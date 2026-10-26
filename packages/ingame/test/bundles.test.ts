// The in-game build: one self-contained bundle per entry, and a manifest whose build id follows the sources.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { buildInGameBundles, MANIFEST_FILE_NAME } from "../scripts/bundles.ts";

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ingame-build-"));
  temporaryDirectories.push(directory);
  return directory;
};

test("the same sources give the same build id and bytes", async () => {
  const first = await buildInGameBundles({ outputDirectory: temporaryDirectory() });
  const second = await buildInGameBundles({ outputDirectory: temporaryDirectory() });
  expect(second).toEqual(first);
  expect(first.buildId).toMatch(/^[0-9a-f]{12}$/);
  expect(Object.keys(first.files)).toContain("boot.js");
});

test("every bundle is self-contained, names its sources relative to the repository, and the manifest matches", async () => {
  const outputDirectory = temporaryDirectory();
  const manifest = await buildInGameBundles({ outputDirectory });
  expect(JSON.parse(readFileSync(path.join(outputDirectory, MANIFEST_FILE_NAME), "utf8"))).toEqual(manifest);
  for (const fileName of Object.keys(manifest.files)) {
    const bundle = readFileSync(path.join(outputDirectory, fileName), "utf8");
    expect(bundle, fileName).not.toMatch(/^\s*import\b|\bimport\s*\(/m);
    expect(bundle, fileName).toMatch(/export\s*\{\s*main\s*\}|export async function main/);
    // Comments name sources from the repository root, whatever directory the build ran in, so the build id is the
    // same on every machine.
    expect(bundle, fileName).toContain("// packages/ingame/src/entries/");
    expect(bundle, fileName).not.toMatch(/\r\n/);
  }
});

test("building from the package's directory, as `npm run build -w` does, gives the same build", async () => {
  const fromRepositoryRoot = await buildInGameBundles({ outputDirectory: temporaryDirectory() });
  const packageDirectory = path.resolve(import.meta.dirname, "..");
  execFileSync(process.execPath, ["scripts/build.ts"], { cwd: packageDirectory });
  const fromPackage = JSON.parse(readFileSync(path.join(packageDirectory, "dist", MANIFEST_FILE_NAME), "utf8"));
  expect(fromPackage).toEqual(fromRepositoryRoot);
});

test("an entry that would import something at runtime fails the build", async () => {
  const entriesDirectory = temporaryDirectory();
  mkdirSync(entriesDirectory, { recursive: true });
  writeFileSync(
    path.join(entriesDirectory, "imports-a-url.ts"),
    'import { helper } from "https://example.com/helper.js";\nexport async function main() { helper(); }\n',
  );
  await expect(buildInGameBundles({ entriesDirectory, outputDirectory: temporaryDirectory() })).rejects.toThrow(
    /imports https:\/\/example\.com\/helper\.js at runtime/,
  );
});
