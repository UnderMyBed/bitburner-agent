// The run report's batcher section (#205): what the batcher's health in the fast snapshots says, hour by hour, and its
// desyncs and problems; out of step (a desync, or an operation late or lost) fails the run (#206). Its counts are each
// run's, from 0 when it starts (a new run has another `runName`), so each hour adds up each run's rises within it; a
// run already under way at the window's first snapshot counts from there.
import type { BatcherHealth } from "@bitburner-agent/core";
import { BATCHER_NOT_RUNNING_AFTER, batcherNotRunning } from "./batcher.ts";
import { formatIsoTime } from "./gap-report.ts";

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
type Counts = Record<(typeof COUNTS)[number], number>;
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

const zero = (): Counts => Object.fromEntries(COUNTS.map((count) => [count, 0])) as Counts;
const countsOf = (health: BatcherHealth): Counts =>
  Object.fromEntries(COUNTS.map((count) => [count, health[count]])) as Counts;

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
 * sent but not running, which fails the run (`failures`).
 */
export function batcherSection(points: BatcherPoint[], failures: string[] = []): string[] {
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
  const problems = new Map<string, number>();
  let firstOutOfStepMs: number | null = null;
  for (const { atMs, health } of healths) {
    const hour = Math.floor((atMs - firstMs) / HOUR_MS);
    const bucket = hours.get(hour) ?? { counts: zero(), targets: new Set<string>(), states: new Set<string>() };
    hours.set(hour, bucket);
    // A run already under way at the window's first snapshot counts from there (#211): what it did before isn't the
    // window's. One that starts later counts from 0.
    const before = lastOfRun.get(health.runName) ?? (atMs === firstMs ? countsOf(health) : zero());
    for (const count of COUNTS) bucket.counts[count] += Math.max(0, health[count] - before[count]);
    if (firstOutOfStepMs === null && OUT_OF_STEP.some((count) => health[count] > before[count])) {
      firstOutOfStepMs = atMs;
    }
    lastOfRun.set(health.runName, countsOf(health));
    if (health.target) bucket.targets.add(health.target);
    bucket.states.add(health.state);
    if (health.problem !== null && !problems.has(health.problem)) problems.set(health.problem, atMs);
  }
  lines.push(`  runs: ${lastOfRun.size}; per hour, from ${formatIsoTime(firstMs)}:`);
  const total = zero();
  for (const [hour, { counts, targets, states }] of [...hours].sort(([a], [b]) => a - b)) {
    for (const count of COUNTS) total[count] += counts[count];
    lines.push(
      `    hour ${hour + 1}: ${[...states].join(", ")} on ${[...targets].join(", ") || "no target"}; ` +
        `${counts.batchesStarted} batches, ${counts.hacksLanded} hack parts landed ($${Math.round(counts.moneyHacked)}), ` +
        `${counts.hacksFailed} failed, ${counts.hacksSkipped} skipped, ${counts.batchesShort} short; ` +
        `${counts.desyncs} desyncs (${counts.outOfOrder} out of order, ${counts.outOfBounds} out of bounds), ` +
        `${counts.late} late, ${counts.lost} lost, ${counts.unexpected} records of another run`,
    );
  }
  lines.push(
    total.desyncs === 0
      ? "  desyncs: none"
      : `  desyncs: ${total.desyncs} (${total.outOfOrder} out of order, ${total.outOfBounds} out of bounds)`,
  );
  lines.push(total.late + total.lost === 0 ? "  late or lost: none" : `  late: ${total.late}, lost: ${total.lost}`);
  // Out of step, a failure (#206): the batches no longer land as planned, or someone else touched the target.
  if (total.desyncs + total.late + total.lost > 0) {
    const line =
      `batcher out of step: ${total.desyncs} desyncs (${total.outOfOrder} out of order, ${total.outOfBounds} out of ` +
      `bounds), ${total.late} late, ${total.lost} lost, the first seen at ` +
      formatIsoTime(firstOutOfStepMs ?? firstMs);
    lines.push(`  ${line}`);
    failures.push(line);
  }
  lines.push(problems.size === 0 ? "  problems: none" : "  problems:");
  for (const [problem, atMs] of problems) lines.push(`    from ${formatIsoTime(atMs)}: ${problem}`);
  lines.push(...notRunning);
  return lines;
}
