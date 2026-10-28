// agent/<deploymentId>/crime-work.js: a home worker that converges the player's work on a crime through the game's
// page (#156, owner decision 37), the work activity's `ui` effector for crime: there's no API for it before
// Singularity. Arguments: the crime ("Shoplift", "Heist", …), "true" or "false" for focus, and when to give up.
// - The page is the only witness of the work (../page/work-page.ts). Focused, the Work page's "You are attempting to
//   shoplift" (`ui/WorkInProgressRoot.tsx:224`, the crime's `workName`); unfocused, the overview's "You are attempting
//   to Shoplift" (`ui/React/CharacterOverview.tsx:303`). Already so: done, nothing touched. The right crime at the
//   wrong focus: the focus set, the crime not started again.
// - Otherwise: the City, then The Slums, in every city, then the crime's button ("Shoplift (45.20% chance of
//   success)", `Locations/ui/SlumsLocation.tsx`), which starts it focused; unfocused after if focus is false. A crime
//   is committed again and again until other work replaces it (`Work/CrimeWork.ts`).
// - Stopped on the way, it leaves the player as found: focused again on their own work, or on the Terminal.
// - The focus is this worker's to set, so `reportPageEffect` leaves the page where the steps do.
// RAM: nothing beyond the base (ram-budget.json); the page costs nothing.
import type { Work } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { convergeWorkOnPage, workShown } from "../page/work-page.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const work: Work = { kind: "crime", crime: String(ns.args[0] ?? ""), focus: String(ns.args[1] ?? "") === "true" };
  const deadlineMs = Number(ns.args[2] ?? 0);
  const reader = openGamePage(ns, deadlineMs);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, work) === (work.focus ? "focused" : "unfocused"),
    doing: "commit crime through",
    steps: (gamePage, { wasFocused }) => convergeWorkOnPage(gamePage, work, { wasFocused }),
    notDoneAfter: `not ${work.focus ? "focused on" : "doing"} ${work.crime} after starting it`,
    ending: "steps",
  });
}
