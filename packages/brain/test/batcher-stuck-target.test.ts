// The run report's check on a batcher stuck on a poor target (#275): an hour or more on targets the best rooted one
// would earn `BATCHER_POOR_TARGET_RATIO` times more than, on the hack loop's hosts' RAM, a warning; 2 hours of it in a
// cycle, a failure. From incomes and fast snapshots built here, shaped like the BN1.3 exit run's (#274).
import { newBatcherHealth } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  BATCHER_POOR_TARGET_RATIO,
  BATCHER_STUCK_BREAK_MS,
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

/**
 * A medium snapshot every 10 s for 6 hours, each with the incomes of the latest change by then: $ a second for each
 * target and the hacking level; null for the ceilings unknown, "none" for no medium snapshot (a degraded tier).
 */
function incomesOf(
  changes: [offsetMs: number, incomes: Record<string, number> | null | "none", hacking?: number][],
): BatcherTargetIncomes {
  const incomes = new BatcherTargetIncomes();
  for (let offsetMs = 0; offsetMs <= 360 * MINUTE; offsetMs += 10 * SECOND) {
    const [, figures, hacking = 1_327] = changes.findLast(([fromMs]) => fromMs <= offsetMs) ?? [0, "none"];
    if (figures === "none") continue;
    incomes.add(T0 + offsetMs, figures === null ? null : new Map(Object.entries(figures)), hacking);
  }
  return incomes;
}

/** 23:00 in the BN1.3 run (#274): n00dles batched at $19.5m/s, b-and-a's plan $818b/s, a prepared mid target. */
const AT_2300 = { n00dles: 19_500_000, "b-and-a": 818_000_000_000, "rho-construction": 60_000_000_000, ecorp: 1e9 };
/** As `AT_2300`, with phantasy poor too and rho-construction not: 1e7 against 1e10. */
const POOR_AND_NOT = { n00dles: 1e7, phantasy: 1e7, "rho-construction": 1e9, ecorp: 1e10 };

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

const WHAT =
  "an hour or more on targets the best rooted one earns 100× more than, on the hack loop's hosts' RAM (under 10 min " +
  "off them joins), or 2 h of it in a cycle";
const NONE = `  stuck on a poor target (#275): none (${WHAT})`;
const HEADER = `  stuck on a poor target (#275), ${WHAT}:`;

describe("a batcher stuck on a poor target (#275)", () => {
  test("the thresholds: 100×, an hour, 2 hours in a cycle, and 10 minutes off poor targets to break a stretch", () => {
    expect(BATCHER_POOR_TARGET_RATIO).toBe(100);
    expect(BATCHER_STUCK_WARNS_AFTER_MS).toBe(60 * MINUTE);
    expect(BATCHER_STUCK_FAILS_AFTER_MS).toBe(120 * MINUTE);
    expect(BATCHER_STUCK_BREAK_MS).toBe(10 * MINUTE);
  });

  test("an hour on n00dles: a warning naming it, the range of ratios, the best at the largest, the hacking levels", () => {
    // The hacking level rose to 1,446 by 00:00 (#274); the ratio fell from 46,513× to 41,949×.
    const incomes = incomesOf([
      [0, { ...AT_2300, "b-and-a": 907_000_000_000 }, 1_327],
      [40 * MINUTE, AT_2300, 1_446],
    ]);
    const { lines, failures, warnings } = check(looks("n00dles", 0, 60 * MINUTE), incomes, [], () => "BN1.3 7");
    const line =
      `batcher stuck on a poor target: n00dles from ${iso(0)} to ${iso(60 * MINUTE)} (1 h 0 min on it), in BN1.3 7; ` +
      "the best rooted target 41,949× to 46,513× it (at the most b-and-a, $907,000,000,000/s against $19,500,000/s " +
      "on the hosts' RAM), at hacking 1,327 to 1,446";
    expect(warnings).toEqual([line]);
    expect(failures).toEqual([]);
    expect(lines).toEqual([HEADER, `    ${line}`]);
  });

  test("the RAM growing partway: the stretch starts where the ratio crosses 100×, and the range shows the climb", () => {
    // n00dles 50× under b-and-a until 5 minutes in, then the cloud servers: 200×, then 20,000× from 30 minutes.
    const incomes = incomesOf([
      [0, { n00dles: 1e7, "b-and-a": 5e8 }],
      [5 * MINUTE, { n00dles: 1e7, "b-and-a": 2e9 }],
      [30 * MINUTE, { n00dles: 1e7, "b-and-a": 2e11 }],
    ]);
    const { warnings } = check(looks("n00dles", 0, 70 * MINUTE), incomes);
    expect(warnings).toEqual([
      `batcher stuck on a poor target: n00dles from ${iso(5 * MINUTE)} to ${iso(70 * MINUTE)} (1 h 5 min on it); the ` +
        "best rooted target 200× to 20,000× it (at the most b-and-a, $200,000,000,000/s against $10,000,000/s on the " +
        "hosts' RAM), at hacking 1,327",
    ]);
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
    // Exactly 100×, an hour: one, its ratio a single figure.
    const exactly = incomesOf([[0, { n00dles: 1e9, ecorp: 1e9 * BATCHER_POOR_TARGET_RATIO }]]);
    const { warnings } = check(looks("n00dles", 0, 60 * MINUTE), exactly);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("the best rooted target 100× it (at the most ecorp, $100,000,000,000/s against");
    expect(warnings[0]?.endsWith("RAM), at hacking 1,327")).toBe(true);
  });

  test("2 hours in a cycle fails: one line for the cycle, its time and its longest stretch", () => {
    const { lines, failures, warnings } = check(
      looks("n00dles", 0, 120 * MINUTE),
      incomesOf([[0, AT_2300]]),
      [],
      () => "BN1.3 7",
    );
    expect(warnings).toEqual([]);
    expect(failures).toEqual([
      "batcher stuck on a poor target: 2 h 0 min on poor targets in BN1.3 7 (2 h or more in a cycle fails), in 1 " +
        `stretch; the longest, n00dles from ${iso(0)} to ${iso(120 * MINUTE)} (2 h 0 min on it); the best rooted ` +
        "target 41,949× it (at the most b-and-a, $818,000,000,000/s against $19,500,000/s on the hosts' RAM), at " +
        "hacking 1,327",
    ]);
    expect(lines).toEqual([HEADER, `    ${failures[0]}`]);
    // Without 2b's cycles: "in its cycle". A second short: a warning.
    expect(check(looks("n00dles", 0, 120 * MINUTE), incomesOf([[0, AT_2300]])).failures[0]).toContain(
      "2 h 0 min on poor targets in its cycle (2 h or more",
    );
    expect(check(looks("n00dles", 0, 120 * MINUTE - 2 * SECOND), incomesOf([[0, AT_2300]])).warnings).toHaveLength(1);
  });

  test("a cycle's poor time adds up across every stretch, each under an hour (#277's review)", () => {
    // 50 minutes on n00dles, then 15 on rho-construction (not poor), three times: 2.5 h stuck, never an hour at once.
    const incomes = incomesOf([[0, POOR_AND_NOT]]);
    const round = (startMs: number, poorMs = 50 * MINUTE) => [
      ...looks("n00dles", startMs, startMs + poorMs),
      ...looks("rho-construction", startMs + poorMs + 2 * SECOND, startMs + 65 * MINUTE - 2 * SECOND),
    ];
    // The second 52 minutes, the longest.
    const three = check([...round(0), ...round(65 * MINUTE, 52 * MINUTE), ...round(130 * MINUTE)], incomes);
    expect(three.warnings).toEqual([]);
    expect(three.failures).toHaveLength(1);
    expect(three.failures[0]).toMatch(
      /^batcher stuck on a poor target: 2 h 32 min on poor targets in its cycle \(2 h or more in a cycle fails\), in 3 stretches; the longest, n00dles from /,
    );
    expect(three.failures[0]).toContain(
      `the longest, n00dles from ${iso(65 * MINUTE)} to ${iso(117 * MINUTE)} (52 min on it)`,
    );
    // Twice: 1 h 40 min, and no stretch an hour: none.
    expect(check([...round(0), ...round(65 * MINUTE)], incomes).lines).toEqual([NONE]);
  });

  test("under 10 minutes off poor targets joins the stretches either side, its time not counted (#277's review)", () => {
    // A 10-second dip under 100× at 40 minutes: one stretch of 80 minutes, less the dip and the looks either side.
    const dip = incomesOf([
      [0, POOR_AND_NOT],
      [40 * MINUTE, { ...POOR_AND_NOT, "rho-construction": 1e8, ecorp: 1e8 }],
      [40 * MINUTE + 10 * SECOND, POOR_AND_NOT],
    ]);
    const dipped = check(looks("n00dles", 0, 80 * MINUTE), dip);
    expect(dipped.warnings).toHaveLength(1);
    expect(dipped.warnings[0]).toContain(`n00dles from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 19 min on it)`);
    const incomes = incomesOf([[0, POOR_AND_NOT]]);
    // A 2-minute move to rho-construction, not poor, and back.
    const away = [
      ...looks("n00dles", 0, 40 * MINUTE),
      ...looks("rho-construction", 40 * MINUTE + 2 * SECOND, 42 * MINUTE),
      ...looks("n00dles", 42 * MINUTE + 2 * SECOND, 80 * MINUTE),
    ];
    const moved = check(away, incomes);
    expect(moved.warnings).toHaveLength(1);
    expect(moved.warnings[0]).toContain(`: n00dles from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 17 min on it)`);
    // A move to phantasy, poor too: one stretch on both, its time all counted.
    const both = check(
      [...looks("n00dles", 0, 40 * MINUTE), ...looks("phantasy", 40 * MINUTE + 2 * SECOND, 80 * MINUTE)],
      incomes,
    );
    expect(both.warnings).toHaveLength(1);
    expect(both.warnings[0]).toContain(`: n00dles, phantasy from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 20 min on it)`);
  });

  test("10 minutes or more from the last poor look to the next, with a look not poor between, breaks it", () => {
    const incomes = incomesOf([[0, POOR_AND_NOT]]);
    const awayUntil = (backMs: number) => [
      ...looks("n00dles", 0, 40 * MINUTE),
      ...looks("rho-construction", 40 * MINUTE + 2 * SECOND, backMs - 2 * SECOND),
      ...looks("n00dles", backMs, 100 * MINUTE),
    ];
    // Back at exactly 10 minutes: 40 and 50 minutes, apart; 1 h 30 min in the cycle.
    expect(check(awayUntil(50 * MINUTE), incomes).lines).toEqual([NONE]);
    // 2 s sooner: joined, an hour and more.
    expect(check(awayUntil(50 * MINUTE - 2 * SECOND), incomes).warnings).toHaveLength(1);
    // A short move off joins, and then 12 minutes unseen (no look not poor) doesn't break it.
    const offThenUnseen = [
      ...looks("n00dles", 0, 20 * MINUTE),
      ...looks("rho-construction", 20 * MINUTE + 2 * SECOND, 21 * MINUTE),
      ...looks("n00dles", 21 * MINUTE + 2 * SECOND, 40 * MINUTE),
      ...looks("n00dles", 52 * MINUTE, 80 * MINUTE),
    ];
    expect(check(offThenUnseen, incomes).warnings[0]).toContain(
      `from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 6 min on it)`,
    );
    // 12 minutes unseen alone doesn't either.
    const unseen = [...looks("n00dles", 0, 40 * MINUTE), ...looks("n00dles", 52 * MINUTE, 80 * MINUTE)];
    expect(check(unseen, incomes).warnings[0]).toContain(`from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 8 min on it)`);
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

  test("looks with the incomes unknown, or stale (no medium snapshot for over 30 s), neither end nor add to it", () => {
    const unknown = incomesOf([
      [0, { n00dles: 1e7, ecorp: 1e10 }],
      [40 * MINUTE, null],
      [45 * MINUTE, { n00dles: 1e7, ecorp: 1e10 }],
    ]);
    const { warnings } = check(looks("n00dles", 0, 80 * MINUTE), unknown);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`from ${iso(0)} to ${iso(80 * MINUTE)} (1 h 14 min on it)`);
    // Unknown for 12 minutes, over the break's 10: still one stretch, as only a look judged not poor breaks one.
    const longUnknown = incomesOf([
      [0, { n00dles: 1e7, ecorp: 1e10 }],
      [40 * MINUTE, null],
      [52 * MINUTE, { n00dles: 1e7, ecorp: 1e10 }],
    ]);
    expect(check(looks("n00dles", 0, 80 * MINUTE), longUnknown).warnings[0]).toContain("(1 h 7 min on it)");
    // No medium snapshot from 40 to 45 minutes: the looks from 40 min 30 s aren't judged on the one at 39 min 50 s.
    const stale = incomesOf([
      [0, { n00dles: 1e7, ecorp: 1e10 }],
      [40 * MINUTE, "none"],
      [45 * MINUTE, { n00dles: 1e7, ecorp: 1e10 }],
    ]);
    expect(check(looks("n00dles", 0, 80 * MINUTE), stale).warnings[0]).toContain("(1 h 15 min on it)");
  });

  test("an install ends a stretch and starts a cycle; a stretch over poor targets joins a move between them", () => {
    // Phantasy for 61 minutes, then n00dles for 62 (the BN1.3 run's cycles 6 and 7, #274): one stretch, 2 h.
    const incomes = incomesOf([[0, POOR_AND_NOT]]);
    const points = [...looks("phantasy", 0, 61 * MINUTE), ...looks("n00dles", 61 * MINUTE + 2 * SECOND, 123 * MINUTE)];
    const together = check(points, incomes);
    expect(together.warnings).toEqual([]);
    expect(together.failures).toEqual([
      expect.stringMatching(/ 2 h 3 min on poor targets in its cycle .* in 1 stretch; the longest, phantasy, n00dles /),
    ]);
    // An install at the move: two cycles, each an hour.
    const apart = check(points, incomes, [T0 + 61 * MINUTE + SECOND]);
    expect(apart.failures).toEqual([]);
    expect(apart.warnings).toEqual([
      expect.stringContaining(": phantasy from"),
      expect.stringContaining(": n00dles from"),
    ]);
    // n00dles' from the first medium snapshot after the install, never the one at 61 minutes, before it.
    expect(apart.warnings[1]).toContain(`: n00dles from ${iso(61 * MINUTE + 10 * SECOND)} to `);
    // An install 10 minutes into n00dles: 1 h 11 min, then 52 minutes, in two cycles.
    const split = check(points, incomes, [T0 + 71 * MINUTE + SECOND]);
    expect(split.failures).toEqual([]);
    expect(split.warnings).toEqual([expect.stringContaining(": phantasy, n00dles from")]);
  });

  test("a target that earns nothing is ∞× under; one not among the targets (not rooted) isn't judged", () => {
    const zero = check(looks("n00dles", 0, 60 * MINUTE), incomesOf([[0, { n00dles: 0, ecorp: 1e10 }]]));
    expect(zero.warnings).toHaveLength(1);
    expect(zero.warnings[0]).toContain(
      "the best rooted target ∞× it (at the most ecorp, $10,000,000,000/s against $0/s",
    );
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
      { incomes: incomesOf([[0, AT_2300]]), cycleLabelAt: () => "BN1.3 7" },
    );
    expect(failures).toEqual([expect.stringContaining("2 h 5 min on poor targets in BN1.3 7 (2 h or more")]);
    const moves = lines.findIndex((line) => line.startsWith("  moves (#236)"));
    expect(lines[moves + 1]).toBe(HEADER);
    expect(lines[moves + 2]).toBe(`    ${failures[0]}`);
    // Without the incomes (an older caller), no line.
    expect(batcherSection(points, []).some((line) => line.includes("#275"))).toBe(false);
  });
});
