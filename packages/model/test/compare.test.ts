// The paired comparison for #247 (#263's work item 6): the verdict's rule, the milestones' range, the favour-first
// policy, and the grid's structural variants.
import { describe, expect, test } from "vitest";
import {
  COMPARISON_GRID,
  FAVOUR_FIRST_POLICY,
  type ModelRun,
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
    const grid = [{ name: "as fitted", options: { horizonMs: 8 * 60 * MINUTE_MS } }];
    const same = pairedComparison(BN1_3.start, TODAYS_POLICY, { ...TODAYS_POLICY, name: "again" }, grid);
    expect(same.settings[0]?.difference.donationsUnlocked).toBe(0);
    expect(same.verdict.donationsUnlocked.answer).toBe("no answer");
    // Never reached within the horizon: no pair.
    expect(same.verdict.destroyed).toMatchObject({ answer: "no answer" });
    expect(same.settings[0]?.first.destroyed).toBeNull();
  });

  test("each setting's difference is the second policy's time less the first's, the pair run at that setting", () => {
    const grid = [
      { name: "as fitted", options: { horizonMs: 10 * 60 * MINUTE_MS } },
      { name: "gross", options: { horizonMs: 10 * 60 * MINUTE_MS, money: "gross" as const } },
    ];
    const compared = pairedComparison(BN1_3.start, TODAYS_POLICY, FAVOUR_FIRST_POLICY, grid);
    for (const [index, { first, second, difference }] of compared.settings.entries()) {
      const run = runModel(BN1_3.start, { ...grid[index]?.options, policy: TODAYS_POLICY });
      expect(first).toEqual(milestonesOf(run, 30));
      const [a, b] = [first.donationsUnlocked, second.donationsUnlocked];
      expect(difference.donationsUnlocked).toBe(a === null || b === null ? null : b - a);
    }
    // From BN1.3's start, favour first unlocks BitRunners' donations 54 min later as fitted (8 h 54 min, against 8 h).
    expect(compared.settings[0]?.difference.donationsUnlocked).toBe(54 * MINUTE_MS);
  });

  test("the grid holds the structural variants (#260's gross money, the share by index) and each constant's step", () => {
    const options = COMPARISON_GRID.map((setting) => setting.options);
    expect(options).toContainEqual({ money: "gross" });
    expect(options).toContainEqual({ share: "index" });
    expect(options).toContainEqual({});
    for (const key of ["expPaceExponent", "moneyPaceMost", "batchesUseOfHosts"]) {
      expect(
        options.some((each) => each.calibration !== undefined && key in each.calibration),
        key,
      ).toBe(true);
    }
  });
});
