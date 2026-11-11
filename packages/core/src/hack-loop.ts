/**
 * The hack loop (#134, M3's first slice): its in-game files, inside a deployment's folder, what its two home workers
 * report to the Agent, and the thresholds the loop hacks at, which the brain's rule for a ready target uses too (#184).
 * Shared by the in-game code and the brain. The constants are plain literals, as in deploy-layout.ts.
 */
import { deploymentIdOfPath, isGeneratedDeploymentId } from "./deploy-layout.ts";

/** Runs on the servers other than home, with the target and the threads it hacks with (#187) as its arguments. */
export const HACK_LOOP_SCRIPT_NAME = "hack-loop.js";
/**
 * Levelling mode's loop (#336): weakens its target, its one argument, for ever, for the experience; started by
 * `hack-loop-deploy.js` on the hosts and on home's RAM beyond what home keeps, in the hack loop's place.
 */
export const LEVEL_LOOP_SCRIPT_NAME = "level-loop.js";
/**
 * Levelling mode's grow loop (#336): grows its target for ever, in the level loop's place once the target is at its
 * minimum security and maximum money, where a grow adds none (`Server/ServerHelpers.ts:201-212`) and earns 1.25 times
 * a weaken's experience a thread-second. A script of its own: one script calling both would cost 0.15 GB a thread more.
 */
export const LEVEL_GROW_SCRIPT_NAME = "level-grow.js";
/**
 * Their RAM budget, GB a thread: 1.6 base + `weaken`'s or `grow`'s 0.15 (RamCostGenerator.ts:11, :18, :20),
 * ram-budget.json's `level-loop.js` and `level-grow.js` (the ingame ram-budget test checks them). On the hack loop's
 * 2.4 GB, 27% fewer threads would fit.
 */
export const LEVEL_LOOP_RAM_GB = 1.75;
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
 * Any deployment's hack loop: `agent/<deploymentId>/hack-loop.js`, or levelling mode's `level-loop.js` or
 * `level-grow.js` (#336), in a folder the deployer generated. Only these are ever stopped, never a script in a player's
 * own `agent/<name>/`.
 */
export function isHackLoopFile(filePath: string): boolean {
  const deploymentId = deploymentIdOfPath(filePath);
  return (
    deploymentId !== null &&
    isGeneratedDeploymentId(deploymentId) &&
    [HACK_LOOP_SCRIPT_NAME, LEVEL_LOOP_SCRIPT_NAME, LEVEL_GROW_SCRIPT_NAME].some((name) =>
      filePath.endsWith(`/${name}`),
    )
  );
}

/**
 * The deploy worker's second argument in levelling mode (#336): the third is then home's kept RAM, GB, and the fourth
 * the operation, `"grow"` or `"weaken"`.
 */
const LEVELLING_ARGUMENT = "levelling";

/**
 * The deploy worker's arguments (#184, #187): whether the loop should run, then each host followed by its target and
 * its hack threads (0: no cap, all its threads hack). Off, or on with no target, names no host. Each host's own target
 * lets part of the hosts prepare the next one; its own hack threads keep the hosts from hacking their target dry.
 * In levelling mode (#336, `levelling`), `"levelling"`, home's kept RAM and the operation come first (absent, the
 * weaken), then each host and home, each with the target and 0: the level or grow loop on each, on home only beyond the
 * RAM it keeps.
 */
export function hackLoopDeployArguments(hackLoop: {
  enabled: boolean;
  target: string | null;
  hosts: string[];
  preparing?: { target: string; hosts: string[] } | null;
  hackThreads?: Record<string, number> | null;
  levelling?: { homeKeptGb: number; operation?: "grow" | "weaken" } | null;
}): (string | boolean | number)[] {
  if (!hackLoop.enabled || hackLoop.target === null) return [hackLoop.enabled];
  const { target, levelling } = hackLoop;
  if (levelling) {
    const hosts = hackLoop.hosts.includes("home") ? hackLoop.hosts : [...hackLoop.hosts, "home"];
    const operation = levelling.operation ?? "weaken";
    return [true, LEVELLING_ARGUMENT, levelling.homeKeptGb, operation, ...hosts.flatMap((host) => [host, target, 0])];
  }
  const hackThreads = new Map(Object.entries(hackLoop.hackThreads ?? {}));
  const loopOf = (loopTarget: string) => (host: string) => [host, loopTarget, hackThreads.get(host) ?? 0];
  const loops = hackLoop.hosts.flatMap(loopOf(target));
  if (hackLoop.preparing) loops.push(...hackLoop.preparing.hosts.flatMap(loopOf(hackLoop.preparing.target)));
  return [true, ...loops];
}

/**
 * A host's loop, as the deploy worker reads its arguments: its target, and its hack threads (null: all of them); in
 * levelling mode (#336), the level loop, with the RAM home keeps.
 */
export interface HostHackLoop {
  target: string;
  hackThreads: number | null;
  /** Levelling mode (#336): its loop on this host, home's kept RAM, GB, and the operation; absent for the hack loop. */
  levelling?: { homeKeptGb: number; operation: "grow" | "weaken" };
}

/** The deploy worker's arguments read back: each host's loop, none when the loop shouldn't run. */
export function hackLoopsByHost(workerArguments: unknown[]): Map<string, HostHackLoop> {
  const loops = new Map<string, HostHackLoop>();
  if (workerArguments[0] !== true) return loops;
  const keptGb = workerArguments[2];
  // Home's kept RAM unread: none of home is used.
  // The operation unread: the weaken, which keeps the target's security at its minimum.
  const levelling =
    workerArguments[1] === LEVELLING_ARGUMENT
      ? {
          homeKeptGb: typeof keptGb === "number" && keptGb >= 0 ? keptGb : Number.POSITIVE_INFINITY,
          operation: workerArguments[3] === "grow" ? ("grow" as const) : ("weaken" as const),
        }
      : null;
  for (let index = levelling === null ? 1 : 4; index + 1 < workerArguments.length; index += 3) {
    const hackThreads = workerArguments[index + 2];
    loops.set(String(workerArguments[index]), {
      target: String(workerArguments[index + 1]),
      hackThreads:
        levelling === null && Number.isSafeInteger(hackThreads) && (hackThreads as number) >= 1
          ? (hackThreads as number)
          : null,
      ...(levelling === null ? {} : { levelling }),
    });
  }
  return loops;
}

/**
 * The share of a server's money one thread's hack takes (#187): the game's `calculatePercentMoneyHacked`
 * (Hacking.ts:44-57), `(100 - security)/100 x (hacking - (required - 1))/hacking x hacking_money x ScriptHackMoney /
 * 240`, between 0 and 1. The BitNode's `ScriptHackMoney` comes folded into `hacking_money` (#321: the brain folds
 * core's `bitNodeHackingMultipliers` in where it reads the player; 0.2 in BN4). 0 at security 100 or more, below the
 * hacking the server needs, or with no hacking at all.
 */
export function percentMoneyHackedPerThread(
  server: { hackDifficulty: number; requiredHackingSkill: number },
  player: { skills: { hacking: number }; mults: { hacking_money: number } },
): number {
  const hacking = player.skills.hacking;
  if (server.hackDifficulty >= 100 || !(hacking > 0)) return 0;
  const difficultyMult = (100 - server.hackDifficulty) / 100;
  const skillMult = (hacking - (server.requiredHackingSkill - 1)) / hacking;
  // Not `share`: the game charges a script RAM for any name an NS function has (Script/RamCalculations.ts:407-440),
  // and `share` is 2.4 GB, which the batcher would pay (#204).
  const fraction = (difficultyMult * skillMult * player.mults.hacking_money) / 240;
  return Math.min(1, Math.max(fraction, 0));
}

/**
 * The log of the growth one thread's grow gives a server (#187): the game's `calculateServerGrowthLog` with 1 thread
 * on 1 core (grow.ts:8-28, Server/data/Constants.ts:7-8): `log1p(0.03 / security)`, at most `log1p(0.0035)`, x
 * growth/100 x hacking_grow x ServerGrowthRate. `threads` threads give `threads` times it. The BitNode's
 * `ServerGrowthRate` comes folded into `hacking_grow` (#334: the brain folds core's `bitNodeHackingMultipliers` in where
 * it reads the player; 0.8 in BN2, BitNode.tsx:579), so exact in the BitNodes the brain plays. 0 for a server with no
 * growth or a security of 0 or less (not a game's server).
 */
export function growthLogPerThread(
  server: { serverGrowth: number; hackDifficulty: number },
  player: { mults: { hacking_grow: number } },
): number {
  if (!(server.serverGrowth > 0) || !(server.hackDifficulty > 0)) return 0;
  const adjustedGrowthLog = Math.min(Math.log1p(0.03 / server.hackDifficulty), MAX_GROWTH_LOG);
  return adjustedGrowthLog * (server.serverGrowth / 100) * player.mults.hacking_grow;
}

/** The game's `ServerMaxGrowthLog`, log1p(0.0035) (Server/data/Constants.ts:8). */
const MAX_GROWTH_LOG = Math.log1p(0.0035);

/** The file a host's loop runs (#336): the hack loop's, or levelling mode's level or grow loop. */
export function loopScriptNameOf(loop: HostHackLoop | undefined): string {
  if (loop?.levelling === undefined) return HACK_LOOP_SCRIPT_NAME;
  return loop.levelling.operation === "grow" ? LEVEL_GROW_SCRIPT_NAME : LEVEL_LOOP_SCRIPT_NAME;
}

/**
 * The loop the deploy worker keeps on `hostname` (#336): its loop in the arguments, but on home only levelling mode's,
 * where the hack loop never runs (the Agent's home); none, so ours there are stopped, otherwise.
 */
export function hostLoopOf(loops: Map<string, HostHackLoop>, hostname: string): HostHackLoop | undefined {
  const loop = loops.get(hostname);
  return hostname === "home" && loop?.levelling === undefined ? undefined : loop;
}

/**
 * The RAM a host keeps from our loop, GB (#336): on home, the brain's word in levelling mode (unread or not
 * levelling: all of it); elsewhere none.
 */
export function keptGbOf(hostname: string, loop: HostHackLoop | undefined): number {
  return hostname === "home" ? (loop?.levelling?.homeKeptGb ?? Number.POSITIVE_INFINITY) : 0;
}

/**
 * The threads our loop may hold on a host (#336, #211): its free RAM with our loop's own (`oursGb`) counted free, less
 * what it keeps, in whole threads of `scriptGb`. On home, what the other scripts use comes first, then the kept RAM:
 * the Agent and its workers keep it beside whatever runs as the loop starts.
 */
export function loopThreadsRoom({
  maxGb,
  usedGb,
  oursGb,
  keptGb,
  scriptGb,
}: {
  maxGb: number;
  usedGb: number;
  oursGb: number;
  keptGb: number;
  scriptGb: number;
}): number {
  if (!(scriptGb > 0)) return 0;
  const room = Math.floor((maxGb - (usedGb - oursGb) - keptGb) / scriptGb);
  return Number.isFinite(room) ? Math.max(0, room) : 0;
}

/**
 * Whether a running loop is started again at full size (#211, #336): once its room holds more threads than it has, by
 * one elsewhere (the batcher's operations landed after it was turned off); on home by as many as the kept RAM holds, so
 * the Agent's workers coming and going (each a few GB, within the kept RAM) don't restart it every convergence, and one
 * that ran as it started, ended since, resizes it once.
 */
export function restartsAtFullSize(room: number, running: number, keptGb: number, scriptGb: number): boolean {
  if (!(running > 0) || !(scriptGb > 0)) return false;
  const margin = Number.isFinite(keptGb) ? Math.max(1, Math.floor(keptGb / scriptGb)) : 1;
  return room - running >= margin;
}
