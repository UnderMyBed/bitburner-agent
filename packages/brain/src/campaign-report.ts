// The campaign report (#290, architecture §7): clear time, cycles and installs per BitNode, per release, over the whole
// store, every run and restart in it: the benchmark in place of community numbers. Read-only, and from the slow
// snapshots and a few kinds of event alone, so a store thinned as #283 plans (events and slow snapshots kept, the
// medium ones thinned, the fast ones dropped) gives the same report. Where each BitNode and cycle starts is the run
// report's own detection (`ResetDetection`, #244); the time online is the bars' clock's rule (`advanceOnlineClock`,
// #222), run over a whole BitNode.
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
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import type { Environment, StoredEvent, TelemetryStore } from "./telemetry-store.ts";
import { BITNODE_DESTROY_SENT_EVENT_KIND } from "./world-daemon.ts";

/** The events the campaign report reads: the brain's starts, the installs sent (yours among them), the destroys. */
export const CAMPAIGN_EVENT_KINDS = [
  BRAIN_STARTED_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  BITNODE_DESTROY_SENT_EVENT_KIND,
];

/**
 * A stored release as the campaign compares it: the brain's (`git describe` of its checkout, `brainRelease`), the part
 * before the first "+". The Agent's deployment after it changes with any rebuild: it would split one release in many.
 */
export function brainReleaseOf(stored: string): string {
  return stored.split("+")[0] || stored;
}

/** What a release did in one BitNode. */
interface ReleaseShare {
  onlineMs: number;
  /** The cycles (`lastAugReset`) it had a slow snapshot in. */
  cycles: Set<number>;
  /** The installs it made: a new cycle first seen after its slow snapshot, in the same BitNode. */
  installs: number;
}

/** A BitNode as the campaign keeps it. */
interface CampaignBitNode extends BitNodeSpan {
  /** Its time online (`advanceOnlineClock` over the BitNode, keyed by its `lastNodeReset`), start and destroy in. */
  clock: OnlineClock;
  /** By release, in the order each first played it. */
  releases: Map<string, ReleaseShare>;
  /** The release of its newest slow snapshot. */
  lastRelease: string;
  /** Every `lastAugReset` its slow snapshots showed: one a cycle; each but its `lastNodeReset` an install. */
  augResets: Set<number>;
  /** Where a `lastAugReset` earlier than the cycle's before it was seen: an older save loaded. */
  olderSavesAtMs: number[];
  /** Its newest slow snapshot's `ownedAugs`: what's installed in it, NeuroFlux Governor's levels as their count. */
  ownedAugs: Record<string, number> | null;
}

/** The fold over the store's slow snapshots, in order. */
class CampaignFold {
  readonly #resets = new ResetDetection<CampaignBitNode>({
    newBitNode: (span) => ({
      ...span,
      clock: advanceOnlineClock(null, span.lastNodeReset, span.lastNodeReset).clock,
      releases: new Map(),
      lastRelease: "",
      augResets: new Set(),
      olderSavesAtMs: [],
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
    if (before !== undefined && before !== bitNode) {
      // The destroy: the time from its last slow snapshot to the next BitNode's start is online, within the gap. An
      // older BitNode's save starts before it: a step back, which the clock leaves out.
      this.#step(before, bitNode.lastNodeReset, before.lastRelease);
    }
    const share = this.#shareOf(bitNode, release);
    if (cycle !== lastCycle && lastCycle?.bitNode === this.bitNodes.length - 1) {
      // Another cycle in the same BitNode: an install by the release before it, or a save from before the last one.
      if (cycle.lastAugReset < lastCycle.lastAugReset) bitNode.olderSavesAtMs.push(atMs);
      else if (cycle.lastAugReset !== bitNode.lastNodeReset) this.#shareOf(bitNode, bitNode.lastRelease).installs += 1;
    }
    this.#step(bitNode, gameTimeMs, release);
    share.cycles.add(cycle.lastAugReset);
    bitNode.augResets.add(cycle.lastAugReset);
    bitNode.lastRelease = release;
    const ownedAugs = data.resetInfo?.ownedAugs;
    bitNode.ownedAugs = typeof ownedAugs === "object" && ownedAugs !== null ? ownedAugs : null;
  }

  /** Moves a BitNode's clock to the game's `gameTimeMs`, the time online it adds the release's. */
  #step(bitNode: CampaignBitNode, gameTimeMs: number, release: string): void {
    const before = bitNode.clock.onlineMs;
    bitNode.clock = advanceOnlineClock(bitNode.clock, gameTimeMs, bitNode.lastNodeReset).clock;
    this.#shareOf(bitNode, release).onlineMs += bitNode.clock.onlineMs - before;
  }

  #shareOf(bitNode: CampaignBitNode, release: string): ReleaseShare {
    let share = bitNode.releases.get(release);
    if (share === undefined) {
      share = { onlineMs: 0, cycles: new Set(), installs: 0 };
      bitNode.releases.set(release, share);
    }
    return share;
  }
}

/** How a BitNode ended, and when (the brain's clock), if it did. */
interface Ending {
  text: string;
  /** Destroyed: the next BitNode's start. */
  destroyedAtMs: number | null;
}

/** What the report says of one BitNode, worked out once. */
interface BitNodeView {
  bitNode: CampaignBitNode;
  /** Its label, and " #2" on for a label played again (BN1.4 after SF1.3, or an older save). */
  name: string;
  /** Its start is before the store's first record: its time online is at least the one shown. */
  begunBefore: boolean;
  ending: Ending;
  wallMs: number;
  cycles: number;
  installs: number;
  /** Installs sent from your queue (`augmentationInstallSent`, source "manual"). */
  yours: number;
  brainStarts: number;
}

const atLeast = (shown: string, isLowerBound: boolean) => (isLowerBound ? `≥ ${shown}` : shown);

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
      `no BitNode in the store (${environment}): ${fold.slowCount} slow snapshots, none with a resetInfo to read`,
    );
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
    `  read: ${fold.slowCount} slow snapshots and the events of the brain's starts (${brainStarts}), installs and ` +
      "destroys, nothing else (so a store thinned of its fast and medium snapshots, #283, gives the same report)" +
      (fold.unread > 0 ? `; ${fold.unread} slow snapshots with no resetInfo to read, left out` : ""),
    `  time online: the game's time between slow snapshots no more than ${formatDuration(AUGMENTATION_SLOW_GAP_MS)} ` +
      "apart, from a BitNode's start to its destroy: an offline gap, or the brain or the Agent away, is left out; the " +
      "wall clock counts it",
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
  const installs = [...bitNode.augResets].filter((reset) => reset !== bitNode.lastNodeReset).length;
  const played = bitNodes.slice(0, index + 1).filter((each) => each.label === bitNode.label).length;
  return {
    bitNode,
    name: played === 1 ? bitNode.label : `${bitNode.label} #${played}`,
    begunBefore,
    ending: endingOf(bitNode, next, its),
    wallMs: (next?.startMs ?? bitNode.lastSlowAtMs) - bitNode.startMs,
    // An install before its first look: its first cycle, from `lastNodeReset`, wasn't seen.
    cycles: installs + 1,
    installs,
    yours: its.filter(
      (event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND && fieldsOf(event.detail).source === "manual",
    ).length,
    brainStarts: its.filter((event) => event.kind === BRAIN_STARTED_EVENT_KIND).length,
  };
}

function endingOf(bitNode: CampaignBitNode, next: CampaignBitNode | undefined, its: readonly StoredEvent[]): Ending {
  if (next !== undefined && next.lastNodeReset > bitNode.lastNodeReset) {
    return { text: `destroyed ${formatIsoTime(next.startMs)}`, destroyedAtMs: next.startMs };
  }
  if (next !== undefined)
    return { text: `an older save loaded ${formatIsoTime(next.firstSlowAtMs)}`, destroyedAtMs: null };
  const sent = its.findLast((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND);
  return {
    text: sent === undefined ? "not yet" : `destroy sent ${formatIsoTime(sent.atMs)}, the next BitNode not seen`,
    destroyedAtMs: null,
  };
}

/** The BitNodes, a row each, then each one's releases and augmentations. */
function bitNodeSection(views: readonly BitNodeView[]): string[] {
  const lines = [
    "BitNodes, one row each (≥, at least: the time online of one begun before the store's first record, and the cycles " +
      "and installs of one whose first slow snapshot showed an install already):",
  ];
  const header = [
    "BitNode",
    "started",
    "ended",
    "wall clock",
    "online",
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
    const yours = view.yours > 0 ? ` (${view.yours} from your queue)` : "";
    return [
      view.name,
      `${formatIsoTime(bitNode.startMs)}${view.begunBefore ? " (before the store)" : ""}`,
      view.ending.text,
      `${formatDuration(view.wallMs)}${sofar}`,
      atLeast(`${formatDuration(bitNode.clock.onlineMs)}${sofar}`, view.begunBefore),
      atLeast(String(view.cycles), unseenInstalls),
      atLeast(`${view.installs}${yours}`, unseenInstalls),
      bitNode.ownedAugs === null ? "not recorded" : String(Object.keys(bitNode.ownedAugs).length),
      String(view.brainStarts),
      [...bitNode.releases.keys()].join(", "),
    ];
  });
  lines.push(...table([header, ...rows]), "", "Each BitNode:");
  for (const view of views) {
    const { bitNode } = view;
    lines.push(`  ${view.name}:`);
    const shares = [...bitNode.releases].map(([release, share]) => `${release} ${formatDuration(share.onlineMs)}`);
    lines.push(`    time online by release: ${shares.join(", ")}`);
    const installed = Object.entries(bitNode.ownedAugs ?? {}).flatMap(([name, level]) =>
      Array.from({ length: isFiniteNumber(level) && level > 1 ? level : 1 }, () => name),
    );
    lines.push(
      `    installed at its last look: ${bitNode.ownedAugs === null ? "not recorded" : describeAugmentations(installed)}`,
    );
    for (const atMs of bitNode.olderSavesAtMs) {
      lines.push(
        `    an older save loaded ${formatIsoTime(atMs)}: a lastAugReset earlier than the cycle's before it ` +
          "(its cycles count each lastAugReset once)",
      );
    }
  }
  return lines;
}

/**
 * Whether a release cleared a BitNode on its own: it alone played it, the store seeing it from its start (and its first
 * cycle) to its destroy.
 */
const clearedAlone = (view: BitNodeView) =>
  view.ending.destroyedAtMs !== null &&
  !view.begunBefore &&
  !view.bitNode.installedBeforeFirstLook &&
  view.bitNode.releases.size === 1;

/** A row per release and BitNode it played, the releases in the order first seen. */
function releaseSection(views: readonly BitNodeView[], releases: readonly string[]): string[] {
  const lines = [
    "By release, one row per release and BitNode it played (a clear of its own where it alone played the BitNode, " +
      "from its start to its destroy):",
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
        String(share.installs),
        destroyedBy(view, release),
      ]);
    }
  }
  lines.push(...table([header, ...rows]));
  return lines;
}

function destroyedBy(view: BitNodeView, release: string): string {
  if (view.ending.destroyedAtMs === null || view.bitNode.lastRelease !== release) return "no";
  const clear = `${formatDuration(view.bitNode.clock.onlineMs)} online, ${formatDuration(view.wallMs)} by the clock`;
  if (clearedAlone(view)) return `yes, a clear of its own: ${clear}`;
  if (view.begunBefore || view.bitNode.installedBeforeFirstLook)
    return "yes, the BitNode's start not seen in the store";
  const others = [...view.bitNode.releases.keys()].filter((each) => each !== release);
  return `yes, played with ${others.join(", ")} too`;
}

/** Each BitNode (number and level) two releases or more cleared on their own: their clears, fastest online first. */
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
        `(${formatDuration(view.wallMs)} by the clock, ${view.cycles} cycles)`,
    );
    lines.push(`  ${label}: ${each.join("; ")}`);
  }
  if (lines.length === 1) lines.push("  none yet: no BitNode cleared on their own by two releases");
  return lines;
}
