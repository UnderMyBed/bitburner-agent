// Runs a scenario once per seed, each in its own simulation process, with a bounded number at a time.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import type { Fixture, GameSummary, RunUntilResult, SimEvent } from "../protocol.ts";
import { Simulation } from "../simulation.ts";
import { type Scenario, scenarioSeeds } from "./spec.ts";

export interface Checkpoint {
  virtualMs: number;
  summary: GameSummary;
}

export interface SeedResult {
  seed: number;
  /** False if the run failed: the simulation crashed, a script couldn't start, a request was refused. */
  ok: boolean;
  error?: string;
  /** Whether the run stopped on a condition (and which), rather than running the full duration. */
  stoppedBy: RunUntilResult["stoppedBy"];
  /** A run passes if it is ok and, when the scenario has stop conditions, one of them stopped it. */
  passed: boolean;
  /** Virtual time the run took, from its start. */
  virtualMs: number;
  /** Real time the run took, booting excluded. */
  wallMs: number;
  /** Virtual ms per real ms. */
  speed: number;
  stateHash?: string;
  summary?: GameSummary;
  checkpoints: Checkpoint[];
  events: SimEvent[];
}

export interface ScenarioOptions {
  /** Where the scenario's relative paths start: the scenario file's directory. Default: the working directory. */
  baseDir?: string;
  /**
   * Test-only knobs: `crashSeeds` makes those seeds' simulations crash after they start, to show a failure stays
   * with its seed.
   * @internal
   */
  testHooks?: { crashSeeds?: number[] };
}

/** A save fixture's path is relative to the scenario file. */
function resolveFixture(fixture: Fixture, baseDir: string): Fixture {
  if (fixture.kind !== "save" || fixture.path === undefined) return fixture;
  return { ...fixture, path: path.resolve(baseDir, fixture.path) };
}

/** Every file under `dir`, by its path relative to `dir` (forward slashes, as the game's paths). */
function filesIn(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(files, filesIn(full, `${prefix}${name}/`));
    else files[`${prefix}${name}`] = readFileSync(full, "utf8");
  }
  return files;
}

async function allEvents(sim: Simulation): Promise<SimEvent[]> {
  const events: SimEvent[] = [];
  for (let since = 0; ; ) {
    const page = await sim.events(since);
    events.push(...page.events);
    if (page.events.length === 0) return events;
    since = page.next;
  }
}

/** Runs a scenario with one seed, in a fresh simulation. Never throws: a failure is in the result. */
export async function runSeed(scenario: Scenario, seed: number, options: ScenarioOptions = {}): Promise<SeedResult> {
  const baseDir = options.baseDir ?? process.cwd();
  const result: SeedResult = {
    seed,
    ok: false,
    stoppedBy: null,
    passed: false,
    virtualMs: 0,
    wallMs: 0,
    speed: 0,
    checkpoints: [],
    events: [],
  };
  let sim: Simulation | undefined;
  try {
    sim = await Simulation.start({
      seed,
      fixture: resolveFixture(scenario.fixture, baseDir),
      ...(scenario.epochMs !== undefined ? { epochMs: scenario.epochMs } : {}),
      ...(scenario.prompts ? { prompts: scenario.prompts } : {}),
    });
    if (options.testHooks?.crashSeeds?.includes(seed)) await sim.diagnostics.crash(3, `test hook: crash seed ${seed}`);
    if (scenario.homeRamGb !== undefined) await sim.diagnostics.setHomeRam(scenario.homeRamGb);
    for (const [host, files] of Object.entries(scenario.files ?? {})) {
      const contents = typeof files === "string" ? filesIn(path.resolve(baseDir, files)) : files;
      for (const [file, content] of Object.entries(contents)) await sim.writeFile(host, file, content);
    }
    for (const { script, host = "home", threads = 1, args = [] } of scenario.run ?? []) {
      const { pid, error } = await sim.run(host, script, { threads, args });
      if (pid === 0) throw new Error(`couldn't start ${script} on ${host}: ${error}`);
    }

    const startedAt = await sim.now();
    const wallStart = performance.now();
    const every = scenario.checkpointEveryMs ?? scenario.durationMs;
    let elapsed = 0;
    while (elapsed < scenario.durationMs && result.stoppedBy === null) {
      const step = Math.min(every - (elapsed % every), scenario.durationMs - elapsed);
      const { now, stoppedBy } = await sim.runUntil(step, {
        ...(scenario.stopWhen ? { stopWhen: scenario.stopWhen } : {}),
        ...(scenario.onBitVerse ? { onBitVerse: scenario.onBitVerse } : {}),
      });
      elapsed = now - startedAt;
      result.stoppedBy = stoppedBy;
      if (elapsed % every === 0 || stoppedBy !== null || elapsed >= scenario.durationMs) {
        result.checkpoints.push({ virtualMs: elapsed, summary: await sim.summary() });
      }
    }
    result.wallMs = Math.round(performance.now() - wallStart);
    result.virtualMs = elapsed;
    result.speed = result.wallMs > 0 ? Math.round(elapsed / result.wallMs) : 0;
    result.summary = result.checkpoints.at(-1)?.summary ?? (await sim.summary());
    result.stateHash = await sim.stateHash();
    result.events = await allEvents(sim);
    result.ok = true;
    const mustStop = (scenario.stopWhen?.length ?? 0) > 0 || scenario.onBitVerse === "stop";
    result.passed = !mustStop || result.stoppedBy !== null;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await sim?.close();
  }
  return result;
}

/** The default number of simulations at once: the machine's parallelism, less a reserve for everything else. */
export function defaultWorkers(reserve = 2, parallelism = availableParallelism()): number {
  return Math.max(1, parallelism - reserve);
}

export interface ScenarioRun {
  scenario: string;
  results: SeedResult[];
  aggregate: Aggregate;
}

/** Runs every seed, at most `workers` at once; results come back in seed order. */
export async function runScenario(
  scenario: Scenario,
  {
    seeds = scenarioSeeds(scenario.seeds),
    workers = defaultWorkers(),
    ...options
  }: ScenarioOptions & {
    seeds?: number[];
    workers?: number;
  } = {},
): Promise<ScenarioRun> {
  if (!Number.isInteger(workers) || workers < 1)
    throw new RangeError(`workers must be a positive integer, got ${workers}`);
  const results: SeedResult[] = new Array(seeds.length);
  let next = 0;
  const worker = async () => {
    while (next < seeds.length) {
      const index = next++;
      results[index] = await runSeed(scenario, seeds[index] as number, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, seeds.length) }, worker));
  return { scenario: scenario.name, results, aggregate: aggregate(results) };
}

export interface Distribution {
  min: number;
  median: number;
  p90: number;
  max: number;
}

export interface Aggregate {
  seeds: number;
  passed: number;
  passRate: number;
  /** Virtual ms to the stop, over the runs that stopped on a condition; null if none did. */
  timeToStop: Distribution | null;
  /** Virtual ms per real ms, over the runs that didn't fail. */
  speed: Distribution | null;
}

/** min, median, 90th percentile (nearest rank) and max; null for no values. */
export function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
  return { min: sorted[0] as number, median: rank(0.5), p90: rank(0.9), max: sorted.at(-1) as number };
}

export function aggregate(results: SeedResult[]): Aggregate {
  const passed = results.filter((r) => r.passed).length;
  return {
    seeds: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    timeToStop: distribution(results.filter((r) => r.ok && r.stoppedBy !== null).map((r) => r.virtualMs)),
    speed: distribution(results.filter((r) => r.ok).map((r) => r.speed)),
  };
}
