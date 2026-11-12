// The Agent's side of Bladeburner (#367): it keeps the desired state's `bladeburner` from the brain it's connected to,
// and runs `bladeburner.js` (../entries/bladeburner.ts), which joins the faction when asked and reads the rank:
// - when the state changes, then every 5 rounds (10 s), as often as the medium snapshot that carries its reading;
// - its reading kept for the medium snapshot (`reading`); null while none is asked for, and before the first;
// - none asked for (null), nothing runs; no instructions (no brain, or one that hasn't sent any), likewise. Not in safe
//   mode: Bladeburner waits for the brain, as the gang does.
import {
  BLADEBURNER_WORKER_NAME,
  type BladeburnerReading,
  type BladeburnerState,
  deployedFilePath,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** Rounds between one run and the next while the state doesn't change: 10 s. */
export const BLADEBURNER_ROUNDS_BETWEEN = 5;

export function createBladeburnerActivity(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  let desired: BladeburnerState | null = null;
  let reading: BladeburnerReading | null = null;
  const schedule = createRoundSchedule();
  const logOutcome = createChangeLog(ns, "bladeburner");

  return {
    /** The brain's latest Bladeburner state: a change is due at once; null asks for none, and drops the last reading. */
    desire(bladeburner: BladeburnerState | null): void {
      if (JSON.stringify(desired) === JSON.stringify(bladeburner)) return;
      if (bladeburner === null) reading = null;
      desired = bladeburner === null ? null : structuredClone(bladeburner);
      schedule.dueNow();
    },

    /** No instructions until the next: nothing runs, and the last reading goes. */
    forget(): void {
      desired = null;
      reading = null;
    },

    /** Runs the worker if it's due, within `deadlineMs`; one that doesn't report is tried again next round. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null) return;
      if (!schedule.takeRound()) return;
      const workerFile = deployedFilePath(deploymentId, BLADEBURNER_WORKER_NAME);
      const workerRun = await workerRunner.runWorker(workerFile, [JSON.stringify(desired)], deadlineMs);
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      reading = workerRun.report.data as BladeburnerReading;
      schedule.dueAfter(BLADEBURNER_ROUNDS_BETWEEN);
      const { rank, problems } = reading;
      logOutcome(
        `${rank === null ? "not in the division" : `rank ${rank.toFixed(1)}`}` +
          `${problems.length > 0 ? `; ${problems.join("; ")}` : ""}`,
      );
    },

    /** The last reading, for the medium snapshot; null while none is asked for, or before the first. */
    reading: (): BladeburnerReading | null => reading,
  };
}
