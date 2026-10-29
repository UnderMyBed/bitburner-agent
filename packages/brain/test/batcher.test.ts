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
  batchPlan,
  batchRamGb,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  newBatcherHealth,
  operationTimeMs,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BATCHER_ENABLED_SETTING,
  BATCHER_MOST_IDLE_MS,
  BATCHER_MOVE_GAIN,
  BATCHER_NEXT_RAM_SHARE,
  BATCHER_TARGET_HORIZON_MS,
  type BatcherTargetWorth,
  batcherHostsOf,
  batcherOutOfStep,
  batcherTargetsOf,
  batcherViewOf,
  chooseBatcher,
  HOME_KEPT_FOR_THE_AGENT_GB,
  planBatcher,
  readBatcherEnabled,
} from "../src/batcher.ts";
import { batcherSection, whoHacked } from "../src/batcher-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { chooseHackHosts } from "../src/hack-loop.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

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
    expect(planBatcher(network, data, "n00dles", hosts, "foodnstuff").batcher?.runOn).toBe("foodnstuff");
    // Without a current host, home of 64 GB.
    expect(planBatcher(network, data, "n00dles", hosts).batcher?.runOn).toBe("home");
    // A current host no longer a host moves it.
    expect(planBatcher(network, data, "n00dles", ["n00dles"], "foodnstuff").batcher?.runOn).toBe("home");
  });

  test("on an 8 GB home: on the largest host, whose RAM the plan counts less the batcher's; core's plan, its config", () => {
    const data = medium(50, { n00dles: true, foodnstuff: true });
    data.servers = data.servers.map((server) => (server.hostname === "n00dles" ? { ...server, maxRam: 4 } : server));
    const planned = planBatcher(network, data, "n00dles", ["n00dles", "foodnstuff"]);
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
});

describe("batcherHostsOf", () => {
  test("the hack loop's hosts and its preparing ones", () => {
    expect(batcherHostsOf({ hosts: ["a", "b"] })).toEqual(["a", "b"]);
    expect(batcherHostsOf({ hosts: ["a"], preparing: { hosts: ["c", "d"] } })).toEqual(["a", "c", "d"]);
    expect(batcherHostsOf({ hosts: [], preparing: null })).toEqual([]);
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
      "batcher out of step: 1 desync (0 out of order, 1 out of bounds), 0 late, 0 lost, the first seen at " +
        "2026-01-01T01:10:00.000Z",
    ]);
    expect(lines).toContain(`  ${failures[0]}`);
    expect(lines).toContain("    from 2026-01-01T01:10:00.000Z: no RAM to prepare n00dles");
  });

  test("in step: no desyncs, nothing late or lost, no problems, always running", () => {
    const failures: string[] = [];
    const lines = batcherSection(
      [
        { atMs: at(0), health: health("a", { batchesStarted: 1, leastSlackMs: 180.4 }) },
        { atMs: at(1), health: health("a", { batchesStarted: 2, leastSlackMs: 116.6 }) },
      ],
      failures,
    );
    expect(lines.slice(-6)).toEqual([
      "  desyncs: none",
      "  late or lost: none",
      // The least over the window (#216's review).
      "  least slack: 117 ms (an operation's time to spare when it was called; under 0 is late)",
      "  problems: none",
      "  sent but not running (3 fast snapshots in a row or more):",
      "    none",
    ]);
    expect(failures).toEqual([]);
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

describe("chooseBatcher (#206)", () => {
  const choose = (data: MediumSnapshotData, current: string | null = null, batching: string | null = null) => {
    const planned = current === null ? null : planBatcher(choiceNetwork, data, current, CHOICE_HOSTS);
    const chosen = chooseBatcher(choiceNetwork, data, CHOICE_HOSTS, planned?.batcher ?? null, batching);
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
    // No next target: rich can't be prepared on the next's part of the RAM within the horizon either.
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
    const sent = planBatcher(network, data, "n00dles", CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(network, data, CHOICE_HOSTS, sent, "n00dles");
    if (chosen.batcher === null) throw new Error(chosen.why);
    const rich = worthOf(chosen, "rich");
    const n00dles = worthOf(chosen, "n00dles");
    // It earns more once prepared, enough for a move, but isn't worth one over the horizon yet.
    expect(rich.incomePerSecond).toBeGreaterThan(n00dles.incomePerSecond * BATCHER_MOVE_GAIN);
    expect(rich.worth).toBeLessThan(n00dles.worth * BATCHER_MOVE_GAIN);
    expect(chosen.batcher.config.target).toBe("n00dles");
    const whole = planBatcher(network, data, "rich", CHOICE_HOSTS);
    expect(chosen.batcher.config.next).toEqual({
      target: "rich",
      figures: lessRich,
      ramGb: (whole.batcher === null ? 0 : whole.ramGb) * BATCHER_NEXT_RAM_SHARE,
    });
    // The batches are planned on the rest.
    const rest = planBatcher(network, data, "n00dles", CHOICE_HOSTS, null, 1 - BATCHER_NEXT_RAM_SHARE);
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
    const sent = planBatcher(network, data, "slower", CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(network, data, CHOICE_HOSTS, sent, null);
    if (chosen.batcher === null) throw new Error(chosen.why);
    expect(chosen.worths.map((each) => each.target)).toEqual(["slower", "slow"]);
    expect(chosen.worths.map((each) => each.worth)).toEqual([0, 0]);
    expect(worthOf(chosen, "slow").untilEarningMs).toBeLessThan(worthOf(chosen, "slower").untilEarningMs);
    expect(chosen.batcher.config.target).toBe("slow");
  });

  test("none, and why: no hacking figures; no rooted server with money the player can hack", () => {
    expect(chooseBatcher(choiceNetwork, mediumData(100, { rich: true }), CHOICE_HOSTS, null, null)).toEqual({
      batcher: null,
      why: "the medium snapshot has no hacking figures for the player",
    });
    expect(chooseBatcher(choiceNetwork, medium(100, { rich: false }), CHOICE_HOSTS, null, null)).toEqual({
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
      "batcher out of step: 0 desyncs (0 out of order, 0 out of bounds), 1 late, 2 lost, the first seen at " +
        "1970-01-01T00:01:00.000Z",
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
      const sent = planBatcher(network, data, "n00dles", hosts(data, network)).batcher;
      const chosen = chooseBatcher(network, data, hosts(data, network), sent, batching);
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
    const fast = (state: "batching" | "preparing") => ({
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
    const current = sent === null ? null : planBatcher(staticData, data, sent, CHOICE_HOSTS).batcher;
    const chosen = chooseBatcher(staticData, data, CHOICE_HOSTS, current, batching);
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
      planBatcher(staticData, data, "n00dles", CHOICE_HOSTS).batcher?.config.spacingMs,
    );
  });

  test("a target is prepared on the RAM the batched target's batches leave: longer than on all of it", () => {
    const data = choiceMedium(RICH.moneyMax / 50, 3 * RICH.minDifficulty);
    const alone = worthOf(chosenOf(choiceNetwork, data, null, null), "rich");
    const beside = worthOf(chosenOf(choiceNetwork, data, "n00dles", "n00dles"), "rich");
    expect(beside.untilEarningMs).toBeGreaterThan(alone.untilEarningMs);
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
