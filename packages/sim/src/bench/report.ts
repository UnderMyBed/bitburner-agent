// Benchmark results as rows of docs/sim/benchmarks.md, and the regression check against earlier rows.
import { cpus, totalmem } from "node:os";

/** The workloads benchmarked: scenario files in packages/sim/scenarios/. */
export const WORKLOADS = ["lean", "batch", "churn", "copies"] as const;
export type Workload = (typeof WORKLOADS)[number];

export interface BenchRow {
  /** YYYY-MM-DD. */
  date: string;
  /** Short commit hash, with "-dirty" if the working tree had changes. */
  commit: string;
  /** Which machine ran it: rows only compare with rows from the same rig. */
  rig: string;
  node: string;
  /** Median virtual ms per real ms, per workload. */
  speeds: Record<Workload, number>;
  /** The long lean run's heap after a full collection, in MB: at the start, at the end, and its growth per day. */
  heap: { startMb: number; endMb: number; perDayMb: number };
}

/**
 * A short name for this machine: `BENCH_RIG` if set, otherwise from its CPU, core count and memory, e.g.
 * "amd-ryzen-9-7950x-32c-64g". Rows from different machines aren't comparable.
 */
export function rigId(env = process.env.BENCH_RIG, cpuList = cpus(), memory = totalmem()): string {
  if (env) return env;
  const model = (cpuList[0]?.model ?? "unknown")
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|cpu|processor|\d+-core|@.*$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${model}-${cpuList.length}c-${Math.round(memory / 2 ** 30)}g`;
}

const HEADER = `| Date | Commit | Rig | Node | ${WORKLOADS.join(" | ")} | Heap start | Heap end | Heap growth per day |`;
const mb = (n: number) => `${n.toFixed(1)} MB`;

export function formatHeader(): string {
  return `${HEADER}\n|${"---|".repeat(HEADER.split("|").length - 2)}`;
}

export function formatRow(row: BenchRow): string {
  const speeds = WORKLOADS.map((w) => `${row.speeds[w]}x`);
  const { startMb, endMb, perDayMb } = row.heap;
  return `| ${[row.date, row.commit, row.rig, row.node, ...speeds, mb(startMb), mb(endMb), `${perDayMb >= 0 ? "+" : ""}${mb(perDayMb)}`].join(" | ")} |`;
}

/** The result rows of benchmarks.md, in file order: every table row after the header that has the right shape. */
export function parseRows(markdown: string): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length !== WORKLOADS.length + 9 || !/^\d{4}-\d{2}-\d{2}$/.test(cells[1] ?? "")) continue;
    const [, date, commit, rig, node, ...rest] = cells as [string, string, string, string, string, ...string[]];
    const number = (cell: string | undefined) => Number.parseFloat((cell ?? "").replace(/[^\d.+-]/g, ""));
    rows.push({
      date,
      commit,
      rig,
      node,
      speeds: Object.fromEntries(WORKLOADS.map((w, i) => [w, number(rest[i])])) as Record<Workload, number>,
      heap: {
        startMb: number(rest[WORKLOADS.length]),
        endMb: number(rest[WORKLOADS.length + 1]),
        perDayMb: number(rest[WORKLOADS.length + 2]),
      },
    });
  }
  return rows;
}

/** A regression is more than this much worse than the last row from the same rig. */
export const REGRESSION = 0.2;
/** Heap growth this small (MB per day) is noise, whatever the ratio. */
const HEAP_NOISE_MB = 1;

/**
 * What got worse by more than 20% since the last row from the same rig: a workload's speed, or the heap's growth per
 * day. Empty if nothing did, or there's no earlier row from this rig.
 */
export function regressions(row: BenchRow, earlier: BenchRow[]): string[] {
  const previous = earlier.filter((r) => r.rig === row.rig).at(-1);
  if (!previous) return [];
  const since = `than ${previous.date} (${previous.commit})`;
  const found = WORKLOADS.filter((w) => row.speeds[w] < previous.speeds[w] * (1 - REGRESSION)).map(
    (w) =>
      `${w}: ${row.speeds[w]}x is ${Math.round((1 - row.speeds[w] / previous.speeds[w]) * 100)}% slower ${since}, at ${previous.speeds[w]}x`,
  );
  const growth = row.heap.perDayMb;
  const before = previous.heap.perDayMb;
  if (growth > HEAP_NOISE_MB && growth > before * (1 + REGRESSION)) {
    found.push(`heap: grows ${mb(growth)} a day, more ${since} (${mb(before)} a day)`);
  }
  return found;
}

/**
 * How much the heap grows a day, from samples taken once a virtual day starting when the scripts start: the
 * least-squares slope through them. The first day is left out, since it's mostly warm-up (compiling scripts, filling
 * caches) rather than growth.
 */
export function growthPerDay(dailyMb: number[]): number {
  const points = dailyMb.slice(1);
  if (points.length < 2) throw new RangeError(`need at least 3 daily samples, got ${dailyMb.length}`);
  const meanX = (points.length - 1) / 2;
  const meanY = points.reduce((sum, y) => sum + y, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  points.forEach((y, x) => {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  });
  return covariance / variance;
}
