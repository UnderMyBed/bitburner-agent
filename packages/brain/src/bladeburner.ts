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
//   holds the worker's 9.6 GB (core's `bladeburnerWorkerFits`): #359's RAM decision. Until then the line says what
//   home needs.
// - Left out, and labelled: crime and Bladeburner's own Training in place of the gym (the planner's choice of focus,
//   a later slice); the gym's cost against the brain's purchases (only core's class guard: 10 minutes of its cost);
//   below Powerhouse's $1.44m the training goes to Iron Gym, 10 times slower (about 4.7 h at SF1.3), A5's work and the
//   invitations' travel held all the while (the player's focus is the planner's, later); an install mid-training,
//   which loses the combat experience (A6 doesn't weigh it: B7's); Bladeburner's actions (B2), so in a live B1 run the
//   rank stays 0.
import {
  BLADEBURNER_BITNODES,
  BLADEBURNER_FACTION,
  BLADEBURNER_FACTION_RANK,
  BLADEBURNER_JOIN_LEVEL,
  BLADEBURNER_WORKER_RAM_GB,
  type BladeburnerReading,
  type BladeburnerState,
  bladeburnerWorkerFits,
  COMBAT_STATS,
  type CombatTrainingPlan,
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
    | { kind: "read"; rank: number | null; problems: string[] };
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
      : { joined, reading: { kind: "read", rank: null, problems } };
  }
  if (!isNumber(rank)) return { joined, reading: { kind: "unread", problem: "the Bladeburner rank isn't a number" } };
  return { joined, reading: { kind: "read", rank, problems } };
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
  /** The gym the training last chose, kept while the money covers a minute of it (core's `chooseGym`). */
  #gym: string | null = null;
  #lastLogged = "";

  readonly #emit: (event: BladeburnerEvent) => void;
  /** Whether the training was held for the owner's work at the last update, as last said by its event. */
  #held = false;

  constructor(log: (line: string) => void = () => {}, emit: (event: BladeburnerEvent) => void = () => {}) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): BladeburnerView {
    return this.#view;
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
      this.#gym = null;
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
        const training = planCombatTraining(person, { money, city, kept: this.#gym });
        this.#gym = training.gym ?? this.#gym;
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
    this.#gym = null;
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
            (reading.problems.length > 0 ? `; ${reading.problems.join("; ")}` : "");
    return this.#decide({ stage: "joined", line, training: null }, { ...none, state: { joinTheFaction } });
  }

  #decide(view: BladeburnerView, decision: BladeburnerDecision): BladeburnerDecision {
    this.#view = view;
    // Logged on a change of stage, gym or stat, not each figure; never "not managed", which is every other BitNode's.
    const training = view.training;
    const logged =
      view.stage === "training" && training !== null
        ? `training ${training.stat} at ${training.gym ?? `nothing (waiting for ${training.waitingFor})`}`
        : view.line.replace(/rank [\d.]+/, "rank");
    if (logged !== this.#lastLogged && view.stage !== "notManaged") {
      this.#log(`bladeburner: ${view.line.replace(/^Bladeburner: /, "")}`);
    }
    this.#lastLogged = logged;
    return decision;
  }
}
