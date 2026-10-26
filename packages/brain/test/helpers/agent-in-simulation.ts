// A real Agent, built from packages/ingame, in a simulation, with a brain's ControlChannel on the lockstep driver.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Connection, ControlChannel, type ControlChannelEvent } from "@bitburner-agent/bridge";
import {
  AGENT_CONFIG_FILE_NAME,
  AGENT_SCRIPT_NAME,
  BOOT_SCRIPT,
  CURRENT_DEPLOYMENT_FILE,
  deployedFilePath,
  SNAPSHOT_TIERS,
  snapshotWorkerFileName,
  TOKEN_FILE_NAME,
} from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation, SimulationOptions } from "@bitburner-agent/sim";
import { afterAll } from "vitest";
import { SimulatedGame } from "../../src/simulated-game.ts";

export const CONTROL_PORT = 12526;
export const CONTROL_URL = `ws://127.0.0.1:${CONTROL_PORT}`;
export const TOKEN = "b".repeat(64);
export const EPOCH_MS = Date.UTC(2026, 0, 1);

/** Builds the in-game bundles once for a test file; returns a function giving a bundle's source. */
export function useBuiltBundles(): () => Promise<(fileName: string) => string> {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "agent-build-"));
  afterAll(() => rmSync(outputDirectory, { recursive: true, force: true }));
  let built: Promise<(fileName: string) => string> | undefined;
  return () => {
    built ??= buildInGameBundles({ outputDirectory }).then(
      () => (fileName: string) => readFileSync(path.join(outputDirectory, fileName), "utf8"),
    );
    return built;
  };
}

/** Writes a deployment into the simulation as the deployer would (#91): its scripts (the Agent and its snapshot
 * workers), config and token. */
export async function writeDeployment(
  simulation: Simulation,
  bundleSource: (fileName: string) => string,
  deploymentId: string,
  { token = TOKEN, makeCurrent = true }: { token?: string; makeCurrent?: boolean } = {},
): Promise<void> {
  await simulation.writeFile("home", BOOT_SCRIPT, bundleSource("boot.js"));
  for (const fileName of [AGENT_SCRIPT_NAME, ...SNAPSHOT_TIERS.map(snapshotWorkerFileName)]) {
    await simulation.writeFile("home", deployedFilePath(deploymentId, fileName), bundleSource(fileName));
  }
  await simulation.writeFile(
    "home",
    deployedFilePath(deploymentId, AGENT_CONFIG_FILE_NAME),
    JSON.stringify({ deploymentId, controlPort: CONTROL_PORT }),
  );
  await simulation.writeFile("home", deployedFilePath(deploymentId, TOKEN_FILE_NAME), token);
  if (makeCurrent) await simulation.writeFile("home", CURRENT_DEPLOYMENT_FILE, deploymentId);
}

export interface BrainOnSimulation {
  game: SimulatedGame;
  channel: ControlChannel;
  /** Every channel event, in order. */
  events: ControlChannelEvent[];
  /** Every connection the page opened, in order: tests can close one from the brain's side. */
  connections: Connection[];
  /** Steps until `condition` holds, failing after `maxVirtualMs`. */
  runUntil(condition: () => boolean, maxVirtualMs: number): Promise<void>;
}

/** A brain's ControlChannel on the lockstep driver, listening where the Agent connects. */
export async function attachBrain(
  simulation: Simulation,
  { token = TOKEN, stepMs = 100 }: { token?: string; stepMs?: number } = {},
): Promise<BrainOnSimulation> {
  const game = await SimulatedGame.create({ simulation, stepMs });
  const channel = new ControlChannel({ token, clock: game.clock });
  const events: ControlChannelEvent[] = [];
  const connections: Connection[] = [];
  channel.subscribe((event) => events.push(event));
  game.listen(CONTROL_URL, (connection) => {
    connections.push(connection);
    channel.accept(connection);
  });
  return {
    game,
    channel,
    events,
    connections,
    runUntil: async (condition, maxVirtualMs) => {
      for (let elapsedMs = 0; !condition(); elapsedMs += stepMs) {
        if (elapsedMs > maxVirtualMs) throw new Error(`condition not met within ${maxVirtualMs} virtual ms`);
        await game.step();
      }
    },
  };
}

export const NEW_GAME_WITH_NETWORK: SimulationOptions = {
  seed: 1,
  epochMs: EPOCH_MS,
  fixture: { kind: "new", tutorial: "skipped" },
  network: { listenUrls: [CONTROL_URL] },
};
