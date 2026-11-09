// The Agent's side of the gang (#325): it keeps the desired state's `gang` from the brain it's connected to, and runs
// `gang.js` (../entries/gang.ts), which recruits, sets the members' tasks and reads the gang:
// - when the state changes, then every 5 rounds (10 s), as often as the medium snapshot that carries its reading (the
//   gang itself processes every 2 s, `Gang/data/Constants.ts:29`);
// - its reading kept for the medium snapshot (`reading`); null while no gang is managed, and before the first;
// - none wanted (null), nothing runs; no instructions (no brain, or one that hasn't sent any), likewise. Not in safe
//   mode: the members keep their tasks in the game, and a recruit can wait for the brain.
import { deployedFilePath, GANG_WORKER_NAME, type GangReading, type GangState } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** Rounds between one run and the next while the state doesn't change: 10 s. */
export const GANG_ROUNDS_BETWEEN = 5;

export function createGangActivity(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  let desired: GangState | null = null;
  let reading: GangReading | null = null;
  const schedule = createRoundSchedule();
  const logOutcome = createChangeLog(ns, "gang");

  return {
    /** The brain's latest gang state: a change is due at once; null manages none, and drops the last reading. */
    desire(gang: GangState | null): void {
      if (JSON.stringify(desired) === JSON.stringify(gang)) return;
      if (gang === null) reading = null;
      desired = gang === null ? null : structuredClone(gang);
      schedule.dueNow();
    },

    /** No instructions until the next: nothing runs, and the last reading goes. */
    forget(): void {
      desired = null;
      reading = null;
    },

    /** Runs the worker if it's due, within `deadlineMs`; one that doesn't report is tried again next round. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null || !schedule.takeRound()) return;
      const workerFile = deployedFilePath(deploymentId, GANG_WORKER_NAME);
      const workerRun = await workerRunner.runWorker(workerFile, [JSON.stringify(desired)], deadlineMs);
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      reading = workerRun.report.data as GangReading;
      schedule.dueAfter(GANG_ROUNDS_BETWEEN);
      const { gang, members, problems } = reading;
      logOutcome(
        gang === null
          ? problems.length > 0
            ? `unread: ${problems.join("; ")}`
            : "no gang formed yet"
          : `${gang.faction}'s, ${members.length} members${problems.length > 0 ? `; ${problems.join("; ")}` : ""}`,
      );
    },

    /** The last reading, for the medium snapshot; null while no gang is managed, or before the first. */
    reading: (): GangReading | null => reading,
  };
}
