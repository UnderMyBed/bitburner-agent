// npm run report -- [--data-dir <dir>] [--since <ISO time>] [--until <ISO time>] [--environment E0]
// The run report (#185): what a run did and what went wrong, from the store (run-report.ts). Without --since, the
// window starts at the newest brain start; without --until, it ends now.
// Exits 0 on PASS, 1 on FAIL, 2 when it couldn't run: no store, no brain start to begin from, a window that ends before
// it starts, or one with nothing recorded in it.
import process from "node:process";
import { environmentFlag, existingStorePath, flagValue, parseIsoTime } from "./config.ts";
import { newestBrainStartMs, runReport } from "./run-report.ts";
import { TelemetryStore } from "./telemetry-store.ts";

try {
  const argv = process.argv.slice(2);
  const storePath = existingStorePath(argv, process.env);
  const environment = environmentFlag(argv);
  const sinceText = flagValue(argv, "--since");
  const untilText = flagValue(argv, "--until");
  const untilMs = untilText ? parseIsoTime(untilText, "--until") : Date.now();

  const store = TelemetryStore.openReadOnly(storePath);
  try {
    const sinceMs = sinceText ? parseIsoTime(sinceText, "--since") : newestBrainStartMs(store, environment);
    if (sinceMs === null) throw new Error(`no brain start (${environment}) in the store: give --since <ISO time>`);
    const report = runReport(store, { environment, sinceMs, untilMs });
    console.log(report.text);
    process.exitCode = report.failures.length === 0 ? 0 : 1;
  } finally {
    store.close();
  }
} catch (error) {
  console.error(`report: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
