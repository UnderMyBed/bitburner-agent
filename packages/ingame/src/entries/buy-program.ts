// agent/<deploymentId>/buy-program.js: a home worker that buys one hacking program through the game's page (#136), the
// first `ui` effector: there's no API for it before Singularity. Arguments: the item ("TOR router" or a program's file
// name), the tech vendor in the player's city for the TOR router (else ""), and when to give up (the game's
// `Date.now()`), so it ends within its Agent's round.
// - The game first: an item already owned is done, without touching the page.
// - Never over an open dialog: that's the owner's to read and close.
// - The TOR router: the City, the vendor, "Purchase TOR router" while it can be bought (`Locations/ui/TorButton.tsx`),
//   then the purchase's own dialog closed with its own close button (never Escape, which closes every dialog).
// - A program: the Terminal, and `buy <program>` in it (`Terminal/commands/buy.ts`).
// - Once it has moved the page, it goes back to the Terminal, however it ends.
// RAM: `hasTorRouter` 0.05 + `fileExists` 0.1 (ram-budget.json); the page costs nothing.
import { type BuyProgramReport, TOR_ROUTER } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type GamePage, openGamePage } from "../page/game-page.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** Owned: the TOR router by the game's own flag, a program by its file on home. */
function owns(ns: NS, item: string): boolean {
  return item === TOR_ROUTER ? ns.hasTorRouter() : ns.fileExists(item, "home");
}

async function buyTorRouter(gamePage: GamePage, vendor: string): Promise<string | null> {
  const problem =
    (await gamePage.openSidebarPage("City")) ??
    // The city's locations: the ASCII map's labelled letters, or buttons with ASCII art off (`Locations/ui/City.tsx`).
    (await gamePage.clickWhenThere(
      `//span[@aria-label='${vendor}'] | //button[normalize-space()='${vendor}']`,
      ` in the city`,
    )) ??
    // A disabled button means the player can't afford it now: its click handler would still run, and open a dialog.
    (await gamePage.clickWhenThere(
      "//button[not(@disabled) and contains(normalize-space(), 'Purchase TOR router')]",
      "TOR router to buy (is the money there?)",
    )) ??
    // The purchase's dialog, the only one open: its close button sits beside its text (`ui/React/Modal.tsx`).
    (await gamePage.clickWhenThere(
      "//div[button and contains(., 'You have purchased a TOR router')]/button",
      "close button on the TOR purchase's dialog",
    ));
  // Back to the Terminal, however it went, in the time kept for it: the page was moved.
  const backProblem = await gamePage.returnToTerminal();
  return problem ?? backProblem;
}

async function buyProgram(gamePage: GamePage, program: string): Promise<string | null> {
  return (await gamePage.openSidebarPage("Terminal")) ?? (await gamePage.runTerminalCommand(`buy ${program}`));
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const item = String(ns.args[0] ?? "");
  const vendor = String(ns.args[1] ?? "");
  const deadlineMs = Number(ns.args[2] ?? 0);
  const report: BuyProgramReport = { item, done: owns(ns, item), problem: null };
  if (!report.done) {
    const gamePage = openGamePage(ns, deadlineMs);
    if (gamePage === null) {
      report.problem = "no game page to buy it through";
    } else if (gamePage.dialogOpen()) {
      report.problem = "a dialog is open: it's the owner's to close";
    } else {
      report.problem = item === TOR_ROUTER ? await buyTorRouter(gamePage, vendor) : await buyProgram(gamePage, item);
      report.done = owns(ns, item);
      if (!report.done) report.problem ??= `${item} isn't owned after buying it`;
    }
  }
  reportToAgent(ns, report);
}
