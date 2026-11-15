// #423 research instrument (not for merge), ruling 4 item 3: the route walk's fidelity against the full simulator.
// The bn6-skills route's opening hour (Bounty Hunter and Raid at the route's rates, from that reading's six cities)
// played in the simulator by a harness that picks each attempt's city as B4 does (the most true population^0.7 over
// the chaos's factor, Raid's among those with communities), recording each attempt and the six after the hour. The
// core research test replays the same attempts in its walks and judges the simulator's figures within 4 sd.
import { readFileSync, writeFileSync } from "node:fs";
import { skillExpFor } from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const DIR = "C:/Users/Matt/AppData/Local/Temp/claude/f9d10e1727648ecd/8fa44f8b-3eb6-48ce-9496-c91c002b8eb4/scratchpad/m4/423/";
const start = useSimulations();
const HOUR = 3600;

interface City {
  name: string;
  population: number;
  communities: number;
  chaos: number;
}

const chaosFactor = (chaos: number) => (chaos > 50 ? Math.sqrt(1 + chaos - 50) : 1);
const factorOf = (city: City) => Math.max(0, city.population) ** 0.7 / chaosFactor(city.chaos);

test("R423 fidelity: the route's opening hour in the simulator", async () => {
  const route = JSON.parse(readFileSync(`${DIR}route-bn6-skills.json`, "utf8")).after as {
    steps: {
      kind: string;
      seconds: number;
      dt: number;
      parts: { name: string; perSecond: number }[];
      state: { cities: City[] };
    }[];
  };
  const climbs = route.steps.filter((s) => s.kind === "climb");
  const read = (climbs[0] as (typeof climbs)[number]).state.cities;
  // The route's attempts in its first hour, each climb step's parts evenly over it.
  const schedule: { t: number; name: string }[] = [];
  for (const step of climbs) {
    if (step.seconds >= HOUR) break;
    for (const part of step.parts) {
      const n = Math.round(part.perSecond * step.dt);
      for (let j = 0; j < n; j++) {
        const t = step.seconds + ((j + 0.5) * step.dt) / n;
        if (t < HOUR) schedule.push({ t, name: part.name });
      }
    }
  }
  schedule.sort((a, b) => a.t - b.t);
  const seeds = (process.env.R423_SIM_SEEDS ?? "1,2,3").split(",").map(Number);
  const runs: unknown[] = [];
  for (const seed of seeds) {
    const sim = await start({ seed, epochMs: Date.UTC(2026, 0, 1), fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3 } } });
    await sim.diagnostics.setHomeRam(128);
    await sim.diagnostics.gainCombatExp(skillExpFor(100, 1.28));
    const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
    expect(joined.out).toEqual([true]);
    await sim.diagnostics.setBladeburnerRank(150);
    for (const city of read) {
      await sim.diagnostics.setBladeburnerFigures({
        city: city.name,
        population: city.population,
        estimate: city.population,
        communities: Math.round(city.communities),
        chaos: city.chaos,
        ...(city.name === read[0]?.name ? { counts: { "Bounty Hunter": 500, Raid: 500 } } : {}),
      });
    }
    const t0 = await sim.now();
    const startCities = (await sim.diagnostics.bladeburnerCities()) as City[];
    const made: unknown[] = [];
    for (const { t, name } of schedule) {
      const now = await sim.now();
      const due = t0 + t * 1000 - now;
      if (due > 0) await sim.advance(Math.round(due));
      const cities = (await sim.diagnostics.bladeburnerCities()) as City[];
      const raid = name === "Raid";
      let best: City | null = null;
      for (const city of cities) {
        if (raid && !(city.communities > 0)) continue;
        if (best === null || factorOf(city) > factorOf(best)) best = city;
      }
      if (best === null) continue;
      const before = (await sim.diagnostics.bladeburnerAttempts()).length;
      const type = raid ? "Operations" : "Contracts";
      await runScript(
        sim,
        `ns.bladeburner.switchCity(${JSON.stringify(best.name)});
ns.bladeburner.setActionAutolevel(${JSON.stringify(type)}, ${JSON.stringify(name)}, false);
ns.bladeburner.setActionLevel(${JSON.stringify(type)}, ${JSON.stringify(name)}, 1);
ns.bladeburner.startAction(${JSON.stringify(type)}, ${JSON.stringify(name)});`,
        200,
      );
      let attempts = (await sim.diagnostics.bladeburnerAttempts(before)) as unknown[];
      for (let k = 0; k < 600 && attempts.length === 0; k++) {
        await sim.advance(1000);
        attempts = (await sim.diagnostics.bladeburnerAttempts(before)) as unknown[];
      }
      await runScript(sim, "ns.bladeburner.stopBladeburnerAction();", 1);
      const done = await sim.now();
      for (const attempt of attempts) made.push({ ...(attempt as object), atSeconds: (done - t0) / 1000 });
    }
    const now = await sim.now();
    if (t0 + HOUR * 1000 > now) await sim.advance(Math.round(t0 + HOUR * 1000 - now));
    const endCities = (await sim.diagnostics.bladeburnerCities()) as City[];
    runs.push({ seed, startCities, made, endCities, endSeconds: ((await sim.now()) - t0) / 1000 });
    console.log(`R423 sim seed ${seed}: ${made.length} attempts of ${schedule.length} scheduled; the hour ended at ${(((await sim.now()) - t0) / 1000).toFixed(0)} s`);
  }
  writeFileSync(`${DIR}fidelity-sim.json`, JSON.stringify({ schedule, runs }));
}, 1_200_000);
