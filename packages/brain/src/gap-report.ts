/**
 * Gaps in the fast snapshots (the heartbeat, every 2 s): the evidence for M2's "live snapshots on Steam for 24 h
 * without gaps" (architecture §13). A gap is an interval longer than the threshold between consecutive snapshots, or
 * between the window's edges and the first or last one. Also the lines `npm run gaps` and `npm run report` both print:
 * times, durations and the page heap.
 */
export interface GapWindow {
  sinceMs: number;
  untilMs: number;
  /** An interval longer than this is a gap; exactly this isn't. */
  thresholdMs: number;
}

export interface Gap {
  fromMs: number;
  toMs: number;
  lengthMs: number;
}

export interface GapReport {
  gaps: Gap[];
  /** Snapshots in the window. */
  count: number;
  firstMs: number | null;
  lastMs: number | null;
  longestIntervalMs: number;
}

/** The default threshold: three fast-tier cadences. */
export const DEFAULT_GAP_THRESHOLD_MS = 6_000;

/** Throws for a window that ends before it starts: it would check nothing, and must never pass as "no gaps". */
export function findGaps(receivedAtMs: number[], { sinceMs, untilMs, thresholdMs }: GapWindow): GapReport {
  if (!(sinceMs < untilMs)) throw new RangeError("the window must end after it starts");
  if (!(thresholdMs > 0)) throw new RangeError("the threshold must be positive");
  const inWindow = receivedAtMs.filter((time) => time >= sinceMs && time <= untilMs).sort((a, b) => a - b);
  const edges = [sinceMs, ...inWindow, untilMs];
  const gaps: Gap[] = [];
  let longestIntervalMs = 0;
  for (let index = 1; index < edges.length; index++) {
    const fromMs = edges[index - 1] as number;
    const toMs = edges[index] as number;
    const lengthMs = toMs - fromMs;
    longestIntervalMs = Math.max(longestIntervalMs, lengthMs);
    if (lengthMs > thresholdMs) gaps.push({ fromMs, toMs, lengthMs });
  }
  return {
    gaps,
    count: inWindow.length,
    firstMs: inWindow[0] ?? null,
    lastMs: inWindow.at(-1) ?? null,
    longestIntervalMs,
  };
}

/** A time as ISO, or "none" for no time. */
export const formatIsoTime = (epochMs: number | null) => (epochMs === null ? "none" : new Date(epochMs).toISOString());
/** A duration in seconds, to a tenth: "10.0 s". */
export const formatSeconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)} s`;
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
const formatMegabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The page heap over a window, for a person to read (`npm run gaps`, `npm run report`): growth would show here first
 * (architecture R10).
 */
export function describePageHeap(pageHeapsBytes: number[]): string {
  const first = pageHeapsBytes[0];
  const last = pageHeapsBytes.at(-1);
  if (first === undefined || last === undefined) return "page heap: not reported";
  const lowest = pageHeapsBytes.reduce((low, bytes) => Math.min(low, bytes));
  const highest = pageHeapsBytes.reduce((high, bytes) => Math.max(high, bytes));
  return (
    `page heap: first ${formatMegabytes(first)}, last ${formatMegabytes(last)}, lowest ${formatMegabytes(lowest)}, ` +
    `highest ${formatMegabytes(highest)} (${pageHeapsBytes.length} snapshot${pageHeapsBytes.length === 1 ? "" : "s"} ` +
    "reported it)"
  );
}

/** "1 choice", "3 choices": a count and its noun (#245). */
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How many of each, the most first, ties in the order first seen (#245). */
export function countsOf(items: readonly string[]): [item: string, count: number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].sort(([, firstCount], [, secondCount]) => secondCount - firstCount);
}

/** `countsOf` in words: "hacking for NiteSec ×19, hacking for CyberSec"; one of a kind has no "×1". */
export function describeCounts(items: readonly string[]): string {
  return countsOf(items)
    .map(([item, count]) => (count === 1 ? item : `${item} ×${count}`))
    .join(", ");
}
