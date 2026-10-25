// npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | --seeds a,b,c] [--workers k] [--json out.json]
// Runs the fork baseline (src/baseline.ts, docs/sim/baselines.md) once per seed, measuring each run's heap, and prints
// the scenario table and each run's heap. Exits 0 if every seed destroyed the BitNode, 1 if any didn't, and 2 if it
// couldn't run at all.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildEngine, formatRun, parseSeeds, parseWorkers, runScenario } from "@bitburner-agent/sim";
import { baselineScenario } from "../src/baseline.ts";

const USAGE =
  "usage: npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]";
const DAY = 24 * 60 * 60 * 1000;
const mb = (n: number | undefined) => (n === undefined ? "-" : `${n.toFixed(1)} MB`);

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string" }, workers: { type: "string" }, json: { type: "string" } },
  });
  if (positionals.length > 0) throw new RangeError(USAGE);
  const seeds = values.seeds === undefined ? undefined : parseSeeds(values.seeds);
  // One seed at a time unless asked: a seed is heavy (docs/sim/baselines.md, #75).
  const workers = values.workers === undefined ? 1 : parseWorkers(values.workers);
  await buildEngine();
  const run = await runScenario(baselineScenario(), { workers, measureHeap: true, ...(seeds ? { seeds } : {}) });
  console.log(formatRun(run));
  console.log("\nseed  heap at start  heap at end  largest   change per virtual day");
  for (const r of run.results) {
    const heaps = r.checkpoints.map((c) => c.heapMb ?? 0);
    const end = heaps.at(-1);
    const perDay = end !== undefined && r.heapStartMb !== undefined && r.virtualMs > 0;
    const change = perDay ? ((end - (r.heapStartMb as number)) / (r.virtualMs / DAY)).toFixed(1) : "-";
    const largest = heaps.length > 0 ? Math.max(...heaps) : undefined;
    console.log(
      `${String(r.seed).padEnd(4)}  ${mb(r.heapStartMb).padStart(13)}  ${mb(end).padStart(11)}  ${mb(largest).padStart(8)}  ${change}`,
    );
  }
  if (values.json) writeFileSync(values.json, `${JSON.stringify(run, null, 2)}\n`);
  process.exitCode = run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
