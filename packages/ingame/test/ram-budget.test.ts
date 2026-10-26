// Every in-game script's static RAM, measured with the game's own calculator, is within its budget (architecture R4).
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();

/** Each in-game script's RAM budget, in GB. */
const budgets = JSON.parse(readFileSync(path.join(import.meta.dirname, "../ram-budget.json"), "utf8")) as Record<
  string,
  number
>;

test("every bundle has a budget, every budget a bundle, and each bundle's RAM is within it", async () => {
  const { manifest, source } = await build();
  const bundleNames = Object.keys(manifest.files).sort();
  expect(Object.keys(budgets).sort(), "ram-budget.json lists exactly the bundles").toEqual(bundleNames);

  const simulation = await start(NEW_GAME);
  const measured: Record<string, number> = {};
  for (const fileName of bundleNames) {
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

test("the Agent's budget plus its largest worker's fits in a fresh save's 8 GB home", () => {
  const largestWorkerBudget = Math.max(
    ...Object.entries(budgets)
      .filter(([fileName]) => fileName.startsWith("snapshot-"))
      .map(([, budget]) => budget),
  );
  expect((budgets["agent.js"] as number) + largestWorkerBudget).toBeLessThanOrEqual(8);
});
