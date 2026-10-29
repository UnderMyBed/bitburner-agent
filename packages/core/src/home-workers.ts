/**
 * Every worker the Agent runs on home beside itself, one at a time (the Singularity backdoor's stays past its round,
 * #162): the snapshot tiers', the hack loop's (#134), the program buyer's (#136), the home RAM upgrader's (#138), the
 * traveller's (#141), the Singularity backend's (#145), the faction joiner's (#147), the augmentation buyer's (#149),
 * the faction, company, crime and class workers' (#151, #153, #156, #158), the cloud server buyer's (#159), the
 * backdoor's (#162), the installer's (#164), the destroyer's (#175), and the faction state's reader (#197). A fresh
 * save's home must hold the Agent plus
 * the largest of those it can run (`freshSaveHomeWorkerFileNames`), so the RAM budget test and the simulator and E2
 * suites read these lists. Functions, not constants, so in-game bundles that don't use them leave them out.
 */
import { BUY_AUGMENTATION_WORKER_NAME, INSTALL_AUGMENTATIONS_WORKER_NAME } from "./augmentations.ts";
import { BACKDOOR_WORKER_NAME } from "./backdoors.ts";
import { singularityWorkerFileNames } from "./backends.ts";
import { BATCHER_DEPLOY_WORKER_NAME } from "./batcher.ts";
import { DESTROY_BITNODE_WORKER_NAME } from "./bitnodes.ts";
import { BUY_SERVER_WORKER_NAME } from "./cloud-servers.ts";
import { SNAPSHOT_TIERS } from "./control-protocol.ts";
import { FACTION_STATE_WORKER_NAME } from "./faction-state.ts";
import { JOIN_FACTION_WORKER_NAME } from "./factions.ts";
import { HACK_LOOP_DEPLOY_WORKER_NAME, HACK_LOOP_ROOT_WORKER_NAME } from "./hack-loop.ts";
import { UPGRADE_HOME_RAM_WORKER_NAME } from "./home-ram.ts";
import { TRAVEL_WORKER_NAME } from "./locations.ts";
import { BUY_PROGRAM_WORKER_NAME } from "./programs.ts";
import { snapshotWorkerFileName } from "./snapshots.ts";
import {
  CLASS_WORK_WORKER_NAME,
  COMPANY_WORK_WORKER_NAME,
  CRIME_WORK_WORKER_NAME,
  FACTION_WORK_WORKER_NAME,
} from "./work.ts";

export function homeWorkerFileNames(): string[] {
  return [
    ...SNAPSHOT_TIERS.map(snapshotWorkerFileName),
    HACK_LOOP_ROOT_WORKER_NAME,
    HACK_LOOP_DEPLOY_WORKER_NAME,
    BATCHER_DEPLOY_WORKER_NAME,
    BUY_PROGRAM_WORKER_NAME,
    UPGRADE_HOME_RAM_WORKER_NAME,
    TRAVEL_WORKER_NAME,
    JOIN_FACTION_WORKER_NAME,
    BUY_AUGMENTATION_WORKER_NAME,
    FACTION_WORK_WORKER_NAME,
    COMPANY_WORK_WORKER_NAME,
    BUY_SERVER_WORKER_NAME,
    CRIME_WORK_WORKER_NAME,
    CLASS_WORK_WORKER_NAME,
    BACKDOOR_WORKER_NAME,
    INSTALL_AUGMENTATIONS_WORKER_NAME,
    DESTROY_BITNODE_WORKER_NAME,
    FACTION_STATE_WORKER_NAME,
    ...singularityWorkerFileNames(),
  ];
}

/** The home workers a fresh save runs: all but the Singularity backend's, which need SF4.3 or BN4 to fit (#145). */
export function freshSaveHomeWorkerFileNames(): string[] {
  const singularityWorkers = singularityWorkerFileNames();
  return homeWorkerFileNames().filter((fileName) => !singularityWorkers.includes(fileName));
}
