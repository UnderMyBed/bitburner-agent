/**
 * The hack loop (#134, M3's first slice): its in-game files, inside a deployment's folder, and what its two home workers
 * report to the Agent. Shared by the in-game code and the brain's tests. The constants are plain literals, as in
 * deploy-layout.ts.
 */
import { deploymentIdOfPath } from "./deploy-layout.ts";

/** Runs on the servers other than home, with the target as its one argument. */
export const HACK_LOOP_SCRIPT_NAME = "hack-loop.js";
/** Home worker: roots every server it can with the programs on home. */
export const HACK_LOOP_ROOT_WORKER_NAME = "hack-loop-root.js";
/** Home worker: starts and stops the loops on the rooted servers, as the desired state says. */
export const HACK_LOOP_DEPLOY_WORKER_NAME = "hack-loop-deploy.js";

export interface HackLoopRootReport {
  /** Servers it gained root on this time. */
  rootedNow: string[];
}

export interface HackLoopDeployReport {
  /** Servers running the loop afterwards, and their threads in all. */
  serversRunning: number;
  threadsRunning: number;
  /** Why it couldn't do its job (no deployment folder, no loop script on home), or null. */
  problem: string | null;
}

/** Any deployment's hack loop: `agent/<deploymentId>/hack-loop.js`. Only these are ever stopped. */
export function isHackLoopFile(filePath: string): boolean {
  return deploymentIdOfPath(filePath) !== null && filePath.endsWith(`/${HACK_LOOP_SCRIPT_NAME}`);
}
