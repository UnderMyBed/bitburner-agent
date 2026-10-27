import type { GameInfo } from "./control-protocol.ts";

/**
 * The game release the agent is built and tested against, pinned as the `vendor/bitburner-src` submodule (ADR 0003). A
 * contract test keeps this in sync with the submodule. `commit` is the submodule's, upstream `stable`'s. Steam's build
 * reports the release tag's commit instead, which has the same source. The simulator's build and the contract test use
 * it; drift checks don't.
 */
export const PINNED_GAME = {
  versionString: "3.0.1",
  versionNumber: 51,
  commit: "1da7316ff",
} as const;

/**
 * How the game an Agent reports (`ns.ui.getGameInfo()`) differs from the pinned release, or null if it doesn't. The
 * release is its version number and version string. The commit isn't compared (owner decision 31, #128): upstream's
 * v3.0.1 tag is a different commit from `stable`'s, and Steam's v3.0.1 reports the tag's (`3162fd2`), not the pinned
 * `stable` one, though both are the same source. The deployer's definitions-file check covers the API.
 */
export function gameDrift(game: GameInfo): string | null {
  const differences: string[] = [];
  if (game.versionNumber !== PINNED_GAME.versionNumber) {
    differences.push(`versionNumber ${game.versionNumber}, pinned ${PINNED_GAME.versionNumber}`);
  }
  if (game.version !== PINNED_GAME.versionString) {
    differences.push(`version ${game.version}, pinned ${PINNED_GAME.versionString}`);
  }
  return differences.length === 0 ? null : differences.join("; ");
}
