// agent/<deploymentId>/hack-loop-deploy.js: the hack loop's second home worker (#134). Arguments: whether the loop
// should run, and its target ("" for none yet). On every rooted server but home, it stops our loops that shouldn't run
// (another deployment's, another target's, or all of them when off), and starts this deployment's loop where it isn't
// running, with the threads the free RAM allows. It never touches any other script, and uses only RAM left free.
// RAM: `scan` 0.2 + `hasRootAccess` 0.05 + `ps` 0.2 + `kill` 0.5 + `scp` 0.6 + `exec` 1.3 + `getScriptRam` 0.1 +
// `getServerMaxRam` and `getServerUsedRam` 0.05 each (ram-budget.json).
import {
  deployedFilePath,
  deploymentIdOfPath,
  HACK_LOOP_SCRIPT_NAME,
  type HackLoopDeployReport,
  isHackLoopFile,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const loopShouldRun = ns.args[0] === true;
  const targetHostname = String(ns.args[1] ?? "");
  const ownDeploymentId = deploymentIdOfPath(ns.getScriptName());
  if (ownDeploymentId === null) return;
  const loopFile = deployedFilePath(ownDeploymentId, HACK_LOOP_SCRIPT_NAME);
  const wanted = loopShouldRun && targetHostname !== "";
  const loopRam = ns.getScriptRam(loopFile, "home");
  const report: HackLoopDeployReport = { serversRunning: 0, threadsRunning: 0, started: 0, stopped: 0 };
  for (const hostname of reachableHostnames(ns)) {
    if (hostname === "home" || !ns.hasRootAccess(hostname)) continue;
    let runningThreads = 0;
    for (const process of ns.ps(hostname)) {
      if (!isHackLoopFile(process.filename)) continue;
      if (wanted && process.filename === loopFile && process.args[0] === targetHostname) {
        runningThreads += process.threads;
      } else if (ns.kill(process.pid)) {
        report.stopped += 1;
      }
    }
    if (wanted && runningThreads === 0 && loopRam > 0) {
      const freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
      const threads = Math.floor(freeRam / loopRam);
      if (threads > 0 && ns.scp(loopFile, hostname, "home") && ns.exec(loopFile, hostname, threads, targetHostname)) {
        runningThreads = threads;
        report.started += 1;
      }
    }
    if (runningThreads > 0) {
      report.serversRunning += 1;
      report.threadsRunning += runningThreads;
    }
  }
  reportToAgent(ns, report);
}
