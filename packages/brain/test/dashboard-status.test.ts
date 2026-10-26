// The dashboard's status (#93), built from a store fixture: the Agent, the last snapshot per tier, key values, gaps
// over 24 h, alerts, recent events and supervision.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildDashboardStatus } from "../src/dashboard/status.ts";
import { recordSupervisionGaveUp, setSupervisionPaused } from "../src/supervision.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const STARTED_AT_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY_MS = 24 * 60 * 60_000;
const context = { environment: "E0" as const, release: "v0.2.0+abc123def456" };
const game = { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" };
let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dashboard-status-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const status = (nowMs: number) =>
  buildDashboardStatus({
    store,
    environment: "E0",
    brainRelease: "v0.2.0",
    brainStartedAtMs: STARTED_AT_MS,
    nowMs,
  });

function recordSnapshot(tier: string, receivedAtMs: number, data: unknown): void {
  store.recordSnapshot(context, {
    agentSessionId: "session-1",
    tier,
    sequenceNumber: receivedAtMs,
    gameTimeMs: receivedAtMs,
    receivedAtMs,
    missedBefore: 0,
    data,
  });
}

const fastData = (money: number): FastSnapshotData => ({
  degradedTiers: ["static"],
  pageHeapUsedBytes: 250_000_000,
  game: {
    money,
    homeRamUsed: 4.7,
    homeMaxRam: 8,
    homeProcesses: [
      { pid: 1, filename: "agent/abc123def456/agent.js", threads: 1, args: [], temporary: true },
      { pid: 2, filename: "agent/abc123def456/snapshot-fast.js", threads: 1, args: [], temporary: true },
    ],
  },
});

test("a healthy skeleton: the Agent connected, every tier's last snapshot and its age, key values, no alerts", () => {
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "deployed",
    detail: { deploymentId: "abc123def456" },
  });
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 2_000,
    kind: "agentConnected",
    detail: { agentSessionId: "session-1", deploymentId: "abc123def456", game },
  });
  for (let second = 2; second <= 20; second += 2)
    recordSnapshot("fast", STARTED_AT_MS + second * 1000, fastData(second));
  recordSnapshot("medium", STARTED_AT_MS + 10_000, {
    player: { skills: { hacking: 42 } },
    servers: [],
  } as MediumSnapshotData);
  recordSnapshot("slow", STARTED_AT_MS + 2_000, {});
  recordSnapshot("static", STARTED_AT_MS + 2_000, {});
  const nowMs = STARTED_AT_MS + 21_000;

  const built = status(nowMs);
  expect(built).toMatchObject({
    nowMs,
    environment: "E0",
    brainRelease: "v0.2.0",
    brainStartedAtMs: STARTED_AT_MS,
    agent: {
      connected: true,
      sinceMs: STARTED_AT_MS + 2_000,
      agentSessionId: "session-1",
      deploymentId: "abc123def456",
      game,
      versionDrift: null,
    },
    tiers: {
      fast: { receivedAtMs: STARTED_AT_MS + 20_000, ageMs: 1_000 },
      medium: { receivedAtMs: STARTED_AT_MS + 10_000, ageMs: 11_000 },
      slow: { receivedAtMs: STARTED_AT_MS + 2_000, ageMs: 19_000 },
      static: { receivedAtMs: STARTED_AT_MS + 2_000, ageMs: 19_000 },
    },
    values: {
      money: 20,
      hackingLevel: 42,
      homeRamUsed: 4.7,
      homeMaxRam: 8,
      homeScripts: 2,
      pageHeapUsedBytes: 250_000_000,
      degradedTiers: ["static"],
    },
    alerts: [],
    supervision: { state: "running", paused: false, gaveUpAtMs: null, relaunches: [] },
  });
  // Newest first.
  expect(built.events.map((event) => event.kind)).toEqual(["agentConnected", "deployed"]);
});

test("gaps over the last 24 h come from the gap report, from 24 h before now", () => {
  const nowMs = STARTED_AT_MS + DAY_MS;
  // One heartbeat from before the window (not counted), then the last 10 minutes every 2 s, but for 100 s.
  recordSnapshot("fast", nowMs - DAY_MS - 1_000, fastData(1));
  const tenMinutesAgoMs = nowMs - 600_000;
  for (let second = 0; second <= 600; second += 2) {
    if (second > 300 && second < 400) continue;
    recordSnapshot("fast", tenMinutesAgoMs + second * 1000, fastData(1));
  }
  const { gaps } = status(nowMs);
  expect(gaps).toMatchObject({ sinceMs: nowMs - DAY_MS, untilMs: nowMs, thresholdMs: 6_000, count: 252 });
  expect(gaps.gaps).toEqual([
    { fromMs: nowMs - DAY_MS, toMs: tenMinutesAgoMs, lengthMs: DAY_MS - 600_000 },
    { fromMs: tenMinutesAgoMs + 300_000, toMs: tenMinutesAgoMs + 400_000, lengthMs: 100_000 },
  ]);
});

test("nothing yet: the Agent not connected, no snapshots, the silent alert after 60 s", () => {
  const built = status(STARTED_AT_MS + 61_000);
  expect(built.agent).toEqual({
    connected: false,
    sinceMs: null,
    agentSessionId: null,
    deploymentId: null,
    game: null,
    versionDrift: null,
  });
  expect(built.tiers).toEqual({ static: null, slow: null, medium: null, fast: null });
  expect(built.values).toEqual({
    money: null,
    hackingLevel: null,
    homeRamUsed: null,
    homeMaxRam: null,
    homeScripts: null,
    pageHeapUsedBytes: null,
    degradedTiers: [],
  });
  expect(built.alerts.map((alert) => alert.name)).toEqual(["agentSilent"]);
});

test("a disconnected Agent, another game version, a failed deploy and a give-up all show", () => {
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "agentConnected",
    detail: { agentSessionId: "s", deploymentId: "d", game: { ...game, commit: "DEV" } },
  });
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "versionDrift",
    detail: { detail: "the Agent's game: commit DEV" },
  });
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 3_000,
    kind: "agentDisconnected",
    detail: { agentSessionId: "s" },
  });
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 4_000,
    kind: "deployFailed",
    detail: { deploymentId: "d", reason: "agent.js needs 4.7 GB, over its budget of 3 GB" },
  });
  store.recordEvent(context, { atMs: STARTED_AT_MS + 5_000, kind: "relaunch", detail: { cause: "game process gone" } });
  recordSupervisionGaveUp(store, STARTED_AT_MS + 6_000);
  const built = status(STARTED_AT_MS + 7_000);
  expect(built.agent).toMatchObject({ connected: false, sinceMs: STARTED_AT_MS + 3_000, agentSessionId: "s" });
  expect(built.alerts).toEqual([
    { name: "versionDrift", sinceMs: STARTED_AT_MS + 1_000, detail: "the Agent's game: commit DEV" },
    { name: "deployFailed", sinceMs: STARTED_AT_MS + 4_000, detail: "agent.js needs 4.7 GB, over its budget of 3 GB" },
    expect.objectContaining({ name: "supervisionGaveUp", sinceMs: STARTED_AT_MS + 6_000 }),
  ]);
  expect(built.supervision).toEqual({
    state: "gaveUp",
    paused: false,
    gaveUpAtMs: STARTED_AT_MS + 6_000,
    relaunches: [{ atMs: STARTED_AT_MS + 5_000, detail: { cause: "game process gone" } }],
  });
  setSupervisionPaused(store, true);
  expect(status(STARTED_AT_MS + 8_000).supervision).toMatchObject({ state: "paused", paused: true });
});

test("only this run of the brain counts for the Agent and the alerts: events from before it started don't", () => {
  store.recordEvent(context, {
    atMs: STARTED_AT_MS - 10_000,
    kind: "agentConnected",
    detail: { agentSessionId: "old", deploymentId: "d", game },
  });
  store.recordEvent(context, { atMs: STARTED_AT_MS - 9_000, kind: "deployFailed", detail: { reason: "old" } });
  store.recordEvent(context, { atMs: STARTED_AT_MS - 8_000, kind: "versionDrift", detail: { detail: "old" } });
  const built = status(STARTED_AT_MS + 1_000);
  expect(built.agent.connected).toBe(false);
  expect(built.alerts).toEqual([]);
  // They're still in the recent events.
  expect(built.events).toHaveLength(3);
});

test("the recent events are the last 50", () => {
  for (let index = 0; index < 60; index++) {
    store.recordEvent(context, {
      atMs: STARTED_AT_MS + index,
      kind: "connectionRejected",
      detail: { reason: "origin", detail: `o${index}` },
    });
  }
  const { events } = status(STARTED_AT_MS + 100);
  expect(events).toHaveLength(50);
  expect(events[0]).toEqual({
    atMs: STARTED_AT_MS + 59,
    kind: "connectionRejected",
    detail: { reason: "origin", detail: "o59" },
  });
});
