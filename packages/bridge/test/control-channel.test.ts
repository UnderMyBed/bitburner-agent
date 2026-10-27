import {
  CONTROL_CLOSE_CODES,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type HelloMessage,
  type SnapshotMessage,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  ControlChannel,
  type ControlChannelEvent,
  HELLO_TIMEOUT_MS,
  REMEMBERED_SESSIONS,
} from "../src/control-channel.ts";
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

  test("a welcomed Agent isn't timed out later", () => {
    const connection = connectAgent();
    clock.advance(HELLO_TIMEOUT_MS * 3);
    expect(connection.closedWith).toBeNull();
    expect(types()).toEqual(["agentConnected"]);
  });

  test("a connection that closes before saying hello isn't reported as timed out later", () => {
    const connection = new MemoryConnection();
    channel.accept(connection);
    connection.dropFromGameSide();
    clock.advance(HELLO_TIMEOUT_MS * 3);
    expect(events).toEqual([]);
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

  test(`only the last ${REMEMBERED_SESSIONS} sessions keep their numbering, so a long run doesn't grow`, () => {
    connectAgent().receive(snapshot(5));
    for (let session = 2; session <= REMEMBERED_SESSIONS + 1; session++) {
      connectAgent(hello({ agentSessionId: `session-${session}` }));
    }
    // session-1 is forgotten: if it ever came back, it would count from scratch.
    connectAgent().receive(snapshot(1));
    expect(received()).toEqual([
      ["fast", 5, 4],
      ["fast", 1, 0],
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

  test("an outdated deployment that keeps coming back is told once, then welcomed, until the deployer learns more", () => {
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    // The game reloaded a save from before the deploy was autosaved: boot.js starts deployment-a again, and again.
    expect(sentTypes(connectAgent(hello({ agentSessionId: "session-1" })))).toEqual(["restart"]);
    expect(sentTypes(connectAgent(hello({ agentSessionId: "session-2" })))).toEqual(["welcome"]);
    const third = connectAgent(hello({ agentSessionId: "session-3" }));
    expect(sentTypes(third)).toEqual(["welcome"]);
    // The deployer reads current.txt (it names deployment-a), deploys again, and the connected Agent is told again.
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    expect(sentTypes(third)).toEqual(["welcome", "restart"]);
  });
});

describe("desired state (#134)", () => {
  const sentTypes = (connection: MemoryConnection) => connection.sentMessages().map((message) => message.type);
  const deployedA = { deployedId: "deployment-a", hold: false, deployFailed: false };
  const loopOn = { hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles", "foodnstuff"] } };
  const loopOff = { hackLoop: { enabled: false, target: null, hosts: [] } };

  test("sent when set, to a welcomed Agent running the deployed deployment", () => {
    channel.setDeploymentState(deployedA);
    const connection = connectAgent();
    channel.setDesiredState(loopOn);
    expect(connection.sentMessages()).toEqual([
      { protocolVersion: 1, type: "welcome" },
      { protocolVersion: 1, type: "desiredState", ...loopOn },
    ]);
  });

  test("never with the welcome: the controller sets it for each new Agent once it knows that Agent's game", () => {
    channel.setDeploymentState(deployedA);
    channel.setDesiredState(loopOn);
    expect(sentTypes(connectAgent())).toEqual(["welcome"]);
  });

  test("sent on a change, not again when it's the same, and null sends nothing", () => {
    channel.setDeploymentState(deployedA);
    const connection = connectAgent();
    channel.setDesiredState(loopOn);
    channel.setDesiredState(structuredClone(loopOn));
    channel.setDesiredState(null);
    channel.setDesiredState(loopOff);
    expect(connection.sentMessages().slice(1)).toEqual([
      { protocolVersion: 1, type: "desiredState", ...loopOn },
      { protocolVersion: 1, type: "desiredState", ...loopOff },
    ]);
  });

  test("each connection is sent it once: a reconnected Agent gets the same state again when it's set", () => {
    channel.setDeploymentState(deployedA);
    connectAgent();
    channel.setDesiredState(loopOn);
    const reconnected = connectAgent(hello({ agentSessionId: "session-2" }));
    channel.setDesiredState(loopOn);
    expect(sentTypes(reconnected)).toEqual(["welcome", "desiredState"]);
  });

  test("a copy is kept: changing the caller's object later changes nothing sent", () => {
    const connection = connectAgent();
    const state = structuredClone(loopOn);
    channel.setDesiredState(state);
    state.hackLoop.hosts.push("joesguns");
    channel.setDeploymentState(deployedA);
    expect(connection.sentMessages()[1]).toEqual({ protocolVersion: 1, type: "desiredState", ...loopOn });
  });

  test("not until the deployer knows the Agent runs the deployed deployment, then at once", () => {
    const connection = connectAgent();
    channel.setDesiredState(loopOn);
    expect(sentTypes(connection)).toEqual(["welcome"]);
    channel.setDeploymentState(deployedA);
    expect(sentTypes(connection)).toEqual(["welcome", "desiredState"]);
  });

  test("on never goes to an Agent told to restart, nor to an outdated one; off goes to both", () => {
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    const toldToRestart = connectAgent();
    channel.setDesiredState(loopOn);
    expect(sentTypes(toldToRestart)).toEqual(["restart"]);
    channel.setDesiredState(loopOff);
    expect(sentTypes(toldToRestart)).toEqual(["restart", "desiredState"]);
    const outdated = connectAgent(hello({ agentSessionId: "session-2" }));
    channel.setDesiredState(loopOn);
    expect(sentTypes(outdated)).toEqual(["welcome"]);
    channel.setDesiredState(loopOff);
    expect(sentTypes(outdated)).toEqual(["welcome", "desiredState"]);
  });

  test("a new connection starts with nothing: the last Agent's state isn't sent when the deployer learns more", () => {
    channel.setDeploymentState(deployedA);
    connectAgent();
    channel.setDesiredState(loopOn);
    const next = connectAgent(hello({ agentSessionId: "session-2" }));
    channel.setDeploymentState(deployedA);
    expect(sentTypes(next)).toEqual(["welcome"]);
  });

  test("off gets through a drift found at hello, before the brain ever learns the deployed id", () => {
    const drifted = connectAgent(
      hello({ game: { version: "3.1.0", versionNumber: 52, commit: "abcdef123", platform: "Steam" } }),
    );
    channel.setDesiredState(loopOn);
    channel.setDesiredState(loopOff);
    expect(drifted.sentMessages().slice(1)).toEqual([{ protocolVersion: 1, type: "desiredState", ...loopOff }]);
  });

  test("an Agent told to restart after its welcome gets nothing more, even if its deployment is current again", () => {
    channel.setDeploymentState(deployedA);
    const connection = connectAgent();
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    // The deployer reads current.txt again, naming deployment-a: the Agent is on its way out all the same.
    channel.setDeploymentState(deployedA);
    channel.setDesiredState(loopOn);
    expect(sentTypes(connection)).toEqual(["welcome", "restart"]);
  });

  test.each([
    ["on hold", { ...deployedA, hold: true }],
    ["after a failed deploy", { ...deployedA, deployFailed: true }],
  ])("%s: on isn't sent, but off is, and on goes out once the hold clears", (_description, held) => {
    channel.setDeploymentState(held);
    const connection = connectAgent();
    channel.setDesiredState(loopOn);
    expect(sentTypes(connection)).toEqual(["welcome"]);
    channel.setDesiredState(loopOff);
    channel.setDesiredState(loopOn);
    channel.setDeploymentState(deployedA);
    expect(connection.sentMessages().slice(1)).toEqual([
      { protocolVersion: 1, type: "desiredState", ...loopOff },
      { protocolVersion: 1, type: "desiredState", ...loopOn },
    ]);
  });

  test("once the game has drifted, only off goes out", () => {
    channel.setDeploymentState(deployedA);
    const drifted = connectAgent(
      hello({ game: { version: "3.1.0", versionNumber: 52, commit: "abcdef123", platform: "Steam" } }),
    );
    channel.setDesiredState(loopOn);
    channel.setDesiredState(loopOff);
    expect(drifted.sentMessages().slice(1)).toEqual([{ protocolVersion: 1, type: "desiredState", ...loopOff }]);
  });
});

describe("an Agent on another game version", () => {
  const otherGame = { version: "3.1.0", versionNumber: 52, commit: "abcdef123", platform: "Steam" };

  test("is welcomed and reported, with a versionDrift event after it, once for the brain's run", () => {
    const connection = connectAgent(hello({ game: otherGame }));
    expect(connection.sentMessages().map((message) => message.type)).toEqual(["welcome"]);
    expect(events).toEqual([
      expect.objectContaining({ type: "agentConnected", game: otherGame }),
      {
        type: "versionDrift",
        atMs: clock.now(),
        detail: "the Agent's game: versionNumber 52, pinned 51; version 3.1.0, pinned 3.0.1",
      },
    ]);
    connectAgent(hello({ game: otherGame, agentSessionId: "session-2" }));
    expect(types().filter((type) => type === "versionDrift")).toHaveLength(1);
  });

  test("puts the channel on hold for good: no restart, for it or any Agent after it", () => {
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    const drifted = connectAgent(hello({ game: otherGame }));
    channel.setDeploymentState({ deployedId: "deployment-c", hold: false, deployFailed: false });
    const pinned = connectAgent(hello({ agentSessionId: "session-2" }));
    expect(drifted.sentMessages().map((message) => message.type)).toEqual(["welcome"]);
    expect(pinned.sentMessages().map((message) => message.type)).toEqual(["welcome"]);
  });

  test("the pinned release from another commit is the same game: Steam's build is v3.0.1's tag (#128)", () => {
    // No hold: an Agent on an older deployment is still told to restart onto the new one.
    channel.setDeploymentState({ deployedId: "deployment-b", hold: false, deployFailed: false });
    const connection = connectAgent(
      hello({ game: { ...otherGame, version: "3.0.1", versionNumber: 51, commit: "3162fd2" } }),
    );
    expect(types()).toEqual(["agentConnected"]);
    expect(connection.sentMessages().map((message) => message.type)).toEqual(["restart"]);
  });
});

describe("a listener that throws", () => {
  test("can't leave the channel half-changed, and its error is handed on", () => {
    const listenerErrors: unknown[] = [];
    channel = new ControlChannel({ token: TOKEN, clock, onListenerError: (error) => listenerErrors.push(error) });
    events = [];
    channel.subscribe(() => {
      throw new Error("the store is full");
    });
    channel.subscribe((event) => events.push(event));
    const first = connectAgent();
    const second = connectAgent(hello({ agentSessionId: "session-2" }));
    expect(first.closedWith?.code).toBe(CONTROL_CLOSE_CODES.replaced);
    expect(second.sentMessages()).toEqual([{ protocolVersion: 1, type: "welcome" }]);
    expect(channel.connectedAgent()?.agentSessionId).toBe("session-2");
    second.dropFromGameSide();
    expect(channel.connectedAgent()).toBeNull();
    // Every event still reached the other listener, and every error was handed on.
    expect(types()).toEqual(["agentConnected", "agentDisconnected", "agentConnected", "agentDisconnected"]);
    expect(listenerErrors).toHaveLength(4);
  });

  test("on a rejection, the connection is closed all the same", () => {
    channel = new ControlChannel({ token: TOKEN, clock, onListenerError: () => {} });
    channel.subscribe(() => {
      throw new Error("the store is full");
    });
    const connection = new MemoryConnection();
    channel.accept(connection);
    connection.receive("{");
    expect(connection.closedWith?.code).toBe(CONTROL_CLOSE_CODES.badMessage);
  });
});
