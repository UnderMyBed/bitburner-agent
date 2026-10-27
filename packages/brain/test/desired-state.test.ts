// The desired state's controller (#134, #136, #138): it turns the switches and the connected Agent's snapshots into the state
// the channel sends, through a real ControlChannel.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DesiredStateController } from "../src/desired-state.ts";
import { readHackLoopEnabled } from "../src/hack-loop.ts";
import { readHomeRamEnabled } from "../src/home-ram.ts";
import { readProgramsEnabled } from "../src/programs.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const TOKEN = "the-token";
let directory: string;
let store: TelemetryStore;
let channel: ControlChannel;
let sequenceNumber = 0;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "desired-state-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** An Agent of the deployed deployment connects, and is welcomed. */
function connectAgent(agentSessionId = "session-1"): MemoryConnection {
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
const send = (connection: MemoryConnection, tier: SnapshotTier, data: unknown, agentSessionId = "session-1") =>
  connection.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "snapshot",
      agentSessionId,
      tier,
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: 1_000,
      data,
    }),
  );
const desiredStates = (connection: MemoryConnection) =>
  connection
    .sentMessages()
    .filter((message) => message.type === "desiredState")
    .map(({ hackLoop, programs, homeRam }) => ({ hackLoop, programs, homeRam }));
const network: StaticSnapshotData = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };
const loopOn = { enabled: true, target: "n00dles", hosts: ["n00dles"] };
const loopOff = { enabled: false, target: null, hosts: [] };
const buyingNothing = { enabled: true, next: null };
const upgradingNothing = { enabled: true, next: null };

test("on: nothing until the connected Agent's own static and medium snapshots, then the target and hosts", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  expect(controller.hackLoopView()).toEqual({ enabled: true, waiting: true, target: null, hosts: [] });
  send(connection, "static", network);
  expect(desiredStates(connection)).toEqual([]);
  // Nothing rooted yet: on, with no target, so the Agent roots what it can.
  send(connection, "medium", mediumData(1, { home: true, n00dles: false }));
  send(connection, "medium", mediumData(1, { home: true, n00dles: true }));
  expect(desiredStates(connection)).toEqual([
    { hackLoop: { enabled: true, target: null, hosts: [] }, programs: buyingNothing, homeRam: upgradingNothing },
    { hackLoop: loopOn, programs: buyingNothing, homeRam: upgradingNothing },
  ]);
  expect(controller.hackLoopView()).toEqual({ enabled: true, waiting: false, target: "n00dles", hosts: ["n00dles"] });
});

test("an Agent that connects again is sent nothing until its own snapshots, then the same state", () => {
  new DesiredStateController({ channel, store });
  const first = connectAgent();
  send(first, "static", network);
  send(first, "medium", mediumData(1, { n00dles: true }));
  const again = connectAgent();
  expect(desiredStates(again)).toEqual([]);
  send(again, "static", network);
  send(again, "medium", mediumData(1, { n00dles: true }));
  expect(desiredStates(again)).toEqual([{ hackLoop: loopOn, programs: buyingNothing, homeRam: upgradingNothing }]);
});

test("an Agent after a reset is never sent the last game's target", () => {
  new DesiredStateController({ channel, store });
  const before = connectAgent();
  send(before, "static", network);
  send(before, "medium", mediumData(1, { n00dles: true }));
  // Augmentations installed: a new Agent, nothing rooted any more.
  const afterReset = connectAgent("session-2");
  send(afterReset, "static", network, "session-2");
  send(afterReset, "medium", mediumData(1, { n00dles: false }), "session-2");
  expect(desiredStates(afterReset)).toEqual([
    { hackLoop: { enabled: true, target: null, hosts: [] }, programs: buyingNothing, homeRam: upgradingNothing },
  ]);
});

test("the hack loop's switch: off is sent at once, kept in the store; on again sends the target back", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }));
  controller.setHackLoopEnabled(false);
  expect(readHackLoopEnabled(store)).toBe(false);
  expect(controller.hackLoopView()).toEqual({ enabled: false, waiting: false, target: null, hosts: [] });
  controller.setHackLoopEnabled(true);
  expect(desiredStates(connection).map((state) => state.hackLoop)).toEqual([loopOn, loopOff, loopOn]);
});

test("the hack loop off in the store when the brain starts: off to each Agent as it connects, before any snapshot", () => {
  store.setSetting("hackLoop.enabled", "false");
  new DesiredStateController({ channel, store });
  const connection = connectAgent();
  expect(desiredStates(connection)).toEqual([
    { hackLoop: loopOff, programs: buyingNothing, homeRam: upgradingNothing },
  ]);
});

test("a disconnect forgets the Agent's snapshots: the views show waiting", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }));
  connection.dropFromGameSide();
  expect(controller.hackLoopView()).toEqual({ enabled: true, waiting: true, target: null, hosts: [] });
  expect(controller.programsView()).toMatchObject({ enabled: true, waiting: true });
});

test("fast snapshots change nothing", () => {
  new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null });
  expect(desiredStates(connection)).toEqual([]);
});

test("programs (#136): the next item once it's affordable, the views say what's owned and what's awaited", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 100_000 }));
  expect(controller.programsView()).toEqual({
    enabled: true,
    waiting: false,
    owned: [],
    buying: null,
    waitingFor: "money for TOR router ($200,000)",
  });
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 600_000, hasTorRouter: true }));
  expect(desiredStates(connection).at(-1)?.programs).toEqual({
    enabled: true,
    next: { item: "BruteSSH.exe", vendor: null },
  });
  expect(controller.programsView()).toMatchObject({ owned: ["TOR router"], buying: "BruteSSH.exe", waitingFor: null });
});

test("programs' switch: off buys nothing, kept in the store, and the hack loop carries on", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 1e9 }));
  controller.setProgramsEnabled(false);
  expect(readProgramsEnabled(store)).toBe(false);
  expect(desiredStates(connection).at(-1)).toEqual({
    hackLoop: loopOn,
    programs: { enabled: false, next: null },
    homeRam: upgradingNothing,
  });
  expect(controller.programsView()).toMatchObject({ enabled: false, buying: null, waitingFor: null });
});

describe("home RAM (#138), one purchase at a time with the programs, cheapest first", () => {
  const sentPurchases = (connection: MemoryConnection) =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => message as unknown as DesiredState)
      .map(({ programs, homeRam }) => ({ programs: programs.next, homeRam: homeRam.next }))
      .at(-1);
  const upgradeFrom8 = { fromRam: 8, vendor: "Alpha Enterprises" };
  /**
   * TOR and BruteSSH.exe owned, so FTPCrack.exe ($1.5m) is next; home's RAM is 8 GB by default, whose upgrade to 16 GB
   * costs $1.01m (16 GB to 32 GB costs $3.19m).
   */
  const afterBruteSsh = (money: number, homeRam = 8) =>
    mediumData(1, { n00dles: true }, { money, hasTorRouter: true, programs: ["BruteSSH.exe"], homeRam });

  test("nothing until the Agent's slow snapshot says which BitNode, then the upgrade", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", afterBruteSsh(1_200_000));
    expect(sentPurchases(connection)).toEqual({ programs: null, homeRam: null });
    expect(controller.homeRamView()).toEqual({
      enabled: true,
      waiting: false,
      ram: 8,
      upgradingTo: null,
      waitingFor: "the Agent's slow snapshot (which BitNode)",
    });
    send(connection, "slow", slowData());
    expect(sentPurchases(connection)).toEqual({ programs: null, homeRam: upgradeFrom8 });
    expect(controller.homeRamView()).toEqual({
      enabled: true,
      waiting: false,
      ram: 8,
      upgradingTo: 16,
      waitingFor: null,
    });
  });

  test("both affordable: the cheaper goes first, and the other says it waits for it", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    // Home at 16 GB: FTPCrack.exe ($1.5m) is cheaper than 32 GB ($3.19m).
    send(connection, "medium", afterBruteSsh(4e6, 16));
    expect(sentPurchases(connection)).toEqual({ programs: { item: "FTPCrack.exe", vendor: null }, homeRam: null });
    expect(controller.homeRamView()).toMatchObject({ upgradingTo: null, waitingFor: "FTPCrack.exe first (cheaper)" });
    // Home at 8 GB: 16 GB ($1.01m) is cheaper than FTPCrack.exe.
    send(connection, "medium", afterBruteSsh(4e6, 8));
    expect(sentPurchases(connection)).toEqual({ programs: null, homeRam: upgradeFrom8 });
    expect(controller.programsView()).toMatchObject({ buying: null, waitingFor: "home RAM to 16 GB first (cheaper)" });
  });

  test("a cheaper upgrade goes while the next program waits for its money", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(1_200_000));
    expect(sentPurchases(connection)).toEqual({ programs: null, homeRam: upgradeFrom8 });
    expect(controller.programsView()).toMatchObject({ waitingFor: "money for FTPCrack.exe ($1,500,000)" });
  });

  test("with the programs' switch off, the upgrade goes even where a program is cheaper", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(4e6, 16));
    controller.setProgramsEnabled(false);
    expect(sentPurchases(connection)).toEqual({
      programs: null,
      homeRam: { fromRam: 16, vendor: "Alpha Enterprises" },
    });
  });

  test("its switch: off upgrades nothing, kept in the store, and the programs carry on", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(1_200_000));
    controller.setHomeRamEnabled(false);
    expect(readHomeRamEnabled(store)).toBe(false);
    expect(desiredStates(connection).at(-1)?.homeRam).toEqual({ enabled: false, next: null });
    expect(controller.homeRamView()).toEqual({
      enabled: false,
      waiting: false,
      ram: 8,
      upgradingTo: null,
      waitingFor: null,
    });
    send(connection, "medium", afterBruteSsh(2_000_000));
    expect(sentPurchases(connection)).toEqual({ programs: { item: "FTPCrack.exe", vendor: null }, homeRam: null });
  });

  test("a disconnect forgets the slow snapshot too", () => {
    const controller = new DesiredStateController({ channel, store });
    const first = connectAgent();
    send(first, "static", network);
    send(first, "slow", slowData());
    send(first, "medium", afterBruteSsh(1_200_000));
    first.dropFromGameSide();
    expect(controller.homeRamView()).toMatchObject({ enabled: true, waiting: true });
    const again = connectAgent("session-2");
    send(again, "static", network, "session-2");
    send(again, "medium", afterBruteSsh(1_200_000), "session-2");
    expect(sentPurchases(again)).toEqual({ programs: null, homeRam: null });
  });
});

test("programs are bought with the hack loop off too, once the Agent's medium snapshot is in", () => {
  store.setSetting("hackLoop.enabled", "false");
  new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "medium", mediumData(1, {}, { money: 1e9 }));
  expect(desiredStates(connection).at(-1)).toEqual({
    hackLoop: loopOff,
    programs: { enabled: true, next: { item: "TOR router", vendor: "Alpha Enterprises" } },
    homeRam: upgradingNothing,
  });
});
