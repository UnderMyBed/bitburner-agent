import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runSeed, type Simulation, startScenario } from "@bitburner-agent/sim";
import { afterEach, describe, expect, test } from "vitest";
import { baselineScenario, CHECKPOINTS_MS } from "../src/baseline.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("the baseline scenario (smoke tests; the full run isn't in CI, docs/sim/baselines.md)", () => {
  const open: Simulation[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((sim) => sim.close()));
  });

  test("starts in BN1 with SF1.1 and SF4.3, the fork on home, running autopilot.js --disable-casino", () => {
    const scenario = baselineScenario();
    expect(scenario.fixture).toEqual({ kind: "bitnode", n: 1, sourceFiles: { 1: 1, 4: 3 } });
    expect(scenario.homeRamGb).toBeUndefined();
    const home = (scenario.files?.home ?? {}) as Record<string, string>;
    expect(home["autopilot.js"]).toBeDefined();
    expect(home["daemon.js"]).toBeDefined();
    expect(scenario.run).toEqual([{ script: "autopilot.js", args: ["--disable-casino"] }]);
    // 12 virtual hours, a checkpoint every 4, and no stop condition (ADR 0011).
    expect(CHECKPOINTS_MS).toEqual([4 * HOUR, 8 * HOUR, 12 * HOUR]);
    expect(scenario.durationMs).toBe(12 * HOUR);
    expect(scenario.checkpointEveryMs).toBe(4 * HOUR);
    expect(scenario.stopWhen).toBeUndefined();
    expect(scenario.onBitVerse).toBeUndefined();
    expect(scenario.seeds).toEqual({ from: 1, to: 8 });
  });

  test("SF1 starts home at 32 GB, and the fork runs unattended: its Singularity managers start", async () => {
    const sim = await startScenario(baselineScenario(), 1);
    open.push(sim);
    expect((await sim.summary()).homeRamMax).toBe(32);
    await sim.advance(5 * MINUTE);
    const running = (await sim.ps("home")).map((p) => p.filename);
    expect(running).toContain("autopilot.js");
    // daemon.js keeps running only with room on home; work-for-factions.js needs SF4 (daemon.js:384-386).
    expect(running).toContain("daemon.js");
    expect(running).toContain("work-for-factions.js");
  }, 120_000);

  test("the fork makes progress within a virtual hour", async () => {
    const result = await runSeed(baselineScenario({ durationMs: HOUR, checkpointEveryMs: HOUR }), 1);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.summary?.hackingLevel).toBeGreaterThan(1);
    expect(result.summary?.money).toBeGreaterThan(1000);
  }, 120_000);
});

describe("npm run baseline", () => {
  const cli = path.resolve(import.meta.dirname, "../scripts/baseline.ts");
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, ...args], { encoding: "utf8" }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
    );

  test.each([
    ["a positional argument", ["extra"], /usage: npm run baseline/],
    ["seeds out of order", ["--seeds", "5..3"], /--seeds/],
    ["no workers", ["--workers", "0"], /--workers/],
  ])("refuses %s with exit 2, before running anything", async (_, args, message) => {
    const { code, stderr } = await run(...args);
    expect(code).toBe(2);
    expect(stderr).toMatch(message);
  });
});
