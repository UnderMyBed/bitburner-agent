// The walking skeleton in the simulator (#98): M2's exit criterion in environment E1, "connect, snapshot, reload,
// reconnect, Agent RAM in an 8 GB fresh start" (architecture §13). The brain runs with its real control channel,
// deployer and store, the game deploys through its own Remote File API client, and the built Agent plays its part, on
// the lockstep driver at a fixed step. The pieces are tested on their own elsewhere (#88–#91); this tests them together,
// on every PR.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import type { Simulation } from "@bitburner-agent/sim";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps } from "../src/gap-report.ts";
import { readInGameBuild } from "../src/in-game-build.ts";
import { SimulatedGame, type SimulatedGameOptions } from "../src/simulated-game.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { CONTROL_URL, EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import {
  BRAIN_RFA_SETTINGS,
  RFA_RECONNECT_SECONDS,
  RFA_URL,
  startBrainInSimulation,
} from "./helpers/brain-in-simulation.ts";

const start = useSimulations();
const STEP_MS = 100;
const SNAPSHOT_ROUND_MS = 2_000;
/** The Agent's first reconnection delay (agent.ts). */
const FIRST_RECONNECT_DELAY_MS = 1_000;
/** Each tier's cadence: every round, every 5th, every 30th. */
const TIER_PERIOD_MS = { fast: 2_000, medium: 10_000, slow: 60_000 } as const;
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

/** The pid of the running script `file` on home; fails at once if it isn't running. */
async function pidOnHome(simulation: Simulation, file: string): Promise<number> {
  const process = (await simulation.ps("home")).find((each) => each.filename === file);
  if (!process) throw new Error(`${file} isn't running on home`);
  return process.pid;
}

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
  const dataDirectory = path.join(temporaryDirectory, `data-${++storeCount}`);
  mkdirSync(dataDirectory);
  const store = TelemetryStore.open(path.join(dataDirectory, "telemetry.sqlite"));
  openStores.push(store);
  const brain = startBrainInSimulation(game, { build, data: { store, brainRelease: BRAIN_RELEASE, dataDirectory } });
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
    storedSnapshots: () => store.snapshots({ environment: "E1" }),
    storedEventKinds: () => store.events({ environment: "E1" }).map((event) => event.kind),
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
    /**
     * Home never held more than the Agent and one worker since `inSimulation`'s game booted: exactly two scripts at
     * most (the Agent and a worker), and at most the RAM of the Agent and the largest worker, by the game's own figures.
     * Read from `homePeak`, which is taken as each changes: a worker starts and exits within one timer, which no check
     * from outside sees.
     */
    expectHomeWithinTheAgentPlusOneWorker: async (inSimulation = simulation) => {
      const ramOf = (file: string) => inSimulation.staticRamUsage("home", file);
      const workerRams = await Promise.all(SNAPSHOT_TIERS.map((tier) => ramOf(workerFile(tier))));
      // Rounded as the game rounds RAM in use, so a sum like 2.8 + 4.35 compares as 7.15.
      const limitGb = Math.round(((await ramOf(agentFile)) + Math.max(...workerRams)) * 100) / 100;
      expect(limitGb).toBeLessThanOrEqual(8);
      const peak = await inSimulation.diagnostics.homePeak();
      expect(peak.scripts).toBe(2);
      expect(peak.ramUsed).toBeLessThanOrEqual(limitGb);
    },
  };
}

type StoredRows = ReturnType<TelemetryStore["snapshots"]>;
const rowsOfTier = (storedRows: StoredRows, tier: string) => storedRows.filter((row) => row.tier === tier);
const sequenceNumbersOfTier = (storedRows: StoredRows, tier: string) =>
  rowsOfTier(storedRows, tier).map((row) => row.sequenceNumber);
const oneUpTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const snapshotKey = (snapshot: { agentSessionId: string; tier: string; sequenceNumber: number }) =>
  `${snapshot.agentSessionId}/${snapshot.tier}/${snapshot.sequenceNumber}`;

test("8 GB fresh start: for 10 virtual minutes every tier arrives within the Agent plus one worker, each stored once, no gaps", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, brain, agentFile } = skeleton;
  const welcomedAtMs = game.clock.now();
  await game.run(600_000);
  await pidOnHome(simulation, agentFile);
  await skeleton.expectHomeWithinTheAgentPlusOneWorker();

  const storedRows = skeleton.storedSnapshots();
  // One session, every tier in the right number, numbered 1, 2, 3… with none missed: every snapshot stored once.
  expect(new Set(storedRows.map((row) => row.agentSessionId)).size).toBe(1);
  const expectedCounts = { static: 1, slow: 10, medium: 60, fast: 300 };
  for (const [tier, expectedCount] of Object.entries(expectedCounts)) {
    const count = rowsOfTier(storedRows, tier).length;
    expect(count, tier).toBeGreaterThanOrEqual(expectedCount);
    expect(count, tier).toBeLessThanOrEqual(expectedCount + 1);
    expect(sequenceNumbersOfTier(storedRows, tier), tier).toEqual(oneUpTo(count));
  }
  // …and at its cadence: each tier's snapshots its period apart, give or take a step.
  for (const [tier, periodMs] of Object.entries(TIER_PERIOD_MS)) {
    const receivedAt = rowsOfTier(storedRows, tier).map((row) => row.receivedAtMs);
    for (let index = 1; index < receivedAt.length; index++) {
      const intervalMs = (receivedAt[index] as number) - (receivedAt[index - 1] as number);
      expect(Math.abs(intervalMs - periodMs), `${tier} #${index}`).toBeLessThanOrEqual(STEP_MS);
    }
  }
  expect(storedRows.every((row) => row.missedBefore === 0)).toBe(true);
  expect(new Set(storedRows.map(snapshotKey)).size).toBe(storedRows.length);
  expect(storedRows.length).toBe(brain.channelEvents.filter((event) => event.type === "snapshotReceived").length);
  expect(new Set(storedRows.map((row) => row.release))).toEqual(
    new Set([`${BRAIN_RELEASE}+${brain.deployer.deploymentId}`]),
  );
  // Home is the fresh start's 8 GB, and each heartbeat saw the Agent and its own worker only.
  const medium = rowsOfTier(storedRows, "medium")[0]?.data as MediumSnapshotData;
  expect(medium.servers.find((server) => server.hostname === "home")).toMatchObject({ maxRam: 8 });
  for (const row of rowsOfTier(storedRows, "fast")) {
    const fast = (row.data as FastSnapshotData).game;
    expect(fast?.homeProcesses.map((process) => process.filename)).toEqual([agentFile, skeleton.workerFile("fast")]);
    expect(fast?.homeMaxRam).toBe(8);
  }
  expect(skeleton.gapsSince(welcomedAtMs).gaps).toEqual([]);
  // The save backup shares the RFA connection with the deploy, and both succeed.
  expect(skeleton.storedEventKinds()).toEqual(["saveBackup", "deployed", "agentConnected"]);
  expect(brain.saveBackupEvents).toEqual([expect.objectContaining({ file: expect.stringMatching(/^saves\/E1\//) })]);
});

test("reload: the save loads into a new simulation, autoexec brings the Agent back, and it sends a full snapshot", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, brain, agentsConnected, agentFile } = skeleton;
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
  // A new Agent session, from the same deployment.
  const [before, after] = agentsConnected();
  expect(after?.agentSessionId).not.toBe(before?.agentSessionId);
  expect(after?.deploymentId).toBe(before?.deploymentId);
  // Brought back by autoexec alone: the Agent is temporary, so the save didn't hold it.
  const lastFast = skeleton
    .storedSnapshots()
    .filter((row) => row.tier === "fast")
    .at(-1);
  if (!lastFast) throw new Error("no fast snapshot after the reload");
  const reloadedAgent = (lastFast.data as FastSnapshotData).game?.homeProcesses.find(
    (process) => process.filename === agentFile,
  );
  expect(reloadedAgent).toMatchObject({ temporary: true });
  expect((await reloaded.ps("home")).filter((process) => process.filename === agentFile)).toHaveLength(1);
  // The reloaded game's RFA client reconnects (its settings came from the save), and the deployer finds its own
  // deployment current: nothing is deployed again. The new connection brings a save backup of its own.
  await game.runUntil(() => brain.remoteFileApiConnections.length === 2, RFA_RECONNECT_SECONDS * 1_000 + 1_000);
  await game.run(5_000);
  expect(skeleton.storedEventKinds()).toEqual([
    "saveBackup",
    "deployed",
    "agentConnected",
    "agentDisconnected",
    "agentConnected",
    "saveBackup",
  ]);
  expect(brain.saveBackupEvents.every((event) => "file" in event)).toBe(true);
  await skeleton.expectHomeWithinTheAgentPlusOneWorker(reloaded);
});

test("reconnect: the brain drops the connection, and the Agent reconnects after its backoff, numbering carrying on", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, brain, agentsConnected, agentFile } = skeleton;
  const welcomedAtMs = game.clock.now();
  await skeleton.untilFullSnapshotSince(0, 10_000);
  const firstConnection = brain.controlConnections[0];
  if (!firstConnection) throw new Error("the Agent has no connection to drop");
  firstConnection.close(1011, "dropped by the brain");
  const droppedAtMs = game.clock.now();
  await game.runUntil(() => agentsConnected().length === 2, 10_000);
  const [before, after] = agentsConnected();
  if (!before || !after) throw new Error("the Agent didn't reconnect");
  // The same Agent, back after its first backoff: it notices the drop when its round's sleep ends (within a round),
  // then waits 1 s.
  expect(after.agentSessionId).toBe(before.agentSessionId);
  expect(after.atMs - droppedAtMs).toBeGreaterThanOrEqual(FIRST_RECONNECT_DELAY_MS);
  expect(after.atMs - droppedAtMs).toBeLessThanOrEqual(SNAPSHOT_ROUND_MS + FIRST_RECONNECT_DELAY_MS + 3 * STEP_MS);
  expect(await simulation.logs(await pidOnHome(simulation, agentFile))).toContainEqual(
    expect.stringContaining("agent: disconnected (1011); reconnecting in 1 s"),
  );
  await skeleton.untilFullSnapshotSince(after.atMs, SNAPSHOT_ROUND_MS + STEP_MS);
  await game.run(30_000);
  const storedRows = skeleton.storedSnapshots();
  for (const tier of SNAPSHOT_TIERS) {
    expect(sequenceNumbersOfTier(storedRows, tier), tier).toEqual(oneUpTo(rowsOfTier(storedRows, tier).length));
  }
  expect(sequenceNumbersOfTier(storedRows, "static")).toEqual([1, 2]);
  expect(storedRows.every((row) => row.missedBefore === 0)).toBe(true);
  expect(skeleton.gapsSince(welcomedAtMs).gaps).toEqual([]);
});

test("the Agent stopped for 30 virtual seconds: the gap report finds exactly that one gap", async () => {
  const skeleton = await freshStartWithBrain();
  const { simulation, game, agentsConnected, agentFile } = skeleton;
  const welcomedAtMs = game.clock.now();
  await game.run(20_000);
  expect(await simulation.kill(await pidOnHome(simulation, agentFile))).toBe(true);
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
/** Heartbeats always dropped, whatever the seed: a gap the report must find. */
const ALWAYS_DROPPED_FAST_SEQUENCE_NUMBERS = new Set([20, 21, 22]);

interface OfferedSnapshot {
  atMs: number;
  snapshot: SnapshotMessage;
  copies: number;
}

/**
 * The skeleton with a faulty wire: each snapshot frame from the Agent is dropped or duplicated at random (seeded), and
 * three heartbeats in a row are always dropped. The hello and other frames pass untouched: over a WebSocket a frame
 * can't be lost or repeated while the connection stays up, so the faults are there to try the store and the gap report,
 * which only snapshots reach. Runs `durationMs` after the welcome; returns every snapshot frame offered, with its fate,
 * and what the brain stored.
 */
async function runWithFaults(durationMs: number) {
  const random = seededRandom(FAULT_SEED);
  const offered: OfferedSnapshot[] = [];
  const skeleton = await freshStartWithBrain({
    deliveredCopies: ({ atMs, data }) => {
      const message = JSON.parse(data) as SnapshotMessage | { type: string };
      if (message.type !== "snapshot") return 1;
      const snapshot = message as SnapshotMessage;
      const roll = random();
      const alwaysDropped =
        snapshot.tier === "fast" && ALWAYS_DROPPED_FAST_SEQUENCE_NUMBERS.has(snapshot.sequenceNumber);
      const copies = alwaysDropped || roll < DROP_RATE ? 0 : roll < DROP_RATE + DUPLICATE_RATE ? 2 : 1;
      offered.push({ atMs, snapshot, copies });
      return copies;
    },
  });
  const welcomedAtMs = skeleton.game.clock.now();
  await skeleton.game.run(durationMs);
  return {
    skeleton,
    welcomedAtMs,
    offered,
    storedRows: skeleton.storedSnapshots(),
    storedEvents: skeleton.store.events({ environment: "E1" }),
  };
}

test("faults on the wire: no duplicates are stored, and the gap report finds the gaps the drops made and no others", async () => {
  const { skeleton, welcomedAtMs, offered, storedRows } = await runWithFaults(300_000);
  expect(offered.some((frame) => frame.copies === 0)).toBe(true);
  expect(offered.some((frame) => frame.copies === 2)).toBe(true);

  // Every snapshot that got through is stored, once; nothing else is.
  const delivered = offered.filter((frame) => frame.copies > 0);
  expect(storedRows.map(snapshotKey)).toEqual(delivered.map((frame) => snapshotKey(frame.snapshot)));
  expect(new Set(storedRows.map(snapshotKey)).size).toBe(storedRows.length);
  // Each stored snapshot counts the drops since the one stored before it in its tier (one Agent session throughout).
  expect(new Set(storedRows.map((row) => row.agentSessionId)).size).toBe(1);
  const lastStoredByTier = new Map<string, number>();
  let missedInAll = 0;
  for (const row of storedRows) {
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

  // The gaps are those the dropped heartbeats leave: the report matches the one over what got through…
  const { gaps } = skeleton.gapsSince(welcomedAtMs);
  const deliveredFastTimes = delivered.filter((frame) => frame.snapshot.tier === "fast").map((frame) => frame.atMs);
  const untilMs = skeleton.game.clock.now();
  expect(gaps).toEqual(
    findGaps(deliveredFastTimes, { sinceMs: welcomedAtMs, untilMs, thresholdMs: DEFAULT_GAP_THRESHOLD_MS }).gaps,
  );
  // …each gap spans only dropped heartbeats…
  const offeredFast = offered.filter((frame) => frame.snapshot.tier === "fast");
  for (const gap of gaps) {
    const fastInside = offeredFast.filter((frame) => frame.atMs > gap.fromMs && frame.atMs < gap.toMs);
    expect(fastInside.length).toBeGreaterThanOrEqual(2);
    expect(fastInside.every((frame) => frame.copies === 0)).toBe(true);
  }
  // …and every run of three or more dropped heartbeats in a row (8 s or more between those that got through, over the
  // 6 s threshold) lies inside a gap, the always-dropped run among them.
  const runsOfDrops: OfferedSnapshot[][] = [];
  let currentRun: OfferedSnapshot[] = [];
  for (const frame of [...offeredFast, null]) {
    if (frame?.copies === 0) {
      currentRun.push(frame);
      continue;
    }
    if (currentRun.length >= 3) runsOfDrops.push(currentRun);
    currentRun = [];
  }
  expect(runsOfDrops.some((run) => run.some((frame) => frame.snapshot.sequenceNumber === 21))).toBe(true);
  for (const run of runsOfDrops) {
    const first = run[0] as OfferedSnapshot;
    const last = run.at(-1) as OfferedSnapshot;
    expect(gaps.some((gap) => gap.fromMs < first.atMs && gap.toMs > last.atMs)).toBe(true);
  }
});

test("determinism: the same seed and step, run twice, store identical rows, timestamps included", async () => {
  const first = await runWithFaults(60_000);
  const second = await runWithFaults(60_000);
  // Enough to compare: a minute's heartbeats and the other tiers, less the drops.
  expect(first.storedRows.length).toBeGreaterThanOrEqual(20);
  expect(second.storedRows).toEqual(first.storedRows);
  expect(second.storedEvents).toEqual(first.storedEvents);
});
