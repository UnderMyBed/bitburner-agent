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
  BLADEBURNER_WORKER_RAM_GB,
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
import { BN1_HACKING, HOME_KEPT_FOR_THE_AGENT_GB } from "../src/batcher.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { bestWorkRate, FactionRule, WORK_TYPE_SWITCH_GAIN } from "../src/factions.ts";
import {
  factionWorkGoingOn,
  homeBatchesWhileSharing,
  homeKeptGbOf,
  readShareEnabled,
  SHARE_ENABLED_SETTING,
  SHARE_HOME_KEPT_GB,
  shareBonusOf,
  sharingConfigOf,
  sharingOf,
  singularityInEffect,
  singularityRamMultiplierOf,
  writeShareEnabled,
} from "../src/share.ts";
import { SHARE_IDLE_AFTER_MS, sharingLines } from "../src/share-report.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { worldDaemonPath } from "../src/world-daemon.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MULTS = { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1, hacking: 1, hacking_exp: 1 };
const N00DLES = { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 };
const network: StaticSnapshotData = {
  servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles", N00DLES), staticServer("foodnstuff")],
};
/** A medium snapshot with the player's figures, as the real worker sends them (`ns.getPlayer()`). */
function medium(
  hacking: number,
  rooted: Record<string, boolean>,
  factions: string[] = [],
  homeRam?: number,
): MediumSnapshotData {
  const data = mediumData(hacking, rooted, { factions, ...(homeRam === undefined ? {} : { homeRam }) });
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

test("Singularity in effect (#226's review): in BN4, or with SF4", () => {
  const slow = (currentNode: number, ownedSF: Record<string, number>) =>
    ({ resetInfo: { currentNode, ownedSF } }) as unknown as Parameters<typeof singularityInEffect>[0];
  expect(singularityInEffect(slow(1, {}))).toBe(false);
  expect(singularityInEffect(slow(4, {}))).toBe(true);
  expect(singularityInEffect(slow(1, { 4: 1 }))).toBe(true);
  expect(singularityInEffect(null)).toBe(false);
  // Its functions' RAM multiplier (#242's review: RamCostGenerator.ts:82-95), or null without it.
  expect(singularityRamMultiplierOf(slow(1, {}))).toBeNull();
  expect(singularityRamMultiplierOf(slow(4, {}))).toBe(1);
  expect(singularityRamMultiplierOf(slow(4, { 4: 1 }))).toBe(1);
  expect(singularityRamMultiplierOf(slow(1, { 4: 1 }))).toBe(16);
  expect(singularityRamMultiplierOf(slow(1, { 4: 2 }))).toBe(4);
  expect(singularityRamMultiplierOf(slow(1, { 4: 3 }))).toBe(1);
  expect(singularityRamMultiplierOf(null)).toBeNull();
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
    expect(sharingConfigOf(config, data, BN1_HACKING)).toEqual({
      reserveGb: shareReserveGb(plan.peakRamGb, 0),
      homeKeptGb: SHARE_HOME_KEPT_GB,
      cores: {},
    });
    // In BN4 (#321) a hack thread takes a fifth, so the plan's share needs more threads: a larger peak to keep free.
    const inBn4 = sharingConfigOf(config, data, { ...BN1_HACKING, ScriptHackMoney: 0.2, HackExpGain: 0.4 });
    expect(inBn4?.reserveGb).toBeGreaterThan(shareReserveGb(plan.peakRamGb, 0));
    // Home keeps 4 times the Agent's 8 GB free of share threads (#226's review); with Singularity, the most its largest
    // worker, the destroy's 33.9 GB at SF4.3, takes at the SF4 level owned beside that (#242's review): not all of
    // home.
    expect(SHARE_HOME_KEPT_GB).toBe(4 * HOME_KEPT_FOR_THE_AGENT_GB);
    const withHome = medium(50, { foodnstuff: true, CSEC: true }, [], 2 ** 20);
    expect(sharingConfigOf(config, withHome, BN1_HACKING, 1)?.homeKeptGb).toBeCloseTo(SHARE_HOME_KEPT_GB + 33.9, 9);
    expect(sharingConfigOf(config, withHome, BN1_HACKING, 4)?.homeKeptGb).toBeCloseTo(
      SHARE_HOME_KEPT_GB + 1.6 + 4 * 32.3,
      9,
    );
    expect(sharingConfigOf(config, withHome, BN1_HACKING, 16)?.homeKeptGb).toBeCloseTo(
      SHARE_HOME_KEPT_GB + 1.6 + 16 * 32.3,
      9,
    );
    expect(sharingConfigOf(config, withHome, BN1_HACKING, null)?.homeKeptGb).toBe(SHARE_HOME_KEPT_GB);
    expect(shareReserveGb(plan.peakRamGb, 0)).toBeGreaterThanOrEqual(plan.peakRamGb * 1.25);
    const next = { target: "foodnstuff", figures: N00DLES, ramGb: 6.4 };
    expect(sharingConfigOf({ ...config, next }, data, BN1_HACKING)?.reserveGb).toBe(
      shareReserveGb(plan.peakRamGb, 6.4),
    );
  });

  test("the hosts' cores over 1, from the medium snapshot; none without the player's hacking figures", () => {
    const data = medium(50, { foodnstuff: true, CSEC: true, "omega-net": true });
    data.servers = data.servers.map((server) => ({ ...server, cpuCores: server.hostname === "foodnstuff" ? 1 : 3 }));
    // omega-net isn't a host: left out. Home, which shares beside the hosts, is in (#226's review).
    expect(sharingConfigOf(config, data, BN1_HACKING)?.cores).toEqual({ CSEC: 3 });
    const withHome = medium(50, { foodnstuff: true, CSEC: true }, [], 64);
    withHome.servers = withHome.servers.map((server) => ({ ...server, cpuCores: server.hostname === "home" ? 8 : 1 }));
    expect(sharingConfigOf(config, withHome, BN1_HACKING)?.cores).toEqual({ home: 8 });
    expect(sharingConfigOf(config, mediumData(50, { foodnstuff: true }), BN1_HACKING)).toBeNull();
  });
});

describe("the bonus counted", () => {
  const sharing = (changes: Partial<SharingHealth>): BatcherHealth => ({
    ...newBatcherHealth("n00dles", "r", 0),
    sharing: { wanted: true, threads: 1_000, ramGb: 4_000, hostsRamGb: 4_000, bonus: 1.28, roomGb: 0, ...changes },
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
    // A stopped batcher's (#226's review): its health 20 s old or more by the game's clock, or reported not running.
    expect(shareBonusOf({ ...sharing({}), atMs: 100_000 }, 120_000)).toBe(1.28);
    expect(shareBonusOf({ ...sharing({}), atMs: 100_000 }, 120_001)).toBe(1);
    expect(shareBonusOf({ ...sharing({}), atMs: 100_000 }, 101_000, true)).toBe(1);
    expect(sharingOf({ sharing: { wanted: "yes", threads: 1, ramGb: 4, bonus: 1, roomGb: 0 } })).toBeNull();
    expect(sharingOf({ sharing: { wanted: true, threads: -1, ramGb: 4, bonus: 1, roomGb: 0 } })).toBeNull();
    // Its RAM on the batches' hosts (#230): checked; absent (a batcher before #230), all of its RAM counts.
    const where = { wanted: true, threads: 2, ramGb: 8, bonus: 1, roomGb: 0 };
    expect(sharingOf({ sharing: { ...where, hostsRamGb: 4 } })?.hostsRamGb).toBe(4);
    expect(sharingOf({ sharing: where })?.hostsRamGb).toBe(8);
    expect(sharingOf({ sharing: { ...where, hostsRamGb: -4 } })).toBeNull();
    expect(sharingOf({ sharing: { ...where, hostsRamGb: Number.NaN } })).toBeNull();
    expect(sharingOf({ sharing: { ...where, hostsRamGb: "4" } })).toBeNull();
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
  expect(config.sharing).toEqual(sharingConfigOf({ ...config, sharing: undefined }, medium(50, rooted), BN1_HACKING));
  expect(config.sharing?.reserveGb).toBeGreaterThan(0);
  expect(log).toContain("batcher: batches n00dles, sharing its spare RAM");
  expect(controller.shareView()).toMatchObject({ enabled: true, asked: true, why: null });
  // Its report, in the view.
  const health = {
    ...newBatcherHealth("n00dles", "r", 0),
    state: "batching" as const,
    sharing: { wanted: true, threads: 8, ramGb: 32, hostsRamGb: 32, bonus: 1 + Math.log(9) / 25, roomGb: 0 },
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

test("home among the batcher's hosts (#340): the share keeps on home what the batches do, the one reserve", () => {
  const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  const controller = new DesiredStateController({ channel, store });
  const agent = connectedAgent(channel);
  const rooted = { n00dles: true, foodnstuff: true };
  agent.send("static", network);
  // BN4 (#242's review): home keeps the largest Singularity worker's RAM too.
  agent.send("slow", {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 4, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    factions: { backend: "sim", state: { joined: [], invitations: [], queuedAugmentations: [] }, problem: null },
  });
  expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }));
  agent.send("medium", medium(50, rooted, [], 4_096));
  const config = agent.lastSent()?.batcher?.config as BatcherConfig;
  expect(config.hosts).toEqual(["foodnstuff", "n00dles", "home"]);
  const kept = homeKeptGbOf(singularityRamMultiplierOf(slowData(4)));
  expect(kept).toBeGreaterThan(SHARE_HOME_KEPT_GB);
  expect(config.homeKeptGb).toBe(kept);
  expect(config.sharing?.homeKeptGb).toBe(kept);
});

test("beside Bladeburner's reading worker (#377's re-review): the share keeps its 42.6 GB too, in the division", () => {
  const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
  channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  const controller = new DesiredStateController({ channel, store });
  const agent = connectedAgent(channel);
  const rooted = { n00dles: true, foodnstuff: true };
  agent.send("static", network);
  agent.send("slow", slowData(6));
  // Your faction work (the actions held for it): faction work goes on, so the batcher shares.
  expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }));
  const base = medium(50, rooted, [], 4_096);
  const combat = { strength: 100, defense: 100, dexterity: 100, agility: 100 };
  const inDivision = (joined: boolean): MediumSnapshotData => ({
    ...base,
    player: {
      ...base.player,
      skills: { ...(base.player as { skills: object }).skills, ...combat },
      exp: { strength: 1e4, defense: 1e4, dexterity: 1e4, agility: 1e4 },
      mults: {
        ...MULTS,
        faction_rep: 1,
        ...Object.fromEntries(
          Object.keys(combat).flatMap((stat) => [
            [stat, 1],
            [`${stat}_exp`, 1],
          ]),
        ),
      },
      money: 1e6,
      city: "Sector-12",
    },
    inBladeburner: joined,
  });
  const kept = homeKeptGbOf(singularityRamMultiplierOf(slowData(6)));
  agent.send("medium", inDivision(true));
  expect(agent.lastSent()?.bladeburner).toEqual({ joinTheFaction: false });
  expect(agent.lastSent()?.batcher?.config.sharing?.homeKeptGb).toBeCloseTo(kept + BLADEBURNER_WORKER_RAM_GB, 9);
  // Out of it (trained, not joined): no worker, nothing more kept.
  agent.send("medium", inDivision(false));
  expect(agent.lastSent()?.bladeburner).toBeUndefined();
  expect(agent.lastSent()?.batcher?.config.sharing?.homeKeptGb).toBe(kept);
});

describe("home's batches against its share while sharing is asked (#340's review, a placeholder)", () => {
  test("home batches only if the batches' income gains more with it, relatively, than the share's bonus on it", () => {
    const on = (withHome: number, withoutHome: number, homeShareGb = 4_000) =>
      homeBatchesWhileSharing({
        withHomeIncomePerSecond: withHome,
        withoutHomeIncomePerSecond: withoutHome,
        homeShareGb,
        homeCores: 1,
        intelligence: 0,
      });
    // 1,000 threads: 1 + ln(1,001)/25, a gain of 0.2763.
    const shareGain = Math.log(1_001) / 25;
    expect(on(1.27, 1).shareGain).toBeCloseTo(shareGain, 12);
    expect(on(1.28, 1)).toMatchObject({ batches: true });
    expect(on(1.27, 1)).toMatchObject({ batches: false });
    expect(on(1.28, 1).incomeGain).toBeCloseTo(0.28, 12);
    // No income without home: home batches. None either way: it shares.
    expect(on(1, 0)).toMatchObject({ batches: true, incomeGain: Number.POSITIVE_INFINITY });
    expect(on(0, 0)).toMatchObject({ batches: false });
    // Home's cores and the player's intelligence raise the share's side.
    const cored = homeBatchesWhileSharing({
      withHomeIncomePerSecond: 1.28,
      withoutHomeIncomePerSecond: 1,
      homeShareGb: 4_000,
      homeCores: 8,
      intelligence: 0,
    });
    expect(cored.batches).toBe(false);
  });

  /** The controller with faction work going on (or not), the hosts' RAM and home's as given; what it sends and logs. */
  function sentWith(hostsGb: number, homeGb: number, working: boolean) {
    const channel = new ControlChannel({ token: "the-token", clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const log: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => log.push(line) });
    const agent = connectedAgent(channel);
    agent.send("static", network);
    agent.send("slow", slowData(1));
    const data = medium(50, { n00dles: true, foodnstuff: true }, [], homeGb);
    data.servers = data.servers.map((server) =>
      server.hostname === "foodnstuff" ? { ...server, maxRam: hostsGb } : server,
    );
    if (working) {
      expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
      agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }));
    }
    agent.send("medium", data);
    return { config: agent.lastSent()?.batcher?.config as BatcherConfig, log };
  }

  test("run #3's late shape, 1.6 PB of hosts beside a 64 TB home on n00dles: sharing, home shares; not, it batches", () => {
    const sharing = sentWith(25 * 65_536, 65_536, true);
    expect(sharing.config.hosts).toEqual(["foodnstuff", "n00dles"]);
    expect(sharing.config).not.toHaveProperty("homeKeptGb");
    expect(sharing.config.sharing).toMatchObject({ homeKeptGb: SHARE_HOME_KEPT_GB });
    expect(sharing.log).toContain(
      "batcher: batches n00dles, sharing its spare RAM, home sharing rather than batching (#340's placeholder)",
    );
    expect(sentWith(25 * 65_536, 65_536, false).config.hosts).toEqual(["foodnstuff", "n00dles", "home"]);
  });

  test("a little more income than nothing, less than the share on home's RAM: home shares (1.6 TB of hosts, 96 GB home)", () => {
    // The plan held to the hosts' RAM: home's 60 GB beyond what it keeps and the batcher's budget add about 4%; its 15
    // share threads, 1 + ln(16)/25, 11%.
    const sharing = sentWith(1_600, 96, true);
    expect(sharing.config.hosts).toEqual(["foodnstuff", "n00dles"]);
    expect(sentWith(1_600, 96, false).config).toMatchObject({
      hosts: ["foodnstuff", "n00dles", "home"],
      ramBound: true,
    });
  });

  test("after an install's shape, 32 GB of hosts beside a 4 TB home: home batches though sharing is asked", () => {
    const sharing = sentWith(16, 4_096, true);
    expect(sharing.config).toMatchObject({ hosts: ["foodnstuff", "n00dles", "home"], homeKeptGb: SHARE_HOME_KEPT_GB });
    expect(sharing.config.sharing).toBeDefined();
    expect(sharing.log.some((line) => line.includes("home sharing rather than batching"))).toBe(false);
  });
});

describe("the run report's lines", () => {
  const at = (seconds: number) => 1_767_225_600_000 + seconds * 1000;
  const health = (
    sharing: Partial<SharingHealth> | null,
    changes: Partial<BatcherHealth> = {},
  ): Partial<BatcherHealth> => ({
    ...newBatcherHealth("n00dles", "a", 0),
    state: "batching",
    sharing:
      sharing === null ? null : { wanted: true, threads: 0, ramGb: 0, hostsRamGb: 0, bonus: 1, roomGb: 0, ...sharing },
    ...changes,
  });
  /** Share threads on the batches' hosts; `onHomeAt`, on home alone, beside them (#230). */
  const sharingAt = (threads: number, bonus: number) => ({
    threads,
    ramGb: threads * 4,
    hostsRamGb: threads * 4,
    bonus,
  });
  const onHomeAt = (threads: number, bonus: number) => ({ ...sharingAt(threads, bonus), hostsRamGb: 0 });

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
        health: health(second === 360 ? { ...sharing, ...sharingAt(2_000, 1.25) } : sharing, { atMs: at(second) }),
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
      "    the bonus while asked (#242): not judged: a batcher before #242 doesn't say the bonus possible",
      "    the brain's faction work while sharing: +150 reputation in 2 min (1.25/s, the bonus x1.250 on average); " +
        "while not: +120 in 2 min (1.00/s) (x1.25)",
      "    while sharing on the batches' hosts: 0 late, 0 lost, 0 short; on home alone: 0 late, 0 lost, 0 short; " +
        "while not: 0 late, 0 lost, 0 short",
      "    idle (asked, the room free, no threads, for 10 minutes): never",
      "    home idle while asked (#242): not judged: a batcher before #242 doesn't say home's RAM",
    ]);
    expect(failures).toEqual([]);
  });

  test("#242: the bonus while asked against the possible, the time at x1.000, home left idle", () => {
    // 6 minutes asked with home idle (run #3's 12:22: no threads, the room 0, home's RAM free), then 6 minutes sharing.
    const points = [];
    for (let second = 0; second <= 720; second += 2) {
      const sharing =
        second <= 360
          ? { wanted: true, possibleBonus: 1.4, homeGb: 1_032, homeFreeGb: 900, homeKeptGb: 32 }
          : {
              wanted: true,
              ...sharingAt(1_000, 1.4),
              possibleBonus: 1.42,
              homeGb: 1_032,
              homeFreeGb: 0,
              homeKeptGb: 32,
            };
      points.push({ atMs: at(second), health: health(sharing, { atMs: at(second) }) });
    }
    const failures: string[] = [];
    const lines = sharingLines(points, [], failures);
    const line =
      "share left home idle from 2026-01-01T00:00:00.000Z to 2026-01-01T00:06:00.000Z (6 min): asked, and over half " +
      "of the 1,000 GB home may share free";
    expect(failures).toEqual([line]);
    expect(lines).toEqual([
      "  sharing spare RAM (#224):",
      "    shared for 6 min: threads at most 1,000, 1,000 on average; RAM at most 4,000 GB, 4,000 GB on average; " +
        "the bonus at most x1.400, x1.400 on average",
      "    the bonus while asked (#242): x1.200 on average, of x1.410 possible under the share's rules; " +
        "at x1.000 for 6 min (50% of 12 min asked)",
      "    the brain's faction work while sharing: none to judge",
      "    while sharing on the batches' hosts: 0 late, 0 lost, 0 short; on home alone: 0 late, 0 lost, 0 short; " +
        "while not: 0 late, 0 lost, 0 short",
      "    idle (asked, the room free, no threads, for 10 minutes): never",
      `    ${line}`,
    ]);
    const idleFor = (sharing: Partial<SharingHealth>, lastSecond: number) => {
      const found: string[] = [];
      const each = [];
      for (let second = 0; second <= lastSecond; second += 2) {
        each.push({
          atMs: at(second),
          health: health({ wanted: true, possibleBonus: 1, ...sharing }, { atMs: at(second) }),
        });
      }
      return { lines: sharingLines(each, [], found), failures: found };
    };
    const idleHome = { homeGb: 1_032, homeFreeGb: 900, homeKeptGb: 32 };
    // Exactly 5 minutes is a failure; a moment under isn't.
    expect(idleFor(idleHome, 300).failures).toHaveLength(1);
    expect(idleFor(idleHome, 298).failures).toEqual([]);
    expect(idleFor(idleHome, 298).lines).toContain(
      "    home idle while asked (over half of what it may share free, for 5 minutes, #242): never",
    );
    // Half of what home may share (its RAM beyond what it keeps), not of its RAM (#242's review): a 64 GB home keeping
    // 32 fails with 17 GB free, not with 16; one that keeps all of it, or under a thread, never.
    expect(idleFor({ homeGb: 64, homeFreeGb: 17, homeKeptGb: 32 }, 300).failures).toHaveLength(1);
    expect(idleFor({ homeGb: 64, homeFreeGb: 16, homeKeptGb: 32 }, 300).failures).toEqual([]);
    expect(idleFor({ homeGb: 64, homeFreeGb: 3, homeKeptGb: 61 }, 300).failures).toEqual([]);
    // Not asked isn't idle; a gap in the fast snapshots breaks a stretch.
    expect(idleFor({ ...idleHome, wanted: false }, 400).failures).toEqual([]);
    const gapped: string[] = [];
    sharingLines(
      points.filter(({ atMs }) => atMs < at(60) || atMs > at(120)),
      [],
      gapped,
    );
    expect(gapped).toEqual([]);
  });

  test("#242: a batcher before it says no bonus possible nor home's RAM: not judged; odd figures aren't kept", () => {
    const old = [0, 2, 4].map((second) => ({ atMs: at(second), health: health({}) }));
    const lines = sharingLines(old, [], []);
    expect(lines).toContain(
      "    the bonus while asked (#242): not judged: a batcher before #242 doesn't say the bonus possible",
    );
    expect(lines).toContain(
      "    home idle while asked (#242): not judged: a batcher before #242 doesn't say home's RAM",
    );
    // Never asked: neither line.
    const unasked = [0, 2].map((second) => ({
      atMs: at(second),
      health: health({ wanted: false, ...sharingAt(5, 1.1) }),
    }));
    expect(sharingLines(unasked, [], []).some((each) => /#242/.test(each))).toBe(false);
    // An older batcher, then a newer one: judged on the newer's.
    const mixed = [
      ...old,
      ...[6, 8].map((second) => ({
        atMs: at(second),
        health: health({ possibleBonus: 1.2, homeGb: 64, homeFreeGb: 0, homeKeptGb: 32 }),
      })),
    ];
    expect(sharingLines(mixed, [], [])).toEqual(
      expect.arrayContaining([
        "    the bonus while asked (#242): x1.000 on average, of x1.200 possible under the share's rules; " +
          "at x1.000 for 0 min (100% of 0 min asked)",
        "    home idle while asked (over half of what it may share free, for 5 minutes, #242): never",
      ]),
    );
    expect(sharingOf(health({ possibleBonus: Number.NaN, homeGb: 64, homeFreeGb: -1 }))).not.toHaveProperty(
      "possibleBonus",
    );
    expect(sharingOf(health({ homeGb: 64, homeFreeGb: -1 }))).not.toHaveProperty("homeGb");
    expect(sharingOf(health({ homeKeptGb: -1 }))).not.toHaveProperty("homeKeptGb");
    expect(sharingOf(health({ possibleBonus: 1.2, homeGb: 64, homeFreeGb: 12, homeKeptGb: 32 }))).toMatchObject({
      possibleBonus: 1.2,
      homeGb: 64,
      homeFreeGb: 12,
      homeKeptGb: 32,
    });
  });

  test("share starved batches (#226's review): batches short of RAM while sharing, on their own terms, a failure", () => {
    const failures: string[] = [];
    const lines = sharingLines(
      [
        { atMs: at(-2), health: health({ wanted: true }) },
        { atMs: at(0), health: health({ wanted: true }, { late: 1 }) },
        { atMs: at(2), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { late: 2 }) },
        { atMs: at(4), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 2, late: 3 }) },
        { atMs: at(6), health: health({ wanted: true }, { batchesShort: 3, late: 3 }) },
        { atMs: at(8), health: health({ wanted: true }, { batchesShort: 4, late: 3 }) },
      ],
      [],
      failures,
    );
    // A late one before sharing doesn't mute it; late and lost are the batcher's out-of-step failure, not this one.
    const line =
      "share starved batches: 3 batches short of RAM while sharing on the batches' hosts, the first seen at " +
      "2026-01-01T00:00:04.000Z";
    expect(failures).toEqual([line]);
    expect(lines).toContain(`    ${line}`);
    expect(lines).toContain(
      "    while sharing on the batches' hosts: 2 late, 0 lost, 3 short; on home alone: 0 late, 0 lost, 0 short; " +
        "while not: 1 late, 0 lost, 1 short",
    );
    // Late or lost while sharing, and short while not: no failure of its own.
    const others: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true }) },
        { atMs: at(2), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { late: 1, lost: 1 }) },
        { atMs: at(14), health: health({ wanted: true }, { late: 1, lost: 1 }) },
        { atMs: at(16), health: health({ wanted: true }, { late: 1, lost: 1, batchesShort: 5 }) },
      ],
      [],
      others,
    );
    expect(others).toEqual([]);
    // Another run's counts start from 0: no rise across runs.
    const restarted: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 3 }) },
        { atMs: at(2), health: { ...health({ wanted: true, ...sharingAt(10, 1.1) }), runName: "b" } },
      ],
      [],
      restarted,
    );
    expect(restarted).toEqual([]);
  });

  test("share starved batches (#232's review): batches trimmed for the share's threads on the batches' hosts too", () => {
    // The batcher trims a batch the RAM doesn't hold, never short; one it would have planned larger without the share's
    // threads on its hosts is the share's (`batchesTrimmedBySharing`), a lost hack as a short is.
    const failures: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...sharingAt(10, 1.1) }) },
        { atMs: at(2), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesTrimmedBySharing: 2 }) },
        { atMs: at(4), health: health({ wanted: true }, { batchesTrimmedBySharing: 2, batchesTrimmed: 5 }) },
      ],
      [],
      failures,
    );
    expect(failures).toEqual([
      "share starved batches: 2 batches trimmed to the RAM its threads left (#232) while sharing on the batches' " +
        "hosts, the first seen at 2026-01-01T00:00:02.000Z",
    ]);
    // Short and trimmed: both counted.
    const both: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...sharingAt(10, 1.1) }) },
        {
          atMs: at(2),
          health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 1, batchesTrimmedBySharing: 1 }),
        },
      ],
      [],
      both,
    );
    expect(both).toEqual([
      "share starved batches: 1 batch short of RAM and 1 batch trimmed to the RAM its threads left (#232) while " +
        "sharing on the batches' hosts, the first seen at 2026-01-01T00:00:02.000Z",
    ]);
    // An older batcher doesn't count them: none.
    const older: string[] = [];
    sharingLines(
      [
        {
          atMs: at(0),
          health: { ...health({ wanted: true, ...sharingAt(10, 1.1) }), batchesTrimmedBySharing: undefined },
        },
        {
          atMs: at(2),
          health: { ...health({ wanted: true, ...sharingAt(10, 1.1) }), batchesTrimmedBySharing: undefined },
        },
      ],
      [],
      older,
    );
    expect(older).toEqual([]);
  });

  test("a run that starts in the window (#232's review): counted from 0, as the batcher's section counts it", () => {
    // Its first snapshot's short, beside a share on its hosts then, is the share's; the window's first counts from
    // there.
    const failures: string[] = [];
    sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 4 }) },
        {
          atMs: at(2),
          health: { ...health({ wanted: true, ...sharingAt(10, 1.1) }, { batchesShort: 1 }), runName: "b" },
        },
      ],
      [],
      failures,
    );
    expect(failures).toEqual([
      "share starved batches: 1 batch short of RAM while sharing on the batches' hosts, the first seen at " +
        "2026-01-01T00:00:02.000Z",
    ]);
  });

  test("short while the share is on home alone (#230): shown apart, no share failure (the batcher's own, #232)", () => {
    // #229's augmentations suite: home shares beside the hosts, whose reserve leaves them none, and batches come up
    // short of their own (the same batches with sharing off).
    const failures: string[] = [];
    const lines = sharingLines(
      [
        { atMs: at(0), health: health({ wanted: true, ...onHomeAt(6, 1.08) }) },
        { atMs: at(2), health: health({ wanted: true, ...onHomeAt(6, 1.08) }, { batchesShort: 1 }) },
        { atMs: at(4), health: health({ wanted: true, ...onHomeAt(6, 1.08) }, { batchesShort: 2, late: 1 }) },
        { atMs: at(6), health: health({ wanted: true }, { batchesShort: 3, late: 1 }) },
        // Then on its hosts too: short beside it is the share's.
        { atMs: at(8), health: health({ wanted: true, ...sharingAt(8, 1.08) }, { batchesShort: 3, late: 1 }) },
        { atMs: at(10), health: health({ wanted: true, ...sharingAt(8, 1.08) }, { batchesShort: 4, late: 1 }) },
      ],
      [],
      failures,
    );
    expect(lines).toContain(
      "    while sharing on the batches' hosts: 0 late, 0 lost, 1 short; on home alone: 1 late, 0 lost, 3 short; " +
        "while not: 0 late, 0 lost, 0 short",
    );
    expect(failures).toEqual([
      "share starved batches: 1 batch short of RAM while sharing on the batches' hosts, the first seen at " +
        "2026-01-01T00:00:10.000Z",
    ]);
    // A batcher before #230 doesn't say where its share is: all of it counts as on its hosts.
    const older: string[] = [];
    const { hostsRamGb: _hostsRamGb, ...withoutWhere } = health({ wanted: true, ...onHomeAt(6, 1.08) }).sharing ?? {};
    sharingLines(
      [
        { atMs: at(0), health: { ...health(null), sharing: withoutWhere } },
        { atMs: at(2), health: { ...health(null, { batchesShort: 1 }), sharing: withoutWhere } },
      ],
      [],
      older,
    );
    expect(older).toEqual([
      "share starved batches: 1 batch short of RAM while sharing on the batches' hosts, the first seen at " +
        "2026-01-01T00:00:02.000Z",
    ]);
  });

  test("a stopped batcher's last health (#226's review): its sharing not counted once 20 s old, nor its idle", () => {
    // The same health, written once, read in every fast snapshot for 5 minutes.
    const points = [];
    for (let second = 0; second <= 300; second += 2) {
      points.push({ atMs: at(second), health: health({ wanted: true, roomGb: 400, ...sharingAt(1_000, 1.25) }) });
    }
    const failures: string[] = [];
    const lines = sharingLines(points, [], failures);
    expect(lines[1]).toMatch(/^ {4}shared for 0 min:/);
    // Asked, with room and no threads, but its health 11 minutes old: not idle, stopped (the batcher's own checks say).
    const stopped = [];
    for (let second = 0; second <= 660; second += 2) {
      stopped.push({ atMs: at(second), health: health({ wanted: true, roomGb: 400 }) });
    }
    const idle: string[] = [];
    sharingLines(stopped, [], idle);
    expect(idle).toEqual([]);
  });

  test("home among the batcher's hosts (#340): no home figures beside them, so judged with the batches, not idle", () => {
    const points = [];
    const home = { gb: 4_096, keptGb: 32, freeGb: 4_000, batchesGb: 0 };
    for (let second = 0; second <= 400; second += 2) {
      points.push({ atMs: at(second), health: health({ possibleBonus: 1 }, { atMs: at(second), home }) });
    }
    const failures: string[] = [];
    const lines = sharingLines(points, [], failures);
    expect(failures).toEqual([]);
    expect(lines.at(-1)).toBe(
      "    home idle while asked, among the batcher's hosts (#340): shared as they are, judged with the batches",
    );
  });

  test("share idle: asked while batching, the room free and no threads for 10 minutes, a failure", () => {
    const idleFor = (ms: number, changes: Partial<SharingHealth> = {}, state: BatcherHealth["state"] = "batching") => {
      const points = [];
      for (let ms2 = 0; ms2 <= ms; ms2 += 2_000) {
        points.push({
          atMs: at(ms2 / 1000),
          health: health({ wanted: true, roomGb: 400, ...changes }, { state, atMs: at(ms2 / 1000) }),
        });
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
    sharing: { wanted: true, threads, ramGb: threads * 4, hostsRamGb: threads * 4, bonus, roomGb: 0 },
  });
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }, health(1_000, 1.5)));
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  const shared = controller.factionsView().choice;
  expect(shared?.reputationPerSecond).toBeCloseTo((plain?.reputationPerSecond ?? 0) * 1.5, 12);
  expect(shared?.etaSeconds).toBeCloseTo((plain?.etaSeconds ?? 0) / 1.5, 9);
  // The batcher reported not running (#226's review): its last health's bonus no longer counts.
  const stopped = { running: null, started: false, stopped: 0, problem: "no room on foodnstuff" };
  agent.send("fast", {
    ...fast({ converged: true, problem: null, backend: "sim" }, health(1_000, 1.5)),
    batcherDeploy: stopped,
  });
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  expect(controller.factionsView().choice?.reputationPerSecond).toBeCloseTo(plain?.reputationPerSecond ?? 0, 12);
  // Its threads ended: the rate without.
  agent.send("fast", fast({ converged: true, problem: null, backend: "sim" }, health(0, 1)));
  agent.send("medium", medium(100, rooted, ["CyberSec"]));
  expect(controller.factionsView().choice?.reputationPerSecond).toBeCloseTo(plain?.reputationPerSecond ?? 0, 12);
});

test("the work type worked is kept against the bonus's swings (#226's review): another must earn 1.1 times as much", () => {
  // MegaCorp offers all three. Hacking work earns 1.08 times security's here, 1.32 times field's.
  const person = {
    skills: { hacking: 330, strength: 300, defense: 300, dexterity: 300, agility: 300, charisma: 1, intelligence: 0 },
    mults: { faction_rep: 1 },
  };
  const faction = { name: "MegaCorp", reputation: 0, favor: 0 };
  const conditions = {
    sourceFile15Level: 0,
    focused: true,
    implant: false,
    factionWorkRepGain: 1,
    favorToDonateToFaction: 1,
  };
  const keep = (workType: "hacking" | "field" | "security", name = faction.name) => ({
    ...conditions,
    keep: { faction: name, workType },
  });
  const best = bestWorkRate(person, faction, conditions);
  expect(best?.workType).toBe("hacking");
  // Security within 10% of hacking's: kept, at its own rate.
  const security = bestWorkRate(person, faction, keep("security"));
  expect(security?.workType).toBe("security");
  expect((best?.perSecond ?? 0) / (security?.perSecond ?? 1)).toBeLessThan(WORK_TYPE_SWITCH_GAIN);
  // Field far behind: not kept. Another faction's work changes nothing here.
  expect(bestWorkRate(person, faction, keep("field"))).toEqual(best);
  expect(bestWorkRate(person, faction, keep("security", "CyberSec"))).toEqual(best);
});

test("The Red Pill's rate on the World Daemon's path counts the bonus (#226's review)", () => {
  const network: StaticSnapshotData = { servers: [staticServer("home", { moneyMax: 0 })] };
  const data = medium(1_000, {}, ["Daedalus"]);
  const slowData = {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: "sim" as const,
      state: { joined: [{ name: "Daedalus", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  };
  const at = (shareBonus?: number) =>
    worldDaemonPath({ staticData: network, mediumData: data, slowData, expPerSecond: null, shareBonus }).redPill;
  const plain = at();
  expect(plain?.perSecond).toBeGreaterThan(0);
  expect(at(1.5)?.perSecond).toBeCloseTo((plain?.perSecond ?? 0) * 1.5, 12);
});

test("the faction rule keeps the work type worked as the bonus swings (#226's review), until another earns 1.1 times", () => {
  // MegaCorp: security work earns most at no bonus; at x1.15 hacking work earns 1.04 times as much; at x1.6, 1.33 times.
  const data = medium(300, {}, ["MegaCorp"]);
  const combat = { strength: 330, defense: 330, dexterity: 330, agility: 330, charisma: 1 };
  data.player = { ...data.player, skills: { ...(data.player.skills as object), ...combat } };
  const inputs = {
    mediumData: data,
    slowData: {
      resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs: {}, ownedSF: {}, bitNodeOptions: {} },
      purchasedServers: [],
      factions: {
        backend: "sim" as const,
        state: { joined: [{ name: "MegaCorp", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
        problem: null,
      },
    },
    slowAtMs: 1,
    nowMs: 1,
    ownersWork: false,
    enabled: true,
  };
  const rule = new FactionRule({});
  const workType = (shareBonus: number) => rule.update({ ...inputs, shareBonus }).work?.workType;
  expect(workType(1)).toBe("security");
  expect(workType(1.15)).toBe("security");
  expect(workType(1.6)).toBe("hacking");
  // A rule with no work sent picks the best at once.
  expect(new FactionRule({}).update({ ...inputs, shareBonus: 1.15 }).work?.workType).toBe("hacking");
});
