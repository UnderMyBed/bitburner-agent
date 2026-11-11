// agent/<deploymentId>/level-loop.js: levelling mode's loop (#336), run by `hack-loop-deploy.js` on the hosts and on
// home's RAM beyond what home keeps, with its target as its one argument. It weakens the target for ever: each weaken
// gives every thread the target's hacking experience (`Hacking.ts:30-38`, `NetscriptFunctions.ts:373`), and keeps it
// at its minimum security, where a weaken is quickest (`Hacking.ts:60-94`). The brain chose the target (core's
// `chooseLevellingTarget`).
// RAM: `weaken` 0.15 (ram-budget.json; core's LEVEL_LOOP_RAM_GB).
import type { NS } from "../ns.ts";

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const targetHostname = String(ns.args[0]);
  for (;;) await ns.weaken(targetHostname);
}
