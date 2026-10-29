// agent/<deploymentId>/batch-grow.js: a batch's grow, or a preparation wave's (#204), started by the batcher on one of
// its hosts, landing at the moment it names (../workers/batch-operation.ts). Started too late, it grows late.
// RAM: `grow` 0.15 + `getGrowTime` 0.05 (ram-budget.json; core's BATCH_GROW_RAM_GB).
import type { NS } from "../ns.ts";
import { landOperation } from "../workers/batch-operation.ts";

export async function main(ns: NS): Promise<void> {
  await landOperation(
    ns,
    (target) => ns.getGrowTime(target),
    (target, options) => ns.grow(target, options),
    { runLate: true },
  );
}
