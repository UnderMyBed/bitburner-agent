// The supervisor (#94, architecture §10.2): it launches the game when it isn't running, kills and relaunches it when
// the Agent has gone silent, at most 3 times an hour, and never while paused. It judges by checks and by which heartbeat
// is newest, never by timestamps. Against a fake process table and a hand-moved clock.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManualClock } from "@bitburner-agent/bridge/test-helpers";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readSupervisionSwitch, setSupervisionPaused } from "../src/supervision.ts";
import {
  type GameProcess,
  GRACE_CHECKS,
  LAUNCH_WAIT_CHECKS,
  MAX_FAILED_CHECKS,
  MAX_LAUNCHES_PER_HOUR,
  SILENT_AFTER_CHECKS,
  SUPERVISION_CHECK_INTERVAL_MS,
  Supervisor,
  shouldSupervise,
} from "../src/supervisor.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const context = { environment: "E0" as const, release: "v0.2.0+abc123def456" };
let directory: string;
let store: TelemetryStore;
let clock: ManualClock;
let errors: unknown[];
let supervisor: Supervisor | undefined;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "supervisor-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  clock = new ManualClock(Date.UTC(2026, 9, 26, 12, 0, 0));
  errors = [];
});
afterEach(() => {
  supervisor?.stop();
  supervisor = undefined;
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A process table the test controls. A launched game appears after `appearsAfterChecks` looks (Steam starting). */
class FakeGame implements GameProcess {
  running = false;
  appearsAfterChecks = 0;
  readonly actions: string[] = [];
  /** Throws from these operations, each time, while set. */
  failing = new Set<string>();
  /** Called during isRunning, before it answers: to change things mid-check. */
  duringIsRunning: () => void = () => {};
  #looksUntilItAppears: number | null = null;

  async isRunning(): Promise<boolean> {
    this.#maybeFail("isRunning");
    this.duringIsRunning();
    if (this.#looksUntilItAppears !== null && --this.#looksUntilItAppears <= 0) {
      this.running = true;
      this.#looksUntilItAppears = null;
    }
    return this.running;
  }

  async launch(): Promise<void> {
    this.#maybeFail("launch");
    this.actions.push("launch");
    if (this.appearsAfterChecks === 0) this.running = true;
    else this.#looksUntilItAppears = this.appearsAfterChecks;
  }

  async kill(): Promise<void> {
    this.actions.push("kill");
    this.running = false;
    this.#maybeFail("kill");
  }

  #maybeFail(operation: string): void {
    if (this.failing.has(operation)) throw new Error(`${operation} failed: no such program`);
  }
}

function startSupervisor(game: FakeGame): void {
  supervisor = new Supervisor({ gameProcess: game, store, context, clock, onError: (error) => errors.push(error) });
}

let heartbeatNumber = 0;
/** A new fast heartbeat, as the control channel stores it, stamped `receivedAtMs` (now by default). */
function heartbeat(receivedAtMs = clock.now()): void {
  store.recordSnapshot(context, {
    agentSessionId: "s",
    tier: "fast",
    sequenceNumber: ++heartbeatNumber,
    gameTimeMs: receivedAtMs,
    receivedAtMs,
    missedBefore: 0,
    // A full home: no worker data, but still the heartbeat.
    data: { degradedTiers: ["fast", "medium"], pageHeapUsedBytes: null, game: null },
  });
}

/** Runs `count` checks, calling `beforeEachCheck` first each time, letting each check's awaits finish. */
async function checks(count: number, beforeEachCheck: () => void = () => {}): Promise<void> {
  for (let check = 0; check < count; check++) {
    beforeEachCheck();
    clock.advance(SUPERVISION_CHECK_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const supervisionEvents = () =>
  store
    .events({ environment: "E0" })
    .filter((event) => ["relaunch", "supervisionGaveUp", "supervisionFailed"].includes(event.kind))
    .map((event) => ({ kind: event.kind, detail: event.detail }));

test("only Steam's game, on Windows, is supervised", () => {
  expect(shouldSupervise("E0", "win32")).toBe(true);
  expect(shouldSupervise("E2", "win32")).toBe(false);
  expect(shouldSupervise("E1", "win32")).toBe(false);
  expect(shouldSupervise("E0", "linux")).toBe(false);
});

test("the checks are 30 s apart: none sooner", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  clock.advance(SUPERVISION_CHECK_INTERVAL_MS - 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(game.actions).toEqual([]);
  clock.advance(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(game.actions).toEqual(["launch"]);
});

test("a game that isn't running is launched at the first check, with the cause recorded", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  await checks(1);
  expect(game.actions).toEqual(["launch"]);
  expect(supervisionEvents()).toEqual([{ kind: "relaunch", detail: { cause: "notRunning" } }]);
});

test("Steam slow to start the game (4 minutes) gets one launch, not a launch every check", async () => {
  const game = new FakeGame();
  game.appearsAfterChecks = 8;
  startSupervisor(game);
  await checks(30, heartbeat);
  expect(game.actions).toEqual(["launch"]);
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
});

test("a launch that never brings the game up is tried again after 5 minutes, and gives up after 3", async () => {
  const game = new FakeGame();
  game.appearsAfterChecks = 1_000;
  startSupervisor(game);
  await checks(1 + LAUNCH_WAIT_CHECKS);
  expect(game.actions).toEqual(["launch"]);
  await checks(1);
  expect(game.actions).toEqual(["launch", "launch"]);
  await checks(2 * (LAUNCH_WAIT_CHECKS + 1));
  expect(game.actions).toEqual(["launch", "launch", "launch"]);
  expect(readSupervisionSwitch(store).gaveUpAtMs).not.toBeNull();
  expect(supervisionEvents().at(-1)).toEqual({
    kind: "supervisionGaveUp",
    detail: { cause: "notRunning", launchesInLastHour: MAX_LAUNCHES_PER_HOUR },
  });
});

test("a running game whose Agent sends heartbeats is left alone, even with no worker data", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await checks(60, heartbeat);
  expect(game.actions).toEqual([]);
});

test("a running game with no new heartbeat for 10 checks is killed and relaunched, after the grace", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await checks(GRACE_CHECKS);
  expect(game.actions).toEqual([]);
  await checks(1);
  expect(game.actions).toEqual(["kill", "launch"]);
  expect(supervisionEvents()).toEqual([{ kind: "relaunch", detail: { cause: "silent" } }]);
});

test("heartbeats that stop, after the grace, make it silent only after 10 checks with none", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await checks(GRACE_CHECKS + 5, heartbeat);
  await checks(SILENT_AFTER_CHECKS - 1);
  expect(game.actions).toEqual([]);
  // The 10th check with nothing new.
  await checks(1);
  expect(game.actions).toEqual(["kill", "launch"]);
});

test("heartbeats stamped with any time count by being new, so a clock that stepped can't fake silence", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  // Each heartbeat stamped an hour behind (a clock since set back), or a day ahead.
  await checks(30, () => heartbeat(clock.now() - 3_600_000));
  await checks(30, () => heartbeat(clock.now() + 86_400_000));
  expect(game.actions).toEqual([]);
});

test("after a relaunch, nothing is done for 5 minutes, then silence counts again after the grace", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  await checks(GRACE_CHECKS + 1);
  expect(game.actions).toEqual(["kill", "launch"]);
  await checks(LAUNCH_WAIT_CHECKS + GRACE_CHECKS);
  expect(game.actions).toEqual(["kill", "launch"]);
  await checks(1);
  expect(game.actions).toEqual(["kill", "launch", "kill", "launch"]);
});

test("resumed after a pause, a game still booting gets a fresh grace before silence counts", async () => {
  const game = new FakeGame();
  game.running = true;
  startSupervisor(game);
  // Half the grace gone, with no heartbeat, when the owner pauses (to restart the game, say).
  await checks(GRACE_CHECKS / 2);
  setSupervisionPaused(store, true);
  await checks(30);
  setSupervisionPaused(store, false);
  // Still no heartbeat: the Agent is booting. A whole grace from the resume.
  await checks(GRACE_CHECKS);
  expect(game.actions).toEqual([]);
});

test("the fourth launch within an hour gives up instead, until resumed; resuming starts afresh", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  // The game dies straight after each launch.
  for (let launch = 0; launch < MAX_LAUNCHES_PER_HOUR; launch++) {
    await checks(1);
    game.running = false;
    await checks(LAUNCH_WAIT_CHECKS);
  }
  expect(game.actions).toEqual(["launch", "launch", "launch"]);
  await checks(1);
  expect(game.actions).toHaveLength(3);
  expect(readSupervisionSwitch(store)).toEqual({ paused: false, gaveUpAtMs: clock.now() });
  await checks(60);
  expect(game.actions).toHaveLength(3);
  setSupervisionPaused(store, false);
  await checks(1);
  expect(game.actions).toHaveLength(4);
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
});

test("launches spread out, never more than 3 in an hour, don't add up to a give-up", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  // Six times: launched, plays for 25 minutes (heartbeats), then dies.
  for (let launch = 0; launch < 6; launch++) {
    await checks(1);
    await checks(50, heartbeat);
    game.running = false;
  }
  expect(game.actions).toEqual(Array(6).fill("launch"));
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
});

test("launches recorded by an earlier run of the brain count toward the hour", async () => {
  for (let launch = 0; launch < MAX_LAUNCHES_PER_HOUR; launch++) {
    store.recordEvent(context, { atMs: clock.now() - 600_000, kind: "relaunch", detail: { cause: "notRunning" } });
  }
  const game = new FakeGame();
  startSupervisor(game);
  await checks(1);
  expect(game.actions).toEqual([]);
  expect(readSupervisionSwitch(store).gaveUpAtMs).not.toBeNull();
});

test("while paused nothing is launched or killed, whatever the game does", async () => {
  const game = new FakeGame();
  setSupervisionPaused(store, true);
  startSupervisor(game);
  await checks(60);
  game.running = true;
  await checks(60);
  expect(game.actions).toEqual([]);
  expect(supervisionEvents()).toEqual([]);
});

test("a pause set while a check is looking stops that check's launch", async () => {
  const game = new FakeGame();
  game.duringIsRunning = () => setSupervisionPaused(store, true);
  startSupervisor(game);
  await checks(1);
  expect(game.actions).toEqual([]);
  expect(supervisionEvents()).toEqual([]);
});

test("a kill that reports failure, with the game gone anyway, still relaunches as silent", async () => {
  const game = new FakeGame();
  game.running = true;
  game.failing.add("kill");
  startSupervisor(game);
  await checks(GRACE_CHECKS + 1);
  expect(game.actions).toEqual(["kill", "launch"]);
  expect(supervisionEvents()).toEqual([{ kind: "relaunch", detail: { cause: "silent" } }]);
});

test("a command that keeps failing is recorded once, and gives up after 10 checks in a row", async () => {
  const game = new FakeGame();
  game.failing.add("launch");
  startSupervisor(game);
  await checks(MAX_FAILED_CHECKS - 1);
  expect(supervisionEvents()).toEqual([
    { kind: "supervisionFailed", detail: { cause: "notRunning", failure: "launch failed: no such program" } },
  ]);
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
  await checks(1);
  expect(readSupervisionSwitch(store).gaveUpAtMs).not.toBeNull();
  expect(supervisionEvents().at(-1)).toEqual({
    kind: "supervisionGaveUp",
    detail: { failedChecksInARow: MAX_FAILED_CHECKS, failure: "launch failed: no such program" },
  });
  // The event and the give-up share one time: the dashboard's alert matches them by it (#127).
  expect(store.events({ environment: "E0" }).at(-1)?.atMs).toBe(readSupervisionSwitch(store).gaveUpAtMs);
});

test("a failure that clears starts the count again", async () => {
  const game = new FakeGame();
  game.failing.add("isRunning");
  startSupervisor(game);
  await checks(MAX_FAILED_CHECKS - 1);
  game.failing.clear();
  game.running = true;
  await checks(1, heartbeat);
  game.failing.add("isRunning");
  await checks(MAX_FAILED_CHECKS - 1);
  expect(readSupervisionSwitch(store).gaveUpAtMs).toBeNull();
  expect(supervisionEvents().filter((event) => event.kind === "supervisionFailed")).toHaveLength(2);
});

test("a switch setting it didn't write is a failed check, recorded, never a crash", async () => {
  store.setSetting("supervision.paused", "yes");
  const game = new FakeGame();
  startSupervisor(game);
  await checks(1);
  expect(game.actions).toEqual([]);
  expect(errors).toEqual([]);
  expect(supervisionEvents()).toEqual([
    {
      kind: "supervisionFailed",
      detail: { cause: null, failure: 'the supervision.paused setting is "yes", not true or false' },
    },
  ]);
});

test("a check still running when the next is due makes that one skip", async () => {
  const game = new FakeGame();
  let release: () => void = () => {};
  let looks = 0;
  game.isRunning = () => {
    looks++;
    return new Promise((resolve) => {
      release = () => resolve(false);
    });
  };
  startSupervisor(game);
  await checks(3);
  expect(looks).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(game.actions).toEqual(["launch"]);
});

test("stopped, it checks no more", async () => {
  const game = new FakeGame();
  startSupervisor(game);
  supervisor?.stop();
  await checks(10);
  expect(game.actions).toEqual([]);
});
