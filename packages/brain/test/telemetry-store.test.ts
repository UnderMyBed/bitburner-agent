import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TelemetryStore } from "../src/telemetry-store.ts";

let directory: string;
let store: TelemetryStore;
const context = { environment: "E1" as const, release: "v0.2.0+deployment-a" };

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "telemetry-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a snapshot round-trips, tagged with environment and release", () => {
  store.recordSnapshot(context, {
    agentSessionId: "session-1",
    tier: "fast",
    sequenceNumber: 3,
    gameTimeMs: 1_000,
    receivedAtMs: 2_000,
    missedBefore: 1,
    data: { money: 5 },
  });
  expect(store.snapshots({ environment: "E1" })).toEqual([
    {
      environment: "E1",
      release: "v0.2.0+deployment-a",
      agentSessionId: "session-1",
      tier: "fast",
      sequenceNumber: 3,
      gameTimeMs: 1_000,
      receivedAtMs: 2_000,
      missedBefore: 1,
      data: { money: 5 },
    },
  ]);
});

test("fast snapshots' receipt times, by environment and window, for the gap report", () => {
  for (const [receivedAtMs, tier, environment] of [
    [1_000, "fast", "E1"],
    [2_000, "slow", "E1"],
    [3_000, "fast", "E1"],
    [4_000, "fast", "E0"],
    [9_000, "fast", "E1"],
  ] as const) {
    store.recordSnapshot(
      { environment, release: "r" },
      {
        agentSessionId: "s",
        tier,
        sequenceNumber: receivedAtMs,
        gameTimeMs: 0,
        receivedAtMs,
        missedBefore: 0,
        data: null,
      },
    );
  }
  expect(store.fastSnapshotTimes({ environment: "E1", sinceMs: 0, untilMs: 5_000 })).toEqual([1_000, 3_000]);
  // Both edges of the window count.
  expect(store.fastSnapshotTimes({ environment: "E1", sinceMs: 1_000, untilMs: 3_000 })).toEqual([1_000, 3_000]);
});

test("snapshots of a tier and events, by environment and window (both edges), in order: the run report", () => {
  for (const [receivedAtMs, tier, environment] of [
    [3_000, "medium", "E1"],
    [1_000, "medium", "E1"],
    [2_000, "fast", "E1"],
    [4_000, "medium", "E0"],
    [5_000, "medium", "E1"],
    [9_000, "medium", "E1"],
  ] as const) {
    store.recordSnapshot(
      { environment, release: "r" },
      {
        agentSessionId: "s",
        tier,
        sequenceNumber: 1,
        gameTimeMs: 0,
        receivedAtMs,
        missedBefore: 0,
        data: receivedAtMs,
      },
    );
    store.recordEvent({ environment, release: "r" }, { atMs: receivedAtMs, kind: tier, detail: receivedAtMs });
  }
  const window = { environment: "E1", sinceMs: 1_000, untilMs: 5_000 } as const;
  // By time of arrival, not the order stored, one row at a time.
  const rows = store.iterateSnapshotsInWindow({ ...window, tier: "medium" });
  expect(rows.next().value?.data).toBe(1_000);
  expect([...rows].map((snapshot) => snapshot.data)).toEqual([3_000, 5_000]);
  // Events in the order stored.
  expect(store.eventsInWindow(window).map((event) => event.detail)).toEqual([3_000, 1_000, 2_000, 5_000]);
});

test("fast snapshots' page heaps, by environment and window, in order of arrival, numbers only", () => {
  for (const [receivedAtMs, tier, environment, data] of [
    [3_000, "fast", "E0", { pageHeapUsedBytes: 30 }],
    [1_000, "fast", "E0", { pageHeapUsedBytes: 10 }],
    [2_000, "fast", "E0", { pageHeapUsedBytes: null }],
    // E2's shape: Playwright's page has no performance.memory, so the key is missing.
    [2_100, "fast", "E0", {}],
    [2_200, "fast", "E0", { pageHeapUsedBytes: "12" }],
    [2_500, "medium", "E0", { pageHeapUsedBytes: 99 }],
    [2_600, "fast", "E2", { pageHeapUsedBytes: 98 }],
    [9_000, "fast", "E0", { pageHeapUsedBytes: 90 }],
  ] as const) {
    store.recordSnapshot(
      { environment, release: "r" },
      {
        agentSessionId: "s",
        tier,
        sequenceNumber: receivedAtMs,
        gameTimeMs: 0,
        receivedAtMs,
        missedBefore: 0,
        data,
      },
    );
  }
  expect(store.fastSnapshotPageHeaps({ environment: "E0", sinceMs: 1_000, untilMs: 3_000 })).toEqual([10, 30]);
  expect(store.fastSnapshotPageHeaps({ environment: "E0", sinceMs: 4_000, untilMs: 8_000 })).toEqual([]);
});

test("the store is in WAL mode, so a reader never blocks the brain's writes; a read-only open can't write", () => {
  expect(store.journalMode()).toBe("wal");
  const reader = TelemetryStore.openReadOnly(path.join(directory, "telemetry.sqlite"));
  expect(() => reader.setSetting("x", "y")).toThrow();
  reader.close();
});

test("a read transaction sees the store as at its first read, whatever is written meanwhile (the run report)", () => {
  const reader = TelemetryStore.openReadOnly(path.join(directory, "telemetry.sqlite"));
  const count = () => reader.events({ environment: "E1" }).length;
  store.recordEvent(context, { atMs: 1, kind: "a", detail: null });
  const [before, during] = reader.readTransaction(() => {
    const first = count();
    store.recordEvent(context, { atMs: 2, kind: "b", detail: null });
    return [first, count()];
  });
  expect([before, during, count()]).toEqual([1, 1, 2]);
  // A read that throws still ends the transaction.
  expect(() =>
    reader.readTransaction(() => {
      throw new Error("read failed");
    }),
  ).toThrow("read failed");
  expect(reader.readTransaction(count)).toBe(2);
  reader.close();
});

test("events round-trip in order, tagged", () => {
  store.recordEvent(context, { atMs: 5, kind: "agentConnected", detail: { agentSessionId: "s" } });
  store.recordEvent(context, { atMs: 6, kind: "connectionRejected", detail: { reason: "origin", detail: "x" } });
  expect(store.events({ environment: "E1" })).toEqual([
    {
      environment: "E1",
      release: "v0.2.0+deployment-a",
      atMs: 5,
      kind: "agentConnected",
      detail: { agentSessionId: "s" },
    },
    {
      environment: "E1",
      release: "v0.2.0+deployment-a",
      atMs: 6,
      kind: "connectionRejected",
      detail: { reason: "origin", detail: "x" },
    },
  ]);
});

const snapshotAt = (receivedAtMs: number, tier: string, data: unknown = null) => ({
  agentSessionId: "s",
  tier,
  sequenceNumber: receivedAtMs,
  gameTimeMs: 0,
  receivedAtMs,
  missedBefore: 0,
  data,
});

test("the latest snapshot of a tier, in the order stored (a clock set back can't reorder), in an environment", () => {
  store.recordSnapshot(context, snapshotAt(3_000, "fast", { n: 3 }));
  // Arrived later, though the clock had gone back.
  store.recordSnapshot(context, snapshotAt(1_000, "fast", { n: 1 }));
  store.recordSnapshot(context, snapshotAt(5_000, "medium", { n: 5 }));
  store.recordSnapshot({ environment: "E0", release: "r" }, snapshotAt(9_000, "fast", { n: 9 }));
  expect(store.latestSnapshot({ environment: "E1", tier: "fast" })).toMatchObject({
    receivedAtMs: 1_000,
    data: { n: 1 },
  });
  expect(store.latestSnapshot({ environment: "E1", tier: "slow" })).toBeNull();
});

test("a session's last sequence number of each tier (#119), in an environment, from any release", () => {
  const ofSession = (agentSessionId: string, tier: string, sequenceNumber: number) => ({
    ...snapshotAt(sequenceNumber, tier),
    agentSessionId,
    sequenceNumber,
  });
  store.recordSnapshot(context, ofSession("s", "fast", 7));
  // Stored after a higher one (a clock set back can't matter: it's by number).
  store.recordSnapshot({ ...context, release: "v0.2.0+deployment-b" }, ofSession("s", "fast", 9));
  store.recordSnapshot(context, ofSession("s", "fast", 8));
  store.recordSnapshot(context, ofSession("s", "slow", 2));
  store.recordSnapshot(context, ofSession("other", "medium", 40));
  store.recordSnapshot({ environment: "E0", release: "r" }, ofSession("s", "medium", 50));
  expect(store.lastSequenceNumbers({ environment: "E1", agentSessionId: "s" })).toEqual({ fast: 9, slow: 2 });
  expect(store.lastSequenceNumbers({ environment: "E1", agentSessionId: "new" })).toEqual({});
});

test("recent events newest first, up to a limit; and the latest of some kinds after an event", () => {
  const ids: number[] = [];
  for (const [atMs, kind] of [
    [1, "deployed"],
    [2, "agentConnected"],
    [3, "deployFailed"],
    [4, "agentDisconnected"],
  ] as const) {
    ids.push(store.recordEvent(context, { atMs, kind, detail: { atMs } }));
  }
  // Numbered in the order stored.
  expect(ids).toEqual([1, 2, 3, 4]);
  store.recordEvent({ environment: "E0", release: "r" }, { atMs: 5, kind: "deployed", detail: {} });
  expect(store.recentEvents({ environment: "E1", limit: 3 }).map((event) => event.atMs)).toEqual([4, 3, 2]);
  expect(
    store.recentEvents({ environment: "E1", limit: 5, kinds: ["deployed", "deployFailed"] }).map((event) => event.atMs),
  ).toEqual([3, 1]);
  expect(store.latestEvent({ environment: "E1", kinds: ["deployed", "deployFailed"], afterEventId: 0 })).toMatchObject({
    atMs: 3,
    kind: "deployFailed",
  });
  // Strictly after: the event itself doesn't count.
  expect(store.latestEvent({ environment: "E1", kinds: ["deployed"], afterEventId: 1 })).toBeNull();
});

test("the latest event id of some kinds, and counting events after an event since a time", () => {
  expect(store.latestEventId({ environment: "E1", kinds: ["relaunch"] })).toBe(0);
  const first = store.recordEvent(context, { atMs: 100, kind: "relaunch", detail: {} });
  const gaveUp = store.recordEvent(context, { atMs: 200, kind: "gaveUp", detail: {} });
  store.recordEvent(context, { atMs: 50, kind: "relaunch", detail: {} });
  store.recordEvent(context, { atMs: 300, kind: "relaunch", detail: {} });
  store.recordEvent({ environment: "E0", release: "r" }, { atMs: 400, kind: "relaunch", detail: {} });
  expect(store.latestEventId({ environment: "E1", kinds: ["gaveUp"] })).toBe(gaveUp);
  expect(store.countEvents({ environment: "E1", kinds: ["relaunch"], afterEventId: 0, sinceMs: 0 })).toBe(3);
  // After the give-up by order, whatever the times say; and within the window by time.
  expect(store.countEvents({ environment: "E1", kinds: ["relaunch"], afterEventId: gaveUp, sinceMs: 0 })).toBe(2);
  expect(store.countEvents({ environment: "E1", kinds: ["relaunch"], afterEventId: first, sinceMs: 100 })).toBe(1);
});

test("settings are kept across reopening the store, and can be deleted", () => {
  store.setSetting("supervision.paused", "true");
  store.close();
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  expect(store.getSetting("supervision.paused")).toBe("true");
  expect(store.getSetting("missing")).toBeNull();
  store.deleteSetting("supervision.paused");
  expect(store.getSetting("supervision.paused")).toBeNull();
});
