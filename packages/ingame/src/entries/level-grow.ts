// agent/<deploymentId>/level-grow.js: levelling mode's grow loop (#336), run by `hack-loop-deploy.js` on the hosts and
// on home's RAM beyond what home keeps, with its target as its one argument, once the brain sees the target at its
// minimum security and maximum money. It grows the target for ever: each grow gives every thread the target's hacking experience
// (`Hacking.ts:30-38`, `NetscriptFunctions.ts:295`) in 3.2 hacks' time, a weaken's in 4 (`Hacking.ts:83-94`), and at the
// target's maximum money it adds no security (`Server/ServerHelpers.ts:201-212`). The brain chose the target and the
// operation (core's `chooseLevellingTarget`).
// RAM: `grow` 0.15 (ram-budget.json; core's LEVEL_LOOP_RAM_GB).
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const targetHostname = String(ns.args[0]);
  for (;;) await ns.grow(targetHostname);
}
