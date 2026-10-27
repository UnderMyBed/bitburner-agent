// The Agent's side of the hack loop (#134, M3's first slice of the reconciler, architecture §5.3). It keeps the last
// desired state the brain sent and converges the game on it with two home workers, one after the other:
// `hack-loop-root.js` (root what it can) then `hack-loop-deploy.js` (start and stop the loops). It runs them when the
// desired state changes and every 15 rounds (30 s) after that, so servers that become rootable, and loops the game
// lost, are picked up. With no desired state yet, after the Agent starts, it does nothing: loops already running keep
// running.
import {
  type DesiredState,
  deployedFilePath,
  HACK_LOOP_DEPLOY_WORKER_NAME,
  HACK_LOOP_ROOT_WORKER_NAME,
  type HackLoopDeployReport,
  type HackLoopRootReport,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { runWorker } from "./run-worker.ts";

/** Rounds between one convergence and the next, while nothing changes: 30 s. */
export const HACK_LOOP_ROUNDS_BETWEEN = 15;

export function createHackLoop(ns: NS, { deploymentId }: { deploymentId: string }) {
  let desired: DesiredState["hackLoop"] | null = null;
  /** 0: due now. */
  let roundsUntilDue = 0;
  /** Each worker's last pid: never a second copy of one still running. */
  const lastWorkerPids = new Map<string, number>();
  let lastOutcome = "";

  /** The worker's report, or null if it couldn't start, is still running from before, or didn't report in time. */
  async function runHackLoopWorker(
    workerName: string,
    workerArguments: (string | boolean)[],
    deadlineMs: number,
  ): Promise<unknown> {
    const previousWorkerPid = lastWorkerPids.get(workerName);
    if (previousWorkerPid !== undefined && ns.isRunning(previousWorkerPid)) return null;
    if (Date.now() >= deadlineMs) return null;
    const workerRun = await runWorker(ns, deployedFilePath(deploymentId, workerName), workerArguments, deadlineMs);
    if (!workerRun.started) return null;
    lastWorkerPids.set(workerName, workerRun.workerPid);
    return workerRun.report?.data ?? null;
  }

  /** Logged when it changes, so a steady loop doesn't fill the log. */
  function logOutcome(outcome: string): void {
    if (outcome !== lastOutcome) ns.print(`agent: hack loop: ${outcome}`);
    lastOutcome = outcome;
  }

  return {
    /** The brain's latest desired state: a change makes the loop due at once. */
    desire(hackLoop: DesiredState["hackLoop"]): void {
      if (desired?.enabled === hackLoop.enabled && desired.target === hackLoop.target) return;
      desired = { ...hackLoop };
      roundsUntilDue = 0;
    },

    /** After a round's snapshots: converges if it's due, within `deadlineMs`. If it can't, it stays due. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null) return;
      if (roundsUntilDue > 0) {
        roundsUntilDue -= 1;
        return;
      }
      if (desired.enabled) {
        const rooted = (await runHackLoopWorker(
          HACK_LOOP_ROOT_WORKER_NAME,
          [],
          deadlineMs,
        )) as HackLoopRootReport | null;
        if (rooted === null) return logOutcome(`${HACK_LOOP_ROOT_WORKER_NAME} didn't run; trying again next round`);
        if (rooted.rootedNow.length > 0) ns.print(`agent: hack loop: rooted ${rooted.rootedNow.join(", ")}`);
      }
      const deployed = (await runHackLoopWorker(
        HACK_LOOP_DEPLOY_WORKER_NAME,
        [desired.enabled, desired.target ?? ""],
        deadlineMs,
      )) as HackLoopDeployReport | null;
      if (deployed === null) return logOutcome(`${HACK_LOOP_DEPLOY_WORKER_NAME} didn't run; trying again next round`);
      roundsUntilDue = HACK_LOOP_ROUNDS_BETWEEN - 1;
      const running = `${deployed.threadsRunning} threads on ${deployed.serversRunning} servers`;
      logOutcome(
        !desired.enabled
          ? "off"
          : desired.target === null
            ? "on, no target yet"
            : `on, ${running}, against ${desired.target}`,
      );
    },
  };
}
