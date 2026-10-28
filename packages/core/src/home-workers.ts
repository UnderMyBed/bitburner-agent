/**
 * Every worker the Agent runs on home beside itself, one at a time: the snapshot tiers', the hack loop's (#134), the
 * program buyer's (#136), the home RAM upgrader's (#138) and the traveller's (#141).
 * Home's RAM must hold the Agent plus the largest of them, so the RAM budget test and the simulator and E2 suites read
 * this one list. A function, not a constant, so in-game bundles that don't use it leave it out.
 */
import { SNAPSHOT_TIERS } from "./control-protocol.ts";
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
  ];
}
