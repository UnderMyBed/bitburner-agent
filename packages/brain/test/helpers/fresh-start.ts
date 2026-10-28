// A game in the simulator with the brain and the built Agent in it, as the suites for the Agent's actions start from
// (#134, #145): the brain deploys, the owner's own setup runs (`beforeAgent`), then the Agent starts and connects.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";
import {
  AGENT_SIM_EFFECTORS_GLOBAL,
  BOOT_SCRIPT,
  type FastSnapshotData,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation, SimulationOptions } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import type { DesiredStateController } from "../../src/desired-state.ts";
import { readInGameBuild } from "../../src/in-game-build.ts";
import { SimulatedGame } from "../../src/simulated-game.ts";
import { TelemetryStore } from "../../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, RFA_URL, startBrainInSimulation } from "./brain-in-simulation.ts";

const STEP_MS = 200;

export interface FreshGame {
  simulation: Simulation;
  game: SimulatedGame;
}

/**
 * Runs `source` once on home: the owner's own setup, as they'd type it. Steps a second, so it has run and exited.
 * Calls that cost RAM go here, before the Agent starts.
 */
export async function ownerRunsOnHome(fresh: FreshGame, source: string) {
  await fresh.simulation.writeFile("home", "owner-setup.js", source);
  expect((await fresh.simulation.run("home", "owner-setup.js")).error).toBeUndefined();
  await fresh.game.run(1_000);
}

/**
 * The owner's setup that takes the simulator's own effectors away (#145), so the Agent uses its workers as in a
 * browser: the page's (`ui`), or Singularity's where the game has it.
 */
export const withoutSimEffectors = (fresh: FreshGame) =>
  ownerRunsOnHome(fresh, `export async function main(ns) { delete globalThis.${AGENT_SIM_EFFECTORS_GLOBAL}; }`);

/**
 * Registers the test file's hooks (the build, once; a temporary directory; the stores, closed after each test) and
 * returns the fresh start: an 8 GB new game unless `fixture` says otherwise, with the brain, deployed, `beforeAgent`
 * run, then the Agent. With `withDesiredState`, the brain has its desired state controller, as `main.ts` does.
 */
export function useFreshStarts() {
  const start = useSimulations();
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "fresh-start-"));
  afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  let build: InGameBuild;
  beforeAll(async () => {
    await buildInGameBundles({ outputDirectory: path.join(temporaryDirectory, "build") });
    build = readInGameBuild(path.join(temporaryDirectory, "build"));
  });
  const openStores: TelemetryStore[] = [];
  afterEach(() => {
    for (const store of openStores.splice(0)) store.close();
  });
  let storeCount = 0;

  return async function freshStart({
    withDesiredState,
    beforeAgent = async () => {},
    fixture = { kind: "new", tutorial: "skipped" },
  }: {
    withDesiredState: boolean;
    beforeAgent?: (fresh: FreshGame) => Promise<void>;
    fixture?: SimulationOptions["fixture"];
  }) {
    const simulation = await start({
      seed: 1,
      epochMs: EPOCH_MS,
      fixture,
      network: { listenUrls: [CONTROL_URL, RFA_URL] },
      gameSettings: { ...BRAIN_RFA_SETTINGS, AutoexecScript: BOOT_SCRIPT },
    });
    const game = await SimulatedGame.create({ simulation, stepMs: STEP_MS });
    const dataDirectory = path.join(temporaryDirectory, `data-${++storeCount}`);
    mkdirSync(dataDirectory);
    const store = TelemetryStore.open(path.join(dataDirectory, "telemetry.sqlite"));
    openStores.push(store);
    const data = { store, brainRelease: "fresh-start-test", dataDirectory };
    const brain = startBrainInSimulation(game, { build, data, withDesiredState });
    // A request and its reply cross one step each way, so the deploy's requests take longer at this step size.
    await game.runUntil(() => brain.deployerEvents.length > 0, 30_000);
    expect(brain.deployerEvents).toEqual([expect.objectContaining({ type: "deployed" })]);
    await beforeAgent({ simulation, game });
    expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
    await game.runUntil(() => brain.channelEvents.some((event) => event.type === "agentConnected"), 10_000);
    const latest = <Data>(tier: string) =>
      (store.latestSnapshot({ environment: "E1", tier })?.data as Data | undefined) ?? null;
    return {
      simulation,
      game,
      brain,
      data,
      /** The in-game build the brain deploys: for another brain started on the same game. */
      build,
      deploymentId: brain.deployer.deploymentId,
      latest,
      money: () => latest<FastSnapshotData>("fast")?.game?.money ?? null,
      medium: () => latest<MediumSnapshotData>("medium"),
      /** The brain's desired state controller; fails at once if the brain has none. */
      controller: (): DesiredStateController => {
        if (!brain.desiredState) throw new Error("this brain has no desired state controller");
        return brain.desiredState;
      },
    };
  };
}
