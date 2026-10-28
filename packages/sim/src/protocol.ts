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

/**
 * Entering BitNode `n` with the given Source-Files (BitNode → level), from a new game, through the game's own
 * `enterBitNode` as b1t_flum3.exe does: a player with these Source-Files and no other history. The BitNode's level is
 * `sourceFiles[n] + 1`, capped at 3 except in BitNode 12, as the game's `getBitNodeLevel` computes it.
 */
export interface BitNodeFixture {
  kind: "bitnode";
  n: number;
  sourceFiles: Record<number, number>;
}

/** The game state a simulation starts from. */
export type Fixture = { kind: "new"; tutorial: Tutorial } | BitNodeFixture | SaveFixture;

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
  /**
   * Caps the simulation process's V8 heap (`--max-old-space-size`), in MB: a whole number, at least 256. V8 grows its
   * heap toward the limit before collecting, so a long run can hold far more memory than it uses; a cap makes it
   * collect sooner. A run that needs more than the cap crashes, as out of memory. Default: Node's.
   */
  maxHeapMb?: number;
  /** The page's network (ADR 0012): which WebSocket URLs the parent listens on. Without it, every socket is refused. */
  network?: NetworkOptions;
  /** Game settings set right after the fixture boots, before the RFA client's timer fires. A harness edit. */
  gameSettings?: GameSettingsOverride;
  testHooks?: TestHooks;
}

export interface NetworkOptions {
  /**
   * `ws:` or `wss:` URLs a page socket may connect to, the parent being the other end. A URL matches exactly as the
   * browser normalises it: `ws://localhost:1` isn't `ws://127.0.0.1:1`. A socket to any other URL fails, as a refused
   * connection does.
   */
  listenUrls: string[];
}

/** Game settings a harness may set (Settings.ts): the Remote File API's address, port and retry delay, and autoexec. */
export interface GameSettingsOverride {
  RemoteFileApiAddress?: string;
  /** 0 turns the RFA client off (the game's default). */
  RemoteFileApiPort?: number;
  /** Seconds before the RFA client reconnects after a drop; 0 (the default) never reconnects. */
  RemoteFileApiReconnectionDelay?: number;
  /** A script (and its arguments) on home that runs on every load of a saved game. */
  AutoexecScript?: string;
}

/**
 * What the page's sockets did, for the parent to take (`network.take`), in order. `atMs` is the virtual time it
 * happened. `close` is the page closing its own socket (`code` null when it gave none).
 */
export type NetworkOutboxEntry = { connectionId: number; atMs: number } & (
  | { type: "connect"; url: string }
  | { type: "message"; data: string }
  | { type: "close"; code: number | null; reason: string }
);

/** The least `maxHeapMb`: a booted game's heap is about 110 MB. */
export const MIN_HEAP_MB = 256;

/** Why `maxHeapMb` isn't usable, or null if it is (or isn't set). */
export function maxHeapError(maxHeapMb: number | undefined): string | null {
  if (maxHeapMb === undefined || (Number.isSafeInteger(maxHeapMb) && maxHeapMb >= MIN_HEAP_MB)) return null;
  return `maxHeapMb must be a whole number of MB, at least ${MIN_HEAP_MB}, got ${maxHeapMb}`;
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
  network?: NetworkOptions;
  gameSettings?: GameSettingsOverride;
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
  | ({ type: "bitverseReached" } & BitVerseReached)
  /**
   * The game left BitNode `destroyed` for BitNode `entered` by destroying it: through w0r1d_d43m0n
   * (`ns.singularity.destroyW0r1dD43m0n`), or through the BitVerse after backdooring it.
   */
  | { type: "bitnodeDestroyed"; destroyed: number; entered: number }
  /** The game left BitNode `left` for BitNode `entered` without destroying it (b1t_flum3.exe, `ns.singularity.b1tflum3`). */
  | { type: "bitnodeFlumed"; left: number; entered: number };

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

/** A condition that ends a run (`runUntil`), checked after every timer. */
export type StopCondition =
  /** An event of this type was recorded during the run (see `RunUntilParams.eventsFrom`). */
  | { event: StopEvent }
  /**
   * A script with this filename (its full path, as `ps` shows it) has run, and none is running now, on any server. A
   * script that hasn't started yet doesn't count as exited.
   */
  | { scriptExited: string }
  /** A `GameSummary` field compares with `value` as `op` says, e.g. `{ field: "money", op: ">=", value: 1e9 }`. */
  | { summary: { field: SummaryField; op: ComparisonOp; value: number } };

export const STOP_EVENTS = ["bitnodeDestroyed", "bitnodeFlumed", "bitverseReached"] as const;
export type StopEvent = (typeof STOP_EVENTS)[number];
export const COMPARISON_OPS = ["<", "<=", "==", ">=", ">"] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];
/**
 * The numeric `GameSummary` fields, except `virtualMs`: how long a run takes is its `ms` (a stop on time alone would
 * depend on how the run is cut up, since time passes between timers).
 */
export type SummaryField = Exclude<
  { [K in keyof GameSummary]: GameSummary[K] extends number ? K : never }[keyof GameSummary],
  "virtualMs"
>;

/**
 * What a run does when the game arrives at the BitVerse, where a player picks the next BitNode: stop there, or enter
 * BitNode `enter` at once, as a player clicking its portal would. Without it, the game waits at the BitVerse.
 */
export type OnBitVerse = "stop" | { enter: number };

export interface RunUntilParams {
  /** The most virtual time to run, a non-negative integer of ms. */
  ms: number;
  /** The run stops after the first timer at which any of these holds. */
  stopWhen?: StopCondition[];
  onBitVerse?: OnBitVerse;
  /**
   * `{ event }` conditions count events from this position in the event log (`EventPage.next`), e.g. 0 for every
   * event since the game booted. Default: the log's end when the call starts, so only events during the call.
   */
  eventsFrom?: number;
  /**
   * Fail the run (reject) if the game loop has fallen behind virtual time by more than this many ms: an uncaught error
   * in it stops it, and time would otherwise go on over a frozen game. Default 10,000.
   */
  stalledLoopMs?: number;
}

export interface RunUntilResult {
  /** Virtual now when the run ended. */
  now: number;
  /** Which condition stopped the run (its index in `stopWhen`, or "bitverse" for `onBitVerse: "stop"`), or null. */
  stoppedBy: number | "bitverse" | null;
}

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

/** Home's highs: each is its own, and they may come from different moments. */
export interface HomePeak {
  /** The highest RAM in use, in GB. */
  ramUsed: number;
  /** The most scripts running at once. */
  scripts: number;
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
  /** The current BitNode's multipliers (`currentNodeMults`), by name. */
  bitNodeMultipliers: Record<string, number>;
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

/** A V8 CPU profile (the `.cpuprofile` format): call-tree nodes, and which node each sample was in. */
export interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
  }[];
  startTime: number;
  endTime: number;
  samples: number[];
  /** Microseconds since the previous sample. */
  timeDeltas: number[];
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
  /** A script's static RAM in GB, from the game's own calculator; fails with the reason if there's none. */
  staticRamUsage(params: { host: string; path: string }): number;
  /** Starts a script as the terminal's `run` does: the game's own RAM check, pid and messages. */
  run(params: { host: string; script: string; threads: number; args: ScriptArg[] }): RunResult;
  /** Running scripts on a server, by pid. */
  ps(params: { host: string }): ProcessInfo[];
  /** A running or recently finished script's log lines. */
  logs(params: { pid: number }): string[];
  /** Kills a running script; false if there is none with that pid. */
  kill(params: { pid: number }): boolean;
  /**
   * Advances like `advance`, but checks `stopWhen` after every timer that fires, and stops right there when one holds.
   * Also handles arrivals at the BitVerse per `onBitVerse`.
   */
  runUntil(params: RunUntilParams): RunUntilResult;
  "diagnostics.clock"(params: Record<string, never>): ClockDiagnostics;
  "diagnostics.game"(params: Record<string, never>): GameDiagnostics;
  /**
   * The highest RAM home has had in use, and the most scripts it has run at once, since the game booted (each its own
   * high), taken as each changes: a script that starts and exits within one timer counts.
   */
  "diagnostics.homePeak"(params: Record<string, never>): HomePeak;
  "diagnostics.random"(params: { count: number }): RandomSample;
  /**
   * Navigates as game code does (`Router.toPage`): a simple page by its `Page` value, or "BitVerse" (only then is
   * `flume` used). Test-only: it changes game state (going to the BitVerse kills every script), and scenarios must not
   * use it.
   */
  "diagnostics.toPage"(params: { page: string; flume?: boolean }): void;
  /** `Router.back()`, as the UI's Back buttons call it. Test-only, like `diagnostics.toPage`. */
  "diagnostics.back"(params: Record<string, never>): void;
  /**
   * Destroys the current BitNode and enters BitNode `n`, as the BitVerse's portal does after a real destroy: the
   * current BitNode's Source-File goes up a level. Fails if the game goes into recovery mode. Test-only: it changes
   * game state; scenarios use `runUntil`'s `onBitVerse`.
   */
  "diagnostics.destroyBitNode"(params: { n: number }): void;
  /**
   * Sets home's RAM, in GB (a power of 2, 8 to 2^30), so test and benchmark scenarios can run big workloads at once. A
   * harness edit, not something a player can do.
   */
  "diagnostics.setHomeRam"(params: { gb: number }): void;
  /** Sets the player's money (finite, 0 or more), for test scenarios. A harness edit, not something a player can do. */
  "diagnostics.setMoney"(params: { money: number }): void;
  /**
   * Makes the player a member of `faction` (one of the game's names; joining bans its enemies) with this reputation
   * (finite, 0 or more), for test scenarios (#149). A harness edit, not something a player can do.
   */
  "diagnostics.joinFactionWithReputation"(params: { faction: string; reputation: number }): void;
  /**
   * Gives the player an augmentation (one of the game's names, not already installed), installed and unpaid, for test
   * scenarios (#151). A harness edit, not something a player can do.
   */
  "diagnostics.giveInstalledAugmentation"(params: { augmentation: string }): void;
  /**
   * Gives the player hacking experience (finite, 0 or more) through the game's own `gainHackingExp`, which sets the
   * skill from it, for test scenarios that need a server's required level (#162). A harness edit.
   */
  "diagnostics.gainHackingExp"(params: { exp: number }): void;
  /**
   * Queues an augmentation (one of the game's names, not owned already but for NeuroFlux Governor), unpaid and not yet
   * installed, for test scenarios (#164). A harness edit, not something a player can do.
   */
  "diagnostics.queueAugmentation"(params: { augmentation: string }): void;
  /** The game's own `getBitNodeMultipliers(n, level)`, for comparison. Test-only. */
  "diagnostics.bitNodeMultipliers"(params: { n: number; level: number }): Record<string, number>;
  /** The host's V8 heap in use, in bytes, after a full garbage collection. */
  "diagnostics.heap"(params: Record<string, never>): number;
  /** The host's V8 heap limit, in bytes: `maxHeapMb` plus room for the young generation, or Node's default. */
  "diagnostics.heapLimit"(params: Record<string, never>): number;
  /**
   * Starts or stops a CPU profile of the host (the game and everything it runs). Stopping returns the profile, in the
   * `.cpuprofile` format Chrome DevTools and Node use.
   */
  "diagnostics.profile"(params: { action: "start" | "stop" }): CpuProfile | null;
  /** Writes `message` to stderr and exits with `code`. */
  "diagnostics.crash"(params: { code: number; message: string }): never;
  /** Everything the page's sockets did since the last call, in order. */
  "network.take"(params: Record<string, never>): NetworkOutboxEntry[];
  /**
   * Sends a text frame to the page on a connection, delivered at the start of the next advance. False if the connection
   * is closing or closed (the frame is dropped); throws for a connection that never existed.
   */
  "network.send"(params: { connectionId: number; data: string }): boolean;
  /**
   * Closes a connection from the parent's side, delivered at the start of the next advance: a clean close if it's open,
   * a failed connection (as a refused handshake) if it hasn't opened yet. False if it's already closing or closed.
   */
  "network.close"(params: { connectionId: number; code: number; reason: string }): boolean;
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
  if (options.network !== undefined) validateNetwork(options.network);
  if (options.gameSettings !== undefined) validateGameSettings(options.gameSettings);
  const delay = options.testHooks?.importDelayMs;
  if (delay && !(Number.isInteger(delay[0]) && Number.isInteger(delay[1]) && 0 <= delay[0] && delay[0] <= delay[1])) {
    throw new RangeError(
      `testHooks.importDelayMs must be [min, max] integers with 0 <= min <= max, got ${JSON.stringify(delay)}`,
    );
  }
}

export function validateNetwork(network: NetworkOptions): void {
  const isSocketUrl = (url: unknown) => {
    if (typeof url !== "string" || !URL.canParse(url)) return false;
    return ["ws:", "wss:"].includes(new URL(url).protocol);
  };
  if (typeof network !== "object" || network === null || !Array.isArray(network.listenUrls)) {
    throw new RangeError("network needs listenUrls: a list of ws: or wss: URLs");
  }
  const bad = network.listenUrls.filter((url) => !isSocketUrl(url));
  if (bad.length > 0) throw new RangeError(`network.listenUrls must be ws: or wss: URLs, got ${JSON.stringify(bad)}`);
}

const isText = { expected: "text", isValid: (value: unknown) => typeof value === "string" };
const GAME_SETTING_CHECKS: Record<keyof GameSettingsOverride, { expected: string; isValid(value: unknown): boolean }> =
  {
    RemoteFileApiAddress: isText,
    RemoteFileApiPort: {
      expected: "a port number from 0 to 65535",
      isValid: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535,
    },
    RemoteFileApiReconnectionDelay: {
      expected: "a non-negative number of seconds",
      isValid: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    },
    AutoexecScript: isText,
  };

export function validateGameSettings(settings: GameSettingsOverride): void {
  if (typeof settings !== "object" || settings === null) throw new RangeError("gameSettings must be an object");
  for (const [name, value] of Object.entries(settings)) {
    if (!Object.hasOwn(GAME_SETTING_CHECKS, name)) {
      throw new RangeError(`gameSettings has no ${name}: one of ${Object.keys(GAME_SETTING_CHECKS).join(", ")}`);
    }
    const { expected, isValid } = GAME_SETTING_CHECKS[name as keyof GameSettingsOverride];
    if (!isValid(value)) throw new RangeError(`gameSettings.${name} must be ${expected}, got ${JSON.stringify(value)}`);
  }
}

export function validatePrompts(prompts: PromptRule[]): void {
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

/**
 * The game's BitNodes (BitNode/Constants.ts `validBitNodes`), and how far each Source-File goes: 3, except SF12, which
 * the game doesn't cap (RedPill.tsx `giveSourceFile`). Entering BitNode 12 applies NeuroFlux Governor once per SF12
 * level, so SF12 stops at a level that still boots in about a second. test/bitnode.test.ts checks these against the
 * game's source.
 */
export const BITNODES = 15;
export const MAX_SF_LEVEL = 3;
export const MAX_SF12_LEVEL = 1_000_000;
const maxSourceFileLevel = (n: number) => (n === 12 ? MAX_SF12_LEVEL : MAX_SF_LEVEL);

export function validateBitNodeFixture({ n, sourceFiles }: BitNodeFixture): void {
  const isBitNode = (value: number) => Number.isInteger(value) && value >= 1 && value <= BITNODES;
  if (!isBitNode(n)) throw new RangeError(`a BitNode fixture needs n in 1-${BITNODES}, got ${JSON.stringify(n)}`);
  if (typeof sourceFiles !== "object" || sourceFiles === null || Array.isArray(sourceFiles)) {
    throw new RangeError("a BitNode fixture needs sourceFiles: { [BitNode]: level }, e.g. {} or { 4: 3 }");
  }
  for (const [key, level] of Object.entries(sourceFiles)) {
    const bitNode = Number(key);
    // Only plain integer keys: "04", " 4" and "0x4" would all read as 4, and two of them would collide.
    if (!isBitNode(bitNode) || String(bitNode) !== key) {
      throw new RangeError(`no Source-File ${JSON.stringify(key)}: Source-Files are numbered 1-${BITNODES}`);
    }
    if (!Number.isInteger(level) || level < 1 || level > maxSourceFileLevel(bitNode)) {
      throw new RangeError(
        `Source-File ${key} level must be an integer from 1 to ${maxSourceFileLevel(bitNode)}, got ${JSON.stringify(level)}`,
      );
    }
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
    case "bitnode":
      validateBitNodeFixture(fixture);
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

/** Home RAM as the game has it: a power of 2 GB, from 8 to 2^30 (ServerPurchases.ts limits). */
export function validateHomeRam(gb: number): void {
  if (!Number.isInteger(gb) || gb < 8 || gb > 2 ** 30 || (gb & (gb - 1)) !== 0) {
    throw new RangeError(`home RAM must be a power of 2 GB from 8 to 2^30, got ${gb}`);
  }
}

export function validateAdvance(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new RangeError(`advance(ms) needs a non-negative integer number of milliseconds, got ${ms}`);
  }
}

const SUMMARY_FIELDS: Record<SummaryField, true> = {
  playtimeMs: true,
  bitNodeN: true,
  bitNodeLevel: true,
  money: true,
  hackingLevel: true,
  hackingExp: true,
  homeRamUsed: true,
  homeRamMax: true,
  scripts: true,
  augsInstalled: true,
  augsQueued: true,
};

/** Describes what's wrong with a stop condition, or returns null if it's valid. */
function stopConditionProblem(condition: StopCondition): string | null {
  if (typeof condition !== "object" || condition === null) return "a stop condition must be an object";
  const keys = Object.keys(condition);
  if (keys.length !== 1)
    return `a stop condition has exactly one of event, scriptExited, summary; got ${keys.join(", ")}`;
  if ("event" in condition) {
    return STOP_EVENTS.includes(condition.event) ? null : `stop on event: one of ${STOP_EVENTS.join(", ")}`;
  }
  if ("scriptExited" in condition) {
    return typeof condition.scriptExited === "string" && condition.scriptExited !== ""
      ? null
      : "scriptExited: a filename";
  }
  if ("summary" in condition) {
    const { field, op, value } = condition.summary ?? {};
    if (!Object.hasOwn(SUMMARY_FIELDS, field)) return `summary field: one of ${Object.keys(SUMMARY_FIELDS).join(", ")}`;
    if (!COMPARISON_OPS.includes(op as ComparisonOp)) return `summary op: one of ${COMPARISON_OPS.join(" ")}`;
    return typeof value === "number" && !Number.isNaN(value) ? null : "summary value: a number";
  }
  return `unknown stop condition ${JSON.stringify(condition)}`;
}

export function validateRunUntil({ ms, stopWhen = [], onBitVerse, eventsFrom, stalledLoopMs }: RunUntilParams): void {
  validateAdvance(ms);
  if (eventsFrom !== undefined && !(Number.isSafeInteger(eventsFrom) && eventsFrom >= 0)) {
    throw new RangeError(`eventsFrom must be a log position (a non-negative integer), got ${eventsFrom}`);
  }
  if (stalledLoopMs !== undefined && !(Number.isSafeInteger(stalledLoopMs) && stalledLoopMs > 0)) {
    throw new RangeError(`stalledLoopMs must be a positive integer, got ${stalledLoopMs}`);
  }
  if (!Array.isArray(stopWhen)) throw new RangeError("stopWhen must be a list of stop conditions");
  for (const condition of stopWhen) {
    const problem = stopConditionProblem(condition);
    if (problem) throw new RangeError(`bad stop condition ${JSON.stringify(condition)}: ${problem}`);
  }
  if (onBitVerse !== undefined && onBitVerse !== "stop") {
    const n = (onBitVerse as { enter?: unknown }).enter;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > BITNODES) {
      throw new RangeError(`onBitVerse must be "stop" or { enter: 1-${BITNODES} }, got ${JSON.stringify(onBitVerse)}`);
    }
  }
}

/** One wording for how a process ended, used by every error that reports it. */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `was killed by ${signal}` : `exited with code ${code}`;
}
