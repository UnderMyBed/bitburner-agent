import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { scenarioCli } from "../src/scenario/cli.ts";
import { formatRun } from "../src/scenario/report.ts";
import {
  aggregate,
  defaultWorkers,
  distribution,
  runScenario,
  runSeed,
  type SeedResult,
  startScenario,
} from "../src/scenario/run.ts";
import { loadScenario, type Scenario, scenarioSeeds, validateScenario } from "../src/scenario/spec.ts";
import { Simulation } from "../src/simulation.ts";
import { withBitNodeFinished } from "./helpers/save-edit.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIOS = path.join(REPO_ROOT, "packages/sim/scenarios");
const scratch = mkdtempSync(path.join(tmpdir(), "sim-scenarios-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HACK_LOOP = readFileSync(path.join(SCENARIOS, "scripts/hack.js"), "utf8");
const lean = (extra: Partial<Scenario> = {}): Scenario => ({
  name: "lean test",
  fixture: { kind: "new", tutorial: "skipped" },
  epochMs: EPOCH,
  files: { home: { "hack.js": HACK_LOOP } },
  run: [{ script: "hack.js", threads: 3 }],
  durationMs: 10 * MINUTE,
  ...extra,
});

/** A result without what real time decides. */
const deterministic = ({ wallMs, speed, ...rest }: SeedResult) => rest;

const result = (r: Partial<SeedResult>): SeedResult => ({
  seed: 0,
  ok: true,
  stoppedBy: null,
  passed: true,
  uncaught: 0,
  virtualMs: 0,
  wallMs: 0,
  speed: 0,
  checkpoints: [],
  events: [],
  ...r,
});

describe("scenario specs", () => {
  test("seeds come as a list or an inclusive range, default [1]", () => {
    expect(scenarioSeeds()).toEqual([1]);
    expect(scenarioSeeds([5, 2])).toEqual([5, 2]);
    expect(scenarioSeeds({ from: 3, to: 6 })).toEqual([3, 4, 5, 6]);
  });

  test.each([
    [[], /a JSON object/],
    [{ ...lean(), extra: 1 }, /unknown field "extra"/],
    [{ ...lean(), name: "" }, /name/],
    [{ ...lean(), fixture: "new" }, /fixture/],
    [{ ...lean(), fixture: { kind: "new" } }, /tutorial/],
    [{ ...lean(), fixture: { kind: "bitnode", n: 20, sourceFiles: {} } }, /n in 1-15/],
    [{ ...lean(), epochMs: undefined }, /epochMs: required/],
    [{ ...lean(), fixture: { kind: "save", path: "a.json.gz" } }, /epochMs: a save fixture takes its epoch/],
    [{ ...lean(), epochMs: undefined, fixture: { kind: "save" } }, /needs a path/],
    [{ ...lean(), durationMs: 0 }, /durationMs/],
    [{ ...lean(), checkpointEveryMs: -5 }, /checkpointEveryMs/],
    [{ ...lean(), files: { home: { "a.js": 3 } } }, /files.home/],
    [{ ...lean(), files: { home: "." } }, /inside the scenario's own directory/],
    [{ ...lean(), files: { home: "../elsewhere" } }, /inside the scenario's own directory/],
    [{ ...lean(), run: [{ threads: 2 }] }, /run\[0\]/],
    [{ ...lean(), run: [{ script: "a.js", threads: 0 }] }, /run\[0\].threads/],
    [{ ...lean(), run: [{ script: "a.js", args: [{}] }] }, /script args/],
    [{ ...lean(), seeds: [] }, /seeds/],
    [{ ...lean(), seeds: [1, 1] }, /distinct/],
    [{ ...lean(), seeds: { from: 5, to: 2 } }, /seeds/],
    [{ ...lean(), homeRamGb: 100 }, /homeRamGb: home RAM must be a power of 2/],
    [{ ...lean(), prompts: [{ match: "" }] }, /prompts/],
    [{ ...lean(), stopWhen: [{ event: "nope" }] }, /stop on event/],
    [{ ...lean(), failWhen: {} }, /failWhen: a list/],
    [{ ...lean(), onBitVerse: { enter: 0 } }, /onBitVerse/],
    [{ ...lean(), onBitVerse: null }, /onBitVerse/],
  ])("refuses %o", (scenario, message) => {
    expect(() => validateScenario(scenario)).toThrow(message);
  });

  test("the scenario files in the repository are valid", () => {
    const files = readdirSync(SCENARIOS).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["batch.json", "churn.json", "copies.json", "lean.json"]);
    for (const file of files) expect(() => loadScenario(path.join(SCENARIOS, file))).not.toThrow();
  });
});

describe("aggregates", () => {
  test("distribution: min, median, 90th percentile by nearest rank, max", () => {
    expect(distribution([])).toBe(null);
    expect(distribution([7])).toEqual({ min: 7, median: 7, p90: 7, max: 7 });
    expect(distribution([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ min: 1, median: 5, p90: 9, max: 10 });
  });

  test("pass rate; time to stop over the runs that passed by stopping; speed over the runs that didn't fail", () => {
    const byStop = { list: "stopWhen", index: 0 } as const;
    const byFail = { list: "failWhen", index: 0 } as const;
    expect(
      aggregate([
        result({ stoppedBy: byStop, virtualMs: 100, speed: 50 }),
        result({ stoppedBy: "bitverse", virtualMs: 300, speed: 30 }),
        result({ stoppedBy: byFail, passed: false, virtualMs: 50, speed: 60 }),
        result({ passed: false, virtualMs: 1000, speed: 40 }),
        result({ ok: false, passed: false, speed: 0 }),
      ]),
    ).toEqual({
      seeds: 5,
      passed: 2,
      passRate: 0.4,
      timeToStop: { min: 100, median: 100, p90: 300, max: 300 },
      speed: { min: 30, median: 40, p90: 60, max: 60 },
    });
  });

  test("the default pool is the machine's parallelism less a reserve, at least 1", () => {
    expect(defaultWorkers(2, 16)).toBe(14);
    expect(defaultWorkers(4, 16)).toBe(12);
    expect(defaultWorkers(2, 2)).toBe(1);
  });

  test("the table: one row per seed, failures and what stopped each run, then errors in full", () => {
    const text = formatRun({
      scenario: "s",
      results: [
        result({
          seed: 1,
          stoppedBy: { list: "stopWhen", index: 0 },
          virtualMs: 3_600_000,
          speed: 900,
          stateHash: "a".repeat(64),
        }),
        result({ seed: 2, passed: false, virtualMs: 7_200_000, speed: 800, uncaught: 2, stateHash: "b".repeat(64) }),
        result({ seed: 3, passed: false, stoppedBy: { list: "failWhen", index: 1 }, stateHash: "c".repeat(64) }),
        result({
          seed: 4,
          ok: false,
          passed: false,
          error: "Simulation process exited with code 3.\nLast output:\nboom",
        }),
      ],
      aggregate: aggregate([]),
    });
    const lines = text.split("\n");
    expect(lines[1]).toMatch(/^seed\s+result\s+stopped by\s+virtual\s+wall\s+speed\s+uncaught\s+state hash$/);
    expect(lines[2]).toMatch(/^1\s+pass\s+stopWhen\[0\]\s+1\.00 h\s+0\.0 s\s+900x\s+0\s+aaaaaaaaaaaa$/);
    expect(lines[3]).toMatch(/^2\s+no stop\s+-\s+2\.00 h\s+0\.0 s\s+800x\s+2\s+bbbbbbbbbbbb$/);
    expect(lines[4]).toMatch(/^3\s+fail\s+failWhen\[1\]/);
    expect(lines[5]).toMatch(/^4\s+FAILED\s+-/);
    expect(text).toContain("errors:\nseed 4: Simulation process exited with code 3.\nLast output:\nboom");
  });
});

describe("running scenarios", () => {
  test("each seed's result is the same with 1 worker or 4", async () => {
    const seeds = [1, 2, 3, 4];
    const one = await runScenario(lean(), { seeds, workers: 1 });
    const four = await runScenario(lean(), { seeds, workers: 4 });
    expect(four.results.map(deterministic)).toEqual(one.results.map(deterministic));
    expect(new Set(one.results.map((r) => r.stateHash)).size).toBe(4); // seeds differ from each other
    expect(one.results.every((r) => r.ok && r.passed)).toBe(true);
  });

  test("a seed that fails fails alone, and says why", async () => {
    const run = await runScenario(lean(), { seeds: [1, 2, 3], workers: 3, testHooks: { crashSeeds: [2] } });
    expect(run.results.map((r) => [r.seed, r.ok])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(run.results[1]?.error).toMatch(/exited with code 3[\s\S]*test hook: crash seed 2/);
    expect(run.aggregate).toMatchObject({ seeds: 3, passed: 2 });
  });

  test("checkpoints every interval and at the end; a stop condition ends the run and passes it", async () => {
    const files = { home: { "nap.js": "export async function main(ns) { await ns.sleep(150_000); }" } };
    const scenario = lean({
      files,
      run: [{ script: "nap.js" }],
      checkpointEveryMs: MINUTE,
      stopWhen: [{ scriptExited: "nap.js" }],
    });
    const [only] = (await runScenario(scenario, { seeds: [1], workers: 1 })).results;
    expect(only).toMatchObject({ ok: true, passed: true, stoppedBy: { list: "stopWhen", index: 0 } });
    expect(only?.checkpoints.map((c) => c.virtualMs)).toEqual([MINUTE, 2 * MINUTE, 150_000]);
    expect(only?.virtualMs).toBe(150_000);
    expect(only?.heapStartMb).toBeUndefined();
    expect(only?.checkpoints.every((c) => c.heapMb === undefined)).toBe(true);
  });

  test("with measureHeap, the heap is sampled as the run starts and at every checkpoint", async () => {
    const scenario = lean({ checkpointEveryMs: MINUTE, durationMs: 2 * MINUTE });
    const [only] = (await runScenario(scenario, { seeds: [1], workers: 1, measureHeap: true })).results;
    const heaps = [only?.heapStartMb, ...(only?.checkpoints.map((c) => c.heapMb) ?? [])];
    expect(heaps).toHaveLength(3);
    for (const mb of heaps) expect(mb).toBeGreaterThan(10);
    for (const mb of heaps) expect(mb).toBeLessThan(4096);
  });

  test("onCheckpoint reports each checkpoint as it's taken, with the seed and the real time so far", async () => {
    const seen: [number, number][] = [];
    const wall: number[] = [];
    const scenario = lean({ checkpointEveryMs: MINUTE, durationMs: 3 * MINUTE });
    await runScenario(scenario, {
      seeds: [4],
      workers: 1,
      onCheckpoint: (seed, checkpoint, wallMs) => {
        seen.push([seed, checkpoint.virtualMs]);
        wall.push(wallMs);
      },
    });
    expect(seen).toEqual([
      [4, MINUTE],
      [4, 2 * MINUTE],
      [4, 3 * MINUTE],
    ]);
    expect(wall.every((ms, i) => ms >= 0 && ms >= (wall[i - 1] ?? 0))).toBe(true);
  });

  test("wallLimitMs kills a seed past it, without waiting for a checkpoint, and fails it with what it had", async () => {
    // Ten virtual years of the lean loop in 30-day pieces: many real seconds without a limit.
    const scenario = lean({ durationMs: 3650 * DAY, checkpointEveryMs: 30 * DAY });
    const [only] = (await runScenario(scenario, { seeds: [1], workers: 1, wallLimitMs: 500 })).results;
    expect(only).toMatchObject({
      ok: false,
      passed: false,
      error: "wall limit: 500 ms of real time reached; before its first checkpoint",
    });
    expect(only?.wallMs).toBeGreaterThanOrEqual(500);
    expect(only?.wallMs).toBeLessThan(5000);
    const kept = only?.checkpoints ?? [];
    expect(kept.length).toBeLessThan(121);
    expect(only?.virtualMs).toBe(kept.at(-1)?.virtualMs ?? 0);
  });

  test("a seed stopped by its wall limit keeps the checkpoints it reached, and says where it got to", async () => {
    const scenario = lean({ durationMs: 3650 * DAY, checkpointEveryMs: MINUTE });
    const [only] = (await runScenario(scenario, { seeds: [1], workers: 1, wallLimitMs: 1500 })).results;
    const kept = only?.checkpoints ?? [];
    expect(kept.length).toBeGreaterThan(0);
    const last = kept.at(-1);
    expect(only?.virtualMs).toBe(last?.virtualMs);
    expect(only?.summary).toEqual(last?.summary);
    expect(only?.error).toBe(
      `wall limit: 1500 ms of real time reached; its last checkpoint was at ${((last?.virtualMs ?? 0) / 3_600_000).toFixed(1)} virtual hours`,
    );
    expect(only?.stateHash).toBeUndefined();
  });

  test.each([0, -1, 1.5, Number.NaN, 2 ** 31])("refuses wallLimitMs %s before starting anything", async (ms) => {
    await expect(runScenario(lean(), { seeds: [1], wallLimitMs: ms })).rejects.toThrow(/wallLimitMs/);
    const result = await runSeed(lean(), 1, { wallLimitMs: ms });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/wallLimitMs/) });
  });

  test("refuses a maxHeapMb that can't work before starting any seed", async () => {
    await expect(runScenario(lean(), { seeds: [1, 2], maxHeapMb: 100 })).rejects.toThrow(/maxHeapMb/);
  });

  test.each([
    [
      "throws",
      () => {
        throw new Error("printer broke");
      },
    ],
    ["returns a rejected promise", () => Promise.reject(new Error("printer broke"))],
  ])("a progress callback that %s doesn't change the seed's result", async (_, onCheckpoint) => {
    const scenario = lean({ checkpointEveryMs: MINUTE, durationMs: 2 * MINUTE });
    const [only] = (await runScenario(scenario, { seeds: [1], workers: 1, onCheckpoint })).results;
    expect(only).toMatchObject({ ok: true, passed: true, virtualMs: 2 * MINUTE });
    expect(only?.checkpoints).toHaveLength(2);
  });
  test("maxHeapMb reaches each seed's simulation", async () => {
    const sim = await startScenario(lean(), 1, { maxHeapMb: 512 });
    try {
      expect(await sim.diagnostics.heapLimit()).toBeLessThan(1024 * 2 ** 20);
    } finally {
      await sim.close();
    }
  });

  test("a failWhen condition ends the run and fails it", async () => {
    const files = { home: { "nap.js": "export async function main(ns) { await ns.sleep(30_000); }" } };
    const scenario = lean({
      files,
      run: [{ script: "nap.js" }],
      stopWhen: [{ event: "bitnodeDestroyed" }],
      failWhen: [{ scriptExited: "nap.js" }],
    });
    const [only] = (await runScenario(scenario, { seeds: [1] })).results;
    expect(only).toMatchObject({
      ok: true,
      passed: false,
      stoppedBy: { list: "failWhen", index: 0 },
      virtualMs: 30_000,
    });
  });

  test("a scenario with stop conditions that ran out of time doesn't pass", async () => {
    const [only] = (await runScenario(lean({ stopWhen: [{ event: "bitnodeDestroyed" }] }), { seeds: [1] })).results;
    expect(only).toMatchObject({ ok: true, passed: false, stoppedBy: null, virtualMs: 10 * MINUTE });
  });

  test("events count from boot: a save that starts at the BitVerse stops a run at once", async () => {
    const sim = await Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
    const file = path.join(scratch, "at-bitverse.json.gz");
    writeFileSync(file, withBitNodeFinished(await sim.save()));
    await sim.close();
    const scenario: Scenario = {
      name: "at the BitVerse",
      fixture: { kind: "save", path: file },
      durationMs: MINUTE,
      stopWhen: [{ event: "bitverseReached" }],
    };
    const [only] = (await runScenario(scenario, { seeds: [1] })).results;
    expect(only).toMatchObject({ ok: true, passed: true, virtualMs: 0 });
  });

  test("uncaught errors are counted, not failures", async () => {
    const files = {
      home: { "oops.js": 'export async function main(ns) { setTimeout(() => { throw new Error("oops"); }, 10); }' },
    };
    const [only] = (await runScenario(lean({ files, run: [{ script: "oops.js" }] }), { seeds: [1] })).results;
    expect(only).toMatchObject({ ok: true, passed: true, uncaught: 1 });
  });

  test("a script that can't start fails the seed", async () => {
    const [only] = (await runScenario(lean({ run: [{ script: "missing.js" }] }), { seeds: [1] })).results;
    expect(only).toMatchObject({ ok: false, error: expect.stringContaining("couldn't start missing.js") });
  });

  test.each(["lean", "batch", "churn", "copies"])("the %s workload starts and runs", async (name) => {
    const { scenario, baseDir } = loadScenario(path.join(SCENARIOS, `${name}.json`));
    const [only] = (await runScenario({ ...scenario, durationMs: MINUTE }, { seeds: [1], workers: 1, baseDir }))
      .results;
    expect(only).toMatchObject({ ok: true, passed: true, uncaught: 0 });
    expect(only?.summary?.scripts).toBeGreaterThan(0);
  });
});

describe("the CLI", () => {
  const cli = path.join(REPO_ROOT, "packages/sim/scripts/run-scenario.ts");
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { cwd: REPO_ROOT }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
  const writeScenario = (name: string, scenario: object) => {
    const dir = path.join(scratch, name);
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/hack.js"), HACK_LOOP);
    writeFileSync(path.join(dir, "s.json"), JSON.stringify(scenario));
    return dir;
  };

  test("runs a scenario file, prints the table and writes JSON; files are relative to it", async () => {
    const dir = writeScenario("cli", { ...lean(), files: { home: "scripts" }, durationMs: MINUTE, seeds: [9] });
    const out = path.join(dir, "out.json");
    const { code, stdout } = await run(path.join(dir, "s.json"), "--seeds", "1..2", "--workers", "2", "--json", out);
    expect(code).toBe(0);
    expect(stdout).toContain("seed  result");
    expect(stdout).toContain("passed: 2/2 (100%)");
    const written = JSON.parse(readFileSync(out, "utf8")) as Awaited<ReturnType<typeof runScenario>>;
    expect(written.results.map((r) => r.seed)).toEqual([1, 2]);
    expect(written.results.every((r) => r.ok && r.summary !== undefined)).toBe(true);
  });

  test("passes --seeds, --workers, --wall-limit (minutes) and --max-heap (MB) to the run", async () => {
    const runs: unknown[] = [];
    const code = await scenarioCli(
      [
        "packages/sim/scenarios/lean.json",
        "--seeds",
        "2..3",
        "--workers",
        "1",
        "--wall-limit",
        "90",
        "--max-heap",
        "512",
      ],
      {
        buildEngine: async () => undefined,
        runScenario: async (scenario, options) => {
          runs.push(options);
          return { scenario: scenario.name, results: [], aggregate: aggregate([]) };
        },
        log: () => {},
        error: () => {},
      },
    );
    expect(code).toBe(0);
    expect(runs).toEqual([
      expect.objectContaining({ seeds: [2, 3], workers: 1, wallLimitMs: 90 * MINUTE, maxHeapMb: 512 }),
    ]);
  });

  test("prints a progress line per seed per checkpoint on stderr, and accepts --wall-limit and --max-heap", async () => {
    const dir = writeScenario("cli-progress", {
      ...lean(),
      files: { home: "scripts" },
      durationMs: 2 * MINUTE,
      checkpointEveryMs: MINUTE,
    });
    const out = path.join(dir, "out.json");
    const { code, stderr } = await run(
      path.join(dir, "s.json"),
      "--wall-limit",
      "5",
      "--max-heap",
      "512",
      "--json",
      out,
    );
    expect(code).toBe(0);
    expect(stderr.split("\n").filter((line) => line.startsWith("seed 1: "))).toHaveLength(2);
    expect(stderr).toMatch(/seed 1: 0\.03 h virtual, [\d.]+ min real, \d+x; \d+ scripts, \$[\d.e+]+, hacking \d+/);
  });

  test("exits 1 when a seed doesn't pass", async () => {
    const dir = writeScenario("cli-fail", {
      ...lean(),
      files: { home: "scripts" },
      durationMs: MINUTE,
      stopWhen: [{ event: "bitnodeDestroyed" }],
    });
    const { code, stdout } = await run(path.join(dir, "s.json"));
    expect(code).toBe(1);
    expect(stdout).toContain("no stop");
  });

  test.each([
    [[], "usage"],
    [["missing.json"], "can't read scenario"],
    [["packages/sim/scenarios/lean.json", "--seeds", ""], "--seeds"],
    [["packages/sim/scenarios/lean.json", "--seeds", "1,,2"], "--seeds"],
    [["packages/sim/scenarios/lean.json", "--seeds", "5..3"], "--seeds"],
    [["packages/sim/scenarios/lean.json", "--seeds", "1,1"], "--seeds"],
    [["packages/sim/scenarios/lean.json", "--workers", "0"], "--workers"],
    [["packages/sim/scenarios/lean.json", "--workers", "abc"], "--workers"],
    [["packages/sim/scenarios/lean.json", "--wall-limit", "0"], "--wall-limit"],
    [["packages/sim/scenarios/lean.json", "--wall-limit", "1.5"], "--wall-limit"],
    [["packages/sim/scenarios/lean.json", "--max-heap", "128"], "--max-heap"],
    [["packages/sim/scenarios/lean.json", "--wall-limit", "35792"], "--wall-limit"],
    [["packages/sim/scenarios/lean.json", "--max-heap", "100000000000000000000"], "--max-heap"],
  ])("refuses %o, exiting 2", async (args, message) => {
    expect(await run(...args)).toMatchObject({ code: 2, stderr: expect.stringContaining(message) });
  });
});
