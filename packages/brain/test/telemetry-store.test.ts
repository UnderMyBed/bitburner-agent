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

test("the store is in WAL mode, so a reader never blocks the brain's writes; a read-only open can't write", () => {
  expect(store.journalMode()).toBe("wal");
  const reader = TelemetryStore.openReadOnly(path.join(directory, "telemetry.sqlite"));
  expect(() => reader.setSetting("x", "y")).toThrow();
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

test("settings are kept across reopening the store, and can be deleted", () => {
  store.setSetting("supervision.paused", "true");
  store.close();
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  expect(store.getSetting("supervision.paused")).toBe("true");
  expect(store.getSetting("missing")).toBeNull();
  store.deleteSetting("supervision.paused");
  expect(store.getSetting("supervision.paused")).toBeNull();
});
