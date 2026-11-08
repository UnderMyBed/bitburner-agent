// Stopping at the BitNode's end (#303): the switch, kept in the store; the rule that tells the next BitNode after a
// destroy from an install, a soft reset, a save loaded, b1t_flum3 and a restart; and the controller that asks the brain
// to stop at the first of a destroy seen and a destroy that would gain nothing, through a real ControlChannel.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CLOSE_GAME_WINDOW_STAYED_OPEN,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  INTENT_RETRY_ROUNDS,
  type SlowSnapshotData,
  SNAPSHOT_TIER_PERIOD_MS,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BitNodeEndShutdown,
  type BitNodeReading,
  bitNodeReadingOf,
  CLOSE_GAME_INTENT,
  describeStopAtBitNodeEnd,
  destroyedBetween,
  GAME_CLOSE_CONFIRMED_WITHIN_MS,
  GAME_CLOSE_QUIET_MS,
  GAME_CLOSE_SENT_WITHIN_MS,
  parseStopAtBitNodeEnd,
  readStopAtBitNodeEnd,
  STOP_AFTER_MS,
  STOP_AT_BITNODE_END_SETTING,
  writeStopAtBitNodeEnd,
} from "../src/bitnode-end.ts";
import { DesiredStateController, type RuleEvent } from "../src/desired-state.ts";
import { readManualIntents, writeManualIntents, writeResetSentNote } from "../src/manual-intents.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
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
  test("off unless set; its three settings kept in the store as they are, so they survive a restart", () => {
    expect(readStopAtBitNodeEnd(store)).toBe("off");
    expect(STOP_AT_BITNODE_END_SETTING).toBe("stopAtBitNodeEnd");
    for (const setting of ["brain", "brainAndGame", "off"] as const) {
      writeStopAtBitNodeEnd(store, setting);
      expect(store.getSetting(STOP_AT_BITNODE_END_SETTING)).toBe(setting);
      expect(readStopAtBitNodeEnd(store)).toBe(setting);
    }
  });

  test("a value it didn't write fails, rather than guess; the dashboard's request is checked the same", () => {
    store.setSetting(STOP_AT_BITNODE_END_SETTING, "true");
    expect(() => readStopAtBitNodeEnd(store)).toThrow(
      /stopAtBitNodeEnd setting is "true", not off, brain, brainAndGame/,
    );
    expect(parseStopAtBitNodeEnd("brainAndGame")).toBe("brainAndGame");
    for (const value of ["on", true, null, "Brain"]) expect(parseStopAtBitNodeEnd(value)).toBeNull();
  });

  test("in words, for the log", () => {
    expect(["off", "brain", "brainAndGame"].map((each) => describeStopAtBitNodeEnd(each as never))).toEqual([
      "play on",
      "stop the brain",
      "stop the brain and close the game",
    ]);
  });

  test("the controller's: written, and its view says it", () => {
    const controller = new DesiredStateController({ channel, store });
    expect(controller.stopAtBitNodeEndView()).toEqual({ setting: "off" });
    controller.setStopAtBitNodeEnd("brainAndGame");
    expect(store.getSetting(STOP_AT_BITNODE_END_SETTING)).toBe("brainAndGame");
    expect(controller.stopAtBitNodeEndView()).toEqual({ setting: "brainAndGame" });
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
    const changed = (fields: Record<string, unknown>) =>
      ({ ...slow, resetInfo: { ...slow.resetInfo, ...fields } }) as unknown as SlowSnapshotData;
    expect(bitNodeReadingOf(changed({ lastNodeReset: "x" }), 99)).toBeNull();
    expect(bitNodeReadingOf(changed({ lastNodeReset: Number.NaN }), 99)).toBeNull();
    expect(bitNodeReadingOf(changed({ currentNode: 1.5 }), 99)).toBeNull();
    expect(bitNodeReadingOf(changed({ currentNode: "1" }), 99)).toBeNull();
    expect(bitNodeReadingOf(changed({ ownedSF: null }), 99)).toBeNull();
    expect(bitNodeReadingOf(changed({ ownedSF: 3 }), 99)).toBeNull();
  });
});

// --- The controller --------------------------------------------------------------------------------------------------

/** A slow snapshot: BN1.3 (SF1 at 2) begun at 1,000, its last install then too, unless said. */
function slowSnapshot(
  fields: {
    lastNodeReset?: number;
    lastAugReset?: number;
    currentNode?: number;
    ownedSF?: Record<string, number>;
    ownedAugs?: Record<string, number>;
    queued?: string[];
  } = {},
): SlowSnapshotData {
  const { lastNodeReset = 1_000, currentNode = 1, ownedSF = { 1: 2 }, ownedAugs = {}, queued = [] } = fields;
  const lastAugReset = fields.lastAugReset ?? lastNodeReset;
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
  // Stand-in save backups (the irreversible gate's), each settled by the test.
  const pendingBackups: ((event: SaveBackupEvent) => void)[] = [];
  const backupNow = vi.fn(() => new Promise<SaveBackupEvent>((resolve) => pendingBackups.push(resolve)));
  const settleBackup = async () => {
    pendingBackups.shift()?.({ type: "saveBackup", atMs: 1, file: "saves/E2/x.json.gz", sizeBytes: 10 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const controller = new DesiredStateController({
    channel,
    store,
    saveBackups: { backupNow },
    log: (line) => lines.push(line),
  });
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
  /** The intents in the last desired state sent. */
  const sentIds = () =>
    (
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as { intents: { id: string }[] } | undefined
    )?.intents.map((each) => each.id) ?? [];
  return { controller, lines, events, send, reconnect, stops, backupNow, settleBackup, sentIds };
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
    writeStopAtBitNodeEnd(store, "brain");
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
        closeGame: false,
        settingAfter: "off",
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
    writeStopAtBitNodeEnd(store, "brain");
    writeManualIntents(store, [{ id: "destroyBitNode(2)", action: "destroyBitNode", args: { nextBitNode: 2 } }]);
    writeResetSentNote(store, { ...DESTROY_NOTE, id: "destroyBitNode(2)" });
    const { send, stops } = brain();
    send("slow", slowSnapshot({ ownedSF: { 1: 3 } }), 2_000);
    send("slow", slowSnapshot({ currentNode: 2, lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    expect(stops()).toMatchObject([{ reason: "destroyed", bitNode: "BN1.4", nextBitNode: "BN2.1" }]);
  });

  test("a restarted brain with its destroy out: the first slow snapshot of the next BitNode, the last unseen", () => {
    writeStopAtBitNodeEnd(store, "brain");
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops, lines } = brain();
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    const detail = "a destroy went through, BN1.4 seen";
    expect(stops()).toMatchObject([{ reason: "destroyed", bitNode: null, nextBitNode: "BN1.4", detail }]);
    expect(lines).toContain(`stopping at the BitNode's end (the switch is on): ${detail}`);
  });

  test("a destroy by hand in the game, below the cap: the Source-File's level gained says it", () => {
    writeStopAtBitNodeEnd(store, "brain");
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
    controller.setStopAtBitNodeEnd("brain");
    send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 10_000);
    expect(stops()).toEqual([]);
  });
});

describe("not on the wrong signals", () => {
  test("an install, and a soft reset (nothing queued): lastAugReset moves, lastNodeReset doesn't", () => {
    writeStopAtBitNodeEnd(store, "brain");
    const { send, stops } = brain();
    send("slow", slowSnapshot({ queued: ["CashRoot Starter Kit"] }), 2_000);
    send("slow", slowSnapshot({ lastAugReset: 5_000, ownedAugs: { "CashRoot Starter Kit": 1 } }), 5_500);
    send("slow", slowSnapshot({ lastAugReset: 7_000, ownedAugs: { "CashRoot Starter Kit": 1 } }), 7_500);
    expect(stops()).toEqual([]);
  });

  test("an install with a destroy's note out (an older brain's, say): not the destroy", () => {
    writeStopAtBitNodeEnd(store, "brain");
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ lastAugReset: 5_000 }), 5_500);
    expect(stops()).toEqual([]);
  });

  test("a save loaded: an older BitNode's (its start before the last look), or one from this BitNode", () => {
    writeStopAtBitNodeEnd(store, "brain");
    writeResetSentNote(store, DESTROY_NOTE);
    const { send, stops } = brain();
    send("slow", slowSnapshot({ lastNodeReset: 1_000 }), 50_000);
    send("slow", slowSnapshot({ lastNodeReset: 20_000, ownedSF: { 1: 1 } }), 30_000);
    expect(stops()).toEqual([]);
  });

  test("b1t_flum3 or a new game: another BitNode with no note and no level gained", () => {
    writeStopAtBitNodeEnd(store, "brain");
    const { send, stops } = brain();
    send("slow", slowSnapshot(), 2_000);
    send("slow", slowSnapshot({ currentNode: 2, lastNodeReset: 9_000 }), 9_500);
    send("slow", slowSnapshot({ lastNodeReset: 12_000, ownedSF: {} }), 12_500);
    expect(stops()).toEqual([]);
  });

  test("a brain restarted mid-BitNode, with no destroy out: its first slow snapshot is no change", () => {
    writeStopAtBitNodeEnd(store, "brain");
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
    writeStopAtBitNodeEnd(store, "brain");
    const { send, events, lines, stops } = inBlockedBitNode();
    const detail =
      "BN1.4's w0r1d_d43m0n is ready, but its destroy would enter BitNode 1, and Source-File 1 is at level 3, so " +
      "BitNode 1 gives nothing more: the next BitNode is yours";
    expect(stops()).toEqual([
      {
        type: "brainStoppedAtBitNodeEnd",
        atMs: expect.any(Number),
        reason: "nothingMoreToGain",
        bitNode: "BN1.4",
        nextBitNode: null,
        closeGame: false,
        settingAfter: "off",
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
    writeStopAtBitNodeEnd(store, "brain");
    expect(inBlockedBitNode({ hacking: 2999 }).stops()).toEqual([]);
  });

  test("not rooted: none", () => {
    writeStopAtBitNodeEnd(store, "brain");
    expect(inBlockedBitNode({ rooted: false }).stops()).toEqual([]);
  });

  test("below the cap the destroy goes, so the brain plays on to it", () => {
    writeStopAtBitNodeEnd(store, "brain");
    expect(inBlockedBitNode({ ownedSF: { 1: 2 } }).stops()).toEqual([]);
  });

  test("the World Daemon's switch off (your own destroy planned): none, the destroy awaited instead", () => {
    writeStopAtBitNodeEnd(store, "brain");
    writeWorldDaemonEnabled(store, false);
    expect(inBlockedBitNode().stops()).toEqual([]);
  });

  test("the switch off: none; turned on mid-run, at once, without a restart", () => {
    const { controller, stops } = inBlockedBitNode();
    expect(stops()).toEqual([]);
    controller.setStopAtBitNodeEnd("brain");
    expect(stops()).toMatchObject([{ reason: "nothingMoreToGain", bitNode: "BN1.4" }]);
  });
});

describe("closing the game too (the switch's third setting)", () => {
  /** A destroy by hand seen (BN1.3 to BN1.4) with the switch at `setting`: the stop, then the static snapshot. */
  function destroyedWith(setting: "brain" | "brainAndGame") {
    writeStopAtBitNodeEnd(store, setting);
    const started = brain();
    started.send("slow", slowSnapshot(), 2_000);
    started.send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    started.send("static", network);
    return started;
  }
  const medium = () => mediumData(1, {});
  const closeView = (controller: DesiredStateController) =>
    controller.intentsView().find((view) => view.id === CLOSE_GAME_INTENT.id);
  /** The Agent's fast snapshot with the close's outcome. */
  const tried = (tries: number, problem: string) => ({
    degradedTiers: [],
    pageHeapUsedBytes: null,
    game: null,
    intents: [{ id: CLOSE_GAME_INTENT.id, done: false, tries, problem, backend: "ui" }],
  });
  const UNSAVED = 'the game\'s save not confirmed ("Game Saved!" not shown in time), so not closed';

  test("the stop asks for the close: past the gate's two medium snapshots and a save backup, stored as it goes out", async () => {
    const { controller, send, stops, events, lines, backupNow, settleBackup, sentIds } = destroyedWith("brainAndGame");
    expect(stops()).toMatchObject([{ reason: "destroyed", closeGame: true }]);
    expect(lines).toContain(
      "stopping at the BitNode's end (the switch is on, the game to close first): BN1.3 destroyed, BN1.4 seen",
    );
    expect(closeView(controller)).toMatchObject({ source: "bitNodeEnd", outcome: null });
    expect(controller.closeGameWaitingFor()).toMatch(/^waiting for the guard to hold on 2 consecutive medium/);
    send("medium", medium());
    send("medium", medium());
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
    expect(events.filter((event) => event.type === "gameCloseSent")).toEqual([]);
    await settleBackup();
    expect(sentIds()).toContain(CLOSE_GAME_INTENT.id);
    expect(events.filter((event) => event.type === "gameCloseSent")).toEqual([
      { type: "gameCloseSent", atMs: expect.any(Number) },
    ]);
    expect(lines).toContain("closing the game: its own Save Game, then its window closed (a save backup taken first)");
    expect(controller.closeGameWaitingFor()).toBeNull();
    // Stored once.
    send("medium", medium());
    expect(events.filter((event) => event.type === "gameCloseSent")).toHaveLength(1);
  });

  test("your queue first: the close waits for what was queued before it, as a reset does", () => {
    writeStopAtBitNodeEnd(store, "brainAndGame");
    const started = brain();
    started.controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    started.send("slow", slowSnapshot(), 2_000);
    started.send("slow", slowSnapshot({ lastNodeReset: 9_000, ownedSF: { 1: 3 } }), 9_500);
    expect(started.controller.closeGameWaitingFor()).toBe("held: travel(Aevum), queued before it, isn't done");
  });

  test("stopping the brain alone: no close asked for", () => {
    const { controller, stops } = destroyedWith("brain");
    expect(stops()).toMatchObject([{ closeGame: false }]);
    expect(closeView(controller)).toBeUndefined();
    expect(controller.closeGameWaitingFor()).toBe("not asked for");
  });

  test("tried, not done: each try stored, asked again up to 3 tries, then withdrawn, logged; never again", async () => {
    const { controller, send, lines, events, settleBackup, sentIds } = destroyedWith("brainAndGame");
    send("medium", medium());
    send("medium", medium());
    await settleBackup();
    send("fast", tried(1, UNSAVED));
    // The same try reported again is one try.
    send("fast", tried(1, UNSAVED));
    send("fast", tried(2, UNSAVED));
    expect(sentIds()).toContain(CLOSE_GAME_INTENT.id);
    send("fast", tried(3, UNSAVED));
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
    expect(closeView(controller)).toBeUndefined();
    expect(events.filter((event) => event.type === "gameCloseTried")).toEqual(
      [1, 2, 3].map((tries) => ({ type: "gameCloseTried", atMs: expect.any(Number), tries, problem: UNSAVED })),
    );
    expect(lines).toContain(`closing the game: try 2 of 3 reported: ${UNSAVED}`);
    expect(lines).toContain(`closing the game: withdrawn after 3 tries: ${UNSAVED}`);
    send("medium", medium());
    send("medium", medium());
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
  });

  test("the window stayed open (a browser's): withdrawn at once, not closed again", async () => {
    const { send, lines, settleBackup, sentIds } = destroyedWith("brainAndGame");
    send("medium", medium());
    send("medium", medium());
    await settleBackup();
    send("fast", tried(1, CLOSE_GAME_WINDOW_STAYED_OPEN));
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
    expect(lines).toContain(`closing the game: withdrawn after 1 try: ${CLOSE_GAME_WINDOW_STAYED_OPEN}`);
  });

  test("the Agent gone after the close went out (a reload too): never sent again, to it or the next", async () => {
    const { send, reconnect, lines, settleBackup, sentIds } = destroyedWith("brainAndGame");
    send("medium", medium());
    send("medium", medium());
    await settleBackup();
    expect(sentIds()).toContain(CLOSE_GAME_INTENT.id);
    reconnect("session-2");
    expect(lines).toContain("closing the game: the Agent went after it went out; not sent again");
    send("static", network);
    send("medium", medium());
    send("medium", medium());
    await settleBackup();
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
  });

  test("set back to play on before the close went out: called off, stored, the brain stops alone; after, nothing", async () => {
    const called = destroyedWith("brainAndGame");
    called.controller.setStopAtBitNodeEnd("off");
    expect(closeView(called.controller)).toBeUndefined();
    expect(called.events.filter((event) => event.type === "gameCloseCalledOff")).toEqual([
      { type: "gameCloseCalledOff", atMs: expect.any(Number) },
    ]);
    expect(called.lines).toContain(
      "closing the game: called off from the dashboard before it went out; the brain stops alone",
    );
    called.send("medium", medium());
    called.send("medium", medium());
    expect(called.backupNow).not.toHaveBeenCalled();
  });

  test("set back to play on after the close went out: too late, nothing called off", async () => {
    const { controller, send, events, settleBackup, sentIds } = destroyedWith("brainAndGame");
    send("medium", medium());
    send("medium", medium());
    await settleBackup();
    controller.setStopAtBitNodeEnd("off");
    expect(events.filter((event) => event.type === "gameCloseCalledOff")).toEqual([]);
    expect(sentIds()).toContain(CLOSE_GAME_INTENT.id);
  });
});

describe("the owner's queue refuses closeGame: only the switch closes the game (#303 review)", () => {
  test("queued from the dashboard: refused, naming the switch", () => {
    const { controller } = brain();
    expect(controller.addManualIntent({ action: "closeGame", args: {} })).toEqual({
      ok: false,
      reason:
        "closeGame isn't queued by hand: set the dashboard's \"The BitNode's end\" to \"Stop the brain and close the " +
        'game", which closes it once, then stops the brain',
    });
    expect(readManualIntents(store)).toEqual([]);
  });

  test("one in a store written before: off the queue once the Agent goes after it went out, never sent again", async () => {
    writeManualIntents(store, [CLOSE_GAME_INTENT]);
    const { send, reconnect, settleBackup, sentIds } = brain();
    send("static", network);
    send("medium", mediumData(1, {}));
    send("medium", mediumData(1, {}));
    await settleBackup();
    expect(sentIds()).toContain(CLOSE_GAME_INTENT.id);
    // The game closed (or reloaded): the Agent's gone before it could report the close.
    reconnect("session-2");
    expect(readManualIntents(store)).toEqual([]);
    send("static", network);
    send("medium", mediumData(1, {}));
    send("medium", mediumData(1, {}));
    await settleBackup();
    expect(sentIds()).not.toContain(CLOSE_GAME_INTENT.id);
  });

  test("one in a store written before: off the queue once tried enough, never a loop of saves", () => {
    writeManualIntents(store, [CLOSE_GAME_INTENT]);
    const { send } = brain();
    const fast = (tries: number, problem: string) =>
      send("fast", {
        degradedTiers: [],
        pageHeapUsedBytes: null,
        game: null,
        intents: [{ id: CLOSE_GAME_INTENT.id, done: false, tries, problem, backend: "ui" }],
      });
    fast(1, "the game's save not confirmed");
    expect(readManualIntents(store).map((each) => each.id)).toEqual([CLOSE_GAME_INTENT.id]);
    fast(1, CLOSE_GAME_WINDOW_STAYED_OPEN);
    expect(readManualIntents(store)).toEqual([]);
  });
});

describe("main.ts's side: when the brain shuts down (BitNodeEndShutdown)", () => {
  afterEach(() => vi.useRealTimers());
  const STOP = { type: "brainStoppedAtBitNodeEnd", atMs: 1_000 };
  function shutdownWith(waitingFor: string | null = "waiting for a save backup") {
    vi.useFakeTimers();
    const shutDown = vi.fn();
    const stopSupervising = vi.fn();
    const turnOff = vi.fn();
    const recorded: [string, Record<string, unknown>][] = [];
    const lines: string[] = [];
    const watch = new BitNodeEndShutdown({
      shutDown,
      record: (kind, detail) => recorded.push([kind, detail]),
      log: (line) => lines.push(line),
      closeWaitingFor: () => waitingFor,
      stopSupervising,
      turnOff,
    });
    return { watch, shutDown, stopSupervising, turnOff, recorded, lines };
  }
  /** The stop that closes the game, and the close going out at 30 s. */
  function closeSent() {
    const started = shutdownWith();
    started.watch.ruleEvent({ ...STOP, closeGame: true });
    expect(started.stopSupervising).not.toHaveBeenCalled();
    started.watch.ruleEvent({ type: "gameCloseSent", atMs: 30_000 });
    return started;
  }

  test("the brain alone: a second on, as on Ctrl+C, nothing more stored; once, the switch set back to play on", () => {
    const { watch, shutDown, recorded, stopSupervising, turnOff, lines } = shutdownWith();
    watch.ruleEvent({ ...STOP, closeGame: false });
    vi.advanceTimersByTime(STOP_AFTER_MS - 1);
    expect(shutDown).not.toHaveBeenCalled();
    expect(turnOff).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(shutDown).toHaveBeenCalledTimes(1);
    expect(turnOff).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "the stop at the BitNode's end set back to play on: set it again for the next BitNode's end",
    ]);
    expect([recorded, stopSupervising.mock.calls]).toEqual([[], []]);
  });

  test("the close going out stops supervision, so the game closed isn't relaunched", () => {
    const { stopSupervising } = closeSent();
    expect(stopSupervising).toHaveBeenCalledTimes(1);
  });

  test("closed: the Agent's connection drops after the close, and no Agent comes back within 15 s; then the stop", () => {
    const { watch, shutDown, recorded, lines } = shutdownWith();
    watch.ruleEvent({ ...STOP, closeGame: true });
    // A disconnect before the close went out (the destroy's own reload, say) isn't the close.
    watch.agentDisconnected(2_000);
    watch.agentConnected(3_000);
    expect([shutDown.mock.calls, recorded]).toEqual([[], []]);
    watch.ruleEvent({ type: "gameCloseSent", atMs: 30_000 });
    watch.agentDisconnected(30_400);
    vi.advanceTimersByTime(GAME_CLOSE_QUIET_MS - 1);
    expect(shutDown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recorded).toEqual([["gameClosed", { closeSentAtMs: 30_000, afterMs: 400 }]]);
    expect(lines).toEqual([
      "the game closed: its Agent's connection dropped 0.4 s after the close went out, and no Agent came back within " +
        "15 s",
      "the stop at the BitNode's end set back to play on: set it again for the next BitNode's end",
    ]);
    expect(shutDown).toHaveBeenCalledTimes(1);
    // Once, and no timer left to fire.
    watch.agentConnected(50_000);
    vi.advanceTimersByTime(GAME_CLOSE_SENT_WITHIN_MS);
    expect(shutDown).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
  });

  test("an Agent back after the drop (a reload, the Agent restarted): the window stayed open, not confirmed, the stop", () => {
    const { watch, shutDown, recorded, lines } = closeSent();
    watch.agentDisconnected(30_400);
    watch.agentConnected(33_400);
    const reason =
      "an Agent connected 3.0 s after the connection dropped: the game's window stayed open (a reload, or the Agent " +
      "restarted)";
    expect(recorded).toEqual([["gameCloseNotConfirmed", { reason, closeSentAtMs: 30_000 }]]);
    expect(lines).toEqual([
      `game close NOT CONFIRMED: ${reason}; stopping the brain anyway`,
      "the stop at the BitNode's end set back to play on: set it again for the next BitNode's end",
    ]);
    expect(shutDown).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(GAME_CLOSE_SENT_WITHIN_MS);
    expect(shutDown).toHaveBeenCalledTimes(1);
  });

  test("the connection not dropped within a minute of the close: gameCloseNotConfirmed, logged, then the stop anyway", () => {
    const { shutDown, recorded, lines } = closeSent();
    vi.advanceTimersByTime(GAME_CLOSE_CONFIRMED_WITHIN_MS - 1);
    expect(shutDown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const reason = "the Agent's connection didn't drop within 60 s of the close: the game may still be running";
    expect(recorded).toEqual([["gameCloseNotConfirmed", { reason, closeSentAtMs: 30_000 }]]);
    expect(lines).toEqual([
      `game close NOT CONFIRMED: ${reason}; stopping the brain anyway`,
      "the stop at the BitNode's end set back to play on: set it again for the next BitNode's end",
    ]);
    expect(shutDown).toHaveBeenCalledTimes(1);
  });

  test("at the Agent's real cadence (a try at once, then every 30 s): each try waits afresh, so try 3 is waited for", () => {
    const { watch, shutDown, recorded } = closeSent();
    const retryMs = INTENT_RETRY_ROUNDS * SNAPSHOT_TIER_PERIOD_MS.fast;
    // The confirm window holds the next try and its worker's round.
    expect(GAME_CLOSE_CONFIRMED_WITHIN_MS).toBeGreaterThan(retryMs + 2 * SNAPSHOT_TIER_PERIOD_MS.fast);
    // Tries reported 2 s after the close went out, then 30 s apart: none of them closed the window.
    for (const [index, atMs] of [2_000, 2_000 + retryMs, 2_000 + 2 * retryMs].entries()) {
      vi.advanceTimersByTime(index === 0 ? 2_000 : retryMs);
      expect(shutDown).not.toHaveBeenCalled();
      watch.ruleEvent({ type: "gameCloseTried", atMs: 30_000 + atMs });
    }
    // The third try's wait, then not confirmed, of the last try.
    vi.advanceTimersByTime(GAME_CLOSE_CONFIRMED_WITHIN_MS - 1);
    expect(shutDown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recorded).toEqual([
      [
        "gameCloseNotConfirmed",
        {
          reason:
            "the Agent's connection didn't drop within 60 s of the close's last try: the game may still be running",
          closeSentAtMs: 30_000,
        },
      ],
    ]);
  });

  test("a try that closes the window: no report, the drop, then closed", () => {
    const { watch, shutDown, recorded } = closeSent();
    watch.ruleEvent({ type: "gameCloseTried", atMs: 32_000 });
    vi.advanceTimersByTime(30_000);
    watch.agentDisconnected(62_100);
    // A try reported while the drop is awaited changes nothing (a stale fast snapshot).
    watch.ruleEvent({ type: "gameCloseTried", atMs: 62_200 });
    vi.advanceTimersByTime(GAME_CLOSE_QUIET_MS);
    expect(recorded).toEqual([["gameClosed", { closeSentAtMs: 30_000, afterMs: 32_100 }]]);
    expect(shutDown).toHaveBeenCalledTimes(1);
  });

  test("the close never out within 5 minutes of the stop: not confirmed, saying what it waits for, then the stop", () => {
    const { watch, shutDown, recorded } = shutdownWith("waiting for a save backup");
    watch.ruleEvent({ ...STOP, closeGame: true });
    vi.advanceTimersByTime(GAME_CLOSE_SENT_WITHIN_MS - 1);
    expect(shutDown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recorded).toEqual([
      [
        "gameCloseNotConfirmed",
        { reason: "the close didn't go out within 5 min of the stop (waiting for a save backup)", closeSentAtMs: null },
      ],
    ]);
    expect(shutDown).toHaveBeenCalledTimes(1);
  });

  test("the close called off before it went out: the stop alone, a second on, nothing more stored", () => {
    const { watch, shutDown, recorded, stopSupervising } = shutdownWith();
    watch.ruleEvent({ ...STOP, closeGame: true });
    watch.ruleEvent({ type: "gameCloseCalledOff", atMs: 5_000 });
    vi.advanceTimersByTime(STOP_AFTER_MS);
    expect(shutDown).toHaveBeenCalledTimes(1);
    expect([recorded, stopSupervising.mock.calls]).toEqual([[], []]);
  });

  test("before any stop, nothing: a disconnect or a stray close event shuts nothing down", () => {
    const { watch, shutDown, stopSupervising } = shutdownWith();
    watch.agentDisconnected(5);
    watch.ruleEvent({ type: "gameCloseSent", atMs: 6 });
    watch.ruleEvent({ type: "gameCloseCalledOff", atMs: 6 });
    watch.agentDisconnected(7);
    watch.agentConnected(8);
    vi.advanceTimersByTime(GAME_CLOSE_SENT_WITHIN_MS * 2);
    expect(shutDown).not.toHaveBeenCalled();
    expect(stopSupervising).not.toHaveBeenCalled();
  });
});
