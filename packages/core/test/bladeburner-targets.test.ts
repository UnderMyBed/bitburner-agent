// Bladeburner #386: the current-rank targets, the expected time to one (an absorbing chain's, checked against a
// simulated walk), and the rule's choice under a target: the least time to it, a low-chance, high-gain action against a
// steady one on both sides of where they cross; past the target, rank a second.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerPlansToTarget,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { bladeburnerSkillMultsOf } from "../src/bladeburner-skills.ts";
import {
  BLADEBURNER_TARGET_CELLS,
  BLADEBURNER_TARGET_CELLS_A_DISTANCE,
  BLADEBURNER_TARGET_CELLS_A_STEP,
  BLADEBURNER_TARGET_CELLS_MOST,
  type BladeburnerRankSource,
  type BladeburnerRankStep,
  bladeburnerAttemptsInCount,
  bladeburnerCycleStep,
  bladeburnerRankTarget,
  bladeburnerRestStep,
  bladeburnerSecondsToRank,
  bladeburnerSecondsToRankAtLeast,
  bladeburnerStepRise,
  bladeburnerSustainableRate,
  bladeburnerTargetGrid,
} from "../src/bladeburner-targets.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A seeded uniform on [0, 1) (mulberry32): the simulated walk's, the same each run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The walk run `runs` times from `rank`, each gain and loss ±10% uniform as the game's (`Bladeburner.ts:951`, `:980`):
 * its seconds to the target (a step's `attempts`, then its `then`), their mean and the mean's standard error.
 */
function simulate(first: BladeburnerRankStep, rank: number, target: number, runs: number, seed: number) {
  const random = seeded(seed);
  let sum = 0;
  let squares = 0;
  for (let run = 0; run < runs; run++) {
    let x = rank;
    let seconds = 0;
    let step = first;
    let attempts = 0;
    while (x < target) {
      if (attempts >= (step.attempts ?? Number.POSITIVE_INFINITY) && step.next !== undefined) {
        step = step.next;
        attempts = 0;
      }
      // The stock spent, the analytic tail (#392's decision): the rank still needed at its rate.
      if (attempts >= (step.attempts ?? Number.POSITIVE_INFINITY) && step.tailRate !== undefined) {
        seconds += (target - x) / step.tailRate;
        break;
      }
      const offset = 0.9 + 0.2 * random();
      x = random() < step.chance ? x + step.gain * offset + step.rest : Math.max(0, x - step.loss * offset) + step.rest;
      seconds += step.seconds;
      attempts += 1;
    }
    sum += seconds;
    squares += seconds * seconds;
  }
  const mean = sum / runs;
  return { mean, standardError: Math.sqrt((squares / runs - mean * mean) / runs) };
}

describe("the targets", () => {
  test("the faction's 25 while it isn't joined, then the next Black Op's (B5's, #392); met, none", () => {
    // The game's: `RankNeededForFaction: 25` and the join's check against the rank as it is; a Black Op's `reqdRank`.
    expect(gameSource("Bladeburner/data/Constants.ts")).toContain("RankNeededForFaction: 25,");
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain(
      "if (this.rank >= BladeburnerConstants.RankNeededForFaction) {",
    );
    expect(gameSource("Bladeburner/Actions/BlackOperation.ts")).toContain(
      'if (bladeburner.rank < this.reqdRank) return { error: "Insufficient rank" };',
    );
    expect(gameSource("Bladeburner/Bladeburner.ts")).toMatch(/this\.rank \+= change;\n\s+if \(this\.rank < 0\) \{/);
    expect(bladeburnerRankTarget({ rank: 0, factionJoined: false })).toBe(25);
    expect(bladeburnerRankTarget({ rank: 24.99, factionJoined: false })).toBe(25);
    expect(bladeburnerRankTarget({ rank: 25, factionJoined: false })).toBeNull();
    expect(bladeburnerRankTarget({ rank: 3, factionJoined: true })).toBeNull();
    expect(bladeburnerRankTarget({ rank: 3, factionJoined: true, blackOpRank: 2500 })).toBe(2500);
    expect(bladeburnerRankTarget({ rank: 2500, factionJoined: true, blackOpRank: 2500 })).toBeNull();
    // Not joined, the faction's 25 comes first.
    expect(bladeburnerRankTarget({ rank: 3, factionJoined: false, blackOpRank: 2500 })).toBe(25);
  });
});

describe("the expected time to a target", () => {
  test("a success over the whole distance: the geometric wait, seconds over the chance, from any rank", () => {
    const step = { chance: 0.055, gain: 55, loss: 2.5, rest: 0, seconds: 73 };
    for (const rank of [0, 1.3, 12, 24.9]) {
      expect(bladeburnerSecondsToRank(step, rank, 25)).toBeCloseTo(73 / 0.055, 6);
    }
    expect(bladeburnerSecondsToRank(step, 25, 25)).toBe(0);
    expect(bladeburnerSecondsToRank(step, 30, 25)).toBe(0);
  });

  test("a diffusion's formula won't do: it puts Raid's 18 attempts from 0 to 25 at under 4", () => {
    // Brownian motion with drift μ and variance σ² a step, reflected at 0, from x to T: (T − x)/μ − σ²/(2μ²)·
    // (e^(−2μx/σ²) − e^(−2μT/σ²)), the generator's equation σ²/2·f'' + μf' = −1 with f'(0) = 0 and f(T) = 0.
    const step = { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 1 };
    const mu = step.chance * (step.gain + step.rest) + (1 - step.chance) * (step.rest - step.loss);
    const variance =
      step.chance * (step.gain + step.rest) ** 2 + (1 - step.chance) * (step.rest - step.loss) ** 2 - mu * mu;
    const diffusion = 25 / mu - (variance / (2 * mu * mu)) * (1 - Math.exp((-2 * mu * 25) / variance));
    expect(diffusion).toBeLessThan(4);
    expect(bladeburnerSecondsToRank(step, 0, 25)).toBeGreaterThan(18);
  });

  test("no chance and no rest's rank: never; a rest's rank over the loss: it rises", () => {
    expect(bladeburnerSecondsToRank({ chance: 0, gain: 5, loss: 1, rest: 0.5, seconds: 10 }, 0, 25)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(bladeburnerSecondsToRank({ chance: 0.5, gain: 0, loss: 1, rest: 0, seconds: 10 }, 0, 25)).toBe(
      Number.POSITIVE_INFINITY,
    );
    // A failure every step, 2 a step net: 12.5 steps, 125 s, within a cell's 2 steps of the grid.
    const rising = bladeburnerSecondsToRank({ chance: 0, gain: 0, loss: 1, rest: 3, seconds: 10 }, 0, 25);
    expect(Math.abs(rising - 130)).toBeLessThanOrEqual(10);
  });

  // Each step as the hour's: Raid at its 5.5% low end with Field Analysis between, Bounty Hunter's steady rise, and one
  // where the floor holds the walk back (a failure's loss near a success's gain).
  const cases: { name: string; step: BladeburnerRankStep; rank: number }[] = [
    { name: "Raid-like, from 0", step: { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 }, rank: 0 },
    { name: "Raid-like, from 10", step: { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 }, rank: 10 },
    { name: "steady", step: { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 30 }, rank: 0 },
    { name: "floored", step: { chance: 0.45, gain: 3, loss: 2.5, rest: 0, seconds: 40 }, rank: 0 },
    { name: "floored, from 20", step: { chance: 0.45, gain: 3, loss: 2.5, rest: 0, seconds: 40 }, rank: 20 },
    // Every attempt a success of a fifth of the distance: the ±10% decides whether the fifth reaches it (half the time).
    { name: "the ±10% deciding", step: { chance: 1, gain: 5, loss: 0, rest: 0, seconds: 10 }, rank: 0 },
    // The counts (#386's amendment): Raid's 12 attempts, then the steady action from wherever the walk is.
    {
      name: "Raid-like for 12 attempts, then steady",
      step: {
        chance: 0.055,
        gain: 55,
        loss: 2.5,
        rest: 0.14,
        seconds: 116,
        attempts: 12,
        next: { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 60 },
      },
      rank: 3,
    },
    {
      name: "steady for 30 attempts, then resting alone",
      step: {
        chance: 0.4,
        gain: 0.9,
        loss: 0.05,
        rest: 0.05,
        seconds: 60,
        attempts: 30,
        next: bladeburnerRestStep(0.1 / 30),
      },
      rank: 0,
    },
  ];
  test.each(cases)("$name: the chain's against a simulated walk of 20,000 runs", ({ step, rank }) => {
    const target = 25;
    const model = bladeburnerSecondsToRank(step, rank, target);
    const { mean, standardError } = simulate(step, rank, target, 20_000, 386);
    // Within four standard errors (seeded, so the same each run) and 1% for the grid's smoothing
    // (BLADEBURNER_TARGET_CELLS: under 0.8% in these walks).
    expect(BLADEBURNER_TARGET_CELLS).toBe(200);
    const grid = 0.01 * mean;
    console.log(
      `${rank} → ${target}: the chain ${model.toFixed(0)} s, the walk ${mean.toFixed(2)} ± ${standardError.toFixed(2)}`,
    );
    expect(Math.abs(model - mean)).toBeLessThanOrEqual(4 * standardError + grid);
  });

  // A far target, B5's first Black Op's 2,500 (#390's review, #392): from 0, and from near it (a Black Op's loss
  // rebuilt, Raid a single success from it, a count's sequence), the window and the spacing by the grid's rules.
  const steadyFar = { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 30 };
  const tracking = { chance: 0.87, gain: 0.3, loss: 0, rest: 0, seconds: 7 };
  const far: { name: string; step: BladeburnerRankStep; rank: number; runs: number }[] = [
    {
      name: "Raid-like from 0",
      step: { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 },
      rank: 0,
      runs: 2_000,
    },
    { name: "steady from 0", step: steadyFar, rank: 0, runs: 2_000 },
    {
      name: "floored, rising, from 0",
      step: { chance: 0.5, gain: 3, loss: 2.5, rest: 0, seconds: 40 },
      rank: 0,
      runs: 2_000,
    },
    { name: "Tracking-like from 0", step: tracking, rank: 0, runs: 1_000 },
    { name: "Tracking-like from 2,400", step: tracking, rank: 2400, runs: 40_000 },
    { name: "steady from 2,490 (a Black Op's 10 rebuilt)", step: steadyFar, rank: 2490, runs: 40_000 },
    {
      name: "lossless with a rest's share, from 2,490",
      step: { chance: 0.7, gain: 1.5, loss: 0, rest: 0.1, seconds: 20 },
      rank: 2490,
      runs: 40_000,
    },
    {
      name: "Raid-like from 2,440: a success reaches it",
      step: { chance: 0.1, gain: 73, loss: 3.3, rest: 0, seconds: 60 },
      rank: 2440,
      runs: 40_000,
    },
    {
      name: "Raid-like for 12 attempts, then steady, from 2,440",
      step: { chance: 0.1, gain: 73, loss: 3.3, rest: 0, seconds: 60, attempts: 12, next: steadyFar },
      rank: 2440,
      runs: 40_000,
    },
    // The next-best's own count (#392): Raid's 30, then a steady action's 50, then resting alone.
    {
      name: "Raid-like for 30 attempts, a steady one for 50, then resting alone, from 1,000",
      step: {
        chance: 0.1,
        gain: 73,
        loss: 3.3,
        rest: 0,
        seconds: 60,
        attempts: 30,
        next: {
          chance: 0.4,
          gain: 1.5,
          loss: 0,
          rest: 0.05,
          seconds: 30,
          attempts: 50,
          next: bladeburnerRestStep(0.1 / 30),
        },
      },
      rank: 1000,
      runs: 2_000,
    },
    // Three stages ending in the analytic tail (#395's review): the stock walked, then the rank still needed at the rate.
    {
      name: "Tracking-like for 4, Raid-like for 35, then the tail at 0.47 a minute, from 174.7",
      step: {
        chance: 0.87,
        gain: 0.33,
        loss: 0,
        rest: 0,
        seconds: 8,
        attempts: 4,
        next: { chance: 0.1, gain: 55, loss: 2.5, rest: 0.1, seconds: 70, attempts: 35, tailRate: 0.47 / 60 },
      },
      rank: 174.7,
      runs: 20_000,
    },
    {
      name: "Raid-like for 12, a steady one for 40, then the tail, from 2,470 (the stock can reach it)",
      step: {
        chance: 0.1,
        gain: 55,
        loss: 2.5,
        rest: 0.14,
        seconds: 116,
        attempts: 12,
        next: { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 60, attempts: 40, tailRate: 0.3 / 60 },
      },
      rank: 2470,
      runs: 20_000,
    },
    // A slow rise from near it that dips under the window often: the time back up to it counted (none, 10.7% short).
    {
      name: "a slow rise (51% of ±1) from 2,490, often under the window",
      step: { chance: 0.51, gain: 1, loss: 1, rest: 0, seconds: 10 },
      rank: 2490,
      runs: 20_000,
    },
    {
      name: "Raid-like for 30 attempts, then Tracking-like, from 1,000",
      step: { chance: 0.1, gain: 73, loss: 3.3, rest: 0, seconds: 60, attempts: 30, next: tracking },
      rank: 1000,
      runs: 1_000,
    },
  ];
  test.each(far)("$name to 2,500: the chain's against a simulated walk, within 1%", ({ step, rank, runs }) => {
    const target = 2500;
    const grid = bladeburnerTargetGrid(step.next === undefined ? [step] : [step, step.next], rank, target);
    const model = bladeburnerSecondsToRank(step, rank, target);
    const { mean, standardError } = simulate(step, rank, target, runs, 2500);
    console.log(
      `${rank} → ${target} (from ${grid.low.toFixed(0)}, ${grid.cells.join(" and ")} points): the chain ` +
        `${model.toFixed(1)} s, the walk ${mean.toFixed(1)} ± ${standardError.toFixed(1)}`,
    );
    expect(Math.abs(model - mean)).toBeLessThanOrEqual(4 * standardError + 0.01 * mean);
  });

  test("the grid: 200 points at least, 4,000 at most; 8 a largest step, finer near the target; the window", () => {
    const raid = { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 };
    const steady = { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 30 };
    const top = 1 + 0.1 / Math.sqrt(3);
    const spread = 0.2 / Math.sqrt(3);
    expect([BLADEBURNER_TARGET_CELLS, BLADEBURNER_TARGET_CELLS_A_STEP]).toEqual([200, 8]);
    expect([BLADEBURNER_TARGET_CELLS_A_DISTANCE, BLADEBURNER_TARGET_CELLS_MOST]).toEqual([200, 4000]);
    // To 25 from 0, as #386's: 200 points over [0, 25).
    expect(bladeburnerTargetGrid([raid], 0, 25)).toEqual({ low: 0, cells: [200] });
    expect(bladeburnerTargetGrid([steady], 0, 25)).toEqual({ low: 0, cells: [200] });
    // Near 25: the distance's 200th, no finer than an eighth of the nodes' spread of the larger landing; the window from
    // 4 distances and 8 largest steps under the start (Raid's reach under 0: from 0).
    const steadyNear = bladeburnerTargetGrid([steady], 24, 25);
    expect(steadyNear.low).toBeCloseTo(24 - (4 + 8 * (0.9 * top + 0.05)), 12);
    expect(steadyNear.cells).toEqual([Math.ceil((25 - steadyNear.low) / Math.max((0.9 * spread) / 8, 1 / 200))]);
    expect(bladeburnerTargetGrid([raid], 24, 25)).toEqual({ low: 0, cells: [200] });
    // To 2,500 from 0: 8 a largest step, at most 4,000.
    expect(bladeburnerTargetGrid([raid], 0, 2500).cells).toEqual([Math.ceil(2500 / ((55 * top + 0.14) / 8))]);
    expect(bladeburnerTargetGrid([steady], 0, 2500).cells).toEqual([4000]);
    // From near 2,500: the window from 4 distances and 8 of the largest step under the start.
    const near = bladeburnerTargetGrid([steady, raid], 2440, 2500);
    expect(near.low).toBeCloseTo(2440 - (4 * 60 + 8 * (55 * top + 0.14)), 9);
    expect(near.cells).toEqual([
      Math.min(
        4000,
        Math.ceil((2500 - near.low) / Math.min((0.9 * top + 0.05) / 8, Math.max((0.9 * spread) / 8, 60 / 200))),
      ),
      Math.ceil((2500 - near.low) / Math.min((55 * top + 0.14) / 8, Math.max((55 * spread) / 8, 60 / 200))),
    ]);
    // A walk that doesn't rise without the floor keeps it.
    const sinking = { chance: 0.01, gain: 55, loss: 2.5, rest: 0, seconds: 116 };
    expect(bladeburnerStepRise(sinking)).toBeLessThan(0);
    expect(bladeburnerTargetGrid([sinking], 2440, 2500).low).toBe(0);
    expect(bladeburnerTargetGrid([{ ...raid, gain: 0, rest: 0, loss: 0 }], 0, 2500).cells).toEqual([200]);
  });

  test("Wald's bound: the distance over a step's most mean, chance × gain + rest; under the chain's", () => {
    for (const { step, rank } of cases) {
      const bound = bladeburnerSecondsToRankAtLeast(step, rank, 25);
      expect(bound).toBeCloseTo((step.seconds * (25 - rank)) / (step.chance * step.gain + step.rest), 9);
      expect(bound).toBeLessThanOrEqual(bladeburnerSecondsToRank(step, rank, 25));
    }
    const none = { chance: 0, gain: 5, loss: 0, rest: 0, seconds: 10 };
    expect(bladeburnerSecondsToRankAtLeast(none, 0, 25)).toBe(Number.POSITIVE_INFINITY);
    expect(bladeburnerSecondsToRankAtLeast(none, 25, 25)).toBe(0);
  });

  test("the counts: 1 + (count − 1)/(1 − growth × a step's seconds) attempts, unbounded where the growth keeps up", () => {
    // The game's growth: a random tenth of its range each 480 s (`Bladeburner.ts:1388-1393`), Raid's [2, 40] (#383).
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain("/ BladeburnerConstants.ActionCountGrowthPeriod");
    const raid = action("Raid");
    if (raid === undefined) throw new Error("Raid");
    const growth = countGrowthPerSecond(raid);
    expect(growth).toBeCloseTo(21 / 10 / 480, 12);
    // Count 10, 100 s a step: 2.1/480 × 100 = 0.4375 grown an attempt, so 1 + 9/0.5625 = 17 attempts.
    expect(bladeburnerAttemptsInCount(10, growth, 100)).toBe(17);
    expect(bladeburnerAttemptsInCount(1, growth, 100)).toBe(1);
    expect(bladeburnerAttemptsInCount(0.9, growth, 100)).toBe(0);
    expect(bladeburnerAttemptsInCount(10, growth, 480 / 2.1)).toBe(Number.POSITIVE_INFINITY);
    // A step bounded: slower than unbounded when the next is slower, the next's time when none can be made.
    const raidStep = { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 };
    const steady = { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 60 };
    const free = bladeburnerSecondsToRank(raidStep, 0, 25);
    const bounded = bladeburnerSecondsToRank({ ...raidStep, attempts: 5, next: steady }, 0, 25);
    expect(bounded).toBeGreaterThan(free);
    expect(bounded).toBeLessThan(bladeburnerSecondsToRank(steady, 0, 25));
    expect(bladeburnerSecondsToRank({ ...raidStep, attempts: 0, next: steady }, 0, 25)).toBe(
      bladeburnerSecondsToRank(steady, 0, 25),
    );
    expect(bladeburnerSecondsToRank({ ...raidStep, attempts: 5 }, 0, 25)).toBe(Number.POSITIVE_INFINITY);
  });

  test("the cycle's step: an attempt and its share of the rest, s·(1 − duty)/duty, at the rest's rate", () => {
    const cycle = bladeburnerCycleStep({
      chance: 0.1,
      gain: 55,
      loss: 2.5,
      seconds: 70,
      duty: 0.7,
      restRankPerSecond: 0.1 / 30,
    });
    expect(cycle).toMatchObject({ chance: 0.1, gain: 55, loss: 2.5 });
    // 30 s of rest an attempt (70 × 0.3 / 0.7), Field Analysis's 0.1 over them.
    expect(cycle.rest).toBeCloseTo(0.1, 12);
    expect(cycle.seconds).toBeCloseTo(100, 12);
    expect(
      bladeburnerCycleStep({ chance: 0.1, gain: 55, loss: 2.5, seconds: 70, duty: 1, restRankPerSecond: 0.1 / 30 }),
    ).toEqual({ chance: 0.1, gain: 55, loss: 2.5, rest: 0, seconds: 70 });
  });

  test("a low-chance, high-gain action against a steady one: the first from far under the target, the second near it", () => {
    const raid = { chance: 0.055, gain: 55, loss: 2.5, rest: 0.14, seconds: 116 };
    const steady = { chance: 0.4, gain: 0.9, loss: 0.05, rest: 0.05, seconds: 60 };
    // Raid's mean a step is the more rank a second: B2's rule chose it.
    const perSecond = (step: BladeburnerRankStep) =>
      (step.chance * step.gain - (1 - step.chance) * step.loss + step.rest) / step.seconds;
    expect(perSecond(raid)).toBeGreaterThan(perSecond(steady));
    // From 0 Raid's wait is the shorter; from 20 the steady rise to 25 is.
    const at = (rank: number) => [raid, steady].map((step) => bladeburnerSecondsToRank(step, rank, 25));
    const [raidAt0, steadyAt0] = at(0) as [number, number];
    const [raidAt20, steadyAt20] = at(20) as [number, number];
    console.log(`from 0: Raid ${raidAt0.toFixed(0)} s, steady ${steadyAt0.toFixed(0)} s`);
    console.log(`from 20: Raid ${raidAt20.toFixed(0)} s, steady ${steadyAt20.toFixed(0)} s`);
    expect(raidAt0).toBeLessThan(steadyAt0);
    expect(steadyAt20).toBeLessThan(raidAt20);
  });
});

/** A player as BN6's division takes one: the four combat stats at 100, hacking and charisma 1, no intelligence. */
const WHO: BladeburnerPerson = {
  skills: { hacking: 1, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 1, intelligence: 0 },
  mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
};
const action = (name: string) => BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name);

describe("the rule's choice under a target", () => {
  // Bounty Hunter at 20% and Raid at a 5.5% low end, level 1 each, as the hour's after B4's move.
  // Their counts a million: unbounded over any walk here, but where a test sets them.
  const readings = (raidChance: number): BladeburnerActionReading[] => [
    { type: "Contracts", name: "Bounty Hunter", level: 1, maxLevel: 1, count: 1e6, chance: [0.2, 0.2] },
    { type: "Operations", name: "Raid", level: 1, maxLevel: 1, count: 1e6, chance: [raidChance, raidChance] },
  ];
  const max = maxStaminaOf(WHO, 0);
  const choose = (target?: { rank: number; target: number }, raidChance = 0.055) =>
    chooseBladeburnerAction({
      readings: readings(raidChance),
      person: WHO,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
      ...(target === undefined ? {} : { target }),
    });

  test("by rank a second, Raid; under the target, the least time: Raid far under it, Bounty Hunter near it", () => {
    const byRate = choose();
    expect(byRate.work?.name).toBe("Raid");
    expect(byRate.toTarget).toBeUndefined();
    // A plan's time to 25 by hand from its own cycle: the work's step with its rest's share.
    const timeOf = (plan: ReturnType<typeof choose>, rank: number) => {
      const work = plan.work;
      if (work === null) throw new Error("no work");
      const levelled = action(work.name);
      if (levelled === undefined) throw new Error(work.name);
      const step = bladeburnerCycleStep({
        chance: work.chance,
        gain: actionRankGain(levelled, 1, 1),
        loss: actionRankLoss(levelled, 1),
        seconds: actionSeconds(levelled, 1, WHO),
        duty: plan.duty,
        restRankPerSecond: plan.rest.rankPerSecond,
      });
      return bladeburnerSecondsToRank(step, rank, 25);
    };
    // Each alone under the target: its best rest by the time, not the rate.
    const alone = (index: number, rank: number) =>
      chooseBladeburnerAction({
        readings: readings(0.055).slice(index, index + 1),
        person: WHO,
        stamina: max,
        maxStamina: max,
        rankMultiplier: 1,
        speed: 1,
        target: { rank, target: 25 },
      });
    // Where they cross: Raid's wait barely moves with the rank, Bounty Hunter's falls as (25 − rank) over its rate.
    const seconds = (plan: ReturnType<typeof choose>) => plan.toTarget?.seconds ?? Number.NaN;
    let crossing = 0;
    while (seconds(alone(0, crossing)) > seconds(alone(1, crossing))) crossing += 0.5;
    console.log(`Raid's and Bounty Hunter's times to 25 cross at rank ${crossing - 0.5} to ${crossing}`);
    expect(crossing).toBeGreaterThan(0);
    expect(crossing).toBeLessThan(25);
    const under = choose({ rank: crossing - 0.5, target: 25 });
    expect(under.work?.name).toBe("Raid");
    expect(under.toTarget?.target).toBe(25);
    expect(under.toTarget?.seconds).toBeCloseTo(timeOf(under, crossing - 0.5), 6);
    expect(under.toTarget?.seconds).toBeLessThan(seconds(alone(0, crossing - 0.5)));
    const near = choose({ rank: crossing, target: 25 });
    expect(near.work?.name).toBe("Bounty Hunter");
    expect(near.toTarget?.seconds).toBeCloseTo(timeOf(near, crossing), 6);
    expect(near.toTarget?.seconds).toBeLessThan(seconds(alone(1, crossing)));
    // At a 1% low end Raid loses from 0 too: the steady action all the way.
    expect(choose({ rank: 0, target: 25 }, 0.01).work?.name).toBe("Bounty Hunter");
  });

  test("the counts: Raid's spent, the next-best after it; every plan solved gives the same choice as the pruned", () => {
    // Infinite counts: no sequence, so each plan by its own Wald bound, which the pruning stops on.
    for (const raidCount of [Number.POSITIVE_INFINITY, 100, 3, 1.2]) {
      for (const rank of [0, 10, 16, 17, 17.5, 18, 19, 20, 24]) {
        const counted = (each: BladeburnerActionReading) =>
          raidCount === Number.POSITIVE_INFINITY ? { ...each, count: raidCount } : each;
        const input = {
          readings: readings(0.055).map((each) =>
            each.name === "Raid" ? { ...each, count: raidCount } : counted(each),
          ),
          person: WHO,
          stamina: max,
          maxStamina: max,
          rankMultiplier: 1,
          speed: 1,
          target: { rank, target: 25 },
        };
        const all = bladeburnerPlansToTarget(input);
        const chosen = chooseBladeburnerAction(input);
        expect(all.length).toBeGreaterThan(3);
        expect(chosen).toEqual(all[0]);
        for (const each of all) {
          expect(each.toTarget?.seconds).toBeGreaterThanOrEqual(chosen.toTarget?.seconds ?? Number.NaN);
        }
      }
    }
    // Raid's count spent after 1 attempt: its time is the attempt and Bounty Hunter's after, more than unbounded.
    const at = (count: number) =>
      bladeburnerPlansToTarget({
        readings: readings(0.055).map((each) => (each.name === "Raid" ? { ...each, count } : each)),
        person: WHO,
        stamina: max,
        maxStamina: max,
        rankMultiplier: 1,
        speed: 1,
        target: { rank: 0, target: 25 },
      }).find((each) => each.work?.name === "Raid")?.toTarget?.seconds ?? Number.NaN;
    expect(at(1.2)).toBeGreaterThan(at(100));
    expect(
      bladeburnerPlansToTarget({
        ...{ readings: [], person: WHO },
        stamina: max,
        maxStamina: max,
        rankMultiplier: 1,
        speed: 1,
      }),
    ).toEqual([]);
  });

  test("the target met: rank a second, as without one", () => {
    expect(choose({ rank: 25, target: 25 })).toEqual(choose());
    expect(choose({ rank: 30, target: 25 }).work?.name).toBe("Raid");
  });

  test("resting alone under the target: Field Analysis's steady rate, (target − rank) over it", () => {
    const none = chooseBladeburnerAction({
      readings: readings(0.055).map((each) => ({ ...each, count: 0 })),
      person: WHO,
      stamina: max,
      maxStamina: max,
      rankMultiplier: 1,
      speed: 1,
      target: { rank: 20, target: 25 },
    });
    expect(none.work).toBeNull();
    expect(none.toTarget?.seconds).toBeCloseTo(5 / (0.1 / 30), 6);
  });
});

describe("a far target's counts (#392)", () => {
  // bn6-skills' hour at Typhoon's 2,500, its last reading's counts: Tracking's 4.2, Raid's 34.7, Bounty Hunter's 165.2.
  // With the next-best's own count unbounded, each Tracking plan handed the walk to Raid as if unbounded (74.8 h, all
  // alike), under Raid's own 90.1 h, and the rule chose Tracking at 0.343 rank/min against Raid's 0.519.
  const who: BladeburnerPerson = {
    skills: { hacking: 1, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 1, intelligence: 0 },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
  const levels = {
    "Blade's Intuition": 2,
    "Short-Circuit": 4,
    "Digital Observer": 1,
    Tracer: 3,
    Reaper: 2,
    "Evasive System": 2,
    "Cyber's Edge": 1,
  };
  const counts: Record<string, number> = {
    Tracking: 4.2,
    "Bounty Hunter": 165.2,
    Retirement: 169.8,
    Investigation: 37.7,
    "Undercover Operation": 57.9,
    "Sting Operation": 52.2,
    Raid: 34.7,
    "Stealth Retirement Operation": 40.9,
    Assassination: 119.9,
  };
  const maxLevels: Record<string, number> = { Tracking: 8, "Bounty Hunter": 6 };
  const skills = bladeburnerSkillMultsOf(levels);
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, {
      city: { population: 1e9, communities: 50, chaos: 0 },
      penalty: 1,
      skills,
    });
    return {
      type: action.type,
      name: action.name,
      level: 1,
      maxLevel: maxLevels[action.name] ?? 1,
      count: counts[action.name] as number,
      chance: [chance, chance],
    };
  });
  const max = maxStaminaOf(who, 0, skills);
  const input = {
    readings,
    person: who,
    stamina: max,
    maxStamina: max,
    rankMultiplier: 1,
    speed: 1,
    skills: { read: levels },
  };

  const target = { rank: 174.7, target: 2500 };
  const distance = 2500 - 174.7;
  /** The sustainable rate from every plan the rule weighs: each action's best rank a second, its cycle, its growth. */
  function sustainable(every: ReturnType<typeof bladeburnerPlansToTarget>) {
    const supply = new Map<string, { growthPerSecond: number; options: { rise: number; seconds: number }[] }>();
    for (const plan of every) {
      if (plan.work === null) continue;
      const action = BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === plan.work?.name);
      if (action === undefined) continue;
      const known = supply.get(action.name) ?? { growthPerSecond: countGrowthPerSecond(action), options: [] };
      const seconds = plan.work.seconds / plan.duty;
      known.options.push({ rise: plan.rankPerSecond * seconds, seconds });
      supply.set(action.name, known);
    }
    const alone = every.find((plan) => plan.work === null);
    return bladeburnerSustainableRate([...supply.values()], alone?.rankPerSecond ?? 0);
  }

  test("the choice is the stock's best rank a second (#392's decision): the tail common to every plan", () => {
    const every = bladeburnerPlansToTarget({ ...input, target });
    const chosen = chooseBladeburnerAction({ ...input, target });
    expect(chosen).toEqual(every[0]);
    // The best rank a second of every plan the rule weighs: Raid's here, a count of 34.7.
    const fastest = Math.max(...every.map((plan) => plan.rankPerSecond));
    expect(chosen.rankPerSecond).toBe(fastest);
    expect(chosen.work?.name).toBe("Raid");
    // Wald: no plan's walk under the distance over the fastest rate; and none under what the counts can't cover at
    // the sustainable rate (each attempt at most its chance × gain at its best level, a tenth more for the growth over
    // its own steps). A next-best run past its own count (#386's, unbounded) went under it.
    const rate = sustainable(every);
    const counted = readings.reduce((total, read) => {
      const action = BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === read.name);
      if (action === undefined) return total;
      let most = 0;
      for (let level = 1; level <= read.maxLevel; level++) {
        const chance = Math.min(1, read.chance[0] * action.difficultyFac ** (1 - level));
        most = Math.max(most, chance * actionRankGain(action, level, 1));
      }
      return total + 1.1 * read.count * most;
    }, 0);
    expect(distance - counted).toBeGreaterThan(0);
    for (const plan of every) {
      const seconds = plan.toTarget?.seconds ?? 0;
      expect(seconds).toBeGreaterThanOrEqual(distance / fastest);
      expect(seconds).toBeGreaterThanOrEqual((distance - counted) / rate);
    }
    console.log(
      `at 174.7 → 2,500: ${chosen.work?.name} level ${chosen.work?.level} at ${(60 * chosen.rankPerSecond).toFixed(3)} ` +
        `rank/min, ${((chosen.toTarget?.seconds ?? 0) / 3600).toFixed(2)} h; the sustainable rate ` +
        `${(60 * rate).toFixed(3)} rank/min`,
    );
  });
  test("the ETA is continuous across a count's start threshold (#395's review): the regrowth is the action's", () => {
    // Raid's count from 1.6 (workable now) to 0.9 (not): its regrowth stays in the sustainable rate.
    const at = (raid: number) =>
      chooseBladeburnerAction({
        ...input,
        readings: readings.map((read) => (read.name === "Raid" ? { ...read, count: raid } : read)),
        target,
      }).toTarget?.seconds ?? 0;
    const workable = at(1.6);
    const short = at(0.9);
    console.log(`Raid's count 1.6: ${(workable / 3600).toFixed(3)} h; 0.9: ${(short / 3600).toFixed(3)} h`);
    // Under 1 Raid's own stock (0.6 of an attempt here) goes: at most its share of the walk, well under 1%.
    expect(Math.abs(short - workable) / workable).toBeLessThan(0.01);
  });

  test("a next-best no faster than the tail straight away isn't taken (#395's review): at 2,400, Tracking level 2", () => {
    // Without the condition, Raid level 1's next-best (slower than the tail) was taken: 3.713 h against 3.567.
    const near = chooseBladeburnerAction({ ...input, target: { rank: 2400, target: 2500 } });
    expect(near.work).toMatchObject({ name: "Tracking", level: 2 });
    expect(near).toEqual(bladeburnerPlansToTarget({ ...input, target: { rank: 2400, target: 2500 } })[0]);
    expect((near.toTarget?.seconds ?? 0) / 3600).toBeLessThan(3.6);
  });
});

describe("the sustainable rate (#392's decision)", () => {
  /** One way to work each: its rise a second of its cycle, its cycle's seconds and its growth. */
  const single = (rankPerSecond: number, seconds: number, growthPerSecond: number): BladeburnerRankSource => ({
    growthPerSecond,
    options: [{ rise: rankPerSecond * seconds, seconds }],
  });

  test("one way an action: each to its count's growth, the most rank a second first, the rest resting alone", () => {
    // By hand: 0.01 a second for a share of 100 s × 0.001 = 0.1, 0.005 for 0.2, the rest (0.7) at 0.001.
    expect(bladeburnerSustainableRate([single(0.005, 50, 0.004), single(0.01, 100, 0.001)], 0.001)).toBeCloseTo(
      0.1 * 0.01 + 0.2 * 0.005 + 0.7 * 0.001,
      12,
    );
    // One whose growth more than fills the second takes it all; one under resting alone isn't worked.
    expect(bladeburnerSustainableRate([single(0.01, 100, 0.05)], 0.001)).toBeCloseTo(0.01, 12);
    expect(bladeburnerSustainableRate([single(0.0005, 10, 0.1)], 0.001)).toBeCloseTo(0.001, 12);
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain(
      "contract.count += (seconds * contract.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;",
    );
  });

  test("levels trade rise against time (#395's review): the linear programme's best, over any one level an action", () => {
    // A: a slow way (4 rank in 100 s) and a fast one (2.5 in 40 s); B: 1 in 50 s; the second binding. Which way of A,
    // and how much of B, is the linear programme's; checked against every mix on a grid.
    const a = {
      growthPerSecond: 0.01,
      options: [
        { rise: 4, seconds: 100 },
        { rise: 2.5, seconds: 40 },
      ],
    };
    const b = { growthPerSecond: 0.012, options: [{ rise: 1, seconds: 50 }] };
    const rate = bladeburnerSustainableRate([a, b], 0);
    // Brute force over the mixes: A's attempts split between its ways, B's, within the growth and the second.
    let best = 0;
    for (let slow = 0; slow <= 100; slow++) {
      for (let fast = 0; slow + fast <= 100; fast++) {
        const xs = (0.01 * slow) / 100;
        const xf = (0.01 * fast) / 100;
        const left = 1 - 100 * xs - 40 * xf;
        if (left < 0) continue;
        const xb = Math.min(0.012, left / 50);
        best = Math.max(best, 4 * xs + 2.5 * xf + xb);
      }
    }
    expect(rate).toBeCloseTo(best, 9);
    // Each action at one way only (its best rank a second, the greedy fill): less.
    const greedy = bladeburnerSustainableRate([{ ...a, options: [{ rise: 2.5, seconds: 40 }] }, b], 0);
    expect(rate).toBeGreaterThanOrEqual(greedy);
    console.log(
      `two ways: ${rate.toFixed(5)} a second, the best mix's ${best.toFixed(5)}; one way each ${greedy.toFixed(5)}`,
    );
  });

  /**
   * A long walk with the counts regrowing as the game's (each second a random integer in its range, a tenth of it
   * over 480, `Bladeburner.ts:1388-1393`), each action worked whenever its count allows, the most rank a second first,
   * else resting; each attempt its cycle's seconds with the rest's rank in it. Its rank a second by 20 batches.
   */
  function walk(
    actions: readonly {
      chance: number;
      gain: number;
      loss: number;
      seconds: number;
      rest: number;
      growth: readonly [number, number];
    }[],
    restRate: number,
  ) {
    const mean = (action: (typeof actions)[number]) =>
      action.chance * action.gain - (1 - action.chance) * action.loss + action.rest;
    const rate = bladeburnerSustainableRate(
      actions.map((action) =>
        single(mean(action) / action.seconds, action.seconds, (action.growth[0] + action.growth[1]) / 2 / 10 / 480),
      ),
      restRate,
    );
    const random = seeded(392);
    const counts = actions.map(() => 0);
    const order = actions
      .map((action, index) => ({ index, rate: mean(action) / action.seconds }))
      .sort((x, y) => y.rate - x.rate)
      .map((each) => each.index);
    const grow = (seconds: number) => {
      actions.forEach((action, index) => {
        for (let second = 0; second < seconds; second++) {
          const growth = action.growth[0] + Math.floor(random() * (action.growth[1] - action.growth[0] + 1));
          counts[index] = (counts[index] as number) + growth / 10 / 480;
        }
      });
    };
    const batches: number[] = [];
    for (let batch = 0; batch < 20; batch++) {
      let time = 0;
      let rank = 0;
      while (time < 1e6) {
        const index = order.find((each) => (counts[each] as number) >= 1);
        if (index === undefined) {
          grow(30);
          time += 30;
          rank += restRate * 30;
          continue;
        }
        const action = actions[index] as (typeof actions)[number];
        counts[index] = (counts[index] as number) - 1;
        grow(action.seconds);
        time += action.seconds;
        const offset = 0.9 + 0.2 * random();
        rank += (random() < action.chance ? action.gain * offset : -action.loss * offset) + action.rest;
      }
      batches.push(rank / time);
    }
    const walked = batches.reduce((total, each) => total + each, 0) / batches.length;
    const standardError = Math.sqrt(
      batches.reduce((total, each) => total + (each - walked) ** 2, 0) / (batches.length - 1) / batches.length,
    );
    return { rate, walked, standardError };
  }

  test("against a long walk with the counts regrowing as the game's: within 4 standard errors and 1%", () => {
    // Raid-, Bounty Hunter- and Tracking-like; the second not binding (their shares 0.31, 0.25 and 0.10).
    const { rate, walked, standardError } = walk(
      [
        { chance: 0.1, gain: 55, loss: 2.5, seconds: 70, rest: 0, growth: [2, 40] },
        { chance: 0.45, gain: 1.4, loss: 0, seconds: 30, rest: 0, growth: [5, 75] },
        { chance: 0.7, gain: 0.35, loss: 0, seconds: 12, rest: 0, growth: [5, 75] },
      ],
      0.1 / 30,
    );
    console.log(
      `the sustainable rate ${(3600 * rate).toFixed(2)} rank/h; the walk's ${(3600 * walked).toFixed(2)} ± ` +
        `${(3600 * standardError).toFixed(2)}`,
    );
    expect(Math.abs(walked - rate)).toBeLessThanOrEqual(4 * standardError + 0.01 * rate);
  });

  test("with the second binding and the stamina's rests in each cycle: within 4 standard errors and 1%", () => {
    // Each cycle an attempt and its rest at Field Analysis's rate; the shares 0.88, 0.83 and 0.50: the second binds.
    const field = 0.1 / 30;
    const { rate, walked, standardError } = walk(
      [
        { chance: 0.1, gain: 55, loss: 2.5, seconds: 200, rest: 130 * field, growth: [2, 40] },
        { chance: 0.45, gain: 1.4, loss: 0, seconds: 100, rest: 70 * field, growth: [5, 75] },
        { chance: 0.7, gain: 0.35, loss: 0, seconds: 60, rest: 48 * field, growth: [5, 75] },
      ],
      field,
    );
    console.log(
      `binding: the sustainable rate ${(3600 * rate).toFixed(2)} rank/h; the walk's ${(3600 * walked).toFixed(2)} ± ` +
        `${(3600 * standardError).toFixed(2)}`,
    );
    expect(Math.abs(walked - rate)).toBeLessThanOrEqual(4 * standardError + 0.01 * rate);
  });
});
