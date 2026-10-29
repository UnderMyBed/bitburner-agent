// Factions and their work (#203, M4 phase A slice A5): the brain joins every invitation from a faction with no enemies,
// and works for the faction whose next augmentation worth having for its hacking is nearest, so a run earns the
// reputation A6 buys with. Choices computed from the game's formulas (owner decision 46). Also what the dashboard's
// `factionWorkStalled` alert and the run report (#185) read of them.
// - Joining: the `joinFaction` intent (#147), one at a time, in the order invited. A faction with enemies (the six city
//   factions, `Faction/FactionInfo.tsx:498-552`) bans them when joined (`Faction/FactionHelpers.tsx:35-52`): left to the
//   owner, conservatively. Of the augmentations with a hacking value, only PCMatrix (Aevum) and Neuregen Gene
//   Modification (Chongqing) are sold by no faction without enemies.
// - Working: an augmentation's hacking value is core's `hackingValue`. Of those a joined faction sells, not installed,
//   queued or already within a joined seller's reputation, the one with the most value per second of work to reach its
//   reputation, by the game's rate (core's `factionReputationPerSecond`) for the faction's best work type. NeuroFlux
//   Governor is A6's: sold everywhere, it never runs out.
// - The owner's work wins; the dashboard's "Faction work" switch turns the brain's off.
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  FACTION_ENEMIES,
  FACTION_NAMES,
  FACTIONS,
  type FactionState,
  type FactionWorkType,
  factionReadingOf,
  factionReputationPerSecond,
  hackingValue,
  type Intent,
  intentId,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  type SlowSnapshotData,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";
import { workFocus } from "./work.ts";

/** The dashboard's switch for the brain's faction work (#203): on unless turned off. Joins have none. */
export const FACTION_WORK_ENABLED_SETTING = "factionWork.enabled";

export function readFactionWorkEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, FACTION_WORK_ENABLED_SETTING, true);
}

export function writeFactionWorkEnabled(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, FACTION_WORK_ENABLED_SETTING, enabled);
}

/**
 * The brain's faction work earning under `FACTION_WORK_ON_TRACK_SHARE` of its rate for this long is
 * `factionWorkStalled` (#203), and a run report failure: 10 minutes. The work earns every cycle while it goes on, and
 * the slow snapshot (every 60 s) shows it.
 */
export const FACTION_WORK_STALLED_AFTER_MS = 10 * 60_000;
/**
 * The share of the work's rate (the game's formula, at the choice) the faction's reputation must rise by, between slow
 * snapshots, to count: a half. Not just any rise: a joined faction not being worked gains reputation passively, at
 * most a tenth of the best work's rate, or 1/120 a cycle (`processPassiveFactionRepGain`,
 * `Faction/FactionHelpers.tsx:132-170`), so a rise alone doesn't show the work going on. Unfocused work earns 0.8 of it.
 */
export const FACTION_WORK_ON_TRACK_SHARE = 0.5;

/** Whether reputation rose from `from` to `to` by at least the share of `perSecond` that counts. */
export function onTrack(
  from: { atMs: number; reputation: number },
  to: { atMs: number; reputation: number },
  perSecond: number,
): boolean {
  return to.reputation - from.reputation >= (FACTION_WORK_ON_TRACK_SHARE * perSecond * (to.atMs - from.atMs)) / 1000;
}

/** The events the rule's choices are stored as (#203), for the run report. */
export const FACTION_WORK_CHOSEN_EVENT_KIND = "factionWorkChosen";
export const FACTION_WORK_STOPPED_EVENT_KIND = "factionWorkStopped";

// --- Joining ----------------------------------------------------------------------------------------------------------

/** An invitation the brain leaves to the owner: its faction, and the factions joining it would ban. */
export interface LeftInvitation {
  faction: string;
  bans: string[];
}

export interface JoinPlan {
  /** The faction to join now, or null. */
  next: string | null;
  /** The invitations from factions with enemies, in the order invited. */
  leftToOwner: LeftInvitation[];
}

/**
 * The invitations not yet joined, in the order invited: the first from a faction without enemies is joined; those
 * from factions with enemies are left to the owner. A name that isn't one of the game's factions is passed over.
 */
export function chooseJoin(invitations: readonly string[], joined: readonly string[]): JoinPlan {
  const open = invitations.filter((faction) => FACTION_NAMES.includes(faction) && !joined.includes(faction));
  return {
    next: open.find((faction) => FACTION_ENEMIES[faction] === undefined) ?? null,
    leftToOwner: open
      .filter((faction) => FACTION_ENEMIES[faction] !== undefined)
      .map((faction) => ({ faction, bans: [...(FACTION_ENEMIES[faction] ?? [])] })),
  };
}

/** The `joinFaction` intent for `faction`. */
export function joinIntent(faction: string): Intent {
  const args = { faction };
  return { id: intentId("joinFaction", args), action: "joinFaction", args };
}

// --- Working ----------------------------------------------------------------------------------------------------------

/** The brain's choice of faction work, and why: the augmentation it brings nearest, and when. */
export interface FactionWorkChoice {
  faction: string;
  workType: FactionWorkType;
  /** The augmentation the work is for. */
  augmentation: string;
  /** The faction's reputation now (the slow snapshot's), and what the augmentation needs. */
  reputation: number;
  reputationNeeded: number;
  /** The work's reputation a second, by the game's formula. */
  reputationPerSecond: number;
  /** Until the reputation is reached at that rate. */
  etaSeconds: number;
}

/**
 * The rule's choice, or why there's none. `transient`: the snapshots don't say yet (none, the faction state unread, a
 * figure missing), so nothing changes in the store's events; otherwise it's a definite reason (no faction, nothing
 * left worth working for).
 */
export type FactionWorkPlan =
  | { choice: FactionWorkChoice; waitingFor: null; transient: false }
  | { choice: null; waitingFor: string; transient: boolean };

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecordOf = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && Object.values(value).every(isFiniteNumber);

/** The player's skills and faction reputation multiplier from a medium snapshot, or null: it's the Agent's word. */
export function workingPersonOf(mediumData: MediumSnapshotData): WorkingPerson | null {
  const player = mediumData.player as { skills?: Record<string, unknown>; mults?: Record<string, unknown> } | undefined;
  const skills = player?.skills;
  const names = ["hacking", "strength", "defense", "dexterity", "agility", "charisma", "intelligence"] as const;
  if (!skills || !names.every((name) => isFiniteNumber(skills[name]))) return null;
  const factionRep = player?.mults?.faction_rep;
  if (!isFiniteNumber(factionRep)) return null;
  return {
    skills: Object.fromEntries(names.map((name) => [name, skills[name]])) as WorkingPerson["skills"],
    mults: { faction_rep: factionRep },
  };
}

/** The slow snapshot's reset info as the rule needs it, or null where it doesn't say. */
function resetInfoOf(slowData: SlowSnapshotData) {
  const info = slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  if (!Number.isInteger(info?.currentNode) || !isRecordOf(info?.ownedAugs) || !isRecordOf(info?.ownedSF)) return null;
  return { currentNode: info.currentNode as number, ownedAugs: info.ownedAugs, ownedSF: info.ownedSF };
}

/** Why the faction state can't be used: the reading's problem, or that there's none. */
function unreadFactionState(slowData: SlowSnapshotData): string {
  const problem = factionReadingOf(slowData)?.problem;
  return `the faction state in the Agent's slow snapshot${problem ? ` (unread: ${problem})` : ""}`;
}

/**
 * The faction work to do now: of the augmentations the joined factions sell, the candidate with the most hacking
 * value per second of work, and its faction's best work type.
 * - A candidate: a hacking value, neither installed nor queued, not NeuroFlux Governor, each missing prerequisite sold
 *   by a joined faction, and its reputation not yet reached at any joined faction that sells it (one reached is A6's to
 *   buy). Its reputation is the game's (`augmentationCost`), at the faction's own reputation now.
 * - The rate: the best of the faction's work types (core's `FACTIONS`), at the focus the work goes with (decision 37,
 *   ./work.ts's `workFocus`).
 * - Ties go to the sooner, then the faction first in the game's order. A gang's faction isn't modelled (none in BN1).
 */
export function chooseFactionWork(mediumData: MediumSnapshotData, slowData: SlowSnapshotData): FactionWorkPlan {
  const waiting = (waitingFor: string, transient: boolean) => ({ choice: null, waitingFor, transient });
  const state: FactionState | null = factionReadingOf(slowData)?.state ?? null;
  if (state === null) return waiting(unreadFactionState(slowData), true);
  const resetInfo = resetInfoOf(slowData);
  if (resetInfo === null) return waiting("the reset info in the Agent's slow snapshot", true);
  const person = workingPersonOf(mediumData);
  if (person === null) return waiting("the player's skills and multipliers in the Agent's medium snapshot", true);
  const working = state.joined.filter(
    (faction) => FACTION_NAMES.includes(faction.name) && (FACTIONS[faction.name]?.workTypes.length ?? 0) > 0,
  );
  if (state.joined.length === 0) return waiting("a faction to join", false);
  if (working.length === 0) return waiting("a joined faction that offers work", false);

  const { currentNode, ownedAugs, ownedSF } = resetInfo;
  const implant = Object.hasOwn(ownedAugs, NEURORECEPTOR_MANAGEMENT_IMPLANT);
  // What core doesn't know (an augmentation, a BitNode: another game version) throws: no choice, saying so.
  try {
    // Faction work's focus turns on the implant alone, the same for every faction and work type.
    const focused = workFocus({ kind: "faction", faction: working[0]?.name ?? "", workType: "hacking" }, slowData);
    const choice = bestCandidate(person, state, working, { currentNode, ownedAugs, ownedSF }, { focused, implant });
    if (choice === null) return waiting("an augmentation worth working for at the joined factions", false);
    return { choice, waitingFor: null, transient: false };
  } catch (error) {
    return waiting(`the snapshots as core knows the game (${(error as Error).message})`, false);
  }
}

/** `chooseFactionWork`'s candidates and choice, from figures already checked; null for none. */
function bestCandidate(
  person: WorkingPerson,
  state: FactionState,
  working: FactionState["joined"],
  { currentNode, ownedAugs, ownedSF }: NonNullable<ReturnType<typeof resetInfoOf>>,
  { focused, implant }: { focused: boolean; implant: boolean },
): FactionWorkChoice | null {
  const purchaseState: AugmentationPurchaseState = {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  const shops = new Map<string, string[]>();
  for (const { name } of state.joined) {
    if (FACTION_NAMES.includes(name)) shops.set(name, augmentationsSoldBy(name, currentNode, null));
  }
  const owned = (augmentation: string) =>
    Object.hasOwn(ownedAugs, augmentation) || state.queuedAugmentations.includes(augmentation);
  const soldByJoined = (augmentation: string) => [...shops].filter(([, shop]) => shop.includes(augmentation));
  const reputationOf = (faction: string) => state.joined.find((each) => each.name === faction)?.reputation ?? 0;

  let best: (FactionWorkChoice & { score: number }) | null = null;
  for (const faction of working) {
    const sourceFile15Level = ownedSF["15"] ?? 0;
    const rates = (FACTIONS[faction.name]?.workTypes ?? []).map((workType) => ({
      workType,
      perSecond: factionReputationPerSecond(person, workType, {
        favor: faction.favor,
        sourceFile15Level,
        focused,
        implant,
      }),
    }));
    const rate = rates.reduce((top, each) => (each.perSecond > top.perSecond ? each : top));
    if (!(rate.perSecond > 0)) continue;
    for (const augmentation of shops.get(faction.name) ?? []) {
      if (augmentation === NEUROFLUX_GOVERNOR || owned(augmentation)) continue;
      const value = hackingValue(augmentation);
      if (!(value > 0)) continue;
      const missing = missingPrerequisites(augmentation, purchaseState);
      if (!missing.every((prerequisite) => soldByJoined(prerequisite).length > 0)) continue;
      const reputationNeeded = augmentationCost(augmentation, purchaseState).reputation;
      const reached = soldByJoined(augmentation).some(([seller]) => reputationOf(seller) >= reputationNeeded);
      if (reached) continue;
      const etaSeconds = (reputationNeeded - faction.reputation) / rate.perSecond;
      const score = value / etaSeconds;
      const better =
        best === null ||
        score > best.score ||
        (score === best.score &&
          (etaSeconds < best.etaSeconds ||
            (etaSeconds === best.etaSeconds &&
              FACTION_NAMES.indexOf(faction.name) < FACTION_NAMES.indexOf(best.faction))));
      if (better) {
        best = {
          faction: faction.name,
          workType: rate.workType,
          augmentation,
          reputation: faction.reputation,
          reputationNeeded,
          reputationPerSecond: rate.perSecond,
          etaSeconds,
          score,
        };
      }
    }
  }
  if (best === null) return null;
  const { score: _score, ...choice } = best;
  return choice;
}

// --- The rule, as the controller runs it ------------------------------------------------------------------------------

/** What the dashboard shows of factions (#203). */
export interface FactionsView {
  /** The "Faction work" switch. */
  enabled: boolean;
  /** No medium and slow snapshots from the connected Agent yet. */
  waiting: boolean;
  /** The faction being joined, or null. */
  joining: string | null;
  leftToOwner: LeftInvitation[];
  /** The rule's choice, or null, and whether it's the work sent (not with the owner's work, or the switch off). */
  choice: FactionWorkChoice | null;
  sent: boolean;
  /** Why there's no choice, or why it isn't sent; null when it is. */
  waitingFor: string | null;
}

/**
 * The brain's faction work's watch (#203): its faction, and the last slow snapshot whose reputation was on track (or the
 * work's first): 10 minutes before now is `factionWorkStalled`.
 */
export interface FactionWorkStall {
  faction: string;
  sinceMs: number;
}

/** An event the rule's choices are stored as. */
export type FactionWorkEvent =
  | ({ type: typeof FACTION_WORK_CHOSEN_EVENT_KIND; atMs: number } & FactionWorkChoice)
  | { type: typeof FACTION_WORK_STOPPED_EVENT_KIND; atMs: number; reason: string };

/** What the controller hands the rule. */
export interface FactionInputs {
  mediumData: MediumSnapshotData | null;
  slowData: SlowSnapshotData | null;
  /** When the connected Agent's latest slow snapshot arrived, or null. */
  slowAtMs: number | null;
  /** The latest time the controller has seen (a channel event's), for the events; null before any. */
  nowMs: number | null;
  /** The owner's work is set: it wins. */
  ownersWork: boolean;
  /** The "Faction work" switch. */
  enabled: boolean;
}

const formatReputation = (reputation: number) => Math.round(reputation).toLocaleString("en-US");

/** An ETA in words: "45 s", "12 min", "3.4 h". */
export function describeEta(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** A choice in words, for the log, the dashboard and the run report. */
export function describeChoice(choice: FactionWorkChoice): string {
  return (
    `${choice.workType} for ${choice.faction}, for ${choice.augmentation} (reputation ` +
    `${formatReputation(choice.reputation)} of ${formatReputation(choice.reputationNeeded)}, ` +
    `${choice.reputationPerSecond.toFixed(2)}/s: about ${describeEta(choice.etaSeconds)})`
  );
}

/**
 * Joins and faction work as the desired state's controller runs them, on every update (so it logs only on a change):
 * the join to send and the work to send, the view, the stall, and the events for the store.
 * - The join is asked for until a snapshot shows the faction joined; the next waits for it.
 * - The work is sent while it's the rule's (no owner's work, the switch on). Its choice is stored as an event when its
 *   faction, work type or target changes, and its end as another when a definite reason stops it: the owner's work,
 *   the switch, nothing left worth it. Snapshots missing (a reconnect, the faction state unread) change nothing stored:
 *   the work isn't sent meanwhile, and the Agent leaves the game's work as it is.
 * - The stall: while the rule's work is sent, its faction's reputation in the slow snapshots, and the last one on track
 *   (`onTrack`), or the work's first. Another faction, the work not sent, or the snapshots gone, starts it again.
 */
export class FactionRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: FactionWorkEvent) => void;
  /** The faction asked to join, until a snapshot shows it joined, or its invitation is gone; or null. */
  #joining: string | null = null;
  /** The invitations left to the owner already logged, in this run of the brain. */
  readonly #leftLogged = new Set<string>();
  /** The last choice stored (faction, work type, target), "stopped", or null before any. */
  #lastStored: string | null = null;
  /**
   * The stall's watch on the work sent: its faction, the last slow snapshot whose reputation was on track (or the first
   * of the work), and the latest one's reputation and time, and whether the stall was logged.
   */
  #watch: { faction: string; sinceMs: number; reputation: number; slowAtMs: number; stalled: boolean } | null = null;
  #view: FactionsView = {
    enabled: true,
    waiting: true,
    joining: null,
    leftToOwner: [],
    choice: null,
    sent: false,
    waitingFor: null,
  };

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (e: FactionWorkEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): FactionsView {
    return this.#view;
  }

  /** The brain's work's stall, or null: its faction and since when its reputation last rose. */
  stall(): FactionWorkStall | null {
    return this.#watch === null ? null : { faction: this.#watch.faction, sinceMs: this.#watch.sinceMs };
  }

  update(inputs: FactionInputs): { join: Intent | null; work: { faction: string; workType: FactionWorkType } | null } {
    const join = this.#join(inputs);
    const work = this.#work(inputs);
    return { join, work };
  }

  #join({ mediumData, slowData }: FactionInputs): Intent | null {
    const state = slowData === null ? null : (factionReadingOf(slowData)?.state ?? null);
    const joined = (mediumData?.player as { factions?: unknown } | undefined)?.factions;
    if (state === null || !Array.isArray(joined)) {
      this.#view = { ...this.#view, joining: null, leftToOwner: [] };
      return null;
    }
    const joinedNames = [
      ...joined.filter((name): name is string => typeof name === "string"),
      ...state.joined.map((each) => each.name),
    ];
    if (this.#joining !== null && joinedNames.includes(this.#joining)) {
      this.#log(`factions: ${this.#joining} joined`);
      this.#joining = null;
    } else if (this.#joining !== null && !state.invitations.includes(this.#joining)) {
      // Neither joined nor invited: the invitation went with a reset (an install). Not asked for again.
      this.#log(`factions: no longer joining ${this.#joining}: its invitation is gone`);
      this.#joining = null;
    }
    const plan = chooseJoin(state.invitations, joinedNames);
    for (const { faction, bans } of plan.leftToOwner) {
      if (this.#leftLogged.has(faction)) continue;
      this.#leftLogged.add(faction);
      this.#log(`factions: ${faction}'s invitation is left to you (joining it bans ${bans.join(", ")})`);
    }
    // Asked for until a snapshot shows it joined: the invitations are in the order received, so it stays the first.
    const next = plan.next;
    if (next !== null && next !== this.#joining) {
      this.#joining = next;
      this.#log(`factions: joining ${next} (its invitation)`);
    }
    this.#view = { ...this.#view, joining: next, leftToOwner: plan.leftToOwner };
    return next === null ? null : joinIntent(next);
  }

  #work(inputs: FactionInputs): { faction: string; workType: FactionWorkType } | null {
    const { mediumData, slowData, slowAtMs, nowMs, ownersWork, enabled } = inputs;
    const plan: FactionWorkPlan =
      mediumData === null || slowData === null
        ? { choice: null, waitingFor: "the Agent's medium and slow snapshots", transient: true }
        : chooseFactionWork(mediumData, slowData);
    const notSent = !enabled ? "the Faction work switch is off" : ownersWork ? "your work on the dashboard" : null;
    const sent = plan.choice !== null && notSent === null ? plan.choice : null;
    this.#view = {
      ...this.#view,
      enabled,
      waiting: mediumData === null || slowData === null,
      choice: plan.choice,
      sent: sent !== null,
      waitingFor: plan.choice === null ? plan.waitingFor : notSent,
    };
    this.#store(sent, notSent ?? (plan.transient ? null : plan.waitingFor), nowMs);
    this.#watchReputation(sent, slowData, slowAtMs);
    return sent === null ? null : { faction: sent.faction, workType: sent.workType };
  }

  /** The choice stored when it changes; its end when a definite `reason` stops it. */
  #store(sent: FactionWorkChoice | null, reason: string | null, nowMs: number | null): void {
    if (nowMs === null) return;
    if (sent !== null) {
      const key = JSON.stringify([sent.faction, sent.workType, sent.augmentation]);
      if (key === this.#lastStored) return;
      this.#lastStored = key;
      this.#emit({ type: FACTION_WORK_CHOSEN_EVENT_KIND, atMs: nowMs, ...sent });
      this.#log(`faction work: ${describeChoice(sent)}`);
    } else if (reason !== null && this.#lastStored !== null && this.#lastStored !== "stopped") {
      this.#lastStored = "stopped";
      this.#emit({ type: FACTION_WORK_STOPPED_EVENT_KIND, atMs: nowMs, reason });
      this.#log(`faction work: stopped (${reason})`);
    }
  }

  #watchReputation(sent: FactionWorkChoice | null, slowData: SlowSnapshotData | null, slowAtMs: number | null): void {
    if (sent === null || slowData === null || slowAtMs === null) {
      this.#watch = null;
      return;
    }
    const watch = this.#watch;
    if (watch === null || watch.faction !== sent.faction) {
      this.#watch = { faction: sent.faction, sinceMs: slowAtMs, reputation: sent.reputation, slowAtMs, stalled: false };
      return;
    }
    if (slowAtMs === watch.slowAtMs) return;
    const now = { atMs: slowAtMs, reputation: sent.reputation };
    if (onTrack({ atMs: watch.slowAtMs, reputation: watch.reputation }, now, sent.reputationPerSecond)) {
      if (watch.stalled) this.#log(`faction work: ${watch.faction}'s reputation is rising at the work's rate again`);
      watch.sinceMs = slowAtMs;
      watch.stalled = false;
    } else if (!watch.stalled && slowAtMs - watch.sinceMs >= FACTION_WORK_STALLED_AFTER_MS) {
      watch.stalled = true;
      this.#log(
        `faction work STALLED: ${watch.faction}'s reputation has risen under half the ${sent.workType} work's ` +
          `${sent.reputationPerSecond.toFixed(2)}/s for ${Math.floor((slowAtMs - watch.sinceMs) / 60_000)} min, at ` +
          `${formatReputation(sent.reputation)}, with the work the brain's choice`,
      );
    }
    watch.slowAtMs = slowAtMs;
    watch.reputation = sent.reputation;
  }
}

// --- What the run report reads (#185) ---------------------------------------------------------------------------------

/**
 * Slow snapshots (every 60 s) further apart than this are a gap: the stall's clock starts again after one, as the
 * snapshots' gap is a failure of its own.
 */
export const SLOW_SNAPSHOT_GAP_MS = 3 * 60_000;

/** A stretch of the brain's faction work in which its faction's reputation rose under half the work's rate. */
export interface ReputationStall {
  faction: string;
  workType: string;
  /** The work's rate, at its choice. */
  reputationPerSecond: number;
  /** The last slow snapshot on track (or the work's first, or the one after a gap), to the last one that wasn't. */
  fromMs: number;
  toMs: number;
  /** Still not risen at the window's last slow snapshot. */
  ongoing: boolean;
}

/** A choice of the brain's faction work, or its end, as stored. */
export type FactionWorkRecord =
  | { atMs: number; kind: "chosen"; choice: FactionWorkChoice }
  | { atMs: number; kind: "stopped"; reason: string };

const isChoice = (detail: unknown): detail is FactionWorkChoice => {
  const fields = detail as Partial<FactionWorkChoice> | null;
  return (
    typeof fields?.faction === "string" &&
    typeof fields.workType === "string" &&
    typeof fields.augmentation === "string" &&
    isFiniteNumber(fields.reputation) &&
    isFiniteNumber(fields.reputationNeeded) &&
    isFiniteNumber(fields.reputationPerSecond) &&
    isFiniteNumber(fields.etaSeconds)
  );
};

/**
 * The brain's joins and faction work over a run, for the run report: the stored choices and ends (a `brainStarted`
 * ends one too, as the brain that made it is gone), the factions the medium snapshots show joined, the invitations
 * left to the owner, and, from the slow snapshots, each faction's reputation gained while the brain's work was on it,
 * and the stretches of `FACTION_WORK_STALLED_AFTER_MS` or more in which it rose under half the work's rate (`onTrack`,
 * with the rate stored at the choice: the skills only grow, so the work earns at least that).
 */
export class FactionWorkTimeline {
  /** The choices and ends, in time order; a malformed one is left out. */
  readonly records: FactionWorkRecord[] = [];
  /** Each faction the medium snapshots showed joined, and when first: null for those joined at the first one. */
  readonly joined = new Map<string, number | null>();
  /** Each invitation from a faction with enemies the slow snapshots showed, not joined, and when first. */
  readonly leftToOwner = new Map<string, number>();
  /** Each faction's reputation gained between slow snapshots while the brain's work was on it. */
  readonly gained = new Map<string, number>();
  readonly stalls: ReputationStall[] = [];
  readonly #ends: number[];
  #firstMedium = true;
  #watch: {
    faction: string;
    workType: string;
    record: FactionWorkRecord;
    reputation: number;
    lastSlowMs: number;
    /** The last slow snapshot on track, or the work's first, or the one after a gap. */
    onTrackMs: number;
    stall: ReputationStall | null;
  } | null = null;

  /** `events`: the window's, in the order stored. */
  constructor(events: readonly { atMs: number; kind: string; detail: unknown }[], brainStartedKind: string) {
    for (const { atMs, kind, detail } of events) {
      if (kind === FACTION_WORK_CHOSEN_EVENT_KIND && isChoice(detail)) {
        const { faction, workType, augmentation, reputation, reputationNeeded, reputationPerSecond, etaSeconds } =
          detail;
        const choice = {
          faction,
          workType,
          augmentation,
          reputation,
          reputationNeeded,
          reputationPerSecond,
          etaSeconds,
        };
        this.records.push({ atMs, kind: "chosen", choice });
      } else if (kind === FACTION_WORK_STOPPED_EVENT_KIND) {
        const reason = (detail as { reason?: unknown } | null)?.reason;
        this.records.push({ atMs, kind: "stopped", reason: typeof reason === "string" ? reason : "no reason stored" });
      }
    }
    this.#ends = events.filter((event) => event.kind === brainStartedKind).map((event) => event.atMs);
  }

  /** The choice in force at `atMs`, or null: none yet, or ended since (stopped, or the brain started again). */
  choiceAt(atMs: number): { record: FactionWorkRecord; choice: FactionWorkChoice } | null {
    const record = this.records.findLast((each) => each.atMs <= atMs);
    if (record?.kind !== "chosen") return null;
    if (this.#ends.some((endMs) => endMs > record.atMs && endMs <= atMs)) return null;
    return { record, choice: record.choice };
  }

  /** Medium snapshots, in time order: the factions joined. */
  addMedium(atMs: number, data: MediumSnapshotData): void {
    const factions = (data.player as { factions?: unknown } | undefined)?.factions;
    if (!Array.isArray(factions)) return;
    for (const faction of factions) {
      if (typeof faction === "string" && !this.joined.has(faction))
        this.joined.set(faction, this.#firstMedium ? null : atMs);
    }
    this.#firstMedium = false;
  }

  /** Slow snapshots, in time order: the invitations left, and the reputation under the brain's work. */
  addSlow(atMs: number, data: SlowSnapshotData): void {
    const state = factionReadingOf(data)?.state ?? null;
    if (state === null) return;
    const joinedNow = state.joined.map((each) => each.name);
    for (const { faction } of chooseJoin(state.invitations, joinedNow).leftToOwner) {
      if (!this.leftToOwner.has(faction)) this.leftToOwner.set(faction, atMs);
    }
    const current = this.choiceAt(atMs);
    const reputation = current && state.joined.find((each) => each.name === current.choice.faction)?.reputation;
    if (current === null || reputation === undefined || reputation === null) {
      this.#endWatch();
      return;
    }
    const { faction, workType } = current.choice;
    const watch = this.#watch;
    if (watch === null || watch.faction !== faction || this.#endedBetween(watch.record.atMs, current.record.atMs)) {
      this.#endWatch();
      this.#watch = {
        faction,
        workType,
        record: current.record,
        reputation,
        lastSlowMs: atMs,
        onTrackMs: atMs,
        stall: null,
      };
      return;
    }
    watch.record = current.record;
    watch.workType = workType;
    const perSecond = current.choice.reputationPerSecond;
    if (reputation > watch.reputation) {
      this.gained.set(faction, (this.gained.get(faction) ?? 0) + (reputation - watch.reputation));
    }
    if (atMs - watch.lastSlowMs > SLOW_SNAPSHOT_GAP_MS) {
      if (watch.stall) watch.stall.ongoing = false;
      watch.stall = null;
      watch.onTrackMs = atMs;
    } else if (onTrack({ atMs: watch.lastSlowMs, reputation: watch.reputation }, { atMs, reputation }, perSecond)) {
      if (watch.stall) watch.stall.ongoing = false;
      watch.stall = null;
      watch.onTrackMs = atMs;
    } else if (atMs - watch.onTrackMs >= FACTION_WORK_STALLED_AFTER_MS) {
      if (watch.stall) watch.stall.toMs = atMs;
      else {
        watch.stall = {
          faction,
          workType,
          reputationPerSecond: perSecond,
          fromMs: watch.onTrackMs,
          toMs: atMs,
          ongoing: true,
        };
        this.stalls.push(watch.stall);
      }
    }
    watch.reputation = reputation;
    watch.lastSlowMs = atMs;
  }

  /** Whether the work ended between two times (stopped, or a brain start): the watch doesn't carry over the end. */
  #endedBetween(fromMs: number, toMs: number): boolean {
    return (
      this.#ends.some((endMs) => endMs > fromMs && endMs <= toMs) ||
      this.records.some((each) => each.kind === "stopped" && each.atMs >= fromMs && each.atMs <= toMs)
    );
  }

  #endWatch(): void {
    if (this.#watch?.stall) this.#watch.stall.ongoing = false;
    this.#watch = null;
  }
}
