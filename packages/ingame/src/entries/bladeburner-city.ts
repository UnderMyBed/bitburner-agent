// agent/<deploymentId>/bladeburner-city.js: a home worker that moves the Bladeburner division to the brain's city and
// reads the six cities (#383), every 10 s just before `bladeburner.js` while the brain asks for a city
// (../agent/bladeburner.ts). Argument: the desired state's `bladeburner.city`, as JSON (one of the six, or null: none
// to move to); anything else is a problem, and nothing is moved. What it does, and its RAM, are in
// ../workers/bladeburner-city.ts (ram-budget.json).
import type { NS } from "../ns.ts";
import { bladeburnerCityReading } from "../workers/bladeburner-city.ts";
import { reportToAgent } from "../workers/report-to-agent.ts";

export function main(ns: NS): void {
  ns.disableLog("ALL");
  let city: unknown = null;
  try {
    city = JSON.parse(String(ns.args[0] ?? "null"));
  } catch {
    city = undefined;
  }
  if (city !== null && typeof city !== "string") {
    reportToAgent(ns, {
      city: null,
      cities: [],
      problems: [`the Bladeburner city isn't one to move to: ${ns.args[0]}`],
    });
    return;
  }
  reportToAgent(ns, bladeburnerCityReading(ns, city));
}
