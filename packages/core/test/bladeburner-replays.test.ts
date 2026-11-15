// Bladeburner #423: the grown route's replays under the game's draws. The draws checked against the pinned game's
// source and against core's own means (the drift's mean path, ./bladeburner-drift.ts, tested against seeded walks and
// the engine); a replay's independence and its seeds; the gate (#423's ruling 7) by hand; the 200 replays' derivation.
// The routes' figures (the playability, B7's comparison) are core's bladeburner-growth.test.ts's; the replay against
// the full simulator over a route's opening hour is the brain's bladeburner-drift-parity.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionRankGain,
  actionRankLoss,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerLevelledAction,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_EVENT_SECONDS,
  type BladeburnerDriftCity,
  type BladeburnerDriftState,
  bladeburnerAttemptDrift,
  bladeburnerEventDrift,
} from "../src/bladeburner-drift.ts";
import {
  BLADEBURNER_REPLAY_LEAST_RATIO,
  BLADEBURNER_REPLAY_MOST_ERROR,
  BLADEBURNER_REPLAY_MOST_FALLBACK,
  BLADEBURNER_REPLAY_MOST_RATIO,
  BLADEBURNER_ROUTE_REPLAYS,
  bladeburnerAttemptDraw,
  bladeburnerEventDraw,
  bladeburnerEventIntervalDraw,
  bladeburnerReplayAttempts,
  bladeburnerReplayDeclined,
  bladeburnerReplayRoute,
  bladeburnerReplaySeedOf,
  bladeburnerSeeded,
} from "../src/bladeburner-replays.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");
const action = (name: string) =>
  BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name) as BladeburnerLevelledAction;

const SIX: BladeburnerDriftCity[] = [
  { name: "Aevum", population: 1.4e9, communities: 30, chaos: 0 },
  { name: "Chongqing", population: 0.9e9, communities: 0, chaos: 20 },
  { name: "Sector-12", population: 1.1e9, communities: 50, chaos: 55 },
  { name: "New Tokyo", population: 1.25e9, communities: 12, chaos: 80 },
  { name: "Ishima", population: 1.6e9, communities: 7, chaos: 49.5 },
  { name: "Volhaven", population: 1.05e9, communities: 90, chaos: 51 },
];

describe("the replays' draws (#423): the game's own", () => {
  test("the events, the decay and each attempt's effects, as the source has them", () => {
    const source = gameSource("Bladeburner/Bladeburner.ts");
    for (const line of [
      // `randomEvent`'s kinds and draws (`:601-699`), its interval (`:1403-1409`), the decay (`:1395-1401`).
      "if (chance <= 0.05) {",
      "const percentage = getRandomIntInclusive(8, 24) / 100;",
      "sourceCity.changeChaosByCount(1);",
      "sourceCity.changeChaosByPercentage(getRandomIntInclusive(5, 20));",
      "const percentage = getRandomIntInclusive(8, 20) / 100;",
      "let percentage = getRandomIntInclusive(3, 15) / 100;",
      "percentage *= getRandomIntInclusive(2, 4);",
      "this.randomEventCounter += getRandomIntInclusive(240, 600);",
      "city.chaos -= 0.0001 * seconds;",
      // The attempts' (`:793-890`).
      "city.changeChaosByPercentage(getRandomIntInclusive(1, 5));",
      "const change = getRandomIntInclusive(-10, -5) / 10;",
      "city.changeChaosByPercentage(getRandomIntInclusive(-3, -1));",
      "city.changeChaosByPercentage(getRandomIntInclusive(-5, 5));",
      "city.changeChaosByCount(0.1);",
      "city.changeChaosByCount(0.02);",
      "city.changeChaosByCount(0.04);",
    ]) {
      expect(source, line).toContain(line);
    }
    const constants = gameSource("Bladeburner/data/Constants.ts");
    expect(constants).toContain("BasePopGrowth: 100,");
    expect(constants).toContain("PopGrowthCeiling: 1.5e9,");
    // The interval's draw: 240 to 600 inclusive.
    const random = bladeburnerSeeded(7);
    const intervals = Array.from({ length: 20_000 }, () => bladeburnerEventIntervalDraw(random));
    expect(Math.min(...intervals)).toBe(240);
    expect(Math.max(...intervals)).toBe(600);
  });

  test("an event's draws against the drift's mean an event, each city (the +100s a part in 10⁷ of it)", () => {
    const mean = bladeburnerEventDrift(SIX).map((each) => ({
      population: each.population * BLADEBURNER_EVENT_SECONDS,
      chaos: each.chaos * BLADEBURNER_EVENT_SECONDS,
      communities: each.communities * BLADEBURNER_EVENT_SECONDS,
    }));
    const random = bladeburnerSeeded(4231);
    const events = 300_000;
    const sums = SIX.map(() => ({ population: 0, square: 0, chaos: 0, communities: 0 }));
    for (let n = 0; n < events; n++) {
      const cities = SIX.map((each) => ({ ...each }));
      bladeburnerEventDraw(cities, random);
      for (const [i, city] of cities.entries()) {
        const was = SIX[i] as BladeburnerDriftCity;
        const sum = sums[i] as (typeof sums)[number];
        const change = city.population - was.population;
        sum.population += change;
        sum.square += change * change;
        sum.chaos += city.chaos - was.chaos;
        sum.communities += city.communities - was.communities;
      }
    }
    for (const [i, city] of SIX.entries()) {
      const sum = sums[i] as (typeof sums)[number];
      const expected = mean[i] as (typeof mean)[number];
      const populationMean = sum.population / events;
      const error = Math.sqrt((sum.square / events - populationMean ** 2) / events);
      expect(Math.abs(populationMean - expected.population), city.name).toBeLessThan(4 * error + 100);
      expect(sum.chaos / events, city.name).toBeCloseTo(expected.chaos, 2);
      expect(sum.communities / events, city.name).toBeCloseTo(expected.communities, 2);
    }
  });

  test("each attempt's draws against the drift's mean an attempt (`bladeburnerAttemptDrift`) at a chance of 0.3", () => {
    const p = 0.3;
    const n = 40_000;
    for (const name of [
      "Raid",
      "Sting Operation",
      "Stealth Retirement Operation",
      "Assassination",
      "Bounty Hunter",
      "Retirement",
      "Investigation",
      "Undercover Operation",
    ]) {
      const each = action(name);
      const mean = bladeburnerAttemptDrift(each, p, 50);
      const random = bladeburnerSeeded(4232);
      let population = 0;
      let square = 0;
      let chaos = 0;
      let chaosSquare = 0;
      for (let k = 0; k < n; k++) {
        const cities = SIX.map((city) => ({ ...city, population: 1e9, communities: 50, chaos: 40 }));
        bladeburnerAttemptDraw(cities, 0, each, random() < p, random);
        const city = cities[0] as BladeburnerDriftCity;
        const ratio = city.population / 1e9;
        population += ratio;
        square += ratio * ratio;
        chaos += city.chaos;
        chaosSquare += city.chaos * city.chaos;
      }
      const popMean = population / n;
      const popError = Math.sqrt(Math.max(0, square / n - popMean ** 2) / n);
      const chaosMean = chaos / n;
      const chaosError = Math.sqrt(Math.max(0, chaosSquare / n - chaosMean ** 2) / n);
      // The drift's mean: the population × populationScale, less a migration's share; the chaos × scale + add (its
      // ±1 counts, a kill's, about 10⁻⁹ of a city at 1e9, left out there: within the draws' rounding here).
      const expectedPopulation = mean.populationScale * (1 - mean.migrated);
      expect(Math.abs(popMean - expectedPopulation), name).toBeLessThanOrEqual(4 * popError + 2e-9);
      expect(Math.abs(chaosMean - (40 * mean.chaosScale + mean.chaosAdd)), name).toBeLessThanOrEqual(
        4 * chaosError + 1e-9,
      );
    }
  });
});

describe("a replay (#423): its own cities, its seeds", () => {
  const start: BladeburnerDriftState = { cities: SIX.map((city) => ({ ...city })), worked: 0, ceiling: 50 };
  const reference = SIX[0] as BladeburnerDriftCity;
  const attempts = Array.from({ length: 200 }, (_, k) => ({
    at: 60 + 90 * k,
    action: action(k % 3 === 0 ? "Raid" : "Bounty Hunter"),
    competence: k % 3 === 0 ? 0.08 : 0.4,
    state: start,
  }));

  test("the same seed the same replay, whatever ran before (no drain shared); another seed another", () => {
    const once = bladeburnerReplayAttempts(start, reference, attempts, { seed: 11, end: 20_000 });
    for (let k = 0; k < 3; k++) bladeburnerReplayAttempts(start, reference, attempts, { seed: 100 + k, end: 20_000 });
    const again = bladeburnerReplayAttempts(start, reference, attempts, { seed: 11, end: 20_000 });
    expect([...again.chances]).toEqual([...once.chances]);
    expect(again.cities).toEqual(once.cities);
    // The start untouched.
    expect(start.cities).toEqual(SIX);
    const other = bladeburnerReplayAttempts(start, reference, attempts, { seed: 12, end: 20_000 });
    expect(other.cities).not.toEqual(once.cities);
  });

  test("the seed series from the refresh's game time: whole seconds, apart each refresh", () => {
    const at = Date.UTC(2026, 0, 1, 0, 10);
    expect(bladeburnerReplaySeedOf(at)).toBe(bladeburnerReplaySeedOf(at + 999));
    expect(bladeburnerReplaySeedOf(at)).not.toBe(bladeburnerReplaySeedOf(at + 600_000));
    expect(Number.isInteger(bladeburnerReplaySeedOf(at))).toBe(true);
    expect(bladeburnerReplaySeedOf(at)).toBeGreaterThanOrEqual(0);
  });
});

describe("the gate (#423's ruling 7) and the 200 replays' derivation", () => {
  test("used only with at most 1% of the replays at the fallback and the error within 3.9%", () => {
    const replays = { replays: 200, replaysWithFallback: 0, seconds: 100 * 3600, error: 1 * 3600 };
    expect(bladeburnerReplayDeclined(replays)).toBeNull();
    // 2 of 200 is 1%: used; 3 is past it.
    expect(bladeburnerReplayDeclined({ ...replays, replaysWithFallback: 2 })).toBeNull();
    expect(bladeburnerReplayDeclined({ ...replays, replaysWithFallback: 3 })).toBe(
      "3 of 200 replays needed the rate's fallback, past 1%",
    );
    // The error: 3.89% used, 3.91% declined.
    expect(bladeburnerReplayDeclined({ ...replays, error: 0.0389 * replays.seconds })).toBeNull();
    expect(bladeburnerReplayDeclined({ ...replays, error: 0.0391 * replays.seconds })).toBe(
      "the replays' standard error 3.9%, past the design's 3.9%",
    );
    expect(BLADEBURNER_REPLAY_MOST_FALLBACK).toBe(0.01);
  });

  test("200 replays: the 500-replay figures' errors at 200 the same order as the 10-min staleness; the bound their top", () => {
    // #423's rulings 4 and 5: the 500-replay walks' standard errors (BN6's best case 0.5 / 68.6 h, bn6-skills' route
    // 1.2 / 91.7 h, BN7's 2.9 / 116.8 h) and the grown figure's staleness at 10 min (1.8% bn7-actions, 3.0% bn6-skills).
    const at500 = [0.5 / 68.6, 1.2 / 91.7, 2.9 / 116.8];
    const at200 = at500.map((share) => share * Math.sqrt(500 / BLADEBURNER_ROUTE_REPLAYS));
    const staleness = [0.018, 0.03];
    expect(BLADEBURNER_ROUTE_REPLAYS).toBe(200);
    // The same order: the largest within ×2.5 of the staleness either way.
    expect(Math.max(...at200)).toBeLessThan(2.5 * Math.max(...staleness));
    expect(Math.max(...at200)).toBeGreaterThan(Math.max(...staleness) / 2.5);
    // The gate's bound is the largest of them (3.9%).
    expect(BLADEBURNER_REPLAY_MOST_ERROR).toBeCloseTo(Math.max(...at200), 3);
  });
});

describe("the ratios measured (#423's rulings 10 and 11): a climb step outside them a fallback, at the mean path's rate", () => {
  // The least and the most ratio of the 3,701 engine comparisons (the research's r9-sorted.txt), exact.
  test("the bounds the least and the most ratio measured", () => {
    expect(BLADEBURNER_REPLAY_LEAST_RATIO).toBe(0.08342624096023106);
    expect(BLADEBURNER_REPLAY_MOST_RATIO).toBe(6.600987476314665);
  });

  test("a replay's step just under the least counts; just over it doesn't", () => {
    const start: BladeburnerDriftState = { cities: SIX.map((city) => ({ ...city })), worked: 0, ceiling: 50 };
    const rate = 0.05;
    const dt = 3600;
    const timeline = {
      start,
      reference: SIX[0] as BladeburnerDriftCity,
      rankMultiplier: 1,
      segments: [
        {
          kind: "climb" as const,
          seconds: 0,
          dt,
          by: rate * dt,
          rate,
          parts: [{ action: action("Raid"), level: 1, chance: 0.3, perSecond: 0.004 }],
          state: start,
        },
      ],
    };
    // The replays with no bound (only a rate at 0 or under): each replay's one step and its ratio.
    const free = bladeburnerReplayRoute(timeline, { replays: 20, seed: 4233, leastRatio: 0 });
    const ratio = free.leastRatios[0] as number;
    expect(ratio).toBeGreaterThan(0);
    // Just under it: that replay's step counts, its time the mean path's; just over: re-priced as before.
    const under = bladeburnerReplayRoute(timeline, { replays: 20, seed: 4233, leastRatio: ratio * (1 + 1e-9) });
    const over = bladeburnerReplayRoute(timeline, { replays: 20, seed: 4233, leastRatio: ratio * (1 - 1e-9) });
    expect(under.times[0]).toBeCloseTo(dt, 6);
    expect(over.times[0]).toBeCloseTo(free.times[0] as number, 9);
    expect(under.fallbackSteps).toBeGreaterThan(over.fallbackSteps);
    expect(under.replaysWithFallback).toBeGreaterThanOrEqual(1);
  });
});

describe("the most ratio, Raid with no community, the Black Ops' rebuilds (#423's ruling 11)", () => {
  const start: BladeburnerDriftState = { cities: SIX.map((city) => ({ ...city })), worked: 0, ceiling: 50 };
  const reference = SIX[0] as BladeburnerDriftCity;
  const rate = 0.05;
  const dt = 3600;
  const raid = { action: action("Raid"), level: 1, chance: 0.3, perSecond: 0.004 };
  const climb = (state: BladeburnerDriftState) => ({
    kind: "climb" as const,
    seconds: 0,
    dt,
    by: rate * dt,
    rate,
    parts: [raid],
    state,
  });

  test("a replay's climb step just over the most ratio counts; just under it doesn't", () => {
    const timeline = { start, reference, rankMultiplier: 1, segments: [climb(start)] };
    const free = bladeburnerReplayRoute(timeline, {
      replays: 20,
      seed: 4233,
      leastRatio: 0,
      mostRatio: Number.POSITIVE_INFINITY,
    });
    // One step a replay: its least ratio is its ratio.
    const ratio = free.leastRatios[0] as number;
    const at = (mostRatio: number) =>
      bladeburnerReplayRoute(timeline, { replays: 20, seed: 4233, leastRatio: 0, mostRatio });
    const under = at(ratio * (1 - 1e-9));
    const over = at(ratio * (1 + 1e-9));
    expect(under.times[0]).toBeCloseTo(dt, 6);
    expect(over.times[0]).toBeCloseTo(free.times[0] as number, 9);
    expect(under.fallbackSteps).toBeGreaterThan(over.fallbackSteps);
  });

  test("Raid with no community in any city: no attempt, none of its effects; re-priced as gaining and losing nothing", () => {
    // The game's availability: no Synthoid communities in the current city, the Raid an error.
    expect(gameSource("Bladeburner/data/Operations.ts")).toContain(
      'if (bladeburner.getCurrentCity().comms < 1) return { error: "No Synthoid communities in current city" };',
    );
    const none: BladeburnerDriftState = {
      cities: SIX.map((city) => ({ ...city, communities: 0 })),
      worked: 0,
      ceiling: 50,
    };
    // All before the first event (U(240..600) s; an event can found a community).
    const raids = Array.from({ length: 50 }, (_, k) => ({
      at: 1 + 4 * k,
      action: raid.action,
      competence: 0.3,
      state: none,
    }));
    const raided = bladeburnerReplayAttempts(none, reference, raids, { seed: 5, end: 230 });
    const idle = bladeburnerReplayAttempts(none, reference, [], { seed: 5, end: 230 });
    expect([...raided.skipped]).toEqual(raids.map(() => 1));
    expect(raided.successes).toBe(0);
    // The decay alone (passed in pieces, so to rounding).
    for (const [i, city] of raided.cities.entries()) {
      const alone = idle.cities[i] as BladeburnerDriftCity;
      expect({ ...city, chaos: 0 }).toEqual({ ...alone, chaos: 0 });
      expect(city.chaos).toBeCloseTo(alone.chaos, 9);
    }
    // With communities the Raids are made, and move their cities.
    const made = bladeburnerReplayAttempts(start, reference, raids, { seed: 5, end: 230 });
    expect([...made.skipped].every((x) => x === 0)).toBe(true);
    expect(made.cities).not.toEqual(bladeburnerReplayAttempts(start, reference, [], { seed: 5, end: 230 }).cities);
    // The re-pricing: each skipped attempt at the chance where p·gain = (1 − p)·loss, its expected rank 0.
    const gain = actionRankGain(raid.action, raid.level, 1);
    const loss = actionRankLoss(raid.action, raid.level);
    // A climb of 200 s (before the first event), 10 Raids, at a rate its re-pricing keeps over 0.
    const part = { ...raid, perSecond: 0.05 };
    const climbRate = 2 * part.perSecond * (gain + loss);
    const expected = climbRate + part.perSecond * (loss / (gain + loss) - part.chance) * (gain + loss);
    const short = { ...climb(none), dt: 200, by: climbRate * 200, rate: climbRate, parts: [part] };
    const timeline = { start: none, reference, rankMultiplier: 1, segments: [short] };
    const replayed = bladeburnerReplayRoute(timeline, {
      replays: 3,
      seed: 4233,
      leastRatio: 0,
      mostRatio: Number.POSITIVE_INFINITY,
    });
    expect(replayed.fallbackSteps).toBe(0);
    for (const time of replayed.times) expect(time).toBeCloseTo((climbRate * 200) / expected, 6);
  });

  test("a Black Op's rebuilds at the mean path's rate in every replay, labelled; their attempts still move the cities", () => {
    const blackOp = {
      kind: "blackOp" as const,
      seconds: dt,
      span: 1234,
      works: [{ dt: 600, rate, parts: [raid], state: start }],
    };
    const after = { ...climb(start), seconds: dt + 1234 };
    const timeline = { start, reference, rankMultiplier: 1, segments: [climb(start), blackOp, after] };
    const replayed = bladeburnerReplayRoute(timeline, { replays: 20, seed: 4233 });
    expect(replayed.meanPathRebuilds).toBe(1);
    expect(replayed.segmentSeconds[1]).toBe(1234);
    // Against the same route with a fixed span in its place: the climb before it the same; the climb after it moved,
    // the rebuilds' Raids having moved the cities and taken draws.
    const without = bladeburnerReplayRoute(
      {
        start,
        reference,
        rankMultiplier: 1,
        segments: [climb(start), { kind: "fixed", seconds: dt, span: 1234 }, after],
      },
      { replays: 20, seed: 4233 },
    );
    expect(without.meanPathRebuilds).toBe(0);
    expect(replayed.segmentSeconds[0]).toBe(without.segmentSeconds[0]);
    expect(replayed.segmentSeconds[2]).not.toBe(without.segmentSeconds[2]);
  });
});
