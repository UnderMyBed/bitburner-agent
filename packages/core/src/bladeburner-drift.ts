/**
 * Bladeburner (#359), #418: the side effects of the contracts and operations on the cities, and the hospital's money.
 * PR #417's review found them outside the rule's figures. Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under
 * `Bladeburner/` unless named.
 * - **An attempt's effects** (`completeOperation`, `Bladeburner.ts:793-866`; `completeContract`, `:868-890`; called at
 *   `:964`, `:1004`), in the city it runs in (`getCurrentCity`):
 *   - Tracking: the estimate only, on a success (`improvePopulationEstimateByCount`, `City.ts:35-43`).
 *   - Bounty Hunter and Retirement, on a success: the population −1 and the estimate −1 (`City.ts:63-73`), the chaos
 *     +0.02 and +0.04 (`City.ts:89-91`).
 *   - Investigation and Undercover Operation: the estimate on a success (`City.ts:46-58`); on a failure a migration
 *     with chance 0.1 and 0.15 (`triggerPotentialMigration`, `Bladeburner.ts:589-599`): 3–15% of the population to
 *     another city, ×2–4 with chance 0.05 where there are communities, which moves one (`triggerMigration`, `:564-587`).
 *   - Sting: −0.1% of the population and the estimate alike on a success; the chaos +0.1 either way.
 *   - Raid: on a success −1% of the population and the estimate alike, and a community; on a failure −0.5 to −1% of
 *     the population alone, the estimate left (`City.ts:79-87`, `changeEstEqually: false`); the chaos +1–5% either way
 *     (`City.ts:31-33`).
 *   - Stealth Retirement: −0.5% of the population and the estimate alike on a success; the chaos −1–3% either way.
 *   - Assassination: the population and the estimate −1 on a success; the chaos −5% to +5% either way.
 *   Each draw is `getRandomIntInclusive`'s, uniform over its integers (`utils/helpers/getRandomIntInclusive.ts`), so its
 *   mean is its range's middle.
 * - **In the chances** (B4's, ./bladeburner-cities.ts): the true population on the competence, (pop / 1e9)^0.7
 *   (`Actions/Action.ts:88-92`), and the chaos over 50 on the difficulty, √(1 + chaos − 50) (`:94-103`), in the city
 *   worked; so an attempt moves every chance there. Raid is 0 with no communities (`Actions/Operation.ts:63-68`).
 * - **The time's own:** the chaos −0.0001 a second in every city (`Bladeburner.ts:1395-1401`), and a random event every
 *   240–600 s (`:1403-1409`), 420 s on average (the renewal rate), each in a city drawn of the six (`randomEvent`,
 *   `:601-699`), its mean here: 5% a new community (+10–20% of its population), 5% a community's migration (10–20% to
 *   another city, or a new community where it has none), 20% new Synthoids (+8–24%), 20% a migration (`triggerMigration`),
 *   20% riots (the chaos +1, then +5–20%), 20% fewer Synthoids (−8–20%), 10% nothing. The total population rises by
 *   (0.05·0.15 + 0.2·0.16 − 0.2·0.14)/6 of it an event on average, 1.64% an hour, the migrations moving it between
 *   cities.
 * - **Diplomacy** (B4's): the brain sends it in the city worked where its chaos is over 50 and it pays, which B4's
 *   bn6-cities suite solves at about 50.05 (#417's round 1): so the path holds the chaos worked at its ceiling (50, or
 *   the chaos read where that's over 50: B4 decides that one at the reading), each Diplomacy 60 s cutting it by
 *   charisma^0.045 + charisma/1,000 percent (`Bladeburner.ts:737-745`, `:1187-1198`), its time the plan's.
 * - **The hospital** (`Bladeburner.ts:983-991`, `Hospital/Hospital.ts:4-10`, `PersonObjects/Player/
 *   PlayerObjectGeneralMethods.ts:266-290`): a failure does ⌈hpLoss × diffMult ± 10%⌉ HP; at 0 or under, the hospital
 *   refills it and bills min(10% of the money, the HP missing × $100k, `Constants.ts:47`).
 * Left out, and labelled (each where it's used): the ±1 population counts (a kill's, against about 10⁹), the
 * BasePopGrowth's +100 (`data/Constants.ts:36`), the paths' spread (the mean path stands for the mean over the paths:
 * each chance's mean over the spread is under the chance at the mean path's population, (pop)^0.7 concave), and the
 * estimate's own drift (the brain recovers pop/popEst at each reading, #411's ruling 4).
 */
import type { BladeburnerLevelledAction } from "./bladeburner-actions.ts";
import { BLADEBURNER_CONSTANTS, chaosDifficultyFactor } from "./bladeburner-constants.ts";

/** One attempt's mean effects on the city it runs in (#418): its chaos, its true population and its communities. */
export interface BladeburnerAttemptDrift {
  /** The chaos after: chaos × `chaosScale` + `chaosAdd` (`City.ts:31-33`, `:89-91`). */
  chaosScale: number;
  chaosAdd: number;
  /**
   * The scale's log's mean, E[ln(1 + U/100)] over its draw (#418's review): Diplomacy's time to hold a chaos at its
   * ceiling goes as the log, so its mean, under ln(chaosScale) (Jensen's); 0 at a scale of 1.
   */
  chaosLogScale: number;
  /** The true population × `populationScale` (`City.ts:79-87`). */
  populationScale: number;
  /** The share of the population migrated to another city, drawn of the other five (`triggerMigration`). */
  migrated: number;
  /** The communities' change: Raid's success, a migration's 5% (it moves one to the city it goes to). */
  communities: number;
}

/** A migration's mean share (`triggerMigration`, `Bladeburner.ts:564-587`): 3–15%, ×2–4 with chance 0.05 (communities). */
export function migrationShare(communities: number): number {
  return 0.09 * (communities > 0 ? 1 + 0.05 * (3 - 1) : 1);
}

/** A migration's chance on an Investigation's and an Undercover Operation's failure (`Bladeburner.ts:811`, `:820`). */
const MIGRATION_CHANCE: Readonly<Record<string, number>> = { Investigation: 0.1, "Undercover Operation": 0.15 };

/**
 * One attempt's mean effects on its city at success chance `chance` (#418, see above), with the city's `communities`
 * (a migration moves one in 5% of them where there are any).
 */
export function bladeburnerAttemptDrift(
  action: Pick<BladeburnerLevelledAction, "name">,
  chance: number,
  communities = 1,
): BladeburnerAttemptDrift {
  const p = Math.max(0, Math.min(1, chance));
  const none = { chaosScale: 1, chaosAdd: 0, chaosLogScale: 0, populationScale: 1, migrated: 0, communities: 0 };
  switch (action.name) {
    case "Bounty Hunter":
      return { ...none, chaosAdd: 0.02 * p };
    case "Retirement":
      return { ...none, chaosAdd: 0.04 * p };
    case "Investigation":
    case "Undercover Operation": {
      const migrating = (1 - p) * (MIGRATION_CHANCE[action.name] as number);
      return {
        ...none,
        migrated: migrating * migrationShare(communities),
        communities: communities > 0 ? -migrating * 0.05 : 0,
      };
    }
    case "Sting Operation":
      return { ...none, chaosAdd: 0.1, populationScale: 1 - 0.001 * p };
    case "Raid":
      // Its failure's −(5 to 10)/10 %, 0.75% on average; the chaos's +1–5%, 3%.
      return {
        ...none,
        chaosScale: 1.03,
        chaosLogScale: logScaleMean(1, 5),
        populationScale: p * 0.99 + (1 - p) * (1 - 0.0075),
        communities: -p,
      };
    case "Stealth Retirement Operation":
      return { ...none, chaosScale: 0.98, chaosLogScale: logScaleMean(-3, -1), populationScale: 1 - 0.005 * p };
    case "Assassination":
      // Its chaos ±5% (×1 on average) and its −1.
      return { ...none, chaosLogScale: logScaleMean(-5, 5) };
    default:
      // Tracking: the estimate only.
      return none;
  }
}

/** E[ln(1 + U/100)], U uniform over the whole numbers `low`..`high` (`getRandomIntInclusive`'s). */
export function logScaleMean(low: number, high: number): number {
  let sum = 0;
  for (let u = low; u <= high; u++) sum += Math.log1p(u / 100);
  return sum / (high - low + 1);
}

/** A city on the drift's path (#418): its population (any unit common to the six), communities and chaos. */
export interface BladeburnerDriftCity {
  name: string;
  population: number;
  communities: number;
  /** The chaos (on the path, its mean over `chaosMix`). */
  chaos: number;
  /** On the path (#418's review): the chaos as the share at 0 and the cohorts over it (`BladeburnerChaosMix`). */
  chaosMix?: BladeburnerChaosMix;
  /** On the path, once Raid works it (#418's review): the communities' distribution (`BladeburnerCommunitiesMix`). */
  communitiesMix?: BladeburnerCommunitiesMix;
}

/**
 * A city's chaos on the path (#418's review): the share of the paths at 0 and the cohorts over it, each its share and
 * chaos. The decay's clamp at 0 (`Bladeburner.ts:1399-1400`) makes 0 a point the mean can't leave (the riots' mean,
 * under the decay there, and Raid's ×1.03 of 0), while the game's draws do leave it: a riot jumps it to (0 + 1) × 1.125
 * (`:681-683`), which Raid then compounds faster than the decay takes it down. So the share at 0 is carried apart: a
 * riot in a chunk takes 1 − e^−λ of it (λ the city's riots in the chunk, 0.2 an event of 1/6, an event each 420 s),
 * born a cohort at 1.125 halfway through the step; a cohort the decay takes to 0 joins it again. Over 0 each cohort
 * follows the mean, which is exact there while no bound binds (every move is affine: Raid's ×1.03, a riot's
 * (c + 1) × 1.125, the decay's −0.0001 a second); Diplomacy's ceiling is applied cohort by cohort. Labelled: a riot's
 * spread on a cohort over 0 (each is its mean), a second riot on a cohort born in the chunk, and the cohorts merged past
 * `BLADEBURNER_CHAOS_COHORTS` (the nearest two by their chaos's ratio, at their mean).
 */
export interface BladeburnerChaosMix {
  zero: number;
  cohorts: { mass: number; chaos: number }[];
}

/** The cohorts a city's chaos carries at most (`BladeburnerChaosMix`): past it, the nearest two merged. */
export const BLADEBURNER_CHAOS_COHORTS = 16;

/** A city's chaos mix: its own, or the chaos read as one cohort (0: all at 0). */
function mixOf(city: BladeburnerDriftCity): BladeburnerChaosMix {
  if (city.chaosMix !== undefined) return city.chaosMix;
  return city.chaos > 0 ? { zero: 0, cohorts: [{ mass: 1, chaos: city.chaos }] } : { zero: 1, cohorts: [] };
}

/** Sets a city's mix and its mean chaos; a cohort at 0 or under joins the share at 0, and the cohorts are merged. */
function setMix(city: BladeburnerDriftCity, mix: BladeburnerChaosMix): void {
  let zero = mix.zero;
  const cohorts: { mass: number; chaos: number }[] = [];
  let sorted = true;
  for (const cohort of mix.cohorts) {
    if (!(cohort.mass > 0)) continue;
    if (cohort.chaos > 0) {
      const last = cohorts[cohorts.length - 1];
      if (last !== undefined && cohort.chaos < last.chaos) sorted = false;
      cohorts.push(cohort);
    } else zero += cohort.mass;
  }
  // Every map on the path keeps the cohorts' order but a cohort born (the cost: sorted only where it isn't).
  if (!sorted) cohorts.sort((a, b) => a.chaos - b.chaos);
  while (cohorts.length > BLADEBURNER_CHAOS_COHORTS) {
    let at = 0;
    let best = (cohorts[1] as { chaos: number }).chaos / (cohorts[0] as { chaos: number }).chaos;
    for (let i = 1; i + 1 < cohorts.length; i++) {
      const ratio = (cohorts[i + 1] as { chaos: number }).chaos / (cohorts[i] as { chaos: number }).chaos;
      if (ratio < best) {
        at = i;
        best = ratio;
      }
    }
    const low = cohorts[at] as { mass: number; chaos: number };
    const high = cohorts[at + 1] as { mass: number; chaos: number };
    const mass = low.mass + high.mass;
    cohorts.splice(at, 2, { mass, chaos: (low.mass * low.chaos + high.mass * high.chaos) / mass });
  }
  city.chaosMix = { zero, cohorts };
  city.chaos = cohorts.reduce((sum, cohort) => sum + cohort.mass * cohort.chaos, 0);
}

/** The chaos's mean factor on a chance there, 1 over √(1 + chaos − 50) over 50, each cohort at most `ceiling`. */
function chaosFactorOf(city: BladeburnerDriftCity, ceiling = Number.POSITIVE_INFINITY): number {
  if (city.chaosMix === undefined) return 1 / chaosDifficultyFactor(Math.min(city.chaos, ceiling));
  let factor = city.chaosMix.zero;
  for (const cohort of city.chaosMix.cohorts)
    factor += cohort.mass / chaosDifficultyFactor(Math.min(cohort.chaos, ceiling));
  return factor;
}

/** A city copied with its mix (the path changes its own copies). */
function copyCity(city: BladeburnerDriftCity): BladeburnerDriftCity {
  const copied: BladeburnerDriftCity = { ...city };
  if (city.chaosMix !== undefined) {
    copied.chaosMix = { zero: city.chaosMix.zero, cohorts: city.chaosMix.cohorts.map((each) => ({ ...each })) };
  }
  if (city.communitiesMix !== undefined) {
    copied.communitiesMix = { low: city.communitiesMix.low, probs: [...city.communitiesMix.probs] };
  }
  return copied;
}

/**
 * A city's communities on the path once Raid works it (#418's review): their distribution over the whole numbers from
 * `low` (`probs`). Raid's chance is 0 with none (`Actions/Operation.ts:63-68`) and a success takes one
 * (`Bladeburner.ts:832-838`), so near 0 the chance is P(at least one), not the mean's: walks of the game's draws had
 * Raid's mean chance 0.012 over 100 h where the mean (its events' +0.1 an hour over 0) kept it at 0.052.
 */
export interface BladeburnerCommunitiesMix {
  low: number;
  probs: number[];
}

/** A city's communities' distribution: its own, or the mean read split between its two whole numbers. */
function communitiesMixOf(city: BladeburnerDriftCity): BladeburnerCommunitiesMix {
  if (city.communitiesMix !== undefined) return city.communitiesMix;
  const mean = Math.max(0, city.communities);
  const low = Math.floor(mean);
  const share = mean - low;
  return { low, probs: share > 0 ? [1 - share, share] : [1] };
}

/** Sets a city's communities' distribution (its tails under 1e-12 dropped) and its mean. */
function setCommunities(city: BladeburnerDriftCity, low: number, cells: Float64Array): void {
  let first = 0;
  let last = cells.length - 1;
  while (first < last && !((cells[first] as number) > 1e-12)) first++;
  while (last > first && !((cells[last] as number) > 1e-12)) last--;
  let total = 0;
  let sum = 0;
  for (let i = first; i <= last; i++) {
    total += cells[i] as number;
    sum += (low + i) * (cells[i] as number);
  }
  if (!(total > 0)) return;
  const probs: number[] = [];
  for (let i = first; i <= last; i++) probs.push((cells[i] as number) / total);
  city.communitiesMix = { low: low + first, probs };
  city.communities = sum / total;
}

/** The Poisson's probabilities of 0..k at mean m, the rest at k (`Math.max` of a tail): a count's draws in a chunk. */
function poisson(mean: number, most: number): number[] {
  const out: number[] = [];
  let term = Math.exp(-mean);
  let sum = 0;
  for (let k = 0; k < most; k++) {
    out.push(term);
    sum += term;
    term *= mean / (k + 1);
  }
  out.push(Math.max(0, 1 - sum));
  return out;
}

/** P(at least one community): Raid's factor (`Actions/Operation.ts:63-68`), from the distribution where carried. */
function communitiesFactor(city: BladeburnerDriftCity): number {
  if (city.communitiesMix === undefined) return city.communities > 0 ? 1 : 0;
  const { low, probs } = city.communitiesMix;
  return low > 0 ? 1 : 1 - (probs[0] ?? 0);
}

/**
 * `successes` (a Poisson's mean: each attempt's success its own draw, a chunk's few at small chances) of Raid taking a
 * community each, none taken at 0 (its chance 0 there); the communities taken, on average. Far from 0 (8 standard
 * deviations of the draws over 1) with no distribution yet, the mean's, exact there.
 */
function takeCommunities(city: BladeburnerDriftCity, successes: number): number {
  if (!(successes > 0)) return 0;
  if (city.communitiesMix === undefined && city.communities - successes - 8 * Math.sqrt(successes + 1) >= 1) {
    city.communities -= successes;
    return successes;
  }
  const before = city.communities;
  const { low, probs } = communitiesMixOf(city);
  const draws = poisson(successes, Math.max(8, Math.ceil(successes + 8 * Math.sqrt(successes))));
  // From 0 to the most there is now.
  const cells = new Float64Array(low + probs.length);
  for (const [i, mass] of probs.entries()) {
    const count = low + i;
    for (const [taken, chance] of draws.entries()) {
      const after = count > taken ? count - taken : 0;
      cells[after] = (cells[after] as number) + mass * chance;
    }
  }
  setCommunities(city, 0, cells);
  return Math.max(0, before - city.communities);
}

/**
 * The events' communities over a step on a carried distribution (`randomEvent`, `Bladeburner.ts:601-699`): as the
 * source (1/6 of the events) a new community +1 (0.05), a community's migration −1 (0.05, or +1 with none), a migration's
 * community −1 (0.2 × 0.05, with some); as a destination +1 from each other city with some (1/30 of the events: 0.05 and
 * 0.2 × 0.05). Each a Poisson's draws over the step, the gains and the losses apart.
 */
function eventCommunities(city: BladeburnerDriftCity, events: number, inflow: number): void {
  const { low, probs } = communitiesMixOf(city);
  const most = 4;
  const losses = poisson((events * (0.05 + 0.2 * 0.05)) / 6, most);
  const gainsSome = poisson((events * 0.05) / 6 + inflow, most);
  const gainsNone = poisson((events * 0.1) / 6 + inflow, most);
  const start = Math.max(0, low - most);
  const size = low + probs.length + most - start;
  // The gains, then the losses on what had some (the floor at 0 the same in turn, max(0, c + up − down)); with none,
  // the gains alone (for the cost: two passes of 5, not 25).
  const gained = new Float64Array(size);
  const cells = new Float64Array(size);
  for (const [i, mass] of probs.entries()) {
    const count = low + i;
    if (count === 0) {
      for (const [up, chanceUp] of gainsNone.entries())
        cells[up - start] = (cells[up - start] as number) + mass * chanceUp;
      continue;
    }
    for (const [up, chanceUp] of gainsSome.entries()) {
      gained[count + up - start] = (gained[count + up - start] as number) + mass * chanceUp;
    }
  }
  for (let at = 0; at < size; at++) {
    const mass = gained[at] as number;
    if (!(mass > 0)) continue;
    const count = at + start;
    for (const [down, chanceDown] of losses.entries()) {
      const after = Math.max(0, count - down) - start;
      cells[after] = (cells[after] as number) + mass * chanceDown;
    }
  }
  setCommunities(city, start, cells);
}

/** A random event's mean interval (`Bladeburner.ts:1403-1409`, `getRandomIntInclusive(240, 600)`): 420 s. */
export const BLADEBURNER_EVENT_SECONDS = 420;

/**
 * Each city's mean change a second from the random events (#418, `randomEvent`, `Bladeburner.ts:601-699`): a city the
 * source with chance 1/6, the destination of a move with chance 1/6 (one of the other five, `:609-610`), over
 * `BLADEBURNER_EVENT_SECONDS`.
 */
export function bladeburnerEventDrift(
  cities: readonly BladeburnerDriftCity[],
): { population: number; chaos: number; communities: number }[] {
  const n = cities.length;
  if (n < 2) return cities.map(() => ({ population: 0, chaos: 0, communities: 0 }));
  // What each city sends to the destination, as the source: a community's migration (15% and a community) where it
  // has communities, and a migration's share (`migrationShare`) with its 5% community move.
  const sent = cities.map((city) => {
    const has = city.communities > 0;
    return {
      population: city.population * ((has ? 0.05 * 0.15 : 0) + 0.2 * migrationShare(city.communities)),
      communities: has ? 0.05 + 0.2 * 0.05 : 0,
    };
  });
  const total = sent.reduce(
    (sum, each) => ({ population: sum.population + each.population, communities: sum.communities + each.communities }),
    { population: 0, communities: 0 },
  );
  const rate = 1 / BLADEBURNER_EVENT_SECONDS;
  return cities.map((city, i) => {
    const has = city.communities > 0;
    const own = sent[i] as { population: number; communities: number };
    // As the source: a new community +15% (+1), a community's migration (−15%, −1; with none, a new one), new
    // Synthoids +16%, a migration out, the riots, fewer Synthoids −14%.
    const asSource = {
      population: city.population * (0.05 * 0.15 + (has ? 0 : 0.05 * 0.15) + 0.2 * 0.16 - 0.2 * 0.14) - own.population,
      communities: 0.05 + (has ? 0 : 0.05) - own.communities,
      // Riots: (chaos + 1) × 1.125 − chaos.
      chaos: 0.2 * ((city.chaos + 1) * 1.125 - city.chaos),
    };
    // As the destination: each other source's sending, its destination this one with chance 1/(n − 1).
    const inflow = {
      population: (total.population - own.population) / (n - 1),
      communities: (total.communities - own.communities) / (n - 1),
    };
    return {
      population: (rate * (asSource.population + inflow.population)) / n,
      chaos: (rate * asSource.chaos) / n,
      communities: (rate * (asSource.communities + inflow.communities)) / n,
    };
  });
}

/**
 * A riot's log's mean on a chaos, E[ln(1 + U/100)], U of 5..20 (`Bladeburner.ts:682-683`): on a chaos Diplomacy holds,
 * the time to hold it goes as the log (#418's review), so a riot there is taken at it, with its +1's ln(1 + 1/chaos).
 */
const RIOT_LOG = (() => {
  let sum = 0;
  for (let u = 5; u <= 20; u++) sum += Math.log1p(u / 100);
  return sum / 16;
})();

/** The chaos's fall a second, every city's (`Bladeburner.ts:1398`). */
const CHAOS_DECAY = 0.0001;

/**
 * Each city's `steps[i]` seconds of the random events' mean (`bladeburnerEventDrift`, the same figures, in place: the
 * path's own, at each chunk) and the decay, each city at least 0; a city at 0 seconds left as it is. Each city's from the
 * figures before the call, so the order of the six doesn't matter.
 */
function applyEvents(
  cities: BladeburnerDriftCity[],
  steps: readonly number[],
  /** The city worked and Diplomacy's hold there: a riot on a chaos held taken at its log's mean (`RIOT_LOG`). */
  held: { index: number; ceiling: number } | null = null,
): void {
  const n = cities.length;
  let sentPopulation = 0;
  let sentCommunities = 0;
  for (const city of cities) {
    const has = city.communities > 0;
    sentPopulation += city.population * ((has ? 0.05 * 0.15 : 0) + 0.2 * migrationShare(city.communities));
    sentCommunities += has ? 0.05 + 0.2 * 0.05 : 0;
  }
  // Each city's change from the figures before the step, so the order of the six doesn't matter.
  const changes = cities.map((city, i) => {
    const rate = (steps[i] ?? 0) / BLADEBURNER_EVENT_SECONDS / n;
    if (n < 2 || !(rate > 0)) return { population: 0, communities: 0, chaos: 0 };
    const has = city.communities > 0;
    const ownPopulation = city.population * ((has ? 0.05 * 0.15 : 0) + 0.2 * migrationShare(city.communities));
    const ownCommunities = has ? 0.05 + 0.2 * 0.05 : 0;
    return {
      population:
        rate *
        (city.population * (0.05 * 0.15 + (has ? 0 : 0.05 * 0.15) + 0.2 * 0.16 - 0.2 * 0.14) -
          ownPopulation +
          (sentPopulation - ownPopulation) / (n - 1)),
      communities: rate * (0.05 + (has ? 0 : 0.05) - ownCommunities + (sentCommunities - ownCommunities) / (n - 1)),
    };
  });
  for (const [i, city] of cities.entries()) {
    const dt = steps[i] ?? 0;
    if (!(dt > 0)) continue;
    const rate = dt / BLADEBURNER_EVENT_SECONDS / n;
    const change = changes[i] as { population: number; communities: number };
    city.population = Math.max(0, city.population + change.population);
    if (city.communitiesMix === undefined || n < 2) {
      city.communities = Math.max(0, city.communities + change.communities);
    } else {
      // Carried (Raid works it): the events' draws on the distribution, each other city with some sending.
      const events = dt / BLADEBURNER_EVENT_SECONDS;
      let inflow = 0;
      for (const [j, other] of cities.entries()) {
        if (j !== i && other.communities > 0) inflow += (events * (0.05 + 0.2 * 0.05)) / (n * (n - 1));
      }
      eventCommunities(city, events, inflow);
    }
    // The chaos (`BladeburnerChaosMix`): each cohort over 0 its riots' mean and the decay; of the share at 0, those a
    // riot reaches, 1 − e^−λ (λ = 0.2 × the city's events), born at 1.125 halfway through, so half the decay.
    const mix = mixOf(city);
    const riots = n < 2 ? 0 : rate * 0.2;
    const atHold = held !== null && held.index === i ? held.ceiling : Number.POSITIVE_INFINITY;
    // In place: the path's own copies (`copyCity`).
    const cohorts = mix.cohorts;
    for (const cohort of cohorts) {
      cohort.chaos =
        cohort.chaos >= atHold
          ? cohort.chaos * Math.exp(riots * (RIOT_LOG + Math.log1p(1 / cohort.chaos))) - CHAOS_DECAY * dt
          : cohort.chaos + riots * ((cohort.chaos + 1) * 1.125 - cohort.chaos) - CHAOS_DECAY * dt;
    }
    let zero = mix.zero;
    const reached = zero * -Math.expm1(-riots);
    if (reached > 0) {
      const born = Math.max(0, 1.125 - (CHAOS_DECAY * dt) / 2);
      cohorts.push({ mass: reached, chaos: born });
      zero -= reached;
    }
    setMix(city, { zero, cohorts });
  }
}

/** Diplomacy's cut of the chaos, in percent (`Bladeburner.ts:737-745`), and its seconds (`data/GeneralActions.ts:39`). */
function diplomacyPercentOf(charisma: number): number {
  return charisma ** 0.045 + charisma / 1e3;
}
const DIPLOMACY_SECONDS = 60;

/**
 * A city's competence factor on every chance there (#418): (pop)^0.7 over the chaos's factor (`Actions/Action.ts:
 * 88-103`), on the path the factor's mean over its chaos mix, each cohort's chaos at most `ceiling` (Diplomacy's hold).
 */
export function cityChanceFactor(
  city: Pick<BladeburnerDriftCity, "population" | "chaos" | "chaosMix">,
  ceiling = Number.POSITIVE_INFINITY,
): number {
  return (
    Math.max(0, city.population) ** BLADEBURNER_CONSTANTS.populationExponent *
    chaosFactorOf(city as BladeburnerDriftCity, ceiling)
  );
}

/** The drift's state (#418): the six cities, the one worked, and the chaos Diplomacy holds it at (`ceiling`). */
export interface BladeburnerDriftState {
  cities: BladeburnerDriftCity[];
  worked: number;
  /** The chaos the worked city is held at by Diplomacy (50, or the chaos read over it). */
  ceiling: number;
}

/** A part of the work on the path: an action, its chance at the reference city `reference`, and its attempts. */
export interface BladeburnerDriftPart {
  action: Pick<BladeburnerLevelledAction, "name">;
  /** Its chance at `reference` (the city and state its chance was read at). */
  chance: number;
  attempts: number;
}

/**
 * The chunks a path is followed in at most: past it, each a share of the attempts (`bladeburnerDriftPath`). 256: in one
 * city the chunks are exact to a part in 10⁴ against attempts one at a time (they converge: Raid's mean chance 0.01591,
 * 0.01589, 0.01589, 0.01589 and 0.01588 at 100, 256, 512, 1,024 and 1,600 chunks of its 1,600 attempts).
 */
export const BLADEBURNER_DRIFT_CHUNKS = 256;

/**
 * Raid with B4's moves is followed an attempt at a time (#418's ruling 4). Its chunks don't converge: Raid drains the
 * city it works, B4 moves to the next with the most factor, and the city left keeps its chaos (Diplomacy holds only the
 * one worked) while the riots raise it, so the path settles in one of two homes of near-equal factor (Volhaven's or
 * Ishima's here), which by the step: of 1,600 attempts, Volhaven worked 37%, 45%, 18%, 44% and 18% at 256, 512, 800,
 * 1,024 and 1,600 chunks, hundreds of switches each, the mean chance 1.15%, 4.3%, 0.1%, 3.6% and 0 off the attempt at a
 * time (core's test, the path's chunks). A bifurcation in B4's argmax, not the splitting's order or the clamp's
 * cohorts (a city worked throughout converges, above). An attempt at a time is the brain's own resolution (B4 reads
 * each 10 s, an attempt each minute or more): 4 times a path's cost (5.7 ms against 1.4). B4's own near-tie flipping
 * (moving only by more than the error) is #420's.
 */
export const BLADEBURNER_DRIFT_EXACT_RAID = true;

/**
 * An action's chance on the path (#418): its chance at `reference` times the worked city's factor over the reference's
 * (`cityChanceFactor`), at most 1; Raid 0 with no communities there.
 */
export function driftedChance(
  part: Pick<BladeburnerDriftPart, "action" | "chance">,
  reference: Pick<BladeburnerDriftCity, "population" | "chaos" | "chaosMix">,
  city: BladeburnerDriftCity,
  /** The chaos Diplomacy holds the city at (its cohorts over it counted at it). */
  ceiling = Number.POSITIVE_INFINITY,
): number {
  // Raid by P(at least one community) there (none: 0, `Actions/Operation.ts:63-68`).
  const communities = part.action.name === "Raid" ? communitiesFactor(city) : 1;
  return chanceThere(part, reference, city, ceiling) * communities;
}

/** An action's chance in a city with the communities it needs (`driftedChance` but for Raid's P(some)). */
function chanceThere(
  part: Pick<BladeburnerDriftPart, "chance">,
  reference: Pick<BladeburnerDriftCity, "population" | "chaos" | "chaosMix">,
  city: BladeburnerDriftCity,
  ceiling: number,
): number {
  const from = cityChanceFactor(reference);
  if (!(from > 0)) return 0;
  return Math.min(1, part.chance * (cityChanceFactor(city, ceiling) / from));
}

/** What a path did (#418): the state after it, each part's mean chance, and Diplomacy's seconds on it. */
export interface BladeburnerDriftResult {
  state: BladeburnerDriftState;
  /** Each part's mean chance over its attempts (its successes over its attempts); its chance there with none. */
  chances: number[];
  diplomacySeconds: number;
  /**
   * The first part's figures at each chunk's end (#418's review: an action's ways priced off one path), cumulative:
   * its attempts, successes and Diplomacy's seconds.
   */
  curve: { attempts: number[]; successes: number[]; diplomacy: number[] };
}

/**
 * The mean path of the cities over `seconds` of work (#418): each part's attempts, spread evenly over the time, in the
 * city worked, each moving it by its mean effects at its chance there (`bladeburnerAttemptDrift`), the decay and the
 * random events' mean (`bladeburnerEventDrift`) over the time, and Diplomacy holding the worked city's chaos at the
 * ceiling (its time returned, not taken from `seconds`). `moves`: the brain's city chosen again as the path goes (B4's,
 * the most chance factor), else the city worked throughout. Since #420 the brain measures every city's true population
 * each reading, so its B4 picks by the truth, as the path's. Labelled (#420's ruling 3): the path is the mean, where the
 * six alike stay alike, but the events spread the cities apart and B4 works the best of them, so against walks of the
 * game's draws from 150 to Typhoon's 2,500 the path is pessimistic by 14.7% (Bounty Hunter first) and 15.1% (Raid
 * first), the plans' order the same: Bounty Hunter's chance 0.418 priced, 0.528 an attempt walked (0.297 at the six's
 * mean). Pricing B4's pick over the spread is #421's. In attempts one at a time to `BLADEBURNER_DRIFT_CHUNKS`,
 * past it in that many chunks, each chunk's attempts at the chance before each, as if linear over the chunk (the
 * success-moved effects, Raid's and the kills', at the chance at the chunk's start).
 */
export function bladeburnerDriftPath(
  start: BladeburnerDriftState,
  reference: Pick<BladeburnerDriftCity, "population" | "chaos" | "chaosMix">,
  parts: readonly BladeburnerDriftPart[],
  seconds: number,
  {
    charisma,
    moves,
    chunks: given,
    exactRaid,
  }: {
    charisma: number;
    moves: boolean;
    /**
     * The chunks at most: absent, `BLADEBURNER_DRIFT_CHUNKS`; the grown estimate's steps fewer, its own. Raid with
     * the moves an attempt at a time whatever is given (`BLADEBURNER_DRIFT_EXACT_RAID`).
     */
    chunks?: number;
    /** Raid with the moves an attempt at a time: `BLADEBURNER_DRIFT_EXACT_RAID` absent (false: the chunks, the tests'). */
    exactRaid?: boolean;
  },
): BladeburnerDriftResult {
  const cities = start.cities.map(copyCity);
  let worked = start.worked;
  const most = Math.max(0, ...parts.map((part) => part.attempts));
  const exact =
    (exactRaid ?? BLADEBURNER_DRIFT_EXACT_RAID) && moves && parts.some((part) => part.action.name === "Raid");
  const mostChunks = exact ? Number.POSITIVE_INFINITY : (given ?? BLADEBURNER_DRIFT_CHUNKS);
  const chunks = Math.max(1, Math.min(mostChunks, Math.ceil(most)));
  const dt = Math.max(0, seconds) / chunks;
  const successes = parts.map(() => 0);
  const keep = 1 - diplomacyPercentOf(charisma) / 100;
  let diplomacySeconds = 0;
  // Raid alone (the rule's own pricing of it): the cities with communities only.
  const raidAlone = parts.length > 0 && parts.every((part) => part.action.name === "Raid");
  const curve = { attempts: [0], successes: [0], diplomacy: [0] };
  for (let chunk = 0; chunk < chunks; chunk++) {
    // The time's own over the chunk's first half, the attempts, then its second half (Strang's splitting, second order
    // in the chunk: at a chunk's end alone the attempts saw the population before the events' inflow, the drained city's
    // chance low by 9% over 10 h at 64 chunks, against walks of the game's draws). The city worked only: the others,
    // where no attempt falls, take the chunk's whole step at once (for the cost: their events a step's, from its start).
    const whole = cities.map((_, i) => (i === worked ? dt / 2 : dt));
    if (dt > 0) applyEvents(cities, whole, { index: worked, ceiling: start.ceiling });
    for (const [index, part] of parts.entries()) {
      const attempts = part.attempts / chunks;
      if (!(attempts > 0)) continue;
      const city = cities[worked] as BladeburnerDriftCity;
      // Each chance at the chaos held (Diplomacy keeps it at the ceiling between the readings; its time at the end).
      const before = driftedChance(part, reference, city, start.ceiling);
      const drift = bladeburnerAttemptDrift(part.action, before, city.communities);
      const raid = part.action.name === "Raid";
      const thereBefore = raid ? chanceThere(part, reference, city, start.ceiling) : 0;
      applyAttempts(cities, worked, drift, attempts, { ceiling: start.ceiling, takesCommunities: raid });
      const now = cities[worked] as BladeburnerDriftCity;
      // The chunk's attempts each drawn at the chance before it: Σ over j < a of p(j), exact where p is linear in j
      // (the trapezoid and half its fall); one attempt or less, the chance before it.
      const linear = (from: number, to: number) =>
        attempts >= 1 ? (attempts * (from + to)) / 2 + (from - to) / 2 : attempts * from;
      // Raid's successes take communities, each where there's some (#418's review): its successes the communities taken,
      // each attempt's success a Poisson's draw at its chance there, none at 0.
      const drawn = raid
        ? takeCommunities(now, linear(thereBefore, chanceThere(part, reference, now, start.ceiling)))
        : linear(before, driftedChance(part, reference, now, start.ceiling));
      successes[index] = (successes[index] as number) + drawn;
    }
    // The time's own over its second half, the city worked's: the random events' mean and the decay.
    const half = cities.map((_, i) => (i === worked ? dt / 2 : 0));
    if (dt > 0) applyEvents(cities, half, { index: worked, ceiling: start.ceiling });
    // B4's order: the city first (the most chance factor, its chaos as it is), then Diplomacy there, to its ceiling.
    if (moves) worked = mostFactor(cities, worked, raidAlone, start.ceiling);
    const here = cities[worked] as BladeburnerDriftCity;
    if (here.chaos > 0 && keep > 0 && keep < 1) {
      const mix = mixOf(here);
      let spent = 0;
      const cohorts = mix.cohorts.map((cohort) => {
        if (!(cohort.chaos > start.ceiling)) return cohort;
        spent += (cohort.mass * DIPLOMACY_SECONDS * Math.log(start.ceiling / cohort.chaos)) / Math.log(keep);
        return { mass: cohort.mass, chaos: start.ceiling };
      });
      if (spent > 0) {
        diplomacySeconds += spent;
        setMix(here, { zero: mix.zero, cohorts });
      }
    }
    curve.attempts.push((((parts[0]?.attempts ?? 0) / chunks) * (chunk + 1)) as number);
    curve.successes.push(successes[0] ?? 0);
    curve.diplomacy.push(diplomacySeconds);
  }
  return {
    state: { cities, worked, ceiling: start.ceiling },
    chances: parts.map((part, index) =>
      part.attempts > 0
        ? (successes[index] as number) / part.attempts
        : driftedChance(part, reference, start.cities[start.worked] as BladeburnerDriftCity, start.ceiling),
    ),
    diplomacySeconds,
    curve,
  };
}

/** A path's curve at `attempts` (`BladeburnerDriftResult`'s `curve`): its successes and Diplomacy's, linear between chunks. */
export function bladeburnerDriftCurveAt(
  curve: BladeburnerDriftResult["curve"],
  attempts: number,
): { successes: number; diplomacy: number } {
  const { attempts: at, successes, diplomacy } = curve;
  const last = at.length - 1;
  if (!(attempts > 0)) return { successes: 0, diplomacy: 0 };
  let j = 1;
  while (j < last && (at[j] as number) < attempts) j++;
  const from = at[j - 1] as number;
  const to = at[j] as number;
  const share = to > from ? Math.min(1, (attempts - from) / (to - from)) : 1;
  const mix = (xs: number[]) => (xs[j - 1] as number) + share * ((xs[j] as number) - (xs[j - 1] as number));
  return { successes: mix(successes), diplomacy: mix(diplomacy) };
}

/**
 * `attempts` attempts' mean effects on city `worked` (a migration's population to the other cities, evenly); its map
 * on the chaos, c × scale + add (each cohort's, the share at 0 a cohort at `add` where it's over 0).
 */
function applyAttempts(
  cities: BladeburnerDriftCity[],
  worked: number,
  drift: BladeburnerAttemptDrift,
  attempts: number,
  {
    ceiling = Number.POSITIVE_INFINITY,
    takesCommunities = false,
  }: {
    /** Diplomacy's hold: a cohort there scaled by the log's mean (`chaosLogScale`), the time to hold it the log's. */
    ceiling?: number;
    /** Raid: its communities taken on their distribution after (`takeCommunities`), not here. */
    takesCommunities?: boolean;
  } = {},
): { scale: number; add: number } {
  const city = cities[worked] as BladeburnerDriftCity;
  // chaos × s + a, k times: s^k·chaos + a·(s^k − 1)/(s − 1), or + a·k at s 1.
  const scaled = drift.chaosScale ** attempts;
  const added =
    drift.chaosScale === 1 ? drift.chaosAdd * attempts : (drift.chaosAdd * (scaled - 1)) / (drift.chaosScale - 1);
  if (scaled !== 1 || added !== 0) {
    const mix = mixOf(city);
    // A cohort that reaches the hold: its mean scale to it, then the log's mean past it (the time to hold it its log's).
    const growing = drift.chaosScale > 1;
    const cohorts = mix.cohorts.map((cohort) => {
      if (!growing || !(cohort.chaos * scaled > ceiling))
        return { mass: cohort.mass, chaos: cohort.chaos * scaled + added };
      const toHold = cohort.chaos >= ceiling ? 0 : Math.log(ceiling / cohort.chaos) / Math.log(drift.chaosScale);
      return {
        mass: cohort.mass,
        chaos: Math.max(cohort.chaos, ceiling) * Math.exp(drift.chaosLogScale * (attempts - toHold)) + added,
      };
    });
    if (added > 0 && mix.zero > 0) cohorts.push({ mass: mix.zero, chaos: added });
    setMix(city, { zero: added > 0 ? 0 : mix.zero, cohorts });
  }
  const kept = drift.populationScale ** attempts;
  const leaving = city.population * kept * (1 - (1 - drift.migrated) ** attempts);
  city.population = Math.max(0, city.population * kept - leaving);
  const others = cities.length - 1;
  if (others > 0 && leaving > 0) {
    for (const [i, other] of cities.entries()) if (i !== worked) other.population += leaving / others;
  }
  const moved = drift.communities * attempts;
  if (!takesCommunities && city.communitiesMix === undefined) city.communities = Math.max(0, city.communities + moved);
  if (others > 0 && drift.migrated > 0 && moved < 0) {
    for (const [i, other] of cities.entries()) if (i !== worked) other.communities += -moved / others;
  }
  return { scale: scaled, add: added };
}

/**
 * The city chosen again (B4's, by its ratio): another only where it beats the one worked with that one's chaos at the
 * ceiling, Diplomacy's to take it there (B4 would move on Raid's jump of chaos and come back, at a reading's
 * resolution; the chaos is Diplomacy's to take off either way, the decay's 0.0001 a second its only other way down),
 * so the path doesn't hang on its chunks; the current one on a tie. With `raid`, of those with communities (B4's "the
 * most with Raid there"), the current one where none has.
 */
function mostFactor(cities: readonly BladeburnerDriftCity[], current: number, raid: boolean, ceiling: number): number {
  const worked = cities[current] as BladeburnerDriftCity;
  const kept =
    raid && !(communitiesFactor(worked) > 0)
      ? -1
      : cityChanceFactor(worked, ceiling) * (raid ? communitiesFactor(worked) : 1);
  let best = current;
  let most = kept;
  for (const [i, city] of cities.entries()) {
    if (i === current || (raid && !(communitiesFactor(city) > 0))) continue;
    const factor = cityChanceFactor(city) * (raid ? communitiesFactor(city) : 1);
    if (factor > most) {
      best = i;
      most = factor;
    }
  }
  return best;
}

/**
 * The drift's start from the cities read (#418): their populations (since #420 each city's measured true population,
 * core's `bladeburnerMeasuredCities`, as B4's are: the walk's and the grown estimate's B4 then picks by each city's own
 * figure, as the brain does), communities and chaos, the city
 * worked `city`, its chaos at `chaos` where given (B4's forecasts at another chaos), Diplomacy's ceiling 50 or the
 * chaos read over it. Null with `city` not among them.
 */
export function bladeburnerDriftStart(
  cities: readonly BladeburnerDriftCity[],
  city: string,
  chaos?: number,
): BladeburnerDriftState | null {
  const worked = cities.findIndex((each) => each.name === city);
  if (worked < 0) return null;
  const copied = cities.map(copyCity);
  const here = copied[worked] as BladeburnerDriftCity;
  if (chaos !== undefined && chaos !== here.chaos) {
    here.chaos = chaos;
    delete here.chaosMix;
  }
  return { cities: copied, worked, ceiling: Math.max(BLADEBURNER_CONSTANTS.chaosThreshold, here.chaos) };
}

/** The hospital's bill an HP (`Constants.ts:47`, `HospitalCostPerHp`). */
export const HOSPITAL_COST_PER_HP = 100e3;

/**
 * A failure's mean hospital bill (#418): with a failure's mean damage `damage` (core's `actionHpLoss`) against the max
 * HP `hpMax`, the hospital comes each k = ⌈max / damage⌉ failures (the HP refilled at each visit,
 * `PlayerObjectGeneralMethods.ts:281-290`), its bill min(10% of `money`, the HP missing × $100k), the HP missing k ×
 * damage (`Hospital/Hospital.ts:4-10`, the HP gone under 0 counted): so min(10% of the money, $100k × k × damage) / k.
 * 0 with no damage or no money (`:4-6`). Left out, and labelled: each draw's ±10% and ⌈⌉ (`Bladeburner.ts:984-985`),
 * the HP the Regeneration Chamber gives back, and the HP under the max at the reading (the first visit's).
 */
export function hospitalCostPerFailure(damage: number, hpMax: number, money: number): number {
  if (!(damage > 0) || !(money > 0) || !(hpMax > 0)) return 0;
  const k = Math.ceil(hpMax / damage);
  return Math.min(0.1 * money, HOSPITAL_COST_PER_HP * k * damage) / k;
}
