// The dashboard's alerts (#93): rules over what the store holds, evaluated whenever status is read. Each turns on and
// off at its edge.
import { describe, expect, test } from "vitest";
import {
  AGENT_SILENT_AFTER_MS,
  type AlertFacts,
  activeAlerts,
  INCOME_STALLED_AFTER_MS,
  INSTALL_NOT_RESTARTED_AFTER_MS,
} from "../src/dashboard/alerts.ts";
import { FACTION_WORK_STALLED_AFTER_MS } from "../src/factions.ts";

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
  backdoorsDue: [],
  factionWorkStall: null,
  augmentationsNotQueued: [],
  installAwaitingRestart: null,
};
const names = (facts: AlertFacts) => activeAlerts(facts).map((alert) => alert.name);

describe("augmentations (#210)", () => {
  test("a purchase not queued: one alert each, since it was bought", () => {
    const alerts = activeAlerts({
      ...quiet,
      augmentationsNotQueued: [
        { augmentation: "BitWire", level: 1, boughtAtMs: 5 },
        { augmentation: "NeuroFlux Governor", level: 3, boughtAtMs: 6 },
      ],
    });
    expect(alerts).toEqual([
      {
        name: "augmentationNotQueued",
        sinceMs: 5,
        detail:
          "BitWire was reported bought, but the faction state's queue doesn't show it: check the Augmentations page",
      },
      {
        name: "augmentationNotQueued",
        sinceMs: 6,
        detail:
          "NeuroFlux Governor (level 3) was reported bought, but the faction state's queue doesn't show it: check the " +
          "Augmentations page",
      },
    ]);
  });

  test("an install not restarted: from 5 minutes after the disconnect, not before", () => {
    const sinceMs = quiet.nowMs - INSTALL_NOT_RESTARTED_AFTER_MS;
    const awaiting = { id: "installAugmentations()", sinceMs };
    // The Agent silent too, at that age: both say so.
    const facts = { ...quiet, lastFastSnapshotAtMs: quiet.nowMs, installAwaitingRestart: awaiting };
    expect(activeAlerts(facts)).toEqual([
      {
        name: "installNotRestarted",
        sinceMs,
        detail:
          "installAugmentations() went out and the Agent disconnected 5 min ago, and no slow snapshot has shown the " +
          "reset: is the game at the Terminal, and did boot.js run?",
      },
    ]);
    expect(names({ ...facts, installAwaitingRestart: { ...awaiting, sinceMs: sinceMs + 1 } })).toEqual([]);
  });

  test("an install reported done that the game didn't reset: at once (#213 re-review)", () => {
    const awaiting = { id: "installAugmentations()", sinceMs: quiet.nowMs - 1, doneNotReset: true };
    expect(activeAlerts({ ...quiet, installAwaitingRestart: awaiting })).toEqual([
      {
        name: "installNotRestarted",
        sinceMs: quiet.nowMs - 1,
        detail:
          "installAugmentations(): install reported done but the game didn't reset: the faction state's queue isn't " +
          "the game's. The install cycle is called off, and no other is chosen until a reset (or the brain restarts): " +
          "check the Augmentations page",
      },
    ]);
  });
});

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

describe("factionWorkStalled (#203): the brain's faction work under half its rate for 10 minutes", () => {
  const NOW = STARTED_AT_MS + 60 * 60_000;
  test("at 10 minutes, not before, saying the faction and for how long", () => {
    const stall = (sinceMs: number) =>
      activeAlerts({
        ...quiet,
        nowMs: NOW,
        lastFastSnapshotAtMs: NOW,
        factionWorkStall: { faction: "CyberSec", sinceMs, lastReadingAtMs: NOW - 30_000 },
      });
    expect(stall(NOW - FACTION_WORK_STALLED_AFTER_MS + 1)).toEqual([]);
    expect(stall(NOW - FACTION_WORK_STALLED_AFTER_MS)).toEqual([
      {
        name: "factionWorkStalled",
        sinceMs: NOW - FACTION_WORK_STALLED_AFTER_MS,
        detail:
          "CyberSec's reputation has risen under half the work's rate for 10 min, with the brain's faction work for " +
          "it: see the Work section's outcome",
      },
    ]);
    expect(activeAlerts({ ...quiet, nowMs: NOW, lastFastSnapshotAtMs: NOW })).toEqual([]);
  });

  test("no reading of its reputation in the window (slow snapshots stopped, or each skipped): says so, not the rate", () => {
    const stall = { faction: "CyberSec", sinceMs: NOW - 11 * 60_000, lastReadingAtMs: NOW - 11 * 60_000 };
    expect(activeAlerts({ ...quiet, nowMs: NOW, lastFastSnapshotAtMs: NOW, factionWorkStall: stall })).toEqual([
      {
        name: "factionWorkStalled",
        sinceMs: NOW - 11 * 60_000,
        detail:
          "no reading of CyberSec's reputation for 11 min, with the brain's faction work for it: no slow snapshot, or " +
          "each one's faction state skipped (see the Factions section)",
      },
    ]);
  });

  test("last in the order, after backdoorOverdue", () => {
    const names = activeAlerts({
      ...quiet,
      nowMs: NOW,
      lastFastSnapshotAtMs: NOW,
      backdoorsDue: [{ hostname: "CSEC", sinceMs: STARTED_AT_MS }],
      factionWorkStall: { faction: "CyberSec", sinceMs: STARTED_AT_MS, lastReadingAtMs: NOW - 30_000 },
    }).map((alert) => alert.name);
    expect(names.slice(-2)).toEqual(["backdoorOverdue", "factionWorkStalled"]);
  });
});

test("factionStateUnread (#197): only once 3 slow snapshots in a row are unread, since the first of them", () => {
  const sinceMs = STARTED_AT_MS + 5_000;
  const unread = (unreadInARow: number, backend: string | null = "ui") => ({
    ...quiet,
    factionState: { sinceMs, unreadInARow, backend, problem: "no game page to read it through" },
  });
  // One or two misses (a dialog flood, the owner acting mid-read): not yet.
  expect(activeAlerts(unread(1))).toEqual([]);
  expect(activeAlerts(unread(2))).toEqual([]);
  expect(activeAlerts(unread(3))).toEqual([
    {
      name: "factionStateUnread",
      sinceMs,
      detail:
        "the faction state couldn't be read in the last 3 slow snapshots in a row (ui): no game page to read it through",
    },
  ]);
  // Not well formed, so no backend.
  expect(activeAlerts(unread(3, null))[0]?.detail).toBe(
    "the faction state couldn't be read in the last 3 slow snapshots in a row: no game page to read it through",
  );
});

test("batcherNotRunning (#211): sent and not running in 3 fast snapshots in a row, not in 2, with its reason", () => {
  const notRunning = { sinceMs: 5_000, inARow: 3, problem: "no room on joesguns" };
  expect(activeAlerts({ ...quiet, batcherNotRunning: notRunning })).toEqual([
    {
      name: "batcherNotRunning",
      sinceMs: 5_000,
      detail:
        "the batcher isn't running, in the last 3 fast snapshots, so nothing hacks the servers the hack loop left to " +
        "it: no room on joesguns",
    },
  ]);
  expect(names({ ...quiet, batcherNotRunning: { ...notRunning, inARow: 2 } })).toEqual([]);
  expect(names({ ...quiet, batcherNotRunning: null })).toEqual([]);
});

test("batcherOutOfStep (#206): its desyncs, late or lost rose lately, with the target and counts; after batcherNotRunning", () => {
  const outOfStep = { sinceMs: 7_000, target: "n00dles", desyncs: 1, late: 2, lost: 0 };
  expect(activeAlerts({ ...quiet, batcherOutOfStep: outOfStep })).toEqual([
    {
      name: "batcherOutOfStep",
      sinceMs: 7_000,
      detail:
        "the batcher is out of step on n00dles: 1 desync, 2 late, 0 lost lately; it stops hacking, prepares the " +
        "target again and goes on, and the run report fails the run",
    },
  ]);
  const notRunning = { sinceMs: 5_000, inARow: 3, problem: "no room on joesguns" };
  expect(names({ ...quiet, batcherNotRunning: notRunning, batcherOutOfStep: outOfStep })).toEqual([
    "batcherNotRunning",
    "batcherOutOfStep",
  ]);
  expect(names({ ...quiet, batcherOutOfStep: null })).toEqual([]);
});

describe("cloudServerProblem (#194): a cloud purchase the Agent reported done with a problem", () => {
  const problem = "buyServer(pserv-0, 64): bought as pserv-0-0: a server off the network held pserv-0";

  test("holds while the controller has one noted, saying what and how to go on", () => {
    expect(activeAlerts({ ...quiet, cloudServerProblem: problem })).toEqual([
      {
        name: "cloudServerProblem",
        sinceMs: quiet.nowMs,
        detail:
          "a cloud server purchase went wrong, so the brain buys no more until cloud servers are switched off and " +
          `on: ${problem}`,
      },
    ]);
    expect(names({ ...quiet, cloudServerProblem: null })).toEqual([]);
  });

  test("in its place in the order: after incomeStalled, before intentStuck", () => {
    const stuck = { id: "buyTor(Alpha Enterprises)", done: false, tries: 5, problem: null, backend: null };
    const stalled = {
      hackLoopTarget: "zer0",
      income: { money: 1, lastRiseAtMs: quiet.nowMs - INCOME_STALLED_AFTER_MS - 1 },
    };
    expect(names({ ...quiet, ...stalled, cloudServerProblem: problem, intentOutcomes: [stuck] })).toEqual([
      "incomeStalled",
      "cloudServerProblem",
      "intentStuck",
    ]);
  });
});

describe("messageRefused (#194's review): the Agent refused the brain's last message", () => {
  test("holds while the newest fast snapshot says so, with the count and the reason", () => {
    const refusedMessage = { reason: "an intent's hostname isn't valid", count: 3 };
    expect(activeAlerts({ ...quiet, refusedMessage })).toEqual([
      {
        name: "messageRefused",
        sinceMs: quiet.lastFastSnapshotAtMs,
        detail:
          "the Agent refused the brain's message (3 so far), so it acts on the last one it took: an intent's " +
          "hostname isn't valid",
      },
    ]);
    expect(names({ ...quiet, refusedMessage: null })).toEqual([]);
  });

  test("in its place in the order: after cloudServerProblem, before intentStuck", () => {
    const stuck = { id: "buyTor(Alpha Enterprises)", done: false, tries: 5, problem: null, backend: null };
    const refusedMessage = { reason: "x", count: 1 };
    expect(names({ ...quiet, cloudServerProblem: "p", refusedMessage, intentOutcomes: [stuck] })).toEqual([
      "cloudServerProblem",
      "messageRefused",
      "intentStuck",
    ]);
  });
});
