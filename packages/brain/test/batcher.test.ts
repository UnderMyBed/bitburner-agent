// The brain's side of the batcher (#205, #206): its switch, its plan on a target and the hack loop's hosts, where it
// runs, the target it chooses (counting the time to prepare it) and the next one it prepares, what the controller sends
// with it on and logs, the dashboard's view and alert's facts, and the run report's section.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  BATCHER_RAM_BUDGET_GB,
  type BatcherHealth,
  type BatchShort,
  batcherIncomePerGigabyteSecond,
  batchPlan,
  batchRamGb,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  MIN_BATCH_SPACING_MS,
  newBatcherHealth,
  operationTimeMs,
  preparationTimeMs,
  type RamWait,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BATCHER_ENABLED_SETTING,
  BATCHER_MOST_IDLE_MS,
  BATCHER_MOVE_GAIN,
  BATCHER_MOVE_IDLE_FAILS_AFTER_MS,
  BATCHER_NEXT_HORIZON_MS,
  BATCHER_NEXT_RAM_SHARE,
  BATCHER_ON_HOME_SETTING,
  BATCHER_TARGET_HORIZON_MS,
  BATCHER_TARGETS_PLANNED,
  type BatcherTargetWorth,
  BN1_HACKING,
  batcherHostsOf,
  batcherMultsOf,
  batcherOutOfStep,
  batcherTargetsOf,
  batcherViewOf,
  bitNodeHackingOf,
  chooseBatcher,
  HACKING_MULTIPLIERS_UNREAD,
  HOME_KEPT_FOR_THE_AGENT_GB,
  hackingPlayerOf,
  planBatcher,
  readBatcherEnabled,
  readBatcherOnHome,
} from "../src/batcher.ts";
import { batcherSection, GROW_SHORTFALL_REACH_MS, whoHacked } from "../src/batcher-report.ts";
import type { ClockIncident } from "../src/clock-incidents.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { chooseHackHosts } from "../src/hack-loop.ts";
import { homeKeptGbOf, SHARE_HOME_KEPT_GB, singularityRamMultiplierOf } from "../src/share.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1, hacking: 1, hacking_exp: 1 };
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
  test("on unless the owner turned it off (#206)", () => {
    expect(readBatcherEnabled(store)).toBe(true);
    store.setSetting(BATCHER_ENABLED_SETTING, "false");
    expect(readBatcherEnabled(store)).toBe(false);
  });
});

describe("planBatcher", () => {
  test("kept where it runs while that still holds it (#211): a larger host, or home grown, doesn't move it", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true }, 64);
    const hosts = ["n00dles", "foodnstuff"];
    expect(planBatcher(network, data, BN1_HACKING, "n00dles", hosts, "foodnstuff").batcher?.runOn).toBe("foodnstuff");
    // Without a current host, home of 64 GB.
    expect(planBatcher(network, data, BN1_HACKING, "n00dles", hosts).batcher?.runOn).toBe("home");
    // A current host no longer a host moves it.
    expect(planBatcher(network, data, BN1_HACKING, "n00dles", ["n00dles"], "foodnstuff").batcher?.runOn).toBe("home");
  });

  test("on an 8 GB home: on the largest host, whose RAM the plan counts less the batcher's; core's plan, its config", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true });
    data.servers = data.servers.map((server) => (server.hostname === "n00dles" ? { ...server, maxRam: 4 } : server));
    const planned = planBatcher(network, data, BN1_HACKING, "n00dles", ["n00dles", "foodnstuff"]);
    const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
    const plan = batchPlan(N00DLES, player, batchRamGb([4, 16 - BATCHER_RAM_BUDGET_GB]));
    expect(planned).toEqual({
      incomePerSecond: plan?.incomePerSecond,
      peakRamGb: plan?.peakRamGb,
      ramGb: batchRamGb([4, 16 - BATCHER_RAM_BUDGET_GB]),
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
      planBatcher(network, medium(50, { n00dles: true, foodnstuff: true }, homeRam), BN1_HACKING, "n00dles", [
        "foodnstuff",
      ]);
    expect(HOME_KEPT_FOR_THE_AGENT_GB + BATCHER_RAM_BUDGET_GB).toBeLessThanOrEqual(16);
    expect(at(16).batcher?.runOn).toBe("home");
    expect(at(8).batcher?.runOn).toBe("foodnstuff");
  });

  test("none, and why: no hacking figures, no target figures, no host with RAM, or none that holds it", () => {
    const why = (planned: ReturnType<typeof planBatcher>) => (planned.batcher === null ? planned.why : null);
    expect(why(planBatcher(network, mediumData(50, { n00dles: true }), BN1_HACKING, "n00dles", ["n00dles"]))).toContain(
      "hacking figures",
    );
    expect(why(planBatcher(network, medium(50, { n00dles: true }), BN1_HACKING, "zer0", ["n00dles"]))).toContain(
      "zer0",
    );
    expect(why(planBatcher(network, medium(50, { n00dles: true }), BN1_HACKING, "n00dles", ["nowhere"]))).toBe(
      "no host with RAM",
    );
    const small = medium(50, { n00dles: true });
    small.servers = small.servers.map((server) => ({ ...server, maxRam: 2 }));
    expect(why(planBatcher(network, small, BN1_HACKING, "n00dles", ["n00dles"]))).toBe("no host holds the batcher");
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
  test("switch on: the batcher on the hack loop's hosts, the hack loop left on with none; off: as before; logged", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const log: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => log.push(line) });
    controller.setBatcherEnabled(false);
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    expect(agent.lastSent()?.hackLoop).toMatchObject({ enabled: true, target: "n00dles" });
    expect(agent.lastSent()?.batcher).toBeUndefined();
    expect(controller.batcherView()).toEqual({ enabled: false, sent: null, why: null, health: null });
    // Off from the start: nothing logged.
    expect(log.filter((line) => line.startsWith("batcher:"))).toEqual([]);

    controller.setBatcherEnabled(true);
    expect(log.filter((line) => line.startsWith("batcher:"))).toEqual(["batcher: batches n00dles"]);
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
    expect(log.filter((line) => line.startsWith("batcher:")).at(-1)).toBe("batcher: the hack loop hacks");
  });

  test("home among its hosts (#340), beyond the share's reserve; Singularity's worker kept too; its switch off: never", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }, 4_096));
    expect(agent.lastSent()?.batcher).toMatchObject({
      runOn: "home",
      config: { hosts: ["foodnstuff", "n00dles", "home"], homeKeptGb: SHARE_HOME_KEPT_GB },
    });
    expect(controller.batcherView().sent?.hosts).toBe(3);
    // In BN4 (#242's review): its largest Singularity worker's RAM kept beside, the same figure the share keeps.
    agent.send("slow", slowData(4));
    const kept = homeKeptGbOf(singularityRamMultiplierOf(slowData(4)));
    expect(kept).toBeGreaterThan(SHARE_HOME_KEPT_GB);
    expect(agent.lastSent()?.batcher?.config.homeKeptGb).toBe(kept);
    // Off: the game's servers alone, main's before #340; on again: back.
    store.setSetting(BATCHER_ON_HOME_SETTING, "false");
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }, 4_096));
    expect(agent.lastSent()?.batcher?.config.hosts).toEqual(["foodnstuff", "n00dles"]);
    expect(agent.lastSent()?.batcher?.config).not.toHaveProperty("homeKeptGb");
    expect(readBatcherOnHome(store)).toBe(false);
    store.setSetting(BATCHER_ON_HOME_SETTING, "true");
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }, 4_096));
    expect(agent.lastSent()?.batcher?.config.hosts).toContain("home");
  });

  test("switch on with the hack loop off: no batcher, and the dashboard says it needs the hack loop (#211)", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    controller.setBatcherEnabled(true);
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    expect(agent.lastSent()?.batcher).toBeDefined();
    controller.setHackLoopEnabled(false);
    expect(agent.lastSent()?.batcher).toBeUndefined();
    expect(controller.batcherView()).toMatchObject({ enabled: true, sent: null, why: "it needs the hack loop on" });
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

  test("in BN4 (#321): the config's player has BN4's multipliers folded in, once the slow snapshot says the BitNode", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const log: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => log.push(line) });
    controller.setBatcherEnabled(true);
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    // No slow snapshot yet: BN1's, logged once.
    expect(agent.lastSent()?.batcher?.config.player.mults).toMatchObject({ hacking_money: 1, hacking_exp: 1 });
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    expect(log.filter((line) => line === HACKING_MULTIPLIERS_UNREAD)).toHaveLength(1);
    agent.send("slow", slowData(4));
    expect(agent.lastSent()?.batcher?.config.player.mults).toMatchObject({ hacking_money: 0.2, hacking_exp: 0.4 });
    // The hack loop's threads (the batcher's hosts' loop) and sharing take the same; BN1's back in BN1.
    agent.send("slow", slowData(1));
    expect(agent.lastSent()?.batcher?.config.player.mults).toMatchObject({ hacking_money: 1, hacking_exp: 1 });
    expect(log.filter((line) => line === HACKING_MULTIPLIERS_UNREAD)).toHaveLength(1);
  });
});

describe("home among the hosts (#340)", () => {
  const HOSTS = ["n00dles", "foodnstuff"];
  const at = (homeRam: number, homeKeptGb: number | null, hosts = HOSTS, current: string | null = null) =>
    planBatcher(
      network,
      medium(50, { n00dles: true, foodnstuff: true }, homeRam),
      BN1_HACKING,
      "n00dles",
      hosts,
      current,
      1,
      homeKeptGb,
    );
  const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };

  test("last among the hosts, for its RAM beyond what it keeps and the batcher's budget; the config says what it keeps", () => {
    const planned = at(4_096, 32);
    if (planned.batcher === null) throw new Error(planned.why);
    // The game's servers 16 GB each; home's beyond its 32 GB, less the batcher's own budget, which runs there.
    const ramGb = batchRamGb([16, 16, 4_096 - 32 - BATCHER_RAM_BUDGET_GB]);
    expect(planned.ramGb).toBe(ramGb);
    expect(planned.incomePerSecond).toBe(batchPlan(N00DLES, player, ramGb)?.incomePerSecond);
    expect(planned.batcher).toMatchObject({ runOn: "home", config: { hosts: [...HOSTS, "home"], homeKeptGb: 32 } });
    // Whether the plan is held to the RAM (#340's review): on 4 TB it is; on a petabyte n00dles' money bounds it.
    expect(planned.batcher.config.ramBound).toBe(true);
    const huge = at(2 ** 20, 32);
    expect(huge.batcher?.config).toMatchObject({ hosts: [...HOSTS, "home"], ramBound: false });
    expect(huge.batcher?.config.spacingMs).toBe(MIN_BATCH_SPACING_MS);
  });

  test("with the batcher elsewhere, home's RAM beyond what it keeps, all of it, and the batcher's host less its budget", () => {
    const planned = at(4_096, 32, HOSTS, "foodnstuff");
    if (planned.batcher === null) throw new Error(planned.why);
    expect(planned.batcher.runOn).toBe("foodnstuff");
    expect(planned.ramGb).toBe(batchRamGb([16, 16 - BATCHER_RAM_BUDGET_GB, 4_096 - 32]));
  });

  test("never with its switch off (null): main's before #340, and the config says nothing of home", () => {
    const planned = at(4_096, null);
    if (planned.batcher === null) throw new Error(planned.why);
    expect(planned.batcher.config.hosts).toEqual(HOSTS);
    expect(planned.batcher.config).not.toHaveProperty("homeKeptGb");
    expect(planned.ramGb).toBe(batchRamGb([16, 16]));
  });

  test("a batch never takes the Agent's room: none on home until its RAM is past what it keeps and the batcher's", () => {
    const kept = 32 + 33.9;
    // At what it keeps and the batcher's budget, nothing left for an operation: not a host.
    expect(at(kept + BATCHER_RAM_BUDGET_GB, kept).batcher?.config.hosts).toEqual(HOSTS);
    expect(at(kept + BATCHER_RAM_BUDGET_GB, kept).batcher?.config).not.toHaveProperty("homeKeptGb");
    // A GB past it: a host, its GB beyond them the plan's.
    const past = at(kept + BATCHER_RAM_BUDGET_GB + 1, kept);
    expect(past.batcher?.config).toMatchObject({ hosts: [...HOSTS, "home"], homeKeptGb: kept });
    expect(past.batcher === null ? null : past.ramGb).toBe(batchRamGb([16, 16, 1]));
    // A fresh save's 8 GB, or 16: never, as before (the batcher may run there, its operations not).
    for (const homeRam of [8, 16]) expect(at(homeRam, 32).batcher?.config.hosts).toEqual(HOSTS);
  });

  test("home alone, no game server with RAM: the batcher and its batches on home", () => {
    const planned = at(4_096, 32, []);
    if (planned.batcher === null) throw new Error(planned.why);
    expect(planned.batcher).toMatchObject({ runOn: "home", config: { hosts: ["home"], homeKeptGb: 32 } });
    expect(planned.ramGb).toBe(batchRamGb([4_096 - 32 - BATCHER_RAM_BUDGET_GB]));
    // Without home, or within what it keeps: no host with RAM, as before.
    expect(at(4_096, null, []).batcher).toBeNull();
    expect(at(34, 32, [])).toEqual({ batcher: null, why: "no host with RAM" });
  });

  test("chooseBatcher plans every target on home's RAM too", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true }, 4_096);
    const chosen = chooseBatcher(network, data, BN1_HACKING, HOSTS, null, null, 32);
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.batcher.config).toMatchObject({ hosts: [...HOSTS, "home"], homeKeptGb: 32 });
    const without = chooseBatcher(network, data, BN1_HACKING, HOSTS, null, null);
    if (without.batcher === null) throw new Error(without.why);
    expect(without.batcher.config.hosts).toEqual(HOSTS);
  });
});

describe("batcherHostsOf", () => {
  test("the hack loop's hosts and its preparing ones", () => {
    expect(batcherHostsOf({ hosts: ["a", "b"] })).toEqual(["a", "b"]);
    expect(batcherHostsOf({ hosts: ["a"], preparing: { hosts: ["c", "d"] } })).toEqual(["a", "c", "d"]);
    expect(batcherHostsOf({ hosts: [], preparing: null })).toEqual([]);
  });
});

describe("batcherMultsOf (#315)", () => {
  test("the formulas' four and the level forecast's two, the medium snapshot's own; null if one is missing", () => {
    const mults = { hacking_chance: 1.1, hacking_speed: 1.2, hacking_money: 1.3, hacking_grow: 1.4 };
    const player = { skills: { hacking: 100, intelligence: 0 }, mults: { ...mults, hacking: 3.4, hacking_exp: 4.5 } };
    expect(batcherMultsOf(player, BN1_HACKING)).toEqual({ ...mults, hacking: 3.4, hacking_exp: 4.5 });
    expect(batcherMultsOf({ ...player, mults }, BN1_HACKING)).toBeNull();
    expect(batcherMultsOf({ ...player, mults: { ...mults, hacking: 3.4 } }, BN1_HACKING)).toBeNull();
    expect(batcherMultsOf(null, BN1_HACKING)).toBeNull();
  });

  test("the BitNode's ScriptHackMoney and HackExpGain folded into hacking_money and hacking_exp (#321): BN4's", () => {
    const mults = { hacking_chance: 1.1, hacking_speed: 1.2, hacking_money: 2.5, hacking_grow: 1.4 };
    const player = { skills: { hacking: 100, intelligence: 0 }, mults: { ...mults, hacking: 3.4, hacking_exp: 2.5 } };
    const bn4 = bitNodeHackingOf(4);
    expect(bn4).toEqual({ multipliers: { ...BN1_HACKING, ScriptHackMoney: 0.2, HackExpGain: 0.4 }, known: true });
    expect(batcherMultsOf(player, bn4.multipliers)).toEqual({
      ...mults,
      hacking_money: 0.5,
      hacking: 3.4,
      hacking_exp: 1,
    });
    expect(hackingPlayerOf(player, bn4.multipliers)).toEqual({
      skills: { hacking: 100, intelligence: 0 },
      mults: { ...mults, hacking_money: 0.5 },
    });
    // A BitNode core has none for, and none read: BN1's, said known false (the controller logs it).
    expect(bitNodeHackingOf(3)).toEqual({ multipliers: BN1_HACKING, known: false });
    expect(bitNodeHackingOf(undefined)).toEqual({ multipliers: BN1_HACKING, known: false });
    expect(bitNodeHackingOf(1)).toEqual({ multipliers: BN1_HACKING, known: true });
  });

  test("BN2's ServerGrowthRate and HackingLevelMultiplier folded into hacking_grow and hacking (#334)", () => {
    const mults = { hacking_chance: 1.1, hacking_speed: 1.2, hacking_money: 2.5, hacking_grow: 1.5 };
    const player = { skills: { hacking: 100, intelligence: 0 }, mults: { ...mults, hacking: 3, hacking_exp: 2.5 } };
    const bn2 = bitNodeHackingOf(2);
    expect(bn2).toEqual({
      multipliers: { ...BN1_HACKING, ServerGrowthRate: 0.8, HackingLevelMultiplier: 0.8 },
      known: true,
    });
    // 1.5 × 0.8 and 3 × 0.8: the grow's growth (`grow.ts:22-28`) and the level (`Person.ts:60-63`) as the game has them.
    expect(batcherMultsOf(player, bn2.multipliers)).toEqual({
      ...mults,
      hacking_grow: 1.2000000000000002,
      hacking: 2.4000000000000004,
      hacking_exp: 2.5,
    });
    expect(hackingPlayerOf(player, bn2.multipliers)?.mults).toEqual({ ...mults, hacking_grow: 1.2000000000000002 });
    // The plan the Agent runs carries them.
    const data = medium(50, { n00dles: true, foodnstuff: true });
    const inBn1 = planBatcher(network, data, BN1_HACKING, "n00dles", ["n00dles", "foodnstuff"]);
    const inBn2 = planBatcher(network, data, bn2.multipliers, "n00dles", ["n00dles", "foodnstuff"]);
    if (inBn1.batcher === null || inBn2.batcher === null) throw new Error("no plan");
    expect(inBn2.batcher.config.player.mults.hacking_grow).toBeCloseTo(
      0.8 * inBn1.batcher.config.player.mults.hacking_grow,
      12,
    );
    expect(inBn2.batcher.config.player.mults.hacking).toBeCloseTo(
      0.8 * (inBn1.batcher.config.player.mults.hacking ?? 0),
      12,
    );
  });

  test("in BN4 the plan hacks 5 times the share a thread for the same take: the hack threads planned rise", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true });
    const bn1 = planBatcher(network, data, BN1_HACKING, "n00dles", ["n00dles", "foodnstuff"]);
    const bn4 = planBatcher(network, data, bitNodeHackingOf(4).multipliers, "n00dles", ["n00dles", "foodnstuff"]);
    if (bn1.batcher === null || bn4.batcher === null) throw new Error("no plan");
    expect(bn4.batcher.config.player.mults).toMatchObject({ hacking_money: 0.2, hacking_exp: 0.4 });
    // A thread takes a fifth: the same RAM earns less, and the plan's share is the game's.
    expect(bn4.incomePerSecond).toBeLessThan(bn1.incomePerSecond);
    const player = { skills: { hacking: 50, intelligence: 0 }, mults: { ...MULTS, hacking_money: 0.2 } };
    expect(bn4.batcher.config.hackShare).toBe(batchPlan(N00DLES, player, bn4.ramGb)?.hackShare);
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
  /** A run's least money after a grow so far (#234), and its target. */
  const least = (share: number, target: string) => ({ leastMoneyAfterGrow: share, leastMoneyAfterGrowOn: target });

  test("home among its hosts (#340): its RAM in the batches; idle over half while batches want RAM, 10 minutes, fails", () => {
    const home = (freeGb: number, batchesGb: number, ramBound?: boolean) => ({
      gb: 4_128,
      keptGb: 32,
      freeGb,
      batchesGb,
      ...(ramBound === undefined ? {} : { ramBound }),
    });
    /** A fast snapshot every 2 s for `minutes`, from `fromMinute`, each health from `of(index)`. */
    const every2s = (fromMinute: number, minutes: number, of: (index: number) => Partial<BatcherHealth>) =>
      Array.from({ length: Math.round(minutes * 30) + 1 }, (_, index) => ({
        atMs: at(fromMinute + index / 30),
        health: health("a", of(index)),
      }));
    // Never a host: no line, no failure, as before #340.
    const never: string[] = [];
    expect(
      batcherSection(
        every2s(0, 1, () => ({})),
        never,
      ).some((line) => line.includes("#340")),
    ).toBe(false);
    expect(never).toEqual([]);
    // 10 minutes batching with 3,000 of home's 4,096 GB free, a batch trimmed every minute: a failure. Its RAM in the
    // batches, on average and at most.
    const idle = every2s(0, 10, (index) => ({ home: home(3_000, 1_096), batchesTrimmed: Math.floor(index / 30) }));
    const failures: string[] = [];
    const lines = batcherSection(idle, failures);
    const failure =
      "batches left home idle from 2026-01-01T00:00:00.000Z to 2026-01-01T00:10:00.000Z (10 min): batching, over half " +
      "of the 4,096 GB home may give free, with 10 batches trimmed or short of RAM";
    expect(failures).toEqual([failure]);
    expect(lines).toContain(
      "  home among its hosts (#340): 4,096 GB it may give the batches, beyond the 32 GB it keeps; its operations held " +
        "1,096 GB there on average while batching (27% of it), at most 1,096 GB",
    );
    expect(lines).toContain(`    ${failure}`);
    // Idle alone, no batch wanting RAM (a plan bounded by its target's money, or an older brain's): no failure.
    for (const ramBound of [false, undefined]) {
      const bounded: string[] = [];
      const boundedLines = batcherSection(
        every2s(0, 12, () => ({ home: home(3_000, 1_096, ramBound) })),
        bounded,
      );
      expect(bounded).toEqual([]);
      expect(boundedLines).toContain(
        "    batches left home idle (over half free, the plan held to the RAM or batches trimmed or short, for 10 " +
          "minutes): never",
      );
    }
    // The plan sent held to the RAM throughout (#340's review), none trimmed: the brain's plan sized without home.
    const heldToRam: string[] = [];
    batcherSection(
      every2s(0, 10, () => ({ home: home(3_000, 1_096, true) })),
      heldToRam,
    );
    expect(heldToRam).toEqual([
      "batches left home idle from 2026-01-01T00:00:00.000Z to 2026-01-01T00:10:00.000Z (10 min): batching, over half " +
        "of the 4,096 GB home may give free, with the plan sent held to the RAM",
    ]);
    // Held to the RAM for all but one look: not throughout, no failure.
    const once: string[] = [];
    batcherSection(
      every2s(0, 10, (index) => ({ home: home(3_000, 1_096, index !== 150) })),
      once,
    );
    expect(once).toEqual([]);
    // A home that isn't one (a figure not a number of 0 or more): no line, no failure.
    const odd: string[] = [];
    const oddLines = batcherSection(
      every2s(0, 10, () => ({ home: { ...home(3_000, 1_096, true), freeGb: Number.NaN } })),
      odd,
    );
    expect(odd).toEqual([]);
    expect(oddLines.some((line) => line.includes("#340"))).toBe(false);
    // Half free or less, a moment under 10 minutes, preparing, or a gap in the fast snapshots: none.
    const cases: Partial<BatcherHealth>[][] = [];
    for (const [freeGb, minutes, state] of [
      [2_048, 12, "batching"],
      [3_000, 9.9, "batching"],
      [3_000, 12, "preparing"],
    ] as const) {
      cases.push(
        every2s(0, minutes, (index) => ({ state, home: home(freeGb, 0), batchesShort: index })).map(
          ({ health: each }) => each,
        ),
      );
    }
    for (const each of cases) {
      const found: string[] = [];
      batcherSection(
        each.map((one, index) => ({ atMs: at(index / 30), health: one })),
        found,
      );
      expect(found.filter((line) => line.startsWith("batches left home idle"))).toEqual([]);
    }
    const gapped: string[] = [];
    batcherSection(
      idle.filter(({ atMs }) => atMs < at(4) || atMs > at(4.5)),
      gapped,
    );
    expect(gapped).toEqual([]);
  });

  test("not run: says so", () => {
    expect(
      batcherSection([
        { atMs: at(0), health: null },
        { atMs: at(1), health: "junk" },
      ]),
    ).toEqual(["6. The batcher (#205, #206)", "  not run in the window (no fast snapshot with its health)"]);
  });

  test("each hour adds up each run's rises, from the window's first snapshot; a restart's counts start again; desyncs a failure (#206)", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
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
      ],
      failures,
    );
    expect(lines[1]).toBe("  runs: 2; per hour, from 2026-01-01T00:00:00.000Z:");
    // Run a was under way at the window's first snapshot: it counts from there, 2 batches and $100 already done.
    expect(lines[2]).toContain("hour 1: batching on n00dles; 8 batches, 7 hack parts landed ($700)");
    expect(lines[3]).toContain("hour 2: batching on n00dles; 3 batches, 2 hack parts landed ($50)");
    expect(lines[3]).toContain("1 desync (0 out of order, 1 out of bounds)");
    expect(lines).toContain("  desyncs: 1 (0 out of order, 1 out of bounds)");
    // Out of step: a failure, from the snapshot that first showed it.
    expect(failures).toEqual([
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on n00dles, the first seen " +
        "at 2026-01-01T01:10:00.000Z; no page stall, or delivery lag the page was behind, before it",
    ]);
    expect(lines).toContain(`  ${failures[0]}`);
    expect(lines).toContain("    from 2026-01-01T01:10:00.000Z: no RAM to prepare n00dles");
  });

  test("a desync after grows short of their hacks names the shortfall its cause (#315); one without, or older, not", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { moneyLooks: 100 }) },
        { atMs: at(1), health: health("a", { moneyLooks: 200, moneyLooksBelowFull: 14, ...least(0.99, "n00dles") }) },
        {
          atMs: at(2),
          health: health("a", {
            state: "recovering",
            moneyLooks: 210,
            moneyLooksBelowFull: 83,
            ...least(0.84, "n00dles"),
            desyncs: 1,
            outOfBounds: 1,
          }),
        },
      ],
      failures,
    );
    const failure =
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on n00dles, the first seen at " +
      "2026-01-01T00:02:00.000Z; no page stall, or delivery lag the page was behind, before it; its cause: a grow " +
      "shortfall, the money below full after 83 grows from 2026-01-01T00:01:00.000Z, the least 84.0% of n00dles's " +
      "maximum, each hack taking more than its grow put back, so the batches drifted out of the bounds (#315)";
    expect(failures).toEqual([failure]);
    expect(lines).toContain(`  ${failure}`);
    // Grows short only longer ago than GROW_SHORTFALL_REACH_MS: not its cause.
    const longAgo: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: health("b", { moneyLooksBelowFull: 0 }) },
        { atMs: at(1), health: health("b", { moneyLooksBelowFull: 5 }) },
        { atMs: at(1 + GROW_SHORTFALL_REACH_MS / 60_000), health: health("b", { moneyLooksBelowFull: 5 }) },
        {
          atMs: at(2 + GROW_SHORTFALL_REACH_MS / 60_000),
          health: health("b", { moneyLooksBelowFull: 5, desyncs: 1, outOfBounds: 1 }),
        },
      ],
      longAgo,
    );
    expect(longAgo).toHaveLength(1);
    expect(longAgo[0]).not.toContain("its cause");
    // An older batcher, which doesn't look, gives none.
    const older: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: { ...health("c", {}), moneyLooksBelowFull: undefined } },
        { atMs: at(1), health: { ...health("c", { desyncs: 1, outOfBounds: 1 }), moneyLooksBelowFull: undefined } },
      ],
      older,
    );
    expect(older[0]).not.toContain("its cause");
    // Grows short on the target before a move (#315's review): not the new target's cause; and the run's least, from
    // before the reach on another target, isn't given.
    const moved: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: health("d", { moneyLooksBelowFull: 0 }) },
        { atMs: at(1), health: health("d", { moneyLooksBelowFull: 9, ...least(0.0, "n00dles") }) },
        // The move: zer0 prepared while n00dles' grows still land below full (#315's re-review): not zer0's.
        {
          atMs: at(2),
          health: {
            ...health("d", { state: "preparing", moneyLooksBelowFull: 12, ...least(0.0, "n00dles") }),
            target: "zer0",
          },
        },
        {
          atMs: at(3),
          health: {
            ...health("d", { moneyLooksBelowFull: 12, ...least(0.0, "n00dles"), desyncs: 1, outOfBounds: 1 }),
            target: "zer0",
          },
        },
      ],
      moved,
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]).not.toContain("grow shortfall");
    const later: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: health("e", { moneyLooksBelowFull: 3, ...least(0.5, "n00dles") }) },
        { atMs: at(10), health: health("e", { moneyLooksBelowFull: 3, ...least(0.5, "n00dles") }) },
        {
          atMs: at(11),
          health: health("e", { moneyLooksBelowFull: 7, ...least(0.5, "n00dles"), desyncs: 1, outOfBounds: 1 }),
        },
      ],
      later,
    );
    expect(later[0]).toContain(
      "its cause: a grow shortfall, the money below full after 4 grows from 2026-01-01T00:11:00.000Z, each hack",
    );
    // The run's least fell within the reach, but on another target (a next's, say): not this one's.
    const elsewhere: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: health("g", { moneyLooksBelowFull: 3 }) },
        {
          atMs: at(1),
          health: health("g", { moneyLooksBelowFull: 7, ...least(0.2, "zer0"), desyncs: 1, outOfBounds: 1 }),
        },
      ],
      elsewhere,
    );
    expect(elsewhere[0]).toContain("its cause: a grow shortfall, the money below full after 4 grows from");
    expect(elsewhere[0]).not.toContain("the least");
    // Late operations alone: no money drift's end, so no cause named.
    const lateOnly: string[] = [];
    batcherSection(
      [
        { atMs: at(0), health: health("f", {}) },
        { atMs: at(1), health: health("f", { moneyLooksBelowFull: 2, late: 1 }) },
      ],
      lateOnly,
    );
    expect(lateOnly).toHaveLength(1);
    expect(lateOnly[0]).not.toContain("grow shortfall");
  });

  test("a recovery in place past its time (#315's review): on the desyncs' line", () => {
    const lines = batcherSection([
      { atMs: at(0), health: health("a", {}) },
      { atMs: at(9), health: health("a", { state: "preparing", desyncs: 2, outOfBounds: 2, recoveriesTimedOut: 1 }) },
    ]);
    expect(lines).toContain(
      "  desyncs: 2 (0 out of order, 2 out of bounds); 1 recovery in place past its time (a weaken and 10 batches: " +
        "something kept the target down), the target prepared again",
    );
  });

  test("the level at the hacks' landings (#315): hacks sent smaller, the most levels; an older batcher's not", () => {
    const lines = batcherSection([
      { atMs: at(0), health: health("a", { hacksTrimmedForLevel: 10, mostLevelRise: 3 }) },
      { atMs: at(1), health: health("a", { hacksTrimmedForLevel: 45, mostLevelRise: 41 }) },
    ]);
    // Run a was under way at the window's start: its hacks counted from there.
    expect(lines).toContain(
      "  the level at the hacks' landings (#315): 35 hacks sent smaller for the level forecast at their landing; the " +
        "most levels forecast between a hack's start and its landing: 41",
    );
    const older = batcherSection([
      { atMs: at(0), health: { ...health("b", {}), hacksTrimmedForLevel: undefined, mostLevelRise: undefined } },
    ]);
    expect(older).toContain("  the level at the hacks' landings (#315): not reported (an older batcher)");
  });

  test("in step: no desyncs, nothing late or lost, no problems, always running", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { batchesStarted: 1, leastSlackMs: 180.4, moneyLooks: 3 }) },
        { atMs: at(1), health: health("a", { batchesStarted: 2, leastSlackMs: 116.6, moneyLooks: 5 }) },
      ],
      failures,
    );
    expect(lines.slice(-15)).toEqual([
      "  desyncs: none",
      "  late or lost: none",
      // The least over the window (#216's review).
      "  least slack: 117 ms (an operation's time to spare when it was called; under 0 is late)",
      // Never short, nor trimmed (#232).
      "  short of RAM: none",
      // Nothing waited for RAM at its time (#246).
      "  waited for RAM (#246): none",
      "  hacks held for their batch's orders waiting for RAM (#246): none; orders that found their batch gone: none",
      "  trimmed to the hosts' RAM (#232): none",
      // Each grow left the target at its maximum (#234): 2 looks in the window.
      "  money after each batch's grow (#234): full at all 2 looks",
      // No level rise forecast (#315).
      "  the level at the hacks' landings (#315): 0 hacks sent smaller for the level forecast at their landing; the " +
        "most levels forecast between a hack's start and its landing: 0",
      // No move in the window (#236).
      "  moves (#236): none",
      "  problems: none",
      "  sent but not running (3 fast snapshots in a row or more):",
      "    none",
      // Its sharing (#224): never asked here.
      "  sharing spare RAM (#224):",
      "    never asked, and no share threads",
    ]);
    expect(failures).toEqual([]);
  });

  test("short of RAM (#232): a failure, unless sharing on the batches' hosts (the share's failure); trimmed shown", () => {
    const onHosts = { wanted: true, threads: 4, ramGb: 16, hostsRamGb: 16, bonus: 1.05, roomGb: 0 };
    const homeAlone = { ...onHosts, hostsRamGb: 0 };
    // Each health written at its snapshot: an older one's sharing is a stopped batcher's, not counted (#226's review).
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { batchesStarted: 10 }) },
        { atMs: at(1), health: health("a", { batchesStarted: 20, batchesShort: 2, batchesTrimmed: 3 }) },
        // A share on the batches' hosts at either end: the share's (`share starved batches`).
        { atMs: at(2), health: health("a", { batchesStarted: 30, batchesShort: 3, sharing: onHosts, atMs: at(2) }) },
        // Shared on them at the interval's start only: still the share's.
        { atMs: at(3), health: health("a", { batchesStarted: 35, batchesShort: 4, sharing: homeAlone, atMs: at(3) }) },
        // Home alone sharing, at both ends, can't take their RAM (#230): the batcher's.
        { atMs: at(4), health: health("a", { batchesStarted: 40, batchesShort: 5, sharing: homeAlone, atMs: at(4) }) },
        // Restarted, counted from 0; an older batcher, which doesn't say how many it trimmed.
        { atMs: at(5), health: { ...health("b", { batchesStarted: 5, batchesShort: 1 }), batchesTrimmed: undefined } },
        { atMs: at(6), health: health("c", { batchesStarted: 5, batchesTrimmed: 2, batchesTrimmedBySharing: 1 }) },
      ],
      failures,
    );
    expect(lines[2]).toContain("6 short, 5 trimmed; ");
    expect(lines).toContain("  short of RAM: 6 batches (2 while sharing on the batches' hosts: the share's)");
    expect(lines).toContain(
      "  trimmed to the hosts' RAM (#232): 5 batches planned with fewer hack threads than the config's share, or none " +
        "(1 for the share's threads on the batches' hosts: the share's)",
    );
    const line =
      "batches short of RAM: 4 batches short (their hacks lost), not while sharing on the batches' hosts, the " +
      "first seen at 2026-01-01T00:01:00.000Z";
    expect(failures).toContain(line);
    expect(lines).toContain(`  ${line}`);
    expect(failures).toContainEqual(expect.stringMatching(/^share starved batches: 2 batches short of RAM /));
    expect(failures).toHaveLength(2);
  });

  test("short of RAM and waits for it (#246): each kept once, with what held the RAM; those not kept counted", () => {
    const held = {
      freeGb: 9.6,
      largestFreeGb: 3.5,
      pastLandingGb: 21.6,
      othersGb: 0,
      sharingGb: 0,
      landingLagMs: 35.2,
    };
    const short = (atMs: number, changes: Partial<BatchShort> = {}): BatchShort => ({
      atMs,
      target: "n00dles",
      operation: "weaken1",
      threads: 12,
      waitedMs: 100.4,
      slackMs: null,
      failedOn: null,
      ...held,
      ...changes,
    });
    const wait = (atMs: number, waitedMs: number, changes: Partial<RamWait> = {}): RamWait => ({
      atMs,
      target: "n00dles",
      operation: "grow",
      threads: 30,
      waitedMs,
      slackMs: 150.4,
      ...held,
      ...changes,
    });
    const failures: string[] = [];
    const lines = batcherSection(
      [
        // Under way at the window's start: its short and wait before it aren't the window's, nor its longest wait.
        {
          atMs: at(0),
          health: health("a", {
            batchesShort: 1,
            shorts: [short(at(-1))],
            ramWaits: 2,
            longestRamWaitMs: 90,
            waits: [wait(at(-1), 90)],
          }),
        },
        {
          atMs: at(1),
          health: health("a", {
            batchesShort: 2,
            shorts: [short(at(-1)), short(at(0.5))],
            ramWaits: 3,
            longestRamWaitMs: 90,
            waits: [wait(at(-1), 90), wait(at(0.5), 40.2, { landingLagMs: null })],
          }),
        },
        // Another run under way at the window's start, with no wait in it: its longest isn't the window's runs'.
        { atMs: at(0), health: health("z", { ramWaits: 4, longestRamWaitMs: 99, waits: [wait(at(-2), 99)] }) },
        // Kept again in the next health: listed once.
        {
          atMs: at(2),
          health: health("a", {
            batchesShort: 3,
            shorts: [short(at(-1)), short(at(0.5)), short(at(1.5), { operation: "hack", othersGb: 4.8 })],
            ramWaits: 3,
            longestRamWaitMs: 90,
            waits: [wait(at(-1), 90), wait(at(0.5), 40.2, { landingLagMs: null })],
          }),
        },
        // Restarted: 7 shorts and 6 waits between snapshots, of which its health keeps the last 5 each. One the Agent
        // wrote wrong is left out.
        {
          atMs: at(3),
          health: {
            ...health("b", {
              batchesShort: 7,
              ramWaits: 6,
              longestRamWaitMs: 60,
              hacksHeldForBatch: 2,
              ordersDropped: 1,
            }),
            shorts: [
              ...[2.1, 2.2, 2.3].map((minutes) => short(at(minutes))),
              { ...short(at(2.5)), failedOn: "foodnstuff" },
              { ...short(at(2.6)), atMs: "junk" },
            ],
            waits: [2.1, 2.2, 2.3, 2.4, 2.5].map((minutes) => wait(at(minutes), 60)),
          },
        },
      ],
      failures,
    );
    const shortsFrom = lines.indexOf("  short of RAM: 9 batches (0 while sharing on the batches' hosts: the share's)");
    expect(shortsFrom).toBeGreaterThan(0);
    const heldText =
      "9.6 GB free (3.5 GB at most on a host), held by its operations past their landing up to 21.6 " +
      "GB, by scripts not its own 0 GB, by its share threads 0 GB; landings 35 ms late";
    expect(lines.slice(shortsFrom + 1, shortsFrom + 9)).toEqual([
      `    at 2026-01-01T00:00:30.000Z: weaken1 of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText}`,
      `    at 2026-01-01T00:01:30.000Z: hack of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText.replace(
        "own 0 GB",
        "own 4.8 GB",
      )}`,
      `    at 2026-01-01T00:02:06.000Z: weaken1 of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText}`,
      `    at 2026-01-01T00:02:12.000Z: weaken1 of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText}`,
      `    at 2026-01-01T00:02:18.000Z: weaken1 of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText}`,
      `    at 2026-01-01T00:02:30.000Z: weaken1 of 12 threads on n00dles, 100 ms past its time; as it gave up ${heldText}; exec ` +
        "failed on foodnstuff",
      // 9 in the window, 6 listed: run b's 7 between two snapshots, of which its health kept 5 (one unreadable).
      "    (3 more not kept: the health keeps the last 5)",
      // The waits in the window: run a's 1 since its first snapshot, run b's 6; the longest in a run is its own so
      // far, run a's 90 from before the window, so it says so.
      "  waited for RAM (#246): 7 operations found no room at their time and started within 100 ms; the longest wait " +
        "in the run so far 90 ms",
    ]);
    const waitsFrom = shortsFrom + 9;
    expect(lines.slice(waitsFrom, waitsFrom + 8)).toEqual([
      "    at 2026-01-01T00:00:30.000Z: grow of 30 threads on n00dles, started 40 ms past its time, 150 ms to spare; at its first look " +
        heldText.replace("landings 35 ms late", "none landed then"),
      ...[6, 12, 18, 24, 30].map(
        (seconds) =>
          `    at 2026-01-01T00:02:${String(seconds).padStart(2, "0")}.000Z: grow of 30 threads on n00dles, ` +
          `started 60 ms past its time, 150 ms to spare; at its first look ${heldText}`,
      ),
      "    (1 more not kept: the health keeps the last 5)",
      // Hacks held for their batch apart from the waits for RAM, and an order that found its batch gone: never silent.
      "  hacks held for their batch's orders waiting for RAM (#246): 2; orders that found their batch gone: 1",
    ]);
    // Still a failure (#232).
    expect(failures).toContainEqual(expect.stringMatching(/^batches short of RAM: 9 batches short /));
    // An order dropped, its batch gone (#253): a hack landed without its grow or weaken, a failure, with when it was
    // first seen.
    const dropped =
      "batch orders dropped: 1 found their batch gone (a bug since #253), the first seen at 2026-01-01T00:03:00.000Z";
    expect(failures).toContain(dropped);
    expect(lines).toContain(`  ${dropped}`);
    // An older batcher says nothing of waits.
    const older = batcherSection([{ atMs: at(0), health: { ...health("c", {}), ramWaits: undefined } }]);
    expect(older).toContain("  waited for RAM (#246): not reported (an older batcher)");
  });

  test("money after each batch's grow (#234): below full, with the run's least so far and its target", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
        // Run a was under way at the window's start: its counts from there. Its least only falls.
        { atMs: at(0), health: health("a", { moneyLooks: 10, moneyLooksBelowFull: 1, ...least(0.99, "iron-gym") }) },
        { atMs: at(1), health: health("a", { moneyLooks: 30, moneyLooksBelowFull: 3, ...least(0.97, "iron-gym") }) },
        // Restarted, counted from 0: its least is its own.
        {
          atMs: at(2),
          health: health("b", {
            moneyLooks: 10,
            moneyLooksBelowFull: 1,
            growsNotLooked: 2,
            ...least(0.98, "omega-net"),
          }),
        },
        // A run that found it full has a least of 1: not among those below.
        { atMs: at(3), health: health("c", { moneyLooks: 10 }) },
      ],
      failures,
    );
    expect(lines).toContain(
      "  money after each batch's grow (#234): below full after 3 of 40 looks (the runs' least so far: 97.0% of " +
        "iron-gym's maximum), 2 grows not looked at; a grow short of the hack before it, so the batches drift toward " +
        "the bounds' floor",
    );
    // A line, not a failure: a drift that reaches the floor is a desync, which fails the run.
    expect(failures).toEqual([]);
    // One run below: its own least.
    expect(
      batcherSection([
        { atMs: at(0), health: health("a", {}) },
        { atMs: at(1), health: health("a", { moneyLooks: 5, moneyLooksBelowFull: 1, ...least(0.9, "iron-gym") }) },
      ]),
    ).toContain(
      "  money after each batch's grow (#234): below full after 1 of 5 looks (the run's least so far: 90.0% of " +
        "iron-gym's maximum); a grow short of the hack before it, so the batches drift toward the bounds' floor",
    );
    // A run whose looks below full were all before the window: its least isn't the window's, though lower.
    const before = { moneyLooksBelowFull: 1, ...least(0.8, "iron-gym") };
    expect(
      batcherSection([
        { atMs: at(0), health: health("a", { moneyLooks: 5, ...before }) },
        { atMs: at(1), health: health("a", { moneyLooks: 9, ...before }) },
        { atMs: at(2), health: health("b", { moneyLooks: 4, moneyLooksBelowFull: 1, ...least(0.95, "omega-net") }) },
      ]),
    ).toContain(
      "  money after each batch's grow (#234): below full after 1 of 8 looks (the run's least so far: 95.0% of " +
        "omega-net's maximum); a grow short of the hack before it, so the batches drift toward the bounds' floor",
    );
  });

  test("money after each batch's grow (#234): full; none landed; none looked at; an older batcher's", () => {
    const line = (healths: unknown[]) =>
      batcherSection(healths.map((each, index) => ({ atMs: at(index), health: each }))).find((each) =>
        each.startsWith("  money after each batch's grow (#234): "),
      );
    expect(line([health("a", {}), health("a", { moneyLooks: 4, growsNotLooked: 1 })])).toBe(
      "  money after each batch's grow (#234): full at all 4 looks, 1 grow not looked at",
    );
    expect(line([health("a", {}), health("a", { moneyLooks: 4 })])).toBe(
      "  money after each batch's grow (#234): full at all 4 looks",
    );
    expect(line([health("a", {})])).toBe(
      "  money after each batch's grow (#234): not looked at (no grow landed in the window)",
    );
    // Every grow had something land on its target first, or landed during a desync's recovery.
    expect(line([health("a", {}), health("a", { growsNotLooked: 3 })])).toBe(
      "  money after each batch's grow (#234): none looked at: 3 grows not looked at (something else landed on the " +
        "target first, or a desync's recovery)",
    );
    // An older batcher, which doesn't look.
    const older = {
      ...health("a", {}),
      moneyLooks: undefined,
      moneyLooksBelowFull: undefined,
      leastMoneyAfterGrow: undefined,
      leastMoneyAfterGrowOn: undefined,
      growsNotLooked: undefined,
    };
    expect(line([older])).toBe("  money after each batch's grow (#234): not reported (an older batcher)");
  });

  test("each move with its idle time (#236); one past BATCHER_MOVE_IDLE_FAILS_AFTER_MS, done or not, a failure", () => {
    const failures: string[] = [];
    const hackAt = (target: string, minutes: number) => ({ lastHack: { target, atMs: at(minutes) } });
    const move = (from: string, to: string, fromMinutes: number, toMinutes: number) => ({
      lastMove: { from, to, idleMs: (toMinutes - fromMinutes) * 60_000, atMs: at(toMinutes) },
    });
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { ...hackAt("n00dles", 0) }) },
        // A move to phantasy, idle 1.5 minutes: seen in two snapshots, listed once.
        {
          atMs: at(10),
          health: health("a", {
            target: "phantasy",
            ...hackAt("phantasy", 10),
            ...move("n00dles", "phantasy", 8.5, 10),
          }),
        },
        {
          atMs: at(11),
          health: health("a", {
            target: "phantasy",
            ...hackAt("phantasy", 11),
            ...move("n00dles", "phantasy", 8.5, 10),
          }),
        },
        // Run #2's: 25.6 minutes, through a target never hacked (4sigma).
        {
          atMs: at(20),
          health: health("a", {
            target: "4sigma",
            ...hackAt("phantasy", 13.5),
            ...move("n00dles", "phantasy", 8.5, 10),
          }),
        },
        {
          atMs: at(40),
          health: health("a", {
            target: "megacorp",
            ...hackAt("megacorp", 39.1),
            ...move("phantasy", "megacorp", 13.5, 39.1),
          }),
        },
        // A restarted batcher's move, not done at the window's end: 11 minutes so far.
        { atMs: at(41), health: health("b", { target: "megacorp", ...hackAt("megacorp", 41) }) },
        {
          atMs: at(52),
          health: health("b", { target: "ecorp", ...hackAt("megacorp", 41), targetChangedSinceHack: true }),
        },
      ],
      failures,
    );
    const from = lines.indexOf("  moves (#236), from the last hack on the target before to the first on the new one:");
    expect(lines.slice(from, from + 4)).toEqual([
      "  moves (#236), from the last hack on the target before to the first on the new one:",
      "    n00dles → phantasy at 2026-01-01T00:10:00.000Z: idle 1.5 min",
      "    phantasy → megacorp at 2026-01-01T00:39:06.000Z: idle 25.6 min",
      "    megacorp → ecorp, not done at 2026-01-01T00:52:00.000Z: idle 11.0 min so far",
    ]);
    expect(failures).toEqual([
      "batcher idle on a move: phantasy → megacorp, 25.6 min without a hack, from 2026-01-01T00:13:30.000Z to " +
        "2026-01-01T00:39:06.000Z (more than 10 min)",
      "batcher idle on a move: megacorp → ecorp, 11.0 min without a hack, from 2026-01-01T00:41:00.000Z to " +
        "2026-01-01T00:52:00.000Z, not done (more than 10 min)",
    ]);
    expect(lines).toContain(`  ${failures[0]}`);
    expect(BATCHER_MOVE_IDLE_FAILS_AFTER_MS).toBe(2 * BATCHER_MOST_IDLE_MS);
  });

  test("moves (#237's review): one done before the window isn't the window's; one across a restart is joined", () => {
    const failures: string[] = [];
    // Run #2's 25.6-minute move ended before the window: kept in the health until the next move, it isn't listed.
    const old = { from: "phantasy", to: "megacorp", idleMs: 25.6 * 60_000, atMs: at(-21) };
    const later = batcherSection(
      [
        {
          atMs: at(0),
          health: health("a", { target: "megacorp", lastHack: { target: "megacorp", atMs: at(0) }, lastMove: old }),
        },
        {
          atMs: at(30),
          health: health("a", { target: "megacorp", lastHack: { target: "megacorp", atMs: at(30) }, lastMove: old }),
        },
      ],
      failures,
    );
    expect(later).toContain("  moves (#236): none");
    expect(failures).toEqual([]);
    // A restart between the last hack on n00dles and the first on phantasy: the new run starts with no last hack, so
    // the report joins them; one still under way at the window's end is joined too.
    const joined = batcherSection(
      [
        { atMs: at(0), health: health("a", { lastHack: { target: "n00dles", atMs: at(0) } }) },
        { atMs: at(2), health: health("b", { target: "phantasy" }) },
        { atMs: at(13), health: health("b", { target: "phantasy", lastHack: { target: "phantasy", atMs: at(12.5) } }) },
        { atMs: at(14), health: health("c", { target: "megacorp" }) },
        { atMs: at(26), health: health("c", { target: "megacorp" }) },
      ],
      failures,
    );
    expect(joined.filter((line) => line.includes("→"))).toEqual([
      "    n00dles → phantasy at 2026-01-01T00:12:30.000Z: idle 12.5 min, across a restart",
      "    phantasy → megacorp, not done at 2026-01-01T00:26:00.000Z: idle 13.5 min so far, across a restart",
      "  batcher idle on a move: n00dles → phantasy, 12.5 min without a hack, from 2026-01-01T00:00:00.000Z to " +
        "2026-01-01T00:12:30.000Z (more than 10 min)",
      "  batcher idle on a move: phantasy → megacorp, 13.5 min without a hack, from 2026-01-01T00:12:30.000Z to " +
        "2026-01-01T00:26:00.000Z, not done (more than 10 min)",
    ]);
    // An install between the two isn't a move: the new cycle starts from nothing.
    const installed = batcherSection(
      [
        { atMs: at(0), health: health("a", { target: "phantasy", lastHack: { target: "phantasy", atMs: at(0) } }) },
        { atMs: at(14), health: health("b", { lastHack: { target: "n00dles", atMs: at(13) } }) },
      ],
      [],
      [],
      [at(1)],
    );
    expect(installed).toContain("  moves (#236): none");
  });

  test("moves (#237's re-review): a run with no hack between two is no break in the join; a detour shows under way", () => {
    const failures: string[] = [];
    // A crash loop: a hacks n00dles, b never hacks, c first hacks phantasy 20 minutes in.
    const chain = batcherSection(
      [
        { atMs: at(0), health: health("a", { lastHack: { target: "n00dles", atMs: at(0) } }) },
        { atMs: at(2), health: health("b", { target: "phantasy" }) },
        { atMs: at(5), health: health("b", { target: "phantasy" }) },
        { atMs: at(21), health: health("c", { target: "phantasy", lastHack: { target: "phantasy", atMs: at(20) } }) },
      ],
      failures,
    );
    expect(chain.filter((line) => line.includes("→"))).toEqual([
      "    n00dles → phantasy at 2026-01-01T00:20:00.000Z: idle 20.0 min, across a restart",
      "  batcher idle on a move: n00dles → phantasy, 20.0 min without a hack, from 2026-01-01T00:00:00.000Z to " +
        "2026-01-01T00:20:00.000Z (more than 10 min)",
    ]);
    // Detours under way at the window's end, as the health says: phantasy → 4sigma → phantasy, 4sigma never hacked;
    // and 4sigma → phantasy → 4sigma, phantasy never hacked. Each back on the target last hacked.
    for (const target of ["phantasy", "4sigma"]) {
      const detour = batcherSection([
        { atMs: at(0), health: health("a", { target, lastHack: { target, atMs: at(0) } }) },
        {
          atMs: at(12),
          health: health("a", { target, lastHack: { target, atMs: at(0) }, targetChangedSinceHack: true }),
        },
      ]);
      expect(detour).toContain(`    ${target} → ${target}, not done at 2026-01-01T00:12:00.000Z: idle 12.0 min so far`);
    }
  });

  test("moves (#237's review): a last hack or a move that isn't one, as the Agent sent it, is left out", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { lastHack: { target: "n00dles", atMs: Number.NaN } }) },
        {
          atMs: at(20),
          health: {
            ...health("a", { target: "joesguns", lastHack: { target: "joesguns", atMs: at(20) } }),
            lastMove: { from: "n00dles", to: "joesguns", idleMs: "a while", atMs: at(20) },
          },
        },
      ],
      failures,
    );
    expect(lines.filter((line) => line.includes("NaN") || line.includes("→"))).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("moves (#236): none; a move under way within the limit isn't a failure; an older batcher's", () => {
    const failures: string[] = [];
    const quiet = batcherSection([{ atMs: at(0), health: health("a", {}) }], failures);
    expect(quiet).toContain("  moves (#236): none");
    const underWay = batcherSection(
      [
        { atMs: at(0), health: health("a", { lastHack: { target: "n00dles", atMs: at(0) } }) },
        {
          atMs: at(4),
          health: health("a", {
            target: "joesguns",
            lastHack: { target: "n00dles", atMs: at(0) },
            targetChangedSinceHack: true,
          }),
        },
      ],
      failures,
    );
    expect(underWay).toContain("    n00dles → joesguns, not done at 2026-01-01T00:04:00.000Z: idle 4.0 min so far");
    expect(failures).toEqual([]);
    // Done, n00dles' batches still landing among joesguns': its last hack is n00dles', and the move isn't under way.
    const landing = batcherSection([
      { atMs: at(3), health: health("a", { lastHack: { target: "n00dles", atMs: at(3) } }) },
      {
        atMs: at(5),
        health: health("a", {
          target: "joesguns",
          lastHack: { target: "n00dles", atMs: at(5) },
          lastMove: { from: "n00dles", to: "joesguns", idleMs: 60_000, atMs: at(4.9) },
        }),
      },
    ]);
    expect(landing.filter((line) => line.includes("→"))).toEqual([
      "    n00dles → joesguns at 2026-01-01T00:04:54.000Z: idle 1.0 min",
    ]);
    const older = health("a", {});
    delete older.lastHack;
    delete older.lastMove;
    expect(batcherSection([{ atMs: at(0), health: older }])).toContain(
      "  moves (#236): not reported (an older batcher)",
    );
  });

  test("sent but not running for 3 fast snapshots in a row or more: each stretch a failure; 2 aren't (#211)", () => {
    const down = { running: null, started: false, stopped: 0, problem: "no room on joesguns" };
    const up = { running: "joesguns", started: true, stopped: 0, problem: null };
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: null, deploy: down },
        { atMs: at(1), health: null, deploy: down },
        { atMs: at(2), health: null, deploy: up },
        { atMs: at(3), health: null, deploy: { ...down, problem: null } },
        { atMs: at(4), health: null, deploy: down },
        { atMs: at(5), health: null, deploy: down },
        { atMs: at(6), health: null, deploy: null },
      ],
      failures,
    );
    expect(failures).toEqual([
      "batcher not running from 2026-01-01T00:03:00.000Z to 2026-01-01T00:05:00.000Z (3 fast snapshots): no room on joesguns",
    ]);
    expect(lines).toContain(`    ${failures[0]}`);
  });
});

const RICH = { moneyMax: 1_000_000_000, minDifficulty: 5, requiredHackingSkill: 50, serverGrowth: 50 };
const choiceNetwork: StaticSnapshotData = {
  servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles", N00DLES), staticServer("rich", RICH)],
};
/** Hacking 100, two 1 TB cloud servers as hosts, n00dles prepared, and rich with `money` at `security`. */
function choiceMedium(money: number, security: number): MediumSnapshotData {
  const data = medium(100, { n00dles: true, rich: true });
  const at = (hostname: string) => (hostname === "rich" ? { moneyAvailable: money, hackDifficulty: security } : {});
  data.servers = [
    ...data.servers.map((server) => ({
      ...server,
      ...(server.hostname === "n00dles" ? { moneyAvailable: N00DLES.moneyMax, hackDifficulty: 1 } : {}),
      ...at(server.hostname),
    })),
    ...["pserv-0", "pserv-1"].map((hostname) => ({
      hostname,
      maxRam: 1024,
      cpuCores: 1,
      hasAdminRights: true,
      backdoorInstalled: false,
      moneyAvailable: 0,
      hackDifficulty: 1,
    })),
  ];
  return data;
}
const CHOICE_HOSTS = ["pserv-0", "pserv-1"];
const PLAYER_100 = { skills: { hacking: 100, intelligence: 0 }, mults: MULTS };

test("planBatcher's figures carry the static snapshot's base difficulty when it has one (#315's review)", () => {
  const data = choiceMedium(RICH.moneyMax, RICH.minDifficulty);
  const based: StaticSnapshotData = {
    servers: choiceNetwork.servers.map((server) =>
      server.hostname === "rich" ? { ...server, baseDifficulty: 27.5 } : server,
    ),
  };
  expect(planBatcher(based, data, BN1_HACKING, "rich", CHOICE_HOSTS).batcher?.config.figures.baseDifficulty).toBe(27.5);
  // An older Agent's snapshot, without it: none in the figures (the batcher takes the most a minimum allows).
  expect(
    planBatcher(choiceNetwork, data, BN1_HACKING, "rich", CHOICE_HOSTS).batcher?.config.figures,
  ).not.toHaveProperty("baseDifficulty");
});

describe("chooseBatcher (#206)", () => {
  const choose = (data: MediumSnapshotData, current: string | null = null, batching: string | null = null) => {
    const planned = current === null ? null : planBatcher(choiceNetwork, data, BN1_HACKING, current, CHOICE_HOSTS);
    const chosen = chooseBatcher(choiceNetwork, data, BN1_HACKING, CHOICE_HOSTS, planned?.batcher ?? null, batching);
    if (chosen.batcher === null) throw new Error(chosen.why);
    return chosen;
  };
  const worthOf = (chosen: ReturnType<typeof choose>, target: string) =>
    chosen.worths.find((each) => each.target === target) as BatcherTargetWorth;

  test("the worthiest over the horizon, counting the time to prepare it: rich at nothing waits, n00dles earns", () => {
    const chosen = choose(choiceMedium(0, 15));
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    // Rich's plan earns far more, but growing it from nothing takes longer than the horizon.
    expect(rich.incomePerSecond).toBeGreaterThan(10 * n00dles.incomePerSecond);
    expect(rich.untilEarningMs).toBeGreaterThan(BATCHER_TARGET_HORIZON_MS);
    expect(rich.worth).toBe(0);
    expect(chosen.batcher.config.target).toBe("n00dles");
    // No next target: rich doesn't earn on the next's part of the RAM within BATCHER_NEXT_HORIZON_MS either (#274).
    expect(chosen.batcher.config.next).toBeUndefined();
  });

  test("rich prepared: it earns a batch's weaken after it starts, and is chosen; n00dles isn't worth a next", () => {
    const chosen = choose(choiceMedium(RICH.moneyMax, RICH.minDifficulty));
    expect(worthOf(chosen, "rich").untilEarningMs).toBe(operationTimeMs("weaken1", RICH, PLAYER_100));
    expect(chosen.batcher.config.target).toBe("rich");
    expect(chosen.batcher.config.next).toBeUndefined();
  });

  test("the target batched is kept unless another is worth BATCHER_MOVE_GAIN times it; then prepared beside it", () => {
    // Rich nearly all grown, at its minimum: a wave or two on the next's part of the RAM.
    const data = choiceMedium(RICH.moneyMax * 0.9, RICH.minDifficulty);
    const chosen = choose(data, "n00dles", "n00dles");
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    expect(n00dles.untilEarningMs).toBe(0);
    expect(rich.worth).toBeGreaterThanOrEqual(n00dles.worth * BATCHER_MOVE_GAIN);
    // Worth the move, but prepared on the RAM n00dles' batches leave it earns only after BATCHER_MOST_IDLE_MS (#216's
    // review): it's prepared as the next, and the move comes once it's ready.
    expect(rich.untilEarningMs).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next?.target).toBe("rich");
    // Prepared: the move.
    expect(choose(choiceMedium(RICH.moneyMax, RICH.minDifficulty), "n00dles", "n00dles").batcher.config.target).toBe(
      "rich",
    );
    // A target batched worth more than the move: kept, and rich, prepared beside it on the next's part of the RAM,
    // which the batches' plan leaves out.
    const kept = choose(data, "rich", "rich");
    expect(kept.batcher.config.target).toBe("rich");
    expect(kept.batcher.config.next).toBeUndefined();
  });

  test("a richer target not yet worth the move is prepared next, on the next's part of the RAM", () => {
    // A less rich one, a fifth grown, at its minimum: a wave on all the RAM, a few on the next's part; n00dles batched.
    const lessRich = { ...RICH, moneyMax: 80_000_000 };
    const network: StaticSnapshotData = {
      servers: [staticServer("n00dles", N00DLES), staticServer("rich", lessRich)],
    };
    const data = choiceMedium(lessRich.moneyMax / 5, RICH.minDifficulty);
    const sent = planBatcher(network, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(network, data, BN1_HACKING, CHOICE_HOSTS, sent, "n00dles");
    if (chosen.batcher === null) throw new Error(chosen.why);
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    // It earns more once prepared, enough for a move, but isn't worth one over the horizon yet.
    expect(rich.incomePerSecond).toBeGreaterThan(n00dles.incomePerSecond * BATCHER_MOVE_GAIN);
    expect(rich.worth).toBeLessThan(n00dles.worth * BATCHER_MOVE_GAIN);
    expect(chosen.batcher.config.target).toBe("n00dles");
    const whole = planBatcher(network, data, BN1_HACKING, "rich", CHOICE_HOSTS);
    expect(chosen.batcher.config.next).toEqual({
      target: "rich",
      figures: lessRich,
      ramGb: (whole.batcher === null ? 0 : whole.ramGb) * BATCHER_NEXT_RAM_SHARE,
    });
    // The batches are planned on the rest.
    const rest = planBatcher(network, data, BN1_HACKING, "n00dles", CHOICE_HOSTS, null, 1 - BATCHER_NEXT_RAM_SHARE);
    expect(chosen.batcher.config.spacingMs).toBe(rest.batcher?.config.spacingMs);
  });

  test("the target sent but worth nothing gives way: of those worth nothing, the soonest to earn", () => {
    // Two slow growers from nothing, both out of the horizon: "slower" first by the ceiling, and sent; "slow" sooner.
    const slow = { ...RICH };
    const slower = { ...RICH, moneyMax: 2 * RICH.moneyMax, minDifficulty: 3, serverGrowth: 20 };
    const network: StaticSnapshotData = {
      servers: [staticServer("slow", slow), staticServer("slower", slower)],
    };
    const data = choiceMedium(0, 15);
    data.servers = [
      ...data.servers.filter((server) => server.hostname.startsWith("pserv-")),
      ...["slow", "slower"].map((hostname) => ({
        hostname,
        maxRam: 16,
        cpuCores: 1,
        hasAdminRights: true,
        backdoorInstalled: false,
        moneyAvailable: 0,
        hackDifficulty: 15,
      })),
    ];
    const sent = planBatcher(network, data, BN1_HACKING, "slower", CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(network, data, BN1_HACKING, CHOICE_HOSTS, sent, null);
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.worths.map((each) => each.target)).toEqual(["slower", "slow"]);
    expect(chosen.worths.map((each) => each.worth)).toEqual([0, 0]);
    expect(worthOf(chosen, "slow").untilEarningMs).toBeLessThan(worthOf(chosen, "slower").untilEarningMs);
    expect(chosen.batcher.config.target).toBe("slow");
  });

  test("none, and why: no hacking figures; no rooted server with money the player can hack", () => {
    expect(
      chooseBatcher(choiceNetwork, mediumData(100, { rich: true }), BN1_HACKING, CHOICE_HOSTS, null, null),
    ).toEqual({
      batcher: null,
      why: "the medium snapshot has no hacking figures for the player",
    });
    expect(chooseBatcher(choiceNetwork, medium(100, { rich: false }), BN1_HACKING, CHOICE_HOSTS, null, null)).toEqual({
      batcher: null,
      why: "no rooted server with money the player can hack",
    });
  });
});

describe("batcherTargetsOf (#206)", () => {
  test("the game's servers rooted with money that a hack takes something from: not home, a cloud server or too hard", () => {
    const player = { skills: { hacking: 20, intelligence: 0 }, mults: MULTS };
    const servers: StaticSnapshotData = {
      servers: [
        staticServer("home", { purchasedByPlayer: true }),
        staticServer("pserv-0", { purchasedByPlayer: true }),
        staticServer("n00dles", N00DLES),
        staticServer("broke", { moneyMax: 0 }),
        // Needing more hacking than the player has, though a hack's chance isn't 0 yet (1.75 x 20 is over 30).
        staticServer("hard", { requiredHackingSkill: 30 }),
        staticServer("locked"),
      ],
    };
    const data = medium(20, { home: true, "pserv-0": true, n00dles: true, broke: true, hard: true, locked: false });
    expect(batcherTargetsOf(servers, data, player).map((each) => each.hostname)).toEqual(["n00dles"]);
  });
});

describe("batcherOutOfStep (#206)", () => {
  const point = (atMs: number, runName: string, desyncs: number, late = 0, lost = 0) => ({
    receivedAtMs: atMs,
    health: { ...newBatcherHealth("n00dles", runName, atMs), desyncs, late, lost },
  });

  test("a rise in the newest run's desyncs, late or lost over the snapshots, since the first that showed it", () => {
    expect(batcherOutOfStep([point(5, "a", 2, 1), point(4, "a", 1, 1), point(3, "a", 1), point(2, "a", 0)])).toEqual({
      sinceMs: 3,
      target: "n00dles",
      desyncs: 2,
      late: 1,
      lost: 0,
    });
  });

  test("none: no rise over them, another run's before it, nothing to read", () => {
    expect(batcherOutOfStep([point(5, "a", 1), point(4, "a", 1)])).toBeNull();
    // Run b started from 0 after run a's desync: b's in step.
    expect(batcherOutOfStep([point(5, "b", 0), point(4, "a", 3), point(3, "a", 0)])).toBeNull();
    // Run b's two desyncs came before these snapshots; run a's counts before it are another run's, not a rise.
    expect(batcherOutOfStep([point(5, "b", 2), point(4, "b", 2), point(3, "a", 0)])).toBeNull();
    expect(batcherOutOfStep([])).toBeNull();
    expect(batcherOutOfStep([{ receivedAtMs: 1, health: "junk" }])).toBeNull();
  });
});

describe("whoHacked (#206)", () => {
  test("the batcher, its states and targets, as its health says; or the hack loop", () => {
    const health = { ...newBatcherHealth("n00dles", "a", 0), state: "batching" };
    expect(
      whoHacked([
        { atMs: 1, health },
        { atMs: 2, health: null },
      ]),
    ).toBe("the batcher, batching on n00dles (its health in 1 of 2 fast snapshots)");
    expect(whoHacked([{ atMs: 1, health: null }])).toBe("the hack loop (no batcher health in the 1 fast snapshot)");
  });
});

describe("the run report's section, out of step (#206)", () => {
  test("late or lost alone fails the run too", () => {
    const failures: string[] = [];
    const batching = { ...newBatcherHealth("n00dles", "a", 0), state: "batching" };
    batcherSection(
      [
        { atMs: 0, health: batching },
        { atMs: 60_000, health: { ...batching, late: 1 } },
        { atMs: 120_000, health: { ...batching, late: 1, lost: 2 } },
      ],
      failures,
    );
    // When the first was seen, not the last.
    expect(failures).toEqual([
      "batcher out of step: 0 desyncs (0 out of order, 0 out of bounds), 1 late, 2 lost on n00dles, the first seen " +
        "at 1970-01-01T00:01:00.000Z; no page stall, or delivery lag the page was behind, before it",
    ]);
  });
});

describe("the run report's section, out of step after a clock step or page stall (#241, owner decision 55)", () => {
  // Run #3's shape (2026-11-05): Windows stepped the clock +2,678 ms; section 4's clock step from 17:11:47.8 (the
  // game's clock) to 17:12:12.478 (the brain's); 1,615 desyncs on the-hub from 17:12:14.478 (16 late, 24 lost),
  // recovering, preparing, and batching again at 17:13:49.478, 95 s later; nothing since.
  const T0 = Date.parse("2026-11-05T17:00:00Z");
  const at = (offsetMs: number) => T0 + offsetMs;
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
  const WEAKEN_MS = 477_000;
  const STEP: ClockIncident = {
    kind: "clockStep",
    fromMs: at(707_800),
    toMs: at(732_478),
    sizeMs: 2_678,
    detail: "the game's clock +2.7 s …, the brain's +2.7 s …",
  };
  const STALL: ClockIncident = { ...STEP, kind: "pageStall", sizeMs: 3_000, detail: "…" };
  type State = "batching" | "recovering" | "preparing";
  // Run #3's batcher was before #251, timed on the wall clock: its health says no clock.
  const health = (state: State, changes = {}, target = "the-hub", runName = "r1") => ({
    ...newBatcherHealth(target, runName, 0),
    clock: undefined,
    state,
    batchesStarted: 900,
    ...changes,
  });
  const OUT = { desyncs: 1615, outOfOrder: 1615, late: 16, lost: 24 };
  type Point = { atMs: number; health: unknown };
  /** The run: in step to 17:12, the step's desyncs, then batching again at `recoveredMs` and looked at to `lastMs`. */
  const run = ({ recoveredMs = 829_478, lastMs = 1_500_000, after = [] as Point[] } = {}): Point[] => [
    { atMs: at(700_000), health: health("batching") },
    { atMs: at(734_478), health: health("recovering", { desyncs: 1000, outOfOrder: 1000 }) },
    { atMs: at(760_000), health: health("recovering", OUT) },
    { atMs: at(800_000), health: health("preparing", OUT) },
    ...(recoveredMs <= lastMs ? [{ atMs: at(recoveredMs), health: health("batching", OUT) }] : []),
    ...after,
    { atMs: at(lastMs), health: health(recoveredMs <= lastMs ? "batching" : "recovering", OUT) },
  ];
  const section = (points: Point[], incidents: ClockIncident[] = [STEP], weakenMs: number | null = WEAKEN_MS) => {
    const failures: string[] = [];
    const warnings: string[] = [];
    const lines = batcherSection(points, failures, [], [], { incidents, weakenMs: () => weakenMs, warnings });
    return { lines, failures, warnings };
  };
  const COUNTS = "1615 desyncs (1615 out of order, 0 out of bounds), 16 late, 24 lost on the-hub";
  const FIRST = `the first seen at ${iso(734_478)}`;
  const AFTER =
    `after a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)} ` + "(within a weaken there, 7 min 57 s)";
  const RECOVERED = `recovered in 1 min 35 s: batching again at ${iso(829_478)}`;

  test("run #3: put down to the clock step, batching again and in step 10 minutes: a warning naming it", () => {
    const { lines, failures, warnings } = section(run());
    const warning =
      `batcher out of step after a clock step: ${COUNTS}, ${FIRST}, ${AFTER}; ${RECOVERED}, and nothing out of step ` +
      "in the 10 min after";
    expect(warnings).toEqual([warning]);
    expect(failures).toEqual([]);
    expect(lines).toContain(`  ${warning}`);
    expect(lines).toContain("  desyncs: 1615 (1615 out of order, 0 out of bounds)");
  });

  test("a batcher on the monotonic clock (#251): a clock step can't put it out of step, so it fails, unexplained; a page stall still explains it", () => {
    const monotonic = (points: Point[]) =>
      points.map((point) => ({ ...point, health: { ...(point.health as object), clock: "monotonic" } }));
    const stepped = section(monotonic(run()), [STEP]);
    expect(stepped.warnings).toEqual([]);
    expect(stepped.failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no page stall, or delivery lag the page was behind, before it (a clock step can't put a ` +
        "batcher on the page's monotonic clock out of step, #251)",
    ]);
    // A page stall within a weaken before it, the step beside it: the stall's.
    const stall = { ...STALL, fromMs: at(600_000), toMs: at(605_000) };
    expect(section(monotonic(run()), [stall, STEP]).warnings).toEqual([
      `batcher out of step after a page stall: ${COUNTS}, ${FIRST}, after a page stall of ~3.0 s from ` +
        `${iso(600_000)} to ${iso(605_000)} (within a weaken there, 7 min 57 s); ${RECOVERED}, and nothing out of ` +
        "step in the 10 min after",
    ]);
    // An older batcher's health, with no clock, keeps the step's warning.
    expect(section(run(), [STEP]).warnings).toHaveLength(1);
  });

  test("a desync an incident explains, grows short before it: a cause beside it, maybe its cause instead (#315)", () => {
    const short = run().map((point, index) =>
      index === 1 || index === 2
        ? {
            ...point,
            health: {
              ...(point.health as object),
              moneyLooksBelowFull: 5,
              leastMoneyAfterGrow: 0.9,
              leastMoneyAfterGrowOn: "the-hub",
            },
          }
        : index > 2
          ? { ...point, health: { ...(point.health as object), moneyLooksBelowFull: 5 } }
          : point,
    );
    const [warning] = section(short).warnings;
    expect(warning).toContain(
      `${AFTER}; a grow shortfall before it too, which may be its cause instead, the money below ` +
        `full after 5 grows from ${iso(734_478)}, the least 90.0% of the-hub's maximum`,
    );
  });

  test("of two incidents within a weaken before the first desync, the latest", () => {
    const earlier = { ...STALL, fromMs: at(600_000), toMs: at(605_000) };
    expect(section(run(), [earlier, STEP]).warnings).toEqual([
      `batcher out of step after a clock step: ${COUNTS}, ${FIRST}, ${AFTER}; ${RECOVERED}, and nothing out of step ` +
        "in the 10 min after",
    ]);
  });

  test("a page stall the same", () => {
    expect(section(run(), [STALL]).warnings).toEqual([
      `batcher out of step after a page stall: ${COUNTS}, ${FIRST}, after a page stall of ~3.0 s from ` +
        `${iso(707_800)} to ${iso(732_478)} (within a weaken there, 7 min 57 s); ${RECOVERED}, and nothing out of ` +
        "step in the 10 min after",
    ]);
  });

  test("a delivery lag (#309) the page was behind explains a stretch as a page stall does; one it wasn't, or can't tell, doesn't", () => {
    const monotonic = (points: Point[]) =>
      points.map((point) => ({ ...point, health: { ...(point.health as object), clock: "monotonic" } }));
    const lag: ClockIncident = {
      kind: "deliveryLag",
      fromMs: at(700_000),
      toMs: at(800_000),
      sizeMs: 632,
      detail: "…",
      pageLagMs: 600,
    };
    // The Agent's send stamps show it 0.6 s late sending: the page held, so its batcher too.
    const within =
      `after a delivery lag of up to 0.6 s from ${iso(700_000)} to ${iso(800_000)} (within a weaken there, ` +
      "7 min 57 s)";
    expect(section(monotonic(run()), [lag]).warnings).toEqual([
      `batcher out of step after a delivery lag: ${COUNTS}, ${FIRST}, ${within}; ${RECOVERED}, and nothing out of ` +
        "step in the 10 min after",
    ]);
    const lagText = `a delivery lag of up to 0.6 s from ${iso(700_000)} to ${iso(800_000)}`;
    // The Agent sent on time (its share 1 ms): the socket's or the brain's lag, which can't hold the page's batcher.
    const brains = { ...lag, pageLagMs: 1 };
    const notPage = ` (${lagText} was the socket's or the brain's, the page sending on time: no excuse, #309)`;
    expect(section(monotonic(run()), [brains])).toMatchObject({
      warnings: [],
      failures: [
        `batcher out of step: ${COUNTS}, ${FIRST}; no page stall, or delivery lag the page was behind, before it${notPage}`,
      ],
    });
    expect(section(run(), [brains]).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no clock step, page stall, or delivery lag the page was behind, before it${notPage}`,
    ]);
    // 2026-11-08's: the clarkinc desyncs began inside a backlog from an Agent before #309, whose side is unknown: no
    // excuse (P1 of #314's review: every such lag seen was the brain's). They stay a failure; their cause is #315.
    const unknown = { ...lag, pageLagMs: null };
    expect(section(monotonic(run()), [unknown])).toMatchObject({
      warnings: [],
      failures: [
        `batcher out of step: ${COUNTS}, ${FIRST}; no page stall, or delivery lag the page was behind, before it (${lagText}, its side ` +
          "unknown, no send stamps showing the page behind it: no excuse, #309)",
      ],
    });
    // One that ended more than a weaken before the first look isn't named.
    const longBefore = { ...brains, fromMs: at(100_000), toMs: at(200_000) };
    expect(section(monotonic(run()), [longBefore]).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no page stall, or delivery lag the page was behind, before it`,
    ]);
    // Nor with a weaken's time unknown there.
    expect(section(monotonic(run()), [brains], null).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no page stall, or delivery lag the page was behind, before it`,
    ]);
  });

  test("no incident, none within a weaken before the first desync, or one after it: a failure, as before", () => {
    expect(section(run(), []).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no clock step, page stall, or delivery lag the page was behind, before it`,
    ]);
    expect(section(run(), [STEP], 1_000).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no clock step, page stall, or delivery lag the page was behind, within a weaken there ` +
        `(1 s) before it (the last, a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)})`,
    ]);
    const later = { ...STEP, fromMs: at(734_479), toMs: at(740_000) };
    expect(section(run(), [later]).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; no clock step, page stall, or delivery lag the page was behind, before it`,
    ]);
  });

  test("an incident, but a weaken's time there unknown: a failure, never a guess", () => {
    expect(section(run(), [STEP], null).failures).toEqual([
      `batcher out of step: ${COUNTS}, ${FIRST}; a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)} ` +
        "before it, but a weaken's time on the-hub is unknown (no static snapshot with its figures, or no medium " +
        "snapshot with the player's)",
    ]);
  });

  test("the first desync seen as the incident ends, or a weaken after it, is the incident's", () => {
    const ending = (toMs: number) => ({ ...STEP, fromMs: at(toMs - 5_000), toMs: at(toMs) });
    expect(section(run(), [ending(734_478)]).warnings).toHaveLength(1);
    expect(section(run(), [ending(734_478 - WEAKEN_MS)]).warnings).toHaveLength(1);
    expect(section(run(), [ending(734_478 - WEAKEN_MS - 1)]).warnings).toEqual([]);
  });

  test("not batching again 10 minutes after the incident: a failure; ending sooner, unconfirmed", () => {
    const tenMinutesOn = 732_478 + 10 * 60_000;
    const failed = section(run({ recoveredMs: Number.POSITIVE_INFINITY, lastMs: tenMinutesOn }));
    expect(failed.warnings).toEqual([]);
    expect(failed.failures).toEqual([
      `batcher out of step after a clock step, not recovered: ${COUNTS}, ${FIRST}, ${AFTER}; not batching again ` +
        `within 10 min of the clock step (its run's last look at ${iso(tenMinutesOn)})`,
    ]);
    expect(section(run({ recoveredMs: Number.POSITIVE_INFINITY, lastMs: tenMinutesOn - 1 })).failures).toEqual([]);
    const { failures, warnings } = section(run({ recoveredMs: Number.POSITIVE_INFINITY, lastMs: 900_000 }));
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      `batcher out of step after a clock step, recovery not yet confirmed: ${COUNTS}, ${FIRST}, ${AFTER}; not ` +
        `batching again at its run's last look, at ${iso(900_000)}, 2 min 48 s after the clock step (10 min allowed)`,
    ]);
  });

  test("batching again only more than 10 minutes after the incident: a failure", () => {
    const tenMinutesOn = 732_478 + 10 * 60_000;
    expect(section(run({ recoveredMs: tenMinutesOn, lastMs: 2_400_000 })).warnings).toHaveLength(1);
    const { failures } = section(run({ recoveredMs: tenMinutesOn + 1, lastMs: 2_400_000 }));
    expect(failures).toEqual([
      `batcher out of step after a clock step, not recovered: ${COUNTS}, ${FIRST}, ${AFTER}; batching again only at ` +
        `${iso(tenMinutesOn + 1)}, 10 min after the clock step (more than 10 min)`,
    ]);
  });

  test("out of step again within 10 minutes of batching again, the 10th minute too: a failure, with when", () => {
    const again = (offsetMs: number) => {
      const desynced = health("batching", { ...OUT, desyncs: 1616, outOfBounds: 1 });
      return run({ lastMs: 2_400_000, after: [{ atMs: at(offsetMs), health: desynced }] }).map((point) =>
        point.atMs === at(2_400_000) ? { ...point, health: desynced } : point,
      );
    };
    const { failures, warnings } = section(again(1_000_000));
    expect(warnings).toEqual([]);
    expect(failures).toEqual([
      "batcher out of step after a clock step, not recovered: 1616 desyncs (1615 out of order, 1 out of bounds), " +
        `16 late, 24 lost on the-hub, ${FIRST}, ${AFTER}; out of step again at ${iso(1_000_000)}, 2 min 51 s after ` +
        `batching again at ${iso(829_478)} (within 10 min)`,
    ]);
    expect(section(again(829_478 + 10 * 60_000)).failures[0]).toMatch(/; out of step again at /);
    // A millisecond later, another stretch, judged on its own: no incident left for it.
    const later = section(again(829_478 + 10 * 60_000 + 1));
    expect(later.warnings).toHaveLength(1);
    expect(later.failures).toEqual([
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on the-hub, the first seen at " +
        `${iso(1_429_479)}; no clock step, page stall, or delivery lag the page was behind, within a weaken there (7 min 57 s) before ` +
        `it (the last, a ` +
        `clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)})`,
    ]);
  });

  test("its run's looks ending 10 minutes after batching again: confirmed", () => {
    expect(section(run({ lastMs: 829_478 + 10 * 60_000 })).warnings[0]).toMatch(/, and nothing out of step in the /);
  });

  test("its run's looks ending under 10 minutes after batching again: a warning, recovery not yet confirmed", () => {
    const { failures, warnings } = section(run({ lastMs: 829_478 + 5 * 60_000 }));
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      `batcher out of step after a clock step, recovery not yet confirmed: ${COUNTS}, ${FIRST}, ${AFTER}; ` +
        `${RECOVERED}, but its run's last look, at ${iso(1_129_478)}, is 5 min after (10 min needed)`,
    ]);
  });

  test("judged on its own run's looks: a run replaced mid-recovery, or stopped a minute after, is unconfirmed", () => {
    const next = (offsetMs: number) => ({ atMs: at(offsetMs), health: health("batching", {}, "the-hub", "r2") });
    const replaced = section([
      ...run({ recoveredMs: Number.POSITIVE_INFINITY, lastMs: 800_000 }),
      next(802_000),
      next(2_400_000),
    ]);
    expect(replaced.failures).toEqual([]);
    expect(replaced.warnings).toEqual([
      `batcher out of step after a clock step, recovery not yet confirmed: ${COUNTS}, ${FIRST}, ${AFTER}; not ` +
        `batching again at its run's last look, at ${iso(800_000)}, 1 min 8 s after the clock step (10 min allowed)`,
    ]);
    const stopped = section([...run({ lastMs: 889_478 }), next(890_000), next(2_400_000)]);
    expect(stopped.failures).toEqual([]);
    expect(stopped.warnings).toEqual([
      `batcher out of step after a clock step, recovery not yet confirmed: ${COUNTS}, ${FIRST}, ${AFTER}; ` +
        `${RECOVERED}, but its run's last look, at ${iso(889_478)}, is 1 min after (10 min needed)`,
    ]);
  });

  test("an incident explains the first stretch after it only: a second within its weaken is a failure", () => {
    const longWeaken = 15 * 60_000;
    const second = health("batching", { ...OUT, desyncs: 1616, outOfBounds: 1 });
    const points = [
      ...run({ lastMs: 1_431_478 }),
      { atMs: at(1_431_479), health: second },
      { atMs: at(2_400_000), health: second },
    ];
    const { failures, warnings } = section(points, [STEP], longWeaken);
    expect(warnings).toHaveLength(1);
    expect(failures).toEqual([
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on the-hub, the first seen at " +
        `${iso(1_431_479)}; a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)} within a weaken there ` +
        "(15 min) before it, but an earlier stretch was put down to it",
    ]);
  });

  test("late or lost alone, never leaving batching: batching again once the parts in flight land, any weaken", () => {
    const longWeaken = 15 * 60_000;
    const batching = (changes = {}, target = "the-hub") => health("batching", changes, target);
    const points = [
      { atMs: at(700_000), health: batching() },
      { atMs: at(734_478), health: batching({ late: 2 }) },
      { atMs: at(736_478), health: batching({ late: 2 }) },
      // Lost 10 s after its landing: a part in flight at the step, still the stretch's.
      { atMs: at(746_478), health: batching({ late: 2, lost: 1 }) },
      { atMs: at(748_478), health: batching({ late: 2, lost: 1 }) },
      { atMs: at(2_400_000), health: batching({ late: 2, lost: 1 }) },
    ];
    const { failures, warnings } = section(points, [STEP], longWeaken);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      "batcher out of step after a clock step: 0 desyncs (0 out of order, 0 out of bounds), 2 late, 1 lost on " +
        `the-hub, ${FIRST}, after a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)} (within a weaken ` +
        `there, 15 min); recovered in 14 s: batching again at ${iso(748_478)}, and nothing out of step in the 10 min ` +
        "after",
    ]);
  });

  test("a part found lost 10 s after the last landing a weaken could bring is still the stretch's", () => {
    const lostAtMs = 732_478 + WEAKEN_MS + 5_000;
    const points = [
      { atMs: at(700_000), health: health("batching") },
      { atMs: at(734_478), health: health("batching", { late: 1 }) },
      { atMs: at(736_478), health: health("batching", { late: 1 }) },
      { atMs: at(lostAtMs), health: health("batching", { late: 1, lost: 1 }) },
      { atMs: at(lostAtMs + 2_000), health: health("batching", { late: 1, lost: 1 }) },
      { atMs: at(2_400_000), health: health("batching", { late: 1, lost: 1 }) },
    ];
    const { failures, warnings } = section(points);
    expect(failures).toEqual([]);
    expect(warnings[0]).toMatch(/1 late, 1 lost on the-hub, .*; recovered in 8 min 2 s: batching again at /);
  });

  test("a move (preparing a new target) is no recovery: batching again is on the new target, after it", () => {
    const points = [
      { atMs: at(700_000), health: health("batching") },
      { atMs: at(734_478), health: health("batching", { late: 1 }) },
      { atMs: at(736_478), health: health("preparing", { late: 1 }, "joesguns") },
      { atMs: at(738_478), health: health("batching", { late: 1 }, "joesguns") },
      { atMs: at(2_400_000), health: health("batching", { late: 1 }, "joesguns") },
    ];
    expect(section(points).warnings[0]).toMatch(/; recovered in 4 s: batching again at /);
  });

  test("put down to the game's clock moving, when the brain's moved later: recovery from the game's", () => {
    const brainLater: ClockIncident = {
      ...STEP,
      toMs: at(972_478),
      gameClock: { fromMs: at(707_800), toMs: at(709_800) },
    };
    const inTime = section(run({ recoveredMs: 709_800 + 10 * 60_000, lastMs: 2_400_000 }), [brainLater]);
    expect(inTime.warnings).toHaveLength(1);
    const late = section(run({ recoveredMs: 709_800 + 10 * 60_000 + 1, lastMs: 2_400_000 }), [brainLater]);
    expect(late.failures[0]).toMatch(/; batching again only at \S+, 10 min after the clock step \(more than 10 min\)$/);
    // From the game's move's start: a first desync before it isn't its.
    expect(section(run(), [{ ...brainLater, gameClock: { fromMs: at(734_479), toMs: at(736_000) } }]).warnings).toEqual(
      [],
    );
  });

  test("late or lost alone, a part still landing over 10 minutes after the incident: out of step again, a failure", () => {
    const longWeaken = 15 * 60_000;
    const lateAgainMs = 732_478 + 12 * 60_000;
    const points = [
      { atMs: at(700_000), health: health("batching") },
      { atMs: at(734_478), health: health("batching", { late: 1 }) },
      { atMs: at(736_478), health: health("batching", { late: 1 }) },
      { atMs: at(lateAgainMs), health: health("batching", { late: 2 }) },
      { atMs: at(lateAgainMs + 2_000), health: health("batching", { late: 2 }) },
      { atMs: at(2_400_000), health: health("batching", { late: 2 }) },
    ];
    const { failures, warnings } = section(points, [STEP], longWeaken);
    expect(warnings).toEqual([]);
    expect(failures).toEqual([
      "batcher out of step after a clock step, not recovered: 0 desyncs (0 out of order, 0 out of bounds), 2 late, 0 " +
        `lost on the-hub, ${FIRST}, after a clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)} (within a ` +
        `weaken there, 15 min); out of step again at ${iso(lateAgainMs)}, 12 min after the clock step, after batching ` +
        `again at ${iso(736_478)} (more than 10 min after it)`,
    ]);
  });

  test("a move (preparing a new target) is no recovery: a part lost after it is still the stretch's", () => {
    const points = [
      { atMs: at(700_000), health: health("batching") },
      { atMs: at(734_478), health: health("batching", { late: 1 }) },
      { atMs: at(736_478), health: health("preparing", { late: 1 }, "joesguns") },
      { atMs: at(738_478), health: health("batching", { late: 1 }, "joesguns") },
      { atMs: at(744_478), health: health("batching", { late: 1, lost: 1 }, "joesguns") },
      { atMs: at(746_478), health: health("batching", { late: 1, lost: 1 }, "joesguns") },
      { atMs: at(2_400_000), health: health("batching", { late: 1, lost: 1 }, "joesguns") },
    ];
    const { failures, warnings } = section(points);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([
      "batcher out of step after a clock step: 0 desyncs (0 out of order, 0 out of bounds), 1 late, 1 lost on " +
        `the-hub, ${FIRST}, ${AFTER}; recovered in 12 s: batching again at ${iso(746_478)}, and nothing out of step ` +
        "in the 10 min after",
    ]);
  });

  test("stretches put down to no incident: one failure with their totals, each listed under it", () => {
    const desynced = (desyncs: number) => health("recovering", { desyncs, outOfBounds: desyncs }, "n00dles");
    const points = [
      { atMs: at(0), health: health("batching", {}, "n00dles") },
      { atMs: at(60_000), health: desynced(1) },
      { atMs: at(120_000), health: health("batching", { desyncs: 1, outOfBounds: 1 }, "n00dles") },
      { atMs: at(1_000_000), health: desynced(3) },
    ];
    const { lines, failures } = section(points, []);
    const failure =
      "batcher out of step: 3 desyncs (0 out of order, 3 out of bounds), 0 late, 0 lost in 2 stretches on n00dles, " +
      `the first seen at ${iso(60_000)}; the first: no clock step, page stall, or delivery lag the page was behind, before it`;
    expect(failures).toEqual([failure]);
    const at0 = lines.indexOf(`  ${failure}`);
    expect(lines.slice(at0 + 1, at0 + 3)).toEqual([
      "    1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on n00dles, the first seen at " +
        `${iso(60_000)}; no clock step, page stall, or delivery lag the page was behind, before it`,
      "    2 desyncs (0 out of order, 2 out of bounds), 0 late, 0 lost on n00dles, the first seen at " +
        `${iso(1_000_000)}; no clock step, page stall, or delivery lag the page was behind, before it`,
    ]);
  });

  test("two runs, one put down to the step and one not: a warning and a failure", () => {
    const other = (changes = {}) => health("batching", changes, "n00dles", "r2");
    const points = [
      ...run(),
      { atMs: at(1_600_000), health: other() },
      { atMs: at(2_400_000), health: other({ desyncs: 1, outOfBounds: 1, state: "recovering" }) },
    ];
    const { failures, warnings } = section(points);
    expect(warnings).toHaveLength(1);
    expect(failures).toEqual([
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost on n00dles, the first seen at " +
        `${iso(2_400_000)}; no clock step, page stall, or delivery lag the page was behind, within a weaken there (7 min 57 s) before ` +
        `it (the last, a ` +
        `clock step of +2.7 s from ${iso(707_800)} to ${iso(732_478)})`,
    ]);
  });
});

describe("the controller's target (#206)", () => {
  test("the target the batcher reports batching earns at once, so it's kept where a target only sent would move", () => {
    // n00dles batched: just hacked, its medium snapshot shows it short of its money. A prepared rich, worth a move from
    // n00dles counted as unprepared, but not from n00dles batched.
    const at = (richMoney: number) => {
      const network: StaticSnapshotData = {
        servers: [staticServer("n00dles", N00DLES), staticServer("rich", { ...RICH, moneyMax: richMoney })],
      };
      const data = choiceMedium(richMoney, RICH.minDifficulty);
      data.servers = data.servers.map((server) =>
        server.hostname === "n00dles" ? { ...server, moneyAvailable: N00DLES.moneyMax / 2 } : server,
      );
      return { network, data };
    };
    const hosts = (data: MediumSnapshotData, network: StaticSnapshotData) => chooseHackHosts(network, data);
    const choice = (richMoney: number, batching: string | null) => {
      const { network, data } = at(richMoney);
      const sent = planBatcher(network, data, BN1_HACKING, "n00dles", hosts(data, network)).batcher;
      const chosen = chooseBatcher(network, data, BN1_HACKING, hosts(data, network), sent, batching);
      return chosen.batcher?.config.target;
    };
    const richMoney = [40, 50, 60, 70, 80, 90, 100]
      .map((millions) => millions * 1_000_000)
      .find((money) => choice(money, "n00dles") === "n00dles" && choice(money, null) === "rich");
    expect(richMoney).toBeDefined();
    const { network, data } = at(richMoney as number);

    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    const agent = connectedAgent(channel);
    agent.send("static", network);
    // First n00dles alone is there to batch: rich not yet rooted.
    agent.send("medium", {
      ...data,
      servers: data.servers.map((server) =>
        server.hostname === "rich" ? { ...server, hasAdminRights: false } : server,
      ),
    });
    expect(agent.lastSent()?.batcher?.config.target).toBe("n00dles");
    const fast = (state: "batching" | "preparing" | "recovering") => ({
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [],
      dialogs: { handled: [], blocking: null },
      batcher: { ...newBatcherHealth("n00dles", "r1", 5), state },
    });
    agent.send("fast", fast("batching"));
    agent.send("medium", data);
    expect(controller.batcherView().sent?.target).toBe("n00dles");
    // Recovering from a desync (#315): it batches on in place, so n00dles is still the one batched, never a hop away
    // (on 2026-11-08 clarkinc, recovering, read as nothing batched, sent it to rho-construction and back).
    agent.send("fast", fast("recovering"));
    agent.send("medium", data);
    expect(controller.batcherView().sent?.target).toBe("n00dles");
    // Not batching (still preparing n00dles): rich, prepared, is worth the move.
    agent.send("fast", fast("preparing"));
    agent.send("medium", data);
    expect(controller.batcherView().sent?.target).toBe("rich");
  });
});

describe("chooseBatcher, review fixes (#216)", () => {
  const network = (richMoney: number): StaticSnapshotData => ({
    servers: [staticServer("n00dles", N00DLES), staticServer("rich", { ...RICH, moneyMax: richMoney })],
  });
  const chosenOf = (
    staticData: StaticSnapshotData,
    data: MediumSnapshotData,
    sent: string | null,
    batching: string | null,
  ) => {
    const current = sent === null ? null : planBatcher(staticData, data, BN1_HACKING, sent, CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, CHOICE_HOSTS, current, batching);
    if (chosen.batcher === null) throw new Error(chosen.why);
    return chosen;
  };
  const worthOf = (chosen: { worths: BatcherTargetWorth[] }, target: string) =>
    chosen.worths.find((each) => each.target === target) as BatcherTargetWorth;

  test("never long without income: with nothing batched, a target past BATCHER_MOST_IDLE_MS waits as the next", () => {
    // Rich, half grown at three times its minimum: worth more over the horizon than n00dles, but a first wave at that
    // security takes longer than the brain may go without income. Nothing batched: a fresh start, a handover.
    const data = choiceMedium(RICH.moneyMax / 2, 3 * RICH.minDifficulty);
    const chosen = chosenOf(choiceNetwork, data, null, null);
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    expect(rich.worth).toBeGreaterThan(n00dles.worth);
    expect(rich.untilEarningMs).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    expect(n00dles.untilEarningMs).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next?.target).toBe("rich");
    // Rich sent and still preparing, far off: not kept for its worth while n00dles earns soon.
    expect(chosenOf(choiceNetwork, data, "rich", null).batcher.config.target).toBe("n00dles");
  });

  test("with none earning soon and nothing batched, the soonest; sent and still preparing, kept only if soon", () => {
    const data = choiceMedium(0, 15);
    data.servers = data.servers.map((server) =>
      server.hostname === "n00dles" ? { ...server, moneyAvailable: 0, hackDifficulty: 1 } : server,
    );
    const chosen = chosenOf(choiceNetwork, data, "rich", null);
    const soonest = [...chosen.worths].sort((a, b) => a.untilEarningMs - b.untilEarningMs)[0];
    expect(chosen.batcher.config.target).toBe(soonest?.target);
  });

  test("a next prepared but not worth the move isn't kept as the next: its RAM goes back to the batches", () => {
    // Rich prepared, earning more than n00dles batched but not BATCHER_MOVE_GAIN times its worth over the horizon.
    const staticData = network(70_000_000);
    const data = choiceMedium(70_000_000, RICH.minDifficulty);
    const chosen = chosenOf(staticData, data, "n00dles", "n00dles");
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    expect(rich.incomePerSecond).toBeGreaterThanOrEqual(n00dles.incomePerSecond * BATCHER_MOVE_GAIN);
    expect(rich.worth).toBeLessThan(n00dles.worth * BATCHER_MOVE_GAIN);
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next).toBeUndefined();
    // And the batches have all the RAM.
    expect(chosen.batcher.config.spacingMs).toBe(
      planBatcher(staticData, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher?.config.spacingMs,
    );
  });

  test("a target is prepared on the RAM the batched target's batches leave: longer than on all of it", () => {
    const data = choiceMedium(RICH.moneyMax / 50, 3 * RICH.minDifficulty);
    const alone = worthOf(chosenOf(choiceNetwork, data, null, null), "rich");
    const beside = worthOf(chosenOf(choiceNetwork, data, "n00dles", "n00dles"), "rich");
    expect(beside.untilEarningMs).toBeGreaterThan(alone.untilEarningMs);
  });
});

describe("chooseBatcher, a target move (#236)", () => {
  const chosenOf = (
    staticData: StaticSnapshotData,
    data: MediumSnapshotData,
    current: ReturnType<typeof planBatcher>["batcher"],
    batching: string | null,
  ) => {
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, CHOICE_HOSTS, current ?? null, batching);
    if (chosen.batcher === null) throw new Error(chosen.why);
    return chosen;
  };
  const worthOf = (chosen: { worths: BatcherTargetWorth[] }, target: string) =>
    chosen.worths.find((each) => each.target === target) as BatcherTargetWorth;

  test("while a target earns, a move goes only to one prepared; one still to prepare is the next, moved to when ready", () => {
    // Rich (an easier one) nearly grown, at its minimum: a wave beside n00dles' batches, then a weaken, within
    // BATCHER_MOST_IDLE_MS, and worth the move. Before #236 the brain moved at once, and nothing new was batched while
    // it was prepared.
    const easier = { ...RICH, requiredHackingSkill: 20 };
    const network: StaticSnapshotData = { servers: [staticServer("n00dles", N00DLES), staticServer("rich", easier)] };
    const data = choiceMedium(RICH.moneyMax * 0.98, RICH.minDifficulty);
    const n00dlesSent = planBatcher(network, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(network, data, n00dlesSent, "n00dles");
    const rich = worthOf(chosen, "rich");
    expect(rich.untilEarningMs).toBeGreaterThan(operationTimeMs("weaken1", easier, PLAYER_100));
    expect(rich.untilEarningMs).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    expect(rich.worth).toBeGreaterThanOrEqual(worthOf(chosen, "n00dles").worth * BATCHER_MOVE_GAIN);
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next?.target).toBe("rich");
    // Prepared: the move, its first batch a weaken away.
    const prepared = choiceMedium(RICH.moneyMax, RICH.minDifficulty);
    expect(chosenOf(network, prepared, chosen.batcher, "n00dles").batcher.config.target).toBe("rich");
    // With nothing batched (a fresh start, a handover, a move under way), the soon one, still to prepare, as before.
    expect(chosenOf(network, data, null, null).batcher.config.target).toBe("rich");
  });

  test("the next target is kept unless another is worth BATCHER_MOVE_GAIN times it once prepared: its waves out", () => {
    // Two rich targets half grown, at three times their minimum: each the next, by its worth once prepared.
    const rival = (moneyMax: number): StaticSnapshotData => ({
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("rich", RICH),
        staticServer("rival", { ...RICH, moneyMax }),
      ],
    });
    const at = (staticData: StaticSnapshotData) => {
      const data = choiceMedium(RICH.moneyMax / 2, 3 * RICH.minDifficulty);
      const rich = data.servers.find((server) => server.hostname === "rich");
      const rivalMax = Number(staticData.servers.find((server) => server.hostname === "rival")?.moneyMax);
      data.servers.push({ ...rich, hostname: "rival", moneyAvailable: rivalMax / 2 } as (typeof data.servers)[number]);
      const preparedWorth = (target: string) => {
        const plan = planBatcher(staticData, data, BN1_HACKING, target, CHOICE_HOSTS);
        const figures = staticData.servers.find((server) => server.hostname === target) as unknown as typeof RICH;
        const weakenMs = operationTimeMs("weaken1", figures, PLAYER_100);
        return plan.batcher === null ? 0 : plan.incomePerSecond * (BATCHER_TARGET_HORIZON_MS - weakenMs);
      };
      return { data, preparedWorth };
    };
    // The rival a little richer: worth more once prepared, but not BATCHER_MOVE_GAIN times rich, the next sent.
    const close = rival(RICH.moneyMax * 1.1);
    const { data, preparedWorth } = at(close);
    expect(preparedWorth("rival")).toBeGreaterThan(preparedWorth("rich"));
    expect(preparedWorth("rival")).toBeLessThan(preparedWorth("rich") * BATCHER_MOVE_GAIN);
    const fresh = chosenOf(
      close,
      data,
      planBatcher(close, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher,
      "n00dles",
    );
    expect(fresh.batcher.config.next?.target).toBe("rival");
    const sent = fresh.batcher;
    const richNext = {
      ...sent,
      config: { ...sent.config, next: { ...sent.config.next, target: "rich", figures: RICH } },
    };
    const kept = chosenOf(close, data, richNext as typeof sent, "n00dles");
    expect(kept.batcher.config.next?.target).toBe("rich");
    // Far richer: worth the waste, so it's the next.
    const far = rival(RICH.moneyMax * 3);
    const farAt = at(far);
    expect(farAt.preparedWorth("rival")).toBeGreaterThanOrEqual(farAt.preparedWorth("rich") * BATCHER_MOVE_GAIN);
    expect(chosenOf(far, farAt.data, richNext as typeof sent, "n00dles").batcher.config.next?.target).toBe("rival");
  });

  test("the next is prepared on the RAM the batches leave, a fifth at least (#237's review): a slow grower has a path", () => {
    // Two 256 TB hosts, late in a cycle: n00dles' batches leave most of them idle. A slow grower with no money at its
    // minimum security of 30 is prepared within the horizon on what they leave, but not on a fifth. Before, it was
    // never the next, and never moved to.
    const slow = { moneyMax: 1e12, minDifficulty: 30, requiredHackingSkill: 1, serverGrowth: 1 };
    const network: StaticSnapshotData = { servers: [staticServer("n00dles", N00DLES), staticServer("slow", slow)] };
    const data = choiceMedium(0, 1);
    data.servers = data.servers.map((server) =>
      server.hostname === "rich"
        ? { ...server, hostname: "slow", moneyAvailable: 0, hackDifficulty: 30 }
        : server.hostname.startsWith("pserv-")
          ? { ...server, maxRam: 262_144 }
          : server,
    );
    const sent = planBatcher(network, data, BN1_HACKING, "n00dles", CHOICE_HOSTS);
    const whole = planBatcher(network, data, BN1_HACKING, "slow", CHOICE_HOSTS);
    if (sent.batcher === null || whole.batcher === null) throw new Error("no plan");
    const leftGb = whole.ramGb - sent.peakRamGb;
    const now = { money: 0, security: 30 };
    expect(leftGb).toBeGreaterThan(whole.ramGb * BATCHER_NEXT_RAM_SHARE);
    expect(preparationTimeMs(slow, PLAYER_100, now, whole.ramGb * BATCHER_NEXT_RAM_SHARE)).toBeGreaterThan(
      BATCHER_TARGET_HORIZON_MS,
    );
    expect(preparationTimeMs(slow, PLAYER_100, now, leftGb)).toBeLessThanOrEqual(BATCHER_TARGET_HORIZON_MS);
    const chosen = chosenOf(network, data, sent.batcher, "n00dles");
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next).toMatchObject({ target: "slow", figures: slow });
    expect(chosen.batcher.config.next?.ramGb).toBeCloseTo(leftGb, 3);
    // The batches planned on the rest: n00dles' own plan, which that RAM holds.
    expect(chosen.batcher.config.spacingMs).toBe(sent.batcher.config.spacingMs);
    expect(chosen.batcher.config.hackShare).toBe(sent.batcher.config.hackShare);
    // Nothing batched yet (#237's re-review: a fresh start, after an install or a restart, a move under way): n00dles
    // still to start, so no leftover is known; the next is weighed on a fifth, and n00dles' own preparation keeps the
    // rest. On a fifth it isn't prepared within BATCHER_TARGET_HORIZON_MS, but it is within BATCHER_NEXT_HORIZON_MS
    // (#274): the next, on a fifth.
    const starting = chosenOf(network, data, null, null);
    expect(starting.batcher.config.target).toBe("n00dles");
    expect(starting.batcher.config.next).toMatchObject({ target: "slow" });
    expect(starting.batcher.config.next?.ramGb).toBeCloseTo(whole.ramGb * BATCHER_NEXT_RAM_SHARE, 3);
  });

  test("a prepared target whose weaken is over BATCHER_MOST_IDLE_MS (#237's review): its idle is the weaken past the batches'", () => {
    // Rich prepared, at a level where its weaken takes over 5 minutes; n00dles batched lands its batches for a weaken
    // of its own meanwhile, so the move leaves the difference without a hack.
    const player = 50;
    const slowWeaken = { ...RICH, moneyMax: 100_000_000_000, minDifficulty: 11 };
    const network: StaticSnapshotData = {
      servers: [staticServer("n00dles", N00DLES), staticServer("rich", slowWeaken)],
    };
    const data = choiceMedium(slowWeaken.moneyMax, slowWeaken.minDifficulty);
    data.player = { ...data.player, skills: { hacking: player, intelligence: 0 } };
    const at50 = { skills: { hacking: player, intelligence: 0 }, mults: MULTS };
    const richWeakenMs = operationTimeMs("weaken1", slowWeaken, at50);
    const n00dlesWeakenMs = operationTimeMs("weaken1", N00DLES, at50);
    expect(richWeakenMs).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    expect(richWeakenMs - n00dlesWeakenMs).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    const sent = planBatcher(network, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(network, data, sent, "n00dles");
    expect(worthOf(chosen, "rich").worth).toBeGreaterThanOrEqual(worthOf(chosen, "n00dles").worth * BATCHER_MOVE_GAIN);
    expect(chosen.batcher.config.target).toBe("rich");
  });
});

describe("chooseBatcher, off a poor target (#274)", () => {
  // BN1.3's exit run at 23:00, synthetic: hacking 1,327 and 424 TB of cloud servers, n00dles batched, the richest
  // targets at 3 times their minimum security after the install, each a weaken there past BATCHER_TARGET_HORIZON_MS,
  // and rho-construction prepared. The game's figures (servers.ts), money 25 times the initial (Server.ts:76), the
  // minimum a third of the base (:83). Before #274 the brain weighed the 5 best by A1's ceiling alone, none of which
  // could be moved to (none prepared) or be the next (none prepared within the horizon): n00dles for hours.
  const player = {
    skills: { hacking: 1327, intelligence: 0 },
    mults: { hacking_chance: 1.6, hacking_speed: 2.3, hacking_money: 2, hacking_grow: 1.6, hacking: 2, hacking_exp: 2 },
  };
  const FIGURES = {
    n00dles: N00DLES,
    phantasy: { moneyMax: 600_000_000, minDifficulty: 7, requiredHackingSkill: 100, serverGrowth: 35 },
    "rho-construction": { moneyMax: 15_000_000_000, minDifficulty: 17, requiredHackingSkill: 500, serverGrowth: 50 },
    "b-and-a": { moneyMax: 500_000_000_000, minDifficulty: 27, requiredHackingSkill: 1050, serverGrowth: 70 },
    "4sigma": { moneyMax: 500_000_000_000, minDifficulty: 22, requiredHackingSkill: 1100, serverGrowth: 90 },
    clarkinc: { moneyMax: 500_000_000_000, minDifficulty: 18, requiredHackingSkill: 1100, serverGrowth: 60 },
    "kuai-gong": { moneyMax: 625_000_000_000, minDifficulty: 32, requiredHackingSkill: 1150, serverGrowth: 90 },
    ecorp: { moneyMax: 1_250_000_000_000, minDifficulty: 33, requiredHackingSkill: 1250, serverGrowth: 99 },
    megacorp: { moneyMax: 1_250_000_000_000, minDifficulty: 33, requiredHackingSkill: 1250, serverGrowth: 99 },
    blade: { moneyMax: 500_000_000_000, minDifficulty: 31, requiredHackingSkill: 1100, serverGrowth: 80 },
  } as const;
  type Name = keyof typeof FIGURES;
  const RICHEST: Name[] = ["b-and-a", "4sigma", "clarkinc", "kuai-gong", "ecorp", "megacorp", "blade"];
  const HOSTS_RAM = { "pserv-0": 262_144, "pserv-1": 131_072, "pserv-2": 32_768, "pserv-3": 8_192 };
  const HOSTS = Object.keys(HOSTS_RAM);
  const staticData: StaticSnapshotData = {
    servers: [
      staticServer("home", { purchasedByPlayer: true, moneyMax: 0 }),
      ...Object.entries(FIGURES).map(([hostname, figures]) => staticServer(hostname, figures)),
    ],
  };
  /** The snapshot at 23:00: those named prepared, the rest as the install left them (3 times the minimum, 4% money). */
  function at(prepared: Name[], securityTimes: Partial<Record<Name, number>> = {}): MediumSnapshotData {
    const data = medium(player.skills.hacking, {});
    data.player = { ...data.player, ...player };
    const server = (hostname: string, maxRam: number, money: number, security: number) => ({
      hostname,
      maxRam,
      cpuCores: 1,
      hasAdminRights: true,
      backdoorInstalled: false,
      moneyAvailable: money,
      hackDifficulty: security,
    });
    data.servers = [
      ...Object.entries(FIGURES).map(([hostname, { moneyMax, minDifficulty }]) =>
        prepared.includes(hostname as Name)
          ? server(hostname, 0, moneyMax, minDifficulty)
          : server(hostname, 0, moneyMax / 25, minDifficulty * (securityTimes[hostname as Name] ?? 3)),
      ),
      ...Object.entries(HOSTS_RAM).map(([hostname, ram]) => server(hostname, ram, 0, 1)),
    ];
    return data;
  }
  const weakenMs = (name: Name, security?: number) => operationTimeMs("weaken1", FIGURES[name], player, security);
  const incomeOf = (data: MediumSnapshotData, name: Name) => {
    const plan = planBatcher(staticData, data, BN1_HACKING, name, HOSTS);
    return plan.batcher === null ? 0 : plan.incomePerSecond;
  };
  /**
   * The brain's choices from `batching`, as the batcher would follow them: each next prepared before the next choice,
   * and a move (only ever to one prepared while one earns) batched at once. The target batched after each.
   */
  function follow(data: MediumSnapshotData, batching: Name, choices: number): { batched: string[]; nexts: string[] } {
    let current = planBatcher(staticData, data, BN1_HACKING, batching, HOSTS).batcher;
    let batched: string = batching;
    const trail = { batched: [] as string[], nexts: [] as string[] };
    for (let choice = 0; choice < choices; choice++) {
      const chosen = chooseBatcher(staticData, data, BN1_HACKING, HOSTS, current, batched);
      if (chosen.batcher === null) throw new Error(chosen.why);
      const next = chosen.batcher.config.next?.target;
      if (next !== undefined) {
        const { moneyMax, minDifficulty } = FIGURES[next as Name];
        data.servers = data.servers.map((server) =>
          server.hostname === next ? { ...server, moneyAvailable: moneyMax, hackDifficulty: minDifficulty } : server,
        );
      }
      batched = chosen.batcher.config.target;
      current = chosen.batcher;
      trail.batched.push(batched);
      trail.nexts.push(next ?? "none");
    }
    return trail;
  }

  test("the shape: the richest pay thousands of times n00dles, each a weaken past the horizon, rho-construction out of the 5 best", () => {
    const data = at(["n00dles", "rho-construction"]);
    for (const name of RICHEST) {
      expect(incomeOf(data, name)).toBeGreaterThan(1000 * incomeOf(data, "n00dles"));
      expect(weakenMs(name, 3 * FIGURES[name].minDifficulty)).toBeGreaterThan(BATCHER_TARGET_HORIZON_MS);
    }
    // A1's ceiling ranks the richest first, rho-construction after them: the 5 best were all weighed before #274.
    const ceilingOf = (name: Name) => batcherIncomePerGigabyteSecond(FIGURES[name], player, 1);
    const byCeiling = (Object.keys(FIGURES) as Name[]).sort((a, b) => ceilingOf(b) - ceilingOf(a));
    expect(byCeiling.indexOf("rho-construction")).toBeGreaterThanOrEqual(5);
    // Rho-construction prepared, its weaken under BATCHER_MOST_IDLE_MS: a move from n00dles leaves little idle.
    expect(weakenMs("rho-construction") - weakenMs("n00dles")).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    expect(incomeOf(data, "rho-construction")).toBeGreaterThan(1000 * incomeOf(data, "n00dles"));
  });

  test("at 23:00: off n00dles to rho-construction, prepared, a richer next prepared beside it; then the richest", () => {
    const data = at(["n00dles", "rho-construction"]);
    const sent = planBatcher(staticData, data, BN1_HACKING, "n00dles", HOSTS).batcher;
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, HOSTS, sent, "n00dles");
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.batcher.config.target).toBe("rho-construction");
    // The next: one of the richest, though a weaken at its security now is past BATCHER_TARGET_HORIZON_MS, earning
    // within BATCHER_NEXT_HORIZON_MS on the next's RAM, and one a move from rho-construction can reach.
    const next = chosen.batcher.config.next;
    expect(RICHEST).toContain(next?.target);
    const name = next?.target as Name;
    const now = { money: FIGURES[name].moneyMax / 25, security: 3 * FIGURES[name].minDifficulty };
    const untilMs = preparationTimeMs(FIGURES[name], player, now, next?.ramGb ?? 0) + weakenMs(name);
    expect(untilMs).toBeGreaterThan(BATCHER_TARGET_HORIZON_MS);
    expect(untilMs).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    expect(weakenMs(name) - weakenMs("rho-construction")).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    // Followed: clarkinc, the most income of all on these hosts, batched within 3 choices, and kept.
    const income = Object.fromEntries((Object.keys(FIGURES) as Name[]).map((each) => [each, incomeOf(data, each)]));
    expect(Math.max(...Object.values(income))).toBe(income.clarkinc);
    const trail = follow(at(["n00dles", "rho-construction"]), "n00dles", 5);
    expect(trail.batched.slice(0, 3)).toContain("clarkinc");
    expect(trail.batched.at(-1)).toBe("clarkinc");
    expect(trail.nexts.at(-1)).toBe("none");
  });

  test("nothing prepared but n00dles: the next is a step a move can reach (rho-construction), never one it can't", () => {
    // Clarkinc's weaken at its minimum is just over BATCHER_MOST_IDLE_MS past n00dles': prepared, a move from n00dles
    // to it would leave too long without a hack, so it can't be the next while n00dles earns. Before #274, a next like
    // it was prepared and kept, and never moved to (#237's re-review).
    expect(weakenMs("clarkinc") - weakenMs("n00dles")).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    const data = at(["n00dles"]);
    const sent = planBatcher(staticData, data, BN1_HACKING, "n00dles", HOSTS).batcher;
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, HOSTS, sent, "n00dles");
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.batcher.config.target).toBe("n00dles");
    expect(chosen.batcher.config.next?.target).toBe("rho-construction");
    // Followed: rho-construction, then clarkinc, each prepared as the next first.
    const trail = follow(at(["n00dles"]), "n00dles", 6);
    expect(trail.batched.slice(0, 5)).toContain("rho-construction");
    expect(trail.batched.at(-1)).toBe("clarkinc");
  });

  test("the next is the one worth most over BATCHER_NEXT_HORIZON_MS: a target soon prepared before a richer one later", () => {
    // From rho-construction batched: clarkinc earns most once prepared, but at 3 times its minimum it's prepared later
    // than 4sigma at half that; over the next's horizon 4sigma is worth more.
    const data = at(["rho-construction"], { "4sigma": 1.5 });
    const sent = planBatcher(staticData, data, BN1_HACKING, "rho-construction", HOSTS).batcher;
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, HOSTS, sent, "rho-construction");
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.batcher.config.target).toBe("rho-construction");
    const ramGb = chosen.batcher.config.next?.ramGb ?? 0;
    const nextWorth = (name: Name, security: number) => {
      const now = { money: FIGURES[name].moneyMax / 25, security };
      const untilMs = preparationTimeMs(FIGURES[name], player, now, ramGb) + weakenMs(name);
      return { untilMs, worth: incomeOf(data, name) * Math.max(0, BATCHER_NEXT_HORIZON_MS - untilMs) };
    };
    const clarkinc = nextWorth("clarkinc", 3 * FIGURES.clarkinc.minDifficulty);
    const sigma = nextWorth("4sigma", 1.5 * FIGURES["4sigma"].minDifficulty);
    expect(incomeOf(data, "clarkinc") * (BATCHER_TARGET_HORIZON_MS - weakenMs("clarkinc"))).toBeGreaterThan(
      incomeOf(data, "4sigma") * (BATCHER_TARGET_HORIZON_MS - weakenMs("4sigma")),
    );
    expect(sigma.untilMs).toBeLessThan(clarkinc.untilMs);
    expect(sigma.worth).toBeGreaterThan(clarkinc.worth);
    expect(chosen.batcher.config.next?.target).toBe("4sigma");
    // Clarkinc sent as the next: kept, as 4sigma isn't worth BATCHER_MOVE_GAIN times it over that horizon.
    expect(sigma.worth).toBeLessThan(clarkinc.worth * BATCHER_MOVE_GAIN);
    const clarkincNext = { ...chosen.batcher.config.next, target: "clarkinc", figures: FIGURES.clarkinc };
    const sentClarkinc = { ...chosen.batcher, config: { ...chosen.batcher.config, next: clarkincNext } };
    const kept = chooseBatcher(staticData, data, BN1_HACKING, HOSTS, sentClarkinc as typeof sent, "rho-construction");
    expect(kept.batcher?.config.next?.target).toBe("clarkinc");
  });
});

describe("chooseBatcher, weighed beyond the 5 best by the ceiling (#274)", () => {
  /** A server in the medium snapshot: a host with RAM, or a target with its money and security now. */
  const serverAt = (hostname: string, maxRam: number, money: number, security: number) => ({
    hostname,
    maxRam,
    cpuCores: 1,
    hasAdminRights: true,
    backdoorInstalled: false,
    moneyAvailable: money,
    hackDifficulty: security,
  });
  /** Hacking 100 at `speed`, the two hosts (1 TB), n00dles prepared, and each target with its money and security. */
  function worldAt(targets: Record<string, [number, number]>, speed = 1, hostRam = 1024): MediumSnapshotData {
    const data = medium(100, {});
    data.player = { ...data.player, mults: { ...MULTS, hacking_speed: speed } };
    data.servers = [
      serverAt("n00dles", 0, N00DLES.moneyMax, N00DLES.minDifficulty),
      ...CHOICE_HOSTS.map((hostname) => serverAt(hostname, hostRam, 0, 1)),
      ...Object.entries(targets).map(([hostname, [money, security]]) => serverAt(hostname, 0, money, security)),
    ];
    return data;
  }
  const chosenOf = (staticData: StaticSnapshotData, data: MediumSnapshotData, sent: BatcherState | null) => {
    const chosen = chooseBatcher(staticData, data, BN1_HACKING, CHOICE_HOSTS, sent, sent?.config.target ?? null);
    if (chosen.batcher === null) throw new Error(chosen.why);
    return chosen;
  };
  type BatcherState = NonNullable<ReturnType<typeof planBatcher>["batcher"]>;

  // Six targets richer than "late" lead A1's ceiling, as after an install: 3 times their minimum security, 4% money.
  const RICHER = ["rich-0", "rich-1", "rich-2", "rich-3", "rich-4", "rich-5"];
  const LATE = { ...RICH, moneyMax: RICH.moneyMax * 0.9 };
  const wide: StaticSnapshotData = {
    servers: [
      staticServer("n00dles", N00DLES),
      ...RICHER.map((hostname, index) =>
        staticServer(hostname, { ...RICH, moneyMax: RICH.moneyMax * (1.1 + index / 100) }),
      ),
      staticServer("late", LATE),
    ],
  };
  const afterAnInstall = Object.fromEntries(
    RICHER.map((hostname, index) => [hostname, [(RICH.moneyMax * (1.1 + index / 100)) / 25, 3 * RICH.minDifficulty]]),
  ) as Record<string, [number, number]>;
  const isFirstByCeiling = (name: string, of: number) => {
    const player = { skills: { hacking: 100, intelligence: 0 }, mults: MULTS };
    const ceilings = wide.servers.map((server) =>
      batcherIncomePerGigabyteSecond(server as unknown as typeof RICH, player, 1),
    );
    const own = ceilings[wide.servers.findIndex((server) => server.hostname === name)] as number;
    return ceilings.filter((each) => each > own).length < of;
  };

  test("a target prepared, however far down by the ceiling: moved to while n00dles earns", () => {
    expect(isFirstByCeiling("late", 6)).toBe(false);
    const data = worldAt({ ...afterAnInstall, late: [LATE.moneyMax, LATE.minDifficulty] });
    const sent = planBatcher(wide, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    expect(chosenOf(wide, data, sent).batcher.config.target).toBe("late");
  });

  test("the next sent, however far down by the ceiling: kept while it's being prepared", () => {
    // Late half prepared, at 1.5 times its minimum, as the next sent beside n00dles' batches.
    const data = worldAt({ ...afterAnInstall, late: [LATE.moneyMax / 2, 1.5 * LATE.minDifficulty] });
    const sent = planBatcher(wide, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher as BatcherState;
    const fresh = chosenOf(wide, data, sent);
    expect(fresh.batcher.config.next?.target).toMatch(/^rich-/);
    const lateNext = { ...fresh.batcher.config.next, target: "late", figures: LATE } as BatcherState["config"]["next"];
    const kept = chosenOf(wide, data, { ...fresh.batcher, config: { ...fresh.batcher.config, next: lateNext } });
    expect(kept.batcher.config.target).toBe("n00dles");
    expect(kept.batcher.config.next?.target).toBe("late");
  });

  test("the steps are reckoned from the one batched: one whose own weaken is long reaches one past BATCHER_MOST_IDLE_MS", () => {
    // Hacking 100: base's weaken 4 minutes, prepared and batched; step's 7, richer, at 3 times its minimum; and five
    // far richer still after an install, first by the ceiling, a weaken of 20 minutes, which nothing here can move to.
    const base = { moneyMax: 100_000_000, minDifficulty: 10, requiredHackingSkill: 52, serverGrowth: 50 };
    const step = { moneyMax: 10_000_000_000, minDifficulty: 11, requiredHackingSkill: 96, serverGrowth: 50 };
    const far = { moneyMax: 1_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FAR = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("base", base),
        staticServer("step", step),
        ...FAR.map((hostname) => staticServer(hostname, far)),
      ],
    };
    const data = worldAt({
      base: [base.moneyMax, base.minDifficulty],
      step: [step.moneyMax, 3 * step.minDifficulty],
      ...Object.fromEntries(FAR.map((hostname) => [hostname, [far.moneyMax / 25, 3 * far.minDifficulty]])),
    });
    const weakenMs = (figures: typeof base) => operationTimeMs("weaken1", figures, PLAYER_100);
    expect(weakenMs(step)).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    expect(weakenMs(step) - weakenMs(base)).toBeLessThanOrEqual(BATCHER_MOST_IDLE_MS);
    expect(weakenMs(far) - weakenMs(base)).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    const ceilingOf = (figures: typeof base) => batcherIncomePerGigabyteSecond(figures, PLAYER_100, 1);
    expect(ceilingOf(far)).toBeGreaterThan(ceilingOf(step));
    const sent = planBatcher(world, data, BN1_HACKING, "base", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(world, data, sent);
    expect(chosen.batcher.config.target).toBe("base");
    expect(chosen.batcher.config.next?.target).toBe("step");
  });

  test("home among the hosts (#340): the steps are reckoned on its RAM too, so a step only it can prepare is the next", () => {
    // The last test's world, its two hosts 16 GB each and home 2 TB keeping 32: step's preparation on the hosts' RAM
    // alone never ends; on home's too, within the hour, so it's the next.
    const base = { moneyMax: 100_000_000, minDifficulty: 10, requiredHackingSkill: 52, serverGrowth: 50 };
    const step = { moneyMax: 10_000_000_000, minDifficulty: 11, requiredHackingSkill: 96, serverGrowth: 50 };
    const far = { moneyMax: 1_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FAR = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("base", base),
        staticServer("step", step),
        ...FAR.map((hostname) => staticServer(hostname, far)),
      ],
    };
    const data = worldAt(
      {
        base: [base.moneyMax, base.minDifficulty],
        step: [step.moneyMax, 3 * step.minDifficulty],
        ...Object.fromEntries(FAR.map((hostname) => [hostname, [far.moneyMax / 25, 3 * far.minDifficulty]])),
      },
      1,
      16,
    );
    data.servers.push(serverAt("home", 2_048, 0, 1));
    const chosenWith = (homeKeptGb: number | null) => {
      const sent = planBatcher(world, data, BN1_HACKING, "base", CHOICE_HOSTS, null, 1, homeKeptGb).batcher;
      const chosen = chooseBatcher(world, data, BN1_HACKING, CHOICE_HOSTS, sent, "base", homeKeptGb);
      if (chosen.batcher === null) throw new Error(chosen.why);
      return chosen.batcher.config;
    };
    // The batches beside the next, planned on four fifths of the RAM, home's among it (#340's review).
    expect(chosenWith(32)).toMatchObject({
      target: "base",
      next: { target: "step" },
      hosts: [...CHOICE_HOSTS, "home"],
      homeKeptGb: 32,
      ramBound: true,
    });
    expect(chosenWith(null).next).toBeUndefined();
  });

  test("the next's bound counts its first batch: one prepared within BATCHER_NEXT_HORIZON_MS but earning after isn't", () => {
    // Rich after an install, alone beside n00dles batched, at a speed that puts its preparation within the hour and its
    // first batch past it; a little faster, both within it.
    const world: StaticSnapshotData = { servers: [staticServer("n00dles", N00DLES), staticServer("rich", RICH)] };
    const now = { money: RICH.moneyMax / 25, security: 3 * RICH.minDifficulty };
    const timesAt = (speed: number) => {
      const data = worldAt({ rich: [now.money, now.security] }, speed);
      const player = { skills: { hacking: 100, intelligence: 0 }, mults: { ...MULTS, hacking_speed: speed } };
      const batched = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS);
      const whole = planBatcher(world, data, BN1_HACKING, "rich", CHOICE_HOSTS);
      if (batched.batcher === null || whole.batcher === null) throw new Error("no plan");
      const nextGb = whole.ramGb * Math.max(BATCHER_NEXT_RAM_SHARE, 1 - batched.peakRamGb / batched.ramGb);
      const preparingMs = preparationTimeMs(RICH, player, now, nextGb);
      return { data, preparingMs, weakenMs: operationTimeMs("weaken1", RICH, player), sent: batched.batcher };
    };
    const atOne = timesAt(1);
    const speed = (2 * atOne.preparingMs + atOne.weakenMs) / (2 * BATCHER_NEXT_HORIZON_MS);
    const slow = timesAt(speed);
    expect(slow.preparingMs).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    expect(slow.preparingMs + slow.weakenMs).toBeGreaterThan(BATCHER_NEXT_HORIZON_MS);
    expect(chosenOf(world, slow.data, slow.sent).batcher.config.next).toBeUndefined();
    const quicker = timesAt(speed * 1.2);
    expect(quicker.preparingMs + quicker.weakenMs).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    expect(chosenOf(world, quicker.data, quicker.sent).batcher.config.next?.target).toBe("rich");
  });

  /** Hacking 100 at `speed`. */
  const playerAt = (speed: number) => ({
    skills: { hacking: 100, intelligence: 0 },
    mults: { ...MULTS, hacking_speed: speed },
  });
  /** The next's RAM beside `batched`'s batches: what they leave, a fifth at least (#237's review). */
  const nextGbBeside = (staticData: StaticSnapshotData, data: MediumSnapshotData, batched: string) => {
    const plan = planBatcher(staticData, data, BN1_HACKING, batched, CHOICE_HOSTS);
    if (plan.batcher === null) throw new Error(plan.why);
    return plan.ramGb * Math.max(BATCHER_NEXT_RAM_SHARE, 1 - plan.peakRamGb / plan.ramGb);
  };

  test("the steps earn within BATCHER_NEXT_HORIZON_MS (#278's review): five better by the ceiling that can't leave room", () => {
    // At speed 0.5 the six richer are at their maximum money but at security 100, a weaken there of 58 minutes, and a
    // batch's after it: none earns within the hour. Late, half prepared, does. Before, the 5 best by the ceiling of
    // those a move reaches were the steps, earning or not, and late wasn't weighed.
    const speed = 0.5;
    const player = playerAt(speed);
    const data = worldAt(
      {
        ...Object.fromEntries(RICHER.map((hostname, index) => [hostname, [RICH.moneyMax * (1.1 + index / 100), 100]])),
        late: [LATE.moneyMax / 2, 1.5 * LATE.minDifficulty],
      },
      speed,
    );
    const nextGb = nextGbBeside(wide, data, "n00dles");
    const untilMs = (figures: typeof RICH, now: { money: number; security: number }) =>
      preparationTimeMs(figures, player, now, nextGb) + operationTimeMs("weaken1", figures, player);
    for (const [index] of RICHER.entries()) {
      const figures = { ...RICH, moneyMax: RICH.moneyMax * (1.1 + index / 100) };
      expect(untilMs(figures, { money: figures.moneyMax, security: 100 })).toBeGreaterThan(BATCHER_NEXT_HORIZON_MS);
    }
    const lateNow = { money: LATE.moneyMax / 2, security: 1.5 * LATE.minDifficulty };
    expect(untilMs(LATE, lateNow)).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    const sent = planBatcher(wide, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    expect(chosenOf(wide, data, sent).batcher.config.next?.target).toBe("late");
  });

  test("the steps are reckoned from the one chosen too (#278's review): a move now, and a next its target reaches", () => {
    // N00dles batched; base prepared, the move; step a weaken of 7 minutes, past BATCHER_MOST_IDLE_MS of n00dles' but
    // within it of base's; five far richer first by the ceiling.
    const base = { moneyMax: 1_000_000_000, minDifficulty: 10, requiredHackingSkill: 52, serverGrowth: 50 };
    const step = { moneyMax: 100_000_000_000, minDifficulty: 11, requiredHackingSkill: 96, serverGrowth: 50 };
    const far = { moneyMax: 1_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FAR = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("base", base),
        staticServer("step", step),
        ...FAR.map((hostname) => staticServer(hostname, far)),
      ],
    };
    const data = worldAt({
      base: [base.moneyMax, base.minDifficulty],
      step: [step.moneyMax, 3 * step.minDifficulty],
      ...Object.fromEntries(FAR.map((hostname) => [hostname, [far.moneyMax / 25, 3 * far.minDifficulty]])),
    });
    const weakenMs = (figures: typeof base) => operationTimeMs("weaken1", figures, PLAYER_100);
    expect(weakenMs(step) - weakenMs(N00DLES)).toBeGreaterThan(BATCHER_MOST_IDLE_MS);
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(world, data, sent);
    expect(chosen.batcher.config.target).toBe("base");
    expect(chosen.batcher.config.next?.target).toBe("step");
  });

  describe("the next's cost (#278's review): the batches on four fifths of the RAM while it's prepared", () => {
    // Rich prepared and batched, richer 1.6 times its money (worth the move once prepared), and five far richer still,
    // first by the ceiling, which nothing here can move to: richer is weighed only as a step.
    const RICHER_ONE = { ...RICH, moneyMax: RICH.moneyMax * 1.6 };
    const FAR = { moneyMax: 1_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FARS = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("rich", RICH),
        staticServer("richer", RICHER_ONE),
        ...FARS.map((hostname) => staticServer(hostname, FAR)),
      ],
    };
    const ceilingOf = (figures: typeof RICH) => batcherIncomePerGigabyteSecond(figures, PLAYER_100, 1);
    const at = (richerNow: { money: number; security: number }, hostRam = 1024) => {
      const data = worldAt(
        {
          rich: [RICH.moneyMax, RICH.minDifficulty],
          richer: [richerNow.money, richerNow.security],
          ...Object.fromEntries(FARS.map((hostname) => [hostname, [FAR.moneyMax / 25, 100]])),
        },
        1,
        hostRam,
      );
      const whole = planBatcher(world, data, BN1_HACKING, "rich", CHOICE_HOSTS);
      const rest = planBatcher(world, data, BN1_HACKING, "rich", CHOICE_HOSTS, null, 1 - BATCHER_NEXT_RAM_SHARE);
      const richer = planBatcher(world, data, BN1_HACKING, "richer", CHOICE_HOSTS);
      if (whole.batcher === null || rest.batcher === null || richer.batcher === null) throw new Error("no plan");
      const weakenMs = operationTimeMs("weaken1", RICHER_ONE, PLAYER_100);
      const untilMs =
        preparationTimeMs(RICHER_ONE, PLAYER_100, richerNow, nextGbBeside(world, data, "rich")) + weakenMs;
      const afterMs = Math.max(0, BATCHER_NEXT_HORIZON_MS - untilMs);
      const lostPerSecond = whole.incomePerSecond - rest.incomePerSecond;
      return {
        data,
        untilMs,
        lostPerSecond,
        // What it gains over rich after it earns, less what rich's batches lose meanwhile; and over nothing, wrongly.
        gain: (richer.incomePerSecond - whole.incomePerSecond) * afterMs - lostPerSecond * untilMs,
        gainOverNothing: richer.incomePerSecond * afterMs - lostPerSecond * untilMs,
        worthTheMove:
          richer.incomePerSecond * (BATCHER_TARGET_HORIZON_MS - weakenMs) >=
          whole.incomePerSecond * BATCHER_TARGET_HORIZON_MS * BATCHER_MOVE_GAIN,
        sent: whole.batcher,
      };
    };
    const afterAnInstall = (money: number) => ({ money, security: 3 * RICHER_ONE.minDifficulty });
    const next = (shape: ReturnType<typeof at>) => chosenOf(world, shape.data, shape.sent).batcher.config.next?.target;

    test("home among the hosts (#340's review): what the batches lose while a next is prepared counts home's RAM", () => {
      // The hosts 16 GB each and home 2 TB beyond the 32 GB it keeps: at each rung of richer's money, it's the next
      // exactly when its gain over rich, less what rich's batches lose on four fifths of all that RAM, is above 0.
      const shapeAt = (money: number) => {
        const data = worldAt(
          {
            rich: [RICH.moneyMax, RICH.minDifficulty],
            richer: [money, 3 * RICHER_ONE.minDifficulty],
            ...Object.fromEntries(FARS.map((hostname) => [hostname, [FAR.moneyMax / 25, 100]])),
          },
          1,
          16,
        );
        data.servers.push(serverAt("home", 2_080, 0, 1));
        const plan = (target: string, share = 1, kept: number | null = 32) =>
          planBatcher(world, data, BN1_HACKING, target, CHOICE_HOSTS, null, share, kept);
        const whole = plan("rich");
        const rest = plan("rich", 1 - BATCHER_NEXT_RAM_SHARE);
        const restWithoutHome = plan("rich", 1 - BATCHER_NEXT_RAM_SHARE, null);
        const richer = plan("richer");
        if (whole.batcher === null || rest.batcher === null || richer.batcher === null) throw new Error("no plan");
        const nextGb = whole.ramGb * Math.max(BATCHER_NEXT_RAM_SHARE, 1 - whole.peakRamGb / whole.ramGb);
        const weakenMs = operationTimeMs("weaken1", RICHER_ONE, PLAYER_100);
        const untilMs =
          preparationTimeMs(RICHER_ONE, PLAYER_100, { money, security: 3 * RICHER_ONE.minDifficulty }, nextGb) +
          weakenMs;
        const afterMs = Math.max(0, BATCHER_NEXT_HORIZON_MS - untilMs);
        const gainLess = (lost: number) => (richer.incomePerSecond - whole.incomePerSecond) * afterMs - lost * untilMs;
        const chosen = chooseBatcher(world, data, BN1_HACKING, CHOICE_HOSTS, whole.batcher, "rich", 32);
        if (chosen.batcher === null) throw new Error(chosen.why);
        return {
          gain: gainLess(whole.incomePerSecond - rest.incomePerSecond),
          gainLostWithoutHome: gainLess(
            whole.incomePerSecond - (restWithoutHome.batcher === null ? 0 : restWithoutHome.incomePerSecond),
          ),
          next: chosen.batcher.config.next?.target,
        };
      };
      const shapes = Array.from({ length: 30 }, (_, halvings) => shapeAt(RICHER_ONE.moneyMax / 2 ** halvings));
      for (const shape of shapes) expect(shape.next === "richer").toBe(shape.gain > 0);
      // Some rungs go each way, and on one at least the loss reckoned without home's RAM would refuse the next.
      expect(shapes.some((shape) => shape.next === "richer")).toBe(true);
      expect(shapes.some((shape) => shape.next === undefined)).toBe(true);
      expect(shapes.some((shape) => shape.gain > 0 && shape.gainLostWithoutHome <= 0)).toBe(true);
    });

    test("RAM-bound: a next that earns too late to make up what the batches lose isn't sent; one sooner is", () => {
      expect(ceilingOf(FAR)).toBeGreaterThan(ceilingOf(RICHER_ONE));
      // Of richer's money now, halving from its maximum, the most at which its gain is below 0: past break-even.
      const ladder = Array.from({ length: 40 }, (_, halvings) => RICHER_ONE.moneyMax / 2 ** halvings);
      const slowMoney = ladder.find((money) => at(afterAnInstall(money)).gain < 0) as number;
      const slow = at(afterAnInstall(slowMoney));
      expect(slow.worthTheMove).toBe(true);
      expect(slow.lostPerSecond).toBeGreaterThan(0);
      expect(slow.untilMs).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
      expect(slow.gain).toBeLessThan(0);
      // Its gain counted over nothing, not over rich, would send it.
      expect(slow.gainOverNothing).toBeGreaterThan(0);
      expect(next(slow)).toBeUndefined();
      const quick = at(afterAnInstall(RICHER_ONE.moneyMax / 2));
      expect(quick.gain).toBeGreaterThan(0);
      expect(next(quick)).toBe("richer");
      // Richer among the 5 best by the ceiling too (no far ones): weighed whatever the steps, the next's own check.
      const near: StaticSnapshotData = { servers: world.servers.filter((server) => !FARS.includes(server.hostname)) };
      expect(chosenOf(near, slow.data, slow.sent).batcher.config.next).toBeUndefined();
      expect(chosenOf(near, quick.data, quick.sent).batcher.config.next?.target).toBe("richer");
    });

    test("free where the batches leave the RAM idle: n00dles' on two 1 PB hosts lose nothing to a fifth", () => {
      // Plus, a little richer than n00dles, a weaken at security 100 away. Counting all n00dles earns as lost would
      // drop it; n00dles' batches lose nothing, so it's sent. Of plus's money, from 1.5 to 4 times n00dles', the least
      // that tells the two apart.
      const free = (moneyMax: number) => {
        const plus = { moneyMax, minDifficulty: 5, requiredHackingSkill: 50, serverGrowth: 50 };
        const staticData: StaticSnapshotData = {
          servers: [staticServer("n00dles", N00DLES), staticServer("plus", plus)],
        };
        const data = worldAt({ plus: [moneyMax, 100] }, 1, 1_048_576);
        const whole = planBatcher(staticData, data, BN1_HACKING, "n00dles", CHOICE_HOSTS);
        const rest = planBatcher(
          staticData,
          data,
          BN1_HACKING,
          "n00dles",
          CHOICE_HOSTS,
          null,
          1 - BATCHER_NEXT_RAM_SHARE,
        );
        const plan = planBatcher(staticData, data, BN1_HACKING, "plus", CHOICE_HOSTS);
        if (whole.batcher === null || rest.batcher === null || plan.batcher === null) throw new Error("no plan");
        const weakenMs = operationTimeMs("weaken1", plus, PLAYER_100);
        const untilMs =
          preparationTimeMs(
            plus,
            PLAYER_100,
            { money: moneyMax, security: 100 },
            nextGbBeside(staticData, data, "n00dles"),
          ) + weakenMs;
        const afterMs = Math.max(0, BATCHER_NEXT_HORIZON_MS - untilMs);
        return {
          staticData,
          data,
          sent: whole.batcher,
          untilMs,
          lostPerSecond: whole.incomePerSecond - rest.incomePerSecond,
          gain: (plan.incomePerSecond - whole.incomePerSecond) * afterMs,
          gainLosingAll: (plan.incomePerSecond - whole.incomePerSecond) * afterMs - whole.incomePerSecond * untilMs,
          worthTheMove:
            plan.incomePerSecond * (BATCHER_TARGET_HORIZON_MS - weakenMs) >=
            whole.incomePerSecond * BATCHER_TARGET_HORIZON_MS * BATCHER_MOVE_GAIN,
        };
      };
      const shape = Array.from({ length: 26 }, (_, tenth) => free(N00DLES.moneyMax * (1.5 + tenth / 10))).find(
        (each) => each.worthTheMove && each.gainLosingAll < 0,
      );
      if (shape === undefined) throw new Error("no shape tells them apart");
      expect(shape.lostPerSecond).toBe(0);
      expect(shape.untilMs).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
      expect(shape.gain).toBeGreaterThan(0);
      expect(chosenOf(shape.staticData, shape.data, shape.sent).batcher.config.next?.target).toBe("plus");
    });
  });

  test("the steps are judged on the RAM the batched one's batches leave, not a fifth (#278's review)", () => {
    // #237's slow grower beside n00dles' batches on two 256 TB hosts, at speed 0.5: within the hour on what they leave,
    // not on a fifth; five far richer first by the ceiling, so it's weighed only as a step.
    const speed = 0.5;
    const player = playerAt(speed);
    const slow = { moneyMax: 1e12, minDifficulty: 30, requiredHackingSkill: 1, serverGrowth: 1 };
    const FAR = { moneyMax: 100_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FARS = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("slow", slow),
        ...FARS.map((hostname) => staticServer(hostname, FAR)),
      ],
    };
    const data = worldAt(
      { slow: [0, 30], ...Object.fromEntries(FARS.map((hostname) => [hostname, [FAR.moneyMax / 25, 100]])) },
      speed,
      262_144,
    );
    const ceilingOf = (figures: typeof slow) => batcherIncomePerGigabyteSecond(figures, player, 1);
    expect(ceilingOf(FAR)).toBeGreaterThan(ceilingOf(slow));
    const whole = planBatcher(world, data, BN1_HACKING, "slow", CHOICE_HOSTS);
    if (whole.batcher === null) throw new Error(whole.why);
    const untilMs = (ramGb: number) =>
      preparationTimeMs(slow, player, { money: 0, security: 30 }, ramGb) + operationTimeMs("weaken1", slow, player);
    expect(untilMs(nextGbBeside(world, data, "n00dles"))).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    expect(untilMs(whole.ramGb * BATCHER_NEXT_RAM_SHARE)).toBeGreaterThan(BATCHER_NEXT_HORIZON_MS);
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    expect(chosenOf(world, data, sent).batcher.config.next?.target).toBe("slow");
  });

  test("a next sent and being prepared, pushed past the hour (#278's review: hosts lost), is kept while it's worth a path", () => {
    // Rich from no money, beside n00dles' batches, at a speed that puts its first batch at 70 minutes: never sent as
    // the next, but once sent, its waves out, kept; another worth more would still replace it.
    const world: StaticSnapshotData = { servers: [staticServer("n00dles", N00DLES), staticServer("rich", RICH)] };
    const now = { money: 0, security: 3 * RICH.minDifficulty };
    const untilAt = (speed: number) => {
      const data = worldAt({ rich: [now.money, now.security] }, speed);
      const player = playerAt(speed);
      return (
        preparationTimeMs(RICH, player, now, nextGbBeside(world, data, "n00dles")) +
        operationTimeMs("weaken1", RICH, player)
      );
    };
    const speed = untilAt(1) / (70 * 60_000);
    expect(untilAt(speed)).toBeGreaterThan(BATCHER_NEXT_HORIZON_MS);
    const data = worldAt({ rich: [now.money, now.security] }, speed);
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher as BatcherState;
    const fresh = chosenOf(world, data, sent);
    expect(fresh.batcher.config.next).toBeUndefined();
    const richNext = { target: "rich", figures: RICH, ramGb: nextGbBeside(world, data, "n00dles") };
    const kept = chosenOf(world, data, { ...sent, config: { ...sent.config, next: richNext } });
    expect(kept.batcher.config.next?.target).toBe("rich");
    // One that never prepares (the RAM holds no wave, or more than MOST_PREPARATION_WAVES): not kept (#278's
    // re-review), as the batches would run on four fifths of the RAM for nothing. Rich with a growth of 10, from no
    // money.
    const stuck = { ...RICH, serverGrowth: 10 };
    const stuckWorld: StaticSnapshotData = { servers: [staticServer("n00dles", N00DLES), staticServer("rich", stuck)] };
    const stuckData = worldAt({ rich: [now.money, now.security] });
    const nextGb = nextGbBeside(stuckWorld, stuckData, "n00dles");
    expect(preparationTimeMs(stuck, PLAYER_100, now, nextGb)).toBe(Number.POSITIVE_INFINITY);
    const stuckSent = planBatcher(stuckWorld, stuckData, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher as BatcherState;
    const stuckNext = { target: "rich", figures: stuck, ramGb: nextGb };
    const dropped = chosenOf(stuckWorld, stuckData, { ...stuckSent, config: { ...stuckSent.config, next: stuckNext } });
    expect(dropped.batcher.config.next).toBeUndefined();
  });

  test("a next is judged against the chosen one batched (#278's re-review): on a move, none the later move would refuse", () => {
    // N00dles batched; base prepared, a weaken of 4 minutes, the move. Over the horizon base is worth its income for 11
    // minutes now (its first batch a weaken away), but 15 once batched, which is what the move to the next is weighed
    // against. Over, a little richer than base and nearly prepared, falls between: before, it was sent as the next,
    // prepared at its cost, and never moved to.
    const base = { moneyMax: 1_000_000_000, minDifficulty: 10, requiredHackingSkill: 52, serverGrowth: 50 };
    const shapeOf = (share: number) => {
      const over = { ...base, moneyMax: base.moneyMax * share };
      const world: StaticSnapshotData = {
        servers: [staticServer("n00dles", N00DLES), staticServer("base", base), staticServer("over", over)],
      };
      const data = worldAt({
        base: [base.moneyMax, base.minDifficulty],
        over: [over.moneyMax, 1.2 * over.minDifficulty],
      });
      const baseIncome = planBatcher(world, data, BN1_HACKING, "base", CHOICE_HOSTS);
      const overIncome = planBatcher(world, data, BN1_HACKING, "over", CHOICE_HOSTS);
      if (baseIncome.batcher === null || overIncome.batcher === null) throw new Error("no plan");
      const weakenMs = operationTimeMs("weaken1", base, PLAYER_100);
      const overWorth = overIncome.incomePerSecond * (BATCHER_TARGET_HORIZON_MS - weakenMs);
      return {
        world,
        data,
        overNow: overWorth >= baseIncome.incomePerSecond * (BATCHER_TARGET_HORIZON_MS - weakenMs) * BATCHER_MOVE_GAIN,
        overBatched: overWorth >= baseIncome.incomePerSecond * BATCHER_TARGET_HORIZON_MS * BATCHER_MOVE_GAIN,
      };
    };
    const shape = Array.from({ length: 41 }, (_, step) => shapeOf(1.2 + step / 100)).find(
      (each) => each.overNow && !each.overBatched,
    );
    if (shape === undefined) throw new Error("no share falls between the two");
    const sent = planBatcher(shape.world, shape.data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(shape.world, shape.data, sent);
    expect(chosen.batcher.config.target).toBe("base");
    expect(chosen.batcher.config.next).toBeUndefined();
  });

  test("the steps are the first 5 by the ceiling that pass the exact checks (#278's re-review), planned as they're met", () => {
    // Two 1 PB hosts. Five n00dles a tenth richer lead the ceiling and pass its bounds, but their batches are capped by
    // their money, so none is worth the move from n00dles; big, a lower ceiling (a hacking level near the player's),
    // earns far more on that RAM. Before, the 5 by the ceiling took the steps' places, planned or not.
    const clone = { ...N00DLES, moneyMax: N00DLES.moneyMax * 1.1 };
    const CLONES = ["clone-0", "clone-1", "clone-2", "clone-3", "clone-4"];
    const big = { moneyMax: 200_000_000, minDifficulty: 5, requiredHackingSkill: 99, serverGrowth: 50 };
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        ...CLONES.map((hostname) => staticServer(hostname, clone)),
        staticServer("big", big),
      ],
    };
    const data = worldAt(
      {
        ...Object.fromEntries(CLONES.map((hostname) => [hostname, [clone.moneyMax / 25, 3]])),
        big: [big.moneyMax / 2, 1.5 * big.minDifficulty],
      },
      1,
      1_048_576,
    );
    const ceilingOf = (figures: typeof big) => batcherIncomePerGigabyteSecond(figures, PLAYER_100, 1);
    expect(ceilingOf(clone)).toBeGreaterThan(ceilingOf(N00DLES));
    expect(ceilingOf(N00DLES)).toBeGreaterThan(ceilingOf(big));
    const incomeOf = (name: string) => {
      const plan = planBatcher(world, data, BN1_HACKING, name, CHOICE_HOSTS);
      return plan.batcher === null ? 0 : plan.incomePerSecond;
    };
    expect(incomeOf("clone-0")).toBeLessThan(incomeOf("n00dles") * BATCHER_MOVE_GAIN);
    expect(incomeOf("big")).toBeGreaterThan(2 * incomeOf("n00dles"));
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    expect(chosenOf(world, data, sent).batcher.config.next?.target).toBe("big");
  });

  test("the steps are several (#278's re-review): the first by the ceiling isn't always the next", () => {
    // Five far richer, first by the ceiling, which nothing here can move to; then slow, a tenth richer than rich but at
    // security 40, a few waves to prepare; then rich, half prepared. Both are steps; rich is worth more over the hour.
    const FAR = { moneyMax: 1_000_000_000_000, minDifficulty: 42, requiredHackingSkill: 80, serverGrowth: 50 };
    const FARS = ["far-0", "far-1", "far-2", "far-3", "far-4"];
    const slow = { ...RICH, moneyMax: RICH.moneyMax * 1.1 };
    const world: StaticSnapshotData = {
      servers: [
        staticServer("n00dles", N00DLES),
        staticServer("slow", slow),
        staticServer("rich", RICH),
        ...FARS.map((hostname) => staticServer(hostname, FAR)),
      ],
    };
    const data = worldAt({
      slow: [slow.moneyMax, 40],
      rich: [RICH.moneyMax / 2, 1.5 * RICH.minDifficulty],
      ...Object.fromEntries(FARS.map((hostname) => [hostname, [FAR.moneyMax / 25, 100]])),
    });
    const ceilingOf = (figures: typeof RICH) => batcherIncomePerGigabyteSecond(figures, PLAYER_100, 1);
    expect(ceilingOf(FAR)).toBeGreaterThan(ceilingOf(slow));
    expect(ceilingOf(slow)).toBeGreaterThan(ceilingOf(RICH));
    const nextGb = nextGbBeside(world, data, "n00dles");
    const untilMs = (figures: typeof RICH, now: { money: number; security: number }) =>
      preparationTimeMs(figures, PLAYER_100, now, nextGb) + operationTimeMs("weaken1", figures, PLAYER_100);
    expect(untilMs(slow, { money: slow.moneyMax, security: 40 })).toBeLessThan(BATCHER_NEXT_HORIZON_MS);
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    expect(chosenOf(world, data, sent).batcher.config.next?.target).toBe("rich");
  });

  test("what's planned stays bounded on BN1's 60 targets (#278's review): the 5 best, the steps, the prepared, 3 more", () => {
    let seed = 274;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const names = Array.from({ length: 60 }, (_, index) => `target-${index}`);
    const figuresOf = Object.fromEntries(
      names.map((name) => [
        name,
        {
          moneyMax: Math.round(10 ** (7 + random() * 5)),
          minDifficulty: 1 + Math.floor(random() * 33),
          requiredHackingSkill: 1 + Math.floor(random() * 900),
          serverGrowth: 10 + Math.floor(random() * 90),
        },
      ]),
    );
    const preparedNames = names.slice(0, 4);
    const world: StaticSnapshotData = {
      servers: [staticServer("n00dles", N00DLES), ...names.map((name) => staticServer(name, figuresOf[name]))],
    };
    const data = worldAt(
      Object.fromEntries(
        names.map((name) => {
          const { moneyMax, minDifficulty } = figuresOf[name] as typeof RICH;
          return [name, preparedNames.includes(name) ? [moneyMax, minDifficulty] : [moneyMax / 25, 3 * minDifficulty]];
        }),
      ),
    );
    data.player = { ...data.player, skills: { hacking: 1000, intelligence: 0 } };
    const sent = planBatcher(world, data, BN1_HACKING, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chosenOf(world, data, sent);
    // The 5 best by the ceiling, the steps from the one batched and from the one chosen, every one prepared (n00dles
    // too), and the one sent, its next and the one batched.
    expect(chosen.worths.length).toBeLessThanOrEqual(3 * BATCHER_TARGETS_PLANNED + preparedNames.length + 1 + 3);
  });
});

describe("the batcher's health after an install (#216's review)", () => {
  test("a health written before the game's last install isn't news: the batcher the reset killed isn't batching", () => {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const controller = new DesiredStateController({ channel, store });
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("medium", medium(50, { n00dles: true, foodnstuff: true }));
    const fast = (atMs: number) => ({
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [],
      dialogs: { handled: [], blocking: null },
      batcher: { ...newBatcherHealth("n00dles", "r1", atMs), state: "batching" },
    });
    const slow = (lastAugReset: number) => ({ ...slowData(), resetInfo: { ...slowData().resetInfo, lastAugReset } });
    agent.send("slow", slow(1_000));
    agent.send("fast", fast(5_000));
    expect(controller.batcherView().health?.state).toBe("batching");
    // An install at 6 s; the port still has the health from 5 s.
    agent.send("slow", slow(6_000));
    agent.send("fast", fast(5_000));
    expect(controller.batcherView().health).toBeNull();
  });
});
