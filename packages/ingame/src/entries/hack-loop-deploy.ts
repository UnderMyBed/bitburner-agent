// agent/<deploymentId>/hack-loop-deploy.js: the hack loop's second home worker (#134). Arguments: whether the loop
// should run, then each host the brain named followed by its target and its hack threads (core's
// `hackLoopDeployArguments`): most earn on the target, and some may prepare the next one (#184); each hacks with its
// own count, so together they never hack a target dry (#187). On every server but home, it stops our loops that
// shouldn't run there (another deployment's, one whose target or hack threads aren't this host's, on a server that
// isn't a host, or all of them when off), and starts this deployment's loop on each host where it isn't running, with
// the threads the free RAM allows, and the hack threads capped at those; one running beside free RAM that holds
// another thread is started again at full size (#211). It never touches any other script, and uses only RAM
// left free.
// RAM: `scan` 0.2 + `hasRootAccess` 0.05 + `ps` 0.2 + `kill` 0.5 + `scp` 0.6 + `exec` 1.3 + `getScriptRam` 0.1 +
// `getServerMaxRam` and `getServerUsedRam` 0.05 each (ram-budget.json).
import {
  deployedFilePath,
  deploymentIdOfPath,
  HACK_LOOP_SCRIPT_NAME,
  type HackLoopDeployReport,
  hackLoopsByHost,
  isHackLoopFile,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const loopOfHost = hackLoopsByHost(ns.args);
  const report: HackLoopDeployReport = { serversRunning: 0, threadsRunning: 0, byTarget: [], problem: null };
  const ownDeploymentId = deploymentIdOfPath(ns.getScriptName());
  if (ownDeploymentId === null) {
    report.problem = `${ns.getScriptName()} isn't in a deployment folder`;
    reportToAgent(ns, report);
    return;
  }
  const loopFile = deployedFilePath(ownDeploymentId, HACK_LOOP_SCRIPT_NAME);
  const loopRam = ns.getScriptRam(loopFile, "home");
  if (loopOfHost.size > 0 && loopRam === 0) {
    // Stopping still goes ahead: only starting needs the script.
    report.problem = `${loopFile} isn't on home`;
  }
  for (const hostname of reachableHostnames(ns)) {
    if (hostname === "home" || !ns.hasRootAccess(hostname)) continue;
    // This host's loop, or undefined: no loop of ours runs here.
    const loop = loopOfHost.get(hostname);
    // The loop's arguments with `threads` threads: its target, and its hack threads capped at those (none: all).
    const loopArguments = (threads: number): (string | number)[] =>
      loop === undefined
        ? []
        : loop.hackThreads === null
          ? [loop.target]
          : [loop.target, Math.min(loop.hackThreads, threads)];
    let runningThreads = 0;
    let hackThreads = 0;
    const runningPids: number[] = [];
    for (const process of ns.ps(hostname)) {
      if (!isHackLoopFile(process.filename)) continue;
      const wanted = loopArguments(process.threads);
      if (
        loop !== undefined &&
        process.filename === loopFile &&
        process.args.length === wanted.length &&
        process.args.every((arg, index) => arg === wanted[index])
      ) {
        runningThreads += process.threads;
        hackThreads += wanted.length > 1 ? (wanted[1] as number) : process.threads;
        runningPids.push(process.pid);
      } else {
        ns.kill(process.pid);
      }
    }
    // A loop started small, beside RAM that's been freed since (the batcher's operations, landed after it was turned
    // off, #211), is started again at full size once the free RAM holds another thread: so no loop stays starved. Only
    // RAM freed since it started can do that, so it's rare: what a restart loses is the weaken or grow under way.
    if (runningThreads > 0 && loopRam > 0) {
      const freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
      if (Math.floor(freeRam / loopRam) >= 1) {
        for (const pid of runningPids) ns.kill(pid);
        runningThreads = 0;
        hackThreads = 0;
      }
    }
    if (loop !== undefined && runningThreads === 0 && loopRam > 0) {
      const freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
      const threads = Math.floor(freeRam / loopRam);
      const startArguments = loopArguments(threads);
      if (
        threads > 0 &&
        ns.scp(loopFile, hostname, "home") &&
        ns.exec(loopFile, hostname, threads, ...startArguments)
      ) {
        runningThreads = threads;
        hackThreads = startArguments.length > 1 ? (startArguments[1] as number) : threads;
      }
    }
    if (loop !== undefined && runningThreads > 0) {
      report.serversRunning += 1;
      report.threadsRunning += runningThreads;
      let running = report.byTarget.find((each) => each.target === loop.target);
      if (running === undefined) {
        running = { target: loop.target, serversRunning: 0, threadsRunning: 0, hackThreadsRunning: 0 };
        report.byTarget.push(running);
      }
      running.serversRunning += 1;
      running.threadsRunning += runningThreads;
      running.hackThreadsRunning += hackThreads;
    }
  }
  reportToAgent(ns, report);
}
