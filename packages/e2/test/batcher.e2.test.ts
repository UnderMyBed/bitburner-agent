// The batcher on the real page (#205): a simulator-made save (hacking 50, the no-port servers rooted, the batcher and
// its operation scripts on home), its config written to its port as the Agent writes it, and the batcher started with
// no argument, as `batcher-deploy.js` starts it. The page's game time moves in 200 ms steps, at most 20 times real time
// (packages/e2 README, "Game time"), and script imports run in real time between steps: so on this page, unlike the
// simulator's, an operation's start lags its `exec` by real time, which can be whole steps of game time. The batcher
// prepares n00dles, then batches; every landing must come in order, and any late operation, lost record or desync is
// printed, and fails the test.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATCHER_CONFIG_PORT,
  BATCHER_HEALTH_PORT,
  BATCHER_SCRIPT_NAME,
  type BatcherConfig,
  type BatcherHealth,
  batchPlan,
  batchRamGb,
} from "@bitburner-agent/core";
// The in-game build, as the brain (this package's dependency) builds it.
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Page } from "playwright";
import { afterAll, expect, test } from "vitest";
import { advanceGameTime, closeGame, gameFromSave, terminalText, typeCommand } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave } from "./helpers/saves.ts";

const e2 = useE2();
const buildDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-batcher-"));
afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

const FOLDER = "agent/e2-batcher/";
/** The no-port servers, rooted in the save: the batcher's hosts, with their RAM (servers.ts). */
const HOSTS: [string, number][] = [
  ["foodnstuff", 16],
  ["sigma-cosmetics", 16],
  ["joesguns", 16],
  ["harakiri-sushi", 16],
  ["nectar-net", 16],
  ["hong-fang-tea", 16],
  ["n00dles", 4],
];
const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
/** Game time to prepare n00dles and start batching (1.8 min in the simulator), then to batch for. */
const BATCHING_WITHIN_MS = 6 * 60_000;
const BATCHING_FOR_MS = 8 * 60_000;
/** How often the test reads the batcher's health, in game time. */
const LOOK_EVERY_MS = 20_000;

/** Writes the config (a file in the save) to the batcher's port, as the Agent does, and starts the batcher. */
const START = `export async function main(ns) {
  ns.clearPort(${BATCHER_CONFIG_PORT});
  ns.writePort(${BATCHER_CONFIG_PORT}, JSON.parse(ns.read("batcher-config.txt")));
  ns.run("${FOLDER}${BATCHER_SCRIPT_NAME}");
}`;
/** Prints the batcher's health from its port, as the Agent reads it. */
const HEALTH = `export async function main(ns) { ns.tprint("BATCHER-HEALTH " + JSON.stringify(ns.peek(${BATCHER_HEALTH_PORT}))); }`;

/** The batcher's health, as a script on the page prints it. */
async function healthOn(page: Page): Promise<BatcherHealth | null> {
  const before = (await terminalText(page)).split("BATCHER-HEALTH ").length;
  await typeCommand(page, "run batcher-health.js");
  for (let tries = 0; ; tries += 1) {
    await advanceGameTime(page, 200);
    const pieces = (await terminalText(page)).split("BATCHER-HEALTH ");
    if (pieces.length > before) {
      const printed = (pieces.at(-1) as string).split("\n")[0] as string;
      const health = JSON.parse(printed) as BatcherHealth | string;
      return typeof health === "object" ? health : null;
    }
    if (tries > 50) throw new Error("batcher-health.js printed nothing in 10 s of game time");
  }
}

test("the batcher on the real page, started as the Agent starts it: prepares n00dles, then batches in step", {
  timeout: 600_000,
}, async () => {
  await buildInGameBundles({ outputDirectory: buildDirectory });
  const source = (name: string) => readFileSync(path.join(buildDirectory, name), "utf8");
  const plan = batchPlan(
    N00DLES,
    { skills: { hacking: 50, intelligence: 0 }, mults: MULTS },
    batchRamGb(HOSTS.map(([, ram]) => ram)),
  );
  if (plan === null) throw new Error("no plan for n00dles");
  const config: BatcherConfig = {
    target: "n00dles",
    figures: N00DLES,
    player: { intelligence: 0, mults: MULTS },
    hosts: HOSTS.map(([host]) => host),
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
  };
  const save = await simulatorSave({
    prepare: async (sim) => {
      await sim.diagnostics.gainHackingExp(2_000);
      for (const name of [
        BATCHER_SCRIPT_NAME,
        "batch-hack.js",
        "batch-grow.js",
        "batch-weaken.js",
        "hack-loop-root.js",
      ]) {
        await sim.writeFile("home", FOLDER + name, source(name));
      }
      await sim.writeFile("home", "start-batcher.js", START);
      await sim.writeFile("home", "batcher-health.js", HEALTH);
      await sim.writeFile("home", "batcher-config.txt", JSON.stringify(config));
      expect((await sim.run("home", `${FOLDER}hack-loop-root.js`)).error).toBeUndefined();
      await sim.advance(1_000);
    },
  });
  const page = await gameFromSave(e2.browser, e2.server, save);
  try {
    await typeCommand(page, "run start-batcher.js");
    const looks: BatcherHealth[] = [];
    let batchingAtMs: number | null = null;
    for (let gameMs = 0; gameMs < (batchingAtMs ?? BATCHING_WITHIN_MS) + BATCHING_FOR_MS; gameMs += LOOK_EVERY_MS) {
      await advanceGameTime(page, LOOK_EVERY_MS);
      const health = await healthOn(page);
      if (health === null) continue;
      looks.push(health);
      if (batchingAtMs === null && health.state === "batching") batchingAtMs = gameMs;
      if (batchingAtMs === null && gameMs > BATCHING_WITHIN_MS) break;
    }
    const last = looks.at(-1);
    console.log(
      `E2 batcher: batching ${batchingAtMs === null ? "never" : `${(batchingAtMs / 60_000).toFixed(1)} min in`}; ` +
        `the last health: ${JSON.stringify(last)}`,
    );
    expect(batchingAtMs, "batching within 6 minutes of game time").not.toBeNull();
    expect(last).toMatchObject({ state: "batching", problem: null });
    expect(last?.hacksLanded).toBeGreaterThan(5);
    // On real script starts: nothing late, lost or out of order, and no desync.
    expect(last).toMatchObject({ outOfOrder: 0, late: 0, lost: 0, outOfBounds: 0, desyncs: 0, batchesShort: 0 });
  } finally {
    await closeGame(page);
  }
});
