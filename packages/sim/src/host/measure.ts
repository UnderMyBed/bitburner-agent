// Measuring the host itself, for benchmarks: its heap after a full collection, and CPU profiles.
import { Session } from "node:inspector/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { CpuProfile } from "../protocol.ts";

/**
 * A full garbage collection. `--expose-gc` would put `gc` on the global object, where player scripts could see it;
 * setting the flag at run time and taking `gc` from a fresh context keeps it private.
 */
const collectGarbage: () => void = (() => {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
})();

/** The V8 heap in use, in bytes, after a full garbage collection. */
export function heapUsed(): number {
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

let profiling: Session | null = null;

/** Starts a CPU profile of this process (the game and everything it runs). */
export async function startProfile(): Promise<void> {
  if (profiling) throw new Error("a profile is already running");
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  profiling = session;
}

/** Stops the CPU profile and returns it. */
export async function stopProfile(): Promise<CpuProfile> {
  if (!profiling) throw new Error("no profile is running");
  const { profile } = (await profiling.post("Profiler.stop")) as { profile: CpuProfile };
  profiling.disconnect();
  profiling = null;
  return profile;
}
