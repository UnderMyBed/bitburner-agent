// The `ui` effectors on the real page (#136, #138, #141), end to end. A save with money, a real brain, the built Agent:
// the Agent buys the TOR router at Alpha Enterprises and every port opener through the terminal, upgrades home's RAM
// at Alpha Enterprises, and travels where the owner's manual queue says, as a player would, and leaves the page on the
// Terminal with no dialog open.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOT_SCRIPT, type MediumSnapshotData, PORT_OPENER_PROGRAMS } from "@bitburner-agent/core";
import type { Page } from "playwright";
import { afterAll, afterEach, expect, onTestFailed, test } from "vitest";
import {
  advanceGameTime,
  advanceUntil,
  closeGame,
  gameFromSave,
  TERMINAL_INPUT,
  waitForTerminal,
} from "../src/game.ts";
import { freeBrainPorts, type RunningBrain, readStore, startBrain } from "./helpers/brain.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave, withMoney } from "./helpers/saves.ts";

const e2 = useE2();
/** The game autosaves every 60 s; a deploy is in the save only after it (#91). */
const AUTOSAVE_GAME_TIMEOUT_MS = 65_000;
const STEP_REAL_TIMEOUT_MS = 60_000;
/**
 * Six purchases, each seen by the brain in a medium snapshot (10 s) before the next is asked for: about 12 s each. A
 * try that fails waits 30 s, so this leaves no room for one: each item is bought at the first try.
 */
const ALL_BOUGHT_GAME_TIMEOUT_MS = 100_000;
/** Any dialog open: the game's alerts and prompts (MUI's `Modal`). */
const OPEN_DIALOG = ".MuiModal-root";
/** Enough for TOR and every program: $200k + $286.5m. */
const MONEY = 1e9;

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "e2-programs-"));
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
const started: { brains: RunningBrain[]; pages: Page[] } = { brains: [], pages: [] };
afterEach(async () => {
  for (const page of started.pages.splice(0)) await closeGame(page).catch(() => {});
  for (const brain of started.brains.splice(0)) await brain.stop();
});
let dataDirectoryCount = 0;

/** The newest medium snapshot the brain has stored, or null. */
function latestMedium(dataDirectory: string): MediumSnapshotData | null {
  const medium = readStore(dataDirectory)
    .snapshots.filter((row) => row.tier === "medium")
    .at(-1);
  return (medium?.data as MediumSnapshotData | undefined) ?? null;
}

const offlineAlertShown = (page: Page) => async () => (await page.getByText(/^Offline for/).count()) > 0;

/**
 * The "Offline for…" alert the game raises 250 ms after loading a save (`engine.tsx`), closed as a player would: the
 * Agent buys nothing over an open dialog.
 */
async function closeOfflineAlert(page: Page): Promise<void> {
  await advanceUntil(page, offlineAlertShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 2_000 });
  await page.keyboard.press("Escape");
  await advanceUntil(page, async () => (await page.locator(OPEN_DIALOG).count()) === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 2_000,
  });
}

const allOwned = (medium: MediumSnapshotData | null) =>
  medium?.hasTorRouter === true && PORT_OPENER_PROGRAMS.every((program) => medium.programs.includes(program));

/**
 * A save with money and the brain's Remote File API and autoexec in its settings; the brain deploys, with
 * `brainSettings` in its store; past an autosave and a reload, autoexec starts the Agent. The reload's "Offline for…"
 * alert is closed, unless `keepOfflineAlert`; then `beforeAgent` runs on the page, before the Agent's first round.
 */
async function moneyedGameWithAgent({
  money = MONEY,
  keepOfflineAlert = false,
  beforeAgent = async () => {},
  brainSettings = {},
}: {
  money?: number;
  keepOfflineAlert?: boolean;
  beforeAgent?: (page: Page) => Promise<void>;
  brainSettings?: Record<string, string>;
} = {}) {
  const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
  const ports = await freeBrainPorts();
  const brain = await startBrain({ dataDirectory, ports, allowedOrigin: e2.server.origin, settings: brainSettings });
  started.brains.push(brain);
  onTestFailed(() => console.log(`The brain's log (${dataDirectory}):\n${brain.log.join("\n")}`));
  const save = withMoney(
    await simulatorSave({
      gameSettings: {
        RemoteFileApiAddress: "127.0.0.1",
        RemoteFileApiPort: ports.remoteFileApiPort,
        RemoteFileApiReconnectionDelay: 1,
        AutoexecScript: BOOT_SCRIPT,
      },
    }),
    money,
  );
  const page = await gameFromSave(e2.browser, e2.server, save);
  started.pages.push(page);
  const eventCount = (kind: string) => readStore(dataDirectory).events.filter((event) => event.kind === kind).length;
  await advanceUntil(page, async () => eventCount("deployed") === 1, { realTimeoutMs: STEP_REAL_TIMEOUT_MS });
  await advanceUntil(page, async () => (await page.getByText("Game Saved!").count()) > 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: AUTOSAVE_GAME_TIMEOUT_MS,
  });
  await page.reload();
  await waitForTerminal(page);
  // Game time stands still until the test moves it, so the Agent hasn't had a round yet.
  if (!keepOfflineAlert) await closeOfflineAlert(page);
  await beforeAgent(page);
  await advanceUntil(page, async () => eventCount("agentConnected") === 1, { realTimeoutMs: STEP_REAL_TIMEOUT_MS });
  return { dataDirectory, page, ports };
}

test("with money, the Agent buys the TOR router at Alpha Enterprises and every port opener, and leaves the page as it was", async () => {
  // Home RAM off: with this much money its upgrades would go in between, cheapest first (#138).
  const { dataDirectory, page } = await moneyedGameWithAgent({ brainSettings: { "homeRam.enabled": "false" } });
  await advanceUntil(page, async () => allOwned(latestMedium(dataDirectory)), {
    realTimeoutMs: 4 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: ALL_BOUGHT_GAME_TIMEOUT_MS,
  });
  // Paid for, at the game's prices: $200k for TOR, $286.5m for the five programs. The hack loop earns a few million
  // meanwhile, so the bound allows for that.
  const money = latestMedium(dataDirectory)?.player.money as number;
  expect(money).toBeLessThanOrEqual(MONEY - 250_000_000);
  // Back on the Terminal, and no dialog left open.
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("the TOR router alone: bought, its dialog closed, and the page back on the Terminal", async () => {
  // Enough for the TOR router ($200k), not for BruteSSH.exe ($500k): nothing after it moves the page.
  const { dataDirectory, page } = await moneyedGameWithAgent({ money: 300_000 });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 2_000);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  expect(latestMedium(dataDirectory)?.programs).toEqual([]);
});

/** The sidebar's "World" section header, which holds City: the click goes to the header itself, wherever it sits. */
const toggleWorldSection = (page: Page) =>
  page.locator("xpath=//div[@role='button' and .//p[normalize-space()='World']]").first().dispatchEvent("click");

test("with the sidebar's World section collapsed, City can't be reached: nothing is bought until it's open again", async () => {
  // The owner collapses the section that holds City before the Agent's first round (its items unmount:
  // Sidebar/ui/SidebarAccordion.tsx).
  const { dataDirectory, page } = await moneyedGameWithAgent({ beforeAgent: toggleWorldSection });
  // The section unmounts once its collapse animation has run: game time (the page's clock is the test's).
  await advanceGameTime(page, 2_000);
  await expect(page.locator("xpath=//div[@role='button' and .//p[normalize-space()='City']]").count()).resolves.toBe(0);
  await advanceGameTime(page, 60_000);
  expect(latestMedium(dataDirectory)?.hasTorRouter).toBe(false);
  await toggleWorldSection(page);
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
});

test("with a dialog open, nothing is bought until the owner closes it", async () => {
  const { dataDirectory, page } = await moneyedGameWithAgent({ keepOfflineAlert: true });
  await advanceUntil(page, offlineAlertShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 2_000 });
  await advanceGameTime(page, 60_000);
  // The alert is as the game left it, and the page wasn't touched under it.
  await expect(page.getByText(/^Offline for/).count()).resolves.toBe(1);
  expect(latestMedium(dataDirectory)?.hasTorRouter).toBe(false);
  await page.keyboard.press("Escape");
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
});

const homeRamOf = (medium: MediumSnapshotData | null) =>
  medium?.servers.find((server) => server.hostname === "home")?.maxRam;

test("home RAM (#138): with $1.1m and buying programs off, home goes from 8 GB to 16 GB at Alpha Enterprises, no further", async () => {
  // $1.01m for 16 GB; 32 GB's $3.19m is beyond what the hack loop earns meanwhile. A new save starts in Sector-12, so
  // the vendor is Alpha Enterprises: the only one the page could buy it at there.
  const { dataDirectory, page } = await moneyedGameWithAgent({
    money: 1_100_000,
    brainSettings: { "programs.enabled": "false" },
  });
  await advanceUntil(page, async () => homeRamOf(latestMedium(dataDirectory)) === 16, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 30_000);
  const medium = latestMedium(dataDirectory);
  expect(homeRamOf(medium)).toBe(16);
  // Paid for (the hack loop earns some meanwhile), and nothing else bought.
  expect(medium?.player.money as number).toBeLessThan(600_000);
  expect(medium?.hasTorRouter).toBe(false);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

/** Queues an intent on the brain's dashboard, as its page does: from its own origin, as JSON. */
async function queueIntent(dashboardPort: number, request: { action: string; args: Record<string, unknown> }) {
  const origin = `http://127.0.0.1:${dashboardPort}`;
  const response = await fetch(`${origin}/api/intents`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(response.status, await response.text()).toBe(200);
}

test("travel (#141): queued on the dashboard, the Agent flies to Aevum, confirming and closing the alert", async () => {
  // Purchases off, so the travel is all the page does; the game's Options show the confirmation and the alert.
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Aevum" } });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.player.city === "Aevum", {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 2_000);
  const medium = latestMedium(dataDirectory);
  // The $200k ticket, and nothing else bought.
  expect(medium?.player.money as number).toBeLessThan(1_000_000 - 150_000);
  expect(medium?.hasTorRouter).toBe(false);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  // Done in the game, so the brain took it off the queue.
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
});
