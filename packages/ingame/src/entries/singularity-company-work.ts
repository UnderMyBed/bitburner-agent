// agent/<deploymentId>/singularity-company-work.js: the work activity's `singularity` effector for company work (#153,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the company, the job field, "true" or
// "false" for focus, and when to give up (unused: the calls are quick).
// - The game first: already this work (a job in the field there) at this focus is done, nothing called.
// - No job in the field there: `applyToCompany`, which refuses where the player doesn't qualify (null).
// - Then `workForCompany` at the focus, or, the right work at the wrong focus, `setFocus`.
// RAM: `getPlayer` 0.5 + `getCurrentWork` 0.5 + `isFocused` 0.1 + `applyToCompany` 3 + `workForCompany` 3 + `setFocus`
// 0.1 at SF4.3 or in BN4 (ram-budget.json): 8.8 GB.
import { type EffectorReport, JOB_FIELDS } from "@bitburner-agent/core";
import type { CompanyName, JobField, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const company = String(ns.args[0] ?? "");
  const field = String(ns.args[1] ?? "");
  const focus = String(ns.args[2] ?? "") === "true";
  const titles = (JOB_FIELDS[field] ?? []).map((job) => job.title);
  const hasJobInField = () => titles.includes((ns.getPlayer().jobs as Record<string, string>)[company] ?? "");
  const isThisWork = () => {
    const current = ns.singularity.getCurrentWork();
    return current?.type === "COMPANY" && current.companyName === company && hasJobInField();
  };
  const converged = () => isThisWork() && ns.singularity.isFocused() === focus;
  const report: EffectorReport = { done: converged(), problem: null };
  if (!report.done) {
    if (!hasJobInField() && ns.singularity.applyToCompany(company as CompanyName, field as JobField) === null) {
      report.problem = `not qualified for a ${field} job at ${company} yet`;
    } else {
      if (!isThisWork()) ns.singularity.workForCompany(company as CompanyName, focus);
      else ns.singularity.setFocus(focus);
      report.done = converged();
      if (!report.done) report.problem = `not ${focus ? "focused on" : "doing"} ${field} work at ${company}`;
    }
  }
  reportToAgent(ns, report);
}
