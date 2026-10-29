// The brain's side of the batcher (#205): its switch, its fixed plan on the hack loop's target and hosts, where it
// runs, what the controller sends with it on, the dashboard's view, and the run report's section.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  BATCHER_RAM_BUDGET_GB,
  batchPlan,
  batchRamGb,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  newBatcherHealth,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BATCHER_ENABLED_SETTING,
  batcherViewOf,
  HOME_KEPT_FOR_THE_AGENT_GB,
  planBatcher,
  readBatcherEnabled,
} from "../src/batcher.ts";
import { batcherSection } from "../src/batcher-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
const network: StaticSnapshotData = {
  servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles", N00DLES), staticServer("foodnstuff")],
};
/** A medium snapshot with the player's hacking figures, as the real worker sends them (`ns.getPlayer()`). */
function medium(hacking: number, rooted: Record<string, boolean>, homeRam = 8): MediumSnapshotData {
  const data = mediumData(hacking, rooted, { homeRam });
  return { ...data, player: { ...data.player, skills: { hacking, intelligence: 0 }, mults: MULTS } };
}

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "batcher-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the switch", () => {
  test("off unless the owner turned it on", () => {
    expect(readBatcherEnabled(store)).toBe(false);
    store.setSetting(BATCHER_ENABLED_SETTING, "true");
    expect(readBatcherEnabled(store)).toBe(true);
  });
});

describe("planBatcher", () => {
  test("on an 8 GB home: on the largest host, whose RAM the plan counts less the batcher's; core's plan, its config", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true });
    data.servers = data.servers.map((server) => (server.hostname === "n00dles" ? { ...server, maxRam: 4 } : server));
    const planned = planBatcher(network, data, "n00dles", ["n00dles", "foodnstuff"]);
    const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
    const plan = batchPlan(N00DLES, player, batchRamGb([4, 16 - BATCHER_RAM_BUDGET_GB]));
    expect(planned).toEqual({
      batcher: {
        runOn: "foodnstuff",
        config: {
          target: "n00dles",
          figures: N00DLES,
          player: { intelligence: 0, mults: MULTS },
          hosts: ["n00dles", "foodnstuff"],
          hackShare: plan?.hackShare,
          spacingMs: plan?.spacingMs,
        },
      },
    });
  });

  test("on home once home has its budget beyond what it keeps for the Agent: 16 GB", () => {
    const at = (homeRam: number) =>
      planBatcher(network, medium(50, { n00dles: true, foodnstuff: true }, homeRam), "n00dles", ["foodnstuff"]);
    expect(HOME_KEPT_FOR_THE_AGENT_GB + BATCHER_RAM_BUDGET_GB).toBeLessThanOrEqual(16);
    expect(at(16).batcher?.runOn).toBe("home");
    expect(at(8).batcher?.runOn).toBe("foodnstuff");
  });

  test("none, and why: no hacking figures, no target figures, no host with RAM, or none that holds it", () => {
    const why = (planned: ReturnType<typeof planBatcher>) => (planned.batcher === null ? planned.why : null);
    expect(why(planBatcher(network, mediumData(50, { n00dles: true }), "n00dles", ["n00dles"]))).toContain(
      "hacking figures",
    );
    expect(why(planBatcher(network, medium(50, { n00dles: true }), "zer0", ["n00dles"]))).toContain("zer0");
    expect(why(planBatcher(network, medium(50, { n00dles: true }), "n00dles", ["nowhere"]))).toBe("no host with RAM");
    const small = medium(50, { n00dles: true });
    small.servers = small.servers.map((server) => ({ ...server, maxRam: 2 }));
    expect(why(planBatcher(network, small, "n00dles", ["n00dles"]))).toBe("no host holds the batcher");
  });
});

/** An Agent connects to `channel`, and is welcomed; then its snapshots. */
function connectedAgent(channel: ControlChannel) {
  const connection = new MemoryConnection();
  channel.accept(connection);
  connection.receive(
    encodeControlMessage({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      type: "hello",
      token: "the-token",
      deploymentId: "deployment-a",
      agentSessionId: "session-1",
      game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
    }),
  );
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
  const lastSent = () =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .at(-1) as unknown as DesiredState | undefined;
  return { send, lastSent };
}

describe("the controller", () => {
  test("switch on: the batcher on the hack loop's target and hosts, the hack loop left on with none; off: as before", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    expect(agent.lastSent()?.hackLoop).toMatchObject({ enabled: true, target: "n00dles" });
    expect(agent.lastSent()?.batcher).toBeUndefined();
    expect(controller.batcherView()).toEqual({ enabled: false, sent: null, why: null, health: null });

    controller.setBatcherEnabled(true);
    const sent = agent.lastSent();
    expect(sent?.hackLoop).toEqual({ enabled: true, target: "n00dles", hosts: [] });
    expect(sent?.batcher?.config).toMatchObject({ target: "n00dles", hosts: ["foodnstuff", "n00dles"] });
    expect(controller.batcherView()).toMatchObject({ enabled: true, sent: { target: "n00dles", hosts: 2 } });

    // Its health, as the Agent's fast snapshot reports it.
    const health = newBatcherHealth("n00dles", "r1", 5);
    agent.send("fast", {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [],
      dialogs: { handled: [], blocking: null },
      batcher: health,
    });
    expect(controller.batcherView().health).toEqual(health);

    controller.setBatcherEnabled(false);
    expect(agent.lastSent()?.batcher).toBeUndefined();
    expect(agent.lastSent()?.hackLoop.hosts.length).toBeGreaterThan(0);
  });

  test("switch on with nothing to plan: the hack loop as before, and why on the dashboard", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    controller.setBatcherEnabled(true);
    const agent = connectedAgent(channel);
    agent.send("static", network);
    // The medium snapshot without the player's multipliers: no plan.
    agent.send("medium", mediumData(50, { n00dles: true, foodnstuff: true }));
    expect(agent.lastSent()?.batcher).toBeUndefined();
    expect(agent.lastSent()?.hackLoop.hosts.length).toBeGreaterThan(0);
    expect(controller.batcherView()).toMatchObject({
      enabled: true,
      sent: null,
      why: expect.stringContaining("hacking"),
    });
  });
});

describe("batcherViewOf", () => {
  test("why only while on", () => {
    expect(batcherViewOf(false, null, "no target yet", null).why).toBeNull();
    expect(batcherViewOf(true, null, "no target yet", undefined)).toEqual({
      enabled: true,
      sent: null,
      why: "no target yet",
      health: null,
    });
  });
});

describe("the run report's section", () => {
  const at = (minutes: number) => 1_767_225_600_000 + minutes * 60_000;
  const health = (runName: string, changes: Partial<ReturnType<typeof newBatcherHealth>>) => ({
    ...newBatcherHealth("n00dles", runName, 0),
    state: "batching" as const,
    ...changes,
  });

  test("not run: says so", () => {
    expect(
      batcherSection([
        { atMs: at(0), health: null },
        { atMs: at(1), health: "junk" },
      ]),
    ).toEqual(["6. The batcher (#205)", "  not run in the window (no fast snapshot with its health)"]);
  });

  test("each hour adds up each run's rises; a restart's counts start again; desyncs and problems reported", () => {
    const lines = batcherSection([
      { atMs: at(0), health: health("a", { batchesStarted: 2, hacksLanded: 1, moneyHacked: 100 }) },
      { atMs: at(30), health: health("a", { batchesStarted: 10, hacksLanded: 8, moneyHacked: 800 }) },
      // Restarted: its counts from 0.
      {
        atMs: at(70),
        health: health("b", {
          batchesStarted: 3,
          hacksLanded: 2,
          moneyHacked: 50,
          desyncs: 1,
          outOfBounds: 1,
          problem: "no RAM to prepare n00dles",
        }),
      },
    ]);
    expect(lines[1]).toBe("  runs: 2; per hour, from 2026-01-01T00:00:00.000Z:");
    expect(lines[2]).toContain("hour 1: batching on n00dles; 10 batches, 8 hack parts landed ($800)");
    expect(lines[3]).toContain("hour 2: batching on n00dles; 3 batches, 2 hack parts landed ($50)");
    expect(lines[3]).toContain("1 desyncs (0 out of order, 1 out of bounds)");
    expect(lines).toContain("  desyncs: 1 (0 out of order, 1 out of bounds): reported here; #206 makes them a failure");
    expect(lines).toContain("    from 2026-01-01T01:10:00.000Z: no RAM to prepare n00dles");
  });

  test("in step: no desyncs, nothing late or lost, no problems", () => {
    const lines = batcherSection([{ atMs: at(0), health: health("a", { batchesStarted: 1 }) }]);
    expect(lines.slice(-3)).toEqual(["  desyncs: none", "  late or lost: none", "  problems: none"]);
  });
});
