// Augmentations and the reset (#210): the brain's rule, driven with snapshot data as the Agent sends it. Core's
// augmentation-plan.test.ts works the formulas; here, what the rule reads, its phases, the commit, the purchases' check
// against the queue, its events and its view.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FactionState, MediumSnapshotData, SlowSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AUGMENTATION_CYCLE_SETTING,
  type AugmentationEvent,
  type AugmentationInputs,
  AugmentationRule,
  earnedOf,
  formatEta,
  purchaseIntent,
  readAugmentationCycle,
  readAugmentationsEnabled,
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
} = {}): SlowSnapshotData {
  const state: FactionState = {
    joined: joined ?? [{ name: "CyberSec", reputation, favor: 0 }],
    invitations: [],
    queuedAugmentations: queued,
  };
  return {
    resetInfo: { lastAugReset, lastNodeReset: 0, currentNode: 1, ownedAugs, ownedSF: {}, bitNodeOptions: {} },
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

/** The game's time of each slow snapshot fed, from 7 h after the last install. */
let gameTimeMs = 7 * HOUR;
beforeEach(() => {
  gameTimeMs = 7 * HOUR;
});
/** An update; the medium snapshot arrived with it (`mediumAtMs` its `nowMs`) unless said: its money is fresh. */
function update(fields: Partial<AugmentationInputs> & { slowData?: SlowSnapshotData | null } = {}) {
  return rule.update({
    mediumData: medium(),
    mediumAtMs: fields.nowMs ?? 1_000,
    slowData: slow(),
    slowGameTimeMs: gameTimeMs,
    doneIds: new Set(),
    nowMs: 1_000,
    enabled: true,
    homeRamEnabled: true,
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

describe("waiting", () => {
  test("for the snapshots, the reset info, the player and the faction state, saying which", () => {
    expect(update({ mediumData: null })).toEqual({ intent: null, install: false, committed: false });
    expect(rule.view()).toMatchObject({ waiting: true, enabled: true });
    const noReset = { ...slow(), resetInfo: undefined } as unknown as SlowSnapshotData;
    update({ slowData: noReset });
    expect(rule.view()).toMatchObject({ waiting: false, waitingFor: "the reset info in the Agent's slow snapshot" });
    update({ mediumData: { ...medium(), player: { skills: { hacking: 1 } } } });
    expect(rule.view().waitingFor).toMatch(/^the player's skills, experience, money and multipliers/);
    update({ slowData: slow({ reading: "unread" }) });
    expect(rule.view().waitingFor).toBe(
      "the faction state in the Agent's slow snapshot (unread: the page's Factions wouldn't open)",
    );
    expect(events).toEqual([]);
  });

  test("nothing to install: no commit, whatever the income", () => {
    measureIncome(1_000_000, { reputation: 0 });
    expect(update({ slowData: slow({ reputation: 0 }) }).committed).toBe(false);
    expect(rule.view().waitingFor).toMatch(/^an augmentation worth installing/);
  });

  test("with something to install and a next one: the income measured first", () => {
    // Gen I reached at 10,000; Gen II at 18,750 is the next.
    update({ slowData: slow({ reputation: 10_000 }), mediumData: medium({ money: 1e9 }) });
    expect(rule.view().waitingFor).toBe("the income, measured over 10 minutes of slow snapshots");
    expect(readAugmentationCycle(store)).toBeNull();
  });
});

describe("the decision", () => {
  test("CyberSec's five reached and covered, nothing else at the joined factions: install chosen, at once", () => {
    const ask = update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: FIVE_COST }) });
    expect(ask).toEqual({ intent: purchaseIntent("CyberSec", GEN_I, 1), install: false, committed: true });
    expect(readAugmentationCycle(store)).toEqual({ lastAugReset: 0, installing: false });
    expect(events).toEqual([
      {
        type: "augmentationInstallChosen",
        atMs: 1_000,
        set: FIVE.map((augmentation) => ({ augmentation, price: expect.any(Number) })),
        cost: FIVE_COST,
        queued: [],
        sinceResetMs: 7 * HOUR,
        rebuildMs: expect.any(Number),
        without: null,
        with: null,
        reason: "nothing left",
      },
    ]);
    expect(lines).toEqual([
      `augmentations: install chosen, 7.0 h since the last: buying ${FIVE.join(", ")} ($447,170,900), nothing else ` +
        "worth installing at the joined factions",
    ]);
    expect(rule.view()).toMatchObject({
      committed: true,
      asking: `buying ${GEN_I} from CyberSec for $70,000,000`,
      reserve: Number.POSITIVE_INFINITY,
    });
  });

  test("the next one sooner carrying on: no install, saying both; none within 15 minutes either, so no reserve", () => {
    // Hacking 300, focused hacking work: 300 / 975 × 5 = 1.54 rep/s. Gen II: 8,750 more rep, 1.6 h; installing, the
    // rebuild then 18,750 from scratch.
    measureIncome(100_000, { reputation: 10_000 }, medium({ money: 200e6 }));
    const ask = update({ slowData: slow({ reputation: 10_000, earned: 1e12 }), mediumData: medium({ money: 200e6 }) });
    expect(ask).toEqual({ intent: null, install: false, committed: false });
    const { decision, waitingFor, set, reserve } = rule.view();
    expect(decision?.without).toEqual({ augmentation: GEN_II, faction: "CyberSec", ms: expect.any(Number) });
    expect(decision?.without?.ms).toBeCloseTo(((18_750 - 10_000) / ((300 / 975) * 5)) * 1000, -3);
    expect(decision?.with?.ms).toBeGreaterThan(decision?.without?.ms as number);
    expect(waitingFor).toMatch(/^the next augmentation to come no sooner by installing \(1\.6 h carrying on, \d/);
    // The four reached ($200m covers them all: Gen I, BitWire, Synaptic, Neurotrainer I).
    expect(set.map((each) => each.augmentation)).toEqual([
      GEN_I,
      "BitWire",
      "Synaptic Enhancement Implant",
      "Neurotrainer I",
    ]);
    // With 15 minutes more income ($290m), Gen II is still over an hour off carrying on: nothing held back.
    expect(reserve).toBe(0);
    expect(readAugmentationCycle(store)).toBeNull();
    expect(events).toEqual([]);
  });

  test("the reserve: an install projected within A2's payback limit holds its set's money back; not before", () => {
    // CyberSec's five reached, NiteSec joined (its next far off), $435m at $20k/s. Now, Synaptic is left out ($447m with
    // it) and comes in 10 min: no install. In 15 minutes ($453m) the five are covered, and NiteSec's next is 15 h off
    // carrying on (Neurotrainer II at 1.9⁵ its price), 3.3 h installing first: install.
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    measureIncome(20_000, { joined }, medium({ money: 435e6 }));
    expect(rule.view()).toMatchObject({ committed: false, decision: { install: false } });
    expect(rule.reserve()).toBeCloseTo(FIVE_COST, 0);
    // $100m: the five not covered within the 15 minutes ($118m): nothing held back.
    rule = newRule();
    measureIncome(20_000, { joined }, medium({ money: 100e6 }));
    expect(rule.view()).toMatchObject({ committed: false });
    expect(rule.reserve()).toBe(0);
    // No income: nothing held back.
    rule = newRule();
    measureIncome(0, { joined }, medium({ money: 400e6 }));
    expect(rule.reserve()).toBe(0);
  });

  test("an income of 0 never installs: the money's wait can't be judged (#213 review)", () => {
    // As above, with nothing earned over the window: before the fix, every candidate short of money was "never".
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 0, favor: 0 },
    ];
    measureIncome(0, { joined }, medium({ money: 400e6 }));
    expect(readAugmentationCycle(store)).toBeNull();
    expect(rule.view().waitingFor).toMatch(/^an income above \$0 a second/);
    expect(events).toEqual([]);
  });

  test("the money far off carrying on: install chosen", () => {
    // NiteSec joined too, with nothing reached there: its next costs 1.9⁵ times over after CyberSec's five, at $10k/s.
    const joined = [
      { name: "CyberSec", reputation: 18_750, favor: 0 },
      { name: "NiteSec", reputation: 6_250, favor: 0 },
    ];
    measureIncome(10_000, { joined }, medium({ money: FIVE_COST }));
    expect(readAugmentationCycle(store)).toEqual({ lastAugReset: 0, installing: false });
    const [chosen] = events;
    expect(chosen).toMatchObject({
      type: "augmentationInstallChosen",
      without: { faction: "NiteSec" },
      reason: "sooner installing",
    });
    if (chosen?.type !== "augmentationInstallChosen") throw new Error("no decision");
    expect(chosen.with?.ms as number).toBeLessThan(chosen.without?.ms as number);
  });
});

/** Committed with CyberSec's five reached and $1b; returns the slow snapshot's fields. */
function committed() {
  const fields = { reputation: 18_750 };
  update({ slowData: slow(fields), mediumData: medium({ money: 1e9, homeRam: 1024 }) });
  expect(readAugmentationCycle(store)).not.toBeNull();
  return fields;
}

describe("committed", () => {
  test("the set in buy order, each once reported done; then home's RAM, NeuroFlux Governor, the install", () => {
    committed();
    let money = 1e9;
    const queue: string[] = [];
    const bought = (id: string) =>
      update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money, homeRam: 256 }),
        doneIds: new Set([id]),
      });
    for (const [index, name] of FIVE.entries()) {
      const ask = update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money, homeRam: 256 }),
      });
      expect(ask.intent).toEqual(purchaseIntent("CyberSec", name, 1));
      const price = (events.at(0) as { set: { price: number }[] }).set[index]?.price as number;
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
    // $553m left: home's RAM 256 → 512 GB first ($318m: 256 × 32,000 × 1.58⁸; 512 → 1024 would be $1b).
    const homeRam = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 256 }),
    });
    expect(homeRam.intent).toMatchObject({
      action: "upgradeHomeRam",
      args: { fromRam: 256, vendor: "Alpha Enterprises" },
    });
    expect(rule.view().asking).toBe("home RAM to 512 GB before the install (it stays)");
    update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 256 }),
      doneIds: new Set([homeRam.intent?.id as string]),
    });
    // Reported done again, the medium snapshot not yet showing it: logged once.
    const again = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money, homeRam: 256 }),
      doneIds: new Set([homeRam.intent?.id as string]),
    });
    expect(again.intent).toEqual(homeRam.intent);
    expect(lines.filter((line) => line.endsWith("done, before the install (home's RAM stays)"))).toHaveLength(1);
    // Home at 1024 GB (as if bought twice), $300m left: NeuroFlux Governor level 1, at 750k × 1.9⁵ = $18.6m.
    money = 300e6;
    const neuroFlux = update({ slowData: slow({ reputation: 18_750, queued: queue }), mediumData: medium({ money }) });
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
    // $447,170,900 covers the five exactly. Bought, with the medium snapshot from before them still the latest, nothing
    // is left: no NeuroFlux Governor ($18.6m) on money already spent.
    update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: FIVE_COST }) });
    const queue: string[] = [];
    for (const [index, name] of FIVE.entries()) {
      const nowMs = 2_000 + index;
      const ask = update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money: FIVE_COST }),
        mediumAtMs: 1_000,
        nowMs,
      });
      expect(ask.intent).toEqual(purchaseIntent("CyberSec", name, 1));
      update({
        slowData: slow({ reputation: 18_750, queued: [...queue] }),
        mediumData: medium({ money: FIVE_COST }),
        mediumAtMs: 1_000,
        nowMs,
        doneIds: new Set([ask.intent?.id as string]),
      });
      queue.push(name);
    }
    const stale = update({
      slowData: slow({ reputation: 18_750, queued: queue }),
      mediumData: medium({ money: FIVE_COST }),
      mediumAtMs: 1_000,
      nowMs: 3_000,
    });
    // Not NeuroFlux Governor: waiting for the faction state to show the five, with nothing left to buy.
    expect(stale).toEqual({ intent: null, install: false, committed: true });
    expect(rule.view().waitingFor).toMatch(/^the faction state to show /);
  });

  test("a medium snapshot after the purchases is the money: the spending isn't taken off twice", () => {
    update({ slowData: slow({ reputation: 18_750 }), mediumData: medium({ money: 1e9 }) });
    const first = update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      nowMs: 2_000,
      mediumAtMs: 1_000,
    });
    update({
      slowData: slow({ reputation: 18_750 }),
      mediumData: medium({ money: 1e9 }),
      nowMs: 2_000,
      mediumAtMs: 1_000,
      doneIds: new Set([first.intent?.id as string]),
    });
    // The newer snapshot shows $377,170,900 left: Gen II and the rest exactly, nothing more taken off it.
    const ask = update({
      slowData: slow({ reputation: 18_750, queued: [GEN_I] }),
      mediumData: medium({ money: 377_170_900 }),
      nowMs: 3_000,
      mediumAtMs: 3_000,
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
    expect(readAugmentationCycle(store)).toEqual({ lastAugReset: 0, installing: true });
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
      reason: "nothing was bought to install",
    });
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

  test("the income needs a full window, and starts again at a reset", () => {
    // Five minutes of it: not yet.
    for (let minute = 0; minute <= 5; minute += 1) {
      gameTimeMs += MINUTE;
      update({ slowData: slow({ reputation: 10_000, earned: minute * 60_000 }) });
    }
    expect(rule.view().waitingFor).toMatch(/^the income/);
    measureIncome(1_000, { reputation: 10_000 });
    expect(rule.view().waitingFor).not.toMatch(/^the income/);
    gameTimeMs += MINUTE;
    update({ slowData: slow({ reputation: 10_000, lastAugReset: gameTimeMs - MINUTE }) });
    expect(rule.view().waitingFor).toMatch(/^the income/);
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
