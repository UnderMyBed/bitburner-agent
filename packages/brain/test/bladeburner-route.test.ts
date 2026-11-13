// Bladeburner B6 (#398): BN6's win route in the brain. The route read from a medium snapshot (the Black Ops done, the
// next one, core's estimate of both routes, the rank's stall bound), the gate's guard on all 21 done, levelling off on
// this route only, and the controller: the destroy asked for only with all 21 done, in BN6 alone. Core's sum and its
// walk are core's bladeburner-route.test.ts; the rule's stalls world-daemon.test.ts's; the destroy itself in the
// engine bn6-destroy-simulation.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerPerson,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpsRouteEstimate,
  bladeburnerSkillMultsOf,
  CONTROL_PROTOCOL_VERSION,
  encodeControlMessage,
  type Intent,
  type MediumSnapshotData,
  maxStaminaOf,
  type SlowSnapshotData,
  type SnapshotTier,
  staminaGainPerSecond,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BLADEBURNER_REST_SLACK_MS } from "../src/bladeburner-actions-report.ts";
import { BLACK_OPS_LAST_RANK, blackOpsDoneOf, blackOpsRouteOf } from "../src/bladeburner-route.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { guardFailure } from "../src/irreversible-gate.ts";
import { levelAllThatsLeft } from "../src/levelling.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { worldDaemonDestroyIntent, worldDaemonPath } from "../src/world-daemon.ts";
import { slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

/** The player in BN6's division, combat 5,000: every multiplier 1. */
const PERSON: BladeburnerPerson = {
  skills: { hacking: 100, strength: 5000, defense: 5000, dexterity: 5000, agility: 5000, charisma: 1, intelligence: 0 },
  mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
};
const CITY = { population: 1e9, communities: 50, chaos: 0 };
const LEVELS = { "Blade's Intuition": 40, Overclock: 50 };
const CENTURION = BLADEBURNER_BLACK_OPS[18] as (typeof BLADEBURNER_BLACK_OPS)[number];

/** The worker's reading in the division at `rank`, the next Black Op `blackOp` (null: all done). */
function reading(rank: number, blackOp: { name: string; chance: [number, number] } | null | undefined) {
  const skills = bladeburnerSkillMultsOf(LEVELS);
  const maxStamina = maxStaminaOf(PERSON, 0, skills);
  return {
    rank,
    problems: [],
    stamina: maxStamina,
    maxStamina,
    bonusSeconds: 0,
    found: null,
    current: null,
    actions: BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
      const chance = actionSuccessChance(action, 1, PERSON, { city: CITY, penalty: 1, skills });
      return { type: action.type, name: action.name, level: 1, maxLevel: 5, count: 50, chance: [chance, chance] };
    }),
    skillPoints: 0,
    skillLevels: Object.fromEntries(
      BLADEBURNER_SKILL_NAMES.map((name) => [name, (LEVELS as Record<string, number>)[name] ?? 0]),
    ),
    ...(blackOp === undefined ? {} : { blackOp }),
  };
}

/** A medium snapshot in the division, home 256 GB, the Bladeburners faction joined, hacking 100 at multiplier 0.35. */
function medium(bladeburner: unknown): MediumSnapshotData {
  return {
    player: {
      skills: PERSON.skills,
      exp: {
        strength: 1e9,
        defense: 1e9,
        dexterity: 1e9,
        agility: 1e9,
        hacking: Math.exp((100 / 0.35 + 200) / 32) - 534.6,
        charisma: 0,
        intelligence: 0,
      },
      mults: { ...PERSON.mults, faction_rep: 1, hacking: 1, hacking_exp: 1 },
      money: 1e6,
      city: "Sector-12",
      factions: ["Bladeburners"],
      hp: { current: 20, max: 20 },
    },
    hasTorRouter: false,
    programs: [],
    servers: [
      { hostname: "home", maxRam: 256, cpuCores: 1, hasAdminRights: true, moneyAvailable: 0, hackDifficulty: 1 },
    ],
    inBladeburner: true,
    bladeburner,
  } as unknown as MediumSnapshotData;
}

const SF = { 1: 3, 2: 3, 4: 3, 5: 1 };
const slow = (currentNode: number, fields: Partial<SlowSnapshotData["resetInfo"]> = {}): SlowSnapshotData => {
  const data = slowData(currentNode);
  return { ...data, resetInfo: { ...data.resetInfo, ownedSF: SF, ...fields } as SlowSnapshotData["resetInfo"] };
};

describe("the route from the reading (#398)", () => {
  const blackOp = { name: CENTURION.name, chance: [0.3, 0.35] as [number, number] };

  test("the count, the next one, core's estimate, the ETA at the rate measured, the stall bound, both routes", () => {
    const view = blackOpsRouteOf({
      mediumData: medium(reading(295_000, blackOp)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 2,
      expPerSecond: 1e4,
      soFarMs: 10 * 3_600_000,
    });
    expect(view).toMatchObject({ rank: 295_000, done: 18, next: { name: CENTURION.name, rank: 300_000 } });
    expect(view.etaSeconds).toBe((BLACK_OPS_LAST_RANK - 295_000) / 2);
    expect(BLACK_OPS_LAST_RANK).toBe(400_000);
    // Core's estimate on the same input (its next one's rank solved by core: no rule's time given).
    const r = reading(295_000, blackOp);
    const input = {
      readings: r.actions as never,
      person: PERSON,
      stamina: r.stamina,
      maxStamina: r.maxStamina,
      rankMultiplier: 1,
      speed: 1,
      skills: {
        read: Object.fromEntries(
          BLADEBURNER_SKILL_NAMES.map((name) => [name, (LEVELS as Record<string, number>)[name] ?? 0]),
        ),
      },
    };
    const estimate = blackOpsRouteEstimate(input, { rank: 295_000, next: CENTURION, chanceRead: blackOp.chance });
    expect(view.estimate?.seconds).toBeCloseTo(estimate.seconds, 6);
    expect(view.next?.chance).toBeCloseTo(0.3, 12);
    // The stall bound: twice a rest from ½ max at the natural regain, the attempt and a failure's rebuild, and 10 min.
    const mults = bladeburnerSkillMultsOf(LEVELS);
    const rest = r.maxStamina / 2 / staminaGainPerSecond(PERSON, r.maxStamina, mults);
    const bound = 2 * (rest + blackOpSeconds(CENTURION, PERSON, mults) + blackOpRankLoss(CENTURION) / estimate.rate);
    expect(view.rankStallMs).toBeCloseTo(bound * 1000 + BLADEBURNER_REST_SLACK_MS, 3);
    // The Red Pill's at hacking 100 against 6,000 at 0.35: hopeless by the formulas against 10 h so far.
    expect(view.redPillSeconds).toBeGreaterThan(1e30);
    expect(view.choice).toMatchObject({ route: "blackOps", redPillHopeless: true });
    // The rule's own time to the next one's rank, where given, is the first term.
    const given = blackOpsRouteOf({
      mediumData: medium(reading(295_000, blackOp)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: null,
      expPerSecond: null,
      soFarMs: null,
      firstToRankSeconds: 77,
    });
    expect(given.estimate?.steps[0]?.toRankSeconds).toBe(77);
    expect(given).toMatchObject({ etaSeconds: null, redPillSeconds: null, choice: { redPillHopeless: null } });
  });

  test("all 21 done: the count 21, nothing next, the route's time 0; unread: nothing", () => {
    const done = blackOpsRouteOf({
      mediumData: medium(reading(440_000, null)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 1,
      expPerSecond: null,
      soFarMs: null,
    });
    expect(done).toMatchObject({ done: 21, next: null, estimate: { seconds: 0 }, rankStallMs: null });
    const unread = blackOpsRouteOf({
      mediumData: null,
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: null,
      expPerSecond: null,
      soFarMs: null,
    });
    expect(unread).toMatchObject({ rank: null, done: null, next: null, estimate: null });
    // A B4 Agent's reading (no Black Op read): the count unread.
    expect(blackOpsDoneOf(undefined)).toBeNull();
    expect(blackOpsDoneOf(null)).toBe(21);
    expect(blackOpsDoneOf({ name: BLADEBURNER_BLACK_OPS[0]?.name as string })).toBe(0);
    expect(blackOpsDoneOf({ name: "not one" })).toBeNull();
  });
});

describe("the gate's guard (#398): all 21 done stands in for w0r1d_d43m0n's hacking level", () => {
  const destroy = worldDaemonDestroyIntent(6) as Intent;
  test("none next: the guard holds with no w0r1d_d43m0n; one next: both routes' problems said", () => {
    expect(guardFailure(destroy, medium(reading(440_000, null)), [destroy], null)).toBeNull();
    const short = guardFailure(
      destroy,
      medium(reading(400_100, { name: "Operation Daedalus", chance: [0.4, 0.4] })),
      [destroy],
      null,
    );
    expect(short).toBe("w0r1d_d43m0n isn't reachable: The Red Pill isn't installed; and 20 of the 21 Black Ops done");
    // w0r1d_d43m0n listed with no static snapshot for its level: all 21 done holds all the same.
    const listed = {
      ...medium(reading(440_000, null)),
      servers: [{ hostname: "w0r1d_d43m0n", maxRam: 0, cpuCores: 1, hasAdminRights: false }],
    } as unknown as MediumSnapshotData;
    expect(guardFailure(destroy, listed, [destroy], null)).toBeNull();
    // No Bladeburner reading: The Red Pill's alone, as before.
    expect(guardFailure(destroy, medium(undefined), [destroy], null)).toBe(
      "w0r1d_d43m0n isn't reachable: The Red Pill isn't installed",
    );
  });
});

describe("levelling off on this route only (#398)", () => {
  test("The Red Pill installed, w0r1d_d43m0n rooted, the level short: levelling's in BN4 and BN5, not BN6", () => {
    const at = (currentNode: number) =>
      levelAllThatsLeft(
        worldDaemonPath({
          staticData: { servers: [{ hostname: "w0r1d_d43m0n", requiredHackingSkill: 6000 }] } as never,
          mediumData: {
            ...medium(undefined),
            servers: [{ hostname: "w0r1d_d43m0n", maxRam: 0, cpuCores: 1, hasAdminRights: true }],
          } as unknown as MediumSnapshotData,
          slowData: slow(currentNode, { ownedAugs: { "The Red Pill": 1 } }),
          expPerSecond: 1,
        }),
      );
    expect(at(4)).toBe(true);
    expect(at(5)).toBe(true);
    expect(at(6)).toBe(false);
  });
});

describe("the controller (#398)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-route-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const controller = new DesiredStateController({
      channel,
      store,
      saveBackups: { backupNow: () => new Promise(() => {}) },
      log: () => {},
    });
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
    const send = (tier: SnapshotTier, data: unknown) =>
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier,
          sequenceNumber: ++sequenceNumber,
          gameTimeMs: 1_000 * sequenceNumber,
          data,
        }),
      );
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    return { controller, send };
  }

  test("in BN6: the path is the Black Ops'; the destroy asked for only once all 21 are done, into the order's next", () => {
    const { controller, send } = connected();
    send("slow", slow(6));
    send("medium", medium(reading(400_100, { name: "Operation Daedalus", chance: [0.4, 0.4] })));
    expect(controller.worldDaemonView()).toMatchObject({ destroying: false, path: { route: "blackOps" } });
    expect(controller.worldDaemonView().path?.blackOps).toMatchObject({ done: 20 });
    expect(controller.worldDaemonView().lines[0]).toContain("20 of 21 done; next Operation Daedalus");
    send("medium", medium(reading(440_000, null)));
    expect(controller.worldDaemonView()).toMatchObject({ destroying: true, nextBitNode: 5 });
  });

  test("nothing in other BitNodes: BN4 and BN5 with the same reading read no route, and ask no destroy", () => {
    for (const bitNode of [4, 5]) {
      const { controller, send } = connected();
      send("slow", slow(bitNode));
      send("medium", medium(reading(440_000, null)));
      expect(controller.worldDaemonView(), `BN${bitNode}`).toMatchObject({
        destroying: false,
        path: { route: "redPill", blackOps: null },
      });
    }
  });
});
