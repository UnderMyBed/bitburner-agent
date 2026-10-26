// npm run e2:build: the pinned game built from the submodule into .cache/e2/<commit>/, once per commit (#96).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Written last, so a build that stopped part way is never taken for a finished one. */
export const BUILT_STAMP = "built.json";
const WEBPACK_RUNNER = path.resolve(import.meta.dirname, "../scripts/webpack-in-game.ts");

export function isBuilt(outputDirectory: string): boolean {
  return existsSync(path.join(outputDirectory, BUILT_STAMP));
}

/** The submodule's uncommitted changes, as `git status --porcelain` lists them: empty when it's clean. */
export function submoduleChanges(gameRoot: string): string {
  return execFileSync("git", ["-C", gameRoot, "status", "--porcelain"], { encoding: "utf8" }).trim();
}

export interface BuildResult {
  /** Already built for this commit: nothing was done. */
  skipped: boolean;
  /** How long webpack took. */
  seconds: number;
}

/**
 * Builds the game at `gameRoot` (the submodule, at `commit`) into `outputDirectory`, unless it's built there already.
 * Refuses a submodule with changes, since they'd be built in, and fails if the build leaves any.
 */
export function buildGame({
  gameRoot,
  commit,
  outputDirectory,
  webpackRunner = WEBPACK_RUNNER,
}: {
  gameRoot: string;
  commit: string;
  outputDirectory: string;
  /** The script run in `gameRoot` with `outputDirectory` as its argument; tests give a stand-in. */
  webpackRunner?: string;
}): BuildResult {
  if (isBuilt(outputDirectory)) return { skipped: true, seconds: 0 };
  if (!existsSync(path.join(gameRoot, "node_modules/webpack/package.json"))) {
    throw new Error(`The game's dependencies aren't installed in ${gameRoot}: run npm run setup:engine first.`);
  }
  const before = submoduleChanges(gameRoot);
  if (before !== "") {
    throw new Error(`The submodule has changes, which the build would include:\n${before}`);
  }
  // A stopped earlier build may have left files.
  rmSync(outputDirectory, { recursive: true, force: true });
  const startedAt = performance.now();
  const run = spawnSync(process.execPath, [webpackRunner, outputDirectory], { cwd: gameRoot, stdio: "inherit" });
  const seconds = Math.round((performance.now() - startedAt) / 1000);
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`webpack failed (exit ${run.status ?? run.signal}); the output above says why.`);
  }
  const after = submoduleChanges(gameRoot);
  if (after !== "") throw new Error(`The build changed the submodule:\n${after}`);
  writeFileSync(
    path.join(outputDirectory, BUILT_STAMP),
    `${JSON.stringify({ commit, builtAt: new Date().toISOString(), seconds }, null, 2)}\n`,
  );
  return { skipped: false, seconds };
}
