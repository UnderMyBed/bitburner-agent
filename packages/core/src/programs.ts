/**
 * The hacking programs the Agent buys (#136, M3's second slice): the TOR router, from a tech vendor, then the five
 * port openers, from the dark web, in the order the brain buys them. Shared by the in-game code and the brain. The
 * constants are plain literals, as in deploy-layout.ts.
 */

/** The item name for the TOR router, which has no file: `ns.hasTorRouter()` says whether it's owned. */
export const TOR_ROUTER = "TOR router";

/** The port openers, cheapest first: each opens one more port, so more servers can be rooted. */
export const PORT_OPENER_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];

/**
 * The tech vendor the brain buys the TOR router at, in each city that has one (`Locations/data/LocationsMetadata.ts`,
 * the `techVendor` locations; `Locations/Enums.ts` for the names). Chongqing and New Tokyo have none.
 */
export const TOR_VENDORS: Record<string, string> = {
  "Sector-12": "Alpha Enterprises",
  Aevum: "NetLink Technologies",
  Ishima: "Omega Software",
  Volhaven: "CompuTek",
};

/** Home worker: buys one item through the game's page. */
export const BUY_PROGRAM_WORKER_NAME = "buy-program.js";

/** What `buy-program.js` reports to the Agent. */
export interface BuyProgramReport {
  item: string;
  /** Owned afterwards: bought now, or already. */
  done: boolean;
  /** Why it couldn't buy it (the page wasn't as expected), or null. */
  problem: string | null;
}
