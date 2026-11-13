// The hacking level's rise over faction work (#401): the level's path from the measured experience rate, the work's
// reputation along it, the cycles after an install, and the hindcast of BN4.2's work rates, cycle by cycle.
import { describe, expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { hackingExpOfLevel } from "../src/batcher.ts";
import { repToFavor } from "../src/donations.ts";
import { factionReputationPerSecond } from "../src/faction-work.ts";
import {
  LEVEL_RISE_TERM,
  type LevelRise,
  laterCycleRise,
  levelAlong,
  levelRiseOf,
  reputationAlong,
  workSecondsAlong,
} from "../src/level-rise.ts";
import { levellingInstallMultipliers, secondsToHackingLevel } from "../src/levelling.ts";
import { C1_BOUGHT, type Cycle, BN4_2, SOURCE_FILE_1_3, BN4_FACTION_WORK_REP_GAIN, MINUTE, multipliers, favourMultiplier, rateIn, measuredExp, measuredFactor, endRise, gainOf, rampOf, RAMP_FALLBACK_MINUTES, deadFor, measuredExpAt } from "./bn4-2-fixture.ts";

/** A level-linear rate, as hacking work's is (`reputation.ts:16-24`). */
const linear = (perLevel: number) => (level: number) => perLevel * level;

describe("the level's path (#401)", () => {
  const rise = levelRiseOf({ exp: hackingExpOfLevel(500, 1.5), level: 500, levelMult: 1.5, expPerSecond: 2e4 });

  test("κ is the rate measured over the level + 50; none measured, not finite or 0: flat", () => {
    expect(rise.kappa).toBeCloseTo(2e4 / (500 + LEVEL_RISE_TERM), 9);
    for (const expPerSecond of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const flat = levelRiseOf({ exp: 1e6, level: 500, levelMult: 1.5, expPerSecond });
      expect(flat.kappa).toBe(0);
      expect(levelAlong(flat, 3600)).toBe(500);
    }
  });

  test("the level along it reaches each level when levelling's time to it says (the same model, #336)", () => {
    for (const target of [520, 600, 800]) {
      const seconds = secondsToHackingLevel(rise.exp, target, 1.5, { expPerSecond: 2e4, atLevel: 500 });
      expect(levelAlong(rise, seconds)).toBeCloseTo(target, 0);
    }
    expect(levelAlong(rise, 0)).toBe(500);
  });

  test("the level rises faster with a faster rate, and only rises", () => {
    const faster = { ...rise, kappa: rise.kappa * 2 };
    let last = 500;
    for (const seconds of [60, 600, 3600]) {
      const level = levelAlong(rise, seconds);
      expect(level).toBeGreaterThan(last);
      expect(levelAlong(faster, seconds)).toBeGreaterThan(level);
      last = level;
    }
  });
});

describe("the work's reputation along the path (#401)", () => {
  const rise = levelRiseOf({ exp: hackingExpOfLevel(500, 1.5), level: 500, levelMult: 1.5, expPerSecond: 2e4 });
  const flat: LevelRise = { ...rise, kappa: 0 };
  const rate = linear(0.01);

  test("flat, today's τ: the reputation over the rate at the level now, after the start", () => {
    expect(workSecondsAlong(flat, rate, 10_000)).toBe(10_000 / 5);
    expect(workSecondsAlong(flat, rate, 10_000, 300)).toBe(300 + 10_000 / 5);
    expect(workSecondsAlong(flat, () => 0, 10_000)).toBe(Number.POSITIVE_INFINITY);
    expect(reputationAlong(flat, rate, 100, 400)).toBe(5 * 300);
  });

  test("rising, τ falls with the rate, and the reputation along it adds up to what was asked", () => {
    const along = workSecondsAlong(rise, rate, 10_000);
    expect(along).toBeLessThan(workSecondsAlong(flat, rate, 10_000));
    expect(workSecondsAlong({ ...rise, kappa: rise.kappa * 3 }, rate, 10_000)).toBeLessThan(along);
    expect(reputationAlong(rise, rate, 0, along)).toBeCloseTo(10_000, -1);
    // The level at the end is past the level now, so the rate there is too.
    expect(levelAlong(rise, along)).toBeGreaterThan(500);
  });

  test("from a later start, the work earns at the level then: sooner than from now plus the same work", () => {
    const fromNow = workSecondsAlong(rise, rate, 10_000);
    const later = workSecondsAlong(rise, rate, 10_000, 600);
    expect(later).toBeGreaterThan(600);
    expect(later - 600).toBeLessThan(fromNow);
    expect(reputationAlong(rise, rate, 600, later)).toBeCloseTo(10_000, -1);
  });

  test("none to earn: the start; a rate never above 0: never", () => {
    expect(workSecondsAlong(rise, rate, 0, 120)).toBe(120);
    expect(workSecondsAlong(rise, () => 0, 10)).toBe(Number.POSITIVE_INFINITY);
    expect(reputationAlong(rise, rate, 400, 100)).toBe(0);
  });
});

describe("a dead time, and a level multiplier of 0 (#405's review)", () => {
  const rise = levelRiseOf({ exp: hackingExpOfLevel(500, 1.5), level: 500, levelMult: 1.5, expPerSecond: 2e4 });
  const rate = linear(0.01);

  test("flat for the dead time, then the path as it would have run from its start", () => {
    const late = { ...rise, delaySeconds: 600 };
    expect(levelAlong(late, 300)).toBe(500);
    expect(levelAlong(late, 600)).toBe(500);
    expect(levelAlong(late, 600 + 1800)).toBeCloseTo(levelAlong(rise, 1800), 6);
    // The work earns at the level now meanwhile, then along the path: between the flat τ and the undelayed one.
    const flatTau = workSecondsAlong({ ...rise, kappa: 0 }, rate, 10_000);
    const delayed = workSecondsAlong(late, rate, 10_000);
    expect(delayed).toBeGreaterThan(workSecondsAlong(rise, rate, 10_000));
    expect(delayed).toBeLessThan(flatTau);
    expect(reputationAlong(late, rate, 0, 600)).toBeCloseTo(rate(500) * 600, 6);
    expect(reputationAlong(late, rate, 0, delayed)).toBeCloseTo(10_000, -1);
    expect(laterCycleRise(rise, { hacking: 1, hackingExp: 1, hackingSpeed: 1 }, 300).delaySeconds).toBe(300);
    expect(laterCycleRise(rise, { hacking: 1, hackingExp: 1, hackingSpeed: 1 })).not.toHaveProperty("delaySeconds");
  });

  test("a level multiplier of 0 or less (BN12's, `skill.ts:10-12`): flat, the rate at the level now", () => {
    for (const levelMult of [0, -1]) {
      const held = { ...rise, levelMult };
      expect(levelAlong(held, 3600)).toBe(500);
      expect(workSecondsAlong(held, rate, 10_000)).toBe(10_000 / 5);
      expect(reputationAlong(held, rate, 0, 100)).toBe(500);
    }
  });
});

describe("the cycle after an install (#401)", () => {
  test("from no experience at level 1, m × the install's hacking, κ × its hacking_exp × hacking_speed", () => {
    const rise = levelRiseOf({ exp: 1e8, level: 900, levelMult: 2, expPerSecond: 9.5e4 });
    const gain = { hacking: 1.1, hackingExp: 1.2, hackingSpeed: 1.05 };
    const after = laterCycleRise(rise, gain);
    expect(after).toEqual({ exp: 0, level: 1, levelMult: 2.2, kappa: rise.kappa * 1.2 * 1.05 });
    // Faster with the gains than without them.
    const plain = laterCycleRise(rise, { hacking: 1, hackingExp: 1, hackingSpeed: 1 });
    expect(levelAlong(after, 1800)).toBeGreaterThan(levelAlong(plain, 1800));
  });

  test("its level along the path is de/dt = κ(L + 50) stepped finely, from the first seconds on", () => {
    const after = laterCycleRise(levelRiseOf({ exp: 1e8, level: 900, levelMult: 2, expPerSecond: 9.5e4 }), {
      hacking: 1.1,
      hackingExp: 1.2,
      hackingSpeed: 1.05,
    });
    const levelOf = (exp: number) => after.level + 32 * after.levelMult * (Math.log(exp + 534.6) - Math.log(534.6));
    // Euler at a millisecond, to each mark in turn.
    let exp = 0;
    const dt = 0.001;
    let at = 0;
    for (const mark of [1, 10, 60, 600]) {
      while (at < mark - dt / 2) {
        exp += after.kappa * (levelOf(exp) + LEVEL_RISE_TERM) * dt;
        at += dt;
      }
      expect(levelAlong(after, mark)).toBeCloseTo(levelOf(exp), 0);
    }
  });
});

/**
 * Cycle `index`'s mean work rate as the brain takes it (#405's second review): at the cycle's first work, from the
 * experience and the level then (as measured), the carried κ after what's left of the dead time, the level held at
 * what it is meanwhile; the work from then to T.
 */
const brainMean = (index: number) => {
  const before = BN4_2[index - 1] as Cycle;
  const cycle = BN4_2[index] as Cycle;
  const gain = levellingInstallMultipliers(before.neuroFlux, before.bought);
  const exp = measuredExpAt(index, cycle.firstWork);
  const levelMult = multipliers[index]?.hacking ?? 1;
  const rise = {
    exp,
    level: levelMult * (32 * Math.log(exp + 534.6) - 200),
    levelMult,
    kappa: endRise(index - 1).kappa * gain.hackingExp * gain.hackingSpeed,
    delaySeconds: Math.max(0, deadFor(index).minutes - cycle.firstWork) * MINUTE,
  };
  const workSeconds = (cycle.T - cycle.firstWork) * MINUTE;
  return reputationAlong(rise, rateIn(index, measuredFactor(index - 1)), 0, workSeconds) / (cycle.T * MINUTE);
};

const predictedMean = (index: number, dead = true) => {
  const before = BN4_2[index - 1] as Cycle;
  const cycle = BN4_2[index] as Cycle;
  const rise = endRise(index - 1);
  const deadSeconds = dead ? deadFor(index).minutes * MINUTE : 0;
  const after = laterCycleRise(rise, levellingInstallMultipliers(before.neuroFlux, before.bought), deadSeconds);
  const reputation = reputationAlong(
    after,
    rateIn(index, measuredFactor(index - 1)),
    cycle.firstWork * MINUTE,
    cycle.T * MINUTE,
  );
  return reputation / (cycle.T * MINUTE);
};

describe("the hindcast (#401): BN4.2's work rate each cycle, predicted from the cycle before's measures", () => {
  test("the multipliers from what each install bought are the ones the report read", () => {
    BN4_2.forEach((cycle, index) => {
      expect(multipliers[index]?.hacking).toBeCloseTo(cycle.hacking, 2);
      expect(multipliers[index]?.hackingExp).toBeCloseTo(cycle.hackingExp, 2);
    });
  });

  test("the measured factor, the share's place, is the share's size: ×1.2 to ×1.7 (`Share.ts:43-49`, #345's 1.6)", () => {
    BN4_2.slice(0, -1).forEach((_, index) => {
      expect(measuredFactor(index)).toBeGreaterThan(1.2);
      expect(measuredFactor(index)).toBeLessThan(1.7);
    });
  });

  /**
   * Every cycle, c2 to c8, within ×2 (#401's bar), each at its ratio pinned to 0.05. A first model, the cycle before's
   * measured level path in experience times the install's gains, gave 0.34 at c2 (0.89–0.96 at c3–c8): c1's path was
   * built on 32 GB of home RAM from the BitNode's start, which c2 began with 32,768 GB of. The rate measured at c1's
   * end carries the RAM it ended with, so this model's c2 is 1.15. Neither fits anything to the targets.
   * Since #405's review the path starts after the measured dead time: the cycle before's ramp (`rampOf`), else the
   * last measured before it, else the brain's fallback, 10 minutes. The evidence's levels are coarse (100, 300, 500,
   * 1,000 and the peak), so a ramp is to the quarter minute between them; c1 has none carried in, and c2, c4 and c6
   * never reached the κ carried into them. Without the dead time, as the PR's first round: `without`. The ramps are
   * coarse: c3's 19.25 minutes is mostly straight lines between its marks (300 at 3, 500 at 15, 724 at 67 minutes).
   * `ratio` is the model from the install (c4's 0.53 is that model's: c3's 19.25 minutes is half of c4's 37); `brain` is
   * the model as the brain takes it (`brainMean`: from the first work, the level held at what it is for what's left of
   * the dead time): 0.86–1.03.
   */
  test.each([
    { cycle: 2, dead: "10 (fallback)", deadMinutes: 10, measured: false, ratio: 0.92, without: 1.148, brain: 1.034 },
    { cycle: 3, dead: "10 (fallback)", deadMinutes: 10, measured: false, ratio: 0.852, without: 0.972, brain: 0.909 },
    { cycle: 4, dead: "19.25 (c3's)", deadMinutes: 19.25, measured: true, ratio: 0.532, without: 1.08, brain: 0.911 },
    {
      cycle: 5,
      dead: "19.25 (c3's, the last measured)",
      deadMinutes: 19.25,
      measured: true,
      ratio: 0.659,
      without: 0.915,
      brain: 0.86,
    },
    { cycle: 6, dead: "4.5 (c5's)", deadMinutes: 4.5, measured: true, ratio: 0.998, without: 1.069, brain: 1.026 },
    {
      cycle: 7,
      dead: "4.5 (c5's, the last measured)",
      deadMinutes: 4.5,
      measured: true,
      ratio: 0.864,
      without: 0.92,
      brain: 0.923,
    },
    { cycle: 8, dead: "3.75 (c7's)", deadMinutes: 3.75, measured: true, ratio: 0.943, without: 0.968, brain: 0.959 },
  ])(
    "c$cycle: dead time $dead min, predicted over measured $ratio from the install ($without without it), $brain as the brain takes it",
    (row) => {
      const index = row.cycle - 1;
      expect(deadFor(index)).toEqual({ minutes: row.deadMinutes, measured: row.measured });
      const measured = (BN4_2[index] as Cycle).mean;
      const ratio = predictedMean(index) / measured;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2);
      expect(ratio).toBeCloseTo(row.ratio, 2);
      expect(predictedMean(index, false) / measured).toBeCloseTo(row.without, 2);
      const brain = brainMean(index) / measured;
      expect(brain).toBeCloseTo(row.brain, 2);
      expect(brain).toBeGreaterThan(0.5);
      expect(brain).toBeLessThan(2);
    },
  );

  test("the rise across the BitNode: c2 to c8 measured ×5.2, predicted within ×2 of it", () => {
    const measured = (BN4_2[7] as Cycle).mean / (BN4_2[1] as Cycle).mean;
    const predicted = predictedMean(7) / predictedMean(1);
    expect(measured).toBeCloseTo(5.17, 1);
    expect(predicted / measured).toBeGreaterThan(0.5);
    expect(predicted / measured).toBeLessThan(2);
  });
});

/**
 * The Red Pill holds of BN1.2, BN1.3, BN1.4 and BN4.1 (#345, #351; #401's extraction from a read-only copy of the
 * store, `m4/401/holds/holds.md`): Daedalus's hacking work at favour 0, from the hold's start to the donations install
 * chosen, for 462,491 reputation (favour 150's). At the start: the experience, the level and the multipliers (the
 * medium snapshot's), Daedalus's reputation, and `HackingExpRate` over the 10 minutes before (BN1.4's over 7: its
 * install was 7.1 min before); the share's mean over the hold, the online minutes taken, and the level at the end.
 * The cycle before (the follow-up extraction): `HackingExpRate`'s last whole 10-minute window at its install (2 s
 * before it), with the level, the experience and `mults.hacking` then; the hold's start that long after the install.
 * The install's gains are the hold's multipliers over the cycle before's.
 */
const RED_PILL_HOLDS = [
  {
    node: "BN1.2",
    exp: 7_734_500.9,
    level: 2970,
    mults: { hacking: 9.657123, hackingExp: 10.171725, hackingSpeed: 3.594061, factionRep: 3.221262 },
    gain: 1,
    share: 1.603094,
    windowRate: 8041.87,
    reputation: 28.46,
    actual: 62.27,
    endLevel: 5188,
    sinceInstall: 16.081,
    before: {
      expPerSecond: 734_704,
      level: 3310,
      exp: 453_162_546,
      hacking: 7.5617,
      hackingExp: 8.7611,
      hackingSpeed: 3.0349,
    },
    old: 98.0,
    modelB: 61.3,
    modelBFromStart: 62.4,
    window: 86.7,
  },
  {
    node: "BN1.3",
    exp: 10_293_170.9,
    level: 2679,
    mults: { hacking: 8.459827, hackingExp: 12.474879, hackingSpeed: 3.148467, factionRep: 3.041148 },
    gain: 1,
    share: 1.625467,
    windowRate: 10_211.96,
    reputation: 24.2,
    actual: 72.35,
    endLevel: 4679,
    sinceInstall: 17.114,
    before: {
      expPerSecond: 193_783,
      level: 1715,
      exp: 209_714_258,
      hacking: 4.1515,
      hackingExp: 8.0221,
      hackingSpeed: 2.4604,
    },
    old: 113.5,
    modelB: 74.4,
    modelBFromStart: 75.8,
    window: 100.1,
  },
  {
    node: "BN1.4",
    exp: 59_038_789.3,
    level: 5569,
    mults: { hacking: 14.947369, hackingExp: 22.041423, hackingSpeed: 5.562915, factionRep: 4.985894 },
    gain: 1,
    share: 1.615845,
    windowRate: 139_980.96,
    reputation: 130.48,
    actual: 30.14,
    endLevel: 7694,
    sinceInstall: 7.1,
    before: {
      expPerSecond: 148_244,
      level: 2924,
      exp: 99_268_741,
      hacking: 7.5143,
      hackingExp: 11.4086,
      hackingSpeed: 4.8027,
    },
    old: 33.5,
    modelB: 31.6,
    modelBFromStart: 28.8,
    window: 30.6,
  },
  {
    node: "BN4.1",
    exp: 6_408_712.5,
    level: 2633,
    mults: { hacking: 8.732724, hackingExp: 12.877294, hackingSpeed: 3.25003, factionRep: 2.912916 },
    gain: 0.75,
    share: 1.62469,
    windowRate: 2841.54,
    reputation: 27.05,
    actual: 98.52,
    endLevel: 4774,
    sinceInstall: 23.1,
    before: {
      expPerSecond: 448_681,
      level: 1906,
      exp: 566_631_640,
      hacking: 4.2855,
      hackingExp: 8.2809,
      hackingSpeed: 2.5398,
    },
    old: 160.8,
    modelB: 93.2,
    modelBFromStart: 95.5,
    window: 144.9,
  },
] as const;

/**
 * The holds' ETAs against the actual (#401's bar: within about 25%), each row shown:
 * - **model B,** as c2–c8 above: the level's path from the install, κ the cycle before's last measured rate over its
 *   level + 50 × the install's `hacking_exp` × `hacking_speed`, m × its `hacking` (`laterCycleRise`); the work from the
 *   hold's start, that long after the install, after the dead time (#405's review): the cycle before's ramp isn't in
 *   the extraction (its own rates over time, and the κ carried into it), so the brain's fallback, 10 minutes, labelled:
 *   0.95–1.05 (0.91–1.01 without the dead time);
 * - **model B from the hold's start,** as the brain takes it (the carried κ, `augmentations.levelRise`): the same κ, from
 *   the experience and the level at the hold's start, after what's left of the dead time (BN1.4's 2.9 min; the others'
 *   holds start past it): 0.95–1.05;
 * - **the old ETA** (#351: the level now, the hold's mean share): 1.11–1.63;
 * - **for the record only,** κ from the window at the hold's start: the hack loop's ramp after the install, 15 to 800
 *   times under the hold's own rate, so its level at the hold's end is 1,300–1,800 short: 1.02–1.47, between the actual
 *   and the old.
 */
describe("the four Red Pill holds (#401): the ETA under model B, the level now and the window's rise, against the actual", () => {
  test.each(RED_PILL_HOLDS)(
    "$node: model B $modelB ($modelBFromStart from the hold's start), old $old, window $window, actual $actual min",
    (hold) => {
      const rateAt = (level: number) =>
        factionReputationPerSecond(
          {
            skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
            mults: { faction_rep: hold.mults.factionRep },
          },
          "hacking",
          {
            favor: 0,
            sourceFile15Level: 0,
            focused: true,
            implant: false,
            factionWorkRepGain: hold.gain,
            shareBonus: hold.share,
          },
        );
      const needed = 462_491 - hold.reputation;
      // Model B: the cycle before's rate at its install, the path after it, the work from the hold's start.
      const { before } = hold;
      const after = laterCycleRise(
        levelRiseOf({
          exp: before.exp,
          level: before.level,
          levelMult: before.hacking,
          expPerSecond: before.expPerSecond,
        }),
        {
          hacking: hold.mults.hacking / before.hacking,
          hackingExp: hold.mults.hackingExp / before.hackingExp,
          hackingSpeed: hold.mults.hackingSpeed / before.hackingSpeed,
        },
        RAMP_FALLBACK_MINUTES * MINUTE,
      );
      const startSeconds = hold.sinceInstall * MINUTE;
      const modelB = (workSecondsAlong(after, rateAt, needed, startSeconds) - startSeconds) / MINUTE;
      const flat = levelRiseOf({ exp: hold.exp, level: hold.level, levelMult: hold.mults.hacking, expPerSecond: null });
      const left = Math.max(0, RAMP_FALLBACK_MINUTES * MINUTE - startSeconds);
      const fromStart = workSecondsAlong({ ...flat, kappa: after.kappa, delaySeconds: left }, rateAt, needed) / MINUTE;
      const window = levelRiseOf({ ...flat, expPerSecond: hold.windowRate });
      const old = workSecondsAlong(flat, rateAt, needed) / MINUTE;
      const along = workSecondsAlong(window, rateAt, needed) / MINUTE;
      expect(modelB).toBeCloseTo(hold.modelB, 1);
      expect(fromStart).toBeCloseTo(hold.modelBFromStart, 1);
      expect(old).toBeCloseTo(hold.old, 1);
      expect(along).toBeCloseTo(hold.window, 1);
      // Model B within 25% both ways; the old and the window's ETAs cautious, the window's the nearer.
      for (const eta of [modelB, fromStart]) {
        expect(eta / hold.actual).toBeGreaterThan(0.75);
        expect(eta / hold.actual).toBeLessThan(1.25);
      }
      expect(along).toBeLessThan(old);
      expect(along).toBeGreaterThan(hold.actual);
      expect(levelAlong(window, hold.actual * MINUTE)).toBeLessThan(hold.endLevel);
    },
  );
});
