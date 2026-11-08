// Stopping at the BitNode's end (#303, the owner's request of 2026-11-07): a dashboard switch, off by default. While
// it's on, the brain shuts down cleanly (main.ts's `shutDown`, exit 0, so `npm run brain`'s runner ends too) at the
// first of:
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
// Either is logged in a line, stored as `brainStoppedAtBitNodeEnd` and asked of main.ts once. The game goes on without
// the brain: the in-game scripts keep running, the Agent in safe mode (architecture §5.4).
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { bitNodeLabel } from "./cycle-report.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

/** The dashboard's switch (#303): off unless the owner turns it on. */
export const STOP_AT_BITNODE_END_SETTING = "stopAtBitNodeEnd.enabled";

export function readStopAtBitNodeEnd(store: TelemetryStore): boolean {
  return readSwitch(store, STOP_AT_BITNODE_END_SETTING, false);
}

export function writeStopAtBitNodeEnd(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, STOP_AT_BITNODE_END_SETTING, enabled);
}

/** Stored as the brain asks to stop (#303), for the run report: the run's expected end. */
export const BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND = "brainStoppedAtBitNodeEnd";

export interface BitNodeEndEvent {
  type: typeof BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND;
  atMs: number;
  reason: "destroyed" | "nothingMoreToGain";
  /** The BitNode that ended ("BN1.3"); null for a destroy whose BitNode this brain never saw (sent before a restart). */
  bitNode: string | null;
  /** The next BitNode seen, after a destroy; null for nothing more to gain. */
  nextBitNode: string | null;
  /** The log line's words, after "stopping at the BitNode's end (the switch is on): ". */
  detail: string;
}

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
  if (after.lastNodeReset === before.lastNodeReset) return false;
  // Started before the last look: a save loaded, an older BitNode's.
  if (after.lastNodeReset < before.gameTimeMs) return false;
  if (destroySentAt !== null) return true;
  const node = String(before.currentNode);
  return (after.ownedSF[node] ?? 0) > (before.ownedSF[node] ?? 0);
}

const labelOf = (reading: BitNodeReading) => bitNodeLabel(reading.currentNode, reading.ownedSF);

/** The rule (#303), as the controller runs it: it emits `brainStoppedAtBitNodeEnd` once, and logs its line. */
export class BitNodeEndWatch {
  readonly #log: (line: string) => void;
  readonly #emit: (event: BitNodeEndEvent) => void;
  /** The last slow snapshot's reading this brain saw, across the Agent's connections (a reset kills the Agent). */
  #last: BitNodeReading | null = null;
  #stopped = false;

  constructor({ log, emit }: { log: (line: string) => void; emit: (event: BitNodeEndEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  /** Whether it has asked the brain to stop. */
  stopped(): boolean {
    return this.#stopped;
  }

  /**
   * Each slow snapshot's reading, in order, before the controller drops a destroy's note it shows done: `destroySentAt`
   * the note's `lastNodeReset`, or null. With the switch off, a destroy seen is forgotten: on later, it's this BitNode's
   * end that stops the brain.
   */
  slowSnapshot(
    reading: BitNodeReading,
    { enabled, destroySentAt, atMs }: { enabled: boolean; destroySentAt: number | null; atMs: number },
  ): void {
    const before = this.#last;
    this.#last = reading;
    if (!enabled || this.#stopped || !destroyedBetween(before, reading, destroySentAt)) return;
    const next = labelOf(reading);
    this.#stop({
      atMs,
      reason: "destroyed",
      bitNode: before === null ? null : labelOf(before),
      nextBitNode: next,
      detail: before === null ? `a destroy went through, ${next} seen` : `${labelOf(before)} destroyed, ${next} seen`,
    });
  }

  /** After the World Daemon's update: `nothingMoreToGain` its `nothingMoreToGainNow()`, in the last BitNode seen. */
  worldDaemonUpdated({
    enabled,
    nothingMoreToGain,
    atMs,
  }: {
    enabled: boolean;
    nothingMoreToGain: string | null;
    atMs: number;
  }): void {
    if (!enabled || this.#stopped || nothingMoreToGain === null) return;
    const bitNode = this.#last === null ? null : labelOf(this.#last);
    this.#stop({
      atMs,
      reason: "nothingMoreToGain",
      bitNode,
      nextBitNode: null,
      detail: `${bitNode ?? "the BitNode"}'s w0r1d_d43m0n is ready, but ${nothingMoreToGain}: the next BitNode is yours`,
    });
  }

  #stop(end: Omit<BitNodeEndEvent, "type">): void {
    this.#stopped = true;
    this.#log(`stopping at the BitNode's end (the switch is on): ${end.detail}`);
    this.#emit({ type: BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND, ...end });
  }
}
