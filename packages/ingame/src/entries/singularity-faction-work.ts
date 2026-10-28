// agent/<deploymentId>/singularity-faction-work.js: the work activity's `singularity` effector (#151, architecture §5.6),
// for when the game has Singularity (SF4, or BN4). Arguments: the faction, the work type, "true" or "false" for focus,
// and when to give up (unused: the calls are quick).
// - The game first: already this work at this focus is done, nothing called.
// - Other work, or none: `workForFaction` starts it at the focus; the right work at the wrong focus: `setFocus`.
// RAM: `getCurrentWork` 0.5 + `isFocused` 0.1 + `workForFaction` 3 + `setFocus` 0.1 at SF4.3 or in BN4
// (ram-budget.json): 5.3 GB.
import type { EffectorReport, FactionWorkType } from "@bitburner-agent/core";
import type { FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const workType = String(ns.args[1] ?? "") as FactionWorkType;
  const focus = String(ns.args[2] ?? "") === "true";
  const isThisWork = () => {
    const current = ns.singularity.getCurrentWork();
    return current?.type === "FACTION" && current.factionName === faction && current.factionWorkType === workType;
  };
  const converged = () => isThisWork() && ns.singularity.isFocused() === focus;
  const report: EffectorReport = { done: converged(), problem: null };
  if (!report.done) {
    if (!isThisWork()) ns.singularity.workForFaction(faction as FactionName, workType, focus);
    else ns.singularity.setFocus(focus);
    report.done = converged();
    if (!report.done) {
      report.problem = `not ${focus ? "focused on" : "doing"} ${workType} work for ${faction} (is it joined, and does it offer it?)`;
    }
  }
  reportToAgent(ns, report);
}
