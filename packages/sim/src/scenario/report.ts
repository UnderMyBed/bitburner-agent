// The CLI's text report of a scenario run: one row per seed, the aggregate, then the errors in full.
import type { Checkpoint, Distribution, ScenarioRun, SeedResult } from "./run.ts";

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(2)} h`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const range = (d: Distribution | null, format: (n: number) => string) =>
  d ? `min ${format(d.min)}, median ${format(d.median)}, p90 ${format(d.p90)}, max ${format(d.max)}` : "none";

function result(r: SeedResult): string {
  if (!r.ok) return "FAILED";
  if (r.passed) return "pass";
  return r.stoppedBy !== null && r.stoppedBy !== "bitverse" && r.stoppedBy.list === "failWhen" ? "fail" : "no stop";
}

function stop(r: SeedResult): string {
  if (r.stoppedBy === null) return "-";
  return r.stoppedBy === "bitverse" ? "bitverse" : `${r.stoppedBy.list}[${r.stoppedBy.index}]`;
}

/**
 * A progress line for a checkpoint: the seed, virtual and real time so far, the speed, and how the game stands. The
 * CLIs print one per seed per checkpoint, to stderr, so a long run shows how far each seed has got.
 */
export function formatProgress(seed: number, { virtualMs, summary }: Checkpoint, wallMs: number): string {
  const speed = wallMs > 0 ? `${Math.round(virtualMs / wallMs)}x` : "-";
  const real = `${(wallMs / 60_000).toFixed(1)} min`;
  return (
    `seed ${seed}: ${hours(virtualMs)} virtual, ${real} real, ${speed}; ` +
    `${summary.scripts} scripts, $${summary.money.toExponential(2)}, hacking ${summary.hackingLevel}`
  );
}

/** A scenario run as a plain-text table, one row per seed, then the aggregate and any errors in full. */
export function formatRun({ scenario, results, aggregate }: ScenarioRun): string {
  const rows = [
    ["seed", "result", "stopped by", "virtual", "wall", "speed", "uncaught", "state hash"],
    ...results.map((r) => [
      String(r.seed),
      result(r),
      stop(r),
      hours(r.virtualMs),
      seconds(r.wallMs),
      r.ok ? `${r.speed}x` : "-",
      String(r.uncaught),
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
  const errors = results.filter((r) => !r.ok).map((r) => `seed ${r.seed}: ${r.error ?? "unknown error"}`);
  return [
    `scenario: ${scenario}`,
    ...table,
    "",
    `passed: ${aggregate.passed}/${aggregate.seeds} (${Math.round(aggregate.passRate * 100)}%)`,
    `time to stop: ${range(aggregate.timeToStop, hours)}`,
    `speed: ${range(aggregate.speed, (n) => `${n}x`)}`,
    ...(errors.length > 0 ? ["", "errors:", ...errors] : []),
  ].join("\n");
}
