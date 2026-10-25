import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { FAKE_TIMERS_VERSION, FakeTimers, skipEmptyTimerScans } from "../src/host/clock.ts";

const require = createRequire(import.meta.url);
const installed = readFileSync(require.resolve("@sinonjs/fake-timers"), "utf8");
/** fake-timers as installed, without the patch. */
const Unpatched = require("@sinonjs/fake-timers") as typeof FakeTimers;

type Clock = ReturnType<typeof FakeTimers.createClock>;

/** One random scenario's operations, the same for every clock it runs on. */
type Op =
  | { kind: "timeout" | "interval"; name: string; delay: number; onFire?: Op }
  | { kind: "clear"; name: string }
  | { kind: "tick"; ms: number };

/** A small seeded generator, so a failing case can be replayed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Delays are always numbers: an interval without one breaks the heap's order, and the patch's equivalence (#80). */
function scenario(seed: number): Op[] {
  const random = generator(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const ops: Op[] = [];
  const names: string[] = [];
  const timer = (prefix: string): Op => {
    const name = `${prefix}${names.length}`;
    names.push(name);
    if (random() < 0.3) return { kind: "interval", name, delay: pick([1, 3, 7]) };
    return { kind: "timeout", name, delay: pick([0, 0, 1, 2, 5, 10, 50]) };
  };
  for (let i = 0; i < 60; i++) {
    const roll = random();
    if (roll < 0.45) {
      const op = timer("t");
      // Some timers, when they fire, make another timer or clear one: timers created and cleared during a tick.
      if (op.kind === "timeout" && random() < 0.4) {
        op.onFire = random() < 0.5 && names.length > 1 ? { kind: "clear", name: pick(names) } : timer("n");
      }
      ops.push(op);
    } else if (roll < 0.6 && names.length > 0) ops.push({ kind: "clear", name: pick(names) });
    else ops.push({ kind: "tick", ms: pick([0, 1, 2, 5, 13, 100]) });
  }
  // Clear everything left, then tick onto the empty heap.
  for (const name of names) ops.push({ kind: "clear", name });
  ops.push({ kind: "tick", ms: 1000 });
  return ops;
}

/** Runs the operations on a clock; returns what fired, when, and the clock's time at the end. */
async function play(clock: Clock, ops: Op[], ticks: "tick" | "tickAsync"): Promise<string[]> {
  const log: string[] = [];
  const handles = new Map<string, ReturnType<Clock["setTimeout"]>>();
  const apply = async (op: Op): Promise<void> => {
    if (op.kind === "tick") {
      if (ticks === "tick") clock.tick(op.ms);
      else await clock.tickAsync(op.ms);
    } else if (op.kind === "clear") {
      const handle = handles.get(op.name);
      if (handle !== undefined) clock.clearTimeout(handle);
    } else {
      const fire = () => {
        log.push(`${op.name}@${clock.now}`);
        if (op.onFire) void apply(op.onFire);
      };
      const set = op.kind === "interval" ? clock.setInterval : clock.setTimeout;
      handles.set(op.name, set(fire, op.delay));
    }
  };
  for (const op of ops) await apply(op);
  log.push(`end@${clock.now}`);
  return log;
}

describe("the clock's fake-timers patch (#74)", () => {
  test("adds the early return to the installed fake-timers' firstTimerInRange, once, keeping its line numbers", () => {
    const patched = skipEmptyTimerScans(installed, FAKE_TIMERS_VERSION);
    expect(patched.match(/if \(!first \|\| first\.callAt > to\) \{ return null; \}/g)).toHaveLength(1);
    expect(patched.split("\n")).toHaveLength(installed.split("\n").length);
  });

  test.each([
    ["another version", installed, "15.5.0"],
    [
      "changed lines",
      installed.replace("if (first && inRange(from, to, first)) {", "if (first) {"),
      FAKE_TIMERS_VERSION,
    ],
  ])("refuses %s, so an upgrade can't keep it without a re-check", (_, source, version) => {
    expect(() => skipEmptyTimerScans(source, version)).toThrow(/re-check firstTimerInRange/);
  });

  test.each(["tick", "tickAsync"] as const)(
    "fires the same timers at the same times as unpatched fake-timers, over 150 random scenarios (%s)",
    async (ticks) => {
      for (let seed = 1; seed <= 150; seed++) {
        const ops = scenario(seed);
        const patched = await play(FakeTimers.createClock(0), ops, ticks);
        const unpatched = await play(Unpatched.createClock(0), ops, ticks);
        expect({ seed, log: patched }).toEqual({ seed, log: unpatched });
      }
    },
  );

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
