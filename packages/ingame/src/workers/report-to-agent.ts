// What every home worker ends with: its data, on the port the Agent reads, tagged with the worker's pid.
import { WORKER_REPORT_PORT, type WorkerReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export function reportToAgent(ns: NS, data: unknown): void {
  // A stamp the brain reads (a snapshot's game time, its clock-step check's, #241): the wall clock (#251).
  const report: WorkerReport = { workerPid: ns.pid, gameTimeMs: Date.now(), data };
  ns.writePort(WORKER_REPORT_PORT, report);
}
