// The Agent's side of buying the hacking programs (#136): it keeps the next item the brain it's connected to wants
// bought, and buys it through the game's page with `buy-program.js`. Like the hack loop, it forgets on a disconnect.
// - It runs the worker when the item changes, after the hack loop, within the round's time.
// - Bought, it waits for the brain's next item: the brain sees it owned in the next medium snapshot.
// - Not bought (the page wasn't as expected), it tries again every 15 rounds (30 s), and logs why.
// - A worker that doesn't run (home full, still running, no time left) is tried again next round.
import {
  BUY_PROGRAM_WORKER_NAME,
  type BuyProgramReport,
  type DesiredState,
  deployedFilePath,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** Rounds between one try and the next while an item isn't bought: 30 s. */
const PROGRAMS_ROUNDS_BETWEEN = 15;
/** How long before the round ends the worker gives up, to report and exit in time. */
const WORKER_MARGIN_MS = 200;

export function createProgramBuyer(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  let desired: DesiredState["programs"] | null = null;
  /** 0: due now. */
  let roundsUntilDue = 0;
  let lastOutcome = "";

  /** Logged when it changes. */
  function logOutcome(outcome: string): void {
    if (outcome !== lastOutcome) ns.print(`agent: hacking programs: ${outcome}`);
    lastOutcome = outcome;
  }

  return {
    /** The brain's latest: a new item makes it due at once. */
    desire(programs: DesiredState["programs"]): void {
      if (JSON.stringify(desired) === JSON.stringify(programs)) return;
      desired = { enabled: programs.enabled, next: programs.next === null ? null : { ...programs.next } };
      roundsUntilDue = 0;
    },

    /** Disconnected: no instructions until the next brain sends some. */
    forget(): void {
      desired = null;
    },

    /** After the round's snapshots and the hack loop: buys the next item if it's due, within `deadlineMs`. */
    async buyIfDue(deadlineMs: number): Promise<void> {
      const next = desired?.enabled ? desired.next : null;
      if (!next) return;
      if (roundsUntilDue > 0) {
        roundsUntilDue -= 1;
        return;
      }
      const workerFile = deployedFilePath(deploymentId, BUY_PROGRAM_WORKER_NAME);
      // The worker gives up a little before the round ends, so its report is in before the Agent stops waiting.
      const workerDeadlineMs = deadlineMs - WORKER_MARGIN_MS;
      const workerRun = await workerRunner.runWorker(
        workerFile,
        [next.item, next.vendor ?? "", workerDeadlineMs],
        deadlineMs,
      );
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      const report = workerRun.report.data as BuyProgramReport;
      if (report.done) {
        // Nothing more until the brain names the next item.
        roundsUntilDue = Number.POSITIVE_INFINITY;
        logOutcome(`bought ${next.item}`);
        return;
      }
      roundsUntilDue = PROGRAMS_ROUNDS_BETWEEN - 1;
      logOutcome(`couldn't buy ${next.item}: ${report.problem ?? "no reason given"}; trying again in 30 s`);
    },
  };
}
