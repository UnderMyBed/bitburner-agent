/**
 * Snapshots (#89, architecture §5.2): what each tier's worker reports, and how it reaches the Agent. Shared by the
 * in-game workers and the brain; in-game code bundles it, so its names must not collide with NS function names
 * (packages/ingame/README.md, "RAM"). Server and player fields keep the game's own names (`ns.getServer`,
 * `ns.getPlayer`).
 */
import type { BatcherDeployReport, BatcherHealth } from "./batcher.ts";
import type { SnapshotTier } from "./control-protocol.ts";
import type { FactionStateReading } from "./faction-state.ts";
import type { IntentOutcome } from "./intents.ts";
import type { WorkOutcome } from "./work.ts";

/**
 * The in-game port every home worker reports on (the snapshot workers, and the hack loop's, #134), and the Agent reads.
 * Nothing else uses it (the fork uses no ports).
 */
export const WORKER_REPORT_PORT = 89_001;

/** A tier's worker script, inside a deployment's folder: `snapshot-<tier>.js`. */
export function snapshotWorkerFileName(tier: SnapshotTier): string {
  return `snapshot-${tier}.js`;
}

/** What a home worker writes to the port. `workerPid` tells the Agent it's the worker it just started. */
export interface WorkerReport {
  workerPid: number;
  /** The game's `Date.now()` when the worker read the game. */
  gameTimeMs: number;
  data: unknown;
}

/**
 * static: once per Agent start. Every server `scan` reaches from home at that time, with the fields that never change
 * for a server. Servers that appear later (purchased ones, darkweb) are in medium.
 */
export interface StaticSnapshotData {
  servers: {
    hostname: string;
    purchasedByPlayer: boolean;
    /**
     * Absent for Hacknet servers only. Home and purchased servers have the game's defaults (`moneyMax` 0, so they
     * can't be hacked; `numOpenPortsRequired` 5).
     */
    moneyMax?: number;
    minDifficulty?: number;
    requiredHackingSkill?: number;
    numOpenPortsRequired?: number;
    /** How fast its money grows back (#134): the hack loop's target rule weighs it. */
    serverGrowth?: number;
  }[];
}

/**
 * slow: every 60 s. `ns.getResetInfo()` (its Maps as objects), the purchased servers, and the money by source, from the
 * slow worker; and the faction state (#197), read after it by the Agent's faction state reader.
 */
export interface SlowSnapshotData {
  resetInfo: {
    lastAugReset: number;
    lastNodeReset: number;
    currentNode: number;
    /** Installed augmentation → level. */
    ownedAugs: Record<string, number>;
    /** Source-File number → level. */
    ownedSF: Record<string, number>;
    bitNodeOptions: Record<string, unknown>;
  };
  purchasedServers: string[];
  /**
   * Each joined faction's reputation and favour, the invitations and the queued augmentations (#197), or why they
   * couldn't be read. Absent from an older Agent, and from the slow worker's own report (the Agent adds it).
   */
  factions?: FactionStateReading;
  /**
   * `ns.getMoneySources().sinceInstall` (#196): money made (and spent, as negatives) by source since the last install,
   * which resets it (PlayerObjectGeneralMethods.ts:128). `hacking` is every hack's money. Absent from an older Agent.
   */
  moneySources?: Record<string, number>;
}

/** medium: every 10 s. `ns.getPlayer()` whole, and every reachable server's RAM, cores, money, security and access. */
export interface MediumSnapshotData {
  /** Skills, exp, money, city, location, factions, jobs, karma, multipliers and the rest of `ns.getPlayer()`. */
  player: Record<string, unknown>;
  /** Whether the player owns the TOR router (#136). */
  hasTorRouter: boolean;
  /** The port openers on home, of `PORT_OPENER_PROGRAMS` (#136). */
  programs: string[];
  servers: {
    hostname: string;
    /** These change: home's RAM and cores with upgrades, purchased servers' RAM with theirs. */
    maxRam: number;
    cpuCores: number;
    hasAdminRights: boolean;
    /** These three are absent for Hacknet servers only. */
    backdoorInstalled?: boolean;
    moneyAvailable?: number;
    hackDifficulty?: number;
  }[];
}

/** What the fast tier's worker reads: money, home's RAM, and the scripts running on home. */
export interface FastWorkerData {
  money: number;
  /** Including the Agent and this worker. */
  homeRamUsed: number;
  homeMaxRam: number;
  /** `temporary` scripts aren't saved, so a reload doesn't bring them back. */
  homeProcesses: {
    pid: number;
    filename: string;
    threads: number;
    args: (string | number | boolean)[];
    temporary: boolean;
  }[];
}

/** fast: every 2 s, always sent (the heartbeat), with what the Agent knows itself. */
export interface FastSnapshotData {
  /** Tiers whose last attempt couldn't run its worker, or timed out (the fast tier included). */
  degradedTiers: SnapshotTier[];
  /** The page's JS heap (`performance.memory.usedJSHeapSize`); null where the browser has none. */
  pageHeapUsedBytes: number | null;
  /** The fast worker's data; null when it couldn't run. */
  game: FastWorkerData | null;
  /** Every intent the Agent holds, in order, and how it went (#141). */
  intents: IntentOutcome[];
  /**
   * The game's dialogs (#143): those handled since the last fast snapshot (the latest 100, #160), and the text of one
   * left open, or null.
   */
  dialogs: { handled: HandledDialog[]; blocking: string | null };
  /** How the work the brain wants went (#151): null while it wants none, or absent from an older Agent. */
  work?: WorkOutcome | null;
  /**
   * The batcher's health (#205), as it last wrote it on its port, or null with none there; absent from an older Agent.
   * The Agent's word for what the batcher wrote: read with care.
   */
  batcher?: BatcherHealth | null;
  /**
   * The batcher's deploy worker's last report while the brain wants it running (#211): where it runs, or why it
   * can't; null with none wanted or no report yet, absent from an older Agent. Sent but not running is an alert, and
   * a failure of the run report after 3 fast snapshots in a row.
   */
  batcherDeploy?: BatcherDeployReport | null;
  /**
   * The brain's last message the Agent refused as not valid (#194's review), with why, and how many it has refused
   * since it connected: it acts on the last one it took meanwhile. Null once a desired state is taken again, or absent
   * from an older Agent.
   */
  refusedMessage?: RefusedBrainMessage | null;
}

/** A brain message the Agent refused (#194's review): `parseBrainMessage`'s reason, and the count so far. */
export interface RefusedBrainMessage {
  reason: string;
  count: number;
}

/** How much of a refused message's reason the Agent reports. */
export const MAX_REFUSED_REASON_LENGTH = 500;

/** A dialog of the game's the Agent handled (#143, owner decision 35), and what it said. */
export interface HandledDialog {
  /** A game alert, closed; or a faction invitation, answered "Decide later". */
  kind: "alert" | "factionInvitation";
  /** Its text, cut to `MAX_DIALOG_TEXT_LENGTH`. */
  text: string;
}

/** How much of a dialog's text the Agent reports. */
export const MAX_DIALOG_TEXT_LENGTH = 1_000;
