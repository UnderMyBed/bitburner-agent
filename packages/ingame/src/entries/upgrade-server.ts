// agent/<deploymentId>/upgrade-server.js: a home worker that raises a cloud server's RAM (#194), with the NS API alone,
// which needs no Singularity (`NetscriptFunctions/Cloud.ts:104-114`): the `ui` backend's worker, in any game, with no
// page to drive. Arguments: the hostname, the RAM in GB, and when to give up (unused: the calls are quick). What it
// does, and its RAM, are in ../workers/cloud-server-upgrade.ts (ram-budget.json).
import type { NS } from "../ns.ts";
import { cloudServerUpgrade } from "../workers/cloud-server-upgrade.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const hostname = String(ns.args[0] ?? "");
  const ram = Number(ns.args[1] ?? 0);
  reportToAgent(ns, cloudServerUpgrade(ns, hostname, ram));
}
