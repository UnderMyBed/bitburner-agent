import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BOOTSTRAP_STEPS, bootstrap, runCommandIn } from "../bootstrap.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("bootstrap", () => {
  test("runs the submodule, the packages and the game's dependencies, in that order", () => {
    expect(BOOTSTRAP_STEPS.map((step) => [step.command, ...step.args].join(" "))).toEqual([
      "git submodule update --init",
      "npm ci",
      "npm run setup:engine",
    ]);
    // The script it ends with exists.
    const scripts = (
      JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["setup:engine"]).toBeDefined();
    expect(scripts.bootstrap).toBe("node tools/bootstrap/cli.ts");
  });

  test("says each step, runs them all, and ends by saying what to do next", () => {
    const ran: string[] = [];
    const said: string[] = [];
    const exitCode = bootstrap(
      BOOTSTRAP_STEPS,
      (command, args) => {
        ran.push([command, ...args].join(" "));
        return 0;
      },
      (line) => said.push(line),
    );
    expect(exitCode).toBe(0);
    expect(ran).toHaveLength(3);
    expect(said[0]).toMatch(/^\[1\/3\] the game's source/);
    expect(said.at(-1)).toContain("npm run check");
    expect(said.at(-1)).toContain("docs/setup.md");
  });

  test("stops at the first step that fails, with its exit code, and runs nothing after it", () => {
    const ran: string[] = [];
    const said: string[] = [];
    const exitCode = bootstrap(
      BOOTSTRAP_STEPS,
      (command, args) => {
        ran.push([command, ...args].join(" "));
        return command === "npm" && args[0] === "ci" ? 3 : 0;
      },
      (line) => said.push(line),
    );
    expect(exitCode).toBe(3);
    expect(ran).toEqual(["git submodule update --init", "npm ci"]);
    expect(said.at(-1)).toBe('Stopped: "npm ci" exited with 3. Fix that, then run this again.');
  });

  test("runCommandIn runs a real command in the directory and returns its exit code; a missing one fails", () => {
    const run = runCommandIn(REPOSITORY_ROOT);
    expect(run("git", ["--version"])).toBe(0);
    expect(run("no-such-command-for-bootstrap-tests", [])).not.toBe(0);
  });
});
