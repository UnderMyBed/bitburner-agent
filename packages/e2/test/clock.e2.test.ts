// Game time under Playwright's clock (#96): an hour of it, a cycle at a time, and how much faster than real time that
// runs (recorded in the README).
import { describe, expect, test } from "vitest";
import { advanceGameTime, closeGame, exitTutorial, freshGame } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";

const e2 = useE2();
const GAME_HOUR_MS = 3_600_000;

describe("game time", () => {
  test("moves only when advanced: an hour of it, and the speed-up over real time", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await exitTutorial(page);
      const before = await page.evaluate(() => Date.now());
      const startedAt = performance.now();
      await advanceGameTime(page, GAME_HOUR_MS);
      const realMs = performance.now() - startedAt;
      expect((await page.evaluate(() => Date.now())) - before).toBe(GAME_HOUR_MS);
      // Still running: the terminal answers.
      await expect(page.locator("#terminal-input").count()).resolves.toBe(1);
      console.log(
        `A game hour took ${Math.round(realMs / 1000)} s of real time: ×${Math.round(GAME_HOUR_MS / realMs)}`,
      );
    } finally {
      await closeGame(page);
    }
  });
});
