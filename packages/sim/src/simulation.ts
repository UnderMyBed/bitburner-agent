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
  type ProcessInfo,
  type RunOptions,
  type RunResult,
  type SimulationOptions,
  validateAdvance,
} from "./protocol.ts";
import { RpcClient } from "./rpc.ts";

export type {
  EventPage,
  Fixture,
  GameSummary,
  ProcessInfo,
  RunOptions,
  RunResult,
  ScriptArg,
  SimEvent,
  SimulationOptions,
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

  static async start(options: SimulationOptions): Promise<Simulation> {
    return Simulation.spawn(resolveOptions(options));
  }

  /** Starts a host without the parent-side checks, so tests can reach the host's own validation. */
  static async spawn(options: HostOptions): Promise<Simulation> {
    const child = fork(HOST_ENTRY, [], {
      // Don't inherit the parent's Node flags (e.g. a test runner's loaders): the host is plain Node.
      execArgv: [],
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

  /** For tests and troubleshooting. */
  readonly diagnostics = {
    clock: () => this.rpc.call("diagnostics.clock", {}),
    game: () => this.rpc.call("diagnostics.game", {}),
    random: (count: number) => this.rpc.call("diagnostics.random", { count }),
    /** Test-only: changes game state (going to the BitVerse kills every script). Scenarios must not use it. */
    toPage: (page: string, flume = false) => this.rpc.call("diagnostics.toPage", { page, flume }),
    /** Test-only, like `toPage`. */
    back: () => this.rpc.call("diagnostics.back", {}),
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
