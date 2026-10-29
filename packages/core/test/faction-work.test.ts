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
  expect(factionReputationPerCycle(FRESH, "hacking", 0, 0)).toBeCloseTo(55 / 975, 15);
  const { skills } = MOVED;
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 0)).toBeCloseTo(
    ((skills.hacking + skills.intelligence / 3) / 975) * 1.25 * intelligenceBonus(90) * 1.25,
    15,
  );
  // SF15.3 adds a tenth of charisma (`reputation.ts:54-59`); below level 3, nothing.
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 2)).toBe(factionReputationPerCycle(MOVED, "hacking", 25, 0));
  expect(factionReputationPerCycle(MOVED, "hacking", 25, 3)).toBeCloseTo(
    ((skills.hacking + skills.intelligence / 3 + skills.charisma * 0.1) / 975) * 1.25 * intelligenceBonus(90) * 1.25,
    15,
  );
});

test("field work: 0.9 × (str + def + dex + agi + cha + hacking + intelligence) / 975 / 5.5 × the rest", () => {
  expect(factionReputationPerCycle(FRESH, "field", 0, 0)).toBeCloseTo((0.9 * 60) / 975 / 5.5, 15);
  const { skills } = MOVED;
  const sum = 40 + 50 + 60 + 70 + 80 + skills.hacking + skills.intelligence;
  expect(factionReputationPerCycle(MOVED, "field", 50, 0)).toBeCloseTo(
    ((0.9 * sum) / 975 / 5.5) * 1.25 * 1.5 * intelligenceBonus(90),
    15,
  );
  // SF15.3: three tenths of charisma beside hacking and intelligence.
  expect(factionReputationPerCycle(MOVED, "field", 50, 3)).toBeCloseTo(
    ((0.9 * (sum + 80 * 0.3)) / 975 / 5.5) * 1.25 * 1.5 * intelligenceBonus(90),
    15,
  );
});

test("security work: 0.9 × (str + def + dex + agi + hacking + intelligence) / 975 / 4.5 × the rest, no charisma", () => {
  expect(factionReputationPerCycle(FRESH, "security", 0, 0)).toBeCloseTo((0.9 * 59) / 975 / 4.5, 15);
  const sum = 40 + 50 + 60 + 70 + 300 + 90;
  expect(factionReputationPerCycle(MOVED, "security", 10, 0)).toBeCloseTo(
    ((0.9 * sum) / 975 / 4.5) * 1.25 * 1.1 * intelligenceBonus(90),
    15,
  );
  expect(factionReputationPerCycle(MOVED, "security", 10, 3)).toBeCloseTo(
    ((0.9 * (sum + 80 * 0.3)) / 975 / 4.5) * 1.25 * 1.1 * intelligenceBonus(90),
    15,
  );
});

test("a skill or multiplier that isn't a finite number, or a negative favour, throws rather than guess", () => {
  const broken = { ...FRESH, skills: { ...FRESH.skills, strength: Number.NaN } };
  expect(() => factionReputationPerCycle(broken, "field", 0, 0)).toThrow(/strength/);
  expect(() =>
    factionReputationPerCycle({ ...FRESH, mults: { faction_rep: Number.POSITIVE_INFINITY } }, "hacking", 0, 0),
  ).toThrow(/faction_rep/);
  expect(() => factionReputationPerCycle(FRESH, "hacking", Number.NaN, 0)).toThrow(/favour/);
});

test("factionReputationPerSecond: five cycles a second, × 0.8 unfocused unless the implant is installed", () => {
  const perCycle = factionReputationPerCycle(FRESH, "hacking", 0, 0);
  const options = { favor: 0, sourceFile15Level: 0 };
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

test("hackingValue: the logarithms of the hacking multipliers added up; others count for nothing", () => {
  // BitWire: hacking 1.05 only.
  expect(hackingValue("BitWire")).toBeCloseTo(Math.log(1.05), 15);
  // Neurotrainer I: every exp 1.1, hacking_exp among them.
  expect(hackingValue("Neurotrainer I")).toBeCloseTo(Math.log(1.1), 15);
  // Cranial Signal Processors - Gen II: hacking_chance 1.05, hacking_speed 1.02, hacking 1.07.
  expect(hackingValue("Cranial Signal Processors - Gen II")).toBeCloseTo(
    Math.log(1.05) + Math.log(1.02) + Math.log(1.07),
    15,
  );
  // Combat only, and The Red Pill: nothing.
  expect(hackingValue("Augmented Targeting I")).toBe(0);
  expect(hackingValue("The Red Pill")).toBe(0);
  expect(() => hackingValue("No Such Augmentation")).toThrow(/No Such Augmentation/);
});
