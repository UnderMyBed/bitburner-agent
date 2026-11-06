/**
 * The cycle's curves (#260): the hacking level and the money from the install on, from the simulator's reference cycle
 * (`SIMULATOR_CYCLES`' third) and the game's skill formula. Two clocks run through that reference cycle, each at its
 * own pace: the experience's and the money's (`advanceClocks`).
 */
import { HOME_RAM_LIMIT, hackingExpForLevel, homeRamUpgradePrice } from "@bitburner-agent/core";
import { type Calibration, REFERENCE_MONEY_LEFT_OUT_MINUTES, SIMULATOR_CYCLES } from "./calibration.ts";

const MINUTE_MS = 60_000;
/** The clocks advance in steps this long within a model step, the pace taken afresh each. */
const CLOCK_SUBSTEP_MS = 10_000;
/** `calculateSkill`'s constants (`PersonObjects/formulas/skill.ts:13`): mult × (32 ln(exp + 534.6) − 200). */
const SKILL_EXP_OFFSET = 534.6;

/** Minutes into the reference cycle, by the experience's clock and by the money's. */
export interface Clocks {
  exp: number;
  money: number;
}

export interface HackingMultipliers {
  hacking: number;
  hacking_exp: number;
  hacking_speed: number;
  hacking_money: number;
}

/** The game's `calculateSkill` (`PersonObjects/formulas/skill.ts:7-15`): never below 1. */
export function hackingLevelOf(exp: number, multiplier: number): number {
  return Math.max(1, Math.floor(multiplier * (32 * Math.log(exp + SKILL_EXP_OFFSET) - 200)));
}

/**
 * `points` (minutes, value) at `x`: geometric between two values above 0 (the experience and the money grow
 * exponentially while the RAM is bought), linear otherwise, and linear past the last point at the last slope (the RAM
 * at its limit, a steady rate).
 */
function interpolate(points: readonly (readonly [number, number])[], x: number): number {
  const first = points[0] as readonly [number, number];
  if (x <= first[0]) return first[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1] as readonly [number, number];
    const [x1, y1] = points[i] as readonly [number, number];
    if (x <= x1) {
      const share = (x - x0) / (x1 - x0);
      return y0 > 0 && y1 > 0 ? y0 * (y1 / y0) ** share : y0 + (y1 - y0) * share;
    }
  }
  const [xa, ya] = points[points.length - 2] as readonly [number, number];
  const [xb, yb] = points[points.length - 1] as readonly [number, number];
  return yb + ((yb - ya) / (xb - xa)) * (x - xb);
}

export class Curves {
  readonly calibration: Calibration;
  /** The reference cycle's base hacking experience (at multiplier 1) and money, by minute. */
  readonly #exp: (readonly [number, number])[];
  readonly #money: (readonly [number, number])[];

  constructor(calibration: Calibration) {
    this.calibration = calibration;
    const { reference } = calibration;
    const points = SIMULATOR_CYCLES[2]?.points ?? [];
    this.#exp = [
      [0, 0],
      ...points.map(
        ([minutes, level]) => [minutes, hackingExpForLevel(level, reference.hacking) / reference.hacking_exp] as const,
      ),
    ];
    this.#money = points
      .filter(([minutes]) => !REFERENCE_MONEY_LEFT_OUT_MINUTES.includes(minutes))
      .map(([minutes, , money]) => [minutes, money / reference.hacking_money] as const);
  }

  /** The hacking level `clockMin` minutes into the reference cycle by the experience's clock, at `multipliers`. */
  hackingLevelAt(clockMin: number, multipliers: Pick<HackingMultipliers, "hacking" | "hacking_exp">): number {
    return hackingLevelOf(multipliers.hacking_exp * interpolate(this.#exp, clockMin), multipliers.hacking);
  }

  /** The money `clockMin` minutes into the reference cycle by the money's clock, at `multipliers`. */
  moneyAt(clockMin: number, multipliers: Pick<HackingMultipliers, "hacking_money">): number {
    return multipliers.hacking_money * interpolate(this.#money, clockMin);
  }

  /** The pace of a cycle's economy for home's RAM (`Calibration.firstCycleSpeed`). */
  homeSpeedOf(homeRamGb: number): number {
    const { firstCycleSpeed, fullSpeedHomeRamGb } = this.calibration;
    // 8 GB (2^3) to `fullSpeedHomeRamGb`, log-linear.
    const share = Math.min(1, Math.max(0, (Math.log2(homeRamGb) - 3) / (Math.log2(fullSpeedHomeRamGb) - 3)));
    return firstCycleSpeed + (1 - firstCycleSpeed) * share;
  }

  /**
   * The clocks `stepMs` later: each advances at home's pace times the operations' speed against the reference cycle's
   * at the same point, (level + 50) × hacking_speed (`Hacking.ts:60-80`), to the power of its exponent.
   */
  advanceClocks(clocks: Clocks, stepMs: number, multipliers: HackingMultipliers, homeRamGb: number): Clocks {
    const { reference, expPaceExponent, moneyPaceExponent } = this.calibration;
    const homeSpeed = this.homeSpeedOf(homeRamGb);
    let { exp, money } = clocks;
    for (let done = 0; done < stepMs; done += CLOCK_SUBSTEP_MS) {
      const speed =
        ((this.hackingLevelAt(exp, multipliers) + 50) * multipliers.hacking_speed) /
        ((this.hackingLevelAt(exp, reference) + 50) * reference.hacking_speed);
      const minutes = (Math.min(CLOCK_SUBSTEP_MS, stepMs - done) / MINUTE_MS) * homeSpeed;
      exp += minutes * speed ** expPaceExponent;
      money += minutes * speed ** moneyPaceExponent;
    }
    return { exp, money };
  }
}

/**
 * Home's RAM after a cycle that reached `money`: doubled while the money covers each upgrade's price on top of those
 * before it (core's `homeRamUpgradePrice`), to the game's limit. The brain buys home's RAM through the cycle and
 * ahead of NeuroFlux Governor at the commit (packages/brain/src/augmentations.ts); an install keeps it.
 */
export function homeRamAfter(homeRamGb: number, money: number): number {
  let home = homeRamGb;
  let spent = 0;
  while (home < HOME_RAM_LIMIT && spent + homeRamUpgradePrice(home) <= money) {
    spent += homeRamUpgradePrice(home);
    home *= 2;
  }
  return home;
}
