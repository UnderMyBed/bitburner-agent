// Bundled together with the game's source into dist/engine.cjs. Not typechecked by the repo's tsc: it imports the
// game, which builds under its own TypeScript setup. Keep it minimal; its exports must match EngineApi (../api.ts).
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
// The engine module pulls in the whole game (and its UI dependencies), so loading the bundle exercises the full
// module mapping and the browser environment, as booting will.
import { Engine } from "../../../../../vendor/bitburner-src/src/engine";
import { commitHash } from "../../../../../vendor/bitburner-src/src/utils/helpers/commitHash";

export function versionNumber(): number {
  return CONSTANTS.VersionNumber;
}

export function gameCommit(): string {
  return commitHash();
}

export function engineLastUpdate(): number {
  return Engine._lastUpdate;
}

export function dateNow(): number {
  return Date.now();
}

export function performanceNow(): number {
  return performance.now();
}
