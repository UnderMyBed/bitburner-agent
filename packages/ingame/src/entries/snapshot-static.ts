// agent/<deploymentId>/snapshot-static.js: the static tier's worker (#89). Every reachable server's fixed fields.
// RAM: `scan` 0.2 + `getServer` 2.0 (ram-budget.json).
import type { StaticSnapshotData } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const data: StaticSnapshotData = {
    servers: reachableHostnames(ns).map((hostname) => {
      const server = ns.getServer(hostname);
      return {
        hostname,
        maxRam: server.maxRam,
        cpuCores: server.cpuCores,
        purchasedByPlayer: server.purchasedByPlayer,
        moneyMax: server.moneyMax,
        minDifficulty: server.minDifficulty,
        requiredHackingSkill: server.requiredHackingSkill,
        numOpenPortsRequired: server.numOpenPortsRequired,
      };
    }),
  };
  reportToAgent(ns, data);
}
