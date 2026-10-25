// The types a Simulation (parent) and its host process (child) share: options, fixtures, results, and the messages
// between them over Node IPC. Every message carries a `type`, so new kinds can be added without ambiguity.

/**
 * A new game starts the interactive tutorial; "skipped" ends it as the Skip button does. On v3.0.1 a running tutorial
 * stops finished scripts from being cleaned up, so there is no default: every fixture must choose.
 */
export type Tutorial = "running" | "skipped";

/**
 * A save, as the game writes it: a Steam/Electron `.json.gz` file or the web build's base64 export, given as bytes or
 * as a file path (the only form a JSON scenario can use). The virtual epoch is the save's own `lastUpdate` plus
 * `offlineMs` (default 0), so the game's real offline-progress path runs.
 */
export type SaveFixture = { kind: "save"; offlineMs?: number } & (
  | { bytes: Uint8Array; path?: never }
  | { path: string; bytes?: never }
);

/** The game state a simulation starts from. */
export type Fixture = { kind: "new"; tutorial: Tutorial } | SaveFixture;

/**
 * A fixture as the host receives it. Only kinds that need work in the parent differ from `Fixture`: a save arrives
 * already read, its format known (`data` is the gzip bytes in base64, or the web export's base64 text itself).
 */
export type HostFixture = Exclude<Fixture, SaveFixture> | { kind: "save"; format: "gzip" | "base64"; data: string };

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

export interface SimulationOptions {
  /** Seeds every source of randomness the game can reach. An unsigned 32-bit integer. */
  seed: number;
  /**
   * Virtual epoch: what the game's Date reads when it loads. A non-negative integer. Required, except with a save
   * fixture, which takes its epoch from the save (and refuses this option).
   */
  epochMs?: number;
  /** Without a fixture the engine is loaded but no game is booted. */
  fixture?: Fixture;
  /**
   * How `ns.prompt` is answered, since there is no player to answer it. The first rule whose `match` is part of the
   * prompt's text gives the answer. A prompt no rule matches stays open, as with nobody at the screen, until a newer
   * prompt replaces it (which closes it as dismissing does).
   */
  prompts?: PromptRule[];
  testHooks?: TestHooks;
}

export interface PromptRule {
  /** Matches a prompt whose text contains this (case-sensitive). */
  match: string;
  /**
   * `true`/`false` for a yes/no prompt; the text for a text prompt; one of the choices for a select prompt. An answer
   * a player couldn't give fails the script's `ns.prompt` call.
   */
  answer: string | boolean;
}

/** What the host process receives: the epoch decided and the fixture resolved. */
export interface HostOptions {
  seed: number;
  epochMs: number;
  fixture?: HostFixture;
  prompts?: PromptRule[];
  testHooks?: TestHooks;
}

/** The game arrived at the BitVerse page, where a player picks the next BitNode (see `bitverseReached`). */
export interface BitVerseReached {
  /** Left early with b1t_flum3.exe, rather than by destroying the BitNode. */
  flume: boolean;
  /** The BitNode the player is leaving: the one the BitVerse page shows as destroyed (`Player.bitNodeN`). */
  destroyedBitNode: number;
}

/** A prompt as the game raised it (`ns.prompt`), for the harness to answer. */
export interface PromptRequest {
  text: string;
  /** "boolean" is a yes/no prompt (the game's default type). */
  kind: "boolean" | "text" | "select";
  /** A select prompt's options; empty otherwise. */
  choices: string[];
}

/**
 * Events the game itself raises for its UI, which the engine bundle reports to the host. React content (alerts and
 * toasts built from components) is reduced to its text.
 */
export type GameEvent =
  /** A popup: `ns.alert`, a message arriving, `dialogBoxCreate` anywhere in the game. */
  | { type: "alert"; text: string }
  /** A toast: `ns.toast`, achievements, saves… The variants are the game's `ToastVariant` (ui/Enums.ts). */
  | { type: "toast"; text: string; variant: "success" | "warning" | "error" | "info" }
  /**
   * An error the game reports in its error popup: a script error, or a promise rejection nobody handled. Each popup is
   * closed at once (as its Close button does), so every error is reported, repeats included, unless the game's
   * settings suppress error popups (then the game reports none).
   */
  | { type: "error"; errorType: string; message: string; host: string; script: string; pid: number | null }
  /** `ns.prompt`, and the answer a `PromptRule` gave it; with no matching rule, nobody answered (`answer` is null). */
  | ({ type: "prompt"; answer: string | boolean | null; answeredBy: "rule" | "nobody" } & PromptRequest)
  /**
   * The game went to the BitVerse page, where the player picks the next BitNode: a BitNode was destroyed (or, with
   * `flume`, left early by b1t_flum3.exe), or a save loaded there. Navigating there kills every running script, as
   * the real router does; a save that starts there restarts its saved scripts as usual. The game then waits there
   * until something enters a BitNode.
   */
  | ({ type: "bitverseReached" } & BitVerseReached);

/**
 * Things that happened in the game that a browser would have shown or done outside the page, in order. `at` is the
 * virtual epoch time it happened, or 0 if it happened while the host was still being set up.
 */
export type SimEvent = { at: number } & (
  | GameEvent
  /** The game started a file download (an `<a download>` click), e.g. a save export or a pre-v3 backup. */
  | { type: "download"; filename: string; bytes: number }
  /**
   * An error or warning on the console: from the game, a library, or an uncaught error (as a browser logs it).
   * Machine-specific file paths in the message are replaced by `<repo>`, so the log reads the same on every machine.
   */
  | { type: "console"; level: "error" | "warn"; message: string }
);

/** A page of the event log: events from position `since` on, and where the next page starts. */
export interface EventPage {
  events: SimEvent[];
  next: number;
  /** Events older than the kept window, no longer available (the log keeps the most recent ones). */
  dropped: number;
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
  /** The page the game's Router is on, as its `Page` value: e.g. "Terminal", "BitVerse", "Bladeburner Cinematic". */
  page: string;
  /** `Player.focus`: whether the player is focused on their current work. */
  focus: boolean;
  /** `Player.exploits`: the game's anti-cheat findings. A simulation must never earn any by accident. */
  exploits: string[];
  /** `CONSTANTS.isInTestEnvironment`: true would change game behaviour (it must be false, as in a browser). */
  testEnvironment: boolean;
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
  /** The game's own save, gzip bytes in base64 (the Steam `.json.gz` format). */
  save(params: Record<string, never>): string;
  /** The event log from position `since` (default 0) on, in order. */
  events(params: { since: number }): EventPage;
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
  /**
   * Navigates as game code does (`Router.toPage`): a simple page by its `Page` value, or "BitVerse" (only then is
   * `flume` used). Test-only: it changes game state (going to the BitVerse kills every script), and scenarios must not
   * use it.
   */
  "diagnostics.toPage"(params: { page: string; flume?: boolean }): void;
  /** `Router.back()`, as the UI's Back buttons call it. Test-only, like `diagnostics.toPage`. */
  "diagnostics.back"(params: Record<string, never>): void;
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
  if (options.prompts !== undefined) validatePrompts(options.prompts);
  const delay = options.testHooks?.importDelayMs;
  if (delay && !(Number.isInteger(delay[0]) && Number.isInteger(delay[1]) && 0 <= delay[0] && delay[0] <= delay[1])) {
    throw new RangeError(
      `testHooks.importDelayMs must be [min, max] integers with 0 <= min <= max, got ${JSON.stringify(delay)}`,
    );
  }
}

function validatePrompts(prompts: PromptRule[]): void {
  const valid = (rule: PromptRule) =>
    typeof rule === "object" &&
    rule !== null &&
    typeof rule.match === "string" &&
    rule.match !== "" &&
    (typeof rule.answer === "string" || typeof rule.answer === "boolean");
  if (!Array.isArray(prompts) || !prompts.every(valid)) {
    throw new RangeError("prompts must be rules of { match: non-empty text, answer: text or true/false }");
  }
}

function validateFixture(fixture: HostFixture): void {
  switch (fixture.kind) {
    case "new":
      if (fixture.tutorial !== "running" && fixture.tutorial !== "skipped") {
        throw new RangeError(
          `a new-game fixture needs tutorial: "running" or "skipped", got ${JSON.stringify(fixture.tutorial)}`,
        );
      }
      return;
    case "save":
      if ((fixture.format !== "gzip" && fixture.format !== "base64") || typeof fixture.data !== "string") {
        throw new RangeError("a save fixture needs its data, as gzip (base64-encoded) or base64 text");
      }
      return;
    default: {
      // Exhaustive: a new fixture kind that isn't handled here is a type error.
      const unhandled: never = fixture;
      throw new RangeError(`unknown fixture kind ${JSON.stringify((unhandled as { kind: unknown }).kind)}`);
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
