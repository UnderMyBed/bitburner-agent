// The Agent's intent runner (#141, architecture §5.3): it keeps the intents the brain it's connected to sends, and does
// each through its effector (./effectors.ts) until the game shows it done. Unlike the hack loop and the work, it forgets
// on a disconnect, and never runs in safe mode (#160): one-shot actions need the brain.
// - In order, after the hack loop, each only with enough of the round left for the page; one that isn't waits a round.
// - A new intent is due at once. One not done is tried again every 15 rounds (30 s), logging why each time.
// - One done is never run again while the brain keeps sending it: the brain sees it done in its next medium snapshot,
//   and stops sending it. One that leaves the list and comes back is new.
// - A worker that doesn't run (home full, no time left) is tried again next round. It counts as a try. One whose last
//   copy is still running (a Singularity backdoor waits for it to end, #162) is tried again 30 s later, as one not done.
// - What happened to each is in the fast snapshot (`outcomes`), for the brain and the dashboard.
// - Each try picks its backend (#145) and runs the effector through ./effector-runner.ts. A Singularity worker that
//   can't start for now (home full) or doesn't report is tried again, as any worker is.
import type { Intent, IntentOutcome } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import type { EffectorRunner } from "./effector-runner.ts";
import { effectorFor } from "./effectors.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one try and the next while an intent isn't done: 30 s. */
const ROUNDS_BETWEEN_TRIES = 15;
/** The least of the round worth starting a worker with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

interface HeldIntent {
  intent: Intent;
  schedule: ReturnType<typeof createRoundSchedule>;
  logChange: (line: string) => void;
  outcome: IntentOutcome;
}

export function createIntentRunner(ns: NS, { effectorRunner }: { effectorRunner: EffectorRunner }) {
  let held: HeldIntent[] = [];
  async function run(entry: HeldIntent, deadlineMs: number): Promise<void> {
    const effector = effectorFor(entry.intent);
    const { description } = effector;
    const tried = await effectorRunner.run(effector, deadlineMs);
    entry.outcome.backend = tried.backend;
    // Every try counts, reported or not, so an intent whose worker never runs still shows as stuck.
    entry.outcome.tries += 1;
    const { report } = tried;
    if (report === null) {
      entry.outcome.problem = tried.noReportReason;
      if (tried.stillRunning) {
        entry.schedule.dueAfter(ROUNDS_BETWEEN_TRIES);
        entry.logChange(
          `${entry.outcome.problem}; trying again in ${(ROUNDS_BETWEEN_TRIES * SNAPSHOT_ROUND_MS) / 1000} s`,
        );
      } else {
        entry.logChange(`${entry.outcome.problem}; trying again next round`);
      }
      return;
    }
    entry.outcome.problem = report.problem;
    // A problem after it's done is still worth knowing: the page may not be back on the Terminal.
    const problem = report.problem === null ? "" : `: ${report.problem}`;
    if (report.done) {
      entry.outcome.done = true;
      ns.print(`agent: ${description} (${entry.outcome.backend}): done${problem}`);
      return;
    }
    entry.schedule.dueAfter(ROUNDS_BETWEEN_TRIES);
    // Every try, not just a change: each is a visit to the page the owner may want to see.
    ns.print(
      `agent: ${description} (${entry.outcome.backend}): not done${problem}; ` +
        `trying again in ${(ROUNDS_BETWEEN_TRIES * SNAPSHOT_ROUND_MS) / 1000} s`,
    );
  }

  return {
    /** The brain's latest list: intents it still sends keep how they went; new ones are due at once. */
    desire(intents: Intent[]): void {
      held = intents.map((intent) => {
        const kept = held.find((entry) => entry.intent.id === intent.id);
        if (kept) return kept;
        return {
          intent: structuredClone(intent),
          schedule: createRoundSchedule(),
          logChange: createChangeLog(ns, effectorFor(intent).description),
          outcome: { id: intent.id, done: false, tries: 0, problem: null, backend: null },
        };
      });
    },

    /** Disconnected: no instructions until the next brain sends some. */
    forget(): void {
      held = [];
    },

    /** After the round's snapshots and the hack loop: runs the due intents, in order, within `deadlineMs`. */
    async runDue(deadlineMs: number): Promise<void> {
      // A copy: the list doesn't change mid-round (socket events wait for the main loop), but stays safe if it did.
      for (const entry of [...held]) {
        if (entry.outcome.done) continue;
        // A round that isn't due counts down, short or not. A due one that's short leaves it due next round.
        if (!entry.schedule.takeRound()) continue;
        if (deadlineMs - Date.now() < MIN_WORKER_TIME_MS) continue;
        await run(entry, deadlineMs);
      }
    },

    /** How each held intent went, in order, for the fast snapshot. */
    outcomes(): IntentOutcome[] {
      return held.map((entry) => ({ ...entry.outcome }));
    },
  };
}
