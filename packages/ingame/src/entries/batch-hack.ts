// agent/<deploymentId>/batch-hack.js: a batch's hack (#204), started by the batcher on one of its hosts, landing at the
// moment it names (../workers/batch-operation.ts). Started too late to land on time, it doesn't hack.
// RAM: `hack` 0.1 + `getHackTime` 0.05 (ram-budget.json; core's BATCH_HACK_RAM_GB).
import type { NS } from "../ns.ts";
import { landOperation } from "../workers/batch-operation.ts";

export async function main(ns: NS): Promise<void> {
  await landOperation(
    ns,
    (target) => ns.getHackTime(target),
    (target, options) => ns.hack(target, options),
    { runLate: false },
  );
}
