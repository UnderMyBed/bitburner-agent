// npm run sim -- <scenario.json> [--seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] [--max-heap MB]
//   [--json out.json]
// Runs a scenario once per seed and prints a table, with a progress line per seed per checkpoint on stderr. Exits 0 if
// every seed passed, 1 if any didn't, and 2 if it couldn't run at all (bad usage, a bad scenario, a build failure).
// npm runs it from the repository root, so paths are relative to that.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildEngine } from "../src/engine/build.ts";
import { formatProgress, formatRun } from "../src/scenario/report.ts";
import { defaultWorkers, runScenario } from "../src/scenario/run.ts";
import { loadScenario, parseMaxHeap, parseSeeds, parseWallLimit, parseWorkers } from "../src/scenario/spec.ts";

const USAGE =
  "usage: npm run sim -- <scenario.json> [--seeds a..b | a,b,c] [--workers k] [--wall-limit minutes] " +
  "[--max-heap MB] [--json out.json]";

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      seeds: { type: "string" },
      workers: { type: "string" },
      "wall-limit": { type: "string" },
      "max-heap": { type: "string" },
      json: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new RangeError(USAGE);
  const { scenario, baseDir } = loadScenario(positionals[0] as string);
  const workers = values.workers === undefined ? defaultWorkers() : parseWorkers(values.workers);
  const seeds = values.seeds === undefined ? undefined : parseSeeds(values.seeds);
  const wallLimitMs = values["wall-limit"] === undefined ? undefined : parseWallLimit(values["wall-limit"]);
  const maxHeapMb = values["max-heap"] === undefined ? undefined : parseMaxHeap(values["max-heap"]);
  await buildEngine();
  const run = await runScenario(scenario, {
    baseDir,
    workers,
    ...(seeds ? { seeds } : {}),
    ...(wallLimitMs === undefined ? {} : { wallLimitMs }),
    ...(maxHeapMb === undefined ? {} : { maxHeapMb }),
    onCheckpoint: (seed, checkpoint, wallMs) => console.error(formatProgress(seed, checkpoint, wallMs)),
  });
  console.log(formatRun(run));
  if (values.json) writeFileSync(values.json, `${JSON.stringify(run, null, 2)}\n`);
  process.exitCode = run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
