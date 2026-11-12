// BN2's route, slice 1 (#357): (1) wait for the gang or install now, and (2) the gang's objective at 12 members, with
// golden cases from the formulas (#357's design, the designer's figures) and each candidate's edge cases.
import { describe, expect, test } from "vitest";
import { hackingExpOfLevel } from "../src/batcher.ts";
import {
  GANG_MOST_MEMBERS,
  type GangMemberFigures,
  gangMemberAscended,
  gangRespectPerCycle,
  gangTask,
  gangWantedPerCycle,
} from "../src/gang.ts";
import {
  GANG_FORMING_STEPS_MS,
  GANG_ROUTE_COMMIT_MS,
  type GangRouteFaction,
  gangFormingChoice,
  gangFormingTiming,
  gangLevelEtaMs,
  gangObjectiveChoice,
  gangObjectiveEstimate,
  gangReputationPerSecond,
  gangRespectUnder,
} from "../src/gang-route.ts";
import { type GangRuleInputs, planGang } from "../src/gang-rule.ts";
import { levellingInstallMultipliers } from "../src/levelling.ts";

const MINUTE = 60_000;
/** BN2 with SF1.3: ×1.28 (`SourceFile/applySourceFile.ts:18`) × BN2's `HackingLevelMultiplier` 0.8. */
const LEVEL_MULT = 1.28 * 0.8;
const xp = (level: number) => hackingExpOfLevel(level, LEVEL_MULT);
/** #363's seed 1's mean rate from 201 to 212: 24 min 31 s (the designer's `calc.ps1`). */
const SEED_1_RATE = (xp(212) - xp(201)) / (24 * 60 + 31);
const NO_GAIN = levellingInstallMultipliers(0);

describe("(1) before the gang: wait for the gang, or install now (#357)", () => {
  const at = (level: number, required: number, fields: Partial<Parameters<typeof gangFormingTiming>[0]> = {}) =>
    gangFormingTiming({
      exp: xp(level),
      level,
      required,
      levelMult: LEVEL_MULT,
      expPerSecond: SEED_1_RATE,
      gain: NO_GAIN,
      installable: true,
      ...fields,
    });

  test("seed 1's rate: 64.8 experience a second, from 201 to 212 in 24 min 31 s", () => {
    expect(SEED_1_RATE).toBeCloseTo(64.8, 1);
  });

  test("seed 3, 214 of 218: 46,132 short; waiting 13.0 min, installing now 105.1 min: wait", () => {
    expect(xp(218) - xp(214)).toBeCloseTo(46_132, -1);
    const timing = at(214, 218);
    expect((timing.waitMs as number) / MINUTE).toBeCloseTo(13.0, 1);
    expect((timing.installNowMs as number) / MINUTE).toBeCloseTo(105.1, 1);
    expect(timing.rebuildMs).toBeCloseTo((xp(218) / SEED_1_RATE) * 1000, -1);
    expect(timing).toMatchObject({ choice: "wait", heldForRate: false, tauScale: 1 });
  });

  test("seed 5, 216 of 217: 11,703 short; waiting 4.2 min, installing now 102.0 min: wait", () => {
    expect(xp(217) - xp(216)).toBeCloseTo(11_703, -1);
    const timing = at(216, 217);
    expect((timing.waitMs as number) / MINUTE).toBeCloseTo(4.2, 1);
    expect((timing.installNowMs as number) / MINUTE).toBeCloseTo(102.0, 1);
    expect(timing.choice).toBe("wait");
  });

  test("the level reached: the steps alone, 70 s", () => {
    expect(at(218, 218).waitMs).toBe(GANG_FORMING_STEPS_MS);
    expect(gangLevelEtaMs(xp(218), 218, LEVEL_MULT, null)).toBe(0);
  });

  test("the install's multipliers shorten R: the level's, the experience's and the speed's", () => {
    const gain = { hacking: 1.5, hackingExp: 2, hackingSpeed: 1.25 };
    const timing = at(214, 218, { gain });
    expect(timing.rebuildMs).toBeCloseTo((hackingExpOfLevel(218, LEVEL_MULT * 1.5) / (SEED_1_RATE * 2.5)) * 1000, -1);
    expect(timing.installNowMs).toBeCloseTo(GANG_ROUTE_COMMIT_MS + (timing.rebuildMs as number), 6);
  });

  test("installing now wins where the gang is far off: from 1 of 218 at a slow rate, with a big set", () => {
    // From 1, waiting is R from 1's experience; installing gives ×3 the level multiplier: far less experience.
    const timing = at(1, 218, { exp: 0, gain: { hacking: 3, hackingExp: 3, hackingSpeed: 1 } });
    expect(timing.installNowMs as number).toBeLessThan(timing.waitMs as number);
    expect(timing.choice).toBe("install");
  });

  test("the choice: install only where it's less; a tie, an unknown or a held rate waits", () => {
    expect(gangFormingChoice(10 * MINUTE, 9 * MINUTE, false)).toBe("install");
    expect(gangFormingChoice(10 * MINUTE, 10 * MINUTE, false)).toBe("wait");
    expect(gangFormingChoice(10 * MINUTE, 11 * MINUTE, false)).toBe("wait");
    expect(gangFormingChoice(null, 9 * MINUTE, false)).toBe("wait");
    expect(gangFormingChoice(10 * MINUTE, null, false)).toBe("wait");
    expect(gangFormingChoice(10 * MINUTE, 9 * MINUTE, true)).toBe("wait");
    // From 0 experience with no gain, installing is waiting's level and the commit, over the steps: waiting.
    expect(at(1, 218, { exp: 0 }).choice).toBe("wait");
  });

  test("no rate measured: installing now held, waiting with no estimate", () => {
    const timing = at(214, 218, { expPerSecond: null });
    expect(timing).toMatchObject({
      waitMs: null,
      rebuildMs: null,
      installNowMs: null,
      choice: "wait",
      heldForRate: true,
    });
  });

  test("an invitation's money held (#228): installing now held where it'd win, as #343's", () => {
    const wins = { exp: 0, gain: { hacking: 3, hackingExp: 3, hackingSpeed: 1 } };
    expect(at(1, 218, wins)).toMatchObject({ choice: "install", heldForInvitation: false });
    expect(at(1, 218, { ...wins, invitationHeld: true })).toMatchObject({ choice: "wait", heldForInvitation: true });
  });

  test("never: no experience coming, both never, a tie to waiting", () => {
    const timing = at(214, 218, { expPerSecond: 0 });
    expect(timing.waitMs).toBe(Number.POSITIVE_INFINITY);
    expect(timing.installNowMs).toBe(Number.POSITIVE_INFINITY);
    expect(timing.choice).toBe("wait");
  });

  test("nothing new to install: no install candidate, so waiting", () => {
    const timing = at(1, 218, { exp: 0, installable: false, gain: { hacking: 3, hackingExp: 3, hackingSpeed: 1 } });
    expect(timing.installNowMs).toBeNull();
    expect(timing.choice).toBe("wait");
  });

  test("an overdue wait's measured error scales τ_g, so a stalled wait gives way", () => {
    const timing = at(214, 218, { tauScale: 10 });
    expect(timing.waitMs).toBeCloseTo(10 * (at(214, 218).waitMs as number), 3);
    expect(timing.choice).toBe("install");
  });
});

/** The experience that gives `level` with no multipliers (`gangSkillLevel`'s inverse). */
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** A member at hack `hack` and cha `cha`, the others 1, no multipliers. */
function member(name: string, hack: number, cha: number, task = "Unassigned"): GangMemberFigures {
  const figures: Record<string, unknown> = { name, task, earnedRespect: 0, upgrades: [], augmentations: [] };
  for (const stat of ["hack", "str", "def", "dex", "agi", "cha"]) {
    const level = stat === "hack" ? hack : stat === "cha" ? cha : 1;
    figures[stat] = level;
    figures[`${stat}_exp`] = expFor(level);
    figures[`${stat}_mult`] = 1;
    figures[`${stat}_asc_mult`] = 1;
    figures[`${stat}_asc_points`] = 0;
  }
  return figures as unknown as GangMemberFigures;
}

const NO_PENALTY = { respect: 1e9, wantedLevel: 1, territory: 1 / 7 };
const twelve = (task = "Unassigned") =>
  Array.from({ length: GANG_MOST_MEMBERS }, (_, index) =>
    member(`member-${String(index + 1).padStart(2, "0")}`, 1_000, 250, task),
  );
const inputsOf = (members: GangMemberFigures[], gang = NO_PENALTY): GangRuleInputs => ({
  gang,
  isHacking: true,
  members,
  softcap: 1,
});
const NITESEC: GangRouteFaction = { reputation: 0, favor: 0, factionRep: 1, needed: 2.5e6, redPillOwned: false };

describe("(2) the objective at 12 members (#357)", () => {
  test("a member at hack 1,000 and cha 250, 1/7 territory, no penalty: Cyberterrorism 7.344, Money Laundering 1.098", () => {
    const one = member("member-01", 1_000, 250);
    const gang = { respect: 1e12, wantedLevel: 0, territory: 1 / 7 };
    expect(gangRespectPerCycle(gang, one, gangTask("Cyberterrorism"), 1)).toBeCloseTo(7.344, 3);
    expect(gangWantedPerCycle(gang, one, gangTask("Cyberterrorism"))).toBeCloseTo(0.426, 3);
    expect(gangRespectPerCycle(gang, one, gangTask("Money Laundering"), 1)).toBeCloseTo(1.098, 3);
    expect(gangWantedPerCycle(gang, one, gangTask("Money Laundering"))).toBeCloseTo(0.0887, 4);
    // At full territory the ratio is 9.91 (77.66 a cycle, 11.2 h to 2.5m for twelve).
    const full = { ...gang, territory: 1 };
    const cyber = gangRespectPerCycle(full, one, gangTask("Cyberterrorism"), 1);
    expect(cyber).toBeCloseTo(77.66, 1);
    expect(cyber / gangRespectPerCycle(full, one, gangTask("Money Laundering"), 1)).toBeCloseTo(9.91, 2);
    expect(2.5e6 / gangReputationPerSecond(12 * cyber, 1, 0) / 3600).toBeCloseTo(11.2, 1);
  });

  test("twelve such at favour 0: respect's 5.875 rep/s, 118.2 h to 2.5m; money's 0.879, 790 h", () => {
    const one = member("member-01", 1_000, 250);
    const gang = { respect: 1e12, wantedLevel: 0, territory: 1 / 7 };
    const respect = gangReputationPerSecond(12 * gangRespectPerCycle(gang, one, gangTask("Cyberterrorism"), 1), 1, 0);
    const money = gangReputationPerSecond(12 * gangRespectPerCycle(gang, one, gangTask("Money Laundering"), 1), 1, 0);
    expect(respect).toBeCloseTo(5.875, 3);
    expect(2.5e6 / respect / 3600).toBeCloseTo(118.2, 1);
    expect(money).toBeCloseTo(0.879, 3);
    expect(2.5e6 / money / 3600).toBeCloseTo(790, -1);
    // Favour multiplies it (`Gang.ts:152`), and `faction_rep` too.
    expect(gangReputationPerSecond(10, 1.5, 50)).toBeCloseTo(gangReputationPerSecond(10, 1, 0) * 1.5 * 1.5, 9);
  });

  test("the rate is the plan's under that objective: each member's task's respect, at the gang's penalty", () => {
    const inputs = inputsOf(twelve());
    for (const objective of ["respect", "money"] as const) {
      const plan = planGang(inputs, objective);
      expect(plan.objective).toBe(objective);
      // The plan ascends member-01 first (its experience unconverted): it, and the gang's respect less what it costs.
      const ascend = plan.ascend;
      expect(ascend?.name).toBe("member-01");
      const gang = { ...inputs.gang, respect: inputs.gang.respect - (ascend?.result.respect ?? 0) };
      const byHand = plan.assignments.reduce((sum, each, index) => {
        const one = inputs.members[index] as GangMemberFigures;
        const figures = each.name === ascend?.name ? gangMemberAscended(one) : one;
        return sum + gangRespectPerCycle(gang, figures, gangTask(each.task), 1);
      }, 0);
      expect(byHand).toBeGreaterThan(0);
      expect(gangRespectUnder(inputs, objective)).toBeCloseTo(byHand, 9);
    }
    // Respect's plan earns more of it than money's.
    expect(gangRespectUnder(inputs, "respect")).toBeGreaterThan(gangRespectUnder(inputs, "money"));
  });

  test("planGang's objective: given, it's the plan's; not given, the rule's (respect under 12, money with 12)", () => {
    const inputs = inputsOf(twelve());
    expect(planGang(inputs).objective).toBe("money");
    expect(planGang(inputs, "respect").objective).toBe("respect");
    expect(planGang(inputsOf(twelve().slice(0, 11))).objective).toBe("respect");
  });

  test("the choice: the least time to The Red Pill's reputation, respect here; each estimate's time from the faction's now", () => {
    const inputs = inputsOf(twelve());
    const choice = gangObjectiveChoice(inputs, NITESEC);
    expect(choice.reason).toBe("estimates");
    expect(choice.objective).toBe("respect");
    const respect = choice.respect as NonNullable<typeof choice.respect>;
    expect(respect.reputationPerSecond).toBeCloseTo(gangReputationPerSecond(respect.respectPerCycle, 1, 0), 9);
    expect(respect.etaMs).toBeCloseTo((2.5e6 / respect.reputationPerSecond) * 1000, 0);
    // Halfway there: half the time.
    const halfway = gangObjectiveEstimate(inputs, "respect", { ...NITESEC, reputation: 1.25e6 });
    expect(halfway.etaMs).toBeCloseTo(respect.etaMs / 2, 0);
    expect((choice.money as NonNullable<typeof choice.money>).etaMs).toBeGreaterThan(respect.etaMs);
  });

  test("edge cases: under 12 the rule's respect; The Red Pill owned or the faction unread, money; reached; never; a tie", () => {
    const inputs = inputsOf(twelve());
    expect(gangObjectiveChoice(inputsOf(twelve().slice(0, 11)), NITESEC)).toEqual({
      objective: "respect",
      reason: "recruiting",
      respect: null,
      money: null,
    });
    expect(gangObjectiveChoice(inputs, { ...NITESEC, redPillOwned: true })).toEqual({
      objective: "money",
      reason: "The Red Pill owned",
      respect: null,
      money: null,
    });
    expect(gangObjectiveChoice(inputs, null)).toMatchObject({ objective: "money", reason: "unread" });
    // Reached (not yet bought): both 0, a tie, money.
    const reached = gangObjectiveChoice(inputs, { ...NITESEC, reputation: 2.5e6 });
    expect(reached).toMatchObject({ objective: "money", respect: { etaMs: 0 }, money: { etaMs: 0 } });
    // Never: members too weak to earn respect (levels 1, every task's weight under its difficulty): both never, money.
    const weak = inputsOf(Array.from({ length: 12 }, (_, index) => member(`member-${index}`, 1, 1)));
    const never = gangObjectiveChoice(weak, NITESEC);
    expect(never).toMatchObject({
      objective: "money",
      respect: { etaMs: Number.POSITIVE_INFINITY },
      money: { etaMs: Number.POSITIVE_INFINITY },
    });
  });
});
