import FakeTimers from "@sinonjs/fake-timers";

/** Real timer functions, captured before the clock is faked, for the harness's own use (the import barrier, #26). */
export const realTimers = { setTimeout, clearTimeout, setImmediate };

export interface VirtualClock {
  /** Virtual epoch milliseconds. */
  now(): number;
  /** Fires every timer due in the next `ms` virtual milliseconds, in order, then returns. */
  advance(ms: number): Promise<void>;
}

/**
 * Browsers call timer callbacks with `this` set to the window; fake-timers calls them with `null`. The game relies
 * on the browser behaviour: `Engine.start` is passed bare to setTimeout and assigns `this.isRunning`.
 */
function callTimersWithWindowAsThis(): void {
  const timers = globalThis as unknown as Record<"setTimeout" | "setInterval", (...args: unknown[]) => unknown>;
  for (const name of ["setTimeout", "setInterval"] as const) {
    const faked = timers[name];
    timers[name] = (handler: unknown, timeout?: unknown, ...args: unknown[]) => {
      const callback =
        typeof handler === "function"
          ? (...callbackArgs: unknown[]) => handler.apply(globalThis.window ?? globalThis, callbackArgs)
          : handler;
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
  // fake-timers captures `setImmediate` when the clock is created and yields through it between timers in
  // tickAsync. Lend it `betweenTimers` for that moment only; the real setImmediate stays installed for everyone else.
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
  callTimersWithWindowAsThis();
  return {
    now: () => clock.now,
    advance: async (ms) => {
      await clock.tickAsync(ms);
    },
  };
}
