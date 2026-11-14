// Augmentations and the reset (#210): the brain's rule, driven with snapshot data as the Agent sends it. Core's
// augmentation-plan.test.ts works the formulas; here, what the rule reads, the bars' clock of time online and the
// countdown (#222), its phases, the commit, the purchases' check against the queue, its events and its view.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  chooseAugmentationsToBuy,
  countablesLeft,
  DAEDALUS_COUNT_HOLD_MS,
  donationToReach,
  type FactionState,
  factionRepInstallMultiplier,
  factionReputationPerSecond,
  favorAfterInstall,
  hackingExpOfLevel,
  type InstallTimingCandidate,
  isWorthInstalling,
  LATER_CYCLE_FACTIONS,
  laterCyclesMs,
  levellingInstallMultipliers,
  type MediumSnapshotData,
  PORT_OPENER_PROGRAMS,
  type SlowSnapshotData,
  TOR_ROUTER,
  type WorkingPerson,
  workSecondsAlong,
} from "@bitburner-agent/core";
import * as model from "@bitburner-agent/model";
import { type Countdown, countHoldOf, holdsOf, installClock, installDecision } from "@bitburner-agent/model";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUGMENTATION_COUNT_HOLD_SETTING,
  AUGMENTATION_CYCLE_REBUILD_SETTING,
  AUGMENTATION_CYCLE_SEEN_SETTING,
  AUGMENTATION_CYCLE_SETTING,
  AUGMENTATION_INCOME_WINDOW_MS,
  AUGMENTATION_INSTALL_INTENT,
  AUGMENTATION_INSTALL_WAIT_SETTING,
  AUGMENTATION_LEVEL_RAMP_SETTING,
  AUGMENTATION_LEVEL_RISE_SETTING,
  AUGMENTATION_ONLINE_SETTING,
  AUGMENTATION_PROGRESS_COUNTS_EVERY_MS,
  AUGMENTATION_RESERVE_LOOKAHEAD_MS,
  type AugmentationEvent,
  type AugmentationInputs,
  AugmentationRule,
  advanceOnlineClock,
  countablesToCome,
  cycleUnseenMs,
  describeProgress,
  describeReason,
  earnedOf,
  formatEta,
  type InstallTimingPolicy,
  type InstallTimingView,
  purchaseIntent,
  readAugmentationCycle,
  readAugmentationsEnabled,
  readCarriedLevelRise,
  readCountHold,
  readCycleRebuild,
  readCycleSeen,
  readGangRateKept,
  readGangRedPillHold,
  readInstallWait,
  readLevelRamp,
  readOnlineClock,
  shareBonusMean,
} from "../src/augmentations.ts";
import { HOME_KEPT_FOR_THE_AGENT_GB } from "../src/batcher.ts";
import * as cloud from "../src/cloud-servers.ts";
import { bestWorkRate, workConditionsOf, workingPersonOf } from "../src/factions.ts";
import { PURCHASE_PRICES } from "../src/programs.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { HACKING_EXP_WINDOW_MS, HackingExpRate } from "../src/world-daemon.ts";

const GEN_I = "Cranial Signal Processors - Gen I";
const GEN_II = "Cranial Signal Processors - Gen II";
const NFG = "NeuroFlux Governor";
/** CyberSec's five in buy order, and their money then (core's test works it). */
const FIVE = [GEN_I, GEN_II, "BitWire", "Synaptic Enhancement Implant", "Neurotrainer I"];
const FIVE_COST = 447_170_900;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOTHING_QUEUED = "nothing queued to install (the faction state's queue is empty)";
/** NeuroFlux Governor's first two levels after `queued` purchases: 750k × 1.9^q, then 750k × 1.14 × 1.9^(q+1). */
const level1After = (queued: number) => 750_000 * 1.9 ** queued;
const level2After = (queued: number) => 750_000 * 1.14 * 1.9 ** (queued + 1);
/** Money over a sum, so floating point never decides a count. */
const SLACK = 1_000;
/**
 * Eight reached: CyberSec at 18,750 (its five) and NiteSec at 15,000 (Artificial Synaptic Potentiation, Neurotrainer
 * II and Embedded Netburner Module more); NiteSec sells more beyond, so something is left.
 */
const EIGHT_JOINED = [
  { name: "CyberSec", reputation: 18_750, favor: 0 },
  { name: "NiteSec", reputation: 15_000, favor: 0 },
];
const EIGHT_COST = chooseAugmentationsToBuy(
  [...FIVE, "Artificial Synaptic Potentiation", "Neurotrainer II", "Embedded Netburner Module"],
  {
    installed: {},
    queued: [],
    sourceFile11Level: 0,
    bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
  },
  1e15,
  300,
).money;
const dollars = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;

let directory: string;
let store: TelemetryStore;
let lines: string[];
let events: AugmentationEvent[];
let rule: AugmentationRule;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "augmentations-"));
  store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
  lines = [];
  events = [];
  rule = newRule();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * The rule, its install timing short of Daedalus's count the count rule's (#343: the A/B's baseline), so these tests
 * work the count rule, its countdown and decision 56's hold on this file's fixture, short of the count (nothing
 * installed, Daedalus not inviting): the count rule's own path once the count is met. The planner's are its own tests.
 */
const newRule = (installTiming: InstallTimingPolicy = "count rule") =>
  new AugmentationRule({
    store,
    log: (line) => lines.push(line),
    emit: (event) => events.push(event),
    installTiming,
  });

/** A medium snapshot: hacking `hacking` (its experience at multiplier 1), the money, home's RAM, in Sector-12. */
function medium({ hacking = 300, money = 0, homeRam = 1024 } = {}): MediumSnapshotData {
  const exp = Math.max(0, Math.exp((hacking + 200) / 32) - 534.6);
  return {
    player: {
      skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      exp: { hacking: exp },
      mults: { faction_rep: 1, hacking: 1 },
      money,
      city: "Sector-12",
    },
    hasTorRouter: true,
    programs: [],
    servers: [{ hostname: "home", maxRam: homeRam, cpuCores: 1, hasAdminRights: true }],
  };
}

/** A slow snapshot: the faction state read, CyberSec joined at `reputation`, `earned` so far, installed `ownedAugs`. */
function slow({
  reputation = 0,
  queued = [] as string[],
  joined = undefined as FactionState["joined"] | undefined,
  earned = 0,
  lastAugReset = 0,
  ownedAugs = {} as Record<string, number>,
  reading = "read" as "read" | "skipped" | "unread",
  currentNode = 1,
} = {}): SlowSnapshotData {
  const state: FactionState = {
    joined: joined ?? [{ name: "CyberSec", reputation, favor: 0 }],
    invitations: [],
    queuedAugmentations: queued,
  };
  return {
    resetInfo: { lastAugReset, lastNodeReset: 0, currentNode, ownedAugs, ownedSF: {}, bitNodeOptions: {} },
    purchasedServers: [],
    moneySources: { hacking: earned, servers: -5e9, other: 1e12 },
    factions:
      reading === "read"
        ? { backend: "sim", state, problem: null }
        : reading === "skipped"
          ? { backend: "ui", state, problem: null, skipped: "no sidebar" }
          : { backend: "ui", state: null, problem: "the page's Factions wouldn't open" },
  };
}

/** The game's time of each slow snapshot fed, from 7 h after the last install (no quick install). */
let gameTimeMs = 7 * HOUR;
beforeEach(() => {
  gameTimeMs = 7 * HOUR;
});
/**
 * An update; the fast and medium snapshots taken at the game's time `nowMs` unless said (the medium's then not before
 * the fast's): its money is fresh. The slow snapshot's game time is the latest, so the countdown's clock.
 */
function update(fields: Partial<AugmentationInputs> & { slowData?: SlowSnapshotData | null } = {}) {
  return rule.update({
    mediumData: medium(),
    mediumGameTimeMs: fields.nowMs ?? 1_000,
    fastGameTimeMs: fields.nowMs ?? 1_000,
    slowData: slow(),
    slowGameTimeMs: gameTimeMs,
    doneIds: new Set(),
    nowMs: 1_000,
    enabled: true,
    homeRamEnabled: true,
    destroyWanted: false,
    ...fields,
  });
}
/** Ten minutes of slow snapshots a minute apart, earning `perSecond`: the income measured. */
function measureIncome(perSecond: number, slowFields: Parameters<typeof slow>[0] = {}, mediumData = medium()) {
  let earned = 0;
  for (let minute = 0; minute <= 10; minute += 1) {
    gameTimeMs += MINUTE;
    earned += perSecond * 60;
    update({ slowData: slow({ ...slowFields, earned }), mediumData });
  }
}
/** The update the rule says install on, then its countdown run out: committed. */
function throughCountdown(fields: Parameters<typeof update>[0] = {}, countdownMs = 90_000) {
  update(fields);
  expect(rule.view().progress?.countdown).not.toBeNull();
  gameTimeMs += countdownMs;
  const ask = update(fields);
  expect(readAugmentationCycle(store)).not.toBeNull();
  return ask;
}
const progressEvents = () => events.filter((event) => event.type === "augmentationProgress");

describe("waiting", () => {
  test("for the snapshots, the reset info, the player and the faction state, saying which", () => {
    expect(update({ mediumData: null })).toEqual({ intent: null, install: false, committed: false });
    expect(rule.view()).toMatchObject({ waiting: true, enabled: true });
    const noReset = { ...slow(), resetInfo: undefined } as unknown as SlowSnapshotData;
    update({ slowData: noReset });
    expect(rule.view()).toMatchObject({ waiting: false, waitingFor: "the reset info in the Agent's slow snapshot" });
    update({ mediumData: { ...medium(), player: { skills: { hacking: 1 } } } });
    expect(rule.view().waitingFor).toMatch(/^the player's skills, money and multipliers/);
    update({ slowData: slow({ reading: "unread" }) });
    expect(rule.view().waitingFor).toBe(
      "the faction state in the Agent's slow snapshot (unread: the page's Factions wouldn't open)",
    );
    expect(events).toEqual([]);
  });

  test("nothing to install: no countdown, no commit, whatever the income; the count said", () => {
    measureIncome(1_000_000, { reputation: 0 });
    expect(update({ slowData: slow({ reputation: 0 }) }).committed).toBe(false);
    expect(rule.view().waitingFor).toBe(
      "the count to reach a bar: 0 of 8 new augmentations affordable (0 of 12 with NeuroFlux), 10 min online this " +
        "cycle; the bar falls to 7 in 1.8 h; short of Daedalus's count (0 of 30 augmentations installed): any augmentation counts",
    );
    expect(rule.view().progress).toMatchObject({ countdown: null, reason: null });
  });
});

describe("the bars' clock: the game's time online this cycle (#222)", () => {
  test("slow snapshots of a cycle no more than 3 minutes apart add up; a gap, or the clock set back, is left out", () => {
    measureIncome(0, { reputation: 0 });
    expect(rule.view().progress?.onlineMs).toBe(10 * MINUTE);
    // The game closed for an hour: left out, logged.
    gameTimeMs += HOUR;
    update();
    expect(rule.view().progress?.onlineMs).toBe(10 * MINUTE);
    expect(lines.at(-1)).toBe(
      "augmentations: a gap of 1.0 h between slow snapshots: left out of the time online this cycle, and the income " +
        "is measured afresh",
    );
    // 3 minutes exactly counts; a millisecond more doesn't.
    gameTimeMs += 3 * MINUTE;
    update();
    expect(rule.view().progress?.onlineMs).toBe(13 * MINUTE);
    gameTimeMs += 3 * MINUTE + 1;
    update();
    expect(rule.view().progress?.onlineMs).toBe(13 * MINUTE);
    gameTimeMs -= MINUTE;
    update();
    expect(rule.view().progress?.onlineMs).toBe(13 * MINUTE);
    expect(lines.at(-1)).toMatch(/^augmentations: the game's clock set back between slow snapshots: left out/);
    // The same slow snapshot again adds nothing.
    update();
    expect(rule.view().progress?.onlineMs).toBe(13 * MINUTE);
  });

  test("kept in the store: a restarted brain carries it on; another lastAugReset starts it at 0", () => {
    measureIncome(0, { reputation: 0 });
    expect(readOnlineClock(store)).toEqual({ lastAugReset: 0, onlineMs: 10 * MINUTE, lastGameTimeMs: gameTimeMs });
    rule = newRule();
    gameTimeMs += MINUTE;
    update();
    expect(rule.view().progress?.onlineMs).toBe(11 * MINUTE);
    // The game reset (installed): the next cycle's clock.
    gameTimeMs += MINUTE;
    update({ slowData: slow({ lastAugReset: gameTimeMs - 30_000 }) });
    expect(rule.view().progress?.onlineMs).toBe(0);
    expect(readOnlineClock(store)).toMatchObject({ lastAugReset: gameTimeMs - 30_000, onlineMs: 0 });
  });

  test("never the game's time since the install, and a clock the brain didn't write fails", () => {
    // 95 h since the install, first seen now: 0 online.
    gameTimeMs = 95 * HOUR;
    update();
    expect(rule.view().progress).toMatchObject({ onlineMs: 0, bar: 8, barWithNeuroFlux: 12 });
    expect(advanceOnlineClock(null, 95 * HOUR, 0)).toEqual({
      clock: { lastAugReset: 0, onlineMs: 0, lastGameTimeMs: 95 * HOUR },
      leftOutMs: null,
    });
    store.setSetting(AUGMENTATION_ONLINE_SETTING, "{");
    expect(() => newRule()).toThrow("isn't JSON");
    store.setSetting(AUGMENTATION_ONLINE_SETTING, JSON.stringify({ lastAugReset: 0, onlineMs: -1, lastGameTimeMs: 0 }));
    expect(() => newRule()).toThrow("isn't a clock the brain wrote");
  });
});

describe("the count rule (#222)", () => {
  test("last night's shape: a save 95 h into its cycle, first seen now, has bars of 8 and 12, not 1", () => {
    // CyberSec's five reached, NiteSec joined with nothing reached (something left), the money for the five and two
    // NeuroFlux Governor levels: 5 of 8, 7 of 12. The game's time since the install (95 h) doesn't lower the bars.
    gameTimeMs = 95 * HOUR;
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    const mediumData = medium({ money: FIVE_COST + level1After(5) + level2After(5) + SLACK });
    update({ slowData: slow({ joined }), mediumData });
    expect(rule.view().progress).toMatchObject({
      affordable: 5,
      affordableWithNeuroFlux: 7,
      bar: 8,
      barWithNeuroFlux: 12,
      onlineMs: 0,
      reason: null,
      countdown: null,
    });
    expect(rule.view().waitingFor).toBe(
      "the count to reach a bar: 5 of 8 new augmentations affordable (7 of 12 with NeuroFlux), 0 s online this cycle; " +
        "the bar falls to 7 in 2.0 h; short of Daedalus's count (0 of 30 augmentations installed): any augmentation counts",
    );
    expect(readAugmentationCycle(store)).toBeNull();
    // 6 h online in slow snapshots 3 minutes apart: the bar falls to 5, the count, and the countdown starts.
    for (let step = 0; step < 119; step += 1) {
      gameTimeMs += 3 * MINUTE;
      update({ slowData: slow({ joined }), mediumData });
    }
    expect(rule.view().progress).toMatchObject({ bar: 6, countdown: null });
    gameTimeMs += 3 * MINUTE;
    update({ slowData: slow({ joined }), mediumData });
    expect(rule.view().progress).toMatchObject({
      bar: 5,
      barWithNeuroFlux: 9,
      onlineMs: 6 * HOUR,
      reason: "count reached",
      countdown: { endsInMs: 90_000, quick: false, extensions: 0 },
    });
    gameTimeMs += 90_000;
    update({ slowData: slow({ joined }), mediumData });
    expect(events.at(-1)).toEqual({
      type: "augmentationInstallChosen",
      atMs: 1_000,
      set: FIVE.map((augmentation) => ({ augmentation, price: expect.any(Number) })),
      cost: FIVE_COST,
      queued: [],
      onlineMs: 6 * HOUR + 90_000,
      affordable: 5,
      affordableWithNeuroFlux: 7,
      bar: 5,
      barWithNeuroFlux: 9,
      reason: "count reached",
      donations: [],
      // Short of Daedalus's count (#343): the run report fails an install there without the planner's estimates.
      short: { installed: 0, required: 30 },
    });
    expect(lines.at(-1)).toBe(
      `augmentations: install chosen, 6.0 h online this cycle: buying ${FIVE.join(", ")} ($447,170,900), the count ` +
        "reached: 5 of 5 new augmentations affordable (7 of 9 with NeuroFlux)",
    );
  });

  test("last night's shape, 8 affordable: the countdown at once, 95 h or not", () => {
    gameTimeMs = 95 * HOUR;
    update({ slowData: slow({ joined: EIGHT_JOINED }), mediumData: medium({ money: EIGHT_COST + SLACK }) });
    expect(rule.view().progress).toMatchObject({
      affordable: 8,
      affordableWithNeuroFlux: 8,
      bar: 8,
      reason: "count reached",
      countdown: { endsInMs: 90_000 },
    });
  });

  test("12 with NeuroFlux Governor's levels: the count reached", () => {
    // CyberSec's five and, with $1b, 4 levels (9); with $3b, enough more for 12 or over.
    update({
      slowData: slow({ joined: [...EIGHT_JOINED.slice(0, 1), { name: "NiteSec", reputation: 0, favor: 0 }] }),
      mediumData: medium({ money: 1e9 }),
    });
    expect(rule.view().progress).toMatchObject({ affordable: 5, affordableWithNeuroFlux: 9, reason: null });
    update({
      slowData: slow({ joined: [...EIGHT_JOINED.slice(0, 1), { name: "NiteSec", reputation: 0, favor: 0 }] }),
      mediumData: medium({ money: 1e12 }),
    });
    expect(rule.view().progress?.affordableWithNeuroFlux).toBeGreaterThanOrEqual(12);
    expect(rule.view().progress).toMatchObject({ affordable: 5, reason: "count reached" });
  });

  test("nothing left at the joined factions (CyberSec's five reached): installs, after the countdown", () => {
    const ask = throughCountdown({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: FIVE_COST }) });
    expect(ask).toEqual({ intent: purchaseIntent("CyberSec", GEN_I, 1), install: false, committed: true });
    expect(readAugmentationCycle(store)).toEqual({
      lastAugReset: 0,
      installing: false,
      neuroFluxTarget: 0,
      donations: [],
      reason: "nothing left",
      // Short of Daedalus's count (#238): nothing else reached at CyberSec, no NeuroFlux Governor level.
      countFacts: { moneyAfterSet: 0, within: [] },
    });
    expect(events.at(-1)).toMatchObject({ type: "augmentationInstallChosen", reason: "nothing left", cost: FIVE_COST });
    expect(lines).toEqual([
      "augmentations: install countdown started, 90 s, nothing else worth installing at the joined factions; " +
        "$447,170,900 held back from cloud servers and home RAM",
      "augmentations: install countdown ended (0 extensions)",
      `augmentations: install chosen, 2 min online this cycle: buying ${FIVE.join(", ")} ($447,170,900), nothing ` +
        "else worth installing at the joined factions",
    ]);
    expect(rule.view()).toMatchObject({
      committed: true,
      asking: `buying ${GEN_I} from CyberSec for $70,000,000`,
      reserve: Number.POSITIVE_INFINITY,
      progress: null,
    });
  });

  test("a quick install: 4 with NeuroFlux within 20 minutes of the last install, a 30 s countdown", () => {
    gameTimeMs = 5 * MINUTE;
    const joined = [
      { name: "CyberSec", reputation: 10_000, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    // Gen I, BitWire, Synaptic and Neurotrainer I reached and covered: 4.
    const fields = { slowData: slow({ joined }), mediumData: medium({ money: 1e9 }) };
    update(fields);
    expect(rule.view().progress).toMatchObject({
      affordableWithNeuroFlux: expect.any(Number),
      reason: "quick install",
      countdown: { endsInMs: 30_000, quick: true },
    });
    expect(lines.at(-1)).toMatch(
      /^augmentations: install countdown started, 30 s, a quick install, within 20 min of the last install: 4 of 8 /,
    );
    gameTimeMs += 30_000;
    update(fields);
    expect(events.at(-1)).toMatchObject({ type: "augmentationInstallChosen", reason: "quick install" });
  });
});

describe("the countdown (#222)", () => {
  /** Eight reached and covered: the count reached; `extra` money more. */
  const eight = (extra = 0) => ({
    slowData: slow({ joined: EIGHT_JOINED }),
    mediumData: medium({ money: EIGHT_COST + SLACK + extra }),
  });

  test("started at 90 s, holding the counted purchases' money back; extended as the count rises; never shortened", () => {
    update(eight());
    const startedAt = gameTimeMs;
    expect(lines).toEqual([
      "augmentations: install countdown started, 90 s, the count reached: 8 of 8 new augmentations affordable (8 of " +
        `12 with NeuroFlux); ${dollars(EIGHT_COST)} held back from cloud servers and home RAM`,
    ]);
    expect(rule.reserve()).toBeCloseTo(EIGHT_COST, 0);
    expect(rule.countdownReserve()).toBeCloseTo(EIGHT_COST, 0);
    expect(rule.view().waitingFor).toMatch(/^the install countdown: 90 s left, the count reached: 8 of 8 /);
    expect(readAugmentationCycle(store)).toBeNull();
    // 30 s on, a NeuroFlux Governor level more: extension 1, 90 × (1 − 1/12) = 82.5 s from now (the end was 60 s off).
    gameTimeMs = startedAt + 30_000;
    update(eight(level1After(8)));
    expect(rule.view().progress?.countdown).toEqual({
      endsAtGameMs: startedAt + 112_500,
      endsInMs: 82_500,
      quick: false,
      extensions: 1,
    });
    expect(lines.at(-1)).toBe(
      "augmentations: install countdown extended, 83 s from now (extension 1): 8 of 8 new augmentations affordable " +
        "(9 of 12 with NeuroFlux)",
    );
    expect(rule.countdownReserve()).toBeCloseTo(EIGHT_COST + level1After(8), 0);
    // 2 s on, another: extension 2 would end 75 s from now, sooner than the end set: not shortened, not logged.
    gameTimeMs = startedAt + 32_000;
    update(eight(level1After(8) + level2After(8)));
    expect(rule.view().progress?.countdown).toMatchObject({ endsAtGameMs: startedAt + 112_500, extensions: 2 });
    expect(lines.filter((line) => line.includes("countdown extended"))).toHaveLength(1);
    // A millisecond before the end: still counting down; at it, the install.
    gameTimeMs = startedAt + 112_499;
    update(eight(level1After(8) + level2After(8)));
    expect(readAugmentationCycle(store)).toBeNull();
    gameTimeMs = startedAt + 112_500;
    update(eight(level1After(8) + level2After(8)));
    expect(readAugmentationCycle(store)).not.toBeNull();
    expect(lines.slice(-2)).toEqual([
      "augmentations: install countdown ended (2 extensions)",
      expect.stringMatching(
        /^augmentations: install chosen, \S+ min online this cycle: buying .*, the count reached: /,
      ),
    ]);
  });

  test("the count falling back under the bar calls it off, logged; nothing held back for it then", () => {
    update(eight());
    gameTimeMs += 10_000;
    update(eight(-20e6));
    expect(lines.at(-1)).toMatch(
      /^augmentations: install countdown called off: the rule no longer says install: 7 of 8 new augmentations /,
    );
    expect(rule.view().progress?.countdown).toBeNull();
    expect(rule.countdownReserve()).toBe(0);
    expect(rule.reserve()).toBe(0);
    // Back over the bar: a new countdown, from 90 s.
    gameTimeMs += 10_000;
    update(eight());
    expect(rule.view().progress?.countdown).toMatchObject({ endsInMs: 90_000, extensions: 0 });
  });

  test("The Red Pill reached: no countdown, the one under way given way to it", () => {
    update(eight());
    const joined = [...EIGHT_JOINED, { name: "Daedalus", reputation: 2.5e6, favor: 0 }];
    gameTimeMs += 5_000;
    update({ slowData: slow({ joined }), mediumData: medium({ money: EIGHT_COST + SLACK }) });
    expect(lines.slice(-2, -1)).toEqual([
      "augmentations: install countdown called off: The Red Pill reached, installed at once",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "augmentationInstallChosen", reason: "The Red Pill" });
  });

  test("The Red Pill's way holding the install calls the countdown off: the destroy wanted after it's installed", () => {
    // The Red Pill installed, the destroy not wanted: ordinary installs go on. Wanted: held (#215 review).
    const installed = {
      slowData: slow({ joined: EIGHT_JOINED, ownedAugs: { "The Red Pill": 1 } }),
      mediumData: medium({ money: EIGHT_COST + SLACK }),
    };
    update(installed);
    expect(rule.view().progress?.countdown).not.toBeNull();
    gameTimeMs += 5_000;
    update({ ...installed, destroyWanted: true });
    const why =
      "the BitNode's destroy: The Red Pill is installed, and an install would reset the hacking level w0r1d_d43m0n " +
      "needs (the destroy switched on)";
    expect(lines.at(-1)).toBe(`augmentations: install countdown called off: held for ${why}`);
    expect(rule.view().progress).toMatchObject({ reason: "count reached", countdown: null, held: why });
    expect(rule.countdownReserve()).toBe(0);
    expect(progressEvents().at(-1)).toMatchObject({ held: why, countdown: null });
    gameTimeMs += 90_000;
    update({ ...installed, destroyWanted: true });
    expect(readAugmentationCycle(store)).toBeNull();
  });

  test("the switch off calls it off; a reset does too", () => {
    update(eight());
    update({ ...eight(), enabled: false });
    expect(lines.at(-1)).toBe("augmentations: install countdown called off: the Augmentations switch turned off");
    expect(rule.countdownReserve()).toBe(0);
    update(eight());
    gameTimeMs += MINUTE;
    update({ slowData: slow({ joined: EIGHT_JOINED, lastAugReset: gameTimeMs - 1_000 }), mediumData: null });
    expect(lines.at(-1)).toBe("augmentations: install countdown called off: the game has reset");
  });

  test("the game's clock set back (a save loaded): called off, logged, and a fresh countdown from the new time", () => {
    update(eight());
    gameTimeMs += 60_000;
    update(eight());
    expect(rule.view().progress?.countdown).toMatchObject({ endsInMs: 30_000 });
    // An hour back: the old end would be 61 minutes off; called off, and a countdown from now.
    gameTimeMs -= HOUR;
    update(eight());
    expect(lines.slice(-2)).toEqual([
      "augmentations: install countdown called off: the game's clock set back",
      expect.stringMatching(/^augmentations: install countdown started, 90 s, the count reached: /),
    ]);
    expect(rule.view().progress?.countdown).toMatchObject({ endsInMs: 90_000, extensions: 0 });
    expect(readAugmentationCycle(store)).toBeNull();
  });

  test("a brain restarted mid-countdown starts a fresh one (the countdown isn't stored): the safe side", () => {
    update(eight());
    gameTimeMs += 60_000;
    update(eight());
    rule = newRule();
    update(eight());
    expect(rule.view().progress?.countdown).toMatchObject({ endsInMs: 90_000 });
    gameTimeMs += 89_999;
    update(eight());
    expect(readAugmentationCycle(store)).toBeNull();
    gameTimeMs += 1;
    update(eight());
    expect(readAugmentationCycle(store)).not.toBeNull();
  });

  test("the lookahead's rule is 15 minutes on: no money held for a quick install its window will have closed on", () => {
    // 10 minutes into the cycle, Neurotrainer I reached and two NeuroFlux Governor levels covered ($8.6m): 3 with
    // NeuroFlux. At $10k/s, 15 minutes on the money covers a third level, 4, a quick install by today's clocks; but the
    // cycle is 25 minutes in then, past a quick install's 20, and 4 is under the bars: nothing held.
    gameTimeMs = 0;
    const joined = [
      { name: "CyberSec", reputation: 1_000, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    measureIncome(10_000, { joined }, medium({ money: 8.6e6 }));
    expect(rule.view().progress).toMatchObject({ affordable: 1, affordableWithNeuroFlux: 3, onlineMs: 10 * MINUTE });
    expect(rule.reserve()).toBe(0);
  });
});

describe("the progress events (#222)", () => {
  test("one each time the counts, a bar or the countdown change; none while steady", () => {
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    for (let minute = 0; minute < 5; minute += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slow({ joined }), mediumData: medium({ money: FIVE_COST + SLACK }) });
    }
    expect(progressEvents()).toEqual([
      {
        type: "augmentationProgress",
        atMs: 1_000,
        lastAugReset: 0,
        affordable: 5,
        affordableWithNeuroFlux: 5,
        bar: 8,
        barWithNeuroFlux: 12,
        onlineMs: 0,
        barFallsInMs: 2 * HOUR,
        barWithNeuroFluxFallsInMs: 2 * HOUR,
        reason: null,
        countdown: null,
        held: null,
        byDonation: 0,
        setCost: expect.closeTo(FIVE_COST, 0),
        // Nothing installed: short of Daedalus's count (#228).
        short: { installed: 0, required: 30 },
        // No install held for the count (#243).
        countHold: null,
      },
    ]);
    // A NeuroFlux Governor level more, 5 minutes after the last recorded (the brain's time): recorded.
    gameTimeMs += MINUTE;
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: FIVE_COST + level1After(5) + SLACK }),
      nowMs: 1_000 + AUGMENTATION_PROGRESS_COUNTS_EVERY_MS,
    });
    expect(progressEvents()).toHaveLength(2);
    expect(progressEvents().at(-1)).toMatchObject({ affordableWithNeuroFlux: 6, onlineMs: 5 * MINUTE });
    expect(describeProgress(progressEvents().at(-1) as never)).toBe(
      "5 of 8 new augmentations affordable (6 of 12 with NeuroFlux), 5 min online this cycle; the bar falls to 7 in " +
        "1.9 h; short of Daedalus's count (0 of 30 augmentations installed): any augmentation counts",
    );
  });

  test("money see-sawing across a NeuroFlux Governor price: the counts alone recorded at most every 5 minutes", () => {
    expect(AUGMENTATION_PROGRESS_COUNTS_EVERY_MS).toBe(5 * MINUTE);
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    // Every 10 s of the brain's time for 4 minutes, the money over and under the first level's price: one event.
    for (let step = 0; step < 24; step += 1) {
      gameTimeMs += 10_000;
      const money = FIVE_COST + SLACK + (step % 2 === 0 ? 0 : level1After(5));
      update({ slowData: slow({ joined }), mediumData: medium({ money }), nowMs: 1_000 + step * 10_000 });
    }
    expect(progressEvents()).toHaveLength(1);
    // Past 5 minutes, the counts differing from the last recorded: one more.
    gameTimeMs += 10_000;
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: FIVE_COST + SLACK + level1After(5) }),
      nowMs: 1_000 + AUGMENTATION_PROGRESS_COUNTS_EVERY_MS,
    });
    expect(progressEvents()).toHaveLength(2);
    // A countdown starting is recorded at once (8 affordable): the counts change with it.
    update({
      slowData: slow({ joined: EIGHT_JOINED }),
      mediumData: medium({ money: EIGHT_COST + SLACK }),
      nowMs: 1_000 + AUGMENTATION_PROGRESS_COUNTS_EVERY_MS + 10_000,
    });
    expect(progressEvents()).toHaveLength(3);
    expect(progressEvents().at(-1)?.countdown).not.toBeNull();
  });

  test("a bar falling on its own, the counts unchanged, is recorded at once (the report's overdue clock reads it)", () => {
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    // 2 h online in 3-minute slow snapshots, the brain's time with them: the bars fall to 7 and 11.
    for (let step = 0; step <= 40; step += 1) {
      update({
        slowData: slow({ joined }),
        mediumData: medium({ money: FIVE_COST + SLACK }),
        nowMs: 1_000 + step * 3 * MINUTE,
      });
      gameTimeMs += 3 * MINUTE;
    }
    expect(progressEvents().map((event) => [event.bar, event.barWithNeuroFlux, event.onlineMs])).toEqual([
      [8, 12, 0],
      [7, 11, 2 * HOUR],
    ]);
  });
});

describe("the reserve before the countdown: the lookahead (#222, A2's)", () => {
  test("held back only for an install the rule would choose with 15 minutes more income: its purchases' money", () => {
    // Eight reached, $10m short of covering all eight, at $20k/s: 15 minutes ($18m) covers them, so their money is held.
    measureIncome(20_000, { joined: EIGHT_JOINED }, medium({ money: EIGHT_COST - 10e6 }));
    expect(rule.view()).toMatchObject({ committed: false, progress: { affordable: 7, countdown: null } });
    expect(rule.reserve()).toBeCloseTo(EIGHT_COST, 0);
    expect(rule.countdownReserve()).toBe(0);
    // $30m short: not covered within the 15 minutes; nothing held back.
    rule = newRule();
    measureIncome(20_000, { joined: EIGHT_JOINED }, medium({ money: EIGHT_COST - 30e6 }));
    expect(rule.reserve()).toBe(0);
    // No income: nothing held back.
    rule = newRule();
    measureIncome(0, { joined: EIGHT_JOINED }, medium({ money: EIGHT_COST - 10e6 }));
    expect(rule.reserve()).toBe(0);
  });

  test("the income needs a full window with no gap: none held back before it", () => {
    let earned = 0;
    for (let minute = 0; minute < 10; minute += 1) {
      gameTimeMs += MINUTE;
      earned += 20_000 * 60;
      update({ slowData: slow({ joined: EIGHT_JOINED, earned }), mediumData: medium({ money: EIGHT_COST - 10e6 }) });
    }
    expect(rule.reserve()).toBe(0);
    gameTimeMs += MINUTE;
    earned += 20_000 * 60;
    update({ slowData: slow({ joined: EIGHT_JOINED, earned }), mediumData: medium({ money: EIGHT_COST - 10e6 }) });
    expect(rule.reserve()).toBeCloseTo(EIGHT_COST, 0);
    // A gap: measured afresh.
    gameTimeMs += HOUR;
    update({
      slowData: slow({ joined: EIGHT_JOINED, earned: earned + 1 }),
      mediumData: medium({ money: EIGHT_COST - 10e6 }),
    });
    expect(rule.reserve()).toBe(0);
  });
});

/**
 * Committed with CyberSec's five reached (nothing left at the joined factions) and `money`, its countdown run out;
 * returns the slow snapshot's fields.
 */
function committed(money = 1e9) {
  const fields = { reputation: 18_750 };
  throughCountdown({ slowData: slow(fields), mediumData: medium({ money, homeRam: 1024 }) });
  return fields;
}

describe("the level's rise carried over an install (#401)", () => {
  /** Medium snapshots a minute apart, hacking 300 + the minute, A6 off (it samples the experience all the same). */
  const measure = (minutes: number) => {
    const rate = new HackingExpRate();
    for (let minute = 0; minute < minutes; minute += 1) {
      const mediumData = medium({ hacking: 300 + minute });
      update({ enabled: false, mediumData, mediumGameTimeMs: minute * MINUTE, fastGameTimeMs: minute * MINUTE });
      rate.add(minute * MINUTE, hackingExpOfLevel(300 + minute, 1));
    }
    return rate;
  };
  /** Committed (the note), all five queued, nothing more to buy: the install, at `minute`. */
  const install = (minute: number) => {
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    return update({
      slowData: slow({ reputation: 18_750, queued: [...FIVE] }),
      mediumData: medium({ hacking: 300 + minute }),
      mediumGameTimeMs: minute * MINUTE,
      fastGameTimeMs: minute * MINUTE,
    });
  };

  test("asked for with the rate measured over its whole window: κ over the level + 50, × the install's gains", () => {
    const rate = measure(11);
    rate.add(11 * MINUTE, hackingExpOfLevel(311, 1));
    expect(install(11)).toEqual({ intent: null, install: true, committed: true });
    const gain = levellingInstallMultipliers(0, FIVE);
    expect(gain.hackingExp * gain.hackingSpeed).toBeGreaterThan(1);
    expect(readCarriedLevelRise(store)).toEqual({
      lastNodeReset: 0,
      lastAugReset: 0,
      kappa: expect.closeTo(((rate.perSecond() as number) / (311 + 50)) * gain.hackingExp * gain.hackingSpeed, 9),
      // No ramp measured this cycle, none carried in: none yet (#405's review).
      deadMs: null,
    });
  });

  test("its dead time (#405's review): this cycle's ramp measured; else the one carried in; else none", () => {
    // This cycle's ramp, stored: carried as the next cycle's dead time.
    store.setSetting(AUGMENTATION_LEVEL_RAMP_SETTING, JSON.stringify({ lastAugReset: 0, rampMs: 4 * MINUTE }));
    measure(11);
    install(11);
    expect(readCarriedLevelRise(store)).toMatchObject({ lastAugReset: 0, deadMs: 4 * MINUTE });
    // None this cycle (another cycle's ramp), one carried in from the cycle before: the last measured, kept.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    for (const ramp of [null, { lastAugReset: -5, rampMs: MINUTE }, { lastAugReset: 0, rampMs: null }]) {
      rule = newRule();
      if (ramp === null) store.deleteSetting(AUGMENTATION_LEVEL_RAMP_SETTING);
      else store.setSetting(AUGMENTATION_LEVEL_RAMP_SETTING, JSON.stringify(ramp));
      store.setSetting(
        AUGMENTATION_LEVEL_RISE_SETTING,
        // A κ this cycle's rate never reaches: no ramp of its own measured.
        JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa: 1e12, deadMs: 7 * MINUTE }),
      );
      measure(11);
      install(11);
      expect(readCarriedLevelRise(store)).toMatchObject({ lastAugReset: 0, deadMs: 7 * MINUTE });
    }
    // An older setting with no dead time reads as none measured; a bad ramp fails.
    store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa: 1 }));
    expect(readCarriedLevelRise(store)?.deadMs).toBeNull();
    for (const bad of ["{", JSON.stringify({ lastAugReset: 0, rampMs: -1 }), JSON.stringify({ rampMs: 1 })]) {
      store.setSetting(AUGMENTATION_LEVEL_RAMP_SETTING, bad);
      expect(() => readLevelRamp(store)).toThrow(/augmentations\.levelRamp/);
    }
    store.setSetting(
      AUGMENTATION_LEVEL_RISE_SETTING,
      JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa: 1, deadMs: -1 }),
    );
    expect(() => readCarriedLevelRise(store)).toThrow(/augmentations\.levelRise/);
  });

  test("the window not whole (5 minutes): nothing carried, the one stored kept", () => {
    const kept = { lastNodeReset: 0, lastAugReset: -1, kappa: 2 };
    store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, JSON.stringify(kept));
    measure(5);
    expect(install(5)).toEqual({ intent: null, install: true, committed: true });
    expect(readCarriedLevelRise(store)).toEqual({ ...kept, deadMs: null });
  });

  test("a setting the brain didn't write fails: A6 waits, saying why", () => {
    const bad = ["{", JSON.stringify({ lastNodeReset: 0, lastAugReset: 0, kappa: 0 }), JSON.stringify({ kappa: 1 })];
    for (const value of bad) {
      store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, value);
      expect(() => readCarriedLevelRise(store)).toThrow(/augmentations\.levelRise/);
    }
    update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) });
    expect(rule.view().waitingFor).toMatch(
      /^the snapshots as core knows the game \(the store's augmentations\.levelRise/,
    );
  });
});

describe("committed", () => {
  test("the set in buy order, each once reported done; then home's RAM, NeuroFlux Governor, the install", () => {
    // Chosen with $1b: the five and 4 NeuroFlux Governor levels counted ($18.6m, $40.2m, $87.1m, $188.7m after them).
    committed();
    expect(readAugmentationCycle(store)?.neuroFluxTarget).toBe(4);
    const levelsHeld = [5, 6, 7, 8].reduce((sum, queued, level) => sum + 750_000 * 1.14 ** level * 1.9 ** queued, 0);
    let money = 1e9;
    const queue: string[] = [];
    const bought = (id: string) =>
      update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money, homeRam: 128 }),
        doneIds: new Set([id]),
      });
    for (const [index, name] of FIVE.entries()) {
      const ask = update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money, homeRam: 128 }),
      });
      expect(ask.intent).toEqual(purchaseIntent("CyberSec", name, 1));
      const chosen = events.find((event) => event.type === "augmentationInstallChosen");
      const price = (chosen as { set: { price: number }[] }).set[index]?.price as number;
      money -= price;
      bought(ask.intent?.id as string);
      queue.push(name);
    }
    expect(events.filter((event) => event.type === "augmentationBought").map((event) => event)).toEqual(
      FIVE.map((augmentation, index) => ({
        type: "augmentationBought",
        atMs: 1_000,
        augmentation,
        faction: "CyberSec",
        level: 1,
        price: expect.any(Number),
        queueLength: index + 1,
      })),
    );
    // $553m left: home's RAM 128 → 256 GB first ($100.8m: 128 × 32,000 × 1.58⁷), leaving more than the levels held.
    const homeRam = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 128 }),
    });
    expect(homeRam.intent).toMatchObject({
      action: "upgradeHomeRam",
      args: { fromRam: 128, vendor: "Alpha Enterprises" },
    });
    expect(rule.view().asking).toBe("home RAM to 256 GB before the install (it stays)");
    update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 128 }),
      doneIds: new Set([homeRam.intent?.id as string]),
    });
    // Reported done again, the medium snapshot not yet showing it: logged once.
    const again = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 128 }),
      doneIds: new Set([homeRam.intent?.id as string]),
    });
    expect(again.intent).toEqual(homeRam.intent);
    expect(lines.filter((line) => line.endsWith("done, before the install (home's RAM stays)"))).toHaveLength(1);
    // Home at 256 GB, $452m left: 256 → 512 GB ($318m) would leave $134m, under the $334.6m held for the 4 levels
    // counted (#222 review): NeuroFlux Governor level 1 instead, at 750k × 1.9⁵ = $18.6m.
    money -= 128 * 32_000 * 1.58 ** 7;
    expect(money - 256 * 32_000 * 1.58 ** 8).toBeLessThan(levelsHeld);
    const neuroFlux = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 256 }),
      nowMs: 2_000,
    });
    expect(neuroFlux.intent).toEqual(purchaseIntent("CyberSec", NFG, 1));
    expect(rule.view().asking).toBe(`buying ${NFG} level 1 from CyberSec for $18,570,742`);
    update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money }),
      doneIds: new Set([neuroFlux.intent?.id as string]),
    });
    // Level 2: 750k × 1.14 × 1.9⁶, $40.2m; with $30m, none. The queue not yet showing every purchase: waiting.
    money = 30e6;
    const waiting = update({ slowData: slow({ reputation: 18_750, queued: queue }), mediumData: medium({ money }) });
    expect(waiting).toEqual({ intent: null, install: false, committed: true });
    expect(rule.view().waitingFor).toMatch(
      /^the faction state to show .*NeuroFlux Governor queued, before the install$/,
    );
    // A read showing all six: the install.
    gameTimeMs += MINUTE;
    const install = update({
      slowData: slow({ reputation: 18_750, queued: [...queue, NFG] }),
      mediumData: medium({ money }),
    });
    expect(install).toEqual({ intent: null, install: true, committed: true });
    expect(rule.view().asking).toBe("installing 6 queued");
    // Asked for, the install stays, though the money now covers more.
    expect(
      update({ slowData: slow({ reputation: 18_750, queued: [...queue, NFG] }), mediumData: medium({ money: 1e9 }) }),
    ).toEqual({ intent: null, install: true, committed: true });
  });

  test("home's RAM switch off: none bought before the install, NeuroFlux Governor next", () => {
    committed();
    const ask = update({
      slowData: slow({ reputation: 18_750, queued: [...FIVE] }),
      mediumData: medium({ money: 1e9, homeRam: 8 }),
      homeRamEnabled: false,
    });
    expect(ask.intent).toEqual(purchaseIntent("CyberSec", NFG, 1));
  });

  test("a NeuroFlux Governor level needs a seller's reputation as well as the money", () => {
    // Level 1 at CyberSec needs 500 rep: with 400 there (the five installed already, and one more queued), none.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const ask = update({
      slowData: slow({ reputation: 400, queued: ["BitWire"], ownedAugs: {} }),
      mediumData: medium({ money: 1e12, homeRam: 2 ** 20 }),
    });
    expect(ask.install).toBe(true);
  });

  test("a purchase two reads don't show queued: the event, the log line, the alert's list", () => {
    committed();
    const first = update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) });
    update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      doneIds: new Set([first.intent?.id as string]),
      nowMs: 5_000,
    });
    // While unshown, it counts as queued: the next asked for is Gen II.
    expect(update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) }).intent).toEqual(
      purchaseIntent("CyberSec", GEN_II, 1),
    );
    // A skipped read doesn't count; the first read missing it doesn't either.
    gameTimeMs += MINUTE;
    update({ slowData: slow({ reputation: 18_750, reading: "skipped" }), mediumData: medium({ money: 1e9 }) });
    gameTimeMs += MINUTE;
    update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }), nowMs: 70_000 });
    expect(rule.notQueued()).toEqual([]);
    gameTimeMs += MINUTE;
    update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }), nowMs: 130_000 });
    expect(rule.notQueued()).toEqual([{ augmentation: GEN_I, level: 1, boughtAtMs: 5_000 }]);
    expect(events.at(-1)).toEqual({
      type: "augmentationNotQueued",
      atMs: 130_000,
      augmentation: GEN_I,
      level: 1,
      boughtAtMs: 5_000,
    });
    expect(lines.at(-1)).toBe(
      `augmentations: ${GEN_I} NOT QUEUED: the Agent reported it bought, and 2 faction state reads since don't show it`,
    );
    expect(rule.view().notQueued).toHaveLength(1);
    // Never asked for again (#213 review): it counts as queued, alerted; the next is still Gen II.
    expect(update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) }).intent).toEqual(
      purchaseIntent("CyberSec", GEN_II, 1),
    );
    // A new game: that game's purchases forgotten, the alert's list too.
    gameTimeMs += MINUTE;
    update({ slowData: slow({ lastAugReset: 9 * HOUR }) });
    expect(rule.notQueued()).toEqual([]);
  });

  test("the money spent since the medium snapshot is taken off its money: no phantom money (#213 review)", () => {
    // The game's times: the medium snapshot taken at 1,000, each purchase reported done in a fast one after it.
    // $447,170,900 covers the five exactly. Bought, with the medium snapshot from before them still the latest, nothing
    // is left: no NeuroFlux Governor ($18.6m) on money already spent.
    committed(FIVE_COST);
    const queue: string[] = [];
    for (const [index, name] of FIVE.entries()) {
      const nowMs = 2_000 + index;
      const ask = update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money: FIVE_COST }),
        mediumGameTimeMs: 1_000,
        nowMs,
      });
      expect(ask.intent).toEqual(purchaseIntent("CyberSec", name, 1));
      update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money: FIVE_COST }),
        mediumGameTimeMs: 1_000,
        nowMs,
        doneIds: new Set([ask.intent?.id as string]),
      });
      queue.push(name);
    }
    const stale = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money: FIVE_COST }),
      mediumGameTimeMs: 1_000,
      nowMs: 3_000,
    });
    // Not NeuroFlux Governor: waiting for the faction state to show the five, with nothing left to buy.
    expect(stale).toEqual({ intent: null, install: false, committed: true });
    expect(rule.view().waitingFor).toMatch(/^the faction state to show /);
  });

  test("a medium snapshot after the purchases is the money: the spending isn't taken off twice", () => {
    committed();
    const first = update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      nowMs: 2_000,
      mediumGameTimeMs: 1_000,
    });
    update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      nowMs: 2_000,
      mediumGameTimeMs: 1_000,
      doneIds: new Set([first.intent?.id as string]),
    });
    // The newer snapshot shows $377,170,900 left: Gen II and the rest exactly, nothing more taken off it.
    const ask = update({
      slowData: slow({ reputation: 18_750, queued: [GEN_I] }),
      mediumData: medium({ money: 377_170_900 }),
      nowMs: 3_000,
      mediumGameTimeMs: 3_000,
    });
    expect(ask.intent).toEqual(purchaseIntent("CyberSec", GEN_II, 1));
  });

  test("a purchase shown queued by the next read: confirmed, never not queued", () => {
    committed();
    const first = update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) });
    update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      doneIds: new Set([first.intent?.id as string]),
    });
    for (let read = 0; read < 3; read += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slow({ reputation: 18_750, queued: [GEN_I] }) });
    }
    expect(rule.notQueued()).toEqual([]);
    // Recorded once, though the Agent reports it done again.
    update({ slowData: slow({ reputation: 18_750, queued: [GEN_I] }), doneIds: new Set([first.intent?.id as string]) });
    expect(events.filter((event) => event.type === "augmentationBought")).toHaveLength(1);
  });

  test("NeuroFlux Governor's installed levels count: the level to buy, the queue's copies, the read that shows it", () => {
    // The five installed, NeuroFlux Governor at level 2: the next is level 3 ($975k), then, with one copy queued, 4.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const ownedAugs = { ...Object.fromEntries(FIVE.map((name) => [name, 1])), [NFG]: 2 };
    const first = update({
      slowData: slow({ reputation: 18_750, ownedAugs }),
      mediumData: medium({ money: 1e9, homeRam: 2 ** 20 }),
    });
    expect(first.intent).toEqual(purchaseIntent("CyberSec", NFG, 3));
    update({
      slowData: slow({ reputation: 18_750, ownedAugs }),
      mediumData: medium({ money: 1e9, homeRam: 2 ** 20 }),
      doneIds: new Set([first.intent?.id as string]),
    });
    // A skipped reading carrying a state that shows the copy (not a read, so not yet confirmed): counted once, level 4.
    gameTimeMs += MINUTE;
    const carried = update({
      slowData: slow({ reputation: 18_750, ownedAugs, queued: [NFG], reading: "skipped" }),
      mediumData: medium({ money: 1e9, homeRam: 2 ** 20 }),
    });
    expect(carried.intent).toEqual(purchaseIntent("CyberSec", NFG, 4));
    // Two reads showing one copy queued: level 3 confirmed, never "not queued"; the next is level 4.
    for (let read = 0; read < 2; read += 1) {
      gameTimeMs += MINUTE;
      update({
        slowData: slow({ reputation: 18_750, ownedAugs, queued: [NFG] }),
        mediumData: medium({ money: 1e9, homeRam: 2 ** 20 }),
      });
    }
    expect(rule.notQueued()).toEqual([]);
    const next = update({
      slowData: slow({ reputation: 18_750, ownedAugs, queued: [NFG] }),
      mediumData: medium({ money: 1e9, homeRam: 2 ** 20 }),
    });
    expect(next.intent).toEqual(purchaseIntent("CyberSec", NFG, 4));
  });

  test("bought from the joined seller with the most reputation: BitWire at NiteSec (18,750), not CyberSec (10,000)", () => {
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const joined = [
      { name: "CyberSec", reputation: 10_000, favor: 0 },
      { name: "NiteSec", reputation: 18_750, favor: 0 },
    ];
    // $10m covers BitWire alone, the most hacking value at hacking 300.
    const ask = update({ slowData: slow({ joined }), mediumData: medium({ money: 10e6 }) });
    expect(ask.intent).toEqual(purchaseIntent("NiteSec", "BitWire", 1));
  });

  test("committed, then the reset with no medium snapshot yet: nothing held back from cloud servers", () => {
    committed();
    expect(rule.reserve()).toBe(Number.POSITIVE_INFINITY);
    gameTimeMs += MINUTE;
    update({ mediumData: null, slowData: slow({ lastAugReset: 9 * HOUR }) });
    expect(rule.reserve()).toBe(0);
  });

  test("the game reset (another lastAugReset): the cycle over, the note gone, the purchases forgotten", () => {
    committed();
    gameTimeMs += MINUTE;
    update({
      slowData: slow({ lastAugReset: 9 * HOUR, ownedAugs: { BitWire: 1 } }),
      mediumData: medium({ hacking: 1 }),
    });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(lines.at(-1)).toBe("augmentations: the game has reset (installed): the install cycle is over");
    // The next Agent's medium snapshot not in yet: nothing held back from cloud servers (#213 review).
    update({ mediumData: null, slowData: slow({ lastAugReset: 9 * HOUR }) });
    expect(rule.reserve()).toBe(0);
  });

  test("a restarted brain with the install asked for buys nothing more (#213 review)", () => {
    committed();
    const queue = [...FIVE];
    const install = update({ slowData: slow({ reputation: 18_750, queued: queue }), mediumData: medium({ money: 0 }) });
    expect(install.install).toBe(true);
    expect(readAugmentationCycle(store)).toEqual({
      lastAugReset: 0,
      installing: true,
      neuroFluxTarget: 4,
      donations: [],
      reason: "nothing left",
      countFacts: { moneyAfterSet: expect.any(Number), within: [] },
    });
    rule = newRule();
    // $1b now covers NeuroFlux Governor, but the install is out.
    const after = update({ slowData: slow({ reputation: 18_750, queued: queue }), mediumData: medium({ money: 1e9 }) });
    expect(after).toEqual({ intent: null, install: true, committed: true });
  });

  test("a restarted brain carries the commit on, and ends it on a reset it missed", () => {
    committed();
    rule = newRule();
    expect(update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) }).intent).toEqual(
      purchaseIntent("CyberSec", GEN_I, 1),
    );
    rule = newRule();
    update({ slowData: slow({ lastAugReset: 9 * HOUR }) });
    expect(readAugmentationCycle(store)).toBeNull();
  });

  test("the switch off: nothing asked for, the cycle called off, stored and logged; no reserve", () => {
    committed();
    expect(update({ enabled: false })).toEqual({ intent: null, install: false, committed: false });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(events.at(-1)).toEqual({
      type: "augmentationCycleCalledOff",
      atMs: 1_000,
      reason: "the Augmentations switch turned off",
    });
    expect(rule.view()).toMatchObject({ enabled: false, committed: false });
    expect(rule.reserve()).toBe(0);
    // Off, nothing is chosen.
    expect(
      update({ enabled: false, slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) }).committed,
    ).toBe(false);
  });

  test("nothing bought to install: the cycle called off", () => {
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    expect(update({ slowData: slow({ reputation: 0 }), mediumData: medium({ money: 0 }) })).toEqual({
      intent: null,
      install: false,
      committed: false,
    });
    expect(events.at(-1)).toMatchObject({
      type: "augmentationCycleCalledOff",
      reason: NOTHING_QUEUED,
    });
  });

  test("at a bar of 1, a purchase never queued isn't counted: no install chosen on it, ever (#222 review)", () => {
    // 22 h online (both bars 1), committed with $70m: Gen I reported bought, two reads don't show it, $0 left. Its
    // phantom is the plan's queue (never asked for again), not what an install would install: 0 affordable.
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: 22 * HOUR, lastGameTimeMs: gameTimeMs }),
    );
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    rule = newRule();
    const fields = { reputation: 18_750 };
    const ask = update({ slowData: slow(fields), mediumData: medium({ money: 70e6 }) });
    update({
      slowData: slow(fields),
      mediumData: medium({ money: 70e6 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    for (let read = 0; read < 2; read += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slow(fields), mediumData: medium({ money: 0, homeRam: 2 ** 20 }) });
    }
    expect(rule.notQueued()).toHaveLength(1);
    expect(readAugmentationCycle(store)).toBeNull();
    for (let again = 0; again < 4; again += 1) {
      gameTimeMs += 90_000;
      expect(update({ slowData: slow(fields), mediumData: medium({ money: 0, homeRam: 2 ** 20 }) }).committed).toBe(
        false,
      );
    }
    expect(rule.view().progress).toMatchObject({
      bar: 1,
      barWithNeuroFlux: 1,
      affordable: 0,
      reason: null,
      countdown: null,
    });
    expect(events.filter((event) => event.type === "augmentationInstallChosen")).toEqual([]);
    expect(lines.filter((line) => line.includes("countdown started"))).toEqual([]);
  });

  test("every purchase a false done: no install of nothing, called off, and none chosen again (#213 re-review)", () => {
    // Committed with $70m: a purchase reported done, and two reads since that don't show it queued, $0 left.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const fields = { reputation: 18_750 };
    const ask = update({ slowData: slow(fields), mediumData: medium({ money: 70e6 }) });
    expect(ask.intent?.action).toBe("purchaseAugmentation");
    update({
      slowData: slow(fields),
      mediumData: medium({ money: 70e6 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    for (let read = 0; read < 2; read += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slow(fields), mediumData: medium({ money: 0, homeRam: 2 ** 20 }) });
    }
    expect(rule.notQueued()).toHaveLength(1);
    expect(events.filter((event) => event.type === "augmentationCycleCalledOff")).toEqual([
      expect.objectContaining({ reason: NOTHING_QUEUED }),
    ]);
    // Never the install; and with nothing really queued, no install chosen again, update after update.
    for (let again = 0; again < 3; again += 1) {
      expect(update({ slowData: slow(fields), mediumData: medium({ money: 0, homeRam: 2 ** 20 }) })).toEqual({
        intent: null,
        install: false,
        committed: false,
      });
    }
    expect(events.filter((event) => event.type === "augmentationInstallChosen")).toHaveLength(0);
  });

  test("a restarted brain with the install asked for checks the queue first: empty, called off (#213 re-review)", () => {
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0, installing: true }));
    rule = newRule();
    expect(update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 0 }) })).toEqual({
      intent: null,
      install: false,
      committed: false,
    });
    expect(events).toEqual([{ type: "augmentationCycleCalledOff", atMs: 1_000, reason: NOTHING_QUEUED }]);
  });

  test("an install reported done that the next slow snapshot doesn't show reset: called off, alerted (#213 re-review)", () => {
    committed();
    const fields = { reputation: 18_750, queued: [...FIVE] };
    expect(update({ slowData: slow(fields), mediumData: medium({ money: 0 }) }).install).toBe(true);
    const done = new Set([AUGMENTATION_INSTALL_INTENT.id]);
    expect(rule.askedDone(done)).toBe(true);
    // Reported done: the next slow snapshot should show the reset. This one is the same snapshot again.
    expect(update({ slowData: slow(fields), mediumData: medium({ money: 0 }), doneIds: done }).install).toBe(true);
    expect(lines.at(-1)).toBe("augmentations: the install reported done: the next slow snapshot should show the reset");
    expect(rule.installNotReset()).toBeNull();
    // An update with that slow snapshot still the latest: not judged yet.
    expect(update({ slowData: slow(fields), mediumData: medium({ money: 0 }), doneIds: done }).install).toBe(true);
    expect(rule.installNotReset()).toBeNull();
    // The next, with no reset: the cycle called off, the event, the alert's.
    gameTimeMs += MINUTE;
    const after = update({ slowData: slow(fields), mediumData: medium({ money: 0 }), doneIds: done, nowMs: 61_000 });
    expect(after).toEqual({ intent: null, install: false, committed: false });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.installNotReset()).toEqual({ atMs: 61_000, queued: FIVE });
    expect(events.slice(-2)).toEqual([
      { type: "augmentationInstallNotReset", atMs: 61_000, queued: FIVE },
      {
        type: "augmentationCycleCalledOff",
        atMs: 61_000,
        reason: "the install was reported done but the game didn't reset",
      },
    ]);
    expect(lines.some((line) => line.includes("INSTALL REPORTED DONE BUT THE GAME DIDN'T RESET"))).toBe(true);
    // No install chosen again until a reset: the faction state's queue isn't the game's.
    gameTimeMs += MINUTE;
    expect(update({ slowData: slow(fields), mediumData: medium({ money: 1e9 }) }).committed).toBe(false);
    expect(rule.view().waitingFor).toMatch(/^a reset: an install was reported done but the game didn't reset/);
    gameTimeMs += MINUTE;
    update({ slowData: slow({ lastAugReset: 9 * HOUR }) });
    expect(rule.installNotReset()).toBeNull();
  });

  test("an install reported done, then the reset in the next slow snapshot: no failure", () => {
    committed();
    const fields = { reputation: 18_750, queued: [...FIVE] };
    update({ slowData: slow(fields), mediumData: medium({ money: 0 }) });
    const done = new Set([AUGMENTATION_INSTALL_INTENT.id]);
    update({ slowData: slow(fields), mediumData: medium({ money: 0 }), doneIds: done });
    gameTimeMs += MINUTE;
    update({ slowData: slow({ lastAugReset: 9 * HOUR, ownedAugs: { BitWire: 1 } }), doneIds: done });
    expect(rule.installNotReset()).toBeNull();
    expect(events.map((event) => event.type)).not.toContain("augmentationInstallNotReset");
    expect(events.map((event) => event.type)).not.toContain("augmentationCycleCalledOff");
  });
});

describe("The Red Pill and Daedalus first (#215)", () => {
  const RED_PILL = "The Red Pill";
  /** Thirty installed, none of CyberSec's: Daedalus's count in BN1. */
  const THIRTY = Object.fromEntries(
    AUGMENTATION_NAMES.filter((name) => ![...FIVE, NFG, RED_PILL].includes(name))
      .slice(0, 30)
      .map((name) => [name, 1]),
  );

  test("The Red Pill reached at a joined Daedalus: install chosen for it, whatever the income; bought last", () => {
    const joined = [{ name: "Daedalus", reputation: 2.5e6, favor: 0 }];
    const ask = update({ slowData: slow({ joined }), mediumData: medium({ money: 0 }) });
    expect(readAugmentationCycle(store)).toEqual({
      lastAugReset: 0,
      installing: false,
      neuroFluxTarget: 0,
      donations: [],
      reason: "The Red Pill",
    });
    expect(events).toEqual([expect.objectContaining({ type: "augmentationInstallChosen", reason: "The Red Pill" })]);
    expect(lines.at(-1)).toMatch(/The Red Pill reached: it links w0r1d_d43m0n once installed$/);
    // Nothing else the money covers: The Red Pill, from Daedalus, then the install once it shows queued.
    expect(ask.intent).toEqual(purchaseIntent("Daedalus", RED_PILL, 1));
    expect(rule.view().asking).toBe("buying The Red Pill from Daedalus");
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: 0 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    gameTimeMs += MINUTE;
    expect(update({ slowData: slow({ joined, queued: [RED_PILL] }), mediumData: medium({ money: 0 }) })).toEqual({
      intent: null,
      install: true,
      committed: true,
    });
  });

  test("bought after the set, home's RAM and NeuroFlux Governor: the others first, as each purchase dearens the next", () => {
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation: 2.5e6, favor: 0 },
    ];
    // $70m: one of CyberSec's; then NeuroFlux Governor isn't covered, so The Red Pill.
    const first = update({ slowData: slow({ joined }), mediumData: medium({ money: 70e6 }) });
    expect(first.intent?.args).toMatchObject({ faction: expect.any(String) });
    expect(first.intent?.args).not.toMatchObject({ augmentation: RED_PILL });
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: 70e6 }),
      doneIds: new Set([first.intent?.id as string]),
    });
    const next = update({ slowData: slow({ joined }), mediumData: medium({ money: 0 }), nowMs: 5_000 });
    expect(next.intent).toEqual(purchaseIntent("Daedalus", RED_PILL, 1));
  });

  test("queued already (the owner's, say): the install is chosen for it", () => {
    update({ slowData: slow({ queued: [RED_PILL] }), mediumData: medium({ money: 0 }) });
    expect(events).toEqual([expect.objectContaining({ type: "augmentationInstallChosen", reason: "The Red Pill" })]);
  });

  test("Daedalus joined, The Red Pill short: no install or countdown, though the count is reached; nothing held back", () => {
    // Eight reached and covered, with Daedalus joined at 100k: short of what unlocks its donations too (#225).
    const joined = [...EIGHT_JOINED, { name: "Daedalus", reputation: 100_000, favor: 0 }];
    const why = "The Red Pill: Daedalus's reputation 100,000 of 2,500,000 (an install now would lose it)";
    measureIncome(10_000, { joined }, medium({ money: EIGHT_COST + SLACK }));
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view()).toMatchObject({ waitingFor: why, reserve: 0, progress: { countdown: null, held: why } });
    expect(rule.view().progress?.reason).not.toBeNull();
    // One progress event, held: the reputation's figure in its words changes nothing recorded.
    gameTimeMs += MINUTE;
    const more = [...EIGHT_JOINED, { name: "Daedalus", reputation: 120_000, favor: 0 }];
    update({ slowData: slow({ joined: more }), mediumData: medium({ money: EIGHT_COST + SLACK }) });
    expect(rule.view().progress?.held).toMatch(/^The Red Pill: Daedalus's reputation 120,000 of /);
    expect(events.map((event) => event.type)).toEqual(["augmentationProgress"]);
    expect(lines).toEqual([`augmentations: no install, waiting for ${why}`]);
  });

  test("Daedalus's count and hacking reached, the money short: no install, its $100b held back from cloud servers", () => {
    const fields = { reputation: 18_750, ownedAugs: THIRTY };
    update({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 50e9 }) });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view()).toMatchObject({
      waitingFor:
        "Daedalus's invitation ($50,000,000,000 of $100,000,000,000): an install now would reset the money and the " +
        "hacking level",
      reserve: 100e9,
    });
    expect(rule.reserve()).toBe(100e9);
    // Met: still none, until it invites and A5 joins.
    update({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 150e9 }) });
    expect(rule.view().waitingFor).toMatch(/^Daedalus's invitation \(the game's next check\)/);
    // Its hacking short, the money there, ordinary installs go on (they raise the multiplier): CyberSec's five.
    throughCountdown({ slowData: slow(fields), mediumData: medium({ hacking: 2000, money: 150e9 }) });
    // Short of the count: likewise.
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    rule = newRule();
    throughCountdown({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ hacking: 2600, money: 50e9 }) });
  });

  test("The Red Pill installed, the destroy wanted: no install, logged once; not wanted, ordinary installs go on", () => {
    const fields = { reputation: 18_750, ownedAugs: { ...THIRTY, [RED_PILL]: 1 } };
    const why =
      "the BitNode's destroy: The Red Pill is installed, and an install would reset the hacking level w0r1d_d43m0n " +
      "needs (the destroy switched on)";
    for (let again = 0; again < 2; again += 1) {
      update({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 50e9 }), destroyWanted: true });
    }
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view()).toMatchObject({ waitingFor: why, reserve: 0 });
    expect(lines).toEqual([`augmentations: no install, waiting for ${why}`]);
    throughCountdown({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 50e9 }) });
  });

  test("The Red Pill bought, never queued: the cycle called off, no install without it, none chosen again (R2)", () => {
    const joined = [{ name: "Daedalus", reputation: 2.5e6, favor: 0 }];
    const ask = update({ slowData: slow({ joined }), mediumData: medium({ money: 0 }) });
    expect(ask.intent).toEqual(purchaseIntent("Daedalus", RED_PILL, 1));
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: 0 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    for (let read = 0; read < 2; read += 1) {
      gameTimeMs += MINUTE;
      expect(update({ slowData: slow({ joined }), mediumData: medium({ money: 0 }) }).install).toBe(false);
    }
    expect(rule.notQueued()).toEqual([expect.objectContaining({ augmentation: RED_PILL })]);
    expect(events.map((event) => event.type)).toEqual([
      "augmentationInstallChosen",
      "augmentationBought",
      "augmentationNotQueued",
      "augmentationCycleCalledOff",
    ]);
    expect(events.at(-1)).toMatchObject({
      reason: "The Red Pill reported bought but never queued: no install without it",
    });
    for (let again = 0; again < 3; again += 1) {
      gameTimeMs += MINUTE;
      expect(update({ slowData: slow({ joined }), mediumData: medium({ money: 0 }) })).toEqual({
        intent: null,
        install: false,
        committed: false,
      });
    }
    // Held from then on: one progress event saying so, and nothing else.
    expect(events.slice(4).map((event) => event.type)).toEqual(["augmentationProgress"]);
    expect(events.at(-1)).toMatchObject({ held: expect.stringMatching(/^The Red Pill reported bought but not in /) });
    expect(rule.view().waitingFor).toMatch(/^The Red Pill reported bought but not in the faction state's queue/);
  });

  test("committed for Daedalus's way, The Red Pill not bought: no install of the rest", () => {
    // Committed (an ordinary cycle, say), Daedalus joined short of The Red Pill: the five, then no install.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation: 1e6, favor: 0 },
    ];
    const ask = update({ slowData: slow({ joined, queued: [...FIVE] }), mediumData: medium({ money: 0 }) });
    expect(ask).toEqual({ intent: null, install: false, committed: true });
    expect(rule.view().waitingFor).toBe("The Red Pill bought and shown queued, before the install");
  });

  test("BN15: Daedalus doesn't sell The Red Pill (a labyrinth's reward), so no hold for its invitation", () => {
    update({
      slowData: slow({ reputation: 18_750, ownedAugs: THIRTY, currentNode: 15 }),
      mediumData: medium({ hacking: 2600, money: 150e9 }),
    });
    expect(rule.daedalusHold()).toBe(0);
    expect(rule.view().waitingFor ?? "").not.toMatch(/^Daedalus's invitation/);
  });

  test("Daedalus's hold is home RAM's too: $100b while it holds, 0 otherwise", () => {
    const fields = { reputation: 18_750, ownedAugs: THIRTY };
    update({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 150e9 }) });
    expect(rule.daedalusHold()).toBe(100e9);
    update({ slowData: slow(fields), mediumData: medium({ hacking: 2600, money: 150e9 }), enabled: false });
    expect(rule.daedalusHold()).toBe(0);
    update({ slowData: slow(fields), mediumData: medium({ hacking: 2000, money: 150e9 }) });
    expect(rule.daedalusHold()).toBe(0);
  });
});

describe("the gang's faction's shop (#334, G5)", () => {
  const RED_PILL = "The Red Pill";
  /** BN2, CyberSec joined (the gang's faction NiteSec left out, as the controller's `withoutGangFaction` has it). */
  const bn2 = (fields: Parameters<typeof slow>[0] = {}) =>
    slow({ joined: [{ name: "CyberSec", reputation: 18_750, favor: 0 }], currentNode: 2, ...fields });
  const gang = (reputation: number) => ({ gangShop: { name: "NiteSec", reputation, favor: 0 } });
  /**
   * G5's hold and the count rule there are the rules' since #357's (3) (the A/B's baseline, `bn2Route` "rules"): these
   * tests work them. The planner's are "BN2 with the gang" below; The Red Pill reached is the same for both.
   */
  const rulesRoute = () =>
    new AugmentationRule({
      store,
      log: (line) => lines.push(line),
      emit: (event) => events.push(event),
      installTiming: "count rule",
      bn2Route: "rules",
    });
  beforeEach(() => {
    rule = rulesRoute();
  });

  test("The Red Pill reached there: the install chosen for it, the set bought there and The Red Pill last", () => {
    // $1b: what the money covers, CyberSec's and the gang's faction's; NiteSec has the most reputation for each.
    const ask = update({ slowData: bn2(), mediumData: medium({ money: 1e9 }), ...gang(2.5e6) });
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "The Red Pill" });
    expect(ask.intent?.action).toBe("purchaseAugmentation");
    expect(ask.intent?.args).toMatchObject({ faction: "NiteSec" });
    const set = rule.view().set.map((each) => each.augmentation);
    expect(set.length).toBeGreaterThan(1);
    // Some only the gang's faction sells of the two (Augmented Targeting I, say: not CyberSec's, not NiteSec's own).
    expect(set.some((name) => !augmentationsSoldBy("CyberSec", 2, null).includes(name))).toBe(true);
    expect(set.some((name) => !augmentationsSoldBy("NiteSec", 2, null).includes(name))).toBe(true);
    // With no money, The Red Pill alone ($0), from the gang's faction, then the install once it shows queued.
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    rule = rulesRoute();
    const redPill = update({ slowData: bn2(), mediumData: medium({ money: 0 }), ...gang(2.5e6) });
    expect(redPill.intent).toEqual(purchaseIntent("NiteSec", RED_PILL, 1));
    expect(rule.view().asking).toBe("buying The Red Pill from NiteSec");
    update({
      slowData: bn2(),
      mediumData: medium({ money: 0 }),
      doneIds: new Set([redPill.intent?.id as string]),
      ...gang(2.5e6),
    });
    gameTimeMs += MINUTE;
    expect(update({ slowData: bn2({ queued: [RED_PILL] }), mediumData: medium({ money: 0 }), ...gang(0) })).toEqual({
      intent: null,
      install: true,
      committed: true,
    });
  });

  test("short there: held while it comes within 20 minutes at the cycle's rate, not beyond; never a money hold", () => {
    // 7 h since the install (the game's time), 2.4m of 2.5m: the rest in 17.5 min at the cycle's rate. Held.
    const why =
      "The Red Pill: NiteSec's reputation 2,400,000 of 2,500,000, about 18 min more at the cycle's rate (the gang's " +
      "faction; held 0 s of at most 20 min) (an install now would lose it)";
    update({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...gang(2.4e6) });
    expect(rule.view()).toMatchObject({ waitingFor: why, reserve: 0, progress: { countdown: null, held: why } });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(lines).toEqual([`augmentations: no install, waiting for ${why}`]);
    // 2m: the rest in 1.75 h, beyond the window: not held, the count rule's turn (its countdown under way).
    update({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...gang(2e6) });
    expect(rule.view().waitingFor ?? "").not.toContain(RED_PILL);
    expect(rule.view().progress?.held).toBeNull();
    expect(rule.view().progress?.countdown).not.toBeNull();
    // Daedalus's invitation met but its money (thirty installed, hacking 2,600): no $100b held, the gang's faction
    // sells The Red Pill.
    const thirty = Object.fromEntries(
      AUGMENTATION_NAMES.filter((name) => ![...FIVE, NFG, RED_PILL].includes(name))
        .slice(0, 30)
        .map((name) => [name, 1]),
    );
    update({ slowData: bn2({ ownedAugs: thirty }), mediumData: medium({ hacking: 2600, money: 50e9 }), ...gang(2e6) });
    expect(rule.daedalusHold()).toBe(0);
    // Without the gang, as before: held for Daedalus's money.
    update({ slowData: bn2({ ownedAugs: thirty }), mediumData: medium({ hacking: 2600, money: 50e9 }) });
    expect(rule.daedalusHold()).toBe(100e9);
  });

  test("the hold there (#335's review): from its first start, 20 minutes online at most, never restarted in the cycle", () => {
    // 2.4m and flat: at 7 h and on, the rest always within 20 minutes at the cycle's rate, so an estimate alone holds.
    const at = (lastAugReset = 0) =>
      update({ slowData: bn2({ lastAugReset }), mediumData: medium({ money: 1e12 }), ...gang(2.4e6) });
    const heldNow = () => (rule.view().progress?.held ?? "").startsWith("The Red Pill: NiteSec's reputation");
    at();
    expect(heldNow()).toBe(true);
    for (let minute = 1; minute < 20; minute += 1) {
      gameTimeMs += MINUTE;
      at();
      expect(heldNow(), `minute ${minute}`).toBe(true);
    }
    expect(rule.view().progress?.held).toContain("held 19 min of at most 20 min");
    gameTimeMs += MINUTE;
    at();
    expect(heldNow()).toBe(false);
    // Never restarted in the cycle, a restarted brain's too (the store keeps its start).
    rule = rulesRoute();
    for (let minute = 1; minute <= 5; minute += 1) {
      gameTimeMs += MINUTE;
      at();
      expect(heldNow(), `minute ${20 + minute}`).toBe(false);
    }
    // The next cycle's hold starts afresh, from its own start: held to its minute 19, not at 20.
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    rule = rulesRoute();
    const next = gameTimeMs - 7 * HOUR;
    at(next);
    expect(heldNow()).toBe(true);
    for (let minute = 1; minute <= 20; minute += 1) {
      gameTimeMs += MINUTE;
      at(next);
      expect(heldNow(), `the next cycle's minute ${minute}`).toBe(minute < 20);
    }
  });

  test("the hold's start as stored (#335's re-review): one the brain didn't write fails, as the count hold's does", () => {
    store.setSetting("augmentations.gangRedPillHold", "not json");
    expect(() => readGangRedPillHold(store)).toThrow("isn't JSON");
    store.setSetting("augmentations.gangRedPillHold", JSON.stringify({ lastAugReset: 0 }));
    expect(() => readGangRedPillHold(store)).toThrow("isn't a hold the brain wrote");
    store.setSetting("augmentations.gangRedPillHold", JSON.stringify({ lastAugReset: 0, sinceOnlineMs: 60_000 }));
    expect(readGangRedPillHold(store)).toEqual({ lastAugReset: 0, sinceOnlineMs: 60_000 });
  });

  test("the hold's start is the cycle's (#335's review): one stored for an earlier cycle starts none here", () => {
    // An earlier cycle's hold, started 5 minutes into it, kept in the store.
    store.setSetting("augmentations.gangRedPillHold", JSON.stringify({ lastAugReset: -1, sinceOnlineMs: 5 * MINUTE }));
    const at = () => update({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...gang(2.4e6) });
    const heldNow = () => (rule.view().progress?.held ?? "").startsWith("The Red Pill: NiteSec's reputation");
    at();
    for (let minute = 1; minute <= 22; minute += 1) {
      gameTimeMs += MINUTE;
      at();
      expect(heldNow(), `minute ${minute}`).toBe(minute < 20);
    }
  });

  test("Daedalus's count doesn't count with The Red Pill there (#335's review): only what's worth hacking is bought", () => {
    // Nothing installed, Daedalus nowhere: short of its count without a gang, so any augmentation would count.
    const set = (withGang: boolean) => {
      store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
      rule = rulesRoute();
      update({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...(withGang ? gang(2e6) : {}) });
      return rule.view().set.map((each) => each.augmentation);
    };
    const theirs = set(true);
    expect(theirs.length).toBeGreaterThan(0);
    expect(
      theirs.every((name) => isWorthInstalling(name, false)),
      theirs.join(", "),
    ).toBe(true);
    expect(rule.view().progress?.short).toBeNull();
    // And Daedalus joined, short of The Red Pill's reputation: no hold for it (the gang's faction is the route).
    update({
      slowData: bn2({
        joined: [
          { name: "CyberSec", reputation: 18_750, favor: 0 },
          { name: "Daedalus", reputation: 1_000, favor: 0 },
        ],
      }),
      mediumData: medium({ money: 1e12 }),
      ...gang(1e6),
    });
    expect(rule.view().waitingFor ?? "").not.toContain("Daedalus's reputation");
  });

  test("committed for an ordinary install, The Red Pill short there: the install goes ahead; for its own, it waits", () => {
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0 }));
    const ordinary = update({ slowData: bn2({ queued: [...FIVE] }), mediumData: medium({ money: 0 }), ...gang(1e6) });
    expect(ordinary).toEqual({ intent: null, install: true, committed: true });
    // A cycle committed for The Red Pill that no seller's reputation reaches now (a stale reading's, as forming a gang
    // resets its faction's to 0): called off, never an install without it, and judged afresh.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0, reason: "The Red Pill" }));
    rule = rulesRoute();
    lines.length = 0;
    const forIt = update({ slowData: bn2({ queued: [...FIVE] }), mediumData: medium({ money: 0 }), ...gang(1e6) });
    expect(forIt).toEqual({ intent: null, install: false, committed: false });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(lines).toContain(
      "augmentations: the install cycle is called off: The Red Pill's reputation short at every seller now: no " +
        "install without it",
    );
    // A brain restarted in BN2 before the gang's first reading (#335's review): no seller seen yet, but no call-off.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0, reason: "The Red Pill" }));
    rule = rulesRoute();
    const unread = update({ slowData: bn2({ queued: [...FIVE] }), mediumData: medium({ money: 0 }), gangUnread: true });
    expect(unread).toEqual({ intent: null, install: false, committed: true });
    expect(rule.view().waitingFor).toBe("the gang's first reading, for The Red Pill's seller, before the install");
    expect(readAugmentationCycle(store)).not.toBeNull();
    // Reached there, the same cycle buys it.
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: 0, reason: "The Red Pill" }));
    rule = rulesRoute();
    const reached = update({ slowData: bn2({ queued: [...FIVE] }), mediumData: medium({ money: 0 }), ...gang(2.5e6) });
    expect(reached.intent).toEqual(purchaseIntent("NiteSec", RED_PILL, 1));
  });
});

describe("donations (#225)", () => {
  /** CyberSec at 5,000 with its donations unlocked: Gen I and Gen II by one donation, to Gen II's 18,750. */
  const UNLOCKED = [{ name: "CyberSec", reputation: 5_000, favor: 150 }];
  const DONATION = 13_750_010_000;
  const donateIntent = (faction: string, amount: number, reputation: number) => ({
    id: `donateToFaction(${faction}, ${amount}, ${reputation})`,
    action: "donateToFaction",
    args: { faction, amount, reputation },
  });
  const atReputation = (reputation: number, favor = 150) => [{ name: "CyberSec", reputation, favor }];

  test("counted when the money covers the prices and the donation; the reserve holds both; the note records it", () => {
    const mediumData = medium({ money: FIVE_COST + DONATION + SLACK });
    update({ slowData: slow({ joined: UNLOCKED }), mediumData });
    expect(rule.view().progress).toMatchObject({ affordable: 5, byDonation: 2, reason: "nothing left" });
    expect(rule.view().donations).toEqual([{ faction: "CyberSec", reputation: 18_750, amount: DONATION }]);
    expect(rule.view().reserve).toBeCloseTo(FIVE_COST + DONATION, 0);
    expect(describeProgress(rule.view().progress as never)).toMatch(
      /^5 of 8 new augmentations affordable \(5 of 12 with NeuroFlux; 2 of them by donation\)/,
    );
    // The money for the five's prices alone: Gen II and Gen I, which need the donation, left out.
    rule = newRule();
    update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money: FIVE_COST }) });
    expect(rule.view().progress).toMatchObject({ byDonation: 0 });
    expect(rule.view().donations).toEqual([]);
    // Not unlocked (favour 149): none by donation.
    rule = newRule();
    update({ slowData: slow({ joined: atReputation(5_000, 149) }), mediumData });
    expect(rule.view().progress).toMatchObject({ affordable: 3, byDonation: 0 });
    // Committed (after the countdown), the note and the event carry the donation.
    rule = newRule();
    gameTimeMs += MINUTE;
    throughCountdown({ slowData: slow({ joined: UNLOCKED }), mediumData });
    expect(readAugmentationCycle(store)?.donations).toEqual([
      { faction: "CyberSec", reputation: 18_750, amount: DONATION },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "augmentationInstallChosen",
      donations: [{ faction: "CyberSec", reputation: 18_750, amount: DONATION }],
    });
    expect(lines.at(-1)).toMatch(/donating \$13,750,010,000 to CyberSec \(for 18,750 reputation\) first, /);
  });

  test("a change in the count by donation alone is recorded, as the counts' are (at most every 5 minutes)", () => {
    const nitesec = { name: "NiteSec", reputation: 0, favor: 0 };
    update({
      slowData: slow({ joined: [...UNLOCKED, nitesec] }),
      mediumData: medium({ money: FIVE_COST + DONATION + SLACK }),
    });
    // CyberSec worked up to Gen II meanwhile: the same five, none by donation.
    gameTimeMs += MINUTE;
    update({
      slowData: slow({ joined: [...atReputation(18_750), nitesec] }),
      mediumData: medium({ money: FIVE_COST + SLACK }),
      nowMs: 1_000 + AUGMENTATION_PROGRESS_COUNTS_EVERY_MS,
    });
    expect(
      progressEvents().map((event) => [event.affordable, event.affordableWithNeuroFlux, event.byDonation]),
    ).toEqual([
      [5, 5, 2],
      [5, 5, 0],
    ]);
  });

  test("committed: the donation first, then nothing bought until the faction state shows it; then the set in buy order", () => {
    const money = FIVE_COST + DONATION + SLACK;
    throughCountdown({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    const ask = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money, homeRam: 128 }) });
    // Before Gen I, and before home's RAM, which the money would cover.
    expect(ask.intent).toEqual(donateIntent("CyberSec", DONATION, 18_750));
    expect(rule.view().asking).toBe("donating $13,750,010,000 to CyberSec (for 18,750 reputation)");
    update({
      slowData: slow({ joined: UNLOCKED }),
      mediumData: medium({ money, homeRam: 128 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    // Reported done, the faction state not showing it yet: nothing more.
    const waiting = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money, homeRam: 128 }) });
    expect(waiting.intent).toBeNull();
    expect(rule.view().waitingFor).toBe("the faction state to show CyberSec's reputation after the donation");
    // A read showing it: the donation's event, then Gen I.
    gameTimeMs += MINUTE;
    const next = update({
      slowData: slow({ joined: atReputation(18_750.01) }),
      mediumData: medium({ money: FIVE_COST + SLACK, homeRam: 128 }),
    });
    expect(events.filter((event) => event.type === "augmentationDonated")).toEqual([
      {
        type: "augmentationDonated",
        atMs: 1_000,
        faction: "CyberSec",
        amount: DONATION,
        reputation: 18_750,
        before: 5_000,
        after: 18_750.01,
      },
    ]);
    expect(next.intent).toEqual(purchaseIntent("CyberSec", GEN_I, 1));
    expect(lines).toContainEqual(
      "augmentations: donated $13,750,010,000 to CyberSec (for 18,750 reputation): its reputation 5,000 → 18,750",
    );
  });

  test("a donation the faction state never shows: augmentationDonationFailed, alerted, the cycle called off", () => {
    const money = FIVE_COST + DONATION + SLACK;
    throughCountdown({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    const ask = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    update({
      slowData: slow({ joined: UNLOCKED }),
      mediumData: medium({ money }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    // One read missing it: not yet.
    gameTimeMs += MINUTE;
    update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    expect(rule.donationsFailed()).toEqual([]);
    // A skipped reading isn't a read.
    gameTimeMs += MINUTE;
    update({ slowData: slow({ joined: UNLOCKED, reading: "skipped" }), mediumData: medium({ money }) });
    expect(rule.donationsFailed()).toEqual([]);
    gameTimeMs += MINUTE;
    update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    expect(rule.donationsFailed()).toEqual([
      { faction: "CyberSec", amount: DONATION, reputation: 18_750, donatedAtMs: 1_000 },
    ]);
    expect(events.find((event) => event.type === "augmentationDonationFailed")).toMatchObject({
      faction: "CyberSec",
      shown: 5_000,
    });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(lines).toContainEqual(
      "augmentations: the install cycle is called off: the donation to CyberSec didn't show in its reputation",
    );
    expect(lines.some((line) => line.startsWith("augmentations: DONATION FAILED: $13,750,010,000 to CyberSec"))).toBe(
      true,
    );
  });

  test("a note's donation the money no longer covers: passed over, said, and the reached ones bought", () => {
    throughCountdown({
      slowData: slow({ joined: UNLOCKED }),
      mediumData: medium({ money: FIVE_COST + DONATION + SLACK }),
    });
    // The owner spent it meanwhile, with no donation in flight (a restarted brain asked for none): $200m left.
    rule = newRule();
    const ask = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money: 200e6 }) });
    expect(ask.intent?.action).toBe("purchaseAugmentation");
    expect(lines).toContainEqual(
      "augmentations: the donation $13,750,010,000 to CyberSec (for 18,750 reputation) passed over: $200,000,000 " +
        "now; what it was for isn't bought",
    );
  });

  test("a counted donation in flight, its money already spent, isn't passed over (#227 re-review): asked again", () => {
    const asked = throughCountdown({
      slowData: slow({ joined: UNLOCKED }),
      mediumData: medium({ money: FIVE_COST + DONATION + SLACK }),
    });
    expect(asked.intent).toEqual(donateIntent("CyberSec", DONATION, 18_750));
    // The medium snapshot shows the money spent before the done comes: the same donation, nothing passed over.
    const again = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money: FIVE_COST + SLACK }) });
    expect(again.intent).toEqual(asked.intent);
    expect(lines.filter((line) => line.includes("passed over"))).toEqual([]);
  });

  test("Daedalus's favour (legacy autopilot.js:920-931): its reputation unlocking donations installs, after the countdown", () => {
    // CyberSec's five reached and covered; Daedalus at 462,491, what unlocks its donations at the next install.
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation: 462_491, favor: 0 },
    ];
    const mediumData = medium({ money: FIVE_COST + SLACK });
    update({ slowData: slow({ joined }), mediumData });
    expect(rule.view().progress).toMatchObject({ reason: "Daedalus donations", held: null });
    expect(rule.view().progress?.countdown).toMatchObject({ quick: false });
    gameTimeMs += 90_000;
    update({ slowData: slow({ joined }), mediumData });
    expect(events.at(-1)).toMatchObject({ type: "augmentationInstallChosen", reason: "Daedalus donations" });
    expect(lines.at(-1)).toMatch(
      /Daedalus donations: its reputation this cycle unlocks its donations at the next install/,
    );
    expect(describeReason("Daedalus donations", {})).toMatch(/^Daedalus donations: /);
  });

  test("Daedalus's favour: its preconditions, each needed", () => {
    const money = FIVE_COST + SLACK;
    const daedalusAt = (reputation: number, favor = 0) => [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation, favor },
    ];
    // A reputation short of it: The Red Pill's hold, no install.
    update({ slowData: slow({ joined: daedalusAt(462_490) }), mediumData: medium({ money }) });
    expect(rule.view().progress?.held).toMatch(/^The Red Pill: Daedalus's reputation 462,490 of 2,500,000/);
    // Banked favour lowers it: 306,374 from 100.
    rule = newRule();
    update({ slowData: slow({ joined: daedalusAt(306_374, 100) }), mediumData: medium({ money }) });
    expect(rule.view().progress?.reason).toBe("Daedalus donations");
    // Not joined: Daedalus's hold for its invitation, or nothing (not its count).
    rule = newRule();
    update({ slowData: slow({ joined: daedalusAt(462_491).slice(0, 1) }), mediumData: medium({ money }) });
    expect(rule.view().progress?.reason).not.toBe("Daedalus donations");
    // The Red Pill reached: its own install, at once.
    rule = newRule();
    update({ slowData: slow({ joined: daedalusAt(2.5e6) }), mediumData: medium({ money }) });
    expect(events.at(-1)).toMatchObject({ type: "augmentationInstallChosen", reason: "The Red Pill" });
    // Nothing at all to install: no install, held, saying why.
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    rule = newRule();
    update({ slowData: slow({ joined: [{ name: "Daedalus", reputation: 500_000, favor: 0 }] }), mediumData: medium() });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view().progress?.held).toMatch(/^something affordable to install: Daedalus's reputation this cycle/);
    expect(rule.view().progress?.countdown).toBeNull();
  });

  test("Daedalus's donations unlocked: The Red Pill's reputation donated and bought once the money covers it", () => {
    const joined = [{ name: "Daedalus", reputation: 0, favor: 150 }];
    // $2.5t and $10k for the margin, at faction_rep 1.
    const amount = 2.5e12 + 10_000;
    update({ slowData: slow({ joined }), mediumData: medium({ money: amount - 1 }) });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view()).toMatchObject({
      waitingFor:
        "The Red Pill: the money for Daedalus's donation, $2,500,000,010,000 for its reputation " +
        "($2,500,000,009,999 now)",
      reserve: amount,
    });
    // Covered: the install chosen for it, the donation first.
    const chosen = update({ slowData: slow({ joined }), mediumData: medium({ money: amount }) });
    expect(events.at(-1)).toMatchObject({
      type: "augmentationInstallChosen",
      reason: "The Red Pill",
      donations: [{ faction: "Daedalus", reputation: 2.5e6, amount }],
    });
    expect(chosen.intent).toEqual(donateIntent("Daedalus", amount, 2.5e6));
  });

  test("Daedalus donations, driven to the install (#225 review): committed without The Red Pill, then install: true", () => {
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation: 462_491, favor: 0 },
    ];
    let money = FIVE_COST + SLACK;
    update({ slowData: slow({ joined }), mediumData: medium({ money }) });
    gameTimeMs += 90_000;
    let ask = update({ slowData: slow({ joined }), mediumData: medium({ money }) });
    expect(readAugmentationCycle(store)?.reason).toBe("Daedalus donations");
    const chosen = events.find((event) => event.type === "augmentationInstallChosen") as {
      set: { augmentation: string; price: number }[];
    };
    expect(chosen.set.length).toBeGreaterThan(0);
    const queue: string[] = [];
    for (const { augmentation, price } of chosen.set) {
      expect(ask.intent).toMatchObject({ action: "purchaseAugmentation", args: { augmentation } });
      update({
        slowData: slow({ joined, queued: [...queue] }),
        mediumData: medium({ money }),
        doneIds: new Set([ask.intent?.id as string]),
      });
      queue.push(augmentation);
      money -= price;
      gameTimeMs += MINUTE;
      ask = update({ slowData: slow({ joined, queued: [...queue] }), mediumData: medium({ money }) });
    }
    // The set bought; the money for nothing more.
    gameTimeMs += MINUTE;
    ask = update({ slowData: slow({ joined, queued: [...queue] }), mediumData: medium({ money: 0 }) });
    // Daedalus sells The Red Pill, unreached: #215's guard would hold for it, but this install is for the favour.
    expect(ask).toEqual({ intent: null, install: true, committed: true });
  });

  test("The Red Pill's donation first, the counts budgeted without its money, with another donor present (#225 review)", () => {
    // Daedalus and CyberSec both unlocked: $2.5t for The Red Pill, and $6b more.
    const joined = [
      { name: "Daedalus", reputation: 0, favor: 150 },
      { name: "CyberSec", reputation: 5_000, favor: 150 },
    ];
    const RED_PILL_DONATION = 2_500_000_010_000;
    const ask = update({ slowData: slow({ joined }), mediumData: medium({ money: RED_PILL_DONATION + 6e9 }) });
    const note = readAugmentationCycle(store);
    expect(note).toMatchObject({ reason: "The Red Pill", redPill: "Daedalus" });
    expect(note?.donations?.[0]).toEqual({ faction: "Daedalus", reputation: 2.5e6, amount: RED_PILL_DONATION });
    // The rest planned within the $6b left, after it: CyberSec's $5b for Gen I, not Daedalus's own augmentations'.
    const rest = (note?.donations ?? []).slice(1);
    expect(rest.map((each) => each.faction)).toEqual(["CyberSec"]);
    expect(rest.reduce((sum, each) => sum + each.amount, 0)).toBeLessThanOrEqual(6e9);
    expect(ask.intent).toEqual(donateIntent("Daedalus", RED_PILL_DONATION, 2.5e6));
    // In flight (#227 re-review): the medium snapshot shows its $2.5t spent before the done comes. No call-off: asked
    // again; then the done, recorded, and the reputation shown.
    const spent = update({ slowData: slow({ joined }), mediumData: medium({ money: 6e9 }) });
    expect(spent.intent).toEqual(ask.intent);
    expect(readAugmentationCycle(store)).not.toBeNull();
    update({
      slowData: slow({ joined }),
      mediumData: medium({ money: 6e9 }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    gameTimeMs += MINUTE;
    const shown = [{ ...joined[0], reputation: 2.5e6 + 0.01 }, joined[1]] as typeof joined;
    update({ slowData: slow({ joined: shown }), mediumData: medium({ money: 6e9 }) });
    expect(events.filter((event) => event.type === "augmentationCycleCalledOff")).toEqual([]);
    expect(events.filter((event) => event.type === "augmentationDonated")).toEqual([
      expect.objectContaining({ faction: "Daedalus", amount: RED_PILL_DONATION, before: 0 }),
    ]);
  });

  test("The Red Pill's donation never passed over: its money gone with none in flight, the cycle called off, held for it", () => {
    const joined = [{ name: "Daedalus", reputation: 0, favor: 150 }];
    const RED_PILL_DONATION = 2_500_000_010_000;
    update({ slowData: slow({ joined }), mediumData: medium({ money: RED_PILL_DONATION }) });
    expect(readAugmentationCycle(store)?.redPill).toBe("Daedalus");
    // A restarted brain (none in flight); the owner spent the money meanwhile.
    rule = newRule();
    const short = update({ slowData: slow({ joined }), mediumData: medium({ money: RED_PILL_DONATION - 1 }) });
    expect(short).toMatchObject({ intent: null, committed: false });
    expect(readAugmentationCycle(store)).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "augmentationCycleCalledOff",
      reason: expect.stringMatching(/^the money for The Red Pill's donation is gone: \$2,500,000,010,000 to Daedalus/),
    });
    update({ slowData: slow({ joined }), mediumData: medium({ money: RED_PILL_DONATION - 1 }) });
    expect(rule.redPillHold()).toBe(RED_PILL_DONATION);
    expect(rule.reserve()).toBe(RED_PILL_DONATION);
  });

  test("Daedalus's favour, legacy's 90% guard (#225 review): from 2,250,000 of 2.5m earned, no install, earned to the end", () => {
    const at = (reputation: number) => [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "Daedalus", reputation, favor: 0 },
    ];
    update({ slowData: slow({ joined: at(2_249_999) }), mediumData: medium({ money: FIVE_COST + SLACK }) });
    expect(rule.view().progress?.reason).toBe("Daedalus donations");
    rule = newRule();
    update({ slowData: slow({ joined: at(2_250_000) }), mediumData: medium({ money: FIVE_COST + SLACK }) });
    expect(rule.view().progress?.held).toMatch(/^The Red Pill: Daedalus's reputation 2,250,000 of 2,500,000/);
  });

  test("the lookahead's reserve counts the donations (#225 review): an install 15 minutes off by donation holds its money", () => {
    // CyberSec alone, unlocked at 5,000: with $0 now and 15 minutes of income, the five, two by donation, nothing left.
    measureIncome((FIVE_COST + DONATION + SLACK) / 900, { joined: UNLOCKED }, medium({ money: 0 }));
    expect(rule.view().progress?.countdown).toBeNull();
    expect(rule.reserve()).toBeCloseTo(FIVE_COST + DONATION, 0);
  });

  test("a donation shown in the faction state before its done is reported (#225 review): recorded once, then on", () => {
    const money = FIVE_COST + DONATION + SLACK;
    const ask = throughCountdown({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    expect(ask.intent).toEqual(donateIntent("CyberSec", DONATION, 18_750));
    // The faction state shows it; the medium snapshot doesn't yet, nor has the done come: Gen I next, on the money
    // left.
    gameTimeMs += MINUTE;
    const next = update({ slowData: slow({ joined: atReputation(18_750.01) }), mediumData: medium({ money }) });
    expect(next.intent).toEqual(purchaseIntent("CyberSec", GEN_I, 1));
    const donated = () => events.filter((event) => event.type === "augmentationDonated");
    expect(donated()).toEqual([expect.objectContaining({ faction: "CyberSec", amount: DONATION, after: 18_750.01 })]);
    // The done, reported late: nothing more.
    update({
      slowData: slow({ joined: atReputation(18_750.01) }),
      mediumData: medium({ money }),
      doneIds: new Set([ask.intent?.id as string]),
    });
    expect(donated()).toHaveLength(1);
  });

  test("the switch off: nothing donated, and a cycle under way called off", () => {
    const money = FIVE_COST + DONATION + SLACK;
    throughCountdown({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }) });
    const off = update({ slowData: slow({ joined: UNLOCKED }), mediumData: medium({ money }), enabled: false });
    expect(off.intent).toBeNull();
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view().donations).toEqual([]);
  });
});

describe("the store and the figures", () => {
  test("the switch is on unless turned off; a commit the brain didn't write fails", () => {
    expect(readAugmentationsEnabled(store)).toBe(true);
    store.setSetting(AUGMENTATION_CYCLE_SETTING, "{");
    expect(() => readAugmentationCycle(store)).toThrow("isn't JSON");
    store.setSetting(AUGMENTATION_CYCLE_SETTING, JSON.stringify({ lastAugReset: "x" }));
    expect(() => newRule()).toThrow("isn't a note the brain wrote");
  });

  test("the income counts the earnings only: not spending, nor `other`", () => {
    expect(earnedOf(slow({ earned: 5 }))).toBe(5);
    expect(
      earnedOf({
        ...slow(),
        moneySources: { hacking: 1, work: 2, crime: 3, hacknet: 4, codingcontract: 5, infiltration: 6, servers: -100 },
      }),
    ).toBe(21);
    expect(earnedOf({ ...slow(), moneySources: undefined })).toBeNull();
    expect(earnedOf({ ...slow(), moneySources: { hacking: Number.NaN } })).toBeNull();
  });

  test("the count rule in words: the bars' falls, and each reason (an earlier brain's as stored)", () => {
    const counts = { affordable: 1, affordableWithNeuroFlux: 4, bar: 1, barWithNeuroFlux: 5 };
    expect(
      describeProgress({ ...counts, onlineMs: 15 * HOUR, barFallsInMs: null, barWithNeuroFluxFallsInMs: HOUR }),
    ).toBe(
      "1 of 1 new augmentations affordable (4 of 5 with NeuroFlux), 15.0 h online this cycle; the bar is 1, and with " +
        "NeuroFlux falls to 4 in 1.0 h",
    );
    expect(
      describeProgress({
        ...counts,
        barWithNeuroFlux: 1,
        onlineMs: 30 * HOUR,
        barFallsInMs: null,
        barWithNeuroFluxFallsInMs: null,
      }),
    ).toBe("1 of 1 new augmentations affordable (4 of 1 with NeuroFlux), 30.0 h online this cycle; both bars are 1");
    expect(describeReason("count reached", counts)).toBe(
      "the count reached: 1 of 1 new augmentations affordable (4 of 5 with NeuroFlux)",
    );
    expect(describeReason("quick install", {})).toBe(
      "a quick install, within 20 min of the last install: the counts not stored",
    );
    expect(describeReason("sooner installing", {})).toBe("sooner installing");
  });

  test("ETAs in words", () => {
    expect([
      formatEta(45_000),
      formatEta(12 * MINUTE),
      formatEta(3.4 * HOUR),
      formatEta(null),
      formatEta(Infinity),
    ]).toEqual(["45 s", "12 min", "3.4 h", "never", "never"]);
  });
});

describe("short of Daedalus's count (#228)", () => {
  const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
  /** Run #2's 23 (2026-11-04): the four hacker factions' set with a hacking value, and NeuroFlux Governor. */
  const RUN_2: Record<string, number> = {
    ...Object.fromEntries(
      [...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))]
        .filter((name) => isWorthInstalling(name))
        .map((name) => [name, 1]),
    ),
    [NFG]: 124,
  };
  /** The four joined, Magnetism Amplifier (15,000) and Neural Wit Amplifier (5,000) reached. */
  const FOUR = HACKERS.map((name) => ({
    name,
    reputation: name === "The Black Hand" ? 15_000 : name === "BitRunners" ? 5_000 : 0,
    favor: 0,
  }));
  /** $250m, then $10m × 1.9: the two, dearest first. */
  const TWO_COST = 250e6 + 10e6 * 1.9;
  const runTwo = (fields: Parameters<typeof slow>[0] = {}) => slow({ joined: FOUR, ownedAugs: RUN_2, ...fields });

  test("only no-value augmentations reachable: both counted, nothing else left, so installed after the countdown", () => {
    const mediumData = medium({ hacking: 6_000, money: 1e9 });
    throughCountdown({ slowData: runTwo(), mediumData });
    const chosen = events.find((event) => event.type === "augmentationInstallChosen");
    expect(chosen).toMatchObject({ reason: "nothing left", affordable: 2, cost: TWO_COST });
    expect(rule.view().set.map((each) => each.augmentation)).toEqual(["Magnetism Amplifier", "Neural Wit Amplifier"]);
    const [progress] = progressEvents();
    expect(progress).toMatchObject({ affordable: 2, reason: "nothing left", short: { installed: 23, required: 30 } });
    expect(describeProgress(progress as Parameters<typeof describeProgress>[0])).toMatch(
      /; short of Daedalus's count \(23 of 30 augmentations installed\): any augmentation counts$/,
    );
  });

  test('a no-value one left to work for (Neural Wit Amplifier, BitRunners at 0): not "nothing left", no install', () => {
    const leftOne = FOUR.map((faction) => (faction.name === "BitRunners" ? { ...faction, reputation: 0 } : faction));
    update({
      slowData: slow({ joined: leftOne, ownedAugs: RUN_2 }),
      mediumData: medium({ hacking: 6_000, money: 1e9 }),
    });
    expect(rule.view().progress).toMatchObject({ affordable: 1, reason: null, countdown: null });
  });

  test("Daedalus inviting (the count met): the hacking-value rule, so nothing to buy or install", () => {
    const invited = {
      ...runTwo(),
      factions: {
        backend: "sim",
        state: { joined: FOUR, invitations: ["Daedalus"], queuedAugmentations: [] },
        problem: null,
      },
    } as SlowSnapshotData;
    update({ slowData: invited, mediumData: medium({ hacking: 6_000, money: 1e9 }) });
    expect(rule.view().set).toEqual([]);
    expect(rule.view().progress).toMatchObject({ affordable: 0, reason: null, countdown: null, short: null });
    expect(rule.view().waitingFor).not.toMatch(/short of Daedalus/);
  });

  test("the counts take queued ones whatever their value; the lookahead's reserve counts them too", () => {
    // Neural Wit Amplifier queued already: Magnetism Amplifier the set, two affordable.
    update({
      slowData: runTwo({ queued: ["Neural Wit Amplifier"] }),
      mediumData: medium({ hacking: 6_000, money: 1e9 }),
    });
    expect(rule.view().progress).toMatchObject({ affordable: 2, reason: "nothing left" });
    // Short of the money, with the income to cover it in 15 minutes: held from cloud servers (the reserve).
    rule = newRule();
    events.length = 0;
    measureIncome(1e6, { joined: FOUR, ownedAugs: RUN_2, reputation: 0 }, medium({ hacking: 6_000, money: 0 }));
    expect(rule.view().progress).toMatchObject({ affordable: 0, short: { installed: 23, required: 30 } });
    expect(rule.reserve()).toBeCloseTo(TWO_COST, 0);
  });
});

describe("what counts within reach at a commit while short (#238): Daedalus count stuck's facts", () => {
  /** CyberSec's five and NeuroFlux Governor installed: the extended runs' second cycle, at 6 of 30. */
  const SIX = { ...Object.fromEntries(FIVE.map((name) => [name, 1])), [NFG]: 1 };
  /** NeuroFlux Governor's levels 2 to 4 with $10m: 750k × 1.14ᵏ, × 1.9 for each bought before. */
  const THREE_LEVELS = [1, 2, 3].reduce((sum, k) => sum + 750_000 * 1.14 ** k * 1.9 ** (k - 1), 0);
  /** 22 hours online: both bars at 1, so NeuroFlux Governor's levels alone install. */
  const longCycle = () => {
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: 22 * HOUR, lastGameTimeMs: gameTimeMs }),
    );
    rule = newRule();
  };

  test("nothing else joined: a NeuroFlux-only commit, nothing within reach, and the money left after the set", () => {
    longCycle();
    throughCountdown({
      slowData: slow({ reputation: 18_750, ownedAugs: SIX }),
      mediumData: medium({ money: 10e6 }),
    });
    expect(rule.view().set).toEqual([]);
    expect(readAugmentationCycle(store)).toMatchObject({ neuroFluxTarget: 3, reason: "count reached" });
    const facts = readAugmentationCycle(store)?.countFacts;
    expect(facts?.within).toEqual([]);
    // All $10m (#238 review): not the $6.7m the three levels take, as the fourth's $8.7m isn't covered.
    expect(facts?.moneyAfterSet).toBe(10e6);
    expect(THREE_LEVELS).toBeLessThan(10e6 - 3e6);
    expect(rule.countFacts()).toEqual(facts);
  });

  test("The Black Hand's three reached beyond the money: each, whatever its value, at its price and seller", () => {
    longCycle();
    // At 15,000: Artificial Synaptic Potentiation, Embedded Netburner Module, Magnetism Amplifier (no hacking value).
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "The Black Hand", reputation: 15_000, favor: 0 },
    ];
    throughCountdown({ slowData: slow({ joined, ownedAugs: SIX }), mediumData: medium({ money: 10e6 }) });
    expect(rule.countFacts()).toEqual({
      moneyAfterSet: 10e6,
      within: [
        { augmentation: "Artificial Synaptic Potentiation", faction: "The Black Hand", money: 80e6 },
        { augmentation: "Embedded Netburner Module", faction: "The Black Hand", money: 250e6 },
        { augmentation: "Magnetism Amplifier", faction: "The Black Hand", money: 250e6 },
      ],
    });
  });

  test("the set's own purchases aren't within reach; reached ones left over are, priced after the set", () => {
    // Run #2's 23, BitRunners at 0 (Neural Wit Amplifier not reached): Magnetism Amplifier the set.
    const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
    const runTwo: Record<string, number> = {
      ...Object.fromEntries(
        [...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))]
          .filter((name) => isWorthInstalling(name))
          .map((name) => [name, 1]),
      ),
      [NFG]: 124,
    };
    const joined = HACKERS.map((name) => ({ name, reputation: name === "The Black Hand" ? 15_000 : 0, favor: 0 }));
    longCycle();
    throughCountdown({
      slowData: slow({ joined, ownedAugs: runTwo }),
      mediumData: medium({ hacking: 6_000, money: 1e9 }),
    });
    expect(rule.view().set.map((each) => each.augmentation)).toEqual(["Magnetism Amplifier"]);
    // $1b less Magnetism Amplifier's $250m.
    expect(rule.countFacts()).toEqual({ moneyAfterSet: 750e6, within: [] });
  });

  test("donations (favour 150 at NiteSec): the set's donation off the money; those reached by one, listed", () => {
    longCycle();
    // NiteSec at 9,999: Artificial Synaptic Potentiation reached, Neurotrainer II a reputation short (by donation).
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 9_999, favor: 150 },
    ];
    throughCountdown({ slowData: slow({ joined, ownedAugs: SIX }), mediumData: medium({ money: 200e6 }) });
    const chosen = events.find((event) => event.type === "augmentationInstallChosen");
    expect(chosen).toMatchObject({
      set: [{ augmentation: "Artificial Synaptic Potentiation" }, { augmentation: "Neurotrainer II" }],
    });
    const donated = chosen?.type === "augmentationInstallChosen" ? chosen.donations : [];
    expect(donated).toEqual([{ faction: "NiteSec", reputation: 10_000, amount: donationToReach(1, 1, 1) }]);
    const facts = rule.countFacts();
    expect(facts?.moneyAfterSet).toBeCloseTo(200e6 - (chosen as { cost: number }).cost - donationToReach(1, 1, 1), 0);
    // The rest NiteSec sells by donation, priced after the set's two, with the donation from 9,999: the cheapest first.
    expect(facts?.within[0]).toEqual({
      augmentation: "Embedded Netburner Module",
      faction: "NiteSec",
      money: 250e6 * 1.9 ** 2 + donationToReach(15_000 - 9_999, 1, 1),
    });
    expect(facts?.within.every((each) => each.faction === "NiteSec")).toBe(true);
  });

  test("not short (Daedalus inviting): no facts kept; a note's facts not the brain's fail", () => {
    longCycle();
    const invited = {
      ...slow({ reputation: 18_750, ownedAugs: SIX }),
      factions: {
        backend: "sim",
        state: {
          joined: [{ name: "CyberSec", reputation: 18_750, favor: 0 }],
          invitations: ["Daedalus"],
          queuedAugmentations: [],
        },
        problem: null,
      },
    } as SlowSnapshotData;
    throughCountdown({ slowData: invited, mediumData: medium({ money: 10e6 }) });
    expect(readAugmentationCycle(store)).not.toHaveProperty("countFacts");
    expect(rule.countFacts()).toBeNull();
    store.setSetting(
      AUGMENTATION_CYCLE_SETTING,
      JSON.stringify({ lastAugReset: 0, installing: false, countFacts: { moneyAfterSet: 1, within: [{}] } }),
    );
    expect(() => readAugmentationCycle(store)).toThrow("isn't a note the brain wrote");
  });
});

describe("held for Daedalus's count (#243)", () => {
  const TBH = "The Black Hand";
  const BLACK_HAND_SHOP = augmentationsSoldBy(TBH, 1, null);
  const CYBERSEC_SHOP = augmentationsSoldBy("CyberSec", 1, null);
  /** Augmentations sold by neither joined faction, to fill the count. */
  const FILLERS = AUGMENTATION_NAMES.filter(
    (name) =>
      isWorthInstalling(name, true) &&
      !BLACK_HAND_SHOP.includes(name) &&
      !CYBERSEC_SHOP.includes(name) &&
      name !== "Neural Wit Amplifier",
  );
  /**
   * Run #3's 17:49 (2026-11-05), synthetic: 25 installed (all The Black Hand sells but its own augmentation, CyberSec's
   * Gen I and II, NeuroFlux Governor and fillers sold by neither); Neural Wit Amplifier queued; CyberSec's other three
   * reached, so the install takes it to 29 of 30. The 30th is "The Black Hand" (100,000), worked for.
   */
  const OWNED: Record<string, number> = Object.fromEntries(
    [...BLACK_HAND_SHOP.filter((name) => name !== TBH && name !== NFG), GEN_I, GEN_II, NFG, ...FILLERS]
      .slice(0, 25)
      .map((name) => [name, name === NFG ? 5 : 1]),
  );
  /** A filler not in `OWNED`, to keep 25 installed when one is taken out. */
  const SPARE = FILLERS.find((name) => !Object.hasOwn(OWNED, name)) as string;
  const THREE = ["BitWire", "Synaptic Enhancement Implant", "Neurotrainer I"];
  /** The three after Neural Wit Amplifier, dearest first; with The Black Hand, it first; what it adds. */
  const THREE_COST = 10e6 * 1.9 + 7.5e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3;
  const WITH_BLACK_HAND = 550e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
  const BLACK_HAND_MONEY = WITH_BLACK_HAND - THREE_COST;
  const MONEY = WITH_BLACK_HAND + 10e6;
  /** Daedalus's hacking reached this cycle (#243 review): the count is what's missing. */
  const HACKING = 2_500;
  const playerWith = (money: number, hacking = HACKING) => medium({ hacking, money });

  function runThree({
    reputation = 0,
    favor = 0,
    queued = ["Neural Wit Amplifier"],
    invitations = [] as string[],
    ownedAugs = OWNED,
    earned = 0,
  } = {}): SlowSnapshotData {
    const data = slow({
      joined: [
        { name: "CyberSec", reputation: 18_750, favor: 0 },
        { name: TBH, reputation, favor },
      ],
      queued,
      ownedAugs,
      earned,
    });
    const state = data.factions?.state as FactionState;
    return { ...data, factions: { backend: "sim", state: { ...state, invitations }, problem: null } };
  }
  /** The work's rate at The Black Hand (A5's formula, hacking 2,500): what the hold's ETA is worked at. */
  const RATE = (
    bestWorkRate(
      workingPersonOf(playerWith(0)) as WorkingPerson,
      { name: TBH, reputation: 0, favor: 0 },
      workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow()),
    ) as { perSecond: number }
  ).perSecond;
  /** The Black Hand's reputation `etaMs` off by work. */
  const reputationFor = (etaMs: number) => 100_000 - (RATE * etaMs) / 1000;
  /** 8 h online (`hours`): the bar is 4, so the four count. */
  const online = (hours = 8) => {
    store.deleteSetting(AUGMENTATION_COUNT_HOLD_SETTING);
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: hours * HOUR, lastGameTimeMs: gameTimeMs }),
    );
    rule = newRule();
  };
  /** A minute on: the next slow snapshot, a minute more online. */
  const minuteOn = (
    fields: Parameters<typeof runThree>[0] = {},
    money = MONEY,
    more: Partial<AugmentationInputs> = {},
  ) => {
    gameTimeMs += MINUTE;
    return update({ slowData: runThree(fields), mediumData: playerWith(money), ...more });
  };
  const chosen = () => events.filter((event) => event.type === "augmentationInstallChosen");
  const heldLines = () => lines.filter((line) => line.startsWith("augmentations: install held for Daedalus's count"));
  const OVER = "augmentations: the hold for Daedalus's count is over: ";

  test("the fixture: 25 installed, the install takes it to 29 of 30, The Black Hand the 30th, worked for", () => {
    expect(Object.keys(OWNED)).toHaveLength(25);
    expect(OWNED).toMatchObject({ [GEN_I]: 1, [GEN_II]: 1, [NFG]: 5 });
    expect(OWNED).not.toHaveProperty(TBH);
    expect(RATE).toBeGreaterThan(0);
  });

  test("run #3's 17:49: held, The Black Hand ~17 min off by work; no countdown or install; its money held", () => {
    online();
    const ask = minuteOn({ reputation: reputationFor(17 * MINUTE) });
    expect(ask).toEqual({ intent: null, install: false, committed: false });
    const view = rule.view();
    expect(view.set.map((each) => each.augmentation)).toEqual(THREE);
    expect(view.progress).toMatchObject({ affordable: 4, bar: 4, reason: "count reached", countdown: null });
    expect(view.progress?.held).toBe(
      "Daedalus's count reachable this cycle, The Black Hand in ~17 min (by work at The Black Hand, " +
        `${dollars(BLACK_HAND_MONEY)}; 29 of 30 after this install; held 20 min at most, 20 min left)`,
    );
    expect(view.progress?.countHold).toEqual({
      augmentation: TBH,
      faction: TBH,
      way: "work",
      etaMs: expect.closeTo(17 * MINUTE, -3),
      money: BLACK_HAND_MONEY,
      // The work's time alone (#343: the planner adds up the work one faction at a time).
      workMs: expect.closeTo(17 * MINUTE, -3),
      leftMs: 20 * MINUTE,
    });
    expect(view.waitingFor).toBe(`the install held for Daedalus's count: ${view.progress?.held}`);
    // Held from cloud servers and home RAM alike: the counted purchases' money (the set and NeuroFlux Governor's
    // levels), or the set's and The Black Hand's, the more.
    expect(rule.reserve()).toBeCloseTo(WITH_BLACK_HAND, 0);
    expect(dollars(BLACK_HAND_MONEY)).toBe("$1,111,159,900");
    expect(rule.countdownReserve()).toBe(rule.reserve());
    // Not the countdown (the travel for invitations goes on), and A5 works for The Black Hand.
    expect(rule.countdownUnderWay()).toBe(false);
    expect(rule.countHoldTarget()).toEqual({ faction: TBH, augmentation: TBH });
    expect(heldLines()).toEqual([`augmentations: install held for Daedalus's count: ${view.progress?.held}`]);
    expect(chosen()).toEqual([]);
    expect(rule.countFacts()).toBeNull();
    // The progress event says so, for the run report.
    expect(progressEvents().at(-1)).toMatchObject({ held: view.progress?.held, countHold: { augmentation: TBH } });
    // With $10b, the levels the money covers cost more: their money held, as the countdown would.
    minuteOn({ reputation: reputationFor(16 * MINUTE) }, 10e9);
    expect(rule.view().progress?.countHold).not.toBeNull();
    expect(rule.reserve()).toBeGreaterThan(2 * WITH_BLACK_HAND);
  });

  test("only once this cycle has reached Daedalus's hacking or combat requirement", () => {
    online();
    gameTimeMs += MINUTE;
    update({ slowData: runThree({ reputation: reputationFor(MINUTE) }), mediumData: playerWith(MONEY, 2_499) });
    expect(rule.view().progress).toMatchObject({ reason: "count reached", countHold: null });
    expect(rule.view().progress?.countdown).not.toBeNull();
    // Every combat skill at 1,500 is the other way in.
    const combat = playerWith(MONEY, 2_499);
    Object.assign(combat.player.skills as Record<string, number>, {
      strength: 1_500,
      defense: 1_500,
      dexterity: 1_500,
      agility: 1_500,
    });
    online();
    gameTimeMs += MINUTE;
    update({ slowData: runThree({ reputation: reputationFor(MINUTE) }), mediumData: combat });
    expect(rule.view().progress?.countHold).not.toBeNull();
  });

  test("the share bonus measured (#345): The Black Hand 25 min off at ×1 isn't held (20 min); at ×1.6, 15.6 min, held", () => {
    const reputation = reputationFor(25 * MINUTE);
    online();
    minuteOn({ reputation });
    expect(rule.view().progress).toMatchObject({ countHold: null, reason: "count reached" });
    online();
    minuteOn({ reputation }, MONEY, { shareBonus: 1.6 });
    expect(rule.view().progress?.countHold).toMatchObject({
      augmentation: TBH,
      way: "work",
      etaMs: expect.closeTo((25 / 1.6) * MINUTE, -3),
      workMs: expect.closeTo((25 / 1.6) * MINUTE, -3),
    });
    // The owner's field work there: the share lifts its hacking term alone (`reputation.ts:40-52`).
    const there = { kind: "faction", faction: TBH, workType: "field" } as const;
    const conditions = workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow());
    const person = workingPersonOf(playerWith(0)) as WorkingPerson;
    const fieldRate = factionReputationPerSecond(person, "field", { favor: 0, ...conditions, shareBonus: 1.6 });
    online();
    minuteOn({ reputation: 100_000 - fieldRate * 300 }, MONEY, {
      holdWork: { owners: there, brainWorks: false },
      shareBonus: 1.6,
    });
    expect(rule.view().progress?.countHold).toMatchObject({ way: "work", etaMs: expect.closeTo(5 * MINUTE, -3) });
  });

  test("the level's rise (#401): The Black Hand 21 min off isn't held flat (20 min); along the last cycle's κ, held", () => {
    const reputation = reputationFor(21 * MINUTE);
    online();
    minuteOn({ reputation });
    expect(rule.view().progress).toMatchObject({ countHold: null, reason: "count reached" });
    // The last cycle's rate carried over its install: the level rises over the work.
    const exp = hackingExpOfLevel(HACKING, 1);
    const kappa = (1_000 * exp) / 600 / (HACKING + 50);
    store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa }));
    const along =
      workSecondsAlong(
        { exp, level: HACKING, levelMult: 1, kappa },
        (level) => RATE * (level / HACKING),
        RATE * 21 * 60,
      ) * 1000;
    expect(along).toBeLessThan(20 * MINUTE);
    online();
    minuteOn({ reputation });
    expect(rule.view().progress?.countHold).toMatchObject({
      augmentation: TBH,
      way: "work",
      workMs: expect.closeTo(along, -3),
    });
    // The owner's field work there: along the rise too, shorter than at the level now (5 min).
    const there = { kind: "faction", faction: TBH, workType: "field" } as const;
    const conditions = workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow());
    const person = workingPersonOf(playerWith(0)) as WorkingPerson;
    const fieldRate = factionReputationPerSecond(person, "field", { favor: 0, ...conditions });
    online();
    minuteOn({ reputation: 100_000 - fieldRate * 300 }, MONEY, { holdWork: { owners: there, brainWorks: false } });
    expect(rule.view().progress?.countHold?.etaMs).toBeLessThan(5 * MINUTE - 1_000);
  });

  test("the work counts only where someone works: A5 under the hold, or the owner's faction work there", () => {
    const fiveOff = reputationFor(5 * MINUTE);
    // A5's switch off, no owner's work: nobody earns The Black Hand's reputation, so no hold.
    online();
    minuteOn({ reputation: fiveOff }, MONEY, { holdWork: { owners: null, brainWorks: false } });
    expect(rule.view().progress).toMatchObject({ countHold: null, reason: "count reached" });
    // The owner's work elsewhere wins over A5: no hold either.
    const elsewhere = { kind: "faction", faction: "CyberSec", workType: "hacking" } as const;
    online();
    minuteOn({ reputation: fiveOff }, MONEY, { holdWork: { owners: elsewhere, brainWorks: true } });
    expect(rule.view().progress?.countHold).toBeNull();
    // The owner's field work at The Black Hand: held, at that work's rate.
    const there = { kind: "faction", faction: TBH, workType: "field" } as const;
    const fieldRate = factionReputationPerSecond(workingPersonOf(playerWith(0)) as WorkingPerson, "field", {
      favor: 0,
      ...workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow()),
    });
    online();
    minuteOn({ reputation: 100_000 - fieldRate * 300 }, MONEY, { holdWork: { owners: there, brainWorks: false } });
    expect(rule.view().progress?.countHold).toMatchObject({ way: "work", etaMs: expect.closeTo(5 * MINUTE, -3) });
  });

  test("its reputation reached: the hold over, logged; the countdown, then the install of all five, 30 of 30", () => {
    online();
    minuteOn({ reputation: reputationFor(10 * MINUTE) });
    expect(rule.view().progress?.countHold?.augmentation).toBe(TBH);
    minuteOn({ reputation: 100_000 });
    expect(lines).toContain(`${OVER}the count reached at this install`);
    expect(rule.view().progress).toMatchObject({ affordable: 5, held: null, countHold: null });
    expect(rule.view().progress?.countdown).not.toBeNull();
    expect(rule.countdownUnderWay()).toBe(true);
    expect(rule.countHoldTarget()).toBeNull();
    gameTimeMs += 90_000;
    update({ slowData: runThree({ reputation: 100_000 }), mediumData: playerWith(MONEY) });
    expect(chosen()).toEqual([expect.objectContaining({ reason: "count reached", affordable: 5 })]);
    expect(rule.view().set.map((each) => each.augmentation)).toEqual([TBH, ...THREE]);
    expect(heldLines()).toHaveLength(1);
  });

  test("never past its 20 min: the ETA no longer fitting what's left ends it; the window never restarts", () => {
    online();
    // 5 min off (a second less, so floating point never decides), the reputation not rising: held to 15 of the 20.
    const fiveOff = reputationFor(5 * MINUTE - 1_000);
    minuteOn({ reputation: fiveOff });
    for (let minute = 1; minute <= 15; minute += 1) {
      minuteOn({ reputation: fiveOff });
      expect(rule.view().progress?.countHold).not.toBeNull();
    }
    expect(rule.view().progress?.held).toMatch(/held 20 min at most, 5 min left\)$/);
    expect(heldLines()).toHaveLength(1);
    minuteOn({ reputation: fiveOff });
    expect(rule.view().progress).toMatchObject({ held: null, countHold: null, reason: "count reached" });
    expect(rule.view().progress?.countdown).not.toBeNull();
    expect(lines).toContain(`${OVER}The Black Hand isn't within what's left of its 20 min`);
    // Seconds off now, but the window is the cycle's first, never restarted: 20 min from the hold's start, it's over.
    minuteOn({ reputation: reputationFor(1_000) });
    expect(rule.view().progress?.countHold).not.toBeNull();
    // The countdown the hold's end started is called off.
    expect(rule.view().progress?.countdown).toBeNull();
    for (let minute = 18; minute <= 20; minute += 1) minuteOn({ reputation: reputationFor(1_000) });
    expect(rule.view().progress?.countHold).toBeNull();
    expect(lines).toContain(`${OVER}its 20 min are up`);
    // On to the install at 29, its facts recorded, as #238 has them.
    gameTimeMs += 90_000;
    update({ slowData: runThree({ reputation: reputationFor(1_000) }), mediumData: playerWith(MONEY) });
    expect(chosen()).toEqual([expect.objectContaining({ reason: "count reached", affordable: 4 })]);
    expect(rule.countFacts()).not.toBeNull();
  });

  test("each other end, logged: the count met, the rule not saying install, two short, the switch, snapshots", () => {
    const held = () => {
      online();
      minuteOn({ reputation: reputationFor(5 * MINUTE) });
      expect(rule.view().progress?.countHold).not.toBeNull();
    };
    held();
    minuteOn({ reputation: reputationFor(5 * MINUTE), invitations: ["Daedalus"] });
    expect(lines).toContain(`${OVER}Daedalus's count met`);
    held();
    minuteOn({ reputation: reputationFor(5 * MINUTE) }, 0);
    expect(lines).toContain(`${OVER}the rule no longer says install`);
    held();
    minuteOn({ reputation: reputationFor(5 * MINUTE) }, MONEY, { enabled: false });
    expect(lines).toContain(`${OVER}the Augmentations switch turned off`);
    held();
    gameTimeMs += MINUTE;
    update({ slowData: runThree({ reputation: reputationFor(5 * MINUTE) }), mediumData: null });
    expect(lines).toContain(`${OVER}waiting for the Agent's medium and slow snapshots`);
    // NeuroFlux Governor not installed: its first level the 29th. The money for the three alone leaves it two short.
    const ownedAugs = { ...Object.fromEntries(Object.entries(OWNED).filter(([name]) => name !== NFG)), [SPARE]: 1 };
    const threeAlone = 10e6 + 7.5e6 * 1.9 + 4e6 * 1.9 ** 2;
    online(10);
    minuteOn({ reputation: reputationFor(5 * MINUTE), queued: [], ownedAugs });
    expect(rule.view().progress).toMatchObject({ affordable: 3, countHold: { augmentation: TBH } });
    minuteOn({ reputation: reputationFor(5 * MINUTE), queued: [], ownedAugs }, threeAlone + SLACK);
    expect(lines).toContain(`${OVER}this install would now leave it 2 short`);
    expect(rule.view().progress?.countdown).not.toBeNull();
  });

  test("a restarted brain keeps the hold's window (in the store): it never outlasts 20 min online", () => {
    online();
    minuteOn({ reputation: reputationFor(MINUTE) });
    for (let minute = 1; minute <= 10; minute += 1) minuteOn({ reputation: reputationFor(MINUTE) });
    expect(rule.view().progress?.countHold).toMatchObject({ leftMs: 10 * MINUTE });
    rule = newRule();
    minuteOn({ reputation: reputationFor(MINUTE) });
    expect(rule.view().progress?.countHold).toMatchObject({ leftMs: 9 * MINUTE });
    // A window the brain didn't write fails, at the start (as the commit's note does), not in a decision.
    store.setSetting(AUGMENTATION_COUNT_HOLD_SETTING, JSON.stringify({ lastAugReset: 0 }));
    expect(() => readCountHold(store)).toThrow("isn't a hold the brain wrote");
    expect(() => newRule()).toThrow("isn't a hold the brain wrote");
    // Another cycle's window is none of this one's.
    store.setSetting(AUGMENTATION_COUNT_HOLD_SETTING, JSON.stringify({ lastAugReset: -1, sinceOnlineMs: 0 }));
    rule = newRule();
    minuteOn({ reputation: reputationFor(MINUTE) });
    expect(rule.view().progress?.countHold).toMatchObject({ leftMs: 20 * MINUTE });
  });

  test("not held: the rule not saying install, two short, Daedalus inviting, or the last more than 20 min off", () => {
    // One short after the install, the last a minute off, but 4 affordable under the bar of 7 at 2 h: no hold.
    online(2);
    minuteOn({ reputation: reputationFor(MINUTE) });
    expect(rule.view().progress).toMatchObject({ affordable: 4, bar: 7, reason: null, countHold: null, held: null });
    expect(rule.view().waitingFor).toMatch(/^the count to reach a bar: /);
    // Two short: nothing queued, the three alone, the bar 3 at 10 h.
    online(10);
    minuteOn({ reputation: reputationFor(MINUTE), queued: [] });
    expect(rule.view().progress).toMatchObject({ affordable: 3, reason: "count reached", countHold: null });
    expect(rule.view().progress?.countdown).not.toBeNull();
    // Daedalus inviting: not short, the hacking-value rule.
    online();
    minuteOn({ reputation: reputationFor(MINUTE), invitations: ["Daedalus"] });
    expect(rule.view().progress?.countHold).toBeNull();
    // 21 min off by work.
    online();
    minuteOn({ reputation: reputationFor(21 * MINUTE) });
    expect(rule.view().progress).toMatchObject({ countHold: null, reason: "count reached" });
    expect(rule.view().progress?.countdown).not.toBeNull();
    expect(heldLines()).toEqual([]);
  });

  test("what's to come: never NeuroFlux Governor or The Red Pill, though reached and within the money", () => {
    const toCome = countablesToCome({
      sold: [NFG, "The Red Pill", TBH],
      state: {
        // NeuroFlux Governor not installed yet: its levels add one, but it isn't one to wait for (A6 buys it last).
        installed: Object.fromEntries(Object.entries(OWNED).filter(([name]) => name !== NFG)),
        queued: [],
        sourceFile11Level: 0,
        bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
      },
      set: { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] },
      joined: [
        { name: TBH, reputation: 3e6, favor: 0 },
        { name: "Daedalus", reputation: 3e6, favor: 0 },
      ],
      shops: new Map([
        [TBH, BLACK_HAND_SHOP],
        ["Daedalus", augmentationsSoldBy("Daedalus", 1, null)],
      ]),
      terms: undefined,
      person: workingPersonOf(playerWith(0)) as WorkingPerson,
      conditions: workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow()),
      work: { owners: null, brainWorks: true },
      money: 1e12,
      income: null,
    });
    expect(toCome).toEqual([{ augmentation: TBH, faction: TBH, way: "money", etaMs: 0, money: 550e6 }]);
  });

  /** Magnetism Amplifier not installed (a filler in its place); The Black Hand at 15,000 reaches it. */
  const withoutMagnetism = () => {
    const ownedAugs = { ...OWNED, [SPARE]: 1 };
    delete ownedAugs["Magnetism Amplifier"];
    return ownedAugs;
  };

  test("by the money (#228, whatever its value): Magnetism Amplifier reached, its money at the income", () => {
    const ownedAugs = withoutMagnetism();
    expect(Object.keys(ownedAugs)).toHaveLength(25);
    // Bought with the three, it goes first: $614,670,900 in all, $541,159,900 more than the three.
    const withMagnetism = 250e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
    const money = withMagnetism - 60e6;
    online();
    // No income measured yet: not reachable by the money, not held.
    minuteOn({ reputation: 15_000, ownedAugs }, money);
    expect(rule.view().set.map((each) => each.augmentation)).toEqual(THREE);
    expect(rule.view().progress?.countHold).toBeNull();
    // $100k a second: 10 minutes for the $60m short. The income measured first, with no money (nothing to install).
    online();
    for (let minute = 0; minute <= 10; minute += 1) {
      minuteOn({ reputation: 15_000, ownedAugs, earned: minute * 6e6 }, minute < 10 ? 0 : money);
    }
    expect(rule.view().progress?.countHold).toEqual({
      augmentation: "Magnetism Amplifier",
      faction: TBH,
      way: "money",
      etaMs: expect.closeTo(10 * MINUTE, -3),
      money: withMagnetism - THREE_COST,
      leftMs: 20 * MINUTE,
    });
    expect(rule.view().progress?.held).toMatch(
      /^Daedalus's count reachable this cycle, Magnetism Amplifier in ~10 min \(at The Black Hand, its reputation /,
    );
    // Not by work: A5 isn't steered.
    expect(rule.countHoldTarget()).toBeNull();
  });

  test("a restart with the money not yet covered: held on until the income is measured or the window ends", () => {
    const ownedAugs = withoutMagnetism();
    const withMagnetism = 250e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
    const money = withMagnetism - 60e6;
    online();
    for (let minute = 0; minute <= 10; minute += 1) {
      minuteOn({ reputation: 15_000, ownedAugs, earned: minute * 6e6 }, minute < 10 ? 0 : money);
    }
    expect(rule.view().progress?.countHold).toMatchObject({ way: "money" });
    // Restarted: no income for 10 minutes, but the window open, so the hold goes on, not the install at 29.
    rule = newRule();
    minuteOn({ reputation: 15_000, ownedAugs, earned: 11 * 6e6 }, money);
    expect(rule.view().progress?.countHold).toMatchObject({ way: "money", leftMs: 19 * MINUTE });
    expect(rule.view().progress?.countdown).toBeNull();
    // Earning nothing now: held each minute while the income is unknown (its samples start again at the restart)...
    for (let minute = 12; minute <= 20; minute += 1) {
      minuteOn({ reputation: 15_000, ownedAugs, earned: 11 * 6e6 }, money);
      expect(rule.view().progress?.countHold).toMatchObject({ way: "money", leftMs: (30 - minute) * MINUTE });
    }
    expect(lines.filter((line) => line.startsWith(OVER))).toEqual([]);
    // ...and at 21, 10 minutes of samples measure it: none, so never, and the hold is over, logged once.
    minuteOn({ reputation: 15_000, ownedAugs, earned: 11 * 6e6 }, money);
    expect(rule.view().progress?.countHold).toBeNull();
    expect(lines.filter((line) => line.startsWith(OVER))).toEqual([
      `${OVER}Magnetism Amplifier isn't within what's left of its 20 min`,
    ]);
  });

  test("a hold's end logged before a restart isn't logged again by the restarted brain", () => {
    online();
    minuteOn({ reputation: reputationFor(5 * MINUTE) });
    expect(rule.view().progress?.countHold).not.toBeNull();
    minuteOn({ reputation: reputationFor(5 * MINUTE) }, 0);
    expect(lines.filter((line) => line.startsWith(OVER))).toEqual([`${OVER}the rule no longer says install`]);
    rule = newRule();
    minuteOn({ reputation: reputationFor(5 * MINUTE) }, 0);
    expect(lines.filter((line) => line.startsWith(OVER))).toHaveLength(1);
    // Held again in the window (the store's mark cleared), then restarted: the restarted brain logs this end.
    minuteOn({ reputation: reputationFor(5 * MINUTE) });
    expect(rule.view().progress?.countHold).not.toBeNull();
    rule = newRule();
    minuteOn({ reputation: reputationFor(5 * MINUTE) }, 0);
    expect(lines.filter((line) => line.startsWith(OVER))).toHaveLength(2);
  });

  test("a restarted brain whose hold has ended logs its end at its first decision", () => {
    online();
    minuteOn({ reputation: reputationFor(5 * MINUTE) });
    expect(rule.view().progress?.countHold).not.toBeNull();
    rule = newRule();
    lines.length = 0;
    minuteOn({ reputation: reputationFor(5 * MINUTE), invitations: ["Daedalus"] });
    expect(lines).toContain(`${OVER}Daedalus's count met`);
  });

  test("by a donation (#225): The Black Hand's donations unlocked, its price and donation at the income", () => {
    const donation = donationToReach(100_000 - 50_000, 1, 1);
    // $1m short of it alone (its value first, it would take the three's money); with the three, $140,670,900 short.
    const money = 550e6 * 1.9 + donation - 1e6;
    online();
    for (let minute = 0; minute <= 10; minute += 1) {
      minuteOn({ reputation: 50_000, favor: 150, earned: minute * 12e6 }, minute < 10 ? 0 : money, {
        holdWork: { owners: null, brainWorks: false },
      });
    }
    expect(rule.view().set.map((each) => each.augmentation)).toEqual(THREE);
    expect(rule.view().progress?.countHold).toEqual({
      augmentation: TBH,
      faction: TBH,
      way: "donation",
      etaMs: expect.closeTo(703_354.5, -3),
      money: BLACK_HAND_MONEY + donation,
      leftMs: 20 * MINUTE,
    });
    expect(rule.view().progress?.held).toMatch(/The Black Hand in ~12 min \(by a donation to The Black Hand, /);
  });

  test("donations unlocked, but work sooner (#243 review): the work counts too, the sooner wins", () => {
    // 5 min off at favour 0, 2 at 150 (the rate ×2.5); the donation's money not covered, with no income: work.
    online();
    minuteOn({ reputation: reputationFor(5 * MINUTE), favor: 150 });
    expect(rule.view().progress?.countHold).toMatchObject({ way: "work", etaMs: expect.closeTo(2 * MINUTE, -3) });
  });

  test("donation routes tied (both at once): the cheapest seller's donation wins", () => {
    const ENM = "Embedded Netburner Module";
    const toCome = countablesToCome({
      sold: [ENM],
      state: {
        installed: {},
        queued: [],
        sourceFile11Level: 0,
        bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
      },
      set: { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] },
      joined: [
        { name: "NiteSec", reputation: 0, favor: 150 },
        { name: TBH, reputation: 10_000, favor: 150 },
      ],
      shops: new Map([
        ["NiteSec", augmentationsSoldBy("NiteSec", 1, null)],
        [TBH, BLACK_HAND_SHOP],
      ]),
      terms: {
        sellers: {
          [ENM]: [
            { faction: "NiteSec", reputation: 0 },
            { faction: TBH, reputation: 10_000 },
          ],
        },
        neuroFluxSellers: [],
        factionRep: 1,
        factionWorkRepGain: 1,
      },
      person: workingPersonOf(playerWith(0)) as WorkingPerson,
      conditions: workConditionsOf({ currentNode: 1, ownedAugs: {}, ownedSF: {} }, slow()),
      work: { owners: null, brainWorks: false },
      money: 1e15,
      income: null,
    });
    expect(toCome).toEqual([
      {
        augmentation: ENM,
        faction: TBH,
        way: "donation",
        etaMs: 0,
        money: 250e6 + donationToReach(15_000 - 10_000, 1, 1),
      },
    ]);
  });

  test("a donation where the set already donates (#243 review): the faction raised to the larger, not both", () => {
    // Magnetism Amplifier (15,000) not installed, The Black Hand at 10,000 with donations: the set donates for it.
    const ownedAugs = withoutMagnetism();
    const both = donationToReach(100_000 - 10_000, 1, 1);
    const setsOwn = donationToReach(15_000 - 10_000, 1, 1);
    // $1 short of The Black Hand alone with its donation, so the set is the three and Magnetism Amplifier.
    const money = 550e6 + both - 1;
    online();
    for (let minute = 0; minute <= 10; minute += 1) {
      minuteOn(
        { reputation: 10_000, favor: 150, queued: [], ownedAugs, earned: minute * 60e9 },
        minute < 10 ? 0 : money,
        {
          holdWork: { owners: null, brainWorks: false },
        },
      );
    }
    expect(rule.view().set.map((each) => each.augmentation)).toEqual(["Magnetism Amplifier", ...THREE]);
    // In buy order with the set, it goes first: what it adds to the set's price, and its donation less the set's.
    const setPrice = 250e6 + 10e6 * 1.9 + 7.5e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3;
    const withIt = 550e6 + 250e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
    expect(rule.view().progress?.countHold).toMatchObject({
      augmentation: TBH,
      way: "donation",
      money: expect.closeTo(withIt - setPrice + both - setsOwn, 0),
    });
  });

  test("brain against the fast model (#263): the hold, its window, and the money taken as coming after a restart", () => {
    // 26 installed (Neural Wit Amplifier among them: the model buys at the commit, so nothing's queued), Magnetism
    // Amplifier reached at The Black Hand and $60m short at $100k/s; the install would take the count to 29 of 30.
    const ownedAugs = { ...withoutMagnetism(), "Neural Wit Amplifier": 1 };
    const withMagnetism = 250e6 + 10e6 * 1.9 + 7.5e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3;
    const money = withMagnetism - 60e6;
    const fields = (earned: number) => ({ reputation: 15_000, queued: [], ownedAugs, earned });
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: TBH, reputation: 15_000, favor: 0 },
    ];
    /** The model's hold on the same inputs as the brain's last update, its income and the hold's start given. */
    const modelHold = (income: number | null, heldSinceOnlineMs: number | null, onlineMs: number) =>
      countHoldOf({
        installed: ownedAugs,
        joined,
        currentNode: 1,
        ownedSF: {},
        decision: installDecision({
          installed: ownedAugs,
          joined,
          currentNode: 1,
          ownedSF: {},
          money,
          hacking: HACKING,
          factionRep: 1,
          onlineMs,
          sinceResetMs: gameTimeMs,
        }),
        money,
        income,
        person: workingPersonOf(playerWith(money)) as WorkingPerson,
        conditions: workConditionsOf({ currentNode: 1, ownedAugs, ownedSF: {} }, runThree(fields(0))),
        onlineMs,
        heldSinceOnlineMs,
      });
    // 10 h online: the bar is 3, so the three count.
    online(10);
    for (let minute = 0; minute <= 10; minute += 1) minuteOn(fields(minute * 6e6), minute < 10 ? 0 : money);
    const first = rule.view().progress;
    expect(first).toMatchObject({ affordable: 3, bar: 3, reason: "count reached" });
    expect(first?.countHold).toMatchObject({ augmentation: "Magnetism Amplifier", way: "money" });
    const held = modelHold(100e3, null, first?.onlineMs ?? 0);
    expect(held?.next).toMatchObject({ augmentation: "Magnetism Amplifier", faction: TBH, way: "money" });
    expect(held?.next.etaMs).toBeCloseTo(first?.countHold?.etaMs ?? 0, -3);
    expect((held?.untilOnlineMs ?? 0) - (first?.onlineMs ?? 0)).toBe(first?.countHold?.leftMs);
    // Restarted: no income for 10 minutes, the window open: the money taken as coming (`assumeMoney`), both held on.
    rule = newRule();
    minuteOn(fields(11 * 6e6), money);
    const restarted = rule.view().progress;
    const since = readCountHold(store)?.sinceOnlineMs ?? null;
    expect(restarted?.countHold).toMatchObject({ way: "money", leftMs: 19 * MINUTE });
    const assumed = modelHold(null, since, restarted?.onlineMs ?? 0);
    expect(assumed?.next).toMatchObject({ augmentation: "Magnetism Amplifier", way: "money", etaMs: 0 });
    expect((assumed?.untilOnlineMs ?? 0) - (restarted?.onlineMs ?? 0)).toBe(19 * MINUTE);
    // No hold under way, no income: nothing taken as coming, no hold (the brain's first minutes above); the window
    // over, none; an income of nothing measured, none (the brain's at 21 minutes).
    expect(modelHold(null, null, restarted?.onlineMs ?? 0)).toBeNull();
    expect(modelHold(null, since, (since ?? 0) + DAEDALUS_COUNT_HOLD_MS)).toBeNull();
    expect(modelHold(0, since, restarted?.onlineMs ?? 0)).toBeNull();
  });
});

describe("brain against the fast model (#263): the A6 state the model copies, on the same inputs", () => {
  /** The model's decision on what the brain's update read: eight reached, `money`, at the brain's clocks. */
  const modelDecision = (money: number, onlineMs: number, income: number | null = null) =>
    installDecision({
      installed: {},
      joined: EIGHT_JOINED,
      currentNode: 1,
      ownedSF: {},
      money,
      hacking: 300,
      factionRep: 1,
      onlineMs,
      sinceResetMs: gameTimeMs,
      income,
    });
  const eight = (extra = 0) => ({
    slowData: slow({ joined: EIGHT_JOINED }),
    mediumData: medium({ money: EIGHT_COST + SLACK + extra }),
  });

  test("the countdown: started, extended as the count rises, never shortened, ended; its money held meanwhile", () => {
    const startedAt = gameTimeMs;
    let clock: Countdown | null = null;
    const both = level1After(8) + level2After(8);
    for (const [atMs, extra] of [
      [0, 0],
      [30_000, level1After(8)],
      [32_000, both],
      [112_499, both],
      [112_500, both],
    ] as const) {
      gameTimeMs = startedAt + atMs;
      update(eight(extra));
      // The brain's clock online: from 0 at its first update, the game's time on since.
      const decision = modelDecision(EIGHT_COST + SLACK + extra, atMs);
      const step = installClock(clock, decision.reason, decision, gameTimeMs);
      clock = step.countdown;
      const committed = readAugmentationCycle(store) !== null;
      expect(step.install, `${atMs} ms`).toBe(committed);
      if (committed) continue;
      const countdown = rule.view().progress?.countdown;
      expect(clock?.endsAtMs, `${atMs} ms`).toBe(countdown?.endsAtGameMs);
      expect(clock?.extensions, `${atMs} ms`).toBe(countdown?.extensions);
      expect(holdsOf(decision, clock !== null, null).fromHomeRam, `${atMs} ms`).toBeCloseTo(rule.countdownReserve(), 0);
    }
    expect(readAugmentationCycle(store)).not.toBeNull();
  });

  test("called off as the count falls under the bar, nothing held; started afresh over it", () => {
    const startedAt = gameTimeMs;
    let clock: Countdown | null = null;
    for (const [atMs, extra] of [
      [0, 0],
      [10_000, -20e6],
      [20_000, 0],
    ] as const) {
      gameTimeMs = startedAt + atMs;
      update(eight(extra));
      const decision = modelDecision(EIGHT_COST + SLACK + extra, atMs);
      clock = installClock(clock, decision.reason, decision, gameTimeMs).countdown;
      expect(clock?.endsAtMs ?? null, `${atMs} ms`).toBe(rule.view().progress?.countdown?.endsAtGameMs ?? null);
      expect(holdsOf(decision, clock !== null, null).fromHomeRam, `${atMs} ms`).toBeCloseTo(rule.countdownReserve(), 0);
    }
  });

  test("the lookahead's reserve before the countdown: from cloud servers alone, at the income over the window", () => {
    for (const [short, perSecond] of [
      [10e6, 20_000],
      [30e6, 20_000],
      [10e6, 0],
    ] as const) {
      rule = newRule();
      measureIncome(perSecond, { joined: EIGHT_JOINED }, medium({ money: EIGHT_COST - short }));
      const decision = modelDecision(EIGHT_COST - short, rule.view().progress?.onlineMs ?? 0, perSecond);
      expect(decision.reason).toBeNull();
      const holds = holdsOf(decision, false, null);
      expect(holds.fromCloudServers, `$${short} short at $${perSecond}/s`).toBeCloseTo(rule.reserve(), 0);
      expect(holds.fromHomeRam).toBe(rule.countdownReserve());
    }
  });

  test("the constants the model copies are the brain's", () => {
    expect(model.AUGMENTATION_RESERVE_LOOKAHEAD_MS).toBe(AUGMENTATION_RESERVE_LOOKAHEAD_MS);
    expect(model.INCOME_WINDOW_MS).toBe(AUGMENTATION_INCOME_WINDOW_MS);
    expect(model.CLOUD_SERVER_INCOME_WINDOW_MS).toBe(cloud.CLOUD_SERVER_INCOME_WINDOW_MS);
    expect(model.CLOUD_SERVER_LIMIT).toBe(cloud.CLOUD_SERVER_LIMIT);
    expect(model.CLOUD_SERVER_PAYBACK_LIMIT_MS).toBe(cloud.CLOUD_SERVER_PAYBACK_LIMIT_MS);
    expect(model.CLOUD_SERVER_PRICE_PER_GB).toBe(cloud.CLOUD_SERVER_PRICE_PER_GB);
    expect(model.CLOUD_SERVER_RESERVE_HORIZON_MS).toBe(cloud.CLOUD_SERVER_RESERVE_HORIZON_MS);
    expect(model.MIN_CLOUD_SERVER_RAM).toBe(cloud.MIN_CLOUD_SERVER_RAM);
    // The programs in the order the brain buys them (TOR first, then core's port openers), at the brain's prices.
    expect(model.PROGRAM_PRICES).toEqual([TOR_ROUTER, ...PORT_OPENER_PROGRAMS].map((item) => PURCHASE_PRICES[item]));
    // What home keeps free of #242's share (the model's `shareBonusOfState`).
    expect(model.SHARE_HOME_KEPT_GB).toBe(SHARE_HOME_KEPT_GB);
    // Home's RAM in use beside the share: the Agent's and its largest fresh-save worker's.
    expect(model.HOME_USED_BY_THE_AGENT_GB).toBe(HOME_KEPT_FOR_THE_AGENT_GB);
  });
});

describe("the planner times installs short of Daedalus's count (#343)", () => {
  const TBH = "The Black Hand";
  const BLACK_HAND_SHOP = augmentationsSoldBy(TBH, 1, null);
  const CYBERSEC_SHOP = augmentationsSoldBy("CyberSec", 1, null);
  const FILLERS = AUGMENTATION_NAMES.filter(
    (name) =>
      isWorthInstalling(name, true) &&
      !BLACK_HAND_SHOP.includes(name) &&
      !CYBERSEC_SHOP.includes(name) &&
      name !== "Neural Wit Amplifier",
  );
  const THREE = ["BitWire", "Synaptic Enhancement Implant", "Neurotrainer I"];
  /**
   * Run #3's BN1.2 17:49 (2026-11-05), as #243's tests have it: 25 installed (NeuroFlux Governor among them), Neural
   * Wit Amplifier queued and CyberSec's other three reached, so an install adds 4: 29 of 30. The 30th is "The Black
   * Hand" (100,000 reputation), by work.
   */
  const OWNED: Record<string, number> = Object.fromEntries(
    [...BLACK_HAND_SHOP.filter((name) => name !== TBH && name !== NFG), GEN_I, GEN_II, NFG, ...FILLERS]
      .slice(0, 25)
      .map((name) => [name, name === NFG ? 5 : 1]),
  );
  /** CyberSec's whole shop owned in place of three fillers: only NeuroFlux Governor's levels left to buy there. */
  const ALL_CYBERSEC: Record<string, number> = Object.fromEntries([
    ...Object.entries(OWNED).filter(
      ([name]) =>
        !FILLERS.filter((each) => Object.hasOwn(OWNED, each))
          .slice(-3)
          .includes(name),
    ),
    ...THREE.map((name) => [name, 1] as const),
  ]);
  const THREE_COST = 10e6 * 1.9 + 7.5e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3;
  const WITH_BLACK_HAND = 550e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;
  const MONEY = WITH_BLACK_HAND + 10e6;
  const playerWith = (money: number) => medium({ hacking: 2_500, money });
  function slowWith({
    reputation = 0,
    queued = ["Neural Wit Amplifier"],
    invitations = [] as string[],
    ownedAugs = OWNED,
    earned = 0,
    lastAugReset = 0,
  } = {}): SlowSnapshotData {
    const data = slow({
      joined: [
        { name: "CyberSec", reputation: 18_750, favor: 0 },
        { name: TBH, reputation, favor: 0 },
      ],
      queued,
      ownedAugs,
      earned,
      lastAugReset,
    });
    const state = data.factions?.state as FactionState;
    return { ...data, factions: { backend: "sim", state: { ...state, invitations }, problem: null } };
  }
  const RATE = (
    bestWorkRate(
      workingPersonOf(playerWith(0)) as WorkingPerson,
      { name: TBH, reputation: 0, favor: 0 },
      workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow()),
    ) as { perSecond: number }
  ).perSecond;
  const reputationFor = (etaMs: number) => 100_000 - (RATE * etaMs) / 1000;
  /** The planner's rule, `minutes` online this cycle so far (the next slow snapshot a minute on). */
  /** The game's count of money earned since the install: $1m a second, so 10 minutes of slow snapshots measure it. */
  let earned = 0;
  const plannerAt = (minutes: number) => {
    earned = 0;
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: minutes * MINUTE, lastGameTimeMs: gameTimeMs }),
    );
    // The brain saw the cycle from its install: T is the time online.
    store.setSetting(AUGMENTATION_CYCLE_SEEN_SETTING, JSON.stringify({ lastAugReset: 0, gameTimeMs: 0 }));
    rule = newRule("planner");
  };
  const minuteOn = (
    fields: Parameters<typeof slowWith>[0] = {},
    money = MONEY,
    more: Partial<AugmentationInputs> = {},
  ) => {
    gameTimeMs += MINUTE;
    earned += 60e6;
    return update({ slowData: slowWith({ earned, ...fields }), mediumData: playerWith(money), ...more });
  };
  /** Ten minutes more, the income measured by the next slow snapshot. */
  const tenMinutes = (fields: Parameters<typeof slowWith>[0] = {}, money = MONEY) => {
    for (let minute = 0; minute < 10; minute += 1) minuteOn(fields, money);
  };
  const chosen = () => events.filter((event) => event.type === "augmentationInstallChosen");
  const overdue = () => events.filter((event) => event.type === "augmentationWaitOverdue");

  test("29 of 30, The Black Hand 17 min off by work, 28 min online: the planner waits; no countdown, no install", () => {
    expect(Object.keys(OWNED)).toHaveLength(25);
    plannerAt(27);
    const ask = minuteOn({ reputation: reputationFor(17 * MINUTE) });
    expect(ask).toEqual({ intent: null, install: false, committed: false });
    const progress = rule.view().progress;
    expect(progress?.timing).toEqual({
      needed: 5,
      adding: 4,
      onlineMs: 28 * MINUTE,
      candidates: [
        { k: 0, tauMs: 0, estimateMs: 28 * MINUTE },
        { k: 1, tauMs: expect.closeTo(17 * MINUTE, -3), estimateMs: expect.closeTo(17 * MINUTE, -3) },
      ],
      choice: 1,
      heldForIncome: false,
      heldForInvitation: false,
      tauScale: 1,
      tauError: 0,
      kept: null,
      timeOnlineMs: 28 * MINUTE,
      next: [{ augmentation: TBH, faction: TBH, way: "work", tauMs: expect.closeTo(17 * MINUTE, -3) }],
      // #389: no κ carried over an install (the BitNode's first cycle here): this one's shape, said so.
      laterCycles: {
        rebuildMs: null,
        deadMs: 10 * MINUTE,
        deadMeasured: false,
        left: 13,
        carried: false,
        why: "no faction work yet",
      },
      words:
        "25 of 30 installed, 4 new at an install, 28 min this cycle (T); to Daedalus's count: install now 28 min, " +
        "wait for The Black Hand (17 min, by work at The Black Hand) 17 min; later cycles this one's shape: DP from " +
        "the second cycle: no rate carried over an install yet; chosen: wait for 1",
    });
    expect(progress).toMatchObject({ reason: null, countdown: null, countHold: null, held: null });
    expect(rule.view().waitingFor).toBe(`the planner's time to Daedalus's count: ${progress?.timing?.words}`);
    expect(lines).toEqual([`augmentations: the planner's install timing: ${progress?.timing?.words}`]);
    expect(progressEvents().at(-1)).toMatchObject({ timing: { choice: 1 } });
    // A5 works for The Black Hand; the travel for invitations goes on. 17 minutes is past the lookahead's 15: no money
    // held back.
    expect(rule.countHoldTarget()).toEqual({ faction: TBH, augmentation: TBH });
    expect(rule.countdownUnderWay()).toBe(false);
    expect(rule.reserve()).toBe(0);
    expect(chosen()).toEqual([]);
    // Within the lookahead's 15 minutes, the set's and The Black Hand's money is held from cloud servers and home RAM.
    minuteOn({ reputation: reputationFor(10 * MINUTE) });
    expect(rule.view().progress?.timing?.choice).toBe(1);
    expect(rule.reserve()).toBeCloseTo(WITH_BLACK_HAND, 0);
    expect(rule.countdownReserve()).toBe(rule.reserve());
    // A wait never installs, and the choice unchanged isn't logged again.
    expect(chosen()).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  test("The Black Hand 30 min off at 28 min: install now, at once, its estimates in the event, the log and the note", () => {
    plannerAt(17);
    // No income measured yet (the rule's first ten minutes): installing now, the shortest, is held; the wait meanwhile.
    tenMinutes({ reputation: reputationFor(30 * MINUTE) });
    expect(rule.view().progress?.timing).toMatchObject({ choice: 1, heldForIncome: true });
    expect(rule.view().progress?.timing?.words).toMatch(/; chosen: wait for 1; install now held: no income measured/);
    expect(chosen()).toEqual([]);
    const ask = minuteOn({ reputation: reputationFor(30 * MINUTE) });
    expect(ask).toMatchObject({ install: false, committed: true });
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "Daedalus's count" });
    const event = chosen().at(-1);
    expect(event).toMatchObject({
      reason: "Daedalus's count",
      set: THREE.map((augmentation) => ({ augmentation })),
      cost: expect.closeTo(THREE_COST, 0),
      queued: ["Neural Wit Amplifier"],
      short: { installed: 25, required: 30 },
      timing: {
        needed: 5,
        adding: 4,
        onlineMs: 28 * MINUTE,
        candidates: [
          { k: 0, estimateMs: 28 * MINUTE },
          { k: 1, estimateMs: expect.closeTo(30 * MINUTE, -3) },
        ],
        choice: 0,
      },
    });
    const words = (event as unknown as { timing: { words: string } }).timing.words;
    expect(words).toMatch(/; chosen: install now$/);
    // No countdown: the planner's install goes at once.
    expect(lines.filter((line) => line.includes("countdown"))).toEqual([]);
    expect(lines.slice(-1)).toEqual([
      `augmentations: install chosen, 28 min online this cycle: buying ${THREE.join(", ")} ` +
        `(${dollars(THREE_COST)}), Daedalus's count: the planner's shortest time to it is installing now (#343); ${words}`,
    ]);
    expect(rule.reserve()).toBe(Number.POSITIVE_INFINITY);
  });

  test("the share bonus (#345): The Black Hand 42 min off with no share all along, ×1: install now at 28 min", () => {
    const reputation = reputationFor(42 * MINUTE);
    // No share all along: ×1, as before #345, 42 min against 28: install now.
    plannerAt(17);
    for (let minute = 0; minute < 11; minute += 1) minuteOn({ reputation }, MONEY, { shareBonus: 1 });
    expect(chosen().at(-1)).toMatchObject({
      reason: "Daedalus's count",
      timing: { candidates: [{ k: 0 }, { k: 1, tauMs: expect.closeTo(42 * MINUTE, -3) }], choice: 0 },
    });
  });

  test("the share bonus (#345): The Black Hand 42 min off, at ×1.6 26 min against 28, a wait; a dip of one update, still", () => {
    const reputation = reputationFor(42 * MINUTE);
    // The share running (the batcher's health, the controller's `shareBonusOf`), a slow snapshot's sample each minute:
    // A5's work there earns 1.6 times as much, 26.25 min against 28: a wait.
    plannerAt(17);
    for (let minute = 0; minute < 10; minute += 1) minuteOn({ reputation }, MONEY, { shareBonus: 1.6 });
    const ask = minuteOn({ reputation }, MONEY, { shareBonus: 1.6 });
    expect(ask).toEqual({ intent: null, install: false, committed: false });
    expect(rule.view().progress?.timing).toMatchObject({
      onlineMs: 28 * MINUTE,
      candidates: [
        { k: 0, estimateMs: 28 * MINUTE },
        { k: 1, tauMs: expect.closeTo((42 / 1.6) * MINUTE, -3) },
      ],
      choice: 1,
      heldForIncome: false,
    });
    expect(rule.countHoldTarget()).toEqual({ faction: TBH, augmentation: TBH });
    // A dip for one update (a stale health, a batcher restarting): the window's mean, (9 × 1.6 + 1) / 10, not ×1, so
    // 27.3 min against 29: still a wait, no install (×1 would install: 42 against 29).
    minuteOn({ reputation }, MONEY, { shareBonus: 1 });
    expect(rule.view().progress?.timing).toMatchObject({
      candidates: [{ k: 0 }, { k: 1, tauMs: expect.closeTo((42 / 1.54) * MINUTE, -3) }],
      choice: 1,
    });
    expect(chosen()).toEqual([]);
  });

  test("the share bonus (#345): stopped for the whole window, the estimate falls back to ×1; part of it, the mean", () => {
    const reputation = reputationFor(20 * MINUTE);
    plannerAt(17);
    for (let minute = 0; minute < 11; minute += 1) minuteOn({ reputation }, MONEY, { shareBonus: 1.6 });
    expect(rule.view().progress?.timing?.candidates[1]).toMatchObject({ tauMs: expect.closeTo(12.5 * MINUTE, -3) });
    // Nine minutes without: one sample of 1.6 left in the window.
    for (let minute = 0; minute < 9; minute += 1) minuteOn({ reputation }, MONEY, { shareBonus: 1 });
    expect(rule.view().progress?.timing?.candidates[1]).toMatchObject({
      tauMs: expect.closeTo((20 / 1.06) * MINUTE, -3),
    });
    // The tenth: no share in the whole window, ×1.
    minuteOn({ reputation }, MONEY, { shareBonus: 1 });
    expect(rule.view().progress?.timing).toMatchObject({
      candidates: [{ k: 0 }, { k: 1, tauMs: expect.closeTo(20 * MINUTE, -3) }],
      choice: 1,
    });
    // The mean: 1 with no samples.
    expect(shareBonusMean([])).toBe(1);
    expect(shareBonusMean([1.6, 1.6, 1])).toBeCloseTo(1.4, 12);
  });

  /** The medium snapshot at the next minute, its hacking experience `exp` (the level held at 2,500). */
  const withExp = (exp: number): Partial<AugmentationInputs> => {
    const data = playerWith(MONEY);
    return {
      mediumData: { ...data, player: { ...(data.player as object), exp: { hacking: exp } } },
      mediumGameTimeMs: gameTimeMs + MINUTE,
    };
  };
  const E0 = hackingExpOfLevel(2_500, 1);
  /** τ by work for The Black Hand 42 min off at the level now, along the level's path at `kappa` (core's). */
  const along = (exp: number, kappa: number) =>
    workSecondsAlong({ exp, level: 2_500, levelMult: 1, kappa }, (level) => RATE * (level / 2_500), RATE * 42 * 60) *
    1000;

  test("the level's rise (#401): flat over the window, today's τ (42 min); rising, τ falls with it", () => {
    const reputation = reputationFor(42 * MINUTE);
    plannerAt(60);
    for (let minute = 0; minute < 11; minute += 1) minuteOn({ reputation }, MONEY, withExp(E0));
    expect(rule.view().progress?.timing?.candidates[1]).toMatchObject({ tauMs: expect.closeTo(42 * MINUTE, -3) });
    expect(rule.view().progress?.timing?.levelRise).toBeUndefined();
    // T 71 min: waiting for it (42) is the choice, as at the level now before #401.
    expect(rule.view().progress?.timing?.choice).toBe(1);
    expect(rule.view().progress?.timing?.words).not.toMatch(/level's rise/);
    // Rising, ×2 and ×10 over the window: τ along the level's path, shorter; the faster, the shorter still.
    const taus: number[] = [];
    for (const growth of [1, 9]) {
      plannerAt(60);
      let exp = E0;
      for (let minute = 0; minute < 11; minute += 1) {
        minuteOn({ reputation }, MONEY, withExp(exp));
        if (minute < 10) exp += (growth * E0) / 10;
      }
      const perSecond = (growth * E0) / 600;
      const timing = rule.view().progress?.timing;
      expect(timing?.candidates[1]?.tauMs).toBeCloseTo(along(exp, perSecond / 2_550), -3);
      expect(timing?.levelRise?.from).toBe("measured now");
      expect((timing?.levelRise?.expPerSecond as number) / perSecond).toBeCloseTo(1, 9);
      expect(timing?.words).toMatch(/; τ by work along the level's rise, [\d,]+ exp\/s now \(measured now\); chosen:/);
      taus.push(timing?.candidates[1]?.tauMs as number);
    }
    expect(taus[0]).toBeLessThan(42 * MINUTE - 10_000);
    expect(taus[1]).toBeLessThan(taus[0] as number);
    // The window not whole yet (5 minutes): not measured, the level now.
    plannerAt(60);
    let exp = E0;
    for (let minute = 0; minute < 6; minute += 1) {
      minuteOn({ reputation }, MONEY, withExp(exp));
      exp += (9 * E0) / 10;
    }
    expect(rule.view().progress?.timing?.levelRise).toBeUndefined();
    expect(rule.view().progress?.timing?.candidates[1]).toMatchObject({ tauMs: expect.closeTo(42 * MINUTE, -3) });
  });

  test("the dead time (#405's review): early in a cycle the carried κ rises only after it, measured or the fallback", () => {
    const reputation = reputationFor(10 * MINUTE);
    const kappa = (9 * E0) / 600 / 2_550;
    for (const deadMs of [30 * MINUTE, undefined]) {
      store.setSetting(
        AUGMENTATION_LEVEL_RISE_SETTING,
        JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa, ...(deadMs === undefined ? {} : { deadMs }) }),
      );
      plannerAt(1);
      for (let minute = 0; minute < 3; minute += 1) minuteOn({ reputation }, MONEY, withExp(E0));
      const timing = rule.view().progress?.timing;
      const dead = deadMs ?? 10 * MINUTE;
      const left = Math.max(0, dead - (timing?.timeOnlineMs as number)) / 1000;
      expect(left).toBeGreaterThan(0);
      const expected =
        workSecondsAlong(
          { exp: E0, level: 2_500, levelMult: 1, kappa, delaySeconds: left },
          (level) => RATE * (level / 2_500),
          RATE * 10 * 60,
        ) * 1000;
      expect(timing?.candidates[1]?.tauMs).toBeCloseTo(expected, -3);
      // Later than with none, as the dead time holds the level meanwhile.
      const undelayed =
        workSecondsAlong(
          { exp: E0, level: 2_500, levelMult: 1, kappa },
          (level) => RATE * (level / 2_500),
          RATE * 600,
        ) * 1000;
      expect(timing?.candidates[1]?.tauMs).toBeGreaterThan(undelayed + 1_000);
      expect(timing?.levelRise).toMatchObject({
        from: "the last cycle's",
        deadMs: dead,
        deadMeasured: deadMs !== undefined,
      });
      expect(timing?.words).toMatch(
        deadMs === undefined
          ? /\(the last cycle's, after 10 min: no ramp measured yet, the rate's window\)/
          : /\(the last cycle's, after its ramp of 30 min measured\)/,
      );
    }
  });

  /**
   * A cycle installed at `installMs` (the game's time): the online clock and the brain's look from then, κ carried over
   * the install before it; a new rule. The ramp's κ: the rate over the samples, per level + 50, at E0 a minute.
   */
  const RAMP_KAPPA = E0 / 60 / 2_550;
  const cycleFrom = (installMs: number) => {
    store.setSetting(
      AUGMENTATION_LEVEL_RISE_SETTING,
      JSON.stringify({ lastNodeReset: 0, lastAugReset: installMs - 1, kappa: RAMP_KAPPA }),
    );
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: installMs, onlineMs: 0, lastGameTimeMs: installMs }),
    );
    store.setSetting(
      AUGMENTATION_CYCLE_SEEN_SETTING,
      JSON.stringify({ lastAugReset: installMs, gameTimeMs: installMs }),
    );
    rule = newRule("planner");
  };
  /** `minutes` minutes on, the experience rising by `perMinute` × E0 each, from `exp`; returns the experience then. */
  const rampOn = (installMs: number, minutes: number, perMinute: number, exp: number) => {
    const reputation = reputationFor(42 * MINUTE);
    let now = exp;
    for (let minute = 0; minute < minutes; minute += 1) {
      minuteOn({ reputation, lastAugReset: installMs }, MONEY, withExp(now));
      now += perMinute * E0;
    }
    return now;
  };

  test("this cycle's ramp (#405's review): watched from its install, the time online its rate reaches the carried κ, once", () => {
    const installMs = gameTimeMs;
    cycleFrom(installMs);
    // E0/2 in the first minute, then 2·E0 a minute: over two minutes, 1.25 times the κ.
    let exp = rampOn(installMs, 1, 0.5, E0);
    expect(readLevelRamp(store)).toBeNull();
    const onlineAt: number[] = [];
    for (let minute = 0; minute < 4; minute += 1) {
      exp = rampOn(installMs, 1, 2, exp);
      onlineAt.push(rule.view().progress?.timing?.timeOnlineMs as number);
    }
    const ramp = readLevelRamp(store);
    expect(ramp?.lastAugReset).toBe(installMs);
    expect(ramp?.rampMs).toBeGreaterThan(0);
    expect(onlineAt).toContain(ramp?.rampMs);
    // Stored once: kept as the rate goes on.
    const first = ramp?.rampMs;
    rampOn(installMs, 1, 10, exp);
    expect(readLevelRamp(store)?.rampMs).toBe(first);
  });

  test("the ramp's guard (#405's second review): a restart mid-ramp, the rate reached after it: not measured", () => {
    const installMs = gameTimeMs;
    cycleFrom(installMs);
    // Four minutes under the κ (a tenth of it), then a restart, then 4·E0 a minute: reached, by a brain that didn't
    // watch the ramp from the install.
    const exp = rampOn(installMs, 4, 0.1, E0);
    rule = newRule("planner");
    rampOn(installMs, 4, 4, exp);
    expect(readLevelRamp(store)).toEqual({ lastAugReset: installMs, rampMs: null });
  });

  test("the ramp's guard (#405's second review): a cycle first seen 30 minutes past its install: not measured", () => {
    const installMs = gameTimeMs - 30 * MINUTE;
    cycleFrom(installMs);
    rampOn(installMs, 4, 4, E0);
    expect(readLevelRamp(store)).toEqual({ lastAugReset: installMs, rampMs: null });
  });

  test("the ramp's guard (#405's second review): a gap over 3 minutes in the experience mid-ramp: not measured", () => {
    const installMs = gameTimeMs;
    cycleFrom(installMs);
    const exp = rampOn(installMs, 2, 0.1, E0);
    expect(readLevelRamp(store)).toBeNull();
    // Four minutes with no snapshot (the game closed): the rate starts again, the ramp unwatched.
    gameTimeMs += 4 * MINUTE;
    rampOn(installMs, 4, 4, exp);
    expect(readLevelRamp(store)).toEqual({ lastAugReset: installMs, rampMs: null });
  });

  test("the level's rise (#401): the last cycle's κ carried over the install, where it's more than the window's", () => {
    const reputation = reputationFor(42 * MINUTE);
    const kappa = (9 * E0) / 600 / 2_550;
    const carry = (fields: object) =>
      store.setSetting(
        AUGMENTATION_LEVEL_RISE_SETTING,
        JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa, ...fields }),
      );
    carry({});
    plannerAt(60);
    for (let minute = 0; minute < 11; minute += 1) minuteOn({ reputation }, MONEY, withExp(E0));
    expect(rule.view().progress?.timing?.candidates[1]?.tauMs).toBeCloseTo(along(E0, kappa), -3);
    expect(rule.view().progress?.timing?.candidates[1]?.tauMs).toBeLessThan(42 * MINUTE - 30_000);
    expect(rule.view().progress?.timing?.levelRise).toMatchObject({ from: "the last cycle's" });
    // Its own cycle's, or another BitNode's: not carried, flat.
    for (const fields of [{ lastAugReset: 0 }, { lastNodeReset: 5 }]) {
      carry(fields);
      minuteOn({ reputation }, MONEY, withExp(E0));
      expect(rule.view().progress?.timing?.candidates[1]).toMatchObject({ tauMs: expect.closeTo(42 * MINUTE, -3) });
      expect(rule.view().progress?.timing?.levelRise).toBeUndefined();
    }
    // The window's more: it's taken.
    carry({ kappa: kappa / 100 });
    plannerAt(60);
    let exp = E0;
    for (let minute = 0; minute < 11; minute += 1) {
      minuteOn({ reputation }, MONEY, withExp(exp));
      if (minute < 10) exp += E0 / 10;
    }
    expect(rule.view().progress?.timing?.levelRise).toMatchObject({ from: "measured now" });
    expect(rule.view().progress?.timing?.candidates[1]?.tauMs).toBeCloseTo(along(exp, E0 / 600 / 2_550), -3);
  });

  test("its reputation reached: the set meets the count (n ≥ N), installed at once with all five, 30 of 30", () => {
    plannerAt(27);
    minuteOn({ reputation: reputationFor(10 * MINUTE) });
    expect(rule.view().progress?.timing?.choice).toBe(1);
    minuteOn({ reputation: 100_000 });
    expect(chosen().at(-1)).toMatchObject({
      reason: "Daedalus's count",
      timing: { needed: 5, adding: 5, candidates: [{ k: 0, estimateMs: 0 }], choice: 0 },
    });
    const set = (chosen().at(-1) as unknown as { set: { augmentation: string }[] }).set;
    expect(set.map((each) => each.augmentation).sort()).toEqual([TBH, ...THREE].sort());
    expect(overdue()).toEqual([]);
  });

  test("nothing new to the count (NeuroFlux Governor's levels alone): never an install, where the count rule did", () => {
    // CyberSec's shop owned: only NeuroFlux Governor's levels to buy with $1t; The Black Hand at 0.
    const nothingNew = { ownedAugs: ALL_CYBERSEC, queued: [] as string[], reputation: 0 };
    expect(Object.keys(ALL_CYBERSEC)).toHaveLength(25);
    plannerAt(16 * 60);
    minuteOn(nothingNew, 1e12);
    expect(rule.view().progress?.affordableWithNeuroFlux).toBeGreaterThanOrEqual(4);
    expect(rule.view().progress?.timing).toMatchObject({
      adding: 0,
      candidates: [{ k: 1, tauMs: expect.closeTo((100_000 / RATE) * 1000, -3) }],
      choice: 1,
    });
    // Nobody working for The Black Hand: nothing to wait for at a rate known either; still no install.
    minuteOn(nothingNew, 1e12, { holdWork: { owners: null, brainWorks: false } });
    expect(rule.view().progress?.timing).toMatchObject({ adding: 0, candidates: [], choice: null });
    expect(rule.view().waitingFor).toMatch(/; chosen: nothing new to install, and nothing to come at the rates known$/);
    expect(rule.countHoldTarget()).toBeNull();
    expect(rule.reserve()).toBe(0);
    expect(chosen()).toEqual([]);
    // The count rule's (the A/B's baseline): 16 h online, the levels over its bar, a NeuroFlux-only install.
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: 16 * HOUR, lastGameTimeMs: gameTimeMs }),
    );
    rule = newRule("count rule");
    minuteOn(nothingNew, 1e12);
    expect(rule.view().progress).toMatchObject({ reason: "count reached", affordable: 0 });
    expect(rule.view().progress?.timing).toBeUndefined();
  });

  test("a wait still short at twice its first τ and 10 minutes: overdue, once, the event and the log line", () => {
    plannerAt(27);
    // The Black Hand's reputation never moves (the work isn't counted): its τ stays 10 minutes, the wait goes on.
    const stuck = reputationFor(10 * MINUTE);
    for (let minute = 0; minute < 30; minute += 1) minuteOn({ reputation: stuck });
    expect(rule.view().progress?.timing?.choice).toBe(1);
    expect(overdue()).toEqual([]);
    minuteOn({ reputation: stuck });
    expect(overdue()).toEqual([
      expect.objectContaining({
        onlineMs: 58 * MINUTE,
        sinceOnlineMs: 28 * MINUTE,
        firstTauMs: expect.closeTo(10 * MINUTE, -3),
        untilAdding: 5,
        timing: expect.objectContaining({ choice: 1 }),
      }),
    ]);
    expect(lines.at(-1)).toMatch(
      /^augmentations: WAIT OVERDUE: the planner's wait for Daedalus's count, from 28 min online, expected 5 new at an install in ~10 min, still 4 at 58 min online: the estimate was wrong; 25 of 30/,
    );
    expect(readInstallWait(store)).toMatchObject({ lastAugReset: 0, sinceOnlineMs: 28 * MINUTE, overdue: true });
    for (let minute = 0; minute < 5; minute += 1) minuteOn({ reputation: stuck });
    expect(overdue()).toHaveLength(1);
    // From then on each fresh τ is scaled by the measured error, the wait so far over its first τ: 35 min over 10. At
    // the last countable the scaled wait is the wait so far, under a cycle's T: it goes on (one more cycle is longer).
    expect(rule.view().progress?.timing?.tauScale).toBeCloseTo(3.5, 1);
    expect(rule.view().progress?.timing?.words).toMatch(/; each τ ×3\.5, the overdue wait's measured error; chosen: /);
    expect(chosen()).toEqual([]);
  });

  /** 21 installed (OWNED's first 21: The Black Hand's shop but its own, Gen I and II, NeuroFlux Governor): 9 to go. */
  const OWNED_21 = Object.fromEntries(Object.entries(OWNED).slice(0, 21));

  test("a stalled wait gives way: once overdue, the measured error scales τ until installing now is shorter", () => {
    expect(Object.keys(OWNED_21)).toHaveLength(21);
    plannerAt(27);
    // 21 installed, 4 new at an install, 9 to go: installing now is 2 more cycles (2T), waiting for The Black Hand (10
    // min) T + 2τ. Its reputation never moves, so its τ stays 10 min.
    const stuck = { ownedAugs: OWNED_21, reputation: reputationFor(10 * MINUTE) };
    minuteOn(stuck);
    expect(rule.view().progress?.timing).toMatchObject({
      needed: 9,
      adding: 4,
      candidates: [
        { k: 0, estimateMs: 56 * MINUTE },
        { k: 1, estimateMs: expect.closeTo(48 * MINUTE, -3) },
      ],
      choice: 1,
    });
    // Overdue at 2τ + 10 min (58 min online); the next minute τ × 3.1: 59 + 2 × 31 = 121 min against 2 × 59 = 118.
    for (let minute = 0; minute < 30; minute += 1) minuteOn(stuck);
    expect(overdue()).toHaveLength(1);
    expect(chosen()).toEqual([]);
    minuteOn(stuck);
    expect(chosen()).toEqual([
      expect.objectContaining({
        reason: "Daedalus's count",
        timing: expect.objectContaining({ choice: 0, tauScale: expect.closeTo(3.1, 2), onlineMs: 59 * MINUTE }),
      }),
    ]);
    expect(readInstallWait(store)).toBeNull();
  });

  test("the wait kept in the store: a restarted brain carries on its start, its first τ and its overdue", () => {
    plannerAt(27);
    const stuck = { reputation: reputationFor(10 * MINUTE) };
    minuteOn(stuck);
    const wait = readInstallWait(store);
    expect(wait).toEqual({
      lastAugReset: 0,
      sinceOnlineMs: 28 * MINUTE,
      firstTauMs: expect.closeTo(10 * MINUTE, -3),
      untilAdding: 5,
      overdue: false,
    });
    // Restarted 20 minutes on: the same wait (not a new one from 48 min), overdue at 58 min as before, once.
    for (let minute = 0; minute < 19; minute += 1) minuteOn(stuck);
    rule = newRule("planner");
    for (let minute = 0; minute < 11; minute += 1) minuteOn(stuck);
    expect(readInstallWait(store)).toEqual({ ...wait, overdue: true });
    expect(overdue()).toEqual([expect.objectContaining({ sinceOnlineMs: 28 * MINUTE, onlineMs: 58 * MINUTE })]);
    rule = newRule("planner");
    minuteOn(stuck);
    expect(overdue()).toHaveLength(1);
    // A wait the brain didn't write fails, as the count hold's does.
    store.setSetting(AUGMENTATION_INSTALL_WAIT_SETTING, JSON.stringify({ lastAugReset: 0 }));
    expect(() => newRule()).toThrow("isn't a wait the brain wrote");
  });

  test("a wait's end: n reaching what it waited for, another cycle, and the count met (the planner off) each end it", () => {
    plannerAt(27);
    minuteOn({ ownedAugs: OWNED_21, reputation: reputationFor(10 * MINUTE) });
    expect(readInstallWait(store)).toMatchObject({ untilAdding: 5 });
    // Its reputation reached, restarted (no income): 5 new, 9 to go, installing now held for the income; the wait is
    // over all the same (n reached the 5 it waited for).
    rule = newRule("planner");
    minuteOn({ ownedAugs: OWNED_21, reputation: 100_000 });
    expect(rule.view().progress?.timing).toMatchObject({ adding: 5, choice: null, heldForIncome: true });
    expect(readInstallWait(store)).toBeNull();
    // Another cycle: the last cycle's wait isn't this one's.
    minuteOn({ ownedAugs: OWNED_21, reputation: reputationFor(10 * MINUTE) });
    expect(readInstallWait(store)).toMatchObject({ lastAugReset: 0 });
    const reset = gameTimeMs;
    minuteOn({ ownedAugs: OWNED_21, reputation: 0, lastAugReset: reset });
    expect(readInstallWait(store)).toMatchObject({ lastAugReset: reset });
    // The count met (Daedalus inviting): the planner doesn't time installs, and the wait is gone.
    plannerAt(27);
    minuteOn({ reputation: reputationFor(10 * MINUTE) });
    expect(readInstallWait(store)).not.toBeNull();
    minuteOn({ reputation: reputationFor(10 * MINUTE), invitations: ["Daedalus"] });
    expect(readInstallWait(store)).toBeNull();
  });

  test("T counts the cycle's time before the brain first saw it: a save 7 h into its cycle, first seen now", () => {
    // No clock stored: the brain first sees this cycle 7 h after its install (lastAugReset 0).
    rule = newRule("planner");
    gameTimeMs = 7 * HOUR;
    update({ slowData: slowWith({ reputation: reputationFor(30 * MINUTE) }), mediumData: playerWith(MONEY) });
    expect(readCycleSeen(store)).toEqual({ lastAugReset: 0, gameTimeMs: 7 * HOUR });
    expect(rule.view().progress?.onlineMs).toBe(0);
    expect(rule.view().progress?.timing).toMatchObject({
      onlineMs: 7 * HOUR,
      timeOnlineMs: 0,
      unseenMs: 7 * HOUR,
      candidates: [{ k: 0, estimateMs: 7 * HOUR }, { k: 1 }],
      choice: 1,
    });
    // Labelled (#388): the game's time, its time online not known, leaning towards waiting.
    expect(rule.view().progress?.timing?.words).toMatch(
      /, 7\.0 h this cycle \(T; 0 s online, and 7\.0 h before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\); /,
    );
  });

  test("T: first seen 3 min after its install, within the gap, the bars' clock alone (#388); a second more, all of it", () => {
    // Seen within the gap: the store's slow snapshots aren't read (an install the brain watched).
    const asked: number[] = [];
    rule = new AugmentationRule({
      store,
      installTiming: "planner",
      cycleLooks: (lastAugReset) => {
        asked.push(lastAugReset);
        return [MINUTE];
      },
    });
    gameTimeMs = 3 * MINUTE;
    update({ slowData: slowWith({ reputation: reputationFor(30 * MINUTE) }), mediumData: playerWith(MONEY) });
    expect(asked).toEqual([]);
    expect(rule.view().progress?.timing).toMatchObject({ onlineMs: 0, timeOnlineMs: 0 });
    expect(rule.view().progress?.timing?.unseenMs).toBeUndefined();
    expect(cycleUnseenMs({ lastAugReset: 0, gameTimeMs: 3 * MINUTE })).toBe(0);
    expect(cycleUnseenMs({ lastAugReset: 0, gameTimeMs: 3 * MINUTE + 1_000 })).toBe(3 * MINUTE + 1_000);
  });

  test("an invitation's money held (#228): installing now held unless the set meets the count; then installed", () => {
    plannerAt(17);
    tenMinutes({ reputation: reputationFor(30 * MINUTE) });
    // The income measured, installing now (28 min) the shortest; the invitations rule holding $30m for a city group.
    minuteOn({ reputation: reputationFor(30 * MINUTE) }, MONEY, { invitationHold: 30e6 });
    expect(rule.view().progress?.timing).toMatchObject({
      choice: 1,
      heldForIncome: false,
      heldForInvitation: true,
    });
    expect(rule.view().progress?.timing?.words).toMatch(
      /; install now held: the money held for an invitation \(#228\)/,
    );
    expect(chosen()).toEqual([]);
    // The set meeting the count installs, the hold or not.
    minuteOn({ reputation: 100_000 }, MONEY, { invitationHold: 30e6 });
    expect(chosen()).toEqual([expect.objectContaining({ timing: expect.objectContaining({ adding: 5, choice: 0 }) })]);
  });

  test("the invitation's hold over: installing now goes", () => {
    plannerAt(17);
    tenMinutes({ reputation: reputationFor(30 * MINUTE) });
    minuteOn({ reputation: reputationFor(30 * MINUTE) }, MONEY, { invitationHold: 30e6 });
    expect(chosen()).toEqual([]);
    minuteOn({ reputation: reputationFor(30 * MINUTE) }, MONEY, { invitationHold: 0 });
    expect(chosen()).toEqual([
      expect.objectContaining({ timing: expect.objectContaining({ choice: 0, heldForInvitation: false }) }),
    ]);
  });

  test("held for the income 20 minutes online (two of its windows): once, the event and the log line", () => {
    plannerAt(17);
    // No money sources in the slow snapshots: the income is never measured.
    const unmeasured = () => {
      gameTimeMs += MINUTE;
      const { moneySources: _sources, ...data } = slowWith({ reputation: reputationFor(60 * MINUTE) });
      return update({ slowData: data as SlowSnapshotData, mediumData: playerWith(MONEY) });
    };
    const held = () => events.filter((event) => event.type === "augmentationIncomeHeld");
    for (let minute = 0; minute < 20; minute += 1) unmeasured();
    expect(rule.view().progress?.timing).toMatchObject({ heldForIncome: true });
    expect(held()).toEqual([]);
    unmeasured();
    expect(held()).toEqual([
      expect.objectContaining({ onlineMs: 38 * MINUTE, sinceOnlineMs: 18 * MINUTE, timing: expect.any(Object) }),
    ]);
    expect(lines.at(-1)).toMatch(/^augmentations: INCOME UNMEASURED: installing now held for the income since 18 min/);
    for (let minute = 0; minute < 5; minute += 1) unmeasured();
    expect(held()).toHaveLength(1);
    expect(chosen()).toEqual([]);
  });

  test("a store from before #343, its clock for the cycle and no record of its start, none of its slow snapshots stored: the game's time, labelled", () => {
    // 27 min online, its last slow snapshot at the game's 7 h: the brain first saw the cycle about 6 h 33 min in.
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: 27 * MINUTE, lastGameTimeMs: gameTimeMs }),
    );
    rule = newRule("planner");
    minuteOn({ reputation: reputationFor(17 * MINUTE) });
    expect(readCycleSeen(store)).toEqual({ lastAugReset: 0, gameTimeMs: 7 * HOUR - 27 * MINUTE, fromClock: true });
    // T the game's time since the install (#388: no slow snapshot says when the clock began), labelled.
    expect(rule.view().progress?.timing).toMatchObject({
      onlineMs: 7 * HOUR + MINUTE,
      timeOnlineMs: 28 * MINUTE,
      unseenMs: 7 * HOUR - 27 * MINUTE,
      unseenGaps: true,
    });
    // Mostly the gaps the clock left out, not time before the brain saw the cycle (#397's review): said so.
    expect(rule.view().progress?.timing?.words).toMatch(
      /, 7\.0 h this cycle \(T; 28 min online, and 6\.5 h of the game's time not known online \(a store from before #343: mostly its clock's gaps\), counted whole: cautious, leaning towards waiting\); /,
    );
  });

  test("a store from before #343, a 5 h gap in its clock (BN4.2's first cycle, #388): its first slow snapshot stored is its start", () => {
    // The clock, 27 min online at the game's 7 h; the cycle's first slow snapshot in the store at its install's 1 min.
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: 27 * MINUTE, lastGameTimeMs: gameTimeMs }),
    );
    const asked: number[] = [];
    rule = new AugmentationRule({
      store,
      log: (line) => lines.push(line),
      emit: (event) => events.push(event),
      installTiming: "planner",
      cycleLooks: (lastAugReset) => {
        asked.push(lastAugReset);
        return [MINUTE, 2 * MINUTE, 7 * HOUR + 5 * MINUTE];
      },
    });
    minuteOn({ reputation: reputationFor(17 * MINUTE) });
    expect(asked).toEqual([0]);
    expect(readCycleSeen(store)).toEqual({ lastAugReset: 0, gameTimeMs: MINUTE });
    // Not 7 h 1 min, as the seed from the clock had it: the gap it left out isn't online.
    expect(rule.view().progress?.timing).toMatchObject({ onlineMs: 28 * MINUTE, timeOnlineMs: 28 * MINUTE });
    expect(rule.view().progress?.timing?.unseenMs).toBeUndefined();
    expect(rule.view().progress?.timing?.words).toMatch(/, 28 min this cycle \(T\); /);
  });

  test("Daedalus inviting (the count met): the count rule times installs, as before; the planner doesn't", () => {
    plannerAt(10 * 60);
    minuteOn({ reputation: reputationFor(5 * MINUTE), invitations: ["Daedalus"] });
    expect(rule.view().progress).toMatchObject({ short: null, reason: "count reached" });
    expect(rule.view().progress?.timing).toBeUndefined();
    expect(rule.view().progress?.countdown).not.toBeNull();
  });
});

describe("the planner's later cycles priced from the countables left (#389)", () => {
  /** The pool's factions here: those joined (CyberSec, NiteSec), Tian Di Hui and the six city factions. */
  const POOL = ["CyberSec", "NiteSec", ...LATER_CYCLE_FACTIONS];
  /** Every countable they sell under 10,000 reputation, installed (Augmented Targeting II's prerequisite among them). */
  const CHEAP = [
    "Neurotrainer I",
    "Wired Reflexes",
    "Synaptic Enhancement Implant",
    "Speech Enhancement",
    "BitWire",
    "ADR-V1 Pheromone Gene",
    "Augmented Targeting I",
    "Nuoptimal Nootropic Injector Implant",
    "NutriGen Implant",
    "Social Negotiation Assistant (S.N.A)",
    "Combat Rib I",
    "Speech Processor Implant",
    "INFRARET Enhancement",
    "Augmented Targeting II",
    "Artificial Synaptic Potentiation",
  ];
  const ELSEWHERE = AUGMENTATION_NAMES.filter(
    (name) =>
      name !== NFG &&
      name !== "The Red Pill" &&
      ![...POOL, "Netburners"].some((faction) => augmentationsSoldBy(faction, 1, null).includes(name)),
  );
  /** 28 installed (NeuroFlux Governor once): 2 to go. Gen I queued (10,000 at CyberSec): 1 new at an install. */
  const OWNED: Record<string, number> = Object.fromEntries(
    [...CHEAP, NFG, ...ELSEWHERE.slice(0, 12)].map((name) => [name, name === NFG ? 3 : 1]),
  );
  const MONEY = 1e15;
  const RATE = (
    bestWorkRate(
      workingPersonOf(medium({ money: MONEY })) as WorkingPerson,
      { name: "CyberSec", reputation: 0, favor: 0 },
      workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow()),
    ) as { perSecond: number }
  ).perSecond;
  /** CyberSec's reputation with Gen II (18,750) `minutes` off by A5's work there. */
  const genIIIn = (minutes: number) => 18_750 - RATE * minutes * 60;
  let earned = 0;
  function slowWith({ cyberSec = genIIIn(33), niteSec = null as number | null, lastAugReset = 0 } = {}) {
    const joined = [
      { name: "CyberSec", reputation: cyberSec, favor: 0 },
      ...(niteSec === null ? [] : [{ name: "NiteSec", reputation: niteSec, favor: 0 }]),
    ];
    return slow({ joined, queued: [GEN_I], ownedAugs: OWNED, earned, lastAugReset });
  }
  /** The planner's rule `minutes` online this cycle, R `rebuildMinutes` (none: not measured, not in the store). */
  const plannerAt = (minutes: number, rebuildMinutes: number | null, carried = true) => {
    earned = 0;
    // A κ carried over an install in this BitNode (a cycle before, as the install stores it): the DP prices. Its κ
    // tiny, so the rate measured now is the one taken.
    if (carried) {
      store.setSetting(
        AUGMENTATION_LEVEL_RISE_SETTING,
        JSON.stringify({ lastNodeReset: 0, lastAugReset: -1, kappa: 1e-12, deadMs: null }),
      );
    } else {
      store.deleteSetting(AUGMENTATION_LEVEL_RISE_SETTING);
    }
    store.setSetting(
      AUGMENTATION_ONLINE_SETTING,
      JSON.stringify({ lastAugReset: 0, onlineMs: minutes * MINUTE, lastGameTimeMs: gameTimeMs }),
    );
    store.setSetting(AUGMENTATION_CYCLE_SEEN_SETTING, JSON.stringify({ lastAugReset: 0, gameTimeMs: 0 }));
    if (rebuildMinutes !== null) {
      store.setSetting(
        AUGMENTATION_CYCLE_REBUILD_SETTING,
        JSON.stringify({ lastAugReset: 0, rebuildMs: rebuildMinutes * MINUTE }),
      );
    }
    rule = newRule("planner");
  };
  /** Eleven minutes on (the income measured), a slow snapshot each. */
  const elevenMinutes = (fields: Parameters<typeof slowWith>[0] = {}, more: Partial<AugmentationInputs> = {}) => {
    for (let minute = 0; minute < 11; minute += 1) {
      gameTimeMs += MINUTE;
      earned += 60e6;
      update({ slowData: slowWith(fields), mediumData: medium({ money: MONEY }), ...more });
    }
  };
  const timing = () => rule.view().progress?.timing;

  /** The timing the last install was chosen on (its `augmentationInstallChosen` event's). */
  const chosenTiming = () =>
    (events.filter((event) => event.type === "augmentationInstallChosen").at(-1) as { timing?: unknown } | undefined)
      ?.timing as ReturnType<typeof timing>;

  /** One countable fewer under 10,000 left: CashRoot Starter Kit (12,500) installed for a filler, still 28. */
  const OWNED_DEAR: Record<string, number> = Object.fromEntries([
    ...Object.entries(OWNED).filter(([name]) => name !== ELSEWHERE[11]),
    ["CashRoot Starter Kit", 1],
  ]);
  /** The experience at the level now (300, `medium`'s) and a minute's rise: 600 exp/s, so a level's rise is known. */
  const E300 = hackingExpOfLevel(300, 1);
  let exp = E300;
  /** The experience each minute: 36,000 (steady); `uneven` alternates 20,000 and 52,000 (the same mean). */
  let uneven = false;
  let step = 0;
  /** A minute on: a slow snapshot, the medium snapshot's experience risen 36,000 (or unevenly). */
  const minuteOn = (
    fields: Parameters<typeof slowWith>[0] & { owned?: Record<string, number> } = {},
    more: Partial<AugmentationInputs> = {},
  ) => {
    gameTimeMs += MINUTE;
    earned += 60e6;
    step += 1;
    exp += uneven ? (step % 2 === 0 ? 20_000 : 52_000) : 36_000;
    const data = medium({ money: MONEY });
    const { owned, ...slowFields } = fields;
    const slowData = slowWith(slowFields);
    const ownedAugs = owned ?? OWNED;
    update({
      slowData: { ...slowData, resetInfo: { ...(slowData.resetInfo as object), ownedAugs } } as SlowSnapshotData,
      mediumData: { ...data, player: { ...(data.player as object), exp: { hacking: exp } } },
      mediumGameTimeMs: gameTimeMs,
      ...more,
    });
  };
  const risingMinutes = (
    count: number,
    fields: Parameters<typeof minuteOn>[0] = {},
    more: Partial<AugmentationInputs> = {},
  ) => {
    for (let minute = 0; minute < count; minute += 1) minuteOn(fields, more);
  };

  test("unpriced: R not measured (no faction work yet): install now at T, as before #389", () => {
    expect(Object.keys(OWNED)).toHaveLength(28);
    expect(Object.keys(OWNED_DEAR)).toHaveLength(28);
    expect(genIIIn(33)).toBeGreaterThan(0);
    // No faction work seen (the input absent): R waiting, this one's shape. Gen II 33 min off: install now at T.
    plannerAt(19, null);
    elevenMinutes();
    expect(chosenTiming()).toMatchObject({
      needed: 2,
      adding: 1,
      onlineMs: 30 * MINUTE,
      candidates: [
        { k: 0, estimateMs: 30 * MINUTE },
        // Gen II along the carried κ, a tiny one: within 5 s of the 33 min at the level now.
        { k: 1, tauMs: expect.closeTo(33 * MINUTE, -4) },
      ],
      choice: 0,
      laterCycles: {
        rebuildMs: null,
        why: "no faction work yet",
        deadMs: 10 * MINUTE,
        deadMeasured: false,
        carried: true,
      },
    });
    expect(chosenTiming()?.later).toBeUndefined();
    expect(chosenTiming()?.candidates[0]?.cyclesMs).toBeUndefined();
    expect(chosenTiming()?.words).toMatch(
      /; later cycles this one's shape: R not measured \(no faction work yet\)(; τ by work along [^;]*)?; chosen: install now$/,
    );
  });

  /** The timing at CyberSec's `reputation` (Gen II at 18,750 by A5's work), the level rising, R 5 min. */
  const pricedAt = (reputation: number, owned: Record<string, number>, minutes = 19, carried = true) => {
    store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
    exp = E300;
    plannerAt(minutes, 5, carried);
    risingMinutes(11, { cyberSec: reputation, owned });
    const view = chosenTiming() ?? timing();
    events = [];
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    return view;
  };

  test("dearer countables left (CashRoot Starter Kit installed): install now's estimate rises, and the choice moves to the wait", () => {
    const cheap = pricedAt(0, OWNED);
    const dear = pricedAt(0, OWNED_DEAR);
    // Priced: R 5 min, the level along its rise after the fallback's 10 min (no ramp measured), κ the window's.
    expect(cheap).toMatchObject({
      later: { rebuildMs: 5 * MINUTE, deadSeconds: 600, kappa: expect.any(Number) },
      laterCycles: { rebuildMs: 5 * MINUTE, deadMs: 10 * MINUTE, deadMeasured: false },
    });
    expect(cheap?.words).toMatch(
      /; later cycles from the \d+ countables left, cheapest first, split to the least: R 5 min, the level along its rise after 10 min: no ramp measured yet, the rate's window/,
    );
    // Each later cycle's length in the words.
    expect(cheap?.words).toMatch(/install now [\d.]+ (min|h) \(then [\d.]+ (min|h)\)/);
    const nowOf = (view: typeof cheap) => view?.candidates[0]?.estimateMs as number;
    // The cheapest left, CashRoot Starter Kit's 12,500 (Sector-12), against DermaForce Particle Barrier's 15,000.
    expect(nowOf(dear)).toBeGreaterThan(nowOf(cheap));
    // Gen II's τ halfway between the two: the cheap one installs, the dear one waits. Its reputation found by halving.
    const target = (nowOf(cheap) + nowOf(dear)) / 2;
    let low = 0;
    let high = 18_749;
    for (let step = 0; step < 20; step++) {
      const middle = (low + high) / 2;
      const tau = pricedAt(middle, OWNED)?.candidates[1]?.tauMs as number;
      if (tau > target) low = middle;
      else high = middle;
    }
    expect(pricedAt(low, OWNED)?.choice).toBe(0);
    expect(pricedAt(low, OWNED_DEAR)?.choice).toBe(1);
  });

  test("the first cycle (no κ carried over an install): this cycle's shape, even where the DP would install", () => {
    // Gen II from none at CyberSec, T 600 min. From the second cycle the DP prices install now under Gen II's τ:
    // install. In the first, install now is T, 600, over the τ: the wait, as before #389, and said so.
    const second = pricedAt(0, OWNED, 589);
    const tau = second?.candidates[1]?.tauMs as number;
    expect(second).toMatchObject({ choice: 0, later: { rebuildMs: 5 * MINUTE }, laterCycles: { carried: true } });
    expect(second?.candidates[0]?.estimateMs as number).toBeLessThan(tau);
    expect(tau).toBeLessThan(600 * MINUTE);
    const first = pricedAt(0, OWNED, 589, false);
    expect(first).toMatchObject({
      choice: 1,
      candidates: [{ k: 0, estimateMs: 600 * MINUTE }, { k: 1 }],
      laterCycles: { carried: false },
    });
    expect(first?.later).toBeUndefined();
    expect(first?.candidates[0]?.cyclesMs).toBeUndefined();
    expect(first?.words).toMatch(
      /; later cycles this one's shape: DP from the second cycle: no rate carried over an install yet/,
    );
    // A restart in the first cycle carries none: the store's measurement alone.
    rule = newRule("planner");
    minuteOn({ cyberSec: 0 });
    expect(timing()?.laterCycles?.carried).toBe(false);
    expect(timing()?.later).toBeUndefined();
  });

  test("the brain's later cycles are core's on its inputs: NiteSec's favour after the install, what it installs", () => {
    // NiteSec joined at 3,000: its Neurotrainer II (10,000) the cheapest left, worked after the install at the favour
    // that 3,000 earns (`favorAfterInstall`), the level's path after Gen I and the set's installs.
    store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
    exp = E300;
    plannerAt(19, 5);
    risingMinutes(11, { cyberSec: 0, niteSec: 3000 });
    const chosenEvent = events.filter((event) => event.type === "augmentationInstallChosen").at(-1) as
      | { timing?: InstallTimingView; set?: { augmentation: string }[] }
      | undefined;
    const view = chosenEvent?.timing ?? timing();
    const setNames = (chosenEvent?.set ?? rule.view().set ?? []).map((each) =>
      typeof each === "string" ? each : each.augmentation,
    );
    const joined = [
      { name: "CyberSec", reputation: 0, favor: 0 },
      { name: "NiteSec", reputation: 3000, favor: 0 },
    ];
    const person = workingPersonOf(medium({ money: MONEY })) as WorkingPerson;
    const conditions = workConditionsOf({ currentNode: 1, ownedAugs: OWNED, ownedSF: {} }, slow());
    const { keep: _keep, ...rateConditions } = conditions;
    const rateAt = (faction: string, level: number) => {
      const seller = joined.find((each) => each.name === faction);
      const favor = seller === undefined ? 0 : favorAfterInstall(seller.favor, seller.reputation);
      const best = bestWorkRate(person, { name: faction, reputation: 0, favor }, conditions);
      if (best === null) return 0;
      const at = { ...person, skills: { ...person.skills, hacking: level } };
      return factionReputationPerSecond(at, best.workType, { favor, ...rateConditions });
    };
    const state = {
      installed: OWNED,
      queued: [GEN_I],
      sourceFile11Level: 0,
      bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
    };
    const left = countablesLeft({
      factions: ["CyberSec", "NiteSec", ...LATER_CYCLE_FACTIONS],
      bitNode: 1,
      state,
      set: setNames,
    });
    expect(left[0]?.augmentation).toBe("Neurotrainer II");
    const expected = laterCyclesMs({
      count: (view?.needed as number) - (view?.adding as number),
      perCycle: view?.adding as number,
      shapeMs: Number.NaN,
      later: {
        left,
        rebuildMs: 5 * MINUTE,
        rise: { exp, level: 300, levelMult: 1, kappa: view?.later?.kappa as number },
        deadSeconds: 600,
        rateAt,
        installing: [GEN_I, ...setNames],
      },
    });
    expect(view?.candidates[0]?.cyclesMs).toEqual(expected.map((ms) => expect.closeTo(ms, 0)));
  });

  test("the ramp measured this cycle (#405) is the later cycles' dead time; a κ from another BitNode carries none", () => {
    store.setSetting(AUGMENTATION_LEVEL_RAMP_SETTING, JSON.stringify({ lastAugReset: 0, rampMs: 3 * MINUTE }));
    const measured = pricedAt(0, OWNED);
    expect(measured).toMatchObject({
      later: { deadSeconds: 180 },
      laterCycles: { deadMs: 3 * MINUTE, deadMeasured: true },
    });
    expect(measured?.words).toMatch(/the level along its rise after its ramp of 3 min measured/);
    store.deleteSetting(AUGMENTATION_LEVEL_RAMP_SETTING);
    // A κ stored in another BitNode (its lastNodeReset), or at this cycle's own install: none carried, the first rule.
    for (const stored of [
      { lastNodeReset: -5, lastAugReset: -1, kappa: 1e-12, deadMs: null },
      { lastNodeReset: 0, lastAugReset: 0, kappa: 1e-12, deadMs: null },
    ]) {
      store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
      exp = E300;
      plannerAt(19, 5, false);
      store.setSetting(AUGMENTATION_LEVEL_RISE_SETTING, JSON.stringify(stored));
      risingMinutes(11, { cyberSec: 0 });
      const view =
        (
          events.filter((event) => event.type === "augmentationInstallChosen").at(-1) as
            | { timing?: InstallTimingView }
            | undefined
        )?.timing ?? timing();
      expect(view?.laterCycles?.carried).toBe(false);
      events = [];
      store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    }
  });

  test("κ's measured error propagated through each τ (#406): an uneven experience rate gives each wait an error", () => {
    // Steady: κ's error 0, no share: no error. Uneven (20,000 and 52,000 a minute): κ's relative error over the
    // window, and each τ again at κ lowered by it: the wait for Gen II an error of its own.
    const steady = pricedAt(18_000, OWNED);
    expect(steady?.candidates[1]?.errorMs).toBeUndefined();
    uneven = true;
    const shaky = pricedAt(18_000, OWNED);
    uneven = false;
    const wait = shaky?.candidates[1];
    expect(wait?.errorMs as number).toBeGreaterThan(0);
    expect((wait?.errorMs as number) / (wait?.tauMs as number)).toBeLessThan(1);
  });

  test("Netburners' route open (#387): its five among the countables left, its 1,875 the cheapest: a shorter cycle", () => {
    const without = pricedAt(0, OWNED);
    const sold = augmentationsSoldBy("Netburners", 1, null);
    store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
    exp = E300;
    plannerAt(19, 5);
    risingMinutes(11, { cyberSec: 0 }, { netburners: { sold, setupMoney: 0, invited: true } });
    const view = chosenTiming() ?? timing();
    expect(view?.laterCycles?.left).toBe((without?.laterCycles?.left as number) + 5);
    expect(view?.candidates[0]?.estimateMs as number).toBeLessThan(without?.candidates[0]?.estimateMs as number);
  });

  test("the set meeting the count: no later cycle to price, and the words say nothing of them", () => {
    // CyberSec at 18,750: Gen II reached and bought with Gen I, 2 new of 2 to go.
    plannerAt(19, 5);
    elevenMinutes({ cyberSec: 18_750 });
    const meeting = chosenTiming();
    expect(meeting).toMatchObject({ adding: 2, needed: 2, candidates: [{ k: 0, estimateMs: 0 }], choice: 0 });
    expect(meeting?.candidates[0]?.cyclesMs).toBeUndefined();
    expect(meeting?.words).not.toMatch(/later cycles/);
  });

  test("R measured: T at the cycle's first look with faction work going on, never passive reputation; a restart", () => {
    plannerAt(0, null);
    // Reputation at CyberSec (favour's passive gain) with no work going on: waiting.
    for (let minute = 0; minute < 3; minute += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slowWith({ cyberSec: 50 * minute }), mediumData: medium({ money: MONEY }) });
    }
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: 0, waiting: true });
    expect(timing()?.words).toMatch(/; later cycles this one's shape: R not measured \(no faction work yet\)/);
    // Faction work going on at 4 min: R 4 min.
    gameTimeMs += MINUTE;
    update({ slowData: slowWith({ cyberSec: 200 }), mediumData: medium({ money: MONEY }), factionWorking: true });
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: 0, rebuildMs: 4 * MINUTE });
    // A restart keeps it.
    rule = newRule("planner");
    gameTimeMs += MINUTE;
    update({ slowData: slowWith({ cyberSec: 300 }), mediumData: medium({ money: MONEY }) });
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: 0, rebuildMs: 4 * MINUTE });
    expect(timing()?.laterCycles?.rebuildMs).toBe(4 * MINUTE);
    // Another cycle, first seen with its work going on: not measured.
    gameTimeMs += MINUTE;
    const later = gameTimeMs - 30_000;
    update({ slowData: slowWith({ cyberSec: 300, lastAugReset: later }), mediumData: medium(), factionWorking: true });
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: later, rebuildMs: null });
    expect(timing()?.words).toMatch(/R not measured \(the cycle first seen with its work going on\)/);
    // A value the brain didn't write fails.
    store.setSetting(AUGMENTATION_CYCLE_REBUILD_SETTING, JSON.stringify({ lastAugReset: 0, rebuildMs: "4" }));
    expect(() => readCycleRebuild(store)).toThrow(/isn't one the brain wrote/);
  });

  test("a restart while R waits: unmeasured (the work may have started while the brain was down)", () => {
    plannerAt(0, null);
    gameTimeMs += MINUTE;
    update({ slowData: slowWith({ cyberSec: 0 }), mediumData: medium({ money: MONEY }) });
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: 0, waiting: true });
    rule = newRule("planner");
    gameTimeMs += MINUTE;
    update({ slowData: slowWith({ cyberSec: 0 }), mediumData: medium({ money: MONEY }), factionWorking: true });
    expect(readCycleRebuild(store)).toEqual({ lastAugReset: 0, rebuildMs: null });
  });
});

describe("the margin (#406): install now only by more than the best wait's τ error; the wait under way kept", () => {
  const POOL = ["CyberSec", "NiteSec", ...LATER_CYCLE_FACTIONS];
  /** Every countable the pool's factions sell under 10,000 reputation, installed; fillers sold elsewhere. */
  const CHEAP = [
    "Neurotrainer I",
    "Wired Reflexes",
    "Synaptic Enhancement Implant",
    "Speech Enhancement",
    "BitWire",
    "ADR-V1 Pheromone Gene",
    "Augmented Targeting I",
    "Nuoptimal Nootropic Injector Implant",
    "NutriGen Implant",
    "Social Negotiation Assistant (S.N.A)",
    "Combat Rib I",
    "Speech Processor Implant",
    "INFRARET Enhancement",
    "Augmented Targeting II",
    "Artificial Synaptic Potentiation",
  ];
  const ELSEWHERE = AUGMENTATION_NAMES.filter(
    (name) =>
      name !== NFG &&
      name !== "The Red Pill" &&
      ![...POOL, "Netburners"].some((faction) => augmentationsSoldBy(faction, 1, null).includes(name)),
  );
  const ownedOf = (fillers: number): Record<string, number> =>
    Object.fromEntries([...CHEAP, NFG, ...ELSEWHERE.slice(0, fillers)].map((name) => [name, name === NFG ? 3 : 1]));
  /** 28 installed: 2 to go; 27: 3 to go. Gen I queued: 1 new at an install. */
  const OWNED_28 = ownedOf(12);
  const OWNED_27 = ownedOf(11);
  const MONEY = 1e15;
  let earned = 0;
  let minute = 0;
  /**
   * `count` readings, a minute apart, the share alternating 1 and 1.2 (so its mean has a measured error); first
   * (`fresh`) the rule anew at `minutes` online this cycle (no κ carried: the first cycle, this one's shape).
   */
  const readings = (
    joined: { name: string; reputation: number; favor: number }[],
    owned: Record<string, number>,
    { fresh = false, minutes = 19, count = 1 } = {},
  ) => {
    if (fresh) {
      // A fresh rule: no install chosen, committed or waited for from before.
      events = [];
      store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
      store.deleteSetting(AUGMENTATION_INSTALL_WAIT_SETTING);
      earned = 0;
      store.setSetting(
        AUGMENTATION_ONLINE_SETTING,
        JSON.stringify({ lastAugReset: 0, onlineMs: minutes * MINUTE, lastGameTimeMs: gameTimeMs }),
      );
      store.setSetting(AUGMENTATION_CYCLE_SEEN_SETTING, JSON.stringify({ lastAugReset: 0, gameTimeMs: 0 }));
      rule = newRule("planner");
    }
    for (let each = 0; each < count; each++) {
      gameTimeMs += MINUTE;
      earned += 60e6;
      minute += 1;
      update({
        slowData: slow({ joined, queued: [GEN_I], ownedAugs: owned, earned, lastAugReset: 0 }),
        mediumData: medium({ money: MONEY }),
        shareBonus: minute % 2 === 0 ? 1 : 1.2,
      });
    }
    const chosen = events.filter((event) => event.type === "augmentationInstallChosen").at(-1) as
      | { timing?: InstallTimingView }
      | undefined;
    return chosen?.timing ?? (rule.view().progress?.timing as InstallTimingView);
  };
  const minutesOf = (ms: number | undefined) => (ms as number) / MINUTE;

  test("a near tie within the error waits; a clear install-now win installs", () => {
    // 2 to go, 1 new: install now T, 30 min; waiting for Gen II, its τ. Gen II's reputation set so its τ is 30.5 min,
    // half a minute over T: install now wins by that, within the error: the wait.
    const probe = readings([{ name: "CyberSec", reputation: 0, favor: 0 }], OWNED_28, { fresh: true, count: 11 });
    const perMinute = 18_750 / minutesOf(probe.candidates[1]?.tauMs);
    const at = (tauMinutes: number) => [{ name: "CyberSec", reputation: 18_750 - perMinute * tauMinutes, favor: 0 }];
    const nearTie = readings(at(30.5), OWNED_28, { fresh: true, count: 11 });
    expect(nearTie.tauError).toBeGreaterThan(0.02);
    expect(minutesOf(nearTie.candidates[0]?.estimateMs)).toBeCloseTo(30, 6);
    const tau = minutesOf(nearTie.candidates[1]?.tauMs);
    expect(tau - 30).toBeGreaterThan(0);
    expect(tau - 30).toBeLessThan(nearTie.tauError * tau);
    expect(nearTie).toMatchObject({ choice: 1, kept: "margin" });
    expect(nearTie.words).toMatch(
      /; install now not shorter than the best wait by more than its τ's error \(±[^)]+\): the wait$/,
    );
    expect(events.filter((event) => event.type === "augmentationInstallChosen")).toEqual([]);
    // Gen II 40 min off: install now wins by 10, past the error: it installs.
    const clear = readings(at(40), OWNED_28, { fresh: true, count: 11 });
    expect(clear).toMatchObject({ choice: 0, kept: null });
  });

  test("a held choice doesn't flap within the error: the wait under way kept against a rival shorter by less", () => {
    // 3 to go, 1 new. Waiting for 1 (Gen II, τ1 10 min): τ1 + (T + τ1). For 2 (NiteSec's Neurotrainer II after it, one
    // faction at a time): τ2, meeting the count. NiteSec far off first: the wait for 1 chosen, kept in the store.
    const cyberSec = (minutes: number, perMinute: number) => ({
      name: "CyberSec",
      reputation: 18_750 - perMinute * minutes,
      favor: 0,
    });
    // Each faction's rate at the share's mean, from its first τ from none (Gen II's 18,750; Neurotrainer II's 10,000).
    const tauFromNone = (faction: string) =>
      minutesOf(
        readings([{ name: faction, reputation: 0, favor: 0 }], OWNED_27, { fresh: true, count: 11 }).candidates[1]
          ?.tauMs,
      );
    const cyberPerMinute = 18_750 / tauFromNone("CyberSec");
    const nitePerMinute = 10_000 / tauFromNone("NiteSec");
    const joined = (niteMinutes: number) => [
      cyberSec(10, cyberPerMinute),
      { name: "NiteSec", reputation: 10_000 - nitePerMinute * niteMinutes, favor: 0 },
    ];
    const first = readings(joined(90), OWNED_27, { fresh: true, count: 11 });
    expect(first).toMatchObject({ needed: 3, choice: 1, kept: null });
    // The next reading: NiteSec's work set so τ2 is a minute under the wait for 1's estimate, within the error of the
    // larger τ: the wait for 1 kept.
    const waitFor1 = minutesOf(first.candidates.find((each) => each.k === 1)?.estimateMs) + 1;
    const tau1 = minutesOf(first.candidates.find((each) => each.k === 1)?.tauMs);
    /** NiteSec's work, minutes, for τ2 (CyberSec's τ1 first, then NiteSec's) to be `target`. */
    const nite = (target: number) => target - tau1;
    const held = readings(joined(nite(waitFor1 - 1)), OWNED_27);
    const one = held.candidates.find((each) => each.k === 1) as InstallTimingCandidate;
    const two = held.candidates.find((each) => each.k === 2) as InstallTimingCandidate;
    expect(two.estimateMs).toBeLessThan(one.estimateMs);
    expect(one.estimateMs - two.estimateMs).toBeLessThan(held.tauError * Math.max(one.tauMs, two.tauMs));
    expect(held).toMatchObject({ choice: 1, kept: "held" });
    expect(held.words).toMatch(/; the wait under way kept: no rival shorter by more than the error \(±[^)]+\)/);
    // Past the error (τ2 10 min under): the rival taken.
    const taken = readings(joined(nite(waitFor1 + 1 - 10)), OWNED_27);
    expect(taken).toMatchObject({ choice: 2, kept: null });
  });
});

describe("BN2 before the gang (#357's (1)): wait for the gang, or install now", () => {
  /** SF1.3's ×1.28 at BN2's `HackingLevelMultiplier` 0.8 (`mults.hacking` read 1.28). */
  const LEVEL_MULT = 1.28 * 0.8;
  const xp = (level: number, mult = LEVEL_MULT) => hackingExpOfLevel(level, mult);
  /** #363's seed 1's mean rate from 201 to 212 (24 min 31 s). */
  const RATE = (xp(212) - xp(201)) / (24 * 60 + 31);
  /**
   * The rate's window, s (`HACKING_EXP_WINDOW_MS`): A6 measures τ_g only over it (#378's review), so each case's first
   * run is that much longer, its experience from that much earlier at the same rate, to end where it did.
   */
  const WINDOW_S = HACKING_EXP_WINDOW_MS / 1000;
  /** BN2, CyberSec joined at the reputation for its five. */
  const bn2Slow = (lastAugReset = 0) => slow({ reputation: 18_750, currentNode: 2, lastAugReset });
  /** Hacking `level`, its experience `exp`, the money for CyberSec's five and no NeuroFlux Governor level after. */
  const bn2Medium = (level: number, exp: number): MediumSnapshotData => {
    const data = medium({ hacking: level, money: FIVE_COST + 1e6 });
    const player = { ...(data.player as object), exp: { hacking: exp }, mults: { faction_rep: 1, hacking: 1.28 } };
    return { ...data, player } as MediumSnapshotData;
  };
  let mediumMs = 0;
  beforeEach(() => {
    mediumMs = 7 * HOUR;
  });
  /**
   * `seconds` more of medium snapshots every 10 s at hacking `level`, the experience from `fromExp` at `rate`, a slow
   * snapshot a minute; avmnite-02h's level `required`, or null (no gang forming).
   */
  const run = (
    seconds: number,
    {
      level,
      fromExp,
      rate = RATE,
      required = 218,
    }: { level: number; fromExp: number; rate?: number; required?: number | null },
  ) => {
    let ask: ReturnType<typeof update> | null = null;
    for (let t = 0; t <= seconds; t += 10) {
      mediumMs += 10_000;
      if (t % 60 === 0) gameTimeMs += MINUTE;
      ask = update({
        slowData: bn2Slow(),
        mediumData: bn2Medium(level, fromExp + rate * t),
        mediumGameTimeMs: mediumMs,
        fastGameTimeMs: mediumMs,
        gangForming: required === null ? null : { required },
      });
    }
    return ask;
  };
  const timing = () => rule.view().progress?.timing;
  const chosen = () => events.filter((event) => event.type === "augmentationInstallChosen");
  const overdue = () => events.filter((event) => event.type === "augmentationWaitOverdue");

  test("seed 3's case, 214 of 218: wait for the gang (12 min) against install now (34 min); no install, no money held", () => {
    rule = newRule("planner");
    const ask = run(WINDOW_S + 70, { level: 214, fromExp: xp(214) - RATE * WINDOW_S });
    expect(ask).toEqual({ intent: null, install: false, committed: false });
    const gang = timing()?.gang;
    expect(timing()).toMatchObject({ route: "gang forming", choice: 1, next: [], adding: 5 });
    // τ_g from the experience now (70 s of it at the rate); R from 0 at the five's multipliers.
    expect(gang?.gain).toEqual(levellingInstallMultipliers(0, FIVE));
    const expNow = xp(214) + RATE * 70;
    expect(gang?.waitMs).toBeCloseTo(((xp(218) - expNow) / RATE) * 1000 + 70_000, -2);
    const gain = gang?.gain ?? levellingInstallMultipliers(0);
    const rate = RATE * gain.hackingExp * gain.hackingSpeed;
    expect(gang?.rebuildMs).toBeCloseTo((xp(218, LEVEL_MULT * gain.hacking) / rate) * 1000, -2);
    expect(gang?.installNowMs).toBeCloseTo(120_000 + (gang?.rebuildMs as number), 3);
    expect(gang).toMatchObject({ required: 218, level: 214, heldForRate: false, choice: "wait" });
    expect(timing()?.words).toMatch(
      // T's label on the gang's route too (#397's review): the cycle first seen 7 h in.
      /^no gang yet: wait for the gang \(avmnite-02h's 218 at 214, 12 min\) against install now \(34 min: the commit and 32 min from 0 at 75\.6 experience a second \(64\.8 now, at the install's multipliers\)\); chosen: wait; T 7\.2 h \(11 min online, and 7\.0 h before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\)$/,
    );
    expect(rule.view().waitingFor).toBe(`the planner's time to the gang formed: ${timing()?.words}`);
    // No money held for it, no countdown, nothing for A5 to work for; the wait kept in the store.
    expect(rule.countdownReserve()).toBe(0);
    expect(rule.reserve()).toBe(0);
    expect(rule.view().progress?.countdown).toBeNull();
    expect(rule.countHoldTarget()).toBeNull();
    expect(readInstallWait(store)).toEqual({
      lastAugReset: 0,
      sinceOnlineMs: expect.any(Number),
      firstTauMs: expect.any(Number),
      untilAdding: 5,
      overdue: false,
      route: "gang forming",
    });
    expect(lines).toContainEqual(expect.stringMatching(/^augmentations: the planner's install timing: no gang yet: /));
    expect(chosen()).toEqual([]);
  });

  test("the rules (`bn2Route` rules, the A/B's baseline): #343's candidates there, nothing to come, so it installs", () => {
    rule = new AugmentationRule({
      store,
      log: (line) => lines.push(line),
      emit: (event) => events.push(event),
      installTiming: "planner",
      bn2Route: "rules",
    });
    // Eleven minutes: the income measured (nothing earned), so the five's install is #343's only candidate.
    run(11 * 60, { level: 214, fromExp: xp(214), rate: 1 });
    expect(timing()?.route).toBeUndefined();
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]).toMatchObject({ reason: "Daedalus's count" });
  });

  test("install now wins from level 1 at a slow rate, with the five's multipliers: chosen at once, with its estimates", () => {
    rule = newRule("planner");
    run(WINDOW_S + 70, { level: 1, fromExp: 0, rate: 1 });
    expect(chosen()).toHaveLength(1);
    const event = chosen()[0] as Extract<AugmentationEvent, { type: "augmentationInstallChosen" }>;
    const gang = event.timing?.gang;
    expect(gang?.installNowMs as number).toBeLessThan(gang?.waitMs as number);
    expect(event.reason).toBe("Daedalus's count");
    expect(event.timing).toMatchObject({ route: "gang forming", choice: 0, gang: { choice: "install" } });
    expect(lines).toContainEqual(
      expect.stringMatching(
        /, BN2 before the gang: installing now is the planner's shortest time to the gang formed \(#357\); no gang yet: /,
      ),
    );
    expect(readAugmentationCycle(store)).not.toBeNull();
    expect(readInstallWait(store)).toBeNull();
  });

  test("an invitation's money held (#228): installing now held where it'd win, as #343's", () => {
    rule = newRule("planner");
    for (let t = 0; t <= WINDOW_S + 70; t += 10) {
      mediumMs += 10_000;
      if (t % 60 === 0) gameTimeMs += MINUTE;
      update({
        slowData: bn2Slow(),
        mediumData: bn2Medium(1, t),
        mediumGameTimeMs: mediumMs,
        fastGameTimeMs: mediumMs,
        gangForming: { required: 218 },
        invitationHold: 1e6,
      });
    }
    expect(timing()?.gang).toMatchObject({ heldForInvitation: true, choice: "wait" });
    expect(timing()?.gang?.installNowMs as number).toBeLessThan(timing()?.gang?.waitMs as number);
    expect(timing()?.words).toContain("; install now held: the money held for an invitation (#228); chosen: wait");
    expect(chosen()).toEqual([]);
  });

  test("the gang's reading unread, no gang known (#368's review): installing now held where it'd win", () => {
    rule = newRule("planner");
    for (let t = 0; t <= WINDOW_S + 70; t += 10) {
      mediumMs += 10_000;
      if (t % 60 === 0) gameTimeMs += MINUTE;
      update({
        slowData: bn2Slow(),
        mediumData: bn2Medium(1, t),
        mediumGameTimeMs: mediumMs,
        fastGameTimeMs: mediumMs,
        gangForming: { required: 218, unread: true },
      });
    }
    expect(timing()?.gang).toMatchObject({ heldForGangUnread: true, choice: "wait" });
    expect(timing()?.gang?.installNowMs as number).toBeLessThan(timing()?.gang?.waitMs as number);
    expect(timing()?.words).toContain(
      "; install now held: the gang's reading unread, so whether there's a gang isn't known",
    );
    expect(chosen()).toEqual([]);
  });

  test("no rate measured: installing now held where it'd win, the wait unrecorded; the rate's window of snapshots measures it", () => {
    rule = newRule("planner");
    run(30, { level: 1, fromExp: 0, rate: 1 });
    expect(timing()?.gang).toMatchObject({ heldForRate: true, waitMs: null, installNowMs: null, choice: "wait" });
    expect(timing()?.candidates).toEqual([]);
    expect(timing()?.words).toContain("install now (held: the experience rate not measured yet");
    expect(readInstallWait(store)).toBeNull();
    expect(chosen()).toEqual([]);
    // Measured, it's chosen.
    run(WINDOW_S, { level: 1, fromExp: 40, rate: 1 });
    expect(chosen()).toHaveLength(1);
  });

  test("overdue: still no gang at twice τ_g and 10 minutes online, once; τ_g scaled by the measured error from then", () => {
    rule = newRule("planner");
    run(WINDOW_S + 70, { level: 216, fromExp: xp(216) - RATE * WINDOW_S });
    const first = readInstallWait(store);
    expect(first?.route).toBe("gang forming");
    const firstTauMs = first?.firstTauMs as number;
    // The experience then barely rises (the level never comes); online time runs a minute a slow snapshot.
    const dueMs = 2 * firstTauMs + 10 * MINUTE;
    run(Math.ceil(dueMs / 1000) + 120, { level: 216, fromExp: xp(216) + RATE * 70, rate: 0.001 });
    expect(overdue()).toHaveLength(1);
    expect(overdue()[0]).toMatchObject({ route: "gang forming", firstTauMs });
    expect(lines).toContainEqual(
      expect.stringMatching(/^augmentations: WAIT OVERDUE: the planner's wait for the gang, from /),
    );
    expect(readInstallWait(store)?.overdue).toBe(true);
    // From then on τ_g scaled by its measured error, growing as the wait does: it gives way to installing now.
    run(Math.ceil((4 * dueMs) / 1000), { level: 216, fromExp: xp(216) + RATE * 70, rate: 0.001 });
    expect(overdue()).toHaveLength(1);
    expect(chosen()).toHaveLength(1);
    const event = chosen()[0] as Extract<AugmentationEvent, { type: "augmentationInstallChosen" }>;
    expect(event.timing?.tauScale).toBeGreaterThan(1);
    // The cycle first seen 7 h in: T's label after the route's words (#397's review).
    expect(event.timing?.words).toMatch(
      /; τ_g ×\d+\.\d, the overdue wait's measured error; chosen: install; T [\d.]+ h \([^)]*before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\)$/,
    );
  });

  test("the wait kept in the store: a restarted brain carries on its start and first τ_g", () => {
    rule = newRule("planner");
    run(WINDOW_S + 70, { level: 214, fromExp: xp(214) - RATE * WINDOW_S });
    const wait = readInstallWait(store);
    expect(wait?.route).toBe("gang forming");
    rule = newRule("planner");
    run(WINDOW_S + 70, { level: 214, fromExp: xp(214) + RATE * (80 - WINDOW_S) });
    expect(readInstallWait(store)).toEqual(wait);
  });

  test("no gang forming (none read, or the gang formed): #343's candidates, and the gang's wait gone", () => {
    rule = newRule("planner");
    run(WINDOW_S + 70, { level: 214, fromExp: xp(214) - RATE * WINDOW_S });
    expect(readInstallWait(store)?.route).toBe("gang forming");
    run(10, { level: 214, fromExp: xp(214) + RATE * 80, required: null });
    expect(timing()?.route).toBeUndefined();
    expect(readInstallWait(store)?.route).toBeUndefined();
  });
});

describe("BN2 with the gang (#357's (3)): keep the cycle, install now, or bank R* then install", () => {
  /** BN2, CyberSec joined (the gang's faction NiteSec left out, as the controller's `withoutGangFaction` has it). */
  const bn2Fields = { joined: [{ name: "CyberSec", reputation: 18_750, favor: 0 }], currentNode: 2 };
  const bn2 = () => slow(bn2Fields);
  /** 5.875 reputation a second at favour 0 and `faction_rep` 1: 88.125 respect a cycle (× 5 a second, / 75). */
  const RESPECT_PER_CYCLE = (5.875 * 75) / 5;
  const FIGURES = { rateKept: 0.979, respectPerCycle: RESPECT_PER_CYCLE };
  /** What the gang earns over the commit's 2 minutes at it: an install converts that too. */
  const COMMIT_EARNS = 5.875 * 120;
  /** The gang's faction at `reputation` (favour `favor`), and what the gang rule reads (`gangInstall`). */
  const withGang = (reputation: number, favor = 0, gangInstall: AugmentationInputs["gangInstall"] = FIGURES) => ({
    gangShop: { name: "NiteSec", reputation, favor },
    gangInstall,
  });
  const at = (reputation: number, fields: Partial<AugmentationInputs> = {}) =>
    update({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...withGang(reputation), ...fields });
  const chosen = () =>
    events.filter(
      (event): event is Extract<AugmentationEvent, { type: "augmentationInstallChosen" }> =>
        event.type === "augmentationInstallChosen",
    );
  const timing = () => rule.view().progress?.timing;

  test("keep: at 2m of 2.5m keeping is shortest; no install, no countdown, no money held, for 30 minutes", () => {
    rule = newRule("planner");
    for (let minute = 0; minute <= 30; minute += 1) {
      gameTimeMs += MINUTE;
      expect(at(2e6), `minute ${minute}`).toEqual({ intent: null, install: false, committed: false });
    }
    expect(timing()).toMatchObject({ route: "gang formed", choice: 2, gangInstall: { choice: "keep", bankAt: null } });
    const gang = timing()?.gangInstall;
    // (N − r) / g(f) at the rate at favour 0: 500,000 at 5.875 a second.
    expect(gang?.keepMs).toBeCloseTo((0.5e6 / 5.875) * 1000, -3);
    expect(gang?.installNow as number).toBeGreaterThan(gang?.keep as number);
    // s: the faction_rep of what an install now installs: the set the money covers, and NeuroFlux Governor's levels
    // (CyberSec's) after it, a whole number of them.
    const set = rule.view().set.map((each) => each.augmentation);
    const levels =
      Math.log((gang?.factionRepGain as number) / factionRepInstallMultiplier(0, set)) / Math.log(1.01000262);
    expect(Math.round(levels)).toBeGreaterThanOrEqual(1);
    expect(gang?.factionRepGain).toBeCloseTo(factionRepInstallMultiplier(Math.round(levels), set), 12);
    expect(factionRepInstallMultiplier(0, set)).toBeGreaterThan(1.1);
    expect(timing()?.words).toMatch(
      /^with the gang: NiteSec's 2,000,000 of 2,500,000 reputation, favour 0\.0: keep the cycle 23\.6 h, install now [\d.]+ h \(converting about 2,000,705 with the commit, favour 0\.0 → 221\.\d; the rate ×0\.979 for the members' points, ×[\d.]+ the set's faction_rep\); chosen: keep; T [\d.]+ h \([^)]*before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\)$/,
    );
    expect(rule.view()).toMatchObject({
      waitingFor: `the planner's time to The Red Pill's reputation: ${timing()?.words}`,
      reserve: 0,
      progress: { countdown: null, held: null },
    });
    expect(rule.redPillHeldAtGang()).toBe(true);
    expect(readAugmentationCycle(store)).toBeNull();
    expect(chosen()).toEqual([]);
    // Logged once, as the choice was made; never G5's hold.
    expect(
      lines.filter((line) => line.startsWith("augmentations: the planner's install timing: with the gang")),
    ).toHaveLength(1);
    expect(lines.some((line) => line.includes("held 0 s of at most 20 min"))).toBe(false);
  });

  test("install now: at 500k, chosen at once for the gang's favour, with its estimates and its cost", () => {
    rule = newRule("planner");
    const ask = at(5e5);
    expect(ask.intent?.action).toBe("purchaseAugmentation");
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "the gang's favour" });
    expect(chosen()).toHaveLength(1);
    const [event] = chosen();
    if (event === undefined) throw new Error("no install chosen");
    expect(event.reason).toBe("the gang's favour");
    expect(event.timing).toMatchObject({ route: "gang formed", choice: 0, gangInstall: { choice: "install" } });
    const gang = event.timing?.gangInstall;
    expect(gang?.installNow as number).toBeLessThan(gang?.keep as number);
    // What the install converts: r and the commit's 2 minutes at 5.875 a second (the slow snapshot's age 0 here).
    expect(gang?.atInstall).toBeCloseTo(5e5 + COMMIT_EARNS, 6);
    expect(event.gangCost).toEqual({
      faction: "NiteSec",
      reputation: gang?.atInstall,
      favor: 0,
      favorAfter: favorAfterInstall(0, gang?.atInstall as number),
      needed: 2.5e6,
      redPillMs: gang?.installNowMs,
      keepMs: gang?.keepMs,
      rateKept: 0.979,
    });
    expect(lines).toContainEqual(
      expect.stringMatching(
        /, the gang's favour: in BN2 with the gang, the planner's shortest time to The Red Pill's reputation is installing now, its reputation turned into favour \(#357\); with the gang: .*; its cost: NiteSec's about 500,705 reputation lost, favour 0\.0 → 153\.8, The Red Pill then in ~[\d.]+ h \(keeping's [\d.]+ h\)$/,
      ),
    );
  });

  test("bank: at 100k it waits for R* (about 242k); past it, the install is chosen", () => {
    rule = newRule("planner");
    at(1e5);
    expect(timing()).toMatchObject({ route: "gang formed", choice: 1, gangInstall: { choice: "bank" } });
    const bankAt = timing()?.gangInstall?.bankAt as number;
    expect(bankAt).toBeGreaterThan(1e5);
    expect(bankAt).toBeLessThanOrEqual(242.3e3);
    expect(timing()?.words).toMatch(
      /, bank to [\d,]+ then install [\d.]+ h \(favour \d+\.\d, in [\d.]+ (min|h)\); chosen: bank; T [\d.]+ h \([^)]*before the brain first saw the cycle, counted whole: cautious, leaning towards waiting\)$/,
    );
    expect(timing()?.candidates.map((each) => each.k)).toEqual([0, 1, 2]);
    expect(chosen()).toEqual([]);
    expect(rule.redPillHeldAtGang()).toBe(true);
    // The reputation rising, 5,000 a minute: banking while short of R* (which moves as the set does, its faction_rep
    // in s), then installing once past it, at once.
    let reputation = 1e5;
    let lastBankAt = bankAt;
    while (chosen().length === 0 && reputation < 2.5e6) {
      reputation += 5_000;
      gameTimeMs += MINUTE;
      at(reputation);
      if (chosen().length === 0) {
        expect(timing()?.gangInstall?.choice, `at ${reputation}`).toBe("bank");
        lastBankAt = timing()?.gangInstall?.bankAt as number;
        expect(lastBankAt).toBeGreaterThan(reputation + COMMIT_EARNS);
      }
    }
    // Installed once what it converts (r and the commit's 2 minutes' reputation) reaches R*.
    expect(chosen()).toHaveLength(1);
    expect(reputation + COMMIT_EARNS).toBeGreaterThanOrEqual(lastBankAt);
    expect(reputation + COMMIT_EARNS).toBeLessThan(lastBankAt + 5_000);
    expect(chosen()[0]).toMatchObject({ reason: "the gang's favour" });
    expect(chosen()[0]?.gangCost?.reputation).toBeCloseTo(reputation + COMMIT_EARNS, 6);
    expect(chosen()[0]?.timing?.gangInstall).toMatchObject({ choice: "install", bankAt: null });
  });

  test("p unknown: the gang unread, no install, the hold said; never earning in the cycle, the rules as before", () => {
    rule = newRule("planner");
    at(5e5, withGang(5e5, 0, null));
    expect(timing()?.gangInstall).toMatchObject({ choice: "keep", heldForRate: true, installNow: null, keepMs: null });
    expect(timing()?.words).toContain(
      "install now (held: the rate after it not known: no respect earned now, or the gang unread)",
    );
    expect(chosen()).toEqual([]);
    expect(rule.redPillHeldAtGang()).toBe(true);
    // Members training from the cycle's start, so p never known in it (#357's G3 suite, #372's review): (3) has no rate
    // after an install, and what's banked isn't growing, so the rules decide, as before #357: no planner's route, the
    // count rule's countdown (G5's hold not within its window at 500k), its install carrying its cost with p unknown.
    expect(readGangRateKept(store)).toBeNull();
    const training = withGang(5e5, 0, { rateKept: null, respectPerCycle: 0 });
    at(5e5, training);
    expect(timing()?.route).toBeUndefined();
    expect(rule.view().progress?.countdown).not.toBeNull();
    expect(rule.redPillHeldAtGang()).toBe(false);
    gameTimeMs += 90_000;
    at(5e5, training);
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]?.reason).not.toBe("the gang's favour");
    expect(chosen()[0]?.gangCost).toMatchObject({ reputation: 5e5, rateKept: null });
  });

  test("a pause to train longer than the countdown (#372's review): the cycle's last p decides, keeping; no install, held for the stall to watch", () => {
    rule = newRule("planner");
    gameTimeMs += MINUTE;
    at(2e6);
    expect(readGangRateKept(store)).toEqual({ lastAugReset: 0, rateKept: 0.979 });
    // Five minutes training (the plan earns no respect: p unread now) with $1t: the count rule would install.
    const training = withGang(2e6, 0, { rateKept: null, respectPerCycle: 0 });
    for (let minute = 1; minute <= 5; minute += 1) {
      gameTimeMs += MINUTE;
      expect(at(2e6, training), `minute ${minute}`).toEqual({ intent: null, install: false, committed: false });
      expect(timing()).toMatchObject({ route: "gang formed", gangInstall: { choice: "keep", rateKept: 0.979 } });
      expect(rule.view().progress?.countdown).toBeNull();
      // Held for The Red Pill there: the World Daemon's reputation stall watches, as on main (#372's re-review).
      expect(rule.redPillHeldAtGang()).toBe(true);
    }
    expect(chosen()).toEqual([]);
    // A restart keeps p (the store's): training, still the planner's.
    rule = newRule("planner");
    at(2e6, training);
    expect(timing()?.gangInstall).toMatchObject({ choice: "keep", rateKept: 0.979 });
    // The gang unread (a restart's first updates): the stored p isn't used (#372's re-review), so at 500k, where p
    // would install now, nothing is installed; read again, it is.
    rule = newRule("planner");
    at(5e5, withGang(5e5, 0, null));
    expect(timing()?.gangInstall).toMatchObject({ choice: "keep", rateKept: null, heldForRate: true });
    expect(chosen()).toEqual([]);
    at(5e5, withGang(5e5, 0, training.gangInstall));
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]?.reason).toBe("the gang's favour");
    store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
    events.length = 0;
    rule = newRule("planner");
    // Another cycle (an install since): p never known there, so the rules, as G3's never-earning gang.
    at(2e6, { ...training, slowData: slow({ ...bn2Fields, lastAugReset: 5 * MINUTE }) });
    expect(timing()?.route).toBeUndefined();
    // A p the brain didn't write fails, as the wait's does.
    store.setSetting("augmentations.gangRateKept", "not json");
    expect(() => readGangRateKept(store)).toThrow("isn't JSON");
    store.setSetting("augmentations.gangRateKept", JSON.stringify({ lastAugReset: 0 }));
    expect(() => readGangRateKept(store)).toThrow("isn't a p the brain wrote");
  });

  test("favour multiplies the rate (`Gang.ts:152-155`): at favour 100 keeping's minutes are half favour 0's", () => {
    rule = newRule("planner");
    at(2e6, withGang(2e6, 0));
    const atZero = timing()?.gangInstall?.keepMs as number;
    at(2e6, withGang(2e6, 100));
    // The rate now (at favour 100) is twice favour 0's, and keeping's reputation a half: the same minutes, at twice.
    expect(timing()?.gangInstall?.keep).toBeCloseTo(0.5e6 / 2, 3);
    expect(timing()?.gangInstall?.keepMs).toBeCloseTo(atZero / 2, -3);
  });

  test("The Red Pill reached there: G5's endgame, unchanged: its install, and no cost (the route's end)", () => {
    rule = newRule("planner");
    at(2.5e6, { mediumData: medium({ money: 1e9 }) });
    expect(readAugmentationCycle(store)).toMatchObject({ reason: "The Red Pill" });
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]?.gangCost).toBeUndefined();
    expect(chosen()[0]?.timing).toBeUndefined();
  });

  test("the rules (the A/B's baseline): the count rule's install there, its cost recorded too", () => {
    rule = new AugmentationRule({
      store,
      log: (line) => lines.push(line),
      emit: (event) => events.push(event),
      installTiming: "planner",
      bn2Route: "rules",
    });
    throughCountdown({ slowData: bn2(), mediumData: medium({ money: 1e12 }), ...withGang(2e6) });
    expect(chosen()).toHaveLength(1);
    expect(chosen()[0]?.reason).not.toBe("the gang's favour");
    expect(chosen()[0]?.timing).toBeUndefined();
    expect(chosen()[0]?.gangCost).toMatchObject({
      faction: "NiteSec",
      reputation: 2e6 + COMMIT_EARNS,
      favor: 0,
      favorAfter: favorAfterInstall(0, 2e6 + COMMIT_EARNS),
      needed: 2.5e6,
    });
    expect(lines).toContainEqual(
      expect.stringMatching(/; its cost: NiteSec's about 2,000,705 reputation lost, favour 0\.0 → 221\.\d, /),
    );
  });

  test("no gang (BN2 before it, or BN1): nothing changes, the same decisions as the rules'", () => {
    const decide = (bn2Route: "planner" | "rules") => {
      store.deleteSetting(AUGMENTATION_CYCLE_SETTING);
      store.deleteSetting(AUGMENTATION_ONLINE_SETTING);
      gameTimeMs = 7 * HOUR;
      events.length = 0;
      rule = new AugmentationRule({
        store,
        emit: (event) => events.push(event),
        installTiming: "count rule",
        bn2Route,
      });
      const asks = [];
      for (let minute = 0; minute < 3; minute += 1) {
        gameTimeMs += MINUTE;
        asks.push(update({ slowData: bn2(), mediumData: medium({ money: 1e12 }) }));
      }
      return { asks, view: rule.view(), events: [...events] };
    };
    const planner = decide("planner");
    const rules = decide("rules");
    expect(planner.view.progress?.timing ?? null).toBeNull();
    expect(planner.asks).toEqual(rules.asks);
    expect(planner.events.map((event) => event.type)).toEqual(rules.events.map((event) => event.type));
    expect(planner.events.some((event) => "gangCost" in event)).toBe(false);
  });
});
