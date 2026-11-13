/**
 * Bladeburner (#359), slice B5 (#392): the Black Ops. The game's 21, their success, time and rank, and the rule's
 * check of when to run the next. Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **The 21** (`data/BlackOperations.ts:7-733`), done in order: the n-th is available once n are done, and only while
 *   the rank as it is (not the most ever held) is at its own (`Actions/BlackOperation.ts:44-49`), which the game checks
 *   at the start and every second under way (`Bladeburner.ts:1301`). Each is done once: the API's count is 1 for the
 *   next and those after it, 0 for those done (`NetscriptFunctions/Bladeburner.ts:182-183`).
 * - **Success** (`Actions/Action.ts:169-196`), as a contract's or operation's but at no population and no chaos
 *   (`Actions/BlackOperation.ts:55-61`: both factors 1) and no level: min(1, competence / difficulty), the competence the
 *   stats' weighted levels, the intelligence bonus, the stamina penalty, the team bonus (teamCount + 1)^0.05
 *   (`Actions/Operation.ts:96-98`, `:67`), the success skills (the operations', `Actions/BlackOperation.ts:69`) and the
 *   augmentations'. **The estimate's range** (`Action.ts:144-167`): the real and estimated chances are the same (no
 *   population), so it is the chance, its low end times pop/popEst below 1 and its high end above, the division's city's.
 * - **Time** (`Action.ts:105-122`, `Actions/BlackOperation.ts:51-53`): ⌈max(1, difficulty/10 × Overclock's / statFac) ×
 *   1.5⌉ s.
 * - **Rank** (`Formulas.ts:24-25`, `:40-41`): a success gains rankGain × `BladeburnerRank`, a failure loses rankLoss,
 *   not BitNode-scaled; each ±10% (`Bladeburner.ts:1033`, `:1058`), the rank floored at 0 (`:1271-1274`).
 * - **Stamina and HP** (`Bladeburner.ts:1015-1069`): 0.285 × diffMult, success or not; a failure ⌈hpLoss × diffMult ±
 *   10%⌉ HP. **Either way the action stops** (`:1083`): the game doesn't repeat it (`:1313-1315`).
 * - **Teams:** each member ×(n + 1)^0.05 on the competence, and casualties win or lose (`Actions/TeamCasualties.ts`).
 *   The rule sends none (team 0, the game's default, `Actions/BlackOperation.ts:23`): labelled, as #359 sets it.
 */
import {
  actionSkillCompetence,
  actionStatFactor,
  BLADEBURNER_CONSTANTS,
  type BladeburnerActionInput,
  type BladeburnerPerson,
  type BladeburnerPersonStat,
  chooseBladeburnerAction,
  difficultyMultiplier,
  staminaPenalty,
} from "./bladeburner-actions.ts";
import {
  type BladeburnerSkillLevels,
  type BladeburnerSkillMults,
  bladeburnerSkillMultsOf,
  cheapestBladeburnerSkillLevel,
  NO_BLADEBURNER_SKILLS,
  planBladeburnerSkills,
} from "./bladeburner-skills.ts";

/** The Black Ops' action type, as the NS API names it (`Bladeburner/Enums.ts:5`). */
export const BLACK_OPERATIONS = "Black Operations";

/** A Black Op, as `data/BlackOperations.ts` defines it. */
export interface BladeburnerBlackOp {
  /** Its type, for the success skills: an operation's (`Actions/BlackOperation.ts:69`). */
  type: typeof BLACK_OPERATIONS;
  name: string;
  /** The rank it needs, the rank as it is (`Actions/BlackOperation.ts:47`). */
  rank: number;
  baseDifficulty: number;
  rankGain: number;
  rankLoss: number;
  hpLoss: number;
  weights: Record<BladeburnerPersonStat, number>;
  decays: Record<BladeburnerPersonStat, number>;
  isStealth: boolean;
  isKill: boolean;
}

const stats = (
  hacking: number,
  strength: number,
  defense: number,
  dexterity: number,
  agility: number,
  charisma: number,
  intelligence: number,
): Record<BladeburnerPersonStat, number> => ({
  hacking,
  strength,
  defense,
  dexterity,
  agility,
  charisma,
  intelligence,
});

const blackOp = (
  name: string,
  rank: number,
  baseDifficulty: number,
  rankGain: number,
  rankLoss: number,
  hpLoss: number,
  weights: Record<BladeburnerPersonStat, number>,
  decays: Record<BladeburnerPersonStat, number>,
  isStealth: boolean,
  isKill: boolean,
): BladeburnerBlackOp => ({
  type: BLACK_OPERATIONS,
  name,
  rank,
  baseDifficulty,
  rankGain,
  rankLoss,
  hpLoss,
  weights,
  decays,
  isStealth,
  isKill,
});

/** The 21, in the game's order (`data/BlackOperations.ts:7-733`, each its `n`). */
export const BLADEBURNER_BLACK_OPS: readonly BladeburnerBlackOp[] = [
  blackOp(
    "Operation Typhoon",
    2500,
    2000,
    50,
    10,
    100,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Zero",
    5000,
    2500,
    60,
    15,
    50,
    stats(0.2, 0.15, 0.15, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    true,
    false,
  ),
  blackOp(
    "Operation X",
    7500,
    3000,
    75,
    15,
    100,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Titan",
    10_000,
    4000,
    100,
    20,
    100,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Ares",
    12_500,
    5000,
    125,
    20,
    200,
    stats(0, 0.25, 0.25, 0.25, 0.25, 0, 0),
    stats(0, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Archangel",
    15_000,
    7500,
    200,
    20,
    25,
    stats(0, 0.2, 0.2, 0.3, 0.3, 0, 0),
    stats(0, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Juggernaut",
    20_000,
    10_000,
    300,
    40,
    300,
    stats(0, 0.25, 0.25, 0.25, 0.25, 0, 0),
    stats(0, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Red Dragon",
    25_000,
    12_500,
    500,
    50,
    500,
    stats(0.05, 0.2, 0.2, 0.25, 0.25, 0, 0.05),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation K",
    30_000,
    15_000,
    750,
    60,
    1000,
    stats(0.05, 0.2, 0.2, 0.25, 0.25, 0, 0.05),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Deckard",
    40_000,
    20_000,
    1000,
    75,
    200,
    stats(0, 0.24, 0.24, 0.24, 0.24, 0, 0.04),
    stats(0, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Tyrell",
    50_000,
    25_000,
    1500,
    100,
    500,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Wallace",
    75_000,
    30_000,
    2000,
    150,
    1500,
    stats(0, 0.24, 0.24, 0.24, 0.24, 0, 0.04),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Shoulder of Orion",
    100_000,
    35_000,
    2500,
    500,
    1500,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    true,
    false,
  ),
  blackOp(
    "Operation Hyron",
    125_000,
    40_000,
    3000,
    1000,
    500,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Morpheus",
    150_000,
    45_000,
    4000,
    1000,
    100,
    stats(0.05, 0.15, 0.15, 0.3, 0.3, 0, 0.05),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    true,
    false,
  ),
  blackOp(
    "Operation Ion Storm",
    175_000,
    50_000,
    5000,
    1000,
    5000,
    stats(0, 0.24, 0.24, 0.24, 0.24, 0, 0.04),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Annihilus",
    200_000,
    55_000,
    7500,
    1000,
    10_000,
    stats(0, 0.24, 0.24, 0.24, 0.24, 0, 0.04),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Ultron",
    250_000,
    60_000,
    10_000,
    2000,
    10_000,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    true,
  ),
  blackOp(
    "Operation Centurion",
    300_000,
    70_000,
    15_000,
    5000,
    10_000,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    false,
  ),
  blackOp(
    "Operation Vindictus",
    350_000,
    75_000,
    20_000,
    20_000,
    20_000,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    false,
  ),
  blackOp(
    "Operation Daedalus",
    400_000,
    80_000,
    40_000,
    10_000,
    100_000,
    stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.75),
    false,
    false,
  ),
];

/** The Black Op by name, or null. */
export function bladeburnerBlackOp(name: string): BladeburnerBlackOp | null {
  return BLADEBURNER_BLACK_OPS.find((each) => each.name === name) ?? null;
}

/** A Black Op's time over a contract's at its difficulty (`Actions/BlackOperation.ts:51-53`). */
export const BLACK_OP_TIME_PENALTY = 1.5;

/**
 * A Black Op's chance (`Actions/Action.ts:169-196`): no population and no chaos (`Actions/BlackOperation.ts:55-61`), no
 * team (its bonus 1 at 0 members, labelled), the stamina penalty and the skills (none: all 1).
 */
export function blackOpSuccessChance(
  op: BladeburnerBlackOp,
  person: BladeburnerPerson,
  { penalty, skills = NO_BLADEBURNER_SKILLS }: { penalty: number; skills?: BladeburnerSkillMults },
): number {
  let competence = actionSkillCompetence(op, person, skills);
  // `calculateIntelligenceBonus(int, 0.75)` (`PersonObjects/formulas/intelligence.ts`).
  competence *= 1 + (0.75 * person.skills.intelligence ** 0.8) / 600;
  competence *= penalty;
  competence *= person.mults.bladeburner_success_chance;
  return Math.min(1, competence / op.baseDifficulty);
}

/** A Black Op's time, in seconds: ⌈max(1, difficulty/10 × Overclock's / statFac) × 1.5⌉ (`Action.ts:105-122`). */
export function blackOpSeconds(
  op: BladeburnerBlackOp,
  person: BladeburnerPerson,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  const baseTime = op.baseDifficulty / BLADEBURNER_CONSTANTS.difficultyToTimeFactor;
  return Math.ceil(
    Math.max(1, (baseTime * skills.actionTime) / actionStatFactor(person, skills)) * BLACK_OP_TIME_PENALTY,
  );
}

/** A success's rank: rankGain × `BladeburnerRank`, ±10% (`Formulas.ts:24-25`, `Bladeburner.ts:1033`). */
export function blackOpRankGain(op: BladeburnerBlackOp, rankMultiplier: number): number {
  return op.rankGain * rankMultiplier;
}

/** A failure's rank lost: rankLoss, not BitNode-scaled, ±10% (`Formulas.ts:40-41`, `Bladeburner.ts:1058`). */
export function blackOpRankLoss(op: BladeburnerBlackOp): number {
  return op.rankLoss;
}

/** An attempt's stamina, success or not: 0.285 × diffMult (`Bladeburner.ts:1015-1024`). */
export function blackOpStaminaCost(op: BladeburnerBlackOp): number {
  return BLADEBURNER_CONSTANTS.baseStaminaLoss * difficultyMultiplier(op.baseDifficulty);
}

/** A failure's HP lost, its mean: hpLoss × diffMult (`Bladeburner.ts:1061-1063`), each draw rounded up. */
export function blackOpHpLoss(op: BladeburnerBlackOp): number {
  return op.hpLoss * difficultyMultiplier(op.baseDifficulty);
}

/** The next Black Op as the worker reads it (#392): its name, and the game's estimate's range for it. */
export interface BladeburnerBlackOpReading {
  name: string;
  /** `getActionEstimatedSuccessChance`, with the stamina penalty of the moment. */
  chance: [number, number];
}

/** The points a skill point takes of the max rank (`data/Constants.ts:47`, `Bladeburner.ts:1284-1293`). */
export const BLADEBURNER_RANKS_PER_SKILL_POINT = 3;

/**
 * The expected game seconds to a Black Op done (#392), each attempt `seconds` at chance `chance`, each failure the
 * rank's rebuild, `rebuild` seconds: the attempts are geometric (1/chance of them, Grinstead and Snell, "Introduction to
 * Probability", 2nd ed., 1997, §5.1), each but the last a failure, so (seconds + (1 − chance) × rebuild) / chance.
 * Infinity at chance 0.
 */
export function blackOpSecondsToDone(chance: number, seconds: number, rebuild: number): number {
  return chance > 0 ? (seconds + (1 - Math.min(1, chance)) * rebuild) / Math.min(1, chance) : Number.POSITIVE_INFINITY;
}

/** The least chance the check's bound is sought from (#392): the bisection's floor, where a time is still finite. */
const LEAST_CHANCE = 1e-9;

/** The rule's check on the next Black Op (#392), for the brain, the dashboard and the run report. */
export interface BladeburnerBlackOpCheck {
  name: string;
  /** Its rank, and whether the rank read is at it. */
  rank: number;
  met: boolean;
  /** The estimate's low end with the stamina's penalty out (`blackOpChanceLow`), null with no penalty to divide by. */
  chance: number | null;
  /** An attempt's game seconds, a failure's rank lost (its mean), and a success's rank gained. */
  seconds: number;
  loss: number;
  gain: number;
  /**
   * The rank's rebuild after a failure: the expected game seconds from its rank less the loss back to it, by #386's least
   * expected time to a target (`chooseBladeburnerAction`); Infinity if none rises.
   */
  rebuild: number;
  /** The expected game seconds to it done if attempted now and at each return to its rank (`blackOpSecondsToDone`). */
  expected: number;
  /**
   * The one-stage look-ahead (`checkBladeburnerBlackOp`): the points awaited (those the cheapest level of a rank skill is
   * short of), the seconds to them, the chance and seconds after B3's plan spends them, and the expected time to it
   * done that way (the wait and then `blackOpSecondsToDone`). Null without B3's skills read.
   */
  wait: { points: number; seconds: number; chance: number; attemptSeconds: number; expected: number } | null;
  /**
   * The least chance at which attempting now is as fast as the look-ahead's wait (0 with no wait; Infinity when the
   * wait is faster even at 1: the skills awaited cut the time), and the verdict.
   */
  bound: number;
  run: boolean;
}

/**
 * The low end of the game's estimate for a Black Op with the stamina's penalty out (as core's `chanceLowAt`): the low
 * end over the penalty, at most 1. The range is the chance itself times pop/popEst at the low end (no population in it,
 * `Actions/BlackOperation.ts:55-57`), so it scales as the penalty while the chance isn't clamped at 1; clamped (the
 * high end read at 1), it's the low end as read, a bound from below. Null with no penalty (stamina at 0).
 */
export function blackOpChanceLow(read: readonly [number, number], penalty: number): number | null {
  if (!(penalty > 0)) return null;
  if (read[1] >= 1) return Math.min(1, read[0]);
  return Math.min(1, read[0] / penalty);
}

/**
 * When to run the next Black Op (#392). Under its rank, never: the rule's target is its rank (`bladeburnerRankTarget`,
 * #386's least expected time to it). At it, the measure is the expected time to it done (`blackOpSecondsToDone`): each
 * attempt its seconds (`blackOpSeconds`) at the estimate's low end (`blackOpChanceLow`), each failure losing its rank
 * loss and so the time to rebuild it (`rebuild`: #386's least expected time from its rank less the loss back to it).
 * Attempting is a stopping problem against waiting for the chance to rise, which only the skills move here (the stats
 * and augmentations are the planner's, B7): the max rank earns a point each 3 (`BLADEBURNER_RANKS_PER_SKILL_POINT`), and
 * B3's plan spends them (core's `planBladeburnerSkills`, the brain's). So the check is the one-stage look-ahead (Ferguson,
 * "Optimal Stopping and Applications", ch. 5, the monotone case: stop when stopping now is no worse than one more
 * stage then stopping): attempting now against waiting for the points the cheapest rank skill's next level is short of
 * (`cheapestBladeburnerSkillLevel`, at least 1), at the plan's rank a second, then attempting at the chance and seconds
 * after B3's plan spends them. Run it when now's expected time is no more than the wait's; `bound` is the least chance
 * that holds (bisected: now's falls with the chance, as 1/chance). Without B3's skills read (an older Agent), run it at
 * any chance over 0. The look-ahead is optimal where the problem is monotone (once stopping is best it stays best),
 * which is taken, not proved: each point's levels cost more as they rise (`Skill.ts:76-80`), so the chance a wait buys
 * falls, and the rule re-checks at each reading.
 * The time waiting earns rank toward the next Black Op too, which this measure (the time to this one done) counts as a
 * cost: it errs toward running now, the order the epic sets (#359).
 * Left out, and labelled: the rank over its requirement, so each failure's rebuild is from its rank less the loss (a
 * failure from higher needs less, so the rebuild errs long); the ±10% on the loss (its mean); the rebuild's own
 * speed-up from the skills awaited; the points' fraction already earned toward the next (the max rank isn't read, so
 * the wait errs long, toward running now); HP, which costs money at the hospital, not rank (B2's, the planner's); the
 * team (0).
 */
export function checkBladeburnerBlackOp(
  input: Omit<BladeburnerActionInput, "target">,
  {
    op,
    rank,
    chance: read,
    skills,
    forecastUnmet = false,
  }: {
    op: BladeburnerBlackOp;
    rank: number;
    chance: readonly [number, number];
    /** B3's reading (null: an older Agent's): the levels, the points unspent and the BitNode's skill cost. */
    skills: { levels: BladeburnerSkillLevels; points: number; costMultiplier: number } | null;
    /** Under its rank, still forecast the time to it done once there (the run report's ETA); never run. */
    forecastUnmet?: boolean;
  },
): BladeburnerBlackOpCheck {
  const levels = input.skills?.read ?? {};
  const mults = bladeburnerSkillMultsOf(levels);
  const chance = blackOpChanceLow(read, input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0);
  const seconds = blackOpSeconds(op, input.person, mults);
  const loss = blackOpRankLoss(op);
  const gain = blackOpRankGain(op, input.rankMultiplier);
  const met = rank >= op.rank;
  const none = { name: op.name, rank: op.rank, met, chance, seconds, loss, gain };
  const never = { rebuild: Number.POSITIVE_INFINITY, expected: Number.POSITIVE_INFINITY, wait: null, bound: 0 };
  if ((!met && !forecastUnmet) || chance === null || !(chance > 0)) return { ...none, ...never, run: false };
  const rebuildPlan = chooseBladeburnerAction({
    ...input,
    target: { rank: Math.max(0, op.rank - loss), target: op.rank },
  });
  const rebuild = rebuildPlan.toTarget?.seconds ?? Number.POSITIVE_INFINITY;
  const expected = blackOpSecondsToDone(chance, seconds, rebuild);
  if (!met) return { ...none, ...never, rebuild, expected, run: false };
  if (skills === null) return { ...none, rebuild, expected, wait: null, bound: 0, run: true };
  // The look-ahead: the points awaited, at the plan's rank a second (rank met: no target), and B3's plan with them.
  const points = Math.max(1, cheapestBladeburnerSkillLevel(skills.levels, skills.costMultiplier) - skills.points);
  const rate = chooseBladeburnerAction(input).rankPerSecond;
  const waitSeconds = rate > 0 ? (points * BLADEBURNER_RANKS_PER_SKILL_POINT) / rate : Number.POSITIVE_INFINITY;
  const plan = planBladeburnerSkills({
    levels: skills.levels,
    points: skills.points + points,
    costMultiplier: skills.costMultiplier,
    rankPerSecond: (planned) => chooseBladeburnerAction({ ...input, skills: { read: levels, planned } }).rankPerSecond,
  });
  const planned = { ...levels, ...Object.fromEntries(plan.buys.map((buy) => [buy.skill, buy.to])) };
  const plannedMults = bladeburnerSkillMultsOf(planned);
  const readCompetence = actionSkillCompetence(op, input.person, mults);
  const ratio = readCompetence > 0 ? actionSkillCompetence(op, input.person, plannedMults) / readCompetence : 1;
  // Clamped (the high end read at 1), a rise isn't credited, as `chanceLowAt`'s.
  const after = Math.min(1, chance * (read[1] >= 1 ? Math.min(1, ratio) : ratio));
  const attemptSeconds = blackOpSeconds(op, input.person, plannedMults);
  const waited = waitSeconds + blackOpSecondsToDone(after, attemptSeconds, rebuild);
  const wait = { points, seconds: waitSeconds, chance: after, attemptSeconds, expected: waited };
  // The least chance now no slower than the wait, the wait's chance moving with it (`ratio`): bisected over (0, 1].
  const nowAt = (p: number) => blackOpSecondsToDone(p, seconds, rebuild);
  const waitAt = (p: number) =>
    waitSeconds +
    blackOpSecondsToDone(Math.min(1, p * (read[1] >= 1 ? Math.min(1, ratio) : ratio)), attemptSeconds, rebuild);
  let bound = 0;
  if (!(nowAt(1) <= waitAt(1))) bound = Number.POSITIVE_INFINITY;
  else if (!(nowAt(LEAST_CHANCE) <= waitAt(LEAST_CHANCE))) {
    let low = LEAST_CHANCE;
    let high = 1;
    for (let step = 0; step < 60; step++) {
      const middle = (low + high) / 2;
      if (nowAt(middle) <= waitAt(middle)) high = middle;
      else low = middle;
    }
    bound = high;
  }
  return { ...none, rebuild, expected, wait, bound, run: expected <= waited };
}
