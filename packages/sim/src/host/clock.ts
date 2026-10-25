import FakeTimers from "@sinonjs/fake-timers";
import { reportUncaughtException } from "./parity/errors.ts";

/** Real timer functions, captured before the clock is faked, for the harness's own use (the import barrier, #26). */
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
  // This relies on a fake-timers internal (pinned at 15.4.0): `withGlobal` captures
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
      // comes from its timer heap, an internal (pinned at 15.4.0); test/run-until.test.ts "without a stop condition it
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
