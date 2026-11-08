// The campaign report (#290, architecture §7): clear time, cycles and installs per BitNode, per release, over the whole
// store, every run and restart in it: the benchmark in place of community numbers. Read-only, and from the slow
// snapshots' `resetInfo` and a few kinds of event alone: it never reads a medium or fast snapshot, so a store thinned
// (#283) gives the same report. The campaign itself (where each BitNode and cycle starts, how each ended, the time
// online) is `campaign-model.ts`'s, which the dashboard's timeline shows too (#285).
import { describeAugmentations, isFiniteNumber } from "./augmentation-report.ts";
import { AUGMENTATION_SLOW_GAP_MS } from "./augmentations.ts";
import {
  type BitNodeView,
  CAMPAIGN_EVENT_KINDS,
  type CampaignBitNode,
  CampaignFold,
  campaignViews,
  describeEnding,
  installsOfLevel,
  type ReleaseShare,
  sum,
} from "./campaign-model.ts";
import { formatDuration, formatIsoTime, plural } from "./gap-report.ts";
import type { Environment, TelemetryStore } from "./telemetry-store.ts";

/**
 * Another release's time at a BitNode's start that still leaves the release that went on a clear of its own (proposed
 * owner decision 61, #290): within the BitNode's first cycle, with no install, before the other's first slow snapshot,
 * and at most this long online. A brain upgraded just after a destroy, as run #3's BN1.3 was (2 min 3 s).
 */
export const STARTER_ALLOWANCE_MS = 5 * 60_000;
const atLeast = (shown: string, isLowerBound: boolean) => (isLowerBound ? `≥ ${shown}` : shown);

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
    // Each slow snapshot's `resetInfo` alone, taken out in the query (one a minute online, about 525,000 a year).
    for (const snapshot of store.iterateSlowResetInfo({ environment })) fold.add(snapshot);
    return store.eventsInWindow({
      environment,
      sinceMs: 0,
      untilMs: Number.MAX_SAFE_INTEGER,
      kinds: CAMPAIGN_EVENT_KINDS,
    });
  });
  const campaign = campaignViews(fold, events);
  if (campaign === null) {
    throw new Error(
      `no BitNode in the store (${environment}): ${plural(fold.slowCount, "slow snapshot", "slow snapshots")}, ` +
        "none with a resetInfo to read",
    );
  }
  const { views, firstMs, lastMs, releases, brainStarts } = campaign;
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
    const sofar = view.soFar ? " so far" : "";
    return [
      view.name,
      `${formatIsoTime(bitNode.startMs)}${view.startNote === null ? "" : ` (${view.startNote})`}`,
      describeEnding(view.ending, formatIsoTime),
      atLeast(`${formatDuration(view.wallMs)}${sofar}`, view.wallAtLeast),
      atLeast(`${formatDuration(bitNode.clock.onlineMs)}${sofar}`, view.onlineAtLeast),
      describeLeftOut(view.gapsMs),
      atLeast(String(view.cycles), view.countsAtLeast),
      atLeast(describeInstalls(view.installs, view.byHand), view.countsAtLeast),
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
      Array.from({ length: installsOfLevel(level) }, () => name),
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
