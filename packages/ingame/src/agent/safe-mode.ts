// The Agent's safe mode (#160, architecture §5.4): with no brain, it keeps converging the hack loop and the work on the
// last desired state a brain sent, never its intents, until the state's `ttlMs` passes. A connected brain's word comes
// first: while connected, the Agent acts only on what that brain sends (#134).
// - Kept in agent/desired-state.json on home (core's `SafeModeState`), so the next Agent has it: after a reload, an
//   install's restart, a new deployment. Written when a state arrives, every 30 rounds (60 s) while connected to the
//   brain that sent it, and at the disconnect, with its time. `ns.write` replaces the whole text at once, and costs no
//   RAM; nor does `ns.read` (RamCostGenerator.ts:621-625).
// - The clock runs from when the Agent was last connected to the brain that sent it: a brain that connects and sends
//   nothing (one that holds) vouches for nothing.
// - Dropped `ttlMs` after that, and once the slow snapshot's `lastAugReset` isn't the one it was kept with: a reset
//   (an install, a new BitNode) may have made its target unhackable, its work gone. A reset always means a new Agent,
//   so only a state from the file is checked, and it waits for the check. `getResetInfo` itself would cost the Agent
//   1 GB, so the check takes the slow worker's.
// - The file never holds a state older than the last one heard: one that can't be stamped yet empties it.
import {
  DESIRED_STATE_FILE,
  type DesiredState,
  encodeSafeModeState,
  parseSafeModeState,
  type SafeModeState,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog } from "./activity.ts";

/** Rounds between writes while connected to the brain that sent it, to move `heardAtMs` on: 60 s. */
const ROUNDS_BETWEEN_WRITES = 30;

/** What safe mode converges on: the activities of the last desired state. */
export type SafeModeActivities = Pick<SafeModeState, "hackLoop" | "work">;

/** "12 h", "5 min" or "90 s", for the log. */
const describeDuration = (ms: number): string =>
  ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1_000} s`;

/** A kept state; `lastAugReset` null until this Agent knows it, for a state it heard before its first slow snapshot. */
type Kept = Omit<SafeModeState, "lastAugReset"> & { lastAugReset: number | null };

export function createSafeMode(ns: NS) {
  const logChange = createChangeLog(ns, "safe mode");
  let kept: Kept | null = null;
  /** Its `lastAugReset` is known to be this game's: heard by this Agent, or checked against its slow snapshot. */
  let checked = false;
  /** Connected to the brain that sent it, so it still vouches for it. */
  let connectedToSender = false;
  let roundsUntilWrite = ROUNDS_BETWEEN_WRITES;

  const fileText = ns.read(DESIRED_STATE_FILE);
  if (fileText !== "") {
    const parsed = parseSafeModeState(fileText);
    if (parsed.ok) kept = parsed.message;
    else logChange(`ignored ${DESIRED_STATE_FILE}: ${parsed.reason}`);
  }

  /** Writes what's kept, if it can be stamped; else empties the file, so it never holds an older state. */
  const save = (): void => {
    roundsUntilWrite = ROUNDS_BETWEEN_WRITES;
    const lastAugReset = kept?.lastAugReset ?? null;
    const text = kept === null || lastAugReset === null ? "" : encodeSafeModeState({ ...kept, lastAugReset });
    ns.write(DESIRED_STATE_FILE, text, "w");
  };

  const drop = (why: string): void => {
    kept = null;
    connectedToSender = false;
    ns.write(DESIRED_STATE_FILE, "", "w");
    logChange(`dropped the last desired state: ${why}`);
  };

  /** A state from the file, checked against the game's last reset once the Agent knows it. */
  const checkReset = (lastAugReset: number | null): void => {
    if (kept === null || checked || lastAugReset === null) return;
    if (kept.lastAugReset === lastAugReset) checked = true;
    else drop("it's from before the game's last reset");
  };

  return {
    /** A desired state from the connected brain: kept in place of any other, its intents left out, and written. */
    heard(state: DesiredState, nowMs: number, lastAugReset: number | null): void {
      if (state.ttlMs === undefined || state.ttlMs <= 0) {
        if (kept !== null) drop("the brain's latest has no ttlMs");
        return;
      }
      kept = structuredClone({
        hackLoop: state.hackLoop,
        work: state.work ?? null,
        ttlMs: state.ttlMs,
        heardAtMs: nowMs,
        lastAugReset,
      });
      checked = true;
      connectedToSender = true;
      save();
    },

    /** Each round while connected, after its snapshots: the reset check; the clock moved on, written when due. */
    connectedRound(nowMs: number, lastAugReset: number | null): void {
      checkReset(lastAugReset);
      if (kept === null) return;
      const unstamped = kept.lastAugReset === null && lastAugReset !== null;
      if (unstamped) kept.lastAugReset = lastAugReset;
      if (!connectedToSender) {
        if (unstamped) save();
        return;
      }
      kept.heardAtMs = nowMs;
      roundsUntilWrite -= 1;
      if (unstamped || roundsUntilWrite <= 0) save();
    },

    /** The connection's gone: the clock stops here, written with its time. */
    disconnected(nowMs: number): void {
      if (kept === null || !connectedToSender) return;
      connectedToSender = false;
      kept.heardAtMs = nowMs;
      save();
    },

    /** With no brain: what to converge on now, or null (none kept, its reset not checked yet, expired, or dropped). */
    toConverge(nowMs: number, lastAugReset: number | null): SafeModeActivities | null {
      checkReset(lastAugReset);
      if (kept === null || !checked) return null;
      if (kept.lastAugReset === null && lastAugReset !== null) {
        kept.lastAugReset = lastAugReset;
        save();
      }
      const untilMs = kept.heardAtMs + kept.ttlMs;
      if (nowMs >= untilMs) {
        drop(`no brain for ${describeDuration(kept.ttlMs)}, its ttlMs`);
        return null;
      }
      logChange(
        `no brain: converging on its last desired state, without intents, until ${new Date(untilMs).toISOString()}`,
      );
      return { hackLoop: kept.hackLoop, work: kept.work };
    },

    /** A state is kept, checked or waiting for its check: rounds go on while the Agent has no brain. */
    holds: (): boolean => kept !== null,
  };
}
