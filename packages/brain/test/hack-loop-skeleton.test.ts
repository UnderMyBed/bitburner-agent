// The hack loop end to end in the simulator (#134, M3's first slice), in an 8 GB fresh start: the brain decides, the
// Agent roots the servers and runs the loop on them through its workers, and the money grows. The switch stops it, and
// an owner's own script is never touched.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";
import {
  AGENT_SCRIPT_NAME,
  BOOT_SCRIPT,
  deployedFilePath,
  type FastSnapshotData,
  HACK_LOOP_DEPLOY_WORKER_NAME,
  HACK_LOOP_ROOT_WORKER_NAME,
  HACK_LOOP_SCRIPT_NAME,
  isHackLoopFile,
  type MediumSnapshotData,
  SNAPSHOT_TIERS,
  type StaticSnapshotData,
  snapshotWorkerFileName,
} from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { chooseHackTarget } from "../src/hack-loop.ts";
import { readInGameBuild } from "../src/in-game-build.ts";
import { SimulatedGame } from "../src/simulated-game.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, RFA_URL, startBrainInSimulation } from "./helpers/brain-in-simulation.ts";

const start = useSimulations();
const STEP_MS = 200;
/** The Agent converges every 15 rounds of 2 s while nothing changes. */
const CONVERGE_EVERY_MS = 30_000;
const SNAPSHOT_ROUND_MS = 2_000;

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "hack-loop-"));
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

/** The owner's own script, and how they put it on foodnstuff before the brain arrives: rooted, 2 threads of it. */
const OWNER_SCRIPT = "owner.js";
const OWNER_THREADS = 2;
const OWNER_SCRIPT_SOURCE = "export async function main(ns) { for (;;) await ns.sleep(60000); }";
const OWNER_SETUP_SOURCE = `export async function main(ns) {
  ns.nuke("foodnstuff");
  ns.scp("${OWNER_SCRIPT}", "foodnstuff", "home");
  ns.exec("${OWNER_SCRIPT}", "foodnstuff", ${OWNER_THREADS});
}`;

/** An 8 GB fresh start with the owner's script on foodnstuff, then the brain, with its hack loop, and the Agent. */
async function freshStartWithHackLoop() {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL, RFA_URL] },
    gameSettings: { ...BRAIN_RFA_SETTINGS, AutoexecScript: BOOT_SCRIPT },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: STEP_MS });
  const dataDirectory = path.join(temporaryDirectory, `data-${++storeCount}`);
  mkdirSync(dataDirectory);
  const store = TelemetryStore.open(path.join(dataDirectory, "telemetry.sqlite"));
  openStores.push(store);
  const brain = startBrainInSimulation(game, {
    build,
    data: { store, brainRelease: "hack-loop-test", dataDirectory },
    hackLoop: true,
  });
  // A request and its reply cross one step each way, so the deploy's requests take longer at this step size.
  await game.runUntil(() => brain.deployerEvents.length > 0, 30_000);
  expect(brain.deployerEvents).toEqual([expect.objectContaining({ type: "deployed" })]);
  // The owner's own script, before the Agent starts.
  await simulation.writeFile("home", OWNER_SCRIPT, OWNER_SCRIPT_SOURCE);
  await simulation.writeFile("home", "owner-setup.js", OWNER_SETUP_SOURCE);
  expect((await simulation.run("home", "owner-setup.js")).error).toBeUndefined();
  await game.run(1_000);
  expect((await simulation.ps("foodnstuff")).map((process) => process.filename)).toEqual([OWNER_SCRIPT]);
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await game.runUntil(() => brain.channelEvents.some((event) => event.type === "agentConnected"), 10_000);
  const deploymentId = brain.deployer.deploymentId;
  const latest = <Data>(tier: string) => store.latestSnapshot({ environment: "E1", tier })?.data as Data | undefined;
  /** The servers the loop is for: every one but home and purchased ones, needing no open ports. */
  const noPortServers = () =>
    (latest<StaticSnapshotData>("static")?.servers ?? [])
      .filter((server) => server.hostname !== "home" && !server.purchasedByPlayer && server.numOpenPortsRequired === 0)
      .map((server) => server.hostname);
  /** Our loops on each no-port server: [hostname, threads, args] for each. */
  const loopsRunning = async () =>
    (
      await Promise.all(
        noPortServers().map(async (hostname) =>
          (
            await simulation.ps(hostname)
          )
            .filter((process) => isHackLoopFile(process.filename))
            .map((process) => ({ hostname, filename: process.filename, threads: process.threads, args: process.args })),
        ),
      )
    ).flat();
  return {
    simulation,
    game,
    brain,
    store,
    deploymentId,
    loopFile: deployedFilePath(deploymentId, HACK_LOOP_SCRIPT_NAME),
    noPortServers,
    loopsRunning,
    money: () => latest<FastSnapshotData>("fast")?.game?.money ?? null,
    hacking: () => (latest<MediumSnapshotData>("medium")?.player?.skills as { hacking?: number })?.hacking ?? null,
    brainsTarget: () =>
      chooseHackTarget(latest<StaticSnapshotData>("static") ?? null, latest<MediumSnapshotData>("medium") ?? null),
  };
}

/** Home never held more than the Agent and one worker, the hack loop's included, by the game's own figures. */
async function expectHomeWithinTheAgentPlusOneWorker(simulation: Simulation, deploymentId: string) {
  const ramOf = (fileName: string) => simulation.staticRamUsage("home", deployedFilePath(deploymentId, fileName));
  const workerNames = [
    ...SNAPSHOT_TIERS.map(snapshotWorkerFileName),
    HACK_LOOP_ROOT_WORKER_NAME,
    HACK_LOOP_DEPLOY_WORKER_NAME,
  ];
  const workerRams = await Promise.all(workerNames.map(ramOf));
  const limitGb = Math.round(((await ramOf(AGENT_SCRIPT_NAME)) + Math.max(...workerRams)) * 100) / 100;
  expect(limitGb).toBeLessThanOrEqual(8);
  const peak = await simulation.diagnostics.homePeak();
  expect(peak.scripts).toBe(2);
  expect(peak.ramUsed).toBeLessThanOrEqual(limitGb);
}

test("on by default: the Agent roots the no-port servers, runs the loop on them against the brain's target, and money grows", async () => {
  const loop = await freshStartWithHackLoop();
  const { simulation, game } = loop;
  const startingMoney = await (async () => {
    await game.runUntil(() => loop.money() !== null, 10_000);
    return loop.money() as number;
  })();
  await game.run(10 * 60_000);

  // Every no-port server runs this deployment's loop against the brain's target, with what RAM it has left.
  const target = loop.brainsTarget();
  expect(target).toBe("n00dles");
  const running = await loop.loopsRunning();
  expect(running.map((each) => each.hostname).sort()).toEqual(loop.noPortServers().sort());
  for (const each of running) {
    expect(each, each.hostname).toMatchObject({ filename: loop.loopFile, args: [target] });
  }
  // The owner's script is still there, and the loop has only the RAM it left: (16 - 2 × 1.6) / 2.4 = 5 threads.
  const onFoodnstuff = await simulation.ps("foodnstuff");
  expect(onFoodnstuff.filter((process) => process.filename === OWNER_SCRIPT)).toEqual([
    expect.objectContaining({ threads: OWNER_THREADS }),
  ]);
  expect(running.find((each) => each.hostname === "foodnstuff")?.threads).toBe(5);

  // In the measured runs n00dles had earned over $1m by 10 virtual minutes; anything like that shows the loop pays.
  expect((loop.money() as number) - startingMoney).toBeGreaterThan(500_000);
  await expectHomeWithinTheAgentPlusOneWorker(simulation, loop.deploymentId);
});

test("a loop that stops, with nothing changed, is started again within 30 s", async () => {
  const loop = await freshStartWithHackLoop();
  const { simulation, game } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  const [joesgunsLoop] = (await simulation.ps("joesguns")).filter((process) => isHackLoopFile(process.filename));
  if (!joesgunsLoop) throw new Error("no loop on joesguns");
  expect(await simulation.kill(joesgunsLoop.pid)).toBe(true);
  await game.run(SNAPSHOT_ROUND_MS);
  expect((await loop.loopsRunning()).map((each) => each.hostname)).not.toContain("joesguns");
  await game.run(CONVERGE_EVERY_MS + SNAPSHOT_ROUND_MS);
  expect((await loop.loopsRunning()).map((each) => each.hostname)).toContain("joesguns");
});

test("switched off: every loop is gone within a round, and stays gone; on again, they're back", async () => {
  const loop = await freshStartWithHackLoop();
  const { game, brain } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  expect((await loop.loopsRunning()).length).toBe(loop.noPortServers().length);

  brain.hackLoop?.setEnabled(false);
  // The change reaches the Agent at once, and it converges in its next round.
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect(await loop.loopsRunning()).toEqual([]);
  await game.run(2 * CONVERGE_EVERY_MS);
  expect(await loop.loopsRunning()).toEqual([]);
  // The owner's script was never one of ours.
  expect((await loop.simulation.ps("foodnstuff")).map((process) => process.filename)).toEqual([OWNER_SCRIPT]);

  brain.hackLoop?.setEnabled(true);
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect((await loop.loopsRunning()).length).toBe(loop.noPortServers().length);
});
