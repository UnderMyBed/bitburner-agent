// Bladeburner B3 (#379): the skills' figures checked against the pinned game's source, their costs and effects worked
// by hand (golden figures from `Skill.ts:76-80` and `Bladeburner.ts:776-786`), B2's formulas at skill levels, and the
// rule's choice of levels by rank a second a point. The parity against the engine itself is the simulator's
// (packages/brain/test/bladeburner-skills-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionSeconds,
  actionSkillCompetence,
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  chanceLowAt,
  chooseBladeburnerAction,
  chooseBladeburnerSkills,
  effectiveLevel,
  maxStaminaAtSkills,
  maxStaminaOf,
  staminaGainPerSecond,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_RANK_SKILLS,
  BLADEBURNER_SKILL_NAMES,
  BLADEBURNER_SKILLS,
  type BladeburnerSkill,
  type BladeburnerSkillLevels,
  bladeburnerSkill,
  bladeburnerSkillCost,
  bladeburnerSkillCostMultiplierOf,
  bladeburnerSkillMultsOf,
  cheapestBladeburnerSkillLevel,
  NO_BLADEBURNER_SKILLS,
  planBladeburnerSkills,
} from "../src/bladeburner-skills.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

const skillOf = (name: string) => bladeburnerSkill(name) as BladeburnerSkill;

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma 1, no intelligence. */
function person(combat = 100): BladeburnerPerson {
  return {
    skills: {
      hacking: 1,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma: 1,
      intelligence: 0,
    },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}
const CITY = { population: 1e9, communities: 50, chaos: 0 };

/** Each action read at level 1 of max `maxLevel`, its count `count`, its range collapsed on the chance at `levels`. */
function readingsAt(
  levels: BladeburnerSkillLevels,
  { maxLevel = 1, count = 100, who = person() } = {},
): BladeburnerActionReading[] {
  const skills = bladeburnerSkillMultsOf(levels);
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty: 1, skills });
    return { type: action.type, name: action.name, level: 1, maxLevel, count, chance: [chance, chance] };
  });
}

describe("the game's facts", () => {
  test("the twelve skills' names, costs, max levels and effects are the data file's", () => {
    const enums = gameSource("Bladeburner/Enums.ts");
    const data = gameSource("Bladeburner/data/Skills.ts");
    const names = enums.slice(
      enums.indexOf("export enum BladeburnerSkillName"),
      enums.indexOf("export enum Bladeburner", enums.indexOf("export enum BladeburnerSkillName") + 1),
    );
    const order = [...names.matchAll(/ {2}(\w+) = "([^"]+)",/g)];
    expect(order.map((match) => match[2])).toEqual([...BLADEBURNER_SKILL_NAMES]);
    expect(BLADEBURNER_SKILLS.map((skill) => skill.name)).toEqual([...BLADEBURNER_SKILL_NAMES]);
    const multKeys: Record<string, string> = {
      SuccessChanceAll: "successAll",
      SuccessChanceStealth: "successStealth",
      SuccessChanceKill: "successKill",
      SuccessChanceOperation: "successOperation",
      SuccessChanceContract: "successContract",
      SuccessChanceEstimate: "successEstimate",
      ActionTime: "actionTime",
      EffStr: "effStrength",
      EffDef: "effDefense",
      EffDex: "effDexterity",
      EffAgi: "effAgility",
      Stamina: "stamina",
      Money: "money",
      ExpGain: "expGain",
    };
    for (const [, key, name] of order) {
      const skill = skillOf(name as string);
      const from = data.indexOf(`[BladeburnerSkillName.${key}]: new Skill({`);
      expect(from, name).toBeGreaterThan(0);
      const block = data.slice(from, data.indexOf("  }),", from));
      expect(block, `${name}'s base cost`).toContain(`baseCost: ${skill.baseCost},`);
      expect(block, `${name}'s rise`).toContain(`costInc: ${skill.costInc},`);
      if (skill.maxLevel === Number.MAX_VALUE) expect(block).not.toContain("maxLvl");
      else expect(block).toContain(`maxLvl: ${skill.maxLevel},`);
      const mults = Object.fromEntries(
        [...block.matchAll(/\[BladeburnerMultName\.(\w+)\]: (-?[\d.]+)/g)].map((match) => [
          multKeys[match[1] as string],
          Number(match[2]),
        ]),
      );
      expect(mults, `${name}'s effects`).toEqual(skill.mults);
    }
    // The defaults (`Skill.ts:31-33`) and Overclock's cap.
    const skillFile = gameSource("Bladeburner/Skill.ts");
    expect(skillFile).toContain("this.maxLvl = params.maxLvl ?? Number.MAX_VALUE;");
    expect(skillOf("Overclock").maxLevel).toBe(90);
  });

  test("the cost and effect formulas, and the points a rank, are the game's lines", () => {
    const skillFile = gameSource("Bladeburner/Skill.ts");
    expect(skillFile).toContain(
      "    return Math.round(\n      actualCount *\n        currentNodeMults.BladeburnerSkillCost *\n" +
        "        (this.baseCost + this.costInc * (currentLevel + (actualCount - 1) / 2)),\n    );",
    );
    const bladeburner = gameSource("Bladeburner/Bladeburner.ts");
    expect(bladeburner).toContain("const mult = 1 + (baseMult * level) / 100;");
    expect(bladeburner).toContain("this.skillMultipliers[name] = clampNumber(this.getSkillMult(name) * mult, 0);");
    expect(bladeburner).toContain("return this.skillMultipliers[name] ?? 1;");
    expect(bladeburner).toContain(
      "const rankNeededForSp = (this.totalSkillPoints + 1) * BladeburnerConstants.RanksPerSkillPoint;",
    );
    expect(gameSource("Bladeburner/data/Constants.ts")).toContain("RanksPerSkillPoint: 3,");
    const action = gameSource("Bladeburner/Actions/Action.ts");
    expect(action).toContain("competence *= inst.getSkillMult(BladeburnerMultName.SuccessChanceAll);");
    expect(action).toContain(
      "if (this.isStealth) competence *= inst.getSkillMult(BladeburnerMultName.SuccessChanceStealth);",
    );
    expect(action).toContain(
      "if (this.isKill) competence *= inst.getSkillMult(BladeburnerMultName.SuccessChanceKill);",
    );
    expect(action).toContain("const skillFac = bladeburner.getSkillMult(BladeburnerMultName.ActionTime);");
    expect(gameSource("Bladeburner/Actions/Contract.ts")).toContain(
      "return inst.getSkillMult(BladeburnerMultName.SuccessChanceContract);",
    );
    expect(gameSource("Bladeburner/Actions/Operation.ts")).toContain(
      "return inst.getSkillMult(BladeburnerMultName.SuccessChanceOperation);",
    );
    // BN7's cost multiplier 2, BN6's the default 1.
    const bitNodes = gameSource("BitNode/BitNode.tsx");
    expect(bitNodes).toMatch(/case 7: \{[^}]*BladeburnerSkillCost: 2,/);
    expect(bitNodes).not.toMatch(/case 6: \{[^}]*BladeburnerSkillCost/);
    expect(gameSource("BitNode/BitNodeMultipliers.ts")).toContain("BladeburnerSkillCost = 1;");
    expect(bladeburnerSkillCostMultiplierOf(6)).toBe(1);
    expect(bladeburnerSkillCostMultiplierOf(7)).toBe(2);
    expect(bladeburnerSkillCostMultiplierOf(2)).toBeNull();
  });
});

describe("costs and effects, worked by hand", () => {
  test("cost: round(count × mult × (base + inc·(L + (count − 1)/2))), rounded once for the count", () => {
    // Blade's Intuition (3, 2.1): 3 from 0; 2 levels round(2 × 4.05) = 8; from 10, 5 levels in BN7: round(10 × 28.2).
    expect(bladeburnerSkillCost(skillOf("Blade's Intuition"), 0, 1, 1)).toBe(3);
    expect(bladeburnerSkillCost(skillOf("Blade's Intuition"), 0, 2, 1)).toBe(8);
    expect(bladeburnerSkillCost(skillOf("Blade's Intuition"), 10, 5, 2)).toBe(282);
    // Cloak (2, 1.1): 3 from 0, round(3 × 3.1) = 9, not 2 + 3 + 4 (a level at a time: round(3.1) = 3, round(4.2) = 4).
    expect(bladeburnerSkillCost(skillOf("Cloak"), 0, 3, 1)).toBe(9);
    // Cyber's Edge (1, 3): 1 from 0; 3 levels from 3, round(3 × 13) = 39.
    expect(bladeburnerSkillCost(skillOf("Cyber's Edge"), 0, 1, 1)).toBe(1);
    expect(bladeburnerSkillCost(skillOf("Cyber's Edge"), 3, 3, 1)).toBe(39);
    // Overclock (3, 1.4): its 90th from 89, round(127.6) = 128; past 90, Infinity (`getSkillUpgradeCost`'s).
    expect(bladeburnerSkillCost(skillOf("Overclock"), 89, 1, 1)).toBe(128);
    expect(bladeburnerSkillCost(skillOf("Overclock"), 89, 2, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(bladeburnerSkillCost(skillOf("Overclock"), 0, 90, 1)).toBe(Math.round(90 * (3 + 1.4 * 44.5)));
  });

  test("effects: each multiplier the product of 1 + p·level/100; Overclock 90 is ×0.1; none at level 0", () => {
    expect(bladeburnerSkillMultsOf({})).toEqual(NO_BLADEBURNER_SKILLS);
    const mults = bladeburnerSkillMultsOf({
      "Blade's Intuition": 4,
      Cloak: 2,
      Reaper: 5,
      "Evasive System": 3,
      Overclock: 90,
      "Cyber's Edge": 7,
      Tracer: 0,
    });
    expect(mults.successAll).toBeCloseTo(1.12, 12);
    expect(mults.successStealth).toBeCloseTo(1.11, 12);
    expect(mults.successContract).toBe(1);
    // Reaper's 10% and Evasive System's 12% multiply on dexterity and agility; strength and defense Reaper's alone.
    expect(mults.effStrength).toBeCloseTo(1.1, 12);
    expect(mults.effAgility).toBeCloseTo(1.1 * 1.12, 12);
    expect(mults.effDexterity).toBeCloseTo(1.1 * 1.12, 12);
    expect(mults.effCharisma).toBe(1);
    expect(mults.actionTime).toBeCloseTo(0.1, 12);
    expect(mults.stamina).toBeCloseTo(1.14, 12);
  });

  test("B2's formulas at skill levels: competence, time, the max stamina and its regain", () => {
    const who = person();
    const tracking = bladeburnerLevelledAction("Contracts", "Tracking");
    const bounty = bladeburnerLevelledAction("Contracts", "Bounty Hunter");
    if (tracking === null || bounty === null) throw new Error("no contract");
    const skills = bladeburnerSkillMultsOf({ "Blade's Intuition": 2, Tracer: 5, Cloak: 1, Reaper: 5, Overclock: 50 });
    expect(effectiveLevel(who, "agility", skills)).toBeCloseTo(110, 12);
    expect(effectiveLevel(who, "hacking", skills)).toBe(1);
    // Tracking: stealthy, a contract; its stats at 110 (charisma 1): 0.8 × 110^0.91 + 0.1, × 1.06 × 1.2 × 1.055.
    expect(actionSkillCompetence(tracking, who, skills)).toBeCloseTo((0.8 * 110 ** 0.91 + 0.1) * 1.06 * 1.2 * 1.055, 9);
    // Each type its own: Tracer 5 (×1.2) on a contract, Digital Observer 10 (×1.4) on an operation (Investigation).
    const investigation = bladeburnerLevelledAction("Operations", "Investigation");
    if (investigation === null) throw new Error("no Investigation");
    const byType = bladeburnerSkillMultsOf({ Tracer: 5, "Digital Observer": 10 });
    expect(actionSkillCompetence(tracking, who, byType) / actionSkillCompetence(tracking, who)).toBeCloseTo(1.2, 12);
    expect(actionSkillCompetence(investigation, who, byType) / actionSkillCompetence(investigation, who)).toBeCloseTo(
      1.4,
      12,
    );
    // Bounty Hunter kills, isn't stealthy: Cloak's no part of it, Short-Circuit's (none here) would be.
    expect(actionSkillCompetence(bounty, who, skills) / actionSkillCompetence(bounty, who)).toBeCloseTo(
      ((0.8 * 110 ** 0.91 + 0.1 + 0.1 * 0) / (0.8 * 100 ** 0.91 + 0.1)) * 1.06 * 1.2,
      9,
    );
    expect(actionSuccessChance(tracking, 1, who, { city: CITY, penalty: 1, skills })).toBeCloseTo(
      ((0.8 * 110 ** 0.91 + 0.1) * 1.06 * 1.2 * 1.055) / 125,
      9,
    );
    // Time: ⌈12.5 × 0.5 / statFac(110, 110)⌉.
    const statFac = 0.5 * (110 ** 0.04 + 110 ** 0.035 + 110 / 10e3 + 110 / 10e3);
    expect(actionSeconds(tracking, 1, who, skills)).toBe(Math.ceil((12.5 * 0.5) / statFac));
    expect(actionSeconds(tracking, 1, who, skills)).toBeLessThan(actionSeconds(tracking, 1, who));
    // Max stamina: (110^0.8 + bonus) × 1.1 (Cyber's Edge 5); its regain (0.0085 + max/70,000) × 110^0.17 × 1.1.
    const edge = bladeburnerSkillMultsOf({ Reaper: 5, "Cyber's Edge": 5 });
    const max = maxStaminaOf(who, 2, edge);
    expect(max).toBeCloseTo((110 ** 0.8 + 2) * 1.1, 9);
    expect(staminaGainPerSecond(who, max, edge)).toBeCloseTo((0.0085 + max / 70_000) * 110 ** 0.17 * 1.1, 12);
    // The max at other levels, from one read: its bonus kept.
    expect(maxStaminaAtSkills(who, max, edge, NO_BLADEBURNER_SKILLS)).toBeCloseTo(100 ** 0.8 + 2, 9);
    expect(maxStaminaAtSkills(who, max, edge, edge)).toBeCloseTo(max, 9);
  });

  test("the low end at other levels scales with the competence; clamped, a rise isn't credited", () => {
    const tracking = bladeburnerLevelledAction("Contracts", "Tracking");
    if (tracking === null) throw new Error("no Tracking");
    const read: BladeburnerActionReading = { ...readingsAt({})[0], chance: [0.4, 0.6] } as BladeburnerActionReading;
    expect(chanceLowAt(tracking, read, 1, 1, 1.25)).toBeCloseTo(0.5, 12);
    expect(chanceLowAt(tracking, read, 2, 0.5, 1.25)).toBeCloseTo(1 / 1.02, 12);
    expect(chanceLowAt(tracking, read, 1, 1, 0.5)).toBeCloseTo(0.2, 12);
    const clamped = { ...read, chance: [0.4, 1] as [number, number] };
    expect(chanceLowAt(tracking, clamped, 1, 1, 1.25)).toBeCloseTo(0.4, 12);
    expect(chanceLowAt(tracking, clamped, 1, 1, 0.5)).toBeCloseTo(0.2, 12);
  });
});

describe("the rule's choice (#379): the levels that add the most rank a second a point", () => {
  test("by a forecast given: the best gain a point each step, within the points, the game's order on a tie", () => {
    // Rank a second: Cloak's levels 0.02 each, Tracer's 0.05. Tracer's first level costs 2, two round(6.1) = 6, three
    // round(12.3) = 12; Cloak's 2, round(5.1) = 5, round(9.3) = 9.
    const weights: Partial<Record<string, number>> = { Cloak: 0.02, Tracer: 0.05 };
    const rankPerSecond = (levels: BladeburnerSkillLevels) =>
      Object.entries(levels).reduce((sum, [name, level]) => sum + (weights[name] ?? 0) * (level ?? 0), 1);
    const plan = planBladeburnerSkills({ levels: {}, points: 10, costMultiplier: 1, rankPerSecond });
    // Tracer 1 (0.05 for 2: 0.025 a point); Tracer 2 (0.05 for 4: 0.0125) over Cloak 1 (0.01); then Cloak 1 for 2;
    // then Cloak 2 (3 more) and Tracer 3 (6 more) are over the 2 left.
    expect(plan.buys).toEqual([
      { skill: "Cloak", from: 0, to: 1, cost: 2 },
      { skill: "Tracer", from: 0, to: 2, cost: 6 },
    ]);
    expect(plan.spent).toBe(8);
    expect(plan.rankPerSecond).toBe(1);
    expect(plan.rankPerSecondAfter).toBeCloseTo(1.12, 12);
    // A point's gain, not a level's: Blade's Intuition gains more (0.03) for 3 points, Cloak less (0.025) for 2, so
    // more a point (0.0125 against 0.01): Cloak, and the 1 point left buys nothing.
    const perPoint = planBladeburnerSkills({
      levels: {},
      points: 3,
      costMultiplier: 1,
      rankPerSecond: (levels) => 1 + 0.03 * (levels["Blade's Intuition"] ?? 0) + 0.025 * (levels.Cloak ?? 0),
    });
    expect(perPoint.buys).toEqual([{ skill: "Cloak", from: 0, to: 1, cost: 2 }]);
    // A tie: the first in the game's order.
    const even = planBladeburnerSkills({
      levels: {},
      points: 2,
      costMultiplier: 1,
      rankPerSecond: (levels) => 1 + 0.01 * ((levels.Cloak ?? 0) + (levels.Tracer ?? 0)),
    });
    expect(even.buys).toEqual([{ skill: "Cloak", from: 0, to: 1, cost: 2 }]);
    // No gain: nothing bought, however many points.
    expect(planBladeburnerSkills({ levels: {}, points: 1000, costMultiplier: 1, rankPerSecond: () => 1 }).buys).toEqual(
      [],
    );
    // BN7's 2: Tracer's first level 4 points; 3 buys nothing.
    expect(planBladeburnerSkills({ levels: {}, points: 3, costMultiplier: 2, rankPerSecond }).buys).toEqual([]);
    expect(planBladeburnerSkills({ levels: {}, points: 4, costMultiplier: 2, rankPerSecond }).buys).toEqual([
      { skill: "Tracer", from: 0, to: 1, cost: 4 },
    ]);
  });

  test("a gain only several levels on (a whole second's step) is seen; the max level kept; from the levels read", () => {
    // Overclock gains only at 3 levels and over (the time a whole second): 3 levels from 87 cost round(3 × (3 +
    // 1.4 × 88)) = 379; the max 90 stops it there.
    const rankPerSecond = (levels: BladeburnerSkillLevels) => ((levels.Overclock ?? 0) >= 90 ? 2 : 1);
    const plan = planBladeburnerSkills({ levels: { Overclock: 87 }, points: 10_000, costMultiplier: 1, rankPerSecond });
    expect(plan.buys).toEqual([{ skill: "Overclock", from: 87, to: 90, cost: 379 }]);
    expect(
      planBladeburnerSkills({ levels: { Overclock: 87 }, points: 378, costMultiplier: 1, rankPerSecond }).buys,
    ).toEqual([]);
    // Left out: no forecast weighs Hands of Midas, Hyperdrive or Datamancer.
    expect(BLADEBURNER_RANK_SKILLS).not.toContain("Hands of Midas");
    expect(BLADEBURNER_RANK_SKILLS).not.toContain("Hyperdrive");
    expect(BLADEBURNER_RANK_SKILLS).not.toContain("Datamancer");
    expect(cheapestBladeburnerSkillLevel({}, 1)).toBe(1);
    expect(cheapestBladeburnerSkillLevel({ "Cyber's Edge": 3 }, 1)).toBe(2);
    expect(cheapestBladeburnerSkillLevel({ "Cyber's Edge": 3 }, 2)).toBe(4);
  });

  test("by B2's forecast: the levels raise its rank a second; at the levels read, B2's own plan", () => {
    const who = person();
    const input = {
      readings: readingsAt({}),
      person: who,
      stamina: maxStaminaOf(who, 0),
      maxStamina: maxStaminaOf(who, 0),
      rankMultiplier: 1,
      speed: 1,
    };
    const b2 = chooseBladeburnerAction(input);
    // The levels read as planned: B2's plan.
    expect(chooseBladeburnerAction({ ...input, skills: { read: {}, planned: {} } }).rankPerSecond).toBeCloseTo(
      b2.rankPerSecond,
      12,
    );
    const plan = chooseBladeburnerSkills(input, { levels: {}, points: 30, costMultiplier: 1 });
    expect(plan.rankPerSecond).toBeCloseTo(b2.rankPerSecond, 12);
    expect(plan.spent).toBeLessThanOrEqual(30);
    expect(plan.spent).toBe(plan.buys.reduce((sum, buy) => sum + buy.cost, 0));
    expect(plan.buys.length).toBeGreaterThan(1);
    expect(plan.rankPerSecondAfter).toBeGreaterThan(plan.rankPerSecond * 1.1);
    // Read at the planned levels (the game's range, the max stamina and its regain then), the forecast is the plan's.
    const levels = Object.fromEntries(plan.buys.map((buy) => [buy.skill, buy.to])) as BladeburnerSkillLevels;
    const maxAfter = maxStaminaOf(who, 0, bladeburnerSkillMultsOf(levels));
    const after = chooseBladeburnerAction({
      ...input,
      readings: readingsAt(levels),
      stamina: maxAfter,
      maxStamina: maxAfter,
      skills: { read: levels },
    });
    expect(after.rankPerSecond).toBeCloseTo(plan.rankPerSecondAfter, 9);
    // What's left buys nothing that gains: each rank skill's next level is over it, or gains nothing.
    for (const name of BLADEBURNER_RANK_SKILLS) {
      const level = levels[name] ?? 0;
      const more =
        bladeburnerSkillCost(skillOf(name), 0, level + 1, 1) - bladeburnerSkillCost(skillOf(name), 0, level, 1);
      const rate = chooseBladeburnerAction({
        ...input,
        skills: { read: {}, planned: { ...levels, [name]: level + 1 } },
      });
      expect(more > 30 - plan.spent || rate.rankPerSecond <= plan.rankPerSecondAfter, name).toBe(true);
    }
    // No points: none. No work (the counts out): no level gains, none bought.
    expect(chooseBladeburnerSkills(input, { levels: {}, points: 0, costMultiplier: 1 }).buys).toEqual([]);
    const idle = { ...input, readings: readingsAt({}, { count: 0.5 }) };
    expect(chooseBladeburnerSkills(idle, { levels: {}, points: 100, costMultiplier: 1 }).buys).toEqual([]);
  });

  test("Cyber's Edge is worth its duty cycle: more regain, more of the cycle worked", () => {
    const who = person();
    const max = maxStaminaOf(who, 0);
    const input = { readings: readingsAt({}), person: who, stamina: max, maxStamina: max, rankMultiplier: 1, speed: 1 };
    const without = chooseBladeburnerAction(input);
    const withEdge = chooseBladeburnerAction({ ...input, skills: { read: {}, planned: { "Cyber's Edge": 10 } } });
    expect(withEdge.regain).toBeCloseTo(
      staminaGainPerSecond(who, max * 1.2, bladeburnerSkillMultsOf({ "Cyber's Edge": 10 })),
      12,
    );
    expect(withEdge.duty).toBeGreaterThan(without.duty);
    expect(withEdge.rankPerSecond).toBeGreaterThan(without.rankPerSecond);
    // Bounty Hunter still: its chance and time don't move with the stamina.
    expect(withEdge.work).toEqual(without.work);
  });
});
