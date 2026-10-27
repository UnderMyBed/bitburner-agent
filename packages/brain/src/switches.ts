// The dashboard's switches (#93, #134, #136): each a setting in the store, "true" or "false", so it survives restarts
// of the brain.
import type { TelemetryStore } from "./telemetry-store.ts";

/** The switch's value, or `whenUnset`. Fails on a value it didn't write, rather than guess. */
export function readSwitch(store: TelemetryStore, settingName: string, whenUnset: boolean): boolean {
  const value = store.getSetting(settingName);
  if (value === null) return whenUnset;
  if (value !== "true" && value !== "false") {
    throw new Error(`the ${settingName} setting is ${JSON.stringify(value)}, not true or false`);
  }
  return value === "true";
}

export function writeSwitch(store: TelemetryStore, settingName: string, value: boolean): void {
  store.setSetting(settingName, String(value));
}
