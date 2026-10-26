// agent/<deploymentId>/snapshot-medium.js: the medium tier's worker (#89). The player, and every reachable server's
// RAM, cores, money, security and access. RAM: `getPlayer` 0.5 + `scan` 0.2 + `getServer` 2.0 (ram-budget.json).
import type { MediumSnapshotData } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const data: MediumSnapshotData = {
    player: { ...ns.getPlayer() },
    servers: reachableHostnames(ns).map((hostname) => {
      const server = ns.getServer(hostname);
      return {
        hostname,
        maxRam: server.maxRam,
        cpuCores: server.cpuCores,
        hasAdminRights: server.hasAdminRights,
        backdoorInstalled: server.backdoorInstalled,
        moneyAvailable: server.moneyAvailable,
        hackDifficulty: server.hackDifficulty,
      };
    }),
  };
  reportToAgent(ns, data);
}
