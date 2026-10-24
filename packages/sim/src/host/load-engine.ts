import { createRequire } from "node:module";
import { assertEngineApi, type EngineApi } from "../engine/api.ts";
import { enginePaths } from "../engine/paths.ts";

/** Loads dist/engine.cjs. The browser environment (installDom) must already be installed. */
export function loadEngine(): EngineApi {
  const exports: unknown = createRequire(import.meta.url)(enginePaths.bundle);
  assertEngineApi(exports);
  return exports;
}
