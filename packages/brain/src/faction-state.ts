// The faction state as the brain reads it (#197): each slow snapshot's reading, what it is, and the events and the
// rule that make an unread one loud, for the dashboard (its panel and alert) and the run report.
// - A slow snapshot from an older Agent has no reading: it wasn't read by this Agent, which is information, never a
//   problem (a redeploy's old Agent sends one).
// - A skipped reading (no sidebar on the page) isn't a problem either; one read, but with the page not put back as
//   found, is read.
// - Unread: an event and a log line each time the problem changes (record-channel-events.ts); the alert and the run
//   report's failure only once `FACTION_STATE_UNREAD_AFTER` slow snapshots in a row are unread, as an intent is stuck
//   only after its tries (dashboard/alerts.ts). A single miss (a dialog flood, the owner acting mid-read) isn't one.
import { type FactionReadingKind, factionReadingKind, factionReadingOf } from "@bitburner-agent/core";

/** A slow snapshot whose faction state couldn't be read (#197), stored when the problem changes: it and the backend. */
export const FACTION_STATE_UNREAD_EVENT_KIND = "factionStateUnread";
/** The faction state read again after a `factionStateUnread` (#197): the backend. */
export const FACTION_STATE_READ_EVENT_KIND = "factionStateRead";
/** Unread slow snapshots in a row (about 3 minutes) before the alert holds and the run report fails (#197). */
export const FACTION_STATE_UNREAD_AFTER = 3;

/** What a slow snapshot's faction state is: its reading's kind, or `absent`, from an older Agent. */
export interface SlowFactionStatus {
  kind: FactionReadingKind | "absent";
  backend: string | null;
  /** The reading's problem, or why it was skipped; null where it's neither. */
  problem: string | null;
}

/** The problem for a slow snapshot whose `factions` isn't as the Agent writes it: a bug, so unread. */
export const MALFORMED_FACTION_READING = "the slow snapshot's faction state isn't well formed";

export function factionStatusOf(data: unknown): SlowFactionStatus {
  const reading = factionReadingOf(data);
  if (reading === null) {
    const carried = typeof data === "object" && data !== null && "factions" in data;
    return carried
      ? { kind: "unread", backend: null, problem: MALFORMED_FACTION_READING }
      : { kind: "absent", backend: null, problem: null };
  }
  const kind = factionReadingKind(reading);
  return { kind, backend: reading.backend, problem: kind === "skipped" ? (reading.skipped ?? null) : reading.problem };
}
