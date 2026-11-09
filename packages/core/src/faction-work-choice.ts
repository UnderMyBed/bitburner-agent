/**
 * The brain's choice of faction work (#203, M4 phase A slice A5), moved from the brain to core (#260) so the fast model
 * (packages/model) makes the same choice from its own state: pure, from the game's formulas (owner decision 46). The
 * brain's rule (packages/brain/src/factions.ts) reads the snapshots and calls `factionWorkChoice`.
 * - An augmentation's hacking value is core's `hackingValue`. Of those a joined faction sells, not installed, queued or
 *   already within a joined seller's reputation, the one with the most value per second of work to reach its
 *   reputation, by the game's rate (core's `factionReputationPerSecond`) for the faction's best work type. NeuroFlux
 *   Governor is A6's: sold everywhere, it never runs out.
 * - The Red Pill first (#215, A8): once a joined faction (Daedalus) sells it, neither installed nor queued, and its
 *   reputation isn't reached, the work is for it, ahead of any hacking value: it ends the BitNode.
 * - Working toward donation favour (#225, owner decision 53; legacy `work-for-factions.js:897-918`, `:929-930`): at a
 *   faction that takes donations, the work goes to the lesser of the augmentation's reputation and the reputation that
 *   unlocks donations at the next install (`workTarget`), the augmentation's if it's within 10% of the larger of that
 *   and the reputation now. A faction whose donations are unlocked isn't worked, nor an augmentation one sells.
 * - Short of Daedalus's count (#228, core's `daedalusCountOf`): every augmentation but NeuroFlux Governor and The Red
 *   Pill is a candidate (core's `isWorthInstalling`). Those with a hacking value still go first, by value a second;
 *   with none left to work for, the soonest reached of the rest, the work saying it's for the count.
 * - An install A6 holds for Daedalus's count (#243): the held augmentation's seller first (`heldWork`).
 */
import { type DaedalusCount, isWorthInstalling } from "./augmentation-plan.ts";
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
} from "./augmentations.ts";
import { THE_RED_PILL } from "./bitnodes.ts";
import { acceptsDonations, reputationToUnlockDonations } from "./donations.ts";
import { FACTIONS } from "./faction-data.ts";
import type { FactionState, JoinedFaction } from "./faction-state.ts";
import { factionReputationPerSecond, hackingValue, type WorkingPerson } from "./faction-work.ts";
import { FACTION_NAMES } from "./factions.ts";
import type { FactionWorkType } from "./work.ts";

/** The brain's choice of faction work, and why: the augmentation it works for, and when it's reached. */
export interface FactionWorkChoice {
  faction: string;
  workType: FactionWorkType;
  /** The augmentation the work is for. */
  augmentation: string;
  /** The faction's reputation now (the slow snapshot's), and the reputation the work is for (`workTarget`'s). */
  reputation: number;
  reputationNeeded: number;
  /** The work's reputation a second, by the game's formula. */
  reputationPerSecond: number;
  /** Until the reputation is reached at that rate. */
  etaSeconds: number;
  /**
   * Why that reputation (#225): the augmentation's, or the reputation that unlocks the faction's donations at the next
   * install (then the augmentation's own is `augmentationReputation`). The faction's favour now. Absent in an earlier
   * brain's choice.
   */
  target?: WorkTarget["reason"];
  augmentationReputation?: number;
  favor?: number;
  /** Short of Daedalus's count (#228): the work is for the count, installed of required. Absent otherwise. */
  count?: Pick<DaedalusCount, "installed" | "required">;
  /** The work is for an install A6 holds for Daedalus's count (#243 review). Absent otherwise. */
  held?: true;
  /** The work is favour first's (#247, ./favour-first.ts): toward donations at the faction selling the most. */
  favourFirst?: true;
}

/** The reputation worked toward at a faction for an augmentation (#225), and why. */
export interface WorkTarget {
  reputation: number;
  reason: "augmentation" | "donations";
}

/**
 * Within this share of the larger of the reputation that unlocks donations and the reputation now, the augmentation's
 * reputation is worked all the way to (legacy `work-for-factions.js:929-930`): it's soon reached, and bought at once.
 */
export const WORK_TO_AUGMENTATION_WITHIN = 1.1;

/**
 * The reputation to work toward at `faction` for an augmentation needing `augmentationReputation` (#225), or null where
 * the faction's donations are unlocked already: its reputation is bought, not earned (legacy `:916-919`).
 * - With `donations` false (the Augmentations switch off: no install or donation follows), the augmentation's.
 * - A faction taking no donations (`acceptsDonations`): the augmentation's.
 * - Else the lesser of it and the reputation this cycle that unlocks donations at the next install (core's
 *   `reputationToUnlockDonations`), unless the augmentation's is within `WORK_TO_AUGMENTATION_WITHIN` of the larger of
 *   that and the reputation now (legacy `:929-930`): then the augmentation's.
 */
export function workTarget(
  augmentationReputation: number,
  faction: JoinedFaction,
  favorToDonateToFaction: number,
  donations = true,
): WorkTarget | null {
  const augmentation: WorkTarget = { reputation: augmentationReputation, reason: "augmentation" };
  // No gang is modelled (none in BN1): the gang's faction would take none.
  if (!donations || !acceptsDonations(faction.name, null)) return augmentation;
  const unlock = reputationToUnlockDonations(faction.favor, { FavorToDonateToFaction: favorToDonateToFaction });
  if (unlock === 0) return null;
  if (augmentationReputation <= unlock) return augmentation;
  if (augmentationReputation <= WORK_TO_AUGMENTATION_WITHIN * Math.max(faction.reputation, unlock)) return augmentation;
  return { reputation: unlock, reason: "donations" };
}

/**
 * Daedalus's guard (legacy `work-for-factions.js:829`, `daedalusSpecialCheck`): from this share of The Red Pill's
 * reputation, it's earned to the end, never installed away for donations' favour.
 */
export const RED_PILL_EARNED_SHARE = 0.9;

/**
 * The reputation to work toward for The Red Pill at its seller (#225): `workTarget`'s, but The Red Pill's own once
 * `RED_PILL_EARNED_SHARE` of it is earned. A5's target and A6's "Daedalus donations" install both read it, so the
 * work never stops short where no install follows.
 */
export function redPillTarget(
  redPillReputation: number,
  faction: JoinedFaction,
  favorToDonateToFaction: number,
  donations = true,
): WorkTarget | null {
  const target = workTarget(redPillReputation, faction, favorToDonateToFaction, donations);
  if (target === null || faction.reputation < RED_PILL_EARNED_SHARE * redPillReputation) return target;
  return { reputation: redPillReputation, reason: "augmentation" };
}

/** The slow snapshot's reset info, as the rule needs it. */
export interface WorkResetInfo {
  currentNode: number;
  ownedAugs: Record<string, number>;
  ownedSF: Record<string, number>;
}

/** What a faction work rate depends on beyond the person and the faction: the run's figures and the focus. */
export interface WorkConditions {
  sourceFile15Level: number;
  /** As the work goes (decision 37, the brain's `workFocus`, packages/brain/src/work.ts). */
  focused: boolean;
  /** The Neuroreceptor Management Implant installed: unfocused at the full rate. */
  implant: boolean;
  /** The BitNode's (core's `augmentationBitNodeMultipliers`). */
  factionWorkRepGain: number;
  /** The BitNode's, on the favour that unlocks donations (#225). */
  favorToDonateToFaction: number;
  /** Donations to come (#225): the Augmentations switch on. Absent, they are. */
  donations?: boolean;
  /** The share threads' bonus while they run (#224, the brain's `shareBonusOf`, brain/src/share.ts); 1 absent. */
  shareBonus?: number;
  /**
   * The work sent now (#226's review): its faction keeps its work type unless another earns `WORK_TYPE_SWITCH_GAIN`
   * times as much, so the share's bonus, which the work type gets only part of, doesn't flip it to and fro.
   */
  keep?: { faction: string; workType: FactionWorkType };
}

/** How much more another work type must earn to replace the one worked (#226's review). */
export const WORK_TYPE_SWITCH_GAIN = 1.1;

/**
 * A faction's best work type and its reputation a second, by the game's formula (core's `factionReputationPerSecond`)
 * for each type it offers (core's `FACTIONS`); null for one that offers none, or earns nothing (#203; A6 too). The first
 * in the game's order wins a tie.
 */
export function bestWorkRate(
  person: WorkingPerson,
  faction: JoinedFaction,
  conditions: WorkConditions,
): { workType: FactionWorkType; perSecond: number } | null {
  const workTypes = FACTION_NAMES.includes(faction.name) ? (FACTIONS[faction.name]?.workTypes ?? []) : [];
  const { keep, ...rateConditions } = conditions;
  let best: { workType: FactionWorkType; perSecond: number } | null = null;
  let kept: { workType: FactionWorkType; perSecond: number } | null = null;
  for (const workType of workTypes) {
    const perSecond = factionReputationPerSecond(person, workType, { favor: faction.favor, ...rateConditions });
    if (best === null || perSecond > best.perSecond) best = { workType, perSecond };
    if (keep?.faction === faction.name && keep.workType === workType) kept = { workType, perSecond };
  }
  // The work type worked is kept while nothing earns `WORK_TYPE_SWITCH_GAIN` times as much (#226's review).
  if (kept !== null && best !== null && best.perSecond < kept.perSecond * WORK_TYPE_SWITCH_GAIN) best = kept;
  return best !== null && best.perSecond > 0 ? best : null;
}

/** An augmentation worth working for at a joined faction (`workCandidates`). */
export interface WorkCandidate {
  faction: string;
  augmentation: string;
  /** Core's `hackingValue`, at the player's hacking level. */
  value: number;
  /** Its reputation (core's `augmentationCost`), and the faction's now. */
  reputationNeeded: number;
  reputation: number;
  /** The reputation worked toward for it there (#225, `workTarget`): below `reputationNeeded` for donations' favour. */
  target: WorkTarget;
  favor: number;
}

/**
 * The augmentations worth working for (#203; A6 too), at each joined faction that sells them, in the order joined
 * factions and their shops list them: a hacking value at `hackingLevel` (core's `hackingValue`), neither installed nor
 * queued, not NeuroFlux Governor (A6's), each missing prerequisite sold by a joined faction, and its reputation not yet
 * reached at any joined faction that sells it (one reached is A6's to buy). Throws for what core doesn't know.
 * Donations (#225): not one a joined faction with donations unlocked sells (A6 buys its reputation), nor at such a
 * faction; and each at its faction's `workTarget`, not one already reached there.
 * `short` of Daedalus's count (#228): every augmentation core's `isWorthInstalling` counts then, whatever its value.
 */
export function workCandidates(
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  hackingLevel: number,
  donations = true,
  short = false,
): WorkCandidate[] {
  const { FavorToDonateToFaction } = augmentationBitNodeMultipliers(currentNode, ownedSF);
  // No gang is modelled (none in BN1): the gang's faction would take none.
  const unlocked = (faction: JoinedFaction) =>
    donations &&
    acceptsDonations(faction.name, null) &&
    reputationToUnlockDonations(faction.favor, { FavorToDonateToFaction }) === 0;
  const purchaseState: AugmentationPurchaseState = {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  };
  // A gang's faction isn't modelled (none in BN1): gangFaction null, so every shop is the faction's own list.
  const shops = new Map<string, string[]>();
  for (const { name } of state.joined) {
    if (FACTION_NAMES.includes(name)) shops.set(name, augmentationsSoldBy(name, currentNode, null));
  }
  const owned = (augmentation: string) =>
    Object.hasOwn(ownedAugs, augmentation) || state.queuedAugmentations.includes(augmentation);
  const soldByJoined = (augmentation: string) => [...shops].filter(([, shop]) => shop.includes(augmentation));
  const joinedOf = (faction: string) =>
    state.joined.find((each) => each.name === faction) ?? { name: faction, reputation: 0, favor: 0 };
  const reputationOf = (faction: string) => joinedOf(faction).reputation;
  const candidates: WorkCandidate[] = [];
  for (const [faction, shop] of shops) {
    for (const augmentation of shop) {
      if (augmentation === NEUROFLUX_GOVERNOR || owned(augmentation)) continue;
      const value = hackingValue(augmentation, hackingLevel);
      if (!(short ? isWorthInstalling(augmentation, true) : value > 0)) continue;
      const missing = missingPrerequisites(augmentation, purchaseState);
      if (!missing.every((prerequisite) => soldByJoined(prerequisite).length > 0)) continue;
      const reputationNeeded = augmentationCost(augmentation, purchaseState).reputation;
      if (soldByJoined(augmentation).some(([seller]) => reputationOf(seller) >= reputationNeeded)) continue;
      if (soldByJoined(augmentation).some(([seller]) => unlocked(joinedOf(seller)))) continue;
      const target = workTarget(reputationNeeded, joinedOf(faction), FavorToDonateToFaction, donations);
      if (target === null || reputationOf(faction) >= target.reputation) continue;
      const { favor } = joinedOf(faction);
      candidates.push({
        faction,
        augmentation,
        value,
        reputationNeeded,
        reputation: reputationOf(faction),
        target,
        favor,
      });
    }
  }
  return candidates;
}

/**
 * The work for The Red Pill (#215), or null: at the joined faction selling it (Daedalus; none in BN15) with the soonest
 * ETA at its best work, while it's neither installed nor queued and no joined seller's reputation reaches it (reached,
 * it's A6's to buy). Its reputation is core's `augmentationCost`: 2.5m in BN1 (`Augmentation/Augmentations.ts:1946`).
 * Donations (#225): worked to its seller's `redPillTarget`; none at a seller whose donations are unlocked (A8's way
 * buys the reputation), and none once the target is reached there (A6 installs for "Daedalus donations").
 */
export function redPillWork(
  person: WorkingPerson,
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  conditions: WorkConditions,
): FactionWorkChoice | null {
  if (Object.hasOwn(ownedAugs, THE_RED_PILL) || state.queuedAugmentations.includes(THE_RED_PILL)) return null;
  const sellers = state.joined.filter(
    (faction) =>
      FACTION_NAMES.includes(faction.name) &&
      augmentationsSoldBy(faction.name, currentNode, null).includes(THE_RED_PILL),
  );
  const reputationNeeded = augmentationCost(THE_RED_PILL, {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  }).reputation;
  if (sellers.some((faction) => faction.reputation >= reputationNeeded)) return null;
  let best: FactionWorkChoice | null = null;
  for (const faction of sellers) {
    const target = redPillTarget(reputationNeeded, faction, conditions.favorToDonateToFaction, conditions.donations);
    if (target === null || faction.reputation >= target.reputation) continue;
    const rate = bestWorkRate(person, faction, conditions);
    if (rate === null) continue;
    const etaSeconds = (target.reputation - faction.reputation) / rate.perSecond;
    if (best === null || etaSeconds < best.etaSeconds) {
      best = {
        faction: faction.name,
        workType: rate.workType,
        augmentation: THE_RED_PILL,
        reputation: faction.reputation,
        reputationNeeded: target.reputation,
        reputationPerSecond: rate.perSecond,
        etaSeconds,
        target: target.reason,
        augmentationReputation: reputationNeeded,
        favor: faction.favor,
      };
    }
  }
  return best;
}

/**
 * The work for an install A6 holds for Daedalus's count (#243 review): at the held augmentation's joined seller, its
 * best work type, to its reputation (A6 counts the hold on that work), ahead of hacking value; null if it isn't joined,
 * offers no work, or its reputation is reached (A6 buys it).
 */
export function heldWork(
  person: WorkingPerson,
  state: FactionState,
  { currentNode, ownedAugs, ownedSF }: WorkResetInfo,
  conditions: WorkConditions,
  held: { faction: string; augmentation: string },
  count: DaedalusCount,
): FactionWorkChoice | null {
  const faction = state.joined.find((each) => each.name === held.faction);
  if (faction === undefined || !FACTION_NAMES.includes(faction.name)) return null;
  const reputationNeeded = augmentationCost(held.augmentation, {
    installed: ownedAugs,
    queued: state.queuedAugmentations,
    sourceFile11Level: ownedSF["11"] ?? 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(currentNode, ownedSF),
  }).reputation;
  if (faction.reputation >= reputationNeeded) return null;
  const rate = bestWorkRate(person, faction, conditions);
  if (rate === null) return null;
  return {
    faction: faction.name,
    workType: rate.workType,
    augmentation: held.augmentation,
    reputation: faction.reputation,
    reputationNeeded,
    reputationPerSecond: rate.perSecond,
    etaSeconds: (reputationNeeded - faction.reputation) / rate.perSecond,
    target: "augmentation",
    augmentationReputation: reputationNeeded,
    favor: faction.favor,
    count: { installed: count.installed, required: count.required },
    held: true,
  };
}

/**
 * `chooseFactionWork`'s choice from figures already checked; null for none. Short of Daedalus's count (#228), every
 * candidate adds one to it: those with a hacking value first, by value a second; with none, the soonest reached, for
 * the count.
 */
export function bestCandidate(
  person: WorkingPerson,
  state: FactionState,
  resetInfo: WorkResetInfo,
  conditions: WorkConditions,
  count: DaedalusCount,
): FactionWorkChoice | null {
  const rates = new Map(state.joined.map((faction) => [faction.name, bestWorkRate(person, faction, conditions)]));
  let best: (FactionWorkChoice & { score: number }) | null = null;
  const all = workCandidates(state, resetInfo, person.skills.hacking, conditions.donations, count.short).filter(
    (candidate) => rates.get(candidate.faction),
  );
  const valued = all.filter((candidate) => candidate.value > 0);
  const forCount = valued.length === 0 && count.short;
  for (const candidate of forCount ? all : valued) {
    const rate = rates.get(candidate.faction);
    if (!rate) continue;
    const etaSeconds = (candidate.target.reputation - candidate.reputation) / rate.perSecond;
    const score = forCount ? -etaSeconds : candidate.value / etaSeconds;
    const better =
      best === null ||
      score > best.score ||
      (score === best.score && FACTION_NAMES.indexOf(candidate.faction) < FACTION_NAMES.indexOf(best.faction));
    if (better) {
      best = {
        faction: candidate.faction,
        workType: rate.workType,
        augmentation: candidate.augmentation,
        reputation: candidate.reputation,
        reputationNeeded: candidate.target.reputation,
        reputationPerSecond: rate.perSecond,
        etaSeconds,
        target: candidate.target.reason,
        augmentationReputation: candidate.reputationNeeded,
        favor: candidate.favor,
        ...(forCount ? { count: { installed: count.installed, required: count.required } } : {}),
        score,
      };
    }
  }
  if (best === null) return null;
  const { score: _score, ...choice } = best;
  return choice;
}

/**
 * The faction work to do now from figures already read (#203; #260 for the fast model): The Red Pill's work first
 * (`redPillWork`), then an install's hold for Daedalus's count (`heldWork`, with `held`), then the best candidate
 * (`bestCandidate`); null for none. The brain's `chooseFactionWork` calls it on the snapshots' figures.
 */
export function factionWorkChoice(
  person: WorkingPerson,
  state: FactionState,
  resetInfo: WorkResetInfo,
  conditions: WorkConditions,
  count: DaedalusCount,
  held: { faction: string; augmentation: string } | null = null,
): FactionWorkChoice | null {
  return (
    redPillWork(person, state, resetInfo, conditions) ??
    (held === null ? null : heldWork(person, state, resetInfo, conditions, held, count)) ??
    bestCandidate(person, state, resetInfo, conditions, count)
  );
}
