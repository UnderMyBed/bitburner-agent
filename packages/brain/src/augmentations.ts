// Augmentations and the reset (#210, M4 phase A slice A6): the brain buys the augmentations worth installing and
// installs them, the run's reset cycle. Choices computed from the game's formulas (owner decision 46), in core's
// augmentation-plan.ts; this is the rule as the controller runs it, and what the dashboard and the run report read.
// - Not committed: each update, the set the money covers of the augmentations reached (a joined seller's reputation
//   covers them), the counts of what's affordable, and core's `installRule`, the legacy scripts' count rule (#222,
//   owner decision 51), on a clock of the game's time the brain saw online this cycle (`advanceOnlineClock`, kept in
//   the store). The rule saying install starts a countdown in the game's time (90 s, 30 s for a quick install),
//   extended as the count rises and called off if the rule stops saying so, with the counted purchases' money held
//   back from cloud servers and home RAM. At its end, the install is chosen: committed, kept in the store until the
//   game resets, so a restarted brain carries on. Each change in the counts, the bars or the countdown is an
//   `augmentationProgress` event, for the run report.
// - Committed, one intent at a time: the set's next purchase (recomputed from what's queued), then home's RAM, which
//   an install keeps (`Server/ServerHelpers.ts:224-237`), then NeuroFlux Governor a level at a time, then, once
//   every purchase the Agent reported done shows in the faction state's queue, the install (the controller's gate and
//   backup), never of nothing (#213 re-review).
//   Once the install is asked for, nothing more is bought, so the gate's count isn't restarted by a purchase.
// - The income: a 10-minute window with no gap, for one thing alone: before the rule says install, the money is held
//   back from cloud servers only for an install the rule would choose with 15 minutes more of it (A2's, #213).
// - Fail loudly: a purchase reported done that two faction state reads after it don't show queued is
//   `augmentationNotQueued` (an event, a log line, the dashboard's alert and the run report's failure); an install
//   reported done that the next slow snapshot doesn't show reset is `augmentationInstallNotReset` (likewise).
// - The Red Pill first (#215, A8): with Daedalus's count of installed augmentations reached and its other
//   requirements but the money, no install is chosen and its $100b is held back from cloud servers, until it invites
//   (A5 joins). Joined, none is chosen while The Red Pill is short of its reputation (an install resets it,
//   `Faction/Faction.ts:77-85`), or until Daedalus's reputation unlocks its donations at the next install (#225,
//   "Daedalus donations", below); reached, or queued, the install is chosen ("The Red Pill"), and it's bought last.
// - The "Augmentations" switch, on by default (owner decision 48): off, nothing is bought or installed, and a cycle
//   under way is called off (what's bought stays queued, for the owner).
// - Donations (#225, owner decision 53, under the same switch): an augmentation sold by a joined faction with donations
//   unlocked counts as within reach when the money covers its price and the donation for its missing reputation
//   (core's `chooseAugmentationsToBuy` and `affordableCounts` with `DonationTerms`), so the counts, the countdown's
//   hold and the reserve include the donations. The commit's note records each faction's donation; committed, they go
//   first, one faction at a time (the `donateToFaction` intent), each confirmed by the faction state showing the
//   reputation before anything else is bought (else `augmentationDonationFailed`: the cycle called off, alerted).
// - Daedalus's favour (#225, legacy `autopilot.js:920-931`): with Daedalus joined, its donations not unlocked (and
//   unlockable in the BitNode), its reputation this cycle enough to unlock them at the next install, and The Red Pill's
//   not reached, an install is chosen ("Daedalus donations", the normal countdown), if anything is to install. Once
//   they're unlocked, The Red Pill's way donates its reputation and buys it when the money covers the donation.
// - Short of Daedalus's count (#228, core's `daedalusCountOf`): every augmentation but NeuroFlux Governor and The Red
//   Pill is worth installing (core's `isWorthInstalling`), in the set (hacking value first, then the cheapest), the
//   counts and bars, the countdown, the lookahead's reserve and "nothing left"; the progress says so.
// - Held for Daedalus's count (#243, core's `daedalusCountHold`): an install the count rule chose that would leave the
//   count one short is held while the last can be bought within the hold's window (`DAEDALUS_COUNT_HOLD_MS`, 20 min
//   online from the cycle's first hold, kept in the store): its reputation by work at A5's rate for its seller, or a
//   donation, and the money at the income (`countablesToCome`). No countdown meanwhile; the countdown's money (or the
//   set's and the last's, if more) held back from cloud servers and home RAM; the progress, the dashboard and the log
//   say so, and when it's over.
// - The planner's levelling install (#336, ./levelling.ts): The Red Pill installed and every install held for the
//   destroy, A6 offers the NeuroFlux Governor levels the money buys (`neuroFluxOffer`); once the planner chooses them,
//   the install is chosen at once (`reason` "the hacking level"), the destroy's hold set aside for it.
import {
  type AugmentationPurchaseState,
  type AugmentationSet,
  type AugmentationShops,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationEndgame,
  augmentationShops,
  type CountableToCome,
  type CountableWithinReach,
  chooseAugmentationsToBuy,
  countAfterInstall,
  countablesToCome,
  countablesWithinReach,
  countdownExtensionMs,
  DAEDALUS,
  DAEDALUS_COUNT_HOLD_MS,
  type DaedalusCount,
  type Donation,
  daedalusCountHold,
  daedalusCountOf,
  daedalusRequirements,
  daedalusSkillsReached,
  donationTermsOf,
  donationToReach,
  type FactionState,
  factionReadingKind,
  factionReadingOf,
  GANG_RED_PILL_HOLD_MS,
  gangSellsRedPill,
  type HoldWork,
  INSTALL_COUNTDOWN_MS,
  type InstallReason,
  type Intent,
  installJudgement,
  intentId,
  type JoinedFaction,
  type MediumSnapshotData,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
  QUICK_INSTALL_COUNTDOWN_MS,
  QUICK_INSTALL_WITHIN_MS,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { CLOUD_SERVER_PAYBACK_LIMIT_MS } from "./cloud-servers.ts";
import { workConditionsOf, workingPersonOf } from "./factions.ts";
import { chooseHomeRamUpgrade } from "./home-ram.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

// What's within reach beyond a joined seller's reputation moved to core (#260); these names stay here for the brain's
// other modules and tests.
export { type CountableWithMoney, countablesToCome, donationTermsOf, type HoldWork } from "@bitburner-agent/core";

/** The dashboard's switch (#210): on unless turned off (owner decision 48). */
export const AUGMENTATIONS_ENABLED_SETTING = "augmentations.enabled";

export function readAugmentationsEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, AUGMENTATIONS_ENABLED_SETTING, true);
}

export function writeAugmentationsEnabled(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, AUGMENTATIONS_ENABLED_SETTING, enabled);
}

/**
 * The commit, kept in the store until the game resets: the game's `lastAugReset` when the install was chosen, and
 * whether the install has been asked for (so a restarted brain buys nothing more, #213 review).
 */
export const AUGMENTATION_CYCLE_SETTING = "augmentations.cycle";

/**
 * The bars' clock (#222), kept in the store so a restarted brain carries it on: the game's time the brain saw online
 * since the last install (`advanceOnlineClock`), keyed by that install's `lastAugReset`.
 */
export const AUGMENTATION_ONLINE_SETTING = "augmentations.online";

/**
 * The hold for Daedalus's count (#243), kept in the store so a restarted brain doesn't start its window again: the
 * cycle's `lastAugReset`, and the time online at its first hold.
 */
export const AUGMENTATION_COUNT_HOLD_SETTING = "augmentations.countHold";

/** How long the income is measured over: the slow snapshots' money sources across 10 minutes. */
export const AUGMENTATION_INCOME_WINDOW_MS = 10 * 60_000;
/**
 * Slow snapshots further apart than this (3 slow intervals, 3 minutes) have a gap between them: the game closed
 * (offline earns a fraction of the online rate), or the Agent or the brain away. The time across it isn't online time
 * (the bars' clock leaves it out, #222), and what was earned across it isn't the income, so the window starts again.
 */
export const AUGMENTATION_SLOW_GAP_MS = 3 * SNAPSHOT_TIER_PERIOD_MS.slow;
/**
 * Before the rule says install, money is held back from cloud servers (A2, #194) only for an install the rule would
 * choose with this much more income: A2's payback limit (`CLOUD_SERVER_PAYBACK_LIMIT_MS`, 15 minutes, decided in
 * #213's review). A server bought now pays itself back within it, so holding money any sooner would cost the income.
 */
export const AUGMENTATION_RESERVE_LOOKAHEAD_MS = CLOUD_SERVER_PAYBACK_LIMIT_MS;
/**
 * Faction state reads after a purchase reported done that may miss it before it's `augmentationNotQueued`: 2. The first
 * may have been read before the purchase, in the same round (snapshots come before the intents).
 */
export const NOT_QUEUED_AFTER_READS = 2;

/**
 * The money sources that are earnings (`utils/MoneySourceTracker.ts`): what the income counts. The rest are spending
 * (servers, augmentations, Hacknet's and a gang's expenses, classes, hospitals), mixed (stocks, corporations, casino),
 * or "other", which holds program purchases and an install's starting money alike.
 */
export const EARNING_SOURCES = ["hacking", "work", "crime", "hacknet", "codingcontract", "infiltration"] as const;

/** The events the rule stores (#210), for the run report. */
export const AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND = "augmentationInstallChosen";
export const AUGMENTATION_BOUGHT_EVENT_KIND = "augmentationBought";
export const AUGMENTATION_NOT_QUEUED_EVENT_KIND = "augmentationNotQueued";
export const AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND = "augmentationCycleCalledOff";
/** Stored by the controller, as the install goes out (its reset note written): the brain's, or the owner's. */
export const AUGMENTATION_INSTALL_SENT_EVENT_KIND = "augmentationInstallSent";
/**
 * The install reported done, and the next slow snapshot showing no reset (#213 re-review): the game had nothing to
 * install, though the faction state's queue said otherwise. The cycle is called off; a run report failure.
 */
export const AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND = "augmentationInstallNotReset";
/**
 * The counts, a bar or the countdown changed (#222), or why the rule is held: one each time, none while steady. The
 * run report lists them, and fails a cycle overdue its install on them.
 */
export const AUGMENTATION_PROGRESS_EVENT_KIND = "augmentationProgress";
/** A change in the counts alone is recorded at most this often (#222 review); any other change at once. */
export const AUGMENTATION_PROGRESS_COUNTS_EVERY_MS = 5 * 60_000;
/**
 * A donation reported done that the faction state then showed (#225): the faction's reputation before and after. One
 * that two faction state reads after it don't show is `augmentationDonationFailed` (the cycle called off, alerted).
 */
export const AUGMENTATION_DONATED_EVENT_KIND = "augmentationDonated";
export const AUGMENTATION_DONATION_FAILED_EVENT_KIND = "augmentationDonationFailed";

/** The install of the queued augmentations (#164), as the rule asks for it: the owner's has the same id. */
export const AUGMENTATION_INSTALL_INTENT: Intent = {
  id: intentId("installAugmentations", {}),
  action: "installAugmentations",
  args: {},
};

/**
 * Where the count rule stands (#222), for the dashboard, the events and the report: the counts, the bars, the time
 * online this cycle and the online time until each bar falls next (null once at 1), why it would install, the
 * countdown (its end in the game's time, and how far off), and why the rule is held (The Red Pill's way), or null.
 */
export interface AugmentationProgress {
  lastAugReset: number;
  affordable: number;
  affordableWithNeuroFlux: number;
  bar: number;
  barWithNeuroFlux: number;
  onlineMs: number;
  barFallsInMs: number | null;
  barWithNeuroFluxFallsInMs: number | null;
  reason: InstallReason | null;
  countdown: { endsAtGameMs: number; endsInMs: number; quick: boolean; extensions: number } | null;
  held: string | null;
  /** How many of the counted purchases, the set's and NeuroFlux Governor's levels, need a donation (#225). */
  byDonation: number;
  /** What the set and its donations cost (#225 review): the run report's "donations unused" weighs what's left. */
  setCost: number;
  /**
   * Short of Daedalus's count (#228): installed of required, any augmentation counting; null when not. Absent in an
   * earlier brain's progress.
   */
  short?: Pick<DaedalusCount, "installed" | "required"> | null;
  /**
   * The install held for Daedalus's count (#243): the augmentation it waits for (`CountableToCome`), its money, and
   * what's left of the hold's window; null when not. Absent in an earlier brain's progress.
   */
  countHold?: CountHoldView | null;
}

/** An install held for Daedalus's count (#243), as the progress gives it. */
export type CountHoldView = CountableToCome & { money: number; leftMs: number };

export type AugmentationEvent =
  | {
      type: typeof AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND;
      atMs: number;
      /** The set to buy, in buy order, at its prices then, and the money in all. */
      set: { augmentation: string; price: number }[];
      cost: number;
      /** Bought already, not installed. */
      queued: string[];
      /** The game's time the brain saw online this cycle, and the counts and bars then. */
      onlineMs: number;
      affordable: number;
      affordableWithNeuroFlux: number;
      bar: number;
      barWithNeuroFlux: number;
      /** The count reached, a quick install, nothing left at the joined factions, The Red Pill or Daedalus's favour. */
      reason: InstallReason;
      /** The donations the commit makes first, one a faction (#225). */
      donations: Donation[];
    }
  | {
      type: typeof AUGMENTATION_DONATED_EVENT_KIND;
      atMs: number;
      faction: string;
      amount: number;
      /** The faction's reputation the donation is for, and as the faction state showed it before and after. */
      reputation: number;
      before: number;
      after: number;
    }
  | {
      type: typeof AUGMENTATION_DONATION_FAILED_EVENT_KIND;
      atMs: number;
      faction: string;
      amount: number;
      reputation: number;
      /** The reputation the faction state showed at its last read, and when the donation was reported done. */
      shown: number | null;
      donatedAtMs: number;
    }
  | ({ type: typeof AUGMENTATION_PROGRESS_EVENT_KIND; atMs: number } & AugmentationProgress)
  | {
      type: typeof AUGMENTATION_BOUGHT_EVENT_KIND;
      atMs: number;
      augmentation: string;
      faction: string;
      level: number;
      price: number;
      /** The queue's length with it. */
      queueLength: number;
    }
  | {
      type: typeof AUGMENTATION_NOT_QUEUED_EVENT_KIND;
      atMs: number;
      augmentation: string;
      level: number;
      boughtAtMs: number;
    }
  | { type: typeof AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND; atMs: number; reason: string }
  | {
      type: typeof AUGMENTATION_INSTALL_SENT_EVENT_KIND;
      atMs: number;
      source: "brain" | "manual";
      /** The queue as last known: the faction state's, with the purchases since. */
      queued: string[];
    }
  | {
      type: typeof AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND;
      atMs: number;
      /** The queue as last known, which the game didn't install. */
      queued: string[];
    };

/** The purchase asked for, with its price then; `augmentation` null for home's RAM and a donation (`donation`'s). */
interface Asked {
  intent: Intent;
  augmentation: string | null;
  faction: string;
  level: number;
  price: number;
  /** A donation (#225): the reputation it's for, and the faction's before it. */
  donation?: { reputation: number; before: number };
}

/** A donation reported done that the faction state hasn't shown yet (#225). */
interface Donated {
  faction: string;
  amount: number;
  reputation: number;
  before: number;
  atMs: number;
  reads: number;
  shown: number | null;
}

/** A donation the faction state never showed (#225): the alert's. */
export interface DonationFailed {
  faction: string;
  amount: number;
  reputation: number;
  donatedAtMs: number;
}

/** A purchase the Agent reported done and the faction state hasn't shown queued yet. */
interface Bought {
  augmentation: string;
  level: number;
  atMs: number;
  /** Faction state reads since it was reported done, none showing it. */
  reads: number;
}

/** A purchase reported done that the faction state never showed queued (#210): the alert's. */
export interface NotQueued {
  augmentation: string;
  level: number;
  boughtAtMs: number;
}

/**
 * An install awaiting its reset (#210), the `installNotRestarted` alert's: out when the Agent disconnected, since then;
 * or (`doneNotReset`, #213 re-review) reported done with no reset in the next slow snapshot, since then.
 */
export interface InstallAwaitingRestart {
  id: string;
  sinceMs: number;
  doneNotReset?: boolean;
}

/** What the dashboard shows of augmentations (#210). */
export interface AugmentationsView {
  enabled: boolean;
  /** No medium and slow snapshots from the connected Agent yet. */
  waiting: boolean;
  /** The donations reported done that the faction state never showed (#225), until a reset. */
  donationsFailed?: DonationFailed[];
  /** The install chosen: buying for it, or installing. */
  committed: boolean;
  /** What the brain asks for now, in words, or null. */
  asking: string | null;
  /** Not committed: the set the money covers now, in buy order, and its money. */
  set: { augmentation: string; price: number }[];
  setCost: number;
  /** Not committed: where the count rule stands (#222), or null. */
  progress: AugmentationProgress | null;
  /** The donations (#225): not committed, those the counts plan; committed, the note's. */
  donations: Donation[];
  /** Why nothing is asked for, or no install chosen, or null. */
  waitingFor: string | null;
  notQueued: NotQueued[];
  /**
   * The money held back from cloud servers (A2) for augmentations: Infinity while committed; in the countdown, what
   * the counted purchases cost (#222); before it, that only for an install the rule would choose with
   * `AUGMENTATION_RESERVE_LOOKAHEAD_MS` more income, else 0; Daedalus's $100b while it holds for its invitation (#215).
   */
  reserve: number;
}

/** What the controller hands the rule each update. */
export interface AugmentationInputs {
  mediumData: MediumSnapshotData | null;
  /**
   * The game's time when the medium snapshot was taken (its `gameTimeMs`), or null: purchases reported done in a fast
   * snapshot taken after it are taken off its money (#213 re-review).
   */
  mediumGameTimeMs: number | null;
  slowData: SlowSnapshotData | null;
  /** The game's time of the latest slow snapshot (its `gameTimeMs`), or null. */
  slowGameTimeMs: number | null;
  /** The intents the connected Agent's latest fast snapshot reports done, and the game's time it was taken, or null. */
  doneIds: ReadonlySet<string>;
  fastGameTimeMs: number | null;
  /** The latest time the controller has seen (a channel event's), for the events. */
  nowMs: number | null;
  enabled: boolean;
  homeRamEnabled: boolean;
  /**
   * The BitNode's destroy wanted once The Red Pill is installed (#215 review): the World Daemon's switch on, with
   * nothing playable left in the order to gain too, where the destroy is a replay (#311, #321). Then no ordinary
   * install is chosen: it would reset the hacking level w0r1d_d43m0n needs.
   */
  destroyWanted: boolean;
  /**
   * Who works for a faction while an install is held for Daedalus's count (#243): the owner's work, and A5's switch.
   * Absent, A5 does (its switch on, no owner's work).
   */
  holdWork?: HoldWork;
  /**
   * The gang's faction (#334, G5: the gang rule's `gangShopOf`), its reputation as the slow snapshot reports it, or
   * null (absent) with no gang. `slowData` leaves it out of the joined factions; its shop joins the others here.
   */
  gangShop?: JoinedFaction | null;
  /**
   * In BN2 with no gang reading yet (#335's review, the gang rule's `gangUnread`): whether there's a gang, and its
   * shop, unknown. A commit for The Red Pill isn't called off for want of a seller meanwhile. Absent, read.
   */
  gangUnread?: boolean;
  /**
   * The planner's levelling choice is NeuroFlux Governor's levels and an install (#336, ./levelling.ts): with The Red
   * Pill installed and the destroy wanted, the install is chosen at once ("the hacking level") in place of the
   * destroy's hold, if the money buys a level. Absent, not.
   */
  levellingInstall?: boolean;
}

/** What the rule asks of the controller. */
export interface AugmentationAsk {
  /** A purchase (an augmentation, home's RAM, a NeuroFlux Governor level), or null. */
  intent: Intent | null;
  /** The install: the controller queues it after the owner's, through the gate. */
  install: boolean;
  /** Committed: the program purchases (lost at the install) and cloud servers stand down. */
  committed: boolean;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecordOf = (value: unknown): value is Record<string, number> =>
  typeof value === "object" && value !== null && Object.values(value).every(isFiniteNumber);
/** "BitWire", or "NeuroFlux Governor (level 3)". */
const levelled = (augmentation: string, level: number) =>
  augmentation === NEUROFLUX_GOVERNOR ? `${augmentation} (level ${level})` : augmentation;
const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

/**
 * What the rule reads of the player in a medium snapshot, or null: it's the Agent's word. The person is A5's
 * (`workingPersonOf`, #203), with the money.
 */
function playerOf(mediumData: MediumSnapshotData) {
  const person = workingPersonOf(mediumData);
  const player = mediumData.player as { money?: unknown } | undefined;
  if (person === null || !isFiniteNumber(player?.money)) return null;
  return { person, money: player.money };
}

/** The slow snapshot's reset info as the rule needs it, or null where it doesn't say. */
function resetInfoOf(slowData: SlowSnapshotData) {
  const info = slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  if (
    !Number.isInteger(info?.currentNode) ||
    !isFiniteNumber(info?.lastAugReset) ||
    !isRecordOf(info?.ownedAugs) ||
    !isRecordOf(info?.ownedSF)
  ) {
    return null;
  }
  return {
    currentNode: info.currentNode as number,
    lastAugReset: info.lastAugReset,
    ownedAugs: info.ownedAugs,
    ownedSF: info.ownedSF,
  };
}

/** The money earned since the install, from the slow snapshot's money sources, or null without them. */
export function earnedOf(slowData: SlowSnapshotData): number | null {
  const sources = slowData.moneySources;
  if (typeof sources !== "object" || sources === null) return null;
  let earned = 0;
  for (const source of EARNING_SOURCES) {
    const value = sources[source] ?? 0;
    if (!isFiniteNumber(value)) return null;
    earned += value;
  }
  return earned;
}

/** The commit as stored, or null; a value the brain didn't write fails, as the reset note does. */
export interface AugmentationCycle {
  lastAugReset: number;
  installing: boolean;
  /**
   * The NeuroFlux Governor copies to have queued, those queued and the levels counted when the install was chosen
   * (#222 review): home's RAM spends only money above the rest's. Absent in an earlier brain's note: none held.
   */
  neuroFluxTarget?: number;
  /** The donations the commit makes first, one a faction (#225). Absent in an earlier brain's note: none. */
  donations?: Donation[];
  /** Why the install was chosen (#225): "Daedalus donations" installs without The Red Pill. */
  reason?: InstallReason;
  /**
   * The faction whose donation is The Red Pill's (#225): first, never passed over; the money for it gone, the cycle is
   * called off.
   */
  redPill?: string;
  /**
   * Short of Daedalus's count at the commit (#238): what counts within reach then, for "Daedalus count stuck". Absent
   * when not short, or in an earlier brain's note.
   */
  countFacts?: CountFacts;
}

/**
 * At a commit while short of Daedalus's count (#238): the money left after the set (and its donations), what
 * NeuroFlux Governor's levels and home's RAM then take; and each augmentation that would add to the count left within
 * reach beyond the set (core's `countablesWithinReach`). The World Daemon judges an install that added none to the
 * count on them: one whose money is no more than what was left, A6's set should have taken (#238 review).
 */
export interface CountFacts {
  moneyAfterSet: number;
  within: CountableWithinReach[];
}

const isCountFacts = (value: unknown): value is CountFacts => {
  const { moneyAfterSet, within } = (value ?? {}) as Partial<CountFacts>;
  return (
    isFiniteNumber(moneyAfterSet) &&
    Array.isArray(within) &&
    within.every(
      (each) =>
        typeof each?.augmentation === "string" && typeof each.faction === "string" && isFiniteNumber(each.money),
    )
  );
};

const isDonation = (value: unknown): value is Donation => {
  const { faction, reputation, amount } = (value ?? {}) as Partial<Donation>;
  return typeof faction === "string" && isFiniteNumber(reputation) && Number.isSafeInteger(amount);
};

export function readAugmentationCycle(store: TelemetryStore): AugmentationCycle | null {
  const value = store.getSetting(AUGMENTATION_CYCLE_SETTING);
  if (value === null) return null;
  type Note = {
    lastAugReset?: unknown;
    installing?: unknown;
    neuroFluxTarget?: unknown;
    donations?: unknown;
    reason?: unknown;
    redPill?: unknown;
    countFacts?: unknown;
  };
  let note: Note | null;
  try {
    note = JSON.parse(value) as Note | null;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't JSON`);
  }
  const installing = note?.installing ?? false;
  const target = note?.neuroFluxTarget;
  const donations = note?.donations;
  const reason = note?.reason;
  const redPill = note?.redPill;
  const countFacts = note?.countFacts;
  if (
    !isFiniteNumber(note?.lastAugReset) ||
    typeof installing !== "boolean" ||
    (target !== undefined && !(Number.isInteger(target) && (target as number) >= 0)) ||
    (donations !== undefined && !(Array.isArray(donations) && donations.every(isDonation))) ||
    (reason !== undefined && typeof reason !== "string") ||
    (redPill !== undefined && typeof redPill !== "string") ||
    (countFacts !== undefined && !isCountFacts(countFacts))
  ) {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't a note the brain wrote`);
  }
  return {
    lastAugReset: note.lastAugReset,
    installing,
    ...(target === undefined ? {} : { neuroFluxTarget: target as number }),
    ...(donations === undefined ? {} : { donations: donations as Donation[] }),
    ...(reason === undefined ? {} : { reason: reason as InstallReason }),
    ...(redPill === undefined ? {} : { redPill: redPill as string }),
    ...(countFacts === undefined ? {} : { countFacts: countFacts as CountFacts }),
  };
}

function writeAugmentationCycle(store: TelemetryStore, note: AugmentationCycle | null): void {
  if (note === null) store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
  else store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify(note));
}

/** "45 s", "12 min", "3.4 h", or "never". */
export function formatEta(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "never";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** The store's setting with the cycle's hold for The Red Pill at the gang's faction (#335's review), as JSON. */
export const AUGMENTATION_GANG_RED_PILL_HOLD_SETTING = "augmentations.gangRedPillHold";

/** The cycle's hold at the gang's faction: the cycle (`lastAugReset`) and the online time it first started at. */
export interface GangRedPillHold {
  lastAugReset: number;
  sinceOnlineMs: number;
}

/** The hold as stored, or null for none; a value the brain didn't write fails, as the count hold's does. */
export function readGangRedPillHold(store: TelemetryStore): GangRedPillHold | null {
  const value = store.getSetting(AUGMENTATION_GANG_RED_PILL_HOLD_SETTING);
  if (value === null) return null;
  let hold: Partial<Record<keyof GangRedPillHold, unknown>> | null;
  try {
    hold = JSON.parse(value) as typeof hold;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_GANG_RED_PILL_HOLD_SETTING} isn't JSON`);
  }
  const { lastAugReset, sinceOnlineMs } = hold ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(sinceOnlineMs) || sinceOnlineMs < 0) {
    throw new Error(`the store's ${AUGMENTATION_GANG_RED_PILL_HOLD_SETTING} isn't a hold the brain wrote`);
  }
  return { lastAugReset, sinceOnlineMs };
}

function writeGangRedPillHold(store: TelemetryStore, hold: GangRedPillHold): void {
  store.setSetting(AUGMENTATION_GANG_RED_PILL_HOLD_SETTING, JSON.stringify(hold));
}

/** A countdown's time in seconds, rounded (#222): "90 s", "83 s". */
function countdownSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** The counts and bars, as the progress, the events and the report give them. */
type CountFigures = Pick<AugmentationProgress, "affordable" | "affordableWithNeuroFlux" | "bar" | "barWithNeuroFlux">;

/** "5 of 8 new augmentations affordable (7 of 12 with NeuroFlux)", and (#225) "; 2 of them by donation". */
function describeCounts({
  affordable,
  affordableWithNeuroFlux,
  bar,
  barWithNeuroFlux,
  byDonation,
}: CountFigures & { byDonation?: unknown }): string {
  const donated = isFiniteNumber(byDonation) && byDonation > 0 ? `; ${byDonation} of them by donation` : "";
  return (
    `${affordable} of ${bar} new augmentations affordable (${affordableWithNeuroFlux} of ${barWithNeuroFlux} with ` +
    `NeuroFlux${donated})`
  );
}

/**
 * Where the count rule stands, in words (#222), for the log, the dashboard and the report: "5 of 8 new augmentations
 * affordable (7 of 12 with NeuroFlux), 1.2 h online this cycle; the bar falls to 7 in 48 min".
 */
export function describeProgress(progress: CountFigures & Partial<AugmentationProgress>): string {
  const { bar, barWithNeuroFlux, onlineMs, barFallsInMs, barWithNeuroFluxFallsInMs } = progress;
  const online = isFiniteNumber(onlineMs) ? `, ${formatEta(onlineMs)} online this cycle` : "";
  const falls = isFiniteNumber(barFallsInMs)
    ? `; the bar falls to ${bar - 1} in ${formatEta(barFallsInMs)}`
    : isFiniteNumber(barWithNeuroFluxFallsInMs)
      ? `; the bar is 1, and with NeuroFlux falls to ${barWithNeuroFlux - 1} in ${formatEta(barWithNeuroFluxFallsInMs)}`
      : barFallsInMs === null && barWithNeuroFluxFallsInMs === null
        ? "; both bars are 1"
        : "";
  const short = progress.short;
  const forCount =
    short === undefined || short === null
      ? ""
      : `; short of Daedalus's count (${short.installed} of ${short.required} augmentations installed): any ` +
        "augmentation counts";
  return `${describeCounts(progress)}${online}${falls}${forCount}`;
}

/** Why the install was chosen, in words, for the log and the report; another reason, as it is. */
export function describeReason(reason: InstallReason | string, figures: Partial<CountFigures>): string {
  const counted =
    isFiniteNumber(figures.affordable) &&
    isFiniteNumber(figures.affordableWithNeuroFlux) &&
    isFiniteNumber(figures.bar) &&
    isFiniteNumber(figures.barWithNeuroFlux)
      ? describeCounts(figures as CountFigures)
      : "the counts not stored";
  if (reason === "count reached") return `the count reached: ${counted}`;
  if (reason === "quick install") {
    return `a quick install, within ${formatEta(QUICK_INSTALL_WITHIN_MS)} of the last install: ${counted}`;
  }
  if (reason === "nothing left") return "nothing else worth installing at the joined factions";
  if (reason === "The Red Pill") return "The Red Pill reached: it links w0r1d_d43m0n once installed";
  if (reason === "the hacking level") {
    return (
      `the hacking level: the planner's shortest way to w0r1d_d43m0n's is NeuroFlux Governor's levels, then an ` +
      `install (#336; ${counted})`
    );
  }
  if (reason === "Daedalus donations") {
    return (
      `Daedalus donations: its reputation this cycle unlocks its donations at the next install, so ${THE_RED_PILL}'s ` +
      `reputation is bought, not earned (${counted})`
    );
  }
  return reason;
}

/** "$6,750,010,000 to NiteSec (for 18,750 reputation)", for the log and the report. */
export function describeDonation({ faction, amount, reputation }: Donation): string {
  return `${formatMoney(amount)} to ${faction} (for ${Math.round(reputation).toLocaleString("en-US")} reputation)`;
}

/** The bars' clock (#222): the game's time online since the install `lastAugReset`, and the last slow snapshot's. */
export interface OnlineClock {
  lastAugReset: number;
  onlineMs: number;
  lastGameTimeMs: number;
}

/**
 * The bars' clock after a slow snapshot taken at `gameTimeMs` in the cycle `lastAugReset` (#222): it adds the time
 * since the last slow snapshot of the same cycle, if no more than `AUGMENTATION_SLOW_GAP_MS` (the game closed, or
 * the Agent or the brain away, isn't online time). Another `lastAugReset` starts it at 0: a save first seen mid-cycle
 * starts when the brain first sees it, the conservative side (the bars start at 8 and 12). Never the game's time since
 * the install, which counts the time the game was closed. Also the gap, or the clock set back (`stepMs` 0 or less),
 * that it left out, or null. The rule and the run report each fold their slow snapshots through this.
 */
export function advanceOnlineClock(
  clock: OnlineClock | null,
  gameTimeMs: number,
  lastAugReset: number,
): { clock: OnlineClock; leftOutMs: number | null } {
  if (clock === null || clock.lastAugReset !== lastAugReset) {
    return { clock: { lastAugReset, onlineMs: 0, lastGameTimeMs: gameTimeMs }, leftOutMs: null };
  }
  const stepMs = gameTimeMs - clock.lastGameTimeMs;
  if (stepMs === 0) return { clock, leftOutMs: null };
  const online = stepMs > 0 && stepMs <= AUGMENTATION_SLOW_GAP_MS;
  return {
    clock: { lastAugReset, onlineMs: clock.onlineMs + (online ? stepMs : 0), lastGameTimeMs: gameTimeMs },
    leftOutMs: online ? null : stepMs,
  };
}

/** The bars' clock as stored, or null; a value the brain didn't write fails, as the commit's note does. */
export function readOnlineClock(store: TelemetryStore): OnlineClock | null {
  const value = store.getSetting(AUGMENTATION_ONLINE_SETTING);
  if (value === null) return null;
  let clock: Partial<Record<keyof OnlineClock, unknown>> | null;
  try {
    clock = JSON.parse(value) as Partial<Record<keyof OnlineClock, unknown>> | null;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_ONLINE_SETTING} isn't JSON`);
  }
  const { lastAugReset, onlineMs, lastGameTimeMs } = clock ?? {};
  if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(onlineMs) || onlineMs < 0 || !isFiniteNumber(lastGameTimeMs)) {
    throw new Error(`the store's ${AUGMENTATION_ONLINE_SETTING} isn't a clock the brain wrote`);
  }
  return { lastAugReset, onlineMs, lastGameTimeMs };
}

/** The hold's window as stored (#243), or null; a value the brain didn't write fails, as the clock does. */
export function readCountHold(
  store: TelemetryStore,
): { lastAugReset: number; sinceOnlineMs: number; ended?: boolean } | null {
  const value = store.getSetting(AUGMENTATION_COUNT_HOLD_SETTING);
  if (value === null) return null;
  let hold: { lastAugReset?: unknown; sinceOnlineMs?: unknown; ended?: unknown } | null;
  try {
    hold = JSON.parse(value) as typeof hold;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_COUNT_HOLD_SETTING} isn't JSON`);
  }
  const { lastAugReset, sinceOnlineMs, ended } = hold ?? {};
  if (
    !isFiniteNumber(lastAugReset) ||
    !isFiniteNumber(sinceOnlineMs) ||
    sinceOnlineMs < 0 ||
    (ended !== undefined && typeof ended !== "boolean")
  ) {
    throw new Error(`the store's ${AUGMENTATION_COUNT_HOLD_SETTING} isn't a hold the brain wrote`);
  }
  return { lastAugReset, sinceOnlineMs, ...(ended === true ? { ended: true } : {}) };
}

/** Whether someone works for `faction` under a hold (#243 review): the owner's faction work there, or A5's. */
function worksFor(work: HoldWork, faction: string): boolean {
  if (work.owners !== null) return work.owners.kind === "faction" && work.owners.faction === faction;
  return work.brainWorks;
}

/** "Daedalus's count reachable this cycle, The Black Hand in ~17 min (by work at The Black Hand, $7,168,…; …)". */
export function describeCountHold(hold: CountHoldView, count: Pick<DaedalusCount, "required">): string {
  const route =
    hold.way === "work"
      ? `by work at ${hold.faction}`
      : hold.way === "donation"
        ? `by a donation to ${hold.faction}`
        : `at ${hold.faction}, its reputation reached`;
  return (
    `Daedalus's count reachable this cycle, ${hold.augmentation} in ~${formatEta(hold.etaMs)} (${route}, ` +
    `${formatMoney(hold.money)}; ${count.required - 1} of ${count.required} after this install; held ` +
    `${formatEta(DAEDALUS_COUNT_HOLD_MS)} at most, ${formatEta(hold.leftMs)} left)`
  );
}

/** The intent buying `augmentation` from `faction` (`level` 1 but for NeuroFlux Governor). */
export function purchaseIntent(faction: string, augmentation: string, level: number): Intent {
  const args = { faction, augmentation, level };
  return { id: intentId("purchaseAugmentation", args), action: "purchaseAugmentation", args };
}

/** The Red Pill's way, before an ordinary install is chosen (#215): `AugmentationRule`'s `#endgame`. */
type HoldReason = "destroy" | "redPillNotQueued" | "redPill" | "daedalus" | "daedalusDonations";
type Endgame =
  | { kind: "redPill"; donation: Donation | null }
  | { kind: "daedalusDonations" }
  | { kind: "hold"; why: HoldReason; waitingFor: string; reserve: number }
  | { kind: "none" };

/**
 * The note's donations with `extra` (The Red Pill's, #225) first, so the counted ones never spend its money: one a
 * faction, for the most reputation.
 */
function withDonation(donations: readonly Donation[], extra: Donation | null): Donation[] {
  if (extra === null) return [...donations];
  const same = donations.find((each) => each.faction === extra.faction);
  const first = same !== undefined && same.reputation > extra.reputation ? same : extra;
  return [first, ...donations.filter((each) => each.faction !== extra.faction)];
}

/** The augmentation rule (#210), as the controller runs it. */
export class AugmentationRule {
  readonly #store: TelemetryStore;
  readonly #log: (line: string) => void;
  readonly #emit: (event: AugmentationEvent) => void;
  /** The income's samples: the game's time, the money earned since the install, and that install. */
  #incomeSamples: { gameTimeMs: number; earned: number; lastAugReset: number }[] = [];
  /**
   * The bars' clock (#222), as stored. There's no NS call for the time online since an install
   * (`getTimeSinceLastAug` went in 3.0), so it's the time the brain saw online.
   */
  #onlineClock: OnlineClock | null;
  /**
   * The countdown under way (#222), in the game's time: its cycle, its end, its length (90 s, or 30 s quick), the
   * extensions so far, and the count with NeuroFlux last seen (a rise extends it).
   */
  #countdown: {
    lastAugReset: number;
    endsAtGameMs: number;
    lengthMs: number;
    quick: boolean;
    extensions: number;
    count: number;
    /** The game's time it last saw: an earlier one is the clock set back. */
    seenAtGameMs: number;
  } | null = null;
  /** The progress last recorded: its cycle, bars, reason, countdown and hold, its counts, and when. */
  #progress: { structural: string; counts: string; atMs: number } | null = null;
  /** The slow snapshot's game time last sampled, so each is taken once. */
  #sampledGameTimeMs: number | null = null;
  /** The game's last `lastAugReset` seen: a new one is a reset, which ends a cycle's purchases. */
  #lastAugReset: number | null = null;
  /** The purchase asked for now, with its price then. */
  #asked: Asked | null = null;
  /** The queue when last worked out: the faction state's, with the purchases reported done since. */
  #queue: string[] = [];
  /** The purchases recorded as done this game, by intent id, so each is recorded once. */
  #recorded = new Set<string>();
  #bought: Bought[] = [];
  #notQueued: NotQueued[] = [];
  /** Donations reported done, not yet shown by the faction state (#225); those it never showed, for the alert. */
  #donated: Donated[] = [];
  #donationsFailed: DonationFailed[] = [];
  /** The note's donations passed over this cycle, the money short of them then (#225): bought without. */
  #donationsSkipped = new Set<string>();
  /**
   * The money of each purchase recorded done, and the game's time of the fast snapshot reporting it (#213 review and
   * re-review): until a medium snapshot taken after that, its money is taken off the medium snapshot's, read before it.
   * The Agent's round takes its snapshots before its intents, so a purchase is in every medium snapshot taken after the
   * fast one reporting it. One reported done some rounds after it was made (a page effector's) can be taken off a
   * medium snapshot that shows it already: less money, the safe side, until the next one.
   */
  #spent: { gameTimeMs: number; price: number }[] = [];
  /** The install asked for: nothing more is bought. Kept in the commit's note too. */
  #installing = false;
  /** Why no install is chosen on The Red Pill's way (#215), as last logged: logged as it starts. */
  #holding: HoldReason | null = null;
  /** The last decision held installs for The Red Pill at the gang's faction (#335's review): the World Daemon's stall. */
  #redPillHeldAtGang = false;
  /**
   * NeuroFlux Governor's levels the money buys (#336), donations included (decision 53), as the last decision held
   * every install for the destroy, or null: the planner's install candidate.
   */
  #neuroFluxOffer: number | null = null;
  /** The install held for Daedalus's count (#243), as last decided, or null: logged as it starts and ends. */
  #countHeld: CountHoldView | null = null;
  /** This update logged the hold's end (#243 review): `update` logs one on any other path. */
  #countHoldEndLogged = false;
  /** A decision made since the brain started: a hold's window open at the first is a restarted brain's hold. */
  #decidedOnce = false;
  /** Daedalus's $100b, held back for its invitation (#215), or 0: home RAM keeps it too (#215 review). */
  #daedalusHold = 0;
  /** The Red Pill's donation's money, held back (#225 review), or 0. */
  #redPillHold = 0;
  /** The install reported done, and the latest slow snapshot's game time then: the next one should show the reset. */
  #installDone: { slowGameTimeMs: number | null } | null = null;
  /**
   * An install reported done that the next slow snapshot didn't show reset (#213 re-review), until a reset: the
   * `installNotRestarted` alert's. No other install is chosen meanwhile, as the faction state's queue isn't the game's.
   */
  #installNotReset: { atMs: number; queued: string[] } | null = null;
  #view: Omit<AugmentationsView, "enabled" | "notQueued"> = {
    waiting: true,
    committed: false,
    asking: null,
    set: [],
    setCost: 0,
    progress: null,
    donations: [],
    waitingFor: null,
    reserve: 0,
  };
  #enabled = true;

  constructor({
    store,
    log = () => {},
    emit = () => {},
  }: {
    store: TelemetryStore;
    log?: (line: string) => void;
    emit?: (event: AugmentationEvent) => void;
  }) {
    this.#store = store;
    this.#log = log;
    this.#emit = emit;
    readAugmentationCycle(store);
    readCountHold(store);
    this.#onlineClock = readOnlineClock(store);
  }

  /** Whether the purchase asked for is among `doneIds`, not yet recorded: the controller updates at once then. */
  askedDone(doneIds: ReadonlySet<string>): boolean {
    const asked = this.#asked;
    if (asked !== null && doneIds.has(asked.intent.id) && !this.#recorded.has(asked.intent.id)) return true;
    // The install reported done (nothing to install, says the game): watched for the reset from now.
    return this.#installDone === null && doneIds.has(AUGMENTATION_INSTALL_INTENT.id) && this.installAskedFor();
  }

  /**
   * The install asked for: here, or in the commit's note (a restarted brain's, before its first decision). The World
   * Daemon's too (#238 review): an install while short with no `countFacts` is A6's, and stuck.
   */
  installAskedFor(): boolean {
    return this.#installing || readAugmentationCycle(this.#store)?.installing === true;
  }

  /**
   * The money held for Daedalus's invitation (#215): $100b while it holds for it, else 0 (each update starts at 0, so
   * the switch off is 0 too). Home RAM keeps it too.
   */
  daedalusHold(): number {
    return this.#daedalusHold;
  }

  /**
   * The money held for The Red Pill's donation (#225), while the money is short of it with a seller's donations
   * unlocked, else 0: from cloud servers (`reserve`), home RAM and programs alike.
   */
  redPillHold(): number {
    return this.#redPillHold;
  }

  /**
   * The money held in the install's countdown (#222): what the counted purchases cost, from cloud servers (`reserve`)
   * and home RAM alike, as the legacy scripts' reserve.txt holds it from every purchase (`autopilot.js:983`); while an
   * install is held for Daedalus's count (#243), the set's and the one it waits for; else 0.
   */
  countdownReserve(): number {
    return this.#enabled && (this.#countdown !== null || this.#countHeld !== null) ? this.#view.reserve : 0;
  }

  /**
   * The install counting down (#222), not held for Daedalus's count (#243 review): what the travel for invitations
   * stands down for (`#installUnderWay`), as the install puts the player back in Sector-12; a hold may end in none.
   */
  countdownUnderWay(): boolean {
    return this.#enabled && this.#countdown !== null;
  }

  /**
   * The faction and augmentation an install held for Daedalus's count waits on by work (#243 review), for A5 to work
   * for (the owner's work and A5's switch still win); null when none is held, or the hold waits on a donation or money.
   */
  countHoldTarget(): { faction: string; augmentation: string } | null {
    const held = this.#countHeld;
    return held?.way === "work" ? { faction: held.faction, augmentation: held.augmentation } : null;
  }

  /**
   * What counts within reach at the commit, short of Daedalus's count (#238), from the commit's note until the game
   * resets; null without a commit, or one not short. The World Daemon's facts for "Daedalus count stuck".
   */
  countFacts(): CountFacts | null {
    return readAugmentationCycle(this.#store)?.countFacts ?? null;
  }

  /** The last decision held installs for The Red Pill at the gang's faction (#335's review): its stall's to watch. */
  redPillHeldAtGang(): boolean {
    return this.#redPillHeldAtGang;
  }

  /**
   * NeuroFlux Governor's levels the money would buy at an install now (#336, core's `affordableCounts`: each level's
   * price, 1.14 times the last's and 1.9 times for each purchase queued before it, and its reputation, by donation where
   * a seller takes them), while The Red Pill is installed and every install held for the destroy; null otherwise.
   */
  neuroFluxOffer(): number | null {
    return this.#neuroFluxOffer;
  }

  /** An install reported done that the next slow snapshot didn't show reset, until a reset (#213 re-review). */
  installNotReset(): { atMs: number; queued: string[] } | null {
    return this.#installNotReset === null ? null : { ...this.#installNotReset };
  }

  view(): AugmentationsView {
    return {
      ...this.#view,
      enabled: this.#enabled,
      notQueued: [...this.#notQueued],
      donationsFailed: [...this.#donationsFailed],
    };
  }

  /** The money held back from cloud servers for augmentations (#210, for A2): Infinity while committed. */
  reserve(): number {
    return this.#enabled ? this.#view.reserve : 0;
  }

  /** The queue as last worked out: the faction state's, with the purchases reported done since. */
  queued(): string[] {
    return [...this.#queue];
  }

  /** The purchases reported done that never showed queued (#210): the `augmentationNotQueued` alert's. */
  notQueued(): NotQueued[] {
    return [...this.#notQueued];
  }

  /** The donations reported done that the faction state never showed (#225): the alert's, until a reset. */
  donationsFailed(): DonationFailed[] {
    return [...this.#donationsFailed];
  }

  update(inputs: AugmentationInputs): AugmentationAsk {
    // Held again only by this update's decision (#243); a hold's end is logged whatever the path (#243 review).
    const countHeldBefore = this.#countHeld;
    this.#countHeld = null;
    this.#countHoldEndLogged = false;
    const ask = this.#updateOnce(inputs, countHeldBefore);
    if (countHeldBefore !== null && this.#countHeld === null && !this.#countHoldEndLogged) {
      const endReason = !inputs.enabled
        ? "the Augmentations switch turned off"
        : `waiting for ${this.#view.waitingFor ?? "the Agent's medium and slow snapshots"}`;
      this.#log(`augmentations: the hold for Daedalus's count is over: ${endReason}`);
    }
    return ask;
  }

  #updateOnce(inputs: AugmentationInputs, countHeldBefore: CountHoldView | null): AugmentationAsk {
    const { mediumData, mediumGameTimeMs, slowData, slowGameTimeMs, doneIds, fastGameTimeMs, nowMs } = inputs;
    const { enabled, homeRamEnabled, destroyWanted } = inputs;
    const holdWork = inputs.holdWork ?? { owners: null, brainWorks: true };
    this.#daedalusHold = 0;
    this.#redPillHeldAtGang = false;
    this.#neuroFluxOffer = null;
    this.#redPillHold = 0;
    this.#enabled = enabled;
    const atMs = nowMs ?? 0;
    // Nothing asked for now; the last purchase asked for is kept, so its done is recorded when it's reported (after a
    // reconnect, say).
    const askNothing = (waitingFor: string | null, view: Partial<AugmentationsView> = {}): AugmentationAsk => {
      const committed = readAugmentationCycle(this.#store) !== null;
      const reserve = committed ? Number.POSITIVE_INFINITY : 0;
      this.#view = { ...this.#view, asking: null, waitingFor, committed, reserve, ...view };
      return { intent: null, install: false, committed };
    };
    if (slowData !== null) this.#sample(slowData, slowGameTimeMs, atMs);
    this.#recordDone(doneIds, fastGameTimeMs, atMs);
    this.#watchInstallDone(doneIds, slowGameTimeMs, atMs);
    // Spending a medium snapshot taken after it already shows.
    if (mediumGameTimeMs !== null) this.#spent = this.#spent.filter((each) => each.gameTimeMs > mediumGameTimeMs);
    if (!enabled) {
      if (readAugmentationCycle(this.#store) !== null) this.#callOff(atMs, "the Augmentations switch turned off");
      this.#cancelCountdown("the Augmentations switch turned off");
      return askNothing(null, {
        waiting: false,
        committed: false,
        reserve: 0,
        progress: null,
        set: [],
        setCost: 0,
        donations: [],
      });
    }
    if (mediumData === null || slowData === null) return askNothing(null, { waiting: true });
    const resetInfo = resetInfoOf(slowData);
    if (resetInfo === null) return askNothing("the reset info in the Agent's slow snapshot", { waiting: false });
    const player = playerOf(mediumData);
    if (player === null) {
      return askNothing("the player's skills, money and multipliers in the Agent's medium snapshot", {
        waiting: false,
      });
    }
    const state: FactionState | null = factionReadingOf(slowData)?.state ?? null;
    if (state === null) {
      const problem = factionReadingOf(slowData)?.problem;
      return askNothing(`the faction state in the Agent's slow snapshot${problem ? ` (unread: ${problem})` : ""}`, {
        waiting: false,
      });
    }
    // What core doesn't know (an augmentation, a BitNode: another game version) throws: nothing, saying so.
    try {
      return this.#decide({
        state,
        resetInfo,
        player,
        slowData,
        mediumData,
        slowGameTimeMs,
        // The game's latest time seen, the countdown's clock (#222): every tier's is the game's `Date.now()`.
        gameNowMs: Math.max(
          ...[slowGameTimeMs, mediumGameTimeMs, fastGameTimeMs].filter((time): time is number => time !== null),
        ),
        atMs,
        homeRamEnabled,
        destroyWanted,
        countHeldBefore,
        holdWork,
        gangShop: inputs.gangShop ?? null,
        gangUnread: inputs.gangUnread ?? false,
        levellingInstall: inputs.levellingInstall ?? false,
      });
    } catch (error) {
      return askNothing(`the snapshots as core knows the game (${(error as Error).message})`, { waiting: false });
    }
  }

  /** A slow snapshot: a reset; and once per snapshot, the bars' clock, the income's sample and the faction state's read. */
  #sample(slowData: SlowSnapshotData, gameTimeMs: number | null, atMs: number): void {
    const lastAugReset = slowData.resetInfo?.lastAugReset;
    if (isFiniteNumber(lastAugReset) && this.#lastAugReset !== null && lastAugReset !== this.#lastAugReset) {
      // A new game: its purchases start afresh.
      this.#bought = [];
      this.#notQueued = [];
      this.#donated = [];
      this.#donationsFailed = [];
      this.#donationsSkipped.clear();
      this.#recorded.clear();
      this.#spent = [];
      this.#installing = false;
      this.#installNotReset = null;
    }
    if (isFiniteNumber(lastAugReset)) {
      this.#lastAugReset = lastAugReset;
      // A commit from before a reset (seen now, or while the brain was down) is over.
      const cycle = readAugmentationCycle(this.#store);
      if (cycle !== null && cycle.lastAugReset !== lastAugReset) {
        writeAugmentationCycle(this.#store, null);
        this.#installing = false;
        this.#log("augmentations: the game has reset (installed): the install cycle is over");
      }
      if (this.#countdown !== null && this.#countdown.lastAugReset !== lastAugReset) {
        this.#cancelCountdown("the game has reset");
      }
    }
    // A reset is judged on every slow snapshot; the clock, the income and the reads once per snapshot (by its time).
    if (gameTimeMs === null || gameTimeMs === this.#sampledGameTimeMs) return;
    this.#sampledGameTimeMs = gameTimeMs;
    let gap = false;
    if (isFiniteNumber(lastAugReset)) {
      const { clock, leftOutMs } = advanceOnlineClock(this.#onlineClock, gameTimeMs, lastAugReset);
      if (clock !== this.#onlineClock) {
        this.#onlineClock = clock;
        this.#store.setSetting(AUGMENTATION_ONLINE_SETTING, JSON.stringify(clock));
      }
      if (leftOutMs !== null) {
        gap = true;
        this.#log(
          `augmentations: ${leftOutMs > 0 ? `a gap of ${formatEta(leftOutMs)}` : "the game's clock set back"} between ` +
            "slow snapshots: left out of the time online this cycle, and the income is measured afresh",
        );
      }
    }
    const earned = earnedOf(slowData);
    if (earned === null || !isFiniteNumber(lastAugReset) || gap) {
      this.#incomeSamples = [];
    } else {
      this.#incomeSamples = this.#incomeSamples.filter((sample) => sample.lastAugReset === lastAugReset);
    }
    if (earned !== null && isFiniteNumber(lastAugReset)) {
      this.#incomeSamples.push({ gameTimeMs, earned, lastAugReset });
      // The newest sample a window old or older, and those after it.
      const old = this.#incomeSamples.findLastIndex(
        (sample) => gameTimeMs - sample.gameTimeMs >= AUGMENTATION_INCOME_WINDOW_MS,
      );
      if (old > 0) this.#incomeSamples = this.#incomeSamples.slice(old);
    }
    this.#confirmQueued(slowData, atMs);
  }

  /**
   * The money earned a second over the window, or null until the window is a window long with no gap: for the reserve's
   * lookahead alone (#222). The samples are the game's own count since the install, so they're kept across the Agent's
   * reconnects (#213 review) but for a gap: a reset (another `lastAugReset`) starts them again.
   */
  #income(): number | null {
    const first = this.#incomeSamples[0];
    const last = this.#incomeSamples.at(-1);
    if (first === undefined || last === undefined) return null;
    const spanMs = last.gameTimeMs - first.gameTimeMs;
    if (spanMs < AUGMENTATION_INCOME_WINDOW_MS) return null;
    return (Math.max(0, last.earned - first.earned) / spanMs) * 1000;
  }

  /**
   * The install reported done (#213 re-review): the game had nothing to install, or its reset is under way. A slow
   * snapshot since that shows no reset (`#sample` ends the cycle on one, first) calls the cycle off, stored and
   * alerted.
   */
  #watchInstallDone(doneIds: ReadonlySet<string>, slowGameTimeMs: number | null, atMs: number): void {
    if (!this.installAskedFor()) {
      this.#installDone = null;
      return;
    }
    if (this.#installDone === null) {
      if (!doneIds.has(AUGMENTATION_INSTALL_INTENT.id)) return;
      this.#installDone = { slowGameTimeMs };
      this.#log("augmentations: the install reported done: the next slow snapshot should show the reset");
      return;
    }
    if (slowGameTimeMs === null || slowGameTimeMs === this.#installDone.slowGameTimeMs) return;
    const queued = [...this.#queue];
    this.#installDone = null;
    this.#installNotReset = { atMs, queued };
    this.#emit({ type: AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND, atMs, queued });
    this.#log(
      `augmentations: INSTALL REPORTED DONE BUT THE GAME DIDN'T RESET: the faction state's queue ` +
        `(${queued.join(", ") || "empty"}) isn't the game's; no install is chosen again until a reset`,
    );
    this.#callOff(atMs, "the install was reported done but the game didn't reset");
  }

  /**
   * A faction state read (not skipped, not carried over): each purchase it shows queued is confirmed; one it misses on
   * its `NOT_QUEUED_AFTER_READS`th read is `augmentationNotQueued`.
   */
  #confirmQueued(slowData: SlowSnapshotData, atMs: number): void {
    const reading = factionReadingOf(slowData);
    if (reading === null || reading.state === null) return;
    const kind = factionReadingKind(reading);
    if (kind !== "read" && kind !== "readPageNotRestored") return;
    this.#confirmDonated(reading.state, atMs);
    const queue = reading.state.queuedAugmentations;
    const installed = slowData.resetInfo?.ownedAugs?.[NEUROFLUX_GOVERNOR] ?? 0;
    const shown = (bought: Bought) =>
      bought.augmentation === NEUROFLUX_GOVERNOR
        ? installed + queue.filter((name) => name === NEUROFLUX_GOVERNOR).length >= bought.level
        : queue.includes(bought.augmentation);
    const left: Bought[] = [];
    for (const bought of this.#bought) {
      if (shown(bought)) continue;
      bought.reads += 1;
      if (bought.reads < NOT_QUEUED_AFTER_READS) {
        left.push(bought);
        continue;
      }
      const notQueued = { augmentation: bought.augmentation, level: bought.level, boughtAtMs: bought.atMs };
      this.#notQueued.push(notQueued);
      this.#emit({ type: AUGMENTATION_NOT_QUEUED_EVENT_KIND, atMs, ...notQueued });
      this.#log(
        `augmentations: ${levelled(bought.augmentation, bought.level)} NOT QUEUED: the Agent reported it bought, ` +
          `and ${NOT_QUEUED_AFTER_READS} faction state reads since don't show it`,
      );
    }
    this.#bought = left;
  }

  /**
   * The donations reported done (#225), at a faction state read: each whose faction shows its reputation is an
   * `augmentationDonated` event; one the read misses on its `NOT_QUEUED_AFTER_READS`th is `augmentationDonationFailed`,
   * alerted, and the cycle called off (what it was for won't be within reach).
   */
  #confirmDonated(state: FactionState, atMs: number): void {
    const left: Donated[] = [];
    for (const donated of this.#donated) {
      const shown = state.joined.find((each) => each.name === donated.faction)?.reputation ?? null;
      if (shown !== null && shown >= donated.reputation) {
        const { faction, amount, reputation, before } = donated;
        this.#emit({ type: AUGMENTATION_DONATED_EVENT_KIND, atMs, faction, amount, reputation, before, after: shown });
        this.#log(
          `augmentations: donated ${describeDonation(donated)}: its reputation ${Math.round(before).toLocaleString("en-US")} ` +
            `→ ${Math.round(shown).toLocaleString("en-US")}`,
        );
        continue;
      }
      donated.reads += 1;
      donated.shown = shown;
      if (donated.reads < NOT_QUEUED_AFTER_READS) {
        left.push(donated);
        continue;
      }
      const failed = {
        faction: donated.faction,
        amount: donated.amount,
        reputation: donated.reputation,
        donatedAtMs: donated.atMs,
      };
      this.#donationsFailed.push(failed);
      this.#emit({ type: AUGMENTATION_DONATION_FAILED_EVENT_KIND, atMs, ...failed, shown });
      this.#log(
        `augmentations: DONATION FAILED: ${describeDonation(donated)} reported done, and ${NOT_QUEUED_AFTER_READS} ` +
          `faction state reads since show ${shown === null ? "no such faction" : Math.round(shown).toLocaleString("en-US")}`,
      );
      if (readAugmentationCycle(this.#store) !== null) {
        this.#callOff(atMs, `the donation to ${donated.faction} didn't show in its reputation`);
      }
    }
    this.#donated = left;
  }

  /** The purchase asked for, reported done: an event, a log line, and waiting for the queue to show it. */
  #recordDone(doneIds: ReadonlySet<string>, fastGameTimeMs: number | null, atMs: number): void {
    const asked = this.#asked;
    if (asked === null || !doneIds.has(asked.intent.id) || this.#recorded.has(asked.intent.id)) return;
    this.#recorded.add(asked.intent.id);
    // A done comes in a fast snapshot, which has its time (the controller's null is for no fast snapshot, so no done).
    this.#spent.push({ gameTimeMs: fastGameTimeMs ?? 0, price: asked.price });
    if (asked.donation !== undefined) {
      const { reputation, before } = asked.donation;
      this.#donated.push({
        faction: asked.faction,
        amount: asked.price,
        reputation,
        before,
        atMs,
        reads: 0,
        shown: null,
      });
      this.#log(
        `augmentations: ${describeDonation({ faction: asked.faction, amount: asked.price, reputation })} reported ` +
          "done: the faction state should show the reputation",
      );
      return;
    }
    if (asked.augmentation === null) {
      this.#log(`augmentations: ${asked.intent.id} done, before the install (home's RAM stays)`);
      return;
    }
    this.#bought.push({ augmentation: asked.augmentation, level: asked.level, atMs, reads: 0 });
    const queueLength = this.#queue.length + 1;
    this.#emit({
      type: AUGMENTATION_BOUGHT_EVENT_KIND,
      atMs,
      augmentation: asked.augmentation,
      faction: asked.faction,
      level: asked.level,
      price: asked.price,
      queueLength,
    });
    this.#log(
      `augmentations: bought ${levelled(asked.augmentation, asked.level)} from ${asked.faction} for ` +
        `${formatMoney(asked.price)} (queue ${queueLength})`,
    );
  }

  /** The cycle called off: the note gone, and why, stored and logged. */
  #callOff(atMs: number, reason: string): void {
    writeAugmentationCycle(this.#store, null);
    this.#installing = false;
    this.#donationsSkipped.clear();
    this.#emit({ type: AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND, atMs, reason });
    this.#log(`augmentations: the install cycle is called off: ${reason}`);
  }

  #decide({
    state,
    resetInfo,
    player,
    slowData,
    mediumData,
    slowGameTimeMs,
    gameNowMs,
    atMs,
    homeRamEnabled,
    destroyWanted,
    countHeldBefore,
    holdWork,
    gangShop,
    gangUnread,
    levellingInstall,
  }: {
    state: FactionState;
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    slowData: SlowSnapshotData;
    mediumData: MediumSnapshotData;
    slowGameTimeMs: number | null;
    gameNowMs: number;
    atMs: number;
    homeRamEnabled: boolean;
    destroyWanted: boolean;
    countHeldBefore: CountHoldView | null;
    holdWork: HoldWork;
    gangShop: JoinedFaction | null;
    gangUnread: boolean;
    levellingInstall: boolean;
  }): AugmentationAsk {
    const { currentNode, ownedAugs, ownedSF } = resetInfo;
    // What an install would install: the faction state's queue, with each purchase reported done that it doesn't show
    // yet. The queue the purchases are planned on adds each never shown (`augmentationNotQueued`, alerted): asked for
    // again, its done is already recorded, and it would be asked forever. It's never counted as installed (#213
    // re-review): a cycle whose every purchase was a false done would install nothing.
    const withUnshown = (list: string[], { augmentation, level }: { augmentation: string; level: number }) => {
      const copies = list.filter((name) => name === augmentation).length;
      const shown =
        augmentation === NEUROFLUX_GOVERNOR ? (ownedAugs[NEUROFLUX_GOVERNOR] ?? 0) + copies >= level : copies > 0;
      if (!shown) list.push(augmentation);
    };
    const installable = [...state.queuedAugmentations];
    for (const bought of this.#bought) withUnshown(installable, bought);
    const queue = [...installable];
    for (const notQueued of this.#notQueued) withUnshown(queue, notQueued);
    this.#queue = installable;
    const purchaseState: AugmentationPurchaseState = {
      installed: ownedAugs,
      queued: queue,
      sourceFile11Level: ownedSF["11"] ?? 0,
      bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
    };
    const owned = (name: string) => Object.hasOwn(ownedAugs, name) || queue.includes(name);
    // The joined factions' shops and what's reached: core's (#260), the fast model's too; the gang's faction's (#334).
    const shopsView = augmentationShops(state.joined, currentNode, purchaseState, owned, gangShop);
    const { joined, shops, sold, reached, sellerOf, reputationOf } = shopsView;
    const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
    const money = player.money - this.#spent.reduce((sum, each) => sum + each.price, 0);
    const hackingLevel = player.person.skills.hacking;
    // Short of Daedalus's count (#228): any augmentation counts.
    // With The Red Pill at the gang's faction (#334, BN2), Daedalus isn't needed: never short of its count.
    const count = daedalusCountOf({
      currentNode,
      ownedSF,
      installed: ownedAugs,
      joined: state.joined,
      invitations: state.invitations,
      redPillElsewhere: gangSellsRedPill(gangShop?.name ?? null, currentNode),
    });
    const short = count.short;
    const cycle = readAugmentationCycle(this.#store);
    // Donations (#225): planned only before the commit; committed, the note's go first, and the set is what's reached.
    const terms =
      cycle === null
        ? donationTermsOf(
            joined,
            shops,
            sold.filter((name) => !owned(name) && sellerOf(name) === null),
            player.person.mults.faction_rep,
            multipliers,
          )
        : undefined;
    let set = chooseAugmentationsToBuy(reached, purchaseState, money, hackingLevel, terms, short);
    let setView = set.purchases.map(({ name, money: price }) => ({ augmentation: name, price }));

    // A donation asked for, its reputation shown before its done is reported (#225 review): recorded now, as the next
    // ask replaces it and its done would never be.
    this.#recordDonationShown(reputationOf, slowGameTimeMs, atMs);

    if (cycle === null) {
      const endgame0 = this.#endgame({
        resetInfo,
        player,
        purchaseState,
        installable,
        queue,
        shops: shopsView,
        destroyWanted,
        // The game's time since the last install (#334): the gang's faction's rate.
        sinceResetMs: slowGameTimeMs === null ? null : Math.max(0, slowGameTimeMs - resetInfo.lastAugReset),
        onlineMs: this.#onlineClock?.lastAugReset === resetInfo.lastAugReset ? this.#onlineClock.onlineMs : 0,
      });
      // The Red Pill's donation first (#225 review): the counts are budgeted without its money.
      const redPillAmount = endgame0.kind === "redPill" ? (endgame0.donation?.amount ?? 0) : 0;
      const budget = money - redPillAmount;
      if (redPillAmount > 0) {
        set = chooseAugmentationsToBuy(reached, purchaseState, budget, hackingLevel, terms, short);
        setView = set.purchases.map(({ name, money: price }) => ({ augmentation: name, price }));
      }
      const notCommitted = { set: setView, setCost: set.money, committed: false, donations: [] as Donation[] };
      if (this.#installNotReset !== null) {
        this.#cancelCountdown("an install was reported done but the game didn't reset");
        return this.#ask(null, {
          waitingFor:
            "a reset: an install was reported done but the game didn't reset, so no other is chosen until one (or " +
            "the brain restarts)",
          ...notCommitted,
          progress: null,
          reserve: 0,
        });
      }
      if (slowGameTimeMs === null) {
        return this.#ask(null, {
          waitingFor: "the game's time in the Agent's slow snapshot",
          ...notCommitted,
          progress: null,
          reserve: 0,
        });
      }
      const onlineMs = this.#onlineClock?.lastAugReset === resetInfo.lastAugReset ? this.#onlineClock.onlineMs : 0;
      // The game's time since the last install counts the time the game was closed: only a quick install's limit.
      const sinceResetMs = Math.max(0, slowGameTimeMs - resetInfo.lastAugReset);
      /**
       * The counts and the rule with `spare` money and the set it covers (core's `installJudgement`, #260). `laterMs`
       * on, both clocks are that much later (the lookahead's: a quick install's 20 minutes may be over by then, #222
       * review).
       */
      const judge = (spare: number, covered: AugmentationSet, laterMs = 0) =>
        installJudgement({
          state: purchaseState,
          installable,
          set: covered,
          money: spare,
          shops: shopsView,
          owned,
          terms,
          short,
          onlineMs: onlineMs + laterMs,
          sinceResetMs: sinceResetMs + laterMs,
        });
      const { counts, rule } = judge(budget, set);
      const progress = (
        held: string | null,
        reason: InstallReason | null = rule.reason,
        countHold: CountHoldView | null = null,
      ): AugmentationProgress => ({
        lastAugReset: resetInfo.lastAugReset,
        affordable: rule.affordable,
        affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
        bar: rule.bar,
        barWithNeuroFlux: rule.barWithNeuroFlux,
        onlineMs,
        barFallsInMs: rule.barFallsAtMs === null ? null : rule.barFallsAtMs - onlineMs,
        barWithNeuroFluxFallsInMs:
          rule.barWithNeuroFluxFallsAtMs === null ? null : rule.barWithNeuroFluxFallsAtMs - onlineMs,
        reason,
        countdown:
          this.#countdown === null
            ? null
            : {
                endsAtGameMs: this.#countdown.endsAtGameMs,
                endsInMs: Math.max(0, this.#countdown.endsAtGameMs - gameNowMs),
                quick: this.#countdown.quick,
                extensions: this.#countdown.extensions,
              },
        held,
        byDonation: counts.byDonation,
        setCost: set.money + set.donationMoney,
        short: short ? { installed: count.installed, required: count.required } : null,
        countHold,
      });
      const notCommittedDonations = { ...notCommitted, donations: counts.donations };
      let endgame = endgame0;
      // Daedalus's favour (#225): an install only with something to install (`installRule`'s guarantee), else held.
      const anything = installable.length + set.purchases.length + counts.neuroFluxLevels > 0;
      if (endgame.kind === "daedalusDonations" && !anything) {
        endgame = {
          kind: "hold",
          why: "daedalusDonations",
          reserve: 0,
          waitingFor:
            "something affordable to install: Daedalus's reputation this cycle unlocks its donations at the next " +
            "install, but nothing is queued or affordable",
        };
      }
      // The destroy's hold (#336): what the money buys of NeuroFlux Governor is the planner's install candidate, and
      // that install, once the planner chooses it, goes at once in the hold's place ("the hacking level"), if the money
      // buys a level (an install of nothing new would only lose the experience).
      const destroyHold = endgame.kind === "hold" && endgame.why === "destroy";
      if (destroyHold) this.#neuroFluxOffer = counts.neuroFluxLevels;
      const forLevel = destroyHold && levellingInstall && counts.neuroFluxLevels > 0;
      const holding = endgame.kind === "hold" && !forLevel ? endgame.why : null;
      if (holding !== null && holding !== this.#holding) {
        this.#log(`augmentations: no install, waiting for ${endgame.kind === "hold" ? endgame.waitingFor : ""}`);
      }
      this.#holding = holding;
      let reason: InstallReason;
      if (endgame.kind === "hold" && !forLevel) {
        // The Red Pill's way overrides the count rule (#215).
        this.#cancelCountdown(`held for ${endgame.waitingFor}`);
        if (endgame.why === "daedalus") this.#daedalusHold = endgame.reserve;
        if (endgame.why === "redPill") this.#redPillHold = endgame.reserve;
        const held = progress(endgame.waitingFor);
        this.#recordProgress(held, endgame.why, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: held,
          reserve: endgame.reserve,
          waitingFor: endgame.waitingFor,
        });
      }
      // Daedalus's favour (#225) installs through the normal countdown, whatever the count.
      const countdownReason: InstallReason | null =
        endgame.kind === "daedalusDonations" ? "Daedalus donations" : rule.install ? rule.reason : null;
      // Daedalus's count (#243): an install the count rule chose that would leave the count one short is held while the
      // last can be bought within the hold's window, the cycle's first hold's, kept in the store; only once this cycle
      // has reached Daedalus's hacking or combat requirement (#243 review), so the count is what's missing.
      const setNames = set.purchases.map((purchase) => purchase.name);
      const installing = [...installable, ...setNames, ...(counts.neuroFluxLevels > 0 ? [NEUROFLUX_GOVERNOR] : [])];
      const stored = readCountHold(this.#store);
      const heldSinceOnlineMs = stored?.lastAugReset === resetInfo.lastAugReset ? stored.sinceOnlineMs : null;
      const windowOpen = heldSinceOnlineMs !== null && onlineMs < heldSinceOnlineMs + DAEDALUS_COUNT_HOLD_MS;
      const firstDecision = !this.#decidedOnce;
      this.#decidedOnce = true;
      const countHold =
        short && countdownReason !== null && endgame.kind !== "redPill" && !forLevel
          ? daedalusCountHold({
              installed: ownedAugs,
              installing,
              required: count.required,
              skillsReached: daedalusSkillsReached(player.person.skills, daedalusRequirements(currentNode, ownedSF)),
              toCome: countablesToCome({
                sold,
                state: purchaseState,
                set,
                joined,
                shops,
                terms,
                person: player.person,
                conditions: workConditionsOf(resetInfo, slowData),
                work: holdWork,
                money: budget,
                income: this.#income(),
                // A restart or a gap loses the income for 10 minutes: the window open, its money taken as coming.
                assumeMoney: windowOpen,
              }),
              onlineMs,
              heldSinceOnlineMs,
            })
          : null;
      if (countHold !== null) {
        if (heldSinceOnlineMs === null || stored?.ended === true) {
          this.#store.setSetting(
            AUGMENTATION_COUNT_HOLD_SETTING,
            JSON.stringify({ lastAugReset: resetInfo.lastAugReset, sinceOnlineMs: countHold.sinceOnlineMs }),
          );
        }
        const view: CountHoldView = { ...countHold.next, leftMs: countHold.untilOnlineMs - onlineMs };
        const words = describeCountHold(view, count);
        if (countHeldBefore === null) this.#log(`augmentations: install held for Daedalus's count: ${words}`);
        this.#countHeld = view;
        this.#cancelCountdown(`held for Daedalus's count, ${view.augmentation} in ~${formatEta(view.etaMs)}`);
        const held = progress(words, countdownReason, view);
        this.#recordProgress(held, `daedalusCount: ${view.augmentation}`, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: held,
          // As the countdown holds (the counted purchases' money, so the rule goes on saying install), or the set's and
          // the last's if more: from cloud servers and home RAM alike (`countdownReserve`).
          reserve: Math.max(counts.money, set.money + set.donationMoney + view.money),
          waitingFor: `the install held for Daedalus's count: ${words}`,
        });
      }
      // Its end, logged: held at the last update, or (a restarted brain's first decision) its window open and its end
      // not logged before the restart (the store says).
      if (countHeldBefore !== null || (firstDecision && windowOpen && stored?.ended !== true)) {
        const countAfter = countAfterInstall(ownedAugs, installing);
        const holdLength = formatEta(DAEDALUS_COUNT_HOLD_MS);
        const endReason = !short
          ? "Daedalus's count met"
          : countdownReason === null
            ? "the rule no longer says install"
            : countAfter >= count.required
              ? "the count reached at this install"
              : count.required - countAfter > 1
                ? `this install would now leave it ${count.required - countAfter} short`
                : countHeldBefore?.way === "work" && !worksFor(holdWork, countHeldBefore.faction)
                  ? `nobody works for ${countHeldBefore.faction}`
                  : !windowOpen
                    ? `its ${holdLength} are up`
                    : `${countHeldBefore?.augmentation ?? "the last"} isn't within what's left of its ${holdLength}`;
        this.#log(`augmentations: the hold for Daedalus's count is over: ${endReason}`);
        this.#countHoldEndLogged = true;
        if (heldSinceOnlineMs !== null && stored !== null) {
          this.#store.setSetting(AUGMENTATION_COUNT_HOLD_SETTING, JSON.stringify({ ...stored, ended: true }));
        }
      }
      let redPillDonation: Donation | null = null;
      if (endgame.kind === "redPill") {
        // No countdown for The Red Pill: #215's install, at once (the legacy scripts start one, never extended, `:963-968`).
        this.#cancelCountdown("The Red Pill reached, installed at once");
        reason = "The Red Pill";
        redPillDonation = endgame.donation;
      } else if (forLevel) {
        // The planner's levelling install (#336): at once, as The Red Pill's; A6 buys the levels, then installs.
        this.#cancelCountdown("the planner's levelling install, at once");
        reason = "the hacking level";
      } else if (countdownReason === null) {
        this.#cancelCountdown(`the rule no longer says install: ${describeCounts(rule)}`);
        // Held back from cloud servers only for an install the rule would choose with A2's payback limit's more income:
        // the counted purchases' money then (#213 review, #222).
        const income = this.#income();
        let reserve = 0;
        if (income !== null && income > 0) {
          const spare = money + (income * AUGMENTATION_RESERVE_LOOKAHEAD_MS) / 1000;
          const ahead = judge(
            spare,
            chooseAugmentationsToBuy(reached, purchaseState, spare, hackingLevel, terms, short),
            AUGMENTATION_RESERVE_LOOKAHEAD_MS,
          );
          if (ahead.rule.install) reserve = ahead.counts.money;
        }
        const waiting = progress(null);
        this.#recordProgress(waiting, null, atMs);
        return this.#ask(null, {
          ...notCommittedDonations,
          progress: waiting,
          reserve,
          waitingFor: `the count to reach a bar: ${describeProgress(waiting)}`,
        });
      } else {
        const ruleReason = countdownReason;
        // The game's clock set back (a save loaded, say): its end is no longer the countdown's; one starts afresh.
        if (this.#countdown !== null && gameNowMs < this.#countdown.seenAtGameMs) {
          this.#cancelCountdown("the game's clock set back");
        }
        let countdown = this.#countdown;
        if (countdown === null) {
          const quick = ruleReason === "quick install";
          const lengthMs = quick ? QUICK_INSTALL_COUNTDOWN_MS : INSTALL_COUNTDOWN_MS;
          countdown = {
            lastAugReset: resetInfo.lastAugReset,
            endsAtGameMs: gameNowMs + lengthMs,
            lengthMs,
            quick,
            extensions: 0,
            count: rule.affordableWithNeuroFlux,
            seenAtGameMs: gameNowMs,
          };
          this.#countdown = countdown;
          this.#log(
            `augmentations: install countdown started, ${countdownSeconds(lengthMs)}, ${describeReason(ruleReason, rule)}; ` +
              `${formatMoney(counts.money)} held back from cloud servers and home RAM`,
          );
        } else if (rule.affordableWithNeuroFlux > countdown.count) {
          // The count rose: the countdown runs on, a little less each time, never shortened (`autopilot.js:972-976`).
          countdown.extensions += 1;
          const endsAtGameMs =
            gameNowMs + countdownExtensionMs(countdown.lengthMs, countdown.extensions, rule.barWithNeuroFlux);
          if (endsAtGameMs > countdown.endsAtGameMs) {
            countdown.endsAtGameMs = endsAtGameMs;
            this.#log(
              `augmentations: install countdown extended, ${countdownSeconds(endsAtGameMs - gameNowMs)} from now ` +
                `(extension ${countdown.extensions}): ${describeCounts(rule)}`,
            );
          }
        }
        countdown.count = rule.affordableWithNeuroFlux;
        countdown.seenAtGameMs = gameNowMs;
        if (gameNowMs < countdown.endsAtGameMs) {
          const waiting = progress(null, ruleReason);
          this.#recordProgress(waiting, null, atMs);
          return this.#ask(null, {
            ...notCommittedDonations,
            progress: waiting,
            reserve: counts.money,
            waitingFor:
              `the install countdown: ${countdownSeconds(countdown.endsAtGameMs - gameNowMs)} left, ` +
              describeReason(ruleReason, rule),
          });
        }
        this.#countdown = null;
        this.#log(
          `augmentations: install countdown ended (${countdown.extensions} extension` +
            `${countdown.extensions === 1 ? "" : "s"})`,
        );
        reason = ruleReason;
      }
      const donations = withDonation(counts.donations, redPillDonation);
      // Short (#238): what counts within reach beyond the set, whatever `isWorthInstalling` says, and the money left
      // after the set and its donations (#238 review: not the levels', which stop short of the next one).
      const countFacts: CountFacts | undefined = short
        ? {
            moneyAfterSet: budget - set.money - set.donationMoney,
            within: countablesWithinReach({
              reached: reached.map((augmentation) => ({ augmentation, faction: sellerOf(augmentation) as string })),
              state: { ...purchaseState, queued: [...queue, ...set.purchases.map((purchase) => purchase.name)] },
              donations: terms,
            }),
          }
        : undefined;
      writeAugmentationCycle(this.#store, {
        lastAugReset: resetInfo.lastAugReset,
        installing: false,
        neuroFluxTarget: installable.filter((name) => name === NEUROFLUX_GOVERNOR).length + counts.neuroFluxLevels,
        donations,
        reason,
        ...(redPillDonation === null ? {} : { redPill: redPillDonation.faction }),
        ...(countFacts === undefined ? {} : { countFacts }),
      });
      this.#installing = false;
      this.#progress = null;
      this.#donationsSkipped.clear();
      this.#emit({
        type: AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
        atMs,
        set: setView,
        cost: set.money,
        queued: [...installable],
        onlineMs,
        affordable: rule.affordable,
        affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
        bar: rule.bar,
        barWithNeuroFlux: rule.barWithNeuroFlux,
        reason,
        donations,
      });
      this.#log(
        `augmentations: install chosen, ${formatEta(onlineMs)} online this cycle: buying ` +
          `${setView.map((each) => each.augmentation).join(", ") || "nothing more"} (${formatMoney(set.money)}), ` +
          (donations.length === 0 ? "" : `donating ${donations.map(describeDonation).join(", ")} first, `) +
          describeReason(reason, rule),
      );
    }

    // Committed: the donations (#225), the set, home's RAM, NeuroFlux Governor, then the install (already asked for, a
    // restarted brain's note says: nothing more is bought).
    if (cycle?.installing === true) this.#installing = true;
    const note = readAugmentationCycle(this.#store);
    const committedView = {
      set: setView,
      setCost: set.money,
      progress: null,
      donations: note?.donations ?? [],
      reserve: Number.POSITIVE_INFINITY,
      committed: true,
    };
    if (!this.#installing) {
      // The donations first (#225), one faction at a time, each shown by the faction state before anything is bought:
      // the set is what's reached once they are, in buy order.
      if (this.#donated.length > 0) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the faction state to show ${this.#donated.map((each) => `${each.faction}'s`).join(", ")} reputation after the donation`,
        });
      }
      // A donation asked for and not yet reported done (#227 re-review): its money may be spent already, the medium
      // snapshot showing it before the fast one reports the done and the slow one the reputation. Asked again, and
      // nothing else judged, until its done or its reputation shows (`#recordDonationShown`); one that never goes
      // through is the Agent's `intentStuck`.
      const inFlight = this.#asked;
      if (
        inFlight?.donation !== undefined &&
        !this.#recorded.has(inFlight.intent.id) &&
        (note?.donations ?? []).some((each) => each.faction === inFlight.faction)
      ) {
        const { reputation } = inFlight.donation;
        return this.#ask(inFlight, {
          ...committedView,
          asking: `donating ${describeDonation({ faction: inFlight.faction, amount: inFlight.price, reputation })}`,
        });
      }
      // The Red Pill's donation is never passed over (#225 review): the money for it gone, the cycle is called off, and
      // `#endgame` holds the next for the money.
      const redPillDonation = note?.donations?.find((each) => each.faction === note.redPill);
      const redPillAmount =
        redPillDonation === undefined ? 0 : this.#donationNow(redPillDonation, reputationOf, player, multipliers);
      if (redPillDonation !== undefined && redPillAmount > money) {
        this.#callOff(
          atMs,
          `the money for ${THE_RED_PILL}'s donation is gone: ${describeDonation({ ...redPillDonation, amount: redPillAmount })}` +
            `, ${formatMoney(money)} now`,
        );
        return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
      }
      const donation = this.#nextDonation(note?.donations ?? [], reputationOf, player, money, multipliers);
      if (donation !== null) {
        return this.#ask(donation, {
          ...committedView,
          asking: `donating ${describeDonation({ faction: donation.faction, amount: donation.price, reputation: donation.donation?.reputation ?? 0 })}`,
        });
      }
      const [first] = set.purchases;
      if (first !== undefined) {
        const faction = sellerOf(first.name) as string;
        return this.#ask(
          {
            intent: purchaseIntent(faction, first.name, 1),
            augmentation: first.name,
            faction,
            level: 1,
            price: first.money,
          },
          { ...committedView, asking: `buying ${first.name} from ${faction} for ${formatMoney(first.money)}` },
        );
      }
      // Home's RAM (#219's order) only with the money above the NeuroFlux Governor levels counted at the choice and not
      // bought yet (#222 review): an install counted on them installs them.
      const neuroFluxLeft = Math.max(
        0,
        (readAugmentationCycle(this.#store)?.neuroFluxTarget ?? 0) -
          installable.filter((name) => name === NEUROFLUX_GOVERNOR).length,
      );
      const neuroFluxHeld =
        neuroFluxLeft === 0
          ? 0
          : purchaseSequenceCost(Array<string>(neuroFluxLeft).fill(NEUROFLUX_GOVERNOR), purchaseState).money;
      // The donations (#225) went first, each shown before this, or were passed over: home's RAM never spends their
      // money.
      const homeRam = homeRamEnabled ? chooseHomeRamUpgrade(mediumData, slowData) : null;
      if (homeRam?.next && money - (homeRam.price ?? 0) >= neuroFluxHeld) {
        const args = { fromRam: homeRam.next.fromRam, vendor: homeRam.next.vendor };
        return this.#ask(
          {
            intent: { id: intentId("upgradeHomeRam", args), action: "upgradeHomeRam", args },
            augmentation: null,
            faction: homeRam.next.vendor,
            level: 0,
            price: homeRam.price ?? 0,
          },
          { ...committedView, asking: `home RAM to ${homeRam.next.fromRam * 2} GB before the install (it stays)` },
        );
      }
      const neuroFlux = this.#neuroFlux(purchaseState, shops, reputationOf, money);
      if (neuroFlux !== null) {
        return this.#ask(neuroFlux, {
          ...committedView,
          asking:
            `buying ${NEUROFLUX_GOVERNOR} level ${neuroFlux.level} from ${neuroFlux.faction} for ` +
            formatMoney(neuroFlux.price),
        });
      }
      // The Red Pill reached at a joined seller (#215): last, as every purchase makes the next dearer and it costs $0.
      const redPillSeller = owned(THE_RED_PILL) ? null : sellerOf(THE_RED_PILL);
      if (redPillSeller !== null) {
        return this.#ask(
          {
            intent: purchaseIntent(redPillSeller, THE_RED_PILL, 1),
            augmentation: THE_RED_PILL,
            faction: redPillSeller,
            level: 1,
            price: augmentationCost(THE_RED_PILL, purchaseState).money,
          },
          { ...committedView, asking: `buying ${THE_RED_PILL} from ${redPillSeller}` },
        );
      }
      const unconfirmed = this.#bought.map((bought) => bought.augmentation);
      if (unconfirmed.length > 0) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the faction state to show ${unconfirmed.join(", ")} queued, before the install`,
        });
      }
      // Daedalus's path chosen (a joined seller of The Red Pill, not installed): never an install without it (#215
      // review). Reported bought and never queued (`augmentationNotQueued`, alerted), the cycle is called off, and
      // `#endgame` holds the next; not bought yet (its reputation fell short), it waits. But for "Daedalus donations"
      // (#225 review): that install is for Daedalus's favour, without The Red Pill. The gang's faction (#334) holds
      // only The Red Pill's own install: `#endgame` lets an ordinary one go once the window's passed, and the gang stays.
      // Committed for The Red Pill with the gang unread (#335's review: a brain restarted in BN2): its seller unknown
      // until the gang's reading, so neither an install without it nor a call-off; it waits.
      if (
        note?.reason === "The Red Pill" &&
        gangUnread &&
        !Object.hasOwn(ownedAugs, THE_RED_PILL) &&
        !installable.includes(THE_RED_PILL)
      ) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the gang's first reading, for ${THE_RED_PILL}'s seller, before the install`,
        });
      }
      const redPillSold = [...shops].some(
        ([faction, shop]) =>
          shop.includes(THE_RED_PILL) && (faction !== shopsView.gangFaction || note?.reason === "The Red Pill"),
      );
      const forFavour = note?.reason === "Daedalus donations";
      if (redPillSold && !forFavour && !Object.hasOwn(ownedAugs, THE_RED_PILL) && !installable.includes(THE_RED_PILL)) {
        if (queue.includes(THE_RED_PILL)) {
          this.#callOff(atMs, `${THE_RED_PILL} reported bought but never queued: no install without it`);
          return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
        }
        // Committed for it, and no seller's reputation reaches it now (#334): a stale reading's, say, as forming a gang
        // resets its faction's to 0 (`PlayerObjectGangMethods.ts:67`). Called off, so `#endgame` judges afresh, never
        // waiting on a purchase that can't come.
        if (note?.reason === "The Red Pill" && redPillSeller === null) {
          this.#callOff(atMs, `${THE_RED_PILL}'s reputation short at every seller now: no install without it`);
          return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
        }
        return this.#ask(null, {
          ...committedView,
          waitingFor: `${THE_RED_PILL} bought and shown queued, before the install`,
        });
      }
    }
    // Never an install of nothing (#213 re-review): the game would report it done, with no reset. Checked on a
    // restarted brain's way too, its install already asked for.
    if (installable.length === 0) {
      this.#callOff(atMs, "nothing queued to install (the faction state's queue is empty)");
      return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
    }
    if (!this.#installing) {
      this.#installing = true;
      writeAugmentationCycle(this.#store, {
        ...readAugmentationCycle(this.#store),
        lastAugReset: cycle?.lastAugReset ?? resetInfo.lastAugReset,
        installing: true,
      });
      this.#log(`augmentations: installing ${installable.length} queued (the gate, then a save backup first)`);
    }
    this.#asked = null;
    this.#view = {
      ...this.#view,
      ...committedView,
      asking: `installing ${installable.length} queued`,
      waitingFor: null,
      waiting: false,
    };
    return { intent: null, install: true, committed: true };
  }

  /**
   * The Red Pill's way (#215), before an ordinary install is chosen:
   * - `redPill`: it's queued, or reached at a joined seller (Daedalus): install, for it.
   * - `hold`: no ordinary install, saying why. Joined, it's short of its reputation, which an install would reset
   *   (`Faction/Faction.ts:77-85`). Not joined, with Daedalus's count of installed augmentations reached and its skill
   *   requirement met: only money, held at the game's check, is missing, so its $100b is held back from cloud servers
   *   (an install would reset the money and the hacking level). With the skill short, ordinary installs go on: they
   *   raise the hacking multiplier.
   * - Installed, with the destroy wanted (#215 review): `hold`, as an install would reset the hacking level
   *   w0r1d_d43m0n needs (and drop its root), with `lastNodeReset` unmoved, so the destroy would wait hours.
   * - Reported bought and never queued (`augmentationNotQueued`, #215 review): `hold`, as R2 counts it owned for the
   *   plan; an install without it would install the rest and lose Daedalus's reputation.
   * - `redPill` with a donation (#225): a joined seller's donations are unlocked and the money covers the donation for
   *   its missing reputation; short of it, `hold`, that money held back (`redPillHold`).
   * - `daedalusDonations` (#225): Daedalus joined, its donations not unlocked, its reputation this cycle at what
   *   unlocks them at the next install (`redPillTarget`'s donations target: not once 90% of The Red Pill's is earned).
   * - `none`: installed already (the destroy not wanted), not sold in this BitNode (BN15), or Daedalus's count not
   *   reached.
   */
  #endgame({
    resetInfo,
    player,
    purchaseState,
    installable,
    queue,
    shops,
    destroyWanted,
    sinceResetMs,
    onlineMs,
  }: {
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    purchaseState: AugmentationPurchaseState;
    /** What an install would install, and the queue the plan counts (with each `augmentationNotQueued`). */
    installable: string[];
    queue: string[];
    shops: AugmentationShops;
    destroyWanted: boolean;
    sinceResetMs: number | null;
    /** The game's time online this cycle (the bars' clock): the hold's window at the gang's faction, from its start. */
    onlineMs: number;
  }): Endgame {
    const { currentNode, ownedAugs, ownedSF, lastAugReset } = resetInfo;
    // The hold at the gang's faction (#335's review): from its first start in the cycle, at most its window, never
    // restarted, kept in the store as Daedalus's count hold is.
    const stored = readGangRedPillHold(this.#store);
    const heldSince = stored?.lastAugReset === lastAugReset ? stored.sinceOnlineMs : null;
    // The decision is core's (#260), the fast model's too; the words are the brain's.
    const endgame = augmentationEndgame({
      installed: ownedAugs,
      installable,
      queue,
      state: purchaseState,
      shops,
      money: player.money,
      factionRep: player.person.mults.faction_rep,
      figures: { money: player.money, skills: player.person.skills },
      currentNode,
      ownedSF,
      destroyWanted,
      sinceResetMs,
      gangHoldOver: heldSince !== null && onlineMs >= heldSince + GANG_RED_PILL_HOLD_MS,
    });
    const atGang = endgame.kind === "hold" && "seller" in endgame && endgame.seller.faction === shops.gangFaction;
    this.#redPillHeldAtGang = atGang;
    if (atGang && heldSince === null) writeGangRedPillHold(this.#store, { lastAugReset, sinceOnlineMs: onlineMs });
    if (endgame.kind !== "hold") return endgame;
    const count = (value: number) => Math.floor(value).toLocaleString("en-US");
    const hold = (why: HoldReason, waitingFor: string): Endgame => ({
      kind: "hold",
      why,
      reserve: endgame.reserve,
      waitingFor,
    });
    switch (endgame.why) {
      case "destroy":
        return hold(
          "destroy",
          `the BitNode's destroy: ${THE_RED_PILL} is installed, and an install would reset the hacking level ` +
            "w0r1d_d43m0n needs (the destroy switched on)",
        );
      case "redPillNotQueued":
        return hold(
          "redPillNotQueued",
          `${THE_RED_PILL} reported bought but not in the faction state's queue (the augmentationNotQueued alert): ` +
            "no install without it",
        );
      case "redPill":
        return "donation" in endgame
          ? hold(
              "redPill",
              `${THE_RED_PILL}: the money for ${endgame.donation.faction}'s donation, ` +
                `${formatMoney(endgame.donation.amount)} for its reputation (${formatMoney(endgame.money)} now)`,
            )
          : hold(
              "redPill",
              `${THE_RED_PILL}: ${endgame.seller.faction}'s reputation ${count(endgame.seller.reputation)} of ` +
                `${count(endgame.seller.needed)}` +
                // The gang's faction (#334): held only while it comes within the window.
                (endgame.seller.etaMs === undefined
                  ? ""
                  : `, about ${formatEta(endgame.seller.etaMs)} more at the cycle's rate (the gang's faction; held ` +
                    `${formatEta(Math.max(0, onlineMs - (heldSince ?? onlineMs)))} of at most ` +
                    `${formatEta(GANG_RED_PILL_HOLD_MS)})`) +
                " (an install now would lose it)",
            );
      case "daedalus":
        return hold(
          "daedalus",
          `${DAEDALUS}'s invitation (${endgame.missing.join(", ") || "the game's next check"}): an install now would ` +
            "reset the money and the hacking level",
        );
    }
  }

  /**
   * The donation asked for, if the faction state shows its reputation reached though its done isn't reported yet (#225
   * review): its event, its money spent, and recorded, so the done that comes later changes nothing.
   */
  #recordDonationShown(reputationOf: (faction: string) => number, slowGameTimeMs: number | null, atMs: number): void {
    const asked = this.#asked;
    if (asked?.donation === undefined || this.#recorded.has(asked.intent.id)) return;
    const shown = reputationOf(asked.faction);
    if (shown < asked.donation.reputation) return;
    this.#recorded.add(asked.intent.id);
    this.#spent.push({ gameTimeMs: slowGameTimeMs ?? 0, price: asked.price });
    const { reputation, before } = asked.donation;
    const amount = asked.price;
    this.#emit({
      type: AUGMENTATION_DONATED_EVENT_KIND,
      atMs,
      faction: asked.faction,
      amount,
      reputation,
      before,
      after: shown,
    });
    this.#log(
      `augmentations: donated ${describeDonation({ faction: asked.faction, amount, reputation })}: its reputation ` +
        `${Math.round(before).toLocaleString("en-US")} → ${Math.round(shown).toLocaleString("en-US")} (seen before ` +
        "its done was reported)",
    );
  }

  /** The donation `donation` needs now (#225): to its reputation from the faction's now; 0 once it's there. */
  #donationNow(
    donation: Donation,
    reputationOf: (faction: string) => number,
    player: NonNullable<ReturnType<typeof playerOf>>,
    multipliers: { FactionWorkRepGain: number },
  ): number {
    return donationToReach(
      donation.reputation - reputationOf(donation.faction),
      player.person.mults.faction_rep,
      multipliers.FactionWorkRepGain,
    );
  }

  /**
   * The note's next donation to make (#225), as an ask, or null once each is made: its faction's reputation short of
   * the donation's, in the note's order. One the money doesn't cover now is passed over for the cycle, saying so: what
   * it was for isn't bought, and the rest goes on.
   */
  #nextDonation(
    donations: readonly Donation[],
    reputationOf: (faction: string) => number,
    player: NonNullable<ReturnType<typeof playerOf>>,
    money: number,
    multipliers: { FactionWorkRepGain: number },
  ): Asked | null {
    for (const donation of donations) {
      if (this.#donationsSkipped.has(donation.faction)) continue;
      const amount = this.#donationNow(donation, reputationOf, player, multipliers);
      if (amount === 0) continue;
      if (amount > money) {
        this.#donationsSkipped.add(donation.faction);
        this.#log(
          `augmentations: the donation ${describeDonation({ ...donation, amount })} passed over: ` +
            `${formatMoney(money)} now; what it was for isn't bought`,
        );
        continue;
      }
      const args = { faction: donation.faction, amount, reputation: donation.reputation };
      return {
        intent: { id: intentId("donateToFaction", args), action: "donateToFaction", args },
        augmentation: null,
        faction: donation.faction,
        level: 0,
        price: amount,
        donation: { reputation: donation.reputation, before: reputationOf(donation.faction) },
      };
    }
    return null;
  }

  /** The next NeuroFlux Governor level, if the money and a joined seller's reputation cover it, as an ask. */
  #neuroFlux(
    purchaseState: AugmentationPurchaseState,
    shops: Map<string, string[]>,
    reputationOf: (faction: string) => number,
    money: number,
  ) {
    const cost = augmentationCost(NEUROFLUX_GOVERNOR, purchaseState);
    if (cost.money > money) return null;
    let faction: string | null = null;
    for (const [name, shop] of shops) {
      if (
        shop.includes(NEUROFLUX_GOVERNOR) &&
        reputationOf(name) >= cost.reputation &&
        (faction === null || reputationOf(name) > reputationOf(faction))
      ) {
        faction = name;
      }
    }
    if (faction === null) return null;
    const level =
      (purchaseState.installed[NEUROFLUX_GOVERNOR] ?? 0) +
      purchaseState.queued.filter((name) => name === NEUROFLUX_GOVERNOR).length +
      1;
    return {
      intent: purchaseIntent(faction, NEUROFLUX_GOVERNOR, level),
      augmentation: NEUROFLUX_GOVERNOR,
      faction,
      level,
      price: cost.money,
    };
  }

  /** What's asked for now (or nothing), and the view with it. */
  #ask(asked: Asked | null, view: Partial<AugmentationsView>): AugmentationAsk {
    this.#asked = asked;
    this.#view = { ...this.#view, asking: null, waitingFor: null, waiting: false, ...view };
    const committed = readAugmentationCycle(this.#store) !== null;
    return { intent: asked?.intent ?? null, install: false, committed };
  }

  /** The countdown called off, if one is under way (#222), saying why. */
  #cancelCountdown(why: string): void {
    if (this.#countdown === null) return;
    this.#countdown = null;
    this.#log(`augmentations: install countdown called off: ${why}`);
  }

  /**
   * The progress, stored as an `augmentationProgress` event when it changed since the last: always for the cycle, a
   * bar, the reason, the countdown's end or the hold (by its kind: its words carry live figures); for the counts alone,
   * at most once every `AUGMENTATION_PROGRESS_COUNTS_EVERY_MS` (#222 review: money see-sawing across a NeuroFlux price
   * would record each crossing). A steady state records nothing.
   */
  #recordProgress(progress: AugmentationProgress, hold: string | null, atMs: number): void {
    const { lastAugReset, affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux, reason, byDonation } = progress;
    const structural = JSON.stringify([
      lastAugReset,
      bar,
      barWithNeuroFlux,
      reason,
      progress.countdown?.endsAtGameMs ?? null,
      hold,
      progress.short ?? null,
    ]);
    const counts = JSON.stringify([affordable, affordableWithNeuroFlux, byDonation]);
    const last = this.#progress;
    if (last !== null && last.structural === structural) {
      if (last.counts === counts || atMs - last.atMs < AUGMENTATION_PROGRESS_COUNTS_EVERY_MS) return;
    }
    this.#progress = { structural, counts, atMs };
    this.#emit({ type: AUGMENTATION_PROGRESS_EVENT_KIND, atMs, ...progress });
  }
}
