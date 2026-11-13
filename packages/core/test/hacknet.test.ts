// Hacknet to Netburners' invitation (#387): the figures checked against the pinned game's source, the costs worked by
// hand from its formulas (`Hacknet/formulas/HacknetNodes.ts:13-92`), and the cheapest way to the invitation's totals
// against a search that tries every split. The parity against the engine itself is the simulator's
// (packages/brain/test/hacknet-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  HACKNET_NODE,
  type HacknetCostMultipliers,
  type HacknetNodeStats,
  hacknetCoreCost,
  hacknetLevelCost,
  hacknetNodeCost,
  hacknetRamCost,
  hacknetServersInEffect,
  hacknetSetupPlan,
  hacknetTotals,
  INVITATION_CHECK_MS,
  NETBURNERS_INVITATION,
  netburnersTotalsMet,
} from "../src/hacknet.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

const ONES: HacknetCostMultipliers = { purchaseCost: 1, levelCost: 1, ramCost: 1, coreCost: 1 };
const NEW_NODE: HacknetNodeStats = { level: 1, ram: 1, cores: 1 };

describe("the game's figures", () => {
  test("a node's constants are Hacknet/data/Constants.ts:1-17's", () => {
    const constants = gameSource("Hacknet/data/Constants.ts");
    const value = (name: string) => Number(new RegExp(`\\b${name}: ([\\d.e]+),`).exec(constants)?.[1]);
    expect(HACKNET_NODE).toEqual({
      baseCost: value("BaseCost"),
      levelBaseCost: value("LevelBaseCost"),
      ramBaseCost: value("RamBaseCost"),
      coreBaseCost: value("CoreBaseCost"),
      purchaseNextMult: value("PurchaseNextMult"),
      upgradeLevelMult: value("UpgradeLevelMult"),
      upgradeRamMult: value("UpgradeRamMult"),
      upgradeCoreMult: value("UpgradeCoreMult"),
      maxLevel: value("MaxLevel"),
      maxRam: value("MaxRam"),
      maxCores: value("MaxCores"),
    });
  });

  test("Netburners' invitation is Faction/FactionInfo.tsx:675's, each a total over every node", () => {
    expect(gameSource("Faction/FactionInfo.tsx")).toContain(
      'inviteReqs: [haveSkill("hacking", 80), totalHacknetRam(8), totalHacknetCores(4), totalHacknetLevels(100)],',
    );
    expect(NETBURNERS_INVITATION).toEqual({ hacking: 80, levels: 100, ram: 8, cores: 4 });
    // Summed: each condition adds every node's figure until the total is reached (FactionJoinCondition.ts:215-264).
    const conditions = gameSource("Faction/FactionJoinCondition.ts");
    for (const field of ["ram", "cores", "level"]) {
      expect(conditions).toContain(`total += node.${field};`);
    }
  });

  test("the invitations are checked every 10 cycles of 200 ms (engine.tsx:154, :177-183; Constants.ts:19)", () => {
    expect(gameSource("engine.tsx")).toContain("checkFactionInvitations: 10,");
    expect(gameSource("Constants.ts")).toContain("MilliPerCycle: 200,");
    expect(INVITATION_CHECK_MS).toBe(2_000);
  });
});

describe("the costs, by hand from the game's formulas", () => {
  test("the n-th node: $1,000 × 1.85^(n−1), times the multiplier", () => {
    expect(hacknetNodeCost(1)).toBe(1_000);
    expect(hacknetNodeCost(2)).toBeCloseTo(1_850, 6);
    expect(hacknetNodeCost(6)).toBeCloseTo(1_000 * 1.85 ** 5, 6);
    expect(hacknetNodeCost(3, 0.9)).toBeCloseTo(3_422.5 * 0.9, 6);
    expect(hacknetNodeCost(0)).toBe(0);
  });

  test("levels: $500 × 1.04^(L−1) each, Infinity past 200", () => {
    expect(hacknetLevelCost(1, 1)).toBe(500);
    expect(hacknetLevelCost(1, 2)).toBeCloseTo(500 + 520, 6);
    expect(hacknetLevelCost(1, 99)).toBeCloseTo((500 * (1.04 ** 99 - 1)) / 0.04, 2);
    expect(hacknetLevelCost(10, 3, 0.85)).toBeCloseTo(500 * (1.04 ** 9 + 1.04 ** 10 + 1.04 ** 11) * 0.85, 6);
    expect(hacknetLevelCost(199, 2)).toBe(Number.POSITIVE_INFINITY);
    expect(hacknetLevelCost(5, 0)).toBe(0);
  });

  test("RAM doubles: from r GB $30,000 × r × 1.28^log2(r), Infinity past 64 GB", () => {
    expect(hacknetRamCost(1, 1)).toBe(30_000);
    expect(hacknetRamCost(2, 1)).toBeCloseTo(76_800, 6);
    expect(hacknetRamCost(1, 3)).toBeCloseTo(30_000 + 76_800 + 196_608, 6);
    expect(hacknetRamCost(32, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  test("cores: $500,000 × 1.48^(c−1) each, Infinity past 16", () => {
    expect(hacknetCoreCost(1, 1)).toBe(500_000);
    expect(hacknetCoreCost(1, 3)).toBeCloseTo(500_000 * (1 + 1.48 + 1.48 ** 2), 4);
    expect(hacknetCoreCost(16, 1)).toBe(Number.POSITIVE_INFINITY);
  });

  test("one node with it all is about $3.2m (#387's figure)", () => {
    const one = hacknetNodeCost(1) + hacknetLevelCost(1, 99) + hacknetRamCost(1, 3) + hacknetCoreCost(1, 3);
    expect(one).toBeGreaterThan(3.2e6);
    expect(one).toBeLessThan(3.25e6);
  });
});

/**
 * The least cost of the totals over `nodes` (the multipliers' own), each part searched apart from the plan's way:
 * levels and cores by a table over every count each node could take, RAM over every node's doublings.
 */
function searchedCost(nodes: readonly HacknetNodeStats[], mults: HacknetCostMultipliers): number {
  const totals = hacknetTotals(nodes);
  const table = (short: number, costOf: (node: HacknetNodeStats, count: number) => number) => {
    let least = [0, ...Array.from({ length: Math.max(0, short) }, () => Number.POSITIVE_INFINITY)];
    for (const node of nodes) {
      const next = [...least];
      for (const [have, cost] of least.entries()) {
        for (let count = 1; have + count <= short; count++) {
          next[have + count] = Math.min(next[have + count] as number, cost + costOf(node, count));
        }
      }
      least = next;
    }
    return least[Math.max(0, short)] as number;
  };
  const levels = table(NETBURNERS_INVITATION.levels - totals.level, (node, count) =>
    hacknetLevelCost(node.level, count, mults.levelCost),
  );
  const cores = table(NETBURNERS_INVITATION.cores - totals.cores, (node, count) =>
    hacknetCoreCost(node.cores, count, mults.coreCost),
  );
  let ram = Number.POSITIVE_INFINITY;
  // Every node's doublings in turn, until the GB are met (the rest take none) or the cost is no less than the least.
  const choose = (index: number, gb: number, cost: number) => {
    if (cost >= ram) return;
    if (gb >= NETBURNERS_INVITATION.ram) {
      ram = cost;
      return;
    }
    if (index === nodes.length) return;
    const node = nodes[index] as HacknetNodeStats;
    for (let doublings = 0; node.ram * 2 ** doublings <= HACKNET_NODE.maxRam; doublings++) {
      choose(index + 1, gb + node.ram * 2 ** doublings, cost + hacknetRamCost(node.ram, doublings, mults.ramCost));
    }
  };
  choose(0, 0, 0);
  return levels + cores + ram;
}

/** The least over 0 to 10 new nodes, by `searchedCost`. */
function searchedLeast(nodes: readonly HacknetNodeStats[], mults: HacknetCostMultipliers): number {
  let least = Number.POSITIVE_INFINITY;
  let bought = 0;
  for (let added = 0; added <= 10; added++) {
    if (added > 0) bought += hacknetNodeCost(nodes.length + added, mults.purchaseCost);
    const all = [...nodes, ...Array.from({ length: added }, () => NEW_NODE)];
    least = Math.min(least, bought + searchedCost(all, mults));
  }
  return least;
}

/** The nodes after `steps`, from `nodes`, and what the steps cost by the formulas. */
function applied(nodes: readonly HacknetNodeStats[], plan: ReturnType<typeof hacknetSetupPlan>) {
  const after = nodes.map((node) => ({ ...node }));
  for (const step of plan.steps) {
    if (step.kind === "node") {
      expect(step.node).toBe(after.length);
      after.push({ ...NEW_NODE });
      continue;
    }
    const node = after[step.node] as HacknetNodeStats;
    if (step.kind === "level") node.level += step.count;
    else if (step.kind === "ram") node.ram *= 2 ** step.count;
    else node.cores += step.count;
  }
  return after;
}

describe("hacknetSetupPlan: the cheapest way to the totals", () => {
  test("from no node at ×1: 6 nodes, about $170k, against $3.2m for one", () => {
    const plan = hacknetSetupPlan([], ONES);
    expect(plan.nodes).toBe(6);
    expect(plan.cost).toBeCloseTo(searchedLeast([], ONES), 4);
    expect(plan.cost).toBeGreaterThan(160_000);
    expect(plan.cost).toBeLessThan(180_000);
    const after = applied([], plan);
    expect(netburnersTotalsMet(after)).toBe(true);
    expect(plan.steps.reduce((sum, step) => sum + step.cost, 0)).toBeCloseTo(plan.cost, 4);
    // The nodes first, in the game's order, then each node's upgrades.
    expect(plan.steps.slice(0, 6).map((step) => step.kind)).toEqual(Array(6).fill("node"));
    expect(after.map((node) => node.cores)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  test.each<[string, HacknetNodeStats[], HacknetCostMultipliers]>([
    ["no node, Netburners' five installed", [], { purchaseCost: 0.9 * 0.85, levelCost: 0.85, ramCost: 1, coreCost: 1 }],
    ["one node at level 50", [{ level: 50, ram: 1, cores: 1 }], ONES],
    ["two nodes, one with 8 GB", [NEW_NODE, { level: 1, ram: 8, cores: 1 }], ONES],
    ["four nodes, cores met", [NEW_NODE, NEW_NODE, NEW_NODE, NEW_NODE], ONES],
    ["dear nodes, cheap cores", [], { purchaseCost: 50, levelCost: 1, ramCost: 1, coreCost: 0.01 }],
    ["dear levels", [NEW_NODE], { purchaseCost: 1, levelCost: 20, ramCost: 1, coreCost: 1 }],
  ])("%s: the least of every split, and the totals met", (_name, nodes, mults) => {
    const plan = hacknetSetupPlan(nodes, mults);
    expect(plan.cost).toBeCloseTo(searchedLeast(nodes, mults), 4);
    expect(netburnersTotalsMet(applied(nodes, plan))).toBe(true);
    expect(plan.steps.reduce((sum, step) => sum + step.cost, 0)).toBeCloseTo(plan.cost, 4);
  });

  test("the totals met: nothing to buy", () => {
    const met = [{ level: 100, ram: 8, cores: 4 }];
    expect(netburnersTotalsMet(met)).toBe(true);
    expect(hacknetSetupPlan(met, ONES)).toEqual({ steps: [], cost: 0, nodes: 1 });
    // Summed over the nodes, not one node's.
    const split = [
      { level: 60, ram: 4, cores: 2 },
      { level: 40, ram: 4, cores: 2 },
    ];
    expect(netburnersTotalsMet(split)).toBe(true);
    expect(netburnersTotalsMet([{ level: 99, ram: 64, cores: 16 }])).toBe(false);
  });
});

describe("hacknetServersInEffect: Hacknet servers stand in for nodes (left out)", () => {
  test("in BN9 or with SF9, unless the BitNode's options turn them off", () => {
    expect(hacknetServersInEffect(4, { 1: 3 })).toBe(false);
    expect(hacknetServersInEffect(9, {})).toBe(true);
    expect(hacknetServersInEffect(1, { 9: 1 })).toBe(true);
    expect(hacknetServersInEffect(9, { 9: 1 }, { disableHacknetServer: true })).toBe(false);
    // The BitNode's Source-File overrides first, as `activeSourceFileLvl` reads them: SF9 overridden to 0 is none.
    expect(hacknetServersInEffect(1, { 9: 1 }, { sourceFileOverrides: { 9: 0 } })).toBe(false);
    expect(hacknetServersInEffect(1, {}, { sourceFileOverrides: { 9: 2 } })).toBe(true);
    expect(gameSource("PersonObjects/Player/PlayerObjectGeneralMethods.ts")).toContain(
      "if (this.bitNodeOptions.sourceFileOverrides.has(n)) {",
    );
    expect(gameSource("Hacknet/HacknetHelpers.tsx")).toContain(
      "return canAccessBitNodeFeature(9) && !Player.bitNodeOptions.disableHacknetServer;",
    );
  });
});
