// agent/<deploymentId>/batcher-deploy.js: the batcher's home worker (#205). Arguments: the host the batcher should run
// on, or none for none. On every server it can reach, it stops our batchers that shouldn't run there (another
// deployment's, one on another host, or every one with none wanted), and starts this deployment's on the host if it
// isn't running there: copied there with its operation scripts (from home, where the deployer puts them), with no
// argument, so it reads its config from its port, and temporary, so a reload doesn't bring it back without the Agent.
// It never touches any other script. It reports where ours runs, or why it can't (no deployment folder, no batcher on
// home, the host without the room or the access) rather than failing silently.
// RAM: `exec` 1.3 + `scp` 0.6 + `kill` 0.5 + `scan` and `ps` 0.2 each (ram-budget.json).
import {
  BATCH_GROW_SCRIPT_NAME,
  BATCH_HACK_SCRIPT_NAME,
  BATCH_WEAKEN_SCRIPT_NAME,
  BATCHER_SCRIPT_NAME,
  type BatcherDeployReport,
  deployedFilePath,
  deploymentIdOfPath,
  isBatcherFile,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reachableHostnames } from "../workers/reachable-hostnames.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const runOn = ns.args.length > 0 ? String(ns.args[0]) : null;
  const report: BatcherDeployReport = { running: null, started: false, stopped: 0, problem: null };
  const ownDeploymentId = deploymentIdOfPath(ns.getScriptName());
  if (ownDeploymentId === null) {
    report.problem = `${ns.getScriptName()} isn't in a deployment folder`;
    reportToAgent(ns, report);
    return;
  }
  const batcherFile = deployedFilePath(ownDeploymentId, BATCHER_SCRIPT_NAME);
  for (const hostname of reachableHostnames(ns)) {
    for (const process of ns.ps(hostname)) {
      if (!isBatcherFile(process.filename)) continue;
      if (hostname === runOn && process.filename === batcherFile && report.running === null) {
        report.running = hostname;
      } else if (ns.kill(process.pid)) {
        report.stopped += 1;
      }
    }
  }
  if (runOn !== null && report.running === null) {
    const files = [BATCHER_SCRIPT_NAME, BATCH_HACK_SCRIPT_NAME, BATCH_GROW_SCRIPT_NAME, BATCH_WEAKEN_SCRIPT_NAME].map(
      (name) => deployedFilePath(ownDeploymentId, name),
    );
    if (runOn !== "home" && !ns.scp(files, runOn, "home")) {
      report.problem = `can't copy the batcher to ${runOn} (is it on home, and ${runOn} rooted?)`;
    } else if (ns.exec(batcherFile, runOn, { threads: 1, temporary: true }) === 0) {
      report.problem = `${batcherFile} couldn't start on ${runOn} (no room, or no access)`;
    } else {
      report.running = runOn;
      report.started = true;
    }
  }
  reportToAgent(ns, report);
}
