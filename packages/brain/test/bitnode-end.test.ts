// Stopping at the BitNode's end (#303): the switch, kept in the store; the rule that tells the next BitNode after a
// destroy from an install, a soft reset, a save loaded, b1t_flum3 and a restart; and the controller that asks the brain
// to stop at the first of a destroy seen and a destroy that would gain nothing, through a real ControlChannel.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type SlowSnapshotData,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type BitNodeReading,
  bitNodeReadingOf,
  destroyedBetween,
  readStopAtBitNodeEnd,
  STOP_AT_BITNODE_END_SETTING,
  writeStopAtBitNodeEnd,
} from "../src/bitnode-end.ts";
import { DesiredStateController, type RuleEvent } from "../src/desired-state.ts";
import { writeManualIntents, writeResetSentNote } from "../src/manual-intents.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { writeWorldDaemonEnabled } from "../src/world-daemon.ts";
import { mediumData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
const WD = "w0r1d_d43m0n";
const RED_PILL = "The Red Pill";
let directory: string;
let store: TelemetryStore;
let channel: ControlChannel;
let sequenceNumber = 0;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "bitnode-end-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the switch", () => {
  test("off unless turned on; kept in the store as true or false, so it survives a restart", () => {
    expect(readStopAtBitNodeEnd(store)).toBe(false);
    writeStopAtBitNodeEnd(store, true);
    expect(store.getSetting(STOP_AT_BITNODE_END_SETTING)).toBe("true");
    expect(STOP_AT_BITNODE_END_SETTING).toBe("stopAtBitNodeEnd.enabled");
    expect(readStopAtBitNodeEnd(store)).toBe(true);
    writeStopAtBitNodeEnd(store, false);
    expect(readStopAtBitNodeEnd(store)).toBe(false);
  });

  test("a value it didn't write fails, rather than guess", () => {
    store.setSetting(STOP_AT_BITNODE_END_SETTING, "yes");
    expect(() => readStopAtBitNodeEnd(store)).toThrow(/stopAtBitNodeEnd\.enabled setting is "yes"/);
  });

  test("the controller's: written, and its view says it", () => {
    const controller = new DesiredStateController({ channel, store });
    expect(controller.stopAtBitNodeEndView()).toEqual({ enabled: false });
    controller.setStopAtBitNodeEnd(true);
    expect(store.getSetting(STOP_AT_BITNODE_END_SETTING)).toBe("true");
    expect(controller.stopAtBitNodeEndView()).toEqual({ enabled: true });
  });
});

/** A BitNode as a slow snapshot shows it: BN1.3 (SF1 at 2), begun at 0, seen at the game's time 10,000. */
const reading = (changes: Partial<BitNodeReading> = {}): BitNodeReading => ({
  currentNode: 1,
  lastNodeReset: 0,
  ownedSF: { 1: 2 },
  gameTimeMs: 10_000,
  ...changes,
});

describe("the next BitNode after a destroy (destroyedBetween)", () => {
  const before = reading();
  test("the brain's destroy, or the owner's queued one, out (its reset note): another lastNodeReset is the next", () => {
    expect(destroyedBetween(before, reading({ lastNodeReset: 20_000, ownedSF: { 1: 3 } }), 0)).toBe(true);
    // At the cap, with no level to gain (`RedPill.tsx:28-31`): the note says it.
    const atCap = reading({ ownedSF: { 1: 3 } });
    expect(destroyedBetween(atCap, reading({ lastNodeReset: 20_000, ownedSF: { 1: 3 } }), 0)).toBe(true);
    // Into another BitNode.
    expect(destroyedBetween(atCap, reading({ currentNode: 2, lastNodeReset: 20_000, ownedSF: { 1: 3 } }), 0)).toBe(
      true,
    );
  });

  test("with no note, a destroy by hand: the BitNode's Source-File gained a level (`RedPill.tsx:16-52`)", () => {
    expect(destroyedBetween(before, reading({ lastNodeReset: 20_000, ownedSF: { 1: 3 } }), null)).toBe(true);
    const fresh = reading({ ownedSF: {} });
    expect(destroyedBetween(fresh, reading({ lastNodeReset: 20_000, ownedSF: { 1: 1 } }), null)).toBe(true);
  });

  test("with no note and no level gained: b1t_flum3, a new game, or a destroy by hand at the cap; not told apart", () => {
    // b1t_flum3 gives none (`RedPill.tsx:62-63`, its `isFlume`).
    expect(destroyedBetween(before, reading({ currentNode: 2, lastNodeReset: 20_000 }), null)).toBe(false);
    expect(destroyedBetween(before, reading({ lastNodeReset: 20_000, ownedSF: {} }), null)).toBe(false);
    const atCap = reading({ ownedSF: { 1: 3 } });
    expect(destroyedBetween(atCap, reading({ lastNodeReset: 20_000, ownedSF: { 1: 3 } }), null)).toBe(false);
  });

  test("an install or a soft reset leaves lastNodeReset alone (`PlayerObjectGeneralMethods.ts:126`, `:173`)", () => {
    expect(destroyedBetween(before, reading({ gameTimeMs: 30_000 }), null)).toBe(false);
    // Even with a destroy's note out: not done yet.
    expect(destroyedBetween(before, reading({ gameTimeMs: 30_000 }), 0)).toBe(false);
  });

  test("a save loaded: an older BitNode's start is before the last look; the same BitNode's is unmoved", () => {
    const older = reading({ lastNodeReset: 5_000, ownedSF: { 1: 3 }, gameTimeMs: 6_000 });
    expect(destroyedBetween(before, older, 0)).toBe(false);
    expect(destroyedBetween(before, older, null)).toBe(false);
    expect(destroyedBetween(before, reading({ gameTimeMs: 4_000 }), 0)).toBe(false);
  });

  test("a restarted brain, nothing seen before: only its destroy's note, and a later lastNodeReset", () => {
    expect(destroyedBetween(null, reading({ lastNodeReset: 20_000 }), 0)).toBe(true);
    expect(destroyedBetween(null, reading({ lastNodeReset: 20_000, ownedSF: { 1: 3 } }), null)).toBe(false);
    expect(destroyedBetween(null, reading({ lastNodeReset: 0 }), 0)).toBe(false);
    // An older save loaded under a restarted brain.
    expect(destroyedBetween(null, reading({ lastNodeReset: -5_000 }), 0)).toBe(false);
  });

  test("the reading: from the slow snapshot's reset info and its game time; null without them", () => {
    const slow = slowSnapshot({ lastNodeReset: 7, ownedSF: { 1: 2 } });
    expect(bitNodeReadingOf(slow, 99)).toEqual({ currentNode: 1, lastNodeReset: 7, ownedSF: { 1: 2 }, gameTimeMs: 99 });
    expect(bitNodeReadingOf({ ...slow, resetInfo: undefined } as unknown as SlowSnapshotData, 99)).toBeNull();
    const noReset = { ...slow, resetInfo: { ...slow.resetInfo, lastNodeReset: "x" } } as unknown as SlowSnapshotData;
    expect(bitNodeReadingOf(noReset, 99)).toBeNull();
  });
});

// --- The controller ----------------------------------------------------------------------------------------------------

function slowSnapshot({
  lastNodeReset = 1_000,
  lastAugReset = lastNodeReset,
  currentNode = 1,
  ownedSF = { 1: 2 } as Record<string, number>,
  ownedAugs = {} as Record<string, number>,
  queued = [] as string[],
} = {}): SlowSnapshotData {
  return {
    resetInfo: { lastAugReset, lastNodeReset, currentNode, ownedAugs, ownedSF, bitNodeOptions: {} },
    purchasedServers: [],
    factions: { backend: "sim", state: { joined: [], invitations: [], queuedAugmentations: queued }, problem: null },
  };
}

const network: StaticSnapshotData = {
  servers: [
    staticServer("home", { moneyMax: 0 }),
    staticServer("n00dles"),
    staticServer(WD, { requiredHackingSkill: 3000, numOpenPortsRequired: 5 }),
  ],
};

/** A brain's controller with the hack loop off, its log and its events, and an Agent connected that sends `send`. */
function brain() {
  store.setSetting("hackLoop.enabled", "false");
  const lines: string[] = [];
  const events: RuleEvent[] = [];
  const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
  controller.subscribe((event) => events.push(event));
  let connection = connect("session-1");
  let session = "session-1";
  const send = (tier: SnapshotTier, data: unknown, gameTimeMs = 1_000) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: session,
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs,
        data,
      }),
    );
  /** The next Agent (a reset kills the last), in a new session. */
  const reconnect = (agentSessionId: string) => {
    connection.close(1006, "the reset killed the Agent");
    session = agentSessionId;
    connection = connect(agentSessionId);
  };
  const stops = () => events.filter((event) => event.type === "brainStoppedAtBitNodeEnd");
  return { controller, lines, events, send, reconnect, stops };
}

function connect(agentSessionId: string): MemoryConnection {
  const connection = new MemoryConnection();
  channel.accept(connection);
  connection.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId,
      game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
    }),
  );
  return connection;
}

const DESTROY_NOTE = { id: "destroyBitNode(1)", field: "lastNodeReset", resetAt: 1_000, sentAtMs: 5 } as const;

describe("destroyed: the brain stops on the next BitNode's first slow snapshot", () => {
  test("its destroy out: logged, stored once, with the BitNodes; the destroy's note dropped as before", () => {
    writeStopAtBitNodeEnd(store, true);
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, reconnect, stops, lines, controller } = brain();
    send("slow", slowSnapshot(), 2_000);
    expect(stops()).toEqual([]);
    reconnect("session-2");
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    const detail = "BN1.3 destroyed, BN1.4 seen";
    expect(stops()).toEqual([
      {
        type: "brainStoppedAtBitNodeEnd",
        atMs: expect.any(Number),
        reason: "destroyed",
        bitNode: "BN1.3",
        nextBitNode: "BN1.4",
        detail,
      },
    ]);
    expect(lines).toContain(`stopping at the BitNode's end (the switch is on): ${detail}`);
    expect(controller.intentsView()).toEqual([]);
    // Once: what comes after it doesn't ask again.
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 10_000);
    expect(stops()).toHaveLength(1);
  });

  test("the owner's queued destroy, into another BitNode: the same", () => {
    writeStopAtBitNodeEnd(store, true);
    writeManualIntents(store, [{ id: "destroyBitNode(2)", action: "destroyBitNode", args: { nextBitNode: 2 } }]);
    writeResetSentNote(store, { ...DESTROY_NOTE, id: "destroyBitNode(2)" });
    const { send, stops } = brain();
    send("slow", slowSnapshot({ ownedSF: { 1: 3 } }), 2_000);
    send("slow", slowSnapshot({ currentNode: 2, lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    expect(stops()).toMatchObject([{ reason: "destroyed", bitNode: "BN1.4", nextBitNode: "BN2.1" }]);
  });

  test("a restarted brain with its destroy out: the first slow snapshot of the next BitNode, the last unseen", () => {
    writeStopAtBitNodeEnd(store, true);
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops, lines } = brain();
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    const detail = "a destroy went through, BN1.4 seen";
    expect(stops()).toMatchObject([{ reason: "destroyed", bitNode: null, nextBitNode: "BN1.4", detail }]);
    expect(lines).toContain(`stopping at the BitNode's end (the switch is on): ${detail}`);
  });

  test("a destroy by hand in the game, below the cap: the Source-File's level gained says it", () => {
    writeStopAtBitNodeEnd(store, true);
    const { send, stops } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    expect(stops()).toMatchObject([{ reason: "destroyed", bitNode: "BN1.3", nextBitNode: "BN1.4" }]);
  });

  test("the switch off then: nothing, and turned on after, the destroy is forgotten (this BitNode's end is next)", () => {
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops, controller } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    controller.setStopAtBitNodeEnd(true);
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 10_000);
    expect(stops()).toEqual([]);
  });
});

describe("not on the wrong signals", () => {
  test("an install, and a soft reset (nothing queued): lastAugReset moves, lastNodeReset doesn't", () => {
    writeStopAtBitNodeEnd(store, true);
    const { send, stops } = brain();
    send("slow", slowSnapshot({ queued: ["CashRoot Starter Kit"] }), 2_000);
    send("slow", slowSnapshot({ lastAugReset: 5_000, ownedAugs: { "CashRoot Starter Kit": 1 } }), 5_500);
    send("slow", slowSnapshot({ lastAugReset: 7_000, ownedAugs: { "CashRoot Starter Kit": 1 } }), 7_500);
    expect(stops()).toEqual([]);
  });

  test("an install with a destroy's note out (an older brain's, say): not the destroy", () => {
    writeStopAtBitNodeEnd(store, true);
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ lastAugReset: 5_000 }), 5_500);
    expect(stops()).toEqual([]);
  });

  test("a save loaded: an older BitNode's (its start before the last look), or one from this BitNode", () => {
    writeStopAtBitNodeEnd(store, true);
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops } = brain();
    send("slow", slowSnapshot({ lastNodeReset: 1_000 }), 50_000);
    send("slow", slowSnapshot({ lastNodeReset: 20_000, ownedSF: { 1: 1 } }), 30_000);
    expect(stops()).toEqual([]);
  });

  test("b1t_flum3 or a new game: another BitNode with no note and no level gained", () => {
    writeStopAtBitNodeEnd(store, true);
    const { send, stops } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ currentNode: 2, lastNodeReset: 9_000 }), 9_500);
    send("slow", slowSnapshot({ lastNodeReset: 12_000, ownedSF: {} }), 12_500);
    expect(stops()).toEqual([]);
  });

  test("a brain restarted mid-BitNode, with no destroy out: its first slow snapshot is no change", () => {
    writeStopAtBitNodeEnd(store, true);
    const { send, stops } = brain();
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 10_000);
    expect(stops()).toEqual([]);
  });
});

describe("nothing more to gain: w0r1d_d43m0n ready, its destroy refused (Source-File 1 at 3)", () => {
  /** BN1.4 with The Red Pill installed: w0r1d_d43m0n at `hacking`, rooted unless said. */
  function inBlockedBitNode({ hacking = 3000, rooted = true, ownedSF = { 1: 3 } } = {}) {
    const started = brain();
    started.send("static", network);
    started.send("slow", slowSnapshot({ ownedSF, ownedAugs: { [RED_PILL]: 1 } }), 2_000);
    started.send("medium", mediumData(hacking, { [WD]: rooted }));
    return started;
  }

  test("after the nextBitNode stall's line and event, in the same update: logged, stored, once", () => {
    writeStopAtBitNodeEnd(store, true);
    const { send, events, lines, stops } = inBlockedBitNode();
    const detail =
      "BN1.4's w0r1d_d43m0n is ready, but Source-File 1 is at level 3, so BitNode 1 gives nothing more: the next " +
      "BitNode is yours";
    expect(stops()).toEqual([
      {
        type: "brainStoppedAtBitNodeEnd",
        atMs: expect.any(Number),
        reason: "nothingMoreToGain",
        bitNode: "BN1.4",
        nextBitNode: null,
        detail,
      },
    ]);
    const kinds = events.map((event) => event.type).filter((type) => /Stalled|Stopped/.test(type));
    expect(kinds).toEqual(["worldDaemonStalled", "brainStoppedAtBitNodeEnd"]);
    expect(events.find((event) => event.type === "worldDaemonStalled")).toMatchObject({ step: "nextBitNode" });
    const stall = lines.findIndex((line) => line.startsWith("world daemon: STALLED 0 min: the BitNode not destroyed"));
    const stop = lines.indexOf(`stopping at the BitNode's end (the switch is on): ${detail}`);
    expect(stall).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(stall);
    send("medium", mediumData(3000, { [WD]: true }));
    expect(stops()).toHaveLength(1);
  });

  test("not before w0r1d_d43m0n is ready: short of its level, or not rooted", () => {
    writeStopAtBitNodeEnd(store, true);
    expect(inBlockedBitNode({ hacking: 2999 }).stops()).toEqual([]);
  });

  test("not rooted: none", () => {
    writeStopAtBitNodeEnd(store, true);
    expect(inBlockedBitNode({ rooted: false }).stops()).toEqual([]);
  });

  test("below the cap the destroy goes, so the brain plays on to it", () => {
    writeStopAtBitNodeEnd(store, true);
    expect(inBlockedBitNode({ ownedSF: { 1: 2 } }).stops()).toEqual([]);
  });

  test("the World Daemon's switch off (your own destroy planned): none, the destroy awaited instead", () => {
    writeStopAtBitNodeEnd(store, true);
    writeWorldDaemonEnabled(store, false);
    expect(inBlockedBitNode().stops()).toEqual([]);
  });

  test("the switch off: none; turned on mid-run, at once, without a restart", () => {
    const { controller, stops } = inBlockedBitNode();
    expect(stops()).toEqual([]);
    controller.setStopAtBitNodeEnd(true);
    expect(stops()).toMatchObject([{ reason: "nothingMoreToGain", bitNode: "BN1.4" }]);
  });
});
