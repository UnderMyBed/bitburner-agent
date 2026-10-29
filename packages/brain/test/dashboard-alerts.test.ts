// The dashboard's alerts (#93): rules over what the store holds, evaluated whenever status is read. Each turns on and
// off at its edge.
import { describe, expect, test } from "vitest";
import {
  AGENT_SILENT_AFTER_MS,
  type AlertFacts,
  activeAlerts,
  INCOME_STALLED_AFTER_MS,
} from "../src/dashboard/alerts.ts";

const STARTED_AT_MS = 1_000_000;
const quiet: AlertFacts = {
  nowMs: STARTED_AT_MS + 10_000,
  brainStartedAtMs: STARTED_AT_MS,
  lastFastSnapshotAtMs: STARTED_AT_MS + 9_000,
  versionDrift: null,
  lastDeploy: null,
  supervisionGaveUp: null,
  intentOutcomes: [],
  blockingDialog: null,
  hackLoopTarget: null,
  income: null,
  factionState: null,
};
const names = (facts: AlertFacts) => activeAlerts(facts).map((alert) => alert.name);

test("with everything well, no alerts", () => {
  expect(activeAlerts(quiet)).toEqual([]);
});

test("agentSilent: no fast snapshot for over 60 s, counted from the brain's start if none came since", () => {
  const lastFastSnapshotAtMs = STARTED_AT_MS + 9_000;
  expect(names({ ...quiet, nowMs: lastFastSnapshotAtMs + AGENT_SILENT_AFTER_MS })).toEqual([]);
  expect(activeAlerts({ ...quiet, nowMs: lastFastSnapshotAtMs + AGENT_SILENT_AFTER_MS + 1 })).toEqual([
    { name: "agentSilent", sinceMs: lastFastSnapshotAtMs, detail: "no fast snapshot for 60 s" },
  ]);
  // The detail says how long, however long.
  expect(activeAlerts({ ...quiet, nowMs: lastFastSnapshotAtMs + 3_600_000 })[0]?.detail).toBe(
    "no fast snapshot for 3600 s",
  );
  // A snapshot from before this brain started doesn't count: the 60 s run from the start.
  const beforeStart = { ...quiet, lastFastSnapshotAtMs: STARTED_AT_MS - 5_000 };
  expect(names({ ...beforeStart, nowMs: STARTED_AT_MS + AGENT_SILENT_AFTER_MS })).toEqual([]);
  expect(activeAlerts({ ...beforeStart, lastFastSnapshotAtMs: null, nowMs: STARTED_AT_MS + 90_000 })).toEqual([
    { name: "agentSilent", sinceMs: STARTED_AT_MS, detail: "no fast snapshot since the brain started, 90 s ago" },
  ]);
});

test("versionDrift: on once the brain has held on another game version since it started", () => {
  const versionDrift = { atMs: STARTED_AT_MS + 2_000, detail: "versionNumber 52, pinned 51" };
  expect(activeAlerts({ ...quiet, versionDrift })).toEqual([
    { name: "versionDrift", sinceMs: versionDrift.atMs, detail: "versionNumber 52, pinned 51" },
  ]);
});

test("deployFailed: on while the last deploy since the brain started failed, off once one succeeds", () => {
  const failed = { atMs: STARTED_AT_MS + 2_000, failed: true, detail: "agent.js needs 4.7 GB" };
  expect(activeAlerts({ ...quiet, lastDeploy: failed })).toEqual([
    { name: "deployFailed", sinceMs: failed.atMs, detail: "agent.js needs 4.7 GB" },
  ]);
  expect(names({ ...quiet, lastDeploy: { atMs: STARTED_AT_MS + 3_000, failed: false, detail: "" } })).toEqual([]);
});

test("supervisionGaveUp: on while the supervisor has given up, off once it's cleared", () => {
  const relaunches = { cause: "silent", launchesInLastHour: 3 };
  expect(activeAlerts({ ...quiet, supervisionGaveUp: { atMs: STARTED_AT_MS + 4_000, detail: relaunches } })).toEqual([
    {
      name: "supervisionGaveUp",
      sinceMs: STARTED_AT_MS + 4_000,
      detail: "the supervisor stopped after 3 launches in an hour: resume supervision to start it again",
    },
  ]);
  expect(names({ ...quiet, supervisionGaveUp: null })).toEqual([]);
});

test("supervisionGaveUp after checks that kept failing (#127) says so, with the last failure", () => {
  const failedChecks = { failedChecksInARow: 10, failure: "tasklist exited with code 1" };
  expect(activeAlerts({ ...quiet, supervisionGaveUp: { atMs: STARTED_AT_MS, detail: failedChecks } })).toEqual([
    {
      name: "supervisionGaveUp",
      sinceMs: STARTED_AT_MS,
      detail:
        "the supervisor stopped after 10 failed checks in a row (the last: tasklist exited with code 1): " +
        "resume supervision to start it again",
    },
  ]);
});

test("supervisionGaveUp with no event recorded with it says the cause wasn't recorded, and where to look", () => {
  for (const detail of [null, {}, { failedChecksInARow: "10" }]) {
    expect(activeAlerts({ ...quiet, supervisionGaveUp: { atMs: STARTED_AT_MS, detail } })[0]?.detail).toBe(
      "the supervisor stopped, but its cause wasn't recorded (too many launches, or checks that kept failing: see " +
        "the brain's log and the supervisionFailed events): resume supervision to start it again",
    );
  }
});

test("several at once, in a fixed order", () => {
  expect(
    names({
      ...quiet,
      nowMs: STARTED_AT_MS + 120_000,
      versionDrift: { atMs: STARTED_AT_MS, detail: "x" },
      lastDeploy: { atMs: STARTED_AT_MS, failed: true, detail: "y" },
      supervisionGaveUp: { atMs: STARTED_AT_MS, detail: null },
    }),
  ).toEqual(["agentSilent", "versionDrift", "deployFailed", "supervisionGaveUp"]);
});

test("a dialog the Agent leaves open (#143) is an alert, quoting its first 200 characters", () => {
  const alerts = activeAlerts({ ...quiet, blockingDialog: `Buy the server?${"x".repeat(500)}` });
  expect(alerts.map((alert) => alert.name)).toEqual(["dialogBlocking"]);
  expect(alerts[0]?.detail).toBe(
    `a dialog the Agent leaves for you is open, so it does nothing on the page: "Buy the server?${"x".repeat(185)}"`,
  );
});

describe("incomeStalled (#184): the hack loop on against a target, and money not risen for over 10 minutes", () => {
  const lastRiseAtMs = STARTED_AT_MS + 60_000;
  const stalled = {
    ...quiet,
    hackLoopTarget: "zer0",
    income: { money: 21_434_097, lastRiseAtMs },
    // The Agent heard from: only the income can be wrong.
    lastFastSnapshotAtMs: lastRiseAtMs + INCOME_STALLED_AFTER_MS + 23 * 60_000,
    nowMs: lastRiseAtMs + INCOME_STALLED_AFTER_MS + 24 * 60_000,
  };

  test("holds after 10 minutes without a rise, saying how long, the money and the target", () => {
    expect(activeAlerts(stalled)).toEqual([
      {
        name: "incomeStalled",
        sinceMs: lastRiseAtMs,
        detail: "money hasn't risen for 34 min, at $21,434,097, with the hack loop on against zer0",
      },
    ]);
    // Over 10 minutes, not at them.
    const atTheEdge = lastRiseAtMs + INCOME_STALLED_AFTER_MS;
    expect(names({ ...stalled, lastFastSnapshotAtMs: atTheEdge, nowMs: atTheEdge })).toEqual([]);
    expect(names({ ...stalled, lastFastSnapshotAtMs: atTheEdge, nowMs: atTheEdge + 1 })).toEqual(["incomeStalled"]);
  });

  test("not while the hack loop is off or has no target, nor before the money is known", () => {
    expect(names({ ...stalled, hackLoopTarget: null })).toEqual([]);
    expect(names({ ...stalled, income: null })).toEqual([]);
  });

  test("in its place in the order: after dialogBlocking, before intentStuck", () => {
    const stuck = { id: "buyTor(Alpha Enterprises)", done: false, tries: 5, problem: null, backend: null };
    expect(names({ ...stalled, blockingDialog: "x", intentOutcomes: [stuck] })).toEqual([
      "dialogBlocking",
      "incomeStalled",
      "intentStuck",
    ]);
  });
});

test("factionStateUnread (#197): while the newest slow snapshot's faction state couldn't be read, since it came", () => {
  const atMs = STARTED_AT_MS + 5_000;
  expect(
    activeAlerts({ ...quiet, factionState: { atMs, backend: "ui", problem: "no game page to read it through" } }),
  ).toEqual([
    {
      name: "factionStateUnread",
      sinceMs: atMs,
      detail: "the faction state couldn't be read (ui): no game page to read it through",
    },
  ]);
  // No reading at all, so no backend.
  expect(
    activeAlerts({ ...quiet, factionState: { atMs, backend: null, problem: "the slow snapshot carries none" } })[0]
      ?.detail,
  ).toBe("the faction state couldn't be read: the slow snapshot carries none");
});
