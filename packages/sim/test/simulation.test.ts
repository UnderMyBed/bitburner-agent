import { afterEach, describe, expect, test } from "vitest";
import { sfc32 } from "../src/host/rng.ts";
import { Simulation } from "../src/simulation.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const open: Simulation[] = [];
async function start(seed: number, epochMs = EPOCH): Promise<Simulation> {
  const sim = await Simulation.start({ seed, epochMs });
  open.push(sim);
  return sim;
}
// Each test's simulations close when it ends: a file's worth at once would crowd a CI runner's memory.
afterEach(async () => {
  await Promise.all(open.splice(0).map((sim) => sim.close()));
});

describe("Simulation (host environment, no game booted)", () => {
  test("the engine sees the virtual epoch when its modules load", async () => {
    const sim = await start(1);
    const clock = await sim.diagnostics.clock();
    expect(clock.engineLastUpdate).toBe(EPOCH); // Engine._lastUpdate is read from Date at module load
    expect(clock.engineDateNow).toBe(EPOCH);
    expect(await sim.now()).toBe(EPOCH);
  });

  test("advance moves virtual time exactly, as the engine sees it", async () => {
    const sim = await start(1);
    await sim.advance(1234);
    await sim.advance(5 * 3600_000);
    const expected = EPOCH + 1234 + 5 * 3600_000;
    expect(await sim.now()).toBe(expected);
    const clock = await sim.diagnostics.clock();
    expect(clock.engineDateNow).toBe(expected);
    expect(clock.enginePerformanceNow).toBe(1234 + 5 * 3600_000);
  });

  test("requests run one at a time, so a call made during an advance sees it finished", async () => {
    const sim = await start(1);
    const results = await Promise.all([sim.advance(3600_000), sim.now(), sim.advance(1000), sim.now()]);
    expect(results).toEqual([EPOCH + 3600_000, EPOCH + 3600_000, EPOCH + 3601_000, EPOCH + 3601_000]);
  });

  test("randomness in the host is the seeded stream, through every access path", async () => {
    const [a, b, c] = await Promise.all([start(7), start(7), start(8)]);
    const [ra, rb, rc] = await Promise.all([a, b, c].map((sim) => sim.diagnostics.random(16)));
    // The engine draws from Math.random while it loads, so the sample is a contiguous run further along sfc32(7);
    // window.Math is Node's Math, so its draws continue the same run.
    const stream = sfc32(7);
    const values = Array.from({ length: 100_000 }, () => stream());
    const offset = values.indexOf(ra?.math[0] ?? -1);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect([...(ra?.math ?? []), ...(ra?.windowMath ?? [])]).toEqual(values.slice(offset, offset + 32));
    expect(ra).toEqual(rb);
    expect(ra?.cryptoBytes).not.toEqual(rc?.cryptoBytes);
    expect(ra?.windowCryptoBytes).not.toEqual(rc?.windowCryptoBytes);
  });

  test("rejects invalid seeds, epochs and advances before reaching the host", async () => {
    await expect(Simulation.start({ seed: 2 ** 32, epochMs: EPOCH })).rejects.toThrow(/seed/);
    await expect(Simulation.start({ seed: -1, epochMs: EPOCH })).rejects.toThrow(/seed/);
    await expect(Simulation.start({ seed: 1, epochMs: 1.5 })).rejects.toThrow(/epochMs/);
    const sim = await start(1);
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      expect(() => sim.advance(ms)).toThrow(/advance/);
    }
    expect(await sim.now()).toBe(EPOCH);
  });

  test("the host validates its own options too, and reports why it couldn't start", async () => {
    await expect(Simulation.spawn({ seed: -1, epochMs: EPOCH })).rejects.toThrow(/failed to start[\s\S]*seed/);
  });

  test("a crash rejects pending calls with the exit code and the output tail", async () => {
    const sim = await start(1);
    await expect(sim.diagnostics.crash(7, "simulated failure")).rejects.toThrow(
      /exited with code 7[\s\S]*simulated failure/,
    );
  });

  test("measures the host's heap and profiles it, for benchmarks", async () => {
    const sim = await start(1);
    const heap = await sim.diagnostics.heap();
    expect(heap).toBeGreaterThan(1 * 2 ** 20);
    expect(heap).toBeLessThan(4 * 2 ** 30);
    await expect(sim.diagnostics.profile("stop")).rejects.toThrow(/no profile is running/);
    await sim.diagnostics.profile("start");
    await expect(sim.diagnostics.profile("start")).rejects.toThrow(/already running/);
    await sim.advance(3600_000);
    const profile = await sim.diagnostics.profile("stop");
    expect(profile?.nodes.length).toBeGreaterThan(0);
    expect(profile?.samples.length).toBe(profile?.timeDeltas.length);
    // Stopped: another can start.
    await sim.diagnostics.profile("start");
    expect(await sim.diagnostics.profile("stop")).not.toBeNull();
  });

  test("close rejects pending calls and can be called again", async () => {
    const sim = await start(1);
    const pending = sim.advance(24 * 3600_000);
    await sim.close();
    await expect(pending).rejects.toThrow(/Simulation process/);
    await expect(sim.close()).resolves.toBeUndefined();
    await expect(sim.now()).rejects.toThrow(/Simulation process/);
  });
});
