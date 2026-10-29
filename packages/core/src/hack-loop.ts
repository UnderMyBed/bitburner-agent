/**
 * The hack loop (#134, M3's first slice): its in-game files, inside a deployment's folder, what its two home workers
 * report to the Agent, and the thresholds the loop hacks at, which the brain's rule for a ready target uses too (#184).
 * Shared by the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */
import { deploymentIdOfPath, isGeneratedDeploymentId } from "./deploy-layout.ts";

/** Runs on the servers other than home, with the target as its one argument. */
export const HACK_LOOP_SCRIPT_NAME = "hack-loop.js";
/** Home worker: roots every server it can with the programs on home. */
export const HACK_LOOP_ROOT_WORKER_NAME = "hack-loop-root.js";
/** Home worker: starts and stops the loops on the rooted servers, as the desired state says. */
export const HACK_LOOP_DEPLOY_WORKER_NAME = "hack-loop-deploy.js";

/** The loop weakens its target while its security is more than this over the minimum. */
export const HACK_LOOP_SECURITY_MARGIN = 5;
/** Then grows it while its money is under this fraction of the maximum, and hacks otherwise. */
export const HACK_LOOP_MONEY_FRACTION = 0.75;

/**
 * A target the loop hacks at once, by its own thresholds (#184): money at or above 75% of the maximum, security at or
 * below the minimum plus 5. One that isn't, the loop weakens and grows first, which earns nothing.
 */
export function isHackLoopReady({
  moneyAvailable,
  moneyMax,
  hackDifficulty,
  minDifficulty,
}: {
  moneyAvailable: number;
  moneyMax: number;
  hackDifficulty: number;
  minDifficulty: number;
}): boolean {
  return (
    moneyAvailable >= moneyMax * HACK_LOOP_MONEY_FRACTION && hackDifficulty <= minDifficulty + HACK_LOOP_SECURITY_MARGIN
  );
}

export interface HackLoopRootReport {
  /** Servers it gained root on this time. */
  rootedNow: string[];
}

export interface HackLoopDeployReport {
  /** Servers running the loop afterwards, and their threads in all. */
  serversRunning: number;
  threadsRunning: number;
  /** The same, per target (#184): the one earning, and the one being prepared, in the order the scan met them. */
  byTarget: { target: string; serversRunning: number; threadsRunning: number }[];
  /** Why it couldn't do its job (no deployment folder, no loop script on home), or null. */
  problem: string | null;
}

/**
 * Any deployment's hack loop: `agent/<deploymentId>/hack-loop.js`, in a folder the deployer generated. Only these are
 * ever stopped, never a script in a player's own `agent/<name>/`.
 */
export function isHackLoopFile(filePath: string): boolean {
  const deploymentId = deploymentIdOfPath(filePath);
  return (
    deploymentId !== null && isGeneratedDeploymentId(deploymentId) && filePath.endsWith(`/${HACK_LOOP_SCRIPT_NAME}`)
  );
}

/**
 * The deploy worker's arguments (#184): whether the loop should run, then each host followed by its target. Off, or
 * on with no target, names no host. Each host's own target lets part of the hosts prepare the next one.
 */
export function hackLoopDeployArguments(hackLoop: {
  enabled: boolean;
  target: string | null;
  hosts: string[];
  preparing?: { target: string; hosts: string[] } | null;
}): (string | boolean)[] {
  if (!hackLoop.enabled || hackLoop.target === null) return [hackLoop.enabled];
  const earning = hackLoop.target;
  const pairs = hackLoop.hosts.flatMap((host) => [host, earning]);
  const preparing = hackLoop.preparing;
  if (preparing) pairs.push(...preparing.hosts.flatMap((host) => [host, preparing.target]));
  return [true, ...pairs];
}

/** The deploy worker's arguments read back: each host's target, empty when the loop shouldn't run. */
export function hackLoopTargetsByHost(workerArguments: unknown[]): Map<string, string> {
  const targets = new Map<string, string>();
  if (workerArguments[0] !== true) return targets;
  for (let index = 1; index + 1 < workerArguments.length; index += 2) {
    targets.set(String(workerArguments[index]), String(workerArguments[index + 1]));
  }
  return targets;
}
