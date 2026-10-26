// Deploying (#91) against the game's own Remote File API code, in the simulator, on the lockstep driver: the game
// connects, the brain deploys, a one-time `run agent/boot.js` brings the Agent up, and a new build replaces it with no
// human step. The RAM checks use the game's own calculator.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";
import { BOOT_SCRIPT, CURRENT_DEPLOYMENT_FILE, deployedFilePath } from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readInGameBuild, readPinnedDefinitions } from "../src/in-game-build.ts";
import { SimulatedGame } from "../src/simulated-game.ts";
import { CONTROL_URL, EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import {
  BRAIN_RFA_SETTINGS,
  type BrainInSimulation,
  RFA_RECONNECT_SECONDS,
  RFA_URL,
  startBrainInSimulation,
} from "./helpers/brain-in-simulation.ts";

const start = useSimulations();
const buildDirectory = mkdtempSync(path.join(os.tmpdir(), "deploy-build-"));
afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));
let build: InGameBuild;
beforeAll(async () => {
  await buildInGameBundles({ outputDirectory: buildDirectory });
  build = readInGameBuild(buildDirectory);
});

/** The same build with one line added to agent.js: a new deployment, with the RAM the game measures for it. */
function withAgentLine(line: string): InGameBuild {
  return { ...build, scripts: { ...build.scripts, "agent.js": `${build.scripts["agent.js"]}\n${line}\n` } };
}

async function brainAndGame() {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL, RFA_URL] },
    gameSettings: BRAIN_RFA_SETTINGS,
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const brains: BrainInSimulation[] = [];
  /**
   * Starts a brain built from `build`, with its token. A brain already running stops first, closing its connections,
   * so the game reconnects.
   */
  const startBrain = (options: { build?: InGameBuild; token?: string; pinnedDefinitions?: string } = {}) => {
    brains.at(-1)?.closeConnections();
    const brain = startBrainInSimulation(game, { build, ...options });
    brains.push(brain);
    return brain.deployer;
  };
  /** Every brain's events, oldest brain first. */
  const channelEvents = () => brains.flatMap((brain) => brain.channelEvents);
  const deployerEvents = () => brains.flatMap((brain) => brain.deployerEvents);
  const runUntil = (condition: () => boolean, maxVirtualMs: number) => game.runUntil(condition, maxVirtualMs);
  const agentsConnected = () => channelEvents().filter((event) => event.type === "agentConnected");
  return { simulation, game, channelEvents, deployerEvents, agentsConnected, startBrain, runUntil };
}

/** A file's content on home, read by a script in the game (the simulation has no file reader), or null if absent. */
async function readOnHome(simulation: Simulation, game: SimulatedGame, fileName: string): Promise<string | null> {
  await simulation.writeFile(
    "home",
    "read-probe.js",
    `export async function main(ns) { ns.print(JSON.stringify(ns.fileExists(${JSON.stringify(fileName)}) ? ns.read(${JSON.stringify(fileName)}) : null)); }`,
  );
  const { pid } = await simulation.run("home", "read-probe.js");
  await game.step();
  const printed = (await simulation.logs(pid)).find((line) => line.startsWith('"') || line === "null");
  return JSON.parse(printed as string) as string | null;
}

const runningFiles = async (simulation: Simulation) =>
  (await simulation.ps("home")).map((process) => process.filename).filter((name) => name !== "read-probe.js");
/** Long enough for the game to reconnect its RFA, the deploy to finish, and the Agent to hand over. */
const AFTER_A_BRAIN_RESTART_MS = RFA_RECONNECT_SECONDS * 1_000 + 30_000;

/** A game with the brain's first deployment, and its Agent started by the one-time `run agent/boot.js`. */
async function gameWithAgent() {
  const brainOnGame = await brainAndGame();
  const deployer = brainOnGame.startBrain();
  await brainOnGame.runUntil(() => brainOnGame.deployerEvents().length === 1, 10_000);
  expect((await brainOnGame.simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await brainOnGame.runUntil(() => brainOnGame.agentsConnected().length === 1, 10_000);
  return { ...brainOnGame, deployer };
}

test("the game connects, the brain deploys, and a one-time run of boot.js brings the Agent up, welcomed", async () => {
  const { simulation, game, deployerEvents, agentsConnected, deployer } = await gameWithAgent();
  expect(deployerEvents()).toEqual([
    expect.objectContaining({ type: "deployed", deploymentId: deployer.deploymentId }),
  ]);
  expect(await readOnHome(simulation, game, CURRENT_DEPLOYMENT_FILE)).toBe(deployer.deploymentId);
  expect(await readOnHome(simulation, game, deployedFilePath(deployer.deploymentId, "snapshot-medium.js"))).toBe(
    build.scripts["snapshot-medium.js"],
  );
  expect(agentsConnected().at(-1)).toMatchObject({ deploymentId: deployer.deploymentId });
  // Welcomed, not told to restart: it's still running, and still the only Agent, a while later.
  await game.run(5_000);
  expect(agentsConnected()).toHaveLength(1);
  expect(await runningFiles(simulation)).toEqual([deployedFilePath(deployer.deploymentId, "agent.js")]);
});

test("a brain with a new build replaces the running Agent through restart and boot.js, with no human step", async () => {
  const { simulation, deployerEvents, agentsConnected, startBrain, runUntil } = await gameWithAgent();
  // Its agent.js also references getServerMaxRam (0.05 GB), which the game measures at the new path: 2.75 GB.
  const newDeployer = startBrain({ build: withAgentLine("function measured(ns) { return ns.getServerMaxRam; }") });
  await runUntil(() => agentsConnected().at(-1)?.deploymentId === newDeployer.deploymentId, AFTER_A_BRAIN_RESTART_MS);
  expect(deployerEvents().at(-1)).toMatchObject({ type: "deployed", deploymentId: newDeployer.deploymentId });
  expect(await simulation.staticRamUsage("home", deployedFilePath(newDeployer.deploymentId, "agent.js"))).toBe(2.75);
  expect(await runningFiles(simulation)).toEqual([deployedFilePath(newDeployer.deploymentId, "agent.js")]);
});

test("a brain with a new token: the old Agent is refused (4003), finds the new deployment, and hands over", async () => {
  const { simulation, channelEvents, agentsConnected, startBrain, runUntil } = await gameWithAgent();
  const newDeployer = startBrain({ token: "c".repeat(64) });
  await runUntil(() => agentsConnected().at(-1)?.deploymentId === newDeployer.deploymentId, AFTER_A_BRAIN_RESTART_MS);
  expect(channelEvents().some((event) => event.type === "connectionRejected" && event.reason === "wrongToken")).toBe(
    true,
  );
  expect(await runningFiles(simulation)).toEqual([deployedFilePath(newDeployer.deploymentId, "agent.js")]);
});

test("a build the game measures over its RAM budget isn't switched to, and the running Agent stays", async () => {
  const { simulation, game, deployerEvents, agentsConnected, deployer, startBrain, runUntil } = await gameWithAgent();
  // getServer costs 2.0 GB: agent.js would need 4.7 GB, over its 3.0 GB budget.
  startBrain({ build: withAgentLine("function tooCostly(ns) { return ns.getServer; }") });
  await runUntil(() => deployerEvents().length === 2, AFTER_A_BRAIN_RESTART_MS);
  expect(deployerEvents()[1]).toMatchObject({
    type: "deployFailed",
    reason: "agent.js needs 4.7 GB, over its budget of 3 GB",
  });
  await game.run(5_000);
  expect(await readOnHome(simulation, game, CURRENT_DEPLOYMENT_FILE)).toBe(deployer.deploymentId);
  expect(agentsConnected().every((event) => event.deploymentId === deployer.deploymentId)).toBe(true);
  expect(await runningFiles(simulation)).toEqual([deployedFilePath(deployer.deploymentId, "agent.js")]);
});

test("a game whose definition file isn't the brain's pinned one holds it: nothing is deployed", async () => {
  const { simulation, game, deployerEvents, startBrain, runUntil } = await brainAndGame();
  startBrain({ pinnedDefinitions: `${readPinnedDefinitions()}\n// a line the game doesn't have\n` });
  await runUntil(() => deployerEvents().length > 0, 10_000);
  expect(deployerEvents()).toEqual([expect.objectContaining({ type: "versionDrift" })]);
  expect(await readOnHome(simulation, game, CURRENT_DEPLOYMENT_FILE)).toBeNull();
});
