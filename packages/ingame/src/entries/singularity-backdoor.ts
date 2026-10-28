// agent/<deploymentId>/singularity-backdoor.js: the `singularity` backend's backdoor (#162, architecture §5.6), for
// when the game has Singularity (SF4, or BN4). Arguments: the server, and when to give up (the game's `Date.now()`).
// - The game first, and the same refusals, as the `ui` worker's (`backdoorStanding`).
// - `connect` home, then along the way from home (`NetscriptFunctions/Singularity.ts:476-511`), then
//   `installBackdoor()` (`:518-560`), which takes hacking time / 4 and leaves the terminal free. A script killed
//   meanwhile leaves no backdoor, so the worker stays until it ends, then `connect`s home. One that won't end within
//   the round writes its report at once ("installing … s left"), though the Agent still waits out the round for the
//   worker (`run-worker.ts`); the next try, 30 s on, finds it still running if it is, and holds 8 GB of home meanwhile,
//   which the backend choice allows for (`effector-runner.ts`, free RAM).
// RAM: `getServer` 2.0 + `scan` 0.2 + `serverExists` 0.1 + `getHackingLevel` and `getHackTime` 0.05 each +
// `singularity.connect` and `singularity.installBackdoor` 2 each at SF4.3 or in BN4 (ram-budget.json).
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { backdoorStanding, installingProblem } from "../workers/backdoor-standing.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const hostname = String(ns.args[0] ?? "");
  const deadlineMs = Number(ns.args[1] ?? 0);
  const report = (done: boolean, problem: string | null) => reportToAgent(ns, { done, problem } as EffectorReport);
  const standing = backdoorStanding(ns, hostname);
  if (standing.installed) {
    if (standing.terminalThere) ns.singularity.connect("home");
    report(true, null);
    return;
  }
  if (standing.route === null) {
    report(false, standing.problem);
    return;
  }
  ns.singularity.connect("home");
  for (const hop of standing.route) {
    if (!ns.singularity.connect(hop)) {
      ns.singularity.connect("home");
      report(false, `couldn't connect to ${hop} on the way to ${hostname}`);
      return;
    }
  }
  const endsAtMs = Date.now() + ns.getHackTime(hostname) / 4;
  const endsInTheRound = endsAtMs <= deadlineMs;
  if (!endsInTheRound) report(false, installingProblem(hostname, endsAtMs - Date.now()));
  await ns.singularity.installBackdoor();
  ns.singularity.connect("home");
  if (endsInTheRound) {
    const installed = ns.getServer(hostname).backdoorInstalled === true;
    report(installed, installed ? null : `no backdoor on ${hostname} after installing it`);
  }
}
