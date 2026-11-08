// Stopping at the BitNode's end (#303, the owner's requests of 2026-11-07): a dashboard switch with three settings, off
// by default: "stop the brain", or "stop the brain and close the game". While it's on, the brain stops at the first of:
// - **Destroyed:** the next BitNode's first slow snapshot, which main.ts's recorder has stored by then, so the campaign
//   report has the new BitNode's start and says "destroyed". The next BitNode is another `lastNodeReset` (a destroy's
//   prestige sets it, `PersonObjects/Player/PlayerObjectGeneralMethods.ts:173`; an install or a soft reset sets only
//   `lastAugReset`, `:126`), not before the last slow snapshot's game time (else a save loaded, as the campaign model
//   tells one), with a destroy's reset note out (the brain's or the owner's queued `destroyBitNode`, #175: across a
//   brain restart too), or else the BitNode's Source-File a level up (a destroy by hand in the game, below the cap:
//   `giveSourceFile`, `RedPill.tsx:16-52`). b1t_flum3 gives none (`RedPill.tsx:62-63`), and at the cap a destroy gives
//   none either, so with no note those two can't be told apart: neither stops the brain.
// - **Nothing more to gain:** the World Daemon's destroy on and ready (w0r1d_d43m0n rooted at its level), refused as
//   Source-File 1 is at its top level (`nextBitNodeProblem`), after that refusal's `nextBitNode` stall, in the same
//   update. A brain started with the switch on in such a BitNode stops as soon as it sees it.
// Either is logged in a line, stored as `brainStoppedAtBitNodeEnd`, and asked of main.ts once. Stopping the brain
// alone, main.ts shuts it down a second on (`shutDown`, as on Ctrl+C, exit 0, so `npm run brain`'s runner ends too);
// the game goes on without it, the Agent in safe mode (architecture §5.4). Closing the game too, the controller queues
// `closeGame` (the game's own Save Game, then its window closed, through the irreversible gate's two medium snapshots
// and a save backup), stored as `gameCloseSent` as it goes out; the brain shuts down once the Agent's connection drops
// after it (`gameClosed`), or, if it hasn't within a minute, or the close hasn't gone out within 5 minutes, anyway,
// logged and stored as `gameCloseNotConfirmed` (`BitNodeEndShutdown`). The close is tried at most 3 times.
import { CLOSE_GAME_WINDOW_STAYED_OPEN, type Intent, intentId, type SlowSnapshotData } from "@bitburner-agent/core";
import { bitNodeLabel } from "./cycle-report.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

/** The dashboard's switch (#303): what the brain does at the BitNode's end. */
export const STOP_AT_BITNODE_END_SETTING = "stopAtBitNodeEnd";
export const STOP_AT_BITNODE_END_SETTINGS = ["off", "brain", "brainAndGame"] as const;
export type StopAtBitNodeEnd = (typeof STOP_AT_BITNODE_END_SETTINGS)[number];

const isStopAtBitNodeEnd = (value: unknown): value is StopAtBitNodeEnd =>
  STOP_AT_BITNODE_END_SETTINGS.includes(value as StopAtBitNodeEnd);

/** The switch: off unless the owner set it. Fails on a value it didn't write, rather than guess. */
export function readStopAtBitNodeEnd(store: TelemetryStore): StopAtBitNodeEnd {
  const value = store.getSetting(STOP_AT_BITNODE_END_SETTING);
  if (value === null) return "off";
  if (!isStopAtBitNodeEnd(value)) {
    throw new Error(
      `the ${STOP_AT_BITNODE_END_SETTING} setting is ${JSON.stringify(value)}, not ${STOP_AT_BITNODE_END_SETTINGS.join(", ")}`,
    );
  }
  return value;
}

export function writeStopAtBitNodeEnd(store: TelemetryStore, setting: StopAtBitNodeEnd): void {
  store.setSetting(STOP_AT_BITNODE_END_SETTING, setting);
}

/** The setting from the dashboard's request, or null for one that isn't one. */
export function parseStopAtBitNodeEnd(value: unknown): StopAtBitNodeEnd | null {
  return isStopAtBitNodeEnd(value) ? value : null;
}

/** The setting in words, for the log: "off", "stop the brain", "stop the brain and close the game". */
export function describeStopAtBitNodeEnd(setting: StopAtBitNodeEnd): string {
  return setting === "off" ? "off" : setting === "brain" ? "stop the brain" : "stop the brain and close the game";
}

/** Stored as the brain asks to stop (#303), for the run report: the run's expected end. */
export const BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND = "brainStoppedAtBitNodeEnd";
/** Stored by the controller as the close goes out to the Agent, past its gate. */
export const GAME_CLOSE_SENT_EVENT_KIND = "gameCloseSent";
/** Stored by main.ts as the Agent's connection drops after the close: the game closed. */
export const GAME_CLOSED_EVENT_KIND = "gameClosed";
/** Stored by main.ts as it shuts down with the close not confirmed: the run report's warning. */
export const GAME_CLOSE_NOT_CONFIRMED_EVENT_KIND = "gameCloseNotConfirmed";
/** Each of them: what a silence after them follows (the run report's). */
export const BITNODE_END_EVENT_KINDS = [
  BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND,
  GAME_CLOSE_SENT_EVENT_KIND,
  GAME_CLOSED_EVENT_KIND,
  GAME_CLOSE_NOT_CONFIRMED_EVENT_KIND,
];

/** The brain's close of the game (#303). */
export const CLOSE_GAME_INTENT: Intent = { id: intentId("closeGame", {}), action: "closeGame", args: {} };
/** Tries of the close, at most: each its own save; the Agent's round may end before the save's toast shows. */
export const CLOSE_GAME_MOST_TRIES = 3;
/** How long after the close goes out the Agent's connection must drop: Steam's window goes within 200 ms. */
export const GAME_CLOSE_CONFIRMED_WITHIN_MS = 60_000;
/** How long after the stop the close must go out: its gate's two medium snapshots and a save backup take a minute. */
export const GAME_CLOSE_SENT_WITHIN_MS = 5 * 60_000;
/** How long after the stop alone the brain shuts down: the dashboard's reply to the switch that asked goes first. */
export const STOP_AFTER_MS = 1_000;

export type BitNodeEndEvent =
  | {
      type: typeof BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND;
      atMs: number;
      reason: "destroyed" | "nothingMoreToGain";
      /** The BitNode that ended ("BN1.3"); null for a destroy whose BitNode this brain never saw (before a restart). */
      bitNode: string | null;
      /** The next BitNode seen, after a destroy; null for nothing more to gain. */
      nextBitNode: string | null;
      /** The game to close first (the switch's "stop the brain and close the game"). */
      closeGame: boolean;
      /** The log line's words, after its "stopping at the BitNode's end (…): ". */
      detail: string;
    }
  | { type: typeof GAME_CLOSE_SENT_EVENT_KIND; atMs: number };

/** What tells one BitNode from the next, as a slow snapshot shows it, and the game's time then. */
export interface BitNodeReading {
  currentNode: number;
  lastNodeReset: number;
  ownedSF: Readonly<Record<string, number>>;
  gameTimeMs: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The reading from a slow snapshot (the Agent's word, so checked), or null without its reset info. */
export function bitNodeReadingOf(slowData: SlowSnapshotData, gameTimeMs: number): BitNodeReading | null {
  const info = slowData.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  const ownedSF = info?.ownedSF;
  if (
    !Number.isInteger(info?.currentNode) ||
    !isFiniteNumber(info?.lastNodeReset) ||
    typeof ownedSF !== "object" ||
    ownedSF === null
  ) {
    return null;
  }
  return { currentNode: info.currentNode as number, lastNodeReset: info.lastNodeReset, ownedSF, gameTimeMs };
}

/**
 * Whether `after` is the next BitNode after a destroy, from `before` (the last slow snapshot this brain saw, or null
 * after its start) and `destroySentAt` (the `lastNodeReset` a destroy's reset note holds, or null with none out).
 */
export function destroyedBetween(
  before: BitNodeReading | null,
  after: BitNodeReading,
  destroySentAt: number | null,
): boolean {
  if (before === null) {
    // A restarted brain: only the destroy it sent tells, and an older save loaded starts before it.
    return destroySentAt !== null && after.lastNodeReset > destroySentAt;
  }
  // Begun before the last look: the same BitNode (an install, a soft reset, this BitNode's save loaded), or an older
  // BitNode's save loaded. A BitNode begun after it is the next one.
  if (after.lastNodeReset < before.gameTimeMs) return false;
  if (destroySentAt !== null) return true;
  const node = String(before.currentNode);
  return (after.ownedSF[node] ?? 0) > (before.ownedSF[node] ?? 0);
}

const labelOf = (reading: BitNodeReading) => bitNodeLabel(reading.currentNode, reading.ownedSF);

type StopEnd = Omit<Extract<BitNodeEndEvent, { type: "brainStoppedAtBitNodeEnd" }>, "type" | "closeGame">;

/** The rule (#303), as the controller runs it: it emits `brainStoppedAtBitNodeEnd` once, and logs its line. */
export class BitNodeEndWatch {
  readonly #log: (line: string) => void;
  readonly #emit: (event: BitNodeEndEvent) => void;
  /** The last slow snapshot's reading this brain saw, across the Agent's connections (a reset kills the Agent). */
  #last: BitNodeReading | null = null;
  #stopped: { closeGame: boolean } | null = null;

  constructor({ log, emit }: { log: (line: string) => void; emit: (event: BitNodeEndEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  /** Whether it has asked the brain to stop. */
  stopped(): boolean {
    return this.#stopped !== null;
  }

  /** Whether it has asked the brain to close the game as it stops. */
  closeGameAsked(): boolean {
    return this.#stopped?.closeGame === true;
  }

  /**
   * Each slow snapshot's reading, in order, before the controller drops a destroy's note it shows done:
   * `destroySentAt` the note's `lastNodeReset`, or null. With the switch off, a destroy seen is forgotten: on later,
   * it's this BitNode's end that stops the brain.
   */
  slowSnapshot(
    reading: BitNodeReading,
    { setting, destroySentAt, atMs }: { setting: StopAtBitNodeEnd; destroySentAt: number | null; atMs: number },
  ): void {
    const before = this.#last;
    this.#last = reading;
    if (setting === "off" || this.#stopped !== null || !destroyedBetween(before, reading, destroySentAt)) return;
    const next = labelOf(reading);
    this.#stop(setting, {
      atMs,
      reason: "destroyed",
      bitNode: before === null ? null : labelOf(before),
      nextBitNode: next,
      detail: before === null ? `a destroy went through, ${next} seen` : `${labelOf(before)} destroyed, ${next} seen`,
    });
  }

  /** After the World Daemon's update: `nothingMoreToGain` its `nothingMoreToGainNow()`, in the last BitNode seen. */
  worldDaemonUpdated({
    setting,
    nothingMoreToGain,
    atMs,
  }: {
    setting: StopAtBitNodeEnd;
    nothingMoreToGain: string | null;
    atMs: number;
  }): void {
    if (setting === "off" || this.#stopped !== null || nothingMoreToGain === null) return;
    const bitNode = this.#last === null ? null : labelOf(this.#last);
    this.#stop(setting, {
      atMs,
      reason: "nothingMoreToGain",
      bitNode,
      nextBitNode: null,
      detail: `${bitNode ?? "the BitNode"}'s w0r1d_d43m0n is ready, but ${nothingMoreToGain}: the next BitNode is yours`,
    });
  }

  #stop(setting: Exclude<StopAtBitNodeEnd, "off">, end: StopEnd): void {
    const closeGame = setting === "brainAndGame";
    this.#stopped = { closeGame };
    this.#log(
      `stopping at the BitNode's end (the switch is on${closeGame ? ", the game to close first" : ""}): ${end.detail}`,
    );
    this.#emit({ type: BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND, ...end, closeGame });
  }
}

/** Whether the close, reported `outcome` by the Agent, is tried enough: its last try, or the window stayed open. */
export function closeGameTriedEnough(outcome: { tries: number; problem: string | null }): boolean {
  return outcome.tries >= CLOSE_GAME_MOST_TRIES || outcome.problem === CLOSE_GAME_WINDOW_STAYED_OPEN;
}

/** A timer's start, for tests: returns its cancel. */
type StartTimer = (callback: () => void, ms: number) => () => void;

const realTimer: StartTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/**
 * main.ts's side of the stop (#303): when to call `shutDown`, once. Stopping the brain alone, `STOP_AFTER_MS` on.
 * Closing the game too, once the Agent's connection drops after the close went out (`gameClosed`), or, unconfirmed,
 * `GAME_CLOSE_CONFIRMED_WITHIN_MS` after it went out, or `GAME_CLOSE_SENT_WITHIN_MS` after the stop if it never did
 * (`gameCloseNotConfirmed`, logged): never a second close, and never a brain left running.
 */
export class BitNodeEndShutdown {
  readonly #shutDown: () => void;
  readonly #record: (kind: string, detail: Record<string, unknown>) => void;
  readonly #log: (line: string) => void;
  readonly #startTimer: StartTimer;
  readonly #closeWaitingFor: () => string | null;
  #cancelTimer: (() => void) | null = null;
  #closeAskedAtMs: number | null = null;
  #closeSentAtMs: number | null = null;
  #done = false;

  constructor({
    shutDown,
    record,
    log,
    closeWaitingFor,
    startTimer = realTimer,
  }: {
    shutDown: () => void;
    /** Stores an event (`gameClosed`, `gameCloseNotConfirmed`). */
    record: (kind: string, detail: Record<string, unknown>) => void;
    log: (line: string) => void;
    /** Why the close hasn't gone out, or null: the controller's intents view. */
    closeWaitingFor: () => string | null;
    startTimer?: StartTimer;
  }) {
    this.#shutDown = shutDown;
    this.#record = record;
    this.#log = log;
    this.#closeWaitingFor = closeWaitingFor;
    this.#startTimer = startTimer;
  }

  /** The controller's events: the stop, and the close going out. */
  ruleEvent(event: { type: string; atMs: number; closeGame?: boolean }): void {
    if (this.#done) return;
    if (event.type === BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND) {
      if (event.closeGame !== true) {
        this.#timer(STOP_AFTER_MS, () => this.#finish());
        return;
      }
      this.#closeAskedAtMs = event.atMs;
      this.#timer(GAME_CLOSE_SENT_WITHIN_MS, () =>
        this.#notConfirmed(
          `the close didn't go out within ${GAME_CLOSE_SENT_WITHIN_MS / 60_000} min of the stop` +
            `${((why) => (why === null ? "" : ` (${why})`))(this.#closeWaitingFor())}`,
        ),
      );
    } else if (event.type === GAME_CLOSE_SENT_EVENT_KIND && this.#closeAskedAtMs !== null) {
      this.#closeSentAtMs = event.atMs;
      this.#timer(GAME_CLOSE_CONFIRMED_WITHIN_MS, () =>
        this.#notConfirmed(
          `the Agent's connection didn't drop within ${GAME_CLOSE_CONFIRMED_WITHIN_MS / 1000} s of the close: the ` +
            "game may still be running",
        ),
      );
    }
  }

  /** The channel's `agentDisconnected`: after the close went out, the game closed. */
  agentDisconnected(atMs: number): void {
    if (this.#done || this.#closeSentAtMs === null) return;
    const afterMs = atMs - this.#closeSentAtMs;
    this.#record(GAME_CLOSED_EVENT_KIND, { closeSentAtMs: this.#closeSentAtMs, afterMs });
    this.#log(
      `the game closed: its Agent's connection dropped ${(afterMs / 1000).toFixed(1)} s after the close went out`,
    );
    this.#finish();
  }

  #notConfirmed(reason: string): void {
    this.#record(GAME_CLOSE_NOT_CONFIRMED_EVENT_KIND, { reason, closeSentAtMs: this.#closeSentAtMs });
    this.#log(`game close NOT CONFIRMED: ${reason}; stopping the brain anyway`);
    this.#finish();
  }

  #timer(ms: number, callback: () => void): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#startTimer(callback, ms);
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#cancelTimer?.();
    this.#shutDown();
  }
}
