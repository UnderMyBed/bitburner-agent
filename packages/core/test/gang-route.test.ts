// BN2's route, slice 1 (#357): (1) wait for the gang or install now, and (2) the gang's objective at 12 members, with
// golden cases from the formulas (#357's design, the designer's figures) and each candidate's edge cases.
import { describe, expect, test } from "vitest";
import { hackingExpOfLevel } from "../src/batcher.ts";
import { favorAfterInstall } from "../src/donations.ts";
import {
  GANG_MOST_MEMBERS,
  type GangMemberFigures,
  gangMemberAscended,
  gangRespectPerCycle,
  gangSkillLevel,
  gangTask,
  gangWantedPerCycle,
} from "../src/gang.ts";
import {
  factionRepInstallMultiplier,
  GANG_FORMING_STEPS_MS,
  GANG_INSTALL_ASCENSION_KEPT,
  GANG_ROUTE_COMMIT_MS,
  type GangInstallInputs,
  type GangRouteFaction,
  gangBankReputation,
  gangFormingChoice,
  gangFormingTiming,
  gangInstallChoice,
  gangInstallRateKept,
  gangInstallTiming,
  gangLevelEtaMs,
  gangMemberAtPoints,
  gangObjectiveChoice,
  gangObjectiveEstimate,
  gangReputationPerSecond,
  gangRespectOfPlan,
  gangRespectUnder,
} from "../src/gang-route.ts";
import { type GangPlan, type GangRuleInputs, planGang } from "../src/gang-rule.ts";
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

  test("the gang's reading unread, no gang known (#368's review): installing now held where it'd win", () => {
    const wins = { exp: 0, gain: { hacking: 3, hackingExp: 3, hackingSpeed: 1 } };
    expect(at(1, 218, { ...wins, gangUnread: true })).toMatchObject({ choice: "wait", heldForGangUnread: true });
    expect(at(1, 218, wins).heldForGangUnread).toBe(false);
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

const HOUR = 60 * MINUTE;

describe("(3) installing with a gang, before The Red Pill (#357)", () => {
  const N = 2.5e6;
  /** p at 1/7 territory for members whose levels are their ascensions' (`gangInstallRateKept`): the designer's 0.979. */
  const P = 0.979;
  const at = (fields: Partial<GangInstallInputs> = {}) =>
    gangInstallTiming({
      needed: N,
      reputation: 0,
      favor: 0,
      rateKept: P,
      factionRepGain: 1,
      reputationPerSecond: 5.875,
      installable: true,
      ...fields,
    });

  test("favour (`favor.ts:12-24`): 100k gives 81.27, 238k 118.84, 2.5m 233.06 (G5's simulated 233.1)", () => {
    expect(favorAfterInstall(0, 100e3)).toBeCloseTo(81.27, 2);
    expect(favorAfterInstall(0, 238e3)).toBeCloseTo(118.84, 2);
    expect(favorAfterInstall(0, 2.5e6)).toBeCloseTo(233.06, 2);
    expect(at({ reputation: 100e3 }).favorAfter).toBeCloseTo(81.27, 2);
  });

  test("from favour 0: R* 242k (favour 119.65), at 0.562 of keeping: 66 h against 118 h at 5.875 rep/s; bank", () => {
    const timing = at();
    expect((timing.bankAt as number) / 1e3).toBeCloseTo(242.3, 0);
    expect(timing.favorAtBank as number).toBeCloseTo(119.65, 2);
    expect((timing.bank as number) / timing.keep).toBeCloseTo(0.562, 3);
    expect((timing.bankMs as number) / HOUR).toBeCloseTo(66.4, 1);
    expect((timing.keepMs as number) / HOUR).toBeCloseTo(118.2, 1);
    expect(timing.choice).toBe("bank");
    expect(timing.toBankMs as number).toBeCloseTo(((timing.bankAt as number) / 5.875) * 1000, -3);
    // R* is the least: 1% either way costs more.
    const banked = (bankAt: number) => bankAt + N / ((1 + favorAfterInstall(0, bankAt) / 100) * P);
    const R = timing.bankAt as number;
    expect(banked(R)).toBeCloseTo(timing.bank as number, 3);
    expect(banked(R)).toBeLessThan(banked(R * 0.99));
    expect(banked(R)).toBeLessThan(banked(R * 1.01));
    expect(gangBankReputation(N, 0, P)).toBeCloseTo(R, 3);
  });

  test("installing now beats keeping below r = 1.69m (from favour 0, p 0.979), not above; nor under about 2k", () => {
    const wins = (reputation: number) => {
      const timing = at({ reputation });
      return (timing.installNow as number) < timing.keep;
    };
    expect(wins(1.68e6)).toBe(true);
    expect(wins(1.7e6)).toBe(false);
    expect(wins(1e3)).toBe(false);
    expect(wins(3e3)).toBe(true);
    // Past R* (242k) installing now is the choice, up to there.
    expect(at({ reputation: 1.68e6 }).choice).toBe("install");
    expect(at({ reputation: 1.7e6 }).choice).toBe("keep");
  });

  test("from favour 50 and 100, banking's gain is ×0.76 and ×0.92 of keeping, before p", () => {
    for (const [favor, gain] of [
      [50, 0.76],
      [100, 0.92],
    ] as const) {
      const timing = at({ favor, rateKept: 1 });
      expect((timing.bank as number) / timing.keep, `favour ${favor}`).toBeCloseTo(gain, 2);
    }
  });

  test("banking waits, then installs at R*: past it, installing now is the choice, at banking's estimate of the rest", () => {
    const first = at();
    const R = first.bankAt as number;
    const there = at({ reputation: R + 1 });
    expect(there).toMatchObject({ bankAt: null, bank: null, choice: "install" });
    expect(there.installNow as number).toBeCloseTo((first.bank as number) - R, -1);
    // Banking is never more than installing now (installing now is banking at R = r).
    expect(first.bank as number).toBeLessThan(first.installNow as number);
  });

  test("the commit and the reading's age: what the gang earns meanwhile is converted too, so banking ends sooner", () => {
    // 1,150 a second (#357's A/B) over the commit's 2 minutes: 138,000 more at the install.
    const ahead = { aheadMs: 120_000, reputationPerSecond: 1_150 };
    const short = at({ reputation: 100e3, ...ahead });
    expect(short.atInstall).toBeCloseTo(238e3, 3);
    expect(short).toMatchObject({ choice: "bank" });
    expect(short.bankAt as number).toBeCloseTo(gangBankReputation(N, 0, P), 3);
    // At 150k, an install now converts 288k, past R*: installing now, its estimate the commit's 138k and N after.
    const past = at({ reputation: 150e3, ...ahead });
    expect(past).toMatchObject({ choice: "install", bankAt: null });
    expect(past.favorAfter).toBeCloseTo(favorAfterInstall(0, 288e3), 9);
    expect(past.installNow as number).toBeCloseTo(138e3 + N / ((1 + favorAfterInstall(0, 288e3) / 100) * P), 3);
    // Without it (aheadMs 0, or the rate unmeasured), r itself.
    expect(at({ reputation: 150e3 })).toMatchObject({ atInstall: 150e3, choice: "bank" });
    expect(at({ reputation: 150e3, aheadMs: 120_000, reputationPerSecond: null }).atInstall).toBe(150e3);
  });

  test("the choice doesn't depend on the rate, only the minutes do; unmeasured, no minutes; none earned, never", () => {
    const fast = at({ reputationPerSecond: 1_000 });
    const slow = at({ reputationPerSecond: 1 });
    const unread = at({ reputationPerSecond: null });
    expect(fast.choice).toBe(slow.choice);
    expect(unread.choice).toBe(slow.choice);
    expect(unread).toMatchObject({ keepMs: null, installNowMs: null, bankMs: null, toBankMs: null });
    expect((slow.keepMs as number) / (fast.keepMs as number)).toBeCloseTo(1_000, 6);
    // The rate now is at favour f: the rate at favour 0 is it over g(f).
    expect(at({ favor: 100, reputationPerSecond: 2 }).keepMs).toBeCloseTo((N / 2) * 1000, -3);
    expect(at({ reputationPerSecond: 0 }).keepMs).toBe(Number.POSITIVE_INFINITY);
  });

  test("s, the set's `faction_rep`, scales the installs: ×2 lowers R* (143k): at 150k installing now wins over banking", () => {
    const timing = at({ reputation: 150e3, factionRepGain: 2 });
    expect(timing.installNow as number).toBeCloseTo(N / ((1 + favorAfterInstall(0, 150e3) / 100) * P * 2), 3);
    expect(gangBankReputation(N, 0, P * 2) / 1e3).toBeCloseTo(142.7, 0);
    expect(timing.choice).toBe("install");
    expect(at({ reputation: 150e3 }).choice).toBe("bank");
  });

  test("edge cases: nothing to install, p unknown or 0, reached; ties", () => {
    // Nothing to install now: no install now; banking, a wait, still (at R*, installing needs something then).
    expect(at({ installable: false })).toMatchObject({ installNow: null, choice: "bank" });
    expect(at({ installable: false, reputation: 300e3 })).toMatchObject({
      installNow: null,
      bankAt: null,
      choice: "keep",
    });
    // p unknown (no respect earned now, or the gang unread): both installs held, keeping.
    expect(at({ rateKept: null })).toMatchObject({ installNow: null, bank: null, choice: "keep", heldForRate: true });
    // p 0 (nothing earned after): never an install.
    expect(at({ rateKept: 0 })).toMatchObject({ choice: "keep", bankAt: null });
    // p 0.01: R* past N (keeping reaches The Red Pill first), so no banking.
    expect(gangBankReputation(N, 0, 0.01)).toBeGreaterThan(N);
    expect(at({ rateKept: 0.01 })).toMatchObject({ choice: "keep", bankAt: null, bank: null });
    // Reached: keeping's 0, nothing else (A8's endgame installs The Red Pill first).
    expect(at({ reputation: N })).toMatchObject({ keep: 0, installNow: null, bank: null, choice: "keep" });
    // Ties: to keeping, then installing now over banking.
    expect(gangInstallChoice(10, 10, null)).toBe("keep");
    expect(gangInstallChoice(10, 9, 9)).toBe("install");
    expect(gangInstallChoice(10, 9, 8)).toBe("bank");
    expect(gangInstallChoice(10, null, 10)).toBe("keep");
    expect(gangInstallChoice(10, null, null)).toBe("keep");
  });

  test("p: members whose levels are their ascensions' keep about 0.979 at 1/7 territory; from experience alone, 1", () => {
    const gang = { respect: 1e12, wantedLevel: 0, territory: 1 / 7 };
    /** Hacking `level` from ascension points on 1,000 experience (`gangSkillLevel`, `formulas.ts:79-81`). */
    const ascended = (name: string, level: number): GangMemberFigures => {
      const ascMult = level / (32 * Math.log(1_000 + 534.5) - 200);
      return {
        ...member(name, 1, 250),
        hack_exp: 1_000,
        hack_asc_points: 2_000 * ascMult ** 2,
        hack_asc_mult: ascMult,
        hack: gangSkillLevel(1_000, ascMult),
      };
    };
    /** `inputs`' plan with every member on `task`. */
    const planOf = (inputs: GangRuleInputs, task: string): GangPlan => {
      const plan = planGang(inputs, "respect");
      return { ...plan, assignments: plan.assignments.map((each) => ({ ...each, task })) };
    };
    // Far grown (7.7 million, the A/B's member-01): √0.95 on the level, to the softcap's exponent 0.8286.
    const grown = inputsOf([ascended("member-01", 7.7e6)], gang);
    const grownKept = gangInstallRateKept(grown, planOf(grown, "Cyberterrorism")) as number;
    expect(grownKept).toBeCloseTo(0.95 ** (0.5 * (0.2 / 7 + 0.8)), 4);
    expect(grownKept).toBeCloseTo(0.979, 3);
    // At hacking 1,000 the task's difficulty and charisma's share make the loss larger: by the formula.
    const thousand = inputsOf([ascended("member-01", 1_000)], gang);
    const one = thousand.members[0] as GangMemberFigures;
    const after = gangMemberAtPoints(one, GANG_INSTALL_ASCENSION_KEPT);
    expect(after.hack).toBe(gangSkillLevel(1_000, Math.sqrt((one.hack_asc_points * 0.95) / 2_000)));
    const cyber = gangTask("Cyberterrorism");
    expect(gangInstallRateKept(thousand, planOf(thousand, "Cyberterrorism"))).toBeCloseTo(
      gangRespectPerCycle(gang, after, cyber, 1) / gangRespectPerCycle(gang, gangMemberAtPoints(one, 1), cyber, 1),
      9,
    );
    // From experience alone (no points): nothing lost.
    const plain = inputsOf([member("member-01", 1_000, 250)], gang);
    expect(gangInstallRateKept(plain, planOf(plain, "Cyberterrorism"))).toBeCloseTo(1, 9);
    // None earned now (training): null.
    expect(gangInstallRateKept(plain, planOf(plain, "Train Hacking"))).toBeNull();
  });

  test("s: NeuroFlux Governor's levels and the set's `faction_rep`, by product (`AugmentationHelpers.ts:39-50`)", () => {
    expect(factionRepInstallMultiplier(0)).toBe(1);
    expect(factionRepInstallMultiplier(2)).toBeCloseTo(1.01000262 ** 2, 12);
    expect(factionRepInstallMultiplier(1, ["ADR-V1 Pheromone Gene", "BitWire"])).toBeCloseTo(1.01000262 * 1.1, 12);
    expect(() => factionRepInstallMultiplier(0, ["no such"])).toThrow(RangeError);
  });

  test("gangRespectOfPlan is gangRespectUnder's, given the plan", () => {
    const inputs = inputsOf(twelve());
    expect(gangRespectOfPlan(inputs, planGang(inputs, "respect"))).toBe(gangRespectUnder(inputs, "respect"));
  });
});
