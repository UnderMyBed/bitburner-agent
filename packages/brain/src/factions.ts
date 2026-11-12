// Factions and their work (#203, M4 phase A slice A5): the brain joins every invitation from a faction with no enemies,
// and works for the faction and work type that bring the most hacking value per second of work, so a run earns the
// reputation A6 buys with. Choices computed from the game's formulas (owner decision 46). Also what the dashboard's
// `factionWorkStalled` alert and the run report (#185) read of them.
// - Joining: the `joinFaction` intent (#147), one at a time, in the order invited. A faction with enemies (the six
//   city factions, `Faction/FactionInfo.tsx:495-555`) bans them when joined (`Faction/FactionHelpers.tsx:45-47`),
//   until the next install (`Faction/Faction.ts:77-85`): the brain joins those of the city group it chose this cycle
//   that sell something of value (owner decision 54, ./invitations.ts), and never another group's. The irreversible
//   gate's enemy guard stays under it (./irreversible-gate.ts).
// - Working: the choice itself is core's (`factionWorkChoice`, packages/core/src/faction-work-choice.ts, moved there
//   in #260 so the fast model makes the same one): the augmentation with the most hacking value per second of work to
//   reach its reputation; The Red Pill first (#215, A8); toward donation favour at a faction that takes donations
//   (#225, owner decision 53: `workTarget`, `redPillTarget`); every augmentation a candidate short of Daedalus's count
//   (#228); an install held for the count first (#243). With the Augmentations switch off, no install or donation
//   follows, so the work is to the augmentation's reputation. This reads the snapshots and calls it.
//   Tian Di Hui's and the city factions' invitations are ./invitations.ts's travel.
// - The owner's work wins; the dashboard's switch for the brain's faction work turns it off.
import {
  augmentationBitNodeMultipliers,
  CITY_FACTION_GROUPS,
  type DaedalusCount,
  daedalusCountOf,
  FACTION_ENEMIES,
  FACTION_NAMES,
  FACTIONS,
  type FactionState,
  type FactionWorkChoice,
  type FactionWorkType,
  factionReadingKind,
  factionReadingOf,
  factionWorkChoice,
  favorAfterInstall,
  gangSellsRedPill,
  type Intent,
  intentId,
  type JoinedFaction,
  type MediumSnapshotData,
  NEURORECEPTOR_MANAGEMENT_IMPLANT,
  type SlowSnapshotData,
  type WorkConditions,
  type WorkingPerson,
  type WorkResetInfo,
} from "@bitburner-agent/core";
import { CITY_GROUP_CHOSEN_EVENT_KIND, type InvitationView } from "./invitations.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";
import { workFocus } from "./work.ts";

// The work's choice moved to core (#260); these names stay here for the brain's other modules and tests.
export {
  bestWorkRate,
  type FactionWorkChoice,
  RED_PILL_EARNED_SHARE,
  redPillTarget,
  redPillWork,
  WORK_TO_AUGMENTATION_WITHIN,
  WORK_TYPE_SWITCH_GAIN,
  type WorkCandidate,
  type WorkConditions,
  type WorkResetInfo,
  type WorkTarget,
  workCandidates,
  workTarget,
} from "@bitburner-agent/core";

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

/** A city faction's invitation the brain doesn't join (#228): not of its city group, and those joining it would ban. */
export interface PassedOver {
  faction: string;
  bans: string[];
}

export interface JoinPlan {
  /** The faction to join now, or null. */
  next: string | null;
  /**
   * While `next` is a city faction (irreversible: it waits at the irreversible gate, #269), the first other invitation
   * from a faction without enemies, joined beside it so the gate's wait holds up nothing that bans nothing; else null.
   */
  alongside: string | null;
  /** The city factions' invitations not of the brain's city group, in the order invited. */
  passedOver: PassedOver[];
}

/**
 * The invitations not yet joined, in the order invited: the first from a faction without enemies, or from a city
 * faction in `cityFactions` (the city group the brain chose, #228's), is joined; the other city factions' are passed
 * over. A name that isn't one of the game's factions is passed over too.
 */
export function chooseJoin(
  invitations: readonly string[],
  joined: readonly string[],
  cityFactions: readonly string[] = [],
): JoinPlan {
  const open = invitations.filter((faction) => FACTION_NAMES.includes(faction) && !joined.includes(faction));
  const bansNothing = (faction: string) => FACTION_ENEMIES[faction] === undefined;
  const joins = (faction: string) => bansNothing(faction) || cityFactions.includes(faction);
  const next = open.find(joins) ?? null;
  return {
    next,
    alongside:
      next === null || bansNothing(next)
        ? null
        : (open.find((faction) => faction !== next && bansNothing(faction)) ?? null),
    passedOver: open
      .filter((faction) => !joins(faction))
      .map((faction) => ({ faction, bans: [...(FACTION_ENEMIES[faction] ?? [])] })),
  };
}

/** The `joinFaction` intent for `faction`. */
export function joinIntent(faction: string): Intent {
  const args = { faction };
  return { id: intentId("joinFaction", args), action: "joinFaction", args };
}

// --- Working ----------------------------------------------------------------------------------------------------------

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
export function chooseFactionWork(
  mediumData: MediumSnapshotData,
  slowData: SlowSnapshotData,
  shareBonus = 1,
  keep?: { faction: string; workType: FactionWorkType },
  {
    donations = true,
    held = null,
    gang = null,
  }: {
    donations?: boolean;
    held?: { faction: string; augmentation: string } | null;
    /** The gang's faction (#334, `gangShopOf`): its shop "already reached", never worked for. */
    gang?: JoinedFaction | null;
  } = {},
): FactionWorkPlan {
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
    const conditions = {
      ...workConditionsOf(resetInfo, slowData, shareBonus),
      donations,
      ...(keep ? { keep } : {}),
      gang,
    };
    const count = countOf(state, resetInfo, gangSellsRedPill(gang?.name ?? null, resetInfo.currentNode));
    const choice = factionWorkChoice(person, state, resetInfo, conditions, count, held);
    if (choice === null) return waiting("an augmentation worth working for at the joined factions", false);
    return { choice, waitingFor: null, transient: false };
  } catch (error) {
    return waiting(`the snapshots as core knows the game (${(error as Error).message})`, false);
  }
}

/**
 * Daedalus's count (#228) from the faction state and the reset info: core's `daedalusCountOf`; never short with The
 * Red Pill sold elsewhere (#334, `redPillElsewhere`: the gang's faction in BN2).
 */
export function countOf(
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  redPillElsewhere = false,
): DaedalusCount {
  return daedalusCountOf({
    currentNode,
    ownedSF,
    installed: ownedAugs,
    joined: state.joined,
    invitations: state.invitations,
    redPillElsewhere,
  });
}

/** The work conditions in the slow snapshot's reset info, and the share bonus. Throws for a BitNode core doesn't know. */
export function workConditionsOf(
  resetInfo: WorkResetInfo,
  slowData: SlowSnapshotData | null,
  shareBonus = 1,
): WorkConditions {
  const { currentNode, ownedAugs, ownedSF } = resetInfo;
  return {
    sourceFile15Level: ownedSF["15"] ?? 0,
    // Faction work's focus turns on the implant alone, the same for every faction and work type.
    focused: workFocus({ kind: "faction", faction: "CyberSec", workType: "hacking" }, slowData),
    implant: Object.hasOwn(ownedAugs, NEURORECEPTOR_MANAGEMENT_IMPLANT),
    factionWorkRepGain: augmentationBitNodeMultipliers(currentNode, ownedSF).FactionWorkRepGain,
    favorToDonateToFaction: augmentationBitNodeMultipliers(currentNode, ownedSF).FavorToDonateToFaction,
    shareBonus,
  };
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
  /** A faction without enemies joined beside `joining` while that one, a city faction's, waits at the gate (#269). */
  joiningAlongside: string | null;
  /** The city factions' invitations not joined, not of the city group the brain chose (#228). */
  passedOver: PassedOver[];
  /** The city group the brain chose this cycle, in words (#228, ./invitations.ts), or null before it's known. */
  cityGroup: string | null;
  /** The travel for invitations (#228 review): the travel, the hold, or why it waits; the controller's, absent here. */
  invitations?: InvitationView;
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
  /** Why the brain's other work goes instead (#367: Bladeburner's training), or null (absent: none). */
  heldFor?: string | null;
  /** The Augmentations switch (#225): off, no donation follows, so the work is to each augmentation's reputation. */
  augmentationsEnabled?: boolean;
  /** The brain's faction work's switch. */
  enabled: boolean;
  /** The share bonus running (#224): the work's rate counts it. 1 when absent. */
  shareBonus?: number;
  /** The city factions to join (#228): the chosen city group's that sell something of value; none when absent. */
  cityFactions?: readonly string[];
  /** The city group chosen, in words (#228), or null. */
  cityGroup?: string | null;
  /** The augmentation an install is held for by work (#243 review, A6's `countHoldTarget`), worked for first. */
  countHoldTarget?: { faction: string; augmentation: string } | null;
  /** The gang's faction (#334, `gangShopOf`), or null (absent: none): its shop counts as reached, never worked for. */
  gangShop?: JoinedFaction | null;
}

const formatReputation = (reputation: number) => Math.round(reputation).toLocaleString("en-US");

/** An ETA in words: "45 s", "12 min", "3.4 h". */
export function describeEta(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/**
 * A choice in words, for the log, the dashboard and the run report; one for donations' favour (#225) says so, with the
 * augmentation's own reputation and the favour after the next install at the target.
 */
export function describeChoice(choice: FactionWorkChoice): string {
  const target =
    choice.target === "donations"
      ? `: donations at the next install, ${choice.augmentation} at ` +
        `${formatReputation(choice.augmentationReputation ?? Number.NaN)}` +
        (typeof choice.favor === "number"
          ? `; favour ${choice.favor.toFixed(1)}, ${favorAfterInstall(choice.favor, choice.reputationNeeded).toFixed(1)} ` +
            "after the next install at it"
          : "")
      : "";
  return (
    `${choice.workType} for ${choice.faction}, for ${choice.augmentation} (reputation ` +
    `${formatReputation(choice.reputation)} of ${formatReputation(choice.reputationNeeded)}${target}, ` +
    `${choice.reputationPerSecond.toFixed(2)}/s: about ${describeEta(choice.etaSeconds)})` +
    (choice.count === undefined
      ? ""
      : `, for Daedalus's count: ${choice.count.installed} of ${choice.count.required} augmentations installed`) +
    (choice.held === true ? ", the install held for it" : "")
  );
}

/**
 * Joins and faction work as the desired state's controller runs them, on every update (so it logs only on a change):
 * the join to send and the work to send, the view, the stall, and the events for the store.
 * - The join is asked for until a snapshot shows the faction joined; the next waits for it, but for one that bans
 *   nothing, joined beside a city faction's while that one waits at the irreversible gate (#269 review).
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
  /** The city factions' invitations passed over already logged, since the game's last reset. */
  readonly #passedOverLogged = new Set<string>();
  /** The game's `lastAugReset` when they were logged: another (an install) logs them afresh, as they come again. */
  #passedOverResetAt: number | null = null;
  /** The last choice stored (faction, work type, target), "stopped", or null before any. */
  #lastStored: string | null = null;
  /** The work sent at the last update, kept against the share bonus's swings (#226's review), or null. */
  #sent: { faction: string; workType: FactionWorkType } | null = null;
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
    joiningAlongside: null,
    passedOver: [],
    cityGroup: null,
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

  update(inputs: FactionInputs): {
    join: Intent | null;
    joinAlongside: Intent | null;
    work: { faction: string; workType: FactionWorkType } | null;
  } {
    const { join, joinAlongside } = this.#join(inputs);
    const work = this.#work(inputs);
    return { join, joinAlongside, work };
  }

  #join({ mediumData, slowData, cityFactions = [], cityGroup = null }: FactionInputs): {
    join: Intent | null;
    joinAlongside: Intent | null;
  } {
    const state = slowData === null ? null : (factionReadingOf(slowData)?.state ?? null);
    const joined = (mediumData?.player as { factions?: unknown } | undefined)?.factions;
    if (state === null || !Array.isArray(joined)) {
      this.#view = { ...this.#view, joining: null, joiningAlongside: null, passedOver: [], cityGroup };
      return { join: null, joinAlongside: null };
    }
    const resetAt = (slowData?.resetInfo as { lastAugReset?: unknown } | undefined)?.lastAugReset;
    if (typeof resetAt === "number" && resetAt !== this.#passedOverResetAt) {
      this.#passedOverLogged.clear();
      this.#passedOverResetAt = resetAt;
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
    const plan = chooseJoin(state.invitations, joinedNames, cityFactions);
    for (const { faction, bans } of plan.passedOver) {
      if (this.#passedOverLogged.has(faction)) continue;
      this.#passedOverLogged.add(faction);
      this.#log(
        `factions: ${faction}'s invitation not joined (it would ban ${bans.join(", ")}): ` +
          `${cityGroup ?? "no city group chosen"} (decision 54)`,
      );
    }
    // Asked for until a snapshot shows it joined: the invitations are in the order received, so it stays the first.
    const next = plan.next;
    if (next !== null && next !== this.#joining) {
      this.#joining = next;
      this.#log(`factions: joining ${next} (its invitation)`);
    }
    // The join beside, logged as the first is: when it starts, and when it's joined or no longer asked for.
    const besideBefore = this.#view.joiningAlongside;
    if (besideBefore !== null && besideBefore !== plan.alongside) {
      this.#log(
        joinedNames.includes(besideBefore)
          ? `factions: ${besideBefore} joined`
          : `factions: no longer joining ${besideBefore} beside ${this.#view.joining ?? "a join with enemies"}`,
      );
    }
    if (plan.alongside !== null && plan.alongside !== besideBefore) {
      this.#log(
        `factions: joining ${plan.alongside} (its invitation) beside ${next}'s join, which has enemies, so goes ` +
          "through the irreversible gate",
      );
    }
    this.#view = {
      ...this.#view,
      joining: next,
      joiningAlongside: plan.alongside,
      passedOver: plan.passedOver,
      cityGroup,
    };
    return {
      join: next === null ? null : joinIntent(next),
      joinAlongside: plan.alongside === null ? null : joinIntent(plan.alongside),
    };
  }

  #work(inputs: FactionInputs): { faction: string; workType: FactionWorkType } | null {
    const { mediumData, slowData, slowAtMs, nowMs, ownersWork, enabled, shareBonus = 1 } = inputs;
    const plan: FactionWorkPlan =
      mediumData === null || slowData === null
        ? { choice: null, waitingFor: "the Agent's medium and slow snapshots", transient: true }
        : chooseFactionWork(mediumData, slowData, shareBonus, this.#sent ?? undefined, {
            donations: inputs.augmentationsEnabled ?? true,
            held: inputs.countHoldTarget ?? null,
            gang: inputs.gangShop ?? null,
          });
    const notSent = !enabled
      ? "the brain's faction work is switched off"
      : ownersWork
        ? "your work on the dashboard"
        : (inputs.heldFor ?? null);
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
    this.#sent = sent === null ? null : { faction: sent.faction, workType: sent.workType };
    return sent === null ? null : { faction: sent.faction, workType: sent.workType };
  }

  /** The choice stored when it changes; its end when a definite `reason` stops it. */
  #store(sent: FactionWorkChoice | null, reason: string | null, nowMs: number | null): void {
    if (nowMs === null) return;
    if (sent !== null) {
      const key = JSON.stringify([sent.faction, sent.workType, sent.augmentation, sent.reputationNeeded]);
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

/** A stored choice's optional figures (#225), where they're as the brain writes them. */
function targetFieldsOf(detail: Partial<FactionWorkChoice>): Partial<FactionWorkChoice> {
  return {
    ...(detail.target === "donations" || detail.target === "augmentation" ? { target: detail.target } : {}),
    ...(isFiniteNumber(detail.augmentationReputation) ? { augmentationReputation: detail.augmentationReputation } : {}),
    ...(isFiniteNumber(detail.favor) ? { favor: detail.favor } : {}),
    ...(isFiniteNumber(detail.count?.installed) && isFiniteNumber(detail.count?.required)
      ? { count: { installed: detail.count.installed, required: detail.count.required } }
      : {}),
  };
}

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
 * ends one too, as the brain that made it is gone), the factions the medium snapshots show joined, the city factions'
 * invitations (#228), and, from the slow snapshots, each faction's reputation gained while the brain's work was on it,
 * and the stretches in which it rose under half the work's rate over the last `FACTION_WORK_STALLED_AFTER_MS`
 * (`underRateSince`, with the rate stored at the choice: the skills only grow, so the work earns at least that).
 */
export class FactionWorkTimeline {
  /** The choices and ends, in time order; a malformed one is left out. */
  readonly records: FactionWorkRecord[] = [];
  /** Each faction the medium snapshots showed joined, and when first: null for those joined at the first one. */
  readonly joined = new Map<string, number | null>();
  /**
   * Each city faction's invitation the slow snapshots showed (#228) that the brain passed over: not joined then, nor of
   * the city group it had chosen by then (`cityGroupChosen`); and when first.
   */
  readonly passedOver = new Map<string, number>();
  /** The city group chosen, as stored (#228), in time order. */
  readonly #cityGroups: { atMs: number; group: string | null }[];
  /** Each faction's reputation gained while the brain's work was on it: its rises, summed (skipped readings aside). */
  readonly gained = new Map<string, number>();
  /** Each reading of the worked faction's reputation, skipped ones aside (#224: the share's gain is judged on them). */
  readonly readings: { atMs: number; faction: string; reputation: number }[] = [];
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
          ...targetFieldsOf(detail),
        };
        this.records.push({ atMs, kind: "chosen", choice });
      } else if (kind === FACTION_WORK_STOPPED_EVENT_KIND) {
        const reason = (detail as { reason?: unknown } | null)?.reason;
        this.records.push({ atMs, kind: "stopped", reason: typeof reason === "string" ? reason : "no reason stored" });
      }
    }
    this.#ends = events.filter((event) => event.kind === brainStartedKind).map((event) => event.atMs);
    this.#cityGroups = events
      .filter((event) => event.kind === CITY_GROUP_CHOSEN_EVENT_KIND)
      .map(({ atMs, detail }) => {
        const group = (detail as { group?: unknown } | null)?.group;
        return { atMs, group: typeof group === "string" ? group : null };
      });
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

  /** Slow snapshots, in time order: the city invitations passed over, and the reputation under the brain's work. */
  addSlow(atMs: number, data: SlowSnapshotData): void {
    const reading = factionReadingOf(data);
    const state = reading?.state ?? null;
    if (reading === null || state === null) return;
    const joinedNow = state.joined.map((each) => each.name);
    const chosen = this.#cityGroups.findLast((each) => each.atMs <= atMs)?.group ?? null;
    const ofChosen = CITY_FACTION_GROUPS.find((group) => group.name === chosen)?.factions ?? [];
    for (const { faction } of chooseJoin(state.invitations, joinedNow, ofChosen).passedOver) {
      if (!this.passedOver.has(faction)) this.passedOver.set(faction, atMs);
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
    this.readings.push({ atMs, faction, reputation });
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
