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
import {
  BLADEBURNER_LEVELS_SETTING,
  BLADEBURNER_PRICED_REBUILD_SETTING,
  BladeburnerRule,
  readBladeburnerLevels,
} from "../src/bladeburner.ts";
import { BladeburnerFold } from "../src/bladeburner-report.ts";
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

/** The planner's priced rebuild (#407's review) for the install that ends the cycle from `lastAugReset`, as A6's. */
function price(settings: ReturnType<typeof memorySettings>, lastAugReset: number, seconds: number) {
  settings.setSetting(BLADEBURNER_PRICED_REBUILD_SETTING, JSON.stringify({ lastAugReset, seconds }));
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
      previousAugReset: null,
      levels: { strength: 100, defense: 100, dexterity: 100, agility: 100 },
      rebuild: null,
    });
    // An install the planner priced at its rebuild: the next cycle's first reading, every stat at 1, Training at once.
    price(settings, 0, skillExpFor(100, 1));
    expect(decide(rule, 1, HOUR, 0).state?.action).toEqual(TRAINING_ORDER);
    const rebuild = rule.view().rebuild;
    expect(rebuild?.targets).toEqual({ strength: 100, defense: 100, dexterity: 100, agility: 100 });
    // Its bound (#407's review): twice the price and 10 minutes.
    expect(rebuild).toMatchObject({ skipped: false, pricedSeconds: skillExpFor(100, 1) });
    expect(rebuild?.boundSeconds).toBeCloseTo(2 * skillExpFor(100, 1) + 600, 6);
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
    price(settings, 0, skillExpFor(300, 1));
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

  test("a second install mid-rebuild (#407's review): the targets stay the levels before the first, not the partial", () => {
    const settings = memorySettings();
    const rule = new BladeburnerRule(() => {}, undefined, settings);
    decide(rule, 100, 0);
    price(settings, 0, skillExpFor(100, 1));
    decide(rule, 1, HOUR);
    expect(decide(rule, 50, HOUR).state?.action).toEqual(TRAINING_ORDER);
    // Installed again at 50 of 100: the next cycle rebuilds to 100, not 50 (#407's review: 49d37a7 took 50).
    price(settings, HOUR, skillExpFor(100, 1));
    expect(decide(rule, 1, 2 * HOUR).state?.action).toEqual(TRAINING_ORDER);
    expect(rule.view().rebuild?.targets).toEqual({ strength: 100, defense: 100, dexterity: 100, agility: 100 });
  });

  test("a rebuild past its bound (#407's review): a manual install at combat 600, unpriced: the actions, and the report fails", () => {
    const settings = memorySettings();
    const events: { type: string; skipped?: boolean }[] = [];
    const lines: string[] = [];
    const rule = new BladeburnerRule(
      (line) => lines.push(line),
      (event) => events.push(event),
      settings,
    );
    decide(rule, 600, 0, 0);
    // Yours (no price): Training to 600 is about 2 × 10⁵ h at ×1, past 10 min.
    expect(decide(rule, 1, HOUR, 1000).state?.action).not.toEqual(TRAINING_ORDER);
    expect(rule.view().rebuild).toMatchObject({ skipped: true, pricedSeconds: null, boundSeconds: 600 });
    expect(rule.rebuilding()).toBeNull();
    expect(rule.view().line).toContain("not rebuilding the combat stats the install reset (#404): Training's ");
    expect(lines).toContainEqual(expect.stringContaining("not rebuilt: Training's"));
    const started = events.filter((event) => event.type === "bladeburnerRebuild");
    expect(started).toEqual([expect.objectContaining({ started: true, skipped: true, boundSeconds: 600 })]);
    // Priced by the planner, but far short of 600's: past twice the price and 10 min, the same.
    const priced = memorySettings();
    const other = new BladeburnerRule(() => {}, undefined, priced);
    decide(other, 600, 0, 0);
    price(priced, 0, 3600);
    expect(decide(other, 1, HOUR, 1000).state?.action).not.toEqual(TRAINING_ORDER);
    expect(other.view().rebuild).toMatchObject({ skipped: true, pricedSeconds: 3600, boundSeconds: 7800 });
    // The run report's section 8: a failure.
    const fold = new BladeburnerFold(
      started.map((event) => ({ kind: "bladeburnerRebuild", atMs: 1000, detail: event })),
    );
    fold.addSlow(0, slow(6, { lastAugReset: HOUR }));
    fold.addMedium(1000, medium(1));
    const failures: string[] = [];
    const section = fold.section(failures, 2000);
    expect(failures).toEqual([
      expect.stringMatching(
        /^the rebuild after an install \(#404\) from .* to strength 600, defense 600, dexterity 600, agility 600 not run: Training's .* past its bound, 10 min \(10 min: the planner priced no rebuild for this install\): the stats left to the actions$/,
      ),
    ]);
    expect(section.join("\n")).toContain("not run: Training's");
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

  test("install now: EsperTech queued at combat 100 (it saves the grown route more than its rebuild's 3 h): at once", () => {
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
    expect(timing?.words).toContain(
      "the Black Ops' route (#404), the grown estimate of the time to the destroy (#408): keep ",
    );
    expect(events.filter((event) => event.type === "augmentationInstallChosen")).toEqual([
      expect.objectContaining({ reason: "the Black Ops' route" }),
    ]);
    expect(installAsked()).toBe(true);
  });

  test("its figures solved again 10 min of game time on, or at a new Black Op next (#408: the grown estimate's cost)", () => {
    const { controller, play } = connected();
    const keepMs = () => controller.augmentationsView().progress?.timing?.blackOps?.keepMs;
    const bitWire = () => slow(6, { queued: ["BitWire"] });
    play(1, bitWire, () => medium(100));
    const first = keepMs();
    expect(first).toEqual(expect.any(Number));
    // Within 10 min the figures stand, the rank risen or not.
    play(5, bitWire, () => medium(100, { rank: 2000 }), HOUR + 60_000);
    expect(keepMs()).toBe(first);
    // 10 min on, solved again: the rank risen (its points not read here, so fewer to come).
    play(10, bitWire, () => medium(100, { rank: 2000 }), HOUR + 6 * 60_000);
    const again = keepMs() as number;
    expect(again).not.toBe(first);
    // A new Black Op next: solved again at once.
    const zero = BLADEBURNER_BLACK_OPS[1] as (typeof BLADEBURNER_BLACK_OPS)[number];
    const chance = blackOpSuccessChance(zero, personAt(100), { penalty: 1 });
    play(
      1,
      bitWire,
      () => {
        const data = medium(100, { rank: 2600 });
        (data.bladeburner as { blackOp: unknown }).blackOp = { name: zero.name, chance: [chance, chance] };
        return data;
      },
      HOUR + 16 * 60_000,
    );
    expect(keepMs()).not.toBe(again);
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
    // The planner priced it (A6's record at its choice), so the rule runs it.
    expect(JSON.parse(store.getSetting(BLADEBURNER_PRICED_REBUILD_SETTING) as string)).toMatchObject({
      lastAugReset: 0,
    });
  });

  test("mid-rebuild (#407's review): A6 prices keep and install now at the rebuild's targets, not the stats now", () => {
    // A brain restarted mid-rebuild: the store's record (to 100, the install from the cycle at 0, priced).
    store.setSetting(
      BLADEBURNER_LEVELS_SETTING,
      JSON.stringify({
        lastNodeReset: 0,
        lastAugReset: 2 * HOUR,
        previousAugReset: 0,
        levels: { strength: 1, defense: 1, dexterity: 1, agility: 1 },
        rebuild: { strength: 100, defense: 100, dexterity: 100, agility: 100 },
      }),
    );
    store.setSetting(
      BLADEBURNER_PRICED_REBUILD_SETTING,
      JSON.stringify({ lastAugReset: 0, seconds: skillExpFor(100, 1) }),
    );
    const { controller, play } = connected();
    const events: { type: string; timing?: InstallTimingView }[] = [];
    controller.subscribe((event) => events.push(event as (typeof events)[number]));
    play(
      2,
      () => slow(6, { lastAugReset: 2 * HOUR, queued: ["Hyperion Plasma Cannon V1"] }),
      () => medium(1),
      2 * HOUR,
    );
    expect(controller.bladeburnerView().rebuild?.targets.agility).toBe(100);
    // Keeping: Training's rest of the rebuild (about 3.1 h from 1), then the route at 100; at the stats now it'd be never.
    // Installing Hyperion now is the same rebuild from 0 and a shorter route: chosen.
    const view = events.find((event) => event.type === "augmentationInstallChosen")?.timing?.blackOps;
    expect(view?.choice).toBe("install");
    expect(view?.keepMs).not.toBeNull();
    expect(view?.keepMs as number).toBeGreaterThan(0.9 * skillExpFor(100, 1) * 1000);
    expect(view?.keepMs as number).toBeLessThan(1e7 * 3_600_000);
    expect(view?.rebuildMs).toBeCloseTo(skillExpFor(100, 1) * 1000, -3);
  });

  test("the rebuild's stall: none within twice its priced rebuild and 10 min; past it, the World Daemon's", () => {
    const { controller, play } = connected();
    play(
      1,
      () => slow(6, { queued: [] }),
      () => medium(100),
    );
    // The planner's price for the install (as A6's at its choice): its estimate, 11,255 s (3 h 8 min) at Training's 1 a
    // second, so the bound twice it and 10 minutes, 6 h 25 min.
    store.setSetting(
      BLADEBURNER_PRICED_REBUILD_SETTING,
      JSON.stringify({ lastAugReset: 0, seconds: skillExpFor(100, 1) }),
    );
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
