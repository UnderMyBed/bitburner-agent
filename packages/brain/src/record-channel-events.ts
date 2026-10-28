import type { ControlChannel } from "@bitburner-agent/bridge";
import { type FastSnapshotData, type HandledDialog, MAX_DIALOG_TEXT_LENGTH } from "@bitburner-agent/core";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/**
 * The game's dialogs a fast snapshot says the Agent handled (#143), as events: only the well-formed, with their text
 * cut short, as the snapshot is the Agent's word.
 */
function handledDialogsIn(data: unknown): HandledDialog[] {
  const handled: unknown = (data as Partial<FastSnapshotData> | null)?.dialogs?.handled;
  if (!Array.isArray(handled)) return [];
  return handled
    .filter(
      (dialog): dialog is HandledDialog =>
        (dialog?.kind === "alert" || dialog?.kind === "factionInvitation") && typeof dialog.text === "string",
    )
    .map(({ kind, text }) => ({ kind, text: text.slice(0, MAX_DIALOG_TEXT_LENGTH) }));
}

/**
 * Stores everything the control channel reports: snapshots in their table, the rest as events, and each of the game's
 * dialogs a fast snapshot says the Agent handled as a `gameDialog` event (#143). Each record's release is the brain's
 * own plus the deployment of the Agent connected when it arrived, or `none` while no Agent is (architecture §7).
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
      if (tier === "fast") {
        for (const detail of handledDialogsIn(data))
          store.recordEvent(context, { atMs: event.atMs, kind: "gameDialog", detail });
      }
      return;
    }
    const { type, atMs, ...detail } = event;
    store.recordEvent(context, { atMs, kind: type, detail });
    if (event.type === "agentDisconnected") connectedDeploymentId = "none";
  });
}

/**
 * Stores what one of the brain's parts reports (the deployer, the save backups), as events tagged with `release`: the
 * brain's own plus the deployment it deploys. Returns a function that stops it.
 */
export function recordEvents<Event extends { type: string; atMs: number }>(
  source: { subscribe(listener: (event: Event) => void): () => void },
  store: TelemetryStore,
  context: { environment: Environment; release: string },
): () => void {
  return source.subscribe(({ type, atMs, ...detail }) => store.recordEvent(context, { atMs, kind: type, detail }));
}
