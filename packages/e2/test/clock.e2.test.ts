// Game time under Playwright's clock (#96): ten minutes of it, a cycle at a time, paced; the game's engine still
// running after it; and a reload keeping it (recorded in the README).
import type { Page } from "playwright";
import { describe, expect, test } from "vitest";
import {
  advanceGameTime,
  advanceUntil,
  closeGame,
  exitTutorial,
  freshGame,
  MAX_GAME_SPEEDUP,
  TERMINAL_INPUT,
  waitForTerminal,
} from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";

const e2 = useE2();
const TEN_GAME_MINUTES_MS = 600_000;

/**
 * That the game's engine is running: `analyze` is a terminal action the engine's loop finishes after 1 s of game time
 * (Date.now() moving proves only the clock).
 */
async function expectEngineRunning(page: Page): Promise<void> {
  await page.locator(TERMINAL_INPUT).click();
  await page.keyboard.type("analyze");
  await page.keyboard.press("Enter");
  const { gameMs } = await advanceUntil(
    page,
    async () => (await page.locator("#terminal").innerText()).includes("Root Access:"),
    {
      gameTimeoutMs: 5_000,
      realTimeoutMs: 30_000,
    },
  );
  expect(gameMs).toBeGreaterThanOrEqual(1_000);
}

describe("game time", () => {
  test("moves only when advanced, at most MAX_GAME_SPEEDUP times real time, and the engine runs on it", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await exitTutorial(page);
      const before = await page.evaluate(() => Date.now());
      const startedAt = performance.now();
      await advanceGameTime(page, TEN_GAME_MINUTES_MS);
      const realMs = performance.now() - startedAt;
      expect((await page.evaluate(() => Date.now())) - before).toBe(TEN_GAME_MINUTES_MS);
      const speedup = TEN_GAME_MINUTES_MS / realMs;
      console.log(`Ten game minutes took ${Math.round(realMs / 1000)} s of real time: ×${speedup.toFixed(1)}`);
      expect(speedup).toBeLessThanOrEqual(MAX_GAME_SPEEDUP);
      await expectEngineRunning(page);
      // A reload keeps game time: Playwright replays the clock's history (one entry per step) into the new page.
      const afterAnalyze = await page.evaluate(() => Date.now());
      const reloadStartedAt = performance.now();
      await page.reload();
      await waitForTerminal(page);
      console.log(`A reload after it took ${Math.round(performance.now() - reloadStartedAt)} ms`);
      expect(await page.evaluate(() => Date.now())).toBe(afterAnalyze);
      await expectEngineRunning(page);
    } finally {
      await closeGame(page);
    }
  });
});
