import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { resolveOptions } from "./options.ts";
import {
  describeExit,
  type EventPage,
  type GameSummary,
  type HostMessage,
  type HostOptions,
  maxHeapError,
  type ProcessInfo,
  type RunOptions,
  type RunResult,
  type RunUntilParams,
  type RunUntilResult,
  type SimulationOptions,
  validateAdvance,
  validateRunUntil,
} from "./protocol.ts";
import { RpcClient } from "./rpc.ts";

export type {
  BitNodeFixture,
  ComparisonOp,
  EventPage,
  Fixture,
  GameEvent,
  GameSettingsOverride,
  GameSummary,
  HomePeak,
  NetworkOptions,
  NetworkOutboxEntry,
  OnBitVerse,
  ProcessInfo,
  PromptRule,
  RunOptions,
  RunResult,
  RunUntilParams,
  RunUntilResult,
  SaveFixture,
  ScriptArg,
  SimEvent,
  SimulationOptions,
  StopCondition,
  StopEvent,
  SummaryField,
  Tutorial,
} from "./protocol.ts";

const HOST_ENTRY = path.join(import.meta.dirname, "host", "main.ts");
const OUTPUT_TAIL_CHARS = 8192;
const STARTUP_TIMEOUT_MS = 60_000;

/**
 * One simulated game in its own process (game state is global, so one engine per process). The engine is loaded on
 * a virtual clock with seeded randomness; nothing advances until `advance` is called.
 */
export class Simulation {
  private readonly child: ChildProcess;
  private readonly rpc: RpcClient;

  private constructor(child: ChildProcess, rpc: RpcClient) {
    this.child = child;
    this.rpc = rpc;
  }

  static async start({ maxHeapMb, ...options }: SimulationOptions): Promise<Simulation> {
    const badHeap = maxHeapError(maxHeapMb);
    if (badHeap) throw new RangeError(badHeap);
    return Simulation.spawn(resolveOptions(options), maxHeapMb);
  }

  /**
   * Starts a host without the parent-side checks, so tests can reach the host's own validation. `maxHeapMb` becomes
   * the host's `--max-old-space-size`, unchecked.
   */
  static async spawn(options: HostOptions, maxHeapMb?: number): Promise<Simulation> {
    const child = fork(HOST_ENTRY, [], {
      // Don't inherit the parent's Node flags (e.g. a test runner's loaders): the host is plain Node.
      execArgv: maxHeapMb === undefined ? [] : [`--max-old-space-size=${maxHeapMb}`],
      // Pin the time zone, so local-time formatting in the game reads the same on every machine.
      env: { ...process.env, TZ: "UTC" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let tail = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
      });
    }
    const rpc = new RpcClient(child, () => tail);

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Simulation did not start within 60 s")), STARTUP_TIMEOUT_MS);
        const settle = (error?: Error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        child.on("message", (message: HostMessage) => {
          if (message.type === "ready") settle();
          if (message.type === "fatal") settle(new Error(`Simulation failed to start:\n${message.error}`));
        });
        child.once("close", (code, signal) =>
          settle(new Error(`Simulation process ${describeExit(code, signal)} during startup:\n${tail}`)),
        );
        child.once("error", (error) => settle(error));
        child.send({ type: "init", options });
      });
    } catch (error) {
      child.kill();
      throw error;
    }
    return new Simulation(child, rpc);
  }

  /** Virtual epoch milliseconds. */
  now(): Promise<number> {
    return this.rpc.call("now", {});
  }

  /** Runs the game for `ms` virtual milliseconds (a non-negative integer); resolves with the new virtual now. */
  advance(ms: number): Promise<number> {
    validateAdvance(ms);
    return this.rpc.call("advance", { ms });
  }

  /**
   * Runs the game for up to `ms` virtual milliseconds, checking `stopWhen` after every timer and stopping right at the
   * first timer after which one holds. `onBitVerse` says what happens if the game reaches the BitVerse. Resolves with
   * the virtual now and what stopped the run (an index into `stopWhen`, "bitverse", or null if it ran the full time).
   */
  runUntil(ms: number, options: Omit<RunUntilParams, "ms"> = {}): Promise<RunUntilResult> {
    const params: RunUntilParams = { ms, ...options };
    validateRunUntil(params);
    return this.rpc.call("runUntil", params);
  }

  /** A fixed-schema snapshot of the game. Needs a fixture. */
  summary(): Promise<GameSummary> {
    return this.rpc.call("summary", {});
  }

  /** sha256 of the game's own save JSON: two simulations are in the same state exactly when these match. */
  stateHash(): Promise<string> {
    return this.rpc.call("stateHash", {});
  }

  /** The game's own save, as the Steam build writes it (`.json.gz` bytes). Load it with a `save` fixture. */
  async save(): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(await this.rpc.call("save", {}), "base64"));
  }

  /**
   * What the game did that a browser would have shown or done outside the page (downloads, console errors), from
   * position `since` on. Pass the returned `next` to read only what's new.
   */
  events(since = 0): Promise<EventPage> {
    return this.rpc.call("events", { since });
  }

  /** Writes a script or text file on a server, as a player saving it in the editor would. */
  writeFile(host: string, path: string, content: string): Promise<void> {
    return this.rpc.call("writeFile", { host, path, content });
  }

  /**
   * A script's static RAM in GB, from the game's own calculator (the one `run` uses). Rejects with the reason if the
   * file is missing, isn't a script, or doesn't parse.
   */
  staticRamUsage(host: string, path: string): Promise<number> {
    return this.rpc.call("staticRamUsage", { host, path });
  }

  /** Starts a script as the terminal's `run` does. `pid` is 0 if the game refused, with its message in `error`. */
  run(host: string, script: string, { threads = 1, args = [] }: RunOptions = {}): Promise<RunResult> {
    return this.rpc.call("run", { host, script, threads, args });
  }

  /** Running scripts on a server, by pid. */
  ps(host: string): Promise<ProcessInfo[]> {
    return this.rpc.call("ps", { host });
  }

  /** A running or recently finished script's log lines. */
  logs(pid: number): Promise<string[]> {
    return this.rpc.call("logs", { pid });
  }

  /** Kills a running script; false if there is none with that pid. */
  kill(pid: number): Promise<boolean> {
    return this.rpc.call("kill", { pid });
  }

  /**
   * The other end of the page's sockets (ADR 0012), for URLs listed in `network.listenUrls`. Nothing crosses in real
   * time: the parent takes what the page did, and what it sends or closes reaches the page at the start of the next
   * `advance` or `runUntil`.
   */
  readonly network = {
    /** Everything the page's sockets did since the last call (connects, frames, closes), in order. */
    take: () => this.rpc.call("network.take", {}),
    /** Sends a text frame on a connection; false if it's closing or closed. */
    send: (connectionId: number, data: string) => this.rpc.call("network.send", { connectionId, data }),
    /** Closes a connection from this side; false if it's already closing or closed. */
    close: (connectionId: number, code = 1000, reason = "") =>
      this.rpc.call("network.close", { connectionId, code, reason }),
  };

  /** For tests and troubleshooting. */
  readonly diagnostics = {
    clock: () => this.rpc.call("diagnostics.clock", {}),
    game: () => this.rpc.call("diagnostics.game", {}),
    /**
     * The highest RAM home has had in use (GB), and the most scripts it has run at once, since the game booted: each
     * its own high. Taken as each changes, so a script that starts and exits within one timer, which no check after a
     * timer sees, still counts.
     */
    homePeak: () => this.rpc.call("diagnostics.homePeak", {}),
    random: (count: number) => this.rpc.call("diagnostics.random", { count }),
    /** Test-only: changes game state (going to the BitVerse kills every script). Scenarios must not use it. */
    toPage: (page: string, flume = false) => this.rpc.call("diagnostics.toPage", { page, flume }),
    /** Test-only, like `toPage`. */
    back: () => this.rpc.call("diagnostics.back", {}),
    /**
     * Test-only: destroys the current BitNode and enters BitNode `n`, as the BitVerse's portal does after a real
     * destroy (granting the current BitNode's Source-File).
     */
    destroyBitNode: (n: number) => this.rpc.call("diagnostics.destroyBitNode", { n }),
    /** Sets home's RAM, in GB (a power of 2). A harness edit, for test and benchmark scenarios. */
    setHomeRam: (gb: number) => this.rpc.call("diagnostics.setHomeRam", { gb }),
    /** Sets the player's money. A harness edit, for test scenarios. */
    setMoney: (money: number) => this.rpc.call("diagnostics.setMoney", { money }),
    /** Makes the player a member of `faction` with this reputation. A harness edit, for test scenarios (#149). */
    joinFactionWithReputation: (faction: string, reputation: number) =>
      this.rpc.call("diagnostics.joinFactionWithReputation", { faction, reputation }),
    /** Makes the player `job` at `company`, with this reputation there. A harness edit, for test scenarios (#155). */
    employWithReputation: (company: string, job: string, reputation: number) =>
      this.rpc.call("diagnostics.employWithReputation", { company, job, reputation }),
    /** Gives the player an augmentation, installed and unpaid. A harness edit, for test scenarios (#151). */
    giveInstalledAugmentation: (augmentation: string) =>
      this.rpc.call("diagnostics.giveInstalledAugmentation", { augmentation }),
    /** Gives the player hacking experience, through the game's own gain. A harness edit, for test scenarios (#162). */
    gainHackingExp: (exp: number) => this.rpc.call("diagnostics.gainHackingExp", { exp }),
    /** Queues an augmentation, unpaid, not yet installed. A harness edit, for test scenarios (#164). */
    queueAugmentation: (augmentation: string) => this.rpc.call("diagnostics.queueAugmentation", { augmentation }),
    /** The game's own `getBitNodeMultipliers(n, level)`, for comparison. */
    bitNodeMultipliers: (n: number, level: number) => this.rpc.call("diagnostics.bitNodeMultipliers", { n, level }),
    /** The host's V8 heap in use, in bytes, after a full garbage collection. */
    heap: () => this.rpc.call("diagnostics.heap", {}),
    /** The host's V8 heap limit, in bytes: `maxHeapMb` plus a little for the young generation, or Node's default. */
    heapLimit: () => this.rpc.call("diagnostics.heapLimit", {}),
    /** Starts or stops a CPU profile of the host; stopping returns it. */
    profile: (action: "start" | "stop") => this.rpc.call("diagnostics.profile", { action }),
    crash: (code: number, message: string) => this.rpc.call("diagnostics.crash", { code, message }),
  };

  /** Ends the simulation process. Pending calls are rejected. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = once(this.child, "close");
    this.child.kill();
    await closed;
  }
}
