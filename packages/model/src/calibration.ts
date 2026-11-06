/**
 * The cycle model's calibration (#260): what core's formulas can't say, each a named constant or table citing where it
 * comes from. Fitted, all of it, and said so: the model's money and hacking are inputs measured from run #3, and what
 * the validation tests is the rules of reputation, favour, buying and installing that run on them.
 * - The hacking level and the money over a cycle: run #3's own cycles (`RUN_3_CYCLES`), divided by each cycle's
 *   multipliers into one curve at multiplier 1, run faster or slower by each cycle's level, hacking speed and home RAM
 *   (`Curves`). A curve, not a table a cycle, so a policy that makes cycles longer or shorter (#247) still has one.
 * - The share bonus while working, run #3's own a cycle (`RUN_3_SHARE_BONUS`).
 * - When each hacker faction is joined (`HACKER_FACTION_JOINS`); core's invitation rules for the rest.
 */

/**
 * Run #3's BN1.2 (E0, main 7c741cc, 2026-11-05), each cycle from its install: [minutes, hacking level, the game's
 * hacking income since the install (`moneySources.hacking`, which an install resets)], at 5, 10, 15, 20, 30, 45, 60,
 * 75, 90, 105 and 120 min while the cycle lasted, and at its end. Read from the store, read-only, by the coordinator
 * (#262's review, `run3-cycle-curves.txt`); never by the model's tests.
 */
export const RUN_3_CYCLES: readonly { lengthMin: number; points: readonly (readonly [number, number, number])[] }[] = [
  {
    lengthMin: 39.5,
    points: [
      [5, 8, 0],
      [10, 46, 1.48e6],
      [15, 123, 14.86e6],
      [20, 188, 118.33e6],
      [30, 290, 1.95e9],
      [39.5, 358, 160.12e9],
    ],
  },
  {
    lengthMin: 56.6,
    points: [
      [5, 20, 0],
      [10, 97, 4.28e6],
      [15, 204, 77.14e6],
      [20, 286, 547.81e6],
      [30, 431, 243.78e9],
      [45, 574, 9.45e12],
      [56.6, 593, 18.0e12],
    ],
  },
  {
    lengthMin: 75.6,
    points: [
      [5, 36, 0],
      [10, 159, 10.02e6],
      [15, 311, 220.96e6],
      [20, 442, 3.3e9],
      [30, 649, 2.33e12],
      [45, 725, 16.4e12],
      [60, 773, 66.23e12],
      [75, 797, 116.47e12],
      [75.6, 798, 119.83e12],
    ],
  },
  {
    lengthMin: 95.7,
    points: [
      [5, 86, 656_174],
      [10, 336, 62.37e6],
      [15, 554, 2.09e9],
      [20, 760, 604.03e9],
      [30, 878, 4.72e12],
      [45, 938, 29.75e12],
      [60, 1000, 145.85e12],
      [75, 1033, 272.5e12],
      [90, 1055, 399.27e12],
      [95.7, 1061, 450.02e12],
    ],
  },
  {
    lengthMin: 123.8,
    points: [
      [5, 140, 1.17e6],
      [10, 490, 173.61e6],
      [15, 715, 3.33e9],
      [20, 870, 323.15e9],
      [30, 1104, 11.39e12],
      [45, 1200, 77.63e12],
      [60, 1261, 209.31e12],
      [75, 1295, 340.87e12],
      [90, 1320, 472.49e12],
      [105, 1338, 603.99e12],
      [120, 1353, 735.4e12],
      [123.8, 1357, 770.55e12],
    ],
  },
  {
    lengthMin: 124.1,
    points: [
      [5, 267, 2.74e6],
      [10, 655, 565.71e6],
      [15, 840, 5.31e9],
      [20, 902, 9.21e9],
      [30, 1286, 23.98e12],
      [45, 1386, 70.63e12],
      [60, 1433, 117.35e12],
      [75, 1466, 164.17e12],
      [90, 1489, 210.83e12],
      [105, 1508, 257.7e12],
      [120, 1522, 295.89e12],
      [124.1, 1526, 308.33e12],
    ],
  },
  {
    lengthMin: 31.6,
    points: [
      [5, 974, 79.41e6],
      [10, 1453, 4.75e9],
      [15, 1571, 10.54e9],
      [20, 1640, 16.32e9],
      [30, 1995, 328.58e12],
      [31.6, 2128, 857.53e12],
    ],
  },
  {
    lengthMin: 27.5,
    points: [
      [5, 1956, 1.77e9],
      [10, 2232, 7.59e9],
      [15, 2365, 13.42e9],
      [20, 2410, 17.37e9],
      [27.5, 3310, 2013.09e12],
    ],
  },
  {
    lengthMin: 81.7,
    points: [
      [5, 2561, 2.56e9],
      [10, 2865, 8.37e9],
      [15, 2967, 12.25e9],
      [20, 4203, 1032.45e12],
      [30, 4632, 5883.43e12],
      [45, 4922, 19613.95e12],
      [60, 5064, 33263.06e12],
      [75, 5166, 46986.16e12],
      [81.7, 5204, 53427.52e12],
    ],
  },
  {
    lengthMin: 18.5,
    points: [
      [5, 3130, 2.98e9],
      [10, 3455, 8.63e9],
      [15, 3591, 12.82e9],
      [18.5, 4690, 592.51e12],
    ],
  },
];

/**
 * Run #3's share bonus a cycle, its average while working (#262's review: the coordinator's per-cycle table from the
 * store, #244's section 2b), cycles 1 to 10. A constant flips the 4th cycle's work between 1.40 and 1.45 (#262's
 * review), so the model takes each cycle's own; past the 10th, the last.
 */
export const RUN_3_SHARE_BONUS: readonly number[] = [1.07, 1.26, 1.39, 1.16, 1.49, 1.55, 1.45, 1.41, 1.5, 1.51];

/**
 * The simulator's first three cycles (#247's feasibility probe: seed 1, main 412d97b, a fresh 8 GB BN1.1 start, every
 * rule on, its progress line every 5 virtual minutes): [minutes since the cycle began, hacking level, money]. Cycle 1
 * began at 0, cycle 2 at the install at about 57 min, cycle 3 at the install at about 122 min. Not calibration: an
 * independent check that the curves fitted on BN1.2 carry to a fresh BN1.1 (test/validation.test.ts).
 */
export const SIMULATOR_CYCLES: readonly {
  startMin: number;
  points: readonly (readonly [number, number, number])[];
}[] = [
  {
    startMin: 0,
    points: [
      [5, 7, 1.26e3],
      [10, 27, 3.04e5],
      [15, 59, 1.6e6],
      [20, 100, 9.17e5],
      [25, 135, 1.2e6],
      [30, 164, 9.98e6],
      [35, 191, 4.64e7],
      [40, 222, 4.82e7],
      [45, 254, 1.78e8],
      [50, 286, 1.21e9],
      [55, 292, 5.06e9],
    ],
  },
  {
    startMin: 57,
    points: [
      [3, 8, 1.26e3],
      [8, 38, 9.68e5],
      [13, 101, 2.96e6],
      [18, 171, 8.73e6],
      [23, 218, 3.63e7],
      [28, 268, 5.14e7],
      [33, 305, 6.85e8],
      [38, 346, 2.68e10],
      [43, 419, 1.9e11],
      [48, 460, 4.33e11],
      [53, 479, 2.27e12],
      [58, 484, 2.79e12],
      [63, 497, 3.41e12],
    ],
  },
  {
    startMin: 122,
    points: [
      [3, 1, 1.26e3],
      [8, 38, 3.52e5],
      [13, 120, 2.45e6],
      [18, 206, 7.16e6],
      [23, 277, 5.9e7],
      [28, 357, 3.69e8],
      [33, 389, 1.35e10],
      [38, 491, 2.49e11],
      [43, 540, 2.06e12],
      [48, 556, 3.41e12],
      [53, 575, 7.0e12],
      [58, 589, 9.55e11],
      [63, 589, 9.55e11],
      [68, 597, 7.34e12],
      [73, 608, 1.74e13],
      [78, 616, 2.75e13],
    ],
  },
];

/** The multipliers a cycle ran at, as the model computes them (core's `installGains` and SF1's bonus). */
export interface CycleMultipliers {
  hacking: number;
  hacking_exp: number;
  hacking_speed: number;
  hacking_money: number;
}

/** What can be varied: the sensitivity sweeps (#247) override any of it. */
export interface Calibration {
  /**
   * The cycles of run #3 the curves are made of (1-based), and the multipliers the model itself runs each at, on its
   * run of run #3: checked equal by test/model.test.ts. Each cycle's level (through the game's skill formula,
   * `hackingExpForLevel`) and income, divided by them, is a curve at multiplier 1; the curve is their median a minute.
   */
  referenceCycles: readonly { cycle: number; multipliers: CycleMultipliers }[];
  /** How fast a cycle's economy runs with home's RAM at 8 GB, against one with `fullSpeedHomeRamGb` or more. */
  firstCycleSpeed: number;
  /** Home's RAM from which a cycle runs at the reference cycles' pace (`firstCycleSpeed`'s other end). */
  fullSpeedHomeRamGb: number;
  /**
   * How much the operations' speed drives the experience and the money: each hack, grow and weaken takes time
   * ∝ 1 / ((hacking + 50) × hacking_speed) (`Hacking.ts:60-80`), so a cycle at a higher level and speed runs the
   * reference cycles' curves faster by the ratio of the two, to these powers (`Curves.advanceClocks`). Fitted: the
   * experience's also carries the RAM's growth, which the money pays for, and the money is bounded by the targets'
   * own (the servers' money and growth).
   */
  expPaceExponent: number;
  moneyPaceExponent: number;
  /** The share bonus while working, by cycle (`RUN_3_SHARE_BONUS`); past the list, its last. */
  shareBonusByCycle: readonly number[];
}

export const CALIBRATION: Calibration = {
  referenceCycles: [
    { cycle: 3, multipliers: { hacking: 1.5313, hacking_exp: 1.6042, hacking_speed: 1.5021, hacking_money: 1.4584 } },
    { cycle: 4, multipliers: { hacking: 1.9724, hacking_exp: 2.5704, hacking_speed: 1.6756, hacking_money: 1.5481 } },
    { cycle: 5, multipliers: { hacking: 2.2613, hacking_exp: 3.1379, hacking_speed: 1.7787, hacking_money: 1.6434 } },
    { cycle: 6, multipliers: { hacking: 2.8541, hacking_exp: 3.7007, hacking_speed: 2.0035, hacking_money: 2.5329 } },
  ],
  firstCycleSpeed: 0.65,
  fullSpeedHomeRamGb: 256,
  expPaceExponent: 0.5,
  moneyPaceExponent: 0.375,
  shareBonusByCycle: RUN_3_SHARE_BONUS,
};

/**
 * When each hacker faction is joined (#195's backdoors): once the hacking level reaches its server's
 * `requiredHackingSkill` and the money has bought the TOR router and the port openers it needs. Each server's level is
 * drawn per save in a range (`Server/data/servers.ts:1430-1517`); the model takes the top of each (CSEC 51-60,
 * avmnite-02h 202-220, I.I.I.I 340-365, run4theh111z 505-550), the safe side. Run #3 joined BitRunners at hacking
 * about 588 (#247), the simulator at 540.
 */
export const HACKER_FACTION_JOINS: readonly { faction: string; hacking: number; ports: number }[] = [
  { faction: "CyberSec", hacking: 60, ports: 1 },
  { faction: "NiteSec", hacking: 220, ports: 2 },
  { faction: "The Black Hand", hacking: 365, ports: 3 },
  { faction: "BitRunners", hacking: 550, ports: 4 },
];
