import { type Clock, ControlChannel } from "@bitburner-agent/bridge";
import { type FastSnapshotData, type HandledDialog, MAX_DIALOG_TEXT_LENGTH } from "@bitburner-agent/core";
import { FACTION_STATE_READ_EVENT_KIND, FACTION_STATE_UNREAD_EVENT_KIND, factionStatusOf } from "./faction-state.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";
import { reportedPromotion } from "./work.ts";

/** The event a promotion the Agent took is stored as (#155): its company, titles and game time. */
export const WORK_PROMOTION_EVENT_KIND = "workPromotion";
/**
 * A restart after a reset through the page that couldn't type `run /agent/boot.js` (#212), as the next Agent reports
 * it: `{ outcome, reason, atMs }`, the fallback's reload or a give-up. A failure in the run report.
 */
export const RESTART_FELL_BACK_EVENT_KIND = "restartFellBack";

/** The restart's note in a fast snapshot, if it's well formed (#212). */
function restartNoteIn(data: unknown): { outcome: string; reason: string; atMs: number } | null {
  const note = (data as Partial<FastSnapshotData> | null)?.restart as Record<string, unknown> | undefined;
  if (typeof note !== "object" || note === null) return null;
  const { outcome, reason, atMs } = note;
  if ((outcome !== "reloading" && outcome !== "gaveUp") || typeof reason !== "string" || typeof atMs !== "number") {
    return null;
  }
  return { outcome, reason: reason.slice(0, MAX_DIALOG_TEXT_LENGTH), atMs };
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
 * snapshot after snapshot, so one already stored, after a brain restart too, isn't stored again. Each record's release
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
        const restart = restartNoteIn(data);
        if (restart !== null) {
          store.recordEvent(context, { atMs: event.atMs, kind: RESTART_FELL_BACK_EVENT_KIND, detail: restart });
          log(
            `the restart after a reset couldn't type run /agent/boot.js: ${restart.reason}` +
              (restart.outcome === "reloading" ? "; it saved and reloaded the game" : "; it gave up"),
          );
        }
        const promotion = reportedPromotion((data as Partial<FastSnapshotData> | null)?.work?.promotion);
        if (promotion !== null && JSON.stringify(promotion) !== lastPromotion) {
          lastPromotion = JSON.stringify(promotion);
          store.recordEvent(context, { atMs: event.atMs, kind: WORK_PROMOTION_EVENT_KIND, detail: promotion });
          log(`the Agent took a promotion at ${promotion.company}: ${promotion.from} to ${promotion.to}`);
        }
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
