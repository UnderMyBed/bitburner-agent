// agent/<deploymentId>/company-work.js: a home worker that converges the player's work on company work through the
// game's page (#153, owner decision 37), the work activity's `ui` effector for a company: there's no API for it before
// Singularity. Arguments: the company, the job field ("Waiter", "Software", …), "true" or "false" for focus, "true" or
// "false" for a promotion check (#155), and when to give up.
// - The page is the only witness of the work (../page/work-page.ts). Focused, the Work page's "You are currently working
//   as a Waiter at Noodle Bar" (`ui/WorkInProgressRoot.tsx:442`); unfocused, the overview's "Working at Noodle Bar",
//   whose job title is its tooltip (`ui/React/CharacterOverview.tsx:348-365`), read from React props. Any title of the
//   field counts. Already so: done, nothing touched. The right work at the wrong focus: the focus set, the work not
//   restarted.
// - A promotion check (owner decision 44), with a job in the field there and a later title in it: the steps go ahead
//   even if the work is converged. The sidebar's Job page, from any city, and that company's "Apply" for a later title
//   of the field: disabled or absent, nothing; enabled, clicked, and its alert closed. The work under way goes on. What
//   `getPlayer().jobs` says after, against before, is reported as `promoted` (core's `promotionBetween`).
// - Otherwise, with a job in the field there (`getPlayer().jobs`): the sidebar's Job page, from any city, and that job's
//   "Work" (`Locations/ui/JobRoot.tsx`). Without one: the City, then the company, only in its city (otherwise it says
//   so, and the owner queues a travel; `Locations/ui/CompanyLocation.tsx`), the field's "Apply" (`Company/ui/
//   JobListings.tsx`; a disabled one is not qualified yet), the hiring's alert closed, then "Work". "Work" starts it
//   focused; unfocused after if focus is false.
// - Stopped on the way, it leaves the player as found: focused again on their own work, or on the Terminal.
// - The focus is this worker's to set, so `reportPageEffect` leaves the page where the steps do.
// RAM: `getPlayer` 0.5 (ram-budget.json); the page costs nothing.
import { holdsJobInField, laterJobs, promotionBetween, type Work } from "@bitburner-agent/core";
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
  const deadlineMs = Number(ns.args[4] ?? 0);
  const jobsOf = () => ({ ...(ns.getPlayer().jobs as Record<string, string>) });
  const jobs = jobsOf();
  const { company, field } = work;
  // Only with a later title of the field to be had: at the top of it, the page isn't visited.
  const checkPromotion =
    String(ns.args[3] ?? "") === "true" &&
    holdsJobInField(jobs, company, field) &&
    laterJobs(field, jobs[company]).length > 0;
  const reader = openGamePage(ns, deadlineMs);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reader !== null && workShown(reader, work) === (work.focus ? "focused" : "unfocused"),
    doing: "work through",
    steps: (gamePage, { wasFocused }) => convergeWorkOnPage(gamePage, work, { wasFocused, jobs, checkPromotion }),
    notDoneAfter: `not ${work.focus ? "focused on" : "doing"} ${field} work at ${company} after starting it`,
    ending: "steps",
    stepsWhenDone: checkPromotion,
    reportAlso: () => ({ promoted: promotionBetween(jobs, jobsOf(), company, field) }),
  });
}
