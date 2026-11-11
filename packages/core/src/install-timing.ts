/**
 * Install timing (#343, planner v0's second decision, owner decision 67): while Daedalus's count of installed
 * augmentations isn't met (`DaedalusAugsRequirement`, 30 in BN1 and BN4, `BitNode/BitNodeMultipliers.ts:61`), the
 * rules propose the candidates and the planner takes the one whose estimated time to the count is least:
 * - **install now:** the set A6 would buy, n augmentations new to the count (NeuroFlux Governor's levels one entry,
 *   counted only if none is installed, `Augmentation/AugmentationHelpers.ts:55-58`, `Faction/FactionJoinCondition.ts:
 *   130`);
 * - **wait for the next k:** the k countables still to come soonest (`nextCountables`, from core's `countablesToCome`:
 *   by work, by a donation or by the money at the income), the k-th's time τ_k.
 * With N the countables still needed and T this cycle's time online so far, the next cycles are taken to be of this
 * one's shape, n countables in T (`installNowEstimateMs`, `waitEstimateMs`). The ceiling makes the last one worth
 * waiting for: at 29 of 30, the last 17 minutes off, waiting wins (decision 56's case, with no rule of its own). T
 * holds this cycle's rebuild, so a BitNode whose rebuild is long (BN4's, about 3 times BN1's) gets longer cycles by
 * itself.
 * Left out, each labelled:
 * - the next cycles as long as this one, though the install's multipliers, the favour and home's RAM make them faster:
 *   cautious for "install now";
 * - the next cycles' countables as easy as this one's, though the cheapest and nearest are bought first, so later ones
 *   are dearer or further off: optimistic for "install now";
 * - the factions joined later this cycle, and invitations from factions not joined yet (`countablesToCome` looks at
 *   the joined alone): their countables aren't among the k, cautious for waiting;
 * - restarts and time offline: optimistic for both;
 * - Daedalus's other way in, combat 1,500: left out;
 * - each install's own time, its commit (about 2 minutes live, #343's tables): optimistic for "install now";
 * - a money-bound τ takes the income as accruing unspent, though only a wait within the lookahead's 15 minutes holds
 *   it back from cloud servers and home RAM: optimistic for waiting;
 * - the work one faction at a time, each in turn (`nextCountables`), never two at once: the order A5 takes and its
 *   switches left out, cautious for waiting where its own choice is already one of them;
 * - the countables whose prerequisite is among the k (not offered until it's bought): cautious for waiting;
 * - a τ by work at the share bonus measured now (#345: 1 while no share runs, as before A5 works there and the share
 *   starts), and at the hacking level now, though it rises over the work (the Red Pill holds of BN1.2 to BN4.1
 *   measured 1.2 to 1.7 times the rate at their first level, with the share): both cautious for waiting, optimistic
 *   for installing now.
 * Three guards, each the rule's own measure: with no income measured (`incomeMeasured` false: 10 minutes of slow
 * snapshots after a restart or a gap), every money-bound τ is never, so installing now is held unless the set meets
 * the count; while an invitation's money is held (#228's hold, `invitationHeld`: it ends on the invitation, or 5
 * minutes in the city without one), installing now, which would spend it, is held likewise; and a wait still short of
 * its countables at twice its first τ and 10 minutes scales every fresh τ by its measured error, the wait so far over
 * its first τ (`tauScale`, a rate fitted online), so a stalled wait gives way, except at the last countable, where the
 * scaled wait never exceeds T; the overdue failure reports it.
 * Pure, so the brain's rule and the run report read the same figures.
 */

import { AUGMENTATIONS } from "./augmentation-data.ts";
import { type AugmentationSet, augmentationBuyOrder } from "./augmentation-plan.ts";
import type { CountableWithMoney } from "./augmentation-reach.ts";
import { type AugmentationPurchaseState, purchaseSequenceCost } from "./augmentations.ts";

/** One of the next countables (`nextCountables`), with the time and money of it and those before it together. */
export type NextCountable = CountableWithMoney & {
  /** τ_k: until it and every one before it can be bought, ms; Infinity for never at the rates known. */
  tauMs: number;
  /** What it and those before it add to the set's money: their prices bought with the set, and their donations. */
  addedMoney: number;
};

/** The game's order of the augmentations (`Augmentation/Augmentations.ts`): ties go to the first. */
const gameOrder = (name: string) => Object.keys(AUGMENTATIONS).indexOf(name);

/**
 * The next countables in turn (#343), at most `upTo`: `toCome` (core's `countablesToCome` on `set`) the soonest first
 * (ties to the game's order), each one's τ the latest of three: the work for it and those before it, one faction at a
 * time (each faction's longest `workMs`, added up: the reputation at one faction serves all it sells, but the player
 * works for one faction at a time, `PersonObjects/Player/PlayerObject.ts:76`); the others' own times (a donation's or
 * the money's alone);
 * and the money for the set with all of them in buy order (each purchase multiplies the next one's price by 1.9,
 * `Constants.ts:41`, `Augmentation/AugmentationHelpers.ts:30`) and their donations beyond `money`, at `income` a second
 * (none measured: only what `money` covers). A donation is taken from its seller's reputation now for each, so two at
 * one faction count both (the game's donation raises it to the larger, legacy `faction-manager.js:891`): cautious for
 * waiting. Ends at the first never.
 */
export function nextCountables({
  toCome,
  set,
  state,
  money,
  income,
  upTo,
}: {
  toCome: readonly CountableWithMoney[];
  set: AugmentationSet;
  state: AugmentationPurchaseState;
  money: number;
  income: number | null;
  upTo: number;
}): NextCountable[] {
  const setNames = set.purchases.map((purchase) => purchase.name);
  const priceAdded = (names: readonly string[]) =>
    purchaseSequenceCost(augmentationBuyOrder([...setNames, ...names]), state).money - set.money;
  const moneyMs = (added: number) => {
    const short = set.money + set.donationMoney + added - money;
    if (short <= 0) return 0;
    return income !== null && income > 0 ? (short / income) * 1000 : Number.POSITIVE_INFINITY;
  };
  const sorted = [...toCome].sort((a, b) => a.etaMs - b.etaMs || gameOrder(a.augmentation) - gameOrder(b.augmentation));
  const next: NextCountable[] = [];
  const names: string[] = [];
  let donations = 0;
  /** By work: each faction's longest work, one faction at a time; the rest, each one's own time. */
  const workByFaction = new Map<string, number>();
  let othersMs = 0;
  for (const each of sorted) {
    if (next.length >= upTo || !Number.isFinite(each.etaMs)) break;
    names.push(each.augmentation);
    donations += each.money - priceAdded([each.augmentation]);
    if (each.way === "work" && each.workMs !== undefined) {
      workByFaction.set(each.faction, Math.max(workByFaction.get(each.faction) ?? 0, each.workMs));
    } else {
      othersMs = Math.max(othersMs, each.etaMs);
    }
    const workMs = [...workByFaction.values()].reduce((sum, ms) => sum + ms, 0);
    const addedMoney = priceAdded(names) + donations;
    const tauMs = Math.max(workMs, othersMs, moneyMs(addedMoney));
    if (!Number.isFinite(tauMs)) break;
    next.push({ ...each, tauMs, addedMoney });
  }
  return next;
}

/**
 * Install now's estimated time to the count, ms (#343): 0 once the set meets it (`adding` ≥ `needed`); else this
 * cycle's shape again, ⌈(N − n) / n⌉ more cycles of `onlineMs` each. Null with nothing new to the count (no install).
 */
export function installNowEstimateMs(needed: number, adding: number, onlineMs: number): number | null {
  if (adding >= needed) return 0;
  if (!(adding > 0)) return null;
  return Math.ceil((needed - adding) / adding) * onlineMs;
}

/**
 * Waiting for the next `k`'s estimated time to the count, ms (#343): τ_k once the set and they meet it; else τ_k and
 * ⌈(N − n − k) / (n + k)⌉ more cycles of this one's shape, each `onlineMs` + τ_k long. Null where τ_k is never.
 */
export function waitEstimateMs(
  needed: number,
  adding: number,
  k: number,
  tauMs: number,
  onlineMs: number,
): number | null {
  if (!Number.isFinite(tauMs)) return null;
  if (adding + k >= needed) return tauMs;
  return tauMs + Math.ceil((needed - adding - k) / (adding + k)) * (onlineMs + tauMs);
}

/** A candidate: k 0 installs now, k ≥ 1 waits for the next k (their τ); its estimated time to the count, ms. */
export interface InstallTimingCandidate {
  k: number;
  tauMs: number;
  estimateMs: number;
}

/** The planner's install timing (#343): N, n and T, the candidates with an estimate, and the choice (k), or null. */
export interface InstallTiming {
  needed: number;
  adding: number;
  onlineMs: number;
  candidates: InstallTimingCandidate[];
  /** The k chosen: 0 installs now, 1 or more waits; null with no candidate (nothing new to install, none to come). */
  choice: number | null;
  /** Installing now was the least but held, as no income is measured and the set doesn't meet the count. */
  heldForIncome: boolean;
  /** Installing now was the least but held for an invitation's money (#228's hold), the set not meeting the count. */
  heldForInvitation: boolean;
  /** The factor each wait's τ was scaled by (an overdue wait's measured error), 1 for none. */
  tauScale: number;
}

/**
 * The candidates and the choice (#343): install now (with n above 0) and each next k with a τ (times `tauScale`, an
 * overdue wait's measured error; never, with a τ above 0 times a scale of Infinity), the least estimate chosen; a tie
 * to install (irreversible, it still passes the controller's gate), then to the fewer to wait for. With no income
 * measured (`incomeMeasured` false), installing now is chosen only once the set meets the count; else the least wait,
 * or none (`heldForIncome` says so); likewise while an invitation's money is held (`invitationHeld`,
 * `heldForInvitation`).
 */
export function installTiming({
  needed,
  adding,
  onlineMs,
  next,
  incomeMeasured = true,
  invitationHeld = false,
  tauScale = 1,
}: {
  needed: number;
  adding: number;
  onlineMs: number;
  next: readonly { tauMs: number }[];
  incomeMeasured?: boolean;
  invitationHeld?: boolean;
  tauScale?: number;
}): InstallTiming {
  const candidates: InstallTimingCandidate[] = [];
  const now = installNowEstimateMs(needed, adding, onlineMs);
  if (now !== null) candidates.push({ k: 0, tauMs: 0, estimateMs: now });
  for (const [index, each] of next.entries()) {
    const tauMs = each.tauMs === 0 ? 0 : each.tauMs * tauScale;
    const estimateMs = waitEstimateMs(needed, adding, index + 1, tauMs, onlineMs);
    if (estimateMs !== null) candidates.push({ k: index + 1, tauMs, estimateMs });
  }
  const least = (allowed: (candidate: InstallTimingCandidate) => boolean) => {
    let best: InstallTimingCandidate | null = null;
    for (const candidate of candidates) {
      if (allowed(candidate) && (best === null || candidate.estimateMs < best.estimateMs)) best = candidate;
    }
    return best;
  };
  const best = least(() => true);
  const held = best?.k === 0 && adding < needed;
  const heldForIncome = held && !incomeMeasured;
  const heldForInvitation = held && invitationHeld;
  const choice =
    heldForIncome || heldForInvitation ? (least((candidate) => candidate.k > 0)?.k ?? null) : (best?.k ?? null);
  return { needed, adding, onlineMs, candidates, choice, heldForIncome, heldForInvitation, tauScale };
}
