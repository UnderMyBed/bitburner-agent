// The run report (#185, owner decision 45): what a run did and what went wrong, from the store alone, for a person (and
// Claude) to read after a live run instead of a manual smoke test. Read-only: it records nothing, and reads only what
// the brain already stores (snapshots and events).
import type {
  FastSnapshotData,
  HandledDialog,
  IntentOutcome,
  MediumSnapshotData,
  SlowSnapshotData,
  StaticSnapshotData,
} from "@bitburner-agent/core";
import { INCOME_STALLED_AFTER_MS, INTENT_STUCK_AFTER_TRIES } from "./dashboard/alerts.ts";
import { BRAIN_STARTED_EVENT_KIND } from "./dashboard/status.ts";
import { DEFAULT_GAP_THRESHOLD_MS, describePageHeap, findGaps, formatIsoTime, formatSeconds } from "./gap-report.ts";
import { WORK_PROMOTION_EVENT_KIND } from "./record-channel-events.ts";
import type { Environment, StoredEvent, StoredSnapshot, TelemetryStore } from "./telemetry-store.ts";

/** An Agent disconnect with no reconnect within this is a failure, unless the run ended there. */
export const RECONNECT_WITHIN_MS = 60_000;
/** How much of a handled dialog's text the report quotes. */
const DIALOG_QUOTE_LENGTH = 60;
/** How much of a blocking dialog's text a failure line quotes. */
const BLOCKING_QUOTE_LENGTH = 120;

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

/**
 * Each stretch of `thresholdMs` or more, after money first rose, in which it didn't rise again: a purchase lowers it,
 * which isn't a rise, and the next rise ends the stretch. `points` are in time order.
 */
export function findIncomeStalls(points: { atMs: number; money: number }[], thresholdMs: number): IncomeStall[] {
  const stalls: IncomeStall[] = [];
  let lastRise: { atMs: number; money: number } | null = null;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1] as { atMs: number; money: number };
    const point = points[index] as { atMs: number; money: number };
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

function stallBetween(from: { atMs: number; money: number }, to: { atMs: number; money: number }): IncomeStall {
  return {
    fromMs: from.atMs,
    toMs: to.atMs,
    lengthMs: to.atMs - from.atMs,
    moneyFrom: from.money,
    moneyTo: to.money,
    ongoing: false,
  };
}

/** A stretch of medium snapshots in which the same servers' money or security moved. */
export interface MovedServers {
  servers: string[];
  fromMs: number;
  toMs: number;
}

/**
 * The hack loop's target over time, inferred: a server's money and security change only when a script hacks, grows or
 * weakens it, so the game's servers whose money or security moved between consecutive medium snapshots are the ones
 * being worked. An inference, not a record: the owner's own scripts move servers too. Stretches where nothing moved
 * don't end one. `ignored` are the player's own servers (home, purchased).
 */
export function inferHackTargets(
  medium: { atMs: number; data: MediumSnapshotData }[],
  ignored: ReadonlySet<string>,
): MovedServers[] {
  const stretches: MovedServers[] = [];
  for (let index = 1; index < medium.length; index++) {
    const before = serverStates(medium[index - 1]?.data);
    const after = medium[index] as { atMs: number; data: MediumSnapshotData };
    const moved = [...serverStates(after.data)]
      .filter(([hostname, state]) => !ignored.has(hostname) && before.has(hostname) && before.get(hostname) !== state)
      .map(([hostname]) => hostname)
      .sort();
    if (moved.length === 0) continue;
    const current = stretches.at(-1);
    if (current && current.servers.join() === moved.join()) current.toMs = after.atMs;
    else stretches.push({ servers: moved, fromMs: after.atMs, toMs: after.atMs });
  }
  return stretches;
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

interface Timed<Data> {
  atMs: number;
  data: Data;
}

/** What the report reads from the store for a window. */
interface RunFacts extends RunWindow {
  events: StoredEvent[];
  fast: Timed<Partial<FastSnapshotData>>[];
  medium: Timed<MediumSnapshotData>[];
  slow: Timed<SlowSnapshotData>[];
  staticSnapshots: Timed<StaticSnapshotData>[];
}

function readFacts(store: TelemetryStore, window: RunWindow): RunFacts {
  const ofTier = <Data>(tier: string): Timed<Data>[] =>
    store
      .snapshotsInWindow({ ...window, tier })
      .filter((snapshot: StoredSnapshot) => snapshot.data !== null && typeof snapshot.data === "object")
      .map((snapshot) => ({ atMs: snapshot.receivedAtMs, data: snapshot.data as Data }));
  return {
    ...window,
    events: store.eventsInWindow(window),
    fast: ofTier("fast"),
    medium: ofTier("medium"),
    slow: ofTier("slow"),
    staticSnapshots: ofTier("static"),
  };
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
  const snapshotCount = facts.fast.length + facts.medium.length + facts.slow.length + facts.staticSnapshots.length;
  if (facts.events.length === 0 && snapshotCount === 0) {
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

const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
const listOrNone = (items: string[]) => (items.length === 0 ? "none" : items.join(", "));
const fieldsOf = (detail: unknown) => (detail ?? {}) as Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const quote = (value: string, length: number) =>
  `"${value.length > length ? `${value.slice(0, length).trimEnd()}…` : value}"`;

// --- 1. The window ----------------------------------------------------------------------------------------------------

/** The events of the brain, the Agent's sessions and the save backups, in order; dialogs and promotions are actions. */
function windowSection(facts: RunFacts): string[] {
  const lines = ["1. The window"];
  const timeline = facts.events.filter(
    (event) => event.kind !== "gameDialog" && event.kind !== WORK_PROMOTION_EVENT_KIND,
  );
  for (const event of timeline) lines.push(`  ${formatIsoTime(event.atMs)}  ${describeEvent(event)}`);
  if (timeline.length === 0) lines.push("  no events from the brain or the Agent");
  const count = (kind: string) => timeline.filter((event) => event.kind === kind).length;
  lines.push(
    `  brain starts: ${count(BRAIN_STARTED_EVENT_KIND)}; Agent connections: ${count("agentConnected")}, ` +
      `disconnections: ${count("agentDisconnected")}; relaunches: ${count("relaunch")}; deploys: ${count("deployed")}; ` +
      `save backups: ${timeline.filter((event) => event.kind === "saveBackup" && !fieldsOf(event.detail).failure).length}`,
  );
  return lines;
}

function describeEvent({ kind, detail }: StoredEvent): string {
  const fields = fieldsOf(detail);
  switch (kind) {
    case BRAIN_STARTED_EVENT_KIND:
      return `brain started, release ${text(fields.release)}`;
    case "relaunch":
      return `game relaunched by the supervisor (${text(fields.cause)})`;
    case "agentConnected": {
      const game = fieldsOf(fields.game);
      return (
        `Agent connected: session ${text(fields.agentSessionId)}, deployment ${text(fields.deploymentId)}, game ` +
        `${text(game.version)} (${text(game.platform)})`
      );
    }
    case "agentDisconnected":
      return `Agent disconnected: session ${text(fields.agentSessionId)}`;
    case "deployed":
      return fields.replacedDeploymentId
        ? `deployed ${text(fields.deploymentId)}, replacing ${text(fields.replacedDeploymentId)}`
        : `deployed ${text(fields.deploymentId)}`;
    case "deploymentCurrent":
      return `deployment ${text(fields.deploymentId)} already current`;
    case "deployFailed":
      return `deploy of ${text(fields.deploymentId)} FAILED: ${text(fields.reason)}`;
    case "versionDrift":
      return `version drift: ${text(fields.detail)}`;
    case "saveBackup":
      return fields.failure === undefined
        ? `save backup ${text(fields.file)} (${Math.round(Number(fields.sizeBytes) / 1024)} KB)`
        : `save backup FAILED: ${text(fields.failure)}`;
    case "saveBackupRotationFailed":
      return `old save backups not removed: ${text(fields.failure)}`;
    case "supervisionFailed":
      return `supervisor's check failed (${text(fields.cause)}): ${text(fields.failure)}`;
    case "supervisionGaveUp":
      return `supervisor GAVE UP: ${JSON.stringify(detail)}`;
    case "connectionRejected":
      return `connection rejected (${text(fields.reason)}): ${text(fields.detail)}`;
    default:
      return `${kind}: ${JSON.stringify(detail)}`;
  }
}

// --- 2. Progress ------------------------------------------------------------------------------------------------------

const playerOf = (data: MediumSnapshotData | undefined) => (data?.player ?? {}) as Record<string, unknown>;
const homeRamOf = (data: MediumSnapshotData | undefined) =>
  (Array.isArray(data?.servers) ? data.servers : []).find((server) => server?.hostname === "home")?.maxRam;
const namesOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
const jobsOf = (value: unknown) =>
  Object.entries(fieldsOf(value)).map(([company, title]) => `${company} (${text(title)})`);

/** "first → last", or "last" alone when nothing changed. */
function change(first: string, last: string): string {
  return first === last ? `${last} (unchanged)` : `${first} → ${last}`;
}

/** Start to end, from the first and last snapshots of each tier in the window. */
function progressSection(facts: RunFacts): string[] {
  const lines = ["2. Progress, first snapshot → last"];
  const first = facts.medium[0]?.data;
  const last = facts.medium.at(-1)?.data;
  if (first === undefined || last === undefined) {
    lines.push("  no medium snapshot (the player and the servers) in the window");
  } else {
    const [playerFirst, playerLast] = [playerOf(first), playerOf(last)];
    lines.push(`  money: ${change(formatMoney(Number(playerFirst.money)), formatMoney(Number(playerLast.money)))}`);
    const skillsFirst = fieldsOf(playerFirst.skills);
    const skillsLast = fieldsOf(playerLast.skills);
    lines.push(`  hacking: ${change(text(skillsFirst.hacking), text(skillsLast.hacking))}`);
    const otherSkills = Object.keys(skillsLast).filter((skill) => skill !== "hacking");
    if (otherSkills.length > 0) {
      lines.push(
        `  other skills: ${otherSkills.map((skill) => `${skill} ${text(skillsFirst[skill])} → ${text(skillsLast[skill])}`).join(", ")}`,
      );
    }
    lines.push(`  home RAM: ${change(`${homeRamOf(first)} GB`, `${homeRamOf(last)} GB`)}`);
    lines.push(`  TOR router: ${change(first.hasTorRouter ? "yes" : "no", last.hasTorRouter ? "yes" : "no")}`);
    lines.push(`  port openers: ${change(listOrNone(namesOf(first.programs)), listOrNone(namesOf(last.programs)))}`);
    const ignored = playersServers(facts);
    const rooted = (data: MediumSnapshotData) =>
      (Array.isArray(data.servers) ? data.servers : []).filter(
        (server) => server?.hasAdminRights === true && !ignored.has(server.hostname),
      ).length;
    lines.push(`  the game's servers rooted: ${change(String(rooted(first)), String(rooted(last)))}`);
    lines.push(`  city: ${change(text(playerFirst.city), text(playerLast.city))}`);
    lines.push(
      `  factions: ${change(listOrNone(namesOf(playerFirst.factions)), listOrNone(namesOf(playerLast.factions)))}`,
    );
    lines.push(`  jobs: ${change(listOrNone(jobsOf(playerFirst.jobs)), listOrNone(jobsOf(playerLast.jobs)))}`);
  }
  const slowFirst = facts.slow[0]?.data;
  const slowLast = facts.slow.at(-1)?.data;
  if (slowFirst === undefined || slowLast === undefined) {
    lines.push("  no slow snapshot (the BitNode, augmentations, purchased servers) in the window");
  } else {
    const augmentations = (data: SlowSnapshotData) => Object.keys(fieldsOf(data.resetInfo?.ownedAugs)).sort();
    lines.push(
      `  installed augmentations: ${change(listOrNone(augmentations(slowFirst)), listOrNone(augmentations(slowLast)))}`,
    );
    lines.push(`  BitNode: ${change(text(slowFirst.resetInfo?.currentNode), text(slowLast.resetInfo?.currentNode))}`);
    lines.push(
      `  purchased servers: ${change(listOrNone(namesOf(slowFirst.purchasedServers)), listOrNone(namesOf(slowLast.purchasedServers)))}`,
    );
  }
  lines.push(
    "  hack loop target, inferred from the game's servers whose money or security moved between medium snapshots " +
      "(the owner's own scripts would show too):",
  );
  const stretches = inferHackTargets(facts.medium, playersServers(facts));
  for (const stretch of stretches) {
    lines.push(
      `    ${stretch.servers.join(" + ")}: ${formatIsoTime(stretch.fromMs)} to ${formatIsoTime(stretch.toMs)}`,
    );
  }
  if (stretches.length === 0) lines.push("    none moved");
  return lines;
}

/** Home and the player's purchased servers (static and slow snapshots): not the hack loop's targets. */
function playersServers(facts: RunFacts): Set<string> {
  const names = new Set(["home"]);
  for (const { data } of facts.staticSnapshots) {
    for (const server of Array.isArray(data.servers) ? data.servers : []) {
      if (server?.purchasedByPlayer === true) names.add(server.hostname);
    }
  }
  for (const { data } of facts.slow) for (const name of namesOf(data.purchasedServers)) names.add(name);
  return names;
}

// --- 3. Actions -------------------------------------------------------------------------------------------------------

/** Each intent's latest outcome in the window, in the order first seen, with when it was first seen and seen done. */
function intentsSeen(facts: RunFacts) {
  const seen = new Map<string, { outcome: IntentOutcome; firstSeenMs: number; doneAtMs: number | null }>();
  for (const { atMs, data } of facts.fast) {
    for (const outcome of Array.isArray(data.intents) ? data.intents : []) {
      if (typeof outcome?.id !== "string") continue;
      const known = seen.get(outcome.id);
      const doneAtMs = known?.doneAtMs ?? (outcome.done ? atMs : null);
      seen.set(outcome.id, { outcome, firstSeenMs: known?.firstSeenMs ?? atMs, doneAtMs });
    }
  }
  return seen;
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
  const intents = intentsSeen(facts);
  for (const [id, { outcome, firstSeenMs, doneAtMs }] of intents) {
    const when = doneAtMs === null ? `first seen ${formatIsoTime(firstSeenMs)}` : `done by ${formatIsoTime(doneAtMs)}`;
    lines.push(`    ${id}: ${describeIntent(outcome)}; ${when}`);
  }
  if (intents.size === 0) lines.push("    none");

  lines.push("  work, as it changed:");
  let previous: string | undefined;
  let changes = 0;
  for (const { atMs, data } of facts.fast) {
    if (data.work === undefined) continue;
    const work = data.work;
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
    lines.push(`    ${formatIsoTime(atMs)}  ${text(fields.company)}: ${text(fields.from)} → ${text(fields.to)}`);
  }
  if (promotions.length === 0) lines.push("    none");

  lines.push("  dialogs handled:");
  const dialogs = facts.events.filter((event) => event.kind === "gameDialog");
  for (const { atMs, detail } of dialogs) {
    const dialog = fieldsOf(detail) as Partial<HandledDialog>;
    lines.push(`    ${formatIsoTime(atMs)}  ${text(dialog.kind)}: ${quote(String(dialog.text), DIALOG_QUOTE_LENGTH)}`);
  }
  if (dialogs.length === 0) lines.push("    none");
  return lines;
}

// --- 4. Health --------------------------------------------------------------------------------------------------------

/** Each check prints what it found, and adds a line to `failures` for each failure. */
function healthSection(facts: RunFacts, gapThresholdMs: number, failures: string[]): string[] {
  const lines = ["4. Health"];
  lines.push(...heartbeatLines(facts, gapThresholdMs, failures));
  lines.push(
    `  ${describePageHeap(facts.fast.map(({ data }) => data.pageHeapUsedBytes).filter((bytes) => typeof bytes === "number"))}`,
  );

  lines.push(
    `  income stalls (money in the medium snapshots not rising for ${formatDuration(INCOME_STALLED_AFTER_MS)} or ` +
      "more, after it first rose):",
  );
  const money = facts.medium
    .map(({ atMs, data }) => ({ atMs, money: playerOf(data).money }))
    .filter((point): point is { atMs: number; money: number } => typeof point.money === "number");
  const stalls = findIncomeStalls(money, INCOME_STALLED_AFTER_MS);
  for (const stall of stalls) {
    const end = stall.ongoing
      ? `${formatIsoTime(stall.toMs)}, the last snapshot, still stalled`
      : formatIsoTime(stall.toMs);
    const line =
      `income stalled from ${formatIsoTime(stall.fromMs)} to ${end} (${formatDuration(stall.lengthMs)}): money ` +
      `${formatMoney(stall.moneyFrom)} → ${formatMoney(stall.moneyTo)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (stalls.length === 0) lines.push("    none");

  lines.push(`  stuck intents (${INTENT_STUCK_AFTER_TRIES} tries or more, not done at the last look):`);
  let stuck = 0;
  for (const [id, { outcome }] of intentsSeen(facts)) {
    if (outcome.done || outcome.tries < INTENT_STUCK_AFTER_TRIES) continue;
    stuck++;
    const line = `intent stuck: ${id}, ${describeIntent(outcome)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (stuck === 0) lines.push("    none");

  lines.push("  dialogs left blocking the page:");
  const blocking = new Map<string, { fromMs: number; toMs: number }>();
  for (const { atMs, data } of facts.fast) {
    const dialog = data.dialogs?.blocking;
    if (typeof dialog !== "string") continue;
    blocking.set(dialog, { fromMs: blocking.get(dialog)?.fromMs ?? atMs, toMs: atMs });
  }
  for (const [dialog, { fromMs, toMs }] of blocking) {
    const line =
      `dialog left blocking from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}: ` +
      quote(dialog, BLOCKING_QUOTE_LENGTH);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (blocking.size === 0) lines.push("    none");

  lines.push(...disconnectLines(facts, failures));

  lines.push("  deploy failures, version drift, supervision given up:");
  const held = facts.events.filter((event) =>
    ["deployFailed", "versionDrift", "supervisionGaveUp"].includes(event.kind),
  );
  for (const event of held) {
    const line = `${formatIsoTime(event.atMs)} ${describeEvent(event)}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (held.length === 0) lines.push("    none");
  return lines;
}

/** The run's last record: its newest fast snapshot or event. Silence after it is the run having ended. */
function runEndMs(facts: RunFacts): number | null {
  // Events are in the order stored, which isn't always the order of their times.
  const times = [...facts.fast.slice(-1), ...facts.events].map(({ atMs }) => atMs);
  return times.length === 0 ? null : times.reduce((latest, time) => Math.max(latest, time));
}

/**
 * The gaps in the heartbeat from the first fast snapshot to the run's last record, as `npm run gaps` finds them. The
 * silence before the first (the game starting, the Agent deployed) and after the last record (the run stopped) is
 * shown, not counted.
 */
function heartbeatLines(facts: RunFacts, gapThresholdMs: number, failures: string[]): string[] {
  const times = facts.fast.map(({ atMs }) => atMs);
  const first = times[0];
  const last = times.at(-1);
  const endMs = runEndMs(facts);
  if (first === undefined || last === undefined || endMs === null) {
    const line = "no fast snapshot (the heartbeat) in the window: the Agent never reported";
    failures.push(line);
    return [`  heartbeat: ${line}`];
  }
  const lines = [
    `  heartbeat (fast snapshots), threshold ${formatSeconds(gapThresholdMs)}, from the first snapshot to the run's ` +
      "last record:",
    `    ${times.length} snapshots, first ${formatIsoTime(first)}, last ${formatIsoTime(last)}; before the first, ` +
      `${formatDuration(first - facts.sinceMs)} from the window's start; after the run's last record ` +
      `(${formatIsoTime(endMs)}), ${formatDuration(facts.untilMs - endMs)} to its end`,
  ];
  if (endMs > first) {
    const report = findGaps(times, { sinceMs: first, untilMs: endMs, thresholdMs: gapThresholdMs });
    lines.push(`    longest interval ${formatSeconds(report.longestIntervalMs)}`);
    for (const gap of report.gaps) {
      const line = `gap: ${formatIsoTime(gap.fromMs)} to ${formatIsoTime(gap.toMs)} (${formatSeconds(gap.lengthMs)})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (report.gaps.length === 0) lines.push("    no gaps");
  }
  return lines;
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
    const reconnect = facts.events.find(
      (event) => event.kind === "agentConnected" && event.atMs >= disconnect.atMs && event.atMs <= deadlineMs,
    );
    if (reconnect || deadlineMs > facts.untilMs || endMs <= disconnect.atMs) continue;
    count++;
    const next = facts.events.find((event) => event.kind === "agentConnected" && event.atMs > deadlineMs);
    const line =
      `Agent disconnected at ${formatIsoTime(disconnect.atMs)} (session ${text(fieldsOf(disconnect.detail).agentSessionId)}) ` +
      (next ? `and reconnected only at ${formatIsoTime(next.atMs)}` : "and never reconnected in the window");
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (count === 0) lines.push("    none");
  return lines;
}
