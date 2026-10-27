// How the Agent runs a home worker (#89, #134): as a temporary script, then waits for its report on the worker port
// and for it to exit, so its RAM is free for the next one, never past a deadline. Shared by the snapshotter and the
// hack loop.
import { SNAPSHOT_WORKER_PORT, type SnapshotWorkerReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** How often a wait checks whether its worker is still running. */
const WORKER_POLL_MS = 20;
/** No single wait is longer than a snapshot round, even if the clock steps back. */
const LONGEST_WAIT_MS = 2_000;

/** Anything can be written to a port: only a report from this worker counts. */
function isReportFrom(value: unknown, workerPid: number): value is SnapshotWorkerReport {
  return typeof value === "object" && value !== null && (value as { workerPid?: unknown }).workerPid === workerPid;
}

export type WorkerRun =
  | { started: false }
  /** `report` is null if the worker exited without one, or didn't send one by the deadline. */
  | { started: true; workerPid: number; report: SnapshotWorkerReport | null };

/**
 * Runs `workerFile` on home with `workerArguments`. Returns once the worker has exited, or at `deadlineMs`, whichever
 * comes first. The worker isn't started at all if home has no room for it.
 */
export async function runWorker(
  ns: NS,
  workerFile: string,
  workerArguments: (string | number | boolean)[],
  deadlineMs: number,
): Promise<WorkerRun> {
  const workerPid = ns.run(workerFile, { temporary: true }, ...workerArguments);
  if (workerPid === 0) return { started: false };
  const port = ns.getPortHandle(SNAPSHOT_WORKER_PORT);
  let report: SnapshotWorkerReport | null = null;
  for (;;) {
    // An `ns` call before touching the port: if this Agent has been killed, the game ends it here, before it can read
    // a report meant for the next Agent's worker (port reads don't check).
    const workerRunning = ns.isRunning(workerPid);
    while (report === null && !port.empty()) {
      const value: unknown = port.read();
      if (isReportFrom(value, workerPid)) report = value;
    }
    if (!workerRunning) return { started: true, workerPid, report };
    const remainingMs = Math.min(deadlineMs - Date.now(), LONGEST_WAIT_MS);
    if (remainingMs <= 0) return { started: true, workerPid, report };
    // `asleep`, not `sleep`: a `sleep` that loses the race keeps the script marked busy until it ends, and the game
    // kills a busy script for its next `ns` call (NetscriptHelpers.tsx:405-431). `asleep` doesn't mark it.
    await Promise.race([port.nextWrite(), ns.asleep(Math.min(remainingMs, WORKER_POLL_MS))]);
  }
}
