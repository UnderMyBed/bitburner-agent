// The dashboard's alerts (#93): rules over what the store holds, evaluated whenever status is read. Each turns on and
// off at its edge.
import { expect, test } from "vitest";
import { AGENT_SILENT_AFTER_MS, type AlertFacts, activeAlerts } from "../src/dashboard/alerts.ts";

const STARTED_AT_MS = 1_000_000;
const quiet: AlertFacts = {
  nowMs: STARTED_AT_MS + 10_000,
  brainStartedAtMs: STARTED_AT_MS,
  lastFastSnapshotAtMs: STARTED_AT_MS + 9_000,
  versionDrift: null,
  lastDeploy: null,
  supervisionGaveUpAtMs: null,
  intentOutcomes: [],
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
  expect(activeAlerts({ ...quiet, supervisionGaveUpAtMs: STARTED_AT_MS + 4_000 })).toEqual([
    {
      name: "supervisionGaveUp",
      sinceMs: STARTED_AT_MS + 4_000,
      detail: "the supervisor stopped after too many relaunches: unpause supervision to start it again",
    },
  ]);
  expect(names({ ...quiet, supervisionGaveUpAtMs: null })).toEqual([]);
});

test("several at once, in a fixed order", () => {
  expect(
    names({
      ...quiet,
      nowMs: STARTED_AT_MS + 120_000,
      versionDrift: { atMs: STARTED_AT_MS, detail: "x" },
      lastDeploy: { atMs: STARTED_AT_MS, failed: true, detail: "y" },
      supervisionGaveUpAtMs: STARTED_AT_MS,
    }),
  ).toEqual(["agentSilent", "versionDrift", "deployFailed", "supervisionGaveUp"]);
});
