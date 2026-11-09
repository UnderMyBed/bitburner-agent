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
 * held out of every fit (#263's decision), and seen since #294 (planned from its figures; still fitted on by nothing):
 * the coordinator's read-only extract on #263,
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

/**
 * BN1.4 (#310, the held-out run for #294's item 4): b212138, SF1.3, 2026-11-08, from the builder's read-only extract
 * on #310: https://github.com/UnderMyBed/bitburner-agent/issues/310#issuecomment-6734050810, and its figures at the
 * precision taken (four significant figures, faction_rep among the multipliers):
 * https://github.com/UnderMyBed/bitburner-agent/issues/310#issuecomment-6734355899. Numbers written by hand, never a
 * save or a dump. Its cycle 1 (36 h 24 min by the clock, 34 min online, 35 h 45 min offline, with offline income) is
 * left out: the runs start from its 2nd cycle's start (17:00:34Z), as the game showed it then, and every minute here
 * is from there. Cycle numbers are the BitNode's as #310 counts them (its 2nd to 14th), the model's 1st to 13th.
 */
export const BN1_4 = {
  start: {
    currentNode: 1,
    ownedSF: { "1": 3 },
    afterInstall: {
      installed: {
        "Synaptic Enhancement Implant": 1,
        "Neurotrainer I": 1,
        "NeuroFlux Governor": 26,
        "Cranial Signal Processors - Gen I": 1,
        "Cranial Signal Processors - Gen II": 1,
        "Social Negotiation Assistant (S.N.A)": 1,
        "Nuoptimal Nootropic Injector Implant": 1,
        "ADR-V1 Pheromone Gene": 1,
        "Augmented Targeting I": 1,
        "Speech Enhancement": 1,
        BitWire: 1,
        "Artificial Synaptic Potentiation": 1,
        "Neural Wit Amplifier": 1,
        "Wired Reflexes": 1,
      },
      /** Each faction's favour as the 2nd cycle's first slow snapshot showing it joined had it. */
      favor: {
        CyberSec: 164.36,
        "Tian Di Hui": 11.56,
        NiteSec: 12.94,
        Ishima: 10.83,
        Chongqing: 10.82,
        "The Black Hand": 10.72,
        "New Tokyo": 10.8,
        BitRunners: 10.64,
      },
      homeRamGb: 524_288,
    },
  },
  /** Each install, minutes from the 2nd cycle's start, the 2nd to the 14th cycle's end (The Red Pill's). */
  installsAtMinutes: [32.49, 49.95, 68.41, 87.88, 106.34, 125.8, 173.38, 210.95, 242.51, 259.99, 282.5, 322.09, 330.53],
  /**
   * The destroy, had it been sent: w0r1d_d43m0n's hacking 3000 with The Red Pill installed, by the 15th cycle's first
   * reading (hacking 4,520 at 2.1 min). The brain didn't send it: SF1 is at its cap (#303's switch).
   */
  destroyedAtMinutes: 332.6,
  /** The install (1-based, from the 2nd cycle's) after which each faction's donations unlocked (favour 150 or more). */
  donationsUnlockedAtInstall: { BitRunners: 10, Daedalus: 12 },
};

/**
 * BN1.4 per cycle, the 2nd to the 14th: its length; the install's reason; Daedalus's count after it (the kinds,
 * NeuroFlux Governor once) and NeuroFlux Governor's levels after; what else it installed; the faction worked the most
 * minutes (from the work chosen; none in the 14th); the hacking level at the end; the share bonus's mean over the fast
 * snapshots (none in the 14th); the first cloud server's minute (none in the 14th: The Red Pill's donation held); when
 * BitRunners was joined (the first slow snapshot showing it); and the game's multipliers and home's RAM at the start.
 */
export const BN1_4_PER_CYCLE = [
  {
    cycle: 2,
    lengthMin: 32.49,
    reason: "count reached",
    count: 15,
    neuroFlux: 37,
    added: ["Neurotrainer II"],
    faction: "NiteSec",
    hacking: 686,
    share: 1.472,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 18.1,
    multipliers: { hacking: 1.956, hacking_exp: 1.915, hacking_speed: 1.795, hacking_money: 1.658, faction_rep: 2.097 },
    homeRamGb: 524_288,
  },
  {
    cycle: 3,
    lengthMin: 17.46,
    reason: "quick install",
    count: 15,
    neuroFlux: 46,
    added: [],
    faction: "NiteSec",
    hacking: 829,
    share: 1.465,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 14.1,
    multipliers: { hacking: 2.182, hacking_exp: 2.457, hacking_speed: 2.002, hacking_money: 1.85, faction_rep: 2.34 },
    homeRamGb: 524_288,
  },
  {
    cycle: 4,
    lengthMin: 18.46,
    reason: "quick install",
    count: 15,
    neuroFlux: 53,
    added: [],
    faction: "NiteSec",
    hacking: 958,
    share: 1.472,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 12.1,
    multipliers: { hacking: 2.387, hacking_exp: 2.687, hacking_speed: 2.19, hacking_money: 2.023, faction_rep: 2.559 },
    homeRamGb: 524_288,
  },
  {
    cycle: 5,
    lengthMin: 19.47,
    reason: "quick install",
    count: 16,
    neuroFlux: 60,
    added: ["Embedded Netburner Module"],
    faction: "NiteSec",
    hacking: 1050,
    share: 1.472,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 10.1,
    multipliers: { hacking: 2.559, hacking_exp: 2.881, hacking_speed: 2.348, hacking_money: 2.169, faction_rep: 2.744 },
    homeRamGb: 524_288,
  },
  {
    cycle: 6,
    lengthMin: 18.46,
    reason: "quick install",
    count: 17,
    neuroFlux: 67,
    added: ["Neural-Retention Enhancement"],
    faction: "NiteSec",
    hacking: 1204,
    share: 1.472,
    firstCloudMin: 10.41,
    bitRunnersJoinedMin: 8.1,
    multipliers: { hacking: 2.963, hacking_exp: 3.089, hacking_speed: 2.517, hacking_money: 2.326, faction_rep: 2.942 },
    homeRamGb: 524_288,
  },
  {
    cycle: 7,
    lengthMin: 19.46,
    reason: "quick install",
    count: 17,
    neuroFlux: 75,
    added: [],
    faction: "NiteSec",
    hacking: 1324,
    share: 1.471,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 7.1,
    multipliers: { hacking: 3.177, hacking_exp: 4.14, hacking_speed: 2.699, hacking_money: 2.494, faction_rep: 3.154 },
    homeRamGb: 524_288,
  },
  {
    cycle: 8,
    lengthMin: 47.58,
    reason: "count reached",
    count: 19,
    neuroFlux: 87,
    added: ["Cranial Signal Processors - Gen III", "CRTX42-AA Gene Modification"],
    faction: "BitRunners",
    hacking: 1579,
    share: 1.495,
    firstCloudMin: 10.4,
    bitRunnersJoinedMin: 6.1,
    multipliers: { hacking: 3.44, hacking_exp: 4.483, hacking_speed: 2.923, hacking_money: 2.7, faction_rep: 3.416 },
    homeRamGb: 524_288,
  },
  {
    cycle: 9,
    lengthMin: 37.57,
    reason: "count reached",
    count: 22,
    neuroFlux: 97,
    added: ["Enhanced Myelin Sheathing", "Cranial Signal Processors - Gen IV", "DataJack"],
    faction: "BitRunners",
    hacking: 2029,
    share: 1.528,
    firstCloudMin: 10.41,
    bitRunnersJoinedMin: 5.1,
    multipliers: { hacking: 4.564, hacking_exp: 5.81, hacking_speed: 3.359, hacking_money: 3.499, faction_rep: 3.849 },
    homeRamGb: 2_097_152,
  },
  {
    cycle: 10,
    lengthMin: 31.56,
    reason: "count reached",
    count: 25,
    neuroFlux: 107,
    added: ["Embedded Netburner Module Core Implant", "Neural Accelerator", "Speech Processor Implant"],
    faction: "BitRunners",
    hacking: 2545,
    share: 1.554,
    firstCloudMin: 10.42,
    bitRunnersJoinedMin: 5.1,
    multipliers: { hacking: 5.444, hacking_exp: 7.059, hacking_speed: 3.898, hacking_money: 5.798, faction_rep: 4.252 },
    homeRamGb: 4_194_304,
  },
  {
    cycle: 11,
    lengthMin: 17.48,
    reason: "quick install",
    count: 27,
    neuroFlux: 113,
    added: ["Neuralstimulator", "Magnetism Amplifier"],
    faction: "The Black Hand",
    hacking: 3061,
    share: 1.554,
    firstCloudMin: 10.42,
    bitRunnersJoinedMin: 4.1,
    multipliers: { hacking: 7.079, hacking_exp: 9.596, hacking_speed: 4.436, hacking_money: 8.454, faction_rep: 4.697 },
    homeRamGb: 4_194_304,
  },
  {
    cycle: 12,
    lengthMin: 22.51,
    reason: "count reached",
    count: 36,
    neuroFlux: 113,
    added: [
      "Embedded Netburner Module Core V2 Upgrade",
      "BitRunners Neurolink",
      "Artificial Bio-neural Network Implant",
      "Cranial Signal Processors - Gen V",
      "The Black Hand",
      "Neuregen Gene Modification",
      "INFRARET Enhancement",
      "Combat Rib I",
      "NutriGen Implant",
    ],
    faction: "The Black Hand",
    hacking: 2924,
    share: 1.554,
    firstCloudMin: 10.41,
    bitRunnersJoinedMin: 5.1,
    multipliers: { hacking: 7.514, hacking_exp: 11.41, hacking_speed: 4.803, hacking_money: 8.975, faction_rep: 4.986 },
    homeRamGb: 4_194_304,
  },
  {
    cycle: 13,
    lengthMin: 39.59,
    reason: "Daedalus donations",
    count: 37,
    neuroFlux: 122,
    added: ["PCMatrix"],
    faction: "Daedalus",
    hacking: 7726,
    share: 1.607,
    firstCloudMin: 10.42,
    bitRunnersJoinedMin: 4.1,
    multipliers: { hacking: 14.95, hacking_exp: 22.04, hacking_speed: 5.563, hacking_money: 18.45, faction_rep: 4.986 },
    homeRamGb: 4_194_304,
  },
  {
    cycle: 14,
    lengthMin: 8.44,
    reason: "The Red Pill",
    count: 41,
    neuroFlux: 122,
    added: [
      "Embedded Netburner Module Core V3 Upgrade",
      "Embedded Netburner Module Direct Memory Access Upgrade",
      "Embedded Netburner Module Analyze Engine",
      "The Red Pill",
    ],
    faction: null,
    hacking: 6089,
    share: null,
    firstCloudMin: null,
    bitRunnersJoinedMin: 3.1,
    multipliers: { hacking: 16.35, hacking_exp: 24.11, hacking_speed: 6.084, hacking_money: 20.18, faction_rep: 5.877 },
    homeRamGb: 16_777_216,
  },
] as const;

/**
 * BN1.4's cycles 2 to 14 in `RUN_3_CYCLES`' form: [minutes, hacking level, the game's hacking income since the
 * install], every 2.5 min to 20, every 5 to 45, and at the end, from the extract's medium (level) and slow (income)
 * snapshots, at four significant figures (the second comment on #310 above).
 */
export const BN1_4_CYCLES: readonly { lengthMin: number; points: readonly (readonly [number, number, number])[] }[] = [
  {
    lengthMin: 32.49,
    points: [
      [2.5, 15, 0],
      [5, 69, 686.3e3],
      [7.5, 181, 8.286e6],
      [10, 314, 69.02e6],
      [12.5, 441, 742.4e6],
      [15, 530, 2.875e9],
      [17.5, 566, 6.411e9],
      [20, 589, 8.769e9],
      [25, 619, 14.66e9],
      [30, 641, 262.2e9],
      [32.5, 686, 2.153e12],
    ],
  },
  {
    lengthMin: 17.46,
    points: [
      [2.5, 19, 0],
      [5, 136, 1.138e6],
      [7.5, 309, 35.44e6],
      [10, 427, 190.6e6],
      [12.5, 551, 1.494e9],
      [15, 663, 33.61e9],
      [17.5, 829, 980.5e9],
    ],
  },
  {
    lengthMin: 18.46,
    points: [
      [2.5, 22, 0],
      [5, 187, 2.058e6],
      [7.5, 382, 75.71e6],
      [10, 484, 281.7e6],
      [12.5, 614, 2.018e9],
      [15, 834, 208.3e9],
      [17.5, 938, 1.387e12],
      [18.5, 958, 1.786e12],
    ],
  },
  {
    lengthMin: 19.47,
    points: [
      [2.5, 24, 0],
      [5, 255, 3.595e6],
      [7.5, 481, 189.3e6],
      [10, 608, 725e6],
      [12.5, 773, 75.78e9],
      [15, 980, 804.1e9],
      [17.5, 1036, 1.999e12],
      [19.5, 1050, 2.48e12],
    ],
  },
  {
    lengthMin: 18.46,
    points: [
      [2.5, 28, 0],
      [5, 360, 7.375e6],
      [7.5, 623, 422.9e6],
      [10, 750, 1.428e9],
      [12.5, 834, 22.76e9],
      [15, 1115, 1.198e12],
      [17.5, 1199, 4.279e12],
      [18.5, 1204, 4.888e12],
    ],
  },
  {
    lengthMin: 19.46,
    points: [
      [2.5, 88, 0],
      [5, 538, 24.67e6],
      [7.5, 763, 840.2e6],
      [10, 859, 2.108e9],
      [12.5, 931, 4.937e9],
      [15, 993, 46.34e9],
      [17.5, 1248, 5.805e12],
      [19.5, 1324, 12.35e12],
    ],
  },
  {
    lengthMin: 47.58,
    points: [
      [2.5, 136, 532e3],
      [5, 663, 50.7e6],
      [7.5, 898, 1.633e9],
      [10, 989, 3.632e9],
      [12.5, 1044, 6.878e9],
      [15, 1082, 9.221e9],
      [17.5, 1110, 12.73e9],
      [20, 1132, 15.08e9],
      [25, 1166, 20.95e9],
      [30, 1176, 23.79e9],
      [35, 1257, 32.75e12],
      [40, 1266, 32.75e12],
      [45, 1531, 386.7e12],
      [47.6, 1579, 1594e12],
    ],
  },
  {
    lengthMin: 37.57,
    points: [
      [2.5, 357, 1.891e6],
      [5, 1050, 277.3e6],
      [7.5, 1290, 3.1e9],
      [10, 1377, 5.458e9],
      [12.5, 1432, 8.998e9],
      [15, 1471, 11.35e9],
      [17.5, 1502, 14.89e9],
      [20, 1528, 17.25e9],
      [25, 1569, 23.15e9],
      [30, 1650, 39.88e12],
      [35, 1931, 978e12],
      [37.6, 2029, 2241e12],
    ],
  },
  {
    lengthMin: 31.56,
    points: [
      [2.5, 625, 9.885e6],
      [5, 1373, 1.088e9],
      [7.5, 1531, 3.787e9],
      [10, 1616, 6.015e9],
      [12.5, 1673, 9.349e9],
      [15, 1716, 11.68e9],
      [17.5, 1753, 15.19e9],
      [20, 1766, 16.62e9],
      [25, 2198, 385.1e12],
      [30, 2504, 2823e12],
      [31.6, 2545, 3787e12],
    ],
  },
  {
    lengthMin: 17.48,
    points: [
      [2.5, 1283, 64.24e6],
      [5, 1884, 1.92e9],
      [7.5, 2038, 5.249e9],
      [10, 2134, 7.547e9],
      [12.5, 2164, 9.715e9],
      [15, 2747, 189.2e12],
      [17.5, 3061, 1235e12],
    ],
  },
  {
    lengthMin: 22.51,
    points: [
      [2.5, 1534, 122.7e6],
      [5, 2045, 2.089e9],
      [7.5, 2205, 5.598e9],
      [10, 2302, 7.94e9],
      [12.5, 2370, 11.45e9],
      [15, 2426, 13.8e9],
      [17.5, 2468, 17.31e9],
      [20, 2479, 17.96e9],
      [22.5, 2924, 792e12],
    ],
  },
  {
    lengthMin: 39.59,
    points: [
      [2.5, 4579, 2.144e9],
      [5, 5544, 42.53e9],
      [7.5, 5572, 12.27e12],
      [10, 5597, 27.65e12],
      [12.5, 6059, 343.7e12],
      [15, 6370, 899.3e12],
      [17.5, 6820, 2692e12],
      [20, 7055, 4297e12],
      [25, 7340, 8345e12],
      [30, 7518, 12420e12],
      [35, 7641, 16440e12],
      [39.6, 7726, 20340e12],
    ],
  },
  {
    lengthMin: 8.44,
    points: [
      [2.5, 5117, 3.476e9],
      [5, 6024, 47.53e9],
      [7.5, 6073, 37e12],
      [8.4, 6089, 51.8e12],
    ],
  },
];

/**
 * BN1.3's cycles the curves' tail past 120 min is fitted on (#310, the review of #316: fitted on the seen run,
 * checked on BN1.4):
 * its 141-min 4th and its Daedalus cycles, the 9th and 10th, in `BN1_4_PER_CYCLE`'s form, with
 * [minutes, hacking level, hacking income since the install] from the builder's read-only extract at four significant
 * figures: https://github.com/UnderMyBed/bitburner-agent/issues/310#issuecomment-6734355899.
 */
export const BN1_3_TAIL_CYCLES = [
  {
    cycle: 4,
    multipliers: { hacking: 2.172, hacking_exp: 2.831, hacking_speed: 1.845, hacking_money: 1.705 },
    homeRamGb: 1_048_576,
    firstCloudMin: 10.42,
    points: [
      [5, 106, 1.056e6],
      [10, 395, 97.43e6],
      [15, 617, 3.063e9],
      [20, 686, 82.19e9],
      [30, 954, 9.47e12],
      [45, 1029, 52.19e12],
      [60, 1090, 185.6e12],
      [75, 1122, 318.6e12],
      [90, 1144, 451.4e12],
      [105, 1160, 584.3e12],
      [120, 1174, 717.2e12],
      [135, 1185, 850e12],
      [141.2, 1189, 903.1e12],
    ],
  },
  {
    cycle: 9,
    multipliers: { hacking: 8.46, hacking_exp: 12.47, hacking_speed: 3.148, hacking_money: 10.44 },
    homeRamGb: 2_097_152,
    firstCloudMin: 15.6,
    points: [
      [5, 2268, 1.997e9],
      [10, 2558, 7.674e9],
      [15, 2668, 12.47e9],
      [20, 3566, 393.7e12],
      [30, 3992, 3047e12],
      [45, 4342, 16630e12],
      [60, 4505, 32740e12],
      [75, 4601, 48730e12],
      [90, 4679, 64890e12],
      [92.8, 4691, 68140e12],
    ],
  },
  {
    cycle: 10,
    multipliers: { hacking: 10.43, hacking_exp: 15.37, hacking_speed: 3.88, hacking_money: 12.87 },
    homeRamGb: 33_554_432,
    firstCloudMin: 19.12,
    points: [
      [5, 2833, 2.162e9],
      [10, 3174, 7.76e9],
      [15, 3356, 13.36e9],
      [20, 3407, 877.2e9],
      [22.5, 4209, 293.1e12],
    ],
  },
] as const;

/**
 * BN1.4's share at a high level (#294's item 5; the review of #316, S2b): its cycles 8 to 13 every 5 min with the cloud
 * bought (1m GB or more), [cycle, minute, hacking level, home RAM GB, cloud RAM GB, the share's RAM GB], from the
 * builder's read-only extract: https://github.com/UnderMyBed/bitburner-agent/issues/310#issuecomment-6734507054.
 */
export const BN1_4_SHARE_RAM: readonly (readonly [number, number, number, number, number, number])[] = [
  [8, 35, 1257, 524_288, 26_214_400, 524_248],
  [8, 40, 1266, 524_288, 26_214_400, 5_619_872],
  [8, 45, 1531, 1_048_576, 26_214_400, 1_048_536],
  [9, 30, 1650, 2_097_152, 6_684_672, 2_349_996],
  [9, 35, 1931, 2_097_152, 26_214_400, 2_097_112],
  [10, 25, 2198, 4_194_304, 24_215_552, 4_194_264],
  [10, 30, 2504, 4_194_304, 26_214_400, 4_194_264],
  [11, 15, 2747, 4_194_304, 14_851_456, 4_194_264],
  [13, 15, 6370, 4_194_304, 26_214_400, 24_837_500],
  [13, 20, 7055, 8_388_608, 26_214_400, 28_979_528],
  [13, 25, 7340, 8_388_608, 26_214_400, 28_977_032],
  [13, 30, 7518, 8_388_608, 26_214_400, 28_974_648],
  [13, 35, 7641, 16_777_216, 26_214_400, 37_441_236],
];
