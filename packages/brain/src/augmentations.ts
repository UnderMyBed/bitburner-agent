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
//   `Faction/Faction.ts:77-85`); reached, or queued, the install is chosen ("The Red Pill"), and it's bought last.
// - The "Augmentations" switch, on by default (owner decision 48): off, nothing is bought or installed, and a cycle
//   under way is called off (what's bought stays queued, for the owner).
import {
  type AugmentationPurchaseState,
  type AugmentationSet,
  affordableCounts,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  chooseAugmentationsToBuy,
  countdownExtensionMs,
  DAEDALUS,
  daedalusMissing,
  daedalusRequirements,
  FACTION_NAMES,
  type FactionState,
  factionReadingKind,
  factionReadingOf,
  INSTALL_COUNTDOWN_MS,
  type InstallReason,
  type Intent,
  installRule,
  intentId,
  isWorthInstalling,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  QUICK_INSTALL_COUNTDOWN_MS,
  QUICK_INSTALL_WITHIN_MS,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { CLOUD_SERVER_PAYBACK_LIMIT_MS } from "./cloud-servers.ts";
import { workingPersonOf } from "./factions.ts";
import { chooseHomeRamUpgrade } from "./home-ram.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

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

/** How long the income is measured over: the slow snapshots' money sources across 10 minutes. */
export const AUGMENTATION_INCOME_WINDOW_MS = 10 * 60_000;
/**
 * Slow snapshots further apart than this (3 slow intervals, 3 minutes) have a gap between them: the game closed
 * (offline earns a fraction of the online rate), or the Agent or the brain away. The time across it isn't online time
 * (the bars' clock leaves it out, #222), and what was earned across it isn't the income, so the window starts again.
 */
export const AUGMENTATION_INCOME_GAP_MS = 3 * SNAPSHOT_TIER_PERIOD_MS.slow;
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
}

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
      /** The count reached, a quick install, nothing left at the joined factions, or The Red Pill. */
      reason: InstallReason;
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

/** The purchase asked for, with its price then; `augmentation` null for home's RAM. */
interface Asked {
  intent: Intent;
  augmentation: string | null;
  faction: string;
  level: number;
  price: number;
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
  /** The install chosen: buying for it, or installing. */
  committed: boolean;
  /** What the brain asks for now, in words, or null. */
  asking: string | null;
  /** Not committed: the set the money covers now, in buy order, and its money. */
  set: { augmentation: string; price: number }[];
  setCost: number;
  /** Not committed: where the count rule stands (#222), or null. */
  progress: AugmentationProgress | null;
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
   * The BitNode's destroy wanted once The Red Pill is installed (#215 review): the World Daemon's switch on, and its
   * next BitNode allowed. Then no ordinary install is chosen: it would reset the hacking level w0r1d_d43m0n needs.
   */
  destroyWanted: boolean;
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
}

export function readAugmentationCycle(store: TelemetryStore): AugmentationCycle | null {
  const value = store.getSetting(AUGMENTATION_CYCLE_SETTING);
  if (value === null) return null;
  let note: { lastAugReset?: unknown; installing?: unknown } | null;
  try {
    note = JSON.parse(value) as { lastAugReset?: unknown; installing?: unknown } | null;
  } catch {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't JSON`);
  }
  const installing = note?.installing ?? false;
  if (!isFiniteNumber(note?.lastAugReset) || typeof installing !== "boolean") {
    throw new Error(`the store's ${AUGMENTATION_CYCLE_SETTING} isn't a note the brain wrote`);
  }
  return { lastAugReset: note.lastAugReset, installing };
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

/** A countdown's time in seconds, rounded (#222): "90 s", "83 s". */
export function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** The counts and bars, as the progress, the events and the report give them. */
type CountFigures = Pick<AugmentationProgress, "affordable" | "affordableWithNeuroFlux" | "bar" | "barWithNeuroFlux">;

/** "5 of 8 new augmentations affordable (7 of 12 with NeuroFlux)". */
export function describeCounts({ affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux }: CountFigures): string {
  return `${affordable} of ${bar} new augmentations affordable (${affordableWithNeuroFlux} of ${barWithNeuroFlux} with NeuroFlux)`;
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
  return `${describeCounts(progress)}${online}${falls}`;
}

/** Why the install was chosen, in words, for the log and the report; a reason the brain no longer gives, as stored. */
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
  return `${reason} (an earlier brain's reason)`;
}

/** The bars' clock (#222): the game's time online since the install `lastAugReset`, and the last slow snapshot's. */
export interface OnlineClock {
  lastAugReset: number;
  onlineMs: number;
  lastGameTimeMs: number;
}

/**
 * The bars' clock after a slow snapshot taken at `gameTimeMs` in the cycle `lastAugReset` (#222): it adds the time
 * since the last slow snapshot of the same cycle, if no more than `AUGMENTATION_INCOME_GAP_MS` (the game closed, or
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
  const online = stepMs > 0 && stepMs <= AUGMENTATION_INCOME_GAP_MS;
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

/** The intent buying `augmentation` from `faction` (`level` 1 but for NeuroFlux Governor). */
export function purchaseIntent(faction: string, augmentation: string, level: number): Intent {
  const args = { faction, augmentation, level };
  return { id: intentId("purchaseAugmentation", args), action: "purchaseAugmentation", args };
}

/** The Red Pill's way, before an ordinary install is chosen (#215): `AugmentationRule`'s `#endgame`. */
type HoldReason = "destroy" | "redPillNotQueued" | "redPill" | "daedalus";
type Endgame =
  | { kind: "redPill" }
  | { kind: "hold"; why: HoldReason; waitingFor: string; reserve: number }
  | { kind: "none" };

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
  } | null = null;
  /** The progress last recorded, as its key: a steady state records nothing. */
  #progressKey: string | null = null;
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
  /** Daedalus's $100b, held back for its invitation (#215), or 0: home RAM keeps it too (#215 review). */
  #daedalusHold = 0;
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
    this.#onlineClock = readOnlineClock(store);
  }

  /** Whether the purchase asked for is among `doneIds`, not yet recorded: the controller updates at once then. */
  askedDone(doneIds: ReadonlySet<string>): boolean {
    const asked = this.#asked;
    if (asked !== null && doneIds.has(asked.intent.id) && !this.#recorded.has(asked.intent.id)) return true;
    // The install reported done (nothing to install, says the game): watched for the reset from now.
    return this.#installDone === null && doneIds.has(AUGMENTATION_INSTALL_INTENT.id) && this.#installAskedFor();
  }

  /** The install asked for: here, or in the commit's note (a restarted brain's, before its first decision). */
  #installAskedFor(): boolean {
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
   * The money held in the install's countdown (#222): what the counted purchases cost, from cloud servers (`reserve`)
   * and home RAM alike, as the legacy scripts' reserve.txt holds it from every purchase (`autopilot.js:983`); else 0.
   */
  countdownReserve(): number {
    return this.#enabled && this.#countdown !== null ? this.#view.reserve : 0;
  }

  /** An install reported done that the next slow snapshot didn't show reset, until a reset (#213 re-review). */
  installNotReset(): { atMs: number; queued: string[] } | null {
    return this.#installNotReset === null ? null : { ...this.#installNotReset };
  }

  view(): AugmentationsView {
    return { ...this.#view, enabled: this.#enabled, notQueued: [...this.#notQueued] };
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

  update(inputs: AugmentationInputs): AugmentationAsk {
    const { mediumData, mediumGameTimeMs, slowData, slowGameTimeMs, doneIds, fastGameTimeMs, nowMs } = inputs;
    const { enabled, homeRamEnabled, destroyWanted } = inputs;
    this.#daedalusHold = 0;
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
      return askNothing(null, { waiting: false, committed: false, reserve: 0, progress: null, set: [], setCost: 0 });
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
    if (!this.#installAskedFor()) {
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

  /** The purchase asked for, reported done: an event, a log line, and waiting for the queue to show it. */
  #recordDone(doneIds: ReadonlySet<string>, fastGameTimeMs: number | null, atMs: number): void {
    const asked = this.#asked;
    if (asked === null || !doneIds.has(asked.intent.id) || this.#recorded.has(asked.intent.id)) return;
    this.#recorded.add(asked.intent.id);
    // A done comes in a fast snapshot, which has its time (the controller's null is for no fast snapshot, so no done).
    this.#spent.push({ gameTimeMs: fastGameTimeMs ?? 0, price: asked.price });
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
    const joined = state.joined.filter((faction) => FACTION_NAMES.includes(faction.name));
    const shops = new Map(
      joined.map((faction) => [faction.name, augmentationsSoldBy(faction.name, currentNode, null)]),
    );
    const reputationOf = (faction: string) => joined.find((each) => each.name === faction)?.reputation ?? 0;
    /** The joined seller with the most reputation covering what `augmentation` needs now, or null. */
    const sellerOf = (augmentation: string): string | null => {
      const needed = augmentationCost(augmentation, purchaseState).reputation;
      let best: string | null = null;
      for (const [faction, shop] of shops) {
        if (
          shop.includes(augmentation) &&
          reputationOf(faction) >= needed &&
          (best === null || reputationOf(faction) > reputationOf(best))
        ) {
          best = faction;
        }
      }
      return best;
    };
    const owned = (name: string) => Object.hasOwn(ownedAugs, name) || queue.includes(name);
    const sold = [...new Set([...shops.values()].flat())].filter((name) => name !== NEUROFLUX_GOVERNOR);
    const reached = sold.filter((name) => !owned(name) && sellerOf(name) !== null);
    const money = player.money - this.#spent.reduce((sum, each) => sum + each.price, 0);
    const hackingLevel = player.person.skills.hacking;
    const set = chooseAugmentationsToBuy(reached, purchaseState, money, hackingLevel);
    const setView = set.purchases.map(({ name, money: price }) => ({ augmentation: name, price }));
    const cycle = readAugmentationCycle(this.#store);

    if (cycle === null) {
      const notCommitted = { set: setView, setCost: set.money, committed: false };
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
      const neuroFluxReputation = Math.max(
        0,
        ...[...shops].filter(([, shop]) => shop.includes(NEUROFLUX_GOVERNOR)).map(([faction]) => reputationOf(faction)),
      );
      /**
       * The counts and the rule with `spare` money and the set it covers. Nothing left: no augmentation worth installing
       * at the joined factions that isn't owned or in the set and could be bought after it (its prerequisites owned or
       * in the set; one sold by no joined faction never can be).
       */
      const judge = (spare: number, covered: AugmentationSet) => {
        const names = covered.purchases.map((purchase) => purchase.name);
        const counts = affordableCounts({ state: purchaseState, set: covered, money: spare, neuroFluxReputation });
        const afterSet = { installed: ownedAugs, queued: [...queue, ...names] };
        const left = sold.filter(
          (name) =>
            isWorthInstalling(name) &&
            !owned(name) &&
            !names.includes(name) &&
            missingPrerequisites(name, afterSet).length === 0,
        );
        const rule = installRule({
          onlineMs,
          sinceResetMs,
          installing: installable.length + names.length,
          nothingLeft: left.length === 0,
          affordable: counts.affordable,
          affordableWithNeuroFlux: counts.affordableWithNeuroFlux,
        });
        return { counts, rule };
      };
      const { counts, rule } = judge(money, set);
      const progress = (held: string | null): AugmentationProgress => ({
        lastAugReset: resetInfo.lastAugReset,
        affordable: rule.affordable,
        affordableWithNeuroFlux: rule.affordableWithNeuroFlux,
        bar: rule.bar,
        barWithNeuroFlux: rule.barWithNeuroFlux,
        onlineMs,
        barFallsInMs: rule.barFallsAtMs === null ? null : rule.barFallsAtMs - onlineMs,
        barWithNeuroFluxFallsInMs:
          rule.barWithNeuroFluxFallsAtMs === null ? null : rule.barWithNeuroFluxFallsAtMs - onlineMs,
        reason: rule.reason,
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
      });
      const endgame = this.#endgame({
        resetInfo,
        player,
        purchaseState,
        installable,
        queue,
        shops,
        reputationOf,
        destroyWanted,
      });
      const holding = endgame.kind === "hold" ? endgame.why : null;
      if (holding !== null && holding !== this.#holding) {
        this.#log(`augmentations: no install, waiting for ${endgame.kind === "hold" ? endgame.waitingFor : ""}`);
      }
      this.#holding = holding;
      let reason: InstallReason;
      if (endgame.kind === "hold") {
        // The Red Pill's way overrides the count rule (#215).
        this.#cancelCountdown(`held for ${endgame.waitingFor}`);
        if (endgame.why === "daedalus") this.#daedalusHold = endgame.reserve;
        const held = progress(endgame.waitingFor);
        this.#recordProgress(held, endgame.why, atMs);
        return this.#ask(null, {
          ...notCommitted,
          progress: held,
          reserve: endgame.reserve,
          waitingFor: endgame.waitingFor,
        });
      }
      if (endgame.kind === "redPill") {
        // No countdown for The Red Pill (`autopilot.js:968`).
        this.#cancelCountdown("The Red Pill reached, installed at once");
        reason = "The Red Pill";
      } else if (!rule.install) {
        this.#cancelCountdown(`the rule no longer says install: ${describeCounts(rule)}`);
        // Held back from cloud servers only for an install the rule would choose with A2's payback limit's more income:
        // the counted purchases' money then (#213 review, #222).
        const income = this.#income();
        let reserve = 0;
        if (income !== null && income > 0) {
          const spare = money + (income * AUGMENTATION_RESERVE_LOOKAHEAD_MS) / 1000;
          const ahead = judge(spare, chooseAugmentationsToBuy(reached, purchaseState, spare, hackingLevel));
          if (ahead.rule.install) reserve = ahead.counts.money;
        }
        const waiting = progress(null);
        this.#recordProgress(waiting, null, atMs);
        return this.#ask(null, {
          ...notCommitted,
          progress: waiting,
          reserve,
          waitingFor: `the count to reach a bar: ${describeProgress(waiting)}`,
        });
      } else {
        const ruleReason = rule.reason as InstallReason;
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
          };
          this.#countdown = countdown;
          this.#log(
            `augmentations: install countdown started, ${formatSeconds(lengthMs)}, ${describeReason(ruleReason, rule)}; ` +
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
              `augmentations: install countdown extended, ${formatSeconds(endsAtGameMs - gameNowMs)} from now ` +
                `(extension ${countdown.extensions}): ${describeCounts(rule)}`,
            );
          }
        }
        countdown.count = rule.affordableWithNeuroFlux;
        if (gameNowMs < countdown.endsAtGameMs) {
          const waiting = progress(null);
          this.#recordProgress(waiting, null, atMs);
          return this.#ask(null, {
            ...notCommitted,
            progress: waiting,
            reserve: counts.money,
            waitingFor:
              `the install countdown: ${formatSeconds(countdown.endsAtGameMs - gameNowMs)} left, ` +
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
      writeAugmentationCycle(this.#store, { lastAugReset: resetInfo.lastAugReset, installing: false });
      this.#installing = false;
      this.#progressKey = null;
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
      });
      this.#log(
        `augmentations: install chosen, ${formatEta(onlineMs)} online this cycle: buying ` +
          `${setView.map((each) => each.augmentation).join(", ") || "nothing more"} (${formatMoney(set.money)}), ` +
          describeReason(reason, rule),
      );
    }

    // Committed: the set, home's RAM, NeuroFlux Governor, then the install (already asked for, a restarted brain's note
    // says: nothing more is bought).
    if (cycle?.installing === true) this.#installing = true;
    const committedView = {
      set: setView,
      setCost: set.money,
      progress: null,
      reserve: Number.POSITIVE_INFINITY,
      committed: true,
    };
    if (!this.#installing) {
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
      const homeRam = homeRamEnabled ? chooseHomeRamUpgrade(mediumData, slowData) : null;
      if (homeRam?.next) {
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
      // `#endgame` holds the next; not bought yet (its reputation fell short), it waits.
      const redPillSold = [...shops.values()].some((shop) => shop.includes(THE_RED_PILL));
      if (redPillSold && !Object.hasOwn(ownedAugs, THE_RED_PILL) && !installable.includes(THE_RED_PILL)) {
        if (queue.includes(THE_RED_PILL)) {
          this.#callOff(atMs, `${THE_RED_PILL} reported bought but never queued: no install without it`);
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
    reputationOf,
    destroyWanted,
  }: {
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    purchaseState: AugmentationPurchaseState;
    /** What an install would install, and the queue the plan counts (with each `augmentationNotQueued`). */
    installable: string[];
    queue: string[];
    shops: Map<string, string[]>;
    reputationOf: (faction: string) => number;
    destroyWanted: boolean;
  }): Endgame {
    const { currentNode, ownedAugs, ownedSF } = resetInfo;
    const count = (value: number) => Math.floor(value).toLocaleString("en-US");
    if (Object.hasOwn(ownedAugs, THE_RED_PILL)) {
      if (!destroyWanted) return { kind: "none" };
      return {
        kind: "hold",
        why: "destroy",
        reserve: 0,
        waitingFor:
          `the BitNode's destroy: ${THE_RED_PILL} is installed, and an install would reset the hacking level ` +
          "w0r1d_d43m0n needs (the destroy switched on)",
      };
    }
    if (installable.includes(THE_RED_PILL)) return { kind: "redPill" };
    if (queue.includes(THE_RED_PILL)) {
      return {
        kind: "hold",
        why: "redPillNotQueued",
        reserve: 0,
        waitingFor:
          `${THE_RED_PILL} reported bought but not in the faction state's queue (the augmentationNotQueued alert): ` +
          "no install without it",
      };
    }
    const needed = augmentationCost(THE_RED_PILL, purchaseState).reputation;
    const sellers = [...shops].filter(([, shop]) => shop.includes(THE_RED_PILL)).map(([faction]) => faction);
    if (sellers.some((faction) => reputationOf(faction) >= needed)) return { kind: "redPill" };
    if (sellers.length > 0) {
      const best = sellers.reduce((most, each) => (reputationOf(each) > reputationOf(most) ? each : most));
      return {
        kind: "hold",
        why: "redPill",
        reserve: 0,
        waitingFor:
          `${THE_RED_PILL}: ${best}'s reputation ${count(reputationOf(best))} of ${count(needed)} (an install now ` +
          "would lose it)",
      };
    }
    if (!augmentationsSoldBy(DAEDALUS, currentNode, null).includes(THE_RED_PILL)) return { kind: "none" };
    const required = daedalusRequirements(currentNode, ownedSF);
    const skills = player.person.skills;
    const figures = { augmentations: Object.keys(ownedAugs).length, money: player.money, skills };
    const missing = daedalusMissing(figures, required);
    // Held only with nothing but the money missing: a count or a skill short is missing too.
    const onlyMoney = missing.length === 0 || (missing.length === 1 && figures.money < required.money);
    if (!onlyMoney) return { kind: "none" };
    return {
      kind: "hold",
      why: "daedalus",
      reserve: required.money,
      waitingFor:
        `${DAEDALUS}'s invitation (${missing.join(", ") || "the game's next check"}): an install now would reset the ` +
        "money and the hacking level",
    };
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
   * The progress, stored as an `augmentationProgress` event when the counts, a bar, the reason, the countdown's end or
   * the hold (by its kind: its words carry live figures) changed since the last; a steady state records nothing.
   */
  #recordProgress(progress: AugmentationProgress, hold: string | null, atMs: number): void {
    const { lastAugReset, affordable, affordableWithNeuroFlux, bar, barWithNeuroFlux, reason } = progress;
    const key = JSON.stringify([
      lastAugReset,
      affordable,
      affordableWithNeuroFlux,
      bar,
      barWithNeuroFlux,
      reason,
      progress.countdown?.endsAtGameMs ?? null,
      hold,
    ]);
    if (key === this.#progressKey) return;
    this.#progressKey = key;
    this.#emit({ type: AUGMENTATION_PROGRESS_EVENT_KIND, atMs, ...progress });
  }
}
