// The fixtures, on the built game (#96): a simulator-made save loads, and a brand-new game's tutorial can be exited.
import { gunzipSync } from "node:zlib";
import { Simulation } from "@bitburner-agent/sim";
import type { Page } from "playwright";
import { describe, expect, test } from "vitest";
import { closeGame, exitTutorial, freshGame, gameFromSave } from "../src/game.ts";
import { useE2 } from "./helpers/environment.ts";

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

/** The player's money and last update time, as the save holds them (a gzipped BitburnerSaveObject). */
function playerInSave(save: Uint8Array): { money: number; lastUpdate: number } {
  const saveObject = JSON.parse(gunzipSync(save).toString("utf8")) as { data: { PlayerSave: string } };
  const player = JSON.parse(saveObject.data.PlayerSave) as { data: { money: number; lastUpdate: number } };
  return { money: player.data.money, lastUpdate: player.data.lastUpdate };
}

/** A save made by the simulator: a new game whose player has hacked n00dles for a while, so its money is its own. */
async function simulatorSave(): Promise<Uint8Array> {
  const sim = await Simulation.start({
    fixture: { kind: "new", tutorial: "skipped" },
    epochMs: Date.UTC(2026, 0, 1),
    seed: 1,
  });
  try {
    await sim.writeFile(
      "home",
      "earn.js",
      'export async function main(ns) { ns.nuke("n00dles"); while (true) await ns.hack("n00dles"); }',
    );
    const { pid } = await sim.run("home", "earn.js");
    await sim.advance(10 * 60_000);
    // No script runs in the save, so nothing changes the money once the page has loaded it.
    await sim.kill(pid);
    return await sim.save();
  } finally {
    await sim.close();
  }
}

describe("the game in Playwright", () => {
  test("a simulator-made save loads to the Terminal, and the overview shows the save's money", async () => {
    const save = await simulatorSave();
    const { money, lastUpdate } = playerInSave(save);
    expect(money).toBeGreaterThan(1_000);
    // The clock starts at the save's own time: no offline progress.
    const page = await gameFromSave(e2.browser, e2.server, save, { startTimeMs: lastUpdate });
    try {
      await expect(page.locator("#terminal-input").count()).resolves.toBe(1);
      const shown = await shownMoney(page);
      expect(Math.abs(shown.value - money), `shown ${shown.text}, saved ${money}`).toBeLessThanOrEqual(shown.rounding);
    } finally {
      await closeGame(page);
    }
  });

  test("a reload isn't blocked by the game's unload prompt, and loads the game again", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await exitTutorial(page);
      // Typing counts as the user using the page, after which the browser does show the unload prompt.
      await page.locator("#terminal-input").click();
      await page.keyboard.type("help");
      await page.evaluate(() => Object.assign(window, { beforeReload: true }));
      await page.reload();
      await page.locator("#terminal-input").waitFor({ timeout: 60_000 });
      await expect(page.evaluate(() => "beforeReload" in window)).resolves.toBe(false);
    } finally {
      await closeGame(page);
    }
  });

  test("a brand-new game starts in the tutorial, which exitTutorial closes", async () => {
    const page = await freshGame(e2.browser, e2.server);
    try {
      await expect(page.getByRole("button", { name: "Exit Tutorial" }).count()).resolves.toBe(1);
      await exitTutorial(page);
      await expect(page.getByRole("button", { name: "Exit Tutorial" }).count()).resolves.toBe(0);
      await expect(page.locator("#terminal-input").count()).resolves.toBe(1);
    } finally {
      await closeGame(page);
    }
  });
});
