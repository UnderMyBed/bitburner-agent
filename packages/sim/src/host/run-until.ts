// Runs that stop on a condition (`runUntil`), and the watch for BitNode entries that every timer and request gets.
import type { EngineApi } from "../engine/api.ts";
import type { ComparisonOp, RunUntilParams, RunUntilResult, StopCondition } from "../protocol.ts";
import type { VirtualClock } from "./clock.ts";
import { gameEvent, logEnd, stopEventSince } from "./events.ts";

/** Records a `bitnodeDestroyed` or `bitnodeFlumed` event when the game has entered a BitNode since the last call. */
export function watchBitNodeEntries(engine: EngineApi): () => void {
  return () => {
    const entry = engine.bitNodeEntry();
    if (!entry) return;
    gameEvent(
      entry.destroyed
        ? { type: "bitnodeDestroyed", destroyed: entry.from, entered: entry.to }
        : { type: "bitnodeFlumed", left: entry.from, entered: entry.to },
    );
  };
}

const compare: Record<ComparisonOp, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  ">=": (a, b) => a >= b,
  ">": (a, b) => a > b,
};

/** Script filenames seen running during any run, so `scriptExited` can tell "has exited" from "hasn't started". */
const seenRunning = new Set<string>();

const DEFAULT_STALLED_LOOP_MS = 10_000;

/**
 * Advances until `ms` of virtual time have passed, or until a stop condition holds: checked at the start, then after
 * each moment timers fire, so when a run stops doesn't depend on how it's driven. Arrivals at the BitVerse are handled
 * per `onBitVerse` at the same moments. Rejects if the game goes into recovery mode, or its loop stalls.
 */
export async function runUntil(
  { ms, stopWhen = [], onBitVerse, eventsFrom = logEnd(), stalledLoopMs = DEFAULT_STALLED_LOOP_MS }: RunUntilParams,
  { clock, engine, watch }: { clock: VirtualClock; engine: EngineApi; watch: () => void },
): Promise<RunUntilResult> {
  const holds = (condition: StopCondition): boolean => {
    if ("event" in condition) return stopEventSince(condition.event, eventsFrom);
    if ("scriptExited" in condition) {
      const state = engine.scriptState(condition.scriptExited);
      if (state === "running") seenRunning.add(condition.scriptExited);
      return state === "finished" || (state === "unknown" && seenRunning.has(condition.scriptExited));
    }
    const { field, op, value } = condition.summary;
    return compare[op](engine.gameSummary()[field], value);
  };
  let stoppedBy: RunUntilResult["stoppedBy"] = null;
  const check = (): boolean => {
    // The watch runs after every timer anyway; this covers the state before the first one, and after an entry below.
    watch();
    if (engine.page() === "Recovery") throw new Error("the game went into recovery mode (a BitNode entry failed?)");
    if (clock.now() - engine.engineLastUpdate() > stalledLoopMs) {
      throw new Error(
        `the game loop stopped ${clock.now() - engine.engineLastUpdate()} virtual ms ago (an uncaught error in it?)`,
      );
    }
    if (onBitVerse && engine.page() === "BitVerse") {
      if (onBitVerse === "stop") {
        stoppedBy = "bitverse";
        return true;
      }
      engine.enterFromBitVerse(onBitVerse.enter);
      watch();
    }
    const index = stopWhen.findIndex(holds);
    if (index < 0) return false;
    stoppedBy = index;
    return true;
  };
  if (!check()) await clock.advanceUntil(clock.now() + ms, check);
  return { now: clock.now(), stoppedBy };
}
