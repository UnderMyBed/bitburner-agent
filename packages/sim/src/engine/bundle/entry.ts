// Bundled together with the game's source into dist/engine.cjs. Not typechecked by the repo's tsc: it imports the
// game, which builds under its own TypeScript setup. Keep it minimal; its exports must match EngineApi (../api.ts).
import { CONSTANTS } from "../../../../../vendor/bitburner-src/src/Constants";
import { commitHash } from "../../../../../vendor/bitburner-src/src/utils/helpers/commitHash";
// The engine module pulls in the whole game (and its UI dependencies), so loading the bundle exercises the full
// module mapping and the browser environment, as booting will.
import "../../../../../vendor/bitburner-src/src/engine";

export function versionNumber(): number {
  return CONSTANTS.VersionNumber;
}

export function gameCommit(): string {
  return commitHash();
}
