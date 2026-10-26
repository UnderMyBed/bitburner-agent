import type { ControlChannel } from "@bitburner-agent/bridge";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/**
 * Stores everything the control channel reports: snapshots in their table, the rest as events. Each record's release is
 * the brain's own plus the deployment of the Agent connected when it arrived (architecture §7).
 */
export function recordChannelEvents(
  channel: ControlChannel,
  store: TelemetryStore,
  { environment, brainRelease }: { environment: Environment; brainRelease: string },
): void {
  let deploymentId = "none";
  channel.subscribe((event) => {
    if (event.type === "agentConnected") deploymentId = event.deploymentId;
    const context = { environment, release: `${brainRelease}+${deploymentId}` };
    if (event.type === "snapshotReceived") {
      const { agentSessionId, tier, sequenceNumber, gameTimeMs, data } = event.snapshot;
      store.recordSnapshot(context, {
        agentSessionId,
        tier,
        sequenceNumber,
        gameTimeMs,
        receivedAtMs: event.atMs,
        missedBefore: event.missedBefore,
        data,
      });
      return;
    }
    const { type, atMs, ...detail } = event;
    store.recordEvent(context, { atMs, kind: type, detail });
  });
}
