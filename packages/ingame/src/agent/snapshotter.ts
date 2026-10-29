// The Agent's snapshotter (#89, architecture §5.2): runs one round of snapshots every 2 s while welcomed (with no
// brain, in safe mode, only the slow worker, once, unsent: #160). Each tier's data comes from a short-lived worker
// script, so the Agent itself stays small:
// - fast, every round, always sent (the heartbeat), even when its worker can't run;
// - medium every 5th round (10 s), slow every 30th (60 s), both in the first round after each welcome;
// - static, once per Agent start, resent from memory after each welcome.
// The slow snapshot also carries the faction state (#197), read just after the slow worker by the Agent's reader
// (./faction-state.ts); read or not, it goes with the slow worker's data, saying why where it couldn't be read.
// Workers run one at a time (but the Singularity backdoor's, which outlives its round, #162), as temporary scripts, and
// report through a port. Every wait ends with the round, so a
// round never runs past 2 s and the heartbeat is never more than two rounds apart. A tier whose worker can't start,
// doesn't report in time, or is still running from before is skipped, named in `degradedTiers`, and tried again next
// round, until it succeeds.
import {
  CONTROL_PROTOCOL_VERSION,
  deployedFilePath,
  type FactionStateReading,
  type FastSnapshotData,
  type FastWorkerData,
  type IntentOutcome,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  type SnapshotMessage,
  type SnapshotTier,
  snapshotWorkerFileName,
  type WorkerReport,
  type WorkOutcome,
} from "@bitburner-agent/core";
import type { NS } from "../ns.ts";
import { type WorkerRunner, whyNoReport } from "./run-worker.ts";

export const SNAPSHOT_ROUND_MS = SNAPSHOT_TIER_PERIOD_MS.fast;
/** Rounds from one snapshot of the tier to the next. */
const ROUNDS_BETWEEN = {
  medium: SNAPSHOT_TIER_PERIOD_MS.medium / SNAPSHOT_ROUND_MS,
  slow: SNAPSHOT_TIER_PERIOD_MS.slow / SNAPSHOT_ROUND_MS,
} as const;

/** The page's JS heap, where the browser reports it (Chromium does; the simulator doesn't). */
function pageHeapUsedBytes(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

/**
 * Whether the game has Singularity (#145): in BN4, or with SF4 at any level, as the slow snapshot `slowData` says. The
 * game's `ownedSF` holds only levels above 0, after any `sourceFileOverrides` (`NetscriptFunctions.ts:1491`), as its own
 * access check does. No slow snapshot yet is no Singularity: the page works either way.
 */
export function singularityAvailableIn(slowData: SlowSnapshotData | null): boolean {
  const resetInfo = slowData?.resetInfo;
  return resetInfo?.currentNode === 4 || (resetInfo?.ownedSF?.["4"] ?? 0) >= 1;
}

export function createSnapshotter(
  ns: NS,
  {
    deploymentId,
    agentSessionId,
    workerRunner,
    intentOutcomes,
    workOutcome,
    dialogReport,
    readFactions,
  }: {
    deploymentId: string;
    agentSessionId: string;
    workerRunner: WorkerRunner;
    /** How the intents went (#141), for the fast snapshot. */
    intentOutcomes: () => IntentOutcome[];
    /** How the work went (#151), for the fast snapshot: null while the brain wants none. */
    workOutcome: () => WorkOutcome | null;
    /** The game's dialogs handled since the last fast snapshot, and one left open (#143). */
    dialogReport: () => FastSnapshotData["dialogs"];
    /** The faction state, read within the deadline, for each slow snapshot (#197). */
    readFactions: (deadlineMs: number) => Promise<FactionStateReading>;
  },
) {
  const lastSequenceNumbers: Record<SnapshotTier, number> = { static: 0, slow: 0, medium: 0, fast: 0 };
  /** 0: due this round. */
  const roundsUntilDue = { medium: 0, slow: 0 };
  const degradedTiers = new Set<SnapshotTier>();
  let staticReport: WorkerReport | null = null;
  /** The latest slow snapshot's data, for what the Agent decides from it (Singularity, #145). */
  let lastSlowData: SlowSnapshotData | null = null;
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

  async function runTierWorker(tier: SnapshotTier, deadlineMs: number): Promise<WorkerReport | null> {
    const workerFile = deployedFilePath(deploymentId, snapshotWorkerFileName(tier));
    const workerRun = await workerRunner.runWorker(workerFile, [], deadlineMs);
    if (workerRun.outcome !== "reported") return skipped(tier, whyNoReport(workerRun, workerFile));
    if (degradedTiers.delete(tier)) ns.print(`agent: the ${tier} tier is back`);
    return workerRun.report;
  }

  return {
    /**
     * Whether the game has Singularity (#145): in BN4, or with SF4 at any level, as the latest slow snapshot says. No
     * slow snapshot yet is no Singularity: the page works either way.
     */
    /** Whether the game has Singularity, as the latest slow snapshot says (`singularityAvailableIn`). */
    singularityAvailable: () => singularityAvailableIn(lastSlowData),

    /** The game's `lastAugReset`, from the latest slow snapshot, or null before the first (safe mode's check, #160). */
    lastAugReset: (): number | null => lastSlowData?.resetInfo.lastAugReset ?? null,

    /**
     * With no brain (safe mode, #160): the slow worker's data, unsent, if the Agent has none yet, for the reset check
     * and Singularity's availability. Neither changes without a reset, which means a new Agent, so once is enough.
     */
    async readSlowTierIfNone(deadlineMs: number): Promise<void> {
      if (lastSlowData !== null) return;
      const report = await runTierWorker("slow", deadlineMs);
      if (report !== null) lastSlowData = report.data as SlowSnapshotData;
    },

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
      const fastReport = await runTierWorker("fast", roundEndsAtMs);
      const fastData: FastSnapshotData = {
        degradedTiers: [...degradedTiers],
        pageHeapUsedBytes: pageHeapUsedBytes(),
        game: fastReport ? (fastReport.data as FastWorkerData) : null,
        intents: intentOutcomes(),
        dialogs: dialogReport(),
        work: workOutcome(),
      };
      send(snapshot("fast", fastReport ? fastReport.gameTimeMs : roundStartedAtMs, fastData));

      for (const tier of ["medium", "slow"] as const) {
        if (roundsUntilDue[tier] > 0) {
          roundsUntilDue[tier] -= 1;
          continue;
        }
        // A tier that fails stays due, so it's tried again next round.
        const report = await runTierWorker(tier, roundEndsAtMs);
        if (report === null) continue;
        let data = report.data;
        if (tier === "slow") {
          // Kept first: the reader's backend depends on it (Singularity, #145), so the first read already knows.
          lastSlowData = report.data as SlowSnapshotData;
          lastSlowData = { ...lastSlowData, factions: await readFactions(roundEndsAtMs) };
          data = lastSlowData;
        }
        send(snapshot(tier, report.gameTimeMs, data));
        roundsUntilDue[tier] = ROUNDS_BETWEEN[tier] - 1;
      }

      staticReport ??= await runTierWorker("static", roundEndsAtMs);
      if (staticReport !== null && staticToSend) {
        send(snapshot("static", staticReport.gameTimeMs, staticReport.data));
        staticToSend = false;
      }
    },
  };
}
