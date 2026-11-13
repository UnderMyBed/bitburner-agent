// agent/<deploymentId>/singularity-destroy-bitnode.js: the `singularity` backend's destroy (#175, architecture §5.6,
// §5.7), for when the game has Singularity (SF4, or BN4). Arguments: the BitNode to enter, the script to start after
// it (`agent/boot.js`), and when to give up (unused: the call is quick).
// - w0r1d_d43m0n's preconditions first, worded as every backend words them (core's `worldDaemonProblem`).
// - The Black Ops' route (#398): the game takes all 21 done in place of the hacking level and root
//   (`NetscriptFunctions/Singularity.ts:1176-1183`). Their count has no NS call under 2 GB (`getNextBlackOp`), so in the
//   division (`bladeburner.inBladeburner`, 0 GB, `Netscript/RamCostGenerator.ts:335`) the call goes ahead and the game's
//   own check decides; out of it, the preconditions' problem is reported as before.
// - `destroyW0r1dD43m0n(nextBitNode, cbScript)` (`NetscriptFunctions/Singularity.ts:1153-1194`): it backdoors
//   w0r1d_d43m0n and enters the next BitNode itself (`RedPill.tsx:53-93`, no BitVerse page), every script dying, this
//   one and the Agent too, so nothing is reported. 500 ms later the game starts `cbScript` on home, with 1 thread and
//   no args (`runAfterReset`, `:59-76`); `boot.js` starts the deployed Agent, which connects to the brain afresh.
// - Refused (its own checks, `:1170-1186`), it logs and returns, and this script lives on to say so.
// RAM: `destroyW0r1dD43m0n` 32 at SF4.3 or in BN4, and the preconditions' 0.3 (ram-budget.json): 33.9 GB, beside the
// Agent only on a 64 GB home. The Agent uses the page where it doesn't fit.
import { BLACK_OPS_COUNT, worldDaemonProblem } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";
import { worldDaemonStanding } from "../workers/world-daemon-standing.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const nextBitNode = Number(ns.args[0] ?? 0);
  const callbackScript = String(ns.args[1] ?? "");
  const problem = worldDaemonProblem(worldDaemonStanding(ns));
  // In the division, the Black Ops may stand in for it (#398): the game's check decides.
  const blackOps = problem !== null && ns.bladeburner.inBladeburner();
  if (problem !== null && !blackOps) {
    reportToAgent(ns, { done: false, problem });
    return;
  }
  ns.singularity.destroyW0r1dD43m0n(nextBitNode, callbackScript);
  // Destroyed, this script is dead, and the report's call throws the game's own kill. Here, the game refused.
  reportToAgent(ns, {
    done: false,
    problem: blackOps
      ? `the game refused to destroy w0r1d_d43m0n: ${problem}, and not all ${BLACK_OPS_COUNT} Black Ops done`
      : "the game refused to destroy w0r1d_d43m0n (its requirements not met)",
  });
}
