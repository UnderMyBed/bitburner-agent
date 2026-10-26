// Every in-game script's static RAM, measured with the game's own calculator, is within its budget (architecture R4).
import { expect, test } from "vitest";
import { readRamBudgets } from "../scripts/bundles.ts";
import { NEW_GAME, useInGameBuild, useSimulations } from "./helpers/simulation.ts";

const start = useSimulations();
const build = useInGameBuild();

test("every bundle has a budget, every budget a bundle, and each bundle's RAM is within it", async () => {
  const { manifest, source } = await build();
  const budgets = readRamBudgets();
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
