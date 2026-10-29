// The run report (#185, owner decision 45): what a run did and what went wrong, from the store alone, for a person (and
// Claude) to read after a live run instead of a manual smoke test. Read-only: it records nothing, and reads only what
// the brain already stores (snapshots, events and the hack loop's switch), in one read transaction, folding the
// snapshots row by row so a long run's window never sits in memory whole.
import {
  type FastSnapshotData,
  HACKER_FACTION_SERVERS,
  type HandledDialog,
  type IntentOutcome,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
  type WorkOutcome,
} from "@bitburner-agent/core";
import { BACKDOOR_OVERDUE_AFTER_MS, BackdoorTimeline } from "./backdoors.ts";
import { INCOME_STALLED_AFTER_MS, INTENT_STUCK_AFTER_TRIES } from "./dashboard/alerts.ts";
import { BRAIN_STARTED_EVENT_KIND } from "./dashboard/status.ts";
import {
  DEFAULT_GAP_THRESHOLD_MS,
  describePageHeap,
  findGaps,
  formatIsoTime,
  formatSeconds,
  type Gap,
} from "./gap-report.ts";
import { readHackLoopEnabled } from "./hack-loop.ts";
import { WORK_PROMOTION_EVENT_KIND } from "./record-channel-events.ts";
import { RELAUNCH_EVENT_KIND, SUPERVISION_GAVE_UP_EVENT_KIND } from "./supervision.ts";
import type { Environment, StoredEvent, TelemetryStore } from "./telemetry-store.ts";

/** An Agent disconnect with no reconnect within this is a failure, unless the run ended there. */
export const RECONNECT_WITHIN_MS = 60_000;
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
  "deployed",
  "deployFailed",
  "supervisionFailed",
  SUPERVISION_GAVE_UP_EVENT_KIND,
];
/** The events that are failures in themselves. */
const FAILURE_EVENT_KINDS = ["deployFailed", "versionDrift", SUPERVISION_GAVE_UP_EVENT_KIND];

export interface RunWindow {
  environment: Environment;
  sinceMs: number;
  untilMs: number;
}

export interface RunReport {
  /** The whole report, the verdict last. */
  text: string;
  /** One line per failure; none is PASS. */
  failures: string[];
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
 * The hack loop's target over time, inferred, one medium snapshot at a time: a server's money and security change only
 * when a script hacks, grows or weakens it, so the game's servers whose money or security moved between consecutive
 * medium snapshots are the ones being worked. An inference, not a record: the owner's own scripts move servers too.
 * Stretches where nothing moved don't end one. `ignored` are the player's own servers (home, purchased).
 */
class HackTargetInference {
  readonly stretches: MovedServers[] = [];
  #before: Map<string, string> | null = null;
  readonly #ignored: ReadonlySet<string>;

  constructor(ignored: ReadonlySet<string>) {
    this.#ignored = ignored;
  }

  add(atMs: number, data: MediumSnapshotData): void {
    const before = this.#before;
    const after = serverStates(data);
    this.#before = after;
    if (before === null) return;
    const moved = [...after]
      .filter(
        ([hostname, state]) => !this.#ignored.has(hostname) && before.has(hostname) && before.get(hostname) !== state,
      )
      .map(([hostname]) => hostname)
      .sort();
    if (moved.length === 0) return;
    const current = this.stretches.at(-1);
    if (current && current.servers.join() === moved.join()) current.toMs = atMs;
    else this.stretches.push({ servers: moved, fromMs: atMs, toMs: atMs });
  }
}

/** `HackTargetInference` over a list of medium snapshots. */
export function inferHackTargets(
  medium: { atMs: number; data: MediumSnapshotData }[],
  ignored: ReadonlySet<string>,
): MovedServers[] {
  const inference = new HackTargetInference(ignored);
  for (const { atMs, data } of medium) inference.add(atMs, data);
  return inference.stretches;
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

// --- Reading the store ------------------------------------------------------------------------------------------------

/** What the report keeps of each fast snapshot: not the home processes, the bulk of it. */
interface FastPoint {
  atMs: number;
  pageHeapUsedBytes: unknown;
  homeRamUsed: unknown;
  intents: IntentOutcome[];
  blocking: unknown;
  /** Absent from an older Agent. */
  work: WorkOutcome | null | undefined;
}

/** What the report reads from the store for a window, folded as it's read. */
interface RunFacts extends RunWindow {
  events: StoredEvent[];
  fast: FastPoint[];
  mediumFirst: MediumSnapshotData | undefined;
  mediumLast: MediumSnapshotData | undefined;
  /** The medium snapshots' money, where it's a number. */
  money: MoneyPoint[];
  targets: MovedServers[];
  /** The hacker factions' servers' backdoors over the medium snapshots (#195). */
  backdoors: BackdoorTimeline;
  slowFirst: SlowSnapshotData | undefined;
  slowLast: SlowSnapshotData | undefined;
  snapshotCount: number;
  /** Home and the player's purchased servers (static and slow snapshots): not the hack loop's targets. */
  playersServers: Set<string>;
  /** The dashboard's switch, now: the store keeps no history of it. */
  hackLoopEnabled: boolean;
  /** The newest brain start in the day before the window, if any: the window may not be the whole run. */
  earlierBrainStartMs: number | null;
}

const isObject = (data: unknown): data is object => data !== null && typeof data === "object";

function readFacts(store: TelemetryStore, window: RunWindow): RunFacts {
  return store.readTransaction(() => {
    function* ofTier<Data>(tier: string): Generator<{ atMs: number; data: Data }> {
      for (const snapshot of store.iterateSnapshotsInWindow({ ...window, tier })) {
        if (isObject(snapshot.data)) yield { atMs: snapshot.receivedAtMs, data: snapshot.data as Data };
      }
    }
    let snapshotCount = 0;
    // The player's servers first, from the static and slow snapshots, so the medium ones can be read in one pass.
    const playersServers = new Set(["home"]);
    const backdoors = new BackdoorTimeline();
    for (const { atMs, data } of ofTier<StaticSnapshotData>("static")) {
      snapshotCount++;
      backdoors.addStatic(atMs, data);
      for (const server of Array.isArray(data.servers) ? data.servers : []) {
        if (server?.purchasedByPlayer === true) playersServers.add(server.hostname);
      }
    }
    let slowFirst: SlowSnapshotData | undefined;
    let slowLast: SlowSnapshotData | undefined;
    for (const { data } of ofTier<SlowSnapshotData>("slow")) {
      snapshotCount++;
      slowFirst ??= data;
      slowLast = data;
      for (const name of namesOf(data.purchasedServers)) playersServers.add(name);
    }
    let mediumFirst: MediumSnapshotData | undefined;
    let mediumLast: MediumSnapshotData | undefined;
    const money: MoneyPoint[] = [];
    const inference = new HackTargetInference(playersServers);
    for (const { atMs, data } of ofTier<MediumSnapshotData>("medium")) {
      snapshotCount++;
      mediumFirst ??= data;
      mediumLast = data;
      const playerMoney = playerOf(data).money;
      if (typeof playerMoney === "number") money.push({ atMs, money: playerMoney });
      inference.add(atMs, data);
      backdoors.addMedium(atMs, data);
    }
    const fast: FastPoint[] = [];
    for (const { atMs, data } of ofTier<Partial<FastSnapshotData>>("fast")) {
      snapshotCount++;
      fast.push({
        atMs,
        pageHeapUsedBytes: data.pageHeapUsedBytes,
        homeRamUsed: data.game?.homeRamUsed,
        intents: Array.isArray(data.intents) ? data.intents.filter((outcome) => typeof outcome?.id === "string") : [],
        blocking: data.dialogs?.blocking,
        work: data.work,
      });
    }
    const earlierStarts = store
      .eventsInWindow({
        environment: window.environment,
        sinceMs: window.sinceMs - EARLIER_START_LOOKBACK_MS,
        untilMs: window.sinceMs - 1,
      })
      .filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND);
    return {
      ...window,
      events: store.eventsInWindow(window),
      fast,
      mediumFirst,
      mediumLast,
      money,
      targets: inference.stretches,
      backdoors,
      slowFirst,
      slowLast,
      snapshotCount,
      playersServers,
      hackLoopEnabled: readHackLoopEnabled(store),
      earlierBrainStartMs: earlierStarts.at(-1)?.atMs ?? null,
    };
  });
}

/**
 * The run report for a window of the store. Throws for a window that ends before it starts, or one with nothing in it:
 * it would check nothing, and must never pass.
 */
export function runReport(
  store: TelemetryStore,
  window: RunWindow,
  { gapThresholdMs = DEFAULT_GAP_THRESHOLD_MS }: { gapThresholdMs?: number } = {},
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
  const lines = [
    `Run report (${window.environment}) from ${formatIsoTime(window.sinceMs)} to ${formatIsoTime(window.untilMs)} ` +
      `(${formatDuration(window.untilMs - window.sinceMs)})`,
    "",
    ...windowSection(facts),
    "",
    ...progressSection(facts),
    "",
    ...actionsSection(facts),
    "",
    ...healthSection(facts, gapThresholdMs, failures),
    "",
    failures.length === 0 ? "Verdict: PASS" : "Verdict: FAIL",
    ...failures.map((failure) => `  ${failure}`),
  ];
  return { text: lines.join("\n"), failures };
}

// --- Formatting -------------------------------------------------------------------------------------------------------

/** "29 s", "10 min", "24 min 20 s", "1 h 14 min": to the second under an hour, to the minute over. */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  return `${seconds} s`;
}

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

/** The events of the brain, the Agent's sessions and the save backups, in order; dialogs and promotions are actions. */
function windowSection(facts: RunFacts): string[] {
  const lines = ["1. The window"];
  if (facts.earlierBrainStartMs !== null) {
    lines.push(
      `  note: the brain also started at ${formatIsoTime(facts.earlierBrainStartMs)}, ` +
        `${formatDuration(facts.sinceMs - facts.earlierBrainStartMs)} before the window: for a run that spans a ` +
        "restart, give --since",
    );
  }
  const timeline = facts.events.filter(
    (event) => event.kind !== "gameDialog" && event.kind !== WORK_PROMOTION_EVENT_KIND,
  );
  for (const event of timeline) lines.push(`  ${formatIsoTime(event.atMs)}  ${describeEvent(event)}`);
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

function describeEvent({ kind, detail }: StoredEvent): string {
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
    case "saveBackupRotationFailed":
      return `old save backups not removed: ${displayValue(fields.failure)}`;
    case "supervisionFailed":
      return `supervisor's check failed (${displayValue(fields.cause)}): ${displayValue(fields.failure)}`;
    case SUPERVISION_GAVE_UP_EVENT_KIND:
      return `supervisor GAVE UP: ${JSON.stringify(detail)}`;
    case "connectionRejected":
      return `connection rejected (${displayValue(fields.reason)}): ${displayValue(fields.detail)}`;
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

/** Start to end, from the first and last snapshots of each tier in the window. */
function progressSection(facts: RunFacts): string[] {
  const lines = ["2. Progress, first snapshot → last"];
  const first = facts.mediumFirst;
  const last = facts.mediumLast;
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
  const fastFirst = facts.fast[0];
  const fastLast = facts.fast.at(-1);
  if (fastFirst !== undefined && fastLast !== undefined) {
    lines.push(
      `  home RAM used: ${describeChange(formatGigabytes(fastFirst.homeRamUsed), formatGigabytes(fastLast.homeRamUsed))}`,
    );
  }
  if (first !== undefined && last !== undefined) {
    const yesOrNo = (data: MediumSnapshotData) => (data.hasTorRouter ? "yes" : "no");
    lines.push(`  TOR router: ${describeChange(yesOrNo(first), yesOrNo(last))}`);
    lines.push(
      `  port openers: ${describeChange(listOrNone(namesOf(first.programs)), listOrNone(namesOf(last.programs)))}`,
    );
    const rooted = (data: MediumSnapshotData) =>
      (Array.isArray(data.servers) ? data.servers : []).filter(
        (server) => server?.hasAdminRights === true && !facts.playersServers.has(server.hostname),
      ).length;
    lines.push(`  the game's servers rooted: ${describeChange(String(rooted(first)), String(rooted(last)))}`);
    const [playerFirst, playerLast] = [playerOf(first), playerOf(last)];
    lines.push(`  city: ${describeChange(displayValue(playerFirst.city), displayValue(playerLast.city))}`);
    lines.push(
      `  factions: ${describeChange(listOrNone(namesOf(playerFirst.factions)), listOrNone(namesOf(playerLast.factions)))}`,
    );
    lines.push(`  jobs: ${describeChange(listOrNone(jobsOf(playerFirst.jobs)), listOrNone(jobsOf(playerLast.jobs)))}`);
  }
  const { slowFirst, slowLast } = facts;
  if (slowFirst === undefined || slowLast === undefined) {
    lines.push("  no slow snapshot (the BitNode, augmentations, Source-Files, purchased servers) in the window");
  } else {
    const augmentations = (data: SlowSnapshotData) => Object.keys(fieldsOf(data.resetInfo?.ownedAugs)).sort();
    lines.push(
      `  installed augmentations: ${describeChange(listOrNone(augmentations(slowFirst)), listOrNone(augmentations(slowLast)))}`,
    );
    lines.push(
      `  BitNode: ${describeChange(displayValue(slowFirst.resetInfo?.currentNode), displayValue(slowLast.resetInfo?.currentNode))}`,
    );
    lines.push(
      `  Source-Files: ${describeChange(listOrNone(sourceFilesOf(slowFirst)), listOrNone(sourceFilesOf(slowLast)))}`,
    );
    lines.push(
      `  purchased servers: ${describeChange(listOrNone(namesOf(slowFirst.purchasedServers)), listOrNone(namesOf(slowLast.purchasedServers)))}`,
    );
  }
  lines.push(
    "  hack loop target, inferred from the game's servers whose money or security moved between medium snapshots " +
      "(the owner's own scripts would show too):",
  );
  for (const stretch of facts.targets) {
    lines.push(
      `    ${stretch.servers.join(" + ")}: ${formatIsoTime(stretch.fromMs)} to ${formatIsoTime(stretch.toMs)}`,
    );
  }
  if (facts.targets.length === 0) lines.push("    none moved");
  return lines;
}

// --- 3. Actions -------------------------------------------------------------------------------------------------------

/** One intent from when it was given to when it was done, or last seen: an id given again later is another. */
interface IntentEpisode {
  id: string;
  outcome: IntentOutcome;
  firstSeenMs: number;
  doneAtMs: number | null;
}

/**
 * Each intent episode in the window, in the order first seen, with its latest outcome. The same id starts a new episode
 * when it's seen not done after being done, or with fewer tries (given again, after a reset say).
 */
function intentEpisodes(facts: RunFacts): IntentEpisode[] {
  const episodes: IntentEpisode[] = [];
  const current = new Map<string, IntentEpisode>();
  for (const { atMs, intents } of facts.fast) {
    for (const outcome of intents) {
      const known = current.get(outcome.id);
      if (known === undefined || (known.outcome.done && !outcome.done) || outcome.tries < known.outcome.tries) {
        const episode = { id: outcome.id, outcome, firstSeenMs: atMs, doneAtMs: outcome.done ? atMs : null };
        episodes.push(episode);
        current.set(outcome.id, episode);
        continue;
      }
      known.outcome = outcome;
      if (outcome.done) known.doneAtMs ??= atMs;
    }
  }
  return episodes;
}

function describeIntent(outcome: IntentOutcome): string {
  const backend = outcome.backend === null ? "" : ` (${outcome.backend})`;
  const tries = `${outcome.tries} ${outcome.tries === 1 ? "try" : "tries"}${backend}`;
  return outcome.done
    ? `done after ${tries}`
    : `not done, ${tries}${outcome.problem === null ? "" : `: ${outcome.problem}`}`;
}

function actionsSection(facts: RunFacts): string[] {
  const lines = ["3. Actions", "  intents:"];
  const episodes = intentEpisodes(facts);
  for (const { id, outcome, firstSeenMs, doneAtMs } of episodes) {
    const when = doneAtMs === null ? `first seen ${formatIsoTime(firstSeenMs)}` : `done by ${formatIsoTime(doneAtMs)}`;
    lines.push(`    ${id}: ${describeIntent(outcome)}; ${when}`);
  }
  if (episodes.length === 0) lines.push("    none");

  lines.push("  work, as it changed:");
  let previous: string | undefined;
  let changes = 0;
  for (const { atMs, work } of facts.fast) {
    if (work === undefined) continue;
    const described =
      work === null
        ? "none wanted"
        : `${work.converged ? "converged" : "not converged"}${work.backend ? ` (${work.backend})` : ""}` +
          `${work.problem ? `: ${work.problem}` : ""}`;
    if (described === previous) continue;
    previous = described;
    changes++;
    lines.push(`    ${formatIsoTime(atMs)}  ${described}`);
  }
  if (changes === 0) lines.push("    not reported");

  lines.push("  promotions:");
  const promotions = facts.events.filter((event) => event.kind === WORK_PROMOTION_EVENT_KIND);
  for (const { atMs, detail } of promotions) {
    const fields = fieldsOf(detail);
    lines.push(
      `    ${formatIsoTime(atMs)}  ${displayValue(fields.company)}: ${displayValue(fields.from)} → ${displayValue(fields.to)}`,
    );
  }
  if (promotions.length === 0) lines.push("    none");

  lines.push("  dialogs handled:");
  const dialogs = facts.events.filter((event) => event.kind === "gameDialog");
  for (const { atMs, detail } of dialogs) {
    const dialog = fieldsOf(detail) as Partial<HandledDialog>;
    lines.push(
      `    ${formatIsoTime(atMs)}  ${displayValue(dialog.kind)}: ${quote(displayValue(dialog.text), DIALOG_QUOTE_LENGTH)}`,
    );
  }
  if (dialogs.length === 0) lines.push("    none");
  lines.push(...backdoorLines(facts));
  return lines;
}

/**
 * The hacker factions' servers (#195): when the medium snapshots first showed each backdoored (or gone again, after a
 * reset), and the invitation that followed, where the Agent handled its dialog: a `gameDialog` event of kind
 * `factionInvitation` naming the faction ("Would you like to join CyberSec?").
 */
function backdoorLines(facts: RunFacts): string[] {
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
    lines.push(`    ${hostname}: ${[...changes, ...invited].join("; ")}`);
  }
  return lines;
}

/**
 * Backdoors overdue (#195): a stretch of `BACKDOOR_OVERDUE_AFTER_MS` or more in which the medium snapshots showed one
 * of the hacker factions' servers rooted, at its level and not backdoored: the brain asks for it at once, and it takes
 * seconds. And backdoors asked for again: a `backdoor` intent on one of them first seen while the medium snapshots
 * showed it backdoored (not the window's first fast snapshot's, which may be from before).
 */
function backdoorHealthLines(facts: RunFacts, failures: string[]): string[] {
  const lines = [
    "  backdoors overdue (one of the hacker factions' servers rooted, at its level and not backdoored for " +
      `${formatDuration(BACKDOOR_OVERDUE_AFTER_MS)} or more):`,
  ];
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
  for (const { id, firstSeenMs } of intentEpisodes(facts)) {
    const hostname = HACKER_FACTION_SERVERS.find((server) => id === `backdoor(${server.hostname})`)?.hostname;
    if (hostname === undefined || firstSeenMs === firstFastMs) continue;
    if (!facts.backdoors.installedAt(hostname, firstSeenMs)) continue;
    repeated++;
    const line = `backdoor repeated: ${id} first seen ${formatIsoTime(firstSeenMs)}, with ${hostname} backdoored`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (repeated === 0) lines.push("    none");
  return lines;
}

// --- 4. Health --------------------------------------------------------------------------------------------------------

/** Each check prints what it found, and adds a line to `failures` for each failure. */
function healthSection(facts: RunFacts, gapThresholdMs: number, failures: string[]): string[] {
  const lines = ["4. Health"];
  const heartbeat = heartbeatLines(facts, gapThresholdMs, failures);
  lines.push(...heartbeat.lines);
  lines.push(`  ${describePageHeap(facts.fast.map((point) => point.pageHeapUsedBytes).filter(isNumber))}`);
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

  lines.push(...disconnectLines(facts, failures));

  lines.push("  deploy failures, version drift, supervision given up:");
  const failureEvents = facts.events.filter((event) => FAILURE_EVENT_KINDS.includes(event.kind));
  for (const event of failureEvents) {
    const line = `${formatIsoTime(event.atMs)} ${describeEvent(event)}`;
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
  const times = [...facts.fast.slice(-1), ...facts.events].map(({ atMs }) => atMs);
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
  const before = facts.fast.filter((point) => point.atMs <= fromMs).at(-1);
  const resets = (before?.intents ?? [])
    .filter((outcome) => RESET_ACTIONS.some((action) => outcome.id.startsWith(`${action}(`)))
    .map((outcome) => outcome.id);
  return (
    (during.length === 0 ? "; nothing recorded during it" : `; during it: ${during.join(", ")}`) +
    (resets.length === 0 ? "" : `; before it, the Agent held ${resets.join(", ")}`)
  );
}

/**
 * The gaps in the heartbeat from the first fast snapshot to the run's last record, as `npm run gaps` finds them. The
 * silence before the first (the game starting, the Agent deployed) and after the last record (the run stopped) is
 * shown, not counted.
 */
function heartbeatLines(facts: RunFacts, gapThresholdMs: number, failures: string[]): { lines: string[]; gaps: Gap[] } {
  const times = facts.fast.map(({ atMs }) => atMs);
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
  for (const gap of report.gaps) {
    const line =
      `gap: ${formatIsoTime(gap.fromMs)} to ${formatIsoTime(gap.toMs)} (${formatSeconds(gap.lengthMs)})` +
      explainSilence(facts, gap.fromMs, gap.toMs);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (report.gaps.length === 0) lines.push("    no gaps");
  return { lines, gaps: report.gaps };
}

/**
 * Each Agent disconnect with no reconnect within `RECONNECT_WITHIN_MS`. Not a failure where the window ends before
 * that much time has passed, or where the run ended there (nothing recorded after it).
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
    const line =
      `Agent disconnected at ${formatIsoTime(disconnect.atMs)} (session ` +
      `${displayValue(fieldsOf(disconnect.detail).agentSessionId)}) ` +
      (next ? `and reconnected only at ${formatIsoTime(next.atMs)}` : "and never reconnected in the window") +
      // What happened meanwhile, the disconnect and the reconnect themselves aside.
      explainSilence(facts, disconnect.atMs + 1, next ? next.atMs - 1 : endMs);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (count === 0) lines.push("    none");
  return lines;
}
