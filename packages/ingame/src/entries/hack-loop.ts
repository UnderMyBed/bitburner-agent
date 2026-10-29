// agent/<deploymentId>/hack-loop.js: the hack loop (#134), run by `hack-loop-deploy.js` on the servers other than home,
// with the target and the threads it hacks with (#187) as its arguments. Weakens while security is more than 5 over the
// minimum, grows while money is under 75% of the maximum, and hacks otherwise. The thresholds are core's, which the
// brain's rule for a ready target uses too (#184).
// - Every host's loop sees 75% at about the same time, so all hack together: with all their threads they hacked a
//   slow-growing target dry (#187). It hacks with the brain's count, at most the script's threads (the deploy worker
//   caps it; `hack`'s `threads` option takes fewer than the script has, NetscriptHelpers.tsx:369-381), and the other
//   threads wait out the hack. Without a count, as an older deploy worker started it, it hacks with all of them.
// RAM: `hack` 0.1 + `grow` 0.15 + `weaken` 0.15 + four `getServer…` reads 0.1 each (ram-budget.json).
import { HACK_LOOP_MONEY_FRACTION, HACK_LOOP_SECURITY_MARGIN } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const targetHostname = String(ns.args[0]);
  const hackThreads = ns.args[1];
  // A threads option of 0 or none is all the script's threads (NetscriptHelpers.tsx:371-372): a count of 1 or more.
  const hackOptions = typeof hackThreads === "number" && hackThreads >= 1 ? { threads: hackThreads } : undefined;
  const securityLimit = ns.getServerMinSecurityLevel(targetHostname) + HACK_LOOP_SECURITY_MARGIN;
  const moneyLimit = ns.getServerMaxMoney(targetHostname) * HACK_LOOP_MONEY_FRACTION;
  for (;;) {
    if (ns.getServerSecurityLevel(targetHostname) > securityLimit) await ns.weaken(targetHostname);
    else if (ns.getServerMoneyAvailable(targetHostname) < moneyLimit) await ns.grow(targetHostname);
    else await ns.hack(targetHostname, hackOptions);
  }
}
