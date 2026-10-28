// agent/<deploymentId>/sing-upgrade-home-ram.js: the `singularity` backend's home RAM upgrade (#145, architecture §5.6), for when the game has
// Singularity (SF4, or BN4). Arguments: home's RAM (GB) when the brain asked, and when to give up (unused: the call is quick). The game first, as the
// `ui` backend's worker does: home with more RAM than that is done without calling anything. RAM: `getServerMaxRam` 0.05 + `upgradeHomeRam` 3 at SF4.3 or in BN4
// (ram-budget.json); the game charges 4× or 16× with less of SF4.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const fromRam = Number(ns.args[0] ?? 0);
  const upgraded = () => ns.getServerMaxRam("home") > fromRam;
  const report: EffectorReport = { done: upgraded(), problem: null };
  if (!report.done) {
    report.done = ns.singularity.upgradeHomeRam() && upgraded();
    if (!report.done) report.problem = "the game didn't upgrade home's RAM (is the money there?)";
  }
  reportToAgent(ns, report);
}
