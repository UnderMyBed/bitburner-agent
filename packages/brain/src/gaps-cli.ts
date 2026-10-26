// npm run gaps -- --data-dir <dir> --since <ISO time> [--until <ISO time>] [--environment E0] [--threshold-seconds 6]
// Lists every gap in the fast snapshots (the heartbeat) in a window: the evidence for M2's 24 h Steam criterion.
// Exits 0 when there are none, 1 when there are gaps, 2 when it couldn't run, including for a window that checks
// nothing (one that ends before it starts).
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { flagValue, resolveDataDirectory, STORE_FILE_NAME } from "./config.ts";
import { DEFAULT_GAP_THRESHOLD_MS, findGaps } from "./gap-report.ts";
import { ENVIRONMENTS, type Environment, TelemetryStore } from "./telemetry-store.ts";

/** An ISO time with a `Z` or an explicit offset: without one, JavaScript reads a date-time as local time. */
function parseIsoTime(text: string, flagName: string): number {
  const epochMs = /(Z|[+-]\d\d:\d\d)$/.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(`${flagName} must be an ISO time with Z or an offset, e.g. 2026-10-26T00:00:00Z; got ${text}`);
  }
  return epochMs;
}

const formatIsoTime = (epochMs: number | null) => (epochMs === null ? "none" : new Date(epochMs).toISOString());
const formatSeconds = (durationMs: number) => `${(durationMs / 1000).toFixed(1)} s`;

try {
  const argv = process.argv.slice(2);
  const dataDirectory = resolveDataDirectory(argv, process.env);
  const storePath = path.join(dataDirectory, STORE_FILE_NAME);
  if (!existsSync(storePath)) throw new Error(`No telemetry store at ${storePath}: has the brain run there?`);
  const sinceText = flagValue(argv, "--since");
  if (!sinceText) throw new Error("--since <ISO time> is required");
  const sinceMs = parseIsoTime(sinceText, "--since");
  const untilText = flagValue(argv, "--until");
  const untilMs = untilText ? parseIsoTime(untilText, "--until") : Date.now();
  const environment = (flagValue(argv, "--environment") ?? "E0") as Environment;
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`--environment must be one of ${ENVIRONMENTS.join(", ")}`);
  const thresholdText = flagValue(argv, "--threshold-seconds");
  const thresholdMs = thresholdText ? Number(thresholdText) * 1000 : DEFAULT_GAP_THRESHOLD_MS;
  if (!(thresholdMs > 0)) throw new Error("--threshold-seconds must be a positive number");

  const store = TelemetryStore.openReadOnly(storePath);
  const snapshotTimes = store.fastSnapshotTimes({ environment, sinceMs, untilMs });
  store.close();
  const report = findGaps(snapshotTimes, { sinceMs, untilMs, thresholdMs });
  console.log(
    `Fast snapshots (${environment}) from ${formatIsoTime(sinceMs)} to ${formatIsoTime(untilMs)}, ` +
      `threshold ${formatSeconds(thresholdMs)}:`,
  );
  console.log(
    `  ${report.count} snapshots, first ${formatIsoTime(report.firstMs)}, last ${formatIsoTime(report.lastMs)}`,
  );
  console.log(`  longest interval ${formatSeconds(report.longestIntervalMs)}`);
  for (const gap of report.gaps) {
    console.log(`  gap: ${formatIsoTime(gap.fromMs)} to ${formatIsoTime(gap.toMs)} (${formatSeconds(gap.lengthMs)})`);
  }
  console.log(report.gaps.length === 0 ? "No gaps." : `${report.gaps.length} gaps.`);
  process.exitCode = report.gaps.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`gaps: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
