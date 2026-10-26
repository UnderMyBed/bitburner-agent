// What every snapshot worker ends with: its data, on the port the Agent reads, tagged with the worker's pid.
import { SNAPSHOT_WORKER_PORT, type SnapshotWorkerReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export function reportToAgent(ns: NS, data: unknown): void {
  const report: SnapshotWorkerReport = { workerPid: ns.pid, gameTimeMs: Date.now(), data };
  ns.writePort(SNAPSHOT_WORKER_PORT, report);
}
