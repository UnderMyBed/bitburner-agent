import { type Clock, ControlChannel } from "@bitburner-agent/bridge";
import {
  type FastSnapshotData,
  type HandledDialog,
  MAX_DIALOG_TEXT_LENGTH,
  MAX_REFUSED_REASON_LENGTH,
  type RefusedBrainMessage,
} from "@bitburner-agent/core";
import { FACTION_STATE_READ_EVENT_KIND, FACTION_STATE_UNREAD_EVENT_KIND, factionStatusOf } from "./faction-state.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";
import { reportedPromotion } from "./work.ts";

/** The event a promotion the Agent took is stored as (#155): its company, titles and game time. */
export const WORK_PROMOTION_EVENT_KIND = "workPromotion";

/** The event a brain message the Agent refused is stored as (#194's review): its reason and count. */
export const MESSAGE_REFUSED_EVENT_KIND = "messageRefused";

/** The brain's last message the Agent refused, from a fast snapshot, if well formed (the Agent's word), else null. */
export function reportedRefusal(data: unknown): RefusedBrainMessage | null {
  const refused = (data as Partial<FastSnapshotData> | null)?.refusedMessage;
  if (typeof refused?.reason !== "string" || !Number.isSafeInteger(refused.count)) return null;
  return { reason: refused.reason.slice(0, MAX_REFUSED_REASON_LENGTH), count: refused.count };
}

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
 * The brain's control channel, its numbering seeded from `store` (#119): after a brain restart, the same Agent
 * session's next snapshots carry on from those stored, so none stored counts as missed, and none is stored twice.
 */
export function brainChannel({
  token,
  clock,
  store,
  environment,
}: {
  token: string;
  clock: Clock;
  store: TelemetryStore;
  environment: Environment;
}): ControlChannel {
  return new ControlChannel({
    token,
    clock,
    storedSequenceNumbers: (agentSessionId) => store.lastSequenceNumbers({ environment, agentSessionId }),
  });
}

/**
 * Stores everything the control channel reports: snapshots in their table, the rest as events, and each of the game's
 * dialogs a fast snapshot says the Agent handled as a `gameDialog` event (#143). A promotion a fast snapshot's work
 * reports (#155) is a `workPromotion` event, and a line for `log`, once: the work outcome carries the latest one
 * snapshot after snapshot, so one already stored, after a brain restart too, isn't stored again. A brain message the
 * Agent refused (#194's review) is a `messageRefused` event and a line for `log`, once each: the fast snapshot carries
 * the last one, with its count, until the Agent takes a desired state again. Each record's release
 * is the brain's own plus the deployment of the Agent connected when it arrived, or `none` while no Agent is
 * (architecture §7). A slow snapshot whose faction state couldn't be read (#197) is a `factionStateUnread` event, and a
 * line for `log`, each time the problem changes, and `factionStateRead` once it's read again; after a brain restart, the
 * last one stored says where it was.
 */
export function recordChannelEvents(
  channel: ControlChannel,
  store: TelemetryStore,
  {
    environment,
    brainRelease,
    log = () => {},
  }: { environment: Environment; brainRelease: string; log?: (line: string) => void },
): void {
  let connectedDeploymentId = "none";
  const [lastStored] = store.recentEvents({ environment, limit: 1, kinds: [WORK_PROMOTION_EVENT_KIND] });
  let lastPromotion = JSON.stringify(reportedPromotion(lastStored?.detail));
  let lastRefusal = "null";
  const [lastFactionEvent] = store.recentEvents({
    environment,
    limit: 1,
    kinds: [FACTION_STATE_UNREAD_EVENT_KIND, FACTION_STATE_READ_EVENT_KIND],
  });
  /** The faction state's last problem stored, or null for read (or never unread). */
  let lastFactionProblem =
    lastFactionEvent?.kind === FACTION_STATE_UNREAD_EVENT_KIND
      ? String((lastFactionEvent.detail as { problem?: unknown } | null)?.problem)
      : null;
  channel.subscribe((event) => {
    if (event.type === "agentConnected") {
      connectedDeploymentId = event.deploymentId;
      lastRefusal = "null";
    }
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
        const promotion = reportedPromotion((data as Partial<FastSnapshotData> | null)?.work?.promotion);
        if (promotion !== null && JSON.stringify(promotion) !== lastPromotion) {
          lastPromotion = JSON.stringify(promotion);
          store.recordEvent(context, { atMs: event.atMs, kind: WORK_PROMOTION_EVENT_KIND, detail: promotion });
          log(`the Agent took a promotion at ${promotion.company}: ${promotion.from} to ${promotion.to}`);
        }
        const refusal = reportedRefusal(data);
        if (refusal !== null && JSON.stringify(refusal) !== lastRefusal) {
          store.recordEvent(context, { atMs: event.atMs, kind: MESSAGE_REFUSED_EVENT_KIND, detail: refusal });
          log(
            `the Agent REFUSED the brain's message (${refusal.count} so far), so it acts on the last one it took: ` +
              refusal.reason,
          );
        }
        lastRefusal = JSON.stringify(refusal);
      }
      if (tier === "slow") {
        // Only unread changes it: one read (or read with the page not put back) clears it; one skipped, or from an
        // older Agent (no reading), is neither (faction-state.ts).
        const status = factionStatusOf(data);
        const { backend } = status;
        const problem =
          status.kind === "unread"
            ? status.problem
            : status.kind === "skipped" || status.kind === "absent"
              ? lastFactionProblem
              : null;
        if (problem !== lastFactionProblem) {
          if (problem === null) {
            store.recordEvent(context, { atMs: event.atMs, kind: FACTION_STATE_READ_EVENT_KIND, detail: { backend } });
            log(`the faction state is read again (${backend})`);
          } else {
            store.recordEvent(context, {
              atMs: event.atMs,
              kind: FACTION_STATE_UNREAD_EVENT_KIND,
              detail: { backend, problem },
            });
            log(`the faction state couldn't be read${backend === null ? "" : ` (${backend})`}: ${problem}`);
          }
          lastFactionProblem = problem;
        }
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
