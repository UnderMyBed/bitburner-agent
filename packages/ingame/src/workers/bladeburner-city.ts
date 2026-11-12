// What `bladeburner-city.js` does (#383), apart from its entry so a test can drive it with a stand-in NS: the brain's
// city for the division set, then the six cities read, with the NS API alone (`NetscriptFunctions/Bladeburner.ts:
// 34-43`). Not in the division, it reads nothing and says so (no city).
// - The city, when the state names one: `switchCity` unless the division is there already. It's free and stops no
//   action (`NetscriptFunctions/Bladeburner.ts:316-321`), and isn't the player's city: no travel. A name not one of the
//   six is a problem, and nothing is switched.
// - Then the division's city (`getCity`), and each city's population estimate, communities and chaos
//   (`getCityEstimatedPopulation`, `getCityCommunities`, `getCityChaos`, `:297-311`), in the game's order.
// The Agent runs it just before `bladeburner.js` (../agent/bladeburner.ts), so that one's ranges are read in the city
// set here, and waits for each to exit (`run-worker.ts`): they never hold home's RAM at once.
// RAM (`Netscript/RamCostGenerator.ts:335`, `:366-370`): 4 GB each for `getCityEstimatedPopulation`,
// `getCityCommunities`, `getCityChaos`, `getCity` and `switchCity`; nothing for `inBladeburner`: 21.6 GB with the
// script's 1.6, under the reading worker's 50.6, so B1's RAM gate (core's `bladeburnerWorkerFits`) covers it.
import { BLADEBURNER_CITIES, type BladeburnerCityWorkerReading, isBladeburnerCity } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

type CityName = Parameters<NS["bladeburner"]["switchCity"]>[0];

/** Sets the division's city to `city` (null: leaves it), and reads the six. */
export function bladeburnerCityReading(ns: NS, city: string | null): BladeburnerCityWorkerReading {
  if (!ns.bladeburner.inBladeburner()) return { city: null, cities: [], problems: [] };
  const problems: string[] = [];
  if (city !== null) {
    if (!isBladeburnerCity(city)) problems.push(`no city ${JSON.stringify(city)} to work in`);
    else if (ns.bladeburner.getCity() !== city && !ns.bladeburner.switchCity(city as CityName)) {
      problems.push(`the game didn't move the division to ${city}`);
    }
  }
  return {
    city: ns.bladeburner.getCity(),
    cities: BLADEBURNER_CITIES.map((name) => ({
      name,
      population: ns.bladeburner.getCityEstimatedPopulation(name as CityName),
      communities: ns.bladeburner.getCityCommunities(name as CityName),
      chaos: ns.bladeburner.getCityChaos(name as CityName),
    })),
    problems,
  };
}
