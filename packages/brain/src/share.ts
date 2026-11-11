// Sharing spare RAM for faction reputation (#224, M4 phase A): the brain's side. `ns.share()` raises the reputation
// every faction work earns while it runs (core's share.ts), so while the player works for a faction, whether the
// brain's work or the owner's, the brain asks the batcher, which owns its hosts' RAM, to share what its batches leave
// (`sharingConfigOf`, sent in its config). Its health reports the threads and the bonus, which the brain counts in its
// faction work's rate (`shareBonusOf`, ./factions.ts). The dashboard's switch, on by default (owner decision 52),
// turns it off. With the batcher off, nothing shares: the hack loop's hosts are the hack loop's.
import {
  type BatcherConfig,
  type BatcherHealth,
  type BitNodeHackingMultipliers,
  batchHoldsMs,
  batchPeakRamGb,
  batchThreads,
  hackThreadsForShare,
  type MediumSnapshotData,
  SHARE_RAM_GB,
  SHARE_TIME_MS,
  type SharingConfig,
  type SharingHealth,
  SINGULARITY_LARGEST_WORKER_GB,
  type SlowSnapshotData,
  shareBonus,
  shareReserveGb,
  singularityRamMultiplier,
  singularityWorkerRamGb,
  threadsThatFit,
  type Work,
} from "@bitburner-agent/core";
import { HOME_KEPT_FOR_THE_AGENT_GB, hackingPlayerOf } from "./batcher.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";
import { reportedWorkOutcome } from "./work.ts";

/** The dashboard's switch (#224, owner decision 52): on unless the owner turned it off. */
export const SHARE_ENABLED_SETTING = "share.enabled";

export function readShareEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, SHARE_ENABLED_SETTING, true);
}

export function writeShareEnabled(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, SHARE_ENABLED_SETTING, enabled);
}

/**
 * What home keeps free of share threads for the Agent's workers (#226's review), GB: 4 times what the Agent and its
 * largest fresh-save worker take (`HOME_KEPT_FOR_THE_AGENT_GB`), as a page backdoor's worker can outlive its round
 * beside the next round's. Nothing beside a home of 1 PB.
 */
export const SHARE_HOME_KEPT_GB = 4 * HOME_KEPT_FOR_THE_AGENT_GB;

/**
 * Whether the player works for a faction now (#224): the work the brain sends (the owner's on the dashboard, or its
 * own) is faction work, and the Agent's fast snapshot says the game showed it at its last look. The game's
 * `getPlayer()` has no current work (NetscriptFunctions.ts:1417-1436), so this is the brain's word and the Agent's: work
 * started by hand in the game isn't seen. The Agent looks every 30 s (ingame's work.ts), so work stopped by hand is seen
 * stopped within about 30 s, a medium snapshot later the config drops `sharing`, and 10 s later the last round ends:
 * about 40 s at most.
 */
export function factionWorkGoingOn(work: Work | null, outcome: unknown): boolean {
  return work?.kind === "faction" && reportedWorkOutcome(outcome)?.converged === true;
}

/**
 * The batcher config's `sharing` (#224), or null without the player's hacking figures in the medium snapshot: the
 * reserve (core's `shareReserveGb`) for the batches' peak on the config's plan, at the snapshot's hacking level, and
 * the next target's RAM; what home keeps for the Agent, which shares the rest beside the hosts (#226's review: after an
 * install, home is most of the RAM): `SHARE_HOME_KEPT_GB`, and with Singularity (`singularityMultiplier`, its
 * functions' RAM multiplier, `singularityRamMultiplierOf`) the most its largest worker takes beside that (#242's
 * review): the Agent starts its workers only in home's free RAM (ingame's effector-runner.ts), and the largest, the
 * destroy, takes 33.9 GB at SF4.3, at most 518.4 GB at SF4.1; not all of home, which would leave it idle as run #3's
 * was. And the cores over 1 of the hosts and home, as the medium snapshot shows them, for the bonus the batcher
 * reports.
 */
export function sharingConfigOf(
  config: BatcherConfig,
  mediumData: MediumSnapshotData,
  hacking: BitNodeHackingMultipliers,
  singularityMultiplier: number | null = null,
): SharingConfig | null {
  // The BitNode's hacking multipliers folded in (#321), as the batcher's own plan has them.
  const player = hackingPlayerOf(mediumData.player, hacking);
  if (player === null) return null;
  const { figures, hackShare, spacingMs } = config;
  const threads = batchThreads(figures, player, hackThreadsForShare(hackShare, figures, player));
  const peakGb = batchPeakRamGb(threads, batchHoldsMs(figures, player, threads), spacingMs);
  const cores: Record<string, number> = {};
  for (const server of mediumData.servers) {
    const count = server?.cpuCores;
    const shared = config.hosts.includes(server?.hostname) || server?.hostname === "home";
    if (shared && typeof count === "number" && Number.isFinite(count) && count > 1) cores[server.hostname] = count;
  }
  return {
    reserveGb: shareReserveGb(peakGb, config.next?.ramGb ?? 0),
    homeKeptGb: homeKeptGbOf(singularityMultiplier),
    cores,
  };
}

/**
 * What home keeps for the Agent and its workers beside the batcher's share threads (#226's review, #242's), and beside
 * levelling mode's loops (#336): `SHARE_HOME_KEPT_GB`, and with Singularity (`singularityMultiplier`) the most its
 * largest worker takes beside that; the rest of home is what the batcher may use.
 */
export function homeKeptGbOf(singularityMultiplier: number | null): number {
  return singularityMultiplier === null
    ? SHARE_HOME_KEPT_GB
    : SHARE_HOME_KEPT_GB + singularityWorkerRamGb(SINGULARITY_LARGEST_WORKER_GB, singularityMultiplier);
}

/**
 * Home's batches against its share while sharing is asked (#340's review). **A placeholder** until the planner (owner
 * decision 67) splits home's RAM between batching, levelling and sharing: home stays among the batcher's hosts only if
 * the batches' income with it gains more, relatively, than the share on home's RAM would raise faction work's
 * reputation: income with home / income without, less 1, above the share's bonus on home's threads and cores (core's
 * `shareBonus`, `NetworkShare/Share.ts:22-24,43-48`) less 1, as reputation a second is the bonus times
 * (`PersonObjects/formulas/reputation.ts:15-22`). Run #3's late shape, a 64 TB home beside 1.6 PB of cloud servers,
 * gains at most 4% income against x1.388's 38.8%: home shares. After an install, with home most of the RAM, the batches
 * gain several times over: home batches. Without income without home (none planned), home batches.
 */
export function homeBatchesWhileSharing({
  withHomeIncomePerSecond,
  withoutHomeIncomePerSecond,
  homeShareGb,
  homeCores,
  intelligence,
}: {
  withHomeIncomePerSecond: number;
  withoutHomeIncomePerSecond: number;
  /** Home's RAM the share would take beside the batches' hosts: beyond what it keeps, and the batcher's budget there. */
  homeShareGb: number;
  homeCores: number;
  intelligence: number;
}): { batches: boolean; incomeGain: number; shareGain: number } {
  const incomeGain =
    withoutHomeIncomePerSecond > 0
      ? withHomeIncomePerSecond / withoutHomeIncomePerSecond - 1
      : withHomeIncomePerSecond > 0
        ? Number.POSITIVE_INFINITY
        : 0;
  const threads = threadsThatFit(Math.max(0, homeShareGb), SHARE_RAM_GB);
  const shareGain = shareBonus([{ threads, cores: homeCores }], intelligence) - 1;
  return { batches: incomeGain > shareGain, incomeGain, shareGain };
}

/** Whether the game has Singularity (#226's review): in BN4, or with SF4, as the slow snapshot's reset info says. */
export function singularityInEffect(slowData: SlowSnapshotData | null): boolean {
  const info = slowData?.resetInfo;
  return info?.currentNode === 4 || (info?.ownedSF?.["4"] ?? 0) > 0;
}

/**
 * The game's multiplier on Singularity functions' RAM where it has Singularity (#242's review: core's
 * `singularityRamMultiplier`, at the SF4 level owned), or null where it hasn't.
 */
export function singularityRamMultiplierOf(slowData: SlowSnapshotData | null): number | null {
  if (!singularityInEffect(slowData)) return null;
  const info = slowData?.resetInfo;
  return singularityRamMultiplier(info?.currentNode ?? 0, info?.ownedSF?.["4"] ?? 0);
}

/**
 * The batcher health's sharing, or null if it says none or isn't one (the Agent's word: checked as it's read). A
 * batcher before #230 doesn't say how much is on its hosts: all of its RAM counts, as it could take a batch's. The
 * bonus possible and home's RAM (#242) are kept only as numbers of 0 or more: absent from a batcher before #242.
 */
export function sharingOf(health: unknown): SharingHealth | null {
  const sharing = (health as { sharing?: unknown } | null)?.sharing as Record<string, unknown> | null | undefined;
  if (typeof sharing !== "object" || sharing === null || typeof sharing.wanted !== "boolean") return null;
  const hostsRamGb = sharing.hostsRamGb === undefined ? sharing.ramGb : sharing.hostsRamGb;
  const isAmount = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const numbers = [sharing.threads, sharing.ramGb, hostsRamGb, sharing.bonus, sharing.roomGb];
  if (!numbers.every(isAmount)) return null;
  const { possibleBonus, homeGb, homeFreeGb, homeKeptGb, ...rest } = sharing;
  return {
    ...(rest as unknown as SharingHealth),
    hostsRamGb: hostsRamGb as number,
    ...(isAmount(possibleBonus) ? { possibleBonus } : {}),
    ...(isAmount(homeGb) && isAmount(homeFreeGb) ? { homeGb, homeFreeGb } : {}),
    ...(isAmount(homeKeptGb) ? { homeKeptGb } : {}),
  };
}

/**
 * How old a batcher health may be, by the game's clock, and its sharing still count (#226's review): sharing, it's
 * written as its count changes, at least every round's 10 s; older, the batcher has stopped (crashed, killed).
 */
export const SHARE_HEALTH_STALE_MS = 2 * SHARE_TIME_MS;

/**
 * The share bonus the brain counts in its faction work's rate (#224): the one the batcher reports for the threads it
 * has running, while they run; 1 with none, no batcher health, a health older than `SHARE_HEALTH_STALE_MS` at
 * `gameTimeMs` (the fast snapshot's), or the batcher reported not running (`notRunning`, #226's review).
 */
export function shareBonusOf(
  health: BatcherHealth | null,
  gameTimeMs: number | null = null,
  notRunning = false,
): number {
  const sharing = sharingOf(health);
  if (sharing === null || notRunning || !(sharing.threads > 0 && sharing.bonus >= 1)) return 1;
  const atMs = health?.atMs;
  if (gameTimeMs !== null && !(typeof atMs === "number" && gameTimeMs - atMs <= SHARE_HEALTH_STALE_MS)) return 1;
  return sharing.bonus;
}

/** Sharing on the dashboard (#224): the switch, why it isn't asked for while on, and the batcher's last report. */
export interface ShareView {
  enabled: boolean;
  /** Asked of the batcher now. */
  asked: boolean;
  /**
   * Why not, while on: no faction work going on, the batcher isn't sent, the medium snapshot has no hacking figures,
   * or the Agent's snapshots are still awaited; null when asked, or off.
   */
  why: string | null;
  /** The batcher's sharing in its latest health, or null. */
  sharing: SharingHealth | null;
}
