import { describe, expect, test } from "vitest";
import {
  type AgentMessage,
  type BrainMessage,
  CONTROL_PROTOCOL_VERSION,
  desiredStateWhileHolding,
  encodeControlMessage,
  MAX_SAFE_MODE_TTL_MS,
  parseAgentMessage,
  parseBrainMessage,
} from "../src/control-protocol.ts";
import { TECH_VENDORS } from "../src/locations.ts";

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
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles", "foodnstuff"] },
      intents: [
        { id: "buyTor(Alpha Enterprises)", action: "buyTor", args: { vendor: "Alpha Enterprises" } },
        { id: "travel(Aevum)", action: "travel", args: { city: "Aevum" } },
      ],
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: true, target: null, hosts: [] },
      intents: [{ id: "buyProgram(BruteSSH.exe)", action: "buyProgram", args: { program: "BruteSSH.exe" } }],
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [
        {
          id: "upgradeHomeRam(8, Omega Software)",
          action: "upgradeHomeRam",
          args: { fromRam: 8, vendor: "Omega Software" },
        },
      ],
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [],
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [],
      work: { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true },
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [],
      work: { kind: "company", company: "Noodle Bar", field: "Waiter", focus: false },
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [],
      work: { kind: "crime", crime: "Grand Theft Auto", focus: true },
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles"] },
      intents: [],
      work: { kind: "crime", crime: "Shoplift", focus: true },
      ttlMs: 43_200_000,
    },
    {
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "desiredState",
      hackLoop: { enabled: false, target: null, hosts: [] },
      intents: [],
      work: { kind: "class", location: "Powerhouse Gym", classType: "agi", focus: false },
    },
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

  const hackLoop = { enabled: true, target: "n00dles", hosts: ["foodnstuff"] };
  const travel = { id: "travel(Ishima)", action: "travel", args: { city: "Ishima" } };
  const desiredState = { protocolVersion: 1, type: "desiredState", hackLoop, intents: [travel] };
  const withIntents = (...intents: unknown[]) => ({ ...desiredState, intents });
  const factionWork = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };
  const companyWork = { kind: "company", company: "Noodle Bar", field: "Waiter", focus: true };
  test.each([
    ["no hack loop", { ...desiredState, hackLoop: undefined }],
    ["a hack loop that isn't an object", { ...desiredState, hackLoop: true }],
    ["enabled that isn't a boolean", { ...desiredState, hackLoop: { ...hackLoop, enabled: "yes" } }],
    ["no target", { ...desiredState, hackLoop: { ...hackLoop, target: undefined } }],
    ["an empty target", { ...desiredState, hackLoop: { ...hackLoop, target: "" } }],
    ["a numeric target", { ...desiredState, hackLoop: { ...hackLoop, target: 7 } }],
    ["an over-long target", { ...desiredState, hackLoop: { ...hackLoop, target: "x".repeat(257) } }],
    ["no hosts", { ...desiredState, hackLoop: { ...hackLoop, hosts: undefined } }],
    ["a host that isn't a hostname", { ...desiredState, hackLoop: { ...hackLoop, hosts: ["n00dles", 7] } }],
    ["too many hosts", { ...desiredState, hackLoop: { ...hackLoop, hosts: Array(1_001).fill("n00dles") } }],
    ["preparing that isn't an object", { ...desiredState, hackLoop: { ...hackLoop, preparing: "zer0" } }],
    ["preparing with no target", { ...desiredState, hackLoop: { ...hackLoop, preparing: { hosts: ["zer0"] } } }],
    [
      "preparing with an empty target",
      { ...desiredState, hackLoop: { ...hackLoop, preparing: { target: "", hosts: ["zer0"] } } },
    ],
    ["preparing with no hosts", { ...desiredState, hackLoop: { ...hackLoop, preparing: { target: "zer0" } } }],
    [
      "preparing on a host that isn't a hostname",
      { ...desiredState, hackLoop: { ...hackLoop, preparing: { target: "zer0", hosts: [7] } } },
    ],
    [
      "preparing on a host that also earns",
      { ...desiredState, hackLoop: { ...hackLoop, preparing: { target: "zer0", hosts: ["joesguns", "foodnstuff"] } } },
    ],
    [
      "more hosts than the most, earning and preparing together",
      {
        ...desiredState,
        hackLoop: {
          ...hackLoop,
          hosts: Array.from({ length: 600 }, (_, index) => `earn-${index}`),
          preparing: { target: "zer0", hosts: Array.from({ length: 401 }, (_, index) => `prepare-${index}`) },
        },
      },
    ],
    [
      "preparing with the loop off",
      {
        ...desiredState,
        hackLoop: { enabled: false, target: null, hosts: [], preparing: { target: "zer0", hosts: ["joesguns"] } },
      },
    ],
    [
      "preparing with no target to earn on",
      { ...desiredState, hackLoop: { ...hackLoop, target: null, preparing: { target: "zer0", hosts: ["joesguns"] } } },
    ],
    ["no intents", { ...desiredState, intents: undefined }],
    ["intents that aren't a list", { ...desiredState, intents: travel }],
    ["an intent that isn't valid", withIntents({ ...travel, args: { city: "Atlantis" } })],
    ["an intent whose id isn't its own", withIntents({ ...travel, id: "travel(Aevum)" })],
    ["the same intent twice", withIntents(travel, travel)],
    ["work that isn't an object", { ...desiredState, work: "hacking" }],
    ["work of an unknown kind", { ...desiredState, work: { ...factionWork, kind: "gardening" } }],
    ["work for a faction that isn't one", { ...desiredState, work: { ...factionWork, faction: "The Gibson" } }],
    ["work of a type the game hasn't", { ...desiredState, work: { ...factionWork, workType: "espionage" } }],
    ["work whose focus isn't a boolean", { ...desiredState, work: { ...factionWork, focus: "yes" } }],
    ["company work at a company that isn't one", { ...desiredState, work: { ...companyWork, company: "Gibson Inc" } }],
    ["company work in a field that isn't one", { ...desiredState, work: { ...companyWork, field: "Juggler" } }],
    [
      "company work in a field named by a prototype's key",
      { ...desiredState, work: { ...companyWork, field: "toString" } },
    ],
    ["crime work naming no crime", { ...desiredState, work: { kind: "crime", focus: true } }],
    [
      "crime work naming a crime the game hasn't",
      { ...desiredState, work: { kind: "crime", crime: "Jaywalk", focus: true } },
    ],
    [
      "crime work naming a crime in lower case",
      { ...desiredState, work: { kind: "crime", crime: "shoplift", focus: true } },
    ],
    [
      "crime work naming a prototype's key",
      { ...desiredState, work: { kind: "crime", crime: "toString", focus: true } },
    ],
    ["crime work naming no string", { ...desiredState, work: { kind: "crime", crime: 7, focus: true } }],
    ["a class naming no location", { ...desiredState, work: { kind: "class", classType: "str", focus: false } }],
    [
      "a class at a location that teaches none",
      { ...desiredState, work: { kind: "class", location: "The Slums", classType: "str", focus: false } },
    ],
    [
      "a class at a location named by a prototype's key",
      { ...desiredState, work: { kind: "class", location: "toString", classType: "str", focus: false } },
    ],
    [
      "a class the game hasn't",
      { ...desiredState, work: { kind: "class", location: "Iron Gym", classType: "Strength", focus: false } },
    ],
    [
      "a course at a gym",
      { ...desiredState, work: { kind: "class", location: "Iron Gym", classType: "Algorithms", focus: false } },
    ],
    [
      "a gym stat at a university",
      { ...desiredState, work: { kind: "class", location: "Rothman University", classType: "dex", focus: false } },
    ],
    [
      "over 100 intents, each valid and different",
      withIntents(
        ...Array.from({ length: 101 }, (_, index) => {
          const args = { fromRam: 2 ** (index % 30), vendor: Object.values(TECH_VENDORS)[Math.floor(index / 30)] };
          return { id: `upgradeHomeRam(${args.fromRam}, ${args.vendor})`, action: "upgradeHomeRam", args };
        }),
      ),
    ],
  ])("a desired state with %s", (_description, message) => {
    const result = parseBrainMessage(JSON.stringify(message));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("");
  });

  test("preparing the next target (#184): carried with its hosts; absent, null or on no host, it's none", () => {
    const preparing = { target: "zer0", hosts: ["joesguns", "max-hardware"] };
    const at = (fields: unknown) => parseBrainMessage(JSON.stringify({ ...desiredState, hackLoop: fields }));
    expect(at({ ...hackLoop, preparing: { ...preparing, extra: 1 } })).toEqual({
      ok: true,
      message: { ...desiredState, hackLoop: { ...hackLoop, preparing } },
    });
    // An older brain's state, with none: absent, as before.
    for (const none of [undefined, null, { target: "zer0", hosts: [] }]) {
      expect(at({ ...hackLoop, preparing: none })).toEqual({ ok: true, message: desiredState });
    }
    // The most hosts in all, earning and preparing.
    const most = {
      ...hackLoop,
      hosts: Array.from({ length: 600 }, (_, index) => `earn-${index}`),
      preparing: { target: "zer0", hosts: Array.from({ length: 400 }, (_, index) => `prepare-${index}`) },
    };
    expect(at(most).ok).toBe(true);
  });

  test("a desired state keeps only its known fields", () => {
    const extras = JSON.stringify({
      ...desiredState,
      extra: 1,
      hackLoop: { ...desiredState.hackLoop, extra: 2 },
      intents: [{ ...travel, extra: 3, args: { ...travel.args, extra: 4 } }],
    });
    expect(parseBrainMessage(extras)).toEqual({ ok: true, message: desiredState });
  });
});

describe("while the brain holds (#136, #141)", () => {
  const hackLoopOff = { enabled: false, target: null, hosts: [] };
  const hackLoopOn = { enabled: true, target: "n00dles", hosts: ["foodnstuff"] };
  const intents = [{ id: "travel(Aevum)", action: "travel" as const, args: { city: "Aevum" } }];

  test("with the hack loop on and nothing sent yet, nothing goes: it would start the loop", () => {
    expect(desiredStateWhileHolding({ hackLoop: hackLoopOn, intents }, null)).toBeNull();
  });

  test("with the hack loop on, it goes as last sent, with no intents", () => {
    const lastSent = { hackLoop: { ...hackLoopOn, target: "joesguns" }, intents };
    expect(desiredStateWhileHolding({ hackLoop: hackLoopOn, intents }, lastSent)).toEqual({
      hackLoop: lastSent.hackLoop,
      intents: [],
    });
  });

  test("with the hack loop off, it goes, with no intents", () => {
    expect(desiredStateWhileHolding({ hackLoop: hackLoopOff, intents }, null)).toEqual({
      hackLoop: hackLoopOff,
      intents: [],
    });
  });
});

describe("work (#151)", () => {
  const state = { protocolVersion: 1, type: "desiredState", hackLoop: { enabled: false, target: null, hosts: [] } };
  test("absent or null, the brain doesn't manage work: the message carries none", () => {
    for (const work of [undefined, null]) {
      const parsed = parseBrainMessage(JSON.stringify({ ...state, intents: [], work }));
      expect(parsed.ok && parsed.message.type === "desiredState" && parsed.message.work).toBeUndefined();
    }
  });

  test("only its known fields come through", () => {
    const work = { kind: "faction", faction: "CyberSec", workType: "field", focus: false, extra: 1 };
    const parsed = parseBrainMessage(JSON.stringify({ ...state, intents: [], work }));
    expect(parsed.ok && parsed.message.type === "desiredState" && parsed.message.work).toEqual({
      kind: "faction",
      faction: "CyberSec",
      workType: "field",
      focus: false,
    });
  });

  test("while the brain holds, work isn't managed: none goes", () => {
    const work = { kind: "faction" as const, faction: "CyberSec", workType: "hacking" as const, focus: true };
    const desired = { hackLoop: { enabled: false, target: null, hosts: [] }, intents: [], work };
    expect(desiredStateWhileHolding(desired, null)).toEqual({ hackLoop: desired.hackLoop, intents: [] });
    // The hack loop on, with a last state that had work: the loop as last sent, still no work.
    const loopOn = { ...desired, hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles"] } };
    expect(desiredStateWhileHolding(loopOn, loopOn)).toEqual({ hackLoop: loopOn.hackLoop, intents: [] });
  });
});

describe("safe mode's ttlMs (#160)", () => {
  const state = {
    protocolVersion: 1,
    type: "desiredState",
    hackLoop: { enabled: true, target: "n00dles", hosts: ["n00dles"] },
    intents: [],
  };
  const ttlOf = (text: string) => {
    const parsed = parseBrainMessage(text);
    if (!parsed.ok || parsed.message.type !== "desiredState") throw new Error(`not a desired state: ${text}`);
    return parsed.message.ttlMs;
  };

  test("carried as sent; absent or 0, the message carries none: the state isn't kept past the brain", () => {
    expect(ttlOf(JSON.stringify({ ...state, ttlMs: 43_200_000 }))).toBe(43_200_000);
    expect(ttlOf(JSON.stringify(state))).toBeUndefined();
    expect(ttlOf(JSON.stringify({ ...state, ttlMs: 0 }))).toBeUndefined();
    expect(ttlOf(JSON.stringify({ ...state, ttlMs: MAX_SAFE_MODE_TTL_MS }))).toBe(7 * 24 * 60 * 60_000);
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "600000"],
    ["null", null],
    ["unsafe", 2 ** 53],
    ["over 7 days, so a time it makes can't be shown as a date", 604_800_001],
  ])("one that's %s is refused, with a reason", (_description, ttlMs) => {
    const result = parseBrainMessage(JSON.stringify({ ...state, ttlMs }));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("ttlMs") });
  });

  test("while the brain holds, it goes as the brain set it: a held state starts nothing new, kept or not", () => {
    const loopOn = { hackLoop: state.hackLoop, intents: [], ttlMs: 600_000 };
    expect(desiredStateWhileHolding(loopOn, loopOn)).toEqual({ hackLoop: state.hackLoop, intents: [], ttlMs: 600_000 });
    const loopOff = { ...loopOn, hackLoop: { enabled: false, target: null, hosts: [] } };
    expect(desiredStateWhileHolding(loopOff, null)).toEqual({ ...loopOff, intents: [] });
    expect(desiredStateWhileHolding({ hackLoop: state.hackLoop, intents: [] }, loopOn)).toEqual({
      hackLoop: state.hackLoop,
      intents: [],
    });
  });
});
