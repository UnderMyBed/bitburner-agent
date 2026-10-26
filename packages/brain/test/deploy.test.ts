// Deploying (#91) against the game's own Remote File API code, in the simulator, on the lockstep driver: the game
// connects, the brain deploys, a one-time `run agent/boot.js` brings the Agent up, and a new build replaces it with no
// human step. The RAM checks use the game's own calculator.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Connection,
  ControlChannel,
  type ControlChannelEvent,
  Deployer,
  type DeployerEvent,
  type InGameBuild,
} from "@bitburner-agent/bridge";
import { BOOT_SCRIPT, CURRENT_DEPLOYMENT_FILE, deployedFilePath } from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readInGameBuild, readPinnedDefinitions } from "../src/in-game-build.ts";
import { SimulatedGame } from "../src/simulated-game.ts";
import { CONTROL_PORT, CONTROL_URL, EPOCH_MS, TOKEN } from "./helpers/agent-in-simulation.ts";

const RFA_PORT = 12525;
const RFA_URL = `ws://127.0.0.1:${RFA_PORT}`;
/** The game retries a dropped RFA connection after this many seconds (its own setting). */
const RFA_RECONNECT_SECONDS = 2;

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
    gameSettings: {
      RemoteFileApiAddress: "127.0.0.1",
      RemoteFileApiPort: RFA_PORT,
      RemoteFileApiReconnectionDelay: RFA_RECONNECT_SECONDS,
    },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const channel = new ControlChannel({ token: TOKEN, clock: game.clock });
  const channelEvents: ControlChannelEvent[] = [];
  channel.subscribe((event) => channelEvents.push(event));
  game.listen(CONTROL_URL, (connection) => channel.accept(connection));
  const deployerEvents: DeployerEvent[] = [];
  const rfaConnections: Connection[] = [];
  /** Deploys `deployedBuild` over the game's next RFA connection, as a brain built from it would. */
  const deployOnNextConnection = (deployedBuild: InGameBuild) => {
    const deployer = new Deployer({
      build: deployedBuild,
      controlPort: CONTROL_PORT,
      token: TOKEN,
      pinnedDefinitions: readPinnedDefinitions(),
      channel,
      clock: game.clock,
    });
    deployer.subscribe((event) => deployerEvents.push(event));
    game.listen(RFA_URL, (connection) => {
      rfaConnections.push(connection);
      void deployer.accept(connection);
    });
    return deployer;
  };
  const runUntil = async (condition: () => boolean, maxVirtualMs: number) => {
    for (let elapsedMs = 0; !condition(); elapsedMs += 100) {
      if (elapsedMs > maxVirtualMs) throw new Error(`condition not met within ${maxVirtualMs} virtual ms`);
      await game.step();
    }
  };
  return { simulation, game, channelEvents, deployerEvents, rfaConnections, deployOnNextConnection, runUntil };
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

test("the game connects, the brain deploys, and a one-time run of boot.js brings the Agent up, welcomed", async () => {
  const { simulation, game, channelEvents, deployerEvents, deployOnNextConnection, runUntil } = await brainAndGame();
  const deployer = deployOnNextConnection(build);
  await runUntil(() => deployerEvents.length > 0, 10_000);
  expect(deployerEvents).toEqual([expect.objectContaining({ type: "deployed", deploymentId: deployer.deploymentId })]);
  expect(await readOnHome(simulation, game, CURRENT_DEPLOYMENT_FILE)).toBe(deployer.deploymentId);
  expect(await readOnHome(simulation, game, deployedFilePath(deployer.deploymentId, "snapshot-medium.js"))).toBe(
    build.scripts["snapshot-medium.js"],
  );

  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await runUntil(() => channelEvents.some((event) => event.type === "agentConnected"), 10_000);
  expect(channelEvents.find((event) => event.type === "agentConnected")).toMatchObject({
    deploymentId: deployer.deploymentId,
  });
});

test("a new build replaces the running Agent through restart and boot.js, with the game measuring its RAM", async () => {
  const { simulation, channelEvents, deployerEvents, rfaConnections, deployOnNextConnection, runUntil } =
    await brainAndGame();
  deployOnNextConnection(build);
  await runUntil(() => deployerEvents.length === 1, 10_000);
  await simulation.run("home", BOOT_SCRIPT);
  await runUntil(() => channelEvents.some((event) => event.type === "agentConnected"), 10_000);

  // The brain restarts with a new build, whose agent.js references getServerMaxRam (0.05 GB): the game measures the
  // new file, not a cached figure for the old one (game issue #2907 can't reach new paths).
  const newBuild = withAgentLine("function measured(ns) { return ns.getServerMaxRam; }");
  const newDeployer = deployOnNextConnection(newBuild);
  rfaConnections.at(-1)?.close(1001, "brain restarting");
  await runUntil(
    () => channelEvents.filter((event) => event.type === "agentConnected").length === 2,
    RFA_RECONNECT_SECONDS * 1_000 + 20_000,
  );
  expect(deployerEvents.at(-1)).toMatchObject({ type: "deployed", deploymentId: newDeployer.deploymentId });
  expect(channelEvents.filter((event) => event.type === "agentConnected").at(-1)).toMatchObject({
    deploymentId: newDeployer.deploymentId,
  });
  expect(await simulation.staticRamUsage("home", deployedFilePath(newDeployer.deploymentId, "agent.js"))).toBe(2.75);
  expect((await simulation.ps("home")).map((process) => process.filename)).toEqual([
    deployedFilePath(newDeployer.deploymentId, "agent.js"),
  ]);
});

test("a build over its RAM budget by the game's own measure isn't switched to, and the Agent isn't restarted", async () => {
  const { simulation, game, channelEvents, deployerEvents, rfaConnections, deployOnNextConnection, runUntil } =
    await brainAndGame();
  const deployer = deployOnNextConnection(build);
  await runUntil(() => deployerEvents.length === 1, 10_000);
  await simulation.run("home", BOOT_SCRIPT);
  await runUntil(() => channelEvents.some((event) => event.type === "agentConnected"), 10_000);

  // getServer costs 2.0 GB: agent.js would need 4.7 GB, over its 3.0 GB budget.
  deployOnNextConnection(withAgentLine("function tooCostly(ns) { return ns.getServer; }"));
  rfaConnections.at(-1)?.close(1001, "brain restarting");
  await runUntil(() => deployerEvents.length === 2, RFA_RECONNECT_SECONDS * 1_000 + 10_000);
  expect(deployerEvents[1]).toMatchObject({
    type: "deployFailed",
    reason: "agent.js needs 4.7 GB, over its budget of 3 GB",
  });
  expect(await readOnHome(simulation, game, CURRENT_DEPLOYMENT_FILE)).toBe(deployer.deploymentId);
  expect(channelEvents.filter((event) => event.type === "agentConnected")).toHaveLength(1);
});

test("the game's definitions are the pinned ones: an RFA connection to the simulated game never holds", async () => {
  const { deployerEvents, deployOnNextConnection, runUntil } = await brainAndGame();
  deployOnNextConnection(build);
  await runUntil(() => deployerEvents.length > 0, 10_000);
  expect(deployerEvents.map((event) => event.type)).toEqual(["deployed"]);
});
