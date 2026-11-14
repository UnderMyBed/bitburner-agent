// BN4.2's and BN4.3's cycles after Daedalus's count (#413): the level every 5 min, the multipliers and the installs
// (`m4/bn43/postcount.txt`, from the read-only store copy of 2026-11-14), and BN4.3's faction work, favour and "held back
// by" (`m4/bn43/report-BN4.3.txt`, cycles 12-14), with the helpers the hindcast reads.
import { hackingExpOfLevel } from "../src/batcher.ts";
import { LEVEL_RISE_TERM, type LevelRise, levelRiseOf } from "../src/level-rise.ts";
import { BN4_2 } from "./bn4-2-fixture.ts";

/** A sample: minutes since the cycle's install, the hacking level, the hacking experience. */
export type Sample = [minutes: number, level: number, exp: number];

/** A post-count cycle (or the one before the count, its last sample alone), as `postcount.txt` gives it. */
export interface PostCountCycle {
  name: string;
  /** The level multiplier (`mults.hacking`, BN4's `HackingLevelMultiplier` 1), and the experience's and speed's. */
  m: number;
  mExp: number;
  mSpeed: number;
  samples: Sample[];
}

export const NEUROFLUX = "NeuroFlux Governor";
const neuroFlux = (levels: number) => Array.from({ length: levels }, () => NEUROFLUX);

/** The first post-count install's set, BN4.2's c10 and BN4.3's c12 alike (`augmentationInstallChosen`), 7 levels. */
export const FIRST_SET = [
  "Neuralstimulator",
  "Enhanced Myelin Sheathing",
  "Cranial Signal Processors - Gen IV",
  "The Black Hand",
  "DataJack",
];
/** The second's, BitRunners' (`augmentationInstallChosen` at 17:01 and 18:27): 13 levels in BN4.2, 7 in BN4.3. */
export const SECOND_SET = [
  "Artificial Bio-neural Network Implant",
  "Embedded Netburner Module Core Implant",
  "Cranial Signal Processors - Gen V",
  "Neural Accelerator",
];
export const FIRST_INSTALL = [...FIRST_SET, ...neuroFlux(7)];
export const SECOND_INSTALL_BN4_2 = [...SECOND_SET, ...neuroFlux(13)];
export const SECOND_INSTALL_BN4_3 = [...SECOND_SET, ...neuroFlux(7)];

/** BN4.3's installs before the count, c1-c11 (the run report's "bought"), NeuroFlux Governor once: Daedalus's 30. */
export const BN4_3_INSTALLED_AT_COUNT = [
  "Speech Processor Implant",
  "Social Negotiation Assistant (S.N.A)",
  "Nuoptimal Nootropic Injector Implant",
  "ADR-V1 Pheromone Gene",
  "Speech Enhancement",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Wired Reflexes",
  NEUROFLUX,
  "INFRARET Enhancement",
  "Combat Rib I",
  "Augmented Targeting I",
  "Artificial Synaptic Potentiation",
  "Cranial Signal Processors - Gen I",
  "Neurotrainer II",
  "Neural Wit Amplifier",
  "NutriGen Implant",
  "Neural-Retention Enhancement",
  "Embedded Netburner Module",
  "Cranial Signal Processors - Gen II",
  "Magnetism Amplifier",
  "Cranial Signal Processors - Gen III",
  "CRTX42-AA Gene Modification",
  "CashRoot Starter Kit",
  "Augmented Targeting II",
  "Combat Rib II",
  "DermaForce Particle Barrier",
  "Nanofiber Weave",
  "Neuregen Gene Modification",
];

/** BN4.2's installs before the count, c1-c9 (#401's fixture, and c9's Neuregen Gene Modification), NeuroFlux once. */
export const BN4_2_INSTALLED_AT_COUNT = [
  ...new Set([...BN4_2.flatMap((cycle) => cycle.bought), "Neuregen Gene Modification", NEUROFLUX]),
];

/** The cycle before the count: its last sample alone (`postcount.txt`'s first line of each BitNode). */
export const BN4_2_C9: PostCountCycle = {
  name: "BN4.2 c9",
  m: 2.747,
  mExp: 3.497,
  mSpeed: 2.022,
  samples: [[48.65, 1280, 1.102e9]],
};
export const BN4_3_C11: PostCountCycle = {
  name: "BN4.3 c11",
  m: 2.747,
  mExp: 3.497,
  mSpeed: 2.022,
  samples: [[50.67, 1300, 1.376e9]],
};

export const BN4_2_C10: PostCountCycle = {
  name: "BN4.2 c10",
  m: 2.747,
  mExp: 4.896,
  mSpeed: 2.022,
  samples: [
    [0, 2, 0],
    [5, 1135, 2.099e8],
    [10, 1178, 3.426e8],
    [15, 1204, 4.621e8],
    [20, 1215, 5.22e8],
    [25, 1234, 6.545e8],
    [30, 1263, 9.04e8],
    [35, 1292, 1.262e9],
    [40, 1299, 1.362e9],
    [45, 1321, 1.749e9],
    [50, 1340, 2.183e9],
    [55, 1362, 2.79e9],
    [60, 1380, 3.439e9],
    [65, 1396, 4.092e9],
    [70, 1409, 4.742e9],
    [75, 1420, 5.392e9],
    [80, 1430, 6.039e9],
    [85, 1439, 6.687e9],
    [90, 1447, 7.332e9],
  ],
};
/** BN4.2's c11, its first 90 min (then the game was closed: +545 min, 1,874). */
export const BN4_2_C11: PostCountCycle = {
  name: "BN4.2 c11",
  m: 3.499,
  mExp: 6.467,
  mSpeed: 2.37,
  samples: [
    [0, 3, 0],
    [5, 1498, 3.356e8],
    [10, 1575, 6.666e8],
    [15, 1605, 8.78e8],
    [20, 1648, 1.281e9],
    [25, 1665, 1.5e9],
    [30, 1697, 1.994e9],
    [35, 1728, 2.617e9],
    [40, 1752, 3.243e9],
    [45, 1771, 3.866e9],
    [50, 1788, 4.486e9],
    [55, 1802, 5.104e9],
    [60, 1815, 5.719e9],
    [65, 1827, 6.332e9],
    [70, 1837, 6.943e9],
    [75, 1846, 7.553e9],
    [80, 1855, 8.162e9],
    [85, 1863, 8.771e9],
    [90, 1871, 9.378e9],
  ],
};
export const BN4_2_C12: PostCountCycle = {
  name: "BN4.2 c12",
  m: 6.824,
  mExp: 9.057,
  mSpeed: 2.861,
  samples: [
    [0, 6, 0],
    [5, 2703, 1.232e8],
  ],
};
export const BN4_3_C12: PostCountCycle = {
  name: "BN4.3 c12",
  m: 2.747,
  mExp: 4.896,
  mSpeed: 2.022,
  samples: [
    [0, 2, 0],
    [5, 975, 3.406e7],
    [10, 1053, 8.293e7],
    [15, 1077, 1.096e8],
    [20, 1109, 1.576e8],
    [25, 1169, 3.115e8],
    [30, 1224, 5.793e8],
    [35, 1266, 9.347e8],
    [40, 1297, 1.333e9],
    [45, 1314, 1.62e9],
    [50, 1327, 1.867e9],
    [55, 1349, 2.409e9],
    [60, 1368, 3.006e9],
    [65, 1385, 3.633e9],
    [70, 1399, 4.258e9],
    [75, 1411, 4.882e9],
    [80, 1422, 5.506e9],
    [85, 1431, 6.13e9],
    [90, 1440, 6.751e9],
    [95, 1447, 7.372e9],
  ],
};
export const BN4_3_C13: PostCountCycle = {
  name: "BN4.3 c13",
  m: 3.499,
  mExp: 6.467,
  mSpeed: 2.37,
  samples: [
    [0, 3, 0],
    [5, 1498, 3.354e8],
    [10, 1572, 6.528e8],
    [15, 1607, 8.915e8],
    [20, 1633, 1.128e9],
    [25, 1647, 1.267e9],
    [30, 1672, 1.586e9],
    [35, 1700, 2.045e9],
    [40, 1722, 2.497e9],
    [45, 1738, 2.875e9],
    [50, 1752, 3.243e9],
    [55, 1784, 4.326e9],
    [60, 1809, 5.401e9],
    [65, 1829, 6.477e9],
    [70, 1846, 7.548e9],
    [75, 1861, 8.619e9],
    [80, 1874, 9.688e9],
    [85, 1886, 1.075e10],
    [90, 1896, 1.181e10],
    [95, 1906, 1.287e10],
    [100, 1915, 1.392e10],
    [105, 1923, 1.497e10],
    [111, 1931, 1.602e10],
    [116, 1938, 1.707e10],
    [121, 1944, 1.812e10],
    [126, 1951, 1.916e10],
    [131, 1957, 2.02e10],
    [136, 1962, 2.124e10],
    [141, 1968, 2.229e10],
    [146, 1973, 2.332e10],
    [151, 1977, 2.436e10],
    [156, 1982, 2.539e10],
    [161, 1987, 2.643e10],
  ],
};
export const BN4_3_C14: PostCountCycle = {
  name: "BN4.3 c14",
  m: 6.429,
  mExp: 8.532,
  mSpeed: 2.695,
  samples: [
    [0, 6, 0],
    [5, 2608, 1.665e8],
  ],
};

/** The experience at `minutes` into a cycle as measured: linear between its samples (its last past them). */
export function expAt(cycle: PostCountCycle, minutes: number): number {
  const samples = cycle.samples;
  const at = samples.findIndex(([each]) => each >= minutes);
  if (at === -1) return (samples.at(-1) as Sample)[2];
  if (at === 0) return (samples[0] as Sample)[2];
  const [t0, , e0] = samples[at - 1] as Sample;
  const [t1, , e1] = samples[at] as Sample;
  return e0 + ((e1 - e0) * (minutes - t0)) / (t1 - t0);
}

/** The level at `minutes` as measured: the samples' own where there's one, else the formula on `expAt`, unfloored. */
export function levelAt(cycle: PostCountCycle, minutes: number): number {
  const sample = cycle.samples.find(([each]) => each === minutes);
  if (sample !== undefined) return sample[1];
  return cycle.m * (32 * Math.log(expAt(cycle, minutes) + 534.6) - 200);
}

/**
 * The cycle's rise at `minutes` (its end, absent), as the brain's `HackingExpRate` measures it: the experience a second
 * over the last 10 minutes (the samples' resolution: 5), at the level then. A cycle of one sample (the cycle before
 * the count): its mean over the cycle, the evidence's only rate (labelled: an end rate above its mean, cautious).
 */
export function riseAt(cycle: PostCountCycle, minutes?: number): LevelRise {
  const samples = cycle.samples;
  const last = samples.at(-1) as Sample;
  const to = minutes ?? last[0];
  if (samples.length === 1) {
    return levelRiseOf({ exp: last[2], level: last[1], levelMult: cycle.m, expPerSecond: last[2] / (last[0] * 60) });
  }
  const from = Math.max(0, to - 10);
  return levelRiseOf({
    exp: expAt(cycle, to),
    level: Math.floor(levelAt(cycle, to)),
    levelMult: cycle.m,
    expPerSecond: (expAt(cycle, to) - expAt(cycle, from)) / ((to - from) * 60),
  });
}

/** The install's gains from one cycle to the next, as the multipliers read (`levellingInstallMultipliers`' three). */
export const gainBetween = (before: PostCountCycle, after: PostCountCycle) => ({
  hacking: after.m / before.m,
  hackingExp: after.mExp / before.mExp,
  hackingSpeed: after.mSpeed / before.mSpeed,
});

/**
 * The cycle's ramp (#405, as the brain's `#levelRise` measures it): the first minute (a quarter at a time) its rate,
 * over up to the last 10 minutes from its first, reaches per level + 50 the κ `carried` into it; null where it never
 * does.
 */
export function rampOf(cycle: PostCountCycle, carried: number): number | null {
  const end = (cycle.samples.at(-1) as Sample)[0];
  for (let minutes = 0.25; minutes <= end; minutes += 0.25) {
    const span = Math.min(minutes, 10);
    const perSecond = (expAt(cycle, minutes) - expAt(cycle, minutes - span)) / (span * 60);
    const level = cycle.m * (32 * Math.log(expAt(cycle, minutes) + 534.6) - 200);
    if (perSecond / (level + LEVEL_RISE_TERM) >= carried) return minutes;
  }
  return null;
}

/** The experience the level needs at `m` (`calculateExp`'s inverse of `calculateSkill`, core's `hackingExpOfLevel`). */
export const expForLevel = (level: number, m: number) => hackingExpOfLevel(level, m);
