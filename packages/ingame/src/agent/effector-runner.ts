// Running an effector (#145, #151, architecture §5.6), for the intent runner and the work activity alike: the backend
// picked for this try, then its effector run within the deadline.
// - The simulator's own effectors where the page has them; else Singularity once the game has it (SF4, or BN4) and the
//   action's Singularity worker fits home beside the Agent, however empty home is (the game charges it 4× or 16× with
//   less than SF4.3); else the page. Looked at every try, so a home upgrade brings Singularity back. An action with no
//   Singularity worker (`buyServer`, #159) always has its `ui` one, which needs no Singularity.
// - A worker gives up a little before the round ends, so its report is in before the Agent stops waiting.
import { deployedFilePath, type EffectorBackend, type EffectorReport } from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type Effector, simEffectors } from "./effectors.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

/** How long before the round ends the worker gives up, to report and exit in time. */
const WORKER_MARGIN_MS = 200;

/**
 * One try: its backend, and the effector's report, or why there's none (the worker didn't run, or didn't report).
 * `stillRunning`: the last try's worker hasn't exited, as a Singularity backdoor's waits for it to end (#162).
 */
export type EffectorRun = { backend: EffectorBackend } & (
  | { report: EffectorReport; noReportReason: null; stillRunning?: undefined }
  | { report: null; noReportReason: string; stillRunning: boolean }
);

export function createEffectorRunner(
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
  /** Singularity workers logged as too big for home: each is logged once (home's RAM only grows in an Agent's run). */
  const loggedTooBig = new Set<string>();

  /** Whether `workerFile` fits home beside the Agent, however empty home is. */
  function fitsBesideAgent(workerFile: string): boolean {
    return (
      ns.getScriptRam(workerFile, "home") + ns.getScriptRam(ns.getScriptName(), "home") <= ns.getServerMaxRam("home")
    );
  }

  /** Whether this try goes through Singularity: the game has it, and the worker fits. Logs the first time it doesn't. */
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

  return {
    /** Runs `effector` once, through the backend picked now, within `deadlineMs`. */
    async run(effector: Effector, deadlineMs: number): Promise<EffectorRun> {
      const sim = simEffectors();
      if (sim !== null) return { backend: "sim", report: effector.sim(sim), noReportReason: null };
      const { singularity } = effector;
      const { backend, workerName, workerArguments } =
        singularity !== null && useSingularityFor(singularity.workerName, effector.description)
          ? { backend: "singularity" as const, ...singularity }
          : { backend: "ui" as const, ...effector.ui };
      const workerFile = deployedFilePath(deploymentId, workerName);
      const workerRun = await workerRunner.runWorker(
        workerFile,
        [...workerArguments, deadlineMs - WORKER_MARGIN_MS],
        deadlineMs,
      );
      if (workerRun.outcome === "reported") {
        return { backend, report: workerRun.report.data as EffectorReport, noReportReason: null };
      }
      return {
        backend,
        report: null,
        noReportReason: whyNoReport(workerRun, workerFile),
        stillRunning: workerRun.outcome === "stillRunning",
      };
    },
  };
}

export type EffectorRunner = ReturnType<typeof createEffectorRunner>;
