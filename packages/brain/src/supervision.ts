// The supervision switch (architecture §10.2; #93, #94), kept in the store's settings so it survives restarts of the
// brain. The dashboard sets it; the supervisor (#94) reads it before every relaunch, and records a give-up after too
// many relaunches. While paused, nothing is relaunched; unpausing also clears a give-up.
import type { TelemetryStore } from "./telemetry-store.ts";

const PAUSED_SETTING = "supervision.paused";
const GAVE_UP_AT_SETTING = "supervision.gaveUpAtMs";

export interface SupervisionSwitch {
  paused: boolean;
  /** When the supervisor gave up after too many relaunches, or null. */
  gaveUpAtMs: number | null;
}

export function readSupervisionSwitch(store: TelemetryStore): SupervisionSwitch {
  const gaveUpAt = store.getSetting(GAVE_UP_AT_SETTING);
  return {
    paused: store.getSetting(PAUSED_SETTING) === "true",
    gaveUpAtMs: gaveUpAt === null || gaveUpAt === "" ? null : Number(gaveUpAt),
  };
}

/** The dashboard's switch. Unpausing also clears a give-up, so the supervisor starts afresh. */
export function setSupervisionPaused(store: TelemetryStore, paused: boolean): void {
  store.setSetting(PAUSED_SETTING, String(paused));
  if (!paused) store.setSetting(GAVE_UP_AT_SETTING, "");
}

/** The supervisor's: it stopped after too many relaunches, until the owner unpauses. */
export function recordSupervisionGaveUp(store: TelemetryStore, atMs: number): void {
  store.setSetting(GAVE_UP_AT_SETTING, String(atMs));
}
