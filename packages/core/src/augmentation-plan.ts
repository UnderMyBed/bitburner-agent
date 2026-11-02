/**
 * Augmentations and the reset (#210, M4 phase A slice A6): which augmentations the brain buys, in what order, and
 * when it installs them. Pure, from the game's formulas (owner decision 46) and core's augmentation data and price
 * rules (#193); the brain's rule (packages/brain/src/augmentations.ts) feeds it what the snapshots say. When to install
 * is the legacy scripts' count rule (#222, owner decision 51): `alainbryden/bitburner-scripts`' autopilot.js, cited
 * as `autopilot.js:<line>` (its `maybeInstallAugmentations`, lines 860-1020). Smarter timing is phase B's planner's.
 * Donations (#225, owner decision 53): an augmentation a joined faction with donations unlocked sells counts as within
 * reach when the money covers its price and the donation for its missing reputation, as the legacy faction manager's
 * `canAffordWithDonation` has it (`faction-manager.js:546-549`, `:631`, `:822-860`).
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import {
  type AugmentationPurchase,
  type AugmentationPurchaseState,
  augmentationCost,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
} from "./augmentations.ts";
import { donationToReach } from "./donations.ts";
import { HACKING_MULTIPLIERS, hackingValue } from "./faction-work.ts";
import { FACTION_NAMES } from "./factions.ts";

/** An augmentation's data; an unknown name throws, as in augmentations.ts. */
function dataOf(name: string) {
  const augmentation = AUGMENTATIONS[name];
  if (augmentation === undefined || !Object.hasOwn(AUGMENTATIONS, name)) {
    throw new RangeError(`no augmentation ${JSON.stringify(name)}`);
  }
  return augmentation;
}

/** The game's order of the augmentations (`Augmentation/Augmentations.ts`): ties go to the first. */
const gameOrder = (name: string) => Object.keys(AUGMENTATIONS).indexOf(name);

/**
 * Whether the brain installs `name` (#210): a hacking value (A5's `hackingValue`, #203, at any level) above 0, and not
 * NeuroFlux
 * Governor, which is bought last with what money is left. Combat, charisma and Hacknet augmentations, and The Red Pill,
 * have none.
 */
export function isWorthInstalling(name: string): boolean {
  return name !== NEUROFLUX_GOVERNOR && hackingValue(name, 1) > 0;
}

/** The multipliers an install brings, each the product over `names` (each NeuroFlux Governor copy listed counts). */
export type InstallGains = Record<(typeof HACKING_MULTIPLIERS)[number], number>;

export function installGains(names: readonly string[]): InstallGains {
  const gains = Object.fromEntries(HACKING_MULTIPLIERS.map((key) => [key, 1])) as InstallGains;
  for (const name of names) {
    const { multipliers } = dataOf(name);
    for (const key of HACKING_MULTIPLIERS) gains[key] *= multipliers[key] ?? 1;
  }
  return gains;
}

/**
 * `names` in the order to buy them (#210): each purchase multiplies the next one's price by 1.9 (`Constants.ts:41`),
 * so the dear ones go early; but a prerequisite goes before what needs it (`FactionHelpers.tsx:88-95`). Each time, of
 * those whose prerequisites in `names` are bought (one not in `names` is taken as owned), the one heading the dearest
 * chain: its own price, or that of the dearest in `names` that needs it, so a cheap prerequisite of a dear augmentation
 * goes first, its chain right after (Embedded Netburner Module, then its Core Implant, then Cranial Signal Processors
 * Gen IV: $8.97b, where the dearest-first order costs $10.6b). Ties go to the dearer itself, then the game's order. The
 * base price decides: every other factor of `getAugCost` is the same for all but NeuroFlux Governor and Shadows of
 * Anarchy's, which the brain never puts in a set.
 */
export function augmentationBuyOrder(names: readonly string[]): string[] {
  const left = [...new Set(names)];
  const order: string[] = [];
  const price = (name: string) => dataOf(name).baseMoneyCost;
  // The data lists every prerequisite of a chain (Gen V's are Gen I to IV), so those that need `name` are direct.
  const chainPrice = (name: string) =>
    Math.max(price(name), ...left.filter((each) => dataOf(each).prereqs.includes(name)).map(price));
  while (left.length > 0) {
    const ready = left.filter((name) => dataOf(name).prereqs.every((prereq) => !left.includes(prereq)));
    if (ready.length === 0) throw new RangeError(`the prerequisites of ${left.join(", ")} go round in a circle`);
    const next = ready.reduce((best, name) => {
      const [chain, bestChain] = [chainPrice(name), chainPrice(best)];
      if (chain !== bestChain) return chain > bestChain ? name : best;
      if (price(name) !== price(best)) return price(name) > price(best) ? name : best;
      return gameOrder(name) < gameOrder(best) ? name : best;
    });
    order.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return order;
}

/** A joined faction that takes donations, donations unlocked (core's donations.ts), and its reputation now. */
export interface DonationSeller {
  faction: string;
  reputation: number;
}

/**
 * What buying with donations needs (#225): the joined factions taking donations that sell each augmentation no joined
 * seller's reputation reaches, and NeuroFlux Governor; the player's `faction_rep` and the BitNode's
 * `FactionWorkRepGain`, which a donation's reputation is multiplied by.
 */
export interface DonationTerms {
  sellers: Readonly<Record<string, readonly DonationSeller[]>>;
  neuroFluxSellers: readonly DonationSeller[];
  factionRep: number;
  factionWorkRepGain: number;
}

/** One faction's donation (#225): the reputation it brings the faction to, and the money (core's `donationToReach`). */
export interface Donation {
  faction: string;
  reputation: number;
  amount: number;
}

/**
 * What buying a set costs: each purchase in buy order, at its price then, and the money in all; and (#225) the
 * donations it needs, one a faction, their money, and the purchases they're for.
 */
export interface AugmentationSet {
  purchases: AugmentationPurchase[];
  money: number;
  donations: Donation[];
  donationMoney: number;
  byDonation: string[];
}

/**
 * The donations buying `names` needs (#225): each not in `reached` is bought from one of its donation sellers, the one
 * whose donation it raises least (reputation already reached costs nothing; ties to the seller with more reputation,
 * then the game's order of factions), and a faction's donation brings it to the most reputation that's bought there
 * (legacy `faction-manager.js:871-893`: the max, not the sum, `:891`). `targets` carries donations already planned:
 * each faction's reputation to reach.
 */
function planDonations(
  names: readonly string[],
  state: AugmentationPurchaseState,
  reached: readonly string[],
  terms: DonationTerms | undefined,
  targets = new Map<string, DonationSeller>(),
): { targets: Map<string, DonationSeller>; byDonation: string[] } {
  const byDonation: string[] = [];
  for (const name of names) {
    if (reached.includes(name)) continue;
    const needed = augmentationCost(name, state).reputation;
    const pick = cheapestSeller(terms?.sellers[name] ?? [], needed, targets);
    if (pick === null) throw new RangeError(`${name} is neither reached nor sold by a faction taking donations`);
    if (needed > (targets.get(pick.faction)?.reputation ?? pick.reputation)) {
      targets.set(pick.faction, { faction: pick.faction, reputation: needed });
    }
    byDonation.push(name);
  }
  return { targets, byDonation };
}

/** Of `sellers`, the one whose planned reputation is raised least to `needed`: ties as `planDonations` says. */
function cheapestSeller(
  sellers: readonly DonationSeller[],
  needed: number,
  targets: ReadonlyMap<string, DonationSeller>,
): DonationSeller | null {
  const planned = (seller: DonationSeller) => Math.max(seller.reputation, targets.get(seller.faction)?.reputation ?? 0);
  let best: DonationSeller | null = null;
  for (const seller of sellers) {
    if (best === null) {
      best = seller;
      continue;
    }
    const [raise, bestRaise] = [Math.max(0, needed - planned(seller)), Math.max(0, needed - planned(best))];
    if (raise !== bestRaise) {
      if (raise < bestRaise) best = seller;
    } else if (seller.reputation !== best.reputation) {
      if (seller.reputation > best.reputation) best = seller;
    } else if (FACTION_NAMES.indexOf(seller.faction) < FACTION_NAMES.indexOf(best.faction)) {
      best = seller;
    }
  }
  return best;
}

/** The donations `targets` plans, each from its seller's reputation now (`sellerReputation`), and their money. */
function donationsOf(
  targets: ReadonlyMap<string, DonationSeller>,
  sellerReputation: (faction: string) => number,
  terms: DonationTerms | undefined,
): { donations: Donation[]; donationMoney: number } {
  const donations: Donation[] = [];
  for (const { faction, reputation } of targets.values()) {
    const missing = reputation - sellerReputation(faction);
    if (!(missing > 0) || terms === undefined) continue;
    donations.push({
      faction,
      reputation,
      amount: donationToReach(missing, terms.factionRep, terms.factionWorkRepGain),
    });
  }
  return { donations, donationMoney: donations.reduce((sum, each) => sum + each.amount, 0) };
}

/** Each seller's reputation now in `terms`, by faction. */
function sellerReputations(terms: DonationTerms | undefined): (faction: string) => number {
  const reputations = new Map<string, number>();
  for (const seller of [...Object.values(terms?.sellers ?? {}).flat(), ...(terms?.neuroFluxSellers ?? [])]) {
    reputations.set(seller.faction, seller.reputation);
  }
  return (faction) => reputations.get(faction) ?? 0;
}

/**
 * The set to buy of `reached` (augmentations whose reputation a joined seller has), with `money` (#210): the most
 * hacking value the money covers, greedily. By hacking value at `hackingLevel` (A5's `hackingValue`, which weighs the
 * hacking skill multiplier by the level; ties to the cheaper, then the game's order), each is
 * added with its prerequisites not yet owned, queued or chosen, if they're all reached too, and kept if the whole set,
 * in buy order, costs no more than the money (core's `purchaseSequenceCost`). Only those worth installing count.
 * With `donations` (#225), one no joined seller's reputation reaches is a candidate too where a seller taking donations
 * sells it: kept if the set's prices and its donations (`planDonations`) together are within the money.
 */
export function chooseAugmentationsToBuy(
  reached: readonly string[],
  state: AugmentationPurchaseState,
  money: number,
  hackingLevel: number,
  donations?: DonationTerms,
): AugmentationSet {
  const owned = (name: string) => Object.hasOwn(state.installed, name) || state.queued.includes(name);
  const available = (name: string) => reached.includes(name) || (donations?.sellers[name]?.length ?? 0) > 0;
  const sellerReputation = sellerReputations(donations);
  const candidates = [...new Set([...reached, ...Object.keys(donations?.sellers ?? {})])]
    .filter((name) => available(name) && isWorthInstalling(name) && !owned(name))
    .sort(
      (a, b) =>
        hackingValue(b, hackingLevel) - hackingValue(a, hackingLevel) ||
        dataOf(a).baseMoneyCost - dataOf(b).baseMoneyCost ||
        gameOrder(a) - gameOrder(b),
    );
  let chosen: string[] = [];
  let set: AugmentationSet = { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] };
  for (const name of candidates) {
    if (chosen.includes(name)) continue;
    const bundle = withPrerequisites(name, state, chosen);
    if (bundle === null || !bundle.every(available)) continue;
    const order = augmentationBuyOrder([...chosen, ...bundle]);
    const { targets, byDonation } = planDonations(order, state, reached, donations);
    const tried = {
      ...purchaseSequenceCost(order, state),
      ...donationsOf(targets, sellerReputation, donations),
      byDonation,
    };
    if (tried.money + tried.donationMoney <= money) {
      chosen = [...chosen, ...bundle];
      set = tried;
    }
  }
  return set;
}

/**
 * `name` and the prerequisites it still needs, each with its own, none owned, queued or in `chosen`; null if one is
 * sold by no faction (it can't be bought).
 */
function withPrerequisites(name: string, state: AugmentationPurchaseState, chosen: readonly string[]): string[] | null {
  const bundle: string[] = [];
  const add = (each: string): boolean => {
    if (bundle.includes(each)) return true;
    if (dataOf(each).factions.length === 0) return false;
    bundle.push(each);
    const missing = missingPrerequisites(each, { installed: state.installed, queued: [...state.queued, ...chosen] });
    return missing.every(add);
  };
  return add(name) ? bundle : null;
}

/**
 * The hacking experience a level needs at a multiplier: the game's `calculateExp` (`PersonObjects/formulas/skill.ts:
 * 17-27`), the inverse of `calculateSkill`'s `mult × (32 ln(exp + 534.6) − 200)` (`:7-15`), never below 0.
 */
export function hackingExpForLevel(level: number, multiplier: number): number {
  return Math.max(0, Math.exp((level / multiplier + 200) / 32) - 534.6);
}

/** Install once this many new augmentations are affordable, NeuroFlux Governor's levels not counted (`autopilot.js:10`). */
export const INSTALL_AT_AUGMENTATIONS = 8;
/** Or once this many are, each NeuroFlux Governor level counted (`autopilot.js:11`). */
export const INSTALL_AT_AUGMENTATIONS_WITH_NEUROFLUX = 12;
/**
 * Each bar falls by this many an hour online this cycle, floored, never below 1 (`autopilot.js:15`, `:888`, `:897-898`):
 * an install in a slow cycle locks in what it has. Left out of the legacy scripts', each the planner's: SF11's +1 a
 * level (`:896`, BN11's); a gang's 6 for a quick install and its full countdown (`:937`, `:944`); and the BitNode
 * overrides, BN8's quick reinstalls and BN9's first-install hold (`:885-893`, `:940-941`).
 */
export const INSTALL_BAR_FALL_PER_HOUR = 0.5;
/** A quick install: within 20 minutes of the last install (`autopilot.js:939`), at 4 affordable with NeuroFlux (`:937`). */
export const QUICK_INSTALL_WITHIN_MS = 20 * 60_000;
export const QUICK_INSTALL_AT_AUGMENTATIONS = 4;
/**
 * The countdown once the rule says install, in the game's time: 90 s (`autopilot.js:13`) to see whether more come
 * within reach; 30 s for a quick install (`:944-945`). Each rise in the count during it extends it, to the larger of
 * 10 s (`:973`) and the countdown less a share for each extension so far (`:972-976`). The legacy scripts start one
 * for The Red Pill and never extend it (`:963-968`); here The Red Pill has none (#215's install, at once).
 */
export const INSTALL_COUNTDOWN_MS = 90_000;
export const QUICK_INSTALL_COUNTDOWN_MS = 30_000;
export const INSTALL_COUNTDOWN_LEAST_EXTENSION_MS = 10_000;
const HOUR_MS = 3_600_000;

/** The bars at `onlineMs` online this cycle, and the online time each falls next at (null once it's 1). */
export interface InstallBars {
  bar: number;
  barWithNeuroFlux: number;
  barFallsAtMs: number | null;
  barWithNeuroFluxFallsAtMs: number | null;
}

export function installBars(onlineMs: number): InstallBars {
  if (!Number.isFinite(onlineMs) || onlineMs < 0) {
    throw new RangeError(`the online time must be finite and 0 or more, not ${onlineMs}`);
  }
  const fall = Math.floor((INSTALL_BAR_FALL_PER_HOUR * onlineMs) / HOUR_MS);
  const nextFallAtMs = ((fall + 1) / INSTALL_BAR_FALL_PER_HOUR) * HOUR_MS;
  const bar = Math.max(1, INSTALL_AT_AUGMENTATIONS - fall);
  const barWithNeuroFlux = Math.max(1, INSTALL_AT_AUGMENTATIONS_WITH_NEUROFLUX - fall);
  return {
    bar,
    barWithNeuroFlux,
    barFallsAtMs: bar > 1 ? nextFallAtMs : null,
    barWithNeuroFluxFallsAtMs: barWithNeuroFlux > 1 ? nextFallAtMs : null,
  };
}

/** What's affordable: new augmentations, and with NeuroFlux Governor's levels too. */
export interface InstallCounts {
  affordable: number;
  affordableWithNeuroFlux: number;
}

/** The counts' purchases and their money (#222), and (#225) the donations they need. */
export interface CountedPurchases extends InstallCounts {
  neuroFluxLevels: number;
  /** What the set, the levels and the donations cost. */
  money: number;
  /** One a faction, the set's and the levels' together, and their money. */
  donations: Donation[];
  donationMoney: number;
  /** How many of the counted purchases, the set's and the levels', need a donation. */
  byDonation: number;
}

/**
 * The counts (#222; `autopilot.js:901-903`, the legacy faction manager's affordable and awaiting-install counts).
 * - Affordable: those worth installing in `installable`, plus the set to buy (`chooseAugmentationsToBuy` with `money`).
 *   `installable` is what an install would really install: never a purchase the plan counts as queued only so it isn't
 *   asked for again (the brain's `augmentationNotQueued`), which `state.queued` holds for the prices (#222 review).
 * - With NeuroFlux: that, the NeuroFlux Governor copies in `installable`, and the levels the money left after the set covers at
 *   `neuroFluxReputation` (the joined sellers' most), each priced after the set and the levels before it, as
 *   `augmentationCost` has it (×1.14 a level, ×1.9 a purchase).
 * Also the levels, and the money the set and the levels cost: the countdown holds it back.
 * With `donations` (#225), a level beyond `neuroFluxReputation` is bought with a donation at a NeuroFlux seller taking
 * donations, the one it raises least, on top of the set's donations (legacy `faction-manager.js:822-860`): the money
 * covers its price and what its donation adds. The money then includes every donation.
 */
export function affordableCounts({
  state,
  installable = state.queued,
  set,
  money,
  neuroFluxReputation,
  donations,
}: {
  state: AugmentationPurchaseState;
  installable?: readonly string[];
  set: AugmentationSet;
  money: number;
  neuroFluxReputation: number;
  donations?: DonationTerms;
}): CountedPurchases {
  const queuedWorth = installable.filter(isWorthInstalling).length;
  const queuedNeuroFlux = installable.filter((name) => name === NEUROFLUX_GOVERNOR).length;
  const affordable = queuedWorth + set.purchases.length;
  let queued = [...state.queued, ...set.purchases.map((purchase) => purchase.name)];
  const sellerReputation = sellerReputations(donations);
  let targets = new Map(set.donations.map(({ faction, reputation }) => [faction, { faction, reputation }]));
  let planned = donationsOf(targets, sellerReputation, donations);
  let spent = set.money + planned.donationMoney;
  let neuroFluxLevels = 0;
  let levelsByDonation = 0;
  for (;;) {
    const cost = augmentationCost(NEUROFLUX_GOVERNOR, { ...state, queued });
    // A seller taking donations reaches what its planned donation brings it to.
    const reach = Math.max(
      neuroFluxReputation,
      ...(donations?.neuroFluxSellers ?? []).map((each) => targets.get(each.faction)?.reputation ?? each.reputation),
    );
    let nextTargets = targets;
    let next = planned;
    const byDonation = cost.reputation > reach;
    if (byDonation) {
      const seller = cheapestSeller(donations?.neuroFluxSellers ?? [], cost.reputation, targets);
      // Without a seller taking donations, a finite reputation ends it.
      if (seller === null) break;
      nextTargets = new Map(targets).set(seller.faction, { faction: seller.faction, reputation: cost.reputation });
      next = donationsOf(nextTargets, sellerReputation, donations);
    }
    // Each level dearer, so a finite money ends it.
    if (spent + cost.money + next.donationMoney - planned.donationMoney > money) break;
    spent += cost.money + next.donationMoney - planned.donationMoney;
    targets = nextTargets;
    planned = next;
    queued = [...queued, NEUROFLUX_GOVERNOR];
    neuroFluxLevels += 1;
    if (byDonation) levelsByDonation += 1;
  }
  return {
    affordable,
    affordableWithNeuroFlux: affordable + queuedNeuroFlux + neuroFluxLevels,
    neuroFluxLevels,
    money: spent,
    donations: planned.donations,
    donationMoney: planned.donationMoney,
    byDonation: set.byDonation.length + levelsByDonation,
  };
}

/**
 * Why an install is chosen (#222). "The Red Pill" is the brain's own (#215): reached or queued, it links w0r1d_d43m0n
 * once installed; and "Daedalus donations" (#225): Daedalus's reputation unlocks its donations at the next install, so
 * The Red Pill's is bought. `installRule` gives neither.
 */
export type InstallReason = "count reached" | "quick install" | "nothing left" | "The Red Pill" | "Daedalus donations";

export interface InstallRuleInputs extends InstallCounts {
  /** The game's time the brain saw online since the last install: the bars' clock. */
  onlineMs: number;
  /** The game's time since the last install, the time the game was closed in it too: a quick install's limit. */
  sinceResetMs: number;
  /** What the install would install besides NeuroFlux Governor levels still to buy: what's really queued, and the set. */
  installing: number;
  /** The NeuroFlux Governor levels the money covers, still to buy (`affordableCounts`'s). */
  neuroFluxLevels: number;
  /** No augmentation worth installing is left unowned at the joined factions, beyond the set. */
  nothingLeft: boolean;
}

export interface InstallRule extends InstallBars, InstallCounts {
  install: boolean;
  /** Why it installs, or null. */
  reason: InstallReason | null;
}

/**
 * Whether to install (#222, owner decision 51), the legacy scripts' count rule:
 * - a quick install: within `QUICK_INSTALL_WITHIN_MS` of the last install, online and in the game's time, at
 *   `QUICK_INSTALL_AT_AUGMENTATIONS` with NeuroFlux (`autopilot.js:937-945`). The game's time as well (the legacy
 *   scripts' only clock, `:129`): a save first seen mid-cycle has 0 online, which isn't early in its cycle;
 * - the count reached: `affordable` at `bar`, or `affordableWithNeuroFlux` at `barWithNeuroFlux` (`:917-918`);
 * - nothing left (#210): no augmentation worth installing left at the joined factions, with something to install.
 * Never, for any reason, with nothing really to install: nothing queued (really), in the set or among the levels to
 * buy (#213's guarantee, #222 review). Nothing left needs something queued or in the set: the levels alone don't.
 */
export function installRule(inputs: InstallRuleInputs): InstallRule {
  const { onlineMs, sinceResetMs, installing, neuroFluxLevels, nothingLeft, affordable, affordableWithNeuroFlux } =
    inputs;
  const bars = installBars(onlineMs);
  const quick =
    onlineMs < QUICK_INSTALL_WITHIN_MS &&
    sinceResetMs < QUICK_INSTALL_WITHIN_MS &&
    affordableWithNeuroFlux >= QUICK_INSTALL_AT_AUGMENTATIONS;
  const reached = affordable >= bars.bar || affordableWithNeuroFlux >= bars.barWithNeuroFlux;
  const reason: InstallReason | null = quick
    ? "quick install"
    : reached
      ? "count reached"
      : nothingLeft && installing > 0
        ? "nothing left"
        : null;
  const anything = installing + neuroFluxLevels > 0;
  return {
    ...bars,
    affordable,
    affordableWithNeuroFlux,
    install: anything && reason !== null,
    reason: anything ? reason : null,
  };
}

/**
 * How long a countdown runs from now once the count rises during it (`autopilot.js:972-976`): the countdown (90 s, or
 * 30 s for a quick install: the legacy scripts lower the option to 30 s, `:944-945`) less a share for each extension so
 * far, of `barWithNeuroFlux`, never under 10 s. The caller never shortens a deadline already set (`:976`).
 */
export function countdownExtensionMs(countdownMs: number, extensions: number, barWithNeuroFlux: number): number {
  return Math.max(INSTALL_COUNTDOWN_LEAST_EXTENSION_MS, countdownMs * (1 - extensions / barWithNeuroFlux));
}
