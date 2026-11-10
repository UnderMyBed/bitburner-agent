// agent/<deploymentId>/create-gang.js: a home worker that forms the gang (#325), with the NS API alone, which needs no
// Singularity: the `ui` backend's worker, in any game, with no page to drive. Arguments: the faction, and when to give
// up (unused: the calls are quick). What it does, and its RAM, are in ../workers/gang-creation.ts (ram-budget.json).
import type { NS } from "../ns.ts";
import { gangCreation } from "../workers/gang-creation.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  reportToAgent(ns, gangCreation(ns, String(ns.args[0] ?? "")));
}
