// The Agent's side of buying the hacking programs (#136): it keeps the next item the brain it's connected to wants
// bought, and buys it through the game's page with `buy-program.js`. Like the hack loop, it forgets on a disconnect.
// - It runs the worker when the item changes, after the hack loop, if enough of the round is left for the page.
// - Bought, it waits for the brain's next item: the brain sees it owned in the next medium snapshot.
// - Not bought (the page wasn't as expected), it logs why, every try, and tries again every 15 rounds (30 s).
// - A worker that doesn't run (home full, still running, no time left) is tried again next round.
import {
  BUY_PROGRAM_WORKER_NAME,
  type BuyProgramReport,
  type DesiredState,
  deployedFilePath,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one try and the next while an item isn't bought: 30 s. */
const PROGRAMS_ROUNDS_BETWEEN = 15;
/** How long before the round ends the worker gives up, to report and exit in time. */
const WORKER_MARGIN_MS = 200;
/** The least of the round worth starting the worker with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

export function createProgramBuyer(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  let desired: DesiredState["programs"] | null = null;
  const schedule = createRoundSchedule();
  const logOutcome = createChangeLog(ns, "hacking programs");

  return {
    /** The brain's latest: a new item makes it due at once. */
    desire(programs: DesiredState["programs"]): void {
      if (JSON.stringify(desired) === JSON.stringify(programs)) return;
      desired = { enabled: programs.enabled, next: programs.next === null ? null : { ...programs.next } };
      schedule.dueNow();
    },

    /** Disconnected: no instructions until the next brain sends some. */
    forget(): void {
      desired = null;
    },

    /** After the round's snapshots and the hack loop: buys the next item if it's due, within `deadlineMs`. */
    async buyIfDue(deadlineMs: number): Promise<void> {
      const next = desired?.enabled ? desired.next : null;
      if (!next) return;
      // A round that isn't due counts down, short or not. A due one that's short leaves it due next round.
      if (!schedule.takeRound()) return;
      if (deadlineMs - Date.now() < MIN_WORKER_TIME_MS) return;
      const workerFile = deployedFilePath(deploymentId, BUY_PROGRAM_WORKER_NAME);
      // The worker gives up a little before the round ends, so its report is in before the Agent stops waiting.
      const workerRun = await workerRunner.runWorker(
        workerFile,
        [next.item, next.vendor ?? "", deadlineMs - WORKER_MARGIN_MS],
        deadlineMs,
      );
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      const report = workerRun.report.data as BuyProgramReport;
      // A problem after the item is owned is still worth knowing: the page may not be back on the Terminal.
      const problem = report.problem === null ? "" : `: ${report.problem}`;
      if (report.done) {
        // Nothing more until the brain names the next item.
        schedule.never();
        logOutcome(`bought ${next.item}${problem}`);
        return;
      }
      schedule.dueAfter(PROGRAMS_ROUNDS_BETWEEN);
      // Every failed try, not just a change: each is a visit to the page the owner may want to see.
      ns.print(
        `agent: hacking programs: couldn't buy ${next.item}${problem}; ` +
          `trying again in ${(PROGRAMS_ROUNDS_BETWEEN * SNAPSHOT_ROUND_MS) / 1000} s`,
      );
    },
  };
}
