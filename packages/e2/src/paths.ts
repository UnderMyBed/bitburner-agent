// Where E2 keeps what it builds and downloads: all under the repository's gitignored `.cache/e2/`, so deleting that
// folder undoes everything `e2:build` and `e2:install` did.
import { execFileSync } from "node:child_process";
import path from "node:path";

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
/** The pinned game's source: the submodule. */
export const GAME_ROOT = path.join(REPOSITORY_ROOT, "vendor/bitburner-src");
export const E2_CACHE = path.join(REPOSITORY_ROOT, ".cache/e2");
/** Playwright's browsers, kept here rather than in the user's profile. */
export const BROWSERS_DIRECTORY = path.join(E2_CACHE, "browsers");

/** The commit the submodule has checked out, in full. */
export function gameCommit(): string {
  return execFileSync("git", ["-C", GAME_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Where the game built from `commit` lives: `index.html` here, the bundles in `dist/`. */
export function buildDirectory(commit: string): string {
  return path.join(E2_CACHE, commit);
}
