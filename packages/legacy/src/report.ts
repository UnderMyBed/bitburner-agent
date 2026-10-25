// The baseline's results as docs/sim/baselines.md records them: each seed's heap, and the release rows, one per
// checkpoint (ADR 0011).
import { distribution, type ScenarioRun, type SeedResult } from "@bitburner-agent/sim";
import { CHECKPOINTS_MS } from "./baseline.ts";

const HOUR = 60 * 60 * 1000;

/** The seed's checkpoint at `virtualMs`, if it got there. */
function at(result: SeedResult, virtualMs: number) {
  return result.checkpoints.find((c) => c.virtualMs === virtualMs);
}

const mb = (n: number | undefined) => (n === undefined ? "-" : `${n.toFixed(1)} MB`);

/** One line per seed: the heap at the start and at each checkpoint, after a full collection. */
export function formatHeaps(run: ScenarioRun): string {
  const header = ["seed", "heap at start", ...CHECKPOINTS_MS.map((ms) => `at ${ms / HOUR} h`)];
  const rows = run.results.map((r) => [
    String(r.seed),
    mb(r.heapStartMb),
    ...CHECKPOINTS_MS.map((ms) => mb(at(r, ms)?.heapMb)),
  ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...table.map((cells) => (cells[column] ?? "").length)));
  return table
    .map((cells) =>
      cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  "),
    )
    .join("\n");
}

/** Seeds as `--seeds` takes them: a range "a..b" when they're consecutive, otherwise a list "a,b,c". */
export function formatSeeds(seeds: number[]): string {
  const sorted = [...seeds].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);
  const consecutive = sorted.every((s, i) => s === (first as number) + i);
  return consecutive && sorted.length > 1 ? `${first}..${last}` : sorted.join(",");
}

/** Money as the game shows it: three significant digits and a suffix. */
export function formatMoney(n: number): string {
  const units = ["", "k", "m", "b", "t", "q"];
  let value = n;
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `$${Number(value.toPrecision(3))}${units[unit]}`;
}

export interface RowMeta {
  /** UTC, YYYY-MM-DD. */
  date: string;
  /** Short commit hash, with "-dirty" if the working tree had changes. */
  commit: string;
  rig: string;
  node: string;
}

/**
 * The run's rows for docs/sim/baselines.md, one per checkpoint: the seeds that reached it; the median money and
 * hacking level, with their ranges; the median augmentations installed, home RAM and heap. The real time per seed is
 * the median over the seeds that didn't fail. Medians of an even count take the lower middle value.
 */
export function baselineRows(run: ScenarioRun, { date, commit, rig, node }: RowMeta): string[] {
  const seeds = formatSeeds(run.results.map((r) => r.seed));
  const real = distribution(run.results.filter((r) => r.ok).map((r) => r.wallMs))?.median;
  const realText = real === undefined ? "-" : `${(real / 60_000).toFixed(0)} min`;
  return CHECKPOINTS_MS.map((ms) => {
    const reached = run.results.flatMap((r) => at(r, ms) ?? []);
    const stat = (values: number[], format: (n: number) => string, range: boolean) => {
      const d = distribution(values);
      if (!d) return "-";
      return range ? `${format(d.median)} (${format(d.min)}–${format(d.max)})` : format(d.median);
    };
    const summaries = reached.map((c) => c.summary);
    const cells = [
      date,
      commit,
      rig,
      node,
      seeds,
      `${ms / HOUR} h`,
      `${reached.length}/${run.results.length}`,
      stat(
        summaries.map((s) => s.money),
        formatMoney,
        true,
      ),
      stat(
        summaries.map((s) => s.hackingLevel),
        String,
        true,
      ),
      stat(
        summaries.map((s) => s.augsInstalled),
        String,
        false,
      ),
      stat(
        summaries.map((s) => s.homeRamMax),
        (n) => `${n} GB`,
        false,
      ),
      stat(
        reached.flatMap((c) => (c.heapMb === undefined ? [] : [c.heapMb])),
        (n) => `${n.toFixed(0)} MB`,
        false,
      ),
      realText,
    ];
    return `| ${cells.join(" | ")} |`;
  });
}
