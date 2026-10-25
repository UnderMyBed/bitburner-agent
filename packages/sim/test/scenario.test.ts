import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { formatRun } from "../src/scenario/report.ts";
import { aggregate, defaultWorkers, distribution, runScenario, type SeedResult } from "../src/scenario/run.ts";
import { loadScenario, type Scenario, scenarioSeeds, validateScenario } from "../src/scenario/spec.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIOS = path.join(REPO_ROOT, "packages/sim/scenarios");
const scratch = mkdtempSync(path.join(tmpdir(), "sim-scenarios-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const lean = (extra: Partial<Scenario> = {}): Scenario => ({
  name: "lean test",
  fixture: { kind: "new", tutorial: "skipped" },
  epochMs: EPOCH,
  files: { home: { "hack.js": readFileSync(path.join(SCENARIOS, "lean/hack.js"), "utf8") } },
  run: [{ script: "hack.js", threads: 3 }],
  durationMs: 10 * MINUTE,
  ...extra,
});

/** A result without what real time decides. */
const deterministic = ({ wallMs, speed, ...rest }: SeedResult) => rest;

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
    [{ ...lean(), durationMs: 0 }, /durationMs/],
    [{ ...lean(), checkpointEveryMs: -5 }, /checkpointEveryMs/],
    [{ ...lean(), files: { home: { "a.js": 3 } } }, /files.home/],
    [{ ...lean(), run: [{ threads: 2 }] }, /run\[0\]/],
    [{ ...lean(), seeds: [] }, /seeds/],
    [{ ...lean(), seeds: { from: 5, to: 2 } }, /seeds/],
    [{ ...lean(), homeRamGb: 100 }, /homeRamGb: home RAM must be a power of 2/],
    [{ ...lean(), stopWhen: [{ event: "nope" }] }, /stop on event/],
    [{ ...lean(), onBitVerse: { enter: 0 } }, /onBitVerse/],
  ])("refuses %o", (scenario, message) => {
    expect(() => validateScenario(scenario)).toThrow(message);
  });

  test("the scenario files in the repository are valid", () => {
    const files = readdirSync(SCENARIOS).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["batch.json", "heavy.json", "lean.json"]);
    for (const file of files) expect(() => loadScenario(path.join(SCENARIOS, file))).not.toThrow();
  });
});

describe("aggregates", () => {
  test("distribution: min, median, 90th percentile by nearest rank, max", () => {
    expect(distribution([])).toBe(null);
    expect(distribution([7])).toEqual({ min: 7, median: 7, p90: 7, max: 7 });
    expect(distribution([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ min: 1, median: 5, p90: 9, max: 10 });
  });

  test("pass rate, time to stop over the stopped runs, speed over the runs that didn't fail", () => {
    const result = (r: Partial<SeedResult>): SeedResult => ({
      seed: 0,
      ok: true,
      stoppedBy: null,
      passed: true,
      virtualMs: 0,
      wallMs: 0,
      speed: 0,
      checkpoints: [],
      events: [],
      ...r,
    });
    expect(
      aggregate([
        result({ stoppedBy: 0, virtualMs: 100, speed: 50 }),
        result({ stoppedBy: 0, virtualMs: 300, speed: 30 }),
        result({ passed: false, virtualMs: 1000, speed: 40 }),
        result({ ok: false, passed: false, speed: 0 }),
      ]),
    ).toEqual({
      seeds: 4,
      passed: 2,
      passRate: 0.5,
      timeToStop: { min: 100, median: 100, p90: 300, max: 300 },
      speed: { min: 30, median: 40, p90: 50, max: 50 },
    });
  });

  test("the default pool is the machine's parallelism less a reserve, at least 1", () => {
    expect(defaultWorkers(2, 16)).toBe(14);
    expect(defaultWorkers(4, 16)).toBe(12);
    expect(defaultWorkers(2, 2)).toBe(1);
  });
});

describe("running scenarios", () => {
  test("each seed's result is the same with 1 worker or 4", async () => {
    const seeds = [1, 2, 3, 4];
    const [one, four] = [
      await runScenario(lean(), { seeds, workers: 1 }),
      await runScenario(lean(), { seeds, workers: 4 }),
    ];
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
    const [result] = (await runScenario(scenario, { seeds: [1], workers: 1 })).results;
    expect(result).toMatchObject({ ok: true, passed: true, stoppedBy: 0 });
    expect(result?.checkpoints.map((c) => c.virtualMs)).toEqual([MINUTE, 2 * MINUTE, result?.virtualMs]);
    expect(result?.virtualMs).toBeGreaterThanOrEqual(150_000);
    expect(result?.virtualMs).toBeLessThan(151_000);
  });

  test("a scenario with stop conditions that ran out of time doesn't pass", async () => {
    const [result] = (await runScenario(lean({ stopWhen: [{ event: "bitnodeDestroyed" }] }), { seeds: [1] })).results;
    expect(result).toMatchObject({ ok: true, passed: false, stoppedBy: null, virtualMs: 10 * MINUTE });
  });

  test("a script that can't start fails the seed", async () => {
    const [result] = (await runScenario(lean({ run: [{ script: "missing.js" }] }), { seeds: [1] })).results;
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("couldn't start missing.js") });
  });

  test.each(["lean", "batch", "heavy"])("the %s workload starts and runs", async (name) => {
    const { scenario, baseDir } = loadScenario(path.join(SCENARIOS, `${name}.json`));
    const [result] = (await runScenario({ ...scenario, durationMs: MINUTE }, { seeds: [1], workers: 1, baseDir }))
      .results;
    expect(result).toMatchObject({ ok: true, passed: true });
    expect(result?.summary?.scripts).toBeGreaterThan(0);
  });
});

describe("the CLI", () => {
  const cli = path.join(REPO_ROOT, "packages/sim/scripts/run-scenario.ts");
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { cwd: REPO_ROOT }).then(
      ({ stdout }) => ({ code: 0, stdout, stderr: "" }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );

  test("runs a scenario file, prints the table and writes JSON; files and saves are relative to it", async () => {
    const dir = path.join(scratch, "cli");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/hack.js"), readFileSync(path.join(SCENARIOS, "lean/hack.js")));
    writeFileSync(
      path.join(dir, "s.json"),
      JSON.stringify({ ...lean(), files: { home: "scripts" }, durationMs: MINUTE, seeds: [9] }),
    );
    const out = path.join(dir, "out.json");
    const { code, stdout } = await run(path.join(dir, "s.json"), "--seeds", "1..2", "--workers", "2", "--json", out);
    expect(code).toBe(0);
    expect(stdout).toContain("seed  result");
    expect(stdout).toContain("passed: 2/2 (100%)");
    const written = JSON.parse(readFileSync(out, "utf8")) as Awaited<ReturnType<typeof runScenario>>;
    expect(written.results.map((r) => r.seed)).toEqual([1, 2]);
    expect(formatRun(written)).toBe(stdout.trimEnd());
  });

  test("bad usage exits 2 with a message", async () => {
    expect(await run()).toMatchObject({ code: 2, stderr: expect.stringContaining("usage") });
    expect(await run(path.join(scratch, "missing.json"))).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("can't read scenario"),
    });
  });
});
