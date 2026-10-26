import { describe, expect, test } from "vitest";
import { findGaps } from "../src/gap-report.ts";

const window = { sinceMs: 0, untilMs: 60_000, thresholdMs: 6_000 };
const everyTwoSeconds = Array.from({ length: 31 }, (_, index) => index * 2_000);

describe("findGaps", () => {
  test("snapshots every 2 s across the window: no gaps", () => {
    expect(findGaps(everyTwoSeconds, window)).toEqual({
      gaps: [],
      count: 31,
      firstMs: 0,
      lastMs: 60_000,
      longestIntervalMs: 2_000,
    });
  });

  test("one interval over the threshold is one gap", () => {
    const times = everyTwoSeconds.filter((time) => time < 20_000 || time > 30_000);
    expect(findGaps(times, window).gaps).toEqual([{ fromMs: 18_000, toMs: 32_000, lengthMs: 14_000 }]);
  });

  test("exactly the threshold isn't a gap; a millisecond more is", () => {
    expect(findGaps([0, 6_000, 12_000], { sinceMs: 0, untilMs: 12_000, thresholdMs: 6_000 }).gaps).toEqual([]);
    expect(findGaps([0, 6_001, 12_000], { sinceMs: 0, untilMs: 12_000, thresholdMs: 6_000 }).gaps).toEqual([
      { fromMs: 0, toMs: 6_001, lengthMs: 6_001 },
    ]);
  });

  test("silence at the start or the end of the window counts as a gap", () => {
    const times = everyTwoSeconds.filter((time) => time >= 10_000 && time <= 50_000);
    expect(findGaps(times, window).gaps).toEqual([
      { fromMs: 0, toMs: 10_000, lengthMs: 10_000 },
      { fromMs: 50_000, toMs: 60_000, lengthMs: 10_000 },
    ]);
  });

  test("no snapshots at all: the whole window is one gap", () => {
    expect(findGaps([], window)).toEqual({
      gaps: [{ fromMs: 0, toMs: 60_000, lengthMs: 60_000 }],
      count: 0,
      firstMs: null,
      lastMs: null,
      longestIntervalMs: 60_000,
    });
  });

  test("a window that ends before it starts is an error, not 'no gaps'", () => {
    expect(() => findGaps([], { sinceMs: 10, untilMs: 10, thresholdMs: 6_000 })).toThrow(RangeError);
    expect(() => findGaps([], { sinceMs: 10, untilMs: 0, thresholdMs: 6_000 })).toThrow(RangeError);
  });

  test("times outside the window are ignored, and times needn't arrive sorted", () => {
    expect(findGaps([70_000, 4_000, -5_000, 2_000, 0], { sinceMs: 0, untilMs: 6_000, thresholdMs: 6_000 })).toEqual({
      gaps: [],
      count: 3,
      firstMs: 0,
      lastMs: 4_000,
      longestIntervalMs: 2_000,
    });
  });
});
