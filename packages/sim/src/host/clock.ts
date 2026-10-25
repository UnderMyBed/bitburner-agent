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
 * whatever their due time (the host doesn't fake `requestIdleCallback`), and an interval with no numeric delay is due
 * at NaN once it has fired (`callAt += interval`, fake-timers-src.js:1513; a script's `setInterval(fn)`; #80). Throws
 * if the version or the patched lines aren't the ones this was made for, so an upgrade can't keep the patch without a
 * re-check.
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
 * Timer callbacks run as a browser runs them:
 * - with `this` set to the window; fake-timers passes `null`. A string handler is evaluated, as code. The game relies on it: `Engine.start` is passed bare to
 *   setTimeout and assigns `this.isRunning`.
 * - an exception a callback throws is reported as uncaught and the clock carries on; fake-timers would rethrow it out
 *   of `advance`.
 */
function callTimersAsABrowserDoes(): void {
  const timers = globalThis as unknown as Record<"setTimeout" | "setInterval", (...args: unknown[]) => unknown>;
  for (const name of ["setTimeout", "setInterval"] as const) {
    const faked = timers[name];
    timers[name] = (handler: unknown, timeout?: unknown, ...args: unknown[]) => {
      const run = typeof handler === "function" ? handler : () => evaluateGlobally(String(handler));
      const callback = (...callbackArgs: unknown[]) => {
        try {
          run.apply(globalThis.window ?? globalThis, callbackArgs);
        } catch (error) {
          reportUncaughtException(error);
        }
      };
      return faked(callback, timeout, ...args);
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
  const realSetImmediate = globalThis.setImmediate;
  if (betweenTimers) globalThis.setImmediate = betweenTimers as unknown as typeof setImmediate;
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
