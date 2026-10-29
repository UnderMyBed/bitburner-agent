// The Agent's faction state reader (#197): each joined faction's reputation and favour, the invitations and the queued
// augmentations, read for each slow snapshot (./snapshotter.ts) through the backend the effectors use (#145): the
// simulator's own, else Singularity where its worker fits, else the page (./effectors.ts, `factionStateReader`).
// - The game's routine dialogs are handled first (./dialog-watcher.ts): the snapshots come before the round's dialogs,
//   and an invitation's dialog open would stop the page read, as the owner's dialogs do.
// - A reading always says what happened: the state, or why there's none (the worker's problem, or why it didn't
//   report). Never an empty state in place of an unread one. Logged when the problem changes.
import { type FactionStateReading, type FactionStateReport, parseFactionState } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import type { EffectorRun, EffectorRunner } from "./effector-runner.ts";
import { factionStateReader } from "./effectors.ts";

/** A reader's run as the slow snapshot's reading. */
export function readingOfRun(run: EffectorRun): FactionStateReading {
  const { backend } = run;
  if (run.report === null) return { backend, state: null, problem: run.noReportReason };
  const report = run.report as Partial<FactionStateReport>;
  const problem = typeof report.problem === "string" ? report.problem : null;
  const state = parseFactionState(report.state ?? null);
  if (state === null) return { backend, state: null, problem: problem ?? "the reader reported no faction state" };
  return { backend, state, problem };
}

export function createFactionStateReader(
  ns: NS,
  {
    effectorRunner,
    handleDialogs,
  }: {
    effectorRunner: EffectorRunner;
    /** The dialog watcher's `handle`: the routine dialogs closed or answered, within the deadline. */
    handleDialogs: (deadlineMs: number) => Promise<void>;
  },
) {
  /** The last reading's problem, so the log says each change once. */
  let lastProblem: string | null = null;
  return {
    /** Reads the faction state within `deadlineMs`: the routine dialogs first, then the reader. */
    async read(deadlineMs: number): Promise<FactionStateReading> {
      await handleDialogs(deadlineMs);
      const reading = readingOfRun(await effectorRunner.run(factionStateReader(), deadlineMs));
      if (reading.problem !== lastProblem) {
        ns.print(
          reading.problem === null
            ? "agent: the faction state is read again"
            : `agent: the faction state (${reading.backend}): ${reading.problem}`,
        );
        lastProblem = reading.problem;
      }
      return reading;
    },
  };
}

export type FactionStateReader = ReturnType<typeof createFactionStateReader>;
