// The paired comparison for #247 (#263's work item 6): the verdict's rule, the milestones' range, the favour-first
// policy, and the grid's structural variants.
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  COMPARISON_GRID,
  COMPARISON_STARTS,
  calibrationSteps,
  FAVOUR_FIRST_POLICY,
  GRID_LATER_MS,
  type ModelRun,
  type ModelStart,
  milestonesOf,
  type PolicyView,
  pairedComparison,
  runModel,
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

  test("a setting with a start of its own (#294) runs both policies from it, not from the comparison's", () => {
    const fresh = { currentNode: 1, ownedSF: {} };
    const grid = [{ name: "from SF1.2", options: { horizonMs: 10 * 60 * MINUTE_MS }, start: BN1_3.start }];
    const compared = pairedComparison(fresh, TODAYS_POLICY, FAVOUR_FIRST_POLICY, grid);
    const options = { horizonMs: 10 * 60 * MINUTE_MS };
    expect(compared.settings[0]?.first).toEqual(
      milestonesOf(runModel(BN1_3.start, { ...options, policy: TODAYS_POLICY }), 30),
    );
    expect(compared.settings[0]?.second).toEqual(
      milestonesOf(runModel(BN1_3.start, { ...options, policy: FAVOUR_FIRST_POLICY }), 30),
    );
    expect(compared.settings[0]?.first).not.toEqual(
      milestonesOf(runModel(fresh, { ...options, policy: TODAYS_POLICY }), 30),
    );
  });

  test("the grid: as fitted, the structural variants, every refit step, the batches' use, the joins, the first cloud server, the starts", () => {
    const options = COMPARISON_GRID.filter((setting) => setting.start === undefined).map((setting) => setting.options);
    expect(COMPARISON_GRID).toHaveLength(20);
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
    // The starts: a fresh BN1.1, run #3's SF1.1 and BN1.3's SF1.2.
    const starts = COMPARISON_GRID.flatMap((setting) => (setting.start === undefined ? [] : [setting.start]));
    expect(starts).toEqual(COMPARISON_STARTS.map((each) => each.start));
    expect(starts.map((start) => start.ownedSF["1"] ?? 0)).toEqual([0, 1, 2]);
  });

  test("#247's comparison on the full grid, for the record (the model isn't fit for #247): the figures pinned", () => {
    // Count first (today's brain) against favour first, minutes, the least and the most difference over the 20
    // settings, the three starts among them. From BN1.3's start: favour first unlocks the donations later at 14 of the
    // 15 paired settings (19 to 94 min), sooner at #260's gross money (−65), and 5 settings have no pair; Daedalus's
    // count likewise (−1 to 104). From a fresh BN1.1, 13 settings have no pair (the fresh runs go out of range before
    // the donations). No answer on either; Daedalus's join and the destroy are out of range everywhere. Each
    // milestone: the verdict, the least and the most difference, and the settings with no pair.
    const summary = (start: ModelStart) => {
      const { verdict, settings } = pairedComparison(start, TODAYS_POLICY, FAVOUR_FIRST_POLICY);
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
    };
    expect(summary({ currentNode: 1, ownedSF: {} })).toEqual({
      donationsUnlocked: ["no answer", -20, 94, 13],
      daedalusCount: ["no answer", 40, 104, 13],
      daedalusJoined: ["no answer", Number.NaN, Number.NaN, 20],
      destroyed: ["no answer", Number.NaN, Number.NaN, 20],
    });
    expect(summary(BN1_3.start)).toEqual({
      donationsUnlocked: ["no answer", -65, 94, 5],
      daedalusCount: ["no answer", -1, 104, 5],
      daedalusJoined: ["no answer", Number.NaN, Number.NaN, 20],
      destroyed: ["no answer", Number.NaN, Number.NaN, 20],
    });
  }, 120_000);
});
