// npm run sim -- <scenario.json> [--seeds a..b | --seeds a,b,c] [--workers k] [--json out.json]
// Runs a scenario once per seed and prints a table. Exits 0 if every seed passed, 1 if any didn't, and 2 if it
// couldn't run at all (bad usage, a bad scenario, a build failure). npm runs it from the repository root, so paths are
// relative to that.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildEngine } from "../src/engine/build.ts";
import { formatRun } from "../src/scenario/report.ts";
import { defaultWorkers, runScenario } from "../src/scenario/run.ts";
import { isSeed, loadScenario } from "../src/scenario/spec.ts";

const USAGE = "usage: npm run sim -- <scenario.json> [--seeds a..b | --seeds a,b,c] [--workers k] [--json out.json]";

/** "3..7" or "1,2,5": every part a plain integer, no duplicates. */
function parseSeeds(text: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(text);
  const seeds = range
    ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
    : text.split(",").map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (seeds.length === 0 || !seeds.every(isSeed) || new Set(seeds).size !== seeds.length) {
    throw new RangeError(`--seeds: a range a..b (a <= b) or a list a,b,c of distinct seeds, got "${text}"`);
  }
  return seeds;
}

function parseWorkers(text: string): number {
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new RangeError(`--workers: a positive integer, got "${text}"`);
  return Number(text);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string" }, workers: { type: "string" }, json: { type: "string" } },
  });
  if (positionals.length !== 1) throw new RangeError(USAGE);
  const { scenario, baseDir } = loadScenario(positionals[0] as string);
  const workers = values.workers === undefined ? defaultWorkers() : parseWorkers(values.workers);
  const seeds = values.seeds === undefined ? undefined : parseSeeds(values.seeds);
  await buildEngine();
  const run = await runScenario(scenario, { baseDir, workers, ...(seeds ? { seeds } : {}) });
  console.log(formatRun(run));
  if (values.json) writeFileSync(values.json, `${JSON.stringify(run, null, 2)}\n`);
  process.exitCode = run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
