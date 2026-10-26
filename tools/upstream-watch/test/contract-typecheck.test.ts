import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  contractTypecheck,
  INGAME_CONFIG,
  judgeCompilerRun,
  parseCompilerErrors,
  unsupportedDefinitions,
} from "../src/contract-typecheck.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "contract-typecheck-test-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

const PINNED_DEFINITIONS = "export interface NS {\n  foo(x: number): void;\n  bar(): string;\n}\n";
// One changed signature: foo now takes a string.
const CHANGED_DEFINITIONS = "export interface NS {\n  foo(x: string): void;\n  bar(): string;\n}\n";

/**
 * A stand-in for packages/ingame: a package whose src/tsconfig.json maps `@nsdefs` to the pinned definitions, as the
 * real one does, and an in-game file that uses foo.
 */
function fixtureRepository(name: string): string {
  const root = path.join(temporaryDirectory, name);
  const source = path.join(root, "packages/ingame/src");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n');
  writeFileSync(path.join(root, "pinned.d.ts"), PINNED_DEFINITIONS);
  writeFileSync(
    path.join(source, "tsconfig.json"),
    JSON.stringify({
      extends: path.join(REPOSITORY_ROOT, "tsconfig.base.json"),
      compilerOptions: { lib: ["es2024", "dom"], paths: { "@nsdefs": ["../../../pinned.d.ts"] } },
      include: ["**/*.ts"],
    }),
  );
  writeFileSync(
    path.join(source, "agent.ts"),
    'import type { NS } from "@nsdefs";\n\nexport function main(ns: NS): void {\n  ns.foo(1);\n  void ns.bar();\n}\n',
  );
  return root;
}

const run = (repositoryRoot: string, definitions: string, temporaryParent?: string) =>
  contractTypecheck({ repositoryRoot, configPath: INGAME_CONFIG, definitions, temporaryParent });

describe("contractTypecheck", () => {
  test("against definitions with a changed signature: exactly that error, with file, line, column and message", () => {
    const repositoryRoot = fixtureRepository("changed");
    expect(run(repositoryRoot, CHANGED_DEFINITIONS)).toEqual({
      ran: true,
      errors: [
        {
          file: "packages/ingame/src/agent.ts",
          line: 4,
          column: 10,
          message: "TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.",
        },
      ],
    });
  });

  test("against the same definitions: ran, no errors", () => {
    expect(run(fixtureRepository("same"), PINNED_DEFINITIONS)).toEqual({ ran: true, errors: [] });
  });

  test("a config that can't be read: says it couldn't run, with the compiler's output, never 'no errors'", () => {
    const repositoryRoot = path.join(temporaryDirectory, "empty");
    mkdirSync(repositoryRoot, { recursive: true });
    const result = run(repositoryRoot, PINNED_DEFINITIONS);
    expect(result.ran).toBe(false);
    expect(result.ran === false && result.reason).toMatch(/tsconfig\.json/);
  });

  test("a temporary folder that can't be made: says it couldn't run, rather than failing the report", () => {
    const result = run(fixtureRepository("no-temporary"), PINNED_DEFINITIONS, path.join(temporaryDirectory, "absent"));
    expect(result.ran).toBe(false);
    expect(result.ran === false && result.reason).toMatch(/ENOENT/);
  });

  test("definitions that depend on another file: says it couldn't run, without compiling", () => {
    const result = run(
      fixtureRepository("importing"),
      `import type { RamAmount } from "./Ram";\n${PINNED_DEFINITIONS}`,
    );
    expect(result.ran).toBe(false);
    expect(result.ran === false && result.reason).toContain("depends on another file");
  });

  test("this repository's in-game code against the pinned game's own definitions: ran, no errors", () => {
    const pinnedDefinitions = readFileSync(
      path.join(REPOSITORY_ROOT, "vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts"),
      "utf8",
    );
    expect(
      contractTypecheck({ repositoryRoot: REPOSITORY_ROOT, configPath: INGAME_CONFIG, definitions: pinnedDefinitions }),
    ).toEqual({ ran: true, errors: [] });
  });

  test("the in-game config's `paths` holds only `@nsdefs`, which is all the temporary config replaces", () => {
    // tsconfig.json allows comments: strip whole-line ones before parsing.
    const configText = readFileSync(path.join(REPOSITORY_ROOT, INGAME_CONFIG), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(configText) as { compilerOptions: { paths: Record<string, string[]> } };
    expect(Object.keys(config.compilerOptions.paths)).toEqual(["@nsdefs"]);
  });

  test("leaves nothing behind, in the repository or the temporary folder", () => {
    const repositoryRoot = fixtureRepository("clean");
    const temporaryParent = path.join(temporaryDirectory, "temporary-parent");
    mkdirSync(temporaryParent);
    run(repositoryRoot, CHANGED_DEFINITIONS, temporaryParent);
    expect(readdirSync(temporaryParent)).toEqual([]);
    expect(readdirSync(repositoryRoot, { recursive: true }).map(String).sort()).toEqual(
      [
        "package.json",
        "packages",
        path.join("packages", "ingame"),
        path.join("packages", "ingame", "src"),
        path.join("packages", "ingame", "src", "agent.ts"),
        path.join("packages", "ingame", "src", "tsconfig.json"),
        "pinned.d.ts",
      ].sort(),
    );
  });
});

describe("unsupportedDefinitions", () => {
  test("a self-contained file is fine; any import, re-export or reference isn't", () => {
    expect(unsupportedDefinitions(PINNED_DEFINITIONS)).toBeNull();
    expect(unsupportedDefinitions('import type { X } from "./x";\n')).toContain("`import type");
    expect(unsupportedDefinitions('export type Y = import("./x").X;\n')).toContain(
      '`export type Y = import("./x").X;`',
    );
    expect(unsupportedDefinitions('export * from "./x";\n')).toContain("`export * from");
    expect(unsupportedDefinitions('export { X } from "./x";\n')).toContain("`export { X } from");
    expect(unsupportedDefinitions('/// <reference path="/etc/x.d.ts" />\n')).toContain("`/// <reference");
  });
});

describe("judgeCompilerRun", () => {
  const root = path.resolve("/repo");
  const locations = { compilerDirectory: root, repositoryRoot: root, scratchDirectory: path.resolve("/tmp/scratch") };
  const compilerRun = (exitCode: number | null, standardOutput: string, signal: string | null = null) => ({
    exitCode,
    signal,
    standardOutput,
    standardError: "",
  });
  const codeError = "packages/ingame/src/a.ts(3,10): error TS2345: Argument of type 'number' is not assignable.";

  test("exit 0 is clean", () => {
    expect(judgeCompilerRun(compilerRun(0, ""), locations)).toEqual({ ran: true, errors: [] });
  });

  test("only errors in the code: those errors", () => {
    expect(judgeCompilerRun(compilerRun(2, `${codeError}\n`), locations)).toMatchObject({
      ran: true,
      errors: [{ file: "packages/ingame/src/a.ts", line: 3, column: 10 }],
    });
  });

  test("any error with no place, even beside errors in the code: couldn't run, with the output", () => {
    const output = `${codeError}\nerror TS5023: Unknown compiler option 'x'.\n`;
    expect(judgeCompilerRun(compilerRun(2, output), locations)).toEqual({ ran: false, reason: output.trim() });
  });

  test("ended by a signal, even after printing errors: couldn't run (the list may be incomplete)", () => {
    expect(judgeCompilerRun(compilerRun(null, `${codeError}\n`, "SIGTERM"), locations)).toEqual({
      ran: false,
      reason: codeError,
    });
  });

  test("a failure that printed nothing: couldn't run, saying how it ended", () => {
    expect(judgeCompilerRun(compilerRun(null, "", "SIGKILL"), locations)).toEqual({
      ran: false,
      reason: "tsc ended with signal SIGKILL and printed nothing",
    });
  });
});

describe("parseCompilerErrors", () => {
  const root = path.resolve("/repo");
  const scratchDirectory = path.resolve("/tmp/scratch");
  const locations = { compilerDirectory: root, repositoryRoot: root, scratchDirectory };

  test("reads errors in the code, joining continuation lines, relative to the repository", () => {
    const output = [
      `${path.join(root, "packages/ingame/src/a.ts")}(3,10): error TS2345: Argument of type 'number' is not assignable.`,
      "  Type 'number' is not assignable to type 'string'.",
      "packages/ingame/src/b.ts(12,1): error TS2304: Cannot find name 'x'.",
      "",
    ].join("\n");
    expect(parseCompilerErrors(output, locations)).toEqual({
      errorsInCode: [
        {
          file: "packages/ingame/src/a.ts",
          line: 3,
          column: 10,
          message:
            "TS2345: Argument of type 'number' is not assignable. Type 'number' is not assignable to type 'string'.",
        },
        { file: "packages/ingame/src/b.ts", line: 12, column: 1, message: "TS2304: Cannot find name 'x'." },
      ],
      checkFailures: [],
    });
  });

  test("an error in the substituted definitions is named as the upstream definitions file", () => {
    const output = `${path.join(scratchDirectory, "NetscriptDefinitions.d.ts")}(7,3): error TS1005: ';' expected.\n`;
    expect(parseCompilerErrors(output, locations).errorsInCode).toEqual([
      {
        file: "src/ScriptEditor/NetscriptDefinitions.d.ts (upstream)",
        line: 7,
        column: 3,
        message: "TS1005: ';' expected.",
      },
    ]);
  });

  test("a sibling folder whose name starts like the temporary one isn't inside it", () => {
    const sibling = `${scratchDirectory}2`;
    const output = `${path.join(sibling, "NetscriptDefinitions.d.ts")}(1,1): error TS1005: ';' expected.\n`;
    expect(parseCompilerErrors(output, { ...locations, repositoryRoot: path.resolve("/tmp") }).errorsInCode).toEqual([
      { file: "scratch2/NetscriptDefinitions.d.ts", line: 1, column: 1, message: "TS1005: ';' expected." },
    ]);
  });

  test("errors with no place, in the temporary config, in a .json file or an option code: the check itself failed", () => {
    const configError = `${path.join(scratchDirectory, "tsconfig.json")}(1,13): error TS2307: Cannot find 'x'.`;
    const strayScratchError = `${path.join(scratchDirectory, "other.d.ts")}(2,1): error TS2304: Cannot find name 'y'.`;
    const baseConfigError = "tsconfig.base.json(4,5): error TS2322: Not a boolean.";
    const optionError = "packages/ingame/src/a.ts(1,1): error TS6059: File is not under rootDir.";
    const output = `error TS5058: The specified path does not exist.\n${configError}\n${strayScratchError}\n${baseConfigError}\n${optionError}\n`;
    expect(parseCompilerErrors(output, locations)).toEqual({
      errorsInCode: [],
      checkFailures: [
        "error TS5058: The specified path does not exist.",
        configError,
        strayScratchError,
        baseConfigError,
        optionError,
      ],
    });
  });

  test("an indented line after a check failure isn't added to an earlier error in the code", () => {
    const output = [
      "packages/ingame/src/a.ts(3,10): error TS2345: First.",
      "error TS5023: Unknown compiler option 'x'.",
      "  An indented line.",
      "packages/ingame/src/b.ts(1,1): error TS2304: Second.",
      `${path.join(scratchDirectory, "tsconfig.json")}(1,1): error TS2307: Third.`,
      "  Another indented line.",
    ].join("\n");
    expect(parseCompilerErrors(output, locations).errorsInCode.map((error) => error.message)).toEqual([
      "TS2345: First.",
      "TS2304: Second.",
    ]);
  });
});
