// Keeps the brain running from the repo (#122): starts it as a child process and starts it again after a crash, in
// the foreground of the owner's terminal. Nothing is installed (owner decision 30): Ctrl+C stops it for good, and
// after a reboot the owner runs `npm run brain` again.
import { type ChildProcess, spawn } from "node:child_process";

export interface RestartOnCrashOptions {
  command: string;
  args: string[];
  /** The waits before each restart in a row of crashes; the last repeats. A long enough run starts the row over. */
  restartDelaysMs: readonly number[];
  /** A run at least this long wasn't part of a crash loop: the next restart waits the first delay again. */
  steadyRunMs: number;
  log: (line: string) => void;
  /** For tests: stop after this many runs. */
  maxRuns?: number;
}

export interface RestartOnCrash {
  /** Settles once it has stopped: after `stop()`, a clean exit, or `maxRuns`. */
  finished: Promise<void>;
  /**
   * Stops for good. The brain gets `graceMs` to exit by itself (Ctrl+C in a terminal reaches it too, and it shuts down
   * cleanly); then it's killed. `forward` sends it a signal first, for one only this process received.
   */
  stop(options?: { graceMs?: number; forward?: NodeJS.Signals }): Promise<void>;
}

/** The wait before restarting after the `crashesInARow`th crash in a row (1 for the first). */
export function restartDelayMs(crashesInARow: number, restartDelaysMs: readonly number[]): number {
  return restartDelaysMs[Math.min(crashesInARow, restartDelaysMs.length) - 1] as number;
}

export function restartOnCrash(options: RestartOnCrashOptions): RestartOnCrash {
  let stopping = false;
  let child: ChildProcess | undefined;
  let cancelWait: (() => void) | undefined;
  let crashesInARow = 0;
  let runs = 0;

  const runOnce = () =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null; ranMs: number }>((resolve) => {
      const startedAt = performance.now();
      child = spawn(options.command, options.args, { stdio: "inherit" });
      child.once("error", (error) => options.log(`couldn't start the brain: ${error.message}`));
      child.once("close", (code, signal) => {
        child = undefined;
        resolve({ code, signal, ranMs: performance.now() - startedAt });
      });
    });

  const finished = (async () => {
    while (!stopping) {
      runs++;
      const { code, signal, ranMs } = await runOnce();
      if (stopping) break;
      // Exit 0 is the brain shutting down by itself (it was told to stop): nothing to restart.
      if (code === 0) {
        options.log("the brain stopped");
        break;
      }
      if (options.maxRuns !== undefined && runs >= options.maxRuns) break;
      crashesInARow = ranMs >= options.steadyRunMs ? 1 : crashesInARow + 1;
      const delayMs = restartDelayMs(crashesInARow, options.restartDelaysMs);
      options.log(`the brain exited (${signal ?? `code ${code}`}); restarting in ${delayMs / 1000} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        cancelWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      cancelWait = undefined;
    }
  })();

  return {
    finished,
    async stop({ graceMs = 10_000, forward } = {}) {
      stopping = true;
      cancelWait?.();
      const running = child;
      if (running && forward) running.kill(forward);
      if (running) {
        const exited = new Promise<void>((resolve) => running.once("close", () => resolve()));
        const graceOver = new Promise<"graceOver">((resolve) => setTimeout(() => resolve("graceOver"), graceMs));
        if ((await Promise.race([exited, graceOver])) === "graceOver") running.kill();
      }
      await finished;
    },
  };
}
