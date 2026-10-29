// What `upgrade-server.js` does (#194), apart from its entry so a test can drive it with a stand-in NS: a cloud
// server's RAM raised with the NS API alone (`NetscriptFunctions/Cloud.ts:104-114`, `Server/ServerPurchases.ts:44-63`),
// which needs no Singularity.
// - A name no server has, or another server's: not done. The game would refuse it (`ServerPurchases.ts:45-48`).
// - Then the game first: the player's cloud server with at least that RAM is done, nothing paid.
// - Then the price against the money, each refusal with its reason, so the upgrade's own refusal is left with none the
//   worker knows of: `upgradeServer` answers false for any (`Cloud.ts:107-113`).
// RAM: `cloud.upgradeServer` 0.25 + `serverExists`, `getServerMoneyAvailable` and `cloud.getServerUpgradeCost` 0.1
// each + `getServerMaxRam` 0.05.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

/** Raises the player's cloud server `hostname` to `ram` GB if it can, and reports how it stands. */
export function cloudServerUpgrade(ns: NS, hostname: string, ram: number): EffectorReport {
  const notDone = (problem: string): EffectorReport => ({ done: false, problem });
  if (!ns.serverExists(hostname)) return notDone(`there's no server named ${hostname}`);
  const maxRam = ns.getServerMaxRam(hostname);
  // -1 for any server but the player's cloud servers; twice its RAM is never refused for one (past the most, the
  // price is Infinity, not -1) (`ServerPurchases.ts:44-54`).
  if (ns.cloud.getServerUpgradeCost(hostname, 2 * maxRam) === -1) {
    return notDone(`${hostname} isn't one of the player's cloud servers`);
  }
  if (maxRam >= ram) return { done: true, problem: null };
  const cost = ns.cloud.getServerUpgradeCost(hostname, ram);
  if (cost === Number.POSITIVE_INFINITY) return notDone(`the game sells no ${ram} GB server in this BitNode`);
  if (ns.getServerMoneyAvailable("home") < cost) {
    return notDone(`not enough money: upgrading ${hostname} to ${ram} GB costs $${Math.ceil(cost)}`);
  }
  if (ns.cloud.upgradeServer(hostname, ram)) return { done: true, problem: null };
  return notDone(`the game refused to upgrade ${hostname} from ${maxRam} to ${ram} GB`);
}
