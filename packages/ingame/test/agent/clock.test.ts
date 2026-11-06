// The page's two clocks (#251): the monotonic one for every schedule and deadline, and a moment on it as the wall clock
// reads it, for the stamps the brain reads. A step in the wall clock moves the first not at all.
import { afterEach, expect, test, vi } from "vitest";
import { monotonicMs, monotonicMsOf, wallClockMsOf } from "../../src/clock.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("monotonicMs is performance.now(): a wall-clock step, as `setSystemTime` makes, moves it not", () => {
  vi.useFakeTimers();
  const before = monotonicMs();
  vi.setSystemTime(Date.now() + 3_600_000);
  expect(monotonicMs()).toBe(before);
  vi.advanceTimersByTime(250);
  expect(monotonicMs()).toBe(before + 250);
});

test("wallClockMsOf: a moment ahead or behind on the monotonic clock, as far ahead or behind on the wall clock", () => {
  vi.useFakeTimers();
  expect(wallClockMsOf(monotonicMs() + 5_000)).toBe(Date.now() + 5_000);
  expect(wallClockMsOf(monotonicMs() - 5_000)).toBe(Date.now() - 5_000);
  // Read after a step: the stamp moves with the wall clock, as every wall-clock stamp does.
  const landing = monotonicMs() - 1_000;
  vi.setSystemTime(Date.now() + 2_678);
  expect(wallClockMsOf(landing)).toBe(Date.now() - 1_000);
});

test("monotonicMsOf: the other way, a wall-clock moment as far ahead or behind on the monotonic clock", () => {
  vi.useFakeTimers();
  expect(monotonicMsOf(Date.now() + 30_000)).toBe(monotonicMs() + 30_000);
  expect(monotonicMsOf(Date.now() - 30_000)).toBe(monotonicMs() - 30_000);
  expect(wallClockMsOf(monotonicMsOf(Date.now() + 5))).toBe(Date.now() + 5);
});
