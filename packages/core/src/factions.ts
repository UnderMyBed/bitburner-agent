/**
 * The game's factions (#147): their names (`Faction/Enums.ts`, `FactionName`) and which are enemies
 * (`Faction/FactionInfo.tsx:498-552`). Joining a faction bans its enemies for the rest of the BitNode run
 * (`Faction/FactionHelpers.tsx:44-47`), so joining one that has enemies can't be undone. Shared by the in-game code and
 * the brain; plain literals, as in locations.ts. And (#193) each faction's data, generated from the engine into
 * faction-data.ts.
 */
import { augmentationBitNodeMultipliers } from "./augmentations.ts";
import type { FactionWorkType } from "./work.ts";

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

/**
 * One of a faction's invitation requirements, as `ns.singularity.getFactionInviteRequirements` gives it
 * (`Faction/FactionJoinCondition.ts`; the game's types: `ScriptEditor/NetscriptDefinitions.d.ts:11063-11269`):
 * `{ type: "money", money }`, `{ type: "skills", skills }`, `{ type: "someCondition", conditions }` and the rest.
 */
export type PlayerRequirement = { type: string } & Record<string, unknown>;

/** A faction, as the pinned game defines it (#193, `Faction/FactionInfo.tsx`): `FACTIONS`, in faction-data.ts. */
export interface FactionData {
  /** Joining it bans these for the rest of the BitNode run (`FactionHelpers.tsx:44-47`). */
  enemies: readonly string[];
  /**
   * All must hold for an invitation, as the game reports them in BN1 with nothing backdoored. Two depend on the run:
   * Daedalus's augmentation count is the BitNode's (`daedalusAugmentationsRequired`), and a megacorp's company
   * reputation is 3/4 once its server is backdoored (`Company/utils.ts:15-19`, `Constants.ts:110`).
   */
  inviteRequirements: readonly PlayerRequirement[];
  /** The work it offers, in the game's order. */
  workTypes: readonly FactionWorkType[];
  /** Whether membership survives an install (the megacorps' factions, `keepOnInstall`). */
  keepOnInstall: boolean;
}

/**
 * The installed augmentations Daedalus's invitation needs in the current BitNode (`FactionInfo.tsx:141-142`): its
 * `DaedalusAugsRequirement`, 30 but in BN6 and BN7 (35), BN12 (with its level) and BN15 (20). Queued ones don't count,
 * and NeuroFlux Governor counts once (`FactionJoinCondition.ts:116-131`).
 */
export function daedalusAugmentationsRequired(currentNode: number, ownedSF: Readonly<Record<string, number>>): number {
  return augmentationBitNodeMultipliers(currentNode, ownedSF).DaedalusAugsRequirement;
}

/** Home worker: joins a faction through the game's Factions page (#147). */
export const JOIN_FACTION_WORKER_NAME = "join-faction.js";
