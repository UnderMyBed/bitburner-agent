import { describe, expect, test } from "vitest";
import { growthLogPerThread, percentMoneyHackedPerThread } from "../src/hack-loop.ts";
import {
  coreBonus,
  GROW_SCRIPT_RAM_GB,
  GROW_SECURITY_PER_THREAD,
  GROW_TIME_PER_HACK_TIME,
  HACK_SCRIPT_RAM_GB,
  HACK_SECURITY_PER_THREAD,
  type HackingPlayer,
  hackChance,
  hackingIncomePerGigabyteSecond,
  hackTimeSeconds,
  intelligenceBonus,
  WEAKEN_SCRIPT_RAM_GB,
  WEAKEN_SECURITY_PER_THREAD,
  WEAKEN_TIME_PER_HACK_TIME,
} from "../src/hacking-ceiling.ts";

const player = (hacking: number, overrides: Partial<HackingPlayer["mults"]> = {}, intelligence = 0): HackingPlayer => ({
  skills: { hacking, intelligence },
  mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1, ...overrides },
});

/** zer0 (BN1): $187.5m at most, security 10 at least, needs hacking 75, growth 25. */
const zer0 = { moneyMax: 187_500_000, minDifficulty: 10, requiredHackingSkill: 75, serverGrowth: 25 };
/** n00dles: $1.75m at most, security 1, needs 1, growth 3000. */
const n00dles = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };

test("the game's figures: script RAM (RamCostGenerator.ts:11-20), security a thread (Constants.ts:9-10, grow 2x)", () => {
  expect([HACK_SCRIPT_RAM_GB, GROW_SCRIPT_RAM_GB, WEAKEN_SCRIPT_RAM_GB]).toEqual([1.7, 1.75, 1.75]);
  expect([HACK_SECURITY_PER_THREAD, GROW_SECURITY_PER_THREAD, WEAKEN_SECURITY_PER_THREAD]).toEqual([
    0.002, 0.004, 0.05,
  ]);
  // Grow 3.2x and weaken 4x a hack's time (Hacking.ts:83-94).
  expect([GROW_TIME_PER_HACK_TIME, WEAKEN_TIME_PER_HACK_TIME]).toEqual([3.2, 4]);
});

describe("hackChance: the game's calculateHackingChance, Hacking.ts:9-24", () => {
  test("(1.75 hacking - required)/(1.75 hacking) x (100 - security)/100 x hacking_chance x the intelligence bonus", () => {
    const server = { hackDifficulty: 10, requiredHackingSkill: 75 };
    expect(hackChance(server, player(150))).toBeCloseTo(((262.5 - 75) / 262.5) * 0.9, 15);
    expect(hackChance(server, player(150, { hacking_chance: 1.1 }))).toBeCloseTo(
      ((262.5 - 75) / 262.5) * 0.9 * 1.1,
      15,
    );
    expect(hackChance(server, player(150, {}, 100))).toBeCloseTo(
      ((262.5 - 75) / 262.5) * 0.9 * (1 + 100 ** 0.8 / 600),
      15,
    );
  });

  test("between 0 and 1: none at security 100 or more, or 1.75 x hacking at or below the hacking needed", () => {
    expect(hackChance({ hackDifficulty: 100, requiredHackingSkill: 1 }, player(150))).toBe(0);
    expect(hackChance({ hackDifficulty: 120, requiredHackingSkill: 1_000 }, player(150))).toBe(0);
    expect(hackChance({ hackDifficulty: 10, requiredHackingSkill: 262.5 }, player(150))).toBe(0);
    expect(hackChance({ hackDifficulty: 10, requiredHackingSkill: 300 }, player(150))).toBe(0);
    expect(hackChance({ hackDifficulty: 1, requiredHackingSkill: 1 }, player(150, { hacking_chance: 5 }))).toBe(1);
    // 1.75 x hacking counts as at least 1 (clampNumber(…, 1), Hacking.ts:16): at hacking 0 a server needing 1 has
    // none, not NaN; at 0.4 (no game's level), one needing 0.5 has (1 - 0.5)/1.
    expect(hackChance({ hackDifficulty: 1, requiredHackingSkill: 1 }, player(0))).toBe(0);
    expect(hackChance({ hackDifficulty: 0, requiredHackingSkill: 0.5 }, player(0.4))).toBe(0.5);
  });
});

describe("hackTimeSeconds: the game's calculateHackingTime, Hacking.ts:60-80", () => {
  test("5 x (2.5 x required x security + 500)/(hacking + 50) / (hacking_speed x the intelligence bonus)", () => {
    // zer0 at its minimum, hacking 150: 5 x 2375 / 200.
    expect(hackTimeSeconds({ hackDifficulty: 10, requiredHackingSkill: 75 }, player(150))).toBeCloseTo(59.375, 12);
    expect(
      hackTimeSeconds({ hackDifficulty: 10, requiredHackingSkill: 75 }, player(150, { hacking_speed: 1.25 })),
    ).toBeCloseTo(47.5, 12);
    expect(hackTimeSeconds({ hackDifficulty: 10, requiredHackingSkill: 75 }, player(150, {}, 100))).toBeCloseTo(
      59.375 / (1 + 100 ** 0.8 / 600),
      12,
    );
  });

  test("the intelligence bonus, intelligence.ts:1-3, and the core bonus, ServerHelpers.ts:287-290", () => {
    expect(intelligenceBonus(0)).toBe(1);
    expect(intelligenceBonus(255)).toBeCloseTo(1 + 255 ** 0.8 / 600, 15);
    expect(coreBonus(1)).toBe(1);
    expect(coreBonus(4)).toBe(1 + 3 / 16);
  });
});

/**
 * One batch, as a batcher would size it, but with fractional threads: hack a share f of the maximum with f/p threads,
 * grow it back with the threads the game's own rule gives (`numCycleForGrowthCorrected`, ServerHelpers.ts:90-199, here
 * solved exactly, not rounded up) for each hack that succeeds, and weaken what both add. Money and GB-seconds are
 * expected values a batch.
 */
function batchIncomePerGigabyteSecond(target: typeof zer0, hacker: HackingPlayer, share: number, cores = 1): number {
  const atMinimum = { hackDifficulty: target.minDifficulty, requiredHackingSkill: target.requiredHackingSkill };
  const chance = hackChance(atMinimum, hacker);
  const perThread = percentMoneyHackedPerThread(atMinimum, hacker);
  const growthLog =
    growthLogPerThread({ serverGrowth: target.serverGrowth, hackDifficulty: target.minDifficulty }, hacker) *
    coreBonus(cores);
  const hackThreads = share / perThread;
  // (M(1 - f) + x) e^(kx) = M, by Newton's method on log((o + x)/n) + kx, as the game does.
  const [start, end] = [target.moneyMax * (1 - share), target.moneyMax];
  let growThreads = (end - start) / (1 + (end / 16 + (start * 15) / 16) * growthLog);
  for (let step = 0; step < 100; step++) {
    const ox = start + growThreads;
    growThreads = (growThreads - ox * Math.log(ox / end)) / (1 + ox * growthLog);
  }
  const security = chance * (hackThreads * HACK_SECURITY_PER_THREAD + growThreads * GROW_SECURITY_PER_THREAD);
  const weakenThreads = security / (WEAKEN_SECURITY_PER_THREAD * coreBonus(cores));
  const hackSeconds = hackTimeSeconds(atMinimum, hacker);
  const gigabyteSeconds =
    hackThreads * HACK_SCRIPT_RAM_GB * hackSeconds +
    chance * growThreads * GROW_SCRIPT_RAM_GB * hackSeconds * GROW_TIME_PER_HACK_TIME +
    weakenThreads * WEAKEN_SCRIPT_RAM_GB * hackSeconds * WEAKEN_TIME_PER_HACK_TIME;
  return (chance * share * target.moneyMax) / gigabyteSeconds;
}

describe("hackingIncomePerGigabyteSecond: the most a GB-second of the hosts' RAM can hack, at the target's best", () => {
  test("RAM over the GB-seconds a dollar costs at least: hack, grow and weaken, worked by hand on zer0", () => {
    const hacker = player(150);
    const p = (0.9 * (76 / 150)) / 240;
    const c = ((262.5 - 75) / 262.5) * 0.9;
    const k = Math.log1p(0.003) * 0.25;
    const t = 59.375;
    const m = zer0.moneyMax;
    const growThreads = 1 / (m * k + 1);
    const perDollar =
      (1.7 * t) / (c * p * m) +
      1.75 * 3.2 * t * growThreads +
      1.75 * 4 * t * ((0.002 / (p * m) + 0.004 * growThreads) / 0.05);
    expect(hackingIncomePerGigabyteSecond(zer0, hacker, 1)).toBeCloseTo(1 / perDollar, 12);
    // About $323 a GB-second: 100 GB of hosts could earn about $32,000 a second on zer0 at hacking 150, three quarters
    // of the RAM growing it back (zer0's growth is 25).
    expect(hackingIncomePerGigabyteSecond(zer0, hacker, 1)).toBeCloseTo(323.397, 3);
  });

  test("the limit of a batch's income as its share falls, which is above every batch's (grow's log is convex)", () => {
    for (const [target, hacking, cores] of [
      [zer0, 150, 1],
      [zer0, 400, 4],
      [n00dles, 20, 1],
      [n00dles, 300, 2],
    ] as const) {
      const ceiling = hackingIncomePerGigabyteSecond(target, player(hacking), cores);
      let previous = 0;
      for (const share of [0.9, 0.5, 0.1, 0.01, 1e-4]) {
        const batch = batchIncomePerGigabyteSecond(target, player(hacking), share, cores);
        expect(batch).toBeLessThanOrEqual(ceiling);
        expect(batch).toBeGreaterThan(previous);
        previous = batch;
      }
      expect(previous / ceiling).toBeGreaterThan(0.9999);
    }
  });

  test("every multiplier and the cores move it the right way", () => {
    const base = hackingIncomePerGigabyteSecond(zer0, player(150), 1);
    for (const mult of ["hacking_chance", "hacking_speed", "hacking_money", "hacking_grow"] as const) {
      expect(hackingIncomePerGigabyteSecond(zer0, player(150, { [mult]: 1.5 }), 1), mult).toBeGreaterThan(base);
    }
    expect(hackingIncomePerGigabyteSecond(zer0, player(150, {}, 50), 1)).toBeGreaterThan(base);
    expect(hackingIncomePerGigabyteSecond(zer0, player(150), 8)).toBeGreaterThan(base);
    expect(hackingIncomePerGigabyteSecond(zer0, player(300), 1)).toBeGreaterThan(base);
  });

  test("none where it can't be hacked: below the hacking needed, no money, security 100, no chance", () => {
    expect(hackingIncomePerGigabyteSecond(zer0, player(74), 1)).toBe(0);
    expect(hackingIncomePerGigabyteSecond({ ...zer0, moneyMax: 0 }, player(150), 1)).toBe(0);
    expect(hackingIncomePerGigabyteSecond({ ...zer0, minDifficulty: 100 }, player(150), 1)).toBe(0);
    expect(hackingIncomePerGigabyteSecond(zer0, player(150, { hacking_chance: 0 }), 1)).toBe(0);
    // No growth: every dollar must be grown back $1 a thread (grow.ts:46), dear but finite.
    const noGrowth = hackingIncomePerGigabyteSecond({ ...zer0, serverGrowth: 0 }, player(150), 1);
    expect(noGrowth).toBeGreaterThan(0);
    expect(noGrowth).toBeLessThan(0.01);
  });
});
