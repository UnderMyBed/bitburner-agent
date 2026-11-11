// agent/<deploymentId>/hack-loop-deploy.js: the hack loop's second home worker (#134). Arguments: whether the loop
// should run, then each host the brain named followed by its target and its hack threads (core's
// `hackLoopDeployArguments`): most earn on the target, and some may prepare the next one (#184); each hacks with its
// own count, so together they never hack a target dry (#187). On every server, it stops our loops that shouldn't run
// there (another deployment's, one whose script, target or hack threads aren't this host's, on a server that isn't a
// host, or all of them when off), and starts this deployment's loop on each host where it isn't running, with the
// threads the free RAM allows, and the hack threads capped at those; one running beside free RAM that holds another
// thread is started again at full size (#211). It never touches any other script, and uses only RAM left free.
// - Levelling mode (#336): the level loop (`level-loop.js`) or the grow loop (`level-grow.js`), the operation the
//   brain sends, in the hack loop's place on each host, and on home, where our loops never run otherwise
//   (core's `hostLoopOf`), only beyond the RAM the brain says home keeps for the Agent and its workers: home's loop is
//   sized from home's free RAM less that kept RAM (core's `loopThreadsRoom`), so the reservation stays free beside
//   whatever runs as it starts; once other scripts' end frees as much again, it's started again at full size
//   (`restartsAtFullSize`). It holds home for as long as it runs, where the share threads' 10 s rounds give it back.
//   Neither loop is a bundle (#339): this worker writes the one sent to its deployment's folder on home first (core's
//   `loopSourceOf`), so outside levelling the deploy, and all it does, is the one before levelling.
// RAM: `scan` 0.2 + `hasRootAccess` 0.05 + `ps` 0.2 + `kill` 0.5 + `scp` 0.6 + `exec` 1.3 + `getScriptRam` 0.1 +
// `getServerMaxRam` and `getServerUsedRam` 0.05 each, `read` and `write` none (RamCostGenerator.ts:621-625;
// ram-budget.json).
import {
  deployedFilePath,
  deploymentIdOfPath,
  type HackLoopDeployReport,
  hackLoopsByHost,
  hostLoopOf,
  isHackLoopFile,
  keptGbOf,
  loopScriptNameOf,
  loopSourceOf,
  loopThreadsRoom,
  restartsAtFullSize,
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
  const fileOf = (loop: Parameters<typeof loopScriptNameOf>[0]) =>
    deployedFilePath(ownDeploymentId, loopScriptNameOf(loop));
  // The script the hosts run: every host's is the same one.
  const [anyLoop] = loopOfHost.values();
  // Levelling's loop, written when it's sent and not yet there: the hack loop's, a bundle, is never written.
  const source = loopSourceOf(anyLoop);
  if (anyLoop !== undefined && source !== null && ns.read(fileOf(anyLoop)) !== source) {
    ns.write(fileOf(anyLoop), source, "w");
  }
  if (anyLoop !== undefined && ns.getScriptRam(fileOf(anyLoop), "home") === 0) {
    // Stopping still goes ahead: only starting needs the script.
    report.problem = `${fileOf(anyLoop)} isn't on home`;
  }
  for (const hostname of reachableHostnames(ns)) {
    if (!ns.hasRootAccess(hostname)) continue;
    // This host's loop, or undefined: no loop of ours runs here. Home runs one only in levelling mode.
    const loop = hostLoopOf(loopOfHost, hostname);
    const loopFile = fileOf(loop);
    const loopRam = ns.getScriptRam(loopFile, "home");
    // What this host keeps of its RAM from our loop: on home, the brain's word (unread: all of it).
    const keptGb = keptGbOf(hostname, loop);
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
        hackThreads += loop.levelling !== undefined ? 0 : wanted.length > 1 ? (wanted[1] as number) : process.threads;
        runningPids.push(process.pid);
      } else {
        ns.kill(process.pid);
      }
    }
    // The threads our loop may hold here beside the rest, `runningThreads` of them ours now.
    const threadsRoom = () =>
      loopThreadsRoom({
        maxGb: ns.getServerMaxRam(hostname),
        usedGb: ns.getServerUsedRam(hostname),
        oursGb: runningThreads * loopRam,
        keptGb,
        scriptGb: loopRam,
      });
    // A loop started small, beside RAM that's been freed since (the batcher's operations, landed after it was turned
    // off, #211; on home, other scripts' end), is started again at full size: so no loop stays starved. Only RAM freed
    // since it started can do that, so it's rare: what a restart loses is the weaken or grow under way.
    if (loopRam > 0 && restartsAtFullSize(threadsRoom(), runningThreads, keptGb, loopRam)) {
      for (const pid of runningPids) ns.kill(pid);
      runningThreads = 0;
      hackThreads = 0;
    }
    if (loop !== undefined && runningThreads === 0 && loopRam > 0) {
      const threads = threadsRoom();
      const startArguments = loopArguments(threads);
      if (
        threads > 0 &&
        (hostname === "home" || ns.scp(loopFile, hostname, "home")) &&
        ns.exec(loopFile, hostname, threads, ...startArguments)
      ) {
        runningThreads = threads;
        hackThreads =
          loop.levelling !== undefined ? 0 : startArguments.length > 1 ? (startArguments[1] as number) : threads;
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
