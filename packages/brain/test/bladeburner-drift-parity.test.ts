// Bladeburner #418: core's side effects of the operations and contracts against the engine's own, in the simulator.
// In BN6 with SF1.3, combat 160, rank 100; harness edits set Sector-12's true population (its estimate the truth),
// communities and chaos, and each action's count, which a script can't. A script works each action for its attempts;
// the simulator's record of attempts (`bladeburnerAttempts`) gives each one's city before it and just after its own
// effects (`completeOperation`, `completeContract`), before any time passes.
// - **Each attempt's effects** within the game's draws, by its success: Raid's population −1% (and its estimate, and a
//   community) or −0.5 to −1% (the estimate left), its chaos +1–5%; Sting's, Stealth Retirement's and Bounty Hunter's.
// - **Their mean** over the run against core's (`bladeburnerAttemptDrift`) at each attempt's own chance, within four
//   standard errors of the draws' own spread there.
// - **The chances after:** at the figures the run left (the estimate set to the truth: the range read a point), each
//   action's chance read against core's from the city's figures before the run through `driftedChance`.
// - **The route's replay against the engine** (#423): an hour of a grown route's opening mix played in the engine, its six
//   after the hour within 4 sd of core's replays (`bladeburnerReplayAttempts`) of the same attempts.
// - **The events and the decay over time** (#418's review): ten idle hours of the engine from the six at chaos 30, the
//   six's communities (never falling: the migrations move them), chaos (each city at least its decay's fall) and
//   population against core's mean (`bladeburnerEventDrift`), each within four standard deviations of the draws.
import {
  actionSuccessChance,
  BLADEBURNER_EVENT_SECONDS,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerDriftCity,
  type BladeburnerLevelledAction,
  bladeburnerAttemptDrift,
  bladeburnerMostFactorCity,
  bladeburnerReplayAttempts,
  bladeburnerEventDrift,
  bladeburnerPersonOf,
  driftedChance,
  skillExpFor,
  staminaPenalty,
} from "@bitburner-agent/core";
import type { BladeburnerAttempt } from "@bitburner-agent/sim";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";
import { attemptVariance } from "./helpers/drift-prediction.ts";

const start = useSimulations();

const RUNS: { type: string; name: string; attempts: number }[] = [
  { type: "Operations", name: "Raid", attempts: 30 },
  { type: "Operations", name: "Sting Operation", attempts: 20 },
  { type: "Operations", name: "Stealth Retirement Operation", attempts: 10 },
  { type: "Contracts", name: "Bounty Hunter", attempts: 20 },
];

const action = (name: string) =>
  BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name) as BladeburnerLevelledAction;

test("core's attempt effects and the chances after them are the engine's (#418)", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(160, 1.28));
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(100);
  // Chaos 40: Raid's +1–5% an attempt takes it over 50 within the run, where the chaos factor bites.
  await sim.diagnostics.setBladeburnerFigures({
    city: "Sector-12",
    population: 1.2e9,
    estimate: 1.2e9,
    communities: 40,
    chaos: 40,
    counts: Object.fromEntries(RUNS.map((run) => [run.name, run.attempts + 5])),
  });
  const before = (await sim.diagnostics.bladeburnerAttempts()).length;
  const { log } = await runScript(
    sim,
    `ns.bladeburner.switchCity("Sector-12");
for (const { type, name, attempts } of ${JSON.stringify(RUNS)}) {
  ns.bladeburner.setActionAutolevel(type, name, false);
  ns.bladeburner.setActionLevel(type, name, 1);
  let done = 0;
  let count = ns.bladeburner.getActionCountRemaining(type, name);
  ns.bladeburner.startAction(type, name);
  while (done < attempts) {
    await ns.bladeburner.nextUpdate();
    const now = ns.bladeburner.getActionCountRemaining(type, name);
    // An attempt uses one; the count regrows a little each tick (Bladeburner.ts:1387-1393).
    if (now < count - 0.5) done += 1;
    count = now;
    // Rested before the next attempt's cost (taken before its draw, Bladeburner.ts:921-927, at most 3 here) could
    // take the stamina under half the max: the penalty stays out of every chance drawn.
    const [stamina, max] = ns.bladeburner.getStamina();
    if (stamina - 3 < max / 2) {
      ns.bladeburner.startAction("General", "Hyperbolic Regeneration Chamber");
      while (ns.bladeburner.getStamina()[0] < ns.bladeburner.getStamina()[1]) await ns.bladeburner.nextUpdate();
      ns.bladeburner.startAction(type, name);
      count = ns.bladeburner.getActionCountRemaining(type, name);
    }
  }
  ns.bladeburner.stopBladeburnerAction();
}
out("done");`,
    // The runs and their rests in virtual time: about 2 h.
    4 * 3_600_000,
  );
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const attempts = (await sim.diagnostics.bladeburnerAttempts(before)).filter((attempt) =>
    RUNS.some((run) => run.name === attempt.name),
  );
  const rows: string[] = [];
  for (const run of RUNS) {
    const mine = attempts.filter((attempt) => attempt.name === run.name);
    // The script counts the count's falls (one a tick at most, so it can miss or over-count by a few); the engine's
    // record is the attempts' own, at least half the run's.
    expect(mine.length, run.name).toBeGreaterThan(run.attempts / 2);
    const each = action(run.name);
    // The population's and the chaos's ratio over the attempt, against core's mean at the attempt's own chance.
    const observed = { population: [] as number[], chaos: [] as number[] };
    let expectedPopulation = 0;
    let expectedChaos = 0;
    // The draws' own variance at each attempt's chance (the model's, not the run's: a run of all failures has none).
    let populationVariance = 0;
    let chaosVariance = 0;
    for (const attempt of mine) {
      expect(attempt.city).toBe("Sector-12");
      checkDraw(run.name, attempt);
      const drift = bladeburnerAttemptDrift(each, attempt.chance, attempt.communities);
      observed.population.push(attempt.after.population / attempt.population);
      expectedPopulation += drift.populationScale;
      observed.chaos.push(attempt.after.chaos - attempt.chaos);
      expectedChaos += attempt.chaos * (drift.chaosScale - 1) + drift.chaosAdd;
      const own = attemptVariance(attempt);
      populationVariance += own.population / attempt.population ** 2;
      chaosVariance += own.chaos;
    }
    const n = mine.length;
    const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const error = { population: Math.sqrt(populationVariance) / n, chaos: Math.sqrt(chaosVariance) / n };
    const population = mean(observed.population);
    const chaos = mean(observed.chaos);
    rows.push(
      `${run.name}: ${n} attempts; the population ×${population.toFixed(5)} an attempt against core's ` +
        `×${(expectedPopulation / n).toFixed(5)} (± ${error.population.toFixed(5)}); the chaos ` +
        `${chaos >= 0 ? "+" : ""}${chaos.toFixed(4)} against ${(expectedChaos / n).toFixed(4)} (± ${error.chaos.toFixed(4)})`,
    );
    // Four standard errors (and the draws' integer rounding, a part in 10⁹ of the population).
    expect(Math.abs(population - expectedPopulation / n), run.name).toBeLessThanOrEqual(4 * error.population + 1e-8);
    expect(Math.abs(chaos - expectedChaos / n), run.name).toBeLessThanOrEqual(4 * error.chaos + 1e-9);
  }
  // The chances after the run: at the figures the attempts left (the estimate set to the truth, so the range read is
  // the chance), each action's at level 1, the engine's against core's from the read city's first chance through the
  // drift's factor, the person's own rise (the actions' experience) taken out by core's formula at both.
  const [city] = (await sim.diagnostics.bladeburnerCities()).filter((each) => each.name === "Sector-12");
  if (city === undefined) throw new Error("no Sector-12");
  await sim.diagnostics.setBladeburnerFigures({ city: "Sector-12", estimate: city.population });
  const after = await runScript(
    sim,
    `ns.bladeburner.switchCity("Sector-12");
const out2 = [];
for (const { type, name } of ${JSON.stringify(RUNS)}) {
  ns.bladeburner.setActionLevel(type, name, 1);
  out2.push({ name, range: ns.bladeburner.getActionEstimatedSuccessChance(type, name) });
}
out({ ranges: out2, player: ns.getPlayer(), stamina: ns.bladeburner.getStamina() });`,
  );
  const read = after.out[0] as {
    ranges: { name: string; range: [number, number] }[];
    player: unknown;
    stamina: [number, number];
  };
  const person = bladeburnerPersonOf(read.player);
  if (person === null) throw new Error("no person");
  const penalty = staminaPenalty(read.stamina[0], read.stamina[1]);
  const figuresBefore = { population: 1.2e9, communities: 40, chaos: 40 };
  for (const { name, range } of read.ranges) {
    const each = action(name);
    const atStart = actionSuccessChance(each, 1, person, { city: figuresBefore, penalty });
    const drifted = driftedChance({ action: each, chance: atStart }, figuresBefore, { ...city, name: "Sector-12" });
    expect(range[0], `${name}'s range a point`).toBeCloseTo(range[1], 12);
    expect(drifted, `${name}'s chance after the run`).toBeCloseTo(range[0], 9);
  }
  rows.push(
    `after the run, Sector-12 at ${(city.population / 1e6).toFixed(1)}m, chaos ${city.chaos.toFixed(2)}, ` +
      `${city.communities} communities: ${read.ranges.map(({ name, range }) => `${name} ${(100 * range[0]).toFixed(2)}%`).join(", ")}, core's the same`,
  );
  console.log(rows.join("\n"));
}, 600_000);

/** An attempt's change within the game's draws (`Bladeburner.ts:796-890`, `City.ts`), by its success. */
function checkDraw(name: string, attempt: BladeburnerAttempt): void {
  const { after } = attempt;
  const change = after.population - attempt.population;
  // `clampInteger` rounds (`utils/helpers/clampNumber.ts:17-23`).
  const percent = (p: number) => Math.round(attempt.population * (p / 100));
  switch (name) {
    case "Raid":
      if (attempt.success) {
        expect(change).toBe(percent(-1));
        expect(after.estimate - attempt.estimate).toBe(change);
        expect(after.communities).toBe(attempt.communities - 1);
      } else {
        expect(change).toBeGreaterThanOrEqual(percent(-1));
        expect(change).toBeLessThanOrEqual(percent(-0.5));
        expect(after.estimate).toBe(attempt.estimate);
      }
      expect(after.chaos / attempt.chaos).toBeGreaterThanOrEqual(1.01 - 1e-12);
      expect(after.chaos / attempt.chaos).toBeLessThanOrEqual(1.05 + 1e-12);
      break;
    case "Sting Operation":
      expect(change).toBe(attempt.success ? percent(-0.1) : 0);
      expect(after.chaos - attempt.chaos).toBeCloseTo(0.1, 12);
      break;
    case "Stealth Retirement Operation":
      expect(change).toBe(attempt.success ? percent(-0.5) : 0);
      expect(after.chaos / attempt.chaos).toBeGreaterThanOrEqual(0.97 - 1e-12);
      expect(after.chaos / attempt.chaos).toBeLessThanOrEqual(0.99 + 1e-12);
      break;
    case "Bounty Hunter":
      expect(change).toBe(attempt.success ? -1 : 0);
      expect(after.chaos - attempt.chaos).toBeCloseTo(attempt.success ? 0.02 : 0, 12);
      break;
  }
}

/** Idle hours of the engine's events (#418's review: an engine check of the events and migration over time). */
const IDLE_HOURS = 10;

test("the engine's events and decay over idle hours against core's mean (#418's review)", async () => {
  // The six at chaos 30 (over 1.08, where the riots' mean outruns the decay; no clamp at 0 in the window), each its
  // population and communities as the BitNode starts them, no action: the events' and the decay's alone
  // (`Bladeburner.ts:1395-1409`, `randomEvent` `:601-699`).
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(160, 1.28));
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  for (const city of await sim.diagnostics.bladeburnerCities()) {
    await sim.diagnostics.setBladeburnerFigures({ city: city.name, chaos: 30 });
  }
  const before = await sim.diagnostics.bladeburnerCities();
  const seconds = IDLE_HOURS * 3600;
  await sim.advance(seconds * 1000);
  const after = await sim.diagnostics.bladeburnerCities();
  const events = seconds / BLADEBURNER_EVENT_SECONDS;
  const rates = bladeburnerEventDrift(before);
  const sum = (xs: number[]) => xs.reduce((total, x) => total + x, 0);
  const rows: string[] = [];
  // The communities: the events move them (a community's migration, a migration's 5%) and add them (a new one, or one
  // where there are none), never take one, so the six's total never falls; its rise a count of the new ones, 0.05 an
  // event (more where a city has none: none here), against core's mean, within 4 of its Poisson's standard deviations.
  const communities = sum(after.map((city) => city.communities)) - sum(before.map((city) => city.communities));
  const communitiesMean = sum(rates.map((rate) => rate.communities)) * seconds;
  expect(communities).toBeGreaterThanOrEqual(0);
  expect(Math.abs(communities - communitiesMean)).toBeLessThanOrEqual(4 * Math.sqrt(communitiesMean));
  rows.push(`the communities +${communities} over the six, core's mean +${communitiesMean.toFixed(2)}`);
  // The chaos: each city's decay 0.0001 a second exactly (no clamp from 30), each riot (chaos + 1) × 1.05–1.20 on top,
  // so each city at least its decay's fall; the six's rise against core's mean, within 4 standard deviations of the
  // riots' draws (each event a riot in a city with chance 0.2 / 6, at the chaos read).
  for (const [i, city] of after.entries()) {
    const read = before[i] as (typeof before)[number];
    expect(city.name).toBe(read.name);
    expect(city.chaos, city.name).toBeGreaterThanOrEqual(read.chaos - 0.0001 * seconds - 1e-9);
  }
  const chaos = sum(after.map((city) => city.chaos)) - sum(before.map((city) => city.chaos));
  const chaosMean = sum(rates.map((rate) => rate.chaos - 0.0001)) * seconds;
  let riotSquare = 0;
  for (const city of before) {
    for (let u = 5; u <= 20; u++) riotSquare += ((city.chaos + 1) * (1 + u / 100) - city.chaos) ** 2 / 16;
  }
  const chaosError = Math.sqrt(events * (0.2 / before.length) * riotSquare);
  expect(Math.abs(chaos - chaosMean)).toBeLessThanOrEqual(4 * chaosError);
  rows.push(
    `the chaos ${chaos >= 0 ? "+" : ""}${chaos.toFixed(2)} over the six, core's mean +${chaosMean.toFixed(2)} (± ${chaosError.toFixed(2)})`,
  );
  // The population: the migrations move it (their total kept, but for the +100 under 1.5e9, `:597-598`), the growths
  // and the falls change it; the six's change against core's mean, within 4 standard deviations of the events' draws.
  const population = sum(after.map((city) => city.population)) - sum(before.map((city) => city.population));
  const populationMean = sum(rates.map((rate) => rate.population)) * seconds;
  let shareSquare = 0;
  const squareOf = (low: number, high: number) => {
    let total = 0;
    for (let u = low; u <= high; u++) total += (u / 100) ** 2;
    return total / (high - low + 1);
  };
  // A new community's +10–20% (0.05), new Synthoids' +8–24% (0.2) and fewer Synthoids' −8–20% (0.2).
  for (const city of before) {
    shareSquare += city.population ** 2 * (0.05 * squareOf(10, 20) + 0.2 * squareOf(8, 24) + 0.2 * squareOf(8, 20));
  }
  const populationError = Math.sqrt((events * shareSquare) / before.length);
  expect(Math.abs(population - populationMean)).toBeLessThanOrEqual(4 * populationError);
  rows.push(
    `the population ${population >= 0 ? "+" : ""}${(population / 1e6).toFixed(1)}m over the six, core's mean ` +
      `+${(populationMean / 1e6).toFixed(1)}m (± ${(populationError / 1e6).toFixed(1)}m)`,
  );
  console.log(`${IDLE_HOURS} h idle (about ${events.toFixed(0)} events): ${rows.join("; ")}`);
}, 600_000);

/**
 * The six as bn6-skills' seed 1 read them at its first reading (#423's ruling 4: its grown route's start), and that
 * route's opening mix: Bounty Hunter at 0.00784 and Raid at 0.004375 attempts a second (its first two steps').
 */
const ROUTE_SIX: BladeburnerDriftCity[] = [
  { name: "Aevum", population: 1334171155, communities: 101, chaos: 0 },
  { name: "Chongqing", population: 1030015296, communities: 139, chaos: 0 },
  { name: "Sector-12", population: 1279441505, communities: 32, chaos: 0 },
  { name: "New Tokyo", population: 1330126431, communities: 13, chaos: 0 },
  { name: "Ishima", population: 905424372, communities: 106, chaos: 0 },
  { name: "Volhaven", population: 1232320344, communities: 73, chaos: 0 },
];
const ROUTE_MIX = [
  { name: "Bounty Hunter", type: "Contracts", perSecond: 0.00784 },
  { name: "Raid", type: "Operations", perSecond: 0.004375 },
];
/** The engine's seeds (each a run of the hour), and the replays of each run's attempts. */
const ROUTE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const ROUTE_REPLAYS = 1000;

test("a grown route's opening hour (#423): the engine's six after it within 4 sd of core's replays of its attempts", async () => {
  const hour = 3600;
  // The route's attempts in the hour, each action's evenly over it (the replays' own spreading of a step).
  const schedule = ROUTE_MIX.flatMap(({ name, type, perSecond }) => {
    const n = Math.round(perSecond * hour);
    return Array.from({ length: n }, (_, j) => ({ t: ((j + 0.5) * hour) / n, name, type }));
  }).sort((a, b) => a.t - b.t);
  const reference = ROUTE_SIX[0] as BladeburnerDriftCity;
  const begin = { cities: ROUTE_SIX, worked: 0, ceiling: 50 };
  const rows: string[] = [];
  const zs = new Map<string, number[]>();
  let worst = 0;
  for (const seed of ROUTE_SEEDS) {
    const sim = await routeEngine(seed);
    for (const city of ROUTE_SIX) {
      await sim.diagnostics.setBladeburnerFigures({
        city: city.name,
        population: city.population,
        estimate: city.population,
        communities: city.communities,
        chaos: city.chaos,
        ...(city === reference ? { counts: { "Bounty Hunter": 500, Raid: 500 } } : {}),
      });
    }
    const t0 = await sim.now();
    let worked = 0;
    const made: (BladeburnerAttempt & { at: number })[] = [];
    for (const { t, name, type } of schedule) {
      const due = t0 + t * 1000 - (await sim.now());
      if (due > 0) await sim.advance(Math.round(due));
      // B4's pick by the true figures, core's own chooser.
      const cities = (await sim.diagnostics.bladeburnerCities()) as BladeburnerDriftCity[];
      worked = bladeburnerMostFactorCity(cities, worked, name === "Raid", 50);
      const before = (await sim.diagnostics.bladeburnerAttempts()).length;
      await runScript(
        sim,
        `ns.bladeburner.switchCity(${JSON.stringify((cities[worked] as BladeburnerDriftCity).name)});
ns.bladeburner.setActionAutolevel(${JSON.stringify(type)}, ${JSON.stringify(name)}, false);
ns.bladeburner.setActionLevel(${JSON.stringify(type)}, ${JSON.stringify(name)}, 1);
ns.bladeburner.startAction(${JSON.stringify(type)}, ${JSON.stringify(name)});`,
        200,
      );
      let attempts = await sim.diagnostics.bladeburnerAttempts(before);
      for (let k = 0; k < 600 && attempts.length === 0; k++) {
        await sim.advance(1000);
        attempts = await sim.diagnostics.bladeburnerAttempts(before);
      }
      await runScript(sim, "ns.bladeburner.stopBladeburnerAction();", 1);
      const at = ((await sim.now()) - t0) / 1000;
      for (const attempt of attempts) made.push({ ...attempt, at });
    }
    const left = t0 + hour * 1000 - (await sim.now());
    if (left > 0) await sim.advance(Math.round(left));
    const end = ((await sim.now()) - t0) / 1000;
    const after = (await sim.diagnostics.bladeburnerCities()) as BladeburnerDriftCity[];
    expect(made.length, `seed ${seed}`).toBe(schedule.length);
    // Each attempt's competence: the engine's chance over its city's factor then (core's formula at a tiny chance).
    const replayed = made.map((attempt) => {
      const each = action(attempt.name);
      const city = { name: attempt.city, population: attempt.population, communities: attempt.communities, chaos: attempt.chaos };
      const factor = driftedChance({ action: each, chance: 1e-6 }, reference, city, 50) / 1e-6;
      return { at: attempt.at, action: each, competence: attempt.chance / factor, state: begin };
    });
    const figures = after.map(() => ({ population: [] as number[], communities: [] as number[], chaos: [] as number[] }));
    const successes: number[] = [];
    for (let r = 0; r < ROUTE_REPLAYS; r++) {
      // The replays' seeds apart from the engine's: 9500001 + 1000003·seed + 7919·replay.
      const one = bladeburnerReplayAttempts(begin, reference, replayed, {
        seed: 9500001 + 1000003 * seed + 7919 * r,
        end,
      });
      successes.push(one.successes);
      for (const [i, city] of one.cities.entries()) {
        const out = figures[i] as (typeof figures)[number];
        out.population.push(city.population);
        out.communities.push(city.communities);
        out.chaos.push(city.chaos);
      }
    }
    const stat = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) };
    };
    const far: string[] = [];
    const zOf = (label: string, value: number, xs: number[]) => {
      const { mean, sd } = stat(xs);
      const z = sd > 0 ? (value - mean) / sd : value === mean ? 0 : Number.POSITIVE_INFINITY;
      zs.set(label, [...(zs.get(label) ?? []), z]);
      // The six's riots in an hour (about 1.7, a Poisson's) too few for a bar in sd at one seed: theirs over the seeds.
      if (!label.startsWith("the six's")) worst = Math.max(worst, Math.abs(z));
      if (Math.abs(z) > 2.5) {
        far.push(`${label} z ${z.toFixed(2)} (${value.toPrecision(4)} against ${mean.toPrecision(4)} ± ${sd.toPrecision(3)})`);
      }
    };
    // Each city's population (the drain's and the events'), and as #418's check does, the six's communities and chaos
    // together (a city's alone is mostly 0 or a count of riots in an hour).
    const total = (pick: (out: (typeof figures)[number]) => number[]) =>
      Array.from({ length: ROUTE_REPLAYS }, (_, r) => figures.reduce((sum, out) => sum + (pick(out)[r] as number), 0));
    for (const [i, city] of after.entries()) {
      zOf(`${city.name}'s population`, city.population, (figures[i] as (typeof figures)[number]).population);
    }
    zOf("the six's communities", after.reduce((sum, city) => sum + city.communities, 0), total((out) => out.communities));
    zOf("the six's chaos", after.reduce((sum, city) => sum + city.chaos, 0), total((out) => out.chaos));
    zOf("the successes", made.filter((a) => a.success).length, successes);
    rows.push(`seed ${seed}: ${made.length} attempts; past 2.5 sd: ${far.join(", ") || "none"}`);
  }
  // Each population and the successes within 4 sd of the replays (their draws' own spread) at every seed, and every
  // figure's mean z over the seeds within 4 standard errors of such a mean. The six's chaos and communities by that mean
  // alone: an hour has about 1.7 riots (a Poisson's: one seed's 5, its chance about 3%, is 4 of its sd).
  const bound = 4 / Math.sqrt(ROUTE_SEEDS.length);
  const meanZ = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const off = [...zs].filter(([, xs]) => Math.abs(meanZ(xs)) > bound);
  console.log(
    `a grown route's opening hour, ${ROUTE_SEEDS.length} engine runs against ${ROUTE_REPLAYS} replays each: ` +
      `${rows.join("; ")}; the worst |z| ${worst.toFixed(2)}; the mean z past ${bound.toFixed(2)}: ` +
      `${off.map(([label, xs]) => `${label} ${meanZ(xs).toFixed(2)}`).join(", ") || "none"}`,
  );
  expect(worst).toBeLessThanOrEqual(4);
  expect(off).toEqual([]);
}, 600_000);

/** A BN6 engine as the route's check starts it: SF1.3, combat 100, the division joined at rank 150. */
async function routeEngine(seed: number) {
  const sim = await start({
    seed,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(100, 1.28));
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(150);
  return sim;
}
