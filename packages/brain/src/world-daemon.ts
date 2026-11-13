// The World Daemon (#215, M4 phase A slice A8, the last): the path from late game to the end of the BitNode, and the
// destroy. Daedalus's invitation and The Red Pill are A5's and A6's (./factions.ts, ./augmentations.ts); this rule
// reads the path from the snapshots for the dashboard and the run report, asks for the destroy once w0r1d_d43m0n is
// ready, and fails loudly when a step the brain should finish in minutes hasn't.
// - The path: Daedalus's requirements (core's `daedalusRequirements`), its join; The Red Pill's reputation at the
//   joined seller (2.5m in BN1, `Augmentation/Augmentations.ts:1946-1953`), queued or installed. In BN2 with a gang
//   (#334, G5) its seller is the gang's faction (`FactionHelpers.tsx:180-183`), unless Daedalus has reached it, at
//   the cycle's rate (core's `gangRedPillEtaMs`): no Daedalus needed; w0r1d_d43m0n,
//   reachable once The Red Pill is installed (`Prestige.ts:174-182`), rooted (5 ports,
//   `Server/data/servers.ts:1532-1539`: the hack loop's root worker), and the hacking level against its requirement
//   (3000 × the BitNode's `WorldDaemonDifficulty`, `Server/ServerHelpers.ts:383-385`), with the ETA at the measured
//   experience rate.
// - The destroy: `destroyBitNode` (#175, M3), once The Red Pill is installed and w0r1d_d43m0n is rooted at its level,
//   into the BitNode the campaign's order gives (#321, owner decision 66: core's `nextBitNodeOf`, from the last slow
//   snapshot's Source-Files), fixed as it's asked for; the controller queues it through its gate (two medium snapshots
//   of the preconditions, a save backup). Asked for, it's held until a slow snapshot shows another `lastNodeReset`, as
//   the install's is.
// - The dashboard's switch ("Stop destroying the BitNode", `worldDaemon.enabled`), on by default (owner decision 50).
//   The next BitNode follows the order: BN4 while Source-File 4 is short of 3, then BN1, then BN5 (owner decision 66,
//   superseding 64), the BitNodes the brain can't play yet skipped and said (#323: core's `describeSkipped`). Another
//   is the owner's: `destroyBitNode` queued by hand goes instead. With nothing playable left in the order to gain, the
//   destroy goes ahead all the same, into BN1, a replay (#311): BN1 played again from its start for the run (the stop
//   at the BitNode's end, if the owner set it, fires on it: ./bitnode-end.ts).
// - Daedalus's count (#228): short of it (core's `daedalusCountOf`), the path says how many more augmentations are
//   within reach and where (./invitations.ts's `daedalusReach`, the city group the brain chose). An install while short
//   that adds none to the count (NeuroFlux Governor's levels count once: run #2's nine NeuroFlux-only installs at 23)
//   is "Daedalus count stuck" (the `daedalusCount` stall, at once, a run report failure) only if it passed over one
//   that counts (#238): A6's commit recorded one within reach that the money left after its set would have bought; or
//   A6 installed and its commit kept no facts. Else it's an early NeuroFlux-only install with nothing that counts
//   within reach, as the multipliers climb to the next factions: `daedalusCountNeuroFluxOnly`, the report's
//   information.
// - The Black Ops' route (#398, BN6: core's `winRouteOf`): the path is the route's (./bladeburner-route.ts, from the
//   medium snapshot, at the rates this rule measures): the rank against Operation Daedalus's 400,000, the Black Ops
//   done, the next one's chance, the ETA at the rank measured, and the planner's estimates of both routes. Daedalus,
//   The Red Pill and w0r1d_d43m0n's hacking level are off there, and said so, as are The Red Pill's holds (core's
//   `augmentationEndgame` and `daedalusCountOf`) and levelling (no `daemon` on this path). The destroy is asked for once
//   the reading shows all 21 done (none next), into the order's next BitNode, through the gate as before. Its stalls
//   (decision 45): the rank not rising (any rise from the last reading restarts it, #400's review) within the route's bound (`blackOpsRank`, ./bladeburner-route.ts's
//   `rankStallMs`, while the Bladeburner rule acts), and all 21 done without the destroy (`destroy`, 5 minutes, the Red
//   Pill route's own). A Black Op due and not run is B5's check (./bladeburner-black-ops-report.ts).
import {
  augmentationBitNodeMultipliers,
  augmentationCost,
  augmentationsSoldBy,
  BLACK_OPS_COUNT,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_FACTION_RANK,
  bitNodeUnplayableReason,
  CAMPAIGN_ORDER,
  DAEDALUS,
  daedalusCountOf,
  daedalusMissing,
  daedalusRequirements,
  describeSkipped,
  type FactionState,
  factionReadingOf,
  gangRedPillEtaMs,
  gangSellsRedPill,
  hackingExpForLevel,
  type Intent,
  intentId,
  isBitNodeNumber,
  type JoinedFaction,
  type MediumSnapshotData,
  type NextBitNode,
  nextBitNodeOf,
  type SlowSnapshotData,
  type StaticSnapshotData,
  THE_RED_PILL,
  type WinRoute,
  WORLD_DAEMON,
  winRouteOf,
  worldDaemonProblem,
} from "@bitburner-agent/core";
import type { CountFacts } from "./augmentations.ts";
import { BLADEBURNER_REBUILD_SLACK_MS, type BladeburnerRebuildView } from "./bladeburner.ts";
import type { BlackOpsRouteView } from "./bladeburner-route.ts";
import { describeEta, redPillWork, resetInfoOf, workConditionsOf, workingPersonOf } from "./factions.ts";
import type { GangStallStretch } from "./gang-stalls.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import { type DaedalusReach, daedalusReach, describeReach } from "./invitations.ts";
import { readSwitch, writeSwitch } from "./switches.ts";
import type { TelemetryStore } from "./telemetry-store.ts";

/** The dashboard's switch (#215): on unless turned off. */
export const WORLD_DAEMON_ENABLED_SETTING = "worldDaemon.enabled";

export function readWorldDaemonEnabled(store: TelemetryStore): boolean {
  return readSwitch(store, WORLD_DAEMON_ENABLED_SETTING, true);
}

export function writeWorldDaemonEnabled(store: TelemetryStore, enabled: boolean): void {
  writeSwitch(store, WORLD_DAEMON_ENABLED_SETTING, enabled);
}

/** The brain's destroy (#175's intent) into `nextBitNode` (#321): the owner's into the same BitNode has the same id. */
export function worldDaemonDestroyIntent(nextBitNode: number): Intent {
  return { id: intentId("destroyBitNode", { nextBitNode }), action: "destroyBitNode", args: { nextBitNode } };
}

/**
 * The BitNode a reset note's destroy entered, if it's one the brain's destroy can be (#321, #323: a BitNode of the
 * campaign's order the brain plays), or null: a restarted brain holds its destroy across the reset by it (#215 review).
 */
export function worldDaemonDestroyInto(id: string): number | null {
  const step = CAMPAIGN_ORDER.find((each) => worldDaemonDestroyIntent(each.bitNode).id === id);
  return step !== undefined && bitNodeUnplayableReason(step.bitNode) === null ? step.bitNode : null;
}

/**
 * A step the brain finishes in minutes, not done this long after it could be, is `worldDaemonStalled` (an event, a log
 * line, the dashboard's alert and a run report failure): 5 minutes. A purchase, an install and its restart, a destroy
 * through its gate each take seconds to a couple of minutes.
 */
export const WORLD_DAEMON_STALLED_AFTER_MS = 5 * 60_000;

/** The hacking experience rate's window: the medium snapshots over 10 minutes, a gap over 3 minutes restarting it. */
export const HACKING_EXP_WINDOW_MS = 10 * 60_000;
export const HACKING_EXP_GAP_MS = 3 * 60_000;

/** Stored as a stall starts (#215), for the run report. */
export const WORLD_DAEMON_STALLED_EVENT_KIND = "worldDaemonStalled";
/** Stored by the controller as a destroy goes out (its reset note written): the brain's, or the owner's. */
export const BITNODE_DESTROY_SENT_EVENT_KIND = "bitNodeDestroySent";
/**
 * An install while short of Daedalus's count that added none to it with nothing that counts passed over (#238): the
 * run report's information, never a failure.
 */
export const DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND = "daedalusCountNeuroFluxOnly";

export type WorldDaemonEvent =
  | { type: typeof WORLD_DAEMON_STALLED_EVENT_KIND; atMs: number; step: StallStep; sinceMs: number; detail: string }
  | {
      type: typeof BITNODE_DESTROY_SENT_EVENT_KIND;
      atMs: number;
      source: "brain" | "manual";
      nextBitNode: number;
      /** Why it's a replay (#311, `replayOf`), or null: from the last slow snapshot's BitNode into this one. */
      replay: string | null;
      /** The BitNodes of the order skipped on the way to it, in words (#323, `skippedOf`), or null: none. */
      skipped: string | null;
    }
  | {
      type: typeof DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND;
      atMs: number;
      installed: number;
      required: number;
      /** A6's commit's facts, or null for an install without them (yours, the switch off, an earlier brain's). */
      countFacts: CountFacts | null;
      detail: string;
    };

/**
 * The steps a stall can be on; `daedalusCount` (#228) is "Daedalus count stuck": an install that added none, passing
 * over one that counts (#238).
 */
export type StallStep = "daedalusCount" | "daedalus" | "redPill" | "redPillReputation" | "destroy" | "blackOpsRank";

/**
 * The Red Pill reached, not installed this long after (#215 review): 15 minutes, from "reached". A6's whole commit
 * goes in it: the set, home's RAM and NeuroFlux Governor a purchase at a time, the faction state's next read (a
 * minute), the gate's two medium snapshots and a save backup.
 */
export const RED_PILL_INSTALL_STALLED_AFTER_MS = 15 * 60_000;
/** Daedalus's reputation, The Red Pill short, not risen this long (#215 review): 10 minutes, as A5's stall. */
export const RED_PILL_REPUTATION_STALLED_AFTER_MS = 10 * 60_000;

/** How long each step may take before it's `worldDaemonStalled`. */
const STALLED_AFTER_MS: Record<StallStep, number> = {
  daedalusCount: 0,
  daedalus: WORLD_DAEMON_STALLED_AFTER_MS,
  redPill: RED_PILL_INSTALL_STALLED_AFTER_MS,
  redPillReputation: RED_PILL_REPUTATION_STALLED_AFTER_MS,
  destroy: WORLD_DAEMON_STALLED_AFTER_MS,
  // Its own bound always comes with it (the route's `rankStallMs`).
  blackOpsRank: WORLD_DAEMON_STALLED_AFTER_MS,
};

// Moved to core (#321), with the campaign's order; the name stays here for the campaign model and the tests.
export { SOURCE_FILE_TOP_LEVEL } from "@bitburner-agent/core";

/**
 * The brain's next BitNode (#321, core's `nextBitNodeOf`) from a slow snapshot's `resetInfo`, the Agent's word, so
 * checked: null where its BitNode or Source-Files can't be read.
 */
export function nextBitNodeFrom(resetInfo: unknown): NextBitNode | null {
  const info = resetInfo as { currentNode?: unknown; ownedSF?: unknown } | null | undefined;
  const currentNode = info?.currentNode;
  const ownedSF = info?.ownedSF;
  if (!isBitNodeNumber(currentNode) || typeof ownedSF !== "object" || ownedSF === null) return null;
  if (!Object.values(ownedSF).every((level) => Number.isSafeInteger(level) && (level as number) >= 0)) return null;
  return nextBitNodeOf({ currentNode, ownedSF: ownedSF as Record<string, number> });
}

/**
 * Why a destroy into `nextBitNode` is a replay (#311, kept by #321 for its one case), or null: the brain's next BitNode
 * from `resetInfo` is `nextBitNode`, with nothing playable left in the order to gain (core's `nextBitNodeOf`). BN1
 * destroyed at the caps gives no level (`giveSourceFile`, `RedPill.tsx:27-31`), and the portal enters BN1 all the same
 * (`BitNode/ui/PortalModal.tsx:117-126`): the run itself is the gain.
 */
export function replayOf(resetInfo: unknown, nextBitNode: number): string | null {
  const next = nextBitNodeFrom(resetInfo);
  return next !== null && next.bitNode === nextBitNode ? next.replay : null;
}

/**
 * The BitNodes the order skipped on the way to `nextBitNode` (#323), in words (core's `describeSkipped`), or null:
 * none, or `nextBitNode` isn't the brain's next from `resetInfo` (the owner's, say).
 */
export function skippedOf(resetInfo: unknown, nextBitNode: number): string | null {
  const next = nextBitNodeFrom(resetInfo);
  return next !== null && next.bitNode === nextBitNode ? describeSkipped(next.skipped) : null;
}

/** Why the brain's destroy isn't asked for with w0r1d_d43m0n ready (#321): no next BitNode from the slow snapshot. */
export const NEXT_UNREAD = "the next BitNode can't be read from the slow snapshot (its BitNode or Source-Files)";

/**
 * "into BitNode 4", "into BitNode 5 (BN2 … skipped: …)" (#323), or "into BitNode 1 (…), a replay (…)" (#321): the
 * brain's log line's words, and the start line's.
 */
export function describeNextBitNode(next: NextBitNode): string {
  const skipped = describeSkipped(next.skipped);
  return (
    `into BitNode ${next.bitNode}${skipped === null ? "" : ` (${skipped})`}` +
    (next.replay === null ? "" : `, a replay (${next.replay})`)
  );
}

/**
 * The switch in the brain's start line (#311, #321): "off", "on", or on and into the BitNode the store's last slow
 * snapshot (`lastSlowData`, the Agent's word, so checked) gives: "on (into BitNode 4)".
 */
export function describeWorldDaemonSwitch(enabled: boolean, lastSlowData: unknown): string {
  if (!enabled) return "off";
  const next = nextBitNodeFrom((lastSlowData as { resetInfo?: unknown } | null)?.resetInfo);
  return next === null ? "on" : `on (${describeNextBitNode(next)})`;
}

/** The game's time since the last install (#334): `slowData`'s `lastAugReset` to `gameTimeMs`, or null unread. */
export function sinceResetOf(slowData: SlowSnapshotData | null | undefined, gameTimeMs: number | null | undefined) {
  const lastAugReset = slowData?.resetInfo?.lastAugReset;
  return isFiniteNumber(lastAugReset) && isFiniteNumber(gameTimeMs) ? Math.max(0, gameTimeMs - lastAugReset) : null;
}

/** The path, as the snapshots show it (#215): each part null where the snapshots don't say. */
export interface WorldDaemonPath {
  bitNode: number | null;
  /** The BitNode's win route (#398, core's `winRouteOf`): The Red Pill's, or the Black Ops' (BN6). */
  route: WinRoute;
  /** The Black Ops' route (#398), on it: null elsewhere, or unread. */
  blackOps: BlackOpsRouteView | null;
  /** Null once The Red Pill is installed: Daedalus is done with. */
  daedalus: {
    joined: boolean;
    invited: boolean;
    augmentations: number;
    augmentationsRequired: number;
    /** What its invitation still needs, worded (core's `daedalusMissing`); empty when met. */
    missing: string[];
    /** Short of the count (#228): neither joined nor invited, fewer installed than required. */
    short: boolean;
    /** How many more are within reach, and where (#228); null without the hacking level or the faction state. */
    reach: DaedalusReach | null;
    /** What else its invitation needs, the count aside (#228): the line says the count itself. */
    needs: string[];
  } | null;
  redPill: {
    installed: boolean;
    queued: boolean;
    /**
     * Whose reputation `reputation` is: Daedalus's, or the gang's faction's where it sells it (#334), unless Daedalus
     * has reached it; null with neither (Daedalus not joined, no gang selling it).
     */
    seller: string | null;
    /** Whether `seller` is the gang's faction (#334): its rate the cycle's, not work's. */
    gang: boolean;
    /** The seller's reputation and what The Red Pill needs; the rate and ETA while short (A5's work's, or the gang's). */
    reputation: number | null;
    reputationNeeded: number | null;
    perSecond: number | null;
    etaSeconds: number | null;
  } | null;
  /** Null until The Red Pill is installed. */
  daemon: {
    reachable: boolean;
    rooted: boolean;
    hackingLevel: number;
    requiredHackingLevel: number | null;
    /** The measured hacking experience a second, and the ETA to the required level at it; null unmeasured. */
    expPerSecond: number | null;
    etaSeconds: number | null;
    /** What a destroy still needs (core's `worldDaemonProblem`), or null. */
    problem: string | null;
  } | null;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: number) => Math.floor(value).toLocaleString("en-US");
const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

/** "Neural Wit Amplifier (BitRunners, $10,000,000)": the first three, then how many more. */
function describeWithin(within: CountFacts["within"]): string {
  const named = within
    .slice(0, 3)
    .map(({ augmentation, faction, money }) => `${augmentation} (${faction}, ${formatMoney(money)})`);
  return within.length > 3 ? `${named.join(", ")} and ${within.length - 3} more` : named.join(", ");
}

/** Why an install that added none isn't stuck (#238): nothing within reach, or within the money left after the set. */
function describeNothingWithin(countFacts: CountFacts | null): string {
  if (countFacts === null) {
    return "no facts from A6's commit (yours, the switch off, or an earlier brain's), so not judged";
  }
  const [nearest] = countFacts.within;
  if (nearest === undefined) return "nothing that counts within reach";
  return (
    `nothing that counts within its money: the cheapest within reach, ${describeWithin([nearest])}, costs more ` +
    `than the ${formatMoney(countFacts.moneyAfterSet)} left after the set`
  );
}

/** The medium snapshot's hacking level, or null; and its experience, or null (only the ETA needs it). */
function hackingOf(mediumData: MediumSnapshotData | null) {
  const player = mediumData?.player as { skills?: { hacking?: unknown }; exp?: { hacking?: unknown } } | undefined;
  const level = player?.skills?.hacking;
  const exp = player?.exp?.hacking;
  return isFiniteNumber(level) ? { level, exp: isFiniteNumber(exp) ? exp : null } : null;
}

/** The skills Daedalus's invitation turns on, or null without the hacking level; a combat skill not said is 0. */
function daedalusSkillsOf(mediumData: MediumSnapshotData | null) {
  const skills = (mediumData?.player as { skills?: Record<string, unknown> } | undefined)?.skills;
  if (!isFiniteNumber(skills?.hacking)) return null;
  const skill = (name: string) => (isFiniteNumber(skills[name]) ? skills[name] : 0);
  return {
    hacking: skills.hacking,
    strength: skill("strength"),
    defense: skill("defense"),
    dexterity: skill("dexterity"),
    agility: skill("agility"),
  };
}

/**
 * The time to `requiredLevel` at `expPerSecond`: the experience it needs at the multiplier the level and experience
 * imply now (`PersonObjects/formulas/skill.ts:7-15`), less the experience now. 0 once reached; null unmeasured.
 */
export function hackingEtaSeconds(
  hacking: { level: number; exp: number },
  requiredLevel: number,
  expPerSecond: number | null,
): number | null {
  if (hacking.level >= requiredLevel) return 0;
  const base = 32 * Math.log(hacking.exp + 534.6) - 200;
  if (expPerSecond === null || !(expPerSecond > 0) || !(base > 0)) return null;
  const multiplier = hacking.level / base;
  return Math.max(0, hackingExpForLevel(requiredLevel, multiplier) - hacking.exp) / expPerSecond;
}

/**
 * The path from the snapshots (#215): what the dashboard and the run report show. `expPerSecond` is the measured
 * hacking experience rate, or null; `shareBonus`, the share threads' running (#224), in The Red Pill's rate, 1 by
 * default; `cityGroup`, the brain's city group (#228), for the reach. Throws for what core doesn't know (another game
 * version).
 */
export function worldDaemonPath({
  staticData,
  mediumData,
  slowData,
  expPerSecond,
  shareBonus = 1,
  cityGroup = null,
  gangShop = null,
  sinceResetMs = null,
  blackOps = null,
}: {
  staticData: StaticSnapshotData | null;
  mediumData: MediumSnapshotData | null;
  slowData: SlowSnapshotData | null;
  expPerSecond: number | null;
  /** The Black Ops' route as the reading shows it (#398, ./bladeburner-route.ts), on that route; null unread. */
  blackOps?: BlackOpsRouteView | null;
  shareBonus?: number;
  /** The city group the brain chose this cycle (#228), for the reach; null for none. */
  cityGroup?: string | null;
  /** The gang's faction (#334, the gang's `gangShopOf`), or null for none. */
  gangShop?: JoinedFaction | null;
  /** The game's time since the last install (#334), the gang's faction's rate; null unread. */
  sinceResetMs?: number | null;
}): WorldDaemonPath {
  const resetInfo = slowData === null ? null : resetInfoOf(slowData);
  const state: FactionState | null = slowData === null ? null : (factionReadingOf(slowData)?.state ?? null);
  const hacking = hackingOf(mediumData);
  const redPillInstalled = resetInfo !== null && Object.hasOwn(resetInfo.ownedAugs, THE_RED_PILL);
  const route = resetInfo === null ? "redPill" : winRouteOf(resetInfo.currentNode);
  const path: WorldDaemonPath = {
    bitNode: resetInfo?.currentNode ?? null,
    route,
    blackOps: route === "blackOps" ? blackOps : null,
    daedalus: null,
    redPill: null,
    daemon: null,
  };
  // The Black Ops' route (#398): A8's Red Pill path off, Daedalus, The Red Pill and w0r1d_d43m0n's level with it.
  if (route === "blackOps") return path;
  if (resetInfo !== null && !redPillInstalled) {
    const required = daedalusRequirements(resetInfo.currentNode, resetInfo.ownedSF);
    // Never short with The Red Pill at the gang's faction (#335's review), as A6 has it.
    const count = daedalusCountOf({
      currentNode: resetInfo.currentNode,
      ownedSF: resetInfo.ownedSF,
      installed: resetInfo.ownedAugs,
      joined: state?.joined ?? [],
      invitations: state?.invitations ?? [],
      redPillElsewhere: gangSellsRedPill(gangShop?.name ?? null, resetInfo.currentNode),
    });
    const augmentations = count.installed;
    const person = mediumData === null ? null : workingPersonOf(mediumData);
    const money = (mediumData?.player as { money?: unknown } | undefined)?.money;
    const skills = daedalusSkillsOf(mediumData);
    const unread = ["the player's money and hacking level in the Agent's medium snapshot"];
    path.daedalus = {
      joined: state?.joined.some((faction) => faction.name === DAEDALUS) ?? false,
      invited: state?.invitations.includes(DAEDALUS) ?? false,
      augmentations,
      augmentationsRequired: required.augmentations,
      missing:
        skills === null || !isFiniteNumber(money)
          ? unread
          : daedalusMissing({ augmentations, money, skills }, required),
      short: count.short,
      reach:
        state === null || hacking === null
          ? null
          : daedalusReach(state, resetInfo.currentNode, resetInfo.ownedAugs, hacking.level, cityGroup),
      needs:
        skills === null || !isFiniteNumber(money)
          ? unread
          : daedalusMissing({ augmentations: required.augmentations, money, skills }, required),
    };
    const queued = state?.queuedAugmentations.includes(THE_RED_PILL) ?? false;
    const daedalus = state?.joined.find((faction) => faction.name === DAEDALUS) ?? null;
    // The gang's faction (#334): selling it (BN2), it's the route, as A6 and A5 have it, at the cycle's rate; Daedalus
    // only once its reputation reaches it (#335's re-review), else its estimate and stall would be of work A5 won't do.
    const gangSells =
      gangShop !== null &&
      augmentationsSoldBy(gangShop.name, resetInfo.currentNode, gangShop.name).includes(THE_RED_PILL);
    const reputationNeeded = augmentationCost(THE_RED_PILL, {
      installed: resetInfo.ownedAugs,
      queued: state?.queuedAugmentations ?? [],
      sourceFile11Level: resetInfo.ownedSF["11"] ?? 0,
      bitNodeMultipliers: augmentationBitNodeMultipliers(resetInfo.currentNode, resetInfo.ownedSF),
    }).reputation;
    // By work alone, to The Red Pill's own reputation (#225 review): A5's favour target for it isn't the path's ETA.
    const work =
      person === null || state === null || slowData === null
        ? null
        : redPillWork(person, state, resetInfo, {
            ...workConditionsOf(resetInfo, slowData, shareBonus),
            donations: false,
          });
    if (gangShop !== null && gangSells && !(daedalus !== null && daedalus.reputation >= reputationNeeded)) {
      const etaMs = gangRedPillEtaMs(gangShop.reputation, reputationNeeded, sinceResetMs);
      path.redPill = {
        installed: false,
        queued,
        seller: gangShop.name,
        gang: true,
        reputation: gangShop.reputation,
        reputationNeeded,
        perSecond:
          sinceResetMs !== null && sinceResetMs > 0 && gangShop.reputation > 0
            ? gangShop.reputation / (sinceResetMs / 1000)
            : null,
        etaSeconds: Number.isFinite(etaMs) ? etaMs / 1000 : null,
      };
    } else {
      path.redPill = {
        installed: false,
        queued,
        seller: daedalus === null ? null : DAEDALUS,
        gang: false,
        reputation: daedalus?.reputation ?? null,
        reputationNeeded,
        perSecond: work?.reputationPerSecond ?? null,
        etaSeconds: work?.etaSeconds ?? null,
      };
    }
  }
  if (redPillInstalled) {
    path.redPill = {
      installed: true,
      queued: false,
      seller: null,
      gang: false,
      reputation: null,
      reputationNeeded: null,
      perSecond: null,
      etaSeconds: null,
    };
    const daemon = mediumData?.servers?.find((server) => server.hostname === WORLD_DAEMON);
    const requiredHackingLevel =
      staticData?.servers?.find((server) => server.hostname === WORLD_DAEMON)?.requiredHackingSkill ?? null;
    const rooted = daemon?.hasAdminRights === true;
    path.daemon = {
      reachable: daemon !== undefined,
      rooted,
      hackingLevel: hacking?.level ?? 0,
      requiredHackingLevel: isFiniteNumber(requiredHackingLevel) ? requiredHackingLevel : null,
      expPerSecond,
      etaSeconds:
        hacking === null || hacking.exp === null || !isFiniteNumber(requiredHackingLevel)
          ? null
          : hackingEtaSeconds({ level: hacking.level, exp: hacking.exp }, requiredHackingLevel, expPerSecond),
      problem:
        daemon === undefined
          ? worldDaemonProblem(null)
          : hacking === null || !isFiniteNumber(requiredHackingLevel)
            ? "the hacking level or w0r1d_d43m0n's requirement not in the snapshots yet"
            : worldDaemonProblem({ rooted, hackingLevel: hacking.level, requiredHackingLevel }),
    };
  }
  return path;
}

/** The last Black Op's rank (#398): Operation Daedalus's 400,000 (`data/BlackOperations.ts:704-735`). */
const BLACK_OPS_LAST_RANK = (BLADEBURNER_BLACK_OPS.at(-1) as { rank: number }).rank;
/** "1.23 rank/min". */
const rankPerMinute = (perSecond: number) => `${(perSecond * 60).toFixed(2)} rank/min`;
/** "about 3 h", "never", or "2.78e+66 h" past what a duration reads well. */
function aboutSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "never";
  return seconds > 1e9 ? `${(seconds / 3600).toPrecision(3)} h` : `about ${describeEta(seconds)}`;
}

/** The Black Ops' route in words (#398): the dashboard's and the run report's lines. */
export function describeBlackOpsRoute(view: BlackOpsRouteView | null): string[] {
  const off =
    "off on this route (#398): The Red Pill's holds (A6), levelling (#336) and A8's Red Pill path (Daedalus, " +
    `${THE_RED_PILL}, ${WORLD_DAEMON}'s hacking level)`;
  const unread = "the Black Ops (#398): no reading yet (the division joined, and home's RAM for its reader)";
  if (view === null) return [unread, off];
  const allDone = view.done === BLACK_OPS_COUNT;
  const head =
    `the Black Ops (#398): rank ${view.rank === null ? "unread" : count(view.rank)} of ` +
    `${count(BLACK_OPS_LAST_RANK)} (Operation Daedalus's); ` +
    (view.done === null ? "the Black Ops done unread" : `${view.done} of ${BLACK_OPS_COUNT} done`);
  const next = allDone
    ? ": the destroy, by them"
    : view.next === null
      ? ""
      : `; next ${view.next.name} at rank ${count(view.next.rank)}, its chance ` +
        `${view.next.chance === null ? "unread" : `${(view.next.chance * 100).toFixed(1)}%`} at the low end`;
  const eta = allDone
    ? ""
    : view.rankPerSecond === null
      ? "; the rank's rate not measured yet"
      : view.etaSeconds === null
        ? `; the rank not rising (${rankPerMinute(view.rankPerSecond)} measured)`
        : `; ${count(BLACK_OPS_LAST_RANK)} ${aboutSeconds(view.etaSeconds)} at the measured ` +
          rankPerMinute(view.rankPerSecond);
  const estimate = view.estimate;
  const redPill =
    view.redPillSeconds === null
      ? "not measured (no hacking experience rate yet)"
      : `at least ${aboutSeconds(view.redPillSeconds)} (${WORLD_DAEMON}'s hacking level alone, by the formulas)`;
  const planner =
    `the planner (#398): the Black Ops' ${estimate === null ? "not estimated yet" : aboutSeconds(estimate.seconds)}` +
    (estimate === null || estimate.steps.length === 0
      ? ""
      : ` (the next one's rank by B5's stock and tail, each later one's at ${rankPerMinute(estimate.rate)} ` +
        "sustainable, each one's attempts at the competence now)") +
    `; ${THE_RED_PILL}'s ${redPill}${view.choice.redPillHopeless === true ? ", hopeless" : ""}: ` +
    `${view.choice.route === "blackOps" ? "the Black Ops" : THE_RED_PILL} chosen (${view.choice.why})` +
    // Shown, not acted on (#400's review): the route played is `winRouteOf`'s, fixed per BitNode.
    (view.choice.route === "redPill" ? "; shown, not acted on: this BitNode plays the Black Ops" : "");
  return [view.rank === null && view.done === null ? unread : head + next + eta, planner, off];
}

/** The path in words, a line each (#215): the dashboard's and the run report's. */
export function describeWorldDaemonPath(path: WorldDaemonPath): string[] {
  if (path.route === "blackOps") return describeBlackOpsRoute(path.blackOps);
  const lines: string[] = [];
  const { daedalus, redPill, daemon } = path;
  if (daedalus !== null) {
    const { reach } = daedalus;
    lines.push(
      `Daedalus: ${daedalus.joined ? "joined" : daedalus.invited ? "invited" : "not joined"}; ` +
        `${count(daedalus.augmentations)} of ${count(daedalus.augmentationsRequired)} augmentations installed` +
        (!daedalus.short
          ? ""
          : reach === null
            ? ", the reach not read (the hacking level or the faction state)"
            : `, ${describeReach(reach)}`) +
        (daedalus.joined
          ? ""
          : daedalus.missing.length === 0
            ? "; requirements met"
            : daedalus.needs.length === 0
              ? ""
              : `; needs ${daedalus.needs.join(", ")}`),
    );
  }
  if (redPill !== null) {
    if (redPill.installed) lines.push(`${THE_RED_PILL}: installed`);
    else if (redPill.queued) lines.push(`${THE_RED_PILL}: queued, to install`);
    else if (redPill.reputation === null) lines.push(`${THE_RED_PILL}: Daedalus not joined`);
    else {
      const needed = redPill.reputationNeeded;
      const reached = needed !== null && redPill.reputation >= needed;
      lines.push(
        `${THE_RED_PILL}: ${redPill.seller ?? DAEDALUS}'s${redPill.gang ? " (the gang's faction)" : ""} reputation ` +
          `${count(redPill.reputation)} of ${needed === null ? "?" : count(needed)}` +
          (reached
            ? ", reached: to buy and install"
            : redPill.perSecond !== null && redPill.etaSeconds !== null
              ? ` at ${redPill.perSecond.toFixed(1)}/s${redPill.gang ? " (the cycle's)" : ""}: about ` +
                describeEta(redPill.etaSeconds)
              : redPill.gang
                ? ", none earned this cycle yet"
                : ", no work earning it"),
      );
    }
  }
  if (daemon !== null) {
    const required = daemon.requiredHackingLevel;
    lines.push(
      `${WORLD_DAEMON}: ${daemon.reachable ? (daemon.rooted ? "rooted" : "not rooted") : "not reachable"}; hacking ` +
        `${count(daemon.hackingLevel)} of ${required === null ? "?" : count(required)}` +
        (daemon.etaSeconds === null
          ? daemon.expPerSecond === null
            ? " (the experience rate not measured yet)"
            : ""
          : daemon.etaSeconds === 0
            ? ", reached"
            : `: about ${describeEta(daemon.etaSeconds)} at the measured experience rate`),
    );
  }
  return lines;
}

/**
 * The hacking experience rate from snapshots (time, experience), over the window, a gap or a fall restarting it. With
 * `fallsCount` (#398: Bladeburner's rank, which a Black Op's failure lowers), a fall is measured, not a restart.
 */
export class HackingExpRate {
  #samples: { atMs: number; exp: number }[] = [];
  readonly #fallsCount: boolean;

  constructor({ fallsCount = false }: { fallsCount?: boolean } = {}) {
    this.#fallsCount = fallsCount;
  }

  add(atMs: number, exp: number): void {
    const last = this.#samples.at(-1);
    // A gap, an install (the experience falls to 0) or the clock set back: measured afresh.
    if (
      last !== undefined &&
      (atMs <= last.atMs || atMs - last.atMs > HACKING_EXP_GAP_MS || (exp < last.exp && !this.#fallsCount))
    ) {
      this.#samples = [];
    }
    if (last !== undefined && atMs === last.atMs) return;
    this.#samples.push({ atMs, exp });
    const old = this.#samples.findLastIndex((sample) => atMs - sample.atMs >= HACKING_EXP_WINDOW_MS);
    if (old > 0) this.#samples = this.#samples.slice(old);
  }

  /** The experience a second over the samples, once they span a minute; null before. */
  perSecond(): number | null {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined || last.atMs - first.atMs < 60_000) return null;
    return ((last.exp - first.exp) / (last.atMs - first.atMs)) * 1000;
  }

  /**
   * The samples span the whole window (`HACKING_EXP_WINDOW_MS`): the rate isn't its first minutes' only, which after a
   * reset (the hack loop starting) can be none or a sliver (#378's review: τ_g from it 258 h against 26 min).
   */
  windowFull(): boolean {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    return first !== undefined && last !== undefined && last.atMs - first.atMs >= HACKING_EXP_WINDOW_MS;
  }
}

/** What the dashboard shows (#215). */
export interface WorldDaemonView {
  enabled: boolean;
  path: WorldDaemonPath | null;
  /** The path in words. */
  lines: string[];
  /** The brain's destroy asked for now. */
  destroying: boolean;
  /** A destroy the owner queued, which goes instead of the brain's (the controller's). */
  ownersDestroy: boolean;
  /**
   * The BitNode the brain's destroy enters (#321): the one asked for, else the last slow snapshot's; null before one.
   * The controller's view gives the owner's queued destroy's instead.
   */
  nextBitNode: number | null;
  /** Why the brain's destroy is a replay (#311, `replayOf`), from the last slow snapshot, or null. */
  replay: string | null;
  /** The BitNodes the order skipped on the way to it (#323, `skippedOf`), from the last slow snapshot, or null. */
  skipped: string | null;
  /** A stall, from when it could have been done, or null: the `worldDaemonStalled` alert's. */
  stall: WorldDaemonStall | null;
}

export interface WorldDaemonStall {
  step: StallStep;
  sinceMs: number;
  detail: string;
}

/** What the controller hands the rule each update. */
export interface WorldDaemonInputs {
  staticData: StaticSnapshotData | null;
  mediumData: MediumSnapshotData | null;
  mediumGameTimeMs: number | null;
  slowData: SlowSnapshotData | null;
  /** The controller's clock (a channel event's), for the stalls. */
  nowMs: number | null;
  enabled: boolean;
  /** The share threads' bonus running (#224), for The Red Pill's rate; 1 when absent. */
  shareBonus?: number;
  /** The city group the brain chose this cycle (#228, ./invitations.ts), for the reach; none when absent. */
  cityGroup?: string | null;
  /**
   * A6's commit's facts while short of Daedalus's count (#238, `AugmentationRule.countFacts`): what counts within
   * reach, and the money left after the set; null without a commit (none when absent).
   */
  countFacts?: CountFacts | null;
  /** A6 asked for its install (#238 review, `AugmentationRule.installAskedFor`): an install with no facts is its. */
  augmentationsInstalling?: boolean;
  /** The gang's faction (#334, the gang's `gangShopOf`), The Red Pill's seller in BN2; none when absent. */
  gangShop?: JoinedFaction | null;
  /** The game's time of the slow snapshot (its `gameTimeMs`), for the gang's faction's rate; none when absent. */
  slowGameTimeMs?: number | null;
  /** A6 holds installs for The Red Pill at the gang's faction (#335's review): its not rising stall; not when absent. */
  redPillHeldAtGang?: boolean;
  /**
   * The gang's plan earning no respect (#374, the gang rule's `earningPause`): from when, and its bound (twice the
   * rule's estimate of the time until it earns, and 10 minutes); null or absent while it earns.
   */
  gangPause?: Pick<GangStallStretch, "fromMs" | "withinMs" | "estimateMs"> | null;
  /**
   * The Black Ops' route (#398), on it: the route from the snapshots at this rule's measured rates (the controller's
   * ./bladeburner-route.ts `blackOpsRouteOf`); none when absent (the path then says it's unread).
   */
  blackOps?: ((rates: { rankPerSecond: number | null; expPerSecond: number | null }) => BlackOpsRouteView) | null;
  /** The Bladeburner rule acts (#398, its `acting`): the rank's stall is judged only then. Absent: not. */
  bladeburnerActing?: boolean;
  /**
   * The Bladeburner rule's rebuild after an install (#404, its `rebuilding`): the rank's stall waits for it (Training
   * gains none), and the rebuild has its own bound from its first sighting (#407's review): twice the planner's priced
   * rebuild and 10 minutes (the rule runs none past it). Absent or null: none.
   */
  bladeburnerRebuild?: BladeburnerRebuildView | null;
}

/** The World Daemon rule (#215), as the controller runs it. */
export class WorldDaemonRule {
  readonly #log: (line: string) => void;
  readonly #emit: (event: WorldDaemonEvent) => void;
  readonly #expRate = new HackingExpRate();
  /** Bladeburner's rank a second (#398), over the medium snapshots' readings: a Black Op's failure is part of it. */
  readonly #rankRate = new HackingExpRate({ fallsCount: true });
  /**
   * The Black Ops' clock (#398, #400's review), while the Bladeburner rule acts: the Black Op it's for (the count done),
   * whether its rank has been met (the attempts; kept through a failure's dip under it), and since when, with the rank
   * then (the climb's checkpoint).
   */
  #rankHigh: {
    done: number;
    attempts: boolean;
    value: number;
    sinceMs: number;
    /** The bound used up (#400's round 2): Σ the time between readings over the bound at each, a stall at 1. */
    used: number;
    lastMs: number;
  } | null = null;
  #path: WorldDaemonPath | null = null;
  #enabled = true;
  /** The brain's next BitNode (#321), from the BitNode and Source-Files the last slow snapshot showed, or null. */
  #next: NextBitNode | null = null;
  /**
   * The destroy asked for, the BitNode's `lastNodeReset` then, and the BitNode it enters, fixed as it's asked for: held
   * until a slow snapshot shows another reset.
   */
  #asked: { lastNodeReset: number; nextBitNode: number } | null = null;
  /** `NEXT_UNREAD` logged, until the next BitNode is read again: logged once, not every update. */
  #nextUnreadLogged = false;
  /** Each step's start, while it could be done; the stall once stored, so it's stored once. */
  #ready = new Map<StallStep, { sinceMs: number; stored: boolean; detail: string }>();
  /** Daedalus's reputation while The Red Pill is short, and when it last rose (or was first seen). */
  #reputation: { value: number; risenAtMs: number } | null = null;
  /**
   * The gang's plan earning no respect (#374), as first handed over, kept while it lasts: the gang rule's own stretch
   * starts again after a gap in its readings (#364's review), which would move the bound on at each. Within one brain
   * process only: a restart starts both it and the reputation's clock again; while the Agent is away (no snapshots)
   * the reputation's clock starts again, and this is kept.
   */
  #gangPause: { fromMs: number; withinMs: number; estimateMs: number } | null = null;
  /** Daedalus's count as last seen (#228), and the install since its `lastAugReset`; A6's commit's facts (#238). */
  #count: {
    lastAugReset: number;
    installed: number;
    required: number;
    short: boolean;
    queued: number;
    countFacts: CountFacts | null;
    augmentationsInstalling: boolean;
  } | null = null;
  /**
   * The last install while short that added none to the count (#228), passing over one that counts (#238), while its
   * cycle lasts: "Daedalus count stuck".
   */
  #stuck: { atMs: number; detail: string } | null = null;

  constructor({
    log = () => {},
    emit = () => {},
  }: { log?: (line: string) => void; emit?: (event: WorldDaemonEvent) => void }) {
    this.#log = log;
    this.#emit = emit;
  }

  /**
   * A restarted brain's destroy, from the controller's reset note (#215 review): asked for in the BitNode whose
   * `lastNodeReset` the note holds, so it's held, and its note kept, until a slow snapshot shows another.
   */
  restore(lastNodeReset: number, nextBitNode: number): void {
    this.#asked = { lastNodeReset, nextBitNode };
  }

  /** The brain's destroy while it's asked for, into the BitNode it was asked for (#321), or null. */
  destroyIntent(): Intent | null {
    return this.#asked === null ? null : worldDaemonDestroyIntent(this.#asked.nextBitNode);
  }

  view(): WorldDaemonView {
    const nextBitNode = this.#asked?.nextBitNode ?? this.#next?.bitNode ?? null;
    return {
      enabled: this.#enabled,
      path: this.#path,
      lines: this.#path === null ? [] : describeWorldDaemonPath(this.#path),
      destroying: this.#asked !== null,
      ownersDestroy: false,
      nextBitNode,
      // The asked-for BitNode's, as the last slow snapshot says it: a restored ask's too.
      replay: this.#next !== null && this.#next.bitNode === nextBitNode ? this.#next.replay : null,
      skipped: this.#next !== null && this.#next.bitNode === nextBitNode ? describeSkipped(this.#next.skipped) : null,
      stall: this.stall(),
    };
  }

  /** The step stalled longest, or null: `worldDaemonStalled`'s. */
  stall(): WorldDaemonStall | null {
    let worst: WorldDaemonStall | null = null;
    for (const [step, ready] of this.#ready) {
      if (!ready.stored) continue;
      if (worst === null || ready.sinceMs < worst.sinceMs)
        worst = { step, sinceMs: ready.sinceMs, detail: ready.detail };
    }
    return worst;
  }

  /** Whether to ask for the destroy. */
  update({
    staticData,
    mediumData,
    mediumGameTimeMs,
    slowData,
    nowMs,
    enabled,
    shareBonus = 1,
    cityGroup = null,
    countFacts = null,
    augmentationsInstalling = false,
    gangShop = null,
    slowGameTimeMs = null,
    redPillHeldAtGang = false,
    gangPause = null,
    blackOps = null,
    bladeburnerActing = false,
    bladeburnerRebuild = null,
  }: WorldDaemonInputs): boolean {
    this.#enabled = enabled;
    if (slowData !== null) {
      this.#next = nextBitNodeFrom(slowData.resetInfo);
      if (this.#next !== null) this.#nextUnreadLogged = false;
    }
    const hacking = hackingOf(mediumData);
    if (hacking !== null && hacking.exp !== null && mediumGameTimeMs !== null)
      this.#expRate.add(mediumGameTimeMs, hacking.exp);
    const rank = (mediumData as { bladeburner?: { rank?: unknown } | null } | null)?.bladeburner?.rank;
    if (isFiniteNumber(rank) && mediumGameTimeMs !== null) this.#rankRate.add(mediumGameTimeMs, rank);
    const lastNodeReset = slowData?.resetInfo?.lastNodeReset;
    // A destroy asked for is over once a slow snapshot shows the BitNode reset (or the switch turns off).
    if (
      this.#asked !== null &&
      (!enabled || (isFiniteNumber(lastNodeReset) && lastNodeReset !== this.#asked.lastNodeReset))
    ) {
      this.#asked = null;
      this.#ready.clear();
    }
    if (staticData === null || mediumData === null || slowData === null) {
      // The Agent gone (#228 review): a step's clock not stored yet starts again with the snapshots, so the time away
      // isn't counted as time online.
      for (const [step, ready] of this.#ready) if (!ready.stored) this.#ready.delete(step);
      // The Red Pill's reputation clock too, unless its stall is stored (#228 re-review).
      if (!this.#ready.get("redPillReputation")?.stored) this.#reputation = null;
      // The rank's clock too (#398), unless its stall is stored.
      if (!this.#ready.get("blackOpsRank")?.stored) this.#rankHigh = null;
      return this.#asked !== null;
    }
    let path: WorldDaemonPath;
    try {
      const expPerSecond = this.#expRate.perSecond();
      const onRoute = isBitNodeNumber(slowData.resetInfo?.currentNode)
        ? winRouteOf(slowData.resetInfo.currentNode) === "blackOps"
        : false;
      path = worldDaemonPath({
        staticData,
        mediumData,
        slowData,
        expPerSecond,
        shareBonus,
        cityGroup,
        gangShop,
        sinceResetMs: sinceResetOf(slowData, slowGameTimeMs),
        blackOps:
          onRoute && blackOps !== null ? blackOps({ rankPerSecond: this.#rankRate.perSecond(), expPerSecond }) : null,
      });
    } catch (error) {
      this.#log(`world daemon: the snapshots as core knows the game: ${(error as Error).message}`);
      return this.#asked !== null;
    }
    this.#path = path;
    this.#watchCount(path, slowData, nowMs ?? 0, countFacts, augmentationsInstalling);
    this.#watch(path, nowMs ?? 0, enabled, redPillHeldAtGang, gangPause, bladeburnerActing, bladeburnerRebuild);
    // On the Black Ops' route (#398), all 21 done: the reading shows none next.
    const ready =
      path.route === "blackOps"
        ? path.blackOps?.done === BLACK_OPS_COUNT
        : path.daemon !== null && path.daemon.problem === null;
    if (enabled && ready && this.#asked === null && isFiniteNumber(lastNodeReset)) {
      // The slow snapshot's BitNode or Source-Files not read (#321): no destroy into a BitNode guessed; the destroy
      // step's stall follows, 5 minutes on.
      if (this.#next === null) {
        if (!this.#nextUnreadLogged) this.#log(`world daemon: ${WORLD_DAEMON} ready, but ${NEXT_UNREAD}`);
        this.#nextUnreadLogged = true;
        return false;
      }
      this.#asked = { lastNodeReset, nextBitNode: this.#next.bitNode };
      this.#log(
        `world daemon: ${
          path.route === "blackOps"
            ? `all ${BLACK_OPS_COUNT} Black Ops done (#398)`
            : `${WORLD_DAEMON} rooted at hacking ${path.daemon?.hackingLevel}`
        }: destroying the BitNode, ${describeNextBitNode(this.#next)} (the gate, then a save backup first)`,
      );
    }
    return this.#asked !== null;
  }

  /**
   * Daedalus's count across an install (#228): one while short (the count as last seen before it, Daedalus neither
   * joined nor invited) that leaves the count where it was, passing over one that counts (#238), is "Daedalus count
   * stuck", for the cycle after it. Judged
   * per install, from the slow snapshots' `lastAugReset`: a restarted brain judges the installs it sees. A reset with
   * nothing queued before it isn't an install (#228 re-review): a soft reset (`installAugmentations(true)`,
   * `GameRoot.tsx:297-299`, `Singularity.ts:185-193`, `PlayerObjectGeneralMethods.ts:126`), or an older save loaded.
   * Stuck only if it passed over one that counts (#238): A6's commit's `countFacts` hold one within reach whose money
   * is no more than what was left after the set, so A6's set should have taken it; or A6 asked for the install and its
   * commit kept no facts (a regression that loses them can't hide a stall). Else an early NeuroFlux-only install, with
   * nothing that counts within reach (or within the money), or one without A6's facts (yours, the switch off, an
   * earlier brain's): `daedalusCountNeuroFluxOnly`, information.
   */
  #watchCount(
    path: WorldDaemonPath,
    slowData: SlowSnapshotData,
    nowMs: number,
    countFacts: CountFacts | null,
    augmentationsInstalling: boolean,
  ): void {
    const lastAugReset = slowData.resetInfo?.lastAugReset;
    const daedalus = path.daedalus;
    if (!isFiniteNumber(lastAugReset) || daedalus === null) {
      this.#count = null;
      this.#stuck = null;
      return;
    }
    const before = this.#count;
    if (before !== null && before.lastAugReset !== lastAugReset) {
      const addedNoneToCount = before.short && before.queued > 0 && daedalus.augmentations <= before.installed;
      const facts = before.countFacts;
      const moneyAfterSet = facts?.moneyAfterSet ?? 0;
      const passedOver = facts?.within.filter((each) => each.money <= moneyAfterSet) ?? [];
      const countDescription = `${count(before.installed)} of ${count(before.required)} augmentations installed`;
      const stuckBecause = !addedNoneToCount
        ? null
        : passedOver.length > 0
          ? `passing over ${describeWithin(passedOver)}, which the money left after the set ` +
            `(${formatMoney(moneyAfterSet)}) would have bought`
          : facts === null && before.augmentationsInstalling
            ? "A6's install, with no facts from its commit of what counts within reach"
            : null;
      this.#stuck =
        stuckBecause === null
          ? null
          : {
              atMs: nowMs,
              detail:
                `Daedalus count stuck: an install at ${countDescription} added none to the count (NeuroFlux ` +
                `Governor's levels count once), ${stuckBecause}`,
            };
      if (addedNoneToCount && stuckBecause === null) {
        const detail = `installed NeuroFlux Governor only at ${countDescription}: ${describeNothingWithin(facts)}`;
        this.#log(`world daemon: ${detail}`);
        this.#emit({
          type: DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND,
          atMs: nowMs,
          installed: before.installed,
          required: before.required,
          countFacts: facts,
          detail,
        });
      }
    }
    this.#count = {
      lastAugReset,
      installed: daedalus.augmentations,
      required: daedalus.augmentationsRequired,
      short: daedalus.short,
      queued: factionReadingOf(slowData)?.state?.queuedAugmentations.length ?? 0,
      countFacts,
      augmentationsInstalling,
    };
  }

  /** Each step that could be done, from when; one not done its `STALLED_AFTER_MS` on is stored and logged. */
  #watch(
    path: WorldDaemonPath,
    nowMs: number,
    enabled: boolean,
    redPillHeldAtGang = false,
    gangPause: WorldDaemonInputs["gangPause"] = null,
    bladeburnerActing = false,
    bladeburnerRebuild: BladeburnerRebuildView | null = null,
  ): void {
    const steps = new Map<StallStep, { detail: string; sinceMs?: number; withinMs?: number }>();
    // The Black Ops' route (#398): all 21 done, the destroy's step; short, the rank's, while the Bladeburner rule acts
    // (the owner's work holds its actions: no rank is asked for), from its high's last rise, within the route's bound.
    const route = path.route === "blackOps" ? path.blackOps : null;
    if (route !== null && enabled && route.done === BLACK_OPS_COUNT) {
      steps.set("destroy", { detail: `all ${BLACK_OPS_COUNT} Black Ops done (#398), the BitNode not destroyed` });
    }
    const rank = route?.rank ?? null;
    const rankStallMs = route?.rankStallMs ?? null;
    const nextRank = route?.next?.rank ?? null;
    if (route !== null && bladeburnerActing && bladeburnerRebuild !== null) {
      // The rebuild after an install (#404): Training gains no rank, so the climb waits; the rebuild's own bound (#407's
      // review: twice the planner's priced rebuild, game seconds, and 10 minutes) from its first sighting fails it.
      this.#rankHigh = null;
      const boundMs = bladeburnerRebuild.boundSeconds * 1000;
      const priced =
        bladeburnerRebuild.pricedSeconds === null
          ? `10 min, the planner priced none`
          : `twice the planner's priced ${formatDuration(bladeburnerRebuild.pricedSeconds * 1000)} and ` +
            `${formatDuration(BLADEBURNER_REBUILD_SLACK_MS)}`;
      steps.set("blackOpsRank", {
        detail:
          `the combat stats not rebuilt after the install (#404) by Training within ${formatDuration(boundMs)}: ` +
          `${priced} (${formatDuration(bladeburnerRebuild.seconds * 1000)} left by it now)`,
        ...(bladeburnerRebuild.sinceMs === null ? {} : { sinceMs: bladeburnerRebuild.sinceMs }),
        withinMs: boundMs,
      });
    } else if (
      route !== null &&
      bladeburnerActing &&
      route.done !== null &&
      route.done < BLACK_OPS_COUNT &&
      rank !== null &&
      // Under the faction's 25 the plan can be a lottery at rank 0 (#386): B2's bound judges it.
      rank >= BLADEBURNER_FACTION_RANK &&
      nextRank !== null &&
      rankStallMs !== null
    ) {
      const done = route.done;
      const last = this.#rankHigh;
      // A Black Op's end (the count risen), or the first look: the clock afresh. Its rank met: the attempts from then,
      // kept through a failure's dip under it. Under it: the climb, its checkpoint moved on by each rise of `climbRise`.
      const rise = route.climbRise ?? 0;
      const fresh = (attempts: boolean) => ({ done, attempts, value: rank, sinceMs: nowMs, used: 0, lastMs: nowMs });
      const attemptsMs = route.attemptsStallMs;
      // The climb's window: null where its plan rests alone (the reading not judged).
      const climbMs = route.climbRise === null ? null : (route.climbWindowMs ?? rankStallMs);
      // Each reading uses up its share of the bound as it stands then (#400's round 2: the integral form), so a bound
      // that shrinks (the chance or ρ risen) doesn't fire at once on the time already spent under a longer one.
      const share = (clock: NonNullable<typeof last>, boundMs: number | null) =>
        boundMs === null || !(boundMs > 0) ? 0 : Math.max(0, nowMs - clock.lastMs) / boundMs;
      this.#rankHigh =
        last === null || last.done !== done
          ? fresh(rank >= nextRank)
          : !last.attempts && rank >= nextRank
            ? fresh(true)
            : !last.attempts && climbMs !== null && (rise > 0 ? rank >= last.value + rise : rank > last.value)
              ? fresh(false)
              : {
                  ...last,
                  used: last.used + share(last, last.attempts ? attemptsMs : climbMs),
                  lastMs: nowMs,
                };
      const clock = this.#rankHigh;
      // The #ready check stalls at elapsed ≥ withinMs: the bound used up (to a rounding) is the stall, else never yet.
      const elapsed = nowMs - clock.sinceMs;
      const within = clock.used >= 1 - 1e-9 ? elapsed : Number.POSITIVE_INFINITY;
      if (clock.attempts && attemptsMs !== null) {
        steps.set("blackOpsRank", {
          detail:
            `${route.next?.name ?? "the next Black Op"} not done (#398, ${done} of ${BLACK_OPS_COUNT}), its rank met, ` +
            `the bound ${formatDuration(attemptsMs)}: ⌈ln 0.001 / ln(1 − p)⌉ attempts at its low end's chance, each with ` +
            "a failure's rebuild and its own stamina, a rest and 10 min (the time judged against the bound as it stood " +
            "at each reading)",
          sinceMs: clock.sinceMs,
          withinMs: within,
        });
      } else if (!clock.attempts && climbMs !== null) {
        steps.set("blackOpsRank", {
          detail:
            `Bladeburner's rank not climbing (${count(rank)} now, ${count(clock.value)} at the clock's start) toward ` +
            `${count(nextRank)} on the Black Ops' route (#398, ${done} of ${BLACK_OPS_COUNT} done): ` +
            `${count(rise)} wanted within ${formatDuration(climbMs)}, the sustainable rate's rise less Bernstein's ` +
            "margin at α 0.001; the window twice a rest to the max, the next Black Op's attempt and a failure's rebuild, " +
            `and 10 min${climbMs > rankStallMs ? `, lengthened from ${formatDuration(rankStallMs)} to where that rise is positive` : ""}` +
            " (the time judged against the window as it stood at each reading)",
          sinceMs: clock.sinceMs,
          withinMs: within,
        });
      }
    } else if (!this.#ready.get("blackOpsRank")?.stored) {
      this.#rankHigh = null;
    }
    if (gangPause === null || gangPause.withinMs === undefined) {
      // The pause over (#376's review): the members just put to work, the reputation rises only from the next process
      // on, so its 10 minutes count from now, not from its last rise before the pause, which would fail every pause.
      if (this.#gangPause !== null && this.#reputation !== null) {
        this.#reputation = { ...this.#reputation, risenAtMs: Math.max(this.#reputation.risenAtMs, nowMs) };
      }
      this.#gangPause = null;
    } else {
      this.#gangPause ??= {
        fromMs: gangPause.fromMs,
        withinMs: gangPause.withinMs,
        estimateMs: gangPause.estimateMs ?? 0,
      };
    }
    const { daedalus, redPill, daemon } = path;
    if (this.#stuck !== null) {
      steps.set("daedalusCount", { detail: this.#stuck.detail, sinceMs: this.#stuck.atMs });
    }
    if (daedalus !== null && !daedalus.joined && daedalus.missing.length === 0) {
      steps.set("daedalus", {
        detail: `Daedalus's requirements met, not joined${daedalus.invited ? " (invited)" : " (no invitation yet)"}`,
      });
    }
    const reached =
      redPill !== null &&
      redPill.reputation !== null &&
      redPill.reputationNeeded !== null &&
      redPill.reputation >= redPill.reputationNeeded;
    if (redPill !== null && !redPill.installed && (redPill.queued || reached)) {
      steps.set("redPill", { detail: `${THE_RED_PILL} ${redPill.queued ? "queued" : "reached"}, not installed` });
    }
    // Short at a joined Daedalus, A6 holds every install: its reputation not rising is loud (#215 review). At the gang's
    // faction (#334) only while A6 holds for it: G5's hold, at most 20 min a cycle (#335's review, the rules'), or the
    // planner's keeping or banking (#357's (3)), with no limit, a pause to train included (#372's re-review). While the
    // gang's plan earns no respect (training, justice, warfare), the bound is the plan's own (#374): its reputation flat
    // until twice the gang rule's estimate of the time to earning and 10 minutes from the pause's start, if later than
    // the 10 minutes. A gang's respect pauses while its members train, which holds nothing otherwise.
    if (
      redPill !== null &&
      !redPill.installed &&
      !redPill.queued &&
      !reached &&
      redPill.reputation !== null &&
      (!redPill.gang || redPillHeldAtGang)
    ) {
      const value = redPill.reputation;
      if (this.#reputation === null || value !== this.#reputation.value) {
        // Risen; or fallen (an install, a reload): watched afresh.
        this.#reputation = { value, risenAtMs: nowMs };
      }
      const sinceMs = this.#reputation.risenAtMs;
      // The gang's pause (#374): its bound, from its start, in place of the 10 minutes when it ends later.
      const paused = redPill.gang ? this.#gangPause : null;
      const pauseEndsMs = paused === null ? null : paused.fromMs + paused.withinMs;
      steps.set("redPillReputation", {
        detail:
          `${THE_RED_PILL}'s reputation at ${redPill.seller ?? DAEDALUS} not rising (${count(value)} of ` +
          `${count(redPill.reputationNeeded ?? 0)}): no install is chosen meanwhile, so nothing earning it stalls A6` +
          (paused === null
            ? ""
            : `; the gang's plan earning no respect since ${formatIsoTime(paused.fromMs)}, its bound ` +
              `${formatDuration(paused.withinMs)} (twice the gang rule's estimate of ` +
              `${formatDuration(paused.estimateMs)}, and 10 min)`),
        sinceMs,
        ...(pauseEndsMs === null
          ? {}
          : { withinMs: Math.max(RED_PILL_REPUTATION_STALLED_AFTER_MS, pauseEndsMs - sinceMs) }),
      });
    } else {
      this.#reputation = null;
    }
    if (
      enabled &&
      daemon !== null &&
      daemon.requiredHackingLevel !== null &&
      daemon.hackingLevel >= daemon.requiredHackingLevel
    ) {
      steps.set("destroy", {
        detail:
          `${WORLD_DAEMON} at its level (hacking ${count(daemon.hackingLevel)} of ${count(daemon.requiredHackingLevel)}), ` +
          `the BitNode not destroyed${daemon.problem === null ? "" : `: ${daemon.problem}`}`,
      });
    }
    for (const step of [...this.#ready.keys()]) if (!steps.has(step)) this.#ready.delete(step);
    for (const [step, { detail, sinceMs, withinMs }] of steps) {
      const ready = this.#ready.get(step) ?? { sinceMs: sinceMs ?? nowMs, stored: false, detail };
      ready.detail = detail;
      if (sinceMs !== undefined && sinceMs !== ready.sinceMs) {
        // The reputation rose: its stall, if stored, is over.
        ready.sinceMs = sinceMs;
        ready.stored = false;
      }
      this.#ready.set(step, ready);
      if (ready.stored || nowMs - ready.sinceMs < (withinMs ?? STALLED_AFTER_MS[step])) continue;
      ready.stored = true;
      this.#emit({ type: WORLD_DAEMON_STALLED_EVENT_KIND, atMs: nowMs, step, sinceMs: ready.sinceMs, detail });
      this.#log(`world daemon: STALLED ${Math.floor((nowMs - ready.sinceMs) / 60_000)} min: ${detail}`);
    }
  }
}
