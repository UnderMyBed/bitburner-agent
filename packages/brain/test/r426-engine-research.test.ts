// #426, research only (R426_ENGINE=1; never in CI): the engine at #426's sampled replay-steps (re-chosen climbs, rebuilds,
// ratios past ×6.6; core's r426-harness.ts writes them), the engine run from the replay's drawn state over
// the step's opening attempts, its first-order step rate against core's replays' of the same attempts.
import { appendFileSync, readFileSync } from "node:fs";
import {
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerDriftCity,
  type BladeburnerLevelledAction,
  bladeburnerMostFactorCity,
  bladeburnerReplayAttempts,
  driftedChance,
  skillExpFor,
} from "@bitburner-agent/core";
import type { BladeburnerAttempt } from "@bitburner-agent/sim";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { describe, expect, test } from "vitest";

const SAMPLES_FILE = process.env.R426_SAMPLES ?? "";
const ROWS_FILE = process.env.R426_ENGINE_ROWS ?? "";
const start = useSimulations();
const action = (name: string) =>
  BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === name) as BladeburnerLevelledAction;
/** A step's opening attempts the engine runs (the cost's bound), and the replays of each run. */
const WINDOW = Number(process.env.R426_WINDOW ?? 60);
const REPLAYS = 1000;

interface Sample {
  category: string;
  route: string;
  bitNode: number;
  replay: number;
  segment: number;
  ratio: number;
  start: BladeburnerDriftCity[];
  worked: number;
  ceiling: number;
  reference: BladeburnerDriftCity;
  rate: number;
  seconds: number;
  dt: number;
  parts: {
    name: string;
    type: string;
    level: number;
    chance: number;
    perSecond: number;
    competence: number;
    plus: number;
  }[];
}

describe.runIf(process.env.R426_ENGINE === "1")("#426: the engine at the replays' states", () => {
  test("each sampled replay-step's opening: the engine's first-order rate against the replays', by z", async () => {
    const all = JSON.parse(readFileSync(SAMPLES_FILE, "utf8")) as Sample[];
    const limit = Number(process.env.R426_LIMIT ?? all.length);
    const from = Number(process.env.R426_FROM ?? 0);
    const samples = all.slice(from, from + limit);
    const sim = await start({
      seed: 9,
      epochMs: Date.UTC(2026, 0, 1),
      fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } },
    });
    await sim.diagnostics.setHomeRam(128);
    await sim.diagnostics.gainCombatExp(skillExpFor(Number(process.env.R426_COMBAT ?? 400), 1.28));
    expect((await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());")).out).toEqual([true]);
    await sim.diagnostics.setBladeburnerRank(150);
    const rows: {
      ratio: number;
      firstOrder: number;
      engine: number;
      sd: number;
      z: number;
      bitNode: number;
      attempts: number;
    }[] = [];
    const started = performance.now();
    for (const sample of samples) {
      // The step's opening attempts, each part's evenly over the step.
      const schedule = sample.parts
        .flatMap((part) => {
          const n = Math.round(part.perSecond * sample.dt);
          return Array.from({ length: n }, (_, j) => ({ t: ((j + 0.5) * sample.dt) / n, part }));
        })
        .sort((a, b) => a.t - b.t)
        .slice(0, WINDOW);
      const counts = Object.fromEntries(sample.parts.map((part) => [part.name, 10_000]));
      // Rested to full first (the route's competence has no stamina penalty): the regeneration chamber until full.
      await runScript(sim, 'ns.bladeburner.startAction("General", "Hyperbolic Regeneration Chamber");', 200);
      for (let k = 0; k < 200; k++) {
        const read = await runScript(sim, "out(ns.bladeburner.getStamina());", 1);
        const [stamina, max] = read.out[0] as [number, number];
        if (stamina >= max - 1e-6) break;
        await sim.advance(30_000);
      }
      await runScript(sim, "ns.bladeburner.stopBladeburnerAction();", 1);
      for (const [i, city] of sample.start.entries()) {
        await sim.diagnostics.setBladeburnerFigures({
          city: city.name,
          population: Math.round(city.population),
          estimate: Math.round(city.population),
          communities: Math.max(0, Math.round(city.communities)),
          chaos: city.chaos,
          ...(i === 0 ? { counts } : {}),
        });
      }
      const t0 = await sim.now();
      let worked = sample.worked;
      let skippedRaids = 0;
      const made: (BladeburnerAttempt & { at: number; part: Sample["parts"][number] })[] = [];
      for (const { t, part } of schedule) {
        const due = t0 + t * 1000 - (await sim.now());
        if (due > 0) await sim.advance(Math.round(due));
        const cities = (await sim.diagnostics.bladeburnerCities()) as BladeburnerDriftCity[];
        worked = bladeburnerMostFactorCity(cities, worked, part.name === "Raid", sample.ceiling);
        const city = cities[worked] as BladeburnerDriftCity;
        // Diplomacy as the replays take it (its time the route's): the city to its ceiling.
        if (part.name === "Raid" && !(city.communities >= 1)) {
          // Raid unavailable with no community (`data/Operations.ts:147-150`): no attempt, its chance 0 on both sides.
          skippedRaids++;
          continue;
        }
        if (city.chaos > sample.ceiling)
          await sim.diagnostics.setBladeburnerFigures({ city: city.name, chaos: sample.ceiling });
        const before = (await sim.diagnostics.bladeburnerAttempts()).length;
        await runScript(
          sim,
          `ns.bladeburner.switchCity(${JSON.stringify(city.name)});
ns.bladeburner.setActionAutolevel(${JSON.stringify(part.type)}, ${JSON.stringify(part.name)}, false);
ns.bladeburner.setActionLevel(${JSON.stringify(part.type)}, ${JSON.stringify(part.name)}, 1);
ns.bladeburner.startAction(${JSON.stringify(part.type)}, ${JSON.stringify(part.name)});`,
          200,
        );
        let attempts = await sim.diagnostics.bladeburnerAttempts(before);
        for (let k = 0; k < 120 && attempts.length === 0; k++) {
          await sim.advance(1000);
          attempts = await sim.diagnostics.bladeburnerAttempts(before);
        }
        await runScript(sim, "ns.bladeburner.stopBladeburnerAction();", 1);
        const at = ((await sim.now()) - t0) / 1000;
        for (const attempt of attempts) made.push({ ...attempt, at, part });
      }
      const end = ((await sim.now()) - t0) / 1000;
      // The first-order rate over the window: each part's drawn chance at the route's competence.
      const rateOf = (drawn: Map<string, { sum: number; n: number }>) => {
        let rate = sample.rate;
        for (const part of sample.parts) {
          const each = drawn.get(part.name);
          const p = each === undefined || each.n === 0 ? part.chance : each.sum / each.n;
          rate += part.perSecond * (p - part.chance) * part.plus;
        }
        return rate;
      };
      const engineDrawn = new Map<string, { sum: number; n: number }>(
        skippedRaids > 0 ? [["Raid", { sum: 0, n: skippedRaids }]] : [],
      );
      for (const attempt of made) {
        const city = {
          name: attempt.city,
          population: attempt.population,
          communities: attempt.communities,
          chaos: attempt.chaos,
        };
        const p = driftedChance(
          { action: action(attempt.name), chance: attempt.part.competence },
          sample.reference,
          city,
          sample.ceiling,
        );
        const each = engineDrawn.get(attempt.name) ?? { sum: 0, n: 0 };
        engineDrawn.set(attempt.name, { sum: each.sum + p, n: each.n + 1 });
      }
      const engine = rateOf(engineDrawn);
      // The replays of the engine's own attempts, at the route's competence.
      const begin = { cities: sample.start, worked: sample.worked, ceiling: sample.ceiling };
      const replayed = made.map((attempt) => {
        const each = action(attempt.name);
        // Their draws at the engine's own competence (its stamina, levels and person, as its draws had them), their
        // chance for the rate at the route's: the factor there times the route's competence.
        const city = {
          name: attempt.city,
          population: attempt.population,
          communities: attempt.communities,
          chaos: attempt.chaos,
        };
        const factor = driftedChance({ action: each, chance: 1e-6 }, sample.reference, city, sample.ceiling) / 1e-6;
        return {
          at: attempt.at,
          action: each,
          competence: factor > 0 ? attempt.chance / factor : 0,
          state: begin,
          route: attempt.part.competence,
        };
      });
      const rates: number[] = [];
      for (let r = 0; r < REPLAYS; r++) {
        const one = bladeburnerReplayAttempts(begin, sample.reference, replayed, {
          seed: 8800001 + 1000003 * (from + rows.length) + 7919 * r,
          end,
        });
        const drawn = new Map<string, { sum: number; n: number }>(
          skippedRaids > 0 ? [["Raid", { sum: 0, n: skippedRaids }]] : [],
        );
        for (const [k, attempt] of replayed.entries()) {
          const p = Math.min(1, attempt.route * (one.factors[k] as number));
          const each = drawn.get(attempt.action.name) ?? { sum: 0, n: 0 };
          drawn.set(attempt.action.name, { sum: each.sum + p, n: each.n + 1 });
        }
        rates.push(rateOf(drawn));
      }
      if (process.env.R426_DEBUG === "1") {
        const one = bladeburnerReplayAttempts(begin, sample.reference, replayed, { seed: 1, end });
        console.log(
          JSON.stringify({
            parts: sample.parts.map((p) => [p.name, p.chance, p.competence, p.perSecond, p.plus]),
            rate: sample.rate,
            start: sample.start.map((c) => [c.name, Math.round(c.population / 1e6), c.communities, c.chaos.toFixed(1)]),
            worked: sample.worked,
            engine: made.map((a) => [
              a.name,
              a.city,
              Math.round(a.population / 1e6),
              a.chaos.toFixed(1),
              a.chance.toFixed(3),
              a.at.toFixed(0),
            ]),
            replayCities: one.cities.map((c) => [c.name, Math.round(c.population / 1e6), c.chaos.toFixed(1)]),
            replayChances: [...one.chances].map((x) => x.toFixed(3)),
            engineDrawn: [...engineDrawn],
            skippedRaids,
          }),
        );
      }
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / (rates.length - 1));
      const z = sd > 0 ? (engine - mean) / sd : engine === mean ? 0 : Number.POSITIVE_INFINITY;
      rows.push({
        ratio: sample.ratio,
        firstOrder: mean,
        engine,
        sd,
        z,
        bitNode: sample.bitNode,
        attempts: made.length,
      });
      // Each comparison as it's made (a run cut short keeps what it measured).
      appendFileSync(
        ROWS_FILE,
        `${JSON.stringify({ ...rows.at(-1), category: sample.category, route: sample.route })}\n`,
      );
    }
    const ms = performance.now() - started;
    console.log(
      `R426E ${rows.length} comparisons in ${(ms / 1000).toFixed(1)} s (${(ms / Math.max(1, rows.length) / 1000).toFixed(2)} s each)`,
    );
    expect(rows.length).toBe(samples.length);
  }, 3_600_000);
});
