// Where E2 keeps what it builds and downloads: under the repository's gitignored `.cache/e2/`, so deleting that folder
// undoes what `e2:build` and `e2:install` did, apart from babel's cache, which the game's webpack config keeps in the
// submodule's gitignored `node_modules/.cache/`.
import { execFileSync } from "node:child_process";
import path from "node:path";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
/** The pinned game's source: the submodule. */
export const GAME_ROOT = path.join(REPOSITORY_ROOT, "vendor/bitburner-src");
const E2_CACHE = path.join(REPOSITORY_ROOT, ".cache/e2");
/** Playwright's browsers, kept here rather than in the user's profile. */
export const BROWSERS_DIRECTORY = path.join(E2_CACHE, "browsers");

/**
 * The commit this repository pins the game at (its gitlink for the submodule), in full. Fails if the submodule has
 * another commit checked out: E2 builds and tests the pinned game, nothing else.
 */
export function gameCommit(): string {
  const gitlink = execFileSync("git", ["-C", REPOSITORY_ROOT, "ls-tree", "HEAD", "vendor/bitburner-src"], {
    encoding: "utf8",
  });
  const pinned = /^160000 commit ([0-9a-f]{40})\t/.exec(gitlink)?.[1];
  const checkedOut = execFileSync("git", ["-C", GAME_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (pinned !== checkedOut) {
    throw new Error(
      `The submodule has ${checkedOut} checked out, not the pinned ${pinned}: run git submodule update --init.`,
    );
  }
  return checkedOut;
}

/** Where the game built from `commit` lives: `index.html` here, the bundles in `dist/`. */
export function buildDirectory(commit: string): string {
  return path.join(E2_CACHE, commit);
}
