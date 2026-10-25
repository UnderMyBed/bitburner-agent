// npm run sim: runs a scenario file once per seed, printing a progress line per seed per checkpoint on stderr, then the
// table. scripts/run-scenario.ts calls it with the real dependencies; tests pass stubs.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatProgress, formatRun } from "./report.ts";
import { defaultWorkers, type ScenarioOptions, type ScenarioRun } from "./run.ts";
import { loadScenario, parseMaxHeap, parseSeeds, parseWallLimit, parseWorkers, type Scenario } from "./spec.ts";

export const USAGE =
  "usage: npm run sim -- <scenario.json> [--seeds a..b | a,b,c] [--workers k] [--wall-limit minutes (default: none)] " +
  "[--max-heap MB (default: Node's)] [--json out.json]";

export interface ScenarioCliDeps {
  buildEngine: () => Promise<unknown>;
  runScenario: (
    scenario: Scenario,
    options: ScenarioOptions & { seeds?: number[]; workers?: number },
  ) => Promise<ScenarioRun>;
  log: (text: string) => void;
  error: (text: string) => void;
}

/**
 * Runs the CLI. Returns the exit code: 0 if every seed passed, 1 if any didn't, 2 if it couldn't run at all (bad usage,
 * a bad scenario, a build failure). Every option is checked before the engine is built.
 */
export async function scenarioCli(argv: string[], deps: ScenarioCliDeps): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
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
    const options: ScenarioOptions & { seeds?: number[]; workers: number } = {
      baseDir,
      workers: values.workers === undefined ? defaultWorkers() : parseWorkers(values.workers),
      onCheckpoint: (seed, checkpoint, wallMs) => deps.error(formatProgress(seed, checkpoint, wallMs)),
    };
    if (values.seeds !== undefined) options.seeds = parseSeeds(values.seeds);
    if (values["wall-limit"] !== undefined) options.wallLimitMs = parseWallLimit(values["wall-limit"]);
    if (values["max-heap"] !== undefined) options.maxHeapMb = parseMaxHeap(values["max-heap"]);
    await deps.buildEngine();
    const run = await deps.runScenario(scenario, options);
    if (values.json) writeFileSync(values.json, `${JSON.stringify(run, null, 2)}\n`);
    deps.log(formatRun(run));
    return run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
