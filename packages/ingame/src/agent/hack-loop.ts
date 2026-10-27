// The Agent's side of the hack loop (#134, M3's first slice of the reconciler, architecture §5.3). It keeps the desired
// state the brain it's connected to sent, and converges the game on it with two home workers, one after the other:
// `hack-loop-root.js` (root what it can) then `hack-loop-deploy.js` (start and stop the loops). It acts on instructions
// only from the brain it's connected to: on a disconnect it forgets them, and loops already running keep running.
// - On: it converges when the state changes, then every 15 rounds (30 s), so servers that become rootable and loops
//   the game lost are picked up. A worker that doesn't run is tried again next round, without rooting again.
// - Off: it stops every loop once, then does nothing until the state changes.
import {
  type DesiredState,
  deployedFilePath,
  HACK_LOOP_DEPLOY_WORKER_NAME,
  HACK_LOOP_ROOT_WORKER_NAME,
  type HackLoopDeployReport,
  type HackLoopRootReport,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** Rounds between one convergence and the next, while on and nothing changes: 30 s. */
const HACK_LOOP_ROUNDS_BETWEEN = 15;

export function createHackLoop(
  ns: NS,
  { deploymentId, workerRunner }: { deploymentId: string; workerRunner: WorkerRunner },
) {
  let desired: DesiredState["hackLoop"] | null = null;
  /** 0: due now. */
  let roundsUntilDue = 0;
  /** This convergence has rooted already: a retry of the deploy worker doesn't root again. */
  let rootedThisTime = false;
  let lastOutcome = "";

  /** The worker's report, or null with the reason logged. */
  async function runHackLoopWorker(
    workerName: string,
    workerArguments: (string | boolean)[],
    deadlineMs: number,
  ): Promise<unknown> {
    const workerFile = deployedFilePath(deploymentId, workerName);
    const workerRun = await workerRunner.runWorker(workerFile, workerArguments, deadlineMs);
    if (workerRun.outcome === "reported") return workerRun.report.data;
    logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
    return null;
  }

  /** Logged when it changes, so a steady loop doesn't fill the log. */
  function logOutcome(outcome: string): void {
    if (outcome !== lastOutcome) ns.print(`agent: hack loop: ${outcome}`);
    lastOutcome = outcome;
  }

  return {
    /** The brain's latest desired state: a change makes the loop due at once. */
    desire(hackLoop: DesiredState["hackLoop"]): void {
      if (JSON.stringify(desired) === JSON.stringify(hackLoop)) return;
      desired = { ...hackLoop, hosts: [...hackLoop.hosts] };
      roundsUntilDue = 0;
      rootedThisTime = false;
    },

    /** Disconnected: no instructions until the next brain sends some. */
    forget(): void {
      desired = null;
    },

    /** After a round's snapshots: converges if it's due, within `deadlineMs`. If it can't, it stays due. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null) return;
      if (roundsUntilDue > 0) {
        roundsUntilDue -= 1;
        return;
      }
      if (desired.enabled && !rootedThisTime) {
        const rooted = (await runHackLoopWorker(
          HACK_LOOP_ROOT_WORKER_NAME,
          [],
          deadlineMs,
        )) as HackLoopRootReport | null;
        if (rooted === null) return;
        rootedThisTime = true;
        if (rooted.rootedNow.length > 0) ns.print(`agent: hack loop: rooted ${rooted.rootedNow.join(", ")}`);
      }
      const deployed = (await runHackLoopWorker(
        HACK_LOOP_DEPLOY_WORKER_NAME,
        [desired.enabled, desired.target ?? "", ...desired.hosts],
        deadlineMs,
      )) as HackLoopDeployReport | null;
      if (deployed === null) return;
      rootedThisTime = false;
      // Off, once is enough: nothing starts our loops again but this Agent.
      roundsUntilDue = desired.enabled ? HACK_LOOP_ROUNDS_BETWEEN - 1 : Number.POSITIVE_INFINITY;
      const running = `${deployed.threadsRunning} threads on ${deployed.serversRunning} servers`;
      logOutcome(
        deployed.problem !== null
          ? `can't run: ${deployed.problem}`
          : !desired.enabled
            ? "off"
            : desired.target === null
              ? "on, no target yet"
              : `on, ${running}, against ${desired.target}`,
      );
    },
  };
}
