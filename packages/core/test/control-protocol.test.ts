import { describe, expect, test } from "vitest";
import {
  type AgentMessage,
  type BrainMessage,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  parseAgentMessage,
  parseBrainMessage,
} from "../src/control-protocol.ts";

const hello: AgentMessage = {
  protocolVersion: CONTROL_PROTOCOL_VERSION,
  type: "hello",
  token: "secret",
  deploymentId: "0123abcd",
  agentSessionId: "session-1",
  game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
};
const snapshot: AgentMessage = {
  protocolVersion: CONTROL_PROTOCOL_VERSION,
  type: "snapshot",
  agentSessionId: "session-1",
  tier: "fast",
  sequenceNumber: 1,
  gameTimeMs: 1_767_225_600_000,
  data: { money: 1000, degradedTiers: [] },
};

describe("round trips", () => {
  test.each([hello, snapshot, { ...snapshot, data: null }])("agent message %#", (message) => {
    expect(parseAgentMessage(encodeControlMessage(message))).toEqual({ ok: true, message });
  });

  test.each<BrainMessage>([
    { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "welcome" },
    { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "restart", deploymentId: "0123abcd" },
  ])("brain message %#", (message) => {
    expect(parseBrainMessage(encodeControlMessage(message))).toEqual({ ok: true, message });
  });
});

describe("rejected, each with a reason", () => {
  const withChanges = (base: object, changes: object) => JSON.stringify({ ...base, ...changes });
  test.each([
    ["not JSON", "{"],
    ["not an object", "[1]"],
    ["another protocol version", withChanges(hello, { protocolVersion: 2 })],
    ["no protocol version", JSON.stringify({ type: "hello" })],
    ["an unknown type", withChanges(hello, { type: "goodbye" })],
    ["a hello without a token", withChanges(hello, { token: "" })],
    ["a hello with a bad deployment id", withChanges(hello, { deploymentId: "../x" })],
    ["a hello without a session", withChanges(hello, { agentSessionId: 7 })],
    ["a hello without game info", withChanges(hello, { game: null })],
    ["a hello with a bad version number", withChanges(hello, { game: { ...hello.game, versionNumber: "51" } })],
    ["a snapshot of an unknown tier", withChanges(snapshot, { tier: "hourly" })],
    ["a snapshot numbered 0", withChanges(snapshot, { sequenceNumber: 0 })],
    ["a snapshot numbered 1.5", withChanges(snapshot, { sequenceNumber: 1.5 })],
    ["a snapshot without game time", withChanges(snapshot, { gameTimeMs: undefined })],
    ["a snapshot without data", JSON.stringify({ ...snapshot, data: undefined })],
  ])("%s", (_description, text) => {
    const result = parseAgentMessage(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  test("a brain message the Agent doesn't know", () => {
    expect(parseBrainMessage(JSON.stringify({ protocolVersion: 1, type: "intent" })).ok).toBe(false);
    expect(parseBrainMessage(JSON.stringify({ protocolVersion: 1, type: "restart" })).ok).toBe(false);
  });
});
