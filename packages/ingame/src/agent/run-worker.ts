// How the Agent runs a home worker (#89, #134, #141), for the snapshotter, the hack loop and the intent runner alike:
// never a second copy of one still running, nothing once the deadline has passed, then the worker as a temporary
// script, waiting for its report on the worker port and for it to exit, so its RAM is free for the next one, never past
// the deadline.
import { WORKER_REPORT_PORT, type WorkerReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** How often a wait checks whether its worker is still running. */
const WORKER_POLL_MS = 20;
/** No single wait is longer than a snapshot round, even if the clock steps back. */
const LONGEST_WAIT_MS = 2_000;

/** Anything can be written to a port: only a report from this worker counts. */
function isReportFrom(value: unknown, workerPid: number): value is WorkerReport {
  return typeof value === "object" && value !== null && (value as { workerPid?: unknown }).workerPid === workerPid;
}

export type WorkerRun =
  | { outcome: "reported"; report: WorkerReport }
  /** Its last copy hasn't exited: a worker that hangs would otherwise pile up copies, each holding its RAM. */
  | { outcome: "stillRunning" }
  | { outcome: "noTimeLeft" }
  /** Home has no room for it, or the file is missing. */
  | { outcome: "couldNotStart" }
  /** It exited without a report, or didn't send one by the deadline. */
  | { outcome: "noReport" };

/** Why a run gave no report, for the Agent's log. */
export function whyNoReport(workerRun: Exclude<WorkerRun, { outcome: "reported" }>, workerFile: string): string {
  switch (workerRun.outcome) {
    case "stillRunning":
      return "its last worker is still running";
    case "noTimeLeft":
      return "no time left in the round";
    case "couldNotStart":
      return `${workerFile} couldn't start`;
    case "noReport":
      return `${workerFile} didn't report in time`;
  }
}

export function createWorkerRunner(ns: NS) {
  /** Each worker file's last pid. */
  const lastWorkerPids = new Map<string, number>();
  return {
    /** Runs `workerFile` on home with `workerArguments`, returning by `deadlineMs`. */
    async runWorker(
      workerFile: string,
      workerArguments: (string | number | boolean)[],
      deadlineMs: number,
    ): Promise<WorkerRun> {
      const previousWorkerPid = lastWorkerPids.get(workerFile);
      if (previousWorkerPid !== undefined && ns.isRunning(previousWorkerPid)) return { outcome: "stillRunning" };
      if (Date.now() >= deadlineMs) return { outcome: "noTimeLeft" };
      const workerPid = ns.run(workerFile, { temporary: true }, ...workerArguments);
      if (workerPid === 0) return { outcome: "couldNotStart" };
      lastWorkerPids.set(workerFile, workerPid);
      const port = ns.getPortHandle(WORKER_REPORT_PORT);
      let report: WorkerReport | null = null;
      for (;;) {
        // An `ns` call before touching the port: if this Agent has been killed, the game ends it here, before it can
        // read a report meant for the next Agent's worker (port reads don't check).
        const workerRunning = ns.isRunning(workerPid);
        while (report === null && !port.empty()) {
          const value: unknown = port.read();
          if (isReportFrom(value, workerPid)) report = value;
        }
        const remainingMs = Math.min(deadlineMs - Date.now(), LONGEST_WAIT_MS);
        if (!workerRunning || remainingMs <= 0) {
          return report === null ? { outcome: "noReport" } : { outcome: "reported", report };
        }
        // `asleep`, not `sleep`: a `sleep` that loses the race keeps the script marked busy until it ends, and the
        // game kills a busy script for its next `ns` call (NetscriptHelpers.tsx:405-431). `asleep` doesn't mark it.
        await Promise.race([port.nextWrite(), ns.asleep(Math.min(remainingMs, WORKER_POLL_MS))]);
      }
    },
  };
}

export type WorkerRunner = ReturnType<typeof createWorkerRunner>;
