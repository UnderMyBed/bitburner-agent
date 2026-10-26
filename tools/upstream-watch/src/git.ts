// The git reads the report needs, from a clone of the game's repository (blobless is enough).
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ContractTypecheck } from "./contract-typecheck.ts";
import { diffDeclarations, extractDeclarations } from "./declarations.ts";
import { diffRamCosts, extractRamCosts } from "./ram-costs.ts";
import { DEFINITIONS, RAM_COSTS, type WatchReport } from "./report.ts";

const CONSTANTS = "src/Constants.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 2 ** 20 });
}

/** The commit `vendor/bitburner-src` is pinned to in this repository's HEAD. */
export function pinnedCommit(repoRoot: string): string {
  const entry = git(repoRoot, "ls-tree", "HEAD", "vendor/bitburner-src").trim();
  const sha = /^160000 commit ([0-9a-f]{40})\t/.exec(entry)?.[1];
  if (!sha) throw new Error(`vendor/bitburner-src isn't a submodule in ${repoRoot}'s HEAD: "${entry}"`);
  return sha;
}

/** The game's version string at a commit, e.g. "3.0.1". */
function versionAt(game: string, rev: string): string {
  const constants = git(game, "show", `${rev}:${CONSTANTS}`);
  return /VersionString:\s*"([^"]+)"/.exec(constants)?.[1] ?? "unknown";
}

/** Whether `descendant` is `ancestor` or comes after it in history. */
function isAncestor(game: string, ancestor: string, descendant: string): boolean {
  try {
    git(game, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    // Exit 1 means "not an ancestor"; anything else is a real failure.
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/**
 * Everything the report says about `ref` against the pinned commit, read from the game clone at `game`.
 * `typecheck` runs the contract typecheck against the ref's definitions (contract-typecheck.ts).
 */
export function buildReport(
  game: string,
  pinned: string,
  ref: string,
  watchlist: string[],
  typecheck: (upstreamDefinitions: string) => ContractTypecheck,
): WatchReport {
  const sha = git(game, "rev-parse", `${ref}^{commit}`).trim();
  const show = (rev: string, file: string) => git(game, "show", `${rev}:${file}`);
  const log = git(game, "log", "--format=%H%x09%s", `${pinned}..${sha}`, "--", ...watchlist).trim();
  const upstreamDefinitions = show(sha, DEFINITIONS);
  return {
    pinned: { sha: pinned, version: versionAt(game, pinned) },
    upstream: {
      ref: path.posix.basename(ref),
      sha,
      version: versionAt(game, sha),
      date: git(game, "log", "-1", "--format=%cs", sha).trim(),
      ahead: sha !== pinned && isAncestor(game, pinned, sha),
    },
    api: diffDeclarations(extractDeclarations(show(pinned, DEFINITIONS)), extractDeclarations(upstreamDefinitions)),
    rawApiDiff: git(game, "diff", pinned, sha, "--", DEFINITIONS),
    ram: diffRamCosts(extractRamCosts(show(pinned, RAM_COSTS)), extractRamCosts(show(sha, RAM_COSTS))),
    commits:
      log === ""
        ? []
        : log.split("\n").map((line) => {
            const [commit, ...title] = line.split("\t");
            return { sha: commit as string, title: title.join("\t") };
          }),
    typecheck: typecheck(upstreamDefinitions),
  };
}
