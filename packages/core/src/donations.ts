/**
 * Favour and donations (#225, M4 phase A): the game's formulas for a faction's favour, banked at each install, and for
 * the reputation money buys once the favour unlocks donations. Shared by A5's work target, A6's purchases and the
 * run report; checked against the engine's `ns.formulas.reputation` (the brain's parity suite).
 * - Favour: `favorToRep`/`repToFavor` (`Faction/formulas/favor.ts:7-24`); at an install each faction's favour becomes
 *   `repToFavor(favorToRep(favour) + reputation)` (`Faction.ts:77-80`, `Prestige.ts:104-106`) and its reputation 0.
 * - Donations unlock at `floor(150 × FavorToDonateToFaction)` favour (`favorNeededToDonate`, `donation.ts:16-18`):
 *   150 in BN1, 75 in BN3, 0 in BN8 (always), 150 × 1.02^level in BN12 (`BitNode/BitNode.tsx:617`, `:782`, `:969`).
 * - A donation of `amount` gives `amount / 1e6 × faction_rep × FactionWorkRepGain` reputation (`donation.ts:8-14`);
 *   favour doesn't multiply it.
 * - Who takes one (`NetscriptFunctions/Singularity.ts:925-964`; the page shows `DonateOption` on the same terms,
 *   `Faction/ui/FactionRoot.tsx:94-143`): a joined faction, not the player's gang's, that offers work (not Bladeburners,
 *   Church of the Machine God or Shadows of Anarchy), with the favour.
 */
import { FACTIONS } from "./faction-data.ts";

/** The most favour a faction can have (`favor.ts:7`). */
export const MAX_FAVOR = 35331;
/** The nearest double to ln 1.02, as the game has it (`favor.ts:8-10`): not `Math.log(1.02)`. */
const LOG_1_POINT_02 = 0.019802627296179712;
/** `BaseFavorToDonate` (`Constants.ts:31`). */
export const BASE_FAVOR_TO_DONATE = 150;
/** `DonateMoneyToRepDivisor` (`Constants.ts:33`): $1m of donation is 1 reputation before the multipliers. */
export const DONATE_MONEY_TO_REPUTATION_DIVISOR = 1e6;

/** The reputation `favor` is worth (`favorToRep`, `favor.ts:12-15`), in the game's order of operations. */
export function favorToRep(favor: number): number {
  return Math.max(0, 25000 * Math.expm1(LOG_1_POINT_02 * favor));
}

/** The favour `reputation` is worth (`repToFavor`, `favor.ts:17-20`), never above `MAX_FAVOR`. */
export function repToFavor(reputation: number): number {
  return Math.min(MAX_FAVOR, Math.max(0, Math.log1p(reputation / 25000) / LOG_1_POINT_02));
}

/** A faction's favour after the next install, with `reputation` earned this cycle (`addRepToFavor`, `favor.ts:22-24`). */
export function favorAfterInstall(favor: number, reputation: number): number {
  return repToFavor(favorToRep(favor) + reputation);
}

/** The BitNode's multiplier on the favour donations need (`BitNode/BitNodeMultipliers.ts:143`). */
export interface DonationBitNodeMultipliers {
  FavorToDonateToFaction: number;
}

/** The favour that unlocks donations (`favorNeededToDonate`, `donation.ts:16-18`). */
export function favorToDonate({ FavorToDonateToFaction }: DonationBitNodeMultipliers): number {
  return Math.floor(BASE_FAVOR_TO_DONATE * FavorToDonateToFaction);
}

/** Whether `favor` unlocks donations now: the game's own comparison (`Singularity.ts:948`, `FactionRoot.tsx:104`). */
export function donationsUnlocked(favor: number, multipliers: DonationBitNodeMultipliers): boolean {
  return favor >= favorToDonate(multipliers);
}

/**
 * The reputation to earn this cycle for the favour at the next install to unlock donations: 0 if `favor` does already;
 * else the least whole reputation that does, by the game's own floating point (`favorAfterInstall`). From no favour in
 * BN1, 462,491.
 */
export function reputationToUnlockDonations(favor: number, multipliers: DonationBitNodeMultipliers): number {
  const needed = favorToDonate(multipliers);
  // Unlocked already: favour's worth past the threshold's makes this 0.
  let reputation = Math.max(0, Math.ceil(favorToRep(needed) - favorToRep(favor)));
  while (favorAfterInstall(favor, reputation) < needed) reputation += 1;
  return reputation;
}

/** The reputation a donation of `amount` gives (`repFromDonation`, `donation.ts:8-10`). */
export function repFromDonation(amount: number, factionRep: number, factionWorkRepGain: number): number {
  return (amount / DONATE_MONEY_TO_REPUTATION_DIVISOR) * factionRep * factionWorkRepGain;
}

/** The donation that gives `reputation`, exactly (`donationForRep`, `donation.ts:12-14`). */
export function donationForReputation(reputation: number, factionRep: number, factionWorkRepGain: number): number {
  return (reputation * DONATE_MONEY_TO_REPUTATION_DIVISOR) / factionRep / factionWorkRepGain;
}

/**
 * Reputation a donation gives beyond what's missing: the game adds it to the faction's (`donation.ts:28`), and a sum
 * can round a hair below the price, which a worker would see as not done and donate again.
 */
export const DONATION_REPUTATION_MARGIN = 0.01;

/**
 * The least whole-dollar donation whose reputation, by the game's own formula, is at least `reputation` and
 * `DONATION_REPUTATION_MARGIN` more: what the brain donates, and plans to, so the faction's reputation reaches the
 * price, never a hair short of it. 0 for none missing.
 */
export function donationToReach(reputation: number, factionRep: number, factionWorkRepGain: number): number {
  if (!(reputation > 0)) return 0;
  const wanted = reputation + DONATION_REPUTATION_MARGIN;
  let amount = Math.ceil(donationForReputation(wanted, factionRep, factionWorkRepGain));
  while (repFromDonation(amount, factionRep, factionWorkRepGain) < wanted) amount += 1;
  return amount;
}

/**
 * Whether `faction` takes donations at all once joined (`Singularity.ts:925-944`): not the player's gang's
 * (`gangFaction`, or null), and one that offers work. Its favour is the caller's (`donationsUnlocked`).
 */
export function acceptsDonations(faction: string, gangFaction: string | null): boolean {
  if (faction === gangFaction || !Object.hasOwn(FACTIONS, faction)) return false;
  return (FACTIONS[faction]?.workTypes.length ?? 0) > 0;
}

/** Home worker: donates to a faction through the game's page (#225). */
export const DONATE_TO_FACTION_WORKER_NAME = "donate-to-faction.js";
