// The baseline's results as docs/sim/baselines.md records them: each seed's heap, and the release row.
import { distribution, growthPerDay, type ScenarioRun, type SeedResult } from "@bitburner-agent/sim";
import { DAY } from "./baseline.ts";

const HOUR = 60 * 60 * 1000;

/**
 * The seed's heap samples taken at whole virtual days, starting with the one as the run starts: the samples
 * `growthPerDay` expects. A checkpoint at the stop, part-way through a day, is left out.
 */
export function dailyHeapMb(result: SeedResult): number[] {
  if (result.heapStartMb === undefined) return [];
  const daily = result.checkpoints.filter((c) => c.virtualMs % DAY === 0 && c.heapMb !== undefined);
  return [result.heapStartMb, ...daily.map((c) => c.heapMb as number)];
}

/** The seed's heap growth per virtual day, as benchmarks measure it; null with fewer than 3 daily samples. */
export function seedHeapGrowth(result: SeedResult): number | null {
  const daily = dailyHeapMb(result);
  return daily.length >= 3 ? growthPerDay(daily) : null;
}

/** The middle value (the lower one of an even count, as the scenario aggregate takes it); null for none. */
function median(values: number[]): number | null {
  return distribution(values)?.median ?? null;
}

const mb = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `${n.toFixed(1)} MB`);
const signedMb = (n: number | null) => (n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} MB`);

/** One line per seed: the heap at the start and end, the largest sample, and the growth per virtual day. */
export function formatHeaps(run: ScenarioRun): string {
  const rows = run.results.map((r) => {
    const samples = r.checkpoints.flatMap((c) => (c.heapMb === undefined ? [] : [c.heapMb]));
    const largest = samples.length > 0 ? Math.max(...samples) : null;
    return [String(r.seed), mb(r.heapStartMb), mb(samples.at(-1)), mb(largest), signedMb(seedHeapGrowth(r))];
  });
  const header = ["seed", "heap at start", "heap at end", "largest", "growth per virtual day"];
  return [header, ...rows]
    .map((cells) => cells.map((cell, i) => (i === 0 ? cell.padEnd(4) : cell.padStart(13))).join("  "))
    .join("\n");
}

export interface RowMeta {
  /** UTC, YYYY-MM-DD. */
  date: string;
  commit: string;
  rig: string;
  node: string;
}

/**
 * The run's row for docs/sim/baselines.md: passes; time to destroy (min / median / p90 / max, in virtual hours, over
 * the seeds that passed); median speed and real time over the seeds that didn't crash; median heap growth per virtual
 * day over the seeds with at least 3 daily samples.
 */
export function baselineRow(run: ScenarioRun, { date, commit, rig, node }: RowMeta): string {
  const { aggregate } = run;
  const ran = run.results.filter((r) => r.ok);
  const destroy = aggregate.timeToStop;
  const hours = (ms: number) => `${(ms / HOUR).toFixed(1)} h`;
  const realMin = median(ran.map((r) => r.wallMs));
  const growth = median(run.results.flatMap((r) => seedHeapGrowth(r) ?? []));
  const cells = [
    date,
    commit,
    rig,
    node,
    `${aggregate.passed}/${aggregate.seeds}`,
    destroy ? [destroy.min, destroy.median, destroy.p90, destroy.max].map(hours).join(" / ") : "-",
    aggregate.speed ? `${aggregate.speed.median}x` : "-",
    realMin === null ? "-" : `${(realMin / 60_000).toFixed(0)} min`,
    signedMb(growth),
  ];
  return `| ${cells.join(" | ")} |`;
}
