// Each config's environment, checked with probe files typechecked under that config's own options, so a change to a
// config or to tsconfig.base.json that lets Node or the DOM back in fails here (CONTRIBUTING, "TypeScript configs").
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { findConfigPaths, runTypescriptCompiler } from "../src/typecheck.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");

interface Probe {
  description: string;
  source: string;
  /** The error a config that forbids the probe must give, so a probe can't pass by failing for another reason. */
  rejection?: RegExp;
}

const nodeGlobal: Probe = {
  description: "a Node global",
  source: "export const processId: number = process.pid;",
  rejection: /Cannot find name 'process'/,
};
const nodeModule: Probe = {
  description: "a Node built-in module",
  source: 'import { existsSync } from "node:fs";\nexport const found: boolean = existsSync(".");',
  rejection: /'node:fs'/,
};
const domGlobal: Probe = {
  description: "a DOM global",
  source: "export const pageTitle: string = document.title;",
  rejection: /Cannot find name 'document'/,
};
const nsCalledRight: Probe = {
  description: "the NS API, called as defined",
  source:
    'import type { NS } from "@nsdefs";\nexport async function main(ns: NS): Promise<void> {\n  ns.getServer("home");\n}',
};
const nsCalledWrong: Probe = {
  description: "the NS API, called with the wrong arguments",
  source:
    'import type { NS } from "@nsdefs";\nexport async function main(ns: NS): Promise<void> {\n  ns.getServer(1, 2);\n}',
  rejection: /Expected 0-1 arguments, but got 2/,
};

interface EnvironmentExpectation {
  allowed: Probe[];
  rejected: Probe[];
}

const nodeEnvironment: EnvironmentExpectation = { allowed: [nodeGlobal, nodeModule], rejected: [domGlobal] };

const expectations: Record<string, EnvironmentExpectation> = {
  "packages/core/tsconfig.json": { allowed: [], rejected: [nodeGlobal, nodeModule, domGlobal] },
  "packages/core/test/tsconfig.json": nodeEnvironment,
  "packages/ingame/src/tsconfig.json": {
    allowed: [domGlobal, nsCalledRight],
    rejected: [nodeGlobal, nodeModule, nsCalledWrong],
  },
  "packages/ingame/tsconfig.json": nodeEnvironment,
  "packages/legacy/tsconfig.json": nodeEnvironment,
  "tools/tsconfig.json": nodeEnvironment,
  // These two configs' options are Node's, but their programs also see the DOM through what their files import:
  // @types/jsdom (the simulator's host emulates the page with jsdom; vitest.config.ts imports vitest/config, which
  // imports it). A probe imports neither, so it checks the options (CONTRIBUTING, "TypeScript configs").
  "packages/sim/tsconfig.json": nodeEnvironment,
  "tsconfig.json": nodeEnvironment,
};

/** Typechecks one probe file under a config's own options, through a probe config beside it that extends it. */
function typecheckProbe(configPath: string, source: string): { passed: boolean; output: string } {
  const probeDirectory = path.join(REPOSITORY_ROOT, path.dirname(configPath), `.typecheck-probe-${process.pid}`);
  mkdirSync(probeDirectory, { recursive: true });
  try {
    writeFileSync(path.join(probeDirectory, "probe.ts"), `${source}\n`);
    writeFileSync(
      path.join(probeDirectory, "tsconfig.json"),
      JSON.stringify({ extends: "../tsconfig.json", include: [], files: ["probe.ts"] }),
    );
    const run = runTypescriptCompiler(REPOSITORY_ROOT, ["-p", path.join(probeDirectory, "tsconfig.json")]);
    return { passed: run.exitCode === 0, output: run.standardOutput + run.standardError };
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

test("every config in the repository has an environment expectation here", () => {
  expect(findConfigPaths(REPOSITORY_ROOT).sort()).toEqual(Object.keys(expectations).sort());
});

for (const [configPath, { allowed, rejected }] of Object.entries(expectations)) {
  describe(configPath, () => {
    for (const probe of allowed) {
      test(`allows ${probe.description}`, () => {
        expect(typecheckProbe(configPath, probe.source)).toEqual({ passed: true, output: "" });
      });
    }
    for (const probe of rejected) {
      test(`rejects ${probe.description}`, () => {
        const { passed, output } = typecheckProbe(configPath, probe.source);
        if (!probe.rejection) throw new Error(`Probe "${probe.description}" has no expected rejection`);
        expect(passed).toBe(false);
        expect(output).toMatch(probe.rejection);
      });
    }
  });
}
