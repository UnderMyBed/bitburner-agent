// Messages between a Simulation (parent) and its host process (child), over Node IPC. Every message carries a
// `type`, so new kinds (e.g. host events in later tasks) can be added without ambiguity.

/**
 * A new game starts the interactive tutorial; "skipped" ends it as the Skip button does. On v3.0.1 a running tutorial
 * stops finished scripts from being cleaned up, so there is no default: every fixture must choose.
 */
export type Tutorial = "running" | "skipped";

/** The game state a simulation starts from. A union: later fixture kinds add members. */
export type Fixture = { kind: "new"; tutorial: Tutorial };

export interface HostOptions {
  /** Seeds every source of randomness the game can reach. An unsigned 32-bit integer. */
  seed: number;
  /** Virtual epoch: what the game's Date reads when it loads. A non-negative integer. */
  epochMs: number;
  /** Without a fixture the engine is loaded but no game is booted. */
  fixture?: Fixture;
}

/** A fixed-schema snapshot of the game, for tests and reports. */
export interface GameSummary {
  /** Virtual time since the simulation started. */
  virtualMs: number;
  playtimeMs: number;
  bitNodeN: number;
  bitNodeLevel: number;
  /** Source-File number → level. */
  sourceFiles: Record<string, number>;
  money: number;
  hackingLevel: number;
  hackingExp: number;
  homeRamUsed: number;
  homeRamMax: number;
  scripts: number;
  augsInstalled: number;
  augsQueued: number;
}

export interface GameDiagnostics {
  tutorialRunning: boolean;
  /** The game's own setting (0: the harness turned autosave off). */
  autosaveInterval: number;
  /** Every coding contract, as "host:file", sorted. */
  contracts: string[];
  /** Real milliseconds the host took to load the engine and boot the fixture. */
  bootMs: number;
  /** The default locale the game sees, and the locale the host pinned (see src/host/parity/locale.ts). */
  defaultLocale: string;
  pinnedLocale: string | null;
}

export interface ClockDiagnostics {
  /** `Engine._lastUpdate`, which the engine reads from Date when its module loads. */
  engineLastUpdate: number;
  /** `Date.now()` and `performance.now()` as seen from inside the engine bundle. */
  engineDateNow: number;
  enginePerformanceNow: number;
}

export interface RandomSample {
  math: number[];
  /** Drawn through `window`: guards that window's Math and crypto stay the seeded globals. */
  windowMath: number[];
  cryptoBytes: number[];
  windowCryptoBytes: number[];
  uuid: string;
}

/** Every method the host answers. Diagnostics exist for tests and troubleshooting. */
export interface HostMethods {
  now(params: Record<string, never>): number;
  /** Advances virtual time by a non-negative integer number of ms; returns the new virtual now. */
  advance(params: { ms: number }): number;
  summary(params: Record<string, never>): GameSummary;
  /** sha256 of the game's own save JSON: two runs are identical exactly when their saves are. */
  stateHash(params: Record<string, never>): string;
  "diagnostics.clock"(params: Record<string, never>): ClockDiagnostics;
  "diagnostics.game"(params: Record<string, never>): GameDiagnostics;
  "diagnostics.random"(params: { count: number }): RandomSample;
  /** Writes `message` to stderr and exits with `code`. */
  "diagnostics.crash"(params: { code: number; message: string }): never;
}

export type Method = keyof HostMethods;
export type Params<M extends Method> = Parameters<HostMethods[M]>[0];
export type Result<M extends Method> = ReturnType<HostMethods[M]>;

export type ParentMessage =
  | { type: "init"; options: HostOptions }
  | { type: "request"; id: number; method: Method; params: unknown };

export type HostMessage =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: { message: string; stack?: string } };

export function validateHostOptions(options: HostOptions): void {
  const { seed, epochMs } = options;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be an integer in [0, 2^32), got ${seed}`);
  }
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new RangeError(`epochMs must be a non-negative integer, got ${epochMs}`);
  }
  const { fixture } = options;
  if (fixture !== undefined) {
    if (fixture.kind !== "new") throw new RangeError(`unknown fixture kind ${JSON.stringify(fixture.kind)}`);
    if (fixture.tutorial !== "running" && fixture.tutorial !== "skipped") {
      throw new RangeError(
        `a new-game fixture needs tutorial: "running" or "skipped", got ${JSON.stringify(fixture.tutorial)}`,
      );
    }
  }
}

export function validateAdvance(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`advance(ms) needs a non-negative integer number of milliseconds, got ${ms}`);
  }
}

/** One wording for how a process ended, used by every error that reports it. */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `was killed by ${signal}` : `exited with code ${code}`;
}
