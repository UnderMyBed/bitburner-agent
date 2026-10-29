// agent/<deploymentId>/batch-weaken.js: a batch's weaken, either of them, or a preparation wave's (#204), started by
// the batcher on one of its hosts, landing at the moment it names (../workers/batch-operation.ts). Started too late,
// it weakens late.
// RAM: `weaken` 0.15 + `getWeakenTime` 0.05 (ram-budget.json; core's BATCH_WEAKEN_RAM_GB).
import type { NS } from "../ns.ts";
import { landOperation } from "../workers/batch-operation.ts";

export async function main(ns: NS): Promise<void> {
  await landOperation(
    ns,
    (target) => ns.getWeakenTime(target),
    (target, options) => ns.weaken(target, options),
    { runLate: true },
  );
}
