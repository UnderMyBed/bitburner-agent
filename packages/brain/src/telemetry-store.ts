// The telemetry store (architecture §7, §11): every snapshot and bridge event, tagged with the environment and release
// that produced it, in SQLite through Node's built-in `node:sqlite`. Losing it never breaks play: the game is the truth.
import { DatabaseSync } from "node:sqlite";

/** E0 Steam, E1 the simulator, E2 the source build (architecture §9.4). */
export const ENVIRONMENTS = ["E0", "E1", "E2"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** How long a write waits for a reader's lock before failing, so the dashboard reading never fails the brain's writes. */
const BUSY_TIMEOUT_MS = 5_000;

/** Who produced a record: every row carries it, so releases and environments can be compared (§7, §11). */
export interface RecordContext {
  environment: Environment;
  /** The brain's version plus the Agent's deployment, e.g. "v0.2.0+3f2a…". */
  release: string;
}

export interface StoredSnapshot {
  agentSessionId: string;
  tier: string;
  sequenceNumber: number;
  gameTimeMs: number;
  /** From the brain's clock: virtual time under the simulator. */
  receivedAtMs: number;
  /** Sequence numbers skipped before this one (the control channel's count). */
  missedBefore: number;
  data: unknown;
}

export interface StoredEvent {
  atMs: number;
  /** e.g. agentConnected, agentDisconnected, connectionRejected, deploy, relaunch. */
  kind: string;
  detail: unknown;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    environment TEXT NOT NULL,
    release TEXT NOT NULL,
    agent_session_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,
    game_time_ms INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    missed_before INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS snapshots_by_tier_and_time ON snapshots (environment, tier, received_at_ms);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    environment TEXT NOT NULL,
    release TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class TelemetryStore {
  readonly #database: DatabaseSync;

  private constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Opens (creating if needed) the store at `filePath`, in WAL mode so a reader (the dashboard) never blocks a write. */
  static open(filePath: string): TelemetryStore {
    const database = new DatabaseSync(filePath, { timeout: BUSY_TIMEOUT_MS });
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(SCHEMA);
    return new TelemetryStore(database);
  }

  /** Opens an existing store for reading only (the gap report): it takes no write lock and changes nothing. */
  static openReadOnly(filePath: string): TelemetryStore {
    return new TelemetryStore(new DatabaseSync(filePath, { readOnly: true, timeout: BUSY_TIMEOUT_MS }));
  }

  /** The journal mode in force: `wal` for a store opened with `open`. */
  journalMode(): string {
    return (this.#database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  }

  recordSnapshot(context: RecordContext, snapshot: StoredSnapshot): void {
    this.#database
      .prepare(
        `INSERT INTO snapshots (environment, release, agent_session_id, tier, sequence_number, game_time_ms,
          received_at_ms, missed_before, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        context.environment,
        context.release,
        snapshot.agentSessionId,
        snapshot.tier,
        snapshot.sequenceNumber,
        snapshot.gameTimeMs,
        snapshot.receivedAtMs,
        snapshot.missedBefore,
        JSON.stringify(snapshot.data) ?? "null",
      );
  }

  recordEvent(context: RecordContext, event: StoredEvent): void {
    this.#database
      .prepare("INSERT INTO events (environment, release, at_ms, kind, detail) VALUES (?, ?, ?, ?, ?)")
      .run(context.environment, context.release, event.atMs, event.kind, JSON.stringify(event.detail) ?? "null");
  }

  /** Every snapshot from an environment, in the order stored. */
  snapshots({ environment }: { environment: Environment }): (RecordContext & StoredSnapshot)[] {
    const rows = this.#database
      .prepare(
        `SELECT environment, release, agent_session_id, tier, sequence_number, game_time_ms, received_at_ms,
          missed_before, data FROM snapshots WHERE environment = ? ORDER BY id`,
      )
      .all(environment) as Record<string, string | number>[];
    return rows.map((row) => ({
      environment: row.environment as Environment,
      release: row.release as string,
      agentSessionId: row.agent_session_id as string,
      tier: row.tier as string,
      sequenceNumber: row.sequence_number as number,
      gameTimeMs: row.game_time_ms as number,
      receivedAtMs: row.received_at_ms as number,
      missedBefore: row.missed_before as number,
      data: JSON.parse(row.data as string) as unknown,
    }));
  }

  /** When each fast snapshot arrived, in a window: the gap report's input. */
  fastSnapshotTimes({
    environment,
    sinceMs,
    untilMs,
  }: {
    environment: Environment;
    sinceMs: number;
    untilMs: number;
  }): number[] {
    const rows = this.#database
      .prepare(
        `SELECT received_at_ms FROM snapshots WHERE environment = ? AND tier = 'fast'
          AND received_at_ms BETWEEN ? AND ? ORDER BY received_at_ms`,
      )
      .all(environment, sinceMs, untilMs) as { received_at_ms: number }[];
    return rows.map((row) => row.received_at_ms);
  }

  /** Every event from an environment, in the order stored. */
  events({ environment }: { environment: Environment }): (RecordContext & StoredEvent)[] {
    const rows = this.#database
      .prepare("SELECT environment, release, at_ms, kind, detail FROM events WHERE environment = ? ORDER BY id")
      .all(environment) as Record<string, string | number>[];
    return rows.map((row) => ({
      environment: row.environment as Environment,
      release: row.release as string,
      atMs: row.at_ms as number,
      kind: row.kind as string,
      detail: JSON.parse(row.detail as string) as unknown,
    }));
  }

  getSetting(key: string): string | null {
    const row = this.#database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.#database
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  close(): void {
    this.#database.close();
  }
}
