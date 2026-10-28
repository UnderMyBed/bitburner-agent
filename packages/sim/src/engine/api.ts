import type {
  GameDiagnostics,
  GameEvent,
  GameSettingsOverride,
  GameSummary,
  HomePeak,
  ProcessInfo,
  PromptRequest,
  RunResult,
  ScriptArg,
  Tutorial,
} from "../protocol.ts";

/**
 * The typed boundary between our code and the engine bundle. `bundle/entry.ts` (bundled together with the game, and
 * typechecked against the game's types by `npm run typecheck`) must export exactly these functions: the typecheck
 * checks their types, and `assertEngineApi` checks at runtime that nothing is missing or extra.
 */
export interface EngineApi {
  /** The game's own `CONSTANTS.VersionNumber`. */
  versionNumber(): number;
  /** The game's own `commitHash()`: the short commit the build was made from, as webpack injects it. */
  gameCommit(): string;
  /** `Engine._lastUpdate`: read from Date when the engine module loads. */
  engineLastUpdate(): number;
  /**
   * `Date.now()` and `performance.now()` as seen from inside the bundle. It shares the host's globals today; these
   * guard against the bundle ever capturing its own (real) Date or performance.
   */
  dateNow(): number;
  performanceNow(): number;
  /** Boots a new game through the game's own `Engine.load`, then does what the UI does once mounted. */
  bootNewGame(tutorial: Tutorial): Promise<void>;
  /** Loads a save through the game's own `Engine.load` (stored in IndexedDB first, as the browser would have it). */
  bootSave(saveData: string | Uint8Array): Promise<void>;
  /**
   * A new game, then BitNode `n` entered with `sourceFiles` (BitNode → level) through the game's own `enterBitNode`,
   * as b1t_flum3.exe does. Leaves BitNode 6's cinematic as its Continue button does. Throws if the game goes into
   * recovery mode.
   */
  bootBitNode(n: number, sourceFiles: Record<string, number>): Promise<void>;
  /**
   * What the BitVerse portal does after a real destroy: the current BitNode's Source-File goes up a level, then BitNode
   * `n` starts. Throws if the game goes into recovery mode. Test-only.
   */
  destroyBitNode(n: number): void;
  /**
   * The BitVerse portal's choice of BitNode `n`: enters it (destroying the current BitNode unless the BitVerse was
   * reached by flume), then leaves BitNode 6's cinematic. Throws if the game isn't at the BitVerse.
   */
  enterFromBitVerse(n: number): void;
  /**
   * The BitNode entry since the last call, if any: from which BitNode to which, and whether by destroying it. The first
   * call takes a baseline. Call after every timer and every request.
   */
  bitNodeEntry(): { from: number; to: number; destroyed: boolean } | null;
  /** Whether a script with this filename is running (on any server), has recently finished, or neither. */
  scriptState(filename: string): "running" | "finished" | "unknown";
  /** Sets home's RAM, in GB. A harness edit, for test and benchmark scenarios. */
  setHomeRam(gb: number): void;
  /** Sets the player's money. A harness edit, for test scenarios. */
  setMoney(money: number): void;
  /** Makes the player a member of `faction` with this reputation. A harness edit, for test scenarios (#149). */
  joinFactionWithReputation(faction: string, reputation: number): void;
  /** The page the game's Router is on. */
  page(): string;
  /** The game's own `getBitNodeMultipliers(n, level)`, for comparison. Test-only. */
  bitNodeMultipliers(n: number, level: number): Record<string, number>;
  /** The game's own save: gzip bytes. */
  saveBytes(): Promise<Uint8Array>;
  /** The game-side fields of a summary (the host adds `virtualMs`). */
  gameSummary(): Omit<GameSummary, "virtualMs">;
  /** The game's own save, as JSON text. */
  saveJson(): Promise<string>;
  /**
   * The highest RAM home has had in use, and the most scripts it has run at once, since the game booted (each its own
   * high), taken as each changes: a script that starts and exits within one timer counts.
   */
  homePeak(): HomePeak;
  /** The game-side fields of the game diagnostics (the host adds `bootMs`). */
  gameDiagnostics(): Omit<GameDiagnostics, "bootMs" | "defaultLocale" | "pinnedLocale">;
  /**
   * What the browser page gives the game besides the Router: the globals index.tsx and libraries put on `window`,
   * mirrored onto the global object (`bundle/page.ts`). Call once, right after loading the engine.
   */
  installPageGlobals(): void;
  /**
   * Who hears what the UI would have shown (popups, toasts, the error popup; `bundle/page.ts`) and every arrival at
   * the BitVerse page (`bundle/router.ts`, which booting mounts as GameRoot does on its first render). Call before
   * booting.
   */
  setGameEventListener(listener: (event: GameEvent) => void): void;
  /**
   * Who answers `ns.prompt`, in the player's place: an answer, or `undefined` to leave the prompt open, as for a player
   * who isn't there. Call before booting.
   */
  setPromptAnswerer(answer: (prompt: PromptRequest) => string | boolean | undefined): void;
  /** The router's page history, newest first: runtime state the save doesn't hold, so the state hash adds it. */
  routerPages(): string[];
  /** Navigates as game code does (`Router.toPage`): a simple page, or the BitVerse. Test-only. */
  toPage(page: string, flume: boolean): void;
  /** `Router.back()`. Test-only. */
  routerBack(): void;
  /** Sets the game's hook for importing player-script modules. */
  setScriptImport(doImport: (url: string) => Promise<unknown>): void;
  /**
   * What the page script does when it loads (index.tsx:37): in 2 s, the game's Remote File API client connects with
   * the settings then (port 0, the default, means it doesn't). Call once, right after loading the engine.
   */
  startRemoteFileApi(): void;
  /** Sets game settings, as a player would in the options pages. A harness edit. */
  applyGameSettings(settings: GameSettingsOverride): void;
  writeFile(host: string, path: string, content: string): void;
  /**
   * A script's static RAM in GB, from the game's own calculator (`Script.getRamUsage`, the call `run` makes). Throws
   * with the reason when the file is missing, isn't a script, or can't be parsed.
   */
  staticRamUsage(host: string, path: string): number;
  /** As the terminal's `run`: the game's own RAM check, pid and failure message. */
  runScript(host: string, path: string, threads: number, args: ScriptArg[]): RunResult;
  ps(host: string): ProcessInfo[];
  scriptLogs(pid: number): string[];
  killScript(pid: number): boolean;
}

const API_FUNCTIONS = {
  versionNumber: true,
  gameCommit: true,
  engineLastUpdate: true,
  dateNow: true,
  performanceNow: true,
  bootNewGame: true,
  bootSave: true,
  bootBitNode: true,
  destroyBitNode: true,
  enterFromBitVerse: true,
  bitNodeEntry: true,
  scriptState: true,
  page: true,
  setHomeRam: true,
  setMoney: true,
  joinFactionWithReputation: true,
  bitNodeMultipliers: true,
  saveBytes: true,
  gameSummary: true,
  saveJson: true,
  homePeak: true,
  gameDiagnostics: true,
  installPageGlobals: true,
  setGameEventListener: true,
  setPromptAnswerer: true,
  routerPages: true,
  toPage: true,
  routerBack: true,
  setScriptImport: true,
  startRemoteFileApi: true,
  applyGameSettings: true,
  writeFile: true,
  staticRamUsage: true,
  runScript: true,
  ps: true,
  scriptLogs: true,
  killScript: true,
} satisfies Record<keyof EngineApi, true>;

export function assertEngineApi(exports: unknown): asserts exports is EngineApi {
  if (typeof exports !== "object" || exports === null) throw new Error("engine bundle exports nothing");
  const missing = Object.keys(API_FUNCTIONS).filter(
    (name) => typeof (exports as Record<string, unknown>)[name] !== "function",
  );
  if (missing.length > 0) throw new Error(`engine bundle is missing EngineApi functions: ${missing.join(", ")}`);
}
