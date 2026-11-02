// agent/<deploymentId>/singularity-donate-to-faction.js: the `singularity` backend's donation (#225, architecture §5.6),
// for when the game has Singularity (SF4, or BN4). Arguments: the faction, the amount, the reputation the donation is
// for, and when to give up (unused: the call is quick).
// - The game first, as the `ui` backend's worker does: the faction's reputation already there is done, with nothing
//   donated.
// - `donateToFaction` refuses what the page would (not a member, the gang's faction, one with no work, the money, the
//   favour: `NetscriptFunctions/Singularity.ts:925-964`), returning false.
// RAM: `getFactionRep` 1 + `donateToFaction` 5 at SF4.3 or in BN4 (ram-budget.json): 7.6 GB. The Agent uses the page
// where it doesn't fit home beside it.
import type { EffectorReport } from "@bitburner-agent/core";
import type { FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "") as FactionName;
  const amount = Number(ns.args[1] ?? 0);
  const reputation = Number(ns.args[2] ?? 0);
  const report: EffectorReport = { done: ns.singularity.getFactionRep(faction) >= reputation, problem: null };
  if (!report.done) {
    const donated = ns.singularity.donateToFaction(faction, amount);
    report.done = ns.singularity.getFactionRep(faction) >= reputation;
    if (!report.done) {
      report.problem = donated
        ? `${faction}'s reputation isn't ${reputation} after the donation`
        : `the game refused $${amount} to ${faction} (joined? its favour? the money? a gang's, or one with no work?)`;
    }
  }
  reportToAgent(ns, report);
}
