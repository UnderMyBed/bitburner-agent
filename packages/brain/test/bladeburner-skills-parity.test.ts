// Bladeburner B3 (#379): core's skills against the engine's own figures, in the simulator, as B2's parity test does
// (bladeburner-parity.test.ts). In BN6 with SF1.3, SF5.1 and SF7.1, the combat stats, hacking, charisma and
// intelligence moved off 1, the rank set by a harness edit through the game's own change (its points with it):
// - the points: one for each 3 of the max rank (`Bladeburner.ts:1284-1293`);
// - every skill's cost (`getSkillUpgradeCost`) for 1, 3 and 10 levels, at 0 and at the levels bought, Overclock's past
//   its max Infinity; and the points each `upgradeSkill` takes;
// - at those levels, every contract's and operation's estimate's range and time, over three cities and stamina at full
//   and a quarter, the max stamina and its regain over a tick: each skill's effect (`Bladeburner.ts:776-786`);
// - the BitNodes' `BladeburnerSkillCost`.
import {
  actionSeconds,
  actionSuccessChance,
  actionSuccessRange,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerPerson,
  type BladeburnerSkillLevels,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerSkill,
  bladeburnerSkillCost,
  bladeburnerSkillCostMultiplierOf,
  bladeburnerSkillMultsOf,
  maxStaminaOf,
  skillExpFor,
  staminaGainPerSecond,
  staminaPenalty,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();
const ACTIONS = JSON.stringify(BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({ type, name })));
const SKILLS = JSON.stringify(BLADEBURNER_SKILL_NAMES);
/** The levels bought: every skill, Overclock to 89 (one short of its max), and some of each other. */
const LEVELS: BladeburnerSkillLevels = {
  "Blade's Intuition": 4,
  Cloak: 3,
  "Short-Circuit": 2,
  "Digital Observer": 2,
  Tracer: 5,
  Overclock: 89,
  Reaper: 3,
  "Evasive System": 2,
  Datamancer: 1,
  "Cyber's Edge": 4,
  "Hands of Midas": 1,
  Hyperdrive: 1,
};
const CASES = [
  { population: 1.2e9, estimate: 1.2e9, communities: 50, chaos: 0, share: 1, level: 1 },
  { population: 1e9, estimate: 1.4e9, communities: 20, chaos: 10, share: 1, level: 3 },
  { population: 1.4e9, estimate: 0.9e9, communities: 5, chaos: 75, share: 0.25, level: 5 },
];

interface Costs {
  points: number;
  levels: Record<string, number>;
  /** Each as a string: JSON has no Infinity. */
  costs: Record<string, [string, string, string]>;
}
/** Each skill's level and its cost for 1, 3 and 10 levels from there, and the points unspent. */
const READ_COSTS = `const read = () => ({
  points: ns.bladeburner.getSkillPoints(),
  levels: Object.fromEntries(${SKILLS}.map((name) => [name, ns.bladeburner.getSkillLevel(name)])),
  costs: Object.fromEntries(${SKILLS}.map((name) => [name, [1, 3, 10].map((count) => String(ns.bladeburner.getSkillUpgradeCost(name, count)))])),
});`;

test("core's skill costs and effects are the engine's (#379): the points, the costs, the range, the time and the stamina", async () => {
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
  // 30,000 rank: 10,000 points, one for each 3.
  await sim.diagnostics.setBladeburnerRank(30_000);

  // The BitNodes' cost multipliers.
  for (const bitNode of [6, 7]) {
    const multipliers = (await sim.diagnostics.bitNodeMultipliers(bitNode, 1)) as { BladeburnerSkillCost: number };
    expect(bladeburnerSkillCostMultiplierOf(bitNode), `BN${bitNode}`).toBe(multipliers.BladeburnerSkillCost);
  }

  // The costs at 0; each skill bought to its level in one call, its points the cost core gives; the costs there.
  const { out, log } = await runScript(
    sim,
    `${READ_COSTS}
const before = read();
const bought = [];
for (const [name, level] of Object.entries(${JSON.stringify(LEVELS)})) {
  const points = ns.bladeburner.getSkillPoints();
  const ok = ns.bladeburner.upgradeSkill(name, level);
  bought.push({ name, level, ok, spent: points - ns.bladeburner.getSkillPoints() });
}
out({ before, bought, after: read() });`,
  );
  expect(log.filter((line) => !line.startsWith("out:") && !line.includes("Upgraded skill"))).toEqual([]);
  const { before, bought, after } = out[0] as {
    before: Costs;
    bought: { name: string; level: number; ok: boolean; spent: number }[];
    after: Costs;
  };
  expect(before.points).toBe(10_000);
  let compared = 0;
  for (const [costs, label] of [
    [before, "at 0"],
    [after, "at the levels bought"],
  ] as const) {
    for (const name of BLADEBURNER_SKILL_NAMES) {
      const skill = bladeburnerSkill(name);
      if (skill === null) throw new Error(`no ${name}`);
      const level = costs.levels[name] as number;
      expect(level, `${name} ${label}`).toBe(label === "at 0" ? 0 : LEVELS[name]);
      [1, 3, 10].forEach((count, index) => {
        expect(bladeburnerSkillCost(skill, level, count, 1), `${name}'s ${count} from ${level}`).toBe(
          Number(costs.costs[name]?.[index]),
        );
        compared++;
      });
    }
  }
  expect(compared).toBe(72);
  // Overclock at 89: one more is 128, two or more past the max are Infinity, as core has it.
  expect(after.costs.Overclock).toEqual(["128", "Infinity", "Infinity"]);
  let spent = 0;
  for (const each of bought) {
    const skill = bladeburnerSkill(each.name);
    if (skill === null) throw new Error(`no ${each.name}`);
    expect(each.ok, each.name).toBe(true);
    expect(each.spent, `${each.name}'s points`).toBe(bladeburnerSkillCost(skill, 0, each.level, 1));
    spent += each.spent;
  }
  expect(after.points).toBe(10_000 - spent);
  console.log(`points: 10,000 at rank 30,000; ${spent} spent on the twelve; ${after.points} left`);

  // The effects: every action's range and time at the levels bought, over the cases.
  const skills = bladeburnerSkillMultsOf(LEVELS);
  let ranges = 0;
  for (const each of CASES) {
    const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
    await sim.diagnostics.setBladeburnerFigures({
      population: each.population,
      estimate: each.estimate,
      communities: each.communities,
      chaos: each.chaos,
      stamina: max * each.share,
      maxLevels: Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((action) => [action.name, 5])),
    });
    const read = await runScript(
      sim,
      `const actions = [];
for (const { type, name } of ${ACTIONS}) {
  ns.bladeburner.setActionLevel(type, name, ${each.level});
  actions.push({ type, name, range: ns.bladeburner.getActionEstimatedSuccessChance(type, name), ms: ns.bladeburner.getActionTime(type, name) });
}
out({ person: ns.getPlayer(), stamina: ns.bladeburner.getStamina(), actions });`,
    );
    const figures = read.out[0] as {
      person: unknown;
      stamina: [number, number];
      actions: { type: string; name: string; range: [number, number]; ms: number }[];
    };
    const person = bladeburnerPersonOf(figures.person) as BladeburnerPerson;
    const penalty = staminaPenalty(figures.stamina[0], figures.stamina[1]);
    expect(penalty).toBeCloseTo(Math.min(1, 2 * each.share), 9);
    for (const got of figures.actions) {
      const action = bladeburnerLevelledAction(got.type, got.name);
      if (action === null) throw new Error(`no ${got.name}`);
      const label = `${got.name} at ${JSON.stringify(each)}`;
      const at = (population: number) =>
        actionSuccessChance(action, each.level, person, {
          city: { population, communities: each.communities, chaos: each.chaos },
          penalty,
          skills,
        });
      const range = actionSuccessRange(at(each.population), at(each.estimate), each.population, each.estimate);
      expect(range[0], `${label}: the low end`).toBeCloseTo(got.range[0], 12);
      expect(range[1], `${label}: the high end`).toBeCloseTo(got.range[1], 12);
      expect(actionSeconds(action, each.level, person, skills) * 1000, `${label}: the time`).toBe(got.ms);
      // Not at no skills: the levels moved it.
      expect(actionSeconds(action, each.level, person) * 1000, `${label}: the time at none`).toBeGreaterThan(got.ms);
      if (got.range[1] > 0 && got.range[0] < 1) ranges++;
    }
  }
  expect(ranges).toBeGreaterThan(CASES.length * 4);

  // The max stamina (Training's bonus none here) and its regain over a tick, from a third of it.
  await sim.diagnostics.setBladeburnerFigures({ stamina: 1 });
  const tick = await runScript(
    sim,
    `const before = ns.bladeburner.getStamina();
const ms = await ns.bladeburner.nextUpdate();
out({ before, after: ns.bladeburner.getStamina(), ms, person: ns.getPlayer() });`,
    10_000,
  );
  const {
    before: staminaBefore,
    after: staminaAfter,
    ms,
    person,
  } = tick.out[0] as {
    before: [number, number];
    after: [number, number];
    ms: number;
    person: unknown;
  };
  const who = bladeburnerPersonOf(person) as BladeburnerPerson;
  expect(maxStaminaOf(who, 0, skills)).toBeCloseTo(staminaBefore[1], 12);
  expect(maxStaminaOf(who, 0)).toBeLessThan(staminaBefore[1]);
  expect(ms).toBeGreaterThan(0);
  expect(staminaAfter[0] - staminaBefore[0]).toBeCloseTo(
    (staminaGainPerSecond(who, staminaBefore[1], skills) * ms) / 1000,
    12,
  );
}, 240_000);
