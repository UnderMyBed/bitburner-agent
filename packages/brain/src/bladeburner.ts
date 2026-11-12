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
//   holds the worker's 42.6 GB since B2 (core's `bladeburnerWorkerFits`): #359's RAM decision. Until then the line says
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
//   The player's one focus across systems is the planner's: until that slice, this is a rule's, labelled. The owner's
//   work on the dashboard wins: no action is sent (the game stops it anyway), and the line says so.
import {
  BLADEBURNER_BITNODES,
  BLADEBURNER_CONSTANTS,
  BLADEBURNER_FACTION,
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_JOIN_LEVEL,
  BLADEBURNER_WORKER_RAM_GB,
  type BladeburnerActionOrder,
  type BladeburnerActionPlan,
  type BladeburnerActionReading,
  type BladeburnerReading,
  type BladeburnerState,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerResting,
  bladeburnerWorkerFits,
  type ClassChoice,
  COMBAT_STATS,
  type CombatTrainingPlan,
  chooseBladeburnerAction,
  classLabel,
  combatPersonOf,
  combatTrained,
  type Intent,
  intentId,
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

/**
 * B2's reading (#375), checked: the stamina and its max, the bonus time in seconds, the action the worker found under
 * way and the one after it acted (null idle), and every contract and operation read.
 */
export interface BladeburnerActionsReading {
  stamina: number;
  maxStamina: number;
  bonusSeconds: number;
  found: BladeburnerActionId | null;
  current: BladeburnerActionId | null;
  actions: BladeburnerActionReading[];
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
  return { stamina, maxStamina, bonusSeconds, found: foundId, current: currentId, actions: checked };
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
      reading: { kind: "unread", problem: "the Bladeburner reading's stamina or actions aren't figures" },
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
}

/** The dashboard's line, and where the rule stands. */
export interface BladeburnerView {
  stage: "notManaged" | "waiting" | "training" | "joining" | "joined";
  line: string;
  /** The training's plan while it trains, or null. */
  training: CombatTrainingPlan | null;
  /** In the division (B2, #375): the actions' plan, the action sent, and whether it's resting; null, none sent. */
  actions?: { plan: BladeburnerActionPlan; order: BladeburnerActionOrder; resting: boolean } | null;
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
    const decision = this.#update({ mediumData, slowData, homeKeptGb, ownersWork });
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
  }: {
    mediumData: MediumSnapshotData | null;
    slowData: SlowSnapshotData | null;
    homeKeptGb: number;
    ownersWork: boolean;
  }): BladeburnerDecision {
    const none: BladeburnerDecision = { work: null, intent: null, state: null };
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
    const actions = this.#actions(reading.kind === "read" ? reading.actions : null, mediumData, bitNode, ownersWork);
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
            (reading.problems.length > 0 ? `; ${reading.problems.join("; ")}` : "");
    const state: BladeburnerState =
      actions.sent === null ? { joinTheFaction } : { joinTheFaction, action: actions.sent.order };
    return this.#decide({ stage: "joined", line, training: null, actions: actions.sent }, { ...none, state });
  }

  /**
   * The action to send in the division (#375), from the reading's B2 figures: none with the owner's work set (said), or
   * without them (a B1 Agent, or the player's figures unread).
   */
  #actions(
    reading: BladeburnerActionsReading | null,
    mediumData: MediumSnapshotData,
    bitNode: number,
    ownersWork: boolean,
  ): { sent: NonNullable<BladeburnerView["actions"]> | null; text: string | null } {
    if (reading === null) return { sent: null, text: null };
    if (ownersWork) return { sent: null, text: "actions held for your work on the dashboard" };
    const person = bladeburnerPersonOf(mediumData.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null) {
      return { sent: null, text: "no action: the player's Bladeburner figures aren't in the medium snapshot" };
    }
    const { stamina, maxStamina } = reading;
    this.#resting = bladeburnerResting({ stamina, maxStamina, wasResting: this.#resting });
    const plan = chooseBladeburnerAction({
      readings: reading.actions,
      person,
      stamina,
      maxStamina,
      rankMultiplier,
      speed: bladeburnerSpeedOf(reading.bonusSeconds),
    });
    const resting = this.#resting || plan.work === null;
    const order: BladeburnerActionOrder =
      plan.work !== null && !resting
        ? { type: plan.work.type, name: plan.work.name, level: plan.work.level }
        : { type: "General", name: plan.rest.name, level: null };
    return { sent: { plan, order, resting }, text: describeActionPlan(plan, resting, stamina, maxStamina) };
  }

  #decide(view: BladeburnerView, decision: BladeburnerDecision): BladeburnerDecision {
    this.#view = view;
    // Logged on a change of stage, gym or stat, not each figure; never "not managed", which is every other BitNode's.
    const training = view.training;
    const order = view.actions?.order;
    const logged =
      view.stage === "training" && training !== null
        ? `training ${training.stat} at ${training.gym ?? `nothing (waiting for ${training.waitingFor})`}`
        : order != null
          ? `in the division, ${order.name} ${order.level ?? ""}`
          : view.line.replace(/rank [\d.]+/, "rank");
    if (logged !== this.#lastLogged && view.stage !== "notManaged") {
      this.#log(`bladeburner: ${view.line.replace(/^Bladeburner: /, "")}`);
    }
    this.#lastLogged = logged;
    return decision;
  }
}
