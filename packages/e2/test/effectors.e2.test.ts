// The `ui` effectors and the game's dialogs on the real page (#136, #138, #141, #143), end to end. A save with money, a
// real brain, the built Agent: the Agent buys the TOR router at Alpha Enterprises and every port opener through the
// terminal, upgrades home's RAM at Alpha Enterprises, and travels where the owner's manual queue says, as a player
// would, and leaves the page on the Terminal with no dialog open. It closes the game's alerts and answers faction
// invitations, and leaves the owner's and scripts' dialogs alone. Joining a faction (#147) clicks "Join!" past the
// brain's gate for irreversible intents; buying an augmentation (#149) clicks "Buy", never a disabled one. Work (#151,
// #153): faction work started and kept focused on the real page; company work applied for, the hiring's alert closed,
// and worked, then worked again from the Job page in another city; crime (#156) at the Slums; classes (#158) at a
// university, unfocused, and held back by the city and the money guard. Buying a cloud server (#159) needs no page:
// the NS API's `cloud.purchaseServer`, from a worker that fits a fresh save beside the Agent. A backdoor (#162) is
// typed into the real terminal, which is busy for its time: a purchase that types `buy` meanwhile waits for it.
// Installing augmentations (#167): through the page, then the page timer's `run /agent/boot.js` in the terminal, or
// its save-and-reload, cycle after cycle, which answers Q5 (#36).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BOOT_SCRIPT,
  type FastSnapshotData,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import type { Page } from "playwright";
import { afterAll, afterEach, expect, onTestFailed, test } from "vitest";
import {
  advanceGameTime,
  advanceUntil,
  closeGame,
  gameFromSave,
  TERMINAL_INPUT,
  terminalText,
  typeCommand,
  waitForTerminal,
} from "../src/game.ts";
import { freeBrainPorts, type RunningBrain, readStore, startBrain } from "./helpers/brain.ts";
import { useE2 } from "./helpers/environment.ts";
import { simulatorSave, withCity, withGameSettings, withHomeScript, withMoney } from "./helpers/saves.ts";

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

/** The newest fast snapshot the brain has stored, or null: the intents' outcomes are in it. */
function latestFast(dataDirectory: string): FastSnapshotData | null {
  const fast = readStore(dataDirectory)
    .snapshots.filter((row) => row.tier === "fast")
    .at(-1);
  return (fast?.data as FastSnapshotData | undefined) ?? null;
}

const offlineAlertShown = (page: Page) => async () => (await page.getByText(/^Offline for/).count()) > 0;

/**
 * The "Offline for…" alert the game raises 250 ms after loading a save (`engine.tsx`), closed as a player would, so a
 * test starts from the page the Agent would leave (#143 tests the Agent closing it).
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
  gameSettings = {},
  city = "Sector-12",
  homeScripts = {},
  prepareSave = async () => {},
}: {
  money?: number;
  keepOfflineAlert?: boolean;
  beforeAgent?: (page: Page) => Promise<void>;
  brainSettings?: Record<string, string>;
  /** The game's Options, changed in the save (`withGameSettings`). */
  gameSettings?: Record<string, unknown>;
  /** Where the player starts: Sector-12, as in a new game, unless said. */
  city?: string;
  /** Scripts of the owner's on home, by file name (`withHomeScript`). */
  homeScripts?: Record<string, string>;
  /** The simulator's setup of the save, before it's saved (`simulatorSave`'s `prepare`). */
  prepareSave?: (sim: Simulation) => Promise<void>;
} = {}) {
  const dataDirectory = path.join(temporaryDirectory, `data-${++dataDirectoryCount}`);
  const ports = await freeBrainPorts();
  const brain = await startBrain({ dataDirectory, ports, allowedOrigin: e2.server.origin, settings: brainSettings });
  started.brains.push(brain);
  onTestFailed(() => console.log(`The brain's log (${dataDirectory}):\n${brain.log.join("\n")}`));
  const save = withGameSettings(
    withCity(
      withMoney(
        await simulatorSave({
          gameSettings: {
            RemoteFileApiAddress: "127.0.0.1",
            RemoteFileApiPort: ports.remoteFileApiPort,
            RemoteFileApiReconnectionDelay: 1,
            AutoexecScript: BOOT_SCRIPT,
          },
          prepare: prepareSave,
        }),
        money,
      ),
      city,
    ),
    gameSettings,
  );
  const page = await gameFromSave(
    e2.browser,
    e2.server,
    Object.entries(homeScripts).reduce((edited, [filename, code]) => withHomeScript(edited, filename, code), save),
  );
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

/** The brain's `gameDialog` events (#143): the game's dialogs the Agent handled. */
const gameDialogs = (dataDirectory: string) =>
  readStore(dataDirectory)
    .events.filter((event) => event.kind === "gameDialog")
    .map((event) => event.detail as { kind: string; text: string });

test("the 'Offline for…' alert left open after a load (#143): the Agent closes it, tells the brain, and buys", async () => {
  const { dataDirectory, page } = await moneyedGameWithAgent({ money: 300_000, keepOfflineAlert: true });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  expect(gameDialogs(dataDirectory)).toContainEqual({ kind: "alert", text: expect.stringMatching(/^Offline for/) });
});

test("a faction invitation (#143): $20m in Sector-12 earns one, the Agent answers 'Decide later', and it stays open to join", async () => {
  // In Aevum, where $20m earns nothing (its faction wants $40m); the travel to Sector-12 earns Sector-12's ($15m).
  // Earned before the Agent ran, an invitation's dialog would have come and gone with the setup's reload.
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 20_000_000,
    city: "Aevum",
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Sector-12" } });
  // The game checks for invitations every 10 cycles, 2 s (`engine.tsx`, `checkFactionInvitations`).
  await advanceUntil(
    page,
    async () => gameDialogs(dataDirectory).some((dialog) => dialog.kind === "factionInvitation"),
    {
      realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
      gameTimeoutMs: 90_000,
    },
  );
  expect(gameDialogs(dataDirectory).find((dialog) => dialog.kind === "factionInvitation")?.text).toContain("Sector-12");
  await advanceGameTime(page, 12_000);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  // Not joined: that's the brain's call. The invitation waits on the Factions page.
  expect(latestMedium(dataDirectory)?.player.factions).toEqual([]);
  await page.locator("xpath=//div[@role='button' and .//p[normalize-space()='Factions']]").first().click();
  await expect(page.getByRole("button", { name: "Join!" }).count()).resolves.toBe(1);
});

/** The intents the dashboard lists now (`GET /api/status`), with what each waits for. */
async function dashboardIntents(dashboardPort: number): Promise<{ id: string; waitingFor: string | null }[]> {
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/status`);
  return ((await response.json()) as { intents: { id: string; waitingFor: string | null }[] }).intents;
}

test("joining Sector-12 (#147): past the brain's guard and a save backup, the Agent clicks Join! on the Factions page", async () => {
  // As above: the travel to Sector-12 earns the invitation, which the Agent answers "Decide later".
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 20_000_000,
    city: "Aevum",
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Sector-12" } });
  await advanceUntil(
    page,
    async () => gameDialogs(dataDirectory).some((dialog) => dialog.kind === "factionInvitation"),
    { realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 90_000 },
  );

  // A faction with no invitation (and no enemies, so it goes at once): the Factions page has no row to join it by.
  await queueIntent(ports.dashboardPort, { action: "joinFaction", args: { faction: "CyberSec" } });
  const cyberSecOutcome = () => latestFast(dataDirectory)?.intents.find((each) => each.id === "joinFaction(CyberSec)");
  await advanceUntil(page, async () => (cyberSecOutcome()?.tries ?? 0) >= 1, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(cyberSecOutcome()).toMatchObject({
    done: false,
    problem: "no invitation from CyberSec on the Factions page",
    backend: "ui",
  });
  await cancelIntent(ports.dashboardPort, "joinFaction(CyberSec)");

  const queuedAtMs = Date.now();
  await queueIntent(ports.dashboardPort, { action: "joinFaction", args: { faction: "Sector-12" } });
  // Held at first: the guard hasn't held on two medium snapshots yet.
  expect(
    (await dashboardIntents(ports.dashboardPort)).find((each) => each.id === "joinFaction(Sector-12)"),
  ).toMatchObject({ waitingFor: expect.stringMatching(/^waiting for the guard/) });
  // Two medium snapshots (10 s apart), the backup, then the next round's try.
  await advanceUntil(
    page,
    async () => ((latestMedium(dataDirectory)?.player.factions ?? []) as string[]).includes("Sector-12"),
    { realTimeoutMs: 3 * STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 90_000 },
  );
  // A save backup succeeded after the queueing, and before the first medium snapshot showing Sector-12 joined.
  const { events, snapshots } = readStore(dataDirectory);
  const backupAtMs = events.find(
    (event) => event.kind === "saveBackup" && event.atMs >= queuedAtMs && "file" in (event.detail as object),
  )?.atMs;
  const joinedSeenAtMs = snapshots.find(
    (row) =>
      row.tier === "medium" && ((row.data as MediumSnapshotData).player.factions as string[]).includes("Sector-12"),
  )?.receivedAtMs;
  expect(backupAtMs).toBeDefined();
  expect(joinedSeenAtMs).toBeGreaterThan(backupAtMs as number);
  await advanceGameTime(page, 2_000);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});
/** A save in CyberSec with plenty of reputation, as the simulator sets it up: augmentations to buy (#149). */
const inCyberSec = (sim: Simulation) => sim.diagnostics.joinFactionWithReputation("CyberSec", 1e6);

test("buying augmentations (#149): Neurotrainer I and NeuroFlux level 1 from CyberSec, confirmed, alerts closed; again, nothing paid", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 100_000_000,
    prepareSave: inCyberSec,
    // Nothing else moves the money: purchases and the hack loop off.
    brainSettings: ONLY_WORK,
  });
  const moneyBefore = latestMedium(dataDirectory)?.player.money as number;
  await queueIntent(ports.dashboardPort, {
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 },
  });
  await queueIntent(ports.dashboardPort, {
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "NeuroFlux Governor", level: 1 },
  });
  // Each leaves the queue once the Agent reports it done.
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: 3 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  // Paid for: $4m for Neurotrainer I, then NeuroFlux's $750k at the second purchase's 1.9x, about $1.43m.
  // A medium snapshot comes every 10 s, so the money may show a little after the queue empties.
  const spent = () => moneyBefore - (latestMedium(dataDirectory)?.player.money as number);
  await advanceUntil(page, async () => spent() > 5_000_000, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 15_000,
  });
  expect(spent()).toBeLessThan(6_000_000);
  // The worker closed each "You purchased" alert itself: the dialog watcher (#143) reported none.
  expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.startsWith("You purchased"))).toEqual([]);
  // Queued again: done from the page alone (Neurotrainer I's "Owned", NeuroFlux's next level past 1), nothing paid.
  const moneyAfter = latestMedium(dataDirectory)?.player.money;
  await queueIntent(ports.dashboardPort, {
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 },
  });
  await queueIntent(ports.dashboardPort, {
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "NeuroFlux Governor", level: 1 },
  });
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  await advanceGameTime(page, 11_000);
  expect(latestMedium(dataDirectory)?.player.money).toBe(moneyAfter);
  await advanceGameTime(page, 2_000);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("an augmentation the money doesn't cover (#149): its disabled Buy is never clicked, and the reason is the outcome", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    prepareSave: inCyberSec,
    brainSettings: ONLY_WORK,
  });
  // Every dialog that opens, counted in the page: a click on a disabled Buy would open one saying why not.
  await page.evaluate(() => {
    const counts = { opened: 0 };
    (window as unknown as { dialogsOpened: typeof counts }).dialogsOpened = counts;
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && node.matches(".MuiModal-root")) counts.opened += 1;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await queueIntent(ports.dashboardPort, {
    action: "purchaseAugmentation",
    args: { faction: "CyberSec", augmentation: "Neurotrainer I", level: 1 },
  });
  const outcome = () =>
    latestFast(dataDirectory)?.intents.find((each) => each.id === "purchaseAugmentation(CyberSec, Neurotrainer I, 1)");
  await advanceUntil(page, async () => (outcome()?.tries ?? 0) >= 1, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(outcome()).toMatchObject({
    done: false,
    problem: "can't buy Neurotrainer I from CyberSec yet (the money, the reputation or a prerequisite?)",
    backend: "ui",
  });
  expect(
    await page.evaluate(() => (window as unknown as { dialogsOpened: { opened: number } }).dialogsOpened.opened),
  ).toBe(0);
  expect(latestMedium(dataDirectory)?.player.money).toBe(1_000_000);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
});

/** The brain's switches for a test of work alone: no purchases, and the hack loop off. */
const ONLY_WORK = { "programs.enabled": "false", "homeRam.enabled": "false", "hackLoop.enabled": "false" };

/** Sets the work the brain manages (#151, #153, #156, #158), as the dashboard's Work forms do. */
async function setWork(
  dashboardPort: number,
  work:
    | { faction: string; workType: string }
    | { kind: "company"; company: string; field: string }
    | { kind: "crime"; crime: string }
    | { kind: "class"; location: string; classType: string }
    | null,
) {
  const origin = `http://127.0.0.1:${dashboardPort}`;
  const response = await fetch(`${origin}/api/work`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ work }),
  });
  expect(response.status, await response.text()).toBe(200);
}

/** The Work page's title for CyberSec's hacking contracts: shown while the player is focused on them. */
const HACKING_FOR_CYBERSEC_TITLE = "You are currently carrying out hacking contracts for CyberSec";
const workPageShown = (page: Page) => async () =>
  (await page.locator("h6", { hasText: HACKING_FOR_CYBERSEC_TITLE }).count()) > 0;

test("faction work (#151): started focused on the real page, refocused after the owner unfocuses, and kept through a travel", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    prepareSave: inCyberSec,
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, { faction: "CyberSec", workType: "hacking" });
  await advanceUntil(page, workPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 20_000 });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });

  // The owner does something else: within the activity's 30 s, the Agent focuses again.
  await page.getByRole("button", { name: "Do something else simultaneously" }).click();
  await expect(workPageShown(page)()).resolves.toBe(false);
  await advanceUntil(page, workPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 40_000 });

  // Focused again, not started again: a restart would have raised the "You worked for…" alert (`Work/FactionWork.tsx`).
  expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.startsWith("You worked for"))).toEqual([]);

  // A travel while focused: the Work page hides the sidebar, so the travel unfocuses, flies, and focuses again.
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Aevum" } });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.player.city === "Aevum", {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  await advanceGameTime(page, 2_000);
  await expect(workPageShown(page)()).resolves.toBe(true);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);

  // No longer managed: the work is left as it is.
  await setWork(ports.dashboardPort, null);
  await advanceGameTime(page, 35_000);
  await expect(workPageShown(page)()).resolves.toBe(true);
});

test("safe mode (#160): with the brain stopped, the Agent refocuses the work on the real page; after a reload too, the 'Offline for…' alert closed", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    prepareSave: inCyberSec,
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, { faction: "CyberSec", workType: "hacking" });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  // The brain gone for good: the Agent keeps the last desired state (agent/desired-state.json).
  for (const brain of started.brains) await brain.stop();
  /** The owner does something else: within the work's 30 s, the Agent focuses again, with no brain to say so. */
  const refocusedAfterTheOwner = async () => {
    await page.getByRole("button", { name: "Do something else simultaneously" }).click();
    await expect(workPageShown(page)()).resolves.toBe(false);
    await advanceUntil(page, workPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 40_000 });
  };
  await refocusedAfterTheOwner();

  // Past an autosave, a reload: the work loads focused (`ui/GameRoot.tsx:169-171`), autoexec starts the Agent, and it
  // has only the file. It closes the load's "Offline for…" alert, brain or not.
  await advanceUntil(page, async () => (await page.getByText("Game Saved!").count()) > 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: AUTOSAVE_GAME_TIMEOUT_MS,
  });
  await page.reload();
  await page.locator("h6", { hasText: HACKING_FOR_CYBERSEC_TITLE }).waitFor({ timeout: STEP_REAL_TIMEOUT_MS });
  await advanceUntil(page, offlineAlertShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 2_000 });
  await advanceUntil(page, async () => (await page.locator(OPEN_DIALOG).count()) === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  await refocusedAfterTheOwner();
});

test("faction work unfocused (#151): with the Neuroreceptor Management Implant installed, started then left unfocused, not restarted", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: async (sim) => {
      await inCyberSec(sim);
      await sim.diagnostics.giveInstalledAugmentation("Neuroreceptor Management Implant");
    },
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, { faction: "CyberSec", workType: "hacking" });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  // Working, unfocused: the overview says so, the Work page isn't open, and the page is on the Terminal.
  await expect(page.locator("p", { hasText: /^Working for CyberSec$/ }).count()).resolves.toBe(1);
  await expect(workPageShown(page)()).resolves.toBe(false);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  // Seen as converged from the overview from then on: no restart, so no "You worked for…" alert.
  await advanceGameTime(page, 35_000);
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });
  expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.startsWith("You worked for"))).toEqual([]);
});

test("faction work a faction doesn't offer (#151): not converged, with the page's reason, and the page left on the Terminal", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: inCyberSec,
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, { faction: "CyberSec", workType: "field" });
  await advanceUntil(page, async () => (latestFast(dataDirectory)?.work?.backend ?? null) !== null, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({
    converged: false,
    problem: 'no "Field Work" on CyberSec\'s page (does it offer field work?)',
    backend: "ui",
  });
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
});

/** The Work page's title for a waiter at Noodle Bar: shown while the player is focused on the job. */
const waiterPageShown = (page: Page) => async () =>
  (await page.locator("h6", { hasText: "You are currently working as a Waiter at Noodle Bar" }).count()) > 0;
const NOODLE_BAR_WAITER = { kind: "company", company: "Noodle Bar", field: "Waiter" } as const;

test("company work (#153): in New Tokyo, hired as a Waiter at Noodle Bar, the alert closed, worked focused; refocused, not restarted; after a travel, its Job page", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    city: "New Tokyo",
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, NOODLE_BAR_WAITER);
  await advanceUntil(page, waiterPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 20_000 });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });
  // The worker closed the hiring's alert itself: the dialog watcher, which would close it too, never saw it.
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.startsWith("Congratulations"))).toEqual([]);
  const hired = () => JSON.stringify(latestMedium(dataDirectory)?.player.jobs) === '{"Noodle Bar":"Waiter"}';
  await advanceUntil(page, async () => hired(), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 12_000 });

  // The owner does something else: within the activity's 30 s, the Agent focuses again, without starting the work
  // again (which would end it first: "You finished working for Noodle Bar", `Work/CompanyWork.tsx`), or applying again.
  await page.getByRole("button", { name: "Do something else simultaneously" }).click();
  await expect(waiterPageShown(page)()).resolves.toBe(false);
  await advanceUntil(page, waiterPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 40_000 });
  expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.startsWith("You finished working for"))).toEqual([]);

  // A travel to Aevum, then the owner stops working there: the job is still held (`getPlayer().jobs`), so within 30 s
  // the Agent clicks its "Work" on the sidebar's Job page, away from Noodle Bar's city.
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Aevum" } });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.player.city === "Aevum", {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  await advanceGameTime(page, 2_000);
  await expect(waiterPageShown(page)()).resolves.toBe(true);
  await page.getByRole("button", { name: "Stop working" }).click();
  await expect(waiterPageShown(page)()).resolves.toBe(false);
  await advanceUntil(page, waiterPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 40_000 });
  expect(latestMedium(dataDirectory)?.player.city).toBe("Aevum");
  await advanceGameTime(page, 4_000);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("company work in another city (#153): not converged, saying where the player is, and the page left on the Terminal", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, NOODLE_BAR_WAITER);
  await advanceUntil(page, async () => (latestFast(dataDirectory)?.work?.backend ?? null) !== null, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({
    converged: false,
    problem: "no Noodle Bar in the city (is the player in its city?)",
    backend: "ui",
  });
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
});

/** The Work page's title while the player is focused on shoplifting, and the overview's header while unfocused. */
const shopliftingPageShown = (page: Page) => async () =>
  (await page.locator("h6", { hasText: /^You are attempting to shoplift$/ }).count()) > 0;
const shopliftingOverviewShown = (page: Page) => async () =>
  (await page.locator("p", { hasText: /^You are attempting to Shoplift$/ }).count()) > 0;

test("crime (#156): shoplifting started focused at the Slums on the real page, and focused again after the owner unfocuses", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({ brainSettings: ONLY_WORK });
  await setWork(ports.dashboardPort, { kind: "crime", crime: "Shoplift" });
  await advanceUntil(page, shopliftingPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 20_000 });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });
  // The owner does something else (the game goes to the City): within the activity's 30 s, the Agent focuses again
  // with the overview's "Focus", never going back to the Slums, which would start the crime again, losing its progress.
  await page.getByRole("button", { name: "Do something else simultaneously" }).click();
  await expect(shopliftingPageShown(page)()).resolves.toBe(false);
  await expect(shopliftingOverviewShown(page)()).resolves.toBe(true);
  await page.evaluate(() => {
    const seen = { slums: 0 };
    new MutationObserver(() => {
      if ((document.body.textContent ?? "").includes("chance of success")) seen.slums = 1;
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { slumsSeen: typeof seen }).slumsSeen = seen;
  });
  await advanceUntil(page, shopliftingPageShown(page), { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 40_000 });
  await expect(
    page.evaluate(() => (window as unknown as { slumsSeen: { slums: number } }).slumsSeen.slums),
  ).resolves.toBe(0);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("crime unfocused (#156): with the Neuroreceptor Management Implant installed, started then left unfocused on the Terminal", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: (sim) => sim.diagnostics.giveInstalledAugmentation("Neuroreceptor Management Implant"),
    brainSettings: ONLY_WORK,
  });
  await setWork(ports.dashboardPort, { kind: "crime", crime: "Shoplift" });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  await expect(shopliftingOverviewShown(page)()).resolves.toBe(true);
  await expect(shopliftingPageShown(page)()).resolves.toBe(false);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await advanceGameTime(page, 35_000);
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });
  await expect(shopliftingOverviewShown(page)()).resolves.toBe(true);
});

/** Whether the overview's header says `text` exactly: the player's work, unfocused. */
const overviewSays = (page: Page, text: string) => async () =>
  (await page
    .locator("p")
    .filter({ hasText: new RegExp(`^${text}$`) })
    .count()) > 0;
/** Whether the Work page's title starts "You are currently": the player focused on any work. */
const focusedOnWork = (page: Page) => async () =>
  (await page
    .locator("h6")
    .filter({ hasText: /^You are currently / })
    .count()) > 0;

test("a class (#158): Computer Science at Rothman University started and left unfocused on the Terminal; then a paid course in its place", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({ money: 1_000_000, brainSettings: ONLY_WORK });
  await setWork(ports.dashboardPort, { kind: "class", location: "Rothman University", classType: "Computer Science" });
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 30_000,
  });
  // Unfocused (focus gains a class nothing), on the Terminal: the overview says what it is.
  await expect(overviewSays(page, "You are studying Computer Science")()).resolves.toBe(true);
  await expect(focusedOnWork(page)()).resolves.toBe(false);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await advanceGameTime(page, 35_000);
  expect(latestFast(dataDirectory)?.work).toEqual({ converged: true, problem: null, backend: "ui" });
  await expect(overviewSays(page, "You are studying Computer Science")()).resolves.toBe(true);
  // A paid course in its place ($1m covers 10 minutes of $120 a second): the class the page started ends with the
  // game's "After studying Computer Science for …" alert, which the dialog watcher closes.
  await setWork(ports.dashboardPort, { kind: "class", location: "Rothman University", classType: "Data Structures" });
  await advanceUntil(page, overviewSays(page, "You are taking a Data Structures course"), {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  await advanceUntil(
    page,
    async () => gameDialogs(dataDirectory).some((dialog) => dialog.text.startsWith("After studying Computer Science")),
    { realTimeoutMs: STEP_REAL_TIMEOUT_MS, gameTimeoutMs: 10_000 },
  );
  await advanceUntil(page, async () => latestFast(dataDirectory)?.work?.converged === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
});

test("a class held back (#158): a gym in Aevum from Sector-12, and a paid course without 10 minutes of its cost; nothing started", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({ money: 1_000, brainSettings: ONLY_WORK });
  const problemNow = () => latestFast(dataDirectory)?.work?.problem ?? null;
  await setWork(ports.dashboardPort, { kind: "class", location: "Crush Fitness Gym", classType: "str" });
  await advanceUntil(page, async () => problemNow() !== null, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(latestFast(dataDirectory)?.work).toEqual({
    converged: false,
    problem: "Crush Fitness Gym is in Aevum, and the player is in Sector-12 (travel there first)",
    backend: "ui",
  });
  await setWork(ports.dashboardPort, { kind: "class", location: "Rothman University", classType: "Data Structures" });
  await advanceUntil(page, async () => problemNow()?.startsWith("Data Structures") === true, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(problemNow()).toBe(
    "Data Structures at Rothman University costs $120 a second: the Agent starts it with 10 minutes of that " +
      "($72,000) or more, and the player has $1,000",
  );
  // The page untouched: no class under way, the Terminal, and the money as it was.
  await expect(
    page
      .locator("p")
      .filter({ hasText: /^You are (studying|taking|training)/ })
      .count(),
  ).resolves.toBe(0);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  // From a medium snapshot taken after the effector ran.
  const mediums = () => readStore(dataDirectory).snapshots.filter((row) => row.tier === "medium").length;
  const mediumsNow = mediums();
  await advanceUntil(page, async () => mediums() > mediumsNow, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 15_000,
  });
  expect(latestMedium(dataDirectory)?.player.money).toBe(1_000);
});

/** What the terminal shows once the page timer's `run /agent/boot.js` has started it (`Terminal/commands/runScript.ts`). */
const BOOT_STARTED = /> run \/agent\/boot\.js\s+Running script with 1 thread, pid \d+ and args: \[\]\./;
const eventsOf = (dataDirectory: string, kind: string) =>
  readStore(dataDirectory).events.filter((event) => event.kind === kind);
/** The newest slow snapshot the brain has stored, or null: the installed augmentations and the last reset. */
function latestSlow(dataDirectory: string): SlowSnapshotData | null {
  const slow = readStore(dataDirectory)
    .snapshots.filter((row) => row.tier === "slow")
    .at(-1);
  return (slow?.data as SlowSnapshotData | undefined) ?? null;
}
/** The Agent's first slow snapshot's last reset: the game's, before anything is installed. */
async function firstLastAugReset(page: Page, dataDirectory: string): Promise<number> {
  await advanceUntil(page, async () => latestSlow(dataDirectory) !== null, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 10_000,
  });
  return latestSlow(dataDirectory)?.resetInfo.lastAugReset as number;
}
/** Q5's evidence (#36): each install cycle's restart, and its game time from the Agent's death to the next Agent. */
const q5Cycles: { cycle: string; path: "terminal" | "reload"; agentBackGameMs: number }[] = [];
afterAll(() => {
  if (q5Cycles.length > 0) console.log(`Q5 cycles: ${JSON.stringify(q5Cycles)}`);
});

/**
 * One install through the page (#167), from a save the simulator sets up: `installed` already installed, `queued`
 * queued, and the game's Options changed by `gameSettings`. With `ownerLine`, the owner has left that line typed in the
 * terminal, which the page timer never types over. Runs until the Agent that installed has died and the next is
 * connected, and returns what the test checks.
 */
async function installedThroughThePage({
  installed,
  queued,
  gameSettings = {},
  ownerLine = "",
  ownerCommand = "",
}: {
  installed: string[];
  queued: string;
  gameSettings?: Record<string, unknown>;
  ownerLine?: string;
  /** A command the owner ran in the terminal before the install, as `cd agent`. */
  ownerCommand?: string;
}) {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: async (sim) => {
      for (const augmentation of installed) await sim.diagnostics.giveInstalledAugmentation(augmentation);
      await sim.diagnostics.queueAugmentation(queued);
    },
    gameSettings,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  // The browser's own dialogs, answered as a player at the screen would: "stay" on the unload prompt, which would
  // stop a reload the page asked for (with no listener, Playwright lets every navigation through: ../src/game.ts).
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => {
    browserDialogs.push(dialog.type());
    void dialog.dismiss().catch(() => {});
  });
  if (ownerCommand !== "") await typeCommand(page, ownerCommand);
  if (ownerLine !== "") {
    // Typed as a player types: the page then has the user's activation, so its unload prompt would really ask.
    await page.locator(TERMINAL_INPUT).focus();
    await page.keyboard.type(ownerLine);
  }
  const unloadPromptArmed = await page.evaluate(() => typeof window.onbeforeunload === "function");
  const lastAugResetBefore = await firstLastAugReset(page, dataDirectory);
  await queueIntent(ports.dashboardPort, { action: "installAugmentations", args: {} });
  // The gate (two medium snapshots, a backup), then the worker installs: the Agent dies with it.
  await advanceUntil(page, async () => eventsOf(dataDirectory, "agentDisconnected").length > 0, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  // Then the next Agent: through the terminal, or after the fallback's reload, which the steps can't drive through.
  let agentBackGameMs = 0;
  const agentBack = async () => eventsOf(dataDirectory, "agentConnected").length === 2;
  const deadline = performance.now() + 2 * STEP_REAL_TIMEOUT_MS;
  while (!(await agentBack())) {
    if (performance.now() > deadline || agentBackGameMs > 60_000) throw new Error("the next Agent never connected");
    try {
      await advanceGameTime(page, 200);
      agentBackGameMs += 200;
    } catch (error) {
      // A reload under way: the game's clock is back once it has loaded. The clock can fail a moment before the
      // navigation is reported, so that gets a moment too.
      if (navigations.length === 0) await page.waitForEvent("framenavigated", { timeout: 5_000 }).catch(() => {});
      if (navigations.length === 0) throw error;
      await waitForTerminal(page);
    }
  }
  q5Cycles.push({ cycle: queued, path: navigations.length === 0 ? "terminal" : "reload", agentBackGameMs });
  return { dataDirectory, page, ports, navigations, unloadPromptArmed, lastAugResetBefore, browserDialogs };
}

/** After the install: the next Agent's slow snapshot shows it, and the brain takes the install off its queue. */
async function expectInstalled(page: Page, dataDirectory: string, augmentations: string[], lastAugResetBefore: number) {
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  const resetInfo = latestSlow(dataDirectory)?.resetInfo;
  expect(Object.keys(resetInfo?.ownedAugs ?? {}).sort()).toEqual([...augmentations].sort());
  // Another reset: not a later one here, as the game takes it from the page's clock, which E2 starts near 0 while the
  // simulator's save is from 2026 (the brain counts any change: #167).
  expect(resetInfo?.lastAugReset).not.toBe(lastAugResetBefore);
}

/** The augmentations the install cycles queue, one each, the ones before it installed in its save. */
const CYCLE_AUGMENTATIONS = ["Neurotrainer I", "BitWire", "Synaptic Enhancement Implant", "Neurotrainer II"];

test("installing through the page (#167, Q5): cycle after cycle, the page timer's `run /agent/boot.js` brings the Agent back, with no reload", async () => {
  for (const [index, queued] of CYCLE_AUGMENTATIONS.entries()) {
    const installed = CYCLE_AUGMENTATIONS.slice(0, index);
    // Every other cycle with the install's confirmation turned off in Options: Install itself installs.
    const gameSettings = index % 2 === 1 ? { SuppressBuyAugmentationConfirmation: true } : {};
    // The last two with the owner's `cd agent` first: an install leaves the terminal there, so the line is absolute.
    const ownerCommand = index >= 2 ? "cd agent" : "";
    const cycle = await installedThroughThePage({ installed, queued, gameSettings, ownerCommand });
    const { dataDirectory, page, navigations } = cycle;
    expect(navigations, `cycle ${index + 1}`).toEqual([]);
    expect(await terminalText(page)).toMatch(BOOT_STARTED);
    if (ownerCommand !== "") expect(await terminalText(page)).toMatch(/\[home \/agent\/\]> run \/agent\/boot\.js/);
    await expectInstalled(page, dataDirectory, [...installed, queued], cycle.lastAugResetBefore);
    // The install's alert was closed by the page timer, before the next Agent's dialog watcher ever saw it.
    expect(gameDialogs(dataDirectory).filter((dialog) => dialog.text.includes("You slowly drift"))).toEqual([]);
    await advanceGameTime(page, 4_000);
    await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
    await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
    // Done with this game: the next cycle has its own page and brain.
    for (const opened of started.pages.splice(0)) await closeGame(opened).catch(() => {});
    for (const brain of started.brains.splice(0)) await brain.stop();
  }
});

test("the restart's fallback (#167, Q5): a line the owner left in the terminal, so the timer saves and reloads; autoexec, twice", async () => {
  for (const [index, queued] of ["Neurotrainer I", "BitWire"].entries()) {
    const installed = index === 0 ? [] : ["Neurotrainer I"];
    const cycle = await installedThroughThePage({ installed, queued, ownerLine: "ls" });
    const { dataDirectory, page, navigations } = cycle;
    // The production build's unload prompt was armed (the owner's typing made it ask): the timer cleared it, so the
    // game's own save-then-reload went through.
    expect(cycle.unloadPromptArmed).toBe(true);
    expect(navigations, `cycle ${index + 1}`).toHaveLength(1);
    expect(cycle.browserDialogs).toEqual([]);
    // The reloaded game was saved after the install: it's installed, and autoexec brought the Agent back.
    await expectInstalled(page, dataDirectory, [...installed, queued], cycle.lastAugResetBefore);
    expect(await terminalText(page)).not.toMatch(BOOT_STARTED);
    for (const opened of started.pages.splice(0)) await closeGame(opened).catch(() => {});
    for (const brain of started.brains.splice(0)) await brain.stop();
  }
});

test("installing with nothing queued (#167): the Augmentations page's Install is disabled, so it's done, with no reset", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: (sim) => sim.diagnostics.giveInstalledAugmentation("Neurotrainer I"),
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  const lastAugResetBefore = await firstLastAugReset(page, dataDirectory);
  await queueIntent(ports.dashboardPort, { action: "installAugmentations", args: {} });
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  // The Agent's report, at its first try: the page shows nothing left to install.
  const reported = readStore(dataDirectory)
    .snapshots.filter((row) => row.tier === "fast")
    .flatMap((row) => (row.data as FastSnapshotData).intents ?? [])
    .filter((outcome) => outcome.id === "installAugmentations()" && outcome.done);
  expect(reported[0]).toMatchObject({ done: true, problem: null, backend: "ui", tries: 1 });
  expect(eventsOf(dataDirectory, "agentDisconnected")).toEqual([]);
  expect(latestSlow(dataDirectory)?.resetInfo.lastAugReset).toBe(lastAugResetBefore);
  await advanceGameTime(page, 2_000);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

/** The dashboard's alerts now, as its page reads them (`GET /api/status`). */
async function dashboardAlerts(dashboardPort: number): Promise<{ name: string; detail: string }[]> {
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/status`);
  return ((await response.json()) as { alerts: { name: string; detail: string }[] }).alerts;
}

test("a dialog the owner opened (#143): left alone, nothing bought under it, and the dashboard's alert quotes it", async () => {
  // The owner asks to travel and leaves the confirmation open, before the Agent's first round.
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 300_000,
    beforeAgent: async (page) => {
      await page.locator("xpath=//div[@role='button' and .//p[normalize-space()='Travel']]").first().click();
      await page
        .locator("xpath=//h4[normalize-space()='Travel Agency']/following::p/span[normalize-space()='A']")
        .click();
    },
  });
  await advanceGameTime(page, 60_000);
  await expect(page.getByText(/^Would you like to travel to Aevum/).count()).resolves.toBe(1);
  expect(latestMedium(dataDirectory)?.hasTorRouter).toBe(false);
  const blocking = (await dashboardAlerts(ports.dashboardPort)).find((alert) => alert.name === "dialogBlocking");
  expect(blocking?.detail).toMatch(/"Would you like to travel to Aevum/);
  // The owner cancels: the TOR router follows, and the alert goes.
  await page.getByRole("button", { name: "Cancel" }).click();
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.hasTorRouter === true, {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 4_000);
  expect((await dashboardAlerts(ports.dashboardPort)).map((alert) => alert.name)).not.toContain("dialogBlocking");
});

test("a script's ns.alert and ns.prompt (#143): the owner's, so both are left open, and nothing is bought under them", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 300_000,
    homeScripts: {
      "owner.js":
        'export async function main(ns) { ns.alert("Your script says hello"); await ns.prompt("Buy the server?"); }',
    },
    beforeAgent: (page) => typeCommand(page, "run owner.js"),
  });
  await advanceGameTime(page, 30_000);
  await expect(page.getByText("Your script says hello").count()).resolves.toBe(1);
  await expect(page.getByText("Buy the server?").count()).resolves.toBe(1);
  expect(latestMedium(dataDirectory)?.hasTorRouter).toBe(false);
  // The game's own alerts may be handled meanwhile, but nothing of the script's.
  expect(gameDialogs(dataDirectory).filter((dialog) => /hello|Buy the server/.test(dialog.text))).toEqual([]);
  expect((await dashboardAlerts(ports.dashboardPort)).map((alert) => alert.name)).toContain("dialogBlocking");
  // The owner answers both, each with its own button (one dialog's backdrop sits over the other: the click goes to the
  // button itself): the purchase follows.
  await page.getByRole("button", { name: "No" }).dispatchEvent("click");
  await page
    .locator(OPEN_DIALOG)
    .filter({ hasText: "Your script says hello" })
    .locator("button")
    .first()
    .dispatchEvent("click");
  await advanceGameTime(page, 1_000);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
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

test("buying a server (#159): queued on the dashboard, pserv-0 bought through the NS API; queued again, nothing paid", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    // Nothing else moves the money: purchases and the hack loop off.
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false", "hackLoop.enabled": "false" },
  });
  const moneyBefore = latestMedium(dataDirectory)?.player.money as number;
  await queueIntent(ports.dashboardPort, { action: "buyServer", args: { hostname: "pserv-0", ram: 8 } });
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  const pserv0 = () => latestMedium(dataDirectory)?.servers.find((server) => server.hostname === "pserv-0");
  await advanceUntil(page, async () => pserv0() !== undefined, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 15_000,
  });
  // The player's, with root, at 8 GB, for 8 × $55k; the worker didn't touch the page.
  expect(pserv0()).toMatchObject({ maxRam: 8, hasAdminRights: true });
  expect(latestMedium(dataDirectory)?.player.money).toBe(moneyBefore - 440_000);
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
  // Queued again: done from the game alone, and no second server (the game would have named it pserv-0-0).
  await queueIntent(ports.dashboardPort, { action: "buyServer", args: { hostname: "pserv-0", ram: 8 } });
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  await advanceGameTime(page, 11_000);
  expect(latestMedium(dataDirectory)?.player.money).toBe(moneyBefore - 440_000);
  expect(latestMedium(dataDirectory)?.servers.map((server) => server.hostname)).not.toContain("pserv-0-0");
});

/**
 * A save where nectar-net (layer 2, required level 20, no ports) can be backdoored: 500 hacking exp, level 22 (the
 * simulator's `gainHackingExp`), and NUKE.exe run on it by the owner's script.
 */
async function nectarNetReady(sim: Simulation) {
  await sim.diagnostics.gainHackingExp(500);
  await sim.writeFile("home", "owner-nuke.js", 'export async function main(ns) { ns.nuke("nectar-net"); }');
  expect((await sim.run("home", "owner-nuke.js")).error).toBeUndefined();
  await sim.advance(1_000);
}

test("a backdoor (#162): typed into the real terminal, home and connect by connect; a purchase meanwhile is 'terminal busy' until it ends", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: nectarNetReady,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false", "hackLoop.enabled": "false" },
    // The owner has left the terminal on n00dles: the way to nectar-net starts from home, so `home` comes first.
    beforeAgent: (page) => typeCommand(page, "connect n00dles"),
  });
  await queueIntent(ports.dashboardPort, { action: "backdoor", args: { hostname: "nectar-net" } });
  await queueIntent(ports.dashboardPort, { action: "buyTor", args: { vendor: "Alpha Enterprises" } });
  await queueIntent(ports.dashboardPort, { action: "buyProgram", args: { program: "BruteSSH.exe" } });
  const outcome = (id: string) => latestFast(dataDirectory)?.intents.find((each) => each.id === id);
  await advanceUntil(page, async () => (outcome("buyProgram(BruteSSH.exe)")?.tries ?? 0) >= 1, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  // The backdoor's action runs (about 26 s at level 22): the input is disabled, and `buy` isn't typed.
  expect(outcome("backdoor(nectar-net)")?.problem).toMatch(/^installing the backdoor on nectar-net: about \d+ s left$/);
  expect(outcome("buyProgram(BruteSSH.exe)")).toMatchObject({ done: false, problem: "terminal busy", backend: "ui" });
  await expect(page.locator(TERMINAL_INPUT).isDisabled()).resolves.toBe(true);
  expect(await terminalText(page)).not.toContain("buy BruteSSH.exe");
  // Then each is done: the backdoor's next try types `home`, and the purchase's types `buy`.
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: 3 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 90_000,
  });
  await advanceGameTime(page, 11_000);
  const medium = latestMedium(dataDirectory);
  expect(medium?.servers.find((server) => server.hostname === "nectar-net")?.backdoorInstalled).toBe(true);
  expect(medium?.programs).toContain("BruteSSH.exe");
  // The terminal's own words, in order: the owner's connect, home, two connects, the backdoor, home again.
  const text = await terminalText(page);
  const at = (words: string) => text.indexOf(words);
  expect(at("Connected to home")).toBeGreaterThan(at("Connected to n00dles"));
  expect(at("Connected to nectar-net")).toBeGreaterThan(at("Connected to home"));
  expect(at("Backdoor on 'nectar-net' successful!")).toBeGreaterThan(at("Connected to nectar-net"));
  expect(text.lastIndexOf("Connected to home")).toBeGreaterThan(at("Backdoor on 'nectar-net' successful!"));
  expect((text.match(/Connected to /g) ?? []).length).toBeGreaterThanOrEqual(5);
  // The purchase's `buy` was typed only after the backdoor ended.
  expect(text.indexOf("buy BruteSSH.exe")).toBeGreaterThan(at("Backdoor on 'nectar-net' successful!"));
  // Left home (the input's prompt, `Terminal/ui/TerminalInput.tsx:453-455`), the input free, no dialog.
  await expect(page.locator(TERMINAL_INPUT).locator("xpath=preceding-sibling::p").innerText()).resolves.toMatch(
    /^\[home\s\/\]>/,
  );
  await expect(page.locator(TERMINAL_INPUT).isDisabled()).resolves.toBe(false);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("a short backdoor (#162): one that ends within the round is waited for, and done at the first try, the terminal home", async () => {
  // Level 1,000 or so (the simulator's `gainHackingExp`): n00dles's hacking time is about 2.4 s, its backdoor 0.6 s.
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    prepareSave: async (sim) => {
      await sim.diagnostics.gainHackingExp(1e17);
      await sim.writeFile("home", "owner-nuke.js", 'export async function main(ns) { ns.nuke("n00dles"); }');
      expect((await sim.run("home", "owner-nuke.js")).error).toBeUndefined();
      await sim.advance(1_000);
    },
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false", "hackLoop.enabled": "false" },
  });
  await queueIntent(ports.dashboardPort, { action: "backdoor", args: { hostname: "n00dles" } });
  const outcome = () => latestFast(dataDirectory)?.intents.find((each) => each.id === "backdoor(n00dles)");
  await advanceUntil(page, async () => (outcome()?.tries ?? 0) >= 1, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(outcome()).toMatchObject({ done: true, tries: 1, problem: null, backend: "ui" });
  const text = await terminalText(page);
  expect(text.lastIndexOf("Connected to home")).toBeGreaterThan(text.indexOf("Backdoor on 'n00dles' successful!"));
  await expect(page.locator(TERMINAL_INPUT).locator("xpath=preceding-sibling::p").innerText()).resolves.toMatch(
    /^\[home\s\/\]>/,
  );
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

/** Takes an intent off the dashboard's queue, as its Cancel button does. */
async function cancelIntent(dashboardPort: number, id: string) {
  const origin = `http://127.0.0.1:${dashboardPort}`;
  const response = await fetch(`${origin}/api/intents/cancel`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  expect(response.status, await response.text()).toBe(200);
}

/** Counts the game's travel dialogs as they open, in the page, for a test to read back. */
const countTravelDialogs = (page: Page) =>
  page.evaluate(() => {
    const seen = { confirmation: 0, alert: 0 };
    new MutationObserver(() => {
      const text = document.body.textContent ?? "";
      if (text.includes("Would you like to travel to")) seen.confirmation = 1;
      if (text.includes("You are now in")) seen.alert = 1;
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { travelDialogsSeen: typeof seen }).travelDialogsSeen = seen;
  });
const travelDialogsSeen = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { travelDialogsSeen: { confirmation: number; alert: number } }).travelDialogsSeen,
  );

test("travel (#141): queued on the dashboard, the Agent flies to Aevum, confirming and closing the alert", async () => {
  // Purchases off, so the travel is all the page does; the game's Options show the confirmation and the alert.
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  await countTravelDialogs(page);
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
  // The game asked, and said so, and the Agent answered both.
  await expect(travelDialogsSeen(page)).resolves.toEqual({ confirmation: 1, alert: 1 });
  // Done, as the Agent reported, so the brain took it off the queue.
  await advanceUntil(page, async () => readStore(dataDirectory).manualIntents.length === 0, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
});

test("travel with ASCII art off and the confirmation turned off in Options: the city's button, and no dialog", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 1_000_000,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
    gameSettings: { DisableASCIIArt: true, SuppressTravelConfirmation: true },
  });
  await countTravelDialogs(page);
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Volhaven" } });
  await advanceUntil(page, async () => latestMedium(dataDirectory)?.player.city === "Volhaven", {
    realTimeoutMs: 2 * STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 60_000,
  });
  await advanceGameTime(page, 2_000);
  await expect(travelDialogsSeen(page)).resolves.toEqual({ confirmation: 0, alert: 0 });
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});

test("travel without the ticket's money: not done, the reason logged as the outcome, and the page left as it was", async () => {
  const { dataDirectory, page, ports } = await moneyedGameWithAgent({
    money: 100_000,
    brainSettings: { "programs.enabled": "false", "homeRam.enabled": "false" },
  });
  await queueIntent(ports.dashboardPort, { action: "travel", args: { city: "Aevum" } });
  const outcome = () => latestFast(dataDirectory)?.intents.find((each) => each.id === "travel(Aevum)");
  await advanceUntil(page, async () => (outcome()?.tries ?? 0) >= 1, {
    realTimeoutMs: STEP_REAL_TIMEOUT_MS,
    gameTimeoutMs: 20_000,
  });
  expect(outcome()).toMatchObject({
    done: false,
    problem: "not in Aevum after travelling (is the $200k ticket there?)",
    // The page: a browser has no simulator effectors, and E2's game has no Singularity (#145).
    backend: "ui",
  });
  expect(latestMedium(dataDirectory)?.player.city).toBe("Sector-12");
  await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
  await expect(page.locator(OPEN_DIALOG).count()).resolves.toBe(0);
});
