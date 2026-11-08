// The campaign as the store shows it (#290, #285): every BitNode played, how it ended, its cycles and installs, its
// time online, by release. The campaign report (`campaign-report.ts`) prints it; the dashboard's timeline
// (`dashboard/timeline.ts`) shows it, folding each slow snapshot once as it's stored. Read from the slow snapshots'
// `resetInfo` and a few kinds of event alone, never a medium or fast snapshot, so a store thinned (#283) gives the same
// campaign. Where each BitNode and cycle starts is the run report's own detection (`ResetDetection`, #244); the time
// online is the bars' clock's rule (`advanceOnlineClock`, #222), run over a whole BitNode.
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { fieldsOf, isFiniteNumber } from "./augmentation-report.ts";
import { AUGMENTATION_INSTALL_SENT_EVENT_KIND, advanceOnlineClock, type OnlineClock } from "./augmentations.ts";
import { type BitNodeSpan, ResetDetection } from "./cycle-report.ts";
import { BRAIN_STARTED_EVENT_KIND } from "./dashboard/status.ts";
import { RELOAD_LEAD_MS } from "./run-report.ts";
import type { SlowResetInfo, StoredEvent } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";

/** The events the campaign reads: the brain's starts, the installs sent (yours among them), the destroys. */
export const CAMPAIGN_EVENT_KINDS = [
  BRAIN_STARTED_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  BITNODE_DESTROY_SENT_EVENT_KIND,
];

/**
 * A Source-File's highest level, past which destroying its BitNode gains nothing (`RedPill.tsx:28`): every BitNode's
 * but BitNode 12's, which has none.
 */
const SOURCE_FILE_CAP = 3;
const UNCAPPED_BITNODE = 12;

/**
 * A stored release as the campaign compares it: the brain's (`git describe` of its checkout, `brainRelease`), the part
 * before the first "+". The Agent's deployment after it changes with any rebuild: it would split one release in many.
 */
export function brainReleaseOf(stored: string): string {
  return stored.split("+")[0] || stored;
}

/** An install the slow snapshots saw: another `lastAugReset`, later than the last look, in the same BitNode. */
export interface Install {
  /** The cycle it ended started here (the brain's clock), and the new one was first seen here. */
  fromMs: number;
  atMs: number;
  /** When it was made, by the brain's clock: the new cycle's start (`ResetDetection`'s, from its `lastAugReset`). */
  installedAtMs: number;
  /** Not sent by the brain's own rule: no `augmentationInstallSent` from "brain" in the cycle it ended. */
  byHand: boolean;
  /**
   * The augmentations it installed: those `ownedAugs` gained from the last look to the first after, NeuroFlux
   * Governor once a level; null where either slow snapshot didn't record them.
   */
  augmentations: string[] | null;
}

/** What a release did in one BitNode. */
export interface ReleaseShare {
  onlineMs: number;
  /** The BitNode's cycles (`cycles`) it had a slow snapshot in. */
  cycles: Set<number>;
  /** The installs that ended a cycle whose last slow snapshot was its. */
  installs: Install[];
  /** Its first and last slow snapshots in the BitNode (the brain's clock). */
  firstAtMs: number;
  lastAtMs: number;
}

/** How the store came to a BitNode from the one before it. */
type Entry = "first" | "save loaded" | "reset";

/**
 * How the Source-Files changed at a reset (`sourceFileChange`), over those `sourceFileOverrides` hides on neither side:
 * - "gained": the BitNode's own went up one, nothing else changed: a destroy (`RedPill.tsx:62-63`);
 * - "gained, unseen": up more than one, or another rose too: destroyed, and BitNodes played the store didn't see;
 * - "unseen": another rose, its own didn't: BitNodes the store didn't see;
 * - "lost": one fell: a new game;
 * - "overridden": its own is overridden on either side, so its level doesn't say (`NetscriptFunctions.ts:1491-1495`);
 * - "none": none changed.
 */
type SourceFileChange = "gained" | "gained, unseen" | "unseen" | "lost" | "overridden" | "none";

/**
 * A cycle of a BitNode, one per `lastAugReset` its slow snapshots showed, in the order first seen (the dashboard's
 * timeline, #285). Its kind:
 * - "start": the BitNode's first, from its start (`lastAugReset` is its `lastNodeReset`);
 * - "seen first": its first look's, with an install before it the store didn't see;
 * - "install": begun by an install the slow snapshots saw;
 * - "save": a save's from a cycle never seen, loaded (not an install, not counted in `cycles`). A save loaded back to a
 *   cycle seen already goes on in that one.
 */
export interface CampaignCycle {
  lastAugReset: number;
  kind: "start" | "seen first" | "install" | "save";
  /** Its start by the brain's clock, as `ResetDetection` first saw it. */
  startMs: number;
  /**
   * Its time online: the steps to its slow snapshots, the step across an install split at the install's
   * `lastAugReset` (the game's time at it); a BitNode's cycles add up to its time online.
   */
  onlineMs: number;
  /** The installs that ended it: one, unless a save loaded back to it was installed from again. */
  endedBy: Install[];
  /** Each time a save loaded left it (the brain's clock: the first slow snapshot after), for another cycle (#285). */
  leftForSaveAtMs: number[];
}

/** A BitNode as the campaign keeps it. */
export interface CampaignBitNode extends BitNodeSpan {
  entry: Entry;
  /** At a reset, how the Source-Files changed from the BitNode before; null otherwise. */
  change: SourceFileChange | null;
  /** Its time online (`advanceOnlineClock` over the BitNode, keyed by its `lastNodeReset`), start and destroy in. */
  clock: OnlineClock;
  /** The game's time of its newest slow snapshot. */
  lastGameTimeMs: number;
  /** What its start's step left out (over the gap from `lastNodeReset` to its first look), and every step after. */
  startLeftOutMs: number;
  gapsMs: number[];
  /** By release, in the order each first played it. */
  releases: Map<string, ReleaseShare>;
  /** The release of its newest slow snapshot. */
  lastRelease: string;
  /** Every `lastAugReset` its slow snapshots showed, to tell a save loaded from an install (a clock set back too). */
  augResets: Set<number>;
  /** Its cycles: its first look's and each install's (`lastAugReset`), not a save's from a cycle never seen. */
  cycles: Set<number>;
  /** Every cycle its slow snapshots showed, in the order first seen (`CampaignCycle`), and the newest's. */
  cycleList: CampaignCycle[];
  currentCycle: CampaignCycle | null;
  installs: Install[];
  /** Where another cycle's `lastAugReset` was already seen, or before the last look: a save loaded. */
  savesLoadedAtMs: number[];
  /** Its first and newest slow snapshots' `ownedSF`; its newest's `ownedAugs`, NeuroFlux Governor's levels counted. */
  firstOwnedSF: Record<string, number>;
  lastOwnedSF: Record<string, number>;
  /** Its first and newest slow snapshots' `sourceFileOverrides` (BitNode options, `BitNodeUtils.ts:54-62`). */
  firstOverrides: Record<string, number>;
  lastOverrides: Record<string, number>;
  ownedAugs: Record<string, number> | null;
}

type ResetInfo = Partial<SlowSnapshotData["resetInfo"]>;
const sourceFilesOf = (info: ResetInfo) => fieldsOf(info.ownedSF) as Record<string, number>;
/** The BitNode's Source-File overrides: `ownedSF` shows an overridden one at its override (`activeSourceFiles`). */
const overridesOf = (info: ResetInfo) =>
  fieldsOf(fieldsOf(info.bitNodeOptions).sourceFileOverrides) as Record<string, number>;
const ownedAugsOf = (info: ResetInfo) =>
  typeof info.ownedAugs === "object" && info.ownedAugs !== null ? info.ownedAugs : null;

/** An `ownedAugs` level as installs: NeuroFlux Governor's level is its installs, any other's 1. */
export const installsOfLevel = (level: unknown) => (isFiniteNumber(level) && level > 1 ? level : 1);
export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Each augmentation installed from `before` to `after` (`ownedAugs`), once a level; null where either is unknown. */
export function augmentationsGained(
  before: Record<string, number> | null,
  after: Record<string, number> | null,
): string[] | null {
  if (before === null || after === null) return null;
  return Object.entries(after).flatMap(([name, level]) => {
    const had = Object.hasOwn(before, name) ? installsOfLevel(before[name]) : 0;
    return Array.from({ length: Math.max(0, installsOfLevel(level) - had) }, () => name);
  });
}

/** How the Source-Files changed from `before`'s last look to `next`'s first (`SourceFileChange`). */
function sourceFileChange(before: CampaignBitNode, next: CampaignBitNode): SourceFileChange {
  const overridden = new Set([...Object.keys(before.lastOverrides), ...Object.keys(next.firstOverrides)]);
  const level = (ownedSF: Record<string, number>, node: string) => (isFiniteNumber(ownedSF[node]) ? ownedSF[node] : 0);
  const compared = [...new Set([...Object.keys(before.lastOwnedSF), ...Object.keys(next.firstOwnedSF)])].filter(
    (node) => !overridden.has(node),
  );
  if (compared.some((node) => level(next.firstOwnedSF, node) < level(before.lastOwnedSF, node))) return "lost";
  const own = String(before.currentNode);
  const othersRose = compared.some(
    (node) => node !== own && level(next.firstOwnedSF, node) > level(before.lastOwnedSF, node),
  );
  if (overridden.has(own)) return othersRose ? "unseen" : "overridden";
  const gain = level(next.firstOwnedSF, own) - level(before.lastOwnedSF, own);
  if (gain === 0) return othersRose ? "unseen" : "none";
  return gain === 1 && !othersRose ? "gained" : "gained, unseen";
}

/**
 * The fold over the store's slow snapshots, in order of arrival (`iterateSlowResetInfo`): the report folds them all at
 * once, the dashboard's timeline each as it's stored (`add` keeps everything it needs to go on).
 */
export class CampaignFold {
  readonly #resets = new ResetDetection<CampaignBitNode>({
    newBitNode: (span) => ({
      ...span,
      entry: "first",
      change: null,
      // The bars' clock keyed by the BitNode's `lastNodeReset` (its `lastAugReset` field holds it): one clock for the
      // whole BitNode, from its start, installs and all.
      clock: advanceOnlineClock(null, span.lastNodeReset, span.lastNodeReset).clock,
      lastGameTimeMs: span.lastNodeReset,
      startLeftOutMs: 0,
      gapsMs: [],
      releases: new Map(),
      lastRelease: "",
      augResets: new Set(),
      cycles: new Set(),
      cycleList: [],
      currentCycle: null,
      installs: [],
      savesLoadedAtMs: [],
      firstOwnedSF: {},
      lastOwnedSF: {},
      firstOverrides: {},
      lastOverrides: {},
      ownedAugs: null,
    }),
  });
  readonly bitNodes = this.#resets.bitNodes;
  slowCount = 0;
  /** Slow snapshots whose `resetInfo` doesn't say the BitNode and cycle (malformed): left out, and counted. */
  unread = 0;

  add({ receivedAtMs: atMs, gameTimeMs, release: storedRelease, resetInfo }: SlowResetInfo): void {
    this.slowCount += 1;
    const info: ResetInfo = resetInfo ?? {};
    const release = brainReleaseOf(storedRelease);
    const before = this.bitNodes.at(-1);
    const lastCycle = this.#resets.cycles.at(-1);
    const seen = this.#resets.add(atMs, gameTimeMs, { resetInfo } as SlowSnapshotData);
    if (seen === null) {
      this.unread += 1;
      return;
    }
    const { bitNode, cycle } = seen;
    const isNew = bitNode !== before;
    const ownedAugs = ownedAugsOf(info);
    // Where the step to this slow snapshot goes, and where an install's step is split.
    const stepFrom = { gameTimeMs: bitNode.lastGameTimeMs, cycle: bitNode.currentCycle };
    let installedAt: number | null = null;
    if (isNew) {
      bitNode.firstOwnedSF = sourceFilesOf(info);
      bitNode.firstOverrides = overridesOf(info);
      bitNode.cycles.add(cycle.lastAugReset);
      this.#enter(
        bitNode,
        cycle.lastAugReset,
        bitNode.installedBeforeFirstLook ? "seen first" : "start",
        cycle.startMs,
      );
      if (before !== undefined) {
        // A start before the last look is a save's, loaded (an older BitNode, or a newer one gone back to); a start
        // after it, the game's: a destroy, b1t_flum3 or a new game (`endingOf` tells which), its edge online if near,
        // unless BitNodes the store didn't see came between.
        bitNode.entry = bitNode.lastNodeReset < before.lastGameTimeMs ? "save loaded" : "reset";
        if (bitNode.entry === "reset") {
          bitNode.change = sourceFileChange(before, bitNode);
          const unseen = bitNode.change === "unseen" || bitNode.change === "gained, unseen";
          if (!unseen) {
            const { onlineMs } = this.#step(before, bitNode.lastNodeReset, before.lastRelease);
            if (before.currentCycle !== null) before.currentCycle.onlineMs += onlineMs;
          }
        }
      }
    } else if (cycle !== lastCycle) {
      // Another cycle in the same BitNode: an install, its `lastAugReset` new and after the last look (the game's time
      // at the install, `PlayerObjectGeneralMethods.ts:126`), or a save loaded, older or newer. One edge: the PC's
      // clock set back before an install makes its `lastAugReset` earlier than the last look: read as a save loaded.
      if (bitNode.augResets.has(cycle.lastAugReset) || cycle.lastAugReset < bitNode.lastGameTimeMs) {
        bitNode.savesLoadedAtMs.push(atMs);
        stepFrom.cycle?.leftForSaveAtMs.push(atMs);
        this.#enter(bitNode, cycle.lastAugReset, "save", cycle.startMs);
      } else {
        const install: Install = {
          fromMs: lastCycle?.startMs ?? bitNode.startMs,
          atMs,
          installedAtMs: cycle.startMs,
          byHand: false,
          augmentations: augmentationsGained(bitNode.ownedAugs, ownedAugs),
        };
        bitNode.installs.push(install);
        bitNode.cycles.add(cycle.lastAugReset);
        this.#shareOf(bitNode, bitNode.lastRelease).installs.push(install);
        stepFrom.cycle?.endedBy.push(install);
        this.#enter(bitNode, cycle.lastAugReset, "install", cycle.startMs);
        installedAt = cycle.lastAugReset;
      }
    }
    // The step to this slow snapshot is its release's, a step across a change of release the new one's.
    const { leftOutMs, onlineMs } = this.#step(bitNode, gameTimeMs, release);
    if (isNew) bitNode.startLeftOutMs = Math.max(0, leftOutMs);
    // And its cycle's, but for the part of an install's step before the install: the cycle it ended.
    const beforeInstallMs =
      installedAt === null || stepFrom.cycle === null
        ? 0
        : Math.min(onlineMs, Math.max(0, installedAt - stepFrom.gameTimeMs));
    if (stepFrom.cycle !== null) stepFrom.cycle.onlineMs += beforeInstallMs;
    if (bitNode.currentCycle !== null) bitNode.currentCycle.onlineMs += onlineMs - beforeInstallMs;
    const share = this.#shareOf(bitNode, release);
    if (bitNode.cycles.has(cycle.lastAugReset)) share.cycles.add(cycle.lastAugReset);
    share.firstAtMs = Math.min(share.firstAtMs, atMs);
    share.lastAtMs = atMs;
    bitNode.augResets.add(cycle.lastAugReset);
    bitNode.lastRelease = release;
    bitNode.lastOwnedSF = sourceFilesOf(info);
    bitNode.lastOverrides = overridesOf(info);
    bitNode.ownedAugs = ownedAugs;
  }

  /** Makes the cycle `lastAugReset` the BitNode's current one: the one listed already, or a new one of `kind`. */
  #enter(bitNode: CampaignBitNode, lastAugReset: number, kind: CampaignCycle["kind"], startMs: number): void {
    let entered = bitNode.cycleList.find((each) => each.lastAugReset === lastAugReset);
    if (entered === undefined) {
      entered = { lastAugReset, kind, startMs, onlineMs: 0, endedBy: [], leftForSaveAtMs: [] };
      bitNode.cycleList.push(entered);
    }
    bitNode.currentCycle = entered;
  }

  /**
   * Moves a BitNode's clock to the game's `gameTimeMs`, the time online it adds the release's. Returns that time, and
   * the time it left out (a gap), or 0; a gap after the BitNode's start is kept.
   */
  #step(bitNode: CampaignBitNode, gameTimeMs: number, release: string): { leftOutMs: number; onlineMs: number } {
    const before = bitNode.clock.onlineMs;
    const { clock, leftOutMs } = advanceOnlineClock(bitNode.clock, gameTimeMs, bitNode.lastNodeReset);
    bitNode.clock = clock;
    bitNode.lastGameTimeMs = gameTimeMs;
    const onlineMs = clock.onlineMs - before;
    this.#shareOf(bitNode, release).onlineMs += onlineMs;
    const gapMs = leftOutMs !== null && leftOutMs > 0 ? leftOutMs : 0;
    // The first step is the start's: kept apart, as it counts only where the store saw the start.
    if (gapMs > 0 && bitNode.lastRelease !== "") bitNode.gapsMs.push(gapMs);
    return { leftOutMs: gapMs, onlineMs };
  }

  #shareOf(bitNode: CampaignBitNode, release: string): ReleaseShare {
    let share = bitNode.releases.get(release);
    if (share === undefined) {
      share = { onlineMs: 0, cycles: new Set(), installs: [], firstAtMs: Number.POSITIVE_INFINITY, lastAtMs: 0 };
      bitNode.releases.set(release, share);
    }
    return share;
  }
}

/**
 * How a BitNode ended, and when (the brain's clock), if it was destroyed and the next BitNode was the one after. Its
 * words hold `{at}` where its time `atMs` goes, if it has one (`describeEnding`): the report's ISO time, the page's
 * own.
 */
export interface Ending {
  text: string;
  atMs: number | null;
  /** False for the newest BitNode with no end seen: "not yet", or a destroy sent with the next BitNode not seen. */
  ended: boolean;
  destroyedAtMs: number | null;
  /** Destroyed, with BitNodes the store didn't see before the next: its destroy's time unknown, never a clear. */
  unseenAfter: boolean;
}

/** An ending's words, its time put in with `formatTime`. */
export function describeEnding(ending: Ending, formatTime: (ms: number) => string): string {
  return ending.atMs === null ? ending.text : ending.text.replace("{at}", formatTime(ending.atMs));
}

/** What the campaign says of one BitNode, worked out once. */
export interface BitNodeView {
  bitNode: CampaignBitNode;
  /** Its label, and " #2" on for a label played again (BN1.4 after SF1.3, a new game, or a save loaded). */
  name: string;
  /** Its start is before the store's first record: its time online is at least the one shown. */
  begunBefore: boolean;
  /** Its start the store saw: not begun before it, and not a save loaded. */
  startSeen: boolean;
  ending: Ending;
  wallMs: number;
  cycles: number;
  installs: number;
  byHand: number;
  /** The time online left out, each gap (the start's only where the store saw it). */
  gapsMs: number[];
  brainStarts: number;
  /** How the store came to it, where its start wasn't seen: begun before the store's first record, or a save loaded. */
  startNote: "before the store" | "a save loaded" | null;
  /** Not destroyed: its wall clock and time online run to its end, or its last look, "so far". */
  soFar: boolean;
  /** Lower bounds ("≥"): its wall clock (a save loaded), time online (its start unseen), cycles and installs. */
  wallAtLeast: boolean;
  onlineAtLeast: boolean;
  countsAtLeast: boolean;
}

/** The campaign over the slow snapshots folded and the events (`CAMPAIGN_EVENT_KINDS`, in the order stored). */
export interface CampaignViews {
  views: BitNodeView[];
  /** The first and last record read: a slow snapshot's or an event's. */
  firstMs: number;
  lastMs: number;
  /** The releases, in the order first seen. */
  releases: string[];
  brainStarts: number;
}

/** The campaign's BitNodes as `fold` and `events` show them, or null with none; each install marked by hand or not. */
export function campaignViews(fold: CampaignFold, events: readonly StoredEvent[]): CampaignViews | null {
  const { bitNodes } = fold;
  if (bitNodes.length === 0) return null;
  // Each install by hand or not: the brain's has its `augmentationInstallSent` in the cycle it ended.
  const sentByBrain = events.filter(
    (event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND && fieldsOf(event.detail).source === "brain",
  );
  for (const install of bitNodes.flatMap((bitNode) => bitNode.installs)) {
    install.byHand = !sentByBrain.some((event) => event.atMs > install.fromMs && event.atMs <= install.atMs);
  }
  const times = [...bitNodes.flatMap((each) => [each.firstSlowAtMs, each.lastSlowAtMs]), ...events.map((e) => e.atMs)];
  const firstMs = Math.min(...times);
  return {
    views: bitNodes.map((_, index) => viewOf(bitNodes, index, events, firstMs)),
    firstMs,
    lastMs: Math.max(...times),
    releases: [...new Set(bitNodes.flatMap((bitNode) => [...bitNode.releases.keys()]))],
    brainStarts: events.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).length,
  };
}

function viewOf(
  bitNodes: readonly CampaignBitNode[],
  index: number,
  events: readonly StoredEvent[],
  firstMs: number,
): BitNodeView {
  const bitNode = bitNodes[index] as CampaignBitNode;
  const next = bitNodes[index + 1];
  const endMs = next?.startMs ?? Number.POSITIVE_INFINITY;
  // The first BitNode takes the events before its start too: the brain started before its first slow snapshot.
  const inIt = (event: StoredEvent) => (index === 0 || event.atMs >= bitNode.startMs) && event.atMs < endMs;
  const its = events.filter(inIt);
  const begunBefore = bitNode.startMs < firstMs;
  const startSeen = !begunBefore && bitNode.entry !== "save loaded";
  // The installs seen, and the one its first look showed already (those before it unseen: at least).
  const installs = bitNode.installs.length + (bitNode.installedBeforeFirstLook ? 1 : 0);
  const played = bitNodes.slice(0, index + 1).filter((each) => each.label === bitNode.label).length;
  const ending = endingOf(bitNode, next, its);
  return {
    bitNode,
    name: played === 1 ? bitNode.label : `${bitNode.label} #${played}`,
    begunBefore,
    startSeen,
    ending,
    // To the next BitNode's start, or its last look where BitNodes the store didn't see came between.
    wallMs: (unseenAfter(next) ? bitNode.lastSlowAtMs : (next?.startMs ?? bitNode.lastSlowAtMs)) - bitNode.startMs,
    // Its first cycle, from `lastNodeReset`, and one more for each install.
    cycles: installs + 1,
    installs,
    byHand: bitNode.installs.filter((install) => install.byHand).length,
    gapsMs: startSeen && bitNode.startLeftOutMs > 0 ? [bitNode.startLeftOutMs, ...bitNode.gapsMs] : bitNode.gapsMs,
    brainStarts: its.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).length,
    startNote: begunBefore ? "before the store" : bitNode.entry === "save loaded" ? "a save loaded" : null,
    soFar: ending.destroyedAtMs === null,
    wallAtLeast: bitNode.entry === "save loaded",
    onlineAtLeast: !startSeen,
    countsAtLeast: bitNode.installedBeforeFirstLook,
  };
}

const unseenAfter = (next: CampaignBitNode | undefined) =>
  next?.entry === "reset" && (next.change === "unseen" || next.change === "gained, unseen");

/**
 * How a BitNode ended, from the next one's start:
 * - before its last look: a save loaded (`CampaignFold.add`);
 * - its Source-File gained a level: destroyed (`RedPill.tsx:62-63`, `giveSourceFile`); more than one, or another
 *   Source-File rose too: destroyed, with BitNodes the store didn't see between; another rose alone: those BitNodes;
 * - at its Source-File's cap (`RedPill.tsx:28`, no level to gain), or with its Source-File overridden (its level
 *   doesn't say), the brain's `bitNodeDestroySent` after its last look: destroyed; overridden with none: unknown;
 * - a Source-File lost, or none to lose (b1t_flum3 needs one: `Programs.ts:29-33`, `BitNodeUtils.ts:21-25`): a new
 *   game (a new player's `lastNodeReset` is the time it began, `PlayerObject.ts:168`);
 * - otherwise b1t_flum3, which enters a BitNode with no Source-File (`RedPill.tsx:62`, its `isFlume`;
 *   `Programs.ts:306-322`, `Singularity.ts:1148`), or, at the cap, a destroy the brain didn't send.
 * The destroy sent counts only as the last in the BitNode, and no more than `RELOAD_LEAD_MS` before its last look: one
 * with slow snapshots of the BitNode after it didn't happen then.
 */
function endingOf(bitNode: CampaignBitNode, next: CampaignBitNode | undefined, its: readonly StoredEvent[]): Ending {
  const last = its.findLast((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND);
  const sent = last !== undefined && last.atMs >= bitNode.lastSlowAtMs - RELOAD_LEAD_MS ? last : undefined;
  const ended = (text: string, atMs: number | null, destroyedAtMs: number | null = null) => ({
    text,
    atMs,
    ended: true,
    destroyedAtMs,
    unseenAfter: false,
  });
  if (next === undefined) {
    const goesOn =
      sent === undefined ? ended("not yet", null) : ended("destroy sent {at}, the next BitNode not seen", sent.atMs);
    return { ...goesOn, ended: false };
  }
  const at = next.startMs;
  if (next.entry === "save loaded") return ended("a save loaded {at}", next.firstSlowAtMs);
  switch (next.change) {
    case "lost":
      return ended("a new game {at}", at);
    case "gained":
      return ended("destroyed {at}", at, at);
    case "gained, unseen":
      return {
        text: "destroyed, BitNodes unseen before {at}",
        atMs: at,
        ended: true,
        destroyedAtMs: null,
        unseenAfter: true,
      };
    case "unseen":
      return ended("BitNodes unseen before {at}", at);
    case "overridden":
      return sent === undefined
        ? ended("unknown {at} (its Source-File overridden, no destroy sent)", at)
        : ended("destroyed {at} (its Source-File overridden; the destroy sent)", at, at);
  }
  const levelBefore = bitNode.lastOwnedSF[String(bitNode.currentNode)] ?? 0;
  const atCap = levelBefore >= SOURCE_FILE_CAP && bitNode.currentNode !== UNCAPPED_BITNODE;
  if (atCap && sent !== undefined) return ended("destroyed {at} (at the cap)", at, at);
  const noSourceFile =
    Object.keys(bitNode.lastOverrides).length === 0 && !Object.values(bitNode.lastOwnedSF).some((level) => level > 0);
  if (noSourceFile) return ended("a new game {at}", at);
  return ended(atCap ? "b1t_flum3, or a destroy not sent by the brain at the cap, {at}" : "b1t_flum3 {at}", at);
}
