// Core's game data and price rules (#193) against the engine: the generated augmentations, factions and BitNode
// multipliers (packages/core/src/augmentation-data.ts, faction-data.ts) are the game's own, field for field, and
// core's `augmentationCost` is the game's `getAugCost` for every augmentation, in states that exercise each rule.
import {
  AUGMENTATION_BITNODE_MULTIPLIERS,
  AUGMENTATIONS,
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  BITNODE_COUNT,
  FACTIONS,
  NEUROFLUX_GOVERNOR,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import type { BitNodeFixture, Fixture, GameNumber } from "../src/protocol.ts";
import type { Simulation } from "../src/simulation.ts";
import { runScript, useSimulations } from "./helpers/sim.ts";

const start = useSimulations();
const EPOCH = Date.UTC(2026, 0, 1);
const newGame = () => start({ seed: 1, epochMs: EPOCH, fixture: { kind: "new", tutorial: "skipped" } });
const REGENERATE = "core's game data differs from the engine's: rerun node packages/sim/scripts/generate-game-data.ts";
const number = (value: GameNumber) => (value === "Infinity" ? Number.POSITIVE_INFINITY : value);

test("every augmentation in core is the engine's, field for field, in the game's order", async () => {
  const { augmentations } = await (await newGame()).diagnostics.gameData();
  expect(Object.keys(AUGMENTATIONS), REGENERATE).toEqual(augmentations.map((augmentation) => augmentation.name));
  for (const { name, baseMoneyCost, baseRepCost, multipliers, ...rest } of augmentations) {
    const core = AUGMENTATIONS[name];
    const random = name === "Unstable Circadian Modulator";
    expect(core, `${name}: ${REGENERATE}`).toEqual({
      baseMoneyCost: number(baseMoneyCost),
      baseRepCost: number(baseRepCost),
      // Drawn by the game's clock: the engine has one of its seven sets, core none.
      multipliers: random ? {} : multipliers,
      ...rest,
      ...(random ? { randomMultipliers: true } : {}),
    });
    if (random) expect(Object.keys(multipliers).length).toBeGreaterThan(0);
  }
  // The rules' cases are there: never sold, free, special, a starting bonus.
  expect(AUGMENTATIONS["BigD's Big ... Brain"]).toMatchObject({ baseMoneyCost: Infinity, baseRepCost: Infinity });
  expect(AUGMENTATIONS["The Red Pill"]).toMatchObject({ baseMoneyCost: 0, baseRepCost: 2.5e6, isSpecial: true });
  expect(AUGMENTATIONS[NEUROFLUX_GOVERNOR]?.isSpecial).toBe(true);
  expect(AUGMENTATIONS["CashRoot Starter Kit"]).toMatchObject({ startingMoney: 1e6, programs: ["BruteSSH.exe"] });
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

const bitNode = (n: number, sourceFiles: Record<number, number> = {}): BitNodeFixture => ({
  kind: "bitnode",
  n,
  sourceFiles,
});

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
