import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { contractTypecheck, INGAME_CONFIG, judgeCompilerRun, parseCompilerErrors } from "../src/contract-typecheck.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "contract-typecheck-"));
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

const run = (repositoryRoot: string, definitions: string) =>
  contractTypecheck({ repositoryRoot, configPath: "packages/ingame/src/tsconfig.json", definitions });

describe("contractTypecheck", () => {
  test("against definitions with a changed signature: exactly that error, with file, line and message", () => {
    const repositoryRoot = fixtureRepository("changed");
    expect(run(repositoryRoot, CHANGED_DEFINITIONS)).toEqual({
      ran: true,
      errors: [
        {
          file: "packages/ingame/src/agent.ts",
          line: 4,
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

  test("this repository's in-game code against the pinned game's own definitions: ran, no errors", () => {
    const pinnedDefinitions = readFileSync(
      path.join(REPOSITORY_ROOT, "vendor/bitburner-src/src/ScriptEditor/NetscriptDefinitions.d.ts"),
      "utf8",
    );
    expect(
      contractTypecheck({ repositoryRoot: REPOSITORY_ROOT, configPath: INGAME_CONFIG, definitions: pinnedDefinitions }),
    ).toEqual({ ran: true, errors: [] });
  });

  test("leaves nothing behind, in the repository or the temporary folder", () => {
    const repositoryRoot = fixtureRepository("clean");
    const scratchFolders = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith("contract-typecheck-"));
    const before = scratchFolders();
    run(repositoryRoot, CHANGED_DEFINITIONS);
    expect(scratchFolders()).toEqual(before);
    // The substituted definitions and config live in a temporary folder of their own.
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
      errors: [{ file: "packages/ingame/src/a.ts", line: 3 }],
    });
  });

  test("any error with no place, even beside errors in the code: couldn't run, with the output", () => {
    const output = `${codeError}\nerror TS5023: Unknown compiler option 'x'.\n`;
    expect(judgeCompilerRun(compilerRun(2, output), locations)).toEqual({ ran: false, reason: output.trim() });
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

  test("reads located errors, joining continuation lines, relative to the repository", () => {
    const output = [
      `${path.join(root, "packages/ingame/src/a.ts")}(3,10): error TS2345: Argument of type 'number' is not assignable.`,
      "  Type 'number' is not assignable to type 'string'.",
      "packages/ingame/src/b.ts(12,1): error TS2304: Cannot find name 'x'.",
      "",
    ].join("\n");
    expect(parseCompilerErrors(output, locations)).toEqual({
      located: [
        {
          file: "packages/ingame/src/a.ts",
          line: 3,
          message:
            "TS2345: Argument of type 'number' is not assignable. Type 'number' is not assignable to type 'string'.",
        },
        { file: "packages/ingame/src/b.ts", line: 12, message: "TS2304: Cannot find name 'x'." },
      ],
      unlocated: [],
    });
  });

  test("an error in the substituted definitions is named as the upstream definitions file", () => {
    const output = `${path.join(scratchDirectory, "NetscriptDefinitions.d.ts")}(7,3): error TS1005: ';' expected.\n`;
    expect(parseCompilerErrors(output, locations).located).toEqual([
      { file: "src/ScriptEditor/NetscriptDefinitions.d.ts (upstream)", line: 7, message: "TS1005: ';' expected." },
    ]);
  });

  test("errors with no location, or in the temporary config, are kept apart: they mean the check itself failed", () => {
    const configError = `${path.join(scratchDirectory, "tsconfig.json")}(1,13): error TS5083: Cannot read file 'x'.`;
    const output = `error TS5058: The specified path does not exist.\n${configError}\n`;
    expect(parseCompilerErrors(output, locations)).toEqual({
      located: [],
      unlocated: ["error TS5058: The specified path does not exist.", configError],
    });
  });
});
