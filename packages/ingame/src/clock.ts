// The page's two clocks (#251). Scheduling, waits and landings are timed on the monotonic one, `performance.now()`:
// the PC's wall clock, `Date.now()`, steps when the OS syncs it (run #3: Windows Time stepped it +2,678 ms, and the
// batcher counted 1,615 desyncs). The game itself never times on `Date`: every `hack`, `grow`, `weaken` and `asleep`
// ends on a `setTimeout` (NetscriptHelpers.tsx:419-432, NetscriptFunctions.ts:264), which runs on the browser's
// monotonic clock. Every script shares one `performance` and its time origin: a script is a module imported into the
// page itself (NetscriptJSEvaluator.ts:210-211), its `main` called there (NetscriptWorker.ts:55-66), no Web Worker of
// its own; so a time the Agent or the batcher hands a worker means the same moment there. Not across a reload, which
// starts the clock again at 0: the scripts handed one (all temporary) don't outlive it, nor do the ports.
// `Date.now()` is kept for stamps the brain reads (a snapshot's or a health's time, a short's), which it lines up
// with its own clock and with the game's (`Player.lastAugReset`), and for anything that outlives a reload.

/** The page's monotonic clock, ms since it loaded: every schedule, wait, deadline and landing (#251). */
export function monotonicMs(): number {
  return performance.now();
}

/**
 * A moment on the monotonic clock as the wall clock (`Date.now()`) reads it now, for a stamp the brain reads: a step
 * between that moment and now moves it by the step, as it moves every wall-clock stamp.
 */
export function wallClockMsOf(atMonotonicMs: number): number {
  return Date.now() + (atMonotonicMs - performance.now());
}
