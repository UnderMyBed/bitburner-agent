// agent/<deploymentId>/singularity-class-work.js: the work activity's `singularity` effector for a class (#158,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the university or gym, the class
// type, "true" or "false" for focus, and when to give up (unused: the calls are quick).
// - The game first: already this class, at this location (`getCurrentWork`'s `classType` and `location`), at this
//   focus is done, nothing called.
// - Otherwise held back, from `getPlayer`, as the `ui` worker is (core's `classStartProblem`): the location in another
//   city, or a paid class with less money than 10 minutes of it costs. A class under way is never held back.
// - Otherwise `universityCourse` or `gymWorkout` at the focus (`NetscriptFunctions/Singularity.ts:235-376`; each
//   refuses another city too), or, the right class at the wrong focus, `setFocus`.
// RAM: `getPlayer` 0.5 + `getCurrentWork` 0.5 + `isFocused` 0.1 + `universityCourse` 2 + `gymWorkout` 2 + `setFocus`
// 0.1 at SF4.3 or in BN4 (ram-budget.json): 6.8 GB.
import { CLASS_LOCATIONS, classLabel, classStartProblem, type EffectorReport } from "@bitburner-agent/core";
import type { GymLocationName, GymType, NS, UniversityClassType, UniversityLocationName } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const choice = { location: String(ns.args[0] ?? ""), classType: String(ns.args[1] ?? "") };
  const focus = String(ns.args[2] ?? "") === "true";
  const isThisWork = () => {
    const current = ns.singularity.getCurrentWork();
    return current?.type === "CLASS" && current.classType === choice.classType && current.location === choice.location;
  };
  const converged = () => isThisWork() && ns.singularity.isFocused() === focus;
  const report: EffectorReport = { done: converged(), problem: null };
  if (!report.done) {
    const { money, city } = ns.getPlayer();
    const heldBack = isThisWork() ? null : classStartProblem(choice, { money, city });
    if (heldBack !== null) {
      report.problem = heldBack;
    } else {
      if (isThisWork()) ns.singularity.setFocus(focus);
      else if (CLASS_LOCATIONS[choice.location]?.kind === "gym") {
        ns.singularity.gymWorkout(choice.location as GymLocationName, choice.classType as GymType, focus);
      } else {
        ns.singularity.universityCourse(
          choice.location as UniversityLocationName,
          choice.classType as UniversityClassType,
          focus,
        );
      }
      report.done = converged();
      if (!report.done) report.problem = `not ${focus ? "focused on" : "doing"} ${classLabel(choice)}`;
    }
  }
  reportToAgent(ns, report);
}
