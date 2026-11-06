/**
 * The cycle's curves (#260): the hacking level and the money from the install on. Run #3's reference cycles
 * (`Calibration.referenceCycles`), each divided by its multipliers through the game's skill formula, make one curve at
 * multiplier 1, their median a minute. Two clocks run through it, each at its own pace: the experience's and the
 * money's (`advanceClocks`).
 */
import { HOME_RAM_LIMIT, hackingExpForLevel, homeRamUpgradePrice } from "@bitburner-agent/core";
import { type Calibration, type CycleMultipliers, RUN_3_CYCLES } from "./calibration.ts";

const MINUTE_MS = 60_000;
/** The clocks advance in steps this long within a model step, the pace taken afresh each. */
const CLOCK_SUBSTEP_MS = 10_000;
/** `calculateSkill`'s constants (`PersonObjects/formulas/skill.ts:13`): mult × (32 ln(exp + 534.6) − 200). */
const SKILL_EXP_OFFSET = 534.6;
/** The minutes run #3's cycles were read at (`RUN_3_CYCLES`; a cycle's end, at another minute, is left out). */
export const READ_MINUTES: readonly number[] = [5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120];

/** Minutes into the reference curve, by the experience's clock and by the money's. */
export interface Clocks {
  exp: number;
  money: number;
}

export type HackingMultipliers = CycleMultipliers;

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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Each multiplier's geometric mean over `cycles`: the reference curve's own, the clocks' pace 1. */
function meanMultipliers(cycles: readonly { multipliers: CycleMultipliers }[]): CycleMultipliers {
  const mean = (key: keyof CycleMultipliers) =>
    Math.exp(cycles.reduce((sum, each) => sum + Math.log(each.multipliers[key]), 0) / cycles.length);
  return {
    hacking: mean("hacking"),
    hacking_exp: mean("hacking_exp"),
    hacking_speed: mean("hacking_speed"),
    hacking_money: mean("hacking_money"),
  };
}

export class Curves {
  readonly calibration: Calibration;
  /** The reference curves' own multipliers: the reference cycles' geometric mean. */
  readonly reference: CycleMultipliers;
  /** The base hacking experience (at multiplier 1) and money, by minute. */
  readonly #exp: (readonly [number, number])[];
  readonly #money: (readonly [number, number])[];

  constructor(calibration: Calibration) {
    this.calibration = calibration;
    const cycles = calibration.referenceCycles;
    if (cycles.length === 0) throw new RangeError("the calibration names no reference cycle");
    this.reference = meanMultipliers(cycles);
    const exp: [number, number][] = [[0, 0]];
    const money: [number, number][] = [[0, 0]];
    for (const minutes of READ_MINUTES) {
      const read = cycles.flatMap(({ cycle, multipliers }) => {
        const point = RUN_3_CYCLES[cycle - 1]?.points.find(([at]) => at === minutes);
        return point === undefined ? [] : [{ point, multipliers }];
      });
      if (read.length === 0) continue;
      const exps = read.map(
        ({ point, multipliers }) => hackingExpForLevel(point[1], multipliers.hacking) / multipliers.hacking_exp,
      );
      exp.push([minutes, median(exps)]);
      money.push([minutes, median(read.map(({ point, multipliers }) => point[2] / multipliers.hacking_money))]);
    }
    this.#exp = exp;
    this.#money = money;
    this.lastMinute = (exp.at(-1) as readonly [number, number])[0];
  }

  /** The curve's last reading, in minutes: past it, each clock is extrapolated at its last slope (#263 flags it). */
  readonly lastMinute: number;

  /** The hacking level `clockMin` minutes into the reference curve by the experience's clock, at `multipliers`. */
  hackingLevelAt(clockMin: number, multipliers: Pick<HackingMultipliers, "hacking" | "hacking_exp">): number {
    return hackingLevelOf(multipliers.hacking_exp * interpolate(this.#exp, clockMin), multipliers.hacking);
  }

  /** The money `clockMin` minutes into the reference curve by the money's clock, at `multipliers`. */
  moneyAt(clockMin: number, multipliers: Pick<HackingMultipliers, "hacking_money">): number {
    return multipliers.hacking_money * interpolate(this.#money, clockMin);
  }

  /** The pace of a cycle's economy for home's RAM (`Calibration.firstCycleSpeed`), log-linear in the RAM. */
  homeSpeedOf(homeRamGb: number): number {
    const { firstCycleSpeed, fullSpeedHomeRamGb } = this.calibration;
    // From 8 GB (2^3) to `fullSpeedHomeRamGb`.
    const share = Math.min(1, Math.max(0, (Math.log2(homeRamGb) - 3) / (Math.log2(fullSpeedHomeRamGb) - 3)));
    return firstCycleSpeed + (1 - firstCycleSpeed) * share;
  }

  /**
   * The clocks `stepMs` later: each advances at home's pace times the operations' speed against the reference's at the
   * same point, (level + 50) × hacking_speed (`Hacking.ts:60-80`), to the power of its exponent.
   */
  advanceClocks(clocks: Clocks, stepMs: number, multipliers: HackingMultipliers, homeRamGb: number): Clocks {
    const { expPaceExponent, moneyPaceExponent } = this.calibration;
    const homeSpeed = this.homeSpeedOf(homeRamGb);
    let { exp, money } = clocks;
    for (let done = 0; done < stepMs; done += CLOCK_SUBSTEP_MS) {
      const speed =
        ((this.hackingLevelAt(exp, multipliers) + 50) * multipliers.hacking_speed) /
        ((this.hackingLevelAt(exp, this.reference) + 50) * this.reference.hacking_speed);
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

/**
 * A measured cycle's hacking level and money `minutes` after its install (`RUN_3_CYCLES`' form): the level linear
 * between readings from 1 at the install, the money geometric (`interpolate`); past the last reading, each at its last
 * slope.
 */
export function measuredAt(
  points: readonly (readonly [number, number, number])[],
  minutes: number,
): { hacking: number; money: number } {
  const levels: [number, number][] = [[0, 1], ...points.map(([at, level]) => [at, level] as [number, number])];
  const money: [number, number][] = [[0, 0], ...points.map(([at, , income]) => [at, income] as [number, number])];
  let level = levels[0] as [number, number];
  for (const point of levels) if (point[0] <= minutes) level = point;
  const next = levels.find(([at]) => at > minutes);
  const [xa, ya] = levels[levels.length - 2] as [number, number];
  const [xb, yb] = levels[levels.length - 1] as [number, number];
  const hacking =
    next === undefined
      ? yb + ((yb - ya) / (xb - xa)) * (minutes - xb)
      : level[1] + ((next[1] - level[1]) * (minutes - level[0])) / (next[0] - level[0]);
  return { hacking: Math.max(1, Math.floor(hacking)), money: interpolate(money, minutes) };
}
