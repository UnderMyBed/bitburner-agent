// The build's cache and checks, and the webpack config, without running webpack: these run in CI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BUILT_STAMP, buildGame, isBuilt, submoduleChanges } from "../src/build.ts";
import { GAME_ROOT } from "../src/paths.ts";
import { e2WebpackConfig } from "../src/webpack-config.ts";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-build-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

/** A git repository with one commit, standing in for the submodule; `withDependencies` fakes an installed webpack. */
function fakeGame(name: string, { withDependencies }: { withDependencies: boolean }): string {
  const root = path.join(temporaryDirectory, name);
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(root, "webpack.config.js"), "module.exports = () => ({});\n");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "game");
  if (withDependencies) {
    mkdirSync(path.join(root, "node_modules/webpack"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/webpack/package.json"), "{}");
  }
  return root;
}

describe("buildGame", () => {
  test("a commit already built (its stamp written) is skipped, and nothing else is checked", () => {
    const outputDirectory = path.join(temporaryDirectory, "built");
    mkdirSync(outputDirectory);
    writeFileSync(path.join(outputDirectory, BUILT_STAMP), "{}");
    expect(isBuilt(outputDirectory)).toBe(true);
    expect(buildGame({ gameRoot: path.join(temporaryDirectory, "nowhere"), commit: "x", outputDirectory })).toEqual({
      skipped: true,
      seconds: 0,
    });
  });

  test("without the game's dependencies it says to run setup:engine", () => {
    const gameRoot = fakeGame("no-dependencies", { withDependencies: false });
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory: path.join(temporaryDirectory, "out1") })).toThrow(
      "run npm run setup:engine first",
    );
  });

  test("a submodule with changes is refused before building, naming them", () => {
    const gameRoot = fakeGame("dirty", { withDependencies: true });
    writeFileSync(path.join(gameRoot, "webpack.config.js"), "changed\n");
    expect(submoduleChanges(gameRoot)).toBe("M webpack.config.js");
    const outputDirectory = path.join(temporaryDirectory, "out2");
    expect(() => buildGame({ gameRoot, commit: "x", outputDirectory })).toThrow(
      "The submodule has changes, which the build would include:\nM webpack.config.js",
    );
    expect(existsSync(outputDirectory)).toBe(false);
  });

  test("a clean submodule lists no changes", () => {
    expect(submoduleChanges(fakeGame("clean", { withDependencies: true }))).toBe("");
  });

  /** A stand-in for webpack-in-game.ts: `body` runs in the game's folder, with the output directory as argv[2]. */
  function runner(name: string, body: string): string {
    const file = path.join(temporaryDirectory, `${name}.mjs`);
    writeFileSync(file, `import fs from "node:fs";\nconst out = process.argv[2];\n${body}\n`);
    return file;
  }

  test("a successful build runs in the game's folder, writes its stamp last, and is skipped next time", () => {
    const gameRoot = fakeGame("builds", { withDependencies: true });
    const outputDirectory = path.join(temporaryDirectory, "out3");
    const webpackRunner = runner(
      "succeeds",
      'fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(out + "/index.html", process.cwd());',
    );
    expect(buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner }).skipped).toBe(false);
    expect(readFileSync(path.join(outputDirectory, "index.html"), "utf8")).toBe(gameRoot);
    expect(JSON.parse(readFileSync(path.join(outputDirectory, BUILT_STAMP), "utf8"))).toMatchObject({ commit: "abc" });
    expect(buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner }).skipped).toBe(true);
  });

  test("a failed build says so and writes no stamp; a stopped build's leftovers are cleared first", () => {
    const gameRoot = fakeGame("fails", { withDependencies: true });
    const outputDirectory = path.join(temporaryDirectory, "out4");
    mkdirSync(outputDirectory);
    writeFileSync(path.join(outputDirectory, "leftover.js"), "");
    const webpackRunner = runner("fails", "process.exit(3);");
    expect(() => buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner })).toThrow(
      "webpack failed (exit 3)",
    );
    expect(existsSync(path.join(outputDirectory, "leftover.js"))).toBe(false);
    expect(isBuilt(outputDirectory)).toBe(false);
  });

  test("a build that changes the submodule fails, naming the change, and writes no stamp", () => {
    const gameRoot = fakeGame("dirtied", { withDependencies: true });
    const outputDirectory = path.join(temporaryDirectory, "out5");
    const webpackRunner = runner(
      "dirties",
      // An absolute path, so it lands in the fake game wherever the runner is started.
      `fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(gameRoot, "stray.txt"))}, "");`,
    );
    expect(() => buildGame({ gameRoot, commit: "abc", outputDirectory, webpackRunner })).toThrow(
      "The build changed the submodule:\n?? stray.txt",
    );
    expect(isBuilt(outputDirectory)).toBe(false);
  });
});

describe.runIf(existsSync(path.join(GAME_ROOT, "node_modules/webpack/package.json")))("e2WebpackConfig", () => {
  test("the game's production config, writing outside the submodule, minifying on one core, no typecheck process", () => {
    const outputDirectory = path.join(temporaryDirectory, "webpack-out");
    const config = e2WebpackConfig(GAME_ROOT, outputDirectory);
    expect(config.output.path).toBe(path.join(outputDirectory, "dist"));
    expect(config.optimization.minimize).toBe(true);
    const minimizers = config.optimization.minimizer as {
      constructor: { name: string };
      options: { parallel: unknown };
    }[];
    expect(minimizers.map((minimizer) => [minimizer.constructor.name, minimizer.options.parallel])).toEqual([
      ["TerserPlugin", false],
    ]);
    const pluginNames = config.plugins.map((plugin) => plugin.constructor.name);
    expect(pluginNames).not.toContain("ForkTsCheckerWebpackPlugin");
    // The game's own plugins otherwise stay: the editor's, the HTML page's and the commit hash's.
    expect(pluginNames).toEqual(
      expect.arrayContaining(["MonacoEditorWebpackPlugin", "HtmlWebpackPlugin", "DefinePlugin"]),
    );
  });
});
