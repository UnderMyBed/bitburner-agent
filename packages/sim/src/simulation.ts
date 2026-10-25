import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { HOST_OPTIONS_ENV, type HostStatus } from "./protocol.ts";
import { RpcClient } from "./rpc.ts";

export interface SimulationOptions {
  /** Seeds every source of randomness the game can reach. */
  seed: number;
  /** Virtual epoch: what the game's Date reads when it loads. */
  epochMs: number;
}

const HOST_ENTRY = path.join(import.meta.dirname, "host", "main.ts");
const OUTPUT_TAIL_BYTES = 8192;

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
    if (!Number.isSafeInteger(options.seed) || !Number.isSafeInteger(options.epochMs)) {
      throw new Error(`seed and epochMs must be integers, got ${JSON.stringify(options)}`);
    }
    const child = fork(HOST_ENTRY, [], {
      execArgv: [],
      env: { ...process.env, [HOST_OPTIONS_ENV]: JSON.stringify(options) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let tail = "";
    const keepTail = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);
    const rpc = new RpcClient(child, () => tail);

    await new Promise<void>((resolve, reject) => {
      child.once("message", (status: HostStatus) =>
        "ready" in status ? resolve() : reject(new Error(`Simulation failed to start:\n${status.fatal}`)),
      );
      child.once("exit", (code, signal) =>
        reject(new Error(`Simulation process ${signal ?? `exited with code ${code}`} during startup:\n${tail}`)),
      );
    });
    return new Simulation(child, rpc);
  }

  /** Virtual epoch milliseconds. */
  now(): Promise<number> {
    return this.rpc.call("now", {});
  }

  /** Runs the game for `ms` virtual milliseconds; resolves with the new virtual now. */
  advance(ms: number): Promise<number> {
    return this.rpc.call("advance", { ms });
  }

  /** For tests and troubleshooting. */
  readonly diagnostics = {
    clock: () => this.rpc.call("diagnostics.clock", {}),
    random: (count: number) => this.rpc.call("diagnostics.random", { count }),
    crash: (code: number, message: string) => this.rpc.call("diagnostics.crash", { code, message }),
  };

  /** Ends the simulation process. Pending calls are rejected. */
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill();
    await exited;
  }
}
