// Destroying a BitNode (#175): the BitNodes a destroy can enter, The Red Pill, and w0r1d_d43m0n's preconditions.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { AUGMENTATION_NAMES } from "../src/augmentations.ts";
import {
  BITNODE_BLACK_OPS_ESTIMATE_REASON,
  BITNODE_COUNT,
  BITNODE_NO_WIN_ROUTE_REASON,
  BLACK_OPS_COUNT,
  bitNodeAssumptions,
  bitNodeHackingMultipliers,
  bitNodePriceMultipliers,
  bitNodeUnplayableReason,
  isBitNodeNumber,
  knownBitNodes,
  listedBitNodes,
  playableBitNodes,
  THE_RED_PILL,
  winRouteOf,
  worldDaemonProblem,
} from "../src/bitnodes.ts";
import { BLADEBURNER_BLACK_OPS } from "../src/bladeburner-black-ops.ts";

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

test("worldDaemonProblem with the Black Ops (#398): all 21 done is enough, as Singularity's destroy and the page's button take it", () => {
  // The game's either-or (`NetscriptFunctions/Singularity.ts:1176-1183`), and the Black Ops page's button
  // (`Bladeburner/ui/BlackOpPage.tsx:39-52`), each at `numberOfBlackOperations`.
  const singularity = gameSource("NetscriptFunctions/Singularity.ts");
  expect(singularity).toContain("return Player.bladeburner.numBlackOpsComplete >= numberOfBlackOperations;");
  expect(singularity).toContain("if (!hackingRequirements() && !bladeburnerRequirements()) {");
  expect(gameSource("Bladeburner/ui/BlackOpPage.tsx")).toContain(
    "{bladeburner.numBlackOpsComplete >= numberOfBlackOperations && (",
  );
  expect(gameSource("Bladeburner/data/BlackOperations.ts")).toContain(
    "export const numberOfBlackOperations = Object.keys(BladeburnerBlackOpName).length;",
  );
  expect(BLACK_OPS_COUNT).toBe(BLADEBURNER_BLACK_OPS.length);
  expect(BLACK_OPS_COUNT).toBe(21);
  expect(worldDaemonProblem(null, 21)).toBeNull();
  expect(worldDaemonProblem({ rooted: false, hackingLevel: 1, requiredHackingLevel: 6000 }, 21)).toBeNull();
  expect(worldDaemonProblem(null, 20)).toBe(
    "w0r1d_d43m0n isn't reachable: The Red Pill isn't installed; and 20 of the 21 Black Ops done",
  );
  // Either route: the hacking one holding is enough, whatever the Black Ops.
  expect(worldDaemonProblem({ rooted: true, hackingLevel: 6000, requiredHackingLevel: 6000 }, 3)).toBeNull();
  // Not read (no Bladeburner): The Red Pill's route alone, worded as before.
  expect(worldDaemonProblem(null, null)).toBe("w0r1d_d43m0n isn't reachable: The Red Pill isn't installed");
});

test("winRouteOf (#398): the Black Ops in BN6 and BN7, The Red Pill's elsewhere", () => {
  expect([6, 7].map(winRouteOf)).toEqual(["blackOps", "blackOps"]);
  expect([1, 2, 3, 4, 5, 8, 12].map(winRouteOf)).toEqual(Array(7).fill("redPill"));
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
  expect(bitNodePriceMultipliers(3)).toBeNull();
  expect(bitNodePriceMultipliers(0)).toBeNull();
});

/** The four multipliers on hacking core folds in, at the defaults but for `changed`. */
const hackingWith = (changed: Partial<Record<string, number>>) => ({
  ScriptHackMoney: 1,
  HackExpGain: 1,
  ServerGrowthRate: 1,
  HackingLevelMultiplier: 1,
  ...changed,
});

test("bitNodeHackingMultipliers (#321): BN1's 1 each, BN4's 0.2 and 0.4, as the pinned game sets and applies them", () => {
  const defaults = gameSource("BitNode/BitNodeMultipliers.ts");
  for (const name of ["ScriptHackMoney", "HackExpGain", "ServerGrowthRate", "HackingLevelMultiplier"]) {
    expect(defaults).toContain(`  ${name} = 1;`);
  }
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  const bn4 = bitNodes.slice(bitNodes.indexOf("    case 4: {"), bitNodes.indexOf("    case 5: {"));
  expect(bn4).toContain("ScriptHackMoney: 0.2,");
  expect(bn4).toContain("HackExpGain: 0.4,");
  // Its other multipliers on hacking are the defaults, so the fold makes the formulas exact there.
  expect(bn4).not.toMatch(
    /ServerGrowthRate|ServerWeakenRate|HackingSpeedMultiplier|HackingLevelMultiplier|ScriptHackMoneyGain/,
  );
  // Where the game applies them: the share a thread hacks, a thread's exp, a grow's growth, and the level (#334).
  const hacking = gameSource("Hacking.ts");
  expect(hacking).toContain("person.mults.hacking_money * currentNodeMults.ScriptHackMoney) / balanceFactor;");
  expect(hacking).toContain("return expGain * person.mults.hacking_exp * currentNodeMults.HackExpGain;");
  const grow = gameSource("Server/formulas/grow.ts");
  expect(grow).toContain(
    "const serverGrowthPercentageAdjusted = serverGrowthPercentage * currentNodeMults.ServerGrowthRate;",
  );
  expect(grow).toContain("return adjGrowthLog * serverGrowthPercentageAdjusted * p.mults.hacking_grow * coreBonus *");
  expect(gameSource("PersonObjects/Person.ts")).toContain(
    "this.mults.hacking * currentNodeMults.HackingLevelMultiplier,",
  );
  expect(bitNodeHackingMultipliers(1)).toEqual(hackingWith({}));
  expect(bitNodeHackingMultipliers(4)).toEqual(hackingWith({ ScriptHackMoney: 0.2, HackExpGain: 0.4 }));
  expect(bitNodeHackingMultipliers(3)).toBeNull();
  expect(bitNodeHackingMultipliers(0)).toBeNull();
});

test("BN5's rows (#323): its softcap 1.2, ScriptHackMoney 0.15 and HackExpGain 0.5, as the pinned game sets them", () => {
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  // BN5's own block, up to BN6's (`BitNode.tsx:663-693`).
  const bn5 = bitNodes.slice(bitNodes.indexOf("    case 5: {"), bitNodes.indexOf("    case 6: {"));
  expect(bn5).toContain("CloudServerSoftcap: 1.2,");
  expect(bn5).toContain("ScriptHackMoney: 0.15,");
  expect(bn5).toContain("HackExpGain: 0.5,");
  // The rest of the prices, and the other multipliers on hacking, are the defaults; ServerMaxMoney too.
  expect(bn5).not.toMatch(/HomeComputerRamCost|CloudServerCost|CloudServerLimit|CloudServerMaxRam/);
  expect(bn5).not.toMatch(
    /ServerGrowthRate|ServerWeakenRate|HackingSpeedMultiplier|HackingLevelMultiplier|ScriptHackMoneyGain|ServerMaxMoney/,
  );
  // What it sets on the servers, the snapshots read; w0r1d_d43m0n's level is the static snapshot's (4500).
  expect(bn5).toContain("ServerStartingSecurity: 2,");
  expect(bn5).toContain("ServerStartingMoney: 0.5,");
  expect(bn5).toContain("WorldDaemonDifficulty: 1.5,");
  const ones = { HomeComputerRamCost: 1, CloudServerCost: 1, CloudServerLimit: 1, CloudServerMaxRam: 1 };
  expect(bitNodePriceMultipliers(5)).toEqual({ ...ones, CloudServerSoftcap: 1.2 });
  expect(bitNodeHackingMultipliers(5)).toEqual(hackingWith({ ScriptHackMoney: 0.15, HackExpGain: 0.5 }));
});

test("BN2's rows (#334): its softcap 1.3, ServerGrowthRate and HackingLevelMultiplier 0.8, as the pinned game sets them", () => {
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  // BN2's whole block, up to BN3's (`BitNode.tsx:575-597`): every multiplier it sets.
  const bn2 = bitNodes.slice(bitNodes.indexOf("    case 2: {"), bitNodes.indexOf("    case 3: {"));
  const set = [...bn2.matchAll(/^ {8}(\w+): (-?[\d.]+),$/gm)].map((match) => [match[1], Number(match[2])]);
  expect(Object.fromEntries(set)).toEqual({
    HackingLevelMultiplier: 0.8,
    ServerGrowthRate: 0.8,
    ServerMaxMoney: 0.08,
    ServerStartingMoney: 0.4,
    CloudServerSoftcap: 1.3,
    CrimeMoney: 3,
    FactionPassiveRepGain: 0,
    FactionWorkRepGain: 0.5,
    CorporationSoftcap: 0.9,
    CorporationDivisions: 0.9,
    InfiltrationMoney: 3,
    StaneksGiftPowerMultiplier: 2,
    StaneksGiftExtraSize: -6,
    WorldDaemonDifficulty: 5,
  });
  // The rest of the prices and of hacking's are the defaults; the servers' figures the snapshots read.
  const ones = { HomeComputerRamCost: 1, CloudServerCost: 1, CloudServerLimit: 1, CloudServerMaxRam: 1 };
  expect(bitNodePriceMultipliers(2)).toEqual({ ...ones, CloudServerSoftcap: 1.3 });
  expect(bitNodeHackingMultipliers(2)).toEqual(hackingWith({ ServerGrowthRate: 0.8, HackingLevelMultiplier: 0.8 }));
});

test("BN6's and BN7's rows (#367): every multiplier they set on hacking and the prices, as the pinned game sets them", () => {
  const bitNodes = gameSource("BitNode/BitNode.tsx");
  // Each one's whole block (`BitNode.tsx:694-727`, `:728-769`): every multiplier it sets.
  const blockOf = (n: number) => {
    const block = bitNodes.slice(bitNodes.indexOf(`    case ${n}: {`), bitNodes.indexOf(`    case ${n + 1}: {`));
    return Object.fromEntries(
      [...block.matchAll(/^ {8}(\w+): (-?[\d.]+),$/gm)].map((match) => [match[1], Number(match[2])]),
    );
  };
  const bn6 = blockOf(6);
  const bn7 = blockOf(7);
  expect(bn6).toEqual({
    HackingLevelMultiplier: 0.35,
    ServerMaxMoney: 0.2,
    ServerStartingMoney: 0.5,
    ServerStartingSecurity: 1.5,
    CloudServerSoftcap: 2,
    CompanyWorkMoney: 0.5,
    CrimeMoney: 0.75,
    HacknetNodeMoney: 0.2,
    ScriptHackMoney: 0.75,
    HackExpGain: 0.25,
    InfiltrationMoney: 0.75,
    CorporationValuation: 0.2,
    CorporationSoftcap: 0.9,
    CorporationDivisions: 0.8,
    GangSoftcap: 0.7,
    GangUniqueAugs: 0.2,
    DaedalusAugsRequirement: 35,
    StaneksGiftPowerMultiplier: 0.5,
    StaneksGiftExtraSize: 2,
    WorldDaemonDifficulty: 2,
  });
  // BN7's are BN6's but these.
  expect(bn7).toEqual({
    ...bn6,
    ScriptHackMoney: 0.5,
    AugmentationMoneyCost: 3,
    FourSigmaMarketDataCost: 2,
    FourSigmaMarketDataApiCost: 2,
    BladeburnerRank: 0.6,
    BladeburnerSkillCost: 2,
    StaneksGiftPowerMultiplier: 0.9,
    StaneksGiftExtraSize: -1,
  });
  // The rest of the prices and of hacking's are the defaults; the servers' figures the snapshots read.
  const ones = { HomeComputerRamCost: 1, CloudServerCost: 1, CloudServerLimit: 1, CloudServerMaxRam: 1 };
  for (const n of [6, 7]) expect(bitNodePriceMultipliers(n)).toEqual({ ...ones, CloudServerSoftcap: 2 });
  const hacking = { HackExpGain: 0.25, HackingLevelMultiplier: 0.35 };
  expect(bitNodeHackingMultipliers(6)).toEqual(hackingWith({ ...hacking, ScriptHackMoney: 0.75 }));
  expect(bitNodeHackingMultipliers(7)).toEqual(hackingWith({ ...hacking, ScriptHackMoney: 0.5 }));
});

test("BN6's route is built (B6, #398), its estimate with installs past the bar (B7, #404); BN7's at its own multipliers past it too (B8, #411): the campaign skips both", () => {
  expect(knownBitNodes()).toEqual([1, 2, 4, 5, 6, 7]);
  expect(playableBitNodes()).toEqual([1, 2, 4, 5]);
  expect(bitNodeUnplayableReason(6)).toBe(BITNODE_BLACK_OPS_ESTIMATE_REASON);
  expect(BITNODE_BLACK_OPS_ESTIMATE_REASON).toBe(
    "no win route yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408)",
  );
  expect(bitNodeUnplayableReason(7)).toBe(BITNODE_NO_WIN_ROUTE_REASON);
  expect(BITNODE_NO_WIN_ROUTE_REASON).toBe(
    "no win route yet: the Black Ops' grown estimate at BN7's multipliers is past the campaign's bar even with the Bladeburners' shop installed (#411)",
  );
  // The Red Pill's route there: w0r1d_d43m0n at 3,000 (`Server/data/servers.ts:1536`) × 2 (`Server/ServerHelpers.ts:
  // 383-385`), at a level multiplier of 0.35, is 17,143 at ×1, against BN4's 9,000 (3,000 × 3).
  expect(gameSource("Server/ServerHelpers.ts")).toContain(
    "server.requiredHackingSkill *= currentNodeMults.WorldDaemonDifficulty;",
  );
  expect(Math.round((3000 * 2) / 0.35)).toBe(17_143);
});

test("playable: BN1, BN2, BN4 and BN5, with both tables; another says what core lacks of it", () => {
  expect(playableBitNodes()).toEqual([1, 2, 4, 5]);
  expect(listedBitNodes([1, 2, 4, 5])).toBe("BN1, BN2, BN4 and BN5");
  expect(listedBitNodes([2, 3])).toBe("BN2 and BN3");
  expect(listedBitNodes([2])).toBe("BN2");
  expect([1, 2, 4, 5].map(bitNodeUnplayableReason)).toEqual([null, null, null, null]);
  expect(bitNodeUnplayableReason(3)).toBe("no hacking multipliers or prices yet");
  expect(bitNodeUnplayableReason(15)).toBe("no hacking multipliers or prices yet");
});

test("bitNodeAssumptions: none in BN1, BN2, BN4, BN5, BN6 or BN7, whose prices and hacking core has; another's said", () => {
  for (const bitNode of [1, 2, 4, 5, 6, 7]) expect(bitNodeAssumptions(bitNode)).toEqual([]);
  expect(bitNodeAssumptions(3)).toEqual([
    "BitNode 3's multipliers: the brain knows those of BN1, BN2, BN4, BN5, BN6 and BN7 only, so it buys no home RAM " +
      "or cloud servers here, and its hacking takes BN1's (each multiplier on it 1)",
  ]);
});
