// Snapshot data for the brain's rule and controller tests (#134, #136, #138), in the shape the Agent's workers send.
import type { MediumSnapshotData, SlowSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import type { AugmentationsView } from "../../src/augmentations.ts";
import type { FactionsView } from "../../src/factions.ts";

/** The brain's factions view with nothing to show (#203): for statuses built in tests that aren't about it. */
export const QUIET_FACTIONS_VIEW: FactionsView = {
  enabled: true,
  waiting: true,
  joining: null,
  leftToOwner: [],
  choice: null,
  sent: false,
  waitingFor: null,
};

type StaticServer = StaticSnapshotData["servers"][number];

/** A server as the static snapshot has it: the game's own, hackable at level 1, no ports, growth 10. */
export const staticServer = (hostname: string, changes: Partial<StaticServer> = {}): StaticServer => ({
  hostname,
  purchasedByPlayer: false,
  moneyMax: 1_000_000,
  minDifficulty: 1,
  requiredHackingSkill: 1,
  numOpenPortsRequired: 0,
  serverGrowth: 10,
  ...changes,
});

/**
 * A medium snapshot: the player's hacking level, each server rooted or not (16 GB each), and the player's money, city
 * and hacking programs (none, by default). `homeRam` sets home's RAM, adding home if `rooted` doesn't name it.
 */
export const mediumData = (
  hacking: number,
  rooted: Record<string, boolean>,
  {
    money = 0,
    city = "Sector-12",
    hasTorRouter = false,
    programs = [],
    homeRam,
    factions = [],
  }: {
    money?: number;
    city?: string;
    hasTorRouter?: boolean;
    programs?: string[];
    homeRam?: number;
    /** The factions joined (#147). */
    factions?: string[];
  } = {},
): MediumSnapshotData => ({
  player: { skills: { hacking }, money, city, factions },
  hasTorRouter,
  programs,
  servers: Object.entries(homeRam === undefined ? rooted : { home: true, ...rooted }).map(
    ([hostname, hasAdminRights]) => ({
      hostname,
      maxRam: hostname === "home" && homeRam !== undefined ? homeRam : 16,
      cpuCores: 1,
      hasAdminRights,
      backdoorInstalled: false,
      moneyAvailable: 0,
      hackDifficulty: 1,
    }),
  ),
});

/** A slow snapshot: the BitNode the player is in (BN1 by default) and its options. */
export const slowData = (currentNode = 1, bitNodeOptions: Record<string, unknown> = {}): SlowSnapshotData => ({
  resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode, ownedAugs: {}, ownedSF: {}, bitNodeOptions },
  purchasedServers: [],
  factions: { backend: "sim", state: { joined: [], invitations: [], queuedAugmentations: [] }, problem: null },
});

/** The augmentations' view (#210) with nothing to show: on, waiting for the snapshots. */
export const idleAugmentations: AugmentationsView = {
  enabled: true,
  waiting: true,
  committed: false,
  asking: null,
  set: [],
  setCost: 0,
  decision: null,
  waitingFor: null,
  notQueued: [],
  reserve: 0,
};
