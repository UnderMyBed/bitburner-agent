// The dashboard's status (#93), built from a store fixture: the Agent, the last snapshot per tier, key values, gaps
// over 24 h, alerts, recent events and supervision.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { INCOME_STALLED_AFTER_MS, type IncomeFacts } from "../src/dashboard/alerts.ts";
import { BRAIN_STARTED_EVENT_KIND, buildDashboardStatus } from "../src/dashboard/status.ts";
import type { CloudServersView, HackLoopView, HomeRamView, IntentView, ProgramsView } from "../src/desired-state.ts";
import { RELAUNCH_EVENT_KIND, recordSupervisionGaveUp, setSupervisionPaused } from "../src/supervision.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const STARTED_AT_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY_MS = 24 * 60 * 60_000;
const context = { environment: "E0" as const, release: "v0.2.0+abc123def456" };
// What Steam's v3.0.1 reports: upstream's tag commit, not the pinned stable one (the same source, #128).
const game = { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" };
let directory: string;
let store: TelemetryStore;
let brainStartedEventId: number;
/** What the hack loop's controller shows (#134): the status passes it on as it is. */
const hackLoop: HackLoopView = {
  enabled: true,
  waiting: false,
  target: "n00dles",
  hosts: ["foodnstuff", "n00dles"],
  hackThreads: null,
  preparing: null,
};
const programs: ProgramsView = {
  enabled: true,
  waiting: false,
  owned: ["TOR router"],
  buying: "BruteSSH.exe",
  waitingFor: null,
};
const homeRam: HomeRamView = { enabled: true, waiting: false, ram: 8, upgradingTo: 16, waitingFor: null };
const cloudServers: CloudServersView = {
  enabled: true,
  waiting: false,
  servers: [{ hostname: "pserv-0", ram: 64 }],
  buying: null,
  waitingFor: null,
  problem: null,
};
const intents: IntentView[] = [{ id: "travel(Aevum)", source: "manual", outcome: null, waitingFor: null }];
/** The brain starting, as main.ts records it: everything stored after this is this run. */
const brainStarts = () => {
  brainStartedEventId = store.recordEvent(context, { atMs: STARTED_AT_MS, kind: BRAIN_STARTED_EVENT_KIND, detail: {} });
};
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dashboard-status-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  brainStarts();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const status = (
  nowMs: number,
  {
    income = null,
    loop = hackLoop,
    cloud = cloudServers,
  }: { income?: IncomeFacts | null; loop?: HackLoopView; cloud?: CloudServersView } = {},
) =>
  buildDashboardStatus({
    store,
    environment: "E0",
    brainRelease: "v0.2.0",
    brainStartedAtMs: STARTED_AT_MS,
    brainStartedEventId,
    supervising: true,
    hackLoop: loop,
    programs,
    homeRam,
    cloudServers: cloud,
    intents,
    work: { desired: null, outcome: null },
    income,
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
  intents: [],
  dialogs: { handled: [], blocking: null },
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
    hasTorRouter: false,
    programs: [],
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
    hackLoop,
    programs,
    homeRam,
    cloudServers,
    intents,
    work: { desired: null, outcome: null },
  });
  // Newest first.
  expect(built.events.map((event) => event.kind)).toEqual(["agentConnected", "deployed", "brainStarted"]);
});

test("incomeStalled (#184): from the income watch's facts, while the hack loop is on against a target", () => {
  const nowMs = STARTED_AT_MS + 30 * 60_000;
  // The Agent heard from, so only the income alert can hold.
  recordSnapshot("fast", nowMs - 1_000, fastData(1));
  const income = { money: 21_434_097, lastRiseAtMs: nowMs - INCOME_STALLED_AFTER_MS - 60_000 };
  expect(status(nowMs, { income }).alerts).toEqual([
    {
      name: "incomeStalled",
      sinceMs: income.lastRiseAtMs,
      detail: "money hasn't risen for 11 min, at $21,434,097, with the hack loop on against n00dles",
    },
  ]);
  // Off, it isn't expected to earn.
  const off = { ...hackLoop, enabled: false, target: null, hosts: [] };
  expect(status(nowMs, { income, loop: off }).alerts).toEqual([]);
});

test("cloudServerProblem (#194): from the controller's view of cloud servers, while it has a problem noted", () => {
  const nowMs = STARTED_AT_MS + 30 * 60_000;
  recordSnapshot("fast", nowMs - 1_000, fastData(1));
  const problem = "buyServer(pserv-0, 64): bought as pserv-0-0: a server off the network held pserv-0";
  expect(status(nowMs, { cloud: { ...cloudServers, problem } }).alerts).toMatchObject([
    { name: "cloudServerProblem", sinceMs: nowMs, detail: expect.stringContaining(problem) },
  ]);
  expect(status(nowMs).alerts).toEqual([]);
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
  expect(gaps).toMatchObject({
    sinceMs: nowMs - DAY_MS,
    untilMs: nowMs,
    thresholdMs: 6_000,
    count: 252,
    gapCount: 2,
    totalGapMs: DAY_MS - 600_000 + 100_000,
  });
  // Newest first.
  expect(gaps.newestGaps).toEqual([
    { fromMs: tenMinutesAgoMs + 300_000, toMs: tenMinutesAgoMs + 400_000, lengthMs: 100_000 },
    { fromMs: nowMs - DAY_MS, toMs: tenMinutesAgoMs, lengthMs: DAY_MS - 600_000 },
  ]);
});

test("the gaps are all counted, but only the newest 20 are listed", () => {
  const nowMs = STARTED_AT_MS + DAY_MS;
  // A heartbeat every 10 s for 5 minutes: each interval is a gap.
  for (let second = 300; second >= 0; second -= 10) recordSnapshot("fast", nowMs - second * 1000, fastData(1));
  const { gaps } = status(nowMs);
  // 30 intervals of 10 s, and the window's start to the first heartbeat.
  expect(gaps.gapCount).toBe(31);
  expect(gaps.newestGaps).toHaveLength(20);
  expect(gaps.newestGaps[0]).toEqual({ fromMs: nowMs - 10_000, toMs: nowMs, lengthMs: 10_000 });
});

test("a deploy that failed is resolved by a later connection finding the deployment already in place", () => {
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "deployFailed",
    detail: { deploymentId: "d", reason: "pushFile agent/current.txt: no reply within 30 s" },
  });
  expect(status(STARTED_AT_MS + 2_000).alerts.map((alert) => alert.name)).toEqual(["deployFailed"]);
  store.recordEvent(context, { atMs: STARTED_AT_MS + 3_000, kind: "deploymentCurrent", detail: { deploymentId: "d" } });
  expect(status(STARTED_AT_MS + 4_000).alerts).toEqual([]);
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
    detail: { agentSessionId: "s", deploymentId: "d", game: { ...game, versionNumber: 52 } },
  });
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "versionDrift",
    detail: { detail: "the Agent's game: versionNumber 52, pinned 51" },
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
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 5_000,
    kind: RELAUNCH_EVENT_KIND,
    detail: { cause: "notRunning" },
  });
  recordSupervisionGaveUp(store, STARTED_AT_MS + 6_000);
  // The give-up's cause is in its event (#127): here, checks that kept failing.
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 6_000,
    kind: "supervisionGaveUp",
    detail: { failedChecksInARow: 10, failure: "launch failed" },
  });
  const built = status(STARTED_AT_MS + 7_000);
  expect(built.agent).toMatchObject({ connected: false, sinceMs: STARTED_AT_MS + 3_000, agentSessionId: "s" });
  expect(built.alerts).toEqual([
    { name: "versionDrift", sinceMs: STARTED_AT_MS + 1_000, detail: "the Agent's game: versionNumber 52, pinned 51" },
    { name: "deployFailed", sinceMs: STARTED_AT_MS + 4_000, detail: "agent.js needs 4.7 GB, over its budget of 3 GB" },
    {
      name: "supervisionGaveUp",
      sinceMs: STARTED_AT_MS + 6_000,
      detail: expect.stringContaining("after 10 failed checks in a row (the last: launch failed)"),
    },
  ]);
  expect(built.supervision).toEqual({
    state: "gaveUp",
    paused: false,
    gaveUpAtMs: STARTED_AT_MS + 6_000,
    relaunches: [{ atMs: STARTED_AT_MS + 5_000, detail: { cause: "notRunning" } }],
  });
  setSupervisionPaused(store, true);
  expect(status(STARTED_AT_MS + 8_000).supervision).toMatchObject({ state: "paused", paused: true });
});

test("a give-up whose own event is missing doesn't take an older give-up's cause (#127)", () => {
  // An earlier give-up, since resumed, then one whose event wasn't recorded (the store failed, say).
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 1_000,
    kind: "supervisionGaveUp",
    detail: { cause: "silent", launchesInLastHour: 3 },
  });
  recordSupervisionGaveUp(store, STARTED_AT_MS + 2_000);
  expect(status(STARTED_AT_MS + 3_000).alerts.find((alert) => alert.name === "supervisionGaveUp")?.detail).toBe(
    "the supervisor stopped, but its cause wasn't recorded (too many launches, or checks that kept failing: see " +
      "the brain's log and the supervisionFailed events): resume supervision to start it again",
  );
});

test("only this run of the brain counts for the Agent and the alerts, by order, whatever the clock says", () => {
  // An earlier run, its events stamped later than this run's start (a clock since set back).
  store.recordEvent(context, {
    atMs: STARTED_AT_MS + 10_000,
    kind: "agentConnected",
    detail: { agentSessionId: "old", deploymentId: "d", game },
  });
  store.recordEvent(context, { atMs: STARTED_AT_MS + 11_000, kind: "deployFailed", detail: { reason: "old" } });
  store.recordEvent(context, { atMs: STARTED_AT_MS + 12_000, kind: "versionDrift", detail: { detail: "old" } });
  brainStarts();
  const built = status(STARTED_AT_MS + 1_000);
  expect(built.agent.connected).toBe(false);
  expect(built.alerts).toEqual([]);
  // They're still in the recent events: both starts and the three between.
  expect(built.events).toHaveLength(5);
});

test("a brain that doesn't supervise (not Steam's, or not on Windows) shows supervision off, paused or not", () => {
  setSupervisionPaused(store, true);
  const built = buildDashboardStatus({
    store,
    environment: "E0",
    brainRelease: "v0.2.0",
    brainStartedAtMs: STARTED_AT_MS,
    brainStartedEventId,
    supervising: false,
    hackLoop,
    programs,
    homeRam,
    cloudServers,
    intents,
    work: { desired: null, outcome: null },
    income: null,
    nowMs: STARTED_AT_MS + 1_000,
  });
  expect(built.supervision).toMatchObject({ state: "off", paused: true });
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

test("an intent tried 5 times and still not done is an alert (#141); fewer tries, or done, isn't", () => {
  const outcome = (id: string, tries: number, done = false) => ({
    id,
    done,
    tries,
    problem: "no Travel in the sidebar",
  });
  recordSnapshot("fast", STARTED_AT_MS + 2_000, {
    ...fastData(1),
    intents: [outcome("travel(Aevum)", 5), outcome("travel(Ishima)", 4), outcome("buyTor(CompuTek)", 9, true)],
  });
  expect(status(STARTED_AT_MS + 3_000).alerts).toEqual([
    {
      name: "intentStuck",
      sinceMs: STARTED_AT_MS + 2_000,
      detail: "travel(Aevum): 5 tries, not done: no Travel in the sidebar",
    },
  ]);
});

test("a dialog left open in the newest fast snapshot (#143) is the dialogBlocking alert", () => {
  recordSnapshot("fast", STARTED_AT_MS + 2_000, {
    ...fastData(1),
    dialogs: { handled: [], blocking: "Would you like to travel to Aevum?" },
  });
  expect(status(STARTED_AT_MS + 3_000).alerts).toMatchObject([
    { name: "dialogBlocking", sinceMs: STARTED_AT_MS + 2_000, detail: expect.stringContaining("travel to Aevum") },
  ]);
});
