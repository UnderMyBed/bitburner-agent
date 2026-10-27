// Buying the hacking programs on the real page (#136): the first `ui` effector, end to end. A save with money, a real
// brain, the built Agent: the Agent buys the TOR router at Alpha Enterprises and every port opener through the
// terminal, as a player would, and leaves the page on the Terminal with no dialog open.
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
/** Six purchases, each seen by the brain in a medium snapshot (10 s) before the next is asked for. */
const ALL_BOUGHT_GAME_TIMEOUT_MS = 240_000;
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

const allOwned = (medium: MediumSnapshotData | null) =>
  medium?.hasTorRouter === true && PORT_OPENER_PROGRAMS.every((program) => medium.programs.includes(program));

/**
 * A save with money and the brain's Remote File API and autoexec in its settings; the brain deploys; past an autosave
 * and a reload, autoexec starts the Agent. `beforeAgent` runs on the page just before the reload's Agent starts.
 */
async function moneyedGameWithAgent({
  money = MONEY,
  beforeAgent = async () => {},
}: {
  money?: number;
  beforeAgent?: (page: Page) => Promise<void>;
} = {}) {
  const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
  const ports = await freeBrainPorts();
  const brain = await startBrain({ dataDirectory, ports, allowedOrigin: e2.server.origin });
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
  await beforeAgent(page);
  await advanceUntil(page, async () => eventCount("agentConnected") === 1, { realTimeoutMs: STEP_REAL_TIMEOUT_MS });
  return { dataDirectory, page };
}

test("with money, the Agent buys the TOR router at Alpha Enterprises and every port opener, and leaves the page as it was", async () => {
  const { dataDirectory, page } = await moneyedGameWithAgent();
  await advanceUntil(page, async () => allOwned(latestMedium(dataDirectory)), {
    realTimeoutMs: 4 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: ALL_BOUGHT_GAME_TIMEOUT_MS,
  });
  // Paid for, at the game's prices: $200k for TOR, $286.5m for the five programs. The hack loop earns a few million
  // meanwhile, so the bound allows for that.
  const money = latestMedium(dataDirectory)?.player.money as number;
  expect(money).toBeLessThanOrEqual(MONEY - 250_000_000);
  // Back on the Terminal, and the purchase's dialog closed.
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.getByText("You have purchased a TOR router").count()).resolves.toBe(0);
  // Nothing more is bought: the next minute, the money holds.
  await advanceGameTime(page, 60_000);
  expect(latestMedium(dataDirectory)?.player.money).toBeGreaterThanOrEqual(money);
});

test("the TOR router alone: bought, its dialog closed, and the page back on the Terminal", async () => {
  // Enough for the TOR router ($200k), not for BruteSSH.exe ($500k): nothing after it moves the page.
  const { dataDirectory, page } = await moneyedGameWithAgent({ money: 300_000 });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 2_000);
  await expect(page.getByText("You have purchased a TOR router").count()).resolves.toBe(0);
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
