// Messages between a Simulation (parent) and its host process (child), over Node IPC. Every message carries a
// `type`, so new kinds (e.g. host events in later tasks) can be added without ambiguity.

/**
 * A new game starts the interactive tutorial; "skipped" ends it as the Skip button does. On v3.0.1 a running tutorial
 * stops finished scripts from being cleaned up, so there is no default: every fixture must choose.
 */
export type Tutorial = "running" | "skipped";

/** The game state a simulation starts from. A union: later fixture kinds add members. */
export type Fixture = { kind: "new"; tutorial: Tutorial };

/**
 * Test-only knobs for the simulator's own tests. Never use them in scenarios: with the barrier disabled, the
 * determinism guarantee doesn't hold.
 * @internal
 */
export interface TestHooks {
  /** Delays every script import by a real (not virtual) [min, max] ms, to prove the import barrier works. */
  importDelayMs?: [number, number];
  /** Turns the import barrier off, to show that the barrier test would catch its absence. */
  disableImportBarrier?: boolean;
  /** How long an import may take, in real ms, before the host gives up (default 30 s). */
  importTimeoutMs?: number;
}

export type ScriptArg = string | number | boolean;

export interface RunOptions {
  /** Default 1. */
  threads?: number;
  args?: ScriptArg[];
}

/** `pid` is 0 when the game refused to start the script; `error` then holds the game's own message. */
export interface RunResult {
  pid: number;
  error?: string;
}

export interface ProcessInfo {
  pid: number;
  filename: string;
  threads: number;
  args: ScriptArg[];
}

export interface HostOptions {
  /** Seeds every source of randomness the game can reach. An unsigned 32-bit integer. */
  seed: number;
  /** Virtual epoch: what the game's Date reads when it loads. A non-negative integer. */
  epochMs: number;
  /** Without a fixture the engine is loaded but no game is booted. */
  fixture?: Fixture;
  testHooks?: TestHooks;
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
  /** Writes a script or text file, as a player saving it in the editor would. */
  writeFile(params: { host: string; path: string; content: string }): void;
  /** Starts a script as the terminal's `run` does: the game's own RAM check, pid and messages. */
  run(params: { host: string; script: string; threads: number; args: ScriptArg[] }): RunResult;
  /** Running scripts on a server, by pid. */
  ps(params: { host: string }): ProcessInfo[];
  /** A running or recently finished script's log lines. */
  logs(params: { pid: number }): string[];
  /** Kills a running script; false if there is none with that pid. */
  kill(params: { pid: number }): boolean;
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
  if (options.fixture !== undefined) validateFixture(options.fixture);
  const delay = options.testHooks?.importDelayMs;
  if (delay && !(Number.isInteger(delay[0]) && Number.isInteger(delay[1]) && 0 <= delay[0] && delay[0] <= delay[1])) {
    throw new RangeError(
      `testHooks.importDelayMs must be [min, max] integers with 0 <= min <= max, got ${JSON.stringify(delay)}`,
    );
  }
}

function validateFixture(fixture: Fixture): void {
  switch (fixture.kind) {
    case "new":
      if (fixture.tutorial !== "running" && fixture.tutorial !== "skipped") {
        throw new RangeError(
          `a new-game fixture needs tutorial: "running" or "skipped", got ${JSON.stringify(fixture.tutorial)}`,
        );
      }
      return;
    default: {
      // Exhaustive: a new fixture kind that isn't handled here is a type error.
      const unhandled: never = fixture.kind;
      throw new RangeError(`unknown fixture kind ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Type checks only: a bad thread count gets the game's own refusal (pid 0), as at the terminal. */
export function validateRun({ threads, args }: { threads: number; args: ScriptArg[] }): void {
  if (typeof threads !== "number") throw new RangeError(`threads must be a number, got ${typeof threads}`);
  if (!args.every((arg) => ["string", "number", "boolean"].includes(typeof arg))) {
    throw new RangeError("script args must be strings, numbers or booleans");
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
