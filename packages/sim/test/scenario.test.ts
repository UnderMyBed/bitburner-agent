import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { formatRun } from "../src/scenario/report.ts";
import { aggregate, defaultWorkers, distribution, runScenario, type SeedResult } from "../src/scenario/run.ts";
import { loadScenario, type Scenario, scenarioSeeds, validateScenario } from "../src/scenario/spec.ts";
import { Simulation } from "../src/simulation.ts";
import { withBitNodeFinished } from "./helpers/save-edit.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
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
      ({ stdout }) => ({ code: 0, stdout, stderr: "" }),
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
  ])("refuses %o, exiting 2", async (args, message) => {
    expect(await run(...args)).toMatchObject({ code: 2, stderr: expect.stringContaining(message) });
  });
});
