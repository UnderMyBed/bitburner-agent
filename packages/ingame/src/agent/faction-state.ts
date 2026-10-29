// The Agent's faction state reader (#197): each joined faction's reputation and favour, the invitations and the queued
// augmentations, read for each slow snapshot (./snapshotter.ts) through the backend the effectors use (#145): the
// simulator's own, else Singularity where its worker fits, else the page (./effectors.ts, `factionStateReader`).
// - The game's routine dialogs are handled first (./dialog-watcher.ts): the snapshots come before the round's dialogs,
//   and an invitation's dialog open would stop the page read, as the owner's dialogs do.
// - The page's reader is given what it read last (its memory) and what the Agent saw happen since: an invitation
//   answered, an augmentation bought. With those it opens a page only for what may have changed
//   (../page/faction-state-page.ts). The memory is this Agent's: a new Agent (a reset, a reload) reads everything.
// - A reading always says what happened: the state, or why there's none (the worker's problem, or why it didn't
//   report), or that it was skipped. Never an empty state in place of an unread one. Logged when the problem changes.
import {
  type FactionState,
  type FactionStateReading,
  type FactionStateReport,
  parseFactionState,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import type { FactionPageMemory, FactionReadContext } from "../page/faction-state-page.ts";
import type { EffectorRun, EffectorRunner } from "./effector-runner.ts";
import { factionStateReader } from "./effectors.ts";

/** A reader's run as the slow snapshot's reading. */
export function readingOfRun(run: EffectorRun): FactionStateReading {
  const { backend } = run;
  if (run.report === null) return { backend, state: null, problem: run.noReportReason };
  const report = run.report as Partial<FactionStateReport>;
  const problem = typeof report.problem === "string" ? report.problem : null;
  const state = parseFactionState(report.state ?? null);
  const opened = Array.isArray(report.opened) ? { opened: report.opened.map(String) } : {};
  if (typeof report.skipped === "string") return { backend, state, problem: null, skipped: report.skipped, ...opened };
  if (state === null) return { backend, state: null, problem: problem ?? "the reader reported no faction state" };
  return { backend, state, problem, ...opened };
}

/** The page reader's memory in its report, if it's well formed. */
function memoryOf(report: unknown): FactionPageMemory | null {
  const memory = (report as { memory?: Partial<FactionPageMemory> } | null)?.memory;
  if (typeof memory !== "object" || memory === null) return null;
  const state: FactionState | null = parseFactionState(memory.state);
  const { lastAugReset, factionsReadAtMs } = memory;
  if (state === null || typeof lastAugReset !== "number" || typeof factionsReadAtMs !== "number") return null;
  return { state, lastAugReset, factionsReadAtMs };
}

export function createFactionStateReader(
  ns: NS,
  {
    effectorRunner,
    handleDialogs,
    invitationsAnswered = () => 0,
    augmentationsBought = () => 0,
  }: {
    effectorRunner: EffectorRunner;
    /** The dialog watcher's `handle`: the routine dialogs closed or answered, within the deadline. */
    handleDialogs: (deadlineMs: number) => Promise<void>;
    /** How many faction invitations the dialog watcher has answered, all told. */
    invitationsAnswered?: () => number;
    /**
     * How many augmentation purchases the intent runner has seen done, all told: a count, as the brain stops sending
     * a done intent within seconds, before the next read.
     */
    augmentationsBought?: () => number;
  },
) {
  /** What the log said last (the problem, skipped, or read), so it says each change once. */
  let lastLogged: string | null = null;
  /** The last reading's backend, for one the round had no time for (the page's until there's one). */
  let lastBackend: FactionStateReading["backend"] = "ui";
  /** What the page's reader read last, and what the Agent had seen by then. */
  let memory: FactionPageMemory | null = null;
  let invitationsAtRead = 0;
  let boughtAtRead = 0;

  function logged(reading: FactionStateReading): FactionStateReading {
    const line =
      reading.skipped !== undefined
        ? `agent: the faction state's read is skipped: ${reading.skipped}`
        : reading.problem === null
          ? "agent: the faction state is read again"
          : `agent: the faction state (${reading.backend}): ${reading.problem}`;
    // "Read again" only after a line saying otherwise: never at the first read.
    if (line !== lastLogged && (lastLogged !== null || reading.problem !== null || reading.skipped !== undefined)) {
      ns.print(line);
    }
    lastLogged = line;
    return reading;
  }

  return {
    /** Reads the faction state within `deadlineMs`: the routine dialogs first, then the reader. */
    async read(deadlineMs: number): Promise<FactionStateReading> {
      await handleDialogs(deadlineMs);
      const invitations = invitationsAnswered();
      const bought = augmentationsBought();
      // News is news since a read: with none yet, everything is read anyway.
      const context: FactionReadContext = {
        memory,
        invitationAnswered: memory !== null && invitations > invitationsAtRead,
        augmentationBought: memory !== null && bought > boughtAtRead,
      };
      const run = await effectorRunner.run(factionStateReader(JSON.stringify(context)), deadlineMs);
      lastBackend = run.backend;
      const reading = readingOfRun(run);
      const remembered = run.backend === "ui" ? memoryOf(run.report) : null;
      if (remembered !== null) {
        memory = remembered;
        invitationsAtRead = invitations;
        boughtAtRead = bought;
      }
      return logged(reading);
    },

    /** A reading for a slow snapshot sent without its read (no time in round after round): unread, saying why. */
    unread(problem: string): FactionStateReading {
      return logged({ backend: lastBackend, state: null, problem });
    },
  };
}

export type FactionStateReader = ReturnType<typeof createFactionStateReader>;
