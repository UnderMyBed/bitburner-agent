// The run report's lines on sharing spare RAM (#224), in its batcher section: from the batcher's health in the fast
// snapshots, the time it shared, its threads, RAM and bonus, and from the slow snapshots, the brain's faction work's
// reputation while it shared against while it didn't. Two failures of their own:
// - **share starved batches:** batches short of RAM while it shared on the batches' hosts (#226's review: on their
//   own terms), or trimmed for its threads there (#232's review): the share took RAM a batch needed. A share on home
//   alone, beside the hosts, can't (#230): batches short then are shown apart, the batcher's own (its `batches short
//   of RAM` failure, #232). Late and lost, while sharing or not, are the batcher's out-of-step failure.
// - **share idle:** asked to share while batching, with the room for a thread free, and no share threads for 10
//   minutes: its rounds don't start.
// - **share left home idle (#242):** asked, and over half of home's RAM free beyond what it keeps for the Agent, for 5
//   minutes, as the batcher's health has it: run #3's home sat idle for 51 minutes while the room said 0.
// And from a batcher since #242, two lines more: the bonus while asked, on average, against the bonus the RAM free
// allowed (its `possibleBonus`), and the time at x1.000 while asked.
import { SHARE_RAM_GB, type SharingHealth } from "@bitburner-agent/core";
import { formatIsoTime } from "./gap-report.ts";
import { SHARE_HEALTH_STALE_MS, sharingOf } from "./share.ts";

/** Asked, batching, with the room free and no threads this long: `share idle`, a failure. */
export const SHARE_IDLE_AFTER_MS = 10 * 60_000;
/** Asked, with over this share of home's RAM free beyond what it keeps (#242)... */
export const HOME_IDLE_FREE_SHARE = 0.5;
/** ...this long: `share left home idle`, a failure. */
export const HOME_IDLE_AFTER_MS = 5 * 60_000;
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
  /** Batches trimmed for the share's threads on the batches' hosts (#232's review); 0 from an older batcher. */
  trimmedBySharing: number;
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
/** Share threads on the batches' hosts (#230): only these can take a batch's RAM. */
const sharingOnHosts = (point: Point | undefined) => sharingNow(point) && (point?.sharing?.hostsRamGb ?? 0) > 0;
const gigabytes = (ram: number) => `${Math.round(ram).toLocaleString("en-US")} GB`;
const whole = (value: number) => Math.round(value).toLocaleString("en-US");
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/**
 * The points the report reads. A health the batcher hasn't written again for `SHARE_HEALTH_STALE_MS` (the same `atMs`
 * since a fast snapshot that long before) is a stopped batcher's (#226's review): its sharing isn't counted.
 */
function pointsOf(points: { atMs: number; health: unknown }[]): Point[] {
  let written: { atMs: unknown; firstSeenMs: number } | null = null;
  return points.flatMap(({ atMs, health }) => {
    if (typeof health !== "object" || health === null) return [];
    const fields = health as Record<string, unknown>;
    const same: { atMs: unknown; firstSeenMs: number } =
      written !== null && written.atMs === fields.atMs ? written : { atMs: fields.atMs, firstSeenMs: atMs };
    written = same;
    const stale = atMs - same.firstSeenMs > SHARE_HEALTH_STALE_MS;
    return [
      {
        atMs,
        runName: typeof fields.runName === "string" ? fields.runName : null,
        state: fields.state,
        late: count(fields.late),
        lost: count(fields.lost),
        short: count(fields.batchesShort),
        trimmedBySharing: count(fields.batchesTrimmedBySharing),
        sharing: stale ? null : sharingOf(health),
      },
    ];
  });
}

/**
 * The lines, under "  sharing spare RAM (#224):", and the failures into `failures`. `rawPoints`: each fast snapshot's
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
  lines.push(...askedLines(points));
  lines.push(`    ${reputationLine(points, readings)}`);
  lines.push(...starvedLines(points, failures));
  lines.push(...idleLines(points, failures));
  lines.push(...homeIdleLines(points, failures));
  return lines;
}

/**
 * While asked (#242), from a batcher that says its bonus possible: the bonus on average, time-weighted between fast
 * snapshots, against the bonus possible on the RAM free, and the time at x1.000 (no threads running). None from an
 * older batcher.
 */
function askedLines(points: Point[]): string[] {
  let askedMs = 0;
  let bonusMs = 0;
  let possibleMs = 0;
  let atOneMs = 0;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const sharing = point.sharing;
    if (previous === undefined || point.atMs - previous.atMs > FAST_GAP_MS || sharing?.wanted !== true) continue;
    if (sharing.possibleBonus === undefined) continue;
    const stepMs = point.atMs - previous.atMs;
    askedMs += stepMs;
    bonusMs += sharing.bonus * stepMs;
    possibleMs += sharing.possibleBonus * stepMs;
    if (sharing.threads === 0) atOneMs += stepMs;
  }
  if (askedMs === 0) return [];
  const percent = Math.round((atOneMs / askedMs) * 100);
  return [
    `    the bonus while asked (#242): x${(bonusMs / askedMs).toFixed(3)} on average, of x${(possibleMs / askedMs).toFixed(3)} ` +
      `possible on the RAM free; at x1.000 for ${duration(atOneMs)} (${percent}% of ${duration(askedMs)} asked)`,
  ];
}

/**
 * Stretches asked with over `HOME_IDLE_FREE_SHARE` of home's RAM free beyond what it keeps (#242), as the batcher's
 * health has it, of `HOME_IDLE_AFTER_MS` or more: `share left home idle`, a failure each. Whatever the batcher's room
 * says: run #3's room was 0 while home sat idle. None from a batcher before #242, which doesn't say.
 */
function homeIdleLines(points: Point[], failures: string[]): string[] {
  if (!points.some((point) => point.sharing?.homeGb !== undefined)) return [];
  const lines: string[] = [];
  let from: number | null = null;
  let to = 0;
  let homeGb = 0;
  const close = () => {
    if (from !== null && to - from >= HOME_IDLE_AFTER_MS) {
      const line =
        `share left home idle from ${formatIsoTime(from)} to ${formatIsoTime(to)} (${duration(to - from)}): asked, ` +
        `and over half of home's ${gigabytes(homeGb)} free beyond what it keeps`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    from = null;
  };
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const sharing = point.sharing;
    const idle =
      sharing?.wanted === true &&
      sharing.homeGb !== undefined &&
      sharing.homeGb > 0 &&
      (sharing.homeFreeGb ?? 0) > HOME_IDLE_FREE_SHARE * sharing.homeGb;
    if (!idle || (previous !== undefined && point.atMs - previous.atMs > FAST_GAP_MS)) close();
    if (!idle) continue;
    from ??= point.atMs;
    to = point.atMs;
    homeGb = sharing.homeGb ?? 0;
  }
  close();
  if (lines.length === 0) lines.push("    home idle while asked (over half its RAM free, for 5 minutes, #242): never");
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
 * Late, lost and short while sharing on the batches' hosts (a fast snapshot interval with share threads there at
 * either end), while sharing on home alone, and while not; `share starved batches`, a failure, when batches came up
 * short of RAM while sharing on their hosts (#226's review), or were trimmed for the share's threads there (#232's
 * review, the batcher's own count: planned larger without them): a share there takes only what the reserve leaves,
 * so a batch starved beside one is the share's doing, or the reserve's. Home's share, beside the hosts, can't take a
 * batch's RAM (#230: #229's augmentations suite has the same batches short with sharing off). Late and lost are shown
 * for comparison, and fail as the batcher's out-of-step. Each run's counts as the batcher's section takes them: from
 * the window's first snapshot, and from 0 for a run that starts later (its first snapshot judged by its own sharing).
 */
function starvedLines(points: Point[], failures: string[]): string[] {
  const whileSharingOnHosts = { late: 0, lost: 0, short: 0 };
  const onHomeAlone = { late: 0, lost: 0, short: 0 };
  const whileNot = { late: 0, lost: 0, short: 0 };
  let trimmedBySharing = 0;
  let firstStarvedAtMs: number | null = null;
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous === undefined || point.runName === null) continue;
    const sameRun = previous.runName === point.runName;
    const before = sameRun ? previous : { late: 0, lost: 0, short: 0, trimmedBySharing: 0 };
    const sharingOnTheHosts = (sameRun && sharingOnHosts(previous)) || sharingOnHosts(point);
    const sharingAnywhere = (sameRun && sharingNow(previous)) || sharingNow(point);
    let into = whileNot;
    if (sharingOnTheHosts) into = whileSharingOnHosts;
    else if (sharingAnywhere) into = onHomeAlone;
    into.late += Math.max(0, point.late - before.late);
    into.lost += Math.max(0, point.lost - before.lost);
    const short = Math.max(0, point.short - before.short);
    into.short += short;
    const trimmed = Math.max(0, point.trimmedBySharing - before.trimmedBySharing);
    trimmedBySharing += trimmed;
    if ((sharingOnTheHosts && short > 0) || trimmed > 0) firstStarvedAtMs ??= point.atMs;
  }
  const describe = ({ late, lost, short }: typeof whileNot) => `${late} late, ${lost} lost, ${short} short`;
  const lines = [
    `    while sharing on the batches' hosts: ${describe(whileSharingOnHosts)}; on home alone: ${describe(onHomeAlone)}; ` +
      `while not: ${describe(whileNot)}`,
  ];
  const describeBatchCount = (count: number) => `${count} batch${count === 1 ? "" : "es"}`;
  const starved = [
    ...(whileSharingOnHosts.short > 0 ? [`${describeBatchCount(whileSharingOnHosts.short)} short of RAM`] : []),
    ...(trimmedBySharing > 0
      ? [`${describeBatchCount(trimmedBySharing)} trimmed to the RAM its threads left (#232)`]
      : []),
  ];
  if (starved.length > 0) {
    const line =
      `share starved batches: ${starved.join(" and ")} while sharing on the batches' hosts, the first seen at ` +
      formatIsoTime(firstStarvedAtMs ?? 0);
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
