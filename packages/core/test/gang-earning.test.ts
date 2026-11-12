// The gang rule's time until its plan earns respect (#374): golden cases from the formulas, recomputed by hand, and the
// estimate against the rule itself played forward a minute at a time.
import { describe, expect, test } from "vitest";
import {
  GANG_CYCLE_MS,
  type GangMemberFigures,
  gangAscensionMult,
  gangExpPerCycle,
  gangFreshRecruit,
  gangMemberAfter,
  gangMemberAscended,
  gangSkillLevel,
  gangSoftcapOf,
  gangTask,
  gangWantedPerCycle,
} from "../src/gang.ts";
import {
  GANG_EARNING_MARGIN_MS,
  gangEarningBoundMs,
  gangJusticeReleaseMs,
  gangTimeToEarningMs,
  gangTrainingTimeMs,
  gangWarfareExitMs,
} from "../src/gang-earning.ts";
import {
  GANG_ASCENSION_HORIZON_CAP_MS,
  GANG_WARFARE_HORIZON_MS,
  type GangAssignment,
  type GangPlan,
  type GangRole,
  type GangRuleInputs,
  gangTimeToAscensionMs,
  gangTrains,
  planGang,
} from "../src/gang-rule.ts";

const MINUTE = 60_000;
const SOFTCAP = gangSoftcapOf(2);
const START = { respect: 1, wantedLevel: 1, territory: 1 / 7 };
const named = (index: number) => `member-${String(index + 1).padStart(2, "0")}`;
/** The experience that gives `level` with no multipliers: the inverse of `gangSkillLevel`. */
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** `count` fresh recruits training, as the rule sets them (`GangMember.ts:31-66`). */
const fresh = (count: number): GangMemberFigures[] =>
  Array.from({ length: count }, (_, index) => ({ ...gangFreshRecruit(named(index)), task: "Train Hacking" }));

/** A member at hacking `hack` (its experience to match), the rest fresh, on `task`. */
const atHacking = (name: string, hack: number, task: string): GangMemberFigures => ({
  ...gangFreshRecruit(name),
  task,
  hack,
  hack_exp: expFor(hack),
});

/** The G3 suite's grown gang: three ascended four times after 20 minutes' training each (×9.4, `formulas.ts:75-81`). */
const grown = (count: number): GangMemberFigures[] => {
  let points = 0;
  for (let round = 0; round < 4; round += 1) {
    const exp =
      20 *
      300 *
      gangExpPerCycle({ ...gangFreshRecruit("x"), hack_asc_mult: gangAscensionMult(points) }, gangTask("Train Hacking"))
        .hack;
    points += exp - 1000;
  }
  const mult = gangAscensionMult(points);
  return fresh(count).map((each) => ({
    ...each,
    hack_asc_points: points,
    hack_asc_mult: mult,
    hack: gangSkillLevel(0, mult),
  }));
};

const inputsOf = (members: GangMemberFigures[], gang = START): GangRuleInputs => ({
  gang,
  isHacking: true,
  members,
  softcap: SOFTCAP,
});

/**
 * The rule played forward a minute at a time while its plan earns nothing (no respect, so the gang's figures hold):
 * each plan's ascension made, its members trained a minute; the minute its plan first has a member working.
 */
function playedMinutes(given: GangRuleInputs): number {
  let inputs = given;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const plan = planGang(inputs);
    if (plan.assignments.some((each) => each.role === "working")) return minute;
    let respect = inputs.gang.respect;
    const members = inputs.members.map((member) => {
      const ascended = member.name === plan.ascend?.name;
      if (ascended) respect = Math.max(1, respect - member.earnedRespect);
      const figures = ascended ? { ...gangMemberAscended(member), task: member.task } : member;
      const task = gangTask(plan.assignments.find((each) => each.name === member.name)?.task ?? member.task);
      return { ...gangMemberAfter(figures, task, MINUTE / GANG_CYCLE_MS), task: task.name };
    });
    inputs = { ...inputs, gang: { ...inputs.gang, respect }, members };
  }
  return Number.POSITIVE_INFINITY;
}

/** A plan by hand: each member's role and task, the bound 1/N. */
function planOf(roles: [string, GangRole, string][], recruit: string[] = []): GangPlan {
  const assignments: GangAssignment[] = roles.map(([name, role, task]) => ({
    name,
    task,
    role,
    value: 0,
    bestTask: task,
    nextAscensionMs: GANG_ASCENSION_HORIZON_CAP_MS,
  }));
  return {
    objective: "respect",
    assignments,
    recruit,
    lostShare: 0,
    bound: 1 / roles.length,
    ascend: null,
    warfare: null,
  };
}

describe("the bound (#374): twice the estimate and 10 minutes, as #343's waits", () => {
  test("2E + 10 min", () => {
    expect(GANG_EARNING_MARGIN_MS).toBe(10 * MINUTE);
    expect(gangEarningBoundMs(0)).toBe(10 * MINUTE);
    expect(gangEarningBoundMs(9 * MINUTE)).toBe(28 * MINUTE);
    expect(gangEarningBoundMs(44 * MINUTE)).toBe(98 * MINUTE);
  });
});

describe("training: the rule's own threshold, from the game's experience a cycle (#374)", () => {
  test("a fresh hacker: 615 experience a minute, the day's horizon until 5,000, so it trains 9 minutes", () => {
    // Train Hacking: hackWeight 100 / 1500 × difficulty 45^0.9 (`GangMember.ts:168-176`) = 2.0502 a cycle, 615.07 a
    // minute. Under 5,000 experience its ascension can't convert enough (`GANG_ASCENSION_MOST_LEFT_OUT`), so its next
    // ascension's horizon is the day (`gangTimeToAscensionMs`), and it trains while a minute's training gains more than
    // 1/1,439 of its work: 5,000 at 8.13 minutes, then its ascension's horizon falls, and at 9 minutes it works.
    const recruit = fresh(1)[0] as GangMemberFigures;
    const perCycle = gangExpPerCycle(recruit, gangTask("Train Hacking")).hack;
    expect(perCycle).toBeCloseTo(2.0502178, 6);
    expect((5000 / (perCycle * 300)) * MINUTE).toBeCloseTo(8.1292 * MINUTE, -2);
    const inputs = inputsOf([recruit]);
    const trained = (minutes: number) => gangMemberAfter(recruit, gangTask("Train Hacking"), minutes * 300);
    const trains = (minutes: number) =>
      gangTrains(inputs, trained(minutes), "respect", gangTimeToAscensionMs(inputs, trained(minutes), "respect"));
    expect(gangTimeToAscensionMs(inputs, trained(8), "respect")).toBe(GANG_ASCENSION_HORIZON_CAP_MS);
    expect(trains(8)).toBe(true);
    expect(trains(9)).toBe(false);
    expect(gangTrainingTimeMs(inputs, recruit, "respect")).toEqual({
      ms: 9 * MINUTE,
      ascensions: 0,
      capped: false,
      firstAscensionMs: null,
    });
  });

  test("a member the rule would have work now: 0", () => {
    // The fresh hacker trained its 9 minutes: it works.
    const worker = {
      ...gangMemberAfter(fresh(1)[0] as GangMemberFigures, gangTask("Train Hacking"), 9 * 300),
      task: "Train Hacking",
    };
    const inputs = inputsOf([worker]);
    expect(planGang(inputs).assignments[0]?.role).toBe("working");
    expect(gangTrainingTimeMs(inputs, worker, "respect").ms).toBe(0);
  });

  test("an ascension on the way: made, and the training goes on from the ascended member (the lone G3 member)", () => {
    const [member] = grown(1) as [GangMemberFigures];
    const time = gangTrainingTimeMs(inputsOf([member]), member, "respect");
    // Four ascensions in about 7.6 h; the rule, a minute at a time and its recruits left out, works at 453 minutes:
    // the search to within a minute of each ascension rounds each up, so 4 at most over it.
    expect(time.ascensions).toBe(4);
    expect(time.firstAscensionMs).toBe(44 * MINUTE);
    const played = 453 * MINUTE;
    expect(time.ms).toBeGreaterThanOrEqual(played);
    expect(time.ms).toBeLessThanOrEqual(played + 4 * MINUTE);
  });
});

describe("training: an ascension the rule may not make", () => {
  test("its ascension paying but not allowed (the penalty's share past the bound after it): the rule has it work then", () => {
    // The lone grown member, its earned respect 99 of the gang's 100 at wanted 20: after an ascension the share above
    // the floor would be 19/21, past the bound with its two free recruits (1/3), so `gangAscensionAllowed` refuses it,
    // and with its ascension's horizon 0 the rule has it work (`gangTrains`), not ascend.
    const [grownMember] = grown(1) as [GangMemberFigures];
    const member = { ...grownMember, earnedRespect: 99 };
    const inputs = inputsOf([member], { respect: 100, wantedLevel: 20, territory: 1 / 7 });
    const time = gangTrainingTimeMs(inputs, member, "respect");
    expect(time.ascensions).toBe(0);
    expect(time.firstAscensionMs).toBeNull();
    const played = playedMinutes(inputs) * MINUTE;
    expect(time.ms).toBeGreaterThanOrEqual(played);
    expect(time.ms).toBeLessThanOrEqual(played + MINUTE);
  });
});

describe("the plan: the least of its members', or two ascensions at once (#374)", () => {
  test("against the rule played forward: three fresh (9 min), twelve at respect 2m (9), the G3 grown three (44)", () => {
    for (const [inputs, minutes] of [
      [inputsOf(fresh(3)), 9],
      [inputsOf(fresh(12), { ...START, respect: 2e6 }), 9],
      [inputsOf(grown(3)), 44],
    ] as const) {
      expect(playedMinutes(inputs)).toBe(minutes);
      const estimate = gangTimeToEarningMs(inputs, planGang(inputs));
      expect(estimate.ms).toBe(minutes * MINUTE);
      expect(estimate.boundMs).toBe(gangEarningBoundMs(minutes * MINUTE));
    }
  });

  test("twelve at respect 2m: each ascends at 9 min and trains 9 more alone, but one ascends a plan, so the rest work at 9", () => {
    const inputs = inputsOf(fresh(12), { ...START, respect: 2e6 });
    const estimate = gangTimeToEarningMs(inputs, planGang(inputs));
    for (const each of estimate.members) {
      expect(each).toMatchObject({ role: "training", ms: 18 * MINUTE, ascensions: 1, firstAscensionMs: 9 * MINUTE });
    }
    expect(estimate).toMatchObject({ ms: 9 * MINUTE, first: "member-02" });
  });

  test("the recruits the plan makes are counted: fresh, set to train at once", () => {
    // One grown member alone at respect 1: the plan recruits two more (three are free, `Constants.ts:5`), each 9 min.
    const inputs = inputsOf(grown(1));
    const plan = planGang(inputs);
    expect(plan.recruit).toEqual(["member-02", "member-03"]);
    const estimate = gangTimeToEarningMs(inputs, plan);
    expect(estimate.members.map((each) => [each.name, each.ms / MINUTE])).toEqual([
      ["member-01", expect.any(Number)],
      ["member-02", 9],
      ["member-03", 9],
    ]);
    expect(estimate.ms).toBe(9 * MINUTE);
    expect(gangTimeToEarningMs(inputs, { ...plan, recruit: [] }).ms).toBeGreaterThan(7 * 60 * MINUTE);
  });

  test("Territory Warfare: G4's exit, the territory left at the clashes' gain an update × 20 s, at most a day", () => {
    const members = [atHacking("member-01", 300, "Territory Warfare")];
    const inputs = inputsOf(members);
    const crew = (territoryPerUpdate: number): GangPlan => ({
      ...planOf([["member-01", "territory", "Territory Warfare"]]),
      warfare: { crew: ["member-01"], engage: true, measure: { territoryPerUpdate } as never, deaths: 0 },
    });
    // From 1/7, 0.001 an update: (6/7) / 0.001 = 857.14 updates × 20 s = 17,142,857 ms, 4 h 45 min 43 s.
    expect(gangWarfareExitMs(inputs, crew(0.001))).toBeCloseTo(17_142_857.14, 1);
    const estimate = gangTimeToEarningMs(inputs, crew(0.001));
    expect(estimate.members[0]).toMatchObject({ role: "territory" });
    expect(estimate.ms).toBeCloseTo(17_142_857.14, 1);
    // Both sides of the day's cap: 0.0001 an update is 47.6 h, the day; at 1/7, a gain of 857.14 / 4,320 updates, the
    // day exactly, 0.000198413; and none gained (losing, or no measure): the day.
    expect(gangWarfareExitMs(inputs, crew(0.0001))).toBe(GANG_WARFARE_HORIZON_MS);
    expect(gangWarfareExitMs(inputs, crew(0.0002))).toBeLessThan(GANG_WARFARE_HORIZON_MS);
    expect(gangWarfareExitMs(inputs, crew(0.00019))).toBe(GANG_WARFARE_HORIZON_MS);
    expect(gangWarfareExitMs(inputs, crew(-0.0003))).toBe(GANG_WARFARE_HORIZON_MS);
    expect(gangWarfareExitMs(inputs, { warfare: null })).toBe(GANG_WARFARE_HORIZON_MS);
    // At all the territory: none left, 0.
    expect(gangWarfareExitMs(inputsOf(members, { ...START, territory: 1 }), crew(0.001))).toBe(0);
  });

  test("a member working: 0; Territory Warfare with no measure (none gained): a day; nobody: Infinity", () => {
    const members = [atHacking("member-01", 300, "Train Hacking"), ...fresh(2).slice(1)];
    const inputs = inputsOf(members);
    const roles: [string, GangRole, string][] = [
      ["member-01", "territory", "Territory Warfare"],
      ["member-02", "training", "Train Hacking"],
    ];
    const warfare = gangTimeToEarningMs(inputs, planOf(roles));
    expect(warfare.members[0]).toEqual({ name: "member-01", role: "territory", ms: GANG_WARFARE_HORIZON_MS });
    expect(warfare.ms).toBe(9 * MINUTE);
    const crewOnly = gangTimeToEarningMs(inputs, planOf([roles[0] as [string, GangRole, string]]));
    expect(crewOnly.ms).toBe(24 * 60 * MINUTE);
    expect(crewOnly.boundMs).toBe(48 * 60 * MINUTE + 10 * MINUTE);
    const working = gangTimeToEarningMs(
      inputs,
      planOf([["member-01", "working", "Cyberterrorism"], roles[1] as [string, GangRole, string]]),
    );
    expect(working).toMatchObject({ ms: 0, first: "member-01" });
    expect(gangTimeToEarningMs(inputsOf([]), planOf([])).ms).toBe(Number.POSITIVE_INFINITY);
  });

  test("the plan's ascension applied first, as `planGang` does: the member ascended, the respect less", () => {
    const [member] = grown(1) as [GangMemberFigures];
    const ready = { ...gangMemberAfter(member, gangTask("Train Hacking"), 44 * 300), task: "Train Hacking" };
    const inputs = inputsOf([ready]);
    const plan = planGang(inputs);
    expect(plan.ascend?.name).toBe("member-01");
    const mine = gangTimeToEarningMs(inputs, { ...plan, recruit: [] }).members[0];
    // Ascended now: its training from its ascended self, the ascension already made.
    const ascended = { ...gangMemberAscended(ready), task: "Train Hacking" };
    const own = gangTrainingTimeMs(inputsOf([ascended]), ascended, "respect");
    expect(mine?.ms).toBe(own.ms);
    // Not ascended again at 0 (the plan's own ascension counted twice), which would read as two at once with another.
    expect(mine).toMatchObject({ ascensions: own.ascensions, firstAscensionMs: own.firstAscensionMs });
    expect(mine?.firstAscensionMs).not.toBe(0);
  });
});

describe("justice: the wanted level to the rule's release, by the game's process (#374)", () => {
  // Four on Ethical Hacking at hacking 100, charisma 1: each 0.4 × −0.001 × (0.9 × 100 + 0.1 − 3.5) × territory 1/7 =
  // −0.0049486 a cycle (`formulas.ts:33-54`), −0.0197943 the four. Respect 1,000: the bound 1/4, released at 1/8 of the
  // share, W_r = (1000/8 + 1) / (7/8) = 144. Each process (10 cycles, 2 s) W ← (W + 10g)(1 − 0.004) (`Gang.ts:157-167`),
  // settling at W* = 10g × 0.996 / 0.004 = −49.288; from 500, n = ln(549.288 / 193.288) / −ln(0.996) = 260.59: 261
  // processes, 522 s. With no gain (hacking 1: the weight under 3.5 × difficulty), ln(500 / 144) / 0.0040080 = 310.58:
  // 311 processes, 622 s.
  const justice = (hack: number) =>
    Array.from({ length: 4 }, (_, index) => atHacking(named(index), hack, "Ethical Hacking"));
  const roles = (count: number): [string, GangRole, string][] =>
    Array.from({ length: count }, (_, index) => [named(index), "justice", "Ethical Hacking"]);
  const gang = (wantedLevel: number) => ({ respect: 1000, wantedLevel, territory: 1 / 7 });

  test("golden: 522 s from 500 at hacking 100, 622 s with no gain", () => {
    expect(gangWantedPerCycle(START, justice(100)[0] as GangMemberFigures, gangTask("Ethical Hacking"))).toBeCloseTo(
      -0.0049486,
      7,
    );
    expect(gangJusticeReleaseMs(inputsOf(justice(100), gang(500)), planOf(roles(4)))).toBe(522_000);
    expect(gangJusticeReleaseMs(inputsOf(justice(1), gang(500)), planOf(roles(4)))).toBe(622_000);
  });

  test("the closed form is the game's process, step by step: the same count of processes from anywhere", () => {
    for (const hack of [1, 100, 300]) {
      const members = justice(hack);
      const g = members.reduce((sum, each) => sum + gangWantedPerCycle(START, each, gangTask("Ethical Hacking")), 0);
      for (const from of [144.01, 150, 500, 2_000, 1e5]) {
        // `Gang.ts:157-167`, a process at a time: W ← (W + 10g)(1 − 0.001 × 4), never under 1.
        let wanted = from;
        let processes = 0;
        while (wanted > 144) {
          wanted = Math.max(1, (wanted + 10 * g) * (1 - 0.004));
          processes += 1;
        }
        expect(gangJusticeReleaseMs(inputsOf(members, gang(from)), planOf(roles(4))), `${hack} from ${from}`).toBe(
          processes * 2_000,
        );
      }
    }
  });

  test("both sides of the release: at 144 none, just over it one process", () => {
    expect(gangJusticeReleaseMs(inputsOf(justice(1), gang(144)), planOf(roles(4)))).toBe(0);
    expect(gangJusticeReleaseMs(inputsOf(justice(1), gang(144.5)), planOf(roles(4)))).toBe(2_000);
  });

  test("never at the plan's tasks: none on justice, or the gains settling above the release; a day in the plan", () => {
    const training = planOf(roles(4).map(([name]) => [name, "training", "Train Hacking"]));
    expect(gangJusticeReleaseMs(inputsOf(justice(1), gang(500)), training)).toBe(Number.POSITIVE_INFINITY);
    // One on justice at hacking 1 (no gain), three on Cyberterrorism at hacking 400 adding wanted: settles far above.
    const members = [
      atHacking("member-01", 1, "Ethical Hacking"),
      ...[1, 2, 3].map((index) => atHacking(named(index), 400, "Cyberterrorism")),
    ];
    const mixed = planOf([
      ["member-01", "justice", "Ethical Hacking"],
      ...[1, 2, 3].map((index): [string, GangRole, string] => [named(index), "working", "Cyberterrorism"]),
    ]);
    expect(gangJusticeReleaseMs(inputsOf(members, gang(500)), mixed)).toBe(Number.POSITIVE_INFINITY);
    // Its member then a day at most (its plan earns, the others working): so a bound always holds.
    expect(gangTimeToEarningMs(inputsOf(members, gang(500)), mixed).members[0]).toMatchObject({
      role: "justice",
      releaseMs: Number.POSITIVE_INFINITY,
      ms: GANG_ASCENSION_HORIZON_CAP_MS,
      capped: true,
    });
  });

  test("a justice member: its release, then its training as the rule would have it", () => {
    const inputs = inputsOf(justice(1), gang(500));
    const estimate = gangTimeToEarningMs(inputs, planOf(roles(4)));
    const training = gangTrainingTimeMs(inputs, justice(1)[0] as GangMemberFigures, "respect").ms;
    expect(training).toBe(9 * MINUTE);
    expect(estimate.members[0]).toMatchObject({ role: "justice", releaseMs: 622_000, ms: 622_000 + training });
    expect(estimate.ms).toBe(622_000 + 9 * MINUTE);
  });
});
