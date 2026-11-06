import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { PINNED_GAME } from "@bitburner-agent/core";
import * as esbuild from "esbuild";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildEngine,
  collectBundleSources,
  collectEngineInputs,
  collectPackageJsons,
  collectTsconfigs,
  type EngineInputs,
  engineBuildOptions,
  engineFingerprint,
  gameDependencies,
  holdModules,
  pathIsUnder,
} from "../src/engine/build.ts";
import { enginePaths } from "../src/engine/paths.ts";
import { checkVendorInstall, lockfileHash, writeSetupStamp } from "../src/engine/vendor.ts";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", enginePaths.gameRoot, ...args], { encoding: "utf8" }).trim();

/**
 * A tree of files under a new temporary directory named `prefix`…; returns its real path (the collectors name what
 * they read by theirs).
 */
function tree(files: Record<string, string>, prefix: string): string {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

/** Links `link` to the directory `target` (a junction on Windows, which needs no rights), as a vendor may be linked. */
function linkDirectory(target: string, link: string): void {
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link, "junction");
}

const inputs: EngineInputs = {
  vendorCommit: "1da7316ff",
  vendorWorkingTree: "",
  vendorLockfile: "lock-v1",
  buildScript: "build v1",
  bundleSources: { "entry.ts": "export const a = 1;", "stubs/empty.js": "export default {};" },
  esbuildVersion: "0.28.2",
  tsconfigs: {
    "../../../tsconfig.json": '{ "extends": "../../tsconfig.base.json" }',
    "../../../../../tsconfig.base.json": "{}",
  },
  packageJsons: {
    "../../../package.json": '{"type":"module"}',
    "../../../../../vendor/bitburner-src/package.json": "{}",
  },
};

describe("engineFingerprint", () => {
  test("is stable for equal inputs, regardless of the order of the sources, tsconfigs and package.json files", () => {
    const reversed = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).reverse());
    const reordered = {
      ...inputs,
      bundleSources: reversed(inputs.bundleSources),
      tsconfigs: reversed(inputs.tsconfigs),
      packageJsons: reversed(inputs.packageJsons),
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
    // #132: esbuild applies their options (`target`, `verbatimModuleSyntax`, ...) to our bundled sources.
    [
      "tsconfig esbuild applies",
      { tsconfigs: { ...inputs.tsconfigs, "../../../tsconfig.json": '{ "compilerOptions": { "target": "es2022" } }' } },
    ],
    [
      "root tsconfig it extends",
      { tsconfigs: { ...inputs.tsconfigs, "../../../../../tsconfig.base.json": '{ "compilerOptions": {} }' } },
    ],
    // #172: esbuild applies their `type`, `sideEffects`, `browser` and `imports` to the sources under them.
    [
      "package.json esbuild applies to our sources",
      { packageJsons: { ...inputs.packageJsons, "../../../package.json": '{"type":"commonjs"}' } },
    ],
    [
      "package.json esbuild applies to the game's sources",
      {
        packageJsons: {
          ...inputs.packageJsons,
          "../../../../../vendor/bitburner-src/package.json": '{"sideEffects":false}',
        },
      },
    ],
    ["set of package.json files", { packageJsons: { ...inputs.packageJsons, "../../../../../package.json": "{}" } }],
  ])("changes when the %s changes", (_, change) => {
    expect(engineFingerprint({ ...inputs, ...change })).not.toBe(engineFingerprint(inputs));
  });
});

describe("collectEngineInputs", () => {
  test("collects every bundled source recursively, with forward-slash keys, and nothing else", () => {
    const sources = collectBundleSources(enginePaths.bundleSourceDir);
    expect(Object.keys(sources).sort()).toEqual([
      "agent-effectors.ts",
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

  test("reads the tsconfig esbuild applies to our bundled sources, and the root ones it extends (#132)", () => {
    const repoRoot = path.resolve(enginePaths.bundleSourceDir, "../../../../..");
    const read = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");
    expect(collectEngineInputs().tsconfigs).toEqual({
      "../../../tsconfig.json": read("packages/sim/tsconfig.json"),
      "../../../../../tsconfig.node.json": read("tsconfig.node.json"),
      "../../../../../tsconfig.base.json": read("tsconfig.base.json"),
    });
  });

  test("reads the package.json files above our sources and the game's (#172)", () => {
    const packageJsons = collectEngineInputs().packageJsons;
    // Any above the repository apply too, but they're the machine's, not the repository's.
    const inRepository = Object.keys(packageJsons).filter((name) => !name.startsWith("../../../../../../"));
    expect(inRepository.sort()).toEqual([
      "../../../../../package.json",
      "../../../../../vendor/bitburner-src/package.json",
      "../../../package.json",
    ]);
    expect(packageJsons["../../../package.json"]).toBe('{"type":"module"}');
    expect(packageJsons["../../../../../package.json"]).toBe('{"type":"module"}');
    // The game's sets none of them (its `repository` has a `type`, which isn't the package's).
    expect(packageJsons["../../../../../vendor/bitburner-src/package.json"]).toBe("{}");
  });
});

describe("collectPackageJsons", () => {
  test("takes every package.json at or above each directory, with only the fields esbuild applies", () => {
    const root = tree(
      {
        "pkg/package.json": JSON.stringify({
          name: "pkg",
          type: "module",
          sideEffects: ["./src/stubs/*.js"],
          dependencies: { a: "1.0.0" },
          scripts: { build: "x" },
        }),
        // The nearest with a `browser` map remaps imports below it, even past a nearer package.json without one.
        "package.json": JSON.stringify({
          browser: { "./x.js": "./y.js" },
          imports: { "#a": "./a.js" },
          repository: { type: "git" },
        }),
        "game/package.json": JSON.stringify({ main: "main.js", version: "1.0.0" }),
        // Not on either path up.
        "other/package.json": JSON.stringify({ type: "commonjs" }),
        "pkg/src/bundle/entry.ts": "",
        "game/src/a.ts": "",
      },
      "package-jsons-",
    );
    const bundle = path.join(root, "pkg/src/bundle");
    const packageJsons = collectPackageJsons([bundle, path.join(root, "game")], bundle);
    // Any above the temporary directory are the machine's.
    const inTree = Object.fromEntries(
      Object.entries(packageJsons).filter(([name]) => !name.startsWith("../../../../")),
    );
    expect(inTree).toEqual({
      "../../package.json": '{"type":"module","sideEffects":["./src/stubs/*.js"]}',
      "../../../package.json": '{"browser":{"./x.js":"./y.js"},"imports":{"#a":"./a.js"}}',
      "../../../game/package.json": "{}",
    });
  });

  test("walks up from the real path, as esbuild does: a linked directory gets those above its target", () => {
    const root = tree({ "real/package.json": '{"type":"module"}', "real/src/a.ts": "" }, "package-jsons-");
    const linked = path.join(root, "linked/src");
    linkDirectory(path.join(root, "real/src"), linked);
    const packageJsons = collectPackageJsons([linked], root);
    expect(packageJsons["real/package.json"]).toBe('{"type":"module"}');
  });

  test.each([
    ["isn't JSON", "{ type: module }"],
    ["is null", "null"],
    ["is an array", '[{ "type": "module" }]'],
    ["is a number", "3"],
  ])("fails on a package.json that %s, naming it, rather than leave it out of the fingerprint", (_, content) => {
    const root = tree({ "package.json": content, "src/a.ts": "" }, "package-jsons-");
    expect(() => collectPackageJsons([path.join(root, "src")], root)).toThrow(path.join(root, "package.json"));
  });
});

describe("collectTsconfigs", () => {
  test("walks up from the real path, as esbuild does: a linked directory gets the one above its target", () => {
    const root = tree({ "real/tsconfig.json": "{}", "real/src/a.ts": "" }, "tsconfigs-");
    const linked = path.join(root, "linked/src");
    linkDirectory(path.join(root, "real/src"), linked);
    expect(collectTsconfigs(linked)).toEqual({ "../tsconfig.json": "{}" });
  });

  test("takes the nearest tsconfig.json above the sources, as esbuild does, then each file it extends", () => {
    const files = {
      // Comments, as the repository's have (one an old extends); an extends without its .json (beside a directory of
      // the same name); then a list of them, with a trailing comma; and a cycle back, followed once.
      "pkg/tsconfig.json":
        '{\n  // the package\'s, once "extends": "./gone.json"\n  "extends": "../node",\n  "include": ["src/**/*.ts"]\n}',
      "node.json": '{ /* node */ "extends": ["./base.json", "./strict.json", ] }',
      "node/readme.txt": "a directory named like the extends, without its .json",
      "base.json": '{ "compilerOptions": { "target": "es2024" } }',
      "strict.json": '{ "extends": "./node.json", "compilerOptions": { "strict": true } }',
      // Not on the chain: another directory's, and a parent's beyond the nearest.
      "other/tsconfig.json": "{}",
      "tsconfig.json": "{}",
    };
    const root = tree({ ...files, "pkg/src/bundle/entry.ts": "" }, "tsconfigs-");
    expect(collectTsconfigs(path.join(root, "pkg/src/bundle"))).toEqual({
      "../../tsconfig.json": files["pkg/tsconfig.json"],
      "../../../node.json": files["node.json"],
      "../../../base.json": files["base.json"],
      "../../../strict.json": files["strict.json"],
    });
  });

  test("fails on an extends it can't follow, rather than leave that config out of the fingerprint", () => {
    const fromPackage = tree({ "tsconfig.json": '{ "extends": "@tsconfig/node22" }', "src/a.ts": "" }, "tsconfigs-");
    expect(() => collectTsconfigs(path.join(fromPackage, "src"))).toThrow(
      /extends @tsconfig\/node22, a package's config/,
    );
    const missing = tree({ "tsconfig.json": '{ "extends": "./gone.json" }', "src/a.ts": "" }, "tsconfigs-");
    expect(() => collectTsconfigs(path.join(missing, "src"))).toThrow(/extends \.\/gone\.json, which isn't there/);
  });

  test("fails on a jsconfig.json esbuild would take before a tsconfig.json further up", () => {
    const root = tree({ "pkg/jsconfig.json": "{}", "tsconfig.json": "{}", "pkg/src/a.ts": "" }, "tsconfigs-");
    expect(() => collectTsconfigs(path.join(root, "pkg/src"))).toThrow(/jsconfig\.json.*fingerprint/);
  });
});

describe("gameDependencies (#267)", () => {
  /** A package `name` whose main module exports `copy`. */
  const lib = (dir: string, name: string, copy: string) => ({
    [`${dir}/${name}/package.json`]: JSON.stringify({ name, main: "index.js" }),
    [`${dir}/${name}/index.js`]: `module.exports = ${JSON.stringify(copy)};`,
    [`${dir}/${name}/server.js`]: `module.exports = ${JSON.stringify(`${copy}, server`)};`,
  });

  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  interface BundleOptions {
    /** Off, to show what esbuild does on its own. */
    withGameDependencies?: boolean;
    /** Reaches the game, or our bundle's directory, through a junction, as a linked vendor would be. */
    linked?: "game" | "bundle";
    /** The directory the plugin takes for our sources, from the real one (default: that one). */
    pluginBundleDir?: (bundleDir: string) => string;
  }

  /** Bundles pkg/src/bundle/entry.js (importing `imports`) as the engine does. */
  async function bundle(files: Record<string, string>, imports: string[], options: BundleOptions = {}) {
    const { withGameDependencies = true, linked, pluginBundleDir = (dir: string) => dir } = options;
    const lines = imports.map((name, i) => `import v${i} from ${JSON.stringify(name)}; console.log(v${i});`);
    // game/src is where the plugin resolves from, as the game's own sources do: it needs to exist.
    const root = tree({ ...files, "pkg/src/bundle/entry.js": lines.join("\n"), "game/src/a.js": "" }, "hoist-");
    roots.push(root);
    let bundleDir = path.join(root, "pkg/src/bundle");
    let gameRoot = path.join(root, "game");
    if (linked === "game") {
      linkDirectory(gameRoot, path.join(root, "linked/game"));
      gameRoot = path.join(root, "linked/game");
    } else if (linked === "bundle") {
      linkDirectory(bundleDir, path.join(root, "linked/bundle"));
      bundleDir = path.join(root, "linked/bundle");
    }
    const result = await esbuild.build({
      entryPoints: [path.join(bundleDir, "entry.js")],
      bundle: true,
      format: "cjs",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: withGameDependencies ? [gameDependencies(pluginBundleDir(bundleDir), gameRoot)] : [],
    });
    return result.outputFiles[0]?.text ?? "";
  }

  test("a package hoisted to the root's node_modules is still bundled from the game's", async () => {
    const files = { ...lib("node_modules", "lib", "root copy"), ...lib("game/node_modules", "lib", "game copy") };
    // The hazard: esbuild walks up from our sources, so the root's copy comes first.
    expect(await bundle(files, ["lib"], { withGameDependencies: false })).toContain('"root copy"');
    const text = await bundle(files, ["lib", "lib/server.js"]);
    expect(text).toContain('"game copy"');
    expect(text).toContain('"game copy, server"');
    expect(text).not.toContain("root copy");
  });

  test("so is one in the bundle's own package's node_modules", async () => {
    const files = { ...lib("pkg/node_modules", "lib", "our copy"), ...lib("game/node_modules", "lib", "game copy") };
    const text = await bundle(files, ["lib"]);
    expect(text).toContain('"game copy"');
    expect(text).not.toContain("our copy");
  });

  test("fails the build on a package the game doesn't have, naming it, rather than bundle another copy", async () => {
    // The game has its node_modules, without lib.
    const files = { ...lib("node_modules", "lib", "root copy"), ...lib("game/node_modules", "other", "game copy") };
    await expect(bundle(files, ["lib"])).rejects.toThrow(
      /lib \(imported by .*entry\.js\) resolves to .*node_modules.lib.index\.js, not in the game's node_modules/,
    );
    // esbuild's own reason, not a guess at one.
    await expect(bundle({}, ["nowhere"])).rejects.toThrow(
      /nowhere \(imported by .*entry\.js\) can't be resolved from the game's sources \(Could not resolve "nowhere"/,
    );
  });

  test("leaves the game's own imports and our relative ones alone", async () => {
    const files = {
      ...lib("game/node_modules", "lib", "game copy"),
      "pkg/src/bundle/local.js": 'module.exports = "local";',
      "game/src/game.js": 'module.exports = require("lib") + ", from the game";',
    };
    const text = await bundle(files, ["./local.js", "../../../game/src/game.js"]);
    expect(text).toContain('"local"');
    expect(text).toContain('"game copy"');
  });

  test("leaves a game dependency's own imports alone: its nested copy stays its own", async () => {
    const files = {
      "game/node_modules/dep/package.json": JSON.stringify({ name: "dep", main: "index.js" }),
      "game/node_modules/dep/index.js": 'module.exports = require("lib");',
      ...lib("game/node_modules/dep/node_modules", "lib", "nested copy"),
      ...lib("game/node_modules", "lib", "game copy"),
    };
    const text = await bundle(files, ["dep"]);
    expect(text).toContain('"nested copy"');
    expect(text).not.toContain("game copy");
  });

  test.each(["game", "bundle"] as const)(
    "pins through a junctioned %s directory, as esbuild resolves it to its real path",
    async (linked) => {
      const files = { ...lib("node_modules", "lib", "root copy"), ...lib("game/node_modules", "lib", "game copy") };
      const text = await bundle(files, ["lib"], { linked });
      expect(text).toContain('"game copy"');
      expect(text).not.toContain("root copy");
    },
  );

  test("fails closed: a package bundled from outside the game's node_modules fails the build, naming it", async () => {
    // The plugin told our sources are elsewhere (as a path that doesn't match esbuild's would), so it pins nothing.
    const files = { ...lib("node_modules", "lib", "root copy"), ...lib("game/node_modules", "lib", "game copy") };
    const elsewhere = (bundleDir: string) => path.join(bundleDir, "../../../game/src");
    await expect(bundle(files, ["lib"], { pluginBundleDir: elsewhere })).rejects.toThrow(
      /bundled from outside the game's node_modules: .*node_modules.lib.index\.js/,
    );
  });

  test("leaves `#` imports to esbuild: the package.json `imports` of our sources", async () => {
    const files = {
      "pkg/src/package.json": JSON.stringify({ imports: { "#local": "./bundle/local.js" } }),
      "pkg/src/bundle/local.js": 'module.exports = "local";',
    };
    expect(await bundle(files, ["#local"])).toContain('"local"');
  });

  test("the engine's build pins our imports through it, and no longer searches the game's node_modules last", () => {
    const options = engineBuildOptions();
    expect(options.plugins?.map((plugin) => plugin.name)).toContain("game-dependencies");
    expect(options.nodePaths).toBeUndefined();
    // The plugin's check reads the metafile.
    expect(options.metafile).toBe(true);
  });
});

describe("pathIsUnder", () => {
  test("on Windows, ignores case and the separator, as its file system does", () => {
    expect(pathIsUnder("c:\\Repo\\Game\\node_modules\\lib\\index.js", "C:\\repo\\game\\node_modules", "win32")).toBe(
      true,
    );
    expect(pathIsUnder("C:/repo/game/node_modules/lib/index.js", "C:\\repo\\game\\node_modules", "win32")).toBe(true);
  });

  test("elsewhere, case matters", () => {
    expect(pathIsUnder("/repo/Game/node_modules/lib/index.js", "/repo/game/node_modules", "linux")).toBe(false);
    expect(pathIsUnder("/repo/game/node_modules/lib/index.js", "/repo/game/node_modules", "linux")).toBe(true);
  });

  test("takes a sibling with the same prefix, or the directory itself, as not under it", () => {
    expect(pathIsUnder("/repo/game/node_modules2/lib.js", "/repo/game/node_modules", "linux")).toBe(false);
    expect(pathIsUnder("C:\\repo\\game\\node_modules", "C:\\repo\\game\\node_modules", "win32")).toBe(false);
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
      // Fixed at PINNED_GAME's length, whatever the clone (a shallow one would give 7 characters).
      gameCommit: PINNED_GAME.commit,
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
