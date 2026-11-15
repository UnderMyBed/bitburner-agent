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
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerLevelledAction,
  bladeburnerAttemptDrift,
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
