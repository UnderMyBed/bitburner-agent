/**
 * The game's factions (#147): their names (`Faction/Enums.ts`, `FactionName`) and which are enemies
 * (`Faction/FactionInfo.tsx:498-552`). Joining a faction bans its enemies for the rest of the BitNode run
 * (`Faction/FactionHelpers.tsx:44-47`), so joining one that has enemies can't be undone. Shared by the in-game code and
 * the brain; plain literals, as in locations.ts.
 */

/** Every faction, by the name the game uses. */
export const FACTION_NAMES = [
  "Illuminati",
  "Daedalus",
  "The Covenant",
  "ECorp",
  "MegaCorp",
  "Bachman & Associates",
  "Blade Industries",
  "NWO",
  "Clarke Incorporated",
  "OmniTek Incorporated",
  "Four Sigma",
  "KuaiGong International",
  "Fulcrum Secret Technologies",
  "BitRunners",
  "The Black Hand",
  "NiteSec",
  "Aevum",
  "Chongqing",
  "Ishima",
  "New Tokyo",
  "Sector-12",
  "Volhaven",
  "Speakers for the Dead",
  "The Dark Army",
  "The Syndicate",
  "Silhouette",
  "Tetrads",
  "Slum Snakes",
  "Netburners",
  "Tian Di Hui",
  "CyberSec",
  "Bladeburners",
  "Church of the Machine God",
  "Shadows of Anarchy",
];

/** Each faction that has enemies, and them, in the game's order: the six city factions. */
export const FACTION_ENEMIES: Record<string, string[]> = {
  Aevum: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  Chongqing: ["Sector-12", "Aevum", "Volhaven"],
  Ishima: ["Sector-12", "Aevum", "Volhaven"],
  "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
  "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  Volhaven: ["Chongqing", "Sector-12", "New Tokyo", "Aevum", "Ishima"],
};

/** Home worker: joins a faction through the game's Factions page (#147). */
export const JOIN_FACTION_WORKER_NAME = "join-faction.js";
