import type { Distribution, ScenarioRun } from "./run.ts";

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const range = (d: Distribution | null, format: (n: number) => string) =>
  d ? `min ${format(d.min)}, median ${format(d.median)}, p90 ${format(d.p90)}, max ${format(d.max)}` : "none";

/** A scenario run as a plain-text table, one row per seed, then the aggregate. */
export function formatRun({ scenario, results, aggregate }: ScenarioRun): string {
  const rows = [
    ["seed", "result", "stopped", "virtual", "wall", "speed", "state hash"],
    ...results.map((r) => [
      String(r.seed),
      r.ok ? (r.passed ? "pass" : "no stop") : `FAILED: ${r.error ?? "unknown error"}`,
      r.stoppedBy === null ? "-" : String(r.stoppedBy),
      hours(r.virtualMs),
      seconds(r.wallMs),
      r.ok ? `${r.speed}x` : "-",
      r.stateHash?.slice(0, 12) ?? "-",
    ]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  const table = rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  return [
    `scenario: ${scenario}`,
    ...table,
    "",
    `passed: ${aggregate.passed}/${aggregate.seeds} (${Math.round(aggregate.passRate * 100)}%)`,
    `time to stop: ${range(aggregate.timeToStop, hours)}`,
    `speed: ${range(aggregate.speed, (n) => `${n}x`)}`,
  ].join("\n");
}
