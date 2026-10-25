import { describe, expect, test } from "vitest";
import type { Simulation, SimulationOptions } from "../src/simulation.ts";
import { decodeSave } from "./helpers/save-diff.ts";
import { editSave } from "./helpers/save-edit.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

// BitNode fixtures (`{ kind: "bitnode", n, sourceFiles }`): the game's own enterBitNode, from a new game.

const EPOCH = Date.UTC(2026, 0, 1);
const start = useSimulations();
const bitNode = (n: number, sourceFiles: Record<number, number> = {}, seed = 4) =>
  start({ seed, epochMs: EPOCH, fixture: { kind: "bitnode", n, sourceFiles } });

// biome-ignore lint/suspicious/noExplicitAny: a decoded save is untyped JSON.
type Save = Record<string, any>;

/** The fields #29 compares between a fixture and the game's real destroy flow. */
async function state(sim: Simulation) {
  const save: Save = decodeSave(await sim.save());
  const player = save.PlayerSave.data;
  const summary = await sim.summary();
  return {
    sourceFiles: summary.sourceFiles,
    bitNodeN: summary.bitNodeN,
    bitNodeLevel: summary.bitNodeLevel,
    bitNodeMultipliers: (await sim.diagnostics.game()).bitNodeMultipliers,
    homeRam: summary.homeRamMax,
    money: summary.money,
    augmentations: player.augmentations,
    factions: player.factions,
    intelligenceExp: player.exp.intelligence,
  };
}

/** What a script calling one Singularity function costs to run, by the game's own RAM calculator. */
async function singularityScriptRam(sim: Simulation): Promise<number> {
  await sim.writeFile("home", "sing.js", "export async function main(ns) { ns.singularity.getOwnedAugmentations(); }");
  const { out } = await runScript(sim, `out(ns.getScriptRam("sing.js"));`);
  return out[0] as number;
}

describe("BitNode fixtures", () => {
  test("BN1 with no Source-Files is a fresh game", async () => {
    const fresh = await start({ seed: 4, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
    const fixture = await bitNode(1);
    expect(await state(fixture)).toEqual(await state(fresh));
    expect(await state(fixture)).toMatchObject({ bitNodeN: 1, bitNodeLevel: 1, sourceFiles: {} });
    expect(await fixture.diagnostics.game()).toMatchObject({ page: "Terminal", tutorialRunning: false });
  });

  test("BN1 with SF4.3: Singularity costs no more RAM than in BN4; without SF4 it costs 16x", async () => {
    const [plain, withSf4, bn4] = await Promise.all([bitNode(1), bitNode(1, { 4: 3 }), bitNode(4)]);
    const base = 1.6; // every script's own cost
    const plainRam = await singularityScriptRam(plain);
    const sf4Ram = await singularityScriptRam(withSf4);
    const bn4Ram = await singularityScriptRam(bn4);
    expect(sf4Ram).toBe(bn4Ram);
    expect(plainRam - base).toBeCloseTo(16 * (bn4Ram - base));
    expect((await withSf4.summary()).sourceFiles).toEqual({ 4: 3 });
  });

  test("BN4 with SF1.1 runs at level 1, with the game's own multipliers for it", async () => {
    const sim = await bitNode(4, { 1: 1 });
    expect(await sim.summary()).toMatchObject({ bitNodeN: 4, bitNodeLevel: 1, sourceFiles: { 1: 1 } });
    expect((await sim.diagnostics.game()).bitNodeMultipliers).toEqual(await sim.diagnostics.bitNodeMultipliers(4, 1));
    // And not some other BitNode's: BN4's differ from BN1's.
    expect((await sim.diagnostics.game()).bitNodeMultipliers).not.toEqual(
      await sim.diagnostics.bitNodeMultipliers(1, 1),
    );
  });

  test("the level comes from the BitNode's own Source-File: SF4.2 makes BN4 level 3", async () => {
    const sim = await bitNode(4, { 4: 2 });
    expect(await sim.summary()).toMatchObject({ bitNodeN: 4, bitNodeLevel: 3 });
    expect((await sim.diagnostics.game()).bitNodeMultipliers).toEqual(await sim.diagnostics.bitNodeMultipliers(4, 3));
  });

  test.each([
    // [fixture n, fixture Source-Files, destroyed BitNode d, Source-Files before destroying d]
    [4, { 1: 1 }, 1, {}],
    [1, { 4: 3 }, 4, { 4: 2 }],
  ])("BN%i with %o equals destroying BN%i through the BitVerse portal", async (n, sourceFiles, destroyed, before) => {
    const fixture = await bitNode(n, sourceFiles);
    const reference = await bitNode(destroyed, before);
    await reference.diagnostics.enterBitNode(n); // the portal's call: grants SF `destroyed` one level up
    expect(await state(fixture)).toEqual(await state(reference));
  });

  test("entering BN6 leaves the Bladeburner cinematic, as clicking Continue does", async () => {
    const sim = await bitNode(6);
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Terminal" });
    expect((await sim.summary()).bitNodeN).toBe(6);
  });

  test("Bladeburner actions progress over virtual time (its page check sees the headless router)", async () => {
    // Joining the Bladeburners needs 100 in each combat stat; Singularity starts the action.
    const save = editSave(await (await bitNode(6, { 4: 3 })).save(), ({ PlayerSave, AllServersSave }) => {
      AllServersSave.home.data.maxRam = 1024;
      for (const stat of ["strength", "defense", "dexterity", "agility"]) PlayerSave.data.exp[stat] = 1e6;
      PlayerSave.data.money = 1e9;
    });
    const sim = await start({ seed: 4, fixture: { kind: "save", bytes: save } });
    const { out } = await runScript(
      sim,
      `out(ns.bladeburner.joinBladeburnerDivision());
       out(ns.bladeburner.startAction("General", "Training"));
       await ns.sleep(10_000);
       out(ns.bladeburner.getCurrentAction()?.name);
       out(ns.bladeburner.getActionCurrentTime());`,
      11_000,
    );
    expect(out.slice(0, 3)).toEqual([true, true, "Training"]);
    expect(out[3]).toBeGreaterThan(5_000); // ms of the action done: Bladeburner.process ran
  });

  test("the same seed gives the same state", async () => {
    const [a, b] = await Promise.all([bitNode(2, { 1: 3 }, 7), bitNode(2, { 1: 3 }, 7)]);
    await Promise.all([a.advance(60_000), b.advance(60_000)]);
    expect(await a.stateHash()).toBe(await b.stateHash());
  });

  test.each([
    [{ n: 0, sourceFiles: {} }, /n in 1-15/],
    [{ n: 16, sourceFiles: {} }, /n in 1-15/],
    [{ n: 1, sourceFiles: { 16: 1 } }, /no Source-File 16/],
    [{ n: 1, sourceFiles: { 4: 4 } }, /Source-File 4 level must be an integer from 1 to 3/],
    [{ n: 1, sourceFiles: { 4: 0 } }, /Source-File 4 level/],
    [{ n: 1, sourceFiles: [] }, /sourceFiles/],
  ])("refuses %o", async (fixture, message) => {
    const options = { seed: 1, epochMs: EPOCH, fixture: { kind: "bitnode", ...fixture } } as SimulationOptions;
    await expect(start(options)).rejects.toThrow(message);
  });

  test("SF12 has no level cap", async () => {
    const sim = await bitNode(12, { 12: 49 });
    expect(await sim.summary()).toMatchObject({ bitNodeN: 12, bitNodeLevel: 50 });
  });
});
