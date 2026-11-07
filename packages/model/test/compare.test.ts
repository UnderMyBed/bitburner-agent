// The paired comparison for #247 (#263's work item 6, #294): the verdict's rule, the milestones' range, the
// favour-first policy, the grid's variants, and a verdict a start.
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  COMPARISON_GRID,
  COMPARISON_STARTS,
  calibrationSteps,
  comparisonByStart,
  FAVOUR_FIRST_POLICY,
  GRID_LATER_MS,
  type ModelRun,
  milestonesOf,
  type PolicyView,
  pairedComparison,
  runModel,
  startInRange,
  TODAYS_POLICY,
  verdictOf,
} from "../src/index.ts";
import { BN1_3 } from "./fixtures.ts";

const MINUTE_MS = 60_000;

describe("the verdict: a sign held at every setting, or no answer", () => {
  test("every difference below zero: the second sooner; above: the first", () => {
    expect(verdictOf([-3, -1, -2]).answer).toBe("second sooner");
    expect(verdictOf([4, 1]).answer).toBe("first sooner");
    expect(verdictOf([-3, -1, -2])).toMatchObject({ least: -3, most: -1 });
  });

  test("a sign that changes, a tie, a setting with no pair, or no setting: no answer", () => {
    expect(verdictOf([-3, 2]).answer).toBe("no answer");
    expect(verdictOf([-3, 0]).answer).toBe("no answer");
    expect(verdictOf([-3, null, -1]).answer).toBe("no answer");
    expect(verdictOf([]).answer).toBe("no answer");
  });
});

describe("the milestones, inside the curves' range", () => {
  const cycle = (endMs: number, countAfter: number) => ({ endMs, countAfter }) as ModelRun["cycles"][number];
  const run = (outOfRange: number[]): ModelRun => ({
    policy: "test",
    cycles: [cycle(10, 5), cycle(20, 30), cycle(30, 31)],
    events: [
      { atMs: 10, kind: "donationsUnlocked", faction: "BitRunners" },
      { atMs: 25, kind: "joined", faction: "Daedalus" },
    ],
    destroyedAtMs: 35,
    outOfRange,
  });

  test("each as the run has it: the first donations, the install reaching the count, Daedalus joined, the destroy", () => {
    expect(milestonesOf(run([]), 30)).toEqual({
      donationsUnlocked: 10,
      daedalusCount: 20,
      daedalusJoined: 25,
      destroyed: 35,
    });
  });

  test("none in or after a cycle out of range: the 3rd's makes Daedalus's join and the destroy no answer", () => {
    expect(milestonesOf(run([3]), 30)).toEqual({
      donationsUnlocked: 10,
      daedalusCount: 20,
      daedalusJoined: null,
      destroyed: null,
    });
    // The cycle under way at the horizon, past the last install, counts too.
    expect(milestonesOf(run([4]), 30).destroyed).toBeNull();
  });
});

describe("favour first (#247)", () => {
  const view = (joined: string[], installed: Record<string, number> = {}): PolicyView => ({
    atMs: 0,
    onlineMs: 0,
    hacking: 1,
    money: 0,
    installed,
    joined: joined.map((name) => ({ name, reputation: 0, favor: 0 })),
    multipliers: {} as PolicyView["multipliers"],
  });

  test("grinds BitRunners, the most countables, once it's joined; not before", () => {
    expect(FAVOUR_FIRST_POLICY.favourGrind?.(view(["CyberSec", "NiteSec"]))).toBeNull();
    expect(FAVOUR_FIRST_POLICY.favourGrind?.(view(["CyberSec", "BitRunners"]))).toBe("BitRunners");
    expect(FAVOUR_FIRST_POLICY.homeShares).toBe(true);
    expect(FAVOUR_FIRST_POLICY.daedalusCountHold).toBe(TODAYS_POLICY.daedalusCountHold);
  });

  test("in a run, BitRunners' work goes to its donations' target from its join", () => {
    const run = runModel(BN1_3.start, { policy: FAVOUR_FIRST_POLICY, horizonMs: 6 * 60 * MINUTE_MS });
    const grinding = run.cycles.filter((cycle) => cycle.donationTargetMinutes > 0);
    expect(grinding.length).toBeGreaterThan(0);
    for (const cycle of grinding) expect(cycle.donationTargetMinutes).toBe(cycle.workMinutes.BitRunners);
  });
});

describe("the paired comparison", () => {
  test("a policy against itself: every difference 0, so no answer", () => {
    const grid = [{ name: "as fitted", options: { horizonMs: 10 * 60 * MINUTE_MS } }];
    const same = pairedComparison(BN1_3.start, TODAYS_POLICY, { ...TODAYS_POLICY, name: "again" }, grid);
    expect(same.settings[0]?.first.donationsUnlocked).not.toBeNull();
    expect(same.settings[0]?.difference.donationsUnlocked).toBe(0);
    expect(same.verdict.donationsUnlocked.answer).toBe("no answer");
    // Never reached within the horizon: no pair.
    expect(same.settings[0]?.first.destroyed).toBeNull();
    expect(same.verdict.destroyed).toMatchObject({ answer: "no answer" });
  });

  test("each setting's pair is both policies run at that setting; its difference the second's time less the first's", () => {
    const grid = [
      { name: "as fitted", options: { horizonMs: 10 * 60 * MINUTE_MS } },
      { name: "gross", options: { horizonMs: 10 * 60 * MINUTE_MS, money: "gross" as const } },
    ];
    const compared = pairedComparison(BN1_3.start, TODAYS_POLICY, FAVOUR_FIRST_POLICY, grid);
    for (const [index, { first, second, difference }] of compared.settings.entries()) {
      const options = grid[index]?.options;
      expect(first).toEqual(milestonesOf(runModel(BN1_3.start, { ...options, policy: TODAYS_POLICY }), 30));
      expect(second).toEqual(milestonesOf(runModel(BN1_3.start, { ...options, policy: FAVOUR_FIRST_POLICY }), 30));
      const [a, b] = [first.donationsUnlocked, second.donationsUnlocked];
      expect(difference.donationsUnlocked).toBe(a === null || b === null ? null : b - a);
    }
    // The settings differ, so a pair run without its setting would be seen: the gross's first unlocks at another time.
    expect(compared.settings[0]?.first.donationsUnlocked).not.toBeNull();
    expect(compared.settings[1]?.first.donationsUnlocked).not.toBe(compared.settings[0]?.first.donationsUnlocked);
  });

  test("each start its own verdict over the whole grid; a start under 32 GB of home, out of the measured range, none", () => {
    const grid = [{ name: "as fitted", options: { horizonMs: 10 * 60 * MINUTE_MS } }];
    const byStart = comparisonByStart(TODAYS_POLICY, FAVOUR_FIRST_POLICY, COMPARISON_STARTS, grid);
    expect(byStart.map(({ start }) => start)).toEqual(COMPARISON_STARTS.map((each) => each.start));
    for (const { start, comparison } of byStart) {
      expect(comparison.settings[0]?.first).toEqual(
        milestonesOf(runModel(start, { horizonMs: 10 * 60 * MINUTE_MS, policy: TODAYS_POLICY }), 30),
      );
      expect(comparison.startInRange).toBe(startInRange(start));
    }
    // Home's RAM at the start: 8 GB with no Source-File (out), 32 GB with SF1 (in).
    expect(COMPARISON_STARTS.map(({ start }) => startInRange(start))).toEqual([false, true, true]);
    // Out of range, a difference of one sign at every setting is still no answer: favour first unlocks the donations
    // 30 min sooner from a fresh BN1.1 as fitted.
    const fresh = pairedComparison(COMPARISON_STARTS[0]?.start as never, TODAYS_POLICY, FAVOUR_FIRST_POLICY, [
      { name: "as fitted", options: {} },
    ]);
    expect(verdictOf(fresh.settings.map((each) => each.difference.donationsUnlocked)).answer).toBe("second sooner");
    expect(fresh.verdict.donationsUnlocked.answer).toBe("no answer");
  });

  test("the grid: as fitted, the structural variants, every refit step, the batches' use, the joins, the first cloud server", () => {
    const options = COMPARISON_GRID.map((setting) => setting.options);
    expect(COMPARISON_GRID).toHaveLength(17);
    expect(options).toContainEqual({});
    expect(options).toContainEqual({ money: "gross" });
    expect(options).toContainEqual({ share: "index" });
    for (const { name, calibration } of calibrationSteps(CALIBRATION)) {
      expect(options, name).toContainEqual({ calibration });
    }
    expect(options).toContainEqual({ calibration: { batchesUseFactor: 0.5 } });
    // #294: the joins at once (slice 2's) and 5 min later than modelled; the first cloud server 5 min later.
    expect(options).toContainEqual({ joinDelay: "instant" });
    expect(options).toContainEqual({ joinDelay: GRID_LATER_MS });
    expect(options).toContainEqual({ cloudDelayMs: GRID_LATER_MS });
    expect(GRID_LATER_MS).toBe(5 * MINUTE_MS);
    // The starts are crossed with the grid, not in it: a fresh BN1.1, run #3's SF1.1 and BN1.3's SF1.2.
    expect(COMPARISON_STARTS.map(({ start }) => start.ownedSF["1"] ?? 0)).toEqual([0, 1, 2]);
  });

  test("#247's comparison, each start over the 17 settings, for the record (the model isn't fit for #247): pinned", () => {
    // Count first (today's brain) against favour first, minutes, the least and the most difference, and the settings
    // with no pair. From SF1.1: count first reaches Daedalus's count sooner at every setting (2 to 97 min), the one
    // answer; the donations no answer (#260's gross money flips it, −45). From SF1.2: 14 of the 17 settings have no
    // pair (favour first's runs go out of range first), so no answer. From a fresh BN1.1 (8 GB, out of the measured
    // range): favour first would unlock the donations sooner at all 16 paired settings (18 to 48 min), but the start
    // gives no answer. Daedalus's join and the destroy are out of range everywhere.
    const summaries = comparisonByStart(TODAYS_POLICY, FAVOUR_FIRST_POLICY).map(({ comparison }) => {
      const { verdict, settings } = comparison;
      const unpaired = (milestone: keyof typeof verdict) =>
        settings.filter((setting) => setting.difference[milestone] === null).length;
      return Object.fromEntries(
        Object.entries(verdict).map(([milestone, { answer, least, most }]) => [
          milestone,
          [
            answer,
            Math.round(least / MINUTE_MS),
            Math.round(most / MINUTE_MS),
            unpaired(milestone as keyof typeof verdict),
          ],
        ]),
      );
    });
    const outOfRange = ["no answer", Number.NaN, Number.NaN, 17];
    expect(summaries).toEqual([
      {
        donationsUnlocked: ["no answer", -48, -18, 1],
        daedalusCount: ["no answer", 7, 46, 1],
        daedalusJoined: outOfRange,
        destroyed: outOfRange,
      },
      {
        donationsUnlocked: ["no answer", -45, 69, 0],
        daedalusCount: ["first sooner", 2, 97, 0],
        daedalusJoined: outOfRange,
        destroyed: outOfRange,
      },
      {
        donationsUnlocked: ["no answer", -54, 48, 14],
        daedalusCount: ["no answer", 18, 78, 14],
        daedalusJoined: outOfRange,
        destroyed: outOfRange,
      },
    ]);
  }, 120_000);
});
