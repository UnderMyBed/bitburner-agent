// #418: the cities after a suite's window against core's drift (`bladeburnerDriftPath`), from the simulator's true
// figures at its start and its record of the attempts made, and the spread the game's draws leave about that mean:
// each attempt's own draw (`Bladeburner.ts:796-890`) and the random events' jumps (`:601-699`), as a variance.
import {
  BLADEBURNER_EVENT_SECONDS,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerDriftCity,
  type BladeburnerDriftState,
  bladeburnerAttemptDrift,
  bladeburnerDriftPath,
} from "@bitburner-agent/core";
import type { BladeburnerAttempt } from "@bitburner-agent/sim";
import { expect } from "vitest";

/** E[U²] for U uniform over the integers a..b, over 100: its mean's square and its variance ((n² − 1)/12). */
function secondMoment(a: number, b: number): number {
  const n = b - a + 1;
  const mean = (a + b) / 2;
  return (mean * mean + (n * n - 1) / 12) / 1e4;
}

/** A migration's share's second moment (`triggerMigration`): 3–15%, ×2–4 with chance 0.05 where there are communities. */
function migrationSecondMoment(communities: number): number {
  const share = secondMoment(3, 15);
  return communities > 0 ? share * (0.95 + 0.05 * ((4 + 9 + 16) / 3)) : share;
}

/** One attempt's variance about its mean (its own draws), in its city's population and chaos. */
export function attemptVariance(attempt: BladeburnerAttempt): { population: number; chaos: number } {
  const p = attempt.chance;
  const { population: pop, chaos } = attempt;
  const bernoulli = (x: number) => p * (1 - p) * x * x;
  switch (attempt.name) {
    case "Raid": {
      // A success −1%; a failure −(5 to 10)/10 %, each of the six alike; the chaos ×(1 + U{1..5}/100).
      const failure = [5, 6, 7, 8, 9, 10].map((each) => each / 1000);
      const second = p * 0.01 ** 2 + ((1 - p) * failure.reduce((sum, x) => sum + x * x, 0)) / 6;
      const mean = p * 0.01 + ((1 - p) * failure.reduce((sum, x) => sum + x, 0)) / 6;
      return { population: pop * pop * (second - mean * mean), chaos: chaos * chaos * 2e-4 };
    }
    case "Sting Operation":
      return { population: bernoulli(0.001 * pop), chaos: 0 };
    case "Stealth Retirement Operation":
      return { population: bernoulli(0.005 * pop), chaos: chaos * chaos * (2 / 3) * 1e-4 };
    case "Assassination":
      return { population: 0, chaos: chaos * chaos * 10e-4 };
    case "Bounty Hunter":
      return { population: 0, chaos: bernoulli(0.02) };
    case "Retirement":
      return { population: 0, chaos: bernoulli(0.04) };
    case "Investigation":
    case "Undercover Operation": {
      const q = attempt.name === "Investigation" ? 0.1 : 0.15;
      return { population: pop * pop * (1 - p) * q * migrationSecondMoment(attempt.communities), chaos: 0 };
    }
    default:
      return { population: 0, chaos: 0 };
  }
}

/**
 * The random events' variance a second in each city (`randomEvent`, `Bladeburner.ts:601-699`): each event's jump's second
 * moment, as the source with chance 1/6 and a move's destination with 1/30 from each other city, an event each
 * `BLADEBURNER_EVENT_SECONDS` (as a compound Poisson's: the intervals' uniform spread under the Poisson's, so wider).
 */
function eventVariance(cities: readonly BladeburnerDriftCity[]): { population: number; chaos: number }[] {
  const rate = 1 / BLADEBURNER_EVENT_SECONDS;
  return cities.map((city, i) => {
    const asSource =
      (city.population ** 2 *
        (0.05 * secondMoment(10, 20) +
          0.05 * secondMoment(10, 20) +
          0.2 * secondMoment(8, 24) +
          0.2 * migrationSecondMoment(city.communities) +
          0.2 * secondMoment(8, 20))) /
      6;
    const asDestination = cities.reduce(
      (sum, other, j) =>
        j === i
          ? sum
          : sum +
            (other.population ** 2 *
              ((other.communities > 0 ? 0.05 * secondMoment(10, 20) : 0) +
                0.2 * migrationSecondMoment(other.communities))) /
              30,
      0,
    );
    // Riots: (chaos + 1)(1 + U) − chaos = 1 + (chaos + 1)·U, U = U{5..20}/100.
    const riot = 1 + 2 * (city.chaos + 1) * 0.125 + (city.chaos + 1) ** 2 * secondMoment(5, 20);
    return { population: rate * (asSource + asDestination), chaos: (rate * riot) / 30 };
  });
}

/** A city predicted (#418): its mean figures after the window, and the standard deviation about them. */
export interface PredictedCity extends BladeburnerDriftCity {
  populationSpread: number;
  chaosSpread: number;
}

const actionOf = (name: string) => BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name);

/**
 * The cities after a window (#418): core's mean path from `start` (the simulator's true figures at `fromMs`), the time
 * between attempts its own (the decay and the events' mean), each attempt the record's (its city, action and chance),
 * Diplomacy's ceiling the brain's (50, or a chaos read over it); and each city's spread, the attempts' draws' and the
 * events' variances summed over the window.
 */
export function predictCities(
  start: readonly BladeburnerDriftCity[],
  attempts: readonly BladeburnerAttempt[],
  fromMs: number,
  untilMs: number,
  charisma: number,
): PredictedCity[] {
  let state: BladeburnerDriftState = {
    cities: start.map((city) => ({ ...city })),
    worked: 0,
    ceiling: Math.max(50, ...start.map((city) => city.chaos)),
  };
  const variance = start.map(() => ({ population: 0, chaos: 0 }));
  let at = fromMs;
  const pass = (seconds: number) => {
    if (!(seconds > 0)) return;
    const spread = eventVariance(state.cities);
    for (const [i, each] of spread.entries()) {
      const sum = variance[i] as { population: number; chaos: number };
      sum.population += each.population * seconds;
      sum.chaos += each.chaos * seconds;
    }
    const reference = state.cities[state.worked] as BladeburnerDriftCity;
    state = bladeburnerDriftPath(state, reference, [], seconds, { charisma, moves: false }).state;
  };
  for (const attempt of [...attempts].sort((a, b) => a.atMs - b.atMs)) {
    if (attempt.atMs <= fromMs || attempt.atMs > untilMs) continue;
    const action = actionOf(attempt.name);
    pass((attempt.atMs - at) / 1000);
    at = attempt.atMs;
    if (action === undefined) continue;
    const worked = state.cities.findIndex((city) => city.name === attempt.city);
    if (worked < 0) continue;
    state = { ...state, worked };
    const reference = state.cities[worked] as BladeburnerDriftCity;
    state = bladeburnerDriftPath(state, reference, [{ action, chance: attempt.chance, attempts: 1 }], 0, {
      charisma,
      moves: false,
    }).state;
    const own = attemptVariance(attempt);
    const sum = variance[worked] as { population: number; chaos: number };
    sum.population += own.population;
    sum.chaos += own.chaos;
  }
  pass((untilMs - at) / 1000);
  return state.cities.map((city, i) => ({
    ...city,
    populationSpread: Math.sqrt((variance[i] as { population: number }).population),
    chaosSpread: Math.sqrt((variance[i] as { chaos: number }).chaos),
  }));
}

/**
 * The cities at a window's end against `predictCities` (#418), each city's chaos and true population within 4 standard
 * deviations of its prediction (a chance of 6e-5 a figure of a false failure); and the attempts' own effects on their
 * cities' population (each attempt's city just after it, the simulator's record) against core's mean at each one's
 * chance, within 4 standard deviations of their draws. Returns the lines printed.
 */
export function expectCitiesAsPredicted(
  start: readonly BladeburnerDriftCity[],
  end: readonly BladeburnerDriftCity[],
  attempts: readonly BladeburnerAttempt[],
  fromMs: number,
  untilMs: number,
  charisma: number,
): string {
  const predicted = predictCities(start, attempts, fromMs, untilMs, charisma);
  const rows: string[] = [];
  for (const city of end) {
    const at = predicted.find((each) => each.name === city.name) as PredictedCity;
    const was = start.find((each) => each.name === city.name) as BladeburnerDriftCity;
    rows.push(
      `${city.name}: the chaos ${was.chaos.toFixed(2)} → ${city.chaos.toFixed(2)} (predicted ${at.chaos.toFixed(2)} ± ` +
        `${(4 * at.chaosSpread).toFixed(2)}); the population ${(was.population / 1e6).toFixed(1)}m → ` +
        `${(city.population / 1e6).toFixed(1)}m (predicted ${(at.population / 1e6).toFixed(1)}m ± ` +
        `${((4 * at.populationSpread) / 1e6).toFixed(1)}m)`,
    );
    expect(Math.abs(city.chaos - at.chaos), `${city.name}'s chaos`).toBeLessThanOrEqual(4 * at.chaosSpread + 1e-6);
    expect(Math.abs(city.population - at.population), `${city.name}'s population`).toBeLessThanOrEqual(
      4 * at.populationSpread + 1,
    );
  }
  // The attempts' own: each one's population change against its mean, their variances summed.
  let observed = 0;
  let mean = 0;
  let variance = 0;
  let counted = 0;
  for (const attempt of attempts) {
    if (attempt.atMs <= fromMs || attempt.atMs > untilMs) continue;
    const action = actionOf(attempt.name);
    if (action === undefined) continue;
    counted += 1;
    observed += attempt.after.population - attempt.population;
    mean +=
      attempt.population * (bladeburnerAttemptDrift(action, attempt.chance, attempt.communities).populationScale - 1);
    variance += attemptVariance(attempt).population;
  }
  const spread = Math.sqrt(variance);
  rows.push(
    `the ${counted} attempts' own effect on their cities' population: ${(observed / 1e6).toFixed(2)}m against core's ` +
      `mean ${(mean / 1e6).toFixed(2)}m ± ${((4 * spread) / 1e6).toFixed(2)}m`,
  );
  // Within the draws' spread, and each draw's rounding to a whole Synthoid (`clampInteger`), a half each.
  expect(Math.abs(observed - mean), "the attempts' own effect").toBeLessThanOrEqual(4 * spread + counted);
  return rows.join("\n");
}
