// The lockstep driver: a real ControlChannel and store against a simulation, with the brain's clock on virtual time.
// The same seed and step size give the same stored rows, whatever real time anything takes.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { useSimulations } from "@bitburner-agent/sim/test-helpers";
import { afterAll, expect, test } from "vitest";
import { recordChannelEvents } from "../src/record-channel-events.ts";
import { SimulatedGame, VirtualBrainClock } from "../src/simulated-game.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const start = useSimulations();
const CONTROL_URL = "ws://127.0.0.1:12526";
const TOKEN = "a".repeat(64);
const EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * A stand-in Agent: says hello, then sends a fast snapshot every 2 s once welcomed. Its names avoid NS function names
 * (the game charges RAM by name).
 */
const STUB_AGENT = `export async function main(ns) {
  const socket = new WebSocket("${CONTROL_URL}");
  let sequence = 0;
  socket.onopen = () => socket.send(JSON.stringify({
    protocolVersion: 1, type: "hello", token: "${TOKEN}", deploymentId: "deployment-a", agentSessionId: "session-1",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
  }));
  socket.onmessage = (event) => {
    if (JSON.parse(event.data).type !== "welcome") return;
    setInterval(() => socket.send(JSON.stringify({
      protocolVersion: 1, type: "snapshot", agentSessionId: "session-1", tier: "fast",
      sequenceNumber: ++sequence, gameTimeMs: Date.now(), data: { sequence },
    })), 2000);
  };
  for (;;) await ns.asleep(60_000);
}`;

test("the brain's virtual clock fires timers in due order, each at its own time, ties in creation order", () => {
  const clock = new VirtualBrainClock(1_000);
  const fired: string[] = [];
  const record = (label: string) => () => fired.push(`${label}@${clock.now()}`);
  clock.setTimeout(record("late"), 300);
  clock.setTimeout(record("early"), 100);
  clock.setTimeout(record("tie-first"), 200);
  clock.setTimeout(record("tie-second"), 200);
  const cancelled = clock.setTimeout(record("cancelled"), 150);
  clock.clearTimeout(cancelled);
  // A timer set by a timer, still within the range, fires in the same advance.
  clock.setTimeout(() => clock.setTimeout(record("chained"), 50), 120);
  clock.advanceTo(1_250);
  expect(fired).toEqual(["early@1100", "chained@1170", "tie-first@1200", "tie-second@1200"]);
  expect(clock.now()).toBe(1_250);
  clock.advanceTo(1_400);
  expect(fired.at(-1)).toBe("late@1300");
});

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** Runs the stub Agent against a brain on the driver for `durationMs`, and returns what the brain stored. */
async function runBrainAgainstSimulation({
  seed,
  stepMs,
  durationMs,
  realDelayPerEventMs = 0,
}: {
  seed: number;
  stepMs: number;
  durationMs: number;
  realDelayPerEventMs?: number;
}) {
  const simulation = await start({
    seed,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs });
  const directory = mkdtempSync(path.join(os.tmpdir(), "simulated-brain-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const channel = new ControlChannel({ token: TOKEN, clock: game.clock });
  recordChannelEvents(channel, store, { environment: "E1", brainRelease: "test" });
  if (realDelayPerEventMs > 0) {
    channel.subscribe(() => {
      const until = performance.now() + realDelayPerEventMs;
      while (performance.now() < until) {
        // A slow brain, in real time: it mustn't change anything virtual.
      }
    });
  }
  game.listen(CONTROL_URL, (connection) => channel.accept(connection));
  await simulation.writeFile("home", "stub-agent.js", STUB_AGENT);
  expect((await simulation.run("home", "stub-agent.js")).error).toBeUndefined();
  await game.run(durationMs);
  const rows = { snapshots: store.snapshots({ environment: "E1" }), events: store.events({ environment: "E1" }) };
  store.close();
  return rows;
}

test("the brain stores the Agent's snapshots, stamped with virtual time", async () => {
  const { snapshots, events } = await runBrainAgainstSimulation({ seed: 1, stepMs: 100, durationMs: 20_000 });
  expect(events.map((event) => event.kind)).toEqual(["agentConnected"]);
  expect(snapshots.length).toBeGreaterThanOrEqual(9);
  expect(snapshots.map((snapshot) => snapshot.sequenceNumber)).toEqual(
    Array.from({ length: snapshots.length }, (_, index) => index + 1),
  );
  for (const snapshot of snapshots) {
    // Received when the page sent it, in virtual time: the game's clock and the brain's agree.
    expect(snapshot.receivedAtMs).toBe(snapshot.gameTimeMs);
    expect(snapshot.receivedAtMs).toBeGreaterThan(EPOCH_MS);
    expect(snapshot.receivedAtMs).toBeLessThan(EPOCH_MS + 20_000 + 100);
  }
});

test("the same seed and step size give identical stored rows, however slow the brain is in real time", async () => {
  const run = { seed: 7, stepMs: 250, durationMs: 15_000 };
  const first = await runBrainAgainstSimulation(run);
  const second = await runBrainAgainstSimulation(run);
  const slow = await runBrainAgainstSimulation({ ...run, realDelayPerEventMs: 20 });
  expect(first.snapshots.length).toBeGreaterThan(5);
  expect(second).toEqual(first);
  expect(slow).toEqual(first);
});

test("the brain's timers run on virtual time: a page that never says hello is timed out after 5 virtual seconds", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 500 });
  const channel = new ControlChannel({ token: TOKEN, clock: game.clock });
  const rejections: { atMs: number; reason: string }[] = [];
  channel.subscribe((event) => {
    if (event.type === "connectionRejected") rejections.push({ atMs: event.atMs, reason: event.reason });
  });
  game.listen(CONTROL_URL, (connection) => channel.accept(connection));
  await simulation.writeFile(
    "home",
    "silent.js",
    `export async function main(ns) { new WebSocket("${CONTROL_URL}"); for (;;) await ns.asleep(60_000); }`,
  );
  await simulation.run("home", "silent.js");
  const connectedAtMs = await simulation.now();
  await game.run(10_000);
  expect(rejections).toHaveLength(1);
  expect(rejections[0]?.reason).toBe("helloTimeout");
  // Accepted when the connect was taken (within the first step), timed out 5 virtual seconds later.
  expect(rejections[0]?.atMs).toBeGreaterThanOrEqual(connectedAtMs + 5_000);
  expect(rejections[0]?.atMs).toBeLessThanOrEqual(connectedAtMs + 5_000 + 500);
});
