// agent/<deploymentId>/singularity-buy-tor.js: the `singularity` backend's TOR router purchase (#145, architecture
// §5.6), for when the game has Singularity (SF4, or BN4). Arguments: none, and when to give up (unused: the call is
// quick). The game first, as the `ui` backend's worker does: the TOR router owned is done without calling anything.
// RAM: `hasTorRouter` 0.05 + `purchaseTor` 2 at SF4.3 or in BN4 (ram-budget.json); the game charges 4× or 16× with less
// of SF4.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const report: EffectorReport = { done: ns.hasTorRouter(), problem: null };
  if (!report.done) {
    report.done = ns.singularity.purchaseTor() && ns.hasTorRouter();
    if (!report.done) report.problem = "the game didn't sell the TOR router (is the money there?)";
  }
  reportToAgent(ns, report);
}
