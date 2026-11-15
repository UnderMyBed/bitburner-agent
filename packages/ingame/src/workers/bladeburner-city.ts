// What `bladeburner-city.js` does (#383), apart from its entry so a test can drive it with a stand-in NS: the brain's
// city for the division set, then the six cities read, with the NS API alone (`NetscriptFunctions/Bladeburner.ts:
// 34-43`). Not in the division, it reads nothing and says so (no city).
// - The city, when the state names one: `switchCity` unless the division is there already. It's free and stops no
//   action (`NetscriptFunctions/Bladeburner.ts:316-321`), and isn't the player's city: no travel. A name not one of the
//   six is a problem, and nothing is switched.
// - Then the division's city (`getCity`), and each city's population estimate, communities and chaos
//   (`getCityEstimatedPopulation`, `getCityCommunities`, `getCityChaos`, `:297-311`), in the game's order.
// - Then (#420) the round over the six: in each, `switchCity` there, the next Black Op's range (`getNextBlackOp`,
//   `:88-93`) and each contract's and operation's (`getActionEstimatedSuccessChance`, `:138-142`: the current city's
//   population, estimate and chaos, `Bladeburner/Actions/Action.ts:144-167`); then `switchCity` back to the city it
//   was in. All in one synchronous run, no `await` in it (`bladeburnerCitiesRound` returns no promise): a script's NS
//   calls run at once (`Netscript/APIWrapper.ts:78-83`), and the game moves only in its own timer (`engine.tsx:441`,
//   its Bladeburner `process` at `:199-206`, an action completing in `processAction`, `Bladeburner/Bladeburner.ts:
//   1296-1312`), which can't run until the script yields: so no action completes in another city, and the round takes
//   no game time. A switch the game refuses, or the division not back where it was, is a problem and no round.
// The Agent runs it just before `bladeburner.js` (../agent/bladeburner.ts), so that one's ranges are read in the city
// set here, and waits for each to exit (`run-worker.ts`): they never hold home's RAM at once.
// RAM (`Netscript/RamCostGenerator.ts:335`, `:339`, `:348`, `:366-370`): 4 GB each for `getCityEstimatedPopulation`,
// `getCityCommunities`, `getCityChaos`, `getCity`, `switchCity` and `getActionEstimatedSuccessChance`, 2 GB for
// `getNextBlackOp`, nothing for `inBladeburner`: 27.6 GB with the script's 1.6, under the reading worker's 50.6, so
// B1's RAM gate (core's `bladeburnerWorkerFits`) covers it.
import {
  BLACK_OPERATIONS,
  BLADEBURNER_CITIES,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerCitiesRound,
  type BladeburnerCityWorkerReading,
  isBladeburnerCity,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

type CityName = Parameters<NS["bladeburner"]["switchCity"]>[0];
type ActionType = Parameters<NS["bladeburner"]["getActionEstimatedSuccessChance"]>[0];
type ActionName = Parameters<NS["bladeburner"]["getActionEstimatedSuccessChance"]>[1];

/**
 * The round over the six (#420), synchronous: each city's own ranges, then back to the division's city. Null with a
 * switch refused or the division not back, its problem in `problems`.
 */
export function bladeburnerCitiesRound(ns: NS, problems: string[]): BladeburnerCitiesRound | null {
  const home = ns.bladeburner.getCity();
  const next = ns.bladeburner.getNextBlackOp();
  const cities: BladeburnerCitiesRound["cities"] = [];
  let refused: string | null = null;
  for (const name of BLADEBURNER_CITIES) {
    if (!ns.bladeburner.switchCity(name as CityName)) {
      refused = name;
      break;
    }
    const range = (type: string, action: string): [number, number] => {
      const [low, high] = ns.bladeburner.getActionEstimatedSuccessChance(type as ActionType, action as ActionName);
      return [low, high];
    };
    cities.push({
      name,
      blackOp: next === null ? null : range(BLACK_OPERATIONS, next.name),
      actions: BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name: action }) => ({
        type,
        name: action,
        chance: range(type, action),
      })),
    });
  }
  ns.bladeburner.switchCity(home as CityName);
  const after = ns.bladeburner.getCity();
  if (refused !== null) problems.push(`the round (#420): the game didn't move the division to ${refused}`);
  if (after !== home) {
    problems.push(`the round (#420): the division left in ${after}, not back in ${home}`);
    return null;
  }
  return refused === null ? { blackOp: next?.name ?? null, cities, city: after } : null;
}

/** Sets the division's city to `city` (null: leaves it), reads the six, and makes the round over them (#420). */
export function bladeburnerCityReading(ns: NS, city: string | null): BladeburnerCityWorkerReading {
  if (!ns.bladeburner.inBladeburner()) return { city: null, cities: [], problems: [] };
  const problems: string[] = [];
  if (city !== null) {
    if (!isBladeburnerCity(city)) problems.push(`no city ${JSON.stringify(city)} to work in`);
    else if (ns.bladeburner.getCity() !== city && !ns.bladeburner.switchCity(city as CityName)) {
      problems.push(`the game didn't move the division to ${city}`);
    }
  }
  const cities = BLADEBURNER_CITIES.map((name) => ({
    name,
    population: ns.bladeburner.getCityEstimatedPopulation(name as CityName),
    communities: ns.bladeburner.getCityCommunities(name as CityName),
    chaos: ns.bladeburner.getCityChaos(name as CityName),
  }));
  const round = bladeburnerCitiesRound(ns, problems);
  return { city: ns.bladeburner.getCity(), cities, problems, round };
}
