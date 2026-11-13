// Bladeburner B7 (#404): augmentations and installs on the Black Ops' route. The Bladeburner rule's rebuild after an
// install (Training back to the levels before it, within one reading, a restart keeping it), and at the controller the
// planner's install timing on both sides (install now against keep), the rule back within one reading of an install,
// the rebuild's stall on both sides of its bound, and nothing of it outside BN6 and BN7 or before the join. Core's
// figures are core's bladeburner-installs.test.ts's; against the real engine, bn6-install-simulation.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_TRAINING,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  blackOpSuccessChance,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  intentId,
  type MediumSnapshotData,
  maxStaminaOf,
  type SlowSnapshotData,
  type SnapshotTier,
  skillExpFor,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BLACK_OPS_ROUTE, type InstallTimingView } from "../src/augmentations.ts";
import { BLADEBURNER_LEVELS_SETTING, BladeburnerRule, readBladeburnerLevels } from "../src/bladeburner.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const HOUR = 3_600_000;
const TYPHOON = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];
const TRAINING_ORDER = { type: "General", name: BLADEBURNER_TRAINING, level: null };
const ESPERTECH = "EsperTech Bladeburner Eyewear";

/** The player in BN6's division at `combat`: hacking and charisma 1, no intelligence, every multiplier 1. */
const personAt = (combat: number): BladeburnerPerson => ({
  skills: {
    hacking: 1,
    strength: combat,
    defense: combat,
    dexterity: combat,
    agility: combat,
    charisma: 1,
    intelligence: 0,
  },
  mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
});
const CITY = { population: 1e9, communities: 50, chaos: 0 };

/** The worker's reading at `combat`: every contract and operation at level 1 of 1, rested, Typhoon next. */
function reading(combat: number, rank: number) {
  const person = personAt(combat);
  const actions: BladeburnerActionReading[] = BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, person, { city: CITY, penalty: 1 });
    return { type: action.type, name: action.name, level: 1, maxLevel: 1, count: 50, chance: [chance, chance] };
  });
  const maxStamina = maxStaminaOf(person, 0);
  const typhoon = blackOpSuccessChance(TYPHOON, person, { penalty: 1 });
  return {
    rank,
    problems: [],
    stamina: maxStamina,
    maxStamina,
    bonusSeconds: 0,
    found: null,
    current: null,
    actions,
    blackOp: { name: TYPHOON.name, chance: [typhoon, typhoon] },
  };
}

/** A medium snapshot in the division at `combat` (its experience at ×1), rank `rank`, home 128 GB. */
function medium(combat: number, { rank = 1000, money = 0, inBladeburner = true } = {}): MediumSnapshotData {
  const person = personAt(combat);
  const exp = combat <= 1 ? 0 : skillExpFor(combat, 1);
  return {
    player: {
      skills: person.skills,
      exp: { strength: exp, defense: exp, dexterity: exp, agility: exp, hacking: 0, charisma: 0, intelligence: 0 },
      mults: {
        ...person.mults,
        strength: 1,
        defense: 1,
        dexterity: 1,
        agility: 1,
        strength_exp: 1,
        defense_exp: 1,
        dexterity_exp: 1,
        agility_exp: 1,
        faction_rep: 1,
        hacking: 1,
        hacking_exp: 1,
        charisma: 1,
        charisma_exp: 1,
      },
      money,
      city: "Sector-12",
      factions: ["Bladeburners"],
      hp: { current: 20, max: 20 },
    },
    hasTorRouter: false,
    programs: [],
    servers: [
      {
        hostname: "home",
        maxRam: 128,
        cpuCores: 1,
        hasAdminRights: true,
        backdoorInstalled: false,
        moneyAvailable: 0,
        hackDifficulty: 1,
      },
    ],
    inBladeburner,
    ...(inBladeburner ? { bladeburner: reading(combat, rank) } : {}),
  } as unknown as MediumSnapshotData;
}

/** A slow snapshot of `bitNode` in the cycle from `lastAugReset`, Bladeburners joined, `queued` bought already. */
function slow(
  bitNode: number,
  { lastAugReset = 0, queued = [] as string[], ownedSF = {} as Record<string, number>, ownedAugs = {} } = {},
): SlowSnapshotData {
  const data = slowData(bitNode);
  return {
    ...data,
    resetInfo: { ...data.resetInfo, lastAugReset, ownedSF, ownedAugs } as SlowSnapshotData["resetInfo"],
    factions: {
      backend: "sim",
      state: {
        joined: [{ name: "Bladeburners", reputation: 5000, favor: 0 }],
        invitations: [],
        queuedAugmentations: queued,
      },
      problem: null,
    },
  };
}

/** A settings store in memory, as the rule keeps its record in the brain's. */
function memorySettings() {
  const settings = new Map<string, string>();
  return {
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => void settings.set(key, value),
  };
}

describe("the rebuild after an install (#404): Training back to the levels before it", () => {
  const decide = (rule: BladeburnerRule, combat: number, lastAugReset: number, nowMs: number | null = null) =>
    rule.update({ mediumData: medium(combat), slowData: slow(6, { lastAugReset }), homeKeptGb: 32, nowMs });

  test("the next cycle's first reading: Training, ahead of the rest, until all four are back; then B2's order", () => {
    const lines: string[] = [];
    const settings = memorySettings();
    const rule = new BladeburnerRule((line) => lines.push(line), undefined, settings);
    expect(decide(rule, 100, 0).state?.action).not.toEqual(TRAINING_ORDER);
    expect(readBladeburnerLevels(settings)).toEqual({
      lastNodeReset: 0,
      lastAugReset: 0,
      levels: { strength: 100, defense: 100, dexterity: 100, agility: 100 },
      rebuild: null,
    });
    // An install: the next cycle's first reading, every stat at 1, Training at once.
    expect(decide(rule, 1, HOUR, 0).state?.action).toEqual(TRAINING_ORDER);
    const rebuild = rule.view().rebuild;
    expect(rebuild?.targets).toEqual({ strength: 100, defense: 100, dexterity: 100, agility: 100 });
    // At ×1 from 0: level 100's experience at Training's 1 a second (30 × 1² each 30 s).
    expect(rebuild?.seconds).toBeCloseTo(skillExpFor(100, 1), 6);
    expect(rule.view().line).toContain(
      "rebuilding the combat stats the install reset (#404): Training, strength 1 of 100, defense 1 of 100",
    );
    expect(lines).toContainEqual(expect.stringContaining("an install reset the combat stats (#404): rebuilding to"));
    // Halfway: still Training, its estimate the time left.
    expect(decide(rule, 60, HOUR, 1000).state?.action).toEqual(TRAINING_ORDER);
    expect(rule.view().rebuild?.firstSeconds).toBeCloseTo(skillExpFor(100, 1), 6);
    expect(rule.view().rebuild?.sinceMs).toBe(0);
    // Back at 100: B2's order, the rebuild over and said.
    expect(decide(rule, 100, HOUR, 2000).state?.action).not.toEqual(TRAINING_ORDER);
    expect(rule.view().rebuild).toBeNull();
    expect(lines).toContainEqual("bladeburner: the combat stats rebuilt after the install (#404)");
  });

  test("a restart mid-rebuild keeps it (the store's record); none with no cycle before it seen; the owner's work holds", () => {
    const settings = memorySettings();
    decide(new BladeburnerRule(() => {}, undefined, settings), 300, 0);
    decide(new BladeburnerRule(() => {}, undefined, settings), 1, HOUR);
    const restarted = new BladeburnerRule(() => {}, undefined, settings);
    expect(decide(restarted, 50, HOUR).state?.action).toEqual(TRAINING_ORDER);
    expect(restarted.view().rebuild?.targets.agility).toBe(300);
    expect(JSON.parse(settings.getSetting(BLADEBURNER_LEVELS_SETTING) as string)).toMatchObject({
      lastAugReset: HOUR,
      levels: { strength: 50 },
      rebuild: { strength: 300 },
    });
    // A destroy's new BitNode (its own start): Bladeburner cleared, nothing to rebuild to there.
    const destroyed = new BladeburnerRule(() => {}, undefined, settings);
    const next = slow(6, { lastAugReset: 3 * HOUR });
    const afterDestroy = destroyed.update({
      mediumData: medium(1),
      slowData: { ...next, resetInfo: { ...next.resetInfo, lastNodeReset: 3 * HOUR } },
      homeKeptGb: 32,
    });
    expect(afterDestroy.state?.action).not.toEqual(TRAINING_ORDER);
    expect(destroyed.view().rebuild).toBeNull();
    // A store with no record (a cycle not seen before): no targets, B2's order (the actions rebuild them, labelled).
    const fresh = new BladeburnerRule(() => {}, undefined, memorySettings());
    expect(decide(fresh, 1, 2 * HOUR).state?.action).not.toEqual(TRAINING_ORDER);
    expect(fresh.view().rebuild).toBeNull();
    // The owner's work on the dashboard: no action, the rebuild still said in the view.
    const held = new BladeburnerRule(() => {}, undefined, settings);
    const decision = held.update({
      mediumData: medium(50),
      slowData: slow(6, { lastAugReset: HOUR }),
      homeKeptGb: 32,
      ownersWork: true,
    });
    expect(decision.state?.action).toBeUndefined();
    expect(held.view().line).toContain("actions held for your work on the dashboard");
  });
});

describe("the controller (#404): the planner's install timing on the Black Ops' route", () => {
  const TOKEN = "the-token";
  const INSTALL_ID = intentId("installAugmentations", {});
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let clock: ManualClock;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-installs-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    clock = new ManualClock();
    channel = new ControlChannel({ token: TOKEN, clock });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const lines: string[] = [];
    const controller = new DesiredStateController({
      channel,
      store,
      saveBackups: { backupNow: () => new Promise(() => {}) },
      log: (line) => lines.push(line),
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
    const send = (tier: SnapshotTier, data: unknown, gameTimeMs = 1_000) =>
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
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    const last = () =>
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as unknown as DesiredState | undefined;
    /** `minutes` of a slow and a medium snapshot a minute. */
    const play = (
      minutes: number,
      slowOf: () => SlowSnapshotData,
      mediumOf: (minute: number) => MediumSnapshotData,
      fromMs = HOUR,
    ) => {
      for (let minute = 0; minute < minutes; minute += 1) {
        clock.advance(60_000);
        const gameTimeMs = fromMs + (minute + 1) * 60_000;
        send("slow", slowOf(), gameTimeMs);
        send("medium", mediumOf(minute), gameTimeMs);
      }
    };
    const installAsked = () => controller.intentsView().some((each) => each.id === INSTALL_ID);
    return { controller, send, last, lines, play, installAsked };
  }

  test("install now: EsperTech queued at combat 100 (the route's 5 million h against its rebuild's 3 h): at once", () => {
    const { controller, play, installAsked } = connected();
    const events: { type: string; reason?: string; timing?: InstallTimingView }[] = [];
    controller.subscribe((event) => events.push(event as (typeof events)[number]));
    play(
      2,
      () => slow(6, { queued: [ESPERTECH] }),
      () => medium(100),
    );
    const timing = events.find((event) => event.type === "augmentationInstallChosen")?.timing;
    expect(timing).toMatchObject({ route: BLACK_OPS_ROUTE, choice: 0, blackOps: { choice: "install" } });
    const view = timing?.blackOps;
    expect(view?.rebuildMs).toBeCloseTo(skillExpFor(100, 1) * 1000, 0);
    expect(view?.installNowMs as number).toBeLessThan(view?.keepMs as number);
    expect(view?.gain.successChance).toBe(1.03);
    expect(timing?.words).toContain("the Black Ops' route (#404), B6's estimate of the time to the destroy: keep ");
    expect(events.filter((event) => event.type === "augmentationInstallChosen")).toEqual([
      expect.objectContaining({ reason: "the Black Ops' route" }),
    ]);
    expect(installAsked()).toBe(true);
  });

  test("keep: a hacking augmentation alone (its rebuild for nothing on the route): no install, decided at each update", () => {
    const { controller, play, installAsked, lines } = connected();
    play(
      30,
      () => slow(6, { queued: ["BitWire"] }),
      () => medium(100),
    );
    const timing = controller.augmentationsView().progress?.timing;
    expect(timing).toMatchObject({ route: BLACK_OPS_ROUTE, choice: 1, blackOps: { choice: "keep" } });
    expect(timing?.blackOps?.afterMs).toBe(timing?.blackOps?.keepMs);
    expect(controller.augmentationsView().committed).toBe(false);
    expect(controller.augmentationsView().waitingFor).toContain("the planner's time to the destroy: ");
    expect(installAsked()).toBe(false);
    expect(lines).toContainEqual(
      expect.stringContaining("augmentations: the planner's install timing: the Black Ops'"),
    );
  });

  test("an install keeps the rank, skills and counts: the rule is back, Training, within one reading", () => {
    const { controller, play, last } = connected();
    play(
      2,
      () => slow(6, { queued: [ESPERTECH] }),
      () => medium(100, { rank: 1234 }),
    );
    expect(last()?.bladeburner?.action).not.toEqual(TRAINING_ORDER);
    // The install done: the next cycle, EsperTech installed, the stats at 1, the rank and the reading's figures kept.
    play(
      1,
      () => slow(6, { lastAugReset: 2 * HOUR, ownedAugs: { [ESPERTECH]: 1 } }),
      () => medium(1, { rank: 1234 }),
      2 * HOUR,
    );
    expect(last()?.bladeburner?.action).toEqual(TRAINING_ORDER);
    expect(controller.bladeburnerView().line).toContain("rank 1234.0");
    expect(controller.bladeburnerView().rebuild?.targets).toEqual({
      strength: 100,
      defense: 100,
      dexterity: 100,
      agility: 100,
    });
  });

  test("the rebuild's stall: none within twice its first estimate and 10 min; past it, the World Daemon's", () => {
    const { controller, play } = connected();
    play(
      1,
      () => slow(6, { queued: [] }),
      () => medium(100),
    );
    // Its first estimate 11,255 s (3 h 8 min) at Training's 1 a second: the bound 6 h 25 min.
    const next = () => slow(6, { lastAugReset: 2 * HOUR });
    play(6 * 60, next, () => medium(1), 2 * HOUR);
    expect(controller.worldDaemonView().stall).toBeNull();
    play(30, next, () => medium(1), 8 * HOUR);
    expect(controller.worldDaemonView().stall).toMatchObject({ step: "blackOpsRank" });
    expect(controller.worldDaemonView().stall?.detail).toContain(
      "the combat stats not rebuilt after the install (#404) by Training within",
    );
  });

  test("before the join, the count rule as before #404; outside BN6 and BN7 with SF6 and SF7, none of it", () => {
    const before = connected();
    before.play(
      2,
      () => slow(6, { queued: [ESPERTECH] }),
      () => medium(100, { inBladeburner: false }),
    );
    expect(before.controller.augmentationsView().progress?.timing?.route).not.toBe(BLACK_OPS_ROUTE);
    expect(before.controller.bladeburnerView().rebuild ?? null).toBeNull();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-installs-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
    const elsewhere = connected();
    elsewhere.play(
      2,
      () => slow(1, { queued: [ESPERTECH], ownedSF: { 6: 1, 7: 1 } }),
      () => medium(100),
    );
    expect(elsewhere.controller.augmentationsView().progress?.timing?.route).not.toBe(BLACK_OPS_ROUTE);
    expect(elsewhere.controller.bladeburnerView().stage).toBe("notManaged");
    expect(elsewhere.last()?.bladeburner).toBeUndefined();
  });
});
