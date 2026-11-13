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
  actionRankLoss,
  actionSuccessChance,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerPerson,
  blackOpRankLoss,
  blackOpSeconds,
  blackOpStaminaCost,
  blackOpsRouteEstimate,
  blackOpsRouteGrownEstimate,
  bladeburnerLevelledAction,
  bladeburnerSkillMultsOf,
  CONTROL_PROTOCOL_VERSION,
  chooseBladeburnerAction,
  chooseWinRoute,
  climbRiseLowerBound,
  climbWindowSeconds,
  combatPersonOf,
  encodeControlMessage,
  hackingExpForLevel,
  type Intent,
  type MediumSnapshotData,
  maxStaminaOf,
  type SlowSnapshotData,
  type SnapshotTier,
  skillExpFor,
  staminaGainPerSecond,
  worldDaemonRequiredLevel,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BLADEBURNER_REST_SLACK_MS } from "../src/bladeburner-actions-report.ts";
import {
  BLACK_OPS_GROWN_REFRESH_MS,
  BLACK_OPS_LAST_RANK,
  blackOpsDoneOf,
  blackOpsRouteOf,
  GrownEstimateMemo,
} from "../src/bladeburner-route.ts";
import { DesiredStateController, destroyBlackOpsOf } from "../src/desired-state.ts";
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
    // The climb's least rise (#400's review): Bernstein's lower bound at α 0.001 over its window, the plan's attempts
    // (the forecast's best: no rule's plan given) each at most its mean and a failure's loss at 110% under it.
    const climbing = chooseBladeburnerAction(input);
    const work = climbing.work as NonNullable<typeof climbing.work>;
    const action = bladeburnerLevelledAction(work.type, work.name) as NonNullable<
      ReturnType<typeof bladeburnerLevelledAction>
    >;
    const climbAttempts = {
      perSecond: climbing.duty / work.seconds,
      variance: work.rankVariance,
      below: work.rankMean + 1.1 * actionRankLoss(action, work.level),
    };
    const window = climbWindowSeconds(estimate.rate, (view.rankStallMs as number) / 1000, climbAttempts, 0.001);
    expect(view.climbWindowMs).toBeCloseTo(window * 1000, 3);
    expect(view.climbRise).toBeCloseTo(climbRiseLowerBound(estimate.rate, window, climbAttempts, 0.001), 6);
    expect(view.climbRise).toBeGreaterThan(0);
    // The rule's own plan where given (#400's round 2): its rate where under ρ is the mean; resting alone, not judged.
    const slower = { ...climbing, rankPerSecond: estimate.rate / 2 };
    const viewSlower = blackOpsRouteOf({
      mediumData: medium(reading(295_000, blackOp)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 2,
      expPerSecond: 1e4,
      soFarMs: 10 * 3_600_000,
      plan: slower,
    });
    const windowSlower = climbWindowSeconds(
      estimate.rate / 2,
      (view.rankStallMs as number) / 1000,
      climbAttempts,
      0.001,
    );
    expect(viewSlower.climbRise).toBeCloseTo(
      climbRiseLowerBound(estimate.rate / 2, windowSlower, climbAttempts, 0.001),
      6,
    );
    const resting = blackOpsRouteOf({
      mediumData: medium(reading(295_000, blackOp)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 2,
      expPerSecond: 1e4,
      soFarMs: 10 * 3_600_000,
      plan: { ...climbing, work: null },
    });
    expect(resting).toMatchObject({ climbRise: null, climbWindowMs: null });
    console.log(
      `the climb at combat 5,000: window ${(window / 60).toFixed(1)} min (base ${((view.rankStallMs as number) / 60_000).toFixed(1)}), ` +
        `least rise ${(view.climbRise as number).toFixed(0)} of the rate's ${(estimate.rate * window).toFixed(0)}`,
    );
    // The attempts' bound: ⌈ln 0.001 / ln(1 − 0.3)⌉ = 20 attempts, each with a failure's rebuild, a rest and 10 min.
    const attempts = Math.ceil(Math.log(0.001) / Math.log(1 - 0.3));
    expect(attempts).toBe(20);
    // Each attempt's own stamina regained at the natural regain (#400's round 2).
    const regain = staminaGainPerSecond(PERSON, r.maxStamina, mults);
    const stamina = Math.min(blackOpStaminaCost(CENTURION), r.maxStamina) / regain;
    expect(stamina).toBeGreaterThan(0);
    const each = blackOpSeconds(CENTURION, PERSON, mults) + blackOpRankLoss(CENTURION) / estimate.rate + stamina;
    expect(view.attemptsStallMs).toBeCloseTo((attempts * each + rest) * 1000 + BLADEBURNER_REST_SLACK_MS, 3);
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

/** A medium snapshot with the player's combat figures read (#408): each stat's experience at its level, multipliers 1. */
function withCombat(bladeburner: unknown): MediumSnapshotData {
  const data = medium(bladeburner);
  const player = data.player as { exp: Record<string, number>; mults: Record<string, number> };
  for (const stat of ["strength", "defense", "dexterity", "agility"]) {
    player.exp[stat] = skillExpFor(5000, 1);
    player.mults[stat] = 1;
    player.mults[`${stat}_exp`] = 1;
  }
  return data;
}

describe("the route's grown estimate in the brain (#408)", () => {
  const blackOp = { name: CENTURION.name, chance: [0.3, 0.35] as [number, number] };

  test("the planner's: core's grown estimate on the reading (B6's first time to its rank), chosen over B6's", () => {
    const view = blackOpsRouteOf({
      mediumData: withCombat({ ...reading(295_000, blackOp), skillPoints: 4 }),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 2,
      expPerSecond: 1e4,
      soFarMs: 10 * 3_600_000,
    });
    const combat = combatPersonOf(withCombat(reading(295_000, blackOp)).player);
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
    const grown = blackOpsRouteGrownEstimate(
      input,
      {
        rank: 295_000,
        next: CENTURION,
        chanceRead: blackOp.chance,
        firstToRankSeconds: view.estimate?.steps[0]?.toRankSeconds ?? null,
      },
      { combat: combat as NonNullable<typeof combat>, costMultiplier: 1, points: 4 },
    );
    expect(view.grown?.seconds).toBe(grown.seconds);
    expect(view.grown?.seconds).toBeLessThan(view.estimate?.seconds as number);
    expect(view.grownAtMs).toBeNull();
    // Without the player's combat figures (an older snapshot's): B6's alone, as before #408.
    const old = blackOpsRouteOf({
      mediumData: medium(reading(295_000, blackOp)),
      bitNode: 6,
      ownedSF: SF,
      rankPerSecond: 2,
      expPerSecond: 1e4,
      soFarMs: 10 * 3_600_000,
    });
    expect(old.grown).toBeNull();
    // The planner's choice reads the grown estimate: The Red Pill's between the two, the Black Ops chosen.
    const required = worldDaemonRequiredLevel(6, SF);
    const near = (expPerSecond: number) => {
      const data = withCombat({ ...reading(295_000, blackOp), skillPoints: 4 });
      const player = data.player as { skills: Record<string, number>; exp: Record<string, number> };
      player.skills = { ...player.skills, hacking: required - 1 };
      player.exp.hacking = hackingExpForLevel(required - 1, 0.35);
      return blackOpsRouteOf({
        mediumData: data,
        bitNode: 6,
        ownedSF: SF,
        rankPerSecond: 2,
        expPerSecond,
        soFarMs: 1e12,
      });
    };
    const once = near(1);
    const between = ((once.grown?.seconds as number) + (once.estimate?.seconds as number)) / 2;
    const close = near((once.redPillSeconds as number) / between);
    expect(close.redPillSeconds).toBeCloseTo(between, 0);
    expect(close.choice.route).toBe("blackOps");
    expect(
      chooseWinRoute({
        blackOpsSeconds: close.estimate?.seconds as number,
        redPillSeconds: close.redPillSeconds,
        soFarSeconds: 1e9,
      }).route,
    ).toBe("redPill");
    console.log(
      `combat 5,000 at rank 295,000: grown ${(grown.seconds / 3600).toFixed(2)} h, B6's ` +
        `${((view.estimate?.seconds as number) / 3600).toFixed(2)} h`,
    );
  });

  test("kept between solves: again after 10 min, at a new Black Op next, or with the time gone back; null never kept", () => {
    const memo = new GrownEstimateMemo();
    let solves = 0;
    const route = { steps: [], seconds: 1, rate: 1, path: [], solves: 1 };
    const solve = () => {
      solves += 1;
      return route;
    };
    expect(memo.get("6 Operation Centurion", 1000, solve)).toEqual({ value: route, atMs: 1000 });
    expect(memo.get("6 Operation Centurion", 1000 + BLACK_OPS_GROWN_REFRESH_MS - 1, solve).atMs).toBe(1000);
    expect(solves).toBe(1);
    expect(memo.get("6 Operation Centurion", 1000 + BLACK_OPS_GROWN_REFRESH_MS, solve).atMs).toBe(
      1000 + BLACK_OPS_GROWN_REFRESH_MS,
    );
    expect(solves).toBe(2);
    memo.get("6 Operation Vindictus", 1000 + BLACK_OPS_GROWN_REFRESH_MS, solve);
    expect(solves).toBe(3);
    memo.get("6 Operation Vindictus", 500, solve);
    expect(solves).toBe(4);
    expect(memo.get("6 Operation Daedalus", 600, () => null)).toEqual({ value: null, atMs: null });
    memo.get("6 Operation Daedalus", 700, solve);
    expect(solves).toBe(5);
    expect(BLACK_OPS_GROWN_REFRESH_MS).toBe(10 * 60_000);
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

  test("the grown estimate (#408): the path's and the destroy estimate's, kept 10 min between solves", () => {
    const { controller, send } = connected();
    send("slow", slow(6));
    const centurion = { name: CENTURION.name, chance: [0.3, 0.35] as [number, number] };
    send("medium", withCombat(reading(295_000, centurion)));
    const view = controller.worldDaemonView().path?.blackOps;
    expect(view?.grown).not.toBeNull();
    expect(view?.grown?.seconds).toBeLessThan(view?.estimate?.seconds as number);
    const solvedAt = view?.grownAtMs as number;
    expect(solvedAt).toEqual(expect.any(Number));
    expect(controller.worldDaemonView().lines[1]).toContain("with the competence's growth (#408");
    // Within 10 min the figures stand (a new reading, the same Black Op next); a new Black Op next solves again.
    send("medium", withCombat(reading(296_000, centurion)));
    expect(controller.worldDaemonView().path?.blackOps?.grown).toBe(view?.grown);
    expect(controller.worldDaemonView().path?.blackOps?.grownAtMs).toBe(solvedAt);
    send("medium", withCombat(reading(301_000, { name: "Operation Vindictus", chance: [0.3, 0.35] })));
    const vindictus = controller.worldDaemonView().path?.blackOps?.grown;
    expect(vindictus).not.toBe(view?.grown);
    expect(vindictus?.steps[0]?.name).toBe("Operation Vindictus");
    // The destroy estimate's BO (#360) the grown estimate where read, said so; else B6's.
    const route = controller.worldDaemonView().path?.blackOps ?? null;
    expect(destroyBlackOpsOf(route)).toMatchObject({ ms: (vindictus?.seconds as number) * 1000, grown: true });
    expect(destroyBlackOpsOf(route === null ? null : { ...route, grown: null })).toMatchObject({
      ms: (route?.estimate?.seconds as number) * 1000,
      grown: false,
    });
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
