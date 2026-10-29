import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Clock, type Connection, ControlChannel, EventListeners } from "@bitburner-agent/bridge";
import { CONTROL_PROTOCOL_VERSION, encodeControlMessage } from "@bitburner-agent/core";
import { afterEach, expect, test } from "vitest";
import { brainChannel, recordChannelEvents, recordEvents } from "../src/record-channel-events.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const TOKEN = "a".repeat(64);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixedClock: Clock = { now: () => 1_000, setTimeout: () => 0, clearTimeout: () => {} };

/** A connection the test drives by hand. */
function connectionFromTest() {
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const connection: Connection = {
    send: () => {},
    close: () => {
      for (const listener of closeListeners) listener();
    },
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
  };
  return {
    connection,
    receive: (text: string) => {
      for (const listener of messageListeners) listener(text);
    },
    drop: () => connection.close(1006, ""),
  };
}

test("each row's release is the brain's plus the connected Agent's deployment, or none while no Agent is", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const channel = new ControlChannel({ token: TOKEN, clock: fixedClock });
  recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0" });

  const page = connectionFromTest();
  channel.accept(page.connection);
  page.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: "session-1",
      game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    }),
  );
  page.drop();
  channel.reportRejectedOrigin("https://example.com");

  expect(store.events({ environment: "E2" }).map(({ kind, release }) => [kind, release])).toEqual([
    ["agentConnected", "v0.2.0+deployment-a"],
    ["agentDisconnected", "v0.2.0+deployment-a"],
    ["connectionRejected", "v0.2.0+none"],
  ]);
  store.close();
});

test("the game's dialogs the Agent handled (#143) are stored as gameDialog events, well-formed ones only", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const channel = new ControlChannel({ token: TOKEN, clock: fixedClock });
  recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0" });
  const page = connectionFromTest();
  channel.accept(page.connection);
  const message = (type: string, fields: object) =>
    page.receive(encodeControlMessage({ protocolVersion: CONTROL_PROTOCOL_VERSION, type, ...fields } as never));
  message("hello", {
    token: TOKEN,
    deploymentId: "deployment-a",
    agentSessionId: "session-1",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
  });
  const handled = [
    { kind: "alert", text: "Offline for 5 minutes." },
    { kind: "factionInvitation", text: "You received a faction invitation." },
    { kind: "rm -rf", text: "not a kind the Agent reports" },
    { kind: "alert", text: "x".repeat(5_000) },
  ];
  message("snapshot", {
    agentSessionId: "session-1",
    tier: "fast",
    sequenceNumber: 1,
    gameTimeMs: 1_000,
    data: { degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: [], dialogs: { handled, blocking: null } },
  });
  const dialogs = store.events({ environment: "E2" }).filter((event) => event.kind === "gameDialog");
  expect(dialogs.map((event) => event.detail)).toEqual([
    { kind: "alert", text: "Offline for 5 minutes." },
    { kind: "factionInvitation", text: "You received a faction invitation." },
    { kind: "alert", text: "x".repeat(1_000) },
  ]);
  store.close();
});

test("after a brain restart, the same session's next snapshots don't count stored ones as missed (#119)", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const hello = encodeControlMessage({
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    type: "hello",
    token: TOKEN,
    deploymentId: "deployment-a",
    agentSessionId: "session-1",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
  });
  const snapshot = (sequenceNumber: number) =>
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "snapshot",
      agentSessionId: "session-1",
      tier: "fast",
      sequenceNumber,
      gameTimeMs: sequenceNumber,
      data: null,
    });
  /** A brain's channel, as main.ts makes it, with the Agent connected and sending `sequenceNumbers`. */
  const brainRun = (sequenceNumbers: number[]) => {
    const channel = brainChannel({ token: TOKEN, clock: fixedClock, store, environment: "E2" });
    recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0" });
    const page = connectionFromTest();
    channel.accept(page.connection);
    page.receive(hello);
    for (const sequenceNumber of sequenceNumbers) page.receive(snapshot(sequenceNumber));
  };
  brainRun([1, 2, 3]);
  // The brain restarts; the same Agent reconnects, sending one it may have sent already, then the next.
  brainRun([3, 4]);
  expect(store.snapshots({ environment: "E2" }).map((row) => [row.sequenceNumber, row.missedBefore])).toEqual([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
  ]);
  store.close();
});

test("a part's events are stored with their time, kind and the rest as detail, until stopped", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const source = new EventListeners<{ type: "saveBackup"; atMs: number; file: string }>();
  const stop = recordEvents(source, store, { environment: "E0", release: "v0.2.0+abc" });
  source.emit({ type: "saveBackup", atMs: 5, file: "saves/E0/x.json.gz" });
  stop();
  source.emit({ type: "saveBackup", atMs: 6, file: "after stopping" });
  expect(store.events({ environment: "E0" })).toEqual([
    { environment: "E0", release: "v0.2.0+abc", atMs: 5, kind: "saveBackup", detail: { file: "saves/E0/x.json.gz" } },
  ]);
  store.close();
});

test("a promotion the Agent took (#155): a workPromotion event and a log line, once, after a brain restart too", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const lines: string[] = [];
  const promotion = { company: "Carmichael Security", from: "IT Intern", to: "IT Analyst", gameTimeMs: 5_000 };
  /** A brain's run, the Agent connected and sending fast snapshots whose work reports `promotions`, in turn. */
  const brainRun = (session: string, promotions: unknown[]) => {
    const channel = new ControlChannel({ token: TOKEN, clock: fixedClock });
    recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0", log: (line) => lines.push(line) });
    const page = connectionFromTest();
    channel.accept(page.connection);
    const message = (type: string, fields: object) =>
      page.receive(encodeControlMessage({ protocolVersion: CONTROL_PROTOCOL_VERSION, type, ...fields } as never));
    message("hello", {
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: session,
      game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    });
    for (const [index, each] of promotions.entries()) {
      message("snapshot", {
        agentSessionId: session,
        tier: "fast",
        sequenceNumber: index + 1,
        gameTimeMs: 1_000,
        data: {
          degradedTiers: [],
          pageHeapUsedBytes: null,
          game: null,
          intents: [],
          dialogs: { handled: [], blocking: null },
          work: { converged: true, problem: null, backend: "ui", ...(each === undefined ? {} : { promotion: each }) },
        },
      });
    }
  };
  // None, then the same promotion snapshot after snapshot, and one that isn't well-formed.
  brainRun("session-1", [undefined, promotion, promotion, { ...promotion, to: 7 }]);
  brainRun("session-2", [promotion, { ...promotion, to: "IT Manager", gameTimeMs: 9_000 }]);
  const promotions = store.events({ environment: "E2" }).filter((event) => event.kind === "workPromotion");
  expect(promotions.map((event) => event.detail)).toEqual([
    promotion,
    { ...promotion, to: "IT Manager", gameTimeMs: 9_000 },
  ]);
  expect(lines).toEqual([
    "the Agent took a promotion at Carmichael Security: IT Intern to IT Analyst",
    "the Agent took a promotion at Carmichael Security: IT Intern to IT Manager",
  ]);
  store.close();
});

test("the faction state unread (#197): a factionStateUnread event and a log line per change, read again once; after a brain restart too", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "record-"));
  directories.push(directory);
  const store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  const lines: string[] = [];
  const read = { joined: [], invitations: [], queuedAugmentations: [] };
  const unread = (problem: string) => ({ factions: { backend: "ui", state: null, problem } });
  /** A brain's run, the Agent connected and sending slow snapshots with `slows`, in turn. */
  const brainRun = (session: string, slows: unknown[]) => {
    const channel = new ControlChannel({ token: TOKEN, clock: fixedClock });
    recordChannelEvents(channel, store, { environment: "E2", brainRelease: "v0.2.0", log: (line) => lines.push(line) });
    const page = connectionFromTest();
    channel.accept(page.connection);
    const message = (type: string, fields: object) =>
      page.receive(encodeControlMessage({ protocolVersion: CONTROL_PROTOCOL_VERSION, type, ...fields } as never));
    message("hello", {
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: session,
      game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    });
    for (const [index, data] of slows.entries()) {
      message("snapshot", { agentSessionId: session, tier: "slow", sequenceNumber: index + 1, gameTimeMs: 1, data });
    }
  };
  brainRun("session-1", [
    { factions: { backend: "ui", state: read, problem: null } },
    unread("a dialog the Agent leaves for the owner is open"),
    unread("a dialog the Agent leaves for the owner is open"),
    unread("no game page to read the faction state through"),
  ]);
  // The brain restarts: the same problem isn't stored again; read again is.
  brainRun("session-2", [
    unread("no game page to read the faction state through"),
    { factions: { backend: "sim", state: read, problem: null } },
    { purchasedServers: [] },
  ]);
  const factionEvents = store
    .events({ environment: "E2" })
    .filter((event) => event.kind.startsWith("factionState"))
    .map(({ kind, detail }) => [kind, detail]);
  expect(factionEvents).toEqual([
    ["factionStateUnread", { backend: "ui", problem: "a dialog the Agent leaves for the owner is open" }],
    ["factionStateUnread", { backend: "ui", problem: "no game page to read the faction state through" }],
    ["factionStateRead", { backend: "sim" }],
    ["factionStateUnread", { backend: null, problem: "the slow snapshot carries no faction state the brain can read" }],
  ]);
  expect(lines).toEqual([
    "the faction state couldn't be read (ui): a dialog the Agent leaves for the owner is open",
    "the faction state couldn't be read (ui): no game page to read the faction state through",
    "the faction state is read again (sim)",
    "the faction state couldn't be read: the slow snapshot carries no faction state the brain can read",
  ]);
  store.close();
});
