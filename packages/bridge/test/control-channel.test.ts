import {
  CONTROL_CLOSE_CODES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type HelloMessage,
  type SnapshotMessage,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import { ControlChannel, type ControlChannelEvent, HELLO_TIMEOUT_MS } from "../src/control-channel.ts";
import { ManualClock, MemoryConnection } from "./helpers/fakes.ts";

const TOKEN = "the-token";

function hello(changes: Partial<HelloMessage> = {}): string {
  return encodeControlMessage({
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    type: "hello",
    token: TOKEN,
    deploymentId: "deployment-a",
    agentSessionId: "session-1",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    ...changes,
  });
}

function snapshot(sequenceNumber: number, tier: SnapshotTier = "fast", agentSessionId = "session-1"): string {
  const message: SnapshotMessage = {
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    type: "snapshot",
    agentSessionId,
    tier,
    sequenceNumber,
    gameTimeMs: 1_000 * sequenceNumber,
    data: { sequenceNumber },
  };
  return encodeControlMessage(message);
}

let clock: ManualClock;
let channel: ControlChannel;
let events: ControlChannelEvent[];

beforeEach(() => {
  clock = new ManualClock();
  channel = new ControlChannel({ token: TOKEN, clock });
  events = [];
  channel.subscribe((event) => events.push(event));
});

function connectAgent(helloText = hello()): MemoryConnection {
  const connection = new MemoryConnection();
  channel.accept(connection);
  connection.receive(helloText);
  return connection;
}

const types = () => events.map((event) => event.type);

describe("accepting an Agent", () => {
  test("a valid hello is welcomed and reported", () => {
    const connection = connectAgent();
    expect(connection.sentMessages()).toEqual([{ protocolVersion: 1, type: "welcome" }]);
    expect(events).toEqual([
      {
        type: "agentConnected",
        atMs: clock.now(),
        agentSessionId: "session-1",
        deploymentId: "deployment-a",
        game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
      },
    ]);
    expect(channel.connectedAgent()).toMatchObject({ agentSessionId: "session-1", deploymentId: "deployment-a" });
  });

  test("no hello within the time allowed: closed with 4001 and reported", () => {
    const connection = new MemoryConnection();
    channel.accept(connection);
    clock.advance(HELLO_TIMEOUT_MS - 1);
    expect(connection.closedWith).toBeNull();
    clock.advance(1);
    expect(connection.closedWith?.code).toBe(CONTROL_CLOSE_CODES.helloTimeout);
    expect(events).toEqual([{ type: "connectionRejected", atMs: clock.now(), reason: "helloTimeout", detail: "" }]);
  });

  test("a wrong token: closed with 4003 and reported, and nothing is welcomed", () => {
    const connection = connectAgent(hello({ token: "guess" }));
    expect(connection.closedWith?.code).toBe(CONTROL_CLOSE_CODES.wrongToken);
    expect(connection.sent).toEqual([]);
    expect(types()).toEqual(["connectionRejected"]);
    expect(events[0]).toMatchObject({ reason: "wrongToken" });
  });

  test.each([
    ["a frame that isn't a message", "{"],
    ["another protocol version", JSON.stringify({ protocolVersion: 2, type: "hello" })],
    ["a snapshot before hello", snapshot(1)],
  ])("%s: closed with 4002 and reported", (_description, text) => {
    const connection = new MemoryConnection();
    channel.accept(connection);
    connection.receive(text);
    expect(connection.closedWith?.code).toBe(CONTROL_CLOSE_CODES.badMessage);
    expect(events[0]).toMatchObject({ type: "connectionRejected", reason: "badMessage" });
  });

  test("a rejected connection never displaces the connected Agent", () => {
    const agent = connectAgent();
    connectAgent(hello({ token: "guess" }));
    expect(agent.closedWith).toBeNull();
    expect(channel.connectedAgent()?.agentSessionId).toBe("session-1");
  });

  test("a second hello, or a snapshot from another session, is a protocol error", () => {
    const twice = connectAgent();
    twice.receive(hello());
    expect(twice.closedWith?.code).toBe(CONTROL_CLOSE_CODES.badMessage);
    const otherSession = connectAgent();
    otherSession.receive(snapshot(1, "fast", "someone-else"));
    expect(otherSession.closedWith?.code).toBe(CONTROL_CLOSE_CODES.badMessage);
  });

  test("an origin the transport refused is reported through the channel", () => {
    channel.reportRejectedOrigin("https://example.com");
    expect(events).toEqual([
      { type: "connectionRejected", atMs: clock.now(), reason: "origin", detail: "https://example.com" },
    ]);
  });
});

describe("one Agent at a time", () => {
  test("the newest accepted connection replaces the current one, which is closed with 4000", () => {
    const first = connectAgent();
    const second = connectAgent(hello({ agentSessionId: "session-2" }));
    expect(first.closedWith).toEqual({ code: CONTROL_CLOSE_CODES.replaced, reason: "replaced" });
    expect(second.closedWith).toBeNull();
    expect(channel.connectedAgent()?.agentSessionId).toBe("session-2");
    expect(types()).toEqual(["agentConnected", "agentDisconnected", "agentConnected"]);
  });

  test("a replaced connection's frames still in flight are ignored", () => {
    const first = connectAgent();
    connectAgent(hello({ agentSessionId: "session-2" }));
    first.receiveInFlight(snapshot(1, "fast", "session-1"));
    expect(types()).not.toContain("snapshotReceived");
  });

  test("the Agent going away is reported once", () => {
    const connection = connectAgent();
    connection.dropFromGameSide();
    expect(types()).toEqual(["agentConnected", "agentDisconnected"]);
    expect(channel.connectedAgent()).toBeNull();
  });
});

describe("snapshots", () => {
  const received = () =>
    events.flatMap((event) =>
      event.type === "snapshotReceived"
        ? [[event.snapshot.tier, event.snapshot.sequenceNumber, event.missedBefore]]
        : [],
    );

  test("passed on in order; duplicates and late ones dropped; jumps counted as missed", () => {
    const connection = connectAgent();
    for (const sequenceNumber of [1, 2, 2, 5, 4, 6]) connection.receive(snapshot(sequenceNumber));
    connection.receive(snapshot(1, "slow"));
    expect(received()).toEqual([
      ["fast", 1, 0],
      ["fast", 2, 0],
      ["fast", 5, 2],
      ["fast", 6, 0],
      ["slow", 1, 0],
    ]);
  });

  test("a reconnect of the same session carries on its numbering", () => {
    connectAgent().receive(snapshot(1));
    const again = connectAgent();
    again.receive(snapshot(1));
    again.receive(snapshot(3));
    expect(received()).toEqual([
      ["fast", 1, 0],
      ["fast", 3, 1],
    ]);
  });

  test("every snapshot is stamped with the channel's clock", () => {
    const connection = connectAgent();
    clock.advance(2_000);
    connection.receive(snapshot(1));
    expect(events.at(-1)).toMatchObject({ type: "snapshotReceived", atMs: clock.now() });
  });
});

describe("restart, without loops", () => {
  const sentTypes = (connection: MemoryConnection) => connection.sentMessages().map((message) => message.type);

  test("sent when the deployed deployment is known and differs", () => {
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    const connection = connectAgent();
    expect(connection.sentMessages()).toEqual([{ protocolVersion: 1, type: "restart", deploymentId: "deployment-b" }]);
  });

  test("not sent when it's the same deployment", () => {
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    expect(sentTypes(connectAgent())).toEqual(["welcome"]);
  });

  test.each([
    ["unknown", { deployedId: null, hold: false, deployFailed: false }],
    ["on hold", { deployedId: "deployment-b", hold: true, deployFailed: false }],
    ["after a failed deploy", { deployedId: "deployment-b", hold: false, deployFailed: true }],
  ])("not sent while the deployment is %s: the Agent is welcomed as it is", (_description, state) => {
    channel.setDeploymentState(state);
    expect(sentTypes(connectAgent())).toEqual(["welcome"]);
  });

  test("a deploy that completes while an older Agent is connected restarts it, once", () => {
    const connection = connectAgent();
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    expect(sentTypes(connection)).toEqual(["welcome", "restart"]);
  });
});
