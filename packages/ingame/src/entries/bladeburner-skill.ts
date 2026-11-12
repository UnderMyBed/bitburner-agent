// agent/<deploymentId>/bladeburner-skill.js: a home worker that raises a Bladeburner skill to a level (#379), with the
// NS API alone, which needs no Singularity: the `ui` backend's worker, in any game, with no page to drive. Arguments:
// the skill, the level, and when to give up (unused: the calls are quick). What it does, and its RAM, are in
// ../workers/bladeburner-skill.ts (ram-budget.json).
import type { NS } from "../ns.ts";
import { bladeburnerSkillRaise } from "../workers/bladeburner-skill.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  reportToAgent(ns, bladeburnerSkillRaise(ns, String(ns.args[0] ?? ""), Number(ns.args[1] ?? 0)));
}
