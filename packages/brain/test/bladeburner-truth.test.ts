// Bladeburner (#415): B2's action rule and B3's skill spending at the chance the game draws against, the true
// population recovered from the next Black Op's range read (#411's ruling 4), not the range's low end. Against the
// engine at an undercount (the estimate 0.6× the truth) and an overcount (1.42×, seed 1's New Tokyo): the brain's rule
// on a reading of the engine's own ranges chooses as core's rule does at the engine's drawn chances (`Actions/Action.ts:
// 169-196`, at the true population, `:83-85`), and not as it would at the low end. Paths are
// `vendor/bitburner-src/src/`'s (v3.0.1).
import {
  actionSuccessChance,
  BLACK_OPERATIONS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerBlackOp,
  bladeburnerPersonOf,
  chooseBladeburnerAction,
  chooseBladeburnerSkills,
  type MediumSnapshotData,
  type SlowSnapshotData,
  skillExpFor,
  staminaPenalty,
} from "@bitburner-agent/core";
import { runScript, useSimulations } from "@bitburner-agent/sim/test-helpers";
import { expect, test } from "vitest";
import { BladeburnerRule } from "../src/bladeburner.ts";
import { slowData } from "./helpers/snapshot-fixtures.ts";

const start = useSimulations();
const ACTIONS = JSON.stringify(BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({ type, name })));
const CITY = { communities: 30, chaos: 0 };
/** The rank set: Operation Typhoon's (the target met, so B2 by rank a second), and its 833 points. */
const RANK = 2500;

test("B2's choice and B3's points at the engine's drawn chance: an undercount and an overcount (#415)", async () => {
  const sim = await start({
    seed: 1,
    epochMs: Date.UTC(2026, 0, 1),
    fixture: { kind: "bitnode", n: 6, sourceFiles: { 1: 3, 5: 1 } },
  });
  await sim.diagnostics.setHomeRam(128);
  await sim.diagnostics.gainCombatExp(skillExpFor(300, 1.28));
  const joined = await runScript(sim, "out(ns.bladeburner.joinBladeburnerDivision());");
  expect(joined.out).toEqual([true]);
  await sim.diagnostics.setBladeburnerRank(RANK);
  const typhoon = bladeburnerBlackOp("Operation Typhoon");
  if (typhoon === null) throw new Error("no Typhoon");
  const rows: string[] = [];
  for (const [label, population, estimate] of [
    ["an undercount (the estimate 0.6× the truth)", 1.3e9, 0.78e9],
    ["an overcount (the estimate 1.42× the truth)", 1.1e9, 1.562e9],
  ] as const) {
    const max = (await runScript(sim, "out(ns.bladeburner.getStamina()[1]);")).out[0] as number;
    await sim.diagnostics.setBladeburnerFigures({ population, estimate, ...CITY, stamina: max });
    const { out, log } = await runScript(
      sim,
      `out({
  player: ns.getPlayer(),
  rank: ns.bladeburner.getRank(),
  stamina: ns.bladeburner.getStamina(),
  points: ns.bladeburner.getSkillPoints(),
  blackOp: ns.bladeburner.getActionEstimatedSuccessChance("${BLACK_OPERATIONS}", "${typhoon.name}"),
  actions: ${ACTIONS}.map(({ type, name }) => ({
    type,
    name,
    level: ns.bladeburner.getActionCurrentLevel(type, name),
    maxLevel: ns.bladeburner.getActionMaxLevel(type, name),
    count: ns.bladeburner.getActionCountRemaining(type, name),
    chance: ns.bladeburner.getActionEstimatedSuccessChance(type, name),
  })),
});`,
    );
    expect(log.filter((line) => !line.startsWith("out:"))).toEqual([]);
    const read = out[0] as {
      player: Record<string, unknown>;
      rank: number;
      stamina: [number, number];
      points: number;
      blackOp: [number, number];
      actions: BladeburnerActionReading[];
    };
    const person = bladeburnerPersonOf(read.player) as BladeburnerPerson;
    const penalty = staminaPenalty(read.stamina[0], read.stamina[1]);
    // The worker's reading, as the Agent's `bladeburner.js` sends it (#375, #379, #392).
    const reading = {
      rank: read.rank,
      problems: [],
      stamina: read.stamina[0],
      maxStamina: read.stamina[1],
      bonusSeconds: 0,
      found: null,
      current: null,
      actions: read.actions,
      skillPoints: read.points,
      skillLevels: Object.fromEntries(BLADEBURNER_SKILL_NAMES.map((name) => [name, 0])),
      blackOp: { name: typhoon.name, chance: read.blackOp },
    };
    const medium = {
      player: { ...read.player, factions: ["Bladeburners"] },
      servers: [{ hostname: "home", maxRam: 128, cpuCores: 1, hasAdminRights: true, moneyAvailable: 0 }],
      inBladeburner: true,
      bladeburner: reading,
    } as unknown as MediumSnapshotData;
    const rule = new BladeburnerRule();
    rule.update({ mediumData: medium, slowData: slowData(6) as SlowSnapshotData, homeKeptGb: 32 });
    const view = rule.view();
    // The engine's drawn chances: each at the true population (`Actions/Action.ts:83-85`), the penalty in.
    const drawn = read.actions.map((each) => {
      const action = BLADEBURNER_LEVELLED_ACTIONS.find((one) => one.name === each.name);
      if (action === undefined) throw new Error(`no ${each.name}`);
      const chance = actionSuccessChance(action, each.level, person, { city: { population, ...CITY }, penalty });
      return { ...each, chance: [chance, chance] as [number, number] };
    });
    const base = {
      person,
      stamina: read.stamina[0],
      maxStamina: read.stamina[1],
      rankMultiplier: 1,
      speed: 1,
      skills: { read: {} },
    };
    const atDrawn = chooseBladeburnerAction({ ...base, readings: drawn });
    const atLow = chooseBladeburnerAction({
      ...base,
      readings: read.actions.map((each) => ({ ...each, chance: [each.chance[0], each.chance[0]] as [number, number] })),
    });
    const plan = view.actions?.plan;
    expect(plan?.work?.name, label).toBe(atDrawn.work?.name);
    expect(plan?.work?.level, label).toBe(atDrawn.work?.level);
    expect(plan?.work?.chance, label).toBeCloseTo(atDrawn.work?.chance ?? Number.NaN, 9);
    expect(plan?.rankPerSecond, label).toBeCloseTo(atDrawn.rankPerSecond, 12);
    expect(view.actions?.ratio, label).toBeCloseTo(population / estimate, 9);
    expect(view.line).toContain(`at the true population (pop/popEst ${(population / estimate).toFixed(3)})`);
    // B3's points: the plan at the drawn chances, the levels bought the same.
    const skillsAtDrawn = chooseBladeburnerSkills(
      { ...base, readings: drawn },
      { levels: {}, points: read.points, costMultiplier: 1 },
    );
    expect(view.skills?.buys, label).toEqual(skillsAtDrawn.buys);
    const skillsAtLow = chooseBladeburnerSkills(
      { ...base, readings: read.actions },
      { levels: {}, points: read.points, costMultiplier: 1 },
    );
    // Neither as at the low end (on seed 1's figures: the overcount's low end works Tracking, not Raid).
    expect(atLow.rankPerSecond, label).not.toBeCloseTo(atDrawn.rankPerSecond, 6);
    expect(skillsAtLow.buys, label).not.toEqual(skillsAtDrawn.buys);
    rows.push(
      `${label}: B2 ${plan?.work?.name} level ${plan?.work?.level} at ${(100 * (plan?.work?.chance ?? 0)).toFixed(2)}% ` +
        `(${(plan?.rankPerSecond ?? 0) * 60} rank/min); at the low end ${atLow.work?.name} level ${atLow.work?.level} at ` +
        `${(100 * (atLow.work?.chance ?? 0)).toFixed(2)}% (${atLow.rankPerSecond * 60} rank/min); B3 ` +
        `${skillsAtDrawn.buys.map((buy) => `${buy.skill} ${buy.to}`).join(", ")} for ${skillsAtDrawn.spent}; at the low ` +
        `end ${skillsAtLow.buys.map((buy) => `${buy.skill} ${buy.to}`).join(", ")} for ${skillsAtLow.spent}`,
    );
  }
  console.log(rows.join("\n"));
}, 240_000);
