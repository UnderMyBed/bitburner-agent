// The dashboard's alerts (#93, architecture §7): rules over what the store holds, evaluated whenever status is read, so
// there's no alert state to keep in sync. The stall alert (no progress on the route's critical path) needs a route, so
// it comes with the planner (M4).
import type { IntentOutcome } from "@bitburner-agent/core";

/** No fast snapshot (the heartbeat, every 2 s) for longer than this, with the brain up, is `agentSilent`. */
export const AGENT_SILENT_AFTER_MS = 60_000;
/** An intent tried this many times and still not done is `intentStuck` (#141): 5 tries are 2 minutes. */
export const INTENT_STUCK_AFTER_TRIES = 5;

export type AlertName = "agentSilent" | "versionDrift" | "deployFailed" | "supervisionGaveUp" | "intentStuck";

export interface Alert {
  name: AlertName;
  /**
   * Since when: for `agentSilent`, when the Agent was last heard from (or the brain's start); for the others, the
   * event or give-up that raised it.
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
  /** When the supervisor gave up (#94), until unpausing clears it. */
  supervisionGaveUpAtMs: number | null;
  /** The intents' outcomes in the newest fast snapshot (#141), or none. */
  intentOutcomes: IntentOutcome[];
}

/**
 * The alerts that hold now, in a fixed order: agentSilent, versionDrift, deployFailed, supervisionGaveUp, then one
 * intentStuck per stuck intent.
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
  if (facts.supervisionGaveUpAtMs !== null) {
    alerts.push({
      name: "supervisionGaveUp",
      sinceMs: facts.supervisionGaveUpAtMs,
      detail: "the supervisor stopped after too many relaunches: unpause supervision to start it again",
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
