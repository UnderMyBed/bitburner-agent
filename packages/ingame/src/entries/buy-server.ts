// agent/<deploymentId>/buy-server.js: a home worker that buys a cloud server (#159), with the NS API alone, which needs
// no Singularity (`NetscriptFunctions/Cloud.ts:35-97`): the `ui` backend's worker, in any game, with no page to drive.
// Arguments: the hostname, the RAM in GB, and when to give up (unused: the calls are quick).
// - The game first: a cloud server of the player's by that name is done, whatever its RAM (upgrades aren't this).
// - The name taken by another server: not done, and nothing bought. The game would buy it as `<name>-0`
//   (`Server/ServerHelpers.ts:42-65`), and the next try would buy another.
// - Then the price against the money, each refusal with its reason, so the purchase's own refusal is left with one
//   cause: the limit on cloud servers.
// RAM: `cloud.purchaseServer` 2.25 + `cloud.getServerCost` 0.25 + `serverExists`, `getServerMoneyAvailable` and
// `cloud.getServerUpgradeCost` 0.1 each + `getServerMaxRam` and `cloud.getServerLimit` 0.05 each (ram-budget.json).
// `cloud.getServerNames` would list the player's servers, but at 1.05 GB the worker would no longer fit a fresh save
// beside the Agent.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/**
 * Whether `hostname`, a server that exists, is one of the player's cloud servers: `getServerUpgradeCost` answers -1
 * for any other (`Server/ServerPurchases.ts:42-52`, `NetscriptDefinitions.d.ts:4230`). It's asked the price of twice
 * the server's RAM, which it never refuses for a cloud server: past the most, the price is Infinity, not -1.
 */
function isPlayersCloudServer(ns: NS, hostname: string): boolean {
  return ns.cloud.getServerUpgradeCost(hostname, 2 * ns.getServerMaxRam(hostname)) !== -1;
}

/** Buys it if it can: null once it's the player's, else why not. */
function buy(ns: NS, hostname: string, ram: number): string | null {
  if (ns.serverExists(hostname)) {
    return isPlayersCloudServer(ns, hostname) ? null : `${hostname} is the name of a server that isn't the player's`;
  }
  const cost = ns.cloud.getServerCost(ram);
  if (cost === Number.POSITIVE_INFINITY) return `the game sells no ${ram} GB server in this BitNode (over its most)`;
  const money = ns.getServerMoneyAvailable("home");
  if (money < cost) return `not enough money: the ${ram} GB server costs $${Math.ceil(cost)}`;
  const bought = ns.cloud.purchaseServer(hostname, ram);
  if (bought === hostname) return null;
  // Renamed only if a server the game keeps off the network (`serverExists`) held the name.
  if (bought !== "") return `bought as ${bought}: ${hostname} was taken`;
  return `the game's limit of ${ns.cloud.getServerLimit()} cloud servers is reached`;
}

export function main(ns: NS): void {
  ns.disableLog("ALL");
  const hostname = String(ns.args[0] ?? "");
  const ram = Number(ns.args[1] ?? 0);
  const problem = buy(ns, hostname, ram);
  const report: EffectorReport = { done: problem === null, problem };
  reportToAgent(ns, report);
}
