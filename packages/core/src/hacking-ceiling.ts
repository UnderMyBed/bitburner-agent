/**
 * The hacking ceiling (#196, M4 phase A slice A1): the most hacking income a GB-second of RAM can earn on a target,
 * from the game's formulas, so "how good is our hacking" is a number: what hacking earned, against this times the hack
 * loop's RAM. Shared by the brain (the dashboard, the run report) and, later, the batcher (A7), which is scored on it.
 * BitNode multipliers are taken as 1, until they come to core: exact in BN1; elsewhere `ScriptHackMoney`,
 * `ScriptHackMoneyGain`, `ServerGrowthRate` and `HackingSpeedMultiplier` are at most 1 (BitNode.tsx), so this errs
 * high, the safe side for a ceiling, but for BN11's `ServerWeakenRate` of 2 (BitNode.tsx:896), where it errs low.
 */
import { growthLogPerThread, percentMoneyHackedPerThread } from "./hack-loop.ts";

/** A script that only hacks, a thread: 1.6 GB base + `hack`'s 0.1 (Netscript/RamCostGenerator.ts:11, 16). */
export const HACK_SCRIPT_RAM_GB = 1.7;
/** One that only grows: + `grow`'s 0.15 (RamCostGenerator.ts:18). */
export const GROW_SCRIPT_RAM_GB = 1.75;
/** One that only weakens: + `weaken`'s 0.15 (RamCostGenerator.ts:20). */
export const WEAKEN_SCRIPT_RAM_GB = 1.75;
/** Security a successful hack thread adds: `ServerFortifyAmount` (Constants.ts:9; NetscriptHelpers.tsx:613). */
export const HACK_SECURITY_PER_THREAD = 0.002;
/** A grow thread used adds twice that (ServerHelpers.ts:209-211). */
export const GROW_SECURITY_PER_THREAD = 0.004;
/** A weaken thread takes off `ServerWeakenAmount` x its host's core bonus (Constants.ts:10; ServerHelpers.ts:292-295). */
export const WEAKEN_SECURITY_PER_THREAD = 0.05;
/** A grow takes 3.2 hacks' time, a weaken 4 (Hacking.ts:83-94). */
export const GROW_TIME_PER_HACK_TIME = 3.2;
export const WEAKEN_TIME_PER_HACK_TIME = 4;

/** What the formulas read of `ns.getPlayer()`. */
export interface HackingPlayer {
  skills: { hacking: number; intelligence: number };
  mults: { hacking_chance: number; hacking_speed: number; hacking_money: number; hacking_grow: number };
}

/** A server's static figures, as the static snapshot has them. */
export interface HackingTarget {
  moneyMax: number;
  minDifficulty: number;
  requiredHackingSkill: number;
  serverGrowth: number;
}

/** The game's `calculateIntelligenceBonus` at weight 1 (PersonObjects/formulas/intelligence.ts:1-3). */
export function intelligenceBonus(intelligence: number): number {
  return 1 + intelligence ** 0.8 / 600;
}

/** The game's `getCoreBonus` (ServerHelpers.ts:287-290): grow and weaken are this much stronger on a host's cores. */
export function coreBonus(cores: number): number {
  return 1 + (cores - 1) / 16;
}

/**
 * The chance a hack succeeds, on a rooted server: the game's `calculateHackingChance` (Hacking.ts:9-24),
 * `(1.75 hacking - required)/(1.75 hacking) x (100 - security)/100 x hacking_chance x the intelligence bonus`, the
 * 1.75 hacking at least 1, the whole between 0 and 1. 0 at security 100 or more.
 */
export function hackChance(
  server: { hackDifficulty: number; requiredHackingSkill: number },
  player: HackingPlayer,
): number {
  if (server.hackDifficulty >= 100) return 0;
  const skillMult = Math.max(1.75 * player.skills.hacking, 1);
  const chance =
    ((skillMult - server.requiredHackingSkill) / skillMult) *
    ((100 - server.hackDifficulty) / 100) *
    player.mults.hacking_chance *
    intelligenceBonus(player.skills.intelligence);
  return Math.min(1, Math.max(chance, 0));
}

/**
 * A hack's time in seconds, fixed as it starts (NetscriptHelpers.tsx:544): the game's `calculateHackingTime`
 * (Hacking.ts:60-80), `5 x (2.5 x required x security + 500)/(hacking + 50) / (hacking_speed x the intelligence
 * bonus)`. A grow takes `GROW_TIME_PER_HACK_TIME` of it, a weaken `WEAKEN_TIME_PER_HACK_TIME`.
 */
export function hackTimeSeconds(
  server: { hackDifficulty: number; requiredHackingSkill: number },
  player: HackingPlayer,
): number {
  const skillFactor = (2.5 * server.requiredHackingSkill * server.hackDifficulty + 500) / (player.skills.hacking + 50);
  return (5 * skillFactor) / (player.mults.hacking_speed * intelligenceBonus(player.skills.intelligence));
}

/**
 * The most hacking income a GB-second of RAM can earn on `target` (#196), in $: 1 over the GB-seconds each dollar
 * costs at least, with `cores` the hosts' best for grow and weaken. At the target's minimum security and maximum money
 * M, where every figure is at its best (the largest share p, chance c and growth log k, the shortest hack time T):
 * - **hack:** 1/(c p M) threads, failed ones included, each `HACK_SCRIPT_RAM_GB` for T;
 * - **grow:** at least 1/(M k + 1) threads, each `GROW_SCRIPT_RAM_GB` for 3.2 T. Growing back a share f takes x threads
 *   with (M(1 - f) + x) e^(kx) = M (grow.ts:38-58: $1 a thread first, then e^(kx)); log(1 + u) <= u gives
 *   x >= f M/(M k + 1), whatever f;
 * - **weaken:** what those add, 0.002 for each successful hack thread, 1/(p M) a dollar, and 0.004 a grow thread, over
 *   0.05 x the core bonus, each `WEAKEN_SCRIPT_RAM_GB` for 4 T.
 * A batch taking a share f costs at least this a dollar; only as f goes to 0 does it get there (grow's log is convex), so
 * the best over f is this limit. It assumes continuous batching with no gaps, every operation landing at the right
 * moment, fractional threads, and security and money held at their best: an upper bound, not a plan. 0 where nothing
 * can be hacked: no money, below the hacking it needs, security 100, or no chance.
 */
export function hackingIncomePerGigabyteSecond(target: HackingTarget, player: HackingPlayer, cores: number): number {
  const atMinimum = { hackDifficulty: target.minDifficulty, requiredHackingSkill: target.requiredHackingSkill };
  const money = target.moneyMax;
  const share = percentMoneyHackedPerThread(atMinimum, player);
  const chance = hackChance(atMinimum, player);
  if (!(money > 0) || !(share > 0) || !(chance > 0)) return 0;
  const bonus = coreBonus(cores);
  const growthLog =
    growthLogPerThread({ serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty }, player) * bonus;
  const hackSeconds = hackTimeSeconds(atMinimum, player);
  const hackThreads = 1 / (chance * share * money);
  const growThreads = 1 / (money * growthLog + 1);
  const weakenThreads =
    (HACK_SECURITY_PER_THREAD / (share * money) + GROW_SECURITY_PER_THREAD * growThreads) /
    (WEAKEN_SECURITY_PER_THREAD * bonus);
  const gigabyteSecondsPerDollar =
    hackSeconds *
    (hackThreads * HACK_SCRIPT_RAM_GB +
      growThreads * GROW_SCRIPT_RAM_GB * GROW_TIME_PER_HACK_TIME +
      weakenThreads * WEAKEN_SCRIPT_RAM_GB * WEAKEN_TIME_PER_HACK_TIME);
  return 1 / gigabyteSecondsPerDollar;
}
