// The run report's BitNodes and augmentation cycles (#244): the window split at each destroy, each BitNode's milestones
// with the time since its start, and a block per augmentation cycle (`lastAugReset` to the next reset), with a summary
// line each, answering what held it back. Folded as the run report reads the store: the slow snapshots first (they say
// where each BitNode and cycle starts), then the medium and the fast ones, each put in the BitNode and cycle its time
// falls in. Read-only, and from what the store already has: an older store's missing fields read "not recorded".
import {
  type AugmentationPurchaseState,
  acceptsDonations,
  augmentationBitNodeMultipliers,
  augmentationBuyOrder,
  augmentationCost,
  augmentationsSoldBy,
  DAEDALUS,
  type DonationTerms,
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
import { describeAugmentations, fieldsOf, formatMoney, isFiniteNumber } from "./augmentation-report.ts";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
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
import type { ReputationPoint } from "./share-report.ts";
import type { StoredEvent } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";

/**
 * How often a cycle's slow snapshots are judged for what held it back: its first, then the first at least this long
 * after the last judged, and any whose "factions" (nothing left to count) differs from the last judged's, so that
 * answer is to the minute. Run #3's question was answered by hand at 15 minutes.
 */
export const HELD_BACK_JUDGED_EVERY_MS = 5 * 60_000;
/**
 * The brain's receipt less the game's time, for a snapshot, past which the two clocks aren't the same machine's (or the
 * game's time isn't recorded): a reset's time (the game's) is then taken as the brain's, within the bounds below.
 */
const CLOCK_OFFSET_SANE_MS = 24 * 3_600_000;
/** The events that say whether an install was chosen, looked for in the day before the window too (#244 review). */
export const INSTALL_DECISION_EVENT_KINDS = [
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
];

/**
 * What more of would have raised the count the install rule waits on (core's `installRule`), estimated at a slow
 * snapshot (`heldBackOf`):
 * - "reputation": more reputation at the joined factions whose donations are locked (the money covering it);
 * - "money": more money (the reputation reached, or a donation's to buy where they're unlocked);
 * - "reputation and money": either;
 * - "count": neither: everything worth installing at the joined factions is counted (or can't be had, a prerequisite
 *   sold only elsewhere), and the cycle waits on the bar;
 * - "factions": nothing worth installing is left unowned at the joined factions (none joined, early in a cycle, say):
 *   only another faction's would count more, or, with something to install, the bar or "nothing left" ends it.
 */
export type HeldBack = "reputation" | "money" | "reputation and money" | "count" | "factions";
/**
 * A cycle's answers (#244 review): `HeldBack`'s, or the brain's own state from its `augmentationProgress` in force,
 * where the count isn't what it waits on: "The Red Pill's way" (the rule held for Daedalus, its reputation or its
 * donation, The Red Pill or the destroy, #215, #225: the progress's `held`), or "count reached" (a countdown running,
 * or the install held for Daedalus's count, #243).
 */
export type CycleAnswer = HeldBack | "The Red Pill's way" | "count reached";
const ANSWER_ORDER: CycleAnswer[] = [
  "reputation",
  "money",
  "reputation and money",
  "count",
  "factions",
  "The Red Pill's way",
  "count reached",
];

/** The medium snapshot's figures a judgement needs: the money, and the `faction_rep` multiplier a donation is worth. */
export interface PlayerFigures {
  money: number;
  factionRep: number;
}

const formatWhole = (value: number) => Math.round(value).toLocaleString("en-US");
const formatFavor = (favor: number) => favor.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** A donation an augmentation needs: at `faction` (its reputation now), to `reputation`. */
interface DonationNeed {
  faction: string;
  sellerReputation: number;
  reputation: number;
}

/**
 * How many of `names` the money buys, the cheapest first, each with its prerequisites owned, queued or counted already
 * (passes again until none is added, so a prerequisite dearer than what needs it still counts it), at its price in the
 * game's buy order (core's `purchaseSequenceCost`, each purchase's ×1.9 in it), with its donation (`donationFor`): one
 * a faction, to the most reputation bought there (as the brain's plan, legacy `faction-manager.js:891`). Stops once it
 * exceeds `stopAbove`. A count, not the brain's set (chosen by hacking value), so an estimate.
 */
function countAffordable(
  names: readonly string[],
  state: AugmentationPurchaseState,
  money: number,
  donationFor: (name: string) => DonationNeed | null,
  terms: Pick<DonationTerms, "factionRep" | "factionWorkRepGain">,
  stopAbove = Number.POSITIVE_INFINITY,
): number {
  const price = new Map(names.map((name) => [name, augmentationCost(name, state).money]));
  const cheapestFirst = [...names].sort((a, b) => (price.get(a) ?? 0) - (price.get(b) ?? 0));
  const chosen: string[] = [];
  let targets = new Map<string, DonationNeed>();
  const donationMoney = (each: ReadonlyMap<string, DonationNeed>) =>
    [...each.values()].reduce(
      (sum, need) =>
        sum + donationToReach(need.reputation - need.sellerReputation, terms.factionRep, terms.factionWorkRepGain),
      0,
    );
  for (let added = true; added; ) {
    added = false;
    for (const name of cheapestFirst) {
      if (chosen.includes(name)) continue;
      if (missingPrerequisites(name, { installed: state.installed, queued: [...state.queued, ...chosen] }).length > 0)
        continue;
      const need = donationFor(name);
      const tried = new Map(targets);
      if (need !== null && need.reputation > (tried.get(need.faction)?.reputation ?? 0)) tried.set(need.faction, need);
      const cost = purchaseSequenceCost(augmentationBuyOrder([...chosen, name]), state).money + donationMoney(tried);
      if (cost > money) continue;
      chosen.push(name);
      targets = tried;
      added = true;
      if (chosen.length > stopAbove) return chosen.length;
    }
  }
  return chosen.length;
}

/** How many of `names` can be had at all, whatever the money: their prerequisites owned, queued or among them. */
function countHadAtAll(names: readonly string[], state: AugmentationPurchaseState): number {
  const had: string[] = [];
  for (let added = true; added; ) {
    added = false;
    for (const name of names) {
      if (had.includes(name)) continue;
      if (missingPrerequisites(name, { installed: state.installed, queued: [...state.queued, ...had] }).length > 0)
        continue;
      had.push(name);
      added = true;
    }
  }
  return had.length;
}

/** What a slow snapshot shows of the joined factions' shops, for `heldBackOf`; null where it doesn't say. */
interface Shops {
  state: FactionState;
  purchaseState: AugmentationPurchaseState;
  multipliers: ReturnType<typeof augmentationBitNodeMultipliers>;
  joined: JoinedFaction[];
  shops: Map<string, string[]>;
  /**
   * Worth installing (core's `isWorthInstalling`, any short of Daedalus's count), sold by a joined faction, not owned
   * or queued. Never NeuroFlux Governor: its levels are endless, so more money always buys one more, and counting them
   * would make every cycle "money"; the bar with them falls as the bar does.
   */
  unowned: string[];
}

function shopsOf(data: SlowSnapshotData): Shops | null {
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
    // Checked now: a name core doesn't know is null, not a throw later.
    augmentationCost(NEUROFLUX_GOVERNOR, purchaseState);
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
    const unowned = [...new Set([...shops.values()].flat())].filter(
      (name) => name !== NEUROFLUX_GOVERNOR && !owned(name) && isWorthInstalling(name, short),
    );
    return { state, purchaseState, multipliers, joined, shops, unowned };
  } catch {
    return null;
  }
}

/** Whether a slow snapshot shows nothing left to count at the joined factions ("factions"), or null where unknown. */
function nothingLeftAt(data: SlowSnapshotData): boolean | null {
  const shops = shopsOf(data);
  return shops === null ? null : shops.unowned.length === 0;
}

/**
 * What held the count back at a slow snapshot (`HeldBack`), from its faction state and `ownedAugs` and the medium
 * snapshot's money: the unowned augmentations worth installing (`Shops.unowned`), counted three ways
 * (`countAffordable`): as things are (reputation reached, or a donation's money where the seller's donations are
 * unlocked); with the reputation reached at every faction whose donations are locked (at one unlocked, the reputation
 * is money's, so its donation is still paid); and with the money unlimited. Null where the snapshot doesn't say (no
 * faction state, an unread one, malformed `resetInfo`) or core doesn't know a name in it.
 */
export function heldBackOf(data: SlowSnapshotData, player: PlayerFigures): HeldBack | null {
  const shops = shopsOf(data);
  if (shops === null) return null;
  const { purchaseState, multipliers, joined, unowned } = shops;
  if (unowned.length === 0) return "factions";
  try {
    const needed = new Map(unowned.map((name) => [name, augmentationCost(name, purchaseState).reputation]));
    const sellers = (name: string) => joined.filter((faction) => shops.shops.get(faction.name)?.includes(name));
    const reached = (name: string) => sellers(name).some((faction) => faction.reputation >= (needed.get(name) ?? 0));
    const unlocked = (faction: JoinedFaction) =>
      acceptsDonations(faction.name, null) && donationsUnlocked(faction.favor, multipliers);
    const donationTerms = donationTermsOf(
      joined,
      shops.shops,
      unowned.filter((name) => !reached(name)),
      player.factionRep,
      multipliers,
    );
    // Its donation, where no joined seller's reputation reaches it: at the seller taking donations with the most.
    const donation = (name: string): DonationNeed | null => {
      if (reached(name)) return null;
      const donor = (donationTerms.sellers[name] ?? []).reduce<{ faction: string; reputation: number } | null>(
        (best, each) => (best === null || each.reputation > best.reputation ? each : best),
        null,
      );
      return donor === null
        ? null
        : { faction: donor.faction, sellerReputation: donor.reputation, reputation: needed.get(name) ?? 0 };
    };
    const buyable = unowned.filter((name) => reached(name) || (donationTerms.sellers[name]?.length ?? 0) > 0);
    const now = countAffordable(buyable, purchaseState, player.money, donation, donationTerms);
    // Reputation reached where donations are locked: one sold only where they're unlocked still pays its donation.
    const lockedSomewhere = (name: string) => sellers(name).some((faction) => !unlocked(faction));
    const withReputation =
      countAffordable(
        unowned,
        purchaseState,
        player.money,
        (name) => (lockedSomewhere(name) ? null : donation(name)),
        donationTerms,
        now,
      ) > now;
    const withMoney = countHadAtAll(buyable, purchaseState) > now;
    if (withReputation && withMoney) return "reputation and money";
    if (withReputation) return "reputation";
    if (withMoney) return "money";
    return "count";
  } catch {
    return null;
  }
}

/**
 * "BN1.2": the BitNode and its level, one more than its Source-File's. Our count, not the game's: the game caps the
 * level at 3 (`BitNode/BitNodeUtils.ts:102-104`), so at Source-File 1.3 its portal reads "Enter BN1.3" where this says
 * BN1.4.
 */
export function bitNodeLabel(currentNode: number, ownedSF: Readonly<Record<string, unknown>>): string {
  const level = ownedSF[String(currentNode)];
  return `BN${currentNode}.${(isFiniteNumber(level) ? level : 0) + 1}`;
}

/** A BitNode as the slow snapshots show it (`lastNodeReset`, #244): where it starts, and its first and last look. */
export interface BitNodeSpan {
  lastNodeReset: number;
  label: string;
  /**
   * Its label, with " #2" on for a label seen again (#311: a replay at the cap, BN1.4 into BN1.4; a new game, a save
   * loaded), as the campaign report names it: unique among the BitNodes seen, so their cycles never merge. The run
   * report counts names within its window, so one BitNode can be "BN1.4" there and "BN1.4 #3" in the campaign.
   */
  name: string;
  currentNode: number;
  /** Its start by the brain's clock: `lastNodeReset`, from the previous BitNode's last slow snapshot to its first. */
  startMs: number;
  /** Its first look's `lastAugReset` isn't its `lastNodeReset`: an install before then, its first cycle unseen. */
  installedBeforeFirstLook: boolean;
  firstSlowAtMs: number;
  lastSlowAtMs: number;
}

/** An augmentation cycle as the slow snapshots show it (`lastAugReset`, #244), and its first look's `resetInfo`. */
export interface CycleSpan {
  lastAugReset: number;
  /** Its BitNode's index in `ResetDetection.bitNodes`. */
  bitNode: number;
  /** Its start by the brain's clock: `lastAugReset`, from its BitNode's start or the last cycle's last look on. */
  startMs: number;
  firstSlowAtMs: number;
  lastSlowAtMs: number;
  ownedAugs: Record<string, number> | null;
  ownedSF: Record<string, number>;
  currentNode: number;
}

/**
 * Where each BitNode and augmentation cycle starts (#244), from the slow snapshots' `resetInfo` in order: another
 * `lastNodeReset` is another BitNode, another `lastAugReset` (or BitNode) another cycle. The run report's
 * (`BitNodeCycles`) and the campaign report's (#290), each making its own record of a BitNode and a cycle from the span
 * (`newBitNode`, `newCycle`), which this then keeps up to date.
 */
export class ResetDetection<B extends BitNodeSpan = BitNodeSpan, C extends CycleSpan = CycleSpan> {
  readonly bitNodes: B[] = [];
  readonly cycles: C[] = [];
  readonly #newBitNode: (span: BitNodeSpan) => B;
  readonly #newCycle: (span: CycleSpan) => C;

  constructor({
    newBitNode = (span) => span as B,
    newCycle = (span) => span as C,
  }: { newBitNode?: (span: BitNodeSpan) => B; newCycle?: (span: CycleSpan) => C } = {}) {
    this.#newBitNode = newBitNode;
    this.#newCycle = newCycle;
  }

  /** A reset's time by the brain's clock: the game's, moved by this snapshot's clocks' offset, within the bounds. */
  static #startOf(resetMs: number, atMs: number, gameTimeMs: number, earliestMs: number): number {
    const offset = atMs - gameTimeMs;
    const moved = resetMs + (isFiniteNumber(offset) && Math.abs(offset) <= CLOCK_OFFSET_SANE_MS ? offset : 0);
    return Math.max(earliestMs, Math.min(atMs, moved));
  }

  /** The BitNode and cycle a slow snapshot shows, new or not; null where its `resetInfo` doesn't say. */
  add(atMs: number, gameTimeMs: number, data: SlowSnapshotData): { bitNode: B; cycle: C } | null {
    const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
    const { lastAugReset, lastNodeReset, currentNode } = info ?? {};
    if (!isFiniteNumber(lastAugReset) || !isFiniteNumber(lastNodeReset) || !Number.isInteger(currentNode)) return null;
    const ownedSF = fieldsOf(info?.ownedSF) as Record<string, number>;
    const ownedAugs = typeof info?.ownedAugs === "object" && info.ownedAugs !== null ? info.ownedAugs : null;
    let bitNode = this.bitNodes.at(-1);
    if (bitNode?.lastNodeReset !== lastNodeReset) {
      const label = bitNodeLabel(currentNode as number, ownedSF);
      const played = this.bitNodes.filter((each) => each.label === label).length + 1;
      bitNode = this.#newBitNode({
        lastNodeReset,
        label,
        name: played === 1 ? label : `${label} #${played}`,
        currentNode: currentNode as number,
        startMs: ResetDetection.#startOf(
          lastNodeReset,
          atMs,
          gameTimeMs,
          bitNode?.lastSlowAtMs ?? Number.NEGATIVE_INFINITY,
        ),
        installedBeforeFirstLook: lastAugReset !== lastNodeReset,
        firstSlowAtMs: atMs,
        lastSlowAtMs: atMs,
      });
      this.bitNodes.push(bitNode);
    }
    bitNode.lastSlowAtMs = atMs;
    const bitNodeIndex = this.bitNodes.length - 1;
    let cycle = this.cycles.at(-1);
    if (cycle?.lastAugReset !== lastAugReset || cycle.bitNode !== bitNodeIndex) {
      const earliestMs = Math.max(bitNode.startMs, cycle?.lastSlowAtMs ?? Number.NEGATIVE_INFINITY);
      cycle = this.#newCycle({
        lastAugReset,
        bitNode: bitNodeIndex,
        startMs: ResetDetection.#startOf(lastAugReset, atMs, gameTimeMs, earliestMs),
        firstSlowAtMs: atMs,
        lastSlowAtMs: atMs,
        ownedAugs: ownedAugs as Record<string, number> | null,
        ownedSF,
        currentNode: currentNode as number,
      });
      this.cycles.push(cycle);
    }
    cycle.lastSlowAtMs = atMs;
    return { bitNode, cycle };
  }
}

/** When a milestone was first seen: its time, or before the window; and the faction, for the first one joined. */
interface Milestone {
  atMs: number;
  beforeWindow: boolean;
  detail?: string;
}

/** A BitNode the window's slow snapshots show (`lastNodeReset`), with its milestones (#244). */
interface BitNode extends BitNodeSpan {
  /** Begun before the window, with an install in it before the window too: its first look's cycle isn't its first. */
  installedBeforeWindow: boolean;
  firstMediumAtMs: number | null;
  /** The newest record in it: a snapshot of any tier, or an event. */
  lastRecordMs: number;
  firstFaction: Milestone | null;
  donationsUnlocked: Map<string, Milestone>;
  daedalusCount: Milestone | null;
  daedalusRequired: number | null;
  daedalusJoined: Milestone | null;
  /** Daedalus's favour as the slow snapshots first showed it joined: above 0, it was joined in a cycle before. */
  daedalusFirstFavor: number | null;
  redPill: Milestone | null;
}

/** A medium snapshot's figures, as a cycle keeps them. */
interface MediumPoint {
  atMs: number;
  money: number | null;
  hacking: number | null;
  factionRep: number | null;
}

/** A slow snapshot to judge for what held its cycle back, and the time online it stands for (to the next one). */
interface Judgement {
  atMs: number;
  data: SlowSnapshotData;
  onlineMs: number;
  nothingLeft: boolean | null;
}

/** An augmentation cycle the window's slow snapshots show (`lastAugReset`), and what the report keeps of it. */
interface Cycle extends CycleSpan {
  clock: OnlineClock | null;
  /** The install the brain chose at or after its start and didn't call off (never with none): judged until then. */
  chosenAtMs: number;
  /** Each faction's favour as first seen in it: an install leaves every faction, so one shows once joined again. */
  favorSeen: Map<string, number>;
  lastJoined: JoinedFaction[] | null;
  judgements: Judgement[];
  medium: MediumPoint[];
  /** The fast snapshots' share bonuses, added up, and how many had a batcher health field (absent: older Agent). */
  shareSum: number;
  shareCount: number;
  targets: string[];
}

/** What a cycle's summary line and block say, worked out once. */
interface CycleView {
  label: string;
  start: string;
  length: string;
  endedBy: string;
  count: string;
  heldBack: string;
  topAnswer: string;
  lines: string[];
}

/**
 * The BitNodes and cycles over a window (#244). `events` are the window's, and `earlier` the install decisions in the
 * day before it (`INSTALL_DECISION_EVENT_KINDS`): a window opening after an install was chosen doesn't judge its
 * buying. The slow snapshots come first, in order, then the medium and the fast ones, each in order.
 */
export class BitNodeCycles {
  readonly bitNodes: BitNode[];
  readonly #cycles: Cycle[];
  readonly #resets: ResetDetection<BitNode, Cycle>;
  readonly #events: readonly StoredEvent[];
  readonly #decisions: readonly StoredEvent[];
  readonly #sinceMs: number;

  constructor(events: readonly StoredEvent[], { sinceMs }: { sinceMs: number }, earlier: readonly StoredEvent[] = []) {
    this.#events = events;
    this.#decisions = [...earlier, ...events]
      .filter((event) => INSTALL_DECISION_EVENT_KINDS.includes(event.kind))
      .sort((a, b) => a.atMs - b.atMs);
    this.#sinceMs = sinceMs;
    this.#resets = new ResetDetection<BitNode, Cycle>({
      newBitNode: (span) => ({
        ...span,
        installedBeforeWindow: span.startMs < sinceMs && span.installedBeforeFirstLook,
        firstMediumAtMs: null,
        lastRecordMs: span.firstSlowAtMs,
        firstFaction: null,
        donationsUnlocked: new Map(),
        daedalusCount: null,
        daedalusRequired: null,
        daedalusJoined: null,
        daedalusFirstFavor: null,
        redPill: null,
      }),
      newCycle: (span) => ({
        ...span,
        clock: null,
        chosenAtMs: this.#installChosenFrom(span.startMs),
        favorSeen: new Map(),
        lastJoined: null,
        judgements: [],
        medium: [],
        shareSum: 0,
        shareCount: 0,
        targets: [],
      }),
    });
    this.bitNodes = this.#resets.bitNodes;
    this.#cycles = this.#resets.cycles;
  }

  /**
   * The BitNode `atMs` falls in, or -1: none seen, or before the first's start (an earlier BitNode's snapshots, with no
   * slow snapshot of it in the window: never mixed into the first's progress, #244 review).
   */
  bitNodeIndexAt(atMs: number): number {
    return this.bitNodes.findLastIndex((bitNode) => bitNode.startMs <= atMs);
  }

  /** Whether a slow snapshot by `atMs` showed the BitNode: with none, another can't be told from the first (#286). */
  bitNodeKnownBy(atMs: number): boolean {
    return this.bitNodes.some((bitNode) => bitNode.firstSlowAtMs <= atMs);
  }

  /**
   * When the first slow snapshot after `afterMs`, up to `untilMs`, arrived showing another BitNode (`lastNodeReset`):
   * a destroy seen done, as section 2's BitNodes line sees one (#286: for section 3's destroy intents, never reported
   * done, `ingame/src/page/destroy-page.ts:110`). Null for none. The window's first BitNode is no change.
   */
  bitNodeSeenBetween(afterMs: number, untilMs: number): number | null {
    const seen = this.bitNodes.find(
      (bitNode, index) => index > 0 && bitNode.firstSlowAtMs > afterMs && bitNode.firstSlowAtMs <= untilMs,
    );
    return seen?.firstSlowAtMs ?? null;
  }

  /** The cycle `atMs` falls in, or none before the first's start. */
  #cycleAt(atMs: number): Cycle | undefined {
    return this.#cycles.findLast((cycle) => cycle.startMs <= atMs);
  }

  /**
   * The cycle `atMs` falls in as 2b's summary names it, "BN1.1 2", for section 3's summaries (#245); "before BN1.1 1"
   * before the first, or "the window" with no cycle seen (no slow snapshot).
   */
  cycleLabelAt(atMs: number): string {
    const index = this.#cycles.findLastIndex((cycle) => cycle.startMs <= atMs);
    const cycle = this.#cycles[index];
    if (cycle !== undefined) return this.#labelOf(cycle, index);
    const first = this.#cycles[0];
    return first === undefined ? "the window" : `before ${this.#labelOf(first, 0)}`;
  }

  /** "BN1.1 2": the BitNode's name ("BN1.4 #2" played again, #311) and the cycle's number in it. */
  #labelOf(cycle: Cycle, index: number): string {
    const number = this.#cycles.filter((each, at) => each.bitNode === cycle.bitNode && at <= index).length;
    return `${this.bitNodes[cycle.bitNode]?.name ?? "?"} ${number}`;
  }

  /** Where the cycle `atMs` falls in started, by the brain's clock, or null before the first (#245). */
  cycleStartAt(atMs: number): number | null {
    return this.#cycleAt(atMs)?.startMs ?? null;
  }

  /** Where each cycle starts (an install or a destroy), by the brain's clock, in order (#245). */
  resetsMs(): number[] {
    return this.#cycles.map((cycle) => cycle.startMs);
  }

  addSlow(atMs: number, gameTimeMs: number, data: SlowSnapshotData): void {
    const seen = this.#resets.add(atMs, gameTimeMs, data);
    if (seen === null) return;
    const { bitNode, cycle } = seen;
    const { lastAugReset } = cycle;
    const ownedSF = fieldsOf(data.resetInfo?.ownedSF) as Record<string, number>;
    bitNode.lastRecordMs = Math.max(bitNode.lastRecordMs, atMs);
    // The bars' clock, as the rule folds it (#222): the time online, gaps left out. Each step is the state before it's.
    const before = cycle.clock?.onlineMs ?? 0;
    cycle.clock = advanceOnlineClock(cycle.clock, gameTimeMs, lastAugReset).clock;
    const { chosenAtMs } = cycle;
    const current = cycle.judgements.at(-1);
    if (current !== undefined && atMs <= chosenAtMs) current.onlineMs += cycle.clock.onlineMs - before;
    if (atMs < chosenAtMs) {
      const nothingLeft = nothingLeftAt(data);
      if (
        current === undefined ||
        atMs - current.atMs >= HELD_BACK_JUDGED_EVERY_MS ||
        nothingLeft !== current.nothingLeft
      ) {
        cycle.judgements.push({ atMs, data, onlineMs: 0, nothingLeft });
      }
    }
    const state = factionReadingOf(data)?.state ?? null;
    if (state !== null) {
      for (const { name, favor } of state.joined) if (!cycle.favorSeen.has(name)) cycle.favorSeen.set(name, favor);
      cycle.lastJoined = state.joined;
    }
    this.#slowMilestones(bitNode, cycle, atMs, data, state, ownedSF);
  }

  /**
   * The install the brain chose from `atMs` on and didn't call off before choosing again (#244 review: a cycle called
   * off goes on), or never. Its decisions from the day before the window too.
   */
  #installChosenFrom(atMs: number): number {
    let pending: StoredEvent | null = null;
    for (const decision of this.#decisions) {
      if (decision.atMs < atMs) continue;
      if (decision.kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND) pending = null;
      else if (pending !== null) return pending.atMs;
      else pending = decision;
    }
    return pending?.atMs ?? Number.POSITIVE_INFINITY;
  }

  #milestone(bitNode: BitNode, atMs: number, firstLookMs: number | null, detail?: string): Milestone {
    const beforeWindow = atMs === firstLookMs && bitNode.startMs < this.#sinceMs;
    return { atMs, beforeWindow, ...(detail === undefined ? {} : { detail }) };
  }

  #slowMilestones(
    bitNode: BitNode,
    cycle: Cycle,
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
        bitNode.daedalusCount = this.#milestone(bitNode, atMs, bitNode.firstSlowAtMs);
      }
      for (const faction of state?.joined ?? []) {
        if (faction.name === DAEDALUS) bitNode.daedalusFirstFavor ??= faction.favor;
        if (bitNode.donationsUnlocked.has(faction.name) || !acceptsDonations(faction.name, null)) continue;
        // Favour changes only at an install: dated at the one that raised it, not at the join after it (#244 review).
        if (donationsUnlocked(faction.favor, multipliers)) {
          bitNode.donationsUnlocked.set(faction.name, {
            atMs: cycle.startMs,
            beforeWindow: cycle.startMs < this.#sinceMs,
          });
        }
      }
    } catch {}
    const redPill = Object.hasOwn(ownedAugs, THE_RED_PILL) || (state?.queuedAugmentations ?? []).includes(THE_RED_PILL);
    if (redPill && bitNode.redPill === null) bitNode.redPill = this.#milestone(bitNode, atMs, bitNode.firstSlowAtMs);
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const player = fieldsOf(data?.player);
    const bitNode = this.bitNodes[this.bitNodeIndexAt(atMs)];
    if (bitNode !== undefined) {
      bitNode.firstMediumAtMs ??= atMs;
      bitNode.lastRecordMs = Math.max(bitNode.lastRecordMs, atMs);
      const factions = Array.isArray(player.factions)
        ? player.factions.filter((name): name is string => typeof name === "string")
        : [];
      const [first] = factions;
      if (bitNode.firstFaction === null && first !== undefined) {
        bitNode.firstFaction = bitNode.installedBeforeWindow
          ? { atMs, beforeWindow: true, detail: first }
          : this.#milestone(bitNode, atMs, bitNode.firstMediumAtMs, first);
      }
      if (bitNode.daedalusJoined === null && factions.includes(DAEDALUS)) {
        bitNode.daedalusJoined = this.#milestone(bitNode, atMs, bitNode.firstMediumAtMs);
      }
    }
    const cycle = this.#cycleAt(atMs);
    if (cycle === undefined) return;
    const hacking = fieldsOf(player.skills).hacking;
    const factionRep = fieldsOf(player.mults).faction_rep;
    cycle.medium.push({
      atMs,
      money: isFiniteNumber(player.money) ? player.money : null,
      hacking: isFiniteNumber(hacking) ? hacking : null,
      factionRep: isFiniteNumber(factionRep) ? factionRep : null,
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
    if (typeof target === "string" && !cycle.targets.includes(target)) cycle.targets.push(target);
  }

  // --- The lines -----------------------------------------------------------------------------------------------------

  /**
   * The BitNodes line (#244): each entered in the window, with its start, and destroyed (the next one seen) or not,
   * with how long it lasted, or has so far, and the BitNode it went into (#321): the next one seen, or the one the
   * destroy sent named. "not recorded" with no slow snapshot.
   */
  bitNodesLine(): string {
    if (this.bitNodes.length === 0) return "  BitNodes: not recorded (no slow snapshot in the window)";
    const each = this.bitNodes.map((bitNode, index) => {
      const next = this.bitNodes[index + 1];
      const before = bitNode.startMs < this.#sinceMs ? " (before the window)" : "";
      const from = `from ${formatIsoTime(bitNode.startMs)}${before}`;
      if (next !== undefined) {
        return `${bitNode.name} ${from}, destroyed after ${formatDuration(next.startMs - bitNode.startMs)}, into ${next.name}`;
      }
      const endMs = Math.max(bitNode.lastRecordMs, ...this.#eventsIn(index).map((event) => event.atMs));
      const sent = this.#destroySentIn(index);
      const into = this.#eventsIn(index).find((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND);
      const nextBitNode = into === undefined ? undefined : fieldsOf(into.detail).nextBitNode;
      const intoText = typeof nextBitNode === "number" ? `, into BitNode ${nextBitNode}` : "";
      const destroyed =
        sent === null
          ? "not destroyed"
          : `destroy sent at ${formatIsoTime(sent)}${intoText}, the next BitNode not seen`;
      const lasted = formatDuration(endMs - bitNode.startMs);
      return `${bitNode.name} ${from}, ${destroyed}, ${lasted} by the window's last record`;
    });
    return `  BitNodes: ${each.join("; ")}`;
  }

  /** The label of the progress before the first BitNode's start (`bitNodeIndexAt`'s -1), or none known at all. */
  labelBefore(): string {
    const first = this.bitNodes[0];
    return first === undefined
      ? "BitNode not recorded"
      : `before ${first.name}'s start (an earlier BitNode, with no slow snapshot of it in the window)`;
  }

  #eventsIn(index: number): StoredEvent[] {
    return this.#events.filter((event) => this.bitNodeIndexAt(event.atMs) === index);
  }

  #destroySentIn(index: number): number | null {
    return this.#eventsIn(index).find((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND)?.atMs ?? null;
  }

  /** A BitNode's milestones (#244), with the time since its start: indented under its progress. */
  milestoneLines(index: number): string[] {
    const bitNode = this.bitNodes[index];
    if (bitNode === undefined) return [];
    const since = (milestone: Milestone | null, what = "") =>
      milestone === null
        ? "not in the window"
        : milestone.beforeWindow
          ? `${what}before the window`
          : `${what}+${formatDuration(milestone.atMs - bitNode.startMs)} (${formatIsoTime(milestone.atMs)})`;
    const lines = ["milestones (the time since the BitNode's start):"];
    const first = bitNode.firstFaction;
    lines.push(`  first faction joined: ${since(first, first?.detail === undefined ? "" : `${first.detail}, `)}`);
    const unlocked = [...bitNode.donationsUnlocked].map(([faction, milestone]) => since(milestone, `${faction} `));
    lines.push(
      "  donations unlocked (at the install that raised the favour): " +
        (unlocked.length === 0 ? "none in the window" : unlocked.join(", ")),
    );
    const required = bitNode.daedalusRequired === null ? "" : ` (${bitNode.daedalusRequired} installed)`;
    lines.push(`  Daedalus's count reached${required}: ${since(bitNode.daedalusCount)}`);
    // Joined in the window with favour already: joined first in a cycle before the window (#244 review).
    const joined = bitNode.daedalusJoined;
    const rejoined =
      joined !== null &&
      !joined.beforeWindow &&
      (bitNode.daedalusFirstFavor ?? 0) > 0 &&
      bitNode.startMs < this.#sinceMs;
    lines.push(`  Daedalus joined: ${rejoined ? `before the window; again ${since(joined)}` : since(joined)}`);
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
   * Section 2b (#244): a summary line per cycle (the issue's table), then each cycle's block, a BitNode at a time.
   * `readings` are the brain's worked faction's reputation (`FactionWorkTimeline.readings`).
   */
  section(readings: readonly ReputationPoint[]): string[] {
    const lines = [
      "2b. Augmentation cycles (each from an install's lastAugReset to the next reset; #244)",
      "  held back by: what more of would have raised the count the install rule waits on, estimated (the cheapest " +
        `first, not the brain's set) every ${formatDuration(HELD_BACK_JUDGED_EVERY_MS)} of a cycle's slow snapshots ` +
        "until its install was chosen, by time online: reputation (the money covering it), money (the reputation " +
        "reached, or a donation's), reputation and money, count (neither: it waits on the bar), factions (nothing " +
        "left to count at the joined factions); or the brain's own state where the count isn't what it waits on: The " +
        "Red Pill's way (held for Daedalus, The Red Pill or the destroy), count reached (a countdown, or held for " +
        "Daedalus's count)",
    ];
    if (this.#cycles.length === 0) return [...lines, "  not recorded (no slow snapshot in the window)"];
    const views = this.#cycles.map((cycle, index) => this.#view(cycle, index, readings));
    const header = ["cycle", "start", "length", "ended by", "count", "held back by (most)"];
    const rows = [
      header,
      ...views.map((view) => [view.label, view.start, view.length, view.endedBy, view.count, view.topAnswer]),
    ];
    const widths = header.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
    lines.push("  summary, one line a cycle:");
    for (const row of rows)
      lines.push(
        `    ${row
          .map((cell, column) => cell.padEnd(widths[column] ?? 0))
          .join("  ")
          .trimEnd()}`,
      );
    for (const [bitNodeIndex, bitNode] of this.bitNodes.entries()) {
      lines.push(`  ${bitNode.name}:`);
      for (const [index, cycle] of this.#cycles.entries()) {
        if (cycle.bitNode === bitNodeIndex) lines.push(...(views[index]?.lines ?? []).map((line) => `    ${line}`));
      }
    }
    return lines;
  }

  #view(cycle: Cycle, index: number, readings: readonly ReputationPoint[]): CycleView {
    const next = this.#cycles[index + 1];
    const installed = next !== undefined && next.bitNode === cycle.bitNode;
    const destroyed = next !== undefined && !installed;
    const number = this.#cycles.filter((each, at) => each.bitNode === cycle.bitNode && at <= index).length;
    const endMs = next?.startMs ?? Math.max(cycle.lastSlowAtMs, ...cycle.medium.map((point) => point.atMs));
    const inCycle = (atMs: number) => atMs >= cycle.startMs && (next === undefined || atMs < next.startMs);
    const events = this.#events.filter((event) => inCycle(event.atMs)).sort((a, b) => a.atMs - b.atMs);
    // The brain's clock in its progress events carries time from before the window (#222).
    const progressOnline = this.#progressOf(cycle)
      .map((event) => fieldsOf(event.detail).onlineMs)
      .filter(isFiniteNumber);
    const onlineMs = Math.max(cycle.clock?.onlineMs ?? 0, ...progressOnline);
    const start = `${formatIsoTime(cycle.startMs)}${cycle.startMs < this.#sinceMs ? " (before the window)" : ""}`;
    const length = `${formatDuration(endMs - cycle.startMs)}${next === undefined ? " so far" : ""}`;
    const endedBy = this.#endedBy(next, installed, events);
    const { line: installedLine, count } = this.#installed(cycle, installed ? next : undefined, destroyed);
    const { line: heldBack, top } = this.#heldBack(cycle);
    const lines = [
      `cycle ${number} from ${start}, ${length} (${formatDuration(onlineMs)} online), ${endedBy}`,
      `  ${installedLine}`,
      `  held back by: ${heldBack}`,
      `  faction work: ${this.#workLine(
        readings.filter((each) => inCycle(each.atMs)),
        events,
      )}`,
      `  favour: ${this.#favourLine(cycle, installed ? next : undefined, destroyed)}`,
    ];
    // The money unspent while it was judged: once the install is chosen, the set's buying spends it.
    const chosen = Number.isFinite(cycle.chosenAtMs);
    const moneys = cycle.medium
      .filter((point) => !chosen || point.atMs <= cycle.chosenAtMs)
      .map((point) => point.money)
      .filter(isFiniteNumber);
    const share =
      cycle.shareCount === 0 ? "not recorded" : `×${(cycle.shareSum / cycle.shareCount).toFixed(2)} on average`;
    lines.push(
      `  share bonus: ${share}; most money unspent${chosen ? " until its install was chosen" : ""}: ` +
        (moneys.length === 0 ? "not recorded" : formatMoney(Math.max(...moneys))),
    );
    const hacking = cycle.medium.map((point) => point.hacking).filter(isFiniteNumber);
    const [firstHacking] = hacking;
    lines.push(
      `  hacking: ${
        firstHacking === undefined
          ? "not recorded"
          : `${formatWhole(firstHacking)} → ${formatWhole(hacking.at(-1) ?? firstHacking)}, ` +
            `most ${formatWhole(Math.max(...hacking))}`
      }`,
    );
    const targets =
      cycle.shareCount === 0 ? "not recorded" : cycle.targets.length === 0 ? "none" : cycle.targets.join(", ");
    lines.push(`  the batcher's targets: ${targets}`);
    const label = this.#labelOf(cycle, index);
    const short = endedBy.replace(/^ended by an? /, "").replace("not ended in the window", "not ended");
    return {
      label,
      start: formatIsoTime(cycle.startMs),
      length,
      endedBy: short,
      count,
      heldBack,
      topAnswer: top,
      lines,
    };
  }

  /** The progress events of a cycle (#222), by its `lastAugReset`, in time order. */
  #progressOf(cycle: Cycle): StoredEvent[] {
    return this.#events
      .filter(
        (event) =>
          event.kind === AUGMENTATION_PROGRESS_EVENT_KIND && fieldsOf(event.detail).lastAugReset === cycle.lastAugReset,
      )
      .sort((a, b) => a.atMs - b.atMs);
  }

  /**
   * "ended by an install (count reached)": its last install chosen and not called off after (#244 review), with its
   * reason; "… (yours)" for one from your queue; "… (none chosen in the window)"; "ended by a destroy"; or "not ended
   * in the window". `events` are the cycle's, in time order.
   */
  #endedBy(next: Cycle | undefined, installed: boolean, events: readonly StoredEvent[]): string {
    if (next === undefined) return "not ended in the window";
    if (!installed) return "ended by a destroy";
    let chosen: StoredEvent | null = null;
    for (const event of events) {
      if (event.kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND) chosen = event;
      if (event.kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND) chosen = null;
    }
    if (chosen !== null) {
      const reason = fieldsOf(chosen.detail).reason;
      return `ended by an install (${typeof reason === "string" ? reason : "reason not stored"})`;
    }
    const sent = events.findLast((event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND);
    if (sent !== undefined && fieldsOf(sent.detail).source === "manual") return "ended by an install (yours)";
    return "ended by an install (none chosen in the window)";
  }

  /**
   * What the install installed (the next cycle's `ownedAugs` gained, NeuroFlux Governor a level at a time), and
   * Daedalus's count before → after: "installed: 2 (BitWire, NeuroFlux Governor); Daedalus's count 4 → 5 of 30"; none
   * at a destroy, and not yet for a cycle still going. And the count alone, for the summary: "4 → 5", or "4".
   */
  #installed(cycle: Cycle, next: Cycle | undefined, destroyed: boolean): { line: string; count: string } {
    const count = (owned: Record<string, number> | null) => (owned === null ? null : Object.keys(owned).length);
    let required = "";
    try {
      required = ` of ${daedalusAugmentationsRequired(cycle.currentNode, cycle.ownedSF)}`;
    } catch {}
    const before = count(cycle.ownedAugs);
    if (next === undefined || cycle.ownedAugs === null || next.ownedAugs === null) {
      const installed = destroyed ? "none, the BitNode destroyed" : next === undefined ? "not yet" : "not recorded";
      const counted = before === null ? "not recorded" : String(before);
      return {
        line: `installed: ${installed}; Daedalus's count ${before === null ? counted : `${before}${required}`}`,
        count: counted,
      };
    }
    const gained: string[] = [];
    for (const [name, level] of Object.entries(next.ownedAugs)) {
      const had = cycle.ownedAugs[name];
      for (let each = isFiniteNumber(had) ? had : 0; each < level; each += 1) gained.push(name);
    }
    const counted = `${before} → ${count(next.ownedAugs)}`;
    return {
      line:
        `installed: ${gained.length}${gained.length === 0 ? "" : ` (${describeAugmentations(gained)})`}; ` +
        `Daedalus's count ${counted}${required}`,
      count: counted,
    };
  }

  /**
   * The cycle's answers by time online: "reputation (92% of 50 min online judged), count (8%)", each judgement the
   * brain's own state where its progress in force held the rule (The Red Pill's way) or had the count reached, else
   * `heldBackOf` with the latest medium snapshot's money. And the top answer, for the summary: "reputation 92%".
   */
  #heldBack(cycle: Cycle): { line: string; top: string } {
    const progress = this.#progressOf(cycle);
    const totals = new Map<CycleAnswer, number>();
    let judged = 0;
    let unjudged = 0;
    for (const judgement of cycle.judgements) {
      const answer = this.#answerAt(cycle, judgement, progress);
      if (answer === null) {
        unjudged += 1;
        continue;
      }
      judged += judgement.onlineMs;
      totals.set(answer, (totals.get(answer) ?? 0) + judgement.onlineMs);
    }
    const none = (line: string) => ({ line, top: "—" });
    if (cycle.judgements.length === 0) return none("not judged: its install was chosen before its first slow snapshot");
    if (unjudged === cycle.judgements.length) {
      return none("not judged: no faction state or money recorded with its slow snapshots");
    }
    if (judged === 0) {
      return none(
        Number.isFinite(cycle.chosenAtMs)
          ? "nothing: its install was chosen at once"
          : "not judged yet: no time online between its slow snapshots (one so far, or gaps)",
      );
    }
    const ranked = ANSWER_ORDER.filter((answer) => (totals.get(answer) ?? 0) > 0).sort(
      (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
    );
    const percent = (answer: CycleAnswer) => Math.round((100 * (totals.get(answer) ?? 0)) / judged);
    const shares = ranked.map(
      (answer, rank) =>
        `${answer} (${percent(answer)}%${rank === 0 ? ` of ${formatDuration(judged)} online judged` : ""})`,
    );
    const [top] = ranked;
    return {
      line: shares.join(", ") + (unjudged > 0 ? `; ${unjudged} not judged (no faction state or money)` : ""),
      top: top === undefined ? "—" : `${top} ${percent(top)}%`,
    };
  }

  /**
   * What held the cycles back from `fromMs` to `toMs`, for section 5's hours (#245): 2b's judgements made in it, by
   * time online, the most first (answers tied for the most named together). Where those are reputation, the count or
   * the brain's own state, income wasn't what the cycle waited on, and the most money the judgements giving them saw
   * says so: "held back by reputation, not income (92% of 55 min online judged in the hour; count 8%); most money
   * unspent $766,000,000,000,000" (each judgement's own figure, so never another BitNode's). Where money is among them,
   * "held back by money: income (…)"; "factions" says neither, as joining one can cost a travel. Or not judged.
   */
  heldBackBetween(fromMs: number, toMs: number): string {
    const onlineByAnswer = new Map<CycleAnswer, number>();
    const moneyByAnswer = new Map<CycleAnswer, number>();
    let onlineJudgedMs = 0;
    let judgementsInHour = 0;
    let judgementsAnswered = 0;
    for (const cycle of this.#cycles) {
      const progress = this.#progressOf(cycle);
      for (const judgement of cycle.judgements.filter(({ atMs }) => atMs >= fromMs && atMs < toMs)) {
        judgementsInHour += 1;
        const answer = this.#answerAt(cycle, judgement, progress);
        if (answer === null) continue;
        judgementsAnswered += 1;
        onlineJudgedMs += judgement.onlineMs;
        onlineByAnswer.set(answer, (onlineByAnswer.get(answer) ?? 0) + judgement.onlineMs);
        const money = this.#figuresAt(cycle, judgement)?.money;
        if (isFiniteNumber(money)) moneyByAnswer.set(answer, Math.max(moneyByAnswer.get(answer) ?? money, money));
      }
    }
    if (onlineJudgedMs === 0) {
      const why =
        judgementsInHour === 0
          ? "no slow snapshot judged: its install already chosen, or none"
          : judgementsAnswered === 0
            ? "no faction state or money"
            : "no time online between its slow snapshots";
      return `held back by: not judged in the hour (${why})`;
    }
    const onlineOf = (answer: CycleAnswer) => onlineByAnswer.get(answer) ?? 0;
    const ranked = ANSWER_ORDER.filter((answer) => onlineOf(answer) > 0).sort((a, b) => onlineOf(b) - onlineOf(a));
    const percent = (answer: CycleAnswer) => `${Math.round((100 * onlineOf(answer)) / onlineJudgedMs)}%`;
    const tiedForMost = ranked.filter((answer) => onlineOf(answer) === onlineOf(ranked[0] as CycleAnswer));
    const others = ranked.slice(tiedForMost.length);
    const each = tiedForMost.length > 1 ? " each" : "";
    const shares =
      `${percent(tiedForMost[0] as CycleAnswer)}${each} of ${formatDuration(onlineJudgedMs)} ` +
      `online judged in the hour${others.map((answer) => `; ${answer} ${percent(answer)}`).join("")}`;
    const heldBy = `held back by ${tiedForMost.join(" and ")}${tiedForMost.length > 1 ? " equally" : ""}`;
    if (tiedForMost.some((answer) => answer === "money" || answer === "reputation and money")) {
      return `${heldBy}: income (${shares})`;
    }
    const moneySeen = tiedForMost.map((answer) => moneyByAnswer.get(answer)).filter(isFiniteNumber);
    const unspent = moneySeen.length === 0 ? "not recorded" : formatMoney(Math.max(...moneySeen));
    const unspentPart = `most money unspent ${unspent}`;
    if (tiedForMost.includes("factions")) return `${heldBy} (${shares}); ${unspentPart}`;
    return `${heldBy}, not income (${shares}); ${unspentPart}`;
  }

  /** The medium snapshot's figures a judgement is made with: the latest by it with money, else the cycle's first. */
  #figuresAt(cycle: Cycle, judgement: Judgement): MediumPoint | undefined {
    return (
      cycle.medium.findLast((point) => point.atMs <= judgement.atMs && point.money !== null) ??
      cycle.medium.find((point) => point.money !== null)
    );
  }

  /** One judgement's answer (`CycleAnswer`), or null where it can't be judged. */
  #answerAt(cycle: Cycle, judgement: Judgement, progress: readonly StoredEvent[]): CycleAnswer | null {
    const inForce = fieldsOf(progress.findLast((event) => event.atMs <= judgement.atMs)?.detail);
    if (typeof inForce.held === "string") return "The Red Pill's way";
    if (isFiniteNumber(fieldsOf(inForce.countdown).endsInMs) || Object.keys(fieldsOf(inForce.countHold)).length > 0) {
      return "count reached";
    }
    const figures = this.#figuresAt(cycle, judgement);
    if (figures === undefined) return null;
    return heldBackOf(judgement.data, { money: figures.money as number, factionRep: figures.factionRep ?? 1 });
  }

  /**
   * The brain's worked factions in the cycle (#203's readings): each one's reputation gained between readings no more
   * than `SLOW_SNAPSHOT_GAP_MS` apart (a donation's left out, #225), and that over the time between them. One with a
   * single reading says nothing, and is left out.
   */
  #workLine(readings: readonly ReputationPoint[], events: readonly StoredEvent[]): string {
    const factions = new Map<string, { earned: number; ms: number }>();
    const last = new Map<string, ReputationPoint>();
    for (const reading of readings) {
      const { atMs, faction, reputation } = reading;
      const before = last.get(faction);
      last.set(faction, reading);
      if (before === undefined || atMs - before.atMs > SLOW_SNAPSHOT_GAP_MS) continue;
      const totals = factions.get(faction) ?? { earned: 0, ms: 0 };
      factions.set(faction, totals);
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
          return isFiniteNumber(from) && isFiniteNumber(to) ? Math.max(0, to - from) : 0;
        })
        .reduce((sum, each) => sum + each, 0);
      totals.earned += Math.max(0, reputation - before.reputation - donated);
      totals.ms += atMs - before.atMs;
    }
    if (factions.size === 0) return "none recorded";
    return [...factions]
      .map(
        ([faction, { earned, ms }]) =>
          `${faction} +${formatWhole(earned)} reputation at ${(earned / (ms / 1000)).toFixed(2)}/s`,
      )
      .join("; ");
  }

  /**
   * The favour at the faction nearest donations (#225): of the joined factions taking donations whose donations aren't
   * unlocked, the one whose favour after the install is most; with all unlocked, the one with the most. After an
   * install, the next cycle's favour as first seen there, or core's `favorAfterInstall` where it isn't ("(predicted)");
   * at a destroy, favour is lost. "BitRunners 5 → 96; donations at 150", "Daedalus 150, donations unlocked".
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
        return isFiniteNumber(shown)
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
