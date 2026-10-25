import { afterAll, describe, expect, test } from "vitest";
import { Simulation } from "../src/simulation.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const open: Simulation[] = [];
async function start(seed: number, epochMs = EPOCH): Promise<Simulation> {
  const sim = await Simulation.start({ seed, epochMs });
  open.push(sim);
  return sim;
}
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
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

  test("Math.random and crypto randomness are seeded streams", async () => {
    const [a, b, c] = await Promise.all([start(7), start(7), start(8)]);
    const [ra, rb, rc] = await Promise.all([a, b, c].map((sim) => sim.diagnostics.random(16)));
    expect(ra).toEqual(rb);
    expect(ra?.math).not.toEqual(rc?.math);
    expect(ra?.windowMath).not.toEqual(rc?.windowMath);
    expect(ra?.cryptoBytes).not.toEqual(rc?.cryptoBytes);
    expect(ra?.windowCryptoBytes).not.toEqual(rc?.windowCryptoBytes);
    expect(ra?.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("a crash rejects pending calls with the exit code and the stderr tail", async () => {
    const sim = await start(1);
    await expect(sim.diagnostics.crash(7, "simulated failure")).rejects.toThrow(
      /exited with code 7[\s\S]*simulated failure/,
    );
  });
});
