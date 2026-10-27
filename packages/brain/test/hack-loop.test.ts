// The brain's side of the hack loop (#134): the starter target rule, the dashboard's switch, and the controller that
// turns snapshots and the switch into the desired state the channel sends.
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
import { chooseHackTarget, HackLoopController, readHackLoopEnabled } from "../src/hack-loop.ts";
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

describe("the switch", () => {
  test("on until the owner turns it off, kept in the store", () => {
    const channel = new ControlChannel({ token: "t", clock: new ManualClock() });
    expect(readHackLoopEnabled(store)).toBe(true);
    new HackLoopController({ channel, store }).setEnabled(false);
    expect(readHackLoopEnabled(store)).toBe(false);
  });

  test("a value it didn't write fails, rather than guess", () => {
    store.setSetting("hackLoop.enabled", "maybe");
    expect(() => readHackLoopEnabled(store)).toThrow(/hackLoop\.enabled/);
  });
});

describe("the controller", () => {
  const TOKEN = "the-token";
  let channel: ControlChannel;
  let connection: MemoryConnection;
  let sequenceNumber = 0;

  const send = (tier: SnapshotTier, data: unknown) =>
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "snapshot",
        agentSessionId: "session-1",
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs: 1_000,
        data,
      }),
    );
  const desiredStates = () =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .map((message) => message.hackLoop);

  beforeEach(() => {
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    connection = new MemoryConnection();
    channel.accept(connection);
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "hello",
        token: TOKEN,
        deploymentId: "deployment-a",
        agentSessionId: "session-1",
        game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
      }),
    );
  });

  test("on at once with no target, so servers get rooted; then the target once snapshots show one", () => {
    new HackLoopController({ channel, store });
    expect(desiredStates()).toEqual([{ enabled: true, target: null }]);
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    send("medium", mediumData(1, { home: true, n00dles: false }));
    expect(desiredStates()).toEqual([{ enabled: true, target: null }]);
    send("medium", mediumData(1, { home: true, n00dles: true }));
    expect(desiredStates()).toEqual([
      { enabled: true, target: null },
      { enabled: true, target: "n00dles" },
    ]);
  });

  test("the switch: off sends off at once, and on again picks the target back up", () => {
    const controller = new HackLoopController({ channel, store });
    send("static", { servers: [staticServer("n00dles")] });
    send("medium", mediumData(1, { n00dles: true }));
    controller.setEnabled(false);
    controller.setEnabled(true);
    expect(desiredStates()).toEqual([
      { enabled: true, target: null },
      { enabled: true, target: "n00dles" },
      { enabled: false, target: null },
      { enabled: true, target: "n00dles" },
    ]);
  });

  test("off in the store when the brain starts: off from the start", () => {
    store.setSetting("hackLoop.enabled", "false");
    new HackLoopController({ channel, store });
    send("static", { servers: [staticServer("n00dles")] });
    send("medium", mediumData(1, { n00dles: true }));
    expect(desiredStates()).toEqual([{ enabled: false, target: null }]);
  });

  test("fast snapshots don't change anything", () => {
    new HackLoopController({ channel, store });
    send("fast", { degradedTiers: [], pageHeapUsedBytes: null, game: null });
    expect(desiredStates()).toEqual([{ enabled: true, target: null }]);
  });
});
