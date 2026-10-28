// agent/<deploymentId>/faction-work.js: a home worker that converges the player's work on faction work through the
// game's page (#151, owner decision 37), the work activity's `ui` effector: there's no API for it before Singularity.
// Arguments: the faction, the work type (hacking, field, security), "true" or "false" for focus, and when to give up.
// - The page is the only witness without Singularity. Focused, the Work page's title ("You are currently carrying out
//   hacking contracts for CyberSec", `ui/WorkInProgressRoot.tsx:371-393`). Unfocused, the overview's "Working for
//   CyberSec" (`ui/React/CharacterOverview.tsx:332-347`): its "Doing hacking work" is the header's tooltip, rendered
//   only on hover, so it's read from the overview's React props. Already so: done, nothing touched.
// - The right work at the wrong focus: the overview's "Focus", or "Do something else simultaneously" (which
//   `reportPageEffect` clicks first for a focused player) and back to the Terminal. The work isn't restarted.
// - Otherwise it starts it: the sidebar's Factions, "Details" on the faction's row, then the work's button
//   (`Faction/ui/FactionRoot.tsx:127-139`), which starts it focused; unfocused if focus is false.
// - Stopped on the way, it leaves the player as found: focused again on their own work, or on the Terminal.
// - The focus is this worker's to set, so `reportPageEffect` leaves the page where the steps do.
// RAM: nothing beyond the base (ram-budget.json); the page costs nothing.
import type { FactionWorkType, Work } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { convergeWorkOnPage, workShown } from "../page/work-page.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const work: Work = {
    kind: "faction",
    faction: String(ns.args[0] ?? ""),
    workType: String(ns.args[1] ?? "") as FactionWorkType,
    focus: String(ns.args[2] ?? "") === "true",
  };
  const deadlineMs = Number(ns.args[3] ?? 0);
  const reader = openGamePage(ns, deadlineMs);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, work) === (work.focus ? "focused" : "unfocused"),
    doing: "work through",
    steps: (gamePage, { wasFocused }) => convergeWorkOnPage(gamePage, work, { wasFocused }),
    notDoneAfter: `not ${work.focus ? "focused on" : "doing"} ${work.workType} work for ${work.faction} after starting it`,
    ending: "steps",
  });
}
