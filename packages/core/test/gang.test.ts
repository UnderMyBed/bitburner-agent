// Gangs (#325, G1 of #324): the game's facts checked against its source, the formulas worked by hand, and the rule.
// The formulas and the task table are checked against the engine too (packages/brain's gang-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  GANG_FACTIONS,
  GANG_FREE_MEMBERS,
  GANG_MOST_MEMBERS,
  GANG_RECRUIT_RESPECT_BASE,
  GANG_TASK_NAMES,
  type GangMemberFigures,
  gangExpPerCycle,
  gangFactionToForm,
  gangMemberAfter,
  gangMoneyPerCycle,
  gangRecruitsAllowed,
  gangRespectPerCycle,
  gangRespectToRecruit,
  gangSkillLevel,
  gangTask,
  gangTasksFor,
  gangTerritoryLeverage,
  gangWantedPenaltyOf,
  gangWantedPerCycle,
  HACKING_GANG_FACTIONS,
  parseGangState,
} from "../src/gang.ts";
import {
  GANG_MEMBER_NAMES,
  type GangRuleInputs,
  gangBestWork,
  gangLostShare,
  gangLostShareBound,
  gangTrains,
  planGang,
} from "../src/gang-rule.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** The experience that gives `level` with no multipliers: the inverse of `gangSkillLevel`. */
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** A member with these levels (the others 1), their experience to match, and no multipliers. */
function member(name: string, levels: Partial<Record<"hack" | "str" | "def" | "dex" | "agi" | "cha", number>> = {}) {
  const level = (stat: keyof typeof levels) => levels[stat] ?? 1;
  const figures: GangMemberFigures = {
    name,
    task: "Unassigned",
    hack: level("hack"),
    str: level("str"),
    def: level("def"),
    dex: level("dex"),
    agi: level("agi"),
    cha: level("cha"),
    hack_exp: expFor(level("hack")),
    str_exp: expFor(level("str")),
    def_exp: expFor(level("def")),
    dex_exp: expFor(level("dex")),
    agi_exp: expFor(level("agi")),
    cha_exp: expFor(level("cha")),
    hack_mult: 1,
    str_mult: 1,
    def_mult: 1,
    dex_mult: 1,
    agi_mult: 1,
    cha_mult: 1,
    hack_asc_mult: 1,
    str_asc_mult: 1,
    def_asc_mult: 1,
    dex_asc_mult: 1,
    agi_asc_mult: 1,
    cha_asc_mult: 1,
  };
  return figures;
}

const START = { respect: 1, wantedLevel: 1, territory: 1 / 7 };

describe("the game's facts", () => {
  test("the gang factions, the hacking ones, and the recruiting constants are the game's", () => {
    const constants = gameSource("Gang/data/Constants.ts");
    const names = /Names: \[([^\]]+)\]/.exec(constants)?.[1] ?? "";
    const enumNames = [...names.matchAll(/FactionName\.(\w+)/g)].map((match) => match[1]);
    const factionEnum = gameSource("Faction/Enums.ts");
    const factionNames = enumNames.map((key) => new RegExp(`\\b${key} = "([^"]+)"`).exec(factionEnum)?.[1]);
    expect(GANG_FACTIONS).toEqual(factionNames);
    expect(gameSource("NetscriptFunctions/Gang.ts")).toContain(
      "const isHacking = faction === FactionName.NiteSec || faction === FactionName.TheBlackHand;",
    );
    expect(HACKING_GANG_FACTIONS).toEqual(["NiteSec", "The Black Hand"]);
    expect(constants).toContain(`numFreeMembers: ${GANG_FREE_MEMBERS},`);
    expect(constants).toContain(`recruitThresholdBase: ${GANG_RECRUIT_RESPECT_BASE},`);
    expect(constants).toContain(`MaximumGangMembers: ${GANG_MOST_MEMBERS},`);
  });

  test("the task names are the game's, in order", () => {
    const tasks = gameSource("Gang/data/tasks.ts");
    expect(GANG_TASK_NAMES).toEqual([...tasks.matchAll(/^\s+name: "([^"]+)",/gm)].map((match) => match[1]));
  });

  test("a hacking gang's tasks are the hacking ones, a combat gang's the combat ones, both without Unassigned", () => {
    const names = (isHacking: boolean) => gangTasksFor(isHacking).map((each) => each.name);
    expect(names(true)).toContain("Cyberterrorism");
    expect(names(true)).not.toContain("Terrorism");
    expect(names(false)).toContain("Terrorism");
    expect(names(false)).not.toContain("Ethical Hacking");
    for (const isHacking of [true, false]) {
      expect(names(isHacking)).toEqual(expect.arrayContaining(["Vigilante Justice", "Train Hacking"]));
      expect(names(isHacking)).not.toContain("Unassigned");
    }
  });
});

describe("the formulas, by hand", () => {
  test("a skill level from experience, and the experience back", () => {
    expect(gangSkillLevel(0, 1)).toBe(1);
    for (const level of [5, 50, 105, 300]) expect(gangSkillLevel(expFor(level) + 1e-6, 1)).toBe(level);
    expect(gangSkillLevel(expFor(100) + 1e-6, 1.5)).toBe(Math.floor(1.5 * 100));
  });

  test("respect, money and wanted a cycle, and the penalty", () => {
    const hacker = member("a", { hack: 100, cha: 21 });
    // Fraud & Counterfeiting: weight 0.8 × 100 + 0.2 × 21 = 84.2; difficulty 20.
    const fraud = gangTask("Fraud & Counterfeiting");
    const gang = { respect: 3, wantedLevel: 1, territory: 1 / 7 };
    const exponent = 0.2 / 7 + 0.8;
    expect(gangWantedPenaltyOf(gang)).toBe(0.75);
    expect(gangRespectPerCycle(gang, hacker, fraud, 1)).toBeCloseTo(
      (11 * 0.0004 * (84.2 - 80) * (100 / 7 / 100) * 0.75) ** exponent,
      15,
    );
    expect(gangMoneyPerCycle(gang, hacker, fraud, 1)).toBeCloseTo(
      (5 * 45 * (84.2 - 64) * (100 / 7 / 100) * 0.75) ** exponent,
      12,
    );
    expect(gangWantedPerCycle(gang, hacker, fraud)).toBeCloseTo((7 * 0.3) / (3 * (84.2 - 70) * (1 / 7)) ** 0.8, 15);
    // The softcap multiplies the exponent: BN3's 0.9.
    expect(gangRespectPerCycle(gang, hacker, fraud, 0.9)).toBeCloseTo(
      (11 * 0.0004 * (84.2 - 80) * (1 / 7) * 0.75) ** (exponent * 0.9),
      15,
    );
    // Wanted is capped at 100 a cycle: Cyberterrorism just past its difficulty (W − 126 = 0.6) would add 124.
    expect(gangWantedPerCycle(gang, member("c", { hack: 158 }), gangTask("Cyberterrorism"))).toBe(100);
    // A justice task lowers wanted: 0.4 × base × (weight − 3.5 × difficulty) × territory multiplier.
    expect(gangWantedPerCycle(gang, hacker, gangTask("Ethical Hacking"))).toBeCloseTo(
      0.4 * -0.001 * (0.9 * 100 + 0.1 * 21 - 3.5) * (1 / 7),
      15,
    );
    // Short of the difficulty, nothing; and no respect from a task with none.
    expect(gangRespectPerCycle(gang, member("b", { hack: 79 }), gangTask("Fraud & Counterfeiting"), 1)).toBe(0);
    expect(gangRespectPerCycle(gang, hacker, gangTask("Ethical Hacking"), 1)).toBe(0);
    expect(gangMoneyPerCycle(gang, hacker, gangTask("DDoS Attacks"), 1)).toBe(0);
  });

  test("training's experience a cycle, and the levels it gives", () => {
    const recruit = member("a");
    const train = gangTask("Train Hacking");
    // 100 / 1500 × 45^0.9, no multipliers.
    expect(gangExpPerCycle(recruit, train).hack).toBeCloseTo((100 / 1500) * 45 ** 0.9, 15);
    expect(gangExpPerCycle(recruit, train).str).toBe(0);
    expect(gangExpPerCycle({ ...recruit, hack_mult: 1.4, hack_asc_mult: 2 }, train).hack).toBeCloseTo(
      (100 / 1500) * 45 ** 0.9 * 1.1 * 2,
      15,
    );
    expect(gangExpPerCycle(recruit, gangTask("Unassigned")).hack).toBe(0);
    // 20 minutes of training (6,000 cycles) takes a recruit's hacking to 102.
    const trained = gangMemberAfter(recruit, train, 6_000);
    expect(trained.hack_exp).toBeCloseTo(6_000 * (100 / 1500) * 45 ** 0.9, 9);
    expect(trained.hack).toBe(gangSkillLevel(trained.hack_exp, 1));
    expect(trained.hack).toBe(102);
  });

  test("recruiting: 3 free, then 5^(n − 2) respect for member n + 1, up to 12", () => {
    expect([0, 1, 2].map(gangRespectToRecruit)).toEqual([0, 0, 0]);
    expect(gangRespectToRecruit(3)).toBe(5);
    expect(gangRespectToRecruit(4)).toBe(25);
    expect(gangRespectToRecruit(11)).toBe(5 ** 9);
    expect(gangRespectToRecruit(12)).toBe(Number.POSITIVE_INFINITY);
    expect(gangRecruitsAllowed(1, 0)).toBe(3);
    expect(gangRecruitsAllowed(4.9, 3)).toBe(0);
    expect(gangRecruitsAllowed(5, 3)).toBe(1);
    expect(gangRecruitsAllowed(125, 3)).toBe(3);
    expect(gangRecruitsAllowed(1e12, 3)).toBe(9);
    expect(gangRecruitsAllowed(1e12, 12)).toBe(0);
    expect(gangRecruitsAllowed(125, 7)).toBe(0);
  });
});

describe("the faction to form with", () => {
  test("none of the seven joined: none", () => {
    expect(gangFactionToForm([])).toBeNull();
    expect(gangFactionToForm(["CyberSec", "Sector-12"])).toBeNull();
  });

  test("the one joined; with several, the game's order, a combat one before a hacking one", () => {
    expect(GANG_FACTIONS.slice(0, 5).some((faction) => HACKING_GANG_FACTIONS.includes(faction))).toBe(false);
    expect(gangFactionToForm(["CyberSec", "NiteSec"])).toBe("NiteSec");
    expect(gangFactionToForm(["NiteSec", "Slum Snakes"])).toBe("Slum Snakes");
    expect(gangFactionToForm(["The Black Hand", "NiteSec"])).toBe("NiteSec");
    expect(gangFactionToForm(["Speakers for the Dead", "Tetrads"])).toBe("Tetrads");
  });

  test("a combat gang's top respect task has 14 times the territory leverage at the start's 1/7", () => {
    expect(gangTerritoryLeverage(false, 1 / 7) / gangTerritoryLeverage(true, 1 / 7)).toBeCloseTo(100 / 7, 10);
  });
});

describe("the rule", () => {
  const inputs = (members: GangMemberFigures[], gang = START, isHacking = true): GangRuleInputs => ({
    gang,
    isHacking,
    members,
    softcap: 1,
  });

  test("new recruits train: nothing earns at level 1", () => {
    const recruits = ["member-01", "member-02", "member-03"].map((name) => member(name));
    const plan = planGang(inputs(recruits));
    expect(plan.objective).toBe("respect");
    expect(plan.assignments.map((each) => [each.task, each.role])).toEqual([
      ["Train Hacking", "training"],
      ["Train Hacking", "training"],
      ["Train Hacking", "training"],
    ]);
    expect(planGang(inputs(recruits, START, false)).assignments[0]?.task).toBe("Train Combat");
  });

  test("training stops where a minute's more no longer pays back within the hour: about hacking 90", () => {
    const gang = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 };
    const trains = (hack: number) => gangTrains(inputs([], gang), member("a", { hack }), "respect");
    expect([20, 50, 80, 88].map(trains)).toEqual([true, true, true, true]);
    expect([95, 120, 300, 800].map(trains)).toEqual([false, false, false, false]);
  });

  test("the work for respect less wanted rises with the member's levels", () => {
    const gang = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 };
    const best = (hack: number) => gangBestWork(inputs([], gang), member("a", { hack }), "respect").task.name;
    expect([best(50), best(100), best(200), best(300), best(800)]).toEqual([
      "Ransomware",
      "Phishing",
      "DDoS Attacks",
      "Plant Virus",
      "Cyberterrorism",
    ]);
    // Respect less wanted: Cyberterrorism's wanted outweighs its respect at hacking 300.
    const strong = member("a", { hack: 300 });
    const cyber = gangTask("Cyberterrorism");
    expect(gangRespectPerCycle(gang, strong, cyber, 1)).toBeLessThan(gangWantedPerCycle(gang, strong, cyber));
  });

  test("with 12 members, money, from tasks whose respect covers their wanted", () => {
    const gang = { respect: 1e7, wantedLevel: 1, territory: 1 / 7 };
    const twelve = GANG_MEMBER_NAMES.map((name) => member(name, { hack: 500, cha: 100 }));
    const plan = planGang(inputs(twelve, gang));
    expect(plan.objective).toBe("money");
    expect(new Set(plan.assignments.map((each) => each.task))).toEqual(new Set(["Money Laundering"]));
    expect(plan.recruit).toEqual([]);
  });

  test("with 12 members, a task whose wanted outweighs its respect is passed over for money, however it pays", () => {
    const gang = { respect: 1e7, wantedLevel: 1, territory: 1 / 7 };
    const twelve = GANG_MEMBER_NAMES.map((name) => member(name, { hack: 300 }));
    const strong = twelve[0] as GangMemberFigures;
    const laundering = gangTask("Money Laundering");
    expect(gangRespectPerCycle(gang, strong, laundering, 1)).toBeLessThan(gangWantedPerCycle(gang, strong, laundering));
    expect(gangMoneyPerCycle(gang, strong, laundering, 1)).toBeGreaterThan(
      gangMoneyPerCycle(gang, strong, gangTask("Fraud & Counterfeiting"), 1),
    );
    expect(new Set(planGang(inputs(twelve, gang)).assignments.map((each) => each.task))).toEqual(
      new Set(["Fraud & Counterfeiting"]),
    );
  });

  test("recruits as the respect allows, the first names free", () => {
    const three = ["member-01", "member-03", "member-05"].map((name) => member(name, { hack: 100 }));
    expect(planGang(inputs(three, { ...START, respect: 4 })).recruit).toEqual([]);
    expect(planGang(inputs(three, { ...START, respect: 30 })).recruit).toEqual(["member-02", "member-04"]);
    expect(planGang(inputs([], START)).recruit).toEqual(["member-01", "member-02", "member-03"]);
  });

  test("wanted control: the weakest working members to justice while the lost share is over k/N and wanted rises", () => {
    const gang = { respect: 10, wantedLevel: 100, territory: 1 / 7 };
    expect(gangLostShare(gang)).toBeCloseTo(99 / 110, 15);
    expect(gangLostShareBound(3)).toBeCloseTo(1 / 3, 15);
    const three = [member("member-01", { hack: 300 }), member("member-02", { hack: 200 }), member("member-03")];
    const plan = planGang(inputs(three, gang));
    // member-03 trains; of the working two, the weaker goes to Ethical Hacking, which lowers wanted most for it; then
    // the wanted level falls, so member-01 keeps working.
    expect(plan.assignments.map((each) => [each.name, each.task, each.role])).toEqual([
      ["member-01", "Phishing", "working"],
      ["member-02", "Ethical Hacking", "justice"],
      ["member-03", "Train Hacking", "training"],
    ]);
    // A combat gang's justice is Vigilante Justice.
    const fighters = [member("member-01", { str: 300, def: 300, dex: 300, agi: 300, cha: 300 }), member("member-02")];
    const combat = planGang(inputs(fighters, gang, false));
    expect(combat.assignments[0]).toMatchObject({ task: "Vigilante Justice", role: "justice" });
  });

  test("wanted control stops at the k-th member whose cost, k/N, the lost share doesn't cover, wanted still rising", () => {
    // (12 − 1) / (10 + 12) = 0.5: over 1/3, under 2/3. Cyberterrorism's wanted keeps rising after one on justice.
    const gang = { respect: 10, wantedLevel: 12, territory: 1 / 7 };
    const three = ["member-01", "member-02", "member-03"].map((name) => member(name, { hack: 800 }));
    const plan = planGang(inputs(three, gang));
    expect(plan.assignments.map((each) => each.role).sort()).toEqual(["justice", "working", "working"]);
    expect(plan.assignments.filter((each) => each.role === "working").map((each) => each.task)).toEqual([
      "Cyberterrorism",
      "Cyberterrorism",
    ]);
  });

  test("the justice task that lowers a member's wanted most: Vigilante Justice for a hacking gang's fighter", () => {
    const gang = { respect: 10, wantedLevel: 100, territory: 1 / 7 };
    const fighter = member("member-01", { hack: 120, str: 600, def: 600, dex: 600, agi: 600 });
    const hacker = member("member-02", { hack: 400 });
    const plan = planGang(inputs([fighter, hacker], gang));
    expect(plan.assignments[0]).toMatchObject({ role: "justice", task: "Vigilante Justice" });
    expect(gangWantedPerCycle(gang, fighter, gangTask("Vigilante Justice"))).toBeLessThan(
      gangWantedPerCycle(gang, fighter, gangTask("Ethical Hacking")),
    );
  });

  test("no wanted control while the lost share is within the bound", () => {
    const gang = { respect: 1_000, wantedLevel: 200, territory: 1 / 7 };
    // 199 / 1,200 = 0.17, under 1/3.
    const three = ["member-01", "member-02", "member-03"].map((name) => member(name, { hack: 300 }));
    const plan = planGang(inputs(three, gang));
    expect(plan.assignments.every((each) => each.role === "working")).toBe(true);
  });
});

describe("the desired state's gang", () => {
  test("parsed: recruits and tasks; null and absent are none", () => {
    expect(parseGangState(undefined)).toEqual({ ok: true, gang: null });
    expect(parseGangState({ recruit: ["a"], tasks: { a: "Ransomware" } })).toEqual({
      ok: true,
      gang: { recruit: ["a"], tasks: { a: "Ransomware" } },
    });
    expect(parseGangState({ recruit: [], tasks: { a: "Nap" } })).toMatchObject({ ok: false });
  });
});
