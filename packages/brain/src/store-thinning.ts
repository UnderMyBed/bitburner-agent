// Thinning the telemetry store (#283, architecture §7): the campaign's months of data, a 12-hour run's 200 MB or so,
// kept to what its readers need of old runs. The last `keptWholeDays` before the newest snapshot stay whole; before
// that, every event, setting, static and slow snapshot, and the first fast and medium snapshot of each minute, stay
// whole, and each other fast and medium snapshot keeps its row and times with its data cut to a stub
// (`TelemetryStore.thinSnapshots`). The run report's time checks (the heartbeat's gaps, clock steps, page stalls)
// read every row, so stay exact; its content checks read one snapshot a minute there. It can't be undone. By hand,
// with `npm run thin` (a dry run, and a backup first, unless told not to); at the brain's start only if config.json's
// `telemetryKeptWholeDays` opts in (owner's call, proposed in #283), never in a run's hot path. The save backups are
// files beside the store: never touched.
import { formatIsoTime, formatSeconds } from "./gap-report.ts";
import type { RecordContext, TelemetryStore } from "./telemetry-store.ts";

/** Recorded with what a thinning did; the newest one's cutoff is where the next starts. */
export const STORE_THINNED_EVENT_KIND = "storeThinned";
/** A thinning that failed: the brain starts all the same (losing the store never breaks play). */
export const STORE_THINNING_FAILED_EVENT_KIND = "storeThinningFailed";
/** The thinning's events: never a run's own record (the run report's end of a run, #283's review). */
export const STORE_THINNING_EVENT_KINDS: readonly string[] = [
  STORE_THINNED_EVENT_KIND,
  STORE_THINNING_FAILED_EVENT_KIND,
];
/**
 * The days `npm run thin` keeps whole unless config.json or `--kept-whole-days` says. The brain's start thins only
 * when config.json says (`telemetryKeptWholeDays`). The owner's call, proposed conservatively: two weeks keeps any run
 * read back, and any calibration taken, whole; 24/7 runs make that several GB.
 */
export const DEFAULT_KEPT_WHOLE_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** What a thinning did, or a dry run would (#283): the `storeThinned` event's detail, and the log line's. */
export interface StoreThinning {
  /** Its cutoff, on a minute: before it, thinned. Null with no snapshot recorded, or when it was skipped. */
  beforeMs: number | null;
  /** Where it started: the last thinning's cutoff, or null the first time (from the store's start). */
  fromMs: number | null;
  keptWholeDays: number;
  /** A dry run: what it would cut, nothing changed. */
  dryRun: boolean;
  /** Why it thinned nothing without looking, or null. */
  skipped: string | null;
  /** The snapshots cut to a stub, by tier. */
  thinned: { fast: number; medium: number };
  /** Their data's bytes, before and after. */
  bytesBefore: number;
  bytesAfter: number;
  /** How long it took. */
  tookMs: number;
  /**
   * Why the write-ahead log couldn't be emptied after the thinning committed (#297's re-review): the thinning stands,
   * the log stays at its size until SQLite's next checkpoint. Absent when it was emptied, or there was nothing to.
   */
  logNotEmptied?: string;
}

/**
 * Thins an environment's snapshots older than `keptWholeDays` before its newest snapshot, from where the last
 * thinning stopped (a brain started after a long pause thins nothing it hasn't already, and the dashboard's newest
 * readings are never stubs). With the newest snapshot after now, a clock was wrong: nothing is thinned, so a wrong
 * clock can't thin real data and set the next start's place in the future. Records a `storeThinned` event, and
 * empties the write-ahead log, if it cut anything. `dryRun` says what it would cut, and changes nothing.
 */
export function thinStore(
  store: TelemetryStore,
  {
    context,
    nowMs,
    keptWholeDays,
    dryRun = false,
  }: { context: RecordContext; nowMs: number; keptWholeDays: number; dryRun?: boolean },
): StoreThinning {
  const startedMs = performance.now();
  const { environment } = context;
  const [last] = store.recentEvents({ environment, limit: 1, kinds: [STORE_THINNED_EVENT_KIND] });
  const lastBeforeMs = (last?.detail as Partial<StoreThinning> | undefined)?.beforeMs;
  const fromMs = typeof lastBeforeMs === "number" && Number.isFinite(lastBeforeMs) ? lastBeforeMs : null;
  const result = (beforeMs: number | null, skipped: string | null = null): StoreThinning => ({
    beforeMs,
    fromMs,
    keptWholeDays,
    dryRun,
    skipped,
    thinned: { fast: 0, medium: 0 },
    bytesBefore: 0,
    bytesAfter: 0,
    tookMs: performance.now() - startedMs,
  });
  const newestMs = store.newestSnapshotMs({ environment });
  if (newestMs === null) return result(null);
  if (newestMs > nowMs) {
    return result(
      null,
      `the newest snapshot, at ${formatIsoTime(newestMs)}, is after now, ${formatIsoTime(nowMs)}: a clock is wrong`,
    );
  }
  const beforeMs = Math.floor((newestMs - keptWholeDays * DAY_MS) / MINUTE_MS) * MINUTE_MS;
  if (fromMs !== null && beforeMs <= fromMs) return result(beforeMs);
  const span = { environment, fromMs: fromMs ?? Number.MIN_SAFE_INTEGER, beforeMs };
  const thin = () => {
    const tiers = dryRun ? store.thinnableSnapshots(span) : store.thinSnapshots(span);
    const countOf = (tier: string) => tiers.find((each) => each.tier === tier)?.count ?? 0;
    const thinning: StoreThinning = {
      ...result(beforeMs),
      thinned: { fast: countOf("fast"), medium: countOf("medium") },
      bytesBefore: tiers.reduce((sum, each) => sum + each.bytesBefore, 0),
      bytesAfter: tiers.reduce((sum, each) => sum + each.bytesAfter, 0),
    };
    if (!dryRun && cutAny(thinning)) {
      thinning.tookMs = performance.now() - startedMs;
      store.recordEvent(context, { atMs: nowMs, kind: STORE_THINNED_EVENT_KIND, detail: thinning });
    }
    return thinning;
  };
  if (dryRun) return thin();
  const thinning = store.writeTransaction(thin);
  let logNotEmptied: string | undefined;
  if (cutAny(thinning)) {
    try {
      store.checkpoint();
    } catch (error) {
      logNotEmptied = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...thinning,
    tookMs: performance.now() - startedMs,
    ...(logNotEmptied === undefined ? {} : { logNotEmptied }),
  };
}

/** Whether a thinning cut (or a dry run would cut) any snapshot. */
export const cutAny = ({ thinned }: StoreThinning) => thinned.fast + thinned.medium > 0;

/** Bytes as MB, to a tenth: the thinning's lines and the command's. */
export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A thinning as a line: the brain's log, the command's output, the run report's section 1. */
export function describeThinning(thinning: StoreThinning): string {
  const { beforeMs, keptWholeDays, dryRun, skipped, thinned, bytesBefore, bytesAfter, tookMs, logNotEmptied } =
    thinning;
  const name = dryRun ? "store thinning (a dry run, nothing changed)" : "store thinning";
  if (typeof skipped === "string") return `${name}: nothing thinned: ${skipped}`;
  if (beforeMs === null) return `${name}: no snapshots recorded yet`;
  const kept = `the last ${keptWholeDays} days before the newest snapshot kept whole`;
  if (!cutAny(thinning)) return `${name}: nothing to thin before ${formatIsoTime(beforeMs)} (${kept})`;
  const counts = `${thinned.fast} fast and ${thinned.medium} medium snapshots`;
  const bytes = `their data ${megabytes(bytesBefore)} → ${megabytes(bytesAfter)}`;
  const rule = `${kept}; before, one fast and one medium snapshot a minute`;
  const took = typeof tookMs === "number" ? `, in ${formatSeconds(tookMs)}` : "";
  return dryRun
    ? `${name}: would cut ${counts} before ${formatIsoTime(beforeMs)} to their times (${rule}), ${bytes}`
    : `store thinned before ${formatIsoTime(beforeMs)} (${rule}): ${counts} cut to their times, ${bytes}${took}` +
        (typeof logNotEmptied === "string" ? `; its write-ahead log not emptied: ${logNotEmptied}` : "");
}

/**
 * The brain's start (main.ts), with `telemetryKeptWholeDays` in config.json: thins, and logs what it did. A failure
 * is logged and recorded, never thrown, and returned for the dashboard's `storeThinningFailed` alert: the brain starts
 * all the same.
 */
export function thinStoreAtStart(
  store: TelemetryStore,
  options: { context: RecordContext; nowMs: number; keptWholeDays: number; log: (message: string) => void },
): { atMs: number; failure: string } | null {
  const { context, nowMs, log } = options;
  try {
    log(describeThinning(thinStore(store, options)));
    return null;
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    log(`store thinning FAILED, the store left as it was: ${failure}`);
    try {
      store.recordEvent(context, { atMs: nowMs, kind: STORE_THINNING_FAILED_EVENT_KIND, detail: { failure } });
    } catch (recordError) {
      log(`store thinning's failure not recorded: ${recordError instanceof Error ? recordError.message : recordError}`);
    }
    return { atMs: nowMs, failure };
  }
}
