// The World Daemon (#215): the path read from snapshot data as the Agent sends it, the destroy asked for once
// w0r1d_d43m0n is ready and held until the reset, and the stalls.
import {
  AUGMENTATION_NAMES,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  describeWorldDaemonPath,
  HackingExpRate,
  hackingEtaSeconds,
  WORLD_DAEMON_DESTROY_INTENT,
  WORLD_DAEMON_STALLED_AFTER_MS,
  type WorldDaemonEvent,
  WorldDaemonRule,
  worldDaemonPath,
} from "../src/world-daemon.ts";

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
} = {}): SlowSnapshotData {
  return {
    resetInfo: { lastAugReset: 0, lastNodeReset, currentNode: 1, ownedAugs, ownedSF: {}, bitNodeOptions: {} },
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
    });
    expect(path.daemon).toBeNull();
    expect(describeWorldDaemonPath(path)).toEqual([
      "Daedalus: not joined; 1 of 30 augmentations installed; needs 1 of 30 augmentations installed, " +
        "$5,000,000,000 of $100,000,000,000, hacking 2,000 of 2,500 (or every combat skill 1,500)",
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
    // Joined: that's over; The Red Pill reached starts its own.
    update({
      ...met,
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
      nowMs: 2 * WORLD_DAEMON_STALLED_AFTER_MS,
    });
    expect(rule.stall()).toBeNull();
    update({
      ...met,
      slowData: slow({ ownedAugs: THIRTY, daedalus: 2.5e6 }),
      nowMs: 3 * WORLD_DAEMON_STALLED_AFTER_MS,
    });
    expect(rule.stall()).toMatchObject({ step: "redPill", detail: "The Red Pill reached, not installed" });
    expect(events.map((event) => (event.type === "worldDaemonStalled" ? event.step : event.type))).toEqual([
      "daedalus",
      "redPill",
    ]);
  });
});
