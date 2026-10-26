// The lockstep driver: a real ControlChannel and store against a simulation, with the brain's clock on virtual time.
// The same seed and step size give the same stored rows, whatever real time anything takes.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Connection, ControlChannel } from "@bitburner-agent/bridge";
import type { Simulation } from "@bitburner-agent/sim";
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

test("the virtual clock takes a delay as Node does: under 1 ms or not a number waits 1 ms, so nothing can spin", () => {
  const clock = new VirtualBrainClock(1_000);
  const fired: number[] = [];
  clock.setTimeout(() => fired.push(clock.now()), Number.NaN);
  clock.setTimeout(() => fired.push(clock.now()), -5);
  let rearmed = 0;
  const rearm = () => {
    rearmed++;
    clock.setTimeout(rearm, 0);
  };
  clock.setTimeout(rearm, 0);
  clock.advanceTo(1_010);
  expect(fired).toEqual([1_001, 1_001]);
  expect(clock.now()).toBe(1_010);
  // Once a millisecond, not for ever.
  expect(rearmed).toBe(10);
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

/** A simulation with a brain's ControlChannel on the driver, and every channel event recorded with its time. */
async function gameWithChannel(stepMs: number) {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs });
  const channel = new ControlChannel({ token: TOKEN, clock: game.clock });
  const events: { type: string; atMs: number }[] = [];
  channel.subscribe((event) => events.push({ type: event.type, atMs: event.atMs }));
  game.listen(CONTROL_URL, (connection) => channel.accept(connection));
  return { simulation, game, channel, events };
}

const HELLO = `JSON.stringify({ protocolVersion: 1, type: "hello", token: "${TOKEN}", deploymentId: "deployment-a",
  agentSessionId: "session-1", game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" } })`;

test("a close by the brain is reported once it reaches the page, as a live socket reports it after the handshake", async () => {
  const { simulation, game, channel, events } = await gameWithChannel(100);
  // Says hello twice: the second is a protocol error, so the brain closes the connection (4002).
  await simulation.writeFile(
    "home",
    "twice.js",
    `export async function main(ns) {
       const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => { socket.send(${HELLO}); socket.send(${HELLO}); socket.send(${HELLO}); };
       for (;;) await ns.asleep(60_000);
     }`,
  );
  await simulation.run("home", "twice.js");
  await game.step();
  // The brain has closed it, but the close hasn't reached the page: the Agent still counts as connected, as live.
  expect(events.map((event) => event.type)).toEqual(["agentConnected", "connectionRejected"]);
  expect(channel.connectedAgent()).not.toBeNull();
  await game.step();
  expect(events.map((event) => event.type)).toEqual(["agentConnected", "connectionRejected", "agentDisconnected"]);
  expect(channel.connectedAgent()).toBeNull();
});

test("once the brain has closed a connection, nothing more crosses it either way", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const framesToPage: string[] = [];
  const sendToPage = simulation.network.send.bind(simulation.network);
  simulation.network.send = (connectionId, data) => {
    framesToPage.push(data);
    return sendToPage(connectionId, data);
  };
  const framesFromPage: string[] = [];
  game.listen(CONTROL_URL, (connection) => {
    connection.onMessage((text) => {
      framesFromPage.push(text);
      connection.send("before closing");
      connection.close(4000, "enough");
      connection.send("after closing");
    });
  });
  await simulation.writeFile(
    "home",
    "chatty.js",
    `export async function main(ns) {
       const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => { socket.send("one"); socket.send("two"); };
       for (;;) await ns.asleep(60_000);
     }`,
  );
  await simulation.run("home", "chatty.js");
  await game.run(500);
  expect(framesFromPage).toEqual(["one"]);
  expect(framesToPage).toEqual(["before closing"]);
});

/**
 * Starts a script that connects and sends `frames` once open. It exits at once: its socket outlives it, and a save
 * doesn't bring it back.
 */
async function runSender(simulation: Simulation, scriptName: string, frames: string[]): Promise<void> {
  await simulation.writeFile(
    "home",
    scriptName,
    `export function main(ns) {
       const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => { for (const frame of ${JSON.stringify(frames)}) socket.send(frame); };
     }`,
  );
  expect((await simulation.run("home", scriptName)).error).toBeUndefined();
}

test("a test's fault function decides how many copies of each frame from the page reach the brain", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const offered: { data: string; atMs: number }[] = [];
  const copiesByFrame: Record<string, number> = { dropped: 0, duplicated: 2, once: 1 };
  const game = await SimulatedGame.create({
    simulation,
    stepMs: 100,
    deliveredCopies: ({ data, atMs }) => {
      offered.push({ data, atMs });
      return copiesByFrame[data] as number;
    },
  });
  const received: string[] = [];
  game.listen(CONTROL_URL, (connection) => connection.onMessage((text) => received.push(text)));
  await runSender(simulation, "sender.js", ["dropped", "duplicated", "once"]);
  await game.run(500);
  expect(offered.map((frame) => frame.data)).toEqual(["dropped", "duplicated", "once"]);
  expect(offered[0]?.atMs).toBeGreaterThan(EPOCH_MS);
  expect(received).toEqual(["duplicated", "duplicated", "once"]);
});

test("a fault function's answer must be a whole number of copies, or the step fails", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100, deliveredCopies: () => 0.5 });
  game.listen(CONTROL_URL, () => {});
  await runSender(simulation, "sender.js", ["anything"]);
  await expect(game.run(500)).rejects.toThrow(/whole number of copies, got 0.5/);
});

test("on a reload the old page's sockets close at once, and the steps drive the reloaded simulation", async () => {
  const before = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation: before, stepMs: 100 });
  const received: string[] = [];
  const closedAtMs: number[] = [];
  const connections: Connection[] = [];
  game.listen(CONTROL_URL, (connection) => {
    connections.push(connection);
    connection.onMessage((text) => received.push(text));
    connection.onClose(() => closedAtMs.push(game.clock.now()));
  });
  await runSender(before, "sender.js", ["before the reload"]);
  await game.run(500);
  const after = await start({
    seed: 1,
    fixture: { kind: "save", bytes: await before.save() },
    network: { listenUrls: [CONTROL_URL] },
  });
  const framesToReloadedPage: string[] = [];
  const sendToReloadedPage = after.network.send.bind(after.network);
  after.network.send = (connectionId, data) => {
    framesToReloadedPage.push(data);
    return sendToReloadedPage(connectionId, data);
  };
  // The brain's reply is still queued for the old page when the reload happens: it goes nowhere.
  connections[0]?.send("to the old page");
  const reloadedAtMs = game.clock.now();
  game.replaceSimulation(after);
  expect(closedAtMs).toEqual([reloadedAtMs]);
  await runSender(after, "sender-after.js", ["after the reload"]);
  await game.run(500);
  expect(received).toEqual(["before the reload", "after the reload"]);
  expect(framesToReloadedPage).toEqual([]);
  expect(connections).toHaveLength(2);
  // The brain's clock follows the reloaded game's, but never goes back: the save was taken a moment before the reload.
  const reloadedGameNowMs = await after.now();
  expect(reloadedGameNowMs).toBeLessThan(reloadedAtMs + 500);
  expect(game.clock.now()).toBe(Math.max(reloadedAtMs, reloadedGameNowMs));
});

test("runUntil steps until its condition holds, or fails once over its virtual time", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const startMs = game.clock.now();
  await game.runUntil(() => game.clock.now() >= startMs + 300, 1_000);
  expect(game.clock.now()).toBe(startMs + 300);
  await expect(game.runUntil(() => false, 250)).rejects.toThrow("condition not met within 250 virtual ms");
  // Checked before each step: 300 ms of steps, the first over 250.
  expect(game.clock.now()).toBe(startMs + 600);
});

test("a reload can't happen mid-step", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const stepping = game.step();
  expect(() => game.replaceSimulation(simulation)).toThrow(/mid-step/);
  await stepping;
});

test("a close by the page is reported at the virtual time it happened", async () => {
  const { simulation, game, events } = await gameWithChannel(1_000);
  await simulation.writeFile(
    "home",
    "leaves.js",
    `export async function main(ns) {
       const socket = new WebSocket("${CONTROL_URL}");
       socket.onopen = () => socket.send(${HELLO});
       socket.onmessage = () => setTimeout(() => socket.close(1000, "done"), 250);
       for (;;) await ns.asleep(60_000);
     }`,
  );
  await simulation.run("home", "leaves.js");
  await game.run(5_000);
  const connected = events.find((event) => event.type === "agentConnected");
  const disconnected = events.find((event) => event.type === "agentDisconnected");
  expect(disconnected).toBeDefined();
  // Welcomed at the start of the next step; the page closes 250 virtual ms after that.
  expect((disconnected?.atMs as number) - (connected?.atMs as number)).toBeGreaterThan(250);
  expect((disconnected?.atMs as number) % 1_000).not.toBe(0);
});

test("steps can't overlap, and a socket to a URL nobody listens on fails the step after the whole batch", async () => {
  const simulation = await start({
    seed: 1,
    epochMs: EPOCH_MS,
    fixture: { kind: "new", tutorial: "skipped" },
    network: { listenUrls: [CONTROL_URL] },
  });
  const game = await SimulatedGame.create({ simulation, stepMs: 100 });
  const first = game.step();
  await expect(game.step()).rejects.toThrow(/already running/);
  await first;
  await simulation.writeFile(
    "home",
    "unheard.js",
    `export async function main(ns) { new WebSocket("${CONTROL_URL}"); for (;;) await ns.asleep(60_000); }`,
  );
  await simulation.run("home", "unheard.js");
  await expect(game.step()).rejects.toThrow(/nothing listens on/);
  // The clock still moved to the step's end.
  expect(game.clock.now()).toBe(await simulation.now());
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
