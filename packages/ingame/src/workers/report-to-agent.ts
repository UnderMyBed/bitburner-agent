// What every home worker ends with: its data, on the port the Agent reads, tagged with the worker's pid.
import { WORKER_REPORT_PORT, type WorkerReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export function reportToAgent(ns: NS, data: unknown): void {
  const report: WorkerReport = { workerPid: ns.pid, gameTimeMs: Date.now(), data };
  ns.writePort(WORKER_REPORT_PORT, report);
}
