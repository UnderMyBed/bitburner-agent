// The walking skeleton in the simulator (#98): M2's exit criterion in environment E1, "connect, snapshot, reload,
// reconnect, Agent RAM in an 8 GB fresh start" (architecture §13). The brain runs with its real control channel,
// deployer and store, the game deploys through its own Remote File API client, and the built Agent plays its part, on
// the lockstep driver at a fixed step. The pieces are tested on their own elsewhere (#88–#91); this tests them together,
// on every PR.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InGameBuild } from "@bitburner-agent/bridge";
import {
  AGENT_SCRIPT_NAME,
  BOOT_SCRIPT,
  deployedFilePath,
  type FastSnapshotData,
  type MediumSnapshotData,
  SNAPSHOT_TIERS,
  type SnapshotMessage,
  snapshotWorkerFileName,
} from "@bitburner-agent/core";
import { buildInGameBundles } from "@bitburner-agent/ingame/build";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps } from "../src/gap-report.ts";
import { readInGameBuild } from "../src/in-game-build.ts";
import { SimulatedGame, type SimulatedGameOptions } from "../src/simulated-game.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { BRAIN_RFA_SETTINGS, RFA_URL, startBrainInSimulation } from "./helpers/brain-in-simulation.ts";

const start = useSimulations();
const STEP_MS = 100;
const SNAPSHOT_ROUND_MS = 2_000;
const BRAIN_RELEASE = "skeleton-test";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "skeleton-"));
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

/**
 * An 8 GB fresh start with the brain on it: a new game (tutorial skipped), with its settings naming the brain's Remote
 * File API and autoexec running boot.js. The brain deploys when the game connects; then the one-time `run agent/boot.js`
 * brings the Agent up, and it's welcomed.
 */
async function freshStartWithBrain({ deliveredCopies }: Pick<SimulatedGameOptions, "deliveredCopies"> = {}) {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL, RFA_URL] },
    gameSettings: { ...BRAIN_RFA_SETTINGS, AutoexecScript: BOOT_SCRIPT },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: STEP_MS, deliveredCopies });
  const store = TelemetryStore.open(path.join(temporaryDirectory, `telemetry-${++storeCount}.sqlite`));
  openStores.push(store);
  const brain = startBrainInSimulation(game, { build, recordInto: { store, brainRelease: BRAIN_RELEASE } });
  await game.runUntil(() => brain.deployerEvents.length > 0, 10_000);
  expect(brain.deployerEvents).toEqual([expect.objectContaining({ type: "deployed" })]);
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  const agentsConnected = () => brain.channelEvents.filter((event) => event.type === "agentConnected");
  await game.runUntil(() => agentsConnected().length === 1, 10_000);
  const deploymentId = brain.deployer.deploymentId;
  const agentFile = deployedFilePath(deploymentId, AGENT_SCRIPT_NAME);
  const workerFile = (tier: (typeof SNAPSHOT_TIERS)[number]) =>
    deployedFilePath(deploymentId, snapshotWorkerFileName(tier));
  return {
    simulation,
    game,
    brain,
    store,
    agentsConnected,
    agentFile,
    workerFile,
    /**
     * Home never held more than the Agent and one worker since `inSimulation`'s game booted: at most two scripts, and
     * at most the RAM of the Agent and the largest worker, by the game's own figures. Taken as each script starts
     * (`homePeak`): a worker starts and exits between two timers, which no check from outside sees.
     */
    expectHomeWithinTheAgentPlusOneWorker: async (inSimulation = simulation) => {
      const ramOf = (file: string) => inSimulation.staticRamUsage("home", file);
      const workerRams = await Promise.all(SNAPSHOT_TIERS.map((tier) => ramOf(workerFile(tier))));
      const limitGb = (await ramOf(agentFile)) + Math.max(...workerRams);
      expect(limitGb).toBeLessThanOrEqual(8);
      const peak = await inSimulation.diagnostics.homePeak();
      expect(peak.scripts).toBe(2);
      expect(peak.ramUsed).toBeLessThanOrEqual(limitGb);
    },
    storedSnapshots: () => store.snapshots({ environment: "E1" }),
    /** The gap report over the store's fast snapshots, from `sinceMs` to now. */
    gapsSince: (sinceMs: number) =>
      findGaps(store.fastSnapshotTimes({ environment: "E1", sinceMs, untilMs: game.clock.now() }), {
        sinceMs,
        untilMs: game.clock.now(),
        thresholdMs: DEFAULT_GAP_THRESHOLD_MS,
      }),
    /** Steps until every tier has been stored since `sinceMs`. */
    untilFullSnapshotSince: (sinceMs: number, maxVirtualMs: number) =>
      game.runUntil(() => {
        const storedTiers = new Set(
          store
            .snapshots({ environment: "E1" })
            .filter((snapshot) => snapshot.receivedAtMs >= sinceMs)
            .map((snapshot) => snapshot.tier),
        );
        return SNAPSHOT_TIERS.every((tier) => storedTiers.has(tier));
      }, maxVirtualMs),
  };
}

type StoredRows = ReturnType<TelemetryStore["snapshots"]>;
const ofTier = (rows: StoredRows, tier: string) => rows.filter((row) => row.tier === tier);
const sequenceNumbersOf = (rows: StoredRows, tier: string) => ofTier(rows, tier).map((row) => row.sequenceNumber);
const oneToN = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const snapshotKey = (snapshot: { agentSessionId: string; tier: string; sequenceNumber: number }) =>
  `${snapshot.agentSessionId}/${snapshot.tier}/${snapshot.sequenceNumber}`;

test("8 GB fresh start: for 10 virtual minutes every tier arrives within the Agent plus one worker, each stored once, no gaps", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, brain, agentFile } = skeleton;
  const welcomedAtMs = game.clock.now();
  await game.run(600_000);
  expect((await simulation.ps("home")).map((process) => process.filename)).toContain(agentFile);
  await skeleton.expectHomeWithinTheAgentPlusOneWorker();

  const rows = skeleton.storedSnapshots();
  // One session, every tier at its cadence, numbered 1, 2, 3… with none missed: every snapshot stored exactly once.
  expect(new Set(rows.map((row) => row.agentSessionId)).size).toBe(1);
  const expectedCounts = { static: 1, slow: 10, medium: 60, fast: 300 };
  for (const [tier, expectedCount] of Object.entries(expectedCounts)) {
    const count = ofTier(rows, tier).length;
    expect(count, tier).toBeGreaterThanOrEqual(expectedCount);
    expect(count, tier).toBeLessThanOrEqual(expectedCount + 1);
    expect(sequenceNumbersOf(rows, tier), tier).toEqual(oneToN(count));
  }
  expect(rows.every((row) => row.missedBefore === 0)).toBe(true);
  expect(new Set(rows.map(snapshotKey)).size).toBe(rows.length);
  expect(rows.length).toBe(brain.channelEvents.filter((event) => event.type === "snapshotReceived").length);
  expect(new Set(rows.map((row) => row.release))).toEqual(new Set([`${BRAIN_RELEASE}+${brain.deployer.deploymentId}`]));
  // Home is the fresh start's 8 GB, and each heartbeat saw the Agent and its own worker only.
  const medium = ofTier(rows, "medium")[0]?.data as MediumSnapshotData;
  expect(medium.servers.find((server) => server.hostname === "home")).toMatchObject({ maxRam: 8 });
  for (const row of ofTier(rows, "fast")) {
    const fast = (row.data as FastSnapshotData).game;
    expect(fast?.homeProcesses.map((process) => process.filename)).toEqual([agentFile, skeleton.workerFile("fast")]);
    expect(fast?.homeMaxRam).toBe(8);
  }
  expect(skeleton.gapsSince(welcomedAtMs).gaps).toEqual([]);
  expect(skeleton.store.events({ environment: "E1" }).map((event) => event.kind)).toEqual([
    "deployed",
    "agentConnected",
  ]);
});

test("reload: the save loads into a new simulation, autoexec brings the Agent back, and it sends a full snapshot", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, agentsConnected, agentFile } = skeleton;
  await skeleton.untilFullSnapshotSince(0, 10_000);
  // No settings passed: the reloaded game has the save's, the brain's RFA address and autoexec included.
  const reloaded = await start({
    seed: 1,
    fixture: { kind: "save", bytes: await simulation.save() },
    network: { listenUrls: [CONTROL_URL, RFA_URL] },
  });
  game.replaceSimulation(reloaded);
  const reloadedAtMs = game.clock.now();
  await game.runUntil(() => agentsConnected().length === 2, 10_000);
  await skeleton.untilFullSnapshotSince(reloadedAtMs, SNAPSHOT_ROUND_MS + STEP_MS);
  // A new Agent session, from the same deployment, which the brain didn't need to deploy again.
  const [before, after] = agentsConnected();
  expect(after?.agentSessionId).not.toBe(before?.agentSessionId);
  expect(after?.deploymentId).toBe(before?.deploymentId);
  expect(skeleton.store.events({ environment: "E1" }).map((event) => event.kind)).toEqual([
    "deployed",
    "agentConnected",
    "agentDisconnected",
    "agentConnected",
  ]);
  const running = (await reloaded.ps("home")).map((process) => process.filename);
  expect(running.filter((file) => file === agentFile)).toHaveLength(1);
  await skeleton.expectHomeWithinTheAgentPlusOneWorker();
  await skeleton.expectHomeWithinTheAgentPlusOneWorker(reloaded);
});

test("reconnect: the brain drops the connection, and the Agent reconnects after its backoff, numbering carrying on", async () => {
  const skeleton = await freshStartWithBrain();
  const { game, brain, agentsConnected } = skeleton;
  const welcomedAtMs = game.clock.now();
  await skeleton.untilFullSnapshotSince(0, 10_000);
  brain.controlConnections[0]?.close(1011, "dropped by the brain");
  const droppedAtMs = game.clock.now();
  await game.runUntil(() => agentsConnected().length === 2, 10_000);
  const [before, after] = agentsConnected();
  // The same Agent, back after its first backoff (1 s).
  expect(after?.agentSessionId).toBe(before?.agentSessionId);
  expect((after?.atMs as number) - droppedAtMs).toBeGreaterThanOrEqual(1_000);
  const agent = (await skeleton.simulation.ps("home")).find((process) => process.filename === skeleton.agentFile);
  expect(await skeleton.simulation.logs(agent?.pid as number)).toContainEqual(
    expect.stringContaining("agent: disconnected (1011); reconnecting in 1 s"),
  );
  await skeleton.untilFullSnapshotSince(after?.atMs as number, SNAPSHOT_ROUND_MS + STEP_MS);
  await game.run(30_000);
  const rows = skeleton.storedSnapshots();
  for (const tier of SNAPSHOT_TIERS) {
    expect(sequenceNumbersOf(rows, tier), tier).toEqual(oneToN(ofTier(rows, tier).length));
  }
  expect(sequenceNumbersOf(rows, "static")).toEqual([1, 2]);
  expect(rows.every((row) => row.missedBefore === 0)).toBe(true);
  expect(skeleton.gapsSince(welcomedAtMs).gaps).toEqual([]);
});

test("the Agent stopped for 30 virtual seconds: the gap report finds exactly that one gap", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, agentsConnected, agentFile } = skeleton;
  const welcomedAtMs = game.clock.now();
  await game.run(20_000);
  const agent = (await simulation.ps("home")).find((process) => process.filename === agentFile);
  expect(await simulation.kill(agent?.pid as number)).toBe(true);
  const stoppedAtMs = game.clock.now();
  await game.run(30_000);
  expect((await simulation.run("home", BOOT_SCRIPT)).error).toBeUndefined();
  const restartedAtMs = game.clock.now();
  await game.runUntil(() => agentsConnected().length === 2, 10_000);
  await game.run(20_000);
  const { gaps } = skeleton.gapsSince(welcomedAtMs);
  expect(gaps).toHaveLength(1);
  // From the last heartbeat before the stop (one round at most) to the first after the restart (connect, welcome,
  // and its first round: within a round).
  expect(gaps[0]?.fromMs).toBeLessThanOrEqual(stoppedAtMs);
  expect(gaps[0]?.fromMs).toBeGreaterThan(stoppedAtMs - SNAPSHOT_ROUND_MS - STEP_MS);
  expect(gaps[0]?.toMs).toBeGreaterThan(restartedAtMs);
  expect(gaps[0]?.toMs).toBeLessThanOrEqual(restartedAtMs + SNAPSHOT_ROUND_MS);
  await skeleton.expectHomeWithinTheAgentPlusOneWorker();
});

/** A seeded pseudo-random source (mulberry32): the same seed gives the same faults. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FAULT_SEED = 98;
const DROP_RATE = 0.3;
const DUPLICATE_RATE = 0.15;

interface OfferedSnapshot {
  atMs: number;
  snapshot: SnapshotMessage;
  copies: number;
}

/**
 * The skeleton with a faulty wire: each snapshot frame from the Agent is dropped or duplicated at random (seeded). The
 * hello and other frames pass untouched: a lost hello is the hello timeout's case (the control channel's own tests).
 * Runs `durationMs` after the welcome; returns every snapshot frame offered, with its fate, and what the brain stored.
 */
async function runWithFaults(durationMs: number) {
  const random = seededRandom(FAULT_SEED);
  const offered: OfferedSnapshot[] = [];
  const skeleton = await freshStartWithBrain({
    deliveredCopies: ({ atMs, data }) => {
      const message = JSON.parse(data) as SnapshotMessage | { type: string };
      if (message.type !== "snapshot") return 1;
      const roll = random();
      const copies = roll < DROP_RATE ? 0 : roll < DROP_RATE + DUPLICATE_RATE ? 2 : 1;
      offered.push({ atMs, snapshot: message as SnapshotMessage, copies });
      return copies;
    },
  });
  const welcomedAtMs = skeleton.game.clock.now();
  await skeleton.game.run(durationMs);
  return {
    skeleton,
    welcomedAtMs,
    offered,
    rows: skeleton.storedSnapshots(),
    events: skeleton.store.events({ environment: "E1" }),
  };
}

test("faults on the wire: no duplicates are stored, and the gap report finds the gaps the drops made and no others", async () => {
  const { skeleton, welcomedAtMs, offered, rows } = await runWithFaults(300_000);
  expect(offered.some((frame) => frame.copies === 0)).toBe(true);
  expect(offered.some((frame) => frame.copies === 2)).toBe(true);

  // Every snapshot that got through is stored, once; nothing else is.
  const delivered = offered.filter((frame) => frame.copies > 0);
  expect(rows.map(snapshotKey)).toEqual(delivered.map((frame) => snapshotKey(frame.snapshot)));
  expect(new Set(rows.map(snapshotKey)).size).toBe(rows.length);
  // Each stored snapshot counts the drops since the one stored before it in its tier (one Agent session throughout).
  expect(new Set(rows.map((row) => row.agentSessionId)).size).toBe(1);
  const lastStoredByTier = new Map<string, number>();
  let missedInAll = 0;
  for (const row of rows) {
    const previous = lastStoredByTier.get(row.tier) ?? 0;
    const droppedBetween = offered.filter(
      (frame) =>
        frame.copies === 0 &&
        frame.snapshot.tier === row.tier &&
        frame.snapshot.sequenceNumber > previous &&
        frame.snapshot.sequenceNumber < row.sequenceNumber,
    );
    expect(droppedBetween.length, snapshotKey(row)).toBe(row.sequenceNumber - previous - 1);
    expect(row.missedBefore, snapshotKey(row)).toBe(droppedBetween.length);
    lastStoredByTier.set(row.tier, row.sequenceNumber);
    missedInAll += row.missedBefore;
  }
  expect(missedInAll).toBeGreaterThan(0);

  // The gaps are those the dropped heartbeats leave, and each one spans only dropped heartbeats.
  const { gaps } = skeleton.gapsSince(welcomedAtMs);
  const deliveredFastTimes = delivered.filter((frame) => frame.snapshot.tier === "fast").map((frame) => frame.atMs);
  const untilMs = skeleton.game.clock.now();
  expect(gaps).toEqual(
    findGaps(deliveredFastTimes, { sinceMs: welcomedAtMs, untilMs, thresholdMs: DEFAULT_GAP_THRESHOLD_MS }).gaps,
  );
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) {
    const fastInside = offered.filter(
      (frame) => frame.snapshot.tier === "fast" && frame.atMs > gap.fromMs && frame.atMs < gap.toMs,
    );
    expect(fastInside.length).toBeGreaterThanOrEqual(2);
    expect(fastInside.every((frame) => frame.copies === 0)).toBe(true);
  }
});

test("determinism: the same seed and step, run twice, store identical rows, timestamps included", async () => {
  const first = await runWithFaults(60_000);
  const second = await runWithFaults(60_000);
  expect(first.rows.length).toBeGreaterThan(20);
  expect(second.rows).toEqual(first.rows);
  expect(second.events).toEqual(first.events);
});
