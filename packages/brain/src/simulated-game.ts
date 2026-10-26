// The lockstep driver (ADR 0012): runs a brain against a simulation. The page's sockets become `Connection`s on the
// brain's side, and the brain's clock follows the simulation's virtual time, so a run is reproducible from its seed and
// step size, whatever real time the brain's synchronous work takes. Used by every brain-plus-simulator test; the live
// brain never loads it.
//
// The brain's handlers must be synchronous: a batch of frames is handed over without yielding, so the continuation of
// an `await` on real I/O would land in whichever step real time put it in.
import type { Clock, Connection, TimerHandle } from "@bitburner-agent/bridge";
import type { NetworkOutboxEntry, Simulation } from "@bitburner-agent/sim";

/** The least a timer waits, as Node takes a delay below 1 ms (or not a number). */
const MIN_TIMER_DELAY_MS = 1;

interface PendingTimer {
  dueMs: number;
  callback: () => void;
}

/** The brain's clock under the simulator: virtual time, moved only by the driver. */
export class VirtualBrainClock implements Clock {
  #nowMs: number;
  #nextHandle = 1;
  readonly #timers = new Map<number, PendingTimer>();

  constructor(startMs: number) {
    this.#nowMs = startMs;
  }

  now(): number {
    return this.#nowMs;
  }

  /** As Node's: a delay below 1 ms, or not a finite number, waits 1 ms, so a timer that re-arms itself can't spin. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = this.#nextHandle++;
    const waitMs = Number.isFinite(delayMs) && delayMs >= MIN_TIMER_DELAY_MS ? delayMs : MIN_TIMER_DELAY_MS;
    this.#timers.set(handle, { dueMs: this.#nowMs + waitMs, callback });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  /** Moves to `targetMs`, firing each timer due by then at its own due time, in order (ties by creation). */
  advanceTo(targetMs: number): void {
    for (;;) {
      let earliest: { handle: number; timer: PendingTimer } | undefined;
      for (const [handle, timer] of this.#timers) {
        if (timer.dueMs > targetMs) continue;
        if (!earliest || timer.dueMs < earliest.timer.dueMs) earliest = { handle, timer };
      }
      if (!earliest) break;
      this.#timers.delete(earliest.handle);
      this.#nowMs = Math.max(this.#nowMs, earliest.timer.dueMs);
      earliest.timer.callback();
    }
    this.#nowMs = Math.max(this.#nowMs, targetMs);
  }
}

type OutgoingFrame =
  | { kind: "send"; connection: SimulatedConnection; data: string }
  | { kind: "close"; connection: SimulatedConnection; code: number; reason: string };

/** One page socket, as the brain sees it. */
class SimulatedConnection implements Connection {
  readonly connectionId: number;
  /** The driver's queue of frames for the page, sent at the start of the next step. */
  readonly #outgoing: OutgoingFrame[];
  /** No more frames either way: closed by the page, or by the brain (whose close is still on its way). */
  #closed = false;
  #closeReported = false;
  readonly #messageListeners: ((text: string) => void)[] = [];
  readonly #closeListeners: (() => void)[] = [];

  constructor(connectionId: number, outgoing: OutgoingFrame[]) {
    this.connectionId = connectionId;
    this.#outgoing = outgoing;
  }

  send(text: string): void {
    if (!this.#closed) this.#outgoing.push({ kind: "send", connection: this, data: text });
  }

  /**
   * Stops frames at once, as a real socket does once closing, but reports the close only once it has reached the page
   * (the next step), as a live socket reports it after the closing handshake.
   */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outgoing.push({ kind: "close", connection: this, code, reason });
  }

  onMessage(listener: (text: string) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  /** No more frames cross it: closed by the page, or by the brain. */
  get isClosed(): boolean {
    return this.#closed;
  }

  receive(text: string): void {
    if (this.#closed) return;
    for (const listener of this.#messageListeners) listener(text);
  }

  /** The close has completed: the page closed it, or the brain's close reached the page. */
  reportClosed(): void {
    this.#closed = true;
    if (this.#closeReported) return;
    this.#closeReported = true;
    for (const listener of this.#closeListeners) listener();
  }
}

export interface SimulatedGameOptions {
  simulation: Simulation;
  /**
   * Virtual ms per step. The brain's replies reach the page at the start of the next step, so the step size is part of
   * what makes a run: fix it per test.
   */
  stepMs: number;
  /**
   * For fault tests: how many copies of each frame from the page reach the brain (0 drops it, 2 duplicates it, both
   * copies back to back). Called once per frame, in order, so a seeded function gives a reproducible run; not for frames
   * on a connection the brain has closed, which it would discard anyway. Default: every frame once.
   */
  deliveredCopies?: (frame: { atMs: number; data: string }) => number;
}

export class SimulatedGame {
  /** The brain's clock: give it to the brain's parts (`ControlChannel`, the store's timestamps). */
  readonly clock: VirtualBrainClock;
  #simulation: Simulation;
  readonly #stepMs: number;
  readonly #deliveredCopies: NonNullable<SimulatedGameOptions["deliveredCopies"]>;
  readonly #listeners = new Map<string, (connection: Connection) => void>();
  readonly #connections = new Map<number, SimulatedConnection>();
  readonly #outgoing: OutgoingFrame[] = [];
  #stepping = false;

  private constructor({ simulation, stepMs, deliveredCopies = () => 1 }: SimulatedGameOptions, startMs: number) {
    this.#simulation = simulation;
    this.#stepMs = stepMs;
    this.#deliveredCopies = deliveredCopies;
    this.clock = new VirtualBrainClock(startMs);
  }

  static async create(options: SimulatedGameOptions): Promise<SimulatedGame> {
    if (!Number.isSafeInteger(options.stepMs) || options.stepMs < 1) {
      throw new RangeError(`stepMs must be a positive integer, got ${options.stepMs}`);
    }
    return new SimulatedGame(options, await options.simulation.now());
  }

  /**
   * The game reloaded: `simulation` is a new one started from its save. Every socket of the old page closes now, as a
   * reload closes them, frames still queued for it go nowhere, and steps drive `simulation` from here on. Its
   * `network.listenUrls` must cover what's listened on. The brain's clock never goes back: the save's time may be a
   * moment behind it, and it waits for the reloaded game to catch up.
   */
  replaceSimulation(simulation: Simulation): void {
    if (this.#stepping) throw new Error("SimulatedGame.replaceSimulation() can't run mid-step: await the step first");
    this.#outgoing.length = 0;
    for (const connection of [...this.#connections.values()]) connection.reportClosed();
    this.#simulation = simulation;
  }

  /**
   * Hands every page socket to `url` to `onConnection` (e.g. a `ControlChannel`'s `accept`). The simulation must have
   * been started with `url` in its `network.listenUrls`.
   */
  listen(url: string, onConnection: (connection: Connection) => void): void {
    this.#listeners.set(new URL(url).href, onConnection);
  }

  /**
   * One step: the brain's queued frames and closes go to the page; the simulation advances; what the page's sockets did
   * comes back in order, each at its own virtual time, with the brain's timers fired in between. Steps never overlap.
   */
  async step(): Promise<void> {
    if (this.#stepping) throw new Error("SimulatedGame.step() is already running: await each step");
    this.#stepping = true;
    try {
      for (const frame of this.#outgoing.splice(0)) {
        if (frame.kind === "send") {
          await this.#simulation.network.send(frame.connection.connectionId, frame.data);
        } else {
          await this.#simulation.network.close(frame.connection.connectionId, frame.code, frame.reason);
          frame.connection.reportClosed();
        }
      }
      const nowMs = await this.#simulation.advance(this.#stepMs);
      const unlistenedUrls: string[] = [];
      for (const entry of await this.#simulation.network.take()) {
        this.clock.advanceTo(entry.atMs);
        this.#handle(entry, unlistenedUrls);
      }
      this.clock.advanceTo(nowMs);
      // Reported once the whole batch is handled, so nothing after it is lost.
      if (unlistenedUrls.length > 0) {
        throw new Error(`page sockets connected to ${unlistenedUrls.join(", ")}, which nothing listens on`);
      }
    } finally {
      this.#stepping = false;
    }
  }

  /** Steps until at least `durationMs` of virtual time has passed. */
  async run(durationMs: number): Promise<void> {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += this.#stepMs) await this.step();
  }

  /** Steps until `condition` holds (checked before each step), failing once over `maxVirtualMs` has passed. */
  async runUntil(condition: () => boolean, maxVirtualMs: number): Promise<void> {
    for (let elapsedMs = 0; !condition(); elapsedMs += this.#stepMs) {
      if (elapsedMs > maxVirtualMs) throw new Error(`condition not met within ${maxVirtualMs} virtual ms`);
      await this.step();
    }
  }

  #handle(entry: NetworkOutboxEntry, unlistenedUrls: string[]): void {
    if (entry.type === "connect") {
      const onConnection = this.#listeners.get(entry.url);
      if (!onConnection) {
        unlistenedUrls.push(entry.url);
        return;
      }
      const connection = new SimulatedConnection(entry.connectionId, this.#outgoing);
      this.#connections.set(entry.connectionId, connection);
      // Closed from either side: the driver forgets it.
      connection.onClose(() => this.#connections.delete(entry.connectionId));
      onConnection(connection);
      return;
    }
    const connection = this.#connections.get(entry.connectionId);
    if (!connection) return;
    if (entry.type === "close") {
      connection.reportClosed();
      return;
    }
    // Not for a frame the brain would discard: the fault function sees only what could reach it.
    if (connection.isClosed) return;
    const copies = this.#deliveredCopies(entry);
    if (!Number.isSafeInteger(copies) || copies < 0) {
      throw new RangeError(`deliveredCopies must return a whole number of copies, got ${copies}`);
    }
    for (let copy = 0; copy < copies; copy++) connection.receive(entry.data);
  }
}
