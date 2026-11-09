// The World Daemon (#215): the path read from snapshot data as the Agent sends it, the destroy asked for once
// w0r1d_d43m0n is ready and held until the reset, and the stalls.
import {
  AUGMENTATION_NAMES,
  augmentationCost,
  augmentationsSoldBy,
  countablesWithinReach,
  isWorthInstalling,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import type { CountFacts } from "../src/augmentations.ts";
import {
  describeWorldDaemonPath,
  describeWorldDaemonSwitch,
  HackingExpRate,
  hackingEtaSeconds,
  RED_PILL_INSTALL_STALLED_AFTER_MS,
  RED_PILL_REPUTATION_STALLED_AFTER_MS,
  replayOf,
  WORLD_DAEMON_DESTROY_INTENT,
  WORLD_DAEMON_STALLED_AFTER_MS,
  type WorldDaemonEvent,
  WorldDaemonRule,
  worldDaemonPath,
} from "../src/world-daemon.ts";
import { WORLD_DAEMON_EVENT_KINDS, WorldDaemonFold } from "../src/world-daemon-report.ts";

const DAEMON = "w0r1d_d43m0n";
const RED_PILL = "The Red Pill";
const MINUTE = 60_000;
/** Thirty installed augmentations: Daedalus's count in BN1. */
const THIRTY = Object.fromEntries(
  AUGMENTATION_NAMES.filter((name) => name !== RED_PILL && name !== "NeuroFlux Governor")
    .slice(0, 30)
    .map((name) => [name, 1]),
);
const ONE = AUGMENTATION_NAMES.find((name) => name !== RED_PILL) as string;

/** The hacking experience for `level` at multiplier 1 (`skill.ts`'s inverse). */
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.6);

function staticData(requiredHackingSkill = 3000): StaticSnapshotData {
  return { servers: [{ hostname: DAEMON, requiredHackingSkill }] } as unknown as StaticSnapshotData;
}

/** A medium snapshot: hacking `hacking` (its experience at multiplier 1), the money, w0r1d_d43m0n listed or not. */
function medium({ hacking = 3000, money = 0, daemon = "rooted" as "rooted" | "unrooted" | "absent" } = {}) {
  return {
    player: {
      skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      exp: { hacking: expFor(hacking) },
      mults: { faction_rep: 1, hacking: 1 },
      money,
      city: "Sector-12",
    },
    hasTorRouter: true,
    programs: [],
    servers:
      daemon === "absent" ? [] : [{ hostname: DAEMON, maxRam: 0, cpuCores: 1, hasAdminRights: daemon === "rooted" }],
  } as unknown as MediumSnapshotData;
}

/** A slow snapshot: the installed augmentations, Daedalus's reputation if joined, the queue and the BitNode's reset. */
function slow({
  ownedAugs = { ...THIRTY, [RED_PILL]: 1 } as Record<string, number>,
  daedalus = null as number | null,
  invited = false,
  queued = [] as string[],
  lastNodeReset = 0,
  ownedSF = {} as Record<string, number>,
  currentNode = 1,
  lastAugReset = 0,
} = {}): SlowSnapshotData {
  return {
    resetInfo: { lastAugReset, lastNodeReset, currentNode, ownedAugs, ownedSF, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: "sim",
      state: {
        joined: daedalus === null ? [] : [{ name: "Daedalus", reputation: daedalus, favor: 0 }],
        invitations: invited ? ["Daedalus"] : [],
        queuedAugmentations: queued,
      },
      problem: null,
    },
  } as SlowSnapshotData;
}

let lines: string[];
let events: WorldDaemonEvent[];
let rule: WorldDaemonRule;
beforeEach(() => {
  lines = [];
  events = [];
  rule = new WorldDaemonRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
});

const update = (fields: Partial<Parameters<WorldDaemonRule["update"]>[0]> = {}) =>
  rule.update({
    staticData: staticData(),
    mediumData: medium(),
    mediumGameTimeMs: 1_000,
    slowData: slow(),
    nowMs: 1_000,
    enabled: true,
    ...fields,
  });

describe("the path", () => {
  test("before Daedalus: its count, money and hacking short, worded; The Red Pill's Daedalus not joined", () => {
    const path = worldDaemonPath({
      staticData: staticData(),
      mediumData: medium({ hacking: 2000, money: 5e9 }),
      slowData: slow({ ownedAugs: { [ONE]: 1 } }),
      expPerSecond: null,
    });
    expect(path.daedalus).toEqual({
      joined: false,
      invited: false,
      augmentations: 1,
      augmentationsRequired: 30,
      missing: [
        "1 of 30 augmentations installed",
        "$5,000,000,000 of $100,000,000,000",
        "hacking 2,000 of 2,500 (or every combat skill 1,500)",
      ],
      // Short (#228); within reach, the hacker factions' (A3's backdoors bring them) and Tian Di Hui's at hacking 50
      // (its NeuroFlux Governor is the one installed: counted once); no city group chosen.
      short: true,
      reach: {
        more: 32,
        by: [
          { faction: "CyberSec", count: 5 },
          { faction: "NiteSec", count: 7 },
          { faction: "The Black Hand", count: 6 },
          { faction: "BitRunners", count: 6 },
          { faction: "Tian Di Hui", count: 8 },
        ],
      },
      needs: ["$5,000,000,000 of $100,000,000,000", "hacking 2,000 of 2,500 (or every combat skill 1,500)"],
    });
    expect(path.daemon).toBeNull();
    // The count said once (#228), with the reach.
    expect(describeWorldDaemonPath(path)).toEqual([
      "Daedalus: not joined; 1 of 30 augmentations installed, 32 more within reach (CyberSec 5, NiteSec 7, The Black " +
        "Hand 6, BitRunners 6, Tian Di Hui 8); needs $5,000,000,000 of $100,000,000,000, hacking 2,000 of 2,500 (or every combat skill 1,500)",
      "The Red Pill: Daedalus not joined",
    ]);
  });

  test("Daedalus joined: The Red Pill's reputation, the work's rate and ETA; reached; queued", () => {
    const short = worldDaemonPath({
      staticData: staticData(),
      mediumData: medium({ hacking: 2600, money: 200e9 }),
      slowData: slow({ ownedAugs: THIRTY, daedalus: 1e6 }),
      expPerSecond: null,
    });
    expect(short.redPill).toMatchObject({ installed: false, queued: false, reputation: 1e6, reputationNeeded: 2.5e6 });
    expect(short.redPill?.etaSeconds).toBeCloseTo(1.5e6 / (short.redPill?.perSecond as number), 6);
    expect(describeWorldDaemonPath(short)[1]).toMatch(
      /^The Red Pill: Daedalus's reputation 1,000,000 of 2,500,000 at /,
    );
    const reached = worldDaemonPath({
      staticData: staticData(),
      mediumData: medium({ hacking: 2600 }),
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
      expPerSecond: null,
    });
    expect(describeWorldDaemonPath(reached)[1]).toBe(
      "The Red Pill: Daedalus's reputation 2,500,000 of 2,500,000, reached: to buy and install",
    );
    const queued = worldDaemonPath({
      staticData: staticData(),
      mediumData: medium({ hacking: 2600 }),
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6, queued: [RED_PILL] }),
      expPerSecond: null,
    });
    expect(describeWorldDaemonPath(queued)[1]).toBe("The Red Pill: queued, to install");
  });

  test("The Red Pill installed: w0r1d_d43m0n's root and hacking against its requirement, with the ETA", () => {
    const path = worldDaemonPath({
      staticData: staticData(),
      mediumData: medium({ hacking: 2000, daemon: "unrooted" }),
      slowData: slow(),
      expPerSecond: 1e6,
    });
    expect(path.daedalus).toBeNull();
    expect(path.daemon).toMatchObject({
      reachable: true,
      rooted: false,
      hackingLevel: 2000,
      requiredHackingLevel: 3000,
      problem: "no root access on w0r1d_d43m0n (NUKE.exe first)",
    });
    expect(path.daemon?.etaSeconds).toBeCloseTo((expFor(3000) - expFor(2000)) / 1e6, 0);
    expect(describeWorldDaemonPath(path)).toEqual([
      "The Red Pill: installed",
      `w0r1d_d43m0n: not rooted; hacking 2,000 of 3,000: about ${((expFor(3000) - expFor(2000)) / 1e6 / 3600).toFixed(1)} h ` +
        "at the measured experience rate",
    ]);
    // A BitNode's difficulty is the static snapshot's requirement; reached, it says so.
    const reached = worldDaemonPath({
      staticData: staticData(1500),
      mediumData: medium({ hacking: 1500 }),
      slowData: slow(),
      expPerSecond: null,
    });
    expect(describeWorldDaemonPath(reached)[1]).toBe("w0r1d_d43m0n: rooted; hacking 1,500 of 1,500, reached");
    expect(reached.daemon?.problem).toBeNull();
  });

  test("the ETA: at the multiplier the level and experience imply; 0 reached; null unmeasured", () => {
    // Hacking ×2: level 2000 at the experience level 1000 takes at ×1.
    const hacking = { level: 2000, exp: expFor(1000) };
    expect(hackingEtaSeconds(hacking, 3000, 100)).toBeCloseTo((expFor(1500) - expFor(1000)) / 100, 0);
    expect(hackingEtaSeconds(hacking, 2000, 100)).toBe(0);
    expect(hackingEtaSeconds(hacking, 3000, null)).toBeNull();
    expect(hackingEtaSeconds(hacking, 3000, 0)).toBeNull();
  });

  test("the experience rate: over the window, a gap or a fall (an install) starting it again", () => {
    const rate = new HackingExpRate();
    rate.add(0, 0);
    rate.add(30_000, 3_000);
    expect(rate.perSecond()).toBeNull();
    rate.add(60_000, 6_000);
    expect(rate.perSecond()).toBe(100);
    rate.add(60_000 + 4 * MINUTE, 7_000);
    expect(rate.perSecond()).toBeNull();
    rate.add(60_000 + 5 * MINUTE, 7_600);
    expect(rate.perSecond()).toBe(10);
    rate.add(60_000 + 6 * MINUTE, 0);
    expect(rate.perSecond()).toBeNull();
  });
});

describe("the destroy", () => {
  test("asked for once w0r1d_d43m0n is rooted at its level, logged; not before", () => {
    expect(update({ mediumData: medium({ hacking: 2999 }) })).toBe(false);
    expect(update({ mediumData: medium({ daemon: "unrooted" }) })).toBe(false);
    expect(update({ mediumData: medium({ daemon: "absent" }) })).toBe(false);
    expect(update({ slowData: slow({ ownedAugs: THIRTY }) })).toBe(false);
    expect(update({ enabled: false })).toBe(false);
    expect(update()).toBe(true);
    expect(rule.view()).toMatchObject({ enabled: true, destroying: true });
    expect(lines).toEqual([
      "world daemon: w0r1d_d43m0n rooted at hacking 3000: destroying the BitNode, into BitNode 1 (the gate, then a " +
        "save backup first)",
    ]);
    expect(WORLD_DAEMON_DESTROY_INTENT).toEqual({
      id: "destroyBitNode(1)",
      action: "destroyBitNode",
      args: { nextBitNode: 1 },
    });
  });

  test("held until a slow snapshot shows another lastNodeReset: across the Agent going (no snapshots)", () => {
    expect(update()).toBe(true);
    expect(update({ staticData: null, mediumData: null, slowData: null })).toBe(true);
    // The next BitNode's: The Red Pill gone, the reset moved.
    expect(
      update({ slowData: slow({ ownedAugs: {}, lastNodeReset: 5_000 }), mediumData: medium({ hacking: 1 }) }),
    ).toBe(false);
    expect(rule.view().destroying).toBe(false);
  });

  test("the switch off withdraws it", () => {
    expect(update()).toBe(true);
    expect(update({ enabled: false })).toBe(false);
  });
});

describe("stalls", () => {
  test("ready to destroy, not destroyed 5 minutes on: the event, the log line, the alert's; once", () => {
    update({ mediumData: medium({ daemon: "unrooted" }), nowMs: 0 });
    update({ mediumData: medium({ daemon: "unrooted" }), nowMs: WORLD_DAEMON_STALLED_AFTER_MS - 1 });
    expect(rule.stall()).toBeNull();
    update({ mediumData: medium({ daemon: "unrooted" }), nowMs: WORLD_DAEMON_STALLED_AFTER_MS });
    const detail =
      "w0r1d_d43m0n at its level (hacking 3,000 of 3,000), the BitNode not destroyed: no root access on " +
      "w0r1d_d43m0n (NUKE.exe first)";
    expect(rule.stall()).toEqual({ step: "destroy", sinceMs: 0, detail });
    expect(events).toEqual([
      { type: "worldDaemonStalled", atMs: WORLD_DAEMON_STALLED_AFTER_MS, step: "destroy", sinceMs: 0, detail },
    ]);
    expect(lines.at(-1)).toBe(`world daemon: STALLED 5 min: ${detail}`);
    update({ mediumData: medium({ daemon: "unrooted" }), nowMs: 2 * WORLD_DAEMON_STALLED_AFTER_MS });
    expect(events).toHaveLength(1);
    // Off, the destroy is the owner's: no stall.
    update({ mediumData: medium({ daemon: "unrooted" }), nowMs: 3 * WORLD_DAEMON_STALLED_AFTER_MS, enabled: false });
    expect(rule.stall()).toBeNull();
  });

  test("Daedalus's requirements met and not joined; The Red Pill reached and not installed", () => {
    const met = { mediumData: medium({ hacking: 2600, money: 200e9 }) };
    update({ ...met, slowData: slow({ ownedAugs: THIRTY, invited: true }), nowMs: 0 });
    update({ ...met, slowData: slow({ ownedAugs: THIRTY, invited: true }), nowMs: WORLD_DAEMON_STALLED_AFTER_MS });
    expect(rule.stall()).toMatchObject({
      step: "daedalus",
      detail: "Daedalus's requirements met, not joined (invited)",
    });
    // Joined: that's over; The Red Pill reached starts its own, 15 minutes for A6's whole commit (#215 review).
    const reachedAt = 2 * WORLD_DAEMON_STALLED_AFTER_MS;
    update({ ...met, slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }), nowMs: reachedAt });
    expect(rule.stall()).toBeNull();
    update({
      ...met,
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
      nowMs: reachedAt + RED_PILL_INSTALL_STALLED_AFTER_MS - 1,
    });
    expect(rule.stall()).toBeNull();
    update({
      ...met,
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
      nowMs: reachedAt + RED_PILL_INSTALL_STALLED_AFTER_MS,
    });
    expect(rule.stall()).toMatchObject({ step: "redPill", detail: "The Red Pill reached, not installed" });
    expect(events.map((event) => (event.type === "worldDaemonStalled" ? event.step : event.type))).toEqual([
      "daedalus",
      "redPill",
    ]);
  });

  test("The Red Pill short, Daedalus's reputation not rising 10 minutes: loud, as A6 holds every install meanwhile", () => {
    expect(RED_PILL_REPUTATION_STALLED_AFTER_MS).toBe(10 * MINUTE);
    expect(RED_PILL_INSTALL_STALLED_AFTER_MS).toBe(15 * MINUTE);
    const at = (reputation: number, nowMs: number) =>
      update({
        mediumData: medium({ hacking: 2600 }),
        slowData: slow({ ownedAugs: THIRTY, daedalus: reputation }),
        nowMs,
      });
    at(1e6, 0);
    at(1e6, RED_PILL_REPUTATION_STALLED_AFTER_MS - 1);
    expect(rule.stall()).toBeNull();
    // Risen: watched from then.
    at(1.1e6, RED_PILL_REPUTATION_STALLED_AFTER_MS - 1);
    at(1.1e6, 2 * RED_PILL_REPUTATION_STALLED_AFTER_MS - 2);
    expect(rule.stall()).toBeNull();
    at(1.1e6, 2 * RED_PILL_REPUTATION_STALLED_AFTER_MS - 1);
    const detail =
      "The Red Pill's reputation at Daedalus not rising (1,100,000 of 2,500,000): no install is chosen meanwhile, so " +
      "nothing earning it stalls A6";
    expect(rule.stall()).toEqual({
      step: "redPillReputation",
      sinceMs: RED_PILL_REPUTATION_STALLED_AFTER_MS - 1,
      detail,
    });
    expect(events).toEqual([
      {
        type: "worldDaemonStalled",
        atMs: 2 * RED_PILL_REPUTATION_STALLED_AFTER_MS - 1,
        step: "redPillReputation",
        sinceMs: RED_PILL_REPUTATION_STALLED_AFTER_MS - 1,
        detail,
      },
    ]);
    // Rising again: over, and a later stall is stored afresh.
    at(1.2e6, 2 * RED_PILL_REPUTATION_STALLED_AFTER_MS);
    expect(rule.stall()).toBeNull();
  });
});

describe("a replay at Source-File 1's cap (#311)", () => {
  const REPLAY = "Source-File 1 is at 3, nothing to gain but the run";

  test("replayOf: BitNode 1 into BitNode 1 with Source-File 1 at 3, and only that", () => {
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 3 } }, 1)).toBe(REPLAY);
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 3, 4: 1 } }, 1)).toBe(REPLAY);
    // Below the cap: a Source-File level gained.
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 2 } }, 1)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: {} }, 1)).toBeNull();
    // Another BitNode destroyed (its own Source-File gained), or another entered: not a replay of BitNode 1.
    expect(replayOf({ currentNode: 2, ownedSF: { 1: 3 } }, 1)).toBeNull();
    expect(replayOf({ currentNode: 3, ownedSF: { 1: 3 } }, 1)).toBeNull();
    expect(replayOf({ ownedSF: { 1: 3 } }, 1)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 3 } }, 2)).toBeNull();
    // Not read: not said.
    expect(replayOf(undefined, 1)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: { 1: "3" } }, 1)).toBeNull();
  });

  test("the destroy goes ahead at the cap: asked for, logged as a replay, no stall; the view says it", () => {
    const atThree = { slowData: slow({ ownedSF: { 1: 3 } }) };
    expect(update({ ...atThree, nowMs: 0 })).toBe(true);
    // No stall at once (the refusal before #311 was one): only the destroy's own, 5 minutes on, if it doesn't go.
    expect(update({ ...atThree, nowMs: MINUTE })).toBe(true);
    expect(lines).toEqual([
      "world daemon: w0r1d_d43m0n rooted at hacking 3000: destroying the BitNode, into BitNode 1, a replay (Source-File " +
        "1 is at 3, nothing to gain but the run) (the gate, then a save backup first)",
    ]);
    expect(events).toEqual([]);
    expect(rule.view()).toMatchObject({ destroying: true, replay: REPLAY, stall: null });
    // Below the cap, the view says no replay.
    update({ slowData: slow({ ownedSF: { 1: 2 } }) });
    expect(rule.view().replay).toBeNull();
    // Kept across the Agent gone (no snapshots).
    update({ ...atThree });
    update({ staticData: null, mediumData: null, slowData: null });
    expect(rule.view().replay).toBe(REPLAY);
  });

  test("a replay not through 5 minutes on: the destroy step's stall, as below the cap", () => {
    const atThree = { slowData: slow({ ownedSF: { 1: 3 } }) };
    update({ ...atThree, nowMs: 0 });
    update({ ...atThree, nowMs: WORLD_DAEMON_STALLED_AFTER_MS - 1 });
    expect(rule.stall()).toBeNull();
    update({ ...atThree, nowMs: WORLD_DAEMON_STALLED_AFTER_MS });
    const detail = "w0r1d_d43m0n at its level (hacking 3,000 of 3,000), the BitNode not destroyed";
    expect(rule.stall()).toEqual({ step: "destroy", sinceMs: 0, detail });
    expect(events).toEqual([
      { type: "worldDaemonStalled", atMs: WORLD_DAEMON_STALLED_AFTER_MS, step: "destroy", sinceMs: 0, detail },
    ]);
    expect(lines.at(-1)).toBe(`world daemon: STALLED 5 min: ${detail}`);
  });

  test("the start line's words: off, on, or on and a replay as the last slow snapshot shows the game", () => {
    expect(describeWorldDaemonSwitch(false, slow({ ownedSF: { 1: 3 } }))).toBe("off");
    expect(describeWorldDaemonSwitch(true, null)).toBe("on");
    expect(describeWorldDaemonSwitch(true, slow({ ownedSF: { 1: 2 } }))).toBe("on");
    expect(describeWorldDaemonSwitch(true, { resetInfo: "odd" })).toBe("on");
    expect(describeWorldDaemonSwitch(true, slow({ ownedSF: { 1: 3 } }))).toBe(`on (it replays BitNode 1: ${REPLAY})`);
  });
});

describe("a restarted brain", () => {
  test("its destroy restored from the reset note: held with no snapshots, over at another lastNodeReset", () => {
    rule.restore(0);
    expect(update({ staticData: null, mediumData: null, slowData: null })).toBe(true);
    expect(update({ slowData: slow({ lastNodeReset: 0 }), mediumData: medium({ hacking: 1 }) })).toBe(true);
    expect(
      update({ slowData: slow({ ownedAugs: {}, lastNodeReset: 5_000 }), mediumData: medium({ hacking: 1 }) }),
    ).toBe(false);
  });
});

describe("Daedalus count stuck (#228, #238)", () => {
  const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
  const NFG = "NeuroFlux Governor";
  /** Run #2's 23: the four hacker factions' set with a hacking value, and NeuroFlux Governor at `level`. */
  const runTwo = (level: number, more: string[] = []): Record<string, number> => ({
    ...Object.fromEntries(
      [...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))]
        .filter((name) => isWorthInstalling(name))
        .map((name) => [name, 1]),
    ),
    ...Object.fromEntries(more.map((name) => [name, 1])),
    [NFG]: level,
  });
  const stateOf = (installed: Record<string, number>) => ({
    installed,
    queued: [],
    sourceFile11Level: 0,
    bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
  });
  /** A NeuroFlux Governor level's price over `installed`: run #2's money left after its empty set, at least that. */
  const levelPrice = (installed: Record<string, number>) => augmentationCost(NFG, stateOf(installed)).money;
  /**
   * Run #2's commits (A6 then bought only hacking value): the four joined with the reputation for all they sell, so
   * what they sell not installed is within reach (core's `countablesWithinReach`), and a NeuroFlux Governor level's
   * money left after the set.
   */
  const runTwoFacts = (installed: Record<string, number>): CountFacts => ({
    moneyAfterSet: levelPrice(installed),
    within: countablesWithinReach({
      reached: HACKERS.flatMap((faction) =>
        augmentationsSoldBy(faction, 1, null).map((augmentation) => ({ augmentation, faction })),
      ),
      state: stateOf(installed),
    }),
  });
  /**
   * A cycle's slow snapshot: NeuroFlux Governor queued for the install that ends it, unless `queued` says else; A6's
   * commit's facts, run #2's unless `countFacts` says else; A6 not asking for the install unless `installing`.
   */
  const cycle = (
    install: number,
    ownedAugs: Record<string, number>,
    invited = false,
    queued = [NFG],
    countFacts: CountFacts | null = runTwoFacts(ownedAugs),
    installing = false,
  ) => ({
    mediumData: medium({ hacking: 6_368, money: 1e12 }),
    slowData: slow({ ownedAugs, lastAugReset: install * 10 * MINUTE, invited, queued }),
    countFacts,
    augmentationsInstalling: installing,
  });
  const dollars = (money: number) => `$${Math.round(money).toLocaleString("en-US")}`;
  const STUCK_AT_23 =
    "Daedalus count stuck: an install at 23 of 30 augmentations installed added none to the count (NeuroFlux " +
    "Governor's levels count once), ";
  /** Run #2's failure at an install from `level`: the two no-value ones the four sold, passed over. */
  const detail = (level: number) =>
    `${STUCK_AT_23}passing over Neural Wit Amplifier (BitRunners, $10,000,000), Magnetism Amplifier (The Black Hand, ` +
    `$250,000,000), which the money left after the set (${dollars(levelPrice(runTwo(level)))}) would have bought`;
  const neuroFluxOnly = () => events.filter((event) => event.type === "daedalusCountNeuroFluxOnly");
  const ONLY_AT_23 = "installed NeuroFlux Governor only at 23 of 30 augmentations installed: ";

  test("run #2's nine NeuroFlux-only installs at 23, two that count passed over: each one fails, at once", () => {
    expect(Object.keys(runTwo(1))).toHaveLength(23);
    expect(runTwoFacts(runTwo(115)).within.map((each) => each.augmentation)).toEqual([
      "Neural Wit Amplifier",
      "Magnetism Amplifier",
    ]);
    update({ ...cycle(0, runTwo(115)), nowMs: 0 });
    expect(rule.stall()).toBeNull();
    for (let install = 1; install <= 9; install++) {
      // At the install A6's note is gone (the game reset): judged on its facts before it, then the next commit's.
      update({ ...cycle(install, runTwo(115 + install), false, [NFG], null), nowMs: install * 10 * MINUTE });
      update({ ...cycle(install, runTwo(115 + install)), nowMs: install * 10 * MINUTE + MINUTE });
    }
    const stuck = events.filter((event) => event.type === "worldDaemonStalled" && event.step === "daedalusCount");
    expect(stuck).toHaveLength(9);
    expect(stuck[0]).toEqual({
      type: "worldDaemonStalled",
      atMs: 10 * MINUTE,
      step: "daedalusCount",
      sinceMs: 10 * MINUTE,
      detail: detail(115),
    });
    expect(rule.stall()).toEqual({ step: "daedalusCount", sinceMs: 90 * MINUTE, detail: detail(123) });
    expect(lines.at(-1)).toBe(`world daemon: STALLED 0 min: ${detail(123)}`);
    expect(neuroFluxOnly()).toEqual([]);
  });

  test("the early NeuroFlux-only install (CyberSec's five, nothing else within reach): information, not a failure", () => {
    const SIX = { ...Object.fromEntries(augmentationsSoldBy("CyberSec", 1, null).map((name) => [name, 1])), [NFG]: 1 };
    expect(Object.keys(SIX)).toHaveLength(6);
    update({ ...cycle(1, SIX, false, Array(13).fill(NFG), { moneyAfterSet: 5e9, within: [] }, true), nowMs: 0 });
    update({ ...cycle(2, { ...SIX, [NFG]: 14 }, false, [], null), nowMs: 10 * MINUTE });
    expect(rule.stall()).toBeNull();
    expect(events.filter((event) => event.type === "worldDaemonStalled")).toEqual([]);
    const said =
      "installed NeuroFlux Governor only at 6 of 30 augmentations installed: nothing that counts within reach";
    expect(neuroFluxOnly()).toEqual([
      {
        type: "daedalusCountNeuroFluxOnly",
        atMs: 10 * MINUTE,
        installed: 6,
        required: 30,
        countFacts: { moneyAfterSet: 5e9, within: [] },
        detail: said,
      },
    ]);
    expect(lines).toEqual([`world daemon: ${said}`]);
    // Once an install: the next update with the same lastAugReset judges nothing.
    update({ ...cycle(2, { ...SIX, [NFG]: 14 }), nowMs: 11 * MINUTE });
    expect(neuroFluxOnly()).toHaveLength(1);
  });

  test("the money decides: one costing more than the money left after the set isn't stuck; as much is", () => {
    const within = [{ augmentation: "Neurotrainer II", faction: "NiteSec", money: 45e6 }];
    // $1 short: information, naming the cheapest within reach.
    update({ ...cycle(0, runTwo(1), false, [NFG], { moneyAfterSet: 45e6 - 1, within }), nowMs: 0 });
    update({ ...cycle(1, runTwo(2)), nowMs: 10 * MINUTE });
    expect(rule.stall()).toBeNull();
    expect(neuroFluxOnly().map((event) => event.detail)).toEqual([
      `${ONLY_AT_23}nothing that counts within its money: the cheapest within reach, Neurotrainer II (NiteSec, ` +
        "$45,000,000), costs more than the $44,999,999 left after the set",
    ]);
    // As much as was left: A6's set should have taken it, so stuck.
    update({ ...cycle(1, runTwo(2), false, [NFG], { moneyAfterSet: 45e6, within }), nowMs: 15 * MINUTE });
    update({ ...cycle(2, runTwo(3)), nowMs: 20 * MINUTE });
    expect(rule.stall()?.detail).toBe(
      `${STUCK_AT_23}passing over Neurotrainer II (NiteSec, $45,000,000), which the money left after the set ` +
        "($45,000,000) would have bought",
    );
  });

  test("the band (#238 review): dearer than the levels took, within the money left after the set: stuck", () => {
    // $10m left after an empty set: three levels take $6,718,210 (750k × 1.14ᵏ × 1.9ᵏ⁻¹, k 1 to 3), the fourth would be
    // $8.7m more. One at $9m, 1.3 times the levels' money, was A6's to buy.
    const within = [{ augmentation: "Speech Enhancement", faction: "Tian Di Hui", money: 9e6 }];
    update({ ...cycle(0, runTwo(1), false, [NFG], { moneyAfterSet: 10e6, within }), nowMs: 0 });
    update({ ...cycle(1, runTwo(2)), nowMs: 10 * MINUTE });
    expect(rule.stall()?.detail).toBe(
      `${STUCK_AT_23}passing over Speech Enhancement (Tian Di Hui, $9,000,000), which the money left after the set ` +
        "($10,000,000) would have bought",
    );
  });

  test("past three passed over, how many more; only those the money covered are named", () => {
    const at = (augmentation: string, money: number) => ({ augmentation, faction: "Tian Di Hui", money });
    const within = [
      at("Wired Reflexes", 2.5e6),
      at("Speech Enhancement", 12.5e6),
      at("Nuoptimal Nootropic Injector Implant", 20e6),
      at("Speech Processor Implant", 50e6),
      at("Nanofiber Weave", 125e6),
    ];
    update({ ...cycle(0, runTwo(1), false, [NFG], { moneyAfterSet: 60e6, within }), nowMs: 0 });
    update({ ...cycle(1, runTwo(2)), nowMs: 10 * MINUTE });
    expect(rule.stall()?.detail).toBe(
      `${STUCK_AT_23}passing over Wired Reflexes (Tian Di Hui, $2,500,000), Speech Enhancement (Tian Di Hui, ` +
        "$12,500,000), Nuoptimal Nootropic Injector Implant (Tian Di Hui, $20,000,000) and 1 more, which the money " +
        "left after the set ($60,000,000) would have bought",
    );
  });

  test("an install with no facts from A6's commit, A6 not installing (yours, the switch off): not judged", () => {
    update({ ...cycle(0, runTwo(1), false, [NFG], null), nowMs: 0 });
    update({ ...cycle(1, runTwo(2), false, [NFG], null), nowMs: 10 * MINUTE });
    expect(rule.stall()).toBeNull();
    expect(neuroFluxOnly().map((event) => event.detail)).toEqual([
      `${ONLY_AT_23}no facts from A6's commit (yours, the switch off, or an earlier brain's), so not judged`,
    ]);
  });

  test("A6's own install with no facts from its commit (#238 review): stuck, as it can't be judged clean", () => {
    update({ ...cycle(0, runTwo(1), false, [NFG], null, true), nowMs: 0 });
    update({ ...cycle(1, runTwo(2), false, [NFG], null), nowMs: 10 * MINUTE });
    expect(rule.stall()?.detail).toBe(
      `${STUCK_AT_23}A6's install, with no facts from its commit of what counts within reach`,
    );
    expect(neuroFluxOnly()).toEqual([]);
  });

  test("an install that adds to the count is quiet, and ends the last one's failure; so is one not short", () => {
    // Run #2's: NeuroFlux Governor's levels at 116, dear enough to have bought both passed over.
    update({ ...cycle(0, runTwo(116)), nowMs: 0 });
    update({ ...cycle(1, runTwo(117)), nowMs: 10 * MINUTE });
    expect(rule.stall()).toMatchObject({ step: "daedalusCount" });
    // The simulator suite's install: Tian Di Hui's eight and two more, 23 to 33.
    const tenMore = [...augmentationsSoldBy("Tian Di Hui", 1, null), "Neural Wit Amplifier", "Magnetism Amplifier"];
    update({ ...cycle(2, runTwo(118, tenMore)), nowMs: 20 * MINUTE });
    expect(rule.stall()).toBeNull();
    // Daedalus inviting before an install: not short, so nothing to judge.
    update({ ...cycle(3, runTwo(118), true), nowMs: 30 * MINUTE });
    update({ ...cycle(4, runTwo(119), true), nowMs: 40 * MINUTE });
    expect(rule.stall()).toBeNull();
    expect(events.filter((event) => event.type === "worldDaemonStalled")).toHaveLength(1);
    expect(neuroFluxOnly()).toEqual([]);
  });

  test("a reset with nothing queued before it (a soft reset, an older save) isn't an install: quiet", () => {
    update({ ...cycle(0, runTwo(116), false, []), nowMs: 0 });
    update({ ...cycle(1, runTwo(116), false, []), nowMs: 10 * MINUTE });
    expect(rule.stall()).toBeNull();
    expect(neuroFluxOnly()).toEqual([]);
    // With something queued, the same reset is an install, and stuck.
    update({ ...cycle(1, runTwo(116)), nowMs: 15 * MINUTE });
    update({ ...cycle(2, runTwo(117)), nowMs: 20 * MINUTE });
    expect(rule.stall()).toMatchObject({ step: "daedalusCount" });
  });

  test("the path's line: the reach, counting the city group chosen", () => {
    const path = (cityGroup: string | null) =>
      describeWorldDaemonPath(
        worldDaemonPath({ staticData: staticData(), ...cycle(0, runTwo(124)), expPerSecond: null, cityGroup }),
      )[0];
    expect(path(null)).toBe(
      "Daedalus: not joined; 23 of 30 augmentations installed, 10 more within reach (The Black Hand 1, BitRunners 1, " +
        "Tian Di Hui 8)",
    );
    expect(path("B")).toBe(
      "Daedalus: not joined; 23 of 30 augmentations installed, 15 more within reach (The Black Hand 1, BitRunners 1, " +
        "Tian Di Hui 8, Chongqing 1, New Tokyo 1, Ishima 3)",
    );
  });

  test("the run report: stuck a failure, said as such, at the install it saw; NeuroFlux only, section 3's line", () => {
    const failures: string[] = [];
    const DETAIL = detail(115);
    const stored = {
      atMs: 10 * MINUTE,
      kind: "worldDaemonStalled",
      detail: { step: "daedalusCount", sinceMs: 10 * MINUTE, detail: DETAIL },
    };
    const said =
      "installed NeuroFlux Governor only at 6 of 30 augmentations installed: nothing that counts within reach";
    const information = { atMs: 20 * MINUTE, kind: "daedalusCountNeuroFluxOnly", detail: { detail: said } };
    const fold = new WorldDaemonFold();
    const health = fold.healthLines([stored, information] as never, {
      failures,
      warnings: [],
      formatTime: (ms) => `t${ms}`,
      bitNodeAt: () => 0,
    });
    expect(health[1]).toBe(`    ${DETAIL}, seen at t${10 * MINUTE}`);
    expect(health).toHaveLength(2);
    expect(failures).toEqual([`${DETAIL}, seen at t${10 * MINUTE}`]);
    const path = fold.pathLines(
      { staticLast: undefined, mediumLast: undefined, slowLast: undefined },
      [stored, information] as never,
      (ms) => `t${ms}`,
    );
    expect(path.at(-1)).toBe(`    t${20 * MINUTE}  ${said}`);
    expect(WORLD_DAEMON_EVENT_KINDS).toContain("daedalusCountNeuroFluxOnly");
  });
});

test("the Agent gone: a step's clock not yet stored starts again with the snapshots (#228 review), the time away left out", () => {
  const met = {
    mediumData: medium({ hacking: 2600, money: 200e9 }),
    slowData: slow({ ownedAugs: THIRTY, invited: true }),
  };
  update({ ...met, nowMs: 0 });
  update({ ...met, mediumData: null, nowMs: MINUTE });
  update({ ...met, nowMs: 4 * MINUTE });
  update({ ...met, nowMs: 4 * MINUTE + WORLD_DAEMON_STALLED_AFTER_MS - 1 });
  expect(rule.stall()).toBeNull();
  update({ ...met, nowMs: 4 * MINUTE + WORLD_DAEMON_STALLED_AFTER_MS });
  expect(rule.stall()).toMatchObject({ step: "daedalus", sinceMs: 4 * MINUTE });
});

test("the Agent gone: The Red Pill's reputation clock starts again too, the time away left out (#228 re-review)", () => {
  const at = (nowMs: number, slowData: SlowSnapshotData | null = slow({ ownedAugs: THIRTY, daedalus: 1e6 })) =>
    update({ mediumData: medium({ hacking: 2600 }), slowData, nowMs });
  at(0);
  at(MINUTE, null);
  at(30 * MINUTE);
  at(30 * MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS - 1);
  expect(rule.stall()).toBeNull();
  at(30 * MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS);
  expect(rule.stall()).toMatchObject({ step: "redPillReputation", sinceMs: 30 * MINUTE });
});
