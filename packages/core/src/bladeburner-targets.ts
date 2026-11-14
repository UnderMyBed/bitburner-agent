/**
 * Bladeburner (#359), #386: the current-rank targets, and the expected time to reach one. Paths are
 * `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **The targets** are what the game checks against the rank as it is, not the most rank ever held: the Bladeburners
 *   faction at rank 25 (`joinFaction`, `Bladeburner.ts:268`, `data/Constants.ts:42`), and each Black Op at its own
 *   (`Actions/BlackOperation.ts:44-49`: 2,500 for the first, `data/BlackOperations.ts:11`), B5's (#392). The rank
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
 * Black Op's rank (`blackOpRank`, B5's, #392: null with none read). A target met (the rank at it or over) is no
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
 * The grid's least points for `bladeburnerSecondsToRank`: 200. Each landing is split between the two points around it
 * in the shares that keep its mean, so the drift is exact; what's left is the grid's smoothing, under 0.8% of the time
 * in the core test's walks to 25 (400 points halve it, for about 8 times the work: the rule solves a walk for each plan
 * at each reading).
 */
export const BLADEBURNER_TARGET_CELLS = 200;

/**
 * The grid's points a walk's largest step spans at least (#390's review): 8, as 200 points do over 25 for a step of
 * about 1 (Bounty Hunter's 0.9 and a rest's share). Near the target (#392) the spacing is finer still, down to the
 * distance's hundredth (`BLADEBURNER_TARGET_CELLS_A_DISTANCE`), though no finer than an eighth of the ±10%'s two nodes'
 * spread (`bladeburnerTargetGrid`).
 */
export const BLADEBURNER_TARGET_CELLS_A_STEP = 8;

/**
 * The points the distance to the target spans at least, where a step's own spread allows (#392): 100. At a far target a
 * walk that starts near it (B5's rebuild of a Black Op's loss, 10 rank under 2,500) is decided by where each landing
 * falls against the target, which 8 points a step left 4% off the simulated walk (Raid-like from 2,440).
 */
export const BLADEBURNER_TARGET_CELLS_A_DISTANCE = 200;

/**
 * The grid's most points (#392): 4,000. A far target's small steps (Tracking's 0.3 at 2,500) asked for 63,000 at 8 a
 * step, and the rule solves a walk for each plan at each reading, in each city (B4). Far from the target the spacing
 * doesn't decide the time, the drift does: the core test's walks to 2,500 from 0 at 4,000 points are within 1% of the
 * simulated ones, as at 63,000.
 */
export const BLADEBURNER_TARGET_CELLS_MOST = 4000;

/**
 * How far under the start the grid reaches, at least (#392): 4 times the distance to the target and 8 of the largest
 * step (`bladeburnerTargetGrid`).
 */
export const BLADEBURNER_TARGET_WINDOW_DISTANCES = 4;
export const BLADEBURNER_TARGET_WINDOW_STEPS = 8;

/** The ±10%'s two nodes' spread over a step: 2 × 0.1/√3 (`BLADEBURNER_OFFSET_POINTS`). */
const NODES_SPREAD = 0.2 / Math.sqrt(3);

/**
 * A step's mean rise, unfloored: chance × gain − (1 − chance) × loss + rest (Wald's identity's drift: Durrett,
 * "Probability: Theory and Examples", 5th ed., 2019, Theorem 4.8.6).
 */
export function bladeburnerStepRise(step: BladeburnerRankStep): number {
  const chance = Math.min(1, step.chance);
  return chance * step.gain - (1 - chance) * step.loss + step.rest;
}

/**
 * The grid for walks of `steps` from `rank` to `target` (#392; each walk of a sequence its own points, over one
 * window):
 * - **The window** `[low, target)`: from 0, the floor (`Bladeburner.ts:1273`), unless the start is far over it: then
 *   from `BLADEBURNER_TARGET_WINDOW_DISTANCES` times the distance and `BLADEBURNER_TARGET_WINDOW_STEPS` of the largest
 *   step under the start, where every walk's mean rise is over 0 (one that isn't needs the floor to get anywhere). A
 *   landing under the window is taken back up to its floor at Wald's time, the distance over the step's mean rise
 *   (`bladeburnerStepRise`): exact far from the target but for the overshoot past the floor, which a window this wide
 *   reaches rarely. So a far target's walk from near it isn't spread over the rank from 0.
 * - **The points**: the window over a spacing of an eighth of the walk's largest step (a gain and its rest, or a loss,
 *   at the ±10%'s upper node, `BLADEBURNER_TARGET_CELLS_A_STEP`), or finer near the target: down to the distance's
 *   hundredth (`BLADEBURNER_TARGET_CELLS_A_DISTANCE`), no finer than an eighth of the ±10%'s nodes' spread of its gain
 *   or loss. At least `BLADEBURNER_TARGET_CELLS`, at most `BLADEBURNER_TARGET_CELLS_MOST`.
 */
export function bladeburnerTargetGrid(
  steps: readonly BladeburnerRankStep[],
  rank: number,
  target: number,
): { low: number; cells: number[] } {
  const top = BLADEBURNER_OFFSET_POINTS[BLADEBURNER_OFFSET_POINTS.length - 1] as number;
  const from = Math.max(0, rank);
  const distance = Math.max(0, target - from);
  const largestOf = (step: BladeburnerRankStep) => Math.max(step.gain * top + step.rest, step.loss * top, step.rest);
  const largest = Math.max(0, ...steps.map(largestOf));
  const reach = BLADEBURNER_TARGET_WINDOW_DISTANCES * distance + BLADEBURNER_TARGET_WINDOW_STEPS * largest;
  const low = steps.every((step) => bladeburnerStepRise(step) > 0) && from - reach > 0 ? from - reach : 0;
  const cells = steps.map((step) => {
    const span = largestOf(step);
    if (!(span > 0)) return BLADEBURNER_TARGET_CELLS;
    // The larger landing's spread (the gain's, or the loss's): a finer spacing for the smaller would widen the band.
    const spread = (Math.max(step.gain, step.loss) || span) * NODES_SPREAD;
    const spacing = Math.min(
      span / BLADEBURNER_TARGET_CELLS_A_STEP,
      Math.max(spread / BLADEBURNER_TARGET_CELLS_A_STEP, distance / BLADEBURNER_TARGET_CELLS_A_DISTANCE),
    );
    const wanted = Math.ceil((target - low) / spacing);
    return Math.min(BLADEBURNER_TARGET_CELLS_MOST, Math.max(BLADEBURNER_TARGET_CELLS, wanted));
  });
  return { low, cells };
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
  /**
   * After its attempts with no `next` (#392's decision): the rest of the walk at this rank a second, the sustainable
   * rate (`bladeburnerSustainableRate`), (target − x)/rate from where the stock left it (Wald's identity: Durrett,
   * Theorem 4.8.6, a far target's first passage the distance over the drift). Left out, and labelled (#395's review):
   * the tail's own spread (its variance moves no mean, as the tail is linear in the rank) and its overshoot past the
   * target (at most a step: the time's error at most a step's seconds), and its floor (none: the tail is far from 0).
   */
  tailRate?: number;
}

/** The analytic tail's seconds from `x` (#392): the rank still needed over the sustainable rate; Infinity at none. */
function tailSeconds(step: BladeburnerRankStep, x: number, target: number): number {
  const rate = step.tailRate;
  if (rate === undefined || !(rate > 0)) return x >= target ? 0 : Number.POSITIVE_INFINITY;
  return Math.max(0, target - x) / rate;
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

/**
 * An action's long-run supply (#392): its count's mean growth a second, and each way to work it (a level and a rest):
 * an attempt's mean rise with its share of the rest (`rise`) over its cycle seconds (`seconds`).
 */
export interface BladeburnerRankSource {
  growthPerSecond: number;
  /**
   * Each way: its rise and cycle seconds; where the rule made it (#408, the competence's growth), its level, its
   * attempt's chance and seconds too.
   */
  options: readonly { rise: number; seconds: number; level?: number; chance?: number; attemptSeconds?: number }[];
  /** The action's type and name, where the rule made it (#408). */
  type?: string;
  name?: string;
}

/**
 * The sustainable rank a second once the counts are spent (#392's decision): each action's count regrows its mean
 * growth a second (`Bladeburner.ts:1388-1393`, `growthFunction`'s range over 10 each 480 s, core's
 * `countGrowthPerSecond`), so in the long run it can be attempted that often, each attempt one of its ways (a level and
 * a rest: its cycle's seconds with its share of the stamina's rests, and its rise with the rest's rank). A second is the
 * budget, what's left of it resting alone (`restRankPerSecond`, Field Analysis's). The best mix is a linear programme:
 * the most Σ xₒ·riseₒ + r₀·(1 − Σ xₒ·secondsₒ) with each action's attempts a second Σ xₒ at most its growth and the
 * time Σ xₒ·secondsₒ at most 1. Its dual (#395's review: one way an action, a greedy fill by rank a second is optimal,
 * but levels trade rise against time) is the least over λ ≥ r₀ of λ + Σₐ growthₐ·max(0, maxₒ(riseₒ − λ·secondsₒ)):
 * λ the second's worth, each action worked its best way against it (Bertsimas and Tsitsiklis, "Introduction to Linear
 * Optimization", 1997, §4.2, strong duality). Convex and piecewise linear in λ, so its least is where its slope,
 * 1 − Σ growthₐ·secondsₒ of the ways worked, turns from negative: bisected. Left out, and labelled: the regrowth's
 * randomness (a tenth of a random integer a second, its mean taken) and the chances' change over the tail (the levels
 * opened, the skills bought). Each way balances its stamina within its own cycle (its duty against its rest), not
 * pooled across the ways worked, so a mix that could share the rests is held to each one's own: a conservative lower
 * bound on the rate.
 */
export function bladeburnerSustainableRate(
  sources: readonly BladeburnerRankSource[],
  restRankPerSecond: number,
): number {
  const { value, floor, low, high } = sustainableDual(sources, restRankPerSecond);
  if (low === null) return value(floor).total;
  return Math.min(value(low).total, value(high).total);
}

/** The dual's value and slope at λ (`bladeburnerSustainableRate`), each action's best way there (-1: none worth it). */
function sustainableValue(sources: readonly BladeburnerRankSource[], lambda: number) {
  let total = lambda;
  let slope = 1;
  const chosen: number[] = [];
  for (const { growthPerSecond, options } of sources) {
    let best = 0;
    let seconds = 0;
    let index = -1;
    options.forEach((option, at) => {
      const worth = option.rise - lambda * option.seconds;
      if (worth > best) {
        best = worth;
        seconds = option.seconds;
        index = at;
      }
    });
    total += growthPerSecond * best;
    slope -= growthPerSecond * seconds;
    chosen.push(index);
  }
  return { total, slope, chosen };
}

/** The dual's bisection (`bladeburnerSustainableRate`): its floor r₀, and λ's bracket (low null: the time never binds). */
function sustainableDual(sources: readonly BladeburnerRankSource[], restRankPerSecond: number) {
  const floor = Math.max(0, restRankPerSecond);
  const value = (lambda: number) => sustainableValue(sources, lambda);
  // Past the best way's rise a second, no action is worth working: the slope 1.
  let high = floor;
  for (const { options } of sources) {
    for (const option of options) if (option.seconds > 0) high = Math.max(high, option.rise / option.seconds);
  }
  if (!(value(floor).slope < 0)) return { value, floor, low: null, high };
  let low = floor;
  for (let step = 0; step < 100; step++) {
    const middle = (low + high) / 2;
    if (value(middle).slope < 0) low = middle;
    else high = middle;
  }
  return { value, floor, low, high };
}

/** One way an action is worked in the sustainable mix (#408): its source's and option's places, attempts a second. */
export interface BladeburnerMixPart {
  source: number;
  option: number;
  perSecond: number;
}

/**
 * The sustainable rate's mix (#408): the linear programme's primal, each action's attempts a second at each of its
 * ways, rebuilt from the dual's bracket by complementary slackness (Bertsimas and Tsitsiklis, §4.3). At the bracket's
 * ends λ_low and λ_high each action's best way is worked at its whole growth (none where none is worth it), their
 * times T_low > 1 ≥ T_high; the mix θ·low + (1 − θ)·high with θ = (1 − T_high)/(T_low − T_high) spends the second
 * exactly, and both ends are optimal at λ* (the bracket's 100 halvings), so it is. Where the time never binds, each
 * worked at its growth. `rate`: its Σ x·rise + r₀·(1 − Σ x·seconds), the dual's own within the bracket.
 */
export function bladeburnerSustainableMix(
  sources: readonly BladeburnerRankSource[],
  restRankPerSecond: number,
): { rate: number; parts: BladeburnerMixPart[] } {
  const { value, floor, low, high } = sustainableDual(sources, restRankPerSecond);
  const ends = low === null ? [{ weight: 1, chosen: value(floor).chosen }] : mixEnds(sources, value(low), value(high));
  const parts: BladeburnerMixPart[] = [];
  let rise = 0;
  let seconds = 0;
  for (const { weight, chosen } of ends) {
    chosen.forEach((option, source) => {
      const each = sources[source] as BladeburnerRankSource;
      const way = each.options[option];
      if (way === undefined || !(weight > 0)) return;
      const perSecond = weight * each.growthPerSecond;
      const known = parts.find((part) => part.source === source && part.option === option);
      if (known === undefined) parts.push({ source, option, perSecond });
      else known.perSecond += perSecond;
      rise += perSecond * way.rise;
      seconds += perSecond * way.seconds;
    });
  }
  return { rate: rise + floor * Math.max(0, 1 - seconds), parts };
}

/** The bracket's two ends weighted to spend the second exactly (`bladeburnerSustainableMix`). */
function mixEnds(
  sources: readonly BladeburnerRankSource[],
  low: { chosen: number[] },
  high: { chosen: number[] },
): { weight: number; chosen: number[] }[] {
  const timeOf = (chosen: number[]) =>
    chosen.reduce((sum, option, source) => {
      const each = sources[source] as BladeburnerRankSource;
      return sum + (option < 0 ? 0 : each.growthPerSecond * (each.options[option] as { seconds: number }).seconds);
    }, 0);
  const tLow = timeOf(low.chosen);
  const tHigh = timeOf(high.chosen);
  const theta = tLow > tHigh ? Math.min(1, Math.max(0, (1 - tHigh) / (tLow - tHigh))) : 0;
  return [
    { weight: theta, chosen: low.chosen },
    { weight: 1 - theta, chosen: high.chosen },
  ];
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
 * `bladeburnerTargetGrid`'s points over its window (from 0, or far under the start, a landing under it taken back up
 * at Wald's time: #392), each landing split between the two points around it in the shares that keep its mean (at or
 * over the target absorbed, the target itself a point), each gain and loss its ±10% (`BLADEBURNER_OFFSET_POINTS`);
 * from `rank` itself, its own step, then the grid's.
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
 * (+15%) for Raid's 12 then a steady action from rank 3 in the core test. **The second's own count** (#392) is
 * bounded too, by backward induction (`boundedNext`): left unbounded, at a far target a plan with a count of 4 handed
 * the whole walk to a next-best it could only run for its own count, and the rule chose it for that (bn6-skills' hour
 * at Typhoon's 2,500). **The tail** (#392's decision): once the stock (the counts now, in the plan's order) is spent,
 * the rest of the walk is analytic, the rank still needed over the sustainable rate (`tailRate`,
 * `bladeburnerSustainableRate`: the counts' regrowth), common to every plan; so far from the target the plans differ
 * by their stock alone, and near it (the stock covering the target) the chain alone decides. With neither a `next` nor
 * a `tailRate`, a count short of the walk is never. The next-best is the one fastest from the rank now (#390's review),
 * not from where the count runs out: labelled.
 * Left out, and labelled: the skill points the max rank earns (B3's), either way, as both routes earn them about in
 * proportion to the rank they make; the stamina's own path (a cycle's rest spread over its attempts,
 * `bladeburnerCycleStep`), and the chances moving with the levels opened, the skills bought and the city's chaos
 * (the rule re-plans at each reading: this weighs the walk as if the step stayed as it is now).
 */
export function bladeburnerSecondsToRank(
  step: BladeburnerRankStep,
  rank: number,
  target: number,
  /** The stock in closed form where it applies (`bladeburnerStockInClosedForm`); off, the chain always (the tests'). */
  { closedForm = true }: { closedForm?: boolean } = {},
): number {
  if (rank >= target) return 0;
  const attempts = step.attempts ?? Number.POSITIVE_INFINITY;
  if (attempts < 1) {
    return step.next === undefined
      ? tailSeconds(step, rank, target)
      : bladeburnerSecondsToRank(step.next, rank, target);
  }
  // Far from both the target and the floor (#395's review: the chain's cost), the stock in closed form.
  const closed = closedForm ? bladeburnerStockInClosedForm(step, rank, target) : null;
  if (closed !== null) return closed;
  // Each walk on its own grid, by its own steps, over the one window (the next-best's taken onto the first's).
  const bounded = attempts < Number.POSITIVE_INFINITY;
  // The next-best, and (#392) what follows its own count: the window under them all.
  const sequence = [step];
  if (bounded && step.next !== undefined) {
    sequence.push(step.next);
    if (step.next.next !== undefined && (step.next.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY) {
      sequence.push(step.next.next);
    }
  }
  const grid = bladeburnerTargetGrid(sequence, rank, target);
  const cells = grid.cells[0] as number;
  const chain = chainOf(step, target, !bounded, cells, grid.low);
  const from = Math.max(0, rank);
  const start = chain.landings(from);
  const startExtra = chain.extraOf(from);
  if (!bounded) return chain.seconds === null ? Number.POSITIVE_INFINITY : chain.from(start) + startExtra;
  // Its attempts, the walk run forward a step at a time over the grid (what isn't absorbed), two buffers in turn.
  const { offsets, columns, shares, extras } = chain;
  let distribution = new Float64Array(cells);
  let next = new Float64Array(cells);
  // Only the points the walk can be at are visited (#392: a far target's grid is thousands of points, and a count's
  // attempts ran over every one): `low` to `high`, the rest 0.
  let low = cells;
  let high = -1;
  for (const [k, probability] of start) {
    distribution[k] = (distribution[k] as number) + probability;
    low = Math.min(low, k);
    high = Math.max(high, k);
  }
  let seconds = step.seconds + startExtra;
  const aliveOf = (each: Float64Array) => {
    let total = 0;
    for (let i = low; i <= high; i++) total += each[i] as number;
    return total;
  };
  for (let n = 1; n < attempts; n++) {
    // What isn't absorbed, summed as it's moved on: none left, done.
    let alive = 0;
    let extra = 0;
    let nextLow = cells;
    let nextHigh = -1;
    for (let i = low; i <= high; i++) {
      const mass = distribution[i] as number;
      if (mass === 0) continue;
      alive += mass;
      extra += mass * (extras[i] as number);
      for (let at = offsets[i] as number; at < (offsets[i + 1] as number); at++) {
        const k = columns[at] as number;
        next[k] = (next[k] as number) + mass * (shares[at] as number);
        if (k < nextLow) nextLow = k;
        if (k > nextHigh) nextHigh = k;
      }
    }
    if (!(alive > 1e-12)) return seconds;
    seconds += alive * step.seconds + extra;
    // This step's buffer cleared where it held mass, for its turn as the next.
    if (high >= low) distribution.fill(0, low, high + 1);
    [distribution, next] = [next, distribution];
    low = nextLow;
    high = nextHigh;
  }
  if (!(aliveOf(distribution) > 1e-12)) return seconds;
  // Then the next-best's from wherever the walk is.
  if (step.next === undefined) {
    // The analytic tail (#392) from wherever the stock left the walk.
    if (step.tailRate === undefined) return Number.POSITIVE_INFINITY;
    let tail = 0;
    for (let i = low; i <= high; i++) {
      const mass = distribution[i] as number;
      if (mass !== 0) tail += mass * tailSeconds(step, grid.low + (i / cells) * (target - grid.low), target);
    }
    return seconds + tail;
  }
  // The next-best on its own grid (#392: by its own steps, so solved once for every plan it follows).
  const following = step.next;
  const nextBounded = (following.attempts ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY;
  const nextGrid = bladeburnerTargetGrid(
    nextBounded && following.next !== undefined ? [following, following.next] : [following],
    rank,
    target,
  );
  const nextCells = nextGrid.cells[0] as number;
  const nextLow = nextGrid.low;
  const nextSeconds = nextBounded
    ? boundedNext(following, target, nextCells, nextLow, nextGrid.cells[1] ?? nextCells)
    : solvedNext(following, target, nextCells, nextLow);
  if (nextSeconds === null) return Number.POSITIVE_INFINITY;
  const nextRise = bladeburnerStepRise(following);
  // The next-best's seconds at each of the first's points, between its own two around it (its last's to the target's
  // 0 past it); under its window, Wald's time back up to it.
  const nextAt = (x: number) => {
    if (x < nextLow) return (nextSeconds[0] as number) + ((nextLow - x) * following.seconds) / nextRise;
    const cell = ((x - nextLow) / (target - nextLow)) * nextCells;
    const k = Math.min(nextCells - 1, Math.floor(cell));
    const share = cell - k;
    const upper = k + 1 < nextCells ? (nextSeconds[k + 1] as number) : 0;
    return (1 - share) * (nextSeconds[k] as number) + share * upper;
  };
  let after = 0;
  for (let i = low; i <= high; i++) {
    const mass = distribution[i] as number;
    if (mass !== 0) after += mass * nextAt(grid.low + (i / cells) * (target - grid.low));
  }
  return seconds + after;
}

/**
 * How unlikely a stock's reaching the target or the floor must be for its closed form (#395's review): 1e-9, so the
 * time it leaves out is at most that share of the walk's.
 */
export const BLADEBURNER_STOCK_ALPHA = 1e-9;

/**
 * A stock that won't reach the target nor the floor, in closed form (#395's review: the chain's cost at a far target):
 * a sequence of counted walks ending in the analytic tail. Its rank's path, centred, is a martingale with each attempt
 * at most `up` over its mean and `down` under it (a success's or a failure's at the ±10%'s top, and the rest), its
 * variances summing to V; by Freedman's inequality (Freedman, "On tail probabilities for martingales", 1975, a maximal
 * Bernstein) its highest point passes its mean drift by t with chance at most exp(−t²/(2(V + b·t/3))), b the larger
 * step. With that t at `BLADEBURNER_STOCK_ALPHA` on each side and the drift's own highest and lowest, or with every
 * attempt at its own most (all successes, or all failures, at the ±10%'s top), the path stays under the target and over
 * 0: no attempt absorbed or floored. Then its time is its attempts' seconds and the tail's from
 * its mean end, the tail linear in the rank: Σ kᵢ·sᵢ + (target − rank − Σ kᵢ·μᵢ)/rate, μᵢ a step's mean rise
 * (`bladeburnerStepRise`; Wald's identity over a fixed number of steps), which the chain would give for a grid's work
 * (each landing split to keep its mean, the tail linear). Null where it doesn't apply.
 */
export function bladeburnerStockInClosedForm(step: BladeburnerRankStep, rank: number, target: number): number | null {
  let variance = 0;
  let up = 0;
  let down = 0;
  let seconds = 0;
  let mean = 0;
  let highest = 0;
  let lowest = 0;
  // The path's own most: each attempt a success, or a failure, at the ±10%'s top.
  let most = 0;
  let least = 0;
  for (let each: BladeburnerRankStep | undefined = step; ; each = each.next) {
    if (each === undefined) return null;
    const attempts = each.attempts ?? Number.POSITIVE_INFINITY;
    if (!(attempts < Number.POSITIVE_INFINITY)) return null;
    const count = Math.max(0, Math.floor(attempts));
    const chance = Math.min(1, each.chance);
    const rise = bladeburnerStepRise(each);
    // E[U²] for U uniform on [0.9, 1.1]: 1 + 0.1²/3.
    const square =
      (chance * (each.gain + 0) ** 2 + (1 - chance) * each.loss ** 2) * (1 + 0.01 / 3) +
      2 * each.rest * (chance * each.gain - (1 - chance) * each.loss) +
      each.rest ** 2;
    variance += count * Math.max(0, square - rise * rise);
    if (count > 0) {
      up = Math.max(up, each.gain * 1.1 + each.rest - rise);
      down = Math.max(down, rise + each.loss * 1.1 - each.rest);
    }
    most += count * Math.max(0, each.gain * 1.1 + each.rest);
    least += count * Math.min(0, each.rest - each.loss * 1.1);
    seconds += count * each.seconds;
    mean += count * rise;
    highest = Math.max(highest, mean);
    lowest = Math.min(lowest, mean);
    if (each.next === undefined) {
      const rate = each.tailRate;
      if (rate === undefined || !(rate > 0)) return null;
      const margin = (b: number) => {
        const logs = Math.log(1 / BLADEBURNER_STOCK_ALPHA);
        const linear = (logs * b) / 3;
        return linear + Math.sqrt(linear * linear + 2 * logs * variance);
      };
      // Each side by the path's own most, or Freedman's.
      const under = rank + most < target || rank + highest + margin(up) < target;
      const over = rank + least > 0 || rank + lowest - margin(down) > 0;
      if (!under || !over) return null;
      return seconds + (target - rank - mean) / rate;
    }
  }
}

/** The next-best's seconds from each grid point, solved once a step, target and grid (the rule weighs many before it). */
const solvedNexts = new WeakMap<
  BladeburnerRankStep,
  { target: number; cells: number; low: number; seconds: Float64Array | null }
>();
function solvedNext(step: BladeburnerRankStep, target: number, cells: number, low: number): Float64Array | null {
  const known = solvedNexts.get(step);
  if (known !== undefined && known.target === target && known.cells === cells && known.low === low) {
    return known.seconds;
  }
  const { seconds } = chainOf(step, target, true, cells, low);
  solvedNexts.set(step, { target, cells, low, seconds });
  return seconds;
}

/**
 * A next-best bounded by its own count (#392): its seconds from each of its grid points, its `attempts` then its own
 * `next` (resting alone), by backward induction over the attempts left (Bertsekas, "Dynamic Programming and Optimal
 * Control", 4th ed., 2017, vol. 1, §1.3: V_k = c + Q·V_{k−1}, V_0 the tail's), solved once a step, target and grid.
 * Null where the tail can't rise.
 */
const boundedNexts = new WeakMap<
  BladeburnerRankStep,
  { target: number; cells: number; low: number; seconds: Float64Array | null }
>();
function boundedNext(
  step: BladeburnerRankStep,
  target: number,
  cells: number,
  low: number,
  tailCells: number,
): Float64Array | null {
  const known = boundedNexts.get(step);
  if (known !== undefined && known.target === target && known.cells === cells && known.low === low) {
    return known.seconds;
  }
  const remember = (seconds: Float64Array | null) => {
    boundedNexts.set(step, { target, cells, low, seconds });
    return seconds;
  };
  const tail = step.next === undefined ? null : solvedNext(step.next, target, tailCells, low);
  if (tail === null && step.tailRate === undefined) return remember(null);
  const { offsets, columns, shares, extras } = chainOf(step, target, false, cells, low);
  // V_0: the analytic tail's (#392), or the next's at each point, between its own two around it (its last's to the
  // target's 0 past it).
  let values = new Float64Array(cells);
  for (let i = 0; i < cells; i++) {
    if (tail === null) {
      values[i] = tailSeconds(step, low + (i / cells) * (target - low), target);
      continue;
    }
    const cell = (i / cells) * tailCells;
    const k = Math.min(tailCells - 1, Math.floor(cell));
    const share = cell - k;
    const upper = k + 1 < tailCells ? (tail[k + 1] as number) : 0;
    values[i] = (1 - share) * (tail[k] as number) + share * upper;
  }
  let next = new Float64Array(cells);
  const attempts = Math.max(0, Math.floor(step.attempts ?? 0));
  // Until the attempts are spent, or more of them no longer move any point's time (a count far past the walk's:
  // the walk is absorbed first, as the forward run's 1e-12).
  for (let n = 0; n < attempts; n++) {
    let moved = 0;
    for (let i = 0; i < cells; i++) {
      let total = step.seconds + (extras[i] as number);
      for (let at = offsets[i] as number; at < (offsets[i + 1] as number); at++) {
        total += (shares[at] as number) * (values[columns[at] as number] as number);
      }
      moved = Math.max(moved, Math.abs(total - (values[i] as number)) / Math.max(1, Math.abs(total)));
      next[i] = total;
    }
    [values, next] = [next, values];
    if (!(moved > 1e-12)) break;
  }
  return remember(values);
}

/**
 * The chain of `step` under `target` (`bladeburnerSecondsToRank`) over the grid's window from `low`: where a step from
 * x lands (`landings`, and the time a landing under `low` adds, `extraOf`), each grid point's landings flat
 * (`offsets`, `columns`, `shares`) and the time its landings under `low` add (`extras`), and, `solve`d, the expected
 * seconds to the target from each point (null: not solved, or the walk can't rise) and from a first step's landings
 * (`from`).
 */
function chainOf(
  step: BladeburnerRankStep,
  target: number,
  /** Whether to solve for the seconds: a walk run forward only needs its rows. */
  solve: boolean,
  /** The grid's points and its window's floor (`bladeburnerTargetGrid`). */
  cells: number,
  low = 0,
): {
  cells: number;
  landings: (x: number) => [number, number][];
  extraOf: (x: number) => number;
  offsets: Int32Array;
  columns: Int32Array;
  shares: Float64Array;
  extras: Float64Array;
  seconds: Float64Array | null;
  from: (start: readonly [number, number][]) => number;
} {
  const h = (target - low) / cells;
  const success = Math.min(1, step.chance);
  const each = 1 / BLADEBURNER_OFFSET_POINTS.length;
  // Under the window (`bladeburnerTargetGrid`), Wald's time back up to it: the distance over a step's mean rise.
  const rise = bladeburnerStepRise(step);
  // Where a step from x lands: at or over the target, absorbed; else split between the points around it, the target's
  // own point (absorbed) among them past the last; under the window, at its floor, the time back up to it returned.
  // Each landing handed to `out` as (cell, probability), in the same order for every use.
  const landingsOf = (x: number, out: (k: number, probability: number) => void): number => {
    let extra = 0;
    const put = (y: number, probability: number) => {
      if (!(probability > 0) || y >= target) return;
      if (y < low) {
        extra += (probability * (low - y) * step.seconds) / rise;
        out(0, probability);
        return;
      }
      const cell = (y - low) / h;
      const k = Math.min(cells - 1, Math.floor(cell));
      const share = cell - k;
      // Past the last point, the target's share absorbed.
      if (!(share > 0)) out(k, probability);
      else if (k + 1 >= cells) out(k, probability * (1 - share));
      else {
        out(k, probability * (1 - share));
        out(k + 1, probability * share);
      }
    };
    for (const offset of BLADEBURNER_OFFSET_POINTS) {
      put(x + step.gain * offset + step.rest, success * each);
      put(Math.max(0, x - step.loss * offset) + step.rest, (1 - success) * each);
    }
    return extra;
  };
  const landings = (x: number): [number, number][] => {
    const out: [number, number][] = [];
    landingsOf(x, (k, probability) => out.push([k, probability]));
    return out;
  };
  const extraOf = (x: number) => landingsOf(x, () => {});
  // The rows written straight into the flat arrays (#392: a far target's tens of thousands of points made the rows'
  // own arrays most of a solve's time): at most two landings for each of a success's and a failure's two nodes.
  const most = 4 * BLADEBURNER_OFFSET_POINTS.length;
  const offsets = new Int32Array(cells + 1);
  const extras = new Float64Array(cells);
  let columns = new Int32Array(cells * most);
  let shares = new Float64Array(cells * most);
  let down = 0;
  let up = 0;
  let written = 0;
  let row = 0;
  const write = (k: number, probability: number) => {
    columns[written] = k;
    shares[written] = probability;
    written += 1;
    if (row - k > down) down = row - k;
    if (k - row > up) up = k - row;
  };
  for (row = 0; row < cells; row++) {
    extras[row] = landingsOf(low + row * h, write);
    offsets[row + 1] = written;
  }
  columns = columns.slice(0, written);
  shares = shares.slice(0, written);
  const unsolved = {
    cells,
    landings,
    extraOf,
    offsets,
    columns,
    shares,
    extras,
    seconds: null,
    from: () => Number.POSITIVE_INFINITY,
  };
  const rises = (step.chance > 0 && step.gain + step.rest > 0) || step.rest > step.loss;
  if (!solve || !rises) return unsolved;
  const width = down + up + 1;
  // Row i's column j at i·width + (j − i + down): I − Q in a band, and the right-hand side a step's seconds (and the
  // time back up to the window's floor from its landings under it).
  const band = new Float64Array(cells * width);
  const seconds = new Float64Array(cells);
  for (let i = 0; i < cells; i++) seconds[i] = step.seconds + (extras[i] as number);
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
  return { cells, landings, extraOf, offsets, columns, shares, extras, seconds, from };
}
