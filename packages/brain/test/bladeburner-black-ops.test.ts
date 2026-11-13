// Bladeburner B5 (#392): the brain's rule on the next Black Op (the target hook at each next one's rank, the check at
// it on both sides, the work or rest choice at ½ stamina, one under way kept, a chaos action kept first, a B4 Agent's
// reading), the controller sending it as the worker's action with A5's work held for it and nothing outside BN6 and
// BN7, and the run report's Black Ops with their failure. Core's check is bladeburner-black-ops.test.ts's in core; the
// rule against the real engine is bn6-black-ops-simulation.test.ts's; core's formulas against the engine's are
// bladeburner-black-ops-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_CITIES,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  type BladeburnerSkillLevels,
  bladeburnerSkillMultsOf,
  CONTROL_PROTOCOL_VERSION,
  checkBladeburnerBlackOp,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  maxStaminaOf,
  type SlowSnapshotData,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BLADEBURNER_ACTIONS_HOLD, BladeburnerRule, bladeburnerSnapshotOf } from "../src/bladeburner.ts";
import { BladeburnerFold } from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const SECOND = 1000;
const T0 = Date.UTC(2026, 0, 1);

/** The player in BN6's division: combat 100, hacking and charisma 1, no intelligence, every multiplier 1. */
const PERSON: BladeburnerPerson = {
  skills: { hacking: 1, strength: 100, defense: 100, dexterity: 100, agility: 100, charisma: 1, intelligence: 0 },
  mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
};
const CITY = { population: 1e9, communities: 50, chaos: 0 };
const TYPHOON = BLADEBURNER_BLACK_OPS[0] as (typeof BLADEBURNER_BLACK_OPS)[number];
const ZERO = BLADEBURNER_BLACK_OPS[1] as (typeof BLADEBURNER_BLACK_OPS)[number];
const TYPHOON_ORDER = { type: BLACK_OPERATIONS, name: TYPHOON.name, level: null };
/** Overclock at its max and some levels: B3's next level raises Typhoon's chance, so a low one waits (core's test). */
const WAITING_LEVELS: BladeburnerSkillLevels = { Overclock: 90, Tracer: 20, "Cyber's Edge": 10 };

/** Every contract and operation at level 1 of 3, at the skill levels, the range collapsed on its chance. */
function actionReadings(levels: BladeburnerSkillLevels): BladeburnerActionReading[] {
  const skills = bladeburnerSkillMultsOf(levels);
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, PERSON, { city: CITY, penalty: 1, skills });
    return { type: action.type, name: action.name, level: 1, maxLevel: 3, count: 100, chance: [chance, chance] };
  });
}

interface ReadingOptions {
  rank?: number;
  /** The stamina as a share of the max. */
  share?: number;
  current?: { type: string; name: string } | null;
  levels?: BladeburnerSkillLevels | null;
  points?: number;
  /** The next Black Op read (null: all done; undefined: a B4 Agent's, none). */
  blackOp?: { name: string; chance: [number, number] } | null;
  withCities?: boolean;
}
/** The worker's reading in the division: B2's, B3's (unless `levels` is null) and B5's figures. */
function reading({
  rank = 0,
  share = 1,
  current = null,
  levels = {},
  points = 0,
  blackOp,
  withCities = false,
}: ReadingOptions = {}) {
  const maxStamina = maxStaminaOf(PERSON, 0, bladeburnerSkillMultsOf(levels ?? {}));
  return {
    rank,
    problems: [],
    stamina: maxStamina * share,
    maxStamina,
    bonusSeconds: 0,
    found: current,
    current,
    actions: actionReadings(levels ?? {}),
    ...(levels === null
      ? {}
      : {
          skillPoints: points,
          skillLevels: Object.fromEntries(BLADEBURNER_SKILL_NAMES.map((name) => [name, levels[name] ?? 0])),
        }),
    ...(withCities
      ? {
          city: "Sector-12",
          cities: BLADEBURNER_CITIES.map((name) => ({ name, population: 1e9, communities: 50, chaos: 52 })),
        }
      : {}),
    ...(blackOp === undefined ? {} : { blackOp }),
  };
}

/** A medium snapshot in the division with `bladeburner`, home 128 GB; in the Bladeburners faction. */
function medium(bladeburner: unknown, { factions = ["CyberSec", "Bladeburners"] as string[] } = {}) {
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
    inBladeburner: true,
    bladeburner,
  } as unknown as MediumSnapshotData;
}

const slow = (bitNode: number, ownedSF: Record<string, number> = {}): SlowSnapshotData => {
  const data = slowData(bitNode);
  return { ...data, resetInfo: { ...data.resetInfo, ownedSF } as SlowSnapshotData["resetInfo"] };
};

describe("the rule (#392)", () => {
  const decide = (rule: BladeburnerRule, data: MediumSnapshotData, nowMs: number | null = null) =>
    rule.update({ mediumData: data, slowData: slow(6), homeKeptGb: 32, nowMs });

  test("the target hook: each next Black Op's rank, once the faction is joined; all done, none", () => {
    const rule = new BladeburnerRule();
    const targetAt = (options: ReadingOptions, factions?: string[]) => {
      decide(rule, medium(reading(options), factions === undefined ? {} : { factions }));
      return rule.view().actions?.plan.toTarget?.target;
    };
    expect(targetAt({ rank: 1000, blackOp: { name: TYPHOON.name, chance: [0.5, 0.5] } })).toBe(2500);
    expect(targetAt({ rank: 3000, blackOp: { name: ZERO.name, chance: [0.5, 0.5] } })).toBe(5000);
    expect(targetAt({ rank: 3000, blackOp: null })).toBeUndefined();
    expect(rule.view().line).toContain("; all 21 Black Ops done");
    // Not joined, the faction's 25 first.
    expect(targetAt({ rank: 10, blackOp: { name: TYPHOON.name, chance: [0.5, 0.5] } }, ["CyberSec"])).toBe(25);
    // A B4 Agent's reading: no Black Op, no target past the faction, no line.
    expect(targetAt({ rank: 1000 })).toBeUndefined();
    expect(rule.view().line).not.toContain("Black Op");
  });

  test("run only at its rank, the check saying so (no B3 skills: any chance); under it, #386's plan", () => {
    const rule = new BladeburnerRule();
    const blackOp = { name: TYPHOON.name, chance: [0.5, 0.5] as [number, number] };
    const under = decide(rule, medium(reading({ rank: 2499.9, levels: null, blackOp }))).state?.action;
    expect(under?.type).not.toBe(BLACK_OPERATIONS);
    expect(rule.view().line).toContain(
      `; next Black Op: ${TYPHOON.name} at rank 2,500, its chance 50.0% at the low end`,
    );
    expect(decide(rule, medium(reading({ rank: 2500, levels: null, blackOp }))).state?.action).toEqual(TYPHOON_ORDER);
    expect(rule.view().actions?.blackOp).toMatchObject({ order: "run", check: { met: true, run: true, wait: null } });
    expect(rule.view().line).toContain(`${TYPHOON.name} run, then: `);
    // At no chance read: not run.
    const none = decide(rule, medium(reading({ rank: 2500, levels: null, blackOp: { ...blackOp, chance: [0, 0] } })));
    expect(none.state?.action?.type).not.toBe(BLACK_OPERATIONS);
  });

  test("the check on both sides of its bound: waiting for the next skill points under it, run over it", () => {
    const rule = new BladeburnerRule();
    const at = (chance: number) =>
      decide(
        rule,
        medium(
          reading({ rank: 2500, levels: WAITING_LEVELS, blackOp: { name: TYPHOON.name, chance: [chance, chance] } }),
        ),
      ).state?.action;
    // The bound core's check computes on the same figures.
    const probe = reading({ rank: 2500, levels: WAITING_LEVELS });
    const { bound } = checkBladeburnerBlackOp(
      {
        readings: probe.actions,
        person: PERSON,
        stamina: probe.stamina,
        maxStamina: probe.maxStamina,
        rankMultiplier: 1,
        speed: 1,
        skills: { read: WAITING_LEVELS },
      },
      {
        op: TYPHOON,
        rank: 2500,
        chance: [0.05, 0.05],
        skills: { levels: WAITING_LEVELS, points: 0, costMultiplier: 1 },
      },
    );
    expect(bound).toBeGreaterThan(0.01);
    expect(bound).toBeLessThan(0.5);
    expect(at(bound * 0.98)?.type).not.toBe(BLACK_OPERATIONS);
    expect(rule.view().actions?.blackOp).toMatchObject({ order: null, check: { met: true, run: false } });
    expect(rule.view().line).toContain(`next Black Op: ${TYPHOON.name}, its rank 2,500 met, its chance `);
    expect(rule.view().line).toContain(": waiting (the bound ");
    expect(at(bound * 1.02)).toEqual(TYPHOON_ORDER);
  });

  test("the work or rest choice at ½ stamina: at it the Black Op; under it, the rest; rested, back at the max", () => {
    const rule = new BladeburnerRule();
    const blackOp = { name: TYPHOON.name, chance: [0.5, 0.5] as [number, number] };
    const at = (share: number) =>
      decide(rule, medium(reading({ rank: 2500, share, levels: null, blackOp }))).state?.action;
    expect(at(0.5)).toEqual(TYPHOON_ORDER);
    const resting = at(0.5 - 1e-9);
    expect(resting?.type).toBe("General");
    expect(rule.view().actions?.resting).toBe(true);
    expect(at(0.9)?.type).toBe("General");
    expect(at(1)).toEqual(TYPHOON_ORDER);
  });

  test("one under way is kept to its end, whatever the check says; a chaos action under way is kept first", () => {
    const rule = new BladeburnerRule();
    const underWay = { type: BLACK_OPERATIONS, name: TYPHOON.name };
    // Under way, its check now saying wait (the stamina under ½ max): kept, no action asked (the worker leaves it).
    const kept = decide(
      rule,
      medium(
        reading({
          rank: 2500,
          share: 0.2,
          levels: null,
          current: underWay,
          blackOp: { name: TYPHOON.name, chance: [0.5, 0.5] },
        }),
      ),
    ).state;
    expect(kept).toEqual({ joinTheFaction: false, action: null, city: null });
    expect(rule.view().actions?.order).toEqual(TYPHOON_ORDER);
    expect(rule.view().actions?.blackOp?.order).toBe("kept");
    expect(rule.view().line).toContain(`${TYPHOON.name} under way, kept to its end, then: `);
    // Diplomacy under way in its first 60 s: kept, the Black Op after it.
    const chaos = new BladeburnerRule();
    const diplomacy = { type: "General", name: "Diplomacy" };
    const at = (offsetMs: number) =>
      decide(
        chaos,
        medium(
          reading({
            rank: 2500,
            levels: null,
            current: diplomacy,
            withCities: true,
            blackOp: { name: TYPHOON.name, chance: [0.5, 0.5] },
          }),
        ),
        T0 + offsetMs,
      ).state?.action;
    expect(at(0)).toEqual({ type: "General", name: "Diplomacy", level: null });
    expect(at(30 * SECOND)).toEqual({ type: "General", name: "Diplomacy", level: null });
    expect(at(60 * SECOND)).toEqual(TYPHOON_ORDER);
  });

  test("the reading checked: a Black Op not the game's, or its range not two figures, is unread", () => {
    expect(bladeburnerSnapshotOf(medium(reading({ blackOp: null }))).reading).toMatchObject({
      kind: "read",
      actions: { blackOp: null },
    });
    for (const blackOp of [
      { name: "Operation Nowhere", chance: [0.5, 0.5] },
      { name: TYPHOON.name, chance: [0.5] },
      { name: TYPHOON.name, chance: ["0.5", 0.5] },
    ]) {
      expect(bladeburnerSnapshotOf(medium({ ...reading(), blackOp })).reading).toEqual({
        kind: "unread",
        problem: "the Bladeburner reading's stamina, actions, skills, cities or Black Op aren't figures",
      });
    }
  });
});

describe("the controller (#392)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-black-ops-"));
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
  const blackOp = { name: TYPHOON.name, chance: [0.5, 0.5] as [number, number] };

  test("in BN6's division: the Black Op sent at its rank, the focus held for it (A5's faction work waits)", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    send("medium", medium(reading({ rank: 2400, levels: null, blackOp })));
    expect(last()?.bladeburner?.action?.type).not.toBe(BLACK_OPERATIONS);
    expect(controller.bladeburnerView().actions?.plan.toTarget?.target).toBe(2500);
    send("medium", medium(reading({ rank: 2500, levels: null, blackOp })));
    expect(last()?.bladeburner).toMatchObject({ joinTheFaction: false, action: TYPHOON_ORDER });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    expect(last()?.work ?? null).toBeNull();
    expect(controller.workView().desired).toBeNull();
    // Done: the next, Zero, its rank the target; Typhoon not sent again.
    send("medium", medium(reading({ rank: 2550, levels: null, blackOp: { name: ZERO.name, chance: [0.5, 0.5] } })));
    expect(last()?.bladeburner?.action?.type).not.toBe(BLACK_OPERATIONS);
    expect(controller.bladeburnerView().actions?.plan.toTarget?.target).toBe(5000);
  });

  test("outside BN6 and BN7, with SF6 and SF7 and a Black Op read at its rank: nothing sent, A5's work goes", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(1, { 6: 1, 7: 1 }));
    send("medium", medium(reading({ rank: 2500, levels: null, blackOp })));
    expect(last()?.bladeburner).toBeUndefined();
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    expect(controller.bladeburnerView().stage).toBe("notManaged");
  });
});

describe("the run report's Black Ops (#392)", () => {
  const BOUNTY = { type: "Contracts", name: "Bounty Hunter" };
  const underWay = { type: BLACK_OPERATIONS, name: TYPHOON.name };
  /** Mediums every 10 s from T0, each its options (Bounty Hunter under way unless said). */
  function run(each: ReadingOptions[]): [number, MediumSnapshotData][] {
    return each.map((options, index) => [
      T0 + index * 10 * SECOND,
      medium(reading({ current: BOUNTY, levels: null, ...options })),
    ]);
  }
  function fold(mediums: [number, MediumSnapshotData][]) {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    for (const [atMs, data] of mediums) folded.addMedium(atMs, data);
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 24 * 60 * 60 * SECOND).join("\n");
    return { text, failures };
  }
  const typhoon = { name: TYPHOON.name, chance: [0.5, 0.5] as [number, number] };
  const zero = { name: ZERO.name, chance: [0.4, 0.4] as [number, number] };
  const DUE = "  a Black Op due (its rank met, the check running it) with work under way instead, past 22 s:";

  test("done in the window and when; the next, its rank, chance and ETA at the last reading; none due", () => {
    const { text, failures } = fold(
      run([
        { rank: 2400, blackOp: typhoon },
        { rank: 2500, blackOp: typhoon },
        { rank: 2500, blackOp: typhoon, current: underWay },
        { rank: 2550, blackOp: zero, current: null },
        { rank: 2551, blackOp: zero },
      ]),
    );
    expect(failures).toEqual([]);
    expect(text).toContain(
      `  the Black Ops (#392): 0 done before the window; in it, ${TYPHOON.name} ${new Date(T0 + 30 * SECOND).toISOString()}\n` +
        `    at the last reading, ${new Date(T0 + 40 * SECOND).toISOString()} (rank 2551.0): next Black Op: ${ZERO.name} ` +
        "at rank 5,000, its chance 40.0% at the low end, about ",
    );
    expect(text).toMatch(
      /\n {4}the ETA to Operation Zero done: about .+ \(rank 5,000 in about .+ expected, then about .+ to it done\)/,
    );
    expect(text).toContain(`${DUE}\n    none`);
    // The Black Op's end listed as its own, not other work.
    expect(text).toContain(`: ${TYPHOON.name}, done (its one attempt made: the game stops a Black Op either way)`);
  });

  test("due with work under way past 22 s fails; within it, or resting, or waiting, it passes", () => {
    const due = (readings: number) => run(Array.from({ length: readings }, () => ({ rank: 2500, blackOp: typhoon })));
    // 3 readings: 20 s, within; 4: 30 s, past.
    expect(fold(due(3)).failures).toEqual([]);
    const { failures } = fold(due(4));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      `a Black Op due with work under way instead from ${new Date(T0).toISOString()} to ` +
        `${new Date(T0 + 30 * SECOND).toISOString()}, for 30 s (rank 2500.0, Bounty Hunter under way; next Black Op: ` +
        `${TYPHOON.name}, its rank 2,500 met, its chance 50.0% at the low end: run, `,
    );
    // Resting (the stamina's), or under its rank, or the look-ahead waiting (B3's next levels raise the chance): not
    // judged. (The ranks here are flat: only the Black Ops' check is looked at.)
    const dueOf = (mediums: [number, MediumSnapshotData][]) => {
      const { text, failures } = fold(mediums);
      return { text, due: failures.filter((line) => line.startsWith("a Black Op due")) };
    };
    const field = { type: "General", name: "Field Analysis" };
    expect(dueOf(run(Array.from({ length: 6 }, () => ({ rank: 2500, blackOp: typhoon, current: field })))).due).toEqual(
      [],
    );
    expect(dueOf(run(Array.from({ length: 6 }, () => ({ rank: 2499, blackOp: typhoon })))).due).toEqual([]);
    const waiting = dueOf(
      run(
        Array.from({ length: 6 }, () => ({
          rank: 2500,
          levels: WAITING_LEVELS,
          blackOp: { ...typhoon, chance: [0.02, 0.02] as [number, number] },
        })),
      ),
    );
    expect(waiting.due).toEqual([]);
    expect(waiting.text).toContain(": waiting (the bound ");
  });

  test("an older Agent's reading: said; all 21 done: said", () => {
    expect(fold(run([{ rank: 10 }])).text).toContain("  the Black Ops (#392): no reading with them (an older Agent's)");
    expect(fold(run([{ rank: 500_000, blackOp: null }])).text).toContain(
      "  the Black Ops (#392): 21 done before the window; in it, none\n    all 21 done at the last reading",
    );
  });
});
