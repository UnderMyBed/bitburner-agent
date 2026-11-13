// BN4.2's cycles (2026-11-12), the fixture of #401's hindcast (level-rise.test.ts) and #389's (install-timing.test.ts),
// with the helpers that read it: the multipliers, favour, the work's rate, the measured experience and the ramps.
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { hackingExpOfLevel } from "../src/batcher.ts";
import { repToFavor } from "../src/donations.ts";
import { factionReputationPerSecond } from "../src/faction-work.ts";
import { LEVEL_RISE_TERM, levelRiseOf } from "../src/level-rise.ts";
import { levellingInstallMultipliers } from "../src/levelling.ts";

/**
 * BN4.2, 2026-11-12, cycles 1–8 (`m4/predaedalus/cycles2-BN4.2.txt` and `rebuild.txt`, from a read-only copy of the
 * store): each cycle's minutes online T, its first faction work, its mean work rate (the work's reputation over T,
 * rep/s), its peak hacking level (at T), the minutes to each hacking level reached (`ms`), the multipliers the report
 * read (`hacking`, `hacking_exp`), what its install bought (and NeuroFlux Governor's levels), the reputation needed at
 * each faction worked, and the reputation earned at every joined faction (for the favour after each install).
 */
export const C1_BOUGHT = [
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
export interface Cycle {
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
export const BN4_2: Cycle[] = [
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
export const SOURCE_FILE_1_3 = 1.28;
/** BN4's FactionWorkRepGain (`BitNode/BitNode.tsx:651`); its HackingLevelMultiplier is 1. */
export const BN4_FACTION_WORK_REP_GAIN = 0.75;
export const MINUTE = 60;

/** Each cycle's multipliers: SF1.3's times every install before it (`levellingInstallMultipliers`, faction_rep too). */
export const multipliers = (() => {
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
export const favourMultiplier = (index: number) => {
  const worked = Object.entries(BN4_2[index]?.worked ?? {});
  const before = (faction: string) =>
    BN4_2.slice(0, index).reduce((sum, cycle) => sum + (cycle.earned[faction] ?? 0), 0);
  const reputation = worked.reduce((sum, [, each]) => sum + each, 0);
  const time = worked.reduce((sum, [faction, each]) => sum + each / (1 + repToFavor(before(faction)) / 100), 0);
  return reputation / time;
};

/** The game's hacking work rate at `level` in cycle `index`, focused, int 0, the share's place taken by `factor`. */
export const rateIn = (index: number, factor: number) => (level: number) =>
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
export const measuredExp = (index: number) => {
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
export const measuredFactor = (index: number) => {
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
/** Cycle `index`'s rise at its end: its last measured stretch's experience rate, at its peak. */
export const endRise = (index: number) => {
  const points = measuredExp(index);
  const [t0, e0] = points.at(-2) as [number, number];
  const [t1, e1] = points.at(-1) as [number, number];
  return levelRiseOf({
    exp: e1,
    level: (BN4_2[index] as Cycle).peak,
    levelMult: multipliers[index]?.hacking ?? 1,
    expPerSecond: (e1 - e0) / ((t1 - t0) * MINUTE),
  });
};
export const gainOf = (index: number) =>
  levellingInstallMultipliers((BN4_2[index] as Cycle).neuroFlux, (BN4_2[index] as Cycle).bought);

/**
 * Cycle `index`'s ramp (#405's review), as the brain measures it: the first minute its experience rate (over up to
 * the last 10 minutes, as `HackingExpRate` from its first minute) reaches, per level + 50, the κ carried into it (the
 * cycle before's end × its install's gains); null where none was carried (the BitNode's first) or it never did.
 */
export const rampOf = (index: number): number | null => {
  if (index === 0) return null;
  const gain = gainOf(index - 1);
  const carried = endRise(index - 1).kappa * gain.hackingExp * gain.hackingSpeed;
  const points = measuredExp(index);
  const expAt = (minutes: number) => {
    const at = points.findIndex(([each]) => each >= minutes);
    const [t0, e0] = points[Math.max(0, at - 1)] as [number, number];
    const [t1, e1] = points[at] as [number, number];
    return t1 === t0 ? e1 : e0 + ((e1 - e0) * (minutes - t0)) / (t1 - t0);
  };
  const mult = multipliers[index]?.hacking ?? 1;
  const { T } = BN4_2[index] as Cycle;
  for (let minutes = 1; minutes <= T; minutes += 0.25) {
    const span = Math.min(minutes, 10);
    const perSecond = (expAt(minutes) - expAt(minutes - span)) / (span * MINUTE);
    const level = mult * (32 * Math.log(expAt(minutes) + 534.6) - 200);
    if (perSecond / (level + LEVEL_RISE_TERM) >= carried) return minutes;
  }
  return null;
};

/** The brain's fallback where no ramp is measured yet: the rate's window, 10 minutes (`LEVEL_RAMP_FALLBACK_MS`). */
export const RAMP_FALLBACK_MINUTES = 10;

/** The dead time for cycle `index`: the cycle before's ramp, else the last measured before it, else the fallback. */
export const deadFor = (index: number): { minutes: number; measured: boolean } => {
  for (let before = index - 1; before >= 0; before--) {
    const ramp = rampOf(before);
    if (ramp !== null) return { minutes: ramp, measured: true };
  }
  return { minutes: RAMP_FALLBACK_MINUTES, measured: false };
};

/** Cycle `index`'s experience at `minutes` as measured: linear between the levels the report gives. */
export const measuredExpAt = (index: number, minutes: number) => {
  const points = measuredExp(index);
  const at = points.findIndex(([each]) => each >= minutes);
  const [t0, e0] = points[Math.max(0, at - 1)] as [number, number];
  const [t1, e1] = points[at] as [number, number];
  return t1 === t0 ? e1 : e0 + ((e1 - e0) * (minutes - t0)) / (t1 - t0);
};
