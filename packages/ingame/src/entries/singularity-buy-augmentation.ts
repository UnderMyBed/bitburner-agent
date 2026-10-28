// agent/<deploymentId>/singularity-buy-augmentation.js: the `singularity` backend's augmentation purchase (#149,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the faction, the augmentation, the
// level (1, or NeuroFlux Governor's level to buy), and when to give up (unused: the call is quick).
// - The game first, as the `ui` backend's worker does: owned (installed or queued) is done without buying.
//   NeuroFlux's level is counted as the game counts it (core's `neuroFluxLevel`).
// - `purchaseAugmentation` refuses what the page would (a non-member, an augmentation the faction doesn't sell, the
//   money, the reputation, a prerequisite), returning false.
// RAM: `getResetInfo` 1 + `getOwnedAugmentations` 5 + `purchaseAugmentation` 5 at SF4.3 or in BN4
// (ram-budget.json): 12.6 GB. The Agent uses the page where it doesn't fit home beside it.
import { augmentationProblems, type EffectorReport, NEUROFLUX_GOVERNOR, neuroFluxLevel } from "@bitburner-agent/core";
import type { AugmentationName, FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const augmentation = String(ns.args[1] ?? "");
  const level = Number(ns.args[2] ?? 1);
  /** NeuroFlux's level now; for another augmentation, 1 if owned, else 0. */
  const levelNow = () => {
    const owned = ns.singularity.getOwnedAugmentations(true);
    if (augmentation !== NEUROFLUX_GOVERNOR) return owned.includes(augmentation) ? 1 : 0;
    return neuroFluxLevel(ns.getResetInfo().ownedAugs.get(augmentation) ?? 0, owned);
  };
  const before = levelNow();
  const report: EffectorReport = { done: before >= level, problem: null };
  if (!report.done) {
    // Only NeuroFlux has levels past 1 (the intent's parser refuses any other).
    if (before + 1 !== level) {
      report.problem = augmentationProblems.outOfTurn(before + 1, level);
    } else {
      ns.singularity.purchaseAugmentation(faction as FactionName, augmentation as AugmentationName);
      report.done = levelNow() >= level;
      if (!report.done) report.problem = augmentationProblems.refused(augmentation, faction);
    }
  }
  reportToAgent(ns, report);
}
