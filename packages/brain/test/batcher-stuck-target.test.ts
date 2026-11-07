// The run report's check on a batcher stuck on a poor target (#275): an hour or more batching on a target the best
// rooted one would earn `BATCHER_POOR_TARGET_RATIO` times more than, on the hack loop's hosts' RAM, a warning; 2 hours
// of it in a cycle, a failure. From incomes and fast snapshots built here, shaped like the BN1.3 exit run's (#274).
import { newBatcherHealth } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  BATCHER_POOR_TARGET_RATIO,
  BATCHER_STUCK_FAILS_AFTER_MS,
  BATCHER_STUCK_WARNS_AFTER_MS,
  batcherSection,
  stuckTargetLines,
} from "../src/batcher-report.ts";
import { BatcherTargetIncomes } from "../src/hacking-ceiling.ts";

const T0 = Date.parse("2026-11-06T22:18:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** The fast snapshots' looks at the batcher, every 2 s from `fromMs` to `toMs` (both in), on `target`. */
function looks(target: string, fromMs: number, toMs: number): { atMs: number; target: string }[] {
  const points: { atMs: number; target: string }[] = [];
  for (let offsetMs = fromMs; offsetMs <= toMs; offsetMs += 2 * SECOND) points.push({ atMs: T0 + offsetMs, target });
  return points;
}

/** The incomes a medium snapshot at each offset gave: $ a second for each target, and the hacking level. */
function incomesOf(
  each: [offsetMs: number, incomes: Record<string, number> | null, hacking?: number][],
): BatcherTargetIncomes {
  const incomes = new BatcherTargetIncomes();
  for (const [offsetMs, figures, hacking = 1_327] of each) {
    incomes.add(T0 + offsetMs, figures === null ? null : new Map(Object.entries(figures)), hacking);
  }
  return incomes;
}

/** 23:00 in the BN1.3 run (#274): n00dles batched at $19.5m/s, b-and-a's plan $818b/s, a prepared mid target. */
const AT_2300 = { n00dles: 19_500_000, "b-and-a": 818_000_000_000, "rho-construction": 60_000_000_000, ecorp: 1e9 };

function check(
  points: { atMs: number; target: string }[],
  incomes: BatcherTargetIncomes,
  resetsMs: number[] = [],
  cycleLabelAt?: (atMs: number) => string,
) {
  const failures: string[] = [];
  const warnings: string[] = [];
  const lines = stuckTargetLines(points, incomes, resetsMs, failures, warnings, cycleLabelAt);
  return { lines, failures, warnings };
}

const NONE =
  "  stuck on a poor target (#275): none (an hour or more on a target the best rooted one earns 100× more than, " +
  "on the hack loop's hosts' RAM)";
const HEADER =
  "  stuck on a poor target (#275), an hour or more on a target the best rooted one earns 100× more than, on the " +
  "hack loop's hosts' RAM:";

describe("a batcher stuck on a poor target (#275)", () => {
  test("the thresholds: 100×, an hour, and 2 hours in a cycle", () => {
    expect(BATCHER_POOR_TARGET_RATIO).toBe(100);
    expect(BATCHER_STUCK_WARNS_AFTER_MS).toBe(60 * MINUTE);
    expect(BATCHER_STUCK_FAILS_AFTER_MS).toBe(120 * MINUTE);
  });

  test("an hour on n00dles with b-and-a 41,949× it: a warning naming both, the ratio and the hacking levels", () => {
    // The hacking level rose to 1,446 by 00:00 (#274); the least ratio, the stretch's, is the later one here.
    const incomes = incomesOf([
      [0, { ...AT_2300, "b-and-a": 907_000_000_000 }, 1_327],
      [40 * MINUTE, AT_2300, 1_446],
    ]);
    const { lines, failures, warnings } = check(looks("n00dles", 0, 60 * MINUTE), incomes, [], () => "BN1.3 7");
    const line =
      `batcher stuck on a poor target: n00dles from ${iso(0)} to ${iso(60 * MINUTE)} (1 h 0 min on it), in BN1.3 7; ` +
      "the best rooted target 41,949× it at least (b-and-a, $818,000,000,000/s against $19,500,000/s on the hosts' " +
      "RAM), at hacking 1,327 to 1,446";
    expect(warnings).toEqual([line]);
    expect(failures).toEqual([]);
    expect(lines).toEqual([HEADER, `    ${line}`]);
  });

  test("just under an hour isn't one; nor 3 hours on a target the best earns just under 100× more than", () => {
    const incomes = incomesOf([[0, AT_2300]]);
    expect(check(looks("n00dles", 0, 60 * MINUTE - 2 * SECOND), incomes)).toEqual({
      lines: [NONE],
      failures: [],
      warnings: [],
    });
    const near = incomesOf([[0, { n00dles: 1e9, ecorp: 1e9 * BATCHER_POOR_TARGET_RATIO * 0.9999 }]]);
    expect(check(looks("n00dles", 0, 180 * MINUTE), near)).toEqual({ lines: [NONE], failures: [], warnings: [] });
    // Exactly 100×, an hour: one.
    const exactly = incomesOf([[0, { n00dles: 1e9, ecorp: 1e9 * BATCHER_POOR_TARGET_RATIO }]]);
    const { warnings } = check(looks("n00dles", 0, 60 * MINUTE), exactly);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the best rooted target 100× it at least (ecorp, $100,000,000,000/s against");
    expect(warnings[0]?.endsWith("RAM), at hacking 1,327")).toBe(true);
  });

  test("2 hours on one target in a cycle fails, saying so", () => {
    const { lines, failures, warnings } = check(looks("n00dles", 0, 120 * MINUTE), incomesOf([[0, AT_2300]]));
    expect(warnings).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^batcher stuck on a poor target: n00dles from .* \(2 h 0 min on it\); /);
    expect(failures[0]).toMatch(/; 2 h 0 min stuck in its cycle \(2 h or more fails\)$/);
    expect(lines).toEqual([HEADER, `    ${failures[0]}`]);
    // A second short: a warning.
    expect(check(looks("n00dles", 0, 120 * MINUTE - 2 * SECOND), incomesOf([[0, AT_2300]])).warnings).toHaveLength(1);
  });

  test("2 hours in a cycle over two targets fails both; with an install between, each cycle's own: warnings", () => {
    // Phantasy for 61 minutes, then n00dles for 61 (the BN1.3 run's cycle 6 to 8, #274).
    const incomes = incomesOf([[0, { ...AT_2300, phantasy: 6_700_000_000 }]]);
    const points = [...looks("phantasy", 0, 61 * MINUTE), ...looks("n00dles", 61 * MINUTE + 2 * SECOND, 123 * MINUTE)];
    const together = check(points, incomes);
    expect(together.failures).toHaveLength(2);
    expect(together.failures[0]).toContain("phantasy from");
    expect(together.failures[1]).toContain("n00dles from");
    expect(together.failures[0]).toContain("; 2 h 2 min stuck in its cycle (2 h or more fails)");
    expect(together.warnings).toEqual([]);
    // An install at the move: two cycles of 61 minutes.
    const apart = check(points, incomes, [T0 + 61 * MINUTE + SECOND]);
    expect(apart.failures).toEqual([]);
    expect(apart.warnings).toHaveLength(2);
    // An install 10 minutes into n00dles: it's two stretches, 10 and 51 minutes, neither an hour.
    const split = check(points, incomes, [T0 + 71 * MINUTE + SECOND]);
    expect(split.warnings).toHaveLength(1);
    expect(split.warnings[0]).toContain("phantasy from");
  });

  test("a stretch under an hour doesn't count toward the cycle's 2 hours", () => {
    const incomes = incomesOf([[0, { ...AT_2300, phantasy: 6_700_000_000 }]]);
    const points = [...looks("phantasy", 0, 61 * MINUTE), ...looks("n00dles", 61 * MINUTE + 2 * SECOND, 121 * MINUTE)];
    const { failures, warnings } = check(points, incomes);
    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("phantasy from");
  });

  test("the time on it is the time seen: a gap over 6 s isn't counted, but doesn't end the stretch", () => {
    const incomes = incomesOf([[0, AT_2300]]);
    // 50 minutes, 20 unseen, 20 more: 70 minutes on it, over 90.
    const points = [...looks("n00dles", 0, 50 * MINUTE), ...looks("n00dles", 70 * MINUTE, 90 * MINUTE)];
    const { warnings } = check(points, incomes);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`n00dles from ${iso(0)} to ${iso(90 * MINUTE)} (1 h 10 min on it)`);
    // 40 and 15 seen: none.
    const short = [...looks("n00dles", 0, 40 * MINUTE), ...looks("n00dles", 70 * MINUTE, 85 * MINUTE)];
    expect(check(short, incomes).warnings).toEqual([]);
    // Snapshots 6 s apart are counted.
    const sparse = looks("n00dles", 0, 60 * MINUTE).filter((_, index) => index % 3 === 0);
    expect(check(sparse, incomes).warnings).toHaveLength(1);
  });

  test("a look judged within 100× ends a stretch, as another target does; one with the incomes unknown doesn't", () => {
    // From 40 minutes to 40 min 10 s, a medium snapshot with ecorp only 10× n00dles.
    const judged = incomesOf([
      [0, { n00dles: 1e7, ecorp: 1e10 }],
      [40 * MINUTE, { n00dles: 1e7, ecorp: 1e8 }],
      [40 * MINUTE + 10 * SECOND, { n00dles: 1e7, ecorp: 1e10 }],
    ]);
    expect(check(looks("n00dles", 0, 80 * MINUTE), judged).warnings).toEqual([]);
    // Unknown for 5 minutes instead: one stretch, 75 minutes less the looks either side of the unknown ones.
    const unknown = incomesOf([
      [0, { n00dles: 1e7, ecorp: 1e10 }],
      [40 * MINUTE, null],
      [45 * MINUTE, { n00dles: 1e7, ecorp: 1e10 }],
    ]);
    const { warnings } = check(looks("n00dles", 0, 80 * MINUTE), unknown);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 14 min on it)`);
    // Another target for a look: two stretches of 40 minutes.
    const incomes = incomesOf([[0, { n00dles: 1e7, phantasy: 1e7, ecorp: 1e10 }]]);
    const detour = [
      ...looks("n00dles", 0, 40 * MINUTE),
      { atMs: T0 + 40 * MINUTE + SECOND, target: "phantasy" },
      ...looks("n00dles", 40 * MINUTE + 2 * SECOND, 80 * MINUTE),
    ];
    expect(check(detour, incomes).warnings).toEqual([]);
  });

  test("a target that earns nothing is ∞× under; one not among the targets (not rooted) isn't judged", () => {
    const zero = check(looks("n00dles", 0, 60 * MINUTE), incomesOf([[0, { n00dles: 0, ecorp: 1e10 }]]));
    expect(zero.warnings).toHaveLength(1);
    expect(zero.warnings[0]).toContain("the best rooted target ∞× it at least (ecorp, $10,000,000,000/s against $0/s");
    const notATarget = check(looks("n00dles", 0, 60 * MINUTE), incomesOf([[0, { ecorp: 1e10 }]]));
    expect(notATarget.lines).toEqual([
      "  stuck on a poor target (#275): not judged (no look at the batcher with its target's income and the best " +
        "target's known)",
    ]);
    // Nothing hackable rooted: no best, nothing judged.
    expect(check(looks("n00dles", 0, 60 * MINUTE), incomesOf([[0, { n00dles: 0 }]])).lines[0]).toContain("not judged");
    expect(check(looks("n00dles", 0, 60 * MINUTE), new BatcherTargetIncomes()).lines[0]).toContain("not judged");
    expect(check([], incomesOf([[0, AT_2300]])).lines[0]).toContain("not judged");
  });

  test("section 6 lists it after the moves, its failures and warnings the run's", () => {
    const at = (minutes: number) => T0 + minutes * MINUTE;
    const points = [];
    for (let seconds = 0; seconds <= 125 * 60; seconds += 2) {
      points.push({
        atMs: T0 + seconds * SECOND,
        health: { ...newBatcherHealth("n00dles", "a", 0), state: "batching" as const, lastHack: null },
      });
    }
    const failures: string[] = [];
    const warnings: string[] = [];
    const lines = batcherSection(
      points,
      failures,
      [],
      [],
      { incidents: [], weakenMs: () => null, warnings },
      { incomes: incomesOf([[0, AT_2300]]), cycleLabelAt: (atMs) => (atMs >= at(0) ? "BN1.3 7" : "?") },
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("batcher stuck on a poor target: n00dles from");
    expect(failures[0]).toContain("in BN1.3 7;");
    const moves = lines.findIndex((line) => line.startsWith("  moves (#236)"));
    expect(lines[moves + 1]).toBe(HEADER);
    expect(lines[moves + 2]).toBe(`    ${failures[0]}`);
    // Without the incomes (an older caller), no line.
    expect(batcherSection(points, []).some((line) => line.includes("#275"))).toBe(false);
  });
});
