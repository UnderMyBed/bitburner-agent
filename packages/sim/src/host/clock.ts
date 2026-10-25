import FakeTimers from "@sinonjs/fake-timers";

/** Real timer functions, captured before the clock is faked, for the harness's own use. */
export const realTimers = { setTimeout, clearTimeout, setImmediate };

export interface VirtualClock {
  /** Virtual epoch milliseconds. */
  now(): number;
  /** Fires every timer due in the next `ms` virtual milliseconds, in order, then returns. */
  advance(ms: number): Promise<void>;
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
  return {
    now: () => clock.now,
    advance: async (ms) => {
      await clock.tickAsync(ms);
    },
  };
}
