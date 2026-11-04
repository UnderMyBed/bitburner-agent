// The World Daemon (#215): the path read from snapshot data as the Agent sends it, the destroy asked for once
// w0r1d_d43m0n is ready and held until the reset, and the stalls.
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  isWorthInstalling,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  DAEDALUS_OUT_OF_REACH_AFTER_MS,
  describeWorldDaemonPath,
  HackingExpRate,
  hackingEtaSeconds,
  nextBitNodeProblem,
  RED_PILL_INSTALL_STALLED_AFTER_MS,
  RED_PILL_REPUTATION_STALLED_AFTER_MS,
  WORLD_DAEMON_DESTROY_INTENT,
  WORLD_DAEMON_STALLED_AFTER_MS,
  type WorldDaemonEvent,
  WorldDaemonRule,
  worldDaemonPath,
} from "../src/world-daemon.ts";
import { WorldDaemonFold } from "../src/world-daemon-report.ts";

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
} = {}): SlowSnapshotData {
  return {
    resetInfo: { lastAugReset: 0, lastNodeReset, currentNode, ownedAugs, ownedSF, bitNodeOptions: {} },
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
      // Short (#228); within reach, the hacker factions' (A3's backdoors bring them), Tian Di Hui's at hacking 50, and
      // the city group selling the most of the rest (B; its NeuroFlux Governor is the one installed: counted once).
      short: true,
      reach: {
        more: 37,
        by: [
          { faction: "CyberSec", count: 5 },
          { faction: "NiteSec", count: 7 },
          { faction: "The Black Hand", count: 6 },
          { faction: "BitRunners", count: 6 },
          { faction: "Tian Di Hui", count: 8 },
          { faction: "Chongqing", count: 1 },
          { faction: "New Tokyo", count: 1 },
          { faction: "Ishima", count: 3 },
        ],
      },
      needs: ["$5,000,000,000 of $100,000,000,000", "hacking 2,000 of 2,500 (or every combat skill 1,500)"],
    });
    expect(path.daemon).toBeNull();
    // The count said once (#228), with the reach.
    expect(describeWorldDaemonPath(path)).toEqual([
      "Daedalus: not joined; 1 of 30 augmentations installed, 37 more within reach (CyberSec 5, NiteSec 7, The Black " +
        "Hand 6, BitRunners 6, Tian Di Hui 8, Chongqing 1, New Tokyo 1, Ishima 3); needs $5,000,000,000 of $100,000,000,000, hacking 2,000 of 2,500 (or every combat skill 1,500)",
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

  test("Source-File 1 at 3: BitNode 1 gives nothing more, so no destroy; logged once and loud at once", () => {
    expect(nextBitNodeProblem({ 1: 2 })).toBeNull();
    const problem = nextBitNodeProblem({ 1: 3 });
    expect(problem).toBe(
      "Source-File 1 is at level 3, so BitNode 1 gives nothing more: the next BitNode is yours (turn the switch off " +
        "and queue destroyBitNode)",
    );
    const atThree = { slowData: slow({ ownedSF: { 1: 3 } }) };
    expect(update({ ...atThree, nowMs: 0 })).toBe(false);
    expect(update({ ...atThree, nowMs: 1 })).toBe(false);
    expect(lines).toEqual([`world daemon: STALLED 0 min: the BitNode not destroyed: ${problem}`]);
    expect(rule.stall()).toEqual({ step: "nextBitNode", sinceMs: 0, detail: `the BitNode not destroyed: ${problem}` });
    // Off, it's the owner's: quiet.
    update({ ...atThree, enabled: false });
    expect(rule.stall()).toBeNull();
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

describe("Daedalus out of reach (#228)", () => {
  const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
  /** Run #2's 23: the four hacker factions' set with a hacking value, and NeuroFlux Governor. */
  const TWENTY_THREE: Record<string, number> = {
    ...Object.fromEntries(
      [...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))]
        .filter((name) => isWorthInstalling(name))
        .map((name) => [name, 1]),
    ),
    "NeuroFlux Governor": 124,
  };
  /** BN12 at Source-File 12 level 500: 40 for Daedalus (core's `daedalusAugmentationsRequired`). */
  const BN12 = { currentNode: 12, ownedSF: { 12: 500 } };
  const short = (hacking: number, bitNode: { currentNode?: number; ownedSF?: Record<string, number> } = BN12) => ({
    mediumData: medium({ hacking, money: 1e12 }),
    slowData: slow({ ownedAugs: TWENTY_THREE, ...bitNode }),
  });
  const DETAIL =
    "Daedalus out of reach: 23 of 40 augmentations installed, 15 more within reach (The Black Hand 1, BitRunners 1, " +
    "Tian Di Hui 8, Chongqing 1, New Tokyo 1, Ishima 3)";

  test("23 installed: run #2's", () => {
    expect(Object.keys(TWENTY_THREE)).toHaveLength(23);
  });

  test("short, the count and the reach under the requirement, no install under way: the failure 30 minutes on, once", () => {
    // BN12's 40: the hacker factions' two left, Tian Di Hui's eight and group B's five make 38.
    update({ ...short(50), nowMs: 0 });
    expect(rule.view().lines[0]).toBe(
      `Daedalus: not joined; ${DETAIL.slice("Daedalus out of reach: ".length)}: Daedalus out of reach; needs hacking 50 ` +
        "of 2,500 (or every combat skill 1,500)",
    );
    update({ ...short(50), nowMs: DAEDALUS_OUT_OF_REACH_AFTER_MS - 1 });
    expect(rule.stall()).toBeNull();
    update({ ...short(50), nowMs: DAEDALUS_OUT_OF_REACH_AFTER_MS });
    update({ ...short(50), nowMs: DAEDALUS_OUT_OF_REACH_AFTER_MS + MINUTE });
    expect(rule.stall()).toEqual({ step: "daedalusReach", sinceMs: 0, detail: DETAIL });
    expect(events).toEqual([
      {
        type: "worldDaemonStalled",
        atMs: DAEDALUS_OUT_OF_REACH_AFTER_MS,
        step: "daedalusReach",
        sinceMs: 0,
        detail: DETAIL,
      },
    ]);
    expect(lines).toEqual([`world daemon: STALLED 30 min: ${DETAIL}`]);
  });

  test("quiet while the reach makes it up: BN1's 30, run #2's end with 15 more", () => {
    update({ ...short(50, {}), nowMs: 0 });
    update({ ...short(50, {}), nowMs: 2 * DAEDALUS_OUT_OF_REACH_AFTER_MS });
    expect(rule.stall()).toBeNull();
    expect(rule.view().lines[0]).toBe(
      "Daedalus: not joined; 23 of 30 augmentations installed, 15 more within reach (The Black Hand 1, BitRunners 1, " +
        "Tian Di Hui 8, Chongqing 1, New Tokyo 1, Ishima 3); needs hacking 50 of 2,500 (or every combat skill 1,500)",
    );
  });

  test("an install under way waits it out, and starts it afresh", () => {
    update({ ...short(50), nowMs: 0 });
    update({ ...short(50), nowMs: 20 * MINUTE, installing: true });
    update({ ...short(50), nowMs: DAEDALUS_OUT_OF_REACH_AFTER_MS + MINUTE });
    expect(rule.stall()).toBeNull();
    update({ ...short(50), nowMs: 20 * MINUTE + 2 * DAEDALUS_OUT_OF_REACH_AFTER_MS });
    expect(rule.stall()).toMatchObject({ step: "daedalusReach" });
  });

  test("the run report: a failure, said as such", () => {
    const failures: string[] = [];
    const stored = {
      atMs: DAEDALUS_OUT_OF_REACH_AFTER_MS,
      kind: "worldDaemonStalled",
      detail: { step: "daedalusReach", sinceMs: 0, detail: DETAIL },
    };
    const health = new WorldDaemonFold().healthLines([stored as never], failures, (ms) => `t${ms}`);
    expect(health[1]).toBe(`    ${DETAIL}, from t0 to at least t${DAEDALUS_OUT_OF_REACH_AFTER_MS}`);
    expect(failures).toEqual([`${DETAIL}, from t0 to at least t${DAEDALUS_OUT_OF_REACH_AFTER_MS}`]);
  });
});
