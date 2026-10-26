// Rotating save backups (#92, architecture §6; R8's backups before irreversible intents come with intents, M3): the
// game's save, taken over the Remote File API on every connection and every interval, validated, filed under its
// environment, and rotated. Insurance against a bug or a corrupted save, and a source of real starting states for the
// simulator: a backup is the game's save at that moment in the format Steam writes to bitburnerSave_*.json.gz, which the
// simulator loads as a save fixture and the game's Options → Import Game accepts.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  type Clock,
  type Connection,
  EventListeners,
  type GameSaveFile,
  RfaClient,
  RfaError,
} from "@bitburner-agent/bridge";
import type { Environment } from "./telemetry-store.ts";

/** Where backups go inside the data directory: one folder per environment. */
export const SAVE_BACKUPS_DIRECTORY_NAME = "saves";
/** A backup's file name: its UTC time, with `-` for `:` (which Windows doesn't allow), then `.json.gz`. */
const BACKUP_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json\.gz$/;
const PARTIAL_SUFFIX = ".partial";
/** The longest delay a timer takes: Node runs a longer one after 1 ms. */
export const MAX_BACKUP_INTERVAL_MS = 2 ** 31 - 1;

export type SaveBackupEvent =
  /** `file` is relative to the data directory, e.g. `saves/E0/2026-10-27T03-30-00.000Z.json.gz`. */
  | { type: "saveBackup"; atMs: number; file: string; sizeBytes: number }
  | { type: "saveBackup"; atMs: number; failure: string }
  /** The backup was kept, but older ones couldn't all be deleted; the next rotation tries again. */
  | { type: "saveBackupRotationFailed"; atMs: number; failure: string };

export interface SaveBackupsOptions {
  dataDirectory: string;
  /** Backups go to `<dataDirectory>/saves/<environment>`, so environments never mix (architecture §9.4). */
  environment: Environment;
  /** From the brain's start, at most `MAX_BACKUP_INTERVAL_MS`. */
  backupIntervalMs: number;
  /** How many backups to keep in this environment's folder: the newest. */
  backupsKept: number;
  clock: Clock;
}

/** A save that came back but can't be kept. */
class DamagedSaveError extends Error {}
/** The disk refused (full, read-only, in use): an operating system error, which has a `syscall`. */
class DiskError extends Error {}

const isOperatingSystemError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).syscall === "string";

/**
 * Best effort, after a failed write: the failure is what gets recorded. `force` covers a file that was never made, but
 * not, on Linux, a path through a file (ENOTDIR); the next rotation clears anything left.
 */
function removePartialFile(partialFile: string): void {
  try {
    rmSync(partialFile, { force: true });
  } catch (error) {
    if (!isOperatingSystemError(error)) throw error;
  }
}

export class SaveBackups {
  readonly #options: SaveBackupsOptions;
  readonly #directory: string;
  readonly #listeners = new EventListeners<SaveBackupEvent>();
  /** The newest connection's client, while it's open: the one the interval's backups go over. */
  #client: RfaClient | null = null;
  #takingBackup = false;
  /** A backup was asked for while one was under way: it's taken as soon as that one ends (several become one). */
  #backupAskedForWhileTaking = false;

  /** Starts the interval at once; each connection brings a backup of its own. */
  constructor(options: SaveBackupsOptions) {
    if (!(options.backupIntervalMs >= 1 && options.backupIntervalMs <= MAX_BACKUP_INTERVAL_MS)) {
      throw new RangeError(`the backup interval must be from 1 ms to ${MAX_BACKUP_INTERVAL_MS} ms`);
    }
    if (!Number.isInteger(options.backupsKept) || options.backupsKept < 1) {
      throw new RangeError("at least one backup must be kept");
    }
    this.#options = options;
    this.#directory = path.join(options.dataDirectory, SAVE_BACKUPS_DIRECTORY_NAME, options.environment);
    const everyInterval = () => {
      void this.#takeBackup();
      options.clock.setTimeout(everyInterval, options.backupIntervalMs);
    };
    options.clock.setTimeout(everyInterval, options.backupIntervalMs);
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: SaveBackupEvent) => void): () => void {
    return this.#listeners.subscribe(listener);
  }

  /**
   * Takes a Remote File API connection from the game (beside the deployer, on its own client: request ids are unique
   * per connection): a backup now, and the interval's backups over it until it closes or a newer one comes.
   */
  accept(connection: Connection): void {
    const client = new RfaClient(connection, this.#options.clock);
    this.#client = client;
    connection.onClose(() => {
      if (this.#client === client) this.#client = null;
    });
    void this.#takeBackup();
  }

  /**
   * One at a time. A backup asked for while one is under way follows it, over the newest connection then, so a new
   * connection's backup isn't lost to one still waiting on an older connection.
   */
  async #takeBackup(): Promise<void> {
    if (this.#takingBackup) {
      this.#backupAskedForWhileTaking = true;
      return;
    }
    const client = this.#client;
    if (!client) return this.#recordFailure("no Remote File API connection");
    this.#takingBackup = true;
    try {
      const bytes = validSaveBytes(await client.getSaveFile());
      const fileName = this.#writeBackup(bytes);
      const file = path.posix.join(SAVE_BACKUPS_DIRECTORY_NAME, this.#options.environment, fileName);
      this.#listeners.emit({ type: "saveBackup", atMs: this.#options.clock.now(), file, sizeBytes: bytes.length });
      this.#rotateBackups(fileName);
    } catch (error) {
      // The game's side, or the disk: recorded, never kept. Anything else is a bug, which crashes the brain.
      if (!(error instanceof RfaError || error instanceof DamagedSaveError || error instanceof DiskError)) throw error;
      this.#recordFailure(error.message);
    } finally {
      this.#takingBackup = false;
    }
    if (this.#backupAskedForWhileTaking) {
      this.#backupAskedForWhileTaking = false;
      await this.#takeBackup();
    }
  }

  #recordFailure(failure: string): void {
    this.#listeners.emit({ type: "saveBackup", atMs: this.#options.clock.now(), failure });
  }

  /**
   * Written under a temporary name, then renamed, so a half-written backup is only ever a `.partial` file, which isn't
   * counted as a backup (and is removed on failure, or by the next rotation). Two backups in the same millisecond: the
   * second replaces the first.
   */
  #writeBackup(bytes: Buffer): string {
    const fileName = `${new Date(this.#options.clock.now()).toISOString().replaceAll(":", "-")}.json.gz`;
    const file = path.join(this.#directory, fileName);
    try {
      mkdirSync(this.#directory, { recursive: true });
      writeFileSync(`${file}${PARTIAL_SUFFIX}`, bytes);
      renameSync(`${file}${PARTIAL_SUFFIX}`, file);
    } catch (error) {
      removePartialFile(`${file}${PARTIAL_SUFFIX}`);
      if (!isOperatingSystemError(error)) throw error;
      throw new DiskError(`couldn't write ${fileName}: ${error.message}`);
    }
    return fileName;
  }

  /**
   * Keeps the newest `backupsKept` backups, and removes partial ones. Only files named as backups count: nothing else
   * in the folder is touched. The backup just written is never deleted, even if the clock went back and its name sorts
   * first. A file that can't be deleted is reported, and the rest are still tried.
   */
  #rotateBackups(justWritten: string): void {
    let names: string[];
    try {
      names = readdirSync(this.#directory);
    } catch (error) {
      if (!isOperatingSystemError(error)) throw error;
      this.#recordRotationFailure(`couldn't list ${this.#directory}: ${error.message}`);
      return;
    }
    const backups = names.filter((name) => BACKUP_FILE_NAME.test(name) && name !== justWritten).sort();
    const toDelete = [
      ...backups.slice(0, Math.max(0, backups.length - (this.#options.backupsKept - 1))),
      ...names.filter(
        (name) => name.endsWith(PARTIAL_SUFFIX) && BACKUP_FILE_NAME.test(name.slice(0, -PARTIAL_SUFFIX.length)),
      ),
    ];
    const failures: string[] = [];
    for (const name of toDelete) {
      try {
        rmSync(path.join(this.#directory, name));
      } catch (error) {
        if (!isOperatingSystemError(error)) throw error;
        failures.push(`${name}: ${error.message}`);
      }
    }
    if (failures.length > 0) this.#recordRotationFailure(`couldn't delete ${failures.join("; ")}`);
  }

  #recordRotationFailure(failure: string): void {
    this.#listeners.emit({ type: "saveBackupRotationFailed", atMs: this.#options.clock.now(), failure });
  }
}

/**
 * The save's gzip bytes, once they're known to be what the game's own Import Game accepts: gzip, strict UTF-8, JSON, a
 * `BitburnerSaveObject` whose `data.PlayerSave` is a string (SaveDataUtils.ts:25, SaveObject.ts:157-167). Otherwise a
 * `DamagedSaveError` saying why not.
 */
function validSaveBytes({ binary, save }: GameSaveFile): Buffer {
  if (!binary) throw new DamagedSaveError("the game sent its save as text (binary: false), not Steam's gzip bytes");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is every byte value
  if (/[^\x00-\xff]/.test(save)) throw new DamagedSaveError("the save isn't one byte per character");
  const bytes = Buffer.from(save, "latin1");
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(gunzipSync(bytes));
  } catch (error) {
    throw new DamagedSaveError(`the save doesn't gunzip into UTF-8 (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DamagedSaveError(`the save isn't JSON (${(error as Error).message})`);
  }
  const saveObject = parsed as { ctor?: unknown; data?: { PlayerSave?: unknown } } | null;
  if (saveObject?.ctor !== "BitburnerSaveObject") throw new DamagedSaveError("the save isn't a BitburnerSaveObject");
  if (typeof saveObject.data?.PlayerSave !== "string") throw new DamagedSaveError("the save has no player");
  return bytes;
}
