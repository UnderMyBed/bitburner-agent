// Destroying a BitNode (#175): the BitNodes a destroy can enter, The Red Pill, and w0r1d_d43m0n's preconditions.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { AUGMENTATION_NAMES } from "../src/augmentations.ts";
import {
  BITNODE_COUNT,
  bitNodeAssumptions,
  bitNodeHackingMultipliers,
  bitNodePriceMultipliers,
  isBitNodeNumber,
  THE_RED_PILL,
  worldDaemonProblem,
} from "../src/bitnodes.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

test("the BitNodes a destroy can enter are the pinned game's: 1 to 15", () => {
  expect(gameSource("BitNode/Constants.ts")).toContain(
    `export const validBitNodes = [${Array.from({ length: BITNODE_COUNT }, (_, index) => index + 1).join(", ")}];`,
  );
  expect([1, 2, 15].every(isBitNodeNumber)).toBe(true);
  expect([0, 16, 1.5, "2", null, Number.NaN].some(isBitNodeNumber)).toBe(false);
});

test("The Red Pill is the game's, and the install that links w0r1d_d43m0n checks it", () => {
  expect(AUGMENTATION_NAMES).toContain(THE_RED_PILL);
  expect(gameSource("Augmentation/Enums.ts")).toContain(`TheRedPill = "${THE_RED_PILL}",`);
  expect(gameSource("Prestige.ts")).toContain("if (Player.hasAugmentation(AugmentationName.TheRedPill, true)) {");
});

test("worldDaemonProblem: unreachable, then no root, then the level, each saying why; none once all hold", () => {
  expect(worldDaemonProblem(null)).toBe("w0r1d_d43m0n isn't reachable: The Red Pill isn't installed");
  expect(worldDaemonProblem({ rooted: false, hackingLevel: 1, requiredHackingLevel: 3000 })).toBe(
    "no root access on w0r1d_d43m0n (NUKE.exe first)",
  );
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 2999, requiredHackingLevel: 3000 })).toBe(
    "hacking level 2999: w0r1d_d43m0n needs 3000",
  );
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 3000, requiredHackingLevel: 3000 })).toBeNull();
  // BN2's difficulty is 5: 15000 (`Server/ServerHelpers.ts:383-385`).
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 14999, requiredHackingLevel: 15000 })).toBe(
    "hacking level 14999: w0r1d_d43m0n needs 15000",
  );
});

test("the price multipliers the brain knows: BN1's the defaults, BN4's softcap 1.2, as the pinned game sets them", () => {
  const defaults = gameSource("BitNode/BitNodeMultipliers.ts");
  for (const name of [
    "HomeComputerRamCost",
    "CloudServerCost",
    "CloudServerSoftcap",
    "CloudServerLimit",
    "CloudServerMaxRam",
  ]) {
    expect(defaults).toContain(`  ${name} = 1;`);
  }
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  expect(bitNodes).toContain("    case 1: {\n      return new BitNodeMultipliers();\n    }");
  // BN4's own block, up to BN5's: only the softcap among the prices.
  const bn4 = bitNodes.slice(bitNodes.indexOf("    case 4: {"), bitNodes.indexOf("    case 5: {"));
  expect(bn4).toContain("CloudServerSoftcap: 1.2,");
  expect(bn4).not.toMatch(/HomeComputerRamCost|CloudServerCost|CloudServerLimit|CloudServerMaxRam/);
  expect(bn4).toContain("ScriptHackMoney: 0.2,");
  expect(bn4).toContain("HackExpGain: 0.4,");
  const ones = { HomeComputerRamCost: 1, CloudServerCost: 1, CloudServerSoftcap: 1, CloudServerLimit: 1 };
  expect(bitNodePriceMultipliers(1)).toEqual({ ...ones, CloudServerMaxRam: 1 });
  expect(bitNodePriceMultipliers(4)).toEqual({ ...ones, CloudServerSoftcap: 1.2, CloudServerMaxRam: 1 });
  expect(bitNodePriceMultipliers(2)).toBeNull();
  expect(bitNodePriceMultipliers(0)).toBeNull();
});

test("bitNodeHackingMultipliers (#321): BN1's 1 and 1, BN4's 0.2 and 0.4, as the pinned game sets and applies them", () => {
  const defaults = gameSource("BitNode/BitNodeMultipliers.ts");
  expect(defaults).toContain("  ScriptHackMoney = 1;");
  expect(defaults).toContain("  HackExpGain = 1;");
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  const bn4 = bitNodes.slice(bitNodes.indexOf("    case 4: {"), bitNodes.indexOf("    case 5: {"));
  expect(bn4).toContain("ScriptHackMoney: 0.2,");
  expect(bn4).toContain("HackExpGain: 0.4,");
  // Its other multipliers on hacking are the defaults, so the fold makes the formulas exact there.
  expect(bn4).not.toMatch(
    /ServerGrowthRate|ServerWeakenRate|HackingSpeedMultiplier|HackingLevelMultiplier|ScriptHackMoneyGain/,
  );
  // Where the game applies them: the share a thread hacks, and a thread's exp.
  const hacking = gameSource("Hacking.ts");
  expect(hacking).toContain("person.mults.hacking_money * currentNodeMults.ScriptHackMoney) / balanceFactor;");
  expect(hacking).toContain("return expGain * person.mults.hacking_exp * currentNodeMults.HackExpGain;");
  expect(bitNodeHackingMultipliers(1)).toEqual({ ScriptHackMoney: 1, HackExpGain: 1 });
  expect(bitNodeHackingMultipliers(4)).toEqual({ ScriptHackMoney: 0.2, HackExpGain: 0.4 });
  expect(bitNodeHackingMultipliers(2)).toBeNull();
  expect(bitNodeHackingMultipliers(0)).toBeNull();
});

test("bitNodeAssumptions: none in BN1 or BN4, whose prices and hacking core has; another BitNode's said", () => {
  expect(bitNodeAssumptions(1)).toEqual([]);
  expect(bitNodeAssumptions(4)).toEqual([]);
  expect(bitNodeAssumptions(2)).toEqual([
    "BitNode 2's multipliers: the brain knows BN1's and BN4's only, so it buys no home RAM or cloud servers here, " +
      "and its hacking takes BN1's (ScriptHackMoney and HackExpGain 1)",
  ]);
});
