// The brain's side of the hack loop (#134): the starter rules (target and hosts), the dashboard's switch, and the
// controller that turns the connected Agent's snapshots and the switch into the desired state the channel sends.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type MediumSnapshotData,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chooseHackHosts, chooseHackTarget, HackLoopController, readHackLoopEnabled } from "../src/hack-loop.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

type StaticServer = StaticSnapshotData["servers"][number];
type MediumServer = MediumSnapshotData["servers"][number];

const staticServer = (hostname: string, changes: Partial<StaticServer> = {}): StaticServer => ({
  hostname,
  purchasedByPlayer: false,
  moneyMax: 1_000_000,
  minDifficulty: 1,
  requiredHackingSkill: 1,
  numOpenPortsRequired: 0,
  serverGrowth: 10,
  ...changes,
});
const mediumServer = (hostname: string, hasAdminRights: boolean): MediumServer => ({
  hostname,
  maxRam: 16,
  cpuCores: 1,
  hasAdminRights,
  backdoorInstalled: false,
  moneyAvailable: 0,
  hackDifficulty: 1,
});
const mediumData = (hacking: number, rooted: Record<string, boolean>): MediumSnapshotData => ({
  player: { skills: { hacking } },
  servers: Object.entries(rooted).map(([hostname, hasAdminRights]) => mediumServer(hostname, hasAdminRights)),
});

describe("chooseHackTarget: a starter rule until the planner (M4)", () => {
  // The game's own figures for these servers (moneyMax, serverGrowth).
  const network: StaticSnapshotData = {
    servers: [
      staticServer("home", { moneyMax: 0, numOpenPortsRequired: 5, serverGrowth: 1 }),
      staticServer("n00dles", { moneyMax: 1_750_000, serverGrowth: 3_000 }),
      staticServer("foodnstuff", { moneyMax: 50_000_000, serverGrowth: 5 }),
      staticServer("joesguns", { moneyMax: 62_500_000, serverGrowth: 20, requiredHackingSkill: 10 }),
      staticServer("big-and-slow", { moneyMax: 2_000_000_000, serverGrowth: 50, requiredHackingSkill: 20 }),
      staticServer("bought-1", { purchasedByPlayer: true, moneyMax: 0 }),
    ],
  };
  const allRooted = {
    home: true,
    n00dles: true,
    foodnstuff: true,
    joesguns: true,
    "big-and-slow": true,
    "bought-1": true,
  };

  test("the highest money times growth among rooted servers needing at most half the hacking level", () => {
    // n00dles (5.25e9) over foodnstuff (2.5e8) and joesguns (1.25e9): the one that grows back fast.
    expect(chooseHackTarget(network, mediumData(1, allRooted))).toBe("n00dles");
    expect(chooseHackTarget(network, mediumData(39, allRooted))).toBe("n00dles");
    // 1e11 once its level is in reach.
    expect(chooseHackTarget(network, mediumData(40, allRooted))).toBe("big-and-slow");
  });

  test("only rooted servers, never home or a purchased one", () => {
    // Level 20 reaches joesguns (needs 10), not big-and-slow (needs 20).
    expect(chooseHackTarget(network, mediumData(20, { ...allRooted, n00dles: false }))).toBe("joesguns");
    expect(chooseHackTarget(network, mediumData(19, { ...allRooted, n00dles: false }))).toBe("foodnstuff");
    expect(chooseHackTarget(network, mediumData(100, { home: true, "bought-1": true }))).toBeNull();
  });

  test("a server without money or growth isn't one", () => {
    const barren: StaticSnapshotData = {
      servers: [staticServer("no-money", { moneyMax: 0 }), staticServer("no-growth", { serverGrowth: undefined })],
    };
    expect(chooseHackTarget(barren, mediumData(1, { "no-money": true, "no-growth": true }))).toBeNull();
  });

  test("ties go to the first hostname, so the choice doesn't flap", () => {
    const twins: StaticSnapshotData = { servers: [staticServer("zeta"), staticServer("alpha")] };
    expect(chooseHackTarget(twins, mediumData(1, { zeta: true, alpha: true }))).toBe("alpha");
  });

  test("nothing to go on: no target", () => {
    expect(chooseHackTarget(null, mediumData(1, allRooted))).toBeNull();
    expect(chooseHackTarget(network, null)).toBeNull();
  });
});

describe("chooseHackHosts: where the loop runs", () => {
  test("the game's rooted servers with RAM, sorted: never home, nor the player's purchased or Hacknet servers", () => {
    const network: StaticSnapshotData = {
      servers: [
        staticServer("home", { moneyMax: 0 }),
        staticServer("n00dles"),
        staticServer("foodnstuff"),
        staticServer("not-rooted"),
        staticServer("no-ram"),
        staticServer("bought-1", { purchasedByPlayer: true, moneyMax: 0 }),
        staticServer("hacknet-server-0", { purchasedByPlayer: true }),
      ],
    };
    const medium = mediumData(1, {
      home: true,
      n00dles: true,
      foodnstuff: true,
      "not-rooted": false,
      "no-ram": true,
      "bought-1": true,
      "hacknet-server-0": true,
    });
    for (const server of medium.servers) if (server.hostname === "no-ram") server.maxRam = 0;
    expect(chooseHackHosts(network, medium)).toEqual(["foodnstuff", "n00dles"]);
  });

  test("only names the protocol takes, and at most its limit", () => {
    const odd: StaticSnapshotData = {
      servers: [staticServer(""), staticServer("x".repeat(257)), staticServer("n00dles")],
    };
    expect(chooseHackHosts(odd, mediumData(1, { "": true, ["x".repeat(257)]: true, n00dles: true }))).toEqual([
      "n00dles",
    ]);
    const hostnames = Array.from({ length: 1_005 }, (_, index) => `server-${String(index).padStart(4, "0")}`);
    const many: StaticSnapshotData = { servers: hostnames.map((hostname) => staticServer(hostname)) };
    const allRooted = Object.fromEntries(hostnames.map((hostname) => [hostname, true]));
    expect(chooseHackHosts(many, mediumData(1, allRooted))).toHaveLength(1_000);
  });

  test("nothing to go on: none", () => {
    expect(chooseHackHosts(null, mediumData(1, { n00dles: true }))).toEqual([]);
    expect(chooseHackHosts({ servers: [staticServer("n00dles")] }, null)).toEqual([]);
  });
});

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "hack-loop-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("the switch: a value it didn't write fails, rather than guess", () => {
  store.setSetting("hackLoop.enabled", "maybe");
  expect(() => readHackLoopEnabled(store)).toThrow(/hackLoop\.enabled/);
});

describe("the controller", () => {
  const TOKEN = "the-token";
  let channel: ControlChannel;
  let sequenceNumber = 0;

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
      .map((message) => message.hackLoop);
  const network: StaticSnapshotData = { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] };
  const on = { enabled: true, target: "n00dles", hosts: ["n00dles"] };
  const off = { enabled: false, target: null, hosts: [] };

  beforeEach(() => {
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });

  test("on: nothing until the connected Agent's own static and medium snapshots, then the target and hosts", () => {
    const controller = new HackLoopController({ channel, store });
    const connection = connectAgent();
    expect(controller.view()).toEqual({ enabled: true, waiting: true, target: null, hosts: [] });
    send(connection, "static", network);
    expect(desiredStates(connection)).toEqual([]);
    // Nothing rooted yet: on, with no target, so the Agent roots what it can.
    send(connection, "medium", mediumData(1, { home: true, n00dles: false }));
    send(connection, "medium", mediumData(1, { home: true, n00dles: true }));
    expect(desiredStates(connection)).toEqual([{ enabled: true, target: null, hosts: [] }, on]);
    expect(controller.view()).toEqual({ enabled: true, waiting: false, target: "n00dles", hosts: ["n00dles"] });
  });

  test("an Agent that connects again is sent nothing until its own snapshots, then the same state", () => {
    new HackLoopController({ channel, store });
    const first = connectAgent();
    send(first, "static", network);
    send(first, "medium", mediumData(1, { n00dles: true }));
    const again = connectAgent();
    expect(desiredStates(again)).toEqual([]);
    send(again, "static", network);
    send(again, "medium", mediumData(1, { n00dles: true }));
    expect(desiredStates(again)).toEqual([on]);
  });

  test("an Agent after a reset is never sent the last game's target", () => {
    new HackLoopController({ channel, store });
    const before = connectAgent();
    send(before, "static", network);
    send(before, "medium", mediumData(1, { n00dles: true }));
    // Augmentations installed: a new Agent, nothing rooted any more.
    const afterReset = connectAgent("session-2");
    send(afterReset, "static", network, "session-2");
    send(afterReset, "medium", mediumData(1, { n00dles: false }), "session-2");
    expect(desiredStates(afterReset)).toEqual([{ enabled: true, target: null, hosts: [] }]);
  });

  test("the switch: off is sent at once, kept in the store; on again sends the target back", () => {
    const controller = new HackLoopController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", mediumData(1, { n00dles: true }));
    controller.setEnabled(false);
    expect(readHackLoopEnabled(store)).toBe(false);
    expect(controller.view()).toEqual({ enabled: false, waiting: false, target: null, hosts: [] });
    controller.setEnabled(true);
    expect(desiredStates(connection)).toEqual([on, off, on]);
  });

  test("off in the store when the brain starts: off to each Agent as it connects, before any snapshot", () => {
    store.setSetting("hackLoop.enabled", "false");
    new HackLoopController({ channel, store });
    const connection = connectAgent();
    expect(desiredStates(connection)).toEqual([off]);
  });

  test("a disconnect forgets the Agent's snapshots: the view shows on, waiting", () => {
    const controller = new HackLoopController({ channel, store });
    const connection = connectAgent();
    send(connection, "static", network);
    send(connection, "medium", mediumData(1, { n00dles: true }));
    connection.dropFromGameSide();
    expect(controller.view()).toEqual({ enabled: true, waiting: true, target: null, hosts: [] });
  });

  test("fast snapshots change nothing", () => {
    new HackLoopController({ channel, store });
    const connection = connectAgent();
    send(connection, "fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null });
    expect(desiredStates(connection)).toEqual([]);
  });
});
