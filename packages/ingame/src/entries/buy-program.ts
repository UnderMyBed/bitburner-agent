// agent/<deploymentId>/buy-program.js: a home worker that buys one hacking program through the game's page (#136), the
// first `ui` effector: there's no API for it before Singularity. Arguments: the item ("TOR router" or a program's file
// name), the tech vendor in the player's city for the TOR router (else ""), and when to give up (the game's
// `Date.now()`), so it ends within its Agent's round.
// - The game first: an item already owned is done, without touching the page.
// - The TOR router: the City, the vendor, "Purchase TOR router" (`Locations/ui/TorButton.tsx`), then that purchase's
//   dialog closed with its own close button (Escape would dismiss every dialog), then back to the Terminal.
// - A program: the Terminal, and `buy <program>` in it (`Terminal/commands/buy.ts`).
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
      vendor,
    )) ??
    (await gamePage.clickWhenThere("//button[contains(normalize-space(), 'Purchase TOR router')]", "TOR button"));
  if (problem !== null) return problem;
  // The purchase's own dialog: the modal's close button sits beside its text (`ui/React/Modal.tsx`).
  await gamePage.clickWhenThere("//div[button and contains(., 'You have purchased a TOR router')]/button", "dialog");
  return gamePage.openSidebarPage("Terminal");
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
    } else {
      report.problem = item === TOR_ROUTER ? await buyTorRouter(gamePage, vendor) : await buyProgram(gamePage, item);
      report.done = owns(ns, item);
      if (!report.done) report.problem ??= `${item} isn't owned after buying it`;
    }
  }
  reportToAgent(ns, report);
}
