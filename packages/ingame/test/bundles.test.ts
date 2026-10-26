// The in-game build: one self-contained bundle per entry, and a manifest whose build id follows the sources.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { buildInGameBundles, MANIFEST_FILE_NAME } from "../scripts/bundles.ts";

const outputDirectories: string[] = [];
afterAll(() => {
  for (const directory of outputDirectories) rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ingame-build-"));
  outputDirectories.push(directory);
  return directory;
};

test("the same sources give the same build id and bytes", async () => {
  const first = await buildInGameBundles(temporaryDirectory());
  const second = await buildInGameBundles(temporaryDirectory());
  expect(second).toEqual(first);
  expect(first.buildId).toMatch(/^[0-9a-f]{12}$/);
  expect(Object.keys(first.files)).toContain("boot.js");
});

test("every bundle is self-contained, and the manifest on disk is the one returned", async () => {
  const outputDirectory = temporaryDirectory();
  const manifest = await buildInGameBundles(outputDirectory);
  expect(JSON.parse(readFileSync(path.join(outputDirectory, MANIFEST_FILE_NAME), "utf8"))).toEqual(manifest);
  for (const fileName of Object.keys(manifest.files)) {
    const bundle = readFileSync(path.join(outputDirectory, fileName), "utf8");
    expect(bundle, fileName).not.toMatch(/^\s*import\b|\bimport\s*\(/m);
    expect(bundle, fileName).toMatch(/export\s*\{\s*main\s*\}|export async function main/);
  }
});
