// The owner's manual intents (#141, owner decision 36): one-shot actions queued from the dashboard, kept in the store so
// they survive restarts of the brain, until the game shows each done. Any action may be queued, irreversible ones too,
// with no confirmation: the project drives itself.
import { type Intent, parseIntentRequest } from "@bitburner-agent/core";
import type { TelemetryStore } from "./telemetry-store.ts";

export const MANUAL_INTENTS_SETTING = "intents.manual";

/** The queue, in the order added. A value the brain didn't write fails, rather than guess. */
export function readManualIntents(store: TelemetryStore): Intent[] {
  const value = store.getSetting(MANUAL_INTENTS_SETTING);
  if (value === null) return [];
  let requests: unknown;
  try {
    requests = JSON.parse(value);
  } catch {
    throw new Error(`the store's ${MANUAL_INTENTS_SETTING} isn't JSON`);
  }
  if (!Array.isArray(requests)) throw new Error(`the store's ${MANUAL_INTENTS_SETTING} isn't a list`);
  return requests.map((request) => {
    const parsed = parseIntentRequest(request);
    if (!parsed.ok)
      throw new Error(`the store's ${MANUAL_INTENTS_SETTING} has an intent that isn't valid: ${parsed.reason}`);
    return parsed.message;
  });
}

export function writeManualIntents(store: TelemetryStore, intents: Intent[]): void {
  store.setSetting(MANUAL_INTENTS_SETTING, JSON.stringify(intents.map(({ action, args }) => ({ action, args }))));
}
