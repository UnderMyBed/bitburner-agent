// Factions and their work (#203, M4 phase A slice A5): the brain joins every invitation from a faction with no enemies,
// and works for the faction and work type that bring the most hacking value per second of work, so a run earns the
// reputation A6 buys with. Choices computed from the game's formulas (owner decision 46). Also what the dashboard's
// `factionWorkStalled` alert and the run report (#185) read of them.
// - Joining: the `joinFaction` intent (#147), one at a time, in the order invited. A faction with enemies (the six
//   city factions, `Faction/FactionInfo.tsx:498-552`) bans them when joined (`Faction/FactionHelpers.tsx:35-52`): left
//   to the owner, conservatively. Of the augmentations with a hacking value, only PCMatrix (Aevum) and Neuregen Gene
//   Modification (Chongqing) are sold by no faction without enemies.
// - Working: an augmentation's hacking value is core's `hackingValue`. Of those a joined faction sells, not installed,
//   queued or already within a joined seller's reputation, the one with the most value per second of work to reach its
//   reputation, by the game's rate (core's `factionReputationPerSecond`) for the faction's best work type. NeuroFlux
//   Governor is A6's: sold everywhere, it never runs out.
// - The Red Pill first (#215, A8): once a joined faction (Daedalus) sells it, neither installed nor queued, and its
//   reputation isn't reached, the work is for it, ahead of any hacking value: it ends the BitNode.
// - The owner's work wins; the dashboard's switch for the brain's faction work turns it off.
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
  factionReadingKind,
  factionReadingOf,
  factionReputationPerSecond,
  hackingValue,
  type Intent,
  intentId,
  type JoinedFaction,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  type SlowSnapshotData,
  THE_RED_PILL,
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
 * The window the brain's faction work is judged over (#203): earning under `FACTION_WORK_ON_TRACK_SHARE` of its rate
 * across the last 10 minutes is `factionWorkStalled`, and a run report failure. The work earns every cycle while it
 * goes on, and the slow snapshot (every 60 s) shows it.
 * - Over the whole window, not snapshot to snapshot: the page's reader (#197) reads the worked faction's reputation
 *   fresh each time from the work's own display, but any other faction's only when it opens the Factions page, at
 *   least every 10 minutes (`FACTIONS_PAGE_REFRESH_MS`). Work that isn't going on leaves its faction's reading flat,
 *   then jumping by the passive gain of up to 10 minutes: one interval of that could pass for on track, a 10-minute
 *   window can't.
 */
export const FACTION_WORK_STALLED_AFTER_MS = 10 * 60_000;
/**
 * The share of the work's rate (the game's formula) the faction's reputation must rise by to count: a half. Not just
 * any rise: a joined faction not being worked gains reputation passively, at most a tenth of the best work's rate, or
 * 1/120 a cycle (`processPassiveFactionRepGain`, `Faction/FactionHelpers.tsx:132-170`), so a rise alone doesn't show
 * the work going on. Unfocused work earns 0.8 of it.
 */
export const FACTION_WORK_ON_TRACK_SHARE = 0.5;

/** A faction's reputation at a slow snapshot. */
export interface ReputationReading {
  atMs: number;
  reputation: number;
}

/** Whether reputation rose from `from` to `to` by at least the share of `perSecond` that counts. */
export function onTrack(
  from: { atMs: number; reputation: number },
  to: { atMs: number; reputation: number },
  perSecond: number,
): boolean {
  return to.reputation - from.reputation >= (FACTION_WORK_ON_TRACK_SHARE * perSecond * (to.atMs - from.atMs)) / 1000;
}

/**
 * Where the window `FACTION_WORK_STALLED_AFTER_MS` before `now` starts, if reputation rose under the share of
 * `perSecond` that counts since then; null if it rose by that or more, or the readings don't go back that far. The
 * window starts at the newest reading at least 10 minutes before `now`. `readings` are in time order.
 */
export function underRateSince(
  readings: readonly ReputationReading[],
  now: ReputationReading,
  perSecond: number,
): number | null {
  const start = readings.findLast((each) => each.atMs <= now.atMs - FACTION_WORK_STALLED_AFTER_MS);
  return start === undefined || onTrack(start, now, perSecond) ? null : start.atMs;
}

/** The readings a window from `nowMs` still needs: the newest at least 10 minutes back, and those after it. */
function trimmedReadings(readings: ReputationReading[], nowMs: number): ReputationReading[] {
  const start = readings.findLastIndex((each) => each.atMs <= nowMs - FACTION_WORK_STALLED_AFTER_MS);
  return start <= 0 ? readings : readings.slice(start);
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

/** The brain's choice of faction work, and why: the augmentation it works for, and when it's reached. */
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

/** The slow snapshot's reset info, as the rule needs it. */
export interface WorkResetInfo {
  currentNode: number;
  ownedAugs: Record<string, number>;
  ownedSF: Record<string, number>;
}

/** The slow snapshot's reset info as the rule needs it, or null where it doesn't say (#203; A6 too). */
export function resetInfoOf(slowData: SlowSnapshotData): WorkResetInfo | null {
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
 * The faction work to do now: of the augmentations the joined factions sell (`workCandidates`), the one with the most
 * hacking value per second of work to reach its reputation, at its faction's best work type (`bestWorkRate`).
 * - A tie (the same augmentation at two factions, as near and at the same rate) goes to the faction first in the
 *   game's order.
 * - It ranks by the reputation's ETA alone: the money is A6's, which adds its own ETA (#210).
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
  // What core doesn't know (an augmentation, a BitNode: another game version) throws: no choice, saying so.
  try {
    const conditions = workConditionsOf(resetInfo, slowData);
    const choice =
      redPillWork(person, state, resetInfo, conditions) ?? bestCandidate(person, state, resetInfo, conditions);
    if (choice === null) return waiting("an augmentation worth working for at the joined factions", false);
    return { choice, waitingFor: null, transient: false };
  } catch (error) {
    return waiting(`the snapshots as core knows the game (${(error as Error).message})`, false);
  }
}

/** What a faction work rate depends on beyond the person and the faction: the run's figures and the focus. */
export interface WorkConditions {
  sourceFile15Level: number;
  /** As the work goes (decision 37, ./work.ts's `workFocus`). */
  focused: boolean;
  /** The Neuroreceptor Management Implant installed: unfocused at the full rate. */
  implant: boolean;
  /** The BitNode's (core's `augmentationBitNodeMultipliers`). */
  factionWorkRepGain: number;
}

/** The work conditions in the slow snapshot's reset info. Throws for a BitNode core doesn't know. */
export function workConditionsOf(resetInfo: WorkResetInfo, slowData: SlowSnapshotData | null): WorkConditions {
  const { currentNode, ownedAugs, ownedSF } = resetInfo;
  return {
    sourceFile15Level: ownedSF["15"] ?? 0,
    // Faction work's focus turns on the implant alone, the same for every faction and work type.
    focused: workFocus({ kind: "faction", faction: "CyberSec", workType: "hacking" }, slowData),
    implant: Object.hasOwn(ownedAugs, NEURORECEPTOR_MANAGEMENT_IMPLANT),
    factionWorkRepGain: augmentationBitNodeMultipliers(currentNode, ownedSF).FactionWorkRepGain,
  };
}

/**
 * A faction's best work type and its reputation a second, by the game's formula (core's `factionReputationPerSecond`)
 * for each type it offers (core's `FACTIONS`); null for one that offers none, or earns nothing (#203; A6 too). The first
 * in the game's order wins a tie.
 */
export function bestWorkRate(
  person: WorkingPerson,
  faction: JoinedFaction,
  conditions: WorkConditions,
): { workType: FactionWorkType; perSecond: number } | null {
  const workTypes = FACTION_NAMES.includes(faction.name) ? (FACTIONS[faction.name]?.workTypes ?? []) : [];
  let best: { workType: FactionWorkType; perSecond: number } | null = null;
  for (const workType of workTypes) {
    const perSecond = factionReputationPerSecond(person, workType, { favor: faction.favor, ...conditions });
    if (best === null || perSecond > best.perSecond) best = { workType, perSecond };
  }
  return best !== null && best.perSecond > 0 ? best : null;
}

/** An augmentation worth working for at a joined faction (`workCandidates`). */
export interface WorkCandidate {
  faction: string;
  augmentation: string;
  /** Core's `hackingValue`, at the player's hacking level. */
  value: number;
  /** Its reputation (core's `augmentationCost`), and the faction's now. */
  reputationNeeded: number;
  reputation: number;
}

/**
 * The augmentations worth working for (#203; A6 too), at each joined faction that sells them, in the order joined
 * factions and their shops list them: a hacking value at `hackingLevel` (core's `hackingValue`), neither installed nor
 * queued, not NeuroFlux Governor (A6's), each missing prerequisite sold by a joined faction, and its reputation not yet
 * reached at any joined faction that sells it (one reached is A6's to buy). Throws for what core doesn't know.
 */
export function workCandidates(
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  hackingLevel: number,
): WorkCandidate[] {
  const purchaseState: AugmentationPurchaseState = {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  // A gang's faction isn't modelled (none in BN1): gangFaction null, so every shop is the faction's own list.
  const shops = new Map<string, string[]>();
  for (const { name } of state.joined) {
    if (FACTION_NAMES.includes(name)) shops.set(name, augmentationsSoldBy(name, currentNode, null));
  }
  const owned = (augmentation: string) =>
    Object.hasOwn(ownedAugs, augmentation) || state.queuedAugmentations.includes(augmentation);
  const soldByJoined = (augmentation: string) => [...shops].filter(([, shop]) => shop.includes(augmentation));
  const reputationOf = (faction: string) => state.joined.find((each) => each.name === faction)?.reputation ?? 0;
  const candidates: WorkCandidate[] = [];
  for (const [faction, shop] of shops) {
    for (const augmentation of shop) {
      if (augmentation === NEUROFLUX_GOVERNOR || owned(augmentation)) continue;
      const value = hackingValue(augmentation, hackingLevel);
      if (!(value > 0)) continue;
      const missing = missingPrerequisites(augmentation, purchaseState);
      if (!missing.every((prerequisite) => soldByJoined(prerequisite).length > 0)) continue;
      const reputationNeeded = augmentationCost(augmentation, purchaseState).reputation;
      if (soldByJoined(augmentation).some(([seller]) => reputationOf(seller) >= reputationNeeded)) continue;
      candidates.push({ faction, augmentation, value, reputationNeeded, reputation: reputationOf(faction) });
    }
  }
  return candidates;
}

/**
 * The work for The Red Pill (#215), or null: at the joined faction selling it (Daedalus; none in BN15) with the soonest
 * ETA at its best work, while it's neither installed nor queued and no joined seller's reputation reaches it (reached,
 * it's A6's to buy). Its reputation is core's `augmentationCost`: 2.5m in BN1 (`Augmentation/Augmentations.ts:1946`).
 */
export function redPillWork(
  person: WorkingPerson,
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  conditions: WorkConditions,
): FactionWorkChoice | null {
  if (Object.hasOwn(ownedAugs, THE_RED_PILL) || state.queuedAugmentations.includes(THE_RED_PILL)) return null;
  const sellers = state.joined.filter(
    (faction) =>
      FACTION_NAMES.includes(faction.name) &&
      augmentationsSoldBy(faction.name, currentNode, null).includes(THE_RED_PILL),
  );
  const reputationNeeded = augmentationCost(THE_RED_PILL, {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  }).reputation;
  if (sellers.some((faction) => faction.reputation >= reputationNeeded)) return null;
  let best: FactionWorkChoice | null = null;
  for (const faction of sellers) {
    const rate = bestWorkRate(person, faction, conditions);
    if (rate === null) continue;
    const etaSeconds = (reputationNeeded - faction.reputation) / rate.perSecond;
    if (best === null || etaSeconds < best.etaSeconds) {
      best = {
        faction: faction.name,
        workType: rate.workType,
        augmentation: THE_RED_PILL,
        reputation: faction.reputation,
        reputationNeeded,
        reputationPerSecond: rate.perSecond,
        etaSeconds,
      };
    }
  }
  return best;
}

/** `chooseFactionWork`'s choice from figures already checked; null for none. */
function bestCandidate(
  person: WorkingPerson,
  state: FactionState,
  resetInfo: WorkResetInfo,
  conditions: WorkConditions,
): FactionWorkChoice | null {
  const rates = new Map(state.joined.map((faction) => [faction.name, bestWorkRate(person, faction, conditions)]));
  let best: (FactionWorkChoice & { score: number }) | null = null;
  for (const candidate of workCandidates(state, resetInfo, person.skills.hacking)) {
    const rate = rates.get(candidate.faction);
    if (!rate) continue;
    const etaSeconds = (candidate.reputationNeeded - candidate.reputation) / rate.perSecond;
    const score = candidate.value / etaSeconds;
    const better =
      best === null ||
      score > best.score ||
      (score === best.score && FACTION_NAMES.indexOf(candidate.faction) < FACTION_NAMES.indexOf(best.faction));
    if (better) {
      best = {
        faction: candidate.faction,
        workType: rate.workType,
        augmentation: candidate.augmentation,
        reputation: candidate.reputation,
        reputationNeeded: candidate.reputationNeeded,
        reputationPerSecond: rate.perSecond,
        etaSeconds,
        score,
      };
    }
  }
  if (best === null) return null;
  const { score: _score, ...choice } = best;
  return choice;
}

// --- The rule, as the controller runs it ------------------------------------------------------------------------------

/** What the dashboard shows of factions (#203). */
export interface FactionsView {
  /** The brain's faction work's switch. */
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
 * The brain's faction work's watch (#203): its faction, and where the window it's been stalled over started, or else
 * its newest slow snapshot: 10 minutes before now is `factionWorkStalled`.
 */
export interface FactionWorkStall {
  faction: string;
  sinceMs: number;
  /** The newest reading of its reputation the window counted: not a skipped one (#197). */
  lastReadingAtMs: number;
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
  /** The brain's faction work's switch. */
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
 * - The stall: while the rule's work is sent, its faction's reputation in the slow snapshots, judged over the last 10
 *   minutes (`underRateSince`). Another faction, the work not sent, or the snapshots gone, starts it again.
 */
export class FactionRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: FactionWorkEvent) => void;
  /** The faction asked to join, until a snapshot shows it joined, or its invitation is gone; or null. */
  #joining: string | null = null;
  /** The invitations left to the owner already logged, since the game's last reset. */
  readonly #leftLogged = new Set<string>();
  /** The game's `lastAugReset` when they were logged: another (an install) logs them afresh, as they come again. */
  #leftLoggedResetAt: number | null = null;
  /** The last choice stored (faction, work type, target), "stopped", or null before any. */
  #lastStored: string | null = null;
  /**
   * The stall's watch on the work sent: its faction, its reputation's readings the 10-minute window still needs (skipped
   * ones left out), and where the window it's been stalled over started, while it is.
   */
  #watch: {
    faction: string;
    readings: ReputationReading[];
    /** Where the window it's been stalled over started, while it is; null while it isn't. */
    stalledSinceMs: number | null;
  } | null = null;
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
  }: { log?: (line: string) => void; emit?: (event: FactionWorkEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  view(): FactionsView {
    return this.#view;
  }

  /**
   * The brain's work's watch, or null: its faction, where the window it's been stalled over started (else its newest
   * reading), and its newest reading.
   */
  stall(): FactionWorkStall | null {
    const watch = this.#watch;
    if (watch === null) return null;
    const lastReadingAtMs = watch.readings.at(-1)?.atMs as number;
    // Not stalled: since the newest reading, so the alert waits for the next, unless none comes (the alert says so).
    return { faction: watch.faction, sinceMs: watch.stalledSinceMs ?? lastReadingAtMs, lastReadingAtMs };
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
    const resetAt = (slowData?.resetInfo as { lastAugReset?: unknown } | undefined)?.lastAugReset;
    if (typeof resetAt === "number" && resetAt !== this.#leftLoggedResetAt) {
      this.#leftLogged.clear();
      this.#leftLoggedResetAt = resetAt;
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
    const notSent = !enabled
      ? "the brain's faction work is switched off"
      : ownersWork
        ? "your work on the dashboard"
        : null;
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
    const now = { atMs: slowAtMs, reputation: sent.reputation };
    // A skipped reading (#197: the casino, an infiltration) is the last one again: not a reading of the window's.
    const reading = factionReadingOf(slowData);
    if (
      watch !== null &&
      watch.faction === sent.faction &&
      reading !== null &&
      factionReadingKind(reading) === "skipped"
    ) {
      return;
    }
    if (watch === null || watch.faction !== sent.faction) {
      this.#watch = { faction: sent.faction, readings: [now], stalledSinceMs: null };
      return;
    }
    if (slowAtMs === watch.readings.at(-1)?.atMs) return;
    const under = underRateSince(watch.readings, now, sent.reputationPerSecond);
    watch.readings = trimmedReadings([...watch.readings, now], slowAtMs);
    if (under === null) {
      if (watch.stalledSinceMs !== null) {
        this.#log(`faction work: ${watch.faction}'s reputation is rising at the work's rate again`);
      }
      watch.stalledSinceMs = null;
    } else if (watch.stalledSinceMs === null) {
      watch.stalledSinceMs = under;
      this.#log(
        `faction work STALLED: ${watch.faction}'s reputation has risen under half the ${sent.workType} work's ` +
          `${sent.reputationPerSecond.toFixed(2)}/s over the last ${Math.floor((slowAtMs - under) / 60_000)} min, at ` +
          `${formatReputation(sent.reputation)}, with the work the brain's choice`,
      );
    }
  }
}

// --- What the run report reads (#185) ---------------------------------------------------------------------------------

/**
 * Slow snapshots (every 60 s) further apart than this are a gap: the stall's clock starts again after one, as the
 * snapshots' gap is a failure of its own.
 */
export const SLOW_SNAPSHOT_GAP_MS = 3 * 60_000;

/** A stretch in which the brain's faction work earned under half its rate over each 10-minute window. */
export interface ReputationStall {
  faction: string;
  workType: string;
  /** The work's rate, at its choice. */
  reputationPerSecond: number;
  /** The start of the first window judged under the rate, to the last slow snapshot whose window was. */
  fromMs: number;
  toMs: number;
  /** Still under it at the report window's last slow snapshot. */
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
 * and the stretches in which it rose under half the work's rate over the last `FACTION_WORK_STALLED_AFTER_MS`
 * (`underRateSince`, with the rate stored at the choice: the skills only grow, so the work earns at least that).
 */
export class FactionWorkTimeline {
  /** The choices and ends, in time order; a malformed one is left out. */
  readonly records: FactionWorkRecord[] = [];
  /** Each faction the medium snapshots showed joined, and when first: null for those joined at the first one. */
  readonly joined = new Map<string, number | null>();
  /** Each invitation from a faction with enemies the slow snapshots showed, not joined, and when first. */
  readonly leftToOwner = new Map<string, number>();
  /** Each faction's reputation gained while the brain's work was on it: its rises, summed (skipped readings aside). */
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
    /** The readings since the work's first, or the one after a gap, that its window still needs. */
    readings: ReputationReading[];
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
    const reading = factionReadingOf(data);
    const state = reading?.state ?? null;
    if (reading === null || state === null) return;
    const joinedNow = state.joined.map((each) => each.name);
    for (const { faction } of chooseJoin(state.invitations, joinedNow).leftToOwner) {
      if (!this.leftToOwner.has(faction)) this.leftToOwner.set(faction, atMs);
    }
    // A skipped reading (#197) is the last one again: neither a gain nor a reading of the stall's window.
    if (factionReadingKind(reading) === "skipped") return;
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
        readings: [{ atMs, reputation }],
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
    const now = { atMs, reputation };
    if (atMs - watch.lastSlowMs > SLOW_SNAPSHOT_GAP_MS) {
      if (watch.stall) watch.stall.ongoing = false;
      watch.stall = null;
      watch.readings = [now];
    } else {
      const under = underRateSince(watch.readings, now, perSecond);
      watch.readings = trimmedReadings([...watch.readings, now], atMs);
      if (under === null) {
        if (watch.stall) watch.stall.ongoing = false;
        watch.stall = null;
      } else if (watch.stall) {
        watch.stall.toMs = atMs;
      } else {
        watch.stall = { faction, workType, reputationPerSecond: perSecond, fromMs: under, toMs: atMs, ongoing: true };
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
