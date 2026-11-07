// The run report (#185, owner decision 45): what a run did and what went wrong, from the store alone, for a person (and
// Claude) to read after a live run instead of a manual smoke test. Read-only: it records nothing, and reads only what
// the brain already stores (snapshots, events, and the hack loop's and augmentations' switches), in one read
// transaction, folding the snapshots row by row so a long run's window never sits in memory whole.
import {
  type FactionState,
  type FastSnapshotData,
  factionStateOf,
  HACKER_FACTION_SERVERS,
  type HandledDialog,
  type IntentOutcome,
  type MediumSnapshotData,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  type StaticSnapshotData,
  type WorkOutcome,
} from "@bitburner-agent/core";
import {
  AUGMENTATION_EVENT_KINDS,
  AugmentationTimeline,
  BEFORE_FIRST_SLOW,
  donationStatus,
} from "./augmentation-report.ts";
import { AUGMENTATION_INSTALL_SENT_EVENT_KIND, readAugmentationsEnabled } from "./augmentations.ts";
import { BackdoorTimeline } from "./backdoors.ts";
import { batcherSection, whoHacked } from "./batcher-report.ts";
import {
  type ClockIncident,
  type FastSnapshotTime,
  findClockIncidents,
  incidentLines,
  type SnapshotTime,
  WeakenTimes,
} from "./clock-incidents.ts";
import { cloudServerPrice } from "./cloud-servers.ts";
import { BitNodeCycles } from "./cycle-report.ts";
import {
  BACKDOOR_OVERDUE_AFTER_MS,
  INCOME_STALLED_AFTER_MS,
  INSTALL_NOT_RESTARTED_AFTER_MS,
  INTENT_STUCK_AFTER_TRIES,
} from "./dashboard/alerts.ts";
import { BRAIN_STARTED_EVENT_KIND } from "./dashboard/status.ts";
import { FACTION_STATE_UNREAD_AFTER, factionStatusOf } from "./faction-state.ts";
import {
  describeChoice,
  FACTION_WORK_CHOSEN_EVENT_KIND,
  FACTION_WORK_STALLED_AFTER_MS,
  FACTION_WORK_STOPPED_EVENT_KIND,
  FactionWorkTimeline,
  SLOW_SNAPSHOT_GAP_MS,
} from "./factions.ts";
import {
  countsOf,
  DEFAULT_GAP_THRESHOLD_MS,
  describeCounts,
  describePageHeap,
  findGaps,
  formatDuration,
  formatIsoTime,
  formatSeconds,
  type Gap,
  plural,
} from "./gap-report.ts";
import { hackLoopHosts, readHackLoopEnabled } from "./hack-loop.ts";
import { HackingFold } from "./hacking-ceiling.ts";
import {
  CITY_GROUP_CHOSEN_EVENT_KIND,
  INVITATION_TRAVEL_EVENT_KIND,
  INVITATION_WAITING_EVENT_KIND,
  invitationHealthLines,
  invitationLines,
} from "./invitations.ts";
import {
  MESSAGE_REFUSED_EVENT_KIND,
  RESTART_FELL_BACK_EVENT_KIND,
  WORK_PROMOTION_EVENT_KIND,
} from "./record-channel-events.ts";
import {
  describeThinning,
  STORE_THINNED_EVENT_KIND,
  STORE_THINNING_FAILED_EVENT_KIND,
  type StoreThinning,
} from "./store-thinning.ts";
import { RELAUNCH_EVENT_KIND, SUPERVISION_GAVE_UP_EVENT_KIND } from "./supervision.ts";
import { type Environment, isThinnedReading, type StoredEvent, type TelemetryStore } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";
import { WORLD_DAEMON_EVENT_KINDS, WorldDaemonFold } from "./world-daemon-report.ts";

/** An Agent disconnect with no reconnect within this is a failure, unless the run ended there. */
export const RECONNECT_WITHIN_MS = 60_000;
/**
 * The longest heartbeat gap a reload explains (#240): a destroy or an install sent (the brain's or yours), or a deploy.
 * Up to it, shown as expected, not counted. What the game does: an install kills every script
 * (`Augmentation/AugmentationHelpers.ts:76`); a destroy does through the page at the BitVerse
 * (`ui/GameRoot.tsx:256-257`) and again entering the next BitNode (`RedPill.tsx:60`), and through Singularity as it
 * enters it
 * (`NetscriptFunctions/Singularity.ts:1191`). Singularity starts the next Agent 500 ms on (`:210`, `:1192`); the page's
 * restart timer once the Terminal is back: after the BitVerse's cinematic and portal for a destroy, and into BitNode 6
 * after Bladeburner's cinematic too, typed out line by line (`Bladeburner/ui/BladeburnerCinematic.tsx:9-36`, about 15 s
 * more). A deploy restarts the Agent alone. Run #3's gaps were 6.1 s (a deploy), 9.5 s and 13.1 s (destroys), its
 * installs' about 4.5 s: a minute is over 4 times the longest, BN6's fits, and it's a disconnect's own allowance
 * (`RECONNECT_WITHIN_MS`). Longer, something besides the reload held it up: a failure.
 */
export const RELOAD_GAP_BOUND_MS = 60_000;
/**
 * How long before a gap's start a destroy or an install sent explains it (#240). A destroy goes out, the Agent's next
 * round (2 s) starts its worker, and the worker types the hops and the backdoor (about 3 s at its required level)
 * before the BitVerse kills it; an install's clicks are quicker. Run #3's destroys went out 4.4 s and 4.7 s before
 * their gaps. A round later than that is caught by the reset intent the Agent held at the gap's start.
 */
export const RELOAD_LEAD_MS = 10_000;
/** A fast snapshot late, or in flight as an event is recorded: its round runs its workers first. */
const RELOAD_SLACK_MS = 1_000;
/**
 * How far into a gap a reload's event may be and still explain it: one fast snapshot's period and `RELOAD_SLACK_MS`.
 * The brain tells the Agent to restart onto a deploy as it records `deployed`, so the old Agent's last snapshot is
 * about a period before (run #3's, 0.4 s). A deploy later in a gap followed it: a reload of the game's own connects RFA
 * again, which may deploy.
 */
export const RELOAD_LAG_MS = SNAPSHOT_TIER_PERIOD_MS.fast + RELOAD_SLACK_MS;
/** A kind of event a reload follows (#240): what restarts, the event in a few words, and how long before a gap. */
interface ReloadKind {
  restarting: string;
  event: string;
  leadMs: number;
}
const RELOAD_KINDS: Record<string, ReloadKind> = {
  [BITNODE_DESTROY_SENT_EVENT_KIND]: {
    restarting: "the game reloading",
    event: "a destroy sent",
    leadMs: RELOAD_LEAD_MS,
  },
  [AUGMENTATION_INSTALL_SENT_EVENT_KIND]: {
    restarting: "the game reloading",
    event: "an install sent",
    leadMs: RELOAD_LEAD_MS,
  },
  // A deploy only `RELOAD_SLACK_MS` before: the old Agent reporting later than that, its gap is a new Agent's death.
  deployed: { restarting: "the Agent restarting", event: "a deploy", leadMs: RELOAD_SLACK_MS },
};
/** Restarts in a gap a reload doesn't explain: the brain's own, or the game relaunched (#240's review). */
const RESTARTS_BESIDES_A_RELOAD = [BRAIN_STARTED_EVENT_KIND, RELAUNCH_EVENT_KIND, "supervisionFailed"];
/** How far before the window section 1 looks for an earlier brain start, to say the window may not be the whole run. */
export const EARLIER_START_LOOKBACK_MS = 24 * 60 * 60_000;
/** How much of a handled dialog's text the report quotes. */
const DIALOG_QUOTE_LENGTH = 60;
/** How much of a blocking dialog's text a failure line quotes. */
const BLOCKING_QUOTE_LENGTH = 120;
/** The intents that reset the game, so a gap after one is expected (#164, #175). */
const RESET_ACTIONS = ["installAugmentations", "destroyBitNode"];
/** The events that explain a silence: the brain, the game or the Agent starting or stopping. */
const RESTART_EVENT_KINDS = [
  BRAIN_STARTED_EVENT_KIND,
  RELAUNCH_EVENT_KIND,
  "agentDisconnected",
  "agentConnected",
  RESTART_FELL_BACK_EVENT_KIND,
  "deployed",
  "deployFailed",
  "supervisionFailed",
  SUPERVISION_GAVE_UP_EVENT_KIND,
];
/** The events that are failures in themselves. */
const FAILURE_EVENT_KINDS = [
  "deployFailed",
  "versionDrift",
  SUPERVISION_GAVE_UP_EVENT_KIND,
  RESTART_FELL_BACK_EVENT_KIND,
  MESSAGE_REFUSED_EVENT_KIND,
];

export interface RunWindow {
  environment: Environment;
  sinceMs: number;
  untilMs: number;
}

export interface RunReport {
  /** The whole report, the verdict last. */
  text: string;
  /** One line per failure; none is PASS, or WARN with warnings. */
  failures: string[];
  /**
   * One line per warning (owner decision 55): what went wrong but isn't yet a failure. Something outside the brain
   * that was put right by itself (#241: a batcher out of step after a clock step or page stall, batching again, or not
   * yet seen to), or a batcher an hour or more on poor targets, short of 2 hours in its cycle (#275). WARN with no
   * failure; listed after FAIL's.
   */
  warnings: string[];
}

/** When the newest run of the brain started (its `brainStarted` event), or null if it never has. */
export function newestBrainStartMs(store: TelemetryStore, environment: Environment): number | null {
  const [started] = store.recentEvents({ environment, limit: 1, kinds: [BRAIN_STARTED_EVENT_KIND] });
  return started?.atMs ?? null;
}

// --- Income stalls ----------------------------------------------------------------------------------------------------

/** A stretch with no rise in money, from the last rise (or the first) to the next rise, or the last snapshot. */
export interface IncomeStall {
  fromMs: number;
  toMs: number;
  lengthMs: number;
  moneyFrom: number;
  moneyTo: number;
  /** Still stalled at the last snapshot: no rise ended it. */
  ongoing: boolean;
}

interface MoneyPoint {
  atMs: number;
  money: number;
}

/**
 * Each stretch of `thresholdMs` or more, after money first rose, in which it didn't rise again: a purchase lowers it,
 * which isn't a rise, and the next rise ends the stretch. `points` are in time order.
 */
export function findIncomeStalls(points: MoneyPoint[], thresholdMs: number): IncomeStall[] {
  const stalls: IncomeStall[] = [];
  let lastRise: MoneyPoint | null = null;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1] as MoneyPoint;
    const point = points[index] as MoneyPoint;
    if (point.money <= previous.money) continue;
    if (lastRise !== null && point.atMs - lastRise.atMs >= thresholdMs) {
      stalls.push({ ...stallBetween(lastRise, previous), toMs: point.atMs, lengthMs: point.atMs - lastRise.atMs });
    }
    lastRise = point;
  }
  const last = points.at(-1);
  if (lastRise !== null && last !== undefined && last.atMs - lastRise.atMs >= thresholdMs) {
    stalls.push({ ...stallBetween(lastRise, last), ongoing: true });
  }
  return stalls;
}

function stallBetween(from: MoneyPoint, to: MoneyPoint): IncomeStall {
  return {
    fromMs: from.atMs,
    toMs: to.atMs,
    lengthMs: to.atMs - from.atMs,
    moneyFrom: from.money,
    moneyTo: to.money,
    ongoing: false,
  };
}

// --- The hack loop's target, inferred ---------------------------------------------------------------------------------

/** A stretch of medium snapshots in which the same servers' money or security moved. */
export interface MovedServers {
  servers: string[];
  fromMs: number;
  toMs: number;
}

/**
 * Where the window's installs and destroys are (#245): each cycle's start by the brain's clock, as 2b estimates it, and
 * each `lastAugReset` the slow snapshots show, on the game's own clock. A snapshot's game time is the game's clock too,
 * so the second needs no estimate: a clock offset can't move it past the snapshot it falls before.
 */
export interface Resets {
  brainMs: readonly number[];
  gameMs: readonly number[];
}

/** A snapshot's two times: its receipt (the brain's clock) and the game's time it was taken. */
interface SnapshotMoment {
  atMs: number;
  gameTimeMs?: number;
}

/** Whether a reset is between two snapshots, by either clock: after `before`, at or before `after`. */
function resetBetween(resets: Resets, before: SnapshotMoment, after: SnapshotMoment): boolean {
  if (resets.brainMs.some((resetMs) => resetMs > before.atMs && resetMs <= after.atMs)) return true;
  const [fromMs, toMs] = [before.gameTimeMs, after.gameTimeMs];
  if (!isNumber(fromMs) || !isNumber(toMs)) return false;
  return resets.gameMs.some((resetMs) => resetMs > fromMs && resetMs <= toMs);
}

/**
 * The hack loop's target over time, inferred, one medium snapshot at a time: a server's money and security change only
 * when a script hacks, grows or weakens it, so the game's servers whose money or security moved between consecutive
 * medium snapshots are the ones being worked. An inference, not a record: the owner's own scripts move servers too.
 * Stretches where nothing moved don't end one. `ignored` are the player's own servers (home, purchased). Two snapshots
 * with a reset between them (`resetBetween`: an install or a destroy, which puts every server's money and security
 * back) aren't compared (#245): that move is the reset's, every server at once, not the hack loop's.
 */
class HackTargetInference {
  readonly stretches: MovedServers[] = [];
  #before: Map<string, string> | null = null;
  #beforeMoment: SnapshotMoment = { atMs: Number.NEGATIVE_INFINITY };
  readonly #ignored: ReadonlySet<string>;
  readonly #resets: Resets;

  constructor(ignored: ReadonlySet<string>, resets: Resets = { brainMs: [], gameMs: [] }) {
    this.#ignored = ignored;
    this.#resets = resets;
  }

  add(moment: SnapshotMoment, data: MediumSnapshotData): void {
    const [before, beforeMoment] = [this.#before, this.#beforeMoment];
    const after = serverStates(data);
    this.#before = after;
    this.#beforeMoment = moment;
    if (before === null || resetBetween(this.#resets, beforeMoment, moment)) return;
    const moved = [...after]
      .filter(
        ([hostname, state]) => !this.#ignored.has(hostname) && before.has(hostname) && before.get(hostname) !== state,
      )
      .map(([hostname]) => hostname)
      .sort();
    if (moved.length === 0) return;
    const current = this.stretches.at(-1);
    if (current && current.servers.join() === moved.join()) current.toMs = moment.atMs;
    else this.stretches.push({ servers: moved, fromMs: moment.atMs, toMs: moment.atMs });
  }
}

/** `HackTargetInference` over a list of medium snapshots. */
export function inferHackTargets(
  medium: (SnapshotMoment & { data: MediumSnapshotData })[],
  ignored: ReadonlySet<string>,
  resets?: Resets,
): MovedServers[] {
  const inference = new HackTargetInference(ignored, resets);
  for (const { data, ...moment } of medium) inference.add(moment, data);
  return inference.stretches;
}

/**
 * The batcher's target as its health in the fast snapshots says it, a stretch at a time (#245): one target from its
 * first look to its last, ended by another target, a reset (`resetBetween`), or no look naming it for more than the
 * heartbeat's gap threshold (the batcher stopped, or the Agent gone): the same target after one is another stretch.
 */
class BatcherTargets {
  readonly stretches: BatcherTarget[] = [];
  #last: SnapshotMoment | null = null;
  /** Whether the last record named a target, or followed one that did: a thinned one goes on only after one. */
  #lastNamed = false;
  readonly #resets: Resets;

  constructor(resets: Resets) {
    this.#resets = resets;
  }

  add(moment: SnapshotMoment, batcher: unknown): void {
    const target = isObject(batcher) ? fieldsOf(batcher).target : undefined;
    this.#lastNamed = typeof target === "string";
    if (typeof target !== "string") return;
    const [current, last] = [this.stretches.at(-1), this.#last];
    this.#last = moment;
    const goesOn =
      current?.target === target &&
      last !== null &&
      moment.atMs - last.atMs <= DEFAULT_GAP_THRESHOLD_MS &&
      !resetBetween(this.#resets, last, moment);
    if (goesOn) current.toMs = moment.atMs;
    else this.stretches.push({ target, fromMs: moment.atMs, toMs: moment.atMs });
  }

  /**
   * A thinned fast snapshot (#283): the Agent reporting, what its health said unknown. A stretch goes on across it, as
   * across a look naming its target, so thinned minutes aren't each a stretch; one never starts at it.
   */
  heard(moment: SnapshotMoment): void {
    const last = this.#last;
    const goesOn =
      this.#lastNamed &&
      last !== null &&
      moment.atMs - last.atMs <= DEFAULT_GAP_THRESHOLD_MS &&
      !resetBetween(this.#resets, last, moment);
    this.#lastNamed = goesOn;
    if (goesOn) this.#last = moment;
  }
}

/** Each server's money and security, as one string to compare. */
function serverStates(data: MediumSnapshotData | undefined): Map<string, string> {
  const servers = Array.isArray(data?.servers) ? data.servers : [];
  return new Map(
    servers
      .filter((server) => typeof server?.hostname === "string")
      .map((server) => [server.hostname, `${server.moneyAvailable}/${server.hackDifficulty}`]),
  );
}

// --- The faction state (#197) -----------------------------------------------------------------------------------------

/** A faction's reputation and favour, at its first and last reading in the window. */
interface FactionChange {
  first: { reputation: number; favor: number };
  last: { reputation: number; favor: number };
}

/** A stretch of slow snapshots in a row whose faction state couldn't be read, for the same reason. */
interface UnreadStretch {
  problem: string;
  backend: string | null;
  fromMs: number;
  toMs: number;
  count: number;
}

/**
 * The faction state over the window's slow snapshots, one at a time: each faction's first and last reading, when each
 * invitation was first seen, the first and last queue, and the stretches it couldn't be read.
 */
class FactionStateFolding {
  readonly factions = new Map<string, FactionChange>();
  readonly invitations = new Map<string, number>();
  firstQueue: string[] | null = null;
  lastQueue: string[] | null = null;
  readonly unread: UnreadStretch[] = [];
  #current: UnreadStretch | null = null;
  /** Slow snapshots not read, but not a problem: skipped (no sidebar), and from an older Agent (no reading). */
  skipped = 0;
  absent = 0;
  /** Read, but with the page not put back as found: how many, and the last problem. */
  notRestored = 0;
  lastNotRestored: string | null = null;

  add(atMs: number, data: SlowSnapshotData): void {
    const { kind, backend, problem } = factionStatusOf(data);
    if (kind === "skipped") {
      // Neither ends a stretch of unread ones nor adds to it.
      this.skipped += 1;
    } else if (kind !== "unread") {
      this.#current = null;
      if (kind === "absent") this.absent += 1;
      if (kind === "readPageNotRestored") {
        this.notRestored += 1;
        this.lastNotRestored = problem;
      }
    } else if (this.#current !== null) {
      // In a row, whatever each one's reason: the latest's is shown.
      this.#current.toMs = atMs;
      this.#current.count += 1;
      this.#current.problem = problem ?? this.#current.problem;
      this.#current.backend = backend;
    } else {
      this.#current = { problem: problem ?? "", backend, fromMs: atMs, toMs: atMs, count: 1 };
      this.unread.push(this.#current);
    }
    const state: FactionState | null = factionStateOf(data);
    if (state === null) return;
    for (const { name, reputation, favor } of state.joined) {
      const now = { reputation, favor };
      const known = this.factions.get(name);
      if (known) known.last = now;
      else this.factions.set(name, { first: now, last: now });
    }
    for (const name of state.invitations) if (!this.invitations.has(name)) this.invitations.set(name, atMs);
    this.firstQueue ??= state.queuedAugmentations;
    this.lastQueue = state.queuedAugmentations;
  }
}

// --- Reading the store ------------------------------------------------------------------------------------------------

/**
 * A fast snapshot's times, its degraded tiers and its page heap: every one's, a thinned one's too (#283), for the time
 * checks (the heartbeat, clock steps and page stalls, the page heap, the run's end).
 */
interface FastTime extends FastSnapshotTime {
  pageHeapUsedBytes: unknown;
}

/**
 * What the report keeps of each whole fast snapshot: not the home processes, the bulk of it; never a thinned one's
 * (#283), whose stub says none of it.
 */
interface FastPoint {
  atMs: number;
  /** The game's time it was taken (#241). */
  gameTimeMs: number;
  /** The Agent that sent it (#286): a new one, after a reset say, holds a new intent list. */
  agentSessionId: string;
  /** The tiers it says failed last round (#241: a medium snapshot retried is no page stall). */
  degradedTiers: unknown;
  pageHeapUsedBytes: unknown;
  homeRamUsed: unknown;
  intents: IntentOutcome[];
  blocking: unknown;
  /** Absent from an older Agent. */
  work: WorkOutcome | null | undefined;
  /** The batcher's health (#205); absent from an older Agent. */
  batcher: unknown;
  /** The batcher's deploy worker's last report while wanted (#211); absent from an older Agent. */
  batcherDeploy: unknown;
}

/** A stretch of the batcher's health naming one target (#245): from its first look to its last, before another. */
interface BatcherTarget {
  target: string;
  fromMs: number;
  toMs: number;
}

/** A cloud server bought (`fromRam` null) or upgraded (#194), as the medium snapshots show it. */
export interface CloudServerChange {
  atMs: number;
  hostname: string;
  fromRam: number | null;
  toRam: number;
  /** The fleet, the cloud servers the medium snapshots show, in the snapshot before this one and in this one (#245). */
  fleetBefore: CloudFleet;
  fleetAfter: CloudFleet;
}

/** How many cloud servers, and their RAM in all. */
interface CloudFleet {
  count: number;
  ram: number;
}

/**
 * Each cloud server bought or upgraded in the window, in order: one of `cloudServers` (the slow snapshots' lists, the
 * game's word) that a medium snapshot shows first after the window's first, or with more RAM than the one before. One
 * a medium snapshot no longer shows is forgotten: an install deletes them (`Prestige.ts:72-74`), so one bought again
 * after it is bought again.
 */
class CloudServerChanges {
  readonly changes: CloudServerChange[] = [];
  readonly #ram = new Map<string, number>();
  #first = true;
  readonly #cloudServers: ReadonlySet<string>;

  constructor(cloudServers: ReadonlySet<string>) {
    this.#cloudServers = cloudServers;
  }

  #fleet(): CloudFleet {
    return { count: this.#ram.size, ram: [...this.#ram.values()].reduce((total, ram) => total + ram, 0) };
  }

  add(atMs: number, data: MediumSnapshotData): void {
    const seen = new Set<string>();
    const fleetBefore = this.#fleet();
    const changes: Omit<CloudServerChange, "fleetBefore" | "fleetAfter">[] = [];
    for (const server of Array.isArray(data?.servers) ? data.servers : []) {
      if (typeof server?.hostname !== "string" || !this.#cloudServers.has(server.hostname)) continue;
      if (!isNumber(server.maxRam)) continue;
      const before = this.#ram.get(server.hostname);
      if (before === undefined && !this.#first) {
        changes.push({ atMs, hostname: server.hostname, fromRam: null, toRam: server.maxRam });
      } else if (before !== undefined && server.maxRam > before) {
        changes.push({ atMs, hostname: server.hostname, fromRam: before, toRam: server.maxRam });
      }
      this.#ram.set(server.hostname, server.maxRam);
      seen.add(server.hostname);
    }
    for (const hostname of [...this.#ram.keys()]) if (!seen.has(hostname)) this.#ram.delete(hostname);
    this.#first = false;
    const fleetAfter = this.#fleet();
    for (const change of changes) this.changes.push({ ...change, fleetBefore, fleetAfter });
  }
}

/**
 * Section 2's figures for one BitNode (#244): its first and last snapshots of each tier and its faction state, so its
 * progress is first → last within it, never across a destroy. One, the BitNode unknown, with no slow snapshot.
 */
interface ProgressSegment {
  mediumFirst?: MediumSnapshotData;
  mediumLast?: MediumSnapshotData;
  slowFirst?: SlowSnapshotData;
  slowLast?: SlowSnapshotData;
  homeRamUsedFirst?: unknown;
  homeRamUsedLast?: unknown;
  fastSeen: boolean;
  factionState: FactionStateFolding;
}

/** What the report reads from the store for a window, folded as it's read. */
interface RunFacts extends RunWindow {
  events: StoredEvent[];
  /** The reloads' events in the `RELOAD_LEAD_MS` before the window (#240): one can explain a gap at its start. */
  reloadsBefore: StoredEvent[];
  /** Every fast snapshot's times, thinned or not (#283): the time checks. */
  fastTimes: FastTime[];
  /** The whole fast snapshots, each what it says: the content checks. */
  fast: FastPoint[];
  /** The snapshots in the window thinned to their times (#283), by tier; the newest, or null with none. */
  thinned: { fast: number; medium: number; lastMs: number | null };
  mediumFirst: MediumSnapshotData | undefined;
  mediumLast: MediumSnapshotData | undefined;
  /** The medium snapshots' times (#241), for clock steps and page stalls: every one's, a thinned one's too (#283). */
  mediumTimes: SnapshotTime[];
  /** A weaken's time on a target over the window (#241), to put the batcher's desyncs down to an incident. */
  weakenTimes: WeakenTimes;
  /** The medium snapshots' money, where it's a number. */
  money: MoneyPoint[];
  targets: MovedServers[];
  /** The batcher's target as its health in the fast snapshots says, each stretch of it (#245); none before #205. */
  batcherTargets: BatcherTarget[];
  /** The hacker factions' servers' backdoors over the medium snapshots (#195). */
  backdoors: BackdoorTimeline;
  slowFirst: SlowSnapshotData | undefined;
  slowLast: SlowSnapshotData | undefined;
  /** The installs' times, the slow snapshots' `lastAugReset`s: section 6 joins no move across one (#237's review). */
  resetsMs: number[];
  /** The faction state over the slow snapshots (#197). */
  factionState: FactionStateFolding;
  /** The joins and the brain's faction work (#203), over the events and the medium and slow snapshots. */
  factionWork: FactionWorkTimeline;
  /** The installs over the slow snapshots (#210), for the augmentation rule's events. */
  augmentations: AugmentationTimeline;
  /** The hacking experience rate over the medium snapshots (#215), for the World Daemon's ETA. */
  worldDaemon: WorldDaemonFold;
  snapshotCount: number;
  /** Home and the player's purchased servers (static and slow snapshots): not the hack loop's targets. */
  playersServers: Set<string>;
  /** The newest static snapshot by the window's end (before it, if none in it): which servers are the game's. */
  staticLast: StaticSnapshotData | undefined;
  /** Cloud servers bought or upgraded (#194). */
  cloudServerChanges: CloudServerChange[];
  /** The dashboard's switch, now: the store keeps no history of it. */
  hackLoopEnabled: boolean;
  /** The Augmentations switch, now (#222): likewise. */
  augmentationsEnabled: boolean;
  /** The newest brain start in the day before the window, if any: the window may not be the whole run. */
  earlierBrainStartMs: number | null;
  /** Hacking income against the ceiling (#196). */
  hacking: HackingFold;
  /** The BitNodes and augmentation cycles (#244), and section 2's figures for each BitNode, in order. */
  cycles: BitNodeCycles;
  segments: { index: number; segment: ProgressSegment }[];
}

const isObject = (data: unknown): data is object => data !== null && typeof data === "object";

function readFacts(store: TelemetryStore, window: RunWindow): RunFacts {
  return store.readTransaction(() => {
    function* ofTier<Data>(
      tier: string,
    ): Generator<{ atMs: number; gameTimeMs: number; agentSessionId: string; data: Data }> {
      for (const snapshot of store.iterateSnapshotsInWindow({ ...window, tier })) {
        if (isObject(snapshot.data)) {
          const { receivedAtMs: atMs, gameTimeMs, agentSessionId } = snapshot;
          yield { atMs, gameTimeMs, agentSessionId, data: snapshot.data as Data };
        }
      }
    }
    let snapshotCount = 0;
    // The player's servers first, from the static and slow snapshots, so the medium ones can be read in one pass.
    const playersServers = new Set(["home"]);
    const hacking = new HackingFold(playersServers);
    // The servers' fixed figures for the hacking ceilings, as of the window's start: the Agent sends them once (#196).
    const staticBefore = store.latestSnapshotBefore({ ...window, tier: "static", beforeMs: window.sinceMs });
    const weakenTimes = new WeakenTimes();
    if (isObject(staticBefore?.data)) {
      hacking.addStatic(staticBefore.receivedAtMs, staticBefore.data as StaticSnapshotData);
      weakenTimes.addStatic(staticBefore.receivedAtMs, staticBefore.data as StaticSnapshotData);
    }
    // The newest static snapshot, for which servers are the game's: the hack loop's hosts (#194).
    let staticLast = isObject(staticBefore?.data) ? (staticBefore.data as StaticSnapshotData) : undefined;
    const backdoors = new BackdoorTimeline();
    for (const { atMs, data } of ofTier<StaticSnapshotData>("static")) {
      snapshotCount++;
      staticLast = data;
      hacking.addStatic(atMs, data);
      weakenTimes.addStatic(atMs, data);
      backdoors.addStatic(atMs, data);
      for (const server of Array.isArray(data.servers) ? data.servers : []) {
        if (server?.purchasedByPlayer === true) playersServers.add(server.hostname);
      }
    }
    const events = store.eventsInWindow(window);
    const factionWork = new FactionWorkTimeline(events, BRAIN_STARTED_EVENT_KIND);
    // The day before the window: an earlier brain start (section 1), and the install decisions (#244 review: a window
    // opening after an install was chosen doesn't judge its buying).
    const dayBefore = store.eventsInWindow({
      environment: window.environment,
      sinceMs: window.sinceMs - EARLIER_START_LOOKBACK_MS,
      untilMs: window.sinceMs - 1,
    });
    // The BitNodes and cycles (#244): the slow snapshots say where each starts, then each snapshot is put in its own,
    // or (-1) before the first BitNode's start, or with none known.
    const cycles = new BitNodeCycles(events, window, dayBefore);
    const segments = new Map<number, ProgressSegment>();
    const segmentAt = (index: number): ProgressSegment => {
      let segment = segments.get(index);
      if (segment === undefined) {
        segment = { fastSeen: false, factionState: new FactionStateFolding() };
        segments.set(index, segment);
      }
      return segment;
    };
    let slowFirst: SlowSnapshotData | undefined;
    let slowLast: SlowSnapshotData | undefined;
    const resetsMs = new Set<number>();
    const cloudServers = new Set<string>();
    const factionState = new FactionStateFolding();
    const augmentations = new AugmentationTimeline();
    for (const { atMs, gameTimeMs, data } of ofTier<SlowSnapshotData>("slow")) {
      snapshotCount++;
      hacking.addSlow(atMs, data);
      slowFirst ??= data;
      slowLast = data;
      const lastAugReset = data.resetInfo?.lastAugReset;
      if (typeof lastAugReset === "number" && Number.isFinite(lastAugReset)) resetsMs.add(lastAugReset);
      factionState.add(atMs, data);
      cycles.addSlow(atMs, gameTimeMs, data);
      const segment = segmentAt(cycles.bitNodes.length - 1);
      segment.slowFirst ??= data;
      segment.slowLast = data;
      segment.factionState.add(atMs, data);
      factionWork.addSlow(atMs, data);
      augmentations.addSlow(atMs, data, gameTimeMs);
      for (const name of namesOf(data.purchasedServers)) {
        playersServers.add(name);
        cloudServers.add(name);
      }
    }
    let mediumFirst: MediumSnapshotData | undefined;
    let mediumLast: MediumSnapshotData | undefined;
    const money: MoneyPoint[] = [];
    // The slow snapshots are read: where each reset is (#245), by 2b's estimate and on the game's clock (each
    // `lastAugReset`: an install's, and a destroy's too, `PlayerObjectGeneralMethods.ts:126`).
    const resets: Resets = { brainMs: cycles.resetsMs(), gameMs: [...resetsMs] };
    const inference = new HackTargetInference(playersServers, resets);
    const cloudServerChanges = new CloudServerChanges(cloudServers);
    const worldDaemon = new WorldDaemonFold();
    const mediumTimes: SnapshotTime[] = [];
    const thinned = { fast: 0, medium: 0, lastMs: null as number | null };
    for (const { atMs, gameTimeMs, data } of ofTier<MediumSnapshotData>("medium")) {
      mediumTimes.push({ atMs, gameTimeMs });
      snapshotCount++;
      // A thinned one's time is all it says (#283): the rest read the whole ones, one a minute there.
      if (isThinnedReading(data)) {
        thinned.medium++;
        thinned.lastMs = Math.max(thinned.lastMs ?? atMs, atMs);
        continue;
      }
      worldDaemon.addMedium(atMs, data);
      weakenTimes.addMedium(atMs, data);
      mediumFirst ??= data;
      mediumLast = data;
      cycles.addMedium(atMs, data);
      const segment = segmentAt(cycles.bitNodeIndexAt(atMs));
      segment.mediumFirst ??= data;
      segment.mediumLast = data;
      const playerMoney = playerOf(data).money;
      if (typeof playerMoney === "number") money.push({ atMs, money: playerMoney });
      inference.add({ atMs, gameTimeMs }, data);
      cloudServerChanges.add(atMs, data);
      hacking.addMedium(atMs, data);
      backdoors.addMedium(atMs, data);
      factionWork.addMedium(atMs, data);
      augmentations.addMedium(atMs, data);
    }
    const fast: FastPoint[] = [];
    const fastTimes: FastTime[] = [];
    const batcherTargets = new BatcherTargets(resets);
    for (const { atMs, gameTimeMs, agentSessionId, data } of ofTier<Partial<FastSnapshotData>>("fast")) {
      snapshotCount++;
      const { degradedTiers, pageHeapUsedBytes } = data;
      fastTimes.push({ atMs, gameTimeMs, degradedTiers, pageHeapUsedBytes });
      if (isThinnedReading(data)) {
        thinned.fast++;
        thinned.lastMs = Math.max(thinned.lastMs ?? atMs, atMs);
        batcherTargets.heard({ atMs, gameTimeMs });
        // The BitNode's last record: its time alone.
        cycles.addFast(atMs, gameTimeMs, undefined);
        continue;
      }
      batcherTargets.add({ atMs, gameTimeMs }, data.batcher);
      cycles.addFast(atMs, gameTimeMs, data.batcher);
      const segment = segmentAt(cycles.bitNodeIndexAt(atMs));
      if (!segment.fastSeen) segment.homeRamUsedFirst = data.game?.homeRamUsed;
      segment.fastSeen = true;
      segment.homeRamUsedLast = data.game?.homeRamUsed;
      fast.push({
        atMs,
        gameTimeMs,
        agentSessionId,
        degradedTiers: data.degradedTiers,
        pageHeapUsedBytes: data.pageHeapUsedBytes,
        homeRamUsed: data.game?.homeRamUsed,
        intents: Array.isArray(data.intents) ? data.intents.filter((outcome) => typeof outcome?.id === "string") : [],
        blocking: data.dialogs?.blocking,
        work: data.work,
        batcher: data.batcher,
        batcherDeploy: data.batcherDeploy,
      });
    }
    const earlierStarts = dayBefore.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND);
    const reloadsBefore = store
      .eventsInWindow({
        environment: window.environment,
        sinceMs: window.sinceMs - RELOAD_LEAD_MS,
        untilMs: window.sinceMs - 1,
      })
      .filter((event) => Object.hasOwn(RELOAD_KINDS, event.kind));
    return {
      ...window,
      events,
      reloadsBefore,
      fastTimes,
      fast,
      thinned,
      mediumFirst,
      mediumLast,
      mediumTimes,
      weakenTimes,
      money,
      targets: inference.stretches,
      batcherTargets: batcherTargets.stretches,
      backdoors,
      slowFirst,
      slowLast,
      resetsMs: [...resetsMs],
      factionState,
      factionWork,
      augmentations,
      worldDaemon,
      snapshotCount,
      playersServers,
      staticLast,
      cloudServerChanges: cloudServerChanges.changes,
      hackLoopEnabled: readHackLoopEnabled(store),
      augmentationsEnabled: readAugmentationsEnabled(store),
      earlierBrainStartMs: earlierStarts.at(-1)?.atMs ?? null,
      hacking,
      cycles,
      // In order: before the first BitNode (or none known), then each; nothing at all, one empty segment.
      segments:
        segments.size === 0
          ? [{ index: -1, segment: segmentAt(-1) }]
          : [...segments].sort(([a], [b]) => a - b).map(([index, segment]) => ({ index, segment })),
    };
  });
}

/**
 * The run report for a window of the store. Throws for a window that ends before it starts, or one with nothing in it:
 * it would check nothing, and must never pass. By default, section 3's busiest blocks (the intents, the cloud servers,
 * the augmentations, the dialogs, the faction work) and section 2's hack loop target are summarised; `verbose` (the
 * command's --verbose) lists each line instead (#245: run #3's 12.4 h was 3,270 lines, most of them those). Either way
 * the checks (sections 4 to 6), the failures, the warnings and the verdict are the same.
 */
export function runReport(
  store: TelemetryStore,
  window: RunWindow,
  { gapThresholdMs = DEFAULT_GAP_THRESHOLD_MS, verbose = false }: { gapThresholdMs?: number; verbose?: boolean } = {},
): RunReport {
  if (!(window.sinceMs < window.untilMs)) throw new RangeError("the window must end after it starts");
  const facts = readFacts(store, window);
  if (facts.events.length === 0 && facts.snapshotCount === 0) {
    throw new Error(
      `nothing recorded (${window.environment}) from ${formatIsoTime(window.sinceMs)} to ` +
        `${formatIsoTime(window.untilMs)}`,
    );
  }
  const failures: string[] = [];
  const warnings: string[] = [];
  // Clock steps and page stalls (#241): section 4 lists them, section 6 puts the batcher's desyncs down to them.
  const incidents = findClockIncidents({
    medium: facts.mediumTimes,
    fast: facts.fastTimes,
    restartsMs: facts.events.filter((event) => RESTART_EVENT_KINDS.includes(event.kind)).map(({ atMs }) => atMs),
  });
  const lines = [
    `Run report (${window.environment}) from ${formatIsoTime(window.sinceMs)} to ${formatIsoTime(window.untilMs)} ` +
      `(${formatDuration(window.untilMs - window.sinceMs)})`,
    ...(verbose
      ? []
      : [
          "(summaries: --verbose lists each intent, cloud server bought or upgraded, change of work, dialog " +
            "handled, faction work choice, invitation travel, augmentation decision and purchase, and inferred hack " +
            "target; #245)",
        ]),
    "",
    ...windowSection(facts),
    "",
    ...progressSection(facts, verbose),
    "",
    ...facts.cycles.section(facts.factionWork.readings),
    "",
    ...actionsSection(facts, verbose),
    "",
    ...healthSection(facts, gapThresholdMs, failures, incidents),
    "",
    ...withWhoHacked(
      facts.hacking.section(failures, (fromMs, toMs) => facts.cycles.heldBackBetween(fromMs, toMs)),
      facts,
    ),
    "",
    ...batcherSection(
      facts.fast.map(({ atMs, batcher, batcherDeploy }) => ({ atMs, health: batcher, deploy: batcherDeploy })),
      failures,
      facts.factionWork.readings,
      facts.resetsMs,
      { incidents, weakenMs: (target, atMs) => facts.weakenTimes.weakenMs(target, atMs), warnings },
      // A batcher stuck on a poor target (#275), by section 5's medium snapshots' incomes and 2b's cycles.
      { incomes: facts.hacking.targetIncomes, cycleLabelAt: (atMs) => facts.cycles.cycleLabelAt(atMs) },
    ),
    "",
    failures.length > 0 ? "Verdict: FAIL" : warnings.length > 0 ? "Verdict: WARN" : "Verdict: PASS",
    ...failures.map((failure) => `  ${failure}`),
    ...warnings.map((warning) => `  warning: ${warning}`),
  ];
  return { text: lines.join("\n"), failures, warnings };
}

/**
 * Section 5's lines with, under the best 10 minutes, who hacked in them (#206): the batcher, from its health in the
 * fast snapshots then, or the hack loop. That's the batcher's percentage of A1's measure, the figure it's judged on.
 */
function withWhoHacked(lines: string[], facts: RunFacts): string[] {
  const best = facts.hacking.totals().best;
  const at = lines.findIndex((line) => line.startsWith("  the best 10 minutes: ") && !line.includes("none yet"));
  if (best === null || at === -1) return lines;
  const points = facts.fast
    .filter(({ atMs }) => atMs >= best.fromMs && atMs <= best.toMs)
    .map(({ atMs, batcher }) => ({ atMs, health: batcher }));
  return [...lines.slice(0, at + 1), `    by: ${whoHacked(points)}`, ...lines.slice(at + 1)];
}

// --- Formatting -------------------------------------------------------------------------------------------------------

const UNKNOWN = "unknown";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const formatMoney = (money: unknown) => (isNumber(money) ? `$${Math.round(money).toLocaleString("en-US")}` : UNKNOWN);
const formatGigabytes = (ram: unknown) => (isNumber(ram) ? `${Math.round(ram * 100) / 100} GB` : UNKNOWN);
const listOrNone = (items: string[]) => (items.length === 0 ? "none" : items.join(", "));
const fieldsOf = (detail: unknown) => (isObject(detail) ? detail : {}) as Record<string, unknown>;
/** A value from the store as text: strings as they are, anything else as JSON, and nothing as "unknown". */
const displayValue = (value: unknown) =>
  value === undefined || value === null ? UNKNOWN : typeof value === "string" ? value : JSON.stringify(value);
const quote = (value: string, length: number) =>
  `"${value.length > length ? `${value.slice(0, length).trimEnd()}…` : value}"`;

// --- 1. The window ----------------------------------------------------------------------------------------------------

/**
 * The events of the brain, the Agent's sessions and the save backups, in order; dialogs, promotions and the brain's
 * faction work (#203) are actions.
 */
function windowSection(facts: RunFacts): string[] {
  const lines = ["1. The window"];
  if (facts.earlierBrainStartMs !== null) {
    lines.push(
      `  note: the brain also started at ${formatIsoTime(facts.earlierBrainStartMs)}, ` +
        `${formatDuration(facts.sinceMs - facts.earlierBrainStartMs)} before the window: for a run that spans a ` +
        "restart, give --since",
    );
  }
  const { thinned } = facts;
  if (thinned.lastMs !== null) {
    lines.push(
      `  note: the store is thinned (#283) in this window, up to ${formatIsoTime(thinned.lastMs)}: ` +
        `${thinned.fast} fast and ${thinned.medium} medium snapshots there keep only their times, one of each a ` +
        "minute kept whole. The heartbeat's gaps, clock steps, page stalls and the page heap read every one; the " +
        "rest read the whole ones, so their times there are within a minute, what came and went within one isn't " +
        "seen, and a backdoor overdue and a batcher stuck on a poor target aren't judged there",
    );
  }
  // Section 3's: the actions, with the rules' events (#203, #210).
  const actions = [
    "gameDialog",
    WORK_PROMOTION_EVENT_KIND,
    FACTION_WORK_CHOSEN_EVENT_KIND,
    FACTION_WORK_STOPPED_EVENT_KIND,
    ...AUGMENTATION_EVENT_KINDS,
    ...WORLD_DAEMON_EVENT_KINDS,
    INVITATION_TRAVEL_EVENT_KIND,
    CITY_GROUP_CHOSEN_EVENT_KIND,
    INVITATION_WAITING_EVENT_KIND,
  ];
  const timeline = facts.events.filter((event) => !actions.includes(event.kind));
  for (const event of timeline) lines.push(`  ${formatIsoTime(event.atMs)}  ${describeEvent(event, facts.sinceMs)}`);
  if (timeline.length === 0) lines.push("  no events from the brain or the Agent");
  const count = (kind: string) => timeline.filter((event) => event.kind === kind).length;
  const backups = timeline.filter((event) => event.kind === "saveBackup" && !fieldsOf(event.detail).failure).length;
  lines.push(
    `  brain starts: ${count(BRAIN_STARTED_EVENT_KIND)}; Agent connections: ${count("agentConnected")}, ` +
      `disconnections: ${count("agentDisconnected")}; relaunches: ${count(RELAUNCH_EVENT_KIND)}; ` +
      `deploys: ${count("deployed")}; save backups: ${backups}`,
  );
  return lines;
}

/**
 * An event as a line. `sinceMs`, the window's start: a restart's note from before it (the page's storage outlives a
 * run, #212) says so.
 */
function describeEvent({ kind, detail }: StoredEvent, sinceMs: number = Number.NEGATIVE_INFINITY): string {
  const fields = fieldsOf(detail);
  switch (kind) {
    case BRAIN_STARTED_EVENT_KIND:
      return `brain started, release ${displayValue(fields.release)}`;
    case RELAUNCH_EVENT_KIND:
      return `game relaunched by the supervisor (${displayValue(fields.cause)})`;
    case "agentConnected": {
      const game = fieldsOf(fields.game);
      return (
        `Agent connected: session ${displayValue(fields.agentSessionId)}, deployment ` +
        `${displayValue(fields.deploymentId)}, game ${displayValue(game.version)} (${displayValue(game.platform)})`
      );
    }
    case "agentDisconnected":
      return `Agent disconnected: session ${displayValue(fields.agentSessionId)}`;
    case "deployed":
      return fields.replacedDeploymentId
        ? `deployed ${displayValue(fields.deploymentId)}, replacing ${displayValue(fields.replacedDeploymentId)}`
        : `deployed ${displayValue(fields.deploymentId)}`;
    case "deploymentCurrent":
      return `deployment ${displayValue(fields.deploymentId)} already current`;
    case "deployFailed":
      return `deploy of ${displayValue(fields.deploymentId)} FAILED: ${displayValue(fields.reason)}`;
    case "versionDrift":
      return `version drift: ${displayValue(fields.detail)}`;
    case "saveBackup":
      return fields.failure === undefined
        ? `save backup ${displayValue(fields.file)} (${Math.round(Number(fields.sizeBytes) / 1024)} KB)`
        : `save backup FAILED: ${displayValue(fields.failure)}`;
    case RESTART_FELL_BACK_EVENT_KIND:
      return (
        `restart after a reset couldn't type run /agent/boot.js: ${displayValue(fields.reason)}; ` +
        (fields.outcome === "reloading" ? "it saved and reloaded the game" : "it gave up") +
        // The note's own time, the page's clock: it can come from before this run, reported only now.
        (isNumber(fields.atMs) && fields.atMs > 0
          ? ` (noted ${formatIsoTime(fields.atMs)}${fields.atMs < sinceMs ? ", from before this run" : ""})`
          : "")
      );
    case "saveBackupRotationFailed":
      return `old save backups not removed: ${displayValue(fields.failure)}`;
    case "supervisionFailed":
      return `supervisor's check failed (${displayValue(fields.cause)}): ${displayValue(fields.failure)}`;
    case SUPERVISION_GAVE_UP_EVENT_KIND:
      return `supervisor GAVE UP: ${JSON.stringify(detail)}`;
    case MESSAGE_REFUSED_EVENT_KIND:
      return `the Agent REFUSED the brain's message (${displayValue(fields.count)} so far): ${displayValue(fields.reason)}`;
    case "connectionRejected":
      return `connection rejected (${displayValue(fields.reason)}): ${displayValue(fields.detail)}`;
    case STORE_THINNED_EVENT_KIND:
      return isObject(fields.thinned) && isNumber(fields.keptWholeDays)
        ? describeThinning(detail as StoreThinning)
        : `store thinned: ${JSON.stringify(detail)}`;
    case STORE_THINNING_FAILED_EVENT_KIND:
      return `store thinning FAILED, the store left as it was: ${displayValue(fields.failure)}`;
    default:
      return `${kind}: ${JSON.stringify(detail)}`;
  }
}

// --- 2. Progress ------------------------------------------------------------------------------------------------------

const playerOf = (data: MediumSnapshotData | undefined) => fieldsOf(data?.player);
const homeRamOf = (data: MediumSnapshotData | undefined) =>
  (Array.isArray(data?.servers) ? data.servers : []).find((server) => server?.hostname === "home")?.maxRam;
const namesOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
const jobsOf = (value: unknown) =>
  Object.entries(fieldsOf(value)).map(([company, title]) => `${company} (${displayValue(title)})`);
const sourceFilesOf = (data: SlowSnapshotData) =>
  Object.entries(fieldsOf(data.resetInfo?.ownedSF)).map(([number, level]) => `SF${number}.${displayValue(level)}`);

/** "first → last", or "last (unchanged)" when they're the same. */
function describeChange(first: string, last: string): string {
  return first === last ? `${last} (unchanged)` : `${first} → ${last}`;
}

/**
 * Start to end, from the first and last snapshots of each tier, a BitNode at a time (#244: never across a destroy,
 * which starts money, hacking and the rest again), each with its milestones; then the hack loop's target over the
 * window: the batcher's own, where its health says (#245), the inferred one with `verbose`; else inferred.
 */
function progressSection(facts: RunFacts, verbose: boolean): string[] {
  const lines = ["2. Progress, first snapshot → last, in each BitNode", facts.cycles.bitNodesLine()];
  for (const { index, segment } of facts.segments) {
    const bitNode = facts.cycles.bitNodes[index];
    lines.push(`  ${bitNode?.label ?? facts.cycles.labelBefore()}, first snapshot → last:`);
    lines.push(...segmentProgressLines(facts, segment, verbose).map((line) => `  ${line}`));
    lines.push(...facts.cycles.milestoneLines(index).map((line) => `    ${line}`));
  }
  const inferred = [
    "  hack loop target, inferred from the game's servers whose money or security moved between medium snapshots " +
      "(the owner's own scripts would show too; not across an install or a destroy):",
    ...facts.targets.map(
      (stretch) =>
        `    ${stretch.servers.join(" + ")}: ${formatIsoTime(stretch.fromMs)} to ${formatIsoTime(stretch.toMs)}`,
    ),
  ];
  if (facts.targets.length === 0) inferred.push("    none moved");
  if (facts.batcherTargets.length === 0) return [...lines, ...inferred];
  lines.push(
    "  the batcher's targets, from its health in the fast snapshots" +
      (verbose ? ":" : " (--verbose adds the hack loop's target inferred from the servers):"),
  );
  for (const { target, fromMs, toMs } of facts.batcherTargets) {
    lines.push(`    ${target}: ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`);
  }
  return verbose ? [...lines, ...inferred] : lines;
}

/** A first → last list in full under this long; longer, by default, its counts and what changed (#245). */
const LIST_IN_FULL_UNDER = 100;
/** How many names a long list's change gives before "and N more". */
const LIST_CHANGES_NAMED = 6;

/**
 * A list first → last (#244's progress): in full, "none → BruteSSH.exe", with `verbose` or under `LIST_IN_FULL_UNDER`
 * characters; else (#245: run #3's installed augmentations were 1,871 characters, both sides in full) the counts and
 * the names added and gone: "31 → 36 (+ The Red Pill, …, and 2 more)", or "36 (unchanged)".
 */
function describeListChange(first: readonly string[], last: readonly string[], verbose: boolean): string {
  const whole = describeChange(listOrNone([...first]), listOrNone([...last]));
  if (verbose || whole.length < LIST_IN_FULL_UNDER) return whole;
  const named = (names: string[]) =>
    names.slice(0, LIST_CHANGES_NAMED).join(", ") +
    (names.length > LIST_CHANGES_NAMED ? `, and ${names.length - LIST_CHANGES_NAMED} more` : "");
  const added = last.filter((name) => !first.includes(name));
  const gone = first.filter((name) => !last.includes(name));
  const changes = [
    ...(added.length > 0 ? [`+ ${named(added)}`] : []),
    ...(gone.length > 0 ? [`− ${named(gone)}`] : []),
  ];
  if (changes.length === 0) return `${last.length} (unchanged)`;
  return `${first.length} → ${last.length} (${changes.join("; ")})`;
}

/** One BitNode's progress (#244), first snapshot → last of each tier in it; long lists summarised by default (#245). */
function segmentProgressLines(facts: RunFacts, segment: ProgressSegment, verbose: boolean): string[] {
  const lines: string[] = [];
  const first = segment.mediumFirst;
  const last = segment.mediumLast;
  if (first === undefined || last === undefined) {
    lines.push("  no medium snapshot (the player and the servers) in the window");
  } else {
    const [playerFirst, playerLast] = [playerOf(first), playerOf(last)];
    lines.push(`  money: ${describeChange(formatMoney(playerFirst.money), formatMoney(playerLast.money))}`);
    const skillsFirst = fieldsOf(playerFirst.skills);
    const skillsLast = fieldsOf(playerLast.skills);
    lines.push(`  hacking: ${describeChange(displayValue(skillsFirst.hacking), displayValue(skillsLast.hacking))}`);
    const otherSkills = Object.keys(skillsLast).filter((skill) => skill !== "hacking");
    if (otherSkills.length > 0) {
      const changes = otherSkills.map(
        (skill) => `${skill} ${displayValue(skillsFirst[skill])} → ${displayValue(skillsLast[skill])}`,
      );
      lines.push(`  other skills: ${changes.join(", ")}`);
    }
    lines.push(`  home RAM: ${describeChange(formatGigabytes(homeRamOf(first)), formatGigabytes(homeRamOf(last)))}`);
  }
  if (segment.fastSeen) {
    lines.push(
      `  home RAM used: ${describeChange(formatGigabytes(segment.homeRamUsedFirst), formatGigabytes(segment.homeRamUsedLast))}`,
    );
  }
  if (first !== undefined && last !== undefined) {
    const yesOrNo = (data: MediumSnapshotData) => (data.hasTorRouter ? "yes" : "no");
    lines.push(`  TOR router: ${describeChange(yesOrNo(first), yesOrNo(last))}`);
    lines.push(`  port openers: ${describeListChange(namesOf(first.programs), namesOf(last.programs), verbose)}`);
    const rooted = (data: MediumSnapshotData) =>
      (Array.isArray(data.servers) ? data.servers : []).filter(
        (server) => server?.hasAdminRights === true && !facts.playersServers.has(server.hostname),
      ).length;
    lines.push(`  the game's servers rooted: ${describeChange(String(rooted(first)), String(rooted(last)))}`);
    // The hack loop's hosts as its rule has them (#194), the brain's cloud servers among them.
    const hosts = (data: MediumSnapshotData) => {
      if (facts.staticLast === undefined) return "unknown (no static snapshot)";
      const each = hackLoopHosts(facts.staticLast, data);
      const ram = each.reduce((total, host) => total + host.ram, 0);
      return `${formatGigabytes(ram)} on ${each.length} ${each.length === 1 ? "server" : "servers"}`;
    };
    lines.push(`  the hack loop's hosts' RAM: ${describeChange(hosts(first), hosts(last))}`);
    const [playerFirst, playerLast] = [playerOf(first), playerOf(last)];
    lines.push(`  city: ${describeChange(displayValue(playerFirst.city), displayValue(playerLast.city))}`);
    lines.push(
      `  factions: ${describeListChange(namesOf(playerFirst.factions), namesOf(playerLast.factions), verbose)}`,
    );
    lines.push(`  jobs: ${describeListChange(jobsOf(playerFirst.jobs), jobsOf(playerLast.jobs), verbose)}`);
  }
  const { slowFirst, slowLast } = segment;
  if (slowFirst === undefined || slowLast === undefined) {
    lines.push("  no slow snapshot (the BitNode, augmentations, Source-Files, purchased servers) in the window");
  } else {
    const augmentations = (data: SlowSnapshotData) => Object.keys(fieldsOf(data.resetInfo?.ownedAugs)).sort();
    lines.push(
      `  installed augmentations: ${describeListChange(augmentations(slowFirst), augmentations(slowLast), verbose)}`,
    );
    lines.push(
      `  BitNode: ${describeChange(displayValue(slowFirst.resetInfo?.currentNode), displayValue(slowLast.resetInfo?.currentNode))}`,
    );
    lines.push(`  Source-Files: ${describeListChange(sourceFilesOf(slowFirst), sourceFilesOf(slowLast), verbose)}`);
    const [serversFirst, serversLast] = [namesOf(slowFirst.purchasedServers), namesOf(slowLast.purchasedServers)];
    lines.push(`  purchased servers: ${describeListChange(serversFirst, serversLast, verbose)}`);
    lines.push(...factionProgressLines(segment.factionState, slowLast));
  }
  return lines;
}

const formatReputation = (reputation: number) => Math.round(reputation).toLocaleString("en-US");
const formatFavor = (favor: number) => favor.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The augmentations queued, NeuroFlux Governor's copies counted: "Neurotrainer I, NeuroFlux Governor ×2". */
function describeQueue(queue: string[] | null): string {
  if (queue === null) return UNKNOWN;
  const counts = new Map<string, number>();
  for (const name of queue) counts.set(name, (counts.get(name) ?? 0) + 1);
  return listOrNone([...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)));
}

/**
 * The faction state (#197), first reading → last: each faction's reputation and favour, the invitations, the queue;
 * and (#225) each faction's favour after the next install, and when its donations unlock (`donationStatus`).
 */
function factionProgressLines(folding: FactionStateFolding, slowLast: SlowSnapshotData | undefined): string[] {
  const lines = ["  faction reputation and favour, first reading → last:"];
  for (const [name, { first, last }] of folding.factions) {
    const reputation = describeChange(formatReputation(first.reputation), formatReputation(last.reputation));
    const favor = describeChange(formatFavor(first.favor), formatFavor(last.favor));
    lines.push(`    ${name}: reputation ${reputation}, favour ${favor}${donationStatus(name, last, slowLast)}`);
  }
  if (folding.factions.size === 0) lines.push(`    ${folding.lastQueue === null ? "never read" : "none joined"}`);
  lines.push("  faction invitations, as first seen:");
  for (const [name, atMs] of folding.invitations) lines.push(`    ${name}, ${formatIsoTime(atMs)}`);
  if (folding.invitations.size === 0) lines.push(`    ${folding.lastQueue === null ? "never read" : "none"}`);
  lines.push(
    `  augmentations queued: ${describeChange(describeQueue(folding.firstQueue), describeQueue(folding.lastQueue))}`,
  );
  return lines;
}

// --- 3. Actions -------------------------------------------------------------------------------------------------------

/** One intent from when it was given to when it was done, or last seen: an id given again later is another. */
interface IntentEpisode {
  id: string;
  outcome: IntentOutcome;
  firstSeenMs: number;
  lastSeenMs: number;
  /** When it was seen done: its done record, or the slow snapshot that showed the reset that followed it (#286). */
  doneAtMs: number | null;
  /** The problems it reported while not done, each once (#245: why it was tried again). */
  problemsBeforeDone: string[];
  /** Done by the reset that followed it, with no done record (#286). */
  resetFollowed: boolean;
  /**
   * An install or a destroy not done, first seen before the window's first slow snapshot: whether its reset came can't
   * be told (`resetKnownBefore`), as section 4 doesn't judge an install sent then (#286 re-review).
   */
  notJudged: boolean;
}

/**
 * How long after a reset intent's last record the reset may be seen and still count as its (#286): an install's own
 * allowance in section 4 (`INSTALL_NOT_RESTARTED_AFTER_MS`, 5 minutes); a destroy's reload is under a minute
 * (`RELOAD_GAP_BOUND_MS`). Later, something else reset the game.
 */
const RESET_FOLLOWED_WITHIN_MS = INSTALL_NOT_RESTARTED_AFTER_MS;

/**
 * When a reset intent's own reset was seen after it (#286), or null: an install's, another `lastAugReset` (as section
 * 4's installs sent are seen done); a destroy's, another BitNode (as section 2's BitNodes line). After its first
 * record, up to `RESET_FOLLOWED_WITHIN_MS` after its last, and before the same id's next episode (`nextMs`): a reset
 * seen after that is the next one's. The next can't come before the reset's slow snapshot: the brain sends a reset
 * intent only once the connected Agent's slow snapshot has shown the last reset (`#resetTimeAwaited`,
 * `desired-state.ts:1103-1107`). An install a destroy followed counts too: a destroy resets the cycle as an install
 * does (`PlayerObjectGeneralMethods.ts:145`, `:126`), as section 4 has it. Null for any other intent.
 */
function resetFollowing(
  facts: RunFacts,
  { id, firstSeenMs, lastSeenMs }: IntentEpisode,
  nextMs: number = Number.POSITIVE_INFINITY,
): number | null {
  const untilMs = Math.min(lastSeenMs + RESET_FOLLOWED_WITHIN_MS, nextMs);
  if (id.startsWith("installAugmentations(")) return facts.augmentations.resetSeenBetween(firstSeenMs, untilMs);
  if (id.startsWith("destroyBitNode(")) return facts.cycles.bitNodeSeenBetween(firstSeenMs, untilMs);
  return null;
}

/**
 * Whether a slow snapshot by a reset intent's first record showed the game's last reset (#286 re-review): an install's
 * `lastAugReset`, a destroy's BitNode. With none, a reset after it can't be told from the window's first. True for any
 * other intent.
 */
function resetKnownBefore(facts: RunFacts, { id, firstSeenMs }: IntentEpisode): boolean {
  if (id.startsWith("installAugmentations(")) return facts.augmentations.resetKnownBy(firstSeenMs);
  if (id.startsWith("destroyBitNode(")) return facts.cycles.bitNodeKnownBy(firstSeenMs);
  return true;
}

/**
 * Each intent episode in the window, in the order first seen, with its latest outcome. The same id starts a new episode
 * as the Agent starts a new intent (#286): when it's seen not done after being done, with fewer tries (given again),
 * back after leaving the list (`ingame/src/agent/intent-runner.ts:7`: "one that leaves the list and comes back is
 * new"), or from another Agent (a new one holds a new list, :3; a reset starts one). `installAugmentations()` has one
 * id, so each install is its own episode.
 * An install or a destroy not done that its reset followed is done (#286): the reset kills its worker before it
 * reports, so an install's try is never counted (`intent-runner.ts:48-51`), and a destroy's worker never reports done
 * (`ingame/src/page/destroy-page.ts:110`); what it last reported is a problem before done. One first seen before the
 * window's first slow snapshot isn't judged (`notJudged`).
 */
function intentEpisodes(facts: RunFacts): IntentEpisode[] {
  const episodes: IntentEpisode[] = [];
  const current = new Map<string, IntentEpisode>();
  let previous: FastPoint | undefined;
  for (const point of facts.fast) {
    const { atMs, intents } = point;
    const left = (id: string) =>
      previous !== undefined &&
      (previous.agentSessionId !== point.agentSessionId || !previous.intents.some((outcome) => outcome.id === id));
    for (const outcome of intents) {
      let episode = current.get(outcome.id);
      if (
        episode === undefined ||
        (episode.outcome.done && !outcome.done) ||
        outcome.tries < episode.outcome.tries ||
        left(outcome.id)
      ) {
        episode = {
          id: outcome.id,
          outcome,
          firstSeenMs: atMs,
          lastSeenMs: atMs,
          doneAtMs: null,
          problemsBeforeDone: [],
          resetFollowed: false,
          notJudged: false,
        };
        episodes.push(episode);
        current.set(outcome.id, episode);
      }
      episode.outcome = outcome;
      episode.lastSeenMs = atMs;
      if (outcome.done) episode.doneAtMs ??= atMs;
      else if (outcome.problem !== null && !episode.problemsBeforeDone.includes(outcome.problem)) {
        episode.problemsBeforeDone.push(outcome.problem);
      }
    }
    previous = point;
  }
  // Backwards, each id's next episode's start in hand.
  const nextStartMs = new Map<string, number>();
  for (let index = episodes.length - 1; index >= 0; index--) {
    const episode = episodes[index] as IntentEpisode;
    const nextMs = nextStartMs.get(episode.id);
    nextStartMs.set(episode.id, episode.firstSeenMs);
    if (episode.outcome.done) continue;
    if (!resetKnownBefore(facts, episode)) {
      episode.notJudged = true;
      continue;
    }
    const seenMs = resetFollowing(facts, episode, nextMs);
    if (seenMs === null) continue;
    episode.outcome = { ...episode.outcome, done: true, problem: null };
    episode.doneAtMs = seenMs;
    episode.resetFollowed = true;
  }
  return episodes;
}

/**
 * What an intent reports while its worker is still at it (#245): a ui backdoor's "installing the backdoor on CSEC:
 * about 40 s left" (`ingame/src/workers/backdoor-standing.ts:36`), carried on as "… (its worker is still at it)"
 * (`ingame/src/agent/intent-runner.ts:57`), or "its last worker is still running"
 * (`ingame/src/agent/run-worker.ts:34`).
 */
const STILL_AT_IT = /: about \d+ s left|its worker is still at it|its last worker is still running/;

/**
 * Done after more than one try, everything reported before it its worker still at it (#245): a ui backdoor's second
 * try is routine, as its first starts the backdoor and returns. Counted, not listed, by default. One tried again with
 * nothing reported (no problem seen) is listed: why isn't known.
 */
const triedAgainWhileAtIt = ({ outcome, problemsBeforeDone }: IntentEpisode) =>
  outcome.done &&
  outcome.tries > 1 &&
  outcome.problem === null &&
  problemsBeforeDone.length > 0 &&
  problemsBeforeDone.every((problem) => STILL_AT_IT.test(problem));

/** "2 tries (ui)". */
function describeTries({ tries, backend }: IntentOutcome): string {
  return `${tries} ${tries === 1 ? "try" : "tries"}${backend === null ? "" : ` (${backend})`}`;
}

function describeIntent(outcome: IntentOutcome): string {
  const tries = describeTries(outcome);
  const problem = outcome.problem === null ? "" : `: ${outcome.problem}`;
  return outcome.done ? `done after ${tries}${problem}` : `not done, ${tries}${problem}`;
}

/**
 * An intent episode's line: "    travel(Aevum): done after 2 tries (ui); done by …", or for one its reset followed
 * (#286) "    destroyBitNode(1): done: the reset followed, 1 try (ui); the reset seen by …".
 */
function describeEpisode({ id, outcome, firstSeenMs, doneAtMs, resetFollowed, notJudged }: IntentEpisode): string {
  if (resetFollowed && doneAtMs !== null) {
    return `    ${id}: done: the reset followed, ${describeTries(outcome)}; the reset seen by ${formatIsoTime(doneAtMs)}`;
  }
  const when = doneAtMs === null ? `first seen ${formatIsoTime(firstSeenMs)}` : `done by ${formatIsoTime(doneAtMs)}`;
  return `    ${id}: ${describeIntent(outcome)}; ${when}${notJudged ? `; ${BEFORE_FIRST_SLOW}` : ""}`;
}

/** One action's intents (the id's name before its arguments), counted by outcome. */
interface ActionCounts {
  done: number;
  doneWithProblem: number;
  triedAgainWhileAtIt: number;
  /** Done by the reset that followed it, with no done record (#286). */
  resetFollowed: number;
  notDone: number;
  /** Not done, seen before the window's first slow snapshot: not judged (#286 re-review). */
  notJudged: number;
}

/**
 * The intents (#245): with `verbose`, each episode; else counts by action (the id's name before its arguments) and
 * outcome, the most first, then each episode not done, done with a problem, or tried again for something besides its
 * worker still at it (`triedAgainWhileAtIt`). An install or a destroy its reset followed is done, and says so (#286).
 */
function intentLines(facts: RunFacts, verbose: boolean): string[] {
  const episodes = intentEpisodes(facts);
  if (verbose) return ["  intents:", ...(episodes.length === 0 ? ["    none"] : episodes.map(describeEpisode))];
  const lines = [`  intents: ${episodes.length}, by action and outcome (--verbose lists each):`];
  const byAction = new Map<string, ActionCounts>();
  for (const episode of episodes) {
    const action = episode.id.split("(")[0] ?? episode.id;
    const counts = byAction.get(action) ?? {
      done: 0,
      doneWithProblem: 0,
      triedAgainWhileAtIt: 0,
      resetFollowed: 0,
      notDone: 0,
      notJudged: 0,
    };
    byAction.set(action, counts);
    if (episode.outcome.done) counts.done += 1;
    else counts.notDone += 1;
    if (episode.outcome.done && episode.outcome.problem !== null) counts.doneWithProblem += 1;
    if (triedAgainWhileAtIt(episode)) counts.triedAgainWhileAtIt += 1;
    if (episode.resetFollowed) counts.resetFollowed += 1;
    if (episode.notJudged) counts.notJudged += 1;
  }
  const total = ({ done, notDone }: ActionCounts) => done + notDone;
  const ranked = [...byAction].sort(
    ([firstAction, firstCounts], [secondAction, secondCounts]) =>
      total(secondCounts) - total(firstCounts) ||
      (firstAction < secondAction ? -1 : firstAction > secondAction ? 1 : 0),
  );
  for (const [action, counts] of ranked) {
    const notes = [
      ...(counts.doneWithProblem > 0 ? [`${counts.doneWithProblem} with a problem`] : []),
      ...(counts.triedAgainWhileAtIt > 0 ? [`${counts.triedAgainWhileAtIt} tried again while still at it`] : []),
      ...(counts.resetFollowed > 0 ? [`${counts.resetFollowed} by the reset that followed, with no done record`] : []),
    ];
    const outcomes = [
      ...(counts.done > 0 ? [`${counts.done} done${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`] : []),
      ...(counts.notDone > 0
        ? [`${counts.notDone} not done${counts.notJudged > 0 ? ` (${counts.notJudged} ${BEFORE_FIRST_SLOW})` : ""}`]
        : []),
    ];
    lines.push(`    ${action}: ${outcomes.join(", ")}`);
  }
  if (episodes.length === 0) lines.push("    none");
  lines.push("  intents not done, done with a problem, or tried again for something besides their worker still at it:");
  const notable = episodes.filter(
    (episode) =>
      !episode.outcome.done ||
      episode.outcome.problem !== null ||
      (episode.outcome.tries > 1 && !triedAgainWhileAtIt(episode)),
  );
  lines.push(...(notable.length === 0 ? ["    none"] : notable.map(describeEpisode)));
  return lines;
}

/** How many of an alert's words tell it from others (#245: run #3's 3 Source-File alerts among 108). */
const ALERT_FIRST_WORDS = 4;

/**
 * The dialogs the Agent handled (#245): with `verbose`, each, quoted; else counts by kind (an alert by its first
 * words), the most first, and the dialogs not handled, left blocking the page (section 4's failures).
 */
function dialogLines(facts: RunFacts, verbose: boolean): string[] {
  const dialogs = facts.events
    .filter((event) => event.kind === "gameDialog")
    .map(({ atMs, detail }) => {
      const dialog = fieldsOf(detail) as Partial<HandledDialog>;
      return { atMs, kind: displayValue(dialog.kind), text: displayValue(dialog.text) };
    });
  if (verbose) {
    const lines = ["  dialogs handled:"];
    for (const { atMs, kind, text } of dialogs) {
      lines.push(`    ${formatIsoTime(atMs)}  ${kind}: ${quote(text, DIALOG_QUOTE_LENGTH)}`);
    }
    if (dialogs.length === 0) lines.push("    none");
    return lines;
  }
  const lines = ["  dialogs handled, by kind, an alert by its first words (--verbose lists each):"];
  const kinds = dialogs.map(({ kind, text }) => {
    if (kind !== "alert") return kind;
    const words = text.split(/\s+/).filter((word) => word !== "");
    return `alert "${words.slice(0, ALERT_FIRST_WORDS).join(" ")}${words.length > ALERT_FIRST_WORDS ? "…" : ""}"`;
  });
  for (const [kind, count] of countsOf(kinds)) lines.push(`    ${kind}: ${count}`);
  if (dialogs.length === 0) lines.push("    none");
  lines.push("  dialogs not handled (left blocking the page; section 4's failures):");
  const blocking = blockingEpisodes(facts);
  for (const { dialog, fromMs, toMs } of blocking) {
    lines.push(`    from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}: ${quote(dialog, BLOCKING_QUOTE_LENGTH)}`);
  }
  if (blocking.length === 0) lines.push("    none");
  return lines;
}

/** A work outcome in words (#151): "none wanted", "converged (ui)", "not converged (ui): a dialog … is open". */
function describeWork(work: WorkOutcome | null): string {
  if (work === null) return "none wanted";
  const backend = work.backend ? ` (${work.backend})` : "";
  return `${work.converged ? "converged" : "not converged"}${backend}${work.problem ? `: ${work.problem}` : ""}`;
}

/**
 * The work as it changed (#151): with `verbose`, each change; else a line a cycle (#245), its changes counted by state
 * and each with a problem listed. A new work wanted reads "not converged" with no problem until its first try
 * (`ingame/src/agent/work.ts:44`), which is routine; one with a problem isn't.
 */
function workLines(facts: RunFacts, verbose: boolean): string[] {
  const changes: { atMs: number; work: WorkOutcome | null; described: string }[] = [];
  for (const { atMs, work } of facts.fast) {
    if (work === undefined) continue;
    const described = describeWork(work);
    if (described !== changes.at(-1)?.described) changes.push({ atMs, work, described });
  }
  if (changes.length === 0) return ["  work, as it changed:", "    not reported"];
  if (verbose) {
    const each = changes.map(({ atMs, described }) => `    ${formatIsoTime(atMs)}  ${described}`);
    return ["  work, as it changed:", ...each];
  }
  const lines = ["  work, as it changed, by cycle: each state counted, each problem listed (--verbose lists each):"];
  for (const [label, inCycle] of Map.groupBy(changes, ({ atMs }) => facts.cycles.cycleLabelAt(atMs))) {
    const states = inCycle.map(({ work }) => describeWork(work === null ? null : { ...work, problem: null }));
    lines.push(`    ${label}: ${plural(inCycle.length, "change", "changes")}: ${describeCounts(states)}`);
    for (const { atMs, work, described } of inCycle) {
      if (work?.problem) lines.push(`      ${formatIsoTime(atMs)}  ${described}`);
    }
  }
  return lines;
}

function actionsSection(facts: RunFacts, verbose: boolean): string[] {
  const lines = ["3. Actions", ...intentLines(facts, verbose)];

  lines.push(...cloudServerLines(facts, verbose));
  lines.push(...workLines(facts, verbose));

  lines.push("  promotions:");
  const promotions = facts.events.filter((event) => event.kind === WORK_PROMOTION_EVENT_KIND);
  for (const { atMs, detail } of promotions) {
    const fields = fieldsOf(detail);
    lines.push(
      `    ${formatIsoTime(atMs)}  ${displayValue(fields.company)}: ${displayValue(fields.from)} → ${displayValue(fields.to)}`,
    );
  }
  if (promotions.length === 0) lines.push("    none");

  lines.push(...dialogLines(facts, verbose));
  lines.push(...backdoorLines(facts, verbose));
  lines.push(
    ...factionLines(facts, verbose),
    ...invitationLines(
      facts.events,
      formatIsoTime,
      facts.untilMs,
      facts.events.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).map((event) => event.atMs),
      verbose ? undefined : (atMs) => facts.cycles.cycleLabelAt(atMs),
    ),
  );
  lines.push(
    ...(verbose
      ? facts.augmentations.actionLines(facts.events, formatIsoTime)
      : facts.augmentations.summaryLines(facts.events, formatIsoTime, (atMs) => facts.cycles.cycleLabelAt(atMs))),
  );
  lines.push(...facts.worldDaemon.pathLines(facts, facts.events, formatIsoTime));
  return lines;
}

/**
 * The joins and the brain's faction work (#203): the factions the medium snapshots showed joined, the city factions'
 * invitations seen and not joined (#228: not of the city group the brain chose), each choice of work and why, or its
 * end, and the reputation each faction gained while the brain's work was on it. The choices: with `verbose`, each; else
 * a line a cycle, counted (#245).
 */
function factionLines({ factionWork, cycles }: RunFacts, verbose: boolean): string[] {
  const lines = ["  factions (joins, and the brain's faction work):"];
  if (verbose || factionWork.joined.size === 0) {
    const joined = [...factionWork.joined].map(([faction, atMs]) =>
      atMs === null ? `${faction} (at the window's start)` : `${faction} by ${formatIsoTime(atMs)}`,
    );
    lines.push(`    joined: ${joined.length === 0 ? "none" : joined.join(", ")}`);
  } else {
    // Each faction's first join, counted by the cycle it was in (#245: run #3's, with each time, was 2,000 characters).
    const cycleOf = ([, atMs]: [string, number | null]) =>
      atMs === null ? "at the window's start" : cycles.cycleLabelAt(atMs);
    const byCycle = [...Map.groupBy(factionWork.joined, cycleOf)].map(([label, joins]) => `${label}: ${joins.length}`);
    lines.push(
      `    joined: ${plural(factionWork.joined.size, "faction", "factions")}, each first in: ${byCycle.join(", ")} ` +
        "(--verbose lists each with when)",
    );
  }
  const passedOver = [...factionWork.passedOver].map(
    ([faction, atMs]) => `${faction} (first seen ${formatIsoTime(atMs)})`,
  );
  lines.push(
    "    city factions' invitations passed over (not of the city group the brain chose, decision 54): " +
      (passedOver.length === 0 ? "none" : passedOver.join(", ")),
  );
  if (verbose) {
    lines.push("    the brain's faction work, as chosen:");
    for (const record of factionWork.records) {
      const what = record.kind === "chosen" ? describeChoice(record.choice) : `stopped (${record.reason})`;
      lines.push(`      ${formatIsoTime(record.atMs)}  ${what}`);
    }
  } else {
    lines.push("    the brain's faction work, by cycle (--verbose lists each choice):");
    for (const [label, records] of Map.groupBy(factionWork.records, ({ atMs }) => cycles.cycleLabelAt(atMs))) {
      const chosen = records.flatMap((record) =>
        record.kind === "chosen" ? [`${record.choice.workType} for ${record.choice.faction}`] : [],
      );
      const stopped = records.flatMap((record) => (record.kind === "stopped" ? [record.reason] : []));
      const parts = [
        chosen.length === 0 ? "no choice" : `${plural(chosen.length, "choice", "choices")}: ${describeCounts(chosen)}`,
        ...(stopped.length === 0 ? [] : [`stopped ${stopped.length} (${describeCounts(stopped)})`]),
      ];
      lines.push(`      ${label}: ${parts.join("; ")}`);
    }
  }
  if (factionWork.records.length === 0) lines.push("      none");
  const gained = [...factionWork.gained].map(([faction, reputation]) => `${faction} +${formatReputation(reputation)}`);
  lines.push(`    reputation gained with the brain's work on it: ${gained.length === 0 ? "none" : gained.join(", ")}`);
  return lines;
}

/**
 * The brain's faction work stalled (#203): a stretch of `FACTION_WORK_STALLED_AFTER_MS` or more, with its choice in
 * force, in which its faction's reputation rose under half the work's rate over each 10-minute window of slow snapshots
 * (a faction not being worked gains a little passively; skipped readings left out); a gap of over
 * `SLOW_SNAPSHOT_GAP_MS` in them starts the readings again, as it's a failure of its own.
 */
function factionWorkHealthLines({ factionWork }: RunFacts, failures: string[]): string[] {
  const lines = [
    `  faction work stalled (the brain's choice, its faction's reputation rising under half the work's rate for ` +
      `${formatDuration(FACTION_WORK_STALLED_AFTER_MS)} or more, no slow snapshot gap over ` +
      `${formatDuration(SLOW_SNAPSHOT_GAP_MS)}):`,
  ];
  for (const { faction, workType, reputationPerSecond, fromMs, toMs, ongoing } of factionWork.stalls) {
    const line =
      `faction work stalled: ${faction}'s reputation rose under half the ${workType} work's ` +
      `${reputationPerSecond.toFixed(2)}/s from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} ` +
      `(${formatDuration(toMs - fromMs)}), with the brain's work for it` +
      (ongoing ? "; still under it at the last slow snapshot" : "");
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (factionWork.stalls.length === 0) lines.push("    none");
  return lines;
}

/**
 * The hacker factions' servers by default (#245: run #3's each repeated every reset, about 2,000 characters a line): a
 * line a server, backdoored at the window's start or not; in how many cycles it was backdoored in the window, how
 * long after the cycle's start (the least and the most, and where the most was); not backdoored at the end if the
 * last reset left it so; and its faction's invitations, or none seen after a backdoor.
 */
function backdoorSummaryLines(facts: RunFacts): string[] {
  const lines = ["  backdoors (the hacker factions' servers, for their invitations; --verbose lists each change):"];
  const { backdoors } = facts;
  const firstMs = backdoors.firstMediumAtMs;
  if (firstMs === null) return [...lines, "    no medium snapshot"];
  for (const { hostname, faction } of HACKER_FACTION_SERVERS) {
    const changes = backdoors.changesOf(hostname);
    if (changes.length === 0) {
      lines.push(`    ${hostname}: not in the medium snapshots`);
      continue;
    }
    const atStart = changes.find((change) => change.atMs === firstMs);
    const parts = atStart === undefined ? [] : [`${atStart.installed ? "" : "not "}backdoored at the window's start`];
    const backdoored = changes.filter((change) => change.installed && change.atMs !== firstMs);
    const afterStart = backdoored.flatMap(({ atMs }) => {
      const startMs = facts.cycles.cycleStartAt(atMs);
      return startMs === null ? [] : [{ atMs, afterMs: atMs - startMs }];
    });
    if (backdoored.length > 0 && afterStart.length < backdoored.length) {
      // No cycle seen (no slow snapshot) for one of them: how many, without the timing.
      parts.push(`backdoored ${plural(backdoored.length, "time", "times")}`);
    } else if (backdoored.length > 0) {
      const longest = afterStart.reduce((most, each) => (each.afterMs > most.afterMs ? each : most));
      const least = Math.min(...afterStart.map(({ afterMs }) => afterMs));
      parts.push(
        `backdoored in ${plural(backdoored.length, "cycle", "cycles")}, ${formatDuration(least)} to ` +
          `${formatDuration(longest.afterMs)} after the cycle's start (the most in ` +
          `${facts.cycles.cycleLabelAt(longest.atMs)})`,
      );
    }
    const last = changes.at(-1);
    if (last !== undefined && !last.installed && last.atMs !== firstMs) {
      parts.push(`not backdoored since ${formatIsoTime(last.atMs)} (a reset)`);
    }
    const invited = facts.events.filter((event) => {
      const dialog = fieldsOf(event.detail);
      return (
        event.kind === "gameDialog" &&
        dialog.kind === "factionInvitation" &&
        typeof dialog.text === "string" &&
        dialog.text.includes(faction)
      );
    }).length;
    if (invited > 0) parts.push(`${faction}'s invitation ${plural(invited, "time", "times")}`);
    else if (backdoored.length > 0) parts.push(`no invitation from ${faction} seen`);
    lines.push(`    ${hostname}: ${parts.join("; ")}`);
  }
  return lines;
}

/**
 * The hacker factions' servers (#195), with --verbose: when the medium snapshots first showed each backdoored (or
 * gone again, after a reset), and the invitation that followed, where the Agent handled its dialog: a `gameDialog` event of kind
 * `factionInvitation` naming the faction ("Would you like to join CyberSec?").
 */
function backdoorLines(facts: RunFacts, verbose: boolean): string[] {
  if (!verbose) return backdoorSummaryLines(facts);
  const lines = ["  backdoors (the hacker factions' servers, for their invitations):"];
  const { backdoors } = facts;
  if (backdoors.firstMediumAtMs === null) return [...lines, "    no medium snapshot"];
  const invitations = facts.events.filter((event) => {
    const dialog = fieldsOf(event.detail);
    return event.kind === "gameDialog" && dialog.kind === "factionInvitation" && typeof dialog.text === "string";
  });
  for (const { hostname, faction } of HACKER_FACTION_SERVERS) {
    const changes = backdoors
      .changesOf(hostname)
      .map(({ atMs, installed }) =>
        atMs === backdoors.firstMediumAtMs
          ? installed
            ? "backdoored at the window's start"
            : "not backdoored at the window's start"
          : installed
            ? `backdoored by ${formatIsoTime(atMs)}`
            : `not backdoored from ${formatIsoTime(atMs)} (a reset)`,
      );
    const invited = invitations
      .filter((event) => (fieldsOf(event.detail).text as string).includes(faction))
      .map((event) => `${faction}'s invitation at ${formatIsoTime(event.atMs)}`);
    const backdooredInWindow = backdoors
      .changesOf(hostname)
      .some((change) => change.installed && change.atMs !== backdoors.firstMediumAtMs);
    if (invited.length === 0 && backdooredInWindow) invited.push(`no invitation from ${faction} seen`);
    const said = [...changes, ...invited];
    lines.push(`    ${hostname}: ${said.length === 0 ? "not in the medium snapshots" : said.join("; ")}`);
  }
  return lines;
}

/**
 * Backdoors overdue (#195): a stretch of `BACKDOOR_OVERDUE_AFTER_MS` or more in which the medium snapshots showed one
 * of the hacker factions' servers rooted, at its level and not backdoored: the brain asks for it at once, and it takes
 * seconds; a gap in the medium snapshots ends a stretch, as it's a failure of its own. With no static snapshot in the
 * window (the servers' levels), none can be judged, and it says so. And backdoors asked for again: a `backdoor` intent
 * on one of them first seen while the medium snapshots showed it backdoored. Not one the window's first fast snapshot
 * holds (asked for before), nor one that follows a not-done episode of the same id: an Agent that reconnected, or a
 * reload, forgets the intents it held, and the brain gives it the same one again, from no tries (#195 review). The
 * store can't say whose it was: the brain's rule, or the owner's queue.
 */
function backdoorHealthLines(facts: RunFacts, failures: string[]): string[] {
  const lines = [
    "  backdoors overdue (one of the hacker factions' servers rooted, at its level and not backdoored for " +
      `${formatDuration(BACKDOOR_OVERDUE_AFTER_MS)} or more):`,
  ];
  if (!facts.backdoors.judged && facts.backdoors.firstMediumAtMs !== null) {
    lines.push("    not judged: no static snapshot (the servers' levels) in the window: give --since an Agent's start");
  }
  const overdue = facts.backdoors.due.filter((stretch) => stretch.toMs - stretch.fromMs >= BACKDOOR_OVERDUE_AFTER_MS);
  for (const { hostname, fromMs, toMs, ongoing } of overdue) {
    const line =
      `backdoor overdue: ${hostname} due from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} ` +
      `(${formatDuration(toMs - fromMs)}), not backdoored${ongoing ? "; still due at the last medium snapshot" : ""}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (overdue.length === 0) lines.push("    none");
  lines.push("  backdoors asked for again (on one of the hacker factions' servers already backdoored):");
  const firstFastMs = facts.fast[0]?.atMs;
  let repeated = 0;
  const lastEpisodeDone = new Map<string, boolean>();
  for (const { id, firstSeenMs, outcome } of intentEpisodes(facts)) {
    const followsNotDone = lastEpisodeDone.get(id) === false;
    lastEpisodeDone.set(id, outcome.done);
    const hostname = HACKER_FACTION_SERVERS.find((server) => id === `backdoor(${server.hostname})`)?.hostname;
    if (hostname === undefined || firstSeenMs === firstFastMs || followsNotDone) continue;
    if (!facts.backdoors.installedAt(hostname, firstSeenMs)) continue;
    repeated++;
    const line =
      `backdoor repeated: ${id} first seen ${formatIsoTime(firstSeenMs)}, with ${hostname} backdoored ` +
      `(the brain's rule, or the owner's queue)`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (repeated === 0) lines.push("    none");
  return lines;
}

/**
 * The cloud servers bought or upgraded (#194): with `verbose`, each with its RAM and price; by default (#245), the
 * fleet a line a cycle, its count and RAM before the cycle's first change and after its last, with what was bought
 * and upgraded and its price. Then the total. The price is BN1's (the brain's rule knows no other yet): in another
 * BitNode, unknown.
 */
function cloudServerLines(facts: RunFacts, verbose: boolean): string[] {
  const lines = [
    "  cloud servers bought or upgraded (from the medium snapshots)" +
      (verbose ? ":" : ", the fleet by cycle (--verbose lists each):"),
  ];
  const currentNode = facts.slowLast?.resetInfo?.currentNode;
  const priceOf = ({ fromRam, toRam }: CloudServerChange) =>
    currentNode === 1 ? cloudServerPrice(toRam) - (fromRam === null ? 0 : cloudServerPrice(fromRam)) : null;
  let total = 0;
  for (const change of facts.cloudServerChanges) {
    const price = priceOf(change);
    total += price ?? 0;
    if (!verbose) continue;
    const what =
      change.fromRam === null
        ? `${change.hostname} bought, ${formatGigabytes(change.toRam)}`
        : `${change.hostname} upgraded, ${formatGigabytes(change.fromRam)} → ${formatGigabytes(change.toRam)}`;
    const cost = price === null ? `price unknown in BitNode ${displayValue(currentNode)}` : formatMoney(price);
    lines.push(`    ${formatIsoTime(change.atMs)}  ${what}, ${cost}`);
  }
  const fleet = ({ count, ram }: CloudFleet) =>
    count === 0 ? "none" : `${plural(count, "server", "servers")}, ${formatGigabytes(ram)}`;
  const byCycle = Map.groupBy(facts.cloudServerChanges, ({ atMs }) => facts.cycles.cycleLabelAt(atMs));
  for (const [label, changes] of verbose ? [] : byCycle) {
    const [first, last] = [changes[0], changes.at(-1)] as [CloudServerChange, CloudServerChange];
    const bought = changes.filter((change) => change.fromRam === null).length;
    const span =
      first.atMs === last.atMs
        ? `at ${formatIsoTime(first.atMs)}`
        : `${formatIsoTime(first.atMs)} to ${formatIsoTime(last.atMs)}`;
    const cost =
      currentNode === 1 ? `, ${formatMoney(changes.reduce((sum, each) => sum + (priceOf(each) ?? 0), 0))}` : "";
    lines.push(
      `    ${label}, ${span}: ${fleet(first.fleetBefore)} → ${fleet(last.fleetAfter)} (${bought} bought, ` +
        `${changes.length - bought} upgraded${cost})`,
    );
  }
  if (facts.cloudServerChanges.length === 0) {
    lines.push("    none");
  } else {
    const bought = facts.cloudServerChanges.filter((change) => change.fromRam === null).length;
    const upgraded = facts.cloudServerChanges.length - bought;
    lines.push(
      `    in all: ${bought} bought, ${upgraded} upgraded${currentNode === 1 ? `, ${formatMoney(total)}` : ""}`,
    );
  }
  // The brain's rule waits outside BN1 (cloud-servers.ts): said here, so a run with none bought isn't a mystery.
  if (isNumber(currentNode) && currentNode !== 1) {
    lines.push(`    the brain buys none in BitNode ${currentNode}: cloud server prices are known only in BN1`);
  }
  return lines;
}

// --- 4. Health --------------------------------------------------------------------------------------------------------

/** Each check prints what it found, and adds a line to `failures` for each failure. */
function healthSection(
  facts: RunFacts,
  gapThresholdMs: number,
  failures: string[],
  incidents: readonly ClockIncident[],
): string[] {
  const lines = ["4. Health"];
  const heartbeat = heartbeatLines(facts, gapThresholdMs, failures);
  lines.push(...heartbeat.lines);
  lines.push(`  ${describePageHeap(facts.fastTimes.map((point) => point.pageHeapUsedBytes).filter(isNumber))}`);
  // Clock steps and page stalls (#241): each, and 3 or more in an hour a failure.
  lines.push(...incidentLines(incidents, failures));
  lines.push(...stallLines(facts, heartbeat.gaps, failures));

  lines.push(`  stuck intents (${INTENT_STUCK_AFTER_TRIES} tries or more, not done at the last look):`);
  let stuck = 0;
  for (const { id, outcome } of intentEpisodes(facts)) {
    if (outcome.done || outcome.tries < INTENT_STUCK_AFTER_TRIES) continue;
    stuck++;
    const line = `intent stuck: ${id}, ${describeIntent(outcome)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (stuck === 0) lines.push("    none");
  lines.push(...backdoorHealthLines(facts, failures));
  lines.push(...factionWorkHealthLines(facts, failures));
  lines.push(...invitationHealthLines(facts.events, failures, formatIsoTime));
  lines.push(
    ...facts.augmentations.healthLines(facts.events, {
      untilMs: facts.untilMs,
      withinMs: INSTALL_NOT_RESTARTED_AFTER_MS,
      augmentationsEnabled: facts.augmentationsEnabled,
      failures,
      formatTime: formatIsoTime,
    }),
  );
  lines.push(...facts.worldDaemon.healthLines(facts.events, failures, formatIsoTime));

  // Done, but not as asked (#194): a server bought under another name.
  lines.push("  cloud server purchases done with a problem:");
  let withProblem = 0;
  for (const { id, outcome } of intentEpisodes(facts)) {
    if (!outcome.done || outcome.problem === null) continue;
    if (!id.startsWith("buyServer(") && !id.startsWith("upgradeServer(")) continue;
    withProblem++;
    const line = `cloud server purchase done with a problem: ${id}: ${outcome.problem}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (withProblem === 0) lines.push("    none");

  lines.push("  dialogs left blocking the page:");
  const blocking = blockingEpisodes(facts);
  for (const { dialog, fromMs, toMs } of blocking) {
    const line =
      `dialog left blocking from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}: ` +
      quote(dialog, BLOCKING_QUOTE_LENGTH);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (blocking.length === 0) lines.push("    none");

  lines.push(
    `  faction state unread (slow snapshots in a row whose faction state couldn't be read, #197; ` +
      `${FACTION_STATE_UNREAD_AFTER} or more is a failure):`,
  );
  const folding = facts.factionState;
  for (const { problem, backend, fromMs, toMs, count } of folding.unread) {
    const line =
      `faction state unread from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} (${count} slow ` +
      `${count === 1 ? "snapshot" : "snapshots"} in a row${backend === null ? "" : `, ${backend}`}): ${problem}`;
    if (count >= FACTION_STATE_UNREAD_AFTER) {
      lines.push(`    ${line}`);
      failures.push(line);
    } else {
      lines.push(`    ${line}; under ${FACTION_STATE_UNREAD_AFTER} in a row, not counted`);
    }
  }
  if (folding.unread.length === 0) lines.push("    none");
  const others = [
    folding.skipped > 0 ? `${folding.skipped} skipped (no sidebar on the page)` : null,
    folding.absent > 0 ? `${folding.absent} from an older Agent, with no faction state` : null,
    folding.notRestored > 0
      ? `${folding.notRestored} read, but the page not put back as found (the last: ${folding.lastNotRestored})`
      : null,
  ].filter((each) => each !== null);
  if (others.length > 0) lines.push(`  faction state otherwise: ${others.join("; ")}`);

  lines.push(...disconnectLines(facts, failures));

  lines.push(
    "  deploy failures, version drift, supervision given up, brain messages the Agent refused, restarts that couldn't " +
      "type:",
  );
  const failureEvents = facts.events.filter((event) => FAILURE_EVENT_KINDS.includes(event.kind));
  for (const event of failureEvents) {
    const line = `${formatIsoTime(event.atMs)} ${describeEvent(event, facts.sinceMs)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (failureEvents.length === 0) lines.push("    none");
  return lines;
}

interface BlockingEpisode {
  dialog: string;
  fromMs: number;
  toMs: number;
}

/** Each stretch a dialog was left blocking, from the first fast snapshot that showed it to the last in a row. */
function blockingEpisodes(facts: RunFacts): BlockingEpisode[] {
  const episodes: BlockingEpisode[] = [];
  let current = null as BlockingEpisode | null;
  for (const { atMs, blocking } of facts.fast) {
    if (typeof blocking !== "string") {
      current = null;
      continue;
    }
    if (current?.dialog === blocking) {
      current.toMs = atMs;
      continue;
    }
    current = { dialog: blocking, fromMs: atMs, toMs: atMs };
    episodes.push(current);
  }
  return episodes;
}

/**
 * Income stalls. A failure only while the hack loop's switch is on (the dashboard's, now): with it off, money needn't
 * rise. A stall over a heartbeat gap says so, since the money between went unseen.
 */
function stallLines(facts: RunFacts, gaps: Gap[], failures: string[]): string[] {
  const heading =
    `  income stalls (money in the medium snapshots not rising for ${formatDuration(INCOME_STALLED_AFTER_MS)} or ` +
    "more, after it first rose)";
  const lines = [
    facts.hackLoopEnabled
      ? `${heading}:`
      : `${heading}: the hack loop is switched off now, so these are shown, not counted:`,
  ];
  const stalls = findIncomeStalls(facts.money, INCOME_STALLED_AFTER_MS);
  for (const stall of stalls) {
    const end = stall.ongoing
      ? `${formatIsoTime(stall.toMs)}, the last snapshot, still stalled`
      : formatIsoTime(stall.toMs);
    const spanned = gaps.filter((gap) => gap.fromMs < stall.toMs && gap.toMs > stall.fromMs);
    const overGaps =
      spanned.length === 0
        ? ""
        : `; spans ${spanned.length === 1 ? "a heartbeat gap" : "heartbeat gaps"} of ` +
          spanned.map((gap) => formatDuration(gap.lengthMs)).join(", ");
    const line =
      `income stalled from ${formatIsoTime(stall.fromMs)} to ${end} (${formatDuration(stall.lengthMs)}): money ` +
      `${formatMoney(stall.moneyFrom)} → ${formatMoney(stall.moneyTo)}${overGaps}`;
    lines.push(`    ${line}`);
    if (facts.hackLoopEnabled) failures.push(line);
  }
  if (stalls.length === 0) lines.push("    none");
  return lines;
}

/** The run's last record: its newest fast snapshot or event. Silence after it is the run having ended. */
function runEndMs(facts: RunFacts): number | null {
  // Events are in the order stored, which isn't always the order of their times.
  const times = [...facts.fastTimes.slice(-1), ...facts.events].map(({ atMs }) => atMs);
  return times.length === 0 ? null : times.reduce((latest, time) => Math.max(latest, time));
}

/**
 * What explains a silence from `fromMs` to `toMs`: the restart events recorded in it, and a reset intent the Agent held
 * at the last fast snapshot before it. A restart is still a failure; this says which.
 */
function explainSilence(facts: RunFacts, fromMs: number, toMs: number): string {
  const during = facts.events
    .filter((event) => RESTART_EVENT_KINDS.includes(event.kind) && event.atMs >= fromMs && event.atMs <= toMs)
    .map((event) => `${event.kind} at ${formatIsoTime(event.atMs)}`);
  const resets = resetIntentsHeld(facts, fromMs);
  return (
    (during.length === 0 ? "; nothing recorded during it" : `; during it: ${during.join(", ")}`) +
    (resets.length === 0 ? "" : `; before it, the Agent held ${resets.join(", ")}`)
  );
}

/** The reset intents (an install, a destroy) the Agent held at its last fast snapshot by `atMs`. */
function resetIntentsHeld(facts: RunFacts, atMs: number): string[] {
  const before = facts.fast.filter((point) => point.atMs <= atMs).at(-1);
  return (before?.intents ?? [])
    .filter((outcome) => RESET_ACTIONS.some((action) => outcome.id.startsWith(`${action}(`)))
    .map((outcome) => outcome.id);
}

/**
 * The gaps in the heartbeat from the first fast snapshot to the run's last record, as `npm run gaps` finds them. The
 * silence before the first (the game starting, the Agent deployed) and after the last record (the run stopped) is
 * shown, not counted. So is a gap a reload explains (#240): one that follows a destroy or an install sent (the brain's
 * or yours), a deploy, or the reset intent the Agent held (`reloadBeforeGap`), and is that reload alone
 * (`notTheReloadAlone`).
 */
function heartbeatLines(facts: RunFacts, gapThresholdMs: number, failures: string[]): { lines: string[]; gaps: Gap[] } {
  // Every fast snapshot's, a thinned one's too (#283): its time holds.
  const times = facts.fastTimes.map(({ atMs }) => atMs);
  const first = times[0];
  const last = times.at(-1);
  const endMs = runEndMs(facts);
  if (first === undefined || last === undefined || endMs === null) {
    const line = "no fast snapshot (the heartbeat) in the window: the Agent never reported";
    failures.push(line);
    return { lines: [`  heartbeat: ${line}`], gaps: [] };
  }
  const lines = [
    `  heartbeat (fast snapshots), threshold ${formatSeconds(gapThresholdMs)}, from the first snapshot to the run's ` +
      "last record:",
    `    ${times.length} snapshots, first ${formatIsoTime(first)}, last ${formatIsoTime(last)}; before the first, ` +
      `${formatDuration(first - facts.sinceMs)} from the window's start; after the run's last record ` +
      `(${formatIsoTime(endMs)}), ${formatDuration(facts.untilMs - endMs)} to its end`,
  ];
  if (!(endMs > first)) return { lines, gaps: [] };
  const report = findGaps(times, { sinceMs: first, untilMs: endMs, thresholdMs: gapThresholdMs });
  lines.push(`    longest interval ${formatSeconds(report.longestIntervalMs)}`);
  // One reload's event explains one gap: a second gap after it is a new Agent's own.
  const reloadsUsed = new Set<StoredEvent>();
  for (const gap of report.gaps) {
    const line =
      `gap: ${formatIsoTime(gap.fromMs)} to ${formatIsoTime(gap.toMs)} (${formatSeconds(gap.lengthMs)})` +
      explainSilence(facts, gap.fromMs, gap.toMs);
    const reload = reloadBeforeGap(facts, gap, reloadsUsed);
    if (reload === null) {
      lines.push(`    ${line}`);
      failures.push(line);
      continue;
    }
    if (reload.event !== null) reloadsUsed.add(reload.event);
    const problem = notTheReloadAlone(facts, gap, gapThresholdMs);
    if (problem === null) {
      lines.push(`    ${line} (expected: ${reload.description})`);
      continue;
    }
    const failure = `${line} (not expected: ${reload.description}, but ${problem})`;
    lines.push(`    ${failure}`);
    failures.push(failure);
  }
  if (report.gaps.length === 0) lines.push("    no gaps");
  return { lines, gaps: report.gaps };
}

/** A reload a gap follows (#240): "the game reloading after …", and its event (null for a reset intent held). */
interface ReloadCause {
  description: string;
  event: StoredEvent | null;
}

/**
 * The reload a gap follows (#240): the latest destroy or install sent, or deploy, not yet used for a gap, from its
 * kind's lead before the gap's start to `RELOAD_LAG_MS` into it; else a reset intent the Agent held at the gap's start
 * (a round later than the lead); or null.
 */
function reloadBeforeGap(facts: RunFacts, gap: Gap, reloadsUsed: ReadonlySet<StoredEvent>): ReloadCause | null {
  const latestUntilMs = Math.min(gap.fromMs + RELOAD_LAG_MS, gap.toMs);
  const candidates = [...facts.reloadsBefore, ...facts.events].filter((event) => {
    const kind = RELOAD_KINDS[event.kind];
    return (
      kind !== undefined &&
      !reloadsUsed.has(event) &&
      event.atMs >= gap.fromMs - kind.leadMs &&
      event.atMs <= latestUntilMs
    );
  });
  const latest = candidates.reduce<StoredEvent | null>(
    (latestSoFar, event) => (latestSoFar === null || event.atMs >= latestSoFar.atMs ? event : latestSoFar),
    null,
  );
  if (latest !== null) {
    const kind = RELOAD_KINDS[latest.kind] as ReloadKind;
    return {
      description: `${kind.restarting} after ${kind.event} at ${formatIsoTime(latest.atMs)}`,
      event: latest,
    };
  }
  const [held] = resetIntentsHeld(facts, gap.fromMs);
  return held === undefined
    ? null
    : { description: `the game reloading after the ${held} the Agent held`, event: null };
}

/**
 * Why a gap a reload explains isn't that reload alone (#240), or null: a restart besides it in the gap (the brain's,
 * the game relaunched); no Agent connecting in it; longer than `RELOAD_GAP_BOUND_MS`; or silent for more than the
 * heartbeat's threshold after the Agent's last connect in it.
 */
function notTheReloadAlone(facts: RunFacts, gap: Gap, gapThresholdMs: number): string | null {
  const inGap = facts.events.filter((event) => event.atMs >= gap.fromMs && event.atMs <= gap.toMs);
  const restarts = inGap
    .filter((event) => RESTARTS_BESIDES_A_RELOAD.includes(event.kind))
    .map((event) => `${event.kind} at ${formatIsoTime(event.atMs)}`);
  if (restarts.length > 0) return `a restart in it too: ${restarts.join(", ")}`;
  const connects = inGap.filter((event) => event.kind === "agentConnected");
  if (connects.length === 0) return "no Agent connected in it";
  // In figures that can't round to the bound: a gap 1 ms over it is "60.001 s long".
  if (gap.lengthMs > RELOAD_GAP_BOUND_MS) {
    return `${gap.lengthMs / 1000} s long, over the ${RELOAD_GAP_BOUND_MS / 1000} s allowed`;
  }
  const lastConnectMs = Math.max(...connects.map((event) => event.atMs));
  const silentMs = gap.toMs - lastConnectMs;
  if (silentMs > gapThresholdMs) {
    return `silent for ${formatSeconds(silentMs)} after the Agent connected at ${formatIsoTime(lastConnectMs)}`;
  }
  return null;
}

/**
 * Each Agent disconnect with no reconnect within `RECONNECT_WITHIN_MS`. Not a failure where the window ends before
 * that much time has passed, or where the run ended there (nothing recorded after it). A reload in the
 * `RELOAD_LEAD_MS` before it is named (#240): the disconnect was expected, not its length.
 */
function disconnectLines(facts: RunFacts, failures: string[]): string[] {
  const lines = [`  Agent disconnects with no reconnect within ${formatDuration(RECONNECT_WITHIN_MS)}:`];
  const endMs = runEndMs(facts) ?? facts.sinceMs;
  let count = 0;
  for (const disconnect of facts.events.filter((event) => event.kind === "agentDisconnected")) {
    const deadlineMs = disconnect.atMs + RECONNECT_WITHIN_MS;
    // The same millisecond counts: a replaced session's disconnect and its successor's connect are recorded together.
    const reconnect = facts.events.find(
      (event) => event.kind === "agentConnected" && event.atMs >= disconnect.atMs && event.atMs <= deadlineMs,
    );
    if (reconnect || deadlineMs > facts.untilMs || endMs <= disconnect.atMs) continue;
    count++;
    const next = facts.events.find((event) => event.kind === "agentConnected" && event.atMs > deadlineMs);
    const reload = [...facts.reloadsBefore, ...facts.events]
      .filter(
        (event) =>
          Object.hasOwn(RELOAD_KINDS, event.kind) &&
          event.atMs >= disconnect.atMs - RELOAD_LEAD_MS &&
          event.atMs <= disconnect.atMs,
      )
      .reduce<StoredEvent | null>(
        (latestSoFar, event) => (latestSoFar === null || event.atMs >= latestSoFar.atMs ? event : latestSoFar),
        null,
      );
    const line =
      `Agent disconnected at ${formatIsoTime(disconnect.atMs)} (session ` +
      `${displayValue(fieldsOf(disconnect.detail).agentSessionId)}) ` +
      (next ? `and reconnected only at ${formatIsoTime(next.atMs)}` : "and never reconnected in the window") +
      // What happened meanwhile, the disconnect and the reconnect themselves aside.
      explainSilence(facts, disconnect.atMs + 1, next ? next.atMs - 1 : endMs) +
      (reload === null
        ? ""
        : `; just before it, ${(RELOAD_KINDS[reload.kind] as ReloadKind).event} at ${formatIsoTime(reload.atMs)}`);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (count === 0) lines.push("    none");
  return lines;
}
