// The dashboard's timeline of BitNodes and installs (#285): the campaign report's model, kept up to date as the page
// asks. Over synthetic stores built here, never the owner's .data/: four BitNodes, one begun before the store, with
// installs by the brain and by hand, an offline gap, a save loaded within a BitNode, and the newest going on. It agrees
// with the campaign report's rows; it folds only what was stored since the last read; its first read goes a batch at a
// time; a store thinned (#283) gives the same timeline; a failure is shown, not thrown. A large store's cost is
// measured behind TIMELINE_SLOW_SNAPSHOTS (a year is 525600).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { describeEnding } from "../src/campaign-model.ts";
import { campaignReport } from "../src/campaign-report.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import { CampaignTimeline, type CampaignTimelineView, type TimelineBitNode } from "../src/dashboard/timeline.ts";
import { formatDuration, formatIsoTime } from "../src/gap-report.ts";
import { thinStore } from "../src/store-thinning.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const MINUTE = 60_000;
/** The brain's clock (and the game's: one machine) `minutes` after T0. */
const m = (minutes: number) => T0 + minutes * MINUTE;
const RELEASE = "v1.0.0+aaaaaaaa";

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "campaign-timeline-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
function snapshot(tier: string, atMs: number, data: unknown) {
  store.recordSnapshot(
    { environment: "E0", release: RELEASE },
    {
      agentSessionId: "s",
      tier,
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: atMs,
      receivedAtMs: atMs,
      missedBefore: 0,
      data,
    },
  );
}
const event = (minutes: number, kind: string, detail: unknown = {}) =>
  store.recordEvent({ environment: "E0", release: RELEASE }, { atMs: m(minutes), kind, detail });
const installSent = (minutes: number, source: "brain" | "manual" = "brain") =>
  event(minutes, "augmentationInstallSent", { source, queued: [] });

/** A slow snapshot a minute from `from` to `to`, both in; `everyTier` adds a medium and a fast one every 10 s. */
function play(
  from: number,
  to: number,
  { node, aug, sf = 0, augs = {} }: { node: number; aug: number; sf?: number; augs?: Record<string, number> },
  everyTier = false,
) {
  const resetInfo = {
    lastAugReset: m(aug),
    lastNodeReset: m(node),
    currentNode: 1,
    ownedAugs: augs,
    ownedSF: (sf === 0 ? {} : { "1": sf }) as Record<string, number>,
    bitNodeOptions: {},
  };
  const slow: SlowSnapshotData = { resetInfo, purchasedServers: [] };
  store.writeTransaction(() => {
    for (let minute = from; minute <= to; minute++) {
      snapshot("slow", m(minute), slow);
      if (!everyTier) continue;
      for (let second = 0; second < 60; second += 10) {
        snapshot("medium", m(minute) + second * 1_000 + 5_000, { player: { money: minute }, servers: [] });
        snapshot("fast", m(minute) + second * 1_000 + 2_000, { degradedTiers: [], intents: [] });
      }
    }
  });
}

const EARLY = { BitWire: 1, "Neurotrainer I": 1 };
const LATER = { ...EARLY, "NeuroFlux Governor": 2, "Synaptic Enhancement Implant": 1 };

/**
 * The campaign, in minutes from T0:
 * - BN1.1, begun 10 h before the store and installed in since (at -100): an install by the brain at 30.5, destroyed at
 *   60.5. Online 59 min 30 s: 1 to 60.5, its start's step not seen.
 * - BN1.2 from 60.5: an install by hand (your queue) at 90.5, the game closed from 120 to 141 (21 min left out), an
 *   install by the brain at 150.5, destroyed at 180.5. Online 1 h 39 min, 2 h by the clock.
 * - BN1.3 from 180.5: an install at 200.5, then at 211 a save from its first cycle loaded, installed from again at
 *   220.5; destroyed at 240.5. Online 1 h 0 min.
 * - BN1.4 from 240.5, SF1 at its cap: an install at 260.5, going on at 270.
 */
function campaign(everyTier = false) {
  event(0, "brainStarted", { release: "v1.0.0" });
  play(1, 30, { node: -600, aug: -100, augs: EARLY }, everyTier);
  installSent(30.3);
  play(31, 60, { node: -600, aug: 30.5, augs: LATER }, everyTier);
  event(60.3, "bitNodeDestroySent");

  play(61, 90, { node: 60.5, aug: 60.5, sf: 1 }, everyTier);
  installSent(90.3, "manual");
  play(91, 120, { node: 60.5, aug: 90.5, sf: 1, augs: EARLY }, everyTier);
  play(141, 150, { node: 60.5, aug: 90.5, sf: 1, augs: EARLY }, everyTier);
  installSent(150.3);
  play(151, 180, { node: 60.5, aug: 150.5, sf: 1, augs: { ...EARLY, "NeuroFlux Governor": 1 } }, everyTier);
  event(180.3, "bitNodeDestroySent");

  play(181, 200, { node: 180.5, aug: 180.5, sf: 2 }, everyTier);
  installSent(200.3);
  play(201, 210, { node: 180.5, aug: 200.5, sf: 2, augs: EARLY }, everyTier);
  play(211, 220, { node: 180.5, aug: 180.5, sf: 2 }, everyTier);
  installSent(220.3);
  play(221, 240, { node: 180.5, aug: 220.5, sf: 2, augs: { ...EARLY, "NeuroFlux Governor": 1 } }, everyTier);
  event(240.3, "bitNodeDestroySent");

  play(241, 260, { node: 240.5, aug: 240.5, sf: 3 }, everyTier);
  installSent(260.3);
  play(261, 270, { node: 240.5, aug: 260.5, sf: 3, augs: EARLY }, everyTier);
}

const minutes = (count: number) => count * MINUTE;
const timeline = (batch?: number) => new CampaignTimeline({ store, environment: "E0", batch });
/** A view without its version: two timelines over the same store give the same. */
const withoutVersion = ({ version: _, ...rest }: CampaignTimelineView) => rest;
const cyclesOf = (bitNode: TimelineBitNode | undefined) =>
  bitNode?.cycleList.map((cycle) => [cycle.kind, cycle.startMs, cycle.onlineMs, cycle.endedBy]);

describe("the timeline of BitNodes and installs (#285)", () => {
  test("each BitNode: its start, how it ended, its time online and by the clock, its cycles and installs", () => {
    campaign();
    const view = timeline().read();
    expect(view.reading).toBeNull();
    expect(view.problem).toBeNull();
    expect(view.slowSnapshots).toBe(250);
    expect(view.unread).toBe(0);
    const [bn1, bn2, bn3, bn4] = view.bitNodes;
    expect(view.bitNodes).toHaveLength(4);
    expect(bn1).toMatchObject({
      name: "BN1.1",
      startMs: m(-600),
      start: "before the store",
      ending: "destroyed {at}",
      endedAtMs: m(60.5),
      destroyed: true,
      wallMs: minutes(660.5),
      onlineMs: minutes(59.5),
      soFar: false,
      wallAtLeast: false,
      // Its start not seen, and an install before its first look: at least.
      onlineAtLeast: true,
      countsAtLeast: true,
      leftOutMs: 0,
      gapCount: 0,
      cycles: 3,
      installs: 2,
      byHand: 0,
      augmentations: 4,
      releases: ["v1.0.0"],
    });
    // Its first look's cycle, then the install's: the step across it split at the install (30.5), the destroy's step
    // (60 to 60.5) the last cycle's.
    expect(cyclesOf(bn1)).toEqual([
      [
        "seen first",
        m(-100),
        minutes(29.5),
        [
          {
            atMs: m(30.5),
            byHand: false,
            augmentationCount: 3,
            augmentations: "NeuroFlux Governor ×2, Synaptic Enhancement Implant",
          },
        ],
      ],
      ["install", m(30.5), minutes(30), []],
    ]);
    expect(bn2).toMatchObject({
      name: "BN1.2",
      startMs: m(60.5),
      start: null,
      ending: "destroyed {at}",
      endedAtMs: m(180.5),
      wallMs: minutes(120),
      onlineMs: minutes(99),
      onlineAtLeast: false,
      countsAtLeast: false,
      leftOutMs: minutes(21),
      gapCount: 1,
      cycles: 3,
      installs: 2,
      byHand: 1,
      augmentations: 3,
    });
    expect(cyclesOf(bn2)).toEqual([
      [
        "start",
        m(60.5),
        minutes(30),
        [{ atMs: m(90.5), byHand: true, augmentationCount: 2, augmentations: "BitWire, Neurotrainer I" }],
      ],
      // The gap left out: 0.5 + 29 + 9 + 0.5.
      [
        "install",
        m(90.5),
        minutes(39),
        [{ atMs: m(150.5), byHand: false, augmentationCount: 1, augmentations: "NeuroFlux Governor" }],
      ],
      ["install", m(150.5), minutes(30), []],
    ]);
    // The save loaded goes on in the cycle it's from, which an install ends again: from the save's augmentations.
    expect(bn3).toMatchObject({ name: "BN1.3", onlineMs: minutes(60), wallMs: minutes(60), cycles: 3, installs: 2 });
    expect(cyclesOf(bn3)).toEqual([
      [
        "start",
        m(180.5),
        minutes(30.5),
        [
          { atMs: m(200.5), byHand: false, augmentationCount: 2, augmentations: "BitWire, Neurotrainer I" },
          {
            atMs: m(220.5),
            byHand: false,
            augmentationCount: 3,
            augmentations: "BitWire, Neurotrainer I, NeuroFlux Governor",
          },
        ],
      ],
      ["install", m(200.5), minutes(9.5), []],
      ["install", m(220.5), minutes(20), []],
    ]);
    expect(bn4).toMatchObject({
      name: "BN1.4",
      ending: "not yet",
      endedAtMs: null,
      destroyed: false,
      soFar: true,
      wallMs: minutes(29.5),
      onlineMs: minutes(29.5),
      cycles: 2,
      installs: 1,
    });
    expect(cyclesOf(bn4)?.map(([kind, , onlineMs]) => [kind, onlineMs])).toEqual([
      ["start", minutes(20)],
      ["install", minutes(9.5)],
    ]);
    // A BitNode's cycles add up to its time online.
    for (const bitNode of view.bitNodes) {
      expect(bitNode.cycleList.reduce((total, cycle) => total + cycle.onlineMs, 0)).toBe(bitNode.onlineMs);
    }
  });

  test("the campaign report's own rows: the same names, endings, times, cycles and installs", () => {
    campaign();
    const report = campaignReport(store, { environment: "E0" });
    const lines = report.split("\n");
    const start = lines.findIndex((line) => line.startsWith("BitNodes, one row each")) + 2;
    const rows = lines.slice(start, start + 4).map((line) => line.trim().split(/ {2,}/));
    const atLeast = (shown: string, isLowerBound: boolean) => (isLowerBound ? `≥ ${shown}` : shown);
    const { bitNodes } = timeline().read();
    expect(rows.map((row) => row[0])).toEqual(bitNodes.map((bitNode) => bitNode.name));
    bitNodes.forEach((bitNode, index) => {
      const soFar = bitNode.soFar ? " so far" : "";
      const [, , ended, wall, online, , cycles, installs] = rows[index] ?? [];
      expect(ended).toBe(
        describeEnding(
          { text: bitNode.ending, atMs: bitNode.endedAtMs, destroyedAtMs: null, unseenAfter: false },
          formatIsoTime,
        ),
      );
      expect(wall).toBe(atLeast(`${formatDuration(bitNode.wallMs)}${soFar}`, bitNode.wallAtLeast));
      expect(online).toBe(atLeast(`${formatDuration(bitNode.onlineMs)}${soFar}`, bitNode.onlineAtLeast));
      expect(cycles).toBe(atLeast(String(bitNode.cycles), bitNode.countsAtLeast));
      const byHand = bitNode.byHand > 0 ? ` (${bitNode.byHand} by hand)` : "";
      expect(installs).toBe(atLeast(`${bitNode.installs}${byHand}`, bitNode.countsAtLeast));
    });
  });

  test("each read folds only what was stored since: the same timeline as one read afresh", () => {
    play(1, 30, { node: -600, aug: -100, augs: EARLY });
    const kept = timeline();
    const first = kept.read();
    expect(first.bitNodes.map((bitNode) => bitNode.ending)).toEqual(["not yet"]);
    expect(kept.slowSnapshotsRead).toBe(30);
    // Nothing new: the same view, its version unchanged, and nothing read.
    expect(kept.read()).toBe(first);
    expect(kept.slowSnapshotsRead).toBe(30);
    // An install, a destroy and the next BitNode: each slow snapshot read once, the events appended.
    installSent(30.3);
    play(31, 60, { node: -600, aug: 30.5, augs: LATER });
    event(60.3, "bitNodeDestroySent");
    play(61, 70, { node: 60.5, aug: 60.5, sf: 1 });
    const second = kept.read();
    expect(kept.slowSnapshotsRead).toBe(70);
    expect(second.version).toBeGreaterThan(first.version);
    expect(withoutVersion(second)).toEqual(withoutVersion(timeline().read()));
    expect(second.bitNodes.map((bitNode) => [bitNode.name, bitNode.ending])).toEqual([
      ["BN1.1", "destroyed {at}"],
      ["BN1.2", "not yet"],
    ]);
    // An event alone changes it too, with no slow snapshot read.
    event(70.5, "brainStarted", { release: "v1.0.0" });
    const third = kept.read();
    expect(third.version).toBeGreaterThan(second.version);
    expect(kept.slowSnapshotsRead).toBe(70);
    // Each event read once: nothing new after it.
    expect(kept.read()).toBe(third);
    // And the whole campaign, stored a piece at a time, is the same as read at once.
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "campaign-timeline-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    const piecemeal = timeline();
    const original = store.writeTransaction.bind(store);
    // Each stretch of play is one transaction, every tier stored: read after each.
    store.writeTransaction = <Result>(write: () => Result): Result => {
      const result = original(write);
      piecemeal.read();
      return result;
    };
    campaign(true);
    store.writeTransaction = original;
    expect(withoutVersion(piecemeal.read())).toEqual(withoutVersion(timeline().read()));
  });

  test("the first read goes a batch at a time, showing how far it's got; what's stored meanwhile comes after", () => {
    campaign();
    const batched = timeline(100);
    const first = batched.read();
    expect(first.reading).toEqual({ slowSnapshots: 100 });
    // No BitNode till it's read them all: the newest one read so far may not be the newest.
    expect(first.bitNodes).toEqual([]);
    expect(batched.read().reading).toEqual({ slowSnapshots: 200 });
    // Stored during the first read: folded after it, in the order stored.
    play(271, 280, { node: 240.5, aug: 260.5, sf: 3, augs: EARLY });
    const done = batched.read();
    expect(done.reading).toBeNull();
    expect(done.slowSnapshots).toBe(250);
    expect(batched.read().slowSnapshots).toBe(260);
    expect(withoutVersion(batched.read())).toEqual(withoutVersion(timeline().read()));
  });

  test("a store thinned (#283) gives the same timeline: it reads no medium or fast snapshot", () => {
    campaign(true);
    // A fast snapshot two days on, the newest: with a day kept whole, the whole campaign is thinned.
    snapshot("fast", m(270) + 2 * 24 * 60 * MINUTE, { degradedTiers: [], intents: [] });
    const whole = withoutVersion(timeline().read());
    const thinning = thinStore(store, {
      context: { environment: "E0", release: RELEASE },
      nowMs: m(270) + 2 * 24 * 60 * MINUTE,
      keptWholeDays: 1,
    });
    expect(thinning.thinned.fast).toBeGreaterThan(0);
    expect(thinning.thinned.medium).toBeGreaterThan(0);
    expect(withoutVersion(timeline().read())).toEqual(whole);
  });

  test("a slow snapshot with no resetInfo is counted and left out; a store with no BitNode shows none", () => {
    snapshot("slow", m(1), { purchasedServers: [] });
    expect(timeline().read()).toMatchObject({
      slowSnapshots: 1,
      unread: 1,
      bitNodes: [],
      reading: null,
      problem: null,
    });
    play(2, 3, { node: 0, aug: 0 });
    expect(timeline().read()).toMatchObject({ slowSnapshots: 3, unread: 1 });
  });

  test("a failure is shown in the timeline, not thrown, and handed on once while it lasts", () => {
    campaign();
    const failures: unknown[] = [];
    const failing = new CampaignTimeline({ store, environment: "E0", onError: (error) => failures.push(error) });
    const before = failing.read();
    store.close();
    const failed = failing.read();
    expect(failed.problem).toMatch(/database is not open/);
    // What it read before is still shown.
    expect(failed.bitNodes).toEqual(before.bitNodes);
    failing.read();
    expect(failures).toHaveLength(1);
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  });
});

/**
 * A large store's cost (#285): its first read, batch by batch, and a poll after it, with one slow snapshot stored and
 * with none. Slow snapshots with a real one's payload (the faction state, the money's sources, 30 augmentations). In CI
 * a small store; TIMELINE_SLOW_SNAPSHOTS=525600 for a year's, the times logged.
 */
describe("a large store", () => {
  const count = Number(process.env.TIMELINE_SLOW_SNAPSHOTS ?? 3_000);
  test(`${count.toLocaleString("en-US")} slow snapshots: a poll after the first read reads only what's new`, () => {
    const ownedAugs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`Augmentation ${index}`, 1]));
    const names = (prefix: string, length: number) => Array.from({ length }, (_, index) => `${prefix} ${index}`);
    const data = (minute: number) => ({
      resetInfo: {
        lastAugReset: m(Math.floor(minute / 1_440) * 1_440),
        lastNodeReset: m(Math.floor(minute / 14_400) * 14_400),
        currentNode: 1,
        ownedAugs,
        ownedSF: { "1": 1 },
        bitNodeOptions: { sourceFileOverrides: {} },
      },
      purchasedServers: names("pserv", 25),
      factions: {
        backend: "ui",
        state: {
          joined: names("Faction", 10).map((name) => ({ name, reputation: 123_456.789, favor: 12.3 })),
          invitations: names("Invitation", 3),
          queuedAugmentations: names("Queued", 20),
        },
        opened: ["Augmentations"],
      },
      moneySources: Object.fromEntries(names("source", 15).map((name) => [name, 1_234_567.89])),
    });
    const built = performance.now();
    store.writeTransaction(() => {
      for (let minute = 0; minute < count; minute++) snapshot("slow", m(minute), data(minute));
    });
    const builtMs = performance.now() - built;
    const kept = timeline();
    const started = performance.now();
    let polls = 0;
    let longestPollMs = 0;
    for (let view: CampaignTimelineView | null = null; view?.reading !== null; polls++) {
      const pollStarted = performance.now();
      view = kept.read();
      longestPollMs = Math.max(longestPollMs, performance.now() - pollStarted);
    }
    const firstReadMs = performance.now() - started;
    expect(kept.slowSnapshotsRead).toBe(count);
    const idleStarted = performance.now();
    kept.read();
    const idleMs = performance.now() - idleStarted;
    snapshot("slow", m(count), data(count));
    const pollStarted = performance.now();
    const view = kept.read();
    const pollMs = performance.now() - pollStarted;
    expect(kept.slowSnapshotsRead).toBe(count + 1);
    expect(view.slowSnapshots).toBe(count + 1);
    const reportStarted = performance.now();
    campaignReport(store, { environment: "E0" });
    const reportMs = performance.now() - reportStarted;
    // Each slow snapshot's payload parsed whole, as the report read them before #285.
    const wholeStarted = performance.now();
    let whole = 0;
    for (const _ of store.iterateSnapshotsInWindow({
      environment: "E0",
      tier: "slow",
      sinceMs: 0,
      untilMs: m(count),
    })) {
      whole += 1;
    }
    const wholeMs = performance.now() - wholeStarted;
    expect(whole).toBe(count + 1);
    console.log(
      `timeline over ${count} slow snapshots (store built in ${builtMs.toFixed(0)} ms): first read ` +
        `${firstReadMs.toFixed(0)} ms in ${polls} polls (the longest ${longestPollMs.toFixed(0)} ms); a poll with nothing ` +
        `new ${idleMs.toFixed(2)} ms; with one slow snapshot ${pollMs.toFixed(2)} ms; npm run campaign's report ` +
        `${reportMs.toFixed(0)} ms (each slow snapshot parsed whole, as it read them before: ${wholeMs.toFixed(0)} ms)`,
    );
  });
});
