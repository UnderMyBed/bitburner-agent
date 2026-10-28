// agent/<deploymentId>/upgrade-home-ram.js: a home worker that doubles home's RAM once through the game's page (#138),
// a `ui` effector like buy-program.js: there's no API for it before Singularity. Arguments: home's RAM (GB) when the
// brain asked, the tech vendor in the player's city, and when to give up (the game's `Date.now()`), so it ends within
// its Agent's round.
// - The game first: home with more RAM than that is done, without touching the page. So a repeat buys nothing more.
// - Never over an open dialog: that's the owner's to read and close.
// - The City, the vendor, "Upgrade 'home' RAM" while it can be bought (`Locations/ui/RamButton.tsx`: disabled when the
//   player can't afford it or home is at its limit). A purchase opens no dialog (`Server/ServerPurchases.ts:168`).
// - Once it has moved the page, it goes back to the Terminal, however it ends.
// RAM: `getServerMaxRam` 0.05 (ram-budget.json); the page costs nothing.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { openGamePage } from "../page/game-page.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const fromRam = Number(ns.args[0] ?? 0);
  const vendor = String(ns.args[1] ?? "");
  const deadlineMs = Number(ns.args[2] ?? 0);
  const upgraded = () => ns.getServerMaxRam("home") > fromRam;
  const report: EffectorReport = { done: upgraded(), problem: null };
  if (!report.done) {
    const gamePage = openGamePage(ns, deadlineMs);
    if (gamePage === null) {
      report.problem = "no game page to buy it through";
    } else if (await gamePage.dialogStaysOpen()) {
      report.problem = "a dialog is open: it's the owner's to close";
    } else {
      const problem =
        (await gamePage.openCityLocation(vendor)) ??
        // Enabled only while the player can afford it: a disabled one's click handler would still run, and open a
        // dialog saying why not.
        (await gamePage.clickWhenThere(
          "//button[not(@disabled) and contains(normalize-space(), \"Upgrade 'home' RAM\")]",
          "home RAM upgrade to buy (is the money there?)",
        ));
      // Back to the Terminal, however it went, in the time kept for it: the page was moved.
      const backProblem = await gamePage.returnToTerminal();
      report.problem = problem ?? backProblem;
      report.done = upgraded();
      if (!report.done) report.problem ??= `home's RAM isn't more than ${fromRam} GB after upgrading it`;
    }
  }
  reportToAgent(ns, report);
}
