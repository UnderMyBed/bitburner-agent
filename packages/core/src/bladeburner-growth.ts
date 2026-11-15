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
 *   state at its start (a left Riemann sum in the rank), the experience and successes accrued at that state's rates,
 *   the step's points then spent by B3's rule, batched at its end (and the points read unspent first). Its error is
 *   first order in the step, and measured, not signed by argument: `fraction` 0.05 is 1.1% and 1.8% shorter than an
 *   eighth of it at B7's BN6.1 states (combat 100 and 300, the tests'), so optimistic by about 2% (#409's review). The
 *   left sum alone errs long (with the skills alone, 0.3% and 7.4% long; without them, under 0.01%), but B3's buys,
 *   batched a step at a time, with the stats and levels rising under them come out short on balance. Each Black Op's
 *   attempts: the n-th made with the chance all before it failed, at the state their rebuilds left (each a failure's
 *   loss rebuilt at ρ's mix), so Σₙ P(n made)·(Tₙ + (1 − pₙ)·L/ρₙ), B6's (T + (1 − p)·L/ρ)/p where nothing grows; its chance
 *   the formula there (#411: not B6's share of the low end read); the state after it its expected failures' rebuilds'
 *   (their mean), then its gain's points.
 * - **The chances** (#411, the coordinator's ruling 4 there; `bladeburnerPricedInput`): each contract's and operation's
 *   at the true population, the chance the game draws against, the true population over its estimate recovered from the
 *   next Black Op's range read (core's `populationRatioOfBlackOpRange`: one end its formula, the other that × the
 *   ratio); where it can't be, the mean over the estimate's own spread at a start (`actionChanceOverSpread`, labelled
 *   there, either way). Each Black Op's at its formula (it doesn't depend on the population). Since #415 B2's rule and
 *   B3's spending choose at these chances too (the brain's rule input is this pricing), so the points along the route
 *   are spent by the rule at the estimate's own chances, as the brain spends them; B6's flat estimate and B5's Black Op
 *   check keep the low end (on seed 1's New Tokyo, its estimate 1.42× the truth, Raid's 0.026 low end against 0.051
 *   drawn). Labelled: past the reading, a chance scaled by the competence's rise is clipped at 1
 *   (`bladeburnerGrownInput`), exact at the true chance; at the spread's mean, min(1, E × rise) is over E[min(1,
 *   chance × rise)] past the cap (Jensen), optimistic there.
 * - **Its check** (core's bladeburner-growth.test.ts): a seeded walk of the game's attempts (each success drawn at the
 *   game's formula at the walk's own state, its experience, levels and points the game's, the points spent by B3's
 *   rule as they cover a level): combat 100 from rank 0 to Operation Titan done, within 1% (0.76%); the whole route
 *   (behind an environment knob), 2.8% long (98.25 h against 95.56 ± 1.97 h over 40 walks): the mean path's rate
 *   stands for the mean over the paths (a mean-field step, labelled). The walk checks the integration and the growth's
 *   bookkeeping (the experience, the levels, the points and their spending, the Black Ops' attempts), not ρ: it works
 *   the actions as the tail's mix (`bladeburnerTailMix`) has them, so it inherits ρ and its time accounting (#409's
 *   review). Only the BN6 suites' hindcasts check ρ.
 * - **The first Black Op's rank:** B6's stock (B5's least expected time, `firstToRankSeconds`) where shorter than the
 *   growth's tail: each leaves out what the other counts (the counts' stock; the growth), so each errs long.
 * - **The cities' drift** (#418, ./bladeburner-drift.ts), with the cities read (`input.drift`): the state carries the
 *   six (`BladeburnerGrowthState`'s `drift`), each step's mix moving them on their mean path (its attempts, the decay
 *   and the random events' mean, Diplomacy holding the city worked at 50, B4's city chosen again); each chance there is
 *   the one read times the city worked's factor over the one read in (`driftedChance`), and the step's mix is priced
 *   over the step ahead (its rank over the step before's rate) as B2's rule prices a plan over its horizon
 *   (`bladeburnerGrownInput`'s `horizonSeconds`: tested equal at a step). Labelled: the step's pricing each action
 *   alone (the mix's other actions' drift in it is the state's at the next step); the Black Ops' rebuilds priced at
 *   the state (no step ahead); the events' mean for their spread, and the chance's mean over the paths (concave in the
 *   population): optimistic.
 * Left out, and labelled:
 * - hacking, charisma and intelligence's experience from the actions (their weights in the competence are small, the
 *   contracts' charisma 0.1, the operations' hacking at most 0.25): cautious;
 * - the Black Ops' own attempts' experience and successes (dozens of attempts against the actions' thousands):
 *   cautious;
 * - the max rank over the rank read (not read): the points from the rank read on, so a rank under its max earns its
 *   points early, optimistic by at most that gap's thirds; the points' fraction toward the next, cautious;
 * - the successes before the reading (not read): the least that opened each max level read, cautious;
 * - the skills bought only at each step's end, not each reading: with the left sum, the step's error, measured
 *   optimistic by about 2% (above);
 * - the spread of the paths: the rate at the mean path stands for the paths' mean (the walk's whole route 2.8%
 *   shorter): cautious;
 * - B6's own (its stamina for the Black Ops, HP and the hospital, the destroy's minute): as B6 labels them (#418: the
 *   hospital's money a second at the reading is reported, `moneyLostPerSecond`, not in the time);
 * - the counts' stock after the first Black Op, as B6: cautious.
 */
import { COMBAT_STATS, type CombatPerson, type CombatStat, skillLevelOf } from "./bladeburner.ts";
import {
  actionChanceAtRatio,
  actionChanceOverSpread,
  actionDifficulty,
  actionHpLoss,
  actionSkillCompetence,
  BLADEBURNER_CONSTANTS,
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
  populationRatioOfBlackOpRange,
  staminaPenalty,
  successesForNextLevel,
} from "./bladeburner-actions.ts";
import {
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_RANKS_PER_SKILL_POINT,
  type BladeburnerBlackOp,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSuccessChance,
} from "./bladeburner-black-ops.ts";
import {
  type BladeburnerDriftCity,
  type BladeburnerDriftPart,
  type BladeburnerDriftState,
  bladeburnerDriftPath,
  bladeburnerDriftStart,
  driftedChance,
  hospitalCostPerFailure,
} from "./bladeburner-drift.ts";
import {
  BLADEBURNER_ROUTE_REPLAYS,
  type BladeburnerRoutePart,
  type BladeburnerRouteReplays,
  type BladeburnerRouteTimeline,
  bladeburnerReplayDeclined,
  bladeburnerReplayRoute,
  bladeburnerReplaySeedOf,
} from "./bladeburner-replays.ts";
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
  /**
   * The cities along the route (#418, ./bladeburner-drift.ts): the six as the mix's attempts, the time and Diplomacy
   * have moved them, the brain's city chosen again (B4's), and the one the reading's chances were read in (`reference`).
   * Absent: no cities read, no drift.
   */
  drift?: { state: BladeburnerDriftState; reference: BladeburnerDriftCity };
}

/**
 * The state a reading starts the route at (#408): its skills, points, the combat experience, the least successes; and
 * (#418) the cities read, the city worked the one the chances were read in, Diplomacy's ceiling the chaos threshold
 * (B4 brings a chaos read over it down along the route; that Diplomacy's time left out, optimistic, a reading's).
 */
export function bladeburnerGrowthStart(
  input: Omit<BladeburnerActionInput, "target">,
  { rank, points, combat }: { rank: number; points: number; combat: CombatPerson },
): BladeburnerGrowthState {
  const successes: Record<string, number> = {};
  for (const read of input.readings) {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action !== null) successes[action.name] = successesOfMaxLevel(action, read.maxLevel);
  }
  const start =
    input.drift === undefined ? null : bladeburnerDriftStart(input.drift.cities, input.drift.city, input.drift.chaos);
  const drift =
    start === null
      ? {}
      : {
          drift: {
            state: { ...start, ceiling: BLADEBURNER_CONSTANTS.chaosThreshold },
            reference: { ...(start.cities[start.worked] as BladeburnerDriftCity) },
          },
        };
  return { rank, points, levels: { ...(input.skills?.read ?? {}) }, exp: { ...combat.exp }, successes, ...drift };
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
  /** The drift's horizon (#418): each chance priced over the step ahead (`chooseBladeburnerAction`'s `drift`). */
  horizonSeconds = 0,
): Omit<BladeburnerActionInput, "target"> {
  const readMults = bladeburnerSkillMultsOf(input.skills?.read ?? {});
  const mults = bladeburnerSkillMultsOf(state.levels);
  const person = personAt(input, combat, state);
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const personRatio = personCompetenceFactor(person) / personCompetenceFactor(input.person);
  // The city worked along the route (#418): its chance factor over the one read in, and its communities for Raid.
  const city = state.drift === undefined ? null : (state.drift.state.cities[state.drift.state.worked] ?? null);
  const readings = input.readings.map((read): BladeburnerActionReading => {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action === null || !(penalty > 0)) return read;
    const readCompetence = actionSkillCompetence(action, input.person, readMults);
    const raw = readCompetence > 0 ? (actionSkillCompetence(action, person, mults) / readCompetence) * personRatio : 1;
    const ratio = read.chance[1] >= 1 ? Math.min(1, raw) : raw;
    const level = Math.max(read.maxLevel, maxLevelOfSuccesses(action, state.successes[action.name] ?? 0));
    // Clipped at 1: exact at a true chance (#411's pricing); at the spread's mean, min(1, E × rise) is over
    // E[min(1, chance × rise)] past the cap (Jensen), optimistic there.
    const grown = Math.min(1, (read.chance[0] / penalty) * ratio * action.difficultyFac ** (read.level - level));
    // In the city worked (#418): a chance read at 1 taken as 1 there, so it falls with the drift (cautious).
    const chance =
      city === null || state.drift === undefined
        ? grown
        : driftedChance({ action, chance: grown }, state.drift.reference, city, state.drift.state.ceiling);
    return { ...read, level, maxLevel: level, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaAtSkills(input.person, input.maxStamina, readMults, mults, person);
  // The attempt under way is the reading's (#421's ruling 3), not a state's along the route.
  const { forecast: _forecast, drift: _drift, underWay: _underWay, ...rest } = input;
  // The drift from the city worked, its reference the state's own (the chances above are there now).
  const drift =
    state.drift === undefined || city === null
      ? {}
      : { drift: { cities: state.drift.state.cities, city: city.name, horizonSeconds } };
  return {
    ...rest,
    readings,
    person,
    stamina: maxStamina,
    maxStamina,
    skills: { read: { ...state.levels } },
    ...drift,
  };
}

/**
 * The input the grown estimate prices (#411, the coordinator's ruling 4), and since #415 the one B2's and B3's rules
 * choose at (the brain's `bladeburnerRuleInputOf`): each contract's and operation's chance at the true population (a
 * point), pop/popEst recovered from the next Black Op's range read `chanceRead` against its formula at the reading
 * (its stamina's penalty in; core's `populationRatioOfBlackOpRange`, `actionChanceAtRatio`); where it can't be (no
 * Black Op read, `next` null: all 21 done or an older Agent's; or clipped), each at its mean over the estimate's spread
 * (`actionChanceOverSpread`, its bias labelled there). Since #420 (#422's round 2), where the input's drift carries
 * the round's measure of the city read (`drift.ratio`, core's `bladeburnerCityMeasures`: from every range there not
 * clipped, the branch where they agree), that ratio, so B2, B3 and B4 read one; the Black Op's formula only without
 * a round (its pick near r 1 erred by 0.16% in bn6-skills, Ishima at 1.0008). `ratio`: the one used, or null.
 */
export function bladeburnerPricedInput<T extends Omit<BladeburnerActionInput, "target">>(
  input: T,
  {
    next,
    chanceRead,
  }: { next: BladeburnerBlackOp; chanceRead: readonly [number, number] } | { next: null; chanceRead: null },
): { input: T; ratio: number | null } {
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const measured = input.drift?.ratio;
  const ratio =
    typeof measured === "number"
      ? measured
      : next === null
        ? null
        : populationRatioOfBlackOpRange(
            chanceRead,
            blackOpSuccessChance(next, input.person, {
              penalty,
              skills: bladeburnerSkillMultsOf(input.skills?.read ?? {}),
            }),
          );
  const readings = input.readings.map((read) => {
    const at = ratio === null ? null : actionChanceAtRatio(read.chance, ratio);
    const chance = at ?? actionChanceOverSpread(read.chance);
    return { ...read, chance: [chance, chance] as [number, number] };
  });
  return { input: { ...input, readings }, ratio };
}

/**
 * The chunks a step's drift is followed in at most (#418's review, for the cost): a step is 5% of the rank
 * (`BLADEBURNER_GROWTH_FRACTION`), its pricing over the step ahead and the cities moved by it each a path, against the
 * rule's `BLADEBURNER_DRIFT_CHUNKS` over the whole horizon; a city worked throughout converges in its chunks (core's
 * test). Raid with B4's moves is followed an attempt at a time here too (`BLADEBURNER_DRIFT_EXACT_RAID`, #418's ruling
 * 4: its chunks don't converge, B4's pick between near-tied homes flipping with the step; that flipping is #420), so
 * the estimate's Raid is the rule's: at no measured cost (bn6-install 18.0 s here, 18.5 s with 16 chunks for it; core's
 * route 177.1 h either way).
 */
export const BLADEBURNER_GROWTH_DRIFT_CHUNKS = 16;

/** The least step of the integration, in rank: 10 skill points' worth. */
export const BLADEBURNER_GROWTH_LEAST_STEP = 10 * BLADEBURNER_RANKS_PER_SKILL_POINT;
/** The integration's step, a share of the rank (`blackOpsRouteGrownEstimate`): within 2% of an eighth of it (the tests'). */
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
  /** pop/popEst recovered from the next one's range read (#411), or null: the chances priced over the spread. */
  populationRatio: number | null;
  /**
   * The hospital's money a game second at the reading (#418): the mix's failures a second, each its mean bill at the
   * money and max HP read (core's `hospitalCostPerFailure`); null, not read. Absent in figures before #418.
   */
  moneyLostPerSecond?: number | null;
  /** The cities at the route's end (#418): the drift's mean path, the city worked, its population over the one read. */
  drift?: { cities: BladeburnerDriftCity[]; worked: string; populationRatio: number } | null;
  /**
   * #423: with the cities read, `seconds` (and `path`, each step's terms) is the route's re-priced mean over its replays
   * under the game's draws (./bladeburner-replays.ts, first-order: the mean path's route, levels, installs and clock);
   * `meanPathSeconds` the mean path's alone, `secondsError` the replays' standard error (0 without them), and the
   * replays' count, seed series, times and fallbacks (null without). Absent in figures before #423.
   */
  meanPathSeconds?: number;
  secondsError?: number;
  replays?: {
    count: number;
    seed: number;
    times: number[];
    /** The replays' own mean and standard error, used or not. */
    seconds: number;
    error: number;
    fallbackSteps: number;
    replaysWithFallback: number;
    /** Each replay's least step rate over its mean path's (#423's ruling 8). */
    leastRatios: number[];
    /** The Black Ops whose rebuilds took the mean path's rate in every replay (#423's ruling 11: never measured). */
    meanPathRebuilds: number;
    /** The gate's verdict (#423's ruling 7, `bladeburnerReplayDeclined`): used, or declined and why (the mean path's). */
    used: boolean;
    declined: string | null;
  } | null;
}

/**
 * The replays' seed series where no refresh gives one (core's tests, the hindcasts' replays of a reading): the first of
 * the 10 series the gate was measured on (#423's ruling 11, the refresh at 2026-01-01 00:00 UTC).
 */
export const BLADEBURNER_REPLAY_DEFAULT_SEED = bladeburnerReplaySeedOf(Date.UTC(2026, 0, 1));

/**
 * The Black Ops' route with the competence's growth (#408, see above): from `at`'s rank and next Black Op, the reading
 * `input` and its combat figures `combat`, the skill points unspent `points`, the BitNode's skill cost
 * `costMultiplier`. `firstToRankSeconds` as B6's (a number: B5's stock time to the next one's rank, taken where
 * shorter than the growth's; null or absent: the growth's tail alone). `fraction`: the step (the tests halve it).
 */
export function blackOpsRouteGrownEstimate(
  read: Omit<BladeburnerActionInput, "target">,
  {
    rank,
    next,
    chanceRead,
    firstToRankSeconds = null,
  }: {
    rank: number;
    next: BladeburnerBlackOp;
    /**
     * The next one's range read: the population's ratio from it (#411); every Black Op priced at its formula. Required
     * (#414's round 2: the brain's call had dropped it, so every action was priced over the spread).
     */
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
    replays = BLADEBURNER_ROUTE_REPLAYS,
    replaySeed = BLADEBURNER_REPLAY_DEFAULT_SEED,
    replayLeastRatio,
    replayMostRatio,
  }: {
    combat: CombatPerson;
    points?: number;
    costMultiplier: number;
    fraction?: number;
    grow?: Readonly<BladeburnerGrowthChannels>;
    leastStep?: number;
    /**
     * The route's replays under the game's draws (#423, ./bladeburner-replays.ts), with the cities read (none without):
     * `BLADEBURNER_ROUTE_REPLAYS`; 0, the mean path alone (#406's step error, B7's eighth of the step).
     */
    replays?: number;
    /** Their seed series: the brain's from the refresh's game time (`bladeburnerReplaySeedOf`). */
    replaySeed?: number;
    /** The least step rate ratio measured (`BLADEBURNER_REPLAY_LEAST_RATIO` absent; 0, the rule before #423's ruling 8). */
    replayLeastRatio?: number;
    /** The most climb step rate ratio measured (`BLADEBURNER_REPLAY_MOST_RATIO` absent; Infinity, none). */
    replayMostRatio?: number;
  },
): BlackOpsGrownTime {
  // #411: each contract's and operation's chance at the true population, recovered from the next one's range read.
  const { input, ratio: populationRatio } = bladeburnerPricedInput(read, { next, chanceRead });
  let state = bladeburnerGrowthStart(input, { rank, points, combat });
  let earned = 0;
  let seconds = 0;
  let solves = 0;
  const path: { rank: number; seconds: number }[] = [{ rank, seconds: 0 }];
  // #423: the route's timeline for its replays (with the cities read): its segments, each path point's segment (−1: a
  // point B5's stock clipped, kept), and each Black Op's climb and attempts segments.
  const timeline: BladeburnerRouteTimeline | null =
    state.drift === undefined
      ? null
      : {
          start: state.drift.state,
          reference: state.drift.reference,
          rankMultiplier: input.rankMultiplier,
          segments: [],
        };
  const pointSegment: number[] = [-1];
  const opSegments: { climb: number[]; attempts: number }[] = [];
  const partsOf = (mix: ReturnType<typeof bladeburnerTailMix>): BladeburnerRoutePart[] =>
    mix.work.map((part) => ({
      action: bladeburnerLevelledAction(part.type, part.name) as BladeburnerLevelledAction,
      level: part.level,
      chance: part.chance,
      perSecond: part.attemptsPerSecond,
    }));
  // The tail at a state: its grown input and the mix there, each chance priced over `horizon` s ahead (#418), in
  // `BLADEBURNER_GROWTH_DRIFT_CHUNKS` chunks.
  const tailAt = (at: BladeburnerGrowthState, horizon = 0) => {
    const grown = bladeburnerGrownInput(input, combat, at, horizon);
    solves += 1;
    const priced =
      grown.drift === undefined
        ? grown
        : { ...grown, drift: { ...grown.drift, chunks: BLADEBURNER_GROWTH_DRIFT_CHUNKS } };
    return { grown, mix: bladeburnerTailMix(priced) };
  };
  // Work for `dt` game seconds at a mix: its experience and successes accrued, and (#418) the cities moved by its
  // attempts, the time and Diplomacy (its time in the mix's own, priced), the brain's city chosen again (B4's).
  const work = (at: BladeburnerGrowthState, mix: ReturnType<typeof bladeburnerTailMix>, dt: number) => {
    const exp = { ...at.exp };
    const successes = { ...at.successes };
    const parts: BladeburnerDriftPart[] = [];
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
      parts.push({ action, chance: part.chance, attempts: part.attemptsPerSecond * dt });
    }
    if (at.drift === undefined || !(dt > 0)) return { ...at, exp, successes };
    const city = at.drift.state.cities[at.drift.state.worked] as BladeburnerDriftCity;
    const moved = bladeburnerDriftPath(at.drift.state, city, parts, dt, {
      charisma: (input.forecast ?? input.person).skills.charisma,
      moves: true,
      chunks: BLADEBURNER_GROWTH_DRIFT_CHUNKS,
    });
    return { ...at, exp, successes, drift: { state: moved.state, reference: at.drift.reference } };
  };
  // The points unspent at a state, spent by B3's rule there, as the brain runs it: since #415 at the estimate's own
  // pricing, the true population's chances (the brain's rule input is `bladeburnerPricedInput`'s too), so the estimate
  // credits exactly the purchases the rule makes (#411's low-end exception gone with the rule's low end).
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
  // The hospital's money a second at the reading (#418): the mix's failures a second, each its mean bill.
  const { hospital } = input;
  const moneyLostPerSecond =
    hospital === undefined
      ? null
      : first.mix.work.reduce((sum, part) => {
          const action = bladeburnerLevelledAction(part.type, part.name) as BladeburnerLevelledAction;
          const bill = hospitalCostPerFailure(actionHpLoss(action, part.level), hospital.hpMax, hospital.money);
          return sum + part.attemptsPerSecond * (1 - part.chance) * bill;
        }, 0);
  // The points read unspent, spent first (B3's, within a reading of coming): ρ now is the reading's, before them.
  state = spend(state);
  const rateNow = first.mix.rate;
  // The drift's horizon a step (#418): the step's rank over the rate a step before (the first, the reading's).
  let lastRate = rateNow;
  const left = BLADEBURNER_BLACK_OPS.slice(BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === next.name));
  const steps: BlackOpsGrownStep[] = [];
  for (const [index, op] of left.entries()) {
    // The climb to its rank, step by step.
    const startSeconds = seconds;
    const segmentsBefore = timeline?.segments.length ?? 0;
    const pointsBefore = path.length;
    const segmentsOf: { climb: number[]; attempts: number } = { climb: [], attempts: -1 };
    while (state.rank < op.rank && Number.isFinite(seconds)) {
      const by = Math.min(op.rank - state.rank, Math.max(leastStep, fraction * state.rank));
      const { mix } = tailAt(state, state.drift !== undefined && lastRate > 0 ? by / lastRate : 0);
      if (!(mix.rate > 0)) {
        seconds = Number.POSITIVE_INFINITY;
        break;
      }
      lastRate = mix.rate;
      const dt = by / mix.rate;
      if (timeline !== null && state.drift !== undefined) {
        segmentsOf.climb.push(
          timeline.segments.push({
            kind: "climb",
            seconds,
            dt,
            by,
            rate: mix.rate,
            parts: partsOf(mix),
            state: state.drift.state,
          }) - 1,
        );
      }
      seconds += dt;
      state = rise(work(state, mix, dt), by);
      path.push({ rank: state.rank, seconds });
      pointSegment.push(timeline === null ? -1 : timeline.segments.length - 1);
    }
    let toRankSeconds = seconds - startSeconds;
    if (index === 0 && firstToRankSeconds !== null && firstToRankSeconds < toRankSeconds) {
      seconds = startSeconds + firstToRankSeconds;
      toRankSeconds = firstToRankSeconds;
      for (const point of path) point.seconds = Math.min(point.seconds, seconds);
      // #423: B5's stock, not a grown route: its stretch a fixed time in the replays, its points kept as clipped.
      if (timeline !== null) {
        timeline.segments.splice(segmentsBefore);
        segmentsOf.climb = [timeline.segments.push({ kind: "fixed", seconds: startSeconds, span: toRankSeconds }) - 1];
        for (let i = pointsBefore; i < pointSegment.length; i++) pointSegment[i] = -1;
      }
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
      // Its formula (#411): a Black Op's chance doesn't depend on the population (`Actions/BlackOperation.ts:55-61`),
      // so its mean over any span the range stands for is the formula's.
      const chance = Math.min(1, formula);
      const rebuild = mix.rate > 0 ? loss / mix.rate : Number.POSITIVE_INFINITY;
      return { grown, mix, chance, seconds: blackOpSeconds(op, grown.person, mults), rebuild };
    };
    const firstAttempt = attemptAt(state);
    let current = firstAttempt;
    let at = state;
    // #423: each expected rebuild's mix, the cities it was solved at, for the replays.
    let solvedAt = state;
    const works: { dt: number; rate: number; parts: BladeburnerRoutePart[]; state: BladeburnerDriftState }[] = [];
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
      if (timeline !== null && solvedAt.drift !== undefined) {
        works.push({ dt: rebuild, rate: current.mix.rate, parts: partsOf(current.mix), state: solvedAt.drift.state });
      }
      at = work(at, current.mix, rebuild);
      along.push(at);
      // Solved again each of the first 8, then at each quarter more made (the state moves slowly by then).
      if (made + 1 >= solveAt) {
        current = attemptAt(at);
        solvedAt = at;
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
    // #423: its attempts' stretch, the expected failures' rebuilds back to back from its start (the state the route
    // takes on is the round(failures)-th's, below).
    if (timeline !== null) {
      segmentsOf.attempts =
        timeline.segments.push({
          kind: "blackOp",
          seconds,
          span: attemptsSeconds,
          works: works.slice(0, Math.min(works.length, Math.round(failures))),
        }) - 1;
    }
    opSegments.push(segmentsOf);
    seconds += attemptsSeconds;
    if (!Number.isFinite(seconds)) break;
    // The state its expected failures' rebuilds leave (the path's, at their mean), then a success's mean from its rank.
    state = along[Math.min(along.length - 1, Math.round(failures))] as BladeburnerGrowthState;
    state = rise(state, gain);
    path.push({ rank: state.rank, seconds });
    pointSegment.push(timeline === null ? -1 : segmentsOf.attempts);
  }
  // #423: the route replayed under the game's draws (./bladeburner-replays.ts) and re-priced, first-order: the figure,
  // the path's points and each Black Op's terms their means over the replays; the mean path's kept beside.
  const meanPathSeconds = seconds;
  let replayed: BladeburnerRouteReplays | null = null;
  let declined: string | null = null;
  if (timeline !== null && replays > 0 && Number.isFinite(seconds) && steps.length > 0) {
    replayed = bladeburnerReplayRoute(timeline, {
      replays,
      seed: replaySeed,
      ...(replayLeastRatio === undefined ? {} : { leastRatio: replayLeastRatio }),
      ...(replayMostRatio === undefined ? {} : { mostRatio: replayMostRatio }),
    });
    declined = bladeburnerReplayDeclined(replayed);
  }
  if (replayed !== null && declined === null) {
    const each = replayed.segmentSeconds;
    const cumulative: number[] = [];
    let sum = 0;
    for (const x of each) {
      sum += x;
      cumulative.push(sum);
    }
    for (const [i, point] of path.entries()) {
      const s = pointSegment[i] ?? -1;
      if (s >= 0) point.seconds = cumulative[s] as number;
    }
    for (const [k, step] of steps.entries()) {
      const own = opSegments[k];
      if (own === undefined) continue;
      step.toRankSeconds = own.climb.reduce((total, s) => total + (each[s] as number), 0);
      if (own.attempts >= 0) step.attemptsSeconds = each[own.attempts] as number;
    }
    seconds = replayed.seconds;
  }
  const end = state.drift === undefined ? null : state.drift.state.cities[state.drift.state.worked];
  const result: BlackOpsGrownTime = {
    steps,
    seconds,
    meanPathSeconds,
    secondsError: replayed !== null && declined === null ? replayed.error : 0,
    replays:
      replayed === null
        ? null
        : {
            count: replayed.replays,
            seed: replayed.seed,
            times: replayed.times,
            seconds: replayed.seconds,
            error: replayed.error,
            fallbackSteps: replayed.fallbackSteps,
            replaysWithFallback: replayed.replaysWithFallback,
            leastRatios: replayed.leastRatios,
            meanPathRebuilds: replayed.meanPathRebuilds,
            used: declined === null,
            declined,
          },
    rate: rateNow,
    path,
    solves,
    populationRatio,
    moneyLostPerSecond,
    drift:
      end == null || state.drift === undefined
        ? null
        : {
            cities: state.drift.state.cities.map((city) => ({ ...city })),
            worked: end.name,
            populationRatio:
              state.drift.reference.population > 0 ? end.population / state.drift.reference.population : 1,
          },
  };
  // The timeline its replays ran, for #423's checks (kept beside the result, out of what it serializes).
  if (timeline !== null) ROUTE_TIMELINES.set(result, timeline);
  return result;
}

/** Each grown result's route timeline (#423's checks: the engine against the replays at the states they reach). */
const ROUTE_TIMELINES = new WeakMap<BlackOpsGrownTime, BladeburnerRouteTimeline>();

/** The timeline a grown result's replays ran (`blackOpsRouteGrownEstimate`'s, with the cities read), or null. */
export function blackOpsRouteTimelineOf(result: BlackOpsGrownTime): BladeburnerRouteTimeline | null {
  return ROUTE_TIMELINES.get(result) ?? null;
}

/** The combat stats' experience multipliers of `combat`. */
function expMultsOf(combat: CombatPerson): Record<CombatStat, number> {
  return Object.fromEntries(COMBAT_STATS.map((stat) => [stat, combat.mults[`${stat}_exp`]])) as Record<
    CombatStat,
    number
  >;
}
