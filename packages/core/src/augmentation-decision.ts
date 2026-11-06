/**
 * A6's decision before the commit (#210, #222, #225, #215), moved from the brain to core (#260) so the brain and the
 * fast model (packages/model) make the one decision: what the joined factions sell and which of it is reached
 * (`augmentationShops`), A8's endgame ahead of the count rule (`augmentationEndgame`), and the counts and the rule on a
 * set (`installJudgement`). Pure, from core's functions; the brain's rule (packages/brain/src/augmentations.ts) adds
 * what's stateful (the countdown, the commit, the purchases reported, the reserve's lookahead) and the words.
 */
import {
  type AugmentationSet,
  affordableCounts,
  type CountedPurchases,
  type Donation,
  type DonationTerms,
  daedalusCountOf,
  type InstallRule,
  installRule,
  isWorthInstalling,
} from "./augmentation-plan.ts";
import {
  type AugmentationPurchaseState,
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
} from "./augmentations.ts";
import { THE_RED_PILL } from "./bitnodes.ts";
import { acceptsDonations, donationsUnlocked, donationToReach } from "./donations.ts";
import type { JoinedFaction } from "./faction-state.ts";
import { redPillTarget } from "./faction-work-choice.ts";
import { DAEDALUS, type DaedalusFigures, daedalusMissing, daedalusRequirements, FACTION_NAMES } from "./factions.ts";

/** What the joined factions sell, and of it what a joined seller's reputation reaches, not owned. */
export interface AugmentationShops {
  /** The joined factions core knows, and each one's shop (`augmentationsSoldBy`). */
  joined: JoinedFaction[];
  shops: Map<string, string[]>;
  /** Every augmentation they sell but NeuroFlux Governor, each once. */
  sold: string[];
  /** Of `sold`, those not owned whose reputation a joined seller has. */
  reached: string[];
  /** The joined seller with the most reputation covering what `augmentation` needs now, or null. */
  sellerOf: (augmentation: string) => string | null;
  reputationOf: (faction: string) => number;
  /** The most reputation at a joined faction selling NeuroFlux Governor: its levels' reach (`affordableCounts`). */
  neuroFluxReputation: number;
}

/** The joined factions' shops (A6's, #210): `owned` is installed or in the queue the plan counts. */
export function augmentationShops(
  joined: readonly JoinedFaction[],
  currentNode: number,
  state: AugmentationPurchaseState,
  owned: (name: string) => boolean,
): AugmentationShops {
  const known = joined.filter((faction) => FACTION_NAMES.includes(faction.name));
  const shops = new Map(known.map((faction) => [faction.name, augmentationsSoldBy(faction.name, currentNode, null)]));
  const reputationOf = (faction: string) => known.find((each) => each.name === faction)?.reputation ?? 0;
  const sellerOf = (augmentation: string): string | null => {
    const needed = augmentationCost(augmentation, state).reputation;
    let best: string | null = null;
    for (const [faction, shop] of shops) {
      if (
        shop.includes(augmentation) &&
        reputationOf(faction) >= needed &&
        (best === null || reputationOf(faction) > reputationOf(best))
      ) {
        best = faction;
      }
    }
    return best;
  };
  const sold = [...new Set([...shops.values()].flat())].filter((name) => name !== NEUROFLUX_GOVERNOR);
  const neuroFluxReputation = Math.max(
    0,
    ...[...shops].filter(([, shop]) => shop.includes(NEUROFLUX_GOVERNOR)).map(([faction]) => reputationOf(faction)),
  );
  return {
    joined: known,
    shops,
    sold,
    reached: sold.filter((name) => !owned(name) && sellerOf(name) !== null),
    sellerOf,
    reputationOf,
    neuroFluxReputation,
  };
}

/** Why the endgame holds every install (the brain words each). */
export type EndgameHold =
  /** The Red Pill installed: an install would reset the level w0r1d_d43m0n needs (the destroy wanted). */
  | { why: "destroy" }
  /** The Red Pill reported bought but not queued (`augmentationNotQueued`): no install without it. */
  | { why: "redPillNotQueued" }
  /** The Red Pill's donation at `faction` (unlocked) for `amount`, more than the money. */
  | { why: "redPill"; donation: { faction: string; amount: number }; money: number }
  /** The Red Pill's reputation short at its best seller: an install would lose it. */
  | { why: "redPill"; seller: { faction: string; reputation: number; needed: number } }
  /** Daedalus's invitation waiting on its money alone (what's missing, `daedalusMissing`'s words). */
  | { why: "daedalus"; missing: string[] };

/** A8's endgame (#215, #225): The Red Pill's install, "Daedalus donations", a hold, or none (the count rule's turn). */
export type Endgame =
  | { kind: "redPill"; donation: Donation | null }
  | { kind: "daedalusDonations" }
  | ({ kind: "hold"; reserve: number } & EndgameHold)
  | { kind: "none" };

/**
 * The Red Pill's way ahead of an ordinary install (#215; the brain's `#endgame`):
 * - installed: a hold for the destroy (`destroyWanted`), else none;
 * - in what an install would install, or reached at a joined seller: install it;
 * - reported bought but not queued: a hold;
 * - a seller with donations unlocked (#225): its donation when the money covers it, else a hold reserving it;
 * - Daedalus's reputation this cycle unlocks its donations at the next install (`redPillTarget`): "Daedalus donations";
 * - a seller joined, its reputation short: a hold (an install would lose it);
 * - Daedalus's invitation missing nothing but its money: a hold reserving the money;
 * - else none.
 */
export function augmentationEndgame({
  installed,
  installable,
  queue,
  state,
  shops,
  money,
  factionRep,
  figures,
  currentNode,
  ownedSF,
  destroyWanted,
}: {
  installed: Readonly<Record<string, number>>;
  /** What an install would install, and the queue the plan counts. */
  installable: readonly string[];
  queue: readonly string[];
  state: AugmentationPurchaseState;
  shops: AugmentationShops;
  money: number;
  factionRep: number;
  /** The player's skills and money, for Daedalus's invitation (its count is `installed`'s). */
  figures: Omit<DaedalusFigures, "augmentations">;
  currentNode: number;
  ownedSF: Readonly<Record<string, number>>;
  destroyWanted: boolean;
}): Endgame {
  if (Object.hasOwn(installed, THE_RED_PILL)) {
    return destroyWanted ? { kind: "hold", why: "destroy", reserve: 0 } : { kind: "none" };
  }
  if (installable.includes(THE_RED_PILL)) return { kind: "redPill", donation: null };
  if (queue.includes(THE_RED_PILL)) return { kind: "hold", why: "redPillNotQueued", reserve: 0 };
  const needed = augmentationCost(THE_RED_PILL, state).reputation;
  const sellers = [...shops.shops].filter(([, shop]) => shop.includes(THE_RED_PILL)).map(([faction]) => faction);
  if (sellers.some((faction) => shops.reputationOf(faction) >= needed)) return { kind: "redPill", donation: null };
  const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
  const sellerFactions = shops.joined.filter((faction) => sellers.includes(faction.name));
  // No gang is modelled (none in BN1): the gang's faction would take none.
  const donor = sellerFactions.find(
    (faction) => acceptsDonations(faction.name, null) && donationsUnlocked(faction.favor, multipliers),
  );
  if (donor !== undefined) {
    const amount = donationToReach(needed - donor.reputation, factionRep, multipliers.FactionWorkRepGain);
    if (money >= amount) return { kind: "redPill", donation: { faction: donor.name, reputation: needed, amount } };
    return { kind: "hold", why: "redPill", reserve: amount, donation: { faction: donor.name, amount }, money };
  }
  // Daedalus's favour (#225, legacy `autopilot.js:920-931`): its reputation this cycle unlocks its donations at the
  // next install, A5's target for it (`redPillTarget`: not once 90% of The Red Pill's is earned).
  const daedalus = sellerFactions.find((faction) => faction.name === DAEDALUS);
  const target = daedalus === undefined ? null : redPillTarget(needed, daedalus, multipliers.FavorToDonateToFaction);
  if (daedalus !== undefined && target?.reason === "donations" && daedalus.reputation >= target.reputation) {
    return { kind: "daedalusDonations" };
  }
  if (sellers.length > 0) {
    const best = sellers.reduce((most, each) => (shops.reputationOf(each) > shops.reputationOf(most) ? each : most));
    return {
      kind: "hold",
      why: "redPill",
      reserve: 0,
      seller: { faction: best, reputation: shops.reputationOf(best), needed },
    };
  }
  if (!augmentationsSoldBy(DAEDALUS, currentNode, null).includes(THE_RED_PILL)) return { kind: "none" };
  const required = daedalusRequirements(currentNode, ownedSF);
  // Installed as Daedalus counts them (#228, core's `daedalusCountOf`): NeuroFlux Governor once.
  const count = daedalusCountOf({ currentNode, ownedSF, installed, joined: shops.joined, invitations: [] });
  const missing = daedalusMissing({ ...figures, augmentations: count.installed }, required);
  // Held only with nothing but the money missing: a count or a skill short is missing too.
  const onlyMoney = missing.length === 0 || (missing.length === 1 && figures.money < required.money);
  if (!onlyMoney) return { kind: "none" };
  return { kind: "hold", why: "daedalus", reserve: required.money, missing };
}

/**
 * The counts and the count rule on `set`, bought with `money` (#222; the brain's `judge`): the counts are of what an
 * install would really install (`installable`, never an `augmentationNotQueued`, #222 review), and nothing left is no
 * augmentation worth installing at the joined factions, not owned or in the set, that could be bought after it (its
 * prerequisites owned, queued or in the set).
 */
export function installJudgement({
  state,
  installable,
  set,
  money,
  shops,
  owned,
  terms,
  short,
  onlineMs,
  sinceResetMs,
}: {
  state: AugmentationPurchaseState;
  installable: readonly string[];
  set: AugmentationSet;
  money: number;
  shops: AugmentationShops;
  owned: (name: string) => boolean;
  terms: DonationTerms | undefined;
  short: boolean;
  onlineMs: number;
  sinceResetMs: number;
}): { counts: CountedPurchases; rule: InstallRule } {
  const names = set.purchases.map((purchase) => purchase.name);
  const counts = affordableCounts({
    state,
    installable,
    set,
    money,
    neuroFluxReputation: shops.neuroFluxReputation,
    donations: terms,
    short,
  });
  const afterSet = { installed: state.installed, queued: [...state.queued, ...names] };
  const left = shops.sold.filter(
    (name) =>
      isWorthInstalling(name, short) &&
      !owned(name) &&
      !names.includes(name) &&
      missingPrerequisites(name, afterSet).length === 0,
  );
  const rule = installRule({
    onlineMs,
    sinceResetMs,
    installing: installable.length + names.length,
    neuroFluxLevels: counts.neuroFluxLevels,
    nothingLeft: left.length === 0,
    affordable: counts.affordable,
    affordableWithNeuroFlux: counts.affordableWithNeuroFlux,
  });
  return { counts, rule };
}
