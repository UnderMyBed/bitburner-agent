// The legacy fork's scripts, vendored in fork/ (PROVENANCE.md): the baseline the agent is measured against (#33), and
// later the legacy reflexes that run under the agent (architecture §12.3). fork/ is never edited in place.
import { readFileSync } from "node:fs";
import path from "node:path";

export const FORK_DIR = path.resolve(import.meta.dirname, "../fork");
const MANIFEST = path.resolve(import.meta.dirname, "../manifest.json");

/** manifest.json: where fork/ came from, and the sha256 of every file in it. The one record of both. */
export interface ForkManifest {
  /** The source repository. */
  source: string;
  /** The commit the files were copied from. */
  commit: string;
  /** The git tree id of that commit's tree, which `git rev-parse HEAD:packages/legacy/fork` must match here. */
  tree: string;
  /** Path in the fork's tree → sha256 of its bytes. */
  files: Record<string, string>;
}

export function forkManifest(): ForkManifest {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as ForkManifest;
}

/** Where the vendored files came from (from the manifest). */
export const FORK = (() => {
  const { source, commit, tree } = forkManifest();
  return { repository: source, commit, tree };
})();

export interface ForkFile {
  /** Path in the fork's tree, with forward slashes (as the game's paths are). */
  path: string;
  /** The file as text. The fork is all UTF-8 (no BOM); some files keep CRLF line endings. */
  content: string;
}

/** Every vendored file, in path order, as text. */
export function forkFiles(): ForkFile[] {
  return Object.keys(forkManifest().files)
    .sort()
    .map((file) => ({ path: file, content: readFileSync(path.join(FORK_DIR, file), "utf8") }));
}

/** The files a game needs: the scripts (`.js`) and the text files they read (`.txt`, e.g. reserve.txt). */
export function gameFiles(): ForkFile[] {
  return forkFiles().filter((file) => file.path.endsWith(".js") || file.path.endsWith(".txt"));
}

export { baselineScenario, DAY } from "./baseline.ts";
export { baselineRow, dailyHeapMb, formatHeaps, type RowMeta, seedHeapGrowth } from "./report.ts";
