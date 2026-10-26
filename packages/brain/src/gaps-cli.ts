// npm run gaps -- --data-dir <dir> --since <ISO time> [--until <ISO time>] [--environment E0] [--threshold-seconds 6]
// Lists every gap in the fast snapshots (the heartbeat) in a window: the evidence for M2's 24 h Steam criterion.
// Exits 0 when there are none, 1 when there are gaps, 2 when it couldn't run.
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveDataDirectory, STORE_FILE_NAME } from "./config.ts";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps } from "./gap-report.ts";
import { type Environment, TelemetryStore } from "./telemetry-store.ts";

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseTime(text: string, name: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`${name} must be an ISO time, e.g. 2026-10-26T00:00:00Z; got ${text}`);
  return ms;
}

const iso = (ms: number | null) => (ms === null ? "none" : new Date(ms).toISOString());

try {
  const argv = process.argv.slice(2);
  const dataDirectory = resolveDataDirectory(argv, process.env);
  const storePath = path.join(dataDirectory, STORE_FILE_NAME);
  if (!existsSync(storePath)) throw new Error(`No telemetry store at ${storePath}: has the brain run there?`);
  const since = option(argv, "--since");
  if (!since) throw new Error("--since <ISO time> is required");
  const sinceMs = parseTime(since, "--since");
  const untilText = option(argv, "--until");
  const untilMs = untilText ? parseTime(untilText, "--until") : Date.now();
  const environment = (option(argv, "--environment") ?? "E0") as Environment;
  if (!["E0", "E1", "E2"].includes(environment)) throw new Error("--environment must be E0, E1 or E2");
  const thresholdText = option(argv, "--threshold-seconds");
  const thresholdMs = thresholdText ? Number(thresholdText) * 1000 : DEFAULT_GAP_THRESHOLD_MS;
  if (!(thresholdMs > 0)) throw new Error("--threshold-seconds must be a positive number");

  const store = TelemetryStore.open(storePath);
  const report = findGaps(store.fastSnapshotTimes({ environment, sinceMs, untilMs }), {
    sinceMs,
    untilMs,
    thresholdMs,
  });
  store.close();
  console.log(
    `Fast snapshots (${environment}) from ${iso(sinceMs)} to ${iso(untilMs)}, threshold ${thresholdMs / 1000} s:`,
  );
  console.log(`  ${report.count} snapshots, first ${iso(report.firstMs)}, last ${iso(report.lastMs)}`);
  console.log(`  longest interval ${(report.longestIntervalMs / 1000).toFixed(1)} s`);
  for (const gap of report.gaps) {
    console.log(`  gap: ${iso(gap.fromMs)} to ${iso(gap.toMs)} (${(gap.lengthMs / 1000).toFixed(1)} s)`);
  }
  console.log(report.gaps.length === 0 ? "No gaps." : `${report.gaps.length} gaps.`);
  process.exitCode = report.gaps.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`gaps: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
