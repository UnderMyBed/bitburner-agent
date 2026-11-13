/**
 * Install timing (#343, planner v0's second decision, owner decision 67): while Daedalus's count of installed
 * augmentations isn't met (`DaedalusAugsRequirement`, 30 in BN1 and BN4, `BitNode/BitNodeMultipliers.ts:61`), the
 * rules propose the candidates and the planner takes the one whose estimated time to the count is least:
 * - **install now:** the set A6 would buy, n augmentations new to the count (NeuroFlux Governor's levels one entry,
 *   counted only if none is installed, `Augmentation/AugmentationHelpers.ts:55-58`, `Faction/FactionJoinCondition.ts:
 *   130`);
 * - **wait for the next k:** the k countables still to come soonest (`nextCountables`, from core's `countablesToCome`:
 *   by work, by a donation or by the money at the income), the k-th's time τ_k.
 * With N the countables still needed and T this cycle's time online so far (the brain's bars' clock, gaps over 3
 * minutes left out, #388; a cycle it first saw past its start counts the game's time before whole, which leans towards
 * waiting, as T weighs more on installing now's estimate than on any wait's), the next cycles bring n countables each
 * (n + k after a wait for k), ⌈(N − n) / n⌉ of them (`installNowEstimateMs`, `waitEstimateMs`). The ceiling makes the
 * last one worth waiting for: at 29 of 30, the last 17 minutes off, waiting wins (decision 56's case, with no rule of
 * its own).
 * Each later cycle is priced from the countables left (#389; before it, each was this one's shape, T, and ran 2.8-3.1
 * times optimistic at BN4.2's c6 and c7, 46 min against 128 and 31 against 96): the rebuild R, then the work for its
 * own countables at the rate after the installs before it, R + W_j / r_j (`laterCyclesMs`):
 * - **R, the rebuild:** measured, this cycle's own: its time online before faction work (A5's or the owner's) first
 *   went on (the brain's, `CycleWork`), the invitations, the hacking level and A5's start in it (BN4.2's c2-c9: 4-5
 *   min);
 * - **r_0, the rate measured:** the reputation earned this cycle at the joined factions over T − R (decision 67's rates
 *   fitted online);
 * - **r_j, after each install:** r_0 times the hacking and faction_rep multipliers of what each install before cycle j
 *   installs, this one's first (`LaterCycles.installing`), then each later cycle's own countables (`installGain`):
 *   hacking work's reputation is the hacking level times faction_rep (`PersonObjects/formulas/reputation.ts:18-19`),
 *   the level taken as its multiplier's (`PersonObjects/formulas/skill.ts:7-15`);
 * - **W_j, the countables:** `countablesLeft`, cheapest first (the A5 hook works for the first countable it waits for,
 *   #344, and BN4.2's c7-c9 bought the 4 cheapest left after c6 in that order), n a cycle as this one: the factions
 *   joined, and Tian Di Hui's and the city factions' (#228: a city and money), each cycle's one faction at a time.
 * With the countables left costing what this cycle earned and installs of no such multiplier, each is T again, the
 * estimate before #389. Unpriced (no R measured: a cycle first seen past its first work, or a restart before it;
 * nothing earned; or T ≤ R), it's this one's shape (T, or T + τ_k after a wait); a cycle past the countables known is
 * the last priced one again (labelled: either way). BN4.2's hindcast (core's test): within ×2 at c3-c8, 6 of 7 with c9
 * against 5 of 7 before; c2 3.80 times its actual, the residual below.
 * Left out, each labelled:
 * - the level's rebuild, home RAM and the share beyond the multipliers: BN4.2's rate rose about 5 times from c2 to c8
 *   (3.6 to 18.6 rep/s), the multipliers 1.86 times (hacking 1.48 to 2.75); cautious for "install now", 3.80 times at
 *   c2 (#336's level fit, a follow-up slice under roadmap 1b);
 * - the experience multipliers' part of the level (`skill.ts`: 32 ln of the experience): cautious; the favour gained:
 *   cautious; the passive reputation favour earns (`Faction/FactionHelpers.tsx`, `processPassiveFactionRepGain`) in
 *   what's earned: optimistic, small;
 * - the work at factions bought nothing from: the rate is what was earned, W_j what's needed (BN4.2's needed over
 *   earned 0.67-0.87): optimistic for "install now";
 * - the city groups' exclusion (`CITY_FACTION_GROUPS`: one group a cycle), so a cycle may take two groups' countables:
 *   optimistic; the cities' and Tian Di Hui's invitations' money and travel: optimistic; the hacking factions not
 *   joined yet: cautious;
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
 * - a τ by work at the share bonus's mean over the last 10 minutes (#345: 1 with no share in them, as before A5 works
 *   there and the share starts), and at the hacking level now, though it rises over the work (the Red Pill holds of BN1.2 to BN4.1
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
import {
  type AugmentationPurchaseState,
  augmentationCost,
  augmentationsSoldBy,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
} from "./augmentations.ts";
import { THE_RED_PILL } from "./bitnodes.ts";
import { CITY_FACTION_GROUPS, TIAN_DI_HUI } from "./factions.ts";

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

/** A countable left after an install (#389): its reputation, and who sells it among the factions counted. */
export interface CountableLeft {
  augmentation: string;
  reputation: number;
  sellers: readonly string[];
}

/**
 * The factions the later cycles are taken to join besides those joined now (#389): Tian Di Hui and the city factions,
 * whose invitations need a city and money (#228, `Faction/FactionInfo.tsx:680-692`), so any cycle can have them (one
 * city group a cycle, left out: optimistic).
 */
export const LATER_CYCLE_FACTIONS: readonly string[] = [
  TIAN_DI_HUI,
  ...CITY_FACTION_GROUPS.flatMap((group) => group.factions),
];

/**
 * The countables left after an install (#389), the cheapest first (ties to the game's order): those `factions` sell
 * (never NeuroFlux Governor or The Red Pill), not installed, queued or in `set`, each with its prerequisites installed,
 * queued, in the set or cheaper here (bought in an earlier cycle; a prerequisite dearer than it leaves it out, cautious),
 * at its reputation after them (`augmentationCost`: the BitNode's `AugmentationRepCost`).
 */
export function countablesLeft({
  factions,
  bitNode,
  state,
  set,
}: {
  factions: readonly string[];
  bitNode: number;
  state: AugmentationPurchaseState;
  set: readonly string[];
}): CountableLeft[] {
  const after = { ...state, queued: [...state.queued, ...set] };
  const sellers = new Map<string, string[]>();
  for (const faction of new Set(factions)) {
    for (const name of augmentationsSoldBy(faction, bitNode, null)) {
      if (name === NEUROFLUX_GOVERNOR || name === THE_RED_PILL) continue;
      if (Object.hasOwn(after.installed, name) || after.queued.includes(name)) continue;
      sellers.set(name, [...(sellers.get(name) ?? []), faction]);
    }
  }
  const sorted = [...sellers].map(([augmentation, each]) => ({
    augmentation,
    reputation: augmentationCost(augmentation, after).reputation,
    sellers: each,
  }));
  sorted.sort((a, b) => a.reputation - b.reputation || gameOrder(a.augmentation) - gameOrder(b.augmentation));
  const left: CountableLeft[] = [];
  const queued = [...after.queued];
  for (const each of sorted) {
    if (missingPrerequisites(each.augmentation, { installed: after.installed, queued }).length > 0) continue;
    left.push(each);
    queued.push(each.augmentation);
  }
  return left;
}

/**
 * The reputation `countables` need, one faction at a time (#389, as `nextCountables` has the work: the reputation at
 * one faction serves all it sells, `PersonObjects/Player/PlayerObject.ts:76`): the dearest first, each at a seller
 * already worked for, else at the seller of the most of them (ties to the first listed), whose reputation it adds.
 * One with no seller adds nothing.
 */
export function reputationOneFactionAtATime(
  countables: readonly { reputation: number; sellers: readonly string[] }[],
): number {
  const dearest = [...countables].sort((a, b) => b.reputation - a.reputation);
  const sells = (faction: string) => countables.filter((each) => each.sellers.includes(faction)).length;
  const worked = new Set<string>();
  let reputation = 0;
  for (const each of dearest) {
    if (each.sellers.length === 0 || each.sellers.some((faction) => worked.has(faction))) continue;
    const seller = each.sellers.reduce((best, faction) => (sells(faction) > sells(best) ? faction : best));
    worked.add(seller);
    reputation += each.reputation;
  }
  return reputation;
}

/**
 * This cycle's work (#389), what the later cycles are priced at: R, its time online before faction work first went on
 * (the rebuild), and the reputation earned this cycle at the joined factions, r_0's measure over T − R.
 */
export interface CycleWork {
  rebuildMs: number;
  reputation: number;
}

/**
 * What prices the later cycles (#389): the countables left (`countablesLeft`), this cycle's work, and what this
 * install installs (each NeuroFlux Governor level an entry): its multipliers raise the rate after it.
 */
export interface LaterCycles {
  left: readonly CountableLeft[];
  work: CycleWork | null;
  installing?: readonly string[];
}

/**
 * The rate's gain from installing `names` (#389): each one's hacking and faction_rep multipliers multiplied, as hacking
 * work's reputation is the hacking level times faction_rep (`PersonObjects/formulas/reputation.ts:18-19`), the level
 * taken as its multiplier's (`PersonObjects/formulas/skill.ts:7-15`; the experience's part left out, cautious).
 */
export function installGain(names: readonly string[]): number {
  let gain = 1;
  for (const name of names) {
    const multipliers = (AUGMENTATIONS[name] as { multipliers?: Readonly<Record<string, number>> } | undefined)
      ?.multipliers;
    gain *= (multipliers?.hacking ?? 1) * (multipliers?.faction_rep ?? 1);
  }
  return gain;
}

/** Whether `work` prices the later cycles (#389): R measured, reputation earned and T past R. */
function pricedBy(work: CycleWork | null | undefined, onlineMs: number): work is CycleWork {
  return work != null && work.reputation > 0 && onlineMs > work.rebuildMs;
}

/**
 * The later cycles' lengths, ms (#389): ⌈`count` / `perCycle`⌉ cycles, each the next `perCycle` of `left` (the last
 * one the rest), R + W_j / r_j: r_0 this cycle's earned over T − R (`onlineMs` T), times `installing`'s gain, then
 * each cycle's own countables' after it. Unpriced, `shapeMs` (this one's shape); past the countables known, the last
 * priced cycle again (none priced, `shapeMs`).
 */
export function laterCyclesMs({
  count,
  perCycle,
  onlineMs,
  shapeMs,
  later,
}: {
  count: number;
  perCycle: number;
  onlineMs: number;
  shapeMs: number;
  later?: LaterCycles | undefined;
}): number[] {
  const cycles: number[] = [];
  const work = later?.work;
  const priced = pricedBy(work, onlineMs);
  let rate = priced ? (work.reputation / (onlineMs - work.rebuildMs)) * installGain(later?.installing ?? []) : 0;
  let last: number | null = null;
  for (let start = 0; start < count; start += perCycle) {
    const size = Math.min(perCycle, count - start);
    const group = later?.left.slice(start, start + size) ?? [];
    if (!priced) {
      cycles.push(shapeMs);
      continue;
    }
    if (group.length < size) {
      cycles.push(last ?? shapeMs);
      continue;
    }
    last = work.rebuildMs + reputationOneFactionAtATime(group) / rate;
    cycles.push(last);
    rate *= installGain(group.map((each) => each.augmentation));
  }
  return cycles;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Install now's estimated time to the count, ms (#343): 0 once the set meets it (`adding` ≥ `needed`); else
 * ⌈(N − n) / n⌉ more cycles, each priced from the countables left (`later`, #389: `laterCyclesMs`), or this one's
 * shape, `onlineMs`, unpriced. Null with nothing new to the count (no install).
 */
export function installNowEstimateMs(
  needed: number,
  adding: number,
  onlineMs: number,
  later?: LaterCycles,
): number | null {
  if (adding >= needed) return 0;
  if (!(adding > 0)) return null;
  return sum(laterCyclesMs({ count: needed - adding, perCycle: adding, onlineMs, shapeMs: onlineMs, later }));
}

/**
 * Waiting for the next `k`'s estimated time to the count, ms (#343): τ_k once the set and they meet it; else τ_k and
 * ⌈(N − n − k) / (n + k)⌉ more cycles, each priced from the countables left after the k (`later`, #389, at this
 * cycle's work), or this one's shape, `onlineMs` + τ_k, unpriced. Null where τ_k is never.
 */
export function waitEstimateMs(
  needed: number,
  adding: number,
  k: number,
  tauMs: number,
  onlineMs: number,
  later?: LaterCycles,
): number | null {
  if (!Number.isFinite(tauMs)) return null;
  if (adding + k >= needed) return tauMs;
  const cycles = laterCyclesMs({
    count: needed - adding - k,
    perCycle: adding + k,
    onlineMs,
    shapeMs: onlineMs + tauMs,
    later,
  });
  return tauMs + sum(cycles);
}

/** A candidate: k 0 installs now, k ≥ 1 waits for the next k (their τ); its estimated time to the count, ms. */
export interface InstallTimingCandidate {
  k: number;
  tauMs: number;
  estimateMs: number;
  /** Its later cycles' lengths, ms, where they're priced from the countables left (#389); absent, this one's shape. */
  cyclesMs?: number[];
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
  /** This cycle's work, where it priced the later cycles from the countables left (#389); absent, unpriced. */
  work?: CycleWork;
}

/**
 * The candidates and the choice (#343): install now (with n above 0) and each next k with a τ (times `tauScale`, an
 * overdue wait's measured error; never, with a τ above 0 times a scale of Infinity), the least estimate chosen; a tie
 * to install (irreversible, it still passes the controller's gate), then to the fewer to wait for. With no income
 * measured (`incomeMeasured` false), installing now is chosen only once the set meets the count; else the least wait,
 * or none (`heldForIncome` says so); likewise while an invitation's money is held (`invitationHeld`,
 * `heldForInvitation`). With `later` (#389), each candidate's later cycles are priced from the countables left (a
 * wait's without the k it waits for, by name), at this cycle's work, its `cyclesMs` given.
 */
export function installTiming({
  needed,
  adding,
  onlineMs,
  next,
  incomeMeasured = true,
  invitationHeld = false,
  tauScale = 1,
  later,
}: {
  needed: number;
  adding: number;
  onlineMs: number;
  next: readonly { tauMs: number; augmentation?: string }[];
  incomeMeasured?: boolean;
  invitationHeld?: boolean;
  tauScale?: number;
  later?: LaterCycles;
}): InstallTiming {
  const priced = pricedBy(later?.work, onlineMs);
  /** A candidate's later cycles, where they're priced and there are any: `cyclesMs`. */
  const cyclesOf = (count: number, perCycle: number, shapeMs: number, after: LaterCycles | undefined) =>
    priced && count > 0 ? { cyclesMs: laterCyclesMs({ count, perCycle, onlineMs, shapeMs, later: after }) } : {};
  const candidates: InstallTimingCandidate[] = [];
  const now = installNowEstimateMs(needed, adding, onlineMs, later);
  if (now !== null) {
    const cycles = cyclesOf(needed - adding, adding, onlineMs, later);
    candidates.push({ k: 0, tauMs: 0, estimateMs: now, ...cycles });
  }
  for (const [index, each] of next.entries()) {
    const k = index + 1;
    const tauMs = each.tauMs === 0 ? 0 : each.tauMs * tauScale;
    const waitedFor = next.slice(0, k).map((one) => one.augmentation);
    const left = (later?.left ?? []).filter((one) => !waitedFor.includes(one.augmentation));
    const installing = [...(later?.installing ?? []), ...next.slice(0, k).flatMap((one) => one.augmentation ?? [])];
    const afterWait = later === undefined ? undefined : { left, work: later.work, installing };
    const estimateMs = waitEstimateMs(needed, adding, k, tauMs, onlineMs, afterWait);
    if (estimateMs !== null) {
      candidates.push({
        k,
        tauMs,
        estimateMs,
        ...cyclesOf(needed - adding - k, adding + k, onlineMs + tauMs, afterWait),
      });
    }
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
  const work = priced && later?.work != null ? { work: later.work } : {};
  return { needed, adding, onlineMs, candidates, choice, heldForIncome, heldForInvitation, tauScale, ...work };
}
