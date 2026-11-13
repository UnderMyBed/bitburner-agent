// The desired state's controller (#134, #136, #138, #141): it turns the switches and the connected Agent's snapshots into the state
// the channel sends, through a real ControlChannel.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  bitNodeAssumptions,
  CONTROL_PROTOCOL_VERSION,
  chooseAugmentationsToBuy,
  type DesiredState,
  encodeControlMessage,
  type FactionState,
  factionReputationPerSecond,
  HOME_RAM_LIMIT,
  hackingExpOfLevel,
  INSTALL_COUNTDOWN_MS,
  type Intent,
  type IntentOutcome,
  type IntentRequest,
  intentId,
  isWorthInstalling,
  newBatcherHealth,
  PORT_OPENER_PROGRAMS,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { holdsOf, installDecision, NO_HOLDS, nextPurchase, type Purchase, type Purse } from "@bitburner-agent/model";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUGMENTATION_ONLINE_SETTING,
  type InstallTimingPolicy,
  readCycleSeen,
  readInstallWait,
} from "../src/augmentations.ts";
import { HACKING_MULTIPLIERS_UNREAD } from "../src/batcher.ts";
import { readCloudServersEnabled } from "../src/cloud-servers.ts";
import { DesiredStateController, hackThreadsAddedUp, SAFE_MODE_TTL_MS } from "../src/desired-state.ts";
import { DESTROY_ESTIMATED_EVENT_KIND, type DestroyEstimateEvent } from "../src/destroy-estimate.ts";
import { readHackLoopEnabled } from "../src/hack-loop.ts";
import { readHomeRamEnabled } from "../src/home-ram.ts";
import { readManualIntents, readResetSentNote, writeResetSentNote } from "../src/manual-intents.ts";
import { readProgramsEnabled } from "../src/programs.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { type Environment, TelemetryStore } from "../src/telemetry-store.ts";
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
/** The travel for invitations' events (#228): its own tests' (invitations.test.ts), left out of the others. */
const isInvitationEvent = (event: { type: string }) =>
  ["invitationTravel", "invitationWaiting", "cityGroupChosen"].includes(event.type);
const intent = (request: IntentRequest): Intent => ({ ...request, id: intentId(request.action, request.args) });
/**
 * The travel for Tian Di Hui's invitation (#228): with hacking 50 and $1.2m in Sector-12, and nothing joined (short of
 * Daedalus's count, the hacking way sold out: its eight count) or CyberSec joined (its ADR-V1 and S.N.A have a hacking
 * value), the brain asks for it, last.
 */
const TRAVEL_ISHIMA = intent({ action: "travel", args: { city: "Ishima" } });
/**
 * The travel for city group B's invitations (#228, owner decision 54): with $30.6m (Ishima's $30m and three tickets),
 * the group selling the most the brain would install (nothing joined: short of Daedalus's count, the most of them; else
 * the most hacking value, DataJack, Neuralstimulator and Neuregen), Chongqing first.
 */
const TRAVEL_CHONGQING = intent({ action: "travel", args: { city: "Chongqing" } });
const buyTor = (vendor = "Alpha Enterprises") => intent({ action: "buyTor", args: { vendor } });
const buyProgram = (program: string) => intent({ action: "buyProgram", args: { program } });
const upgradeHomeRam = (fromRam: number, vendor = "Alpha Enterprises") =>
  intent({ action: "upgradeHomeRam", args: { fromRam, vendor } });
/** The purchases' actions: programs, home's RAM and cloud servers. */
const PURCHASE_ACTIONS = ["buyTor", "buyProgram", "upgradeHomeRam", "buyServer", "upgradeServer"];
/** The fast model's purchase (#263, `nextPurchase`) as the brain's intent, from `purse` (the brain's `pserv-<n>`). */
const brainIntentOf = (purchase: Purchase, purse: Purse): Intent => {
  if (purchase.kind === "program") {
    return purse.programs === 0 ? buyTor() : buyProgram(PORT_OPENER_PROGRAMS[purse.programs - 1] as string);
  }
  if (purchase.kind === "homeRam") return upgradeHomeRam(purchase.fromRamGb);
  const hostname = `pserv-${purchase.serverIndex ?? purse.cloudServersRamGb.length}`;
  const args = { hostname, ram: purchase.ramGb };
  return purchase.serverIndex === null
    ? intent({ action: "buyServer", args })
    : intent({ action: "upgradeServer", args });
};

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
  expect(desiredStates(connection).at(-1)).toEqual({ hackLoop: loopOff, intents: [buyTor(), TRAVEL_CHONGQING] });
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
    expect(desiredStates(connection).at(-1)?.intents).toEqual([buyTor(), TRAVEL_CHONGQING]);
    expect(controller.intentsView()).toMatchObject([
      { id: buyTor().id, source: "manual" },
      { id: TRAVEL_CHONGQING.id, source: "travel" },
    ]);
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

  test("full at 95: room for the purchase, the backdoor, the join, the augmentation's and the destroy (#215)", () => {
    const controller = new DesiredStateController({ channel, store });
    const vendors = ["Alpha Enterprises", "NetLink Technologies", "Omega Software", "CompuTek"];
    for (let index = 0; index < 95; index += 1) {
      const args = { fromRam: 2 ** (index % 30), vendor: vendors[Math.floor(index / 30)] };
      expect(controller.addManualIntent({ action: "upgradeHomeRam", args })).toMatchObject({ ok: true });
    }
    expect(controller.addManualIntent({ action: "travel", args: { city: "Aevum" } })).toEqual({
      ok: false,
      reason: "the manual queue is full: 95 intents at most",
    });
    expect(readManualIntents(store)).toHaveLength(95);
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
      // No slow snapshot in this test (#321): the hack loop's hacking multipliers BN1's meanwhile, said once.
      HACKING_MULTIPLIERS_UNREAD,
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
      "intents: the manual queue holds 99, over its 95: backdoor(CSEC), travel(Ishima) wait for room in the protocol's " +
        "100 (cancel one)",
    ]);
  });

  test("after the purchase, so a `buy` never waits for its terminal action; once if the owner queued it too", () => {
    store.setSetting("homeRam.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", withCsec);
    send(connection, "slow", slowData());
    send(connection, "medium", csecAt(60, { money: 2_000_000 }));
    expect(lastIntents(connection)).toEqual([buyProgram("FTPCrack.exe"), BACKDOOR_CSEC, TRAVEL_ISHIMA]);
    controller.addManualIntent({ action: "backdoor", args: { hostname: "CSEC" } });
    expect(lastIntents(connection)).toEqual([BACKDOOR_CSEC, buyProgram("FTPCrack.exe"), TRAVEL_ISHIMA]);
    expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
      [BACKDOOR_CSEC.id, "manual"],
      ["buyProgram(FTPCrack.exe)", "purchase"],
      [TRAVEL_ISHIMA.id, "travel"],
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

  /**
   * An Agent connected with its static snapshot sent, the hack loop off so the intents go without a medium one. Its
   * augmentation tests work the count rule short of Daedalus's count (#343: the A/B's baseline), but the planner's.
   */
  function connectedWithLoopOff(
    installTiming: InstallTimingPolicy = "count rule",
    environment: Environment | null = null,
  ) {
    store.setSetting("hackLoop.enabled", "false");
    const backups = standInBackups();
    const controller = new DesiredStateController({
      channel,
      store,
      saveBackups: backups.saveBackups,
      installTiming,
      environment,
    });
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

  describe("augmentations and the reset (#210)", () => {
    const INSTALL = intent({ action: "installAugmentations", args: {} });
    const AEVUM = intent({ action: "travel", args: { city: "Aevum" } });
    const FIVE = [
      "Cranial Signal Processors - Gen I",
      "Cranial Signal Processors - Gen II",
      "BitWire",
      "Synaptic Enhancement Implant",
      "Neurotrainer I",
    ];
    const buy = (augmentation: string, level = 1) =>
      intent({ action: "purchaseAugmentation", args: { faction: "CyberSec", augmentation, level } });
    /** A slow snapshot with CyberSec joined at the reputation for its five, `queued` bought. */
    const slowWith = (queued: string[] = [], lastAugReset = 1_000) => ({
      ...slowData(),
      resetInfo: { ...slowData().resetInfo, lastAugReset },
      factions: {
        backend: "sim",
        state: {
          joined: [{ name: "CyberSec", reputation: 18_750, favor: 0 }],
          invitations: [],
          queuedAugmentations: queued,
        },
        problem: null,
      },
    });
    /** A medium snapshot with what the rule reads of the player: hacking 300, and `money`. */
    const richMedium = (money: number) => ({
      ...mediumData(300, { home: true }, { money, homeRam: 2 ** 20, hasTorRouter: true }),
      player: {
        skills: { hacking: 300, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
        exp: { hacking: 6_106_794 },
        mults: { faction_rep: 1, hacking: 1 },
        money,
        city: "Sector-12",
        factions: ["CyberSec"],
      },
    });
    const reportedDone = (connection: MemoryConnection, id: string) =>
      send(connection, "fast", {
        degradedTiers: [],
        pageHeapUsedBytes: null,
        game: null,
        intents: [{ id, done: true, tries: 1, problem: null, backend: "sim" }],
      });
    /**
     * A medium snapshot at the game's time past the install's countdown (#222), which runs in the game's time: 90 s
     * (30 s for a quick install) from the first update saying install, at 1,000.
     */
    const pastCountdown = (connection: MemoryConnection, data: unknown) =>
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier: "medium",
          sequenceNumber: ++sequenceNumber,
          gameTimeMs: 1_000 + INSTALL_COUNTDOWN_MS,
          data,
        }),
      );

    test("the install chosen: its purchases (`augmentation`), one at a time, the next at once; programs held", () => {
      const { controller, connection, sentIds } = connectedWithLoopOff();
      send(connection, "slow", slowWith());
      send(connection, "medium", richMedium(1e9));
      // The countdown first (#222): nothing bought in it, the programs held too (they're lost at the install); no
      // travel for invitations either (#228): the install puts the player back in Sector-12.
      expect(sentIds()).toEqual([]);
      expect(controller.programsView().waitingFor).toBe(
        "the augmentations' install countdown (programs are lost at the install)",
      );
      expect(controller.augmentationsView()).toMatchObject({
        committed: false,
        progress: { countdown: { quick: true } },
      });
      pastCountdown(connection, richMedium(1e9));
      expect(sentIds()).toEqual([buy(FIVE[0] as string).id]);
      expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
        [buy(FIVE[0] as string).id, "augmentation"],
      ]);
      expect(controller.programsView().waitingFor).toBe(
        "the install of augmentations chosen (the augmentation rule buys for it)",
      );
      expect(controller.augmentationReserve()).toBe(Number.POSITIVE_INFINITY);
      expect(controller.augmentationsView()).toMatchObject({ committed: true });
      // Reported done: the next goes at once, from the fast snapshot.
      reportedDone(connection, buy(FIVE[0] as string).id);
      expect(sentIds()).toEqual([buy(FIVE[1] as string).id]);
    });

    describe("the planner (#343), short of Daedalus's count", () => {
      const TBH = "The Black Hand";
      const NFG = "NeuroFlux Governor";
      const THREE = ["BitWire", "Synaptic Enhancement Implant", "Neurotrainer I"];
      const fillers = AUGMENTATION_NAMES.filter(
        (name) =>
          isWorthInstalling(name, true) &&
          !augmentationsSoldBy(TBH, 1, null).includes(name) &&
          !augmentationsSoldBy("CyberSec", 1, null).includes(name) &&
          name !== "Neural Wit Amplifier",
      );
      /**
       * Run #3's 17:49, as augmentations.test.ts's planner tests have it: 25 installed (The Black Hand's shop but its
       * own, Gen I and II, NeuroFlux Governor, fillers), Neural Wit Amplifier queued, CyberSec's other three reached:
       * an install adds 4, 29 of 30. The 30th, "The Black Hand", reached at 100,000: its money is what's missing.
       */
      const OWNED: Record<string, number> = Object.fromEntries(
        [
          ...augmentationsSoldBy(TBH, 1, null).filter((name) => name !== TBH && name !== NFG),
          ...FIVE.slice(0, 2),
          NFG,
          ...fillers,
        ]
          .slice(0, 25)
          .map((name) => [name, name === NFG ? 5 : 1]),
      );
      /** The three after Neural Wit Amplifier, then The Black Hand first: what the set and it cost. */
      const WITH_BLACK_HAND = 550e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
      /** $300m short of The Black Hand with the set: 5 minutes at $1m a second. */
      const SHORT_OF_IT = WITH_BLACK_HAND - 300e6;
      /** The set's three after Neural Wit Amplifier, exactly: no NeuroFlux Governor level or home RAM after them. */
      const THREE_EXACTLY = 10e6 * 1.9 + 7.5e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3 + 1_000;
      const EARNING = 1e6;
      const MINUTE = 60_000;
      const plannerSlow = ({
        minute,
        ownedAugs = OWNED,
        queued = ["Neural Wit Amplifier"],
        blackHand = 100_000,
        invited = [],
      }: {
        minute: number;
        ownedAugs?: Record<string, number>;
        queued?: string[];
        blackHand?: number;
        /** Factions inviting (a city group's, ending #228's hold for its invitations). */
        invited?: string[];
      }) => ({
        ...slowData(),
        resetInfo: { ...slowData().resetInfo, lastAugReset: 0, ownedAugs },
        moneySources: { hacking: minute * 60 * EARNING },
        factions: {
          backend: "sim",
          state: {
            joined: [
              { name: "CyberSec", reputation: 18_750, favor: 0 },
              { name: TBH, reputation: blackHand, favor: 0 },
            ],
            invitations: invited,
            queuedAugmentations: queued,
          },
          problem: null,
        },
      });
      /** A slow and a medium snapshot `minute` minutes into the cycle (the game's time), the medium with `money`. */
      const minuteAt = (
        connection: MemoryConnection,
        minute: number,
        money: number,
        fields: Omit<Parameters<typeof plannerSlow>[0], "minute"> = {},
        agentSessionId = "session-1",
      ) => {
        for (const [tier, data] of [
          ["slow", plannerSlow({ minute, ...fields })],
          ["medium", richMedium(money)],
        ] as const) {
          connection.receive(
            encodeControlMessage({
              protocolVersion: CONTROL_PROTOCOL_VERSION,
              type: "snapshot",
              agentSessionId,
              tier,
              sequenceNumber: ++sequenceNumber,
              gameTimeMs: 10 * 3_600_000 + minute * MINUTE,
              data,
            }),
          );
        }
      };
      const augmentationIntents = (ids: string[]) =>
        ids.filter((id) => id === INSTALL.id || id.startsWith("purchaseAugmentation"));

      test("the share bonus the batcher reports reaches the planner's τ by work (#345): The Black Hand at ×1.6", () => {
        const { controller, connection } = connectedWithLoopOff("planner");
        // The batcher's health first: share threads running, the bonus 1.6, so each slow snapshot samples it.
        const sharing = { wanted: true, threads: 1_000, ramGb: 4_000, hostsRamGb: 4_000, bonus: 1.6, roomGb: 0 };
        const health = { ...newBatcherHealth("n00dles", "r", 1_000), state: "batching" as const, sharing };
        send(connection, "fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, batcher: health });
        // The Black Hand 30 minutes off by A5's work at ×1.6 (hacking 300, favour 0), its money in hand.
        const rate = factionReputationPerSecond(
          { skills: richMedium(0).player.skills, mults: { faction_rep: 1 } },
          "hacking",
          { favor: 0, sourceFile15Level: 0, factionWorkRepGain: 1, focused: true, implant: false },
        );
        const blackHand = 100_000 - rate * 1.6 * 30 * 60;
        for (let minute = 0; minute <= 10; minute += 1) minuteAt(connection, minute, 1e12, { blackHand });
        expect(controller.augmentationsView().progress?.timing?.next[0]).toMatchObject({
          augmentation: TBH,
          way: "work",
          tauMs: expect.closeTo(30 * MINUTE, -3),
        });
      });

      test("a wait at 29 of 30, The Black Hand's money 5 min off: nothing goes; restarted, no income measured, still none", () => {
        const { controller, connection, sentIds } = connectedWithLoopOff("planner");
        // Ten minutes of slow snapshots measure the income; meanwhile installing now is held for it.
        minuteAt(connection, 0, SHORT_OF_IT);
        expect(controller.augmentationsView().progress?.timing).toMatchObject({ needed: 5, adding: 4 });
        for (let minute = 1; minute <= 10; minute += 1) minuteAt(connection, minute, SHORT_OF_IT);
        const waiting = controller.augmentationsView().progress?.timing;
        expect(waiting).toMatchObject({ needed: 5, adding: 4, choice: 1, heldForIncome: false });
        expect(waiting?.next[0]).toMatchObject({
          augmentation: TBH,
          way: "money",
          tauMs: expect.closeTo(5 * MINUTE, -3),
        });
        expect(augmentationIntents(sentIds())).toEqual([]);
        expect(controller.augmentationsView().committed).toBe(false);
        const wait = readInstallWait(store);
        expect(wait).toMatchObject({ untilAdding: 5, overdue: false });

        // Restarted: the income's samples are gone, so its money never comes at a rate known; installing now (29 of 30)
        // would be the only candidate, and it's held until the income is measured again.
        const { restarted } = restartedBrain();
        const again = connectAgent();
        send(again, "static", network);
        for (let minute = 11; minute <= 15; minute += 1) minuteAt(again, minute, SHORT_OF_IT);
        expect(restarted.augmentationsView().progress?.timing).toMatchObject({
          adding: 4,
          candidates: [{ k: 0 }],
          choice: null,
          heldForIncome: true,
        });
        expect(restarted.augmentationsView().committed).toBe(false);
        expect(
          augmentationIntents(
            desiredStates(again)
              .at(-1)
              ?.intents.map((each) => each.id) ?? [],
          ),
        ).toEqual([]);
        // The wait's record kept across the restart.
        expect(readInstallWait(store)).toEqual(wait);
      });

      test("NeuroFlux Governor's levels alone on offer, the income measured: never an install", () => {
        const { controller, connection, sentIds } = connectedWithLoopOff("planner");
        // CyberSec's shop owned in place of three fillers: only its NeuroFlux Governor levels, with $1t.
        const lastFillers = Object.keys(OWNED)
          .filter((name) => fillers.includes(name))
          .slice(-3);
        const ownedAugs = {
          ...Object.fromEntries(Object.entries(OWNED).filter(([name]) => !lastFillers.includes(name))),
          ...Object.fromEntries(THREE.map((name) => [name, 1])),
        };
        expect(Object.keys(ownedAugs)).toHaveLength(25);
        for (let minute = 0; minute <= 15; minute += 1) {
          minuteAt(connection, minute, 1e12, { ownedAugs, queued: [], blackHand: 0 });
        }
        expect(controller.augmentationsView().progress?.affordableWithNeuroFlux).toBeGreaterThan(0);
        expect(controller.augmentationsView().progress?.timing).toMatchObject({ adding: 0, heldForIncome: false });
        expect(controller.augmentationsView().progress?.timing?.choice).not.toBe(0);
        expect(controller.augmentationsView().committed).toBe(false);
        expect(augmentationIntents(sentIds())).toEqual([]);
      });

      test("held while the income is unmeasured, then while #228 holds a city group's money; then installing now, at once, through the gate and a backup", async () => {
        const { controller, connection, sentIds, backupNow, settleBackup } = connectedWithLoopOff("planner");
        const sent: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || sent.push(event));
        // The Black Hand far off (0 of 100,000): installing now, 29 of 30, is the shortest, but held for the income.
        for (let minute = 0; minute <= 9; minute += 1) {
          minuteAt(connection, minute, THREE_EXACTLY, { blackHand: 0 });
          expect(controller.augmentationsView().committed).toBe(false);
        }
        expect(controller.augmentationsView().progress?.timing).toMatchObject({ choice: null, heldForIncome: true });
        expect(controller.augmentationsView().progress?.timing?.words).toMatch(
          /; install now held: no income measured/,
        );
        // The income measured; the invitations rule meanwhile holds money for a city group's invitations (#228):
        // installing now, which would spend it, held for it.
        minuteAt(connection, 10, THREE_EXACTLY, { blackHand: 0 });
        expect(controller.invitationsView().hold).toBeGreaterThan(0);
        expect(controller.augmentationsView().progress?.timing).toMatchObject({
          choice: 1,
          heldForIncome: false,
          heldForInvitation: true,
        });
        expect(controller.augmentationsView().committed).toBe(false);
        // The group inviting: the hold over (as of the invitations rule's next update), installing now goes.
        const group = controller.invitationsView().cityFactions;
        expect(group.length).toBeGreaterThan(0);
        minuteAt(connection, 11, THREE_EXACTLY, { blackHand: 0, invited: group });
        expect(controller.invitationsView().hold).toBe(0);
        minuteAt(connection, 12, THREE_EXACTLY, { blackHand: 0, invited: group });
        expect(controller.augmentationsView()).toMatchObject({ committed: true });
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: "augmentationInstallChosen",
            reason: "Daedalus's count",
            short: { installed: 25, required: 30 },
            timing: expect.objectContaining({ needed: 5, adding: 4, choice: 0, heldForIncome: false }),
          }),
        );
        // The set's three, then the install through the gate: two medium snapshots and a backup.
        const queued = ["Neural Wit Amplifier", ...THREE];
        for (const [index, name] of THREE.entries()) {
          expect(sentIds()).toContain(buy(name).id);
          send(connection, "fast", {
            degradedTiers: [],
            pageHeapUsedBytes: null,
            game: null,
            intents: [{ id: buy(name).id, done: true, tries: 1, problem: null, backend: "sim" }],
          });
          minuteAt(connection, 13 + index, THREE_EXACTLY, {
            queued: queued.slice(0, index + 2),
            blackHand: 0,
            invited: group,
          });
        }
        // The four shown queued: the install asked for, then the gate: two consecutive medium snapshots, and a backup.
        minuteAt(connection, 16, 0, { queued, blackHand: 0, invited: group });
        minuteAt(connection, 17, 0, { queued, blackHand: 0, invited: group });
        minuteAt(connection, 18, 0, { queued, blackHand: 0, invited: group });
        // The group's joins (A5's, irreversible too) take their own backups, in turn: each settled.
        expect(backupNow).toHaveBeenCalled();
        for (let backup = 0; backup < 4 && !sentIds().includes(INSTALL.id); backup += 1) {
          await settleBackup(SAVED);
          minuteAt(connection, 19 + backup, 0, { queued, blackHand: 0, invited: group });
        }
        expect(controller.intentsView().map((each) => each.id)).toContain(INSTALL.id);
        expect(sentIds()).toContain(INSTALL.id);
      });

      describe("T, this cycle's time online (#388)", () => {
        const HOUR = 3_600_000;
        /** The game's 10 h, where `minuteAt`'s minutes count from: the cycle's install, seen from its start. */
        const TEN_HOURS = 10 * HOUR;
        /** As `minuteAt`, The Black Hand's money 5 min off, in the cycle installed at `lastAugReset`. */
        const cycleMinute = (connection: MemoryConnection, minute: number, lastAugReset = TEN_HOURS) => {
          const slow = plannerSlow({ minute });
          for (const [tier, data] of [
            ["slow", { ...slow, resetInfo: { ...slow.resetInfo, lastAugReset } }],
            ["medium", richMedium(SHORT_OF_IT)],
          ] as const) {
            connection.receive(
              encodeControlMessage({
                protocolVersion: CONTROL_PROTOCOL_VERSION,
                type: "snapshot",
                agentSessionId: "session-1",
                tier,
                sequenceNumber: ++sequenceNumber,
                gameTimeMs: TEN_HOURS + minute * MINUTE,
                data,
              }),
            );
          }
        };
        /** An earlier brain's slow snapshots of the cycle `lastAugReset`, at the game's `fromMs` on, a minute apart. */
        const storedSlow = (lastAugReset: number, fromMs: number, minutes: number) => {
          for (let minute = 0; minute <= minutes; minute += 1) {
            const atMs = fromMs + minute * MINUTE;
            store.recordSnapshot(
              { environment: "E1", release: "v1.0.1" },
              {
                agentSessionId: "earlier",
                tier: "slow",
                sequenceNumber: minute + 1,
                gameTimeMs: atMs,
                receivedAtMs: atMs,
                missedBefore: 0,
                data: { resetInfo: { lastAugReset, ownedAugs: OWNED } },
              },
            );
          }
        };
        const timingOf = (controller: DesiredStateController) => controller.augmentationsView().progress?.timing;

        test("an offline gap over 3 min mid-cycle: T leaves it out, and install now's estimate falls with it", () => {
          const { controller, connection } = connectedWithLoopOff("planner");
          for (let minute = 0; minute <= 20; minute += 1) cycleMinute(connection, minute);
          expect(timingOf(controller)).toMatchObject({ onlineMs: 20 * MINUTE, choice: 1 });
          // The game closed for an hour: 81 min of the game's time since the install, 21 online.
          cycleMinute(connection, 80);
          cycleMinute(connection, 81);
          const timing = timingOf(controller);
          expect(timing).toMatchObject({ onlineMs: 21 * MINUTE, timeOnlineMs: 21 * MINUTE });
          expect(timing?.candidates[0]).toEqual({ k: 0, tauMs: 0, estimateMs: 21 * MINUTE });
          expect(timing?.unseenMs).toBeUndefined();
          expect(controller.augmentationsView().progress?.onlineMs).toBe(21 * MINUTE);
          expect(timing?.words).toMatch(/, 21 min this cycle \(T\); /);
        });

        test("a gap under 3 min counts: 2 minutes between slow snapshots are online", () => {
          const { controller, connection } = connectedWithLoopOff("planner");
          for (let minute = 0; minute <= 12; minute += 1) cycleMinute(connection, minute);
          cycleMinute(connection, 14);
          cycleMinute(connection, 15);
          const timing = timingOf(controller);
          expect(timing).toMatchObject({ onlineMs: 15 * MINUTE, timeOnlineMs: 15 * MINUTE });
          expect(timing?.candidates[0]).toEqual({ k: 0, tauMs: 0, estimateMs: 15 * MINUTE });
          expect(timing?.unseenMs).toBeUndefined();
        });

        test("a cycle first seen 5 h in, none of its slow snapshots stored: the game's time before, labelled cautious", () => {
          const { controller, connection } = connectedWithLoopOff("planner", "E1");
          for (let minute = 0; minute <= 10; minute += 1) cycleMinute(connection, minute, TEN_HOURS - 5 * HOUR);
          const timing = timingOf(controller);
          expect(timing).toMatchObject({
            onlineMs: 5 * HOUR + 10 * MINUTE,
            timeOnlineMs: 10 * MINUTE,
            unseenMs: 5 * HOUR,
          });
          expect(timing?.candidates[0]).toEqual({ k: 0, tauMs: 0, estimateMs: 5 * HOUR + 10 * MINUTE });
          expect(timing?.words).toMatch(
            /, 5\.2 h this cycle \(T; 10 min online, and 5\.0 h before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\); /,
          );
        });

        test("a cycle first seen 5 h in, its first 20 min of slow snapshots stored (a save loaded back): their time online", () => {
          const installed = TEN_HOURS - 5 * HOUR;
          storedSlow(installed, installed + 30_000, 20);
          // The other save's cycle's 10 min (none of this cycle's), and the clock gone to it meanwhile.
          storedSlow(installed - HOUR, installed + HOUR, 10);
          store.setSetting(
            AUGMENTATION_ONLINE_SETTING,
            JSON.stringify({ lastAugReset: installed - HOUR, onlineMs: HOUR, lastGameTimeMs: installed - MINUTE }),
          );
          const { controller, connection } = connectedWithLoopOff("planner", "E1");
          for (let minute = 0; minute <= 10; minute += 1) cycleMinute(connection, minute, installed);
          const timing = timingOf(controller);
          expect(timing).toMatchObject({ onlineMs: 30 * MINUTE, timeOnlineMs: 30 * MINUTE });
          expect(timing?.unseenMs).toBeUndefined();
          expect(timing?.candidates[0]).toEqual({ k: 0, tauMs: 0, estimateMs: 30 * MINUTE });
          expect(readCycleSeen(store)).toEqual({ lastAugReset: installed, gameTimeMs: installed + 30_000 });
        });

        test("BN4.2's first cycle: a store from before #343, its clock for the cycle, no record of its start, a 5 h gap: T its time online", () => {
          const installed = TEN_HOURS - 5 * HOUR - 20 * MINUTE;
          // The earlier brain saw its first 20 minutes, then the game closed for 5 h: its clock 20 min online.
          storedSlow(installed, installed, 20);
          store.setSetting(
            AUGMENTATION_ONLINE_SETTING,
            JSON.stringify({ lastAugReset: installed, onlineMs: 20 * MINUTE, lastGameTimeMs: installed + 20 * MINUTE }),
          );
          const { controller, connection } = connectedWithLoopOff("planner", "E1");
          for (let minute = 0; minute <= 10; minute += 1) cycleMinute(connection, minute, installed);
          const timing = timingOf(controller);
          // The seed before #388 counted the gap: 5 h 30 min.
          expect(timing).toMatchObject({ onlineMs: 30 * MINUTE, timeOnlineMs: 30 * MINUTE });
          expect(timing?.unseenMs).toBeUndefined();
          expect(timing?.candidates[0]).toEqual({ k: 0, tauMs: 0, estimateMs: 30 * MINUTE });
          expect(readCycleSeen(store)).toEqual({ lastAugReset: installed, gameTimeMs: installed });
        });
      });

      describe("Netburners' Hacknet setup (#387)", () => {
        const HACKNET = intent({ action: "buyHacknetSetup", args: {} });
        const JOIN_NETBURNERS = intent({ action: "joinFaction", args: { faction: "Netburners" } });
        const NETBURNERS_FIVE = augmentationsSoldBy("Netburners", 1, null).filter((name) => name !== NFG);
        /** Netburners' cheapest, 1,875 reputation. */
        const NIC = "Hacknet Node NIC Architecture Neural-Upload";
        /** `getPlayer().mults`' Hacknet cost multipliers, at 1: the Agent's snapshots carry them. */
        const HACKNET_MULTS = {
          hacknet_node_purchase_cost: 1,
          hacknet_node_level_cost: 1,
          hacknet_node_ram_cost: 1,
          hacknet_node_core_cost: 1,
        };
        const hacknetMedium = (money: number, hacking = 300) => {
          const data = richMedium(money);
          const skills = { ...data.player.skills, hacking };
          return { ...data, player: { ...data.player, skills, mults: { ...data.player.mults, ...HACKNET_MULTS } } };
        };
        /** As `minuteAt`, the medium with the Hacknet multipliers; Netburners inviting or joined; another cycle. */
        const hacknetMinute = (
          connection: MemoryConnection,
          minute: number,
          money: number,
          {
            netburners = "none",
            ownedSF = {},
            lastAugReset = 0,
            hacking = 300,
            ...fields
          }: Omit<Parameters<typeof plannerSlow>[0], "minute"> & {
            netburners?: "none" | "invited" | "joined";
            ownedSF?: Record<string, number>;
            lastAugReset?: number;
            hacking?: number;
          } = {},
          agentSessionId = "session-1",
        ) => {
          const slow = plannerSlow({ minute, ...fields });
          const state = slow.factions.state;
          const data = {
            ...slow,
            resetInfo: { ...slow.resetInfo, ownedSF, lastAugReset },
            factions: {
              ...slow.factions,
              state: {
                ...state,
                invitations: [...state.invitations, ...(netburners === "invited" ? ["Netburners"] : [])],
                joined: [
                  ...state.joined,
                  ...(netburners === "joined" ? [{ name: "Netburners", reputation: 0, favor: 0 }] : []),
                ],
              },
            },
          };
          for (const [tier, snapshot] of [
            ["slow", data],
            ["medium", hacknetMedium(money, hacking)],
          ] as const) {
            connection.receive(
              encodeControlMessage({
                protocolVersion: CONTROL_PROTOCOL_VERSION,
                type: "snapshot",
                agentSessionId,
                tier,
                sequenceNumber: ++sequenceNumber,
                gameTimeMs: 10 * 3_600_000 + minute * MINUTE,
                data: snapshot,
              }),
            );
          }
        };
        const hacknetDone = (connection: MemoryConnection) =>
          send(connection, "fast", {
            degradedTiers: [],
            pageHeapUsedBytes: null,
            game: null,
            intents: [{ id: HACKNET.id, done: true, tries: 1, problem: null, backend: "sim" }],
          });
        /** Programs and home RAM off: the purchase order's first two aside. */
        const onlyHacknet = () => {
          store.setSetting("programs.enabled", "false");
          store.setSetting("homeRam.enabled", "false");
        };
        const hacknetEvents = (events: unknown[]) =>
          events.filter((event) => (event as { type: string }).type === "hacknetSetup") as {
            phase: string;
            estimateMs: number | null;
          }[];

        test("The Black Hand far off: the planner waits for Netburners' five; the setup, the invitation, the join, and the setup again after an install", () => {
          onlyHacknet();
          const { controller, connection, sentIds } = connectedWithLoopOff("planner");
          const events: unknown[] = [];
          controller.subscribe((event) => events.push(event));
          // 29 of 30 at an install, The Black Hand 100,000 off. Netburners' first, 1,875 by A5's work after the setup
          // (the money in hand) and the game's check: the planner waits for it, and the setup goes out.
          hacknetMinute(connection, 0, 1e12, { blackHand: 0 });
          const timing = controller.augmentationsView().progress?.timing;
          expect(timing?.next[0]).toMatchObject({
            augmentation: NIC,
            faction: "Netburners",
            way: "work",
          });
          expect(timing?.choice).toBeGreaterThanOrEqual(1);
          expect(sentIds()).toContain(HACKNET.id);
          expect(controller.intentsView().find((view) => view.id === HACKNET.id)?.source).toBe("purchase");
          expect(controller.hacknetView()).toMatchObject({ wanted: true, buying: true, bought: false, invited: false });
          expect(controller.hacknetView().cost).toBeGreaterThan(160_000);
          expect(controller.hacknetView().cost).toBeLessThan(180_000);
          expect(controller.factionsView().hacknet).toEqual(controller.hacknetView());
          // The estimate to the invitation: the money in hand, so the game's check alone.
          expect(hacknetEvents(events)).toEqual([expect.objectContaining({ phase: "wanted", estimateMs: 2_000 })]);
          // A5 works for a countable at a joined faction meanwhile, never Netburners' before it's joined.
          expect(controller.factionsView().choice?.faction).not.toBe("Netburners");
          // Bought: asked for no more (#387's review), so it holds neither the purchase's turn nor money.
          hacknetDone(connection);
          hacknetMinute(connection, 1, 1e12, { blackHand: 0 });
          expect(controller.hacknetView()).toMatchObject({
            bought: true,
            buying: false,
            waitingFor: "Netburners' invitation (the setup bought)",
          });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.gangEquipmentHold().forWhat).not.toContain("Netburners");
          // Invited: the setup no longer asked for; A5 joins Netburners (no enemies).
          hacknetMinute(connection, 2, 1e12, { blackHand: 0, netburners: "invited" });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(sentIds()).toContain(JOIN_NETBURNERS.id);
          expect(controller.hacknetView()).toMatchObject({ wanted: false, invited: true });
          // Joined: A5 and A6 treat it as any other faction; its countables come by the joined path.
          hacknetMinute(connection, 3, 1e12, { blackHand: 0, netburners: "joined" });
          expect(controller.augmentationsView().progress?.timing?.next[0]).toMatchObject({
            augmentation: NIC,
            faction: "Netburners",
          });
          expect(controller.hacknetView().waitingFor).toBe("nothing: Netburners joined (A5 and A6 have it)");
          expect(hacknetEvents(events).map((event) => event.phase)).toEqual(["wanted", "bought", "invited"]);
          // An install later (another cycle, a new Agent): Hacknet and the join are lost, the five not yet installed,
          // so the setup goes out again.
          const again = connectAgent("session-2");
          send(again, "static", network, "session-2");
          hacknetMinute(again, 30, 1e12, { blackHand: 0, lastAugReset: 1 }, "session-2");
          expect(
            desiredStates(again)
              .at(-1)
              ?.intents.map((each) => each.id),
          ).toContain(HACKNET.id);
          expect(hacknetEvents(events).at(-1)).toMatchObject({ phase: "wanted" });
        });

        test("nothing once Netburners' five are installed, or queued; nothing with Hacknet servers (SF9)", () => {
          onlyHacknet();
          const { controller, connection, sentIds } = connectedWithLoopOff("planner");
          const withFive = Object.fromEntries([
            ...Object.entries(OWNED).slice(0, 20),
            ...NETBURNERS_FIVE.map((name) => [name, 1] as const),
          ]);
          hacknetMinute(connection, 0, 1e12, { blackHand: 0, ownedAugs: withFive });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView()).toMatchObject({
            wanted: false,
            waitingFor: "nothing: Netburners' augmentations installed or queued",
          });
          expect(
            controller.augmentationsView().progress?.timing?.next.some((each) => each.faction === "Netburners"),
          ).toBe(false);
          hacknetMinute(connection, 1, 1e12, { blackHand: 0, queued: ["Neural Wit Amplifier", ...NETBURNERS_FIVE] });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView().waitingFor).toBe("nothing: Netburners' augmentations installed or queued");
          hacknetMinute(connection, 2, 1e12, { blackHand: 0, ownedSF: { 9: 1 } });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView().waitingFor).toBe("nothing: Hacknet servers here (BN9 or SF9), left out");
          expect(
            (controller.augmentationsView().progress?.timing?.next ?? []).some((each) => each.faction === "Netburners"),
          ).toBe(false);
        });

        test("not worth its τ: The Black Hand's money 5 min off goes first, and the wait for 1 doesn't reach Netburners'", () => {
          onlyHacknet();
          const { controller, connection, sentIds } = connectedWithLoopOff("planner");
          // The income measured over ten minutes, then the Hacknet multipliers: Netburners' five among the countables.
          for (let minute = 0; minute <= 10; minute += 1) minuteAt(connection, minute, SHORT_OF_IT);
          hacknetMinute(connection, 11, SHORT_OF_IT);
          const timing = controller.augmentationsView().progress?.timing;
          expect(timing).toMatchObject({ needed: 5, adding: 4, choice: 1 });
          expect(timing?.next[0]).toMatchObject({ augmentation: TBH, way: "money" });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView()).toMatchObject({
            wanted: false,
            waitingFor: "the planner's wait to reach Netburners' countables",
          });
        });

        test("its hold is the set's money alone, as its τ has it, not Netburners' own countables' prices after it (#387's review)", () => {
          onlyHacknet();
          const { controller, connection, sentIds } = connectedWithLoopOff("planner");
          // The set's three and the setup's $169,660 in hand, not Netburners' first's price on top: ten minutes of
          // slow snapshots measure the income ($1m a second), the planner waits for Netburners' five.
          // At hacking 1,500, Netburners' first is within the lookahead's 15 minutes, so A6's reserve holds its price.
          const money = THREE_EXACTLY + 200_000;
          for (let minute = 0; minute <= 11; minute += 1) {
            hacknetMinute(connection, minute, money, { blackHand: 0, hacking: 1_500 });
          }
          const timing = controller.augmentationsView().progress?.timing;
          expect(timing?.next[0]).toMatchObject({ augmentation: NIC, faction: "Netburners" });
          expect(timing?.choice).toBeGreaterThanOrEqual(1);
          // A6's reserve counts the countables' prices (the set's, and those waited for, within the lookahead): over the
          // money, so the setup would wait for money its τ never waits for.
          expect(controller.augmentationsView().reserve).toBeGreaterThan(money);
          expect(controller.hacknetView()).toMatchObject({ wanted: true, buying: true, waitingFor: null });
          expect(sentIds()).toContain(HACKNET.id);
        });

        test("a program first, then the setup; short of the money above the holds, it waits", () => {
          store.setSetting("homeRam.enabled", "false");
          const { controller, connection, sentIds } = connectedWithLoopOff("planner");
          hacknetMinute(connection, 0, 1e12, { blackHand: 0 });
          expect(sentIds().some((id) => id.startsWith("buyProgram("))).toBe(true);
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView().waitingFor).toBe("BruteSSH.exe first");
          store.setSetting("programs.enabled", "false");
          // $100k, short of the set's money and the setup's: with no income measured, its money never comes, so
          // Netburners' are no candidates.
          hacknetMinute(connection, 1, 100_000, { blackHand: 0 });
          expect(sentIds()).not.toContain(HACKNET.id);
          expect(controller.hacknetView().waitingFor).toBe("the planner's wait to reach Netburners' countables");
          // The income measured ($1m a second): the set's money and the setup's come within a minute, the planner waits
          // for Netburners', and the setup waits for its money.
          for (let minute = 2; minute <= 11; minute += 1) hacknetMinute(connection, minute, 100_000, { blackHand: 0 });
          // CyberSec's three by the money first, then Netburners'.
          const next = controller.augmentationsView().progress?.timing?.next ?? [];
          expect(next.slice(0, 3).map((each) => each.faction)).toEqual(["CyberSec", "CyberSec", "CyberSec"]);
          expect(next[3]).toMatchObject({ augmentation: NIC, faction: "Netburners" });
          expect(controller.hacknetView().wanted).toBe(true);
          expect(sentIds()).not.toContain(HACKNET.id);
          // The money above the holds: here the city group's trip, which the invitations rule holds (#228).
          // A city group's trip's $20.2m, with $100k: the setup's $169,660 at ×1 waits.
          expect(controller.hacknetView().waitingFor).toBe(
            "money above the $20,200,000 held for an invitation travelled for (#228) ($169,660 the setup)",
          );
        });
      });
    });

    test("purchases reported done after the medium snapshot: their money taken off it (#213 re-review)", () => {
      const { controller, connection, sentIds } = connectedWithLoopOff();
      // The game's times: the medium snapshot at 1,000, each purchase reported done in a fast snapshot after it.
      const at = (tier: SnapshotTier, data: unknown, gameTimeMs: number) =>
        connection.receive(
          encodeControlMessage({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            type: "snapshot",
            agentSessionId: "session-1",
            tier,
            sequenceNumber: ++sequenceNumber,
            gameTimeMs,
            data,
          }),
        );
      const fastAt = (id: string, gameTimeMs: number) =>
        at(
          "fast",
          {
            degradedTiers: [],
            pageHeapUsedBytes: null,
            game: null,
            intents: [{ id, done: true, tries: 1, problem: null, backend: "sim" }],
          },
          gameTimeMs,
        );
      send(connection, "slow", slowWith());
      // $447,170,900: the five exactly; the countdown run out (#222) at 91,000.
      send(connection, "medium", richMedium(447_170_900));
      pastCountdown(connection, richMedium(447_170_900));
      for (const [index, name] of FIVE.entries()) {
        expect(sentIds()).toEqual([buy(name).id]);
        fastAt(buy(name).id, 92_000 + index);
      }
      // Nothing left: no NeuroFlux Governor on money already spent; waiting for the faction state to show the five.
      expect(sentIds()).toEqual([]);
      expect(controller.augmentationsView().waitingFor).toMatch(/^the faction state to show /);
      // A medium snapshot taken after them is the money: $30m, NeuroFlux Governor level 1 ($18.6m).
      at("medium", richMedium(30e6), 100_000);
      expect(sentIds()).toEqual([buy("NeuroFlux Governor").id]);
    });

    test("not committed: the rule's purchases don't hold the programs back", () => {
      const { controller, connection, sentIds } = connectedWithLoopOff();
      send(connection, "slow", {
        ...slowWith(),
        factions: { ...slowWith().factions, state: { joined: [], invitations: [], queuedAugmentations: [] } },
      });
      send(connection, "medium", richMedium(1e9));
      // Nothing joined: group A (seven, as B, in fewer travels) chosen, Sector-12's $15m held here (#228); the program
      // goes, above it.
      expect(sentIds()).toEqual([buyProgram("BruteSSH.exe").id]);
      expect(controller.invitationsView()).toMatchObject({ travel: null, hold: 15e6 });
      expect(controller.augmentationsView()).toMatchObject({ committed: false });
      expect(controller.augmentationReserve()).toBe(0);
    });

    test("the install: after the owner's queue, through the gate and a backup, as `augmentation`; stored as sent", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, settleBackup } = connectedWithLoopOff();
      const sent: unknown[] = [];
      // The travel for invitations (#228) has its own tests.
      controller.subscribe((event) => isInvitationEvent(event) || sent.push(event));
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      // All five bought already, no money left: the install is what's left, once its countdown has run out (#222).
      send(connection, "slow", slowWith(FIVE));
      send(connection, "medium", richMedium(0));
      pastCountdown(connection, richMedium(0));
      send(connection, "medium", richMedium(0));
      expect(waitingFor(INSTALL.id)).toBe("held: travel(Aevum), queued before it, isn't done");
      expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
        [AEVUM.id, "manual"],
        [INSTALL.id, "augmentation"],
      ]);
      expect(sentIds()).toEqual([AEVUM.id]);
      reportedDone(connection, AEVUM.id);
      send(connection, "medium", richMedium(0));
      send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(1);
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
      expect(sent).toEqual([
        // The time to the destroy (#360): the first slow snapshot shows a cycle after the BitNode's first, and the brain
        // has no note for the BitNode, so a first look ("first seen"), not an install.
        expect.objectContaining({ type: DESTROY_ESTIMATED_EVENT_KIND, moment: "first seen", lastAugReset: 1000 }),
        expect.objectContaining({ type: "augmentationProgress", countdown: expect.objectContaining({ quick: true }) }),
        expect.objectContaining({ type: "augmentationInstallChosen" }),
        { type: "augmentationInstallSent", atMs: expect.any(Number), source: "brain", queued: FIVE },
      ]);
      // The install kills the Agent: awaiting its restart until a slow snapshot shows the reset.
      expect(controller.installAwaitingRestart()).toBeNull();
      connection.dropFromGameSide();
      expect(controller.installAwaitingRestart()).toEqual({ id: INSTALL.id, sinceMs: expect.any(Number) });
      const again = connectAgent("session-2");
      // Back: no longer awaited (#213 review); its slow snapshot shows the reset, or the gate sends it again.
      expect(controller.installAwaitingRestart()).toBeNull();
      send(again, "static", network, "session-2");
      send(
        again,
        "slow",
        { ...slowWith([], 90_000), resetInfo: { ...slowWith([], 90_000).resetInfo, ownedAugs: { BitWire: 1 } } },
        "session-2",
      );
      expect(controller.installAwaitingRestart()).toBeNull();
      expect(controller.intentsView()).toEqual([]);
      expect(controller.augmentationsView()).toMatchObject({ committed: false });
      expect(backupNow).toHaveBeenCalledTimes(1);
    });

    test("out, a travel queued ahead of it (#271): withdrawn at once, held, then a new backup", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, settleBackup } = connectedWithLoopOff();
      send(connection, "slow", slowWith(FIVE));
      send(connection, "medium", richMedium(0));
      pastCountdown(connection, richMedium(0));
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
      // The owner's travel goes ahead of the brain's install: its guard, judged on this update, not the next snapshot.
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      expect(sentIds()).toEqual([AEVUM.id]);
      expect(waitingFor(INSTALL.id)).toBe("held: travel(Aevum), queued before it, isn't done");
      // The travel done: not out on its old release, but past its guard and a new backup.
      reportedDone(connection, AEVUM.id);
      expect(sentIds()).toEqual([]);
      expect(waitingFor(INSTALL.id)).toBe("waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)");
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(2);
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
    });

    /** Connected with the brain's install chosen: CyberSec's five bought, no money left, its countdown run out. */
    const installChosen = () => {
      const connected = connectedWithLoopOff();
      send(connected.connection, "slow", slowWith(FIVE));
      send(connected.connection, "medium", richMedium(0));
      pastCountdown(connected.connection, richMedium(0));
      return connected;
    };

    test("queued ahead of it mid-count, done before the next snapshot (#271): it counts two afresh", async () => {
      const { controller, connection, waitingFor, backupNow } = installChosen();
      send(connection, "medium", richMedium(0));
      expect(waitingFor(INSTALL.id)).toBe("waiting for the guard to hold on 2 consecutive medium snapshots (1 so far)");
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      reportedDone(connection, AEVUM.id);
      // Not one more: the snapshot it held on came before the travel, so R8's two are counted again.
      expect(waitingFor(INSTALL.id)).toBe("waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)");
      send(connection, "medium", richMedium(0));
      expect(backupNow).not.toHaveBeenCalled();
      send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(1);
    });

    test("held by the queue, a medium snapshot counts nothing: still held, no backup asked for", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, settleBackup } = installChosen();
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      await settleBackup(SAVED);
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      for (let each = 0; each < 3; each += 1) send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(1);
      expect(sentIds()).toEqual([AEVUM.id]);
      expect(waitingFor(INSTALL.id)).toBe("held: travel(Aevum), queued before it, isn't done");
    });

    test("a backup answered after the intent ahead is done (#271): releases nothing, counted afresh", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, settleBackup } = installChosen();
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(1);
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      reportedDone(connection, AEVUM.id);
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([]);
      expect(waitingFor(INSTALL.id)).toBe("waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)");
    });

    test("out, the intent ahead cancelled rather than done (#271): out again only past a new backup", async () => {
      const { controller, connection, sentIds, backupNow, settleBackup } = installChosen();
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      controller.cancelManualIntent(AEVUM.id);
      expect(sentIds()).toEqual([]);
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(2);
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
    });

    test("its backup taken as the owner queues ahead of it (#271): that backup releases nothing", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, settleBackup } = connectedWithLoopOff();
      send(connection, "slow", slowWith(FIVE));
      send(connection, "medium", richMedium(0));
      pastCountdown(connection, richMedium(0));
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      expect(backupNow).toHaveBeenCalledTimes(1);
      controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([AEVUM.id]);
      expect(waitingFor(INSTALL.id)).toBe("held: travel(Aevum), queued before it, isn't done");
    });

    test("the install reported done with no reset in the next slow snapshot: withdrawn, alerted (#213 re-review)", async () => {
      const { controller, connection, sentIds, settleBackup } = connectedWithLoopOff();
      const sent: { type: string }[] = [];
      // The travel for invitations (#228) has its own tests.
      controller.subscribe((event) => isInvitationEvent(event) || sent.push(event));
      send(connection, "slow", slowWith(FIVE));
      // The countdown from the first medium snapshot, chosen at its end (#222); the gate's two after it.
      send(connection, "medium", richMedium(0));
      pastCountdown(connection, richMedium(0));
      for (let each = 0; each < 2; each += 1) send(connection, "medium", richMedium(0));
      await settleBackup(SAVED);
      expect(sentIds()).toEqual([INSTALL.id]);
      // The game had nothing to install: done, and the next slow snapshot (the game's time on) shows no reset.
      reportedDone(connection, INSTALL.id);
      expect(controller.installAwaitingRestart()).toBeNull();
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier: "slow",
          sequenceNumber: ++sequenceNumber,
          gameTimeMs: 61_000,
          data: slowWith(FIVE),
        }),
      );
      expect(controller.installAwaitingRestart()).toEqual({
        id: INSTALL.id,
        sinceMs: expect.any(Number),
        doneNotReset: true,
      });
      expect(controller.intentsView()).toEqual([]);
      expect(controller.augmentationsView()).toMatchObject({ committed: false });
      expect(controller.augmentationReserve()).toBe(0);
      expect(sent.map((event) => event.type)).toEqual([
        // The first slow snapshot's first look (#360); the next, the same cycle, none.
        DESTROY_ESTIMATED_EVENT_KIND,
        "augmentationProgress",
        "augmentationInstallChosen",
        "augmentationInstallSent",
        "augmentationInstallNotReset",
        "augmentationCycleCalledOff",
      ]);
    });

    test("a restarted brain awaits an install's restart from when it went out, until the Agent connects", () => {
      store.setSetting("augmentations.cycle", JSON.stringify({ lastAugReset: 1_000, installing: true }));
      writeResetSentNote(store, { id: INSTALL.id, field: "lastAugReset", resetAt: 1_000, sentAtMs: 5 });
      const controller = new DesiredStateController({ channel, store });
      expect(controller.installAwaitingRestart()).toEqual({ id: INSTALL.id, sinceMs: 5 });
      connectAgent();
      expect(controller.installAwaitingRestart()).toBeNull();
    });

    /** `richMedium` at hacking `hacking`, with home's RAM `homeRam` and w0r1d_d43m0n rooted if said. */
    const lateMedium = (money: number, { hacking = 3000, homeRam = 2 ** 20, daemon = false } = {}) => {
      const medium = richMedium(money);
      const servers = medium.servers.map((server) =>
        server.hostname === "home" ? { ...server, maxRam: homeRam } : server,
      );
      return {
        ...medium,
        player: { ...medium.player, skills: { ...medium.player.skills, hacking } },
        servers: daemon
          ? [...servers, { ...(servers[0] as (typeof servers)[number]), hostname: "w0r1d_d43m0n", maxRam: 0 }]
          : servers,
      };
    };

    test("the World Daemon's destroy goes before the brain's install (#215 review): an install drops its level", () => {
      store.setSetting("augmentations.cycle", JSON.stringify({ lastAugReset: 1_000, installing: true }));
      const { controller, connection } = connectedWithLoopOff();
      send(connection, "static", {
        servers: [
          ...network.servers,
          staticServer("w0r1d_d43m0n", { requiredHackingSkill: 3000, numOpenPortsRequired: 5 }),
        ],
      });
      const slow = slowWith(FIVE);
      send(connection, "slow", { ...slow, resetInfo: { ...slow.resetInfo, ownedAugs: { "The Red Pill": 1 } } });
      send(connection, "medium", lateMedium(0, { daemon: true }));
      expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
        ["destroyBitNode(4)", "worldDaemon"],
        [INSTALL.id, "augmentation"],
      ]);
    });

    // With nothing left in the campaign's order to gain too (#311, #321): the destroy, a replay, is wanted all the
    // same.
    test.each([
      ["", {}],
      [", with nothing left in the order to gain (#311, #321)", { 1: 3, 2: 3, 4: 3, 5: 3 }],
    ])("The Red Pill installed, the destroy on%s: no ordinary install chosen (#215 review)", (_, ownedSF) => {
      const { controller, connection } = connectedWithLoopOff();
      const slow = slowWith();
      send(connection, "slow", {
        ...slow,
        resetInfo: { ...slow.resetInfo, currentNode: 1, ownedSF, ownedAugs: { "The Red Pill": 1 } },
      });
      send(connection, "medium", lateMedium(1e9, { hacking: 300 }));
      expect(controller.augmentationsView()).toMatchObject({ committed: false });
      expect(controller.augmentationsView().waitingFor).toMatch(/^the BitNode's destroy: The Red Pill is installed/);
      // Off, ordinary installs go on: CyberSec's five, once the countdown has run out (#222).
      controller.setWorldDaemonEnabled(false);
      expect(controller.augmentationsView()).toMatchObject({
        committed: false,
        progress: { countdown: { quick: true } },
      });
      pastCountdown(connection, lateMedium(1e9, { hacking: 300 }));
      expect(controller.augmentationsView()).toMatchObject({ committed: true });
    });

    test("Daedalus's $100b held from home RAM too (#215 review)", () => {
      const thirty = Object.fromEntries(
        AUGMENTATION_NAMES.filter((name) => name !== "The Red Pill" && name !== "NeuroFlux Governor")
          .slice(0, 30)
          .map((name) => [name, 1]),
      );
      const { controller, connection } = connectedWithLoopOff();
      const slow = slowWith();
      send(connection, "slow", { ...slow, resetInfo: { ...slow.resetInfo, ownedAugs: thirty } });
      // $101b: home's next upgrade (1 TB to 2 TB, about $3b) would take it under $100b.
      send(connection, "medium", lateMedium(101e9, { hacking: 2600, homeRam: 1024 }));
      expect(controller.homeRamView().waitingFor).toBe(
        "money above the $100,000,000,000 held for Daedalus's invitation",
      );
    });

    test("The Red Pill's donation's money held from home RAM and programs too (#225 review)", () => {
      const { controller, connection } = connectedWithLoopOff();
      const slow = slowWith();
      const daedalus = { name: "Daedalus", reputation: 0, favor: 150 };
      send(connection, "slow", {
        ...slow,
        factions: { ...slow.factions, state: { ...slow.factions.state, joined: [daedalus] } },
      });
      // $2t, short of the $2.5t donation for The Red Pill's 2.5m: home's next upgrade and BruteSSH.exe both wait.
      send(connection, "medium", { ...lateMedium(2e12, { hacking: 2600, homeRam: 1024 }), programs: [] });
      const held = "money above the $2,500,000,010,000 held for The Red Pill's donation";
      expect(controller.homeRamView().waitingFor).toBe(held);
      expect(controller.programsView().waitingFor).toBe(held);
      expect(controller.augmentationReserve()).toBe(2_500_000_010_000);
    });

    /** TOR owned, no port opener, home at 1 TB: the purse the brain's snapshots below show. */
    const ENDGAME_PURSE: Purse = { spent: 0, programs: 1, cloudServersRamGb: [], homeRamGb: 1024 };
    /** The fast model's next purchase (#263) on the same state: its own A6 decision, its holds. */
    const modelsPurchase = (installed: Record<string, number>, joined: FactionState["joined"], money: number) => {
      const decision = installDecision({
        installed,
        joined,
        currentNode: 1,
        ownedSF: {},
        money,
        hacking: 2600,
        factionRep: 1,
        onlineMs: 0,
      });
      return { decision, purchase: nextPurchase(ENDGAME_PURSE, money, null, holdsOf(decision, false, null)) };
    };
    const purchasesSent = (connection: MemoryConnection) =>
      (desiredStates(connection).at(-1)?.intents ?? []).filter((each) => PURCHASE_ACTIONS.includes(each.action));

    test("brain against the fast model (#263): Daedalus's $100b holds home's RAM, not BruteSSH.exe", () => {
      const thirty = Object.fromEntries(
        AUGMENTATION_NAMES.filter((name) => name !== "The Red Pill" && name !== "NeuroFlux Governor")
          .slice(0, 30)
          .map((name) => [name, 1]),
      );
      const { connection } = connectedWithLoopOff();
      const slow = slowWith();
      send(connection, "slow", { ...slow, resetInfo: { ...slow.resetInfo, ownedAugs: thirty } });
      send(connection, "medium", { ...lateMedium(101e9, { hacking: 2600, homeRam: 1024 }), programs: [] });
      const model = modelsPurchase(thirty, slow.factions.state.joined, 101e9);
      expect(model.decision).toMatchObject({ endgameHold: 100e9, endgameHoldFor: "daedalus" });
      expect(purchasesSent(connection)).toEqual([buyProgram("BruteSSH.exe")]);
      expect(model.purchase === null ? null : brainIntentOf(model.purchase, ENDGAME_PURSE)).toEqual(
        buyProgram("BruteSSH.exe"),
      );
    });

    test("brain against the fast model (#263): The Red Pill's donation holds home's RAM and programs alike", () => {
      const { connection } = connectedWithLoopOff();
      const slow = slowWith();
      const joined = [{ name: "Daedalus", reputation: 0, favor: 150 }];
      send(connection, "slow", { ...slow, factions: { ...slow.factions, state: { ...slow.factions.state, joined } } });
      send(connection, "medium", { ...lateMedium(2e12, { hacking: 2600, homeRam: 1024 }), programs: [] });
      const model = modelsPurchase({}, joined, 2e12);
      expect(model.decision).toMatchObject({ endgameHold: 2_500_000_010_000, endgameHoldFor: "redPill" });
      expect(purchasesSent(connection)).toEqual([]);
      expect(model.purchase).toBeNull();
    });

    test("the owner's install queued too: one install, the owner's", () => {
      const { controller, connection } = connectedWithLoopOff();
      controller.addManualIntent({ action: "installAugmentations", args: {} });
      send(connection, "slow", slowWith(FIVE));
      send(connection, "medium", richMedium(0));
      expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([[INSTALL.id, "manual"]]);
    });

    test("the switch: kept in the store; off, nothing is bought or installed", () => {
      const { controller, connection, sentIds } = connectedWithLoopOff();
      controller.setAugmentationsEnabled(false);
      expect(store.getSetting("augmentations.enabled")).toBe("false");
      send(connection, "slow", slowWith());
      send(connection, "medium", richMedium(1e9));
      expect(sentIds()).toEqual([buyProgram("BruteSSH.exe").id]);
      expect(controller.augmentationsView()).toMatchObject({ enabled: false, committed: false });
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

    describe("the brain's destroy (#215)", () => {
      // From BN1 with Source-File 4 short of 3: into BN4, the campaign's order's next (#321).
      const BRAINS = intent({ action: "destroyBitNode", args: { nextBitNode: 4 } });
      /** With nothing left in the order to gain: into BN1, a replay (#311). */
      const REPLAYS = intent({ action: "destroyBitNode", args: { nextBitNode: 1 } });
      /**
       * Connected with w0r1d_d43m0n in the static snapshot and The Red Pill installed in the slow one, in BN1 with
       * `ownedSF` (none unless said).
       */
      function withTheRedPill({ ownedSF = {} as Record<string, number>, currentNode = 1 } = {}) {
        const connected = connectedWithLoopOff();
        send(connected.connection, "static", staticWithDaemon());
        const slow = slowAt(1_000, 1_000);
        send(connected.connection, "slow", {
          ...slow,
          resetInfo: {
            ...slow.resetInfo,
            currentNode,
            ownedAugs: { "The Red Pill": 1 },
            ownedSF,
          },
        });
        const daemonMedium = (hacking = 3000, { rooted = true } = {}) =>
          send(connected.connection, "medium", mediumData(hacking, { [WD]: rooted }));
        return { ...connected, daemonMedium };
      }

      test("once w0r1d_d43m0n is rooted at its level: into BitNode 4 (#321), through the gate and a backup, stored as sent", async () => {
        const { controller, sentIds, waitingFor, backupNow, settleBackup, daemonMedium } = withTheRedPill();
        const stored: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
        daemonMedium(3000, { rooted: false });
        expect(controller.intentsView().map((view) => view.id)).not.toContain(BRAINS.id);
        daemonMedium();
        expect(controller.intentsView().map(({ id, source }) => [id, source])).toContainEqual([
          BRAINS.id,
          "worldDaemon",
        ]);
        expect(controller.worldDaemonView()).toMatchObject({ enabled: true, destroying: true, nextBitNode: 4 });
        expect(waitingFor(BRAINS.id)).toBe(
          "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)",
        );
        daemonMedium();
        daemonMedium();
        expect(backupNow).toHaveBeenCalledTimes(1);
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([BRAINS.id]);
        expect(stored).toEqual([
          {
            type: "bitNodeDestroySent",
            atMs: expect.any(Number),
            source: "brain",
            nextBitNode: 4,
            replay: null,
            skipped: null,
          },
        ]);
      });

      test("from BN2.3 (#323, #334): into BN5 again, past the BitNodes the brain can't play yet, in the view and stored", async () => {
        const { controller, sentIds, settleBackup, daemonMedium } = withTheRedPill({
          ownedSF: { 1: 3, 4: 3, 5: 1, 2: 2 },
          currentNode: 2,
        });
        const stored: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
        daemonMedium();
        const skipped =
          "BN6 and BN7 skipped: no win route yet (the Black Ops, Bladeburner's B6); " +
          "BN3 skipped: no hacking multipliers or prices yet";
        expect(controller.worldDaemonView()).toMatchObject({ nextBitNode: 5, replay: null, skipped });
        daemonMedium();
        daemonMedium();
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([intent({ action: "destroyBitNode", args: { nextBitNode: 5 } }).id]);
        expect(stored).toEqual([
          {
            type: "bitNodeDestroySent",
            atMs: expect.any(Number),
            source: "brain",
            nextBitNode: 5,
            replay: null,
            skipped,
          },
        ]);
      });

      test("from BN5.1, the owner's destroy into BN5 too (#323): stored without the order's skips", async () => {
        const { controller, sentIds, settleBackup, daemonMedium } = withTheRedPill({
          ownedSF: { 1: 3, 4: 3 },
          currentNode: 5,
        });
        const stored: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
        controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 5 } });
        daemonMedium();
        // The view names the owner's BitNode, with none of the order's skips.
        expect(controller.worldDaemonView()).toMatchObject({ ownersDestroy: true, nextBitNode: 5, skipped: null });
        daemonMedium();
        daemonMedium();
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([intent({ action: "destroyBitNode", args: { nextBitNode: 5 } }).id]);
        expect(stored).toEqual([
          {
            type: "bitNodeDestroySent",
            atMs: expect.any(Number),
            source: "manual",
            nextBitNode: 5,
            replay: null,
            skipped: null,
          },
        ]);
      });

      test("with nothing left in the order to gain (#311, #321): into BN1 all the same, a replay, in the view and stored", async () => {
        const { controller, sentIds, settleBackup, daemonMedium } = withTheRedPill({
          ownedSF: { 1: 3, 2: 3, 4: 3, 5: 3 },
        });
        const stored: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
        daemonMedium();
        const replay =
          "the campaign's order has nothing playable left to gain (Source-File 1 at 3, Source-File 2 at 3, Source-File 4 at 3, " +
          "Source-File 5 at 3), but the run";
        const skipped =
          "BN6 and BN7 skipped: no win route yet (the Black Ops, Bladeburner's B6); " +
          "BN3, BN9, BN11, BN8, BN15, BN10, BN13, BN14 and BN12 skipped: no hacking multipliers or prices yet";
        expect(controller.worldDaemonView()).toMatchObject({
          destroying: true,
          nextBitNode: 1,
          replay,
          skipped,
          stall: null,
        });
        daemonMedium();
        daemonMedium();
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([REPLAYS.id]);
        expect(stored).toEqual([
          { type: "bitNodeDestroySent", atMs: expect.any(Number), source: "brain", nextBitNode: 1, replay, skipped },
        ]);
      });

      test("at the cap, the owner's destroy into another BitNode is no replay (#311): stored without one", async () => {
        const { controller, sentIds, settleBackup, daemonMedium } = withTheRedPill({
          ownedSF: { 1: 3, 2: 3, 4: 3, 5: 3 },
        });
        const stored: unknown[] = [];
        controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
        controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
        daemonMedium();
        // The view names the owner's BitNode, with neither the brain's replay nor its skips (#323).
        expect(controller.worldDaemonView()).toMatchObject({
          ownersDestroy: true,
          nextBitNode: 2,
          replay: null,
          skipped: null,
        });
        daemonMedium();
        daemonMedium();
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([DESTROY.id]);
        // Nor are the brain's skips said (#323): it's the owner's.
        expect(stored).toEqual([
          {
            type: "bitNodeDestroySent",
            atMs: expect.any(Number),
            source: "manual",
            nextBitNode: 2,
            replay: null,
            skipped: null,
          },
        ]);
      });

      /** The Agent reports the owner's travel to Aevum done. */
      const travelDone = (connection: MemoryConnection) =>
        send(connection, "fast", {
          degradedTiers: [],
          pageHeapUsedBytes: null,
          game: null,
          intents: [{ id: AEVUM.id, done: true, tries: 1, problem: null, backend: "sim" }],
        });

      test("its backup taken as the owner queues ahead of it (#271): that backup releases nothing", async () => {
        const { controller, connection, sentIds, waitingFor, settleBackup, daemonMedium } = withTheRedPill();
        for (let each = 0; each < 3; each += 1) daemonMedium();
        controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([AEVUM.id]);
        expect(waitingFor(BRAINS.id)).toBe("held: travel(Aevum), queued before it, isn't done");
        travelDone(connection);
        expect(sentIds()).toEqual([]);
        expect(waitingFor(BRAINS.id)).toBe(
          "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)",
        );
      });

      test("out, a travel queued ahead of it (#271): withdrawn at once, held, then a new backup", async () => {
        const { controller, connection, sentIds, waitingFor, backupNow, settleBackup, daemonMedium } = withTheRedPill();
        for (let each = 0; each < 3; each += 1) daemonMedium();
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([BRAINS.id]);
        controller.addManualIntent({ action: "travel", args: { city: "Aevum" } });
        expect(sentIds()).toEqual([AEVUM.id]);
        expect(waitingFor(BRAINS.id)).toBe("held: travel(Aevum), queued before it, isn't done");
        travelDone(connection);
        expect(sentIds()).toEqual([]);
        expect(waitingFor(BRAINS.id)).toBe(
          "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)",
        );
        daemonMedium();
        daemonMedium();
        expect(backupNow).toHaveBeenCalledTimes(2);
        await settleBackup(SAVED);
        expect(sentIds()).toEqual([BRAINS.id]);
      });

      test("a restarted brain keeps its destroy's note, asking again until the reset shows (#215 review)", () => {
        writeResetSentNote(store, { id: BRAINS.id, field: "lastNodeReset", resetAt: 1_000, sentAtMs: 5 });
        const controller = new DesiredStateController({ channel, store });
        expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([[BRAINS.id, "worldDaemon"]]);
        expect(readResetSentNote(store)).toMatchObject({ id: BRAINS.id, resetAt: 1_000 });
        const connection = connectAgent();
        send(connection, "slow", slowAt(1_000, 2_000));
        expect(controller.intentsView()).toEqual([]);
        expect(readResetSentNote(store)).toBeNull();
      });

      test("the owner's destroy wins, whatever BitNode it enters; the switch off, none of the brain's", () => {
        const { controller, daemonMedium } = withTheRedPill();
        controller.addManualIntent({ action: "destroyBitNode", args: { nextBitNode: 2 } });
        daemonMedium();
        expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([[DESTROY.id, "manual"]]);
        // The dashboard names the owner's BitNode (#321).
        expect(controller.worldDaemonView()).toMatchObject({ destroying: true, ownersDestroy: true, nextBitNode: 2 });
        expect(controller.cancelManualIntent(DESTROY.id)).toBe(true);
        controller.setWorldDaemonEnabled(false);
        expect(store.getSetting("worldDaemon.enabled")).toBe("false");
        daemonMedium();
        expect(controller.intentsView()).toEqual([]);
        expect(controller.worldDaemonView()).toMatchObject({ enabled: false, destroying: false });
      });
    });

    test("its guard: what's queued before it first, then w0r1d_d43m0n's preconditions, each saying why, before any backup", async () => {
      const { controller, connection, sentIds, waitingFor, backupNow, daemonMedium, releaseDestroy } = readyToDestroy();
      const stored: unknown[] = [];
      controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
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
      // Stored as it goes out (#215): the owner's, into their BitNode.
      expect(stored).toEqual([
        {
          type: "bitNodeDestroySent",
          atMs: expect.any(Number),
          source: "manual",
          nextBitNode: 2,
          replay: null,
          skipped: null,
        },
      ]);
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

describe("factions and their work (#203)", () => {
  const JOIN_CYBERSEC = intent({ action: "joinFaction", args: { faction: "CyberSec" } });
  /** A medium snapshot with every skill the work's rate reads: hacking 55, the factions joined. */
  const withSkills = (factions: string[] = []) => {
    const data = mediumData(55, { n00dles: true }, { factions });
    data.player = {
      ...data.player,
      skills: { hacking: 55, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: 1 },
    };
    return data;
  };
  /** A slow snapshot with CyberSec joined at `reputation`, or invited. */
  const factionsSlow = ({ joined, invited = [] as string[] }: { joined?: number; invited?: string[] }) => {
    const data = slowData(1);
    data.factions = {
      backend: "sim",
      state: {
        joined: joined === undefined ? [] : [{ name: "CyberSec", reputation: joined, favor: 0 }],
        invitations: invited,
        queuedAugmentations: [],
      },
      problem: null,
    };
    return data;
  };
  const lastState = (connection: MemoryConnection) =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .at(-1) as unknown as DesiredState | undefined;
  const HACKING_FOR_CYBERSEC = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true };

  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const lines: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
    const events: unknown[] = [];
    // The faction work's events: the augmentation rule's progress (#222) and the invitations' (#228) are their suites'.
    controller.subscribe((event) => {
      if (event.type !== "augmentationProgress" && !isInvitationEvent(event)) events.push(event);
    });
    const connection = connectAgent();
    send(connection, "static", network);
    return { controller, connection, lines, events };
  }

  test("an invitation joined, as source join, after the backdoor; until the medium snapshot shows it joined", () => {
    const { controller, connection, lines } = connected();
    send(connection, "slow", factionsSlow({ invited: ["CyberSec", "Sector-12"] }));
    send(connection, "medium", withSkills());
    expect(lastState(connection)?.intents).toEqual([JOIN_CYBERSEC]);
    expect(controller.intentsView()).toEqual([
      { id: JOIN_CYBERSEC.id, source: "join", outcome: null, waitingFor: null },
    ]);
    expect(controller.factionsView()).toMatchObject({
      joining: "CyberSec",
      passedOver: [{ faction: "Sector-12", bans: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"] }],
    });
    send(connection, "medium", withSkills(["CyberSec"]));
    expect(lastState(connection)?.intents).toEqual([]);
    expect(lines).toContain("factions: CyberSec joined");
    // Queued by the owner too: once, as the owner's.
    send(connection, "slow", factionsSlow({ invited: ["NiteSec"] }));
    controller.addManualIntent({ action: "joinFaction", args: { faction: "NiteSec" } });
    expect(lastState(connection)?.intents.map((each) => each.id)).toEqual(["joinFaction(NiteSec)"]);
    expect(controller.intentsView().map(({ source }) => source)).toEqual(["manual"]);
  });

  test("the brain's work sent with none of the owner's: its view says whose, and its choice is stored", () => {
    const { controller, connection, lines, events } = connected();
    send(connection, "medium", withSkills(["CyberSec"]));
    send(connection, "slow", factionsSlow({ joined: 0 }));
    expect(lastState(connection)?.work).toEqual(HACKING_FOR_CYBERSEC);
    expect(controller.workView()).toEqual({ desired: HACKING_FOR_CYBERSEC, source: "brain", outcome: null });
    expect(controller.factionsView()).toMatchObject({
      enabled: true,
      sent: true,
      choice: { augmentation: "Neurotrainer I" },
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "factionWorkChosen", faction: "CyberSec", augmentation: "Neurotrainer I" }),
      // The time to the destroy (#360): the BitNode's start, its first slow snapshot (its first cycle), after A5's
      // choice in the same update.
      expect.objectContaining({ type: DESTROY_ESTIMATED_EVENT_KIND, moment: "start" }),
    ]);
    expect(lines.filter((line) => line.startsWith("faction work:"))).toHaveLength(1);
  });

  test("the owner's work wins; the switch off sends none of the brain's, kept in the store; on again, sent", () => {
    const { controller, connection, events } = connected();
    send(connection, "medium", withSkills(["CyberSec"]));
    send(connection, "slow", factionsSlow({ joined: 0 }));
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    expect(lastState(connection)?.work).toEqual({ kind: "crime", crime: "Shoplift", focus: true });
    expect(controller.workView().source).toBe("owner");
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: "your work on the dashboard" });
    controller.setWork(null);
    expect(lastState(connection)?.work).toEqual(HACKING_FOR_CYBERSEC);
    controller.setFactionWorkEnabled(false);
    expect(store.getSetting("factionWork.enabled")).toBe("false");
    expect(lastState(connection)?.work).toBeUndefined();
    expect(controller.workView()).toEqual({ desired: null, source: null, outcome: null });
    expect(controller.factionsView()).toMatchObject({
      enabled: false,
      waitingFor: "the brain's faction work is switched off",
    });
    // A restarted brain keeps the switch off.
    expect(
      new DesiredStateController({
        channel: new ControlChannel({ token: TOKEN, clock: new ManualClock() }),
        store,
      }).factionsView().enabled,
    ).toBe(false);
    controller.setFactionWorkEnabled(true);
    expect(lastState(connection)?.work).toEqual(HACKING_FOR_CYBERSEC);
    expect(
      events.map((event) => (event as { type: string; reason?: string }).reason ?? (event as { type: string }).type),
    ).toEqual([
      "factionWorkChosen",
      // The BitNode's start (#360), at the first slow snapshot: once, whatever the work.
      DESTROY_ESTIMATED_EVENT_KIND,
      "your work on the dashboard",
      "factionWorkChosen",
      "the brain's faction work is switched off",
      "factionWorkChosen",
    ]);
  });

  test("factionWorkStall(): the faction and since when, for the alert; none once disconnected", () => {
    const { controller, connection } = connected();
    send(connection, "medium", withSkills(["CyberSec"]));
    send(connection, "slow", factionsSlow({ joined: 0 }));
    expect(controller.factionWorkStall()).toEqual({
      faction: "CyberSec",
      sinceMs: expect.any(Number),
      lastReadingAtMs: expect.any(Number),
    });
    connection.dropFromGameSide();
    expect(controller.factionWorkStall()).toBeNull();
    expect(controller.factionsView()).toMatchObject({ waiting: true, sent: false });
  });

  test("none before the connected Agent's slow snapshot, and none for a player who has joined nothing", () => {
    const { controller, connection, events } = connected();
    send(connection, "medium", withSkills());
    expect(lastState(connection)?.work).toBeUndefined();
    expect(events).toEqual([]);
    send(connection, "slow", factionsSlow({}));
    expect(lastState(connection)?.work).toBeUndefined();
    expect(controller.factionsView()).toMatchObject({ choice: null, waitingFor: "a faction to join" });
    // No faction work's event; the slow snapshot is the BitNode's start (#360), estimated whatever is joined.
    expect(events).toEqual([expect.objectContaining({ type: DESTROY_ESTIMATED_EVENT_KIND, moment: "start" })]);
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
    expect(controller.workView()).toEqual({ desired: null, source: null, outcome: null });
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

  test("the next program waiting for money is held back if the income covers it within a minute; one further off isn't", () => {
    // SQLInject.exe ($250m) is further off: nothing is held back.
    const far = earning(1e6, { programs: PORT_OPENER_PROGRAMS.slice(0, 4) });
    expect(sentPurchases(far.connection)).toEqual([buyServer("pserv-0", 16)]);
    far.connection.dropFromGameSide();
    // At $4,096 a second (on 32 GB), a minute brings $245,760: BruteSSH.exe ($500k), $100,000 short, is held back.
    const near = earning(0, { programs: [], noodlesRam: 32 }, { perSecond: 4_096, endMoney: 400_000 });
    expect(sentPurchases(near.connection)).toEqual([]);
    expect(near.controller.cloudServersView().waitingFor).toBe(
      "money for pserv-0 with 8 GB ($440,000, beyond $500,000 held for BruteSSH.exe)",
    );
  });

  test("of a program and home RAM both waiting, the cheaper is what's held back", () => {
    // FTPCrack.exe ($1.5m) and home RAM from 2 GB to 4 GB ($101,120), neither affordable at $100,000: the upgrade,
    // within the minute's $30,720.
    const { controller, connection } = earning(0, { programs: ["BruteSSH.exe"], homeRam: 2 }, { endMoney: 100_000 });
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView().waitingFor).toBe(
      "money for pserv-0 with 8 GB ($440,000, beyond $101,120 held for home RAM to 4 GB)",
    );
  });

  // The count rule's money held, short of Daedalus's count: its controllers' `installTiming` is "count rule" (#343: the
  // A/B's baseline); the planner's wait holds money only within the lookahead (augmentations.test.ts).
  describe("with augmentations (#210)", () => {
    /**
     * A slow snapshot 7 h into the cycle, `minute` minutes on: the joined factions, and the hacking money earned since the
     * install at `earnedPerSecond` (the augmentation rule's income).
     */
    const slowAt = (joined: { name: string; reputation: number }[], minute = 0, earnedPerSecond = 0) => ({
      ...slowData(),
      moneySources: { hacking: minute * 60 * earnedPerSecond },
      factions: {
        backend: "sim",
        state: { joined: joined.map((each) => ({ ...each, favor: 0 })), invitations: [], queuedAugmentations: [] },
        problem: null,
      },
    });
    const withPlayer = (data: ReturnType<typeof medium>) => ({
      ...data,
      player: {
        ...data.player,
        skills: { hacking: 300, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
        exp: { hacking: Math.exp(500 / 32) - 534.6 },
        mults: { faction_rep: 1, hacking: 1 },
      },
    });
    /** A snapshot at the game's time `gameTimeMs` (the rule samples each slow snapshot's once). */
    const sendAt = (connection: MemoryConnection, tier: SnapshotTier, data: unknown, gameTimeMs: number) =>
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier,
          sequenceNumber: ++sequenceNumber,
          gameTimeMs,
          data,
        }),
      );
    /**
     * As `earning`, with `joined` in a slow snapshot each minute, 7 h into the cycle, earning `earnedPerSecond` by the
     * game's count, and the player's hacking at 300.
     */
    const earningWithFactions = (
      money: number,
      joined: { name: string; reputation: number }[],
      earnedPerSecond = 20_000,
    ) => {
      const controller = new DesiredStateController({ channel, store, installTiming: "count rule" });
      const connection = connectAgent();
      send(connection, "static", network);
      for (let minute = 0; minute <= 10; minute++) {
        if (minute > 0) clock.advance(MINUTE);
        sendAt(connection, "slow", slowAt(joined, minute, earnedPerSecond), 7 * 3_600_000 + minute * MINUTE);
        send(connection, "medium", withPlayer(medium(money + minute * 60 * 512)));
      }
      return { controller, connection };
    };
    const CYBERSEC_ALL = [{ name: "CyberSec", reputation: 18_750 }];
    /** Eight reached (the rule's tests work it): CyberSec's five, and three of NiteSec's at 15,000. */
    const EIGHT = [...CYBERSEC_ALL, { name: "NiteSec", reputation: 15_000 }];
    const EIGHT_COST = chooseAugmentationsToBuy(
      [
        "Cranial Signal Processors - Gen I",
        "Cranial Signal Processors - Gen II",
        "BitWire",
        "Synaptic Enhancement Implant",
        "Neurotrainer I",
        "Artificial Synaptic Potentiation",
        "Neurotrainer II",
        "Embedded Netburner Module",
      ],
      {
        installed: {},
        queued: [],
        sourceFile11Level: 0,
        bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
      },
      1e15,
      300,
    ).money;
    const heldEight = `$${Math.round(EIGHT_COST).toLocaleString("en-US")}`;

    test("an install the count rule would choose with 15 minutes more income holds its money from cloud servers", () => {
      // $10m short of the eight at $20k/s: 15 minutes ($18m) covers them, 8 of 8, so their money is held back (#222).
      const near = earningWithFactions(EIGHT_COST - 10e6, EIGHT);
      expect(near.controller.augmentationsView()).toMatchObject({ committed: false, progress: { countdown: null } });
      expect(near.controller.augmentationReserve()).toBeCloseTo(EIGHT_COST, 0);
      expect(sentPurchases(near.connection)).toEqual([TRAVEL_CHONGQING]);
      expect(near.controller.cloudServersView().waitingFor).toMatch(
        /beyond \$2,927,417,20\d held for the augmentations to buy before the install\)$/,
      );
      near.connection.dropFromGameSide();
      // $40m short: not covered within the 15 minutes: nothing held back, and the largest server bought.
      const far = earningWithFactions(EIGHT_COST - 40e6, EIGHT);
      expect(far.controller.augmentationReserve()).toBe(0);
      expect(sentPurchases(far.connection)?.map((each) => each.action)).toEqual(["buyServer", "travel"]);
    });

    test("the install's countdown (#222): the counted purchases' money held from cloud servers and home RAM", () => {
      const controller = new DesiredStateController({ channel, store, installTiming: "count rule" });
      const connection = connectAgent();
      send(connection, "static", network);
      sendAt(connection, "slow", slowAt(EIGHT), 7 * 3_600_000);
      // Home at 8 GB, its next upgrade about $1m: under the money, but not above what's held.
      send(connection, "medium", withPlayer(medium(EIGHT_COST + 1_000, { homeRam: 8 })));
      expect(controller.augmentationsView()).toMatchObject({
        committed: false,
        progress: { reason: "count reached", countdown: { endsInMs: 90_000 } },
      });
      expect(controller.augmentationReserve()).toBeCloseTo(EIGHT_COST, 0);
      expect(sentPurchases(connection)).toEqual([]);
      expect(controller.homeRamView().waitingFor).toBe(
        `money above the ${heldEight} held for the augmentations' install countdown`,
      );
      // The switch off: nothing held, home's RAM upgraded.
      controller.setAugmentationsEnabled(false);
      expect(sentPurchases(connection)?.map((each) => each.action)).toEqual(["upgradeHomeRam"]);
    });

    test("brain against the fast model (#263): in the countdown, home's RAM under the held money waits; off, it goes", () => {
      const controller = new DesiredStateController({ channel, store, installTiming: "count rule" });
      const connection = connectAgent();
      send(connection, "static", network);
      sendAt(connection, "slow", slowAt(EIGHT), 7 * 3_600_000);
      const money = EIGHT_COST + 1_000;
      send(connection, "medium", withPlayer(medium(money, { homeRam: 8 })));
      const joined = EIGHT.map((each) => ({ ...each, favor: 0 }));
      const decision = installDecision({
        installed: {},
        joined,
        currentNode: 1,
        ownedSF: {},
        money,
        hacking: 300,
        factionRep: 1,
        onlineMs: 0,
        sinceResetMs: 7 * 3_600_000,
      });
      expect(decision.reason).toBe("count reached");
      // Every program owned, home at 8 GB: the brain's purse.
      const purse: Purse = { spent: 0, programs: 1 + PORT_OPENER_PROGRAMS.length, cloudServersRamGb: [], homeRamGb: 8 };
      const held = nextPurchase(purse, money, null, holdsOf(decision, true, null));
      expect(held).toBeNull();
      expect(sentPurchases(connection)).toEqual([]);
      controller.setAugmentationsEnabled(false);
      const free = nextPurchase(purse, money, null, NO_HOLDS) as Purchase;
      expect(sentPurchases(connection)).toEqual([brainIntentOf(free, purse)]);
    });

    test("an install held for Daedalus's count (#243 review): A5 works for its seller; travel goes on", () => {
      // 25 installed (none of group B's but those The Black Hand sells too), CyberSec's other three reached and Neural
      // Wit Amplifier queued: 29 of 30. The
      // Black Hand's own augmentation 5 minutes off at A5's rate, hacking 2,500 (Daedalus's), 8 h online.
      const TBH = "The Black Hand";
      const shopOf = (faction: string) => augmentationsSoldBy(faction, 1, null);
      const groupB = ["Chongqing", "New Tokyo", "Ishima"].flatMap(shopOf);
      const fillers = AUGMENTATION_NAMES.filter(
        (name) =>
          isWorthInstalling(name, true) &&
          ![...shopOf(TBH), ...shopOf("CyberSec"), ...groupB, "Neural Wit Amplifier"].includes(name),
      );
      const owned = Object.fromEntries(
        [
          ...shopOf(TBH).filter((name) => name !== TBH && name !== "NeuroFlux Governor"),
          "Cranial Signal Processors - Gen I",
          "Cranial Signal Processors - Gen II",
          "NeuroFlux Governor",
          ...fillers,
        ]
          .slice(0, 25)
          .map((name) => [name, 1]),
      );
      expect(Object.keys(owned)).toHaveLength(25);
      const player = (data: ReturnType<typeof medium>) => ({
        ...data,
        player: {
          ...data.player,
          skills: { hacking: 2_500, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
          exp: { hacking: Math.exp(2_700 / 32) - 534.6 },
          mults: { faction_rep: 1, hacking: 1 },
        },
      });
      const rate = factionReputationPerSecond(
        { skills: player(medium(0)).player.skills, mults: { faction_rep: 1 } },
        "hacking",
        { favor: 0, sourceFile15Level: 0, factionWorkRepGain: 1, focused: true, implant: false },
      );
      const slow = {
        ...slowData(),
        resetInfo: { ...slowData().resetInfo, ownedAugs: owned },
        factions: {
          backend: "sim",
          state: {
            joined: [
              { name: "CyberSec", reputation: 18_750, favor: 0 },
              { name: TBH, reputation: 100_000 - rate * 300, favor: 0 },
            ],
            invitations: [],
            queuedAugmentations: ["Neural Wit Amplifier"],
          },
          problem: null,
        },
      };
      store.setSetting(
        "augmentations.online",
        JSON.stringify({ lastAugReset: 0, onlineMs: 8 * 3_600_000, lastGameTimeMs: 7 * 3_600_000 }),
      );
      const lines: string[] = [];
      const controller = new DesiredStateController({
        channel,
        store,
        log: (line) => lines.push(line),
        installTiming: "count rule",
      });
      const connection = connectAgent();
      send(connection, "static", network);
      sendAt(connection, "slow", slow, 7 * 3_600_000 + MINUTE);
      send(connection, "medium", player(medium(1.5e9)));
      expect(controller.augmentationsView().progress?.countHold).toMatchObject({ augmentation: TBH, way: "work" });
      expect(controller.factionsView().choice).toMatchObject({ faction: TBH, augmentation: TBH, held: true });
      // Not an install under way: the travel for group B's invitations goes on.
      expect(sentPurchases(connection)).toContainEqual(TRAVEL_CHONGQING);
      // The brain's faction work switched off: nobody works for The Black Hand, so the hold is over, saying so.
      controller.setFactionWorkEnabled(false);
      send(connection, "medium", player(medium(1.5e9)));
      expect(controller.augmentationsView().progress?.countHold).toBeNull();
      expect(lines).toContain("augmentations: the hold for Daedalus's count is over: nobody works for The Black Hand");
    });

    test("the share bonus the batcher reports counts in A6's estimates (#345): The Black Hand 25 min off, held at ×1.6", () => {
      // As above, but The Black Hand 25 minutes off at A5's rate without the share: past the hold's 20 minutes.
      const TBH = "The Black Hand";
      const shopOf = (faction: string) => augmentationsSoldBy(faction, 1, null);
      const groupB = ["Chongqing", "New Tokyo", "Ishima"].flatMap(shopOf);
      const fillers = AUGMENTATION_NAMES.filter(
        (name) =>
          isWorthInstalling(name, true) &&
          ![...shopOf(TBH), ...shopOf("CyberSec"), ...groupB, "Neural Wit Amplifier"].includes(name),
      );
      const owned = Object.fromEntries(
        [
          ...shopOf(TBH).filter((name) => name !== TBH && name !== "NeuroFlux Governor"),
          "Cranial Signal Processors - Gen I",
          "Cranial Signal Processors - Gen II",
          "NeuroFlux Governor",
          ...fillers,
        ]
          .slice(0, 25)
          .map((name) => [name, 1]),
      );
      const player = (data: ReturnType<typeof medium>) => ({
        ...data,
        player: {
          ...data.player,
          skills: { hacking: 2_500, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
          exp: { hacking: Math.exp(2_700 / 32) - 534.6 },
          mults: { faction_rep: 1, hacking: 1 },
        },
      });
      const rate = factionReputationPerSecond(
        { skills: player(medium(0)).player.skills, mults: { faction_rep: 1 } },
        "hacking",
        { favor: 0, sourceFile15Level: 0, factionWorkRepGain: 1, focused: true, implant: false },
      );
      const slow = {
        ...slowData(),
        resetInfo: { ...slowData().resetInfo, ownedAugs: owned },
        factions: {
          backend: "sim",
          state: {
            joined: [
              { name: "CyberSec", reputation: 18_750, favor: 0 },
              { name: TBH, reputation: 100_000 - rate * 25 * 60, favor: 0 },
            ],
            invitations: [],
            queuedAugmentations: ["Neural Wit Amplifier"],
          },
          problem: null,
        },
      };
      store.setSetting(
        "augmentations.online",
        JSON.stringify({ lastAugReset: 0, onlineMs: 8 * 3_600_000, lastGameTimeMs: 7 * 3_600_000 }),
      );
      const controller = new DesiredStateController({ channel, store, installTiming: "count rule" });
      const connection = connectAgent();
      send(connection, "static", network);
      sendAt(connection, "slow", slow, 7 * 3_600_000 + MINUTE);
      send(connection, "medium", player(medium(1.5e9)));
      expect(controller.augmentationsView().progress?.countHold).toBeNull();
      // The batcher's health: share threads running, the bonus 1.6, sampled at the next slow snapshot. A6's estimate
      // takes the window's mean, (1 + 1.6) / 2: 25 / 1.3 minutes, held.
      const sharing = { wanted: true, threads: 1_000, ramGb: 4_000, hostsRamGb: 4_000, bonus: 1.6, roomGb: 0 };
      const health = { ...newBatcherHealth("n00dles", "r", 1_000), state: "batching" as const, sharing };
      send(connection, "fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null, batcher: health });
      sendAt(connection, "slow", slow, 7 * 3_600_000 + 2 * MINUTE);
      send(connection, "medium", player(medium(1.5e9)));
      expect(controller.augmentationsView().progress?.countHold).toMatchObject({
        augmentation: TBH,
        way: "work",
        etaMs: expect.closeTo((25 / 1.3) * MINUTE, -3),
      });
    });

    test("an install chosen: no cloud server at all, saying why, and the augmentation bought instead", () => {
      // CyberSec's five reached, and nothing else at the joined factions: committed at once.
      const { controller, connection } = earningWithFactions(1e9, CYBERSEC_ALL);
      expect(controller.augmentationsView()).toMatchObject({ committed: true });
      expect(sentPurchases(connection)).toEqual([
        intent({
          action: "purchaseAugmentation",
          args: { faction: "CyberSec", augmentation: "Cranial Signal Processors - Gen I", level: 1 },
        }),
      ]);
      expect(controller.cloudServersView()).toMatchObject({
        buying: null,
        waitingFor: "the install of augmentations chosen (cloud servers are lost at it)",
      });
      // The switch off: the reserve is gone, and the cloud server bought.
      controller.setAugmentationsEnabled(false);
      expect(controller.augmentationReserve()).toBe(0);
      expect(sentPurchases(connection)?.map((each) => each.action)).toEqual(["buyServer"]);
    });
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

  test("the reserve looks at what's short: a $250m program $20,000 away is held back, however far its whole price", () => {
    // SQLInject.exe ($250m), short by $20,000, less than a minute of $512 a second ($30,720).
    const { controller, connection } = earning(
      0,
      { programs: PORT_OPENER_PROGRAMS.slice(0, 4) },
      { endMoney: 249_980_000 },
    );
    expect(sentPurchases(connection)).toEqual([TRAVEL_CHONGQING]);
    expect(controller.cloudServersView().waitingFor).toBe(
      "money for pserv-0 with 8 GB ($440,000, beyond $250,000,000 held for SQLInject.exe)",
    );
  });

  test("a program or home RAM switched off holds nothing back", () => {
    const programs = earning(0, { programs: [], noodlesRam: 32 }, { perSecond: 4_096, endMoney: 450_000 });
    expect(sentPurchases(programs.connection)).toEqual([]);
    programs.controller.setProgramsEnabled(false);
    expect(sentPurchases(programs.connection)).toEqual([buyServer("pserv-0", 8)]);
    programs.connection.dropFromGameSide();
    const homeRam = earning(0, { programs: PORT_OPENER_PROGRAMS, homeRam: 2 }, { endMoney: 100_000 });
    expect(homeRam.controller.cloudServersView().waitingFor).toMatch(/held for home RAM to 4 GB/);
    homeRam.controller.setHomeRamEnabled(false);
    expect(homeRam.controller.cloudServersView().waitingFor).toBe("money for pserv-0 with 8 GB ($440,000)");
  });

  test("brain against the fast model (#263): the same purchase from the same purse, money and income", () => {
    /** BruteSSH.exe $100,000 short, within a minute at $4,096 a second; home's 4 GB $1,120 short, within one at $512. */
    const near = { perSecond: 4_096, endMoney: 400_000 };
    const cheapHome = { endMoney: 100_000 };
    const states: [string, number, Options, { perSecond?: number; endMoney?: number | null }][] = [
      ["an empty cloud, every program, no home RAM to buy", 10e6, {}, {}],
      ["a program the money covers goes first", 10e6, { programs: ["BruteSSH.exe"] }, {}],
      ["the next program, far off, isn't held back", 1e6, { programs: PORT_OPENER_PROGRAMS.slice(0, 4) }, {}],
      ["money short of BruteSSH.exe, within a minute: held back", 0, { programs: [], noodlesRam: 32 }, near],
      ["home RAM to 4 GB short, within a minute: held back", 0, { programs: ["BruteSSH.exe"], homeRam: 2 }, cheapHome],
      ["home RAM the money covers, cheaper than the program", 1.2e6, { programs: ["BruteSSH.exe"], homeRam: 8 }, {}],
      ["a large world against a small income: no payback", 1e9, { noodlesRam: 2 ** 14 }, {}],
      ["only the least server the money covers: 8 GB", 0, {}, { endMoney: 450_000 }],
    ];
    for (const [label, money, options, earned] of states) {
      const run = earning(money, options, earned);
      const brains = (sentPurchases(run.connection) ?? []).filter((each) => PURCHASE_ACTIONS.includes(each.action));
      const perSecond = earned.perSecond ?? 512;
      const purse = {
        spent: 0,
        programs: 1 + (options.programs ?? PORT_OPENER_PROGRAMS).length,
        cloudServersRamGb: Object.values(options.cloud ?? {}),
        // No home in the snapshot: the brain buys none, as at the game's limit.
        homeRamGb: options.homeRam ?? HOME_RAM_LIMIT,
      };
      const cash = earned.endMoney ?? money + 10 * 60 * perSecond;
      // The brain measured `perSecond` over n00dles and the cloud servers alike, no purchase in the window (#294).
      const hostsGb = (options.noodlesRam ?? 4) + purse.cloudServersRamGb.reduce((sum, each) => sum + each, 0);
      const models = nextPurchase(purse, cash, { perSecond, perGbSecond: perSecond / hostsGb }, NO_HOLDS);
      expect(brains, label).toEqual(models === null ? [] : [brainIntentOf(models, purse)]);
      run.connection.dropFromGameSide();
    }
  });

  test("a cloud purchase not done, with a problem (not enough money, say), is no problem noted: it's tried again", () => {
    const { controller, connection } = earning(10e6);
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: "buyServer(pserv-0, 128)", done: false, tries: 1, problem: "not enough money", backend: "ui" }],
    });
    expect(controller.cloudServersView().problem).toBeNull();
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
  });

  test("the switch turned on again, without off, keeps a problem noted", () => {
    const { controller, connection } = earning(10e6);
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id: "buyServer(pserv-0, 128)", done: true, tries: 1, problem: "bought as pserv-0-0", backend: "ui" }],
    });
    controller.setCloudServersEnabled(true);
    expect(controller.cloudServersView().problem).toBe("buyServer(pserv-0, 128): bought as pserv-0-0");
  });

  test("a new connection forgets the purchase in flight: chosen afresh at the money then", () => {
    const { connection } = earning(10e6);
    expect(sentPurchases(connection)).toEqual([buyServer("pserv-0", 128)]);
    connection.dropFromGameSide();
    const again = connectAgent("session-2");
    send(again, "static", network, "session-2");
    send(again, "slow", slowData(), "session-2");
    for (let minute = 0; minute <= 10; minute++) {
      if (minute > 0) clock.advance(MINUTE);
      send(again, "medium", medium(100e6 + minute * 60 * 512), "session-2");
    }
    // $100.3m covers 1 TB ($56.3m), not 2 TB.
    expect(sentPurchases(again)).toEqual([buyServer("pserv-0", 1_024), TRAVEL_CHONGQING]);
  });

  test("the owner's cloud servers are never hosts, nor upgraded; they count toward the limit", () => {
    const owners = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`box-${index}`, 8]));
    const { controller, connection } = earning(10e6, { cloud: owners });
    expect(controller.hackLoopView().hosts).toEqual(["n00dles"]);
    expect(sentPurchases(connection)).toEqual([]);
    expect(controller.cloudServersView().waitingFor).toBe(
      "room: the game's limit of 25 cloud servers is reached with your own",
    );
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

describe("the travel for Tian Di Hui's invitation (#228)", () => {
  /** Hacking 100, TOR owned (BruteSSH.exe, $500k, next), home at its most RAM, in `city` with `money`. */
  const player = (city: string, money: number) =>
    mediumData(100, {}, { money, city, hasTorRouter: true, homeRam: 2 ** 20 });
  const connected = () => {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    const ids = () =>
      desiredStates(connection)
        .at(-1)
        ?.intents.map((each) => each.id) ?? [];
    return { controller, connection, ids };
  };

  test("asked for in Sector-12, last, as `travel`; in Ishima, $1m held from programs until the invitation shows", () => {
    const { controller, connection, ids } = connected();
    send(connection, "medium", player("Sector-12", 1_400_000));
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)", TRAVEL_ISHIMA.id]);
    expect(controller.intentsView().map(({ id, source }) => [id, source])).toEqual([
      ["buyProgram(BruteSSH.exe)", "purchase"],
      [TRAVEL_ISHIMA.id, "travel"],
    ]);
    // In Ishima: not asked again; BruteSSH.exe would leave $900k, under the $1m held.
    send(connection, "medium", player("Ishima", 1_400_000));
    expect(ids()).toEqual([]);
    expect(controller.programsView().waitingFor).toBe(
      "money above the $1,000,000 held for an invitation travelled for",
    );
    expect(controller.invitationsView()).toMatchObject({ travel: null, hold: 1e6 });
    send(connection, "medium", player("Ishima", 1_500_000));
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)"]);
    // Invited: the hold over, and A5 joins it.
    send(connection, "medium", player("Ishima", 1_400_000));
    send(connection, "slow", {
      ...slowData(),
      factions: {
        backend: "sim",
        state: { joined: [], invitations: ["Tian Di Hui"], queuedAugmentations: [] },
        problem: null,
      },
    });
    expect(controller.invitationsView().hold).toBe(0);
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)", "joinFaction(Tian Di Hui)"]);
  });

  test("not with the owner's work set, nor the Augmentations switch off, saying why", () => {
    const { controller, connection, ids } = connected();
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    send(connection, "medium", player("Sector-12", 1_400_000));
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)"]);
    expect(controller.invitationsView().waitingFor).toBe("your work on the dashboard (it may be in a city)");
    controller.setWork(null);
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)", TRAVEL_ISHIMA.id]);
    controller.setAugmentationsEnabled(false);
    expect(ids()).toEqual(["buyProgram(BruteSSH.exe)"]);
    expect(controller.invitationsView().waitingFor).toBe("the Augmentations switch, off");
  });
});

describe("the city group, the World Daemon's reach and the owner's joins (#228 review)", () => {
  const player = (money: number) =>
    mediumData(100, {}, { money, city: "Sector-12", hasTorRouter: true, homeRam: 2 ** 20 });
  const connected = () => {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", slowData());
    return { controller, connection };
  };

  test("the group chosen is the reach's in the World Daemon's line; the Factions view says the travel", () => {
    const { controller, connection } = connected();
    send(connection, "medium", player(1e9));
    send(connection, "medium", player(1e9));
    // A (7, as B, in fewer travels from Sector-12): its $15m held here for Sector-12's invitation.
    expect(controller.invitationsView().cityGroup).toMatch(/^group A /);
    expect(controller.worldDaemonView().lines[0]).toMatch(/Sector-12 \d+, Aevum \d+\)/);
    expect(controller.factionsView().invitations).toMatchObject({ travel: null, hold: 15e6, holdIn: "Sector-12" });
  });

  test("a city faction's join the owner queued fixes its group: Volhaven's, C", () => {
    const { controller, connection } = connected();
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Volhaven" } });
    send(connection, "medium", player(1e9));
    expect(controller.invitationsView().cityGroup).toMatch(/^group C \(Volhaven\)/);
  });
});

describe("Daedalus count stuck, judged on A6's commit's facts (#238)", () => {
  /** CyberSec's five and NeuroFlux Governor installed: 6 of 30. */
  const SIX = {
    ...Object.fromEntries(
      ["Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II", "BitWire"].map((name) => [name, 1]),
    ),
    "Synaptic Enhancement Implant": 1,
    "Neurotrainer I": 1,
    "NeuroFlux Governor": 1,
  };
  const slowAt = (lastAugReset: number, queued: string[]) => ({
    ...slowData(),
    resetInfo: { ...slowData().resetInfo, lastAugReset, ownedAugs: SIX },
    factions: {
      backend: "sim",
      state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: queued },
      problem: null,
    },
  });
  /**
   * A6's commit, the install asked for (or not), with `within` and $45m left after the set, or no facts (null); then
   * the reset.
   */
  const installFrom = (
    within: { augmentation: string; faction: string; money: number }[] | null,
    installing = true,
  ) => {
    store.setSetting("hackLoop.enabled", "false");
    const countFacts = within === null ? {} : { countFacts: { moneyAfterSet: 45e6, within } };
    store.setSetting("augmentations.cycle", JSON.stringify({ lastAugReset: 0, installing, ...countFacts }));
    const controller = new DesiredStateController({ channel, store });
    const stored: { type: string }[] = [];
    controller.subscribe((event) => isInvitationEvent(event) || stored.push(event));
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", mediumData(100, {}, { money: 0 }));
    send(connection, "slow", slowAt(0, Array(12).fill("NeuroFlux Governor")));
    expect(controller.worldDaemonStall()).toBeNull();
    send(connection, "slow", slowAt(60_000, []));
    return { controller, stored };
  };

  test("one that counts the money left after the set would have bought, passed over: stuck, naming it", () => {
    const { controller } = installFrom([{ augmentation: "Neurotrainer II", faction: "NiteSec", money: 45e6 }]);
    expect(controller.worldDaemonStall()).toMatchObject({
      step: "daedalusCount",
      detail: expect.stringContaining(
        "at 6 of 30 augmentations installed added none to the count (NeuroFlux Governor's",
      ),
    });
    expect(controller.worldDaemonStall()?.detail).toContain("passing over Neurotrainer II (NiteSec, $45,000,000)");
  });

  test("nothing that counts within reach: information, no stall", () => {
    const { controller, stored } = installFrom([]);
    expect(controller.worldDaemonStall()).toBeNull();
    expect(stored.filter((event) => event.type === "daedalusCountNeuroFluxOnly")).toMatchObject([
      {
        detail:
          "installed NeuroFlux Governor only at 6 of 30 augmentations installed: nothing that counts within reach",
      },
    ]);
  });

  test("A6's install asked for, its commit's facts lost (#238 review): stuck", () => {
    expect(installFrom(null).controller.worldDaemonStall()?.detail).toBe(
      "Daedalus count stuck: an install at 6 of 30 augmentations installed added none to the count (NeuroFlux " +
        "Governor's levels count once), A6's install, with no facts from its commit of what counts within reach",
    );
  });

  test("a commit with no facts, its install not asked for (yours, mid-commit): not judged", () => {
    const { controller, stored } = installFrom(null, false);
    expect(controller.worldDaemonStall()).toBeNull();
    expect(stored.filter((event) => event.type === "daedalusCountNeuroFluxOnly")).toMatchObject([
      {
        detail:
          "installed NeuroFlux Governor only at 6 of 30 augmentations installed: no facts from A6's commit (yours, " +
          "the switch off, or an earlier brain's), so not judged",
      },
    ]);
  });
});

describe("the brain's own irreversible intents go through the irreversible gate (#269)", () => {
  const JOIN_SECTOR_12 = intent({ action: "joinFaction", args: { faction: "Sector-12" } });
  const SAVED: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
  /** A player who can reach every city group (#228's): the city group A chosen (Sector-12, Aevum). */
  const player = (factions: string[] = []) =>
    mediumData(100, {}, { money: 1e9, city: "Sector-12", hasTorRouter: true, homeRam: 2 ** 20, factions });
  /** A slow snapshot with `invited` in the faction state. */
  const invitedTo = (invited: string[]) => {
    const data = slowData();
    data.factions = {
      backend: "sim",
      state: { joined: [], invitations: invited, queuedAugmentations: [] },
      problem: null,
    };
    return data;
  };
  /** The hack loop off and every rule on; save backups each answered when the test says. */
  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const pending: ((event: SaveBackupEvent) => void)[] = [];
    const backupNow = vi.fn(() => new Promise<SaveBackupEvent>((resolve) => pending.push(resolve)));
    const controller = new DesiredStateController({ channel, store, saveBackups: { backupNow } });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "slow", invitedTo(["Sector-12"]));
    const sentIds = () =>
      desiredStates(connection)
        .at(-1)
        ?.intents.map((each) => each.id) ?? [];
    const waitingFor = (id: string) => controller.intentsView().find((view) => view.id === id)?.waitingFor;
    const settleBackup = async (event: SaveBackupEvent) => {
      pending.shift()?.(event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { controller, connection, backupNow, sentIds, waitingFor, settleBackup };
  }

  /** The Agent reports `id` done in its fast snapshot. */
  const reportDone = (connection: MemoryConnection, id: string) =>
    send(connection, "fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [{ id, done: true, tries: 1, problem: null, backend: "sim" }],
    });
  /** The medium snapshots a new rule's gate needs: the first finds no gate (the rule's join comes with its update). */
  const mediumsForAGate = (connection: MemoryConnection, factions: string[] = []) => {
    for (let each = 0; each < 3; each += 1) send(connection, "medium", player(factions));
  };

  test("a city faction's join, Sector-12's (bans four): its guard on two medium snapshots, then a backup", async () => {
    const { controller, connection, backupNow, sentIds, waitingFor, settleBackup } = connected();
    send(connection, "medium", player());
    expect(controller.factionsView().joining).toBe("Sector-12");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)",
    );
    // A third medium snapshot in all: the gate came with the first one's update, and counts from the next (safe side).
    send(connection, "medium", player());
    send(connection, "medium", player());
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe("waiting for a save backup");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    await settleBackup(SAVED);
    expect(sentIds()).toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBeNull();
    // Out, its guard still judged: an enemy joined withdraws it.
    send(connection, "medium", player(["Chongqing"]));
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe("held: Sector-12's enemy Chongqing is joined");
  });

  test("#269's reproduction: the owner's install queued, the join waits for it, one irreversible at a time", async () => {
    const { controller, connection, sentIds, waitingFor, settleBackup } = connected();
    controller.addManualIntent({ action: "installAugmentations", args: {} });
    send(connection, "medium", player());
    send(connection, "medium", player());
    // Before #269: ["buyProgram(BruteSSH.exe)", "joinFaction(Sector-12)", "travel(Ishima)"], the join out at once.
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(controller.intentsView().find((view) => view.id === JOIN_SECTOR_12.id)?.source).toBe("join");
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for installAugmentations() first: one irreversible intent at a time",
    );
    // The install's backup lets the install out, alone.
    await settleBackup(SAVED);
    expect(sentIds()).toContain("installAugmentations()");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
  });

  test("out, then the owner queues an ally (Aevum, its group): withdrawn, never out with Aevum's", async () => {
    const { controller, connection, sentIds, waitingFor, settleBackup } = connected();
    mediumsForAGate(connection);
    await settleBackup(SAVED);
    expect(sentIds()).toContain(JOIN_SECTOR_12.id);
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Aevum" } });
    // No longer first, so no longer judged: back to counting, withdrawn.
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for joinFaction(Aevum) first: one irreversible intent at a time",
    );
    send(connection, "medium", player());
    send(connection, "medium", player());
    await settleBackup(SAVED);
    expect(sentIds()).toContain("joinFaction(Aevum)");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    // Aevum done: Sector-12 is first again, and goes out only past a new guard count and backup.
    reportDone(connection, "joinFaction(Aevum)");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far): " +
        "another irreversible intent was queued ahead of it",
    );
    send(connection, "medium", player(["Aevum"]));
    send(connection, "medium", player(["Aevum"]));
    await settleBackup(SAVED);
    expect(sentIds()).toContain(JOIN_SECTOR_12.id);
  });

  test("pushed back while its backup is taken: that backup's success releases nothing", async () => {
    const { controller, connection, backupNow, sentIds, waitingFor, settleBackup } = connected();
    mediumsForAGate(connection);
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe("waiting for a save backup");
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Aevum" } });
    await settleBackup(SAVED);
    // Not first, so not out on it: the backup was for a gate that has started again.
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(sentIds()).not.toContain("joinFaction(Aevum)");
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for joinFaction(Aevum) first: one irreversible intent at a time",
    );
  });

  test("pushed back after one medium snapshot held: first again, it counts two consecutive ones afresh", async () => {
    const { controller, connection, backupNow, sentIds, waitingFor, settleBackup } = connected();
    // The first finds no gate (the rule's join comes with its update); the second is held.
    send(connection, "medium", player());
    send(connection, "medium", player());
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for the guard to hold on 2 consecutive medium snapshots (1 so far)",
    );
    controller.addManualIntent({ action: "joinFaction", args: { faction: "Aevum" } });
    send(connection, "medium", player());
    send(connection, "medium", player());
    await settleBackup(SAVED);
    expect(sentIds()).toContain("joinFaction(Aevum)");
    reportDone(connection, "joinFaction(Aevum)");
    // One medium snapshot since: not the two consecutive ones R8 asks for, so no backup yet.
    send(connection, "medium", player(["Aevum"]));
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for the guard to hold on 2 consecutive medium snapshots (1 so far): " +
        "another irreversible intent was queued ahead of it",
    );
    send(connection, "medium", player(["Aevum"]));
    expect(backupNow).toHaveBeenCalledTimes(2);
  });

  test("out, then the owner queues an install and cancels it: out again only past a new backup", async () => {
    const { controller, connection, backupNow, sentIds, waitingFor, settleBackup } = connected();
    mediumsForAGate(connection);
    await settleBackup(SAVED);
    expect(sentIds()).toContain(JOIN_SECTOR_12.id);
    controller.addManualIntent({ action: "installAugmentations", args: {} });
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(waitingFor(JOIN_SECTOR_12.id)).toBe(
      "waiting for installAugmentations() first: one irreversible intent at a time",
    );
    controller.cancelManualIntent("installAugmentations()");
    // Not on its old release: its guard and a backup again.
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    send(connection, "medium", player());
    send(connection, "medium", player());
    expect(backupNow).toHaveBeenCalledTimes(2);
    await settleBackup(SAVED);
    expect(sentIds()).toContain(JOIN_SECTOR_12.id);
  });

  test("a city join at the gate holds up no invitation that bans nothing: CyberSec's goes beside it", async () => {
    const { controller, connection, sentIds, waitingFor, settleBackup } = connected();
    send(connection, "slow", invitedTo(["Sector-12", "CyberSec", "NiteSec"]));
    send(connection, "medium", player());
    expect(sentIds()).toContain("joinFaction(CyberSec)");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(controller.factionsView()).toMatchObject({ joining: "Sector-12", joiningAlongside: "CyberSec" });
    expect(waitingFor("joinFaction(CyberSec)")).toBeNull();
    // Backups failing hold Sector-12, not the rest: CyberSec joined, NiteSec next.
    send(connection, "medium", player());
    send(connection, "medium", player());
    await settleBackup({ type: "saveBackup", atMs: 1, failure: "no Remote File API connection" });
    send(connection, "medium", player(["CyberSec"]));
    expect(sentIds()).toContain("joinFaction(NiteSec)");
    expect(sentIds()).not.toContain(JOIN_SECTOR_12.id);
    expect(controller.factionsView()).toMatchObject({ joining: "Sector-12", joiningAlongside: "NiteSec" });
  });

  test("reversible ones the rules make go at once, as before: CyberSec's join (no enemies), the purchase", () => {
    const { connection, sentIds, controller } = connected();
    send(connection, "slow", invitedTo(["CyberSec"]));
    send(connection, "medium", player());
    expect(sentIds()).toEqual(expect.arrayContaining(["joinFaction(CyberSec)", "buyProgram(BruteSSH.exe)"]));
    // Nothing beside a join that's reversible itself.
    expect(controller.factionsView()).toMatchObject({ joining: "CyberSec", joiningAlongside: null });
  });
});

describe("what the brain takes as BN1's (#321): logged once per BitNode, from the slow snapshot", () => {
  test("none in BN1, BN2, BN4 or BN5 (core has both's); another BitNode's on its first slow snapshot, once", () => {
    const lines: string[] = [];
    new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
    const connection = connectAgent();
    const taken = () => lines.filter((line) => line.includes("taken as BN1's"));
    send(connection, "slow", slowData(1));
    send(connection, "slow", slowData(4));
    send(connection, "slow", slowData(2));
    expect(taken()).toEqual([]);
    send(connection, "slow", slowData(3));
    send(connection, "slow", slowData(3));
    expect(bitNodeAssumptions(3)).toHaveLength(1);
    expect(taken()).toEqual([`in BitNode 3, taken as BN1's: ${bitNodeAssumptions(3)[0]}`]);
  });
});

describe("BN2 before the gang (#357's (1)): the controller hands A6 avmnite-02h's level", () => {
  /** SF1.3's ×1.28 at BN2's `HackingLevelMultiplier` 0.8. */
  const LEVEL_MULT = 1.28 * 0.8;
  /** A tenth of #363's seed 1's mean rate from 201 to 212: the level stays 216 for the 11 minutes. */
  const RATE = (hackingExpOfLevel(212, LEVEL_MULT) - hackingExpOfLevel(201, LEVEL_MULT)) / (24 * 60 + 31) / 10;
  const bn2Network: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0 }),
      staticServer("n00dles"),
      staticServer("avmnite-02h", { requiredHackingSkill: 217, numOpenPortsRequired: 2 }),
    ],
  };
  /** BN2 with no gang: CyberSec joined at the reputation for its five, nothing earned (the income measured at 0). */
  const bn2Slow = {
    ...slowData(2),
    moneySources: { hacking: 0 },
    factions: {
      backend: "sim",
      state: { joined: [{ name: "CyberSec", reputation: 18_750, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  };
  /** Hacking 216 of avmnite-02h's 217, `seconds` of experience at the rate on; the money for CyberSec's two cheapest. */
  /** The gang worker's reading: none formed, unless given (`absent` leaves it out). */
  const NO_GANG = { gang: null, members: [], problems: [] };
  const bn2Medium = (seconds: number, gang: unknown = NO_GANG) => ({
    ...mediumData(216, { home: true }, { money: 40e6, homeRam: 2 ** 20, hasTorRouter: true, factions: ["CyberSec"] }),
    player: {
      skills: { hacking: 216, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      exp: { hacking: hackingExpOfLevel(216, LEVEL_MULT) + RATE * seconds },
      mults: { faction_rep: 1, hacking: 1.28 },
      money: 40e6,
      city: "Volhaven",
      factions: ["CyberSec"],
    },
    ...(gang === "absent" ? {} : { gang }),
  });
  /** A brain, its BN2 route `bn2Route`, with the hack loop off, an Agent connected and its static snapshot sent. */
  function bn2Brain(
    bn2Route: "planner" | "rules",
    { gang = NO_GANG as unknown, slow = bn2Slow as unknown }: { gang?: unknown; slow?: unknown } = {},
  ) {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store, installTiming: "planner", bn2Route });
    // The owner's travel queued, so #228's travel for a city group's invitations stands, and holds no money (it would
    // hold #343's installing now).
    controller.addManualIntent({ action: "travel", args: { city: "Volhaven" } });
    const connection = connectAgent();
    send(connection, "static", bn2Network);
    let gameTimeMs = 10 * 3_600_000;
    /** `minutes` of snapshots: a slow one a minute, a medium one every 10 s (the gang read none). */
    const run = (minutes: number, mediumFrom = 0) => {
      for (let second = 0; second < minutes * 60; second += 10) {
        gameTimeMs += 10_000;
        const tiers: [SnapshotTier, unknown][] = [
          ...(second % 60 === 0 ? ([["slow", slow]] as [SnapshotTier, unknown][]) : []),
          ...(second >= mediumFrom ? ([["medium", bn2Medium(second, gang)]] as [SnapshotTier, unknown][]) : []),
        ];
        for (const [tier, data] of tiers) {
          connection.receive(
            encodeControlMessage({
              protocolVersion: CONTROL_PROTOCOL_VERSION,
              type: "snapshot",
              agentSessionId: "session-1",
              tier,
              sequenceNumber: ++sequenceNumber,
              gameTimeMs,
              data,
            }),
          );
        }
      }
    };
    const sent = () =>
      (desiredStates(connection).at(-1)?.intents ?? []).filter(
        (each) => each.action === "purchaseAugmentation" || each.action === "installAugmentations",
      );
    return { controller, run, sent };
  }

  test("216 of 217 with CyberSec's two affordable: the planner waits for the gang, no install; the rules install", () => {
    const planner = bn2Brain("planner");
    planner.run(11);
    expect(planner.controller.gangView().stage).toBe("noFaction");
    expect(planner.controller.augmentationsView().progress?.timing).toMatchObject({
      route: "gang forming",
      choice: 1,
      gang: { required: 217, level: 216, choice: "wait", heldForRate: false },
    });
    expect(planner.controller.augmentationsView().committed).toBe(false);
    expect(planner.sent()).toEqual([]);
    expect(readInstallWait(store)?.route).toBe("gang forming");

    // The A/B's baseline, on a fresh store: #343's install now, nothing to come at the income.
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "desired-state-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const rules = bn2Brain("rules");
    rules.run(11);
    expect(rules.controller.augmentationsView().progress?.timing?.route).toBeUndefined();
    expect(rules.controller.augmentationsView().committed).toBe(true);
    expect(rules.sent()).toEqual([expect.objectContaining({ action: "purchaseAugmentation" })]);
  });

  test("an unmeasured rate holds: the medium snapshots only in the last 50 s, installing now held, no install", () => {
    const { controller, run, sent } = bn2Brain("planner");
    run(11, 11 * 60 - 50);
    expect(controller.augmentationsView().progress?.timing?.gang).toMatchObject({
      heldForRate: true,
      waitMs: null,
      choice: "wait",
    });
    expect(controller.augmentationsView().committed).toBe(false);
    expect(sent()).toEqual([]);
  });

  /** The gang's NiteSec, formed, no members yet: managed. */
  const NITESEC_GANG = {
    gang: {
      faction: "NiteSec",
      isHacking: true,
      respect: 1,
      wantedLevel: 1,
      wantedPenalty: 0.5,
      territory: 1 / 7,
      respectGainRate: 0,
      moneyGainRate: 0,
      wantedLevelGainRate: 0,
      power: 1,
    },
    members: [],
    problems: [],
  };

  test.each([
    ["absent (no reading in the medium snapshot)", "absent"],
    ["unread (the reading isn't one)", { gang: "a string" }],
    ["the worker's problems", { gang: null, members: [], problems: ["ns.gang.getGangInformation threw"] }],
  ])(
    "the gang %s, none known (#368's review): the gang's route, installing now held; the rules would install",
    (_, gang) => {
      const planner = bn2Brain("planner", { gang });
      planner.run(11);
      expect(planner.controller.gangView().stage).toBe("waiting");
      expect(planner.controller.augmentationsView().progress?.timing).toMatchObject({
        route: "gang forming",
        gang: { heldForGangUnread: true, choice: "wait" },
      });
      expect(planner.controller.augmentationsView().committed).toBe(false);
      expect(planner.sent()).toEqual([]);
    },
  );

  test("after a restart, the gang not read yet (#368's review): held too", () => {
    const first = bn2Brain("planner");
    first.run(2);
    expect(first.controller.gangView().stage).toBe("noFaction");
    // A new brain on the same store, its Agent's readings without the gang's for now.
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const restarted = bn2Brain("planner", { gang: "absent" });
    restarted.run(11);
    expect(restarted.controller.augmentationsView().progress?.timing?.gang?.heldForGangUnread).toBe(true);
    expect(restarted.sent()).toEqual([]);
  });

  test("formed, its faction in no slow snapshot yet (#363's seed 5): the gang's route, not #343's; the shop shown, #343's ends", () => {
    const planner = bn2Brain("planner", { gang: NITESEC_GANG });
    planner.run(11);
    expect(planner.controller.gangView().stage).toBe("managed");
    expect(planner.controller.augmentationsView().progress?.timing?.route).toBe("gang forming");
    expect(planner.sent()).toEqual([]);
    // The slow snapshot shows NiteSec, the gang's faction: never short of Daedalus's count, so not #343's nor (1). With
    // no members the gang earns no respect, so not (3) either (#357's second slice): the rules', as before.
    const state = bn2Slow.factions.state;
    const shown = {
      ...bn2Slow,
      factions: {
        ...bn2Slow.factions,
        state: { ...state, joined: [...state.joined, { name: "NiteSec", reputation: 0, favor: 0 }] },
      },
    };
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const after = bn2Brain("planner", { gang: NITESEC_GANG, slow: shown });
    after.run(2);
    expect(after.controller.augmentationsView().progress?.timing ?? null).toBeNull();
  });

  test("the time to the destroy (#357's slice 3), each moment once across restarts: the start at τ_g, the gang formed, The Red Pill's install", () => {
    const START = 10 * 3_600_000;
    let gameTimeMs = START;
    const estimates: DestroyEstimateEvent[] = [];
    /** BN2 from `START`, the cycle from `lastAugReset` with `ownedAugs`: CyberSec joined, as `bn2Slow`. */
    const slowAt = (lastAugReset = START, ownedAugs: Record<string, number> = {}) => ({
      ...bn2Slow,
      resetInfo: { ...bn2Slow.resetInfo, lastNodeReset: START, lastAugReset, ownedAugs },
    });
    /** A brain (a restart each), its estimates kept; then `minutes` of snapshots, the experience at the rate on. */
    const brainOf = () => {
      store.setSetting("hackLoop.enabled", "false");
      channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
      channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
      const controller = new DesiredStateController({ channel, store, installTiming: "planner", bn2Route: "planner" });
      controller.subscribe((event) => {
        if (event.type === DESTROY_ESTIMATED_EVENT_KIND) estimates.push(event as DestroyEstimateEvent);
      });
      const connection = connectAgent();
      send(connection, "static", bn2Network);
      const run = (minutes: number, slow: unknown, gang: unknown = NO_GANG) => {
        for (let second = 0; second < minutes * 60; second += 10) {
          gameTimeMs += 10_000;
          const tiers: [SnapshotTier, unknown][] = [
            ...(second % 60 === 0 ? ([["slow", slow]] as [SnapshotTier, unknown][]) : []),
            ["medium", bn2Medium((gameTimeMs - START) / 1000, gang)],
          ];
          for (const [tier, data] of tiers) {
            connection.receive(
              encodeControlMessage({
                protocolVersion: CONTROL_PROTOCOL_VERSION,
                type: "snapshot",
                agentSessionId: "session-1",
                tier,
                sequenceNumber: ++sequenceNumber,
                gameTimeMs,
                data,
              }),
            );
          }
        }
      };
      return { controller, run };
    };
    const moments = () => estimates.map((each) => each.moment);
    const termsOf = (event: DestroyEstimateEvent | undefined) =>
      event?.terms.map((term) => [term.term, term.ms === null ? null : Math.round(term.ms / 1000), term.label]);

    // The start: it waits for τ_g, measured over the experience rate's whole window (#378's review); then A is A6's τ_g,
    // BC and D none, at least.
    const first = brainOf();
    first.run(12, slowAt());
    expect(moments()).toEqual(["start"]);
    const waitMs = first.controller.augmentationsView().progress?.timing?.gang?.waitMs as number;
    expect(waitMs).toBeGreaterThan(70_000);
    expect(estimates[0]).toMatchObject({ stage: "start", late: false, bitNode: "BN2.1", requiredLevel: 15_000 });
    expect(estimates[0]?.onlineMs).toBe(10 * 60_000);
    expect(termsOf(estimates[0])).toEqual([
      ["A", expect.any(Number), "cautious"],
      ["BC", null, "optimistic"],
      ["D", null, "optimistic"],
    ]);
    // A6's τ_g then: the rate the same, the level short by the same less a minute's experience.
    expect(Math.abs((estimates[0]?.terms[0]?.ms as number) - waitMs)).toBeLessThanOrEqual(3 * 60_000);
    expect(estimates[0]?.atLeast).toBe(true);

    // A restart: no second start.
    const second = brainOf();
    second.run(2, slowAt());
    expect(moments()).toEqual(["start"]);

    // The gang formed (its faction in no slow snapshot yet): at once, A done.
    second.run(2, slowAt(), NITESEC_GANG);
    expect(second.controller.gangView().stage).toBe("managed");
    expect(moments()).toEqual(["start", "gang formed"]);
    expect(termsOf(estimates[1])).toEqual([
      ["A", 0, "done"],
      ["BC", null, "optimistic"],
      ["D", null, "optimistic"],
    ]);

    // A restart: the gang read formed again, no second moment.
    const third = brainOf();
    third.run(2, slowAt(), NITESEC_GANG);
    expect(moments()).toEqual(["start", "gang formed"]);

    // The Red Pill installed (its install made): at once, A and BC done, D none at 15,000 (no BN2 prior): at least.
    const installedAt = gameTimeMs;
    third.run(2, slowAt(installedAt, { "The Red Pill": 1 }), NITESEC_GANG);
    expect(moments()).toEqual(["start", "gang formed", "install"]);
    expect(estimates[2]).toMatchObject({ stage: "The Red Pill installed", atLeast: true, lastAugReset: installedAt });
    expect(termsOf(estimates[2])).toEqual([
      ["A", 0, "done"],
      ["BC", 0, "done"],
      ["D", null, "optimistic"],
    ]);
    const fourth = brainOf();
    fourth.run(2, slowAt(installedAt, { "The Red Pill": 1 }), NITESEC_GANG);
    expect(moments()).toEqual(["start", "gang formed", "install"]);
  });

  test("the time to the destroy (#378's review): an install's first slow snapshot before any medium one, A6's view the last cycle's, isn't taken", () => {
    const START = 10 * 3_600_000;
    let gameTimeMs = START;
    const estimates: DestroyEstimateEvent[] = [];
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({ channel, store, installTiming: "planner", bn2Route: "planner" });
    controller.subscribe((event) => {
      if (event.type === DESTROY_ESTIMATED_EVENT_KIND) estimates.push(event as DestroyEstimateEvent);
    });
    const slowAt = (lastAugReset: number, ownedAugs: Record<string, number> = {}) => ({
      ...bn2Slow,
      resetInfo: { ...bn2Slow.resetInfo, lastNodeReset: START, lastAugReset, ownedAugs },
    });
    const snapshot = (connection: MemoryConnection, session: string, tier: SnapshotTier, data: unknown) =>
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
    // The start, at τ_g over the rate's window.
    const first = connectAgent();
    snapshot(first, "session-1", "static", bn2Network);
    for (let second = 0; second < 12 * 60; second += 10) {
      gameTimeMs += 10_000;
      if (second % 60 === 0) snapshot(first, "session-1", "slow", slowAt(START));
      snapshot(first, "session-1", "medium", bn2Medium((gameTimeMs - START) / 1000));
    }
    expect(estimates.map((each) => each.moment)).toEqual(["start"]);
    // An install, the Agent's next session: its first slow snapshot before any medium one. A6 returns early, its view
    // the last cycle's (τ_g measured then); the install waits for this cycle's figure.
    const installedAt = gameTimeMs;
    const next = connectAgent("session-2");
    snapshot(next, "session-2", "static", bn2Network);
    gameTimeMs += 10_000;
    snapshot(next, "session-2", "slow", slowAt(installedAt, { BitWire: 1 }));
    expect(controller.augmentationsView().progress).toMatchObject({
      lastAugReset: START,
      timing: { route: "gang forming" },
    });
    expect(controller.augmentationsView().progress?.timing?.gang?.waitMs).toEqual(expect.any(Number));
    expect(estimates.map((each) => each.moment)).toEqual(["start"]);
  });
});
