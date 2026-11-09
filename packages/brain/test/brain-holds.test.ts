// The brain's event loop held (#309): slow dashboard statuses and Node's own event-loop delay, a line a minute when
// anything was held, and what's left at the brain's stop.
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  BRAIN_HELD_MS,
  BRAIN_HOLDS_EVERY_MS,
  BrainHolds,
  type LoopDelay,
  watchBrainHolds,
} from "../src/brain-holds.ts";

const NS_PER_MS = 1_000_000;

/** A stand-in for Node's histogram: its longest and its 99th percentile, in ms, until reset. */
function delayOf(maxMs: number, p99Ms = 30) {
  const state = { maxMs, p99Ms, resets: 0 };
  const delay: LoopDelay = {
    get max() {
      return state.maxMs * NS_PER_MS;
    },
    percentile: () => state.p99Ms * NS_PER_MS,
    reset() {
      state.maxMs = 0;
      state.resets += 1;
    },
  };
  return { delay, state };
}

describe("a line a minute, only when something was held", () => {
  test("nothing held: no line, and the minute starts afresh", () => {
    expect(BRAIN_HELD_MS).toBe(200);
    expect(BRAIN_HOLDS_EVERY_MS).toBe(60_000);
    const lines: string[] = [];
    const { delay, state } = delayOf(200);
    new BrainHolds({ delay, log: (line) => lines.push(line) }).minute();
    expect(lines).toEqual([]);
    expect(state.resets).toBe(1);
  });

  test("the loop held over 200 ms: its longest and its 99th percentile", () => {
    const lines: string[] = [];
    let nowMs = 1_000;
    const holds = new BrainHolds({
      delay: delayOf(651, 42).delay,
      log: (line) => lines.push(line),
      nowMs: () => nowMs,
    });
    nowMs += 60_000;
    holds.minute();
    expect(lines).toEqual([
      "held in the last 1 min: the event loop held up to 651 ms (99% of its waits under 42 ms); every snapshot " +
        "arriving meanwhile waited (#309)",
    ]);
  });

  test("slow statuses counted with the slowest, then counted afresh; logged at the next minute, never lost", () => {
    const lines: string[] = [];
    const { delay, state } = delayOf(650);
    let nowMs = 0;
    const holds = new BrainHolds({ delay, log: (line) => lines.push(line), nowMs: () => nowMs });
    holds.slowStatus(640.4);
    holds.slowStatus(722.6);
    nowMs += 60_000;
    holds.minute();
    expect(lines).toEqual([
      "held in the last 1 min: 2 dashboard statuses built slower than 200 ms, the slowest in 723 ms; the event loop " +
        "held up to 650 ms (99% of its waits under 30 ms); every snapshot arriving meanwhile waited (#309)",
    ]);
    // One more, then the brain's stop 12 s on: its own line, its span the 12 s, the loop's delay reset meanwhile.
    holds.slowStatus(250);
    nowMs += 12_000;
    holds.minute();
    expect(lines.at(-1)).toBe(
      "held in the last 12 s: 1 dashboard status built slower than 200 ms, the slowest in 250 ms; every snapshot " +
        "arriving meanwhile waited (#309)",
    );
    holds.minute();
    expect(lines).toHaveLength(2);
    expect(state.resets).toBe(3);
  });
});

test("watched for real: the loop held 300 ms is in the line its stop logs", async () => {
  const lines: string[] = [];
  const watch = watchBrainHolds((line) => lines.push(line));
  // Let the histogram take a first sample, hold the loop, then let it sample the hold.
  await sleep(50);
  const until = performance.now() + 300;
  while (performance.now() < until) {
    // Held, as a status sorting the store's rows held it.
  }
  await sleep(50);
  watch.holds.slowStatus(300);
  watch.stop();
  expect(lines).toHaveLength(1);
  const held = Number(/the event loop held up to (\d+) ms/.exec(lines[0] ?? "")?.[1]);
  expect(held).toBeGreaterThanOrEqual(250);
  expect(lines[0]).toMatch(
    /^held in the last \d+ s: 1 dashboard status built slower than 200 ms, the slowest in 300 ms; /,
  );
});
