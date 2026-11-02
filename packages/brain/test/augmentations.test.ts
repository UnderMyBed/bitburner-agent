// Augmentations and the reset (#210): the brain's rule, driven with snapshot data as the Agent sends it. Core's
// augmentation-plan.test.ts works the formulas; here, what the rule reads, the bars' clock of time online and the
// countdown (#222), its phases, the commit, the purchases' check against the queue, its events and its view.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUGMENTATION_NAMES,
  chooseAugmentationsToBuy,
  type FactionState,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUGMENTATION_CYCLE_SETTING,
  AUGMENTATION_INSTALL_INTENT,
  AUGMENTATION_ONLINE_SETTING,
  AUGMENTATION_PROGRESS_COUNTS_EVERY_MS,
  type AugmentationEvent,
  type AugmentationInputs,
  AugmentationRule,
  advanceOnlineClock,
  describeProgress,
  describeReason,
  earnedOf,
  formatEta,
  purchaseIntent,
  readAugmentationCycle,
  readAugmentationsEnabled,
  readOnlineClock,
} from "../src/augmentations.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

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

const newRule = () =>
  new AugmentationRule({ store, log: (line) => lines.push(line), emit: (event) => events.push(event) });

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
        "cycle; the bar falls to 7 in 1.8 h",
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
        "the bar falls to 7 in 2.0 h",
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
        "1.9 h",
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
