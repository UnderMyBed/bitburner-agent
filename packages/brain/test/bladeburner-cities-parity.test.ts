// Bladeburner B4 (#383): core's cities and chaos against the engine's own figures, in the simulator, as B2's parity test
// (bladeburner-parity.test.ts) does. In BN6 with SF1.3, SF5.1 and SF7.1, the combat stats, hacking, charisma and
// intelligence moved off 1. Harness edits set each city's true population (to its estimate, so the game's range is the
// chance itself), estimate, communities and chaos, which a script can't.
// - The population and chaos between cities: every action's range read in each city (`switchCity`, then
//   `getActionEstimatedSuccessChance`) against the range read in Sector-12 scaled by core's `cityCompetenceRatio`; and
//   B2's forecast in each city from its own ranges against core's `chooseBladeburnerCity`'s from Sector-12's (Raid out
//   with no communities).
// - The decay: every city's chaos 0.0001 a second less over a tick (`nextUpdate`'s seconds).
// - Diplomacy: the chaos after one, core's `chaosAfterDiplomacy` of the chaos decayed over its last tick.
// - Incite Violence: every city's chaos after one, core's `chaosAfterIncite` of each decayed, and each count's rise
//   within its growth's range over the tick and the 180 s it adds.
import {
  BLADEBURNER_CITIES,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerCityReading,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  chaosAfterDiplomacy,
  chaosAfterIncite,
  chooseBladeburnerAction,
  chooseBladeburnerCity,
  cityCompetenceRatio,
  skillExpFor,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();
const ACTIONS = JSON.stringify(BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({ type, name })));
const CITIES = JSON.stringify(BLADEBURNER_CITIES);

/** Each city's figures: the true population its estimate, so the range is the chance; chaos either side of 50. */
const FIGURES: Record<string, { population: number; communities: number; chaos: number }> = {
  Aevum: { population: 1.4e9, communities: 30, chaos: 0 },
  Chongqing: { population: 0.9e9, communities: 0, chaos: 20 },
  "Sector-12": { population: 1.1e9, communities: 50, chaos: 55 },
  "New Tokyo": { population: 1.25e9, communities: 12, chaos: 80 },
  Ishima: { population: 1.6e9, communities: 7, chaos: 49.5 },
  Volhaven: { population: 1.05e9, communities: 90, chaos: 51 },
};

interface CityRead {
  city: BladeburnerCityReading;
  actions: { type: string; name: string; range: [number, number] }[];
}

test("core's cities, Diplomacy and Incite Violence are the engine's (#383)", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 5: 1, 7: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(160, 1.28));
  await sim.diagnostics.gainHackingExp(5_000);
  await sim.diagnostics.gainCharismaExp(3_000);
  await sim.diagnostics.gainIntelligenceExp(20_000);
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(100);
  for (const [city, each] of Object.entries(FIGURES)) {
    await sim.diagnostics.setBladeburnerFigures({ city, ...each, estimate: each.population });
  }

  // Every city's figures and every action's range there, at level 1 and full stamina.
  const { out, log } = await runScript(
    sim,
    `const cities = [];
for (const city of ${CITIES}) {
  ns.bladeburner.switchCity(city);
  const actions = [];
  for (const { type, name } of ${ACTIONS}) {
    ns.bladeburner.setActionLevel(type, name, 1);
    actions.push({ type, name, range: ns.bladeburner.getActionEstimatedSuccessChance(type, name) });
  }
  cities.push({
    city: {
      name: ns.bladeburner.getCity(),
      population: ns.bladeburner.getCityEstimatedPopulation(city),
      communities: ns.bladeburner.getCityCommunities(city),
      chaos: ns.bladeburner.getCityChaos(city),
    },
    actions,
  });
}
ns.bladeburner.switchCity("Sector-12");
out({ person: ns.getPlayer(), stamina: ns.bladeburner.getStamina(), cities });`,
  );
  expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  const read = out[0] as { person: unknown; stamina: [number, number]; cities: CityRead[] };
  const person = bladeburnerPersonOf(read.person) as BladeburnerPerson;
  expect(person.skills.charisma).toBeGreaterThan(1);
  expect(read.cities.map((each) => each.city.name)).toEqual([...BLADEBURNER_CITIES]);
  const home = read.cities.find((each) => each.city.name === "Sector-12") as CityRead;
  // The chaos read is the one set, less the decay since (at most a few seconds' 0.0001).
  for (const each of read.cities) {
    expect(each.city.chaos, each.city.name).toBeCloseTo(FIGURES[each.city.name]?.chaos ?? -1, 2);
    expect(each.city.population, each.city.name).toBe(FIGURES[each.city.name]?.population);
  }
  let compared = 0;
  for (const there of read.cities) {
    const ratio = cityCompetenceRatio(home.city, there.city) as number;
    for (const action of there.actions) {
      const fromHome = home.actions.find((each) => each.name === action.name)?.range as [number, number];
      const label = `${action.name} in ${there.city.name}`;
      if (action.name === "Raid" && there.city.communities === 0) {
        expect(action.range, label).toEqual([0, 0]);
        continue;
      }
      // Unclamped both sides, the range is Sector-12's times the ratio.
      if (fromHome[1] >= 1 || fromHome[1] * ratio >= 1) continue;
      expect(action.range[0], `${label}: the low end`).toBeCloseTo(fromHome[0] * ratio, 12);
      expect(action.range[1], `${label}: the high end`).toBeCloseTo(fromHome[1] * ratio, 12);
      compared++;
    }
  }
  expect(compared).toBeGreaterThan(30);

  // B2's forecast in each city from its own ranges, against core's from Sector-12's.
  const readingsOf = (city: CityRead): BladeburnerActionReading[] =>
    city.actions.map((each) => ({
      type: each.type as BladeburnerActionReading["type"],
      name: each.name,
      level: 1,
      maxLevel: 1,
      count: 100,
      chance: each.range,
    }));
  const forecast = (readings: BladeburnerActionReading[]) => ({
    readings,
    person,
    stamina: read.stamina[0],
    maxStamina: read.stamina[1],
    rankMultiplier: 1,
    speed: 1,
  });
  const choice = chooseBladeburnerCity(forecast(readingsOf(home)), {
    city: "Sector-12",
    cities: read.cities.map((each) => each.city),
  });
  if (choice === null) throw new Error("no choice");
  for (const there of read.cities) {
    const own = chooseBladeburnerAction(forecast(readingsOf(there))).rankPerSecond;
    const scaled = choice.byCity.find((each) => each.name === there.city.name)?.rankPerSecond;
    // Within the clamps: an action clamped at 1 in Sector-12 isn't credited a rise elsewhere (it errs low).
    expect(scaled, there.city.name).toBeLessThanOrEqual(own + 1e-12);
    if (home.actions.every((each) => each.range[1] < 1)) expect(scaled, there.city.name).toBeCloseTo(own, 12);
  }
  console.log(
    `the forecast by city: ${choice.byCity.map((each) => `${each.name} ${(each.rankPerSecond * 60).toFixed(3)}`).join(", ")} rank/min; chosen ${choice.city}`,
  );

  // The decay over a tick, every city; then Diplomacy in Sector-12 (chaos 55) and Incite Violence, each to its end.
  const chaosNow = `Object.fromEntries(${CITIES}.map((city) => [city, ns.bladeburner.getCityChaos(city)]))`;
  const countsNow = `Object.fromEntries(${ACTIONS}.map(({ type, name }) => [name, ns.bladeburner.getActionCountRemaining(type, name)]))`;
  for (const name of ["Diplomacy", "Incite Violence"]) {
    const { out: ticks, log: tickLog } = await runScript(
      sim,
      `ns.bladeburner.startAction("General", "${name}");
const read = () => ({ chaos: ${chaosNow}, counts: ${countsNow}, time: ns.bladeburner.getActionCurrentTime() });
for (let tick = 0; tick < 200; tick++) {
  const before = read();
  const ms = await ns.bladeburner.nextUpdate();
  const after = read();
  out({ before, after, ms, done: after.time < before.time });
  if (after.time < before.time) break;
}
ns.bladeburner.stopBladeburnerAction();`,
      400_000,
    );
    expect(tickLog.filter((line) => !line.startsWith("out:"))).toEqual([]);
    type Tick = {
      before: { chaos: Record<string, number>; counts: Record<string, number> };
      after: { chaos: Record<string, number>; counts: Record<string, number> };
      ms: number;
      done: boolean;
    };
    const all = ticks as Tick[];
    const last = all.at(-1) as Tick;
    expect(last.done, `${name} done`).toBe(true);
    // Every tick but the last: the decay alone, every city.
    let decayed = 0;
    for (const tick of all.slice(0, -1)) {
      for (const city of BLADEBURNER_CITIES) {
        const before = tick.before.chaos[city] as number;
        expect(tick.after.chaos[city], `${city}'s decay`).toBeCloseTo(
          Math.max(0, before - 0.0001 * (tick.ms / 1000)),
          12,
        );
        decayed++;
      }
    }
    expect(decayed).toBeGreaterThan(6 * 10);
    const seconds = last.ms / 1000;
    const decay = (city: string) => Math.max(0, (last.before.chaos[city] as number) - 0.0001 * seconds);
    if (name === "Diplomacy") {
      expect(last.after.chaos["Sector-12"]).toBeCloseTo(
        chaosAfterDiplomacy(decay("Sector-12"), person.skills.charisma),
        12,
      );
      for (const city of BLADEBURNER_CITIES.filter((each) => each !== "Sector-12")) {
        expect(last.after.chaos[city], city).toBeCloseTo(decay(city), 12);
      }
      console.log(
        `Diplomacy at charisma ${person.skills.charisma}: Sector-12's chaos ${last.before.chaos["Sector-12"]} → ` +
          `${last.after.chaos["Sector-12"]}`,
      );
      continue;
    }
    for (const city of BLADEBURNER_CITIES) {
      expect(last.after.chaos[city], `${city} incited`).toBeCloseTo(chaosAfterIncite(decay(city)), 12);
    }
    for (const { name: actionName } of BLADEBURNER_LEVELLED_ACTIONS) {
      const action = bladeburnerLevelledAction(
        BLADEBURNER_LEVELLED_ACTIONS.find((each) => each.name === actionName)?.type ?? "",
        actionName,
      );
      if (action === null) throw new Error(actionName);
      const rise = (last.after.counts[actionName] as number) - (last.before.counts[actionName] as number);
      // The tick's growth and the 180 s Incite Violence adds, each a random tenth over the range, over 480.
      const [low, high] = action.growth;
      expect(rise, `${actionName}'s count`).toBeGreaterThanOrEqual(((seconds + 180) * low) / 10 / 480 - 1e-9);
      expect(rise, `${actionName}'s count`).toBeLessThanOrEqual(((seconds + 180) * high) / 10 / 480 + 1e-9);
    }
    console.log(
      `Incite Violence: chaos ${BLADEBURNER_CITIES.map((city) => `${city} ${(last.before.chaos[city] as number).toFixed(2)} → ${(last.after.chaos[city] as number).toFixed(2)}`).join(", ")}`,
    );
  }
}, 240_000);
