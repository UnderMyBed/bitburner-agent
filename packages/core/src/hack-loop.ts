/**
 * The hack loop (#134, M3's first slice): its in-game files, inside a deployment's folder, what its two home workers
 * report to the Agent, and the thresholds the loop hacks at, which the brain's rule for a ready target uses too (#184).
 * Shared by the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */
import { deploymentIdOfPath, isGeneratedDeploymentId } from "./deploy-layout.ts";

/** Runs on the servers other than home, with the target and the threads it hacks with (#187) as its arguments. */
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
 * The loop's RAM budget, GB a thread: ram-budget.json's `hack-loop.js`, which its RAM is at most (the ingame ram-budget
 * test checks both). The brain counts a host's threads by it, never more than it can run (#187).
 */
export const HACK_LOOP_RAM_BUDGET_GB = 2.4;

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
  /**
   * The same, per target (#184): the one earning, and the one being prepared, in the order the scan met them, with the
   * threads that hack at once (#187): each loop's hack threads, or all its threads with no cap.
   */
  byTarget: { target: string; serversRunning: number; threadsRunning: number; hackThreadsRunning: number }[];
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
 * The deploy worker's arguments (#184, #187): whether the loop should run, then each host followed by its target and
 * its hack threads (0: no cap, all its threads hack). Off, or on with no target, names no host. Each host's own target
 * lets part of the hosts prepare the next one; its own hack threads keep the hosts from hacking their target dry.
 */
export function hackLoopDeployArguments(hackLoop: {
  enabled: boolean;
  target: string | null;
  hosts: string[];
  preparing?: { target: string; hosts: string[] } | null;
  hackThreads?: Record<string, number> | null;
}): (string | boolean | number)[] {
  if (!hackLoop.enabled || hackLoop.target === null) return [hackLoop.enabled];
  const hackThreads = new Map(Object.entries(hackLoop.hackThreads ?? {}));
  const loopOf = (target: string) => (host: string) => [host, target, hackThreads.get(host) ?? 0];
  const loops = hackLoop.hosts.flatMap(loopOf(hackLoop.target));
  if (hackLoop.preparing) loops.push(...hackLoop.preparing.hosts.flatMap(loopOf(hackLoop.preparing.target)));
  return [true, ...loops];
}

/** A host's loop, as the deploy worker reads its arguments: its target, and its hack threads (null: all of them). */
export interface HostHackLoop {
  target: string;
  hackThreads: number | null;
}

/** The deploy worker's arguments read back: each host's loop, none when the loop shouldn't run. */
export function hackLoopsByHost(workerArguments: unknown[]): Map<string, HostHackLoop> {
  const loops = new Map<string, HostHackLoop>();
  if (workerArguments[0] !== true) return loops;
  for (let index = 1; index + 1 < workerArguments.length; index += 3) {
    const hackThreads = workerArguments[index + 2];
    loops.set(String(workerArguments[index]), {
      target: String(workerArguments[index + 1]),
      hackThreads: Number.isSafeInteger(hackThreads) && (hackThreads as number) >= 1 ? (hackThreads as number) : null,
    });
  }
  return loops;
}

/**
 * The share of a server's money one thread's hack takes (#187): the game's `calculatePercentMoneyHacked`
 * (Hacking.ts:44-57), `(100 - security)/100 x (hacking - (required - 1))/hacking x hacking_money x ScriptHackMoney /
 * 240`, between 0 and 1. The BitNode's `ScriptHackMoney` is taken as 1: it's 1 in BN1 and at most 1 in every other
 * (BitNode.tsx), so this is never less than the game's, which errs toward fewer hack threads. 0 at security 100 or
 * more, below the hacking the server needs, or with no hacking at all.
 */
export function percentMoneyHackedPerThread(
  server: { hackDifficulty: number; requiredHackingSkill: number },
  player: { skills: { hacking: number }; mults: { hacking_money: number } },
): number {
  const hacking = player.skills.hacking;
  if (server.hackDifficulty >= 100 || !(hacking > 0)) return 0;
  const difficultyMult = (100 - server.hackDifficulty) / 100;
  const skillMult = (hacking - (server.requiredHackingSkill - 1)) / hacking;
  const share = (difficultyMult * skillMult * player.mults.hacking_money) / 240;
  return Math.min(1, Math.max(share, 0));
}

/**
 * The log of the growth one thread's grow gives a server (#187): the game's `calculateServerGrowthLog` with 1 thread
 * on 1 core (grow.ts:8-28, Constants.ts:7-8): `log1p(0.03 / security)`, at most `log1p(0.0035)`, x growth/100 x
 * hacking_grow x ServerGrowthRate. `threads` threads give `threads` times it. The BitNode's `ServerGrowthRate` is taken
 * as 1: exact in BN1, and more than the game's in a BitNode where it's less (BitNode.tsx), until BitNode multipliers
 * come to core. 0 for a server with no growth or a security of 0 or less (not a game's server).
 */
export function growthLogPerThread(
  server: { serverGrowth: number; hackDifficulty: number },
  player: { mults: { hacking_grow: number } },
): number {
  if (!(server.serverGrowth > 0) || !(server.hackDifficulty > 0)) return 0;
  const adjustedGrowthLog = Math.min(Math.log1p(0.03 / server.hackDifficulty), MAX_GROWTH_LOG);
  return adjustedGrowthLog * (server.serverGrowth / 100) * player.mults.hacking_grow;
}

/** The game's `ServerMaxGrowthLog`, log1p(0.0035) (Constants.ts:8). */
const MAX_GROWTH_LOG = Math.log1p(0.0035);
