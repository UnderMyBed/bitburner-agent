import type { GameSummary } from "../protocol.ts";

/**
 * The typed boundary between our code and the engine bundle. `bundle/entry.ts` (bundled together with the game, and
 * not typechecked by us) must export exactly these functions; `assertEngineApi` checks that at runtime.
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
  bootNewGame(tutorial: "running" | "skipped"): Promise<void>;
  /** The game-side fields of a summary (the host adds `virtualMs`). */
  gameSummary(): Omit<GameSummary, "virtualMs">;
  /** The game's own save, as JSON text. */
  saveJson(): Promise<string>;
  tutorialRunning(): boolean;
}

const API_FUNCTIONS = {
  versionNumber: true,
  gameCommit: true,
  engineLastUpdate: true,
  dateNow: true,
  performanceNow: true,
  bootNewGame: true,
  gameSummary: true,
  saveJson: true,
  tutorialRunning: true,
} satisfies Record<keyof EngineApi, true>;

export function assertEngineApi(exports: unknown): asserts exports is EngineApi {
  if (typeof exports !== "object" || exports === null) throw new Error("engine bundle exports nothing");
  const missing = Object.keys(API_FUNCTIONS).filter(
    (name) => typeof (exports as Record<string, unknown>)[name] !== "function",
  );
  if (missing.length > 0) throw new Error(`engine bundle is missing EngineApi functions: ${missing.join(", ")}`);
}
