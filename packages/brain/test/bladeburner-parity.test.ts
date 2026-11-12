// Bladeburner B2 (#375): core's formulas against the engine's own figures, in the simulator. In BN6 with SF1.3 and
// SF7.1 (Bladeburner's multipliers at 1.08, `SourceFile/applySourceFile.ts:110-122`), the combat stats, hacking and charisma
// moved off 1. Harness edits set the city (the true population, its estimate, communities and chaos), the stamina and
// the max levels, which a script can't: the game's range needs the true population.
// - Every contract and operation's estimate's range (`getActionEstimatedSuccessChance`), time (`getActionTime`), rank
//   gained and lost (`getActionRankGain`, `getActionRankLoss`), over four cities and stamina at full and a quarter, at
//   levels 1 to 5; Raid at 0 with no communities.
// - The max stamina, and its regain over a tick (`nextUpdate`'s seconds).
// - Attempts: each tick an attempt lands in, its stamina (the regain less the cost), its rank (a success's gain within
//   ±10%; an operation's failure's loss within ±10%) and the levels opened by its successes.
// - Training's experience: 30 × mult² a stat, the upstream quirk; Field Analysis's 0.1 rank, no offset.
// - The BitNodes' `BladeburnerRank`.
import {
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  actionStaminaCost,
  actionSuccessChance,
  actionSuccessRange,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  fieldAnalysisRank,
  maxStaminaOf,
  skillExpFor,
  staminaGainPerSecond,
  staminaPenalty,
  successesForNextLevel,
  trainingExpPerAttempt,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();
const ACTIONS = JSON.stringify(BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({ type, name })));

interface Case {
  population: number;
  estimate: number;
  communities: number;
  chaos: number;
  /** The stamina as a share of the max. */
  share: number;
  level: number;
}
const CASES: Case[] = [
  { population: 1.2e9, estimate: 1.2e9, communities: 50, chaos: 0, share: 1, level: 1 },
  { population: 1e9, estimate: 1.4e9, communities: 20, chaos: 10, share: 1, level: 3 },
  { population: 1.4e9, estimate: 0.9e9, communities: 5, chaos: 75, share: 0.25, level: 5 },
  { population: 1.1e9, estimate: 1.3e9, communities: 0, chaos: 51, share: 0.6, level: 2 },
  { population: 1.3e9, estimate: 1.25e9, communities: 80, chaos: 49, share: 0.45, level: 4 },
];

interface Figures {
  person: unknown;
  stamina: [number, number];
  actions: { type: string; name: string; range: [number, number]; ms: number; gain: number; loss: number }[];
}

test("core's success, time, rank and stamina are the engine's (#375), its two quirks too", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 5: 1, 7: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(160, 1.28));
  await sim.diagnostics.gainHackingExp(5_000);
  await sim.diagnostics.gainCharismaExp(3_000);
  // Intelligence (#377's review): SF5.1, as the campaign enters BN6 with, and some experience, so its weight and bonus
  // count.
  await sim.diagnostics.gainIntelligenceExp(20_000);
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(100);

  // The BitNodes' rank multipliers.
  for (const bitNode of [6, 7]) {
    const multipliers = (await sim.diagnostics.bitNodeMultipliers(bitNode, 1)) as { BladeburnerRank: number };
    expect(bladeburnerRankMultiplierOf(bitNode), `BN${bitNode}`).toBe(multipliers.BladeburnerRank);
  }

  // Each case: the city and stamina set, every action at the case's level, read in one go.
  let compared = 0;
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
    const { out, log } = await runScript(
      sim,
      `const actions = [];
for (const { type, name } of ${ACTIONS}) {
  ns.bladeburner.setActionLevel(type, name, ${each.level});
  actions.push({
    type,
    name,
    range: ns.bladeburner.getActionEstimatedSuccessChance(type, name),
    ms: ns.bladeburner.getActionTime(type, name),
    gain: ns.bladeburner.getActionRankGain(type, name, ${each.level}),
    loss: ns.bladeburner.getActionRankLoss(type, name, ${each.level}),
  });
}
out({ person: ns.getPlayer(), stamina: ns.bladeburner.getStamina(), actions });`,
    );
    expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
    const figures = out[0] as Figures;
    const person = bladeburnerPersonOf(figures.person) as BladeburnerPerson;
    expect(person).not.toBeNull();
    expect(person.mults.bladeburner_success_chance).toBeCloseTo(1.08, 12);
    expect(person.skills.strength).toBe(160);
    expect(person.skills.hacking).toBeGreaterThan(1);
    expect(person.skills.charisma).toBeGreaterThan(1);
    expect(person.skills.intelligence).toBeGreaterThan(1);
    const penalty = staminaPenalty(figures.stamina[0], figures.stamina[1]);
    expect(penalty).toBeCloseTo(Math.min(1, 2 * each.share), 9);
    expect(figures.actions).toHaveLength(9);
    for (const read of figures.actions) {
      const action = bladeburnerLevelledAction(read.type, read.name);
      if (action === null) throw new Error(`no ${read.name}`);
      const label = `${read.name} at ${JSON.stringify(each)}`;
      const at = (population: number) =>
        actionSuccessChance(action, each.level, person, {
          city: { population, communities: each.communities, chaos: each.chaos },
          penalty,
        });
      const range = actionSuccessRange(at(each.population), at(each.estimate), each.population, each.estimate);
      expect(range[0], `${label}: the low end`).toBeCloseTo(read.range[0], 12);
      expect(range[1], `${label}: the high end`).toBeCloseTo(read.range[1], 12);
      expect(actionSeconds(action, each.level, person) * 1000, `${label}: the time`).toBe(read.ms);
      expect(actionRankGain(action, each.level, 1), `${label}: the rank`).toBeCloseTo(read.gain, 12);
      expect(actionRankLoss(action, each.level), `${label}: the loss`).toBeCloseTo(read.loss, 12);
      if (read.range[1] > 0) compared++;
    }
    if (each.communities === 0) {
      expect(figures.actions.find((read) => read.name === "Raid")?.range).toEqual([0, 0]);
    }
  }
  // Not all zeros: most actions have a chance in most cases.
  expect(compared).toBeGreaterThan(CASES.length * 6);

  // The max stamina and its regain over a tick, from a third of it.
  {
    const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
    await sim.diagnostics.setBladeburnerFigures({ stamina: max / 3 });
    const { out } = await runScript(
      sim,
      `const before = ns.bladeburner.getStamina();
const ms = await ns.bladeburner.nextUpdate();
out({ before, after: ns.bladeburner.getStamina(), ms, person: ns.getPlayer() });`,
      10_000,
    );
    const { before, after, ms, person } = out[0] as {
      before: [number, number];
      after: [number, number];
      ms: number;
      person: unknown;
    };
    const who = bladeburnerPersonOf(person) as BladeburnerPerson;
    expect(maxStaminaOf(who, 0)).toBeCloseTo(before[1], 12);
    expect(ms).toBeGreaterThan(0);
    expect(after[0] - before[0]).toBeCloseTo((staminaGainPerSecond(who, before[1]) * ms) / 1000, 12);
  }

  // Attempts: Tracking, then Investigation (an operation, its failures losing rank), each tick read.
  for (const [name, type, attemptsWanted] of [
    ["Tracking", "Contracts", 12],
    ["Investigation", "Operations", 6],
  ] as const) {
    const action = bladeburnerLevelledAction(type, name);
    if (action === null) throw new Error(`no ${name}`);
    await sim.diagnostics.setBladeburnerFigures({ stamina: 50, maxLevels: { [name]: 1 } });
    const { out, log } = await runScript(
      sim,
      `ns.bladeburner.setActionAutolevel("${type}", "${name}", true);
ns.bladeburner.setActionLevel("${type}", "${name}", 1);
ns.bladeburner.startAction("${type}", "${name}");
const read = () => ({
  stamina: ns.bladeburner.getStamina(),
  rank: ns.bladeburner.getRank(),
  count: ns.bladeburner.getActionCountRemaining("${type}", "${name}"),
  successes: ns.bladeburner.getActionSuccesses("${type}", "${name}"),
  maxLevel: ns.bladeburner.getActionMaxLevel("${type}", "${name}"),
  level: ns.bladeburner.getActionCurrentLevel("${type}", "${name}"),
  person: ns.getPlayer(),
});
let attempts = 0;
for (let tick = 0; tick < 2000 && attempts < ${attemptsWanted}; tick++) {
  const before = read();
  const ms = await ns.bladeburner.nextUpdate();
  const after = read();
  if (after.count < before.count - 0.5) {
    attempts++;
    out({ before, after, ms });
  }
}
ns.bladeburner.stopBladeburnerAction();`,
      600_000,
    );
    expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
    const attempts = out as {
      before: { stamina: [number, number]; rank: number; successes: number; level: number; person: unknown };
      after: { stamina: [number, number]; rank: number; successes: number; maxLevel: number };
      ms: number;
    }[];
    expect(attempts, name).toHaveLength(attemptsWanted);
    let successes = 0;
    let staminaTicks = 0;
    let failures = 0;
    for (const { before, after, ms } of attempts) {
      const who = bladeburnerPersonOf(before.person) as BladeburnerPerson;
      // The stamina, the max unchanged: the regain over the tick less an attempt's cost.
      if (after.stamina[1] === before.stamina[1]) {
        staminaTicks++;
        expect(after.stamina[0] - before.stamina[0], `${name}'s stamina`).toBeCloseTo(
          (staminaGainPerSecond(who, before.stamina[1]) * ms) / 1000 - actionStaminaCost(action, before.level),
          9,
        );
      }
      const delta = after.rank - before.rank;
      if (after.successes > before.successes) {
        successes++;
        const gain = actionRankGain(action, before.level, 1);
        expect(delta / gain, `${name}'s success`).toBeGreaterThanOrEqual(0.9 - 1e-12);
        expect(delta / gain, `${name}'s success`).toBeLessThanOrEqual(1.1 + 1e-12);
      } else {
        failures++;
        const loss = actionRankLoss(action, before.level);
        if (loss === 0) expect(delta).toBe(0);
        else {
          expect(-delta / loss, `${name}'s failure`).toBeGreaterThanOrEqual(0.9 - 1e-12);
          expect(-delta / loss, `${name}'s failure`).toBeLessThanOrEqual(1.1 + 1e-12);
        }
      }
      // The levels its successes open: level M + 1 after ⌈½·M·(2b + M − 1)⌉.
      let opened = 1;
      while (after.successes >= successesForNextLevel(action, opened)) opened++;
      expect(after.maxLevel, `${name}'s max level at ${after.successes} successes`).toBe(opened);
    }
    console.log(`${name}: ${successes} successes, ${failures} failures`);
    // Most attempts' stamina compared (#377's review): a tick whose max moved (agility levelled) isn't.
    console.log(`${name}: ${staminaTicks} of ${attempts.length} ticks' stamina compared`);
    expect(staminaTicks).toBeGreaterThanOrEqual(attempts.length / 2);
    if (name === "Tracking") expect(successes).toBeGreaterThan(3);
    if (name === "Investigation") expect(failures).toBeGreaterThan(0);
  }

  // Training's experience, mult² a stat; Field Analysis's rank, 0.1, no offset.
  for (const name of ["Training", "Field Analysis"]) {
    const { out } = await runScript(
      sim,
      `ns.bladeburner.startAction("General", "${name}");
const read = () => ({ rank: ns.bladeburner.getRank(), person: ns.getPlayer(), time: ns.bladeburner.getActionCurrentTime() });
for (let tick = 0; tick < 100; tick++) {
  const before = read();
  await ns.bladeburner.nextUpdate();
  const after = read();
  if (after.time < before.time) {
    out({ before, after });
    break;
  }
}
ns.bladeburner.stopBladeburnerAction();`,
      200_000,
    );
    expect(out, name).toHaveLength(1);
    type Read = { rank: number; person: { exp: Record<string, number>; mults: Record<string, number> } };
    const { before, after } = out[0] as { before: Read; after: Read };
    if (name === "Field Analysis") {
      expect(after.rank - before.rank).toBeCloseTo(fieldAnalysisRank(1), 12);
      continue;
    }
    for (const stat of ["strength", "defense", "dexterity", "agility"]) {
      const mult = before.person.mults[`${stat}_exp`] as number;
      expect(mult).toBeCloseTo(1.28, 12);
      expect((after.person.exp[stat] as number) - (before.person.exp[stat] as number), stat).toBeCloseTo(
        trainingExpPerAttempt(mult),
        9,
      );
    }
  }
}, 240_000);
