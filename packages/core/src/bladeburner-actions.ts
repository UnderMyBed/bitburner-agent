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
 * 0 members: 1) and random events.
 */
import {
  type BladeburnerSkillLevels,
  type BladeburnerSkillMults,
  type BladeburnerSkillPlan,
  bladeburnerSkillMultsOf,
  NO_BLADEBURNER_SKILLS,
  planBladeburnerSkills,
} from "./bladeburner-skills.ts";
import {
  type BladeburnerRankSource,
  type BladeburnerRankStep,
  bladeburnerAttemptsInCount,
  bladeburnerCycleStep,
  bladeburnerRestStep,
  bladeburnerSecondsToRank,
  bladeburnerSecondsToRankAtLeast,
  bladeburnerStepRise,
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

/** The game's constants (`data/Constants.ts`). */
export const BLADEBURNER_CONSTANTS = {
  staminaGainPerSecond: 0.0085,
  baseStaminaLoss: 0.285,
  maxStaminaToGainFactor: 70_000,
  difficultyToTimeFactor: 10,
  diffMultExponentialFactor: 0.28,
  diffMultLinearFactor: 650,
  effAgiLinearFactor: 10e3,
  effDexLinearFactor: 10e3,
  effAgiExponentialFactor: 0.04,
  effDexExponentialFactor: 0.035,
  populationThreshold: 1e9,
  populationExponent: 0.7,
  chaosThreshold: 50,
  actionCountGrowthPeriod: 480,
  contractSuccessesPerLevel: 3,
  operationSuccessesPerLevel: 2.5,
  contractBaseMoneyGain: 250e3,
  hrcStaminaGainPercent: 1,
  /** A tick takes at most this many seconds' stored cycles (`Bladeburner.ts:1379`): bonus time's speed. */
  maxSecondsPerTick: 5,
} as const;

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

/** The chaos's factor on difficulty: √(1 + chaos − 50) over 50, else 1 (`Actions/Action.ts:94-103`). */
export function chaosDifficultyFactor(chaos: number): number {
  const { chaosThreshold } = BLADEBURNER_CONSTANTS;
  return chaos > chaosThreshold ? (1 + (chaos - chaosThreshold)) ** 0.5 : 1;
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
 * (`:1338-1345`), so the penalty stays.
 */
export function maxStaminaAtSkills(
  person: BladeburnerPerson,
  maxStamina: number,
  read: BladeburnerSkillMults,
  planned: BladeburnerSkillMults,
): number {
  const divisor = read.stamina * person.mults.bladeburner_max_stamina;
  const bonus = divisor > 0 ? Math.max(0, maxStamina / divisor - effectiveLevel(person, "agility", read) ** 0.8) : 0;
  return maxStaminaOf(person, bonus, planned);
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
  /** The estimate's low end there (`chanceLowAt`), the stamina penalty out. */
  chance: number;
  /** An attempt's rank, mean and variance; its seconds; its stamina; its HP lost on failure; its money on success. */
  rankMean: number;
  rankVariance: number;
  seconds: number;
  stamina: number;
  hpLoss: number;
  money: number;
  /** Rank a second while it runs: `rankMean` / `seconds`. */
  rankPerSecond: number;
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
  /** Under a current-rank target (#386): the target, and the expected game seconds to it with this plan. */
  toTarget?: { target: number; seconds: number };
}

/**
 * The work a cycle of work and rest gains most rank a second with (#375), each contract and operation at each level
 * up to its max, and the rest with it:
 * - **The chance:** the estimate's low end (`chanceLowAt`), from the game's range as last read.
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
 *   action's low end scales by `city.ratio` (core's `cityCompetenceRatio`: the estimates' and the chaos factors'),
 *   as with the skills; Raid out where `city.raid` is false (no communities, `Actions/Operation.ts:63-68`). None
 *   given: the city read.
 * - **Under a current-rank target** (#386, `target`, ./bladeburner-targets.ts): the plan with the least expected time
 *   to it (`fastestToTarget`), not the most rank a second; met (the rank at it), rank a second. Training never rests
 *   better than Field Analysis (less stamina, no rank), so it isn't weighed.
 * Left out, and labelled: a failure's HP (#377's review), which costs money at the hospital, not rank (its mean is
 * `hpLoss`; the run report shows the visits and their money): so the choice is optimistic for the actions that lose
 * the most HP (Raid about 386 a failure, Stealth Retirement 85, Assassination 50, Bounty Hunter 5, against 20 HP at
 * defense 100), the money traded for rank the planner's (decision 67); money (contracts pay as a by-product); teams;
 * the chaos and population the actions themselves move (B4's, read, not forecast).
 */
export function chooseBladeburnerAction(input: BladeburnerActionInput): BladeburnerActionPlan {
  const { candidates, supply } = planCandidates(input);
  const { target } = input;
  if (target === undefined || !(target.rank < target.target)) {
    // Rank a second: the first with the most, in the game's order (resting alone first).
    let best = (candidates[0] as PlanCandidate).plan;
    for (const { plan } of candidates) if (plan.rankPerSecond > best.rankPerSecond) best = plan;
    return best;
  }
  return fastestToTarget(candidates, supply, target, true)[0] as BladeburnerActionPlan;
}

/**
 * Every plan the rule weighs under `input.target` (#386), in the game's order (resting alone first), each with its
 * expected time to the target (`toTarget`), none ruled out by Wald's bound: what the tests check the choice against.
 * Empty with no target, or one met.
 */
export function bladeburnerPlansToTarget(input: BladeburnerActionInput): BladeburnerActionPlan[] {
  const { target } = input;
  if (target === undefined || !(target.rank < target.target)) return [];
  const { candidates, supply } = planCandidates(input);
  return fastestToTarget(candidates, supply, target, false);
}

/** `chooseBladeburnerAction`'s input. */
export type BladeburnerActionInput = Parameters<typeof planCandidates>[0];

/** A plan weighed: its plan, its walk's step (null: resting alone), and its action's name (null: resting alone). */
interface PlanCandidate {
  plan: BladeburnerActionPlan;
  step: BladeburnerRankStep | null;
  name: string | null;
}

/** Every plan `chooseBladeburnerAction` weighs, in the game's order, resting alone first. */
function planCandidates({
  readings,
  person,
  stamina,
  maxStamina,
  rankMultiplier,
  speed,
  skills = {},
  city,
}: {
  readings: readonly BladeburnerActionReading[];
  person: BladeburnerPerson;
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
}): { candidates: PlanCandidate[]; supply: BladeburnerRankSource[] } {
  const readMults = bladeburnerSkillMultsOf(skills.read ?? {});
  const mults = skills.planned === undefined ? readMults : bladeburnerSkillMultsOf(skills.planned);
  const maxPlanned =
    skills.planned === undefined ? maxStamina : maxStaminaAtSkills(person, maxStamina, readMults, mults);
  const regain = staminaGainPerSecond(person, maxPlanned, mults);
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
  const candidates: PlanCandidate[] = [{ plan: alone, step: null, name: null }];
  // Each action's long-run supply (#392's decision, #395's review): every way to work it, whatever its count now (its
  // regrowth is the action's).
  const supply: BladeburnerRankSource[] = [];
  for (const read of readings) {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action === null) continue;
    if (city !== undefined && !city.raid && action.name === "Raid") continue;
    const options: { rise: number; seconds: number }[] = [];
    supply.push({ growthPerSecond: countGrowthPerSecond(action), options });
    const readCompetence = actionSkillCompetence(action, person, readMults);
    const skillRatio =
      skills.planned === undefined || !(readCompetence > 0)
        ? 1
        : actionSkillCompetence(action, person, mults) / readCompetence;
    const ratio = skillRatio * (city?.ratio ?? 1);
    for (let level = 1; level <= Math.max(1, read.maxLevel); level++) {
      const chance = chanceLowAt(action, read, level, penalty, ratio);
      if (chance === null) continue;
      const seconds = actionSeconds(action, level, person, mults);
      const short = read.count < 1 + (BLADEBURNER_READING_SECONDS * speed) / seconds;
      const gain = actionRankGain(action, level, rankMultiplier);
      const loss = actionRankLoss(action, level);
      const { mean, variance } = attemptRankMoments(chance, gain, loss);
      const rate = mean / seconds;
      const cost = actionStaminaCost(action, level);
      const drain = cost / seconds - regain;
      for (const rest of worthResting) {
        const duty =
          drain <= 0 ? 1 : rest.staminaPerSecond > 0 ? rest.staminaPerSecond / (drain + rest.staminaPerSecond) : 0;
        const cycle = duty * rate + (1 - duty) * rest.rankPerSecond;
        if (duty === 0) continue;
        const cycleStep = bladeburnerCycleStep({
          chance,
          gain,
          loss,
          seconds,
          duty,
          restRankPerSecond: rest.rankPerSecond,
        });
        options.push({ rise: bladeburnerStepRise(cycleStep), seconds: cycleStep.seconds });
        if (short) continue;
        // Its count bounds its attempts (#386's amendment): the next-best's after them (`fastestToTarget`).
        const step = {
          ...cycleStep,
          attempts: bladeburnerAttemptsInCount(read.count, countGrowthPerSecond(action), cycleStep.seconds),
        };
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
            hpLoss: actionHpLoss(action, level),
            money: actionMoney(action, level),
            rankPerSecond: rate,
          },
          rest,
          duty,
          rankPerSecond: cycle,
          regain,
        };
        candidates.push({ plan, step, name: action.name });
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
 *   `bladeburnerSustainableRate`: each action's best plan up to its count's regrowth, the most rank a second first,
 *   the rest resting alone), common to every plan. Far from the target the choice is the stock's best rank a second.
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
    const counted = (step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY;
    if (!counted) return bladeburnerSecondsToRankAtLeast(step, rank, target);
    // The next-best's search: its own count, then the tail. The choice's: the plan's count, then its next-best's.
    if (!bounded || name === null) return leastThrough([withCount(step)]);
    const next = nextAfter(name);
    return next === undefined ? leastThrough([withCount(step)]) : leastThrough([step, ...sequenceOf(next)]);
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
  // The tail after the stock (#392's decision): the sustainable rate, each action's best plan's rank a second of its
  // cycle up to its count's growth, the rest resting alone (the first candidate's, Field Analysis's).
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
      nextBest.set(
        name,
        best === undefined || !Number.isFinite(best.seconds) || !(best.seconds < tailOnly)
          ? undefined
          : step === null || step === undefined
            ? bladeburnerRestStep(best.candidate.plan.rankPerSecond)
            : withCount(step),
      );
    }
    return nextBest.get(name);
  };
  const secondsOf = ({ plan, step, name }: PlanCandidate) => {
    if (step === null) return aloneSeconds(plan);
    const bounded = (step.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY && name !== null;
    if (!bounded) return bladeburnerSecondsToRank(unbounded(step), rank, target);
    const next = nextAfter(name);
    return bladeburnerSecondsToRank({ ...step, ...(next === undefined ? { tailRate } : { next }) }, rank, target);
  };
  const solved = search(pool, true, secondsOf, !prune);
  return solved.map(({ candidate, seconds }) => ({ ...candidate.plan, toTarget: { target, seconds } }));
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
    rankPerSecond: (planned) => chooseBladeburnerAction({ ...input, skills: { read: levels, planned } }).rankPerSecond,
  });
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
