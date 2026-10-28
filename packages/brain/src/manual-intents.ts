// The owner's manual intents (#141, owner decision 36): one-shot actions queued from the dashboard, kept in the store so
// they survive restarts of the brain, until the game shows each done. Any action may be queued, irreversible ones too,
// with no confirmation: the project drives itself. With it, the note of when an intent that resets the game went out.
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

export const RESET_SENT_SETTING = "intents.resetSent";

/**
 * When the first queued intent that resets the game went out (#164, #175): its id, and the connected Agent's reset
 * time then, from the slow snapshot. A slow snapshot with another time says it's done.
 */
export interface ResetSentNote {
  id: string;
  field: "lastAugReset" | "lastNodeReset";
  resetAt: number;
}

/**
 * The note kept with the queue, so a restarted brain still knows (#175); null for none. As for the queue, a value the
 * brain didn't write fails.
 */
export function readResetSentNote(store: TelemetryStore): ResetSentNote | null {
  const value = store.getSetting(RESET_SENT_SETTING);
  if (value === null) return null;
  let note: Partial<ResetSentNote> | null;
  try {
    note = JSON.parse(value) as Partial<ResetSentNote> | null;
  } catch {
    throw new Error(`the store's ${RESET_SENT_SETTING} isn't JSON`);
  }
  if (
    typeof note?.id !== "string" ||
    (note.field !== "lastAugReset" && note.field !== "lastNodeReset") ||
    typeof note.resetAt !== "number"
  ) {
    throw new Error(`the store's ${RESET_SENT_SETTING} isn't a note the brain wrote`);
  }
  return { id: note.id, field: note.field, resetAt: note.resetAt };
}

export function writeResetSentNote(store: TelemetryStore, note: ResetSentNote | null): void {
  if (note === null) store.deleteSetting(RESET_SENT_SETTING);
  else store.setSetting(RESET_SENT_SETTING, JSON.stringify(note));
}
