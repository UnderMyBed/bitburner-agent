// The walking skeleton on E2 (#97): M2's exit criterion on the real page, "connect, snapshot, reload, reconnect, Agent
// RAM in an 8 GB fresh start" (architecture §13), with the game's own Remote File API client and network, a real brain
// (environment E2) and the built Agent. It answers Q1 (#34) there.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_SCRIPT_NAME,
  BOOT_SCRIPT,
  deployedFilePath,
  type FastSnapshotData,
  HACK_LOOP_SCRIPT_NAME,
  homeWorkerFileNames,
  type MediumSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  SNAPSHOT_TIERS,
  snapshotWorkerFileName,
} from "@bitburner-agent/core";
import type { Page } from "playwright";
import { afterAll, afterEach, describe, expect, onTestFailed, test } from "vitest";
import {
  advanceGameTime,
  advanceUntil,
  closeGame,
  exitTutorial,
  freshGame,
  GAME_CYCLE_MS,
  gameFromSave,
  terminalText,
  typeCommand,
  waitForTerminal,
} from "../src/game.ts";
import { type BrainPorts, freeBrainPorts, type RunningBrain, readStore, startBrain } from "./helpers/brain.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave } from "./helpers/saves.ts";

const e2 = useE2();
/** The game autosaves every 60 s; a deploy is in the save only after it (#91). Waited for by its toast. */
const AUTOSAVE_GAME_TIMEOUT_MS = 65_000;
const TWO_GAME_MINUTES_MS = 120_000;
/** Real time one step may take: a deploy, a brain's start, an Agent's round. */
const STEP_REAL_TIMEOUT_MS = 60_000;
/**
 * Snapshots a tier may send beyond its period's count over a span: the round after the welcome sends every tier, so
 * each counts one more than the span alone (measured: slow 3, medium 13, fast 61 over 2 game minutes).
 */
const EXTRA_ROUNDS_ALLOWED = 1;
/** How far a tier's interval may be off its period, in game time: two game cycles (the clock's steps). */
const CADENCE_TOLERANCE_MS = 2 * GAME_CYCLE_MS;
/** Events that mean something went wrong. A failed save backup is a `saveBackup` with `failure`, checked apart. */
const TROUBLE_EVENT_KINDS = ["deployFailed", "connectionRejected", "versionDrift", "saveBackupRotationFailed"];

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-skeleton-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
const startedInThisTest: { brains: RunningBrain[]; pages: Page[] } = { brains: [], pages: [] };
afterEach(async () => {
  for (const page of startedInThisTest.pages.splice(0)) await closeGame(page).catch(() => {});
  for (const brain of startedInThisTest.brains.splice(0)) await brain.stop();
});
let dataDirectoryCount = 0;

/** A brain of the test's own (started again on the same `ports` and data directory, it keeps its token). */
async function startTestBrain(dataDirectory: string, ports: BrainPorts): Promise<RunningBrain> {
  const brain = await startBrain({ dataDirectory, ports, allowedOrigin: e2.server.origin });
  startedInThisTest.brains.push(brain);
  const brainNumber = startedInThisTest.brains.length;
  onTestFailed(() => console.log(`Brain ${brainNumber}'s log (${dataDirectory}):\n${brain.log.join("\n")}`));
  return brain;
}

/** A new data directory, free ports, and a brain on them. */
async function newTestBrain() {
  const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
  const ports = await freeBrainPorts();
  return { dataDirectory, ports, brain: await startTestBrain(dataDirectory, ports) };
}

/** What the brain has stored so far, with helpers. */
function storeContents(dataDirectory: string) {
  const { snapshots, events } = readStore(dataDirectory);
  return {
    snapshots,
    events,
    eventKinds: events.map((event) => event.kind),
    count: (kind: string) => events.filter((event) => event.kind === kind).length,
  };
}

/** Moves game time on until the brain has stored `count` events of `kind`. */
function untilEventCount(page: Page, dataDirectory: string, kind: string, count: number, gameTimeoutMs = 30_000) {
  return advanceUntil(page, async () => storeContents(dataDirectory).count(kind) === count, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs,
  });
}

type StoredRows = ReturnType<typeof storeContents>["snapshots"];
const rowsOf = (rows: StoredRows, session: string, tier: string) =>
  rows.filter((row) => row.agentSessionId === session && row.tier === tier);
const oneUpTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const latestSession = (rows: StoredRows) => rows.at(-1)?.agentSessionId as string;

/** Whether every tier has been stored for `session` (since `sinceMs`, the brain's clock): a full snapshot. */
const hasFullSnapshot = (rows: StoredRows, session: string, sinceMs = 0) =>
  SNAPSHOT_TIERS.every((tier) => rowsOf(rows, session, tier).some((row) => row.receivedAtMs >= sinceMs));

/**
 * Every tier of `session` in the right number for `spanMs` of game time (static once), numbered 1, 2, 3… with none
 * missed: every snapshot stored once.
 */
function expectEveryTierInNumber(rows: StoredRows, session: string, spanMs: number): void {
  const expectedCounts = {
    static: 1,
    slow: Math.floor(spanMs / SNAPSHOT_TIER_PERIOD_MS.slow),
    medium: Math.floor(spanMs / SNAPSHOT_TIER_PERIOD_MS.medium),
    fast: Math.floor(spanMs / SNAPSHOT_TIER_PERIOD_MS.fast),
  };
  for (const [tier, expectedCount] of Object.entries(expectedCounts)) {
    const tierRows = rowsOf(rows, session, tier);
    if (tier === "static") expect(tierRows.length, tier).toBe(1);
    expect(tierRows.length, tier).toBeGreaterThanOrEqual(expectedCount);
    expect(tierRows.length, tier).toBeLessThanOrEqual(expectedCount + EXTRA_ROUNDS_ALLOWED);
    expect(
      tierRows.map((row) => row.sequenceNumber),
      tier,
    ).toEqual(oneUpTo(tierRows.length));
  }
  expect(rows.filter((row) => row.agentSessionId === session).every((row) => row.missedBefore === 0)).toBe(true);
  // Every worker ran when its turn came: no fast snapshot without the game's data, no tier ever skipped. On an 8 GB
  // home any two workers and the Agent exceed 8 GB, so this is also "never two workers at once".
  for (const row of rowsOf(rows, session, "fast")) {
    const fast = row.data as FastSnapshotData;
    expect(fast.game, `fast #${row.sequenceNumber}`).not.toBeNull();
    expect(fast.degradedTiers, `fast #${row.sequenceNumber}`).toEqual([]);
  }
}

/** Moves game time on until the brain has stored a full snapshot for the newest session. */
function untilFullSnapshot(page: Page, dataDirectory: string) {
  return advanceUntil(
    page,
    async () => {
      const { snapshots } = storeContents(dataDirectory);
      return snapshots.length > 0 && hasFullSnapshot(snapshots, latestSession(snapshots));
    },
    { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 10_000 },
  );
}

/**
 * Deploy and start (#97, step 1): a simulator-made save whose settings name the brain's Remote File API and autoexec
 * boot.js; the game connects and the brain deploys; past an autosave (its toast shows once the save is written), so the
 * deploy is saved; then a reload, after which autoexec starts the Agent, it's welcomed, and its first round, a full
 * snapshot, is stored: each test starts from there.
 */
async function deployedAndStarted() {
  const { dataDirectory, ports, brain } = await newTestBrain();
  const save = await simulatorSave({
    gameSettings: {
      RemoteFileApiAddress: "127.0.0.1",
      RemoteFileApiPort: ports.remoteFileApiPort,
      RemoteFileApiReconnectionDelay: 1,
      AutoexecScript: BOOT_SCRIPT,
    },
  });
  const page = await gameFromSave(e2.browser, e2.server, save);
  startedInThisTest.pages.push(page);
  await untilEventCount(page, dataDirectory, "deployed", 1);
  await advanceUntil(page, async () => (await page.getByText("Game Saved!").count()) > 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: AUTOSAVE_GAME_TIMEOUT_MS,
  });
  await page.reload();
  await waitForTerminal(page);
  await untilEventCount(page, dataDirectory, "agentConnected", 1);
  await untilFullSnapshot(page, dataDirectory);
  return { dataDirectory, ports, brain, page };
}

describe("the skeleton on E2", () => {
  test("deploy and start: the game connects, the brain deploys and backs up, and after an autosave and a reload autoexec starts the Agent", async () => {
    const { dataDirectory, brain, page } = await deployedAndStarted();
    // After the reload the game's RFA client connects again, from its 2 s timer: the deploy is current.
    await untilEventCount(page, dataDirectory, "deploymentCurrent", 1, 10_000);
    const { events, eventKinds, snapshots } = storeContents(dataDirectory);
    expect(eventKinds.filter((kind) => kind === "deployed")).toHaveLength(1);
    // A backup on each RFA connection, both written.
    const backups = events.filter((event) => event.kind === "saveBackup");
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(backups.every((event) => typeof (event.detail as { file?: unknown }).file === "string")).toBe(true);
    // Welcomed, not told to restart: the Agent runs the deployment the brain deploys.
    const [connected] = events.filter((event) => event.kind === "agentConnected");
    expect(connected?.detail).toMatchObject({ deploymentId: brain.deploymentId });
    expect(new Set(snapshots.map((row) => row.release))).toEqual(
      new Set([expect.stringContaining(brain.deploymentId)]),
    );
  });

  test("snapshots: over 2 game minutes every tier arrives at its cadence in game time, each stored once", async () => {
    const { dataDirectory, page } = await deployedAndStarted();
    await advanceGameTime(page, TWO_GAME_MINUTES_MS);
    const rows = storeContents(dataDirectory).snapshots;
    const session = latestSession(rows);
    expect(new Set(rows.map((row) => row.agentSessionId))).toEqual(new Set([session]));
    expectEveryTierInNumber(rows, session, TWO_GAME_MINUTES_MS);
    // Cadence on gameTimeMs (when the worker read the game): the brain's receive times are real time.
    const worstOffsetsMs: Record<string, number> = {};
    for (const [tier, periodMs] of Object.entries(SNAPSHOT_TIER_PERIOD_MS)) {
      const times = rowsOf(rows, session, tier).map((row) => row.gameTimeMs);
      const intervals = times.slice(1).map((time, index) => time - (times[index] as number));
      worstOffsetsMs[tier] = Math.max(...intervals.map((interval) => Math.abs(interval - periodMs)));
      expect(worstOffsetsMs[tier], `${tier} intervals ${intervals.join(", ")}`).toBeLessThanOrEqual(
        CADENCE_TOLERANCE_MS,
      );
    }
    console.log(
      `Cadence: the most a tier's interval was off its period, in game ms: ${JSON.stringify(worstOffsetsMs)}`,
    );
    expect(new Set(rows.map((row) => `${row.tier}/${row.sequenceNumber}`)).size).toBe(rows.length);
    expect(storeContents(dataDirectory).eventKinds.filter((kind) => TROUBLE_EVENT_KINDS.includes(kind))).toEqual([]);
  });

  test("reload: reloading the page brings the Agent back through autoexec, with a full snapshot", async () => {
    const { dataDirectory, page } = await deployedAndStarted();
    const sessionBefore = latestSession(storeContents(dataDirectory).snapshots);
    await page.reload();
    await waitForTerminal(page);
    await advanceUntil(
      page,
      async () => {
        const { snapshots, count } = storeContents(dataDirectory);
        const session = latestSession(snapshots);
        return count("agentConnected") === 2 && session !== sessionBefore && hasFullSnapshot(snapshots, session);
      },
      { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 30_000 },
    );
  });

  test("reconnect: the brain is killed and started again on the same ports; the game's RFA client and the Agent reconnect", async () => {
    const { dataDirectory, ports, brain, page } = await deployedAndStarted();
    const sessionBefore = latestSession(storeContents(dataDirectory).snapshots);
    // On Windows the kill ends it at once, with no clean shutdown: a crash, as far as the game can tell.
    await brain.stop();
    const restarted = await startTestBrain(dataDirectory, ports);
    const before = storeContents(dataDirectory);
    const { gameMs } = await advanceUntil(
      page,
      async () => {
        const now = storeContents(dataDirectory);
        // After the restart: the game's RFA client reconnected (the deploy is current) and the Agent did too.
        return (
          now.count("deploymentCurrent") > before.count("deploymentCurrent") &&
          now.count("agentConnected") > before.count("agentConnected")
        );
      },
      { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 60_000 },
    );
    console.log(`Reconnected ${gameMs} ms of game time after the brain came back (${restarted.deploymentId})`);
    // Welcomed again, the same Agent sends a full snapshot; its session carries on, its numbering too.
    const reconnectedAtMs = storeContents(dataDirectory).events.findLast((event) => event.kind === "agentConnected")
      ?.atMs as number;
    await advanceUntil(
      page,
      async () => hasFullSnapshot(storeContents(dataDirectory).snapshots, sessionBefore, reconnectedAtMs),
      { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 10_000 },
    );
    const rows = storeContents(dataDirectory).snapshots;
    expect(latestSession(rows)).toBe(sessionBefore);
    for (const tier of SNAPSHOT_TIERS) {
      expect(
        rowsOf(rows, sessionBefore, tier).map((row) => row.sequenceNumber),
        tier,
      ).toEqual(oneUpTo(rowsOf(rows, sessionBefore, tier).length));
    }
  });

  test("8 GB fresh start: options set in the UI, the first boot typed; every tier arrives within the Agent plus one worker", async () => {
    const { dataDirectory, ports, brain } = await newTestBrain();
    const page = await freshGame(e2.browser, e2.server);
    startedInThisTest.pages.push(page);
    await exitTutorial(page);
    // As the owner does (docs/setup.md, section 4): Options → Remote API, Connect; Options → System, autoexec.
    await page.getByText("Options", { exact: true }).click();
    await page.getByText("Remote API", { exact: true }).click();
    const remoteApiField = (label: string) => page.locator(".MuiTextField-root", { hasText: label }).locator("input");
    await remoteApiField("Hostname:").fill("127.0.0.1");
    await remoteApiField("Port:").fill(String(ports.remoteFileApiPort));
    await remoteApiField("Reconnection delay:").fill("5");
    await page.getByRole("button", { name: "Connect" }).click();
    await untilEventCount(page, dataDirectory, "deployed", 1);
    await page.getByText("System", { exact: true }).click();
    // Its label is a paragraph just before the field, not a <label>.
    const autoexecField = page
      .getByText("Autoexec Script + Args", { exact: true })
      .locator("xpath=following-sibling::div[1]//input");
    await autoexecField.fill(BOOT_SCRIPT);
    await expect(autoexecField.inputValue()).resolves.toBe(BOOT_SCRIPT);
    await page.getByText("Terminal", { exact: true }).click();
    await typeCommand(page, `run ${BOOT_SCRIPT}`);
    await untilEventCount(page, dataDirectory, "agentConnected", 1);
    await advanceGameTime(page, TWO_GAME_MINUTES_MS);

    // The game's own RAM figures (`mem`) for the Agent, each home worker (the snapshots' and the hack loop's, #134),
    // and boot.js (beside the Agent at a handover).
    const agentFile = deployedFilePath(brain.deploymentId, AGENT_SCRIPT_NAME);
    const workerFiles = homeWorkerFileNames().map((fileName) => deployedFilePath(brain.deploymentId, fileName));
    const ramGbByScript: Record<string, number> = {};
    for (const file of [agentFile, ...workerFiles, BOOT_SCRIPT]) {
      const terminalLengthBeforeCommand = (await terminalText(page)).length;
      const output = async () => (await terminalText(page)).slice(terminalLengthBeforeCommand);
      await typeCommand(page, `mem ${file}`);
      await advanceUntil(page, async () => /requires [\d.]+GB/.test(await output()), { realTimeoutMs: 10_000 });
      ramGbByScript[file] = Number(/requires ([\d.]+)GB/.exec(await output())?.[1]);
    }
    // Rounded as the game rounds RAM in use, so a sum like 2.8 + 4.35 compares as 7.15.
    const largestWorkerGb = Math.max(...workerFiles.map((file) => ramGbByScript[file] as number));
    const agentPlusLargestWorkerGb = Math.round(((ramGbByScript[agentFile] as number) + largestWorkerGb) * 100) / 100;
    expect(agentPlusLargestWorkerGb).toBeLessThanOrEqual(8);

    const rows = storeContents(dataDirectory).snapshots;
    const session = latestSession(rows);
    expectEveryTierInNumber(rows, session, TWO_GAME_MINUTES_MS);
    const medium = rowsOf(rows, session, "medium")[0]?.data as MediumSnapshotData;
    expect(medium.servers.find((server) => server.hostname === "home")).toMatchObject({ maxRam: 8 });
    const fastRows = rowsOf(rows, session, "fast").map((row) => row.data as FastSnapshotData);
    let mostHomeRamUsedGb = 0;
    for (const fast of fastRows) {
      // No tier ever skipped for want of RAM: within budget.
      expect(fast.degradedTiers).toEqual([]);
      expect(fast.game?.homeMaxRam).toBe(8);
      // The Agent and its own fast worker: the snapshot is taken by that worker.
      const files = fast.game?.homeProcesses.map((process) => process.filename) ?? [];
      expect(files[0]).toBe(agentFile);
      expect(files.length).toBeLessThanOrEqual(2);
      mostHomeRamUsedGb = Math.max(mostHomeRamUsedGb, fast.game?.homeRamUsed ?? 0);
    }
    // What a fast snapshot sees is the Agent and the fast worker, exactly: runtime RAM is the static figure.
    const agentPlusFastWorkerGb =
      (ramGbByScript[agentFile] as number) +
      (ramGbByScript[deployedFilePath(brain.deploymentId, snapshotWorkerFileName("fast"))] as number);
    expect(Math.abs(mostHomeRamUsedGb - agentPlusFastWorkerGb)).toBeLessThan(0.01);
    expect(mostHomeRamUsedGb).toBeLessThanOrEqual(agentPlusLargestWorkerGb);
    // The page's heap: missing on E2, where Playwright's fake `performance` has no `memory.usedJSHeapSize`.
    const heaps = fastRows.map((fast) => fast.pageHeapUsedBytes).filter((bytes) => typeof bytes === "number");
    const heapText =
      heaps.length === 0
        ? "not reported (Playwright's fake performance)"
        : `${Math.round(Math.min(...heaps) / 2 ** 20)}–${Math.round(Math.max(...heaps) / 2 ** 20)} MiB`;
    console.log(
      `Q1 on E2: ${JSON.stringify(ramGbByScript)}; the Agent plus its largest worker ${agentPlusLargestWorkerGb} GB; ` +
        `home RAM in use at each fast snapshot at most ${mostHomeRamUsedGb} GB of 8; page heap ${heapText}`,
    );

    // The hack loop (#134), on by default, in the real game: n00dles is rooted, and runs the loop.
    const latestMedium = rowsOf(rows, session, "medium").at(-1)?.data as MediumSnapshotData;
    expect(latestMedium.servers.find((server) => server.hostname === "n00dles")).toMatchObject({
      hasAdminRights: true,
    });
    await typeCommand(page, "connect n00dles");
    const terminalLengthBeforePs = (await terminalText(page)).length;
    await typeCommand(page, "ps");
    const loopFile = deployedFilePath(brain.deploymentId, HACK_LOOP_SCRIPT_NAME);
    await advanceUntil(page, async () => (await terminalText(page)).slice(terminalLengthBeforePs).includes(loopFile), {
      realTimeoutMs: 10_000,
    });
    await typeCommand(page, "home");
  });
});
