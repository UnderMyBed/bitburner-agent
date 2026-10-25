import { aggregate, type Checkpoint, type GameSummary, type SeedResult } from "@bitburner-agent/sim";
import { describe, expect, test } from "vitest";
import { DAY } from "../src/baseline.ts";
import { baselineRow, dailyHeapMb, formatHeaps, formatSeeds, seedHeapGrowth } from "../src/report.ts";

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

  test("growth is rounded before its sign, so a tiny shrink reads +0.0, as in benchmarks", () => {
    const result = seed(1, {
      heapStartMb: 100,
      checkpoints: [checkpoint(DAY, 110), checkpoint(2 * DAY, 109.96), checkpoint(3 * DAY, 109.92)],
    });
    const run = { scenario: "s", results: [result], aggregate: aggregate([result]) };
    expect(formatHeaps(run).split("\n")[1]).toMatch(/\+0\.0 MB$/);
  });

  test("the table shows start, end, largest (the start included) and growth, '-' for what wasn't measured", () => {
    const measured = seed(1, {
      heapStartMb: 150,
      checkpoints: [checkpoint(DAY, 140), checkpoint(2 * DAY, 130), checkpoint(3 * DAY, 132), checkpoint(4 * DAY, 134)],
    });
    const lines = formatHeaps({ scenario: "s", results: [measured, seed(2, {})], aggregate: aggregate([]) }).split(
      "\n",
    );
    expect(lines[1]?.trim().split(/\s{2,}/)).toEqual(["1", "150.0 MB", "134.0 MB", "150.0 MB", "+2.0 MB"]);
    expect(lines[2]?.trim().split(/\s{2,}/)).toEqual(["2", "-", "-", "-", "-"]);
    // Every column lines up with its header: the lines are the same length.
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });
});

describe("seeds", () => {
  test.each([
    [[1, 2, 3, 4, 5, 6, 7, 8], "1..8"],
    [[3, 1, 2], "1..3"],
    [[1, 3, 5], "1,3,5"],
    [[4], "4"],
  ])("%j are written as --seeds takes them: %s", (seeds, text) => {
    expect(formatSeeds(seeds)).toBe(text);
  });
});

describe("the release row", () => {
  const meta = { date: "2026-10-25", commit: "abc1234", rig: "rig-16c-62g", node: "v24.22.1" };
  const days = (...mb: number[]) => mb.map((value, i) => checkpoint((i + 1) * DAY, value));

  test("seeds, passes, time to destroy in hours, and medians of speed, real time and heap growth", () => {
    const results = [
      seed(1, {
        virtualMs: 30 * HOUR,
        wallMs: 40 * 60_000,
        speed: 45,
        heapStartMb: 100,
        checkpoints: days(110, 111, 112),
      }),
      seed(2, {
        virtualMs: 50 * HOUR,
        wallMs: 80 * 60_000,
        speed: 38,
        heapStartMb: 100,
        checkpoints: days(110, 112, 114),
      }),
      seed(3, {
        virtualMs: 40 * HOUR,
        wallMs: 60 * 60_000,
        speed: 50,
        heapStartMb: 100,
        checkpoints: days(110, 115, 120),
      }),
      // Failed early: its real time must not count, and with one daily sample it has no growth.
      seed(4, {
        ok: false,
        passed: false,
        stoppedBy: null,
        wallMs: 10 * 60_000,
        heapStartMb: 100,
        checkpoints: days(130),
      }),
    ];
    const row = baselineRow({ scenario: "s", results, aggregate: aggregate(results) }, meta);
    // Growths 1, 2 and 5: only the median gives +2.0. Real times 40, 60 and 80 min: 60 only without the failed seed.
    expect(row).toBe(
      "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 1..4 | 3/4 | 30.0 h / 40.0 h / 50.0 h / 50.0 h | 45x | 60 min | +2.0 MB |",
    );
  });

  test("with no seed passing or measured, the columns read '-'", () => {
    const results = [seed(1, { ok: false, passed: false, stoppedBy: null })];
    expect(baselineRow({ scenario: "s", results, aggregate: aggregate(results) }, meta)).toBe(
      "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 1 | 0/1 | - | - | - | - |",
    );
  });
});
