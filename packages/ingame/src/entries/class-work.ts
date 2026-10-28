// agent/<deploymentId>/class-work.js: a home worker that converges the player's work on a class through the game's
// page (#158, owner decision 37), the work activity's `ui` effector for a university course or gym workout: there's no
// API for it before Singularity. Arguments: the university or gym ("Rothman University", "Iron Gym", …), the class
// type ("Computer Science", "str", …), "true" or "false" for focus, and when to give up.
// - The page is the only witness of the work (../page/work-page.ts). Focused, the Work page's "You are currently
//   studying Computer Science" (`ui/WorkInProgressRoot.tsx:270-274`, the class's `youAreCurrently`); unfocused, the
//   overview's "You are studying Computer Science" (`ui/React/CharacterOverview.tsx:306-309`). Neither says where, so
//   a class of this type anywhere counts. Already so: done, nothing touched. The right class at the wrong focus: the
//   focus set, the class not started again.
// - Otherwise, held back without touching the page (`classHeldBack`, from `getPlayer`): the location in another city
//   (the owner queues a travel), or a paid class with less money than 10 minutes of it costs. The game would start it
//   anyway and let the money go negative.
// - Otherwise: the City, then the university or gym, only in its city, then the class's button ("Take Networks
//   course (… / sec)", `Locations/ui/UniversityLocation.tsx:51-82`; "Train Strength (… / sec)", `GymLocation.tsx:42-53`), which
//   starts it focused; unfocused after if focus is false ("Do something else simultaneously" goes to the location,
//   `ui/WorkInProgressRoot.tsx:266-268`), then the Terminal. A class the page started and other work replaces shows an
//   "After … you spent …" alert (`Work/ClassWork.tsx:113-133`, `finish`), which the dialog watcher closes.
// - Stopped on the way, it leaves the player as found: focused again on their own work, or on the Terminal.
// - The focus is this worker's to set, so `reportPageEffect` leaves the page where the steps do.
// RAM: `getPlayer` 0.5 (ram-budget.json); the page costs nothing.
import { classLabel, type Work } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { classHeldBack, convergeWorkOnPage, workShown } from "../page/work-page.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const work: Extract<Work, { kind: "class" }> = {
    kind: "class",
    location: String(ns.args[0] ?? ""),
    classType: String(ns.args[1] ?? ""),
    focus: String(ns.args[2] ?? "") === "true",
  };
  const deadlineMs = Number(ns.args[3] ?? 0);
  const reader = openGamePage(ns, deadlineMs);
  const { money, city } = ns.getPlayer();
  const heldBack = classHeldBack(reader, work, { money, city });
  if (heldBack !== null) {
    reportToAgent(ns, { done: false, problem: heldBack });
    return;
  }
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, work) === (work.focus ? "focused" : "unfocused"),
    doing: "take the class through",
    steps: (gamePage, { wasFocused }) => convergeWorkOnPage(gamePage, work, { wasFocused }),
    notDoneAfter: `not ${work.focus ? "focused on" : "doing"} ${classLabel(work)} after starting it`,
    ending: "steps",
  });
}
