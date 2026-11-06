// agent/<deploymentId>/donate-to-faction.js: a home worker that donates to a faction through the game's page (#225), a
// `ui` effector: there's no API for it before Singularity. Arguments: the faction, the amount, the reputation the
// donation is for, and when to give up (the page's monotonic clock).
// - The page's steps are ../page/donate-page.ts's: the faction's own page, its reputation already there is done with
//   nothing donated; else the amount typed, "donate" (never a disabled one), and the alert closed.
// - Done once the faction's reputation, as the page shows it, is the reputation the donation is for.
// - Around those steps, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog, back to the
//   Terminal, or focused on the work again.
// RAM: no NS call beyond the base (ram-budget.json); the page costs nothing.
import type { NS } from "../ns.ts";
import { donateOnPage } from "../page/donate-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const amount = Number(ns.args[1] ?? 0);
  const reputation = Number(ns.args[2] ?? 0);
  const deadlineMs = Number(ns.args[3] ?? 0);
  const reached: { reputation: number | null } = { reputation: null };
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => reached.reputation !== null && reached.reputation >= reputation,
    doing: "donate through",
    steps: (gamePage) => donateOnPage(gamePage, { faction, amount, reputation }, reached),
    notDoneAfter: `${faction}'s reputation isn't ${reputation} after the donation`,
  });
}
