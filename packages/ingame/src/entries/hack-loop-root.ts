// agent/<deploymentId>/hack-loop-root.js: the hack loop's first home worker (#134). Roots every server it can reach
// but home: opens the ports it can with the programs on home, then runs NUKE if that's enough, as a player does first.
// RAM: `scan` 0.2 + `hasRootAccess` 0.05 + `fileExists` 0.1 + `getServerNumPortsRequired` 0.1 + `nuke` and the five
// port openers 0.05 each (ram-budget.json).
import type { HackLoopRootReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** Each port-opening program, by its file on home. Called by name, so each is charged once. */
const PORT_OPENERS: [string, (ns: NS, hostname: string) => void][] = [
  ["BruteSSH.exe", (ns, hostname) => ns.brutessh(hostname)],
  ["FTPCrack.exe", (ns, hostname) => ns.ftpcrack(hostname)],
  ["relaySMTP.exe", (ns, hostname) => ns.relaysmtp(hostname)],
  ["HTTPWorm.exe", (ns, hostname) => ns.httpworm(hostname)],
  ["SQLInject.exe", (ns, hostname) => ns.sqlinject(hostname)],
];

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const ownedOpeners = PORT_OPENERS.filter(([programFile]) => ns.fileExists(programFile, "home"));
  const rootedNow: string[] = [];
  for (const hostname of reachableHostnames(ns)) {
    if (hostname === "home" || ns.hasRootAccess(hostname)) continue;
    if (ns.getServerNumPortsRequired(hostname) > ownedOpeners.length) continue;
    for (const [, openPort] of ownedOpeners) openPort(ns, hostname);
    if (ns.nuke(hostname)) rootedNow.push(hostname);
  }
  const report: HackLoopRootReport = { rootedNow };
  reportToAgent(ns, report);
}
