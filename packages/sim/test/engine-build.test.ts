import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { PINNED_GAME } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  buildEngine,
  collectBundleSources,
  collectEngineInputs,
  type EngineInputs,
  engineFingerprint,
  holdModules,
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
      "page.ts",
      "router.ts",
      "stubs/node-builtin.js",
      "stubs/null.cjs",
      "stubs/strong-refs.ts",
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
    expect(report.stubs).toEqual(
      expect.arrayContaining(["stubs/node-builtin.js", "stubs/null.cjs", "stubs/strong-refs.ts", "stubs/swc.js"]),
    );
  });

  test("the game's module cache, and only it, gets the strong WeakRef and FinalizationRegistry (#73)", () => {
    const bundle = readFileSync(enginePaths.bundle, "utf8");
    expect(bundle).toContain("moduleCache.set(newCode, new StrongRef(script.mod))");
    expect(bundle).toMatch(/var cleanup = new InertFinalizationRegistry\(/);
    expect(bundle.match(/new (StrongRef|InertFinalizationRegistry)\(/g)).toHaveLength(2);
    // Nothing else in the bundle, the game's dependencies included, can see the collector run.
    expect(bundle).not.toMatch(/new (WeakRef|FinalizationRegistry)\(/);
  });
});

describe("holdModules", () => {
  const cache =
    "const moduleCache = new Map();\nconst cleanup = new FinalizationRegistry(() => {});\n" +
    "moduleCache.set(newCode, new WeakRef(m));";

  test("imports the strong stand-ins on the cache's first line, so its line numbers stay the game's", () => {
    const patched = holdModules(cache);
    expect(patched.split("\n")).toHaveLength(cache.split("\n").length);
    const [, importLine, rest] =
      /^(import \{ WeakRef, FinalizationRegistry \} from "[^"]*"; )([\s\S]*)$/.exec(patched) ?? [];
    expect(importLine).toMatch(/\/stubs\/strong-refs\.ts"; $/);
    expect(rest).toBe(cache);
  });

  test.each([
    ["the cache stops making WeakRefs", cache.replace("new WeakRef(m)", "m")],
    ["only something else makes a WeakRef", `${cache.replace("new WeakRef(m)", "m")}\nconst other = new WeakRef(x);`],
    ["the cache stops using a FinalizationRegistry", cache.replace("new FinalizationRegistry(() => {})", "null")],
  ])("fails the build once %s, so the patch goes", (_, source) => {
    expect(() => holdModules(source)).toThrow(/remove holdModules/);
  });
});

describe("the strong stand-ins", () => {
  // A full collection, as measure.ts takes one: the real WeakRef would drop the target and the real registry would
  // call back, so each assertion fails on the globals the stand-ins replace.
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("a StrongRef keeps its target through a collection", async () => {
    const { WeakRef: Strong } = await import("../src/engine/bundle/stubs/strong-refs.ts");
    // Made in another function, so nothing here holds the target but the ref.
    const ref = (() => new Strong({ kept: true }))();
    await nextTask(); // a WeakRef keeps its target until the current task ends
    gc();
    expect(ref.deref()).toEqual({ kept: true });
  });

  test("the registry never calls back, even once its targets are collected", async () => {
    const { FinalizationRegistry: Inert } = await import("../src/engine/bundle/stubs/strong-refs.ts");
    const held: string[] = [];
    const registry = new Inert((heldValue: string) => held.push(heldValue));
    (() => {
      for (let i = 0; i < 100; i++) registry.register({}, `target ${i}`);
    })();
    for (let i = 0; i < 3; i++) {
      gc();
      await nextTask();
    }
    expect(held).toEqual([]);
    expect(registry.unregister({})).toBe(false);
  });
});
