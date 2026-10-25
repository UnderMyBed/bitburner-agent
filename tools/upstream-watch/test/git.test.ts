import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildReport, pinnedCommit } from "../src/git.ts";
import { DEFINITIONS, RAM_COSTS } from "../src/report.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const temp = mkdtempSync(path.join(tmpdir(), "upstream-watch-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const git = (...args: string[]) =>
  execFileSync(
    "git",
    // Scratch commits ignore the machine's own git setup: signing and hooks would get in the way.
    [
      "-C",
      temp,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

function commit(files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    writeFileSync(path.join(temp, file), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

describe("buildReport", () => {
  test("compares the pinned commit with a ref: versions, API, RAM costs and watched commits", () => {
    git("init", "-q", "-b", "stable");
    const constants = (version: string) => `export const CONSTANTS = {\n  VersionString: "${version}",\n};\n`;
    const pinned = commit(
      {
        "src/Constants.ts": constants("3.0.1"),
        [DEFINITIONS]: "export interface NS {\n  hack(host: string): Promise<number>;\n}\n",
        [RAM_COSTS]:
          "export const RamCostConstants = { Hack: 0.1 };\nexport const RamCosts = {\n  hack: RamCostConstants.Hack,\n};\n",
        "src/Watched/a.ts": "1",
        "src/Other/b.ts": "1",
      },
      "pinned",
    );
    git("checkout", "-q", "-b", "dev");
    commit({ "src/Other/b.ts": "2" }, "unwatched change");
    commit({ "src/Watched/a.ts": "2" }, "FEATURE: watched (#12)");
    commit(
      {
        "src/Constants.ts": constants("3.0.2"),
        [DEFINITIONS]:
          "export interface NS {\n  hack(host: string): Promise<number>;\n  isFullPort(port: number): boolean;\n}\n",
        [RAM_COSTS]:
          "export const RamCostConstants = { Hack: 0.1 };\nexport const RamCosts = {\n  hack: RamCostConstants.Hack,\n  isFullPort: 0,\n};\n",
      },
      "API: ports",
    );
    const report = buildReport(temp, pinned, "dev", ["src/Watched/", "src/Constants.ts"]);
    expect(report.pinned).toEqual({ sha: pinned, version: "3.0.1" });
    expect(report.upstream).toMatchObject({ ref: "dev", sha: git("rev-parse", "dev"), version: "3.0.2", ahead: true });
    // Compared the other way round, the ref is behind: it differs, but isn't ahead.
    expect(buildReport(temp, git("rev-parse", "dev"), pinned, []).upstream.ahead).toBe(false);
    expect(buildReport(temp, pinned, pinned, []).upstream.ahead).toBe(false);
    expect(report.upstream.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.api).toEqual({
      added: [],
      removed: [],
      changed: [{ key: "interface NS", added: ["isFullPort"], removed: [], changed: [] }],
    });
    expect(report.rawApiDiff).toContain("+  isFullPort(port: number): boolean;");
    expect(report.ram).toEqual([{ path: "isFullPort", before: null, after: "0" }]);
    expect(report.commits.map((c) => c.title)).toEqual(["API: ports", "FEATURE: watched (#12)"]);
  });
});

describe("this repository", () => {
  test("the pinned commit is the submodule's gitlink, the commit checked out in vendor/bitburner-src", () => {
    const checkedOut = execFileSync("git", ["-C", path.join(REPO_ROOT, "vendor/bitburner-src"), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(pinnedCommit(REPO_ROOT)).toBe(checkedOut);
  });
});
