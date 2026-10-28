// The hack loop end to end in the simulator (#134, M3's first slice), in an 8 GB fresh start: the brain decides, the
// Agent roots the servers and runs the loop on them through its workers, and the money grows. The switch stops it, an
// owner's own script is never touched, a brain restart leaves the loops alone, and the Agent converges on whatever the
// brain wants: another target, other hosts, another deployment's loops gone.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";
import {
  BOOT_SCRIPT,
  type DesiredState,
  deployedFilePath,
  type FastSnapshotData,
  HACK_LOOP_SCRIPT_NAME,
  homeWorkerFileNames,
  isHackLoopFile,
  type MediumSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import type { DesiredStateController } from "../src/desired-state.ts";
import { chooseHackTarget } from "../src/hack-loop.ts";
import { readInGameBuild } from "../src/in-game-build.ts";
import { SimulatedGame } from "../src/simulated-game.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, RFA_URL, startBrainInSimulation } from "./helpers/brain-in-simulation.ts";
import { expectHomeWithinTheAgentPlusOneWorker } from "./helpers/home-peak.ts";

const start = useSimulations();
const STEP_MS = 200;
const SNAPSHOT_ROUND_MS = 2_000;
/** The Agent converges every 15 rounds while on and nothing changes. */
const CONVERGE_EVERY_MS = 15 * SNAPSHOT_ROUND_MS;

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

/** A fresh start's servers that need no open ports: the loop's hosts there. */
const NO_PORT_SERVERS = [
  "foodnstuff",
  "harakiri-sushi",
  "hong-fang-tea",
  "joesguns",
  "n00dles",
  "nectar-net",
  "sigma-cosmetics",
];

interface FreshGame {
  simulation: Simulation;
  game: SimulatedGame;
}

/** A script of the owner's: it does nothing, and holds 1.6 GB a thread. */
const IDLE_SCRIPT_SOURCE = "export async function main(ns) { for (;;) await ns.sleep(60000); }";
const OWNER_SCRIPT = "owner.js";
const OWNER_THREADS = 2;

/**
 * Runs `source` once on home: the owner's own setup, as they'd type it. Steps a second, so it has run and exited.
 * `nuke` and `exec` cost RAM, so it runs before the Agent starts.
 */
async function ownerRunsOnHome(fresh: FreshGame, source: string) {
  await fresh.simulation.writeFile("home", "owner-setup.js", source);
  expect((await fresh.simulation.run("home", "owner-setup.js")).error).toBeUndefined();
  await fresh.game.run(1_000);
}

/**
 * An 8 GB fresh start with the brain, deployed, and `beforeAgent` run (the owner's own setup), then the Agent. With
 * `withDesiredState`, the brain has its desired state controller, as `main.ts` does.
 */
async function freshStart({
  withDesiredState,
  beforeAgent = async () => {},
}: {
  withDesiredState: boolean;
  beforeAgent?: (fresh: FreshGame) => Promise<void>;
}) {
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
  const data = { store, brainRelease: "hack-loop-test", dataDirectory };
  const brain = startBrainInSimulation(game, { build, data, withDesiredState });
  // A request and its reply cross one step each way, so the deploy's requests take longer at this step size.
  await game.runUntil(() => brain.deployerEvents.length > 0, 30_000);
  expect(brain.deployerEvents).toEqual([expect.objectContaining({ type: "deployed" })]);
  await simulation.writeFile("home", OWNER_SCRIPT, IDLE_SCRIPT_SOURCE);
  await beforeAgent({ simulation, game });
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await game.runUntil(() => brain.channelEvents.some((event) => event.type === "agentConnected"), 10_000);
  const deploymentId = brain.deployer.deploymentId;
  const latest = <Data>(tier: string) =>
    (store.latestSnapshot({ environment: "E1", tier })?.data as Data | undefined) ?? null;
  /** The servers the loop is for: every one but home and purchased ones, needing no open ports. */
  const noPortServers = () =>
    (latest<StaticSnapshotData>("static")?.servers ?? [])
      .filter((server) => server.hostname !== "home" && !server.purchasedByPlayer && server.numOpenPortsRequired === 0)
      .map((server) => server.hostname)
      .sort();
  /** Our loops (any deployment's) on each no-port server. */
  const loopsRunning = async () =>
    (
      await Promise.all(
        NO_PORT_SERVERS.map(async (hostname) =>
          (
            await simulation.ps(hostname)
          )
            .filter((process) => isHackLoopFile(process.filename))
            .map(({ pid, filename, threads, args }) => ({ hostname, pid, filename, threads, args })),
        ),
      )
    ).flat();
  return {
    simulation,
    game,
    brain,
    data,
    deploymentId,
    loopFile: deployedFilePath(deploymentId, HACK_LOOP_SCRIPT_NAME),
    noPortServers,
    loopsRunning,
    hostsOf: async () => (await loopsRunning()).map((each) => each.hostname).sort(),
    money: () => latest<FastSnapshotData>("fast")?.game?.money ?? null,
    medium: () => latest<MediumSnapshotData>("medium"),
    brainsTarget: () => chooseHackTarget(latest<StaticSnapshotData>("static"), latest<MediumSnapshotData>("medium")),
    /** The brain's hack loop controller; fails at once if the brain has none. */
    controller: (): DesiredStateController => {
      if (!brain.desiredState) throw new Error("this brain has no desired state controller");
      return brain.desiredState;
    },
  };
}

/** The owner roots foodnstuff and runs their own script there, 2 threads, before the Agent starts. */
const ownerScriptOnFoodnstuff = (fresh: FreshGame) =>
  ownerRunsOnHome(
    fresh,
    `export async function main(ns) {
      ns.nuke("foodnstuff");
      ns.scp("${OWNER_SCRIPT}", "foodnstuff", "home");
      ns.exec("${OWNER_SCRIPT}", "foodnstuff", ${OWNER_THREADS});
    }`,
  );

test("on by default: the Agent roots the no-port servers, runs the loop on them against the brain's target, and money grows", async () => {
  const loop = await freshStart({ withDesiredState: true, beforeAgent: ownerScriptOnFoodnstuff });
  const { simulation, game } = loop;
  await game.runUntil(() => loop.money() !== null, 10_000);
  const startingMoney = loop.money() as number;
  await game.run(10 * 60_000);

  // Every no-port server runs this deployment's loop against the brain's target, with what RAM it has left.
  expect(loop.noPortServers()).toEqual(NO_PORT_SERVERS);
  expect(loop.brainsTarget()).toBe("n00dles");
  const running = await loop.loopsRunning();
  expect(running.map((each) => each.hostname).sort()).toEqual(NO_PORT_SERVERS);
  for (const each of running) {
    expect(each, each.hostname).toMatchObject({ filename: loop.loopFile, args: ["n00dles"] });
  }
  // The owner's script is still there, and the loop has only the RAM it left: (16 - 2 × 1.6) / 2.4 = 5 threads.
  expect((await simulation.ps("foodnstuff")).filter((process) => process.filename === OWNER_SCRIPT)).toEqual([
    expect.objectContaining({ threads: OWNER_THREADS }),
  ]);
  expect(running.find((each) => each.hostname === "foodnstuff")?.threads).toBe(5);
  // In the measured runs n00dles had earned over $1m by 10 virtual minutes; anything like that shows the loop pays.
  expect((loop.money() as number) - startingMoney).toBeGreaterThan(500_000);
  await expectHomeWithinTheAgentPlusOneWorker(simulation, loop.deploymentId, homeWorkerFileNames());
});

test("a loop that stops, with nothing changed, is started again within one convergence and a round", async () => {
  const loop = await freshStart({ withDesiredState: true });
  const { simulation, game } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  const [joesgunsLoop] = (await loop.loopsRunning()).filter((each) => each.hostname === "joesguns");
  if (!joesgunsLoop) throw new Error("no loop on joesguns");
  expect(await simulation.kill(joesgunsLoop.pid)).toBe(true);
  await game.run(CONVERGE_EVERY_MS + SNAPSHOT_ROUND_MS);
  expect(await loop.hostsOf()).toContain("joesguns");
});

test("switched off: every loop is gone within two rounds, and stays gone; on again, they're back", async () => {
  const loop = await freshStart({ withDesiredState: true, beforeAgent: ownerScriptOnFoodnstuff });
  const { game } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  expect(await loop.hostsOf()).toEqual(NO_PORT_SERVERS);

  // Sent at once; the Agent acts on it at its next round, and converges in it.
  loop.controller().setHackLoopEnabled(false);
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect(await loop.loopsRunning()).toEqual([]);
  await game.run(2 * CONVERGE_EVERY_MS);
  expect(await loop.loopsRunning()).toEqual([]);
  // The owner's script was never one of ours.
  expect((await loop.simulation.ps("foodnstuff")).map((process) => process.filename)).toEqual([OWNER_SCRIPT]);

  loop.controller().setHackLoopEnabled(true);
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect(await loop.hostsOf()).toEqual(NO_PORT_SERVERS);
});

test("a brain restart leaves the loops alone: the new brain sends the same state, which changes nothing", async () => {
  const loop = await freshStart({ withDesiredState: true });
  const { game, brain } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  const before = await loop.loopsRunning();
  expect(before.length).toBe(NO_PORT_SERVERS.length);

  brain.closeConnections();
  const restarted = startBrainInSimulation(game, { build, data: loop.data, withDesiredState: true });
  await game.runUntil(() => restarted.channelEvents.some((event) => event.type === "agentConnected"), 30_000);
  // Its first round's snapshots, the desired state, and a convergence after it, and then some.
  await game.run(CONVERGE_EVERY_MS + 2 * SNAPSHOT_ROUND_MS);
  expect(restarted.desiredState?.hackLoopView()).toMatchObject({ enabled: true, waiting: false, target: "n00dles" });
  // The very same processes: none killed and started again.
  expect(await loop.loopsRunning()).toEqual(before);
});

test("after a disconnect the Agent acts only on the next brain's instructions: from a brain that sends none, nothing", async () => {
  const loop = await freshStart({ withDesiredState: true });
  const { simulation, game, brain } = loop;
  await game.runUntil(() => loop.brainsTarget() !== null, 60_000);
  await game.run(CONVERGE_EVERY_MS);
  // A brain that sends no desired state (as one that holds sends no "on"): the loops keep running, untended.
  brain.closeConnections();
  const silent = startBrainInSimulation(game, { build, data: loop.data });
  await game.runUntil(() => silent.channelEvents.some((event) => event.type === "agentConnected"), 30_000);
  expect((await loop.hostsOf()).length).toBe(NO_PORT_SERVERS.length);
  const [joesgunsLoop] = (await loop.loopsRunning()).filter((each) => each.hostname === "joesguns");
  if (!joesgunsLoop) throw new Error("no loop on joesguns");
  expect(await simulation.kill(joesgunsLoop.pid)).toBe(true);
  await game.run(2 * CONVERGE_EVERY_MS);
  expect(await loop.hostsOf()).not.toContain("joesguns");
});

test("the Agent converges on what the brain says: only the named hosts, a new target, and no other deployment's loops", async () => {
  // A brain with no controller: the test sets the desired state itself.
  const loop = await freshStart({
    withDesiredState: false,
    // A loop left from another deployment (a generated id), on sigma-cosmetics.
    beforeAgent: (fresh) =>
      ownerRunsOnHome(
        fresh,
        `export async function main(ns) {
          ns.nuke("sigma-cosmetics");
          ns.write("agent/0123456789ab/hack-loop.js", ns.read("${OWNER_SCRIPT}"), "w");
          ns.scp("agent/0123456789ab/hack-loop.js", "sigma-cosmetics", "home");
          ns.exec("agent/0123456789ab/hack-loop.js", "sigma-cosmetics", 1, "n00dles");
        }`,
      ),
  });
  const { game, brain } = loop;
  const desire = (hackLoop: DesiredState["hackLoop"]) =>
    brain.channel.setDesiredState({
      hackLoop,
      intents: [],
    });
  expect((await loop.loopsRunning()).map((each) => each.filename)).toEqual(["agent/0123456789ab/hack-loop.js"]);
  // Every no-port server but joesguns: one convergence roots them all, then runs the loop on the hosts.
  const hosts = NO_PORT_SERVERS.filter((hostname) => hostname !== "joesguns");
  desire({ enabled: true, target: "n00dles", hosts });
  await game.run(2 * SNAPSHOT_ROUND_MS);
  let running = await loop.loopsRunning();
  expect(running.map((each) => each.hostname).sort()).toEqual(hosts);
  // The old deployment's loop on sigma-cosmetics is gone, and this deployment's runs there instead.
  expect(running.every((each) => each.filename === loop.loopFile && each.args[0] === "n00dles")).toBe(true);

  // A new target: every loop is stopped and started against it.
  desire({ enabled: true, target: "foodnstuff", hosts });
  await game.run(2 * SNAPSHOT_ROUND_MS);
  running = await loop.loopsRunning();
  expect(running.map((each) => each.hostname).sort()).toEqual(hosts);
  expect(running.every((each) => each.args[0] === "foodnstuff")).toBe(true);

  // A host dropped: its loop goes, the others stay.
  desire({ enabled: true, target: "foodnstuff", hosts: hosts.filter((hostname) => hostname !== "n00dles") });
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect(await loop.hostsOf()).not.toContain("n00dles");
  expect((await loop.hostsOf()).length).toBe(hosts.length - 1);
});

test("a purchase the page can't make (#136, #141): the Agent logs why and when it tries again, and never runs two workers at once", async () => {
  const loop = await freshStart({ withDesiredState: false });
  const { simulation, game, brain } = loop;
  brain.channel.setDesiredState({
    hackLoop: { enabled: false, target: null, hosts: [] },
    intents: [{ id: "buyTor(Alpha Enterprises)", action: "buyTor", args: { vendor: "Alpha Enterprises" } }],
  });
  // Long enough for three tries 30 s apart, not for a fourth.
  await game.run(2 * CONVERGE_EVERY_MS + 3 * SNAPSHOT_ROUND_MS);
  const [agent] = (await simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"));
  if (!agent) throw new Error("no Agent on home");
  const tries = (await simulation.logs(agent.pid)).filter((line) => line.includes("buy the TOR router: not done"));
  // The simulator's page has no sidebar: each try waits for it until its deadline, logs why, and isn't bought.
  expect(tries).toHaveLength(3);
  for (const line of tries) expect(line).toContain('no "City" in the sidebar (is its section collapsed?)');
  for (const line of tries) expect(line).toContain("trying again in 30 s");
  expect(loop.medium()?.hasTorRouter).toBe(false);
  // Each try ends within its round, so home never held more than the Agent and one worker. (E2 shows the retry:
  // bought once the page allows it.)
  expect((await simulation.diagnostics.homePeak()).scripts).toBe(2);
});

test("a home RAM upgrade already made (#138): done from the game alone, without touching the page", async () => {
  const loop = await freshStart({ withDesiredState: false });
  const { simulation, game, brain } = loop;
  // A fresh start's home has 8 GB: an upgrade from 4 GB is made already, as when the brain asks again before its next
  // medium snapshot shows the last one.
  brain.channel.setDesiredState({
    hackLoop: { enabled: false, target: null, hosts: [] },
    intents: [
      {
        id: "upgradeHomeRam(4, Alpha Enterprises)",
        action: "upgradeHomeRam",
        args: { fromRam: 4, vendor: "Alpha Enterprises" },
      },
    ],
  });
  await game.run(3 * SNAPSHOT_ROUND_MS);
  const [agent] = (await simulation.ps("home")).filter((process) => process.filename.endsWith("/agent.js"));
  if (!agent) throw new Error("no Agent on home");
  // The simulator's page has no sidebar: had the worker touched it, the line would name the missing City.
  const lines = (await simulation.logs(agent.pid)).filter((line) => line.includes("home RAM"));
  expect(lines).toEqual([expect.stringMatching(/agent: upgrade home RAM to 8 GB: done$/)]);
});

test("home too full for the deploy worker: it never piles up, and runs within two rounds of there being room", async () => {
  const loop = await freshStart({
    // A brain with no controller: with home this full, the Agent's medium snapshots can't run either.
    withDesiredState: false,
    // The owner's own script on home: 2.7 + 1.6 leaves room for the root worker (2.35) but not the deploy one (4.65).
    beforeAgent: (fresh) =>
      ownerRunsOnHome(fresh, `export async function main(ns) { ns.exec("${OWNER_SCRIPT}", "home", 1); }`),
  });
  const { simulation, game, brain } = loop;
  brain.channel.setDesiredState({
    hackLoop: { enabled: true, target: "n00dles", hosts: NO_PORT_SERVERS },
    intents: [],
  });
  await game.run(CONVERGE_EVERY_MS);
  expect(await loop.loopsRunning()).toEqual([]);
  // The Agent, the owner's script and one worker at most, all along: never a pile-up of tries.
  expect((await simulation.diagnostics.homePeak()).scripts).toBe(3);

  const [ownerScript] = (await simulation.ps("home")).filter((process) => process.filename === OWNER_SCRIPT);
  if (!ownerScript) throw new Error("the owner's script isn't on home");
  expect(await simulation.kill(ownerScript.pid)).toBe(true);
  // Still due, so the next round runs it: no 30 s wait.
  await game.run(2 * SNAPSHOT_ROUND_MS);
  expect(await loop.hostsOf()).toEqual(NO_PORT_SERVERS);
});
