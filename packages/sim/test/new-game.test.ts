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
  test("boots a fresh game (bundle load + boot timed inside the host)", async () => {
    const started = performance.now();
    const sim = await newGame(1);
    const { bootMs } = await sim.diagnostics.game();
    console.log(
      `bundle load + new-game boot: ${bootMs} ms in the host (${Math.round(performance.now() - started)} ms with fork)`,
    );
    expect(bootMs).toBeLessThan(2000);
    expect((await sim.diagnostics.game()).autosaveInterval).toBe(0); // the harness snapshots instead
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

  test("hashing along the way doesn't change how the run turns out", async () => {
    // Serialising the save draws from Math.random (the game builds a throwaway PlayerObject); the host must undo it.
    const [hashed, plain] = await Promise.all([newGame(11), newGame(11)]);
    for (let i = 0; i < 36; i++) {
      await hashed.stateHash();
      await hashed.advance(10 * 60_000);
    }
    await plain.advance(6 * HOUR);
    expect(await hashed.stateHash()).toBe(await plain.stateHash());
  });

  test("the state hash changes when the game state changes", async () => {
    const sim = await newGame(11);
    const before = await sim.stateHash();
    await sim.advance(1000);
    expect(await sim.stateHash()).not.toBe(before);
  });

  test("seeded randomness drives the game: coding contracts follow the seed", async () => {
    const [a, b, c] = await Promise.all([newGame(11), newGame(11), newGame(12)]);
    await Promise.all([a, b, c].map((sim) => sim.advance(6 * HOUR)));
    const [ca, cb, cc] = await Promise.all([a, b, c].map(async (sim) => (await sim.diagnostics.game()).contracts));
    expect(ca?.length).toBeGreaterThan(0);
    expect(ca).toEqual(cb);
    expect(ca).not.toEqual(cc);
  });

  // Recorded on one machine and checked on every other (CI runs Linux): the state must not depend on the platform.
  test("the state is the same on every machine (golden hashes for seed 1)", async () => {
    const sim = await newGame(1);
    const atBoot = await sim.stateHash();
    await sim.advance(HOUR);
    expect({ atBoot, afterOneHour: await sim.stateHash() }).toMatchInlineSnapshot(`
      {
        "afterOneHour": "e43584f65c9c9056f8f1c182464970e7f228639503554f5392b9cd764731be04",
        "atBoot": "dd797305d1ea8220ac4405c6d3999ef55c9d2898914fb8716085dd03f857272f",
      }
    `);
  });
});
