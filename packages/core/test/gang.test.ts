// Gangs (#325, G1 of #324; G2 #328, G3 #330): the game's facts checked against its source, the formulas worked by hand,
// and the rule.
// The formulas and the task table are checked against the engine too (packages/brain's gang-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  GANG_ASCENSION_EXP_LEFT_OUT,
  GANG_ASCENSION_POINTS_SCALE,
  GANG_CYCLE_MS,
  GANG_EQUIPMENT,
  GANG_EQUIPMENT_NAMES,
  GANG_FACTIONS,
  GANG_FREE_MEMBERS,
  GANG_MOST_MEMBERS,
  GANG_RECRUIT_RESPECT_BASE,
  GANG_TASK_NAMES,
  type GangMemberFigures,
  gangAscensionMult,
  gangAscensionOrderStands,
  gangAscensionPointsGain,
  gangAscensionPointsOf,
  gangAscensionResult,
  gangCanAscend,
  gangEquipment,
  gangEquipmentCost,
  gangEquipmentCostMultOf,
  gangEquipmentDiscount,
  gangEquipmentKept,
  gangExpPerCycle,
  gangFactionToForm,
  gangMemberAfter,
  gangMemberAscended,
  gangMemberEquipped,
  gangMemberOwns,
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
  GANG_ASCENSION_HORIZON_CAP_MS,
  GANG_ASCENSION_MOST_LEFT_OUT,
  GANG_AUGMENTATION_HORIZON_MS,
  GANG_EQUIPMENT_PAYBACK_LIMIT_MS,
  GANG_MEMBER_NAMES,
  GANG_TRAINING_STEP_MS,
  GANG_WANTED_RECOVERY_MS,
  type GangAscensionAppraisal,
  type GangAssignment,
  type GangEquipmentAppraisal,
  type GangRuleInputs,
  gangAscensionAppraisal,
  gangAscensionConvertsEnough,
  gangAscensionCost,
  gangAscensionToMake,
  gangBestWork,
  gangCycleSoFarMs,
  gangEquipmentAppraisal,
  gangLostShare,
  gangLostShareBound,
  gangOutputOver,
  gangTimeToAscensionMs,
  gangTrains,
  gangWantedAfter,
  gangWantedAtBound,
  gangWantedRecovers,
  gangWorkRespectPerCycle,
  planGang,
  planGangEquipment,
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
    earnedRespect: 0,
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
    hack_asc_points: 0,
    str_asc_points: 0,
    def_asc_points: 0,
    dex_asc_points: 0,
    agi_asc_points: 0,
    cha_asc_points: 0,
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

  test("training stops where a minute's more no longer pays back within a horizon of an hour: about hacking 90", () => {
    const gang = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 };
    const trains = (hack: number) => gangTrains(inputs([], gang), member("a", { hack }), "respect", 60 * 60_000);
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
    // One ascends (G2): never ascended, its experience is all to gain from; it trains, the rest launder money.
    expect(plan.ascend?.name).toBe("member-01");
    expect(plan.assignments[0]).toMatchObject({ name: "member-01", role: "training" });
    expect(new Set(plan.assignments.slice(1).map((each) => each.task))).toEqual(new Set(["Money Laundering"]));
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
    const plan = planGang(inputs(twelve, gang));
    expect(
      new Set(plan.assignments.filter((each) => each.name !== plan.ascend?.name).map((each) => each.task)),
    ).toEqual(new Set(["Fraud & Counterfeiting"]));
  });

  test("recruits as the respect allows, the first names free", () => {
    const three = ["member-01", "member-03", "member-05"].map((name) => member(name, { hack: 100 }));
    expect(planGang(inputs(three, { ...START, respect: 4 })).recruit).toEqual([]);
    expect(planGang(inputs(three, { ...START, respect: 30 })).recruit).toEqual(["member-02", "member-04"]);
    expect(planGang(inputs([], START)).recruit).toEqual(["member-01", "member-02", "member-03"]);
  });

  test("over the bound: to justice until the wanted level is on course to the bound in time, training members first", () => {
    // (800 − 1) / (1,000 + 800) = 44%, over 1/3; back at the bound (wanted 501.5) within the 23 min.
    const gang = { respect: 1_000, wantedLevel: 800, territory: 1 / 7 };
    expect(gangLostShare(gang)).toBeCloseTo(799 / 1_800, 15);
    expect(gangLostShareBound(3)).toBeCloseTo(1 / 3, 15);
    expect(gangWantedAtBound(gang, 3)).toBeCloseTo((1_000 / 3 + 1) / (2 / 3), 9);
    const three = [member("member-01", { hack: 300 }), member("member-02", { hack: 200 }), member("member-03")];
    const plan = planGang(inputs(three, gang));
    // member-03, training, goes first (its output is none either way); on course only with member-02, the weaker
    // working one, too, on Ethical Hacking, which lowers wanted most for each; member-01 keeps its Plant Virus.
    expect(plan.assignments.map((each) => [each.name, each.task, each.role])).toEqual([
      ["member-01", "Plant Virus", "working"],
      ["member-02", "Ethical Hacking", "justice"],
      ["member-03", "Ethical Hacking", "justice"],
    ]);
    const tasks = plan.assignments.map((each) => each.task);
    expect(gangWantedRecovers(gang, three, tasks)).toBe(true);
    expect(gangWantedRecovers(gang, three, ["Plant Virus", "Plant Virus", "Ethical Hacking"])).toBe(false);
    // The pace, the game's: W' = g − 0.0001 J W a cycle, so with no gains it decays as e^(−0.0001 J t).
    const idle = [member("a"), member("b"), member("c")];
    expect(gangWantedAfter(gang, idle, ["Ethical Hacking", "Unassigned", "Unassigned"], 6_000)).toBeCloseTo(
      800 * Math.exp(-0.0001 * 6_000),
      9,
    );
    // Far over (90%): every member to justice, the game's decay all it allows.
    const far = { respect: 10, wantedLevel: 100, territory: 1 / 7 };
    expect(planGang(inputs(three, far)).assignments.every((each) => each.role === "justice")).toBe(true);
    // A combat gang's justice is Vigilante Justice.
    const fighters = [member("member-01", { str: 300, def: 300, dex: 300, agi: 300, cha: 300 }), member("member-02")];
    const combat = planGang(inputs(fighters, far, false));
    expect(combat.assignments[0]).toMatchObject({ task: "Vigilante Justice", role: "justice" });
  });

  test("on course: back at the bound within one justice member's time to halve the wanted level, 23 min", () => {
    expect(GANG_WANTED_RECOVERY_MS / 60_000).toBeCloseTo(23.09, 2);
    // Members whose tasks add no wanted, one on justice: in the recovery time, 1,000 halves to 500 (500.2 at the rule's
    // continuous rate, 0.0001 a cycle, against the game's ln(1 − 0.001) each 10 cycles). At 3 members the
    // bound's wanted level is respect/2 + 1.5: 505 with 1,007 respect, on course; 495 with 987, not.
    const idle = ["a", "b", "c"].map((name) => member(name));
    const tasks = ["Ethical Hacking", "Unassigned", "Unassigned"];
    const gangOf = (respect: number) => ({ respect, wantedLevel: 1_000, territory: 1 / 7 });
    expect(gangWantedAfter(gangOf(1_007), idle, tasks, GANG_WANTED_RECOVERY_MS / 200)).toBeCloseTo(500, 0);
    expect(gangWantedRecovers(gangOf(1_007), idle, tasks)).toBe(true);
    expect(gangWantedRecovers(gangOf(987), idle, tasks)).toBe(false);
  });

  test("in bonus time the decay is 2.5 times slower a cycle, so more go to justice (#325's review)", () => {
    // 25 cycles a process (`Gang.ts:100-104`), the decay still once a process (`Gang.ts:161`): k = 0.00004 × J.
    const idle = ["a", "b", "c"].map((name) => member(name));
    const tasks = ["Ethical Hacking", "Unassigned", "Unassigned"];
    const gang = { respect: 1_007, wantedLevel: 1_000, territory: 1 / 7 };
    const cycles = GANG_WANTED_RECOVERY_MS / 200;
    expect(gangWantedAfter(gang, idle, tasks, cycles, true)).toBeCloseTo(1_000 * Math.exp(-0.00004 * cycles), 9);
    expect(gangWantedRecovers(gang, idle, tasks)).toBe(true);
    expect(gangWantedRecovers(gang, idle, tasks, true)).toBe(false);
    // The plan: two to justice in normal time (the test above), all three in bonus time.
    const three = [member("member-01", { hack: 300 }), member("member-02", { hack: 200 }), member("member-03")];
    const over = { respect: 1_000, wantedLevel: 800, territory: 1 / 7 };
    const roles = (bonusTime: boolean) =>
      planGang({ ...inputs(three, over), bonusTime }).assignments.map((each) => each.role);
    expect(roles(false)).toEqual(["working", "justice", "justice"]);
    expect(roles(true)).toEqual(["justice", "justice", "justice"]);
  });

  test("over the bound, the rule's own justice members stay, though fewer would be on course now: it only shortens", () => {
    const at34 = { respect: 1_000, wantedLevel: (1_000 * 0.34 + 1) / (1 - 0.34), territory: 1 / 7 };
    const onJustice = [300, 250, 200].map((hack, index) => ({
      ...member(`member-0${index + 1}`, { hack }),
      task: "Ethical Hacking",
    }));
    const placed = ["member-01", "member-02", "member-03"];
    expect(
      planGang({ ...inputs(onJustice, at34), placedOnJustice: placed }).assignments.map((each) => each.role),
    ).toEqual(["justice", "justice", "justice"]);
    // From scratch, two are enough.
    expect(planGang(inputs(onJustice, at34)).assignments.map((each) => each.role)).toEqual([
      "working",
      "justice",
      "justice",
    ]);
  });

  test("hysteresis: the rule's own justice members kept until the share is under half the bound, none flipping", () => {
    // Respect 1,000; the wanted level that makes each share, (W − 1) / (1,000 + W).
    const at = (share: number) => ({
      respect: 1_000,
      wantedLevel: (1_000 * share + 1) / (1 - share),
      territory: 1 / 7,
    });
    const levels = [300, 250, 200];
    const membersOn = (tasks: string[]) =>
      levels.map((hack, index) => ({ ...member(`member-0${index + 1}`, { hack }), task: tasks[index] as string }));
    let tasks = ["Plant Virus", "Plant Virus", "DDoS Attacks"];
    let placed: string[] = [];
    const roles: string[][] = [];
    // Up over the bound (1/3), then about it, then down through half of it (1/6).
    for (const share of [0.4, 0.34, 0.32, 0.35, 0.31, 0.2, 0.17, 0.16, 0.1]) {
      const plan = planGang({ ...inputs(membersOn(tasks), at(share)), placedOnJustice: placed });
      tasks = plan.assignments.map((each) => each.task);
      placed = plan.assignments.filter((each) => each.role === "justice").map((each) => each.name);
      // The member that ascends (G2), under the bound and off justice, recorded as such: it trains after.
      roles.push(plan.assignments.map((each) => (each.name === plan.ascend?.name ? "ascending" : each.role)));
    }
    // The justice members as in G1. The working one ascends (G2) only under the bound with the plan's recruits, 1/7
    // (respect 1,000 recruits four more of 3, #328's review): at 0.1, its levels all experience, never ascended.
    const twoOnJustice = ["working", "justice", "justice"];
    expect(roles).toEqual([
      ...Array(7).fill(twoOnJustice),
      ["working", "working", "working"],
      ["ascending", "working", "working"],
    ]);
    // Between half the bound and the bound, none goes to justice anew; and one the owner put there, not the rule, is
    // the rule's to move back to work.
    const working = membersOn(["Plant Virus", "Plant Virus", "Plant Virus"]);
    expect(planGang(inputs(working, at(0.32))).assignments.some((each) => each.role === "justice")).toBe(false);
    const owners = membersOn(["Plant Virus", "Ethical Hacking", "Plant Virus"]);
    expect(planGang(inputs(owners, at(0.32))).assignments[1]).toMatchObject({ role: "working", task: "Plant Virus" });
    expect(planGang({ ...inputs(owners, at(0.32)), placedOnJustice: ["member-02"] }).assignments[1]).toMatchObject({
      role: "justice",
      task: "Ethical Hacking",
    });
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
    // Nor an ascension (G2): 0.17 is over the bound with the four recruits respect 1,000 makes, 1/7.
    expect(plan.ascend).toBeNull();
  });
});

describe("the desired state's gang", () => {
  test("parsed: recruits and tasks; null and absent are none", () => {
    expect(parseGangState(undefined)).toEqual({ ok: true, gang: null });
    expect(parseGangState({ recruit: ["a"], tasks: { a: "Ransomware" } })).toEqual({
      ok: true,
      gang: { recruit: ["a"], ascend: [], tasks: { a: "Ransomware" }, buy: [], keepMoney: null },
    });
    expect(parseGangState({ recruit: [], tasks: { a: "Nap" } })).toMatchObject({ ok: false });
  });

  test("parsed: the purchases (G3), the game's equipment, with the money to keep; a bad one refuses the state", () => {
    const buy = [{ name: "a", equipment: "NUKE Rootkit", pointsBefore: 12.5 }];
    expect(parseGangState({ recruit: [], tasks: {}, buy, keepMoney: 1e9 })).toEqual({
      ok: true,
      gang: { recruit: [], ascend: [], tasks: {}, buy, keepMoney: 1e9 },
    });
    expect(parseGangState({ recruit: [], tasks: {}, buy, keepMoney: null })).toMatchObject({ ok: true });
    for (const bad of [
      { buy: [{ name: "a", equipment: "Spoon", pointsBefore: 0 }], keepMoney: 0 },
      { buy: [{ name: "a", equipment: "NUKE Rootkit", pointsBefore: -1 }], keepMoney: 0 },
      { buy: [{ name: "", equipment: "NUKE Rootkit", pointsBefore: 0 }], keepMoney: 0 },
      { buy: Array.from({ length: 13 }, () => buy[0]), keepMoney: 0 },
      { buy: "NUKE Rootkit", keepMoney: 0 },
      { buy, keepMoney: -1 },
      { buy, keepMoney: "lots" },
    ]) {
      expect(parseGangState({ recruit: [], tasks: {}, ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("ascension (G2)", () => {
  const TRAIN = gangTask("Train Hacking");
  /** A member trained `minutes` from level 1, never ascended, on `task`, with `earnedRespect`. */
  const trained = (name: string, minutes: number, task = "Train Hacking", earnedRespect = 0): GangMemberFigures => ({
    ...gangMemberAfter(member(name), TRAIN, (minutes * 60_000) / GANG_CYCLE_MS),
    task,
    earnedRespect,
  });
  const GANG = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 };
  const inputs = (members: GangMemberFigures[], gang = GANG): GangRuleInputs => ({
    gang,
    isHacking: true,
    members,
    softcap: 1,
  });

  test("the game's ascension formulas: points are experience over 1,000; the multiplier √(points / 2,000), at least 1", () => {
    const formulas = gameSource("Gang/formulas/formulas.ts");
    expect(formulas).toContain("return Math.max(exp - 1000, 0);");
    expect(formulas).toContain("return Math.max(Math.pow(points / 2000, 0.5), 1);");
    expect([GANG_ASCENSION_EXP_LEFT_OUT, GANG_ASCENSION_POINTS_SCALE]).toEqual([1000, 2000]);
    // The respect it takes from the gang, the member's earned respect, never below 1 (`Gang.ts:390-393`).
    expect(gameSource("Gang/Gang.ts")).toContain("this.respect = Math.max(1, this.respect - res.respect);");
    expect(gameSource("Gang/GangMember.ts")).toContain("const respectToDeduct = this.earnedRespect;");
    expect([gangAscensionPointsGain(800), gangAscensionPointsGain(9_000)]).toEqual([0, 8_000]);
    expect([gangAscensionMult(0), gangAscensionMult(1_999), gangAscensionMult(8_000)]).toEqual([1, 1, 2]);
  });

  test("the result by hand: hacking 9,000 experience gives ×2; with 8,000 points already, ×√2; none under 1,000", () => {
    const hacker = { ...member("a"), hack_exp: 9_000, cha_exp: 999, earnedRespect: 42 };
    expect(gangCanAscend(hacker)).toBe(true);
    expect(gangAscensionResult(hacker)).toEqual({ respect: 42, hack: 2, str: 1, def: 1, dex: 1, agi: 1, cha: 1 });
    const again = { ...hacker, hack_asc_points: 8_000, hack_asc_mult: 2 };
    expect(gangAscensionResult(again)?.hack).toBeCloseTo(Math.SQRT2, 12);
    expect(gangCanAscend({ ...hacker, hack_exp: 1_000 })).toBe(false);
    expect(gangAscensionResult({ ...hacker, hack_exp: 1_000 })).toBeNull();
  });

  test("the member after: experience 0, the points added, its multiplier and levels from them, no respect earned", () => {
    const hacker = { ...member("a", { hack: 100 }), hack_mult: 1.5, hack_asc_points: 2_000, earnedRespect: 42 };
    const after = gangMemberAscended(hacker);
    const points = 2_000 + hacker.hack_exp - 1_000;
    expect(after).toMatchObject({ hack_exp: 0, hack_mult: 1, hack_asc_points: points, earnedRespect: 0 });
    expect(after.hack_asc_mult).toBeCloseTo(Math.sqrt(points / 2_000), 12);
    expect(after.hack).toBe(gangSkillLevel(0, after.hack_asc_mult));
    expect(after.cha).toBe(1);
    expect(gangAscensionPointsOf(after)).toBeCloseTo(points, 9);
  });

  test("an order stands while the member's points are the brain's reading", () => {
    const order = { name: "a", pointsBefore: 12_345.678 };
    expect(gangAscensionOrderStands(order, 12_345.678)).toBe(true);
    expect(gangAscensionOrderStands(order, 12_345.678 + 1e-8)).toBe(true);
    expect(gangAscensionOrderStands(order, 13_000)).toBe(false);
    expect(gangAscensionOrderStands({ name: "a", pointsBefore: 0 }, 0)).toBe(true);
  });

  test("the cycle so far: the training stats' experience over training's pace, plus earned respect over work's", () => {
    const twenty = trained("a", 20);
    expect(gangCycleSoFarMs(inputs([twenty]), twenty)).toBeCloseTo(20 * 60_000, 3);
    const working = { ...twenty, task: "Phishing", earnedRespect: 50 };
    const respect = gangWorkRespectPerCycle(inputs([working]), working);
    expect(respect).toBeGreaterThan(0);
    expect(gangCycleSoFarMs(inputs([working]), working)).toBeCloseTo(20 * 60_000 + (50 / respect) * GANG_CYCLE_MS, 3);
  });

  test("it pays once the ascended member out-earns it over its cycle so far: not after 5 min's training, after 20", () => {
    const five = trained("a", 5);
    const appraisal5 = gangAscensionAppraisal(inputs([five]), five, "respect");
    // ×1.02: 3,075 experience, 2,075 points.
    expect(appraisal5?.result.hack).toBeCloseTo(Math.sqrt(2_075 / 2_000), 2);
    expect(appraisal5).toMatchObject({ pays: false, cost: 0 });
    expect(appraisal5?.gain).toBeLessThan(0);
    const twenty = trained("a", 20);
    const appraisal20 = gangAscensionAppraisal(inputs([twenty]), twenty, "respect");
    expect(appraisal20).toMatchObject({ name: "a", pays: true, cost: 0 });
    expect(appraisal20?.horizonMs).toBeCloseTo(20 * 60_000, 3);
    // Over the same horizon, the gain is the difference of the best outputs, training a share then working.
    const cycles = (20 * 60_000) / GANG_CYCLE_MS;
    expect(appraisal20?.gain).toBeCloseTo(
      gangOutputOver(inputs([twenty]), gangMemberAscended(twenty), "respect", cycles) -
        gangOutputOver(inputs([twenty]), twenty, "respect", cycles),
      6,
    );
    expect(gangAscensionAppraisal(inputs([member("b")]), member("b"), "respect")).toBeNull();
  });

  test("the cost: the earned respect for respect, and the penalty's toll on the others while they earn it back", () => {
    const gang = { respect: 500, wantedLevel: 50, territory: 1 / 7 };
    const alone = trained("a", 20, "Phishing", 400);
    expect(gangAscensionCost(inputs([alone], gang), alone, "respect", 6_000)).toBe(400);
    expect(gangAscensionCost(inputs([alone], gang), alone, "money", 6_000)).toBe(0);
    const other = trained("b", 20, "Phishing");
    const both = inputs([alone, other], gang);
    const after = { ...gang, respect: 100 };
    const phishing = gangTask("Phishing");
    const regrowth = gangRespectPerCycle(after, other, phishing, 1);
    // The toll lasts while the other earns the 400 back, or the horizon if that's shorter.
    const earnedBack = 400 / regrowth;
    for (const horizon of [earnedBack / 2, 1e6]) {
      expect(earnedBack).toBeLessThan(1e6);
      const tollCycles = Math.min(horizon, earnedBack);
      expect(gangAscensionCost(both, alone, "respect", horizon)).toBeCloseTo(
        400 + (gangRespectPerCycle(gang, other, phishing, 1) - regrowth) * tollCycles,
        6,
      );
      expect(gangAscensionCost(both, alone, "money", horizon)).toBeCloseTo(
        (gangMoneyPerCycle(gang, other, phishing, 1) - gangMoneyPerCycle(after, other, phishing, 1)) * tollCycles,
        3,
      );
    }
  });

  test("a member's earned respect can outweigh the gain: it doesn't ascend while it holds the gang's respect", () => {
    const twenty = trained("a", 20, "Phishing", 0);
    const appraise = (earnedRespect: number) =>
      gangAscensionAppraisal(
        inputs([{ ...twenty, earnedRespect }]),
        { ...twenty, earnedRespect },
        "respect",
        20 * 60_000,
      );
    const free = appraise(0);
    expect(free?.pays).toBe(true);
    expect(appraise((free?.gain ?? 0) * 0.9)?.pays).toBe(true);
    expect(appraise((free?.gain ?? 0) * 1.1)?.pays).toBe(false);
  });

  test("the time to the next ascension, working from now: none while it can't pay, minutes once training nears it", () => {
    // 5 min's training: ×1.02, and working adds no experience: never within a day, the cap.
    const five = trained("a", 5, "Ransomware");
    expect(gangTimeToAscensionMs(inputs([five]), five, "respect")).toBe(GANG_ASCENSION_HORIZON_CAP_MS);
    expect(gangTimeToAscensionMs(inputs([member("b")]), member("b"), "respect")).toBe(GANG_ASCENSION_HORIZON_CAP_MS);
    // Paying now: 0.
    const twenty = trained("a", 20, "Phishing");
    expect(gangTimeToAscensionMs(inputs([twenty]), twenty, "respect")).toBe(0);
    // 10 min's: it pays a few minutes' work on, its earned respect and cycle grown at work's pace, not a minute before.
    const ten = trained("a", 10, "Ransomware");
    const nextMs = gangTimeToAscensionMs(inputs([ten]), ten, "respect");
    expect(nextMs).toBeGreaterThan(0);
    expect(nextMs).toBeLessThan(10 * 60_000);
    const respect = gangWorkRespectPerCycle(inputs([ten]), ten);
    const workedFor = (ms: number) => {
      const worked = { ...ten, earnedRespect: (respect * ms) / GANG_CYCLE_MS };
      return gangAscensionAppraisal(inputs([worked]), worked, "respect", gangCycleSoFarMs(inputs([ten]), ten) + ms);
    };
    expect(workedFor(nextMs)?.pays).toBe(true);
    expect(workedFor(nextMs - GANG_TRAINING_STEP_MS)?.pays).toBe(false);
  });

  test("it converts enough: a training stat's 5,000 experience, ×√2 at the first, √(1 + 4,000 / P) after (#328's review)", () => {
    expect(GANG_ASCENSION_MOST_LEFT_OUT).toBe(0.2);
    const at = (hack_exp: number, hack_asc_points = 0) => ({ ...member("a"), hack_exp, hack_asc_points });
    expect(gangAscensionConvertsEnough(at(4_999), true)).toBe(false);
    expect(gangAscensionConvertsEnough(at(5_000), true)).toBe(true);
    expect(gangAscensionResult(at(5_000))?.hack).toBeCloseTo(Math.SQRT2, 12);
    expect(gangAscensionResult(at(5_000, 8_000))?.hack).toBeCloseTo(Math.sqrt(1 + 4_000 / 8_000), 12);
    // Only the stats the gang's training trains: charisma's for neither; strength's for a combat gang's.
    expect(gangAscensionConvertsEnough({ ...member("a"), cha_exp: 9_000 }, true)).toBe(false);
    expect(gangAscensionConvertsEnough({ ...member("a"), str_exp: 5_000 }, false)).toBe(true);
    expect(gangAscensionConvertsEnough({ ...member("a"), str_exp: 5_000 }, true)).toBe(false);
    // With money the objective and the member alone, the cost is 0: over a day, 4,999 gains, but doesn't pay.
    const appraise = (hack_exp: number) =>
      gangAscensionAppraisal(inputs([at(hack_exp)]), at(hack_exp), "money", GANG_ASCENSION_HORIZON_CAP_MS);
    expect(appraise(4_999)).toMatchObject({ convertsEnough: false, pays: false, cost: 0 });
    expect(appraise(4_999)?.gain).toBeGreaterThan(0);
    expect(appraise(5_000)).toMatchObject({ convertsEnough: true, pays: true });
  });

  test("training's horizon is the time to the next ascension: a recruit that can't ascend trains, as with a day", () => {
    const recruit = member("member-01");
    const plan = planGang(inputs([recruit]));
    expect(plan.assignments[0]).toMatchObject({ role: "training", nextAscensionMs: GANG_ASCENSION_HORIZON_CAP_MS });
    // A minute's training pays back within a day at levels it wouldn't within an hour (G1's horizon).
    const hacker = member("member-01", { hack: 100 });
    expect(gangTrains(inputs([hacker]), hacker, "respect", 60 * 60_000)).toBe(false);
    expect(gangTrains(inputs([hacker]), hacker, "respect", GANG_ASCENSION_HORIZON_CAP_MS)).toBe(true);
  });

  test("the plan: the member to ascend first, then the rest for the gang after it; it trains, its levels reset", () => {
    const members = [trained("member-01", 20, "Phishing"), trained("member-02", 30, "Phishing")];
    const plan = planGang(inputs(members));
    // The longer trained gains more: its cycle is longer and its multiplier higher.
    expect(plan.ascend).toMatchObject({ name: "member-02", pays: true });
    expect(plan.assignments.map((each) => [each.name, each.role])).toEqual([
      ["member-01", "working"],
      ["member-02", "training"],
    ]);
    expect(gangAscensionToMake(inputs(members), "respect")?.name).toBe("member-02");
    // The rest of the plan is for the gang after it: 300 respect of 1,000 lost, the share above the floor 49 / 750.
    const earned = [members[0] as GangMemberFigures, { ...(members[1] as GangMemberFigures), earnedRespect: 300 }];
    const after = planGang(inputs(earned, { respect: 1_000, wantedLevel: 50, territory: 1 / 7 }));
    expect(after.ascend).toMatchObject({ name: "member-02", result: { respect: 300 } });
    expect(after.lostShare).toBeCloseTo(49 / 750, 12);
  });

  test("none over the bound, of a member on justice, past the bound after, or leaving fewer recruits allowed", () => {
    const ready = trained("member-01", 30, "Phishing");
    expect(gangAscensionToMake(inputs([ready]), "respect")?.name).toBe("member-01");
    // The penalty's share over the bound: two members, 1/2.
    const two = [ready, trained("member-02", 5, "Ransomware")];
    expect(
      gangAscensionToMake(inputs(two, { respect: 100, wantedLevel: 200, territory: 1 / 7 }), "respect"),
    ).toBeNull();
    // On justice: skipped, the other considered.
    const onJustice = [{ ...ready, task: "Ethical Hacking" }, trained("member-02", 30, "Phishing")];
    expect(gangAscensionToMake(inputs(onJustice), "respect")?.name).toBe("member-02");
    // Its earned respect would take the share over the bound, and nothing else holds it (#328's review): 7 members,
    // so none to recruit at respect 1,000 (log5 1,000 + 3 = 7) and the bound 1/7; the share 0.1 now, after losing 500
    // respect 111.2 / 612.2 = 0.18. It pays, and recruits allowed stay 0.
    const fillers = ["member-02", "member-03", "member-04", "member-05", "member-06", "member-07"];
    const holding = [{ ...ready, earnedRespect: 500 }, ...fillers.map((name) => trained(name, 5, "Ransomware"))];
    const wanted = { respect: 1_000, wantedLevel: (100 + 1) / 0.9, territory: 1 / 7 };
    expect(gangLostShare(wanted)).toBeCloseTo(0.1, 12);
    expect(gangRecruitsAllowed(500, 7)).toBe(0);
    expect(gangAscensionAppraisal(inputs(holding, wanted), holding[0] as GangMemberFigures, "respect")?.pays).toBe(
      true,
    );
    expect(gangAscensionToMake(inputs(holding, wanted), "respect")).toBeNull();
    expect(gangAscensionToMake(inputs([ready, ...holding.slice(1)], wanted), "respect")?.name).toBe("member-01");
    // The bound with the plan's recruits (#328's review): two members and respect 1,000 recruit five, so 1/7, not 1/2.
    // The share 0.2 is under 1/2 but over 1/7: none; at 0.1, it ascends.
    const atShare = (share: number) => ({
      respect: 1_000,
      wantedLevel: (1_000 * share + 1) / (1 - share),
      territory: 1 / 7,
    });
    expect(gangRecruitsAllowed(1_000, 2)).toBe(5);
    expect(gangAscensionToMake(inputs(two, atShare(0.2)), "respect")).toBeNull();
    expect(gangAscensionToMake(inputs(two, atShare(0.1)), "respect")?.name).toBe("member-01");
    // A name the protocol can't carry (an owner's, over 64 characters) is never picked, so it holds back no other.
    const longName = { ...trained("x".repeat(65), 40, "Phishing") };
    expect(gangAscensionToMake(inputs([longName, ready]), "respect")?.name).toBe("member-01");
    expect(gangAscensionToMake(inputs([longName]), "respect")).toBeNull();
    // Respect 130 lets the gang recruit three more of 3 (at 5, 25 and 125); 10 lost leaves 120, two; 4 lost, three.
    const three = [{ ...ready, earnedRespect: 10 }, trained("member-02", 5), trained("member-03", 5)];
    const recruiting = { respect: 130, wantedLevel: 1, territory: 1 / 7 };
    expect(gangAscensionToMake(inputs(three, recruiting), "respect")).toBeNull();
    expect(
      gangAscensionToMake(inputs([{ ...ready, earnedRespect: 4 }, ...three.slice(1)], recruiting), "respect")?.name,
    ).toBe("member-01");
  });
});

describe("equipment (G3)", () => {
  /** A hacker with ascension multiplier `asc` and `exp` hacking experience, on `task`. */
  const hacker = (name: string, asc: number, exp: number, task = "Money Laundering"): GangMemberFigures => ({
    ...member(name),
    task,
    hack_asc_mult: asc,
    hack_asc_points: GANG_ASCENSION_POINTS_SCALE * asc ** 2,
    hack_exp: exp,
    hack: gangSkillLevel(exp, asc),
  });
  const GANG = { respect: 1_000, wantedLevel: 1, territory: 1 / 7 };
  const inputs = (members: GangMemberFigures[], gang = GANG): GangRuleInputs => ({
    gang,
    isHacking: true,
    members,
    softcap: 1,
  });
  const NUKE = gangEquipment("NUKE Rootkit");
  const BITWIRE = gangEquipment("BitWire");
  const MINUTE = 60_000;
  /** A plan with these members working (or in `roles`), each `nextMs` from its next ascension. */
  const planOf = (
    members: GangMemberFigures[],
    nextMs: number,
    roles: Record<string, GangAssignment["role"]> = {},
    ascend: string | null = null,
  ) => ({
    assignments: members.map((each) => ({
      name: each.name,
      task: each.task,
      role: roles[each.name] ?? ("working" as const),
      value: 0,
      bestTask: each.task,
      nextAscensionMs: nextMs,
    })),
    ascend: ascend === null ? null : ({ name: ascend } as GangAscensionAppraisal),
  });

  test("the upgrades are the game's: names, costs, types and multipliers, in order", () => {
    const source = gameSource("Gang/data/upgrades.ts");
    const blocks = [
      ...source.matchAll(/cost: ([\d.e]+),\s+mults: \{([^}]*)\},\s+name: "([^"]+)",\s+upgType: \w+\.(\w+)/g),
    ];
    expect(blocks).toHaveLength(32);
    expect(
      blocks.map(([, cost, mults, name, type]) => ({
        name,
        cost: Number(cost),
        type,
        mults: Object.fromEntries(
          (mults as string).split(",").map((pair) => {
            const [stat, value] = pair.split(":").map((part) => part.trim());
            return [stat, Number(value)];
          }),
        ),
      })),
    ).toEqual(GANG_EQUIPMENT.map((each) => ({ ...each })));
    expect(GANG_EQUIPMENT_NAMES).toEqual(blocks.map((each) => each[3]));
    // `getType()`'s names (`GangMemberUpgrade.ts:51-66`) for the source's enum.
    expect(GANG_EQUIPMENT.filter((each) => each.type === "Augmentation")).toHaveLength(11);
    expect(GANG_EQUIPMENT.filter(gangEquipmentKept).map((each) => each.name)).toEqual(
      GANG_EQUIPMENT.slice(21).map((each) => each.name),
    );
    expect(() => gangEquipment("Spoon")).toThrow(RangeError);
  });

  test("the discount from respect and power, as the game's, at least 1; the cost is the upgrade's × its inverse", () => {
    const gang = gameSource("Gang/Gang.ts");
    expect(gang).toContain("const respectLinearFac = 5e6;");
    expect(gang).toContain("const powerLinearFac = 1e6;");
    expect(gang).toContain(
      "Math.pow(respect, 0.01) + respect / respectLinearFac + Math.pow(power, 0.01) + power / powerLinearFac - 1;",
    );
    expect(gang).toContain("return Math.max(1, discount);");
    expect(gang).toContain("return upg.cost / this.getDiscount();");
    // At the start (respect and power 1): 1 + 1/5e6 + 1/1e6. Grown: 10^0.06 + 0.2 + 100^0.01 + 1e-4 − 1.
    expect(gangEquipmentDiscount({ respect: 1, power: 1 })).toBeCloseTo(1 + 1 / 5e6 + 1 / 1e6, 15);
    expect(gangEquipmentDiscount({ respect: 1e6, power: 100 })).toBeCloseTo(
      10 ** 0.06 + 0.2 + 100 ** 0.01 - 1 + 1e-4,
      12,
    );
    expect(gangEquipmentDiscount({ respect: 0, power: 0 })).toBe(1);
    expect(gangEquipmentCost(NUKE, 0.5)).toBe(2.5e6);
    // From an older Agent's reading, without `equipmentCostMult`: 1 / the discount.
    expect(gangEquipmentCostMultOf({ respect: 1e6, power: 100 })).toBeCloseTo(
      1 / gangEquipmentDiscount({ respect: 1e6, power: 100 }),
      15,
    );
    expect(gangEquipmentCostMultOf({ respect: 1e6, power: 100, equipmentCostMult: 0.7 })).toBe(0.7);
  });

  test("a member equipped: its multiplier × the upgrade's, its level from it, the upgrade listed by kind", () => {
    const before = hacker("a", 2, 10_000);
    const rooted = gangMemberEquipped(before, NUKE);
    expect(rooted).toMatchObject({ hack_mult: 1.05, upgrades: ["NUKE Rootkit"], cha_mult: 1, cha: 1 });
    expect(rooted.hack).toBe(gangSkillLevel(10_000, 1.05 * 2));
    expect(rooted.hack).toBeGreaterThan(before.hack);
    expect(gangMemberOwns(rooted, "NUKE Rootkit")).toBe(true);
    const wired = gangMemberEquipped(rooted, BITWIRE);
    expect(wired).toMatchObject({ upgrades: ["NUKE Rootkit"], augmentations: ["BitWire"] });
    expect(wired.hack_mult).toBeCloseTo(1.05 * 1.05, 15);
    expect(gangMemberOwns(wired, "BitWire")).toBe(true);
    expect(gangMemberOwns(before, "BitWire")).toBe(false);
    // Training's experience is faster with it: (mult − 1) / 4 + 1 (`GangMember.ts:141-150`).
    expect(gangExpPerCycle(wired, gangTask("Train Hacking")).hack).toBeCloseTo(
      gangExpPerCycle(before, gangTask("Train Hacking")).hack * (1 + (1.05 * 1.05 - 1) / 4),
      12,
    );
  });

  test("an ascension loses the upgrades and keeps the augmentations: G2's member after, and its appraisal, count them", () => {
    const member_ = gameSource("Gang/GangMember.ts");
    expect(member_).toContain("this.upgrades.length = 0;");
    expect(member_).toMatch(
      /for \(let i = 0; i < this\.augmentations\.length; \+\+i\) \{\s+const aug = GangMemberUpgrades/,
    );
    const base = { ...hacker("member-01", 1, 9_000, "Phishing"), earnedRespect: 0 };
    const equipped = gangMemberEquipped(
      gangMemberEquipped(gangMemberEquipped(base, NUKE), BITWIRE),
      gangEquipment("DataJack"),
    );
    const after = gangMemberAscended(equipped);
    expect(after).toMatchObject({ upgrades: [], augmentations: ["BitWire", "DataJack"], hack_exp: 0, cha_mult: 1 });
    expect(after.hack_mult).toBeCloseTo(1.05 * 1.1, 15);
    expect(after.hack).toBe(gangSkillLevel(0, 1.05 * 1.1 * after.hack_asc_mult));
    // Its level from them too: at an ascension multiplier of 100, 115 from no experience, not 100.
    const grown = gangMemberAscended(
      gangMemberEquipped(gangMemberEquipped(hacker("member-02", 100, 9_000), BITWIRE), gangEquipment("DataJack")),
    );
    expect(grown.hack).toBe(gangSkillLevel(0, 1.05 * 1.1 * grown.hack_asc_mult));
    expect([grown.hack, gangSkillLevel(0, grown.hack_asc_mult)]).toEqual([115, 100]);
    // None: G2's 1.
    expect(gangMemberAscended(base).hack_mult).toBe(1);
    // G2's appraisal: the ascended member with its augmentations out-earns it without, so the gain is larger.
    const withAugs = gangAscensionAppraisal(inputs([equipped]), equipped, "respect", 60 * MINUTE);
    const without = gangAscensionAppraisal(
      inputs([{ ...equipped, augmentations: [] }]),
      { ...equipped, augmentations: [] },
      "respect",
      60 * MINUTE,
    );
    expect(withAugs?.gain).toBeGreaterThan(without?.gain as number);
  });

  test("an upgrade pays when the member's money output gains more than its cost within the horizon", () => {
    const strong = hacker("member-01", 8, 10_000);
    // A rootkit for a strong hacker on Money Laundering: about $4,000 a second more, so $5m back within 30 minutes.
    const appraisal = gangEquipmentAppraisal(inputs([strong]), strong, NUKE, 30 * MINUTE, 1);
    expect(appraisal).toMatchObject({
      name: "member-01",
      equipment: "NUKE Rootkit",
      kept: false,
      cost: 5e6,
      pays: true,
    });
    expect(appraisal.gain).toBeGreaterThan(5e6);
    // Not within 10 minutes; nor for a weak one, whose money tasks pay little.
    expect(gangEquipmentAppraisal(inputs([strong]), strong, NUKE, 10 * MINUTE, 1).pays).toBe(false);
    const weak = hacker("member-02", 2, 10_000, "Identity Theft");
    expect(gangEquipmentAppraisal(inputs([weak]), weak, NUKE, 30 * MINUTE, 1).pays).toBe(false);
    // The discount brings it nearer: at half the cost, within 15 minutes.
    expect(gangEquipmentAppraisal(inputs([strong]), strong, NUKE, 15 * MINUTE, 1).pays).toBe(false);
    expect(gangEquipmentAppraisal(inputs([strong]), strong, NUKE, 15 * MINUTE, 0.5).pays).toBe(true);
    // The gain is in money at the gang's wanted penalty now: at a penalty of a half, half of it.
    const penalised = inputs([strong], { respect: 1_000, wantedLevel: 1_000, territory: 1 / 7 });
    expect(gangEquipmentAppraisal(penalised, strong, NUKE, 30 * MINUTE, 1).gain).toBeCloseTo(
      appraisal.gain / 2 / gangWantedPenaltyOf(GANG),
      3,
    );
    // A weapon does nothing for a hacking gang: no stat its tasks weigh.
    expect(gangEquipmentAppraisal(inputs([strong]), strong, gangEquipment("Katana"), 30 * MINUTE, 1).gain).toBe(0);
  });

  test("the plan: lost items for a working member, over G2's time to its next ascension; augmentations over a day", () => {
    const strong = [hacker("member-01", 16, 10_000), hacker("member-02", 16, 10_000)];
    const budget = { budget: 1e12, costMult: 1 };
    // Each working, 30 minutes from its next ascension: a rootkit each, the cheapest-for-its-gain.
    const working = planGangEquipment(inputs(strong), planOf(strong, 30 * MINUTE), budget);
    expect(working.buy.map(({ name, equipment, horizonMs }) => [name, equipment, horizonMs])).toEqual([
      ["member-01", "NUKE Rootkit", 30 * MINUTE],
      ["member-02", "NUKE Rootkit", 30 * MINUTE],
    ]);
    expect(working.paying).toEqual(working.buy);
    // 5 minutes off: nothing pays back so soon. Due now (0, held): none either.
    expect(planGangEquipment(inputs(strong), planOf(strong, 5 * MINUTE), budget).paying).toEqual([]);
    expect(planGangEquipment(inputs(strong), planOf(strong, 0), budget).paying).toEqual([]);
    // Training or on justice: no lost item, whatever the forecast: it earns nothing before the ascension that loses it.
    const roles = { "member-01": "training", "member-02": "justice" } as const;
    expect(planGangEquipment(inputs(strong), planOf(strong, 30 * MINUTE, roles), budget).paying).toEqual([]);
    // Under 5,000 experience its ascension doesn't convert enough, and G2's forecast leaves out the training that soon
    // brings it: no lost item, though the forecast (a day) would pay it.
    const recruit = [hacker("member-01", 16, 4_999), strong[1] as GangMemberFigures];
    expect(gangAscensionConvertsEnough(recruit[0] as GangMemberFigures, true)).toBe(false);
    const early = planGangEquipment(inputs(recruit), planOf(recruit, GANG_ASCENSION_HORIZON_CAP_MS), budget);
    expect(early.paying.map((each) => each.name)).toEqual(["member-02"]);
    // With no plan (the run report's): working unless on the training or a justice task, its forecast worked out.
    const read = [{ ...(strong[0] as GangMemberFigures), task: "Train Hacking" }, strong[1] as GangMemberFigures];
    const unplanned = planGangEquipment(inputs(read), { assignments: [], ascend: null }, budget);
    expect(unplanned.paying.map((each) => [each.name, each.horizonMs])).toEqual([
      ["member-02", gangTimeToAscensionMs(inputs(read), read[1] as GangMemberFigures, "respect")],
    ]);
    const ascending = planGangEquipment(inputs(strong), planOf(strong, 30 * MINUTE, {}, "member-01"), budget);
    expect(ascending.paying.map((each) => each.name)).toEqual(["member-02"]);
    // An item owned is skipped: the next rootkit that pays, Soulstealer's.
    const owning = [{ ...(strong[0] as GangMemberFigures), upgrades: ["NUKE Rootkit"] }];
    expect(planGangEquipment(inputs(owning), planOf(owning, 30 * MINUTE), budget).paying[0]?.equipment).not.toBe(
      "NUKE Rootkit",
    );
    // A hacker far stronger (hacking 4.8 million): an augmentation pays back within 15 minutes, kept, whatever its task,
    // training too.
    const veryStrong = [hacker("member-01", 20_000, 1e6)];
    const kept = planGangEquipment(inputs(veryStrong), planOf(veryStrong, 0, { "member-01": "training" }), budget);
    expect(kept.paying).toHaveLength(1);
    expect(kept.paying[0]).toMatchObject({ kept: true, horizonMs: GANG_AUGMENTATION_HORIZON_MS, pays: true });
    expect(GANG_AUGMENTATION_HORIZON_MS).toBe(GANG_ASCENSION_HORIZON_CAP_MS);
    // A name the protocol can't carry: none.
    const long = [hacker("x".repeat(65), 16, 10_000)];
    expect(planGangEquipment(inputs(long), planOf(long, 30 * MINUTE), budget).paying).toEqual([]);
  });

  test("only an upgrade that pays back within 15 minutes, the cloud servers' limit (#330's review): both sides", () => {
    expect(GANG_EQUIPMENT_PAYBACK_LIMIT_MS).toBe(15 * MINUTE);
    // A rootkit for a hacker ×8 pays within the 30 minutes to its next ascension, but slower than 15 minutes: none.
    const slower = [hacker("member-01", 8, 10_000)];
    const appraisal = gangEquipmentAppraisal(inputs(slower), slower[0] as GangMemberFigures, NUKE, 30 * MINUTE, 1);
    expect(appraisal.pays).toBe(true);
    expect(appraisal.paybackMs).toBeGreaterThan(GANG_EQUIPMENT_PAYBACK_LIMIT_MS);
    expect(appraisal.paybackMs).toBeCloseTo((appraisal.cost / appraisal.gain) * 30 * MINUTE, 6);
    const budget = { budget: 1e12, costMult: 1 };
    expect(planGangEquipment(inputs(slower), planOf(slower, 30 * MINUTE), budget).paying).toEqual([]);
    // ×16: within it, bought.
    const faster = [hacker("member-01", 16, 10_000)];
    const bought = planGangEquipment(inputs(faster), planOf(faster, 30 * MINUTE), budget).paying;
    expect(bought).toHaveLength(1);
    expect(bought[0]?.paybackMs).toBeLessThanOrEqual(GANG_EQUIPMENT_PAYBACK_LIMIT_MS);
    // No gain: never paid back.
    expect(
      gangEquipmentAppraisal(inputs(slower), slower[0] as GangMemberFigures, gangEquipment("Katana"), MINUTE, 1),
    ).toMatchObject({ gain: 0, paybackMs: Number.POSITIVE_INFINITY });
  });

  test("the budget: the best gain for its cost first, then what still fits; nothing with none", () => {
    const members = [hacker("member-01", 16, 10_000), hacker("member-02", 32, 10_000)];
    const plan = planOf(members, 30 * MINUTE);
    const all = planGangEquipment(inputs(members), plan, { budget: 1e12, costMult: 1 });
    expect(all.paying.map((each) => each.name)).toEqual(["member-02", "member-01"]);
    const ratios = all.paying.map((each) => each.gain / each.cost);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
    // Room for one: the best; none with no money, though both still pay.
    const first = all.paying[0] as GangEquipmentAppraisal;
    expect(planGangEquipment(inputs(members), plan, { budget: first.cost, costMult: 1 }).buy).toEqual([first]);
    expect(planGangEquipment(inputs(members), plan, { budget: 0, costMult: 1 }).buy).toEqual([]);
    expect(planGangEquipment(inputs(members), plan, { budget: 0, costMult: 1 }).paying).toEqual(all.paying);
  });
});
