// npm run bench -w @bitburner-agent/sim [-- --dry-run | --accept] | [-- --profile <workload> [--out file.cpuprofile]]
// Benchmarks the simulator: each workload's median speed over its seeds, and the heap over a 7-virtual-day lean run.
// Appends the results as a row of docs/sim/benchmarks.md, unless they regressed: more than 20% worse than the last
// row from this machine (docs/sim/benchmarks.md has the rules). A regressed row is recorded only with --accept.
// Exits 0 if nothing regressed, 1 if something did, and 2 if it couldn't run.
// With --profile, it instead profiles one run of a workload, writes the profile and prints where the time went.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { topSelfTime } from "../src/bench/profile.ts";
import {
  type BenchRow,
  commitId,
  formatRow,
  growthPerDay,
  parseRows,
  regressions,
  rigId,
  rowText,
  WORKLOADS,
  type Workload,
} from "../src/bench/report.ts";
import { buildEngine } from "../src/engine/build.ts";
import type { CpuProfile } from "../src/protocol.ts";
import { runScenario, startScenario } from "../src/scenario/run.ts";
import { loadScenario, scenarioSeeds } from "../src/scenario/spec.ts";

const USAGE =
  "usage: npm run bench -w @bitburner-agent/sim [-- --dry-run | --accept] | [-- --profile <workload> [--out file.cpuprofile]]";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RESULTS = path.join(REPO_ROOT, "docs/sim/benchmarks.md");
const DAY_MS = 24 * 60 * 60 * 1000;
const HEAP_DAYS = 7;
const MB = 2 ** 20;

const scenarioFile = (workload: Workload) => path.join(import.meta.dirname, "../scenarios", `${workload}.json`);

/** Median speed over the workload's seeds, one simulation at a time so they don't compete for the CPU. */
async function speedOf(workload: Workload): Promise<number> {
  const { scenario, baseDir } = loadScenario(scenarioFile(workload));
  const run = await runScenario(scenario, { baseDir, workers: 1 });
  const failed = run.results.find((r) => !r.ok);
  if (failed) throw new Error(`${workload}: seed ${failed.seed} failed: ${failed.error}`);
  return run.aggregate.speed?.median ?? 0;
}

/** Heap after a full collection, in MB, as the lean workload starts and at the end of each virtual day after. */
async function leanHeap(): Promise<number[]> {
  const { scenario, baseDir } = loadScenario(scenarioFile("lean"));
  const sim = await startScenario(scenario, 1, { baseDir });
  try {
    const daily = [(await sim.diagnostics.heap()) / MB];
    for (let day = 1; day <= HEAP_DAYS; day++) {
      await sim.runUntil(DAY_MS);
      daily.push((await sim.diagnostics.heap()) / MB);
      console.log(`  heap after day ${day}: ${daily.at(-1)?.toFixed(1)} MB`);
    }
    return daily;
  } finally {
    await sim.close();
  }
}

/** The short commit hash, "-dirty" if anything but the results file has changed. */
const commit = () => commitId(REPO_ROOT, [path.relative(REPO_ROOT, RESULTS)]);

/** Measures, prints the row and records it unless that's a dry run, or it regressed and isn't accepted. */
async function bench({ dryRun, accept }: { dryRun: boolean; accept: boolean }): Promise<string[]> {
  const speeds = {} as Record<Workload, number>;
  for (const workload of WORKLOADS) {
    speeds[workload] = await speedOf(workload);
    console.log(`${workload}: ${speeds[workload]}x`);
  }
  console.log(`lean heap over ${HEAP_DAYS} virtual days:`);
  const daily = await leanHeap();
  const row: BenchRow = {
    date: new Date().toISOString().slice(0, 10),
    commit: commit(),
    rig: rigId(),
    node: process.version,
    speeds,
    heap: { startMb: daily[0] as number, endMb: daily.at(-1) as number, perDayMb: growthPerDay(daily) },
  };
  const markdown = readFileSync(RESULTS, "utf8");
  const earlier = parseRows(markdown);
  const found = regressions(row, earlier);
  console.log(`\n${formatRow(row)}`);
  if (!earlier.some((r) => r.rig === row.rig)) console.log(`(no earlier row from rig ${row.rig}: nothing compared)`);
  if (dryRun) console.log("(dry run: not recorded)");
  else if (found.length > 0 && !accept)
    console.log("(regressed: not recorded; see docs/sim/benchmarks.md#regressions)");
  else appendFileSync(RESULTS, rowText(markdown, row));
  return found;
}

async function profile(workload: Workload, out: string): Promise<void> {
  const { scenario, baseDir } = loadScenario(scenarioFile(workload));
  const sim = await startScenario(scenario, scenarioSeeds(scenario.seeds)[0] as number, { baseDir });
  let result: CpuProfile | null;
  try {
    await sim.diagnostics.profile("start");
    await sim.runUntil(scenario.durationMs);
    result = await sim.diagnostics.profile("stop");
  } finally {
    await sim.close();
  }
  if (!result) throw new Error("the host returned no profile");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result));
  console.log(`${workload}: profile written to ${out}\n\nself time  share  function`);
  for (const { function: name, ms, share } of topSelfTime(result)) {
    console.log(`${`${ms.toFixed(0)} ms`.padStart(9)}  ${`${(share * 100).toFixed(1)}%`.padStart(5)}  ${name}`);
  }
}

const isWorkload = (name: string): name is Workload => (WORKLOADS as readonly string[]).includes(name);

/** The options, checked before anything slow runs. */
function options() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      accept: { type: "boolean", default: false },
      profile: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.profile === undefined) {
    if (values.out !== undefined) throw new RangeError("--out goes with --profile");
    if (values["dry-run"] && values.accept) throw new RangeError("--dry-run and --accept don't go together");
    return { mode: "bench" as const, dryRun: values["dry-run"], accept: values.accept };
  }
  if (!isWorkload(values.profile)) throw new RangeError(`--profile: one of ${WORKLOADS.join(", ")}`);
  if (values["dry-run"] || values.accept)
    throw new RangeError("--profile doesn't record a row: no --dry-run or --accept");
  // npm runs this from packages/sim; a relative --out is from where npm was run. The default is gitignored.
  const out = values.out
    ? path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out)
    : path.join(REPO_ROOT, ".reports", `${values.profile}.cpuprofile`);
  return { mode: "profile" as const, workload: values.profile, out };
}

let chosen: ReturnType<typeof options>;
try {
  chosen = options();
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
try {
  await buildEngine();
  if (chosen.mode === "profile") {
    await profile(chosen.workload, chosen.out);
  } else {
    const found = await bench(chosen);
    for (const regression of found) console.error(`REGRESSION ${regression}`);
    process.exitCode = found.length > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
