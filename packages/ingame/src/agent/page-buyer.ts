// The Agent's side of what it buys through the game's page (the `ui` effector): the hacking programs (#136) and home's
// RAM (#138). Each buyer keeps the next purchase the brain it's connected to wants, and buys it with its worker
// (`buy-program.js`, `upgrade-home-ram.js`). Like the hack loop, it forgets on a disconnect.
// - It runs the worker when the purchase changes, after the hack loop, if enough of the round is left for the page.
// - Bought, it waits for the brain's next purchase: the brain sees it in the next medium snapshot.
// - Not bought (the page wasn't as expected), it logs why, every try, and tries again every 15 rounds (30 s).
// - A worker that doesn't run (home full, still running, no time left) is tried again next round.
import {
  BUY_PROGRAM_WORKER_NAME,
  type DesiredState,
  deployedFilePath,
  type PurchaseReport,
  UPGRADE_HOME_RAM_WORKER_NAME,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { createChangeLog, createRoundSchedule } from "./activity.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";
import { SNAPSHOT_ROUND_MS } from "./snapshotter.ts";

/** Rounds between one try and the next while a purchase isn't made: 30 s. */
const ROUNDS_BETWEEN_TRIES = 15;
/** How long before the round ends the worker gives up, to report and exit in time. */
const WORKER_MARGIN_MS = 200;
/** The least of the round worth starting the worker with: the page takes a few renders. Less waits a round. */
const MIN_WORKER_TIME_MS = 1_000;

interface Activity<Next> {
  /** Its name in the log. */
  name: string;
  workerName: string;
  /** The worker's arguments for `next`, before the deadline it's given. */
  workerArguments(next: Next): (string | number)[];
  /** What `next` buys, for the log. */
  describe(next: Next): string;
}

type PageBuyerOptions = { deploymentId: string; workerRunner: WorkerRunner };

function createPageBuyer<Next>(
  ns: NS,
  { deploymentId, workerRunner }: PageBuyerOptions,
  { name, workerName, workerArguments, describe }: Activity<Next>,
) {
  let desired: { enabled: boolean; next: Next | null } | null = null;
  const schedule = createRoundSchedule();
  const logOutcome = createChangeLog(ns, name);

  return {
    /** The brain's latest: a new purchase makes it due at once. */
    desire(wanted: { enabled: boolean; next: Next | null }): void {
      if (JSON.stringify(desired) === JSON.stringify(wanted)) return;
      desired = structuredClone(wanted);
      schedule.dueNow();
    },

    /** Disconnected: no instructions until the next brain sends some. */
    forget(): void {
      desired = null;
    },

    /** After the round's snapshots and the hack loop: buys the next purchase if it's due, within `deadlineMs`. */
    async buyIfDue(deadlineMs: number): Promise<void> {
      const next = desired?.enabled ? desired.next : null;
      if (next === null) return;
      // A round that isn't due counts down, short or not. A due one that's short leaves it due next round.
      if (!schedule.takeRound()) return;
      if (deadlineMs - Date.now() < MIN_WORKER_TIME_MS) return;
      const workerFile = deployedFilePath(deploymentId, workerName);
      // The worker gives up a little before the round ends, so its report is in before the Agent stops waiting.
      const workerRun = await workerRunner.runWorker(
        workerFile,
        [...workerArguments(next), deadlineMs - WORKER_MARGIN_MS],
        deadlineMs,
      );
      if (workerRun.outcome !== "reported") {
        logOutcome(`${whyNoReport(workerRun, workerFile)}; trying again next round`);
        return;
      }
      const report = workerRun.report.data as PurchaseReport;
      // A problem after the purchase is still worth knowing: the page may not be back on the Terminal.
      const problem = report.problem === null ? "" : `: ${report.problem}`;
      if (report.done) {
        // Nothing more until the brain names the next purchase.
        schedule.never();
        logOutcome(`bought ${describe(next)}${problem}`);
        return;
      }
      schedule.dueAfter(ROUNDS_BETWEEN_TRIES);
      // Every failed try, not just a change: each is a visit to the page the owner may want to see.
      ns.print(
        `agent: ${name}: couldn't buy ${describe(next)}${problem}; ` +
          `trying again in ${(ROUNDS_BETWEEN_TRIES * SNAPSHOT_ROUND_MS) / 1000} s`,
      );
    },
  };
}

/** The hacking programs (#136): the TOR router at a tech vendor, or a port opener through the terminal. */
export function createProgramBuyer(ns: NS, options: PageBuyerOptions) {
  return createPageBuyer<NonNullable<DesiredState["programs"]["next"]>>(ns, options, {
    name: "hacking programs",
    workerName: BUY_PROGRAM_WORKER_NAME,
    workerArguments: ({ item, vendor }) => [item, vendor ?? ""],
    describe: ({ item }) => item,
  });
}

/** Home's RAM (#138): one doubling at a tech vendor. */
export function createHomeRamUpgrader(ns: NS, options: PageBuyerOptions) {
  return createPageBuyer<NonNullable<DesiredState["homeRam"]["next"]>>(ns, options, {
    name: "home RAM",
    workerName: UPGRADE_HOME_RAM_WORKER_NAME,
    workerArguments: ({ fromRam, vendor }) => [fromRam, vendor],
    describe: ({ fromRam }) => `${fromRam * 2} GB of home RAM`,
  });
}
