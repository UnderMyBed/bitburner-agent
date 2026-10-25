import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { FakeTimers, skipEmptyTimerScans } from "../src/host/clock.ts";

const installed = readFileSync(createRequire(import.meta.url).resolve("@sinonjs/fake-timers"), "utf8");

describe("the clock's fake-timers patch (#74)", () => {
  test("adds the early return to the installed fake-timers' firstTimerInRange, once", () => {
    const patched = skipEmptyTimerScans(installed);
    expect(patched.length).toBeGreaterThan(installed.length);
    expect(patched.match(/if \(!first \|\| first\.callAt > to\) \{/g)).toHaveLength(1);
  });

  test("refuses a fake-timers it wasn't made for, so an upgrade can't drop it silently", () => {
    expect(() => skipEmptyTimerScans(installed.replace("const first = clock.timerHeap.peek();", ""))).toThrow(
      /skipEmptyTimerScans/,
    );
  });

  test("fires the same timers in the same order as unpatched fake-timers", () => {
    const fire = (createClock: typeof FakeTimers.createClock) => {
      const clock = createClock(0);
      const fired: string[] = [];
      clock.setTimeout(() => fired.push("a@5"), 5);
      clock.setTimeout(() => fired.push("b@5"), 5);
      clock.setInterval(() => {
        fired.push(`i@${clock.now}`);
        if (clock.now === 6) clock.setTimeout(() => fired.push(`z@${clock.now}`), 0);
      }, 3);
      clock.setTimeout(() => fired.push("far"), 1e9);
      for (let i = 0; i < 12; i++) clock.tick(1);
      return fired;
    };
    const unpatched = createRequire(import.meta.url)("@sinonjs/fake-timers") as typeof FakeTimers;
    expect(fire(FakeTimers.createClock)).toEqual(fire(unpatched.createClock));
  });

  test("a step costs about the same with 20,000 timers pending as with 10", () => {
    // Each tick fires one interval timer; then, without the patch, the earliest timer left is past the range and
    // fake-timers scans every pending timer, twice. Best of 5, so one slow moment doesn't decide it.
    const stepsMs = (pending: number) => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run++) {
        const clock = FakeTimers.createClock(0);
        for (let i = 0; i < pending; i++) clock.setTimeout(() => {}, 1e9 + i);
        clock.setInterval(() => {}, 1);
        const started = performance.now();
        for (let i = 0; i < 2000; i++) clock.tick(1);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const few = stepsMs(10);
    const many = stepsMs(20_000);
    expect(many).toBeLessThan(Math.max(20 * few, 50));
  });
});
