// Measuring the host itself, for benchmarks: its heap after a full collection, its heap limit, and CPU profiles.

import { Session } from "node:inspector/promises";
import process from "node:process";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { CpuProfile } from "../protocol.ts";

let collect: (() => void) | null = null;

/**
 * A full garbage collection. `--expose-gc` would put `gc` on the global object, where player scripts could see it;
 * setting the flag at run time and taking `gc` from a fresh context keeps it private. It's set on first use, so only
 * simulations that measure their heap change a V8 flag after startup.
 */
function collectGarbage(): void {
  if (!collect) {
    setFlagsFromString("--expose-gc");
    collect = runInNewContext("gc") as () => void;
  }
  collect();
}

/** The V8 heap in use, in bytes, after a full garbage collection. */
export function heapUsed(): number {
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

/** The V8 heap limit, in bytes: `--max-old-space-size` plus room for the young generation, or Node's default. */
export function heapLimit(): number {
  return getHeapStatistics().heap_size_limit;
}

let profiling: Session | null = null;

/** Starts a CPU profile of this process (the game and everything it runs). */
export async function startProfile(): Promise<void> {
  if (profiling) throw new Error("a profile is already running");
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
  } catch (error) {
    session.disconnect();
    throw error;
  }
  profiling = session;
}

/** Stops the CPU profile and returns it. */
export async function stopProfile(): Promise<CpuProfile> {
  if (!profiling) throw new Error("no profile is running");
  const session = profiling;
  profiling = null;
  try {
    const { profile } = (await session.post("Profiler.stop")) as { profile: CpuProfile };
    return profile;
  } finally {
    session.disconnect();
  }
}
