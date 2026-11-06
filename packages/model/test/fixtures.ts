// The validation's figures (#260), synthetic: each as an issue or the review states it, never read from a store.

/**
 * Run #3's BN1.2 (E0, main 7c741cc, 2026-11-05) per cycle: #262's review, the coordinator's table from a read-only
 * report over the store (#244's section 2b). By cycle: its length, Daedalus's count after its install, the faction
 * worked most with the reputation earned there and its average rate a second, that faction's favour after the install,
 * and the cycle's most hacking. Its own hacking and income curves are the model's input (`RUN_3_CYCLES`); these are
 * what the rules make of them.
 */
export const RUN_3_PER_CYCLE = [
  { lengthMin: 39.5, count: 3, faction: "CyberSec", reputation: 2576, rate: 1.59, favorAfter: 5.04, hacking: 358 },
  { lengthMin: 56.6, count: 5, faction: "CyberSec", reputation: 11_344, rate: 4.1, favorAfter: 22.54, hacking: 593 },
  { lengthMin: 75.6, count: 10, faction: "NiteSec", reputation: 27_335, rate: 7.33, favorAfter: 37.65, hacking: 798 },
  { lengthMin: 95.7, count: 17, faction: "NiteSec", reputation: 49_611, rate: 11.95, favorAfter: 71.88, hacking: 1061 },
  {
    lengthMin: 123.8,
    count: 21,
    faction: "BitRunners",
    reputation: 139_364,
    rate: 20.87,
    favorAfter: 96.01,
    hacking: 1357,
  },
  {
    lengthMin: 124.1,
    count: 25,
    faction: "BitRunners",
    reputation: 318_895,
    rate: 48.48,
    favorAfter: 150.38,
    hacking: 1526,
  },
  {
    lengthMin: 31.6,
    count: 29,
    faction: "The Black Hand",
    reputation: 57_191,
    rate: 37.9,
    favorAfter: 94.16,
    hacking: 2128,
  },
  {
    lengthMin: 27.5,
    count: 31,
    faction: "The Black Hand",
    reputation: 94_108,
    rate: 82.38,
    favorAfter: 105.53,
    hacking: 3310,
  },
  {
    lengthMin: 81.7,
    count: 32,
    faction: "Daedalus",
    reputation: 460_688,
    rate: 127.41,
    favorAfter: 152.95,
    hacking: 5204,
  },
  { lengthMin: 18.5, count: 36, faction: "Aevum", reputation: 96_187, rate: 106.28, favorAfter: null, hacking: 4690 },
] as const;

/**
 * Run #3's cash in hand (the medium snapshots' `player.money`) a cycle, cycles 1 to 6, [minutes after the install,
 * money], at the readings the cycle lasted to (its end left out: that's after the commit's purchases). The
 * coordinator's read-only extract on #263: https://github.com/UnderMyBed/bitburner-agent/issues/263 (its first comment). The slow
 * snapshots' sources lag the medium's by up to a few minutes, so in a cycle's steep minutes the two don't compare.
 */
export const RUN_3_CASH: readonly (readonly (readonly [number, number])[])[] = [
  [5, 10, 15, 20, 30].map((minutes, index) => [minutes, [1262, 1.43e6, 2.64e6, 16.55e6, 195.61e6][index] as number]),
  [5, 10, 15, 20, 30, 45].map((minutes, index) => [
    minutes,
    [78_905, 4.74e6, 7.68e6, 58.56e6, 45.72e9, 4.33e12][index] as number,
  ]),
  [5, 10, 15, 20, 30, 45, 60, 75].map((minutes, index) => [
    minutes,
    [416_351, 8.47e6, 74.79e6, 198.21e6, 887.82e9, 17.68e12, 35.43e12, 85.59e12][index] as number,
  ]),
  [5, 10, 15, 20, 30, 45, 60, 75, 90].map((minutes, index) => [
    minutes,
    [613_611, 63.94e6, 220.54e6, 131.5e9, 5.53e12, 28.3e12, 50.21e12, 176.88e12, 303.64e12][index] as number,
  ]),
  [5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120].map((minutes, index) => [
    minutes,
    [1.46e6, 216.33e6, 290.74e6, 537.14e9, 10.88e12, 83.52e12, 213.71e12, 345.27e12, 476.88e12, 608.38e12, 738.34e12][
      index
    ] as number,
  ]),
  [5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120].map((minutes, index) => [
    minutes,
    [4.75e6, 597.46e6, 263.97e6, 131.13e9, 24.61e12, 71.26e12, 117.46e12, 164.27e12, 210.95e12, 257.3e12, 294.97e12][
      index
    ] as number,
  ]),
];

/** BitRunners' favour after the 4th install in run #3 (#247: "favour 4.8" at 13:13; the table's 4.76). */
export const RUN_3_BITRUNNERS_FAVOR_AFTER_4 = 4.76;

/**
 * Run #3's BN1.2 phases (#244's table), each ending at an install: 11 h 17 min from 08:46 to the destroy at 20:03.
 * Only the first two are in the model's reach (cycles 1 to 6, `RUN_3_PER_CYCLE`); the rest are reported, not tested.
 */
export const RUN_3_BN1_2 = {
  start: { currentNode: 1, ownedSF: { "1": 1 } },
  totalMinutes: 11 * 60 + 17,
  phases: [
    { name: "count 0 → 17 (CyberSec, Tian Di Hui, NiteSec)", endsAtInstall: 4, minutes: 4 * 60 + 27 },
    { name: "BitRunners favour 5 → 96 → 150", endsAtInstall: 6, minutes: 4 * 60 + 8 },
  ],
};

/**
 * The simulator's first three cycles (#247's feasibility comment: seed 1, main 412d97b, a fresh BN1.1 start): installs
 * at about 57 min (3 installed) and about 122 min (4), none by 200 min; hacking 0 → 290 in 55 min in cycle 1, 0 → 497 in
 * 62 min in cycle 2. Independent of the calibration, which is run #3's. "Installed" is `ownedAugs`' names, as the
 * probe counted them (NeuroFlux Governor once).
 */
export const SIMULATOR_SEED_1 = {
  start: { currentNode: 1, ownedSF: {} },
  horizonMinutes: 200,
  installs: [
    { atMinutes: 57, installed: 3 },
    { atMinutes: 122, installed: 4 },
  ],
  hackingAtCycleEnd: [290, 497],
};
