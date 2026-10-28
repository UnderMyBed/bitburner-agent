// agent/<deploymentId>/singularity-travel.js: the `singularity` backend's travel (#145, architecture §5.6), for when
// the game has Singularity (SF4, or BN4). Arguments: the city, and when to give up (unused: the call is quick). The
// game first, as the `ui` backend's worker does: the player already in the city is done without calling anything. RAM:
// `getPlayer` 0.5 + `travelToCity` 2 at SF4.3 or in BN4 (ram-budget.json); the game charges 4× or 16× with less of SF4.
import type { EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

/** The game's city names, as the definitions type `travelToCity`'s argument. */
type CityName = Parameters<NS["singularity"]["travelToCity"]>[0];

export async function main(ns: NS): Promise<void> {
  ns.disableLog("ALL");
  const city = String(ns.args[0] ?? "");
  const inCity = () => ns.getPlayer().city === city;
  const report: EffectorReport = { done: inCity(), problem: null };
  if (!report.done) {
    report.done = ns.singularity.travelToCity(city as CityName) && inCity();
    if (!report.done) report.problem = `not in ${city} after travelling (is the $200k ticket there?)`;
  }
  reportToAgent(ns, report);
}
