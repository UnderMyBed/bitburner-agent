/**
 * What's within reach for A6 beyond a joined seller's reputation (#225, #243), moved from the brain to core (#260) so
 * the fast model (packages/model) counts the same: the donation terms (who takes a donation for what), and each
 * augmentation still to come for Daedalus's count, with when it can be bought. Pure, from the game's formulas (owner
 * decision 46); the brain's A6 rule (packages/brain/src/augmentations.ts) reads the snapshots and calls them.
 */
import {
  type AugmentationSet,
  augmentationBuyOrder,
  type CountableToCome,
  type DonationSeller,
  type DonationTerms,
} from "./augmentation-plan.ts";
import {
  type AugmentationPurchaseState,
  augmentationCost,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
} from "./augmentations.ts";
import { THE_RED_PILL } from "./bitnodes.ts";
import { acceptsDonations, donationsUnlocked, donationToReach } from "./donations.ts";
import type { JoinedFaction } from "./faction-state.ts";
import { factionReputationPerSecond, type WorkingPerson } from "./faction-work.ts";
import { bestWorkRate, type WorkConditions } from "./faction-work-choice.ts";
import { INVITATION_CHECK_MS, NETBURNERS } from "./hacknet.ts";
import type { Work } from "./work.ts";

/** `Omit` over each member of a union, not over their common fields. */
type OmitEach<Union, Key extends PropertyKey> = Union extends unknown ? Omit<Union, Key> : never;

/**
 * What buying with donations needs now (#225): the joined factions taking donations with them unlocked (never the
 * gang's, `gangFaction`, #334: the brain leaves it out of `joined` anyway, a report may not), selling each of `wanted`
 * (augmentations no joined seller's reputation reaches) and NeuroFlux Governor, and the multipliers on a donation's
 * reputation.
 */
export function donationTermsOf(
  joined: readonly JoinedFaction[],
  shops: ReadonlyMap<string, readonly string[]>,
  wanted: readonly string[],
  factionRep: number,
  multipliers: { FactionWorkRepGain: number; FavorToDonateToFaction: number },
  gangFaction: string | null = null,
): DonationTerms {
  const donors = joined.filter(
    (faction) => acceptsDonations(faction.name, gangFaction) && donationsUnlocked(faction.favor, multipliers),
  );
  const sellersOf = (name: string): DonationSeller[] =>
    donors
      .filter((faction) => shops.get(faction.name)?.includes(name))
      .map(({ name: faction, reputation }) => ({ faction, reputation }));
  const sellers: Record<string, DonationSeller[]> = {};
  for (const name of wanted) {
    const each = sellersOf(name);
    if (each.length > 0) sellers[name] = each;
  }
  return {
    sellers,
    neuroFluxSellers: sellersOf(NEUROFLUX_GOVERNOR),
    factionRep,
    factionWorkRepGain: multipliers.FactionWorkRepGain,
  };
}

/**
 * One to come for Daedalus's count (#243), with its money: what it adds to the set's, and any donation. By work, its
 * work's time alone (`workMs`, #343: its reputation at the rate, the money aside), as the work at one faction at a time
 * adds up. `beforeJoinMs` (#387): sold by a faction not joined yet, the time to its invitation, in `workMs` too.
 */
export type CountableWithMoney = CountableToCome & { money: number; workMs?: number; beforeJoinMs?: number };

/**
 * Netburners before it's joined (#387): its Hacknet setup's money (0 once bought) and whether it has invited. Its
 * countables come by A5's work there once it's joined, after the setup's money at the income and the game's check for
 * invitations (`INVITATION_CHECK_MS`); none before hacking 80, its invitation's other need, as the time to that isn't
 * known (the caller passes none then: cautious for waiting).
 */
export interface NetburnersRoute {
  /** What Netburners sells in the BitNode (core's `augmentationsSoldBy`). */
  sold: readonly string[];
  setupMoney: number;
  invited: boolean;
}

/**
 * Who works for a faction while an install is held (#243): the owner's work wins (only faction work at the seller
 * earns it reputation, at that work type); else A5 (its switch on) works for the held augmentation's seller.
 */
export interface HoldWork {
  owners: OmitEach<Work, "focus"> | null;
  brainWorks: boolean;
}

/**
 * Each augmentation a joined faction sells that would add one to Daedalus's count after an install (#243): not
 * NeuroFlux Governor or The Red Pill, not owned or queued (`state`'s queue) or in `set`, its prerequisites owned,
 * queued or in the set; and when it can be bought, by its soonest route, each the later of its reputation and its
 * money:
 * - reached at a joined seller (`way` "money"): its money alone;
 * - a donation (`terms`, at the seller whose donation is least, from its reputation now, #225): at once, with the
 *   donation's money; a seller the set already donates to is raised to the larger reputation, not both (as
 *   `planDonations` has it, legacy `faction-manager.js:891`), so only the difference is its;
 * - work, the sooner of that and a donation: only at a seller someone works for: the owner's faction work there, at
 *   its work type; or, with no owner's work and A5's switch on, A5 under the hold (`bestWorkRate`, the work's formula;
 *   since #345 with the share bonus `conditions` carry: the brain's mean over the income's window of the one measured,
 *   1 with none in it, cautious for waiting;
 *   the level's rise over the work left out: cautious for waiting, optimistic for installing now);
 * - its money: the set with it, in buy order (`augmentationBuyOrder`: a dear one goes first), with the set's donations
 *   and its own, beyond `money`, at `income` a second. With no income measured, only what `money` covers, unless
 *   `assumeMoney` (a hold's window already open: a restart or a gap lost the income for 10 minutes), when the money
 *   is taken as coming until the income is measured or the window ends.
 * And with `netburners` (#387), Netburners' countables before it's joined, by A5's work there once it is (only with
 * A5's switch on and no owner's work: theirs can't be at a faction not joined), from no reputation and no favour (never
 * joined, as #387's runs had it; cautious for waiting where it has some), each `beforeJoinMs` later: the setup's money
 * after the set's at the income (`setupMoney`, 0 once bought), then the game's check (`INVITATION_CHECK_MS`); none once
 * invited. Left out, labelled: the setup's money from the next k's (`nextCountables` adds each one's price alone, so
 * about $170k short: optimistic for waiting); the faction state's reading of the invitation, up to a minute.
 */
export function countablesToCome({
  sold,
  state,
  set,
  joined,
  shops,
  terms,
  person,
  conditions,
  work,
  money,
  income,
  assumeMoney = false,
  netburners = null,
}: {
  sold: readonly string[];
  state: AugmentationPurchaseState;
  set: AugmentationSet;
  joined: readonly JoinedFaction[];
  shops: ReadonlyMap<string, readonly string[]>;
  terms: DonationTerms | undefined;
  person: WorkingPerson;
  conditions: WorkConditions;
  work: HoldWork;
  money: number;
  income: number | null;
  assumeMoney?: boolean;
  netburners?: NetburnersRoute | null;
}): CountableWithMoney[] {
  const setNames = set.purchases.map((purchase) => purchase.name);
  const afterSet = { ...state, queued: [...state.queued, ...setNames] };
  const moneyMsFor = (addedMoney: number) => {
    const moneyShort = set.money + set.donationMoney + addedMoney - money;
    if (moneyShort <= 0) return 0;
    if (income !== null && income > 0) return (moneyShort / income) * 1000;
    return income === null && assumeMoney ? 0 : Number.POSITIVE_INFINITY;
  };
  /** The work's reputation a second at `seller` under the hold, or null where nobody works for it. */
  const workRate = (seller: JoinedFaction): number | null => {
    if (work.owners !== null) {
      if (work.owners.kind !== "faction" || work.owners.faction !== seller.name) return null;
      const { keep: _keep, ...rateConditions } = conditions;
      const perSecond = factionReputationPerSecond(person, work.owners.workType, {
        favor: seller.favor,
        ...rateConditions,
      });
      return perSecond > 0 ? perSecond : null;
    }
    return work.brainWorks ? (bestWorkRate(person, seller, conditions)?.perSecond ?? null) : null;
  };
  const toCome: CountableWithMoney[] = [];
  for (const name of sold) {
    if (name === NEUROFLUX_GOVERNOR || name === THE_RED_PILL) continue;
    if (Object.hasOwn(afterSet.installed, name) || afterSet.queued.includes(name)) continue;
    if (missingPrerequisites(name, afterSet).length > 0) continue;
    const { reputation } = augmentationCost(name, afterSet);
    const priceAdded = purchaseSequenceCost(augmentationBuyOrder([...setNames, name]), state).money - set.money;
    const sellers = joined.filter((faction) => shops.get(faction.name)?.includes(name));
    const reachedAt = sellers.find((seller) => seller.reputation >= reputation)?.name;
    if (reachedAt !== undefined) {
      toCome.push({
        augmentation: name,
        faction: reachedAt,
        way: "money",
        etaMs: moneyMsFor(priceAdded),
        money: priceAdded,
      });
      continue;
    }
    const routes: CountableWithMoney[] = [];
    for (const seller of terms?.sellers[name] ?? []) {
      // The set's donation there, if any, raised to this one's reputation: only the difference is this one's.
      const planned = set.donations.find((each) => each.faction === seller.faction);
      const donateFor = (target: number) =>
        donationToReach(target - seller.reputation, terms?.factionRep ?? 1, terms?.factionWorkRepGain ?? 1);
      const donation =
        planned === undefined
          ? donateFor(reputation)
          : donateFor(Math.max(planned.reputation, reputation)) - planned.amount;
      const addedMoney = priceAdded + donation;
      routes.push({
        augmentation: name,
        faction: seller.faction,
        way: "donation",
        etaMs: moneyMsFor(addedMoney),
        money: addedMoney,
      });
    }
    for (const seller of sellers) {
      const perSecond = workRate(seller);
      if (perSecond === null) continue;
      const workMs = ((reputation - seller.reputation) / perSecond) * 1000;
      routes.push({
        augmentation: name,
        faction: seller.name,
        way: "work",
        etaMs: Math.max(workMs, moneyMsFor(priceAdded)),
        money: priceAdded,
        workMs,
      });
    }
    // The soonest; a tie (both at once, say) to the cheaper: the seller whose donation is least.
    const soonest = routes.reduce<CountableWithMoney | undefined>(
      (best, route) =>
        best === undefined || route.etaMs < best.etaMs || (route.etaMs === best.etaMs && route.money < best.money)
          ? route
          : best,
      undefined,
    );
    if (soonest !== undefined) toCome.push(soonest);
  }
  if (netburners === null || joined.some((faction) => faction.name === NETBURNERS)) return toCome;
  if (work.owners !== null || !work.brainWorks) return toCome;
  const perSecond = bestWorkRate(person, { name: NETBURNERS, reputation: 0, favor: 0 }, conditions)?.perSecond;
  const beforeJoinMs = netburners.invited ? 0 : moneyMsFor(netburners.setupMoney) + INVITATION_CHECK_MS;
  if (perSecond === undefined || !Number.isFinite(beforeJoinMs)) return toCome;
  for (const name of netburners.sold) {
    if (name === NEUROFLUX_GOVERNOR || name === THE_RED_PILL || sold.includes(name)) continue;
    if (Object.hasOwn(afterSet.installed, name) || afterSet.queued.includes(name)) continue;
    if (missingPrerequisites(name, afterSet).length > 0) continue;
    const { reputation } = augmentationCost(name, afterSet);
    const priceAdded = purchaseSequenceCost(augmentationBuyOrder([...setNames, name]), state).money - set.money;
    const workMs = beforeJoinMs + (reputation / perSecond) * 1000;
    toCome.push({
      augmentation: name,
      faction: NETBURNERS,
      way: "work",
      etaMs: Math.max(workMs, moneyMsFor(priceAdded)),
      money: priceAdded,
      workMs,
      beforeJoinMs,
    });
  }
  return toCome;
}
