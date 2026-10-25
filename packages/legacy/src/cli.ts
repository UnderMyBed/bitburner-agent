// npm run baseline: runs the fork baseline (baseline.ts, docs/sim/baselines.md) once per seed, measuring each run's
// heap, and prints the scenario table, each seed's heap and the run's row for docs/sim/baselines.md. scripts/baseline.ts
// calls it with the real dependencies; tests pass stubs.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  formatProgress,
  formatRun,
  parseMaxHeap,
  parseSeeds,
  parseWallLimit,
  parseWorkers,
  type Scenario,
  type ScenarioOptions,
  type ScenarioRun,
} from "@bitburner-agent/sim";
import { baselineScenario } from "./baseline.ts";
import { baselineRow, formatHeaps } from "./report.ts";

export const USAGE =
  "usage: npm run baseline -w @bitburner-agent/legacy [-- --seeds a..b | a,b,c] [--workers k] " +
  "[--wall-limit minutes (default 720)] [--max-heap MB (default 2048)] [--json out.json]";
/** Each seed's default real-time limit: 12 hours. */
export const DEFAULT_WALL_LIMIT_MS = 12 * 60 * 60_000;
/** Each simulation's default heap cap: the fork's heap stayed near 120 MB, reaching 1 GB only with 144,000 scripts. */
export const DEFAULT_MAX_HEAP_MB = 2048;

export interface CliDeps {
  buildEngine: () => Promise<unknown>;
  runScenario: (
    scenario: Scenario,
    options: ScenarioOptions & { seeds?: number[]; workers?: number },
  ) => Promise<ScenarioRun>;
  /** The checkout's commit, "-dirty" if it has changes (`commitId`). */
  commit: () => string;
  /** The machine's name (`rigId`). */
  rig: () => string;
  now: () => Date;
  node: string;
  /** Where relative paths start: where npm was run (`INIT_CWD`). */
  cwd: string;
  log: (text: string) => void;
  error: (text: string) => void;
}

/**
 * Runs the CLI. Returns the exit code: 0 if every seed destroyed the BitNode, 1 if any didn't, 2 if it couldn't run.
 * Everything that can refuse (arguments, the `--json` folder, the commit, the rig's name) is checked before the run,
 * and the JSON is written as soon as the run ends, so hours of results are never lost to a late error.
 */
export async function baselineCli(argv: string[], deps: CliDeps): Promise<number> {
  let meta: Parameters<typeof baselineRow>[1];
  let options: { seeds?: number[]; workers: number; wallLimitMs: number; maxHeapMb: number };
  let json: string | undefined;
  try {
    const { values, positionals } = parseArgs({
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
    if (positionals.length > 0) throw new RangeError(USAGE);
    // One seed at a time unless asked: a seed is heavy (docs/sim/baselines.md, #75).
    options = {
      workers: values.workers === undefined ? 1 : parseWorkers(values.workers),
      wallLimitMs: values["wall-limit"] === undefined ? DEFAULT_WALL_LIMIT_MS : parseWallLimit(values["wall-limit"]),
      maxHeapMb: values["max-heap"] === undefined ? DEFAULT_MAX_HEAP_MB : parseMaxHeap(values["max-heap"]),
    };
    if (values.seeds !== undefined) options.seeds = parseSeeds(values.seeds);
    json = values.json === undefined ? undefined : path.resolve(deps.cwd, values.json);
    if (json && !existsSync(path.dirname(json))) throw new Error(`--json: no folder ${path.dirname(json)}`);
    meta = { date: deps.now().toISOString().slice(0, 10), commit: deps.commit(), rig: deps.rig(), node: deps.node };
    await deps.buildEngine();
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let run: ScenarioRun;
  try {
    // A seed's failure is in its result; this throws only if the run as a whole couldn't happen.
    run = await deps.runScenario(baselineScenario(), {
      ...options,
      measureHeap: true,
      onCheckpoint: (seed, checkpoint, wallMs) => deps.error(formatProgress(seed, checkpoint, wallMs)),
    });
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (json) writeFileSync(json, `${JSON.stringify(run, null, 2)}\n`);
  deps.log(formatRun(run));
  deps.log(`\n${formatHeaps(run)}`);
  deps.log(`\nrow for docs/sim/baselines.md:\n${baselineRow(run, meta)}`);
  return run.aggregate.passed === run.aggregate.seeds ? 0 : 1;
}
