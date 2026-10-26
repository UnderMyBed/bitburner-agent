// Fixtures for E2 tests: a browser, the game opened from a save or brand new, the tutorial exited, and game time
// moved on (packages/e2/README.md).
//
// Time is split. Playwright's clock fakes the page's timers, `Date` and `performance`, so game time moves only when a
// test advances it. Script imports and WebSockets still run in real time, so game time moves in small steps, each
// followed by letting the page's real-time work run, and tests wait for conditions with real-time timeouts, never
// fixed sleeps.
import { type Browser, chromium, type Page } from "playwright";
import { BLANK_PAGE, type GameServer } from "./server.ts";

/** One game cycle (the engine's 200 ms tick): the step game time moves in. */
export const GAME_CYCLE_MS = 200;
/** How long a fixture waits, in real time, for the game to load. */
const LOAD_TIMEOUT_MS = 60_000;

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    throw new Error(
      `Couldn't start Playwright's Chromium: run npm run e2:install. (${error instanceof Error ? error.message : error})`,
    );
  }
}

/**
 * A page in a new browser context (so its own, empty IndexedDB), with the clock installed before anything loads, at
 * `startTimeMs` (the game's "now"), paused. The production build asks before unloading, but with no dialog listener,
 * Playwright's own navigations aren't blocked by it (the reload test checks): a test that listens for dialogs must
 * accept that one itself.
 */
async function newGamePage(browser: Browser, startTimeMs: number): Promise<Page> {
  const context = await browser.newContext();
  await context.clock.install({ time: startTimeMs });
  // Installed, the clock still flows with real time; paused, game time moves only when a test moves it.
  await context.clock.pauseAt(startTimeMs);
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

/** Lets the page run whatever real-time work is ready (a finished import, a socket message): one real task. */
async function settle(page: Page): Promise<void> {
  // A MessageChannel task: Playwright's clock doesn't fake it, so it runs in real time.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      }),
  );
}

/** Moves game time on by `ms`, one game cycle at a time, letting real-time work run after each. */
export async function advanceGameTime(page: Page, ms: number): Promise<void> {
  for (let advanced = 0; advanced < ms; advanced += GAME_CYCLE_MS) {
    await page.clock.runFor(Math.min(GAME_CYCLE_MS, ms - advanced));
    await settle(page);
  }
}

/**
 * Moves game time on, a cycle at a time, until `condition` holds. Fails after `realTimeoutMs` of real time, or after
 * `gameTimeoutMs` of game time if given.
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

/**
 * Waits, in real time, for the game to finish loading: its terminal's input is on the page. Game time stands still
 * meanwhile, so a save loads at exactly the time the clock started at, with no offline progress.
 */
async function waitForTerminal(page: Page): Promise<void> {
  await page.locator("#terminal-input").waitFor({ timeout: LOAD_TIMEOUT_MS });
}

/**
 * The game loaded from `save` (the gzip bytes a save file holds, e.g. from the simulator's `save()`), with game time
 * starting at `startTimeMs`: the save's own time, for no offline progress. The save goes into the game's IndexedDB
 * (`bitburnerSave` v2, store `savestring`, key `save`; src/db.ts) from a blank page on the origin, before the game loads.
 */
export async function gameFromSave(
  browser: Browser,
  server: GameServer,
  save: Uint8Array,
  { startTimeMs }: { startTimeMs: number },
): Promise<Page> {
  const page = await newGamePage(browser, startTimeMs);
  await page.goto(`${server.origin}${BLANK_PAGE}`);
  await page.evaluate(async (bytes) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bitburnerSave", 2);
      request.onupgradeneeded = () => request.result.createObjectStore("savestring");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("savestring", "readwrite");
      transaction.objectStore("savestring").put(new Uint8Array(bytes), "save");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, Array.from(save));
  await page.goto(server.origin);
  await waitForTerminal(page);
  return page;
}

/** A brand-new game: 8 GB of home RAM, with the tutorial running. */
export async function freshGame(
  browser: Browser,
  server: GameServer,
  { startTimeMs = Date.UTC(2026, 0, 1) }: { startTimeMs?: number } = {},
): Promise<Page> {
  const page = await newGamePage(browser, startTimeMs);
  await page.goto(server.origin);
  await waitForTerminal(page);
  return page;
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
