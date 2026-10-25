// The watchlist: game source paths whose commits the report lists, and the game files our mechanics docs cite.
import { readFileSync } from "node:fs";

/** Paths from the watchlist file: one per line, `#` comments and blank lines skipped. */
export function readWatchlist(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line !== "");
}

/** Whether `file` is on the watchlist, itself or under a watched directory (one ending in `/`). */
export function covers(watchlist: string[], file: string): boolean {
  return watchlist.some((watched) => watched === file || (watched.endsWith("/") && file.startsWith(watched)));
}

/**
 * The game files a Markdown doc cites, in order of first citation. Docs cite `src/Hacking.ts:12`,
 * `NetscriptFunctions/Gang.ts:20` or just `engine.tsx:106`; each is matched against the game's files (`gameFiles`, paths
 * from the repository root) by its trailing path. A name that could be several files, like a bare `Gang.ts`, is
 * skipped: such short forms follow a full citation of the same file.
 */
export function citedGameFiles(markdown: string, gameFiles: string[]): string[] {
  const cited = new Set<string>();
  for (const [token] of markdown.matchAll(/[\w./-]+\.tsx?\b/g)) {
    const tail = token.replace(/^(?:\.\/|vendor\/bitburner-src\/)/, "");
    const matches = gameFiles.filter((file) => file === tail || file.endsWith(`/${tail}`));
    if (matches.length === 1) cited.add(matches[0] as string);
  }
  return [...cited];
}
