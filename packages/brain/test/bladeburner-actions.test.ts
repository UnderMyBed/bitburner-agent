// Bladeburner B2 (#375): the brain's rule on the worker's readings in the division (the work or the rest at ½ stamina,
// the plan's action and level, the owner's work holding it, the bonus time, BN7's rank), the controller sending it as
// the worker's action with A5's work held for it and nothing outside BN6 and BN7, and the run report's actions with
// both of their failures. The rule against the real engine is bn6-actions-simulation.test.ts's; core's formulas
// against the engine's are bladeburner-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  CONTROL_PROTOCOL_VERSION,
  chooseBladeburnerAction,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  maxStaminaOf,
  type SlowSnapshotData,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BLADEBURNER_ACTIONS_HOLD,
  BladeburnerRule,
  bladeburnerSnapshotOf,
  bladeburnerSpeedOf,
} from "../src/bladeburner.ts";
import { BLADEBURNER_GAP_MS, BLADEBURNER_RANK_SIGMAS } from "../src/bladeburner-actions-report.ts";
import { BladeburnerFold } from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.UTC(2026, 0, 1);

/** The player in BN6's division: combat 100, hacking and charisma 1, no intelligence, every multiplier 1. */
const PERSON: BladeburnerPerson = {
  skills: { hacking: 1, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 1, intelligence: 0 },
  mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
};
const MAX_STAMINA = maxStaminaOf(PERSON, 0);
const CITY = { population: 1e9, communities: 50, chaos: 0 };

/** Every contract and operation at level 1 of `maxLevel`, its count, and the range collapsed on its chance. */
function actionReadings({ count = 100, maxLevel = 1 } = {}): BladeburnerActionReading[] {
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, PERSON, { city: CITY, penalty: 1 });
    return { type: action.type, name: action.name, level: 1, maxLevel, count, chance: [chance, chance] };
  });
}

interface ReadingOptions {
  rank?: number;
  stamina?: number;
  bonusSeconds?: number;
  found?: { type: string; name: string } | null;
  current?: { type: string; name: string } | null;
  actions?: BladeburnerActionReading[];
}
/** The worker's reading in the division, B2's figures in it (full stamina, idle, every action's). */
function reading({
  rank = 0,
  stamina = MAX_STAMINA,
  bonusSeconds = 0,
  found = null,
  current = null,
  actions = actionReadings(),
}: ReadingOptions = {}) {
  return { rank, problems: [], stamina, maxStamina: MAX_STAMINA, bonusSeconds, found, current, actions };
}

/** A medium snapshot in the division with `reading`, home 128 GB, the player's figures as `getPlayer()` has them. */
function medium(bladeburner: unknown, { factions = ["CyberSec"] as string[], inBladeburner = true } = {}) {
  return {
    player: {
      skills: PERSON.skills,
      exp: { strength: 1e4, defense: 1e4, dexterity: 1e4, agility: 1e4, hacking: 0, charisma: 0, intelligence: 0 },
      mults: {
        ...PERSON.mults,
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
      money: 1e6,
      city: "Sector-12",
      factions,
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
    bladeburner,
  } as unknown as MediumSnapshotData;
}

const slow = (bitNode: number, ownedSF: Record<string, number> = {}): SlowSnapshotData => {
  const data = slowData(bitNode);
  return { ...data, resetInfo: { ...data.resetInfo, ownedSF } as SlowSnapshotData["resetInfo"] };
};

/** The plan core makes of a reading at full stamina: Bounty Hunter level 1 at combat 100, Field Analysis to rest. */
const PLAN = chooseBladeburnerAction({
  readings: actionReadings(),
  person: PERSON,
  stamina: MAX_STAMINA,
  maxStamina: MAX_STAMINA,
  rankMultiplier: 1,
  speed: 1,
});
const WORK = { type: "Contracts", name: "Bounty Hunter", level: 1 };
const REST = { type: "General", name: "Field Analysis", level: null };

describe("the rule (#375)", () => {
  const decide = (rule: BladeburnerRule, data: MediumSnapshotData, bitNode = 6, ownersWork = false) =>
    rule.update({ mediumData: data, slowData: slow(bitNode), homeKeptGb: 32, ownersWork });

  test("at full stamina: the plan's work, at its level, as the worker's action; A5 held for it", () => {
    expect(PLAN.work).toMatchObject(WORK);
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading())).state).toEqual({ joinTheFaction: false, action: WORK });
    expect(rule.acting()).toBe(true);
    expect(rule.view().actions).toMatchObject({ order: WORK, resting: false, plan: { work: WORK } });
    expect(rule.view().line).toBe(
      "Bladeburner: in the division, rank 0.0; Bladeburners at rank 25; Bounty Hunter level 1 (21.2% at the " +
        "estimate's low end, 0.54 rank/min worked), resting with Field Analysis; stamina 39.8 / 39.8; worked 29% of a " +
        "cycle, 0.30 rank/min over it",
    );
  });

  test("the work or the rest at ½ stamina: at it, work; under it, rest; rested, back to work only at the max", () => {
    const rule = new BladeburnerRule();
    const at = (stamina: number) => decide(rule, medium(reading({ stamina }))).state?.action;
    expect(at(MAX_STAMINA / 2)).toEqual(WORK);
    expect(at(MAX_STAMINA / 2 - 1e-9)).toEqual(REST);
    expect(rule.view().actions?.resting).toBe(true);
    expect(rule.view().line).toContain("; resting with Field Analysis for Bounty Hunter level 1 (");
    // Resting, at ½ and at just under the max: still resting.
    expect(at(MAX_STAMINA / 2)).toEqual(REST);
    expect(at(MAX_STAMINA - 1e-9)).toEqual(REST);
    expect(at(MAX_STAMINA)).toEqual(WORK);
    expect(at(MAX_STAMINA * 0.75)).toEqual(WORK);
  });

  test("no contract or operation worth it (their counts out): Field Analysis alone, still an action", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ actions: actionReadings({ count: 0.5 }) }))).state?.action).toEqual(REST);
    expect(rule.view().line).toContain("; Field Analysis (no contract or operation beats it; 0.20 rank/min; ");
    expect(rule.acting()).toBe(true);
  });

  test("the owner's work holds the actions, said; A5 not held for them", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading()), 6, true).state).toEqual({ joinTheFaction: false });
    expect(rule.view().line).toContain("; actions held for your work on the dashboard");
    expect(rule.acting()).toBe(false);
  });

  test("a B1 Agent's reading (no stamina or actions): no action, as before", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ rank: 3, problems: [] })).state).toEqual({ joinTheFaction: false });
    expect(rule.acting()).toBe(false);
  });

  test("BN7's rank at 0.6; bonus time's 5 s a tick from 5 s of it, its counts' margin five times over", () => {
    const rule = new BladeburnerRule();
    decide(rule, medium(reading()), 7);
    expect(rule.view().actions?.plan.rankPerSecond).toBeCloseTo(PLAN.rankPerSecond * 0.6, 12);
    expect(bladeburnerSpeedOf(4.9)).toBe(1);
    expect(bladeburnerSpeedOf(5)).toBe(5);
    // Bounty Hunter's 21 s: 1 + 10/21 attempts at speed 1, 1 + 50/21 at 5.
    const bountyHunterAt = (count: number) =>
      actionReadings().map((each) => (each.name === "Bounty Hunter" ? { ...each, count } : each));
    const at = (count: number, bonusSeconds: number) =>
      decide(rule, medium(reading({ actions: bountyHunterAt(count), bonusSeconds }))).state?.action?.name;
    expect(at(1 + 10 / 21, 0)).toBe("Bounty Hunter");
    expect(at(1 + 10 / 21, 5)).not.toBe("Bounty Hunter");
    expect(at(1 + 50 / 21, 5)).toBe("Bounty Hunter");
  });

  test("the reading checked: B2's figures, or unread when one isn't a figure", () => {
    expect(bladeburnerSnapshotOf(medium(reading())).reading).toMatchObject({
      kind: "read",
      actions: { stamina: MAX_STAMINA, found: null, current: null, actions: actionReadings() },
    });
    for (const bad of [
      { ...reading(), stamina: "1" },
      { ...reading(), current: { type: "Contracts" } },
      { ...reading(), actions: [{ ...actionReadings()[0], chance: [0.5] }] },
      { ...reading(), actions: [{ ...actionReadings()[0], type: "Black Operations" }] },
      { ...reading(), actions: undefined },
    ]) {
      expect(bladeburnerSnapshotOf(medium(bad)).reading).toEqual({
        kind: "unread",
        problem: "the Bladeburner reading's stamina or actions aren't figures",
      });
    }
  });

  test("it logs a change of action, not each figure", () => {
    const lines: string[] = [];
    const rule = new BladeburnerRule((line) => lines.push(line));
    decide(rule, medium(reading()));
    decide(rule, medium(reading({ stamina: MAX_STAMINA * 0.8, rank: 2 })));
    decide(rule, medium(reading({ stamina: MAX_STAMINA * 0.4, rank: 3 })));
    decide(rule, medium(reading({ stamina: MAX_STAMINA * 0.45, rank: 3.1 })));
    expect(lines.map((line) => line.split(" (")[0])).toEqual([
      "bladeburner: in the division, rank 0.0; Bladeburners at rank 25; Bounty Hunter level 1",
      "bladeburner: in the division, rank 3.0; Bladeburners at rank 25; resting with Field Analysis for Bounty Hunter level 1",
    ]);
  });
});

describe("the controller (#375)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-actions-"));
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
          gameTimeMs: 1_000,
          data,
        }),
      );
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    const last = () =>
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as unknown as DesiredState | undefined;
    return { controller, send, last };
  }
  const withCyberSec = (bitNode: number, ownedSF: Record<string, number> = {}): SlowSnapshotData => ({
    ...slow(bitNode, ownedSF),
    factions: {
      backend: "sim",
      state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  });

  test("in BN6's division: the work sent at ½ stamina and over, the rest under it; A5's faction work held for it", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    // Before the reading has B2's figures: A5's work goes, no action.
    send("medium", medium({ rank: 0, problems: [] }));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false });
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    send("medium", medium(reading({ stamina: MAX_STAMINA / 2 })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: WORK });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    expect(last()?.work ?? null).toBeNull();
    expect(controller.workView().desired).toBeNull();
    send("medium", medium(reading({ stamina: MAX_STAMINA / 2 - 0.01 })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: REST });
    expect(last()?.work ?? null).toBeNull();
    // The owner's work: no action; the owner's work sent.
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    send("medium", medium(reading({ stamina: MAX_STAMINA })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false });
    expect(last()?.work).toMatchObject({ kind: "crime", crime: "Shoplift" });
    controller.setWork(null);
    send("medium", medium(reading({ stamina: MAX_STAMINA })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: WORK });
  });

  test("outside BN6 and BN7, with SF6 and SF7 and a reading: no action, A5's work goes", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(1, { 6: 1, 7: 1 }));
    send("medium", medium(reading()));
    expect(last()?.bladeburner).toBeUndefined();
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    expect(controller.bladeburnerView().stage).toBe("notManaged");
  });
});

describe("the run report's actions (#375)", () => {
  const TRACKING = { type: "Contracts", name: "Tracking" };
  const FIELD = { type: "General", name: "Field Analysis" };
  /** Only Tracking, at 50% (to 70%) at level 1: an attempt 11 s at combat 100 for 0.3, no loss. */
  const tracking = (count = 100): BladeburnerActionReading[] => [
    { type: "Contracts", name: "Tracking", level: 1, maxLevel: 1, count, chance: [0.5, 0.7] },
  ];
  /** Mediums every 10 s from T0: `ranks[i]` at the i-th, Tracking under way (found and after) unless said. */
  function run(ranks: number[], each: (index: number) => ReadingOptions = () => ({})): [number, MediumSnapshotData][] {
    return ranks.map((rank, index) => [
      T0 + index * BLADEBURNER_READING_SECONDS * SECOND,
      medium(reading({ rank, found: TRACKING, current: TRACKING, actions: tracking(), ...each(index) }), {
        factions: [],
      }),
    ]);
  }
  function fold(mediums: [number, MediumSnapshotData][]) {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    for (const [atMs, data] of mediums) folded.addMedium(atMs, data);
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 24 * 60 * MINUTE).join("\n");
    return { text, failures };
  }
  // By hand: 10 s of Tracking is 10/11 of an attempt of mean 0.5 × 0.3 and variance 0.5 × 0.09 × (1 + 0.01/3) less
  // 0.15²; each end's allowance a success's 110% and 10 s at its rate.
  const N = 60;
  const expected = (N - 1) * (10 / 11) * 0.15;
  const sigma = Math.sqrt((N - 1) * (10 / 11) * (0.5 * 0.09 * (1 + 0.01 / 3) - 0.15 ** 2));
  const ends = 2 * (1.1 * 0.3 + (0.15 / 11) * 10);
  const bound = expected - BLADEBURNER_RANK_SIGMAS * sigma - ends;

  test("Tracking for 10 min at its forecast: the lines, and no failure", () => {
    expect(BLADEBURNER_RANK_SIGMAS).toBe(3);
    const ranks = Array.from({ length: N }, (_, index) => (index * expected) / (N - 1));
    const { text, failures } = fold(run(ranks));
    expect(failures).toEqual([]);
    expect(text).toContain(
      `  the actions (#375): 60 readings from ${new Date(T0).toISOString()} to ` +
        `${new Date(T0 + 590 * SECOND).toISOString()}, 1 stretch\n    time under way: Tracking level 1 9 min 50 s\n`,
    );
    expect(text).toContain(
      `    rank from the actions run: ${expected.toFixed(2)} measured against ${expected.toFixed(2)} forecast (σ ` +
        `${sigma.toFixed(2)}), its bound ${bound.toFixed(2)}: the forecast less 3σ and ${ends.toFixed(2)} for 0 ` +
        "switches and the stretches' ends; over 9 min 50 s of game time\n",
    );
    expect(text).toContain("  an action stopped at stamina 0 at any reading:\n    none\n");
    expect(text).toContain("  the rank from the actions run below its forecast's bound:\n    none");
  });

  test("the rank below the bound fails; at it, it passes", () => {
    const ranksTo = (total: number) => Array.from({ length: N }, (_, index) => (index * total) / (N - 1));
    expect(fold(run(ranksTo(bound + 1e-9))).failures).toEqual([]);
    const { failures } = fold(run(ranksTo(bound - 0.01)));
    expect(failures).toEqual([
      `the rank from the actions run below its forecast's bound: ${(bound - 0.01).toFixed(2)} against ` +
        `${bound.toFixed(2)} (forecast ${expected.toFixed(2)}, σ ${sigma.toFixed(2)}), from ` +
        `${new Date(T0).toISOString()} to ${new Date(T0 + 590 * SECOND).toISOString()}`,
    ]);
  });

  test("bonus time: an interval's game seconds are its real ones and the bonus spent", () => {
    // 50 s of bonus spent each 10 s: 60 game seconds an interval, 6 times the attempts.
    const ranks = Array.from({ length: N }, () => 0);
    const { text } = fold(run(ranks, (index) => ({ bonusSeconds: 10_000 - 50 * index })));
    expect(text).toContain(`measured against ${(expected * 6).toFixed(2)} forecast`);
    expect(text).toContain("over 59 min of game time");
  });

  test("a stop at stamina 0 fails; one for the counts or other work is listed, no failure", () => {
    const cost = 0.285 * (125 ** 0.28 + 125 / 650);
    const stopped = (stamina: number, count = 100) =>
      fold(
        run([0, 0.3, 0.3], (index) =>
          index === 2 ? { found: null, current: TRACKING, stamina, actions: tracking(count) } : {},
        ),
      );
    const atZero = stopped(cost - 0.01);
    // Found idle: a switch (an attempt cut short), its allowance counted.
    expect(atZero.text).toContain(" for 1 switch and the stretches' ends");
    expect(atZero.failures).toEqual([
      `an action stopped at stamina 0: Tracking, found idle ${new Date(T0 + 20 * SECOND).toISOString()} (stamina ` +
        `${(cost - 0.01).toFixed(2)} / ${MAX_STAMINA.toFixed(1)}, under an attempt's ${cost.toFixed(2)})`,
    ]);
    expect(stopped(cost).failures).toEqual([]);
    const counts = stopped(cost, 0.5);
    expect(counts.failures).toEqual([]);
    expect(counts.text).toContain(
      `      ${new Date(T0 + 20 * SECOND).toISOString()}: Tracking, the counts ran out (its count 0.50, under 1)\n`,
    );
    expect(stopped(MAX_STAMINA).text).toContain(": Tracking, other work (stopped with stamina and count left");
  });

  test("Field Analysis's rank counted, a switch's allowance, and a gap splitting the stretches", () => {
    // 3 readings resting with Field Analysis (0.1 each 30 s), then Tracking: one switch.
    const mediums = run([0, 0, 0, 0.0667, 0.2], (index) =>
      index < 3 ? { found: FIELD, current: FIELD } : index === 3 ? { found: FIELD, current: TRACKING } : {},
    );
    const { text } = fold(mediums);
    // Field Analysis 30 s (the intervals from readings 0, 1 and 2, each under way at its start), Tracking 10 s.
    const forecast = 3 * 10 * (0.1 / 30) + (10 / 11) * 0.15;
    expect(text).toContain(`measured against ${forecast.toFixed(2)} forecast`);
    expect(text).toContain(" for 1 switch and the stretches' ends");
    expect(text).toContain("time under way: Field Analysis 30 s, Tracking level 1 10 s\n");
    const gap = fold([
      ...run([0, 0.1]),
      ...run([0.2, 0.3]).map(
        ([atMs, data]) => [atMs + BLADEBURNER_GAP_MS + 30 * SECOND, data] as [number, MediumSnapshotData],
      ),
    ]);
    expect(gap.text).toContain("4 readings from ");
    expect(gap.text).toContain(", 2 stretches\n");
  });

  test("in the division with no B2 reading: said; not in it: no actions' lines", () => {
    const joinedNoReading = fold([[T0, medium({ rank: 0, problems: [] }, { factions: [] })]]);
    expect(joinedNoReading.text).toContain(
      "  the actions (#375): no reading with them (the worker's, once home's RAM holds it)",
    );
    expect(joinedNoReading.failures).toEqual([]);
    const outside = fold([[T0, medium(null, { factions: [], inBladeburner: false })]]);
    expect(outside.text).not.toContain("the actions (#375)");
  });
});
