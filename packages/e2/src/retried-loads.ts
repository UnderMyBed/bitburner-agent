// A run's retried fixture loads (#120), counted across its test files, so a retry can't hide a regression. The E2
// global setup (test/global-setup.ts) names a file in RETRIED_LOADS_FILE_VARIABLE; each retry `untilGameLoaded` makes
// appends its first try's report there; the teardown reads them and judges the run.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

/** The environment variable naming the run's file of retried loads. Unset (outside `npm run e2`), none are counted. */
export const RETRIED_LOADS_FILE_VARIABLE = "E2_RETRIED_LOADS_FILE";
/** More than this many retried loads in one run fails it: once is a flake (#120), more is a pattern. */
export const RETRIED_LOADS_ALLOWED = 1;

/** Counts one retried load, with its first try's report. */
export function recordRetriedLoad(report: string, file = process.env[RETRIED_LOADS_FILE_VARIABLE]): void {
  if (file) appendFileSync(file, `${JSON.stringify(report)}\n`);
}

/** The reports of the run's retried loads, in order. */
export function readRetriedLoads(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string);
}

/**
 * The run's verdict: nothing to say with none retried; a loud summary with one; a failure with more, each report's
 * first lines listed.
 */
export function retriedLoadsVerdict(reports: string[]): { failed: boolean; summary: string | null } {
  if (reports.length === 0) return { failed: false, summary: null };
  const firstLines = reports.map((report, index) => `${index + 1}. ${report.split("\n").slice(0, 3).join(" | ")}`);
  const failed = reports.length > RETRIED_LOADS_ALLOWED;
  const summary = [
    `E2: ${reports.length} fixture load${reports.length === 1 ? "" : "s"} needed a retry this run (#120)${
      failed ? `: more than ${RETRIED_LOADS_ALLOWED}, so the run fails` : ""
    }. Report it on #120:`,
    ...firstLines,
  ].join("\n");
  return { failed, summary };
}
