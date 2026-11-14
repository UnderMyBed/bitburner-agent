// The World Daemon (#215): the path read from snapshot data as the Agent sends it, the destroy asked for once
// w0r1d_d43m0n is ready and held until the reset, and the stalls.
import {
  AUGMENTATION_NAMES,
  augmentationCost,
  augmentationsSoldBy,
  chooseWinRoute,
  climbRiseLowerBound,
  climbWindowSeconds,
  countablesWithinReach,
  isWorthInstalling,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import type { CountFacts } from "../src/augmentations.ts";
import type { BlackOpsRouteView } from "../src/bladeburner-route.ts";
import {
  describeWorldDaemonPath,
  describeWorldDaemonSwitch,
  HackingExpRate,
  hackingEtaSeconds,
  NEXT_UNREAD,
  RED_PILL_INSTALL_STALLED_AFTER_MS,
  RED_PILL_REPUTATION_STALLED_AFTER_MS,
  replayOf,
  skippedOf,
  WORLD_DAEMON_STALLED_AFTER_MS,
  type WorldDaemonEvent,
  WorldDaemonRule,
  worldDaemonDestroyIntent,
  worldDaemonDestroyInto,
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

  test("Bladeburner's rank a second (#398): a fall (a Black Op's failure) is measured, not a restart; a gap still is", () => {
    const rank = new HackingExpRate({ fallsCount: true });
    rank.add(0, 1_000);
    rank.add(MINUTE, 1_120);
    rank.add(2 * MINUTE, 1_020);
    expect(rank.perSecond()).toBeCloseTo(20 / 120, 12);
    rank.add(2 * MINUTE + 4 * MINUTE, 1_100);
    expect(rank.perSecond()).toBeNull();
  });

  test("the window full (#378's review): its samples spanning the 10 minutes, kept so; a fall starts it again", () => {
    const rate = new HackingExpRate();
    for (let minute = 0; minute <= 9; minute++) rate.add(minute * MINUTE, minute * 100);
    expect(rate.perSecond()).not.toBeNull();
    expect(rate.windowFull()).toBe(false);
    rate.add(10 * MINUTE - 1, 999);
    expect(rate.windowFull()).toBe(false);
    rate.add(10 * MINUTE, 1_000);
    expect(rate.windowFull()).toBe(true);
    rate.add(11 * MINUTE, 1_100);
    expect(rate.windowFull()).toBe(true);
    rate.add(12 * MINUTE, 0);
    expect(rate.windowFull()).toBe(false);
  });
});

describe("the destroy", () => {
  test("asked for once w0r1d_d43m0n is rooted at its level, logged; not before", () => {
    expect(update({ mediumData: medium({ hacking: 2999 }) })).toBe(false);
    expect(update({ mediumData: medium({ daemon: "unrooted" }) })).toBe(false);
    expect(update({ mediumData: medium({ daemon: "absent" }) })).toBe(false);
    expect(update({ slowData: slow({ ownedAugs: THIRTY }) })).toBe(false);
    expect(update({ enabled: false })).toBe(false);
    expect(rule.destroyIntent()).toBeNull();
    // BN1.1 (no Source-Files): the campaign's order's next is BN4 (#321).
    expect(update()).toBe(true);
    expect(rule.view()).toMatchObject({ enabled: true, destroying: true, nextBitNode: 4, replay: null, skipped: null });
    expect(lines).toEqual([
      "world daemon: w0r1d_d43m0n rooted at hacking 3000: destroying the BitNode, into BitNode 4 (the gate, then a " +
        "save backup first)",
    ]);
    expect(rule.destroyIntent()).toEqual({
      id: "destroyBitNode(4)",
      action: "destroyBitNode",
      args: { nextBitNode: 4 },
    });
  });

  test("into the BitNode the campaign's order gives (#321), fixed once asked for, though the snapshot changes", () => {
    // BN4.3 with SF1 at 3: SF4 reaches 3 by this destroy, so BN5 (#323), nothing skipped before it.
    const bn43 = { slowData: slow({ currentNode: 4, ownedSF: { 1: 3, 4: 2 } }) };
    expect(update(bn43)).toBe(true);
    expect(rule.destroyIntent()).toEqual(worldDaemonDestroyIntent(5));
    expect(rule.view()).toMatchObject({ nextBitNode: 5, replay: null, skipped: null });
    expect(lines.at(-1)).toContain("destroying the BitNode, into BitNode 5 (the gate,");
    // A slow snapshot of the same BitNode saying otherwise (an odd one): the ask keeps its BitNode.
    expect(update({ slowData: slow({ currentNode: 4, ownedSF: { 1: 3, 4: 1 } }) })).toBe(true);
    expect(rule.destroyIntent()).toEqual(worldDaemonDestroyIntent(5));
    expect(rule.view()).toMatchObject({ nextBitNode: 5, replay: null, skipped: null });
  });

  test("past the BitNodes the brain can't play yet (#323): BN2.3 into BN5 again, the skipped logged and in the view", () => {
    const skipped =
      "BN6 skipped: no win route yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408); BN7 skipped: no win route yet (the Black Ops at BN7's multipliers, Bladeburner's B8); " +
      "BN3 skipped: no hacking multipliers or prices yet";
    const bn23 = { currentNode: 2, ownedSF: { 1: 3, 4: 3, 5: 1, 2: 2 } };
    expect(update({ slowData: slow(bn23) })).toBe(true);
    expect(rule.destroyIntent()).toEqual(worldDaemonDestroyIntent(5));
    expect(rule.view()).toMatchObject({ nextBitNode: 5, replay: null, skipped });
    expect(lines).toEqual([
      `world daemon: w0r1d_d43m0n rooted at hacking 3000: destroying the BitNode, into BitNode 5 (${skipped}) ` +
        "(the gate, then a save backup first)",
    ]);
    // A slow snapshot whose next is another BitNode (BN1, a replay, all the rest skipped): the asked-for BN5's skips
    // aren't that one's.
    update({ slowData: slow({ currentNode: 5, ownedSF: { 1: 3, 2: 3, 4: 3, 5: 3 } }) });
    expect(rule.view()).toMatchObject({ nextBitNode: 5, replay: null, skipped: null });
    expect(skippedOf(bn23, 5)).toBe(skipped);
    // BN5.1 into BN2 (#334): nothing skipped.
    expect(skippedOf({ currentNode: 5, ownedSF: { 1: 3, 4: 3 } }, 2)).toBeNull();
    expect(skippedOf({ currentNode: 4, ownedSF: { 1: 3, 4: 2 } }, 5)).toBeNull();
    expect(skippedOf(undefined, 5)).toBeNull();
  });

  test("a slow snapshot whose BitNode or Source-Files can't be read: no destroy, logged once", () => {
    const odd = { slowData: slow({ currentNode: 0 }) };
    expect(update(odd)).toBe(false);
    expect(update(odd)).toBe(false);
    expect(rule.destroyIntent()).toBeNull();
    expect(rule.view().nextBitNode).toBeNull();
    expect(lines).toEqual([`world daemon: w0r1d_d43m0n ready, but ${NEXT_UNREAD}`]);
    expect(update({ slowData: slow({ ownedSF: { 1: -1 } }) })).toBe(false);
    expect(update()).toBe(true);
  });

  test("worldDaemonDestroyInto: a reset note's destroy into a BitNode of the order, else null", () => {
    expect(worldDaemonDestroyInto("destroyBitNode(1)")).toBe(1);
    expect(worldDaemonDestroyInto("destroyBitNode(4)")).toBe(4);
    expect(worldDaemonDestroyInto("destroyBitNode(5)")).toBe(5);
    // BN2 played since #334; BN3 is in the order (#323), but the brain doesn't play it yet: never the brain's.
    expect(worldDaemonDestroyInto("destroyBitNode(2)")).toBe(2);
    expect(worldDaemonDestroyInto("destroyBitNode(3)")).toBeNull();
    expect(worldDaemonDestroyInto("installAugmentations()")).toBeNull();
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

  test("A6 batching first for the levelling set at The Red Pill (#410): its bound in place of the 15 or 10 minutes", () => {
    const met = { mediumData: medium({ hacking: 2600, money: 200e9 }) };
    // Reached, A6 waiting from 0 within 40 min: no stall at 15, nor at 40 less a millisecond; at 40, the stall, said.
    const wait = { sinceMs: 0, withinMs: 40 * MINUTE };
    const reached = (nowMs: number) =>
      update({ ...met, slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }), nowMs, redPillWait: wait });
    reached(0);
    reached(RED_PILL_INSTALL_STALLED_AFTER_MS);
    reached(40 * MINUTE - 1);
    expect(rule.stall()).toBeNull();
    reached(40 * MINUTE);
    expect(rule.stall()).toMatchObject({
      step: "redPill",
      detail:
        "The Red Pill reached, not installed; A6 batching first for the levelling set (#410), its bound 40 min from " +
        "1970-01-01T00:00:00.000Z",
    });
    // By a donation, its reputation flat: the wait's bound too, in place of the 10 minutes.
    rule = new WorldDaemonRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
    const short = (nowMs: number) =>
      update({ ...met, slowData: slow({ ownedAugs: THIRTY, daedalus: 3_000 }), nowMs, redPillWait: wait });
    short(0);
    short(RED_PILL_REPUTATION_STALLED_AFTER_MS);
    short(40 * MINUTE - 1);
    expect(rule.stall()).toBeNull();
    short(40 * MINUTE);
    expect(rule.stall()).toMatchObject({ step: "redPillReputation" });
    // A wait shorter than the default: the default stands.
    rule = new WorldDaemonRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
    const brief = (nowMs: number) =>
      update({
        ...met,
        slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
        nowMs,
        redPillWait: { sinceMs: 0, withinMs: MINUTE },
      });
    brief(0);
    brief(RED_PILL_INSTALL_STALLED_AFTER_MS - 1);
    expect(rule.stall()).toBeNull();
    brief(RED_PILL_INSTALL_STALLED_AFTER_MS);
    expect(rule.stall()).toMatchObject({ step: "redPill" });
  });

  test("levelling's choice hopeless (#410): the stall at once, once while it lasts; over when it isn't", () => {
    const detail = "levelling's choice hopeless (#410): batching for money, about 1.0e+6 h";
    rule.watchLevelling(detail, 5_000);
    expect(rule.stall()).toEqual({ step: "levelling", sinceMs: 5_000, detail });
    expect(events).toEqual([{ type: "worldDaemonStalled", atMs: 5_000, step: "levelling", sinceMs: 5_000, detail }]);
    expect(lines.at(-1)).toBe(`world daemon: STALLED 0 min: ${detail}`);
    // A8's own update keeps it; a second reading adds none.
    update({ mediumData: medium({ hacking: 2600 }), slowData: slow({ ownedAugs: THIRTY }), nowMs: 6_000 });
    rule.watchLevelling(detail, 7_000);
    expect(events).toHaveLength(1);
    expect(rule.stall()?.step).toBe("levelling");
    rule.watchLevelling(null, 8_000);
    expect(rule.stall()).toBeNull();
    rule.watchLevelling(detail, 9_000);
    expect(events).toHaveLength(2);
  });
});

describe("The Red Pill at the gang's faction (#334, G5)", () => {
  const NITESEC = (reputation: number) => ({ name: "NiteSec", reputation, favor: 0 });
  /** BN2, nothing installed (Daedalus's count far off), 1 h since the install. */
  const bn2 = (fields: Parameters<typeof slow>[0] = {}) =>
    slow({ ownedAugs: { [ONE]: 1 }, currentNode: 2, lastAugReset: 0, ...fields });
  const HOUR = 60 * MINUTE;

  test("the path: its seller the gang's faction, at the cycle's rate and ETA; no Daedalus needed; reached; queued", () => {
    const path = (slowData: SlowSnapshotData, reputation: number, sinceResetMs: number | null = HOUR) =>
      worldDaemonPath({
        staticData: staticData(15_000),
        mediumData: medium({ hacking: 500 }),
        slowData,
        expPerSecond: null,
        gangShop: NITESEC(reputation),
        sinceResetMs,
      });
    // 500,000 in an hour: 138.9 a second, the rest in 4 hours.
    const short = path(bn2(), 500_000);
    expect(short.redPill).toMatchObject({
      seller: "NiteSec",
      gang: true,
      reputation: 500_000,
      reputationNeeded: 2.5e6,
    });
    expect(short.redPill?.perSecond).toBeCloseTo(500_000 / 3600, 9);
    expect(short.redPill?.etaSeconds).toBeCloseTo(4 * 3600, 6);
    expect(describeWorldDaemonPath(short)[1]).toBe(
      "The Red Pill: NiteSec's (the gang's faction) reputation 500,000 of 2,500,000 at 138.9/s (the cycle's): about " +
        "4.0 h",
    );
    expect(describeWorldDaemonPath(path(bn2(), 0))[1]).toBe(
      "The Red Pill: NiteSec's (the gang's faction) reputation 0 of 2,500,000, none earned this cycle yet",
    );
    expect(describeWorldDaemonPath(path(bn2(), 2.5e6))[1]).toBe(
      "The Red Pill: NiteSec's (the gang's faction) reputation 2,500,000 of 2,500,000, reached: to buy and install",
    );
    expect(describeWorldDaemonPath(path(bn2({ queued: [RED_PILL] }), 2.5e6))[1]).toBe(
      "The Red Pill: queued, to install",
    );
    // Daedalus joined with more (#335's re-review): still the gang's faction, A6's route there, unless Daedalus has
    // reached it. Outside BN2 the gang's faction sells none (`FactionHelpers.tsx:180`).
    expect(path(bn2({ daedalus: 600_000 }), 500_000).redPill).toMatchObject({ seller: "NiteSec", gang: true });
    expect(path(bn2({ daedalus: 400_000 }), 500_000).redPill).toMatchObject({ seller: "NiteSec", gang: true });
    expect(path(bn2({ daedalus: 2.5e6 }), 500_000).redPill).toMatchObject({ seller: "Daedalus", gang: false });
    expect(path(bn2({ currentNode: 1 }), 2.5e6).redPill).toMatchObject({ seller: null, reputation: null });
    // Daedalus's count never short with the gang's faction selling it (#335's review); without a gang, short.
    expect(short.daedalus?.short).toBe(false);
    const noGang = worldDaemonPath({
      staticData: staticData(15_000),
      mediumData: medium({ hacking: 500 }),
      slowData: bn2(),
      expPerSecond: null,
    });
    expect(noGang.daedalus?.short).toBe(true);
  });

  test("reached there and not installed 15 minutes on: the stall, a failure; its reputation pausing isn't one", () => {
    const at = (reputation: number, nowMs: number) =>
      update({
        mediumData: medium({ hacking: 500 }),
        slowData: bn2(),
        gangShop: NITESEC(reputation),
        slowGameTimeMs: HOUR,
        nowMs,
      });
    // Short and not rising for an hour, A6 not holding for it: a gang's respect pauses while its members train.
    at(1e6, 0);
    at(1e6, 6 * RED_PILL_REPUTATION_STALLED_AFTER_MS);
    expect(rule.stall()).toBeNull();
    expect(rule.view().path?.redPill).toMatchObject({ seller: "NiteSec", reputation: 1e6 });
    // At the cycle's rate, from the slow snapshot's game time: 1m in an hour, the rest in 1.5 h.
    expect(rule.view().path?.redPill?.perSecond).toBeCloseTo(1e6 / 3600, 9);
    expect(rule.view().path?.redPill?.etaSeconds).toBeCloseTo(1.5 * 3600, 6);
    // Reached: 15 minutes for A6's whole commit, then the stall.
    const reachedAt = HOUR;
    at(2.5e6, reachedAt);
    at(2.5e6, reachedAt + RED_PILL_INSTALL_STALLED_AFTER_MS - 1);
    expect(rule.stall()).toBeNull();
    at(2.5e6, reachedAt + RED_PILL_INSTALL_STALLED_AFTER_MS);
    expect(rule.stall()).toMatchObject({ step: "redPill", detail: "The Red Pill reached, not installed" });
    expect(events.map((event) => (event.type === "worldDaemonStalled" ? event.step : event.type))).toEqual(["redPill"]);
  });

  test("not rising at the gang's faction while held, Daedalus ahead and rising (#335's re-review): the gang's stall", () => {
    // Daedalus at 2.45m and rising, the gang's faction flat at 2.4m with A6 holding there: the gang's is watched.
    const at = (nowMs: number, daedalus: number) =>
      update({
        mediumData: medium({ hacking: 500 }),
        slowData: bn2({ daedalus }),
        gangShop: NITESEC(2.4e6),
        slowGameTimeMs: HOUR,
        redPillHeldAtGang: true,
        nowMs,
      });
    at(0, 2.45e6);
    expect(rule.view().path?.redPill).toMatchObject({ seller: "NiteSec", gang: true, reputation: 2.4e6 });
    at(RED_PILL_REPUTATION_STALLED_AFTER_MS - 1, 2.46e6);
    expect(rule.stall()).toBeNull();
    at(RED_PILL_REPUTATION_STALLED_AFTER_MS, 2.47e6);
    expect(rule.stall()).toMatchObject({
      step: "redPillReputation",
      detail: expect.stringContaining("The Red Pill's reputation at NiteSec not rising (2,400,000 of 2,500,000)"),
    });
  });

  test("not rising while A6 holds installs for it (#335's review): the stall at 10 minutes, as at Daedalus", () => {
    const at = (nowMs: number, redPillHeldAtGang = true) =>
      update({
        mediumData: medium({ hacking: 500 }),
        slowData: bn2(),
        gangShop: NITESEC(2.4e6),
        slowGameTimeMs: HOUR,
        redPillHeldAtGang,
        nowMs,
      });
    at(0);
    at(RED_PILL_REPUTATION_STALLED_AFTER_MS - 1);
    expect(rule.stall()).toBeNull();
    at(RED_PILL_REPUTATION_STALLED_AFTER_MS);
    expect(rule.stall()).toMatchObject({
      step: "redPillReputation",
      detail:
        "The Red Pill's reputation at NiteSec not rising (2,400,000 of 2,500,000): no install is chosen meanwhile, so " +
        "nothing earning it stalls A6",
    });
  });

  test("while the gang's plan earns no respect (#374): its own bound in place of the 10 minutes, kept from its start", () => {
    type Pause = { fromMs: number; withinMs: number; estimateMs: number } | null;
    const at = (nowMs: number, gangPause: Pause, reputation = 2.4e6) =>
      update({
        mediumData: medium({ hacking: 500 }),
        slowData: bn2(),
        gangShop: NITESEC(reputation),
        slowGameTimeMs: HOUR,
        redPillHeldAtGang: true,
        gangPause,
        nowMs,
      });
    // Risen last at 0, the plan training from a minute on: its estimate 9 min, its bound 28 (2 × 9 + 10), to 29 min.
    const pause = { fromMs: MINUTE, withinMs: 28 * MINUTE, estimateMs: 9 * MINUTE };
    at(0, null);
    at(MINUTE, pause);
    at(29 * MINUTE - 1, pause);
    expect(rule.stall()).toBeNull();
    // Each reading a gap would start the gang rule's own stretch again (#364's review): the first one is kept.
    at(29 * MINUTE, { ...pause, fromMs: 29 * MINUTE });
    expect(rule.stall()).toMatchObject({
      step: "redPillReputation",
      sinceMs: 0,
      detail: expect.stringMatching(
        /; the gang's plan earning no respect since 1970-01-01T00:01:00\.000Z, its bound 28 min \(twice the gang rule's estimate of 9 min, and 10 min\)$/,
      ),
    });
    // A bound that ends before the 10 minutes from the last rise: the 10 minutes still. The pause from 0, its estimate
    // 0 and bound 10 min, to 10; the reputation last risen at 5 min: the stall at 15, not 10.
    rule = new WorldDaemonRule({ log: () => {}, emit: (event) => events.push(event) });
    const short = { fromMs: 0, withinMs: 10 * MINUTE, estimateMs: 0 };
    at(0, short, 2.3e6);
    at(5 * MINUTE, short);
    at(5 * MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS - 1, short);
    expect(rule.stall()).toBeNull();
    at(5 * MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS, short);
    expect(rule.stall()).toMatchObject({ step: "redPillReputation", sinceMs: 5 * MINUTE });
    // The plan earning again (null) at 1 min: the pause forgotten, the 10 minutes from its end (#376's review), not
    // from the reputation's last rise before it: flat to 11 min, the stall; not at 11 min less a millisecond.
    rule = new WorldDaemonRule({ log: () => {}, emit: (event) => events.push(event) });
    at(0, pause);
    at(MINUTE, null);
    at(MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS - 1, null);
    expect(rule.stall()).toBeNull();
    at(MINUTE + RED_PILL_REPUTATION_STALLED_AFTER_MS, null);
    expect(rule.stall()).toMatchObject({ step: "redPillReputation", sinceMs: MINUTE });
  });

  test("a normal pause ending (#376's review): no stall as it ends; the reputation rising after it, none; flat 10 min, the stall", () => {
    type Pause = { fromMs: number; withinMs: number; estimateMs: number } | null;
    const at = (nowMs: number, gangPause: Pause, reputation: number) =>
      update({
        mediumData: medium({ hacking: 500 }),
        slowData: bn2(),
        gangShop: NITESEC(reputation),
        slowGameTimeMs: HOUR,
        redPillHeldAtGang: true,
        gangPause,
        nowMs,
      });
    // Risen to minute 3; the plan training from 4 to 12 (its estimate 9, bound 28); working from 13, the reputation
    // not yet risen at that first reading (the members just put to work).
    const pause = { fromMs: 4 * MINUTE, withinMs: 28 * MINUTE, estimateMs: 9 * MINUTE };
    const play = (rising: boolean) => {
      rule = new WorldDaemonRule({ log: () => {}, emit: (event) => events.push(event) });
      let reputation = 2e6;
      for (let minute = 0; minute <= 3; minute += 1) {
        reputation += 1_000;
        at(minute * MINUTE, null, reputation);
      }
      for (let minute = 4; minute <= 12; minute += 1) at(minute * MINUTE, pause, reputation);
      at(13 * MINUTE, null, reputation);
      expect(rule.stall()).toBeNull();
      for (let minute = 14; minute <= 23; minute += 1) {
        if (rising) reputation += 1_000;
        at(minute * MINUTE, null, reputation);
      }
    };
    play(true);
    expect(rule.stall()).toBeNull();
    play(false);
    expect(rule.stall()).toMatchObject({ step: "redPillReputation", sinceMs: 13 * MINUTE });
  });
});
test("the run report's path (#334): the gang's faction from the window's last slow snapshot, at its game time's rate", () => {
  const fold = new WorldDaemonFold();
  fold.addSlow(60 * MINUTE);
  const slowLast = {
    ...slow({ ownedAugs: { [ONE]: 1 }, currentNode: 2 }),
    gangFaction: "NiteSec",
    factions: {
      backend: "sim",
      state: { joined: [{ name: "NiteSec", reputation: 500_000, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  } as SlowSnapshotData;
  const lines = fold.pathLines(
    { staticLast: staticData(15_000), mediumLast: medium({ hacking: 500 }), slowLast },
    [],
    (ms) => `t${ms}`,
  );
  expect(lines).toContain(
    "    The Red Pill: NiteSec's (the gang's faction) reputation 500,000 of 2,500,000 at 138.9/s (the cycle's): about " +
      "4.0 h",
  );
});

describe("a replay with nothing playable left in the campaign's order to gain (#311, #321, #323)", () => {
  const REPLAY =
    "the campaign's order has nothing playable left to gain (Source-File 1 at 3, Source-File 2 at 3, Source-File 4 at 3, " +
    "Source-File 5 at 3), but the run";
  const SKIPPED =
    "BN6 skipped: no win route yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408); BN7 skipped: no win route yet (the Black Ops at BN7's multipliers, Bladeburner's B8); " +
    "BN3, BN9, BN11, BN8, BN15, BN10, BN13, BN14 " +
    "and BN12 skipped: no hacking multipliers or prices yet";
  const CAPS = { 1: 3, 2: 3, 4: 3, 5: 3 };
  const atCaps = { slowData: slow({ ownedSF: CAPS }) };

  test("replayOf: the brain's next BitNode with nothing left in the order, and only that", () => {
    expect(replayOf({ currentNode: 1, ownedSF: CAPS }, 1)).toBe(REPLAY);
    // BN5.3 destroyed: SF5 reaches 3 by it.
    expect(replayOf({ currentNode: 5, ownedSF: { 1: 3, 2: 3, 4: 3, 5: 2 } }, 1)).toBe(REPLAY);
    // BN5.3 destroyed with BN2 short: into BN2 (#334), no replay.
    expect(replayOf({ currentNode: 5, ownedSF: { 1: 3, 4: 3, 5: 2 } }, 2)).toBeNull();
    // BN4.3 destroyed with SF1 at 3 (#321's replay): BN5 is next now (#323).
    expect(replayOf({ currentNode: 4, ownedSF: { 1: 3, 4: 2 } }, 1)).toBeNull();
    expect(skippedOf({ currentNode: 1, ownedSF: CAPS }, 1)).toBe(SKIPPED);
    // At SF1's cap with SF4 short (#311's replay before #321): BN4 is next, not a replay; BN1 isn't the brain's.
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 3 } }, 4)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: { 1: 3 } }, 1)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: CAPS }, 2)).toBeNull();
    // Not read: not said.
    expect(replayOf({ ownedSF: CAPS }, 1)).toBeNull();
    expect(replayOf(undefined, 1)).toBeNull();
    expect(replayOf({ currentNode: 1, ownedSF: { ...CAPS, 1: "3" } }, 1)).toBeNull();
  });

  test("the destroy goes ahead at the caps: asked for, logged as a replay, no stall; the view says it", () => {
    expect(update({ ...atCaps, nowMs: 0 })).toBe(true);
    // No stall at once (the refusal before #311 was one): only the destroy's own, 5 minutes on, if it doesn't go.
    expect(update({ ...atCaps, nowMs: MINUTE })).toBe(true);
    expect(lines).toEqual([
      `world daemon: w0r1d_d43m0n rooted at hacking 3000: destroying the BitNode, into BitNode 1 (${SKIPPED}), ` +
        `a replay (${REPLAY}) (the gate, then a save backup first)`,
    ]);
    expect(events).toEqual([]);
    expect(rule.view()).toMatchObject({
      destroying: true,
      nextBitNode: 1,
      replay: REPLAY,
      skipped: SKIPPED,
      stall: null,
    });
    // A slow snapshot with SF4 short: BN4 would be next, so the asked-for BN1 isn't said to be a replay.
    update({ slowData: slow({ ownedSF: { 1: 3 } }) });
    expect(rule.view()).toMatchObject({ nextBitNode: 1, replay: null, skipped: null });
    // Kept across the Agent gone (no snapshots).
    update({ ...atCaps });
    update({ staticData: null, mediumData: null, slowData: null });
    expect(rule.view().replay).toBe(REPLAY);
  });

  test("a replay not through 5 minutes on: the destroy step's stall, as for any destroy", () => {
    update({ ...atCaps, nowMs: 0 });
    update({ ...atCaps, nowMs: WORLD_DAEMON_STALLED_AFTER_MS - 1 });
    expect(rule.stall()).toBeNull();
    update({ ...atCaps, nowMs: WORLD_DAEMON_STALLED_AFTER_MS });
    const detail = "w0r1d_d43m0n at its level (hacking 3,000 of 3,000), the BitNode not destroyed";
    expect(rule.stall()).toEqual({ step: "destroy", sinceMs: 0, detail });
    expect(events).toEqual([
      { type: "worldDaemonStalled", atMs: WORLD_DAEMON_STALLED_AFTER_MS, step: "destroy", sinceMs: 0, detail },
    ]);
    expect(lines.at(-1)).toBe(`world daemon: STALLED 5 min: ${detail}`);
  });

  test("the start line's words: off, on, or on and into the BitNode the last slow snapshot gives (#321)", () => {
    expect(describeWorldDaemonSwitch(false, slow({ ownedSF: { 1: 3 } }))).toBe("off");
    expect(describeWorldDaemonSwitch(true, null)).toBe("on");
    expect(describeWorldDaemonSwitch(true, { resetInfo: "odd" })).toBe("on");
    expect(describeWorldDaemonSwitch(true, slow({ ownedSF: { 1: 2 } }))).toBe("on (into BitNode 4)");
    expect(describeWorldDaemonSwitch(true, slow({ ownedSF: { 1: 3 } }))).toBe("on (into BitNode 4)");
    expect(describeWorldDaemonSwitch(true, slow({ currentNode: 4, ownedSF: { 1: 3, 4: 1 } }))).toBe(
      "on (into BitNode 4)",
    );
    expect(describeWorldDaemonSwitch(true, slow({ currentNode: 4, ownedSF: { 1: 3, 4: 2 } }))).toBe(
      "on (into BitNode 5)",
    );
    // BN5.1 into BN2 (#334); BN2.3 into BN5 again, past the rest.
    expect(describeWorldDaemonSwitch(true, slow({ currentNode: 5, ownedSF: { 1: 3, 4: 3 } }))).toBe(
      "on (into BitNode 2)",
    );
    expect(describeWorldDaemonSwitch(true, slow({ currentNode: 2, ownedSF: { 1: 3, 4: 3, 5: 1, 2: 2 } }))).toBe(
      "on (into BitNode 5 (BN6 skipped: no win route yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408); BN7 skipped: no win route yet (the Black Ops at BN7's multipliers, Bladeburner's B8); BN3 skipped: " +
        "no hacking multipliers or prices yet))",
    );
    expect(describeWorldDaemonSwitch(true, slow({ ownedSF: CAPS }))).toBe(
      `on (into BitNode 1 (${SKIPPED}), a replay (${REPLAY}))`,
    );
  });
});

describe("a restarted brain", () => {
  test("its destroy restored from the reset note: held with no snapshots, over at another lastNodeReset", () => {
    rule.restore(0, 4);
    expect(rule.destroyIntent()).toEqual(worldDaemonDestroyIntent(4));
    expect(update({ staticData: null, mediumData: null, slowData: null })).toBe(true);
    expect(rule.view()).toMatchObject({ destroying: true, nextBitNode: 4 });
    expect(update({ slowData: slow({ lastNodeReset: 0 }), mediumData: medium({ hacking: 1 }) })).toBe(true);
    // A slow snapshot whose next would be a replay into BN1: the restored destroy into BN4 isn't called one.
    update({
      slowData: slow({ lastNodeReset: 0, ownedSF: { 1: 3, 2: 3, 4: 3, 5: 3 } }),
      mediumData: medium({ hacking: 1 }),
    });
    expect(rule.view()).toMatchObject({ destroying: true, nextBitNode: 4, replay: null });
    expect(
      update({ slowData: slow({ ownedAugs: {}, lastNodeReset: 5_000 }), mediumData: medium({ hacking: 1 }) }),
    ).toBe(false);
    expect(rule.destroyIntent()).toBeNull();
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

describe("the Black Ops' route (#398): BN6", () => {
  const BN6 = { currentNode: 6, ownedSF: { 1: 3, 2: 3, 4: 3, 5: 1 }, ownedAugs: {} as Record<string, number> };
  /** The route as the controller's `blackOpsRouteOf` gives it: 18 of 21 done, Centurion next. */
  const view = (fields: Partial<BlackOpsRouteView> = {}): BlackOpsRouteView => ({
    rank: 300_500,
    done: 18,
    next: { name: "Operation Centurion", rank: 300_000, chance: 0.4 },
    rankPerSecond: 1,
    etaSeconds: 99_500,
    estimate: { steps: [], seconds: 120_000, rate: 1 },
    grown: null,
    grownAtMs: null,
    redPillSeconds: 1e70,
    choice: chooseWinRoute({ blackOpsSeconds: 120_000, redPillSeconds: 1e70, soFarSeconds: 36_000 }),
    rankStallMs: 20 * MINUTE,
    climbWindowMs: 20 * MINUTE,
    climbRise: 0,
    attemptsStallMs: 60 * MINUTE,
    ...fields,
  });
  const bn6 = (fields: Partial<BlackOpsRouteView> = {}, more: Partial<Parameters<WorldDaemonRule["update"]>[0]> = {}) =>
    update({
      slowData: slow({ ...BN6, daedalus: 1e6 }),
      mediumData: medium({ hacking: 2600, daemon: "absent" }),
      blackOps: () => view(fields),
      bladeburnerActing: true,
      ...more,
    });

  test("the path is the route's: the rank, the next one, both routes' estimates, and The Red Pill's path off, said", () => {
    const path = worldDaemonPath({
      staticData: staticData(6000),
      mediumData: medium({ hacking: 2600, daemon: "absent" }),
      slowData: slow({ ...BN6, daedalus: 1e6 }),
      expPerSecond: 100,
      blackOps: view(),
    });
    expect(path).toMatchObject({ bitNode: 6, route: "blackOps", daedalus: null, redPill: null, daemon: null });
    expect(path.blackOps).toEqual(view());
    expect(describeWorldDaemonPath(path)).toEqual([
      "the Black Ops (#398): rank 300,500 of 400,000 (Operation Daedalus's); 18 of 21 done; next Operation Centurion " +
        "at rank 300,000, its chance 40.0% at the low end; 400,000 about 27.6 h at the measured 60.00 rank/min",
      "the planner (#398): the Black Ops' about 33.3 h; The Red Pill's at least 2.78e+66 h (w0r1d_d43m0n's " +
        "hacking level alone, by the formulas), hopeless: the Black Ops chosen (The Red Pill's hopeless by the " +
        "formulas, past the BitNode's time so far (decision 67's point 8, #359))",
      "off on this route (#398): The Red Pill's holds (A6), levelling (#336) and A8's Red Pill path (Daedalus, The " +
        "Red Pill, w0r1d_d43m0n's hacking level)",
    ]);
    // A Red Pill choice is shown, not acted on: the route played is fixed per BitNode (#400's review).
    const redPill = chooseWinRoute({ blackOpsSeconds: 7200, redPillSeconds: 3600, soFarSeconds: 36_000 });
    expect(describeWorldDaemonPath({ ...path, blackOps: view({ choice: redPill }) })[1]).toMatch(
      /The Red Pill chosen \(The Red Pill's the shorter\); shown, not acted on: this BitNode plays the Black Ops$/,
    );
    // With the competence's growth (#408): the planner's, B6's at the competence now beside it.
    const grownStep = { name: "Operation Daedalus", chance: 0.052 } as NonNullable<
      BlackOpsRouteView["grown"]
    >["steps"][number];
    const grown = { steps: [grownStep], seconds: 36_000, rate: 1, path: [], solves: 10 };
    expect(describeWorldDaemonPath({ ...path, blackOps: view({ grown, grownAtMs: 0 }) })[1]).toMatch(
      /^the planner \(#398\): the Black Ops' about 10.0 h with the competence's growth \(#408: the skills from the rank, the stats from the actions, the levels from the successes; the last one at 5\.2%\), about 33\.3 h at the competence now \(B6's\); /,
    );
    // Unread: said.
    expect(describeWorldDaemonPath({ ...path, blackOps: null })[0]).toBe(
      "the Black Ops (#398): no reading yet (the division joined, and home's RAM for its reader)",
    );
    // In BN4, The Red Pill's, unchanged: no Black Ops part.
    const bn4 = worldDaemonPath({
      staticData: staticData(9000),
      mediumData: medium({ hacking: 2600, daemon: "absent" }),
      slowData: slow({ currentNode: 4, ownedSF: { 1: 3 }, ownedAugs: THIRTY, daedalus: 1e6 }),
      expPerSecond: 100,
      blackOps: view(),
    });
    expect(bn4).toMatchObject({ route: "redPill", blackOps: null });
    expect(bn4.daedalus).not.toBeNull();
    expect(bn4.redPill).not.toBeNull();
  });

  test("the destroy only with all 21 done, into the order's next (BN6.1 into BN5 while BN6's estimate is past the bar, BN7 waits for B8), logged; none at 20", () => {
    expect(bn6({ done: 20, next: { name: "Operation Daedalus", rank: 400_000, chance: 0.5 } })).toBe(false);
    expect(rule.destroyIntent()).toBeNull();
    expect(bn6({ done: 21, next: null, rank: 440_000 })).toBe(true);
    expect(rule.destroyIntent()).toEqual(worldDaemonDestroyIntent(5));
    expect(lines).toEqual([
      "world daemon: all 21 Black Ops done (#398): destroying the BitNode, into BitNode 5 (BN6 skipped: no win route " +
        "yet: the Black Ops' grown estimate is past the campaign's bar even with the Bladeburners' shop installed (#408); BN7 skipped: no win route yet (the " +
        "Black Ops at BN7's multipliers, Bladeburner's B8); BN3 skipped: no hacking multipliers or prices yet) (the " +
        "gate, then a save backup first)",
    ]);
    // Unread (no reading): none.
    rule = new WorldDaemonRule({});
    expect(update({ slowData: slow(BN6), mediumData: medium({ daemon: "absent" }) })).toBe(false);
  });

  test("all 21 done and not destroyed 5 minutes on: the destroy's stall, a run report failure", () => {
    bn6({ done: 21, next: null }, { nowMs: 0 });
    bn6({ done: 21, next: null }, { nowMs: WORLD_DAEMON_STALLED_AFTER_MS - 1 });
    expect(rule.stall()).toBeNull();
    bn6({ done: 21, next: null }, { nowMs: WORLD_DAEMON_STALLED_AFTER_MS });
    const detail = "all 21 Black Ops done (#398), the BitNode not destroyed";
    expect(rule.stall()).toEqual({ step: "destroy", sinceMs: 0, detail });
    expect(events).toEqual([
      { type: "worldDaemonStalled", atMs: WORLD_DAEMON_STALLED_AFTER_MS, step: "destroy", sinceMs: 0, detail },
    ]);
  });

  describe("the stalls on the route (#400's review): the climb's and the attempts' bounds", () => {
    const CLIMB = 20 * MINUTE;
    const ATTEMPTS = 60 * MINUTE;
    /** Under Centurion's 300,000: the climb, its least rise 120 a 20 min bound (a tenth of 1 rank/s over it). */
    const climbing = (rank: number, nowMs: number, more: Partial<Parameters<WorldDaemonRule["update"]>[0]> = {}) =>
      bn6({ rank, climbRise: 120, rankStallMs: CLIMB, attemptsStallMs: ATTEMPTS }, { nowMs, ...more });
    const attempting = (rank: number, nowMs: number, done = 18) =>
      bn6({ rank, done, climbRise: 120, rankStallMs: CLIMB, attemptsStallMs: ATTEMPTS }, { nowMs });

    test("the climb flat: a stall at its bound, on both sides; a rise by its least, over", () => {
      climbing(290_000, 0);
      climbing(290_000, CLIMB - 1);
      expect(rule.stall()).toBeNull();
      climbing(290_000, CLIMB);
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
      expect(rule.stall()?.detail).toContain(
        "Bladeburner's rank not climbing (290,000 now, 290,000 at the clock's start)",
      );
      climbing(290_120, CLIMB + MINUTE);
      expect(rule.stall()).toBeNull();
    });

    test("the climb's least rise (120 a 20 min window here): short of it within the window, a stall; past it, none", () => {
      for (let at = 0; at <= CLIMB; at += MINUTE) climbing(290_000 + (0.01 * at) / 1000, at);
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
      // Past the least rise within each window: none.
      rule = new WorldDaemonRule({});
      for (let at = 0; at <= 3 * CLIMB; at += MINUTE) climbing(290_000 + (0.2 * at) / 1000, at);
      expect(rule.stall()).toBeNull();
    });

    test("a Black Op stuck failing, each loss rebuilt to its rank: a stall at the attempts' bound, the rebuilds no reset", () => {
      // Centurion at 300,000: each 10 min a failure's 5,000 lost, then rebuilt (each reading a rise), each attempt a
      // little higher than the last (the contracts' steps past the rank): the rises past a climb's least are no reset.
      for (let failure = 0; failure * 10 * MINUTE <= ATTEMPTS; failure++) {
        const from = failure * 10 * MINUTE;
        const peak = 300_000 + 200 * failure;
        attempting(peak, from);
        for (let minute = 1; minute < 10; minute++) {
          attempting(peak - 5_000 + (5_200 * (minute - 1)) / 9, from + minute * MINUTE);
        }
      }
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
      expect(rule.stall()?.detail).toContain(
        "Operation Centurion not done (#398, 18 of 21), its rank met, the bound 1 h 0 min",
      );
    });

    test("failures in a row within the bound, each rebuilt, then the Black Op done: no stall, the clock afresh", () => {
      for (let failure = 0; failure < 5; failure++) {
        const from = failure * 10 * MINUTE;
        attempting(300_000, from);
        for (let minute = 1; minute < 10; minute++) {
          attempting(295_000 + (5_000 * (minute - 1)) / 9, from + minute * MINUTE);
        }
      }
      // Done at 55 min: the next one's climb from then.
      bn6(
        { rank: 310_000, done: 19, next: { name: "Operation Vindictus", rank: 350_000, chance: 0.3 }, climbRise: 120 },
        { nowMs: 55 * MINUTE },
      );
      for (let at = 56; at <= 70; at++) {
        bn6(
          {
            rank: 310_000 + at * 200,
            done: 19,
            next: { name: "Operation Vindictus", rank: 350_000, chance: 0.3 },
            climbRise: 120,
            rankStallMs: CLIMB,
          },
          { nowMs: at * MINUTE },
        );
      }
      expect(rule.stall()).toBeNull();
      expect(events).toEqual([]);
    });

    test("Bernstein's climb at α 0.001: a seeded run at the rate, its ordinary failures in it, passes; a crawl at 1% fails", () => {
      // The plan: attempts at 0.6 gaining 40 and losing 30 (each ±10%), 5 s each, worked 90% of the time: its bound positive
      // at the 20 min window itself (a lumpier plan's window is lengthened: core's test).
      const PLAN = { chance: 0.6, gain: 40, loss: 30, seconds: 5, duty: 0.9 };
      const mean = PLAN.chance * PLAN.gain - (1 - PLAN.chance) * PLAN.loss;
      const second = (PLAN.chance * PLAN.gain ** 2 + (1 - PLAN.chance) * PLAN.loss ** 2) * (1 + 0.01 / 3);
      const attempts = {
        perSecond: PLAN.duty / PLAN.seconds,
        variance: second - mean ** 2,
        below: mean + 1.1 * PLAN.loss,
      };
      const rate = (PLAN.duty * mean) / PLAN.seconds;
      const window = climbWindowSeconds(rate, CLIMB / 1000, attempts, 0.001);
      const fields = {
        climbRise: climbRiseLowerBound(rate, window, attempts, 0.001),
        climbWindowMs: window * 1000,
        rankStallMs: CLIMB,
        attemptsStallMs: ATTEMPTS,
      };
      expect(window).toBe(CLIMB / 1000);
      expect(fields.climbRise).toBeGreaterThan(0.01 * rate * window);
      // A seeded walk of the plan, a reading each minute, over five windows.
      let state = 400;
      const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let x = state;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
      const every = PLAN.seconds / PLAN.duty;
      let rank = 100_000;
      let nextAttemptS = every;
      for (let at = 0; at <= 5 * window * 1000; at += MINUTE) {
        for (; nextAttemptS * 1000 <= at; nextAttemptS += every) {
          const offset = 0.9 + 0.2 * random();
          rank += random() < PLAN.chance ? PLAN.gain * offset : -PLAN.loss * offset;
        }
        bn6({ rank, ...fields }, { nowMs: at });
      }
      expect(rule.stall()).toBeNull();
      expect(events).toEqual([]);
      // A crawl at 1% of the rate: a stall within the window.
      rule = new WorldDaemonRule({});
      for (let at = 0; at <= window * 1000 + MINUTE; at += MINUTE) {
        bn6({ rank: 100_000 + (0.01 * rate * at) / 1000, ...fields }, { nowMs: at });
      }
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
      expect(rule.stall()?.detail).toContain("Bernstein's margin at α 0.001");
    });

    test("a lengthened window (Bernstein's bound 0 at the base): the climb judged over it, not the base", () => {
      const fields = { climbRise: 50, climbWindowMs: 2 * CLIMB, rankStallMs: CLIMB, attemptsStallMs: ATTEMPTS };
      bn6({ rank: 290_000, ...fields }, { nowMs: 0 });
      bn6({ rank: 290_000, ...fields }, { nowMs: 2 * CLIMB - 1 });
      expect(rule.stall()).toBeNull();
      bn6({ rank: 290_000, ...fields }, { nowMs: 2 * CLIMB });
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
      expect(rule.stall()?.detail).toContain("lengthened from 20 min");
    });

    test("the chance risen mid-attempts (#400's round 2): the time spent judged against the bound as it stood, not at once", () => {
      // 40 min of failures at p 0.1 (its bound 66 min), then p 0.2 (31 min): 40/66 used, the rest at the new bound.
      const at = (minute: number, boundMinutes: number) =>
        bn6(
          { rank: 300_000, climbRise: 120, rankStallMs: CLIMB, attemptsStallMs: boundMinutes * MINUTE },
          { nowMs: minute * MINUTE },
        );
      for (let minute = 0; minute <= 40; minute++) at(minute, 66);
      at(41, 31);
      expect(rule.stall()).toBeNull();
      // Used up at 40/66 + m/31 = 1: m = 12.2, so by minute 53.
      for (let minute = 42; minute <= 52; minute++) at(minute, 31);
      expect(rule.stall()).toBeNull();
      at(53, 31);
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
    });

    test("ρ risen mid-climb (#400's round 2): the window as it stood at each reading, not the new one at once", () => {
      const at = (minute: number, windowMinutes: number) =>
        bn6(
          { rank: 290_000, climbRise: 120, climbWindowMs: windowMinutes * MINUTE, rankStallMs: CLIMB },
          { nowMs: minute * MINUTE },
        );
      for (let minute = 0; minute <= 40; minute++) at(minute, 60);
      at(41, 20);
      expect(rule.stall()).toBeNull();
      // 40/60 + m/20 = 1: m = 6.7, so by minute 47.
      for (let minute = 42; minute <= 46; minute++) at(minute, 20);
      expect(rule.stall()).toBeNull();
      at(47, 20);
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank", sinceMs: 0 });
    });

    test("a plan resting alone (the counts spent, #400's round 2): its readings not judged, the climb's clock not advanced", () => {
      for (let minute = 0; minute <= 180; minute++) {
        bn6({ rank: 290_000, climbRise: null, climbWindowMs: null, rankStallMs: CLIMB }, { nowMs: minute * MINUTE });
      }
      expect(rule.stall()).toBeNull();
      // Work again: judged from the last rest-only reading on, its window whole: used up at minute 200.
      for (let minute = 181; minute < 200; minute++) climbing(290_000, minute * MINUTE);
      expect(rule.stall()).toBeNull();
      climbing(290_000, 200 * MINUTE);
      expect(rule.stall()).toMatchObject({ step: "blackOpsRank" });
    });

    test("not judged: the rule not acting (the owner's work), all 21 done with the switch off, or under the faction's 25", () => {
      for (let at = 0; at <= 3 * ATTEMPTS; at += MINUTE) climbing(290_000, at, { bladeburnerActing: false });
      expect(rule.stall()).toBeNull();
      rule = new WorldDaemonRule({});
      for (let at = 0; at <= 3 * ATTEMPTS; at += MINUTE) {
        bn6({ rank: 440_000, done: 21, next: null }, { nowMs: at, enabled: false });
      }
      expect(rule.stall()).toBeNull();
      // Under 25 the plan can be a lottery at rank 0 (#386): B2's bound judges it, not this one.
      rule = new WorldDaemonRule({});
      for (let at = 0; at <= 3 * CLIMB; at += MINUTE) climbing(10, at);
      expect(rule.stall()).toBeNull();
    });
  });

  test("The Red Pill's steps are off there (A8): Daedalus joined, its reputation flat, no stall; BN4's has it", () => {
    for (let at = 0; at <= 3 * RED_PILL_REPUTATION_STALLED_AFTER_MS; at += MINUTE) {
      bn6({}, { nowMs: at, bladeburnerActing: false });
    }
    expect(rule.stall()).toBeNull();
    expect(events).toEqual([]);
    // The same in BN4: its reputation's stall, as before.
    rule = new WorldDaemonRule({});
    const bn4 = {
      mediumData: medium({ hacking: 2600 }),
      slowData: slow({ currentNode: 4, ownedSF: { 1: 3 }, ownedAugs: THIRTY, daedalus: 1e6 }),
    };
    update({ ...bn4, nowMs: 0 });
    update({ ...bn4, nowMs: RED_PILL_REPUTATION_STALLED_AFTER_MS });
    expect(rule.stall()).toMatchObject({ step: "redPillReputation" });
  });
});
