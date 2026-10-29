/**
 * The batcher (#204, M4 phase A slice A7a): the maths of one batch (hack, weaken, grow, weaken, landing in that order),
 * its plan on some RAM, its timing, where its threads go, the bounds a batch in step keeps its target within, the
 * waves that prepare a target, and the checks on its landings. Pure, so the brain (A7c) plans with the same functions
 * the in-game batcher (`entries/batcher.ts`) runs. Design and plan: #204; the Agent runs it in #205, the brain chooses
 * in #206. BitNode multipliers are taken as 1, as in hacking-ceiling.ts: exact in BN1.
 */
import { deploymentIdOfPath, isGeneratedDeploymentId } from "./deploy-layout.ts";
import { growthLogPerThread, percentMoneyHackedPerThread } from "./hack-loop.ts";
import {
  GROW_SECURITY_PER_THREAD,
  GROW_TIME_PER_HACK_TIME,
  HACK_SECURITY_PER_THREAD,
  type HackingPlayer,
  type HackingTarget,
  hackChance,
  hackTimeSeconds,
  WEAKEN_SECURITY_PER_THREAD,
  WEAKEN_TIME_PER_HACK_TIME,
} from "./hacking-ceiling.ts";

/** The batcher itself: launches the operations, checks their landings, keeps its health. */
export const BATCHER_SCRIPT_NAME = "batcher.js";
/** The operation scripts, one call each, beside the batcher in its folder; copied to the hosts it runs them on. */
export const BATCH_HACK_SCRIPT_NAME = "batch-hack.js";
export const BATCH_GROW_SCRIPT_NAME = "batch-grow.js";
export const BATCH_WEAKEN_SCRIPT_NAME = "batch-weaken.js";

/** A batch's operations, in the order they land. */
export const BATCH_OPERATIONS = ["hack", "weaken1", "grow", "weaken2"] as const;
export type BatchOperation = (typeof BATCH_OPERATIONS)[number];
export type BatchThreads = Record<BatchOperation, number>;

/**
 * Each operation script's RAM a thread, GB: 1.6 base + its call (`hack` 0.1, `grow`/`weaken` 0.15) + the read of its
 * time (`getHackTime`/`getGrowTime`/`getWeakenTime`, 0.05) (RamCostGenerator.ts:11-20, :48). ram-budget.json's, which
 * the ingame RAM test measures, and checks equal to these.
 */
export const BATCH_HACK_RAM_GB = 1.75;
export const BATCH_GROW_RAM_GB = 1.8;
export const BATCH_WEAKEN_RAM_GB = 1.8;

/**
 * The batcher's RAM budget, GB: ram-budget.json's `batcher.js`, which its RAM is at most (the ingame RAM test checks
 * both). The brain plans with it (#205): where the batcher runs, its operations have that much less.
 */
export const BATCHER_RAM_BUDGET_GB = 3.85;

/** The ms between one landing of a batch and the next (δ): hack, then weaken, grow and weaken, each δ after. */
export const BATCH_LANDING_GAP_MS = 20;
/** The least time between one batch's hack and the next's: its four landings, δ apart, never interleave. */
export const MIN_BATCH_SPACING_MS = 4 * BATCH_LANDING_GAP_MS;
/**
 * How long before its time an operation is started, beyond what security above the minimum may add: for the start's
 * lag (a module's compile and `main`, NetscriptWorker.ts:48-67) and the batcher's own wake-ups. The operation waits
 * the rest out itself (`additionalMsec`), so this only costs RAM.
 */
export const BATCH_LAUNCH_LEAD_MS = 200;
/**
 * Grow is sized for this many times the hack's planned share: the share rises with the hacking level between the
 * hack's start and its landing (`percentMoneyHackedPerThread`'s (hacking - (required - 1))/hacking). The hack's threads
 * are replanned when it starts (`hackThreadsAtLaunch`), so the margin covers a hack's time, a quarter of a weaken's.
 * Not tuned in the simulator, where n00dles (needing hacking 1) doesn't move the share: core's rising-level test checks
 * it holds where the share rises 1.25x over a weaken's time (harakiri-sushi at hacking 55, #208's review). Extra grow
 * costs RAM, never security: only the threads used add it (ServerHelpers.ts:202-212).
 */
export const GROW_MARGIN = 1.1;
/** The largest share a batch takes: grow is sized for `GROW_MARGIN` times it, which must stay under all of it. */
export const MAX_BATCH_SHARE = 0.9;
/** The batcher's ports: each operation's landing record, and the batcher's health (one entry, replaced). */
export const BATCHER_LANDING_PORT = 89_002;
export const BATCHER_HEALTH_PORT = 89_003;
/**
 * The batcher's config (#205), one entry, replaced: the Agent writes the desired state's `batcher.config` there each
 * round it's on, and the batcher re-reads it every loop, so a change starts nothing over (architecture §5.5).
 */
export const BATCHER_CONFIG_PORT = 89_004;
/** Home worker (#205): starts the batcher where the desired state says, and stops ours anywhere else, or everywhere. */
export const BATCHER_DEPLOY_WORKER_NAME = "batcher-deploy.js";

/**
 * Any deployment's batcher: `agent/<deploymentId>/batcher.js`, in a folder the deployer generated. Only these are ever
 * stopped, never a script in a player's own `agent/<name>/`.
 */
export function isBatcherFile(filePath: string): boolean {
  const deploymentId = deploymentIdOfPath(filePath);
  return deploymentId !== null && isGeneratedDeploymentId(deploymentId) && filePath.endsWith(`/${BATCHER_SCRIPT_NAME}`);
}

/** What the batcher's deploy worker reports (#205): where ours runs afterwards, if anywhere, and what it did. */
export interface BatcherDeployReport {
  /** The host our batcher runs on afterwards, or null. */
  running: string | null;
  /** Started this time (a new one, or after one the game lost). */
  started: boolean;
  /** Ours stopped this time: another deployment's, one on another host, or all of them when off. */
  stopped: number;
  /** Why it couldn't do its job (no deployment folder, no batcher on home, no room on its host), or null. */
  problem: string | null;
}
/** A landing not recorded this long after its time is lost: its script never ran, or died. */
export const LANDING_LOST_AFTER_MS = 10_000;

/** Whole threads for `threads` worth: up, but a sum like 25 x 0.04 (1.0000000000000002) stays 1. */
function wholeThreads(threads: number): number {
  return Math.ceil(threads - 1e-9);
}

/**
 * The grow threads that take a server's money from `startMoney` to `targetMoney` (at most `moneyMax`), one thread's
 * growth log being `growthLog` (core's `growthLogPerThread`, times the host's core bonus): the game's
 * `numCycleForGrowthCorrected` (Server/ServerHelpers.ts:90-199), line for line. Grow adds $1 a thread, then multiplies
 * by e^(growthLog x threads) (grow.ts:38-58); the game solves (start + x) e^(kx) = target by Newton's method from its
 * own first guess, then rounds up, checking the integer below on its rounding-error path. 0 when there's nothing to
 * grow; Infinity with no growth.
 */
export function growThreads(startMoney: number, targetMoney: number, moneyMax: number, growthLog: number): number {
  if (!(growthLog > 0)) return Number.POSITIVE_INFINITY;
  const start = Math.max(startMoney, 0);
  const target = Math.min(targetMoney, moneyMax);
  if (target <= start) return 0;
  let x = (target - start) / (1 + (target * (1 / 16) + start * (15 / 16)) * growthLog);
  let diff: number;
  do {
    const ox = start + x;
    const newX = (x - ox * Math.log(ox / target)) / (1 + ox * growthLog);
    diff = newX - x;
    x = newX;
  } while (diff < -1 || diff > 1);
  const ceilingCycles = Math.ceil(x);
  if (ceilingCycles - x > 0.999999) {
    const floorCycles = ceilingCycles - 1;
    if (target <= (start + floorCycles) * Math.exp(growthLog * floorCycles)) return floorCycles;
  }
  if (ceilingCycles >= x + ((diff <= 0 ? -diff : diff) + 0.000001)) return ceilingCycles;
  if (target <= (start + ceilingCycles) * Math.exp(growthLog * ceilingCycles)) return ceilingCycles;
  return ceilingCycles + 1;
}

/** The target at its minimum security, where a batch finds it. */
const atMinimum = (target: HackingTarget) => ({
  hackDifficulty: target.minDifficulty,
  requiredHackingSkill: target.requiredHackingSkill,
});

/** One hack thread's share of the target's money at its minimum security, for this player. */
export function hackSharePerThread(target: HackingTarget, player: HackingPlayer): number {
  return percentMoneyHackedPerThread(atMinimum(target), player);
}

/** The hack threads that take about `wantedShare` of the money now (at least 1); 0 when a thread takes nothing. */
export function hackThreadsForShare(wantedShare: number, target: HackingTarget, player: HackingPlayer): number {
  const perThread = hackSharePerThread(target, player);
  if (!(perThread > 0)) return 0;
  return Math.max(1, Math.floor(wantedShare / perThread + 1e-9));
}

/**
 * One batch's threads (#204), whole, at 1 core (more cores only grow and weaken more):
 * - **hack:** `hackThreads`;
 * - **weaken1:** what a successful hack adds, 0.002 a thread (Constants.ts:9), over a weaken thread's 0.05 (:10);
 * - **grow:** from the money a hack of `GROW_MARGIN` times its share leaves (none, past all of it) back to the maximum
 *   (`growThreads`), at the minimum security, where it lands;
 * - **weaken2:** what that grow adds, 0.004 a thread (ServerHelpers.ts:209-211).
 * Each is at least 1.
 */
export function batchThreads(target: HackingTarget, player: HackingPlayer, hackThreads: number): BatchThreads {
  // Never `hack`, `grow` or `share` as an identifier or a dotted member in code the batcher runs: the game charges a
  // script the RAM of every NS function so named that it reaches (Script/RamCalculations.ts:407-440), so `threads.grow`
  // would cost grow's 0.15 GB. Object keys and destructuring keys aren't charged, so `{ hack: hackCount }` is free.
  const hackCount = Math.max(1, Math.floor(hackThreads));
  const takenShare = Math.min(1, hackCount * hackSharePerThread(target, player));
  const growthLog = growthLogPerThread(
    { serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty },
    player,
  );
  const left = target.moneyMax * Math.max(0, 1 - GROW_MARGIN * takenShare);
  const growCount = Math.max(1, growThreads(left, target.moneyMax, target.moneyMax, growthLog));
  return {
    hack: hackCount,
    weaken1: Math.max(1, wholeThreads((HACK_SECURITY_PER_THREAD * hackCount) / WEAKEN_SECURITY_PER_THREAD)),
    grow: growCount,
    weaken2: Math.max(1, wholeThreads((GROW_SECURITY_PER_THREAD * growCount) / WEAKEN_SECURITY_PER_THREAD)),
  };
}

/** An operation's script. */
export function operationScriptName(operation: BatchOperation): string {
  if (operation === "hack") return BATCH_HACK_SCRIPT_NAME;
  return operation === "grow" ? BATCH_GROW_SCRIPT_NAME : BATCH_WEAKEN_SCRIPT_NAME;
}

/** An operation's RAM a thread, GB. */
export function operationRamGb(operation: BatchOperation): number {
  if (operation === "hack") return BATCH_HACK_RAM_GB;
  return operation === "grow" ? BATCH_GROW_RAM_GB : BATCH_WEAKEN_RAM_GB;
}

/** When an operation lands after its batch's hack: its place in the order times δ. */
export function landingOffsetMs(operation: BatchOperation): number {
  return BATCH_OPERATIONS.indexOf(operation) * BATCH_LANDING_GAP_MS;
}

/** An operation's time on the target at `security` (its minimum by default), ms: a hack's, 3.2 or 4 of it. */
export function operationTimeMs(
  operation: BatchOperation,
  target: HackingTarget,
  player: HackingPlayer,
  security = target.minDifficulty,
): number {
  const hackMs =
    hackTimeSeconds({ hackDifficulty: security, requiredHackingSkill: target.requiredHackingSkill }, player) * 1000;
  if (operation === "hack") return hackMs;
  return hackMs * (operation === "grow" ? GROW_TIME_PER_HACK_TIME : WEAKEN_TIME_PER_HACK_TIME);
}

/**
 * The bounds batches in step keep their target within (#204), at any moment: money at least what a hack of
 * `GROW_MARGIN` times its share leaves, and security at most the minimum plus the most one landing adds before its
 * weaken lands (a hack's 0.002 a thread, or a grow's 0.004), over every batch that may still be landing (`batches`):
 * an older batch, planned at a lower hacking level, has more hack threads than a newer one. Outside them, a batch has
 * landed out of step, or someone else touched the target: a desync. The hacking level now gives the largest share.
 */
export function batchBounds(
  target: HackingTarget,
  player: HackingPlayer,
  batches: BatchThreads[],
): { moneyFloor: number; securityCeiling: number } {
  let mostHack = 0;
  let mostGrow = 0;
  for (const { hack: hackCount, grow: growCount } of batches) {
    mostHack = Math.max(mostHack, hackCount);
    mostGrow = Math.max(mostGrow, growCount);
  }
  const takenShare = Math.min(1, mostHack * hackSharePerThread(target, player));
  return {
    moneyFloor: target.moneyMax * Math.max(0, 1 - GROW_MARGIN * takenShare),
    securityCeiling:
      target.minDifficulty + Math.max(HACK_SECURITY_PER_THREAD * mostHack, GROW_SECURITY_PER_THREAD * mostGrow) + 1e-9,
  };
}

/** Whether what the batcher saw of the target is outside the bounds: money under the floor, or security over it. */
export function isOutsideBounds(
  bounds: { moneyFloor: number; securityCeiling: number },
  seen: { money: number; security: number },
): boolean {
  return seen.money < bounds.moneyFloor || seen.security > bounds.securityCeiling;
}

/**
 * A batch's hack threads when its hack goes out (#204): at most those planned when its first weaken went out, and no
 * more than take the share planned then, at the hacking level now. The share a thread takes rises with the level
 * (`percentMoneyHackedPerThread`'s (hacking - (required - 1))/hacking), so between the plan and the hack's landing it
 * could outrun the grow's `GROW_MARGIN`: replanned here, the margin need cover only a hack's time, a quarter of a
 * weaken's. At least 1.
 */
export function hackThreadsAtLaunch(
  plannedHack: number,
  plannedShare: number,
  target: HackingTarget,
  player: HackingPlayer,
): number {
  const now = hackThreadsForShare(plannedShare, target, player);
  return Math.max(1, Math.min(plannedHack, now > 0 ? now : plannedHack));
}

/**
 * How long before its landing an operation is started, beyond its time at the minimum security, ms: the fixed lead
 * (`BATCH_LAUNCH_LEAD_MS`) plus what security at the bounds' ceiling adds to its time, since an operation called while
 * a batch's hack or grow has just landed takes that much longer (its time is fixed when it's called,
 * NetscriptHelpers.tsx:544).
 */
export function launchLeadMs(
  operation: BatchOperation,
  target: HackingTarget,
  player: HackingPlayer,
  securityCeiling: number,
): number {
  const slower =
    operationTimeMs(operation, target, player, securityCeiling) - operationTimeMs(operation, target, player);
  return BATCH_LAUNCH_LEAD_MS + Math.max(0, slower);
}

/**
 * Each operation of a batch: when it's started, before its landing, ms, and so how long it holds its RAM. Its lead
 * covers the security the largest of its batch and `others` (the batches still landing on the target) may leave: a
 * small batch's operation started just after a larger one's grow landed takes longer (#206: a plan grown with the
 * RAM made one 12 ms late).
 */
export function batchHoldsMs(
  target: HackingTarget,
  player: HackingPlayer,
  threads: BatchThreads,
  others: BatchThreads[] = [],
): Record<BatchOperation, number> {
  const { securityCeiling } = batchBounds(target, player, [threads, ...others]);
  const holds = {} as Record<BatchOperation, number>;
  for (const operation of BATCH_OPERATIONS) {
    holds[operation] =
      operationTimeMs(operation, target, player) + launchLeadMs(operation, target, player, securityCeiling);
  }
  return holds;
}

/**
 * The RAM batches every `spacingMs` hold at their peak, GB: each operation's threads x RAM, times the batches whose
 * same operation runs at once, ⌈its hold / the spacing⌉.
 */
export function batchPeakRamGb(
  threads: BatchThreads,
  holdsMs: Record<BatchOperation, number>,
  spacingMs: number,
): number {
  let peak = 0;
  for (const operation of BATCH_OPERATIONS) {
    peak += threads[operation] * operationRamGb(operation) * Math.ceil(holdsMs[operation] / spacingMs - 1e-9);
  }
  return peak;
}

/**
 * The least spacing (whole ms, at least `MIN_BATCH_SPACING_MS`) at which batches' peak fits `ramGb`, or null when one
 * batch alone doesn't (every operation at once). The peak only falls as the spacing grows.
 */
export function leastSpacingMs(
  threads: BatchThreads,
  holdsMs: Record<BatchOperation, number>,
  ramGb: number,
): number | null {
  const longest = Math.max(...BATCH_OPERATIONS.map((operation) => holdsMs[operation]));
  const fits = (spacingMs: number) => batchPeakRamGb(threads, holdsMs, spacingMs) <= ramGb;
  if (!fits(Math.max(longest, MIN_BATCH_SPACING_MS))) return null;
  if (fits(MIN_BATCH_SPACING_MS)) return MIN_BATCH_SPACING_MS;
  let low = MIN_BATCH_SPACING_MS;
  let high = Math.ceil(Math.max(longest, MIN_BATCH_SPACING_MS));
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) high = middle;
    else low = middle;
  }
  return high;
}

export interface BatchPlan {
  /** The share of the money a batch's hack takes, at the hacking level planned for. */
  hackShare: number;
  threads: BatchThreads;
  /** ms between one batch's hack and the next's. */
  spacingMs: number;
  /** The RAM the batches hold at their peak, GB. */
  peakRamGb: number;
  /** Money a second: the share of the maximum, times the hack's chance, a batch every spacing. */
  incomePerSecond: number;
}

/**
 * The best plan on `ramGb` of usable RAM (#204): for each hack thread count, from 1 until the share passes
 * `MAX_BATCH_SHARE`, the batch's threads (`batchThreads`), the least spacing whose peak fits (`leastSpacingMs`), and
 * the income that gives; the most income wins, the fewer threads on a tie. Null when nothing can be hacked (no share
 * or no chance) or no batch fits.
 */
export function batchPlan(target: HackingTarget, player: HackingPlayer, ramGb: number): BatchPlan | null {
  const perThread = hackSharePerThread(target, player);
  const chance = hackChance(atMinimum(target), player);
  if (!(perThread > 0) || !(chance > 0) || !(target.moneyMax > 0)) return null;
  let best: BatchPlan | null = null;
  for (let hackCount = 1; hackCount === 1 || hackCount * perThread <= MAX_BATCH_SHARE; hackCount += 1) {
    const threads = batchThreads(target, player, hackCount);
    const holdsMs = batchHoldsMs(target, player, threads);
    const spacingMs = leastSpacingMs(threads, holdsMs, ramGb);
    // More hack threads need more RAM at once: once one batch doesn't fit, none larger does.
    if (spacingMs === null) break;
    const hackShare = Math.min(1, hackCount * perThread);
    const incomePerSecond = (target.moneyMax * hackShare * chance * 1000) / spacingMs;
    if (best === null || incomePerSecond > best.incomePerSecond) {
      best = { hackShare, threads, spacingMs, peakRamGb: batchPeakRamGb(threads, holdsMs, spacingMs), incomePerSecond };
    }
  }
  return best;
}

/**
 * The RAM batches can use on hosts of these sizes, GB: each one's whole threads of the largest operation script
 * (`BATCH_WEAKEN_RAM_GB`, 1.8) at that size, as `exec` counts them (`threadsThatFit`). A 16 GB host holds 8 threads,
 * 14.4 GB: what `batchPlan` is given. (A1's `usableRamGb` counts the 1.7 GB hack script's, for the ceiling.)
 */
export function batchRamGb(hostsRamGb: number[]): number {
  return hostsRamGb.reduce(
    (total, ramGb) => total + threadsThatFit(ramGb, BATCH_WEAKEN_RAM_GB) * BATCH_WEAKEN_RAM_GB,
    0,
  );
}

/** A host's free RAM, GB. */
export interface HostRam {
  host: string;
  freeGb: number;
}

/** The threads of `ramGb` each a host's `freeGb` holds, as the game's `exec` counts (NetscriptWorker.ts:110-117). */
export function threadsThatFit(freeGb: number, ramGb: number): number {
  if (!(ramGb > 0) || !(freeGb > 0)) return 0;
  let threads = Math.floor(freeGb / ramGb);
  while (Math.round(ramGb * (threads + 1) * 100) / 100 <= freeGb + 0.001) threads += 1;
  while (threads > 0 && Math.round(ramGb * threads * 100) / 100 > freeGb + 0.001) threads -= 1;
  return threads;
}

/**
 * Where an operation's `threads` go (#204): all on the host with the least free RAM that holds them all, so the large
 * stay free for large operations; otherwise split across the hosts with the most, largest first. Its parts land at the
 * same moment, which for a grow takes a little more than one grow would (each adds its $1 a thread). Null when the
 * hosts don't hold them all.
 */
export function placeThreads(
  hosts: HostRam[],
  threads: number,
  ramGb: number,
): { host: string; threads: number }[] | null {
  if (!(threads >= 1)) return [];
  const fitting = hosts
    .map((each) => ({ host: each.host, freeGb: each.freeGb, fits: threadsThatFit(each.freeGb, ramGb) }))
    .filter((each) => each.fits > 0);
  const whole = fitting.filter((each) => each.fits >= threads).sort((a, b) => a.freeGb - b.freeGb)[0];
  if (whole !== undefined) return [{ host: whole.host, threads }];
  const parts: { host: string; threads: number }[] = [];
  let left = threads;
  for (const each of [...fitting].sort((a, b) => b.freeGb - a.freeGb)) {
    const part = Math.min(each.fits, left);
    parts.push({ host: each.host, threads: part });
    left -= part;
    if (left === 0) return parts;
  }
  return null;
}

/** A target ready for batches: at its minimum security and maximum money. */
export function isTargetPrepared(target: HackingTarget, now: { money: number; security: number }): boolean {
  return now.security <= target.minDifficulty + 1e-6 && now.money >= target.moneyMax;
}

/**
 * The next wave that prepares a target (#204), on `ramGb`: weaken1 for the security over its minimum, then grow from
 * the money now to the maximum (at the minimum security, where it lands after weaken1) and weaken2 for what it adds,
 * landing in that order. What the RAM doesn't hold waits for the next wave: weaken1 first, then as much grow as fits
 * with its weaken2. Null when it's ready; all 0 when the RAM holds none of what it needs.
 */
export function preparationWave(
  target: HackingTarget,
  player: HackingPlayer,
  now: { money: number; security: number },
  ramGb: number,
): { weaken1: number; grow: number; weaken2: number } | null {
  if (isTargetPrepared(target, now)) return null;
  const weakenRoom = Math.floor(ramGb / BATCH_WEAKEN_RAM_GB + 1e-9);
  const weaken1 = Math.min(
    weakenRoom,
    Math.max(0, wholeThreads((now.security - target.minDifficulty) / WEAKEN_SECURITY_PER_THREAD)),
  );
  const growthLog = growthLogPerThread(
    { serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty },
    player,
  );
  const needed = growThreads(now.money, target.moneyMax, target.moneyMax, growthLog);
  const weakenFor = (count: number) => wholeThreads((GROW_SECURITY_PER_THREAD * count) / WEAKEN_SECURITY_PER_THREAD);
  const room = ramGb - weaken1 * BATCH_WEAKEN_RAM_GB;
  const fits = (count: number) => count * BATCH_GROW_RAM_GB + weakenFor(count) * BATCH_WEAKEN_RAM_GB <= room + 1e-9;
  let growCount = Number.isFinite(needed) ? needed : 0;
  if (!fits(growCount)) {
    const perGrow = BATCH_GROW_RAM_GB + BATCH_WEAKEN_RAM_GB * (GROW_SECURITY_PER_THREAD / WEAKEN_SECURITY_PER_THREAD);
    growCount = Math.floor(room / perGrow);
    while (growCount > 0 && !fits(growCount)) growCount -= 1;
  }
  return { weaken1, grow: growCount, weaken2: growCount > 0 ? weakenFor(growCount) : 0 };
}

/** The most preparation waves `preparationTimeMs` counts: past them, a target is out of reach of the RAM. */
export const MOST_PREPARATION_WAVES = 50;

/**
 * How long preparing a target takes from `now` on `ramGb` (#206), ms: `preparationWave` after wave, as the batcher
 * starts them (one when the last has landed), each landing a weaken's time at the security then, plus the lead. After
 * a wave, security is down by its weaken1 (its weaken2 takes off what its grow adds) and money is grown by its grow at
 * the security weaken1 left (grow.ts:38-58). 0 when it's ready; Infinity when the RAM holds none of a wave, or it would
 * take more than `MOST_PREPARATION_WAVES`: a slow grower from a fresh start's 4% on a fresh start's RAM (#204's build).
 */
export function preparationTimeMs(
  target: HackingTarget,
  player: HackingPlayer,
  now: { money: number; security: number },
  ramGb: number,
): number {
  let state = { ...now };
  let totalMs = 0;
  for (let waves = 0; waves < MOST_PREPARATION_WAVES; waves++) {
    const wave = preparationWave(target, player, state, ramGb);
    if (wave === null) return totalMs;
    if (wave.weaken1 + wave.grow === 0) return Number.POSITIVE_INFINITY;
    totalMs += operationTimeMs("weaken1", target, player, state.security) + BATCH_LAUNCH_LEAD_MS;
    const security = Math.max(target.minDifficulty, state.security - wave.weaken1 * WEAKEN_SECURITY_PER_THREAD);
    const growthLog = growthLogPerThread({ serverGrowth: target.serverGrowth, hackDifficulty: security }, player);
    const grown = (Math.max(state.money, 0) + wave.grow) * Math.exp(growthLog * wave.grow);
    state = { security, money: Math.min(target.moneyMax, grown) };
    // Grown to within a part in a million, as the game's grow threads do with their rounding up: ready.
    if (state.money >= target.moneyMax * (1 - 1e-6)) state.money = target.moneyMax;
  }
  return Number.POSITIVE_INFINITY;
}

/** What each operation script writes to the landing port as it lands (#204). */
export interface LandingRecord {
  /** The batcher's name for the operation's part. */
  id: string;
  /** When it was meant to land, and when it did (the game's clock, `Date.now()`). */
  landAt: number;
  landedAt: number;
  /** What the call returned: money hacked (0: the hack failed), growth, or security taken off. */
  result: number;
  /** Started too late to land on time: a hack then doesn't run, a grow or weaken lands late. */
  late: boolean;
  /** Its call never ran (a late hack): it landed nothing, so it says nothing of the order. */
  skipped: boolean;
  /**
   * The ms it had to spare when it was called (#211): the landing time less now less its operation's time, before
   * it's clamped to 0; under 0, it was late. Absent from an older script.
   */
  slackMs?: number;
}

/** A landing record, as the port gives it back, or null (data from the game is never taken on trust). */
export function parseLandingRecord(data: unknown): LandingRecord | null {
  if (typeof data !== "object" || data === null) return null;
  const { id, landAt, landedAt, result, late, skipped } = data as Record<string, unknown>;
  if (typeof id !== "string" || typeof late !== "boolean" || typeof skipped !== "boolean") return null;
  if (![landAt, landedAt, result].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const { slackMs } = data as Record<string, unknown>;
  return {
    id,
    landAt,
    landedAt,
    result,
    late,
    skipped,
    ...(typeof slackMs === "number" && Number.isFinite(slackMs) ? { slackMs } : {}),
  } as LandingRecord;
}

/**
 * The checks on the landings (#204): every operation started is expected at its time; each record must come in the
 * order of the times (never before one already landed: out of order), and any not recorded `LANDING_LOST_AFTER_MS`
 * after its time is lost. Only expected records count: one this watch never started (a previous batcher's, still
 * landing; one recorded already, or lost) is unexpected, and moves nothing. Nor does one whose call never ran (a late
 * hack, recorded at once with its future time), which would make every earlier landing look out of order.
 */
export class LandingWatch {
  readonly #expected = new Map<string, number>();
  #latestLandAt = Number.NEGATIVE_INFINITY;

  /** An operation's part started, to land at `landAt`. */
  expect(id: string, landAt: number): void {
    this.#expected.set(id, landAt);
  }

  /** A record from the port: whether it was expected at all, and whether it landed out of order. */
  landed(record: LandingRecord): { outOfOrder: boolean; expected: boolean } {
    if (!this.#expected.delete(record.id)) return { outOfOrder: false, expected: false };
    if (record.skipped) return { outOfOrder: false, expected: true };
    const outOfOrder = record.landAt < this.#latestLandAt;
    this.#latestLandAt = Math.max(this.#latestLandAt, record.landAt);
    return { outOfOrder, expected: true };
  }

  /** The parts not recorded long after their time, forgotten now: how many. */
  takeLost(nowMs: number): number {
    return this.takeLostIds(nowMs).length;
  }

  /** The parts not recorded long after their time, forgotten now: their ids (#206: a wave waits for its own). */
  takeLostIds(nowMs: number): string[] {
    const lost: string[] = [];
    for (const [id, landAt] of this.#expected) {
      if (landAt + LANDING_LOST_AFTER_MS < nowMs) {
        this.#expected.delete(id);
        lost.push(id);
      }
    }
    return lost;
  }

  /** When the next part would be lost, if none is recorded first: the batcher wakes then. Infinity with none. */
  nextLostAtMs(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const landAt of this.#expected.values()) earliest = Math.min(earliest, landAt + LANDING_LOST_AFTER_MS + 1);
    return earliest;
  }

  /** Parts started and not yet recorded. */
  inFlight(): number {
    return this.#expected.size;
  }

  /** The latest landing time expected, or recorded: a new schedule starts after it. */
  latestLandAt(): number {
    let latest = this.#latestLandAt;
    for (const landAt of this.#expected.values()) latest = Math.max(latest, landAt);
    return latest;
  }
}

/** An operation of a batch to start: when, and when it lands. */
export interface LaunchOrder {
  batch: number;
  operation: BatchOperation;
  landAt: number;
  launchAt: number;
}

/**
 * A batch's four operations, its hack landing at `landAt` and the rest δ apart after it, each started its hold
 * (`batchHoldsMs`) before it lands, earliest first: weaken1, weaken2, grow, hack, as their times go.
 */
export function batchOrders(batch: number, landAt: number, holdsMs: Record<BatchOperation, number>): LaunchOrder[] {
  return BATCH_OPERATIONS.map((operation) => {
    const operationLandAt = landAt + landingOffsetMs(operation);
    return { batch, operation, landAt: operationLandAt, launchAt: operationLandAt - holdsMs[operation] };
  }).sort((a, b) => a.launchAt - b.launchAt || a.landAt - b.landAt);
}

/** What the batcher's config says (#204): one target, its hosts, the share and the spacing (A7c: the brain's). */
export interface BatcherConfig {
  target: string;
  /** The target's figures, from the static snapshot, as the formulas read them. */
  figures: HackingTarget;
  /** The player's multipliers and intelligence; the batcher reads the hacking level live. */
  player: { intelligence: number; mults: HackingPlayer["mults"] };
  /** The hosts its operations run on. */
  hosts: string[];
  hackShare: number;
  spacingMs: number;
  /**
   * The next target (#206), prepared beside the batches on at most `ramGb` of the hosts' RAM, so a move to it starts
   * batching at once; absent with none.
   */
  next?: { target: string; figures: HackingTarget; ramGb: number };
}

/** A target's figures, or the first missing (the config is the brain's word, checked as it's read). */
function figuresProblem(figures: unknown): string | null {
  const fields = (figures ?? {}) as Record<string, unknown>;
  for (const field of ["moneyMax", "minDifficulty", "requiredHackingSkill", "serverGrowth"]) {
    if (!isFiniteNumber(fields[field])) return field;
  }
  return null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A batcher config from JSON's parse, or why it isn't one. */
export function parseBatcherConfig(
  value: unknown,
): { ok: true; config: BatcherConfig } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "the config isn't an object" };
  const { target, figures, player, hosts, hackShare, spacingMs } = value as Record<string, unknown>;
  if (typeof target !== "string" || target === "") return { ok: false, reason: "the config has no target" };
  const targetFigures = (figures ?? {}) as Record<string, unknown>;
  for (const field of ["moneyMax", "minDifficulty", "requiredHackingSkill", "serverGrowth"]) {
    if (!isFiniteNumber(targetFigures[field])) return { ok: false, reason: `the config's figures have no ${field}` };
  }
  const { intelligence, mults } = (player ?? {}) as Record<string, unknown>;
  if (!isFiniteNumber(intelligence)) return { ok: false, reason: "the config's player has no intelligence" };
  const playerMults = (mults ?? {}) as Record<string, unknown>;
  for (const field of ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"]) {
    if (!isFiniteNumber(playerMults[field])) return { ok: false, reason: `the config's player has no mults.${field}` };
  }
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((host) => typeof host === "string" && host !== "")) {
    return { ok: false, reason: "the config's hosts aren't a list of hostnames" };
  }
  if (!isFiniteNumber(hackShare) || hackShare <= 0 || hackShare > MAX_BATCH_SHARE) {
    return { ok: false, reason: `the config's hackShare isn't above 0 and at most ${MAX_BATCH_SHARE}` };
  }
  if (!isFiniteNumber(spacingMs) || spacingMs < MIN_BATCH_SPACING_MS) {
    return { ok: false, reason: `the config's spacing isn't at least ${MIN_BATCH_SPACING_MS} ms` };
  }
  const { next } = value as Record<string, unknown>;
  let parsedNext: BatcherConfig["next"];
  if (next !== undefined && next !== null) {
    const { target: nextTarget, figures: nextFigures, ramGb } = next as Record<string, unknown>;
    if (typeof nextTarget !== "string" || nextTarget === "")
      return { ok: false, reason: "the config's next has no target" };
    const missing = figuresProblem(nextFigures);
    if (missing !== null) return { ok: false, reason: `the config's next figures have no ${missing}` };
    if (!isFiniteNumber(ramGb) || ramGb <= 0) return { ok: false, reason: "the config's next has no RAM above 0" };
    parsedNext = { target: nextTarget, figures: nextFigures as HackingTarget, ramGb };
  }
  return {
    ok: true,
    config: {
      target,
      figures: figures as HackingTarget,
      player: { intelligence, mults: mults as HackingPlayer["mults"] },
      hosts: hosts as string[],
      hackShare,
      spacingMs,
      ...(parsedNext === undefined ? {} : { next: parsedNext }),
    },
  };
}

/** The batcher's health (#204): on its health port and in its log; A7b sends it to the brain. */
export interface BatcherHealth {
  /** Preparing the target, batching, or letting what's in flight land before preparing again after a desync. */
  state: "preparing" | "batching" | "recovering";
  target: string;
  /** Preparation waves started; batches started (their first operation out). */
  wavesStarted: number;
  batchesStarted: number;
  /** Batches with an operation the hosts' RAM couldn't hold (their hack skipped). */
  batchesShort: number;
  /**
   * Hacks landed, a part a host where one was split across hosts, and those that took nothing (the chance failed),
   * and the money they took.
   */
  hacksLanded: number;
  hacksFailed: number;
  moneyHacked: number;
  /** Hacks not started: their batch was short, or the target was outside the bounds. */
  hacksSkipped: number;
  /** Landings out of order, operations started too late, records lost, and the target outside the bounds. */
  outOfOrder: number;
  late: number;
  lost: number;
  outOfBounds: number;
  /** Records no operation of this run's started: a previous batcher's, still landing. Counted, never trusted. */
  unexpected: number;
  /** All of the desyncs: out of order, and outside the bounds. */
  desyncs: number;
  /** The target's money and security when it last looked (preparing, and at each hack), or null before. */
  seen: { money: number; security: number } | null;
  /** Why it can't do its job (a config it can't read, no RAM to prepare, an operation that wouldn't start), or null. */
  problem: string | null;
  /** This run's name, the start of each of its operations' ids, so a previous run's records are told apart. */
  runName: string;
  /** Batches planned whose hack hasn't gone out, and operation parts started and not yet recorded. */
  batchesPending: number;
  inFlight: number;
  /**
   * The latest landing it expects, or null: a batcher started after this one (#205) waits for it, so its first batches
   * aren't short of the RAM this one's operations still hold.
   */
  latestLandAt: number | null;
  /**
   * The least time any operation had to spare when it was called (#211, its record's `slackMs`), ms, or null before
   * one: how close a start's lag came to making one late. A lead (`BATCH_LAUNCH_LEAD_MS`) of 200 ms less it is the lag.
   */
  leastSlackMs: number | null;
  /**
   * The next target it prepares beside its batches (#206, the config's `next`): its preparation waves started, and
   * whether it was ready when it last looked; null with none. Absent from an older batcher.
   */
  next?: { target: string; wavesStarted: number; ready: boolean } | null;
  /** The game's clock when this was written. */
  atMs: number;
}

/** A new batcher's health. */
export function newBatcherHealth(target: string, runName: string, atMs: number): BatcherHealth {
  return {
    state: "preparing",
    target,
    wavesStarted: 0,
    batchesStarted: 0,
    batchesShort: 0,
    hacksLanded: 0,
    hacksFailed: 0,
    moneyHacked: 0,
    hacksSkipped: 0,
    outOfOrder: 0,
    late: 0,
    lost: 0,
    outOfBounds: 0,
    unexpected: 0,
    desyncs: 0,
    seen: null,
    problem: null,
    runName,
    batchesPending: 0,
    inFlight: 0,
    latestLandAt: null,
    leastSlackMs: null,
    next: null,
    atMs,
  };
}
