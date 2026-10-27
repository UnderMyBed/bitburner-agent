/**
 * Every worker the Agent runs on home beside itself, one at a time: the snapshot tiers' and the hack loop's (#134).
 * Home's RAM must hold the Agent plus the largest of them, so the RAM budget test and the simulator and E2 suites read
 * this one list. A function, not a constant, so in-game bundles that don't use it leave it out.
 */
import { SNAPSHOT_TIERS } from "./control-protocol.ts";
import { HACK_LOOP_DEPLOY_WORKER_NAME, HACK_LOOP_ROOT_WORKER_NAME } from "./hack-loop.ts";
import { snapshotWorkerFileName } from "./snapshots.ts";

export function homeWorkerFileNames(): string[] {
  return [...SNAPSHOT_TIERS.map(snapshotWorkerFileName), HACK_LOOP_ROOT_WORKER_NAME, HACK_LOOP_DEPLOY_WORKER_NAME];
}
