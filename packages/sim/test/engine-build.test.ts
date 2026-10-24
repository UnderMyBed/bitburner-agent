import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PINNED_GAME } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  buildEngine,
  collectBundleSources,
  collectEngineInputs,
  type EngineInputs,
  engineFingerprint,
} from "../src/engine/build.ts";
import { enginePaths } from "../src/engine/paths.ts";
import { checkVendorInstall, lockfileHash, writeSetupStamp } from "../src/engine/vendor.ts";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", enginePaths.gameRoot, ...args], { encoding: "utf8" }).trim();

const inputs: EngineInputs = {
  vendorCommit: "1da7316ff",
  vendorWorkingTree: "",
  vendorLockfile: "lock-v1",
  buildScript: "build v1",
  bundleSources: { "entry.ts": "export const a = 1;", "stubs/empty.js": "export default {};" },
  esbuildVersion: "0.28.2",
};

describe("engineFingerprint", () => {
  test("is stable for equal inputs, regardless of source order", () => {
    const reordered = {
      ...inputs,
      bundleSources: { "stubs/empty.js": "export default {};", "entry.ts": "export const a = 1;" },
    };
    expect(engineFingerprint(reordered)).toBe(engineFingerprint(inputs));
  });

  test.each([
    ["vendor commit", { vendorCommit: "abc" }],
    ["vendor working tree", { vendorWorkingTree: " M src/Constants.ts" }],
    ["vendor lockfile", { vendorLockfile: "lock-v2" }],
    ["build script", { buildScript: "build v2" }],
    ["bundle source content", { bundleSources: { ...inputs.bundleSources, "entry.ts": "export const a = 2;" } }],
    ["bundle source set", { bundleSources: { ...inputs.bundleSources, "extra.ts": "" } }],
    ["esbuild version", { esbuildVersion: "0.28.3" }],
  ])("changes when the %s changes", (_, change) => {
    expect(engineFingerprint({ ...inputs, ...change })).not.toBe(engineFingerprint(inputs));
  });
});

describe("collectEngineInputs", () => {
  test("collects every bundled source recursively, with forward-slash keys, and nothing else", () => {
    const sources = collectBundleSources(enginePaths.bundleSourceDir);
    expect(Object.keys(sources).sort()).toEqual([
      "entry.ts",
      "stubs/node-builtin.js",
      "stubs/null.cjs",
      "stubs/swc.js",
    ]);
  });

  test("reads the game's commit, working tree and lockfile", () => {
    const collected = collectEngineInputs();
    expect(collected.vendorCommit).toBe(git("rev-parse", "HEAD"));
    expect(collected.vendorLockfile).toBe(lockfileHash(enginePaths.gameRoot));
    expect(collected.buildScript).toContain("export async function buildEngine");
  });
});

describe("checkVendorInstall", () => {
  function fakeGame(stampLock?: string): string {
    const root = mkdtempSync(path.join(tmpdir(), "fake-game-"));
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
    if (stampLock !== undefined) {
      mkdirSync(path.join(root, "node_modules"));
      writeSetupStamp(root);
      if (stampLock !== "current") writeFileSync(path.join(root, "package-lock.json"), stampLock);
    }
    return root;
  }

  test("names the setup command when the game's dependencies were never installed", () => {
    expect(() => checkVendorInstall(fakeGame())).toThrow(/not installed.*npm run setup:engine/s);
  });

  test("names the setup command when the game's lockfile changed since setup", () => {
    expect(() => checkVendorInstall(fakeGame('{"lockfileVersion":3,"changed":true}'))).toThrow(
      /out of date.*npm run setup:engine/s,
    );
  });

  test("passes when setup ran against the current lockfile", () => {
    expect(() => checkVendorInstall(fakeGame("current"))).not.toThrow();
  });
});

describe("engine bundle", () => {
  const helper = path.join(import.meta.dirname, "helpers", "load-engine.ts");
  const loadEngineInChild = (...args: string[]) =>
    JSON.parse(execFileSync(process.execPath, [helper, ...args], { encoding: "utf8", timeout: 60_000 }));

  // The global setup has already built the bundle, so this build must be skipped.
  test("is not rebuilt when its inputs are unchanged", async () => {
    const started = performance.now();
    const result = await buildEngine();
    expect(result.skipped).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("is rebuilt when the recorded fingerprint doesn't match", async () => {
    const meta = JSON.parse(readFileSync(enginePaths.meta, "utf8")) as { fingerprint: string };
    writeFileSync(enginePaths.meta, JSON.stringify({ ...meta, fingerprint: "stale" }));
    const result = await buildEngine();
    expect(result.skipped).toBe(false);
    expect(result.fingerprint).toBe(meta.fingerprint);
  });

  test("loads in plain Node under the DOM environment and reports the pinned game version and commit", () => {
    expect(loadEngineInChild()).toEqual({
      versionNumber: PINNED_GAME.versionNumber,
      gameCommit: git("rev-parse", "--short", "HEAD"),
    });
  });

  test("does not load without the DOM environment", () => {
    expect(() =>
      execFileSync(process.execPath, [helper, "--no-dom"], { encoding: "utf8", stdio: "pipe", timeout: 60_000 }),
    ).toThrow(/ReferenceError: \w+ is not defined/);
  });

  test("bundles the whole game through the game-module mapping", () => {
    const { report } = JSON.parse(readFileSync(enginePaths.meta, "utf8")) as {
      report: { gameFiles: number; packages: string[]; stubs: string[] };
    };
    expect(report.gameFiles).toBeGreaterThan(500);
    expect(report.packages).toContain("react");
    // Mapped to stubs, so they must not be bundled as packages.
    expect(report.packages).not.toContain("monaco-editor");
    expect(report.packages).not.toContain("@swc/wasm-web");
    expect(report.stubs).toEqual(expect.arrayContaining(["stubs/node-builtin.js", "stubs/null.cjs", "stubs/swc.js"]));
  });
});
