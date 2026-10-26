// The build's cache and checks, and the webpack config, without running webpack: these run in CI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSetupStamp } from "@bitburner-agent/sim";
import { afterAll, describe, expect, test } from "vitest";
import { BUILT_STAMP, buildGame, buildInputsHash, isBuilt, submoduleState } from "../src/build.ts";
import { GAME_ROOT, gameCommit } from "../src/paths.ts";
import { e2WebpackConfig } from "../src/webpack-config.ts";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-build-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

/** A harness file for the inputs hash: tests change it to change the inputs. */
const harnessFile = path.join(temporaryDirectory, "harness.ts");
writeFileSync(harnessFile, "// version 1\n");
const harnessFiles = [harnessFile];

/**
 * A git repository with one commit, standing in for the submodule: a lockfile, a committed `dist/` icon, and a
 * .gitignore like the game's (build outputs ignored). Its dependencies are "installed" (setup's stamp written).
 */
function fakeGame(name: string): string {
  const root = path.join(temporaryDirectory, name);
  mkdirSync(path.join(root, "dist/icons"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\nindex.html\n*.bundle.*\n");
  writeFileSync(path.join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  writeFileSync(path.join(root, "dist/icons/achievement.svg"), "<svg/>");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "game");
  mkdirSync(path.join(root, "node_modules"));
  writeSetupStamp(root);
  return root;
}

/** A stand-in for run-game-webpack.ts: `body` runs in the game's folder, with the output directory as argv[2]. */
function runner(name: string, body: string): string {
  const file = path.join(temporaryDirectory, `${name}.mjs`);
  writeFileSync(file, `import fs from "node:fs";\nconst out = process.argv[2];\n${body}\n`);
  return file;
}

const succeeds = runner(
  "succeeds",
  'fs.mkdirSync(out + "/dist", { recursive: true }); fs.writeFileSync(out + "/index.html", process.cwd());',
);

describe("buildGame", () => {
  test("builds in the game's folder, copies the game's committed dist/ files, and writes its stamp last", () => {
    const gameRoot = fakeGame("builds");
    const outputDirectory = path.join(temporaryDirectory, "out-builds");
    const result = buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner: succeeds, harnessFiles });
    expect(result.skipped).toBe(false);
    expect(readFileSync(path.join(outputDirectory, "index.html"), "utf8")).toBe(gameRoot);
    expect(readFileSync(path.join(outputDirectory, "dist/icons/achievement.svg"), "utf8")).toBe("<svg/>");
    const stamp = JSON.parse(readFileSync(path.join(outputDirectory, BUILT_STAMP), "utf8"));
    expect(stamp).toMatchObject({ commit: "abc", inputs: buildInputsHash(gameRoot, harnessFiles) });
    expect(isBuilt(outputDirectory, buildInputsHash(gameRoot, harnessFiles))).toBe(true);
  });

  test("built from the same inputs, it's skipped; from other inputs (harness code, dependencies), built again", () => {
    const gameRoot = fakeGame("inputs");
    const outputDirectory = path.join(temporaryDirectory, "out-inputs");
    const build = () => buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner: succeeds, harnessFiles });
    expect(build().skipped).toBe(false);
    expect(build().skipped).toBe(true);
    writeFileSync(harnessFile, "// version 2\n");
    try {
      expect(build().skipped).toBe(false);
    } finally {
      writeFileSync(harnessFile, "// version 1\n");
    }
    // New dependencies, committed (as a game bump brings them) and installed: the lockfile and setup's stamp change.
    writeFileSync(path.join(gameRoot, "package-lock.json"), '{ "lockfileVersion": 3, "packages": {} }\n');
    const git = (...args: string[]) => execFileSync("git", ["-C", gameRoot, ...args], { encoding: "utf8" });
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-am", "bump");
    writeSetupStamp(gameRoot);
    expect(build().skipped).toBe(false);
  });

  test("refuses dependencies that aren't installed, or are stale, before anything else", () => {
    const gameRoot = fakeGame("stale");
    const outputDirectory = path.join(temporaryDirectory, "out-stale");
    writeFileSync(path.join(gameRoot, "package-lock.json"), '{ "lockfileVersion": 3, "changed": true }\n');
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory, webpackRunner: succeeds, harnessFiles })).toThrow(
      "out of date",
    );
    rmSync(path.join(gameRoot, "node_modules"), { recursive: true });
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory, webpackRunner: succeeds, harnessFiles })).toThrow(
      "not installed",
    );
  });

  test("a submodule with changes is refused before building, naming them", () => {
    const gameRoot = fakeGame("dirty");
    writeFileSync(path.join(gameRoot, "package.json"), "{}");
    const outputDirectory = path.join(temporaryDirectory, "out-dirty");
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory, webpackRunner: succeeds, harnessFiles })).toThrow(
      "The submodule has changes, which the build would include:\n?? package.json",
    );
    expect(existsSync(outputDirectory)).toBe(false);
  });

  test("its state lists ignored files, but not node_modules", () => {
    const gameRoot = fakeGame("state");
    expect(submoduleState(gameRoot)).toEqual([]);
    writeFileSync(path.join(gameRoot, "index.html"), "");
    mkdirSync(path.join(gameRoot, "node_modules/.cache"), { recursive: true });
    writeFileSync(path.join(gameRoot, "node_modules/.cache/x"), "");
    expect(submoduleState(gameRoot)).toEqual(["!! index.html"]);
  });

  test("a failed build says so and writes no stamp; a stopped build's leftovers are cleared first", () => {
    const gameRoot = fakeGame("fails");
    const outputDirectory = path.join(temporaryDirectory, "out-fails");
    mkdirSync(outputDirectory);
    writeFileSync(path.join(outputDirectory, "leftover.js"), "");
    const webpackRunner = runner("fails", "process.exit(3);");
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory, webpackRunner, harnessFiles })).toThrow(
      "webpack failed (exit 3)",
    );
    expect(existsSync(path.join(outputDirectory, "leftover.js"))).toBe(false);
    expect(isBuilt(outputDirectory, buildInputsHash(gameRoot, harnessFiles))).toBe(false);
  });

  test("a build that writes into the submodule fails, naming what it wrote, even a file the game ignores", () => {
    const gameRoot = fakeGame("dirtied");
    const outputDirectory = path.join(temporaryDirectory, "out-dirtied");
    // Absolute paths, so they land in the fake game wherever the runner is started.
    const webpackRunner = runner(
      "dirties",
      `fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(gameRoot, "main.bundle.js"))}, "");`,
    );
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory, webpackRunner, harnessFiles })).toThrow(
      "The build changed the submodule:\n!! main.bundle.js",
    );
    expect(isBuilt(outputDirectory, buildInputsHash(gameRoot, harnessFiles))).toBe(false);
  });
});

describe("gameCommit", () => {
  test("is the pinned commit: this repository's gitlink, which the submodule has checked out", () => {
    const gitlink = execFileSync("git", ["ls-tree", "HEAD", "vendor/bitburner-src"], {
      cwd: path.join(GAME_ROOT, "../.."),
      encoding: "utf8",
    });
    expect(gitlink).toContain(gameCommit());
  });
});

describe.runIf(existsSync(path.join(GAME_ROOT, "node_modules/webpack/package.json")))("e2WebpackConfig", () => {
  test("the game's production config, writing outside the submodule, minifying on one core, no typecheck process", () => {
    const outputDirectory = path.join(temporaryDirectory, "webpack-out");
    const config = e2WebpackConfig(GAME_ROOT, outputDirectory);
    expect(config.mode).toBe("production");
    expect(config.output.path).toBe(path.join(outputDirectory, "dist"));
    expect(config.optimization.minimize).toBe(true);
    const minimizers = config.optimization.minimizer as {
      constructor: { name: string };
      options: { parallel: unknown; minimizer: { options: unknown } };
    }[];
    // webpack's default minimizer (two compress passes), only on one core.
    expect(
      minimizers.map((minimizer) => [
        minimizer.constructor.name,
        minimizer.options.parallel,
        minimizer.options.minimizer.options,
      ]),
    ).toEqual([["TerserPlugin", false, { compress: { passes: 2 } }]]);
    const pluginNames = config.plugins.map((plugin) => plugin.constructor.name);
    expect(pluginNames).not.toContain("ForkTsCheckerWebpackPlugin");
    // The game's own plugins otherwise stay: the editor's, the HTML page's and the commit hash's.
    expect(pluginNames).toEqual(
      expect.arrayContaining(["MonacoEditorWebpackPlugin", "HtmlWebpackPlugin", "DefinePlugin"]),
    );
  });
});
