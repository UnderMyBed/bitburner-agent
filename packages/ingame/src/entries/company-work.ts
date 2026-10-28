// agent/<deploymentId>/company-work.js: a home worker that converges the player's work on company work through the
// game's page (#153, owner decision 37), the work activity's `ui` effector for a company: there's no API for it before
// Singularity. Arguments: the company, the job field ("Waiter", "Software", …), "true" or "false" for focus, and when to
// give up.
// - The page is the only witness of the work (../page/work-page.ts): focused, the Work page's "You are currently working
//   as a Waiter at Noodle Bar"; unfocused, the overview's "Working at Noodle Bar" with the job title (from React props).
//   Already so: done, nothing touched. The right work at the wrong focus: the focus set, the work not restarted.
// - Otherwise: the City, then the company (only in its city: otherwise it says so, and the owner queues a travel); the
//   field's offered job applied for unless `getPlayer().jobs` shows one in that field there (a disabled "Apply" is not
//   qualified yet; the "Congratulations" alert is closed); then "Work", which starts it focused; unfocused if focus is
//   false.
// - Stopped on the way, it leaves the player as found: focused again on their own work, or on the Terminal.
// RAM: `getPlayer` 0.5 (ram-budget.json); the page costs nothing.
import { JOB_FIELDS, type Work } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";
import { convergeWorkOnPage, workShown } from "../page/work-page.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const work: Work = {
    kind: "company",
    company: String(ns.args[0] ?? ""),
    field: String(ns.args[1] ?? ""),
    focus: String(ns.args[2] ?? "") === "true",
  };
  const deadlineMs = Number(ns.args[3] ?? 0);
  const job = (ns.getPlayer().jobs as Record<string, string | undefined>)[work.company];
  const hasJobInField = (JOB_FIELDS[work.field] ?? []).some((each) => each.title === job);
  const reader = openGamePage(ns, deadlineMs);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, work) === (work.focus ? "focused" : "unfocused"),
    doing: "work through",
    steps: (gamePage, { wasFocused }) => convergeWorkOnPage(gamePage, work, { wasFocused, hasJobInField }),
    notDoneAfter: `not ${work.focus ? "focused on" : "doing"} ${work.field} work at ${work.company} after starting it`,
    ending: "steps",
  });
}
