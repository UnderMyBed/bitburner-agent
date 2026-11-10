/**
 * Gangs (#325, slice G1 of the gangs epic #324; ascension, #328, G2; equipment, #330, G3): the game's gang facts and
 * formulas, and the brain's rule for a gang that grows: which faction it's formed with, who is recruited, who ascends,
 * each member's task, and its equipment. Paths are `vendor/bitburner-src/src/`'s. The formulas are the game's own
 * (`Gang/formulas/formulas.ts`, `Gang/GangMember.ts`), checked against the engine's `ns.formulas.gang` and
 * `getTaskStats` in the brain's parity suite (`gang-parity.test.ts`). In-game code bundles the protocol's part (the
 * worker names, `GANG_TASK_NAMES`), so no name here is an NS function's (packages/ingame/README.md, "RAM"):
 * `gangRespectPerCycle`, never `respectGain`.
 */

/** The factions a gang can be formed with, in the game's order (`Gang/data/Constants.ts:18-26`). */
export const GANG_FACTIONS = [
  "Slum Snakes",
  "Tetrads",
  "The Syndicate",
  "The Dark Army",
  "Speakers for the Dead",
  "NiteSec",
  "The Black Hand",
] as const;

/** Those whose gang is a hacking gang (`NetscriptFunctions/Gang.ts:49`); the other five make a combat gang. */
export const HACKING_GANG_FACTIONS: readonly string[] = ["NiteSec", "The Black Hand"];

/** Members recruited with no respect (`Constants.ts:6`). */
export const GANG_FREE_MEMBERS = 3;
/** The base of the respect a recruit beyond the free ones needs (`Constants.ts:8`). */
export const GANG_RECRUIT_RESPECT_BASE = 5;
/** The most members a gang has (`Constants.ts:11`). */
export const GANG_MOST_MEMBERS = 12;
/** A gang cycle, as the engine's (`CONSTANTS.MilliPerCycle`): the formulas' rates are per cycle. */
export const GANG_CYCLE_MS = 200;
/**
 * The wanted level's fall each time the gang processes, per member on a task that lowers it (`Gang.ts:161`): × (1 −
 * 0.001 × those members), on top of their own gains. The gang processes 10 cycles every 2 s (`Constants.ts:29`,
 * `engine.tsx:106`).
 */
export const GANG_JUSTICE_DECAY_PER_PROCESS = 0.001;
export const GANG_CYCLES_PER_PROCESS = 10;
/**
 * The cycles a process takes in bonus time, the game's stored cycles (`Constants.ts:30-31`, `Gang.ts:100-104`): 25, with
 * the justice decay still once a process (`Gang.ts:161`), so 2.5 times slower a cycle.
 */
export const GANG_BONUS_CYCLES_PER_PROCESS = 25;

/**
 * Whether the gang is in bonus time, from `ns.gang.getBonusTime()` (its stored cycles × 200 ms,
 * `NetscriptFunctions/Gang.ts:340-343`): in normal time it stores under 10 cycles between processes (`Gang.ts:99-101`),
 * under 2 s; more is bonus time, processed 25 cycles a call.
 */
export function gangInBonusTime(bonusTimeMs: number | undefined): boolean {
  return (bonusTimeMs ?? 0) > GANG_CYCLES_PER_PROCESS * GANG_CYCLE_MS;
}

/** The six stats, by the game's short names (`GangMember.ts:35-40`). */
export const GANG_STATS = ["hack", "str", "def", "dex", "agi", "cha"] as const;
export type GangStat = (typeof GANG_STATS)[number];

/** A task's parameters, as `ns.gang.getTaskStats` gives them (`Gang/GangMemberTask.ts`). */
export interface GangTask {
  name: string;
  isHacking: boolean;
  isCombat: boolean;
  baseRespect: number;
  baseWanted: number;
  baseMoney: number;
  hackWeight: number;
  strWeight: number;
  defWeight: number;
  dexWeight: number;
  agiWeight: number;
  chaWeight: number;
  difficulty: number;
  territory: { money: number; respect: number; wanted: number };
}

const NO_TERRITORY = { money: 1, respect: 1, wanted: 1 };
/** A task from the game's metadata (`Gang/data/tasks.ts`), with the defaults its constructor fills in. */
function task(
  name: string,
  { hacking, combat }: { hacking: boolean; combat: boolean },
  params: Partial<Omit<GangTask, "name" | "isHacking" | "isCombat">>,
): GangTask {
  return {
    name,
    isHacking: hacking,
    isCombat: combat,
    baseRespect: 0,
    baseWanted: 0,
    baseMoney: 0,
    hackWeight: 0,
    strWeight: 0,
    defWeight: 0,
    dexWeight: 0,
    agiWeight: 0,
    chaWeight: 0,
    difficulty: 1,
    territory: NO_TERRITORY,
    ...params,
  };
}
const HACKING = { hacking: true, combat: false };
const COMBAT = { hacking: false, combat: true };
const BOTH = { hacking: true, combat: true };

/**
 * Every task, in the game's order (`Gang/data/tasks.ts:31-395`). Typed from the source; the parity suite checks each
 * against the engine's `getTaskStats`, so a game bump that changes one fails CI.
 */
export const GANG_TASKS: readonly GangTask[] = [
  task("Unassigned", BOTH, { hackWeight: 100 }),
  task("Ransomware", HACKING, { baseRespect: 0.00005, baseWanted: 0.0001, baseMoney: 3, hackWeight: 100 }),
  task("Phishing", HACKING, {
    baseRespect: 0.00008,
    baseWanted: 0.003,
    baseMoney: 7.5,
    hackWeight: 85,
    chaWeight: 15,
    difficulty: 3.5,
  }),
  task("Identity Theft", HACKING, {
    baseRespect: 0.0001,
    baseWanted: 0.075,
    baseMoney: 18,
    hackWeight: 80,
    chaWeight: 20,
    difficulty: 5,
  }),
  task("DDoS Attacks", HACKING, { baseRespect: 0.0004, baseWanted: 0.2, hackWeight: 100, difficulty: 8 }),
  task("Plant Virus", HACKING, { baseRespect: 0.0006, baseWanted: 0.4, hackWeight: 100, difficulty: 12 }),
  task("Fraud & Counterfeiting", HACKING, {
    baseRespect: 0.0004,
    baseWanted: 0.3,
    baseMoney: 45,
    hackWeight: 80,
    chaWeight: 20,
    difficulty: 20,
  }),
  task("Money Laundering", HACKING, {
    baseRespect: 0.001,
    baseWanted: 1.25,
    baseMoney: 360,
    hackWeight: 75,
    chaWeight: 25,
    difficulty: 25,
  }),
  task("Cyberterrorism", HACKING, {
    baseRespect: 0.01,
    baseWanted: 6,
    hackWeight: 80,
    chaWeight: 20,
    difficulty: 36,
  }),
  task("Ethical Hacking", HACKING, { baseWanted: -0.001, baseMoney: 3, hackWeight: 90, chaWeight: 10 }),
  task("Mug People", COMBAT, {
    baseRespect: 0.00005,
    baseWanted: 0.00005,
    baseMoney: 3.6,
    strWeight: 25,
    defWeight: 25,
    dexWeight: 25,
    agiWeight: 10,
    chaWeight: 15,
  }),
  task("Deal Drugs", COMBAT, {
    baseRespect: 0.00006,
    baseWanted: 0.002,
    baseMoney: 15,
    agiWeight: 20,
    dexWeight: 20,
    chaWeight: 60,
    difficulty: 3.5,
    territory: { money: 1.2, respect: 1, wanted: 1.15 },
  }),
  task("Strongarm Civilians", COMBAT, {
    baseRespect: 0.00004,
    baseWanted: 0.02,
    baseMoney: 7.5,
    hackWeight: 10,
    strWeight: 25,
    defWeight: 25,
    dexWeight: 20,
    agiWeight: 10,
    chaWeight: 10,
    difficulty: 5,
    territory: { money: 1.6, respect: 1.1, wanted: 1.5 },
  }),
  task("Run a Con", COMBAT, {
    baseRespect: 0.00012,
    baseWanted: 0.05,
    baseMoney: 45,
    strWeight: 5,
    defWeight: 5,
    agiWeight: 25,
    dexWeight: 25,
    chaWeight: 40,
    difficulty: 14,
  }),
  task("Armed Robbery", COMBAT, {
    baseRespect: 0.00014,
    baseWanted: 0.1,
    baseMoney: 114,
    hackWeight: 20,
    strWeight: 15,
    defWeight: 15,
    agiWeight: 10,
    dexWeight: 20,
    chaWeight: 20,
    difficulty: 20,
  }),
  task("Traffick Illegal Arms", COMBAT, {
    baseRespect: 0.0002,
    baseWanted: 0.24,
    baseMoney: 174,
    hackWeight: 15,
    strWeight: 20,
    defWeight: 20,
    dexWeight: 20,
    chaWeight: 25,
    difficulty: 32,
    territory: { money: 1.4, respect: 1.3, wanted: 1.25 },
  }),
  task("Threaten & Blackmail", COMBAT, {
    baseRespect: 0.0002,
    baseWanted: 0.125,
    baseMoney: 72,
    hackWeight: 25,
    strWeight: 25,
    dexWeight: 25,
    chaWeight: 25,
    difficulty: 28,
  }),
  task("Human Trafficking", COMBAT, {
    baseRespect: 0.004,
    baseWanted: 1.25,
    baseMoney: 360,
    hackWeight: 30,
    strWeight: 5,
    defWeight: 5,
    dexWeight: 30,
    chaWeight: 30,
    difficulty: 36,
    territory: { money: 1.5, respect: 1.5, wanted: 1.6 },
  }),
  task("Terrorism", COMBAT, {
    baseRespect: 0.01,
    baseWanted: 6,
    hackWeight: 20,
    strWeight: 20,
    defWeight: 20,
    dexWeight: 20,
    chaWeight: 20,
    difficulty: 36,
    territory: { money: 1, respect: 2, wanted: 2 },
  }),
  task("Vigilante Justice", BOTH, {
    baseWanted: -0.001,
    hackWeight: 20,
    strWeight: 20,
    defWeight: 20,
    dexWeight: 20,
    agiWeight: 20,
    territory: { money: 1, respect: 1, wanted: 0.9 },
  }),
  task("Train Combat", BOTH, { strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 25, difficulty: 100 }),
  task("Train Hacking", BOTH, { hackWeight: 100, difficulty: 45 }),
  task("Train Charisma", BOTH, { chaWeight: 100, difficulty: 8 }),
  task("Territory Warfare", BOTH, {
    hackWeight: 15,
    strWeight: 20,
    defWeight: 20,
    dexWeight: 20,
    agiWeight: 20,
    chaWeight: 5,
    difficulty: 5,
  }),
];

/** Every task's name, the game's order. */
export const GANG_TASK_NAMES: readonly string[] = GANG_TASKS.map((each) => each.name);
export const UNASSIGNED_GANG_TASK = "Unassigned";
export const TRAIN_HACKING_TASK = "Train Hacking";
export const TRAIN_COMBAT_TASK = "Train Combat";
export const TERRITORY_WARFARE_TASK = "Territory Warfare";

/** A task by name; throws for one the game hasn't. */
export function gangTask(name: string): GangTask {
  const found = GANG_TASKS.find((each) => each.name === name);
  if (found === undefined) throw new RangeError(`${name} isn't a gang task`);
  return found;
}

/**
 * The tasks a gang of that kind may set (`Gang.ts:419-427`), Unassigned aside: a hacking gang's those marked hacking,
 * a combat gang's those marked combat.
 */
export function gangTasksFor(isHacking: boolean): GangTask[] {
  return GANG_TASKS.filter(
    (each) => each.name !== UNASSIGNED_GANG_TASK && (isHacking ? each.isHacking : each.isCombat),
  );
}

/**
 * Each BitNode's `GangSoftcap` that isn't 1 (`BitNode/BitNode.tsx`: BN3 :622, BN6 :717, BN7 :759, BN8 :795, BN9 :833,
 * BN10 :878, BN12 :987 at every level, BN13 :1034, BN14 :1079). The parity suite checks every BitNode's against the
 * engine's `getBitNodeMultipliers`.
 */
const GANG_SOFTCAPS: Readonly<Record<number, number>> = {
  3: 0.9,
  6: 0.7,
  7: 0.7,
  8: 0,
  9: 0.8,
  10: 0.9,
  12: 0.8,
  13: 0.3,
  14: 0.7,
};

/** The BitNode's `GangSoftcap`: the exponent's factor on respect and money (`formulas.ts:99`, `:143`). */
export function gangSoftcapOf(bitNode: number): number {
  return GANG_SOFTCAPS[bitNode] ?? 1;
}

/** What the formulas read of the gang (`formulas.ts:5-9`, `FormulaGang`). */
export interface GangFigures {
  respect: number;
  wantedLevel: number;
  /** The share of territory, 0 to 1: 1/7 at the start (`AllGangs.ts:11-40`). */
  territory: number;
}

/**
 * What the brain reads of a member (`ns.gang.getMemberInformation`): its task, levels, experience, equipment
 * multipliers, ascension multipliers and points (G2), and the respect it earned since its last ascension.
 */
export interface GangMemberFigures {
  name: string;
  task: string;
  /** Respect earned since the last ascension, which an ascension takes from the gang (`Gang.ts:390-393`). */
  earnedRespect: number;
  hack: number;
  str: number;
  def: number;
  dex: number;
  agi: number;
  cha: number;
  hack_exp: number;
  str_exp: number;
  def_exp: number;
  dex_exp: number;
  agi_exp: number;
  cha_exp: number;
  hack_mult: number;
  str_mult: number;
  def_mult: number;
  dex_mult: number;
  agi_mult: number;
  cha_mult: number;
  hack_asc_mult: number;
  str_asc_mult: number;
  def_asc_mult: number;
  dex_asc_mult: number;
  agi_asc_mult: number;
  cha_asc_mult: number;
  /** The ascension points each multiplier comes from (`GangMember.ts:56-61`, `:74-76`). */
  hack_asc_points: number;
  str_asc_points: number;
  def_asc_points: number;
  dex_asc_points: number;
  agi_asc_points: number;
  cha_asc_points: number;
  /**
   * The member's upgrades lost on ascension, and its augmentations, kept (G3, `GangMember.ts:63-64`, `:308-319`), by
   * name. Absent from an older Agent's reading: none.
   */
  upgrades?: readonly string[];
  augmentations?: readonly string[];
}

type MemberLevels = Pick<GangMemberFigures, GangStat>;

/** The task's weights on the member's levels, the formulas' common term (`formulas.ts:17-24`). */
export function gangStatWeight(task: GangTask, member: MemberLevels): number {
  return (
    (task.hackWeight / 100) * member.hack +
    (task.strWeight / 100) * member.str +
    (task.defWeight / 100) * member.def +
    (task.dexWeight / 100) * member.dex +
    (task.agiWeight / 100) * member.agi +
    (task.chaWeight / 100) * member.cha
  );
}

/** The share of respect and money the wanted level leaves: respect / (respect + wanted) (`formulas.ts:11-13`). */
export function gangWantedPenaltyOf(gang: GangFigures): number {
  return gang.respect / (gang.respect + gang.wantedLevel);
}

/** `max(0.005, (territory × 100)^factor / 100)` (`formulas.ts:26`, `:44`, `:68`). */
function territoryMultiplier(territory: number, factor: number): number {
  return Math.max(0.005, (territory * 100) ** factor / 100);
}

/** The softcap's exponent: (0.2 × territory + 0.8) × `GangSoftcap` (`formulas.ts:27`, `:71`). */
function softcapExponent(territory: number, softcap: number): number {
  return (0.2 * territory + 0.8) * softcap;
}

/** Respect a cycle of `task` earns (`formulas.ts:15-31`), the gang's penalty in it. */
export function gangRespectPerCycle(gang: GangFigures, member: MemberLevels, task: GangTask, softcap: number): number {
  if (task.baseRespect === 0) return 0;
  const weight = gangStatWeight(task, member) - 4 * task.difficulty;
  if (weight <= 0) return 0;
  const territoryMult = territoryMultiplier(gang.territory, task.territory.respect);
  if (Number.isNaN(territoryMult) || territoryMult <= 0) return 0;
  return (
    (11 * task.baseRespect * weight * territoryMult * gangWantedPenaltyOf(gang)) **
    softcapExponent(gang.territory, softcap)
  );
}

/** Wanted level a cycle of `task` adds (`formulas.ts:33-54`): negative for a task that lowers it. */
export function gangWantedPerCycle(gang: GangFigures, member: MemberLevels, task: GangTask): number {
  if (task.baseWanted === 0) return 0;
  const weight = gangStatWeight(task, member) - 3.5 * task.difficulty;
  if (weight <= 0) return 0;
  const territoryMult = territoryMultiplier(gang.territory, task.territory.wanted);
  if (Number.isNaN(territoryMult) || territoryMult <= 0) return 0;
  if (task.baseWanted < 0) return 0.4 * task.baseWanted * weight * territoryMult;
  return Math.min(100, (7 * task.baseWanted) / (3 * weight * territoryMult) ** 0.8);
}

/** Money a cycle of `task` earns (`formulas.ts:56-73`), the gang's penalty in it. */
export function gangMoneyPerCycle(gang: GangFigures, member: MemberLevels, task: GangTask, softcap: number): number {
  if (task.baseMoney === 0) return 0;
  const weight = gangStatWeight(task, member) - 3.2 * task.difficulty;
  if (weight <= 0) return 0;
  const territoryMult = territoryMultiplier(gang.territory, task.territory.money);
  if (Number.isNaN(territoryMult) || territoryMult <= 0) return 0;
  return (
    (5 * task.baseMoney * weight * territoryMult * gangWantedPenaltyOf(gang)) **
    softcapExponent(gang.territory, softcap)
  );
}

/**
 * A stat's level from its experience and multiplier: max(1, ⌊mult × (32 ln(exp + 534.5) − 200)⌋)
 * (`GangMember.ts:70-72`).
 */
export function gangSkillLevel(exp: number, mult: number): number {
  return Math.max(Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)), 1);
}

/**
 * Each stat's experience a cycle of `task` gives (`GangMember.ts:155-210`): weight / 1500 × difficulty^0.9 × ((mult −
 * 1) / 4 + 1) × the ascension multiplier. None unassigned.
 */
export function gangExpPerCycle(member: GangMemberFigures, task: GangTask): Record<GangStat, number> {
  const gains = { hack: 0, str: 0, def: 0, dex: 0, agi: 0, cha: 0 };
  if (task.name === UNASSIGNED_GANG_TASK) return gains;
  const difficultyMult = task.difficulty ** 0.9;
  for (const stat of GANG_STATS) {
    const weight = task[`${stat}Weight`];
    const expMult = (member[`${stat}_mult`] - 1) / 4 + 1;
    gains[stat] = (weight / 1500) * difficultyMult * expMult * member[`${stat}_asc_mult`];
  }
  return gains;
}

/**
 * The member after `cycles` of `task`: its experience gained, its levels as the game updates them
 * (`Gang.ts:274-279`).
 */
export function gangMemberAfter(member: GangMemberFigures, task: GangTask, cycles: number): GangMemberFigures {
  const gains = gangExpPerCycle(member, task);
  const after = { ...member };
  for (const stat of GANG_STATS) {
    const exp = member[`${stat}_exp`] + gains[stat] * cycles;
    after[`${stat}_exp`] = exp;
    after[stat] = gangSkillLevel(exp, member[`${stat}_mult`] * member[`${stat}_asc_mult`]);
  }
  return after;
}

/** The experience an ascension leaves out of a stat's points: its first 1,000 (`formulas.ts:75-77`). */
export const GANG_ASCENSION_EXP_LEFT_OUT = 1000;
/** The points scale of an ascension multiplier, √(points / 2,000) (`formulas.ts:79-81`). */
export const GANG_ASCENSION_POINTS_SCALE = 2000;

/** The ascension points a stat's experience gives: max(0, exp − 1,000) (`formulas.ts:75-77`). */
export function gangAscensionPointsGain(exp: number): number {
  return Math.max(exp - GANG_ASCENSION_EXP_LEFT_OUT, 0);
}

/** A stat's ascension multiplier from its points: max(1, √(points / 2,000)) (`formulas.ts:79-81`). */
export function gangAscensionMult(points: number): number {
  return Math.max(Math.sqrt(points / GANG_ASCENSION_POINTS_SCALE), 1);
}

/** Whether the game lets the member ascend: a stat's experience over 1,000 (`GangMember.ts:245-248`). */
export function gangCanAscend(member: GangMemberFigures): boolean {
  return GANG_STATS.some((stat) => gangAscensionPointsGain(member[`${stat}_exp`]) > 0);
}

/** What an ascension gives, as `ns.gang.getAscensionResult` has it. */
export type GangAscensionResult = { respect: number } & Record<GangStat, number>;

/**
 * What ascending the member now gives, as `ns.gang.getAscensionResult` (`NetscriptFunctions/Gang.ts:291-300`): the
 * respect the gang loses, the member's earned respect (`Gang.ts:390-393`), and each stat's ascension multiplier after
 * over before (`GangMember.ts:262-285`). Null when the game wouldn't ascend it (`gangCanAscend`).
 */
export function gangAscensionResult(member: GangMemberFigures): GangAscensionResult | null {
  if (!gangCanAscend(member)) return null;
  const result = { respect: member.earnedRespect, hack: 1, str: 1, def: 1, dex: 1, agi: 1, cha: 1 };
  for (const stat of GANG_STATS) {
    const points = member[`${stat}_asc_points`];
    result[stat] =
      gangAscensionMult(points + gangAscensionPointsGain(member[`${stat}_exp`])) / gangAscensionMult(points);
  }
  return result;
}

/**
 * The member after an ascension (`GangMember.ts:298-320`): each stat's points gained, its experience 0, its levels
 * recomputed, no respect earned. Its upgrades are lost and its equipment multipliers set back to 1, then its
 * augmentations applied again (G3, #330: `:308-319`), so G2's appraisal counts what they keep.
 */
export function gangMemberAscended(member: GangMemberFigures): GangMemberFigures {
  const augmentations = member.augmentations ?? [];
  const after: GangMemberFigures = { ...member, earnedRespect: 0, upgrades: [], augmentations: [...augmentations] };
  for (const stat of GANG_STATS) {
    const points = member[`${stat}_asc_points`] + gangAscensionPointsGain(member[`${stat}_exp`]);
    const ascMult = gangAscensionMult(points);
    const mult = augmentations.reduce((product, name) => product * (gangEquipment(name).mults[stat] ?? 1), 1);
    after[`${stat}_asc_points`] = points;
    after[`${stat}_asc_mult`] = ascMult;
    after[`${stat}_mult`] = mult;
    after[`${stat}_exp`] = 0;
    after[stat] = gangSkillLevel(0, mult * ascMult);
  }
  return after;
}

/** An upgrade's type, as `ns.gang.getEquipmentType` names it (`Gang/GangMemberUpgrade.ts:51-66`). */
export type GangEquipmentType = "Weapon" | "Armor" | "Vehicle" | "Rootkit" | "Augmentation";

/** An upgrade (G3): its name, its cost before the discount, its type, and its multipliers on the member's stats. */
export interface GangEquipment {
  name: string;
  cost: number;
  type: GangEquipmentType;
  mults: Readonly<Partial<Record<GangStat, number>>>;
}

const equipment = (
  type: GangEquipmentType,
  name: string,
  cost: number,
  mults: Partial<Record<GangStat, number>>,
): GangEquipment => ({ name, cost, type, mults });

/**
 * Every upgrade (G3, #330), in the game's order (`Gang/data/upgrades.ts:34-227`). Typed from the source; the parity
 * suite checks each against the engine's `getEquipmentNames`, `getEquipmentType`, `getEquipmentStats` and
 * `getEquipmentCost`, so a game bump that changes one fails CI.
 */
export const GANG_EQUIPMENT: readonly GangEquipment[] = [
  equipment("Weapon", "Baseball Bat", 1e6, { str: 1.04, def: 1.04 }),
  equipment("Weapon", "Katana", 12e6, { str: 1.08, def: 1.08, dex: 1.08 }),
  equipment("Weapon", "Malorian-3516", 25e6, { str: 1.1, def: 1.1, dex: 1.1, agi: 1.1 }),
  equipment("Weapon", "Hansen-HA7", 50e6, { str: 1.12, def: 1.1, agi: 1.1 }),
  equipment("Weapon", "Arasaka-HJSH18", 60e6, { str: 1.2, def: 1.15 }),
  equipment("Weapon", "Militech-M251s", 100e6, { str: 1.25, def: 1.2 }),
  equipment("Weapon", "Nokota-D5", 150e6, { str: 1.3, def: 1.25 }),
  equipment("Weapon", "Techtronika-SPT32", 225e6, { str: 1.3, dex: 1.25, agi: 1.3 }),
  equipment("Armor", "Bulletproof Vest", 2e6, { def: 1.04 }),
  equipment("Armor", "Full Body Armor", 5e6, { def: 1.08 }),
  equipment("Armor", "Liquid Body Armor", 25e6, { def: 1.15, agi: 1.15 }),
  equipment("Armor", "Graphene Plating Armor", 40e6, { def: 1.2 }),
  equipment("Vehicle", "Herrera Outlaw GTS", 3e6, { agi: 1.04, cha: 1.04 }),
  equipment("Vehicle", "Yaiba ASM-R250 Muramasa", 9e6, { agi: 1.08, cha: 1.08 }),
  equipment("Vehicle", "Rayfield Caliburn", 18e6, { agi: 1.12, cha: 1.12 }),
  equipment("Vehicle", "Quadra Sport R-7", 30e6, { agi: 1.16, cha: 1.16 }),
  equipment("Rootkit", "NUKE Rootkit", 5e6, { hack: 1.05 }),
  equipment("Rootkit", "Soulstealer Rootkit", 25e6, { hack: 1.1 }),
  equipment("Rootkit", "Demon Rootkit", 75e6, { hack: 1.15 }),
  equipment("Rootkit", "Hmap Node", 40e6, { hack: 1.12 }),
  equipment("Rootkit", "Jack the Ripper", 75e6, { hack: 1.15 }),
  equipment("Augmentation", "Bionic Arms", 10e9, { str: 1.3, dex: 1.3 }),
  equipment("Augmentation", "Bionic Legs", 10e9, { agi: 1.6 }),
  equipment("Augmentation", "Bionic Spine", 15e9, { str: 1.15, def: 1.15, dex: 1.15, agi: 1.15 }),
  equipment("Augmentation", "BrachiBlades", 20e9, { str: 1.4, def: 1.4 }),
  equipment("Augmentation", "Nanofiber Weave", 12e9, { str: 1.2, def: 1.2 }),
  equipment("Augmentation", "Synthetic Heart", 25e9, { str: 1.5, agi: 1.5 }),
  equipment("Augmentation", "Synfibril Muscle", 15e9, { str: 1.3, def: 1.3 }),
  equipment("Augmentation", "BitWire", 5e9, { hack: 1.05 }),
  equipment("Augmentation", "Neuralstimulator", 10e9, { hack: 1.15 }),
  equipment("Augmentation", "DataJack", 7.5e9, { hack: 1.1 }),
  equipment("Augmentation", "Graphene Bone Lacings", 50e9, { str: 1.7, def: 1.7 }),
];

/** Every upgrade's name, the game's order. */
export const GANG_EQUIPMENT_NAMES: readonly string[] = GANG_EQUIPMENT.map((each) => each.name);

/** An upgrade by name; throws for one the game hasn't. */
export function gangEquipment(name: string): GangEquipment {
  const found = GANG_EQUIPMENT.find((each) => each.name === name);
  if (found === undefined) throw new RangeError(`${name} isn't gang equipment`);
  return found;
}

/** Whether an ascension keeps the upgrade: an augmentation (`GangMember.ts:308-319`); the rest are lost. */
export function gangEquipmentKept(item: Pick<GangEquipment, "type">): boolean {
  return item.type === "Augmentation";
}

/**
 * The discount on equipment (`Gang.ts:407-416`): max(1, respect^0.01 + respect / 5e6 + power^0.01 + power / 1e6 − 1),
 * power the gang's (`Gang.ts:90-92`). A cost is the upgrade's over it (`:429-434`); `getGangInformation` gives its
 * inverse, `equipmentCostMult` (`NetscriptFunctions/Gang.ts:102`).
 */
export function gangEquipmentDiscount({ respect, power }: { respect: number; power: number }): number {
  return Math.max(1, respect ** 0.01 + respect / 5e6 + power ** 0.01 + power / 1e6 - 1);
}

/** What the upgrade costs now: its cost × the gang's `equipmentCostMult` (1 / `gangEquipmentDiscount`). */
export function gangEquipmentCost(item: Pick<GangEquipment, "cost">, costMult: number): number {
  return item.cost * costMult;
}

/** The gang's `equipmentCostMult` as read, or, from an older Agent, 1 / the discount from its respect and power. */
export function gangEquipmentCostMultOf(
  gang: Pick<GangInformation, "respect" | "power" | "equipmentCostMult">,
): number {
  return gang.equipmentCostMult ?? 1 / gangEquipmentDiscount(gang);
}

/** Whether the member has the upgrade: the game refuses one owned (`GangMember.ts:355-356`). */
export function gangMemberOwns(member: Pick<GangMemberFigures, "upgrades" | "augmentations">, name: string): boolean {
  return (member.upgrades ?? []).includes(name) || (member.augmentations ?? []).includes(name);
}

/**
 * The member with the upgrade (`GangMember.ts:343-367`): its multipliers × the upgrade's, its levels as the gang's next
 * process recomputes them (`Gang.ts:274-279`), and the upgrade in its list.
 */
export function gangMemberEquipped(member: GangMemberFigures, item: GangEquipment): GangMemberFigures {
  const after: GangMemberFigures = gangEquipmentKept(item)
    ? { ...member, augmentations: [...(member.augmentations ?? []), item.name] }
    : { ...member, upgrades: [...(member.upgrades ?? []), item.name] };
  for (const stat of GANG_STATS) {
    const factor = item.mults[stat];
    if (factor === undefined) continue;
    after[`${stat}_mult`] = member[`${stat}_mult`] * factor;
    after[stat] = gangSkillLevel(member[`${stat}_exp`], after[`${stat}_mult`] * member[`${stat}_asc_mult`]);
  }
  return after;
}

/** The respect the next recruit needs with `members` (`Gang.ts:316-323`): 0 for the free ones, Infinity at 12. */
export function gangRespectToRecruit(members: number): number {
  if (members < GANG_FREE_MEMBERS) return 0;
  if (members >= GANG_MOST_MEMBERS) return Number.POSITIVE_INFINITY;
  return GANG_RECRUIT_RESPECT_BASE ** (members - GANG_FREE_MEMBERS + 1);
}

/** How many the respect lets the gang recruit now (`Gang.ts:325-334`, the game's `getRecruitsAvailable`). */
export function gangRecruitsAllowed(respect: number, members: number): number {
  if (members >= GANG_MOST_MEMBERS) return 0;
  const recruitable =
    Math.floor(Math.max(Math.log(respect), 0) / Math.log(GANG_RECRUIT_RESPECT_BASE)) + GANG_FREE_MEMBERS;
  return Math.max(0, Math.min(recruitable, GANG_MOST_MEMBERS) - members);
}

/**
 * The faction to form the gang with, of `joined` (the player's factions), or null with none of the seven (#325). The
 * first one joined: the brain reaches NiteSec first, by A3's backdoor on avmnite-02h at hacking 202-220
 * (`Server/data/servers.ts:1468-1485`); The Black Hand's server needs 340-365, and the combat gangs' factions combat
 * stats and karma the brain doesn't train (`Faction/FactionInfo.tsx:662-669`). With several joined, the first in the
 * game's order, which puts the five combat factions before the two hacking ones: a combat gang's top respect task,
 * Terrorism, scales with territory to the power 2, Cyberterrorism to the power 1 (`Gang/data/tasks.ts`), ×14 at the
 * starting 1/7 (`gangTerritoryLeverage`).
 */
export function gangFactionToForm(joined: readonly string[]): string | null {
  return GANG_FACTIONS.find((faction) => joined.includes(faction)) ?? null;
}

/**
 * The cycles between territory and power updates (G4, `Constants.ts:12`, `Gang.ts:180-182`): 100, 20 s; in bonus time
 * too, the update counted in cycles.
 */
export const GANG_TERRITORY_UPDATE_CYCLES = 100;
/** Each gang's power multiplier, its additive gain's factor (`Gang/data/power.ts`, `Gang.ts:199-203`). */
export const GANG_POWER_MULTIPLIERS: Readonly<Record<string, number>> = {
  "Slum Snakes": 1,
  Tetrads: 2,
  "The Syndicate": 2,
  "The Dark Army": 2,
  "Speakers for the Dead": 5,
  NiteSec: 2,
  "The Black Hand": 5,
};
/** The share of the player's clashes in which members may die (`Gang.ts:288-289`): 35%. */
export const GANG_DEATH_ROUND_CHANCE = 0.35;
/** A Territory Warfare member's base chance to die in such a clash, won and lost (`Gang.ts:283-284`). */
export const GANG_DEATH_CHANCE_WON = 0.005;
export const GANG_DEATH_CHANCE_LOST = 0.01;
/** The share of the gang's respect a death costs, with the member's earned respect (`Gang.ts:372-375`). */
export const GANG_DEATH_RESPECT_SHARE = 0.05;
/** The clash chance's fall an update once warfare is disengaged (`Gang.ts:210-216`), from 1 while engaged. */
export const GANG_CLASH_CHANCE_FALL_PER_UPDATE = 0.01;
/** The least territory a clash moves (`Gang.ts:174-178`): 0.0001 × the power bonus, at least 1, × (rand + 0.5). */
export const GANG_LEAST_TERRITORY_TAKEN = 0.5e-4;
/** The power the player's gang keeps when it loses a clash (`Gang.ts:286`): 1/1.008, 0.8% less. */
export const GANG_POWER_KEPT_LOSING = 1 / 1.008;
/**
 * The power another gang keeps when it loses a clash, to the player's or another (`Gang.ts:243`, `:247`, `:258`,
 * `:260`): 1/1.01, 1% less.
 */
export const GANG_OTHER_POWER_KEPT_LOSING = 1 / 1.01;

/**
 * The clashes still to come after a disengage at clash chance `clashChance`, in updates at the full rate
 * (`Gang.ts:210-216`): the chance falls 0.01 an update first, so from 1, 0.99 + 0.98 + … + 0.01 = 49.5.
 */
export function gangClashTailUpdates(clashChance: number): number {
  let total = 0;
  for (let chance = clashChance - GANG_CLASH_CHANCE_FALL_PER_UPDATE; chance > 1e-9; ) {
    total += chance;
    chance -= GANG_CLASH_CHANCE_FALL_PER_UPDATE;
  }
  return total;
}

/** A member's power, its levels summed over 95 (`GangMember.ts:87-89`). */
export function gangMemberPower(member: MemberLevels): number {
  return (member.hack + member.str + member.def + member.dex + member.agi + member.cha) / 95;
}

/**
 * The gang's power gain at a territory update (`Gang.ts:362-369`, `:189`): 0.015 × max(0.002, territory) × the
 * members on Territory Warfare's power.
 */
export function gangPowerGainPerUpdate(territory: number, crew: readonly MemberLevels[]): number {
  return 0.015 * Math.max(0.002, territory) * crew.reduce((sum, each) => sum + gangMemberPower(each), 0);
}

/**
 * The chance to win a clash, power / (power + the other's) (`AllGangs.ts:73-77`,
 * `NetscriptFunctions/Gang.ts:328-339`).
 */
export function gangClashWinChance(power: number, otherPower: number): number {
  const chance = power / (power + otherPower);
  return Number.isFinite(chance) ? chance : 0;
}

/**
 * The territory a clash moves on average (`Gang.ts:174-178`): 0.0001 × max(1, 1 + ln(winner's power / loser's) /
 * ln 50) × (rand + 0.5), whose mean is 1; the game caps it at the loser's territory, which the caller does.
 */
export function gangTerritoryPerClash(winnerPower: number, loserPower: number): number {
  return 0.0001 * Math.max(1, 1 + Math.log(winnerPower / loserPower) / Math.log(50));
}

/** Another gang, as `ns.gang.getAllGangInformation` gives it (G4, `NetscriptFunctions/Gang.ts:105-113`). */
export interface GangOtherGang {
  faction: string;
  power: number;
  territory: number;
}

/**
 * Another gang's expected power gain at an update (`Gang.ts:191-204`): half the time × 1.005, capped at + 0.85; half
 * + 0.75 × roll × territory × its multiplier, roll in [0.5, 1), 0.75 on average: 0.5 × min(0.85, 0.005 × power) +
 * 0.28125 × territory × multiplier.
 */
export function gangOtherPowerGainPerUpdate(other: GangOtherGang): number {
  const multiplier = GANG_POWER_MULTIPLIERS[other.faction] ?? 1;
  return 0.5 * Math.min(0.85, 0.005 * other.power) + 0.5 * 0.75 * 0.75 * other.territory * multiplier;
}

/**
 * The other gangs' expected powers and territories after an update (`Gang.ts:184-269`): each one's gain
 * (`gangOtherPowerGainPerUpdate`), then its clashes with the others but the player's gang, which happen whatever the
 * player's clash chance: 2/(n − 1) an update against each other gang with territory (`gangClashesPerUpdate`), each
 * lost with the other's power over both, costing 1% of its power (`GANG_OTHER_POWER_KEPT_LOSING`) and the territory a
 * clash moves (`gangTerritoryPerClash`, capped at the loser's); each won takes that from the other. So the weak lose
 * their territory to the strong over hours, and a gang with none clashes none. Its clashes with the player's gang (the
 * 1% it loses at each, the territory the player takes) are the caller's: left out here.
 */
export function gangOthersAfterUpdate(others: readonly GangOtherGang[]): GangOtherGang[] {
  const clashes = gangClashesPerUpdate(others);
  const grown = others.map((each) => ({ ...each, power: each.power + gangOtherPowerGainPerUpdate(each) }));
  return grown.map((each) => {
    if (!(each.territory > 0)) return each;
    let losses = 0;
    let territory = each.territory;
    for (const other of grown) {
      if (other === each || !(other.territory > 0)) continue;
      const lost = gangClashWinChance(other.power, each.power);
      losses += clashes * lost;
      territory +=
        clashes *
        ((1 - lost) * Math.min(other.territory, gangTerritoryPerClash(each.power, other.power)) -
          lost * Math.min(each.territory, gangTerritoryPerClash(other.power, each.power)));
    }
    return {
      ...each,
      power: each.power * (1 - losses * (1 - GANG_OTHER_POWER_KEPT_LOSING)),
      // Under the least a clash takes (0.0001 × 0.5, `Gang.ts:176`), as none: in the game it's gone in a clash, and a
      // gang with none drops out of the clashes (`Gang.ts:219`).
      territory: territory < GANG_LEAST_TERRITORY_TAKEN ? 0 : territory,
    };
  });
}

/**
 * The share of its power the player's gang is expected to lose at an update, at clash chance 1 (`Gang.ts:286`): 0.8%
 * at each clash lost, 2/(n − 1) clashes against each other gang with territory, each lost with the loss chance.
 */
export function gangOwnPowerLossPerUpdate(power: number, others: readonly GangOtherGang[]): number {
  const clashes = gangClashesPerUpdate(others);
  const lost = others.reduce(
    (sum, other) => (other.territory > 0 ? sum + clashes * (1 - gangClashWinChance(power, other.power)) : sum),
    0,
  );
  return lost * (1 - GANG_POWER_KEPT_LOSING);
}

/**
 * The player's expected clashes against each other gang at an update, at clash chance 1 (`Gang.ts:219-234`): each gang
 * with territory (the player's whatever its own) picks one of the others at random, so the player's gang clashes with
 * a given one 2/(n − 1) times an update, n the gangs in it. Those with no territory are left out of it, and clash none.
 */
export function gangClashesPerUpdate(others: readonly GangOtherGang[]): number {
  const n = others.filter((each) => each.territory > 0).length + 1;
  return n > 1 ? 2 / (n - 1) : 0;
}

/**
 * The territory the player's gang is expected to gain at an update, at clash chance 1 (`Gang.ts:219-268`): against
 * each other gang with territory, its clashes × (the win chance × what a win takes, capped at its territory, less the
 * loss chance × what a loss gives, capped at the player's). Negative: the clashes lose territory.
 */
export function gangTerritoryPerUpdate(power: number, territory: number, others: readonly GangOtherGang[]): number {
  const clashes = gangClashesPerUpdate(others);
  let total = 0;
  for (const other of others) {
    if (!(other.territory > 0)) continue;
    const chance = gangClashWinChance(power, other.power);
    const won = Math.min(other.territory, gangTerritoryPerClash(power, other.power));
    const lost = Math.min(territory, gangTerritoryPerClash(other.power, power));
    total += clashes * (chance * won - (1 - chance) * lost);
  }
  return total;
}

/**
 * A Territory Warfare member's chance to die in one of the player's clashes at `winChance` (`Gang.ts:281-303`): 35%
 * of them roll, at 0.005 won and 0.01 lost, over def^0.6.
 */
export function gangDeathChancePerClash(def: number, winChance: number): number {
  const base = winChance * GANG_DEATH_CHANCE_WON + (1 - winChance) * GANG_DEATH_CHANCE_LOST;
  return (GANG_DEATH_ROUND_CHANCE * base) / Math.max(1, def) ** 0.6;
}

/** A recruit as the game makes one (`GangMember.ts:31-66`): levels 1, no experience, multipliers 1, no points. */
export function gangFreshRecruit(name: string): GangMemberFigures {
  const recruit: Record<string, unknown> = { name, task: UNASSIGNED_GANG_TASK, earnedRespect: 0 };
  for (const stat of GANG_STATS) {
    recruit[stat] = 1;
    recruit[`${stat}_exp`] = 0;
    recruit[`${stat}_mult`] = 1;
    recruit[`${stat}_asc_mult`] = 1;
    recruit[`${stat}_asc_points`] = 0;
  }
  return { ...(recruit as unknown as GangMemberFigures), upgrades: [], augmentations: [] };
}

/** The territory multiplier of a gang's top respect task at `territory` (`formulas.ts:26`): the faction's choice. */
export function gangTerritoryLeverage(isHacking: boolean, territory: number): number {
  const top = gangTask(isHacking ? "Cyberterrorism" : "Terrorism");
  return territoryMultiplier(territory, top.territory.respect);
}

/** The slow snapshot's gang faction (#325, `SlowSnapshotData.gangFaction`), or null: none read, or an older Agent. */
export function gangFactionOf(slow: unknown): string | null {
  const faction = (slow as { gangFaction?: unknown } | null | undefined)?.gangFaction;
  return typeof faction === "string" ? faction : null;
}

/** Home worker: forms the gang, the `createGang` intent's (#325), with the NS API alone, so in any game. */
export const CREATE_GANG_WORKER_NAME = "create-gang.js";
/** Home worker: recruits, sets the members' tasks and reads the gang, every 10 s while the brain manages it (#325). */
export const GANG_WORKER_NAME = "gang.js";
/** The home workers that need a gang's BitNode (BN2, or SF2), never run on a fresh save. */
export function gangWorkerFileNames(): string[] {
  return [CREATE_GANG_WORKER_NAME, GANG_WORKER_NAME];
}

/**
 * The desired state's gang (#325): what the Agent's gang worker does each time it runs, while the brain manages a gang
 * (in BN2). Before the gang is formed, it only reads that there's none.
 */
export interface GangState {
  /** Names to recruit, in order, each while the game lets the gang recruit; a member's name already is skipped. */
  recruit: string[];
  /**
   * Members to ascend (G2), after the recruits and before the tasks: each only while its ascension points are still
   * `pointsBefore` (`gangAscensionPointsOf`), the brain's reading, so the worker's next run, on the same state, doesn't
   * ascend it again. Absent from a G1 brain: none.
   */
  ascend: GangAscensionOrder[];
  /** Tasks by member name (a recruit's too); a member not named keeps its task. */
  tasks: Record<string, string>;
  /**
   * Equipment to buy (G3, #330), after the ascensions and before the tasks: each while the member's ascension points
   * are still `pointsBefore` (it hasn't ascended since the brain read it), it hasn't the item, and the money less the
   * item's cost stays at `keepMoney` or more. Absent from an older brain: none.
   */
  buy: GangPurchaseOrder[];
  /** The money the purchases leave alone (G3): the brain's holds for its other spending; null, none spent. */
  keepMoney: number | null;
  /**
   * Territory warfare (G4, #332), set after the tasks: engaged while the order stands (`gangWarfareOrderStands`), else
   * disengaged; null (absent from an older brain), the game's flag left alone.
   */
  warfare: GangWarfareOrder | null;
}

/**
 * The brain's territory warfare (G4): engage or not, and the territory an update the clashes must be expected to gain,
 * by the brain's measure (the deaths' cost over the territory's value, core's `gangWarfareMeasure`), to pay.
 */
export interface GangWarfareOrder {
  engage: boolean;
  leastTerritoryPerUpdate: number;
}

/**
 * Whether the order to engage stands (G4): the territory the clashes are expected to gain an update, from the powers
 * read now (`gangTerritoryPerUpdate`), still above the brain's break-even. So a stale order (others grown since the
 * brain's reading, or the gang's own power fallen) never keeps clashes on at a loss: it disengages, the safe side.
 */
export function gangWarfareOrderStands(order: GangWarfareOrder, territoryPerUpdateNow: number): boolean {
  return order.engage && territoryPerUpdateNow > order.leastTerritoryPerUpdate;
}

/** An upgrade to buy for a member (G3), with its ascension points when the brain read it. */
export interface GangPurchaseOrder {
  name: string;
  equipment: string;
  pointsBefore: number;
}

/** A member to ascend (G2), with its ascension points when the brain read it. */
export interface GangAscensionOrder {
  name: string;
  pointsBefore: number;
}

/**
 * A member's ascension points, its stats' summed: they only rise by an ascension (`GangMember.ts:298-305`), and fall
 * only by the install's penalty (`:287-296`), so a change says the member ascended (or augmentations were installed).
 */
export function gangAscensionPointsOf(member: Pick<GangMemberFigures, `${GangStat}_asc_points`>): number {
  return (
    member.hack_asc_points +
    member.str_asc_points +
    member.def_asc_points +
    member.dex_asc_points +
    member.agi_asc_points +
    member.cha_asc_points
  );
}

/** Whether the member's points are still the order's: the same to within a part in a billion (JSON keeps them). */
export function gangAscensionOrderStands(order: GangAscensionOrder, pointsNow: number): boolean {
  return Math.abs(pointsNow - order.pointsBefore) <= 1e-9 * Math.max(1, Math.abs(order.pointsBefore));
}

/** The longest member name the protocol takes. */
export const MAX_GANG_MEMBER_NAME_LENGTH = 64;

/**
 * A desired state's `gang` (#325): none when absent or null; else at most 12 recruits' names, at most 12 members to
 * ascend (G2; absent, none), the game's tasks, at most 12 purchases of the game's equipment with the money to keep
 * (G3; absent, none, and null), and territory warfare's order (G4; absent, null).
 */
export function parseGangState(value: unknown): { ok: true; gang: GangState | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, gang: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "gang isn't an object" };
  const { recruit, ascend = [], tasks, buy = [], keepMoney = null, warfare = null } = value as Record<string, unknown>;
  const isName = (name: unknown): name is string =>
    typeof name === "string" && name !== "" && name.length <= MAX_GANG_MEMBER_NAME_LENGTH;
  if (!Array.isArray(recruit) || recruit.length > GANG_MOST_MEMBERS || !recruit.every(isName)) {
    return { ok: false, reason: `gang.recruit isn't a list of at most ${GANG_MOST_MEMBERS} member names` };
  }
  const isOrder = (order: unknown): order is GangAscensionOrder =>
    typeof order === "object" &&
    order !== null &&
    isName((order as GangAscensionOrder).name) &&
    typeof (order as GangAscensionOrder).pointsBefore === "number" &&
    Number.isFinite((order as GangAscensionOrder).pointsBefore) &&
    (order as GangAscensionOrder).pointsBefore >= 0;
  if (!Array.isArray(ascend) || ascend.length > GANG_MOST_MEMBERS || !ascend.every(isOrder)) {
    return { ok: false, reason: `gang.ascend isn't a list of at most ${GANG_MOST_MEMBERS} members and their points` };
  }
  const isPurchase = (order: unknown): order is GangPurchaseOrder =>
    isOrder(order) && GANG_EQUIPMENT_NAMES.includes((order as GangPurchaseOrder).equipment);
  if (!Array.isArray(buy) || buy.length > GANG_MOST_MEMBERS || !buy.every(isPurchase)) {
    return {
      ok: false,
      reason: `gang.buy isn't a list of at most ${GANG_MOST_MEMBERS} members, the game's equipment and their points`,
    };
  }
  if (keepMoney !== null && !(typeof keepMoney === "number" && Number.isFinite(keepMoney) && keepMoney >= 0)) {
    return { ok: false, reason: "gang.keepMoney isn't null or an amount of money" };
  }
  const isWarfare = (order: unknown): order is GangWarfareOrder =>
    typeof order === "object" &&
    order !== null &&
    typeof (order as GangWarfareOrder).engage === "boolean" &&
    typeof (order as GangWarfareOrder).leastTerritoryPerUpdate === "number" &&
    Number.isFinite((order as GangWarfareOrder).leastTerritoryPerUpdate) &&
    (order as GangWarfareOrder).leastTerritoryPerUpdate >= 0;
  if (warfare !== null && !isWarfare(warfare)) {
    return { ok: false, reason: "gang.warfare isn't null or an order to engage or not, with its break-even" };
  }
  if (typeof tasks !== "object" || tasks === null || Array.isArray(tasks)) {
    return { ok: false, reason: "gang.tasks isn't an object" };
  }
  const entries = Object.entries(tasks);
  if (entries.length > 2 * GANG_MOST_MEMBERS) return { ok: false, reason: "gang.tasks names too many members" };
  for (const [name, taskName] of entries) {
    if (!isName(name)) return { ok: false, reason: "gang.tasks has a name that isn't a member name" };
    if (!GANG_TASK_NAMES.includes(taskName as string)) {
      return { ok: false, reason: `gang.tasks gives ${name} a task the game hasn't` };
    }
  }
  return {
    ok: true,
    gang: {
      recruit: [...recruit],
      ascend: ascend.map(({ name, pointsBefore }) => ({ name, pointsBefore })),
      tasks: Object.fromEntries(entries) as Record<string, string>,
      buy: buy.map(({ name, equipment, pointsBefore }) => ({ name, equipment, pointsBefore })),
      keepMoney,
      warfare:
        warfare === null ? null : { engage: warfare.engage, leastTerritoryPerUpdate: warfare.leastTerritoryPerUpdate },
    },
  };
}

/**
 * The gang as `ns.gang.getGangInformation` gives it (#325), but its recruit threshold; its equipment cost multiplier
 * since G3; territory warfare's figures and the other gangs since G4.
 */
export interface GangInformation extends Pick<GangFigures, "respect" | "wantedLevel" | "territory"> {
  faction: string;
  isHacking: boolean;
  /** The game's own penalty, respect / (respect + wanted). */
  wantedPenalty: number;
  /** Per cycle (200 ms), over the gang's last process (`Gang.ts:139-162`). */
  respectGainRate: number;
  moneyGainRate: number;
  wantedLevelGainRate: number;
  power: number;
  /**
   * 1 / the equipment discount (G3, `NetscriptFunctions/Gang.ts:102`, core's `gangEquipmentDiscount`): an upgrade's
   * cost now is its cost × this. Absent from an older Agent: the brain computes it from the respect and power.
   */
  equipmentCostMult?: number;
  /**
   * Territory warfare (G4, `NetscriptFunctions/Gang.ts:96-98`): engaged, and the clash chance, 1 while engaged, falling
   * 0.01 an update once not (`Gang.ts:210-216`). Absent from an older Agent.
   */
  territoryWarfareEngaged?: boolean;
  territoryClashChance?: number;
  /**
   * The other gangs (G4, `ns.gang.getAllGangInformation`), the game's order, each with the win chance against it
   * (`gangClashWinChance`, which `getChanceToWinClash` gives at 4 GB). Absent from an older Agent.
   */
  otherGangs?: GangOtherGangReading[];
  /**
   * `ns.gang.getBonusTime()` (#325's review): the stored cycles' time, ms; over 2 s, bonus time, the gang processing 25
   * cycles a call (`gangInBonusTime`, `GANG_BONUS_CYCLES_PER_PROCESS`). Absent from an older Agent.
   */
  bonusTimeMs?: number;
}

/** Another gang as the worker reads it (G4): its power and territory, and the win chance against it. */
export interface GangOtherGangReading extends GangOtherGang {
  winChance: number;
}

/** A member as `ns.gang.getMemberInformation` gives it, its task's rates a cycle too (`NetscriptFunctions/Gang.ts`). */
export interface GangMemberReading extends GangMemberFigures {
  respectGain: number;
  moneyGain: number;
  wantedLevelGain: number;
}

/**
 * The gang worker's reading (#325), in the medium snapshot (`gang`): the gang and its members after what the worker
 * did, and what it couldn't do (a recruit or task the game refused). The gang null with no problem: none formed yet;
 * with one, unread (the worker was given no state it could do).
 */
export interface GangReading {
  gang: GangInformation | null;
  members: GangMemberReading[];
  problems: string[];
  /**
   * The money the worker's purchases left alone (G3): the state's `keepMoney`, for the run report's check; null, none
   * spent. Absent from an older Agent.
   */
  keepMoney?: number | null;
}
