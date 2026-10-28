/**
 * The game's cities and the places in them the Agent goes to (`Locations/data/LocationsMetadata.ts`,
 * `Locations/Enums.ts`). Shared by the in-game code and the brain. The constants are plain literals, as in
 * deploy-layout.ts.
 */

/** The six cities, by the names the game uses (`CityName`). */
export const CITIES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];

/** What a plane ticket costs (`Constants.ts`, `TravelCost`). */
export const TRAVEL_COST = 200_000;

/** Home worker: travels to a city through the game's page (#141). */
export const TRAVEL_WORKER_NAME = "travel.js";

/**
 * The tech vendor the brain buys at, in each city that has one (the `techVendor` locations). Each sells the TOR router
 * and home's RAM (`Locations/ui/TechVendorLocation.tsx`). Chongqing and New Tokyo have none.
 */
export const TECH_VENDORS: Record<string, string> = {
  "Sector-12": "Alpha Enterprises",
  Aevum: "NetLink Technologies",
  Ishima: "Omega Software",
  Volhaven: "CompuTek",
};
