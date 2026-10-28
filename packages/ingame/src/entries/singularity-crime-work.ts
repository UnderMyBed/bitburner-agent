// agent/<deploymentId>/singularity-crime-work.js: the work activity's `singularity` effector for crime (#156,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the crime, "true" or "false" for
// focus, and when to give up (unused: the calls are quick).
// - The game first: already this crime at this focus is done, nothing called.
// - Otherwise `commitCrime` at the focus, from any city (`NetscriptFunctions/Singularity.ts:1037-1062`), or, the right
//   crime at the wrong focus, `setFocus`.
// RAM: `getCurrentWork` 0.5 + `isFocused` 0.1 + `commitCrime` 5 + `setFocus` 0.1 at SF4.3 or in BN4
// (ram-budget.json): 7.3 GB.
import type { EffectorReport } from "@bitburner-agent/core";
import type { CrimeType, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const crime = String(ns.args[0] ?? "");
  const focus = String(ns.args[1] ?? "") === "true";
  const isThisWork = () => {
    const current = ns.singularity.getCurrentWork();
    return current?.type === "CRIME" && current.crimeType === crime;
  };
  const converged = () => isThisWork() && ns.singularity.isFocused() === focus;
  const report: EffectorReport = { done: converged(), problem: null };
  if (!report.done) {
    if (!isThisWork()) ns.singularity.commitCrime(crime as CrimeType, focus);
    else ns.singularity.setFocus(focus);
    report.done = converged();
    if (!report.done) report.problem = `not ${focus ? "focused on" : "doing"} ${crime}`;
  }
  reportToAgent(ns, report);
}
