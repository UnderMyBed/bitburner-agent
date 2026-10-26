// The Agent's snapshotter (#89, architecture §5.2): runs one round of snapshots every 2 s while welcomed. Each tier's
// data comes from a short-lived worker script, so the Agent itself stays small:
// - fast, every round, always sent (the heartbeat), even when its worker can't run;
// - static, once per Agent start (resent from memory after each welcome);
// - medium every 10 s, slow every 60 s.
// Workers run one at a time, as temporary scripts, and report through a port. A worker that can't start (no RAM) or
// doesn't report within 5 s leaves its tier skipped and named in `degradedTiers` until it next succeeds.
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
const WORKER_TIMEOUT_MS = 5_000;
const SLOW_INTERVAL_MS = 60_000;
const MEDIUM_INTERVAL_MS = 10_000;

/** The page's JS heap, where the browser reports it (Chromium does; the simulator doesn't). */
function pageHeapUsedBytes(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

export function createSnapshotter(
  ns: NS,
  { deploymentId, agentSessionId }: { deploymentId: string; agentSessionId: string },
) {
  const lastSequenceNumbers: Record<SnapshotTier, number> = { static: 0, slow: 0, medium: 0, fast: 0 };
  const nextDueAtMs = { slow: 0, medium: 0 };
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

  /** Waits for the report of the worker with this pid, or null after the timeout. */
  async function reportFrom(port: ReturnType<NS["getPortHandle"]>, workerPid: number) {
    const deadlineMs = Date.now() + WORKER_TIMEOUT_MS;
    for (;;) {
      while (!port.empty()) {
        const report = port.read() as SnapshotWorkerReport;
        if (report.workerPid === workerPid) return report;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) return null;
      // `asleep`, not `sleep`: a `sleep` that loses the race keeps the script marked busy until it ends, and the
      // game kills a busy script for its next `ns` call (NetscriptHelpers.tsx:405-431). `asleep` doesn't mark it.
      await Promise.race([port.nextWrite(), ns.asleep(remainingMs)]);
    }
  }

  async function runWorker(tier: SnapshotTier): Promise<SnapshotWorkerReport | null> {
    const port = ns.getPortHandle(SNAPSHOT_WORKER_PORT);
    const workerFile = deployedFilePath(deploymentId, snapshotWorkerFileName(tier));
    const workerPid = ns.run(workerFile, { temporary: true });
    const report = workerPid === 0 ? null : await reportFrom(port, workerPid);
    const wasDegraded = degradedTiers.has(tier);
    // Logged on a change only, so a long spell on a full home doesn't flood the log.
    if (report === null) {
      degradedTiers.add(tier);
      const why = workerPid === 0 ? "couldn't start" : "didn't report";
      if (!wasDegraded) ns.print(`agent: the ${tier} tier is skipped: ${workerFile} ${why}`);
    } else {
      degradedTiers.delete(tier);
      if (wasDegraded) ns.print(`agent: the ${tier} tier is back`);
    }
    return report;
  }

  return {
    /** After every welcome, the next round sends all four tiers, so the brain starts from a full picture. */
    welcomed(): void {
      nextDueAtMs.slow = 0;
      nextDueAtMs.medium = 0;
      staticToSend = true;
    },

    /** One round: the fast tier first (the heartbeat), then each other tier that is due. */
    async takeRound(send: (message: SnapshotMessage) => void): Promise<void> {
      const roundStartedAtMs = Date.now();
      const fastReport = await runWorker("fast");
      const fastData: FastSnapshotData = {
        degradedTiers: [...degradedTiers],
        pageHeapUsedBytes: pageHeapUsedBytes(),
        game: fastReport ? (fastReport.data as FastWorkerData) : null,
      };
      send(snapshot("fast", fastReport ? fastReport.gameTimeMs : roundStartedAtMs, fastData));

      staticReport ??= await runWorker("static");
      if (staticReport !== null && staticToSend) {
        send(snapshot("static", staticReport.gameTimeMs, staticReport.data));
        staticToSend = false;
      }
      for (const [tier, intervalMs] of [
        ["slow", SLOW_INTERVAL_MS],
        ["medium", MEDIUM_INTERVAL_MS],
      ] as const) {
        if (roundStartedAtMs < nextDueAtMs[tier]) continue;
        nextDueAtMs[tier] = roundStartedAtMs + intervalMs;
        const report = await runWorker(tier);
        if (report !== null) send(snapshot(tier, report.gameTimeMs, report.data));
      }
    },
  };
}
