// agent/<deploymentId>/join-bladeburner.js: a home worker that joins the Bladeburner division (#367), with the NS API
// alone, which needs no Singularity: the `ui` backend's worker, in any game, with no page to drive. Argument: when to
// give up (unused: the calls are quick). What it does, and its RAM, are in ../workers/bladeburner-division.ts
// (ram-budget.json).
import type { NS } from "../ns.ts";
import { bladeburnerDivisionJoin } from "../workers/bladeburner-division.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  reportToAgent(ns, bladeburnerDivisionJoin(ns));
}
