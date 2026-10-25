import { aggregate, type Checkpoint, type GameSummary, type SeedResult } from "@bitburner-agent/sim";
import { describe, expect, test } from "vitest";
import { DAY } from "../src/baseline.ts";
import { baselineRow, dailyHeapMb, formatHeaps, seedHeapGrowth } from "../src/report.ts";

const HOUR = DAY / 24;
const summary = {} as GameSummary;
const checkpoint = (virtualMs: number, heapMb?: number): Checkpoint => ({
  virtualMs,
  summary,
  ...(heapMb === undefined ? {} : { heapMb }),
});

function seed(seedNumber: number, fields: Partial<SeedResult>): SeedResult {
  return {
    seed: seedNumber,
    ok: true,
    stoppedBy: { list: "stopWhen", index: 0 },
    passed: true,
    uncaught: 0,
    virtualMs: 0,
    wallMs: 0,
    speed: 0,
    checkpoints: [],
    events: [],
    ...fields,
  };
}

describe("the heap per seed", () => {
  test("daily samples are the start and the whole-day checkpoints; the stop's part-day sample is left out", () => {
    const result = seed(1, {
      heapStartMb: 100,
      checkpoints: [checkpoint(DAY, 110), checkpoint(2 * DAY, 112), checkpoint(2 * DAY + 5 * HOUR, 140)],
    });
    expect(dailyHeapMb(result)).toEqual([100, 110, 112]);
  });

  test("growth is the benchmarks' median day-to-day change, day 1's warm-up left out", () => {
    const result = seed(1, {
      heapStartMb: 100,
      checkpoints: [checkpoint(DAY, 150), checkpoint(2 * DAY, 151), checkpoint(3 * DAY, 153), checkpoint(4 * DAY, 154)],
    });
    expect(seedHeapGrowth(result)).toBe(1);
  });

  test("fewer than 3 daily samples, or no heap measured, gives no growth", () => {
    expect(seedHeapGrowth(seed(1, { heapStartMb: 100, checkpoints: [checkpoint(DAY, 110)] }))).toBeNull();
    expect(seedHeapGrowth(seed(1, { checkpoints: [checkpoint(DAY), checkpoint(2 * DAY)] }))).toBeNull();
  });

  test("the table shows start, end, largest and growth, and '-' for what wasn't measured", () => {
    const measured = seed(1, {
      heapStartMb: 100,
      checkpoints: [checkpoint(DAY, 140), checkpoint(2 * DAY, 130), checkpoint(3 * DAY, 132), checkpoint(4 * DAY, 134)],
    });
    const lines = formatHeaps({ scenario: "s", results: [measured, seed(2, {})], aggregate: aggregate([]) }).split(
      "\n",
    );
    expect(lines[1]?.split(/\s{2,}/)).toEqual(["1", "100.0 MB", "134.0 MB", "140.0 MB", "+2.0 MB"]);
    expect(lines[2]?.split(/\s{2,}/)).toEqual(["2", "-", "-", "-", "-"]);
  });
});

describe("the release row", () => {
  const meta = { date: "2026-10-25", commit: "abc1234", rig: "rig-16c-62g", node: "v24.22.1" };

  test("passes, time to destroy in hours, median speed, real time and heap growth", () => {
    const days = (n: number) => [...Array(n).keys()].map((i) => checkpoint((i + 1) * DAY, 100 + 2 * (i + 1)));
    const results = [
      seed(1, { virtualMs: 30 * HOUR, wallMs: 40 * 60_000, speed: 45, heapStartMb: 100, checkpoints: days(2) }),
      seed(2, { virtualMs: 50 * HOUR, wallMs: 80 * 60_000, speed: 38, heapStartMb: 100, checkpoints: days(3) }),
      seed(3, { ok: false, passed: false, stoppedBy: null, error: "wall limit", heapStartMb: 100 }),
    ];
    const row = baselineRow({ scenario: "s", results, aggregate: aggregate(results) }, meta);
    expect(row).toBe(
      "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 2/3 | 30.0 h / 30.0 h / 50.0 h / 50.0 h | 38x | 40 min | +2.0 MB |",
    );
  });

  test("with no seed passing or measured, the columns read '-'", () => {
    const results = [seed(1, { ok: false, passed: false, stoppedBy: null })];
    expect(baselineRow({ scenario: "s", results, aggregate: aggregate(results) }, meta)).toBe(
      "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 0/1 | - | - | - | - |",
    );
  });
});
