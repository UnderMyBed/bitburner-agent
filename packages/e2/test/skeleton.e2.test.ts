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
  type MediumSnapshotData,
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
  gameFromSave,
  terminalText,
  typeCommand,
  waitForTerminal,
} from "../src/game.ts";
import { type BrainPorts, freeBrainPorts, type RunningBrain, readStore, startBrain } from "./helpers/brain.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave } from "./helpers/saves.ts";

const e2 = useE2();
/** Each tier's cadence, in game time (docs/bridge/protocol.md). */
const TIER_PERIOD_MS = { fast: 2_000, medium: 10_000, slow: 60_000 } as const;
/** The game autosaves every 60 s; a deploy is in the save only after it (#91). */
const PAST_AN_AUTOSAVE_MS = 61_000;
const TWO_GAME_MINUTES_MS = 120_000;
/** Real time a step may take: a deploy, a brain's start, an Agent's round. */
const REAL_TIMEOUT_MS = 60_000;

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-skeleton-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
const running: { brains: RunningBrain[]; pages: Page[] } = { brains: [], pages: [] };
afterEach(async () => {
  for (const page of running.pages.splice(0)) await closeGame(page).catch(() => {});
  for (const brain of running.brains.splice(0)) await brain.stop();
});
let dataDirectoryCount = 0;

/** A brain of the test's own, on free ports (or `ports`, to start it again on the same ones). */
async function brainFor(dataDirectory: string, ports: BrainPorts): Promise<RunningBrain> {
  const brain = await startBrain({ dataDirectory, ports, allowedOrigin: e2.server.origin });
  running.brains.push(brain);
  onTestFailed(() => console.log(`The brain's log (${dataDirectory}):\n${brain.log.join("\n")}`));
  return brain;
}

/** What the brain has stored so far, with helpers. */
function stored(dataDirectory: string) {
  const { snapshots, events } = readStore(dataDirectory);
  return {
    snapshots,
    events,
    eventKinds: events.map((event) => event.kind),
    count: (kind: string) => events.filter((event) => event.kind === kind).length,
  };
}

type StoredRows = ReturnType<typeof stored>["snapshots"];
const rowsOf = (rows: StoredRows, session: string, tier: string) =>
  rows.filter((row) => row.agentSessionId === session && row.tier === tier);
const oneUpTo = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const latestSession = (rows: StoredRows) => rows.at(-1)?.agentSessionId as string;

/** Whether every tier has been stored for `session`: a full snapshot. */
const hasFullSnapshot = (rows: StoredRows, session: string) =>
  SNAPSHOT_TIERS.every((tier) => rowsOf(rows, session, tier).length > 0);

/**
 * Deploy and start (#97, step 1): a simulator-made save whose settings name the brain's Remote File API and autoexec
 * boot.js; the game connects and the brain deploys; past an autosave, so the deploy is saved; then a reload, after which
 * autoexec starts the Agent and it's welcomed.
 */
async function deployedAndStarted() {
  const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
  const ports = await freeBrainPorts();
  const brain = await brainFor(dataDirectory, ports);
  const save = await simulatorSave({
    gameSettings: {
      RemoteFileApiAddress: "127.0.0.1",
      RemoteFileApiPort: ports.remoteFileApiPort,
      RemoteFileApiReconnectionDelay: 1,
      AutoexecScript: BOOT_SCRIPT,
    },
  });
  const page = await gameFromSave(e2.browser, e2.server, save);
  running.pages.push(page);
  await advanceUntil(page, async () => stored(dataDirectory).count("deployed") === 1, {
    realTimeoutMs: REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  await advanceGameTime(page, PAST_AN_AUTOSAVE_MS);
  await page.reload();
  await waitForTerminal(page);
  await advanceUntil(page, async () => stored(dataDirectory).count("agentConnected") === 1, {
    realTimeoutMs: REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  return { dataDirectory, ports, brain, page };
}

describe("the skeleton on E2", () => {
  test("deploy and start: the game connects, the brain deploys, and after an autosave and a reload autoexec starts the Agent", async () => {
    const { dataDirectory, brain, page } = await deployedAndStarted();
    // After the reload the game's RFA client connects again, from its 2 s timer: the deploy is current.
    await advanceUntil(page, async () => stored(dataDirectory).count("deploymentCurrent") === 1, {
      realTimeoutMs: REAL_TIMEOUT_MS,
      gameTimeoutMs: 10_000,
    });
    const { eventKinds, snapshots } = stored(dataDirectory);
    // The first connection deploys and backs up; the one after the reload finds the deploy current.
    expect(eventKinds).toEqual(expect.arrayContaining(["deployed", "deploymentCurrent", "agentConnected"]));
    expect(eventKinds.filter((kind) => kind === "deployed")).toHaveLength(1);
    expect(new Set(snapshots.map((row) => row.release))).toEqual(
      new Set([expect.stringContaining(brain.deploymentId)]),
    );
  });

  test("snapshots: over 2 game minutes every tier arrives at its cadence in game time, each stored once", async () => {
    const { dataDirectory, page } = await deployedAndStarted();
    await advanceUntil(
      page,
      async () => hasFullSnapshot(stored(dataDirectory).snapshots, latestSession(stored(dataDirectory).snapshots)),
      {
        realTimeoutMs: REAL_TIMEOUT_MS,
        gameTimeoutMs: 10_000,
      },
    );
    await advanceGameTime(page, TWO_GAME_MINUTES_MS);
    const rows = stored(dataDirectory).snapshots;
    const session = latestSession(rows);
    expect(new Set(rows.map((row) => row.agentSessionId))).toEqual(new Set([session]));
    const expectedCounts = { static: 1, slow: 2, medium: 12, fast: 60 };
    for (const [tier, expectedCount] of Object.entries(expectedCounts)) {
      const tierRows = rowsOf(rows, session, tier);
      expect(tierRows.length, tier).toBeGreaterThanOrEqual(expectedCount);
      expect(tierRows.length, tier).toBeLessThanOrEqual(expectedCount + 2);
      expect(
        tierRows.map((row) => row.sequenceNumber),
        tier,
      ).toEqual(oneUpTo(tierRows.length));
    }
    // Cadence on gameTimeMs (when the worker read the game), within a game cycle or two of its period.
    const offsets: Record<string, number> = {};
    for (const [tier, periodMs] of Object.entries(TIER_PERIOD_MS)) {
      const times = rowsOf(rows, session, tier).map((row) => row.gameTimeMs);
      const intervals = times.slice(1).map((time, index) => time - (times[index] as number));
      offsets[tier] = Math.max(...intervals.map((interval) => Math.abs(interval - periodMs)));
      expect(offsets[tier], `${tier} intervals ${intervals.join(", ")}`).toBeLessThanOrEqual(400);
    }
    console.log(`Cadence: the most a tier's interval was off its period, in game ms: ${JSON.stringify(offsets)}`);
    expect(rows.every((row) => row.missedBefore === 0)).toBe(true);
    expect(new Set(rows.map((row) => `${row.tier}/${row.sequenceNumber}`)).size).toBe(rows.length);
    // Nothing went wrong on the way: no failed deploy, refused connection or version drift.
    const troubleKinds = ["deployFailed", "connectionRejected", "versionDrift", "saveBackupRotationFailed"];
    expect(stored(dataDirectory).eventKinds.filter((kind) => troubleKinds.includes(kind))).toEqual([]);
  });

  test("reload: reloading the page brings the Agent back through autoexec, with a full snapshot", async () => {
    const { dataDirectory, page } = await deployedAndStarted();
    const sessionBefore = latestSession(stored(dataDirectory).snapshots);
    await page.reload();
    await waitForTerminal(page);
    await advanceUntil(
      page,
      async () => {
        const { snapshots, count } = stored(dataDirectory);
        const session = latestSession(snapshots);
        return count("agentConnected") === 2 && session !== sessionBefore && hasFullSnapshot(snapshots, session);
      },
      { realTimeoutMs: REAL_TIMEOUT_MS, gameTimeoutMs: 30_000 },
    );
  });

  test("reconnect: the brain stops and starts again on the same ports; the game's RFA client and the Agent reconnect", async () => {
    const { dataDirectory, ports, brain, page } = await deployedAndStarted();
    const sessionBefore = latestSession(stored(dataDirectory).snapshots);
    await brain.stop();
    const restarted = await brainFor(dataDirectory, ports);
    const before = stored(dataDirectory);
    const { gameMs } = await advanceUntil(
      page,
      async () => {
        const now = stored(dataDirectory);
        // After the restart: the game's RFA client reconnected (the deploy is current) and the Agent did too.
        return (
          now.count("deploymentCurrent") > before.count("deploymentCurrent") &&
          now.count("agentConnected") > before.count("agentConnected")
        );
      },
      { realTimeoutMs: REAL_TIMEOUT_MS, gameTimeoutMs: 60_000 },
    );
    console.log(`Reconnected ${gameMs} ms of game time after the brain came back (${restarted.deploymentId})`);
    // The same Agent, reconnected: its session carries on, its numbering too.
    await advanceGameTime(page, 10_000);
    const rows = stored(dataDirectory).snapshots;
    expect(latestSession(rows)).toBe(sessionBefore);
    expect(rowsOf(rows, sessionBefore, "fast").map((row) => row.sequenceNumber)).toEqual(
      oneUpTo(rowsOf(rows, sessionBefore, "fast").length),
    );
  });

  test("8 GB fresh start: options set in the UI, the first boot typed; every tier arrives within the Agent plus one worker", async () => {
    const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
    const ports = await freeBrainPorts();
    const brain = await brainFor(dataDirectory, ports);
    const page = await freshGame(e2.browser, e2.server);
    running.pages.push(page);
    await exitTutorial(page);
    // As the owner does (docs/setup.md step 4): Options → Remote API, Connect; Options → System, autoexec.
    await page.getByText("Options", { exact: true }).click();
    await page.getByText("Remote API", { exact: true }).click();
    const field = (label: string) => page.locator(".MuiTextField-root", { hasText: label }).locator("input");
    await field("Hostname:").fill("127.0.0.1");
    await field("Port:").fill(String(ports.remoteFileApiPort));
    await field("Reconnection delay:").fill("5");
    await page.getByRole("button", { name: "Connect" }).click();
    await advanceUntil(page, async () => stored(dataDirectory).count("deployed") === 1, {
      realTimeoutMs: REAL_TIMEOUT_MS,
      gameTimeoutMs: 30_000,
    });
    await page.getByText("System", { exact: true }).click();
    // Its label is a paragraph just before the field, not a <label>.
    await page
      .getByText("Autoexec Script + Args", { exact: true })
      .locator("xpath=following-sibling::div[1]//input")
      .fill(BOOT_SCRIPT);
    await page.getByText("Terminal", { exact: true }).click();
    await typeCommand(page, `run ${BOOT_SCRIPT}`);
    await advanceUntil(page, async () => stored(dataDirectory).count("agentConnected") === 1, {
      realTimeoutMs: REAL_TIMEOUT_MS,
      gameTimeoutMs: 30_000,
    });
    await advanceGameTime(page, TWO_GAME_MINUTES_MS);

    // The game's own RAM figures for the Agent and each worker (`mem`).
    const agentFile = deployedFilePath(brain.deploymentId, AGENT_SCRIPT_NAME);
    const workerFiles = SNAPSHOT_TIERS.map((tier) =>
      deployedFilePath(brain.deploymentId, snapshotWorkerFileName(tier)),
    );
    const ramOf: Record<string, number> = {};
    for (const file of [agentFile, ...workerFiles]) {
      const before = (await terminalText(page)).length;
      await typeCommand(page, `mem ${file}`);
      await advanceUntil(page, async () => /requires [\d.]+GB/.test((await terminalText(page)).slice(before)), {
        realTimeoutMs: 10_000,
      });
      const output = (await terminalText(page)).slice(before);
      ramOf[file] = Number(/requires ([\d.]+)GB/.exec(output)?.[1]);
    }
    const limitGb =
      Math.round(((ramOf[agentFile] as number) + Math.max(...workerFiles.map((file) => ramOf[file] as number))) * 100) /
      100;
    expect(limitGb).toBeLessThanOrEqual(8);

    const rows = stored(dataDirectory).snapshots;
    const session = latestSession(rows);
    expect(hasFullSnapshot(rows, session)).toBe(true);
    const medium = rowsOf(rows, session, "medium")[0]?.data as MediumSnapshotData;
    expect(medium.servers.find((server) => server.hostname === "home")).toMatchObject({ maxRam: 8 });
    const fastRows = rowsOf(rows, session, "fast").map((row) => row.data as FastSnapshotData);
    expect(fastRows.length).toBeGreaterThanOrEqual(60);
    let peakRamUsed = 0;
    for (const fast of fastRows) {
      expect(fast.game?.homeMaxRam).toBe(8);
      const files = fast.game?.homeProcesses.map((process) => process.filename) ?? [];
      expect(files[0]).toBe(agentFile);
      expect(files.length).toBeLessThanOrEqual(2);
      peakRamUsed = Math.max(peakRamUsed, fast.game?.homeRamUsed ?? 0);
    }
    expect(peakRamUsed).toBeLessThanOrEqual(limitGb);
    // The page's heap: missing on E2, where Playwright's fake `performance` has no `memory.usedJSHeapSize`.
    const heaps = fastRows.map((fast) => fast.pageHeapUsedBytes).filter((bytes) => typeof bytes === "number");
    const heapText =
      heaps.length === 0
        ? "not reported (Playwright's fake performance)"
        : `${Math.round(Math.min(...heaps) / 2 ** 20)}–${Math.round(Math.max(...heaps) / 2 ** 20)} MiB`;
    console.log(
      `Q1 on E2: ${JSON.stringify(ramOf)}; the Agent plus its largest worker ${limitGb} GB; ` +
        `home RAM in use at each fast snapshot at most ${peakRamUsed} GB of 8; page heap ${heapText}`,
    );
  });
});
