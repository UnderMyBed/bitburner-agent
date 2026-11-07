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
 * coordinator's read-only extract on #263:
 * https://github.com/UnderMyBed/bitburner-agent/issues/263#issuecomment-6681259933.
 * The slow snapshots' sources lag the medium's by up to a few minutes, so in a cycle's steep minutes the two don't
 * compare.
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
  /** Main 412d97b's brain: #243's hold (44d1f29) in, #242's share (d4d5cf2) not yet. */
  policy: { name: "the simulator probe's brain (main 412d97b)", daedalusCountHold: true, homeShares: false },
  horizonMinutes: 200,
  installs: [
    { atMinutes: 57, installed: 3 },
    { atMinutes: 122, installed: 4 },
  ],
  hackingAtCycleEnd: [290, 497],
};

/**
 * BN1.3, the exit run (#276; v1.0.0's tested build, main 614978a, today's brain with #242's share and #243's hold),
 * held out of every fit (#263's decision): the coordinator's read-only extract on #263,
 * https://github.com/UnderMyBed/bitburner-agent/issues/263 ("BN1.3 per cycle: the held-out validation data").
 * Summarised here, never read from a store. SF1.2 owned, so home starts at 32 GB and the multipliers carry SF1's 24%.
 * In cycles 6 to 8 the batcher sat about 5 hours on poor targets (#274, fixed in #278): their hacking income, and the
 * level and the reputation that follow from it, are far under what a cycle at those multipliers makes. The downstream
 * run has them in its measured curves (`BN1_3_CYCLES`); the independent run's checks on them are confounded.
 */
export const BN1_3 = {
  start: { currentNode: 1, ownedSF: { "1": 2 } },
  /** Each install (and the destroy), minutes from the brain's start (15:26:39.732Z), from the extract's timestamps. */
  installsAtMinutes: [36.28, 86.95, 157.77, 298.97, 317.46, 411.33, 549.39, 635.2, 728.05, 750.56],
  destroyedAtMinutes: 755.11,
  /** The install after which each faction's donations unlocked (its favour after it ≥ 150), 1-based. */
  donationsUnlockedAtInstall: { BitRunners: 7, Daedalus: 9 },
};

/**
 * BN1.3 per cycle, as `RUN_3_PER_CYCLE`: Daedalus's count after the install (the kinds, NeuroFlux Governor once), the
 * faction worked the most minutes (from the work chosen) with its reputation at the cycle's end and its favour after
 * the install, the share bonus's mean over the fast snapshots, the hacking level at the end (the extract rounds 1000
 * and over to the hundred), and the install's reason.
 */
export const BN1_3_PER_CYCLE = [
  { count: 3, faction: "CyberSec", reputation: 2.6e3, favorAfter: 5.18, share: 1.118, hacking: 379, reason: "count" },
  { count: 5, faction: "CyberSec", reputation: 12.1e3, favorAfter: 23.62, share: 1.357, hacking: 637, reason: "count" },
  { count: 10, faction: "NiteSec", reputation: 30.9e3, favorAfter: 41.01, share: 1.459, hacking: 857, reason: "count" },
  {
    count: 14,
    faction: "BitRunners",
    reputation: 75.7e3,
    favorAfter: 70.71,
    share: 1.513,
    hacking: 1200,
    reason: "count",
  },
  {
    count: 18,
    faction: "Tian Di Hui",
    reputation: 6.8e3,
    favorAfter: 15.37,
    share: 1.527,
    hacking: 864,
    reason: "quick",
  },
  {
    count: 23,
    faction: "BitRunners",
    reputation: 211.9e3,
    favorAfter: 128.22,
    share: 1.61,
    hacking: 1400,
    reason: "count",
  },
  {
    count: 32,
    faction: "The Black Hand",
    reputation: 102.2e3,
    favorAfter: 84.11,
    share: 1.532,
    hacking: 1500,
    reason: "count",
  },
  { count: 37, faction: "Aevum", reputation: 128.1e3, favorAfter: null, share: 1.531, hacking: 1700, reason: "count" },
  {
    count: 37,
    faction: "Daedalus",
    reputation: 486.1e3,
    favorAfter: 152.55,
    share: 1.624,
    hacking: 4700,
    reason: "Daedalus donations",
  },
  { count: 41, faction: null, reputation: 0, favorAfter: null, share: null, hacking: 4200, reason: "The Red Pill" },
] as const;

/**
 * BN1.3's cycles in `RUN_3_CYCLES`' form, [minutes, hacking level, the game's hacking income since the install], at 5,
 * 10, 15, 20, 30, 45, 60, 75, 90, 105, 120 and 135 min while the cycle lasted, and at its end: for the downstream run
 * on BN1.3's own curves, stuck batcher and all.
 */
export const BN1_3_CYCLES: readonly { lengthMin: number; points: readonly (readonly [number, number, number])[] }[] = [
  {
    lengthMin: 36.3,
    points: [
      [5, 8, 0],
      [10, 58, 2.81e6],
      [15, 141, 27.36e6],
      [20, 209, 170.45e6],
      [30, 333, 4.34e9],
      [36.3, 379, 158.16e9],
    ],
  },
  {
    lengthMin: 50.7,
    points: [
      [5, 21, 0],
      [10, 128, 6.49e6],
      [15, 254, 157.02e6],
      [20, 363, 1.85e9],
      [30, 547, 1.5e12],
      [45, 615, 6.39e12],
      [50.7, 637, 24.01e12],
    ],
  },
  {
    lengthMin: 70.8,
    points: [
      [5, 50, 330.2e3],
      [10, 231, 21.65e6],
      [15, 429, 1.07e9],
      [20, 560, 134.94e9],
      [30, 740, 3.98e12],
      [45, 805, 35.27e12],
      [60, 835, 110.59e12],
      [70.8, 857, 207.64e12],
    ],
  },
  {
    lengthMin: 141.2,
    points: [
      [5, 106, 1.06e6],
      [10, 395, 97.43e6],
      [15, 617, 3.06e9],
      [20, 686, 82.19e9],
      [30, 954, 9.47e12],
      [45, 1000, 52.19e12],
      [60, 1100, 185.62e12],
      [75, 1100, 318.62e12],
      [90, 1100, 451.39e12],
      [105, 1200, 584.33e12],
      [120, 1200, 717.19e12],
      [135, 1200, 850.01e12],
      [141.2, 1200, 903.14e12],
    ],
  },
  {
    lengthMin: 18.5,
    points: [
      [5, 237, 1.7e6],
      [10, 633, 518.1e6],
      [15, 818, 5.08e9],
      [18.5, 864, 9.79e9],
    ],
  },
  {
    lengthMin: 93.9,
    points: [
      [5, 237, 1.7e6],
      [10, 642, 562.29e6],
      [15, 1000, 474.06e9],
      [20, 1200, 2.48e12],
      [30, 1200, 6.47e12],
      [45, 1300, 12.47e12],
      [60, 1300, 18.49e12],
      [75, 1400, 24.54e12],
      [90, 1400, 30.6e12],
      [93.9, 1400, 32.21e12],
    ],
  },
  {
    lengthMin: 138.1,
    points: [
      [5, 631, 32.82e6],
      [10, 1000, 3.46e9],
      [15, 1200, 9.1e9],
      [20, 1200, 14.99e9],
      [30, 1300, 26.76e9],
      [45, 1300, 44.41e9],
      [60, 1400, 62.07e9],
      [75, 1400, 79.72e9],
      [90, 1400, 97.38e9],
      [105, 1400, 115.05e9],
      [120, 1500, 132.7e9],
      [135, 1500, 150.35e9],
      [138.1, 1500, 153.89e9],
    ],
  },
  {
    lengthMin: 85.8,
    points: [
      [5, 957, 214.14e6],
      [10, 1300, 5.23e9],
      [15, 1400, 11.09e9],
      [20, 1400, 17.02e9],
      [30, 1500, 28.89e9],
      [45, 1500, 46.69e9],
      [60, 1600, 64.49e9],
      [75, 1600, 82.29e9],
      [85.8, 1700, 278.63e12],
    ],
  },
  {
    lengthMin: 92.8,
    points: [
      [5, 2300, 2.0e9],
      [10, 2600, 7.67e9],
      [15, 2700, 12.47e9],
      [20, 3600, 393.75e12],
      [30, 4000, 3.05e15],
      [45, 4300, 16.63e15],
      [60, 4500, 32.74e15],
      [75, 4600, 48.73e15],
      [90, 4700, 64.89e15],
      [92.8, 4700, 68.14e15],
    ],
  },
  {
    lengthMin: 22.5,
    points: [
      [5, 2800, 2.16e9],
      [10, 3200, 7.76e9],
      [15, 3400, 13.36e9],
      [20, 3400, 877.17e9],
      [22.5, 4200, 293.08e12],
    ],
  },
];

/**
 * BN1.3's cash in hand (the medium snapshots' `player.money`), [minutes, money], where the spending is most of the
 * income (cycles 1 to 3 at 20 and 30 min) and where the cloud servers are bought (cycles 3 and 4, 30 to 60 min).
 */
export const BN1_3_CASH: readonly { cycle: number; minutes: number; cash: number }[] = [
  { cycle: 1, minutes: 20, cash: 14.39e6 },
  { cycle: 1, minutes: 30, cash: 378.05e6 },
  { cycle: 2, minutes: 20, cash: 307.04e6 },
  { cycle: 2, minutes: 30, cash: 115.63e9 },
  { cycle: 3, minutes: 20, cash: 60.54e9 },
  { cycle: 3, minutes: 30, cash: 2.8e12 },
  { cycle: 4, minutes: 30, cash: 8.74e12 },
  { cycle: 4, minutes: 45, cash: 56.71e12 },
  { cycle: 4, minutes: 60, cash: 188.61e12 },
];

/**
 * BN1.3's RAM in share threads (the fast snapshots' `batcher.sharing`), GB, [minutes, GB], at the readings it shared
 * at (working for a faction): cycles 1 to 5, the batcher healthy, and the 9th, healthy again at hacking 3,600 to 4,700.
 * The extract rounds to three figures.
 */
export const BN1_3_SHARE_RAM: readonly { cycle: number; points: readonly (readonly [number, number])[] }[] = [
  {
    cycle: 1,
    points: [
      [15, 0],
      [20, 24],
      [30, 472],
      [36.3, 8.2e3],
    ],
  },
  {
    cycle: 2,
    points: [
      [10, 8.2e3],
      [15, 8.2e3],
      [20, 8.2e3],
      [30, 32.7e3],
      [45, 131e3],
      [50.7, 262.1e3],
    ],
  },
  {
    cycle: 3,
    points: [
      [10, 262.1e3],
      [15, 262.1e3],
      [20, 262.1e3],
      [30, 262.1e3],
      [45, 524.2e3],
      [60, 524.2e3],
      [70.8, 1.05e6],
    ],
  },
  {
    cycle: 4,
    points: [
      [10, 1.05e6],
      [15, 1.05e6],
      [20, 1.05e6],
      [30, 1.05e6],
      [45, 1.05e6],
      [60, 524.3e3],
      [75, 2.1e6],
      [90, 2.1e6],
      [105, 2.1e6],
      [120, 2.1e6],
      [135, 2.1e6],
    ],
  },
  {
    cycle: 5,
    points: [
      [10, 2.1e6],
      [15, 2.1e6],
      [18.5, 2.1e6],
    ],
  },
  {
    cycle: 9,
    points: [
      [20, 2.1e6],
      [30, 24.25e6],
      [45, 35.22e6],
      [60, 35.38e6],
      [75, 51.83e6],
    ],
  },
];
