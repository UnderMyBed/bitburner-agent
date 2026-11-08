// The Node major the simulator's recorded results hold for (#282): the repo's .node-version, which CI's setup-node and
// the repo's mise.toml both follow. A seeded run is deterministic on one Node, not across majors: V8's
// Array.prototype.sort calls the comparator a different number of times on short arrays (3 to 7 elements) in V8 13.6
// (Node 24) than in 14.6 (Node 26), so a script sorting with a random comparator, as the legacy fork's go.js does
// (`sort(() => Math.random() - Math.random())`, packages/legacy/fork/go.js:1352-1353), draws Math.random a different
// number of times and the whole seeded game diverges. The baseline, benchmark and scenario scripts refuse any other
// major, so a row is never recorded on a Node it can't be compared with. The pin is Node 26 (it was 24 until
// 2026-11-07): Steam's Electron 41.4.0 is Chromium 146, whose V8 should be 14.6, Node 26's (inferred, parity 4.17).
import { readFileSync } from "node:fs";
import path from "node:path";

/** The repository root: .node-version is there. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** The major in a .node-version text: "26", "v26", "26.13.0" and "v26.13.0" are all 26. */
export function parseNodeMajor(text: string): number {
  const match = /^v?(\d+)(?:\.\d+){0,2}$/.exec(text.trim());
  if (!match) throw new Error(`.node-version: expected a Node version such as 26 or 26.13.0, got "${text.trim()}"`);
  return Number(match[1]);
}

/** The repo's pinned Node major, from its .node-version. */
export function pinnedNodeMajor(repoRoot = REPO_ROOT): number {
  return parseNodeMajor(readFileSync(path.join(repoRoot, ".node-version"), "utf8"));
}

/** Why this Node can't run the simulator's recorded scripts, or null if it's the pinned major. */
export function nodeVersionError(pinnedMajor: number, version: string = process.versions.node): string | null {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (major === pinnedMajor) return null;
  return (
    `Node ${version.replace(/^v?/, "v")} isn't the repo's Node ${pinnedMajor} (.node-version). Seeded simulations ` +
    `differ between Node majors (#282), so baseline, benchmark and scenario results are only recorded on Node ` +
    `${pinnedMajor}. With mise, run from the repo: its mise.toml selects Node ${pinnedMajor} (docs/setup.md).`
  );
}

/** Throws unless this is the repo's pinned Node major: the first thing the sim, baseline and bench scripts do. */
export function checkNodeVersion(repoRoot = REPO_ROOT, version: string = process.versions.node): void {
  const error = nodeVersionError(pinnedNodeMajor(repoRoot), version);
  if (error) throw new Error(error);
}
