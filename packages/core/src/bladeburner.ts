/**
 * Bladeburner (#359), slice B1 (#367): joining. The game's facts and formulas the brain's rule and the Agent's workers
 * share, as plain literals (factions.ts's way). Paths are `vendor/bitburner-src/src/`'s (v3.0.1).
 * - **Where:** BN6 and BN7 have Bladeburner with no Source-File; SF6 or SF7 opens it everywhere but BN8, whose
 *   `BladeburnerRank` is 0 (`PersonObjects/Player/PlayerObjectBladeburnerMethods.ts:6-8`, `BitNode/BitNodeUtils.ts:
 *   17-19`, `NetscriptFunctions/Bladeburner.ts:332-344`). The brain plays it in BN6 and BN7 only for now
 *   (`BLADEBURNER_BITNODES`): elsewhere it's #359's left-out question for the owner.
 * - **Joining the division:** strength, defense, dexterity and agility at 100 each, from any city, no karma
 *   (`NetscriptFunctions/Bladeburner.ts:349-363`; the NSA's button checks the same, `Locations/ui/SpecialLocation.tsx:
 *   62-98`). It can't be undone in the BitNode (an install keeps it, `Prestige.ts:155-158`; a destroy clears it), so its
 *   intent is irreversible.
 * - **The faction:** Bladeburners, at rank 25 (`Bladeburner/data/Constants.ts:42`), by two paths: an invitation (its
 *   requirements, SF6 or SF7 or BN6 or BN7, and the rank, `Faction/FactionInfo.tsx:709`, which the engine checks
 *   every 10 cycles, `engine.tsx:176-183`), which A5 may accept as any; or asking (`Bladeburner/Bladeburner.ts:265-273`:
 *   the API's `joinBladeburnerFaction`, or an install's rejoin, `:259-263`), which the Bladeburner worker does. It
 *   offers no work (`Faction/FactionInfo.tsx:698-714`; core's `FACTIONS`: no work types).
 * - **Combat to 100:** a level is ⌊m·(32·ln(exp + 534.6) − 200)⌋, at least 1, its inverse the experience a level needs
 *   (`PersonObjects/formulas/skill.ts:7-34`), m the player's `mults.<stat>` times the BitNode's `<Stat>LevelMultiplier`
 *   (`PersonObjects/Person.ts:66-140`), which neither BN6 nor BN7 sets (`BitNode/BitNode.tsx:694-769`): 1. At m = 1,
 *   level 100 is 11,255 experience.
 * - **The gym:** its stat's experience a second is the gym's `expMult` times the player's `mults.<stat>_exp`
 *   (`calculateClassEarnings`, `Work/Formulas.ts:108-121`, from 1 a cycle at 5 cycles a second, `Work/ClassWork.tsx:
 *   53-71`), for 120 × `costMult` a second (`Work/Formulas.ts:100-105`). Powerhouse Gym gives the most, 10 a second for
 *   $2,400 (`Locations/data/LocationsMetadata.ts:322-328`): about 19 minutes a stat from nothing at ×1, 75 minutes for
 *   all four. Left out, and labelled: the hash upgrade on gym training (SF9's, `Hacknet/HashManager.ts:53-57`, ×1
 *   without it; cautious: it only adds), and the backdoor's 10% off the cost (core's `classCostPerSecond` errs high).
 *   The BitNode's `ClassGymExpGain` is never applied in v3.0.1 (only `BitNode.tsx` and its description name it).
 * - **RAM** (`Netscript/RamCostGenerator.ts:334-376`): `inBladeburner` costs nothing, so the medium snapshot says
 *   whether the player has joined; `getRank`, `joinBladeburnerFaction` and `joinBladeburnerDivision` 4 GB each.
 */
import type { BladeburnerActionReading } from "./bladeburner-actions.ts";
import {
  CLASS_LOCATION_NAMES,
  CLASS_LOCATIONS,
  CLASS_MONEY_GUARD_SECONDS,
  type ClassChoice,
  classCostPerSecond,
} from "./classes.ts";
import { TRAVEL_COST } from "./locations.ts";

/** The BitNodes the brain plays Bladeburner in (B1): those that have it with no Source-File. */
export const BLADEBURNER_BITNODES: readonly number[] = [6, 7];

/** Each combat stat's level the division needs (`NetscriptFunctions/Bladeburner.ts:349-354`). */
export const BLADEBURNER_JOIN_LEVEL = 100;

/** The Bladeburners faction, and the rank it comes at (`Bladeburner/data/Constants.ts:42`). */
export const BLADEBURNER_FACTION = "Bladeburners";
export const BLADEBURNER_FACTION_RANK = 25;

/** The combat stats, in the game's order, by `getPlayer()`'s names. */
export const COMBAT_STATS = ["strength", "defense", "dexterity", "agility"] as const;
export type CombatStat = (typeof COMBAT_STATS)[number];

/** Each combat stat's gym workout, by the game's `GymType` (`Work/Enums.ts`), as core's `CLASS_TYPES` names them. */
export const COMBAT_GYM_TYPES: Record<CombatStat, string> = {
  strength: "str",
  defense: "def",
  dexterity: "dex",
  agility: "agi",
};

/** Home worker: joins the Bladeburner division (`joinBladeburnerDivision`'s intent). */
export const JOIN_BLADEBURNER_WORKER_NAME = "join-bladeburner.js";
/** Home worker: joins the faction when the brain asks, and reads the rank (the desired state's `bladeburner`). */
export const BLADEBURNER_WORKER_NAME = "bladeburner.js";
/** Home worker: raises a skill to a level (`upgradeBladeburnerSkill`'s intent, #379). */
export const BLADEBURNER_SKILL_WORKER_NAME = "bladeburner-skill.js";

/** The Bladeburner workers, for core's home worker lists. */
export function bladeburnerWorkerFileNames(): string[] {
  return [JOIN_BLADEBURNER_WORKER_NAME, BLADEBURNER_WORKER_NAME, BLADEBURNER_SKILL_WORKER_NAME];
}

/**
 * `bladeburner.js`'s RAM by the game's calculator (ram-budget.json, which a test keeps in step;
 * `Netscript/RamCostGenerator.ts:334-376`): 1.6 GB for a script; 4 GB each for `getRank`, `joinBladeburnerFaction`
 * (B1), B2's (#375) `getStamina`, `getActionEstimatedSuccessChance`, `getActionCountRemaining`, `getActionMaxLevel`,
 * `getActionCurrentLevel`, `startAction`, `setActionLevel` and `setActionAutolevel`, and B3's (#379) `getSkillPoints`
 * and `getSkillLevel`; 1 GB for `getCurrentAction`; nothing for `getBonusTime` and `inBladeburner`. The brain asks for
 * it only once home's RAM beyond what it keeps for the Agent and its workers holds it (#359's RAM decision): at SF4.3
 * that's still a 128 GB home (65.9 + 50.6 GB), as B1's 9.6 GB and B2's 42.6 were; without SF4 the least home moves
 * from B2's 74.6 GB to 82.6, still a 128 GB home.
 */
export const BLADEBURNER_WORKER_RAM_GB = 50.6;

/**
 * `bladeburner-skill.js`'s RAM by the game's calculator (ram-budget.json, which a test keeps in step): 1.6 GB for a
 * script, and 4 GB each for `getSkillLevel` and `upgradeSkill` (`Netscript/RamCostGenerator.ts:361`, `:363`). Home keeps
 * it while the rule has skills to buy (#381's review): beside the reading worker, 65.9 + 50.6 + 9.6 = 126.1 GB at SF4.3,
 * still a 128 GB home.
 */
export const BLADEBURNER_SKILL_WORKER_RAM_GB = 9.6;

/** An action the brain asks `bladeburner.js` to run (#375): its type and name as the NS API has them, and its level. */
export interface BladeburnerActionOrder {
  type: "Contracts" | "Operations" | "General";
  name: string;
  /** A contract's or operation's level, held (auto-level off); null for a general action. */
  level: number | null;
}

/**
 * What the brain asks of `bladeburner.js`: join the faction (the rank allows it, and it isn't joined yet); and (#375)
 * the action to run, or null (absent from a B1 brain): the game's action left as it is.
 */
export interface BladeburnerState {
  joinTheFaction: boolean;
  action?: BladeburnerActionOrder | null;
}

/**
 * What `bladeburner.js` reads, for the medium snapshot: the rank, or null with the division not joined; and the
 * worker's problems (a faction join or an action the game refused). In the division, B2's (#375) too (absent from a
 * B1 Agent): the stamina and its max (`getStamina`), the bonus time in seconds, the action the worker found under way
 * and the one under way after it acted (`getCurrentAction`: type and name, or null idle), and every contract and
 * operation, in core's order; and B3's (#379, absent from a B2 Agent): the skill points unspent (`getSkillPoints`) and
 * each skill's level (`getSkillLevel`), by core's `BLADEBURNER_SKILL_NAMES`.
 */
export interface BladeburnerReading {
  rank: number | null;
  problems: string[];
  stamina?: number;
  maxStamina?: number;
  bonusSeconds?: number;
  found?: { type: string; name: string } | null;
  current?: { type: string; name: string } | null;
  actions?: BladeburnerActionReading[];
  skillPoints?: number;
  skillLevels?: Record<string, number>;
}

const ORDER_TYPES = ["Contracts", "Operations", "General"];

/** The desired state's `bladeburner`, checked: null (none managed), or one to do. */
export function parseBladeburnerState(
  value: unknown,
): { ok: true; bladeburner: BladeburnerState | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, bladeburner: null };
  if (typeof value !== "object" || typeof (value as { joinTheFaction?: unknown }).joinTheFaction !== "boolean") {
    return { ok: false, reason: "bladeburner isn't { joinTheFaction: true or false }" };
  }
  const { joinTheFaction, action } = value as { joinTheFaction: boolean; action?: unknown };
  if (action === undefined || action === null) return { ok: true, bladeburner: { joinTheFaction } };
  const { type, name, level } = action as Partial<Record<keyof BladeburnerActionOrder, unknown>>;
  const levelOk =
    type === "General" ? level === null : typeof level === "number" && Number.isInteger(level) && level >= 1;
  if (typeof action !== "object" || !ORDER_TYPES.includes(type as string) || typeof name !== "string" || !levelOk) {
    return {
      ok: false,
      reason:
        "bladeburner's action isn't { type: Contracts, Operations or General, name, level: a whole level from 1 " +
        "(null for General) }",
    };
  }
  return {
    ok: true,
    bladeburner: { joinTheFaction, action: { type, name, level } as BladeburnerActionOrder },
  };
}

/** A level from its experience (`calculateSkill`, `PersonObjects/formulas/skill.ts:7-15`). */
export function skillLevelOf(exp: number, mult: number): number {
  if (mult === 0) return 1;
  return Math.max(1, Math.floor(mult * (32 * Math.log(exp + 534.6) - 200)));
}

/**
 * The experience a whole `level` needs at `mult` (`calculateExp`, `PersonObjects/formulas/skill.ts:17-34`), raised as
 * the game raises it where floating point would leave its inverse a level short.
 */
export function skillExpFor(level: number, mult: number): number {
  let value = Math.exp((level / mult + 200) / 32) - 534.6;
  if (Number.isInteger(level) && Number.isFinite(value)) {
    let raised = value;
    let diff = Math.abs(value * Number.EPSILON);
    while (skillLevelOf(raised, mult) < level) {
      raised = value + diff;
      diff *= 2;
    }
    value = raised;
  }
  return Math.max(0, value);
}

/** What the rule reads of the player: each combat stat's level, experience, and level and experience multipliers. */
export interface CombatPerson {
  skills: Record<CombatStat, number>;
  exp: Record<CombatStat, number>;
  /** `mults.<stat>` (the level's) and `mults.<stat>_exp`. */
  mults: Record<CombatStat | `${CombatStat}_exp`, number>;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fieldOf = (record: unknown, key: string): unknown =>
  typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined;

/** The combat figures of a medium snapshot's `player` (`getPlayer()`), or null where one isn't a number. */
export function combatPersonOf(player: unknown): CombatPerson | null {
  const skills = fieldOf(player, "skills");
  const exp = fieldOf(player, "exp");
  const mults = fieldOf(player, "mults");
  const person = {
    skills: Object.fromEntries(COMBAT_STATS.map((stat) => [stat, fieldOf(skills, stat)])),
    exp: Object.fromEntries(COMBAT_STATS.map((stat) => [stat, fieldOf(exp, stat)])),
    mults: Object.fromEntries(
      COMBAT_STATS.flatMap((stat) => [
        [stat, fieldOf(mults, stat)],
        [`${stat}_exp`, fieldOf(mults, `${stat}_exp`)],
      ]),
    ),
  };
  const all = [...Object.values(person.skills), ...Object.values(person.exp), ...Object.values(person.mults)];
  return all.every(isNumber) ? (person as CombatPerson) : null;
}

/** Whether every combat stat is at the division's 100. */
export function combatTrained(person: CombatPerson): boolean {
  return COMBAT_STATS.every((stat) => person.skills[stat] >= BLADEBURNER_JOIN_LEVEL);
}

/** Each combat stat's experience short of level 100 at its multiplier: 0 once there. */
export function combatExpLeft(person: CombatPerson): Record<CombatStat, number> {
  return Object.fromEntries(
    COMBAT_STATS.map((stat) => [
      stat,
      person.skills[stat] >= BLADEBURNER_JOIN_LEVEL
        ? 0
        : Math.max(0, skillExpFor(BLADEBURNER_JOIN_LEVEL, person.mults[stat]) - person.exp[stat]),
    ]),
  ) as Record<CombatStat, number>;
}

/** A gym's experience a second for `stat` (`Work/Formulas.ts:108-121`): its `expMult` times the stat's multiplier. */
export function gymExpPerSecond(gym: string, stat: CombatStat, person: CombatPerson): number {
  const location = Object.hasOwn(CLASS_LOCATIONS, gym) ? CLASS_LOCATIONS[gym] : undefined;
  return location?.kind === "gym" ? location.expMult * person.mults[`${stat}_exp`] : 0;
}

/**
 * How long a gym under way is kept with the money falling (#367): while the money covers a minute of its cost, the
 * next medium snapshot's slack; a gym is started only with `CLASS_MONEY_GUARD_SECONDS` of it (core's
 * `classStartProblem`), so the choice doesn't flip at one sum.
 */
export const GYM_KEPT_SECONDS = 60;

/** The gym with the least experience a second: Iron Gym, 1 a second (`Locations/data/LocationsMetadata.ts:293-296`). */
export const SLOWEST_GYM = "Iron Gym";

/**
 * The gym with the most experience a second the money covers (#367), in any city: each by its `expMult`, the most
 * first. One in the player's city is started past core's class guard (10 minutes of its cost); one in another city
 * needs that and the travel there too, `TRAVEL_COST` ($200,000, `Constants.ts:28`, `PersonObjects/Person.ts:243-252`),
 * which the rule then asks for. `kept` (the class the rule last sent) is kept while it's the class still wanted (#373's
 * re-review: its gym, and `classType`, the stat now), the player is in its city, and the money covers
 * `GYM_KEPT_SECONDS` of it: a new class, a stat changed included, needs the 10 minutes the effectors start one with
 * (core's `classStartProblem`), or they'd refuse it and the old class would run on. Null with none the money covers.
 */
export function chooseGym({
  money,
  city,
  kept,
  classType,
}: {
  money: number;
  city: string;
  kept: ClassChoice | null;
  classType: string;
}): string | null {
  const gyms = CLASS_LOCATION_NAMES.filter((name) => CLASS_LOCATIONS[name]?.kind === "gym").sort(
    (a, b) => (CLASS_LOCATIONS[b]?.expMult ?? 0) - (CLASS_LOCATIONS[a]?.expMult ?? 0),
  );
  for (const gym of gyms) {
    const choice: ClassChoice = { location: gym, classType: "str" };
    const here = CLASS_LOCATIONS[gym]?.city === city;
    const underWay = kept?.location === gym && kept.classType === classType;
    if (here && underWay && money >= classCostPerSecond(choice) * GYM_KEPT_SECONDS) return gym;
    const travel = here ? 0 : TRAVEL_COST;
    if (money >= classCostPerSecond(choice) * CLASS_MONEY_GUARD_SECONDS + travel) return gym;
  }
  return null;
}

/** The training to join: the stat now, the gym, its city to travel to, its class, what's left, and the time to 100. */
export interface CombatTrainingPlan {
  /** The first stat in the game's order short of 100, or null: all four there. */
  stat: CombatStat | null;
  /** The gym chosen (`chooseGym`), or null: none, or trained. */
  gym: string | null;
  /** The gym's city, while the player is in another: the travel to ask for first. Null otherwise. */
  travel: string | null;
  /** The class to work, once the player is in the gym's city; or null. */
  work: ClassChoice | null;
  expLeft: Record<CombatStat, number>;
  /** Seconds to all four at 100 at the gym chosen, each at its own rate; 0 trained; null with no gym. */
  etaSeconds: number | null;
  /** Why no class goes while short of 100, or null. */
  waitingFor: string | null;
}

/** Seconds to all four at 100 at `gym`, each stat's experience left over its own rate there. */
function trainingSecondsAt(gym: string, person: CombatPerson, expLeft: Record<CombatStat, number>): number {
  return COMBAT_STATS.reduce((sum, each) => {
    const rate = gymExpPerSecond(gym, each, person);
    return sum + (expLeft[each] === 0 ? 0 : rate > 0 ? expLeft[each] / rate : Number.POSITIVE_INFINITY);
  }, 0);
}

/**
 * The longest the training to join can take once a gym is affordable (#367's review): all four to 100 at the slowest
 * gym, Iron Gym's 1 a second times the player's experience multipliers. The run report's overdue bound is twice this
 * and 10 minutes from the training's first sighting, as #343's waits are bounded. About 4.7 h at SF1.3's ×1.28
 * (4 × 5,417 / 1.28 s), 12.5 h at ×1 (4 × 11,255 s).
 */
export function slowestTrainingSeconds(person: CombatPerson): number {
  return trainingSecondsAt(SLOWEST_GYM, person, combatExpLeft(person));
}

/**
 * The training to join the division (#367): the stats in the game's order, each to 100 in turn (the order doesn't
 * change the total: one gym trains one stat at a time), at `chooseGym`'s gym, first travelling to its city, the
 * estimate each stat's experience left over its rate there. Left out, and labelled: crime and Bladeburner's own
 * Training (the planner's choice of focus, later); the rise of the experience multipliers meanwhile (none without an
 * install, which loses the experience).
 */
export function planCombatTraining(
  person: CombatPerson,
  where: { money: number; city: string; kept: ClassChoice | null },
): CombatTrainingPlan {
  const expLeft = combatExpLeft(person);
  const stat = COMBAT_STATS.find((each) => person.skills[each] < BLADEBURNER_JOIN_LEVEL) ?? null;
  if (stat === null) return { stat, gym: null, travel: null, work: null, expLeft, etaSeconds: 0, waitingFor: null };
  const gym = chooseGym({ ...where, classType: COMBAT_GYM_TYPES[stat] });
  if (gym === null) {
    const least = classCostPerSecond({ location: SLOWEST_GYM, classType: "str" }) * CLASS_MONEY_GUARD_SECONDS;
    const travel =
      CLASS_LOCATIONS[SLOWEST_GYM]?.city === where.city
        ? ""
        : `, and $${TRAVEL_COST.toLocaleString("en-US")} to travel there`;
    const waitingFor = `money for a gym: $${least.toLocaleString("en-US")} at ${SLOWEST_GYM} (${CLASS_MONEY_GUARD_SECONDS / 60} minutes of its cost)${travel}`;
    return { stat, gym, travel: null, work: null, expLeft, etaSeconds: null, waitingFor };
  }
  const gymCity = CLASS_LOCATIONS[gym]?.city ?? where.city;
  const away = gymCity !== where.city;
  return {
    stat,
    gym,
    travel: away ? gymCity : null,
    work: away ? null : { location: gym, classType: COMBAT_GYM_TYPES[stat] },
    expLeft,
    etaSeconds: trainingSecondsAt(gym, person, expLeft),
    waitingFor: away ? `the travel to ${gymCity}` : null,
  };
}

/**
 * Whether `bladeburner.js` fits home's RAM beyond what home keeps for the Agent and its workers (#359's RAM decision):
 * `homeMaxRamGb` less `homeKeptGb` (the brain's `homeKeptGbOf`) at least `BLADEBURNER_WORKER_RAM_GB`.
 */
export function bladeburnerWorkerFits({ homeMaxRamGb, homeKeptGb }: { homeMaxRamGb: number; homeKeptGb: number }) {
  return homeMaxRamGb - homeKeptGb >= BLADEBURNER_WORKER_RAM_GB;
}
