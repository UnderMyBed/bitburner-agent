// agent/<deploymentId>/faction-work.js: a home worker that converges the player's work on faction work through the
// game's page (#151, owner decision 37), the work activity's `ui` effector: there's no API for it before Singularity.
// Arguments: the faction, the work type (hacking, field, security), "true" or "false" for focus, and when to give up.
// - The page is the only witness without Singularity: focused, the Work page's title ("You are currently carrying out
//   hacking contracts for CyberSec", `ui/WorkInProgressRoot.tsx:371-393`); unfocused, the overview's "Working for
//   CyberSec" and "Doing hacking work" (`ui/React/CharacterOverview.tsx:332-347`). Already so: done, nothing touched.
// - The right work at the wrong focus: the overview's "Focus", or the Work page's "Do something else simultaneously"
//   (which `reportPageEffect` clicks first) and back to the Terminal.
// - Otherwise it starts it: the sidebar's Factions, "Details" on the faction's row, then the work's button
//   (`Faction/ui/FactionRoot.tsx:127-139`), which starts it focused; unfocused if focus is false.
// - The focus is this worker's to set, so `reportPageEffect` leaves the page where the steps do.
// RAM: nothing beyond the base (ram-budget.json); the page costs nothing.
import type { FactionWorkType } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { factionRowButtonXpath, type GamePage, openGamePage, xpathString } from "../page/game-page.ts";
import { reportPageEffect, UNFOCUS_XPATH } from "../page/page-effect.ts";

/** How the Work page words each type, and the faction page's button that starts it. */
const WORK_TYPES: Record<FactionWorkType, { doing: string; button: string }> = {
  hacking: { doing: "carrying out hacking contracts", button: "Hacking Contracts" },
  field: { doing: "carrying out field missions", button: "Field Work" },
  security: { doing: "performing security detail", button: "Security Work" },
};

/** What the page shows of the work: this work focused, this work unfocused, or neither. */
function workShown(gamePage: GamePage, faction: string, workType: FactionWorkType): "focused" | "unfocused" | null {
  const title = `You are currently ${WORK_TYPES[workType].doing} for ${faction}`;
  if (gamePage.findElementNow(`//h6[normalize-space()=${xpathString(title)}]`)) return "focused";
  const overview =
    `//p[normalize-space()=${xpathString(`Working for ${faction}`)}]` +
    `/following::p[normalize-space()=${xpathString(`Doing ${workType} work`)}]`;
  return gamePage.findElementNow(overview) ? "unfocused" : null;
}

async function convergeOnPage(gamePage: GamePage, faction: string, workType: FactionWorkType, focus: boolean) {
  // `reportPageEffect` has unfocused a focused player already, so the right work shows on the overview now: left as
  // the focus wants it, the Work page or the Terminal.
  if (workShown(gamePage, faction, workType) === "unfocused") {
    return focus ? gamePage.refocusWork() : gamePage.returnToTerminal();
  }
  const started =
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      factionRowButtonXpath("factions-joined", faction, "Details"),
      `${faction} among the factions joined (is it joined?)`,
    ));
  // Stopped on the way: the problem, and the page back on the Terminal.
  if (started !== null) {
    await gamePage.returnToTerminal();
    return started;
  }
  const button = WORK_TYPES[workType].button;
  const working = await gamePage.clickWhenThere(
    `//button[normalize-space()=${xpathString(button)}]`,
    `"${button}" on ${faction}'s page (does it offer ${workType} work?)`,
  );
  if (working !== null) {
    await gamePage.returnToTerminal();
    return working;
  }
  // Started focused, on the Work page: done, or unfocused and back to the Terminal.
  if (focus) return null;
  return (
    (await gamePage.clickWhenThere(UNFOCUS_XPATH, 'the Work page\'s "Do something else simultaneously"')) ??
    (await gamePage.returnToTerminal())
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const workType = String(ns.args[1] ?? "") as FactionWorkType;
  const focus = String(ns.args[2] ?? "") === "true";
  const deadlineMs = Number(ns.args[3] ?? 0);
  const reader = openGamePage(ns, deadlineMs);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, faction, workType) === (focus ? "focused" : "unfocused"),
    doing: "work through",
    steps: (gamePage) => convergeOnPage(gamePage, faction, workType, focus),
    notDoneAfter: `not ${focus ? "focused on" : "doing"} ${workType} work for ${faction} after starting it`,
    ending: "steps",
  });
}
