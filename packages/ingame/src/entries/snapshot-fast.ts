// agent/<deploymentId>/snapshot-fast.js: the fast tier's worker (#89). Money, home's RAM, and the scripts on home.
// RAM: `getPlayer` 0.5 + `ps` 0.2 + `getServerUsedRam` 0.05 + `getServerMaxRam` 0.05 (ram-budget.json).
import type { FastWorkerData } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const data: FastWorkerData = {
    money: ns.getPlayer().money,
    homeRamUsed: ns.getServerUsedRam("home"),
    homeMaxRam: ns.getServerMaxRam("home"),
    homeProcesses: ns.ps("home").map(({ pid, filename, threads, args, temporary }) => ({
      pid,
      filename,
      threads,
      args,
      temporary,
    })),
  };
  reportToAgent(ns, data);
}
