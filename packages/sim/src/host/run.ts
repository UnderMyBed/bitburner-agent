// Runs that stop on a condition (`runUntil`), and the watch for BitNode entries that every timer gets.
import type { EngineApi } from "../engine/api.ts";
import type { ComparisonOp, RunUntilParams, RunUntilResult, StopCondition } from "../protocol.ts";
import type { VirtualClock } from "./clock.ts";
import { eventCount, gameEvent } from "./events.ts";

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

/**
 * Advances until `ms` of virtual time have passed, or until a stop condition holds after a timer: the clock stops at
 * that timer, so when a run stops doesn't depend on how it's driven. Arrivals at the BitVerse are handled per
 * `onBitVerse` at the same moments.
 */
export async function runUntil(
  { ms, stopWhen = [], onBitVerse }: RunUntilParams,
  { clock, engine, watch, epochMs }: { clock: VirtualClock; engine: EngineApi; watch: () => void; epochMs: number },
): Promise<RunUntilResult> {
  const eventsBefore = new Map(stopWhen.flatMap((c) => ("event" in c ? [[c.event, eventCount(c.event)]] : [])));
  const holds = (condition: StopCondition): boolean => {
    if ("event" in condition) return eventCount(condition.event) > (eventsBefore.get(condition.event) ?? 0);
    if ("scriptExited" in condition) return !engine.scriptRunning(condition.scriptExited);
    const { field, op, value } = condition.summary;
    const actual = field === "virtualMs" ? clock.now() - epochMs : engine.gameSummary()[field];
    return compare[op](actual, value);
  };
  let stoppedBy: RunUntilResult["stoppedBy"] = null;
  const check = (): boolean => {
    watch();
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
  if (!check()) await clock.runUntil(clock.now() + ms, check);
  return { now: clock.now(), stoppedBy };
}
