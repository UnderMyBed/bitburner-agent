// Snapshot tiers (#89), from the built Agent and its workers, against a real ControlChannel on the lockstep driver:
// each tier at its cadence, a full snapshot after every welcome, the heartbeat on a full home, a worker that never
// reports, the Agent back after a reload through autoexec only, and frames that arrive while the Agent sleeps.
import type { ControlChannelEvent } from "@bitburner-agent/bridge";
import {
  BOOT_SCRIPT,
  deployedFilePath,
  type FastSnapshotData,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type SnapshotMessage,
  type SnapshotTier,
  type StaticSnapshotData,
  snapshotWorkerFileName,
  WORKER_REPORT_PORT,
} from "@bitburner-agent/core";
import type { Simulation, SimulationOptions } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps } from "../src/gap-report.ts";

const SNAPSHOT_ROUND_MS = 2_000;

import {
  attachBrain,
  type BrainOnSimulation,
  NEW_GAME_WITH_NETWORK,
  useBuiltBundles,
  writeDeployment,
} from "./helpers/agent-in-simulation.ts";

const start = useSimulations();
const bundles = useBuiltBundles();

const STEP_MS = 250;
const TEN_MINUTES_MS = 600_000;
const agentFile = deployedFilePath("deployment-a", "agent.js");

function snapshotsOf(events: ControlChannelEvent[], tier: SnapshotTier, sinceMs = 0): SnapshotMessage[] {
  return events.flatMap((event) =>
    event.type === "snapshotReceived" && event.snapshot.tier === tier && event.atMs >= sinceMs ? [event.snapshot] : [],
  );
}
const receivedAtOf = (events: ControlChannelEvent[], tier: SnapshotTier) =>
  events.flatMap((event) => (event.type === "snapshotReceived" && event.snapshot.tier === tier ? [event.atMs] : []));
const connectedCount = (events: ControlChannelEvent[]) =>
  events.filter((event) => event.type === "agentConnected").length;
const fastData = (snapshot: SnapshotMessage | undefined) => snapshot?.data as FastSnapshotData;

/** Stand-in workers that never report: one exits at once, one hangs (holding 1.6 GB), one reports 6 s late. */
const BROKEN_WORKERS = {
  exits: "export function main(ns) {}",
  hangs: "export async function main(ns) { await ns.asleep(1e9); }",
  late: `export async function main(ns) {
           await ns.sleep(6_000);
           ns.writePort(${WORKER_REPORT_PORT}, { workerPid: ns.pid, gameTimeMs: Date.now(), data: { late: true } });
         }`,
};
type BrokenWorkers = Partial<Record<SnapshotTier, keyof typeof BROKEN_WORKERS>>;

async function breakWorkers(simulation: Simulation, brokenWorkers: BrokenWorkers): Promise<void> {
  for (const [tier, how] of Object.entries(brokenWorkers) as [SnapshotTier, keyof typeof BROKEN_WORKERS][]) {
    await simulation.writeFile(
      "home",
      deployedFilePath("deployment-a", snapshotWorkerFileName(tier)),
      BROKEN_WORKERS[how],
    );
  }
}

const noFastGapsSince = (brain: BrainOnSimulation, sinceMs: number) =>
  findGaps(receivedAtOf(brain.events, "fast"), {
    sinceMs,
    untilMs: brain.game.clock.now(),
    thresholdMs: DEFAULT_GAP_THRESHOLD_MS,
  }).gaps;

async function gameWithAgent(options: Partial<SimulationOptions> & { brokenWorkers?: BrokenWorkers } = {}) {
  const { brokenWorkers = {}, ...simulationOptions } = options;
  const simulation = await start({ ...NEW_GAME_WITH_NETWORK, ...simulationOptions });
  await writeDeployment(simulation, await bundles(), "deployment-a");
  await breakWorkers(simulation, brokenWorkers);
  const brain = await attachBrain(simulation, { stepMs: STEP_MS });
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  await brain.runUntil(() => connectedCount(brain.events) === 1, 5_000);
  return { simulation, ...brain };
}

/** Waits until every tier has arrived since `sinceMs`. */
const untilFullSnapshot = (brain: BrainOnSimulation, sinceMs: number, maxVirtualMs: number) =>
  brain.runUntil(
    () =>
      (["static", "slow", "medium", "fast"] as const).every(
        (tier) => snapshotsOf(brain.events, tier, sinceMs).length > 0,
      ),
    maxVirtualMs,
  );

test("over 10 virtual minutes, each tier arrives at its cadence, numbered 1, 2, 3… per tier", async () => {
  const { game, events } = await gameWithAgent();
  const welcomedAtMs = game.clock.now();
  await game.run(TEN_MINUTES_MS);
  expect(snapshotsOf(events, "static")).toHaveLength(1);
  const expectedCounts = { slow: 10, medium: 60, fast: 300 };
  for (const [tier, expectedCount] of Object.entries(expectedCounts) as [SnapshotTier, number][]) {
    const snapshots = snapshotsOf(events, tier);
    expect(snapshots.length, tier).toBeGreaterThanOrEqual(expectedCount - 1);
    expect(snapshots.length, tier).toBeLessThanOrEqual(expectedCount + 1);
    expect(
      snapshots.map((snapshot) => snapshot.sequenceNumber),
      tier,
    ).toEqual(snapshots.map((_, index) => index + 1));
  }
  expect(
    findGaps(receivedAtOf(events, "fast"), {
      sinceMs: welcomedAtMs,
      untilMs: game.clock.now(),
      thresholdMs: DEFAULT_GAP_THRESHOLD_MS,
    }).gaps,
  ).toEqual([]);
});

test("each tier's contents: the servers, the reset info, the player, and home", async () => {
  const brain = await gameWithAgent();
  await untilFullSnapshot(brain, 0, 10_000);
  const { events } = brain;
  const staticData = snapshotsOf(events, "static")[0]?.data as StaticSnapshotData;
  const hostnames = staticData.servers.map((server) => server.hostname);
  // The whole network, the deepest servers included, each once.
  expect(hostnames).toEqual(expect.arrayContaining(["home", "n00dles", "The-Cave", "run4theh111z"]));
  expect(new Set(hostnames).size).toBe(hostnames.length);
  expect(staticData.servers.find((server) => server.hostname === "n00dles")).toMatchObject({
    moneyMax: expect.any(Number),
    requiredHackingSkill: 1,
    numOpenPortsRequired: 0,
    purchasedByPlayer: false,
  });
  // Home has the game's defaults for a server that can't be hacked.
  expect(staticData.servers.find((server) => server.hostname === "home")).toMatchObject({ moneyMax: 0 });
  const slowData = snapshotsOf(events, "slow")[0]?.data as SlowSnapshotData;
  expect(slowData.resetInfo).toMatchObject({ currentNode: 1, ownedAugs: {}, ownedSF: {} });
  expect(slowData.purchasedServers).toEqual([]);
  // The money made by source since the install (#196): nothing hacked yet.
  expect(slowData.moneySources).toMatchObject({ hacking: 0, total: expect.any(Number) });
  const mediumData = snapshotsOf(events, "medium")[0]?.data as MediumSnapshotData;
  expect(mediumData.player).toMatchObject({ money: expect.any(Number), city: "Sector-12", skills: expect.any(Object) });
  expect(mediumData.servers.map((server) => server.hostname)).toEqual(hostnames);
  expect(mediumData.servers.find((server) => server.hostname === "home")).toMatchObject({
    maxRam: 8,
    cpuCores: 1,
    hasAdminRights: true,
  });
  expect(mediumData.servers.find((server) => server.hostname === "n00dles")).toMatchObject({ maxRam: 4 });
  const fast = fastData(snapshotsOf(events, "fast")[0]);
  expect(fast).toMatchObject({
    degradedTiers: [],
    pageHeapUsedBytes: null,
    // The Agent (2.9 GB since #162's free-RAM check) and the fast worker (2.0 GB).
    game: { money: expect.any(Number), homeRamUsed: 4.9, homeMaxRam: 8 },
  });
  // The Agent, and the fast worker itself: both temporary, so a reload brings back neither (only autoexec does).
  expect(fast.game?.homeProcesses).toMatchObject([
    { filename: agentFile, temporary: true },
    { filename: deployedFilePath("deployment-a", snapshotWorkerFileName("fast")), temporary: true },
  ]);
});

test("the reset info's Maps arrive as objects: the BitNode and its Source-Files", async () => {
  const brain = await gameWithAgent({ fixture: { kind: "bitnode", n: 2, sourceFiles: { 1: 3 } } });
  await untilFullSnapshot(brain, 0, 10_000);
  const slowData = snapshotsOf(brain.events, "slow")[0]?.data as SlowSnapshotData;
  expect(slowData.resetInfo).toMatchObject({ currentNode: 2, ownedSF: { 1: 3 } });
});

test("every welcome is followed by all four tiers in the next round, numbering carrying on", async () => {
  const brain = await gameWithAgent();
  // Dropped just after the first full round: slow and medium aren't due again for 60 s and 10 s.
  await untilFullSnapshot(brain, 0, 10_000);
  brain.connections[0]?.close(4999, "brain restarting");
  await brain.runUntil(() => connectedCount(brain.events) === 2, 10_000);
  const welcomedAtMs = brain.game.clock.now();
  await untilFullSnapshot(brain, welcomedAtMs, 1_000);
  // static's second copy, from the Agent's memory, is number 2 of the same session.
  expect(snapshotsOf(brain.events, "static").map((snapshot) => snapshot.sequenceNumber)).toEqual([1, 2]);
  expect(snapshotsOf(brain.events, "static")[1]?.data).toEqual(snapshotsOf(brain.events, "static")[0]?.data);
});

test("on a full home the heartbeat goes on for 10 virtual minutes, naming the skipped tiers; freed, all resume", async () => {
  const brain = await gameWithAgent();
  const { simulation, game, events } = brain;
  await untilFullSnapshot(brain, 0, 10_000);
  // 4.8 GB taken: with the Agent's 2.9, 0.3 GB stay free, too little for any worker.
  await simulation.writeFile("home", "hold-ram.js", "export async function main(ns) { await ns.sleep(1e9); }");
  const { pid: holderPid } = await simulation.run("home", "hold-ram.js", { threads: 3 });
  const filledAtMs = game.clock.now();
  await game.run(TEN_MINUTES_MS);
  const duringFull = snapshotsOf(events, "fast", filledAtMs + 2 * STEP_MS);
  expect(duringFull.length).toBeGreaterThanOrEqual(299);
  expect(duringFull.every((snapshot) => fastData(snapshot).game === null)).toBe(true);
  expect(fastData(duringFull.at(-1)).degradedTiers.sort()).toEqual(["fast", "medium", "slow"]);
  expect(
    findGaps(receivedAtOf(events, "fast"), {
      sinceMs: filledAtMs,
      untilMs: game.clock.now(),
      thresholdMs: DEFAULT_GAP_THRESHOLD_MS,
    }).gaps,
  ).toEqual([]);

  await simulation.kill(holderPid);
  const freedAtMs = game.clock.now();
  // A skipped tier stays due, so it comes back within two rounds, not at its next slot (60 s, for slow).
  await brain.runUntil(
    () => snapshotsOf(events, "slow", freedAtMs).length > 0 && snapshotsOf(events, "medium", freedAtMs).length > 0,
    2 * SNAPSHOT_ROUND_MS + STEP_MS,
  );
  await game.run(2_000);
  expect(fastData(snapshotsOf(events, "fast").at(-1))).toMatchObject({ degradedTiers: [], game: { homeMaxRam: 8 } });
});

test("workers that exit without reporting: their tiers are skipped and named, and rounds stay 2 s apart", async () => {
  const brain = await gameWithAgent();
  const { simulation, game, events } = brain;
  await untilFullSnapshot(brain, 0, 10_000);
  await breakWorkers(simulation, { fast: "exits", medium: "exits", slow: "exits" });
  const brokenAtMs = game.clock.now();
  // Past slow's next slot, 60 s after the first full round.
  await game.run(70_000);
  expect(snapshotsOf(events, "medium", brokenAtMs + STEP_MS)).toEqual([]);
  expect(snapshotsOf(events, "slow", brokenAtMs + STEP_MS)).toEqual([]);
  const fastSince = snapshotsOf(events, "fast", brokenAtMs + 2 * SNAPSHOT_ROUND_MS);
  expect(fastSince.length).toBeGreaterThanOrEqual(33);
  expect(fastSince.every((snapshot) => fastData(snapshot).game === null)).toBe(true);
  expect(fastData(fastSince.at(-1)).degradedTiers.sort()).toEqual(["fast", "medium", "slow"]);
  expect(noFastGapsSince(brain, brokenAtMs)).toEqual([]);
  // The Agent stops waiting as soon as a worker exits without a report: each fast snapshot arrives within a step or
  // two of its round's start, not at the round's end.
  const fastEvents = events.filter(
    (event) => event.type === "snapshotReceived" && event.snapshot.tier === "fast" && event.atMs > brokenAtMs + 4_000,
  );
  for (const event of fastEvents) {
    if (event.type === "snapshotReceived") expect(event.atMs - event.snapshot.gameTimeMs).toBeLessThan(500);
  }
});

test("a worker that hangs is waited for only until its round ends, and never started twice", async () => {
  const brain = await gameWithAgent();
  const { simulation, game, events } = brain;
  await untilFullSnapshot(brain, 0, 10_000);
  await breakWorkers(simulation, { medium: "hangs" });
  const brokenAtMs = game.clock.now();
  await game.run(60_000);
  const mediumWorker = deployedFilePath("deployment-a", snapshotWorkerFileName("medium"));
  expect((await simulation.ps("home")).filter((process) => process.filename === mediumWorker)).toHaveLength(1);
  expect(snapshotsOf(events, "fast", brokenAtMs).length).toBeGreaterThanOrEqual(29);
  expect(fastData(snapshotsOf(events, "fast").at(-1)).degradedTiers).toEqual(["medium"]);
  expect(noFastGapsSince(brain, brokenAtMs)).toEqual([]);
});

test("with static's worker hanging from the start, the heartbeat has no gap, and what fits still arrives", async () => {
  const brain = await gameWithAgent({ brokenWorkers: { static: "hangs" } });
  const welcomedAtMs = brain.game.clock.now();
  await brain.game.run(30_000);
  expect(snapshotsOf(brain.events, "static")).toEqual([]);
  // The first round's medium and slow ran before static hung. After that the hung worker's 1.6 GB leaves no room for
  // medium's worker (4.45 GB), so medium is skipped too; slow's (4.65 GB since #196) isn't due again within the 30 s.
  expect(snapshotsOf(brain.events, "slow")).toHaveLength(1);
  expect(snapshotsOf(brain.events, "medium")).toHaveLength(1);
  expect(fastData(snapshotsOf(brain.events, "fast").at(-1)).degradedTiers.sort()).toEqual(["medium", "static"]);
  expect(noFastGapsSince(brain, welcomedAtMs)).toEqual([]);
});

test("a report that comes after its round ended is never taken for the next worker's", async () => {
  const brain = await gameWithAgent();
  const { simulation, game, events } = brain;
  await untilFullSnapshot(brain, 0, 10_000);
  // A medium worker that reports 6 s late: its report sits on the port when the next fast worker runs.
  await breakWorkers(simulation, { medium: "late" });
  const lateAtMs = game.clock.now();
  await game.run(30_000);
  const fastSince = snapshotsOf(events, "fast", lateAtMs);
  expect(fastSince.every((snapshot) => fastData(snapshot).game?.homeMaxRam === 8)).toBe(true);
  expect(snapshotsOf(events, "medium", lateAtMs)).toEqual([]);
});

test("frames arriving while the Agent sleeps between rounds never kill it", async () => {
  const brain = await gameWithAgent();
  const { simulation, game, events, connections } = brain;
  await untilFullSnapshot(brain, 0, 10_000);
  // A frame every step for 20 s: most land while the Agent awaits ns.sleep between rounds.
  for (let step = 0; step < 80; step++) {
    connections[0]?.send(`{"protocolVersion":1,"type":"unknown${step}"}`);
    await game.step();
  }
  expect((await simulation.ps("home")).map((process) => process.filename)).toEqual([agentFile]);
  expect(events.some((event) => event.type === "agentDisconnected")).toBe(false);
});

async function reloadedGame(autoexec: boolean): Promise<{ simulation: Simulation; brain: BrainOnSimulation }> {
  const before = await gameWithAgent(autoexec ? { gameSettings: { AutoexecScript: BOOT_SCRIPT } } : {});
  await untilFullSnapshot(before, 0, 10_000);
  const simulation = await start({
    seed: 1,
    fixture: { kind: "save", bytes: await before.simulation.save() },
    network: NEW_GAME_WITH_NETWORK.network,
  });
  return { simulation, brain: await attachBrain(simulation, { stepMs: STEP_MS }) };
}

test("after a reload the Agent is back through autoexec and sends a full snapshot", async () => {
  const { simulation, brain } = await reloadedGame(true);
  await brain.runUntil(() => connectedCount(brain.events) === 1, 10_000);
  await untilFullSnapshot(brain, 0, 10_000);
  expect((await simulation.ps("home")).map((process) => process.filename)).toEqual([agentFile]);
});

test("after a reload without autoexec, no Agent comes back (it's temporary)", async () => {
  const { simulation, brain } = await reloadedGame(false);
  await brain.game.run(10_000);
  expect(brain.events).toEqual([]);
  expect(await simulation.ps("home")).toEqual([]);
});
