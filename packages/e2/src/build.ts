// npm run e2:build: the pinned game built from the submodule into .cache/e2/<commit>/, once per commit and inputs
// (#96).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkVendorInstall, lockfileHash } from "@bitburner-agent/sim";

/** Written last, so a build that stopped part way is never taken for a finished one. */
export const BUILT_STAMP = "built.json";
const WEBPACK_RUNNER = path.resolve(import.meta.dirname, "../scripts/run-game-webpack.ts");
/** This harness's own code that decides what a build holds: a change to any of it means building again. */
const HARNESS_BUILD_FILES = [
  WEBPACK_RUNNER,
  path.join(import.meta.dirname, "webpack-config.ts"),
  path.join(import.meta.dirname, "build.ts"),
];

/**
 * What a build is made from, besides the game's commit: the game's dependencies (its lockfile) and this harness's build
 * code. Recorded in the stamp; a build made from other inputs is built again.
 */
export function buildInputsHash(gameRoot: string, harnessFiles: string[] = HARNESS_BUILD_FILES): string {
  const hash = createHash("sha256").update(lockfileHash(gameRoot));
  for (const file of harnessFiles) hash.update(readFileSync(file));
  return hash.digest("hex");
}

/** Whether `outputDirectory` holds a finished build made from `inputsHash`. */
export function isBuilt(outputDirectory: string, inputsHash: string): boolean {
  const stamp = path.join(outputDirectory, BUILT_STAMP);
  if (!existsSync(stamp)) return false;
  return (JSON.parse(readFileSync(stamp, "utf8")) as { inputs?: string }).inputs === inputsHash;
}

/**
 * The submodule's state, as `git status --porcelain --ignored` lists it, without its `node_modules` (the game's
 * dependencies, and babel's cache, which the build writes). Ignored files count: the game's .gitignore ignores exactly
 * what a build writes into the submodule (index.html, *.bundle.*), so a build that wrote there would otherwise pass.
 */
export function submoduleState(gameRoot: string): string[] {
  return execFileSync("git", ["-C", gameRoot, "status", "--porcelain", "--ignored"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !/^!! (.*\/)?node_modules\//.test(line));
}

/**
 * The game's committed `dist/` files (icons, favicons, the web manifest), which webpack doesn't emit: Steam's build
 * copies the whole folder (vendor/bitburner-src/tools/build.sh), so this does too.
 */
function copyCommittedDist(gameRoot: string, outputDirectory: string): void {
  const files = execFileSync("git", ["-C", gameRoot, "ls-files", "-z", "dist"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "");
  for (const file of files) {
    const target = path.join(outputDirectory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(gameRoot, file), target);
  }
}

export interface BuildResult {
  /** Already built for this commit and these inputs: nothing was done. */
  skipped: boolean;
  /** How long the build took: the webpack runner, start to exit (0 when skipped). */
  seconds: number;
}

/**
 * Builds the game at `gameRoot` (the submodule, at `commit`) into `outputDirectory`, unless it's built there already
 * from the same inputs. Refuses stale dependencies, and a submodule with changes (they'd be built in); fails if the
 * build changes the submodule.
 */
export function buildGame({
  gameRoot,
  commit,
  outputDirectory,
  webpackRunner = WEBPACK_RUNNER,
  harnessFiles = HARNESS_BUILD_FILES,
}: {
  gameRoot: string;
  commit: string;
  outputDirectory: string;
  /** The script run in `gameRoot` with `outputDirectory` as its argument; tests give a stand-in. */
  webpackRunner?: string;
  /** The harness files the inputs hash covers; tests give their own. */
  harnessFiles?: string[];
}): BuildResult {
  checkVendorInstall(gameRoot);
  const inputs = buildInputsHash(gameRoot, harnessFiles);
  if (isBuilt(outputDirectory, inputs)) return { skipped: true, seconds: 0 };
  const before = submoduleState(gameRoot);
  const changes = before.filter((line) => !line.startsWith("!! "));
  if (changes.length > 0) {
    throw new Error(`The submodule has changes, which the build would include:\n${changes.join("\n")}`);
  }
  // A stopped earlier build, or one from other inputs, may have left files.
  rmSync(outputDirectory, { recursive: true, force: true });
  const startedAt = performance.now();
  const run = spawnSync(process.execPath, [webpackRunner, outputDirectory], { cwd: gameRoot, stdio: "inherit" });
  const seconds = Math.round((performance.now() - startedAt) / 1000);
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`webpack failed (exit ${run.status ?? run.signal}); the output above says why.`);
  }
  const added = submoduleState(gameRoot).filter((line) => !before.includes(line));
  if (added.length > 0) throw new Error(`The build changed the submodule:\n${added.join("\n")}`);
  copyCommittedDist(gameRoot, outputDirectory);
  writeFileSync(
    path.join(outputDirectory, BUILT_STAMP),
    `${JSON.stringify({ commit, inputs, builtAt: new Date().toISOString(), seconds }, null, 2)}\n`,
  );
  return { skipped: false, seconds };
}
