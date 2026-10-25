// Benchmark results as rows of docs/sim/benchmarks.md, and the regression check against earlier rows.
import { cpus, totalmem } from "node:os";

/** The workloads benchmarked: scenario files in packages/sim/scenarios/. */
export const WORKLOADS = ["lean", "batch", "churn", "copies"] as const;
export type Workload = (typeof WORKLOADS)[number];

export interface BenchRow {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** Short commit hash, with "-dirty" if the working tree had changes. */
  commit: string;
  /** Which machine ran it: rows only compare with rows from the same rig. */
  rig: string;
  node: string;
  /** Median virtual ms per real ms, per workload. A row from before a workload was added doesn't have it. */
  speeds: Partial<Record<Workload, number>>;
  /** The long lean run's heap after a full collection, in MB: at the start, at the end, and its growth per day. */
  heap: { startMb: number; endMb: number; perDayMb: number };
}

/**
 * A short name for this machine: `BENCH_RIG` if set, otherwise from its CPU model, logical CPU count and memory, e.g.
 * "amd-ryzen-9-7950x-32c-64g". Rows from different machines aren't comparable.
 */
export function rigId(env = process.env.BENCH_RIG, cpuList = cpus(), memory = totalmem()): string {
  if (env) {
    if (/[|\r\n]/.test(env))
      throw new RangeError(`BENCH_RIG can't contain "|" or line breaks, got ${JSON.stringify(env)}`);
    return env;
  }
  const model = (cpuList[0]?.model ?? "unknown")
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|cpu|processor|\d+-core|@.*$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${model}-${cpuList.length}c-${Math.round(memory / 2 ** 30)}g`;
}

const HEAP_COLUMNS = ["Heap start", "Heap end", "Heap growth per day"] as const;
const COLUMNS = ["Date", "Commit", "Rig", "Node", ...WORKLOADS, ...HEAP_COLUMNS];
const tableLine = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
const HEADER = tableLine(COLUMNS);
const mb = (n: number) => `${n.toFixed(1)} MB`;

export function formatHeader(): string {
  return `${HEADER}\n|${"---|".repeat(COLUMNS.length)}`;
}

export function formatRow(row: BenchRow): string {
  const speeds = WORKLOADS.map((w) => (row.speeds[w] === undefined ? "-" : `${row.speeds[w]}x`));
  const { startMb, endMb, perDayMb } = row.heap;
  const growth = `${perDayMb >= 0 ? "+" : ""}${mb(perDayMb)}`;
  return tableLine([row.date, row.commit, row.rig, row.node, ...speeds, mb(startMb), mb(endMb), growth]);
}

/** A line's table cells, without the empty ones outside the outer pipes; null if it isn't a table line. */
function cellsOf(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** "26899x" or "93.0 MB" (or "+1.6 MB") as a number; NaN for anything else. */
function numberIn(cell: string): number {
  const bare = cell.replace(/\s*(x|MB)$/, "");
  return bare === "" ? Number.NaN : Number(bare);
}

/**
 * The result rows of benchmarks.md, in file order. Each results table's header names its columns, so a table from
 * before a workload was added still reads. Rows whose values aren't numbers are skipped.
 */
export function parseRows(markdown: string): BenchRow[] {
  const rows: BenchRow[] = [];
  let columns: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const cells = cellsOf(line);
    if (cells?.[0] === "Date") columns = cells;
    if (!cells || !columns || cells.length !== columns.length || !/^\d{4}-\d{2}-\d{2}$/.test(cells[0] ?? "")) continue;
    const cell = new Map(columns.map((name, i) => [name, cells[i] as string]));
    const speeds: Partial<Record<Workload, number>> = {};
    for (const w of WORKLOADS) if (cell.has(w)) speeds[w] = numberIn(cell.get(w) as string);
    const [startMb, endMb, perDayMb] = HEAP_COLUMNS.map((name) => numberIn(cell.get(name) ?? ""));
    if ([...Object.values(speeds), startMb, endMb, perDayMb].some((n) => n === undefined || Number.isNaN(n))) continue;
    rows.push({
      date: cell.get("Date") as string,
      commit: cell.get("Commit") ?? "",
      rig: cell.get("Rig") ?? "",
      node: cell.get("Node") ?? "",
      speeds,
      heap: { startMb: startMb as number, endMb: endMb as number, perDayMb: perDayMb as number },
    });
  }
  return rows;
}

/**
 * The text to append to benchmarks.md for a new row. If the file's last results table has other columns (a workload
 * was added or removed since), it starts a new table under the current header, so older rows keep their own.
 */
export function rowText(markdown: string, row: BenchRow): string {
  const lastHeader = markdown
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => cellsOf(line)?.[0] === "Date");
  let text = markdown.endsWith("\n") ? "" : "\n";
  if (lastHeader !== HEADER) text += `\n${formatHeader()}\n`;
  return `${text}${formatRow(row)}\n`;
}

/** A regression is more than this much worse than the last row from the same rig. */
export const REGRESSION = 0.2;
/** Heap growth this small (MB per day) is noise, whatever the ratio. */
const HEAP_NOISE_MB = 1;

/**
 * What got worse by more than 20% since the last row from the same rig: a workload's speed, or the heap's growth per
 * day (compared as recorded, to 0.1 MB). Empty if nothing did, or there's no earlier row from this rig.
 */
export function regressions(row: BenchRow, earlier: BenchRow[]): string[] {
  const previous = earlier.filter((r) => r.rig === row.rig).at(-1);
  if (!previous) return [];
  const since = `than ${previous.date} (${previous.commit})`;
  const found: string[] = [];
  for (const w of WORKLOADS) {
    const now = row.speeds[w];
    const before = previous.speeds[w];
    if (now === undefined || before === undefined || now >= before * (1 - REGRESSION)) continue;
    found.push(`${w}: ${now}x is ${((1 - now / before) * 100).toFixed(1)}% slower ${since}, at ${before}x`);
  }
  const growth = Number(row.heap.perDayMb.toFixed(1));
  const before = previous.heap.perDayMb;
  if (growth > HEAP_NOISE_MB && growth > before * (1 + REGRESSION)) {
    found.push(`heap: grows ${mb(growth)} a day, more ${since} (${mb(before)} a day)`);
  }
  return found;
}

/**
 * How much the heap grows a day, from samples taken once a virtual day starting when the scripts start: the median
 * day-to-day change. The first day is left out, since it's mostly warm-up (compiling scripts, filling caches). A median
 * isn't moved by a one-off step, such as a cache emptying once, but a leak moves every day's change.
 */
export function growthPerDay(dailyMb: number[]): number {
  const changes = dailyMb
    .slice(2)
    .map((mb, i) => mb - (dailyMb[i + 1] as number))
    .sort((a, b) => a - b);
  if (changes.length === 0) throw new RangeError(`need at least 3 daily samples, got ${dailyMb.length}`);
  const middle = Math.floor(changes.length / 2);
  return changes.length % 2 === 1
    ? (changes[middle] as number)
    : ((changes[middle - 1] as number) + (changes[middle] as number)) / 2;
}
