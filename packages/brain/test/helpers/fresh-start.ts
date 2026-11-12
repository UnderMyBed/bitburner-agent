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
import { type InstallTimingPolicy, writeAugmentationsEnabled } from "../../src/augmentations.ts";
import { BATCHER_ENABLED_SETTING } from "../../src/batcher.ts";
import type { DesiredStateController } from "../../src/desired-state.ts";
import { readInGameBuild } from "../../src/in-game-build.ts";
import { SimulatedGame } from "../../src/simulated-game.ts";
import { TelemetryStore } from "../../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, DEPLOY_WITHIN_MS, RFA_URL, startBrainInSimulation } from "./brain-in-simulation.ts";

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
    seed = 1,
    batcher = true,
    augmentations = true,
    installTiming = "planner",
    fixedAgentStart = false,
  }: {
    withDesiredState: boolean;
    beforeAgent?: (fresh: FreshGame) => Promise<void>;
    fixture?: SimulationOptions["fixture"];
    /** The simulation's seed: 1 unless a test runs several (#184). */
    seed?: number;
    /**
     * The batcher's switch, as the owner left it: on by default since #206; off for the suites about the hack loop,
     * which it would otherwise replace on the hosts.
     */
    batcher?: boolean;
    /**
     * The Augmentations switch (A6, #210), as the owner left it: on by default; off for a suite about something an
     * install chosen would hold every dollar from (#334: a gang's faction's reputation buys augmentations).
     */
    augmentations?: boolean;
    /** Who times installs short of Daedalus's count (#343): the planner, as on Steam; the count rule for an A/B. */
    installTiming?: InstallTimingPolicy;
    /**
     * The Agent's start independent of the deploy's length (#341's second item): each bundle the deployer pushes and
     * RAM-checks is a lockstep step before the Agent starts (`packages/bridge/src/deployer.ts:156-161`), so a bundle
     * added moves the Agent's start, and with it the seeded game's draws and its boot-anchored timers. With this, the
     * Agent starts at a fixed virtual time, `DEPLOY_WITHIN_MS` after the page's boot (the deploy's own bound, so it's
     * always done by then), and the seeded random streams start again from `seed` at its first connection. Off by
     * default: every other suite's figures stay as measured.
     */
    fixedAgentStart?: boolean;
  }) {
    const simulation = await start({
      seed,
      epochMs: EPOCH_MS,
      fixture,
      network: { listenUrls: [CONTROL_URL, RFA_URL] },
      gameSettings: { ...BRAIN_RFA_SETTINGS, AutoexecScript: BOOT_SCRIPT },
    });
    const game = await SimulatedGame.create({ simulation, stepMs: STEP_MS });
    const bootMs = game.clock.now();
    const dataDirectory = path.join(temporaryDirectory, `data-${++storeCount}`);
    mkdirSync(dataDirectory);
    const store = TelemetryStore.open(path.join(dataDirectory, "telemetry.sqlite"));
    openStores.push(store);
    if (!batcher) store.setSetting(BATCHER_ENABLED_SETTING, "false");
    if (!augmentations) writeAugmentationsEnabled(store, false);
    const data = { store, brainRelease: "fresh-start-test", dataDirectory };
    const brain = startBrainInSimulation(game, { build, data, withDesiredState, installTiming });
    await game.runUntil(() => brain.deployerEvents.length > 0, DEPLOY_WITHIN_MS);
    expect(brain.deployerEvents).toEqual([expect.objectContaining({ type: "deployed" })]);
    await beforeAgent({ simulation, game });
    if (fixedAgentStart) {
      const waitMs = bootMs + DEPLOY_WITHIN_MS - game.clock.now();
      expect(waitMs, "the deploy and the owner's setup done by the fixed start").toBeGreaterThan(0);
      await game.run(waitMs);
    }
    expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
    await game.runUntil(() => brain.channelEvents.some((event) => event.type === "agentConnected"), 10_000);
    if (fixedAgentStart) await simulation.diagnostics.reseedRandom(seed);
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
      /**
       * The game reloaded now (#164): its sockets close, and autoexec brings the Agent back. From `save`, or by default
       * from a save taken now, as a save-then-reload does (Options' "Force kill all active scripts"). A plain reload
       * loads the last save instead, often older (the autosave runs every 60 s): pass that save's bytes. Returns the
       * reloaded simulation, which the steps drive from here on (`simulation` above is the old page's).
       */
      reload: async (save?: Uint8Array): Promise<Simulation> => {
        const reloaded = await start({
          seed,
          fixture: { kind: "save", bytes: save ?? (await simulation.save()) },
          network: { listenUrls: [CONTROL_URL, RFA_URL] },
        });
        game.replaceSimulation(reloaded);
        return reloaded;
      },
      /** The brain's desired state controller; fails at once if the brain has none. */
      controller: (): DesiredStateController => {
        if (!brain.desiredState) throw new Error("this brain has no desired state controller");
        return brain.desiredState;
      },
    };
  };
}
