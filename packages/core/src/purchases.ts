/**
 * What the Agent buys through the game's page (the `ui` effector, architecture §5.6): the TOR router (#136) and home's
 * RAM (#138) at a tech vendor. Shared by the in-game code and the brain. The constants are plain literals, as in
 * deploy-layout.ts.
 */

/**
 * The tech vendor the brain buys at, in each city that has one (`Locations/data/LocationsMetadata.ts`, the
 * `techVendor` locations; `Locations/Enums.ts` for the names). Each sells the TOR router and home's RAM
 * (`Locations/ui/TechVendorLocation.tsx`). Chongqing and New Tokyo have none.
 */
export const TECH_VENDORS: Record<string, string> = {
  "Sector-12": "Alpha Enterprises",
  Aevum: "NetLink Technologies",
  Ishima: "Omega Software",
  Volhaven: "CompuTek",
};

/** What a worker that buys through the page reports to the Agent. */
export interface PurchaseReport {
  item: string;
  /** Owned afterwards: bought now, or already. */
  done: boolean;
  /** Why it couldn't buy it (the page wasn't as expected), or null. */
  problem: string | null;
}
