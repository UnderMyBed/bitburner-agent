// Fixtures for E2 tests: a browser, the game opened from a save or brand new, the tutorial exited, and game time
// moved on (packages/e2/README.md).
//
// Time is split. Playwright's clock fakes the page's timers, `Date` and `performance`, so game time moves only when a
// test advances it. Script imports and WebSockets still run in real time, so game time moves in small steps, at most
// MAX_GAME_SPEEDUP times as fast as real time, so real-time work gets real time to happen in. Tests wait for conditions
// with real-time timeouts, never fixed sleeps.
import { gunzipSync } from "node:zlib";
import { playerLastUpdate } from "@bitburner-agent/sim";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { BLANK_PAGE_PATH, type GameServer } from "./server.ts";

/** One game cycle (the engine's 200 ms tick): the step game time moves in. */
export const GAME_CYCLE_MS = 200;
/**
 * The most game time runs ahead of real time. At ×20, the Agent's 5 s worker timeout gives an import or a reply 250 ms
 * of real time: a reply 50 ms late tripped it at the ×126 an unpaced clock reached. Raise it only with a test showing
 * real-time work still fits.
 */
export const MAX_GAME_SPEEDUP = 20;
/** The game's terminal input: on the page once the game has loaded. */
export const TERMINAL_INPUT = "#terminal-input";
/** How long a fixture waits, in real time, for the game to load. */
const LOAD_TIMEOUT_MS = 60_000;

/**
 * Whether game time stands still while the page loads ("paused", the default: a save loads at exactly its own time,
 * with no offline progress), or runs in real time until the game has loaded, as on Steam ("running": for checking a
 * race between a timer and the load).
 */
export type ClockDuringLoad = "paused" | "running";

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      `Couldn't start Playwright's Chromium (if it isn't installed: npm run e2:install). (${error instanceof Error ? error.message : error})`,
    );
  }
}

/**
 * A page in a new browser context (so its own, empty IndexedDB), with the clock installed before anything loads, at
 * `startTimeMs` (the game's "now"), and paused unless `clockDuringLoad` is "running". The production build asks
 * before unloading, but with no dialog listener Playwright's own navigations aren't blocked by it (the reload test
 * checks): a test that listens for dialogs must accept that one itself.
 */
async function newGamePage(browser: Browser, startTimeMs: number, clockDuringLoad: ClockDuringLoad): Promise<Page> {
  const context = await browser.newContext();
  try {
    return await setUpGamePage(context, startTimeMs, clockDuringLoad);
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function setUpGamePage(
  context: BrowserContext,
  startTimeMs: number,
  clockDuringLoad: ClockDuringLoad,
): Promise<Page> {
  await context.clock.install({ time: startTimeMs });
  // Installed, the clock flows with real time; paused, game time moves only when a test moves it.
  if (clockDuringLoad === "paused") await context.clock.pauseAt(startTimeMs);
  // Playwright's fake timers call back with `this` null; a browser's call back with `this` the window. The game relies
  // on that: `Engine.start` reschedules itself unbound and sets `this.isRunning`. Registered after the clock's own
  // script, so this wraps the fakes.
  await context.addInitScript(() => {
    for (const name of ["setTimeout", "setInterval", "requestAnimationFrame"] as const) {
      const faked = window[name] as (handler: unknown, ...rest: unknown[]) => number;
      (window as unknown as Record<string, unknown>)[name] = (handler: unknown, ...rest: unknown[]) =>
        faked.call(
          window,
          typeof handler === "function"
            ? (...args: unknown[]) => (handler as (...a: unknown[]) => unknown).apply(window, args)
            : handler,
          ...rest,
        );
    }
  });
  return await context.newPage();
}

/**
 * Moves game time on by `ms`, one game cycle at a time, never more than MAX_GAME_SPEEDUP times as fast as real time.
 * Between steps the page runs its real-time work (imports, socket messages) in real time.
 */
export async function advanceGameTime(page: Page, ms: number): Promise<void> {
  const startedAt = performance.now();
  for (let advanced = 0; advanced < ms; ) {
    const step = Math.min(GAME_CYCLE_MS, ms - advanced);
    await page.clock.runFor(step);
    advanced += step;
    // Pacing, not a test's sleep: real time for imports and replies to happen in.
    const aheadMs = advanced / MAX_GAME_SPEEDUP - (performance.now() - startedAt);
    if (aheadMs > 0) await new Promise((resolve) => setTimeout(resolve, aheadMs));
  }
}

/**
 * Moves game time on, a cycle at a time, until `condition` holds. Fails after `realTimeoutMs` of real time, or after
 * `gameTimeoutMs` of game time if given. Wait for real-time work (an import, a reply) this way, on its effect.
 */
export async function advanceUntil(
  page: Page,
  condition: () => Promise<boolean>,
  { realTimeoutMs, gameTimeoutMs = Number.POSITIVE_INFINITY }: { realTimeoutMs: number; gameTimeoutMs?: number },
): Promise<{ gameMs: number }> {
  const deadline = performance.now() + realTimeoutMs;
  for (let gameMs = 0; ; gameMs += GAME_CYCLE_MS) {
    if (await condition()) return { gameMs };
    if (gameMs >= gameTimeoutMs) throw new Error(`Not met within ${gameTimeoutMs} ms of game time`);
    if (performance.now() > deadline) throw new Error(`Not met within ${realTimeoutMs} ms of real time`);
    await advanceGameTime(page, GAME_CYCLE_MS);
  }
}

/** Waits, in real time, for the game to finish loading: its terminal's input is on the page. */
export async function waitForTerminal(page: Page): Promise<void> {
  await page.locator(TERMINAL_INPUT).waitFor({ timeout: LOAD_TIMEOUT_MS });
}

/** `Player.lastUpdate` in a save (gzip bytes, as Steam writes them): when it was taken. */
export function saveLastUpdate(save: Uint8Array): number {
  return playerLastUpdate(gunzipSync(save).toString("utf8"));
}

/**
 * The game loaded from `save` (the gzip bytes a save file holds, e.g. from the simulator's `save()`). Game time starts
 * `offlineMs` after the save was taken, as the simulator's save fixture does: 0, the default, for no offline progress.
 * The save goes into the game's IndexedDB (`bitburnerSave` v2, store `savestring`, key `save`;
 * vendor/bitburner-src/src/db.ts) from a blank page on the origin, before the game loads.
 */
export async function gameFromSave(
  browser: Browser,
  server: GameServer,
  save: Uint8Array,
  { offlineMs = 0, clockDuringLoad = "paused" }: { offlineMs?: number; clockDuringLoad?: ClockDuringLoad } = {},
): Promise<Page> {
  const page = await newGamePage(browser, saveLastUpdate(save) + offlineMs, clockDuringLoad);
  return await closedIfItFails(page, async () => {
    await page.goto(`${server.origin}${BLANK_PAGE_PATH}`);
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("bitburnerSave", 2);
        request.onupgradeneeded = () => request.result.createObjectStore("savestring");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("savestring", "readwrite");
        transaction.objectStore("savestring").put(bytes, "save");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("The save's transaction was aborted"));
      });
      database.close();
    }, Buffer.from(save).toString("base64"));
    await page.goto(server.origin);
    await waitForTerminal(page);
    // From here on, game time moves only when the test moves it.
    if (clockDuringLoad === "running") await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  });
}

/** `page` once `load` has run on it; if `load` fails, the page's context is closed and the error rethrown. */
async function closedIfItFails(page: Page, load: () => Promise<void>): Promise<Page> {
  try {
    await load();
    return page;
  } catch (error) {
    await page.context().close();
    throw error;
  }
}

/** A brand-new game: 8 GB of home RAM, with the tutorial running. */
export async function freshGame(
  browser: Browser,
  server: GameServer,
  { startTimeMs = Date.UTC(2026, 0, 1) }: { startTimeMs?: number } = {},
): Promise<Page> {
  const page = await newGamePage(browser, startTimeMs, "paused");
  return await closedIfItFails(page, async () => {
    await page.goto(server.origin);
    await waitForTerminal(page);
  });
}

/**
 * Types `command` into the game's terminal and presses Enter. It focuses the input rather than clicking it: a toast
 * (which closes on a game timer, so stays while game time stands still) can lie over it.
 */
export async function typeCommand(page: Page, command: string): Promise<void> {
  await page.locator(TERMINAL_INPUT).focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** The terminal's output so far. */
export function terminalText(page: Page): Promise<string> {
  return page.locator("#terminal").innerText();
}

/** Clicks the tutorial's "Exit Tutorial" button, and waits for the tutorial to close. */
export async function exitTutorial(page: Page): Promise<void> {
  const exitButton = page.getByRole("button", { name: "Exit Tutorial" });
  await exitButton.click();
  await advanceUntil(page, async () => (await exitButton.count()) === 0, { realTimeoutMs: 10_000 });
}

/** Closes the page's browser context (and with it the page). */
export async function closeGame(page: Page): Promise<void> {
  await page.context().close();
}
