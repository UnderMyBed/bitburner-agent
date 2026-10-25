import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { describeExit, type HostMessage, type HostOptions, validateAdvance, validateHostOptions } from "./protocol.ts";
import { RpcClient } from "./rpc.ts";

export type SimulationOptions = HostOptions;

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
    validateHostOptions(options);
    return Simulation.spawn(options);
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

  /** For tests and troubleshooting. */
  readonly diagnostics = {
    clock: () => this.rpc.call("diagnostics.clock", {}),
    random: (count: number) => this.rpc.call("diagnostics.random", { count }),
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
