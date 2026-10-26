// The fixtures, on the built game (#96): a simulator-made save loads, a reload gets through the unload prompt, a
// brand-new game's tutorial can be exited, and a script started by the save runs on the stepped clock.
import type { Page } from "playwright";
import { describe, expect, test } from "vitest";
import {
  advanceUntil,
  closeGame,
  exitTutorial,
  freshGame,
  gameFromSave,
  TERMINAL_INPUT,
  waitForTerminal,
} from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";
import { moneyInSave, simulatorSave } from "./helpers/saves.ts";

const e2 = useE2();

const MONEY_SUFFIXES: Record<string, number> = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** The overview's Money, as shown (e.g. `$1.234k`), and the most the shown value can be off by from rounding. */
async function shownMoney(page: Page): Promise<{ value: number; rounding: number; text: string }> {
  const row = page.locator("tr", { has: page.locator("th", { hasText: /^Money/ }) });
  const text = (await row.locator("td").first().innerText()).trim();
  const match = /^\$(\d+)(?:\.(\d+))?([kmbt]?)$/.exec(text);
  if (!match) throw new Error(`Unexpected money text: ${text}`);
  const [, whole, decimals = "", suffix = ""] = match as unknown as [string, string, string?, string?];
  const unit = MONEY_SUFFIXES[suffix] as number;
  return { value: Number(`${whole}.${decimals || "0"}`) * unit, rounding: (unit * 10 ** -decimals.length) / 2, text };
}

/** Types `command` into the game's terminal and presses Enter. */
async function typeCommand(page: Page, command: string): Promise<void> {
  await page.locator(TERMINAL_INPUT).click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const terminalText = (page: Page) => page.locator("#terminal").innerText();

describe("the game in Playwright", () => {
  test("a simulator-made save loads to the Terminal, and the overview shows the save's money", async () => {
    // Money of its own: the player has hacked n00dles for a while. No script runs in the save, so nothing changes it.
    const save = await simulatorSave({
      prepare: async (sim) => {
        await sim.writeFile(
          "home",
          "earn.js",
          'export async function main(ns) { ns.nuke("n00dles"); while (true) await ns.hack("n00dles"); }',
        );
        const { pid } = await sim.run("home", "earn.js");
        await sim.advance(10 * 60_000);
        await sim.kill(pid);
      },
    });
    const money = moneyInSave(save);
    expect(money).toBeGreaterThan(1_000);
    const page = await gameFromSave(e2.browser, e2.server, save);
    try {
      await expect(page.locator(TERMINAL_INPUT).count()).resolves.toBe(1);
      const shown = await shownMoney(page);
      expect(Math.abs(shown.value - money), `shown ${shown.text}, saved ${money}`).toBeLessThanOrEqual(shown.rounding);
    } finally {
      await closeGame(page);
    }
  });

  test("a reload with the unload prompt armed gets through it, and loads the game again", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await exitTutorial(page);
      // Typing counts as the user using the page, after which the browser does show the game's unload prompt.
      await typeCommand(page, "help");
      await expect(page.evaluate(() => window.onbeforeunload !== null)).resolves.toBe(true);
      await expect(page.evaluate(() => navigator.userActivation.hasBeenActive)).resolves.toBe(true);
      await page.evaluate(() => Object.assign(window, { beforeReload: true }));
      await page.reload();
      await waitForTerminal(page);
      await expect(page.evaluate(() => "beforeReload" in window)).resolves.toBe(false);
    } finally {
      await closeGame(page);
    }
  });

  test("a brand-new game starts in the tutorial, which exitTutorial closes, with 8 GB of home RAM", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await expect(page.getByRole("button", { name: "Exit Tutorial" }).count()).resolves.toBe(1);
      await exitTutorial(page);
      await expect(page.getByRole("button", { name: "Exit Tutorial" }).count()).resolves.toBe(0);
      await typeCommand(page, "free");
      await advanceUntil(page, async () => /Total:\s+8\.00GB/.test(await terminalText(page)), {
        realTimeoutMs: 10_000,
      });
    } finally {
      await closeGame(page);
    }
  });

  test("a script autoexec starts on load imports another, and runs on the stepped clock within 5 s of game time", async () => {
    // What the Agent's workers do: start, import, wait on a game timer, report. A slow import overtaken by game time
    // would show up here as a missed bound.
    const save = await simulatorSave({
      gameSettings: { AutoexecScript: "probe.js" },
      prepare: async (sim) => {
        await sim.writeFile("home", "lib.js", 'export function word() { return "done"; }');
        await sim.writeFile(
          "home",
          "probe.js",
          'import { word } from "lib.js";\nexport async function main(ns) { await ns.sleep(1000); ns.tprint("E2 probe " + word()); }',
        );
      },
    });
    const page = await gameFromSave(e2.browser, e2.server, save);
    try {
      const { gameMs } = await advanceUntil(page, async () => (await terminalText(page)).includes("E2 probe done"), {
        gameTimeoutMs: 5_000,
        realTimeoutMs: 30_000,
      });
      // Its 1 s sleep is game time: it can't finish sooner.
      expect(gameMs).toBeGreaterThanOrEqual(1_000);
      console.log(`The autoexec'd script finished after ${gameMs} ms of game time`);
    } finally {
      await closeGame(page);
    }
  });
});
