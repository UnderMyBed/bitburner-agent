import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { withoutMachinePaths } from "../src/host/paths.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const forward = REPO_ROOT.replaceAll("\\", "/");

describe("withoutMachinePaths", () => {
  test.each([
    ["a native path", `at f (${path.join(REPO_ROOT, "packages", "sim", "x.js")}:1:2)`],
    ["a forward-slash path", `at f (${forward}/packages/sim/x.js:1:2)`],
    ["a file URL", `at f (${pathToFileURL(path.join(REPO_ROOT, "packages/sim/x.js")).href}:1:2)`],
  ])("rewrites %s as <repo>/…, with forward slashes", (_form, line) => {
    expect(withoutMachinePaths(line)).toBe("at f (<repo>/packages/sim/x.js:1:2)");
  });

  test("rewrites the root itself, and paths in quotes", () => {
    expect(withoutMachinePaths(`cwd ${REPO_ROOT}`)).toBe("cwd <repo>");
    expect(withoutMachinePaths(`"${forward}/a.js"`)).toBe('"<repo>/a.js"');
  });

  test("leaves a sibling directory, and a URL that merely contains the path, alone", () => {
    expect(withoutMachinePaths(`${REPO_ROOT}-old/x.js`)).toBe(`${REPO_ROOT}-old/x.js`);
    const url = `http://example.com/${forward.replace(/^\//, "")}`;
    expect(withoutMachinePaths(url)).not.toContain("example.com<repo>");
  });

  test.runIf(process.platform === "win32")("ignores the drive letter's case on Windows", () => {
    const lower = REPO_ROOT.charAt(0).toLowerCase() + REPO_ROOT.slice(1);
    expect(withoutMachinePaths(`${lower}\\x.js`)).toBe("<repo>/x.js");
  });
});
