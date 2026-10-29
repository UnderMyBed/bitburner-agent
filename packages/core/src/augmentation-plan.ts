/**
 * Augmentations and the reset (#210, M4 phase A slice A6): which augmentations the brain buys, in what order, and
 * whether installing them now beats carrying on. Pure, from the game's formulas (owner decision 46) and core's
 * augmentation data and price rules (#193); the brain's rule (packages/brain/src/augmentations.ts) feeds it what the
 * snapshots say.
 */
import { AUGMENTATIONS } from "./augmentation-data.ts";
import {
  type AugmentationPurchase,
  type AugmentationPurchaseState,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
} from "./augmentations.ts";
import { HACKING_MULTIPLIERS, hackingValue } from "./faction-work.ts";

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

/** What buying a set costs: each purchase in buy order, at its price then, and the money in all. */
export interface AugmentationSet {
  purchases: AugmentationPurchase[];
  money: number;
}

/**
 * The set to buy of `reached` (augmentations whose reputation a joined seller has), with `money` (#210): the most
 * hacking value the money covers, greedily. By hacking value at `hackingLevel` (A5's `hackingValue`, which weighs the
 * hacking skill multiplier by the level; ties to the cheaper, then the game's order), each is
 * added with its prerequisites not yet owned, queued or chosen, if they're all reached too, and kept if the whole set,
 * in buy order, costs no more than the money (core's `purchaseSequenceCost`). Only those worth installing count.
 */
export function chooseAugmentationsToBuy(
  reached: readonly string[],
  state: AugmentationPurchaseState,
  money: number,
  hackingLevel: number,
): AugmentationSet {
  const owned = (name: string) => Object.hasOwn(state.installed, name) || state.queued.includes(name);
  const candidates = [...new Set(reached)]
    .filter((name) => isWorthInstalling(name) && !owned(name))
    .sort(
      (a, b) =>
        hackingValue(b, hackingLevel) - hackingValue(a, hackingLevel) ||
        dataOf(a).baseMoneyCost - dataOf(b).baseMoneyCost ||
        gameOrder(a) - gameOrder(b),
    );
  let chosen: string[] = [];
  let set: AugmentationSet = { purchases: [], money: 0 };
  for (const name of candidates) {
    if (chosen.includes(name)) continue;
    const bundle = withPrerequisites(name, state, chosen);
    if (bundle === null || !bundle.every((each) => reached.includes(each))) continue;
    const tried = purchaseSequenceCost(augmentationBuyOrder([...chosen, ...bundle]), state);
    if (tried.money <= money) {
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

/**
 * How long getting back to `hackingLevel` takes after the install (#210): this cycle's pace replayed. The experience
 * the level needs at the hacking multiplier after the install, over the experience it took this cycle, times the time
 * since the last install, over the install's experience and speed multipliers (each hack, grow and weaken is that much
 * quicker and gives that much more). The multiplier now is the one the level and experience imply (`skill.ts:13`, so
 * the BitNode's is in it), the level being floored: at most 1/level off. With no experience yet, nothing to rebuild.
 */
export function rebuildTimeMs({
  sinceResetMs,
  hackingLevel,
  hackingExp,
  gains,
}: {
  sinceResetMs: number;
  hackingLevel: number;
  hackingExp: number;
  gains: Pick<InstallGains, "hacking" | "hacking_exp" | "hacking_speed">;
}): number {
  for (const [what, value] of Object.entries({ sinceResetMs, hackingLevel, hackingExp })) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${what} must be finite and 0 or more, not ${value}`);
  }
  if (hackingExp === 0) return 0;
  const multiplierNow = hackingLevel / (32 * Math.log(hackingExp + 534.6) - 200);
  const expAfter = hackingExpForLevel(hackingLevel, multiplierNow * gains.hacking);
  return (sinceResetMs * (expAfter / hackingExp)) / (gains.hacking_exp * gains.hacking_speed);
}

/** One way to the next augmentation worth installing: an augmentation at one of its joined sellers. */
export interface InstallCandidate {
  augmentation: string;
  faction: string;
  /** Its reputation there now, and what it needs (the game's `getAugCost`). */
  reputation: number;
  reputationNeeded: number;
  /** The reputation a second the faction's best work earns there now (A5's rate); 0 for none. */
  reputationPerSecond: number;
  /** Not installing: the set, then it, in buy order (`purchaseSequenceCost`). */
  costAfterSet: number;
  /** Installing: its price with nothing queued. */
  priceAfterInstall: number;
}

export interface InstallDecisionInputs {
  /** The game's time since the last install (the slow snapshot's game time less `lastAugReset`). */
  sinceResetMs: number;
  hackingLevel: number;
  hackingExp: number;
  /** What the install would install: what's queued and the set to buy (NeuroFlux Governor's copies too). */
  installing: readonly string[];
  money: number;
  /** The money earned a second (the slow snapshots' money sources), or null while it isn't measured. */
  incomePerSecond: number | null;
  /** Each way to the next augmentation worth installing, at the joined factions. */
  candidates: readonly InstallCandidate[];
}

/** Why an install is, or would be, chosen (#210). */
export type InstallReason = "nothing left" | "nothing reachable" | "sooner installing";

/** The decision, with its figures (ms; Infinity for never) for the dashboard, the events and the report. */
export interface InstallDecision {
  install: boolean;
  /** Why not, when it can't be decided: the income not measured yet, or none. Null otherwise. */
  waitingFor: string | null;
  /**
   * Why it installs, or would: nothing left at the joined factions; nothing reachable at a positive reputation rate; or
   * the next one sooner installing first. Null while it waits.
   */
  reason: InstallReason | null;
  rebuildMs: number;
  /** The soonest next augmentation not installing, and how long; null with no candidate. */
  without: { augmentation: string; faction: string; ms: number } | null;
  /** The same, installing now: the rebuild, then it from scratch. */
  with: { augmentation: string; faction: string; ms: number } | null;
}

const eta = (amount: number, perSecond: number) =>
  amount <= 0 ? 0 : perSecond > 0 ? (amount / perSecond) * 1000 : Number.POSITIVE_INFINITY;

/**
 * Whether to install now (#210): when the next augmentation worth installing comes sooner installing first (rebuilding,
 * then it from scratch) than carrying on, or when none is left to work for at the joined factions; and only with
 * something to install.
 * - Carrying on: the longer of its reputation still needed at the rate, and its money, the set's and its own in buy
 *   order less the money now, at the income.
 * - Installing: `rebuildTimeMs`, then the longer of its whole reputation (it becomes favour, left out: conservative) at
 *   the rate times the install's `faction_rep`, and its price with nothing queued from no money, at the income.
 * The soonest candidate on each side. A decision with candidates waits without an income measured, or with one of 0
 * (the hack loop off or stalled): money's wait can't be judged then, and an install is never chosen on it. Never
 * carrying on is only reputation no joined faction's work earns (a rate of 0).
 */
export function installDecision(inputs: InstallDecisionInputs): InstallDecision {
  const { sinceResetMs, hackingLevel, hackingExp, installing, money, incomePerSecond, candidates } = inputs;
  const gains = installGains(installing);
  const rebuildMs = rebuildTimeMs({ sinceResetMs, hackingLevel, hackingExp, gains });
  const decided = (install: boolean, reason: InstallReason | null, waitingFor: string | null = null) => ({
    install,
    waitingFor,
    reason,
    rebuildMs,
  });
  if (candidates.length === 0) return { ...decided(installing.length > 0, "nothing left"), without: null, with: null };
  if (incomePerSecond === null || !(incomePerSecond > 0)) {
    const waitingFor =
      incomePerSecond === null
        ? "the income, measured over 10 minutes of slow snapshots"
        : "an income above $0 a second (none over the last 10 minutes), to judge the money's wait";
    return { ...decided(false, null, waitingFor), without: null, with: null };
  }
  const soonest = (ms: (candidate: InstallCandidate) => number) =>
    candidates
      .map((candidate) => ({ augmentation: candidate.augmentation, faction: candidate.faction, ms: ms(candidate) }))
      .reduce((best, each) => (each.ms < best.ms ? each : best));
  const without = soonest((candidate) =>
    Math.max(
      eta(candidate.reputationNeeded - candidate.reputation, candidate.reputationPerSecond),
      eta(candidate.costAfterSet - money, incomePerSecond),
    ),
  );
  const withInstall = soonest(
    (candidate) =>
      rebuildMs +
      Math.max(
        eta(candidate.reputationNeeded, candidate.reputationPerSecond * gains.faction_rep),
        eta(candidate.priceAfterInstall, incomePerSecond),
      ),
  );
  const reason: InstallReason | null =
    without.ms === Number.POSITIVE_INFINITY
      ? "nothing reachable"
      : withInstall.ms < without.ms
        ? "sooner installing"
        : null;
  return { ...decided(installing.length > 0 && reason !== null, reason), without, with: withInstall };
}
