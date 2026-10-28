// The Agent's intent runner (#141, architecture §5.3): it keeps the intents the brain it's connected to sends, and does
// each through its effector (./effectors.ts) until the game shows it done. Like the hack loop, it forgets on a
// disconnect.
// - In order, after the hack loop, each only with enough of the round left for the page; one that isn't waits a round.
// - A new intent is due at once. One not done is tried again every 15 rounds (30 s), logging why each time.
// - One done is never run again while the brain keeps sending it: the brain sees it done in its next medium snapshot,
//   and stops sending it. One that leaves the list and comes back is new.
// - A worker that doesn't run (home full, still running, no time left) is tried again next round. It counts as a try.
// - What happened to each is in the fast snapshot (`outcomes`), for the brain and the dashboard.
// - Each try picks its backend (#145): the simulator's own effectors where the page has them; else Singularity once the
//   game has it (SF4, or BN4) and that action's Singularity worker fits home beside the Agent, however empty home is
//   (the game charges it 4× or 16× with less than SF4.3); else the page. Looked at every try, so a home upgrade brings
//   Singularity back. A Singularity worker that can't start for now (home full) or doesn't report is tried again, as
//   any worker is.
import { deployedFilePath, type EffectorReport, type Intent, type IntentOutcome } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { effectorFor, simEffectors, type WorkerEffector } from "./effectors.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one try and the next while an intent isn't done: 30 s. */
const ROUNDS_BETWEEN_TRIES = 15;
/** How long before the round ends the worker gives up, to report and exit in time. */
const WORKER_MARGIN_MS = 200;
/** The least of the round worth starting a worker with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

interface HeldIntent {
  intent: Intent;
  schedule: ReturnType<typeof createRoundSchedule>;
  logChange: (line: string) => void;
  outcome: IntentOutcome;
}

export function createIntentRunner(
  ns: NS,
  {
    deploymentId,
    workerRunner,
    singularityAvailable,
  }: {
    deploymentId: string;
    workerRunner: WorkerRunner;
    /** Whether the game has Singularity now: SF4, or BN4, as the Agent's slow snapshot says. */
    singularityAvailable: () => boolean;
  },
) {
  let held: HeldIntent[] = [];
  /** Singularity workers logged as too big for home: each is logged once (home's RAM only grows in an Agent's run). */
  const loggedTooBig = new Set<string>();

  /** Whether `workerFile` fits home beside the Agent, however empty home is. */
  function fitsBesideAgent(workerFile: string): boolean {
    return (
      ns.getScriptRam(workerFile, "home") + ns.getScriptRam(ns.getScriptName(), "home") <= ns.getServerMaxRam("home")
    );
  }

  /** Whether this try goes through Singularity: the game has it, and the action's worker fits. Logs the first time it doesn't fit. */
  function useSingularityFor(workerName: string, description: string): boolean {
    if (!singularityAvailable()) return false;
    const fits = fitsBesideAgent(deployedFilePath(deploymentId, workerName));
    if (!fits && !loggedTooBig.has(workerName)) {
      loggedTooBig.add(workerName);
      ns.print(
        `agent: ${description}: ${workerName} doesn't fit home beside the Agent at this SF4 level; using the page`,
      );
    }
    return fits;
  }

  /** Runs `effector`'s worker: its report, or null (with the outcome's problem set) if it gave none. */
  async function runWorker(entry: HeldIntent, effector: WorkerEffector, deadlineMs: number) {
    const workerFile = deployedFilePath(deploymentId, effector.workerName);
    // The worker gives up a little before the round ends, so its report is in before the Agent stops waiting.
    const workerRun = await workerRunner.runWorker(
      workerFile,
      [...effector.workerArguments, deadlineMs - WORKER_MARGIN_MS],
      deadlineMs,
    );
    if (workerRun.outcome === "reported") return workerRun.report.data as EffectorReport;
    entry.outcome.problem = whyNoReport(workerRun, workerFile);
    return null;
  }

  async function run(entry: HeldIntent, deadlineMs: number): Promise<void> {
    const effector = effectorFor(entry.intent);
    const { description } = effector;
    const sim = simEffectors();
    const useSingularity = sim === null && useSingularityFor(effector.singularity.workerName, description);
    entry.outcome.backend = sim !== null ? "sim" : useSingularity ? "singularity" : "ui";
    // Every try counts, reported or not, so an intent whose worker never runs still shows as stuck.
    entry.outcome.tries += 1;
    let report: EffectorReport | null;
    if (sim !== null) {
      report = effector.sim(sim);
    } else {
      report = await runWorker(entry, useSingularity ? effector.singularity : effector.ui, deadlineMs);
    }
    if (report === null) {
      entry.logChange(`${entry.outcome.problem}; trying again next round`);
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
