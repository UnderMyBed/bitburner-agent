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
  DAEDALUS_COUNT_HOLD_MS,
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
  /**
   * The joined factions core knows, and each one's shop (`augmentationsSoldBy`). The gang's faction (#334) is never in
   * `joined`, where work and donations look (the game offers neither there), but its shop is in `shops`.
   */
  joined: JoinedFaction[];
  shops: Map<string, string[]>;
  /** The gang's faction whose shop is in `shops`, or null (no gang). */
  gangFaction: string | null;
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

/**
 * The joined factions' shops (A6's, #210): `owned` is installed or in the queue the plan counts. `gang` (#334) is the
 * gang's faction as the slow snapshot reports it, its reputation the game's own (respect feeds it, `Gang.ts:144-155`),
 * or null: its shop, nearly every augmentation (`augmentationsSoldBy`'s), joins the others; never `joined`.
 */
export function augmentationShops(
  joined: readonly JoinedFaction[],
  currentNode: number,
  state: AugmentationPurchaseState,
  owned: (name: string) => boolean,
  gang: JoinedFaction | null = null,
): AugmentationShops {
  const known = joined.filter((faction) => FACTION_NAMES.includes(faction.name) && faction.name !== gang?.name);
  const shops = new Map(known.map((faction) => [faction.name, augmentationsSoldBy(faction.name, currentNode, null)]));
  if (gang !== null) shops.set(gang.name, augmentationsSoldBy(gang.name, currentNode, gang.name));
  const sellers = gang === null ? known : [...known, gang];
  const reputationOf = (faction: string) => sellers.find((each) => each.name === faction)?.reputation ?? 0;
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
    gangFaction: gang?.name ?? null,
    sold,
    reached: sold.filter((name) => !owned(name) && sellerOf(name) !== null),
    sellerOf,
    reputationOf,
    neuroFluxReputation,
  };
}

/**
 * The longest A8 holds installs for The Red Pill at the gang's faction (#334): the hold for Daedalus's count's window,
 * one cycle less a margin (`DAEDALUS_COUNT_HOLD_MS`, 20 minutes). An install would lose the cycle's reputation there
 * (`Faction/Faction.ts:77-85`), and the gang, which earns it, stays (`Prestige.ts:133-146`); a hold saves the cycle that
 * would earn it again, less itself, and holds back the install's multipliers meanwhile.
 */
export const GANG_RED_PILL_HOLD_MS = DAEDALUS_COUNT_HOLD_MS;

/**
 * The time, ms, the gang's faction's `reputation` takes to reach `needed` at the cycle's rate (#334): its reputation
 * over `sinceResetMs`, the game's time since the last install, which reset it to 0 (`Faction/Faction.ts:77-85`). The
 * reputation is the game's own (respect feeds it, `Gang.ts:144-155`). Cautious: that time counts any while the game
 * was closed or before the gang formed, and the gang's rate grows over a cycle, so this is long, never short. 0 once
 * reached; Infinity with none earned or the time unread.
 */
export function gangRedPillEtaMs(reputation: number, needed: number, sinceResetMs: number | null): number {
  if (reputation >= needed) return 0;
  if (sinceResetMs === null || !(sinceResetMs > 0) || !(reputation > 0)) return Number.POSITIVE_INFINITY;
  return ((needed - reputation) / reputation) * sinceResetMs;
}

/** Why the endgame holds every install (the brain words each). */
export type EndgameHold =
  /** The Red Pill installed: an install would reset the level w0r1d_d43m0n needs (the destroy wanted). */
  | { why: "destroy" }
  /** The Red Pill reported bought but not queued (`augmentationNotQueued`): no install without it. */
  | { why: "redPillNotQueued" }
  /** The Red Pill's donation at `faction` (unlocked) for `amount`, more than the money. */
  | { why: "redPill"; donation: { faction: string; amount: number }; money: number }
  /**
   * The Red Pill's reputation short at its best seller: an install would lose it. At the gang's faction (#334), with
   * `etaMs`, the time to it at the cycle's rate (`gangRedPillEtaMs`), within `GANG_RED_PILL_HOLD_MS`.
   */
  | { why: "redPill"; seller: { faction: string; reputation: number; needed: number; etaMs?: number } }
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
 * - a seller joined, its reputation short: a hold (an install would lose it); but at the gang's faction (#334) only
 *   while its reputation reaches The Red Pill's within `GANG_RED_PILL_HOLD_MS` at the cycle's rate
 *   (`gangRedPillEtaMs`, `sinceResetMs` the game's time since the last install, null unread: no hold);
 * - the gang's faction selling it (BN2), none: Daedalus isn't needed;
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
  sinceResetMs = null,
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
  /** The game's time since the last install, for the gang's faction's rate (#334); null or absent, unread. */
  sinceResetMs?: number | null;
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
  // The gang's faction is never in `joined` (#334): it takes no donations, and isn't Daedalus.
  const sellerFactions = shops.joined.filter((faction) => sellers.includes(faction.name));
  const donor = sellerFactions.find(
    (faction) => acceptsDonations(faction.name, shops.gangFaction) && donationsUnlocked(faction.favor, multipliers),
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
  // The gang's faction (#334): held for only while its reputation reaches The Red Pill's soon.
  const gangEtaMs =
    shops.gangFaction !== null && sellers.includes(shops.gangFaction)
      ? gangRedPillEtaMs(shops.reputationOf(shops.gangFaction), needed, sinceResetMs)
      : null;
  const holding = sellers.filter(
    (each) => each !== shops.gangFaction || (gangEtaMs ?? Infinity) <= GANG_RED_PILL_HOLD_MS,
  );
  if (holding.length > 0) {
    const best = holding.reduce((most, each) => (shops.reputationOf(each) > shops.reputationOf(most) ? each : most));
    const seller = { faction: best, reputation: shops.reputationOf(best), needed };
    return {
      kind: "hold",
      why: "redPill",
      reserve: 0,
      seller: best === shops.gangFaction && gangEtaMs !== null ? { ...seller, etaMs: gangEtaMs } : seller,
    };
  }
  // Sold by the gang's faction (BN2), Daedalus's invitation isn't needed for it.
  if (shops.gangFaction !== null && sellers.includes(shops.gangFaction)) return { kind: "none" };
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
