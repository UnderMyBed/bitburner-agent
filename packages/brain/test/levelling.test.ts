// Levelling (#336): the brain's side of planner v0's first decision. Its figures from the snapshots, the measured rate,
// the rule's choice and hysteresis, and, through the desired state's controller and a real ControlChannel, every
// branch that changes the hack loop, holds money or installs: levelling mode sent in the batcher's place, back to
// money once the level isn't all that's left, A6's NeuroFlux Governor levels and install for the hacking level, none
// without an offer, and money again after the install.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type HackingTarget,
  hackingExpOfLevel,
  LEVEL_LOOP_RAM_GB,
  LEVELLING_INSTALL_MS,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type SnapshotTier,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  readAugmentationCycle,
  writeAugmentationsEnabled,
} from "../src/augmentations.ts";
import { BN1_HACKING } from "../src/batcher.ts";
import { DesiredStateController, type RuleEvent } from "../src/desired-state.ts";
import {
  LEVELLING_CHOSEN_EVENT_KIND,
  LEVELLING_SETTLE_MS,
  LevellingRateWindow,
  LevellingRule,
  type LevellingRuleInputs,
  levelAllThatsLeft,
  levellingFiguresOf,
  settleMsOf,
} from "../src/levelling.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { worldDaemonPath, writeWorldDaemonEnabled } from "../src/world-daemon.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const RED_PILL = "The Red Pill";

/** The game's servers as the static snapshot has them: joesguns the levelling target, ecorp the batcher's. */
const STATIC: StaticSnapshotData = {
  servers: [
    { hostname: "home", purchasedByPlayer: true, moneyMax: 0, minDifficulty: 1, requiredHackingSkill: 1 },
    {
      hostname: "n00dles",
      purchasedByPlayer: false,
      moneyMax: 1.75e6,
      minDifficulty: 1,
      baseDifficulty: 1,
      requiredHackingSkill: 1,
      numOpenPortsRequired: 0,
      serverGrowth: 3000,
    },
    {
      hostname: "joesguns",
      purchasedByPlayer: false,
      moneyMax: 6.25e7,
      minDifficulty: 5,
      baseDifficulty: 15,
      requiredHackingSkill: 10,
      numOpenPortsRequired: 0,
      serverGrowth: 20,
    },
    {
      hostname: "ecorp",
      purchasedByPlayer: false,
      moneyMax: 1.7e12,
      minDifficulty: 33,
      baseDifficulty: 99,
      requiredHackingSkill: 1100,
      numOpenPortsRequired: 5,
      serverGrowth: 99,
    },
    {
      hostname: "w0r1d_d43m0n",
      purchasedByPlayer: false,
      moneyMax: 0,
      minDifficulty: 1,
      baseDifficulty: 1,
      requiredHackingSkill: 3000,
      numOpenPortsRequired: 5,
      serverGrowth: 0,
    },
  ],
};

/** The player at `level` (×2 its multiplier), its experience just past it, with `money`. */
function player(level: number, money: number, expAbove = 0) {
  return {
    skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    exp: { hacking: hackingExpOfLevel(level, 2) + expAbove },
    mults: {
      hacking: 2,
      hacking_exp: 1.5,
      hacking_chance: 1,
      hacking_speed: 1,
      hacking_money: 1,
      hacking_grow: 1,
      faction_rep: 1,
    },
    money,
    city: "Sector-12",
    factions: ["Daedalus"],
  };
}

/** A medium snapshot: w0r1d_d43m0n rooted or not, the cloud server and home of `homeGb`. */
function medium({
  level = 2000,
  money = 1e6,
  expAbove = 0,
  rooted = true,
  homeGb = 4096,
}: {
  level?: number;
  money?: number;
  expAbove?: number;
  rooted?: boolean;
  homeGb?: number;
} = {}): MediumSnapshotData {
  const server = (hostname: string, maxRam: number, hasAdminRights = true, hackDifficulty = 5) => ({
    hostname,
    maxRam,
    cpuCores: 1,
    hasAdminRights,
    backdoorInstalled: false,
    moneyAvailable: 0,
    hackDifficulty,
  });
  return {
    player: player(level, money, expAbove),
    hasTorRouter: true,
    programs: [],
    servers: [
      server("home", homeGb),
      server("n00dles", 4, true, 1),
      server("joesguns", 16),
      server("ecorp", 0, true, 33),
      server("w0r1d_d43m0n", 0, rooted, 1),
      server("pserv-0", 1024),
    ],
  };
}

/** A slow snapshot: The Red Pill installed (or not), `faction` joined with `reputation`, in BN1. */
function slow({
  redPill = true,
  faction = "Daedalus",
  reputation = 1e9,
  lastAugReset = 0,
}: {
  redPill?: boolean;
  faction?: string;
  reputation?: number;
  lastAugReset?: number;
} = {}): SlowSnapshotData {
  return {
    resetInfo: {
      lastAugReset,
      lastNodeReset: 0,
      currentNode: 1,
      ownedAugs: redPill ? { [RED_PILL]: 1 } : {},
      ownedSF: {},
      bitNodeOptions: {},
    },
    purchasedServers: ["pserv-0"],
    factions: {
      backend: "sim",
      state: { joined: [{ name: faction, reputation, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  };
}

describe("levelling mode's figures (#336)", () => {
  test("the target computed (joesguns), the batcher's hosts and home's RAM beyond what it keeps, the player's", () => {
    const figures = levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING);
    expect(figures).toMatchObject({
      target: { hostname: "joesguns" },
      hosts: ["joesguns", "n00dles", "pserv-0"],
      hostsGb: 16 + 4 + 1024,
      homeGb: 4096,
      homeKeptGb: SHARE_HOME_KEPT_GB,
      homeThreads: Math.floor((4096 - SHARE_HOME_KEPT_GB) / LEVEL_LOOP_RAM_GB),
      level: 2000,
      levelMult: 2,
    });
    expect(figures?.threads).toBe(
      Math.floor(16 / 1.75) + Math.floor(4 / 1.75) + Math.floor(1024 / 1.75) + (figures?.homeThreads ?? 0),
    );
    // The player's figures missing: none.
    expect(levellingFiguresOf(STATIC, { ...medium(), player: {} }, slow(), BN1_HACKING)).toBeNull();
    expect(levellingFiguresOf(null, medium(), slow(), BN1_HACKING)).toBeNull();
  });

  test("the level all that's left: The Red Pill installed, w0r1d_d43m0n rooted, its requirement read, the level short", () => {
    const pathOf = (mediumData: MediumSnapshotData, slowData: SlowSnapshotData) =>
      worldDaemonPath({ staticData: STATIC, mediumData, slowData, expPerSecond: null });
    expect(levelAllThatsLeft(pathOf(medium(), slow()))).toBe(true);
    expect(levelAllThatsLeft(pathOf(medium({ rooted: false }), slow()))).toBe(false);
    expect(levelAllThatsLeft(pathOf(medium(), slow({ redPill: false })))).toBe(false);
    expect(levelAllThatsLeft(pathOf(medium({ level: 3000 }), slow()))).toBe(false);
    expect(levelAllThatsLeft(null)).toBe(false);
  });

  test("the measured rate: over the window, at its mean level; a minute first; a fall or a gap starts it again", () => {
    const window = new LevellingRateWindow();
    window.add(0, 1000, 100);
    window.add(30 * SECOND, 4000, 100);
    expect(window.measured()).toBeNull();
    window.add(60 * SECOND, 7000, 102);
    expect(window.measured()).toEqual({ expPerSecond: 100, atLevel: 100.5 });
    window.add(70 * SECOND, 10, 1);
    expect(window.measured()).toBeNull();
  });

  test("a mode settles a minute and the longest weaken still landing, at each target's security now", () => {
    const figures = STATIC.servers[2] as HackingTarget;
    const joesguns = { hostname: "joesguns", figures };
    const settle = settleMsOf(medium(), BN1_HACKING, [joesguns]);
    const weakenMs = ((4 * 5 * (2.5 * figures.requiredHackingSkill * 5 + 500)) / (2000 + 50)) * 1000;
    expect(settle).toBeCloseTo(LEVELLING_SETTLE_MS + weakenMs, 6);
    expect(settleMsOf(medium(), BN1_HACKING, [])).toBe(LEVELLING_SETTLE_MS);
  });
});

describe("the levelling rule (#336)", () => {
  /** Its inputs over the snapshots: medium at `atMs` of the game's time, A6 offering `neuroFluxLevels`. */
  function inputsAt(
    atMs: number,
    {
      level = 2000,
      expAbove = 0,
      neuroFluxLevels = null as number | null,
      installCommitted = false,
      enabled = true,
      slowData = slow(),
    } = {},
  ): LevellingRuleInputs {
    const mediumData = medium({ level, expAbove });
    return {
      path: worldDaemonPath({ staticData: STATIC, mediumData, slowData, expPerSecond: null }),
      enabled,
      staticData: STATIC,
      mediumData,
      mediumGameTimeMs: atMs,
      slowData,
      hacking: BN1_HACKING,
      neuroFluxLevels,
      installCommitted,
      batcherTarget: null,
      nowMs: atMs,
    };
  }
  const events: RuleEvent[] = [];
  const lines: string[] = [];
  beforeEach(() => {
    events.length = 0;
    lines.length = 0;
  });
  const rule = () =>
    new LevellingRule({ log: (line) => lines.push(line), emit: (event) => events.push(event as RuleEvent) });
  /** Money's rate measured: a minute of medium snapshots, the experience rising `perSecond` (slow, as batching ecorp). */
  function measureMoney(levelling: LevellingRule, perSecond: number, fromMs = 0) {
    let plan = levelling.update(inputsAt(fromMs));
    for (let atMs = fromMs; atMs <= fromMs + 70 * SECOND; atMs += 10 * SECOND) {
      plan = levelling.update(inputsAt(atMs, { expAbove: ((atMs - fromMs) / 1000) * perSecond }));
    }
    return plan;
  }

  test("money first, until its rate is measured; then levelling mode, its target and hosts, home's kept RAM", () => {
    const levelling = rule();
    expect(levelling.update(inputsAt(0))).toEqual({ mode: "money", levelling: null });
    expect(levelling.view()).toMatchObject({ applies: true, mode: "money", estimates: { money: null } });
    const plan = measureMoney(levelling, 10);
    expect(plan).toEqual({
      mode: "level",
      levelling: { target: "joesguns", hosts: ["joesguns", "n00dles", "pserv-0"], homeKeptGb: SHARE_HOME_KEPT_GB },
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: LEVELLING_CHOSEN_EVENT_KIND,
        mode: "level",
        from: "money",
        target: "joesguns",
        money: expect.objectContaining({ expPerSecond: expect.closeTo(10, 6) }),
        factor: null,
      }),
    ]);
    expect(lines).toEqual([
      expect.stringMatching(/^levelling: batching for money to levelling mode: batching for money about/),
    ]);
    expect(levelling.view().lines[1]).toContain("chosen: levelling mode on joesguns");
    expect(levelling.view().lines[1]).toContain("not measured yet (1 taken, optimistic)");
  });

  test("hysteresis: money stays while levelling mode isn't 1.25 times shorter", () => {
    // Money's rate within a fifth of levelling mode's prediction: it stays.
    const figures = levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING);
    const predicted = (figures?.target?.expPerThreadSecond ?? 0) * (figures?.threads ?? 0);
    const levelling = rule();
    expect(measureMoney(levelling, predicted * 0.85).mode).toBe("money");
    expect(events).toEqual([]);
  });

  test("levelling mode's fit: its measured rate once settled, against the formula's for the RAM sent", () => {
    const levelling = rule();
    measureMoney(levelling, 10);
    const figures = levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING);
    const predicted = (figures?.target?.expPerThreadSecond ?? 0) * (figures?.threads ?? 0);
    // While it settles, the batcher's last waves land, a burst; then half the formula's rate: the factor 0.5.
    // Chosen at 60 s, as money's rate first spans a minute.
    const startMs = 60 * SECOND + settleMsOf(medium(), BN1_HACKING, figures?.target ? [figures.target] : []);
    const burst = 700 + 1e6;
    for (let atMs = 80 * SECOND; atMs < startMs; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: atMs < 100 * SECOND ? 700 : burst }));
    }
    for (let atMs = startMs; atMs <= startMs + 2 * MINUTE; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: burst + ((atMs - startMs) / 1000) * predicted * 0.5 }));
    }
    expect(levelling.view().fit?.factor).toBeCloseTo(0.5, 2);
    expect(levelling.view().lines[1]).toMatch(/fitted factor 0\.50 \(measured .*\/s, the formula .*\/s\)/);
  });

  test("the install: chosen with A6's levels on offer, held while A6 commits; back to money after the reset", () => {
    const levelling = rule();
    // Levels on offer from the start: once money's rate is measured, the install is the shortest.
    let plan = levelling.update(inputsAt(0, { neuroFluxLevels: 30 }));
    for (let atMs = 0; atMs <= 70 * SECOND; atMs += 10 * SECOND) {
      plan = levelling.update(inputsAt(atMs, { neuroFluxLevels: 30, expAbove: atMs / 100 }));
    }
    expect(plan.mode).toBe("install");
    expect((levelling.view().estimates?.install as number) * 1000).toBeGreaterThan(LEVELLING_INSTALL_MS);
    // Levelling mode meanwhile: the experience before the install is lost anyway.
    expect(plan.levelling?.target).toBe("joesguns");
    // A6 committed, its money spent on the levels (none on offer now): still the install.
    expect(levelling.update(inputsAt(80 * SECOND, { neuroFluxLevels: null, installCommitted: true })).mode).toBe(
      "install",
    );
    // Not committed, and nothing on offer: chosen afresh.
    expect(levelling.update(inputsAt(90 * SECOND, { neuroFluxLevels: null })).mode).toBe("level");
    // The reset: money, w0r1d_d43m0n not rooted yet.
    const after = levelling.update(inputsAt(100 * SECOND, { slowData: slow({ lastAugReset: 99 * SECOND }) }));
    expect(after.mode).toBe("money");
  });

  test("back to money once the level isn't all that's left: reached, or the World Daemon's switch off", () => {
    for (const changes of [{ level: 3000 }, { enabled: false }]) {
      const levelling = rule();
      measureMoney(levelling, 10);
      expect(levelling.mode()).toBe("level");
      expect(levelling.update(inputsAt(80 * SECOND, changes))).toEqual({ mode: "money", levelling: null });
      expect(events.at(-1)).toMatchObject({ mode: "money", from: "level" });
      expect(levelling.view()).toMatchObject({ applies: false, lines: [] });
      events.length = 0;
    }
  });
});

describe("the controller (#336): every branch that changes the hack loop, holds money or installs", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "levelling-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function connectAgent(): MemoryConnection {
    const connection = new MemoryConnection();
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
    return connection;
  }
  const send = (connection: MemoryConnection, tier: SnapshotTier, data: unknown, gameTimeMs: number) =>
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
  const lastDesired = (connection: MemoryConnection) =>
    connection
      .sentMessages()
      .filter((message) => message.type === "desiredState")
      .at(-1) as unknown as DesiredState | undefined;
  /** The Agent's snapshots for a minute and more: experience rising slowly, as batching ecorp. */
  function aMinuteOf(
    connection: MemoryConnection,
    { money = 1e6, slowData = slow(), fromMs = 1_000, level = 2000 } = {},
  ) {
    send(connection, "static", STATIC, fromMs);
    send(connection, "slow", slowData, fromMs);
    for (let atMs = fromMs; atMs <= fromMs + 80 * SECOND; atMs += 10 * SECOND) {
      send(connection, "medium", medium({ level, money, expAbove: (atMs - fromMs) / 100 }), atMs);
      if (atMs % (60 * SECOND) === 1_000) send(connection, "slow", slowData, atMs);
    }
  }

  test("levelling mode goes in the batcher's place: the level loop on its hosts, home's kept RAM; no income expected", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    // A6 off: no install on offer, so levelling mode is the shortest.
    writeAugmentationsEnabled(store, false);
    aMinuteOf(connection);
    const state = lastDesired(connection);
    expect(state?.hackLoop).toEqual({
      enabled: true,
      target: "joesguns",
      hosts: ["joesguns", "n00dles", "pserv-0"],
      levelling: { homeKeptGb: SHARE_HOME_KEPT_GB },
    });
    expect(state?.batcher ?? null).toBeNull();
    expect(controller.hackLoopView()).toMatchObject({ target: "joesguns", levelling: true });
    expect(controller.batcherView().why).toBe("levelling mode on joesguns has its hosts (#336)");
    expect(controller.levellingView()).toMatchObject({ applies: true, mode: "level", target: "joesguns" });
    // The dashboard's path names the candidates and the choice.
    expect(controller.worldDaemonView().lines).toContainEqual(
      expect.stringMatching(/^levelling \(the hacking level all that's left, #336\): batching for money about/),
    );
  });

  test("back to the hack loop and the batcher once the level isn't all that's left (the World Daemon's switch off)", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    writeAugmentationsEnabled(store, false);
    aMinuteOf(connection);
    expect(lastDesired(connection)?.hackLoop.levelling).toEqual({ homeKeptGb: SHARE_HOME_KEPT_GB });
    writeWorldDaemonEnabled(store, false);
    send(connection, "medium", medium({ level: 2000, expAbove: 1000 }), 100 * SECOND);
    expect(lastDesired(connection)?.hackLoop.levelling).toBeUndefined();
    expect(controller.levellingView().mode).toBe("money");
    expect(controller.hackLoopView().levelling).toBeUndefined();
  });

  test("the install for the hacking level: A6 buys NeuroFlux Governor's levels, then installs; the reason said", () => {
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    // $1t buys NeuroFlux Governor's levels at CyberSec (its reputation reaches them, after its own few augmentations,
    // the set A6 buys first): the install is the shortest.
    const slowData = slow({ faction: "CyberSec" });
    aMinuteOf(connection, { money: 1e12, slowData });
    send(connection, "medium", medium({ level: 2000, money: 1e12, expAbove: 1000 }), 100 * SECOND);
    send(connection, "slow", slowData, 100 * SECOND);
    const levellingEvents = events.filter((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND);
    expect(levellingEvents.at(-1)).toMatchObject({ mode: "install", neuroFluxLevels: expect.any(Number) });
    const chosen = events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND);
    expect(chosen).toEqual([expect.objectContaining({ reason: "the hacking level" })]);
    // Its purchases asked for at CyberSec, its set first, NeuroFlux Governor's levels after; the hack loop levelling
    // meanwhile.
    const state = lastDesired(connection);
    expect(state?.intents).toContainEqual(
      expect.objectContaining({
        action: "purchaseAugmentation",
        args: expect.objectContaining({ faction: "CyberSec" }),
      }),
    );
    expect(controller.augmentationsView().committed).toBe(true);
    // NeuroFlux Governor's levels counted at the commit, bought after the set, then the install.
    expect(readAugmentationCycle(store)).toMatchObject({
      reason: "the hacking level",
      neuroFluxTarget: expect.any(Number),
    });
    expect(readAugmentationCycle(store)?.neuroFluxTarget).toBeGreaterThan(0);
    expect(state?.hackLoop.levelling).toEqual({ homeKeptGb: SHARE_HOME_KEPT_GB });
  });

  test("no install without A6's offer: the switch off, or no faction's reputation reaching a level", () => {
    for (const setUp of [() => writeAugmentationsEnabled(store, false), () => {}]) {
      const controller = new DesiredStateController({ channel, store });
      const events: RuleEvent[] = [];
      controller.subscribe((event) => events.push(event));
      const connection = connectAgent();
      setUp();
      // Daedalus's reputation under a level's 500, or the switch off: nothing on offer.
      aMinuteOf(connection, { money: 1e12, slowData: slow({ reputation: 100 }) });
      expect(controller.levellingView().mode).toBe("level");
      expect(events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([]);
      expect(controller.augmentationsView().committed).toBe(false);
      writeAugmentationsEnabled(store, true);
    }
  });
});
