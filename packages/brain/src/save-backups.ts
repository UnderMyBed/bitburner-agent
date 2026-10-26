// Rotating save backups (#92, architecture §6, R8): the game's own save, taken over the Remote File API on every
// connection and every interval, validated, filed under its environment, and rotated. Insurance against a bug or a
// corrupted save, and a source of real starting states for the simulator: these are the bytes Steam writes to
// bitburnerSave_*.json.gz, which the simulator loads as a save fixture and the game's Options → Import Game accepts.
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

/** A backup's file name: its UTC time, with `-` for `:` (which Windows doesn't allow), then `.json.gz`. */
const BACKUP_FILE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json\.gz$/;

export type SaveBackupEvent =
  | { type: "saveBackup"; atMs: number; file: string; sizeBytes: number }
  | { type: "saveBackup"; atMs: number; failure: string };

export interface SaveBackupsOptions {
  /** This environment's backups: `<data dir>/saves/<environment>`, created when the first is written. */
  directory: string;
  intervalMs: number;
  /** How many backups to keep in `directory`: the newest. */
  kept: number;
  clock: Clock;
  /** Where a listener's error goes. Default: raised as an uncaught exception, so the brain fails fast. */
  onListenerError?: (error: unknown) => void;
}

/** A save that came back but can't be kept. */
class DamagedSaveError extends Error {}

export class SaveBackups {
  readonly #options: SaveBackupsOptions;
  readonly #listeners: EventListeners<SaveBackupEvent>;
  /** The newest connection's client: the one the interval's backups go over. */
  #client: RfaClient | null = null;
  #taking = false;
  /** A backup was asked for while one was under way: it's taken as soon as that one ends. */
  #takeAgain = false;

  /** Starts the interval at once; the first backup comes with the game's first connection. */
  constructor(options: SaveBackupsOptions) {
    if (!(options.intervalMs > 0)) throw new RangeError("the backup interval must be positive");
    if (!Number.isInteger(options.kept) || options.kept < 1) throw new RangeError("at least one backup must be kept");
    this.#options = options;
    this.#listeners = new EventListeners(options.onListenerError);
    const everyInterval = () => {
      void this.#take();
      options.clock.setTimeout(everyInterval, options.intervalMs);
    };
    options.clock.setTimeout(everyInterval, options.intervalMs);
  }

  /** Calls `listener` with every event from now on; returns a function that stops it. */
  subscribe(listener: (event: SaveBackupEvent) => void): () => void {
    return this.#listeners.subscribe(listener);
  }

  /**
   * Takes a Remote File API connection from the game (beside the deployer, on its own client: request ids are unique
   * per connection): a backup now, and the interval's backups over it until a newer one comes.
   */
  accept(connection: Connection): void {
    this.#client = new RfaClient(connection, this.#options.clock);
    void this.#take();
  }

  /**
   * One at a time. A backup asked for while one is under way follows it, over the newest connection then, so a new
   * connection's backup isn't lost to one still waiting on an older connection.
   */
  async #take(): Promise<void> {
    if (this.#taking) {
      this.#takeAgain = true;
      return;
    }
    const client = this.#client;
    if (!client) return this.#fail("no Remote File API connection");
    this.#taking = true;
    try {
      const bytes = validSaveBytes(await client.getSaveFile());
      const file = this.#write(bytes);
      this.#rotate();
      this.#listeners.emit({ type: "saveBackup", atMs: this.#options.clock.now(), file, sizeBytes: bytes.length });
    } catch (error) {
      // The game's side, or the disk: recorded, never kept. Anything else is a bug, which crashes the brain.
      const isFileSystemError = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
      if (!(error instanceof RfaError || error instanceof DamagedSaveError || isFileSystemError)) throw error;
      this.#fail((error as Error).message);
    } finally {
      this.#taking = false;
    }
    if (this.#takeAgain) {
      this.#takeAgain = false;
      await this.#take();
    }
  }

  #fail(failure: string): void {
    this.#listeners.emit({ type: "saveBackup", atMs: this.#options.clock.now(), failure });
  }

  /** Written under a temporary name, then renamed, so a crash never leaves half a backup among the real ones. */
  #write(bytes: Buffer): string {
    const { directory, clock } = this.#options;
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${new Date(clock.now()).toISOString().replaceAll(":", "-")}.json.gz`);
    writeFileSync(`${file}.partial`, bytes);
    renameSync(`${file}.partial`, file);
    return file;
  }

  /** Keeps the newest `kept` backups. Only files named as backups count: nothing else in the folder is touched. */
  #rotate(): void {
    const { directory, kept } = this.#options;
    const backups = readdirSync(directory)
      .filter((name) => BACKUP_FILE_NAME.test(name))
      .sort();
    for (const name of backups.slice(0, Math.max(0, backups.length - kept))) rmSync(path.join(directory, name));
  }
}

/** The save's gzip bytes, once they're known to gunzip into a Bitburner save; otherwise why not. */
function validSaveBytes({ binary, save }: GameSaveFile): Buffer {
  if (!binary) throw new DamagedSaveError("the game sent its save as text (binary: false), not Steam's gzip bytes");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is every byte value
  if (/[^\x00-\xff]/.test(save)) throw new DamagedSaveError("the save isn't one byte per character");
  const bytes = Buffer.from(save, "latin1");
  let json: string;
  try {
    json = gunzipSync(bytes).toString("utf8");
  } catch (error) {
    throw new DamagedSaveError(`the save doesn't gunzip (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DamagedSaveError(`the save isn't JSON (${(error as Error).message})`);
  }
  if ((parsed as { ctor?: unknown } | null)?.ctor !== "BitburnerSaveObject") {
    throw new DamagedSaveError("the save isn't a BitburnerSaveObject");
  }
  return bytes;
}
