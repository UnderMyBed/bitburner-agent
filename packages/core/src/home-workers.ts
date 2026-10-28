/**
 * Every worker the Agent runs on home beside itself, one at a time: the snapshot tiers', the hack loop's (#134), the
 * program buyer's (#136), the home RAM upgrader's (#138), the traveller's (#141), the Singularity backend's (#145),
 * the faction joiner's (#147), and the augmentation buyer's (#149). A fresh save's home must hold the Agent plus the largest of those it can run (`freshSaveHomeWorkerFileNames`), so the
 * RAM budget test and the simulator and E2 suites read these lists. Functions, not constants, so in-game bundles that
 * don't use them leave them out.
 */
import { BUY_AUGMENTATION_WORKER_NAME } from "./augmentations.ts";
import { singularityWorkerFileNames } from "./backends.ts";
import { SNAPSHOT_TIERS } from "./control-protocol.ts";
import { JOIN_FACTION_WORKER_NAME } from "./factions.ts";
import { HACK_LOOP_DEPLOY_WORKER_NAME, HACK_LOOP_ROOT_WORKER_NAME } from "./hack-loop.ts";
import { UPGRADE_HOME_RAM_WORKER_NAME } from "./home-ram.ts";
import { TRAVEL_WORKER_NAME } from "./locations.ts";
import { BUY_PROGRAM_WORKER_NAME } from "./programs.ts";
import { snapshotWorkerFileName } from "./snapshots.ts";

export function homeWorkerFileNames(): string[] {
  return [
    ...SNAPSHOT_TIERS.map(snapshotWorkerFileName),
    HACK_LOOP_ROOT_WORKER_NAME,
    HACK_LOOP_DEPLOY_WORKER_NAME,
    BUY_PROGRAM_WORKER_NAME,
    UPGRADE_HOME_RAM_WORKER_NAME,
    TRAVEL_WORKER_NAME,
    JOIN_FACTION_WORKER_NAME,
    BUY_AUGMENTATION_WORKER_NAME,
    ...singularityWorkerFileNames(),
  ];
}

/** The home workers a fresh save runs: all but the Singularity backend's, which need SF4.3 or BN4 to fit (#145). */
export function freshSaveHomeWorkerFileNames(): string[] {
  const singularityWorkers = singularityWorkerFileNames();
  return homeWorkerFileNames().filter((fileName) => !singularityWorkers.includes(fileName));
}
