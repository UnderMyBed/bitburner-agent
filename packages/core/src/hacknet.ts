/**
 * Hacknet, to Netburners' invitation (#387): the brain's first Hacknet code, and only what the invitation needs. Shared
 * by the in-game code and the brain.
 * - **The invitation:** hacking 80 and Hacknet totals of 8 GB RAM, 4 cores and 100 levels (`Faction/FactionInfo.tsx:
 *   675`), each summed over every node the player owns (`Faction/FactionJoinCondition.ts:215-264`, `:430-449`), at
 *   the game's check every 10 cycles of 200 ms (`engine.tsx:154`, `:177-183`; `Constants.ts:19`).
 * - **The costs** (`Hacknet/formulas/HacknetNodes.ts:13-92`, `Hacknet/data/Constants.ts:1-17`), each times the
 *   player's multiplier for it (`Hacknet/HacknetHelpers.tsx:89-91`, `:240`, `:271`, `:310`): a new node is level 1,
 *   1 GB and 1 core (`Hacknet/HacknetNode.ts:33-48`), the n-th bought $1,000 × 1.85^(n−1); a level from L, $500 ×
 *   1.04^(L−1); RAM doubles, from r GB $30,000 × r × 1.28^log2(r); a core from c, $500,000 × 1.48^(c−1).
 * - **The cheapest way** to the totals (`hacknetSetupPlan`): how many nodes to buy, tried in turn, and for each the
 *   levels, cores and RAM spread the cheapest way. With no node and the multipliers at 1 it's 6 nodes, about $170k,
 *   against $3.2m for one node with all of it (#387's figure): the cores are the dear part, and each new node brings
 *   one.
 * - **Lost at each install** (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:130`), so it's bought again each
 *   cycle while Netburners sells a countable not yet installed.
 * - **Left out, labelled:** Hacknet servers (BN9, or SF9: `Hacknet/HacknetHelpers.tsx:34-36`), whose costs and hashes
 *   differ: the brain buys none there (`hacknetServersInEffect`). Hacknet's money: its production is small, and isn't
 *   counted.
 */

/** The faction Hacknet's totals invite (#387). */
export const NETBURNERS = "Netburners";

/** Netburners' invitation (`Faction/FactionInfo.tsx:675`): hacking, and Hacknet's totals over every node. */
export const NETBURNERS_INVITATION = { hacking: 80, levels: 100, ram: 8, cores: 4 } as const;

/** The game's check for invitations: every 10 cycles of 200 ms (`engine.tsx:154`, `:177-183`; `Constants.ts:19`). */
export const INVITATION_CHECK_MS = 10 * 200;

/** A Hacknet node's figures (`Hacknet/data/Constants.ts:1-17`). */
export const HACKNET_NODE = {
  baseCost: 1_000,
  levelBaseCost: 500,
  ramBaseCost: 30_000,
  coreBaseCost: 500_000,
  purchaseNextMult: 1.85,
  upgradeLevelMult: 1.04,
  upgradeRamMult: 1.28,
  upgradeCoreMult: 1.48,
  maxLevel: 200,
  maxRam: 64,
  maxCores: 16,
} as const;

/** Home worker: buys the Hacknet setup for Netburners' invitation (#387), with the NS API alone. */
export const HACKNET_SETUP_WORKER_NAME = "hacknet-setup.js";

/** One node's level, RAM (GB) and cores, as `ns.hacknet.getNodeStats` has them. */
export interface HacknetNodeStats {
  level: number;
  ram: number;
  cores: number;
}

/** The player's Hacknet cost multipliers (`ns.getHacknetMultipliers()`, `getPlayer().mults`' `hacknet_node_*_cost`). */
export interface HacknetCostMultipliers {
  purchaseCost: number;
  levelCost: number;
  ramCost: number;
  coreCost: number;
}

export const NO_HACKNET_COST_MULTIPLIERS: HacknetCostMultipliers = {
  purchaseCost: 1,
  levelCost: 1,
  ramCost: 1,
  coreCost: 1,
};

/** The n-th node's price, n from 1 (`Hacknet/formulas/HacknetNodes.ts:87-92`). */
export function hacknetNodeCost(n: number, mult = 1): number {
  if (n <= 0) return 0;
  return HACKNET_NODE.baseCost * HACKNET_NODE.purchaseNextMult ** (n - 1) * mult;
}

/** `extra` levels from `level` (`Hacknet/formulas/HacknetNodes.ts:13-32`): Infinity past the most. */
export function hacknetLevelCost(level: number, extra: number, mult = 1): number {
  if (!(extra >= 1)) return 0;
  if (level + extra > HACKNET_NODE.maxLevel) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let each = level - 1; each < level - 1 + extra; each++) total += HACKNET_NODE.upgradeLevelMult ** each;
  return HACKNET_NODE.levelBaseCost * total * mult;
}

/** `doublings` of RAM from `ram` GB (`Hacknet/formulas/HacknetNodes.ts:34-61`): Infinity past the most. */
export function hacknetRamCost(ram: number, doublings: number, mult = 1): number {
  if (!(doublings >= 1)) return 0;
  if (ram * 2 ** doublings > HACKNET_NODE.maxRam) return Number.POSITIVE_INFINITY;
  let total = 0;
  let upgrades = Math.round(Math.log2(ram));
  let current = ram;
  for (let each = 0; each < doublings; each++) {
    total += current * HACKNET_NODE.ramBaseCost * HACKNET_NODE.upgradeRamMult ** upgrades;
    current *= 2;
    upgrades++;
  }
  return total * mult;
}

/** `extra` cores from `cores` (`Hacknet/formulas/HacknetNodes.ts:63-85`): Infinity past the most. */
export function hacknetCoreCost(cores: number, extra: number, mult = 1): number {
  if (!(extra >= 1)) return 0;
  if (cores + extra > HACKNET_NODE.maxCores) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let each = cores; each < cores + extra; each++) {
    total += HACKNET_NODE.coreBaseCost * HACKNET_NODE.upgradeCoreMult ** (each - 1);
  }
  return total * mult;
}

/** Levels, RAM and cores summed over every node, as the invitation's check sums them. */
export function hacknetTotals(nodes: readonly HacknetNodeStats[]): HacknetNodeStats {
  return nodes.reduce(
    (sum, node) => ({ level: sum.level + node.level, ram: sum.ram + node.ram, cores: sum.cores + node.cores }),
    { level: 0, ram: 0, cores: 0 },
  );
}

/** Whether the nodes meet Netburners' Hacknet totals (the hacking level aside). */
export function netburnersTotalsMet(nodes: readonly HacknetNodeStats[]): boolean {
  const totals = hacknetTotals(nodes);
  return (
    totals.level >= NETBURNERS_INVITATION.levels &&
    totals.ram >= NETBURNERS_INVITATION.ram &&
    totals.cores >= NETBURNERS_INVITATION.cores
  );
}

/**
 * Whether Hacknet servers stand in for Hacknet nodes (`Hacknet/HacknetHelpers.tsx:34-36`): in BN9, or with SF9 at
 * its active level, the BitNode's `sourceFileOverrides` first as the game's `activeSourceFileLvl` reads it
 * (`PersonObjects/Player/PlayerObjectGeneralMethods.ts:615-620`; `getResetInfo` gives its Maps as objects), unless the
 * BitNode's options turn them off. Their costs and hashes aren't this module's (left out, labelled): the brain buys no
 * Hacknet there.
 */
export function hacknetServersInEffect(
  currentNode: number,
  ownedSF: Readonly<Record<string, number>>,
  bitNodeOptions: Readonly<Record<string, unknown>> = {},
): boolean {
  if (bitNodeOptions.disableHacknetServer === true) return false;
  const overrides = bitNodeOptions.sourceFileOverrides;
  const override =
    typeof overrides === "object" && overrides !== null ? (overrides as Record<string, unknown>)["9"] : undefined;
  const level = typeof override === "number" ? override : (ownedSF["9"] ?? 0);
  return currentNode === 9 || level > 0;
}

/** One purchase of the setup, in order: a node, or levels, RAM doublings or cores on node `node` (from 0). */
export type HacknetStep =
  | { kind: "node"; node: number; cost: number }
  | { kind: "level"; node: number; count: number; cost: number }
  | { kind: "ram"; node: number; count: number; cost: number }
  | { kind: "core"; node: number; count: number; cost: number };

/** The cheapest way to Netburners' totals from `nodes`: the purchases in order, and what they cost together. */
export interface HacknetSetupPlan {
  steps: HacknetStep[];
  cost: number;
  /** The nodes there'll be. */
  nodes: number;
}

/** The levels, cores or RAM still short over `nodes`, each given the cheapest way. */
function spread(
  nodes: readonly HacknetNodeStats[],
  mults: HacknetCostMultipliers,
): { cost: number; levels: number[]; cores: number[]; doublings: number[] } {
  const levels = nodes.map(() => 0);
  const cores = nodes.map(() => 0);
  const totals = hacknetTotals(nodes);
  let cost = 0;
  // Each level's and each core's own cost rises with the node's count, so one at a time to the cheapest node is the
  // cheapest way to any number of them.
  for (let short = NETBURNERS_INVITATION.levels - totals.level; short > 0; short--) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [index, node] of nodes.entries()) {
      const each = hacknetLevelCost(node.level + (levels[index] ?? 0), 1, mults.levelCost);
      if (each < bestCost) [best, bestCost] = [index, each];
    }
    if (best < 0) return { cost: Number.POSITIVE_INFINITY, levels, cores, doublings: [] };
    levels[best] = (levels[best] ?? 0) + 1;
    cost += bestCost;
  }
  for (let short = NETBURNERS_INVITATION.cores - totals.cores; short > 0; short--) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const [index, node] of nodes.entries()) {
      const each = hacknetCoreCost(node.cores + (cores[index] ?? 0), 1, mults.coreCost);
      if (each < bestCost) [best, bestCost] = [index, each];
    }
    if (best < 0) return { cost: Number.POSITIVE_INFINITY, levels, cores, doublings: [] };
    cores[best] = (cores[best] ?? 0) + 1;
    cost += bestCost;
  }
  // RAM comes in doublings, so the GB a node adds isn't one at a time: the least cost to each shortfall, node by node.
  const ramShort = Math.max(0, NETBURNERS_INVITATION.ram - totals.ram);
  let best: { cost: number; doublings: number[] }[] = [{ cost: 0, doublings: [] }];
  for (let gb = 1; gb <= ramShort; gb++) best.push({ cost: Number.POSITIVE_INFINITY, doublings: [] });
  for (const node of nodes) {
    const next = best.map((each) => ({ cost: each.cost, doublings: [...each.doublings, 0] }));
    for (const [have, each] of best.entries()) {
      if (!Number.isFinite(each.cost)) continue;
      for (let doublings = 1; node.ram * 2 ** doublings <= HACKNET_NODE.maxRam; doublings++) {
        const reach = Math.min(ramShort, have + node.ram * (2 ** doublings - 1));
        const total = each.cost + hacknetRamCost(node.ram, doublings, mults.ramCost);
        if (total < (next[reach]?.cost ?? Number.POSITIVE_INFINITY)) {
          next[reach] = { cost: total, doublings: [...each.doublings, doublings] };
        }
      }
    }
    best = next;
  }
  const ram = best[ramShort] ?? { cost: Number.POSITIVE_INFINITY, doublings: [] };
  return { cost: cost + ram.cost, levels, cores, doublings: ram.doublings };
}

/**
 * The cheapest way to Netburners' Hacknet totals from the player's `nodes` (#387), by the game's costs with the
 * player's multipliers: each number of new nodes in turn, from none, the levels, cores and RAM still short spread the
 * cheapest way over all of them (`spread`), until the new nodes' price alone is no less than the cheapest so far. A tie
 * goes to fewer nodes. Empty with the totals met. In order: the nodes, then each node's levels, RAM and cores.
 */
export function hacknetSetupPlan(
  nodes: readonly HacknetNodeStats[],
  mults: HacknetCostMultipliers = NO_HACKNET_COST_MULTIPLIERS,
): HacknetSetupPlan {
  let chosen: { added: number; cost: number; spread: ReturnType<typeof spread> } | null = null;
  let nodesCost = 0;
  for (let added = 0; ; added++) {
    if (added > 0) nodesCost += hacknetNodeCost(nodes.length + added, mults.purchaseCost);
    if (chosen !== null && nodesCost >= chosen.cost) break;
    const all = [...nodes, ...Array.from({ length: added }, () => ({ level: 1, ram: 1, cores: 1 }))];
    const each = spread(all, mults);
    const cost = nodesCost + each.cost;
    if (chosen === null || cost < chosen.cost) chosen = { added, cost, spread: each };
    // Past the totals' own counts, a node adds nothing the others can't: no cheaper way lies beyond.
    if (all.length >= NETBURNERS_INVITATION.levels) break;
  }
  const steps: HacknetStep[] = [];
  for (let each = 0; each < chosen.added; each++) {
    const node = nodes.length + each;
    steps.push({ kind: "node", node, cost: hacknetNodeCost(node + 1, mults.purchaseCost) });
  }
  const all = [...nodes, ...Array.from({ length: chosen.added }, () => ({ level: 1, ram: 1, cores: 1 }))];
  for (const [index, node] of all.entries()) {
    const levels = chosen.spread.levels[index] ?? 0;
    const doublings = chosen.spread.doublings[index] ?? 0;
    const cores = chosen.spread.cores[index] ?? 0;
    if (levels > 0) {
      steps.push({
        kind: "level",
        node: index,
        count: levels,
        cost: hacknetLevelCost(node.level, levels, mults.levelCost),
      });
    }
    if (doublings > 0) {
      steps.push({
        kind: "ram",
        node: index,
        count: doublings,
        cost: hacknetRamCost(node.ram, doublings, mults.ramCost),
      });
    }
    if (cores > 0) {
      steps.push({ kind: "core", node: index, count: cores, cost: hacknetCoreCost(node.cores, cores, mults.coreCost) });
    }
  }
  return { steps, cost: chosen.cost, nodes: all.length };
}
