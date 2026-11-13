/**
 * Bladeburner (#359), #408: the Black Ops' route's estimate with the competence's growth. B6's estimate
 * (./bladeburner-route.ts) holds the competence at the reading's; along the route it rises three ways, each the game's
 * and the brain's own. Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **The skills from the rank:** a point for each 3 of the max rank (`Bladeburner.ts:1284-1293`, `data/Constants.ts:
 *   47`), spent by B3's rule (core's `chooseBladeburnerSkills`: the levels that add the most rank a second a point, by
 *   the B2 forecast at the state then), the success skills on the competence, Overclock on the time.
 * - **The stats from the actions:** each contract's and operation's attempt gives each stat its time × diffMult ×
 *   weight, half on a failure (`getActionStats`, `Bladeburner.ts:705-734`: `BaseStatGain` 1, `data/Constants.ts:33`;
 *   Hyperdrive's ×1, the rule never buys it), taken once more by `mults.<stat>_exp` (`gainStats`,
 *   `PersonObjects/Person.ts:192-198`: once, unlike Training's quirk); the level is ⌊m·(32·ln(exp + 534.6) − 200)⌋
 *   (`PersonObjects/formulas/skill.ts:7-15`, core's `skillLevelOf`), m the player's `mults.<stat>` (BN6 and BN7 set no
 *   `<Stat>LevelMultiplier`, `BitNode/BitNode.tsx:694-769`). The four combat stats.
 * - **The levels opened:** each success opens level M + 1 at ⌈½·M·(2b + M − 1)⌉ successes, b 3 for contracts and 2.5
 *   for operations (`Actions/LevelableAction.ts:49-56`, `Bladeburner.ts:946-950`), a success's rank rising as
 *   rewardFac^(level − 1) against the difficulty's difficultyFac^(level − 1).
 * - **The rate at a state:** B6's ρ, the tail's linear programme (core's `bladeburnerTailRate`), at the input as the
 *   reading would have it there (`bladeburnerGrownInput`): the person's combat stats from the experience, the skills'
 *   levels, each action's max level from its successes, and its chance read scaled to them (the competence there over
 *   the competence read, as B3's and B7's forecasts scale it, times difficultyFac per level). The linear programme's
 *   primal (`bladeburnerTailMix`) gives each action's attempts a second at its level and chance, so the experience and
 *   the successes a second.
 * - **The integration** (`blackOpsRouteGrownEstimate`): over the rank, from the rank read to each Black Op's rank in
 *   steps of `fraction` of the rank (at least `BLADEBURNER_GROWTH_LEAST_STEP`), each step's time its rank over ρ at the
 *   state at its start (a left Riemann sum in the rank: the competence only rises along a step, so it errs long), the
 *   experience and successes accrued at that state's rates, the step's points then spent by B3's rule (and the points
 *   read unspent first). Its error is first order in the step: `fraction` 0.05 is within 2% of an eighth of it at B7's
 *   BN6.1 states (1.1% and 1.8%, the tests'; not signed, as B3's buys move with the step). Each Black Op's attempts:
 *   the n-th made with the chance all before it failed, at the state their rebuilds left (each a failure's loss
 *   rebuilt at ρ's mix), so Σₙ P(n made)·(Tₙ + (1 − pₙ)·L/ρₙ), B6's (T + (1 − p)·L/ρ)/p where nothing grows; its chance
 *   the formula there times the share read (B6's); the state after it its expected failures' rebuilds' (their mean),
 *   then its gain's points.
 * - **Its check** (core's bladeburner-growth.test.ts): a seeded walk of the game's attempts (each success drawn at the
 *   game's formula at the walk's own state, its experience, levels and points the game's, the points spent by B3's
 *   rule as they cover a level): combat 100 from rank 0 to Operation Titan done, within 1% (0.76%); the whole route
 *   (behind an environment knob), 2.8% long (98.25 h against 95.56 ± 1.97 h over 40 walks): the mean path's rate
 *   stands for the mean over the paths (a mean-field step, labelled).
 * - **The first Black Op's rank:** B6's stock (B5's least expected time, `firstToRankSeconds`) where shorter than the
 *   growth's tail: each leaves out what the other counts (the counts' stock; the growth), so each errs long.
 * Left out, and labelled:
 * - hacking, charisma and intelligence's experience from the actions (their weights in the competence are small, the
 *   contracts' charisma 0.1, the operations' hacking at most 0.25): cautious;
 * - the Black Ops' own attempts' experience and successes (dozens of attempts against the actions' thousands):
 *   cautious;
 * - the max rank over the rank read (not read): the points from the rank read on, so a rank under its max earns its
 *   points early, optimistic by at most that gap's thirds; the points' fraction toward the next, cautious;
 * - the successes before the reading (not read): the least that opened each max level read, cautious;
 * - the skills bought only at each step's end, not each reading: cautious;
 * - the spread of the paths: the rate at the mean path stands for the paths' mean (the walk's whole route 2.8%
 *   shorter): cautious;
 * - B6's own (its stamina for the Black Ops, HP and the hospital, the destroy's minute): as B6 labels them;
 * - the counts' stock after the first Black Op, as B6: cautious.
 */
import { COMBAT_STATS, type CombatPerson, type CombatStat, skillLevelOf } from "./bladeburner.ts";
import {
  actionDifficulty,
  actionSkillCompetence,
  type BladeburnerActionInput,
  type BladeburnerActionReading,
  type BladeburnerLevelledAction,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerTailMix,
  chooseBladeburnerSkills,
  difficultyMultiplier,
  maxStaminaAtSkills,
  personCompetenceFactor,
  staminaPenalty,
  successesForNextLevel,
} from "./bladeburner-actions.ts";
import {
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_RANKS_PER_SKILL_POINT,
  type BladeburnerBlackOp,
  blackOpChanceLow,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSuccessChance,
} from "./bladeburner-black-ops.ts";
import { type BladeburnerSkillLevels, bladeburnerSkillMultsOf } from "./bladeburner-skills.ts";

/**
 * An attempt's expected experience of each combat stat (`getActionStats`, `Bladeburner.ts:705-734`; `gainStats`,
 * `PersonObjects/Person.ts:192-198`): its seconds × diffMult × weight × (chance + ½(1 − chance)) × `mults.<stat>_exp`.
 */
export function actionCombatExpPerAttempt(
  action: BladeburnerLevelledAction,
  level: number,
  chance: number,
  seconds: number,
  expMults: Readonly<Record<CombatStat, number>>,
): Record<CombatStat, number> {
  const base = seconds * difficultyMultiplier(actionDifficulty(action, level)) * (chance + 0.5 * (1 - chance));
  return Object.fromEntries(COMBAT_STATS.map((stat) => [stat, base * action.weights[stat] * expMults[stat]])) as Record<
    CombatStat,
    number
  >;
}

/** The max level `successes` open (`Actions/LevelableAction.ts:49-56`): level M + 1 at ⌈½·M·(2b + M − 1)⌉. */
export function maxLevelOfSuccesses(action: BladeburnerLevelledAction, successes: number): number {
  let level = 1;
  while (successes >= successesForNextLevel(action, level)) level += 1;
  return level;
}

/** The least successes that open `maxLevel` (the inverse of `maxLevelOfSuccesses`): 0 at level 1. */
export function successesOfMaxLevel(action: BladeburnerLevelledAction, maxLevel: number): number {
  return maxLevel <= 1 ? 0 : successesForNextLevel(action, maxLevel - 1);
}

/** The route's competence at a point on it (#408): the skills, the combat experience and each action's successes. */
export interface BladeburnerGrowthState {
  rank: number;
  /** The skill points unspent. */
  points: number;
  levels: BladeburnerSkillLevels;
  exp: Record<CombatStat, number>;
  /** Each contract's and operation's successes, by name. */
  successes: Record<string, number>;
}

/** The state a reading starts the route at (#408): its skills, points, the combat experience, the least successes. */
export function bladeburnerGrowthStart(
  input: Omit<BladeburnerActionInput, "target">,
  { rank, points, combat }: { rank: number; points: number; combat: CombatPerson },
): BladeburnerGrowthState {
  const successes: Record<string, number> = {};
  for (const read of input.readings) {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action !== null) successes[action.name] = successesOfMaxLevel(action, read.maxLevel);
  }
  return { rank, points, levels: { ...(input.skills?.read ?? {}) }, exp: { ...combat.exp }, successes };
}

/** The person at a state (#408): the input's (or its forecast's), each combat stat at its experience's level, at least. */
function personAt(
  input: Omit<BladeburnerActionInput, "target">,
  combat: CombatPerson,
  state: BladeburnerGrowthState,
): BladeburnerPerson {
  const at = input.forecast ?? input.person;
  const skills = { ...at.skills };
  for (const stat of COMBAT_STATS)
    skills[stat] = Math.max(at.skills[stat], skillLevelOf(state.exp[stat], combat.mults[stat]));
  return { ...at, skills };
}

/**
 * The input as a reading at `state` would have it (#408): the person there (`personAt`), its skills read, rested (the
 * max stamina at its agility and skills, B3's `maxStaminaAtSkills`, the stamina at it), and each action read at its
 * max level from the successes, its chance there: the low end read over the stamina's penalty, times the competence
 * there over the competence read (the skills' and the person's, as `chooseBladeburnerAction`'s forecast; at most 1
 * where the high end read is 1, B2's `chanceLowAt`), times difficultyFac^(level read − level), at most 1. The forecast
 * and planned skills are folded in, so neither is set.
 */
export function bladeburnerGrownInput(
  input: Omit<BladeburnerActionInput, "target">,
  combat: CombatPerson,
  state: BladeburnerGrowthState,
): Omit<BladeburnerActionInput, "target"> {
  const readMults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
  const mults = bladeburnerSkillMultsOf(state.levels);
  const person = personAt(input, combat, state);
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const personRatio = personCompetenceFactor(person) / personCompetenceFactor(input.person);
  const readings = input.readings.map((read): BladeburnerActionReading => {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action === null || !(penalty > 0)) return read;
    const readCompetence = actionSkillCompetence(action, input.person, readMults);
    const raw = readCompetence > 0 ? (actionSkillCompetence(action, person, mults) / readCompetence) * personRatio : 1;
    const ratio = read.chance[1] >= 1 ? Math.min(1, raw) : raw;
    const level = Math.max(read.maxLevel, maxLevelOfSuccesses(action, state.successes[action.name] ?? 0));
    const chance = Math.min(1, (read.chance[0] / penalty) * ratio * action.difficultyFac ** (read.level - level));
    return { ...read, level, maxLevel: level, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaAtSkills(input.person, input.maxStamina, readMults, mults, person);
  const { forecast: _forecast, ...rest } = input;
  return { ...rest, readings, person, stamina: maxStamina, maxStamina, skills: { read: { ...state.levels } } };
}

/** The least step of the integration, in rank: 10 skill points' worth. */
export const BLADEBURNER_GROWTH_LEAST_STEP = 10 * BLADEBURNER_RANKS_PER_SKILL_POINT;
/** The integration's step, a share of the rank (`blackOpsRouteGrownEstimate`): within 1% of half of it (the tests'). */
export const BLADEBURNER_GROWTH_FRACTION = 0.05;
/** A Black Op's attempts followed one by one, at most (`blackOpsRouteGrownEstimate`), then in closed form. */
export const BLADEBURNER_GROWTH_ATTEMPTS = 2000;
/** The chance of reaching an attempt under which the rest are in closed form (`blackOpsRouteGrownEstimate`). */
export const BLADEBURNER_GROWTH_REACH = 1e-4;

/** Which of the three growths the estimate counts (#408): all, but for the tests' and the report's parts. */
export interface BladeburnerGrowthChannels {
  skills: boolean;
  stats: boolean;
  levels: boolean;
}
export const ALL_GROWTH: Readonly<BladeburnerGrowthChannels> = { skills: true, stats: true, levels: true };

/** One Black Op's part of the grown route (#408): B6's terms at the state at its rank, and that state's summary. */
export interface BlackOpsGrownStep {
  name: string;
  rank: number;
  chance: number;
  seconds: number;
  gain: number;
  loss: number;
  /** ρ at its rank. */
  rate: number;
  toRankSeconds: number;
  attemptsSeconds: number;
  /** The combat stats' levels, the skills' levels and the max levels there. */
  combat: Record<CombatStat, number>;
  levels: BladeburnerSkillLevels;
  maxLevels: Record<string, number>;
}

/** The grown route (#408): each Black Op's part, their sum in game seconds (Infinity: never), and ρ now. */
export interface BlackOpsGrownTime {
  steps: BlackOpsGrownStep[];
  seconds: number;
  rate: number;
  /** The rank against the game seconds from the reading, at each step's end: for hindcasts. */
  path: { rank: number; seconds: number }[];
  /** The tail's mixes solved: the estimate's cost. */
  solves: number;
}

/**
 * The Black Ops' route with the competence's growth (#408, see above): from `at`'s rank and next Black Op, the reading
 * `input` and its combat figures `combat`, the skill points unspent `points`, the BitNode's skill cost
 * `costMultiplier`. `firstToRankSeconds` as B6's (a number: B5's stock time to the next one's rank, taken where
 * shorter than the growth's; null or absent: the growth's tail alone). `fraction`: the step (the tests halve it).
 */
export function blackOpsRouteGrownEstimate(
  input: Omit<BladeburnerActionInput, "target">,
  {
    rank,
    next,
    chanceRead,
    firstToRankSeconds = null,
  }: {
    rank: number;
    next: BladeburnerBlackOp;
    chanceRead: readonly [number, number];
    firstToRankSeconds?: number | null;
  },
  {
    combat,
    points = 0,
    costMultiplier,
    fraction = BLADEBURNER_GROWTH_FRACTION,
    grow = ALL_GROWTH,
    leastStep = BLADEBURNER_GROWTH_LEAST_STEP,
  }: {
    combat: CombatPerson;
    points?: number;
    costMultiplier: number;
    fraction?: number;
    grow?: Readonly<BladeburnerGrowthChannels>;
    leastStep?: number;
  },
): BlackOpsGrownTime {
  const readMults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const nextLow = blackOpChanceLow(chanceRead, penalty);
  const nextFormula = blackOpSuccessChance(next, input.person, { penalty: 1, skills: readMults });
  // The low end's share of the formula's (B6's): common to every Black Op; 1 where unknown.
  const share = nextLow !== null && nextFormula > 0 && nextFormula < 1 ? Math.min(1, nextLow / nextFormula) : 1;
  let state = bladeburnerGrowthStart(input, { rank, points, combat });
  let earned = 0;
  let seconds = 0;
  let solves = 0;
  const path: { rank: number; seconds: number }[] = [{ rank, seconds: 0 }];
  // The tail at a state: its grown input and the mix there.
  const tailAt = (at: BladeburnerGrowthState) => {
    const grown = bladeburnerGrownInput(input, combat, at);
    solves += 1;
    return { grown, mix: bladeburnerTailMix(grown) };
  };
  // Work for `dt` game seconds at a mix: its experience and successes accrued.
  const work = (at: BladeburnerGrowthState, mix: ReturnType<typeof bladeburnerTailMix>, dt: number) => {
    const exp = { ...at.exp };
    const successes = { ...at.successes };
    for (const part of mix.work) {
      const action = bladeburnerLevelledAction(part.type, part.name) as BladeburnerLevelledAction;
      const gained = actionCombatExpPerAttempt(
        action,
        part.level,
        part.chance,
        part.attemptSeconds,
        expMultsOf(combat),
      );
      if (grow.stats) for (const stat of COMBAT_STATS) exp[stat] += gained[stat] * part.attemptsPerSecond * dt;
      if (grow.levels) successes[part.name] = (successes[part.name] ?? 0) + part.chance * part.attemptsPerSecond * dt;
    }
    return { ...at, exp, successes };
  };
  // The points unspent at a state, spent by B3's rule there.
  const spend = (at: BladeburnerGrowthState): BladeburnerGrowthState => {
    if (!grow.skills || !(at.points > 0)) return at;
    const plan = chooseBladeburnerSkills(bladeburnerGrownInput(input, combat, at), {
      levels: at.levels,
      points: at.points,
      costMultiplier,
    });
    const levels = { ...at.levels };
    for (const buy of plan.buys) levels[buy.skill] = buy.to;
    return { ...at, levels, points: at.points - plan.spent };
  };
  // A rise in rank of `by`: its points (each 3 from the rank read on), then spent.
  const rise = (at: BladeburnerGrowthState, by: number): BladeburnerGrowthState => {
    const before = Math.floor(earned / BLADEBURNER_RANKS_PER_SKILL_POINT);
    earned += by;
    const gained = Math.floor(earned / BLADEBURNER_RANKS_PER_SKILL_POINT) - before;
    const risen = { ...at, rank: at.rank + by, points: at.points + gained };
    return gained > 0 ? spend(risen) : risen;
  };
  const first = tailAt(state);
  // The points read unspent, spent first (B3's, within a reading of coming): ρ now is the reading's, before them.
  state = spend(state);
  const rateNow = first.mix.rate;
  const left = BLADEBURNER_BLACK_OPS.slice(BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === next.name));
  const steps: BlackOpsGrownStep[] = [];
  for (const [index, op] of left.entries()) {
    // The climb to its rank, step by step.
    const startSeconds = seconds;
    while (state.rank < op.rank && Number.isFinite(seconds)) {
      const { mix } = tailAt(state);
      if (!(mix.rate > 0)) {
        seconds = Number.POSITIVE_INFINITY;
        break;
      }
      const by = Math.min(op.rank - state.rank, Math.max(leastStep, fraction * state.rank));
      const dt = by / mix.rate;
      seconds += dt;
      state = rise(work(state, mix, dt), by);
      path.push({ rank: state.rank, seconds });
    }
    let toRankSeconds = seconds - startSeconds;
    if (index === 0 && firstToRankSeconds !== null && firstToRankSeconds < toRankSeconds) {
      seconds = startSeconds + firstToRankSeconds;
      toRankSeconds = firstToRankSeconds;
      for (const point of path) point.seconds = Math.min(point.seconds, seconds);
    }
    if (!Number.isFinite(seconds)) break;
    // Its attempts: the n-th made with the chance all before it failed, at the state their rebuilds left (each a
    // failure's loss rebuilt at ρ's mix, B6's), so E = Σₙ P(n made)·(Tₙ + (1 − pₙ)·Lₙ/ρₙ), B6's (T + (1 − p)·L/ρ)/p
    // where nothing grows. Past `BLADEBURNER_GROWTH_ATTEMPTS` or a chance of reaching it under
    // `BLADEBURNER_GROWTH_REACH`, the rest at the last figures in closed form.
    const gain = blackOpRankGain(op, input.rankMultiplier);
    const loss = blackOpRankLoss(op);
    const attemptAt = (at: BladeburnerGrowthState) => {
      const { grown, mix } = tailAt(at);
      const mults = bladeburnerSkillMultsOf(at.levels);
      const formula = blackOpSuccessChance(op, grown.person, { penalty: 1, skills: mults });
      const chance =
        index === 0 && nextLow !== null
          ? nextFormula > 0
            ? Math.min(1, (nextLow * formula) / nextFormula)
            : Math.min(1, share * formula)
          : Math.min(1, share * formula);
      const rebuild = mix.rate > 0 ? loss / mix.rate : Number.POSITIVE_INFINITY;
      return { grown, mix, chance, seconds: blackOpSeconds(op, grown.person, mults), rebuild };
    };
    const firstAttempt = attemptAt(state);
    let current = firstAttempt;
    let at = state;
    const along: BladeburnerGrowthState[] = [state];
    let reach = 1;
    let failures = 0;
    let attemptsSeconds = 0;
    let solveAt = 1;
    for (let made = 0; ; made++) {
      const { chance, seconds: attempt, rebuild } = current;
      if (!(chance > 0) || (chance < 1 && !Number.isFinite(rebuild))) {
        attemptsSeconds = Number.POSITIVE_INFINITY;
        break;
      }
      const cycle = attempt + (1 - chance) * rebuild;
      if (made >= BLADEBURNER_GROWTH_ATTEMPTS || reach < BLADEBURNER_GROWTH_REACH) {
        // The rest at these figures: Σ (1 − p)ᵏ·cycle = cycle/p; their failures (1 − p)/p each reached.
        attemptsSeconds += (reach * cycle) / chance;
        failures += (reach * (1 - chance)) / chance;
        break;
      }
      attemptsSeconds += reach * cycle;
      reach *= 1 - chance;
      if (!(reach > 0)) break;
      failures += reach;
      at = work(at, current.mix, rebuild);
      along.push(at);
      // Solved again each of the first 8, then at each quarter more made (the state moves slowly by then).
      if (made + 1 >= solveAt) {
        current = attemptAt(at);
        solveAt = made + 1 < 8 ? made + 2 : Math.ceil((made + 1) * 1.25);
      }
    }
    steps.push({
      name: op.name,
      rank: op.rank,
      chance: firstAttempt.chance,
      seconds: firstAttempt.seconds,
      gain,
      loss,
      rate: firstAttempt.mix.rate,
      toRankSeconds,
      attemptsSeconds,
      combat: Object.fromEntries(COMBAT_STATS.map((stat) => [stat, firstAttempt.grown.person.skills[stat]])) as Record<
        CombatStat,
        number
      >,
      levels: { ...state.levels },
      maxLevels: Object.fromEntries(firstAttempt.grown.readings.map((read) => [read.name, read.maxLevel])),
    });
    seconds += attemptsSeconds;
    if (!Number.isFinite(seconds)) break;
    // The state its expected failures' rebuilds leave (the path's, at their mean), then a success's mean from its rank.
    state = along[Math.min(along.length - 1, Math.round(failures))] as BladeburnerGrowthState;
    state = rise(state, gain);
    path.push({ rank: state.rank, seconds });
  }
  return { steps, seconds, rate: rateNow, path, solves };
}

/** The combat stats' experience multipliers of `combat`. */
function expMultsOf(combat: CombatPerson): Record<CombatStat, number> {
  return Object.fromEntries(COMBAT_STATS.map((stat) => [stat, combat.mults[`${stat}_exp`]])) as Record<
    CombatStat,
    number
  >;
}
