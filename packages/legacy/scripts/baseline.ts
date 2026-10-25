// npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]
// Runs the fork baseline (src/baseline.ts, docs/sim/baselines.md) once per seed, measuring each run's heap. Prints the
// scenario table, each seed's heap, and the run's row for docs/sim/baselines.md. Exits 0 if every seed destroyed the
// BitNode, 1 if any didn't, and 2 if it couldn't run at all.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildEngine, formatRun, parseSeeds, parseWorkers, rigId, runScenario } from "@bitburner-agent/sim";
import { baselineScenario } from "../src/baseline.ts";
import { baselineRow, formatHeaps } from "../src/report.ts";

const USAGE =
  "usage: npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] [--json out.json]";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string" }, workers: { type: "string" }, json: { type: "string" } },
  });
  if (positionals.length > 0) throw new RangeError(USAGE);
  const seeds = values.seeds === undefined ? undefined : parseSeeds(values.seeds);
  // One seed at a time unless asked: a seed is heavy (docs/sim/baselines.md, #75).
  const workers = values.workers === undefined ? 1 : parseWorkers(values.workers);
  // npm runs this from the workspace; a path is relative to where npm was run, as the bench's --out is.
  const json = values.json && path.resolve(process.env.INIT_CWD ?? process.cwd(), values.json);
  await buildEngine();
  const run = await runScenario(baselineScenario(), { workers, measureHeap: true, ...(seeds ? { seeds } : {}) });
  console.log(formatRun(run));
  console.log(`\n${formatHeaps(run)}`);
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const date = new Date().toISOString().slice(0, 10);
  console.log(
    `\nrow for docs/sim/baselines.md:\n${baselineRow(run, { date, commit, rig: rigId(), node: process.version })}`,
  );
  if (json) writeFileSync(json, `${JSON.stringify(run, null, 2)}\n`);
  process.exitCode = run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
