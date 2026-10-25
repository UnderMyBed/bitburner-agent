import { runSeed, type Simulation, startScenario } from "@bitburner-agent/sim";
import { afterEach, describe, expect, test } from "vitest";
import { BOOTSTRAP, baselineScenario } from "../src/baseline.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("the baseline scenario (smoke test; the full run is local, docs/sim/baselines.md)", () => {
  const open: Simulation[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((sim) => sim.close()));
  });

  test("starts as a fresh BN1 with SF4.3: the fork and the bootstrap on home, the bootstrap running", () => {
    const scenario = baselineScenario();
    expect(scenario.fixture).toEqual({ kind: "bitnode", n: 1, sourceFiles: { 4: 3 } });
    expect(scenario.homeRamGb).toBeUndefined();
    const home = (scenario.files?.home ?? {}) as Record<string, string>;
    expect(home["autopilot.js"]).toBeDefined();
    expect(home["bootstrap.js"]).toBe(BOOTSTRAP);
    expect(scenario.run).toEqual([{ script: "bootstrap.js" }]);
    expect(scenario.stopWhen).toEqual([{ event: "bitnodeDestroyed" }]);
  });

  test("the scripted early game fits in 8 GB and makes progress within a virtual hour", async () => {
    const result = await runSeed(baselineScenario({ durationMs: HOUR, checkpointEveryMs: HOUR }), 1);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.summary?.homeRamMax).toBe(8);
    expect(result.summary?.hackingLevel).toBeGreaterThan(1);
    expect(result.summary?.money).toBeGreaterThan(1000);
  }, 120_000);

  test("once home has the RAM the fork needs, the bootstrap hands over to the fork's autopilot", async () => {
    const sim = await startScenario(baselineScenario({ homeRamGb: 16 }), 1);
    open.push(sim);
    await sim.advance(MINUTE);
    const running = (await sim.ps("home")).map((p) => p.filename);
    expect(running).not.toContain("bootstrap.js");
    expect(running).toContain("autopilot.js");
  }, 120_000);
});
