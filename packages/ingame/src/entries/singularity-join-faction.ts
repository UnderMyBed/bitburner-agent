// agent/<deploymentId>/singularity-join-faction.js: the `singularity` backend's faction join (#147, architecture
// §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the faction, and when to give up (unused: the call
// is quick). The game first, as the `ui` backend's worker does: already a member is done without calling anything.
// `joinFaction` refuses without an invitation (`NetscriptFunctions/Singularity.ts:779-798`). RAM: `getPlayer` 0.5 +
// `joinFaction` 3 at SF4.3 or in BN4 (ram-budget.json): 5.1 GB, over the fresh-save rule, which no Singularity worker
// runs under; the Agent uses the page where it doesn't fit home.
import type { EffectorReport } from "@bitburner-agent/core";
import type { FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const isMember = () => ns.getPlayer().factions.includes(faction as FactionName);
  const report: EffectorReport = { done: isMember(), problem: null };
  if (!report.done) {
    report.done = ns.singularity.joinFaction(faction as FactionName) && isMember();
    if (!report.done) report.problem = `not a member of ${faction} after joining (is there an invitation?)`;
  }
  reportToAgent(ns, report);
}
