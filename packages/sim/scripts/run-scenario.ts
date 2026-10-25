// npm run sim -- <scenario.json> [--seeds a..b | --seeds 1,2,5] [--workers k] [--json out.json]
// Runs a scenario once per seed and prints a table. Exits 0 if every seed passed, 1 if any didn't, 2 on bad usage.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildEngine } from "../src/engine/build.ts";
import { formatRun } from "../src/scenario/report.ts";
import { defaultWorkers, runScenario } from "../src/scenario/run.ts";
import { loadScenario } from "../src/scenario/spec.ts";

/** "3..7" or "1,2,5". */
function parseSeeds(text: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(text);
  const seeds = range
    ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i)
    : text.split(",").map(Number);
  if (seeds.length === 0 || !seeds.every((s) => Number.isInteger(s) && s >= 0 && s <= 0xffffffff)) {
    throw new RangeError(`--seeds: a range a..b or a list a,b,c of seeds, got "${text}"`);
  }
  return seeds;
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string" }, workers: { type: "string" }, json: { type: "string" } },
  });
  if (positionals.length !== 1)
    throw new RangeError("usage: npm run sim -- <scenario.json> [--seeds a..b] [--workers k] [--json out.json]");
  const { scenario, baseDir } = loadScenario(positionals[0] as string);
  const workers = values.workers === undefined ? defaultWorkers() : Number(values.workers);
  await buildEngine();
  const run = await runScenario(scenario, {
    baseDir,
    workers,
    ...(values.seeds === undefined ? {} : { seeds: parseSeeds(values.seeds) }),
  });
  console.log(formatRun(run));
  if (values.json) writeFileSync(values.json, `${JSON.stringify(run, null, 2)}\n`);
  process.exitCode = run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
