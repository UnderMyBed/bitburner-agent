// The Agent's work activity (#151, owner decision 37): it keeps the work the brain it's connected to wants, and
// converges the game on it through the work effector (./effectors.ts, `workEffectorFor`): that work, at that focus.
// Like the hack loop, it forgets without a brain's word (safe mode's kept state stands in for one, #160), and the brain
// wanting no work (null) leaves the game's work alone.
// - Due when the work wanted changes, then every 15 rounds (30 s): the owner, or a page effector, may have moved it.
//   Page effectors keep the focus themselves (../page/page-effect.ts); this catches what they can't.
// - Last in the round, after the intents, only with a second of the round left; short, it waits a round.
// - What happened is in the fast snapshot (`outcome`), for the brain and the dashboard.
import type { Work, WorkOutcome } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import type { EffectorRunner } from "./effector-runner.ts";
import { workEffectorFor } from "./effectors.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one convergence and the next while nothing changes: 30 s. */
const WORK_ROUNDS_BETWEEN = 15;
/** The least of the round worth starting with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

export function createWorkActivity(ns: NS, { effectorRunner }: { effectorRunner: EffectorRunner }) {
  let desired: Work | null = null;
  let outcome: WorkOutcome | null = null;
  const schedule = createRoundSchedule();
  const logChange = createChangeLog(ns, "work");

  return {
    /** The brain's latest work: a change is due at once; null leaves the game's work alone. */
    desire(work: Work | null): void {
      if (JSON.stringify(desired) === JSON.stringify(work)) return;
      desired = work === null ? null : { ...work };
      outcome = work === null ? null : { converged: false, problem: null, backend: null };
      schedule.dueNow();
    },

    /** No instructions (a brain connected that hasn't sent any, or none kept for safe mode) until the next. */
    forget(): void {
      desired = null;
      outcome = null;
    },

    /** After the intents: converges if it's due, within `deadlineMs`. Short of time, it stays due. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null || outcome === null) return;
      if (!schedule.takeRound()) return;
      if (deadlineMs - Date.now() < MIN_WORKER_TIME_MS) return;
      const tried = await effectorRunner.run(workEffectorFor(desired), deadlineMs);
      outcome.backend = tried.backend;
      if (tried.report === null) {
        outcome.converged = false;
        outcome.problem = tried.noReportReason;
        logChange(`${tried.noReportReason}; trying again next round`);
        return;
      }
      outcome.converged = tried.report.done;
      outcome.problem = tried.report.problem;
      schedule.dueAfter(WORK_ROUNDS_BETWEEN);
      const problem = tried.report.problem === null ? "" : `: ${tried.report.problem}`;
      logChange(
        tried.report.done
          ? `converged${problem}`
          : `not converged${problem}; trying again in ${(WORK_ROUNDS_BETWEEN * SNAPSHOT_ROUND_MS) / 1000} s`,
      );
    },

    /** How the work went, for the fast snapshot; null while no work is wanted. */
    outcome: (): WorkOutcome | null => (outcome === null ? null : { ...outcome }),
  };
}
