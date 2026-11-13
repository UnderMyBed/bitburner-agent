// Bladeburner B5 (#392): core's Black Ops against the engine's own figures, in the simulator, as B2's parity test does
// (bladeburner-parity.test.ts). In BN6 with SF1.3, SF5.1 and SF7.1, the combat stats, hacking, charisma and
// intelligence moved off 1, the rank set by a harness edit through the game's own change (its points with it):
// - the 21's names in order (`getBlackOpNames`) and each one's rank (`getBlackOpRank`);
// - each one's estimate's range (`getActionEstimatedSuccessChance`), time (`getActionTime`), rank gained and lost
//   (`getActionRankGain`, `getActionRankLoss`), at no skills and at levels of the success skills (the operations',
//   stealth's, kill's, all) and Overclock, over two cities (the estimate over and under the true population) and the
//   stamina at full and a quarter: no population or chaos in the chance, only pop/popEst in the range;
// - Typhoon run at its rank: one attempt, its stamina and rank, the action stopped after it, and its count 0 once done;
//   Zero's count 1 then.
import {
  actionSuccessRange,
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  type BladeburnerPerson,
  type BladeburnerSkillLevels,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpStaminaCost,
  blackOpSuccessChance,
  bladeburnerBlackOp,
  bladeburnerPersonOf,
  bladeburnerSkillMultsOf,
  skillExpFor,
  staminaGainPerSecond,
  staminaPenalty,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";

const start = useSimulations();
const NAMES = JSON.stringify(BLADEBURNER_BLACK_OPS.map((op) => op.name));
/** The success skills each Black Op reads, and Overclock: their levels for the second pass. */
const LEVELS: BladeburnerSkillLevels = {
  "Blade's Intuition": 4,
  Cloak: 3,
  "Short-Circuit": 2,
  "Digital Observer": 5,
  Tracer: 5,
  Overclock: 30,
  Reaper: 3,
  "Evasive System": 2,
};
const CASES = [
  { population: 1e9, estimate: 1.4e9, communities: 20, chaos: 80, share: 1 },
  { population: 1.4e9, estimate: 0.9e9, communities: 5, chaos: 10, share: 0.25 },
];

interface Read {
  type: string;
  name: string;
  range: [number, number];
  ms: number;
  gain: number;
  loss: number;
  rank: number;
  count: number;
}

test("core's Black Op success, time and rank are the engine's (#392); Typhoon run: one attempt, then stopped", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 5: 1, 7: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(400, 1.28));
  await sim.diagnostics.gainHackingExp(5_000);
  await sim.diagnostics.gainCharismaExp(3_000);
  await sim.diagnostics.gainIntelligenceExp(20_000);
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(3_000);

  // The names in order, and each one's rank.
  const order = await runScript(
    sim,
    `out({ names: ns.bladeburner.getBlackOpNames(), ranks: ns.bladeburner.getBlackOpNames().map((name) => ns.bladeburner.getBlackOpRank(name)) });`,
  );
  const { names, ranks } = order.out[0] as { names: string[]; ranks: number[] };
  expect(names).toEqual(BLADEBURNER_BLACK_OPS.map((op) => op.name));
  expect(ranks).toEqual(BLADEBURNER_BLACK_OPS.map((op) => op.rank));

  let compared = 0;
  for (const levels of [{}, LEVELS] as BladeburnerSkillLevels[]) {
    if (levels === LEVELS) {
      const bought = await runScript(
        sim,
        `out(Object.entries(${JSON.stringify(LEVELS)}).every(([name, level]) => ns.bladeburner.upgradeSkill(name, level)));`,
      );
      expect(bought.out).toEqual([true]);
    }
    const skills = bladeburnerSkillMultsOf(levels);
    for (const each of CASES) {
      const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
      await sim.diagnostics.setBladeburnerFigures({
        population: each.population,
        estimate: each.estimate,
        communities: each.communities,
        chaos: each.chaos,
        stamina: max * each.share,
      });
      const { out, log } = await runScript(
        sim,
        `const type = "${BLACK_OPERATIONS}";
out({
  person: ns.getPlayer(),
  stamina: ns.bladeburner.getStamina(),
  ops: ${NAMES}.map((name) => ({
    type,
    name,
    range: ns.bladeburner.getActionEstimatedSuccessChance(type, name),
    ms: ns.bladeburner.getActionTime(type, name),
    gain: ns.bladeburner.getActionRankGain(type, name),
    loss: ns.bladeburner.getActionRankLoss(type, name),
    count: ns.bladeburner.getActionCountRemaining(type, name),
  })),
});`,
      );
      expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
      const figures = out[0] as { person: unknown; stamina: [number, number]; ops: Read[] };
      const person = bladeburnerPersonOf(figures.person) as BladeburnerPerson;
      expect(person.mults.bladeburner_success_chance).toBeCloseTo(1.08, 12);
      expect(person.skills.intelligence).toBeGreaterThan(1);
      const penalty = staminaPenalty(figures.stamina[0], figures.stamina[1]);
      expect(penalty).toBeCloseTo(Math.min(1, 2 * each.share), 9);
      expect(figures.ops).toHaveLength(21);
      for (const read of figures.ops) {
        const op = bladeburnerBlackOp(read.name);
        if (op === null) throw new Error(`no ${read.name}`);
        const label = `${read.name} at ${JSON.stringify(each)}, ${JSON.stringify(levels)}`;
        const real = blackOpSuccessChance(op, person, { penalty, skills });
        const range = actionSuccessRange(real, real, each.population, each.estimate);
        expect(range[0], `${label}: the low end`).toBeCloseTo(read.range[0], 12);
        expect(range[1], `${label}: the high end`).toBeCloseTo(read.range[1], 12);
        expect(blackOpSeconds(op, person, skills) * 1000, `${label}: the time`).toBe(read.ms);
        expect(blackOpRankGain(op, 1), `${label}: the rank`).toBeCloseTo(read.gain, 12);
        expect(blackOpRankLoss(op), `${label}: the loss`).toBeCloseTo(read.loss, 12);
        expect(read.count, `${label}: the count`).toBe(1);
        if (read.range[0] > 0 && read.range[1] < 1) compared++;
      }
    }
  }
  // Not all clamped: most Black Ops' ranges are inside (0, 1) in most passes.
  expect(compared).toBeGreaterThan(4 * 15);

  // Typhoon run at its rank (3,000): one attempt, its stamina and rank, then stopped; its count 0 once done.
  const typhoon = bladeburnerBlackOp("Operation Typhoon");
  if (typhoon === null) throw new Error("no Typhoon");
  const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
  await sim.diagnostics.setBladeburnerFigures({ stamina: max });
  const run = await runScript(
    sim,
    `const type = "${BLACK_OPERATIONS}";
const read = () => ({
  stamina: ns.bladeburner.getStamina(),
  rank: ns.bladeburner.getRank(),
  current: ns.bladeburner.getCurrentAction(),
  count: ns.bladeburner.getActionCountRemaining(type, "Operation Typhoon"),
  next: ns.bladeburner.getActionCountRemaining(type, "Operation Zero"),
  person: ns.getPlayer(),
});
const started = ns.bladeburner.startAction(type, "Operation Typhoon");
const ticks = [];
for (let tick = 0; tick < 2000; tick++) {
  const before = read();
  const ms = await ns.bladeburner.nextUpdate();
  const after = read();
  if (after.current === null) {
    out({ started, before, after, ms });
    break;
  }
}`,
    600_000,
  );
  expect(run.log.filter((line) => !line.startsWith("out:"))).toEqual([]);
  expect(run.out).toHaveLength(1);
  type Tick = {
    stamina: [number, number];
    rank: number;
    current: unknown;
    count: number;
    next: number;
    person: unknown;
  };
  const { started, before, after, ms } = run.out[0] as { started: boolean; before: Tick; after: Tick; ms: number };
  expect(started).toBe(true);
  expect(before.current).toEqual({ type: BLACK_OPERATIONS, name: "Operation Typhoon" });
  // Stopped after its one attempt, success or not.
  expect(after.current).toBeNull();
  const who = bladeburnerPersonOf(before.person) as BladeburnerPerson;
  const skills = bladeburnerSkillMultsOf(LEVELS);
  // The tick's regain first, held at the max, then the attempt's cost (`Bladeburner.ts:1383-1385`, `:1021`).
  expect(after.stamina[1]).toBe(before.stamina[1]);
  const regained = Math.min(
    before.stamina[1],
    before.stamina[0] + (staminaGainPerSecond(who, before.stamina[1], skills) * ms) / 1000,
  );
  expect(after.stamina[0], "the stamina").toBeCloseTo(regained - blackOpStaminaCost(typhoon), 9);
  const delta = after.rank - before.rank;
  if (after.count === 0) {
    // Done: its rank ±10%, the next one's count 1.
    expect(delta / blackOpRankGain(typhoon, 1)).toBeGreaterThanOrEqual(0.9 - 1e-12);
    expect(delta / blackOpRankGain(typhoon, 1)).toBeLessThanOrEqual(1.1 + 1e-12);
    expect(after.next).toBe(1);
  } else {
    expect(after.count).toBe(1);
    expect(-delta / blackOpRankLoss(typhoon)).toBeGreaterThanOrEqual(0.9 - 1e-12);
    expect(-delta / blackOpRankLoss(typhoon)).toBeLessThanOrEqual(1.1 + 1e-12);
  }
  console.log(
    `Typhoon at rank 3,000: ${after.count === 0 ? "done" : "failed"}, rank ${before.rank.toFixed(2)} → ` +
      `${after.rank.toFixed(2)}; ${compared} ranges compared inside (0, 1)`,
  );
}, 240_000);
