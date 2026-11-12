/**
 * Bladeburner (#359), slice B2 (#375): the actions and the stamina. The game's figures for contracts, operations and
 * the general actions, its formulas for success, time, rank, money and stamina, and the rule's choice by rank a second.
 * Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **Success** (`Actions/Action.ts:169-196`): min(1, competence / difficulty). Competence is the sum over the seven
 *   stats of weight × level^decay (a combat stat's level times its skill multiplier, `Bladeburner.ts:759-774`), times
 *   the intelligence bonus 1 + 0.75·int^0.8/600 (`PersonObjects/formulas/intelligence.ts`), the stamina penalty
 *   min(1, stamina / (½ max)) (`Bladeburner.ts:167-169`), an operation's team bonus (teamCount + 1)^0.05
 *   (`Actions/Operation.ts:447-449`), the population's (pop / 1e9)^0.7 (`Action.ts:88-92`), the skills' and the
 *   augmentations' `bladeburner_success_chance`. Difficulty is base × fac^(level − 1) (`Actions/LevelableAction.ts:
 *   255-261`), times √(1 + chaos − 50) over 50 chaos (`Action.ts:94-103`). Raid is 0 with no communities
 *   (`Actions/Operation.ts:414-419`).
 * - **The estimate** (`Action.ts:144-167`): the game's range is the chance at the true population (`real`) and at its
 *   estimate (`est`), real ± |real − est|, the low end times pop/popEst below 1, the high end above; each clamped to
 *   [0, 1]. The NS API's `getActionEstimatedSuccessChance` is this range (`NetscriptFunctions/Bladeburner.ts:138-143`).
 * - **Time** (`Action.ts:105-122`): ⌈max(1, difficulty/10 × the skills' time multiplier / statFac)⌉ s, statFac
 *   ½(agi^0.04 + dex^0.035 + agi/10,000 + dex/10,000) on the effective levels; the general actions' are fixed
 *   (`data/GeneralActions.ts`): Training and Field Analysis 30 s, Diplomacy, the Regeneration Chamber and Incite
 *   Violence 60 s.
 * - **Rank** (`Formulas.ts:9-40`): a success gains rankGain × rewardFac^(level − 1) × the BitNode's
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
 *   (`Actions/LevelableAction.ts:241-244`, `:1299-1301`).
 * - **Levels:** level M + 1 opens after ⌈½·M·(2b + M − 1)⌉ successes, b 3 for contracts and 2.5 for operations
 *   (`Actions/LevelableAction.ts:246-253`, `data/Constants.ts`). An action set to auto-level goes to its max after
 *   each attempt (`:1006-1008`), so the rule turns that off for the level it sets.
 * - **Training's experience** is 30 × `mults.<stat>_exp` a stat (`:1096-1099`), which `gainStats` multiplies by the
 *   same multiplier again (`PersonObjects/Person.ts:192-198`): an upstream quirk, × mult², which core keeps.
 * - **Bonus time:** a second's tick takes up to 5 seconds' stored cycles (`:1376-1380`), so the actions run up to 5
 *   times as fast while there is bonus time (`getBonusTime`, `NetscriptFunctions/Bladeburner.ts:367-370`).
 * - **One focus:** any other work stops the action, and starting one stops the work (`:178-180`, `:1356-1368`).
 * Left out, and labelled: the skills (B3: their multipliers at 1 here, `getSkillMult`'s default, `:755-757`), the
 * cities and chaos (B4), Black Ops (B5), teams (an operation's team bonus at 0 members: 1) and random events.
 */

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

/** An action's difficulty at `level`: base × fac^(level − 1) (`Actions/LevelableAction.ts:255-261`). */
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
 * The chance of `action` at `level` (`Actions/Action.ts:169-196`), at a city's population (the true one for the real
 * chance, the estimate for the estimated), with the stamina penalty. The skills at 0 and no team: their multipliers 1
 * (B3's, and labelled). Raid is 0 with no communities (`Actions/Operation.ts:414-419`).
 */
export function actionSuccessChance(
  action: BladeburnerLevelledAction,
  level: number,
  person: BladeburnerPerson,
  { city, penalty }: { city: BladeburnerCityFigures; penalty: number },
): number {
  if (action.name === "Raid" && city.communities <= 0) return 0;
  let difficulty = actionDifficulty(action, level);
  let competence = 0;
  for (const stat of BLADEBURNER_PERSON_STATS) {
    competence += action.weights[stat] * person.skills[stat] ** action.decays[stat];
  }
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

/** statFac: ½(agi^0.04 + dex^0.035 + agi/10,000 + dex/10,000) (`Actions/Action.ts:110-117`). */
function actionStatFactor(person: BladeburnerPerson): number {
  const c = BLADEBURNER_CONSTANTS;
  const agility = person.skills.agility;
  const dexterity = person.skills.dexterity;
  return (
    0.5 *
    (agility ** c.effAgiExponentialFactor +
      dexterity ** c.effDexExponentialFactor +
      agility / c.effAgiLinearFactor +
      dexterity / c.effDexLinearFactor)
  );
}

/** A contract's or operation's time, in seconds: ⌈max(1, difficulty/10 / statFac)⌉ (`Actions/Action.ts:105-122`). */
export function actionSeconds(action: BladeburnerLevelledAction, level: number, person: BladeburnerPerson): number {
  const baseTime = actionDifficulty(action, level) / BLADEBURNER_CONSTANTS.difficultyToTimeFactor;
  return Math.ceil(Math.max(1, baseTime / actionStatFactor(person)));
}

/** A success's rank: rankGain × rewardFac^(level − 1) × `BladeburnerRank`, ±10% (`Formulas.ts:9-24`). */
export function actionRankGain(action: BladeburnerLevelledAction, level: number, rankMultiplier: number): number {
  return action.rankGain * action.rewardFac ** (level - 1) * rankMultiplier;
}

/** A failure's rank lost: rankLoss × rewardFac^(level − 1), not BitNode-scaled, ±10% (`Formulas.ts:26-40`). */
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

/** The max stamina: (agi^0.8 + bonus) × `bladeburner_max_stamina` (`Bladeburner.ts:1329-1337`). */
export function maxStaminaOf(person: BladeburnerPerson, staminaBonus: number): number {
  return Math.max((person.skills.agility ** 0.8 + staminaBonus) * person.mults.bladeburner_max_stamina, 1e-9);
}

/** The stamina regained a second: (0.0085 + max/70,000) × agi^0.17 × `bladeburner_stamina_gain` (`:1319-1327`). */
export function staminaGainPerSecond(person: BladeburnerPerson, maxStamina: number): number {
  const c = BLADEBURNER_CONSTANTS;
  const gain = (c.staminaGainPerSecond + maxStamina / c.maxStaminaToGainFactor) * person.skills.agility ** 0.17;
  return Math.max(0, gain * person.mults.bladeburner_stamina_gain);
}

/** The successes level `maxLevel` + 1 opens after: ⌈½·M·(2b + M − 1)⌉ (`Actions/LevelableAction.ts:251-253`). */
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

/** Field Analysis's rank: 0.1 × `BladeburnerRank`, no offset (`Formulas.ts:10-13`, `Bladeburner.ts:1136-1140`). */
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
 * sets, replaces. Null with no penalty to divide by (stamina at 0).
 */
export function chanceLowAt(
  action: BladeburnerLevelledAction,
  read: BladeburnerActionReading,
  level: number,
  penalty: number,
): number | null {
  if (!(penalty > 0)) return null;
  const atRead = Math.min(1, read.chance[0] / penalty);
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
}

/**
 * The work a cycle of work and rest gains most rank a second with (#375), each contract and operation at each level
 * up to its max, and the rest with it:
 * - **The chance:** the estimate's low end (`chanceLowAt`), from the game's range as last read.
 * - **The rank:** an attempt's mean, a success's gain against a failure's loss (`attemptRankMoments`), over its time.
 * - **The counts:** an action needs its next attempt and those until the next reading: 1 + 10 s × the bonus time's
 *   speed over its time. Under 1 the game stops it (`Actions/LevelableAction.ts:241-244`), idle until the rule's next turn.
 * - **The stamina:** worked from ½ max, the penalty's edge, and rested below. Over a cycle the time worked is the
 *   rest's gain over the work's net drain (its stamina an attempt over its time, less the regain) plus that gain. A work that
 *   drains nothing is worked all the time.
 * - **The rest:** the best of the three with that work, by the cycle's rank a second; and resting alone (Field
 *   Analysis's rank) when no work beats it.
 * - **Ties:** the first in the game's order (contracts, then operations, each level from 1).
 * Left out, and labelled: a failure's HP, which costs money at the hospital, not rank (its mean is `hpLoss`, the
 * money's trade the planner's); money (contracts pay as a by-product); the skills, teams and chaos (B3, B4).
 */
export function chooseBladeburnerAction({
  readings,
  person,
  stamina,
  maxStamina,
  rankMultiplier,
  speed,
}: {
  readings: readonly BladeburnerActionReading[];
  person: BladeburnerPerson;
  stamina: number;
  maxStamina: number;
  rankMultiplier: number;
  /** Game seconds a real second: 5 with bonus time, else 1. */
  speed: number;
}): BladeburnerActionPlan {
  const regain = staminaGainPerSecond(person, maxStamina);
  const rests = bladeburnerRests(regain, maxStamina, rankMultiplier);
  const penalty = staminaPenalty(stamina, maxStamina);
  const restAlone = rests.reduce((best, each) => (each.rankPerSecond > best.rankPerSecond ? each : best));
  let best: BladeburnerActionPlan = {
    work: null,
    rest: restAlone,
    duty: 0,
    rankPerSecond: restAlone.rankPerSecond,
    regain,
  };
  for (const read of readings) {
    const action = bladeburnerLevelledAction(read.type, read.name);
    if (action === null) continue;
    for (let level = 1; level <= Math.max(1, read.maxLevel); level++) {
      const chance = chanceLowAt(action, read, level, penalty);
      if (chance === null) continue;
      const seconds = actionSeconds(action, level, person);
      if (read.count < 1 + (BLADEBURNER_READING_SECONDS * speed) / seconds) continue;
      const { mean, variance } = attemptRankMoments(
        chance,
        actionRankGain(action, level, rankMultiplier),
        actionRankLoss(action, level),
      );
      const rate = mean / seconds;
      const cost = actionStaminaCost(action, level);
      const drain = cost / seconds - regain;
      for (const rest of rests) {
        const duty =
          drain <= 0 ? 1 : rest.staminaPerSecond > 0 ? rest.staminaPerSecond / (drain + rest.staminaPerSecond) : 0;
        const cycle = duty * rate + (1 - duty) * rest.rankPerSecond;
        if (!(cycle > best.rankPerSecond) || duty === 0) continue;
        best = {
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
      }
    }
  }
  return best;
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
