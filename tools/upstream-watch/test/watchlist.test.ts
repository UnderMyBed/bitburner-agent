import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { citedGameFiles, covers, readWatchlist } from "../src/watchlist.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GAME = path.join(REPO_ROOT, "vendor/bitburner-src");
const MECHANICS = path.join(REPO_ROOT, "docs/mechanics");

describe("covers", () => {
  test("a path is covered by itself or by a directory above it", () => {
    const watchlist = ["src/Gang/", "src/Constants.ts"];
    expect(covers(watchlist, "src/Gang/Gang.ts")).toBe(true);
    expect(covers(watchlist, "src/Constants.ts")).toBe(true);
    expect(covers(watchlist, "src/GangX/a.ts")).toBe(false);
    expect(covers(watchlist, "src/Bladeburner/Constants.ts")).toBe(false);
    // A file entry covers only that file, even where it's a prefix of another path.
    expect(covers(["src/Gang"], "src/GangX/a.ts")).toBe(false);
  });
});

describe("citedGameFiles", () => {
  const files = ["src/Gang/Gang.ts", "src/NetscriptFunctions/Gang.ts", "src/engine.tsx", "src/Hacking.ts"];

  test("resolves full, relative and bare citations to game files, skipping names that could be several", () => {
    const markdown =
      "See `src/Hacking.ts:12`, `NetscriptFunctions/Gang.ts:20-23` and `engine.tsx:106`; `Gang.ts:180` is ambiguous, and `Nope.ts` isn't the game's.";
    expect(citedGameFiles(markdown, files)).toEqual([
      "src/Hacking.ts",
      "src/NetscriptFunctions/Gang.ts",
      "src/engine.tsx",
    ]);
  });
});

describe("watchlist.txt", () => {
  const watchlist = readWatchlist(path.join(REPO_ROOT, "tools/upstream-watch/watchlist.txt"));

  test("every path exists in the pinned game", () => {
    expect(watchlist.length).toBeGreaterThan(50);
    expect(watchlist.filter((p) => !existsSync(path.join(GAME, p)))).toEqual([]);
  });

  test("covers every game file the mechanics docs cite", () => {
    const files = execFileSync("git", ["-C", GAME, "ls-files", "src"], { encoding: "utf8" }).trim().split("\n");
    const uncovered = readdirSync(MECHANICS)
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => citedGameFiles(readFileSync(path.join(MECHANICS, name), "utf8"), files))
      .filter((file) => !covers(watchlist, file));
    expect([...new Set(uncovered)]).toEqual([]);
  });
});
