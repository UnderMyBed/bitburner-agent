import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  findConfigPaths,
  findUncoveredFiles,
  listRepositoryFiles,
  TYPESCRIPT_SOURCE_PATHSPECS,
} from "../src/typecheck.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("findUncoveredFiles", () => {
  test("lists source files no config includes, apart from the exempt paths", () => {
    const sourceFiles = [
      "packages/core/src/index.ts",
      "packages/core/src/forgotten.ts",
      "packages/sim/src/engine/bundle/entry.ts",
      "spikes/s1-headless-engine/engine-entry.ts",
      "tools/new-tool/main.mts",
    ];
    const coveredFiles = new Set(["packages/core/src/index.ts"]);
    expect(findUncoveredFiles(sourceFiles, coveredFiles)).toEqual([
      "packages/core/src/forgotten.ts",
      "tools/new-tool/main.mts",
    ]);
  });

  test("an exempt prefix only matches from the repository root", () => {
    expect(findUncoveredFiles(["packages/x/spikes/a.ts"], new Set())).toEqual(["packages/x/spikes/a.ts"]);
  });
});

describe("listRepositoryFiles", () => {
  const scratchRepository = mkdtempSync(path.join(os.tmpdir(), "typecheck-list-"));
  afterAll(() => rmSync(scratchRepository, { recursive: true, force: true }));

  test("returns unusual names unquoted, untracked files included, and leaves out ignored, deleted and declaration files", () => {
    execFileSync("git", ["init", "-q"], { cwd: scratchRepository });
    mkdirSync(path.join(scratchRepository, "src"));
    for (const file of ["src/ünï.ts", "src/plain.mts", "src/types.d.ts", "src/ignored.ts", "src/notes.md"]) {
      writeFileSync(path.join(scratchRepository, file), "export {};\n");
    }
    writeFileSync(path.join(scratchRepository, ".gitignore"), "src/ignored.ts\n");
    // Tracked, then deleted from the working tree: still in git's index, but nothing to typecheck.
    writeFileSync(path.join(scratchRepository, "src/deleted.ts"), "export {};\n");
    execFileSync("git", ["add", "src/deleted.ts"], { cwd: scratchRepository });
    rmSync(path.join(scratchRepository, "src/deleted.ts"));
    expect(listRepositoryFiles(scratchRepository, TYPESCRIPT_SOURCE_PATHSPECS)).toEqual([
      "src/plain.mts",
      "src/ünï.ts",
    ]);
  });
});

describe("findConfigPaths", () => {
  test("finds the repository's configs by exact name, none of them in an exempt path", () => {
    const configPaths = findConfigPaths(REPOSITORY_ROOT);
    expect(configPaths).toContain("tsconfig.json");
    expect(configPaths).toContain("packages/ingame/tsconfig.json");
    expect(configPaths).not.toContain("packages/sim/tsconfig.bundle.json");
    expect(configPaths.filter((configPath) => configPath.startsWith("spikes/"))).toEqual([]);
  });
});
