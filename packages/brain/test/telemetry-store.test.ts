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

test("settings are kept across reopening the store", () => {
  store.setSetting("supervisionPaused", "true");
  store.close();
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  expect(store.getSetting("supervisionPaused")).toBe("true");
  expect(store.getSetting("missing")).toBeNull();
});
