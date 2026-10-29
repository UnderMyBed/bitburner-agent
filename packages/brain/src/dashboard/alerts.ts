// The dashboard's alerts (#93, architecture §7): rules over what the store holds, evaluated whenever status is read, so
// there's no alert state to keep in sync. The route-stall alert (no progress on the route's critical path) needs a
// route, so it comes with the planner (M4).
import type { IntentOutcome } from "@bitburner-agent/core";
import type { InstallAwaitingRestart, NotQueued } from "../augmentations.ts";
import type { BackdoorDue } from "../backdoors.ts";
import { BATCHER_NOT_RUNNING_AFTER } from "../batcher.ts";
import { FACTION_STATE_UNREAD_AFTER } from "../faction-state.ts";
import { FACTION_WORK_STALLED_AFTER_MS, type FactionWorkStall } from "../factions.ts";
import type { WorldDaemonStall } from "../world-daemon.ts";

/** No fast snapshot (the heartbeat, every 2 s) for longer than this, with the brain up, is `agentSilent`. */
export const AGENT_SILENT_AFTER_MS = 60_000;
/** An intent tried this many times and still not done is `intentStuck` (#141): 5 tries are 2 minutes. */
export const INTENT_STUCK_AFTER_TRIES = 5;
/**
 * Money not risen for this long, with the hack loop on against a target, is `incomeStalled` (#184): 10 minutes. The
 * loop earns every few seconds once it hacks, and a target being prepared never holds every host when there are two or
 * more. The run report (#185) uses the same threshold for its income stalls.
 */
export const INCOME_STALLED_AFTER_MS = 10 * 60_000;
/**
 * One of the hacker factions' servers due a backdoor this long (rooted, at its level, not backdoored) is
 * `backdoorOverdue` (#195), and a run report failure: 5 minutes. The brain asks for it with the next medium snapshot
 * (10 s), the Agent tries it at once and every 30 s, and it takes seconds (../backdoors.ts): about 6 times the worst
 * real path. An overdue one may have no intent (the rule broken), so `intentStuck` can't say.
 */
export const BACKDOOR_OVERDUE_AFTER_MS = 5 * 60_000;
/**
 * An install out when the Agent disconnected, with no slow snapshot showing the reset this long after, is
 * `installNotRestarted` (#210), and a run report failure: 5 minutes. The game starts boot.js 500 ms after the reset,
 * or the page timer types it (#164, #167), and the next Agent's first slow snapshot comes in its first round: seconds.
 */
export const INSTALL_NOT_RESTARTED_AFTER_MS = 5 * 60_000;

/** How much of a blocking dialog's text the alert quotes. */
const BLOCKING_DIALOG_QUOTE_LENGTH = 200;

export type AlertName =
  | "agentSilent"
  | "versionDrift"
  | "deployFailed"
  | "supervisionGaveUp"
  | "dialogBlocking"
  | "intentStuck"
  | "incomeStalled"
  | "cloudServerProblem"
  | "messageRefused"
  | "factionStateUnread"
  | "backdoorOverdue"
  | "factionWorkStalled"
  | "batcherNotRunning"
  | "augmentationNotQueued"
  | "installNotRestarted"
  | "worldDaemonStalled";

export interface Alert {
  name: AlertName;
  /**
   * Since when: for `agentSilent`, when the Agent was last heard from (or the brain's start); for `intentStuck` and
   * `dialogBlocking`, the newest fast snapshot that shows it; for `incomeStalled`, money's last rise (or when it was
   * first watched); for `cloudServerProblem`, now; for `messageRefused`, the newest fast snapshot that shows it; for
   * `factionStateUnread`, the first of the unread slow snapshots in a row; for the others, the event or give-up that
   * raised it.
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
   * When the supervisor gave up (#94), until resuming clears it, with the detail of the `supervisionGaveUp` event
   * recorded with this give-up (its cause, #127), or null if no event was recorded with it.
   */
  supervisionGaveUp: { atMs: number; detail: unknown } | null;
  /** The intents' outcomes in the newest fast snapshot (#141), or none. */
  intentOutcomes: IntentOutcome[];
  /** The text of a dialog the Agent left open, in the newest fast snapshot (#143), or null. */
  blockingDialog: string | null;
  /** The hack loop's target while it's on (#184), or null: off, or no target yet. */
  hackLoopTarget: string | null;
  /** The player's money in the medium snapshots, and when it last rose (#184): ./income-watch.ts. */
  income: IncomeFacts | null;
  /**
   * A cloud purchase the Agent reported done with a problem (#194), as the controller noted it ("<id>: <problem>"), or
   * null. Optional for the callers that don't watch cloud servers.
   */
  cloudServerProblem?: string | null;
  /**
   * The brain's last message the Agent refused, in the newest fast snapshot (#194's review), or null. Optional for the
   * callers that don't read it.
   */
  refusedMessage?: { reason: string; count: number } | null;
  /**
   * The faction state unread in the newest slow snapshots (#197): how many in a row (skipped ones neither end nor add
   * to it), since the first of them, and the newest's backend and problem; null where the newest was read, skipped,
   * or from an older Agent, or there's no slow snapshot.
   */
  factionState: { sinceMs: number; unreadInARow: number; backend: string | null; problem: string } | null;
  /** Each of the hacker factions' servers due a backdoor, and since when (#195): the controller's view. */
  backdoorsDue: BackdoorDue[];
  /** The brain's faction work's watch (#203): its faction, its stall's window, its newest reading; or null. */
  factionWorkStall: FactionWorkStall | null;
  /**
   * The newest fast snapshots in a row whose deploy report says the batcher, wanted, isn't running (#211): how many,
   * since the first of them, and the newest's reason; null when the newest says it runs, or isn't wanted.
   */
  batcherNotRunning?: { sinceMs: number; inARow: number; problem: string } | null;
  /** The augmentation purchases reported done that the faction state never showed queued (#210): the controller's. */
  augmentationsNotQueued: NotQueued[];
  /** The install out when the Agent disconnected, until a slow snapshot shows the reset (#210), or null. */
  installAwaitingRestart: InstallAwaitingRestart | null;
  /** A step on the path to the World Daemon stalled (#215): the controller's, or null. */
  worldDaemonStall?: WorldDaemonStall | null;
}

/**
 * The player's money, as the newest medium snapshot shows it, and when it last rose: or, if it hasn't since it was
 * first watched (the Agent connected, or the hack loop came on with a target), then.
 */
export interface IncomeFacts {
  money: number;
  lastRiseAtMs: number;
}

/**
 * The alerts that hold now, in a fixed order: agentSilent, versionDrift, deployFailed, supervisionGaveUp,
 * dialogBlocking, incomeStalled, cloudServerProblem, messageRefused, factionStateUnread, then one intentStuck per stuck
 * intent, then one backdoorOverdue per overdue backdoor, then factionWorkStalled, then batcherNotRunning, then one
 * augmentationNotQueued per purchase not queued, then installNotRestarted, then worldDaemonStalled.
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
  const incomeStalled = incomeStalledAlert(facts);
  if (incomeStalled !== null) alerts.push(incomeStalled);
  if (facts.cloudServerProblem) {
    alerts.push({
      name: "cloudServerProblem",
      sinceMs: facts.nowMs,
      detail:
        `a cloud server purchase went wrong, so the brain buys no more until cloud servers are switched off and on: ` +
        facts.cloudServerProblem,
    });
  }
  if (facts.refusedMessage) {
    alerts.push({
      name: "messageRefused",
      sinceMs: facts.lastFastSnapshotAtMs ?? facts.nowMs,
      detail:
        `the Agent refused the brain's message (${facts.refusedMessage.count} so far), so it acts on the last one it ` +
        `took: ${facts.refusedMessage.reason}`,
    });
  }
  // Only once it's unread in a row: a single miss (a dialog flood, the owner acting mid-read) is a log line and an event.
  if (facts.factionState !== null && facts.factionState.unreadInARow >= FACTION_STATE_UNREAD_AFTER) {
    const { sinceMs, unreadInARow, backend, problem } = facts.factionState;
    alerts.push({
      name: "factionStateUnread",
      sinceMs,
      detail:
        `the faction state couldn't be read in the last ${unreadInARow} slow snapshots in a row` +
        `${backend === null ? "" : ` (${backend})`}: ${problem}`,
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
  alerts.push(...backdoorOverdueAlerts(facts));
  const factionWorkStalled = factionWorkStalledAlert(facts);
  if (factionWorkStalled !== null) alerts.push(factionWorkStalled);
  // The batcher sent but not running (#211): the hack loop has left its hosts to it, so nothing hacks them.
  const notRunning = facts.batcherNotRunning;
  if (notRunning && notRunning.inARow >= BATCHER_NOT_RUNNING_AFTER) {
    alerts.push({
      name: "batcherNotRunning",
      sinceMs: notRunning.sinceMs,
      detail:
        `the batcher isn't running, in the last ${notRunning.inARow} fast snapshots, so nothing hacks the servers the ` +
        `hack loop left to it: ${notRunning.problem}`,
    });
  }
  alerts.push(...augmentationAlerts(facts));
  const stall = facts.worldDaemonStall ?? null;
  if (stall !== null) {
    // The rule raises it `WORLD_DAEMON_STALLED_AFTER_MS` (5 minutes) after the step could be done (#215).
    const minutes = Math.floor((facts.nowMs - stall.sinceMs) / 60_000);
    alerts.push({ name: "worldDaemonStalled", sinceMs: stall.sinceMs, detail: `${stall.detail}, for ${minutes} min` });
  }
  return alerts;
}

/**
 * The augmentations' alerts (#210): `augmentationNotQueued`, one per purchase the Agent reported done that two faction
 * state reads since didn't show queued; and `installNotRestarted`, an install out when the Agent disconnected with no
 * slow snapshot showing the reset `INSTALL_NOT_RESTARTED_AFTER_MS` later, or at once for an install reported done
 * that the next slow snapshot didn't show reset (#213 re-review).
 */
export function augmentationAlerts({
  nowMs,
  augmentationsNotQueued,
  installAwaitingRestart,
}: Pick<AlertFacts, "nowMs" | "augmentationsNotQueued" | "installAwaitingRestart">): Alert[] {
  const alerts: Alert[] = augmentationsNotQueued.map((notQueued) => ({
    name: "augmentationNotQueued",
    sinceMs: notQueued.boughtAtMs,
    detail:
      (notQueued.augmentation === "NeuroFlux Governor"
        ? `${notQueued.augmentation} (level ${notQueued.level}) `
        : `${notQueued.augmentation} `) +
      "was reported bought, but the faction state's queue doesn't show it: check the Augmentations page",
  }));
  if (installAwaitingRestart?.doneNotReset === true) {
    alerts.push({
      name: "installNotRestarted",
      sinceMs: installAwaitingRestart.sinceMs,
      detail:
        `${installAwaitingRestart.id}: install reported done but the game didn't reset: the faction state's queue ` +
        "isn't the game's. The install cycle is called off, and no other is chosen until a reset (or the brain " +
        "restarts): check the Augmentations page",
    });
  } else if (
    installAwaitingRestart !== null &&
    nowMs - installAwaitingRestart.sinceMs >= INSTALL_NOT_RESTARTED_AFTER_MS
  ) {
    const minutes = Math.floor((nowMs - installAwaitingRestart.sinceMs) / 60_000);
    alerts.push({
      name: "installNotRestarted",
      sinceMs: installAwaitingRestart.sinceMs,
      detail:
        `${installAwaitingRestart.id} went out and the Agent disconnected ${minutes} min ago, and no slow snapshot ` +
        "has shown the reset: is the game at the Terminal, and did boot.js run?",
    });
  }
  return alerts;
}

/**
 * `factionWorkStalled` (#203), or null: the brain's faction work is sent, and its faction's reputation has risen under
 * half the work's rate over the last `FACTION_WORK_STALLED_AFTER_MS` of the connected Agent's slow snapshots
 * (../factions.ts, `underRateSince`). The work isn't converged (the Agent's problem says why), or the game credits it
 * elsewhere (another faction's work under way, say). With no reading in the window at all, it says that instead.
 */
export function factionWorkStalledAlert({
  nowMs,
  factionWorkStall,
}: Pick<AlertFacts, "nowMs" | "factionWorkStall">): Alert | null {
  if (factionWorkStall === null || nowMs - factionWorkStall.sinceMs < FACTION_WORK_STALLED_AFTER_MS) return null;
  const { faction, sinceMs, lastReadingAtMs } = factionWorkStall;
  const minutes = (fromMs: number) => Math.floor((nowMs - fromMs) / 60_000);
  // No reading in the window at all: the snapshots stopped, or each was skipped, so the rate can't be blamed.
  const detail =
    nowMs - lastReadingAtMs >= FACTION_WORK_STALLED_AFTER_MS
      ? `no reading of ${faction}'s reputation for ${minutes(lastReadingAtMs)} min, with the brain's faction work for ` +
        "it: no slow snapshot, or each one's faction state skipped (see the Factions section)"
      : `${faction}'s reputation has risen under half the work's rate for ${minutes(sinceMs)} min, with the brain's ` +
        "faction work for it: see the Work section's outcome";
  return { name: "factionWorkStalled", sinceMs, detail };
}

/**
 * `incomeStalled` (#184), or null: the hack loop is on with a target, and the player's money hasn't risen for over 10
 * minutes. A purchase lowers money, which isn't a rise; the next rise ends it. On Steam, `7990834`'s move from n00dles
 * to zer0 left money flat for 24 minutes, and nothing said so. The brain logs its start and end too (income-watch.ts).
 */
export function incomeStalledAlert({
  nowMs,
  hackLoopTarget,
  income,
}: Pick<AlertFacts, "nowMs" | "hackLoopTarget" | "income">): Alert | null {
  if (hackLoopTarget === null || income === null || nowMs - income.lastRiseAtMs <= INCOME_STALLED_AFTER_MS) {
    return null;
  }
  const minutes = Math.floor((nowMs - income.lastRiseAtMs) / 60_000);
  return {
    name: "incomeStalled",
    sinceMs: income.lastRiseAtMs,
    detail:
      `money hasn't risen for ${minutes} min, at $${Math.round(income.money).toLocaleString("en-US")}, with the hack ` +
      `loop on against ${hackLoopTarget}`,
  };
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

/**
 * `backdoorOverdue` (#195), one per server: one of the hacker factions' servers due a backdoor (rooted, at its level,
 * not backdoored) for `BACKDOOR_OVERDUE_AFTER_MS` or more, by the connected Agent's medium snapshots.
 */
export function backdoorOverdueAlerts({ nowMs, backdoorsDue }: Pick<AlertFacts, "nowMs" | "backdoorsDue">): Alert[] {
  return backdoorsDue
    .filter((due) => nowMs - due.sinceMs >= BACKDOOR_OVERDUE_AFTER_MS)
    .map((due) => ({
      name: "backdoorOverdue",
      sinceMs: due.sinceMs,
      detail:
        `${due.hostname} has been rooted, at its hacking level and not backdoored for ` +
        `${Math.floor((nowMs - due.sinceMs) / 60_000)} min: the brain asks for it at once, and it takes seconds`,
    }));
}
