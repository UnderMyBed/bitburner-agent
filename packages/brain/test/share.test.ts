// Sharing spare RAM for faction reputation (#224), the brain's side: its switch, when it asks the batcher to share,
// the reserve and cores it sends, the bonus it counts in its faction work's rate, the dashboard's view, and the run
// report's lines and their two failures.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  type BatcherConfig,
  type BatcherHealth,
  batchPlan,
  batchRamGb,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  newBatcherHealth,
  type SharingHealth,
  type SnapshotTier,
  type StaticSnapshotData,
  shareReserveGb,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HOME_KEPT_FOR_THE_AGENT_GB } from "../src/batcher.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { FactionRule } from "../src/factions.ts";
import {
  factionWorkGoingOn,
  readShareEnabled,
  SHARE_ENABLED_SETTING,
  shareBonusOf,
  sharingConfigOf,
  sharingOf,
  writeShareEnabled,
} from "../src/share.ts";
import { SHARE_IDLE_AFTER_MS, sharingLines } from "../src/share-report.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 };
const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
const network: StaticSnapshotData = {
  servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles", N00DLES), staticServer("foodnstuff")],
};
/** A medium snapshot with the player's figures, as the real worker sends them (`ns.getPlayer()`). */
function medium(hacking: number, rooted: Record<string, boolean>, factions: string[] = []): MediumSnapshotData {
  const data = mediumData(hacking, rooted, { factions });
  const skills = { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 };
  return { ...data, player: { ...data.player, skills, mults: { ...MULTS, faction_rep: 1 } } };
}

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "share-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("the switch: on unless the owner turned it off (decision 52)", () => {
  expect(readShareEnabled(store)).toBe(true);
  writeShareEnabled(store, false);
  expect(store.getSetting(SHARE_ENABLED_SETTING)).toBe("false");
  expect(readShareEnabled(store)).toBe(false);
});

test("faction work goes on: the work sent is faction work, and the Agent says the game shows it", () => {
  const work = { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true } as const;
  const converged = { converged: true, problem: null, backend: "sim" };
  expect(factionWorkGoingOn(work, converged)).toBe(true);
  expect(factionWorkGoingOn(work, { ...converged, converged: false })).toBe(false);
  expect(factionWorkGoingOn(work, null)).toBe(false);
  expect(factionWorkGoingOn(work, "junk")).toBe(false);
  expect(factionWorkGoingOn({ kind: "crime", crime: "Mug", focus: true }, converged)).toBe(false);
  expect(factionWorkGoingOn(null, converged)).toBe(false);
});

describe("sharingConfigOf", () => {
  const player = { skills: { hacking: 50, intelligence: 0 }, mults: MULTS };
  const plan = batchPlan(N00DLES, player, batchRamGb([16, 16])) as NonNullable<ReturnType<typeof batchPlan>>;
  const config: BatcherConfig = {
    target: "n00dles",
    figures: N00DLES,
    player: { intelligence: 0, mults: MULTS },
    hosts: ["foodnstuff", "CSEC"],
    hackShare: plan.hackShare,
    spacingMs: plan.spacingMs,
  };

  test("the reserve covers the plan's peak with the margin, and the next target's RAM; home keeps the Agent's", () => {
    const data = medium(50, { foodnstuff: true, CSEC: true });
    expect(sharingConfigOf(config, data)).toEqual({
      reserveGb: shareReserveGb(plan.peakRamGb, 0),
      homeKeptGb: HOME_KEPT_FOR_THE_AGENT_GB,
      cores: {},
    });
    expect(shareReserveGb(plan.peakRamGb, 0)).toBeGreaterThanOrEqual(plan.peakRamGb * 1.25);
    const next = { target: "foodnstuff", figures: N00DLES, ramGb: 6.4 };
    expect(sharingConfigOf({ ...config, next }, data)?.reserveGb).toBe(shareReserveGb(plan.peakRamGb, 6.4));
  });

  test("the hosts' cores over 1, from the medium snapshot; none without the player's hacking figures", () => {
    const data = medium(50, { foodnstuff: true, CSEC: true, "omega-net": true });
    data.servers = data.servers.map((server) => ({ ...server, cpuCores: server.hostname === "foodnstuff" ? 1 : 3 }));
    // omega-net isn't a host: left out.
    expect(sharingConfigOf(config, data)?.cores).toEqual({ CSEC: 3 });
    expect(sharingConfigOf(config, mediumData(50, { foodnstuff: true }))).toBeNull();
  });
});

describe("the bonus counted", () => {
  const sharing = (changes: Partial<SharingHealth>): BatcherHealth => ({
    ...newBatcherHealth("n00dles", "r", 0),
    sharing: { wanted: true, threads: 1_000, ramGb: 4_000, bonus: 1.28, roomGb: 0, ...changes },
  });

  test("the batcher's, while its threads run; 1 with none, without health, or with a report that isn't one", () => {
    expect(shareBonusOf(sharing({}))).toBe(1.28);
    expect(shareBonusOf(sharing({ threads: 0, bonus: 1 }))).toBe(1);
    // A bonus with no threads running isn't one.
    expect(shareBonusOf(sharing({ threads: 0, bonus: 1.3 }))).toBe(1);
    expect(shareBonusOf(null)).toBe(1);
    expect(shareBonusOf(newBatcherHealth("n00dles", "r", 0))).toBe(1);
    expect(shareBonusOf(sharing({ bonus: Number.NaN }))).toBe(1);
    expect(shareBonusOf(sharing({ bonus: 0.5 }))).toBe(1);
    expect(sharingOf({ sharing: { wanted: "yes", threads: 1, ramGb: 4, bonus: 1, roomGb: 0 } })).toBeNull();
    expect(sharingOf({ sharing: { wanted: true, threads: -1, ramGb: 4, bonus: 1, roomGb: 0 } })).toBeNull();
  });

  test("the faction rule's rate and ETA count it: hacking work's x the bonus", () => {
    const inputs = {
      mediumData: medium(100, {}, ["CyberSec"]),
      slowData: {
        resetInfo: {
          lastAugReset: 0,
          lastNodeReset: 0,
          currentNode: 1,
          ownedAugs: {},
          ownedSF: {},
          bitNodeOptions: {},
        },
        purchasedServers: [],
        factions: {
          backend: "sim" as const,
          state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
          problem: null,
        },
      },
      slowAtMs: 1,
      nowMs: 1,
      ownersWork: false,
      enabled: true,
    };
    const without = new FactionRule({});
    without.update(inputs);
    const sharing = new FactionRule({});
    sharing.update({ ...inputs, shareBonus: 1.5 });
    const plain = without.view().choice;
    const shared = sharing.view().choice;
    expect(plain?.workType).toBe("hacking");
    expect(shared?.reputationPerSecond).toBeCloseTo((plain?.reputationPerSecond ?? 0) * 1.5, 12);
    expect(shared?.etaSeconds).toBeCloseTo((plain?.etaSeconds ?? 0) / 1.5, 9);
  });
});

/** An Agent connects to `channel`, and is welcomed; then its snapshots, and the desired states sent. */
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

const fast = (work: unknown, batcher: BatcherHealth | null = null) => ({
  degradedTiers: [],
  pageHeapUsedBytes: null,
  game: null,
  intents: [],
  dialogs: { handled: [], blocking: null },
  work,
  batcher,
});

test("the controller asks the batcher to share while faction work goes on, with its switch on; logged; viewed", () => {
  const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  const log: string[] = [];
  const controller = new DesiredStateController({ channel, store, log: (line) => log.push(line) });
  const agent = connectedAgent(channel);
  const rooted = { n00dles: true, foodnstuff: true };
  agent.send("static", network);
  agent.send("slow", {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    factions: { backend: "sim", state: { joined: [], invitations: [], queuedAugmentations: [] }, problem: null },
  });
  agent.send("medium", medium(50, rooted));
  // No work going on: the batcher, no sharing.
  expect(agent.lastSent()?.batcher?.config.target).toBe("n00dles");
  expect(agent.lastSent()?.batcher?.config.sharing).toBeUndefined();
  expect(controller.shareView()).toEqual({
    enabled: true,
    asked: false,
    why: "no faction work going on",
    sharing: null,
  });
  // The owner's faction work, sent; the Agent says the game shows it: sharing, with the reserve for the plan sent.
  expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
  expect(agent.lastSent()?.batcher?.config.sharing).toBeUndefined();
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }));
  agent.send("medium", medium(50, rooted));
  const config = agent.lastSent()?.batcher?.config as BatcherConfig;
  expect(config.sharing).toEqual(sharingConfigOf({ ...config, sharing: undefined }, medium(50, rooted)));
  expect(config.sharing?.reserveGb).toBeGreaterThan(0);
  expect(log).toContain("batcher: batches n00dles, sharing its spare RAM");
  expect(controller.shareView()).toMatchObject({ enabled: true, asked: true, why: null });
  // Its report, in the view.
  const health = {
    ...newBatcherHealth("n00dles", "r", 0),
    state: "batching" as const,
    sharing: { wanted: true, threads: 8, ramGb: 32, bonus: 1 + Math.log(9) / 25, roomGb: 0 },
  };
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }, health));
  expect(controller.shareView().sharing).toEqual(health.sharing);
  // Switched off: no sharing, at once; on again: back.
  controller.setShareEnabled(false);
  expect(agent.lastSent()?.batcher?.config.sharing).toBeUndefined();
  expect(controller.shareView()).toMatchObject({ enabled: false, asked: false, why: null });
  expect(log).toContain("batcher: batches n00dles");
  controller.setShareEnabled(true);
  expect(agent.lastSent()?.batcher?.config.sharing).toBeDefined();
  // The work no longer showing in the game: none.
  agent.send("fast", fast({ converged: false, problem: "the Work page isn't up", backend: "sim" }));
  agent.send("medium", medium(50, rooted));
  expect(agent.lastSent()?.batcher?.config.sharing).toBeUndefined();
  // Without the batcher, nothing shares: the hack loop's hosts are its own.
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }));
  controller.setBatcherEnabled(false);
  expect(agent.lastSent()?.batcher).toBeUndefined();
  expect(controller.shareView()).toMatchObject({ enabled: true, asked: false, why: "the batcher isn't sent" });
});

describe("the run report's lines", () => {
  const at = (seconds: number) => 1_767_225_600_000 + seconds * 1000;
  const health = (
    sharing: Partial<SharingHealth> | null,
    changes: Partial<BatcherHealth> = {},
  ): Partial<BatcherHealth> => ({
    ...newBatcherHealth("n00dles", "a", 0),
    state: "batching",
    sharing: sharing === null ? null : { wanted: true, threads: 0, ramGb: 0, bonus: 1, roomGb: 0, ...sharing },
    ...changes,
  });
  const sharingAt = (threads: number, bonus: number) => ({ threads, ramGb: threads * 4, bonus });

  test("never asked: one line, no failure", () => {
    const failures: string[] = [];
    expect(sharingLines([{ atMs: at(0), health: health(null) }], [], failures)).toEqual([
      "  sharing spare RAM (#224):",
      "    never asked, and no share threads",
    ]);
    expect(failures).toEqual([]);
  });

  test("shared: its time, threads, RAM and bonus, and the faction work's reputation with it and without", () => {
    const points = [];
    // 140 s not sharing, then 220 s sharing, the last with twice the threads; a fast snapshot every 2 s.
    for (let second = 0; second <= 360; second += 2) {
      const sharing = second <= 140 ? { wanted: false } : { wanted: true, ...sharingAt(1_000, 1.25) };
      points.push({
        atMs: at(second),
        health: health(second === 360 ? { ...sharing, ...sharingAt(2_000, 1.25) } : sharing),
      });
    }
    // CyberSec's reputation, a slow snapshot a minute: 1/s without, 1.25/s with.
    const readings = [
      { atMs: at(0), faction: "CyberSec", reputation: 0 },
      { atMs: at(60), faction: "CyberSec", reputation: 60 },
      { atMs: at(120), faction: "CyberSec", reputation: 120 },
      // Mixed: left out.
      { atMs: at(180), faction: "CyberSec", reputation: 190 },
      { atMs: at(240), faction: "CyberSec", reputation: 265 },
      { atMs: at(300), faction: "CyberSec", reputation: 340 },
    ];
    const failures: string[] = [];
    const lines = sharingLines(points, readings, failures);
    expect(lines).toEqual([
      "  sharing spare RAM (#224):",
      "    shared for 4 min: threads at most 2,000, 1,009 on average; RAM at most 8,000 GB, 4,036 GB on average; " +
        "the bonus at most x1.250, x1.250 on average",
      "    the brain's faction work while sharing: +150 reputation in 2 min (1.25/s, the bonus x1.250 on average); " +
        "while not: +120 in 2 min (1.00/s) (x1.25)",
      "    while sharing: 0 late, 0 lost, 0 short; before it first shared: 0 late, 0 lost, 0 short",
      "    idle (asked, the room free, no threads, for 10 minutes): never",
    ]);
    expect(failures).toEqual([]);
  });

  test("share starved batches: late, lost or short while sharing, none before it first shared, a failure", () => {
    const failures: string[] = [];
    const lines = sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true }) },
        { atMs: at(2), health: health({ wanted: true, ...sharingAt(10, 1.1) }) },
        { atMs: at(4), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 2, late: 1 }) },
      ],
      [],
      failures,
    );
    const line =
      "share starved batches: 1 late, 0 lost, 2 short while sharing, none before it first shared at 2026-01-01T00:00:02.000Z";
    expect(failures).toEqual([line]);
    expect(lines).toContain(`    ${line}`);
    expect(lines).toContain(
      "    while sharing: 1 late, 0 lost, 2 short; before it first shared: 0 late, 0 lost, 0 short",
    );
    // Some before: not the share's doing; the batcher's own out-of-step failure still counts the late.
    const before: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true }) },
        { atMs: at(2), health: health({ wanted: true }, { late: 1 }) },
        { atMs: at(4), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { late: 2 }) },
      ],
      [],
      before,
    );
    expect(before).toEqual([]);
    // Another run's counts start from 0: no rise across runs.
    const restarted: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { late: 3 }) },
        { atMs: at(2), health: { ...health({ wanted: true, ...sharingAt(10, 1.1) }), runName: "b" } },
      ],
      [],
      restarted,
    );
    expect(restarted).toEqual([]);
  });

  test("share idle: asked while batching, the room free and no threads for 10 minutes, a failure", () => {
    const idleFor = (ms: number, changes: Partial<SharingHealth> = {}, state: BatcherHealth["state"] = "batching") => {
      const points = [];
      for (let ms2 = 0; ms2 <= ms; ms2 += 2_000) {
        points.push({ atMs: at(ms2 / 1000), health: health({ wanted: true, roomGb: 400, ...changes }, { state }) });
      }
      const failures: string[] = [];
      return { lines: sharingLines(points, [], failures), failures };
    };
    const idle = idleFor(SHARE_IDLE_AFTER_MS);
    expect(idle.failures).toEqual([
      "share idle from 2026-01-01T00:00:00.000Z to 2026-01-01T00:10:00.000Z (10 min): asked while batching, the " +
        "room free, and no share threads",
    ]);
    expect(idle.lines).toContain("    asked, and never shared");
    // Under 10 minutes; no room; not asked; preparing; or threads running: none.
    expect(idleFor(SHARE_IDLE_AFTER_MS - 2_000).failures).toEqual([]);
    expect(idleFor(SHARE_IDLE_AFTER_MS, { roomGb: 3 }).failures).toEqual([]);
    expect(idleFor(SHARE_IDLE_AFTER_MS, { wanted: false }).failures).toEqual([]);
    expect(idleFor(SHARE_IDLE_AFTER_MS, {}, "preparing").failures).toEqual([]);
    expect(idleFor(SHARE_IDLE_AFTER_MS, sharingAt(1, 1)).failures).toEqual([]);
  });
});

test("the controller's faction work counts the bonus the batcher reports: its rate and ETA, while threads run", () => {
  const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  const controller = new DesiredStateController({ channel, store });
  const agent = connectedAgent(channel);
  const rooted = { n00dles: true, foodnstuff: true };
  agent.send("static", network);
  agent.send("slow", {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: "sim",
      state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  });
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  const plain = controller.factionsView().choice;
  expect(plain).toMatchObject({ faction: "CyberSec", workType: "hacking" });
  const health = (threads: number, bonus: number) => ({
    ...newBatcherHealth("n00dles", "r", 0),
    state: "batching" as const,
    sharing: { wanted: true, threads, ramGb: threads * 4, bonus, roomGb: 0 },
  });
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }, health(1_000, 1.5)));
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  const shared = controller.factionsView().choice;
  expect(shared?.reputationPerSecond).toBeCloseTo((plain?.reputationPerSecond ?? 0) * 1.5, 12);
  expect(shared?.etaSeconds).toBeCloseTo((plain?.etaSeconds ?? 0) / 1.5, 9);
  // Its threads ended: the rate without.
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }, health(0, 1)));
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  expect(controller.factionsView().choice?.reputationPerSecond).toBeCloseTo(plain?.reputationPerSecond ?? 0, 12);
});
