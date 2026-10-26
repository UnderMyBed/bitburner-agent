import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Paths left out of this typecheck, each for a reason (CONTRIBUTING, "TypeScript configs"). */
export const PATH_PREFIXES_EXEMPT_FROM_TYPECHECK = [
  // Checked separately, with the game's own TypeScript: packages/sim/scripts/typecheck-bundle.ts.
  "packages/sim/src/engine/bundle/",
  // Throwaway experiments, kept as they were run (CONTRIBUTING: "excluded from the gates").
  "spikes/",
];

/** Every TypeScript source file git knows about or would add, declaration files aside. */
export const TYPESCRIPT_SOURCE_PATHSPECS = ["*.ts", "*.mts", "*.cts", "*.tsx", ":!:*.d.ts", ":!:*.d.mts", ":!:*.d.cts"];

export interface CompilerRun {
  /** The exit code, or null when the compiler was ended by a signal. */
  exitCode: number | null;
  signal: string | null;
  standardOutput: string;
  standardError: string;
}

export interface ConfigResult {
  configPath: string;
  passed: boolean;
  /** What to show for a failed config: the compiler's output, or how it ended when it printed nothing. */
  report: string;
}

export interface RepositoryTypecheck {
  configResults: ConfigResult[];
  uncoveredFiles: string[];
}

/**
 * Files on disk that git tracks, or would track (untracked but not ignored), matching the pathspecs, as
 * repository-relative forward-slash paths. Read NUL-separated, so git never quotes unusual names. A tracked file
 * deleted from the working tree is left out.
 */
export function listRepositoryFiles(repositoryRoot: string, pathspecs: string[]): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspecs],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return [...new Set(output.split("\0"))]
    .filter((file) => file !== "" && existsSync(path.join(repositoryRoot, file)))
    .sort();
}

export function isExemptFromTypecheck(file: string): boolean {
  return PATH_PREFIXES_EXEMPT_FROM_TYPECHECK.some((prefix) => file.startsWith(prefix));
}

/** The repository's TypeScript configs: every `tsconfig.json` git knows about, outside the exempt paths. */
export function findConfigPaths(repositoryRoot: string): string[] {
  return listRepositoryFiles(repositoryRoot, ["*tsconfig.json"]).filter(
    (file) => path.posix.basename(file) === "tsconfig.json" && !isExemptFromTypecheck(file),
  );
}

export function runTypescriptCompiler(repositoryRoot: string, args: string[]): CompilerRun {
  const typescriptCompiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [typescriptCompiler, ...args], { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal,
    standardOutput: result.stdout,
    standardError: result.stderr,
  };
}

/** The files a config includes, as repository-relative forward-slash paths. */
export function rootFilesOfConfig(repositoryRoot: string, configPath: string): string[] {
  const run = runTypescriptCompiler(repositoryRoot, ["-p", configPath, "--showConfig"]);
  if (run.exitCode !== 0) {
    throw new Error(`tsc --showConfig failed for ${configPath}:\n${run.standardOutput}${run.standardError}`);
  }
  const { files = [] } = JSON.parse(run.standardOutput) as { files?: string[] };
  return files.map((file) => path.posix.normalize(path.posix.join(path.posix.dirname(configPath), file)));
}

/** Source files that no config includes, apart from the exempt paths. */
export function findUncoveredFiles(sourceFiles: string[], coveredFiles: ReadonlySet<string>): string[] {
  return sourceFiles.filter((file) => !isExemptFromTypecheck(file) && !coveredFiles.has(file));
}

/** What to say about a compiler run that printed nothing: how it ended. */
export function describeSilentCompilerRun(run: CompilerRun): string {
  const ending = run.signal === null ? `exit code ${run.exitCode}` : `signal ${run.signal}`;
  return `tsc ended with ${ending} and printed nothing`;
}

export function typecheckConfig(repositoryRoot: string, configPath: string): ConfigResult {
  const run = runTypescriptCompiler(repositoryRoot, ["-p", configPath]);
  const output = run.standardOutput + run.standardError;
  return {
    configPath,
    passed: run.exitCode === 0,
    report: output.trim() === "" ? describeSilentCompilerRun(run) : output,
  };
}

/** Typechecks every config, each in its own environment, and finds the source files none of them covers. */
export function typecheckRepository(repositoryRoot: string): RepositoryTypecheck {
  const configPaths = findConfigPaths(repositoryRoot);
  const coveredFiles = new Set(configPaths.flatMap((configPath) => rootFilesOfConfig(repositoryRoot, configPath)));
  return {
    configResults: configPaths.map((configPath) => typecheckConfig(repositoryRoot, configPath)),
    uncoveredFiles: findUncoveredFiles(listRepositoryFiles(repositoryRoot, TYPESCRIPT_SOURCE_PATHSPECS), coveredFiles),
  };
}
