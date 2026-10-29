// agent/<deploymentId>/faction-state.js: a home worker that reads the faction state from the game's page (#197), the
// `ui` backend's reader: each joined faction's reputation and favour, the invitations and the queued augmentations,
// which no NS call has before Singularity. The Agent runs it with each slow snapshot. Argument: when to give up (the
// game's `Date.now()`).
// - The steps are in ../page/faction-state-page.ts: the Factions page's React props, the Augmentations page's rows,
//   each only when the sidebar shows something there; the joined factions checked against `getPlayer().factions`.
// - Around them, `reportPageEffect` (../page/page-effect.ts): never over an owner's dialog, and the page left as found,
//   the Terminal or the work focused again (owner decision 37).
// RAM: `getPlayer` 0.5 + `getResetInfo` 1.0 (ram-budget.json); the page costs nothing.
import { type FactionState, NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { readFactionStateOnPage } from "../page/faction-state-page.ts";
import { reportPageEffect } from "../page/page-effect.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const deadlineMs = Number(ns.args[0] ?? 0);
  const gameFactions: string[] = ns.getPlayer().factions;
  const installedNeuroFluxLevel = ns.getResetInfo().ownedAugs.get(NEUROFLUX_GOVERNOR) ?? 0;
  const read: { state: FactionState | null } = { state: null };
  await reportPageEffect(ns, deadlineMs, {
    isDone: () => read.state !== null,
    doing: "read the faction state through",
    steps: (gamePage) => readFactionStateOnPage(gamePage, { gameFactions, installedNeuroFluxLevel }, read),
    // Never reported: the steps return null only once they've read it.
    notDoneAfter: "the faction state wasn't read",
    reportAlso: () => ({ state: read.state }),
  });
}
