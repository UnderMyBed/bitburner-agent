import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { reportUncaughtException } from "./parity/errors.ts";

type FakeTimersModule = typeof import("@sinonjs/fake-timers");

/** The fake-timers version the patch was made for; package.json pins it. */
export const FAKE_TIMERS_VERSION = "15.4.0";
/** The lines the patch anchors on, in `firstTimerInRange` (fake-timers-src.js:1454-1456). */
const SCAN_FROM = `        if (first && inRange(from, to, first)) {
            return first;
        }
`;
/** The same, with the early return added on the closing brace's line, so every line keeps its installed number. */
const SCAN_TO = `        if (first && inRange(from, to, first)) {
            return first;
        } if (!first || first.callAt > to) { return null; }
`;

/**
 * fake-timers' source, with its scan of every timer skipped when none is due (#74).
 *
 * fake-timers finds the next timer due in a range by taking its heap's earliest timer if that one is in range, and
 * otherwise by scanning every timer (`firstTimerInRange`, fake-timers-src.js:1443-1473). The simulator steps exactly to
 * each next due moment, so once that moment's timers have fired the earliest one left is past the range: every step
 * scanned every pending timer, twice, a cost that grew with the square of the scripts running. When the earliest timer
 * is due after the range, so is every timer, since the heap orders them by due time, and the scan would find nothing:
 * this returns null at once.
 *
 * That holds while the heap's order follows due times, which fake-timers breaks in two ways: idle callbacks sort last
 * whatever their due time (the host doesn't fake `requestIdleCallback`), and an interval whose delay fake-timers reads
 * as NaN (`setInterval(fn)`, `"x"`, NaN, ±Infinity; fake-timers-src.js:2012) is due at NaN once it has fired (:1513).
 * The host rules out the second: no delay reaches fake-timers as NaN (`browserDelay`; #80). Throws if the version or
 * the patched lines aren't the ones this was made for, so an upgrade can't keep the patch without a re-check.
 */
export function skipEmptyTimerScans(source: string, version: string): string {
  const recheck =
    "(packages/sim/src/host/clock.ts): re-check firstTimerInRange, compareTimers and the timer heap, then update or " +
    "remove the patch (#74).";
  if (version !== FAKE_TIMERS_VERSION) {
    throw new Error(`skipEmptyTimerScans was made for fake-timers ${FAKE_TIMERS_VERSION}, not ${version} ${recheck}`);
  }
  if (source.split(SCAN_FROM).length !== 2) {
    throw new Error(
      `fake-timers ${version}'s firstTimerInRange isn't the lines skipEmptyTimerScans patches ${recheck}`,
    );
  }
  return source.replace(SCAN_FROM, SCAN_TO);
}

/** fake-timers, loaded from its own source with `skipEmptyTimerScans` applied; node_modules stays as installed. */
function loadFakeTimers(): FakeTimersModule {
  const resolve = createRequire(import.meta.url).resolve;
  const file = resolve("@sinonjs/fake-timers");
  const { version } = JSON.parse(readFileSync(resolve("@sinonjs/fake-timers/package.json"), "utf8")) as {
    version: string;
  };
  const source = skipEmptyTimerScans(readFileSync(file, "utf8"), version);
  const module = { exports: {} as unknown };
  const run = compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
  run(module.exports, createRequire(file), module, file, path.dirname(file));
  return module.exports as FakeTimersModule;
}

/** The fake-timers the clock uses, patched. Exported for tests. */
export const FakeTimers = loadFakeTimers();

/**
 * Real timer functions, captured when this module loads (before the clock is faked and Node's globals are hidden), for
 * the harness's own use: the import barrier, `window.postMessage` (dom.ts) and IndexedDB's scheduler (storage.ts).
 */
export const realTimers = { setTimeout, clearTimeout, setImmediate };

export interface VirtualClock {
  /** Virtual epoch milliseconds. */
  now(): number;
  /** Fires every timer due in the next `ms` virtual milliseconds, in order, then returns. */
  advance(ms: number): Promise<void>;
  /**
   * Advances to `endMs` as `advance` does, but in steps: to each moment a timer is due, firing every timer due then
   * (exactly as `advance` would), and calling `stop` after each step. Stops right there, virtual time staying at that
   * moment, when `stop` returns true; `stop` is also called once at `endMs`. Returns whether it stopped.
   */
  advanceUntil(endMs: number, stop: () => boolean): Promise<boolean>;
}

/** A string timer handler is code, which a browser evaluates in the global scope: an indirect eval. */
// biome-ignore lint/security/noGlobalEval: evaluating a player's string handler is the browser behaviour reproduced
const evaluateGlobally: (code: string) => unknown = globalThis.eval;

/**
 * A timer's delay as Chromium takes it (#80): the timeout is a WebIDL `long` (ToNumber, then ToInt32: truncated, NaN
 * and ±Infinity are 0, and it wraps modulo 2^32), and HTML's timer steps make a negative one 0; like WebIDL, a BigInt or
 * a Symbol throws a TypeError. fake-timers read some delays differently: a non-number `setTimeout` delay with
 * `parseInt(x, 10)` (fake-timers-src.js:1287; `"1e3"` was 1 ms, `"0x10"` 0), a number as `parseInt(String(x))` (:1336;
 * `1e-7` was 1 ms), any delay over 2^31 − 1 as 1 ms (:1293, :1299), and `setInterval`'s delay with `parseInt` (:2012),
 * which made `setInterval(fn)`, `"x"`, NaN and ±Infinity NaN intervals.
 */
export function browserDelay(timeout: unknown): number {
  return Math.max(0, +(timeout as number) | 0);
}

/** The Electron in Steam's build (`vendor/bitburner-src/package-lock.json`), whose Chromium the timer model follows. */
export const STEAM_ELECTRON = "41.4.0";

/**
 * Chromium's timer nesting, as in Chromium 146.0.7680.216 (Electron 41.4.0),
 * `third_party/blink/renderer/core/scheduler/dom_timer.cc`: a timer's nesting level is one more than the level of the
 * timer task that set it (0 outside a timer task), and a timer under 4 ms whose level is over 6 waits 4 ms. Each firing
 * of an interval nests one level deeper. This is `kSpecCompliantMaxTimerNestingLevel`.
 */
export const MAX_TIMER_NESTING_LEVEL = 6;
/** The delay a deeply nested short timer waits instead: `kMinimumInterval` in `dom_timer.cc`. */
export const MIN_NESTED_TIMER_MS = 4;

/** The delay of a timer at nesting level `level`. */
export function nestedDelay(delay: number, level: number): number {
  return level > MAX_TIMER_NESTING_LEVEL && delay < MIN_NESTED_TIMER_MS ? MIN_NESTED_TIMER_MS : delay;
}

/**
 * The nesting level of the timer task running now: in a browser a timer task's microtasks run inside it, so they share
 * its level. 0 outside a timer task.
 */
let runningLevel = 0;

/**
 * Starts a task that isn't a timer's, at nesting level 0, as a browser does: the clock calls it between timers, and the
 * host calls it where other real tasks begin (a script module's import settling, `postMessage`, IndexedDB's steps, an
 * animation frame).
 */
export function beginTask(): void {
  runningLevel = 0;
}

/**
 * Timer callbacks run as a browser runs them:
 * - with `this` set to the window; fake-timers passes `null`. A string handler is evaluated, as code. The game relies
 *   on it: `Engine.start` is passed bare to setTimeout and assigns `this.isRunning`.
 * - an exception a callback throws is reported as uncaught and the clock carries on; fake-timers would rethrow it out
 *   of `advance`.
 * - after a delay taken as Chromium takes it (`browserDelay`), clamped as Chromium clamps nested timers
 *   (`nestedDelay`). A short interval repeats every 4 ms from the firing that takes its level to 7, as Chromium's does
 *   (`DOMTimer::Fired`). One difference remains: fake-timers makes a 0 ms timer set while the clock is advancing (from a
 *   timer, or work between timers: fake-timers' "during a tick") wait 1 ms (fake-timers-src.js:1336), where Chromium
 *   runs it at once; virtual time couldn't move through a chain of them otherwise.
 * - `clearTimeout` and `clearInterval` clear either kind, as in a browser, including an interval that moved to 4 ms,
 *   by its handle or the handle's number.
 */
function callTimersAsABrowserDoes(): void {
  type TimerFunction = (...args: unknown[]) => unknown;
  const timers = globalThis as unknown as Record<
    "setTimeout" | "setInterval" | "clearTimeout" | "clearInterval",
    TimerFunction
  >;
  const fake = {
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    clearTimeout: timers.clearTimeout,
    clearInterval: timers.clearInterval,
  };
  /**
   * An interval that moved to 4 ms: the number of the handle the script holds → fake-timers' current handle. Keyed by
   * number because fake-timers clears by `Number(handle)` (fake-timers-src.js:1581), so a script may too.
   */
  const moved = new Map<number, unknown>();
  const callbackFor = (handler: unknown, args: unknown[]) => {
    const run = typeof handler === "function" ? handler : () => evaluateGlobally(String(handler));
    return () => {
      try {
        run.apply(globalThis.window ?? globalThis, args);
      } catch (error) {
        reportUncaughtException(error);
      }
    };
  };
  timers.setTimeout = (handler: unknown, timeout?: unknown, ...args: unknown[]) => {
    const level = runningLevel + 1;
    const delay = nestedDelay(browserDelay(timeout), level);
    const callback = callbackFor(handler, args);
    return fake.setTimeout(() => {
      runningLevel = level;
      callback();
    }, delay);
  };

  timers.setInterval = (handler: unknown, timeout?: unknown, ...args: unknown[]) => {
    let level = runningLevel + 1;
    let delay = nestedDelay(browserDelay(timeout), level);
    const callback = callbackFor(handler, args);
    let handle: unknown;
    const fire = () => {
      // The callback runs at the interval's level; the firing nests the next one deeper (DOMTimer::Fired).
      runningLevel = level;
      level += 1;
      if (level === MAX_TIMER_NESTING_LEVEL + 1 && delay < MIN_NESTED_TIMER_MS) {
        delay = MIN_NESTED_TIMER_MS;
        fake.clearInterval(moved.get(Number(handle)) ?? handle);
        moved.set(Number(handle), fake.setInterval(fire, delay));
      }
      callback();
    };
    handle = fake.setInterval(fire, delay);
    return handle;
  };

  for (const name of ["clearTimeout", "clearInterval"] as const) {
    timers[name] = (handle: unknown) => {
      const current = moved.get(Number(handle));
      moved.delete(Number(handle));
      return fake[name](current ?? handle);
    };
  }
}

/**
 * Fakes timers, Date and performance from `epochMs`. Microtasks, nextTick and setImmediate stay real, so promises
 * and I/O still work. Window's copies follow these globals (installDom), so both access paths are virtual.
 *
 * `betweenTimers` is how the clock yields to the real event loop after each timer it fires while advancing. It
 * receives the continuation and must run it on a real macrotask, possibly later: the import barrier uses it to hold
 * virtual time while a script module is still loading.
 */
export function installClock(epochMs: number, betweenTimers?: (continueTick: () => void) => void): VirtualClock {
  // This relies on a fake-timers internal (pinned at `FAKE_TIMERS_VERSION`): `withGlobal` captures
  // `originalSetTimeout = _global.setImmediate || _global.setTimeout` (fake-timers-src.js:1748), and tickAsync yields
  // through it after every timer it fires (:2232). Lend it `betweenTimers` for that moment only; the real setImmediate
  // stays installed for everyone else. If an upgrade moves that capture, the test "a script started in the middle of
  // an advance begins at the same virtual time, however slow its import" fails.
  // The lent function also begins a fresh task (nesting level 0) once the timer's follow-on work is done, so the next
  // timer, or a request, isn't taken for a nested one.
  const realSetImmediate = globalThis.setImmediate;
  const yieldBetween = betweenTimers ?? ((continueTick: () => void) => void realSetImmediate(continueTick));
  globalThis.setImmediate = ((continueTick: () => void) =>
    yieldBetween(() => {
      beginTask();
      continueTick();
    })) as unknown as typeof setImmediate;
  let clock: ReturnType<ReturnType<typeof FakeTimers.withGlobal>["install"]>;
  try {
    clock = FakeTimers.withGlobal(globalThis).install({
      now: epochMs,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
      loopLimit: 1e9,
    });
  } finally {
    globalThis.setImmediate = realSetImmediate;
  }
  callTimersAsABrowserDoes();
  return {
    now: () => clock.now,
    advance: async (ms) => {
      await clock.tickAsync(ms);
    },
    advanceUntil: async (endMs, stop) => {
      // fake-timers has no "tick, but stop when…". Each step is a tickAsync to the next moment a timer is due, which
      // keeps tickAsync's semantics exactly (a 0 ms timer set during a tick is due 1 ms later, for one). That moment
      // comes from its timer heap, an internal (pinned at `FAKE_TIMERS_VERSION`); test/run-until.test.ts "without a stop condition it
      // is advance…" fails if it moves.
      for (;;) {
        const heap = (clock as unknown as { timerHeap?: { peek(): { callAt: number } | undefined } }).timerHeap;
        if (!heap) throw new Error("fake-timers' timerHeap is gone: advanceUntil needs updating (clock.ts)");
        const next = heap.peek()?.callAt;
        const to = next === undefined ? endMs : Math.min(next, endMs);
        await clock.tickAsync(to - clock.now);
        if (stop()) return true;
        if (to === endMs) return false;
      }
    },
  };
}
