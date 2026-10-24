/**
 * The game build the agent is built and tested against: the commit Steam ships, pinned as the
 * `vendor/bitburner-src` submodule (ADR 0003). A contract test keeps this in sync with the submodule.
 */
export const PINNED_GAME = {
  versionString: "3.0.1",
  versionNumber: 51,
  commit: "1da7316ff",
} as const;
