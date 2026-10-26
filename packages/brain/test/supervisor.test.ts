// The supervisor (#94, architecture §10.2): it launches the game when it isn't running, kills and relaunches it when
// the Agent has gone silent, at most 3 times an hour, and never while paused. Against a fake process table and a
// hand-moved clock.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManualClock } from "@bitburner-agent/bridge/test-helpers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSupervisionSwitch, setSupervisionPaused } from "../src/supervision.ts";
import {
  type GameProcess,
  MAX_RELAUNCHES_PER_HOUR,
  SUPERVISION_CHECK_INTERVAL_MS,
  SUPERVISION_GRACE_MS,
  SUPERVISION_SILENT_AFTER_MS,
  Supervisor,
} from "../src/supervisor.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const context = { environment: "E0" as const, release: "v0.2.0+abc123def456" };
const MINUTE_MS = 60_000;
let directory: string;
let store: TelemetryStore;
let clock: ManualClock;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "supervisor-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  clock = new ManualClock(Date.UTC(2026, 9, 26, 12, 0, 0));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A process table the test controls: launching starts the game, killing stops it. */
class FakeGame implements GameProcess {
  running = false;
  readonly actions: string[] = [];
  failNext: string | null = null;

  async isRunning(): Promise<boolean> {
    this.#maybeFail("isRunning");
    return this.running;
  }

  async launch(): Promise<void> {
    this.#maybeFail("launch");
    this.actions.push("launch");
    this.running = true;
  }

  async kill(): Promise<void> {
    this.#maybeFail("kill");
    this.actions.push("kill");
    this.running = false;
  }

  #maybeFail(action: string): void {
    if (this.failNext !== action) return;
    this.failNext = null;
    throw new Error(`${action} failed: no such program`);
  }
}

function startSupervisor(game: FakeGame) {
  const supervisor = new Supervisor({ gameProcess: game, store, context, clock });
  return supervisor;
}

/** The fast heartbeat arriving now, as the control channel stores it. */
function heartbeat(): void {
  store.recordSnapshot(context, {
    agentSessionId: "s",
    tier: "fast",
    sequenceNumber: clock.now(),
    gameTimeMs: clock.now(),
    receivedAtMs: clock.now(),
    missedBefore: 0,
    // A full home: no worker data, but still the heartbeat.
    data: { degradedTiers: ["fast", "medium"], pageHeapUsedBytes: null, game: null },
  });
}

/** Moves the clock on in check intervals, letting each check's awaits finish. */
async function runFor(durationMs: number, everyCheck: () => void = () => {}): Promise<void> {
  for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += SUPERVISION_CHECK_INTERVAL_MS) {
    everyCheck();
    clock.advance(SUPERVISION_CHECK_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const supervisionEvents = () =>
  store
    .events({ environment: "E0" })
    .filter((event) => ["relaunch", "supervisionGaveUp", "supervisionFailed"].includes(event.kind))
    .map((event) => ({ kind: event.kind, detail: event.detail }));

test("a game that isn't running is launched, at the first check, with the cause recorded", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual(["launch"]);
  expect(supervisionEvents()).toEqual([{ kind: "relaunch", detail: { cause: "notRunning" } }]);
});

test("a running game whose Agent sends heartbeats is left alone, even with no worker data", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await runFor(30 * MINUTE_MS, heartbeat);
  expect(game.actions).toEqual([]);
});

test("a running game silent for 5 minutes is killed and relaunched, but not within the grace after the brain starts", async () => {
  const game = new FakeGame();
  game.running = true;
  heartbeat();
  startSupervisor(game);
  // Silent from the start, but the grace (5 minutes) comes first.
  await runFor(SUPERVISION_GRACE_MS - SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual([]);
  await runFor(2 * SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual(["kill", "launch"]);
  expect(supervisionEvents()).toEqual([{ kind: "relaunch", detail: { cause: "silent" } }]);
});

test("after a relaunch the game gets its grace again before the next silence check", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await runFor(SUPERVISION_GRACE_MS + SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual(["kill", "launch"]);
  // Still silent: nothing more until the grace after that launch has passed.
  await runFor(SUPERVISION_GRACE_MS - 2 * SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual(["kill", "launch"]);
  await runFor(SUPERVISION_SILENT_AFTER_MS);
  expect(game.actions).toEqual(["kill", "launch", "kill", "launch"]);
});

test("a fourth relaunch within an hour gives up instead, with an alert, until supervision is resumed", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  // The game dies straight after each launch.
  for (let launch = 0; launch < MAX_RELAUNCHES_PER_HOUR; launch++) {
    await runFor(SUPERVISION_CHECK_INTERVAL_MS);
    game.running = false;
  }
  expect(game.actions).toEqual(["launch", "launch", "launch"]);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toHaveLength(3);
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: clock.now() });
  expect(supervisionEvents().at(-1)).toEqual({
    kind: "supervisionGaveUp",
    detail: { relaunchesInLastHour: MAX_RELAUNCHES_PER_HOUR },
  });
  // Given up: nothing more, however long.
  await runFor(30 * MINUTE_MS);
  expect(game.actions).toHaveLength(3);
  // Resumed from the dashboard: it starts afresh, the relaunches before the give-up no longer counted.
  setSupervisionPaused(store, false);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toHaveLength(4);
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
});

test("relaunches spread out, never more than 3 in an hour, don't add up to a give-up", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  // Six times: launched, plays for 25 minutes (heartbeats), then dies.
  for (let launch = 0; launch < 6; launch++) {
    await runFor(SUPERVISION_CHECK_INTERVAL_MS);
    await runFor(25 * MINUTE_MS, heartbeat);
    game.running = false;
  }
  expect(game.actions).toEqual(Array(6).fill("launch"));
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
});

test("while paused nothing is launched or killed, whatever the game does", async () => {
  const game = new FakeGame();
  setSupervisionPaused(store, true);
  startSupervisor(game);
  await runFor(30 * MINUTE_MS);
  game.running = true;
  await runFor(30 * MINUTE_MS);
  expect(game.actions).toEqual([]);
  expect(supervisionEvents()).toEqual([]);
});

test("a process command that fails is recorded, and the next check tries again", async () => {
  const game = new FakeGame();
  game.failNext = "launch";
  startSupervisor(game);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(supervisionEvents()).toEqual([
    { kind: "supervisionFailed", detail: { cause: "notRunning", failure: "launch failed: no such program" } },
  ]);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual(["launch"]);
});

test("relaunches recorded by an earlier run of the brain count toward the hour", async () => {
  for (let launch = 0; launch < MAX_RELAUNCHES_PER_HOUR; launch++) {
    store.recordEvent(context, {
      atMs: clock.now() - 10 * MINUTE_MS,
      kind: "relaunch",
      detail: { cause: "notRunning" },
    });
  }
  const game = new FakeGame();
  startSupervisor(game);
  await runFor(SUPERVISION_CHECK_INTERVAL_MS);
  expect(game.actions).toEqual([]);
  expect(readSupervisionSwitch(store).gaveUpAtMs).not.toBeNull();
});
