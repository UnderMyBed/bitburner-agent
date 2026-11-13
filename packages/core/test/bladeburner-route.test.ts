// Bladeburner B6 (#398): BN6's win route. The route's time to the destroy by hand and against a seeded walk, the
// estimate from a reading against the B5 formulas it sums, The Red Pill's hacking level by the formulas (#359's
// figures), and the planner's choice between the two.
import { describe, expect, test } from "vitest";
import { hackingExpForLevel } from "../src/augmentation-plan.ts";
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerTailRate,
  chooseBladeburnerAction,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_BLACK_OPS,
  type BladeburnerBlackOp,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSuccessChance,
} from "../src/bladeburner-black-ops.ts";
import {
  type BlackOpsRouteOp,
  blackOpsRouteEstimate,
  blackOpsRouteSeconds,
  chooseWinRoute,
  redPillLevelSeconds,
} from "../src/bladeburner-route.ts";
import { bladeburnerSkillMultsOf } from "../src/bladeburner-skills.ts";

/** A seeded uniform on [0, 1) (mulberry32): the walk's, the same each run. */
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

/** Four Black Ops scaled down for the walk: each its rank, chance, seconds, a success's rank and a failure's loss. */
const OPS: BlackOpsRouteOp[] = [
  { name: "one", rank: 1000, chance: 0.8, seconds: 30, gain: 50, loss: 40 },
  { name: "two", rank: 1500, chance: 0.5, seconds: 45, gain: 80, loss: 60 },
  { name: "three", rank: 2200, chance: 0.3, seconds: 60, gain: 100, loss: 300 },
  { name: "four", rank: 3000, chance: 0.6, seconds: 90, gain: 200, loss: 100 },
];
/** The work between them: an attempt each second, 2 rank at 75%, 0.8 lost at 25%: 1.3 rank a second. */
const WORK = { chance: 0.75, gain: 2, loss: 0.8, seconds: 1 };
const WORK_RATE = (WORK.chance * WORK.gain - (1 - WORK.chance) * WORK.loss) / WORK.seconds;

describe("the route's time (#398): the sum's terms", () => {
  test("by hand: each one's rank over the rate from where its predecessor left it, plus (T + (1 − p)·L/ρ)/p", () => {
    const route = blackOpsRouteSeconds({ rank: 800, rate: WORK_RATE, firstToRankSeconds: null, ops: OPS });
    const rho = WORK_RATE;
    // One: 200 to its rank; then from 1,050, two's 450; from 1,580, three's 620; from 2,300, four's 700.
    const toRank = [200 / rho, 450 / rho, 620 / rho, 700 / rho];
    const attempts = OPS.map((op) => (op.seconds + (1 - op.chance) * (op.loss / rho)) / op.chance);
    route.steps.forEach((step, index) => {
      expect(step.toRankSeconds, step.name).toBeCloseTo(toRank[index] as number, 9);
      expect(step.rebuildSeconds, step.name).toBeCloseTo((OPS[index] as BlackOpsRouteOp).loss / rho, 9);
      expect(step.attemptsSeconds, step.name).toBeCloseTo(attempts[index] as number, 9);
    });
    const sum = toRank.reduce((a, b) => a + b, 0) + attempts.reduce((a, b) => a + b, 0);
    expect(route.seconds).toBeCloseTo(sum, 9);
    expect(route.rate).toBe(rho);
  });

  test("the first one's time to its rank is B5's where given; a rank already past an op's adds none; never at 0", () => {
    const given = blackOpsRouteSeconds({ rank: 800, rate: WORK_RATE, firstToRankSeconds: 123, ops: OPS });
    expect(given.steps[0]?.toRankSeconds).toBe(123);
    // At or past the first's rank: none to it, and the rest from the rank as it is.
    const past = blackOpsRouteSeconds({ rank: 1200, rate: WORK_RATE, firstToRankSeconds: 999, ops: OPS });
    expect(past.steps[0]?.toRankSeconds).toBe(0);
    expect(past.steps[1]?.toRankSeconds).toBeCloseTo((1500 - 1250) / WORK_RATE, 9);
    // A chance of 1 is its seconds alone; 0 is never; no rate is never too.
    const sure = blackOpsRouteSeconds({
      rank: 1000,
      rate: 0,
      firstToRankSeconds: 0,
      ops: [{ ...OPS[0], chance: 1 } as BlackOpsRouteOp],
    });
    expect(sure.seconds).toBe(30);
    const none = blackOpsRouteSeconds({
      rank: 1000,
      rate: WORK_RATE,
      firstToRankSeconds: 0,
      ops: [{ ...OPS[0], chance: 0 } as BlackOpsRouteOp],
    });
    expect(none.seconds).toBe(Number.POSITIVE_INFINITY);
    expect(blackOpsRouteSeconds({ rank: 0, rate: 0, firstToRankSeconds: null, ops: OPS }).seconds).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("against a seeded walk of the game's steps: within four standard errors and 1%", () => {
    // The walk: work's attempts until the next Black Op's rank, then its attempt (its seconds; a success its gain, a
    // failure its loss, each ±10% uniform as the game's, `Bladeburner.ts:1033`, `:1058`), until the last is done.
    const random = seeded(398);
    const runs = 20_000;
    const times: number[] = [];
    const offset = () => 0.9 + 0.2 * random();
    for (let run = 0; run < runs; run++) {
      let rank = 800;
      let time = 0;
      let next = 0;
      while (next < OPS.length) {
        const op = OPS[next] as BlackOpsRouteOp;
        if (rank >= op.rank) {
          time += op.seconds;
          if (random() < op.chance) {
            rank += op.gain * offset();
            next += 1;
          } else rank = Math.max(0, rank - op.loss * offset());
        } else {
          time += WORK.seconds;
          rank = random() < WORK.chance ? rank + WORK.gain * offset() : Math.max(0, rank - WORK.loss * offset());
        }
      }
      times.push(time);
    }
    const mean = times.reduce((a, b) => a + b, 0) / runs;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / (runs - 1);
    const standardError = Math.sqrt(variance / runs);
    const route = blackOpsRouteSeconds({ rank: 800, rate: WORK_RATE, firstToRankSeconds: null, ops: OPS });
    console.log(
      `the route: ${route.seconds.toFixed(1)} s by the sum; the walk ${mean.toFixed(1)} ± ${standardError.toFixed(1)} s ` +
        `(${runs} runs), ${(((route.seconds - mean) / mean) * 100).toFixed(2)}%`,
    );
    expect(Math.abs(route.seconds - mean)).toBeLessThan(4 * standardError);
    expect(Math.abs(route.seconds - mean) / mean).toBeLessThan(0.01);
  });
});

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma 1. */
function person(combat: number): BladeburnerPerson {
  return {
    skills: {
      hacking: 1,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma: 1,
      intelligence: 0,
    },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

describe("the estimate from a reading (#398): B5's formulas summed", () => {
  const CITY = { population: 1e9, communities: 50, chaos: 0 };
  const who = person(5000);
  const levels = { "Blade's Intuition": 40, Overclock: 50 };
  const mults = bladeburnerSkillMultsOf(levels);
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty: 1, skills: mults });
    return { type: action.type, name: action.name, level: 1, maxLevel: 5, count: 50, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0, mults);
  const input = {
    readings,
    person: who,
    stamina: maxStamina,
    maxStamina,
    rankMultiplier: 1,
    speed: 1,
    skills: { read: levels },
  };
  const ULTRON = BLADEBURNER_BLACK_OPS[17] as BladeburnerBlackOp;

  test("the next one at its low end read, the later ones at the formula times its share; B5's times and ranks", () => {
    const formula = (op: BladeburnerBlackOp) => blackOpSuccessChance(op, who, { penalty: 1, skills: mults });
    // The low end read at 80% of the formula's (pop/popEst at the low end).
    const low = 0.8 * formula(ULTRON);
    expect(formula(ULTRON)).toBeLessThan(1);
    const route = blackOpsRouteEstimate(input, { rank: 240_000, next: ULTRON, chanceRead: [low, formula(ULTRON)] });
    expect(route.steps.map((step) => step.name)).toEqual(BLADEBURNER_BLACK_OPS.slice(17).map((op) => op.name));
    route.steps.forEach((step, index) => {
      const op = BLADEBURNER_BLACK_OPS[17 + index] as BladeburnerBlackOp;
      expect(step.chance, op.name).toBeCloseTo(index === 0 ? low : Math.min(1, 0.8 * formula(op)), 12);
      expect(step.seconds).toBe(blackOpSeconds(op, who, mults));
      expect(step.gain).toBe(blackOpRankGain(op, 1));
      expect(step.loss).toBe(blackOpRankLoss(op));
    });
    // The next one's rank by B5's least expected time (its stock and tail); the rest at the sustainable rate.
    const rate = bladeburnerTailRate(input);
    expect(rate).toBeGreaterThan(0);
    expect(route.rate).toBe(rate);
    const toUltron = chooseBladeburnerAction({ ...input, target: { rank: 240_000, target: ULTRON.rank } }).toTarget;
    expect(route.steps[0]?.toRankSeconds).toBe(toUltron?.seconds);
    expect(route.steps[1]?.toRankSeconds).toBeCloseTo((300_000 - (250_000 + 10_000)) / rate, 6);
    // The rule's own time to the next one's rank, where given, is taken as it is.
    const given = blackOpsRouteEstimate(input, {
      rank: 240_000,
      next: ULTRON,
      chanceRead: [low, formula(ULTRON)],
      firstToRankSeconds: 42,
    });
    expect(given.steps[0]?.toRankSeconds).toBe(42);
    expect(given.seconds - route.seconds).toBeCloseTo(42 - (toUltron?.seconds ?? 0), 6);
    console.log(
      `from rank 240,000 at combat 5,000: ${(route.seconds / 3600).toFixed(1)} h; ${route.steps
        .map((step) => `${step.name} ${(100 * step.chance).toFixed(1)}%`)
        .join(", ")}`,
    );
  });

  test("a chance of 0 now is never (the competence's rise is B7's): the route's time at the competence now", () => {
    const weak = { ...input, person: person(100) };
    const route = blackOpsRouteEstimate(weak, { rank: 240_000, next: ULTRON, chanceRead: [0, 0] });
    expect(route.seconds).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("The Red Pill's route in BN6 (#398, #359): hopeless by the formulas", () => {
  test("#359's figures: e^(8,143/32m) times BN4's experience at a multiplier m, 10^22 at 5 and 10^5.5 at 20", () => {
    // w0r1d_d43m0n at 3,000 × 2 = 6,000 at BN6's level multiplier 0.35, against BN4's 9,000 at 1.
    for (const [m, decades] of [
      [5, 22.1],
      [20, 5.5],
    ] as const) {
      const ratio = hackingExpForLevel(6000, 0.35 * m) / hackingExpForLevel(9000, m);
      expect(Math.log10(ratio)).toBeCloseTo(decades, 1);
      expect(Math.log(ratio)).toBeCloseTo(8143 / (32 * m), 0);
    }
  });

  test("the level's time by the formulas, at the multiplier the level and experience imply now", () => {
    // Level 1,000 at an experience giving a multiplier of 0.35 × 3: 6,000 needs e^((6000/1.05 + 200)/32).
    const multiplier = 0.35 * 3;
    const exp = hackingExpForLevel(1000, multiplier);
    const seconds = redPillLevelSeconds({ level: 1000, exp, requiredLevel: 6000, expPerSecond: 1e6 });
    expect((seconds as number) / ((hackingExpForLevel(6000, multiplier) - exp) / 1e6)).toBeCloseTo(1, 9);
    expect((seconds as number) / 3.15e7).toBeGreaterThan(1e60);
    expect(redPillLevelSeconds({ level: 6000, exp, requiredLevel: 6000, expPerSecond: 1 })).toBe(0);
    expect(redPillLevelSeconds({ level: 1000, exp, requiredLevel: 6000, expPerSecond: null })).toBeNull();
    // Past what a double holds: never.
    expect(redPillLevelSeconds({ level: 5, exp: 1000, requiredLevel: 6000, expPerSecond: 1e9 })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("the planner's choice: the least estimate, The Red Pill's only measured and within the BitNode's time so far", () => {
    // Hopeless: past the BitNode's time so far (decision 67's point 8), or never.
    expect(chooseWinRoute({ blackOpsSeconds: 3600, redPillSeconds: 1e70, soFarSeconds: 36_000 })).toMatchObject({
      route: "blackOps",
      redPillHopeless: true,
    });
    expect(
      chooseWinRoute({ blackOpsSeconds: null, redPillSeconds: Number.POSITIVE_INFINITY, soFarSeconds: null }),
    ).toMatchObject({ route: "blackOps", redPillHopeless: true });
    // Not measured: the rules' offer, the Black Ops.
    expect(chooseWinRoute({ blackOpsSeconds: 3600, redPillSeconds: null, soFarSeconds: 36_000 })).toMatchObject({
      route: "blackOps",
      redPillHopeless: null,
    });
    // Shorter but past the bar: hopeless all the same (the bar is the BitNode's time so far itself).
    expect(chooseWinRoute({ blackOpsSeconds: 1e6, redPillSeconds: 50_000, soFarSeconds: 36_000 })).toMatchObject({
      route: "blackOps",
      redPillHopeless: true,
    });
    // Within the bar: the shorter, either way; the Black Ops never, The Red Pill's within it wins.
    expect(chooseWinRoute({ blackOpsSeconds: 3600, redPillSeconds: 7200, soFarSeconds: 36_000 }).route).toBe(
      "blackOps",
    );
    expect(chooseWinRoute({ blackOpsSeconds: 7200, redPillSeconds: 3600, soFarSeconds: 36_000 }).route).toBe("redPill");
    expect(
      chooseWinRoute({ blackOpsSeconds: Number.POSITIVE_INFINITY, redPillSeconds: 3600, soFarSeconds: 36_000 }).route,
    ).toBe("redPill");
  });
});
