// What the brain deploys: the build it makes at start, each file checked against the build's manifest.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readInGameBuild, readPinnedDefinitions } from "../src/in-game-build.ts";

const buildDirectory = mkdtempSync(path.join(os.tmpdir(), "in-game-build-"));
afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));
beforeAll(() => buildInGameBundles({ outputDirectory: buildDirectory }));

test("every script in the build, with every script's RAM budget", () => {
  const build = readInGameBuild(buildDirectory);
  expect(Object.keys(build.scripts).sort()).toEqual(Object.keys(build.ramBudgets).sort());
  expect(build.scripts["agent.js"]).toContain("async function main(ns)");
});

test("a file that doesn't match the manifest is refused, not deployed", () => {
  appendFileSync(path.join(buildDirectory, "boot.js"), "\n// edited\n");
  expect(() => readInGameBuild(buildDirectory)).toThrow(/boot\.js doesn't match the build's manifest/);
});

test("the pinned definitions are the submodule's", () => {
  expect(readPinnedDefinitions()).toContain("interface NS");
});
