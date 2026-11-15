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
import { BLADEBURNER_CONSTANTS, type BladeburnerLevelledAction, chaosDifficultyFactor } from "./bladeburner-actions.ts";

/** One attempt's mean effects on the city it runs in (#418): its chaos, its true population and its communities. */
export interface BladeburnerAttemptDrift {
  /** The chaos after: chaos × `chaosScale` + `chaosAdd` (`City.ts:31-33`, `:89-91`). */
  chaosScale: number;
  chaosAdd: number;
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
  const none = { chaosScale: 1, chaosAdd: 0, populationScale: 1, migrated: 0, communities: 0 };
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
      return { ...none, chaosScale: 1.03, populationScale: p * 0.99 + (1 - p) * (1 - 0.0075), communities: -p };
    case "Stealth Retirement Operation":
      return { ...none, chaosScale: 0.98, populationScale: 1 - 0.005 * p };
    default:
      // Tracking (the estimate only); Assassination's chaos ±5% (0 on average) and its −1.
      return none;
  }
}

/** A city on the drift's path (#418): its population (any unit common to the six), communities and chaos. */
export interface BladeburnerDriftCity {
  name: string;
  population: number;
  communities: number;
  chaos: number;
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

/** The chaos's fall a second, every city's (`Bladeburner.ts:1398`). */
const CHAOS_DECAY = 0.0001;

/**
 * `dt` seconds of the random events' mean (`bladeburnerEventDrift`, the same figures, in place: the path's own, at each
 * chunk) and the decay, each city at least 0.
 */
function applyEvents(cities: BladeburnerDriftCity[], dt: number): void {
  const n = cities.length;
  const rate = dt / BLADEBURNER_EVENT_SECONDS / n;
  let sentPopulation = 0;
  let sentCommunities = 0;
  for (const city of cities) {
    const has = city.communities > 0;
    sentPopulation += city.population * ((has ? 0.05 * 0.15 : 0) + 0.2 * migrationShare(city.communities));
    sentCommunities += has ? 0.05 + 0.2 * 0.05 : 0;
  }
  // Each city's change from the figures before the step, so the order of the six doesn't matter.
  const changes = cities.map((city) => {
    if (n < 2) return { population: 0, communities: 0, chaos: 0 };
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
      chaos: rate * 0.2 * ((city.chaos + 1) * 1.125 - city.chaos),
    };
  });
  for (const [i, city] of cities.entries()) {
    const change = changes[i] as { population: number; communities: number; chaos: number };
    city.population = Math.max(0, city.population + change.population);
    city.communities = Math.max(0, city.communities + change.communities);
    city.chaos = Math.max(0, city.chaos + change.chaos - CHAOS_DECAY * dt);
  }
}

/** Diplomacy's cut of the chaos, in percent (`Bladeburner.ts:737-745`), and its seconds (`data/GeneralActions.ts:39`). */
function diplomacyPercentOf(charisma: number): number {
  return charisma ** 0.045 + charisma / 1e3;
}
const DIPLOMACY_SECONDS = 60;

/** A city's competence factor on every chance there (#418): (pop)^0.7 over the chaos's factor (`Actions/Action.ts:88-103`). */
export function cityChanceFactor(city: Pick<BladeburnerDriftCity, "population" | "chaos">): number {
  return Math.max(0, city.population) ** BLADEBURNER_CONSTANTS.populationExponent / chaosDifficultyFactor(city.chaos);
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

/** The chunks a path is followed in at most: past it, each a share of the attempts (`bladeburnerDriftPath`). */
export const BLADEBURNER_DRIFT_CHUNKS = 64;

/**
 * An action's chance on the path (#418): its chance at `reference` times the worked city's factor over the reference's
 * (`cityChanceFactor`), at most 1; Raid 0 with no communities there.
 */
export function driftedChance(
  part: Pick<BladeburnerDriftPart, "action" | "chance">,
  reference: Pick<BladeburnerDriftCity, "population" | "chaos">,
  city: BladeburnerDriftCity,
): number {
  if (part.action.name === "Raid" && !(city.communities > 0)) return 0;
  const from = cityChanceFactor(reference);
  if (!(from > 0)) return 0;
  return Math.min(1, part.chance * (cityChanceFactor(city) / from));
}

/** What a path did (#418): the state after it, each part's mean chance, and Diplomacy's seconds on it. */
export interface BladeburnerDriftResult {
  state: BladeburnerDriftState;
  /** Each part's mean chance over its attempts (its successes over its attempts); its chance there with none. */
  chances: number[];
  diplomacySeconds: number;
}

/**
 * The mean path of the cities over `seconds` of work (#418): each part's attempts, spread evenly over the time, in the
 * city worked, each moving it by its mean effects at its chance there (`bladeburnerAttemptDrift`), the decay and the
 * random events' mean (`bladeburnerEventDrift`) over the time, and Diplomacy holding the worked city's chaos at the
 * ceiling (its time returned, not taken from `seconds`). `moves`: the brain's city chosen again as the path goes (B4's,
 * the most chance factor), else the city worked throughout. In attempts one at a time to `BLADEBURNER_DRIFT_CHUNKS`,
 * past it in that many chunks, each chunk's attempts at the chance before each, as if linear over the chunk (the
 * success-moved effects, Raid's and the kills', at the chance at the chunk's start).
 */
export function bladeburnerDriftPath(
  start: BladeburnerDriftState,
  reference: Pick<BladeburnerDriftCity, "population" | "chaos">,
  parts: readonly BladeburnerDriftPart[],
  seconds: number,
  { charisma, moves }: { charisma: number; moves: boolean },
): BladeburnerDriftResult {
  const cities = start.cities.map((city) => ({ ...city }));
  let worked = start.worked;
  const most = Math.max(0, ...parts.map((part) => part.attempts));
  const chunks = Math.max(1, Math.min(BLADEBURNER_DRIFT_CHUNKS, Math.ceil(most)));
  const dt = Math.max(0, seconds) / chunks;
  const successes = parts.map(() => 0);
  const keep = 1 - diplomacyPercentOf(charisma) / 100;
  let diplomacySeconds = 0;
  // Raid alone (the rule's own pricing of it): the cities with communities only.
  const raidAlone = parts.length > 0 && parts.every((part) => part.action.name === "Raid");
  for (let chunk = 0; chunk < chunks; chunk++) {
    // Each chance at the chaos held (Diplomacy keeps it at the ceiling between the readings; its time at the chunk's end).
    const held = (city: BladeburnerDriftCity) =>
      city.chaos > start.ceiling ? { ...city, chaos: start.ceiling } : city;
    for (const [index, part] of parts.entries()) {
      const attempts = part.attempts / chunks;
      if (!(attempts > 0)) continue;
      const city = cities[worked] as BladeburnerDriftCity;
      const before = driftedChance(part, reference, held(city));
      const drift = bladeburnerAttemptDrift(part.action, before, city.communities);
      applyAttempts(cities, worked, drift, attempts);
      const after = driftedChance(part, reference, held(cities[worked] as BladeburnerDriftCity));
      // The chunk's attempts each drawn at the chance before it: Σ over j < a of p(j), exact where p is linear in j
      // (the trapezoid and half its fall); one attempt or less, the chance before it.
      const drawn = attempts >= 1 ? (attempts * (before + after)) / 2 + (before - after) / 2 : attempts * before;
      successes[index] = (successes[index] as number) + drawn;
    }
    // The time's own over the chunk: the random events' mean and the decay.
    if (dt > 0) applyEvents(cities, dt);
    // B4's order: the city first (the most chance factor, its chaos as it is), then Diplomacy there, to its ceiling.
    if (moves) worked = mostFactor(cities, worked, raidAlone, start.ceiling);
    const here = cities[worked] as BladeburnerDriftCity;
    if (here.chaos > start.ceiling && keep > 0 && keep < 1) {
      diplomacySeconds += (DIPLOMACY_SECONDS * Math.log(start.ceiling / here.chaos)) / Math.log(keep);
      here.chaos = start.ceiling;
    }
  }
  return {
    state: { cities, worked, ceiling: start.ceiling },
    chances: parts.map((part, index) =>
      part.attempts > 0
        ? (successes[index] as number) / part.attempts
        : driftedChance(part, reference, start.cities[start.worked] as BladeburnerDriftCity),
    ),
    diplomacySeconds,
  };
}

/** `attempts` attempts' mean effects on city `worked` (a migration's population to the other cities, evenly). */
function applyAttempts(
  cities: BladeburnerDriftCity[],
  worked: number,
  drift: BladeburnerAttemptDrift,
  attempts: number,
): void {
  const city = cities[worked] as BladeburnerDriftCity;
  // chaos × s + a, k times: s^k·chaos + a·(s^k − 1)/(s − 1), or + a·k at s 1.
  const scaled = drift.chaosScale ** attempts;
  const added =
    drift.chaosScale === 1 ? drift.chaosAdd * attempts : (drift.chaosAdd * (scaled - 1)) / (drift.chaosScale - 1);
  city.chaos = Math.max(0, city.chaos * scaled + added);
  const kept = drift.populationScale ** attempts;
  const leaving = city.population * kept * (1 - (1 - drift.migrated) ** attempts);
  city.population = Math.max(0, city.population * kept - leaving);
  const others = cities.length - 1;
  if (others > 0 && leaving > 0) {
    for (const [i, other] of cities.entries()) if (i !== worked) other.population += leaving / others;
  }
  const moved = drift.communities * attempts;
  city.communities = Math.max(0, city.communities + moved);
  if (others > 0 && drift.migrated > 0 && moved < 0) {
    for (const [i, other] of cities.entries()) if (i !== worked) other.communities += -moved / others;
  }
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
    raid && !(worked.communities > 0) ? -1 : cityChanceFactor({ ...worked, chaos: Math.min(worked.chaos, ceiling) });
  let best = current;
  let most = kept;
  for (const [i, city] of cities.entries()) {
    if (i === current || (raid && !(city.communities > 0))) continue;
    const factor = cityChanceFactor(city);
    if (factor > most) {
      best = i;
      most = factor;
    }
  }
  return best;
}

/**
 * The drift's start from the cities read (#418): their estimates (B4's: each city's taken as far off its truth as the
 * city worked's, `cityCompetenceRatio`'s convention, so the ratios are the brain's), communities and chaos, the city
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
  const copied = cities.map((each) => ({ ...each }));
  const here = copied[worked] as BladeburnerDriftCity;
  if (chaos !== undefined) here.chaos = chaos;
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
