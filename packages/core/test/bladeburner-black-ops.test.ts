// Bladeburner B5 (#392): the Black Ops' figures checked against the pinned game's source, the formulas worked by hand,
// and the rule's check of when to run the next, on both sides of its bound. The parity against the engine itself is
// the simulator's (packages/brain/test/bladeburner-black-ops-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  chooseBladeburnerAction,
  maxStaminaOf,
} from "../src/bladeburner-actions.ts";
import {
  BLACK_OP_TIME_PENALTY,
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_RANKS_PER_SKILL_POINT,
  type BladeburnerBlackOp,
  blackOpChanceLow,
  blackOpHpLoss,
  blackOpRankGain,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpSecondsToDone,
  blackOpStaminaCost,
  blackOpSuccessChance,
  bladeburnerBlackOp,
  checkBladeburnerBlackOp,
} from "../src/bladeburner-black-ops.ts";
import {
  type BladeburnerSkillLevels,
  bladeburnerSkillMultsOf,
  cheapestBladeburnerSkillLevel,
  planBladeburnerSkills,
} from "../src/bladeburner-skills.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma 1, no intelligence. */
function person(combat = 100, overrides: Partial<BladeburnerPerson["skills"]> = {}): BladeburnerPerson {
  return {
    skills: {
      hacking: 1,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma: 1,
      intelligence: 0,
      ...overrides,
    },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

const TYPHOON = BLADEBURNER_BLACK_OPS[0] as BladeburnerBlackOp;
const ZERO = BLADEBURNER_BLACK_OPS[1] as BladeburnerBlackOp;

describe("the game's facts", () => {
  test("the 21 Black Ops' figures and order are the data file's", () => {
    const file = gameSource("Bladeburner/data/BlackOperations.ts");
    const enums = gameSource("Bladeburner/Enums.ts");
    expect(BLADEBURNER_BLACK_OPS).toHaveLength(21);
    expect(file).toContain("export const numberOfBlackOperations = Object.keys(BladeburnerBlackOpName).length;");
    expect(enums).toContain(`BlackOp = "${BLACK_OPERATIONS}",`);
    BLADEBURNER_BLACK_OPS.forEach((op, n) => {
      const key = [...enums.matchAll(/ {2}(\w+) = "([^"]+)",/g)].find((match) => match[2] === op.name)?.[1];
      expect(key, op.name).toBeDefined();
      const from = file.indexOf(`name: BladeburnerBlackOpName.${key},`);
      expect(from, op.name).toBeGreaterThan(0);
      const rest = file.slice(from + 1);
      const block = rest.slice(0, rest.search(/\n {4}\[BladeburnerBlackOpName/) + 1 || undefined);
      // Each field's literal, as a number (the file writes 2.5e3, 10e3, ...): absent is the default 0.
      const field = (name: string) => {
        const match = new RegExp(`\\n {6}${name}: ([\\d.e]+),`).exec(block);
        return match === null ? 0 : Number(match[1]);
      };
      expect(field("n"), `${op.name}'s place`).toBe(n);
      expect(field("reqdRank"), `${op.name}'s rank`).toBe(op.rank);
      expect(field("baseDifficulty"), `${op.name}'s difficulty`).toBe(op.baseDifficulty);
      expect(field("rankGain"), `${op.name}'s gain`).toBe(op.rankGain);
      expect(field("rankLoss"), `${op.name}'s loss`).toBe(op.rankLoss);
      expect(field("hpLoss"), `${op.name}'s HP`).toBe(op.hpLoss);
      for (const [table, values] of [
        ["weights", op.weights],
        ["decays", op.decays],
      ] as const) {
        const lines = Object.entries(values)
          .map(([stat, value]) => `        ${stat}: ${value},`)
          .join("\n");
        expect(block, `${op.name}'s ${table}`).toContain(`      ${table}: {\n${lines}\n      },`);
      }
      expect(block.includes("isStealth: true,"), `${op.name}'s stealth`).toBe(op.isStealth);
      expect(block.includes("isKill: true,"), `${op.name}'s kill`).toBe(op.isKill);
    });
    expect(BLADEBURNER_BLACK_OPS.at(-1)).toMatchObject({ name: "Operation Daedalus", rank: 400_000 });
    expect(bladeburnerBlackOp("Operation Zero")).toBe(ZERO);
    expect(bladeburnerBlackOp("Raid")).toBeNull();
  });

  test("the formulas' lines are the game's", () => {
    const blackOp = gameSource("Bladeburner/Actions/BlackOperation.ts");
    expect(blackOp).toContain(
      'if (bladeburner.numBlackOpsComplete < this.n) return { error: "Have not completed the previous Black Operation" };',
    );
    expect(blackOp).toContain('if (bladeburner.rank < this.reqdRank) return { error: "Insufficient rank" };');
    expect(blackOp).toMatch(/getActionTimePenalty\(\): number \{\n\s+return 1\.5;/);
    expect(BLACK_OP_TIME_PENALTY).toBe(1.5);
    expect(blackOp).toMatch(/getPopulationSuccessFactor\(\): number \{\n\s+return 1;/);
    expect(blackOp).toMatch(/getChaosSuccessFactor\(\): number \{\n\s+return 1;/);
    expect(blackOp).toContain("teamCount = 0;");
    expect(blackOp).toContain("getActionTypeSkillSuccessBonus = operationSkillSuccessBonus;");
    expect(gameSource("Bladeburner/Actions/Action.ts")).toContain(
      "return Math.ceil(baseTime * this.getActionTimePenalty());",
    );
    const formulas = gameSource("Bladeburner/Formulas.ts");
    expect(formulas).toMatch(
      /case BladeburnerActionType\.BlackOp:\n\s+return action\.rankGain \* currentNodeMults\.BladeburnerRank;/,
    );
    expect(formulas).toMatch(/case BladeburnerActionType\.BlackOp:\n\s+return action\.rankLoss;/);
    const bladeburner = gameSource("Bladeburner/Bladeburner.ts");
    expect(bladeburner).toContain("this.resetAction(); // Stop regardless of success or fail");
    expect(bladeburner).toContain("if (action.type != BladeburnerActionType.BlackOp) {");
    expect(bladeburner).toContain("if (!action.getAvailability(this).available) return this.resetAction();");
    expect(bladeburner).toContain("rankGain = addOffset(calculateActionRankGain(action), 10);");
    expect(bladeburner).toContain("rankLoss = addOffset(calculateActionRankLoss(action), 10);");
    expect(gameSource("Bladeburner/data/Constants.ts")).toContain("RanksPerSkillPoint: 3,");
    expect(BLADEBURNER_RANKS_PER_SKILL_POINT).toBe(3);
    expect(gameSource("NetscriptFunctions/Bladeburner.ts")).toContain(
      "return bladeburner.numBlackOpsComplete > action.n ? 0 : 1;",
    );
  });
});

describe("the formulas, worked by hand", () => {
  test("success: the weighted levels, the intelligence and stamina, the operations' and kill's skills; no city", () => {
    const who = person(200, { hacking: 50, intelligence: 30 });
    let competence = 0;
    for (const [stat, weight] of Object.entries(TYPHOON.weights)) {
      competence +=
        weight * (who.skills[stat as keyof BladeburnerPerson["skills"]] as number) ** TYPHOON.decays[stat as "hacking"];
    }
    const intelligence = 1 + (0.75 * 30 ** 0.8) / 600;
    expect(blackOpSuccessChance(TYPHOON, who, { penalty: 1 })).toBeCloseTo((competence * intelligence) / 2000, 12);
    expect(blackOpSuccessChance(TYPHOON, who, { penalty: 0.5 })).toBeCloseTo(
      (competence * intelligence * 0.5) / 2000,
      12,
    );
    // Digital Observer (the operations') and Short-Circuit (kill) count for Typhoon; Cloak (stealth) and Tracer don't.
    const skills = bladeburnerSkillMultsOf({ "Digital Observer": 5, "Short-Circuit": 2, Cloak: 7, Tracer: 9 });
    expect(blackOpSuccessChance(TYPHOON, who, { penalty: 1, skills })).toBeCloseTo(
      (competence * intelligence * skills.successOperation * skills.successKill) / 2000,
      12,
    );
    // Zero is stealthy, not a kill.
    const zeroPlain = blackOpSuccessChance(ZERO, who, { penalty: 1 });
    expect(blackOpSuccessChance(ZERO, who, { penalty: 1, skills })).toBeCloseTo(
      zeroPlain * skills.successOperation * skills.successStealth,
      12,
    );
    expect(blackOpSuccessChance(TYPHOON, person(1e6), { penalty: 1 })).toBe(1);
  });

  test("time: ⌈max(1, difficulty/10 × Overclock's / statFac) × 1.5⌉; rank, stamina and HP", () => {
    const who = person(100);
    const statFac = 0.5 * (100 ** 0.04 + 100 ** 0.035 + 100 / 1e4 + 100 / 1e4);
    expect(blackOpSeconds(TYPHOON, who)).toBe(Math.ceil((200 / statFac) * 1.5));
    const overclock = bladeburnerSkillMultsOf({ Overclock: 90 });
    expect(blackOpSeconds(TYPHOON, who, overclock)).toBe(Math.ceil(Math.max(1, (200 * 0.1) / statFac) * 1.5));
    // The 1 floor before the 1.5 (`Action.ts:119-121`).
    expect(blackOpSeconds({ ...TYPHOON, baseDifficulty: 1 }, who)).toBe(2);
    expect(blackOpRankGain(TYPHOON, 1)).toBe(50);
    expect(blackOpRankGain(TYPHOON, 0.6)).toBeCloseTo(30, 12);
    expect(blackOpRankLoss(TYPHOON)).toBe(10);
    const diffMult = 2000 ** 0.28 + 2000 / 650;
    expect(blackOpStaminaCost(TYPHOON)).toBeCloseTo(0.285 * diffMult, 12);
    expect(blackOpHpLoss(TYPHOON)).toBeCloseTo(100 * diffMult, 12);
  });

  test("the expected time to it done: (seconds + (1 − chance) × rebuild) / chance; never at 0", () => {
    expect(blackOpSecondsToDone(1, 243, 500)).toBe(243);
    expect(blackOpSecondsToDone(0.25, 243, 500)).toBeCloseTo((243 + 0.75 * 500) / 0.25, 9);
    expect(blackOpSecondsToDone(0, 243, 500)).toBe(Number.POSITIVE_INFINITY);
    // The low end read, the penalty out: scaled while under 1, as read once the high end is clamped.
    expect(blackOpChanceLow([0.2, 0.25], 0.5)).toBeCloseTo(0.4, 12);
    expect(blackOpChanceLow([0.8, 1], 0.5)).toBe(0.8);
    expect(blackOpChanceLow([0.2, 0.25], 0)).toBeNull();
  });
});

describe("the check (#392): when to run the next Black Op", () => {
  const CITY = { population: 1e9, communities: 50, chaos: 0 };
  /** The rule's forecast input, each contract and operation read at level 1, at `levels`. */
  function inputAt(who: BladeburnerPerson, levels: BladeburnerSkillLevels) {
    const mults = bladeburnerSkillMultsOf(levels);
    const readings: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
      const chance = actionSuccessChance(action, 1, who, { city: CITY, penalty: 1, skills: mults });
      return { type: action.type, name: action.name, level: 1, maxLevel: 3, count: 100, chance: [chance, chance] };
    });
    const maxStamina = maxStaminaOf(who, 0, mults);
    return {
      readings,
      person: who,
      stamina: maxStamina,
      maxStamina,
      rankMultiplier: 1,
      speed: 1,
      skills: { read: levels },
    };
  }
  const who = person(100);
  const input = inputAt(who, {});
  const skills = { levels: {}, points: 0, costMultiplier: 1 };

  test("under its rank: never, whatever the chance", () => {
    const check = checkBladeburnerBlackOp(input, { op: TYPHOON, rank: 2499.9, chance: [0.9, 0.9], skills });
    expect(check).toMatchObject({ met: false, run: false, chance: 0.9, rank: 2500 });
  });

  test("at its rank: the rebuild is #386's least time from its rank less the loss; the expected time to it done", () => {
    const check = checkBladeburnerBlackOp(input, { op: TYPHOON, rank: 2500, chance: [0.6, 0.6], skills: null });
    const rebuild = chooseBladeburnerAction({ ...input, target: { rank: 2490, target: 2500 } }).toTarget?.seconds;
    expect(rebuild).toBeGreaterThan(0);
    expect(check.rebuild).toBe(rebuild);
    expect(check.seconds).toBe(blackOpSeconds(TYPHOON, who));
    expect(check.expected).toBeCloseTo(blackOpSecondsToDone(0.6, check.seconds, rebuild as number), 9);
    // Without B3's skills read: run at any chance over 0, none at 0.
    expect(check).toMatchObject({ met: true, run: true, wait: null, bound: 0 });
    expect(checkBladeburnerBlackOp(input, { op: TYPHOON, rank: 2500, chance: [0, 0], skills: null }).run).toBe(false);
    // The stamina's penalty out of the low end read.
    const tired = checkBladeburnerBlackOp(
      { ...input, stamina: input.maxStamina / 4 },
      { op: TYPHOON, rank: 2500, chance: [0.3, 0.3], skills: null },
    );
    expect(tired.chance).toBeCloseTo(0.6, 12);
  });

  test("the look-ahead: the points the cheapest level is short of, B3's plan with them, both sides of the bound", () => {
    // Overclock at its max and some levels read: B3's next level (Blade's Intuition, Digital Observer or Short-Circuit)
    // raises Typhoon's chance.
    const levels: BladeburnerSkillLevels = { Overclock: 90, Tracer: 20, "Cyber's Edge": 10 };
    const input = inputAt(who, levels);
    const skills = { levels, points: 0, costMultiplier: 1 };
    const check = checkBladeburnerBlackOp(input, { op: TYPHOON, rank: 2500, chance: [0.05, 0.05], skills });
    const wait = check.wait;
    if (wait === null) throw new Error("no look-ahead");
    // The points: the cheapest level's, none unspent; their seconds at the plan's rank a second, 3 rank a point.
    const points = cheapestBladeburnerSkillLevel(levels, 1);
    expect(wait.points).toBe(points);
    const rate = chooseBladeburnerAction(input).rankPerSecond;
    expect(wait.seconds).toBeCloseTo((points * 3) / rate, 9);
    // B3's plan with them, and the Black Op's competence at its levels over the levels read.
    const plan = planBladeburnerSkills({
      levels,
      points,
      costMultiplier: 1,
      rankPerSecond: (planned) =>
        chooseBladeburnerAction({ ...input, skills: { read: levels, planned } }).rankPerSecond,
    });
    expect(plan.buys.length).toBeGreaterThan(0);
    const planned = { ...levels, ...Object.fromEntries(plan.buys.map((buy) => [buy.skill, buy.to])) };
    const ratio =
      blackOpSuccessChance(TYPHOON, who, { penalty: 1, skills: bladeburnerSkillMultsOf(planned) }) /
      blackOpSuccessChance(TYPHOON, who, { penalty: 1, skills: bladeburnerSkillMultsOf(levels) });
    expect(ratio).toBeGreaterThan(1);
    expect(wait.chance).toBeCloseTo(0.05 * ratio, 12);
    expect(wait.attemptSeconds).toBe(blackOpSeconds(TYPHOON, who, bladeburnerSkillMultsOf(planned)));
    expect(wait.expected).toBeCloseTo(
      wait.seconds + blackOpSecondsToDone(wait.chance, wait.attemptSeconds, check.rebuild),
      6,
    );
    expect(check.run).toBe(check.expected <= wait.expected);
    expect(check.run).toBe(false);
    // The bound between 0 and 1; a chance read on each side of it decides each way.
    console.log(
      `Typhoon at rank 2,500: the look-ahead ${points} points in ${wait.seconds.toFixed(0)} s for ×${ratio.toFixed(4)}; ` +
        `the bound ${(100 * check.bound).toFixed(2)}%; the rebuild ${check.rebuild.toFixed(0)} s`,
    );
    expect(check.bound).toBeGreaterThan(0);
    expect(check.bound).toBeLessThan(1);
    const below = checkBladeburnerBlackOp(input, {
      op: TYPHOON,
      rank: 2500,
      chance: [check.bound * 0.98, check.bound * 0.98],
      skills,
    });
    const above = checkBladeburnerBlackOp(input, {
      op: TYPHOON,
      rank: 2500,
      chance: [check.bound * 1.02, check.bound * 1.02],
      skills,
    });
    expect(below.run).toBe(false);
    expect(below.expected).toBeGreaterThan(below.wait?.expected ?? 0);
    expect(above.run).toBe(true);
    expect(above.expected).toBeLessThanOrEqual(above.wait?.expected ?? 0);
  });

  test("a level the points already cover, or none that raises the chance: run now", () => {
    // Points enough for the cheapest level unspent (B3 found no gain): one point awaited, at least.
    const covered = checkBladeburnerBlackOp(input, {
      op: TYPHOON,
      rank: 2500,
      chance: [0.5, 0.5],
      skills: { levels: {}, points: 1000, costMultiplier: 1 },
    });
    expect(covered.wait?.points).toBe(1);
    // At the chance clamped at 1 (the high end read at 1), no rise is credited: run.
    const sure = checkBladeburnerBlackOp(input, { op: TYPHOON, rank: 2500, chance: [1, 1], skills });
    expect(sure.wait?.chance).toBe(1);
    expect(sure.run).toBe(true);
  });
});
