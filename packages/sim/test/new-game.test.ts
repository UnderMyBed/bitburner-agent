import { afterAll, describe, expect, test } from "vitest";
import { type Fixture, Simulation } from "../src/simulation.ts";

const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3600_000;
const open: Simulation[] = [];
async function newGame(seed: number, tutorial: "running" | "skipped" = "skipped"): Promise<Simulation> {
  const sim = await Simulation.start({ seed, epochMs: EPOCH, fixture: { kind: "new", tutorial } });
  open.push(sim);
  return sim;
}
afterAll(async () => {
  await Promise.all(open.map((sim) => sim.close()));
});

describe("new-game fixture", () => {
  test("boots a fresh game (bundle load + boot timed)", async () => {
    const started = performance.now();
    const sim = await newGame(1);
    const bootMs = performance.now() - started;
    console.log(`bundle load + new-game boot: ${Math.round(bootMs)} ms`);
    expect(bootMs).toBeLessThan(2000);
    expect(await sim.summary()).toEqual({
      virtualMs: 0,
      playtimeMs: 0,
      bitNodeN: 1,
      bitNodeLevel: 1,
      sourceFiles: {},
      money: 1262, // 1000 + CONSTANTS.Donations (PlayerObject.ts)
      hackingLevel: 1,
      hackingExp: 0,
      homeRamUsed: 0,
      homeRamMax: 8,
      scripts: 0,
      augsInstalled: 0,
      augsQueued: 0,
    });
  });

  test("the game runs on the virtual clock: playtime follows advance", async () => {
    const sim = await newGame(1);
    await sim.advance(HOUR);
    const summary = await sim.summary();
    expect(summary.virtualMs).toBe(HOUR);
    expect(summary.playtimeMs).toBe(HOUR);
  });

  test("tutorial is required, and both values behave as specified", async () => {
    await expect(
      Simulation.start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new" } as unknown as Fixture }),
    ).rejects.toThrow(/tutorial/);
    const [running, skipped] = await Promise.all([newGame(1, "running"), newGame(1, "skipped")]);
    expect((await running.diagnostics.game()).tutorialRunning).toBe(true);
    expect((await skipped.diagnostics.game()).tutorialRunning).toBe(false);
  });

  test("the game sees the pinned default locale, whatever the machine's", async () => {
    const sim = await newGame(1);
    // On an en-US machine the default would match anyway, so also check the pin is in place.
    expect(await sim.diagnostics.game()).toMatchObject({ defaultLocale: "en-US", pinnedLocale: "en-US" });
  });

  test("without a fixture, the engine is loaded but no game is booted", async () => {
    const bare = await Simulation.start({ seed: 1, epochMs: EPOCH });
    open.push(bare);
    await expect(bare.summary()).rejects.toThrow(/no game is booted/);
  });
});

describe("determinism", () => {
  test("the same seed gives the same state after 6 virtual hours; another seed doesn't", async () => {
    const [a, b, c] = await Promise.all([newGame(11), newGame(11), newGame(12)]);
    await Promise.all([a, b, c].map((sim) => sim.advance(6 * HOUR)));
    const [ha, hb, hc] = await Promise.all([a, b, c].map((sim) => sim.stateHash()));
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
  });

  test("the result doesn't depend on the step size", async () => {
    const [whole, stepped] = await Promise.all([newGame(11), newGame(11)]);
    await whole.advance(6 * HOUR);
    for (let i = 0; i < 6 * 3600; i++) await stepped.advance(1000);
    expect(await stepped.stateHash()).toBe(await whole.stateHash());
  });

  test("the state hash changes when the game state changes", async () => {
    const sim = await newGame(11);
    const before = await sim.stateHash();
    expect(await sim.stateHash()).toBe(before); // hashing has no side effects
    await sim.advance(1000);
    expect(await sim.stateHash()).not.toBe(before);
  });
});
