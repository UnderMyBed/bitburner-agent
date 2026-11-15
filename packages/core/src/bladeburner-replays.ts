/**
 * Bladeburner (#423): the grown estimate's route replayed under the game's draws, and re-priced at each replay's own
 * drawn chances. Paths are `vendor/bitburner-src/src/`'s (v3.0.1), under `Bladeburner/` unless named.
 * - **Why:** the drift's mean path (./bladeburner-drift.ts) carries each city's chaos at its mean. The chance is convex
 *   in the chaos (√(1 + chaos − 50) over 50, `Actions/Action.ts:94-103`) and B4 takes the best of the six, so where the
 *   route's mean chaos climbs past 50 (Raid's ×1.01–1.05 an attempt, the riots' compounding) the mean path rules out
 *   cities that the game's own draws leave workable. Walked under the game's draws, every grown route measured was about
 *   40% shorter (#423's ruling 4: BN6's best case 113.6 h against 68.6 ± 0.5 h, all of it the chaos's spread; the walks
 *   within 4 sd of the full simulator over a route's opening hour, core's parity test).
 * - **What a replay is:** the route's own attempts at the route's own times (each climb step's mix evenly over it; a
 *   Black Op's expected rebuilds back to back from its start, its own attempts moving no city), the random events
 *   (`randomEvent`, `:601-699`, every U(240..600) s, `:1403-1409`), the decay (`:1395-1401`), each attempt's effects
 *   on its city (`completeOperation`, `:793-866`; `completeContract`, `:868-890`; a migration `triggerMigration`,
 *   `:564-599`), B4's pick by the true figures (core's `bladeburnerMostFactorCity`) and Diplomacy taking the city worked
 *   to its ceiling (`:737-745`, `:1187-1189`; its time the route's), each replay its own cities, so its own drain.
 * - **The re-pricing, first-order (labelled):** the route's actions, levels, attempts a second, installs, Diplomacy's
 *   time and clock are the mean path's; each step's rate at the replay's mean chance for each of its parts, rate' = rate
 *   + Σ x·(p̄ − p)·(gain + loss) (`attemptRankMoments`' mean is p·gain − (1 − p)·loss), its time its rank over rate'; a
 *   Black Op's span its rebuilds' share at their rate over the re-priced one. A route re-planned under the draws could do
 *   better still (#426). A step whose re-priced rate is 0 or under (the attempts held while the chance falls) takes the
 *   mean path's rate there, counted (`fallbackSteps`).
 */
import { actionRankGain, actionRankLoss, type BladeburnerLevelledAction } from "./bladeburner-actions.ts";
import {
  type BladeburnerDriftCity,
  type BladeburnerDriftState,
  bladeburnerMostFactorCity,
  driftedChance,
} from "./bladeburner-drift.ts";

/** A seeded uniform on [0, 1) (mulberry32): a replay's draws, the same each run. */
export function bladeburnerSeeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `getRandomIntInclusive` (`utils/helpers/getRandomIntInclusive.ts`) on a seeded uniform. */
function intIn(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

/**
 * The replays' seed series at a refresh (#423's ruling 6): a fixed series from the refresh's game time (whole seconds,
 * hashed), so a refresh's figure is reproducible and two refreshes draw apart.
 */
export function bladeburnerReplaySeedOf(gameMs: number): number {
  return Math.imul(Math.floor(gameMs / 1000) >>> 0, 2654435761) >>> 0;
}

/**
 * The replays a refresh makes (#423's ruling 6), computed: the 500-replay figures' standard errors (BN6's best case
 * 0.5 / 68.6 h, bn6-skills' route 1.2 / 91.7 h, BN7's 2.9 / 116.8 h: 0.7–2.5%) at 200 replays are √(500/200) ≈ 1.6
 * times those, 1.2–3.9%, the same order as the figure's own staleness at the 10-min refresh (`BLACK_OPS_GROWN_
 * REFRESH_MS`: the grown figure's move over 10 min less its reading-to-reading jitter, 1.8% in bn7-actions and 3.0% in
 * bn6-skills, #423's ruling 5). More would buy a precision the refresh already loses; fewer would let the sampling
 * outgrow it.
 */
export const BLADEBURNER_ROUTE_REPLAYS = 200;

/**
 * The gate on a refresh's replays (#423's ruling 7): the first-order re-pricing holds only where the route's mix stays
 * workable at the drawn chances. Where it leans on an operation whose drawn chance collapses (Assassination's and
 * Raid's in BN7's keep route: 48 of 200 replays with a step at a rate of 0 or under, the figure 308.0 ± 15.6 h against
 * the mean path's 218.6), holding the mix drives a step's rate to 0 or near it and the figure blows up. So the figure is
 * used only with (a) at most 1% of the replays needing the fallback (ruling 6, item 3) and (b) its relative standard
 * error within the 200 replays' design error, 3.9% (the larger end of `BLADEBURNER_ROUTE_REPLAYS`' derivation above);
 * else the mean path's, labelled. Re-choosing each replay's mix at its drawn chances is #426.
 */
export const BLADEBURNER_REPLAY_MOST_FALLBACK = 0.01;

/**
 * The least re-priced step rate, over the mean path's for that step, the first-order re-pricing is measured at (#423's
 * ruling 8, #389: no unmeasured extrapolation): the engine check (the brain's bladeburner-drift-parity.test.ts, a grown
 * route's opening hour in 10 engine runs, each within 4 sd of the replays) re-prices that route's first step at each
 * run's drawn chances between ×0.9323 and ×1.0895 of its mean path's rate. Below the lowest a step is unmeasured, so a
 * replay with one counts as a fallback (its rate the mean path's there), as one at 0 or under. The check covers
 * nothing lower: the low end is the lowest it covered.
 */
export const BLADEBURNER_REPLAY_LEAST_RATIO = 0.9323;
export const BLADEBURNER_REPLAY_MOST_ERROR = 0.039;

/** The gate's verdict on replays (see above): null, used; else why the mean path's figure is used instead. */
export function bladeburnerReplayDeclined(
  replays: Pick<BladeburnerRouteReplays, "replays" | "replaysWithFallback" | "seconds" | "error">,
): string | null {
  const share = replays.replays > 0 ? replays.replaysWithFallback / replays.replays : 1;
  if (share > BLADEBURNER_REPLAY_MOST_FALLBACK) {
    return `${replays.replaysWithFallback} of ${replays.replays} replays needed the rate's fallback, past 1%`;
  }
  const relative = replays.seconds > 0 && Number.isFinite(replays.seconds) ? replays.error / replays.seconds : Infinity;
  if (!(relative <= BLADEBURNER_REPLAY_MOST_ERROR)) {
    return `the replays' standard error ${(100 * relative).toFixed(1)}%, past the design's 3.9%`;
  }
  return null;
}

/** A share of a population, rounded as `clampInteger` (`utils/helpers/clampNumber.ts`). */
function share(population: number, percent: number): number {
  return Math.round((population * percent) / 100);
}

/** `PopGrowthCeiling`'s +100 (`data/Constants.ts:36-37`) where a city gains under 1.5e9. */
function grown(city: BladeburnerDriftCity): void {
  if (city.population < 1.5e9) city.population += 100;
}

/** A migration from city `from` (`triggerMigration`, `:564-587`): 3–15%, ×2–4 with a community at 5%. */
function migrate(cities: BladeburnerDriftCity[], from: number, random: () => number): void {
  const source = cities[from] as BladeburnerDriftCity;
  let to = Math.floor(random() * (cities.length - 1));
  if (to >= from) to += 1;
  const dest = cities[to] as BladeburnerDriftCity;
  let percentage = intIn(random, 3, 15);
  if (random() < 0.05 && source.communities > 0) {
    percentage *= intIn(random, 2, 4);
    source.communities -= 1;
    dest.communities += 1;
  }
  const count = share(source.population, percentage);
  source.population -= count;
  dest.population += count;
  grown(dest);
}

/**
 * A random event on the six (`randomEvent`, `:601-699`), drawn: 5% a new community (+10–20%), 5% a community's
 * migration (10–20% to another city; a new one where it has none), 20% new Synthoids (+8–24%), 20% a migration, 20% riots
 * (the chaos +1 then +5–20%, `:681-683`), 20% fewer Synthoids (−8–20%), 10% nothing.
 */
export function bladeburnerEventDraw(cities: BladeburnerDriftCity[], random: () => number): void {
  const n = cities.length;
  const chance = random();
  const s = Math.floor(random() * n);
  const city = cities[s] as BladeburnerDriftCity;
  const newCommunity = () => {
    city.communities += 1;
    city.population += share(city.population, intIn(random, 10, 20));
    grown(city);
  };
  if (chance <= 0.05) newCommunity();
  else if (chance <= 0.1) {
    if (city.communities <= 0) newCommunity();
    else {
      let d = Math.floor(random() * (n - 1));
      if (d >= s) d += 1;
      const dest = cities[d] as BladeburnerDriftCity;
      city.communities -= 1;
      dest.communities += 1;
      const count = share(city.population, intIn(random, 10, 20));
      city.population -= count;
      dest.population += count;
      grown(dest);
    }
  } else if (chance <= 0.3) {
    city.population += share(city.population, intIn(random, 8, 24));
    grown(city);
  } else if (chance <= 0.5) migrate(cities, s, random);
  else if (chance <= 0.7) city.chaos = (city.chaos + 1) * (1 + intIn(random, 5, 20) / 100);
  else if (chance <= 0.9) city.population = Math.max(0, city.population - share(city.population, intIn(random, 8, 20)));
}

/** The next event's interval (`:1403-1409`): U(240..600) s. */
export function bladeburnerEventIntervalDraw(random: () => number): number {
  return intIn(random, 240, 600);
}

/**
 * An attempt's effects on city `at`, drawn (`completeOperation`, `:793-866`; `completeContract`, `:868-890`): Raid's
 * −1% and a community on a success, −0.5 to −1% on a failure, the chaos +1–5% (`:832-846`); Sting's −0.1% on a success,
 * the chaos +0.1 (`:823-830`); Stealth Retirement's −0.5% on a success, the chaos −1–3% (`:847-855`); Assassination's −1
 * on a success, the chaos ±5% (`:856-861`); Bounty Hunter's and Retirement's −1 and +0.02/+0.04 on a success
 * (`:879-886`); Investigation's and Undercover's failure a migration at 10% and 15% (`:811`, `:820`, `:589-599`).
 */
export function bladeburnerAttemptDraw(
  cities: BladeburnerDriftCity[],
  at: number,
  action: Pick<BladeburnerLevelledAction, "name">,
  success: boolean,
  random: () => number,
): void {
  const city = cities[at] as BladeburnerDriftCity;
  const change = (percent: number) => {
    let delta = share(city.population, percent);
    if (delta === 0) delta = percent > 0 ? 1 : -1;
    city.population = Math.max(0, city.population + delta);
  };
  switch (action.name) {
    case "Raid":
      if (success) {
        change(-1);
        city.communities -= 1;
      } else change(intIn(random, -10, -5) / 10);
      city.chaos = Math.max(0, city.chaos * (1 + intIn(random, 1, 5) / 100));
      break;
    case "Sting Operation":
      if (success) change(-0.1);
      city.chaos += 0.1;
      break;
    case "Stealth Retirement Operation":
      if (success) change(-0.5);
      city.chaos = Math.max(0, city.chaos * (1 + intIn(random, -3, -1) / 100));
      break;
    case "Assassination":
      if (success) city.population = Math.max(0, city.population - 1);
      city.chaos = Math.max(0, city.chaos * (1 + intIn(random, -5, 5) / 100));
      break;
    case "Bounty Hunter":
    case "Retirement":
      if (success) {
        city.population = Math.max(0, city.population - 1);
        city.chaos += action.name === "Retirement" ? 0.04 : 0.02;
      }
      break;
    case "Investigation":
    case "Undercover Operation":
      if (!success && random() < (action.name === "Investigation" ? 0.1 : 0.15)) migrate(cities, at, random);
      break;
  }
}

/** A part of a route's step: an action at a level, its chance there (the mean path's) and its attempts a second. */
export interface BladeburnerRoutePart {
  action: BladeburnerLevelledAction;
  level: number;
  chance: number;
  perSecond: number;
}

/**
 * A segment of the grown route (./bladeburner-growth.ts), the mean path's: a climb's step (its rank `by` at `rate`
 * over `dt`, its mix's parts priced at the cities `state`); a Black Op's attempts (`span`, the expected rebuilds' mixes
 * back to back from its start); or a stretch at a fixed time (B5's stock to the first one's rank, not a grown route).
 */
export type BladeburnerRouteSegment =
  | {
      kind: "climb";
      seconds: number;
      dt: number;
      by: number;
      rate: number;
      parts: BladeburnerRoutePart[];
      state: BladeburnerDriftState;
    }
  | {
      kind: "blackOp";
      seconds: number;
      span: number;
      works: { dt: number; rate: number; parts: BladeburnerRoutePart[]; state: BladeburnerDriftState }[];
    }
  | { kind: "fixed"; seconds: number; span: number };

/** The grown route's timeline: its start (the cities read), its reference city (the chances read's) and segments. */
export interface BladeburnerRouteTimeline {
  start: BladeburnerDriftState;
  reference: BladeburnerDriftCity;
  rankMultiplier: number;
  segments: BladeburnerRouteSegment[];
}

/** What the replays give (#423): each segment's mean re-priced time, the route's per replay, and the fallbacks. */
export interface BladeburnerRouteReplays {
  /** The re-priced route's mean time and its standard error over the replays. */
  seconds: number;
  error: number;
  /** Each replay's re-priced time (the same seeds on two routes pair them: B7's margin). */
  times: number[];
  /** Each segment's mean re-priced time (the path's and the steps' figures). */
  segmentSeconds: number[];
  replays: number;
  seed: number;
  /** Steps whose re-priced rate fell to 0 or under (the mean path's rate there), and the replays with any. */
  fallbackSteps: number;
  replaysWithFallback: number;
  /** Each replay's least ratio of a step's re-priced rate to its mean path's (before any fallback). */
  leastRatios: number[];
}

/** An attempt of a replay: its time, action, its chance's competence at the reference, and the mean path's cities. */
export interface BladeburnerReplayAttempt {
  at: number;
  action: BladeburnerLevelledAction;
  competence: number;
  /** The mean path's state its chance was priced at: its Diplomacy ceiling (and its chaos, for the probe's). */
  state: BladeburnerDriftState;
}

/**
 * One replay of `attempts` (in time order) from `start`'s cities to `end` (the last attempt's time absent): the events
 * from seed `seed`, the attempts' draws from `seed` + 104729; B4's pick by the true figures (core's
 * `bladeburnerMostFactorCity`), Diplomacy taking it to its ceiling (its time the route's), the chance by core's
 * `driftedChance` there, the attempt's effects. Each attempt's chance drawn, the successes and the cities at the end.
 * `meanChaos` (a probe's): B4 and the chance read each city's chaos as the mean path carries it.
 */
export function bladeburnerReplayAttempts(
  start: BladeburnerDriftState,
  reference: BladeburnerDriftCity,
  attempts: readonly BladeburnerReplayAttempt[],
  { seed, end, meanChaos = false }: { seed: number; end?: number; meanChaos?: boolean },
): { chances: Float64Array; successes: number; cities: BladeburnerDriftCity[] } {
  const events = bladeburnerSeeded(seed);
  const random = bladeburnerSeeded(seed + 104729);
  const cities: BladeburnerDriftCity[] = start.cities.map((city) => ({
    name: city.name,
    population: city.population,
    communities: Math.round(city.communities),
    chaos: city.chaos,
  }));
  let worked = start.worked;
  let decayed = 0;
  let next = bladeburnerEventIntervalDraw(events);
  const pass = (t: number) => {
    // The events, each at its own time, and the decay between (`:1395-1401`), at least 0.
    while (next <= t) {
      for (const city of cities) city.chaos = Math.max(0, city.chaos - 0.0001 * (next - decayed));
      decayed = next;
      bladeburnerEventDraw(cities, events);
      next += bladeburnerEventIntervalDraw(events);
    }
    for (const city of cities) city.chaos = Math.max(0, city.chaos - 0.0001 * (t - decayed));
    decayed = t;
  };
  const chances = new Float64Array(attempts.length);
  let successes = 0;
  for (const [k, attempt] of attempts.entries()) {
    pass(attempt.at);
    const { state } = attempt;
    const seen = meanChaos
      ? cities.map((city, i) => ({ ...city, chaos: (state.cities[i] as BladeburnerDriftCity).chaos }))
      : cities;
    // B4's pick by the true figures, then Diplomacy taking it to its ceiling.
    worked = bladeburnerMostFactorCity(seen, worked, attempt.action.name === "Raid", state.ceiling);
    const city = cities[worked] as BladeburnerDriftCity;
    city.chaos = Math.min(city.chaos, state.ceiling);
    const p = driftedChance(
      { action: attempt.action, chance: attempt.competence },
      reference,
      seen === cities ? city : (seen[worked] as BladeburnerDriftCity),
      state.ceiling,
    );
    chances[k] = p;
    const success = random() < p;
    if (success) successes++;
    bladeburnerAttemptDraw(cities, worked, attempt.action, success, random);
  }
  if (end !== undefined) pass(end);
  return { chances, successes, cities };
}

/**
 * The route replayed `replays` times from the seed series `seed` (replay r's events from seed + 7919·r, its attempts'
 * draws from seed + 7919·r + 104729) and re-priced (see above). Each attempt's chance: its chance's competence at the
 * reference (the mean path's chance over its worked city's factor, core's `driftedChance` at a tiny chance), then core's
 * `driftedChance` in the city B4 picks. `options.meanChaos` (a probe's): each city's chaos the mean path's at the step.
 */
export function bladeburnerReplayRoute(
  timeline: BladeburnerRouteTimeline,
  {
    replays = BLADEBURNER_ROUTE_REPLAYS,
    seed,
    meanChaos = false,
    leastRatio = BLADEBURNER_REPLAY_LEAST_RATIO,
  }: { replays?: number; seed: number; meanChaos?: boolean; leastRatio?: number },
): BladeburnerRouteReplays {
  const { reference, segments } = timeline;
  // Each part's key, its gain + loss, and the attempts in time order (shared by every replay).
  const parts: { part: BladeburnerRoutePart; plus: number }[] = [];
  const at: number[] = [];
  const keys: number[] = [];
  const competence: number[] = [];
  const states: BladeburnerDriftState[] = [];
  const competenceOf = (part: BladeburnerRoutePart, state: BladeburnerDriftState) => {
    const tiny = 1e-6;
    const factor =
      driftedChance(
        { action: part.action, chance: tiny },
        reference,
        state.cities[state.worked] as BladeburnerDriftCity,
        state.ceiling,
      ) / tiny;
    return factor > 0 ? part.chance / factor : 0;
  };
  const schedule = (part: BladeburnerRoutePart, state: BladeburnerDriftState, from: number, dt: number) => {
    const key =
      parts.push({
        part,
        plus:
          actionRankGain(part.action, part.level, timeline.rankMultiplier) + actionRankLoss(part.action, part.level),
      }) - 1;
    const n = Math.round(part.perSecond * dt);
    const c = competenceOf(part, state);
    for (let j = 0; j < n; j++) {
      at.push(from + ((j + 0.5) * dt) / n);
      keys.push(key);
      competence.push(c);
      states.push(state);
    }
  };
  for (const segment of segments) {
    if (segment.kind === "climb")
      for (const part of segment.parts) schedule(part, segment.state, segment.seconds, segment.dt);
    else if (segment.kind === "blackOp") {
      let from = segment.seconds;
      for (const work of segment.works) {
        for (const part of work.parts) schedule(part, work.state, from, work.dt);
        from += work.dt;
      }
    }
  }
  const order = at.map((_, i) => i).sort((a, b) => (at[a] as number) - (at[b] as number));
  const sums = new Float64Array(parts.length);
  const counts = new Float64Array(parts.length);
  const segmentSums = new Float64Array(segments.length);
  const times: number[] = [];
  let fallbackSteps = 0;
  let replaysWithFallback = 0;
  const leastRatios: number[] = [];
  const attempts: BladeburnerReplayAttempt[] = order.map((i) => ({
    at: at[i] as number,
    action: (parts[keys[i] as number] as { part: BladeburnerRoutePart }).part.action,
    competence: competence[i] as number,
    state: states[i] as BladeburnerDriftState,
  }));
  for (let replay = 0; replay < replays; replay++) {
    sums.fill(0);
    counts.fill(0);
    const { chances } = bladeburnerReplayAttempts(timeline.start, reference, attempts, {
      seed: seed + 7919 * replay,
      meanChaos,
    });
    for (const [k, i] of order.entries()) {
      const key = keys[i] as number;
      sums[key] = (sums[key] as number) + (chances[k] as number);
      counts[key] = (counts[key] as number) + 1;
    }
    // The re-pricing at the replay's chances.
    const drawn = (key: number) => {
      const n = counts[key] as number;
      const { part } = parts[key] as { part: BladeburnerRoutePart };
      return n > 0 ? (sums[key] as number) / n : part.chance;
    };
    let key = 0;
    let total = 0;
    let fell = 0;
    let least = Number.POSITIVE_INFINITY;
    const repriced = (rate: number, these: readonly BladeburnerRoutePart[]) => {
      let next = rate;
      for (const part of these) {
        next += part.perSecond * (drawn(key) - part.chance) * (parts[key] as { plus: number }).plus;
        key++;
      }
      if (rate > 0) least = Math.min(least, next / rate);
      if (next > 0 && next >= leastRatio * rate) return next;
      fell++;
      return rate;
    };
    for (const [s, segment] of segments.entries()) {
      let seconds: number;
      if (segment.kind === "climb") seconds = segment.by / repriced(segment.rate, segment.parts);
      else if (segment.kind === "blackOp") {
        seconds = segment.span;
        for (const work of segment.works) seconds += work.dt * (work.rate / repriced(work.rate, work.parts) - 1);
      } else seconds = segment.span;
      segmentSums[s] = (segmentSums[s] as number) + seconds;
      total += seconds;
    }
    fallbackSteps += fell;
    if (fell > 0) replaysWithFallback++;
    times.push(total);
    leastRatios.push(least);
  }
  const mean = times.reduce((sum, x) => sum + x, 0) / Math.max(1, times.length);
  const variance = times.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, times.length - 1);
  return {
    seconds: mean,
    error: Math.sqrt(variance / Math.max(1, times.length)),
    times,
    segmentSeconds: [...segmentSums].map((sum) => sum / Math.max(1, replays)),
    replays,
    seed,
    fallbackSteps,
    replaysWithFallback,
    leastRatios,
  };
}
