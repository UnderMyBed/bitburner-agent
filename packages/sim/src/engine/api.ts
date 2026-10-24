/**
 * The typed boundary between our code and the engine bundle. `entry.ts` (bundled together with the game, and not
 * typechecked by us) must export exactly these functions; `assertEngineApi` checks that at runtime.
 */
export interface EngineApi {
  /** The game's own `CONSTANTS.VersionNumber`. */
  versionNumber(): number;
}

const API_FUNCTIONS = { versionNumber: true } satisfies Record<keyof EngineApi, true>;

export function assertEngineApi(exports: unknown): asserts exports is EngineApi {
  if (typeof exports !== "object" || exports === null) throw new Error("engine bundle exports nothing");
  const missing = Object.keys(API_FUNCTIONS).filter(
    (name) => typeof (exports as Record<string, unknown>)[name] !== "function",
  );
  if (missing.length > 0) throw new Error(`engine bundle is missing EngineApi functions: ${missing.join(", ")}`);
}
