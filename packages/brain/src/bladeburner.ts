// Bladeburner (#359), slice B1 (#367): in BN6 and BN7, the brain trains the four combat stats to 100 at the gym, joins
// the division, then the Bladeburners faction once the rank allows. The facts and formulas are core's
// (../../core/src/bladeburner.ts); paths are `vendor/bitburner-src/src/`'s.
// - Only in BN6 and BN7 for now (core's `BLADEBURNER_BITNODES`): they have Bladeburner with no Source-File. With SF6
//   or SF7 elsewhere, it's #359's left-out question for the owner: not managed there, and nothing is sent.
// - The training: core's `planCombatTraining`, from the medium snapshot's player (each stat's level, experience and
//   multipliers, its money and city): the stats in the game's order, each to 100, at the gym with the most experience
//   a second the money covers in any city (Powerhouse Gym: 10 a second for $2,400), the travel's $200,000 counted for
//   one in another city. The travel goes first, as a `travel` intent (Singularity's `travelToCity` with SF4, else the
//   page). Then the class, as the brain's work (unfocused: a class has no focus penalty, `Work/Formulas.ts:108-121`),
//   in place of A5's faction work, which waits for it (./factions.ts), as the invitations' travel does
//   (./invitations.ts): a travel doesn't stop a class (`PersonObjects/Person.ts:243-252`), but the rule's own choice
//   would then send the player back to the gym's city. The gym it chose is kept while the player is there and the money
//   covers a minute of it (core's `GYM_KEPT_SECONDS`), so the choice doesn't flip with each snapshot's money.
// - The owner's work on the dashboard wins: the training is held (no class, no travel), and `bladeburnerTrainingHeld`
//   says so at each change, so the run report pauses the training's overdue clock meanwhile.
// - The join: once all four are at 100, `joinBladeburnerDivision`, irreversible, past the gate (its guard: all four at
//   100 on the medium snapshot, ./irreversible-gate.ts; then a save backup). Done once the medium snapshot shows the
//   player in the division (`inBladeburner`, free of RAM).
// - The reading: the desired state's `bladeburner`, done by the Agent's `bladeburner.js` every 10 s (the rank, and the
//   faction joined once the rank is at 25: Bladeburners offers no work, so A5 never picks it, core's `FACTIONS`). Sent
//   only once home's RAM beyond what it keeps for the Agent and its workers (`homeKeptGb`, share.ts's `homeKeptGbOf`)
//   holds the worker's 50.6 GB since B3 (core's `bladeburnerWorkerFits`): #359's RAM decision. Until then the line says
//   what home needs.
// - Left out, and labelled: crime and Bladeburner's own Training in place of the gym (the planner's choice of focus,
//   a later slice); the gym's cost against the brain's purchases (only core's class guard: 10 minutes of its cost);
//   below Powerhouse's $1.44m the training goes to Iron Gym, 10 times slower (about 4.7 h at SF1.3), A5's work and the
//   invitations' travel held all the while (the player's focus is the planner's, later); an install mid-training,
//   which loses the combat experience (A6 doesn't weigh it: B7's).
// - The actions (B2, #375), once the reading has them: core's `chooseBladeburnerAction`, the contract or operation and
//   its level with the most rank a game second over a cycle of work and rest, from the game's estimate's low end at
//   each one's level, within the counts, and the rest with it (Field Analysis, the Regeneration Chamber or Training).
//   Worked while the stamina is at least ½ max; below, rested, back to work at the max (core's
//   `bladeburnerResting`). Sent as the worker's `action`. The focus is held for it: A5's faction work waits
//   (./factions.ts's `heldFor`), as any work stops the action (`Bladeburner/Bladeburner.ts:178-180`, `:1356-1368`).
//   The player's one focus across systems is the planner's: until that slice, this is a rule's, labelled; A5 waits
//   through the rests too (#377's review: the stamina regains whatever runs), Field Analysis's rank all it gains then.
//   Left out, and labelled: The Blade's Simulacrum, which lets work and the actions run together
//   (`Bladeburner.ts:178-180`, `:1356`): A5 waits with it too. The owner's work on the dashboard wins: no action is sent
//   (the game stops it anyway), and the line says so. The worker turns the game's auto-level off for each action it
//   sets, and doesn't turn it back on.
// - The skills (B3, #379), once the reading has the points and levels: core's `chooseBladeburnerSkills`, each step the
//   levels of one skill that add the most rank a second a point to the actions' forecast (its cycle of work and rest,
//   so Cyber's Edge is worth its duty cycle; Overclock to its max 90), until no level the points left cover gains. Sent
//   at once as `upgradeBladeburnerSkill` intents, one a skill to the level planned, not gated (a skill can't be lost),
//   so the points are spent within a reading of coming. Bought with the owner's work on the dashboard too: they stop no
//   work. The forecast reads the levels too (core's: the time, the regain and the success skills in the range read).
// - The cities and the chaos (B4, #383), once the reading has the six (`bladeburner-city.js`, which the state's `city`
//   asks for: null before the first): core's `chooseBladeburnerCity`, B2's forecast in each city by its population
//   estimate and chaos, the city with the most rank a second sent as the state's `city` (free, and it stops nothing:
//   `NetscriptFunctions/Bladeburner.ts:316-321`); then Diplomacy where its chaos over 50 costs more rank than
//   Diplomacy's 60 s, else Incite Violence where the counts it adds gain more than its 60 s and the chaos it adds cost,
//   each in place of B2's order; else B2's order there. A chaos action under way is kept to its run's end, each 60 game
//   seconds, once the rule has chosen it for that run (#385's review)
//   (#383: Incite Violence's measure can turn as the counts grow meanwhile, and starting another loses its progress,
//   `Bladeburner.ts:186-188`), the city held with it (Diplomacy's fall is the city's at its end, `:1187-1198`). The
//   owner's work holds the moves with the actions; the cities are still read.
import {
  BLADEBURNER_BITNODES,
  BLADEBURNER_CHAOS_ACTION_SECONDS,
  BLADEBURNER_CONSTANTS,
  BLADEBURNER_FACTION,
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_JOIN_LEVEL,
  BLADEBURNER_SKILL_NAMES,
  BLADEBURNER_WORKER_RAM_GB,
  type BladeburnerActionOrder,
  type BladeburnerActionPlan,
  type BladeburnerActionReading,
  type BladeburnerChaosActionName,
  type BladeburnerCityChoice,
  type BladeburnerCityReading,
  type BladeburnerReading,
  type BladeburnerSkillLevels,
  type BladeburnerSkillPlan,
  type BladeburnerState,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerResting,
  bladeburnerSkillCostMultiplierOf,
  bladeburnerWorkerFits,
  type ClassChoice,
  COMBAT_STATS,
  type CombatTrainingPlan,
  cheapestBladeburnerSkillLevel,
  chooseBladeburnerAction,
  chooseBladeburnerCity,
  chooseBladeburnerSkills,
  classLabel,
  combatPersonOf,
  combatTrained,
  DIPLOMACY,
  INCITE_VIOLENCE,
  type Intent,
  intentId,
  isBladeburnerCity,
  type MediumSnapshotData,
  planCombatTraining,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { bitNodeOfSlow } from "./gang.ts";
import type { OwnersWork } from "./work.ts";

/** The training's held for the owner's work (#367's review), or not: at each change, for the report's overdue clock. */
export const BLADEBURNER_TRAINING_HELD_EVENT_KIND = "bladeburnerTrainingHeld";

export type BladeburnerEvent = { type: typeof BLADEBURNER_TRAINING_HELD_EVENT_KIND; atMs: number; held: boolean };

/** The travel to a gym's city, as the rule asks for it (#367's review). */
export function travelIntent(city: string): Intent {
  return { action: "travel", args: { city }, id: intentId("travel", { city }) };
}

/** Why A5's faction work waits while an action is sent (#375): any work stops it. */
export const BLADEBURNER_ACTIONS_HOLD = "Bladeburner's actions, which any work would stop (#375)";

/** A skill raised to a level, as the rule asks for it (#379). */
export function upgradeBladeburnerSkillIntent(skill: string, level: number): Intent {
  return {
    action: "upgradeBladeburnerSkill",
    args: { skill, level },
    id: intentId("upgradeBladeburnerSkill", { skill, level }),
  };
}

/** The division's join, as the rule asks for it. */
export const JOIN_BLADEBURNER_INTENT: Intent = {
  action: "joinBladeburnerDivision",
  args: {},
  id: intentId("joinBladeburnerDivision", {}),
};

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The medium snapshot's Bladeburner, checked, as the brain and the run report take it: whether the player is in the
 * division (null: an older Agent doesn't say), and the worker's reading: absent (none asked for, or an older Agent),
 * unread (the worker's problem, or figures that aren't numbers: the Agent's word), or the rank and problems.
 */
export interface BladeburnerSnapshot {
  joined: boolean | null;
  reading:
    | { kind: "absent" }
    | { kind: "unread"; problem: string }
    | { kind: "read"; rank: number | null; problems: string[]; actions: BladeburnerActionsReading | null };
}

/** An action's type and name, as `getCurrentAction` gives them. */
export interface BladeburnerActionId {
  type: string;
  name: string;
}

/** B3's reading (#379): the skill points unspent, and each skill's level. */
export interface BladeburnerSkillsReading {
  points: number;
  levels: BladeburnerSkillLevels;
}

/**
 * B2's reading (#375), checked: the stamina and its max, the bonus time in seconds, the action the worker found under
 * way and the one after it acted (null idle), and every contract and operation read; and B3's skills (#379), null from
 * a B2 Agent; and B4's (#383) division's city and the cities read, null without them (a B3 Agent, or none asked for).
 */
export interface BladeburnerActionsReading {
  stamina: number;
  maxStamina: number;
  bonusSeconds: number;
  found: BladeburnerActionId | null;
  current: BladeburnerActionId | null;
  actions: BladeburnerActionReading[];
  skills: BladeburnerSkillsReading | null;
  city: string | null;
  cities: BladeburnerCityReading[] | null;
}

/** B4's cities of a reading (#383): null with none, undefined with one not a figure or a name not the six's. */
function citiesReadingOf(
  reading: Partial<BladeburnerReading>,
): { city: string | null; cities: BladeburnerCityReading[] | null } | undefined {
  const { city, cities } = reading;
  if (city === undefined && cities === undefined) return { city: null, cities: null };
  if (city !== null && !isBladeburnerCity(city)) return undefined;
  if (!Array.isArray(cities)) return undefined;
  const checked: BladeburnerCityReading[] = [];
  for (const each of cities as unknown[]) {
    const { name, population, communities, chaos } = (each ?? {}) as Partial<Record<string, unknown>>;
    if (!isBladeburnerCity(name) || !isNumber(population) || !isNumber(communities) || !isNumber(chaos)) {
      return undefined;
    }
    checked.push({ name, population, communities, chaos });
  }
  return { city: city ?? null, cities: checked };
}

/** B3's skills of a reading (#379): null with none (a B2 Agent), undefined with one not a figure. */
function skillsReadingOf(reading: Partial<BladeburnerReading>): BladeburnerSkillsReading | null | undefined {
  const { skillPoints, skillLevels } = reading;
  if (skillPoints === undefined && skillLevels === undefined) return null;
  if (!isNumber(skillPoints) || typeof skillLevels !== "object" || skillLevels === null) return undefined;
  const levels: BladeburnerSkillLevels = {};
  for (const name of BLADEBURNER_SKILL_NAMES) {
    const level = (skillLevels as Record<string, unknown>)[name];
    if (!isNumber(level)) return undefined;
    levels[name] = level;
  }
  return { points: skillPoints, levels };
}

const actionIdOf = (value: unknown): BladeburnerActionId | null | undefined => {
  if (value === null) return null;
  const { type, name } = (typeof value === "object" ? value : {}) as Partial<Record<string, unknown>>;
  return typeof type === "string" && typeof name === "string" ? { type, name } : undefined;
};

/** B2's figures of a reading in the division: null with none (a B1 Agent), undefined with any not as it should be. */
function actionsReadingOf(reading: Partial<BladeburnerReading>): BladeburnerActionsReading | null | undefined {
  const { stamina, maxStamina, bonusSeconds, found, current, actions } = reading;
  if (stamina === undefined && actions === undefined) return null;
  const foundId = actionIdOf(found);
  const currentId = actionIdOf(current);
  if (
    !isNumber(stamina) ||
    !isNumber(maxStamina) ||
    !isNumber(bonusSeconds) ||
    foundId === undefined ||
    currentId === undefined ||
    !Array.isArray(actions)
  ) {
    return undefined;
  }
  const checked: BladeburnerActionReading[] = [];
  for (const each of actions as unknown[]) {
    const { type, name, level, maxLevel, count, chance } = (each ?? {}) as Partial<Record<string, unknown>>;
    if (
      (type !== "Contracts" && type !== "Operations") ||
      typeof name !== "string" ||
      !isNumber(level) ||
      !isNumber(maxLevel) ||
      !isNumber(count) ||
      !Array.isArray(chance) ||
      chance.length !== 2 ||
      !chance.every(isNumber)
    ) {
      return undefined;
    }
    checked.push({ type, name, level, maxLevel, count, chance: [chance[0], chance[1]] as [number, number] });
  }
  const skills = skillsReadingOf(reading);
  const cities = citiesReadingOf(reading);
  if (skills === undefined || cities === undefined) return undefined;
  return { stamina, maxStamina, bonusSeconds, found: foundId, current: currentId, actions: checked, skills, ...cities };
}

/** The Bladeburner of `mediumData`, checked. */
export function bladeburnerSnapshotOf(mediumData: unknown): BladeburnerSnapshot {
  const data = typeof mediumData === "object" && mediumData !== null ? (mediumData as Record<string, unknown>) : {};
  const joined = typeof data.inBladeburner === "boolean" ? data.inBladeburner : null;
  const reading = data.bladeburner;
  if (reading === undefined || reading === null) return { joined, reading: { kind: "absent" } };
  if (typeof reading !== "object") {
    return { joined, reading: { kind: "unread", problem: "the Bladeburner reading isn't an object" } };
  }
  const { rank, problems: rawProblems } = reading as Partial<BladeburnerReading>;
  const problems = Array.isArray(rawProblems) ? rawProblems.filter((each) => typeof each === "string") : [];
  if (rank === null) {
    // No rank with a problem: the worker couldn't do its state (the Agent's word on why).
    return problems.length > 0
      ? { joined, reading: { kind: "unread", problem: problems.join("; ") } }
      : { joined, reading: { kind: "read", rank: null, problems, actions: null } };
  }
  if (!isNumber(rank)) return { joined, reading: { kind: "unread", problem: "the Bladeburner rank isn't a number" } };
  const actions = actionsReadingOf(reading as Partial<BladeburnerReading>);
  if (actions === undefined) {
    return {
      joined,
      reading: {
        kind: "unread",
        problem: "the Bladeburner reading's stamina, actions, skills or cities aren't figures",
      },
    };
  }
  return { joined, reading: { kind: "read", rank, problems, actions } };
}

/**
 * Game seconds a real second (#375): 5 while there's bonus time for a whole tick of 5 s (`Bladeburner.ts:1376-1380`),
 * else 1.
 */
export function bladeburnerSpeedOf(bonusSeconds: number): number {
  const most = BLADEBURNER_CONSTANTS.maxSecondsPerTick;
  return bonusSeconds >= most ? most : 1;
}

/** Home's RAM, from the medium snapshot's servers, or null. */
export function homeMaxRamOf(mediumData: MediumSnapshotData | null): number | null {
  const home = mediumData?.servers?.find((server) => server.hostname === "home");
  return isNumber(home?.maxRam) ? home.maxRam : null;
}

/** The factions the medium snapshot shows joined. */
function joinedFactionsOf(mediumData: MediumSnapshotData | null): string[] {
  const factions = (mediumData?.player as { factions?: unknown } | undefined)?.factions;
  return Array.isArray(factions) ? factions.filter((each): each is string => typeof each === "string") : [];
}

/** What the rule wants now: the brain's work (a gym class), the division's join, and the worker's state. */
/** The training's work: a class at a gym. */
export type GymWork = Extract<OwnersWork, { kind: "class" }>;

export interface BladeburnerDecision {
  work: GymWork | null;
  intent: Intent | null;
  state: BladeburnerState | null;
  /** The skills' levels to buy (#379): one `upgradeBladeburnerSkill` intent a skill, none with nothing to buy. */
  skillIntents: Intent[];
}

/** The dashboard's line, and where the rule stands. */
export interface BladeburnerView {
  stage: "notManaged" | "waiting" | "training" | "joining" | "joined";
  line: string;
  /** The training's plan while it trains, or null. */
  training: CombatTrainingPlan | null;
  /**
   * In the division (B2, #375): the actions' plan, the action sent, and whether it's resting; and (B4, #383) the
   * choice of city and chaos action (null without the cities read), and the chaos action kept to its 60 s's end, or
   * null; null, none sent.
   */
  actions?: {
    plan: BladeburnerActionPlan;
    order: BladeburnerActionOrder;
    resting: boolean;
    cities?: BladeburnerCityChoice | null;
    kept?: BladeburnerChaosActionName | null;
  } | null;
  /** In the division with B3's reading (#379): the skills' plan; null without it. */
  skills?: BladeburnerSkillPlan | null;
}

/** "1.23 rank/min". */
const perMinute = (perSecond: number) => `${(perSecond * 60).toFixed(2)} rank/min`;

/** The plan and the action sent, in words, for the dashboard, the log and the run report. */
export function describeActionPlan(
  plan: BladeburnerActionPlan,
  resting: boolean,
  stamina: number,
  max: number,
): string {
  const work = plan.work;
  const staminaText = `stamina ${stamina.toFixed(1)} / ${max.toFixed(1)}`;
  if (work === null) {
    return `${plan.rest.name} (no contract or operation beats it; ${perMinute(plan.rankPerSecond)}; ${staminaText})`;
  }
  const working =
    `${work.name} level ${work.level} (${(work.chance * 100).toFixed(1)}% at the estimate's low end, ` +
    `${perMinute(work.rankPerSecond)} worked)`;
  return (
    `${resting ? `resting with ${plan.rest.name} for ${working}` : `${working}, resting with ${plan.rest.name}`}; ` +
    `${staminaText}; worked ${(plan.duty * 100).toFixed(0)}% of a cycle, ${perMinute(plan.rankPerSecond)} over it`
  );
}

/**
 * The city and chaos actions' choice in words (#383), read in `readCity`, for the dashboard, the log and the run
 * report.
 */
export function describeCityChoice(choice: BladeburnerCityChoice, readCity: string): string {
  const there = choice.byCity.find((each) => each.name === choice.city);
  const from = choice.byCity.find((each) => each.name === readCity);
  const moving =
    choice.city !== readCity && from !== undefined
      ? `, moving from ${readCity} (chaos ${from.chaos.toFixed(2)}, ${perMinute(from.rankPerSecond)})`
      : "";
  let text =
    `in ${choice.city} (chaos ${(there?.chaos ?? 0).toFixed(2)}, ${perMinute(there?.rankPerSecond ?? 0)}: the most of ` +
    `the six${moving})`;
  const diplomacy = choice.diplomacy;
  if (diplomacy !== null) {
    text +=
      `; ${DIPLOMACY} ${diplomacy.pays ? "pays" : "doesn't pay"}: its 60 s cost ${diplomacy.cost.toFixed(2)} rank, ` +
      `the chaos ${diplomacy.chaos.toFixed(2)} → ${diplomacy.after.toFixed(2)} gains ${diplomacy.gain.toFixed(2)} ` +
      `(about ${diplomacy.attemptsTo50} to 50)`;
  }
  const incite = choice.incite;
  if (incite !== null) {
    text +=
      `; ${INCITE_VIOLENCE} ${incite.pays ? "pays" : "doesn't pay"}: the counts out for ${incite.work} ` +
      `(${perMinute(incite.unbounded)} unbounded), +${incite.countGain.toFixed(2)} a run gains ` +
      `${incite.gain.toFixed(2)} rank; its 60 s and the chaos ${incite.chaos.toFixed(2)} → ${incite.after.toFixed(2)} ` +
      `cost ${incite.cost.toFixed(2)}`;
  }
  return text;
}

/** The skills' plan in words (#379), for the dashboard, the log and the run report. */
export function describeSkillPlan(plan: BladeburnerSkillPlan, levels: BladeburnerSkillLevels, costMultiplier: number) {
  const points = `${plan.points} point${plan.points === 1 ? "" : "s"}`;
  if (plan.buys.length === 0) {
    return (
      `skills: ${points} unspent, no level they cover gains (the cheapest ` +
      `${cheapestBladeburnerSkillLevel(levels, costMultiplier)} points)`
    );
  }
  const buys = plan.buys.map((buy) => `${buy.skill} ${buy.from} → ${buy.to}`).join(", ");
  return (
    `skills: buying ${buys} for ${plan.spent} of ${points}, ${perMinute(plan.rankPerSecond)} → ` +
    `${perMinute(plan.rankPerSecondAfter)} over a cycle`
  );
}

/** "62 min", "1.3 h". */
function describeSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "never at that rate";
  if (seconds < 90 * 60) return `${Math.max(1, Math.round(seconds / 60))} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** "strength 87, defense 1, dexterity 1, agility 1": the combat levels. */
function describeLevels(skills: Record<string, number>): string {
  return COMBAT_STATS.map((stat) => `${stat} ${Math.floor(skills[stat] ?? 0)}`).join(", ");
}

/** The training in words, for the dashboard, the log and the run report. */
export function describeTraining(plan: CombatTrainingPlan, skills: Record<string, number>): string {
  if (plan.work === null && plan.travel !== null && plan.gym !== null) {
    return `travelling to ${plan.travel} for ${plan.gym} (${describeLevels(skills)})`;
  }
  if (plan.work === null) return `training waits for ${plan.waitingFor} (${describeLevels(skills)})`;
  return (
    `${classLabel(plan.work)} (${describeLevels(skills)}; all four at ${BLADEBURNER_JOIN_LEVEL} in about ` +
    `${describeSeconds(plan.etaSeconds ?? Number.POSITIVE_INFINITY)} there)`
  );
}

export class BladeburnerRule {
  readonly #log: (line: string) => void;
  #view: BladeburnerView = {
    stage: "notManaged",
    line: "Bladeburner: not managed (no slow snapshot yet)",
    training: null,
  };
  /** The class the training last sent, kept while it's still wanted and the money covers a minute of it (`chooseGym`). */
  #class: ClassChoice | null = null;
  #lastLogged = "";

  readonly #emit: (event: BladeburnerEvent) => void;
  /** Whether the training was held for the owner's work at the last update, as last said by its event. */
  #held = false;
  /** Whether the actions are resting (#375): below ½ max stamina until back at the max. */
  #resting = false;
  /** The chaos action under way (#383), since its first reading under way: the controller's time and the bonus time. */
  #chaosSince: { name: BladeburnerChaosActionName; atMs: number; bonusSeconds: number; keptRun: number } | null = null;

  constructor(log: (line: string) => void = () => {}, emit: (event: BladeburnerEvent) => void = () => {}) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): BladeburnerView {
    return this.#view;
  }

  /** Whether an action is sent now (#375): A5's faction work waits, as any work would stop it. */
  acting(): boolean {
    return this.#view.stage === "joined" && this.#view.actions != null;
  }

  /** Whether the brain's work is the training now: A5's faction work and the invitations' travel wait for it. */
  training(): boolean {
    const training = this.#view.training;
    return this.#view.stage === "training" && !this.#held && (training?.work != null || training?.travel != null);
  }

  /**
   * The decision on the latest snapshots. `homeKeptGb` is what home keeps for the Agent and its workers (share.ts's
   * `homeKeptGbOf`, with the slow snapshot's Singularity multiplier): the worker runs only in the RAM beyond it.
   */
  update({
    mediumData,
    slowData,
    homeKeptGb,
    ownersWork = false,
    nowMs = null,
  }: {
    mediumData: MediumSnapshotData | null;
    slowData: SlowSnapshotData | null;
    homeKeptGb: number;
    /** The owner's work is set on the dashboard: it wins, and the training is held. */
    ownersWork?: boolean;
    /** The controller's clock, for the events; null before any. */
    nowMs?: number | null;
  }): BladeburnerDecision {
    const decision = this.#update({ mediumData, slowData, homeKeptGb, ownersWork, nowMs });
    // Held while training with the owner's work set: said at each change, for the run report's overdue clock.
    const held = this.#view.stage === "training" && ownersWork;
    if (held !== this.#held && nowMs !== null) {
      this.#held = held;
      this.#emit({ type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, atMs: nowMs, held });
    }
    return decision;
  }

  #update({
    mediumData,
    slowData,
    homeKeptGb,
    ownersWork,
    nowMs,
  }: {
    mediumData: MediumSnapshotData | null;
    slowData: SlowSnapshotData | null;
    homeKeptGb: number;
    ownersWork: boolean;
    nowMs: number | null;
  }): BladeburnerDecision {
    const none: BladeburnerDecision = { work: null, intent: null, state: null, skillIntents: [] };
    const bitNode = bitNodeOfSlow(slowData);
    if (bitNode === null) {
      return this.#decide(
        { stage: "notManaged", line: "Bladeburner: not managed (no slow snapshot yet)", training: null },
        none,
      );
    }
    if (!BLADEBURNER_BITNODES.includes(bitNode)) {
      this.#class = null;
      this.#resting = false;
      this.#chaosSince = null;
      const line = `Bladeburner: not managed (played in BN6 and BN7 only for now; this is BN${bitNode})`;
      return this.#decide({ stage: "notManaged", line, training: null }, none);
    }
    const person = mediumData === null ? null : combatPersonOf(mediumData.player);
    const money = mediumData?.player?.money;
    const city = mediumData?.player?.city;
    if (mediumData === null || person === null || !isNumber(money) || typeof city !== "string") {
      const line = "Bladeburner: waiting for a medium snapshot with the player's combat stats, money and city";
      return this.#decide({ stage: "waiting", line, training: null }, none);
    }
    const snapshot = bladeburnerSnapshotOf(mediumData);
    if (snapshot.joined !== true) {
      if (!combatTrained(person)) {
        const training = planCombatTraining(person, { money, city, kept: this.#class });
        // The class sent, if one is: kept only while it's still the one wanted.
        this.#class = training.work ?? this.#class;
        if (ownersWork) {
          const line = `Bladeburner: training to join held for your work on the dashboard (${describeLevels(person.skills)})`;
          return this.#decide({ stage: "training", line, training }, none);
        }
        const line = `Bladeburner: training to join, ${describeTraining(training, person.skills)}`;
        const work: GymWork | null = training.work === null ? null : { kind: "class", ...training.work };
        const intent = training.travel === null ? null : travelIntent(training.travel);
        return this.#decide({ stage: "training", line, training }, { ...none, work, intent });
      }
      const line =
        `Bladeburner: joining the division (${describeLevels(person.skills)}: all four at ${BLADEBURNER_JOIN_LEVEL})` +
        (snapshot.joined === null ? "; this Agent doesn't say whether it's in" : "");
      return this.#decide({ stage: "joining", line, training: null }, { ...none, intent: JOIN_BLADEBURNER_INTENT });
    }
    this.#class = null;
    const homeMaxRamGb = homeMaxRamOf(mediumData);
    if (homeMaxRamGb === null || !bladeburnerWorkerFits({ homeMaxRamGb, homeKeptGb })) {
      const line =
        "Bladeburner: in the division; its reading waits for home's RAM: " +
        `${BLADEBURNER_WORKER_RAM_GB} GB beyond the ${homeKeptGb.toFixed(1)} GB home keeps` +
        (homeMaxRamGb === null ? " (home not read)" : `, and home has ${homeMaxRamGb} GB`);
      return this.#decide({ stage: "joined", line, training: null }, none);
    }
    const inFaction = joinedFactionsOf(mediumData).includes(BLADEBURNER_FACTION);
    const { reading } = snapshot;
    const rank = reading.kind === "read" ? reading.rank : null;
    const joinTheFaction = !inFaction && rank !== null && rank >= BLADEBURNER_FACTION_RANK;
    const actions = this.#actions(
      reading.kind === "read" ? reading.actions : null,
      mediumData,
      bitNode,
      ownersWork,
      nowMs,
    );
    const skills = this.#skills(reading.kind === "read" ? reading.actions : null, mediumData, bitNode);
    const line =
      reading.kind === "absent"
        ? "Bladeburner: in the division; waiting for its worker's reading"
        : reading.kind === "unread"
          ? `Bladeburner: in the division; unread: ${reading.problem}`
          : `Bladeburner: in the division, rank ${(rank ?? 0).toFixed(1)}; ` +
            (inFaction
              ? `${BLADEBURNER_FACTION} joined`
              : joinTheFaction
                ? `joining ${BLADEBURNER_FACTION}`
                : `${BLADEBURNER_FACTION} at rank ${BLADEBURNER_FACTION_RANK}`) +
            (actions.text === null ? "" : `; ${actions.text}`) +
            (skills.text === null ? "" : `; ${skills.text}`) +
            (reading.problems.length > 0 ? `; ${reading.problems.join("; ")}` : "");
    const state: BladeburnerState = {
      joinTheFaction,
      ...(actions.sent === null ? {} : { action: actions.sent.order }),
      ...(actions.city === undefined ? {} : { city: actions.city }),
    };
    return this.#decide(
      { stage: "joined", line, training: null, actions: actions.sent, skills: skills.plan },
      { ...none, state, skillIntents: skills.intents },
    );
  }

  /**
   * The skills to buy in the division (#379), from the reading's B3 figures: whatever the owner's work (they stop no
   * work); none without them (a B2 Agent, or the player's figures unread).
   */
  #skills(
    reading: BladeburnerActionsReading | null,
    mediumData: MediumSnapshotData,
    bitNode: number,
  ): { plan: BladeburnerSkillPlan | null; intents: Intent[]; text: string | null } {
    if (reading === null || reading.skills === null) return { plan: null, intents: [], text: null };
    const person = bladeburnerPersonOf(mediumData.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    const costMultiplier = bladeburnerSkillCostMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null || costMultiplier === null) {
      return { plan: null, intents: [], text: null };
    }
    const { levels, points } = reading.skills;
    const plan = chooseBladeburnerSkills(
      {
        readings: reading.actions,
        person,
        stamina: reading.stamina,
        maxStamina: reading.maxStamina,
        rankMultiplier,
        speed: bladeburnerSpeedOf(reading.bonusSeconds),
      },
      { levels, points, costMultiplier },
    );
    const intents = plan.buys.map((buy) => upgradeBladeburnerSkillIntent(buy.skill, buy.to));
    return { plan, intents, text: describeSkillPlan(plan, levels, costMultiplier) };
  }

  /**
   * The action to send in the division (#375), from the reading's B2 figures: none with the owner's work set (said), or
   * without them (a B1 Agent, or the player's figures unread). With the cities read (#383), the city and the chaos
   * action by core's `chooseBladeburnerCity`, a chaos action under way kept to its 60 s's end (`#keptChaosAction`).
   * `city`: the state's, with B2's figures read (null before the cities are: the Agent then reads them), else
   * undefined (none asked).
   */
  #actions(
    reading: BladeburnerActionsReading | null,
    mediumData: MediumSnapshotData,
    bitNode: number,
    ownersWork: boolean,
    nowMs: number | null,
  ): { sent: NonNullable<BladeburnerView["actions"]> | null; text: string | null; city?: string | null } {
    if (reading === null) return { sent: null, text: null };
    const kept = this.#keptChaosAction(reading, nowMs);
    const readCity = reading.city;
    if (ownersWork) return { sent: null, text: "actions held for your work on the dashboard", city: readCity };
    const person = bladeburnerPersonOf(mediumData.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null) {
      return {
        sent: null,
        text: "no action: the player's Bladeburner figures aren't in the medium snapshot",
        city: readCity,
      };
    }
    const { stamina, maxStamina } = reading;
    this.#resting = bladeburnerResting({ stamina, maxStamina, wasResting: this.#resting });
    const forecast = {
      readings: reading.actions,
      person,
      stamina,
      maxStamina,
      rankMultiplier,
      speed: bladeburnerSpeedOf(reading.bonusSeconds),
      skills: { read: reading.skills?.levels ?? {} },
    };
    const cities =
      readCity === null || reading.cities === null
        ? null
        : chooseBladeburnerCity(forecast, { city: readCity, cities: reading.cities });
    const plan = cities?.plan ?? chooseBladeburnerAction(forecast);
    const resting = this.#resting || plan.work === null;
    const chaosAction = kept ?? cities?.chaosAction ?? null;
    const order: BladeburnerActionOrder =
      chaosAction !== null
        ? { type: "General", name: chaosAction, level: null }
        : plan.work !== null && !resting
          ? { type: plan.work.type, name: plan.work.name, level: plan.work.level }
          : { type: "General", name: plan.rest.name, level: null };
    const city = kept !== null ? readCity : (cities?.city ?? readCity);
    const then =
      kept !== null ? `${kept} kept to its 60 s's end, then: ` : chaosAction !== null ? `${chaosAction}, then: ` : "";
    const text =
      then +
      describeActionPlan(plan, resting, stamina, maxStamina) +
      (cities === null || readCity === null ? "" : `; ${describeCityChoice(cities, readCity)}`);
    // The rule chose the chaos action under way again at its run's first reading (#385's review): kept to that run's end.
    const since = this.#chaosSince;
    if (since !== null && kept === null && order.type === "General" && order.name === since.name) {
      since.keptRun = this.#chaosRunOf(reading, nowMs);
    }
    return { sent: { plan, order, resting, cities, kept }, text, city };
  }

  /**
   * The chaos action under way to keep (#383): Diplomacy or Incite Violence under way at the reading, in a run of 60 game
   * seconds the rule has chosen it for. The game repeats it on its own, so its runs are counted from its first reading
   * under way (the controller's time, and the bonus time spent meanwhile, `Bladeburner.ts:1376-1380`): the first, which
   * the rule sent it for, is kept; each later one (#385's review) is the rule's to choose again at its first reading,
   * and kept to its end if it does (`#actions`). Null without the controller's time, or none under way. The worker starts
   * it just before reading it, so the time from its first reading errs short by under a reading's carriage, and each
   * run is kept that little past its end.
   */
  #keptChaosAction(reading: BladeburnerActionsReading, nowMs: number | null): BladeburnerChaosActionName | null {
    const current = reading.current;
    const name =
      current?.type === "General" && (current.name === DIPLOMACY || current.name === INCITE_VIOLENCE)
        ? (current.name as BladeburnerChaosActionName)
        : null;
    if (name === null || nowMs === null) {
      this.#chaosSince = null;
      return null;
    }
    if (this.#chaosSince?.name !== name) {
      this.#chaosSince = { name, atMs: nowMs, bonusSeconds: reading.bonusSeconds, keptRun: 0 };
    }
    return this.#chaosRunOf(reading, nowMs) <= this.#chaosSince.keptRun ? name : null;
  }

  /** Which 60 game seconds' run of the chaos action under way this reading falls in: 0 the first (#385's review). */
  #chaosRunOf(reading: BladeburnerActionsReading, nowMs: number | null): number {
    const since = this.#chaosSince;
    if (since === null || nowMs === null) return 0;
    const gameSeconds = (nowMs - since.atMs) / 1000 + since.bonusSeconds - reading.bonusSeconds;
    return Math.floor(gameSeconds / BLADEBURNER_CHAOS_ACTION_SECONDS);
  }

  #decide(view: BladeburnerView, decision: BladeburnerDecision): BladeburnerDecision {
    this.#view = view;
    // Logged on a change of stage, gym or stat, not each figure; never "not managed", which is every other BitNode's.
    const training = view.training;
    const order = view.actions?.order;
    // And each purchase of skills (#379).
    const buys = (view.skills?.buys ?? []).map((buy) => `${buy.skill} ${buy.to}`).join(", ");
    const logged =
      view.stage === "training" && training !== null
        ? `training ${training.stat} at ${training.gym ?? `nothing (waiting for ${training.waitingFor})`}`
        : order != null
          ? `in the division, ${order.name} ${order.level ?? ""}, ${view.actions?.cities?.city ?? ""}; ${buys}`
          : `${view.line.replace(/rank [\d.]+/, "rank")}; ${buys}`;
    if (logged !== this.#lastLogged && view.stage !== "notManaged") {
      this.#log(`bladeburner: ${view.line.replace(/^Bladeburner: /, "")}`);
    }
    this.#lastLogged = logged;
    return decision;
  }
}
