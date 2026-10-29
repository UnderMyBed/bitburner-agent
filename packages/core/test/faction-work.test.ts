// Faction work's reputation and the augmentations' hacking value (#203): the game's formulas worked by hand, and the
// constants checked against the pinned game's source. The brain's faction-work-parity.test.ts checks the rate against
// the engine's own `ns.formulas.work.factionGains`.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import {
  FACTION_WORK_CYCLES_PER_SECOND,
  factionReputationPerCycle,
  factionReputationPerSecond,
  HACKING_MULTIPLIERS,
  hackingSkillValue,
  hackingValue,
  MAX_SKILL_LEVEL,
  UNFOCUSED_WORK_BONUS,
  type WorkingPerson,
} from "../src/faction-work.ts";

const source = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A fresh start's player at hacking 55. */
const FRESH: WorkingPerson = {
  skills: { hacking: 55, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
  mults: { faction_rep: 1 },
};
/** One with every figure the formulas read moved. */
const MOVED: WorkingPerson = {
  skills: { hacking: 300, strength: 40, defense: 50, dexterity: 60, agility: 70, charisma: 80, intelligence: 90 },
  mults: { faction_rep: 1.25 },
};

test("the constants are the pinned game's: 975, 200 ms a cycle, 0.8 unfocused", () => {
  const constants = source("Constants.ts");
  expect(constants).toContain(`MaxSkillLevel: ${MAX_SKILL_LEVEL},`);
  expect(constants).toContain(`MilliPerCycle: ${1000 / FACTION_WORK_CYCLES_PER_SECOND},`);
  expect(constants).toContain(`BaseFocusBonus: ${UNFOCUSED_WORK_BONUS},`);
  expect(source("PersonObjects/formulas/intelligence.ts")).toContain(
    "return 1 + (weight * Math.pow(intelligence, 0.8)) / 600;",
  );
});

/** The game's intelligence bonus at weight 1, as each faction work formula takes it. */
const intelligenceBonus = (intelligence: number) => 1 + intelligence ** 0.8 / 600;

test("hacking work: (hacking + intelligence/3) / 975 × faction_rep × the intelligence bonus × (1 + favour/100)", () => {
  expect(factionReputationPerCycle(FRESH, "hacking", 0, 0, 1)).toBeCloseTo(55 / 975, 15);
  const { skills } = MOVED;
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 0, 1)).toBeCloseTo(
    ((skills.hacking + skills.intelligence / 3) / 975) * 1.25 * intelligenceBonus(90) * 1.25,
    15,
  );
  // SF15.3 adds a tenth of charisma (`reputation.ts:54-59`); below level 3, nothing.
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 2, 1)).toBe(
    factionReputationPerCycle(MOVED, "hacking", 25, 0, 1),
  );
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 3, 1)).toBeCloseTo(
    ((skills.hacking + skills.intelligence / 3 + skills.charisma * 0.1) / 975) * 1.25 * intelligenceBonus(90) * 1.25,
    15,
  );
});

test("field work: 0.9 × (str + def + dex + agi + cha + hacking + intelligence) / 975 / 5.5 × the rest", () => {
  expect(factionReputationPerCycle(FRESH, "field", 0, 0, 1)).toBeCloseTo((0.9 * 60) / 975 / 5.5, 15);
  const { skills } = MOVED;
  const sum = 40 + 50 + 60 + 70 + 80 + skills.hacking + skills.intelligence;
  expect(factionReputationPerCycle(MOVED, "field", 50, 0, 1)).toBeCloseTo(
    ((0.9 * sum) / 975 / 5.5) * 1.25 * 1.5 * intelligenceBonus(90),
    15,
  );
  // SF15.3: three tenths of charisma beside hacking and intelligence.
  expect(factionReputationPerCycle(MOVED, "field", 50, 3, 1)).toBeCloseTo(
    ((0.9 * (sum + 80 * 0.3)) / 975 / 5.5) * 1.25 * 1.5 * intelligenceBonus(90),
    15,
  );
});

test("security work: 0.9 × (str + def + dex + agi + hacking + intelligence) / 975 / 4.5 × the rest, no charisma", () => {
  expect(factionReputationPerCycle(FRESH, "security", 0, 0, 1)).toBeCloseTo((0.9 * 59) / 975 / 4.5, 15);
  const sum = 40 + 50 + 60 + 70 + 300 + 90;
  expect(factionReputationPerCycle(MOVED, "security", 10, 0, 1)).toBeCloseTo(
    ((0.9 * sum) / 975 / 4.5) * 1.25 * 1.1 * intelligenceBonus(90),
    15,
  );
  expect(factionReputationPerCycle(MOVED, "security", 10, 3, 1)).toBeCloseTo(
    ((0.9 * (sum + 80 * 0.3)) / 975 / 4.5) * 1.25 * 1.1 * intelligenceBonus(90),
    15,
  );
});

test("a skill or multiplier that isn't a finite number, or a negative favour, throws rather than guess", () => {
  const broken = { ...FRESH, skills: { ...FRESH.skills, strength: Number.NaN } };
  expect(() => factionReputationPerCycle(broken, "field", 0, 0, 1)).toThrow(/strength/);
  expect(() =>
    factionReputationPerCycle({ ...FRESH, mults: { faction_rep: Number.POSITIVE_INFINITY } }, "hacking", 0, 0, 1),
  ).toThrow(/faction_rep/);
  expect(() => factionReputationPerCycle(FRESH, "hacking", Number.NaN, 0, 1)).toThrow(/favour/);
});

test("factionReputationPerSecond: five cycles a second, × 0.8 unfocused unless the implant is installed", () => {
  const perCycle = factionReputationPerCycle(FRESH, "hacking", 0, 0, 1);
  const options = { favor: 0, sourceFile15Level: 0, factionWorkRepGain: 1 };
  expect(factionReputationPerSecond(FRESH, "hacking", { ...options, focused: true, implant: false })).toBeCloseTo(
    perCycle * 5,
    15,
  );
  expect(factionReputationPerSecond(FRESH, "hacking", { ...options, focused: false, implant: false })).toBeCloseTo(
    perCycle * 5 * 0.8,
    15,
  );
  expect(factionReputationPerSecond(FRESH, "hacking", { ...options, focused: false, implant: true })).toBeCloseTo(
    perCycle * 5,
    15,
  );
  // About 0.28 a second at hacking 55, focused: the figure the issue quotes.
  expect(factionReputationPerSecond(FRESH, "hacking", { ...options, focused: true, implant: false })).toBeCloseTo(
    0.282,
    3,
  );
});

test("the BitNode's FactionWorkRepGain scales every work type (#203 review): 0.2 in BN14", () => {
  for (const workType of ["hacking", "field", "security"] as const) {
    expect(factionReputationPerCycle(MOVED, workType, 25, 0, 0.2)).toBeCloseTo(
      factionReputationPerCycle(MOVED, workType, 25, 0, 1) * 0.2,
      15,
    );
  }
  expect(() => factionReputationPerCycle(FRESH, "hacking", 0, 0, Number.NaN)).toThrow(/FactionWorkRepGain/);
  expect(source("PersonObjects/formulas/reputation.ts")).toContain(
    "return favorMult * currentNodeMults.FactionWorkRepGain;",
  );
});

test("the formulas are the pinned game's: the terms and divisors in reputation.ts", () => {
  const reputation = source("PersonObjects/formulas/reputation.ts");
  expect(reputation).toContain("let favorMult = 1 + favor / 100;");
  expect(reputation).toContain(
    "((p.skills.hacking + p.skills.intelligence / 3 + getDarknetCharismaBonus(p, 0.1)) / CONSTANTS.MaxSkillLevel) *",
  );
  expect(reputation).toMatch(
    /getDarknetCharismaBonus\(p, 0\.3\) \+\s+\(p\.skills\.hacking \+ p\.skills\.intelligence\) \*/,
  );
  expect(reputation).toMatch(/CONSTANTS\.MaxSkillLevel \/\s+4\.5;/);
  expect(reputation).toMatch(/CONSTANTS\.MaxSkillLevel \/\s+5\.5;/);
  expect(reputation).toContain("if (Player.activeSourceFileLvl(15) >= 3) {");
  expect(source("Work/FactionWork.tsx")).toContain(
    "return calculateFactionRep(Player, this.factionWorkType, this.getFaction().favor) * focusBonus;",
  );
});

test("HACKING_MULTIPLIERS: the hacking ones and faction reputation, each a key some augmentation has", () => {
  expect(HACKING_MULTIPLIERS).toEqual([
    "hacking",
    "hacking_speed",
    "hacking_money",
    "hacking_grow",
    "hacking_chance",
    "hacking_exp",
    "faction_rep",
  ]);
  const keys = new Set(Object.values(AUGMENTATIONS).flatMap((each) => Object.keys(each.multipliers)));
  for (const key of HACKING_MULTIPLIERS) expect(keys).toContain(key);
});

test("hackingSkillValue: ×m on the skill as the experience multiplier that lifts the level as much, at level L", () => {
  // The level is m × (32 ln(exp + 534.6) − 200): ×x on experience adds 32 ln x before m, so ln x = (L/32)(1 − 1/m).
  expect(hackingSkillValue(1.05, 300)).toBeCloseTo((300 / 32) * (1 - 1 / 1.05), 15);
  expect(hackingSkillValue(1, 300)).toBe(0);
  // A level's worth: ×1.05 at 300 is ×1.56 on experience; at 3000, ×87.
  expect(Math.exp(hackingSkillValue(1.05, 300))).toBeCloseTo(1.5627, 4);
  expect(Math.exp(hackingSkillValue(1.05, 3000))).toBeCloseTo(86.859, 2);
  for (const odd of [0, Number.NaN]) expect(() => hackingSkillValue(1.05, odd)).toThrow(/hacking level/);
  expect(source("PersonObjects/formulas/skill.ts")).toContain(
    "const value = Math.floor(mult * (32 * Math.log(exp + 534.6) - 200));",
  );
});

test("hackingValue: the hacking skill weighed by the level, the other multipliers' logarithms; others nothing", () => {
  // BitWire: hacking 1.05 only.
  expect(hackingValue("BitWire", 300)).toBeCloseTo(hackingSkillValue(1.05, 300), 15);
  // Neurotrainer I: every exp 1.1, hacking_exp among them, the level aside.
  expect(hackingValue("Neurotrainer I", 300)).toBeCloseTo(Math.log(1.1), 15);
  expect(hackingValue("Neurotrainer I", 3000)).toBeCloseTo(Math.log(1.1), 15);
  // The review's case: at level 300, BitWire is worth more than Neurotrainer I, not half of it (summed logs: 0.049
  // against 0.095).
  expect(hackingValue("BitWire", 300)).toBeGreaterThan(hackingValue("Neurotrainer I", 300) * 4);
  // Cranial Signal Processors - Gen II: hacking_chance 1.05, hacking_speed 1.02, hacking 1.07.
  expect(hackingValue("Cranial Signal Processors - Gen II", 100)).toBeCloseTo(
    Math.log(1.05) + Math.log(1.02) + hackingSkillValue(1.07, 100),
    15,
  );
  // Combat only, and The Red Pill: nothing.
  expect(hackingValue("Augmented Targeting I", 300)).toBe(0);
  expect(hackingValue("The Red Pill", 300)).toBe(0);
  expect(() => hackingValue("No Such Augmentation", 300)).toThrow(/No Such Augmentation/);
});
