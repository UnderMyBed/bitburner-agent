// agent/<deploymentId>/singularity-buy-augmentation.js: the `singularity` backend's augmentation purchase (#149,
// architecture §5.6), for when the game has Singularity (SF4, or BN4). Arguments: the faction, the augmentation, the
// level (1, or NeuroFlux Governor's level to buy), and when to give up (unused: the call is quick).
// - The game first, as the `ui` backend's worker does: owned (installed or queued) is done without buying. NeuroFlux's
//   level is its installed level (`getResetInfo().ownedAugs`) plus one per queued copy (`getOwnedAugmentations(true)`
//   lists the installed once and each queued copy), as the game counts it (`Augmentation/Augmentation.ts`, `getLevel`).
// - `purchaseAugmentation` refuses what the page would (money, reputation, prerequisites, a non-member), returning false.
// RAM: `getResetInfo` 1 + `getOwnedAugmentations` 5 + `purchaseAugmentation` 5 at SF4.3 or in BN4 (ram-budget.json):
// 12.6 GB. The Agent uses the page where it doesn't fit home beside it.
import { type EffectorReport, NEUROFLUX_GOVERNOR } from "@bitburner-agent/core";
import type { AugmentationName, FactionName, NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const faction = String(ns.args[0] ?? "");
  const augmentation = String(ns.args[1] ?? "");
  const level = Number(ns.args[2] ?? 1);
  /** NeuroFlux's level now, or whether another augmentation is owned (1) or not (0). */
  const levelNow = () => {
    const owned = ns.singularity.getOwnedAugmentations(true);
    if (augmentation !== NEUROFLUX_GOVERNOR) return owned.includes(augmentation) ? 1 : 0;
    const installedLevel = ns.getResetInfo().ownedAugs.get(augmentation) ?? 0;
    const queued = owned.filter((name) => name === augmentation).length - (installedLevel > 0 ? 1 : 0);
    return installedLevel + queued;
  };
  const report: EffectorReport = { done: levelNow() >= level, problem: null };
  if (!report.done) {
    if (levelNow() + 1 !== level) {
      report.problem = `${NEUROFLUX_GOVERNOR}'s next level is ${levelNow() + 1}, not ${level}: the levels before it come first`;
    } else {
      ns.singularity.purchaseAugmentation(faction as FactionName, augmentation as AugmentationName);
      report.done = levelNow() >= level;
      if (!report.done) {
        report.problem = `${augmentation} isn't owned after buying it (the money, the reputation or a prerequisite?)`;
      }
    }
  }
  reportToAgent(ns, report);
}
