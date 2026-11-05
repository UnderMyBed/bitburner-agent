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
 * How long after its landing an operation's RAM is counted held (#232): its script frees it once its call has landed
 * and its record is written (NetscriptWorker.ts:147-148, killWorkerScript.ts:124), within a ms in the simulator
 * (batch-operations.test.ts), so a start planned for the same moment may find it still held. δ, the slip a landing
 * already has before its batch is out of step.
 */
export const BATCH_RAM_RELEASE_MS = BATCH_LANDING_GAP_MS;
/**
 * How long before its time an operation is started, beyond what security above the minimum may add: for the start's
 * lag (a module's compile and `main`, NetscriptWorker.ts:48-67) and the batcher's own wake-ups. The operation waits
 * the rest out itself (`additionalMsec`), so this only costs RAM.
 */
export const BATCH_LAUNCH_LEAD_MS = 200;
/**
 * How long past its time an operation that finds no room waits for it (#246), tried again at each landing and every
 * `BATCH_RAM_WAIT_LOOK_MS`: half its lead, the other half kept for the start's lag, so it still lands on time. The RAM
 * its batch was fitted to may free late: on a busy page the game's timers fire late, so an operation's script can end
 * well past its landing and the `BATCH_RAM_RELEASE_MS` counted for it (run #3's shorts as its next target changed).
 */
export const BATCH_RAM_WAIT_MS = BATCH_LAUNCH_LEAD_MS / 2;
/** While an operation waits for room (#246), how often the batcher looks again, beside each landing's record. */
export const BATCH_RAM_WAIT_LOOK_MS = 5;
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
 * same operation runs at once, ⌈(its hold + its release, `BATCH_RAM_RELEASE_MS`) / the spacing⌉ (#232: a hold of
 * exactly the spacing has two at once while one's script ends).
 */
export function batchPeakRamGb(
  threads: BatchThreads,
  holdsMs: Record<BatchOperation, number>,
  spacingMs: number,
): number {
  let peak = 0;
  for (const operation of BATCH_OPERATIONS) {
    const atOnce = Math.ceil((holdsMs[operation] + BATCH_RAM_RELEASE_MS) / spacingMs - 1e-9);
    peak += threads[operation] * operationRamGb(operation) * atOnce;
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
  // One batch alone: each operation's RAM released before the next batch's starts.
  const longest = Math.max(...BATCH_OPERATIONS.map((operation) => holdsMs[operation])) + BATCH_RAM_RELEASE_MS;
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
 * The RAM batches can count on, on hosts of these sizes (or with this much free of anything else), GB (#232): each
 * one's less a thread of the largest operation script (`BATCH_WEAKEN_RAM_GB`, 1.8), on those with room for one. What
 * `batchPlan` is given, and what the batcher fits each batch to (`batchFits`). An operation's threads go whole on one
 * host or split across them (`placeThreads`), and `exec` runs a script only in its host's own free RAM
 * (NetscriptWorker.ts:110-117): each host's free RAM then holds its whole threads and under one more, so an operation
 * whose RAM, with all else of the batches' held, is within this always finds the room. Each host's whole 1.8 GB
 * threads (#204's count) isn't enough: hack's 1.75 GB beside them leaves up to 1.75 GB a host that a grow or weaken
 * can't use (#229's suite: a hack 4 threads short with 194 GB free over 28 hosts). (A1's `usableRamGb` counts the
 * 1.7 GB hack script's whole threads, for the ceiling.)
 */
export function batchRamGb(hostsRamGb: number[]): number {
  return hostsRamGb.reduce((total, ramGb) => total + Math.max(0, ramGb - BATCH_WEAKEN_RAM_GB), 0);
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

/** RAM held, or to be, over [`fromMs`, `untilMs`), GB: an operation's part from its start to its landing's release. */
export interface RamHold {
  gb: number;
  fromMs: number;
  untilMs: number;
}

/** The most RAM `holds` hold at once at any moment of [`fromMs`, `untilMs`), GB: a sweep of their starts and ends. */
export function mostRamHeldGb(holds: readonly RamHold[], fromMs: number, untilMs: number): number {
  let held = 0;
  const changes: [number, number][] = [];
  for (const { gb, fromMs: start, untilMs: end } of holds) {
    if (end <= fromMs || start >= untilMs || !(gb > 0)) continue;
    if (start <= fromMs) held += gb;
    else changes.push([start, gb]);
    if (end < untilMs) changes.push([end, -gb]);
  }
  // At the same moment, one ends before another starts.
  changes.sort(([atMs, changeGb], [otherAtMs, otherChangeGb]) => atMs - otherAtMs || changeGb - otherChangeGb);
  let mostHeld = held;
  for (const [, changeGb] of changes) {
    held += changeGb;
    mostHeld = Math.max(mostHeld, held);
  }
  return mostHeld;
}

/**
 * A batch's RAM as its orders will hold it (#232): each operation's threads x RAM, from its start (`launchAt`, or
 * `nowMs` for one already due) to its landing and `BATCH_RAM_RELEASE_MS`.
 */
export function batchRamHolds(threads: BatchThreads, orders: readonly LaunchOrder[], nowMs: number): RamHold[] {
  return orders.map(({ operation, launchAt, landAt }) => ({
    gb: threads[operation] * operationRamGb(operation),
    fromMs: Math.max(launchAt, nowMs),
    untilMs: landAt + BATCH_RAM_RELEASE_MS,
  }));
}

/**
 * Whether a batch fits (#232): at every moment it holds RAM, it and all else `held` then (the operations in flight,
 * the orders of the batches planned, share threads) are within `capacityGb` (`batchRamGb` of the hosts' RAM less what
 * isn't the batcher's). The brain's plan peaks within it as long as every batch is its own, at its level (`batchPlan`);
 * the batches planned before a new plan, or at a lower hacking level (whose leads are longer), may not (#229's suite:
 * 2 to 3% over, as cloud servers were bought back after an install).
 */
export function batchFits(
  threads: BatchThreads,
  orders: readonly LaunchOrder[],
  held: readonly RamHold[],
  capacityGb: number,
  nowMs: number,
): boolean {
  const batchHolds = batchRamHolds(threads, orders, nowMs);
  if (batchHolds.length === 0) return true;
  const fromMs = Math.min(...batchHolds.map((each) => each.fromMs));
  const untilMs = Math.max(...batchHolds.map((each) => each.untilMs));
  return mostRamHeldGb([...held, ...batchHolds], fromMs, untilMs) <= capacityGb + 1e-9;
}

/**
 * The batch with the most hack threads, `mostHack` at most, that fits (`batchFits`), each planned by `planOf`; null
 * when one of 1 doesn't. A batch's RAM only grows with its hack threads (`batchThreads`), so a binary search.
 */
export function largestBatchThatFits<Batch extends { threads: BatchThreads; orders: LaunchOrder[] }>(
  mostHack: number,
  planOf: (hackThreads: number) => Batch,
  held: readonly RamHold[],
  capacityGb: number,
  nowMs: number,
): Batch | null {
  const fitsBeside = (batch: Batch) => batchFits(batch.threads, batch.orders, held, capacityGb, nowMs);
  const asPlanned = planOf(Math.max(1, Math.floor(mostHack)));
  if (fitsBeside(asPlanned)) return asPlanned;
  let fitting: Batch | null = null;
  let low = 1;
  let high = Math.max(1, Math.floor(mostHack)) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const batch = planOf(middle);
    if (fitsBeside(batch)) {
      fitting = batch;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitting;
}

/**
 * A batch fitted to the RAM (#232): the largest that fits beside `held` (`largestBatchThatFits`); whether it was
 * trimmed (fewer hack threads than `plannedHack`, or none); and whether the share's threads did it (#232's review):
 * beside `held` without `shareHeld` (those of `held` that are share threads), it would have been larger.
 */
export function fitBatch<Batch extends { threads: BatchThreads; orders: LaunchOrder[] }>(
  plannedHack: number,
  planOf: (hackThreads: number) => Batch,
  held: readonly RamHold[],
  shareHeld: readonly RamHold[],
  capacityGb: number,
  nowMs: number,
): { batch: Batch | null; trimmed: boolean; trimmedBySharing: boolean } {
  // Destructured: the batcher runs this, and the game would charge hack's RAM for the name (RamCalculations.ts:436).
  const hackOf = (batch: Batch | null) => {
    const { hack: hackThreads } = batch?.threads ?? { hack: 0 };
    return hackThreads;
  };
  const batch = largestBatchThatFits(plannedHack, planOf, held, capacityGb, nowMs);
  const trimmed = hackOf(batch) < Math.max(1, Math.floor(plannedHack));
  if (!trimmed || shareHeld.length === 0) return { batch, trimmed, trimmedBySharing: false };
  const unshared = largestBatchThatFits(
    plannedHack,
    planOf,
    held.filter((each) => !shareHeld.includes(each)),
    capacityGb,
    nowMs,
  );
  return { batch, trimmed, trimmedBySharing: hackOf(unshared) > hackOf(batch) };
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
 * order of the times on its target (never before one already landed there: out of order; #236: only a target's own
 * order matters, and a move's batches land among another target's), and any not recorded `LANDING_LOST_AFTER_MS`
 * after its time is lost. Only expected records count: one this watch never started (a previous batcher's, still
 * landing; one recorded already, or lost) is unexpected, and moves nothing. Nor does one whose call never ran (a late
 * hack, recorded at once with its future time), which would make every earlier landing look out of order.
 */
export class LandingWatch {
  readonly #expected = new Map<string, { landAt: number; target: string }>();
  /** The latest landing recorded, of all and on each target. */
  #latestLandAt = Number.NEGATIVE_INFINITY;
  readonly #latestLandedOn = new Map<string, number>();

  /** An operation's part started on `target` (one for all, by default), to land at `landAt`. */
  expect(id: string, landAt: number, target = ""): void {
    this.#expected.set(id, { landAt, target });
  }

  /** A record from the port: whether it was expected at all, and whether it landed out of order on its target. */
  landed(record: LandingRecord): { outOfOrder: boolean; expected: boolean } {
    const expected = this.#expected.get(record.id);
    if (expected === undefined) return { outOfOrder: false, expected: false };
    this.#expected.delete(record.id);
    if (record.skipped) return { outOfOrder: false, expected: true };
    const latestLandedOnTarget = this.#latestLandedOn.get(expected.target) ?? Number.NEGATIVE_INFINITY;
    this.#latestLandedOn.set(expected.target, Math.max(latestLandedOnTarget, record.landAt));
    this.#latestLandAt = Math.max(this.#latestLandAt, record.landAt);
    return { outOfOrder: record.landAt < latestLandedOnTarget, expected: true };
  }

  /** The parts not recorded long after their time, forgotten now: how many. */
  takeLost(nowMs: number): number {
    return this.takeLostIds(nowMs).length;
  }

  /** The parts not recorded long after their time, forgotten now: their ids (#206: a wave waits for its own). */
  takeLostIds(nowMs: number): string[] {
    const lost: string[] = [];
    for (const [id, { landAt }] of this.#expected) {
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
    for (const { landAt } of this.#expected.values()) earliest = Math.min(earliest, landAt + LANDING_LOST_AFTER_MS + 1);
    return earliest;
  }

  /** Parts started and not yet recorded. */
  inFlight(): number {
    return this.#expected.size;
  }

  /**
   * The latest landing time expected, or recorded, on `target` (#236), or on any without one: a new schedule on a
   * target starts after its own; a new batcher waits for all of them (#205).
   */
  latestLandAt(target?: string): number {
    let latest =
      target === undefined ? this.#latestLandAt : (this.#latestLandedOn.get(target) ?? Number.NEGATIVE_INFINITY);
    for (const each of this.#expected.values()) {
      if (target === undefined || each.target === target) latest = Math.max(latest, each.landAt);
    }
    return latest;
  }
}

/** A grow whose money is to be looked at (#234): its target and that target's maximum money. */
interface GrowLook {
  target: string;
  moneyMax: number;
}

/**
 * The looks at the target's money after each batch's grow (#234). A grow split across hosts runs a `grow` call a part,
 * and each part raises the security before the next grows (ServerHelpers.ts:211, called a part from
 * NetscriptFunctions.ts:292), so above a minimum security of about 8.57, where growth isn't capped (grow.ts:15-18),
 * its later parts grow less than the plan, which counts them all at the minimum. Its margin (`GROW_MARGIN`) covers
 * the batcher's own plans (#234's measurement), so a grow that leaves the target below its maximum is a drift to see.
 * A grow is due once every part started has landed; its money is the grow's only while nothing has landed on its
 * target since but its own weaken2, δ after it (the next batch's hack lands 2δ after it at the least spacing). The
 * batcher drains its landing port as each record is written, so the records drained with a grow's last part are all
 * that have landed.
 */
export class GrowLandingWatch {
  readonly #grows = new Map<string, GrowLook & { landAt: number; parts: Set<string> }>();
  /** Each part started, by id: its batch's grow. */
  readonly #batchOfPart = new Map<string, string>();
  /** The latest landing on each target, and of any record whose target isn't known (it may be any). */
  readonly #latestLandedOn = new Map<string, number>();
  #latestLandedAnywhere = Number.NEGATIVE_INFINITY;
  #landedInFull: (GrowLook & { landAt: number })[] = [];

  /** A batch's grow started, all its parts (`partIds`), to land at `landAt` on `target`. */
  started(batchId: string, target: string, moneyMax: number, landAt: number, partIds: Iterable<string>): void {
    const parts = new Set(partIds);
    if (parts.size === 0) return;
    this.#grows.set(batchId, { target, moneyMax, landAt, parts });
    for (const part of parts) this.#batchOfPart.set(part, batchId);
  }

  /**
   * A part of any operation landed (a record whose call ran) at `landAt`, on `target`; null when that isn't known
   * (#235's review: another run's record, or a lost part's, late), which may have been on any target.
   */
  landed(id: string, landAt: number, target: string | null): void {
    if (target === null) this.#latestLandedAnywhere = Math.max(this.#latestLandedAnywhere, landAt);
    else this.#latestLandedOn.set(target, Math.max(this.#latestLandedOn.get(target) ?? landAt, landAt));
    const batchId = this.#batchOfPart.get(id);
    if (batchId === undefined) return;
    this.#batchOfPart.delete(id);
    const growing = this.#grows.get(batchId);
    if (growing === undefined) return;
    growing.parts.delete(id);
    if (growing.parts.size > 0) return;
    this.#grows.delete(batchId);
    const { target: grownOn, moneyMax, landAt: grownAt } = growing;
    this.#landedInFull.push({ target: grownOn, moneyMax, landAt: grownAt });
  }

  /**
   * A part lost: its grow, if it was one, is forgotten, never looked at (the part's record, if it comes, is another's
   * to ignore: `LandingWatch` has forgotten it too). Its other parts are forgotten as they land.
   */
  lost(id: string): void {
    const batchId = this.#batchOfPart.get(id);
    this.#batchOfPart.delete(id);
    if (batchId !== undefined) this.#grows.delete(batchId);
  }

  /** The grows started whose parts haven't all landed: for its tests, so a part lost is seen to leave none behind. */
  waiting(): number {
    return this.#grows.size;
  }

  /**
   * The grows landed in full since the last call whose money is theirs now (`due`), and how many no longer are
   * (`notLooked`): something has landed on their target since but their own weaken2.
   */
  takeDue(): { due: GrowLook[]; notLooked: number } {
    const due: GrowLook[] = [];
    let notLooked = 0;
    for (const { target, moneyMax, landAt } of this.#landedInFull) {
      const latest = Math.max(this.#latestLandedOn.get(target) ?? landAt, this.#latestLandedAnywhere);
      if (latest > landAt + BATCH_LANDING_GAP_MS) notLooked += 1;
      else due.push({ target, moneyMax });
    }
    this.#landedInFull = [];
    return { due, notLooked };
  }
}

/** A look at `target`'s money after a batch's grow (#234), in the health: `money` of its `moneyMax`. */
export function recordMoneyLook(health: BatcherHealth, target: string, money: number, moneyMax: number): void {
  health.moneyLooks = (health.moneyLooks ?? 0) + 1;
  health.moneyLooksBelowFull = (health.moneyLooksBelowFull ?? 0) + (money < moneyMax ? 1 : 0);
  // Not `share`: the batcher runs this, and the game would charge share's 2.4 GB for the name (RamCalculations.ts:436).
  const fractionOfMax = moneyMax > 0 ? money / moneyMax : 1;
  if (fractionOfMax < (health.leastMoneyAfterGrow ?? 1)) {
    health.leastMoneyAfterGrow = fractionOfMax;
    health.leastMoneyAfterGrowOn = target;
  }
  health.leastMoneyAfterGrow ??= 1;
  health.leastMoneyAfterGrowOn ??= null;
}

/**
 * A hack landed on `target` at `atMs` (#236), in the health: the last hack (the latest landing); and, the first on the
 * target batched (the health's) since that target last changed (`targetChangedSinceHack`, which the batcher sets on a
 * new target, and this clears), a move, idle from the last hack before it, on whatever target that was: the same one
 * after a detour through a target never hacked (#237's review). The target before still lands its batches for a
 * while, among the new one's: a hack of its then is no move, nor is the new target's next. A hack that took nothing
 * (its chance failed) counts too: the batcher is hacking that target.
 */
export function recordHackLanded(health: BatcherHealth, target: string, atMs: number): void {
  const last = health.lastHack ?? null;
  health.lastMove ??= null;
  const onTarget = target === health.target;
  if (last !== null && health.targetChangedSinceHack === true && onTarget) {
    health.lastMove = { from: last.target, to: target, idleMs: Math.max(0, atMs - last.atMs), atMs };
  }
  if (onTarget) health.targetChangedSinceHack = false;
  if (last === null || atMs >= last.atMs) health.lastHack = { target, atMs };
}

/**
 * Grows not looked at (#235's review), in the health: something landed on their target before the look, or they
 * landed while the batcher recovered from a desync (the money then isn't a grow's doing).
 */
export function recordGrowsNotLooked(health: BatcherHealth, count: number): void {
  health.growsNotLooked = (health.growsNotLooked ?? 0) + count;
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
  /**
   * Sharing spare RAM for faction reputation (#224), while the brain wants it (its switch on, faction work going on);
   * absent otherwise. A round of share keeps `reserveGb` of the hosts' free RAM for the batches and the next target
   * (core's `shareReserveGb`), and `homeKeptGb` of home's for the Agent; `cores` are the hosts' with more than 1, for
   * the bonus it reports.
   */
  sharing?: SharingConfig;
}

/** The config's `sharing` (#224). */
export interface SharingConfig {
  reserveGb: number;
  homeKeptGb: number;
  cores: Record<string, number>;
}

/** A config's `sharing`, or why it isn't one. */
function parseSharing(value: unknown): { ok: true; sharing: SharingConfig } | { ok: false; reason: string } {
  const { reserveGb, homeKeptGb, cores } = (value ?? {}) as Record<string, unknown>;
  if (!isFiniteNumber(reserveGb) || reserveGb < 0) {
    return { ok: false, reason: "the config's sharing has no reserveGb of 0 or more" };
  }
  if (!isFiniteNumber(homeKeptGb) || homeKeptGb < 0) {
    return { ok: false, reason: "the config's sharing has no homeKeptGb of 0 or more" };
  }
  if (typeof cores !== "object" || cores === null || !Object.values(cores).every((each) => isFiniteNumber(each))) {
    return { ok: false, reason: "the config's sharing has no cores" };
  }
  return { ok: true, sharing: { reserveGb, homeKeptGb, cores: cores as Record<string, number> } };
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
  const { sharing } = value as Record<string, unknown>;
  const parsedSharing = sharing === undefined || sharing === null ? null : parseSharing(sharing);
  if (parsedSharing !== null && !parsedSharing.ok) return parsedSharing;
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
      ...(parsedSharing === null ? {} : { sharing: parsedSharing.sharing }),
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
   * Batches planned with fewer hack threads than the config's share, or not at all (#232): the hosts' RAM, as the
   * batches planned and in flight will hold it, didn't hold the plan's (core's `largestBatchThatFits`). Absent from an
   * older batcher.
   */
  batchesTrimmed?: number;
  /**
   * Of them, those the share took the RAM of (#232's review): with share threads on its hosts, and planned larger
   * without them. The share's failure, as a batch short beside it is. Absent from an older batcher.
   */
  batchesTrimmedBySharing?: number;
  /**
   * The target's money after each batch's grow (#234): looked at once all of its grow's parts have landed and nothing
   * has landed on its target since but its own weaken2 (it's woken by each landing's record). The looks; those that
   * found it below its maximum (a grow short of the hack before it: a split grow's later parts grow at the security the
   * earlier ones left, and the batches then drift down to the bounds' floor); the run's least money so far, a share of
   * the maximum (1 while none was below), and its target (null before one); and the grows not looked at (#235's
   * review: something else landed on the target first, or they landed while it recovered from a desync). Absent from an
   * older batcher.
   */
  moneyLooks?: number;
  moneyLooksBelowFull?: number;
  leastMoneyAfterGrow?: number;
  leastMoneyAfterGrowOn?: string | null;
  growsNotLooked?: number;
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
  /**
   * The last hack landed (#236): its target and its landing time; null before one. Absent from an older batcher.
   */
  lastHack?: { target: string; atMs: number } | null;
  /**
   * The last move (#236): the first hack on the target batched since it changed, `to`, landed at `atMs`, `idleMs`
   * after the last hack before it, on `from` (`to` itself after a detour through a target never hacked); null before
   * one. Kept until the next move. Absent from an older batcher.
   */
  lastMove?: { from: string; to: string; idleMs: number; atMs: number } | null;
  /**
   * Whether the target batched has changed since the last hack on it (#237's re-review): a move under way, the report's
   * to show while it lasts, a detour back to the same target too. Absent from an older batcher, which counts as false.
   */
  targetChangedSinceHack?: boolean;
  /**
   * Sharing (#224): whether its config asks for it, the share threads running (started under `SHARE_TIME_MS` ago),
   * their RAM, and of it the RAM on its hosts (#230), the bonus they give (core's `shareBonus`), and the room its
   * last look found (the RAM a round could take); null while it neither shares nor is asked to. Absent from an older
   * batcher.
   */
  sharing?: SharingHealth | null;
  /**
   * Operations that found no room at their time and waited for it (#246), then started: how many, and the longest
   * wait, ms (null before one). Absent from an older batcher.
   */
  ramWaits?: number;
  longestRamWaitMs?: number | null;
  /**
   * The last `BATCH_SHORTS_KEPT` batches short of RAM (#246), oldest first: when, what wasn't placed, and what held
   * the RAM, so the run report says each. Absent from an older batcher.
   */
  shorts?: BatchShort[];
  /** The game's clock when this was written. */
  atMs: number;
}

/** How many batches short of RAM (#246) the health keeps: the run report lists each it sees. */
export const BATCH_SHORTS_KEPT = 5;

/**
 * A batch short of RAM (#246): the operation that didn't start, when, and how long it had waited past its time for
 * room; the hosts' free RAM then (in all, and the most on one host); and what held their RAM beside the batcher's
 * operations in flight: those of its operations past their landing and its release that hadn't yet recorded it (on a
 * busy page their scripts end late), scripts not its own, and its share threads. `failedOn` is the host whose `exec`
 * failed, or null when no host had the room.
 */
export interface BatchShort {
  atMs: number;
  target: string;
  operation: BatchOperation;
  threads: number;
  waitedMs: number;
  freeGb: number;
  largestFreeGb: number;
  pastLandingGb: number;
  othersGb: number;
  sharingGb: number;
  failedOn: string | null;
}

/** A batch short of RAM (#246), in the health: counted, and kept among the last `BATCH_SHORTS_KEPT`. */
export function recordShort(health: BatcherHealth, short: BatchShort): void {
  health.batchesShort += 1;
  health.shorts = [...(health.shorts ?? []), short].slice(-BATCH_SHORTS_KEPT);
}

/** An operation that waited `waitedMs` past its time for room (#246), then started, in the health. */
export function recordRamWait(health: BatcherHealth, waitedMs: number): void {
  health.ramWaits = (health.ramWaits ?? 0) + 1;
  health.longestRamWaitMs = Math.max(health.longestRamWaitMs ?? 0, waitedMs);
}

/** The batcher's sharing, in its health (#224). */
export interface SharingHealth {
  wanted: boolean;
  threads: number;
  ramGb: number;
  /**
   * The share threads' RAM on its hosts, the batches' (#230): of `ramGb`, all but home's, which shares beside them
   * unless it is one. Only this can take a batch's RAM. Absent from a batcher before #230 (the brain's `sharingOf`
   * counts all of `ramGb`).
   */
  hostsRamGb: number;
  bonus: number;
  roomGb: number;
}

/** A new batcher's health. */
export function newBatcherHealth(target: string, runName: string, atMs: number): BatcherHealth {
  return {
    state: "preparing",
    target,
    wavesStarted: 0,
    batchesStarted: 0,
    batchesShort: 0,
    batchesTrimmed: 0,
    batchesTrimmedBySharing: 0,
    moneyLooks: 0,
    moneyLooksBelowFull: 0,
    leastMoneyAfterGrow: 1,
    leastMoneyAfterGrowOn: null,
    growsNotLooked: 0,
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
    lastHack: null,
    lastMove: null,
    targetChangedSinceHack: false,
    sharing: null,
    ramWaits: 0,
    longestRamWaitMs: null,
    shorts: [],
    atMs,
  };
}
