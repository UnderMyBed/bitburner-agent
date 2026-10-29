// Augmentations and the reset (#210, M4 phase A slice A6): the brain buys the augmentations worth installing and
// installs them, the run's reset cycle. Choices computed from the game's formulas (owner decision 46), in core's
// augmentation-plan.ts; this is the rule as the controller runs it, and what the dashboard and the run report read.
// - Not committed: each update, the set the money covers of the augmentations reached (a joined seller's reputation
//   covers them), and core's `installDecision` against the next one worth installing at the joined factions. Install
//   chosen: committed, kept in the store until the game resets, so a restarted brain carries on.
// - Committed, one intent at a time: the set's next purchase (recomputed from what's queued), then home's RAM, which
//   an install keeps (`Server/ServerHelpers.ts:224-237`), then NeuroFlux Governor a level at a time, then, once
//   every purchase the Agent reported done shows in the faction state's queue, the install (the controller's gate and
//   backup).
//   Once the install is asked for, nothing more is bought, so the gate's count isn't restarted by a purchase.
// - Fail loudly: a purchase reported done that two faction state reads after it don't show queued is
//   `augmentationNotQueued` (an event, a log line, the dashboard's alert and the run report's failure).
// - The "Augmentations" switch, on by default (owner decision 48): off, nothing is bought or installed, and a cycle
//   under way is called off (what's bought stays queued, for the owner).
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationBuyOrder,
  augmentationCost,
  augmentationsSoldBy,
  chooseAugmentationsToBuy,
  FACTION_NAMES,
  type FactionState,
  factionReadingKind,
  factionReadingOf,
  type InstallCandidate,
  type InstallDecision,
  type InstallReason,
  type Intent,
  installDecision,
  intentId,
  isWorthInstalling,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
  type SlowSnapshotData,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { CLOUD_SERVER_PAYBACK_LIMIT_MS } from "./cloud-servers.ts";
import { bestWorkRate, workCandidates, workConditionsOf, workingPersonOf } from "./factions.ts";
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

/** How long the income is measured over: the slow snapshots' money sources across 10 minutes. */
export const AUGMENTATION_INCOME_WINDOW_MS = 10 * 60_000;
/**
 * Before an install is chosen, money is held back from cloud servers (A2, #194) only for an install projected within
 * this: A2's payback limit (`CLOUD_SERVER_PAYBACK_LIMIT_MS`, 15 minutes, decided in #213's review). A server bought now
 * pays itself back within it, so holding money any sooner would cost the income the install is waiting for.
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

/** A decision's figures as stored: Infinity (never) as null, which JSON can carry. */
export interface StoredWay {
  augmentation: string;
  faction: string;
  ms: number | null;
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
      sinceResetMs: number;
      rebuildMs: number;
      without: StoredWay | null;
      with: StoredWay | null;
      /** Nothing left at the joined factions, nothing reachable at a positive rate, or the next sooner installing. */
      reason: InstallReason;
    }
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
  /** The last decision's figures, or null. */
  decision: InstallDecision | null;
  /** Why nothing is asked for, or no install chosen, or null. */
  waitingFor: string | null;
  notQueued: NotQueued[];
  /**
   * The money held back from cloud servers (A2) for augmentations: Infinity while committed; before that, the set's
   * money only for an install projected within `AUGMENTATION_RESERVE_LOOKAHEAD_MS`, else 0.
   */
  reserve: number;
}

/** What the controller hands the rule each update. */
export interface AugmentationInputs {
  mediumData: MediumSnapshotData | null;
  /** When it arrived (the controller's clock), or null: purchases recorded since are taken off its money. */
  mediumAtMs: number | null;
  slowData: SlowSnapshotData | null;
  /** The game's time of the latest slow snapshot (its `gameTimeMs`), or null. */
  slowGameTimeMs: number | null;
  /** The intents the connected Agent's latest fast snapshot reports done. */
  doneIds: ReadonlySet<string>;
  /** The latest time the controller has seen (a channel event's), for the events. */
  nowMs: number | null;
  enabled: boolean;
  homeRamEnabled: boolean;
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
 * (`workingPersonOf`, #203), with the hacking experience and the money.
 */
function playerOf(mediumData: MediumSnapshotData) {
  const person = workingPersonOf(mediumData);
  const player = mediumData.player as { exp?: Record<string, unknown>; money?: unknown } | undefined;
  const hackingExp = player?.exp?.hacking;
  if (person === null || !isFiniteNumber(hackingExp) || !isFiniteNumber(player?.money)) return null;
  return { person, hackingExp, money: player.money };
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

const storedWay = (way: InstallDecision["without"]): StoredWay | null =>
  way === null ? null : { ...way, ms: Number.isFinite(way.ms) ? way.ms : null };

/** Why the install was chosen, in words, for the log and the report. */
export function describeReason(
  reason: InstallReason,
  {
    with: withInstall,
    without,
  }: { with: { ms: number | null } | null; without: { augmentation: string; ms: number | null } | null },
): string {
  if (reason === "nothing left") return "nothing else worth installing at the joined factions";
  if (reason === "nothing reachable")
    return "nothing else reachable at a joined faction's work (a reputation rate of 0)";
  return (
    `the next sooner installing (${formatEta(withInstall?.ms ?? null)} against ${formatEta(without?.ms ?? null)}, ` +
    `${without?.augmentation ?? "?"})`
  );
}

/** The intent buying `augmentation` from `faction` (`level` 1 but for NeuroFlux Governor). */
export function purchaseIntent(faction: string, augmentation: string, level: number): Intent {
  const args = { faction, augmentation, level };
  return { id: intentId("purchaseAugmentation", args), action: "purchaseAugmentation", args };
}

/** The augmentation rule (#210), as the controller runs it. */
export class AugmentationRule {
  readonly #store: TelemetryStore;
  readonly #log: (line: string) => void;
  readonly #emit: (event: AugmentationEvent) => void;
  /** The income's samples: the game's time, the money earned since the install, and that install. */
  #incomeSamples: { gameTimeMs: number; earned: number; lastAugReset: number }[] = [];
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
   * The money of each purchase recorded done, and when (#213 review): until a medium snapshot arrives after it, its
   * money is taken off the medium snapshot's, which was read before it.
   */
  #spent: { atMs: number; price: number }[] = [];
  /** The install asked for: nothing more is bought. Kept in the commit's note too. */
  #installing = false;
  #view: Omit<AugmentationsView, "enabled" | "notQueued"> = {
    waiting: true,
    committed: false,
    asking: null,
    set: [],
    setCost: 0,
    decision: null,
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
  }

  /** Whether the purchase asked for is among `doneIds`, not yet recorded: the controller updates at once then. */
  askedDone(doneIds: ReadonlySet<string>): boolean {
    const asked = this.#asked;
    return asked !== null && doneIds.has(asked.intent.id) && !this.#recorded.has(asked.intent.id);
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
    const { mediumData, mediumAtMs, slowData, slowGameTimeMs, doneIds, nowMs, enabled, homeRamEnabled } = inputs;
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
    this.#recordDone(doneIds, atMs);
    // Spending a medium snapshot that arrived after it already shows.
    if (mediumAtMs !== null) this.#spent = this.#spent.filter((each) => each.atMs > mediumAtMs);
    if (!enabled) {
      if (readAugmentationCycle(this.#store) !== null) this.#callOff(atMs, "the Augmentations switch turned off");
      return askNothing(null, { waiting: false, committed: false, reserve: 0, decision: null, set: [], setCost: 0 });
    }
    if (mediumData === null || slowData === null) return askNothing(null, { waiting: true });
    const resetInfo = resetInfoOf(slowData);
    if (resetInfo === null) return askNothing("the reset info in the Agent's slow snapshot", { waiting: false });
    const player = playerOf(mediumData);
    if (player === null) {
      return askNothing("the player's skills, experience, money and multipliers in the Agent's medium snapshot", {
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
      return this.#decide({ state, resetInfo, player, slowData, mediumData, slowGameTimeMs, atMs, homeRamEnabled });
    } catch (error) {
      return askNothing(`the snapshots as core knows the game (${(error as Error).message})`, { waiting: false });
    }
  }

  /** A slow snapshot: a reset; and once per snapshot, the income's sample and the faction state's read. */
  #sample(slowData: SlowSnapshotData, gameTimeMs: number | null, atMs: number): void {
    const lastAugReset = slowData.resetInfo?.lastAugReset;
    if (isFiniteNumber(lastAugReset) && this.#lastAugReset !== null && lastAugReset !== this.#lastAugReset) {
      // A new game: its purchases start afresh.
      this.#bought = [];
      this.#notQueued = [];
      this.#recorded.clear();
      this.#spent = [];
      this.#installing = false;
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
    }
    // A reset is judged on every slow snapshot; the income and the reads once per snapshot (by its game time).
    if (gameTimeMs === null || gameTimeMs === this.#sampledGameTimeMs) return;
    this.#sampledGameTimeMs = gameTimeMs;
    const earned = earnedOf(slowData);
    if (earned === null || !isFiniteNumber(lastAugReset)) {
      this.#incomeSamples = [];
    } else {
      this.#incomeSamples = this.#incomeSamples.filter((sample) => sample.lastAugReset === lastAugReset);
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
   * The money earned a second over the window, or null until it's a window long. The samples are the game's own count
   * since the install, so they're kept across the Agent's reconnects (#213 review): a reset (another `lastAugReset`)
   * starts them again.
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
  #recordDone(doneIds: ReadonlySet<string>, atMs: number): void {
    const asked = this.#asked;
    if (asked === null || !doneIds.has(asked.intent.id) || this.#recorded.has(asked.intent.id)) return;
    this.#recorded.add(asked.intent.id);
    this.#spent.push({ atMs, price: asked.price });
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
    atMs,
    homeRamEnabled,
  }: {
    state: FactionState;
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    player: NonNullable<ReturnType<typeof playerOf>>;
    slowData: SlowSnapshotData;
    mediumData: MediumSnapshotData;
    slowGameTimeMs: number | null;
    atMs: number;
    homeRamEnabled: boolean;
  }): AugmentationAsk {
    const { currentNode, ownedAugs, ownedSF } = resetInfo;
    // The queue: the faction state's, with each purchase reported done that it doesn't show yet, and each never shown
    // (`augmentationNotQueued`, alerted): asked for again, its done is already recorded, and it would be asked forever.
    const queue = [...state.queuedAugmentations];
    for (const bought of [
      ...this.#bought,
      ...this.#notQueued.map(({ augmentation, level }) => ({ augmentation, level })),
    ]) {
      const copies = queue.filter((name) => name === bought.augmentation).length;
      const shown =
        bought.augmentation === NEUROFLUX_GOVERNOR
          ? (ownedAugs[NEUROFLUX_GOVERNOR] ?? 0) + copies >= bought.level
          : copies > 0;
      if (!shown) queue.push(bought.augmentation);
    }
    this.#queue = queue;
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
    const income = this.#income();
    const cycle = readAugmentationCycle(this.#store);

    if (cycle === null) {
      if (slowGameTimeMs === null) {
        return this.#ask(null, {
          waitingFor: "the game's time in the Agent's slow snapshot",
          set: setView,
          setCost: set.money,
          reserve: 0,
          committed: false,
        });
      }
      // The time since the last install counts time the game was closed too, which earns less: a longer rebuild, and a
      // later install, the safe side.
      const sinceResetMs = Math.max(0, slowGameTimeMs - resetInfo.lastAugReset);
      /** The decision with `spare` money (and the set it covers), `laterMs` from now. */
      const decide = (spare: number, laterMs: number) => {
        const covered = laterMs === 0 ? set : chooseAugmentationsToBuy(reached, purchaseState, spare, hackingLevel);
        const installing = [...queue, ...covered.purchases.map((purchase) => purchase.name)];
        const decision = installDecision({
          sinceResetMs: sinceResetMs + laterMs,
          hackingLevel,
          hackingExp: player.hackingExp,
          installing,
          money: spare,
          incomePerSecond: income,
          candidates: this.#candidates({
            state,
            resetInfo,
            slowData,
            purchaseState,
            installing,
            reachedLeftOut: reached
              .filter((name) => isWorthInstalling(name) && !installing.includes(name))
              .map((augmentation) => {
                const faction = sellerOf(augmentation) as string;
                const reputationNeeded = augmentationCost(augmentation, purchaseState).reputation;
                return { faction, augmentation, reputation: reputationOf(faction), reputationNeeded };
              }),
            person: player.person,
            hackingLevel,
          }),
        });
        return { covered, installing, decision };
      };
      const { installing, decision } = decide(money, 0);
      // Held back from cloud servers only for an install projected within A2's payback limit: the decision with that
      // much more income, then (#213 review).
      let reserve = 0;
      if (!decision.install && income !== null && income > 0) {
        const ahead = decide(
          money + (income * AUGMENTATION_RESERVE_LOOKAHEAD_MS) / 1000,
          AUGMENTATION_RESERVE_LOOKAHEAD_MS,
        );
        if (ahead.decision.install) reserve = ahead.covered.money;
      }
      const view = { set: setView, setCost: set.money, decision, reserve, committed: false };
      if (!decision.install) {
        const why =
          decision.waitingFor ??
          (installing.length === 0
            ? "an augmentation worth installing that a joined faction's reputation and the money cover"
            : `the next augmentation to come no sooner by installing (${formatEta(decision.without?.ms ?? null)} ` +
              `carrying on, ${formatEta(decision.with?.ms ?? null)} installing)`);
        return this.#ask(null, { ...view, waitingFor: why });
      }
      writeAugmentationCycle(this.#store, { lastAugReset: resetInfo.lastAugReset, installing: false });
      this.#installing = false;
      const reason = decision.reason as InstallReason;
      this.#emit({
        type: AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
        atMs,
        set: setView,
        cost: set.money,
        queued: [...queue],
        sinceResetMs,
        rebuildMs: decision.rebuildMs,
        without: storedWay(decision.without),
        with: storedWay(decision.with),
        reason,
      });
      this.#log(
        `augmentations: install chosen, ${formatEta(sinceResetMs)} since the last: buying ` +
          `${setView.map((each) => each.augmentation).join(", ") || "nothing more"} (${formatMoney(set.money)}), ` +
          describeReason(reason, decision),
      );
    }

    // Committed: the set, home's RAM, NeuroFlux Governor, then the install (already asked for, a restarted brain's note
    // says: nothing more is bought).
    if (cycle?.installing === true) this.#installing = true;
    const committedView = { set: setView, setCost: set.money, reserve: Number.POSITIVE_INFINITY, committed: true };
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
      const unconfirmed = this.#bought.map((bought) => bought.augmentation);
      if (unconfirmed.length > 0) {
        return this.#ask(null, {
          ...committedView,
          waitingFor: `the faction state to show ${unconfirmed.join(", ")} queued, before the install`,
        });
      }
      if (queue.length === 0) {
        this.#callOff(atMs, "nothing was bought to install");
        return this.#ask(null, { committed: false, reserve: 0, waitingFor: null });
      }
      this.#installing = true;
      writeAugmentationCycle(this.#store, {
        lastAugReset: cycle?.lastAugReset ?? resetInfo.lastAugReset,
        installing: true,
      });
      this.#log(`augmentations: installing ${queue.length} queued (the gate, then a save backup first)`);
    }
    this.#asked = null;
    this.#view = {
      ...this.#view,
      ...committedView,
      asking: `installing ${queue.length} queued`,
      waitingFor: null,
      waiting: false,
    };
    return { intent: null, install: true, committed: true };
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

  /**
   * Each way to the next augmentation worth installing: A5's candidates (#203, `workCandidates`: worth working for at a
   * joined faction, not reached there), with the queue as the rule knows it, and the reached ones the set leaves out
   * (their money); each with its prerequisites owned or in the set. The rate is its faction's best work's (A5's
   * `bestWorkRate`, 0 for none), the money the set's and its own in buy order, and its price with nothing queued.
   */
  #candidates({
    state,
    resetInfo,
    slowData,
    purchaseState,
    installing,
    reachedLeftOut,
    person,
    hackingLevel,
  }: {
    state: FactionState;
    resetInfo: NonNullable<ReturnType<typeof resetInfoOf>>;
    slowData: SlowSnapshotData;
    purchaseState: AugmentationPurchaseState;
    /** What's queued and the set to buy. */
    installing: string[];
    reachedLeftOut: { faction: string; augmentation: string; reputation: number; reputationNeeded: number }[];
    person: WorkingPerson;
    hackingLevel: number;
  }): InstallCandidate[] {
    const conditions = workConditionsOf(resetInfo, slowData);
    const rateOf = (name: string) => {
      const faction = state.joined.find((each) => each.name === name);
      return faction === undefined ? 0 : (bestWorkRate(person, faction, conditions)?.perSecond ?? 0);
    };
    const afterSet = { installed: purchaseState.installed, queued: [...purchaseState.queued, ...installing] };
    const installed: Record<string, number> = { ...purchaseState.installed };
    for (const name of installing) installed[name] = name === NEUROFLUX_GOVERNOR ? (installed[name] ?? 0) + 1 : 1;
    const afterInstall: AugmentationPurchaseState = { ...purchaseState, installed, queued: [] };
    const toBuy = installing.filter((name) => !purchaseState.queued.includes(name));
    const ways = [
      ...workCandidates({ ...state, queuedAugmentations: [...purchaseState.queued] }, resetInfo, hackingLevel),
      ...reachedLeftOut,
    ];
    const candidates: InstallCandidate[] = [];
    for (const { faction, augmentation, reputation, reputationNeeded } of ways) {
      if (installing.includes(augmentation) || missingPrerequisites(augmentation, afterSet).length > 0) continue;
      candidates.push({
        augmentation,
        faction,
        reputation,
        reputationNeeded,
        reputationPerSecond: rateOf(faction),
        costAfterSet: purchaseSequenceCost(augmentationBuyOrder([...toBuy, augmentation]), purchaseState).money,
        priceAfterInstall: augmentationCost(augmentation, afterInstall).money,
      });
    }
    return candidates;
  }
}
