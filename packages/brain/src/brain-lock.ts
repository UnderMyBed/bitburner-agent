// The brain's lock file (#283's review): `brain.lock` in its data directory, written as it starts, before it opens the
// store, and removed as it stops. It names the brain's process and, run by `npm run brain`, the runner's, which lives
// on through a crash and the restart after it. `npm run thin` refuses while either is alive, as well as while the
// dashboard's port answers: the port alone misses a brain starting (the store open before it listens) and a crashed
// one about to be restarted. A lock left by a killed brain names dead processes, so it doesn't count.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BRAIN_LOCK_FILE_NAME = "brain.lock";
/** The environment variable through which `npm run brain`'s runner (start.ts) tells the brain its process id. */
export const BRAIN_RUNNER_PID_VARIABLE = "BITBURNER_AGENT_RUNNER_PID";

export interface BrainLock {
  pid: number;
  /** The runner's process, or null for a brain run without it (tests). */
  runnerPid: number | null;
}

const lockPath = (dataDirectory: string) => path.join(dataDirectory, BRAIN_LOCK_FILE_NAME);

/** Writes the lock, over any left by a brain before. */
export function writeBrainLock(dataDirectory: string, lock: BrainLock): void {
  writeFileSync(lockPath(dataDirectory), `${JSON.stringify(lock)}\n`);
}

/** Removes the lock if it's still `pid`'s. */
export function removeBrainLock(dataDirectory: string, pid: number): void {
  if (readBrainLock(dataDirectory)?.pid === pid) rmSync(lockPath(dataDirectory), { force: true });
}

function readBrainLock(dataDirectory: string): BrainLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockPath(dataDirectory), "utf8")) as Partial<BrainLock>;
    return Number.isInteger(lock.pid)
      ? { pid: lock.pid as number, runnerPid: Number.isInteger(lock.runnerPid) ? (lock.runnerPid as number) : null }
      : null;
  } catch {
    return null;
  }
}

/** Whether a process is alive: signal 0 checks without signalling (EPERM: alive, someone else's). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock of a brain running in `dataDirectory` (its process or its runner alive), with the file's path; or null. */
export function runningBrain(dataDirectory: string): (BrainLock & { path: string }) | null {
  const lock = readBrainLock(dataDirectory);
  if (lock === null) return null;
  const alive = isAlive(lock.pid) || (lock.runnerPid !== null && isAlive(lock.runnerPid));
  return alive ? { ...lock, path: lockPath(dataDirectory) } : null;
}
