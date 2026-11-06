/**
 * The cycle model's calibration (#260, #263): what core's formulas can't say, each a named constant or table citing
 * where it comes from. The gross income and the hacking level are inputs measured from run #3 and fitted (the reference
 * cycles, the paces, the first cycle's speed); the share is the game's for the cycle's RAM, a fitted share of it in
 * threads; the joins' levels are the game's. What the validation tests is the rules that run on them.
 * - The hacking level and the gross income over a cycle: run #3's own cycles (`RUN_3_CYCLES`), divided by each cycle's
 *   multipliers into one curve at multiplier 1, run faster or slower by each cycle's level, hacking speed and home RAM
 *   (`Curves`). A curve, not a table a cycle, so a policy that makes cycles longer or shorter (#247) still has one.
 * - The share bonus while working: from the cycle's RAM (`shareRamShare`), or run #3's own a cycle
 *   (`RUN_3_SHARE_BONUS`).
 * - When each hacker faction is joined (`HACKER_FACTION_JOINS`); core's invitation rules for the rest.
 */

/**
 * Run #3's BN1.2 (E0, main 7c741cc, 2026-11-05), each cycle from its install: [minutes, hacking level, the game's
 * hacking income since the install (`moneySources.hacking`, which an install resets)], at 5, 10, 15, 20, 30, 45, 60,
 * 75, 90, 105 and 120 min while the cycle lasted, and at its end. Read from the store, read-only, by the coordinator,
 * and posted on #260: https://github.com/UnderMyBed/bitburner-agent/issues/260#issuecomment-6680681582.
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
   * Read to 120 min (cycles 5 and 6); past it, linear at the last slope, 105 to 120 min, flagged and bounded (#263,
   * `EXTRAPOLATION_BOUND_MIN`). Assumed multipliers: what run #3 installed a cycle isn't known yet.
   */
  referenceCycles: readonly { cycle: number; multipliers: CycleMultipliers }[];
  /**
   * How fast a cycle's economy runs with home's RAM at 8 GB, against one with `fullSpeedHomeRamGb` or more. Fitted,
   * with `fullSpeedHomeRamGb` and the paces, on run #3's cycles 1 to 6 (the model's 7th on is another cycle than run
   * #3's), refitted by #263 once home's RAM came from the cash: the mean error at each reading, 12% on the level and
   * ×1.8 on the gross income (which spans 12 orders of magnitude). BN1.2's home starts at 32 GB, so 8 GB is out of its
   * range.
   */
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
  /** The share bonus while working, by cycle (`RUN_3_SHARE_BONUS`); past the list, its last: `share: "index"` only. */
  shareBonusByCycle: readonly number[];
  /**
   * The share of home's and the cloud servers' RAM in share threads while working (`shareBonusOfState`, #263): the
   * game's formula on this constant. The real share is what the batches leave (at most 80% of their hosts' use, core's
   * `shareRound`), which rises late in a cycle as the batches need less, so a constant reads low in cycles 5 and 6 (an
   * average of 1.43 against run #3's 1.49 and 1.55). Fitted on run #3's share a cycle, cycles 1 to 6: 6% mean error
   * (3% without the 4th, whose 1.16 its brain's share before #242 made, not its RAM).
   */
  shareRamShare: number;
}

export const CALIBRATION: Calibration = {
  referenceCycles: [
    { cycle: 3, multipliers: { hacking: 1.5313, hacking_exp: 1.6042, hacking_speed: 1.5021, hacking_money: 1.4584 } },
    { cycle: 4, multipliers: { hacking: 1.9724, hacking_exp: 2.5704, hacking_speed: 1.6756, hacking_money: 1.5481 } },
    { cycle: 5, multipliers: { hacking: 2.2613, hacking_exp: 3.1379, hacking_speed: 1.7787, hacking_money: 1.6434 } },
    { cycle: 6, multipliers: { hacking: 2.8541, hacking_exp: 3.7007, hacking_speed: 2.0035, hacking_money: 2.5329 } },
  ],
  firstCycleSpeed: 0.8,
  fullSpeedHomeRamGb: 512,
  expPaceExponent: 0.625,
  moneyPaceExponent: 0.5,
  shareBonusByCycle: RUN_3_SHARE_BONUS,
  shareRamShare: 0.01,
};

/**
 * The world servers' RAM the hack loop roots with `ports` port openers, GB, by the ports (0 to 5): every server of the
 * game's that needs no more (`Server/data/servers.ts`, `numOpenPortsRequired`; NUKE checks the ports alone,
 * `NetscriptFunctions.ts:541-544`, and the hack loop roots by them, packages/ingame/src/entries/hack-loop-root.ts), its
 * RAM 2^`maxRamExponent`, the mean of a range drawn per save. The hack loop's hosts with the cloud servers (the brain's
 * `hackLoopHosts`): the cloud payback's income a GB is over them all (#263 review). The game's; a test recomputes them.
 */
export const ROOTED_WORLD_RAM_GB_BY_PORTS: readonly number[] = [100, 236, 454, 907.0667, 1406.1333, 3168.8];

/**
 * When each hacker faction is joined (#195's backdoors): once the hacking level reaches its server's
 * `requiredHackingSkill` and the TOR router and the port openers it needs are bought. Each server's level is drawn per
 * save in a range (`Server/data/servers.ts:1430-1517`); the model takes the top of each (CSEC 51-60, avmnite-02h
 * 202-220, I.I.I.I 340-365, run4theh111z 505-550), the safe side. Run #3 joined BitRunners at hacking about 588 (#247),
 * the simulator at 540.
 */
export const HACKER_FACTION_JOINS: readonly { faction: string; hacking: number; ports: number }[] = [
  { faction: "CyberSec", hacking: 60, ports: 1 },
  { faction: "NiteSec", hacking: 220, ports: 2 },
  { faction: "The Black Hand", hacking: 365, ports: 3 },
  { faction: "BitRunners", hacking: 550, ports: 4 },
];
