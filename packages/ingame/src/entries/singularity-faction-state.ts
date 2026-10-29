// agent/<deploymentId>/singularity-faction-state.js: the `singularity` backend's faction state reader (#197,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Argument: when to give up (unused: the calls
// are quick).
// - Each joined faction (`getPlayer().factions`): `getFactionRep` and `getFactionFavor`
//   (`NetscriptFunctions/Singularity.ts:907-918`).
// - The invitations: `checkFactionInvitations` (`:771-778`), which also runs the game's invitation check now
//   (`:773-775`), bringing one due within its 2 s forward. Its dialog may then open after the round's dialogs were
//   handled: the next round's dialog watcher answers it.
// - The queue: `getOwnedAugmentations(true)` lists the installed, then the queued, NeuroFlux once per queued level
//   (`:79-92`); what's past the installed (`getOwnedAugmentations(false)`) is the queue, in the game's form.
// RAM: `getPlayer` 0.5 + `getFactionRep` 1 + `getFactionFavor` 1 + `checkFactionInvitations` 3 +
// `getOwnedAugmentations` 5 at SF4.3 or in BN4 (ram-budget.json): 12.1 GB. The Agent uses the page where it doesn't fit
// home beside it.
import type { FactionState, FactionStateReport } from "@bitburner-agent/core";
import type { FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const state: FactionState = {
    joined: ns.getPlayer().factions.map((name) => ({
      name,
      reputation: ns.singularity.getFactionRep(name as FactionName),
      favor: ns.singularity.getFactionFavor(name as FactionName),
    })),
    invitations: ns.singularity.checkFactionInvitations(),
    queuedAugmentations: ns.singularity
      .getOwnedAugmentations(true)
      .slice(ns.singularity.getOwnedAugmentations(false).length),
  };
  const report: FactionStateReport = { done: true, problem: null, state };
  reportToAgent(ns, report);
}
