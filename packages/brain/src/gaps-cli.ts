// npm run gaps -- [--data-dir <dir>] --since <ISO time> [--until <ISO time>] [--environment E0] [--threshold-seconds 6]
// Lists every gap in the fast snapshots (the heartbeat) in a window: the evidence for M2's 24 h Steam criterion. Also
// prints the page heap over the window (#124).
// Exits 0 when there are none, 1 when there are gaps, 2 when it couldn't run, including for a window that checks
// nothing (one that ends before it starts).
import process from "node:process";
import { environmentFlag, existingStorePath, flagValue, parseIsoTime } from "./config.ts";
import { DEFAULT_GAP_THRESHOLD_MS, describePageHeap, findGaps, formatIsoTime, formatSeconds } from "./gap-report.ts";
import { TelemetryStore } from "./telemetry-store.ts";

try {
  const argv = process.argv.slice(2);
  const storePath = existingStorePath(argv, process.env);
  const sinceText = flagValue(argv, "--since");
  if (!sinceText) throw new Error("--since <ISO time> is required");
  const sinceMs = parseIsoTime(sinceText, "--since");
  const untilText = flagValue(argv, "--until");
  const untilMs = untilText ? parseIsoTime(untilText, "--until") : Date.now();
  const environment = environmentFlag(argv);
  const thresholdText = flagValue(argv, "--threshold-seconds");
  const thresholdMs = thresholdText ? Number(thresholdText) * 1000 : DEFAULT_GAP_THRESHOLD_MS;
  if (!(thresholdMs > 0)) throw new Error("--threshold-seconds must be a positive number");

  const store = TelemetryStore.openReadOnly(storePath);
  const snapshotTimes = store.fastSnapshotTimes({ environment, sinceMs, untilMs });
  const pageHeapsBytes = store.fastSnapshotPageHeaps({ environment, sinceMs, untilMs });
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
  // Evidence, not a verdict: the exit code stays the gaps'.
  console.log(`  ${describePageHeap(pageHeapsBytes)}`);
  for (const gap of report.gaps) {
    console.log(`  gap: ${formatIsoTime(gap.fromMs)} to ${formatIsoTime(gap.toMs)} (${formatSeconds(gap.lengthMs)})`);
  }
  console.log(report.gaps.length === 0 ? "No gaps." : `${report.gaps.length} gaps.`);
  process.exitCode = report.gaps.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`gaps: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
