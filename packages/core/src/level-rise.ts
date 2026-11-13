/**
 * The hacking level's rise over faction work (#401, roadmap #347 Track 2 item 1b): faction work's reputation grows with
 * the hacking level (`PersonObjects/formulas/reputation.ts:16-52`, core's `factionReputationPerCycle`), and the level
 * rises while the work goes on, so a time by work at the level now runs long. Pure, from the game's formulas (owner
 * decision 46) and a rate measured online (decision 67):
 * - **The level:** the game's `calculateSkill`, L = m·(32·ln(exp + 534.6) − 200) (`PersonObjects/formulas/skill.ts:
 *   7-15`; m the player's `mults.hacking` × the BitNode's `HackingLevelMultiplier`, `Person.ts:60-63`), unfloored.
 * - **The experience:** de/dt = κ·(L + 50). Every hacking operation's time is `5 × (2.5 × required × security + 500)
 *   / (hacking + 50)` over the speed (`Hacking.ts:60-80`), and each thread earns the same experience whatever the level
 *   (`Hacking.ts:30-38`), so on the same RAM the experience a second scales as L + 50 (as levelling's
 *   `secondsToHackingLevel`, #336). κ is the measured experience rate over (the level it was measured at + 50): the
 *   brain's `HackingExpRate` (#336, a 10-minute window).
 * - **After an install** (`laterCycleRise`): from no experience (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:
 *   80-102`), κ times the install's `hacking_exp` (each thread's experience, `Hacking.ts:37`) and `hacking_speed`
 *   (each operation's time, `Hacking.ts:60-80`), and m times its `hacking` (core's `levellingInstallMultipliers`).
 * - **The reputation:** the work's rate at the predicted level, integrated over the time (`workSecondsAlong`,
 *   `reputationAlong`); the caller's rate holds the faction work formula's other terms (favour, `faction_rep`, the
 *   BitNode's `FactionWorkRepGain`, the share's mean, #351).
 * Left out, each labelled: home RAM growing and new servers (cloud servers bought this cycle, or bought back after an
 * install: `Prestige.ts` loses them), so more threads: cautious for waiting, as the measured rate is held on the RAM
 * it was measured on; the share's own change over the work (its mean now, or the last cycle's, held); the batcher's
 * target moving to a server worth more experience; intelligence's rise (`intelligenceBonus`). With no rate measured the
 * level is flat: the rate at the level now, as before #401.
 */
import type { LevellingMultipliers } from "./levelling.ts";

/** The level's term in an operation's time: `hacking + 50` (`Hacking.ts:69-73`'s `baseSkill`). */
export const LEVEL_RISE_TERM = 50;

/** The experience's offset in the level formula (`skill.ts:13`): ln(exp + 534.6). */
const EXP_OFFSET = 534.6;

/**
 * The level's path from now (#401): the experience and the level now, the level multiplier m, and κ, the experience a
 * second per (level + 50); κ 0 is a flat level.
 */
export interface LevelRise {
  exp: number;
  level: number;
  levelMult: number;
  kappa: number;
}

/**
 * The level's path from `exp` at `level` (the snapshot's, floored by the game), with `expPerSecond` the experience
 * rate measured at that level (null, not finite or not above 0: a flat level, κ 0).
 */
export function levelRiseOf({
  exp,
  level,
  levelMult,
  expPerSecond,
}: {
  exp: number;
  level: number;
  levelMult: number;
  expPerSecond: number | null;
}): LevelRise {
  const kappa =
    expPerSecond !== null && Number.isFinite(expPerSecond) && expPerSecond > 0
      ? expPerSecond / (level + LEVEL_RISE_TERM)
      : 0;
  return { exp: Math.max(0, exp), level, levelMult, kappa };
}

/**
 * The level's path in the cycle after an install (#401): from no experience, at level 1 (`calculateSkill`'s least,
 * `skill.ts:14`), m times the install's `hacking`, κ times its `hacking_exp` and `hacking_speed` (`gain`, core's
 * `levellingInstallMultipliers`). `rise` is this cycle's, with the rate measured now: what the next cycle starts from,
 * on the RAM this one has (home's kept, the cloud servers bought back: left out, labelled in the module's comment).
 */
export function laterCycleRise(rise: LevelRise, gain: LevellingMultipliers): LevelRise {
  return {
    exp: 0,
    level: 1,
    levelMult: rise.levelMult * gain.hacking,
    kappa: rise.kappa * gain.hackingExp * gain.hackingSpeed,
  };
}

/** The predicted level `seconds` from now: the level now plus the formula's rise over the experience gained. */
export function levelAlong(rise: LevelRise, seconds: number): number {
  if (!(rise.kappa > 0) || !(seconds > 0)) return rise.level;
  let level = rise.level;
  let atSeconds = 0;
  for (const step of steps(rise)) {
    if (step.toSeconds >= seconds) {
      return level + ((step.toLevel - level) * (seconds - atSeconds)) / (step.toSeconds - atSeconds);
    }
    level = step.toLevel;
    atSeconds = step.toSeconds;
  }
  return level;
}

/**
 * The seconds until the work, from `fromSeconds` on, has earned `reputation`, at `rateAt(level)` a second along the
 * level's path: the start for none; Infinity where the rate is never above 0. Flat (κ 0): `fromSeconds + reputation /
 * rateAt(level)`, today's τ.
 */
export function workSecondsAlong(
  rise: LevelRise,
  rateAt: (level: number) => number,
  reputation: number,
  fromSeconds = 0,
): number {
  if (!(reputation > 0)) return fromSeconds;
  if (!(rise.kappa > 0)) {
    const rate = rateAt(rise.level);
    return rate > 0 ? fromSeconds + reputation / rate : Number.POSITIVE_INFINITY;
  }
  let earned = 0;
  let atSeconds = 0;
  let level = rise.level;
  for (const step of steps(rise)) {
    if (step.toSeconds > fromSeconds) {
      const from = Math.max(atSeconds, fromSeconds);
      // The rate across the step at its levels' mean: a step is one level or less.
      const rate = (rateAt(level) + rateAt(step.toLevel)) / 2;
      const gained = rate * (step.toSeconds - from);
      if (rate > 0 && earned + gained >= reputation) return from + (reputation - earned) / rate;
      earned += Math.max(0, gained);
    }
    level = step.toLevel;
    atSeconds = step.toSeconds;
  }
  return Number.POSITIVE_INFINITY;
}

/** The reputation the work earns from `fromSeconds` to `toSeconds` at `rateAt(level)` a second along the path. */
export function reputationAlong(
  rise: LevelRise,
  rateAt: (level: number) => number,
  fromSeconds: number,
  toSeconds: number,
): number {
  if (!(toSeconds > fromSeconds)) return 0;
  if (!(rise.kappa > 0)) return rateAt(rise.level) * (toSeconds - fromSeconds);
  let earned = 0;
  let atSeconds = 0;
  let level = rise.level;
  for (const step of steps(rise)) {
    const from = Math.max(atSeconds, fromSeconds);
    const to = Math.min(step.toSeconds, toSeconds);
    if (to > from) {
      // The levels at the overlap's ends, linear across the step.
      const levelAt = (seconds: number) =>
        level + ((step.toLevel - level) * (seconds - atSeconds)) / (step.toSeconds - atSeconds);
      earned += ((rateAt(levelAt(from)) + rateAt(levelAt(to))) / 2) * (to - from);
    }
    if (step.toSeconds >= toSeconds) return earned;
    level = step.toLevel;
    atSeconds = step.toSeconds;
  }
  return earned;
}

/** At most this many steps: a level each, past any level the game reaches (9,000 is w0r1d_d43m0n's at its hardest). */
const MOST_STEPS = 200_000;

/**
 * The path's steps, one level of the formula each: with u = ln(exp + 534.6), de = e^u du and L = m·(32u − 200), so
 * dt = e^u du / (κ·(L + 50)), integrated by the trapezoid rule across each step (e^u grows by e^(1/(32m)) a step: 3% at
 * m 1). The level is the level now plus the formula's rise, 32m·Δu, so the path starts at the snapshot's floored level.
 */
function* steps(rise: LevelRise): Generator<{ toSeconds: number; toLevel: number }> {
  const m = rise.levelMult;
  if (!(m > 0) || !(rise.kappa > 0)) return;
  const du = 1 / (32 * m);
  let u = Math.log(rise.exp + EXP_OFFSET);
  let level = rise.level;
  let weight = Math.exp(u) / (level + LEVEL_RISE_TERM);
  let seconds = 0;
  for (let index = 0; index < MOST_STEPS; index++) {
    const nextLevel = level + 1;
    const nextWeight = Math.exp(u + du) / (nextLevel + LEVEL_RISE_TERM);
    seconds += ((weight + nextWeight) / 2) * (du / rise.kappa);
    if (!Number.isFinite(seconds)) return;
    u += du;
    level = nextLevel;
    weight = nextWeight;
    yield { toSeconds: seconds, toLevel: level };
  }
}
