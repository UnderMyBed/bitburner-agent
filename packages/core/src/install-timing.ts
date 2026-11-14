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
 * times optimistic at BN4.2's c6 and c7, 46 min against 128 and 31 against 96), from its install
 * (`laterCyclesMs`):
 * - **R, the rebuild:** measured, this cycle's own: its time online before faction work (A5's or the owner's) first
 *   went on (the brain's), the invitations, the hacking level and A5's start in it (BN4.2's c2-c9: 4-5 min);
 * - **the level's path** (#401, core's level-rise.ts): from no experience after each install, κ (the brain's: the
 *   rate measured now or carried over the last install, per level + 50) times the `hacking_exp` and `hacking_speed`
 *   of every install before the cycle, m times their `hacking` (`laterCycleRise`, `levellingInstallMultipliers`:
 *   this one's first, `LaterCycles.installing`, then each later cycle's own countables), flat first for the measured
 *   ramp's dead time (#405);
 * - **the work:** from R, each faction in turn (`factionsOneAtATime`), to its reputation along the path at the work's
 *   rate at each level (the caller's `rateAt`: the game's formula, favour, the share's mean), times the installs'
 *   `faction_rep` (`reputation.ts:16-52`);
 * - **the countables:** `countablesLeft`, cheapest first (the A5 hook works for the first countable it waits for,
 *   #344, and BN4.2's c7-c9 bought the 4 cheapest left after c6 in that order): the factions joined, and Tian Di Hui's
 *   and the city factions' (#228: a city and money); split into cycles to the least total (`laterCyclesMs`'s
 *   recurrence), the policy the planner runs. Grouped n a cycle as this one instead, BN4.2's c2 and c4 (n 1) priced 13
 *   and 8 cycles of one, each with its ramp from level 1: 2.63 and 2.19 times their actual.
 * Unpriced (no R measured: a cycle first seen past its first work, or a restart before it; no rate known, κ 0), each is
 * this one's shape (T, or T + τ_k after a wait), as before #389; countables past those known, the last priced cycle's
 * length again (labelled: either way). BN4.2's hindcast, c2-c8 (core's install-timing.test.ts, on #401's fixture):
 * install now 0.67-1.34 times the actual, every one within ×2 (before #389, 5 of 7); the planner's choice main's but at
 * c3 (a wait for 3, about 20 min worse in hindsight, right in expectation) and c8 (a wait for the last, 4 min better).
 * The caller prices from its second cycle alone (#389's decision; the brain's: a κ carried over an install): in the
 * first, every later cycle's rate is this cycle's κ through an install not made, and install now mustn't win on that.
 * Installing now is chosen only by more than the best wait's error through its τ (#406, `installTiming`).
 * Left out, each labelled:
 * - level-rise.ts's own (home RAM and servers bought later, the share's change, the batcher's target): see there;
 * - the favour gained at the install and after: the caller's rate at the favour after this install, none after it
 *   (cautious for "install now"); a faction not joined at none (cautious);
 * - the work type and its rate at the skills other than hacking now (the brain's), which the install resets:
 *   optimistic for "install now" where a type other than hacking is best (#399's review);
 * - the work at factions bought nothing from (BN4.2's needed over earned 0.67-0.87): optimistic for "install now";
 * - the factions within a cycle worked dearest first, each from where the last ended: either way;
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
 *   there and the share starts): cautious for waiting, optimistic for installing now; since #401 along the hacking
 *   level's rise (core's level-rise.ts: κ the larger of the experience rate measured now and the last cycle's, times
 *   the install's gains, the last cycle's after its measured ramp, #405's review): RAM bought from now on left out,
 *   cautious for waiting; but the last cycle's rate was measured on cloud servers the install deleted (`Prestige.ts`),
 *   optimistic for waiting early in a cycle, until they're bought back, beyond what the ramp's dead time stands in
 *   for; with neither measured, at the level now, as before.
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
import { type LevelRise, laterCycleRise, steps as levelSteps } from "./level-rise.ts";
import { addsToLevelling, levellingInstallMultipliers } from "./levelling.ts";

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
  return factionsOneAtATime(countables).reduce((sum, each) => sum + each.reputation, 0);
}

/**
 * The factions `countables` are worked at, one at a time (#389), and each one's reputation: `reputationOneFactionAtATime`'s
 * choice, the dearest first.
 */
export function factionsOneAtATime(
  countables: readonly { reputation: number; sellers: readonly string[] }[],
): { faction: string; reputation: number }[] {
  const dearest = [...countables].sort((a, b) => b.reputation - a.reputation);
  /** How many of them each faction sells, counted once. */
  const sold = new Map<string, number>();
  for (const { sellers } of countables) {
    for (const [index, faction] of sellers.entries()) {
      if (sellers.indexOf(faction) === index) sold.set(faction, (sold.get(faction) ?? 0) + 1);
    }
  }
  const sells = (faction: string) => sold.get(faction) ?? 0;
  const worked: { faction: string; reputation: number }[] = [];
  const workedAt = new Set<string>();
  for (const each of dearest) {
    if (each.sellers.length === 0 || each.sellers.some((faction) => workedAt.has(faction))) continue;
    const seller = each.sellers.reduce((best, faction) => (sells(faction) > sells(best) ? faction : best));
    worked.push({ faction: seller, reputation: each.reputation });
    workedAt.add(seller);
  }
  return worked;
}

/**
 * What prices the later cycles (#389): the countables left (`countablesLeft`); R, an install's time online to its first
 * faction work (the brain's, measured; null not); the hacking level's path now (#401, `LevelRise`, κ the brain's) and
 * the dead time each cycle after an install starts flat for (the brain's measured ramp, #405); the work's rate at a
 * faction at a level, rep/s, before the installs' faction_rep (the caller's: favour, the share's mean, the
 * conditions); and what this install installs (each NeuroFlux Governor level an entry).
 */
export interface LaterCycles {
  left: readonly CountableLeft[];
  rebuildMs: number | null;
  rise: LevelRise | null;
  deadSeconds: number;
  rateAt: (faction: string, level: number) => number;
  installing: readonly string[];
}

/** Later cycles that price (`pricedBy`). */
type PricedLaterCycles = LaterCycles & { rebuildMs: number; rise: LevelRise };

/** Whether `later` prices the later cycles (#389): R measured, and a level that rises (κ and m above 0). */
function pricedBy(later: LaterCycles | undefined): later is PricedLaterCycles {
  return (
    later !== undefined &&
    later.rebuildMs !== null &&
    later.rise !== null &&
    later.rise.kappa > 0 &&
    later.rise.levelMult > 0
  );
}

/** The faction_rep multiplier of installing `names` (#389): each one's, multiplied (`reputation.ts:16-52`). */
export function factionRepGain(names: readonly string[]): number {
  let gain = 1;
  for (const name of names) {
    const multipliers = (AUGMENTATIONS[name] as { multipliers?: Readonly<Record<string, number>> } | undefined)
      ?.multipliers;
    gain *= multipliers?.faction_rep ?? 1;
  }
  return gain;
}

/**
 * A level's path tabulated (#389), walked many times by the later cycles' recurrence: each step's end (seconds), and
 * the reputation a level-linear rate a + b·L earns to it, as Σ over the steps of (a + b·(L₀ + L₁)/2)·Δt (the same
 * trapezoid as `workSecondsAlong`), kept as Σ Δt and Σ ((L₀ + L₁)/2)·Δt, each step's mean level from them; extended as
 * far as asked. A walk starts at its step found by bisection on the ends (#399's review: a scan from the first step
 * was most of the cost).
 */
class PathTable {
  readonly #steps: Generator<{ toSeconds: number; toLevel: number }>;
  readonly #ends: number[] = [0];
  readonly #levelTime: number[] = [0];
  /** Each step's mean level, Σ L·dt over it over its Δt (0 for a step of no length). */
  readonly #meanLevels: number[] = [];
  /** The level at each end (#413): the path's start, then each step's. */
  readonly #levels: number[];
  /** The seconds to each level asked for (#413, `secondsToLevel`), found once a path. */
  readonly #toLevel = new Map<number, number>();
  #level: number;
  #done = false;

  constructor(rise: LevelRise) {
    this.#steps = levelSteps(rise);
    this.#level = rise.level;
    this.#levels = [rise.level];
  }

  /**
   * The seconds along the path until the level reaches `level` (#413): 0 at or past it now; linear across the step it's
   * reached in (as `levelAlong`); Infinity where the path never does (flat, or past its steps). `fresh` says whether it
   * was walked now or found (the cost's count).
   */
  secondsToLevel(level: number): { seconds: number; fresh: boolean } {
    const known = this.#toLevel.get(level);
    if (known !== undefined) return { seconds: known, fresh: false };
    const levels = this.#levels;
    let seconds = 0;
    if ((levels[0] as number) < level) {
      while ((levels.at(-1) as number) < level) {
        if (!this.#extend()) break;
      }
      if ((levels.at(-1) as number) < level) {
        seconds = Number.POSITIVE_INFINITY;
      } else {
        // The first end at or past the level (the levels never fall): the step before it starts below it.
        let low = 1;
        let high = levels.length - 1;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if ((levels[middle] as number) >= level) high = middle;
          else low = middle + 1;
        }
        const [from, to] = [levels[low - 1] as number, levels[low] as number];
        const [start, end] = [this.#ends[low - 1] as number, this.#ends[low] as number];
        seconds = start + ((end - start) * (level - from)) / (to - from);
      }
    }
    this.#toLevel.set(level, seconds);
    return { seconds, fresh: true };
  }

  /** Extends the table by a step: false past its end. */
  #extend(): boolean {
    if (this.#done) return false;
    const next = this.#steps.next();
    if (next.done === true) {
      this.#done = true;
      return false;
    }
    const from = this.#ends.at(-1) as number;
    const meanLevel = (this.#level + next.value.toLevel) / 2;
    const levelTimeAt = this.#levelTime.at(-1) as number;
    const levelTime = levelTimeAt + meanLevel * (next.value.toSeconds - from);
    const to = next.value.toSeconds;
    this.#levelTime.push(levelTime);
    this.#ends.push(to);
    this.#meanLevels.push(to > from ? (levelTime - levelTimeAt) / (to - from) : 0);
    this.#levels.push(next.value.toLevel);
    this.#level = next.value.toLevel;
    return true;
  }

  /**
   * The seconds until the work from `fromSeconds` has earned `reputation` at a + b·L a second: `workSecondsAlong` for a
   * level-linear rate. Infinity where it never does.
   */
  workSeconds(a: number, b: number, reputation: number, fromSeconds: number): number {
    if (!(reputation > 0)) return fromSeconds;
    const ends = this.#ends;
    const meanLevels = this.#meanLevels;
    // The first step ending past `fromSeconds` (the ends never fall): those before it earn nothing.
    while ((ends.at(-1) as number) <= fromSeconds) {
      if (!this.#extend()) break;
    }
    let low = 0;
    let high = ends.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((ends[middle + 1] as number) <= fromSeconds) low = middle + 1;
      else high = middle;
    }
    let earned = 0;
    for (let index = low; ; index++) {
      if (ends.length <= index + 1 && !this.#extend()) return Number.POSITIVE_INFINITY;
      const to = ends[index + 1] as number;
      // Past the first step, its own start: every later one starts after fromSeconds.
      const start = index === low ? Math.max(ends[index] as number, fromSeconds) : (ends[index] as number);
      const rate = a + b * (meanLevels[index] as number);
      const gained = rate * (to - start);
      if (rate > 0 && earned + gained >= reputation) return start + (reputation - earned) / rate;
      earned += Math.max(0, gained);
    }
  }
}

/** The path and `faction_rep` after some installs (`LaterPricing.after`), and the cycles priced after them. */
interface Installs {
  table: PathTable;
  repGain: number;
  cycles: Map<string, number>;
}

/**
 * What one reading's later cycles share (#399's review: priced afresh, a reading took 80 ms, the brain's rule 40 times
 * main's): the work's rate at each faction, read once (`rateAt` at levels 0 and 1); the level's paths, tabulated once a
 * path (`PathTable`); and each cycle C(i, j), priced once for what it depends on: its path (κ, m and the dead time),
 * the installs' `faction_rep` and its countables. Every candidate's DP draws on it: a wait's cycles are mostly install
 * now's, after the same installs. The figures are the same as each priced afresh (the same arithmetic, in the same order).
 */
/**
 * The later cycles' work in a reading (#399's round 3: counted, not timed, so a test can bound it on any machine): the
 * cycles priced, and those asked for.
 */
export interface LaterPricingCounts {
  /** Cycles C(i, j) priced: each a walk of the level's path per faction. */
  priced: number;
  /** Cycles asked for: the DP's B(i) + C(i, j) terms, each priced or found priced. */
  lookups: number;
  /** Paths walked to Daedalus's level (#413, `levelInstallTiming`): each path once; absent where none was. */
  levels?: number;
}

class LaterPricing {
  readonly #later: PricedLaterCycles;
  readonly #counts: LaterPricingCounts | undefined;
  readonly #rates = new Map<string, readonly [number, number]>();
  readonly #tables = new Map<string, PathTable>();
  /** By the path and `faction_rep` after the installs: each with its cycles priced, by their countables' ids. */
  readonly #installs = new Map<string, Installs>();
  readonly #ids = new Map<string, number>();
  /** Each group's factions in turn (`factionsOneAtATime`), by their countables' ids: the same after any installs. */
  readonly #worked = new Map<string, { faction: string; reputation: number }[]>();

  /** The dead time a ramp in the rate (#413's review, `rampSeconds`), not a flat level: the level timing's alone. */
  readonly #ramp: boolean;

  constructor(later: PricedLaterCycles, counts?: LaterPricingCounts, ramp = false) {
    this.#later = later;
    this.#counts = counts;
    this.#ramp = ramp;
  }

  /** The path and `faction_rep` after the installs of `installed` (`laterCycleRise`, `levellingInstallMultipliers`). */
  after(installed: readonly string[]): Installs {
    const later = this.#later;
    const rise = laterCycleRise(later.rise, levellingInstallMultipliers(0, installed), later.deadSeconds, this.#ramp);
    const pathKey = `${rise.levelMult} ${rise.kappa} ${rise.delaySeconds ?? 0} ${rise.rampSeconds ?? 0}`;
    const repGain = factionRepGain(installed);
    const key = `${pathKey} ${repGain}`;
    let installs = this.#installs.get(key);
    if (installs === undefined) {
      let table = this.#tables.get(pathKey);
      if (table === undefined) {
        table = new PathTable(rise);
        this.#tables.set(pathKey, table);
      }
      installs = { table, repGain, cycles: new Map() };
      this.#installs.set(key, installs);
    }
    return installs;
  }

  /**
   * A later cycle's length, ms (#389): from its install, the level's path after every install before it (`installs`,
   * from `after`: flat for the dead time), the work from R at each faction of `group` (its countables, `groupKey` their
   * ids, `id`) in turn (`factionsOneAtATime`), each to its reputation along the path at the work's rate times their
   * `faction_rep`, the rate linear in the level (hacking work's formula, `reputation.ts:16-52`: the caller's, read at
   * levels 0 and 1).
   */
  cycleMs(group: () => readonly CountableLeft[], groupKey: string, installs: Installs): number {
    if (this.#counts !== undefined) this.#counts.lookups += 1;
    const known = installs.cycles.get(groupKey);
    if (known !== undefined) return known;
    if (this.#counts !== undefined) this.#counts.priced += 1;
    const later = this.#later;
    let seconds = later.rebuildMs / 1000;
    let worked = this.#worked.get(groupKey);
    if (worked === undefined) {
      worked = factionsOneAtATime(group());
      this.#worked.set(groupKey, worked);
    }
    for (const { faction, reputation } of worked) {
      const [at0, at1] = this.#rate(faction);
      const a = at0 * installs.repGain;
      const b = at1 * installs.repGain - a;
      seconds = installs.table.workSeconds(a, b, reputation, seconds);
    }
    const ms = seconds * 1000;
    installs.cycles.set(groupKey, ms);
    return ms;
  }

  /**
   * The cycle after `installs` to Daedalus's `level`, ms (#413): from its install along its path (`after`'s, flat for
   * the dead time first: the restart, the hack loop and the servers again, #405), the work's R aside, as the level
   * rises from the install whatever the work does. Each path walked once a reading (`levels` counts them).
   */
  levelMs(installs: Installs, level: number): number {
    const { seconds, fresh } = installs.table.secondsToLevel(level);
    if (fresh && this.#counts !== undefined) this.#counts.levels = (this.#counts.levels ?? 0) + 1;
    return seconds * 1000;
  }

  /** A countable's id in the cycles' keys, by name (a reading's countables left are the same throughout). */
  id(augmentation: string): number {
    let id = this.#ids.get(augmentation);
    if (id === undefined) {
      id = this.#ids.size;
      this.#ids.set(augmentation, id);
    }
    return id;
  }

  #rate(faction: string): readonly [number, number] {
    let rate = this.#rates.get(faction);
    if (rate === undefined) {
      rate = [this.#later.rateAt(faction, 0), this.#later.rateAt(faction, 1)];
      this.#rates.set(faction, rate);
    }
    return rate;
  }
}

/**
 * The later cycles' lengths, ms (#389), the cheapest first (`left`) split into cycles to the least total, the policy the
 * planner itself runs (install timing falls out of the rollouts, architecture §4.5.3): with C(i, j) the cycle of
 * countables i to j − 1 after the installs of `installing` and countables 0 to i − 1 (`LaterPricing`), the least total
 * to j is B(j) = min over i < j of B(i) + C(i, j), B(0) = 0, for the `count` (at most those known), and the cycles are
 * B's own. Its cost: count · (count + 1) / 2 cycles, each a walk of the level's path per faction (465 at 30, the count's
 * most), shared between a reading's candidates (`installTiming`). Unpriced (`pricedBy`), ⌈`count` / `perCycle`⌉ cycles
 * of `shapeMs` each (this one's shape, as before #389); past the countables known, those left priced ⌈rest /
 * `perCycle`⌉ cycles of the last priced cycle's length again (labelled: either way).
 */
export function laterCyclesMs(args: {
  count: number;
  perCycle: number;
  shapeMs: number;
  later?: LaterCycles | undefined;
}): number[] {
  const { later } = args;
  const priced = pricedBy(later)
    ? { pricing: new LaterPricing(later), left: later.left, installing: later.installing }
    : undefined;
  return laterCyclesShaped(args, priced).cycles;
}

/**
 * The recurrence (#389), shared by the count's DP and the level's (#413): with C(i, j) the cycle of `left`'s i to j − 1
 * after the installs of `installing` and `left`'s 0 to i − 1 (`LaterPricing`), B(j) = min over i < j of B(i) + C(i, j),
 * B(0) = 0, for every j to `left`'s length; each B(j) with the i it came from, and the installs before each cycle i.
 */
function leastSplits(
  pricing: LaterPricing,
  left: readonly CountableLeft[],
  installing: readonly string[],
  perCycleMs = 0,
): { best: { totalMs: number; from: number }[]; installs: Installs[] } {
  const known = left.length;
  const names = left.map((each) => each.augmentation);
  /** The installs before cycle i: `installing` and countables 0 to i − 1. */
  const installs = Array.from({ length: known }, (_, i) => pricing.after([...installing, ...names.slice(0, i)]));
  /** Countables i to j − 1's key, by their ids, for each i: grown by one as j grows. */
  const groupKeys: string[] = [];
  const best: { totalMs: number; from: number }[] = [{ totalMs: 0, from: 0 }];
  for (let j = 1; j <= known; j++) {
    const id = pricing.id(names[j - 1] as string);
    for (let i = 0; i < j - 1; i++) groupKeys[i] = `${groupKeys[i]},${id}`;
    groupKeys[j - 1] = `${id}`;
    let least = { totalMs: Number.POSITIVE_INFINITY, from: 0 };
    for (let i = 0; i < j; i++) {
      const before = best[i] as { totalMs: number };
      const installed = installs[i] as Installs;
      const totalMs =
        before.totalMs + pricing.cycleMs(() => left.slice(i, j), groupKeys[i] as string, installed) + perCycleMs;
      if (totalMs < least.totalMs) least = { totalMs, from: i };
    }
    best.push(least);
  }
  return { best, installs };
}

/** The cycles to B(`to`), each one's length, from the recurrence's `best` (`leastSplits`). */
function splitCycles(best: readonly { totalMs: number; from: number }[], to: number): number[] {
  const cycles: number[] = [];
  for (let j = to; j > 0; j = (best[j] as { from: number }).from) {
    const { totalMs, from } = best[j] as { totalMs: number; from: number };
    cycles.unshift(totalMs - (best[from] as { totalMs: number }).totalMs);
  }
  return cycles;
}

/**
 * `laterCyclesMs` with a reading's shared `pricing` where it prices (`priced`: the pricing, which holds R, the rise,
 * the dead time and the rate, and the candidate's own countables left and installs), and how many of the cycles are
 * `shapeMs` itself (`shaped`: all unpriced; past the countables known with none priced, the rest): a wait's estimate
 * moves with its τ through them (#399's review).
 */
function laterCyclesShaped(
  { count, perCycle, shapeMs }: { count: number; perCycle: number; shapeMs: number },
  priced: { pricing: LaterPricing; left: readonly CountableLeft[]; installing: readonly string[] } | undefined,
): { cycles: number[]; shaped: number } {
  if (!(count > 0)) return { cycles: [], shaped: 0 };
  if (priced === undefined) {
    const shaped = Math.ceil(count / perCycle);
    return { cycles: Array.from({ length: shaped }, () => shapeMs), shaped };
  }
  const { pricing, installing } = priced;
  const left = priced.left.slice(0, count);
  const known = left.length;
  const { best } = leastSplits(pricing, left, installing);
  const cycles = splitCycles(best, known);
  const rest = count - known;
  let shaped = 0;
  if (rest > 0) {
    const lastMs = cycles.at(-1) ?? shapeMs;
    const more = Math.ceil(rest / perCycle);
    if (cycles.length === 0) shaped = more;
    cycles.push(...Array.from({ length: more }, () => lastMs));
  }
  return { cycles, shaped };
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
  return sum(laterCyclesMs({ count: needed - adding, perCycle: adding, shapeMs: onlineMs, later }));
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
  const cycles = laterCyclesMs({ count: needed - adding - k, perCycle: adding + k, shapeMs: onlineMs + tauMs, later });
  return tauMs + sum(cycles);
}

/** A candidate: k 0 installs now, k ≥ 1 waits for the next k (their τ); its estimated time to the count, ms. */
export interface InstallTimingCandidate {
  k: number;
  tauMs: number;
  estimateMs: number;
  /** Its later cycles' lengths, ms, where they're priced from the countables left (#389); absent, this one's shape. */
  cyclesMs?: number[];
  /**
   * A wait's estimate's error through its τ, ms (#406): its τ's relative error (its own, else `tauError`) times its τ
   * as measured (no `tauScale`), times 1 + its later cycles of this one's shape, T + τ (unpriced; #399's review);
   * absent where 0.
   */
  errorMs?: number;
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
  /** What priced the later cycles from the countables left (#389): R, the dead time and κ; absent, unpriced. */
  later?: { rebuildMs: number; deadSeconds: number; kappa: number };
  /** The relative error of a wait's τ (#406, `tauRelativeError`), where a wait gives none of its own. */
  tauError: number;
  /** The margin the choice was kept by, ms (#406): the error it was compared within; absent where none kept it. */
  marginMs?: number;
  /**
   * What the margin kept (#406): "margin", a wait chosen as installing now didn't beat the best wait by more than its
   * error; "held", the choice of the last reading kept as no rival beat it by more than the error; null, neither.
   */
  kept: "margin" | "held" | null;
}

/**
 * A rate's relative standard error from its samples (#406): the standard deviation of the samples over √n, over their
 * mean (the error of a mean of n independent samples); null with fewer than 2 or a mean not above 0.
 */
export function meanRelativeError(samples: readonly number[]): number | null {
  const n = samples.length;
  if (n < 2) return null;
  const mean = samples.reduce((sum, each) => sum + each, 0) / n;
  if (!(mean > 0)) return null;
  const variance = samples.reduce((sum, each) => sum + (each - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance / n) / mean;
}

/**
 * The relative error of a τ by work (#406), from the rates' measured errors over their windows, added in quadrature
 * (independent errors, to first order): the share bonus's mean (#351, `shareBonusMean`'s samples, `meanRelativeError`):
 * a τ by work goes as 1 over the work's rate, proportional to the share bonus, so its relative error is the share's;
 * and κ's (#405, `HackingExpRate`'s steps), propagated through the τ itself: the caller's τ again at κ lowered by its
 * relative error, the change over the τ (`kappaPart`). None measured: 0 (the margin then only breaks ties, to the
 * wait; with no income measured, the hold for it applies).
 */
export function tauRelativeError(shareError: number | null, kappaPart: number | null): number {
  return Math.sqrt((shareError ?? 0) ** 2 + (kappaPart ?? 0) ** 2);
}

/**
 * The candidates and the choice (#343): install now (with n above 0) and each next k with a τ (times `tauScale`, an
 * overdue wait's measured error; never, with a τ above 0 times a scale of Infinity), the least estimate chosen, a tie to
 * the fewer to wait for. Installing now, irreversible, is chosen over the best wait only when it beats it by more than
 * the error of their difference (#406): the wait's estimate's through its τ (`errorMs`: `tauError` times its τ, times
 * 1 + its later cycles of this one's shape, T + τ, where unpriced; priced from the countables left, they don't move with
 * the τ); within it, or a tie, the wait, which the next reading decides again. And a choice the last reading made
 * (`held`, a k above 0: the wait under way) is kept until a rival beats it by more than the larger error of the two
 * (the hysteresis #406 filed: a choice doesn't flap within the error). With no income
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
  tauError = 0,
  held = null,
  counts,
}: {
  needed: number;
  adding: number;
  onlineMs: number;
  next: readonly { tauMs: number; augmentation?: string; tauError?: number }[];
  incomeMeasured?: boolean;
  invitationHeld?: boolean;
  tauScale?: number;
  later?: LaterCycles;
  tauError?: number;
  held?: number | null;
  /** Counts the later cycles' work (`LaterPricingCounts`), where priced: tests alone. */
  counts?: LaterPricingCounts;
}): InstallTiming {
  const priced = pricedBy(later);
  // Each candidate's later cycles priced once, from one reading's shared pricing (#399's review), as
  // `installNowEstimateMs` and `waitEstimateMs` price them.
  const pricing = priced ? new LaterPricing(later, counts) : undefined;
  const cyclesOf = (
    count: number,
    perCycle: number,
    shapeMs: number,
    left: readonly CountableLeft[],
    installing: readonly string[],
  ) =>
    laterCyclesShaped({ count, perCycle, shapeMs }, pricing === undefined ? undefined : { pricing, left, installing });
  /** A candidate's later cycles, where they're priced and there are any: `cyclesMs`. */
  const shown = (cycles: number[], count: number) => (priced && count > 0 ? { cyclesMs: cycles } : {});
  const candidates: InstallTimingCandidate[] = [];
  if (adding >= needed) {
    candidates.push({ k: 0, tauMs: 0, estimateMs: 0 });
  } else if (adding > 0) {
    const { cycles } = cyclesOf(needed - adding, adding, onlineMs, later?.left ?? [], later?.installing ?? []);
    candidates.push({ k: 0, tauMs: 0, estimateMs: sum(cycles), ...shown(cycles, needed - adding) });
  }
  for (const [index, each] of next.entries()) {
    const k = index + 1;
    const tauMs = each.tauMs === 0 ? 0 : each.tauMs * tauScale;
    if (!Number.isFinite(tauMs)) continue;
    const waitedFor = next.slice(0, k).map((one) => one.augmentation);
    const left = (later?.left ?? []).filter((one) => !waitedFor.includes(one.augmentation));
    const installing = [...(later?.installing ?? []), ...next.slice(0, k).flatMap((one) => one.augmentation ?? [])];
    const count = needed - adding - k;
    const { cycles, shaped } =
      count > 0 ? cyclesOf(count, adding + k, onlineMs + tauMs, left, installing) : { cycles: [], shaped: 0 };
    const estimateMs = count > 0 ? tauMs + sum(cycles) : tauMs;
    // #406: the estimate's error through the τ: the τ's own and each later cycle's of this one's shape, T + τ (unpriced,
    // c = ⌈(N − n − k) / (n + k)⌉ of them), so the τ's error times 1 + c (#399's review); the cycles priced from the
    // countables left don't move with it. On the τ as measured: an overdue wait's scale would strengthen a stalled
    // wait's hold, against the overdue rule (#399's review).
    const errorMs = (each.tauError ?? tauError) * each.tauMs * (1 + shaped);
    candidates.push({ k, tauMs, estimateMs, ...shown(cycles, count), ...(errorMs > 0 ? { errorMs } : {}) });
  }
  const least = (allowed: (candidate: InstallTimingCandidate) => boolean) => {
    let best: InstallTimingCandidate | null = null;
    for (const candidate of candidates) {
      if (allowed(candidate) && (best === null || candidate.estimateMs < best.estimateMs)) best = candidate;
    }
    return best;
  };
  const best = least(() => true);
  const bestWait = least((candidate) => candidate.k > 0);
  const margin = (...each: InstallTimingCandidate[]) => Math.max(0, ...each.map((one) => one.errorMs ?? 0));
  let kept: InstallTiming["kept"] = null;
  let marginMs: number | null = null;
  let chosen = best;
  // Installing now only by more than the best wait's τ's error (#406), short of the count.
  if (best?.k === 0 && adding < needed && bestWait !== null) {
    if (!(best.estimateMs < bestWait.estimateMs - margin(bestWait))) {
      chosen = bestWait;
      kept = "margin";
      marginMs = margin(bestWait);
    }
  }
  const installing = chosen?.k === 0 && adding < needed;
  const heldForIncome = installing && !incomeMeasured;
  const heldForInvitation = installing && invitationHeld;
  if (heldForIncome || heldForInvitation) chosen = bestWait;
  // The last reading's choice kept, unless a rival beats it by more than the error (#406's hysteresis).
  const last = held !== null && held > 0 ? candidates.find((candidate) => candidate.k === held) : undefined;
  if (last !== undefined && chosen !== null && chosen.k !== last.k && !(chosen.k === 0 && adding >= needed)) {
    if (!(chosen.estimateMs < last.estimateMs - margin(chosen, last))) {
      marginMs = margin(chosen, last);
      chosen = last;
      kept = "held";
    }
  }
  const choice = chosen?.k ?? null;
  const work =
    priced && later.rebuildMs !== null
      ? { later: { rebuildMs: later.rebuildMs, deadSeconds: later.deadSeconds, kappa: later.rise?.kappa ?? 0 } }
      : {};
  return {
    needed,
    adding,
    onlineMs,
    candidates,
    choice,
    heldForIncome,
    heldForInvitation,
    tauScale,
    ...work,
    tauError,
    kept,
    ...(marginMs === null ? {} : { marginMs }),
  };
}

/**
 * One faction's next of the hacking set by work there (#413), in turn: the brain's `nextCountables` on that faction's
 * countables by work alone, each τ the work there to it (and the money for the set and them at the income).
 */
export interface LevelWait {
  faction: string;
  next: readonly { augmentation: string; tauMs: number; tauError?: number }[];
}

/** A candidate of the level's timing (#413): install now (k 0), or wait for `faction`'s next k and then install. */
export interface LevelTimingCandidate {
  k: number;
  /** The faction a wait works at (A5's there); absent installing now. */
  faction?: string;
  /** The augmentations waited for, in turn. */
  waitedFor: string[];
  tauMs: number;
  /** Its estimated time to Daedalus's level, ms: τ, the later cycles, and the last one's time to the level. */
  estimateMs: number;
  /** The later cycles before the one that reaches the level (#389's DP, split to the least total), each's length, ms. */
  cyclesMs: number[];
  /** That cycle's time from its install to the level, along its path, ms (Infinity never). */
  levelMs: number;
  /** A wait whose τ is past this cycle's own time to the invitation (`stayMs`): its estimate is that. */
  stays?: true;
  /** A wait's estimate's error (#406): its τ's relative error times its τ; staying, κ's times `stayMs`. */
  errorMs?: number;
}

/** The planner's install timing after Daedalus's count (#413): the candidates, staying, the choice and A5's work. */
export interface LevelTiming {
  /** Daedalus's hacking level (`daedalusRequirements`). */
  required: number;
  /** This cycle's own time to the invitation, no install: its path to the level, the money at the income; ms. */
  stayMs: number;
  candidates: LevelTimingCandidate[];
  /** The candidate chosen, by its index; null: none to install now or wait for, or staying beat them (no install). */
  choice: number | null;
  /** The chosen estimate (staying's where none is chosen), ms: the time to Daedalus's invitation. */
  estimateMs: number;
  /**
   * A5's work (#413): the chosen wait's faction and its first augmentation; installing now or staying, the best
   * wait's (the faction whose next augmentation most cuts the time to the level); null with no wait priced.
   */
  work: { faction: string; augmentation: string } | null;
  tauError: number;
  /** As `InstallTiming`'s (#406): what the margin kept, and the margin, ms. */
  kept: "margin" | "held" | null;
  marginMs?: number;
  /** Installing now was the least but held (#343's guards): no income measured; an invitation's money held. */
  heldForIncome: boolean;
  heldForInvitation: boolean;
  /** What priced the later cycles: R, the dead time, κ, and the hacking set left (its count). */
  later: { rebuildMs: number; deadSeconds: number; kappa: number; left: number };
}

/**
 * The planner's install timing after Daedalus's count (#413, roadmap #347 Track 2 item 4): with the count met
 * (`FactionInfo.tsx:141-145`: `DaedalusAugsRequirement` installed, kept through every install: `Prestige.ts:55-110`
 * and `PlayerObjectGeneralMethods.ts:80-134` reset the skills, the experience and the money and reapply `augmentations`),
 * the invitation waits on hacking 2,500 (`haveSkill("hacking", 2500)`) and $100b held (`haveMoney(100e9)`). The level
 * is m·(32·ln(exp + 534.6) − 200) (`calculateSkill`, `skill.ts:7-15`), so at a level multiplier m it needs
 * exp((2500/m + 200)/32) − 534.6 experience: at BN4's m 2.75 after the count about 1e15 against the 7e9 a cycle earns,
 * so only an install that raises m gets there. Each candidate's time to the level:
 * - **install now:** the cycle after it along `laterCycleRise` at the install's multipliers (#405's level path, its dead
 *   time a ramp in the rate, the level rising during it: #413's review, `rampSeconds`), to the level (`levelMs`); or,
 *   where the hacking set's later cycles reach it sooner, those by
 *   #389's DP (`leastSplits`, `LaterPricing`: the same recurrence and the same cycles, shared by every candidate of a
 *   reading) and the last one's time to the level: the least over j of B(j) and its level's time after j;
 * - **wait for a faction's next k** (`waits`, A5's work there): τ_k, then likewise after the install of them too; or
 *   this cycle's own time to the invitation where that's sooner (`stays`: then no wait, staying, choice null).
 * The hacking set: the countables left that add to levelling (`addsToLevelling`: the level's multiplier, its
 * experience's or its speed's), cheapest first, from the joined and later-cycle factions (`countablesLeft`). Installing
 * now is chosen only past the best wait's error (#406's rule, `marginMs`), or staying's (κ's), a tie to the wait; a
 * wait under way (`held`, by faction and k) is kept unless a rival beats it by more than the larger error. Never an
 * install of nothing that adds to the level (it would only reset it). Null where the later cycles aren't priced (no R
 * measured, no level's rise, `pricedBy`): the caller's count rule, labelled.
 * Left out, each labelled:
 * - the money after an install: the invitation's $100b taken as there when the level is (BN4.2's c12 and BN4.3's c14
 *   held $8.5e10 and $9.3e10 at +5 min, their level past 2,500): optimistic by a minute or two;
 * - the combat route (every combat skill 1,500, `haveCombatSkills(1500)`): BN4 and BN1 are hacking BitNodes, the brain
 *   trains no combat and works no field work for it (A5 works hacking), so it isn't priced (the Black Ops' route,
 *   #404, prices combat where it's the way);
 * - Intelligence (`calculateIntelligenceBonus`, the level's and the work's): left at none, cautious, as level-rise.ts;
 * - the countables bought by a donation or the money alone, and the work at two factions within a wait: not among the
 *   waits (cautious for waiting); the faction_rep-only augmentations (no level, faster work): not in the hacking set
 *   (cautious); NeuroFlux Governor's levels at a wait's end: today's, held (`installing`'s);
 * - level-rise.ts's and #389's own (RAM bought later, the share's change, the batcher's target; the favour after the
 *   install, the work type, restarts and time offline).
 */
export function levelInstallTiming({
  required,
  rise,
  moneyMs = 0,
  kappaError = 0,
  waits,
  later,
  tauError = 0,
  held = null,
  commitMs = 0,
  incomeMeasured = true,
  invitationHeld = false,
  counts,
}: {
  required: number;
  /** This cycle's level's path now (the brain's: κ measured now, or carried after its dead time). */
  rise: LevelRise;
  /** This cycle's time to the invitation's money at the income, ms: 0 held; Infinity never. Absent, 0. */
  moneyMs?: number;
  /** κ's measured relative error (#406), staying's error's. Absent, 0. */
  kappaError?: number;
  waits: readonly LevelWait[];
  later: LaterCycles;
  /** The relative error of a τ with none of its own (#406). */
  tauError?: number;
  /** The last reading's wait (#406's hysteresis), by faction and k; null none. */
  held?: { faction: string; k: number } | null;
  /**
   * Each install's commit, ms (#413's review: the purchases, the gate and the restart, before the level starts again),
   * added for every install a candidate makes, its own and each later cycle's; staying makes none. Absent, 0.
   */
  commitMs?: number;
  /**
   * #343's guards: with no income measured (a restart or a gap: every money-bound τ is never, so no wait priced), or an
   * invitation's money held (#228), installing now is held: the best wait, else none. Absent: measured, none held.
   */
  incomeMeasured?: boolean;
  invitationHeld?: boolean;
  counts?: LaterPricingCounts;
}): LevelTiming | null {
  if (!pricedBy(later)) return null;
  // The dead time as a ramp in the rate (#413's review): the level rises during it, as the evidence's +5 min show.
  const pricing = new LaterPricing(later, counts, true);
  const left = later.left.filter((each) => addsToLevelling([each.augmentation]));
  /** After installing `installing` and `waitedFor`: the least over j of B(j) and the level's time after j. */
  const priceAfter = (waitedFor: readonly string[]) => {
    const remaining = left.filter((each) => !waitedFor.includes(each.augmentation));
    const installing = [...later.installing, ...waitedFor];
    const { best, installs } = leastSplits(pricing, remaining, installing, commitMs);
    let at = 0;
    let totalMs = Number.POSITIVE_INFINITY;
    let levelMs = Number.POSITIVE_INFINITY;
    for (let j = 0; j <= remaining.length; j++) {
      const after =
        j < remaining.length
          ? (installs[j] as Installs)
          : pricing.after([...installing, ...remaining.map((each) => each.augmentation)]);
      const ms = pricing.levelMs(after, required);
      const total = (best[j] as { totalMs: number }).totalMs + ms + commitMs;
      if (total < totalMs) {
        totalMs = total;
        at = j;
        levelMs = ms;
      }
    }
    return { totalMs, cyclesMs: splitCycles(best, at), levelMs };
  };
  const stayLevelMs = new PathTable(rise).secondsToLevel(required).seconds * 1000;
  const stayMs = Math.max(stayLevelMs, moneyMs);
  const stayErrorMs = Number.isFinite(stayMs) ? kappaError * stayMs : 0;
  const candidates: LevelTimingCandidate[] = [];
  if (addsToLevelling(later.installing)) {
    const now = priceAfter([]);
    candidates.push({ k: 0, waitedFor: [], tauMs: 0, estimateMs: now.totalMs, ...pick(now) });
  }
  for (const { faction, next } of waits) {
    for (const [index, each] of next.entries()) {
      if (!Number.isFinite(each.tauMs)) break;
      const waitedFor = next.slice(0, index + 1).map((one) => one.augmentation);
      const after = priceAfter(waitedFor);
      const estimateMs = each.tauMs + after.totalMs;
      const stays = stayMs <= estimateMs;
      const errorMs = stays ? stayErrorMs : (each.tauError ?? tauError) * each.tauMs;
      candidates.push({
        k: index + 1,
        faction,
        waitedFor,
        tauMs: each.tauMs,
        estimateMs: stays ? stayMs : estimateMs,
        ...pick(after),
        ...(stays ? { stays: true as const } : {}),
        ...(errorMs > 0 ? { errorMs } : {}),
      });
    }
  }
  const least = (allowed: (candidate: LevelTimingCandidate) => boolean) => {
    let best: LevelTimingCandidate | null = null;
    for (const candidate of candidates) {
      if (allowed(candidate) && (best === null || candidate.estimateMs < best.estimateMs)) best = candidate;
    }
    return best;
  };
  const best = least(() => true);
  const bestWait = least((candidate) => candidate.k > 0);
  const errorOf = (candidate: LevelTimingCandidate | null) =>
    candidate === null ? stayErrorMs : (candidate.errorMs ?? 0);
  let chosen = best;
  let kept: LevelTiming["kept"] = null;
  let marginMs: number | null = null;
  if (best?.k === 0) {
    // #406: installing now only by more than the best wait's error; with none, staying's (its own time, κ's error).
    const rival = bestWait === null ? (Number.isFinite(stayMs) ? stayMs : null) : bestWait.estimateMs;
    const margin = errorOf(bestWait);
    if (rival !== null && !(best.estimateMs < rival - margin)) {
      chosen = bestWait;
      kept = "margin";
      marginMs = margin;
    }
  } else if (best !== null && !(best.estimateMs < stayMs)) {
    // No install and no wait beats staying (a tie stays): no install, nothing waited for.
    chosen = null;
  }
  const installing = chosen?.k === 0;
  const heldForIncome = installing && !incomeMeasured;
  const heldForInvitation = installing && invitationHeld;
  if (heldForIncome || heldForInvitation) chosen = bestWait;
  const last =
    held === null ? undefined : candidates.find((each) => each.k === held.k && each.faction === held.faction);
  if (last !== undefined && chosen !== null && chosen !== last) {
    const margin = Math.max(errorOf(chosen), errorOf(last));
    if (!(chosen.estimateMs < last.estimateMs - margin)) {
      chosen = last;
      kept = "held";
      marginMs = margin;
    }
  }
  // A wait that stays (its τ past this cycle's own time) waits for nothing: staying, no install, no money held for it
  // (#413's review).
  if (chosen?.stays === true) chosen = null;
  const choice = chosen === null ? null : candidates.indexOf(chosen);
  const working = chosen !== null && chosen.k > 0 ? chosen : bestWait;
  const first = working?.waitedFor[0];
  return {
    required,
    stayMs,
    candidates,
    choice,
    estimateMs: chosen === null ? stayMs : chosen.estimateMs,
    work:
      working?.faction === undefined || first === undefined ? null : { faction: working.faction, augmentation: first },
    tauError,
    kept,
    ...(marginMs === null ? {} : { marginMs }),
    heldForIncome,
    heldForInvitation,
    later: {
      rebuildMs: later.rebuildMs,
      deadSeconds: later.deadSeconds,
      kappa: later.rise.kappa,
      left: left.length,
    },
  };
}

/** A priced candidate's later cycles and its last cycle's time to the level. */
const pick = ({ cyclesMs, levelMs }: { cyclesMs: number[]; levelMs: number }) => ({ cyclesMs, levelMs });
