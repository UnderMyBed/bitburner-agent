// npm run bench -w @bitburner-agent/sim [-- --dry-run | -- --profile <workload> [--out file.cpuprofile]]
// Benchmarks the simulator: each workload's median speed over its seeds, and the heap over a 7-virtual-day lean run.
// Appends the results as a row of docs/sim/benchmarks.md and flags anything more than 20% worse than the last row
// from this machine. Exits 0 if nothing regressed, 1 if something did, and 2 if it couldn't run.
// With --profile, it instead profiles one run of a workload, writes the profile and prints where the time went.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { topSelfTime } from "../src/bench/profile.ts";
import {
  type BenchRow,
  formatRow,
  growthPerDay,
  parseRows,
  regressions,
  rigId,
  WORKLOADS,
  type Workload,
} from "../src/bench/report.ts";
import { buildEngine } from "../src/engine/build.ts";
import type { CpuProfile } from "../src/protocol.ts";
import { runScenario, startScenario } from "../src/scenario/run.ts";
import { loadScenario, scenarioSeeds } from "../src/scenario/spec.ts";

const USAGE =
  "usage: npm run bench -w @bitburner-agent/sim [-- --dry-run | -- --profile <workload> [--out file.cpuprofile]]";
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
function commit(): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const changed = git("status", "--porcelain", "--", ".", `:!${path.relative(REPO_ROOT, RESULTS)}`);
  return `${git("rev-parse", "--short", "HEAD")}${changed ? "-dirty" : ""}`;
}

async function bench(dryRun: boolean): Promise<string[]> {
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
  const line = formatRow(row);
  const found = regressions(row, parseRows(readFileSync(RESULTS, "utf8")));
  console.log(`\n${line}`);
  if (dryRun) console.log("(dry run: not recorded)");
  else appendFileSync(RESULTS, `${line}\n`);
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
  writeFileSync(out, JSON.stringify(result));
  console.log(`${workload}: profile written to ${out}\n\nself time  share  function`);
  for (const { function: name, ms, share } of topSelfTime(result)) {
    console.log(`${`${ms.toFixed(0)} ms`.padStart(9)}  ${`${(share * 100).toFixed(1)}%`.padStart(5)}  ${name}`);
  }
}

const isWorkload = (name: string): name is Workload => (WORKLOADS as readonly string[]).includes(name);

try {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean" }, profile: { type: "string" }, out: { type: "string" } },
  });
  await buildEngine();
  if (values.profile !== undefined) {
    if (!isWorkload(values.profile)) throw new RangeError(`--profile: one of ${WORKLOADS.join(", ")}\n${USAGE}`);
    await profile(values.profile, values.out ?? `${values.profile}.cpuprofile`);
  } else {
    const found = await bench(values["dry-run"] ?? false);
    for (const regression of found) console.error(`REGRESSION ${regression}`);
    process.exitCode = found.length > 0 ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
