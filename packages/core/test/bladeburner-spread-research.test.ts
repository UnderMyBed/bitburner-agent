// #423 research instruments (temporary, not for merge): B4's pick among the six cities' spread. Measures, at check 3's
// reading, the drift's priced chance of B4's pick against walks of the game's own draws, and options 1 and 3 against
// the walks. Ruling 1 on #423: measure both, then stop. Knobs: R423_WALKS (path-scenario walks), R423_MC (option 3's
// walks), R423_PLAN (check 3's walks), R423_REPS (option 3's replicates), R423_UNCAP=1 (option 3's B4 sees each
// city's chaos as drawn; off, every chaos at most 50). Runs reported on #423 used 1000/1000/1200/5.
/* eslint-disable */
import { describe, expect, test, vi } from "vitest";

vi.mock("../src/bladeburner-drift.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/bladeburner-drift.ts")>();
  return {
    ...original,
    bladeburnerDriftPath: (...args: Parameters<typeof original.bladeburnerDriftPath>) => {
      const result = original.bladeburnerDriftPath(...args);
      const g = globalThis as unknown as { __calls?: unknown[] };
      g.__calls?.push({ args, result });
      return result;
    },
  };
});

import { COMBAT_STATS, type CombatPerson, skillExpFor, skillLevelOf } from "../src/bladeburner.ts";
import {
  actionRankGain,
  actionRankLoss,
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerLevelledAction,
  type BladeburnerPerson,
  bladeburnerPlansToTarget,
  bladeburnerTailMix,
  chooseBladeburnerAction,
  countGrowthPerSecond,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import { chaosDifficultyFactor } from "../src/bladeburner-constants.ts";
import type { BladeburnerDriftCity } from "../src/bladeburner-drift.ts";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const intIn = (random: () => number, min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const action = (name: string) =>
  BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name) as BladeburnerLevelledAction;
const SF1_3 = 1.28;
function combatOf(combat: number): CombatPerson {
  const each = (value: number) => Object.fromEntries(COMBAT_STATS.map((stat) => [stat, value]));
  return {
    skills: each(combat),
    exp: each(skillExpFor(combat, SF1_3)),
    mults: Object.fromEntries(
      COMBAT_STATS.flatMap((stat) => [
        [stat, SF1_3],
        [`${stat}_exp`, SF1_3],
      ]),
    ),
  } as CombatPerson;
}
function personOf(combat: CombatPerson): BladeburnerPerson {
  const skills = { hacking: 100, charisma: 50, intelligence: 0 } as BladeburnerPerson["skills"];
  for (const stat of COMBAT_STATS) skills[stat] = skillLevelOf(combat.exp[stat], SF1_3);
  return { skills, mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 } };
}
const SIX: BladeburnerDriftCity[] = [
  { name: "Aevum", population: 1.1e9, communities: 60, chaos: 0 },
  { name: "Chongqing", population: 1.0e9, communities: 60, chaos: 0 },
  { name: "Sector-12", population: 0.675e9, communities: 60, chaos: 0 },
  { name: "New Tokyo", population: 1.685e9, communities: 60, chaos: 19.8 },
  { name: "Ishima", population: 1.2e9, communities: 60, chaos: 0 },
  { name: "Volhaven", population: 1.3e9, communities: 60, chaos: 0 },
];
const HOME = 3;
function readAt(who: BladeburnerPerson, count = 20) {
  const here = SIX[HOME] as BladeburnerDriftCity;
  const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((each) => {
    const chance = actionSuccessChance(each, 1, who, { city: here, penalty: 1 });
    return { type: each.type, name: each.name, level: 1, maxLevel: 1, count, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(who, 0);
  return { readings, person: who, stamina: maxStamina, maxStamina, rankMultiplier: 1, speed: 1, skills: { read: {} } };
}
function meanOf(xs: readonly number[]): { mean: number; error: number } {
  const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const variance = xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1);
  return { mean, error: Math.sqrt(variance / xs.length) };
}
const factorOf = (pop: number, chaos: number) => Math.max(0, pop) ** 0.7 / chaosDifficultyFactor(chaos);
const MAXE_AT_MEAN_POP = true;
const REF = factorOf((SIX[HOME] as BladeburnerDriftCity).population, (SIX[HOME] as BladeburnerDriftCity).chaos);

/** The game's events (`randomEvent`, `Bladeburner.ts:601-699`) on the six, as check 3's walks draw them. */
function eventsOn(pops: number[], comms: number[], chaos: number[], events: () => number) {
  const other = (s: number) => {
    const d = Math.floor(events() * 5);
    return d >= s ? d + 1 : d;
  };
  const migrate = (s: number, to: number, share: number) => {
    const count = Math.round((pops[s] as number) * share);
    pops[s] = (pops[s] as number) - count;
    pops[to] = (pops[to] as number) + count;
  };
  const grow = (s: number, share: number) => {
    pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * share);
  };
  const kind = events();
  const s = Math.floor(events() * 6);
  if (kind <= 0.05) {
    comms[s] = (comms[s] as number) + 1;
    grow(s, intIn(events, 10, 20) / 100);
  } else if (kind <= 0.1) {
    if ((comms[s] as number) <= 0) {
      comms[s] = 1;
      grow(s, intIn(events, 10, 20) / 100);
    } else {
      const d = other(s);
      comms[s] = (comms[s] as number) - 1;
      comms[d] = (comms[d] as number) + 1;
      migrate(s, d, intIn(events, 10, 20) / 100);
    }
  } else if (kind <= 0.3) grow(s, intIn(events, 8, 24) / 100);
  else if (kind <= 0.5) {
    const to = other(s);
    let share = intIn(events, 3, 15) / 100;
    if (events() < 0.05 && (comms[s] as number) > 0) {
      share *= intIn(events, 2, 4);
      comms[s] = (comms[s] as number) - 1;
      comms[to] = (comms[to] as number) + 1;
    }
    migrate(s, to, share);
  } else if (kind <= 0.7) chaos[s] = ((chaos[s] as number) + 1) * (1 + intIn(events, 5, 20) / 100);
  else if (kind <= 0.9) grow(s, -intIn(events, 8, 20) / 100);
}

/** An attempt's effects on city `city` as `completeOperation`/`completeContract` draw them (check 3's walks'). */
function attemptOn(
  name: string,
  success: boolean,
  city: number,
  pops: number[],
  comms: number[],
  chaos: number[],
  random: () => number,
) {
  const grow = (share: number) => {
    pops[city] = (pops[city] as number) + Math.round((pops[city] as number) * share);
  };
  switch (name) {
    case "Raid":
      if (success) {
        grow(-0.01);
        comms[city] = (comms[city] as number) - 1;
      } else grow(intIn(random, -10, -5) / 1000);
      chaos[city] = (chaos[city] as number) * (1 + intIn(random, 1, 5) / 100);
      break;
    case "Bounty Hunter":
    case "Retirement":
      if (success) {
        pops[city] = (pops[city] as number) - 1;
        chaos[city] = (chaos[city] as number) + (name === "Retirement" ? 0.04 : 0.02);
      }
      break;
    case "Investigation":
    case "Undercover Operation":
      if (!success && random() < (name === "Investigation" ? 0.1 : 0.15)) {
        let to = Math.floor(random() * 5);
        if (to >= city) to += 1;
        let share = intIn(random, 3, 15) / 100;
        if (random() < 0.05 && (comms[city] as number) > 0) {
          share *= intIn(random, 2, 4);
          comms[city] = (comms[city] as number) - 1;
          comms[to] = (comms[to] as number) + 1;
        }
        const count = Math.round((pops[city] as number) * share);
        pops[city] = (pops[city] as number) - count;
        pops[to] = (pops[to] as number) + count;
      }
      break;
    case "Sting Operation":
      if (success) grow(-0.001);
      chaos[city] = (chaos[city] as number) + 0.1;
      break;
    case "Stealth Retirement Operation":
      if (success) grow(-0.005);
      chaos[city] = (chaos[city] as number) * (1 + intIn(random, -3, -1) / 100);
      break;
  }
  if ((chaos[city] as number) > 50) chaos[city] = 50;
}

/** B4's city: the most true factor (Raid's among those with communities); -1 for Raid with none. */
function pick(raid: boolean, pops: number[], comms: number[], chaos: number[]): number {
  let city = -1;
  for (const i of pops.keys()) {
    if (raid && !((comms[i] as number) > 0)) continue;
    if (city < 0 || factorOf(pops[i] as number, chaos[i] as number) > factorOf(pops[city] as number, chaos[city] as number))
      city = i;
  }
  return city;
}

/** A scenario as the rule's path prices it: an action's attempts in pieces (each `attempts` evenly over `seconds`). */
interface Scenario {
  name: string;
  chanceRead: number;
  pieces: { attempts: number; seconds: number; curve: { attempts: number[]; successes: number[] } }[];
  priced: number;
  kind: string;
}

/** Each scenario's attempt times and weights, as the path spreads them (its chunks' middles, attempts evenly). */
function scheduleOf(scenario: Scenario): { t: number; w: number }[] {
  const out: { t: number; w: number }[] = [];
  let offset = 0;
  for (const piece of scenario.pieces) {
    const n = piece.attempts;
    const whole = Math.floor(n);
    for (let j = 0; j < whole; j++) out.push({ t: offset + ((j + 0.5) * piece.seconds) / n, w: 1 });
    if (n - whole > 1e-9) out.push({ t: offset + ((whole + 0.5 * (n - whole)) * piece.seconds) / n, w: n - whole });
    offset += piece.seconds;
  }
  return out;
}

/**
 * Walks of the path's own scenario under the game's draws: the same attempts at the same times, the events and the
 * decay, B4's pick by the true figure before each attempt, Diplomacy to 50 (its time not taken, as the path's). Each
 * walk's mean chance drawn; and at `samples` attempts, each city's chance there (for the independence's measure).
 */
function walkScenario(scenario: Scenario, horizon: number, walks: number, seed: number, samples = 64) {
  const schedule = scheduleOf(scenario);
  const raid = scenario.name === "Raid";
  const every = Math.max(1, Math.floor(schedule.length / samples));
  const sampled = schedule.map((_, j) => j).filter((j) => j % every === 0);
  const columns = sampled.map(() => new Float64Array(walks * 6));
  const chances: number[] = [];
  const c = scenario.chanceRead;
  for (let walk = 0; walk < walks; walk++) {
    const events = seeded(seed + 7919 * walk);
    const random = seeded(seed + 7919 * walk + 104729);
    const pops = SIX.map((city) => city.population);
    const comms = SIX.map((city) => city.communities);
    const chaos = SIX.map((city) => city.chaos);
    let decayed = 0;
    let next = intIn(events, 240, 600);
    const decayTo = (t: number) => {
      for (const i of chaos.keys()) chaos[i] = Math.max(0, (chaos[i] as number) - 0.0001 * (t - decayed));
      decayed = t;
    };
    const pass = (t: number) => {
      while (next <= t) {
        decayTo(next);
        eventsOn(pops, comms, chaos, events);
        next += intIn(events, 240, 600);
      }
      decayTo(t);
    };
    let sum = 0;
    let weights = 0;
    let s = 0;
    for (const [j, { t, w }] of schedule.entries()) {
      pass(t);
      const city = pick(raid, pops, comms, chaos);
      const p = city < 0 ? 0 : Math.min(1, (c * factorOf(pops[city] as number, chaos[city] as number)) / REF);
      sum += w * p;
      weights += w;
      if (s < sampled.length && sampled[s] === j) {
        const col = columns[s] as Float64Array;
        for (let i = 0; i < 6; i++) {
          col[walk * 6 + i] =
            raid && !((comms[i] as number) > 0)
              ? 0
              : Math.min(1, (c * factorOf(pops[i] as number, chaos[i] as number)) / REF);
        }
        s++;
      }
      if (city >= 0) attemptOn(scenario.name, random() < p, city, pops, comms, chaos, random);
    }
    pass(horizon);
    chances.push(sum / weights);
  }
  const weightsOf = sampled.map((j) => (schedule[j] as { w: number }).w);
  return { ...meanOf(chances), chances, columns, weightsOf, walks };
}

/** E[max] over the six under the product of the walks' marginals (each city's column its own empirical law). */
function independentMax(col: Float64Array, walks: number, from = 0, to = walks): number {
  const n = to - from;
  const values: { x: number; i: number }[] = [];
  for (let w = from; w < to; w++) for (let i = 0; i < 6; i++) values.push({ x: col[w * 6 + i] as number, i });
  values.sort((a, b) => a.x - b.x);
  // E[max] = ∫ (1 − Π F_i(x)) dx from 0, F_i the share of city i's values ≤ x.
  const counts = new Array(6).fill(0);
  let product = 0;
  let zeros = 6;
  let logSum = 0;
  let last = 0;
  let integral = 0;
  for (const { x, i } of values) {
    integral += (1 - (zeros > 0 ? 0 : Math.exp(logSum))) * (x - last);
    last = x;
    if (counts[i] === 0) zeros--;
    else logSum -= Math.log(counts[i] / n);
    counts[i]++;
    logSum += Math.log(counts[i] / n);
    product = zeros > 0 ? 0 : Math.exp(logSum);
  }
  void product;
  return integral;
}
function jointMax(col: Float64Array, walks: number, from = 0, to = walks): number {
  let sum = 0;
  for (let w = from; w < to; w++) {
    let most = 0;
    for (let i = 0; i < 6; i++) most = Math.max(most, col[w * 6 + i] as number);
    sum += most;
  }
  return sum / (to - from);
}
/** Option 1's ideal (independence on the walks' own marginals) against the joint, over the sampled attempts. */
function independence(walked: ReturnType<typeof walkScenario>, batches = 10) {
  const { columns, weightsOf, walks } = walked;
  const total = weightsOf.reduce((a, b) => a + b, 0);
  const over = (from: number, to: number) => {
    let ind = 0;
    let joint = 0;
    for (const [k, col] of columns.entries()) {
      ind += (weightsOf[k] as number) * independentMax(col, walks, from, to);
      joint += (weightsOf[k] as number) * jointMax(col, walks, from, to);
    }
    return { ind: ind / total, joint: joint / total };
  };
  const all = over(0, walks);
  const size = Math.floor(walks / batches);
  const diffs: number[] = [];
  for (let b = 0; b < batches; b++) {
    const each = over(b * size, (b + 1) * size);
    diffs.push(each.ind - each.joint);
  }
  return { ...all, diff: all.ind - all.joint, diffError: meanOf(diffs).error / Math.sqrt(1) };
}

/**
 * Option 3's Monte Carlo of the events alone, once a reading from the six read: on a grid of `G` + 1 times over the
 * horizon, each walk's most factor (all six; Raid's of those with communities) and each city's mean factor.
 */
function eventsMonteCarlo(horizon: number, walks: number, seed: number, G = 256) {
  const most = Array.from({ length: G + 1 }, () => new Float64Array(walks));
  const mostRaid = Array.from({ length: G + 1 }, () => new Float64Array(walks));
  const cityMeans = Array.from({ length: G + 1 }, () => new Float64Array(6));
  const popMeans = Array.from({ length: G + 1 }, () => new Float64Array(6));
  const chaosMeans = Array.from({ length: G + 1 }, () => new Float64Array(6));
  for (let walk = 0; walk < walks; walk++) {
    const events = seeded(seed + 7919 * walk);
    const pops = SIX.map((city) => city.population);
    const comms = SIX.map((city) => city.communities);
    const chaos = SIX.map((city) => city.chaos);
    let decayed = 0;
    let next = intIn(events, 240, 600);
    const decayTo = (t: number) => {
      for (const i of chaos.keys()) chaos[i] = Math.max(0, (chaos[i] as number) - 0.0001 * (t - decayed));
      decayed = t;
    };
    for (let g = 0; g <= G; g++) {
      const t = (g * horizon) / G;
      while (next <= t) {
        decayTo(next);
        eventsOn(pops, comms, chaos, events);
        next += intIn(events, 240, 600);
      }
      decayTo(t);
      let best = 0;
      let bestRaid = 0;
      const means = cityMeans[g] as Float64Array;
      for (let i = 0; i < 6; i++) {
        // The worked city's chaos is Diplomacy's to hold at 50: at most 50 here.
        const f = factorOf(pops[i] as number, process.env.R423_UNCAP === "1" ? (chaos[i] as number) : Math.min(50, chaos[i] as number));
        means[i] = (means[i] as number) + f / walks;
        (popMeans[g] as Float64Array)[i] += (pops[i] as number) / walks;
        (chaosMeans[g] as Float64Array)[i] += Math.min(50, chaos[i] as number) / walks;
        if (f > best) best = f;
        if ((comms[i] as number) > 0 && f > bestRaid) bestRaid = f;
      }
      (most[g] as Float64Array)[walk] = best;
      (mostRaid[g] as Float64Array)[walk] = bestRaid;
    }
  }
  return { most, mostRaid, cityMeans, popMeans, chaosMeans, G, horizon, walks };
}
type EventsMC = ReturnType<typeof eventsMonteCarlo>;

/**
 * The same Monte Carlo, lean (for its cost): each walk's most population at each time (the chaos at most 50 there, so
 * its factor 1: the most factor the most population's ^0.7), the events inline. Its output the same figures.
 */
function eventsMonteCarloLean(horizon: number, walks: number, seed: number, G = 256): EventsMC {
  const most = Array.from({ length: G + 1 }, () => new Float64Array(walks));
  const mostRaid = Array.from({ length: G + 1 }, () => new Float64Array(walks));
  const popMeans = Array.from({ length: G + 1 }, () => new Float64Array(6));
  const chaosMeans = Array.from({ length: G + 1 }, () => new Float64Array(6));
  const pops = new Float64Array(6);
  const comms = new Float64Array(6);
  for (let walk = 0; walk < walks; walk++) {
    const ev = seeded(seed + 7919 * walk);
    for (let i = 0; i < 6; i++) {
      pops[i] = (SIX[i] as BladeburnerDriftCity).population;
      comms[i] = (SIX[i] as BladeburnerDriftCity).communities;
    }
    let next = Math.floor(ev() * 361) + 240;
    for (let g = 0; g <= G; g++) {
      const t = (g * horizon) / G;
      while (next <= t) {
        const kind = ev();
        const s = Math.floor(ev() * 6);
        if (kind <= 0.05) {
          comms[s] = (comms[s] as number) + 1;
          pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * ((Math.floor(ev() * 11) + 10) / 100));
        } else if (kind <= 0.1) {
          if ((comms[s] as number) <= 0) {
            comms[s] = 1;
            pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * ((Math.floor(ev() * 11) + 10) / 100));
          } else {
            let d = Math.floor(ev() * 5);
            if (d >= s) d += 1;
            comms[s] = (comms[s] as number) - 1;
            comms[d] = (comms[d] as number) + 1;
            const count = Math.round((pops[s] as number) * ((Math.floor(ev() * 11) + 10) / 100));
            pops[s] = (pops[s] as number) - count;
            pops[d] = (pops[d] as number) + count;
          }
        } else if (kind <= 0.3) {
          pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * ((Math.floor(ev() * 17) + 8) / 100));
        } else if (kind <= 0.5) {
          let to = Math.floor(ev() * 5);
          if (to >= s) to += 1;
          let share = (Math.floor(ev() * 13) + 3) / 100;
          if (ev() < 0.05 && (comms[s] as number) > 0) {
            share *= Math.floor(ev() * 3) + 2;
            comms[s] = (comms[s] as number) - 1;
            comms[to] = (comms[to] as number) + 1;
          }
          const count = Math.round((pops[s] as number) * share);
          pops[s] = (pops[s] as number) - count;
          pops[to] = (pops[to] as number) + count;
        } else if (kind <= 0.7) {
          // Riots: the chaos's draw (its factor 1 at 50 or under, Diplomacy's hold): drawn to keep the stream.
          ev();
        } else if (kind <= 0.9) {
          pops[s] = (pops[s] as number) + Math.round((pops[s] as number) * -((Math.floor(ev() * 13) + 8) / 100));
        }
        next += Math.floor(ev() * 361) + 240;
      }
      let best = 0;
      let bestRaid = 0;
      const pm = popMeans[g] as Float64Array;
      for (let i = 0; i < 6; i++) {
        const p = pops[i] as number;
        pm[i] = (pm[i] as number) + p / walks;
        if (p > best) best = p;
        if ((comms[i] as number) > 0 && p > bestRaid) bestRaid = p;
      }
      (most[g] as Float64Array)[walk] = best;
      (mostRaid[g] as Float64Array)[walk] = bestRaid;
    }
  }
  for (let g = 0; g <= G; g++) {
    const a = most[g] as Float64Array;
    const b = mostRaid[g] as Float64Array;
    for (let w = 0; w < walks; w++) {
      a[w] = (a[w] as number) ** 0.7;
      b[w] = (b[w] as number) ** 0.7;
    }
  }
  return { most, mostRaid, cityMeans: popMeans, popMeans, chaosMeans, G, horizon, walks };
}

/** Option 3's factor at time t for an action at chance read c: E[min(1, c·max f)] / min(1, c·max E f), interpolated. */
function factorAt(mc: EventsMC, c: number, raid: boolean, t: number, from = 0, to = mc.walks): number {
  const at = (g: number) => {
    const xs = (raid ? mc.mostRaid : mc.most)[g] as Float64Array;
    let sum = 0;
    for (let w = from; w < to; w++) sum += Math.min(1, (c * (xs[w] as number)) / REF);
    const eMax = sum / (to - from);
    // max E over the same walks.
    // max E: the mean path's own quantity, the factor at each city's mean population and chaos (the path carries the
    // means); or (the flag off) the max of each city's mean factor.
    let maxE = 0;
    const pm = mc.popMeans[g] as Float64Array;
    const cm = mc.chaosMeans[g] as Float64Array;
    for (let i = 0; i < 6; i++) {
      const each = MAXE_AT_MEAN_POP
        ? factorOf(pm[i] as number, cm[i] as number)
        : ((mc.cityMeans[g] as Float64Array)[i] as number);
      maxE = Math.max(maxE, each);
    }
    return { eMax, maxE };
  };
  const x = Math.max(0, Math.min(mc.G, (t / mc.horizon) * mc.G));
  const g0 = Math.floor(x);
  const g1 = Math.min(mc.G, g0 + 1);
  const a = at(g0);
  const b = at(g1);
  const share = x - g0;
  const eMax = a.eMax + share * (b.eMax - a.eMax);
  const maxE = a.maxE + share * (b.maxE - a.maxE);
  return eMax / Math.min(1, (c * maxE) / REF);
}

/** Batch means of the city factors (for a batch's own max E). */
function eventsMonteCarloBatch(mc: EventsMC, from: number, to: number): EventsMC {
  // A batch's max E needs its own city means: recompute is not possible from the stored maxima, so batches are run apart.
  void from;
  void to;
  return mc;
}
void eventsMonteCarloBatch;

/** Option 3 applied to a scenario's mean path: each chunk's successes × the factor at its middle. */
function optionThree(scenario: Scenario, mc: EventsMC): number {
  const raid = scenario.name === "Raid";
  let offset = 0;
  let successes = 0;
  let attempts = 0;
  for (const piece of scenario.pieces) {
    const { attempts: at, successes: ss } = piece.curve;
    const chunks = at.length - 1;
    for (let k = 0; k < chunks; k++) {
      const da = (at[k + 1] as number) - (at[k] as number);
      const ds = (ss[k + 1] as number) - (ss[k] as number);
      const t = offset + ((k + 0.5) * piece.seconds) / chunks;
      const f = factorAt(mc, scenario.chanceRead, raid, t);
      successes += Math.min(da, ds * f);
      attempts += da;
    }
    offset += piece.seconds;
  }
  return successes / attempts;
}

// ---- Option 1's prototype: per-city log grids, the migrations independent (each inflow at its source's mean) ----

function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j] as number;
        const ai = im[i + j] as number;
        const br = (re[i + j + len / 2] as number) * cr - (im[i + j + len / 2] as number) * ci;
        const bi = (re[i + j + len / 2] as number) * ci + (im[i + j + len / 2] as number) * cr;
        re[i + j] = ar + br;
        im[i + j] = ai + bi;
        re[i + j + len / 2] = ar - br;
        im[i + j + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] = (re[i] as number) / n), (im[i] = (im[i] as number) / n);
}

/** A source event's kernel on ln(pop) (`randomEvent`, communities > 0), linear interpolation between cells. */
function sourceKernel(N: number, h: number): Float64Array {
  const k = new Float64Array(N);
  const put = (shift: number, mass: number) => {
    const x = shift / h;
    const lo = Math.floor(x);
    const share = x - lo;
    const at = (i: number) => ((i % N) + N) % N;
    k[at(lo)] = (k[at(lo)] as number) + mass * (1 - share);
    k[at(lo + 1)] = (k[at(lo + 1)] as number) + mass * share;
  };
  for (let u = 10; u <= 20; u++) put(Math.log1p(u / 100), 0.05 / 11);
  for (let u = 10; u <= 20; u++) put(Math.log1p(-u / 100), 0.05 / 11);
  for (let u = 8; u <= 24; u++) put(Math.log1p(u / 100), 0.2 / 17);
  for (let u = 3; u <= 15; u++) {
    put(Math.log1p(-u / 100), (0.2 * 0.95) / 13);
    for (let m = 2; m <= 4; m++) put(Math.log1p(-Math.min(0.99, (u * m) / 100)), (0.2 * 0.05) / 13 / 3);
  }
  put(0, 0.2 + 0.1);
  for (let u = 8; u <= 20; u++) put(Math.log1p(-u / 100), 0.2 / 13);
  return k;
}

/**
 * Option 1's prototype over a scenario: the six cities' ln(pop) on grids of N cells of h, the events a compound
 * Poisson a chunk (FFT), each inflow at its source's mean (independence), and an attempt's drain (Raid's, Sting's,
 * Stealth Retirement's) on each city's cell weighted by its chance of being B4's pick there (Π of the others' CDFs).
 * The chance drawn: E[min(1, c·max f)] under the product of the six. Chaos left at its factor 1 (held at 50).
 */
function optionOne(scenario: Scenario, horizon: number, N: number, h: number, G = 256) {
  const c = scenario.chanceRead;
  const center = Math.log(1.2e9);
  const uMin = center - (N / 2) * h;
  const cellOf = (pop: number) => (Math.log(pop) - uMin) / h;
  const grids = SIX.map((city) => {
    const p = new Float64Array(N);
    const x = cellOf(city.population);
    const lo = Math.floor(x);
    p[lo] = 1 - (x - lo);
    p[lo + 1] = x - lo;
    return p;
  });
  const kernel = sourceKernel(N, h);
  const kre = new Float64Array(kernel);
  const kim = new Float64Array(N);
  fft(kre, kim, false);
  const dt = horizon / G;
  const lambda = dt / 420 / 6;
  // exp(λ(K̂ − 1)) for the chunk.
  const mre = new Float64Array(N);
  const mim = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = lambda * ((kre[i] as number) - 1);
    const b = lambda * (kim[i] as number);
    mre[i] = Math.exp(a) * Math.cos(b);
    mim[i] = Math.exp(a) * Math.sin(b);
  }
  const pops = new Float64Array(N);
  for (let i = 0; i < N; i++) pops[i] = Math.exp(uMin + i * h);
  const chanceOf = new Float64Array(N);
  for (let i = 0; i < N; i++) chanceOf[i] = Math.min(1, (c * (pops[i] as number) ** 0.7) / REF);
  // The attempts' density over the horizon (the scenario's pieces).
  const attemptsIn = (t0: number, t1: number) => {
    let offset = 0;
    let sum = 0;
    for (const piece of scenario.pieces) {
      const a = Math.max(t0, offset);
      const b = Math.min(t1, offset + piece.seconds);
      if (b > a && piece.seconds > 0) sum += (piece.attempts * (b - a)) / piece.seconds;
      offset += piece.seconds;
    }
    return sum;
  };
  const drainLog = (p: number) => {
    switch (scenario.name) {
      case "Raid":
        return p * Math.log(0.99) + (1 - p) * Math.log(1 - 0.0075);
      case "Sting Operation":
        return p * Math.log(1 - 0.001);
      case "Stealth Retirement Operation":
        return p * Math.log(1 - 0.005);
      default:
        return 0;
    }
  };
  const drains = drainLog(0.5) !== 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const cdfs = SIX.map(() => new Float64Array(N));
  const computeCdfs = () => {
    for (const [i, p] of grids.entries()) {
      const cdf = cdfs[i] as Float64Array;
      let s = 0;
      for (let x = 0; x < N; x++) {
        s += p[x] as number;
        cdf[x] = s;
      }
      // Normalise (mass lost to clamping).
      for (let x = 0; x < N; x++) cdf[x] = (cdf[x] as number) / s;
    }
  };
  /** E[max chance] under the product: Σ over cells of Δ(Π F) × the chance there. */
  const eMax = () => {
    let prev = 0;
    let sum = 0;
    for (let x = 0; x < N; x++) {
      let prod = 1;
      for (const cdf of cdfs) prod *= cdf[x] as number;
      sum += (prod - prev) * (chanceOf[x] as number);
      prev = prod;
    }
    return sum;
  };
  let drawn = 0;
  let made = 0;
  for (let g = 0; g < G; g++) {
    const t0 = g * dt;
    // The events' first half of the chunk is folded into one step (the prototype's resolution): the chunk's events,
    // then its attempts at the chunk's state.
    const means = grids.map((p) => {
      let m = 0;
      let s = 0;
      for (let x = 0; x < N; x++) {
        m += (p[x] as number) * (pops[x] as number);
        s += p[x] as number;
      }
      return m / s;
    });
    for (const [i, p] of grids.entries()) {
      re.set(p);
      im.fill(0);
      fft(re, im, false);
      for (let x = 0; x < N; x++) {
        const a = re[x] as number;
        const b = im[x] as number;
        re[x] = a * (mre[x] as number) - b * (mim[x] as number);
        im[x] = a * (mim[x] as number) + b * (mre[x] as number);
      }
      fft(re, im, true);
      for (let x = 0; x < N; x++) p[x] = Math.max(0, re[x] as number);
      // Inflow from each other city at its mean: a community's migration (0.05, 10–20%) and a migration (0.2, 3–15%,
      // ×2–4 at 5%), each source with chance 1/6 an event, here with 1/5.
      const amounts: { m: number; rate: number }[] = [];
      for (const [j, mean] of means.entries()) {
        if (j === i) continue;
        const rate = dt / 420 / 6 / 5;
        amounts.push({ m: mean * 0.15, rate: rate * 0.05 });
        amounts.push({ m: mean * 0.09 * 0.95, rate: rate * 0.2 * 0.95 });
        amounts.push({ m: mean * 0.27, rate: rate * 0.2 * 0.05 });
      }
      const total = amounts.reduce((sum, each) => sum + each.rate, 0);
      // In SUB mass-keeping steps (λ about 0.1 a chunk): p ← (1 − λ/SUB) p + Σ (rate_m/SUB) T_m p.
      const SUB = 2;
      for (let sub = 0; sub < SUB; sub++) {
        const out = new Float64Array(N);
        for (let x = 0; x < N; x++) out[x] = (1 - total / SUB) * (p[x] as number);
        for (const { m, rate } of amounts) {
          const wgt = rate / SUB;
          for (let x = 0; x < N; x++) {
            const mass = p[x] as number;
            if (!(mass > 1e-14)) continue;
            const y = cellOf((pops[x] as number) + m);
            const lo = Math.floor(y);
            if (lo < 0 || lo + 1 >= N) continue;
            out[lo] = (out[lo] as number) + wgt * mass * (1 - (y - lo));
            out[lo + 1] = (out[lo + 1] as number) + wgt * mass * (y - lo);
          }
        }
        p.set(out);
      }
    }
    computeCdfs();
    const a = attemptsIn(t0, t0 + dt);
    if (a > 0) {
      drawn += a * eMax();
      made += a;
      if (drains) {
        // Each city's cells drained by a × P(this city is B4's pick | its value) × the mean log drain there.
        for (const [i, p] of grids.entries()) {
          const out = new Float64Array(N);
          for (let x = 0; x < N; x++) {
            const mass = p[x] as number;
            if (!(mass > 1e-14)) continue;
            let others = 1;
            for (const [j, cdf] of cdfs.entries()) if (j !== i) others *= cdf[x] as number;
            const shift = (a * others * drainLog(chanceOf[x] as number)) / h;
            const y = x + shift;
            const lo = Math.floor(y);
            out[lo] = (out[lo] as number) + mass * (1 - (y - lo));
            out[lo + 1] = (out[lo + 1] as number) + mass * (y - lo);
          }
          p.set(out);
        }
      }
    }
  }
  const endMeans = grids.map((p) => {
    let m = 0;
    let s = 0;
    for (let x = 0; x < N; x++) {
      m += (p[x] as number) * (pops[x] as number);
      s += p[x] as number;
    }
    return m / s;
  });
  const endSd = grids.map((p) => {
    let m = 0;
    let m2 = 0;
    let s = 0;
    for (let x = 0; x < N; x++) {
      const u = uMin + x * h;
      m += (p[x] as number) * u;
      m2 += (p[x] as number) * u * u;
      s += p[x] as number;
    }
    return Math.sqrt(m2 / s - (m / s) ** 2);
  });
  LAST_GRID = { endMeans, endSd, endMax: eMax() };
  return made > 0 ? drawn / made : 0;
}
let LAST_GRID: { endMeans: number[]; endSd: number[]; endMax: number } | null = null;

/** Events alone, the Monte Carlo's own E[min(1, c·max f)] along a scenario's schedule (no path, no factorisation). */
function mcDirect(scenario: Scenario, mc: EventsMC): number {
  const raid = scenario.name === "Raid";
  let sum = 0;
  let weights = 0;
  for (const { t, w } of scheduleOf(scenario)) {
    const x = Math.max(0, Math.min(mc.G, (t / mc.horizon) * mc.G));
    const g = Math.round(x);
    const xs = (raid ? mc.mostRaid : mc.most)[g] as Float64Array;
    let s = 0;
    for (const f of xs) s += Math.min(1, (scenario.chanceRead * f) / REF);
    sum += (w * s) / xs.length;
    weights += w;
  }
  return sum / weights;
}

describe("#423 research: B4's pick among the six's spread", () => {
  test("instruments, option 1 and option 3 against walks of the game's draws, at check 3's reading", () => {
    const WALKS = Number(process.env.R423_WALKS ?? 1000);
    const MC = Number(process.env.R423_MC ?? 1000);
    const who = personOf(combatOf(100));
    const input = readAt(who);
    const drift = { cities: SIX, city: "New Tokyo" };
    const target = { rank: 150, target: 2500 };
    const g = globalThis as unknown as { __calls?: { args: any[]; result: any }[] };
    g.__calls = [];
    const plans = bladeburnerPlansToTarget({ ...input, target, drift });
    const calls = g.__calls;
    g.__calls = undefined;
    const chosen = plans[0] as (typeof plans)[number];
    const second = chooseBladeburnerAction(input);
    const rival = plans.find((plan) => plan.work?.name === second.work?.name && plan.rest.name === second.rest.name);
    const horizon = chosen.work?.drift?.horizonSeconds as number;
    const mix = bladeburnerTailMix({ ...input, target, drift: { ...drift, horizonSeconds: horizon } });
    console.log(
      `R423 plans: chosen ${chosen.work?.name} ${chosen.work?.chance.toFixed(4)} next ${chosen.toTarget?.next?.name}; ` +
        `rival ${rival?.work?.name} ${rival?.work?.chance.toFixed(4)} next ${rival?.toTarget?.next?.name}; horizon ` +
        `${(horizon / 3600).toFixed(2)} h; tail mix ${mix.work.map((w) => `${w.name} ${w.level} ${w.chance.toFixed(4)} ${(w.attemptsPerSecond * 3600).toFixed(2)}/h`).join(", ")}; ${calls.length} path calls`,
    );
    // The scenarios: a call continuing the previous one's state is its second piece.
    const scenarios: Scenario[] = [];
    let previous: { result: any } | null = null;
    for (const call of calls) {
      const [start, , parts, seconds] = call.args;
      const part = parts[0];
      const piece = { attempts: part.attempts, seconds, curve: call.result.curve };
      if (previous !== null && start === previous.result.state) {
        (scenarios[scenarios.length - 1] as Scenario).pieces.push(piece);
      } else {
        scenarios.push({ name: part.action.name, chanceRead: part.chance, pieces: [piece], priced: 0, kind: "" });
      }
      previous = call;
    }
    const seen = new Set<string>();
    const unique = scenarios.filter((each) => {
      const key = JSON.stringify([each.name, each.chanceRead, each.pieces.map((p) => [p.attempts, p.seconds])]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const each of unique) {
      let successes = 0;
      let attempts = 0;
      for (const piece of each.pieces) {
        successes += piece.curve.successes[piece.curve.successes.length - 1] as number;
        attempts += piece.attempts;
      }
      each.priced = successes / attempts;
      each.kind = each.pieces.length > 1 || (each.pieces[0] as { seconds: number }).seconds < horizon - 1 ? "chain" : "horizon";
    }
    const actions = new Set([
      chosen.work?.name,
      rival?.work?.name,
      chosen.toTarget?.next?.name,
      rival?.toTarget?.next?.name,
      ...mix.work.map((w) => w.name),
    ]);
    const relevant = unique.filter((each) => actions.has(each.name));
    // Option 3's Monte Carlo: its own seeds (apart from the walks'), timed.
    const started = performance.now();
    const mc = eventsMonteCarlo(horizon, MC, 990001);
    const mcMs = performance.now() - started;
    // Its sampling error: 10 Monte Carlos of MC/10 walks each, their spread / √10 the error at MC.
    const batches = Array.from({ length: 10 }, (_, b) => eventsMonteCarlo(horizon, Math.floor(MC / 10), 770001 + 1000003 * b));
    // And a second full Monte Carlo on other seeds (its error measured apart).
    const mc2 = eventsMonteCarlo(horizon, MC, 550001);
    // The lean Monte Carlo's cost at 200, 500 and 1,000 walks (the same draws as the full one: checked equal).
    const leanMs: string[] = [];
    for (const n of [200, 500, 1000]) {
      eventsMonteCarloLean(horizon, n, 123457); // warm
      const t = performance.now();
      const reps = 3;
      for (let r = 0; r < reps; r++) eventsMonteCarloLean(horizon, n, 990001 + r);
      leanMs.push(`${n} walks ${((performance.now() - t) / reps).toFixed(1)} ms`);
    }
    const lean = eventsMonteCarloLean(horizon, MC, 990001);
    const leanCheck = [0.1, 0.5, 0.9].map(
      (share) => factorAt(lean, 0.3178, false, share * horizon) - factorAt(mc, 0.3178, false, share * horizon),
    );
    console.log(`R423 lean MC: ${leanMs.join(", ")}; against the full one's factor at 10/50/90%: ${leanCheck.map((x) => x.toExponential(1)).join(", ")}`);
    // Option 3's sampling error measured apart: REPS Monte Carlos of MC walks each, seeds disjoint from the judged one's.
    const REPS = Number(process.env.R423_REPS ?? 5);
    const replicates = Array.from({ length: REPS }, (_, r) => eventsMonteCarloLean(horizon, MC, 31000001 + 2000003 * r));
    const rows: string[] = [];
    const ratios = { three: new Map<string, number>(), walked: new Map<string, number>() };
    for (const each of relevant) {
      const t0 = performance.now();
      const walked = walkScenario(each, horizon, WALKS, 3861);
      const walkMs = performance.now() - t0;
      const ind = independence(walked);
      if (each.name === "Retirement" ? each.kind === "horizon" : each.kind === "chain") {
        ratios.walked.set(each.name, walked.mean / each.priced);
      }
      const three = optionThree(each, mc);
      const threeOther = optionThree(each, mc2);
      const threeBatches = meanOf(batches.map((b) => optionThree(each, b)));
      const threeReps = meanOf(replicates.map((b) => optionThree(each, b)));
      const repSd = threeReps.error * Math.sqrt(REPS);
      // The ratios for the plans' re-pricing: the plan's own actions' chain, the tail's (Retirement) its horizon's.
      const use = each.name === "Retirement" ? each.kind === "horizon" : each.kind === "chain";
      if (use) {
        ratios.three.set(each.name, three / each.priced);
      }
      const direct = mcDirect(each, mc);
      const t1 = performance.now();
      const one = optionOne(each, horizon, 1024, 0.02);
      const oneMs = performance.now() - t1;
      const gridEnd = LAST_GRID;
      const t2 = performance.now();
      const oneCoarse = optionOne(each, horizon, 256, 0.08, 64);
      const oneCoarseMs = performance.now() - t2;
      const attempts = each.pieces.reduce((sum, p) => sum + p.attempts, 0);
      rows.push(
        `R423 ${each.name} (${each.kind}: ${each.pieces.map((p) => `${p.attempts.toFixed(1)} in ${(p.seconds / 3600).toFixed(2)} h`).join(" + ")}; read ${each.chanceRead.toFixed(4)}): ` +
          `priced ${each.priced.toFixed(4)}; walked ${walked.mean.toFixed(4)} ± ${walked.error.toFixed(4)} (${WALKS} walks, ${walkMs.toFixed(0)} ms); ` +
          `on the sampled attempts joint ${ind.joint.toFixed(4)}, independent ${ind.ind.toFixed(4)} (diff ${ind.diff.toFixed(4)} ± ${ind.diffError.toFixed(4)}); ` +
          `option 1 grid 1024×0.02 ${one.toFixed(4)} (${oneMs.toFixed(1)} ms), 256×0.08 at 64 chunks ${oneCoarse.toFixed(4)} (${oneCoarseMs.toFixed(1)} ms); ` +
          `option 3 ${three.toFixed(4)} (other seeds ${threeOther.toFixed(4)}; 10 batches of ${Math.floor(MC / 10)}: ${threeBatches.mean.toFixed(4)}, sd ${(threeBatches.error * Math.sqrt(10)).toFixed(4)} → ±${(threeBatches.error * Math.sqrt(10) / Math.sqrt(10)).toFixed(4)} at ${MC}); attempts ${attempts.toFixed(1)}; option 3's ${REPS} replicates of ${MC} (seeds apart): ${threeReps.mean.toFixed(4)}, sd ${repSd.toFixed(4)}; ` +
          `events-only E[max] along its schedule (no path) ${direct.toFixed(4)}; grid's end: means ${gridEnd?.endMeans.map((m) => (m / 1e9).toFixed(3)).join("/")} ln-sd ${gridEnd?.endSd.map((m) => m.toFixed(3)).join("/")}`,
      );
    }
    {
      // The Monte Carlo's end: each city's mean population and ln-sd (against the grid's, above).
      const ends = SIX.map((_, i) => {
        const xs: number[] = [];
        for (let walk = 0; walk < Math.min(MC, 400); walk++) {
          const events = seeded(990001 + 7919 * walk);
          const pops = SIX.map((city) => city.population);
          const comms = SIX.map((city) => city.communities);
          const chaos = SIX.map((city) => city.chaos);
          let next = intIn(events, 240, 600);
          while (next <= horizon) {
            eventsOn(pops, comms, chaos, events);
            next += intIn(events, 240, 600);
          }
          xs.push(pops[i] as number);
        }
        const logs = meanOf(xs.map(Math.log));
        const sd = logs.error * Math.sqrt(xs.length);
        return `${(meanOf(xs).mean / 1e9).toFixed(3)} (ln-sd ${sd.toFixed(3)})`;
      });
      console.log(`R423 events MC's end: ${ends.join(", ")}`);
    }
    console.log(`R423 events MC: ${MC} walks over ${(horizon / 3600).toFixed(2)} h at 257 times, ${mcMs.toFixed(1)} ms`);
    for (const row of rows) console.log(row);
    // Option 3's factor along the horizon, for Bounty Hunter's chance read.
    const bh = relevant.find((each) => each.name === "Bounty Hunter");
    if (bh !== undefined) {
      const at = [0, 0.1, 0.25, 0.5, 0.75, 1].map((share) => factorAt(mc, bh.chanceRead, false, share * horizon).toFixed(3));
      console.log(`R423 option 3's factor for Bounty Hunter at 0, 10, 25, 50, 75, 100% of the horizon: ${at.join(", ")}`);
    }
    // Check 3's walks (the plans' own attempts with the events), each action's drawn chance by phase.
    {
      const PLAN = Number(process.env.R423_PLAN ?? 1200);
      const alone = plans.find((plan) => plan.work === null) as (typeof plans)[number];
      const wayOf = (plan: (typeof plans)[number]): WalkedWay => {
        const work = plan.work as NonNullable<(typeof plan)["work"]>;
        const each = action(work.name);
        return {
          action: each,
          chanceRead: work.drift?.chanceRead ?? work.chance,
          seconds: work.seconds,
          stamina: work.stamina,
          gain: actionRankGain(each, work.level, 1),
          loss: actionRankLoss(each, work.level),
        };
      };
      const planAt = (name: string, level: number) => {
        const plan = plans.find((each) => each.work?.name === name && each.work.level === level);
        if (plan === undefined) throw new Error(`no plan for ${name} ${level}`);
        return plan;
      };
      const tail = mix.work.map((part) => ({
        way: { ...wayOf(planAt(part.name, part.level)), seconds: part.attemptSeconds },
        perSecond: part.attemptsPerSecond,
      }));
      const policyOf = (first: (typeof plans)[number]): WalkPolicy => {
        const next = first.toTarget?.next;
        if (next === undefined) return { chain: [wayOf(first)], tail };
        if (next.name === null || next.level === null) throw new Error("resting alone next");
        return { chain: [wayOf(first), wayOf(planAt(next.name, next.level))], tail };
      };
      const setting = {
        ...target,
        regain: chosen.regain,
        maxStamina: input.maxStamina,
        restRank: alone.rankPerSecond,
        charisma: who.skills.charisma,
        cities: SIX,
        city: "New Tokyo",
        walks: PLAN,
      };
      const walkedTimes = new Map<string, number>();
      const chainOf = (name: string) => relevant.find((each) => each.name === name && each.kind === "chain");
      const horizonOf = (name: string) => relevant.find((each) => each.name === name && each.kind === "horizon");
      for (const [label, plan] of [
        ["Bounty Hunter first", chosen],
        ["Raid first", rival as (typeof plans)[number]],
      ] as const) {
        const walked = walkPlan(policyOf(plan), { ...setting, seed: 3861 });
        const lines: string[] = [];
        for (const [key, each] of [...walked.perAction].sort()) {
          const [name, ...rest] = key.split(" ").reduce(
            (acc, word) => {
              // Names have spaces: the phase is the last one or two words.
              acc.push(word);
              return acc;
            },
            [] as string[],
          );
          void name;
          void rest;
          const phase = key.endsWith(" tail") ? "tail" : key.endsWith(" all") ? "all" : "chain";
          const actionName = key.replace(/ (tail|all|chain \d)$/, "");
          const scenario = phase === "tail" ? horizonOf(actionName) : chainOf(actionName);
          const priced = scenario?.priced;
          const three = scenario === undefined ? undefined : optionThree(scenario, mc);
          lines.push(
            `${key}: walked ${each.pooled.toFixed(4)} pooled (${each.mean.toFixed(4)} ± ${each.error.toFixed(4)} a walk's mean, ${each.walks} walks, ${each.n.toFixed(1)} attempts a walk); ` +
              `priced ${priced?.toFixed(4) ?? "-"} (${scenario?.kind ?? "-"}), option 3 ${three?.toFixed(4) ?? "-"}`,
          );
        }
        console.log(
          `R423 check 3, ${label} (${PLAN} walks, seed 3861): ${(walked.mean / 60).toFixed(1)} ± ${(walked.error / 60).toFixed(1)} min walked, ` +
            `${((plan.toTarget?.seconds as number) / 60).toFixed(1)} priced\n  ${lines.join("\n  ")}`,
        );
        walkedTimes.set(label, walked.mean);
      }
      // The plans re-priced with each action's chance read scaled by a ratio (the drift's path the same shape, so its
      // priced chance scales with it), the horizon held: option 3's, and the path-scenario walks' (term 1 alone).
      const repriced = (ratio: Map<string, number>) => {
        const readings = input.readings.map((read) => {
          const r = ratio.get(read.name) ?? 1;
          return { ...read, chance: [read.chance[0] * r, read.chance[1] * r] as [number, number] };
        });
        const again = bladeburnerPlansToTarget({ ...input, readings, target, drift: { ...drift, horizonSeconds: horizon } });
        const find = (p: (typeof plans)[number]) =>
          again.find(
            (each) =>
              each.work?.name === p.work?.name && each.work?.level === p.work?.level && each.rest.name === p.rest.name,
          );
        return {
          bh: find(chosen)?.toTarget?.seconds as number,
          raid: find(rival as (typeof plans)[number])?.toTarget?.seconds as number,
          first: `${again[0]?.work?.name} ${again[0]?.work?.level} ${again[0]?.rest.name}`,
        };
      };
      const base = repriced(new Map());
      const three = repriced(ratios.three);
      const ideal = repriced(ratios.walked);
      const w = { bh: walkedTimes.get("Bounty Hunter first") as number, raid: walkedTimes.get("Raid first") as number };
      const row = (label: string, x: { bh: number; raid: number; first: string }) =>
        `${label}: BH first ${(x.bh / 60).toFixed(1)} (${(100 * (x.bh / w.bh - 1)).toFixed(1)}%), Raid first ${(x.raid / 60).toFixed(1)} ` +
        `(${(100 * (x.raid / w.raid - 1)).toFixed(1)}%), the rule's first ${x.first}`;
      console.log(
        `R423 the plans re-priced (horizon held), against check 3's walked ${(w.bh / 60).toFixed(1)} / ${(w.raid / 60).toFixed(1)} min:\n  ` +
          [row("main", base), row("option 3's ratios", three), row("the path-scenario walks' ratios", ideal)].join("\n  ") +
          `\n  ratios: option 3 ${[...ratios.three].map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ")}; walked ${[...ratios.walked].map(([k, v]) => `${k} ${v.toFixed(4)}`).join(", ")}`,
      );
    }
    expect(relevant.length).toBeGreaterThan(0);
  }, 600_000);
});

// ---- check 3's walks (copied from bladeburner-drift.test.ts at 61e0b1f, with each action's drawn chance) ----
/** A way to work an action in the walks: the rule's plan's own figures for it (its level, time, stamina, chance read). */
interface WalkedWay {
  action: BladeburnerLevelledAction;
  chanceRead: number;
  seconds: number;
  stamina: number;
  gain: number;
  loss: number;
}

/** A walk's policy (#421's term 2): the rule's chain, each way worked until its count runs out, then the tail's mix. */
interface WalkPolicy {
  /** The plan's own way, then its next-best's where the chain has one (`toTarget.next`). */
  chain: readonly WalkedWay[];
  /** The tail's mix (`bladeburnerTailMix` at the rule's horizon): each way and its attempts a second. */
  tail: readonly { way: WalkedWay; perSecond: number }[];
}

/**
 * A plan walked to the target under the game's draws (#418's ruling 2, check 3), from `rank`, by the rule's own policy
 * (#421's term 2; until then the first way in a greedy order with a count, which is not the rule's tail): each way of
 * `policy.chain` worked until its count is under 1, then the tail's mix, each of its ways attempted when its attempts
 * a second times the tail's time reach its attempts made (the most behind first), else Field Analysis's 30 s (the mix's
 * rest alone, and each way's stamina rest); each attempt's count down 1, success or failure, `Bladeburner.ts:927-976`;
 * each count regrowing at its mean, `:1386-1393`. An attempt only with its stamina leaving half the max (no penalty,
 * `staminaPenalty`), the regain a second always. Its success at the chance read times the city's factor
 * over the city read's (the true population^0.7 over the chaos's factor, `Action.ts:88-103`; Raid 0 with no
 * communities), its rank ±10% (`addOffset`) and the floor at 0 (`:1267-1275`); its effects as
 * `completeOperation`/`completeContract` draw them (`:793-890`: Raid's −1% or −(5–10)/10 % and +1–5% chaos and a
 * community; Bounty Hunter's and Retirement's −1 and +0.02/+0.04 chaos; Investigation's and Undercover's failures a
 * migration's chance; Sting's); the city B4's before each attempt, by each city's true figure as the brain measures it
 * at every reading (#420's ruling 2: the round over the six recovers each city's pop/popEst, so the most true
 * population^0.7 over the chaos's factor, Raid's only where there are communities; until #420 the walks picked by the
 * estimates, which the events don't move, `City.ts:35-87`, as the brain then did), Diplomacy as B4 spends
 * it after an attempt over 50 (60 s an attempt at ×keep, taken whole: 60·ln(50/chaos)/ln(keep) s, the city at 50, then
 * the time); an event each 240–600 s in one of the six as `randomEvent` (`:601-699`) draws it and the decay
 * (`:1395-1401`) over every second. Left out, labelled: the count's regrowth's draw (its mean taken), the skills'
 * estimate multiplier (1), the migration's +100 under 1.5e9 (`:597-598`), the levels and skills (the plan's own level
 * throughout, as the rule prices it), each way's rest taken as Field Analysis's, HP and the hospital (no rank).
 */
function walkPlan(
  policy: WalkPolicy,
  {
    rank: from,
    target,
    regain,
    maxStamina,
    restRank,
    charisma,
    cities: read,
    city: readCity,
    walks,
    seed,
  }: {
    rank: number;
    target: number;
    regain: number;
    maxStamina: number;
    restRank: number;
    charisma: number;
    cities: readonly BladeburnerDriftCity[];
    city: string;
    walks: number;
    seed: number;
  },
) {
  const keep = 1 - (charisma ** 0.045 + charisma / 1e3) / 100;
  const factorOf = (pop: number, chaos: number) => Math.max(0, pop) ** 0.7 / chaosDifficultyFactor(chaos);
  const home = read.findIndex((city) => city.name === readCity);
  const reference = factorOf(
    (read[home] as BladeburnerDriftCity).population,
    (read[home] as BladeburnerDriftCity).chaos,
  );
  const times: number[] = [];
  const attemptsOf: number[] = [];
  const own = (policy.chain[0] as WalkedWay).action.name;
  // Each action's count by name (a mix may work one action at several ways).
  const names = [...new Set([...policy.chain, ...policy.tail.map((part) => part.way)].map((way) => way.action.name))];
  // The plan's own action (`policy.chain[0]`'s), over every walk (#420's ruling 3, item 4: the priced time's terms against
  // the walks'): its attempts, their chances summed, the time worked on them, and Diplomacy's after them.
  const first = { attempts: 0, chance: 0, atMean: 0, seconds: 0, diplomacy: 0, clock: 0 };
  // The walks' time and rank by term (#422's review: each term of the priced time against the walk): the plan's own
  // action, the others (the tail), each one's Diplomacy, and the rests; the rank each brought.
  const terms = {
    firstSeconds: 0,
    firstDiplomacy: 0,
    firstRank: 0,
    otherSeconds: 0,
    otherDiplomacy: 0,
    otherRank: 0,
    otherAttempts: 0,
    restSeconds: 0,
    restRank: 0,
  };
  // The tail's own record over every walk (#421's term 2): each way's attempts made and the tail's seconds.
  const tailMade = policy.tail.map(() => 0);
  let tailSeconds = 0;
  // And the chain's: each of its ways' attempts in its stretch.
  const chainMade = policy.chain.map(() => 0);
  // #423: each action's drawn chance, a walk's mean over its attempts (walks with none left out), by phase (chain or tail).
  const perAction = new Map<string, number[]>();
  const perWalk = new Map<string, { n: number; sum: number }>();
  const pooled = new Map<string, { n: number; sum: number }>();
  for (let walk = 0; walk < walks; walk++) {
    for (const [key, each] of perWalk) {
      if (each.n > 0) {
        if (!perAction.has(key)) perAction.set(key, []);
        (perAction.get(key) as number[]).push(each.sum / each.n);
      }
    }
    perWalk.clear();
    // Two streams a walk (common random numbers: a walk's events the same draws under either plan, as its own
    // attempts'), so the plans' gap is read walk by walk.
    const events = seeded(seed + 7919 * walk);
    const random = seeded(seed + 7919 * walk + 104729);
    const offset = (x: number) => x * (1 + (random() * 2 - 1) * 0.1);
    const pops = read.map((city) => city.population);
    const comms = read.map((city) => city.communities);
    const chaos = read.map((city) => city.chaos);
    const counts = new Map(names.map((name) => [name, 20]));
    const growth = new Map(names.map((name) => [name, countGrowthPerSecond(action(name))]));
    // Where the walk is in the chain (past its end: the tail, from `tailFrom`), and each tail way's attempts made.
    let phase = 0;
    let tailFrom = 0;
    const made = policy.tail.map(() => 0);
    let stamina = maxStamina;
    let rank = from;
    let clock = 0;
    let decayed = 0;
    let next = intIn(events, 240, 600);
    let attempts = 0;
    const decayTo = (t: number) => {
      for (const i of chaos.keys()) chaos[i] = Math.max(0, (chaos[i] as number) - 0.0001 * (t - decayed));
      decayed = t;
    };
    const migrate = (s: number, to: number, share: number) => {
      const count = Math.round((pops[s] as number) * share);
      pops[s] = (pops[s] as number) - count;
      pops[to] = (pops[to] as number) + count;
    };
    const other = (s: number, rng: () => number) => {
      const d = Math.floor(rng() * 5);
      return d >= s ? d + 1 : d;
    };
    const migration = (s: number, rng: () => number) => {
      const to = other(s, rng);
      let share = intIn(rng, 3, 15) / 100;
      if (rng() < 0.05 && (comms[s] as number) > 0) {
        share *= intIn(rng, 2, 4);
        comms[s] = (comms[s] as number) - 1;
        comms[to] = (comms[to] as number) + 1;
      }
      migrate(s, to, share);
    };
    const grow = (s: number, share: number) => {
      const change = Math.round((pops[s] as number) * share);
      pops[s] = (pops[s] as number) + change;
      return change;
    };
    const event = () => {
      const kind = events();
      const s = Math.floor(events() * 6);
      if (kind <= 0.05) {
        comms[s] = (comms[s] as number) + 1;
        grow(s, intIn(events, 10, 20) / 100);
      } else if (kind <= 0.1) {
        if ((comms[s] as number) <= 0) {
          comms[s] = 1;
          grow(s, intIn(events, 10, 20) / 100);
        } else {
          const d = other(s, events);
          comms[s] = (comms[s] as number) - 1;
          comms[d] = (comms[d] as number) + 1;
          migrate(s, d, intIn(events, 10, 20) / 100);
        }
      } else if (kind <= 0.3) grow(s, intIn(events, 8, 24) / 100);
      else if (kind <= 0.5) migration(s, events);
      else if (kind <= 0.7) chaos[s] = ((chaos[s] as number) + 1) * (1 + intIn(events, 5, 20) / 100);
      else if (kind <= 0.9) grow(s, -intIn(events, 8, 20) / 100);
    };
    const pass = (dt: number) => {
      const t = clock + dt;
      while (next <= t) {
        decayTo(next);
        event();
        next += intIn(events, 240, 600);
      }
      decayTo(t);
      clock = t;
      stamina = Math.min(maxStamina, stamina + regain * dt);
      for (const name of names) counts.set(name, (counts.get(name) as number) + (growth.get(name) as number) * dt);
    };
    const countOf = (way: WalkedWay) => counts.get(way.action.name) as number;
    const workable = (way: WalkedWay) =>
      stamina - way.stamina >= maxStamina / 2 && (way.action.name !== "Raid" || comms.some((c) => c > 0));
    while (rank < target && clock < 1e8) {
      // The chain: each way until its count is under 1 (Raid's with no communities anywhere, its end too).
      while (
        phase < policy.chain.length &&
        (countOf(policy.chain[phase] as WalkedWay) < 1 ||
          ((policy.chain[phase] as WalkedWay).action.name === "Raid" && !comms.some((c) => c > 0)))
      ) {
        phase++;
        if (phase === policy.chain.length) tailFrom = clock;
      }
      let way: WalkedWay | undefined;
      let part = -1;
      if (phase < policy.chain.length) {
        const each = policy.chain[phase] as WalkedWay;
        if (workable(each)) {
          way = each;
          chainMade[phase] = (chainMade[phase] as number) + 1;
        }
      } else {
        // The tail: the way most behind its share (its attempts a second over the tail's time, less those made).
        let behind = 0;
        for (const [k, { way: each, perSecond }] of policy.tail.entries()) {
          const owed = perSecond * (clock - tailFrom) - (made[k] as number);
          if (owed >= behind && countOf(each) >= 1 && workable(each) && (part < 0 || owed > behind)) {
            behind = owed;
            part = k;
          }
        }
        if (part >= 0) {
          way = (policy.tail[part] as (typeof policy.tail)[number]).way;
          made[part] = (made[part] as number) + 1;
        }
      }
      if (way === undefined) {
        pass(30);
        rank += restRank * 30;
        terms.restSeconds += 30;
        terms.restRank += restRank * 30;
        continue;
      }
      const raid = way.action.name === "Raid";
      // B4's city: the most true factor, measured each reading (#420; Raid's among those with communities).
      let city = -1;
      for (const i of pops.keys()) {
        if (raid && !((comms[i] as number) > 0)) continue;
        if (
          city < 0 ||
          factorOf(pops[i] as number, chaos[i] as number) > factorOf(pops[city] as number, chaos[city] as number)
        )
          city = i;
      }
      counts.set(way.action.name, countOf(way) - 1);
      stamina -= way.stamina;
      pass(way.seconds);
      attempts++;
      const p = Math.min(1, (way.chanceRead * factorOf(pops[city] as number, chaos[city] as number)) / reference);
      const mine = way.action.name === own;
      {
        const key = `${way.action.name} ${phase < policy.chain.length ? `chain ${phase}` : "tail"}`;
        const each = perWalk.get(key) ?? { n: 0, sum: 0 };
        each.n++;
        each.sum += p;
        perWalk.set(key, each);
        const all = perWalk.get(`${way.action.name} all`) ?? { n: 0, sum: 0 };
        all.n++;
        all.sum += p;
        perWalk.set(`${way.action.name} all`, all);
        for (const k of [key, `${way.action.name} all`]) {
          const q = pooled.get(k) ?? { n: 0, sum: 0 };
          q.n++;
          q.sum += p;
          pooled.set(k, q);
        }
      }
      if (mine) {
        first.attempts += 1;
        first.chance += p;
        first.seconds += way.seconds;
        first.clock += clock;
        // At the six's mean population and chaos (those with communities for Raid): the mean path's city, where the
        // six alike stay alike, against B4's pick of the best of six that the events spread apart.
        const pool = [...pops.keys()].filter((k) => !raid || (comms[k] as number) > 0);
        const meanPop = pool.reduce((sum, k) => sum + (pops[k] as number), 0) / pool.length;
        const meanChaos = pool.reduce((sum, k) => sum + (chaos[k] as number), 0) / pool.length;
        first.atMean += Math.min(1, (way.chanceRead * factorOf(meanPop, meanChaos)) / reference);
      }
      const success = random() < p;
      const before = rank;
      rank = Math.max(0, rank + (success ? offset(way.gain) : -offset(way.loss)));
      if (mine) {
        terms.firstSeconds += way.seconds;
        terms.firstRank += rank - before;
      } else {
        terms.otherSeconds += way.seconds;
        terms.otherRank += rank - before;
        terms.otherAttempts += 1;
      }
      switch (way.action.name) {
        case "Raid":
          if (success) {
            grow(city, -0.01);
            comms[city] = (comms[city] as number) - 1;
          } else grow(city, intIn(random, -10, -5) / 1000);
          chaos[city] = (chaos[city] as number) * (1 + intIn(random, 1, 5) / 100);
          break;
        case "Bounty Hunter":
        case "Retirement":
          if (success) {
            pops[city] = (pops[city] as number) - 1;
            chaos[city] = (chaos[city] as number) + (way.action.name === "Retirement" ? 0.04 : 0.02);
          }
          break;
        case "Investigation":
        case "Undercover Operation":
          if (!success && random() < (way.action.name === "Investigation" ? 0.1 : 0.15)) migration(city, random);
          break;
        case "Sting Operation":
          if (success) grow(city, -0.001);
          chaos[city] = (chaos[city] as number) + 0.1;
          break;
      }
      // Diplomacy as B4 spends it: the city back to 50, its time then.
      if ((chaos[city] as number) > 50) {
        const seconds = (60 * Math.log(50 / (chaos[city] as number))) / Math.log(keep);
        chaos[city] = 50;
        if (mine) {
          first.diplomacy += seconds;
          terms.firstDiplomacy += seconds;
        } else terms.otherDiplomacy += seconds;
        pass(seconds);
      }
    }
    times.push(clock);
    attemptsOf.push(attempts);
    if (phase >= policy.chain.length) {
      tailSeconds += clock - tailFrom;
      for (const k of made.keys()) tailMade[k] = (tailMade[k] as number) + (made[k] as number);
    }
  }
  for (const [key, each] of perWalk) {
    if (each.n > 0) {
      if (!perAction.has(key)) perAction.set(key, []);
      (perAction.get(key) as number[]).push(each.sum / each.n);
    }
  }
  void 0;
  return {
    perAction: new Map(
      [...perAction].map(([key, xs]) => [
        key,
        { ...meanOf(xs), walks: xs.length, pooled: (pooled.get(key)?.sum ?? 0) / (pooled.get(key)?.n ?? 1), n: (pooled.get(key)?.n ?? 0) / walks },
      ]),
    ),
    times,
    ...meanOf(times),
    tail: { made: tailMade, seconds: tailSeconds },
    chain: chainMade.map((made) => made / walks),
    attempts: attemptsOf.reduce((a, b) => a + b, 0) / walks,
    first: {
      attempts: first.attempts / walks,
      chance: first.attempts > 0 ? first.chance / first.attempts : 0,
      atMean: first.attempts > 0 ? first.atMean / first.attempts : 0,
      diplomacy: first.attempts > 0 ? first.diplomacy / first.attempts : 0,
      share: first.seconds / walks,
      meanClock: first.attempts > 0 ? first.clock / first.attempts : 0,
    },
    terms: Object.fromEntries(Object.entries(terms).map(([key, value]) => [key, value / walks])) as typeof terms,
  };
}
