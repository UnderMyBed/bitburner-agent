// Sharing spare RAM for faction reputation (#224, M4 phase A): the brain's side. `ns.share()` raises the reputation
// every faction work earns while it runs (core's share.ts), so while the player works for a faction, whether the
// brain's work or the owner's, the brain asks the batcher, which owns its hosts' RAM, to share what its batches leave
// (`sharingConfigOf`, sent in its config). Its health reports the threads and the bonus, which the brain counts in its
// faction work's rate (`shareBonusOf`, ./factions.ts). The dashboard's switch, on by default (owner decision 52),
// turns it off. With the batcher off, nothing shares: the hack loop's hosts are the hack loop's.
import {
  type BatcherConfig,
  type BatcherHealth,
  batchHoldsMs,
  batchPeakRamGb,
  batchThreads,
  hackThreadsForShare,
  type MediumSnapshotData,
  type SharingConfig,
  type SharingHealth,
  shareReserveGb,
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
 * Whether the player works for a faction now (#224): the work the brain sends (the owner's, or its own) is faction
 * work, and the Agent's fast snapshot says the game showed it at its last look. The game's `getPlayer()` has no current
 * work (NetscriptFunctions.ts:1417-1436), so this is the brain's word and the Agent's.
 */
export function factionWorkGoingOn(work: Work | null, outcome: unknown): boolean {
  return work?.kind === "faction" && reportedWorkOutcome(outcome)?.converged === true;
}

/**
 * The batcher config's `sharing` (#224), or null without the player's hacking figures in the medium snapshot: the
 * reserve (core's `shareReserveGb`) for the batches' peak on the config's plan, at the snapshot's hacking level, and
 * the next target's RAM; home's RAM the Agent keeps (`HOME_KEPT_FOR_THE_AGENT_GB`), should home ever be a host; and the
 * hosts' cores over 1, as the medium snapshot shows them, for the bonus the batcher reports.
 */
export function sharingConfigOf(config: BatcherConfig, mediumData: MediumSnapshotData): SharingConfig | null {
  const player = hackingPlayerOf(mediumData.player);
  if (player === null) return null;
  const { figures, hackShare, spacingMs } = config;
  const threads = batchThreads(figures, player, hackThreadsForShare(hackShare, figures, player));
  const peakGb = batchPeakRamGb(threads, batchHoldsMs(figures, player, threads), spacingMs);
  const cores: Record<string, number> = {};
  for (const server of mediumData.servers) {
    const count = server?.cpuCores;
    if (config.hosts.includes(server?.hostname) && typeof count === "number" && Number.isFinite(count) && count > 1) {
      cores[server.hostname] = count;
    }
  }
  return { reserveGb: shareReserveGb(peakGb, config.next?.ramGb ?? 0), homeKeptGb: HOME_KEPT_FOR_THE_AGENT_GB, cores };
}

/** The batcher health's sharing, or null if it says none or isn't one (the Agent's word: checked as it's read). */
export function sharingOf(health: unknown): SharingHealth | null {
  const sharing = (health as { sharing?: unknown } | null)?.sharing as Record<string, unknown> | null | undefined;
  if (typeof sharing !== "object" || sharing === null || typeof sharing.wanted !== "boolean") return null;
  const numbers = [sharing.threads, sharing.ramGb, sharing.bonus, sharing.roomGb];
  if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return sharing as unknown as SharingHealth;
}

/**
 * The share bonus the brain counts in its faction work's rate (#224): the one the batcher reports for the threads it
 * has running, while they run; 1 with none, or no batcher health.
 */
export function shareBonusOf(health: BatcherHealth | null): number {
  const sharing = sharingOf(health);
  return sharing !== null && sharing.threads > 0 && sharing.bonus >= 1 ? sharing.bonus : 1;
}

/** Sharing on the dashboard (#224): the switch, why it isn't asked for while on, and the batcher's last report. */
export interface ShareView {
  enabled: boolean;
  /** Asked of the batcher now. */
  asked: boolean;
  /** Why not, while on: no faction work going on, or no batcher sent; null when asked, or off. */
  why: string | null;
  /** The batcher's sharing in its latest health, or null. */
  sharing: SharingHealth | null;
}
