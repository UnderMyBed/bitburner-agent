// Levelling (#336): the brain's side of planner v0's first decision. Its figures from the snapshots, the measured rate,
// the rule's choice and hysteresis, and, through the desired state's controller and a real ControlChannel, every
// branch that changes the hack loop, holds money or installs: levelling mode sent in the batcher's place, back to
// money once the level isn't all that's left, A6's NeuroFlux Governor levels and install for the hacking level, none
// without an offer, and money again after the install; the install with A6's set alone (#355), in BN2 with the gang's
// shop's, and in BN4 with a plain faction's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  addsToLevelling,
  augmentationsSoldBy,
  BLADEBURNER_WORKER_RAM_GB,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type HackingTarget,
  hackingExpOfLevel,
  hackingLevelOfExp,
  LEVEL_LOOP_RAM_GB,
  LEVELLING_INSTALL_MS,
  LEVELLING_REROOT_MS,
  type LevellingEstimates,
  levellingInstallMultipliers,
  levellingPreparationMs,
  type MediumSnapshotData,
  NEUROFLUX_GOVERNOR,
  neuroFluxMultipliers,
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
import { levellingEstimateMs } from "../src/destroy-estimate.ts";
import { HACK_LOOP_ENABLED_SETTING } from "../src/hack-loop.ts";
import {
  describeEstimate,
  describeEstimates,
  LEVELLING_CHOSEN_EVENT_KIND,
  LEVELLING_INCOME_WAIT_MS,
  LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS,
  LEVELLING_SETTLE_MS,
  type LevellingEvent,
  LevellingRateWindow,
  LevellingRule,
  type LevellingRuleInputs,
  LevelOnlyClock,
  levelAllThatsLeft,
  levellingFiguresOf,
  levellingHopelessFailure,
  levellingInputsOf,
  settleMsOf,
} from "../src/levelling.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { writeSwitch } from "../src/switches.ts";
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

/** The player at `level` (×`mult` its multiplier, 2 unless given), its experience just past it, with `money`. */
function player(level: number, money: number, expAbove = 0, mult = 2) {
  return {
    skills: { hacking: level, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    exp: { hacking: hackingExpOfLevel(level, mult) + expAbove },
    mults: {
      hacking: mult,
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
  joesgunsSecurity = 5,
  joesgunsMoney = 6.25e7,
  gang,
  mult = 2,
}: {
  level?: number;
  money?: number;
  expAbove?: number;
  rooted?: boolean;
  homeGb?: number;
  joesgunsSecurity?: number;
  /** joesguns' money: its maximum by default, so (at its minimum security too) the grow. */
  joesgunsMoney?: number;
  /** The gang worker's reading (BN2), absent none. */
  gang?: unknown;
  /** The level's multiplier (#380's cases: 8, so levelling mode takes hours): 2 unless given. */
  mult?: number;
} = {}): MediumSnapshotData {
  const server = (hostname: string, maxRam: number, hasAdminRights = true, hackDifficulty = 5, moneyAvailable = 0) => ({
    hostname,
    maxRam,
    cpuCores: 1,
    hasAdminRights,
    backdoorInstalled: false,
    moneyAvailable,
    hackDifficulty,
  });
  return {
    player: player(level, money, expAbove, mult),
    hasTorRouter: true,
    programs: [],
    servers: [
      server("home", homeGb),
      server("n00dles", 4, true, 1),
      server("joesguns", 16, true, joesgunsSecurity, joesgunsMoney),
      server("ecorp", 0, true, 33),
      server("w0r1d_d43m0n", 0, rooted, 1),
      server("pserv-0", 1024),
    ],
    ...(gang === undefined ? {} : { gang }),
  } as MediumSnapshotData;
}

/** The gang worker's reading of a gang formed with NiteSec (BN2), no members yet: the gang's faction known. */
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

/** A slow snapshot: The Red Pill installed (or not), `faction` joined with `reputation`, in BN1 or `currentNode`. */
function slow({
  redPill = true,
  faction = "Daedalus",
  reputation = 1e9,
  lastAugReset = 0,
  currentNode = 1,
  neuroFluxLevel = 0,
  favor = 0,
  lastNodeReset = -10 * 60 * MINUTE,
}: {
  redPill?: boolean;
  faction?: string;
  reputation?: number;
  lastAugReset?: number;
  currentNode?: number;
  /** NeuroFlux Governor's level installed: its next level's reputation 500 × 1.14 to it (`Augmentations.ts:1159`). */
  neuroFluxLevel?: number;
  /** `faction`'s favour: 0 unless given; 150 or more unlocks its donations (#380's case). */
  favor?: number;
  /** The BitNode's start: 10 h before the game's time 0 unless given (#382's review: (d)'s batching bound). */
  lastNodeReset?: number;
} = {}): SlowSnapshotData {
  return {
    resetInfo: {
      lastAugReset,
      lastNodeReset,
      currentNode,
      ownedAugs: {
        ...(redPill ? { [RED_PILL]: 1 } : {}),
        ...(neuroFluxLevel > 0 ? { [NEUROFLUX_GOVERNOR]: neuroFluxLevel } : {}),
      },
      ownedSF: {},
      bitNodeOptions: {},
    },
    purchasedServers: ["pserv-0"],
    factions: {
      backend: "sim",
      state: { joined: [{ name: faction, reputation, favor }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  };
}

describe("levelling mode's figures (#336)", () => {
  test("(c) after the install at the grow's rate, after its preparation at the levels' level and speed", () => {
    // Weakened now (above its minimum): the target's operation the weaken, but (c)'s the grow, prepared first.
    const figures = levellingFiguresOf(STATIC, medium({ joesgunsSecurity: 15 }), slow(), BN1_HACKING);
    expect(figures?.target?.operation).toBe("weaken");
    const inputs = levellingInputsOf(figures as NonNullable<typeof figures>, 3000, null, null, 5);
    expect(inputs.install?.perThread.expPerSecond).toBe(figures?.afterInstall?.expPerThreadSecond);
    expect((inputs.install?.perThread.expPerSecond ?? 0) / (figures?.target?.expPerThreadSecond ?? 1)).toBeCloseTo(
      1.25,
      12,
    );
    // The preparation: core's, at hacking from 0 experience at ×2 × 1.01^5 and the speed × 1.01^5, on home's threads.
    const neuroFlux = neuroFluxMultipliers();
    const after = {
      skills: { hacking: hackingLevelOfExp(0, 2 * neuroFlux.hacking ** 5), intelligence: 0 },
      mults: { hacking_chance: 1, hacking_speed: neuroFlux.hackingSpeed ** 5, hacking_money: 1, hacking_grow: 1 },
    };
    const expected = levellingPreparationMs(
      figures?.afterInstall?.figures as HackingTarget,
      after,
      figures?.homeThreads ?? 0,
    );
    expect(inputs.install?.preparationMs).toBeCloseTo(expected, 6);
    expect(expected).toBeGreaterThan(0);
  });

  test("(c) with A6's set (#355): offered with no level, at the set's multipliers, prepared at its level and speed", () => {
    const figures = levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING) as NonNullable<
      ReturnType<typeof levellingFiguresOf>
    >;
    const set = ["QLink", "BitRunners Neurolink"];
    const alone = levellingInputsOf(figures, 3000, null, null, 0, set);
    expect(alone.install).toMatchObject({ levels: 0, augmentations: set, homeThreads: figures.homeThreads });
    // The preparation at the level from 0 experience at ×2 × the set's, and the speed × the set's.
    const gain = levellingInstallMultipliers(0, set);
    const after = {
      skills: { hacking: hackingLevelOfExp(0, 2 * gain.hacking), intelligence: 0 },
      mults: { hacking_chance: 1, hacking_speed: gain.hackingSpeed, hacking_money: 1, hacking_grow: 1 },
    };
    const target = figures.afterInstall?.figures as HackingTarget;
    expect(alone.install?.preparationMs).toBeCloseTo(levellingPreparationMs(target, after, figures.homeThreads), 6);
    expect(alone.install?.preparationMs).not.toBeCloseTo(
      levellingInputsOf(figures, 3000, null, null, 1).install?.preparationMs as number,
      3,
    );
    // With levels too, both; with no set, as before #355.
    expect(levellingInputsOf(figures, 3000, null, null, 5, set).install).toMatchObject({
      levels: 5,
      augmentations: set,
    });
    expect(levellingInputsOf(figures, 3000, null, null, 5).install).not.toHaveProperty("augmentations");
    // Nothing offered (null: A6 not holding for the destroy), a set adding nothing to levelling, or nothing: none.
    expect(levellingInputsOf(figures, 3000, null, null, null, set).install).toBeNull();
    expect(levellingInputsOf(figures, 3000, null, null, 0, ["Combat Rib I"]).install).toBeNull();
    expect(levellingInputsOf(figures, 3000, null, null, 0).install).toBeNull();
  });

  test("the estimates in words: hours to a tenth, past a million hours 3 figures (#355's review), never, none", () => {
    expect(describeEstimate(2307.7 * 3600)).toBe("about 2307.7 h");
    expect(describeEstimate(41 * 60)).toBe("about 41 min");
    expect(describeEstimate(1.2827388715587469e193 * 3600)).toBe("about 1.28e+193 h");
    expect(describeEstimate(1e6 * 3600)).toBe("about 1.00e+6 h");
    expect(describeEstimate(999_999 * 3600)).toBe("about 999999.0 h");
    expect(describeEstimate(Number.POSITIVE_INFINITY)).toBe("never");
    expect(describeEstimate(null)).toBe("none");
  });

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
    // Beside Bladeburner's reading worker (#377's re-review): its 50.6 GB kept from home's loops too, while the rule
    // asks for it (the controller's `homeAlsoKeptGb`); without it, none.
    expect(levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING, BLADEBURNER_WORKER_RAM_GB)).toMatchObject({
      homeKeptGb: SHARE_HOME_KEPT_GB + BLADEBURNER_WORKER_RAM_GB,
      homeThreads: Math.floor((4096 - SHARE_HOME_KEPT_GB - BLADEBURNER_WORKER_RAM_GB) / LEVEL_LOOP_RAM_GB),
    });
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

  test("(d)'s income (#380): the money's rises over the same window; a purchase's fall counts nothing; unread, none", () => {
    const window = new LevellingRateWindow();
    window.add(0, 1000, 100, 1e6);
    window.add(30 * SECOND, 2000, 100, 4e6);
    expect(window.income()).toBeNull();
    // $3m, then a purchase of $2m (a fall: none counted, not −2m), then $5m: $8m in a minute.
    window.add(40 * SECOND, 2500, 100, 2e6);
    window.add(60 * SECOND, 3000, 100, 7e6);
    expect(window.income()).toBeCloseTo(8e6 / 60, 6);
    // A sample's money unread: none.
    window.add(70 * SECOND, 3500, 100, null);
    expect(window.income()).toBeNull();
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

/** Home's level loop threads in the test's figures: 4,096 GB less 32, at 1.75 GB. */
const HOME_THREADS = Math.floor((4096 - SHARE_HOME_KEPT_GB) / 1.75);

describe("the levelling rule (#336)", () => {
  /** Its inputs over the snapshots: medium at `atMs` of the game's time, A6 offering `neuroFluxLevels`. */
  function inputsAt(
    atMs: number,
    {
      level = 2000,
      expAbove = 0,
      neuroFluxLevels = null as number | null,
      installAugmentations = undefined as string[] | undefined,
      installCommitted = false,
      enabled = true,
      slowData = slow(),
      levelLoop = { sent: true, homeThreads: HOME_THREADS },
      joesgunsSecurity = 5,
      joesgunsMoney = 6.25e7,
      homeGb = 4096,
      money = 1e6,
      mult = 2,
      batchOffer = undefined as LevellingRuleInputs["batchOffer"],
    } = {},
  ): LevellingRuleInputs {
    const mediumData = medium({ level, expAbove, joesgunsSecurity, joesgunsMoney, homeGb, money, mult });
    return {
      path: worldDaemonPath({ staticData: STATIC, mediumData, slowData, expPerSecond: null }),
      enabled,
      staticData: STATIC,
      mediumData,
      mediumGameTimeMs: atMs,
      slowData,
      hacking: BN1_HACKING,
      neuroFluxLevels,
      ...(installAugmentations === undefined ? {} : { installAugmentations }),
      installCommitted,
      batcherTarget: null,
      levelLoop,
      nowMs: atMs,
      ...(batchOffer === undefined ? {} : { batchOffer }),
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
  const figures = levellingFiguresOf(STATIC, medium(), slow(), BN1_HACKING);
  /** The formula's rate in levelling mode on the test's RAM: joesguns' grow. */
  const predicted = (figures?.target?.expPerThreadSecond ?? 0) * (figures?.threads ?? 0);
  /** A mode's settle here: a minute and joesguns' weaken at its minimum (no batcher). */
  const SETTLE_MS = settleMsOf(medium(), BN1_HACKING, figures?.target ? [figures.target] : []);
  /**
   * Money's rate measured: medium snapshots every 10 s from 0, the experience rising `perSecond` (slow, as batching
   * ecorp), until the mode changes or 4 minutes: the first update settles, then a minute's span.
   */
  function measureMoney(levelling: LevellingRule, perSecond: number, more: Parameters<typeof inputsAt>[1] = {}) {
    let plan = levelling.update(inputsAt(0, more));
    let atMs = 0;
    for (; atMs <= 4 * MINUTE && plan.mode === "money"; atMs += 10 * SECOND) {
      plan = levelling.update(inputsAt(atMs, { ...more, expAbove: (atMs / 1000) * perSecond }));
    }
    return { plan, switchedAtMs: atMs - 10 * SECOND };
  }

  test("money first, until its rate is measured once settled; then levelling mode, its target, operation, hosts", () => {
    const levelling = rule();
    expect(levelling.update(inputsAt(0))).toEqual({ mode: "money", levelling: null });
    expect(levelling.view()).toMatchObject({ applies: true, mode: "money", estimates: { money: null } });
    const { plan, switchedAtMs } = measureMoney(levelling, 10);
    // The first update settled (a restarted brain's loops may still land), then a minute's span.
    expect(switchedAtMs).toBeGreaterThanOrEqual(SETTLE_MS + MINUTE);
    expect(switchedAtMs).toBeLessThan(SETTLE_MS + MINUTE + 10 * SECOND);
    // joesguns at its minimum: the grow, 1.25 times the weaken's experience a thread-second.
    expect(plan).toEqual({
      mode: "level",
      levelling: {
        target: "joesguns",
        hosts: ["joesguns", "n00dles", "pserv-0"],
        homeKeptGb: SHARE_HOME_KEPT_GB,
        operation: "grow",
      },
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
    expect(levelling.view().lines[1]).toContain("chosen: levelling mode on joesguns, growing it (the operation sent)");
    expect(levelling.view().lines[1]).toContain("not measured yet (1 taken, optimistic)");
  });

  test("the run report's hopeless check (#410): one function, the level-only time added up per BitNode, gaps left out", () => {
    const clock = new LevelOnlyClock();
    // Two readings 10 s apart count 10 s; a 4-minute gap (the brain down) counts none; not level-only breaks it.
    clock.add(0, 4, true);
    clock.add(10 * SECOND, 4, true);
    clock.add(10 * SECOND + 4 * MINUTE, 4, true);
    clock.add(10 * SECOND + 5 * MINUTE, 4, true);
    expect(clock.ms()).toBe(10 * SECOND + MINUTE);
    clock.add(6 * MINUTE, 4, false);
    clock.add(7 * MINUTE, 4, true);
    expect(clock.ms()).toBe(10 * SECOND + MINUTE);
    // Another BitNode: from 0.
    clock.add(8 * MINUTE, 5, true);
    expect(clock.ms()).toBe(0);
    // Past the BitNode's time so far, past the 10 minutes: the failure; at either short, none.
    const tenMinutes = LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS;
    expect(levellingHopelessFailure("money", 3600, 1_000_000, tenMinutes + 1)).toBe(
      "levelling: the brain's choice, batching for money, about 60 min to w0r1d_d43m0n's level, past the 16 min 40 s " +
        "the BitNode has taken so far: a hopeless estimate",
    );
    expect(levellingHopelessFailure("money", 3600, 1_000_000, tenMinutes)).toBeNull();
    expect(levellingHopelessFailure("money", 1000, 1_000_000, tenMinutes + 1)).toBeNull();
    expect(levellingHopelessFailure("money", null, 1_000_000, tenMinutes + 1)).toBeNull();
  });

  test("the operation: the grow at joesguns' minimum security, whatever its money; the weaken above it", () => {
    const levelling = rule();
    measureMoney(levelling, 10);
    expect(levelling.update(inputsAt(5 * MINUTE, { joesgunsSecurity: 5.004 })).levelling?.operation).toBe("weaken");
    expect(levelling.view().lines[1]).toContain("weakening it (the operation sent)");
    // At its minimum security below its maximum money: the grow, whose one round fills it.
    expect(levelling.update(inputsAt(5 * MINUTE + 10 * SECOND, { joesgunsMoney: 6e7 })).levelling?.operation).toBe(
      "grow",
    );
    expect(levelling.update(inputsAt(5 * MINUTE + 20 * SECOND)).levelling?.operation).toBe("grow");
    expect(levelling.view().lines[1]).toContain("growing it (the operation sent)");
  });

  test("the fit is for the threads running: home's loop at a tenth of its room, measured at its rate, fits 1", () => {
    const levelling = rule();
    const { switchedAtMs } = measureMoney(levelling, 10);
    const homeThreads = Math.floor(HOME_THREADS / 10);
    const running = (figures?.threads ?? 0) - HOME_THREADS + homeThreads;
    const share = running / (figures?.threads ?? 1);
    levelFor(levelling, switchedAtMs + 10 * SECOND, SETTLE_MS + 2 * MINUTE, share, { sent: true, homeThreads }, 3000);
    expect(levelling.view().fit?.factor).toBeCloseTo(1, 2);
  });

  test("the first update settles: a restarted brain's level loops still landing aren't money's rate", () => {
    const levelling = rule();
    levelling.update(inputsAt(0));
    // A burst as the old loops' last operations land, then batching's 10 a second.
    for (let atMs = 10 * SECOND; atMs < SETTLE_MS; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: 1e9 }));
    }
    let atMs = Math.ceil(SETTLE_MS / (10 * SECOND)) * 10 * SECOND;
    const from = atMs;
    for (; atMs <= from + 70 * SECOND; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: 1e9 + ((atMs - from) / 1000) * 10 }));
    }
    expect(events.at(-1)).toMatchObject({ money: expect.objectContaining({ expPerSecond: expect.closeTo(10, 6) }) });
  });

  test("hysteresis: money stays while levelling mode isn't 1.25 times shorter", () => {
    // Money's rate within a fifth of levelling mode's prediction: it stays.
    const levelling = rule();
    expect(measureMoney(levelling, predicted * 0.85).plan.mode).toBe("money");
    expect(events).toEqual([]);
  });

  /** Levelling mode from `fromMs` on, the experience rising `share` of the formula's rate, `levelLoop` as given. */
  function levelFor(
    levelling: LevellingRule,
    fromMs: number,
    durationMs: number,
    share: number,
    levelLoop = { sent: true, homeThreads: HOME_THREADS },
    expAt0 = 0,
  ) {
    for (let atMs = fromMs; atMs <= fromMs + durationMs; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: expAt0 + ((atMs - fromMs) / 1000) * predicted * share, levelLoop }));
    }
  }

  test("levelling mode's fit: its measured rate once settled, against the formula's for the RAM sent", () => {
    const levelling = rule();
    const { switchedAtMs } = measureMoney(levelling, 10);
    // While it settles, the batcher's last waves land, a burst; then half the formula's rate: the factor 0.5.
    const startMs = Math.ceil((switchedAtMs + SETTLE_MS) / (10 * SECOND)) * 10 * SECOND;
    const burst = 3000 + 1e6;
    for (let atMs = switchedAtMs + 10 * SECOND; atMs < startMs; atMs += 10 * SECOND) {
      levelling.update(inputsAt(atMs, { expAbove: burst }));
    }
    levelFor(levelling, startMs, 2 * MINUTE, 0.5, undefined, burst);
    expect(levelling.view().fit?.factor).toBeCloseTo(0.5, 2);
    expect(levelling.view().lines[1]).toMatch(/fitted factor 0\.50 \(measured .*\/s, the formula .*\/s\)/);
  });

  test("the fit only while the level loop runs: not sent, or none of it on home where it has room; then it settles", () => {
    for (const notRunning of [
      { sent: false, homeThreads: 0 },
      { sent: true, homeThreads: 0 },
    ]) {
      const levelling = rule();
      const { switchedAtMs } = measureMoney(levelling, 10);
      // The hack loop off (nothing sent), or home's loop not there: no experience comes, and none is measured.
      levelFor(levelling, switchedAtMs + 10 * SECOND, 12 * MINUTE, 0, notRunning, 3000);
      expect(levelling.view().fit).toBeNull();
      // Running again: its first operations land a weaken's time on, nothing before; it settles first, then fits.
      const runningFromMs = switchedAtMs + 13 * MINUTE;
      for (let atMs = runningFromMs; atMs <= runningFromMs + SETTLE_MS + 2 * MINUTE; atMs += 10 * SECOND) {
        const landingMs = Math.max(0, atMs - runningFromMs - 30 * SECOND);
        levelling.update(inputsAt(atMs, { expAbove: 3000 + (landingMs / 1000) * predicted }));
      }
      expect(levelling.view().fit?.factor).toBeCloseTo(1, 2);
    }
  });

  test("an install resets the fit (and money's rate): the new game's are measured afresh", () => {
    const levelling = rule();
    const { switchedAtMs } = measureMoney(levelling, 10);
    levelFor(levelling, switchedAtMs + 10 * SECOND, SETTLE_MS + 2 * MINUTE, 0.5, undefined, 3000);
    expect(levelling.view().fit?.factor).toBeCloseTo(0.5, 1);
    levelling.update(inputsAt(switchedAtMs + 10 * MINUTE, { slowData: slow({ lastAugReset: 1 }) }));
    expect(levelling.view().fit).toBeNull();
    expect(levelling.mode()).toBe("money");
  });

  test("the install: chosen with A6's levels on offer, held while A6 commits; back to money after the reset", () => {
    const levelling = rule();
    // Levels on offer from the start: once money's rate is measured, the install is the shortest.
    const { plan, switchedAtMs } = measureMoney(levelling, 10, { neuroFluxLevels: 30 });
    expect(plan.mode).toBe("install");
    expect((levelling.view().estimates?.install as number) * 1000).toBeGreaterThan(
      LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS,
    );
    // Levelling mode meanwhile: the experience before the install is lost anyway.
    expect(plan.levelling?.target).toBe("joesguns");
    const at = (offsetMs: number) => switchedAtMs + offsetMs;
    // A6 committed, its money spent on the levels (none on offer now): still the install.
    expect(levelling.update(inputsAt(at(10 * SECOND), { neuroFluxLevels: null, installCommitted: true })).mode).toBe(
      "install",
    );
    // Not committed, and nothing on offer: chosen afresh.
    expect(levelling.update(inputsAt(at(20 * SECOND), { neuroFluxLevels: null })).mode).toBe("level");
    // The reset: money, w0r1d_d43m0n not rooted yet.
    const after = levelling.update(inputsAt(at(30 * SECOND), { slowData: slow({ lastAugReset: 99 * SECOND }) }));
    expect(after.mode).toBe("money");
  });

  test("the install with A6's set alone (#355): no level on offer; held while A6 commits; the set said", () => {
    const levelling = rule();
    const set = ["QLink", "BitRunners Neurolink"];
    const { plan, switchedAtMs } = measureMoney(levelling, 10, { neuroFluxLevels: 0, installAugmentations: set });
    expect(plan.mode).toBe("install");
    expect(events.at(-1)).toMatchObject({
      mode: "install",
      from: "money",
      neuroFluxLevels: 0,
      installAugmentations: set,
    });
    expect(levelling.view().lines[2]).toBe(
      "  the install's augmentations: NeuroFlux Governor ×0; the set's QLink, BitRunners Neurolink",
    );
    const at = (offsetMs: number) => switchedAtMs + offsetMs;
    // Held while a set is on offer, even one now worth less than levelling mode (Synaptic Enhancement Implant's speed
    // ×1.03 alone, home at 512 GB, so the install's rate on home alone is far under levelling's on every host), and
    // while A6 commits it (the set bought, none on offer).
    const weak = { neuroFluxLevels: 0, installAugmentations: ["Synaptic Enhancement Implant"], homeGb: 512 };
    expect(levelling.update(inputsAt(at(10 * SECOND), weak)).mode).toBe("install");
    expect(levelling.view().estimates?.install as number).toBeGreaterThan(
      (levelling.view().estimates?.level as number) * 1.25,
    );
    expect(levelling.update(inputsAt(at(20 * SECOND), { neuroFluxLevels: 0, installCommitted: true })).mode).toBe(
      "install",
    );
    // Not committed, and a set that adds nothing to levelling: chosen afresh.
    const nothing = { neuroFluxLevels: 0, installAugmentations: ["Combat Rib I"] };
    expect(levelling.update(inputsAt(at(30 * SECOND), nothing)).mode).toBe("level");
    expect(levelling.view().estimates?.install).toBeNull();
    expect(levelling.view().lines).toHaveLength(2);
  });

  test("back to money once the level isn't all that's left: reached, or the World Daemon's switch off", () => {
    for (const changes of [{ level: 3000 }, { enabled: false }]) {
      const levelling = rule();
      const { switchedAtMs } = measureMoney(levelling, 10);
      expect(levelling.mode()).toBe("level");
      expect(levelling.update(inputsAt(switchedAtMs + 10 * SECOND, changes))).toEqual({
        mode: "money",
        levelling: null,
      });
      expect(events.at(-1)).toMatchObject({ mode: "money", from: "level" });
      expect(levelling.view()).toMatchObject({ applies: false, lines: [] });
      events.length = 0;
    }
  });

  /** A6's ladder (#380): no set, then NeuroFlux Governor's levels at $1m, $3m, $7m …, each level twice the last. */
  const LADDER = Array.from({ length: 31 }, (_, k) => (2 ** k - 1) * 1e6);
  const OFFER = { ladder: LADDER, augmentations: [] };
  /** At ×8 the level 2,000 to 3,000 takes levelling mode hours on this RAM, and NeuroFlux Governor's levels cut it. */
  const MULT = 8;
  /**
   * Batching from `fromMs` for `durationMs`: medium snapshots every 10 s, the experience rising 10 a second, the money
   * `incomePerSecond` from `money`; A6 offering `neuroFluxLevels` (the levels the money buys) as `levelsAt` says.
   */
  function batchFor(
    levelling: LevellingRule,
    fromMs: number,
    durationMs: number,
    {
      incomePerSecond,
      money = 0,
      expAt = 0,
      levelsAt = (_money: number) => null as number | null,
      batchOffer = OFFER as LevellingRuleInputs["batchOffer"],
    }: {
      incomePerSecond: number;
      money?: number;
      expAt?: number;
      levelsAt?: (money: number) => number | null;
      batchOffer?: LevellingRuleInputs["batchOffer"];
    },
  ) {
    let plan = levelling.update(
      inputsAt(fromMs, { mult: MULT, money, expAbove: expAt, batchOffer, levelLoop: { sent: false, homeThreads: 0 } }),
    );
    for (let atMs = fromMs + 10 * SECOND; atMs <= fromMs + durationMs; atMs += 10 * SECOND) {
      const now = money + ((atMs - fromMs) / 1000) * incomePerSecond;
      plan = levelling.update(
        inputsAt(atMs, {
          mult: MULT,
          money: now,
          expAbove: expAt + ((atMs - fromMs) / 1000) * 10,
          batchOffer,
          neuroFluxLevels: levelsAt(now),
          levelLoop: { sent: false, homeThreads: 0 },
        }),
      );
    }
    return plan;
  }
  /** The levels $`money` buys on `LADDER`: (c)'s offer, as A6's. */
  const levelsBought = (money: number) => LADDER.filter((each) => each <= money).length - 1;

  test("(d) (#380): chosen over levelling mode once 1.25 times shorter; batching meanwhile; the install once (c) is no longer", () => {
    const levelling = rule();
    // $10m a second: (a)'s rate and the income measured together once money settles.
    const plan = batchFor(levelling, 0, SETTLE_MS + MINUTE + 10 * SECOND, { incomePerSecond: 1e7 });
    const view = levelling.view();
    expect(plan).toEqual({ mode: "batch", levelling: null });
    expect(view.estimates?.batch as number).toBeLessThan((view.estimates?.level as number) / 1.25);
    const chosen = events.at(-1) as unknown as LevellingEvent;
    expect(chosen).toMatchObject({
      type: LEVELLING_CHOSEN_EVENT_KIND,
      mode: "batch",
      from: "money",
      batch: {
        incomePerSecond: expect.closeTo(1e7, 0),
        ladder: LADDER,
        augmentations: [],
        levels: expect.any(Number),
        money: expect.any(Number),
      },
    });
    const { levels, money: target } = chosen.batch as { levels: number; money: number };
    console.log(`(d): ${describeEstimates(view.estimates as LevellingEstimates)}; ${view.lines.at(-1)}`);
    expect(target).toBe(LADDER[levels]);
    expect(view.lines.at(-1)).toMatch(
      new RegExp(`^ {2}\\(d\\)'s plan: batch to \\$${target.toExponential(2).replace("+", "\\+")} at \\$1\\.00e\\+7/s`),
    );
    expect(view.lines[1]).toBe(
      `  chosen: batching for the money, then an install; levelling's fitted factor not measured yet (1 taken, optimistic)`,
    );
    // Batching on toward M, A6 offering the levels the money buys: (d) goes on until (c) is no longer than it, then the
    // install, at once.
    const startMs = SETTLE_MS + MINUTE + 20 * SECOND;
    const startMoney = (startMs / 1000) * 1e7;
    let installAtMs: number | null = null;
    for (let atMs = startMs; atMs < startMs + 30 * MINUTE && installAtMs === null; atMs += 10 * SECOND) {
      const now = startMoney + ((atMs - startMs) / 1000) * 1e7;
      const next = levelling.update(
        inputsAt(atMs, {
          mult: MULT,
          money: now,
          expAbove: (atMs / 1000) * 10,
          batchOffer: OFFER,
          neuroFluxLevels: levelsBought(now),
          levelLoop: { sent: false, homeThreads: 0 },
        }),
      );
      if (next.mode === "install") {
        installAtMs = atMs;
        // The money in hand at M or past it by one interval's income.
        expect(levelsBought(now)).toBeGreaterThanOrEqual(levels - 1);
        expect(next.levelling?.target).toBe("joesguns");
      } else {
        expect(next).toEqual({ mode: "batch", levelling: null });
      }
    }
    expect(installAtMs).not.toBeNull();
    expect(events.map((event) => (event as unknown as LevellingEvent).mode)).toEqual(["batch", "install"]);
  });

  test("(d) (#380): a drop in income re-decides: the money flat for the window, levelling mode", () => {
    const levelling = rule();
    batchFor(levelling, 0, SETTLE_MS + MINUTE + 10 * SECOND, { incomePerSecond: 1e7 });
    expect(levelling.mode()).toBe("batch");
    // The income stops (a batcher's target drained, say): over the window the measured income falls to 0, (d) is none,
    // and levelling mode is the shortest.
    const fromMs = SETTLE_MS + MINUTE + 20 * SECOND;
    const plan = batchFor(levelling, fromMs, 11 * MINUTE, {
      incomePerSecond: 0,
      money: (fromMs / 1000) * 1e7,
      expAt: (fromMs / 1000) * 10,
    });
    expect(plan.mode).toBe("level");
    expect(events.map((event) => (event as unknown as LevellingEvent).mode)).toEqual(["batch", "level"]);
    expect(events.at(-1)).toMatchObject({ from: "batch" });
  });

  test("(d) (#382's review): its batching bounded by the BitNode's time so far, #336's hopeless bar: both sides", () => {
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    /** (d) after money's minute at $10m a second, on `ladder`, `lastNodeReset` the BitNode's start. */
    const dAfter = (ladder: number[], lastNodeReset: number) => {
      const levelling = rule();
      for (let atMs = 0; atMs <= measuredMs; atMs += 10 * SECOND) {
        levelling.update(
          inputsAt(atMs, {
            mult: MULT,
            money: (atMs / 1000) * 1e7,
            expAbove: (atMs / 1000) * 10,
            batchOffer: { ladder, augmentations: [] },
            levelLoop: { sent: false, homeThreads: 0 },
            slowData: slow({ lastNodeReset }),
          }),
        );
      }
      return levelling.view().estimates?.batch ?? null;
    };
    // The next level at $100b: about 10,000 s of batching. Weighed 10 h into the BitNode; past the bar at its start
    // (its time so far a couple of minutes), not weighed.
    const far = [0, 1e6, 1e11];
    expect(dAfter(far, -10 * 60 * MINUTE)).not.toBeNull();
    expect(dAfter(far, 0)).toBeNull();
    // The next levels within the bar at its start (about 2 minutes' batching): weighed.
    const firstMoney = (measuredMs / 1000) * 1e7;
    expect(dAfter([0, 1e6, firstMoney + 1e9], 0)).not.toBeNull();
    expect(dAfter([0, 1e6, firstMoney + 1e10], 0)).toBeNull();
  });

  test("(d) (#382's review): a first minute with no income (the target preparing) keeps (d): money waits, then (d)", () => {
    const levelling = rule();
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, measuredMs, { incomePerSecond: 0 });
    expect(levelling.mode()).toBe("money");
    // The batcher earning from 2 minutes on: the window's income above 0, (d) weighed and chosen.
    const fromMs = measuredMs + 10 * SECOND;
    batchFor(levelling, fromMs, 2 * MINUTE, { incomePerSecond: 1e7, expAt: (fromMs / 1000) * 10 });
    expect(levelling.mode()).toBe("batch");
    expect(events.map((event) => (event as unknown as LevellingEvent).mode)).toEqual(["batch"]);
  });

  test("(d) (#382's review): from levelling mode, (d) once A6's ladder comes on offer, at the income kept", () => {
    const levelling = rule();
    // No ladder (A6 off, say) as money measures: levelling mode, the income measured all the same.
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, measuredMs, { incomePerSecond: 1e7, batchOffer: null });
    expect(levelling.mode()).toBe("level");
    // The ladder on offer, levelling mode earning nothing: (d) at the income kept, 1.25 times shorter.
    const plan = levelling.update(
      inputsAt(measuredMs + 10 * SECOND, { mult: MULT, batchOffer: OFFER, expAbove: (measuredMs / 1000) * 10 + 100 }),
    );
    expect(plan).toEqual({ mode: "batch", levelling: null });
    expect(events.at(-1)).toMatchObject({
      mode: "batch",
      from: "level",
      batch: { incomePerSecond: expect.closeTo(1e7, -3) },
    });
  });

  test("(d) (#382's re-review): levelling mode to (d), an idle first minute (the target preparing), then income: (d) stays", () => {
    const levelling = rule();
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, measuredMs, { incomePerSecond: 1e7, batchOffer: null });
    expect(levelling.mode()).toBe("level");
    const money = (measuredMs / 1000) * 1e7;
    let atMs = measuredMs + 10 * SECOND;
    levelling.update(
      inputsAt(atMs, { mult: MULT, batchOffer: OFFER, money, expAbove: (measuredMs / 1000) * 10 + 100 }),
    );
    expect(levelling.mode()).toBe("batch");
    // In (d), the batcher idle past its settle and a minute: a fresh window's 0 is unread, the income carried in kept.
    atMs += 10 * SECOND;
    const idleMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, atMs, idleMs, { incomePerSecond: 0, money, expAt: (atMs / 1000) * 10 + 200 });
    expect(levelling.mode()).toBe("batch");
    expect(levelling.view().estimates?.batch).not.toBeNull();
    expect(levelling.view().lines.at(-1)).toMatch(/at \$1\.00e\+7\/s/);
    // Then the batcher earns: (d) on, at the window's income.
    atMs += idleMs + 10 * SECOND;
    batchFor(levelling, atMs, 2 * MINUTE, { incomePerSecond: 1e7, money, expAt: (atMs / 1000) * 10 + 300 });
    expect(levelling.mode()).toBe("batch");
    expect(events.map((event) => (event as unknown as LevellingEvent).mode)).toEqual(["level", "batch"]);
    // Past LEVELLING_INCOME_WAIT_MS from (d)'s start, a snapshot gap (4 min, past HACKING_EXP_GAP_MS) starts the window
    // again, and it reads the money flat: the 0 counts, (d) is none, and the rest are weighed.
    const flatFrom = atMs + 2 * MINUTE + 4 * MINUTE;
    const expHeld = (flatFrom / 1000) * 10 + 400;
    for (let at = flatFrom; at <= flatFrom + SETTLE_MS + 2 * MINUTE; at += 10 * SECOND) {
      levelling.update(
        inputsAt(at, {
          mult: MULT,
          batchOffer: OFFER,
          money: money + 120 * 1e7,
          expAbove: expHeld,
          levelLoop: { sent: false, homeThreads: 0 },
        }),
      );
    }
    const left = events.at(-1) as unknown as LevellingEvent;
    expect(left).toMatchObject({ from: "batch", estimates: { batch: null } });
    expect(levelling.mode()).not.toBe("batch");
  });

  test("(d) (#382's re-review): the game's clock set back during money's wait starts it again, no longer", () => {
    const levelling = rule();
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, measuredMs, { incomePerSecond: 0 });
    expect(levelling.view()).toMatchObject({ mode: "money", waitingForIncome: true });
    // An hour back: the wait runs from the new time, so it ends within its 5 minutes of it, not 65.
    const back = measuredMs - 60 * MINUTE;
    let leftMs: number | null = null;
    for (let at = back; at <= back + 20 * MINUTE && leftMs === null; at += 10 * SECOND) {
      levelling.update(
        inputsAt(at, {
          mult: MULT,
          batchOffer: OFFER,
          money: 0,
          expAbove: 1e6 + (at - back) / 100,
          levelLoop: { sent: false, homeThreads: 0 },
        }),
      );
      if (levelling.mode() !== "money") leftMs = at - back;
    }
    expect(leftMs).not.toBeNull();
    expect(leftMs as number).toBeLessThanOrEqual(LEVELLING_INCOME_WAIT_MS + SETTLE_MS + MINUTE + 10 * SECOND);
  });

  test("(d) (#380): money and (d) both batch: the move between them keeps the window, the income measured on", () => {
    const levelling = rule();
    const switchedMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, switchedMs, { incomePerSecond: 1e7 });
    expect(levelling.mode()).toBe("batch");
    const incomeIn = () => /at \$([\d.e+]+)\/s/.exec(levelling.view().lines.at(-1) ?? "")?.[1];
    expect(incomeIn()).toBe("1.00e+7");
    // Twice the income from the switch on: within 20 s the window's income moves (not settled afresh, a minute's wait).
    batchFor(levelling, switchedMs + 10 * SECOND, 10 * SECOND, {
      incomePerSecond: 2e7,
      money: (switchedMs / 1000) * 1e7 + 1e8,
      expAt: (switchedMs / 1000) * 10 + 100,
    });
    expect(Number(incomeIn())).toBeGreaterThan(1e7);
  });

  test("(d) (#380): a snapshot's money unread keeps the income measured, rather than dropping (d) for the window", () => {
    const levelling = rule();
    const switchedMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(levelling, 0, switchedMs, { incomePerSecond: 1e7 });
    expect(levelling.mode()).toBe("batch");
    const unread = inputsAt(switchedMs + 10 * SECOND, {
      mult: MULT,
      batchOffer: OFFER,
      expAbove: (switchedMs / 1000) * 10 + 100,
      levelLoop: { sent: false, homeThreads: 0 },
    });
    delete ((unread.mediumData as MediumSnapshotData).player as { money?: number }).money;
    levelling.update(unread);
    // Read again: the window holds the unread sample a while, and the income measured before it stands.
    batchFor(levelling, switchedMs + 20 * SECOND, 20 * SECOND, {
      incomePerSecond: 1e7,
      money: ((switchedMs + 20 * SECOND) / 1000) * 1e7,
      expAt: ((switchedMs + 20 * SECOND) / 1000) * 10,
    });
    expect(levelling.view().estimates?.batch).not.toBeNull();
    expect(levelling.mode()).toBe("batch");
  });

  test("(d) (#380): none without A6's ladder or an income; the income kept through levelling mode, gone at an install", () => {
    // No ladder (A6 off, or (d) off for the A/B): levelling mode, as before #380.
    const without = rule();
    batchFor(without, 0, SETTLE_MS + MINUTE + 10 * SECOND, { incomePerSecond: 1e7, batchOffer: null });
    expect(without.mode()).toBe("level");
    expect(without.view().estimates?.batch).toBeNull();
    // No income (the money flat): money waits for one (#382's review), `LEVELLING_INCOME_WAIT_MS` at most, then
    // levelling mode with (d) none.
    events.length = 0;
    const flat = rule();
    const measuredMs = SETTLE_MS + MINUTE + 10 * SECOND;
    batchFor(flat, 0, measuredMs, { incomePerSecond: 0 });
    expect(flat.mode()).toBe("money");
    expect(flat.view().estimates?.batch).toBeNull();
    // Waiting: the time to the destroy (#360) takes the candidate the choice would take meanwhile, (d) left out:
    // levelling mode here, its estimate.
    expect(flat.view()).toMatchObject({ waitingForIncome: true, meanwhile: "level" });
    expect(levellingEstimateMs(flat.view())).toBe((flat.view().estimates?.level as number) * 1000);
    expect(flat.view().lines.at(-1)).toBe("  money waits for (d)'s income: none measured yet (5 min at most, #382)");
    batchFor(flat, measuredMs + 10 * SECOND, LEVELLING_INCOME_WAIT_MS - 20 * SECOND, {
      incomePerSecond: 0,
      expAt: ((measuredMs + 10 * SECOND) / 1000) * 10,
    });
    expect(flat.mode()).toBe("money");
    batchFor(flat, measuredMs + LEVELLING_INCOME_WAIT_MS, 20 * SECOND, {
      incomePerSecond: 0,
      expAt: ((measuredMs + LEVELLING_INCOME_WAIT_MS) / 1000) * 10,
    });
    expect(flat.mode()).toBe("level");
    expect(flat.view().estimates?.batch).toBeNull();
    expect(flat.view().waitingForIncome).toBeUndefined();
    expect(levellingEstimateMs(flat.view())).not.toBeNull();
    // Measured while batching, then a trickle: levelling mode, the income kept (it earns none there), so (d) still
    // weighed.
    events.length = 0;
    const levelling = rule();
    batchFor(levelling, 0, SETTLE_MS + MINUTE + 10 * SECOND, { incomePerSecond: 1e3 });
    expect(levelling.mode()).toBe("level");
    const kept = levelling.view().estimates?.batch;
    expect(kept).not.toBeNull();
    levelling.update(inputsAt(10 * MINUTE, { mult: MULT, batchOffer: OFFER, expAbove: 1e6 }));
    expect(levelling.view().estimates?.batch).not.toBeNull();
    // An install: the income afresh, with the other rates.
    levelling.update(
      inputsAt(11 * MINUTE, { mult: MULT, batchOffer: OFFER, slowData: slow({ lastAugReset: 99 * SECOND }) }),
    );
    expect(levelling.mode()).toBe("money");
    levelling.update(
      inputsAt(11 * MINUTE + 10 * SECOND, {
        mult: MULT,
        batchOffer: OFFER,
        slowData: slow({ lastAugReset: 99 * SECOND }),
      }),
    );
    expect(levelling.view().estimates?.batch).toBeNull();
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
  /**
   * The Agent's snapshots for 3 minutes: experience rising slowly, as batching ecorp, and the money a trickle ($1k a
   * second: an income measured, so money needn't wait for one, #382's review); the first update settles, then money's
   * rate takes a minute.
   */
  function aMinuteOf(
    connection: MemoryConnection,
    { money = 1e6, slowData = slow(), fromMs = 1_000, level = 2000, gang = undefined as unknown, mult = 2 } = {},
  ) {
    send(connection, "static", STATIC, fromMs);
    send(connection, "slow", slowData, fromMs);
    for (let atMs = fromMs; atMs <= fromMs + 3 * MINUTE; atMs += 10 * SECOND) {
      const now = money + (atMs - fromMs);
      send(connection, "medium", medium({ level, money: now, expAbove: (atMs - fromMs) / 100, gang, mult }), atMs);
      if (atMs % (60 * SECOND) === 1_000) send(connection, "slow", slowData, atMs);
    }
  }
  /** The fast snapshot with the level loop's `threads` on home, or none. */
  const fastWithHomeLoop = (threads: number) => ({
    degradedTiers: [],
    pageHeapUsedBytes: null,
    game: {
      money: 1e6,
      homeRamUsed: 8,
      homeMaxRam: 4096,
      homeProcesses:
        threads === 0
          ? []
          : [{ pid: 7, filename: "agent/0123456789ab/level-grow.js", threads, args: ["joesguns"], temporary: false }],
    },
    intents: [],
    dialogs: { handled: [], blocking: null },
  });

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
      levelling: { homeKeptGb: SHARE_HOME_KEPT_GB, operation: "grow" },
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
    expect(lastDesired(connection)?.hackLoop.levelling).toEqual({ homeKeptGb: SHARE_HOME_KEPT_GB, operation: "grow" });
    writeWorldDaemonEnabled(store, false);
    send(connection, "medium", medium({ level: 2000, expAbove: 3000 }), 200 * SECOND);
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
    // the set A6 buys first): the install is the shortest. At ×8 (#380): at ×2 every estimate is hopeless, and (d)'s
    // 23 levels at a trickle's income beat the 14 in hand.
    const slowData = slow({ faction: "CyberSec" });
    aMinuteOf(connection, { money: 1e12, slowData, mult: 8 });
    send(connection, "medium", medium({ level: 2000, money: 1e12, expAbove: 3000, mult: 8 }), 200 * SECOND);
    send(connection, "slow", slowData, 200 * SECOND);
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
    expect(state?.hackLoop.levelling).toEqual({ homeKeptGb: SHARE_HOME_KEPT_GB, operation: "grow" });
  });

  test("a hopeless choice (#410): the World Daemon's alert, by the run report's own check, once 10 minutes level-only", () => {
    // At ×2 levelling mode to 3,000 is about 1e18 s, past the BitNode's 10 h so far: chosen still (the least), and
    // alerted once the level has been all that's left 10 minutes, as the run report fails it.
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    writeAugmentationsEnabled(store, false);
    aMinuteOf(connection);
    expect(controller.levellingView().mode).toBe("level");
    expect(controller.levellingView().hopeless).toBeNull();
    const stalls = () => events.filter((event) => event.type === "worldDaemonStalled");
    let atMs = 190 * SECOND;
    for (; atMs <= 1_000 + 10 * MINUTE; atMs += 10 * SECOND) {
      send(connection, "medium", medium({ level: 2000, expAbove: atMs / 100 }), atMs);
    }
    expect(stalls()).toEqual([]);
    send(connection, "medium", medium({ level: 2000, expAbove: atMs / 100 }), atMs);
    send(connection, "medium", medium({ level: 2000, expAbove: atMs / 100 + 1 }), atMs + 10 * SECOND);
    const hopeless = controller.levellingView().hopeless;
    expect(hopeless).toMatch(
      /^levelling: the brain's choice, levelling mode, about [\d.e+]+ h to w0r1d_d43m0n's level, past the 10 h \d+ min the BitNode has taken so far: a hopeless estimate$/,
    );
    expect(stalls()).toEqual([expect.objectContaining({ step: "levelling", detail: hopeless })]);
    expect(lastDesired(connection)?.hackLoop.levelling).toBeDefined();
  });

  test("The Red Pill's install timed (#410): A6 gets levelling mode after it from the snapshots; with no income, now", () => {
    // BN4, The Red Pill reached at Daedalus, the destroy wanted: A6 times its install on the controller's figures (home's
    // threads, joesguns' grow); no income measured (no hacking money in these slow snapshots), so now, said once.
    const lines: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    aMinuteOf(connection, { slowData: slow({ redPill: false, reputation: 2.6e6, currentNode: 4 }) });
    expect(events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([
      expect.objectContaining({ reason: "The Red Pill" }),
    ]);
    expect(lines.filter((line) => line.startsWith("augmentations: The Red Pill's install timed (#410)"))).toEqual([
      expect.stringMatching(/: the install now, no income measured to batch with$/),
    ]);
  });

  test("the flip: the grow at minimum security below its money, the weaken once the grow raised it, then grow for good", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    writeAugmentationsEnabled(store, false);
    aMinuteOf(connection);
    // At its minimum security, at a 25th of its money (as an install leaves it): the grow.
    send(connection, "medium", medium({ level: 2000, expAbove: 3000, joesgunsMoney: 2.5e6 }), 200 * SECOND);
    expect(lastDesired(connection)?.hackLoop.levelling?.operation).toBe("grow");
    expect(controller.levellingView().lines[1]).toContain("growing it (the operation sent)");
    // The round filled it and raised its security: the weaken.
    send(connection, "medium", medium({ level: 2000, expAbove: 3100, joesgunsSecurity: 25 }), 210 * SECOND);
    expect(lastDesired(connection)?.hackLoop.levelling?.operation).toBe("weaken");
    expect(controller.levellingView().lines[1]).toContain("weakening it (the operation sent)");
    // Back at its minimum, its money at its maximum: the grow, which moves nothing now, so it stays.
    for (let atMs = 220 * SECOND; atMs <= 320 * SECOND; atMs += 10 * SECOND) {
      send(connection, "medium", medium({ level: 2000, expAbove: 3200 + atMs / 1000 }), atMs);
      expect(lastDesired(connection)?.hackLoop.levelling?.operation).toBe("grow");
    }
  });

  test("the fit only while the level loop runs: with the hack loop off while levelling, none; on, with it on home, one", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    writeAugmentationsEnabled(store, false);
    aMinuteOf(connection);
    expect(controller.levellingView().mode).toBe("level");
    // The hack loop switched off: levelling is chosen, but nothing runs, and the experience doesn't rise.
    writeSwitch(store, HACK_LOOP_ENABLED_SETTING, false);
    const fromMs = 200 * SECOND;
    for (let atMs = fromMs; atMs <= fromMs + 12 * MINUTE; atMs += 10 * SECOND) {
      send(connection, "fast", fastWithHomeLoop(0), atMs);
      send(connection, "medium", medium({ level: 2000, expAbove: 3000 }), atMs);
    }
    expect(lastDesired(connection)?.hackLoop.enabled).toBe(false);
    expect(controller.levellingView().fit).toBeNull();
    expect(controller.levellingView().mode).toBe("level");
    // On again, the loop on home in the fast snapshot: it settles, then fits.
    writeSwitch(store, HACK_LOOP_ENABLED_SETTING, true);
    const onMs = fromMs + 13 * MINUTE;
    for (let atMs = onMs; atMs <= onMs + 4 * MINUTE; atMs += 10 * SECOND) {
      send(connection, "fast", fastWithHomeLoop(2000), atMs);
      send(connection, "medium", medium({ level: 2000, expAbove: 3000 + (atMs - onMs) }), atMs);
    }
    expect(controller.levellingView().fit?.measured).toBeCloseTo(1000, 6);
  });

  /**
   * NiteSec at 1m reputation, $1t, NeuroFlux Governor at level 70 installed (its next level's reputation 500 ×
   * 1.14^70, about 4.8m, past NiteSec's: none to buy), The Red Pill installed: in `currentNode`, with the gang's
   * reading or none. The levelling choices and A6's installs chosen, after 3 minutes and an update more.
   */
  function niteSecAt1m(currentNode: number, gang: unknown) {
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    const slowData = slow({ faction: "NiteSec", reputation: 1e6, currentNode, neuroFluxLevel: 70 });
    aMinuteOf(connection, { money: 1e12, slowData, gang });
    send(connection, "medium", medium({ level: 2000, money: 1e12, expAbove: 3000, gang }), 200 * SECOND);
    send(connection, "slow", slowData, 200 * SECOND);
    return {
      controller,
      connection,
      levelling: events.filter((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND),
      installs: events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND),
    };
  }

  test("BN2 (#355): the destroy's hold lets the install for the level go with the gang's shop's set alone", () => {
    // The gang formed with NiteSec: its shop sells nearly every augmentation, but not NeuroFlux Governor
    // (`FactionHelpers.tsx:172-178`), and no other faction is joined: no level on offer.
    const { controller, connection, levelling, installs } = niteSecAt1m(2, NITESEC_GANG);
    const chosen = levelling.at(-1) as unknown as {
      mode: string;
      neuroFluxLevels: number;
      installAugmentations: string[];
    };
    expect(chosen).toMatchObject({ mode: "install", neuroFluxLevels: 0 });
    // The set's augmentations the gang's shop sells that add to levelling, NiteSec's own shop's and others'.
    const gangShop = augmentationsSoldBy("NiteSec", 2, "NiteSec");
    expect(chosen.installAugmentations.length).toBeGreaterThan(1);
    for (const name of chosen.installAugmentations) {
      expect(gangShop, name).toContain(name);
      expect(addsToLevelling([name]), name).toBe(true);
    }
    expect(chosen.installAugmentations.some((name) => !augmentationsSoldBy("NiteSec", 2, null).includes(name))).toBe(
      true,
    );
    expect(installs).toEqual([expect.objectContaining({ reason: "the hacking level" })]);
    // Under the destroy's hold A6 buys only what adds to levelling (#355's review): its whole set is the offer.
    const bought = (installs[0] as unknown as { set: { augmentation: string }[] }).set.map((each) => each.augmentation);
    expect(bought).toEqual(chosen.installAugmentations);
    // Bought at the gang's faction, no NeuroFlux Governor level; the hack loop levelling meanwhile.
    const state = lastDesired(connection);
    expect(state?.intents).toContainEqual(
      expect.objectContaining({
        action: "purchaseAugmentation",
        args: expect.objectContaining({ faction: "NiteSec" }),
      }),
    );
    expect(controller.augmentationsView().committed).toBe(true);
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "the hacking level", neuroFluxTarget: 0 });
    // Committed, nothing more on offer: the install held while A6 commits it.
    expect(controller.levellingView().mode).toBe("install");
  });

  test("BN4, no gang (#355): the set of a plain faction's shop counts too; the install for the level with it alone", () => {
    // NiteSec joined as a faction, its reputation reaching its own hacking augmentations, but no level of NeuroFlux
    // Governor: the set alone is on offer, as Daedalus's or any shop's would be, valued as the gang's is.
    const { controller, connection, levelling, installs } = niteSecAt1m(4, undefined);
    const chosen = levelling.at(-1) as unknown as {
      mode: string;
      neuroFluxLevels: number;
      installAugmentations: string[];
    };
    expect(chosen).toMatchObject({ mode: "install", neuroFluxLevels: 0 });
    const own = augmentationsSoldBy("NiteSec", 4, null);
    expect(chosen.installAugmentations.length).toBeGreaterThan(1);
    for (const name of chosen.installAugmentations) {
      expect(own, name).toContain(name);
      expect(addsToLevelling([name]), name).toBe(true);
    }
    expect(installs).toEqual([expect.objectContaining({ reason: "the hacking level" })]);
    // Under the destroy's hold A6 buys only what adds to levelling (#355's review): its whole set is the offer.
    const bought = (installs[0] as unknown as { set: { augmentation: string }[] }).set.map((each) => each.augmentation);
    expect(bought).toEqual(chosen.installAugmentations);
    expect(lastDesired(connection)?.intents).toContainEqual(
      expect.objectContaining({
        action: "purchaseAugmentation",
        args: expect.objectContaining({ faction: "NiteSec" }),
      }),
    );
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "the hacking level", neuroFluxTarget: 0 });
    expect(controller.levellingView().mode).toBe("install");
  });

  test("BN4, by donations (#380): under the destroy's hold only what adds to levelling, those a donation buys too", () => {
    // NiteSec joined at no reputation, its donations unlocked (favour 200): every augmentation of its shop is within
    // reach by a donation, DataJack (`hacking_money` alone) among them. Only those that add to levelling are bought,
    // so (d)'s set at any money is the one the commit at its M buys.
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    const slowData = slow({ faction: "NiteSec", reputation: 0, favor: 200, currentNode: 4, neuroFluxLevel: 70 });
    aMinuteOf(connection, { money: 1e15, slowData });
    send(connection, "medium", medium({ level: 2000, money: 1e15, expAbove: 3000 }), 200 * SECOND);
    send(connection, "slow", slowData, 200 * SECOND);
    expect(augmentationsSoldBy("NiteSec", 4, null)).toContain("DataJack");
    const installs = events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND);
    expect(installs).toEqual([expect.objectContaining({ reason: "the hacking level" })]);
    const bought = (installs[0] as unknown as { set: { augmentation: string }[] }).set.map((each) => each.augmentation);
    expect(bought.length).toBeGreaterThan(1);
    for (const name of bought) expect(addsToLevelling([name]), name).toBe(true);
    // The chosen install's set is the offer, (d)'s ladder priced with the same set.
    const chosen = events.findLast((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND) as unknown as LevellingEvent;
    expect(bought).toEqual(chosen.installAugmentations);
    expect(controller.levellingView().mode).toBe("install");
  });

  test("BN6, the Black Ops' route (#398): The Red Pill installed there, no destroy's hold and no levelling; A6's set isn't only levelling's", () => {
    // The same as BN4's case above, in BN6: the hacking level isn't the destroy's there, so neither levelling nor the
    // destroy's hold applies, and DataJack (`hacking_money` alone, nothing to levelling) is bought with the rest.
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    const slowData = slow({ faction: "NiteSec", reputation: 0, favor: 200, currentNode: 6, neuroFluxLevel: 70 });
    aMinuteOf(connection, { money: 1e15, slowData });
    send(connection, "medium", medium({ level: 2000, money: 1e15, expAbove: 3000 }), 200 * SECOND);
    send(connection, "slow", slowData, 200 * SECOND);
    expect(controller.levellingView().applies).toBe(false);
    const installs = events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND);
    expect(installs).toHaveLength(1);
    expect(installs[0]).not.toMatchObject({ reason: "the hacking level" });
    const bought = (installs[0] as unknown as { set: { augmentation: string }[] }).set.map((each) => each.augmentation);
    expect(bought).toContain("DataJack");
    expect(addsToLevelling(["DataJack"])).toBe(false);
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

  /**
   * (d)'s cases (#380): batching at ×8 from hacking 2,000 (levelling mode hours on this RAM), the money from `money`
   * rising `incomePerSecond` a second from `fromMs` for `durationMs`, Daedalus's reputation reaching NeuroFlux
   * Governor's levels; medium snapshots every 10 s, slow ones every minute.
   */
  function batchingFor(
    connection: MemoryConnection,
    {
      fromMs,
      durationMs,
      money,
      incomePerSecond,
      expAt = 0,
      slowData = slow(),
    }: {
      fromMs: number;
      durationMs: number;
      money: number;
      incomePerSecond: number;
      expAt?: number;
      slowData?: SlowSnapshotData;
    },
  ) {
    for (let atMs = fromMs; atMs <= fromMs + durationMs; atMs += 10 * SECOND) {
      const now = money + ((atMs - fromMs) / 1000) * incomePerSecond;
      const expAbove = expAt + ((atMs - fromMs) / 1000) * 10;
      send(connection, "medium", medium({ level: 2000, money: now, expAbove, mult: 8 }), atMs);
      if ((atMs - fromMs) % MINUTE === 0) send(connection, "slow", slowData, atMs);
    }
    return { money: money + (durationMs / 1000) * incomePerSecond, expAt: expAt + (durationMs / 1000) * 10 };
  }
  /** The first stretch: the static and slow snapshots, then batching until money's rate and the income are measured. */
  function batchingStart(connection: MemoryConnection, incomePerSecond = 1e7) {
    send(connection, "static", STATIC, 1_000);
    return batchingFor(connection, { fromMs: 1_000, durationMs: 3 * MINUTE, money: 1e6, incomePerSecond });
  }
  const levellingModes = (events: RuleEvent[]) =>
    events
      .filter((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND)
      .map((event) => (event as unknown as LevellingEvent).mode);

  test("(d) (#380): chosen over levelling mode once shorter, the batcher kept on; at M the install for the level, through the gate", () => {
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    const after = batchingStart(connection);
    // (d), A6's ladder at Daedalus (no set: its shop adds nothing to levelling), $10m a second measured.
    expect(levellingModes(events)).toEqual(["batch"]);
    const chosen = events.findLast((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND) as unknown as LevellingEvent;
    const view = controller.levellingView();
    console.log(
      `(d), the controller: ${describeEstimates(view.estimates as LevellingEstimates)}; ${view.lines.at(-1)}`,
    );
    expect(view.estimates?.batch as number).toBeLessThan((view.estimates?.level as number) / 1.25);
    expect(chosen.batch).toMatchObject({ augmentations: [], incomePerSecond: expect.closeTo(1e7, -3) });
    const ladder = chosen.batch?.ladder as number[];
    // NeuroFlux Governor's first levels at Daedalus, priced as A6 buys them: $750k, then ×1.14 × 1.9.
    expect(ladder[1]).toBeCloseTo(750_000, 0);
    expect(ladder[2]).toBeCloseTo(750_000 + 750_000 * 1.14 * 1.9, 0);
    const target = chosen.batch?.money as number;
    expect(target).toBe(ladder[chosen.batch?.levels as number]);
    // The batcher's mode: no levelling sent, no install chosen.
    expect(lastDesired(connection)?.hackLoop.levelling).toBeUndefined();
    expect(controller.hackLoopView().levelling).toBeUndefined();
    expect(events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([]);
    // Batching on toward M: once the money buys (c)'s levels and (c) is no longer than (d), the install; A6 commits it
    // for the hacking level and buys at Daedalus, through the gate.
    batchingFor(connection, {
      fromMs: 1_000 + 3 * MINUTE + 10 * SECOND,
      durationMs: Math.ceil((target - after.money) / 1e7 / 10) * 10 * SECOND + MINUTE,
      money: after.money,
      incomePerSecond: 1e7,
      expAt: after.expAt,
    });
    expect(levellingModes(events)).toEqual(["batch", "install"]);
    const installChosen = events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND);
    expect(installChosen).toEqual([expect.objectContaining({ reason: "the hacking level" })]);
    expect(readAugmentationCycle(store)?.neuroFluxTarget).toBeGreaterThanOrEqual(chosen.batch?.levels as number);
    expect(lastDesired(connection)?.intents).toContainEqual(
      expect.objectContaining({
        action: "purchaseAugmentation",
        args: expect.objectContaining({ faction: "Daedalus" }),
      }),
    );
    expect(controller.augmentationsView().committed).toBe(true);
  });

  test("(d) (#380): A6 switched off while batching: its ladder gone, (d) none, the rest weighed", () => {
    const controller = new DesiredStateController({ channel, store });
    const connection = connectAgent();
    const after = batchingStart(connection);
    expect(controller.levellingView().mode).toBe("batch");
    writeAugmentationsEnabled(store, false);
    batchingFor(connection, {
      fromMs: 1_000 + 3 * MINUTE + 10 * SECOND,
      durationMs: 10 * SECOND,
      money: after.money,
      incomePerSecond: 1e7,
      expAt: after.expAt,
    });
    expect(controller.levellingView().estimates?.batch).toBeNull();
    expect(controller.levellingView().mode).toBe("level");
  });

  test("(d) (#380): a drop in income re-decides: the money flat for the window, (d) gone, the shortest of the rest", () => {
    const controller = new DesiredStateController({ channel, store });
    const events: RuleEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const connection = connectAgent();
    const after = batchingStart(connection);
    expect(levellingModes(events)).toEqual(["batch"]);
    batchingFor(connection, {
      fromMs: 1_000 + 3 * MINUTE + 10 * SECOND,
      durationMs: 11 * MINUTE,
      money: after.money,
      incomePerSecond: 0,
      expAt: after.expAt,
    });
    // The income measured over the window falls to 0: (d) none, and the install of the levels the money in hand buys,
    // short of M, is the shortest left (levelling mode the next).
    const switched = events.findLast(
      (event) => event.type === LEVELLING_CHOSEN_EVENT_KIND,
    ) as unknown as LevellingEvent;
    expect(levellingModes(events)).toEqual(["batch", "install"]);
    expect(switched).toMatchObject({ from: "batch", estimates: { batch: null } });
    expect(switched.estimates.install as number).toBeLessThan(switched.estimates.level as number);
    expect(switched.neuroFluxLevels as number).toBeLessThan(
      (events.find((event) => event.type === LEVELLING_CHOSEN_EVENT_KIND) as unknown as LevellingEvent).batch
        ?.levels as number,
    );
    expect(events.filter((event) => event.type === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND)).toEqual([
      expect.objectContaining({ reason: "the hacking level" }),
    ]);
  });

  test("(d) (#380): off (the A/B's other arm), the install of the levels in hand; outside levelling, nothing changes", () => {
    // Off: the same snapshots choose (c), the levels the money in hand buys, as before #380.
    const off = new DesiredStateController({ channel, store, levellingBatch: false });
    const offEvents: RuleEvent[] = [];
    off.subscribe((event) => offEvents.push(event));
    batchingStart(connectAgent());
    expect(levellingModes(offEvents)).toEqual(["install"]);
    expect(off.levellingView().estimates?.batch).toBeNull();
    // No Red Pill (BN4, no gang): the level isn't all that's left, so A6 offers no ladder, and the states sent with
    // (d) on and off are the same.
    const sentWith = (levellingBatch: boolean) => {
      const each = TelemetryStore.open(path.join(directory, `telemetry-${levellingBatch}.sqlite`));
      const eachChannel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
      eachChannel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
      const controller = new DesiredStateController({ channel: eachChannel, store: each, levellingBatch });
      const connection = new MemoryConnection();
      eachChannel.accept(connection);
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
      const slowData = slow({ redPill: false, currentNode: 4 });
      const at = (atMs: number, tier: SnapshotTier, data: unknown) =>
        connection.receive(
          encodeControlMessage({
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            type: "snapshot",
            agentSessionId: "session-1",
            tier,
            sequenceNumber: atMs + (tier === "static" ? 0 : tier === "slow" ? 1 : 2),
            gameTimeMs: atMs,
            data,
          }),
        );
      at(1_000, "static", STATIC);
      for (let atMs = 1_000; atMs <= 1_000 + 3 * MINUTE; atMs += 10 * SECOND) {
        if ((atMs - 1_000) % MINUTE === 0) at(atMs, "slow", slowData);
        at(atMs, "medium", medium({ level: 2000, money: 1e6 + (atMs / 1000) * 1e7, mult: 8 }));
      }
      expect(controller.levellingView()).toMatchObject({ applies: false, estimates: null });
      const sent = connection.sentMessages().filter((message) => message.type === "desiredState");
      each.close();
      return sent;
    };
    expect(sentWith(true)).toEqual(sentWith(false));
  });
});
