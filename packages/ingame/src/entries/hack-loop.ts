// agent/<deploymentId>/hack-loop.js: the hack loop (#134), run by `hack-loop-deploy.js` on the servers other than home,
// with the target as its one argument. Weakens while security is more than 5 over the minimum, grows while money is
// under 75% of the maximum, and hacks otherwise. The thresholds are core's, which the brain's rule for a ready target
// uses too (#184).
// RAM: `hack` 0.1 + `grow` 0.15 + `weaken` 0.15 + four `getServer…` reads 0.1 each (ram-budget.json).
import { HACK_LOOP_MONEY_FRACTION, HACK_LOOP_SECURITY_MARGIN } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const targetHostname = String(ns.args[0]);
  const securityLimit = ns.getServerMinSecurityLevel(targetHostname) + HACK_LOOP_SECURITY_MARGIN;
  const moneyLimit = ns.getServerMaxMoney(targetHostname) * HACK_LOOP_MONEY_FRACTION;
  for (;;) {
    if (ns.getServerSecurityLevel(targetHostname) > securityLimit) await ns.weaken(targetHostname);
    else if (ns.getServerMoneyAvailable(targetHostname) < moneyLimit) await ns.grow(targetHostname);
    else await ns.hack(targetHostname);
  }
}
