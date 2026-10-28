// agent/<deploymentId>/singularity-install-augmentations.js: the `singularity` backend's install (#164, architecture
// §5.6, §5.7), for when the game has Singularity (SF4, or BN4). Arguments: the script to start after the reset
// (`agent/boot.js`), and when to give up (unused: the call is quick).
// - `installAugmentations(cbScript)` (`NetscriptFunctions/Singularity.ts:196-211`) is the game's own check: with
//   nothing queued it returns false and does nothing, so there's nothing left to install, which is done.
// - Otherwise it installs (`Augmentation/AugmentationHelpers.ts:69-115`): every script dies, this one and the Agent
//   too, so nothing is reported, and the game resets. 500 ms later the game starts `cbScript` on home, with 1 thread
//   and no args (`runAfterReset`, `:59-76`); `boot.js` starts the deployed Agent, which connects to the brain afresh.
// RAM: `installAugmentations` 5 at SF4.3 or in BN4 (ram-budget.json): 6.6 GB. The Agent uses the page where it doesn't
// fit home beside it.
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const callbackScript = String(ns.args[0] ?? "");
  // Typed void, but false with nothing queued; with something queued, this script is dead once it returns.
  const installed = ns.singularity.installAugmentations(callbackScript) as unknown;
  if (installed !== false) return;
  reportToAgent(ns, { done: true, problem: null });
}
