/**
 * Bladeburner (#359), #386: the current-rank targets, and the expected time to reach one. Paths are
 * `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **The targets** are what the game checks against the rank as it is, not the most rank ever held: the Bladeburners
 *   faction at rank 25 (`joinFaction`, `Bladeburner.ts:268`, `data/Constants.ts:42`), and each Black Op at its own
 *   (`Actions/BlackOperation.ts:44-49`: 2,500 for the first, `data/BlackOperations.ts:11`), B5's to read. The rank
 *   floors at 0 (`changeRank`, `Bladeburner.ts:1273`), so a failure below its loss loses only what's there.
 * - **The goal under a target** is the expected time to reach it (`bladeburnerSecondsToRank`), not rank a second:
 *   B2's rule weighs only the mean, and a rare, rich action (Raid at a 5.5% low end, 55 a success and 2.5 a failure)
 *   has the most rank a second with a spread that can leave the rank at the floor for an hour (#385's review). Past
 *   the target the rule goes back to rank a second, until the next.
 */

/** The Bladeburners faction's rank (`Bladeburner/data/Constants.ts:42`, `RankNeededForFaction`). */
const FACTION_RANK = 25;

/**
 * The next current-rank target over `rank`, or null when none: the faction's 25 while it's not joined, then the next
 * Black Op's rank (`blackOpRank`, B5's hook: null until B5 reads it). A target met (the rank at it or over) is no
 * target: the rule goes back to rank a second.
 */
export function bladeburnerRankTarget({
  rank,
  factionJoined,
  blackOpRank = null,
}: {
  rank: number;
  factionJoined: boolean;
  blackOpRank?: number | null;
}): number | null {
  if (!factionJoined) return rank < FACTION_RANK ? FACTION_RANK : null;
  return blackOpRank !== null && rank < blackOpRank ? blackOpRank : null;
}

/**
 * The grid's least points over [0, target) for `bladeburnerSecondsToRank`: 200. Each landing is split between the
 * two points around it in the shares that keep its mean, so the drift is exact; what's left is the grid's smoothing,
 * under 0.8% of the time in the core test's walks to 25 (400 points halve it, for about 8 times the work: the rule
 * solves a walk for each plan at each reading).
 */
export const BLADEBURNER_TARGET_CELLS = 200;

/**
 * The grid's points a walk's largest step spans at least (#390's review): 8, as 200 points do over 25 for a step of
 * about 1 (Bounty Hunter's 0.9 and a rest's share). So a far target (B5's Black Ops, 2,500 and over) keeps the spacing
 * within the step: at 2,500 and Field Analysis's 0.1, 200,000 points (`bladeburnerTargetCells`).
 */
export const BLADEBURNER_TARGET_CELLS_A_STEP = 8;

/**
 * The grid's points for walks of `steps` to `target` (each walk of a sequence its own): `BLADEBURNER_TARGET_CELLS`,
 * or more, so each walk's largest step (a gain and its rest, or a loss, at the ±10%'s upper node) spans
 * `BLADEBURNER_TARGET_CELLS_A_STEP` of them.
 */
export function bladeburnerTargetCells(steps: readonly BladeburnerRankStep[], target: number): number {
  const top = BLADEBURNER_OFFSET_POINTS[BLADEBURNER_OFFSET_POINTS.length - 1] as number;
  const largest = steps
    .map((step) => Math.max(step.gain * top + step.rest, step.loss * top, step.rest))
    .filter((each) => each > 0);
  if (largest.length === 0) return BLADEBURNER_TARGET_CELLS;
  const span = Math.min(...largest);
  return Math.max(BLADEBURNER_TARGET_CELLS, Math.ceil((BLADEBURNER_TARGET_CELLS_A_STEP * target) / span));
}

/**
 * The ±10% on each rank change (`Bladeburner.ts:951`, `:980`), uniform on [0.9, 1.1]: its two-point Gauss–Legendre
 * nodes 1 ± 0.1/√3, which keep its mean and variance.
 */
const BLADEBURNER_OFFSET_POINTS = [1 - 0.1 / Math.sqrt(3), 1 + 0.1 / Math.sqrt(3)];

/** One step of the walk to a target: an attempt and its share of the cycle's rest. */
export interface BladeburnerRankStep {
  /** A success's chance (the estimate's low end), its rank, and a failure's loss (their means). */
  chance: number;
  gain: number;
  loss: number;
  /** The rank the step's share of the rest adds after the attempt, at least 0 (Field Analysis's). */
  rest: number;
  /** The step's game seconds: the attempt's and its share of the rest's. */
  seconds: number;
  /**
   * The most attempts its count allows (`bladeburnerAttemptsInCount`), and the step after them (`next`: the
   * next-best plan with another action, or resting alone). None: unbounded.
   */
  attempts?: number;
  next?: BladeburnerRankStep;
}

/**
 * The most attempts an action's count allows over the walk (#386's amendment): each attempt uses one, and the count
 * grows its mean growth (core's `countGrowthPerSecond`) a second (`Bladeburner.ts:1388-1393`), `stepSeconds` an
 * attempt; under 1 it can't start (`Actions/LevelableAction.ts:44-47`). The k-th attempt needs count − (k − 1)·(1 −
 * growth·stepSeconds) ≥ 1: at most 1 + (count − 1)/(1 − growth·stepSeconds), and unbounded where the growth keeps up.
 */
export function bladeburnerAttemptsInCount(count: number, growthPerSecond: number, stepSeconds: number): number {
  const net = 1 - growthPerSecond * stepSeconds;
  if (!(net > 0)) return Number.POSITIVE_INFINITY;
  return count < 1 ? 0 : Math.floor(1 + (count - 1) / net);
}

/** Resting alone at `rankPerSecond` (Field Analysis's) as a walk's step: 30 s of it, no attempt. */
export function bladeburnerRestStep(rankPerSecond: number): BladeburnerRankStep {
  return { chance: 0, gain: 0, loss: 0, rest: rankPerSecond * 30, seconds: 30 };
}

/**
 * A cycle of work and rest as the walk's step (#386): one attempt of `seconds`, worked `duty` of the time, with the
 * rest's `restRankPerSecond` over the rest of it (s·(1 − duty)/duty a step). Spread a step at a time, though the game
 * rests in blocks: the rest's rank is steady, so only when it comes moves, not how much.
 */
export function bladeburnerCycleStep({
  chance,
  gain,
  loss,
  seconds,
  duty,
  restRankPerSecond,
}: {
  chance: number;
  gain: number;
  loss: number;
  seconds: number;
  duty: number;
  restRankPerSecond: number;
}): BladeburnerRankStep {
  const restSeconds = duty > 0 && duty < 1 ? (seconds * (1 - duty)) / duty : 0;
  return { chance, gain, loss, rest: restSeconds * restRankPerSecond, seconds: seconds + restSeconds };
}

/**
 * Wald's lower bound on the seconds from `rank` to `target` (#386): a step's rank, floored or not, is at most
 * chance × gain + rest on average (a failure floored loses less, never gains), and the walk must rise target − rank,
 * so the expected steps are at least that over it (Wald's identity, the optional stopping theorem: Durrett,
 * "Probability: Theory and Examples", 5th ed., 2019, Theorem 4.8.6). The rule ranks its candidates by it and solves
 * only those it can't rule out.
 */
export function bladeburnerSecondsToRankAtLeast(step: BladeburnerRankStep, rank: number, target: number): number {
  if (rank >= target) return 0;
  const most = step.chance * step.gain + step.rest;
  return most > 0 ? (step.seconds * (target - rank)) / most : Number.POSITIVE_INFINITY;
}

/**
 * The expected game seconds from `rank` to `target` or over, a step at a time (#386): from rank x a success goes to
 * x + gain + rest, a failure to max(0, x − loss) + rest (the floor, `Bladeburner.ts:1273`). The walk is an absorbing
 * Markov chain over the rank under the target, and its expected cost to absorption t solves (I − Q)·t = c, Q the
 * moves among the ranks under the target and c a step's seconds (Grinstead and Snell, "Introduction to Probability",
 * 2nd ed., 1997, §11.2, Theorem 11.5, there with c = 1: the expected steps). Here the ranks are
 * `bladeburnerTargetCells` grid points over [0, target) (200, or 8 a largest step: #390's review), each landing split
 * between the two points around it in the shares that keep its mean (at or over the target absorbed, the target
 * itself a point), each gain and loss its ±10% (`BLADEBURNER_OFFSET_POINTS`); from `rank` itself, its own step, then
 * the grid's.
 * I − Q is banded (a step moves at most loss down and gain + rest up) and an M-matrix, so Gaussian elimination needs
 * no pivoting (Golub and Van Loan, "Matrix Computations", 4th ed., 2013, §4.3.5). Infinity when the walk can't rise
 * (no success and no rest's rank). A diffusion's formula (drift and variance, a reflecting floor) won't do: Raid's
 * steps are as large as the distance, and it puts Raid's 18 attempts from 0 to 25 at under 4. The core test checks the
 * chain against a simulated walk.
 * **The counts** (#386's amendment), as a sequence: a step with `attempts` runs at most that many, then its `next`
 * (the next-best) from wherever the walk is: the first's distribution over the rank after its last attempt (the chain
 * run forward on the same grid) weighted by the second's expected time from each point. The order the rule would run
 * them in (the first is the best now), where a mixture spreads a lottery's tickets over ranks where its failures cost:
 * each step the first with chance w, else the second, w = attempts/n (n the first's own expected steps from `rank`),
 * set once more at attempts over the mixed walk's expected steps; 3,523 s against the simulated sequence's 3,068
 * (+15%) for Raid's 12 then a steady action from rank 3 in the core test. The second's own count isn't bounded. With
 * no `next`, a count short of the walk is never. The next-best is the one fastest from the rank now (#390's review),
 * not from where the count runs out: labelled.
 * Left out, and labelled: the skill points the max rank earns (B3's), either way, as both routes earn them about in
 * proportion to the rank they make; the stamina's own path (a cycle's rest spread over its attempts,
 * `bladeburnerCycleStep`), and the chances moving with the levels opened, the skills bought and the city's chaos
 * (the rule re-plans at each reading: this weighs the walk as if the step stayed as it is now).
 */
export function bladeburnerSecondsToRank(step: BladeburnerRankStep, rank: number, target: number): number {
  if (rank >= target) return 0;
  const attempts = step.attempts ?? Number.POSITIVE_INFINITY;
  // Each walk on its own grid, its points by its own largest step (the next-best's taken onto the first's).
  const cells = bladeburnerTargetCells([step], target);
  const chain = chainOf(step, target, !(attempts < Number.POSITIVE_INFINITY), cells);
  const start = chain.landings(Math.max(0, rank));
  if (!(attempts < Number.POSITIVE_INFINITY))
    return chain.seconds === null ? Number.POSITIVE_INFINITY : chain.from(start);
  if (attempts < 1) {
    return step.next === undefined ? Number.POSITIVE_INFINITY : bladeburnerSecondsToRank(step.next, rank, target);
  }
  // Its attempts, the walk run forward a step at a time over the grid (what isn't absorbed), two buffers in turn.
  const { offsets, columns, shares } = chain;
  let distribution = new Float64Array(cells);
  let next = new Float64Array(cells);
  for (const [k, probability] of start) distribution[k] = (distribution[k] as number) + probability;
  let seconds = step.seconds;
  const aliveOf = (each: Float64Array) => each.reduce((total, mass) => total + mass, 0);
  for (let n = 1; n < attempts; n++) {
    const alive = aliveOf(distribution);
    if (!(alive > 1e-12)) return seconds;
    seconds += alive * step.seconds;
    next.fill(0);
    for (let i = 0; i < cells; i++) {
      const mass = distribution[i] as number;
      if (mass === 0) continue;
      for (let at = offsets[i] as number; at < (offsets[i + 1] as number); at++) {
        const k = columns[at] as number;
        next[k] = (next[k] as number) + mass * (shares[at] as number);
      }
    }
    [distribution, next] = [next, distribution];
  }
  if (!(aliveOf(distribution) > 1e-12)) return seconds;
  // Then the next-best's from wherever the walk is.
  const nextCells = step.next === undefined ? cells : bladeburnerTargetCells([step.next], target);
  const nextSeconds = step.next === undefined ? null : solvedNext(step.next, target, nextCells);
  if (nextSeconds === null) return Number.POSITIVE_INFINITY;
  // The next-best's seconds at each of the first's points, between its own two around it (its last's to the target's
  // 0 past it).
  const nextAt = (x: number) => {
    const cell = (x / target) * nextCells;
    const k = Math.min(nextCells - 1, Math.floor(cell));
    const share = cell - k;
    const upper = k + 1 < nextCells ? (nextSeconds[k + 1] as number) : 0;
    return (1 - share) * (nextSeconds[k] as number) + share * upper;
  };
  let after = 0;
  distribution.forEach((mass, i) => {
    if (mass !== 0) after += mass * nextAt((i / cells) * target);
  });
  return seconds + after;
}

/** The next-best's seconds from each grid point, solved once a step and target (the rule weighs many before it). */
const solvedNexts = new WeakMap<BladeburnerRankStep, { target: number; cells: number; seconds: Float64Array | null }>();
function solvedNext(step: BladeburnerRankStep, target: number, cells: number): Float64Array | null {
  const known = solvedNexts.get(step);
  if (known !== undefined && known.target === target && known.cells === cells) return known.seconds;
  const { seconds } = chainOf(step, target, true, cells);
  solvedNexts.set(step, { target, cells, seconds });
  return seconds;
}

/**
 * The chain of `step` under `target` (`bladeburnerSecondsToRank`): where a step from x lands (`landings`), each grid
 * point's landings flat (`offsets`, `columns`, `shares`), and, `solve`d, the expected seconds to the target from each
 * point (null: not solved, or the walk can't rise) and from a first step's landings (`from`).
 */
function chainOf(
  step: BladeburnerRankStep,
  target: number,
  /** Whether to solve for the seconds: a walk run forward only needs its rows. */
  solve: boolean,
  /** The grid's points (`bladeburnerTargetCells`). */
  cells: number,
): {
  cells: number;
  landings: (x: number) => [number, number][];
  offsets: Int32Array;
  columns: Int32Array;
  shares: Float64Array;
  seconds: Float64Array | null;
  from: (start: readonly [number, number][]) => number;
} {
  const h = target / cells;
  const success = Math.min(1, step.chance);
  const each = 1 / BLADEBURNER_OFFSET_POINTS.length;
  // Where a step from x lands, as [cell, probability] pairs: at or over the target, absorbed; else split between the
  // points around it, the target's own point (absorbed) among them past the last.
  const landings = (x: number): [number, number][] => {
    const out: [number, number][] = [];
    const put = (y: number, probability: number) => {
      if (!(probability > 0) || y >= target) return;
      const cell = y / h;
      const k = Math.min(cells - 1, Math.floor(cell));
      const share = cell - k;
      // Past the last point, the target's share absorbed.
      if (!(share > 0)) out.push([k, probability]);
      else if (k + 1 >= cells) out.push([k, probability * (1 - share)]);
      else out.push([k, probability * (1 - share)], [k + 1, probability * share]);
    };
    for (const offset of BLADEBURNER_OFFSET_POINTS) {
      put(x + step.gain * offset + step.rest, success * each);
      put(Math.max(0, x - step.loss * offset) + step.rest, (1 - success) * each);
    }
    return out;
  };
  const rows = Array.from({ length: cells }, (_, i) => landings(i * h));
  const offsets = new Int32Array(cells + 1);
  rows.forEach((row, i) => {
    offsets[i + 1] = (offsets[i] as number) + row.length;
  });
  const columns = new Int32Array(offsets[cells] as number);
  const shares = new Float64Array(columns.length);
  let down = 0;
  let up = 0;
  rows.forEach((row, i) => {
    row.forEach(([k, probability], index) => {
      columns[(offsets[i] as number) + index] = k;
      shares[(offsets[i] as number) + index] = probability;
      down = Math.max(down, i - k);
      up = Math.max(up, k - i);
    });
  });
  const unsolved = { cells, landings, offsets, columns, shares, seconds: null, from: () => Number.POSITIVE_INFINITY };
  const rises = (step.chance > 0 && step.gain + step.rest > 0) || step.rest > step.loss;
  if (!solve || !rises) return unsolved;
  const width = down + up + 1;
  // Row i's column j at i·width + (j − i + down): I − Q in a band, and the right-hand side a step's seconds.
  const band = new Float64Array(cells * width);
  const seconds = new Float64Array(cells).fill(step.seconds);
  const at = (i: number, j: number) => i * width + (j - i + down);
  for (let i = 0; i < cells; i++) {
    band[at(i, i)] = 1;
    for (let index = offsets[i] as number; index < (offsets[i + 1] as number); index++) {
      const k = columns[index] as number;
      band[at(i, k)] = (band[at(i, k)] as number) - (shares[index] as number);
    }
  }
  // Banded Gaussian elimination, then back substitution.
  for (let k = 0; k < cells; k++) {
    const pivot = band[at(k, k)] as number;
    if (!(pivot > 0)) return unsolved;
    const lastRow = Math.min(cells - 1, k + down);
    const lastColumn = Math.min(cells - 1, k + up);
    for (let i = k + 1; i <= lastRow; i++) {
      const factor = (band[at(i, k)] as number) / pivot;
      if (factor === 0) continue;
      // Row k's columns k… and row i's, each a run in the band.
      const fromK = at(k, k);
      const fromI = at(i, k);
      for (let j = 0; j <= lastColumn - k; j++) {
        band[fromI + j] = (band[fromI + j] as number) - factor * (band[fromK + j] as number);
      }
      seconds[i] = (seconds[i] as number) - factor * (seconds[k] as number);
    }
  }
  for (let i = cells - 1; i >= 0; i--) {
    let sum = seconds[i] as number;
    const lastColumn = Math.min(cells - 1, i + up);
    for (let j = i + 1; j <= lastColumn; j++) sum -= (band[at(i, j)] as number) * (seconds[j] as number);
    seconds[i] = sum / (band[at(i, i)] as number);
  }
  // From `rank` itself: its own step, then the grid's.
  const from = (start: readonly [number, number][]) =>
    start.reduce((total, [k, probability]) => total + probability * (seconds[k] as number), step.seconds);
  return { cells, landings, offsets, columns, shares, seconds, from };
}
