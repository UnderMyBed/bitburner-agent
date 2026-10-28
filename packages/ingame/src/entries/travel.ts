// agent/<deploymentId>/travel.js: a home worker that travels to a city through the game's page (#141), a `ui` effector:
// there's no API for it before Singularity. Arguments: the city, and when to give up (the game's `Date.now()`), so it
// ends within its Agent's round.
// - The game first: the player already in the city is done, without touching the page.
// - Never over an open dialog: that's the owner's to read and close.
// - The sidebar's Travel, then the city (`Locations/ui/TravelAgencyRoot.tsx`): on the ASCII map, the city's first letter
//   (`ui/React/WorldMap.tsx`; the six differ), or with ASCII art off, a "Travel to <city>" button.
// - The confirmation's "Travel", and then the "You are now in <city>!" alert closed with its own close button: each
//   only if it's shown, since the player's Options can turn both off (`SuppressTravelConfirmation`). A ticket costs
//   $200k: without it, the game does nothing.
// - Once it has moved the page, it goes back to the Terminal, however it ends.
// RAM: `getPlayer` 0.5 (ram-budget.json); the page costs nothing.
import { type EffectorReport, TRAVEL_COST } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type GamePage, openGamePage } from "../page/game-page.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** The modal holding the game's travel confirmation (`Locations/ui/TravelConfirmationModal.tsx`). */
const CONFIRMATION_XPATH =
  "//div[contains(concat(' ', @class, ' '), ' MuiModal-root ') and .//p[starts-with(normalize-space(), 'Would you like to travel to')]]//button[normalize-space()='Travel']";

async function travelTo(ns: NS, gamePage: GamePage, city: string): Promise<string | null> {
  const inCity = () => ns.getPlayer().city === city;
  const problem =
    (await gamePage.openSidebarPage("Travel")) ??
    (await gamePage.clickWhenThere(
      `//h4[normalize-space()='Travel Agency']/following::p/span[normalize-space()='${city.charAt(0)}'] | //button[normalize-space()='Travel to ${city}']`,
      `${city} to travel to`,
    ));
  if (problem !== null) return problem;
  // The confirmation, unless Options turn it off; then the travel itself.
  while (!inCity() && !gamePage.stepsTimeUp()) {
    const confirmation = await gamePage.clickIfThere(CONFIRMATION_XPATH, "the travel confirmation's Travel");
    if (confirmation.problem !== null) return confirmation.problem;
    if (!confirmation.clicked) await gamePage.waitARender();
  }
  if (!inCity()) return `not in ${city} after travelling (is the $${TRAVEL_COST / 1000}k ticket there?)`;
  // The alert saying so, unless Options turn it off: it opens as the travel ends, so give it a render.
  const alertCloseXpath = `//div[button and contains(., 'You are now in ${city}!')]/button`;
  await gamePage.waitARender();
  const alert = await gamePage.clickIfThere(alertCloseXpath, "the close button on the travel's alert");
  return alert.problem;
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const city = String(ns.args[0] ?? "");
  const deadlineMs = Number(ns.args[1] ?? 0);
  const inCity = () => ns.getPlayer().city === city;
  const report: EffectorReport = { done: inCity(), problem: null };
  if (!report.done) {
    const gamePage = openGamePage(ns, deadlineMs);
    if (gamePage === null) {
      report.problem = "no game page to travel through";
    } else if (await gamePage.dialogStaysOpen()) {
      report.problem = "a dialog is open: it's the owner's to close";
    } else {
      const problem = await travelTo(ns, gamePage, city);
      // Back to the Terminal, however it went, in the time kept for it: the page was moved.
      const backProblem = await gamePage.returnToTerminal();
      report.problem = problem ?? backProblem;
      report.done = inCity();
      if (!report.done) report.problem ??= `not in ${city} after travelling`;
    }
  }
  reportToAgent(ns, report);
}
