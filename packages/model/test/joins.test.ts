// #294's joins (./src/joins.ts): each join's mean time from its terms to the brain's slow snapshot that shows it, and
// the pipeline that keeps the backdoors one at a time and the joins one a slow snapshot. The hacker factions' times are
// checked against the brain's own rules on the game's clocks in packages/brain/test/backdoors.test.ts.
import { SNAPSHOT_TIER_PERIOD_MS } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import { backdoorMs, INVITATION_CHECK_MS, JoinPipeline, ROUNDS_BETWEEN_TRIES } from "../src/index.ts";

const { fast: ROUND_MS, medium: MEDIUM_MS, slow: SLOW_MS } = SNAPSHOT_TIER_PERIOD_MS;

describe("one join, a fresh pipeline", () => {
  test("a hacker faction: the medium snapshot after, the backdoor, the check, the slow snapshot after, the next: 100 s", () => {
    // From the medium snapshot (5 s on average), the round, 2 s of backdoor and the check's 1 s land before the next
    // medium snapshot (10 s), then the rest of a slow snapshot's minute on average (25 s), then a minute.
    expect(backdoorMs(530, 600, 1.8)).toBeCloseTo(1_950, 0);
    expect(new JoinPipeline().hackerFaction(0, 530, 600, 1.8)).toBe(MEDIUM_MS / 2 + MEDIUM_MS + 25_000 + SLOW_MS);
    // A backdoor of 9.5 s pushes the invitation past the next medium snapshot: 10 s more.
    expect(new JoinPipeline().hackerFaction(0, 54, 54, 0.8)).toBe(110_000);
    // At the edge: the round (2 s) and 7.56 s of backdoor make 9.56 s, and the check (up to 2 s) takes 78% of its
    // phases past the next medium snapshot: 100 s + 0.78 × 10 s.
    expect(backdoorMs(54, 55, 1)).toBeCloseTo(7_559.5, 0);
    expect(new JoinPipeline().hackerFaction(0, 54, 55, 1)).toBeCloseTo(107_797.6, 0);
    // From another time, the same wait.
    expect(new JoinPipeline().hackerFaction(1_234, 530, 600, 1.8)).toBe(101_234);
  });

  test("Tian Di Hui: the travel at the medium snapshot, the check, the slow snapshots: 100 s; Daedalus: the check, then 91 s", () => {
    expect(new JoinPipeline().tianDiHui(0)).toBe(100_000);
    expect(new JoinPipeline().daedalus(0)).toBe(INVITATION_CHECK_MS / 2 + SLOW_MS / 2 + SLOW_MS);
  });

  test("a city group: a city a slow snapshot, each join a slow snapshot after its invitation shows", () => {
    expect(new JoinPipeline().cityGroup(0, 3)).toEqual([100_000, 160_000, 220_000]);
    expect(new JoinPipeline().cityGroup(0, 0)).toEqual([]);
  });
});

describe("the pipeline", () => {
  test("backdoors one at a time: the next asked for at the medium snapshot after the last's reported done (40 s)", () => {
    const pipeline = new JoinPipeline();
    const shown = [54, 207, 350, 530].map((required) => pipeline.hackerFaction(0, required, 600, 1.8));
    // The invitations 40 s apart, but the joins a slow snapshot each: one a minute after the first.
    expect(shown).toEqual([100_000, 160_000, 220_000, 280_000]);
    // Tried in the round after the ask, done at the try 15 rounds on, seen a round later: 34 s, so the next medium
    // snapshot: the next asked for 40 s after.
    expect(ROUND_MS + ROUNDS_BETWEEN_TRIES * ROUND_MS + ROUND_MS).toBe(34_000);
    const one = new JoinPipeline();
    expect(one.backdoorFreeAtMs).toBe(Number.NEGATIVE_INFINITY);
    one.hackerFaction(0, 54, 600, 1.8);
    expect(one.backdoorFreeAtMs).toBe(MEDIUM_MS / 2 + 40_000);
  });

  test("a backdoor longer than the tries' 30 s takes another try before the next is asked for", () => {
    // CSEC at hacking 1, speed 0.1: 5 × 635 / 51 / 0.1 / 4 s, about 156 s: done at the 6th try, 182 s after the
    // ask, so the next asked for at 195 s, not 45 s, and its join a slow snapshot after it shows: 310 s against 160 s.
    const slow = new JoinPipeline();
    expect(backdoorMs(54, 1, 0.1)).toBeCloseTo(155_637, 0);
    expect(slow.hackerFaction(0, 54, 1, 0.1)).toBe(250_000);
    expect(slow.backdoorFreeAtMs).toBe(195_000);
    const fast = new JoinPipeline();
    fast.hackerFaction(0, 54, 600, 1.8);
    expect(slow.hackerFaction(0, 207, 600, 1.8)).toBe(310_000);
    expect(fast.hackerFaction(0, 207, 600, 1.8)).toBe(160_000);
  });

  test("joins of every kind share the one-a-slow-snapshot queue, in the order their terms are met", () => {
    const pipeline = new JoinPipeline();
    expect(pipeline.hackerFaction(0, 54, 600, 1.8)).toBe(100_000);
    expect(pipeline.tianDiHui(0)).toBe(160_000);
    expect(pipeline.cityGroup(0, 2)).toEqual([220_000, 280_000]);
    expect(pipeline.daedalus(0)).toBe(340_000);
    // Terms met long after the queue empties: its own time again.
    expect(pipeline.daedalus(1_000_000)).toBe(1_091_000);
  });
});
