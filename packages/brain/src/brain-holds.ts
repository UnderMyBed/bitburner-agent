// The brain's event loop held (#309): whatever holds it holds every snapshot arriving meanwhile, received late (a
// delivery lag). The live run of 2026-11-08 had up to 0.7 s of it, the dashboard's status sorting the store's rows.
// Two cheap readings, logged at most once a minute, and only when something was held: the dashboard's statuses built
// slower than `SLOW_DASHBOARD_STATUS_MS` (./dashboard/server.ts), counted with the longest; and Node's own event-loop
// delay (`perf_hooks.monitorEventLoopDelay`), whatever held it, its longest over `BRAIN_HELD_MS`. So the next delivery
// lag the run report finds has its cause, or at least its size, in the brain's log at the same minute.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { SLOW_DASHBOARD_STATUS_MS } from "./dashboard/server.ts";

/** An event-loop delay longer than this is logged: a snapshot arriving then is received this late at least. */
export const BRAIN_HELD_MS = 200;
/** Each reading's minute: at most one line a minute, with what the minute held. */
export const BRAIN_HOLDS_EVERY_MS = 60_000;
/** How often Node samples the delay: a hold shorter than this can go unseen, which none that matters is. */
const DELAY_RESOLUTION_MS = 20;

/** What the brain reads of the event loop's delay (`IntervalHistogram`'s, in nanoseconds), so a test can stand in. */
export interface LoopDelay {
  readonly max: number;
  percentile(percentile: number): number;
  reset(): void;
}

const NS_PER_MS = 1_000_000;

/** The slow statuses and the loop's delay since the last minute's line, logged by `minute` if anything was held. */
export class BrainHolds {
  readonly #delay: LoopDelay;
  readonly #log: (line: string) => void;
  #slowStatuses = 0;
  #slowestStatusMs = 0;

  constructor({ delay, log }: { delay: LoopDelay; log: (line: string) => void }) {
    this.#delay = delay;
    this.#log = log;
  }

  /** A dashboard status built slower than `SLOW_DASHBOARD_STATUS_MS`, how long it took. */
  slowStatus(tookMs: number): void {
    this.#slowStatuses += 1;
    this.#slowestStatusMs = Math.max(this.#slowestStatusMs, tookMs);
  }

  /** The minute's line, if it held anything (also at the brain's stop, so nothing counted is lost); then afresh. */
  minute(): void {
    const longestMs = this.#delay.max / NS_PER_MS;
    const parts: string[] = [];
    if (this.#slowStatuses > 0) {
      const statuses = `${this.#slowStatuses} dashboard status${this.#slowStatuses === 1 ? "" : "es"}`;
      parts.push(
        `${statuses} built slower than ${SLOW_DASHBOARD_STATUS_MS} ms, the slowest in ${Math.round(this.#slowestStatusMs)} ms`,
      );
    }
    if (longestMs > BRAIN_HELD_MS) {
      const p99Ms = this.#delay.percentile(99) / NS_PER_MS;
      parts.push(
        `the event loop held up to ${Math.round(longestMs)} ms (99% of its waits under ${Math.round(p99Ms)} ms)`,
      );
    }
    if (parts.length > 0) {
      this.#log(`held in the last minute: ${parts.join("; ")}; every snapshot arriving meanwhile waited (#309)`);
    }
    this.#slowStatuses = 0;
    this.#slowestStatusMs = 0;
    this.#delay.reset();
  }
}

/**
 * Watches the brain's event loop (#309): Node's delay histogram enabled, a line a minute (on a timer that doesn't
 * keep the process alive), and `stop`, which logs what's left and stops both.
 */
export function watchBrainHolds(log: (line: string) => void): { holds: BrainHolds; stop(): void } {
  const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  histogram.enable();
  const holds = new BrainHolds({ delay: histogram, log });
  const timer = setInterval(() => holds.minute(), BRAIN_HOLDS_EVERY_MS);
  timer.unref();
  return {
    holds,
    stop() {
      clearInterval(timer);
      holds.minute();
      histogram.disable();
    },
  };
}
