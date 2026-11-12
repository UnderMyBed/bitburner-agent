// Every in-game script's static RAM, measured with the game's own calculator, is within its budget (architecture R4).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BATCH_GROW_RAM_GB,
  BATCH_GROW_SCRIPT_NAME,
  BATCH_HACK_RAM_GB,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_WEAKEN_RAM_GB,
  BATCH_WEAKEN_SCRIPT_NAME,
  BATCHER_RAM_BUDGET_GB,
  BATCHER_SCRIPT_NAME,
  BLADEBURNER_WORKER_NAME,
  BLADEBURNER_WORKER_RAM_GB,
  bladeburnerWorkerFileNames,
  freshSaveHomeWorkerFileNames,
  gangWorkerFileNames,
  HACK_LOOP_RAM_BUDGET_GB,
  homeWorkerFileNames,
  LEVEL_GROW_SCRIPT_NAME,
  LEVEL_LOOP_RAM_GB,
  LEVEL_LOOP_SCRIPT_NAME,
  loopSourceOf,
  SHARE_RAM_GB,
  SHARE_SCRIPT_NAME,
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

/**
 * What isn't a worker beside the Agent on home: the Agent, `boot.js`, the loop, which runs on other servers, and the
 * batcher and its operation scripts (#204) and share script (#224), whose place the Agent chooses by RAM (#205).
 */
const NOT_HOME_WORKERS = [
  "agent.js",
  "boot.js",
  "hack-loop.js",
  BATCHER_SCRIPT_NAME,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_GROW_SCRIPT_NAME,
  BATCH_WEAKEN_SCRIPT_NAME,
  SHARE_SCRIPT_NAME,
];

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

test("the Agent's budget plus its largest gang worker's fits BN2's home with SF1.3 and SF4.3, as the campaign enters it (#325)", async () => {
  // The gang's workers run only where a gang can be formed: BN2 in the campaign, which comes to it with SF1.3 and
  // SF4.3 (docs/synthesis.md §3). The NS gang API costs the same with or without Singularity.
  const inBitNode2 = await start({ ...NEW_GAME, fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3, 4: 3 } } });
  const homeGb = (await inBitNode2.summary()).homeRamMax;
  const largestGangWorkerBudget = Math.max(...gangWorkerFileNames().map((fileName) => budgets[fileName] as number));
  expect(largestGangWorkerBudget).toBe(budgets["gang.js"]);
  expect((budgets["agent.js"] as number) + largestGangWorkerBudget).toBeLessThanOrEqual(homeGb);
  expect(homeGb).toBe(32);
});

test("the Agent's budget plus its largest Bladeburner worker's fits BN6's home as the campaign enters it (#367); the reading's is core's", async () => {
  // Bladeburner's workers run only in BN6 and BN7 for now, which the campaign comes to with SF1.3 (a 32 GB home,
  // `Prestige.ts:246-251`), SF2.3, SF4.3 and SF5.1 (docs/synthesis.md §3). The brain runs the reading worker only once
  // home's RAM beyond what it keeps holds core's figure for it, so that figure is the worker's.
  const inBitNode6 = await start({
    ...NEW_GAME,
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 2: 3, 4: 3, 5: 1 } },
  });
  const homeGb = (await inBitNode6.summary()).homeRamMax;
  const largest = Math.max(...bladeburnerWorkerFileNames().map((fileName) => budgets[fileName] as number));
  expect((budgets["agent.js"] as number) + largest).toBeLessThanOrEqual(homeGb);
  expect(homeGb).toBe(32);
  expect(budgets[BLADEBURNER_WORKER_NAME]).toBe(BLADEBURNER_WORKER_RAM_GB);
});

test("the loop's budget is core's, by which the brain counts a host's threads (#187)", () => {
  expect(budgets["hack-loop.js"]).toBe(HACK_LOOP_RAM_BUDGET_GB);
});

test("levelling mode's loops (#336) aren't bundles, and cost core's budget, by which the brain counts their threads", async () => {
  // Each bundle adds its push and RAM check to every deploy, so outside levelling the deploy would differ from the one
  // before levelling (#339): the deploy worker writes a loop's source to home when levelling is sent, and only then.
  const { manifest } = await build();
  expect(Object.keys(manifest.files)).not.toContain(LEVEL_LOOP_SCRIPT_NAME);
  expect(Object.keys(manifest.files)).not.toContain(LEVEL_GROW_SCRIPT_NAME);
  const simulation = await start(NEW_GAME);
  for (const [fileName, operation] of [
    [LEVEL_LOOP_SCRIPT_NAME, "weaken"],
    [LEVEL_GROW_SCRIPT_NAME, "grow"],
  ] as const) {
    const source = loopSourceOf({ target: "joesguns", hackThreads: null, levelling: { homeKeptGb: 32, operation } });
    await simulation.writeFile("home", fileName, source as string);
    expect(await simulation.staticRamUsage("home", fileName), fileName).toBe(LEVEL_LOOP_RAM_GB);
  }
});

test("the batch operation scripts' budgets are core's, by which the batcher and its plan count threads (#204)", () => {
  expect(budgets[BATCH_HACK_SCRIPT_NAME]).toBe(BATCH_HACK_RAM_GB);
  expect(budgets[BATCH_GROW_SCRIPT_NAME]).toBe(BATCH_GROW_RAM_GB);
  expect(budgets[BATCH_WEAKEN_SCRIPT_NAME]).toBe(BATCH_WEAKEN_RAM_GB);
  // The share script's (#224), by which a round counts its threads.
  expect(budgets[SHARE_SCRIPT_NAME]).toBe(SHARE_RAM_GB);
  // And the batcher's own, by which the brain plans where it runs (#205).
  expect(budgets[BATCHER_SCRIPT_NAME]).toBe(BATCHER_RAM_BUDGET_GB);
});
