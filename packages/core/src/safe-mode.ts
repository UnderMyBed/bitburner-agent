/**
 * Safe mode (#160, architecture §5.4): with the brain gone, the Agent keeps converging on the last desired state it
 * had, minus its intents, until its `ttlMs` passes. It keeps that state in `DESIRED_STATE_FILE` on home, in this
 * format, so the next Agent (after a reload, an install, a new deployment) has it too. In-game code bundles this.
 */
import { type DesiredState, type ParsedMessage, parseHackLoop } from "./control-protocol.ts";
import { parseWork, type Work } from "./work.ts";

/** What's kept: the activities of the last desired state, never its intents, and when it stops counting. */
export interface SafeModeState {
  hackLoop: DesiredState["hackLoop"];
  /** The work wanted, or null: the brain didn't manage it, so neither does safe mode. */
  work: Work | null;
  /** The brain's `ttlMs`: kept this long after `heardAtMs`. */
  ttlMs: number;
  /** When the Agent was last connected to the brain that sent it: the game's `Date.now()`. */
  heardAtMs: number;
  /** The game's `lastAugReset` (the slow snapshot's) when it was kept: a reset since makes it stale. */
  lastAugReset: number;
}

/** The file's text: its known fields, in a fixed order. */
export function encodeSafeModeState(state: SafeModeState): string {
  const { hackLoop, work, ttlMs, heardAtMs, lastAugReset } = state;
  return JSON.stringify({ hackLoop, work, ttlMs, heardAtMs, lastAugReset });
}

/** The file read back: its known fields only, or why it isn't valid (an older format, or someone's edit). */
export function parseSafeModeState(text: string): ParsedMessage<SafeModeState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not a JSON object" };
  }
  const fields = parsed as Record<string, unknown>;
  const hackLoop = parseHackLoop(fields.hackLoop);
  if (!hackLoop.ok) return hackLoop;
  const work = parseWork(fields.work);
  if (!work.ok) return work;
  const { ttlMs, heardAtMs, lastAugReset } = fields;
  if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) < 1)
    return { ok: false, reason: "ttlMs isn't a positive integer" };
  if (typeof heardAtMs !== "number" || !Number.isFinite(heardAtMs) || heardAtMs < 0) {
    return { ok: false, reason: "no valid heardAtMs" };
  }
  if (typeof lastAugReset !== "number" || !Number.isFinite(lastAugReset)) {
    return { ok: false, reason: "no valid lastAugReset" };
  }
  return {
    ok: true,
    message: {
      hackLoop: hackLoop.message,
      work: work.message,
      ttlMs: ttlMs as number,
      heardAtMs,
      lastAugReset,
    },
  };
}
