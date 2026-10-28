/**
 * Gaps in the fast snapshots (the heartbeat, every 2 s): the evidence for M2's "live snapshots on Steam for 24 h
 * without gaps" (architecture §13). A gap is an interval longer than the threshold between consecutive snapshots, or
 * between the window's edges and the first or last one.
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

export const formatIsoTime = (epochMs: number | null) => (epochMs === null ? "none" : new Date(epochMs).toISOString());
export const formatSeconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)} s`;
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
