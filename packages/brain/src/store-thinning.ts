// Thinning the telemetry store (#283, architecture §7): the campaign's months of data, a 12-hour run's 200 MB or so,
// kept to what its readers need of old runs. The last `keptWholeDays` of what the brain recorded stay whole; before
// that, every event, setting, static and slow snapshot, and the first fast and medium snapshot of each minute, stay
// whole, and each other fast and medium snapshot keeps its row and times with its data cut to a stub
// (`TelemetryStore.thinSnapshots`). The run report's time checks (the heartbeat's gaps, clock steps, page stalls)
// read every row, so stay exact; its content checks read one snapshot a minute there. At the brain's start, before its
// run (never in its hot path), and from `npm run thin`. The save backups are files beside the store: never touched.
import { formatIsoTime } from "./gap-report.ts";
import type { RecordContext, TelemetryStore } from "./telemetry-store.ts";

/** Recorded with what a thinning did; the newest one's cutoff is where the next starts. */
export const STORE_THINNED_EVENT_KIND = "storeThinned";
/** A thinning that failed: the brain starts all the same (losing the store never breaks play). */
export const STORE_THINNING_FAILED_EVENT_KIND = "storeThinningFailed";
/**
 * The days kept whole unless config.json says (`telemetryKeptWholeDays`). The owner's call, made conservatively:
 * two weeks keeps any run read back, and any calibration taken, whole; 24/7 runs make that several GB.
 */
export const DEFAULT_KEPT_WHOLE_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;

/** What a thinning did (#283): the `storeThinned` event's detail, and the log line's. */
export interface StoreThinning {
  /** Its cutoff, on a minute: before it, thinned. Null with no snapshot recorded. */
  beforeMs: number | null;
  /** Where it started: the last thinning's cutoff, or null the first time (from the store's start). */
  fromMs: number | null;
  keptWholeDays: number;
  /** The snapshots cut to a stub, by tier. */
  thinned: { fast: number; medium: number };
  /** Their data's bytes, before and after. */
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Thins an environment's snapshots older than `keptWholeDays` before its newest snapshot, or before now if that's
 * sooner (a brain started after a long pause thins nothing it hasn't already, and the dashboard's newest readings are
 * never stubs), from where the last thinning stopped. Records a `storeThinned` event if it cut anything.
 */
export function thinStore(
  store: TelemetryStore,
  { context, nowMs, keptWholeDays }: { context: RecordContext; nowMs: number; keptWholeDays: number },
): StoreThinning {
  const { environment } = context;
  const nothing = { keptWholeDays, thinned: { fast: 0, medium: 0 }, bytesBefore: 0, bytesAfter: 0 };
  const [last] = store.recentEvents({ environment, limit: 1, kinds: [STORE_THINNED_EVENT_KIND] });
  const lastBeforeMs = (last?.detail as Partial<StoreThinning> | undefined)?.beforeMs;
  const fromMs = typeof lastBeforeMs === "number" && Number.isFinite(lastBeforeMs) ? lastBeforeMs : null;
  const newestMs = store.newestSnapshotMs({ environment });
  if (newestMs === null) return { beforeMs: null, fromMs, ...nothing };
  const beforeMs = Math.floor((Math.min(nowMs, newestMs) - keptWholeDays * DAY_MS) / MINUTE_MS) * MINUTE_MS;
  if (fromMs !== null && beforeMs <= fromMs) return { beforeMs, fromMs, ...nothing };
  return store.writeTransaction(() => {
    const tiers = store.thinSnapshots({ environment, fromMs: fromMs ?? Number.MIN_SAFE_INTEGER, beforeMs });
    const countOf = (tier: string) => tiers.find((each) => each.tier === tier)?.count ?? 0;
    const result: StoreThinning = {
      beforeMs,
      fromMs,
      keptWholeDays,
      thinned: { fast: countOf("fast"), medium: countOf("medium") },
      bytesBefore: tiers.reduce((sum, each) => sum + each.bytesBefore, 0),
      bytesAfter: tiers.reduce((sum, each) => sum + each.bytesAfter, 0),
    };
    if (result.thinned.fast + result.thinned.medium > 0) {
      store.recordEvent(context, { atMs: nowMs, kind: STORE_THINNED_EVENT_KIND, detail: result });
    }
    return result;
  });
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A thinning as a line: the brain's log, the command's output, the run report's section 1. */
export function describeThinning({ beforeMs, keptWholeDays, thinned, bytesBefore, bytesAfter }: StoreThinning): string {
  if (beforeMs === null) return "store thinning: no snapshots recorded yet";
  const kept = `the last ${keptWholeDays} days of records kept whole`;
  if (thinned.fast + thinned.medium === 0) {
    return `store thinning: nothing to thin before ${formatIsoTime(beforeMs)} (${kept})`;
  }
  return (
    `store thinned before ${formatIsoTime(beforeMs)} (${kept}; before, one fast and one medium snapshot a minute): ` +
    `${thinned.fast} fast and ${thinned.medium} medium snapshots cut to their times, their data ` +
    `${megabytes(bytesBefore)} → ${megabytes(bytesAfter)}`
  );
}

/**
 * The brain's start (main.ts): thins, and logs what it did. A failure is logged and recorded, never thrown: the brain
 * starts all the same.
 */
export function thinStoreAtStart(
  store: TelemetryStore,
  options: { context: RecordContext; nowMs: number; keptWholeDays: number; log: (message: string) => void },
): void {
  const { context, nowMs, log } = options;
  try {
    log(describeThinning(thinStore(store, options)));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    log(`store thinning FAILED, the store left as it was: ${failure}`);
    try {
      store.recordEvent(context, { atMs: nowMs, kind: STORE_THINNING_FAILED_EVENT_KIND, detail: { failure } });
    } catch (recordError) {
      log(`store thinning's failure not recorded: ${recordError instanceof Error ? recordError.message : recordError}`);
    }
  }
}
