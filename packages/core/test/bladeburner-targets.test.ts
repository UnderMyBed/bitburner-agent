// Bladeburner #386: the current-rank targets, the expected time to one (an absorbing chain's, checked against a
// simulated walk), and the rule's choice under a target: the least time to it, a low-chance, high-gain action against a
// steady one on both sides of where they cross; past the target, rank a second.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerPlansToTarget,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_TARGET_CELLS,
  type BladeburnerRankStep,
  bladeburnerAttemptsInCount,
  bladeburnerCycleStep,
  bladeburnerRankTarget,
  bladeburnerRestStep,
  bladeburnerSecondsToRank,
  bladeburnerSecondsToRankAtLeast,
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
  test("the faction's 25 while it isn't joined, then the next Black Op's (B5's hook); met, none", () => {
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
