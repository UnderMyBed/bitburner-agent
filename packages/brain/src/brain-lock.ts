// The brain's lock file (#283's review): `brain.lock` in its data directory, claimed as it starts, before it opens the
// store. It names the brain's process and, run by `npm run brain`, the runner's, which lives on through a crash and
// the restart after it. The brain removes it only on a clean stop, so after a crash it stays, and the runner's process
// keeps it counting until the runner stops. `npm run thin` refuses while either is alive, as well as while the
// dashboard's port answers: the port alone misses a brain starting (the store open before it listens) and a crashed
// one about to be restarted. A lock left by a killed brain with no runner names dead processes, so it doesn't count;
// one naming a process id since reused by another program counts until that ends, and the refusal names the file.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Writes the lock, over any left before: to a file of its own, then renamed into place, so a reader never sees it half
 * written (#297's re-review).
 */
export function writeBrainLock(dataDirectory: string, lock: BrainLock): void {
  const temporaryPath = `${lockPath(dataDirectory)}.${lock.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(lock)}\n`);
    renameSync(temporaryPath, lockPath(dataDirectory));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * The brain's start (main.ts): writes its lock, unless another brain's process holds it (two brains on one data
 * directory: the second mustn't take the first's lock, and its failed start mustn't remove it). Never throws: a lock it
 * can't write is logged, and `npm run thin` still has the dashboard's port to go on. True if it holds the lock.
 */
export function claimBrainLock(dataDirectory: string, lock: BrainLock, log: (message: string) => void): boolean {
  try {
    const held = readBrainLock(dataDirectory);
    if (held !== null && held.pid !== lock.pid && isAlive(held.pid)) {
      log(`brain lock: another brain's process ${held.pid} holds ${lockPath(dataDirectory)}: left as it is`);
      return false;
    }
    writeBrainLock(dataDirectory, lock);
    return true;
  } catch (error) {
    log(
      `brain lock: couldn't write ${lockPath(dataDirectory)} (${error instanceof Error ? error.message : error}): ` +
        "npm run thin can tell this brain runs by its dashboard's port alone",
    );
    return false;
  }
}

/** Removes the lock if it's still `pid`'s: on the brain's clean stop. */
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
