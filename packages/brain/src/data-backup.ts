// The data directory's rotating backup (#284, architecture §7): what the brain can't rebuild from the game, the
// telemetry store (the campaign's history, the fast model's calibration data) with config.json and the newest save
// backup of each environment, copied into a folder of its own, `<backup directory>/<UTC time>/`, the newest
// `backupsKept` kept. The store is copied with `VACUUM INTO` in a worker thread (data-backup-worker.ts): consistent
// while the brain writes, compacted, and off the event loop, which a 426 MB store's copy on the brain's own thread
// would block for its whole length (about 0.9 s on an SSD, more on a slower or colder disk; in the worker the loop's
// worst delay was 19 ms, #284). Each copy is opened and checked before it counts. Taken at the brain's start and then
// each interval, whenever the newest is older than the interval (so a crash loop doesn't rotate the good ones out),
// and before a thinning at the start that no backup holds yet (`backupBeforeThinning`). A failure is logged, recorded
// and the dashboard's `dataBackupFailed` alert, and never stops play: it's tried again within the hour.
import { readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { type Clock, EventListeners, type TimerHandle } from "@bitburner-agent/bridge";
import { formatSeconds } from "./gap-report.ts";
import { isSaveBackupFileName, MAX_BACKUP_INTERVAL_MS } from "./save-backups.ts";
import { megabytes } from "./store-thinning.ts";

/** Where data backups go unless config.json's `dataBackupDirectory` says: in the data directory. */
export const DATA_BACKUPS_DIRECTORY_NAME = "backups";
export const DATA_BACKUP_EVENT_KIND = "dataBackup";
export const DATA_BACKUP_FAILED_EVENT_KIND = "dataBackupFailed";
export const DATA_BACKUP_EVENT_KINDS: readonly string[] = [DATA_BACKUP_EVENT_KIND, DATA_BACKUP_FAILED_EVENT_KIND];
/**
 * The owner's call, proposed conservatively (owner decision 62): two kept, one a day. Each is about the store's size
 * once compacted (a 12-hour run adds about 200 MB), so they take about twice the store, three times while a new one is
 * written before the oldest goes.
 */
export const DEFAULT_DATA_BACKUPS_KEPT = 2;
export const DEFAULT_DATA_BACKUP_INTERVAL_HOURS = 24;
/** The longest interval a timer can wait, in whole hours. */
export const MAX_DATA_BACKUP_INTERVAL_HOURS = Math.floor(MAX_BACKUP_INTERVAL_MS / 3_600_000);
/** A backup never leaves less than this free on its disk: the store is on it too, by default, and must keep growing. */
export const MIN_FREE_BYTES_AFTER_BACKUP = 1_000_000_000;
/** After a failure, the next try: in an hour, or at the interval if that's sooner. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
/** A backup's folder name: its UTC time, with `-` for `:` (which Windows doesn't allow), as the save backups' names. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;
const PARTIAL_SUFFIX = ".partial";

/** Why a backup was taken: at the brain's start, at the interval, or before a thinning at the start. */
export type DataBackupReason = "start" | "interval" | "thinning";

export type DataBackupEvent =
  | {
      type: typeof DATA_BACKUP_EVENT_KIND;
      atMs: number;
      reason: DataBackupReason;
      /** Its folder: relative to the data directory (`backups/<time>`) when inside it, else absolute. */
      directory: string;
      /** The store's copy, compacted. */
      storeBytes: number;
      /** The save backups copied, relative to the data directory: the newest of each environment. */
      saves: string[];
      tookMs: number;
      /** Older backups removed by the rotation. */
      removed: string[];
      /** Why older ones couldn't all be removed (the next rotation tries again); absent when they were. */
      rotationFailure?: string;
    }
  | { type: typeof DATA_BACKUP_FAILED_EVENT_KIND; atMs: number; reason: DataBackupReason; failure: string };

/** What the dashboard's `dataBackupFailed` alert says: the newest backup's problem, until one is taken cleanly. */
export interface DataBackupProblem {
  atMs: number;
  /** The backup failed, or was kept but older ones weren't removed. */
  kind: "failed" | "notRotated";
  failure: string;
}

export interface DataBackupsOptions {
  /** Names a backup inside it relative to it, in the events. */
  dataDirectory: string;
  storePath: string;
  /** config.json: copied if it's there. */
  configPath: string;
  /** The save backups' folder, one folder per environment: the newest of each is copied. */
  savesDirectory: string;
  backupDirectory: string;
  backupsKept: number;
  backupIntervalMs: number;
  clock: Clock;
  /** The bytes free on the disk holding `directory`: `statfs`'s, unless a test says otherwise. */
  freeBytes?: (directory: string) => Promise<number>;
}

const freeBytesOnDisk = async (directory: string) => {
  const disk = await statfs(directory);
  return disk.bavail * disk.bsize;
};

/** A time as a backup's folder name. */
export const backupName = (epochMs: number) => new Date(epochMs).toISOString().replaceAll(":", "-");
/** A backup's folder name as its time, or null if it isn't one. */
function backupTimeMs(name: string): number | null {
  if (!BACKUP_NAME.test(name)) return null;
  const [date, time] = name.split("T") as [string, string];
  return Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(3, 5)}:${time.slice(6)}`);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DataBackups {
  readonly #options: DataBackupsOptions;
  readonly #listeners = new EventListeners<DataBackupEvent>();
  readonly #freeBytes: (directory: string) => Promise<number>;
  /** One backup at a time: each waits for the one before. */
  #queue: Promise<unknown> = Promise.resolve();
  #timer: TimerHandle | null = null;
  #stopped = false;
  #problem: DataBackupProblem | null = null;

  constructor(options: DataBackupsOptions) {
    if (!(options.backupIntervalMs >= 1 && options.backupIntervalMs <= MAX_BACKUP_INTERVAL_MS)) {
      throw new RangeError(`the data backup interval must be from 1 ms to ${MAX_BACKUP_INTERVAL_MS} ms`);
    }
    if (!Number.isInteger(options.backupsKept) || options.backupsKept < 1) {
      throw new RangeError("at least one data backup must be kept");
    }
    this.#options = options;
    this.#freeBytes = options.freeBytes ?? freeBytesOnDisk;
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: DataBackupEvent) => void): () => void {
    return this.#listeners.subscribe(listener);
  }

  /** The newest backup's time, from its folder's name; null with none. */
  newestBackupAtMs(): number | null {
    let names: string[];
    try {
      names = readdirSync(this.#options.backupDirectory);
    } catch {
      return null;
    }
    const times = names.map(backupTimeMs).filter((time): time is number => time !== null);
    return times.length === 0 ? null : Math.max(...times);
  }

  /** The newest backup's problem, for the dashboard's alert; null once one is taken cleanly. */
  problem(): DataBackupProblem | null {
    return this.#problem;
  }

  /**
   * At the brain's start (after its `brainStarted`): a backup now if one is due (none yet, or the newest older than the
   * interval, or after now: a clock was wrong), then at each due time. After a failure, again within the hour.
   */
  start(): void {
    this.#check("start");
  }

  /** On the brain's stop: no more backups or events. One under way is cut short with the process, its folder partial. */
  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) this.#options.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #check(reason: DataBackupReason): void {
    const { clock, backupIntervalMs } = this.#options;
    const nowMs = clock.now();
    const newestMs = this.newestBackupAtMs();
    const dueAtMs = newestMs === null || newestMs > nowMs ? nowMs : newestMs + backupIntervalMs;
    if (dueAtMs > nowMs) {
      this.#schedule(dueAtMs - nowMs);
      return;
    }
    void this.backupNow(reason).then((event) =>
      this.#schedule(
        event.type === DATA_BACKUP_EVENT_KIND ? backupIntervalMs : Math.min(backupIntervalMs, RETRY_AFTER_FAILURE_MS),
      ),
    );
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = this.#options.clock.setTimeout(
      () => this.#check("interval"),
      Math.min(Math.max(delayMs, 0), MAX_BACKUP_INTERVAL_MS),
    );
  }

  /** A backup now, after any under way: resolves with its event, saved or failed. Never rejects. */
  backupNow(reason: DataBackupReason): Promise<DataBackupEvent> {
    const backup = this.#queue.then(() => this.#take(reason));
    this.#queue = backup;
    return backup;
  }

  async #take(reason: DataBackupReason): Promise<DataBackupEvent> {
    const { clock, backupDirectory } = this.#options;
    const atMs = clock.now();
    const startedMs = performance.now();
    const name = backupName(atMs);
    const partial = path.join(backupDirectory, `${name}${PARTIAL_SUFFIX}`);
    let event: DataBackupEvent;
    try {
      const { storeBytes, saves } = await this.#write(partial);
      const final = path.join(backupDirectory, name);
      // Two in the same millisecond: the second replaces the first.
      await rm(final, { recursive: true, force: true });
      await rename(partial, final);
      const { removed, failure } = await this.#rotate(name);
      event = {
        type: DATA_BACKUP_EVENT_KIND,
        atMs,
        reason,
        directory: this.#named(final),
        storeBytes,
        saves,
        tookMs: performance.now() - startedMs,
        removed,
        ...(failure === null ? {} : { rotationFailure: failure }),
      };
      this.#problem = failure === null ? null : { atMs, kind: "notRotated", failure };
    } catch (error) {
      // Best effort: the failure is what's recorded, and the next rotation removes a partial folder left.
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      event = { type: DATA_BACKUP_FAILED_EVENT_KIND, atMs, reason, failure: message(error) };
      this.#problem = { atMs, kind: "failed", failure: event.failure };
    }
    if (!this.#stopped) this.#listeners.emit(event);
    return event;
  }

  /** Writes the backup into `partial`: the free space checked first, the store's copy checked after. */
  async #write(partial: string): Promise<{ storeBytes: number; saves: string[] }> {
    const { storePath, configPath, backupDirectory } = this.#options;
    await mkdir(backupDirectory, { recursive: true });
    const saves = await this.#newestSaves();
    const sizeOf = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0;
    // The copy is at most the store and its log; usually less, compacted.
    let neededBytes = (await sizeOf(storePath)) + (await sizeOf(`${storePath}-wal`)) + (await sizeOf(configPath));
    for (const save of saves) neededBytes += await sizeOf(save.from);
    const freeBytes = await this.#freeBytes(backupDirectory);
    if (freeBytes - neededBytes < MIN_FREE_BYTES_AFTER_BACKUP) {
      throw new Error(
        `not enough free space in ${backupDirectory}: a backup needs up to ${megabytes(neededBytes)} and leaves ` +
          `at least ${megabytes(MIN_FREE_BYTES_AFTER_BACKUP)} free, and ${megabytes(freeBytes)} is free`,
      );
    }
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial);
    const storeCopy = path.join(partial, path.basename(storePath));
    await copyStore(storePath, storeCopy);
    if ((await sizeOf(configPath)) > 0) await copyFile(configPath, path.join(partial, path.basename(configPath)));
    for (const save of saves) {
      const to = path.join(partial, save.relative);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(save.from, to);
    }
    return { storeBytes: await sizeOf(storeCopy), saves: saves.map((save) => save.relative.split(path.sep).join("/")) };
  }

  /** The newest save backup of each environment's folder: its path, and where it goes (`saves/<environment>/<file>`). */
  async #newestSaves(): Promise<{ from: string; relative: string }[]> {
    const { savesDirectory } = this.#options;
    const environments = await readdir(savesDirectory, { withFileTypes: true }).catch(() => []);
    const saves: { from: string; relative: string }[] = [];
    for (const environment of environments
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
      const files = (await readdir(path.join(savesDirectory, environment))).filter(isSaveBackupFileName).sort();
      const newest = files.at(-1);
      if (newest === undefined) continue;
      saves.push({
        from: path.join(savesDirectory, environment, newest),
        relative: path.join(path.basename(savesDirectory), environment, newest),
      });
    }
    return saves;
  }

  /**
   * Keeps the newest `backupsKept`, and removes partial ones. Only folders named as backups count: nothing else in
   * the folder is touched. The backup just written is never removed, even if the clock went back and its name sorts
   * first. One that can't be removed is reported, and the rest are still tried.
   */
  async #rotate(justWritten: string): Promise<{ removed: string[]; failure: string | null }> {
    const { backupDirectory, backupsKept } = this.#options;
    let names: string[];
    try {
      names = await readdir(backupDirectory);
    } catch (error) {
      return { removed: [], failure: `couldn't list ${backupDirectory}: ${message(error)}` };
    }
    const backups = names.filter((name) => BACKUP_NAME.test(name) && name !== justWritten).sort();
    const toRemove = [
      ...backups.slice(0, Math.max(0, backups.length - (backupsKept - 1))),
      ...names.filter(
        (name) => name.endsWith(PARTIAL_SUFFIX) && BACKUP_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length)),
      ),
    ];
    const removed: string[] = [];
    const failures: string[] = [];
    for (const name of toRemove) {
      try {
        await rm(path.join(backupDirectory, name), { recursive: true });
        removed.push(name);
      } catch (error) {
        failures.push(`${name}: ${message(error)}`);
      }
    }
    return { removed, failure: failures.length === 0 ? null : `couldn't remove ${failures.join("; ")}` };
  }

  /** A path as the events give it: relative to the data directory when inside it, with `/`; else absolute. */
  #named(file: string): string {
    const relative = path.relative(this.#options.dataDirectory, file);
    return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative.split(path.sep).join("/");
  }
}

/** The store copied to `copyPath` and checked, in a worker thread (data-backup-worker.ts). */
function copyStore(storePath: string, copyPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./data-backup-worker.ts", import.meta.url), {
      workerData: { storePath, copyPath },
    });
    worker.once("message", (reply: { ok: boolean; failure?: string }) =>
      reply.ok ? resolve() : reject(new Error(`the store's copy failed: ${reply.failure}`)),
    );
    worker.once("error", (error) => reject(new Error(`the store's copy failed: ${message(error)}`)));
    // After a reply this does nothing: the promise is settled.
    worker.once("exit", (code) => reject(new Error(`the store's copy stopped (exit code ${code}) before it was done`)));
  });
}

/**
 * A thinning at the brain's start (#283, store-thinning.ts) runs only once a backup holds whole everything it cuts:
 * the newest backup, if it's within the interval and was taken at or after the thinning's cutoff (the snapshots it
 * cuts were all stored before it, and none thinned yet); else one taken now. Null when one does, else why not.
 */
export async function backupBeforeThinning(
  dataBackups: DataBackups | null,
  { beforeMs, nowMs, intervalMs }: { beforeMs: number; nowMs: number; intervalMs: number },
): Promise<string | null> {
  if (dataBackups === null) return "data backups are off (config.json's dataBackupsKept is 0)";
  const newestMs = dataBackups.newestBackupAtMs();
  if (newestMs !== null && newestMs >= beforeMs && newestMs <= nowMs && nowMs - newestMs < intervalMs) return null;
  const event = await dataBackups.backupNow("thinning");
  return event.type === DATA_BACKUP_EVENT_KIND ? null : `the backup before it failed: ${event.failure}`;
}

const REASONS: Record<string, string> = {
  start: "at the brain's start",
  interval: "at the interval",
  thinning: "before the start's thinning",
};

/** A data backup's event as a line: the brain's log, and the run report's section 1 (from the stored kind and detail). */
export function describeDataBackup(kind: string, detail: unknown): string {
  const fields = (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;
  const reason = REASONS[String(fields.reason)] ?? String(fields.reason);
  if (kind === DATA_BACKUP_FAILED_EVENT_KIND) return `data backup FAILED (${reason}): ${String(fields.failure)}`;
  const saves = Array.isArray(fields.saves) ? fields.saves.length : 0;
  const removed =
    Array.isArray(fields.removed) && fields.removed.length > 0 ? `; removed ${fields.removed.join(", ")}` : "";
  return (
    `data backup ${String(fields.directory)} (${reason}): the store ${megabytes(Number(fields.storeBytes))}, ` +
    `${saves} save backup${saves === 1 ? "" : "s"}, in ${formatSeconds(Number(fields.tookMs))}${removed}` +
    (typeof fields.rotationFailure === "string" ? `; older ones NOT removed: ${fields.rotationFailure}` : "")
  );
}
