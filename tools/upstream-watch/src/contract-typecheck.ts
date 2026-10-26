// The contract typecheck (#42, ADR 0005): the in-game code typechecked against an upstream ref's NS definitions instead
// of the pinned ones, so an API change that would break it shows up before Steam ships it. The repository isn't
// touched: the upstream definitions, and a config that extends the package's own and maps `@nsdefs` to them, go in a
// temporary folder.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type CompilerRun, runTypescriptCompiler } from "../../typecheck/src/typecheck.ts";
import { DEFINITIONS } from "./report.ts";

/** The repository this tool lives in, whose TypeScript compiler runs the check. */
const COMPILER_DIRECTORY = path.resolve(import.meta.dirname, "../../..");
/** The in-game code's config: its `paths` maps `@nsdefs` to the pinned definitions. */
export const INGAME_CONFIG = "packages/ingame/src/tsconfig.json";
const DEFINITIONS_FILE_NAME = path.posix.basename(DEFINITIONS);
/** How an error in the substituted definitions themselves is named. */
const UPSTREAM_DEFINITIONS_LABEL = `${DEFINITIONS} (upstream)`;

export interface ContractTypeError {
  /** Repository-relative, forward slashes. */
  file: string;
  line: number;
  /** The compiler's code and message, continuation lines joined. */
  message: string;
}

/** Either the typecheck ran (and found these errors, maybe none), or it couldn't, and why: never mistaken for "none". */
export type ContractTypecheck = { ran: true; errors: ContractTypeError[] } | { ran: false; reason: string };

/** `file(line,col): error TS1234: message`, as `tsc --pretty false` prints it. */
const LOCATED_ERROR = /^(.+)\((\d+),\d+\): error (TS\d+: .*)$/;

/**
 * The compiler's errors. Located ones are the code's; ones with no location, or in the temporary config, mean the
 * check itself failed. Files are made relative to `repositoryRoot`; the substituted definitions get their upstream name.
 */
export function parseCompilerErrors(
  output: string,
  locations: { compilerDirectory: string; repositoryRoot: string; scratchDirectory: string },
): { located: ContractTypeError[]; unlocated: string[] } {
  const located: ContractTypeError[] = [];
  const unlocated: string[] = [];
  let last: ContractTypeError | undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = LOCATED_ERROR.exec(line);
    if (match) {
      const [, printedFile, lineNumber, message] = match as unknown as [string, string, string, string];
      const absoluteFile = path.resolve(locations.compilerDirectory, printedFile);
      const inScratch = absoluteFile.startsWith(path.resolve(locations.scratchDirectory) + path.sep);
      if (inScratch && path.basename(absoluteFile) !== DEFINITIONS_FILE_NAME) {
        unlocated.push(line);
        last = undefined;
        continue;
      }
      last = {
        file: inScratch
          ? UPSTREAM_DEFINITIONS_LABEL
          : path.relative(locations.repositoryRoot, absoluteFile).replaceAll(path.sep, "/"),
        line: Number(lineNumber),
        message,
      };
      located.push(last);
    } else if (/^\s+\S/.test(line) && last) {
      last.message += ` ${line.trim()}`;
    } else if (line.trim() !== "") {
      unlocated.push(line.trim());
      last = undefined;
    }
  }
  return { located, unlocated };
}

/**
 * What a compiler run says: clean on exit 0; the code's errors when every error has a place in the code; otherwise
 * (an error with no place, or in the temporary config, or a failure that printed none) the check itself failed.
 */
export function judgeCompilerRun(
  run: CompilerRun,
  locations: { compilerDirectory: string; repositoryRoot: string; scratchDirectory: string },
): ContractTypecheck {
  if (run.exitCode === 0) return { ran: true, errors: [] };
  const output = `${run.standardOutput}${run.standardError}`;
  const { located, unlocated } = parseCompilerErrors(output, locations);
  if (unlocated.length > 0 || located.length === 0) {
    const ending = run.signal === null ? `exit code ${run.exitCode}` : `signal ${run.signal}`;
    return {
      ran: false,
      reason: output.trim() === "" ? `tsc ended with ${ending} and printed nothing` : output.trim(),
    };
  }
  return { ran: true, errors: located };
}

/**
 * Typechecks the in-game code under `repositoryRoot` (its config at `configPath`) against `definitions`, the text of an
 * upstream NetscriptDefinitions.d.ts.
 */
export function contractTypecheck(options: {
  repositoryRoot: string;
  configPath: string;
  definitions: string;
}): ContractTypecheck {
  const scratchDirectory = mkdtempSync(path.join(os.tmpdir(), "contract-typecheck-"));
  try {
    const definitionsPath = path.join(scratchDirectory, DEFINITIONS_FILE_NAME);
    writeFileSync(definitionsPath, options.definitions);
    // `include` and every other option come from the package's own config; only `@nsdefs` moves.
    const scratchConfig = path.join(scratchDirectory, "tsconfig.json");
    writeFileSync(
      scratchConfig,
      JSON.stringify({
        extends: path.resolve(options.repositoryRoot, options.configPath),
        compilerOptions: { paths: { "@nsdefs": [definitionsPath] } },
      }),
    );
    const run = runTypescriptCompiler(COMPILER_DIRECTORY, ["-p", scratchConfig, "--pretty", "false"]);
    return judgeCompilerRun(run, {
      compilerDirectory: COMPILER_DIRECTORY,
      repositoryRoot: options.repositoryRoot,
      scratchDirectory,
    });
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}
