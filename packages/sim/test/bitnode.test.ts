import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { enginePaths } from "../src/engine/paths.ts";
import { BITNODES, MAX_SF_LEVEL, MAX_SF12_LEVEL } from "../src/protocol.ts";
import type { Simulation, SimulationOptions } from "../src/simulation.ts";
import { decodeSave, diffPaths } from "./helpers/save-diff.ts";
import { editSave } from "./helpers/save-edit.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

// BitNode fixtures (`{ kind: "bitnode", n, sourceFiles }`): the game's own enterBitNode, from a new game.

const EPOCH = Date.UTC(2026, 0, 1);
const start = useSimulations();
const bitNode = (n: number, sourceFiles: Record<number, number> = {}, seed = 4) =>
  start({ seed, epochMs: EPOCH, fixture: { kind: "bitnode", n, sourceFiles } });

/**
 * What entering a BitNode sets: the whole player and home server as saved, with the BitNode's level and multipliers
 * (which the game computes rather than saves).
 */
async function state(sim: Simulation) {
  // biome-ignore lint/suspicious/noExplicitAny: a decoded save is untyped JSON.
  const save: Record<string, any> = decodeSave(await sim.save());
  const { bitNodeLevel } = await sim.summary();
  return {
    player: save.PlayerSave.data,
    home: save.AllServersSave.home.data,
    bitNodeLevel,
    bitNodeMultipliers: (await sim.diagnostics.game()).bitNodeMultipliers,
  };
}

/** What a script costs to run, by the game's own RAM calculator. */
async function scriptRam(sim: Simulation, body: string): Promise<number> {
  await sim.writeFile("home", "costed.js", `export async function main(ns) { ${body} }`);
  const { out } = await runScript(sim, `out(ns.getScriptRam("costed.js"));`);
  return out[0] as number;
}
/** What one Singularity function adds to a script's RAM. */
const singularityRam = async (sim: Simulation) =>
  (await scriptRam(sim, "ns.singularity.getOwnedAugmentations();")) - (await scriptRam(sim, ""));

describe("BitNode fixtures", () => {
  test("BN1 with no Source-Files is a fresh game", async () => {
    const fresh = await start({ seed: 4, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
    const fixture = await bitNode(1);
    // The prestige stamps the time (prestigeAugmentation sets lastUpdate); a fresh game does on its first cycle.
    expect(diffPaths(await state(fixture), await state(fresh))).toEqual(["player.lastUpdate"]);
    expect(await fixture.summary()).toMatchObject({ bitNodeN: 1, bitNodeLevel: 1, sourceFiles: {} });
    expect(await fixture.diagnostics.game()).toMatchObject({ page: "Terminal", tutorialRunning: false });
  });

  test("BN1 with SF4.3: Singularity costs no more RAM than in BN4; without SF4 it costs 16x", async () => {
    // The 16x is the game's penalty below SF4.2 (Netscript/RamCostGenerator.ts SF4Cost); BN4 has none.
    const [plain, withSf4, bn4] = await Promise.all([bitNode(1), bitNode(1, { 4: 3 }), bitNode(4)]);
    const bn4Cost = await singularityRam(bn4);
    expect(await singularityRam(withSf4)).toBe(bn4Cost);
    expect(await singularityRam(plain)).toBeCloseTo(16 * bn4Cost);
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

  test("the level is the BitNode's own Source-File + 1, capped at 3", async () => {
    expect(await (await bitNode(4, { 4: 2 })).summary()).toMatchObject({ bitNodeN: 4, bitNodeLevel: 3 });
    expect(await (await bitNode(4, { 4: 3 })).summary()).toMatchObject({ bitNodeN: 4, bitNodeLevel: 3 });
  });

  test("BN12 has no level cap, and its multipliers follow the level", async () => {
    // BitNode 12 is the only one whose multipliers depend on the level (BitNode.tsx getBitNodeMultipliers).
    const sim = await bitNode(12, { 12: 49 });
    expect(await sim.summary()).toMatchObject({ bitNodeN: 12, bitNodeLevel: 50 });
    const multipliers = (await sim.diagnostics.game()).bitNodeMultipliers;
    expect(multipliers).toEqual(await sim.diagnostics.bitNodeMultipliers(12, 50));
    expect(multipliers).not.toEqual(await sim.diagnostics.bitNodeMultipliers(12, 1));
  });

  test.each([
    // [fixture n, fixture Source-Files, destroyed BitNode d, Source-Files before destroying d]
    [4, { 1: 1 }, 1, {}],
    [1, { 4: 3 }, 4, { 4: 2 }],
    [2, { 10: 1 }, 10, {}], // sleeves, which entering a BitNode grants with SF10
    [12, { 12: 3 }, 12, { 12: 2 }], // NeuroFlux Governor levels from SF12
    [9, { 9: 3 }, 9, { 9: 2 }], // home RAM and a hacknet server from SF9
  ])("BN%i with %o equals destroying BN%i through the BitVerse portal", async (n, sourceFiles, destroyed, before) => {
    const fixture = await bitNode(n, sourceFiles);
    const reference = await bitNode(destroyed, before);
    await reference.diagnostics.destroyBitNode(n);
    expect(diffPaths(await state(fixture), await state(reference))).toEqual([]);
  });

  test("with SF5, a real destroy adds 300 intelligence exp, which the fixture doesn't: the only difference", async () => {
    const fixture = await bitNode(2, { 5: 1 });
    const reference = await bitNode(5);
    await reference.diagnostics.destroyBitNode(2);
    const [fixtureState, referenceState] = [await state(fixture), await state(reference)];
    expect(diffPaths(fixtureState, referenceState).sort()).toEqual([
      "player.exp.intelligence",
      "player.persistentIntelligenceData.exp",
      "player.skills.intelligence",
    ]);
    expect(referenceState.player.exp.intelligence - fixtureState.player.exp.intelligence).toBe(300);
  });

  test("entering BN6 leaves the Bladeburner cinematic, as clicking Continue does", async () => {
    const sim = await bitNode(6);
    expect(await sim.diagnostics.game()).toMatchObject({ page: "Terminal" });
    expect((await sim.summary()).bitNodeN).toBe(6);
  });

  test("Bladeburner actions progress over virtual time (its page check sees the headless router)", async () => {
    // Joining the Bladeburners needs 100 in each combat stat, which only a save edit reaches quickly, so the BN6
    // fixture's save is edited and reloaded; the scripts need more RAM than a new home has.
    const save = editSave(await (await bitNode(6)).save(), ({ PlayerSave, AllServersSave }) => {
      AllServersSave.home.data.maxRam = 1024;
      for (const stat of ["strength", "defense", "dexterity", "agility"]) PlayerSave.data.exp[stat] = 1e6;
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

  test("a BitNode entry that fails (the game goes into recovery mode) fails loudly", async () => {
    const sim = await bitNode(1);
    await expect(sim.diagnostics.destroyBitNode(99)).rejects.toThrow(/Entering BitNode 99 failed: .*recovery mode/);
  });

  test.each([
    [{ n: 0, sourceFiles: {} }, /n in 1-15/],
    [{ n: 16, sourceFiles: {} }, /n in 1-15/],
    [{ n: 1.5, sourceFiles: {} }, /n in 1-15/],
    [{ n: 1, sourceFiles: { 16: 1 } }, /no Source-File "16"/],
    [{ n: 1, sourceFiles: { 4.5: 1 } }, /no Source-File "4.5"/],
    [{ n: 1, sourceFiles: { "04": 1 } }, /no Source-File "04"/],
    [{ n: 1, sourceFiles: { 4: 4 } }, /Source-File 4 level must be an integer from 1 to 3/],
    [{ n: 1, sourceFiles: { 4: 0 } }, /Source-File 4 level/],
    [{ n: 1, sourceFiles: { 4: 1.5 } }, /Source-File 4 level/],
    [{ n: 1, sourceFiles: { 12: MAX_SF12_LEVEL + 1 } }, /Source-File 12 level must be an integer from 1 to 1000000/],
    [{ n: 1, sourceFiles: [] }, /sourceFiles/],
  ])("refuses %o", async (fixture, message) => {
    const options = { seed: 1, epochMs: EPOCH, fixture: { kind: "bitnode", ...fixture } } as SimulationOptions;
    await expect(start(options)).rejects.toThrow(message);
  });

  test("the copied BitNode and Source-File limits still match the game's source", () => {
    const source = (file: string) => readFileSync(path.join(enginePaths.gameRoot, "src", file), "utf8");
    const validBitNodes = source("BitNode/Constants.ts").match(/validBitNodes = \[([^\]]*)\]/)?.[1];
    expect(validBitNodes?.split(",").map(Number)).toEqual(Array.from({ length: BITNODES }, (_, i) => i + 1));
    // giveSourceFile stops at level 3 for every Source-File but SF12's.
    expect(source("RedPill.tsx")).toContain(`if (lvl >= ${MAX_SF_LEVEL} && bitNodeNumber !== 12)`);
  });
});
