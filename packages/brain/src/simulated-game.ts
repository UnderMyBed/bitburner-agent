// The lockstep driver (ADR 0012): runs a brain against a simulation. The page's sockets become `Connection`s on the
// brain's side, and the brain's clock follows the simulation's virtual time, so a run is reproducible from its seed and
// step size, whatever real time anything takes. Used by every brain-plus-simulator test; the live brain never loads it.
import type { Clock, Connection, TimerHandle } from "@bitburner-agent/bridge";
import type { NetworkOutboxEntry, Simulation } from "@bitburner-agent/sim";

/** The brain's clock under the simulator: virtual time, moved only by the driver. */
export class VirtualBrainClock implements Clock {
  #nowMs: number;
  #nextHandle = 1;
  readonly #timers = new Map<number, { dueMs: number; callback: () => void }>();

  constructor(startMs: number) {
    this.#nowMs = startMs;
  }

  now(): number {
    return this.#nowMs;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { dueMs: this.#nowMs + Math.max(0, delayMs), callback });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  /** Moves to `targetMs`, firing each timer due by then at its own due time, in order (ties by creation). */
  advanceTo(targetMs: number): void {
    for (;;) {
      let next: [number, { dueMs: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].dueMs > targetMs) continue;
        if (!next || entry[1].dueMs < next[1].dueMs) next = entry;
      }
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#nowMs = Math.max(this.#nowMs, next[1].dueMs);
      next[1].callback();
    }
    this.#nowMs = Math.max(this.#nowMs, targetMs);
  }
}

type OutgoingFrame =
  | { kind: "send"; connectionId: number; data: string }
  | { kind: "close"; connectionId: number; code: number; reason: string };

/** One page socket, as the brain sees it. */
class SimulatedConnection implements Connection {
  readonly #connectionId: number;
  /** The driver's queue of frames for the page, sent at the start of the next step. */
  readonly #outgoing: OutgoingFrame[];
  #closed = false;
  readonly #messageListeners: ((text: string) => void)[] = [];
  readonly #closeListeners: (() => void)[] = [];

  constructor(connectionId: number, outgoing: OutgoingFrame[]) {
    this.#connectionId = connectionId;
    this.#outgoing = outgoing;
  }

  send(text: string): void {
    if (!this.#closed) this.#outgoing.push({ kind: "send", connectionId: this.#connectionId, data: text });
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#outgoing.push({ kind: "close", connectionId: this.#connectionId, code, reason });
    this.closedOnEitherSide();
  }

  onMessage(listener: (text: string) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  receive(text: string): void {
    if (this.#closed) return;
    for (const listener of this.#messageListeners) listener(text);
  }

  closedOnEitherSide(): void {
    if (this.#closed) return;
    this.#closed = true;
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
}

export class SimulatedGame {
  /** The brain's clock: give it to the brain's parts (`ControlChannel`, the store's timestamps). */
  readonly clock: VirtualBrainClock;
  readonly #simulation: Simulation;
  readonly #stepMs: number;
  readonly #listeners = new Map<string, (connection: Connection) => void>();
  readonly #connections = new Map<number, SimulatedConnection>();
  readonly #outgoing: OutgoingFrame[] = [];

  private constructor(simulation: Simulation, stepMs: number, startMs: number) {
    this.#simulation = simulation;
    this.#stepMs = stepMs;
    this.clock = new VirtualBrainClock(startMs);
  }

  static async create({ simulation, stepMs }: SimulatedGameOptions): Promise<SimulatedGame> {
    if (!Number.isSafeInteger(stepMs) || stepMs < 1)
      throw new RangeError(`stepMs must be a positive integer, got ${stepMs}`);
    return new SimulatedGame(simulation, stepMs, await simulation.now());
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
   * comes back in order, each at its own virtual time, with the brain's timers fired in between.
   */
  async step(): Promise<void> {
    for (const frame of this.#outgoing.splice(0)) {
      if (frame.kind === "send") await this.#simulation.network.send(frame.connectionId, frame.data);
      else await this.#simulation.network.close(frame.connectionId, frame.code, frame.reason);
    }
    const nowMs = await this.#simulation.advance(this.#stepMs);
    for (const entry of await this.#simulation.network.take()) {
      this.clock.advanceTo(entry.atMs);
      this.#handle(entry);
    }
    this.clock.advanceTo(nowMs);
  }

  /** Steps until at least `durationMs` of virtual time has passed. */
  async run(durationMs: number): Promise<void> {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += this.#stepMs) await this.step();
  }

  #handle(entry: NetworkOutboxEntry): void {
    if (entry.type === "connect") {
      const onConnection = this.#listeners.get(entry.url);
      if (!onConnection) throw new Error(`a page socket connected to ${entry.url}, which nothing listens on`);
      const connection = new SimulatedConnection(entry.connectionId, this.#outgoing);
      this.#connections.set(entry.connectionId, connection);
      // Closed from either side: the driver forgets it.
      connection.onClose(() => this.#connections.delete(entry.connectionId));
      onConnection(connection);
      return;
    }
    const connection = this.#connections.get(entry.connectionId);
    if (!connection) return;
    if (entry.type === "message") connection.receive(entry.data);
    else connection.closedOnEitherSide();
  }
}
