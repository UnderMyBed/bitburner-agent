// Core's game data and price rules (#193) against the engine: the generated augmentations, factions and BitNode
// multipliers (packages/core/src/augmentation-data.ts, faction-data.ts) are the game's own, field for field, and
// core's `augmentationCost` is the game's `getAugCost` for every augmentation, in states that exercise each rule.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUGMENTATION_BITNODE_MULTIPLIERS,
  AUGMENTATIONS,
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  BITNODE_COUNT,
  FACTIONS,
  NEUROFLUX_GOVERNOR,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { enginePaths } from "../src/engine/paths.ts";
import type { BitNodeFixture, Fixture, GameNumber } from "../src/protocol.ts";
import type { Simulation } from "../src/simulation.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const EPOCH = Date.UTC(2026, 0, 1);
const newGame = () => start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const REGENERATE = "core's game data differs from the engine's: rerun node packages/sim/scripts/generate-game-data.ts";
const number = (value: GameNumber) => (value === "Infinity" ? Number.POSITIVE_INFINITY : value);

/** `enumName`'s members in the game's `file`, key to value. */
function gameEnumKeys(file: string, enumName: string): Record<string, string> {
  const source = readFileSync(path.join(enginePaths.gameRoot, "src", file), "utf8");
  const body = source.slice(source.indexOf(`export enum ${enumName}`));
  const members = body.slice(0, body.indexOf("}")).matchAll(/^\s+(\w+) = "([^"]+)",/gm);
  return Object.fromEntries([...members].map((match) => [match[1], match[2]]));
}

const bitNode = (n: number, sourceFiles: Record<number, number> = {}): BitNodeFixture => ({
  kind: "bitnode",
  n,
  sourceFiles,
});

test("every augmentation in core is the engine's, field for field, in the game's order", async () => {
  const { augmentations } = await (await newGame()).diagnostics.gameData();
  expect(Object.keys(AUGMENTATIONS), REGENERATE).toEqual(augmentations.map((augmentation) => augmentation.name));
  for (const { name, baseMoneyCost, baseRepCost, multipliers, startingMoney, ...rest } of augmentations) {
    const random = name === "Unstable Circadian Modulator";
    expect(AUGMENTATIONS[name], `${name}: ${REGENERATE}`).toEqual({
      baseMoneyCost: number(baseMoneyCost),
      baseRepCost: number(baseRepCost),
      // Drawn by the game's clock: the engine has one of its seven sets, core none.
      multipliers: random
        ? {}
        : Object.fromEntries(Object.entries(multipliers).map(([key, value]) => [key, number(value)])),
      startingMoney: number(startingMoney),
      ...rest,
      ...(random ? { randomMultipliers: true } : {}),
    });
    if (random) expect(Object.keys(multipliers).length).toBeGreaterThan(0);
  }
});

test("the fields no NS call shows, against the game's source: never sold, free, special, what an install gives", () => {
  // `isSpecial`, `startingMoney` and `programs` (`Augmentation/Augmentations.ts`), checked apart from the extractor.
  expect(AUGMENTATIONS["BigD's Big ... Brain"]).toMatchObject({ baseMoneyCost: Infinity, baseRepCost: Infinity });
  expect(AUGMENTATIONS["Z.O.Ë."]).toMatchObject({ baseMoneyCost: 1e12, baseRepCost: Infinity, factions: [] });
  expect(AUGMENTATIONS["The Red Pill"]).toMatchObject({ baseMoneyCost: 0, baseRepCost: 2.5e6, isSpecial: true });
  expect(AUGMENTATIONS[NEUROFLUX_GOVERNOR]?.isSpecial).toBe(true);
  expect(AUGMENTATIONS["EsperTech Bladeburner Eyewear"]?.isSpecial).toBe(true);
  expect(AUGMENTATIONS.BitWire?.isSpecial).toBe(false);
  expect(AUGMENTATIONS["CashRoot Starter Kit"]).toMatchObject({ startingMoney: 1e6, programs: ["BruteSSH.exe"] });
  expect(AUGMENTATIONS.PCMatrix).toMatchObject({ startingMoney: 0, programs: ["DeepscanV1.exe", "AutoLink.exe"] });
  expect(AUGMENTATIONS.BitWire?.multipliers).toEqual({ hacking: 1.05 });
  // keepOnInstall, from each faction's block in `Faction/FactionInfo.tsx`.
  const infos = readFileSync(path.join(enginePaths.gameRoot, "src/Faction/FactionInfo.tsx"), "utf8");
  const blocks = infos.split(/\[FactionName\.(\w+)\]: new FactionInfo\(/).slice(1);
  const keys = gameEnumKeys("Faction/Enums.ts", "FactionName");
  const kept = new Set<string>();
  for (let i = 0; i < blocks.length; i += 2) {
    if (/keepOnInstall: true/.test(blocks[i + 1] as string)) kept.add(keys[blocks[i] as string] as string);
  }
  expect(kept.size).toBeGreaterThan(0);
  expect(Object.keys(FACTIONS).filter((name) => FACTIONS[name]?.keepOnInstall)).toEqual(
    Object.keys(FACTIONS).filter((name) => kept.has(name)),
  );
});

test("every faction in core is the engine's: enemies, invitation requirements, work types, kept on install", async () => {
  const { factions } = await (await newGame()).diagnostics.gameData();
  expect(Object.keys(FACTIONS), REGENERATE).toEqual(factions.map((faction) => faction.name));
  for (const { name, ...faction } of factions) expect(FACTIONS[name], `${name}: ${REGENERATE}`).toEqual(faction);
  // Daedalus's, as A8 will read them: 30 augmentations in BN1, $100b, and hacking 2500 or combat 1500.
  expect(FACTIONS.Daedalus?.inviteRequirements.slice(0, 2)).toEqual([
    { type: "numAugmentations", numAugmentations: 30 },
    { type: "money", money: 100e9 },
  ]);
});

interface SingularityView {
  augmentations: Record<
    string,
    {
      baseMoneyCost: GameNumber;
      baseRepCost: GameNumber;
      factions: string[];
      prereqs: string[];
      multipliers: Record<string, number>;
    }
  >;
  factions: Record<string, { enemies: string[]; workTypes: string[]; inviteRequirements: unknown[]; shop: string[] }>;
}

/**
 * The game as Singularity reports it (SF4.3: no RAM penalty), an extractor apart from `gameData`: each augmentation's
 * base price, reputation, factions, prerequisites and multipliers, and each faction's enemies, work types, invitation
 * requirements and shop (`NetscriptFunctions/Singularity.ts`).
 */
async function singularityView(sim: Simulation): Promise<SingularityView> {
  await sim.diagnostics.setHomeRam(4096);
  const { out } = await runScript(
    sim,
    `const s = ns.singularity;
     const value = (x) => (Number.isFinite(x) ? x : "Infinity");
     const augmentations = Object.fromEntries(${JSON.stringify(Object.keys(AUGMENTATIONS))}.map((name) => [name, {
       baseMoneyCost: value(s.getAugmentationBasePrice(name)), baseRepCost: value(s.getAugmentationRepReq(name)),
       factions: s.getAugmentationFactions(name), prereqs: s.getAugmentationPrereq(name),
       multipliers: s.getAugmentationStats(name) }]));
     const factions = Object.fromEntries(${JSON.stringify(Object.keys(FACTIONS))}.map((name) => [name, {
       enemies: s.getFactionEnemies(name), workTypes: s.getFactionWorkTypes(name),
       inviteRequirements: s.getFactionInviteRequirements(name), shop: s.getAugmentationsFromFaction(name) }]));
     out({ augmentations, factions });`,
  );
  expect(out).toHaveLength(1);
  return out[0] as SingularityView;
}

test("core agrees with Singularity, an extractor apart from gameData: every augmentation, faction and shop", async () => {
  const sim = await start({ seed: 1, epochMs: EPOCH, fixture: bitNode(1, { 4: 3 }) });
  const view = await singularityView(sim);
  expect(Object.keys(view.augmentations)).toHaveLength(Object.keys(AUGMENTATIONS).length);
  for (const [name, { baseMoneyCost, baseRepCost, multipliers, ...lists }] of Object.entries(view.augmentations)) {
    const core = AUGMENTATIONS[name];
    expect(core, name).toMatchObject({
      baseMoneyCost: number(baseMoneyCost),
      baseRepCost: number(baseRepCost),
      ...lists,
    });
    if (name === "Unstable Circadian Modulator") continue;
    const notOne = Object.entries(multipliers).filter(([, value]) => value !== 1);
    expect(core?.multipliers, name).toEqual(Object.fromEntries(notOne));
  }
  for (const [name, { shop, ...faction }] of Object.entries(view.factions)) {
    expect(FACTIONS[name], name).toMatchObject(faction);
    expect(augmentationsSoldBy(name, 1, null), name).toEqual(shop);
  }
  // As A5 will read them: Slum Snakes and Tian Di Hui each offer two of the three kinds of work.
  expect(FACTIONS["Slum Snakes"]?.workTypes).toEqual(["field", "security"]);
  expect(FACTIONS["Tian Di Hui"]?.workTypes).toEqual(["hacking", "security"]);
});

test("augmentationsSoldBy in BN15 is the game's shop: Daedalus without The Red Pill", async () => {
  const sim = await start({ seed: 1, epochMs: EPOCH, fixture: bitNode(15, { 4: 3 }) });
  const { factions } = await singularityView(sim);
  for (const [name, { shop }] of Object.entries(factions))
    expect(augmentationsSoldBy(name, 15, null), name).toEqual(shop);
  expect(factions.Daedalus?.shop).not.toContain("The Red Pill");
  expect(augmentationsSoldBy("Daedalus", 1, null)).toContain("The Red Pill");
});

test("the BitNode multipliers on augmentations are the engine's, every BitNode at levels 1-3, BN12 at more", async () => {
  const sim = await newGame();
  const pick = ({ AugmentationMoneyCost, AugmentationRepCost, DaedalusAugsRequirement }: Record<string, number>) => ({
    AugmentationMoneyCost,
    AugmentationRepCost,
    DaedalusAugsRequirement,
  });
  expect(Object.keys(AUGMENTATION_BITNODE_MULTIPLIERS).map(Number)).toEqual(
    Array.from({ length: BITNODE_COUNT }, (_, i) => i + 1),
  );
  for (let n = 1; n <= BITNODE_COUNT; n++) {
    for (const level of n === 12 ? [1, 2, 3, 4, 10, 50, 115, 116, 117, 500] : [1, 2, 3]) {
      // The level is the BitNode's own Source-File + 1 (`initBitNodeMultipliers`).
      const ownedSF = level > 1 ? { [n]: level - 1 } : {};
      expect(augmentationBitNodeMultipliers(n, ownedSF), `BN${n}.${level}`).toEqual(
        pick(await sim.diagnostics.bitNodeMultipliers(n, level)),
      );
    }
  }
});

/** What the brain sees of the run, from `ns.getResetInfo()` (the slow snapshot's `resetInfo`). */
async function resetInfo(sim: Simulation) {
  const { out } = await runScript(
    sim,
    `const info = ns.getResetInfo();
     out({ currentNode: info.currentNode, ownedAugs: Object.fromEntries(info.ownedAugs),
           ownedSF: Object.fromEntries(info.ownedSF) });`,
  );
  return out[0] as { currentNode: number; ownedAugs: Record<string, number>; ownedSF: Record<string, number> };
}

/** Every augmentation's price by core, from what the brain sees, against the game's `getAugCost`: the differences. */
async function priceDifferences(sim: Simulation, queued: string[]): Promise<string[]> {
  const { currentNode, ownedAugs, ownedSF } = await resetInfo(sim);
  const state: AugmentationPurchaseState = {
    installed: ownedAugs,
    queued,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  const game = await sim.diagnostics.augmentationCosts();
  expect(Object.keys(game)).toEqual(Object.keys(AUGMENTATIONS));
  return Object.entries(game).flatMap(([name, { moneyCost, repCost }]) => {
    const core = augmentationCost(name, state);
    const expected = { money: number(moneyCost), reputation: number(repCost) };
    return Object.is(core.money, expected.money) && Object.is(core.reputation, expected.reputation)
      ? []
      : [`${name}: core ${JSON.stringify(core)}, game ${JSON.stringify(expected)}`];
  });
}

/** Queued one by one, each price checked after each: SoA's among them (they don't count), NeuroFlux Governor twice. */
const QUEUE = [
  "Neurotrainer I",
  "SoA - Beauty of Aphrodite",
  NEUROFLUX_GOVERNOR,
  "CashRoot Starter Kit",
  NEUROFLUX_GOVERNOR,
  "SoA - Might of Ares",
  "BitWire",
];

test.each<[string, Fixture]>([
  ["a new BN1", { kind: "new", tutorial: "skipped" }],
  ["BN1 with SF11.1 and SF12.3 (NeuroFlux Governor installed at level 3)", bitNode(1, { 11: 1, 12: 3 })],
  ["BN1 with SF11.2", bitNode(1, { 11: 2 })],
  ["BN1 with SF11.3", bitNode(1, { 11: 3 })],
  ["BN3 (money and reputation × 3)", bitNode(3)],
  ["BN10 (money × 5, reputation × 2)", bitNode(10)],
  ["BN12 at level 5 (× 1.02^5), its NeuroFlux Governor at level 4", bitNode(12, { 12: 4 })],
])("every augmentation's price is the game's: %s, as augmentations are installed and queued", async (_, fixture) => {
  const sim = await start({ seed: 1, epochMs: EPOCH, fixture });
  const queued: string[] = [];
  expect(await priceDifferences(sim, queued), "fresh").toEqual([]);
  // Installed: one of Shadows of Anarchy's (n counts it), and NeuroFlux Governor unless SF12 gave it levels.
  await sim.diagnostics.giveInstalledAugmentation("SoA - Wisdom of Athena");
  if ((await resetInfo(sim)).ownedAugs[NEUROFLUX_GOVERNOR] === undefined) {
    await sim.diagnostics.giveInstalledAugmentation(NEUROFLUX_GOVERNOR);
  }
  expect(await priceDifferences(sim, queued), "installed").toEqual([]);
  for (const name of QUEUE) {
    await sim.diagnostics.queueAugmentation(name);
    queued.push(name);
    expect(await priceDifferences(sim, queued), `queued ${queued.join(", ")}`).toEqual([]);
  }
  // The states were what they claim: a price grew with the queue, and NeuroFlux Governor's with its level.
  const { ownedSF, currentNode, ownedAugs } = await resetInfo(sim);
  const state = {
    installed: ownedAugs,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  expect(augmentationCost("BitWire", { ...state, queued }).money).toBeGreaterThan(
    augmentationCost("BitWire", { ...state, queued: [] }).money * 1.7 ** 5,
  );
  expect(ownedAugs[NEUROFLUX_GOVERNOR]).toBe(fixture.kind === "bitnode" ? (fixture.sourceFiles[12] ?? 1) : 1);
});
