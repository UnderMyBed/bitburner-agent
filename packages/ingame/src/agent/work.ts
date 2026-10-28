// The Agent's work activity (#151, owner decision 37): it keeps the work the brain it's connected to wants, and
// converges the game on it through the work effector (./effectors.ts, `workEffectorFor`): that work, at that focus.
// Like the hack loop, it forgets without a brain's word (safe mode's kept state stands in for one, #160), and the brain
// wanting no work (null) leaves the game's work alone.
// - Due when the work wanted changes, then every 15 rounds (30 s): the owner, or a page effector, may have moved it.
//   Page effectors keep the focus themselves (../page/page-effect.ts); this catches what they can't.
// - Company work is also checked for a promotion (#155, owner decision 44): when it's wanted, then every 10 minutes
//   (core's `PROMOTION_CHECK_INTERVAL_MS`), with that round's convergence. A check not converged goes again with the
//   next convergence, 30 s on. The effector takes any later title of the field the game offers.
// - Last in the round, after the intents, only with a second of the round left; short, it waits a round.
// - What happened is in the fast snapshot (`outcome`), for the brain and the dashboard, a promotion included.
import {
  PROMOTION_CHECK_INTERVAL_MS,
  type Work,
  type WorkEffectorReport,
  type WorkOutcome,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import type { EffectorRunner } from "./effector-runner.ts";
import { workEffectorFor } from "./effectors.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one convergence and the next while nothing changes: 30 s. */
const WORK_ROUNDS_BETWEEN = 15;
/** Rounds between one promotion check and the next (#155): 10 minutes. */
const PROMOTION_ROUNDS_BETWEEN = PROMOTION_CHECK_INTERVAL_MS / SNAPSHOT_ROUND_MS;
/** The least of the round worth starting with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

export function createWorkActivity(ns: NS, { effectorRunner }: { effectorRunner: EffectorRunner }) {
  let desired: Work | null = null;
  let outcome: WorkOutcome | null = null;
  const schedule = createRoundSchedule();
  const promotionSchedule = createRoundSchedule();
  const logChange = createChangeLog(ns, "work");

  return {
    /** The brain's latest work: a change is due at once, a promotion check too; null leaves the game's work alone. */
    desire(work: Work | null): void {
      if (JSON.stringify(desired) === JSON.stringify(work)) return;
      desired = work === null ? null : { ...work };
      outcome = work === null ? null : { converged: false, problem: null, backend: null };
      schedule.dueNow();
      promotionSchedule.dueNow();
    },

    /** No instructions (a brain connected that hasn't sent any, or none kept for safe mode) until the next. */
    forget(): void {
      desired = null;
      outcome = null;
    },

    /** After the intents: converges if it's due, within `deadlineMs`. Short of time, it stays due. */
    async convergeIfDue(deadlineMs: number): Promise<void> {
      if (desired === null || outcome === null) return;
      // Each schedule counts every round; either being due converges, the promotion check with it.
      const convergenceDue = schedule.takeRound();
      const checkPromotion = desired.kind === "company" && promotionSchedule.takeRound();
      if (!convergenceDue && !checkPromotion) return;
      if (deadlineMs - Date.now() < MIN_WORKER_TIME_MS) return;
      const tried = await effectorRunner.run(workEffectorFor(desired, { checkPromotion }), deadlineMs);
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
      // A check not converged goes again with the next convergence; converged, a problem with it is reported, and the
      // next is 10 minutes on, so a check that fails doesn't take the page every 30 s.
      if (checkPromotion)
        promotionSchedule.dueAfter(tried.report.done ? PROMOTION_ROUNDS_BETWEEN : WORK_ROUNDS_BETWEEN);
      // A work effector's report says what promotion it took, if any.
      const { promoted } = tried.report as WorkEffectorReport;
      if (desired.kind === "company" && promoted) {
        const { from, to } = promoted;
        outcome.promotion = { company: desired.company, from, to, gameTimeMs: Date.now() };
        ns.print(`agent: work: promoted at ${desired.company}, from ${from} to ${to}`);
      }
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
