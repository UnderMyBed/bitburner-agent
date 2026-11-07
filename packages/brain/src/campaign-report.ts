// The campaign report (#290, architecture §7): clear time, cycles and installs per BitNode, per release, over the whole
// store, every run and restart in it: the benchmark in place of community numbers. Read-only, and from the slow
// snapshots and a few kinds of event alone: it never reads a medium or fast snapshot, so a store thinned (#283) gives
// the same report. Where each BitNode and cycle starts is the run report's own detection (`ResetDetection`, #244); the
// time online is the bars' clock's rule (`advanceOnlineClock`, #222), run over a whole BitNode.
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { describeAugmentations, fieldsOf, isFiniteNumber } from "./augmentation-report.ts";
import {
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_SLOW_GAP_MS,
  advanceOnlineClock,
  type OnlineClock,
} from "./augmentations.ts";
import { type BitNodeSpan, ResetDetection } from "./cycle-report.ts";
import { BRAIN_STARTED_EVENT_KIND } from "./dashboard/status.ts";
import { formatDuration, formatIsoTime, plural } from "./gap-report.ts";
import { RELOAD_LEAD_MS } from "./run-report.ts";
import type { Environment, StoredEvent, TelemetryStore } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";

/** The events the campaign report reads: the brain's starts, the installs sent (yours among them), the destroys. */
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
 * Another release's time at a BitNode's start that still leaves the release that went on a clear of its own (proposed
 * owner decision 61, #290): within the BitNode's first cycle, with no install, before the other's first slow snapshot,
 * and at most this long online. A brain upgraded just after a destroy, as run #3's BN1.3 was (2 min 3 s).
 */
export const STARTER_ALLOWANCE_MS = 5 * 60_000;

/**
 * A stored release as the campaign compares it: the brain's (`git describe` of its checkout, `brainRelease`), the part
 * before the first "+". The Agent's deployment after it changes with any rebuild: it would split one release in many.
 */
export function brainReleaseOf(stored: string): string {
  return stored.split("+")[0] || stored;
}

/** An install the slow snapshots saw: another `lastAugReset`, later than the last look, in the same BitNode. */
interface Install {
  /** The cycle it ended started here (the brain's clock), and the new one was first seen here. */
  fromMs: number;
  atMs: number;
  /** Not sent by the brain's own rule: no `augmentationInstallSent` from "brain" in the cycle it ended. */
  byHand: boolean;
}

/** What a release did in one BitNode. */
interface ReleaseShare {
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

/** A BitNode as the campaign keeps it. */
interface CampaignBitNode extends BitNodeSpan {
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

const sourceFilesOf = (data: SlowSnapshotData) => fieldsOf(data.resetInfo?.ownedSF) as Record<string, number>;
/** The BitNode's Source-File overrides: `ownedSF` shows an overridden one at its override (`activeSourceFiles`). */
const overridesOf = (data: SlowSnapshotData) =>
  fieldsOf(fieldsOf(data.resetInfo?.bitNodeOptions).sourceFileOverrides) as Record<string, number>;

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

/** The fold over the store's slow snapshots, in order. */
class CampaignFold {
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

  add(atMs: number, gameTimeMs: number, storedRelease: string, data: SlowSnapshotData): void {
    this.slowCount += 1;
    const release = brainReleaseOf(storedRelease);
    const before = this.bitNodes.at(-1);
    const lastCycle = this.#resets.cycles.at(-1);
    const seen = this.#resets.add(atMs, gameTimeMs, data);
    if (seen === null) {
      this.unread += 1;
      return;
    }
    const { bitNode, cycle } = seen;
    const isNew = bitNode !== before;
    if (isNew) {
      bitNode.firstOwnedSF = sourceFilesOf(data);
      bitNode.firstOverrides = overridesOf(data);
      bitNode.cycles.add(cycle.lastAugReset);
      if (before !== undefined) {
        // A start before the last look is a save's, loaded (an older BitNode, or a newer one gone back to); a start
        // after it, the game's: a destroy, b1t_flum3 or a new game (`endingOf` tells which), its edge online if near,
        // unless BitNodes the store didn't see came between.
        bitNode.entry = bitNode.lastNodeReset < before.lastGameTimeMs ? "save loaded" : "reset";
        if (bitNode.entry === "reset") {
          bitNode.change = sourceFileChange(before, bitNode);
          const unseen = bitNode.change === "unseen" || bitNode.change === "gained, unseen";
          if (!unseen) this.#step(before, bitNode.lastNodeReset, before.lastRelease);
        }
      }
    } else if (cycle !== lastCycle) {
      // Another cycle in the same BitNode: an install, its `lastAugReset` new and after the last look (the game's time
      // at the install, `PlayerObjectGeneralMethods.ts:126`), or a save loaded, older or newer. One edge: the PC's
      // clock set back before an install makes its `lastAugReset` earlier than the last look: read as a save loaded.
      if (bitNode.augResets.has(cycle.lastAugReset) || cycle.lastAugReset < bitNode.lastGameTimeMs) {
        bitNode.savesLoadedAtMs.push(atMs);
      } else {
        const install = { fromMs: lastCycle?.startMs ?? bitNode.startMs, atMs, byHand: false };
        bitNode.installs.push(install);
        bitNode.cycles.add(cycle.lastAugReset);
        this.#shareOf(bitNode, bitNode.lastRelease).installs.push(install);
      }
    }
    // The step to this slow snapshot is its release's, a step across a change of release the new one's.
    const leftOutMs = this.#step(bitNode, gameTimeMs, release);
    if (isNew) bitNode.startLeftOutMs = Math.max(0, leftOutMs);
    const share = this.#shareOf(bitNode, release);
    if (bitNode.cycles.has(cycle.lastAugReset)) share.cycles.add(cycle.lastAugReset);
    share.firstAtMs = Math.min(share.firstAtMs, atMs);
    share.lastAtMs = atMs;
    bitNode.augResets.add(cycle.lastAugReset);
    bitNode.lastRelease = release;
    bitNode.lastOwnedSF = sourceFilesOf(data);
    bitNode.lastOverrides = overridesOf(data);
    const ownedAugs = data.resetInfo?.ownedAugs;
    bitNode.ownedAugs = typeof ownedAugs === "object" && ownedAugs !== null ? ownedAugs : null;
  }

  /**
   * Moves a BitNode's clock to the game's `gameTimeMs`, the time online it adds the release's. Returns the time it left
   * out (a gap), or 0; a gap after the BitNode's start is kept.
   */
  #step(bitNode: CampaignBitNode, gameTimeMs: number, release: string): number {
    const before = bitNode.clock.onlineMs;
    const { clock, leftOutMs } = advanceOnlineClock(bitNode.clock, gameTimeMs, bitNode.lastNodeReset);
    bitNode.clock = clock;
    bitNode.lastGameTimeMs = gameTimeMs;
    this.#shareOf(bitNode, release).onlineMs += clock.onlineMs - before;
    const gapMs = leftOutMs !== null && leftOutMs > 0 ? leftOutMs : 0;
    // The first step is the start's: kept apart, as it counts only where the store saw the start.
    if (gapMs > 0 && bitNode.lastRelease !== "") bitNode.gapsMs.push(gapMs);
    return gapMs;
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

/** How a BitNode ended, and when (the brain's clock), if it was destroyed and the next BitNode was the one after. */
interface Ending {
  text: string;
  destroyedAtMs: number | null;
  /** Destroyed, with BitNodes the store didn't see before the next: its destroy's time unknown, never a clear. */
  unseenAfter: boolean;
}

/** What the report says of one BitNode, worked out once. */
interface BitNodeView {
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
}

const atLeast = (shown: string, isLowerBound: boolean) => (isLowerBound ? `≥ ${shown}` : shown);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** "2 h 0 min in 1 gap", or "none". */
function describeLeftOut(gapsMs: readonly number[]): string {
  return gapsMs.length === 0 ? "none" : `${formatDuration(sum(gapsMs))} in ${plural(gapsMs.length, "gap", "gaps")}`;
}

/** "SF1.2, SF4.1", the Source-Files a BitNode was entered with, or "no Source-File". */
function describeSourceFiles(ownedSF: Record<string, number>): string {
  const owned = Object.entries(ownedSF)
    .filter(([, level]) => isFiniteNumber(level) && level > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([node, level]) => `SF${node}.${level}`);
  return owned.length === 0 ? "no Source-File" : owned.join(", ");
}

/** "3", "3 (1 by hand)". */
const describeInstalls = (count: number, byHand: number) => `${count}${byHand > 0 ? ` (${byHand} by hand)` : ""}`;

/** Rows as a table: each column padded to its widest cell, indented. */
function table(rows: string[][], indent = "  "): string[] {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows.map(
    (row) =>
      indent +
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
  );
}

/**
 * The campaign report over a whole environment of the store (#290): a row per BitNode, then a row per release and
 * BitNode it played, then each BitNode two releases or more cleared on their own, side by side. Throws when the store
 * has no slow snapshot showing a BitNode: there's nothing to report.
 */
export function campaignReport(store: TelemetryStore, { environment }: { environment: Environment }): string {
  const fold = new CampaignFold();
  const events = store.readTransaction(() => {
    const everything = { environment, sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER };
    // Each slow snapshot's payload is parsed whole for its `resetInfo` (one a minute online, about 525,000 a year): a
    // `json_extract` of `resetInfo` in the query is the fix if that's ever slow.
    for (const snapshot of store.iterateSnapshotsInWindow({ ...everything, tier: "slow" })) {
      if (typeof snapshot.data !== "object" || snapshot.data === null) {
        fold.slowCount += 1;
        fold.unread += 1;
        continue;
      }
      fold.add(snapshot.receivedAtMs, snapshot.gameTimeMs, snapshot.release, snapshot.data as SlowSnapshotData);
    }
    return store.eventsInWindow({ ...everything, kinds: CAMPAIGN_EVENT_KINDS });
  });
  const { bitNodes } = fold;
  if (bitNodes.length === 0) {
    throw new Error(
      `no BitNode in the store (${environment}): ${plural(fold.slowCount, "slow snapshot", "slow snapshots")}, ` +
        "none with a resetInfo to read",
    );
  }
  // Each install by hand or not: the brain's has its `augmentationInstallSent` in the cycle it ended.
  const sentByBrain = events.filter(
    (event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND && fieldsOf(event.detail).source === "brain",
  );
  for (const install of bitNodes.flatMap((bitNode) => bitNode.installs)) {
    install.byHand = !sentByBrain.some((event) => event.atMs > install.fromMs && event.atMs <= install.atMs);
  }
  const times = [...bitNodes.flatMap((each) => [each.firstSlowAtMs, each.lastSlowAtMs]), ...events.map((e) => e.atMs)];
  const firstMs = Math.min(...times);
  const lastMs = Math.max(...times);
  const views = bitNodes.map((_, index) => viewOf(bitNodes, index, events, firstMs));
  const releases = [...new Set(bitNodes.flatMap((bitNode) => [...bitNode.releases.keys()]))];
  const brainStarts = events.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).length;
  const lines = [
    `Campaign report (${environment}): every BitNode and release in the store, from ${formatIsoTime(firstMs)} to ` +
      `${formatIsoTime(lastMs)} (${formatDuration(lastMs - firstMs)})`,
    `  read: ${plural(fold.slowCount, "slow snapshot", "slow snapshots")} and the events of the brain's starts ` +
      `(${brainStarts}), installs and destroys, never a medium or fast snapshot (so a store thinned, #283, gives the ` +
      "same report)" +
      (fold.unread > 0
        ? `; ${plural(fold.unread, "slow snapshot", "slow snapshots")} with no resetInfo to read, left out`
        : ""),
    `  time online: the game's time between slow snapshots no more than ${formatDuration(AUGMENTATION_SLOW_GAP_MS)} ` +
      "apart, from a BitNode's start to its destroy: an offline gap, or the brain or the Agent away, is left out (and " +
      "shown: the game goes on offline), and the wall clock counts it",
    "  a release is the brain's (git describe of its checkout; the Agent's deployment after the \"+\" left out): " +
      releases.join(", "),
    "",
    ...bitNodeSection(views),
    "",
    ...releaseSection(views, releases),
    "",
    ...comparedSection(views),
  ];
  return lines.join("\n");
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
  return {
    bitNode,
    name: played === 1 ? bitNode.label : `${bitNode.label} #${played}`,
    begunBefore,
    startSeen,
    ending: endingOf(bitNode, next, its),
    // To the next BitNode's start, or its last look where BitNodes the store didn't see came between.
    wallMs: (unseenAfter(next) ? bitNode.lastSlowAtMs : (next?.startMs ?? bitNode.lastSlowAtMs)) - bitNode.startMs,
    // Its first cycle, from `lastNodeReset`, and one more for each install.
    cycles: installs + 1,
    installs,
    byHand: bitNode.installs.filter((install) => install.byHand).length,
    gapsMs: startSeen && bitNode.startLeftOutMs > 0 ? [bitNode.startLeftOutMs, ...bitNode.gapsMs] : bitNode.gapsMs,
    brainStarts: its.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).length,
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
  const ended = (text: string, destroyedAtMs: number | null = null) => ({ text, destroyedAtMs, unseenAfter: false });
  if (next === undefined) {
    return ended(
      sent === undefined ? "not yet" : `destroy sent ${formatIsoTime(sent.atMs)}, the next BitNode not seen`,
    );
  }
  const at = formatIsoTime(next.startMs);
  if (next.entry === "save loaded") return ended(`a save loaded ${formatIsoTime(next.firstSlowAtMs)}`);
  switch (next.change) {
    case "lost":
      return ended(`a new game ${at}`);
    case "gained":
      return ended(`destroyed ${at}`, next.startMs);
    case "gained, unseen":
      return { text: `destroyed, BitNodes unseen before ${at}`, destroyedAtMs: null, unseenAfter: true };
    case "unseen":
      return ended(`BitNodes unseen before ${at}`);
    case "overridden":
      return sent === undefined
        ? ended(`unknown ${at} (its Source-File overridden, no destroy sent)`)
        : ended(`destroyed ${at} (its Source-File overridden; the destroy sent)`, next.startMs);
  }
  const levelBefore = bitNode.lastOwnedSF[String(bitNode.currentNode)] ?? 0;
  const atCap = levelBefore >= SOURCE_FILE_CAP && bitNode.currentNode !== UNCAPPED_BITNODE;
  if (atCap && sent !== undefined) return ended(`destroyed ${at} (at the cap)`, next.startMs);
  const noSourceFile =
    Object.keys(bitNode.lastOverrides).length === 0 && !Object.values(bitNode.lastOwnedSF).some((level) => level > 0);
  if (noSourceFile) return ended(`a new game ${at}`);
  return ended(atCap ? `b1t_flum3, or a destroy not sent by the brain at the cap, ${at}` : `b1t_flum3 ${at}`);
}

/** The BitNodes, a row each, then each one's releases, Source-Files and augmentations. */
function bitNodeSection(views: readonly BitNodeView[]): string[] {
  const lines = [
    "BitNodes, one row each (≥, at least: the wall clock and time online of one whose start the store didn't see, " +
      "begun before its first record or a save loaded, and the cycles and installs of one whose first slow snapshot " +
      "showed an install already; by hand: an install the brain's own rule didn't send, from your queue, the game's " +
      "Install button or a Soft Reset):",
  ];
  const header = [
    "BitNode",
    "started",
    "ended",
    "wall clock",
    "online",
    "left out",
    "cycles",
    "installs",
    "augmentations",
    "brain starts",
    "releases",
  ];
  const rows = views.map((view) => {
    const { bitNode } = view;
    const sofar = view.ending.destroyedAtMs === null ? " so far" : "";
    const unseenInstalls = bitNode.installedBeforeFirstLook;
    const how = view.begunBefore ? " (before the store)" : bitNode.entry === "save loaded" ? " (a save loaded)" : "";
    return [
      view.name,
      `${formatIsoTime(bitNode.startMs)}${how}`,
      view.ending.text,
      atLeast(`${formatDuration(view.wallMs)}${sofar}`, bitNode.entry === "save loaded"),
      atLeast(`${formatDuration(bitNode.clock.onlineMs)}${sofar}`, !view.startSeen),
      describeLeftOut(view.gapsMs),
      atLeast(String(view.cycles), unseenInstalls),
      atLeast(describeInstalls(view.installs, view.byHand), unseenInstalls),
      bitNode.ownedAugs === null ? "not recorded" : String(Object.keys(bitNode.ownedAugs).length),
      String(view.brainStarts),
      [...bitNode.releases.keys()].join(", "),
    ];
  });
  lines.push(...table([header, ...rows]), "", "Each BitNode:");
  for (const view of views) {
    const { bitNode } = view;
    const overrides = Object.entries(bitNode.firstOverrides).map(([node, level]) => `SF${node} at ${level}`);
    const overridden = overrides.length === 0 ? "" : ` (overridden: ${overrides.join(", ")})`;
    lines.push(`  ${view.name}: entered with ${describeSourceFiles(bitNode.firstOwnedSF)}${overridden}`);
    const shares = [...bitNode.releases].map(([release, share]) => `${release} ${formatDuration(share.onlineMs)}`);
    lines.push(`    time online by release: ${shares.join(", ")}`);
    const installed = Object.entries(bitNode.ownedAugs ?? {}).flatMap(([name, level]) =>
      Array.from({ length: isFiniteNumber(level) && level > 1 ? level : 1 }, () => name),
    );
    lines.push(
      `    installed at its last look: ${bitNode.ownedAugs === null ? "not recorded" : describeAugmentations(installed)}`,
    );
    for (const atMs of bitNode.savesLoadedAtMs) {
      lines.push(
        `    a save loaded ${formatIsoTime(atMs)}: a lastAugReset seen already, or before the last look ` +
          "(not an install; its cycles count each lastAugReset once)",
      );
    }
  }
  return lines;
}

/**
 * The other releases that played only at a BitNode's start (`STARTER_ALLOWANCE_MS`, proposed owner decision 61): no
 * install, at most that long online, all before the release that went on (its last) first played it. Null where another
 * release played more than that: no release cleared it on its own.
 */
function startersOf(bitNode: CampaignBitNode): [string, ReleaseShare][] | null {
  const clearer = bitNode.releases.get(bitNode.lastRelease);
  const others = [...bitNode.releases].filter(([release]) => release !== bitNode.lastRelease);
  const starter = (share: ReleaseShare) =>
    clearer !== undefined &&
    share.installs.length === 0 &&
    share.onlineMs <= STARTER_ALLOWANCE_MS &&
    share.lastAtMs < clearer.firstAtMs;
  return others.every(([, share]) => starter(share)) ? others : null;
}

/** "(v0.2.0-53-g7c741cc's first 2 min 3 s)", each release that played only at the start, or "". */
function describeStarters(bitNode: CampaignBitNode): string {
  const starters = startersOf(bitNode) ?? [];
  if (starters.length === 0) return "";
  return ` (${starters.map(([release, share]) => `${release}'s first ${formatDuration(share.onlineMs)}`).join(", ")})`;
}

/**
 * Whether a release cleared a BitNode on its own: it played it, the store seeing it from its start (and its first
 * cycle) to its destroy, with no save loaded in it and every install the brain's; another release only at its start
 * (`startersOf`).
 */
const clearedAlone = (view: BitNodeView) =>
  view.ending.destroyedAtMs !== null &&
  view.startSeen &&
  !view.bitNode.installedBeforeFirstLook &&
  view.byHand === 0 &&
  view.bitNode.savesLoadedAtMs.length === 0 &&
  startersOf(view.bitNode) !== null;

/** A row per release and BitNode it played, the releases in the order first seen. */
function releaseSection(views: readonly BitNodeView[], releases: readonly string[]): string[] {
  const lines = [
    "By release, one row per release and BitNode it played (a clear of its own where it played the BitNode from its " +
      "start to its destroy, no save loaded in it, every install the brain's, and another release at most its first " +
      `${formatDuration(STARTER_ALLOWANCE_MS)}, with no install):`,
  ];
  const header = ["release", "BitNode", "online", "cycles", "installs", "destroyed"];
  const rows: string[][] = [];
  for (const release of releases) {
    for (const view of views) {
      const share = view.bitNode.releases.get(release);
      if (share === undefined) continue;
      rows.push([
        release,
        view.name,
        formatDuration(share.onlineMs),
        String(share.cycles.size),
        describeInstalls(share.installs.length, share.installs.filter((install) => install.byHand).length),
        destroyedBy(view, release),
      ]);
    }
  }
  lines.push(...table([header, ...rows]));
  return lines;
}

function destroyedBy(view: BitNodeView, release: string): string {
  if (view.bitNode.lastRelease !== release) return "no";
  if (view.ending.unseenAfter) return "yes, BitNodes unseen after it";
  if (view.ending.destroyedAtMs === null) return "no";
  const clear = `${formatDuration(view.bitNode.clock.onlineMs)} online, ${formatDuration(view.wallMs)} by the clock`;
  if (clearedAlone(view)) return `yes, a clear of its own${describeStarters(view.bitNode)}: ${clear}`;
  if (view.bitNode.entry === "save loaded") return "yes, from a save loaded";
  if (view.begunBefore || view.bitNode.installedBeforeFirstLook)
    return "yes, the BitNode's start not seen in the store";
  if (view.byHand > 0) return `yes, with ${plural(view.byHand, "install", "installs")} by hand`;
  if (view.bitNode.savesLoadedAtMs.length > 0) return "yes, with a save loaded in it";
  const others = [...view.bitNode.releases.keys()].filter((each) => each !== release);
  return `yes, played with ${others.join(", ")} too`;
}

/**
 * Each BitNode (number and level) two releases or more cleared on their own: their clears, the fastest online first,
 * with the time left out (the game goes on offline, `engine.tsx:264-271`, so a release away more can look faster) and
 * the Source-Files each was entered with (the label's number and level only).
 */
function comparedSection(views: readonly BitNodeView[]): string[] {
  const lines = ["Compared: each BitNode two releases or more cleared on their own, the fastest online first:"];
  const byLabel = new Map<string, BitNodeView[]>();
  for (const view of views.filter(clearedAlone)) {
    byLabel.set(view.bitNode.label, [...(byLabel.get(view.bitNode.label) ?? []), view]);
  }
  for (const [label, clears] of byLabel) {
    if (new Set(clears.map((view) => view.bitNode.lastRelease)).size < 2) continue;
    const sorted = [...clears].sort((a, b) => a.bitNode.clock.onlineMs - b.bitNode.clock.onlineMs);
    const each = sorted.map(
      (view) =>
        `${view.bitNode.lastRelease} ${formatDuration(view.bitNode.clock.onlineMs)} online ` +
        `(${formatDuration(view.wallMs)} by the clock, ${plural(view.cycles, "cycle", "cycles")}, left out: ` +
        `${describeLeftOut(view.gapsMs)}; ${describeSourceFiles(view.bitNode.firstOwnedSF)})` +
        describeStarters(view.bitNode),
    );
    lines.push(`  ${label}: ${each.join("; ")}`);
  }
  if (lines.length === 1) lines.push("  none yet: no BitNode cleared on their own by two releases");
  return lines;
}
