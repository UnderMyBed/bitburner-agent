/**
 * The typed boundary between our code and the engine bundle. `entry.ts` (bundled together with the game, and not
 * typechecked by us) must export exactly these functions; `assertEngineApi` checks that at runtime.
 */
export interface EngineApi {
  /** The game's own `CONSTANTS.VersionNumber`. */
  versionNumber(): number;
  /** The game's own `commitHash()`: the short commit the build was made from, as webpack injects it. */
  gameCommit(): string;
  /** `Engine._lastUpdate`: read from Date when the engine module loads. */
  engineLastUpdate(): number;
  /** `Date.now()` and `performance.now()` as seen from inside the bundle. */
  dateNow(): number;
  performanceNow(): number;
}

const API_FUNCTIONS = {
  versionNumber: true,
  gameCommit: true,
  engineLastUpdate: true,
  dateNow: true,
  performanceNow: true,
} satisfies Record<keyof EngineApi, true>;

export function assertEngineApi(exports: unknown): asserts exports is EngineApi {
  if (typeof exports !== "object" || exports === null) throw new Error("engine bundle exports nothing");
  const missing = Object.keys(API_FUNCTIONS).filter(
    (name) => typeof (exports as Record<string, unknown>)[name] !== "function",
  );
  if (missing.length > 0) throw new Error(`engine bundle is missing EngineApi functions: ${missing.join(", ")}`);
}
