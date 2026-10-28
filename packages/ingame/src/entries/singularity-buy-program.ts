// agent/<deploymentId>/singularity-buy-program.js: the `singularity` backend's program purchase (#145, architecture
// §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the program, and when to give up (unused: the call
// is quick). The game first, as the `ui` backend's worker does: the program on home is done without calling anything.
// RAM: `fileExists` 0.1 + `purchaseProgram` 2 at SF4.3 or in BN4 (ram-budget.json); the game charges 4× or 16× with
// less of SF4.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** The dark web's program names, as the definitions type `purchaseProgram`'s argument. */
type ProgramName = Parameters<NS["singularity"]["purchaseProgram"]>[0];

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const program = String(ns.args[0] ?? "");
  const owned = () => ns.fileExists(program, "home");
  const report: EffectorReport = { done: owned(), problem: null };
  if (!report.done) {
    report.done = ns.singularity.purchaseProgram(program as ProgramName) && owned();
    if (!report.done) report.problem = `the game didn't sell ${program} (is the TOR router there, and the money?)`;
  }
  reportToAgent(ns, report);
}
