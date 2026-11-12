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
 * - **The faction:** Bladeburners, at rank 25 (`Bladeburner/data/Constants.ts:42`), joined only by asking
 *   (`Bladeburner/Bladeburner.ts:265-273`: the API's `joinBladeburnerFaction`, or an install's rejoin, `:259-263`); it
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
import {
  CLASS_LOCATION_NAMES,
  CLASS_LOCATIONS,
  CLASS_MONEY_GUARD_SECONDS,
  type ClassChoice,
  classCostPerSecond,
  classStartProblem,
} from "./classes.ts";

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

/** The Bladeburner workers, for core's home worker lists. */
export function bladeburnerWorkerFileNames(): string[] {
  return [JOIN_BLADEBURNER_WORKER_NAME, BLADEBURNER_WORKER_NAME];
}

/**
 * `bladeburner.js`'s RAM by the game's calculator (ram-budget.json, which a test keeps in step): 1.6 GB for a script,
 * `getRank` 4 and `joinBladeburnerFaction` 4 (`Netscript/RamCostGenerator.ts:359`, `:372`). The brain asks for it only
 * once home's RAM beyond what it keeps for the Agent and its workers holds it (#359's RAM decision).
 */
export const BLADEBURNER_WORKER_RAM_GB = 9.6;

/** What the brain asks of `bladeburner.js`: join the faction (the rank allows it, and it isn't joined yet). */
export interface BladeburnerState {
  joinTheFaction: boolean;
}

/**
 * What `bladeburner.js` reads, for the medium snapshot: the rank, or null with the division not joined; and the
 * worker's problems (a faction join the game refused).
 */
export interface BladeburnerReading {
  rank: number | null;
  problems: string[];
}

/** The desired state's `bladeburner`, checked: null (none managed), or one to do. */
export function parseBladeburnerState(
  value: unknown,
): { ok: true; bladeburner: BladeburnerState | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, bladeburner: null };
  if (typeof value !== "object" || typeof (value as { joinTheFaction?: unknown }).joinTheFaction !== "boolean") {
    return { ok: false, reason: "bladeburner isn't { joinTheFaction: true or false }" };
  }
  return { ok: true, bladeburner: { joinTheFaction: (value as BladeburnerState).joinTheFaction } };
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

/**
 * The gym with the most experience a second the money covers in the player's city (#367): each by its `expMult`, the
 * most first, started only past core's class guard (10 minutes of its cost), and `kept` (the gym the rule last chose)
 * kept while the money covers `GYM_KEPT_SECONDS` of it. Null with none: no gym in the city (Chongqing, New Tokyo and
 * Ishima have none; the travel is left out, labelled: the rule waits), or none the money covers.
 */
export function chooseGym({ money, city, kept }: { money: number; city: string; kept: string | null }): string | null {
  const gyms = CLASS_LOCATION_NAMES.filter((name) => {
    const location = CLASS_LOCATIONS[name];
    return location?.kind === "gym" && location.city === city;
  }).sort((a, b) => (CLASS_LOCATIONS[b]?.expMult ?? 0) - (CLASS_LOCATIONS[a]?.expMult ?? 0));
  for (const gym of gyms) {
    const choice: ClassChoice = { location: gym, classType: "str" };
    if (gym === kept && money >= classCostPerSecond(choice) * GYM_KEPT_SECONDS) return gym;
    if (classStartProblem(choice, { money, city }) === null) return gym;
  }
  return null;
}

/** The training to join: the stat now, the gym and its class, what's left, and the time to all four at 100. */
export interface CombatTrainingPlan {
  /** The first stat in the game's order short of 100, or null: all four there. */
  stat: CombatStat | null;
  /** The gym chosen (`chooseGym`), or null: none, or trained. */
  gym: string | null;
  /** The class to work, or null. */
  work: ClassChoice | null;
  expLeft: Record<CombatStat, number>;
  /** Seconds to all four at 100 at the gym chosen, each at its own rate; 0 trained; null with no gym. */
  etaSeconds: number | null;
  /** Why no class goes while short of 100, or null. */
  waitingFor: string | null;
}

/**
 * The training to join the division (#367): the stats in the game's order, each to 100 in turn (the order doesn't
 * change the total: one gym trains one stat at a time), at `chooseGym`'s gym, the estimate each stat's experience left
 * over its rate there. Left out, and labelled: crime and Bladeburner's own Training (the planner's choice of focus,
 * later); the rise of the experience multipliers meanwhile (none without an install, which loses the experience).
 */
export function planCombatTraining(
  person: CombatPerson,
  where: { money: number; city: string; kept: string | null },
): CombatTrainingPlan {
  const expLeft = combatExpLeft(person);
  const stat = COMBAT_STATS.find((each) => person.skills[each] < BLADEBURNER_JOIN_LEVEL) ?? null;
  if (stat === null) return { stat, gym: null, work: null, expLeft, etaSeconds: 0, waitingFor: null };
  const gym = chooseGym(where);
  if (gym === null) {
    const inCity = CLASS_LOCATION_NAMES.some(
      (name) => CLASS_LOCATIONS[name]?.kind === "gym" && CLASS_LOCATIONS[name]?.city === where.city,
    );
    const waitingFor = inCity
      ? `money for a gym in ${where.city}: ${CLASS_MONEY_GUARD_SECONDS / 60} minutes of its cost`
      : `a gym: none in ${where.city} (the travel is left out)`;
    return { stat, gym, work: null, expLeft, etaSeconds: null, waitingFor };
  }
  const etaSeconds = COMBAT_STATS.reduce((sum, each) => {
    const rate = gymExpPerSecond(gym, each, person);
    return sum + (expLeft[each] === 0 ? 0 : rate > 0 ? expLeft[each] / rate : Number.POSITIVE_INFINITY);
  }, 0);
  return {
    stat,
    gym,
    work: { location: gym, classType: COMBAT_GYM_TYPES[stat] },
    expLeft,
    etaSeconds,
    waitingFor: null,
  };
}

/**
 * Whether `bladeburner.js` fits home's RAM beyond what home keeps for the Agent and its workers (#359's RAM decision):
 * `homeMaxRamGb` less `homeKeptGb` (the brain's `homeKeptGbOf`) at least `BLADEBURNER_WORKER_RAM_GB`.
 */
export function bladeburnerWorkerFits({ homeMaxRamGb, homeKeptGb }: { homeMaxRamGb: number; homeKeptGb: number }) {
  return homeMaxRamGb - homeKeptGb >= BLADEBURNER_WORKER_RAM_GB;
}
