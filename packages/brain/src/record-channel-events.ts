import type { ControlChannel, Deployer } from "@bitburner-agent/bridge";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/**
 * Stores everything the control channel reports: snapshots in their table, the rest as events. Each record's release is
 * the brain's own plus the deployment of the Agent connected when it arrived, or `none` while no Agent is
 * (architecture §7).
 */
export function recordChannelEvents(
  channel: ControlChannel,
  store: TelemetryStore,
  { environment, brainRelease }: { environment: Environment; brainRelease: string },
): void {
  let connectedDeploymentId = "none";
  channel.subscribe((event) => {
    if (event.type === "agentConnected") connectedDeploymentId = event.deploymentId;
    const context = { environment, release: `${brainRelease}+${connectedDeploymentId}` };
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
    if (event.type === "agentDisconnected") connectedDeploymentId = "none";
  });
}

/**
 * Stores what the deployer reports, as events. Their release is the brain's own plus the deployment it deploys.
 * Returns a function that stops it.
 */
export function recordDeployerEvents(
  deployer: Deployer,
  store: TelemetryStore,
  { environment, brainRelease }: { environment: Environment; brainRelease: string },
): () => void {
  const context = { environment, release: `${brainRelease}+${deployer.deploymentId}` };
  return deployer.subscribe(({ type, atMs, ...detail }) => store.recordEvent(context, { atMs, kind: type, detail }));
}
