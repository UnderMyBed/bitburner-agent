// The run report's lines on sharing spare RAM (#224), in its batcher section: from the batcher's health in the fast
// snapshots, the time it shared, its threads, RAM and bonus, and from the slow snapshots, the brain's faction work's
// reputation while it shared against while it didn't. Two failures of their own:
// - **share starved batches:** operations late or lost, or batches short, while it shared, with none before it first
//   did: the share took RAM the batches needed. The batcher's own out-of-step failure still counts late and lost alike.
// - **share idle:** asked to share while batching, with the room for a thread free, and no share threads for 10
//   minutes: its rounds don't start.
import { SHARE_RAM_GB, type SharingHealth } from "@bitburner-agent/core";
import { formatIsoTime } from "./gap-report.ts";
import { sharingOf } from "./share.ts";

/** Asked, batching, with the room free and no threads this long: `share idle`, a failure. */
export const SHARE_IDLE_AFTER_MS = 10 * 60_000;
/** Fast snapshots (every 2 s) further apart than this are a gap: the time between isn't counted as shared or not. */
const FAST_GAP_MS = 10_000;
/** Slow snapshots (every 60 s) further apart than this are a gap: the reputation between isn't judged. */
const SLOW_GAP_MS = 3 * 60_000;

/** A fast snapshot's batcher health, as the report reads it. */
interface Point {
  atMs: number;
  runName: string | null;
  state: unknown;
  late: number;
  lost: number;
  short: number;
  sharing: SharingHealth | null;
}

/** A reading of the brain's worked faction's reputation, from a slow snapshot. */
export interface ReputationPoint {
  atMs: number;
  faction: string;
  reputation: number;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const sharingNow = (point: Point | undefined) => (point?.sharing?.threads ?? 0) > 0;
const gigabytes = (ram: number) => `${Math.round(ram).toLocaleString("en-US")} GB`;
const whole = (value: number) => Math.round(value).toLocaleString("en-US");
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

function pointsOf(points: { atMs: number; health: unknown }[]): Point[] {
  return points.flatMap(({ atMs, health }) => {
    if (typeof health !== "object" || health === null) return [];
    const fields = health as Record<string, unknown>;
    return [
      {
        atMs,
        runName: typeof fields.runName === "string" ? fields.runName : null,
        state: fields.state,
        late: count(fields.late),
        lost: count(fields.lost),
        short: count(fields.batchesShort),
        sharing: sharingOf(health),
      },
    ];
  });
}

/**
 * The lines, under "  sharing spare RAM (#224):", and the failures into `failures`. `points`: each fast snapshot's
 * batcher health, in time order; `readings`: the brain's worked faction's reputation in the slow snapshots, in order.
 */
export function sharingLines(
  rawPoints: { atMs: number; health: unknown }[],
  readings: readonly ReputationPoint[],
  failures: string[],
): string[] {
  const points = pointsOf(rawPoints);
  const header = "  sharing spare RAM (#224):";
  if (!points.some((point) => point.sharing !== null)) return [header, "    never asked, and no share threads"];
  const lines = [header];
  // Time shared, and its threads, RAM and bonus, time-weighted between fast snapshots.
  let sharedMs = 0;
  let threadMs = 0;
  let ramMs = 0;
  let bonusMs = 0;
  let peak: SharingHealth | null = null;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const sharing = point.sharing;
    if (sharing !== null && (peak === null || sharing.threads > peak.threads)) peak = sharing;
    if (previous === undefined || point.atMs - previous.atMs > FAST_GAP_MS || sharing === null || sharing.threads === 0)
      continue;
    const stepMs = point.atMs - previous.atMs;
    sharedMs += stepMs;
    threadMs += sharing.threads * stepMs;
    ramMs += sharing.ramGb * stepMs;
    bonusMs += sharing.bonus * stepMs;
  }
  if (sharedMs === 0 || peak === null) {
    lines.push("    asked, and never shared");
  } else {
    lines.push(
      `    shared for ${duration(sharedMs)}: threads at most ${whole(peak.threads)}, ${whole(threadMs / sharedMs)} on ` +
        `average; RAM at most ${gigabytes(peak.ramGb)}, ${gigabytes(ramMs / sharedMs)} on average; the bonus at most ` +
        `x${peak.bonus.toFixed(3)}, x${(bonusMs / sharedMs).toFixed(3)} on average`,
    );
  }
  lines.push(`    ${reputationLine(points, readings)}`);
  lines.push(...starvedLines(points, failures));
  lines.push(...idleLines(points, failures));
  return lines;
}

/**
 * The brain's faction work's reputation while it shared and while it didn't: each interval between slow snapshots of
 * the same faction, with no gap, counted as sharing when every fast snapshot in it shows share threads, and as not when
 * none does; the rest, mixed, are left out.
 */
function reputationLine(points: Point[], readings: readonly ReputationPoint[]): string {
  const totals = { sharing: { gained: 0, ms: 0, bonusSum: 0, bonusCount: 0 }, not: { gained: 0, ms: 0 } };
  for (const [index, reading] of readings.entries()) {
    const previous = readings[index - 1];
    if (previous === undefined || previous.faction !== reading.faction || reading.atMs - previous.atMs > SLOW_GAP_MS)
      continue;
    const inside = points.filter((point) => point.atMs > previous.atMs && point.atMs <= reading.atMs);
    if (inside.length === 0) continue;
    const gained = Math.max(0, reading.reputation - previous.reputation);
    const ms = reading.atMs - previous.atMs;
    if (inside.every(sharingNow)) {
      totals.sharing.gained += gained;
      totals.sharing.ms += ms;
      for (const point of inside) {
        totals.sharing.bonusSum += point.sharing?.bonus ?? 1;
        totals.sharing.bonusCount += 1;
      }
    } else if (!inside.some(sharingNow)) {
      totals.not.gained += gained;
      totals.not.ms += ms;
    }
  }
  const rate = ({ gained, ms }: { gained: number; ms: number }) => (gained * 1000) / ms;
  if (totals.sharing.ms === 0) return "the brain's faction work while sharing: none to judge";
  const bonus = totals.sharing.bonusSum / totals.sharing.bonusCount;
  const sharing =
    `the brain's faction work while sharing: +${whole(totals.sharing.gained)} reputation in ` +
    `${duration(totals.sharing.ms)} (${rate(totals.sharing).toFixed(2)}/s, the bonus x${bonus.toFixed(3)} on average)`;
  if (totals.not.ms === 0) return `${sharing}; while not: none to compare`;
  const ratio = rate(totals.not) > 0 ? ` (x${(rate(totals.sharing) / rate(totals.not)).toFixed(2)})` : "";
  return (
    `${sharing}; while not: +${whole(totals.not.gained)} in ${duration(totals.not.ms)} ` +
    `(${rate(totals.not).toFixed(2)}/s)${ratio}`
  );
}

/**
 * Late, lost and short while sharing (a fast snapshot interval with share threads at either end), and before it first
 * shared; `share starved batches`, a failure, when there were some while sharing and none before.
 */
function starvedLines(points: Point[], failures: string[]): string[] {
  const whileSharing = { late: 0, lost: 0, short: 0 };
  const before = { late: 0, lost: 0, short: 0 };
  let shared = false;
  let firstAtMs: number | null = null;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const sharing = sharingNow(previous) || sharingNow(point);
    if (sharing && !shared) {
      shared = true;
      firstAtMs = point.atMs;
    }
    if (previous === undefined || previous.runName === null || previous.runName !== point.runName) continue;
    const into = sharing ? whileSharing : shared ? null : before;
    if (into === null) continue;
    into.late += Math.max(0, point.late - previous.late);
    into.lost += Math.max(0, point.lost - previous.lost);
    into.short += Math.max(0, point.short - previous.short);
  }
  const describe = ({ late, lost, short }: typeof before) => `${late} late, ${lost} lost, ${short} short`;
  const lines = [`    while sharing: ${describe(whileSharing)}; before it first shared: ${describe(before)}`];
  const starved = whileSharing.late + whileSharing.lost + whileSharing.short;
  if (starved > 0 && before.late + before.lost + before.short === 0) {
    const line =
      `share starved batches: ${describe(whileSharing)} while sharing, none before it first shared at ` +
      formatIsoTime(firstAtMs ?? 0);
    lines.push(`    ${line}`);
    failures.push(line);
  }
  return lines;
}

/**
 * Stretches asked to share while batching, with the room for a thread, and none running, of `SHARE_IDLE_AFTER_MS` or
 * more: `share idle`, a failure each.
 */
function idleLines(points: Point[], failures: string[]): string[] {
  const lines: string[] = [];
  let from: number | null = null;
  let to = 0;
  const close = () => {
    if (from !== null && to - from >= SHARE_IDLE_AFTER_MS) {
      const line =
        `share idle from ${formatIsoTime(from)} to ${formatIsoTime(to)} (${duration(to - from)}): asked while ` +
        "batching, the room free, and no share threads";
      lines.push(`    ${line}`);
      failures.push(line);
    }
    from = null;
  };
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const idle =
      point.sharing?.wanted === true &&
      point.state === "batching" &&
      point.sharing.threads === 0 &&
      point.sharing.roomGb >= SHARE_RAM_GB;
    if (!idle || (previous !== undefined && point.atMs - previous.atMs > FAST_GAP_MS)) close();
    if (!idle) continue;
    from ??= point.atMs;
    to = point.atMs;
  }
  close();
  if (lines.length === 0) lines.push("    idle (asked, the room free, no threads, for 10 minutes): never");
  return lines;
}
