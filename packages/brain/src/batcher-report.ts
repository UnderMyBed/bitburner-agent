// The run report's batcher section (#205): what the batcher's health in the fast snapshots says, hour by hour, and its
// desyncs and problems; out of step (a desync, or an operation late or lost) fails the run (#206), and so does a batch
// short of RAM, except while sharing on the batches' hosts, the share's failure (#232). Its counts are each run's,
// from 0 when it starts (a new run has another `runName`), so each hour adds up each run's rises within it; a run
// already under way at the window's first snapshot counts from there. Its sharing's lines are ./share-report.ts's
// (#224).
import type { BatcherHealth } from "@bitburner-agent/core";
import { BATCHER_NOT_RUNNING_AFTER, batcherNotRunning } from "./batcher.ts";
import { formatIsoTime } from "./gap-report.ts";
import { sharingOf } from "./share.ts";
import { type ReputationPoint, sharingLines } from "./share-report.ts";

/** One fast snapshot's batcher health, as stored (the Agent's word: checked as it's read). */
export interface BatcherPoint {
  atMs: number;
  health: unknown;
  /** The deploy worker's last report while the batcher was wanted (#211); absent from an older Agent. */
  deploy?: unknown;
}

/** The counts added up per hour. */
const COUNTS = [
  "batchesStarted",
  "hacksLanded",
  "hacksFailed",
  "hacksSkipped",
  "moneyHacked",
  "desyncs",
  "outOfOrder",
  "outOfBounds",
  "late",
  "lost",
  "batchesShort",
  "unexpected",
] as const;
/** Counts an older batcher's health lacks, as 0: the batches trimmed to the RAM (#232). */
const NEWER_COUNTS = ["batchesTrimmed"] as const;
const ALL_COUNTS = [...COUNTS, ...NEWER_COUNTS] as const;
type Counts = Record<(typeof ALL_COUNTS)[number], number>;
/** The counts that say the batches are out of step: each a run report failure (#206). */
const OUT_OF_STEP = ["desyncs", "late", "lost"] as const;

const HOUR_MS = 60 * 60_000;

/** A stored health, or null if it isn't one (every count a number, a run name and a state). */
function healthOf(value: unknown): BatcherHealth | null {
  if (typeof value !== "object" || value === null) return null;
  const health = value as Record<string, unknown>;
  if (typeof health.runName !== "string" || typeof health.state !== "string") return null;
  return COUNTS.every((count) => typeof health[count] === "number" && Number.isFinite(health[count]))
    ? (value as BatcherHealth)
    : null;
}

const zero = (): Counts => Object.fromEntries(ALL_COUNTS.map((count) => [count, 0])) as Counts;
const countsOf = (health: BatcherHealth): Counts =>
  Object.fromEntries(
    ALL_COUNTS.map((count) => {
      const value = health[count];
      return [count, typeof value === "number" && Number.isFinite(value) ? value : 0];
    }),
  ) as Counts;
/** Share threads on the batches' hosts (#230): a batch short then is the share's (`share starved batches`). */
const sharingOnHosts = (health: BatcherHealth | undefined) => {
  const sharing = sharingOf(health ?? null);
  return sharing !== null && sharing.threads > 0 && sharing.hostsRamGb > 0;
};

/**
 * The batcher wanted and not running for `BATCHER_NOT_RUNNING_AFTER` fast snapshots in a row or more (#211), each
 * stretch a failure: the hack loop had left its hosts to it, so nothing hacked them.
 */
function notRunningLines(points: BatcherPoint[], failures: string[]): string[] {
  const lines = ["  sent but not running (3 fast snapshots in a row or more):"];
  const stretches: { fromMs: number; toMs: number; count: number; problem: string }[] = [];
  let inStretch = false;
  for (const { atMs, deploy } of points) {
    const problem = batcherNotRunning(deploy);
    const last = stretches.at(-1);
    if (problem === null) inStretch = false;
    else if (inStretch && last !== undefined) Object.assign(last, { toMs: atMs, count: last.count + 1, problem });
    else {
      stretches.push({ fromMs: atMs, toMs: atMs, count: 1, problem });
      inStretch = true;
    }
  }
  for (const { fromMs, toMs, count, problem } of stretches) {
    if (count < BATCHER_NOT_RUNNING_AFTER) continue;
    const line = `batcher not running from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} (${count} fast snapshots): ${problem}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (lines.length === 1) lines.push("    none");
  return lines;
}

/**
 * Who hacked over some fast snapshots (#206, section 5's best 10 minutes): "the batcher, batching on n00dles (its
 * health in 290 of 300 fast snapshots)", its states and targets as its health says, or "the hack loop (no batcher
 * health in the 300 fast snapshots)".
 */
export function whoHacked(points: { atMs: number; health: unknown }[]): string {
  const states = new Set<string>();
  const targets = new Set<string>();
  let withHealth = 0;
  for (const { health } of points) {
    const each = healthOf(health);
    if (each === null) continue;
    withHealth += 1;
    states.add(each.state);
    if (each.target) targets.add(each.target);
  }
  const snapshots = `${points.length} fast snapshot${points.length === 1 ? "" : "s"}`;
  if (withHealth === 0) return `the hack loop (no batcher health in the ${snapshots})`;
  return (
    `the batcher, ${[...states].join(", ")} on ${[...targets].join(", ") || "no target"} (its health in ` +
    `${withHealth} of ${snapshots})`
  );
}

/**
 * The section's lines: "6. The batcher", then each hour, the desyncs and the problems seen, and any stretch it was
 * sent but not running, which fails the run (`failures`); then its sharing (#224), with the brain's worked faction's
 * reputation (`readings`).
 */
export function batcherSection(
  points: BatcherPoint[],
  failures: string[] = [],
  readings: readonly ReputationPoint[] = [],
): string[] {
  const lines = ["6. The batcher (#205, #206)"];
  const notRunning = notRunningLines(points, failures);
  const healths = points.flatMap(({ atMs, health }) => {
    const each = healthOf(health);
    return each === null ? [] : [{ atMs, health: each }];
  });
  if (healths.length === 0) {
    lines.push("  not run in the window (no fast snapshot with its health)");
    if (notRunning.length > 2 || notRunning[1] !== "    none") lines.push(...notRunning);
    return lines;
  }
  const firstMs = (healths[0] as { atMs: number }).atMs;
  const hours = new Map<number, { counts: Counts; targets: Set<string>; states: Set<string> }>();
  const lastOfRun = new Map<string, Counts>();
  const lastHealthOfRun = new Map<string, BatcherHealth>();
  const problems = new Map<string, number>();
  let firstOutOfStepMs: number | null = null;
  // Short of RAM (#232): while sharing on the batches' hosts, at either end of the interval (the share's failure, as
  // share-report.ts counts it), or not (the batcher's own).
  let shortWhileSharing = 0;
  let shortOwn = 0;
  let firstShortOwnMs: number | null = null;
  for (const { atMs, health } of healths) {
    const hour = Math.floor((atMs - firstMs) / HOUR_MS);
    const bucket = hours.get(hour) ?? { counts: zero(), targets: new Set<string>(), states: new Set<string>() };
    hours.set(hour, bucket);
    // A run already under way at the window's first snapshot counts from there (#211): what it did before isn't the
    // window's. One that starts later counts from 0.
    const before = lastOfRun.get(health.runName) ?? (atMs === firstMs ? countsOf(health) : zero());
    const now = countsOf(health);
    for (const count of ALL_COUNTS) bucket.counts[count] += Math.max(0, now[count] - before[count]);
    if (firstOutOfStepMs === null && OUT_OF_STEP.some((count) => health[count] > before[count])) {
      firstOutOfStepMs = atMs;
    }
    const short = Math.max(0, now.batchesShort - before.batchesShort);
    if (sharingOnHosts(lastHealthOfRun.get(health.runName)) || sharingOnHosts(health)) shortWhileSharing += short;
    else if (short > 0) {
      shortOwn += short;
      firstShortOwnMs ??= atMs;
    }
    lastOfRun.set(health.runName, now);
    lastHealthOfRun.set(health.runName, health);
    if (health.target) bucket.targets.add(health.target);
    bucket.states.add(health.state);
    if (health.problem !== null && !problems.has(health.problem)) problems.set(health.problem, atMs);
  }
  lines.push(`  runs: ${lastOfRun.size}; per hour, from ${formatIsoTime(firstMs)}:`);
  const total = zero();
  for (const [hour, { counts, targets, states }] of [...hours].sort(([a], [b]) => a - b)) {
    for (const count of ALL_COUNTS) total[count] += counts[count];
    lines.push(
      `    hour ${hour + 1}: ${[...states].join(", ")} on ${[...targets].join(", ") || "no target"}; ` +
        `${counts.batchesStarted} batches, ${counts.hacksLanded} hack parts landed ($${Math.round(counts.moneyHacked)}), ` +
        `${counts.hacksFailed} failed, ${counts.hacksSkipped} skipped, ${counts.batchesShort} short, ` +
        `${counts.batchesTrimmed} trimmed; ` +
        `${counts.desyncs} desync${counts.desyncs === 1 ? "" : "s"} (${counts.outOfOrder} out of order, ${counts.outOfBounds} out of bounds), ` +
        `${counts.late} late, ${counts.lost} lost, ${counts.unexpected} records of another run`,
    );
  }
  lines.push(
    total.desyncs === 0
      ? "  desyncs: none"
      : `  desyncs: ${total.desyncs} (${total.outOfOrder} out of order, ${total.outOfBounds} out of bounds)`,
  );
  lines.push(total.late + total.lost === 0 ? "  late or lost: none" : `  late: ${total.late}, lost: ${total.lost}`);
  // How close it came to late (#216's review): one late operation fails the run, so the margin is worth seeing.
  const slacks = healths.map(({ health }) => health.leastSlackMs).filter((slack) => typeof slack === "number");
  lines.push(
    slacks.length === 0
      ? "  least slack: unknown (no operation recorded it)"
      : `  least slack: ${Math.round(Math.min(...slacks))} ms (an operation's time to spare when it was called; ` +
          "under 0 is late)",
  );
  // Out of step, a failure (#206): the batches no longer land as planned, or someone else touched the target.
  if (total.desyncs + total.late + total.lost > 0) {
    const line =
      `batcher out of step: ${total.desyncs} desync${total.desyncs === 1 ? "" : "s"} (${total.outOfOrder} out of order, ${total.outOfBounds} out of ` +
      `bounds), ${total.late} late, ${total.lost} lost, the first seen at ` +
      formatIsoTime(firstOutOfStepMs ?? firstMs);
    lines.push(`  ${line}`);
    failures.push(line);
  }
  const describeBatchCount = (count: number) => `${count} batch${count === 1 ? "" : "es"}`;
  lines.push(
    total.batchesShort === 0
      ? "  short of RAM: none"
      : `  short of RAM: ${describeBatchCount(total.batchesShort)} (${shortWhileSharing} while sharing on the batches' hosts: ` +
          "the share's)",
  );
  // Trimmed (#232): the batcher fits each batch to the RAM as it will be held, so a plan its hosts can't place is cut,
  // never short. A batch trimmed is income lost, not a failure: a new plan, or one at a lower hacking level, can hold
  // more for a while than the plan's peak.
  lines.push(
    total.batchesTrimmed === 0
      ? "  trimmed to the hosts' RAM (#232): none"
      : `  trimmed to the hosts' RAM (#232): ${describeBatchCount(total.batchesTrimmed)} planned with fewer hack threads than the ` +
          "config's share, or none",
  );
  // Short of RAM, a failure (#232): the batcher fits each batch to the RAM as it will be held, so one short is RAM
  // taken after it was planned (anyone else's script on its hosts), or the fit is wrong. Its hack is lost.
  if (shortOwn > 0) {
    const line =
      `batches short of RAM: ${describeBatchCount(shortOwn)} short (their hacks lost), not while sharing on the batches' hosts, ` +
      `the first seen at ${formatIsoTime(firstShortOwnMs ?? firstMs)}`;
    lines.push(`  ${line}`);
    failures.push(line);
  }
  lines.push(problems.size === 0 ? "  problems: none" : "  problems:");
  for (const [problem, atMs] of problems) lines.push(`    from ${formatIsoTime(atMs)}: ${problem}`);
  lines.push(...notRunning);
  lines.push(...sharingLines(healths, readings, failures));
  return lines;
}
