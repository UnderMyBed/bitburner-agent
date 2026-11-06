// The run report's BitNodes and augmentation cycles (#244): the window split at each destroy, each BitNode's milestones
// with the time since its start, and a row per augmentation cycle (`lastAugReset` to the next reset) answering what
// held it back. Folded as the run report reads the store: the slow snapshots first (they say where each BitNode and
// cycle starts), then the medium and the fast ones, each put in the BitNode and cycle its time falls in. Read-only, and
// from what the store already has: an older store's missing fields read as "not recorded", never a crash.
import {
  acceptsDonations,
  augmentationBitNodeMultipliers,
  augmentationBuyOrder,
  augmentationCost,
  augmentationsSoldBy,
  DAEDALUS,
  daedalusAugmentationsRequired,
  daedalusCountOf,
  donationsUnlocked,
  donationToReach,
  FACTION_NAMES,
  type FactionState,
  factionReadingKind,
  factionReadingOf,
  favorAfterInstall,
  favorToDonate,
  isWorthInstalling,
  type JoinedFaction,
  type MediumSnapshotData,
  missingPrerequisites,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
  type SlowSnapshotData,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { describeAugmentations } from "./augmentation-report.ts";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_DONATED_EVENT_KIND,
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_PROGRESS_EVENT_KIND,
  advanceOnlineClock,
  donationTermsOf,
  type OnlineClock,
} from "./augmentations.ts";
import { SLOW_SNAPSHOT_GAP_MS } from "./factions.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import { shareBonusOf } from "./share.ts";
import type { StoredEvent } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";

/**
 * How often a cycle's slow snapshots are judged for what held it back: its first, then the first at least this long
 * after the last judged. Run #3's question was answered by hand at 15 minutes; each judgement is three passes of core's
 * prices over the joined factions' augmentations.
 */
export const HELD_BACK_JUDGED_EVERY_MS = 5 * 60_000;
/**
 * The brain's receipt less the game's time, for a snapshot, past which the two clocks aren't the same machine's (or the
 * game's time isn't recorded): a reset's time (the game's) is then taken as the brain's, within the bounds below.
 */
const CLOCK_OFFSET_SANE_MS = 24 * 3_600_000;

/**
 * What more of would have raised the count the install rule waits on (core's `installRule`), at a slow snapshot:
 * - "reputation": more reputation at the joined factions (the money covering it) would count more;
 * - "money": more money would (the reputation reached, or a donation's to buy);
 * - "reputation and money": either would;
 * - "count": neither: everything worth installing at the joined factions is counted, and the cycle waits on the bar;
 * - "factions": nothing worth installing is left unowned at the joined factions (none joined, early in a cycle, say):
 *   only another faction's would count more, or, with something to install, the bar or "nothing left" ends it.
 */
export type HeldBack = "reputation" | "money" | "reputation and money" | "count" | "factions";
const HELD_BACK_ORDER: HeldBack[] = ["reputation", "money", "reputation and money", "count", "factions"];

/** The medium snapshot's figures a judgement needs: the money, and the `faction_rep` multiplier a donation is worth. */
export interface PlayerFigures {
  money: number;
  factionRep: number;
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fieldsOf = (value: unknown) =>
  (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
const formatMoney = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
const formatWhole = (value: number) => Math.round(value).toLocaleString("en-US");
const formatFavor = (favor: number) => favor.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * The most of `names` the money buys, the cheapest first, each with its prerequisites owned, queued or already counted
 * (core's `purchaseSequenceCost` in the game's buy order, so each purchase's ×1.9 is in it), and `extra` money on top
 * for each (a donation's, #225). A count, not the brain's set: its set is chosen by hacking value, which can count
 * fewer, so a count beside another must be the same measure's.
 */
function countable(
  names: readonly string[],
  state: Parameters<typeof augmentationCost>[1],
  money: number,
  extra: (name: string) => number = () => 0,
): number {
  const price = new Map(names.map((name) => [name, augmentationCost(name, state).money + extra(name)]));
  const cheapestFirst = [...names].sort((a, b) => (price.get(a) ?? 0) - (price.get(b) ?? 0));
  const chosen: string[] = [];
  let extras = 0;
  for (const name of cheapestFirst) {
    if (missingPrerequisites(name, { installed: state.installed, queued: [...state.queued, ...chosen] }).length > 0)
      continue;
    const cost = purchaseSequenceCost(augmentationBuyOrder([...chosen, name]), state).money + extras + extra(name);
    if (cost > money) continue;
    chosen.push(name);
    extras += extra(name);
  }
  return chosen.length;
}

/**
 * What held the count back at a slow snapshot (`HeldBack`), from its faction state and `ownedAugs` and the medium
 * snapshot's money: the augmentations worth installing (core's `isWorthInstalling`, any short of Daedalus's count) sold
 * by a joined faction and not owned or queued, counted three ways: as things are (reputation reached, or a donation's
 * money where donations are unlocked); with every one's reputation reached; and with the money unlimited. Null where
 * the snapshot doesn't say (no faction state, an unread one, malformed `resetInfo`) or core doesn't know a name in it.
 */
export function heldBackOf(data: SlowSnapshotData, player: PlayerFigures): HeldBack | null {
  const reading = factionReadingOf(data);
  const state = reading?.state ?? null;
  const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  if (reading === null || state === null || factionReadingKind(reading) === "unread") return null;
  if (!Number.isInteger(info?.currentNode) || typeof info?.ownedAugs !== "object" || info.ownedAugs === null)
    return null;
  try {
    const currentNode = info.currentNode as number;
    const ownedSF = (info.ownedSF ?? {}) as Record<string, number>;
    const multipliers = augmentationBitNodeMultipliers(currentNode, ownedSF);
    const purchaseState = {
      installed: info.ownedAugs as Record<string, number>,
      queued: state.queuedAugmentations,
      sourceFile11Level: ownedSF["11"] ?? 0,
      bitNodeMultipliers: multipliers,
    };
    const joined = state.joined.filter((faction) => FACTION_NAMES.includes(faction.name));
    const shops = new Map(
      joined.map((faction) => [faction.name, augmentationsSoldBy(faction.name, currentNode, null)]),
    );
    const { short } = daedalusCountOf({
      currentNode,
      ownedSF,
      installed: purchaseState.installed,
      joined: state.joined,
      invitations: state.invitations,
    });
    const owned = (name: string) =>
      Object.hasOwn(purchaseState.installed, name) || state.queuedAugmentations.includes(name);
    const open = [...new Set([...shops.values()].flat())].filter(
      (name) => name !== NEUROFLUX_GOVERNOR && !owned(name) && isWorthInstalling(name, short),
    );
    if (open.length === 0) return "factions";
    const needed = new Map(open.map((name) => [name, augmentationCost(name, purchaseState).reputation]));
    const reached = (name: string) =>
      joined.some(
        (faction) => shops.get(faction.name)?.includes(name) && faction.reputation >= (needed.get(name) ?? 0),
      );
    const terms = donationTermsOf(
      joined,
      shops,
      open.filter((name) => !reached(name)),
      player.factionRep,
      multipliers,
    );
    // A donation's money for one no joined seller's reputation reaches: the least of its sellers taking donations.
    const donation = (name: string) => {
      if (reached(name)) return 0;
      return Math.min(
        ...(terms.sellers[name] ?? []).map((seller) =>
          donationToReach((needed.get(name) ?? 0) - seller.reputation, terms.factionRep, terms.factionWorkRepGain),
        ),
      );
    };
    const buyable = open.filter((name) => reached(name) || (terms.sellers[name]?.length ?? 0) > 0);
    const now = countable(buyable, purchaseState, player.money, donation);
    const withReputation = countable(open, purchaseState, player.money) > now;
    const withMoney = countable(buyable, purchaseState, Number.POSITIVE_INFINITY) > now;
    if (withReputation && withMoney) return "reputation and money";
    if (withReputation) return "reputation";
    if (withMoney) return "money";
    return "count";
  } catch {
    return null;
  }
}

/** "BN1.2": the BitNode and its level, one more than its Source-File's (the game's own count). */
function bitNodeLabel(currentNode: number, ownedSF: Record<string, unknown>): string {
  const level = isNumber(ownedSF[String(currentNode)]) ? (ownedSF[String(currentNode)] as number) : 0;
  return `BN${currentNode}.${level + 1}`;
}

/** When a milestone was first seen: its time, or before the window (true at the BitNode's first look, started before). */
interface Seen {
  atMs: number;
  beforeWindow: boolean;
  detail?: string;
}

/** A BitNode the window's slow snapshots show (`lastNodeReset`), with its milestones (#244). */
interface BitNode {
  lastNodeReset: number;
  label: string;
  currentNode: number;
  /** Its start, by the brain's clock: `lastNodeReset`, within its first and the previous BitNode's last slow snapshot. */
  startMs: number;
  firstSlowAtMs: number;
  lastSlowAtMs: number;
  firstMediumAtMs: number | null;
  /** The newest record in it: a snapshot of any tier, or an event. */
  lastRecordMs: number;
  firstFaction: Seen | null;
  donationsUnlocked: Map<string, Seen>;
  daedalusCount: Seen | null;
  daedalusRequired: number | null;
  daedalusJoined: Seen | null;
  redPill: Seen | null;
}

/** A medium snapshot's figures, as a cycle keeps them. */
interface MediumPoint {
  atMs: number;
  money: number | null;
  hacking: number | null;
  factionRep: number | null;
}

/** A slow snapshot judged for what held its cycle back, and the time online it stands for. */
interface Sample {
  atMs: number;
  data: SlowSnapshotData;
  onlineMs: number;
}

/** An augmentation cycle the window's slow snapshots show (`lastAugReset`), and what the report keeps of it. */
interface Cycle {
  lastAugReset: number;
  bitNode: number;
  startMs: number;
  firstSlowAtMs: number;
  lastSlowAtMs: number;
  clock: OnlineClock | null;
  /** The first install the brain chose at or after its start (never with none): judged until then. */
  chosenAtMs: number;
  ownedAugs: Record<string, number> | null;
  ownedSF: Record<string, number>;
  currentNode: number;
  /** Each faction's favour as first seen in it: an install leaves every faction, so one shows only once joined again. */
  favorSeen: Map<string, number>;
  lastJoined: JoinedFaction[] | null;
  samples: Sample[];
  medium: MediumPoint[];
  /** The fast snapshots' share bonuses, added up, and how many had a batcher health field (absent: older Agent). */
  shareSum: number;
  shareCount: number;
  targets: string[];
}

/**
 * The BitNodes and cycles over a window (#244). `events` are the window's; the slow snapshots come first, in order,
 * then the medium and the fast ones, each in order.
 */
export class BitNodeCycles {
  readonly bitNodes: BitNode[] = [];
  readonly #cycles: Cycle[] = [];
  readonly #events: readonly StoredEvent[];
  readonly #sinceMs: number;

  constructor(events: readonly StoredEvent[], { sinceMs }: { sinceMs: number }) {
    this.#events = events;
    this.#sinceMs = sinceMs;
  }

  /** The BitNode `atMs` falls in (the first for a time before them all), or -1 with none seen. */
  bitNodeIndexAt(atMs: number): number {
    if (this.bitNodes.length === 0) return -1;
    return Math.max(
      0,
      this.bitNodes.findLastIndex((bitNode) => bitNode.startMs <= atMs),
    );
  }

  #cycleAt(atMs: number): Cycle | undefined {
    if (this.#cycles.length === 0) return undefined;
    return this.#cycles[
      Math.max(
        0,
        this.#cycles.findLastIndex((cycle) => cycle.startMs <= atMs),
      )
    ];
  }

  /** A reset's time by the brain's clock: the game's, moved by this snapshot's clocks' offset, within the bounds. */
  static #startOf(resetMs: number, atMs: number, gameTimeMs: number, earliestMs: number): number {
    const offset = atMs - gameTimeMs;
    const moved = resetMs + (isNumber(offset) && Math.abs(offset) <= CLOCK_OFFSET_SANE_MS ? offset : 0);
    return Math.max(earliestMs, Math.min(atMs, moved));
  }

  addSlow(atMs: number, gameTimeMs: number, data: SlowSnapshotData): void {
    const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
    const { lastAugReset, lastNodeReset, currentNode } = info ?? {};
    if (!isNumber(lastAugReset) || !isNumber(lastNodeReset) || !Number.isInteger(currentNode)) return;
    const ownedSF = fieldsOf(info?.ownedSF) as Record<string, number>;
    const ownedAugs = typeof info?.ownedAugs === "object" && info.ownedAugs !== null ? info.ownedAugs : null;
    let bitNode = this.bitNodes.at(-1);
    if (bitNode?.lastNodeReset !== lastNodeReset) {
      bitNode = {
        lastNodeReset,
        label: bitNodeLabel(currentNode as number, ownedSF),
        currentNode: currentNode as number,
        startMs: BitNodeCycles.#startOf(
          lastNodeReset,
          atMs,
          gameTimeMs,
          bitNode?.lastSlowAtMs ?? Number.NEGATIVE_INFINITY,
        ),
        firstSlowAtMs: atMs,
        lastSlowAtMs: atMs,
        firstMediumAtMs: null,
        lastRecordMs: atMs,
        firstFaction: null,
        donationsUnlocked: new Map(),
        daedalusCount: null,
        daedalusRequired: null,
        daedalusJoined: null,
        redPill: null,
      };
      this.bitNodes.push(bitNode);
    }
    bitNode.lastSlowAtMs = atMs;
    bitNode.lastRecordMs = Math.max(bitNode.lastRecordMs, atMs);
    const bitNodeIndex = this.bitNodes.length - 1;
    let cycle = this.#cycles.at(-1);
    if (cycle?.lastAugReset !== lastAugReset || cycle.bitNode !== bitNodeIndex) {
      const startMs = BitNodeCycles.#startOf(
        lastAugReset,
        atMs,
        gameTimeMs,
        Math.max(bitNode.startMs, cycle?.lastSlowAtMs ?? Number.NEGATIVE_INFINITY),
      );
      cycle = {
        lastAugReset,
        bitNode: bitNodeIndex,
        startMs,
        firstSlowAtMs: atMs,
        lastSlowAtMs: atMs,
        clock: null,
        chosenAtMs: this.#installChosenAtOrAfter(startMs),
        ownedAugs: ownedAugs as Record<string, number> | null,
        ownedSF,
        currentNode: currentNode as number,
        favorSeen: new Map(),
        lastJoined: null,
        samples: [],
        medium: [],
        shareSum: 0,
        shareCount: 0,
        targets: [],
      };
      this.#cycles.push(cycle);
    }
    cycle.lastSlowAtMs = atMs;
    // The bars' clock, as the rule folds it (#222): the time online, gaps left out. Each step is the state before it's.
    const before = cycle.clock?.onlineMs ?? 0;
    cycle.clock = advanceOnlineClock(cycle.clock, gameTimeMs, lastAugReset).clock;
    const { chosenAtMs } = cycle;
    const current = cycle.samples.at(-1);
    if (current !== undefined && atMs <= chosenAtMs) current.onlineMs += cycle.clock.onlineMs - before;
    if (atMs < chosenAtMs && (current === undefined || atMs - current.atMs >= HELD_BACK_JUDGED_EVERY_MS)) {
      cycle.samples.push({ atMs, data, onlineMs: 0 });
    }
    const state = factionReadingOf(data)?.state ?? null;
    if (state !== null) {
      for (const { name, favor } of state.joined) if (!cycle.favorSeen.has(name)) cycle.favorSeen.set(name, favor);
      cycle.lastJoined = state.joined;
    }
    this.#slowMilestones(bitNode, atMs, data, state, ownedSF);
  }

  /** The first install the brain chose at or after `atMs`, or never. */
  #installChosenAtOrAfter(atMs: number): number {
    return (
      this.#events.find((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND && event.atMs >= atMs)?.atMs ??
      Number.POSITIVE_INFINITY
    );
  }

  #seen(bitNode: BitNode, atMs: number, firstLookMs: number | null, detail?: string): Seen {
    const beforeWindow = atMs === firstLookMs && bitNode.startMs < this.#sinceMs;
    return { atMs, beforeWindow, ...(detail === undefined ? {} : { detail }) };
  }

  #slowMilestones(
    bitNode: BitNode,
    atMs: number,
    data: SlowSnapshotData,
    state: FactionState | null,
    ownedSF: Record<string, number>,
  ): void {
    const ownedAugs = fieldsOf(data.resetInfo?.ownedAugs);
    try {
      const multipliers = augmentationBitNodeMultipliers(bitNode.currentNode, ownedSF);
      bitNode.daedalusRequired = daedalusAugmentationsRequired(bitNode.currentNode, ownedSF);
      if (bitNode.daedalusCount === null && Object.keys(ownedAugs).length >= bitNode.daedalusRequired) {
        bitNode.daedalusCount = this.#seen(bitNode, atMs, bitNode.firstSlowAtMs);
      }
      for (const faction of state?.joined ?? []) {
        if (bitNode.donationsUnlocked.has(faction.name) || !acceptsDonations(faction.name, null)) continue;
        if (donationsUnlocked(faction.favor, multipliers)) {
          bitNode.donationsUnlocked.set(faction.name, this.#seen(bitNode, atMs, bitNode.firstSlowAtMs));
        }
      }
    } catch {}
    const redPill = Object.hasOwn(ownedAugs, THE_RED_PILL) || (state?.queuedAugmentations ?? []).includes(THE_RED_PILL);
    if (redPill && bitNode.redPill === null) bitNode.redPill = this.#seen(bitNode, atMs, bitNode.firstSlowAtMs);
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const player = fieldsOf(data?.player);
    const index = this.bitNodeIndexAt(atMs);
    const bitNode = this.bitNodes[index];
    if (bitNode !== undefined) {
      bitNode.firstMediumAtMs ??= atMs;
      bitNode.lastRecordMs = Math.max(bitNode.lastRecordMs, atMs);
      const factions = Array.isArray(player.factions)
        ? player.factions.filter((name): name is string => typeof name === "string")
        : [];
      const [first] = factions;
      if (bitNode.firstFaction === null && first !== undefined) {
        bitNode.firstFaction = this.#seen(bitNode, atMs, bitNode.firstMediumAtMs, first);
      }
      if (bitNode.daedalusJoined === null && factions.includes(DAEDALUS)) {
        bitNode.daedalusJoined = this.#seen(bitNode, atMs, bitNode.firstMediumAtMs);
      }
    }
    const cycle = this.#cycleAt(atMs);
    if (cycle === undefined) return;
    const hacking = fieldsOf(player.skills).hacking;
    const factionRep = fieldsOf(player.mults).faction_rep;
    cycle.medium.push({
      atMs,
      money: isNumber(player.money) ? player.money : null,
      hacking: isNumber(hacking) ? hacking : null,
      factionRep: isNumber(factionRep) ? factionRep : null,
    });
  }

  /** A fast snapshot's batcher health (`undefined` from an older Agent), taken at the game's time `gameTimeMs`. */
  addFast(atMs: number, gameTimeMs: number, batcher: unknown): void {
    const bitNode = this.bitNodes[this.bitNodeIndexAt(atMs)];
    if (bitNode !== undefined) bitNode.lastRecordMs = Math.max(bitNode.lastRecordMs, atMs);
    const cycle = this.#cycleAt(atMs);
    if (cycle === undefined || batcher === undefined) return;
    cycle.shareSum += shareBonusOf(
      typeof batcher === "object" ? (batcher as Parameters<typeof shareBonusOf>[0]) : null,
      gameTimeMs,
    );
    cycle.shareCount += 1;
    const target = fieldsOf(batcher).target;
    if (typeof target === "string" && cycle.targets.at(-1) !== target && !cycle.targets.includes(target)) {
      cycle.targets.push(target);
    }
  }

  // --- The lines ------------------------------------------------------------------------------------------------------

  /**
   * The BitNodes line (#244): each entered in the window, with its start, and destroyed (the next one seen) or not,
   * with how long it lasted, or has so far. "not recorded" with no slow snapshot.
   */
  bitNodesLine(): string {
    if (this.bitNodes.length === 0) return "  BitNodes: not recorded (no slow snapshot in the window)";
    const each = this.bitNodes.map((bitNode, index) => {
      const next = this.bitNodes[index + 1];
      const from = `from ${formatIsoTime(bitNode.startMs)}${bitNode.startMs < this.#sinceMs ? " (before the window)" : ""}`;
      if (next !== undefined) {
        return `${bitNode.label} ${from}, destroyed after ${formatDuration(next.startMs - bitNode.startMs)}`;
      }
      const endMs = Math.max(bitNode.lastRecordMs, ...this.#eventsIn(index).map((event) => event.atMs));
      const sent = this.#destroySentIn(index);
      return (
        `${bitNode.label} ${from}, ${sent === null ? "not destroyed" : `destroy sent at ${formatIsoTime(sent)}, the next BitNode not seen`}` +
        `, ${formatDuration(endMs - bitNode.startMs)} by the window's last record`
      );
    });
    return `  BitNodes: ${each.join("; ")}`;
  }

  #eventsIn(index: number): StoredEvent[] {
    if (this.bitNodes.length === 0) return [];
    return this.#events.filter((event) => this.bitNodeIndexAt(event.atMs) === index);
  }

  #destroySentIn(index: number): number | null {
    return this.#eventsIn(index).find((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND)?.atMs ?? null;
  }

  /** A BitNode's milestones (#244), with the time since its start: indented under its progress. */
  milestoneLines(index: number): string[] {
    const bitNode = this.bitNodes[index];
    if (bitNode === undefined) return [];
    const since = (seen: Seen | null, what = "") =>
      seen === null
        ? "not in the window"
        : seen.beforeWindow
          ? `${what}before the window`
          : `${what}+${formatDuration(seen.atMs - bitNode.startMs)} (${formatIsoTime(seen.atMs)})`;
    const lines = ["milestones (the time since the BitNode's start):"];
    lines.push(
      `  first faction joined: ${since(bitNode.firstFaction, bitNode.firstFaction?.detail ? `${bitNode.firstFaction.detail}, ` : "")}`,
    );
    const unlocked = [...bitNode.donationsUnlocked].map(([faction, seen]) => since(seen, `${faction} `));
    lines.push(`  donations unlocked: ${unlocked.length === 0 ? "none in the window" : unlocked.join(", ")}`);
    const required = bitNode.daedalusRequired === null ? "" : ` (${bitNode.daedalusRequired} installed)`;
    lines.push(`  Daedalus's count reached${required}: ${since(bitNode.daedalusCount)}`);
    lines.push(`  Daedalus joined: ${since(bitNode.daedalusJoined)}`);
    const bought = this.#eventsIn(index).find(
      (event) => event.kind === AUGMENTATION_BOUGHT_EVENT_KIND && fieldsOf(event.detail).augmentation === THE_RED_PILL,
    );
    const redPill =
      bought !== undefined && (bitNode.redPill === null || bought.atMs < bitNode.redPill.atMs)
        ? { atMs: bought.atMs, beforeWindow: false }
        : bitNode.redPill;
    lines.push(`  The Red Pill bought: ${since(redPill)}`);
    const next = this.bitNodes[index + 1];
    const sent = this.#destroySentIn(index);
    const destroyed =
      next !== undefined
        ? `+${formatDuration(next.startMs - bitNode.startMs)} (${formatIsoTime(next.startMs)}, the next BitNode's ` +
          `start${sent === null ? "; no destroy sent seen" : `; sent at ${formatIsoTime(sent)}`})`
        : sent !== null
          ? `sent +${formatDuration(sent - bitNode.startMs)} (${formatIsoTime(sent)}), the next BitNode not seen`
          : "not in the window";
    lines.push(`  destroyed: ${destroyed}`);
    return lines;
  }

  /**
   * Section 2b (#244): each cycle, a BitNode at a time. `readings` are the brain's worked faction's reputation
   * (`FactionWorkTimeline.readings`).
   */
  section(readings: readonly { atMs: number; faction: string; reputation: number }[]): string[] {
    const lines = [
      "2b. Augmentation cycles (each from an install's lastAugReset to the next reset; #244)",
      `  held back by: what more of would have raised the count the install rule waits on, judged every ` +
        `${formatDuration(HELD_BACK_JUDGED_EVERY_MS)} of a cycle's slow snapshots until its install was chosen, by ` +
        "time online: reputation (the money covering it), money (the reputation reached, or a donation's), " +
        "reputation and money, count (neither: it waits on the bar), or factions (nothing left to count at the " +
        "joined factions)",
    ];
    if (this.#cycles.length === 0) return [...lines, "  not recorded (no slow snapshot in the window)"];
    for (const [bitNodeIndex, bitNode] of this.bitNodes.entries()) {
      lines.push(`  ${bitNode.label}:`);
      const cycles = this.#cycles.filter((cycle) => cycle.bitNode === bitNodeIndex);
      for (const cycle of cycles) {
        const index = this.#cycles.indexOf(cycle);
        lines.push(...this.#cycleLines(cycle, index, cycles.indexOf(cycle) + 1, readings).map((line) => `    ${line}`));
      }
    }
    return lines;
  }

  #cycleLines(
    cycle: Cycle,
    index: number,
    number: number,
    readings: readonly { atMs: number; faction: string; reputation: number }[],
  ): string[] {
    const next = this.#cycles[index + 1];
    const installed = next !== undefined && next.bitNode === cycle.bitNode;
    const endMs = next?.startMs ?? Math.max(cycle.lastSlowAtMs, ...cycle.medium.map((point) => point.atMs));
    const inCycle = (atMs: number) => atMs >= cycle.startMs && (next === undefined || atMs < next.startMs);
    const events = this.#events.filter((event) => inCycle(event.atMs));
    // The brain's clock in its progress events carries time from before the window (#222).
    const progressOnline = this.#events
      .filter(
        (event) =>
          event.kind === AUGMENTATION_PROGRESS_EVENT_KIND && fieldsOf(event.detail).lastAugReset === cycle.lastAugReset,
      )
      .map((event) => fieldsOf(event.detail).onlineMs)
      .filter(isNumber);
    const onlineMs = Math.max(cycle.clock?.onlineMs ?? 0, ...progressOnline);
    const from = `${formatIsoTime(cycle.startMs)}${cycle.startMs < this.#sinceMs ? " (before the window)" : ""}`;
    const length = `${formatDuration(endMs - cycle.startMs)}${next === undefined ? " so far" : ""}`;
    const lines = [
      `cycle ${number} from ${from}, ${length} (${formatDuration(onlineMs)} online), ${this.#endedBy(cycle, next, events)}`,
    ];
    lines.push(`  ${this.#installedLine(cycle, installed ? next : undefined, next !== undefined && !installed)}`);
    lines.push(`  held back by: ${this.#heldBack(cycle)}`);
    lines.push(
      `  faction work: ${this.#workLine(
        readings.filter((each) => inCycle(each.atMs)),
        events,
      )}`,
    );
    lines.push(`  favour: ${this.#favourLine(cycle, installed ? next : undefined, next !== undefined && !installed)}`);
    const moneys = cycle.medium.map((point) => point.money).filter(isNumber);
    const share =
      cycle.shareCount === 0 ? "not recorded" : `×${(cycle.shareSum / cycle.shareCount).toFixed(2)} on average`;
    lines.push(
      `  share bonus: ${share}; most money unspent: ${moneys.length === 0 ? "not recorded" : formatMoney(Math.max(...moneys))}`,
    );
    const hacking = cycle.medium.map((point) => point.hacking).filter(isNumber);
    lines.push(
      `  hacking: ${
        hacking.length === 0
          ? "not recorded"
          : `${formatWhole(hacking[0] as number)} → ${formatWhole(hacking.at(-1) as number)}, most ${formatWhole(Math.max(...hacking))}`
      }`,
    );
    lines.push(
      `  the batcher's targets: ${cycle.shareCount === 0 ? "not recorded" : cycle.targets.length === 0 ? "none" : cycle.targets.join(", ")}`,
    );
    return lines;
  }

  /** "ended by an install (count reached)", "… (yours)", "ended by a destroy", or "not ended in the window". */
  #endedBy(cycle: Cycle, next: Cycle | undefined, events: readonly StoredEvent[]): string {
    if (next === undefined) return "not ended in the window";
    if (next.bitNode !== cycle.bitNode) return "ended by a destroy";
    const chosen = events.find((event) => event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND);
    if (chosen !== undefined) {
      const reason = fieldsOf(chosen.detail).reason;
      return `ended by an install (${typeof reason === "string" ? reason : "reason not stored"})`;
    }
    const sent = events.find((event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND);
    if (sent !== undefined && fieldsOf(sent.detail).source === "manual") return "ended by an install (yours)";
    return "ended by an install (none chosen in the window)";
  }

  /**
   * What the install installed (the next cycle's `ownedAugs` gained, NeuroFlux Governor a level at a time), and
   * Daedalus's count before → after; none at a destroy, and not yet for a cycle still going.
   */
  #installedLine(cycle: Cycle, next: Cycle | undefined, destroyed: boolean): string {
    const count = (owned: Record<string, number> | null) => (owned === null ? null : Object.keys(owned).length);
    let required = "";
    try {
      required = ` of ${daedalusAugmentationsRequired(cycle.currentNode, cycle.ownedSF)}`;
    } catch {}
    const before = count(cycle.ownedAugs);
    if (next === undefined || cycle.ownedAugs === null || next.ownedAugs === null) {
      const installed = destroyed ? "none, the BitNode destroyed" : next === undefined ? "not yet" : "not recorded";
      return `installed: ${installed}; Daedalus's count ${before === null ? "not recorded" : `${before}${required}`}`;
    }
    const gained: string[] = [];
    for (const [name, level] of Object.entries(next.ownedAugs)) {
      for (let each = isNumber(cycle.ownedAugs[name]) ? cycle.ownedAugs[name] : 0; each < level; each += 1)
        gained.push(name);
    }
    return (
      `installed: ${gained.length}${gained.length === 0 ? "" : ` (${describeAugmentations(gained)})`}; ` +
      `Daedalus's count ${before} → ${count(next.ownedAugs)}${required}`
    );
  }

  /** The cycle's judgements, by time online: "reputation (92% of 50 min), count (8%)". */
  #heldBack(cycle: Cycle): string {
    const totals = new Map<HeldBack, number>();
    let judged = 0;
    let unjudged = 0;
    for (const sample of cycle.samples) {
      const figures =
        cycle.medium.findLast((point) => point.atMs <= sample.atMs && point.money !== null) ??
        cycle.medium.find((point) => point.money !== null);
      const held =
        figures === undefined
          ? null
          : heldBackOf(sample.data, { money: figures.money as number, factionRep: figures.factionRep ?? 1 });
      if (held === null) {
        unjudged += 1;
        continue;
      }
      judged += sample.onlineMs;
      totals.set(held, (totals.get(held) ?? 0) + sample.onlineMs);
    }
    if (cycle.samples.length === 0) return "not judged: its install was chosen before its first slow snapshot";
    if (unjudged === cycle.samples.length) {
      return "not judged: no faction state or money recorded with its slow snapshots";
    }
    if (judged === 0) return "nothing: its install was chosen at once";
    const shares = HELD_BACK_ORDER.filter((held) => (totals.get(held) ?? 0) > 0)
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
      .map((held, rank) => {
        const percent = Math.round((100 * (totals.get(held) ?? 0)) / judged);
        return `${held} (${percent}%${rank === 0 ? ` of ${formatDuration(judged)} online judged` : ""})`;
      });
    return shares.join(", ") + (unjudged > 0 ? `; ${unjudged} not judged (no faction state or money)` : "");
  }

  /**
   * The brain's worked factions in the cycle (#203's readings): each one's reputation gained between readings no more
   * than `SLOW_SNAPSHOT_GAP_MS` apart (a donation's left out, #225), and that over the time between them.
   */
  #workLine(
    readings: readonly { atMs: number; faction: string; reputation: number }[],
    events: readonly StoredEvent[],
  ): string {
    if (readings.length === 0) return "none recorded";
    const factions = new Map<string, { earned: number; ms: number }>();
    const last = new Map<string, { atMs: number; reputation: number }>();
    for (const { atMs, faction, reputation } of readings) {
      const totals = factions.get(faction) ?? { earned: 0, ms: 0 };
      factions.set(faction, totals);
      const before = last.get(faction);
      last.set(faction, { atMs, reputation });
      if (before === undefined || atMs - before.atMs > SLOW_SNAPSHOT_GAP_MS) continue;
      const donated = events
        .filter(
          (event) =>
            event.kind === AUGMENTATION_DONATED_EVENT_KIND &&
            fieldsOf(event.detail).faction === faction &&
            event.atMs > before.atMs &&
            event.atMs <= atMs,
        )
        .map((event) => {
          const { before: from, after: to } = fieldsOf(event.detail);
          return isNumber(from) && isNumber(to) ? Math.max(0, to - from) : 0;
        })
        .reduce((sum, each) => sum + each, 0);
      totals.earned += Math.max(0, reputation - before.reputation - donated);
      totals.ms += atMs - before.atMs;
    }
    return [...factions]
      .map(
        ([faction, { earned, ms }]) =>
          `${faction} +${formatWhole(earned)} reputation` +
          (ms > 0 ? ` at ${(earned / (ms / 1000)).toFixed(2)}/s` : ""),
      )
      .join("; ");
  }

  /**
   * The favour at the faction nearest donations (#225): of the joined factions taking donations, the one not yet
   * unlocked whose favour after the install is most; else one unlocked. After an install, the next cycle's favour, or
   * core's `favorAfterInstall` where it doesn't show it; at a destroy, favour is lost.
   */
  #favourLine(cycle: Cycle, next: Cycle | undefined, destroyed: boolean): string {
    const joined = cycle.lastJoined?.filter((faction) => acceptsDonations(faction.name, null));
    if (joined === undefined) return "not recorded (no faction state)";
    if (joined.length === 0) return "no joined faction taking donations";
    try {
      const multipliers = augmentationBitNodeMultipliers(cycle.currentNode, cycle.ownedSF);
      const threshold = favorToDonate(multipliers);
      const after = (faction: JoinedFaction) => {
        const shown = next?.favorSeen.get(faction.name);
        return isNumber(shown)
          ? { favor: shown, predicted: false }
          : { favor: favorAfterInstall(faction.favor, faction.reputation), predicted: true };
      };
      const locked = joined.filter((faction) => !donationsUnlocked(faction.favor, multipliers));
      if (locked.length === 0) {
        const [unlocked] = [...joined].sort((a, b) => b.favor - a.favor);
        return `${unlocked?.name} ${formatFavor(unlocked?.favor ?? 0)}, donations unlocked`;
      }
      const [nearest] = [...locked].sort((a, b) => after(b).favor - after(a).favor);
      if (nearest === undefined) return "no joined faction taking donations";
      if (destroyed) {
        return `${nearest.name} ${formatFavor(nearest.favor)}, lost with the destroy (donations at ${threshold})`;
      }
      const { favor, predicted } = after(nearest);
      return (
        `${nearest.name} ${formatFavor(nearest.favor)} → ${formatFavor(favor)}` +
        `${next === undefined ? " at the next install" : ""}${predicted ? " (predicted)" : ""}` +
        (donationsUnlocked(favor, multipliers) ? ", donations unlocked" : `; donations at ${threshold}`)
      );
    } catch {
      return "not recorded (BitNode unknown to core)";
    }
  }
}
