// The dashboard's alerts (#93, architecture §7): rules over what the store holds, evaluated whenever status is read, so
// there's no alert state to keep in sync. The stall alert (no progress on the route's critical path) needs a route, so
// it comes with the planner (M4).
import type { IntentOutcome } from "@bitburner-agent/core";

/** No fast snapshot (the heartbeat, every 2 s) for longer than this, with the brain up, is `agentSilent`. */
export const AGENT_SILENT_AFTER_MS = 60_000;
/** An intent tried this many times and still not done is `intentStuck` (#141): 5 tries are 2 minutes. */
export const INTENT_STUCK_AFTER_TRIES = 5;

/** How much of a blocking dialog's text the alert quotes. */
const BLOCKING_DIALOG_QUOTE_LENGTH = 200;

export type AlertName =
  | "agentSilent"
  | "versionDrift"
  | "deployFailed"
  | "supervisionGaveUp"
  | "dialogBlocking"
  | "intentStuck";

export interface Alert {
  name: AlertName;
  /**
   * Since when: for `agentSilent`, when the Agent was last heard from (or the brain's start); for `intentStuck` and
   * `dialogBlocking`, the newest fast snapshot that shows it; for the others, the event or give-up that raised it.
   */
  sinceMs: number;
  detail: string;
}

/** What the rules look at, read from the store. Everything "since the brain started" is about this run of the brain. */
export interface AlertFacts {
  nowMs: number;
  brainStartedAtMs: number;
  /** When the newest fast snapshot arrived, from any run of the brain, or null if none ever did. */
  lastFastSnapshotAtMs: number | null;
  /** The newest version hold since the brain started: the deployer's or the control channel's `versionDrift`. */
  versionDrift: { atMs: number; detail: string } | null;
  /** The newest deploy since the brain started: `deployed`, or `deployFailed` with its reason. */
  lastDeploy: { atMs: number; failed: boolean; detail: string } | null;
  /**
   * When the supervisor gave up (#94), until resuming clears it, with the detail of the `supervisionGaveUp` event recorded
   * with this give-up (its cause, #127), or null if no event was recorded with it.
   */
  supervisionGaveUp: { atMs: number; detail: unknown } | null;
  /** The intents' outcomes in the newest fast snapshot (#141), or none. */
  intentOutcomes: IntentOutcome[];
  /** The text of a dialog the Agent left open, in the newest fast snapshot (#143), or null. */
  blockingDialog: string | null;
}

/**
 * The alerts that hold now, in a fixed order: agentSilent, versionDrift, deployFailed, supervisionGaveUp,
 * dialogBlocking, then one intentStuck per stuck intent.
 */
export function activeAlerts(facts: AlertFacts): Alert[] {
  const alerts: Alert[] = [];
  // Heard from: the newest fast snapshot, but no earlier than the brain's start, so a restarted brain gives the Agent
  // its 60 s to reconnect.
  const heardFromAtMs = Math.max(facts.lastFastSnapshotAtMs ?? facts.brainStartedAtMs, facts.brainStartedAtMs);
  if (facts.nowMs - heardFromAtMs > AGENT_SILENT_AFTER_MS) {
    const silentForSeconds = Math.round((facts.nowMs - heardFromAtMs) / 1000);
    const heardSinceStart = facts.lastFastSnapshotAtMs !== null && facts.lastFastSnapshotAtMs >= facts.brainStartedAtMs;
    alerts.push({
      name: "agentSilent",
      sinceMs: heardFromAtMs,
      detail: heardSinceStart
        ? `no fast snapshot for ${silentForSeconds} s`
        : `no fast snapshot since the brain started, ${silentForSeconds} s ago`,
    });
  }
  if (facts.versionDrift) {
    alerts.push({ name: "versionDrift", sinceMs: facts.versionDrift.atMs, detail: facts.versionDrift.detail });
  }
  if (facts.lastDeploy?.failed) {
    alerts.push({ name: "deployFailed", sinceMs: facts.lastDeploy.atMs, detail: facts.lastDeploy.detail });
  }
  if (facts.supervisionGaveUp !== null) {
    alerts.push({
      name: "supervisionGaveUp",
      sinceMs: facts.supervisionGaveUp.atMs,
      detail: gaveUpDetail(facts.supervisionGaveUp.detail),
    });
  }
  if (facts.blockingDialog !== null) {
    const quote = facts.blockingDialog.slice(0, BLOCKING_DIALOG_QUOTE_LENGTH);
    alerts.push({
      name: "dialogBlocking",
      sinceMs: facts.lastFastSnapshotAtMs ?? facts.nowMs,
      detail: `a dialog the Agent leaves for you is open, so it does nothing on the page: "${quote}"`,
    });
  }
  for (const outcome of facts.intentOutcomes) {
    if (outcome.done || outcome.tries < INTENT_STUCK_AFTER_TRIES) continue;
    alerts.push({
      name: "intentStuck",
      sinceMs: facts.lastFastSnapshotAtMs ?? facts.nowMs,
      detail: `${outcome.id}: ${outcome.tries} tries, not done${outcome.problem === null ? "" : `: ${outcome.problem}`}`,
    });
  }
  return alerts;
}

/**
 * The give-up's alert text, saying why from its event's detail (supervisor.ts `#giveUp`): a launch that would have been
 * one too many in the hour, or too many failed checks in a row. Where there's no such detail, it says the cause wasn't
 * recorded, and where to look instead.
 */
function gaveUpDetail(detail: unknown): string {
  const resume = "resume supervision to start it again";
  const fields = (detail ?? {}) as Record<string, unknown>;
  if (typeof fields.failedChecksInARow === "number") {
    const last = typeof fields.failure === "string" ? ` (the last: ${fields.failure})` : "";
    return `the supervisor stopped after ${fields.failedChecksInARow} failed checks in a row${last}: ${resume}`;
  }
  if (typeof fields.launchesInLastHour === "number") {
    return `the supervisor stopped after ${fields.launchesInLastHour} launches in an hour: ${resume}`;
  }
  // No event recorded with this give-up (the store failed as it gave up): say so, and where its cause shows.
  return (
    "the supervisor stopped, but its cause wasn't recorded (too many launches, or checks that kept failing: see the " +
    `brain's log and the supervisionFailed events): ${resume}`
  );
}
