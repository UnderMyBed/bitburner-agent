// What `buy-server.js` does (#159), apart from its entry so a test can drive it with a stand-in NS: a cloud server
// bought with the NS API alone (`NetscriptFunctions/Cloud.ts:35-93`), which needs no Singularity.
// - The game first: a cloud server of the player's by that name is done, whatever its RAM (upgrades aren't this).
// - The name taken by another server: not done, and nothing bought. The game would buy it as `<name>-0`
//   (`Server/ServerHelpers.ts:42-65`), and the next try would buy another.
// - Then the price against the money, each refusal with its reason, so the purchase's own refusal is left with one
//   cause: the limit on cloud servers. The game checks the limit before the money (`Cloud.ts:51-74`); either order
//   refuses the same purchases, and the worker can only count servers with `cloud.getServerNames` (1.05 GB).
// - Bought under another name all the same (a server `serverExists` doesn't see held the name): done, with what
//   happened as its problem, so it's never bought twice. Core refuses the one such name the game has, `w0r1d_d43m0n`.
// RAM: `cloud.purchaseServer` 2.25 + `cloud.getServerCost` 0.25 + `serverExists`, `getServerMoneyAvailable` and
// `cloud.getServerUpgradeCost` 0.1 each + `getServerMaxRam` and `cloud.getServerLimit` 0.05 each.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/**
 * Whether `hostname`, a server that exists, is one of the player's cloud servers: `getServerUpgradeCost` answers -1
 * for any other (`Server/ServerPurchases.ts:44-54`, `NetscriptDefinitions.d.ts:4230`). It's asked the price of twice
 * the server's RAM, which it never refuses for a cloud server: past the most, the price is Infinity, not -1.
 */
function isPlayersCloudServer(ns: NS, hostname: string): boolean {
  return ns.cloud.getServerUpgradeCost(hostname, 2 * ns.getServerMaxRam(hostname)) !== -1;
}

/** Buys the cloud server `hostname` with `ram` GB if it can, and reports how it stands. */
export function cloudServerPurchase(ns: NS, hostname: string, ram: number): EffectorReport {
  const notDone = (problem: string): EffectorReport => ({ done: false, problem });
  if (ns.serverExists(hostname)) {
    if (isPlayersCloudServer(ns, hostname)) return { done: true, problem: null };
    return notDone(`${hostname} is the name of a server that isn't one of the player's cloud servers`);
  }
  const cost = ns.cloud.getServerCost(ram);
  if (cost === Number.POSITIVE_INFINITY) return notDone(`the game sells no ${ram} GB server in this BitNode`);
  if (ns.getServerMoneyAvailable("home") < cost) {
    return notDone(`not enough money: the ${ram} GB server costs $${Math.ceil(cost)}`);
  }
  const bought = ns.cloud.purchaseServer(hostname, ram);
  if (bought === hostname) return { done: true, problem: null };
  if (bought !== "") return { done: true, problem: `bought as ${bought}: a server off the network held ${hostname}` };
  return notDone(`the game's limit of ${ns.cloud.getServerLimit()} cloud servers is reached`);
}
