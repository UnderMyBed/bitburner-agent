/**
 * Bladeburner (#359), slice B2 (#375): the actions and the stamina. The game's figures for contracts, operations and
 * the general actions, its formulas for success, time, rank, money and stamina, and the rule's choice by rank a second.
 * Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **Success** (`Actions/Action.ts:169-196`): min(1, competence / difficulty). Competence is the sum over the seven
 *   stats of weight × level^decay (a combat stat's level times its skill multiplier, `Bladeburner.ts:759-774`), times
 *   the intelligence bonus 1 + 0.75·int^0.8/600 (`PersonObjects/formulas/intelligence.ts`), the stamina penalty
 *   min(1, stamina / (½ max)) (`Bladeburner.ts:167-169`), an operation's team bonus (teamCount + 1)^0.05
 *   (`Actions/Operation.ts:96-98`), the population's (pop / 1e9)^0.7 (`Action.ts:88-92`), the skills' and the
 *   augmentations' `bladeburner_success_chance`. Difficulty is base × fac^(level − 1) (`Actions/LevelableAction.ts:
 *   58-64`), times √(1 + chaos − 50) over 50 chaos (`Action.ts:94-103`). Raid is 0 with no communities
 *   (`Actions/Operation.ts:63-68`).
 * - **The estimate** (`Action.ts:144-167`): the game's range is the chance at the true population (`real`) and at its
 *   estimate (`est`), real ± |real − est|, the low end times pop/popEst below 1, the high end above; each clamped to
 *   [0, 1]. The NS API's `getActionEstimatedSuccessChance` is this range (`NetscriptFunctions/Bladeburner.ts:138-143`).
 * - **Time** (`Action.ts:105-122`): ⌈max(1, difficulty/10 × the skills' time multiplier / statFac)⌉ s, statFac
 *   ½(agi^0.04 + dex^0.035 + agi/10,000 + dex/10,000) on the effective levels; the general actions' are fixed
 *   (`data/GeneralActions.ts`): Training and Field Analysis 30 s, Diplomacy, the Regeneration Chamber and Incite
 *   Violence 60 s.
 * - **Rank** (`Formulas.ts:9-44`): a success gains rankGain × rewardFac^(level − 1) × the BitNode's
 *   `BladeburnerRank`, a failure loses rankLoss × rewardFac^(level − 1), not BitNode-scaled; each ±10%, uniform
 *   (`Bladeburner.ts:951`, `:980`, `utils/helpers/addOffset.ts`). Field Analysis gains 0.1 × `BladeburnerRank`, no
 *   offset (`:1136-1140`). The rank never goes below 0 (`:1271-1274`).
 * - **Money** (contracts only, `Bladeburner.ts:936-943`): 250k × rewardFac^(level − 1) × the skills' money multiplier.
 * - **Stamina:** each contract or operation, success or not, costs 0.285 × diffMult, diffMult = difficulty^0.28 +
 *   difficulty/650 (`:913-927`; `data/Constants.ts`). Training costs 0.1425 and adds 0.04 max stamina (`:1094-1105`);
 *   the Regeneration Chamber gives 1% of the max and 2 HP (`:1199-1204`). The max is (agi^0.8 + bonus) × the skills'
 *   × `bladeburner_max_stamina` (`:1329-1345`); it regains (0.0085 + max/70,000) × agi^0.17 × the skills' ×
 *   `bladeburner_stamina_gain` a second, whatever the action (`:1319-1327`, `:1382-1385`). At 0 the action stops
 *   (`:1370-1374`).
 * - **HP:** a failure costs ⌈hpLoss × diffMult ± 10%⌉ (`:983-991`); at 0 HP the hospital refills it for up to 10% of
 *   the money (`Hospital/Hospital.ts:4-10`, `PersonObjects/Player/PlayerObjectGeneralMethods.ts:266-290`).
 * - **Counts:** each contract and operation grows by its growth (a random tenth over its range) / 480 a second
 *   (`:1387-1393`), and each attempt uses one (`:933`, `:976`). Under 1 it can't start, and one under way stops
 *   (`Actions/LevelableAction.ts:44-47`, `:1299-1301`).
 * - **Levels:** level M + 1 opens after ⌈½·M·(2b + M − 1)⌉ successes, b 3 for contracts and 2.5 for operations
 *   (`Actions/LevelableAction.ts:49-56`, `data/Constants.ts`). An action set to auto-level goes to its max after
 *   each attempt (`:1006-1008`), so the rule turns that off for the level it sets.
 * - **Training's experience** is 30 × `mults.<stat>_exp` a stat (`:1096-1099`), which `gainStats` multiplies by the
 *   same multiplier again (`PersonObjects/Person.ts:192-198`): an upstream quirk, × mult², which core keeps.
 * - **Bonus time:** a second's tick takes up to 5 seconds' stored cycles (`:1376-1380`), so the actions run up to 5
 *   times as fast while there is bonus time (`getBonusTime`, `NetscriptFunctions/Bladeburner.ts:367-370`).
 * - **One focus:** any other work stops the action, and starting one stops the work (`:178-180`, `:1356-1368`).
 * - **The skills** (B3, #379; ./bladeburner-skills.ts): the success skills on competence, Reaper and Evasive System on
 *   the combat stats it, the time and the stamina read (`getEffectiveSkillLevel`, `:759-774`), Overclock on the time,
 *   Cyber's Edge on the max stamina and its regain; each at 1 with no levels (`getSkillMult`'s default, `:755-757`).
 * - **The city** (B4, #383; ./bladeburner-cities.ts): its population and chaos are in the range read; the forecast in
 *   another city, or at another chaos, scales it (`chooseBladeburnerAction`'s `city`).
 * The Black Ops are B5's (#392, ./bladeburner-black-ops.ts). Left out, and labelled: teams (an operation's team bonus at
 * 0 members: 1); the random events, but for their mean on the drift (#418, ./bladeburner-drift.ts).
 */

import { BLADEBURNER_CONSTANTS, chaosDifficultyFactor } from "./bladeburner-constants.ts";
import {
  type BladeburnerDriftCity,
  type BladeburnerDriftResult,
  bladeburnerDriftCurveAt,
  bladeburnerDriftPath,
  bladeburnerDriftStart,
  hospitalCostPerFailure,
} from "./bladeburner-drift.ts";
import {
  type BladeburnerSkillLevels,
  type BladeburnerSkillMults,
  type BladeburnerSkillPlan,
  bladeburnerSkillMultsOf,
  NO_BLADEBURNER_SKILLS,
  planBladeburnerSkills,
} from "./bladeburner-skills.ts";
import {
  BLADEBURNER_TARGET_CELLS,
  type BladeburnerRankSource,
  type BladeburnerRankStep,
  bladeburnerAttemptsInCount,
  bladeburnerCycleStep,
  bladeburnerRestStep,
  bladeburnerSecondsToRank,
  bladeburnerSecondsToRankAtLeast,
  bladeburnerStepRise,
  bladeburnerSustainableMix,
  bladeburnerSustainableRate,
} from "./bladeburner-targets.ts";

/** A contract's or operation's type, as the NS API names it (`Bladeburner/Enums.ts`). */
export type BladeburnerLevelledType = "Contracts" | "Operations";
/** Any action type the rule sends: those, or a general action. */
export type BladeburnerActionType = BladeburnerLevelledType | "General";

/** The seven stats an action's competence weighs, in the game's order (`PersonObjects/Skills.ts`). */
export const BLADEBURNER_PERSON_STATS = [
  "hacking",
  "strength",
  "defense",
  "dexterity",
  "agility",
  "charisma",
  "intelligence",
] as const;
export type BladeburnerPersonStat = (typeof BLADEBURNER_PERSON_STATS)[number];

/** A contract or operation, as `data/Contracts.ts` and `data/Operations.ts` define it. */
export interface BladeburnerLevelledAction {
  type: BladeburnerLevelledType;
  name: string;
  baseDifficulty: number;
  difficultyFac: number;
  rewardFac: number;
  rankGain: number;
  rankLoss: number;
  hpLoss: number;
  weights: Record<BladeburnerPersonStat, number>;
  decays: Record<BladeburnerPersonStat, number>;
  isStealth: boolean;
  isKill: boolean;
  /** Its count's growth over 480 s: a random integer in this range, over 10. */
  growth: readonly [number, number];
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

/** The three contracts (`data/Contracts.ts:8-109`): rankLoss 0 for all (the default, `Actions/Action.ts:36`). */
export const BLADEBURNER_CONTRACTS: readonly BladeburnerLevelledAction[] = [
  {
    type: "Contracts",
    name: "Tracking",
    baseDifficulty: 125,
    difficultyFac: 1.02,
    rewardFac: 1.041,
    rankGain: 0.3,
    rankLoss: 0,
    hpLoss: 0.5,
    weights: stats(0, 0.05, 0.05, 0.35, 0.35, 0.1, 0.05),
    decays: stats(0, 0.91, 0.91, 0.91, 0.91, 0.9, 1),
    isStealth: true,
    isKill: false,
    growth: [5, 75],
  },
  {
    type: "Contracts",
    name: "Bounty Hunter",
    baseDifficulty: 250,
    difficultyFac: 1.04,
    rewardFac: 1.085,
    rankGain: 0.9,
    rankLoss: 0,
    hpLoss: 1,
    weights: stats(0, 0.15, 0.15, 0.25, 0.25, 0.1, 0.1),
    decays: stats(0, 0.91, 0.91, 0.91, 0.91, 0.8, 0.9),
    isStealth: false,
    isKill: true,
    growth: [5, 75],
  },
  {
    type: "Contracts",
    name: "Retirement",
    baseDifficulty: 200,
    difficultyFac: 1.03,
    rewardFac: 1.065,
    rankGain: 0.6,
    rankLoss: 0,
    hpLoss: 1,
    weights: stats(0, 0.2, 0.2, 0.2, 0.2, 0.1, 0.1),
    decays: stats(0, 0.91, 0.91, 0.91, 0.91, 0.8, 0.9),
    isStealth: false,
    isKill: true,
    growth: [5, 75],
  },
];

/** The six operations (`data/Operations.ts:9-226`): Investigation's hpLoss 0 (the default). */
export const BLADEBURNER_OPERATIONS: readonly BladeburnerLevelledAction[] = [
  {
    type: "Operations",
    name: "Investigation",
    baseDifficulty: 400,
    difficultyFac: 1.03,
    rewardFac: 1.07,
    rankGain: 2.2,
    rankLoss: 0.2,
    hpLoss: 0,
    weights: stats(0.25, 0.05, 0.05, 0.2, 0.1, 0.25, 0.1),
    decays: stats(0.85, 0.9, 0.9, 0.9, 0.9, 0.7, 0.9),
    isStealth: true,
    isKill: false,
    growth: [10, 40],
  },
  {
    type: "Operations",
    name: "Undercover Operation",
    baseDifficulty: 500,
    difficultyFac: 1.04,
    rewardFac: 1.09,
    rankGain: 4.4,
    rankLoss: 0.4,
    hpLoss: 2,
    weights: stats(0.2, 0.05, 0.05, 0.2, 0.2, 0.2, 0.1),
    decays: stats(0.8, 0.9, 0.9, 0.9, 0.9, 0.7, 0.9),
    isStealth: true,
    isKill: false,
    growth: [10, 40],
  },
  {
    type: "Operations",
    name: "Sting Operation",
    baseDifficulty: 650,
    difficultyFac: 1.04,
    rewardFac: 1.095,
    rankGain: 5.5,
    rankLoss: 0.5,
    hpLoss: 2.5,
    weights: stats(0.25, 0.05, 0.05, 0.25, 0.1, 0.2, 0.1),
    decays: stats(0.8, 0.85, 0.85, 0.85, 0.85, 0.7, 0.9),
    isStealth: true,
    isKill: false,
    growth: [3, 40],
  },
  {
    type: "Operations",
    name: "Raid",
    baseDifficulty: 800,
    difficultyFac: 1.045,
    rewardFac: 1.1,
    rankGain: 55,
    rankLoss: 2.5,
    hpLoss: 50,
    weights: stats(0.1, 0.2, 0.2, 0.2, 0.2, 0, 0.1),
    decays: stats(0.7, 0.8, 0.8, 0.8, 0.8, 0, 0.9),
    isStealth: false,
    isKill: true,
    growth: [2, 40],
  },
  {
    type: "Operations",
    name: "Stealth Retirement Operation",
    baseDifficulty: 1000,
    difficultyFac: 1.05,
    rewardFac: 1.11,
    rankGain: 22,
    rankLoss: 2,
    hpLoss: 10,
    weights: stats(0.1, 0.1, 0.1, 0.3, 0.3, 0, 0.1),
    decays: stats(0.7, 0.8, 0.8, 0.8, 0.8, 0, 0.9),
    isStealth: true,
    isKill: true,
    growth: [1, 20],
  },
  {
    type: "Operations",
    name: "Assassination",
    baseDifficulty: 1500,
    difficultyFac: 1.06,
    rewardFac: 1.14,
    rankGain: 44,
    rankLoss: 4,
    hpLoss: 5,
    weights: stats(0.1, 0.1, 0.1, 0.3, 0.3, 0, 0.1),
    decays: stats(0.6, 0.8, 0.8, 0.8, 0.8, 0, 0.8),
    isStealth: true,
    isKill: true,
    growth: [1, 20],
  },
];

/** Every contract and operation, contracts first, each in the game's order. */
export const BLADEBURNER_LEVELLED_ACTIONS: readonly BladeburnerLevelledAction[] = [
  ...BLADEBURNER_CONTRACTS,
  ...BLADEBURNER_OPERATIONS,
];

/** The contract or operation by type and name, or null. */
export function bladeburnerLevelledAction(type: string, name: string): BladeburnerLevelledAction | null {
  return BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.type === type && each.name === name) ?? null;
}

/** The general actions the rule rests with (`data/GeneralActions.ts`, `Bladeburner/Enums.ts`). */
export const FIELD_ANALYSIS = "Field Analysis";
export const REGENERATION_CHAMBER = "Hyperbolic Regeneration Chamber";
export const BLADEBURNER_TRAINING = "Training";
export type BladeburnerRestName = typeof FIELD_ANALYSIS | typeof REGENERATION_CHAMBER | typeof BLADEBURNER_TRAINING;
/** The rests' times (`data/GeneralActions.ts:8`, `:15`, `:47`). */
export const BLADEBURNER_REST_SECONDS: Record<BladeburnerRestName, number> = {
  [FIELD_ANALYSIS]: 30,
  [REGENERATION_CHAMBER]: 60,
  [BLADEBURNER_TRAINING]: 30,
};

export { BLADEBURNER_CONSTANTS, chaosDifficultyFactor } from "./bladeburner-constants.ts";

/** The BitNode's `BladeburnerRank`: BN7's 0.6 (`BitNode/BitNode.tsx:756`), BN6's the default 1. Null elsewhere. */
export function bladeburnerRankMultiplierOf(bitNode: number): number | null {
  return bitNode === 6 ? 1 : bitNode === 7 ? 0.6 : null;
}

/** What core reads of the player (`getPlayer()`): every stat's level, and its multipliers. */
export interface BladeburnerPerson {
  skills: Record<BladeburnerPersonStat, number>;
  mults: {
    bladeburner_success_chance: number;
    bladeburner_max_stamina: number;
    bladeburner_stamina_gain: number;
  } & Partial<Record<`${BladeburnerPersonStat}_exp`, number>>;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fieldOf = (record: unknown, key: string): unknown =>
  typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined;

/** A medium snapshot's `player` as core's Bladeburner reads it, or null where a figure isn't a number. */
export function bladeburnerPersonOf(player: unknown): BladeburnerPerson | null {
  const skills = fieldOf(player, "skills");
  const mults = fieldOf(player, "mults");
  const person = {
    skills: Object.fromEntries(BLADEBURNER_PERSON_STATS.map((stat) => [stat, fieldOf(skills, stat)])),
    mults: Object.fromEntries(
      [
        "bladeburner_success_chance",
        "bladeburner_max_stamina",
        "bladeburner_stamina_gain",
        ...BLADEBURNER_PERSON_STATS.map((stat) => `${stat}_exp`),
      ].map((key) => [key, fieldOf(mults, key)]),
    ),
  };
  const needed = [
    ...Object.values(person.skills),
    person.mults.bladeburner_success_chance,
    person.mults.bladeburner_max_stamina,
    person.mults.bladeburner_stamina_gain,
  ];
  return needed.every(isNumber) ? (person as unknown as BladeburnerPerson) : null;
}

/** An action's difficulty at `level`: base × fac^(level − 1) (`Actions/LevelableAction.ts:58-64`). */
export function actionDifficulty(action: BladeburnerLevelledAction, level: number): number {
  return action.baseDifficulty * action.difficultyFac ** (level - 1);
}

/** The population's factor on competence: (pop / 1e9)^0.7 (`Actions/Action.ts:88-92`). */
export function populationSuccessFactor(population: number): number {
  return (population / BLADEBURNER_CONSTANTS.populationThreshold) ** BLADEBURNER_CONSTANTS.populationExponent;
}

/** The stamina penalty: min(1, stamina / (½ max)) (`Bladeburner.ts:167-169`). */
export function staminaPenalty(stamina: number, maxStamina: number): number {
  return Math.min(1, stamina / (0.5 * maxStamina));
}

/** The city as an action's success reads it: its population (true, or the estimate), communities and chaos. */
export interface BladeburnerCityFigures {
  population: number;
  communities: number;
  chaos: number;
}

/**
 * A stat's level as Bladeburner reads it (`getEffectiveSkillLevel`, `Bladeburner.ts:759-774`): a combat stat's or
 * charisma's times its skill multiplier (Reaper's, Evasive System's), the others as they are.
 */
export function effectiveLevel(
  person: BladeburnerPerson,
  stat: BladeburnerPersonStat,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  const level = person.skills[stat];
  switch (stat) {
    case "strength":
      return level * skills.effStrength;
    case "defense":
      return level * skills.effDefense;
    case "dexterity":
      return level * skills.effDexterity;
    case "agility":
      return level * skills.effAgility;
    case "charisma":
      return level * skills.effCharisma;
    default:
      return level;
  }
}

/**
 * The part of an action's competence the skills move (`Actions/Action.ts:174-187`): the stats' weighted levels, at
 * their effective levels, times the success skills' multipliers that apply to it (all; its type's, `Actions/
 * Contract.ts:30-32`, `Actions/Operation.ts:92-94`, a Black Op's the operations', `Actions/BlackOperation.ts:69`;
 * stealth's; killing's). The rest (intelligence, stamina, team,
 * population, augmentations) is the same at any skill levels.
 */
export function actionSkillCompetence(
  action: Pick<BladeburnerLevelledAction, "weights" | "decays" | "isStealth" | "isKill"> & { type: string },
  person: BladeburnerPerson,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  let competence = 0;
  for (const stat of BLADEBURNER_PERSON_STATS) {
    competence += action.weights[stat] * effectiveLevel(person, stat, skills) ** action.decays[stat];
  }
  competence *= skills.successAll;
  competence *= action.type === "Contracts" ? skills.successContract : skills.successOperation;
  if (action.isStealth) competence *= skills.successStealth;
  if (action.isKill) competence *= skills.successKill;
  return competence;
}

/**
 * The chance of `action` at `level` (`Actions/Action.ts:169-196`), at a city's population (the true one for the real
 * chance, the estimate for the estimated), with the stamina penalty and the skills' multipliers (none: all 1). No team:
 * its bonus 1 (labelled). Raid is 0 with no communities (`Actions/Operation.ts:63-68`).
 */
export function actionSuccessChance(
  action: BladeburnerLevelledAction,
  level: number,
  person: BladeburnerPerson,
  {
    city,
    penalty,
    skills = NO_BLADEBURNER_SKILLS,
  }: { city: BladeburnerCityFigures; penalty: number; skills?: BladeburnerSkillMults },
): number {
  if (action.name === "Raid" && city.communities <= 0) return 0;
  let difficulty = actionDifficulty(action, level);
  let competence = actionSkillCompetence(action, person, skills);
  // `calculateIntelligenceBonus(int, 0.75)` (`PersonObjects/formulas/intelligence.ts`).
  competence *= 1 + (0.75 * person.skills.intelligence ** 0.8) / 600;
  competence *= penalty;
  competence *= populationSuccessFactor(city.population);
  difficulty *= chaosDifficultyFactor(city.chaos);
  competence *= person.mults.bladeburner_success_chance;
  return Math.min(1, competence / difficulty);
}

/**
 * The game's estimate's range for an action (`Actions/Action.ts:144-167`): the chance at the true population and at
 * its estimate, real ± |real − est|, the low end times pop/popEst below 1, the high end above; each in [0, 1].
 */
export function actionSuccessRange(real: number, est: number, population: number, estimate: number): [number, number] {
  const clamp = (x: number) => Math.max(0, Math.min(x, 1));
  const diff = Math.abs(real - est);
  let low = real - diff;
  let high = real + diff;
  let ratio = population / estimate;
  if (Number.isNaN(ratio)) ratio = 0;
  if (ratio < 1) low *= ratio;
  else high *= Math.max(Math.min(ratio, Number.MAX_VALUE), -Number.MAX_VALUE);
  return [clamp(low), clamp(high)];
}

/**
 * pop/popEst, the true population over its estimate, from a Black Op's range read (#411, the coordinator's ruling 4):
 * a Black Op's chance has no population factor (`Actions/BlackOperation.ts:55-61`), so the game's range is its chance
 * at one end and that × pop/popEst at the other (`Actions/Action.ts:144-167`: est = real, the low end × the ratio
 * under 1, the high end over it). The ratio is the read ends' own (low/high under 1, high/low over), so a person read
 * apart from the range (the player and the Bladeburner reading are different workers, up to a reading apart: a level
 * between, #414's round 2) moves nothing; `formula`, the chance at the person (core's `blackOpSuccessChance`, its
 * stamina's penalty in), only picks which end is the formula's, the nearer in log ratio. Null where it can't be
 * recovered: an end 0 or the formula 0, or the scaled end clipped at 1 (a ratio over 1 with the high end at 1, or both
 * ends 1: only a bound).
 */
export function populationRatioOfBlackOpRange([low, high]: readonly [number, number], formula: number): number | null {
  if (!(formula > 0) || !(low > 0) || !(high >= low)) return null;
  if (low === high) return high >= 1 ? null : 1;
  const formulaHigh = Math.abs(Math.log(high / formula)) <= Math.abs(Math.log(low / formula));
  if (formulaHigh) return low / high;
  return high >= 1 ? null : high / low;
}

/**
 * A contract's or operation's chance at the true population (#411's ruling 4) from its range read and pop/popEst
 * `ratio` (`Actions/Action.ts:144-167`, `:169-196`): its chance at the estimate is the true one × ratio^−0.7 (the
 * population factor, `:88-92`; chaos and the rest alike in both), each clipped at 1. Under 1 (an overcount), the high
 * end is the estimate's chance: the true one high × ratio^0.7, or where that clips at 1, (low/ratio + 1)/2. Over 1 (an
 * undercount), the low end is the estimate's: low × ratio^0.7, at most 1. Null where the end it needs clips at 0.
 */
export function actionChanceAtRatio([low, high]: readonly [number, number], ratio: number): number | null {
  if (ratio === 1) return low;
  const factor = ratio ** BLADEBURNER_CONSTANTS.populationExponent;
  if (ratio < 1) {
    if (high < 1) return high * factor;
    return low > 0 ? Math.min(1, (low / ratio + 1) / 2) : null;
  }
  return Math.min(1, low * factor);
}

/** The estimate's spread at a start (`Bladeburner/City.ts:19-23`): the estimate the true × U, U uniform on [0.5, 1.5]. */
export const POPULATION_ESTIMATE_SPREAD: readonly [number, number] = [0.5, 1.5];

/**
 * A contract's or operation's expected chance where pop/popEst isn't recovered (#411's ruling 4): over the estimate's
 * own spread, the true population the estimate over U (ratio 1/U), U uniform on `POPULATION_ESTIMATE_SPREAD`, each
 * ratio's chance from the range read (`actionChanceAtRatio`), by the midpoint rule on 200 steps; the low end where none
 * is recovered; each at most 1. Labelled: the spread is a start's (Field Analysis narrows it, `Bladeburner.ts:1124-1143`),
 * and a range read is one ratio's, so the mean errs by where that ratio sits in the spread: optimistic at an undercount,
 * pessimistic at an overcount (#414's round 2, a chance of 0.2: ×1.58 at U = 0.5, ×1.24 at 0.7, ×0.87 at 1.42).
 */
export function actionChanceOverSpread(range: readonly [number, number]): number {
  const [from, to] = POPULATION_ESTIMATE_SPREAD;
  const steps = 200;
  let sum = 0;
  let count = 0;
  for (let step = 0; step < steps; step++) {
    const chance = actionChanceAtRatio(range, 1 / (from + ((step + 0.5) * (to - from)) / steps));
    if (chance === null) continue;
    sum += chance;
    count++;
  }
  return count === 0 ? range[0] : sum / count;
}

/** statFac: ½(agi^0.04 + dex^0.035 + agi/10,000 + dex/10,000), at the effective levels (`Actions/Action.ts:110-117`). */
export function actionStatFactor(person: BladeburnerPerson, skills: BladeburnerSkillMults): number {
  const c = BLADEBURNER_CONSTANTS;
  const agility = effectiveLevel(person, "agility", skills);
  const dexterity = effectiveLevel(person, "dexterity", skills);
  return (
    0.5 *
    (agility ** c.effAgiExponentialFactor +
      dexterity ** c.effDexExponentialFactor +
      agility / c.effAgiLinearFactor +
      dexterity / c.effDexLinearFactor)
  );
}

/**
 * A contract's or operation's time, in seconds: ⌈max(1, difficulty/10 × the skills' time multiplier (Overclock's) /
 * statFac)⌉ (`Actions/Action.ts:105-122`).
 */
export function actionSeconds(
  action: BladeburnerLevelledAction,
  level: number,
  person: BladeburnerPerson,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  const baseTime = actionDifficulty(action, level) / BLADEBURNER_CONSTANTS.difficultyToTimeFactor;
  return Math.ceil(Math.max(1, (baseTime * skills.actionTime) / actionStatFactor(person, skills)));
}

/** A success's rank: rankGain × rewardFac^(level − 1) × `BladeburnerRank`, ±10% (`Formulas.ts:9-28`). */
export function actionRankGain(action: BladeburnerLevelledAction, level: number, rankMultiplier: number): number {
  return action.rankGain * action.rewardFac ** (level - 1) * rankMultiplier;
}

/** A failure's rank lost: rankLoss × rewardFac^(level − 1), not BitNode-scaled, ±10% (`Formulas.ts:30-44`). */
export function actionRankLoss(action: BladeburnerLevelledAction, level: number): number {
  return action.rankLoss * action.rewardFac ** (level - 1);
}

/** A contract's money on success: 250k × rewardFac^(level − 1) (`Bladeburner.ts:936-943`); an operation's 0. */
export function actionMoney(action: BladeburnerLevelledAction, level: number): number {
  return action.type === "Contracts"
    ? BLADEBURNER_CONSTANTS.contractBaseMoneyGain * action.rewardFac ** (level - 1)
    : 0;
}

/** diffMult: difficulty^0.28 + difficulty/650 (`Bladeburner.ts:915-918`). */
export function difficultyMultiplier(difficulty: number): number {
  const c = BLADEBURNER_CONSTANTS;
  return difficulty ** c.diffMultExponentialFactor + difficulty / c.diffMultLinearFactor;
}

/** An attempt's stamina, success or not: 0.285 × diffMult (`Bladeburner.ts:921-927`). */
export function actionStaminaCost(action: BladeburnerLevelledAction, level: number): number {
  return BLADEBURNER_CONSTANTS.baseStaminaLoss * difficultyMultiplier(actionDifficulty(action, level));
}

/**
 * A failure's HP lost, its mean: hpLoss × diffMult (`Bladeburner.ts:983-985`); the game rounds each draw up, at most
 * 1 more.
 */
export function actionHpLoss(action: BladeburnerLevelledAction, level: number): number {
  return action.hpLoss * difficultyMultiplier(actionDifficulty(action, level));
}

/**
 * The max stamina: (agi^0.8 + bonus) × the skills' stamina multiplier (Cyber's Edge's) × `bladeburner_max_stamina`, the
 * agility effective (`Bladeburner.ts:1329-1345`).
 */
export function maxStaminaOf(
  person: BladeburnerPerson,
  staminaBonus: number,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  const agility = effectiveLevel(person, "agility", skills);
  return Math.max((agility ** 0.8 + staminaBonus) * skills.stamina * person.mults.bladeburner_max_stamina, 1e-9);
}

/**
 * The stamina regained a second: (0.0085 + max/70,000) × agi^0.17 × the skills' stamina multiplier ×
 * `bladeburner_stamina_gain`, the agility effective (`Bladeburner.ts:1319-1327`).
 */
export function staminaGainPerSecond(
  person: BladeburnerPerson,
  maxStamina: number,
  skills: BladeburnerSkillMults = NO_BLADEBURNER_SKILLS,
): number {
  const c = BLADEBURNER_CONSTANTS;
  const agility = effectiveLevel(person, "agility", skills);
  const gain = (c.staminaGainPerSecond + maxStamina / c.maxStaminaToGainFactor) * agility ** 0.17;
  return Math.max(0, gain * skills.stamina * person.mults.bladeburner_stamina_gain);
}

/**
 * The max stamina at other skill levels (#379), from the one read at `read`'s multipliers: the bonus (Training's,
 * `Bladeburner.ts:1100`) is what the max read holds beyond its agility's part. The game scales the stamina with the max
 * (`:1338-1345`), so the penalty stays. `at` (#404): another person to compute it for, an install's (its agility and
 * `bladeburner_max_stamina`); the bonus is the division's and an install keeps it (`Bladeburner.ts:259-263`).
 */
export function maxStaminaAtSkills(
  person: BladeburnerPerson,
  maxStamina: number,
  read: BladeburnerSkillMults,
  planned: BladeburnerSkillMults,
  at: BladeburnerPerson = person,
): number {
  const divisor = read.stamina * person.mults.bladeburner_max_stamina;
  const bonus = divisor > 0 ? Math.max(0, maxStamina / divisor - effectiveLevel(person, "agility", read) ** 0.8) : 0;
  return maxStaminaOf(at, bonus, planned);
}

/**
 * The parts of an action's competence outside the skills' (`Actions/Action.ts:169-196`) that a person moves: the
 * intelligence bonus 1 + 0.75·int^0.8/600 and `bladeburner_success_chance` (#404: an install's forecast scales by them).
 */
export function personCompetenceFactor(person: BladeburnerPerson): number {
  return (1 + (0.75 * person.skills.intelligence ** 0.8) / 600) * person.mults.bladeburner_success_chance;
}

/** The successes level `maxLevel` + 1 opens after: ⌈½·M·(2b + M − 1)⌉ (`Actions/LevelableAction.ts:54-56`). */
export function successesForNextLevel(action: BladeburnerLevelledAction, maxLevel: number): number {
  const b =
    action.type === "Contracts"
      ? BLADEBURNER_CONSTANTS.contractSuccessesPerLevel
      : BLADEBURNER_CONSTANTS.operationSuccessesPerLevel;
  return Math.ceil(0.5 * maxLevel * (2 * b + (maxLevel - 1)));
}

/** A count's mean growth a second: its range's middle / 10 / 480 (`Bladeburner.ts:1388-1393`). */
export function countGrowthPerSecond(action: BladeburnerLevelledAction): number {
  return (action.growth[0] + action.growth[1]) / 2 / 10 / BLADEBURNER_CONSTANTS.actionCountGrowthPeriod;
}

/**
 * Training's experience a stat, an attempt: 30 × `mults.<stat>_exp`, taken twice (`Bladeburner.ts:1096-1099`, then
 * `PersonObjects/Person.ts:192-198`): the upstream quirk, kept.
 */
export function trainingExpPerAttempt(expMult: number): number {
  return 30 * expMult * expMult;
}

/** Field Analysis's rank: 0.1 × `BladeburnerRank`, no offset (`Formulas.ts:11-13`, `Bladeburner.ts:1136-1140`). */
export function fieldAnalysisRank(rankMultiplier: number): number {
  return 0.1 * rankMultiplier;
}

/** How often the Agent's Bladeburner worker reads and acts: every 10 s (ingame's `BLADEBURNER_ROUNDS_BETWEEN`). */
export const BLADEBURNER_READING_SECONDS = 10;

/** A contract or operation as the worker reads it: its level, max level, count, and the game's range there. */
export interface BladeburnerActionReading {
  type: BladeburnerLevelledType;
  name: string;
  level: number;
  maxLevel: number;
  count: number;
  /** `getActionEstimatedSuccessChance` at `level`, with the stamina penalty of the moment. */
  chance: [number, number];
}

/**
 * The low end of the estimate's chance at `level`, from the game's range read at `read.level` with the stamina's
 * `penalty` then (#375): the low end over the penalty, times fac^(read level − level), at most 1. The range scales as
 * 1/difficulty, so this is the game's own while neither the real nor the estimated chance is clamped at 1 (the
 * population and chaos factors cancel); read at 1, it's a bound from below that the next reading, at the level the rule
 * sets, replaces. With the high end read at 1 (#377's review), a clamp: the estimate may be over the real chance and
 * clamped (`Actions/Action.ts:144-167`: est 1.2 and real 0.9 read low as 0.53, the true 0.40 at pop/popEst 0.66), so
 * the low end is taken down, to lower levels, and up one level only, a level a reading. Null there, and with no penalty
 * to divide by (stamina at 0).
 */
export function chanceLowAt(
  action: BladeburnerLevelledAction,
  read: BladeburnerActionReading,
  level: number,
  penalty: number,
  /** The competence at other skill levels over the competence read (#379): 1 at the levels read. */
  competenceRatio = 1,
): number | null {
  if (!(penalty > 0)) return null;
  const clamped = read.chance[1] >= 1;
  if (clamped && level > read.level + 1) return null;
  // The range scales with competence as with 1/difficulty (#379); clamped, a skill's rise isn't credited (the low end
  // read may be over the true one already), so the rule errs low there.
  const ratio = clamped ? Math.min(1, competenceRatio) : competenceRatio;
  const atRead = Math.min(1, (read.chance[0] / penalty) * ratio);
  return Math.min(1, atRead * action.difficultyFac ** (read.level - level));
}

/** An attempt's rank, its mean and variance: a success's gain or a failure's loss, each ±10% uniform. */
export function attemptRankMoments(chance: number, gain: number, loss: number): { mean: number; variance: number } {
  // E[U²] for U uniform on [0.9, 1.1]: 1 + 0.1²/3.
  const secondMoment = (chance * gain * gain + (1 - chance) * loss * loss) * (1 + 0.01 / 3);
  const mean = chance * gain - (1 - chance) * loss;
  return { mean, variance: Math.max(0, secondMoment - mean * mean) };
}

/** A rest, its stamina a second net of its own cost (the natural regain included) and its rank a second. */
export interface BladeburnerRest {
  name: BladeburnerRestName;
  staminaPerSecond: number;
  rankPerSecond: number;
}

/**
 * The rests (`Bladeburner.ts:1094-1220`), each with the natural regain `regain` a second: Field Analysis (no stamina,
 * 0.1 × `BladeburnerRank` each 30 s), the Regeneration Chamber (1% of the max each 60 s) and Training (0.1425 each 30 s
 * spent). Left out, and labelled: Training's lasting gains (0.04 max stamina and 30 × mult² of each combat stat's
 * experience an attempt) and Field Analysis's sharper population estimate (B3's and the planner's: neither is rank
 * now).
 */
export function bladeburnerRests(regain: number, maxStamina: number, rankMultiplier: number): BladeburnerRest[] {
  const c = BLADEBURNER_CONSTANTS;
  return [
    {
      name: FIELD_ANALYSIS,
      staminaPerSecond: regain,
      rankPerSecond: fieldAnalysisRank(rankMultiplier) / BLADEBURNER_REST_SECONDS[FIELD_ANALYSIS],
    },
    {
      name: REGENERATION_CHAMBER,
      staminaPerSecond:
        regain + (maxStamina * c.hrcStaminaGainPercent) / 100 / BLADEBURNER_REST_SECONDS[REGENERATION_CHAMBER],
      rankPerSecond: 0,
    },
    {
      name: BLADEBURNER_TRAINING,
      staminaPerSecond: regain - (0.5 * c.baseStaminaLoss) / BLADEBURNER_REST_SECONDS[BLADEBURNER_TRAINING],
      rankPerSecond: 0,
    },
  ];
}

/** The work the rule weighs: a contract or operation at a level, and its figures there. */
export interface BladeburnerWork {
  type: BladeburnerLevelledType;
  name: string;
  level: number;
  /**
   * The range read's low end there (`chanceLowAt`), the stamina penalty out: since #415 the brain's range is a point
   * at the true population (`bladeburnerPricedInput`), so this is the chance the game draws against, or the fallback's.
   */
  chance: number;
  /** An attempt's rank, mean and variance; its seconds; its stamina; its HP lost on failure; its money on success. */
  rankMean: number;
  rankVariance: number;
  seconds: number;
  stamina: number;
  hpLoss: number;
  money: number;
  /** Rank a second while it runs: `rankMean` / (`seconds` + `diplomacySeconds`). */
  rankPerSecond: number;
  /**
   * The drift over the plan's horizon (#418, ./bladeburner-drift.ts), where priced: the chance read (`chance` is its
   * mean over the horizon), the horizon and the attempts in it, Diplomacy's seconds an attempt (holding the chaos it
   * adds), and the city worked at the horizon's end (its chaos, and its population over the one read).
   */
  drift?: {
    chanceRead: number;
    horizonSeconds: number;
    attempts: number;
    chaos: number;
    populationRatio: number;
    /** Under a target, the horizon's passes (`driftedToTarget`). */
    passes?: number;
  };
  /** Diplomacy's seconds an attempt (#418): 0 where the drift isn't priced. */
  diplomacySeconds: number;
  /** The hospital's money a game second while the plan runs (#418, `hospitalCostPerFailure`); null, not read. */
  moneyLostPerSecond: number | null;
}

/** The rule's plan (#375): the work and the rest it alternates with, the share of time worked, and the cycle's rate. */
export interface BladeburnerActionPlan {
  /** The best work, or null: none worth more than resting (no count, or none gains rank). */
  work: BladeburnerWork | null;
  /** The best rest with that work (or alone). */
  rest: BladeburnerRest;
  /** The share of the time worked over a cycle of work and rest, by stamina: rest's gain over work's net drain plus it. */
  duty: number;
  /** Rank a game second over the cycle: duty × the work's rate + (1 − duty) × the rest's. */
  rankPerSecond: number;
  /** The stamina regained a second, whatever the action. */
  regain: number;
  /**
   * Under a current-rank target (#386): the target, and the expected game seconds to it with this plan; `next`, the
   * plan its chain follows its count with (#392's next-best, `fastestToTarget`), absent where the tail follows it.
   */
  toTarget?: { target: number; seconds: number; next?: BladeburnerChainNext };
}

/** A chain's next-best (#421's term 2, check 3's walks): its action and level (null: resting alone) and its rest. */
export interface BladeburnerChainNext {
  name: string | null;
  level: number | null;
  rest: BladeburnerRestName;
}

/**
 * The work a cycle of work and rest gains most rank a second with (#375), each contract and operation at each level
 * up to its max, and the rest with it:
 * - **The chance:** the range read's low end (`chanceLowAt`). Since #415 the brain gives the range priced at the true
 *   population (a point: the chance the game draws against, pop/popEst recovered from the next Black Op's range; else
 *   the mean over the estimate's spread, ./bladeburner-growth.ts's `bladeburnerPricedInput`), so the rule chooses at
 *   that chance, as the grown estimate prices it; given the game's own range, its low end, a bound from below.
 * - **The rank:** an attempt's mean, a success's gain against a failure's loss (`attemptRankMoments`), over its time.
 * - **The counts:** an action needs its next attempt and those until the next reading: 1 + 10 s × the bonus time's
 *   speed over its time. Under 1 the game stops it (`Actions/LevelableAction.ts:44-47`), idle until the rule's next turn.
 * - **The stamina:** worked from ½ max, the penalty's edge, and rested below. Over a cycle the time worked is the
 *   rest's gain over the work's net drain (its stamina an attempt over its time, less the regain) plus that gain. A work that
 *   drains nothing is worked all the time.
 * - **The rest:** the best of the three with that work, by the cycle's rank a second; and resting alone (Field
 *   Analysis's rank) when no work beats it.
 * - **Ties:** the first in the game's order (contracts, then operations, each level from 1).
 * - **The skills** (#379): the levels read (`skills.read`) are in the game's range already, and in the time and the
 *   regain computed here. At other levels (`skills.planned`: the skills' forecast, ./bladeburner-skills.ts), each
 *   action's low end scales with its competence (`actionSkillCompetence`), the time and the regain are computed at
 *   those levels, and the max stamina with them (`maxStaminaAtSkills`). No skills given: none read or planned.
 * - **The city** (#383, ./bladeburner-cities.ts): in another city than the one read, or at another chaos, each
 *   action's low end scales by `city.ratio` (core's `cityCompetenceRatio`: since #420 the measured true populations'
 *   and the chaos factors', core's `bladeburnerMeasuredCities`), as with the skills; Raid out where `city.raid` is false (no communities, `Actions/Operation.ts:63-68`). None
 *   given: the city read.
 * - **Under a current-rank target** (#386, `target`, ./bladeburner-targets.ts): the plan with the least expected time
 *   to it (`fastestToTarget`), not the most rank a second; met (the rank at it), rank a second. Training never rests
 *   better than Field Analysis (less stamina, no rank), so it isn't weighed.
 * - **The drift** (#418, `drift`, ./bladeburner-drift.ts): under a target each chance is its mean over the attempts the
 *   plan makes in its horizon (`driftedToTarget`), the city moved by them, the events and Diplomacy's time on each
 *   attempt; past every target, the chances read (no horizon). Since #421 (term 3) a plan's own action over the
 *   attempts its chain makes (its count, then its share of the tail's mix), the tail's ways over the most the tail can
 *   make of each (the horizon's at its duty, its count and regrowth at most).
 * - **The attempt under way** (#421's ruling 3, `underWay`): under a target, each plan of the action under way has its
 *   first attempt cost only its time left (the level read's seconds less those done); past every target, left out. **The hospital** (#418, `hospital`): each plan's money a
 *   second (`moneyLostPerSecond`), shown, not in the objective (money against rank is the planner's, decision 67).
 * Left out, and labelled: a failure's HP in the objective (above: its money is reported, not traded, so the choice is
 * optimistic for the actions that lose the most HP, Raid about 386 a failure, Stealth Retirement 85, Assassination 50,
 * Bounty Hunter 5, against 20 HP at defense 100); money (contracts pay as a by-product); teams.
 */
export function chooseBladeburnerAction(input: BladeburnerActionInput): BladeburnerActionPlan {
  const { target } = input;
  if (target === undefined || !(target.rank < target.target)) {
    const { candidates } = planCandidates(input);
    // Rank a second: the first with the most, in the game's order (resting alone first).
    let best = (candidates[0] as PlanCandidate).plan;
    for (const { plan } of candidates) if (plan.rankPerSecond > best.rankPerSecond) best = plan;
    return best;
  }
  return driftedToTarget(input, target, true)[0] as BladeburnerActionPlan;
}

/**
 * Every plan the rule weighs under `input.target` (#386), in the game's order (resting alone first), each with its
 * expected time to the target (`toTarget`), none ruled out by Wald's bound: what the tests check the choice against.
 * Empty with no target, or one met. With the drift (#418), at the rule's own horizon (`driftedToTarget`).
 */
export function bladeburnerPlansToTarget(input: BladeburnerActionInput): BladeburnerActionPlan[] {
  const { target } = input;
  if (target === undefined || !(target.rank < target.target)) return [];
  return driftedToTarget(input, target, false);
}

/**
 * The drift's horizon at `input` under its target (#418's review): the plans' least expected time to it at the chances
 * read, or null with no target, none met or no drift. B4 takes it once a reading for every city it weighs
 * (`chooseBladeburnerCity`), so each city's choice is one solve.
 * - **Each plan's own chain** (#386's, `fluidSeconds`, for the cost: the rule's search over every plan, each next-best
 *   found by its own chain, was half of BN7.1's hour of the brain's and the report's solves): its count, then its
 *   next-best by their mean times (each plan's stock at its mean rise an attempt, then the tail's rate: another action,
 *   with its own count, where it beats the tail straight away), then the tail. Labelled: the next-best by the mean, not
 *   by its chain (the floor and the jumps out of that pick only). In core's test the horizon is the rule's chain's to
 *   the bit (from 0 to 25, 25 to 2,500 and 150 to 2,500), and in BN7.1's hour its figures are main's.
 */
export function bladeburnerDriftHorizon(input: BladeburnerActionInput): number | null {
  const { target, drift } = input;
  if (target === undefined || !(target.rank < target.target) || drift === undefined) return null;
  const seconds = fluidSeconds({ ...input, drift: undefined }, target);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** `bladeburnerDriftHorizon`'s mean time: the least over the plans at `input` (no drift in it). */
function fluidSeconds(input: BladeburnerActionInput, { rank, target }: { rank: number; target: number }): number {
  const { candidates, supply } = planCandidates(input);
  const distance = target - rank;
  if (!(distance > 0)) return 0;
  const first = candidates[0] as PlanCandidate;
  const tailRate = bladeburnerSustainableRate(supply, first.step === null ? first.plan.rankPerSecond : 0);
  // Each plan's mean time: its stock at its mean rise, then the tail's rate.
  const meanOf = ({ plan, step }: PlanCandidate) => {
    if (step === null) return plan.rankPerSecond > 0 ? distance / plan.rankPerSecond : Number.POSITIVE_INFINITY;
    const rise = step.chance * step.gain - (1 - step.chance) * step.loss + step.rest;
    const attempts = step.attempts ?? Number.POSITIVE_INFINITY;
    if (rise > 0 && attempts * rise >= distance) return (distance / rise) * step.seconds;
    if (Number.isFinite(attempts) && tailRate > 0) {
      return attempts * step.seconds + Math.max(0, distance - attempts * rise) / tailRate;
    }
    return Number.POSITIVE_INFINITY;
  };
  const means = candidates.map(meanOf);
  const tailOnly = tailRate > 0 ? distance / tailRate : Number.POSITIVE_INFINITY;
  const bare = ({ attempts: _attempts, next: _next, tailRate: _tail, ...rest }: BladeburnerRankStep) => rest;
  const counted = (each: BladeburnerRankStep) =>
    each.attempts !== undefined && Number.isFinite(each.attempts) ? { ...bare(each), attempts: each.attempts } : null;
  // A plan's own chain (#386's): its count, then its next-best by the mean (another action's, with its own count, where
  // it beats the tail straight away), then the tail; its floor and its jumps in.
  // Each next-best's step made once, so its own count's solve is kept for every plan it follows (`boundedNext`'s).
  const nexts = new Map<number, BladeburnerRankStep>();
  const nextOf = (second: number) => {
    let next = nexts.get(second);
    if (next === undefined) {
      const nextStep = (candidates[second] as PlanCandidate).step as BladeburnerRankStep;
      const bounded = counted(nextStep);
      next = bounded === null ? bare(nextStep) : { ...bounded, tailRate };
      nexts.set(second, next);
    }
    return next;
  };
  // A sequence's fastest rise a second (Wald's, as the rule's bound): a step's chance × gain + rest over its seconds.
  const riseOf = (each: BladeburnerRankStep) => (each.chance * each.gain + each.rest) / each.seconds;
  // The plan's sequence, and Wald's bound on its time: the distance at its fastest piece's rise.
  const sequenceOf = (index: number) => {
    const fastest = candidates[index] as PlanCandidate;
    const step = fastest.step as BladeburnerRankStep;
    const own = counted(step);
    if (own === null) return bare(step);
    let second = -1;
    for (const [i, candidate] of candidates.entries()) {
      if (candidate.step === null || candidate.name === fastest.name || !((means[i] as number) < tailOnly)) continue;
      if (second < 0 || (means[i] as number) < (means[second] as number)) second = i;
    }
    return second < 0 ? { ...own, tailRate } : { ...own, next: nextOf(second) };
  };
  const boundOf = (sequence: BladeburnerRankStep) => {
    let most = Math.max(0, tailRate);
    for (let each: BladeburnerRankStep | undefined = sequence; each !== undefined; each = each.next) {
      most = Math.max(most, riseOf(each), each.next === undefined ? (each.tailRate ?? 0) : 0);
    }
    return most > 0 ? distance / most : Number.POSITIVE_INFINITY;
  };
  // The least of every plan's chain (the mean leaves out the floor, from rank 0 a failure loses nothing, so the
  // fastest by it is not always the fastest by the chain), by their means first, those Wald's bound rules out skipped.
  // Labelled (#418's round-2 review): a plan whose mean is infinite (its mean rise 0 or under, with no tail to follow)
  // is left unchained, though the floor can make its chain finite (failures at 0 lose nothing): the horizon then the
  // others' least, longer where that plan alone would be the fastest (the drift priced over more: Raid's chances the
  // lower for it, the population-neutral actions' the higher).
  let least = Number.POSITIVE_INFINITY;
  const order = means
    .map((mean, i) => ({ mean, i }))
    .filter((each) => Number.isFinite(each.mean))
    .sort((x, y) => x.mean - y.mean || x.i - y.i);
  for (const { i } of order) {
    if ((candidates[i] as PlanCandidate).step === null) {
      least = Math.min(least, means[i] as number);
      continue;
    }
    const sequence = sequenceOf(i);
    if (!(boundOf(sequence) < least)) continue;
    least = Math.min(least, bladeburnerSecondsToRank(sequence, rank, target));
  }
  return least;
}

/**
 * The horizon's passes (#418, `driftedToTarget`): 1, the chain solved once a choice, priced at the horizon of its least
 * mean time at the chances read (`bladeburnerDriftHorizon`, no chain). More move the horizon to the priced plan's own time: in core's test, from rank 25 to Typhoon's 2,500, Raid 80 h at
 * the chances read, Bounty Hunter 105 h priced once, 101 h at a fixed point (4 passes): the same choice. Each pass
 * costs a solve (a far target's about 40 ms in BN7's hour), so one. Labelled: the horizon the time at the chances read,
 * either way (the drift lowers Raid's chances and raises the population-neutral actions', the events' growth).
 */
export const BLADEBURNER_DRIFT_PASSES = 1;

/**
 * Each action's drift path over a horizon, kept by its figures (#418's ruling 4): a reading's solves (B4's cities, the
 * route's, the report's folds) share it; its curve is read only. The oldest dropped first past a reading's few.
 */
const DRIFT_CURVES = new Map<
  string,
  { chance: number; curve: BladeburnerDriftResult["curve"]; chaos: number; populationRatio: number }
>();
const DRIFT_CURVES_KEPT = 256;

/** The rule's solves under a target with the drift kept (#418): the run report replays the brain's readings. */
const DRIFTED_SOLVES = new Map<string, BladeburnerActionPlan[]>();
/** The most kept, the oldest dropped first: a reading's few cities and the report's replays of them. */
const DRIFTED_SOLVES_KEPT = 512;

/**
 * Under a target with the drift (#418): the plan's horizon is its own least expected time to the target (#386's
 * chain): from the time with the chances read, each pass prices every chance at its mean over the horizon
 * (`planCandidates`' `drift`) and solves the chain again, the best plan's time the next horizon; until it moves less
 * than the chain's grid resolution (1/`BLADEBURNER_TARGET_CELLS` of it) or `BLADEBURNER_DRIFT_PASSES` passes. Without
 * the drift, the chain once, as before. Each input's solve kept (`DRIFTED_SOLVES`: a pure function's, by its JSON).
 */
function driftedToTarget(
  input: BladeburnerActionInput,
  target: { rank: number; target: number },
  prune: boolean,
): BladeburnerActionPlan[] {
  if (input.drift === undefined) return driftedSolve(input, target, prune);
  const key = `${prune} ${JSON.stringify(input)}`;
  const known = DRIFTED_SOLVES.get(key);
  if (known !== undefined) return [...known];
  const solved = driftedSolve(input, target, prune);
  DRIFTED_SOLVES.set(key, solved);
  if (DRIFTED_SOLVES.size > DRIFTED_SOLVES_KEPT) DRIFTED_SOLVES.delete(DRIFTED_SOLVES.keys().next().value as string);
  return [...solved];
}

/** `driftedToTarget`'s solve. */
function driftedSolve(
  input: BladeburnerActionInput,
  target: { rank: number; target: number },
  prune: boolean,
): BladeburnerActionPlan[] {
  const solve = (priced: BladeburnerActionInput) => {
    const { candidates, supply } = planCandidates(priced);
    return fastestToTarget(candidates, supply, target, prune);
  };
  const { drift } = input;
  if (drift === undefined) return solve(input);
  // A horizon given (#418's review: B4's, once a reading for every city it weighs, `bladeburnerDriftHorizon`): priced
  // there at once, the chain solved once. None: its mean time at the chances read (`bladeburnerDriftHorizon`'s), then
  // priced there, the chain solved once too.
  const given = drift.horizonSeconds ?? 0;
  let plans: BladeburnerActionPlan[] = [];
  let horizon = given > 0 ? 0 : (bladeburnerDriftHorizon({ ...input, target }) ?? 0);
  let passes = 0;
  if (given > 0) {
    plans = solve(input);
    passes = 1;
  } else if (!(horizon > 0)) plans = solve({ ...input, drift: { ...drift, horizonSeconds: 0 } });
  while (passes < BLADEBURNER_DRIFT_PASSES && Number.isFinite(horizon) && horizon > 0) {
    plans = solve({ ...input, drift: { ...drift, horizonSeconds: horizon } });
    passes += 1;
    const next = plans[0]?.toTarget?.seconds ?? Number.POSITIVE_INFINITY;
    const settled = Math.abs(next - horizon) <= horizon / BLADEBURNER_TARGET_CELLS;
    horizon = next;
    if (settled) break;
  }
  // The passes each plan's drift took (the report's and the tests').
  return plans.map((plan) =>
    plan.work?.drift === undefined ? plan : { ...plan, work: { ...plan.work, drift: { ...plan.work.drift, passes } } },
  );
}

/**
 * The sustainable rank a game second at `input` (#398): the tail's rate under a target (#392's decision,
 * `bladeburnerSustainableRate`), the linear programme over every way to work each action read within its count's
 * regrowth, the rest resting alone (Field Analysis's). Its target is ignored: the rate is the state's.
 */
export function bladeburnerTailRate(input: BladeburnerActionInput): number {
  const { candidates, supply } = planCandidates(input, false);
  const first = candidates[0] as PlanCandidate;
  return bladeburnerSustainableRate(supply, first.step === null ? first.plan.rankPerSecond : 0);
}

/** One action worked in the tail's mix (#408): its level, an attempt's chance, seconds and rise, its attempts a second. */
export interface BladeburnerTailWork {
  type: BladeburnerLevelledType;
  name: string;
  level: number;
  chance: number;
  attemptSeconds: number;
  /** An attempt with its share of its rest (its cycle step's seconds): the linear programme's time, Σ ≤ 1 a second. */
  cycleSeconds: number;
  attemptsPerSecond: number;
  /** An attempt's mean rank with its share of its rest's (the cycle's rise, `bladeburnerStepRise`). */
  rise: number;
}

/**
 * The tail's mix at `input` (#408): `bladeburnerTailRate`'s linear programme's primal (core's
 * `bladeburnerSustainableMix`), each action worked, at its level, and its attempts a second; the rest of the second
 * resting alone. `rate` is the primal's, the tail rate's within the dual's bracket.
 */
export function bladeburnerTailMix(input: BladeburnerActionInput): { rate: number; work: BladeburnerTailWork[] } {
  const { candidates, supply } = planCandidates(input, false);
  const first = candidates[0] as PlanCandidate;
  const { rate, parts } = bladeburnerSustainableMix(supply, first.step === null ? first.plan.rankPerSecond : 0);
  const work = parts.map(({ source, option, perSecond }): BladeburnerTailWork => {
    const each = supply[source] as BladeburnerRankSource;
    const way = each.options[option] as Required<BladeburnerRankSource["options"][number]>;
    return {
      type: each.type as BladeburnerLevelledType,
      name: each.name as string,
      level: way.level,
      chance: way.chance,
      attemptSeconds: way.attemptSeconds,
      cycleSeconds: way.seconds,
      attemptsPerSecond: perSecond,
      rise: way.rise,
    };
  });
  return { rate, work };
}

/** `chooseBladeburnerAction`'s input. */
export type BladeburnerActionInput = Parameters<typeof planCandidates>[0];

/**
 * The attempts a plan's chain makes in the drift's horizon (#421's term 3): `count` in its count's `countSeconds` (the
 * chain's step, `bladeburnerAttemptsInCount` at its cycle), then `tail` over the rest of the horizon (its share of the
 * tail's mix). Its count outlasting the horizon: the horizon's attempts at its cycle, `countSeconds` the horizon.
 */
export interface BladeburnerChainAttempts {
  count: number;
  countSeconds: number;
  tail: number;
}

/** A way to work an action, as read (`planCandidates`): its level's chance, time, rank and stamina, its duty a rest. */
interface WayRead {
  level: number;
  chanceRead: number;
  seconds: number;
  gain: number;
  loss: number;
  cost: number;
  dutyOf: (worked: number, rest: BladeburnerRest) => number;
}

/** Two paths' curves end to end (#421's term 3: the count's, then the tail's), the second's figures from the first's end. */
function joinedCurve(
  first: BladeburnerDriftResult["curve"],
  second: BladeburnerDriftResult["curve"],
): BladeburnerDriftResult["curve"] {
  const last = (xs: number[]) => xs[xs.length - 1] ?? 0;
  const [attempts, successes, diplomacy] = [last(first.attempts), last(first.successes), last(first.diplomacy)];
  return {
    attempts: [...first.attempts, ...second.attempts.slice(1).map((x) => attempts + x)],
    successes: [...first.successes, ...second.successes.slice(1).map((x) => successes + x)],
    diplomacy: [...first.diplomacy, ...second.diplomacy.slice(1).map((x) => diplomacy + x)],
  };
}

/** A plan weighed: its plan, its walk's step (null: resting alone), and its action's name (null: resting alone). */
interface PlanCandidate {
  plan: BladeburnerActionPlan;
  step: BladeburnerRankStep | null;
  name: string | null;
  /**
   * The seconds its first attempt saves on its own time (#421's ruling 3): the action under way's, its seconds less
   * the started attempt's time left; 0 for any other.
   */
  firstDiscount: number;
}

/** Every plan `chooseBladeburnerAction` weighs, in the game's order, resting alone first. */
function planCandidates(
  {
    readings,
    person,
    stamina,
    maxStamina,
    rankMultiplier,
    speed,
    skills = {},
    city,
    forecast,
    drift,
    hospital,
    underWay,
  }: {
    readings: readonly BladeburnerActionReading[];
    person: BladeburnerPerson;
    /**
     * Another person to forecast at (#404: an install's, core's `bladeburnerPersonAfterInstall`): each action's low end
     * scaled by its competence there over the competence read, as the skills' are, the times, the max stamina and the
     * regain computed there. None: the person read.
     */
    forecast?: BladeburnerPerson;
    stamina: number;
    maxStamina: number;
    rankMultiplier: number;
    /** Game seconds a real second: 5 with bonus time, else 1. */
    speed: number;
    /** The skill levels read (none: all 0), and those to forecast at (none: the levels read). */
    skills?: { read?: BladeburnerSkillLevels; planned?: BladeburnerSkillLevels };
    /** Another city or chaos than the one read (#383): the competence there over the competence read, and Raid there. */
    city?: { ratio: number; raid: boolean };
    /** The rank now and the next current-rank target (#386, ./bladeburner-targets.ts): under it, the least time to it. */
    target?: { rank: number; target: number };
    /**
     * The cities read and the city the chances are for (#418, ./bladeburner-drift.ts), its chaos where it's another's
     * (B4's forecasts), and the horizon: each contract's and operation's chance priced at its mean over the attempts the
     * plan makes in `horizonSeconds`, the city moved by them, and Diplomacy's time holding the chaos. Under a target the
     * rule solves the horizon itself (`chooseBladeburnerAction`); 0 or absent, the chances read. None: no drift.
     * `chunks`: each path's at most (`BLADEBURNER_DRIFT_CHUNKS` absent; the grown estimate's steps fewer).
     */
    drift?: {
      cities: readonly BladeburnerDriftCity[];
      city: string;
      chaos?: number;
      horizonSeconds?: number;
      chunks?: number;
      /**
       * pop/popEst of `city` as the round measured it (#420, `bladeburnerCityMeasures`), or absent: none recovered there.
       * Only `bladeburnerPricedInput` reads it (each chance at it, #422's round 2), not the forecast.
       */
      ratio?: number;
    };
    /** The max HP and the money read (#418): each plan's hospital money a second. None: not read (null). */
    hospital?: { hpMax: number; money: number };
    /**
     * The contract or operation under way (#421's ruling 3): its name, the level read and its seconds done. Its started
     * attempt's time is fixed (`Bladeburner.ts:186-188`) and a level set keeps it (`NetscriptFunctions/Bladeburner.ts:
     * 218-227`), so each plan of that action's first attempt is the time left of it, the level read's seconds less those
     * done; another action's starts again at 0 (`Bladeburner.ts:187`). None: nothing under way, or not read. Labelled
     * (#425's review): no NS call returns the started attempt's own time, so where the level changed mid-attempt the
     * time left is off by the two levels' ratio (difficultyFac^Δ): in bn6-skills' hour 20 of 175 readings within an
     * attempt, at most 4.5% of an attempt.
     */
    underWay?: { name: string; level: number; secondsDone: number };
  },
  /** The plans as well as the tail's supply: the tail's own callers (`bladeburnerTailMix`, its rate) need only the latter. */
  plans = true,
): { candidates: PlanCandidate[]; supply: BladeburnerRankSource[] } {
  const readMults = bladeburnerSkillMultsOf(skills.read ?? {});
  const mults = skills.planned === undefined ? readMults : bladeburnerSkillMultsOf(skills.planned);
  const at = forecast ?? person;
  const scaled = skills.planned !== undefined || forecast !== undefined;
  const maxPlanned = scaled ? maxStaminaAtSkills(person, maxStamina, readMults, mults, at) : maxStamina;
  const regain = staminaGainPerSecond(at, maxPlanned, mults);
  // The person's own part of the competence forecast over the one read (#404): 1 at the person read.
  const personRatio = forecast === undefined ? 1 : personCompetenceFactor(forecast) / personCompetenceFactor(person);
  const rests = bladeburnerRests(regain, maxPlanned, rankMultiplier);
  // A rest with no more stamina and no more rank a second than another is never the better (#386): Training's, beside
  // Field Analysis's (its cost from the same regain, and no rank).
  const worthResting = rests.filter(
    (rest) =>
      !rests.some(
        (other) =>
          other !== rest &&
          other.staminaPerSecond >= rest.staminaPerSecond &&
          other.rankPerSecond >= rest.rankPerSecond &&
          (other.staminaPerSecond > rest.staminaPerSecond || other.rankPerSecond > rest.rankPerSecond),
      ),
  );
  const penalty = staminaPenalty(stamina, maxStamina);
  const restAlone = rests.reduce((best, each) => (each.rankPerSecond > best.rankPerSecond ? each : best));
  const alone: BladeburnerActionPlan = {
    work: null,
    rest: restAlone,
    duty: 0,
    rankPerSecond: restAlone.rankPerSecond,
    regain,
  };
  // Every plan weighed, in the game's order (resting alone first): its step to a target with it (#386).
  const candidates: PlanCandidate[] = [{ plan: alone, step: null, name: null, firstDiscount: 0 }];
  // Each action's long-run supply (#392's decision, #395's review): every way to work it, whatever its count now (its
  // regrowth is the action's).
  const supply: BladeburnerRankSource[] = [];
  // The drift (#418): the cities from the reading, the city the chances are for, its horizon.
  const driftStart = drift === undefined ? null : bladeburnerDriftStart(drift.cities, drift.city, drift.chaos);
  const horizon = drift?.horizonSeconds ?? 0;
  const reference = driftStart?.cities[driftStart.worked];
  /**
   * An action worked alone over the horizon from the reading's cities at its fastest way and rest (#418's review: one
   * path an action, its ways and rests priced off it, for the cost): the chain's attempts at `chance` (#421's term 3:
   * `chain.count` in its count's `chain.countSeconds`, then `chain.tail` over the rest of the horizon), the brain's city
   * chosen again as they move (B4's, `moves`), Diplomacy in it. Null with no drift or none.
   */
  const driftCurve = (action: BladeburnerLevelledAction, chance: number, chain: BladeburnerChainAttempts) => {
    if (driftStart === null || reference === undefined || !(chain.count + chain.tail > 0) || !(horizon > 0)) {
      return null;
    }
    // Kept by its figures (#418's ruling 4: the drift once a reading and city, every solve of the reading sharing it).
    const key = JSON.stringify([driftStart, action.name, chance, chain, horizon, at.skills.charisma, drift?.chunks]);
    const known = DRIFT_CURVES.get(key);
    if (known !== undefined) return known;
    const options = {
      charisma: at.skills.charisma,
      moves: true,
      ...(drift?.chunks === undefined ? {} : { chunks: drift.chunks }),
    };
    // The count's attempts in its time, then the tail's share over the rest of the horizon (its events with none).
    const counted = bladeburnerDriftPath(
      driftStart,
      reference,
      [{ action, chance, attempts: chain.count }],
      chain.countSeconds,
      options,
    );
    const rest = horizon - chain.countSeconds;
    const path =
      rest > 0
        ? bladeburnerDriftPath(counted.state, reference, [{ action, chance, attempts: chain.tail }], rest, options)
        : null;
    const curve = path === null ? counted.curve : joinedCurve(counted.curve, path.curve);
    const state = (path ?? counted).state;
    const end = state.cities[state.worked] as BladeburnerDriftCity;
    const priced = {
      chance,
      curve,
      chaos: end.chaos,
      populationRatio: reference.population > 0 ? end.population / reference.population : 1,
    };
    DRIFT_CURVES.set(key, priced);
    if (DRIFT_CURVES.size > DRIFT_CURVES_KEPT) DRIFT_CURVES.delete(DRIFT_CURVES.keys().next().value as string);
    return priced;
  };
  /**
   * An action's ways priced at the attempts `chainOf` gives them in the horizon (#421's term 3: the tail's ways at the
   * horizon's, the plan's own step at its chain's), off one path at its fastest way's and rest's attempts.
   */
  const pricing =
    (action: BladeburnerLevelledAction, ways: readonly WayRead[]) =>
    (chainOf: (worked: number, duty: number) => BladeburnerChainAttempts) => {
      const attemptsOf = (worked: number, duty: number) => {
        const chain = chainOf(worked, duty);
        return chain.count + chain.tail;
      };
      let curve: ReturnType<typeof driftCurve> = null;
      if (driftStart !== null && horizon > 0) {
        let fastest: BladeburnerChainAttempts | null = null;
        let attempts = 0;
        let chanceRead = 0;
        for (const rest of worthResting) {
          for (const way of ways) {
            const chain = chainOf(way.seconds, way.dutyOf(way.seconds, rest));
            if (chain.count + chain.tail > attempts) {
              attempts = chain.count + chain.tail;
              fastest = chain;
              chanceRead = way.chanceRead;
            }
          }
        }
        curve = fastest === null ? null : driftCurve(action, chanceRead, fastest);
      }
      return (way: WayRead, rest: BladeburnerRest) => {
        const { chanceRead, seconds, gain, loss, dutyOf } = way;
        const readDuty = dutyOf(seconds, rest);
        if (readDuty === 0) return null;
        // The drift over the horizon (#418), off the action's path: its attempts at its cycle with Diplomacy's seconds
        // in it ((seconds + Diplomacy's) over its duty, no stamina in Diplomacy: `dutyOf`), solved with them; its chance
        // the path's mean over them, times its own over the path's way's. Labelled: an action's ways and rests share its
        // fastest's path (the city that one's attempts leave, at that one's pace: a slower way's attempts see the events
        // of the path's time at fewer attempts, so the drift's events under-counted for it, its attempts' own the same).
        let priced: { chance: number; diplomacySeconds: number; drift: NonNullable<BladeburnerWork["drift"]> } | null =
          null;
        if (curve !== null) {
          let attempts = attemptsOf(seconds, readDuty);
          for (let pass = 0; pass < 3 && attempts > 0; pass++) {
            const diplomacy = bladeburnerDriftCurveAt(curve.curve, attempts).diplomacy / attempts;
            const duty = dutyOf(seconds + diplomacy, rest);
            attempts = duty > 0 ? attemptsOf(seconds + diplomacy, duty) : 0;
          }
          if (attempts > 0) {
            const reached = bladeburnerDriftCurveAt(curve.curve, attempts);
            const factor = curve.chance > 0 ? reached.successes / (attempts * curve.chance) : 1;
            priced = {
              chance: Math.min(1, chanceRead * factor),
              diplomacySeconds: reached.diplomacy / attempts,
              drift: {
                chanceRead,
                horizonSeconds: horizon,
                attempts,
                chaos: curve.chaos,
                populationRatio: curve.populationRatio,
              },
            };
          }
        }
        const chance = priced?.chance ?? chanceRead;
        const diplomacySeconds = priced?.diplomacySeconds ?? 0;
        const worked = seconds + diplomacySeconds;
        const duty = priced === null ? readDuty : dutyOf(worked, rest);
        if (duty === 0) return null;
        const cycleStep = bladeburnerCycleStep({
          chance,
          gain,
          loss,
          seconds: worked,
          duty,
          restRankPerSecond: rest.rankPerSecond,
        });
        return { chance, diplomacySeconds, drift: priced?.drift ?? null, worked, duty, cycleStep };
      };
    };
  // Each action's figures for its plans, priced once the tail's mix is known (#421's term 3).
  const steps: {
    action: BladeburnerLevelledAction;
    read: BladeburnerActionReading;
    ways: WayRead[];
    most: number;
    priceOf: ReturnType<typeof pricing>;
    tailPrice: ReturnType<ReturnType<typeof pricing>>;
    horizonOf: (worked: number, duty: number) => BladeburnerChainAttempts;
  }[] = [];
  for (const read of readings) {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action === null) continue;
    if (city !== undefined && !city.raid && action.name === "Raid") continue;
    const options: { rise: number; seconds: number; level: number; chance: number; attemptSeconds: number }[] = [];
    supply.push({ growthPerSecond: countGrowthPerSecond(action), options, type: action.type, name: action.name });
    const readCompetence = actionSkillCompetence(action, person, readMults);
    const skillRatio =
      !scaled || !(readCompetence > 0) ? 1 : (actionSkillCompetence(action, at, mults) / readCompetence) * personRatio;
    const ratio = skillRatio * (city?.ratio ?? 1);
    // Each way read: its level's chance, time, rank and stamina.
    const ways: WayRead[] = [];
    for (let level = 1; level <= Math.max(1, read.maxLevel); level++) {
      const chanceRead = chanceLowAt(action, read, level, penalty, ratio);
      if (chanceRead === null) continue;
      const cost = actionStaminaCost(action, level);
      ways.push({
        level,
        chanceRead,
        seconds: actionSeconds(action, level, at, mults),
        gain: actionRankGain(action, level, rankMultiplier),
        loss: actionRankLoss(action, level),
        cost,
        dutyOf: (worked, rest) => {
          const drain = cost / worked - regain;
          return drain <= 0
            ? 1
            : rest.staminaPerSecond > 0
              ? rest.staminaPerSecond / (drain + rest.staminaPerSecond)
              : 0;
        },
      });
    }
    // The drift (#418): one path an action, at its fastest way's and rest's attempts in the horizon. The tail's ways
    // (`supply`, #392's linear programme) at the most the tail can make of it: the horizon's attempts at its duty, its
    // count and regrowth at most (#418's). The plan's own step at the attempts its chain makes (#421's term 3, below).
    const most = read.count + countGrowthPerSecond(action) * horizon;
    const horizonOf = (worked: number, duty: number): BladeburnerChainAttempts =>
      !(duty > 0) || !(worked > 0)
        ? { count: 0, countSeconds: 0, tail: 0 }
        : { count: Math.min((horizon * duty) / worked, most), countSeconds: horizon, tail: 0 };
    const priceOf = pricing(action, ways);
    const tailPrice = priceOf(horizonOf);
    for (const way of ways) {
      for (const rest of worthResting) {
        const each = tailPrice(way, rest);
        if (each === null) continue;
        options.push({
          rise: bladeburnerStepRise(each.cycleStep),
          seconds: each.cycleStep.seconds,
          level: way.level,
          chance: each.chance,
          attemptSeconds: way.seconds,
        });
      }
    }
    steps.push({ action, read, ways, most, priceOf, tailPrice, horizonOf });
  }
  if (!plans) return { candidates, supply };
  // #421's term 3: each action's attempts a second in the chain's tail, the sustainable rate's (`fastestToTarget`'s,
  // over `supply`), from its linear programme's primal (`bladeburnerSustainableMix`, `bladeburnerTailMix`'s).
  const shares = new Map<string, number>();
  if (driftStart !== null && horizon > 0) {
    for (const { source, perSecond } of bladeburnerSustainableMix(supply, alone.rankPerSecond).parts) {
      const name = supply[source]?.name;
      if (name !== undefined) shares.set(name, (shares.get(name) ?? 0) + perSecond);
    }
  }
  for (const { action, read, ways, most, priceOf, tailPrice, horizonOf } of steps) {
    // The plan's own step (#421's term 3): its drift over the attempts its chain makes in the horizon, not the
    // horizon's at its duty: its count (`bladeburnerAttemptsInCount` at its cycle, as the chain's step), then its share
    // of the tail over the rest. Labelled: a next-best's count between them counted as the tail's.
    const growth = countGrowthPerSecond(action);
    const share = shares.get(action.name) ?? 0;
    const chainOf = (worked: number, duty: number): BladeburnerChainAttempts => {
      if (!(duty > 0) || !(worked > 0)) return { count: 0, countSeconds: 0, tail: 0 };
      const cycle = worked / duty;
      const inCount = bladeburnerAttemptsInCount(read.count, growth, cycle);
      // Its count outlasting the horizon (or kept up by its growth): the horizon's attempts, as the tail's ways.
      if (!(inCount * cycle < horizon)) return horizonOf(worked, duty);
      const tail = Math.max(0, Math.min(share * (horizon - inCount * cycle), most - inCount));
      return { count: inCount, countSeconds: inCount * cycle, tail };
    };
    const stepPrice = driftStart !== null && horizon > 0 ? priceOf(chainOf) : tailPrice;
    // The attempt under way (#421's ruling 3): its time left, the level read's seconds less those done (a level set
    // keeps it), where this is the action under way.
    const started =
      underWay !== undefined && underWay.name === action.name
        ? ways.find((each) => each.level === underWay.level)
        : undefined;
    const timeLeft = started === undefined ? null : Math.max(0, started.seconds - (underWay?.secondsDone ?? 0));
    for (const way of ways) {
      const { level, seconds, gain, loss, cost } = way;
      if (read.count < 1 + (BLADEBURNER_READING_SECONDS * speed) / seconds) continue;
      for (const rest of worthResting) {
        const priced = stepPrice(way, rest);
        if (priced === null) continue;
        const { chance, diplomacySeconds, worked, duty, cycleStep } = priced;
        const { mean, variance } = attemptRankMoments(chance, gain, loss);
        const rate = mean / worked;
        // Its count bounds its attempts (#386's amendment): the next-best's after them (`fastestToTarget`).
        const step = { ...cycleStep, attempts: bladeburnerAttemptsInCount(read.count, growth, cycleStep.seconds) };
        const hpLoss = actionHpLoss(action, level);
        const plan: BladeburnerActionPlan = {
          work: {
            type: action.type,
            name: action.name,
            level,
            chance,
            rankMean: mean,
            rankVariance: variance,
            seconds,
            stamina: cost,
            hpLoss,
            money: actionMoney(action, level),
            rankPerSecond: rate,
            ...(priced.drift === null ? {} : { drift: priced.drift }),
            diplomacySeconds,
            // Its failures a second over the cycle, each its mean bill (#418).
            moneyLostPerSecond:
              hospital === undefined
                ? null
                : (duty / worked) * (1 - chance) * hospitalCostPerFailure(hpLoss, hospital.hpMax, hospital.money),
          },
          rest,
          duty,
          rankPerSecond: duty * rate + (1 - duty) * rest.rankPerSecond,
          regain,
        };
        candidates.push({
          plan,
          step,
          name: action.name,
          firstDiscount: timeLeft === null ? 0 : seconds - timeLeft,
        });
      }
    }
  }
  return { candidates, supply };
}

/**
 * Under a target (#386): the plans by their expected time to it (`bladeburnerSecondsToRank`), the least first and the
 * first in the game's order on a tie. Resting alone is Field Analysis's steady rate, (target − rank) over it.
 * - **The counts** (#386's amendment): a plan whose count runs out before the target is reached
 *   (`bladeburnerAttemptsInCount`) is followed, as a sequence, by the next-best: the plan with another action (or
 *   resting alone) with the least expected time from the rank now, for its own count too (#392); then, or straight
 *   away where no next-best beats it, the tail: the rank still needed over the sustainable rate (#392's decision,
 *   `bladeburnerSustainableRate`: the linear programme over every way to work each action read, a level and a rest,
 *   within its count's regrowth and the second's time, the rest resting alone), common to every plan. Far from the target the choice is the stock's best rank a second.
 * - **Pruned** (`prune`): each plan's Wald bound (`bladeburnerSecondsToRankAtLeast`; with a count, the distance over
 *   the faster rise of it and its next-best) is taken first, and the walk solved only for those
 *   it can't rule out; just the best returned. Unpruned, every plan, sorted.
 */
function fastestToTarget(
  candidates: readonly PlanCandidate[],
  /** The actions' long-run supply, for the tail's sustainable rate (#392's decision). */
  supply: readonly BladeburnerRankSource[],
  { rank, target }: { rank: number; target: number },
  prune: boolean,
): BladeburnerActionPlan[] {
  const distance = target - rank;
  const aloneSeconds = (plan: BladeburnerActionPlan) =>
    plan.rankPerSecond > 0 ? distance / plan.rankPerSecond : Number.POSITIVE_INFINITY;
  const unbounded = ({ attempts: _attempts, next: _next, tailRate: _tail, ...step }: BladeburnerRankStep) => step;
  // A plan's fastest rise a second: a step's chance × gain + rest over its seconds (Wald's), or resting alone's.
  const riseOf = (step: BladeburnerRankStep) => (step.chance * step.gain + step.rest) / step.seconds;
  // Wald's bound through a sequence (#392): each walk's attempts rise at most its `riseOf` a second for at most its
  // attempts × (chance × gain + rest) of rank, so the least time takes the distance from the fastest first.
  const leastThrough = (steps: readonly BladeburnerRankStep[]) => {
    const pieces = steps
      .flatMap((each) => {
        const attempts = each.attempts ?? Number.POSITIVE_INFINITY;
        const own = { rise: riseOf(each), most: attempts * (each.chance * each.gain + each.rest) };
        // The analytic tail after it (#392), at the sustainable rate.
        const tail = each.next === undefined && each.tailRate !== undefined;
        return tail ? [own, { rise: each.tailRate as number, most: Number.POSITIVE_INFINITY }] : [own];
      })
      .filter((each) => each.rise > 0)
      .sort((a, b) => b.rise - a.rise);
    let left = distance;
    let seconds = 0;
    for (const { rise, most } of pieces) {
      const taken = Math.min(left, most);
      seconds += taken / rise;
      left -= taken;
      if (!(left > 0)) return seconds;
    }
    return Number.POSITIVE_INFINITY;
  };
  const sequenceOf = (step: BladeburnerRankStep): BladeburnerRankStep[] =>
    !((step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY)
      ? [{ ...step, attempts: Number.POSITIVE_INFINITY }]
      : step.next === undefined
        ? step.tailRate === undefined
          ? [{ ...step, attempts: Number.POSITIVE_INFINITY }]
          : [step]
        : [step, ...sequenceOf(step.next)];
  const leastOf = (candidate: PlanCandidate, bounded: boolean) => {
    const { plan, step, name } = candidate;
    if (step === null) return aloneSeconds(plan);
    // The choice's (from the reading): less the seconds its first attempt saves (#421's ruling 3: the action under
    // way's time left), a bound still; the next-best's search is from after the plan's own count, none under way.
    const discount = bounded ? candidate.firstDiscount : 0;
    const counted = (step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY;
    if (!counted) return bladeburnerSecondsToRankAtLeast(step, rank, target) - discount;
    // The next-best's search: its own count, then the tail. The choice's: the plan's count, then its next-best's.
    if (!bounded || name === null) return leastThrough([withCount(step)]) - discount;
    const next = nextAfter(name);
    return (
      (next === undefined ? leastThrough([withCount(step)]) : leastThrough([step, ...sequenceOf(next)])) - discount
    );
  };
  // The best among `pool` by `secondsOf`, Wald's bound (`leastOf`) ruling out the rest when pruned.
  const search = (
    pool: readonly { candidate: PlanCandidate; order: number }[],
    bounded: boolean,
    secondsOf: (candidate: PlanCandidate) => number,
    all: boolean,
  ) => {
    const ranked = pool
      .map((each) => ({ ...each, least: leastOf(each.candidate, bounded) }))
      .sort((x, y) => x.least - y.least || x.order - y.order);
    const solved: { candidate: PlanCandidate; order: number; seconds: number }[] = [];
    let best = Number.POSITIVE_INFINITY;
    for (const { candidate, order, least } of ranked) {
      if (!all && solved.length > 0 && least > best) break;
      const seconds = secondsOf(candidate);
      best = Math.min(best, seconds);
      solved.push({ candidate, order, seconds });
    }
    return solved.sort((x, y) => x.seconds - y.seconds || x.order - y.order);
  };
  const pool = candidates.map((candidate, order) => ({ candidate, order }));
  // The tail after the stock (#392's decision): the sustainable rate, the linear programme over every way to work each
  // action read (a level and a rest) within its count's regrowth and the second, the rest resting alone (the first
  // candidate's, Field Analysis's).
  const first = candidates[0] as PlanCandidate;
  const tailRate = bladeburnerSustainableRate(supply, first.step === null ? first.plan.rankPerSecond : 0);
  // A plan's step with its count, then the tail; unbounded where its count keeps up.
  const withCount = (step: BladeburnerRankStep): BladeburnerRankStep =>
    (step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY
      ? { ...unbounded(step), attempts: step.attempts as number, tailRate }
      : unbounded(step);
  // The next-best after an action's count (cached by the action spent): its step, with its own count (#392), then
  // resting alone.
  const nextBest = new Map<string, BladeburnerRankStep | undefined>();
  // Its candidate, where there's one (the walks' chain, `nextOf`). Labelled: its count is the one read, its regrowth
  // over the plan's own stretch left out (#421's ruling 4: in #424, with what the earlier stretches leave behind).
  const nextPlans = new Map<string, PlanCandidate>();
  // Each plan's time with its own count then resting alone, solved once for every next-best search it's in.
  const counted = new Map<PlanCandidate, number>();
  const countedSeconds = (candidate: PlanCandidate) => {
    const { plan, step } = candidate;
    if (step === null) return aloneSeconds(plan);
    let seconds = counted.get(candidate);
    if (seconds === undefined) {
      seconds = bladeburnerSecondsToRank(withCount(step), rank, target);
      counted.set(candidate, seconds);
    }
    return seconds;
  };
  const nextAfter = (name: string) => {
    if (!nextBest.has(name)) {
      const others = pool.filter(({ candidate }) => candidate.name !== name);
      const [best] = search(others, false, countedSeconds, false);
      const step = best === undefined || !Number.isFinite(best.seconds) ? undefined : best.candidate.step;
      // None faster than the tail straight away (#392): the tail follows the plan's own count.
      const tailOnly = tailRate > 0 ? distance / tailRate : Number.POSITIVE_INFINITY;
      const none = best === undefined || !Number.isFinite(best.seconds) || !(best.seconds < tailOnly);
      nextBest.set(
        name,
        none
          ? undefined
          : step === null || step === undefined
            ? bladeburnerRestStep(best.candidate.plan.rankPerSecond)
            : withCount(step),
      );
      if (!none) nextPlans.set(name, best.candidate);
    }
    return nextBest.get(name);
  };
  // A plan's expected time from the reading (#421's ruling 3): its walk's, less the seconds its first attempt saves
  // (the action under way's time left: the first attempt always runs, its draw the same, so exactly that less).
  const secondsOf = ({ plan, step, name, firstDiscount }: PlanCandidate) => {
    if (step === null) return aloneSeconds(plan);
    const bounded = (step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY && name !== null;
    if (!bounded) return bladeburnerSecondsToRank(unbounded(step), rank, target) - firstDiscount;
    const next = nextAfter(name);
    return (
      bladeburnerSecondsToRank({ ...step, ...(next === undefined ? { tailRate } : { next }) }, rank, target) -
      firstDiscount
    );
  };
  // The plan the chain follows a plan's count with (#421's term 2: check 3's walks follow the rule's own chain).
  const nextOf = ({ step, name }: PlanCandidate): BladeburnerChainNext | undefined => {
    if (step === null || name === null || !((step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY)) {
      return undefined;
    }
    if (nextAfter(name) === undefined) return undefined;
    const plan = nextPlans.get(name)?.plan;
    if (plan === undefined) return undefined;
    return { name: plan.work?.name ?? null, level: plan.work?.level ?? null, rest: plan.rest.name };
  };
  const solved = search(pool, true, secondsOf, !prune);
  return solved.map(({ candidate, seconds }) => {
    const next = nextOf(candidate);
    return { ...candidate.plan, toTarget: { target, seconds, ...(next === undefined ? {} : { next }) } };
  });
}

/**
 * `chooseBladeburnerAction` with each input solved once (#392, #390's review: the run report solved the same reading's
 * plan in each of its folds, a far target's hundreds of milliseconds each time): keyed by the input, the city read
 * (ratio 1, Raid there) the same as none. One a reading: its figures are that reading's.
 */
export function memoizedBladeburnerChoice(): typeof chooseBladeburnerAction {
  const solved = new Map<string, BladeburnerActionPlan>();
  return (input) => {
    const { city, ...rest } = input;
    const key = JSON.stringify(city === undefined || (city.ratio === 1 && city.raid) ? rest : input);
    let plan = solved.get(key);
    if (plan === undefined) {
      plan = chooseBladeburnerAction(input);
      solved.set(key, plan);
    }
    return plan;
  };
}

/** What the rule's forecast reads (#375): `chooseBladeburnerAction`'s figures but the skills. */
export type BladeburnerForecastInput = Omit<Parameters<typeof chooseBladeburnerAction>[0], "skills" | "target">;

/**
 * The skills to buy (#379): core's `planBladeburnerSkills` from the levels and points read, each set of levels
 * weighed by this rule's forecast there (`chooseBladeburnerAction`'s cycle of work and rest).
 */
export function chooseBladeburnerSkills(
  input: BladeburnerForecastInput,
  { levels, points, costMultiplier }: { levels: BladeburnerSkillLevels; points: number; costMultiplier: number },
): BladeburnerSkillPlan {
  return planBladeburnerSkills({
    levels,
    points,
    costMultiplier,
    rankPerSecond: bladeburnerForecastRater(input, levels),
  });
}

/**
 * B3's forecast (#408: the route's estimate runs B3's rule at each step): `chooseBladeburnerAction`'s rank a second at
 * skill levels `planned` over `read`, the same figure to the bit (tested), with what the skills don't move (each
 * level's rank, loss and stamina) worked out once a reading, and no plan built: the most of resting alone and each
 * contract's and operation's cycle at each level and rest, its count not short.
 */
export function bladeburnerForecastRater(
  { readings, person, stamina, maxStamina, rankMultiplier, speed, city, forecast }: BladeburnerForecastInput,
  read: BladeburnerSkillLevels,
): (planned: BladeburnerSkillLevels) => number {
  const readMults = bladeburnerSkillMultsOf(read);
  const at = forecast ?? person;
  const penalty = staminaPenalty(stamina, maxStamina);
  const personRatio = forecast === undefined ? 1 : personCompetenceFactor(forecast) / personCompetenceFactor(person);
  const rows = readings.flatMap((reading) => {
    const action = bladeburnerLevelledAction(reading.type, reading.name);
    if (action === null || (city !== undefined && !city.raid && action.name === "Raid")) return [];
    const levels: { level: number; baseTime: number; gain: number; loss: number; cost: number }[] = [];
    for (let level = 1; level <= Math.max(1, reading.maxLevel); level++) {
      levels.push({
        level,
        baseTime: actionDifficulty(action, level) / BLADEBURNER_CONSTANTS.difficultyToTimeFactor,
        gain: actionRankGain(action, level, rankMultiplier),
        loss: actionRankLoss(action, level),
        cost: actionStaminaCost(action, level),
      });
    }
    return [{ action, reading, readCompetence: actionSkillCompetence(action, person, readMults), levels }];
  });
  return (planned) => {
    const mults = bladeburnerSkillMultsOf(planned);
    const maxPlanned = maxStaminaAtSkills(person, maxStamina, readMults, mults, at);
    const regain = staminaGainPerSecond(at, maxPlanned, mults);
    const rests = bladeburnerRests(regain, maxPlanned, rankMultiplier);
    const worthResting = rests.filter(
      (rest) =>
        !rests.some(
          (other) =>
            other !== rest &&
            other.staminaPerSecond >= rest.staminaPerSecond &&
            other.rankPerSecond >= rest.rankPerSecond &&
            (other.staminaPerSecond > rest.staminaPerSecond || other.rankPerSecond > rest.rankPerSecond),
        ),
    );
    let best = rests.reduce((most, each) => (each.rankPerSecond > most.rankPerSecond ? each : most)).rankPerSecond;
    const statFactor = actionStatFactor(at, mults);
    for (const { action, reading, readCompetence, levels } of rows) {
      const skillRatio = !(readCompetence > 0)
        ? 1
        : (actionSkillCompetence(action, at, mults) / readCompetence) * personRatio;
      const ratio = skillRatio * (city?.ratio ?? 1);
      for (const { level, baseTime, gain, loss, cost } of levels) {
        const chance = chanceLowAt(action, reading, level, penalty, ratio);
        if (chance === null) continue;
        const seconds = Math.ceil(Math.max(1, (baseTime * mults.actionTime) / statFactor));
        if (reading.count < 1 + (BLADEBURNER_READING_SECONDS * speed) / seconds) continue;
        const rate = (chance * gain - (1 - chance) * loss) / seconds;
        const drain = cost / seconds - regain;
        for (const rest of worthResting) {
          const duty =
            drain <= 0 ? 1 : rest.staminaPerSecond > 0 ? rest.staminaPerSecond / (drain + rest.staminaPerSecond) : 0;
          if (duty === 0) continue;
          const cycle = duty * rate + (1 - duty) * rest.rankPerSecond;
          if (cycle > best) best = cycle;
        }
      }
    }
    return best;
  };
}

/**
 * Whether to work now (#375): below ½ max stamina, rest (the penalty's edge, `Bladeburner.ts:167-169`); rested, back
 * to work only at the max, so the switches (each losing the action under way, `Bladeburner.ts:186-188`) come once a
 * cycle. The regain doesn't depend on the stamina, so resting to the max costs no time over resting to ½ max.
 */
export function bladeburnerResting({
  stamina,
  maxStamina,
  wasResting,
}: {
  stamina: number;
  maxStamina: number;
  wasResting: boolean;
}): boolean {
  if (stamina < 0.5 * maxStamina) return true;
  if (stamina >= maxStamina) return false;
  return wasResting;
}
