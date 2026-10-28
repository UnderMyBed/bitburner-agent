// The supervision switch (architecture §10.2; #93, #94), kept in the store's settings so it survives restarts of the
// brain. The dashboard sets it; the supervisor (#94) reads it with `readSupervisionSwitch` before every launch, records
// a give-up with `recordSupervisionGaveUp` after too many (or after checks that kept failing), and records each launch as a `relaunch` event. While paused,
// nothing is launched; unpausing also clears a give-up.
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

const PAUSED_SETTING = "supervision.paused";
const GAVE_UP_AT_SETTING = "supervision.gaveUpAtMs";

/**
 * The event kind the supervisor records for each launch of the game it makes, with `{ cause }` as detail (#94's causes:
 * `notRunning`, `silent`). The dashboard lists the newest.
 */
export const RELAUNCH_EVENT_KIND = "relaunch";
/**
 * The event kind the supervisor records as it gives up, with its cause as detail: `{ cause, launchesInLastHour }` for
 * one launch too many in the hour, or `{ failedChecksInARow, failure }` for checks that kept failing.
 */
export const SUPERVISION_GAVE_UP_EVENT_KIND = "supervisionGaveUp";

export interface SupervisionSwitch {
  paused: boolean;
  /** When the supervisor gave up (too many launches, or checks that kept failing), or null. */
  gaveUpAtMs: number | null;
}

/** Fails on a value it didn't write, rather than guess whether supervision is paused. */
export function readSupervisionSwitch(store: TelemetryStore): SupervisionSwitch {
  const paused = readSwitch(store, PAUSED_SETTING, false);
  const gaveUpAt = store.getSetting(GAVE_UP_AT_SETTING);
  if (gaveUpAt !== null && !/^\d+$/.test(gaveUpAt)) {
    throw new Error(`the ${GAVE_UP_AT_SETTING} setting is ${JSON.stringify(gaveUpAt)}, not a time`);
  }
  return { paused, gaveUpAtMs: gaveUpAt === null ? null : Number(gaveUpAt) };
}

/** The dashboard's switch. Unpausing also clears a give-up, so the supervisor starts afresh. */
export function setSupervisionPaused(store: TelemetryStore, paused: boolean): void {
  writeSwitch(store, PAUSED_SETTING, paused);
  if (!paused) store.deleteSetting(GAVE_UP_AT_SETTING);
}

/** The supervisor's: it stopped (too many launches, or checks that kept failing), until the owner resumes it. */
export function recordSupervisionGaveUp(store: TelemetryStore, atMs: number): void {
  store.setSetting(GAVE_UP_AT_SETTING, String(Math.round(atMs)));
}
