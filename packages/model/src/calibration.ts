/**
 * The cycle model's calibration (#260): what core's formulas can't say, each a named constant or table citing where it
 * comes from. The model has three curves, as #247's feasibility study proposed:
 * - the hacking level over a cycle (`SIMULATOR_CYCLES`' third cycle, through the game's skill formula);
 * - the money over a cycle (the same cycle's): the install rule counts NeuroFlux Governor's levels the money covers,
 *   so money binds the early installs and can't be left out;
 * - when each faction is joined (`HACKER_FACTION_JOINS`, and core's invitation rules for the rest).
 * And the share bonus while working (`CALIBRATION.shareBonus`). Everything else is the game's formulas, through core.
 */

/**
 * The simulator's first three cycles (#247's feasibility probe: seed 1, main 412d97b, a fresh 8 GB BN1.1 start, every
 * rule on, its progress line every 5 virtual minutes): [minutes since the cycle began, hacking level, money]. Cycle 1
 * began at 0, cycle 2 at the install at about 57 min, cycle 3 at the install at about 122 min (the probe's lines at 60
 * and 125 min are the next cycle's first, at hacking 8 and 1). Its cycle 3 is the model's reference curve; cycles 1 and
 * 2, and the installs, are what the model is checked against (test/validation.test.ts).
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

/**
 * The reference cycle's money leaves out these minutes: the money fell 7.3× at 58 min and stayed (the brain bought
 * something, home's RAM most likely), which a curve of the money the counts see can't place at any one minute.
 */
export const REFERENCE_MONEY_LEFT_OUT_MINUTES: readonly number[] = [58, 63];

/** What can be varied: the sensitivity sweeps (#247) override any of it. */
export interface Calibration {
  /**
   * The multipliers the simulator's third cycle ran at: what the model itself installs in the first two (Synaptic
   * Enhancement Implant and Neurotrainer I, then BitWire, and 23 levels of NeuroFlux Governor), checked equal by
   * test/model.test.ts. Dividing them out makes the reference curves the base exp and money at multiplier 1.
   */
  reference: { hacking: number; hacking_exp: number; hacking_speed: number; hacking_money: number };
  /**
   * How fast a cycle's economy runs with home's RAM at 8 GB, against one with 1 TB or more (log-linear between them):
   * a BitNode's first cycle has only home's RAM until cloud servers are bought, and later cycles start with home's RAM
   * of the cycles before. Fitted to the simulator's first two installs, at about 57 and 122 min: 0.75 gives 54 and
   * 122 (0.6 gives 63 and 128; 0.9, 48 and 113). The one constant fitted to the simulator; run #3's total moves 1%.
   */
  firstCycleSpeed: number;
  /** Home's RAM from which a cycle runs at the reference cycle's pace (`firstCycleSpeed`'s other end). */
  fullSpeedHomeRamGb: number;
  /**
   * How much the operations' speed drives the hacking experience: 1, from the game's formulas, not fitted. Each
   * hack, grow and weaken takes time ∝ 1 / ((hacking + 50) × hacking_speed) (`Hacking.ts:60-80`) and earns experience
   * × hacking_exp (`Hacking.ts:30-38`), so a cycle at a higher level and speed runs the reference cycle's experience
   * faster, by the ratio of the two (`Curves.advanceClocks`).
   */
  expPaceExponent: number;
  /**
   * How much the operations' speed drives the money: fitted to run #3's BN1.2, its late cycles (17:21 to 20:03): 28
   * minutes from an install to the next "count reached", no quick install, 10 installs in all. Money is bounded by
   * the targets' own (the servers' money and growth), so it gains far less than the experience from a faster level.
   * 0.25 gives 10 installs and no quick one; 0.5 gives 12 with 4 quick installs, 1 gives 16 with 8; 0 gives 9, the
   * cycle after BitRunners' donations 2.7 times run #3's. Fitted to the phases it's checked on: run #3's late phases
   * (17:21 on) aren't an independent check of it.
   */
  moneyPaceExponent: number;
  /**
   * The share bonus while working for a faction (#224, core's `shareBonus`, 1 + ln(threads)/25): from run #3's rep/s
   * at BitRunners, 22 at favour 4.8 and 52.7 at 96 (#247), each over (1 + favour/100), against the model's best rate
   * at BitRunners in the same cycles of its own run over its own favour: within 10% of both (test/model.test.ts).
   * 1.45 is about 76,000 share threads, 300 TB of the 26 PB. Not fitted to the phases: 1.3 makes the total 3% longer,
   * 1.6 makes it 7% shorter, 1 (no share) 43% longer.
   */
  shareBonus: number;
}

export const CALIBRATION: Calibration = {
  reference: { hacking: 1.3201, hacking_exp: 1.383, hacking_speed: 1.295, hacking_money: 1.2572 },
  firstCycleSpeed: 0.75,
  fullSpeedHomeRamGb: 1024,
  expPaceExponent: 1,
  moneyPaceExponent: 0.25,
  shareBonus: 1.45,
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
