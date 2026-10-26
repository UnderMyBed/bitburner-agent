import type { GameInfo } from "./control-protocol.ts";

/**
 * The game build the agent is built and tested against: the commit Steam ships, pinned as the
 * `vendor/bitburner-src` submodule (ADR 0003). A contract test keeps this in sync with the submodule.
 */
export const PINNED_GAME = {
  versionString: "3.0.1",
  versionNumber: 51,
  commit: "1da7316ff",
} as const;

/** Git's shortest abbreviation: a shorter commit can't be told apart. */
const SHORTEST_COMMIT_LENGTH = 7;

/**
 * How the game an Agent reports (`ns.ui.getGameInfo()`) differs from the pinned one, or null if it doesn't. Commits are
 * compared on their common prefix: the game reports `git rev-parse --short` of its build, whose length depends on the
 * clone it was built in.
 */
export function gameDrift(game: GameInfo): string | null {
  if (game.versionNumber !== PINNED_GAME.versionNumber) {
    return `versionNumber ${game.versionNumber}, pinned ${PINNED_GAME.versionNumber}`;
  }
  const sameCommit =
    game.commit.length >= SHORTEST_COMMIT_LENGTH &&
    (game.commit.startsWith(PINNED_GAME.commit) || PINNED_GAME.commit.startsWith(game.commit));
  return sameCommit ? null : `commit ${game.commit}, pinned ${PINNED_GAME.commit}`;
}
