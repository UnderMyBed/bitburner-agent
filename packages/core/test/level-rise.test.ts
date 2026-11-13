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
});

/**
 * BN4.2, 2026-11-12, cycles 1–8 (`m4/predaedalus/cycles2-BN4.2.txt` and `rebuild.txt`, from a read-only copy of the
 * store): each cycle's minutes online T, its first faction work, its mean work rate (the work's reputation over T,
 * rep/s), its peak hacking level (at T), the minutes to each hacking level reached (`ms`), the multipliers the report
 * read (`hacking`, `hacking_exp`), what its install bought (and NeuroFlux Governor's levels), the reputation needed at
 * each faction worked, and the reputation earned at every joined faction (for the favour after each install).
 */
const C1_BOUGHT = [
  "Artificial Synaptic Potentiation",
  "Cranial Signal Processors - Gen I",
  "Speech Processor Implant",
  "Neurotrainer II",
  "INFRARET Enhancement",
  "Social Negotiation Assistant (S.N.A)",
  "Combat Rib I",
  "Nuoptimal Nootropic Injector Implant",
  "ADR-V1 Pheromone Gene",
  "Augmented Targeting I",
  "Speech Enhancement",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Wired Reflexes",
];
interface Cycle {
  T: number;
  firstWork: number;
  mean: number;
  peak: number;
  ms: [level: number, minutes: number][];
  hacking: number;
  hackingExp: number;
  bought: string[];
  neuroFlux: number;
  worked: Record<string, number>;
  earned: Record<string, number>;
}
const BN4_2: Cycle[] = [
  {
    T: 242,
    firstWork: 20,
    mean: 2.2,
    peak: 535,
    ms: [
      [100, 23],
      [300, 111],
      [500, 199],
    ],
    hacking: 1.28,
    hackingExp: 1.28,
    bought: C1_BOUGHT,
    neuroFlux: 5,
    worked: { NiteSec: 10_000, Ishima: 7500, "Tian Di Hui": 7500, CyberSec: 2000 },
    earned: {
      BitRunners: 88,
      "The Black Hand": 287,
      NiteSec: 10_000,
      Chongqing: 410,
      Ishima: 7744,
      "New Tokyo": 407,
      "Tian Di Hui": 7816,
      CyberSec: 4068,
    },
  },
  {
    T: 38,
    firstWork: 5,
    mean: 3.6,
    peak: 526,
    ms: [
      [100, 2],
      [300, 4],
      [500, 31],
    ],
    hacking: 1.48,
    hackingExp: 1.79,
    bought: ["NutriGen Implant"],
    neuroFlux: 13,
    worked: { "New Tokyo": 6250 },
    earned: {
      "The Black Hand": 78,
      NiteSec: 860,
      Chongqing: 84,
      Ishima: 189,
      "New Tokyo": 6533,
      "Tian Di Hui": 193,
      CyberSec: 271,
    },
  },
  {
    T: 67,
    firstWork: 4,
    mean: 7.1,
    peak: 724,
    ms: [
      [100, 2],
      [300, 3],
      [500, 15],
    ],
    hacking: 1.69,
    hackingExp: 2.03,
    bought: [
      "Neural-Retention Enhancement",
      "Embedded Netburner Module",
      "Cranial Signal Processors - Gen II",
      "Neural Wit Amplifier",
    ],
    neuroFlux: 11,
    worked: { BitRunners: 5000, NiteSec: 20_000 },
    earned: {
      BitRunners: 5175,
      "The Black Hand": 242,
      NiteSec: 21_000,
      Chongqing: 248,
      Ishima: 607,
      "New Tokyo": 551,
      "Tian Di Hui": 802,
      CyberSec: 435,
    },
  },
  {
    T: 37,
    firstWork: 4,
    mean: 8.7,
    peak: 905,
    ms: [
      [100, 2],
      [300, 2],
      [500, 3],
    ],
    hacking: 2.18,
    hackingExp: 2.84,
    bought: ["Magnetism Amplifier"],
    neuroFlux: 0,
    worked: { "The Black Hand": 15_000 },
    earned: {
      BitRunners: 337,
      "The Black Hand": 16_000,
      NiteSec: 1156,
      Chongqing: 182,
      Ishima: 455,
      "New Tokyo": 404,
      "Tian Di Hui": 800,
      CyberSec: 327,
    },
  },
  {
    T: 66,
    firstWork: 4,
    mean: 14.8,
    peak: 1030,
    ms: [
      [100, 2],
      [300, 2],
      [500, 3],
      [1000, 56],
    ],
    hacking: 2.18,
    hackingExp: 2.84,
    bought: ["Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification"],
    neuroFlux: 7,
    worked: { NiteSec: 50_000 },
    earned: {
      BitRunners: 811,
      "The Black Hand": 2509,
      NiteSec: 51_000,
      Chongqing: 439,
      Ishima: 1083,
      "New Tokyo": 981,
      "Tian Di Hui": 1469,
      CyberSec: 779,
    },
  },
  {
    T: 24,
    firstWork: 4,
    mean: 12.3,
    peak: 1083,
    ms: [
      [100, 1],
      [300, 1],
      [500, 2],
      [1000, 7],
    ],
    hacking: 2.75,
    hackingExp: 3.5,
    bought: ["CashRoot Starter Kit", "Augmented Targeting II"],
    neuroFlux: 0,
    worked: { "Sector-12": 13_000 },
    earned: {
      BitRunners: 320,
      "The Black Hand": 1679,
      NiteSec: 1967,
      Aevum: 133,
      "Sector-12": 13_000,
      "Tian Di Hui": 468,
      CyberSec: 316,
    },
  },
  {
    T: 32,
    firstWork: 4,
    mean: 13.8,
    peak: 1162,
    ms: [
      [100, 1],
      [300, 1],
      [500, 2],
      [1000, 8],
    ],
    hacking: 2.75,
    hackingExp: 3.5,
    bought: ["Combat Rib II", "DermaForce Particle Barrier"],
    neuroFlux: 0,
    worked: { Volhaven: 19_000 },
    earned: {
      BitRunners: 496,
      "The Black Hand": 2184,
      NiteSec: 3087,
      Volhaven: 19_000,
      "Tian Di Hui": 1296,
      CyberSec: 485,
    },
  },
  {
    T: 45,
    firstWork: 4,
    mean: 18.6,
    peak: 1238,
    ms: [
      [100, 1],
      [300, 1],
      [500, 2],
      [1000, 8],
    ],
    hacking: 2.75,
    hackingExp: 3.5,
    bought: ["Nanofiber Weave"],
    neuroFlux: 0,
    worked: { "Tian Di Hui": 38_000 },
    earned: {
      BitRunners: 832,
      "The Black Hand": 3124,
      NiteSec: 5033,
      Chongqing: 420,
      Ishima: 1039,
      "New Tokyo": 927,
      "Tian Di Hui": 38_000,
      CyberSec: 807,
    },
  },
];

/** SF1.3's multiplier on every one of these (`SourceFile/applySourceFile.ts:14-49`: 1 + (16 + 8 + 4)/100). */
const SOURCE_FILE_1_3 = 1.28;
/** BN4's FactionWorkRepGain (`BitNode/BitNode.tsx:651`); its HackingLevelMultiplier is 1. */
const BN4_FACTION_WORK_REP_GAIN = 0.75;
const MINUTE = 60;

/** Each cycle's multipliers: SF1.3's times every install before it (`levellingInstallMultipliers`, faction_rep too). */
const multipliers = (() => {
  const each: { hacking: number; hackingExp: number; hackingSpeed: number; factionRep: number }[] = [];
  let at = {
    hacking: SOURCE_FILE_1_3,
    hackingExp: SOURCE_FILE_1_3,
    hackingSpeed: SOURCE_FILE_1_3,
    factionRep: SOURCE_FILE_1_3,
  };
  for (const cycle of BN4_2) {
    each.push(at);
    const gain = levellingInstallMultipliers(cycle.neuroFlux, cycle.bought);
    const factionRep = cycle.bought.reduce(
      (product, name) => product * (AUGMENTATIONS[name]?.multipliers.faction_rep ?? 1),
      1.01 ** cycle.neuroFlux,
    );
    at = {
      hacking: at.hacking * gain.hacking,
      hackingExp: at.hackingExp * gain.hackingExp,
      hackingSpeed: at.hackingSpeed * gain.hackingSpeed,
      factionRep: at.factionRep * factionRep,
    };
  }
  return each;
})();

/**
 * The favour multiplier of the work in cycle `index` (`reputation.ts:8-14`: 1 + favour/100): each worked faction's
 * favour from the reputation earned there before (`favor.ts:17-24`, `Faction.ts:78-79`; BN4.2 started every faction at
 * 0), the time at each its reputation over its rate, so their reputation's mean over the time.
 */
const favourMultiplier = (index: number) => {
  const worked = Object.entries(BN4_2[index]?.worked ?? {});
  const before = (faction: string) =>
    BN4_2.slice(0, index).reduce((sum, cycle) => sum + (cycle.earned[faction] ?? 0), 0);
  const reputation = worked.reduce((sum, [, each]) => sum + each, 0);
  const time = worked.reduce((sum, [faction, each]) => sum + each / (1 + repToFavor(before(faction)) / 100), 0);
  return reputation / time;
};

/** The game's hacking work rate at `level` in cycle `index`, focused, int 0, the share's place taken by `factor`. */
const rateIn = (index: number, factor: number) => (level: number) =>
  factionReputationPerSecond(
    {
      skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: multipliers[index]?.factionRep ?? 1 },
    },
    "hacking",
    {
      favor: 100 * (favourMultiplier(index) - 1),
      sourceFile15Level: 0,
      focused: true,
      implant: false,
      factionWorkRepGain: BN4_FACTION_WORK_REP_GAIN,
      shareBonus: factor,
    },
  );

/** The experience at each minute of a cycle as measured: (0, 0), each level reached, the peak at T; linear between. */
const measuredExp = (index: number) => {
  const cycle = BN4_2[index] as Cycle;
  const mult = multipliers[index]?.hacking ?? 1;
  const points: [number, number][] = [[0, 0]];
  for (const [level, minutes] of [...cycle.ms, [cycle.peak, cycle.T] as [number, number]]) {
    const exp = hackingExpOfLevel(level, mult);
    if (points.at(-1)?.[0] === minutes) points[points.length - 1] = [minutes, exp];
    else points.push([minutes, exp]);
  }
  return points;
};

/** The cycle's measured rate over the formula's along its measured level (no share): the share's place, measured. */
const measuredFactor = (index: number) => {
  const cycle = BN4_2[index] as Cycle;
  const points = measuredExp(index);
  const mult = multipliers[index]?.hacking ?? 1;
  const levelAt = (minutes: number) => {
    const at = points.findIndex(([each]) => each >= minutes);
    const [t0, e0] = points[Math.max(0, at - 1)] as [number, number];
    const [t1, e1] = points[at] as [number, number];
    const exp = t1 === t0 ? e1 : e0 + ((e1 - e0) * (minutes - t0)) / (t1 - t0);
    return mult * (32 * Math.log(exp + 534.6) - 200);
  };
  const rate = rateIn(index, 1);
  const n = 2000;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rate(levelAt(cycle.firstWork + ((i + 0.5) * (cycle.T - cycle.firstWork)) / n));
  const formulaMean = ((sum / n) * (cycle.T - cycle.firstWork)) / cycle.T;
  return cycle.mean / formulaMean;
};

/**
 * Cycle `index`'s mean work rate, predicted from the cycle before's measures alone: its last measured experience rate
 * (the last stretch between the levels the report gives, to its peak at T: the evidence's resolution, where the brain's
 * `HackingExpRate` has a 10-minute window) at its peak, the path after the install (`laterCycleRise`) at its install's
 * multipliers, the work from this cycle's first faction work to T at the game's rate along it, with this cycle's
 * `faction_rep` and favour, and the cycle before's measured factor in the share's place.
 */
const predictedMean = (index: number) => {
  const before = BN4_2[index - 1] as Cycle;
  const cycle = BN4_2[index] as Cycle;
  const points = measuredExp(index - 1);
  const [t0, e0] = points.at(-2) as [number, number];
  const [t1, e1] = points.at(-1) as [number, number];
  const rise = levelRiseOf({
    exp: e1,
    level: before.peak,
    levelMult: multipliers[index - 1]?.hacking ?? 1,
    expPerSecond: (e1 - e0) / ((t1 - t0) * MINUTE),
  });
  const after = laterCycleRise(rise, levellingInstallMultipliers(before.neuroFlux, before.bought));
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
   */
  test.each([
    { cycle: 2, ratio: 1.15 },
    { cycle: 3, ratio: 0.97 },
    { cycle: 4, ratio: 1.08 },
    { cycle: 5, ratio: 0.92 },
    { cycle: 6, ratio: 1.07 },
    { cycle: 7, ratio: 0.92 },
    { cycle: 8, ratio: 0.97 },
  ])("c$cycle: predicted over measured $ratio, within ×2", ({ cycle, ratio }) => {
    const index = cycle - 1;
    const predicted = predictedMean(index);
    const measured = (BN4_2[index] as Cycle).mean;
    expect(predicted / measured).toBeGreaterThan(0.5);
    expect(predicted / measured).toBeLessThan(2);
    expect(predicted / measured).toBeCloseTo(ratio, 1);
  });

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
    old: 98.0,
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
    old: 113.5,
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
    old: 33.5,
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
    old: 160.8,
    window: 144.9,
  },
] as const;

/**
 * The holds' ETAs (#401's bar: within about 25%). Model B proper (κ from the cycle before's measured rate × its
 * install's gains, as c2–c8 above) needs the cycle before each hold, which the extraction doesn't hold: not computed.
 * What is, each against the actual: the old ETA (#351: the level now, the hold's mean share), and, for the record only,
 * κ from the window at the start. That window is the hack loop's ramp after the install 7–23 min before (15 to 800
 * times under the hold's own rate), so its level at the hold's end is 1,300–1,800 short: 1.38–1.47× at three holds,
 * outside 25%, though always between the actual and the old.
 */
describe("the four Red Pill holds (#401): the ETA at the level now and along the window's rise, against the actual", () => {
  test.each(RED_PILL_HOLDS)("$node: old $old, window $window, actual $actual min", (hold) => {
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
    const flat = levelRiseOf({ exp: hold.exp, level: hold.level, levelMult: hold.mults.hacking, expPerSecond: null });
    const window = levelRiseOf({ ...flat, expPerSecond: hold.windowRate });
    const old = workSecondsAlong(flat, rateAt, needed) / MINUTE;
    const along = workSecondsAlong(window, rateAt, needed) / MINUTE;
    expect(old).toBeCloseTo(hold.old, 1);
    expect(along).toBeCloseTo(hold.window, 1);
    // Cautious both, the window's the nearer.
    expect(along).toBeLessThan(old);
    expect(along).toBeGreaterThan(hold.actual);
    // The window's level at the hold's end, short of the measured.
    expect(levelAlong(window, hold.actual * MINUTE)).toBeLessThan(hold.endLevel);
  });
});
