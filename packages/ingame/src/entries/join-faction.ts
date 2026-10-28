// agent/<deploymentId>/join-faction.js: a home worker that joins a faction through the game's page (#147), a `ui`
// effector: there's no API for it before Singularity. Arguments: the faction, and when to give up (the game's
// `Date.now()`), so it ends within its Agent's round.
// - The game first: the player already a member is done, without touching the page.
// - Never over an open dialog the dialog watcher leaves (a script's, the owner's): that's theirs to answer (#143).
// - The sidebar's Factions, then "Join!" on the faction's row under the invitations (`Faction/ui/FactionsRoot.tsx`:
//   `span.factions-invites`, a row per invited faction). No such row: no invitation, so nothing is joined.
// - Once it has moved the page, it goes back to the Terminal, however it ends.
// Joining a faction with enemies bans them: the brain sends that only past its guard and a save backup (#147).
// RAM: `getPlayer` 0.5 (ram-budget.json); the page costs nothing.
import type { FactionName, NS } from "../ns.ts";
import { factionRowButtonXpath, type GamePage } from "../page/game-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

async function joinOnPage(gamePage: GamePage, faction: string): Promise<string | null> {
  return (
    (await gamePage.openSidebarPage("Factions")) ??
    (await gamePage.clickWhenThere(
      factionRowButtonXpath("factions-invites", faction, "Join!"),
      `invitation from ${faction} on the Factions page`,
    ))
  );
}

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const deadlineMs = Number(ns.args[1] ?? 0);
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => ns.getPlayer().factions.includes(faction as FactionName),
    doing: "join through",
    steps: (gamePage) => joinOnPage(gamePage, faction),
    notDoneAfter: `not a member of ${faction} after joining`,
  });
}
