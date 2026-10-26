// The contract typecheck (#42, ADR 0005): the in-game code typechecked against an upstream ref's NS definitions instead
// of the pinned ones, so an API change that would break it shows up before Steam ships it. The repository isn't
// touched: the upstream definitions, and a config that extends the package's own and maps `@nsdefs` to them, go in a
// temporary folder.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CompilerRun, describeSilentCompilerRun, runTypescriptCompiler } from "../../typecheck/src/typecheck.ts";
import { DEFINITIONS } from "./report.ts";

/** The repository this tool lives in: its TypeScript compiler runs the check, from this directory. */
const TOOL_REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
/** The in-game code's config: its `paths` maps `@nsdefs` (and nothing else) to the pinned definitions. */
export const INGAME_CONFIG = "packages/ingame/src/tsconfig.json";
const DEFINITIONS_FILE_NAME = path.posix.basename(DEFINITIONS);
/** How an error in the substituted definitions themselves is named. */
const UPSTREAM_DEFINITIONS_LABEL = `${DEFINITIONS} (upstream)`;

export interface ContractTypeError {
  /** Repository-relative, forward slashes. */
  file: string;
  line: number;
  column: number;
  /** The compiler's code and message, continuation lines joined. */
  message: string;
}

/** Either the typecheck ran (and found these errors, maybe none), or it couldn't, and why: never mistaken for "none". */
export type ContractTypecheckResult = { ran: true; errors: ContractTypeError[] } | { ran: false; reason: string };

/** Where a compiler run's paths are read from and reported against. */
export interface CompilerRunLocations {
  /** The compiler's working directory: `tsc` prints paths relative to it. */
  compilerDirectory: string;
  /** Reported files are made relative to this. */
  repositoryRoot: string;
  /** The temporary folder holding the substituted definitions and config. */
  scratchDirectory: string;
}

/** `file(line,col): error TS1234: message`, as `tsc --pretty false` prints it. */
const LOCATED_ERROR = /^(.+)\((\d+),(\d+)\): error (TS(\d+): .*)$/;

/** Whether `file` is inside `directory` (not a sibling that merely starts with the same name). */
function isInside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The compiler's errors, split in two. Errors in the code (the in-game code, or the substituted definitions, named as
 * upstream's) are the result. Everything else means the check itself failed: an error with no place, an option or
 * config error (TS5xxx, TS6xxx, or any in a `.json` file), an error in the temporary config, or a stray line.
 */
export function parseCompilerErrors(
  output: string,
  locations: CompilerRunLocations,
): { errorsInCode: ContractTypeError[]; checkFailures: string[] } {
  const errorsInCode: ContractTypeError[] = [];
  const checkFailures: string[] = [];
  let lastErrorInCode: ContractTypeError | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = LOCATED_ERROR.exec(line);
    if (match) {
      const [, printedFile, lineNumber, columnNumber, message, code] = match as unknown as string[];
      const absoluteFile = path.resolve(locations.compilerDirectory, printedFile as string);
      const inScratch = isInside(locations.scratchDirectory, absoluteFile);
      const isConfigError = /^[56]\d{3}$/.test(code as string) || absoluteFile.endsWith(".json");
      if (isConfigError || (inScratch && path.basename(absoluteFile) !== DEFINITIONS_FILE_NAME)) {
        checkFailures.push(line);
        lastErrorInCode = undefined;
        continue;
      }
      lastErrorInCode = {
        file: inScratch
          ? UPSTREAM_DEFINITIONS_LABEL
          : path.relative(locations.repositoryRoot, absoluteFile).replaceAll(path.sep, "/"),
        line: Number(lineNumber),
        column: Number(columnNumber),
        message: message as string,
      };
      errorsInCode.push(lastErrorInCode);
    } else if (/^\s+\S/.test(line) && lastErrorInCode) {
      lastErrorInCode.message += ` ${line.trim()}`;
    } else if (line.trim() !== "") {
      checkFailures.push(line.trim());
      lastErrorInCode = undefined;
    }
  }
  return { errorsInCode, checkFailures };
}

/**
 * What a compiler run says: clean on exit 0; the code's errors when it ended by itself and every error is in the code;
 * otherwise (ended by a signal, a check failure, or a failing run that printed no error) the check itself failed.
 */
export function judgeCompilerRun(run: CompilerRun, locations: CompilerRunLocations): ContractTypecheckResult {
  if (run.exitCode === 0) return { ran: true, errors: [] };
  const output = `${run.standardOutput}${run.standardError}`;
  const { errorsInCode, checkFailures } = parseCompilerErrors(output, locations);
  if (run.signal !== null || checkFailures.length > 0 || errorsInCode.length === 0) {
    return { ran: false, reason: output.trim() === "" ? describeSilentCompilerRun(run) : output.trim() };
  }
  return { ran: true, errors: errorsInCode };
}

/**
 * Why `definitions` can't be checked on their own, or null. Only the one file is copied, so an import or reference
 * from it wouldn't resolve, and with `skipLibCheck` its types would quietly become `any`: a "none" that means nothing.
 */
export function unsupportedDefinitions(definitions: string): string | null {
  // Each pattern matches the whole line, which the reason quotes.
  const dependency =
    /^\s*import\s.*$/m.exec(definitions) ??
    /^.*\bimport\s*\(\s*["'].*$/m.exec(definitions) ??
    /^\s*export\s*(\*|\{[^}]*\})\s*from\s*["'].*$/m.exec(definitions) ??
    /^\s*\/\/\/\s*<reference\b.*$/m.exec(definitions);
  if (dependency === null) return null;
  return `The ref's ${DEFINITIONS} depends on another file (\`${dependency[0].trim()}\`), so it can't be checked on its own: copy the files it needs into the temporary folder (tools/upstream-watch/src/contract-typecheck.ts).`;
}

/**
 * Typechecks the in-game code under `repositoryRoot` (its config at `configPath`) against `definitions`, the text of an
 * upstream NetscriptDefinitions.d.ts. The temporary folder goes in `temporaryParent` (the system's by default).
 */
export function contractTypecheck(options: {
  repositoryRoot: string;
  configPath: string;
  definitions: string;
  temporaryParent?: string;
}): ContractTypecheckResult {
  const unsupported = unsupportedDefinitions(options.definitions);
  if (unsupported !== null) return { ran: false, reason: unsupported };
  let scratchDirectory: string | undefined;
  try {
    // The real path: the compiler prints resolved paths, which must compare equal to it.
    scratchDirectory = realpathSync.native(
      mkdtempSync(path.join(options.temporaryParent ?? os.tmpdir(), "contract-typecheck-")),
    );
    const definitionsPath = path.join(scratchDirectory, DEFINITIONS_FILE_NAME);
    writeFileSync(definitionsPath, options.definitions);
    // `include` and every other option come from the package's own config. `paths` is replaced whole: today it holds
    // only `@nsdefs`, and a test fails if it gains another alias, which would then have to be added here too.
    const scratchConfig = path.join(scratchDirectory, "tsconfig.json");
    writeFileSync(
      scratchConfig,
      JSON.stringify({
        extends: path.resolve(options.repositoryRoot, options.configPath),
        compilerOptions: { paths: { "@nsdefs": [definitionsPath] } },
      }),
    );
    const run = runTypescriptCompiler(TOOL_REPOSITORY_ROOT, ["-p", scratchConfig, "--pretty", "false"]);
    return judgeCompilerRun(run, {
      compilerDirectory: TOOL_REPOSITORY_ROOT,
      repositoryRoot: options.repositoryRoot,
      scratchDirectory,
    });
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (scratchDirectory !== undefined) rmSync(scratchDirectory, { recursive: true, force: true });
  }
}
