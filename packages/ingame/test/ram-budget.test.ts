// Every in-game script's static RAM, measured with the game's own calculator, is within its budget (architecture R4).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  freshSaveHomeWorkerFileNames,
  HACK_LOOP_RAM_BUDGET_GB,
  homeWorkerFileNames,
  singularityWorkerFileNames,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();

/** Each in-game script's RAM budget, in GB. */
const budgets = JSON.parse(readFileSync(path.join(import.meta.dirname, "../ram-budget.json"), "utf8")) as Record<
  string,
  number
>;

test("every bundle has a budget, every budget a bundle, and each bundle's RAM is within it (Singularity's in BN4)", async () => {
  const { manifest, source } = await build();
  const bundleNames = Object.keys(manifest.files).sort();
  expect(Object.keys(budgets).sort(), "ram-budget.json lists exactly the bundles").toEqual(bundleNames);

  // The Singularity workers run only with Singularity, so they're measured where it costs what SF4.3 makes it: BN4.
  const newGame = await start(NEW_GAME);
  const inBitNode4 = await start({ ...NEW_GAME, fixture: { kind: "bitnode", n: 4, sourceFiles: {} } });
  const singularityWorkers = new Set(singularityWorkerFileNames());
  const measured: Record<string, number> = {};
  for (const fileName of bundleNames) {
    const simulation = singularityWorkers.has(fileName) ? inBitNode4 : newGame;
    await simulation.writeFile("home", fileName, source(fileName));
    measured[fileName] = await simulation.staticRamUsage("home", fileName);
  }
  console.log(
    bundleNames.map((fileName) => `${fileName}: ${measured[fileName]} GB of ${budgets[fileName]} GB`).join("\n"),
  );
  for (const fileName of bundleNames) {
    expect(measured[fileName], `${fileName}'s static RAM`).toBeLessThanOrEqual(budgets[fileName] as number);
  }
});

/** What isn't a worker beside the Agent on home: the Agent, `boot.js`, and the loop, which runs on other servers. */
const NOT_HOME_WORKERS = ["agent.js", "boot.js", "hack-loop.js"];

test("the Agent's budget plus its largest fresh-save home worker's fits in a fresh save's 8 GB home", () => {
  // Every bundle is one or the other, so a new worker can't be left out of the sum (#134).
  expect([...homeWorkerFileNames(), ...NOT_HOME_WORKERS].sort()).toEqual(Object.keys(budgets).sort());
  // Not the Singularity workers (#147): a fresh save has no Singularity. The Agent uses the page for an action whose
  // Singularity worker doesn't fit home beside it (intent-runner.test.ts).
  const largestWorkerBudget = Math.max(
    ...freshSaveHomeWorkerFileNames().map((fileName) => budgets[fileName] as number),
  );
  expect((budgets["agent.js"] as number) + largestWorkerBudget).toBeLessThanOrEqual(8);
});

test("the loop's budget is core's, by which the brain counts a host's threads (#187)", () => {
  expect(budgets["hack-loop.js"]).toBe(HACK_LOOP_RAM_BUDGET_GB);
});
