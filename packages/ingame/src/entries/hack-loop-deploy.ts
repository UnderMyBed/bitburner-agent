// agent/<deploymentId>/hack-loop-deploy.js: the hack loop's second home worker (#134). Arguments: whether the loop
// should run, then each host the brain named followed by its target (core's `hackLoopDeployArguments`): most earn on
// the target, and some may prepare the next one (#184). On every server but home, it stops our loops that shouldn't
// run there (another deployment's, one whose target isn't this host's, on a server that isn't a host, or all of them
// when off), and starts this deployment's loop on each host where it isn't running, with the threads the free RAM
// allows. It never touches any other script, and uses only RAM left free.
// RAM: `scan` 0.2 + `hasRootAccess` 0.05 + `ps` 0.2 + `kill` 0.5 + `scp` 0.6 + `exec` 1.3 + `getScriptRam` 0.1 +
// `getServerMaxRam` and `getServerUsedRam` 0.05 each (ram-budget.json).
import {
  deployedFilePath,
  deploymentIdOfPath,
  HACK_LOOP_SCRIPT_NAME,
  type HackLoopDeployReport,
  hackLoopTargetsByHost,
  isHackLoopFile,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const targetOfHost = hackLoopTargetsByHost(ns.args);
  const report: HackLoopDeployReport = { serversRunning: 0, threadsRunning: 0, byTarget: [], problem: null };
  const ownDeploymentId = deploymentIdOfPath(ns.getScriptName());
  if (ownDeploymentId === null) {
    report.problem = `${ns.getScriptName()} isn't in a deployment folder`;
    reportToAgent(ns, report);
    return;
  }
  const loopFile = deployedFilePath(ownDeploymentId, HACK_LOOP_SCRIPT_NAME);
  const loopRam = ns.getScriptRam(loopFile, "home");
  if (targetOfHost.size > 0 && loopRam === 0) {
    // Stopping still goes ahead: only starting needs the script.
    report.problem = `${loopFile} isn't on home`;
  }
  for (const hostname of reachableHostnames(ns)) {
    if (hostname === "home" || !ns.hasRootAccess(hostname)) continue;
    // This host's target, or undefined: no loop of ours runs here.
    const targetHostname = targetOfHost.get(hostname);
    let runningThreads = 0;
    for (const process of ns.ps(hostname)) {
      if (!isHackLoopFile(process.filename)) continue;
      if (targetHostname !== undefined && process.filename === loopFile && process.args[0] === targetHostname) {
        runningThreads += process.threads;
      } else {
        ns.kill(process.pid);
      }
    }
    if (targetHostname !== undefined && runningThreads === 0 && loopRam > 0) {
      const freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
      const threads = Math.floor(freeRam / loopRam);
      if (threads > 0 && ns.scp(loopFile, hostname, "home") && ns.exec(loopFile, hostname, threads, targetHostname)) {
        runningThreads = threads;
      }
    }
    if (targetHostname !== undefined && runningThreads > 0) {
      report.serversRunning += 1;
      report.threadsRunning += runningThreads;
      let running = report.byTarget.find((each) => each.target === targetHostname);
      if (running === undefined) {
        running = { target: targetHostname, serversRunning: 0, threadsRunning: 0 };
        report.byTarget.push(running);
      }
      running.serversRunning += 1;
      running.threadsRunning += runningThreads;
    }
  }
  reportToAgent(ns, report);
}
