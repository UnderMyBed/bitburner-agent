// What `hacknet-setup.js` does (#387), apart from its entry so a test can drive it with a stand-in NS: Hacknet bought
// the cheapest way to Netburners' invitation's totals (core's `hacknetSetupPlan`), with the NS API alone, which needs
// no Singularity (`NetscriptFunctions/Hacknet.ts:53-118`).
// - The game first: the nodes' levels, RAM and cores, summed, at the totals is done, nothing bought.
// - A Hacknet server among them (BN9, or SF9: `Hacknet/HacknetHelpers.tsx:34-36`) is a problem: their costs aren't
//   core's, and the brain never asks there (left out, #387). With no node yet, that shows only after the first buy.
// - Then the plan's purchases in order, from the game's own figures and multipliers (`getHacknetMultipliers`), each
//   refused by the game without the money (`HacknetHelpers.tsx:70-72`, `:259`, `:298`, `:329`): the worker stops
//   there and says what it would have cost. Sent again, it goes on from what's bought.
// RAM (`Netscript/RamCostGenerator.ts:99-121`, `:606`): `hacknet.numNodes`, `getNodeStats`, `purchaseNode`,
// `upgradeLevel`, `upgradeRam` and `upgradeCore` 0.5 each; `getHacknetMultipliers` 0.25.
import {
  type EffectorReport,
  type HacknetNodeStats,
  hacknetSetupPlan,
  netburnersTotalsMet,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

const money = (amount: number) => `$${Math.ceil(amount).toLocaleString("en-US")}`;

/** Buys Hacknet to Netburners' totals as far as the money goes, and reports how it stands. */
export function hacknetSetup(ns: NS): EffectorReport {
  const read = (): HacknetNodeStats[] | string => {
    const nodes: HacknetNodeStats[] = [];
    for (let index = 0; index < ns.hacknet.numNodes(); index++) {
      const stats = ns.hacknet.getNodeStats(index);
      if (stats.cache !== undefined) return "Hacknet servers here (BN9 or SF9): the brain buys no Hacknet there";
      nodes.push({ level: stats.level, ram: stats.ram, cores: stats.cores });
    }
    return nodes;
  };
  const nodes = read();
  if (typeof nodes === "string") return { done: false, problem: nodes };
  if (netburnersTotalsMet(nodes)) return { done: true, problem: null };
  const mults = ns.getHacknetMultipliers();
  const plan = hacknetSetupPlan(nodes, mults);
  for (const step of plan.steps) {
    const bought =
      step.kind === "node"
        ? ns.hacknet.purchaseNode() === step.node
        : step.kind === "level"
          ? ns.hacknet.upgradeLevel(step.node, step.count)
          : step.kind === "ram"
            ? ns.hacknet.upgradeRam(step.node, step.count)
            : ns.hacknet.upgradeCore(step.node, step.count);
    if (!bought) {
      const what = step.kind === "node" ? `node ${step.node}` : `${step.count} ${step.kind} on node ${step.node}`;
      return {
        done: false,
        problem: `the game refused ${what} (${money(step.cost)}; the setup ${money(plan.cost)}): not enough money`,
      };
    }
  }
  const after = read();
  if (typeof after === "string") return { done: false, problem: after };
  return netburnersTotalsMet(after)
    ? { done: true, problem: null }
    : { done: false, problem: "every purchase went through, but the totals aren't Netburners' invitation's" };
}
