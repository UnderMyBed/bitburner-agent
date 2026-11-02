// agent/<deploymentId>/singularity-donate-to-faction.js: the `singularity` backend's donation (#225, architecture
// §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the faction, the amount, the reputation the
// donation is for, and when to give up (unused: the call is quick). Its steps are ../workers/singularity-donation.ts's:
// the faction's reputation already there is done, with nothing donated; else `donateToFaction`.
// RAM: `getFactionRep` 1 + `donateToFaction` 5 at SF4.3 or in BN4 (ram-budget.json): 7.6 GB. The Agent uses the page
// where it doesn't fit home beside it.
import type { FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";
import { donateThroughSingularity } from "../workers/singularity-donation.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "") as FactionName;
  const amount = Number(ns.args[1] ?? 0);
  const reputation = Number(ns.args[2] ?? 0);
  const game = {
    factionReputation: () => ns.singularity.getFactionRep(faction),
    makeDonation: () => ns.singularity.donateToFaction(faction, amount),
  };
  reportToAgent(ns, donateThroughSingularity(game, { faction, amount, reputation }));
}
