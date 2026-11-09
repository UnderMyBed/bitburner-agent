/**
 * #247's "favour first", a faction work policy beside today's "count first": once the faction selling the most
 * countable augmentations not installed is joined, its work goes toward the favour that unlocks its donations
 * (`reputationToUnlockDonations`, 150 in BN1, `Faction/formulas/favor.ts`), A6 buying from it as reputation allows.
 * Computed from the game's data and formulas (owner decision 46); the brain's setting picks the policy (default count
 * first), and the fast model's `FAVOUR_FIRST_POLICY` (packages/model/src/compare.ts) grinds at the same faction.
 */
import { type DaedalusCount, isWorthInstalling } from "./augmentation-plan.ts";
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
} from "./augmentations.ts";
import { HACKER_FACTION_SERVERS } from "./backdoors.ts";
import { acceptsDonations, reputationToUnlockDonations } from "./donations.ts";
import type { FactionState } from "./faction-state.ts";
import type { WorkingPerson } from "./faction-work.ts";
import {
  bestWorkRate,
  type FactionWorkChoice,
  factionWorkChoice,
  redPillWork,
  type WorkConditions,
  type WorkResetInfo,
} from "./faction-work-choice.ts";
import { TIAN_DI_HUI } from "./factions.ts";

/** The brain's faction work policies (#247): today's "count first", and "favour first". */
export const FACTION_WORK_POLICIES = ["countFirst", "favourFirst"] as const;
export type FactionWorkPolicy = (typeof FACTION_WORK_POLICIES)[number];

export const isFactionWorkPolicy = (value: unknown): value is FactionWorkPolicy =>
  FACTION_WORK_POLICIES.includes(value as FactionWorkPolicy);

/** The policy in words: "count first" or "favour first". */
export function describeFactionWorkPolicy(policy: FactionWorkPolicy): string {
  return policy === "countFirst" ? "count first" : "favour first";
}

/**
 * The factions favour first chooses among: the hacker factions (`HACKER_FACTION_SERVERS`, each joined by a backdoor) and
 * Tian Di Hui, those a run joins every cycle before Daedalus with nothing banned. The city factions ban each other
 * (`Faction/FactionInfo.tsx:495-555`), and Daedalus asks for the count favour first would delay.
 */
export const FAVOUR_FIRST_FACTIONS: readonly string[] = [
  ...HACKER_FACTION_SERVERS.map((each) => each.faction),
  TIAN_DI_HUI,
];

/**
 * The faction favour first grinds at, joined or not: of `FAVOUR_FIRST_FACTIONS`, the one selling the most countable
 * augmentations (core's `isWorthInstalling`: a hacking value) not in `installed`, the first in that order on a tie
 * (CyberSec when none sells one: its work is then none, `favourFirstWork`; the fast model's grind goes on there). In BN1 from nothing installed, BitRunners' 12 (CyberSec 5, NiteSec 10, The Black Hand 9, Tian
 * Di Hui 2 by the same count).
 */
export function favourFirstFaction(
  currentNode: number,
  installed: Readonly<Record<string, number>>,
): { faction: string; countable: string[] } {
  let best: { faction: string; countable: string[] } | null = null;
  for (const faction of FAVOUR_FIRST_FACTIONS) {
    const countable = augmentationsSoldBy(faction, currentNode, null).filter(
      (name) => isWorthInstalling(name) && !Object.hasOwn(installed, name),
    );
    if (best === null || countable.length > best.countable.length) best = { faction, countable };
  }
  return best as { faction: string; countable: string[] };
}

/**
 * Favour first's work, or null for A5's own choice: at `favourFirstFaction`, joined, its best work type, to the
 * reputation that unlocks its donations at the next install. Null where it isn't joined, takes no donations, offers no
 * work, has that reputation already (or its donations unlocked), or with donations off (the Augmentations switch: no
 * install follows). The choice names the augmentation the donations open the most reputation for: the countable one
 * there, neither installed nor queued, with the most reputation (core's `augmentationCost`).
 */
export function favourFirstWork(
  person: WorkingPerson,
  state: FactionState,
  resetInfo: WorkResetInfo,
  conditions: WorkConditions,
): FactionWorkChoice | null {
  if (conditions.donations === false) return null;
  const { currentNode, ownedAugs, ownedSF } = resetInfo;
  const chosen = favourFirstFaction(currentNode, ownedAugs);
  const faction = state.joined.find((each) => each.name === chosen.faction);
  if (faction === undefined || !acceptsDonations(faction.name, null)) return null;
  const target = reputationToUnlockDonations(faction.favor, {
    FavorToDonateToFaction: conditions.favorToDonateToFaction,
  });
  if (!Number.isFinite(target) || faction.reputation >= target) return null;
  const rate = bestWorkRate(person, faction, conditions);
  if (rate === null) return null;
  const purchaseState: AugmentationPurchaseState = {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  let top: { name: string; reputation: number } | null = null;
  for (const name of chosen.countable) {
    if (state.queuedAugmentations.includes(name)) continue;
    const { reputation } = augmentationCost(name, purchaseState);
    if (top === null || reputation > top.reputation) top = { name, reputation };
  }
  // None countable left there, or every one queued (A6 installs them): nothing for the donations to buy.
  if (top === null) return null;
  return {
    faction: faction.name,
    workType: rate.workType,
    augmentation: top.name,
    reputation: faction.reputation,
    reputationNeeded: target,
    reputationPerSecond: rate.perSecond,
    etaSeconds: (target - faction.reputation) / rate.perSecond,
    target: "donations",
    augmentationReputation: top.reputation,
    favor: faction.favor,
    favourFirst: true,
  };
}

/**
 * The faction work to do now under `policy`: count first is core's `factionWorkChoice` as it is; favour first puts
 * `favourFirstWork` after The Red Pill's work (it ends the BitNode) and ahead of the rest. The fast model's
 * `favourGrind` comes before The Red Pill's too: no BN1 run joins Daedalus before the grind is done.
 */
export function factionWorkChoiceUnder(
  policy: FactionWorkPolicy,
  person: WorkingPerson,
  state: FactionState,
  resetInfo: WorkResetInfo,
  conditions: WorkConditions,
  count: DaedalusCount,
  held: { faction: string; augmentation: string } | null = null,
): FactionWorkChoice | null {
  if (policy === "favourFirst") {
    const first =
      redPillWork(person, state, resetInfo, conditions) ?? favourFirstWork(person, state, resetInfo, conditions);
    if (first !== null) return first;
  }
  return factionWorkChoice(person, state, resetInfo, conditions, count, held);
}
