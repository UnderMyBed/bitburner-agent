// The legacy fork's scripts, as vendored in fork/ (PROVENANCE.md): for the baseline scenario (#33), and later as
// reference behaviour. Never edited in place.
import { readFileSync } from "node:fs";
import path from "node:path";

/** Where the vendored files came from (PROVENANCE.md). */
export const FORK = {
  repository: "https://github.com/UnderMyBed/bitburner-scripts",
  commit: "2705617f3908340ff8cb18fab38962e8caf6af84",
} as const;

export const FORK_DIR = path.resolve(import.meta.dirname, "../fork");
const MANIFEST = path.resolve(import.meta.dirname, "../manifest.json");

export interface ForkFile {
  /** Path in the fork's tree, with forward slashes (as the game's paths are). */
  path: string;
  content: string;
}

/** The manifest: every vendored file's sha256, by path. */
export function forkManifest(): { source: string; commit: string; files: Record<string, string> } {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

/** Every vendored file, in path order, as text (the fork is all text). */
export function forkFiles(): ForkFile[] {
  return Object.keys(forkManifest().files)
    .sort()
    .map((file) => ({ path: file, content: readFileSync(path.join(FORK_DIR, file), "utf8") }));
}
