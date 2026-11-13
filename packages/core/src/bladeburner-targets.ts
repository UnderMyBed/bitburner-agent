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
 * The grid's points over [0, target) for `bladeburnerSecondsToRank`: 400. Each landing is split between the two
 * points around it in the shares that keep its mean, so the drift is exact; what's left is the grid's smoothing, under
 * 0.3% of the time in the core test's walks (against 0.6% at 200 points, 0% at 1,000 for 3 to 10 times the work).
 */
export const BLADEBURNER_TARGET_CELLS = 400;

/** The ±10% on each rank change (`Bladeburner.ts:951`, `:980`): the midpoints of 4 equal slices of [0.9, 1.1]. */
const BLADEBURNER_OFFSET_POINTS = [0.925, 0.975, 1.025, 1.075];

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
 * Markov chain over the rank under the target, and its expected steps to absorption t solve (I − Q)·t = 1, Q the
 * moves among the ranks under the target (Grinstead and Snell, "Introduction to Probability", 2nd ed., 1997, §11.2,
 * Theorem 11.5). Here the ranks are `BLADEBURNER_TARGET_CELLS` grid points over [0, target), each landing split
 * between the two points around it in the shares that keep its mean (at or over the target absorbed; between the last
 * point and the target, kept on the last), each gain and loss its ±10% (`BLADEBURNER_OFFSET_POINTS`); from `rank`
 * itself, its own step, then the grid's. I − Q is banded (a step moves at most loss down and gain + rest up) and an
 * M-matrix, so Gaussian elimination needs no pivoting (Golub and Van Loan, "Matrix Computations", 4th ed., 2013,
 * §4.3.5). Infinity when the walk can't rise (no success and no rest's rank). A diffusion's formula (drift and
 * variance, a reflecting floor) won't do: Raid's steps are as large as the distance, and it puts Raid's 18 attempts
 * from 0 to 25 at under 4. The core test checks the chain against a simulated walk.
 * Left out, and labelled: the counts running out, the stamina's own path (a cycle's rest spread over its attempts,
 * `bladeburnerCycleStep`), and the chances moving with the levels opened, the skills bought and the city's chaos
 * (the rule re-plans at each reading: this weighs the walk as if the step stayed as it is now).
 */
export function bladeburnerSecondsToRank(step: BladeburnerRankStep, rank: number, target: number): number {
  if (rank >= target) return 0;
  const { chance, gain, loss, rest, seconds } = step;
  if (!(chance > 0 && gain + rest > 0) && !(rest > loss)) return Number.POSITIVE_INFINITY;
  const cells = BLADEBURNER_TARGET_CELLS;
  const h = target / cells;
  const success = Math.min(1, chance);
  // Where a step from x lands, as [cell, probability] pairs: at or over the target, absorbed; else split between the
  // points around it, the last cell's landings (between it and the target) kept on it.
  const landings = (x: number): [number, number][] => {
    const out: [number, number][] = [];
    const put = (y: number, probability: number) => {
      if (!(probability > 0) || y >= target) return;
      const cell = y / h;
      const k = Math.min(cells - 1, Math.floor(cell));
      const share = cell - k;
      if (k + 1 >= cells || !(share > 0)) {
        out.push([k, probability]);
        return;
      }
      out.push([k, probability * (1 - share)], [k + 1, probability * share]);
    };
    for (const offset of BLADEBURNER_OFFSET_POINTS) {
      const weight = 1 / BLADEBURNER_OFFSET_POINTS.length;
      put(x + gain * offset + rest, success * weight);
      put(Math.max(0, x - loss * offset) + rest, (1 - success) * weight);
    }
    return out;
  };
  const rows: [number, number][][] = [];
  let down = 0;
  let up = 0;
  for (let i = 0; i < cells; i++) {
    const row = landings(i * h);
    for (const [j] of row) {
      down = Math.max(down, i - j);
      up = Math.max(up, j - i);
    }
    rows.push(row);
  }
  const width = down + up + 1;
  // Row i's column j at i·width + (j − i + down): I − Q in a band, and the right-hand side 1s.
  const band = new Float64Array(cells * width);
  const rhs = new Float64Array(cells).fill(1);
  const at = (i: number, j: number) => i * width + (j - i + down);
  const get = (i: number, j: number) => band[at(i, j)] as number;
  const add = (i: number, j: number, value: number) => {
    band[at(i, j)] = get(i, j) + value;
  };
  rows.forEach((row, i) => {
    add(i, i, 1);
    for (const [j, probability] of row) add(i, j, -probability);
  });
  // Banded Gaussian elimination, then back substitution.
  for (let k = 0; k < cells; k++) {
    const pivot = get(k, k);
    if (!(pivot > 0)) return Number.POSITIVE_INFINITY;
    const lastRow = Math.min(cells - 1, k + down);
    const lastColumn = Math.min(cells - 1, k + up);
    for (let i = k + 1; i <= lastRow; i++) {
      const factor = get(i, k) / pivot;
      if (factor === 0) continue;
      for (let j = k; j <= lastColumn; j++) add(i, j, -factor * get(k, j));
      rhs[i] = (rhs[i] as number) - factor * (rhs[k] as number);
    }
  }
  const steps = new Float64Array(cells);
  for (let i = cells - 1; i >= 0; i--) {
    let sum = rhs[i] as number;
    const lastColumn = Math.min(cells - 1, i + up);
    for (let j = i + 1; j <= lastColumn; j++) sum -= get(i, j) * (steps[j] as number);
    steps[i] = sum / get(i, i);
  }
  // From `rank` itself: its own step, then the grid's.
  let expected = 1;
  for (const [k, probability] of landings(Math.max(0, rank))) expected += probability * (steps[k] as number);
  return expected * seconds;
}
