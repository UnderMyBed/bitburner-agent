// The Agent's side of the batcher (#205, M4 phase A slice A7b; the batcher itself is #204's). It keeps the desired
// state's `batcher` from the brain it's connected to, or with no brain on safe mode's kept state (#160), and:
// - **its config, hot:** each round the batcher is on, the config goes on the batcher's config port, which the batcher
//   re-reads every loop, so a change of share, spacing, hosts or target starts nothing over (architecture §5.5);
// - **where it runs:** `batcher-deploy.js` starts it on `runOn` and stops ours anywhere else, when that changes, when
//   it's turned on or off, and every 15 rounds (30 s) while on, so a batcher the game lost (a reload: it's temporary)
//   comes back. Off, it stops ours once, clears the config, and does nothing until the state changes;
// - **its health:** the batcher's health port, read each fast snapshot (`health`). Ports cost no RAM.
import {
  BATCHER_CONFIG_PORT,
  BATCHER_DEPLOY_WORKER_NAME,
  BATCHER_HEALTH_PORT,
  type BatcherDeployReport,
  type BatcherHealth,
  type BatcherState,
  deployedFilePath,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** Rounds between one deploy and the next, while on and nothing changes: 30 s. */
const BATCHER_ROUNDS_BETWEEN = 15;

export function createBatcherActivity(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  /** Undefined: no instructions (none from this brain yet, or none kept); null: none wanted, ours stopped. */
  let desired: BatcherState | null | undefined;
  const schedule = createRoundSchedule();
  const logOutcome = createChangeLog(ns, "batcher");

  return {
    /** The brain's latest desired state: on or off, or another host, makes the deploy due at once. */
    desire(batcher: BatcherState | null): void {
      const placement = (state: BatcherState | null | undefined) => (state ? state.runOn : String(state));
      if (desired === undefined || placement(desired) !== placement(batcher)) schedule.dueNow();
      desired = batcher === null ? null : structuredClone(batcher);
    },

    /** No instructions until the next: what runs keeps running, on the config it last read. */
    forget(): void {
      desired = undefined;
    },

    /** After a round's snapshots: the config on its port while on, then the deploy if it's due, within `deadlineMs`. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === undefined) return;
      ns.clearPort(BATCHER_CONFIG_PORT);
      if (desired !== null) ns.writePort(BATCHER_CONFIG_PORT, desired.config);
      if (!schedule.takeRound()) return;
      const workerFile = deployedFilePath(deploymentId, BATCHER_DEPLOY_WORKER_NAME);
      const workerRun = await workerRunner.runWorker(workerFile, desired === null ? [] : [desired.runOn], deadlineMs);
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      const deployed = workerRun.report.data as BatcherDeployReport;
      if (desired === null) schedule.never();
      else schedule.dueAfter(BATCHER_ROUNDS_BETWEEN);
      logOutcome(
        deployed.problem !== null
          ? `can't run: ${deployed.problem}`
          : desired === null
            ? "off"
            : `on ${deployed.running}, against ${desired.config.target}${deployed.started ? " (started)" : ""}`,
      );
    },

    /** The batcher's health, as it last wrote it, for the fast snapshot; null with none on its port. */
    health(): BatcherHealth | null {
      const data = ns.peek(BATCHER_HEALTH_PORT);
      return typeof data === "object" && data !== null ? (data as BatcherHealth) : null;
    },
  };
}
