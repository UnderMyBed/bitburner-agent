// The desired state's controller (#134, #136, #138, #141): it turns the switches and the connected Agent's snapshots into the state
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
  type Intent,
  type IntentOutcome,
  type IntentRequest,
  intentId,
  PORT_OPENER_PROGRAMS,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readCloudServersEnabled } from "../src/cloud-servers.ts";
import { DesiredStateController, hackThreadsAddedUp, SAFE_MODE_TTL_MS } from "../src/desired-state.ts";
import { readHackLoopEnabled } from "../src/hack-loop.ts";
import { readHomeRamEnabled } from "../src/home-ram.ts";
import { readManualIntents } from "../src/manual-intents.ts";
import { readProgramsEnabled } from "../src/programs.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
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
/** The desired states sent, without the hack loop's hack threads (#187): "each host's hack threads" checks those. */
const desiredStates = (connection: MemoryConnection) =>
  connection
    .sentMessages()
    .filter((message) => message.type === "desiredState")
    .map((message) => {
      const { hackLoop, intents } = message as unknown as DesiredState;
      const { hackThreads: _hackThreads, ...targetsAndHosts } = hackLoop;
      return { hackLoop: targetsAndHosts, intents };
    });
const network: StaticSnapshotData = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };
const loopOn = { enabled: true, target: "n00dles", hosts: ["n00dles"] };
const loopOff = { enabled: false, target: null, hosts: [] };
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
const buyTor = (vendor = "Alpha Enterprises") => intent({ action: "buyTor", args: { vendor } });
const buyProgram = (program: string) => intent({ action: "buyProgram", args: { program } });
const upgradeHomeRam = (fromRam: number, vendor = "Alpha Enterprises") =>
  intent({ action: "upgradeHomeRam", args: { fromRam, vendor } });

test("on: nothing until the connected Agent's own static and medium snapshots, then the target and hosts", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  expect(controller.hackLoopView()).toEqual({
    enabled: true,
    waiting: true,
    target: null,
    hosts: [],
    hackThreads: null,
    preparing: null,
  });
  send(connection, "static", network);
  expect(desiredStates(connection)).toEqual([]);
  // Nothing rooted yet: on, with no target, so the Agent roots what it can.
  send(connection, "medium", mediumData(1, { home: true, n00dles: false }));
  send(connection, "medium", mediumData(1, { home: true, n00dles: true }));
  expect(desiredStates(connection)).toEqual([
    { hackLoop: { enabled: true, target: null, hosts: [] }, intents: [] },
    { hackLoop: loopOn, intents: [] },
  ]);
  expect(controller.hackLoopView()).toEqual({
    enabled: true,
    waiting: false,
    target: "n00dles",
    hosts: ["n00dles"],
    // Growth 10 at hacking 1: 1 thread (hack-loop.test.ts has the rule).
    hackThreads: 1,
    preparing: null,
  });
});

test("the dashboard's hack threads (#187): the hosts' counts added up; null when one hacks with all its threads", () => {
  expect(hackThreadsAddedUp({ alpha: 16, bravo: 8 }, ["alpha", "bravo"])).toBe(24);
  expect(hackThreadsAddedUp({ alpha: 16, bravo: 8 }, [])).toBe(0);
  // A host the state doesn't name hacks with all its threads: no "at most" to give.
  expect(hackThreadsAddedUp({ alpha: 16 }, ["alpha", "bravo"])).toBeNull();
  for (const none of [undefined, null]) expect(hackThreadsAddedUp(none, ["alpha"])).toBeNull();
});

describe("the move to the next target (#184): prepared while the current one earns", () => {
  // n00dles at hacking 1; zer0 (needs 75) from hacking 150, at 4% of its money until prepared. alpha is the largest host.
  const twoTargets: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0 }),
      staticServer("n00dles", { moneyMax: 1_750_000, serverGrowth: 3_000 }),
      staticServer("zer0", { moneyMax: 187_500_000, serverGrowth: 40, minDifficulty: 10, requiredHackingSkill: 75 }),
      staticServer("alpha", { moneyMax: 0 }),
      staticServer("bravo", { moneyMax: 0 }),
    ],
  };
  /** At `hacking`, zer0 at `zer0Money`, n00dles ready unless `n00dles` says otherwise. */
  const at = (hacking: number, zer0Money: number, n00dles = { moneyAvailable: 1_750_000, hackDifficulty: 1 }) => {
    const data = mediumData(hacking, { home: true, n00dles: true, zer0: true, alpha: true, bravo: true });
    for (const server of data.servers) {
      if (server.hostname === "alpha") server.maxRam = 64;
      if (server.hostname === "n00dles" || server.hostname === "zer0") server.maxRam = 0;
      if (server.hostname === "n00dles") Object.assign(server, n00dles);
      if (server.hostname === "zer0") Object.assign(server, { moneyAvailable: zer0Money, hackDifficulty: 10 });
    }
    return data;
  };
  const earning = { enabled: true, target: "n00dles", hosts: ["alpha", "bravo"] };
  const preparing = {
    enabled: true,
    target: "n00dles",
    hosts: ["bravo"],
    preparing: { target: "zer0", hosts: ["alpha"] },
  };
  const moved = { enabled: true, target: "zer0", hosts: ["alpha", "bravo"] };
  /** n00dles being worked, caught between a hack and its weaken: 60% of its money, security min + 5.1. */
  const WORKED = { moneyAvailable: 1_050_000, hackDifficulty: 6.1 };

  test("earning on n00dles, zer0 is prepared on the largest host, then everything moves once it's ready", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", twoTargets);
    send(connection, "medium", at(100, 7_500_000));
    send(connection, "medium", at(150, 7_500_000));
    // Each host's hack threads (#187), added up per target: bravo hacks n00dles with all 6 of its threads, alpha zer0
    // with 16.
    expect(controller.hackLoopView()).toEqual({
      ...preparing,
      waiting: false,
      hackThreads: 6,
      preparing: { ...preparing.preparing, hackThreads: 16 },
    });
    expect(
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .map((message) => (message as unknown as DesiredState).hackLoop.hackThreads)
        .at(-1),
    ).toEqual({ bravo: 6, alpha: 16 });
    send(connection, "medium", at(150, 100_000_000));
    send(connection, "medium", at(150, 140_625_000));
    // Hacked below 75% again: zer0 is current now, so it stays.
    send(connection, "medium", at(150, 100_000_000));
    expect(desiredStates(connection).map((state) => state.hackLoop)).toEqual([earning, preparing, moved]);
  });

  test("an Agent connecting again within the same reset keeps the target: n00dles caught mid-weaken isn't given up", () => {
    new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", twoTargets);
    send(connection, "slow", slowData());
    send(connection, "medium", at(150, 7_500_000));
    expect(desiredStates(connection).map((state) => state.hackLoop)).toEqual([preparing]);
    // A reload: the same game, n00dles caught between a hack and its weaken (60%, security min + 5.1, not ready), zer0
    // grown to 70%, not ready either. Judged afresh, zer0 (the more of its money, and best) would take every host, and
    // income would stop as on Steam.
    const again = connectAgent();
    send(again, "static", twoTargets);
    send(again, "slow", slowData());
    send(again, "medium", at(150, 131_250_000, WORKED));
    expect(desiredStates(again).map((state) => state.hackLoop)).toEqual([preparing]);
  });

  test("after a reset (another lastAugReset), the target is judged afresh", () => {
    new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", twoTargets);
    send(connection, "slow", slowData());
    send(connection, "medium", at(150, 7_500_000));
    const afterReset = connectAgent("session-2");
    send(afterReset, "static", twoTargets, "session-2");
    send(afterReset, "slow", { ...slowData(), resetInfo: { ...slowData().resetInfo, lastAugReset: 5 } }, "session-2");
    // n00dles back at a fresh start's 4%: nothing is worked, so zer0, best, has both hosts.
    send(afterReset, "medium", at(150, 7_500_000, { moneyAvailable: 70_000, hackDifficulty: 1 }), "session-2");
    expect(desiredStates(afterReset).map((state) => state.hackLoop)).toEqual([moved]);
  });

  test("a brain restart mid-prepare: the target with the most of its money is the one being worked, and earns on", () => {
    const first = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", twoTargets);
    send(connection, "medium", at(150, 7_500_000));
    expect(first.hackLoopView()).toMatchObject(preparing);
    // A new brain on a new channel: nothing set. n00dles mid-weaken at 60%, zer0 grown to 30%.
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    new DesiredStateController({ channel, store });
    const restarted = connectAgent();
    send(restarted, "static", twoTargets);
    send(restarted, "medium", at(150, 56_250_000, WORKED));
    expect(desiredStates(restarted).map((state) => state.hackLoop)).toEqual([preparing]);
  });

  test("off forgets the last target: on again starts from the ready ones", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", twoTargets);
    send(connection, "medium", at(150, 140_625_000));
    controller.setHackLoopEnabled(false);
    send(connection, "medium", at(150, 7_500_000));
    controller.setHackLoopEnabled(true);
    expect(controller.hackLoopView()).toMatchObject({ target: "n00dles", preparing: { target: "zer0" } });
    controller.setHackLoopEnabled(false);
    expect(controller.hackLoopView()).toMatchObject({ preparing: null });
  });
});

test("every state sent carries safe mode's ttlMs (#160): 12 hours, kept by the Agent that long with the brain gone", () => {
  expect(SAFE_MODE_TTL_MS).toBe(12 * 60 * 60_000);
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  controller.setHackLoopEnabled(false);
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }));
  controller.setHackLoopEnabled(true);
  const sent = connection.sentMessages().filter((message) => message.type === "desiredState");
  expect(sent.length).toBeGreaterThanOrEqual(2);
  for (const message of sent) expect(message).toMatchObject({ ttlMs: SAFE_MODE_TTL_MS });
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
  expect(desiredStates(again)).toEqual([{ hackLoop: loopOn, intents: [] }]);
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
  expect(desiredStates(afterReset)).toEqual([{ hackLoop: { enabled: true, target: null, hosts: [] }, intents: [] }]);
});

test("the hack loop's switch: off is sent at once, kept in the store; on again sends the target back", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }));
  controller.setHackLoopEnabled(false);
  expect(readHackLoopEnabled(store)).toBe(false);
  expect(controller.hackLoopView()).toEqual({
    enabled: false,
    waiting: false,
    target: null,
    hosts: [],
    hackThreads: null,
    preparing: null,
  });
  controller.setHackLoopEnabled(true);
  expect(desiredStates(connection).map((state) => state.hackLoop)).toEqual([loopOn, loopOff, loopOn]);
});

test("the hack loop off in the store when the brain starts: off to each Agent as it connects, before any snapshot", () => {
  store.setSetting("hackLoop.enabled", "false");
  new DesiredStateController({ channel, store });
  const connection = connectAgent();
  expect(desiredStates(connection)).toEqual([{ hackLoop: loopOff, intents: [] }]);
});

test("a disconnect forgets the Agent's snapshots: the views show waiting", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }));
  connection.dropFromGameSide();
  expect(controller.hackLoopView()).toEqual({
    enabled: true,
    waiting: true,
    target: null,
    hosts: [],
    hackThreads: null,
    preparing: null,
  });
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
  send(connection, "slow", slowData());
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 100_000 }));
  expect(controller.programsView()).toEqual({
    enabled: true,
    waiting: false,
    owned: [],
    buying: null,
    waitingFor: "money for TOR router ($200,000)",
  });
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 600_000, hasTorRouter: true }));
  expect(desiredStates(connection).at(-1)?.intents).toEqual([buyProgram("BruteSSH.exe")]);
  expect(controller.programsView()).toMatchObject({ owned: ["TOR router"], buying: "BruteSSH.exe", waitingFor: null });
});

test("programs' switch: off buys nothing, kept in the store, and the hack loop carries on", () => {
  const controller = new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "static", network);
  send(connection, "medium", mediumData(1, { n00dles: true }, { money: 1e9 }));
  controller.setProgramsEnabled(false);
  expect(readProgramsEnabled(store)).toBe(false);
  expect(desiredStates(connection).at(-1)).toEqual({ hackLoop: loopOn, intents: [] });
  expect(controller.programsView()).toMatchObject({ enabled: false, buying: null, waitingFor: null });
});

describe("home RAM (#138), one purchase at a time with the programs, cheapest first", () => {
  const sentPurchases = (connection: MemoryConnection) =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => (message as unknown as DesiredState).intents)
      .at(-1);
  const upgradeFrom8 = upgradeHomeRam(8);
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
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.homeRamView()).toEqual({
      enabled: true,
      waiting: false,
      ram: 8,
      upgradingTo: null,
      waitingFor: "the Agent's slow snapshot (which BitNode)",
    });
    send(connection, "slow", slowData());
    expect(sentPurchases(connection)).toEqual([upgradeFrom8]);
    expect(controller.homeRamView()).toEqual({
      enabled: true,
      waiting: false,
      ram: 8,
      upgradingTo: 16,
      waitingFor: null,
    });
  });

  test("with home RAM on, no program before the slow snapshot: which goes first isn't known until then", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    // FTPCrack.exe affordable, but 16 GB is cheaper: without the BitNode, the brain can't tell, so it buys neither.
    send(connection, "medium", afterBruteSsh(2e6));
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.programsView()).toMatchObject({
      waitingFor: "the Agent's slow snapshot (which BitNode), to compare with home RAM",
    });
    send(connection, "slow", slowData());
    expect(sentPurchases(connection)).toEqual([upgradeFrom8]);
    // With home RAM off, the programs don't wait for it.
    controller.setHomeRamEnabled(false);
    expect(sentPurchases(connection)).toEqual([buyProgram("FTPCrack.exe")]);
  });

  test("both affordable: the cheaper goes first, and the other says it waits for it", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    // Home at 16 GB: FTPCrack.exe ($1.5m) is cheaper than 32 GB ($3.19m).
    send(connection, "medium", afterBruteSsh(4e6, 16));
    expect(sentPurchases(connection)).toEqual([buyProgram("FTPCrack.exe")]);
    expect(controller.homeRamView()).toMatchObject({ upgradingTo: null, waitingFor: "FTPCrack.exe first (cheaper)" });
    // Home at 8 GB: 16 GB ($1.01m) is cheaper than FTPCrack.exe.
    send(connection, "medium", afterBruteSsh(4e6, 8));
    expect(sentPurchases(connection)).toEqual([upgradeFrom8]);
    expect(controller.programsView()).toMatchObject({ buying: null, waitingFor: "home RAM to 16 GB first (cheaper)" });
  });

  test("a cheaper upgrade goes while the next program waits for its money", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(1_200_000));
    expect(sentPurchases(connection)).toEqual([upgradeFrom8]);
    expect(controller.programsView()).toMatchObject({ waitingFor: "money for FTPCrack.exe ($1,500,000)" });
  });

  test("with the programs' switch off, the upgrade goes even where a program is cheaper", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(4e6, 16));
    controller.setProgramsEnabled(false);
    expect(sentPurchases(connection)).toEqual([upgradeHomeRam(16)]);
  });

  test("its switch: off upgrades nothing, kept in the store, and the programs carry on", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", afterBruteSsh(1_200_000));
    controller.setHomeRamEnabled(false);
    expect(readHomeRamEnabled(store)).toBe(false);
    expect(desiredStates(connection).at(-1)?.intents).toEqual([]);
    expect(controller.homeRamView()).toEqual({
      enabled: false,
      waiting: false,
      ram: 8,
      upgradingTo: null,
      waitingFor: null,
    });
    send(connection, "medium", afterBruteSsh(2_000_000));
    expect(sentPurchases(connection)).toEqual([buyProgram("FTPCrack.exe")]);
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
    expect(sentPurchases(again)).toEqual([]);
  });
});

test("programs are bought with the hack loop off too, once the Agent's medium snapshot is in", () => {
  store.setSetting("hackLoop.enabled", "false");
  new DesiredStateController({ channel, store });
  const connection = connectAgent();
  send(connection, "slow", slowData());
  send(connection, "medium", mediumData(1, {}, { money: 1e9 }));
  expect(desiredStates(connection).at(-1)).toEqual({ hackLoop: loopOff, intents: [buyTor()] });
});

describe("the manual queue (#141, owner decision 36)", () => {
  const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });

  test("a queued intent goes first, at once, and is kept across restarts of the brain", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", mediumData(1, { n00dles: true }, { money: 1e9 }));
    expect(controller.addManualIntent({ action: "travel", args: { city: "Aevum" } })).toEqual({
      ok: true,
      intent: AEVUM,
    });
    expect(desiredStates(connection).at(-1)?.intents).toEqual([AEVUM, buyTor()]);
    expect(controller.intentsView().map((view) => [view.id, view.source])).toEqual([
      [AEVUM.id, "manual"],
      [buyTor().id, "purchase"],
    ]);
    // In the store, so a new brain has the queue too.
    expect(readManualIntents(store)).toEqual([AEVUM]);
  });

  test("queued twice is queued once; what isn't valid is refused, with a reason", () => {
    const controller = new DesiredStateController({ channel, store });
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(controller.addManualIntent({ action: "travel", args: { city: "Atlantis" } })).toMatchObject({ ok: false });
    expect(controller.addManualIntent({ action: "rm -rf", args: {} })).toMatchObject({ ok: false });
    expect(readManualIntents(store)).toEqual([AEVUM]);
  });

  test("the owner's purchase, queued by hand, goes once, as the owner's", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    controller.addManualIntent({ action: "buyTor", args: { vendor: "Alpha Enterprises" } });
    send(connection, "medium", mediumData(1, { n00dles: true }, { money: 1e9 }));
    expect(desiredStates(connection).at(-1)?.intents).toEqual([buyTor()]);
    expect(controller.intentsView()).toMatchObject([{ id: buyTor().id, source: "manual" }]);
  });

  const fastWith = (...intents: IntentOutcome[]) => ({
    degradedTiers: [],
    pageHeapUsedBytes: null,
    game: null,
    intents,
  });
  const doneOutcome = (id: string): IntentOutcome => ({ id, done: true, tries: 1, problem: null, backend: "ui" });

  test("reported done by the Agent, it leaves the queue; cancelled, it leaves at once", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", mediumData(1, { n00dles: true }));
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
    send(connection, "fast", fastWith(doneOutcome("travel(Aevum)")));
    expect(
      desiredStates(connection)
        .at(-1)
        ?.intents.map((each) => each.id),
    ).toEqual(["travel(Volhaven)"]);
    expect(controller.cancelManualIntent("travel(Volhaven)")).toBe(true);
    expect(controller.cancelManualIntent("travel(Volhaven)")).toBe(false);
    expect(desiredStates(connection).at(-1)?.intents).toEqual([]);
  });

  test("a round trip keeps both legs: a snapshot showing the player in the second leg's city takes nothing off", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    controller.addManualIntent({ action: "travel", args: { city: "Sector-12" } });
    send(connection, "medium", mediumData(1, { n00dles: true }, { city: "Sector-12" }));
    expect(controller.intentsView().map((view) => view.id)).toEqual(["travel(Aevum)", "travel(Sector-12)"]);
  });

  test("full at 98, leaving room for the purchase and the backdoor (#195) in the protocol's 100: the 99th is refused", () => {
    const controller = new DesiredStateController({ channel, store });
    const vendors = ["Alpha Enterprises", "NetLink Technologies", "Omega Software", "CompuTek"];
    for (let index = 0; index < 98; index += 1) {
      const args = { fromRam: 2 ** (index % 30), vendor: vendors[Math.floor(index / 30)] };
      expect(controller.addManualIntent({ action: "upgradeHomeRam", args })).toMatchObject({ ok: true });
    }
    expect(controller.addManualIntent({ action: "travel", args: { city: "Aevum" } })).toEqual({
      ok: false,
      reason: "the manual queue is full: 98 intents at most",
    });
    expect(readManualIntents(store)).toHaveLength(98);
  });

  test("the queue is shown without an Agent, so it can be cancelled; malformed outcomes are left out", () => {
    const controller = new DesiredStateController({ channel, store });
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome: null, waitingFor: null }]);
    const connection = connectAgent();
    send(connection, "fast", { ...fastWith(), intents: [{ id: AEVUM.id, done: "yes", tries: 1, problem: null }] });
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome: null, waitingFor: null }]);
  });

  test("an Agent from before backends (#145) sends outcomes without one: kept, with the backend unknown", () => {
    const controller = new DesiredStateController({ channel, store });
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    const connection = connectAgent();
    send(connection, "fast", {
      ...fastWith(),
      intents: [{ id: AEVUM.id, done: false, tries: 1, problem: "no Travel" }],
    });
    expect(controller.intentsView()).toEqual([
      {
        id: AEVUM.id,
        source: "manual",
        outcome: { id: AEVUM.id, done: false, tries: 1, problem: "no Travel", backend: null },
        waitingFor: null,
      },
    ]);
  });

  test("with the hack loop off, the queue goes before any snapshot: each intent checks the game first", () => {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(desiredStates(connection).at(-1)).toEqual({ hackLoop: loopOff, intents: [AEVUM] });
  });

  test("the view shows how each went, from the connected Agent's latest fast snapshot", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", mediumData(1, { n00dles: true }));
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome: null, waitingFor: null }]);
    const outcome: IntentOutcome = {
      id: AEVUM.id,
      done: false,
      tries: 2,
      problem: "no Travel in the sidebar",
      backend: "ui",
    };
    send(connection, "fast", fastWith(outcome));
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome, waitingFor: null }]);
    connection.dropFromGameSide();
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome: null, waitingFor: null }]);
    // A new Agent holds no intents yet: the last one's outcomes aren't its own.
    const again = connectAgent("session-2");
    send(again, "static", network, "session-2");
    send(again, "medium", mediumData(1, { n00dles: true }), "session-2");
    expect(controller.intentsView()).toEqual([{ id: AEVUM.id, source: "manual", outcome: null, waitingFor: null }]);
  });

  test("a store value the brain didn't write fails, rather than guess", () => {
    store.setSetting("intents.manual", '[{"action":"travel","args":{"city":"Atlantis"}}]');
    expect(() => new DesiredStateController({ channel, store })).toThrow(/intents\.manual/);
  });
});

describe("backdoors for the hacker factions (#195)", () => {
  /** CSEC, needing hacking 54 and 1 port, beside n00dles. */
  const withCsec: StaticSnapshotData = {
    servers: [
      ...network.servers,
      staticServer("CSEC", { moneyMax: 0, requiredHackingSkill: 54, numOpenPortsRequired: 1 }),
    ],
  };
  const BACKDOOR_CSEC = intent({ action: "backdoor", args: { hostname: "CSEC" } });
  /** A medium snapshot at `hacking`, CSEC rooted and backdoored as said, with TOR and BruteSSH.exe owned. */
  const csecAt = (hacking: number, { rooted = true, backdoored = false, money = 0 } = {}) => {
    const data = mediumData(
      hacking,
      { n00dles: true, CSEC: rooted },
      { money, hasTorRouter: true, programs: ["BruteSSH.exe"] },
    );
    for (const server of data.servers) if (server.hostname === "CSEC") server.backdoorInstalled = backdoored;
    return data;
  };
  const lastIntents = (connection: MemoryConnection) => desiredStates(connection).at(-1)?.intents;

  test("asked for once rooted and at its level, as source backdoor, until installed and reported done", () => {
    const lines: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "medium", csecAt(60, { rooted: false }));
    expect(lastIntents(connection)).toEqual([]);
    send(connection, "medium", csecAt(53));
    expect(lastIntents(connection)).toEqual([]);
    send(connection, "medium", csecAt(54));
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC]);
    expect(controller.intentsView()).toEqual([
      { id: BACKDOOR_CSEC.id, source: "backdoor", outcome: null, waitingFor: null },
    ]);
    // Reported done: still sent, so the Agent keeps it done, until a medium snapshot shows it installed.
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: BACKDOOR_CSEC.id, done: true, tries: 2, problem: null, backend: "sim" }],
      dialogs: { handled: [], blocking: null },
    });
    send(connection, "medium", csecAt(55));
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC]);
    send(connection, "medium", csecAt(55, { backdoored: true }));
    expect(lastIntents(connection)).toEqual([]);
    expect(controller.intentsView()).toEqual([]);
    expect(lines).toEqual([
      "backdoor: asking for CSEC (hacking 54, needs 54), for CyberSec's invitation",
      "backdoor: CSEC backdoored, 0 s after it was asked for",
    ]);
  });

  test("installed but not yet reported done: still sent, so the Agent's next try sends the terminal home", () => {
    new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "medium", csecAt(60));
    send(connection, "medium", csecAt(60, { backdoored: true }));
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC]);
    const fast = (done: boolean) => ({
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: BACKDOOR_CSEC.id, done, tries: done ? 2 : 1, problem: null, backend: "ui" }],
      dialogs: { handled: [], blocking: null },
    });
    send(connection, "fast", fast(false));
    send(connection, "medium", csecAt(60, { backdoored: true }));
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC]);
    send(connection, "fast", fast(true));
    send(connection, "medium", csecAt(60, { backdoored: true }));
    expect(lastIntents(connection)).toEqual([]);
  });

  test("an Agent that reconnects while it's installed but not reported done is given it again, until it says done", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "medium", csecAt(60));
    send(connection, "medium", csecAt(60, { backdoored: true }));
    connection.dropFromGameSide();
    const again = connectAgent("session-2");
    send(again, "static", withCsec, "session-2");
    send(again, "medium", csecAt(60, { backdoored: true }), "session-2");
    expect(lastIntents(again)).toEqual([BACKDOOR_CSEC]);
    expect(controller.backdoorsDue()).toEqual([]);
    send(
      again,
      "fast",
      {
        degradedTiers: [],
        pageHeapUsedBytes: null,
        game: null,
        intents: [{ id: BACKDOOR_CSEC.id, done: true, tries: 1, problem: null, backend: "ui" }],
        dialogs: { handled: [], blocking: null },
      },
      "session-2",
    );
    send(again, "medium", csecAt(60, { backdoored: true }), "session-2");
    expect(lastIntents(again)).toEqual([]);
  });

  test("backdoorsDue(): the servers due and since when, for the backdoorOverdue alert; none once disconnected", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "medium", csecAt(60));
    expect(controller.backdoorsDue()).toEqual([{ hostname: "CSEC", sinceMs: expect.any(Number) }]);
    connection.dropFromGameSide();
    expect(controller.backdoorsDue()).toEqual([]);
  });

  test("a queue stored under the old limit (99) leaves the backdoor out, logged once, so the state stays at 100", () => {
    const lines: string[] = [];
    const vendors = ["Alpha Enterprises", "NetLink Technologies", "Omega Software", "CompuTek"];
    const queue = Array.from({ length: 99 }, (_, index) =>
      intent({
        action: "upgradeHomeRam",
        args: { fromRam: 2 ** (index % 30), vendor: vendors[Math.floor(index / 30)] as string },
      }),
    );
    store.setSetting("intents.manual", JSON.stringify(queue));
    store.setSetting("homeRam.enabled", "false");
    new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "slow", slowData());
    send(connection, "medium", csecAt(60, { money: 2_000_000 }));
    send(connection, "medium", csecAt(61, { money: 2_000_000 }));
    expect(lastIntents(connection)).toHaveLength(100);
    expect(lastIntents(connection)?.at(-1)).toEqual(buyProgram("FTPCrack.exe"));
    expect(lines.filter((line) => line.startsWith("intents:"))).toEqual([
      "intents: the manual queue holds 99, over its 98: backdoor(CSEC) wait for room in the protocol's 100 (cancel one)",
    ]);
  });

  test("after the purchase, so a `buy` never waits for its terminal action; once if the owner queued it too", () => {
    store.setSetting("homeRam.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "slow", slowData());
    send(connection, "medium", csecAt(60, { money: 2_000_000 }));
    expect(lastIntents(connection)).toEqual([buyProgram("FTPCrack.exe"), BACKDOOR_CSEC]);
    controller.addManualIntent({ action: "backdoor", args: { hostname: "CSEC" } });
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC, buyProgram("FTPCrack.exe")]);
    expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
      [BACKDOOR_CSEC.id, "manual"],
      ["buyProgram(FTPCrack.exe)", "purchase"],
    ]);
  });

  test("with the hack loop off too; none before the connected Agent's snapshots, nor after it disconnects", () => {
    store.setSetting("hackLoop.enabled", "false");
    new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    expect(lastIntents(connection)).toEqual([]);
    send(connection, "medium", csecAt(60));
    expect(desiredStates(connection).at(-1)).toEqual({ hackLoop: loopOff, intents: [BACKDOOR_CSEC] });
    connection.dropFromGameSide();
    const again = connectAgent("session-2");
    expect(lastIntents(again)).toEqual([]);
  });
});

describe("irreversible intents (#147): the guard on two consecutive medium snapshots, then a save backup", () => {
  const SECTOR_12 = intent({ action: "joinFaction", args: { faction: "Sector-12" } });
  const CHONGQING = intent({ action: "joinFaction", args: { faction: "Chongqing" } });
  const CYBERSEC = intent({ action: "joinFaction", args: { faction: "CyberSec" } });
  const SAVED: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
  const FAILED: SaveBackupEvent = { type: "saveBackup", atMs: 1, failure: "the game sent its save as text" };
  const counting = (held: number, of = 2) =>
    `waiting for the guard to hold on ${of} consecutive medium snapshots (${held} so far)`;

  /** A stand-in for the brain's save backups: each `backupNow` waits until the test settles it. */
  function standInBackups() {
    const pending: ((event: SaveBackupEvent) => void)[] = [];
    const backupNow = vi.fn(
      () =>
        new Promise<SaveBackupEvent>((resolve) => {
          pending.push(resolve);
        }),
    );
    const letItRun = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** Settles the oldest backup asked for with `event`, and lets the controller see it. */
    const settleBackup = async (event: SaveBackupEvent) => {
      pending.shift()?.(event);
      await letItRun();
    };
    /** Settles the newest. */
    const settleNewestBackup = async (event: SaveBackupEvent) => {
      pending.pop()?.(event);
      await letItRun();
    };
    return { saveBackups: { backupNow }, backupNow, settleBackup, settleNewestBackup };
  }

  /** An Agent connected with its static snapshot sent, the hack loop off so the intents go without a medium one. */
  function connectedWithLoopOff() {
    store.setSetting("hackLoop.enabled", "false");
    const backups = standInBackups();
    const controller = new DesiredStateController({ channel, store, saveBackups: backups.saveBackups });
    const connection = connectAgent();
    send(connection, "static", network);
    const sentIds = () =>
      desiredStates(connection)
        .at(-1)
        ?.intents.map((each) => each.id) ?? [];
    const medium = (factions: string[] = []) => send(connection, "medium", mediumData(1, {}, { factions }));
    const waitingFor = (id: string) => controller.intentsView().find((view) => view.id === id)?.waitingFor;
    /** Two medium snapshots and the backup's success: the first irreversible intent released. */
    const release = async (factions: string[] = []) => {
      medium(factions);
      medium(factions);
      await backups.settleBackup(SAVED);
    };
    return { controller, connection, sentIds, medium, waitingFor, release, ...backups };
  }

  /** A new brain on the same store (and so the same queue): its own channel and controller, with stand-in backups. */
  function restartedBrain() {
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const backups = standInBackups();
    const restarted = new DesiredStateController({ channel, store, saveBackups: backups.saveBackups });
    return { restarted, ...backups };
  }

  test("a reversible intent goes out at once; an irreversible one waits, its view saying for what", () => {
    const { controller, sentIds, waitingFor } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "CyberSec" } });
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    expect(sentIds()).toEqual([CYBERSEC.id]);
    expect(waitingFor(CYBERSEC.id)).toBeNull();
    expect(waitingFor(SECTOR_12.id)).toBe(counting(0));
  });

  test("two medium snapshots with the guard holding, then a backup is asked for; it goes out on that backup's success", async () => {
    const { controller, sentIds, medium, waitingFor, backupNow, settleBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    expect(backupNow).not.toHaveBeenCalled();
    expect(waitingFor(SECTOR_12.id)).toBe(counting(1));
    medium();
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe("waiting for a save backup");
    // More snapshots while it's taken ask for no other.
    medium();
    expect(backupNow).toHaveBeenCalledTimes(1);
    await settleBackup(SAVED);
    expect(sentIds()).toEqual([SECTOR_12.id]);
    expect(waitingFor(SECTOR_12.id)).toBeNull();
  });

  test("a failed backup starts the count again, with a minute of snapshots before the next", async () => {
    const { controller, sentIds, medium, waitingFor, backupNow, settleBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    medium();
    await settleBackup(FAILED);
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe(`${counting(0, 6)}: the save backup failed: the game sent its save as text`);
    for (let each = 0; each < 5; each += 1) medium();
    expect(backupNow).toHaveBeenCalledTimes(1);
    medium();
    expect(backupNow).toHaveBeenCalledTimes(2);
    await settleBackup(SAVED);
    expect(sentIds()).toEqual([SECTOR_12.id]);
  });

  test("the guard failing starts the count again, saying why: an enemy joined", () => {
    const { controller, sentIds, medium, waitingFor, backupNow } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    medium(["Chongqing"]);
    expect(waitingFor(SECTOR_12.id)).toBe("held: Sector-12's enemy Chongqing is joined");
    medium();
    expect(backupNow).not.toHaveBeenCalled();
    expect(sentIds()).toEqual([]);
  });

  test("a guard that fails while the backup is taken: that backup's success releases nothing", async () => {
    const { controller, sentIds, medium, waitingFor, settleBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    medium();
    medium(["Volhaven"]);
    await settleBackup(SAVED);
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe("held: Sector-12's enemy Volhaven is joined");
  });

  test("a backup asked for before the count started again releases nothing, even once the next is asked for", async () => {
    const { controller, sentIds, medium, backupNow, settleBackup, settleNewestBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    medium();
    medium(["Volhaven"]);
    medium();
    medium();
    expect(backupNow).toHaveBeenCalledTimes(2);
    // The first one's answer comes now: it isn't for this count.
    await settleBackup(SAVED);
    expect(sentIds()).toEqual([]);
    await settleNewestBackup(SAVED);
    expect(sentIds()).toEqual([SECTOR_12.id]);
  });

  test("a medium snapshot without the factions joined holds it: the guard fails closed, and nothing throws", () => {
    const { controller, connection, sentIds, waitingFor, backupNow } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    send(connection, "medium", { ...mediumData(1, {}), player: { money: 0 } });
    send(connection, "medium", { ...mediumData(1, {}), player: undefined });
    expect(backupNow).not.toHaveBeenCalled();
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe("held: the medium snapshot has no list of the factions joined");
  });

  test("one irreversible intent at a time: the next is judged only once the first is done, so enemies never go together", async () => {
    const { controller, connection, sentIds, medium, waitingFor, release } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Chongqing" } });
    expect(waitingFor(CHONGQING.id)).toBe(
      "waiting for joinFaction(Sector-12) first: one irreversible intent at a time",
    );
    await release();
    expect(sentIds()).toEqual([SECTOR_12.id]);
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: SECTOR_12.id, done: true, tries: 1, problem: null, backend: "ui" }],
    });
    medium(["Sector-12"]);
    expect(sentIds()).toEqual([]);
    expect(waitingFor(CHONGQING.id)).toBe("held: Chongqing's enemy Sector-12 is joined");
  });

  test("once out, its guard is still judged: failing, it's withdrawn", async () => {
    const { controller, sentIds, medium, waitingFor, release } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    await release();
    expect(sentIds()).toEqual([SECTOR_12.id]);
    medium(["Ishima"]);
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe("held: Sector-12's enemy Ishima is joined");
  });

  test("out for 60 medium snapshots and not done: withdrawn until a new backup, so the backup is never stale", async () => {
    const { controller, sentIds, medium, waitingFor, backupNow, release, settleBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    await release();
    for (let each = 0; each < 59; each += 1) medium();
    expect(sentIds()).toEqual([SECTOR_12.id]);
    medium();
    expect(sentIds()).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe(
      `${counting(0)}: out 60 medium snapshots without being done, it needs a new backup`,
    );
    medium();
    medium();
    expect(backupNow).toHaveBeenCalledTimes(2);
    await settleBackup(SAVED);
    expect(sentIds()).toEqual([SECTOR_12.id]);
  });

  test("a disconnect starts the count again, and a backup that ends after it releases nothing", async () => {
    const { controller, connection, medium, waitingFor, settleBackup } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    medium();
    medium();
    connection.dropFromGameSide();
    await settleBackup(SAVED);
    const again = connectAgent("session-2");
    send(again, "static", network, "session-2");
    expect(desiredStates(again).at(-1)?.intents).toEqual([]);
    expect(waitingFor(SECTOR_12.id)).toBe(counting(0));
  });

  test("done, it leaves the queue and the gate", async () => {
    const { controller, sentIds, connection, release } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    await release();
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: SECTOR_12.id, done: true, tries: 1, problem: null, backend: "ui" }],
    });
    expect(sentIds()).toEqual([]);
    expect(controller.intentsView()).toEqual([]);
  });

  test("a held one doesn't hold up the intents queued after it", () => {
    const { controller, sentIds } = connectedWithLoopOff();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
    expect(sentIds()).toEqual(["travel(Aevum)"]);
  });

  test("a brain that takes no save backups never sends one, and says so", () => {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Sector-12" } });
    send(connection, "medium", mediumData(1, {}));
    send(connection, "medium", mediumData(1, {}));
    expect(desiredStates(connection).at(-1)?.intents).toEqual([]);
    expect(controller.intentsView()[0]?.waitingFor).toBe("waiting for a save backup, which this brain doesn't take");
  });

  describe("installing augmentations (#164)", () => {
    const INSTALL = intent({ action: "installAugmentations", args: {} });
    const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });
    const VOLHAVEN = intent({ action: "travel", args: { city: "Volhaven" } });
    const AFTER_INSTALL =
      "waiting for installAugmentations() first: queued after an install, it's for the game after the reset";
    const slowAt = (lastAugReset: number) => ({ ...slowData(), resetInfo: { ...slowData().resetInfo, lastAugReset } });
    const reportedDone = (connection: MemoryConnection, id: string, agentSessionId = "session-1") =>
      send(
        connection,
        "fast",
        {
          degradedTiers: [],
          pageHeapUsedBytes: null,
          game: null,
          intents: [{ id, done: true, tries: 1, problem: null, backend: "sim" }],
        },
        agentSessionId,
      );

    test("its guard: what's queued before it goes first; what's queued after it waits for it", async () => {
      const { controller, connection, sentIds, medium, waitingFor, backupNow, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_000));
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
      expect(sentIds()).toEqual([AEVUM.id]);
      expect(waitingFor(VOLHAVEN.id)).toBe(AFTER_INSTALL);
      medium();
      medium();
      expect(waitingFor(INSTALL.id)).toBe("held: travel(Aevum), queued before it, isn't done");
      expect(backupNow).not.toHaveBeenCalled();
      // The travel done, the install's count starts, and it goes on its backup's success; Volhaven still waits.
      reportedDone(connection, AEVUM.id);
      await release();
      expect(sentIds()).toEqual([INSTALL.id]);
      expect(waitingFor(VOLHAVEN.id)).toBe(AFTER_INSTALL);
    });

    test("sent, then the game resets: the next Agent's slow snapshot takes it off the queue, and what's after it goes", async () => {
      const { controller, connection, sentIds, backupNow, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_000));
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
      await release();
      expect(sentIds()).toEqual([INSTALL.id]);
      // A slow snapshot of the same game changes nothing.
      send(connection, "slow", slowAt(1_000));
      expect(sentIds()).toEqual([INSTALL.id]);
      // The install kills the Agent; the next one connects to the reset game.
      connection.dropFromGameSide();
      const again = connectAgent("session-2");
      send(again, "static", network, "session-2");
      expect(controller.intentsView().map((view) => view.id)).toEqual([INSTALL.id, VOLHAVEN.id]);
      send(again, "slow", slowAt(90_000), "session-2");
      expect(readManualIntents(store).map((each) => each.id)).toEqual([VOLHAVEN.id]);
      expect(
        desiredStates(again)
          .at(-1)
          ?.intents.map((each) => each.id),
      ).toEqual([VOLHAVEN.id]);
      // Not gated and backed up again for the new game.
      expect(backupNow).toHaveBeenCalledTimes(1);
    });

    test("a reset with the clock set back (#167): an earlier lastAugReset is another reset all the same, and takes it off", async () => {
      const { controller, connection, sentIds, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_767_225_600_000));
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      await release();
      expect(sentIds()).toEqual([INSTALL.id]);
      // The game sets it from the clock (E2's page clock starts near 0, the save's from 2026).
      send(connection, "slow", slowAt(82_500));
      expect(readManualIntents(store)).toEqual([]);
    });

    test("a brain restarted mid-install knows it was sent (#175: the note is in the store): the reset takes it off, no second gate", async () => {
      const { controller, connection, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_000));
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      await release();
      connection.dropFromGameSide();
      const { restarted, backupNow } = restartedBrain();
      const again = connectAgent("session-2");
      send(again, "static", network, "session-2");
      expect(restarted.intentsView()).toMatchObject([{ id: INSTALL.id, waitingFor: counting(0) }]);
      send(again, "slow", slowAt(90_000), "session-2");
      expect(restarted.intentsView()).toEqual([]);
      expect(backupNow).not.toHaveBeenCalled();
    });

    test("a brain restarted before the install: the same game's slow snapshot keeps it, gated again", async () => {
      const { controller, connection, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_000));
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      await release();
      connection.dropFromGameSide();
      const { restarted } = restartedBrain();
      const again = connectAgent("session-2");
      send(again, "static", network, "session-2");
      send(again, "slow", slowAt(1_000), "session-2");
      expect(restarted.intentsView()).toMatchObject([{ id: INSTALL.id, waitingFor: counting(0) }]);
      // The Agent checks the game first: nothing left to install is done.
      reportedDone(again, INSTALL.id, "session-2");
      expect(restarted.intentsView()).toEqual([]);
    });

    test("cancelled once sent, it's forgotten: queued again, a reset seen before it's sent again doesn't count", async () => {
      const { controller, connection, sentIds, release } = connectedWithLoopOff();
      send(connection, "slow", slowAt(1_000));
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      await release();
      expect(controller.cancelManualIntent(INSTALL.id)).toBe(true);
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      expect(sentIds()).toEqual([]);
      send(connection, "slow", slowAt(90_000));
      expect(controller.intentsView().map((view) => view.id)).toEqual([INSTALL.id]);
    });
  });

  describe("destroying the BitNode (#175)", () => {
    const DESTROY = intent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
    const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });
    const VOLHAVEN = intent({ action: "travel", args: { city: "Volhaven" } });
    const AFTER_DESTROY = "waiting for destroyBitNode(2) first: queued after a destroy, it's for the next BitNode";
    const WD = "w0r1d_d43m0n";
    /** The static snapshot once The Red Pill is installed: w0r1d_d43m0n among the servers, needing `required`. */
    const staticWithDaemon = (required = 3000): StaticSnapshotData => ({
      servers: [...network.servers, staticServer(WD, { requiredHackingSkill: required, numOpenPortsRequired: 5 })],
    });
    const slowAt = (lastAugReset: number, lastNodeReset: number) => ({
      ...slowData(),
      resetInfo: { ...slowData().resetInfo, lastAugReset, lastNodeReset },
    });

    /** Connected as above, with w0r1d_d43m0n in the static snapshot, and the game's last resets at 1,000. */
    function readyToDestroy({ withSlow = true } = {}) {
      const connected = connectedWithLoopOff();
      send(connected.connection, "static", staticWithDaemon());
      if (withSlow) send(connected.connection, "slow", slowAt(1_000, 1_000));
      /** A medium snapshot at `hacking`, with w0r1d_d43m0n reachable and rooted, unless said. */
      const daemonMedium = (hacking = 3000, { reachable = true, rooted = true } = {}) =>
        send(connected.connection, "medium", mediumData(hacking, reachable ? { [WD]: rooted } : {}));
      const releaseDestroy = async () => {
        daemonMedium();
        daemonMedium();
        await connected.settleBackup(SAVED);
      };
      return { ...connected, daemonMedium, releaseDestroy };
    }

    test("its guard: what's queued before it first, then w0r1d_d43m0n's preconditions, each saying why, before any backup", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, daemonMedium, releaseDestroy } = readyToDestroy();
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
      expect(sentIds()).toEqual([AEVUM.id]);
      expect(waitingFor(VOLHAVEN.id)).toBe(AFTER_DESTROY);
      daemonMedium();
      expect(waitingFor(DESTROY.id)).toBe("held: travel(Aevum), queued before it, isn't done");
      send(connection, "fast", {
        degradedTiers: [],
        pageHeapUsedBytes: null,
        game: null,
        intents: [{ id: AEVUM.id, done: true, tries: 1, problem: null, backend: "sim" }],
      });
      daemonMedium(3000, { reachable: false });
      expect(waitingFor(DESTROY.id)).toBe("held: w0r1d_d43m0n isn't reachable: The Red Pill isn't installed");
      daemonMedium(3000, { rooted: false });
      expect(waitingFor(DESTROY.id)).toBe("held: no root access on w0r1d_d43m0n (NUKE.exe first)");
      daemonMedium(2999);
      expect(waitingFor(DESTROY.id)).toBe("held: hacking level 2999: w0r1d_d43m0n needs 3000");
      expect(backupNow).not.toHaveBeenCalled();
      expect(sentIds()).toEqual([]);
      await releaseDestroy();
      expect(sentIds()).toEqual([DESTROY.id]);
      expect(waitingFor(VOLHAVEN.id)).toBe(AFTER_DESTROY);
      // Once out, still judged: the level short again (an augmentation's multiplier gone), it's withdrawn.
      daemonMedium(10);
      expect(sentIds()).toEqual([]);
    });

    test("no slow snapshot yet: past its gate, not sent until one says the game's last reset, so its done check can't miss", async () => {
      const { controller, connection, sentIds, waitingFor, releaseDestroy } = readyToDestroy({ withSlow: false });
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      await releaseDestroy();
      expect(sentIds()).toEqual([]);
      expect(waitingFor(DESTROY.id)).toBe(
        "waiting for the Agent's slow snapshot (the game's last reset), to see the reset when it comes",
      );
      // The reset can't come unseen: with none sent, the next BitNode's slow snapshot finds it still queued, unsent.
      send(connection, "slow", slowAt(1_000, 1_000));
      expect(sentIds()).toEqual([DESTROY.id]);
      expect(waitingFor(DESTROY.id)).toBeNull();
      // Sent now, with the reset noted: the next BitNode's takes it off.
      send(connection, "slow", slowAt(90_000, 90_000));
      expect(readManualIntents(store)).toEqual([]);
    });

    test("an install too waits for the slow snapshot before it goes", async () => {
      const { controller, connection, sentIds, release } = connectedWithLoopOff();
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      await release();
      expect(sentIds()).toEqual([]);
      send(connection, "slow", slowData());
      expect(sentIds()).toEqual(["installAugmentations()"]);
    });

    test("the level is the BitNode's: the static snapshot's required hacking, and fails closed without it", () => {
      const { controller, connection, waitingFor, backupNow, daemonMedium } = readyToDestroy();
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      // BN2's w0r1d_d43m0n needs 5 × 3000 (`WorldDaemonDifficulty`).
      send(connection, "static", staticWithDaemon(15_000));
      daemonMedium(14_999);
      expect(waitingFor(DESTROY.id)).toBe("held: hacking level 14999: w0r1d_d43m0n needs 15000");
      send(connection, "static", network);
      daemonMedium();
      expect(waitingFor(DESTROY.id)).toBe("held: the static snapshot has no required hacking level for w0r1d_d43m0n");
      send(connection, "static", staticWithDaemon());
      send(connection, "medium", { ...mediumData(3000, { [WD]: true }), player: { money: 0 } });
      expect(waitingFor(DESTROY.id)).toBe("held: the medium snapshot has no hacking level");
      expect(backupNow).not.toHaveBeenCalled();
    });

    test("sent, then the next BitNode: the next Agent's slow snapshot with another lastNodeReset takes it off, and what's after it goes", async () => {
      const { controller, connection, sentIds, backupNow, releaseDestroy } = readyToDestroy();
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
      await releaseDestroy();
      expect(sentIds()).toEqual([DESTROY.id]);
      // An install alone moves only lastAugReset: not a destroy.
      send(connection, "slow", slowAt(5_000, 1_000));
      expect(sentIds()).toEqual([DESTROY.id]);
      connection.dropFromGameSide();
      const again = connectAgent("session-2");
      send(again, "static", network, "session-2");
      send(again, "slow", slowAt(90_000, 90_000), "session-2");
      expect(readManualIntents(store).map((each) => each.id)).toEqual([VOLHAVEN.id]);
      expect(
        desiredStates(again)
          .at(-1)
          ?.intents.map((each) => each.id),
      ).toEqual([VOLHAVEN.id]);
      expect(backupNow).toHaveBeenCalledTimes(1);
    });

    test("a brain restarted mid-destroy knows it was sent: the next BitNode's slow snapshot takes it off, never gated there", async () => {
      const { controller, connection, releaseDestroy } = readyToDestroy();
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      await releaseDestroy();
      connection.dropFromGameSide();
      const { restarted, backupNow } = restartedBrain();
      const again = connectAgent("session-2");
      send(again, "static", network, "session-2");
      send(again, "slow", slowAt(90_000, 90_000), "session-2");
      expect(restarted.intentsView()).toEqual([]);
      expect(readManualIntents(store)).toEqual([]);
      expect(backupNow).not.toHaveBeenCalled();
    });

    test("an install queued after a destroy waits for it; the destroy's note is its own, and the install's comes after", async () => {
      const { controller, connection, sentIds, waitingFor, releaseDestroy, release } = readyToDestroy();
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      expect(waitingFor("installAugmentations()")).toBe(AFTER_DESTROY);
      await releaseDestroy();
      expect(sentIds()).toEqual([DESTROY.id]);
      send(connection, "slow", slowAt(90_000, 90_000));
      expect(readManualIntents(store).map((each) => each.id)).toEqual(["installAugmentations()"]);
      // The install now goes past its own gate, and is done on its own reset: lastAugReset.
      await release();
      expect(sentIds()).toEqual(["installAugmentations()"]);
      send(connection, "slow", slowAt(90_000, 90_000));
      expect(sentIds()).toEqual(["installAugmentations()"]);
      send(connection, "slow", slowAt(120_000, 90_000));
      expect(readManualIntents(store)).toEqual([]);
    });

    test("cancelled once sent, it's forgotten, in the store too: queued again, a reset seen before it's sent doesn't count", async () => {
      const { controller, connection, releaseDestroy } = readyToDestroy();
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      await releaseDestroy();
      expect(controller.cancelManualIntent(DESTROY.id)).toBe(true);
      controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
      send(connection, "slow", slowAt(90_000, 90_000));
      expect(controller.intentsView().map((view) => view.id)).toEqual([DESTROY.id]);
      // Nor after a restart.
      connection.dropFromGameSide();
      const { restarted } = restartedBrain();
      const again = connectAgent("session-2");
      send(again, "slow", slowAt(120_000, 120_000), "session-2");
      expect(restarted.intentsView().map((view) => view.id)).toEqual([DESTROY.id]);
    });
  });
});

describe("work (#151, owner decision 37)", () => {
  const HACKING_FOR_CYBERSEC = { faction: "CyberSec", workType: "hacking" };
  const sentWork = (connection: MemoryConnection) =>
    (
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as unknown as DesiredState
    )?.work;

  function connectedWithLoopOff() {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData(1));
    return { controller, connection };
  }

  test("before the connected Agent's slow snapshot, no work goes: the focus isn't known yet (the implant)", () => {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    controller.setWork(HACKING_FOR_CYBERSEC);
    const connection = connectAgent();
    send(connection, "static", network);
    expect(sentWork(connection)).toBeUndefined();
    send(connection, "slow", slowData(1));
    expect(sentWork(connection)).toMatchObject({ faction: "CyberSec", focus: true });
  });

  test("none set: none sent, so the Agent leaves the game's work alone", () => {
    const { controller, connection } = connectedWithLoopOff();
    expect(sentWork(connection)).toBeUndefined();
    expect(controller.workView()).toEqual({ desired: null, outcome: null });
  });

  test("set on the dashboard: kept in the store, sent at once, focused by default", () => {
    const { controller, connection } = connectedWithLoopOff();
    expect(controller.setWork(HACKING_FOR_CYBERSEC)).toEqual({ ok: true });
    const work = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };
    expect(sentWork(connection)).toEqual(work);
    expect(store.getSetting("work.desired")).toBe('{"kind":"faction","faction":"CyberSec","workType":"hacking"}');
    // A restarted brain sends the same.
    const again = new DesiredStateController({ channel, store });
    expect(again.workView().desired).toEqual(work);
  });

  test("company work (#153): set, kept and sent, its field checked", () => {
    const { controller, connection } = connectedWithLoopOff();
    expect(controller.setWork({ kind: "company", company: "Noodle Bar", field: "Waiter" })).toEqual({ ok: true });
    expect(sentWork(connection)).toEqual({ kind: "company", company: "Noodle Bar", field: "Waiter", focus: true });
    expect(controller.setWork({ kind: "company", company: "Noodle Bar", field: "Juggler" })).toMatchObject({
      ok: false,
    });
  });

  test("a promotion the Agent reports (#155) is in the work's view: a well-formed one, its known fields only", () => {
    const { controller, connection } = connectedWithLoopOff();
    controller.setWork({ kind: "company", company: "Carmichael Security", field: "IT" });
    const promotion = { company: "Carmichael Security", from: "IT Intern", to: "IT Analyst", gameTimeMs: 5_000 };
    const reported = (work: unknown) =>
      send(connection, "fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: [], work });
    reported({ converged: true, problem: null, backend: "ui", promotion: { ...promotion, extra: "dropped" } });
    expect(controller.workView().outcome).toEqual({ converged: true, problem: null, backend: "ui", promotion });
    reported({ converged: true, problem: null, backend: "ui", promotion: { ...promotion, gameTimeMs: "soon" } });
    expect(controller.workView().outcome).toEqual({ converged: true, problem: null, backend: "ui" });
  });

  test("crime (#156): set, kept and sent, focused; an unknown crime refused", () => {
    const { controller, connection } = connectedWithLoopOff();
    expect(controller.setWork({ kind: "crime", crime: "Mug" })).toEqual({ ok: true });
    expect(sentWork(connection)).toEqual({ kind: "crime", crime: "Mug", focus: true });
    expect(controller.setWork({ kind: "crime", crime: "Jaywalk" })).toMatchObject({ ok: false });
    expect(sentWork(connection)).toMatchObject({ crime: "Mug" });
  });

  test("a class (#158): set, kept and sent unfocused, as focus gains it nothing; one the location doesn't teach refused", () => {
    const { controller, connection } = connectedWithLoopOff();
    expect(controller.setWork({ kind: "class", location: "Iron Gym", classType: "str" })).toEqual({ ok: true });
    expect(sentWork(connection)).toEqual({ kind: "class", location: "Iron Gym", classType: "str", focus: false });
    expect(controller.workView().desired).toMatchObject({ focus: false });
    expect(controller.setWork({ kind: "class", location: "Iron Gym", classType: "Algorithms" })).toEqual({
      ok: false,
      reason: "work's classType isn't taught at Iron Gym",
    });
    expect(sentWork(connection)).toMatchObject({ classType: "str" });
  });

  test("part-time company work (#153) goes unfocused: the game gives it full gains either way", () => {
    const { controller, connection } = connectedWithLoopOff();
    controller.setWork({ kind: "company", company: "Noodle Bar", field: "Part-time Waiter" });
    expect(sentWork(connection)).toMatchObject({ field: "Part-time Waiter", focus: false });
    expect(controller.workView().desired).toMatchObject({ focus: false });
  });

  test("unfocused once the Neuroreceptor Management Implant is installed, as the slow snapshot says", () => {
    const { controller, connection } = connectedWithLoopOff();
    controller.setWork(HACKING_FOR_CYBERSEC);
    send(connection, "slow", {
      ...slowData(1),
      resetInfo: { ...slowData(1).resetInfo, ownedAugs: { "Neuroreceptor Management Implant": 1 } },
    });
    expect(sentWork(connection)).toMatchObject({ focus: false });
  });

  test("stopped: none sent; a request that isn't valid is refused, with why, and changes nothing", () => {
    const { controller, connection } = connectedWithLoopOff();
    controller.setWork(HACKING_FOR_CYBERSEC);
    expect(controller.setWork({ faction: "The Gibson", workType: "hacking" })).toMatchObject({ ok: false });
    expect(controller.setWork({ faction: "CyberSec", workType: "espionage" })).toMatchObject({ ok: false });
    expect(sentWork(connection)).toMatchObject({ faction: "CyberSec" });
    expect(controller.setWork(null)).toEqual({ ok: true });
    expect(sentWork(connection)).toBeUndefined();
  });

  test("the view shows the connected Agent's outcome, if well formed", () => {
    const { controller, connection } = connectedWithLoopOff();
    controller.setWork(HACKING_FOR_CYBERSEC);
    const fast = (work: unknown) => ({ degradedTiers: [], pageHeapUsedBytes: null, game: null, intents: [], work });
    send(connection, "fast", fast({ converged: true, problem: null, backend: "ui" }));
    expect(controller.workView().outcome).toEqual({ converged: true, problem: null, backend: "ui" });
    send(connection, "fast", fast({ converged: "yes" }));
    expect(controller.workView().outcome).toBeNull();
  });
});

describe("cloud servers (#194): after the programs and home RAM, by the hack loop's measured income", () => {
  const MINUTE = 60_000;
  let clock: ManualClock;
  beforeEach(() => {
    clock = new ManualClock();
    channel = new ControlChannel({ token: TOKEN, clock });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  const sentPurchases = (connection: MemoryConnection) =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => (message as unknown as DesiredState).intents)
      .at(-1);
  interface Options {
    programs?: string[];
    homeRam?: number;
    cloud?: Record<string, number>;
    noodlesRam?: number;
  }
  /** Every program owned, unless `programs` says which; n00dles rooted, 4 GB; home at `homeRam` GB, if given. */
  const medium = (
    money: number,
    { programs = PORT_OPENER_PROGRAMS, homeRam, cloud = {}, noodlesRam = 4 }: Options = {},
  ) => {
    const data = mediumData(
      1,
      { n00dles: true, ...Object.fromEntries(Object.keys(cloud).map((hostname) => [hostname, true])) },
      { money, hasTorRouter: true, programs, ...(homeRam === undefined ? {} : { homeRam }) },
    );
    for (const server of data.servers) {
      if (server.hostname in cloud) server.maxRam = cloud[server.hostname] as number;
      if (server.hostname === "n00dles") server.maxRam = noodlesRam;
    }
    return data;
  };
  /**
   * The Agent connected, its static and slow snapshots in, and 10 minutes of medium snapshots, a minute apart, with
   * money rising `perSecond` ($512) from `money` on n00dles's 4 GB: $128 a GB a second, so a GB pays back in 7.2
   * minutes. With `endMoney`, a last snapshot 10 s on with money there (spent: not income).
   */
  const earning = (
    money: number,
    options: Options = {},
    { perSecond = 512, endMoney = null as number | null } = {},
  ) => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    for (let minute = 0; minute <= 10; minute++) {
      if (minute > 0) clock.advance(MINUTE);
      send(connection, "medium", medium(money + minute * 60 * perSecond, options));
    }
    if (endMoney !== null) {
      clock.advance(10_000);
      send(connection, "medium", medium(endMoney, options));
    }
    return { controller, connection, money: endMoney ?? money + 10 * 60 * perSecond };
  };
  const buyServer = (hostname: string, ram: number) => intent({ action: "buyServer", args: { hostname, ram } });
  const upgradeServer = (hostname: string, ram: number) => intent({ action: "upgradeServer", args: { hostname, ram } });

  test("nothing until the income spans 10 minutes; then the largest server money allows, and the view says so", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    send(connection, "medium", medium(10e6));
    clock.advance(9 * MINUTE);
    send(connection, "medium", medium(10e6 + 9 * 60 * 512));
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView()).toMatchObject({
      enabled: true,
      waiting: false,
      buying: null,
      waitingFor: "the hack loop's income over 10 min (measured from the medium snapshots)",
    });
    clock.advance(MINUTE);
    send(connection, "medium", medium(10e6 + 10 * 60 * 512));
    // $10.3m covers 128 GB ($7.04m).
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
    expect(controller.cloudServersView()).toEqual({
      enabled: true,
      waiting: false,
      servers: [],
      buying: { action: "buyServer", hostname: "pserv-0", ram: 128, price: 7_040_000, paybackMs: 429_687.5 },
      waitingFor: null,
      problem: null,
    });
    expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
      ["buyServer(pserv-0, 128)", "purchase"],
    ]);
  });

  test("bought, it's listed and a host; the next is the next name; at the limit, the smallest is upgraded", () => {
    const { connection, controller, money } = earning(10e6);
    clock.advance(10_000);
    send(connection, "medium", medium(money - 7_040_000, { cloud: { "pserv-0": 128 } }));
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-1", 32)]);
    expect(controller.cloudServersView().servers).toEqual([{ hostname: "pserv-0", ram: 128 }]);
    expect(controller.hackLoopView().hosts).toEqual(["n00dles", "pserv-0"]);
    const full = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`pserv-${index}`, 64]));
    clock.advance(10_000);
    send(connection, "medium", medium(10e6, { cloud: { ...full, "pserv-4": 8 } }));
    expect(sentPurchases(connection)).toEqual([upgradeServer("pserv-4", 128)]);
  });

  test("a program or home RAM upgrade the money covers goes first; the cloud server waits, saying so", () => {
    const { connection, controller } = earning(10e6, { programs: ["BruteSSH.exe"] });
    expect(sentPurchases(connection)).toEqual([buyProgram("FTPCrack.exe")]);
    expect(controller.cloudServersView()).toMatchObject({ buying: null, waitingFor: "FTPCrack.exe first" });
  });

  test("the next program waiting for money is held back if the income covers it within 5 minutes; one further off isn't", () => {
    // SQLInject.exe ($250m) is further off: nothing is held back.
    const far = earning(1e6, { programs: PORT_OPENER_PROGRAMS.slice(0, 4) });
    expect(sentPurchases(far.connection)).toEqual([buyServer("pserv-0", 16)]);
    far.connection.dropFromGameSide();
    // At $4,096 a second (on 32 GB), 5 minutes bring $1,228,800: BruteSSH.exe ($500k), short at $400,000, is held back.
    const near = earning(0, { programs: [], noodlesRam: 32 }, { perSecond: 4_096, endMoney: 400_000 });
    expect(sentPurchases(near.connection)).toEqual([]);
    expect(near.controller.cloudServersView().waitingFor).toBe(
      "money for pserv-0 with 8 GB ($440,000, beyond $500,000 held for BruteSSH.exe)",
    );
  });

  test("of a program and home RAM both waiting, the cheaper is what's held back", () => {
    // FTPCrack.exe ($1.5m) and home RAM from 2 GB to 4 GB ($101,120), neither affordable at $100,000: the upgrade,
    // within the 5 minutes' $153,600.
    const { controller, connection } = earning(0, { programs: ["BruteSSH.exe"], homeRam: 2 }, { endMoney: 100_000 });
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView().waitingFor).toBe(
      "money for pserv-0 with 8 GB ($440,000, beyond $101,120 held for home RAM to 4 GB)",
    );
  });

  test("the hack loop off, or the switch off: none, saying why; the switch is kept in the store", () => {
    const { controller, connection } = earning(10e6);
    controller.setCloudServersEnabled(false);
    expect(readCloudServersEnabled(store)).toBe(false);
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView()).toMatchObject({ enabled: false, buying: null, waitingFor: null });
    controller.setCloudServersEnabled(true);
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
    controller.setHackLoopEnabled(false);
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView().waitingFor).toBe("the hack loop, switched off: cloud servers only run it");
  });

  test("a purchase in flight keeps its id as money rises, so a failing one reaches intentStuck", () => {
    const { connection, money } = earning(10e6);
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
    clock.advance(10_000);
    send(connection, "medium", medium(money + 20e6));
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
  });

  test("a cloud purchase done with a problem: noted, in the view, none bought until the switch goes off and on", () => {
    const { controller, connection, money } = earning(10e6);
    const problem = "bought as pserv-0-0: a server off the network held pserv-0";
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: "buyServer(pserv-0, 128)", done: true, tries: 1, problem, backend: "ui" }],
    });
    expect(controller.cloudServersView().problem).toBe(`buyServer(pserv-0, 128): ${problem}`);
    expect(sentPurchases(connection)).toEqual([]);
    clock.advance(10_000);
    send(connection, "medium", medium(money, { cloud: { "pserv-0-0": 128 } }));
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView().waitingFor).toBe(
      `you to look at buyServer(pserv-0, 128): ${problem}, then turn cloud servers off and on again`,
    );
    controller.setCloudServersEnabled(false);
    controller.setCloudServersEnabled(true);
    expect(controller.cloudServersView().problem).toBeNull();
    // A fast snapshot from before the Agent had the new state, still showing it: not noted again.
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: "buyServer(pserv-0, 128)", done: true, tries: 1, problem, backend: "ui" }],
    });
    expect(controller.cloudServersView().problem).toBeNull();
    // The renamed one's name is passed over.
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-1", 128)]);
  });

  test("a disconnect forgets the income: 10 more minutes of it before the next", () => {
    const { connection } = earning(10e6);
    connection.dropFromGameSide();
    const again = connectAgent("session-2");
    send(again, "static", network, "session-2");
    send(again, "slow", slowData(), "session-2");
    send(again, "medium", medium(20e6), "session-2");
    expect(sentPurchases(again)).toEqual([]);
  });
});
