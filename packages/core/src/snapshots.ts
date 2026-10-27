/**
 * Snapshots (#89, architecture §5.2): what each tier's worker reports, and how it reaches the Agent. Shared by the
 * in-game workers and the brain; in-game code bundles it, so its names must not collide with NS function names
 * (packages/ingame/README.md, "RAM"). Server and player fields keep the game's own names (`ns.getServer`,
 * `ns.getPlayer`).
 */
import type { SnapshotTier } from "./control-protocol.ts";

/** The in-game port the snapshot workers write to and the Agent reads. Nothing else uses it (the fork uses no ports). */
export const SNAPSHOT_WORKER_PORT = 89_001;

/** A tier's worker script, inside a deployment's folder: `snapshot-<tier>.js`. */
export function snapshotWorkerFileName(tier: SnapshotTier): string {
  return `snapshot-${tier}.js`;
}

/** What a worker writes to the port. `workerPid` tells the Agent it's the worker it just started. */
export interface SnapshotWorkerReport {
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

/** slow: every 60 s. `ns.getResetInfo()` (its Maps as objects) and the purchased servers. */
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
}

/** medium: every 10 s. `ns.getPlayer()` whole, and every reachable server's RAM, cores, money, security and access. */
export interface MediumSnapshotData {
  /** Skills, exp, money, city, location, factions, jobs, karma, multipliers and the rest of `ns.getPlayer()`. */
  player: Record<string, unknown>;
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
}
