// The time to the destroy (#360): the campaign fold's stretches, the prior, the hindcast (nothing after its moment
// read), the campaign report's section over the four BitNodes rebuilt from the store's tables (#360's findings, by
// cycle), the brain's rule at each moment (once across a restart, a missed install marked late), and the run report's
// check (a term never). Over synthetic stores built here, never the owner's .data/.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FactionWorkChoice, SlowSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type BitNodeView,
  CampaignFold,
  campaignViews,
  destroyPriorOf,
  destroyStretchesOf,
  LEVELLING_PROMPT_MS,
  sum,
} from "../src/campaign-model.ts";
import { campaignReport } from "../src/campaign-report.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import {
  DESTROY_ESTIMATE_SETTING,
  DESTROY_ESTIMATED_EVENT_KIND,
  type DestroyEstimateEvent,
  type DestroyEstimateRecord,
  DestroyEstimateRule,
  type DestroySeed,
  readDestroySeed,
} from "../src/destroy-estimate.ts";
import {
  DESTROY_ESTIMATE_REPORT_EVENT_KINDS,
  destroyEstimateHealthLines,
  destroyEstimateRows,
  destroyEstimateSection,
  type JudgedRow,
} from "../src/destroy-estimate-report.ts";
import type { LevellingView } from "../src/levelling.ts";
import { type SlowResetInfo, type StoredEvent, TelemetryStore } from "../src/telemetry-store.ts";
import { WorldDaemonFold } from "../src/world-daemon-report.ts";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const MINUTE = 60_000;
const m = (minutes: number) => T0 + minutes * MINUTE;
const RELEASE = "v1.0.0+aaaaaaaa";
const RED_PILL = "The Red Pill";
const NF = "NeuroFlux Governor";

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "destroy-estimate-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
/** `count` installed by Daedalus's count: NeuroFlux Governor (at `nfLevel`) once, the rest one each; The Red Pill too. */
function augs(count: number, { redPill = false, nfLevel = 5 } = {}): Record<string, number> {
  if (count === 0) return {};
  const owned: Record<string, number> = { [NF]: nfLevel };
  for (let index = 1; index < count - (redPill ? 1 : 0); index++) owned[`Augmentation ${index}`] = 1;
  if (redPill) owned[RED_PILL] = 1;
  return owned;
}
const resetInfo = (node: number, aug: number, currentNode: number, ownedSF: Record<string, number>, owned = {}) => ({
  lastNodeReset: m(node),
  lastAugReset: m(aug),
  currentNode,
  ownedSF,
  ownedAugs: owned,
  bitNodeOptions: {},
});
/** A slow snapshot at `minute` (the game's clock the brain's: one machine). */
function slow(minute: number, info: ReturnType<typeof resetInfo>, factions?: { name: string; favor: number }[]) {
  const data: SlowSnapshotData = { resetInfo: info, purchasedServers: [] } as unknown as SlowSnapshotData;
  if (factions !== undefined) {
    (data as unknown as Record<string, unknown>).factions = {
      backend: "sim",
      state: {
        joined: factions.map(({ name, favor }) => ({ name, reputation: 0, favor })),
        invitations: [],
        queuedAugmentations: [],
      },
      problem: null,
    };
  }
  store.recordSnapshot(
    { environment: "E0", release: RELEASE },
    {
      agentSessionId: "session-1",
      tier: "slow",
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: m(minute),
      receivedAtMs: m(minute),
      missedBefore: 0,
      data,
    },
  );
  return data;
}
function event(minute: number, kind: string, detail: unknown = {}) {
  store.recordEvent({ environment: "E0", release: RELEASE }, { atMs: m(minute), kind, detail });
}

/**
 * A BitNode played from minute `from` (its `lastNodeReset`, the last one's last look): each cycle `online[i]` minutes,
 * a slow snapshot a minute, its install at its last minute (the next cycle's first slow snapshot a minute on), at the
 * count `counts[i]`, The Red Pill installed from cycle `redPillCycle` on. Daedalus joined `joinedAt` minutes into
 * cycle `holdCycle` (A5's choice for The Red Pill then, its ETA `etaMinutes`). Returns its last minute.
 */
function bitNode({
  from,
  currentNode,
  ownedSF,
  online,
  counts,
  redPillCycle,
  hold,
  destroySent = true,
  total,
}: {
  from: number;
  currentNode: number;
  ownedSF: Record<string, number>;
  online: readonly number[];
  counts: readonly number[];
  redPillCycle?: number;
  hold?: { cycle: number; joinedAt: number; etaMinutes: number };
  destroySent?: boolean;
  /**
   * Its time online in all, the findings' (#343's tables): the cycles' minutes are rounded and leave each install's step
   * out, so the difference goes evenly to the installs, each a fraction of a minute after its cycle's last slow snapshot.
   */
  total?: number;
}): number {
  const gap = total === undefined || online.length < 2 ? 0 : (total - sum(online)) / (online.length - 1);
  let start = from;
  online.forEach((minutes, index) => {
    const info = resetInfo(
      from,
      start,
      currentNode,
      ownedSF,
      augs(counts[index] as number, {
        redPill: redPillCycle !== undefined && index >= redPillCycle,
      }),
    );
    for (let minute = start + 1; minute <= start + minutes; minute++) slow(minute, info);
    if (hold !== undefined && hold.cycle === index) {
      event(start + hold.joinedAt + 0.5, "factionWorkChosen", {
        faction: "Daedalus",
        augmentation: RED_PILL,
        workType: "hacking",
        etaSeconds: hold.etaMinutes * 60,
      });
    }
    if (index < online.length - 1) {
      event(start + minutes - 0.5, "augmentationInstallSent", { source: "brain" });
      start += minutes + gap;
    } else start += minutes;
  });
  if (destroySent) event(start - 0.5, "bitNodeDestroySent", { source: "brain", nextBitNode: 1 });
  return start;
}

/**
 * The four BitNodes, cycle by cycle, from install timing's tables (#343, #360's findings): each cycle's online
 * minutes and Daedalus's count at its start; the Red Pill stretch's joins (seen + 1 min) at the ETAs `factionWork
 * Chosen` gave then (157, 184, 35 and 165 min: the share left out). Then BN1 with SF4.1, a look, open.
 */
const BN1_2 = {
  online: [39, 56, 75, 95, 123, 124, 31, 27, 81, 18, 2],
  counts: [0, 3, 5, 10, 17, 21, 25, 29, 31, 32, 36],
};
const BN1_3 = {
  online: [37, 50, 70, 141, 18, 93, 138, 85, 92, 22, 4],
  counts: [0, 3, 5, 10, 14, 18, 23, 32, 37, 37, 41],
};
const BN1_4 = {
  online: [34, 38, 32, 17, 18, 19, 18, 19, 47, 37, 31, 17, 22, 39, 8, 2],
  counts: [0, 3, 14, 15, 15, 15, 16, 17, 17, 19, 22, 25, 27, 36, 37, 41],
};
const BN4_1 = {
  online: [140, 121, 128, 136, 219, 125, 154, 36, 125, 20, 419],
  counts: [0, 4, 5, 7, 11, 15, 23, 32, 36, 37, 41],
};
function fourBitNodes(): void {
  store.writeTransaction(fourBitNodesWritten);
}
function fourBitNodesWritten(): void {
  event(0, "brainStarted", { release: "v1.0.0" });
  let end = bitNode({
    from: 0,
    currentNode: 1,
    ownedSF: { 1: 1 },
    ...BN1_2,
    total: 677,
    redPillCycle: 10,
    hold: { cycle: 8, joinedAt: 16, etaMinutes: 157 },
  });
  end = bitNode({
    from: end,
    currentNode: 1,
    ownedSF: { 1: 2 },
    ...BN1_3,
    total: 756,
    redPillCycle: 10,
    hold: { cycle: 8, joinedAt: 17, etaMinutes: 184 },
  });
  end = bitNode({
    from: end,
    currentNode: 1,
    ownedSF: { 1: 3 },
    ...BN1_4,
    total: 406,
    redPillCycle: 15,
    hold: { cycle: 13, joinedAt: 7, etaMinutes: 35 },
  });
  end = bitNode({
    from: end,
    currentNode: 4,
    ownedSF: { 1: 3 },
    ...BN4_1,
    total: 1624,
    redPillCycle: 10,
    hold: { cycle: 8, joinedAt: 23, etaMinutes: 165 },
  });
  bitNode({ from: end, currentNode: 1, ownedSF: { 1: 3, 4: 1 }, online: [5], counts: [0], destroySent: false });
}

const readAll = () => ({
  slows: [...store.iterateSlowResetInfo({ environment: "E0" })],
  events: store.eventsInWindow({
    environment: "E0",
    sinceMs: 0,
    untilMs: Number.MAX_SAFE_INTEGER,
    kinds: DESTROY_ESTIMATE_REPORT_EVENT_KINDS,
  }),
});
const minutes = (ms: number | null) => (ms === null ? null : Math.round(ms / MINUTE));

describe("the campaign fold's stretches and the prior (#360)", () => {
  test("A, B + C, The Red Pill's cycle and D from the cycles; NeuroFlux Governor counted once", () => {
    fourBitNodes();
    const { slows, events } = readAll();
    const fold = new CampaignFold();
    for (const snapshot of slows) fold.add(snapshot);
    const views =
      campaignViews(
        fold,
        events.filter((each) => each.kind !== "factionWorkChosen"),
      )?.views ?? [];
    expect(views.map((view) => view.name)).toEqual(["BN1.2", "BN1.3", "BN1.4", "BN4.1", "BN1.4 #2"]);
    const stretches = views.map((view) => {
      const each = destroyStretchesOf(view);
      return [minutes(each.aMs), minutes(each.bcMs), minutes(each.redPillCycleMs), minutes(each.dMs)];
    });
    // NeuroFlux Governor at level 5 is one of the count: A ends where the count reaches 30, not at its levels. Each
    // install's step (the findings' totals less the cycles' rounded minutes, a share each) is in the cycle it ends.
    expect(stretches).toEqual([
      [575, 100, 19, 2],
      [551, 201, 23, 4],
      [356, 48, 9, 2],
      [1024, 181, 20, 419],
      [null, null, null, null],
    ]);
    // The prior: the same number first (BN1.3's is BN1.2), else the last destroyed (BN4.1's is BN1.4); levels apart.
    expect(destroyPriorOf(views, 0, [])).toBeNull();
    expect(destroyPriorOf(views, 1, [])).toMatchObject({ bitNode: "BN1.2", requiredLevel: 3000 });
    expect(destroyPriorOf(views, 3, [])).toMatchObject({ bitNode: "BN1.4", currentNode: 1, requiredLevel: 3000 });
    expect(destroyPriorOf(views, 4, [])).toMatchObject({ bitNode: "BN1.4", currentNode: 1 });
    // Its D from before levelling (#336): no levelling choice, or its first later than The Red Pill's install plus the
    // re-root, the settle and a slow gap (`LEVELLING_PROMPT_MS`, 7.4 min); within it, not. BN4.1 as the prior (its D
    // 419 min): a prompt choice just inside the bound, then BN4.1's shape, its first choice hours after.
    expect(LEVELLING_PROMPT_MS).toBe(3.4 * MINUTE + MINUTE + 3 * MINUTE);
    const bn41 = [views[3] as BitNodeView, views[4] as BitNodeView];
    const installedAt = destroyStretchesOf(bn41[0] as BitNodeView).redPillInstalledAtMs as number;
    expect(destroyPriorOf(bn41, 1, [])?.dBeforeLevelling).toBe(true);
    expect(destroyPriorOf(bn41, 1, [installedAt + LEVELLING_PROMPT_MS - 1000])?.dBeforeLevelling).toBe(false);
    expect(destroyPriorOf(bn41, 1, [installedAt + LEVELLING_PROMPT_MS + 1000])?.dBeforeLevelling).toBe(true);
    expect(destroyPriorOf(bn41, 1, [installedAt + 415 * MINUTE])?.dBeforeLevelling).toBe(true);
    // A choice in another BitNode doesn't count.
    expect(destroyPriorOf(bn41, 1, [installedAt - 600 * MINUTE])?.dBeforeLevelling).toBe(true);
  });

  test("a save loaded: its cycle left out of the count; an open BitNode's so far, D none", () => {
    event(0, "brainStarted", { release: "v1.0.0" });
    const ownedSF = { 1: 1 };
    for (let minute = 1; minute <= 30; minute++) slow(minute, resetInfo(0, 0, 1, ownedSF, augs(0)));
    for (let minute = 31; minute <= 60; minute++) slow(minute, resetInfo(0, 30, 1, ownedSF, augs(31)));
    // A save from the first cycle loaded at 61: its count goes back; then the install at 30 again, seen.
    for (let minute = 61; minute <= 70; minute++) slow(minute, resetInfo(0, 0, 1, ownedSF, augs(0)));
    for (let minute = 71; minute <= 80; minute++)
      slow(minute, resetInfo(0, 70, 1, ownedSF, augs(31, { redPill: true })));
    const { slows, events } = readAll();
    const fold = new CampaignFold();
    for (const snapshot of slows) fold.add(snapshot);
    const [view] = campaignViews(fold, events)?.views ?? [];
    expect(view?.bitNode.savesLoadedAtMs).toEqual([m(61)]);
    expect(view?.soFar).toBe(true);
    const stretches = destroyStretchesOf(view as NonNullable<typeof view>);
    expect([stretches.aMs, stretches.bcMs, stretches.dMs, stretches.soFarMs].map(minutes)).toEqual([30, 40, null, 80]);
  });

  test("a save from a cycle never seen, at the count, isn't where the count was met: the install after it is", () => {
    event(0, "brainStarted", { release: "v1.0.0" });
    const ownedSF = { 1: 1 };
    for (let minute = 1; minute <= 30; minute++) slow(minute, resetInfo(0, 0, 1, ownedSF, augs(0)));
    // A save from a cycle the store never saw (its install at 10, before the last look), at 31: a save, not an install.
    for (let minute = 31; minute <= 40; minute++) slow(minute, resetInfo(0, 10, 1, ownedSF, augs(31)));
    for (let minute = 42; minute <= 60; minute++) slow(minute, resetInfo(0, 41, 1, ownedSF, augs(31)));
    const { slows, events } = readAll();
    const fold = new CampaignFold();
    for (const snapshot of slows) fold.add(snapshot);
    const [view] = campaignViews(fold, events)?.views ?? [];
    expect(view?.bitNode.cycleList.map((cycle) => cycle.kind)).toEqual(["start", "save", "install"]);
    expect(minutes(destroyStretchesOf(view as NonNullable<typeof view>).aMs)).toBe(41);
  });
});

/** The section's rows over the store. */
function rowsOf(): JudgedRow[] {
  const { slows, events } = readAll();
  return destroyEstimateRows(slows, events).rows;
}
const summary = (row: JudgedRow) => [
  row.name,
  row.record.stage,
  minutes(row.record.onlineMs),
  minutes(row.record.remainingMs),
  row.ratio === null ? null : Number(row.ratio.toFixed(2)),
  row.record.atLeast,
];

describe("the hindcast and the campaign report's section (#360)", () => {
  test("every start, install and join of the four BitNodes, hindcast, against the outcome", () => {
    fourBitNodes();
    const rows = rowsOf();
    expect(rows.every((row) => row.hindcast)).toBe(true);
    // One a start, one an install, one a join; none in the last (open) BitNode's ratio.
    expect(rows.filter((row) => row.record.moment === "start").map((row) => row.name)).toEqual([
      "BN1.2",
      "BN1.3",
      "BN1.4",
      "BN4.1",
      "BN1.4 #2",
    ]);
    expect(rows.filter((row) => row.record.moment === "install")).toHaveLength(10 + 10 + 15 + 10);
    expect(rows.filter((row) => row.record.moment === "joined").map((row) => row.name)).toEqual([
      "BN1.2",
      "BN1.3",
      "BN1.4",
      "BN4.1",
    ]);
    const bn13 = rows.filter((row) => row.name === "BN1.3").map(summary);
    // BN1.3's cycles start a minute's fraction later each (its installs' steps, 0.6 min: 756 in all); each install is
    // estimated at its first slow snapshot, a minute on. Its start from BN1.2's 575 + 100 + 2, of 755.
    expect(bn13[0]).toEqual(["BN1.3", "start", 1, 677, 0.9, false]);
    // c3 at 89.2 online, by the mean (89.2 × 25/5 = 446) plus the prior's B + C and D: 548 of 667.
    expect(bn13[2]).toEqual(["BN1.3", "install", 89, 548, 0.82, false]);
    // The count met at c8 (551.2): B + C 100 less the minute since, and D 2: 101 of 203. Again at c9, not yet joined.
    expect(bn13[7]).toEqual(["BN1.3", "count met", 552, 101, 0.5, false]);
    expect(bn13[8]?.[1]).toBe("count met");
    // Joined 17 min into c9: the ETA then (184 min, the share left out) plus BN1.2's Red Pill cycle (18.6) and D, of 102.
    expect(bn13.find((row) => row[1] === "joined")).toEqual(["BN1.3", "joined", 654, 205, 2, false]);
    // The install after the join (the donations'): BN1.2's Red Pill cycle and D, of 25.6; then D alone, of 3.
    expect(bn13.find((row) => row[1] === "donations install")).toEqual([
      "BN1.3",
      "donations install",
      730,
      21,
      0.8,
      false,
    ]);
    expect(bn13.find((row) => row[1] === "The Red Pill installed")).toEqual([
      "BN1.3",
      "The Red Pill installed",
      753,
      2,
      0.67,
      false,
    ]);
    // BN4.1 from BN1.4: no D at 9,000 (BN1's 3,000), so at least; the next BitNode, open: no ratio.
    const bn41 = rows.filter((row) => row.name === "BN4.1").map(summary);
    expect(bn41[0]).toEqual(["BN4.1", "start", 1, 356 + 48, 0.25, true]);
    expect(rows.filter((row) => row.name === "BN1.4 #2").map((row) => row.ratio)).toEqual([null]);
  });

  test("the hindcast reads nothing after its moment: the store cut there, or changed after it, gives the same rows", () => {
    fourBitNodes();
    const whole = rowsOf();
    const { slows, events } = readAll();
    // Cut at BN1.4's c5 (the rows' estimates up to there, not their outcomes, which are the whole campaign's).
    const cutMs = whole.filter((row) => row.name === "BN1.4")[4]?.atMs as number;
    const upTo = (rows: readonly JudgedRow[]) =>
      rows.filter((row) => row.atMs <= cutMs).map(({ record, atMs }) => ({ record, atMs }));
    const cut = destroyEstimateRows(
      slows.filter((snapshot) => snapshot.receivedAtMs <= cutMs),
      events.filter((each) => each.atMs <= cutMs),
    ).rows;
    expect(upTo(cut)).toEqual(upTo(whole));
    // After it, everything changed: other counts, a join an hour sooner, no destroy sent: the same rows to there.
    const changed: SlowResetInfo[] = slows.map((snapshot) =>
      snapshot.receivedAtMs <= cutMs
        ? snapshot
        : { ...snapshot, resetInfo: { ...snapshot.resetInfo, ownedAugs: augs(40, { redPill: true }) } },
    );
    const otherEvents: StoredEvent[] = [
      ...events.filter((each) => each.atMs <= cutMs),
      { atMs: cutMs + 60 * MINUTE, kind: "factionWorkChosen", detail: { faction: "Daedalus", augmentation: RED_PILL } },
    ];
    expect(upTo(destroyEstimateRows(changed, otherEvents).rows)).toEqual(upTo(whole));
  });

  test("the brain's own estimates are its rows from the first on; the hindcast's only before it", () => {
    fourBitNodes();
    const live = rowsOf().find((row) => row.name === "BN4.1" && row.record.moment === "joined");
    const record = { ...(live?.record as DestroyEstimateRecord), remainingMs: 600 * MINUTE };
    // The brain's own join estimate, just before the hindcast's would be.
    event(((live?.atMs as number) - T0) / MINUTE - 0.1, DESTROY_ESTIMATED_EVENT_KIND, record);
    const rows = rowsOf();
    const bn41 = rows.filter((row) => row.name === "BN4.1");
    expect(bn41.filter((row) => !row.hindcast).map((row) => row.record.stage)).toEqual(["joined"]);
    // Nothing hindcast from the brain's first estimate on: its join, the donations and The Red Pill's installs.
    expect(
      bn41
        .filter((row) => row.hindcast)
        .map((row) => row.record.stage)
        .at(-1),
    ).toBe("count met");
    // Against BN4.1's time online at its destroy, less its time online at the join.
    const own = bn41.find((row) => !row.hindcast) as JudgedRow;
    expect(own.ratio).toBeCloseTo((600 * MINUTE) / ((own.actualTotalMs as number) - own.record.onlineMs), 9);
    expect(minutes(own.actualTotalMs)).toBe(1624);
  });

  test("a stored first look (a brain with no note) is listed and left out of the summaries, as the hindcast has it", () => {
    fourBitNodes();
    const bn14 = rowsOf().find((row) => row.name === "BN1.4" && row.record.stage === "install") as JudgedRow;
    // Stored after the hindcast's last moment (BN1.4 #2's start), so none of the hindcast's rows is cut.
    const { slows } = readAll();
    const afterAll = ((slows.at(-1) as SlowResetInfo).receivedAtMs - T0) / MINUTE + 0.5;
    event(afterAll, DESTROY_ESTIMATED_EVENT_KIND, { ...bn14.record, moment: "first seen", stage: "first seen" });
    const rows = rowsOf();
    const firstSeen = rows.filter((row) => row.record.stage === "first seen");
    expect(firstSeen).toHaveLength(1);
    expect(firstSeen[0]?.ratio).toBeCloseTo(bn14.ratio as number, 9);
    const section = destroyEstimateSection(rows, 0, (ms) => String(ms));
    expect(section).toContainEqual(expect.stringMatching(/^ {4}BN1.4: .*; left out: .*1 first seen$/));
    expect(section.filter((line) => line.startsWith("    first seen:"))).toEqual([]);
  });

  test("a prior's D is pre-#336 when its first levelling choice came late after The Red Pill's install, or not at all", () => {
    fourBitNodes();
    const fold = new CampaignFold();
    const { slows, events } = readAll();
    for (const snapshot of slows) fold.add(snapshot);
    const views =
      campaignViews(
        fold,
        events.filter((each) => each.kind !== "factionWorkChosen"),
      )?.views ?? [];
    const seenAt = (name: string) =>
      destroyStretchesOf(views.find((view) => view.name === name) as BitNodeView).redPillSeenAtMs as number;
    const minuteOf = (atMs: number) => (atMs - T0) / MINUTE;
    // BN4.1 chose levelling 409 min after its Red Pill's first slow snapshot (as #336's brain did, after a restart).
    event(minuteOf(seenAt("BN4.1")) + 409, "levellingChosen", { mode: "level" });
    const last = slows.at(-1) as SlowResetInfo;
    const bn5 = {
      receivedAtMs: last.receivedAtMs + MINUTE,
      gameTimeMs: last.gameTimeMs + MINUTE,
      resetInfo: resetInfo(minuteOf(last.receivedAtMs), minuteOf(last.receivedAtMs), 5, { 1: 3, 4: 1 }),
    };
    expect(readDestroySeed(store, "E0", bn5).prior).toMatchObject({ bitNode: "BN4.1", dBeforeLevelling: true });
    // Within a slow gap of it: not. And the hindcast reads them too: BN1.4 #2's prior, BN1.4, chose a minute after.
    event(minuteOf(seenAt("BN4.1")) + 2, "levellingChosen", { mode: "level" });
    expect(readDestroySeed(store, "E0", bn5).prior).toMatchObject({ bitNode: "BN4.1", dBeforeLevelling: false });
    const startOf = () => rowsOf().find((row) => row.name === "BN1.4 #2")?.record.terms[2];
    expect(startOf()).toMatchObject({ label: "cautious" });
    event(minuteOf(seenAt("BN1.4")) + 1, "levellingChosen", { mode: "level" });
    expect(startOf()).toMatchObject({ label: "either way", source: "the prior's (BN1.4)" });
  });

  test("the campaign report prints the section: a row each, each BitNode's median and worst, the ratios by moment", () => {
    fourBitNodes();
    const text = campaignReport(store, { environment: "E0" });
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.startsWith("Time to the destroy (#360)"));
    expect(start).toBeGreaterThan(0);
    const section = lines.slice(start);
    expect(section[1]).toMatch(/^ {2}BitNode +at +moment +online +est\. remaining +est\. total +actual remaining/);
    expect(section).toContainEqual(expect.stringMatching(/^ {2}BN4\.1 +\S+ +start \(hindcast\) +1 min +≥ 6 h 44 min /));
    // BN1.3's Red Pill row: 2 min against 3, flagged.
    expect(section).toContainEqual(
      expect.stringMatching(/^ {2}BN1\.3 .* The Red Pill installed \(hindcast\) .* 0\.67 \(under 10 min left\) /),
    );
    // The summaries: the measured rows. BN1.2's have no prior (BN1.1 isn't in the store), BN4.1's no D at 9,000 (BN1.4's
    // is at 3,000): bounds. Under 10 min left (BN1.3's Red Pill row, BN1.4's donations and Red Pill rows): ±1 min steps.
    expect(section.slice(section.indexOf("  each BitNode:"))).toEqual([
      "  each BitNode:",
      "    BN1.2: no ratio; left out: 12 at least",
      "    BN1.3: 11 ratio(s), median 0.72, worst 0.17, 0.17-2.00; left out: 1 under 10 min left",
      "    BN1.4: 15 ratio(s), median 1.52, worst 4.15, 0.87-4.15; left out: 2 under 10 min left",
      "    BN4.1: no ratio; left out: 12 at least",
      "    BN1.4 #2: no ratio",
      "  by moment, over the campaign:",
      "    start: 2 ratio(s), median 1.38, worst 1.87, 0.90-1.87; left out: 2 at least",
      "    install: 18 ratio(s), median 1.24, worst 3.38, 0.63-3.38; left out: 13 at least",
      "    count met: 3 ratio(s), median 0.50, worst 0.17, 0.17-4.15; left out: 3 at least",
      "    joined: 2 ratio(s), median 1.72, worst 2.00, 1.43-2.00; left out: 2 at least",
      "    donations install: 1 ratio(s), median 0.80, worst 0.80, 0.80-0.80; left out: 2 at least, 1 under 10 min left",
      "    The Red Pill installed: no ratio; left out: 2 at least, 2 under 10 min left",
      "  within ×1.25: 7 (27%) of 26; within ×1.5: 13 (50%); within ×2: 18 (69%) (Q9, #39; the measured rows: not " +
        "at least, 10 min or more left, not a first look)",
    ]);
  });
});

/** Levelling's view, as the rule reads it: off unless `estimateSeconds` is given. */
const levellingView = (estimateSeconds?: number): LevellingView =>
  estimateSeconds === undefined
    ? { applies: false, mode: "money", estimates: null, target: null, fit: null, lines: [] }
    : {
        applies: true,
        mode: "money",
        estimates: { money: estimateSeconds, level: null, install: null },
        target: null,
        fit: null,
        lines: [],
      };
const choice = (etaMinutes: number): FactionWorkChoice => ({
  faction: "Daedalus",
  workType: "hacking",
  augmentation: RED_PILL,
  reputation: 0,
  reputationNeeded: 462_491,
  reputationPerSecond: 1,
  etaSeconds: etaMinutes * 60,
});

describe("the brain's rule (#360)", () => {
  const PRIOR = { bitNode: "BN1.2", currentNode: 1, requiredLevel: 3000 };
  const seed: DestroySeed = {
    prior: {
      ...PRIOR,
      aMs: 570 * MINUTE,
      bcMs: 100 * MINUTE,
      redPillCycleMs: 18 * MINUTE,
      dMs: 3 * MINUTE,
    },
    onlineMs: 0,
    countMetOnlineMs: null,
    seenBefore: false,
  };
  /** A rule over the store, its events kept, its log too. */
  const ruleOf = (seenBefore = false) => {
    const events: DestroyEstimateEvent[] = [];
    const log: string[] = [];
    const rule = new DestroyEstimateRule({
      store,
      log: (line) => log.push(line),
      emit: (e) => events.push(e),
      seedOf: () => ({ ...seed, seenBefore }),
    });
    return { rule, events, log };
  };
  /** One update at `minute` of BN1.3 (from minute 0), the cycle from `aug` with `count`; Daedalus's favour if joined. */
  const update = (
    rule: DestroyEstimateRule,
    minute: number,
    aug: number,
    count: number,
    {
      daedalus,
      eta,
      redPill = false,
      levelling,
    }: { daedalus?: number; eta?: number; redPill?: boolean; levelling?: number } = {},
  ) =>
    rule.update({
      slowData: slow(
        minute,
        resetInfo(0, aug, 1, { 1: 2 }, augs(count, { redPill })),
        daedalus === undefined ? [] : [{ name: "Daedalus", favor: daedalus }],
      ),
      slowGameTimeMs: m(minute),
      slowAtMs: m(minute),
      factionChoice: eta === undefined ? null : choice(eta),
      levelling: levellingView(levelling),
      nowMs: m(minute),
    });

  test("an estimate at the start, each install, Daedalus joined and levelling's first choice: each moment once", () => {
    const { rule, events, log } = ruleOf();
    for (let minute = 1; minute <= 3; minute++) update(rule, minute, 0, 0);
    for (let minute = 4; minute <= 6; minute++) update(rule, minute, 3, 10);
    // The count met at 7; Daedalus joined at 9 (favour 0), A5's ETA 100 min; then the donations install (favour 152).
    for (let minute = 7; minute <= 8; minute++) update(rule, minute, 6, 31);
    for (let minute = 9; minute <= 10; minute++) update(rule, minute, 6, 31, { daedalus: 0, eta: 100 });
    update(rule, 11, 10, 35);
    update(rule, 12, 10, 35, { daedalus: 152 });
    // The Red Pill installed at 13; levelling's first estimate (20 min) at 14.
    update(rule, 13, 12, 36, { redPill: true });
    for (let minute = 14; minute <= 15; minute++) update(rule, minute, 12, 36, { redPill: true, levelling: 1200 });
    expect(events.map((each) => [each.moment, each.stage, minutes(each.onlineMs), minutes(each.remainingMs)])).toEqual([
      ["start", "start", 0, 570 + 100 + 3],
      ["install", "install", 3, (3 * 20) / 10 + 100 + 3],
      ["install", "count met", 6, 100 + 3],
      ["joined", "joined", 8, 100 + 18 + 3],
      ["install", "donations install", 10, 18 + 3],
      ["install", "The Red Pill installed", 12, 3],
      ["levelling", "levelling", 13, 20],
    ]);
    expect(events.every((each) => each.type === DESTROY_ESTIMATED_EVENT_KIND && !each.late)).toBe(true);
    expect(events[3]?.terms[1]).toMatchObject({ term: "BC", label: "cautious", never: false });
    expect(log.filter((line) => line.startsWith("destroy estimate: the destroy (#360), at "))).toHaveLength(7);
    // The dashboard's World Daemon line: the latest.
    expect(rule.lines()).toEqual([
      expect.stringMatching(/^time to the destroy \(#360\), at levelling's first choice /),
    ]);
  });

  test("once across a restart: the note carries the moments, the clock and the last estimate", () => {
    const first = ruleOf();
    for (let minute = 1; minute <= 5; minute++) update(first.rule, minute, 0, 0);
    expect(first.events.map((each) => each.moment)).toEqual(["start"]);
    expect(JSON.parse(store.getSetting(DESTROY_ESTIMATE_SETTING) as string)).toMatchObject({
      lastNodeReset: m(0),
      lastAugReset: m(0),
      clock: { onlineMs: 4 * MINUTE },
    });
    // A restart in the same cycle: no estimate again; the line kept, shown once a slow snapshot of its BitNode is seen
    // (till then it could be another BitNode's); the clock goes on, and the prior with it.
    const second = ruleOf();
    expect(second.rule.lines()).toEqual([]);
    for (let minute = 6; minute <= 7; minute++) update(second.rule, minute, 0, 0);
    expect(second.rule.lines()).toEqual(first.rule.lines());
    expect(second.events).toEqual([]);
    update(second.rule, 8, 7, 5);
    // 7 × 25/5 by the mean, and the prior's B + C and D: the note's prior, not the seed's (asked once a BitNode).
    expect(
      second.events.map((each) => [each.moment, minutes(each.onlineMs), each.late, minutes(each.remainingMs)]),
    ).toEqual([["install", 7, false, 35 + 100 + 3]]);
  });

  test("once across a restart in the joined cycle, and after levelling's first choice: the note keeps both", () => {
    const first = ruleOf();
    update(first.rule, 1, 0, 0);
    update(first.rule, 2, 1, 31);
    update(first.rule, 3, 1, 31, { daedalus: 0, eta: 100 });
    expect(first.events.map((each) => each.moment)).toEqual(["start", "install", "joined"]);
    const second = ruleOf();
    update(second.rule, 4, 1, 31, { daedalus: 0, eta: 90 });
    expect(second.events).toEqual([]);
    // The install after the join, the donations': its count met and its join kept by the note (B + C the prior's cycle).
    update(second.rule, 5, 4, 35);
    expect(second.events.map((each) => [each.stage, minutes(each.remainingMs)])).toEqual([
      ["donations install", 18 + 3],
    ]);
    update(second.rule, 6, 5, 36, { redPill: true });
    update(second.rule, 7, 5, 36, { redPill: true, levelling: 600 });
    expect(second.events.map((each) => each.moment)).toEqual(["install", "install", "levelling"]);
    const third = ruleOf();
    update(third.rule, 8, 5, 36, { redPill: true, levelling: 540 });
    expect(third.events).toEqual([]);
  });

  test("a cycle whose first estimate has levelling's already: one estimate, not a second with the same figures", () => {
    const { rule, events } = ruleOf();
    update(rule, 1, 0, 0);
    update(rule, 2, 1, 36, { redPill: true, levelling: 600 });
    update(rule, 3, 1, 36, { redPill: true, levelling: 540 });
    expect(events.map((each) => [each.moment, minutes(each.terms[2]?.ms ?? null)])).toEqual([
      ["start", 3],
      ["install", 10],
    ]);
  });

  test("a save loaded (an earlier lastAugReset): no estimate; the install after it is", () => {
    const { rule, events } = ruleOf();
    update(rule, 1, 0, 0);
    update(rule, 2, 1, 5);
    update(rule, 3, 0, 0);
    expect(events.map((each) => each.moment)).toEqual(["start", "install"]);
    update(rule, 4, 3.5, 6);
    expect(events.map((each) => each.moment)).toEqual(["start", "install", "install"]);
  });

  test("an install while the brain was down: estimated at the first slow snapshot after it, marked late", () => {
    const first = ruleOf();
    for (let minute = 1; minute <= 5; minute++) update(first.rule, minute, 0, 0);
    // Down from 5 to 40; the install at 20: seen at 40, 20 minutes after.
    const second = ruleOf();
    update(second.rule, 40, 20, 5);
    expect(second.events.map((each) => [each.moment, each.late, minutes(each.onlineMs)])).toEqual([
      ["install", true, 4],
    ]);
    expect(second.events[0]?.stage).toBe("install");
  });

  test("a brain first seeing a BitNode in The Red Pill's cycle: Daedalus's favour says the donations install was made", () => {
    const { rule, events } = ruleOf();
    // No note: joined again with favour 152 (the donations' 150), A5's choice none (donations buy it). A first look
    // at a later cycle, and no join (no A5 choice for the hold).
    update(rule, 50, 40, 36, { daedalus: 152 });
    expect(events.map((each) => [each.moment, each.stage, minutes(each.terms[1]?.ms ?? null)])).toEqual([
      ["first seen", "first seen", 18],
    ]);
  });

  test("a brain first seeing a BitNode with Daedalus joined at favour 0: the hold, A5's ETA plus the prior's cycle", () => {
    const fresh = ruleOf();
    update(fresh.rule, 50, 40, 36, { daedalus: 0, eta: 60 });
    expect(fresh.events.map((each) => [each.moment, minutes(each.terms[1]?.ms ?? null)])).toEqual([
      ["first seen", 60 + 18],
      ["joined", 60 + 18],
    ]);
  });

  test("Daedalus joined with no A5 choice for the hold yet: the join waits for it, as the hindcast keys on it", () => {
    const { rule, events } = ruleOf();
    update(rule, 1, 0, 0);
    update(rule, 2, 1, 31);
    update(rule, 3, 1, 31, { daedalus: 0 });
    expect(events.map((each) => each.moment)).toEqual(["start", "install"]);
    update(rule, 4, 1, 31, { daedalus: 0, eta: 100 });
    expect(events.at(-1)).toMatchObject({ moment: "joined", onlineMs: 3 * MINUTE });
    expect(minutes(events.at(-1)?.terms[1]?.ms ?? null)).toBe(100 + 18);
  });

  test("a first look at a BitNode's first cycle: its start if it's the store's first slow snapshot of it, else first seen", () => {
    const fresh = ruleOf(false);
    update(fresh.rule, 1, 0, 0);
    expect(fresh.events.map((each) => each.moment)).toEqual(["start"]);
  });

  test("a first look at a BitNode's first cycle the store saw before (its start the hindcast's): first seen", () => {
    const late = ruleOf(true);
    update(late.rule, 30, 0, 0);
    expect(late.events.map((each) => [each.moment, each.stage])).toEqual([["first seen", "first seen"]]);
  });

  test("a term never (levelling at no rate) is stored as never, with no time", () => {
    const { rule, events } = ruleOf();
    update(rule, 1, 0, 36, { redPill: true });
    update(rule, 2, 0, 36, { redPill: true, levelling: Number.POSITIVE_INFINITY });
    expect(events.at(-1)).toMatchObject({ moment: "levelling", never: true, remainingMs: null });
    expect(events.at(-1)?.terms[2]).toMatchObject({ term: "D", never: true, ms: null });
    // As JSON (the store's): the same.
    expect(JSON.parse(JSON.stringify(events.at(-1)))).toMatchObject({ never: true, remainingMs: null });
  });

  test("outside Daedalus's route (BN2): none, said once in the log", () => {
    const { rule, events, log } = ruleOf();
    for (let minute = 1; minute <= 3; minute++) {
      rule.update({
        slowData: slow(minute, resetInfo(0, 0, 2, { 1: 3 }, {})),
        slowGameTimeMs: m(minute),
        slowAtMs: m(minute),
        factionChoice: null,
        levelling: levellingView(),
        nowMs: m(minute),
      });
    }
    expect(events).toEqual([]);
    expect(log).toEqual([expect.stringMatching(/^destroy estimate: none in BitNode 2: its route isn't Daedalus's/)]);
  });

  test("the store's seed: the prior from the BitNodes before, the time online so far, the BitNode not stored yet", () => {
    fourBitNodes();
    // BN1.4 #2, open: its seed at its last slow snapshot, stored already.
    const { slows } = readAll();
    const last = slows.at(-1) as SlowResetInfo;
    const seedNow = readDestroySeed(store, "E0", { ...last, resetInfo: last.resetInfo as Record<string, unknown> });
    expect(seedNow.prior).toMatchObject({ bitNode: "BN1.4", currentNode: 1 });
    expect(minutes(seedNow.onlineMs)).toBe(5);
    // Its earlier slow snapshots stored: seen before (a first look now would be "first seen", its start the hindcast's).
    expect(seedNow.seenBefore).toBe(true);
    // A new BitNode, the next slow snapshot not stored: BN1.4 #2 ended by it.
    const next = {
      receivedAtMs: last.receivedAtMs + MINUTE,
      gameTimeMs: last.gameTimeMs + MINUTE,
      resetInfo: resetInfo(last.receivedAtMs / MINUTE - T0 / MINUTE, last.receivedAtMs / MINUTE - T0 / MINUTE, 5, {
        1: 3,
        4: 1,
      }),
    };
    // Its first step, from its `lastNodeReset` (the campaign's clock): a minute.
    expect(readDestroySeed(store, "E0", next)).toMatchObject({
      onlineMs: MINUTE,
      countMetOnlineMs: null,
      seenBefore: false,
    });
    // BN5's prior: none of BN5, so the last destroyed (BN4.1); BN1.4 #2 had no destroy sent at the cap, so isn't.
    expect(readDestroySeed(store, "E0", next).prior).toMatchObject({ bitNode: "BN4.1", currentNode: 4 });
  });
});

describe("the run report's check (#360)", () => {
  const record = (fields: Partial<DestroyEstimateRecord>): StoredEvent => ({
    atMs: m(100),
    kind: DESTROY_ESTIMATED_EVENT_KIND,
    detail: {
      moment: "install",
      stage: "count met",
      late: false,
      bitNode: "BN1.3",
      currentNode: 1,
      lastNodeReset: m(0),
      lastAugReset: m(90),
      onlineMs: 100 * MINUTE,
      remainingMs: 100 * MINUTE,
      totalMs: 200 * MINUTE,
      atLeast: false,
      never: false,
      count: 31,
      required: 30,
      requiredLevel: 3000,
      prior: "BN1.2",
      terms: [
        { term: "A", ms: 0, never: false, atLeast: false, source: "the count met", label: "done" },
        { term: "BC", ms: 97 * MINUTE, never: false, atLeast: false, source: "the prior's", label: "either way" },
        { term: "D", ms: 3 * MINUTE, never: false, atLeast: false, source: "the prior's", label: "either way" },
      ],
      ...fields,
    },
  });
  const judge = (events: StoredEvent[], worldDaemonEnabled = true) => {
    const failures: string[] = [];
    const warnings: string[] = [];
    const lines = destroyEstimateHealthLines(events, {
      failures,
      warnings,
      formatTime: (ms) => `${(ms - T0) / MINUTE}m`,
      worldDaemonEnabled,
    });
    return { failures, warnings, lines };
  };

  test("an estimate is reported, not judged: past the time online so far, from the count met on or before, passes", () => {
    // #360 amended: no bar on the whole estimate (a harness-made or short history, the prior's B + C, would break it).
    expect(judge([record({})]).failures).toEqual([]);
    expect(judge([record({ remainingMs: 600 * MINUTE })]).failures).toEqual([]);
    const short = record({
      stage: "install",
      remainingMs: 900 * MINUTE,
      terms: [{ term: "A", ms: 800 * MINUTE, never: false, atLeast: false, source: "the mean", label: "either way" }],
    });
    expect(judge([short]).failures).toEqual([]);
    expect(judge([record({})]).lines).toEqual(["  the time to the destroy (#360: a term never reached):", "    none"]);
    // None in the window: no lines.
    expect(judge([]).lines).toEqual([]);
  });

  test("a term never fails at once; with the World Daemon's switch off, a warning", () => {
    const never = record({
      never: true,
      remainingMs: null,
      totalMs: null,
      stage: "levelling",
      terms: [
        {
          term: "D",
          ms: null,
          never: true,
          atLeast: false,
          source: "levelling's chosen candidate",
          label: "either way",
        },
      ],
    });
    expect(judge([never]).failures).toEqual([
      "destroy estimate never at 100m (BN1.3, levelling): D: levelling's chosen candidate",
    ]);
    const off = judge([never, record({ remainingMs: 600 * MINUTE })], false);
    expect(off.failures).toEqual([]);
    expect(off.warnings).toHaveLength(1);
    expect(off.warnings.every((each) => each.endsWith("so a warning)"))).toBe(true);
    // One the brain didn't write: a failure, not left out silently.
    expect(judge([{ atMs: m(1), kind: DESTROY_ESTIMATED_EVENT_KIND, detail: { moment: "x" } }]).failures).toEqual([
      "destroy estimate: 1 destroyEstimated event(s) not read (not the brain's form)",
    ]);
  });

  test("w0r1d_d43m0n's level in the static snapshot against the BitNode's multipliers: a failure where it differs", () => {
    const failuresOf = (level: number, currentNode: number) => {
      const fold = new WorldDaemonFold();
      fold.addStatic(m(10), { servers: [{ hostname: "w0r1d_d43m0n", requiredHackingSkill: level }] } as never);
      fold.addSlow(m(11), m(11), { resetInfo: { currentNode, ownedSF: { 1: 3 } } } as never);
      const failures: string[] = [];
      fold.healthLines([], {
        failures,
        warnings: [],
        formatTime: (ms) => `${(ms - T0) / MINUTE}m`,
        bitNodeAt: () => 0,
      });
      return failures;
    };
    expect(failuresOf(9000, 4)).toEqual([]);
    expect(failuresOf(4500, 5)).toEqual([]);
    expect(failuresOf(3000, 4)).toEqual([
      "w0r1d_d43m0n's level 3000 in the static snapshot at 10m, not BitNode 4's 9000 (3000 × its WorldDaemonDifficulty, " +
        "core's worldDaemonRequiredLevel, #360)",
    ]);
  });
});
