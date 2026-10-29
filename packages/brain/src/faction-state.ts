// The faction state as the brain reads it (#197): the slow snapshot's reading, and the events a reading's problem is
// stored as (record-channel-events.ts), for the dashboard (its panel and alert) and the run report.
import { factionReadingOf } from "@bitburner-agent/core";
/** A slow snapshot whose faction state couldn't be read (#197), stored when the problem changes: it and the backend. */
export const FACTION_STATE_UNREAD_EVENT_KIND = "factionStateUnread";
/** The faction state read again after a `factionStateUnread` (#197): the backend. */
export const FACTION_STATE_READ_EVENT_KIND = "factionStateRead";
/** The problem when a slow snapshot carries no faction state the brain can read (an older Agent, or a bug). */
export const NO_FACTION_READING = "the slow snapshot carries no faction state the brain can read";

/**
 * The slow snapshot's faction state problem (#197): the Agent's, or `NO_FACTION_READING` where it carries no reading;
 * null where it was read. With the backend, where it says one.
 */
export function factionStateProblemOf(data: unknown): { backend: string | null; problem: string | null } {
  const reading = factionReadingOf(data);
  return reading === null
    ? { backend: null, problem: NO_FACTION_READING }
    : { backend: reading.backend, problem: reading.problem };
}
