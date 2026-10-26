/**
 * Where the bridge reads time and schedules its timeouts (architecture R11). Live, it's the system clock; under the
 * simulator the brain passes one that follows virtual time (#90), so every timestamp is reproducible.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Opaque: whatever the clock hands out. */
export type TimerHandle = unknown;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
