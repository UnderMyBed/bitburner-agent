// Fixtures for E2 tests: a browser, the game opened from a save or brand new, the tutorial exited, the terminal typed in
// and read, and game time moved on (packages/e2/README.md).
//
// Time is split. Playwright's clock fakes the page's timers, `Date` and `performance`, so game time moves only when a
// test advances it. Script imports and WebSockets still run in real time, so game time moves in small steps, at most
// MAX_GAME_SPEEDUP times as fast as real time, so real-time work gets real time to happen in. Tests wait for conditions
// with real-time timeouts, never fixed sleeps.
import { gunzipSync } from "node:zlib";
import { playerLastUpdate } from "@bitburner-agent/sim";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { diagnoseLoad, UNREADABLE_PREFIX } from "./load-diagnosis.ts";
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
 * How long a fixture's first try at a load gets before it reloads the page and waits again (#120): a load takes under
 * 1 s on the reference rig (at most 837 ms over 474 loads and reloads), so this is ample.
 */
const FIRST_LOAD_TIMEOUT_MS = 20_000;
/**
 * What a load that fails adds to its error: the page's visible text, cut to this; its first and last events (the first
 * is often the cause); and the requests still pending.
 */
const LOAD_FAILURE_TEXT_CHARACTERS = 1_500;
const LOAD_FAILURE_FIRST_EVENTS_SHOWN = 5;
const LOAD_FAILURE_LAST_EVENTS_SHOWN = 20;
const LOAD_FAILURE_PENDING_REQUESTS_SHOWN = 10;

/** What a game page went through, recorded from its start, so a load that fails can say. */
interface PageHistory {
  /** Navigations, page errors, console errors, failed requests and a crash, in order. */
  events: string[];
  /** Requests sent and not yet finished or failed: a load stuck on a fetch logs nothing else. */
  pendingRequests: Set<string>;
}
const historyByPage = new WeakMap<Page, PageHistory>();

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
  const page = await context.newPage();
  const history: PageHistory = { events: [], pendingRequests: new Set() };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) history.events.push(`navigated to ${frame.url()}`);
  });
  page.on("pageerror", (error) => history.events.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") history.events.push(`console error: ${message.text()}`);
  });
  page.on("crash", () => history.events.push("the page crashed"));
  page.on("request", (request) => history.pendingRequests.add(request.url()));
  page.on("requestfinished", (request) => history.pendingRequests.delete(request.url()));
  page.on("requestfailed", (request) => {
    history.pendingRequests.delete(request.url());
    history.events.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  historyByPage.set(page, history);
  return page;
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

/**
 * Waits, in real time, for the game to finish loading (its terminal's input is on the page), after a fixture's load or
 * a reload. If it doesn't, the error says what the page showed, what it went through (navigations, errors, failed
 * requests, a crash) and the requests still pending: a load that never finishes says nothing else.
 */
export async function waitForTerminal(page: Page, { timeoutMs = LOAD_TIMEOUT_MS } = {}): Promise<void> {
  try {
    await page.locator(TERMINAL_INPUT).waitFor({ timeout: timeoutMs });
  } catch (error) {
    // Why the text can't be read tells a hung page (a timeout) from a crashed or closed one.
    const visibleText = await page
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch((readError: Error) => `${UNREADABLE_PREFIX}: ${readError.message.split("\n")[0]})`);
    const { events, pendingRequests } = historyByPage.get(page) ?? { events: [], pendingRequests: new Set() };
    const eventsShown =
      events.length <= LOAD_FAILURE_FIRST_EVENTS_SHOWN + LOAD_FAILURE_LAST_EVENTS_SHOWN
        ? events
        : [
            ...events.slice(0, LOAD_FAILURE_FIRST_EVENTS_SHOWN),
            `…${events.length - LOAD_FAILURE_FIRST_EVENTS_SHOWN - LOAD_FAILURE_LAST_EVENTS_SHOWN} more…`,
            ...events.slice(-LOAD_FAILURE_LAST_EVENTS_SHOWN),
          ];
    const pending = [...pendingRequests].slice(0, LOAD_FAILURE_PENDING_REQUESTS_SHOWN);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        message,
        `Looks like: ${diagnoseLoad(visibleText)}`,
        `The page showed: ${visibleText.slice(0, LOAD_FAILURE_TEXT_CHARACTERS)}`,
        `What it went through:\n${eventsShown.join("\n") || "nothing recorded"}`,
        `Requests still pending: ${pending.join(", ") || "none"}`,
      ].join("\n"),
      { cause: error },
    );
  }
}

/**
 * Waits for a fixture's load (`waitForTerminal`), and if it hasn't shown the terminal within `firstTimeoutMs`, reloads
 * the page once and waits again (#120: one load in about 15 suite runs never showed it, and loads hundreds of times in a
 * row didn't: packages/e2/README.md). The first try's report goes to `warn`, so a retried load still shows in the run's output; a load that
 * fails again throws with both reports. Only for a fixture's own load: a test's reload is what it tests.
 */
export async function untilGameLoaded(
  page: Page,
  {
    firstTimeoutMs = FIRST_LOAD_TIMEOUT_MS,
    retryTimeoutMs = LOAD_TIMEOUT_MS,
    warn = (message: string) => console.warn(message),
  }: { firstTimeoutMs?: number; retryTimeoutMs?: number; warn?: (message: string) => void } = {},
): Promise<void> {
  let firstReport: string;
  try {
    return await waitForTerminal(page, { timeoutMs: firstTimeoutMs });
  } catch (error) {
    firstReport = error instanceof Error ? error.message : String(error);
  }
  warn(`E2: the game didn't load within ${firstTimeoutMs} ms, so the page is reloaded once (#120).\n${firstReport}`);
  try {
    await page.reload();
    await waitForTerminal(page, { timeoutMs: retryTimeoutMs });
  } catch (error) {
    const retryReport = error instanceof Error ? error.message : String(error);
    throw new Error(`The game didn't load, twice (#120). The first try:\n${firstReport}\nThe retry:\n${retryReport}`, {
      cause: error,
    });
  }
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
    await untilGameLoaded(page);
    // From here on, game time moves only when the test moves it.
    if (clockDuringLoad === "running") await pauseFlowingClock(page);
  });
}

/**
 * Pauses a clock that's flowing in real time, a game cycle ahead of the page's time as just read: real time passes
 * before the pause lands, and the clock can't be set back. Game time so jumps on by up to a cycle, and timers due in the
 * jump run once. If even a cycle had passed, Playwright refuses, but has paused the clock first (Playwright 1.59), so
 * pausing a cycle ahead of the page's time then lands.
 */
async function pauseFlowingClock(page: Page): Promise<void> {
  const pauseAhead = async () => page.clock.pauseAt((await page.evaluate(() => Date.now())) + GAME_CYCLE_MS);
  try {
    await pauseAhead();
  } catch (error) {
    if (!String(error).includes("Cannot fast-forward to the past")) throw error;
    await pauseAhead();
  }
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
    await untilGameLoaded(page);
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
