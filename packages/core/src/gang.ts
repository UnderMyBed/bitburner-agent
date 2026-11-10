/**
 * Gangs (#325, slice G1 of the gangs epic #324): the game's gang facts and formulas, and the brain's rule for a gang
 * that grows: which faction it's formed with, who is recruited, and each member's task. Paths are
 * `vendor/bitburner-src/src/`'s. The formulas are the game's own (`Gang/formulas/formulas.ts`, `Gang/GangMember.ts`),
 * checked against the engine's `ns.formulas.gang` and `getTaskStats` in the brain's parity suite
 * (`gang-parity.test.ts`). In-game code bundles the protocol's part (the worker names, `GANG_TASK_NAMES`), so no name
 * here is an NS function's (packages/ingame/README.md, "RAM"): `gangRespectPerCycle`, never `respectGain`.
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
 * multipliers and ascension multipliers.
 */
export interface GangMemberFigures {
  name: string;
  task: string;
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
  /** Tasks by member name (a recruit's too); a member not named keeps its task. */
  tasks: Record<string, string>;
}

/** The longest member name the protocol takes. */
export const MAX_GANG_MEMBER_NAME_LENGTH = 64;

/** A desired state's `gang` (#325): none when absent or null; else at most 12 recruits' names, and the game's tasks. */
export function parseGangState(value: unknown): { ok: true; gang: GangState | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, gang: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "gang isn't an object" };
  const { recruit, tasks } = value as Record<string, unknown>;
  const isName = (name: unknown): name is string =>
    typeof name === "string" && name !== "" && name.length <= MAX_GANG_MEMBER_NAME_LENGTH;
  if (!Array.isArray(recruit) || recruit.length > GANG_MOST_MEMBERS || !recruit.every(isName)) {
    return { ok: false, reason: `gang.recruit isn't a list of at most ${GANG_MOST_MEMBERS} member names` };
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
  return { ok: true, gang: { recruit: [...recruit], tasks: Object.fromEntries(entries) as Record<string, string> } };
}

/** The gang as `ns.gang.getGangInformation` gives it, but its recruit threshold and equipment (#325). */
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
   * `ns.gang.getBonusTime()` (#325's review): the stored cycles' time, ms; over 2 s, bonus time, the gang processing 25
   * cycles a call (`gangInBonusTime`, `GANG_BONUS_CYCLES_PER_PROCESS`). Absent from an older Agent.
   */
  bonusTimeMs?: number;
}

/** A member as `ns.gang.getMemberInformation` gives it, its task's rates a cycle too (`NetscriptFunctions/Gang.ts`). */
export interface GangMemberReading extends GangMemberFigures {
  earnedRespect: number;
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
}
