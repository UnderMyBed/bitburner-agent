// Augmentation data and the game's price rules (#193). The engine checks the data and every price in
// packages/sim/test/game-data.test.ts; here, the constants against the game's source, worked examples of each rule,
// and bad input refused.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AUGMENTATION_BITNODE_MULTIPLIERS, AUGMENTATIONS } from "../src/augmentation-data.ts";
import {
  AUGMENTATION_NAMES,
  AUGMENTATION_PRICE_GROWTH,
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationPriceGrowth,
  augmentationsSoldBy,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  NEUROFLUX_LEVEL_GROWTH,
  purchaseSequenceCost,
  SHADOWS_OF_ANARCHY_AUGMENTATIONS,
  SHADOWS_OF_ANARCHY_MONEY_GROWTH,
  SHADOWS_OF_ANARCHY_REPUTATION_GROWTH,
  SOURCE_FILE_11_PRICE_GROWTH_DISCOUNT,
} from "../src/augmentations.ts";
import { FACTIONS } from "../src/faction-data.ts";
import { daedalusAugmentationsRequired, FACTION_ENEMIES, FACTION_NAMES } from "../src/factions.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A new BN1: nothing installed or queued, no SF11, the multipliers 1. */
const BN1: AugmentationPurchaseState = {
  installed: {},
  queued: [],
  sourceFile11Level: 0,
  bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
};
const BITWIRE = { money: 10e6, reputation: 3.75e3 }; // `Augmentations.ts`: BitWire's base costs

describe("the game's constants", () => {
  test("the price's growth, NeuroFlux Governor's and Shadows of Anarchy's are the game's (`Constants.ts`)", () => {
    const constants = gameSource("Constants.ts");
    expect(constants).toContain(`MultipleAugMultiplier: ${AUGMENTATION_PRICE_GROWTH},`);
    expect(constants).toContain(`NeuroFluxGovernorLevelMult: ${NEUROFLUX_LEVEL_GROWTH},`);
    expect(constants).toContain(`SoACostMult: ${SHADOWS_OF_ANARCHY_MONEY_GROWTH},`);
    expect(constants).toContain(`SoARepMult: ${SHADOWS_OF_ANARCHY_REPUTATION_GROWTH},`);
  });

  test("SF11's discount and Shadows of Anarchy's augmentations are the game's (`AugmentationHelpers.ts`)", () => {
    const helpers = gameSource("Augmentation/AugmentationHelpers.ts");
    expect(helpers).toContain(
      `CONSTANTS.MultipleAugMultiplier * [${SOURCE_FILE_11_PRICE_GROWTH_DISCOUNT.join(", ")}][Player.activeSourceFileLvl(11)]`,
    );
    const enumSource = gameSource("Augmentation/Enums.ts");
    const soaKeys = [...(/soaAugmentationNames = \[([^\]]+)\]/.exec(helpers)?.[1] ?? "").matchAll(/\.(\w+)/g)];
    expect(soaKeys.map(([, key]) => new RegExp(`^\\s+${key} = "([^"]+)"`, "m").exec(enumSource)?.[1])).toEqual(
      SHADOWS_OF_ANARCHY_AUGMENTATIONS,
    );
  });
});

describe("the generated data", () => {
  test("every augmentation, by the game's names; its factions and prerequisites are the game's too", () => {
    expect(Object.keys(AUGMENTATIONS)).toEqual(AUGMENTATION_NAMES);
    for (const [name, augmentation] of Object.entries(AUGMENTATIONS)) {
      for (const faction of augmentation.factions) expect(FACTION_NAMES, name).toContain(faction);
      for (const prereq of augmentation.prereqs) expect(AUGMENTATION_NAMES, name).toContain(prereq);
    }
    expect(AUGMENTATIONS.BitWire).toMatchObject({
      baseMoneyCost: 10e6,
      baseRepCost: 3.75e3,
      multipliers: { hacking: 1.05 },
    });
  });

  test("every faction; the hand-written FACTION_ENEMIES (#147) agrees with its enemies", () => {
    expect(Object.keys(FACTIONS)).toEqual(FACTION_NAMES);
    const withEnemies = Object.entries(FACTIONS).filter(([, faction]) => faction.enemies.length > 0);
    expect(Object.fromEntries(withEnemies.map(([name, faction]) => [name, faction.enemies]))).toEqual(FACTION_ENEMIES);
    expect(FACTIONS.CyberSec).toMatchObject({ workTypes: ["hacking"], keepOnInstall: false });
    expect(FACTIONS.CyberSec?.inviteRequirements).toEqual([{ type: "backdoorInstalled", server: "CSEC" }]);
  });

  test("the BitNode multipliers on augmentations: a row for each BitNode", () => {
    expect(Object.keys(AUGMENTATION_BITNODE_MULTIPLIERS)).toHaveLength(15);
    expect(AUGMENTATION_BITNODE_MULTIPLIERS[1]).toEqual({
      AugmentationMoneyCost: 1,
      AugmentationRepCost: 1,
      DaedalusAugsRequirement: 30,
    });
  });
});

describe("augmentationCost: the game's `getAugCost`", () => {
  test("in a new BN1, the base costs", () => {
    expect(augmentationCost("BitWire", BN1)).toEqual(BITWIRE);
    expect(augmentationCost(NEUROFLUX_GOVERNOR, BN1)).toEqual({ money: 750e3, reputation: 500 });
    expect(augmentationCost("The Red Pill", BN1)).toEqual({ money: 0, reputation: 2.5e6 });
    expect(augmentationCost("BigD's Big ... Brain", BN1)).toEqual({ money: Infinity, reputation: Infinity });
  });

  test("money grows 1.9× per augmentation queued but Shadows of Anarchy's; reputation doesn't", () => {
    const queued = ["Neurotrainer I", "SoA - Beauty of Aphrodite", NEUROFLUX_GOVERNOR];
    expect(augmentationCost("BitWire", { ...BN1, queued })).toEqual({
      money: BITWIRE.money * 1.9 ** 2,
      reputation: BITWIRE.reputation,
    });
  });

  test.each([
    [1, 1.824],
    [2, 1.786],
    [3, 1.767],
  ])("SF11.%i makes the growth %f", (level, growth) => {
    expect(augmentationPriceGrowth(level)).toBeCloseTo(growth, 12);
    const queued = ["Neurotrainer I", "BitWire"];
    expect(augmentationCost("CashRoot Starter Kit", { ...BN1, queued, sourceFile11Level: level }).money).toBeCloseTo(
      125e6 * growth ** 2,
      0,
    );
  });

  test("the BitNode's multipliers: money and reputation, each its own", () => {
    const bn10 = {
      ...BN1,
      queued: ["Neurotrainer I"],
      bitNodeMultipliers: { AugmentationMoneyCost: 5, AugmentationRepCost: 2 },
    };
    expect(augmentationCost("BitWire", bn10)).toEqual({
      money: BITWIRE.money * 1.9 * 5,
      reputation: BITWIRE.reputation * 2,
    });
  });

  test("NeuroFlux Governor: × 1.14^level, its level the installed one plus each queued copy", () => {
    const state = {
      ...BN1,
      installed: { [NEUROFLUX_GOVERNOR]: 3 },
      queued: [NEUROFLUX_GOVERNOR, "BitWire", NEUROFLUX_GOVERNOR],
      bitNodeMultipliers: { AugmentationMoneyCost: 2, AugmentationRepCost: 3 },
    };
    const level = 1.14 ** 5;
    const cost = augmentationCost(NEUROFLUX_GOVERNOR, state);
    expect(cost.money).toBeCloseTo(750e3 * level * 2 * 1.9 ** 3, 4);
    expect(cost.reputation).toBeCloseTo(500 * level * 3, 8);
    // Another augmentation isn't leveled.
    expect(augmentationCost("BitWire", state).reputation).toBe(BITWIRE.reputation * 3);
  });

  test("Shadows of Anarchy's: × 7 and × 1.3 per one of theirs installed or queued, no BitNode multiplier, no queue growth", () => {
    const state = {
      ...BN1,
      installed: { "SoA - Wisdom of Athena": 1 },
      queued: ["SoA - Might of Ares", "BitWire", "Neurotrainer I"],
      bitNodeMultipliers: { AugmentationMoneyCost: 3, AugmentationRepCost: 3 },
    };
    const cost = augmentationCost("SoA - Beauty of Aphrodite", state);
    expect(cost.money).toBe(1e6 * 49);
    expect(cost.reputation).toBeCloseTo(1e4 * 1.69, 8);
  });

  test("bad input is refused, not priced", () => {
    expect(() => augmentationCost("BitWires", BN1)).toThrow(/no augmentation "BitWires"/);
    expect(() => augmentationCost("constructor", BN1)).toThrow(/no augmentation/);
    expect(() => augmentationCost("BitWire", { ...BN1, queued: ["Bitwire"] })).toThrow(/no augmentation "Bitwire"/);
    expect(() => augmentationCost("BitWire", { ...BN1, installed: { Nope: 1 } })).toThrow(/no augmentation "Nope"/);
    for (const level of [-1, 4, 1.5, Number.NaN]) {
      expect(() => augmentationCost("BitWire", { ...BN1, sourceFile11Level: level })).toThrow(/SF11 level/);
    }
    for (const value of [0, -1, Number.NaN, Infinity]) {
      const bitNodeMultipliers = { AugmentationMoneyCost: 1, AugmentationRepCost: value };
      expect(() => augmentationCost("BitWire", { ...BN1, bitNodeMultipliers })).toThrow(/AugmentationRepCost/);
    }
  });
});

describe("buying", () => {
  test("purchaseSequenceCost: each at its turn's price, and the total", () => {
    const { purchases, money } = purchaseSequenceCost(
      ["CashRoot Starter Kit", "BitWire", NEUROFLUX_GOVERNOR, NEUROFLUX_GOVERNOR],
      BN1,
    );
    expect(purchases.map((purchase) => purchase.name)).toEqual([
      "CashRoot Starter Kit",
      "BitWire",
      NEUROFLUX_GOVERNOR,
      NEUROFLUX_GOVERNOR,
    ]);
    expect(purchases[0]?.money).toBe(125e6);
    expect(purchases[1]?.money).toBe(10e6 * 1.9);
    expect(purchases[2]?.money).toBeCloseTo(750e3 * 1.9 ** 2, 6);
    expect(purchases[3]).toMatchObject({ reputation: 500 * 1.14 });
    expect(purchases[3]?.money).toBeCloseTo(750e3 * 1.14 * 1.9 ** 3, 6);
    expect(money).toBe(purchases.reduce((sum, purchase) => sum + purchase.money, 0));
    // The order matters: the dearest first costs less in all.
    expect(purchaseSequenceCost(["BitWire", "CashRoot Starter Kit"], BN1).money).toBeGreaterThan(
      purchaseSequenceCost(["CashRoot Starter Kit", "BitWire"], BN1).money,
    );
    expect(purchaseSequenceCost([], BN1)).toEqual({ purchases: [], money: 0 });
  });

  test("purchaseSequenceCost refuses what the game wouldn't sell: owned already, or a prerequisite missing", () => {
    expect(() => purchaseSequenceCost(["BitWire", "BitWire"], BN1)).toThrow(/BitWire is owned already/);
    expect(() => purchaseSequenceCost(["BitWire"], { ...BN1, installed: { BitWire: 1 } })).toThrow(/owned already/);
    expect(() => purchaseSequenceCost(["BitWire"], { ...BN1, queued: ["BitWire"] })).toThrow(/owned already/);
    const genII = "Cranial Signal Processors - Gen II";
    expect(() => purchaseSequenceCost([genII], BN1)).toThrow(/needs Cranial Signal Processors - Gen I first/);
    expect(purchaseSequenceCost(["Cranial Signal Processors - Gen I", genII], BN1).purchases).toHaveLength(2);
  });

  test("missingPrerequisites: neither installed nor queued, in the game's order", () => {
    const v2 = "Embedded Netburner Module Core V2 Upgrade";
    const both = ["Embedded Netburner Module Core Implant", "Embedded Netburner Module"];
    expect(missingPrerequisites(v2, BN1)).toEqual(both);
    expect(missingPrerequisites(v2, { installed: { "Embedded Netburner Module": 1 }, queued: [] })).toEqual([both[0]]);
    expect(
      missingPrerequisites(v2, { installed: { "Embedded Netburner Module": 1 }, queued: [both[0] as string] }),
    ).toEqual([]);
    expect(missingPrerequisites("BitWire", BN1)).toEqual([]);
  });

  test("augmentationsSoldBy: the faction's, in the game's order; no Red Pill at Daedalus in BN15", () => {
    expect(augmentationsSoldBy("CyberSec", 1)).toEqual([
      NEUROFLUX_GOVERNOR,
      "BitWire",
      "Synaptic Enhancement Implant",
      "Cranial Signal Processors - Gen I",
      "Cranial Signal Processors - Gen II",
      "Neurotrainer I",
    ]);
    expect(augmentationsSoldBy("Daedalus", 1)).toContain("The Red Pill");
    expect(augmentationsSoldBy("Daedalus", 15)).not.toContain("The Red Pill");
    expect(augmentationsSoldBy("Daedalus", 15).length).toBe(augmentationsSoldBy("Daedalus", 1).length - 1);
    expect(augmentationsSoldBy("Nobody", 1)).toEqual([]);
  });
});

describe("the BitNode's multipliers, from resetInfo", () => {
  test("each BitNode's own; only BN12's change with the level", () => {
    expect(augmentationBitNodeMultipliers(3, {})).toEqual({
      AugmentationMoneyCost: 3,
      AugmentationRepCost: 3,
      DaedalusAugsRequirement: 30,
    });
    expect(augmentationBitNodeMultipliers(3, { 3: 2 })).toEqual(augmentationBitNodeMultipliers(3, {}));
    // BN12 at level 3 (SF12.2): 1.02^3; another Source-File doesn't count.
    expect(augmentationBitNodeMultipliers(12, { 12: 2, 1: 3 })).toEqual({
      AugmentationMoneyCost: 1.02 ** 3,
      AugmentationRepCost: 1.02 ** 3,
      DaedalusAugsRequirement: 31,
    });
    expect(() => augmentationBitNodeMultipliers(16, {})).toThrow(/no BitNode 16/);
    expect(() => augmentationBitNodeMultipliers(0, {})).toThrow(/no BitNode 0/);
  });

  test("daedalusAugmentationsRequired: 30, 35 in BN6 and BN7, 20 in BN15, BN12's grows to 40", () => {
    expect([1, 6, 7, 15].map((n) => daedalusAugmentationsRequired(n, {}))).toEqual([30, 35, 35, 20]);
    expect(daedalusAugmentationsRequired(12, { 12: 115 })).toBe(39); // 30 + 1.02^116 = 39.9
    expect(daedalusAugmentationsRequired(12, { 12: 500 })).toBe(40);
  });
});
