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
 */
export function installClock(epochMs: number): VirtualClock {
  const clock = FakeTimers.withGlobal(globalThis).install({
    now: epochMs,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    loopLimit: 1e9,
  });
  callTimersWithWindowAsThis();
  return {
    now: () => clock.now,
    advance: async (ms) => {
      await clock.tickAsync(ms);
    },
  };
}
