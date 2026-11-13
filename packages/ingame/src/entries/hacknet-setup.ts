// agent/<deploymentId>/hacknet-setup.js: a home worker that buys Hacknet the cheapest way to Netburners' invitation's
// totals (#387), with the NS API alone, which needs no Singularity (`NetscriptFunctions/Hacknet.ts:53-118`): the `ui`
// backend's worker, in any game, with no page to drive. Arguments: when to give up (unused: the calls are quick). What
// it does, and its RAM, are in ../workers/hacknet-setup.ts (ram-budget.json).
import type { NS } from "../ns.ts";
import { hacknetSetup } from "../workers/hacknet-setup.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  reportToAgent(ns, hacknetSetup(ns));
}
