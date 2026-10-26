// The Agent's snapshotter (#89, architecture §5.2): runs one round of snapshots every 2 s while welcomed. Each tier's
// data comes from a short-lived worker script, so the Agent itself stays small:
// - fast, every round, always sent (the heartbeat), even when its worker can't run;
// - medium every 5th round (10 s), slow every 30th (60 s), both in the first round after each welcome;
// - static, once per Agent start, resent from memory after each welcome.
// Workers run one at a time, as temporary scripts, and report through a port. Every wait ends with the round, so a
// round never runs past 2 s and the heartbeat is never more than two rounds apart. A tier whose worker can't start,
// doesn't report in time, or is still running from before is skipped, named in `degradedTiers`, and tried again next
// round, until it succeeds.
import {
  CONTROL_PROTOCOL_VERSION,
  deployedFilePath,
  type FastSnapshotData,
  type FastWorkerData,
  SNAPSHOT_WORKER_PORT,
  type SnapshotMessage,
  type SnapshotTier,
  type SnapshotWorkerReport,
  snapshotWorkerFileName,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";

export const SNAPSHOT_ROUND_MS = 2_000;
/** How often a wait checks whether its worker is still running. */
const WORKER_POLL_MS = 20;
/** Rounds from one snapshot of the tier to the next. */
const ROUNDS_BETWEEN = { medium: 5, slow: 30 } as const;

/** The page's JS heap, where the browser reports it (Chromium does; the simulator doesn't). */
function pageHeapUsedBytes(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

/** Anything can be written to a port: only a report from this worker counts. */
function isReportFrom(value: unknown, workerPid: number): value is SnapshotWorkerReport {
  return typeof value === "object" && value !== null && (value as { workerPid?: unknown }).workerPid === workerPid;
}

export function createSnapshotter(
  ns: NS,
  { deploymentId, agentSessionId }: { deploymentId: string; agentSessionId: string },
) {
  const lastSequenceNumbers: Record<SnapshotTier, number> = { static: 0, slow: 0, medium: 0, fast: 0 };
  /** 0: due this round. */
  const roundsUntilDue = { medium: 0, slow: 0 };
  const lastWorkerPids: Partial<Record<SnapshotTier, number>> = {};
  const degradedTiers = new Set<SnapshotTier>();
  let staticReport: SnapshotWorkerReport | null = null;
  let staticToSend = false;

  const snapshot = (tier: SnapshotTier, gameTimeMs: number, data: unknown): SnapshotMessage => {
    lastSequenceNumbers[tier] += 1;
    return {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "snapshot",
      agentSessionId,
      tier,
      sequenceNumber: lastSequenceNumbers[tier],
      gameTimeMs,
      data,
    };
  };

  /** Logged on a change only, so a long spell on a full home doesn't flood the log. */
  const skipped = (tier: SnapshotTier, why: string): null => {
    if (!degradedTiers.has(tier)) ns.print(`agent: the ${tier} tier is skipped: ${why}`);
    degradedTiers.add(tier);
    return null;
  };

  /**
   * The worker's report, once the worker has exited (so its RAM is free for the next one), or null if it exits
   * without one. Either way, no later than `deadlineMs`.
   */
  async function reportFrom(workerPid: number, deadlineMs: number): Promise<SnapshotWorkerReport | null> {
    const port = ns.getPortHandle(SNAPSHOT_WORKER_PORT);
    let report: SnapshotWorkerReport | null = null;
    for (;;) {
      // An `ns` call before touching the port: if this Agent has been killed, the game ends it here, before it can
      // read a report meant for the next Agent's worker (port reads don't check).
      const workerRunning = ns.isRunning(workerPid);
      while (report === null && !port.empty()) {
        const value: unknown = port.read();
        if (isReportFrom(value, workerPid)) report = value;
      }
      if (!workerRunning) return report;
      // Bounded by a round even if the clock steps back.
      const remainingMs = Math.min(deadlineMs - Date.now(), SNAPSHOT_ROUND_MS);
      if (remainingMs <= 0) return report;
      // `asleep`, not `sleep`: a `sleep` that loses the race keeps the script marked busy until it ends, and the
      // game kills a busy script for its next `ns` call (NetscriptHelpers.tsx:405-431). `asleep` doesn't mark it.
      await Promise.race([port.nextWrite(), ns.asleep(Math.min(remainingMs, WORKER_POLL_MS))]);
    }
  }

  async function runWorker(tier: SnapshotTier, deadlineMs: number): Promise<SnapshotWorkerReport | null> {
    const previousWorkerPid = lastWorkerPids[tier];
    // Never a second copy: a worker that hangs would otherwise pile up copies, each holding its RAM.
    if (previousWorkerPid !== undefined && ns.isRunning(previousWorkerPid)) {
      return skipped(tier, "its last worker is still running");
    }
    if (Date.now() >= deadlineMs) return skipped(tier, "no time left in the round");
    const workerFile = deployedFilePath(deploymentId, snapshotWorkerFileName(tier));
    const workerPid = ns.run(workerFile, { temporary: true });
    if (workerPid === 0) return skipped(tier, `${workerFile} couldn't start`);
    lastWorkerPids[tier] = workerPid;
    const report = await reportFrom(workerPid, deadlineMs);
    if (report === null) return skipped(tier, `${workerFile} didn't report in time`);
    if (degradedTiers.delete(tier)) ns.print(`agent: the ${tier} tier is back`);
    return report;
  }

  return {
    /** After every welcome, the next round sends all four tiers, so the brain starts from a full picture. */
    welcomed(): void {
      roundsUntilDue.medium = 0;
      roundsUntilDue.slow = 0;
      staticToSend = true;
    },

    /** One round, over within 2 s: the fast tier first (the heartbeat), then each other tier that is due. */
    async takeRound(send: (message: SnapshotMessage) => void): Promise<void> {
      const roundStartedAtMs = Date.now();
      const roundEndsAtMs = roundStartedAtMs + SNAPSHOT_ROUND_MS;
      const fastReport = await runWorker("fast", roundEndsAtMs);
      const fastData: FastSnapshotData = {
        degradedTiers: [...degradedTiers],
        pageHeapUsedBytes: pageHeapUsedBytes(),
        game: fastReport ? (fastReport.data as FastWorkerData) : null,
      };
      send(snapshot("fast", fastReport ? fastReport.gameTimeMs : roundStartedAtMs, fastData));

      for (const tier of ["medium", "slow"] as const) {
        if (roundsUntilDue[tier] > 0) {
          roundsUntilDue[tier] -= 1;
          continue;
        }
        // A tier that fails stays due, so it's tried again next round.
        const report = await runWorker(tier, roundEndsAtMs);
        if (report === null) continue;
        send(snapshot(tier, report.gameTimeMs, report.data));
        roundsUntilDue[tier] = ROUNDS_BETWEEN[tier] - 1;
      }

      staticReport ??= await runWorker("static", roundEndsAtMs);
      if (staticReport !== null && staticToSend) {
        send(snapshot("static", staticReport.gameTimeMs, staticReport.data));
        staticToSend = false;
      }
    },
  };
}
