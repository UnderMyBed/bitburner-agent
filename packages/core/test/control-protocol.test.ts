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
    { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "desiredState", hackLoop: { enabled: true, target: "n00dles" } },
    { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "desiredState", hackLoop: { enabled: true, target: null } },
    { protocolVersion: CONTROL_PROTOCOL_VERSION, type: "desiredState", hackLoop: { enabled: false, target: null } },
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
    ["a numeric deployment id", withChanges(hello, { deploymentId: 123 })],
    ["an over-long token", withChanges(hello, { token: "x".repeat(257) })],
    ["an over-long version", withChanges(hello, { game: { ...hello.game, version: "3".repeat(257) } })],
  ])("%s", (_description, text) => {
    const result = parseAgentMessage(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  test("a reason quotes at most a short piece of a bad value, so a huge frame can't flood the store or the log", () => {
    const result = parseAgentMessage(JSON.stringify({ protocolVersion: "x".repeat(1_000_000) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeLessThan(150);
  });

  test("an array isn't a message", () => {
    expect(parseAgentMessage(JSON.stringify([hello]))).toEqual({ ok: false, reason: "not a JSON object" });
  });

  test("only the known fields come through: anything else the Agent sent is left behind", () => {
    const extras = JSON.stringify({
      ...hello,
      extra: 1,
      game: { ...hello.game, extra: 2 },
      ["__proto__"]: { polluted: true },
    });
    expect(parseAgentMessage(extras)).toEqual({ ok: true, message: hello });
  });

  test("a brain message the Agent doesn't know", () => {
    expect(parseBrainMessage(JSON.stringify({ protocolVersion: 1, type: "intent" })).ok).toBe(false);
    expect(parseBrainMessage(JSON.stringify({ protocolVersion: 1, type: "restart" })).ok).toBe(false);
    expect(parseBrainMessage(JSON.stringify({ protocolVersion: 1, type: "restart", deploymentId: 123 })).ok).toBe(
      false,
    );
  });

  const desiredState = { protocolVersion: 1, type: "desiredState", hackLoop: { enabled: true, target: "n00dles" } };
  test.each([
    ["no hack loop", { ...desiredState, hackLoop: undefined }],
    ["a hack loop that isn't an object", { ...desiredState, hackLoop: true }],
    ["enabled that isn't a boolean", { ...desiredState, hackLoop: { enabled: "yes", target: "n00dles" } }],
    ["no target", { ...desiredState, hackLoop: { enabled: true } }],
    ["an empty target", { ...desiredState, hackLoop: { enabled: true, target: "" } }],
    ["a numeric target", { ...desiredState, hackLoop: { enabled: true, target: 7 } }],
    ["an over-long target", { ...desiredState, hackLoop: { enabled: true, target: "x".repeat(257) } }],
  ])("a desired state with %s", (_description, message) => {
    const result = parseBrainMessage(JSON.stringify(message));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  test("a desired state keeps only its known fields", () => {
    const extras = JSON.stringify({ ...desiredState, extra: 1, hackLoop: { ...desiredState.hackLoop, extra: 2 } });
    expect(parseBrainMessage(extras)).toEqual({ ok: true, message: desiredState });
  });
});
