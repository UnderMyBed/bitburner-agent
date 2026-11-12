// Bladeburner B3 (#379): the brain's skills on the worker's readings in the division (the plan's levels as
// `upgradeBladeburnerSkill` intents, none without points that gain, the owner's work not holding them, BN7's costs, the
// forecast at the levels read), the controller sending them beside the action with A5's work still held and nothing
// outside BN6 and BN7, and the run report's skills with their failure, both sides. The rule against the real engine is
// bn6-skills-simulation.test.ts's; core's skill formulas against the engine's are bladeburner-skills-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_SKILL_NAMES,
  type BladeburnerActionReading,
  type BladeburnerPerson,
  type BladeburnerSkillLevels,
  bladeburnerSkillMultsOf,
  CONTROL_PROTOCOL_VERSION,
  chooseBladeburnerSkills,
  type DesiredState,
  encodeControlMessage,
  INTENT_RETRY_ROUNDS,
  isIrreversibleIntent,
  type MediumSnapshotData,
  maxStaminaOf,
  parseIntentRequest,
  type SlowSnapshotData,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BLADEBURNER_ACTIONS_HOLD,
  BladeburnerRule,
  bladeburnerSnapshotOf,
  upgradeBladeburnerSkillIntent,
} from "../src/bladeburner.ts";
import { BLADEBURNER_GAP_MS, BLADEBURNER_SKILLS_WITHIN_MS } from "../src/bladeburner-actions-report.ts";
import { BladeburnerFold } from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { formatDuration } from "../src/gap-report.ts";
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
const NO_LEVELS = Object.fromEntries(BLADEBURNER_SKILL_NAMES.map((name) => [name, 0])) as BladeburnerSkillLevels;

/** Every contract and operation at level 1 of `maxLevel`, its count, the range collapsed on its chance at `levels`. */
function actionReadings(levels: BladeburnerSkillLevels = {}, { count = 100, maxLevel = 1 } = {}) {
  const skills = bladeburnerSkillMultsOf(levels);
  return BLADEBURNER_LEVELLED_ACTIONS.map((action): BladeburnerActionReading => {
    const chance = actionSuccessChance(action, 1, PERSON, { city: CITY, penalty: 1, skills });
    return { type: action.type, name: action.name, level: 1, maxLevel, count, chance: [chance, chance] };
  });
}

interface ReadingOptions {
  rank?: number;
  points?: number;
  levels?: BladeburnerSkillLevels;
  count?: number;
  current?: { type: string; name: string } | null;
}
/** The worker's reading in the division at `levels` (all 0 else), full stamina, `points` unspent. */
function reading({ rank = 0, points = 0, levels = {}, count = 100, current = null }: ReadingOptions = {}) {
  const max = maxStaminaOf(PERSON, 0, bladeburnerSkillMultsOf(levels));
  return {
    rank,
    problems: [],
    stamina: max,
    maxStamina: max,
    bonusSeconds: 0,
    found: current,
    current,
    actions: actionReadings(levels, { count }),
    skillPoints: points,
    skillLevels: { ...NO_LEVELS, ...levels },
  };
}

/** A medium snapshot in the division with `reading`, home 128 GB, the player's figures as `getPlayer()` has them. */
function medium(bladeburner: unknown, { factions = ["CyberSec"] as string[] } = {}) {
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

/** Core's plan of a reading's skills, as the rule makes it. */
function planOf(points: number, levels: BladeburnerSkillLevels = {}, costMultiplier = 1, rankMultiplier = 1) {
  const max = maxStaminaOf(PERSON, 0, bladeburnerSkillMultsOf(levels));
  return chooseBladeburnerSkills(
    { readings: actionReadings(levels), person: PERSON, stamina: max, maxStamina: max, rankMultiplier, speed: 1 },
    { levels: { ...NO_LEVELS, ...levels }, points, costMultiplier },
  );
}

describe("the intent (#379)", () => {
  test("upgradeBladeburnerSkill { skill, level }: one of the twelve, a whole level to its max; not gated", () => {
    const intent = upgradeBladeburnerSkillIntent("Overclock", 3);
    expect(intent).toEqual({
      action: "upgradeBladeburnerSkill",
      args: { skill: "Overclock", level: 3 },
      id: "upgradeBladeburnerSkill(Overclock, 3)",
    });
    expect(parseIntentRequest({ action: intent.action, args: intent.args })).toEqual({ ok: true, message: intent });
    expect(isIrreversibleIntent(intent)).toBe(false);
    for (const [args, reason] of [
      [{ skill: "Overclocked", level: 1 }, "upgradeBladeburnerSkill's skill isn't one of the game's"],
      [{ skill: 3, level: 1 }, "upgradeBladeburnerSkill's skill isn't one of the game's"],
      [
        { skill: "Overclock", level: 91 },
        "upgradeBladeburnerSkill's level isn't a whole number from 1 to the skill's max (Overclock's 90)",
      ],
      [
        { skill: "Cloak", level: 0 },
        "upgradeBladeburnerSkill's level isn't a whole number from 1 to the skill's max (Overclock's 90)",
      ],
      [
        { skill: "Cloak", level: 1.5 },
        "upgradeBladeburnerSkill's level isn't a whole number from 1 to the skill's max (Overclock's 90)",
      ],
    ] as const) {
      expect(parseIntentRequest({ action: "upgradeBladeburnerSkill", args })).toEqual({ ok: false, reason });
    }
    expect(parseIntentRequest({ action: "upgradeBladeburnerSkill", args: { skill: "Overclock", level: 90 } }).ok).toBe(
      true,
    );
  });
});

describe("the rule (#379)", () => {
  const decide = (rule: BladeburnerRule, data: MediumSnapshotData, bitNode = 6, ownersWork = false) =>
    rule.update({ mediumData: data, slowData: slow(bitNode), homeKeptGb: 32, ownersWork });

  test("points read: the plan's levels as intents, one a skill; the line says so; the action still sent", () => {
    const plan = planOf(30);
    expect(plan.buys.length).toBeGreaterThan(1);
    expect(plan.rankPerSecondAfter).toBeGreaterThan(plan.rankPerSecond);
    const rule = new BladeburnerRule();
    const decision = decide(rule, medium(reading({ points: 30 })));
    expect(decision.skillIntents).toEqual(plan.buys.map((buy) => upgradeBladeburnerSkillIntent(buy.skill, buy.to)));
    expect(decision.state?.action).toMatchObject({ type: "Contracts" });
    expect(rule.view().skills).toEqual(plan);
    const buys = plan.buys.map((buy) => `${buy.skill} 0 → ${buy.to}`).join(", ");
    expect(rule.view().line).toContain(
      `; skills: buying ${buys} for ${plan.spent} of 30 points, ${(plan.rankPerSecond * 60).toFixed(2)} rank/min → ` +
        `${(plan.rankPerSecondAfter * 60).toFixed(2)} rank/min over a cycle`,
    );
  });

  test("none to buy: no points, or none that gain (the counts out); the line says what's unspent", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ points: 0 }))).skillIntents).toEqual([]);
    expect(rule.view().line).toContain("; skills: 0 points unspent, no level they cover gains (the cheapest 1 points)");
    expect(decide(rule, medium(reading({ points: 50, count: 0.5 }))).skillIntents).toEqual([]);
    expect(rule.view().line).toContain("; skills: 50 points unspent, no level they cover gains");
  });

  test("the owner's work holds the actions, not the skills: they stop no work", () => {
    const rule = new BladeburnerRule();
    const decision = decide(rule, medium(reading({ points: 30 })), 6, true);
    expect(decision.state).toEqual({ joinTheFaction: false, city: null });
    expect(decision.skillIntents.length).toBeGreaterThan(0);
    expect(rule.acting()).toBe(false);
  });

  test("BN7's costs ×2: 1 point buys Cyber's Edge's first level in BN6, nothing in BN7", () => {
    expect(planOf(1).buys).toEqual([{ skill: "Cyber's Edge", from: 0, to: 1, cost: 1 }]);
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ points: 1 })), 6).skillIntents).toEqual([
      upgradeBladeburnerSkillIntent("Cyber's Edge", 1),
    ]);
    expect(decide(rule, medium(reading({ points: 1 })), 7).skillIntents).toEqual([]);
    expect(decide(rule, medium(reading({ points: 2 })), 7).skillIntents).toEqual([
      upgradeBladeburnerSkillIntent("Cyber's Edge", 1),
    ]);
  });

  test("the forecast reads the levels: Overclock's time in the work, Cyber's Edge's regain; from the levels read", () => {
    const rule = new BladeburnerRule();
    decide(rule, medium(reading()));
    const without = rule.view().actions?.plan;
    decide(rule, medium(reading({ levels: { Overclock: 50, "Cyber's Edge": 5 } })));
    const withLevels = rule.view().actions?.plan;
    if (without?.work == null || withLevels?.work == null) throw new Error("no work");
    expect(withLevels.work.name).toBe(without.work.name);
    expect(withLevels.work.seconds).toBeLessThan(without.work.seconds);
    expect(withLevels.regain).toBeGreaterThan(without.regain);
    // The plan from the levels read: any skill read at a level is bought on from it.
    const levels = { Overclock: 50, "Cyber's Edge": 5 };
    const decision = decide(rule, medium(reading({ points: 200, levels })));
    expect(decision.skillIntents).toEqual(
      planOf(200, levels).buys.map((buy) => upgradeBladeburnerSkillIntent(buy.skill, buy.to)),
    );
    for (const buy of rule.view().skills?.buys ?? []) {
      expect(buy.from).toBe(levels[buy.skill as keyof typeof levels] ?? 0);
    }
  });

  test("a B2 Agent's reading (no skills): none bought, no skills' line; skills not figures: unread", () => {
    const rule = new BladeburnerRule();
    const { skillPoints: _points, skillLevels: _levels, ...b2 } = reading({ points: 30 });
    expect(decide(rule, medium(b2)).skillIntents).toEqual([]);
    expect(rule.view().line).not.toContain("skills:");
    expect(rule.view().skills).toBeNull();
    for (const bad of [
      { ...reading(), skillPoints: "3" },
      { ...reading(), skillLevels: { ...NO_LEVELS, Cloak: "1" } },
      { ...reading(), skillLevels: null },
      { ...b2, skillPoints: 3 },
    ]) {
      expect(bladeburnerSnapshotOf(medium(bad)).reading).toEqual({
        kind: "unread",
        problem: "the Bladeburner reading's stamina, actions, skills or cities aren't figures",
      });
    }
  });

  test("it logs a purchase, not each point", () => {
    const lines: string[] = [];
    const rule = new BladeburnerRule((line) => lines.push(line));
    decide(rule, medium(reading({ points: 0 })));
    decide(rule, medium(reading({ points: 0, rank: 1 })));
    decide(rule, medium(reading({ points: 1, rank: 3 })));
    decide(rule, medium(reading({ points: 0, rank: 3, levels: { "Cyber's Edge": 1 } })));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("skills: buying Cyber's Edge 0 → 1 for 1 of 1 point, ");
  });
});

describe("the controller (#379)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-skills-"));
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
  const skillIds = (state: DesiredState | undefined) =>
    (state?.intents ?? []).filter((intent) => intent.action === "upgradeBladeburnerSkill").map((intent) => intent.id);

  test("in BN6's division: the skills' intents at once beside the action, A5's work still held; then none", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    send("medium", medium(reading({ points: 30 })));
    const plan = planOf(30);
    expect(skillIds(last())).toEqual(plan.buys.map((buy) => upgradeBladeburnerSkillIntent(buy.skill, buy.to).id));
    expect(last()?.bladeburner?.action).toMatchObject({ type: "Contracts" });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    expect(controller.intentsView().filter((each) => each.source === "bladeburner")).toHaveLength(plan.buys.length);
    // Bought: the next reading shows the levels and the points spent; none sent.
    const levels = Object.fromEntries(plan.buys.map((buy) => [buy.skill, buy.to])) as BladeburnerSkillLevels;
    send("medium", medium(reading({ points: 30 - plan.spent, levels })));
    expect(skillIds(last())).toEqual([]);
    // The owner's work: the action held, A5 not, and a new point still bought.
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    send("medium", medium(reading({ points: 30 - plan.spent + 20, levels })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, city: null });
    expect(skillIds(last()).length).toBeGreaterThan(0);
  });

  test("outside BN6 and BN7, with SF6 and SF7 and a reading with points: no skills bought", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(1, { 6: 1, 7: 1 }));
    send("medium", medium(reading({ points: 30 })));
    expect(skillIds(last())).toEqual([]);
    expect(last()?.bladeburner).toBeUndefined();
    expect(controller.bladeburnerView().stage).toBe("notManaged");
  });
});

describe("the run report's skills (#379)", () => {
  /** The fold over mediums with these readings (idle unless said: no rank forecast to meet), installs at `installs`. */
  const TRACKING = { type: "Contracts", name: "Tracking" };
  function fold(readings: [number, ReadingOptions][], installs: number[] = []) {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    for (const [index, atMs] of installs.entries()) {
      const data = slow(6);
      folded.addSlow(atMs, { ...data, resetInfo: { ...data.resetInfo, lastAugReset: atMs + index } });
    }
    for (const [atMs, options] of readings) {
      folded.addMedium(atMs, medium(reading(options), { factions: [] }));
    }
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 24 * 3600 * SECOND).join("\n");
    return { text, failures };
  }
  const every10s = (count: number, options: (index: number) => ReadingOptions, fromMs = T0) =>
    Array.from(
      { length: count },
      (_, index) => [fromMs + index * BLADEBURNER_READING_SECONDS * SECOND, options(index)] as [number, ReadingOptions],
    );
  const plan = planOf(30);
  const bought = Object.fromEntries(plan.buys.map((buy) => [buy.skill, buy.to])) as BladeburnerSkillLevels;

  test("the bound: two readings, a round and an intent's retry, 52 s", () => {
    expect(BLADEBURNER_SKILLS_WITHIN_MS).toBe(2 * 10_000 + 2_000 + INTENT_RETRY_ROUNDS * 2_000);
    expect(BLADEBURNER_SKILLS_WITHIN_MS).toBe(52_000);
  });

  test("points spent by the next reading: no failure; the levels bought, the plan and the forecasts shown", () => {
    const { text, failures } = fold(
      every10s(6, (index) => (index < 2 ? { points: 30 } : { points: 30 - plan.spent, levels: bought })),
    );
    expect(failures).toEqual([]);
    const boughtText = plan.buys.map((buy) => `${buy.skill} 0 → ${buy.to}`).join(", ");
    expect(text).toContain(`  the skills (#379): bought over the window: ${boughtText}; at the last reading, `);
    expect(text).toContain(`: skills: ${30 - plan.spent} point`);
    const after = planOf(30 - plan.spent, bought);
    expect(text).toContain(
      `    the rule's forecast there: ${(after.rankPerSecond * 60).toFixed(3)} rank/min with the levels read (`,
    );
    expect(text).toContain(`; ${(plan.rankPerSecond * 60).toFixed(3)} rank/min with none (B2's)`);
    expect(after.rankPerSecond).toBeCloseTo(plan.rankPerSecondAfter, 9);
    expect(text).toContain("  skill points unspent with a level to buy, past 52 s:\n    none");
  });

  test("unspent past 52 s fails; at it, passes; a gap or a purchase ends the stretch", () => {
    // Readings 10 s apart for 52 s, then one at 52 s on: the stretch's length exactly the bound.
    const atBound: [number, ReadingOptions][] = [
      ...every10s(6, () => ({ points: 30 })),
      [T0 + BLADEBURNER_SKILLS_WITHIN_MS, { points: 30 }],
    ];
    expect(fold(atBound).failures).toEqual([]);
    const late = fold([...atBound.slice(0, -1), [T0 + BLADEBURNER_SKILLS_WITHIN_MS + 1, { points: 30 }]]);
    expect(late.failures).toEqual([
      `skill points unspent with a level to buy from ${new Date(T0).toISOString()} to ` +
        `${new Date(T0 + BLADEBURNER_SKILLS_WITHIN_MS + 1).toISOString()}, for ` +
        `${formatDuration(BLADEBURNER_SKILLS_WITHIN_MS + 1)} (skills: buying ` +
        `${plan.buys.map((buy) => `${buy.skill} 0 → ${buy.to}`).join(", ")} for ${plan.spent} of 30 points, ` +
        `${(plan.rankPerSecond * 60).toFixed(2)} rank/min → ${(plan.rankPerSecondAfter * 60).toFixed(2)} rank/min over ` +
        "a cycle; the levels none)",
    ]);
    // A gap over `BLADEBURNER_GAP_MS` between: each side under the bound.
    const gap = fold([
      ...every10s(5, () => ({ points: 30 })),
      ...every10s(5, () => ({ points: 30 }), T0 + 40 * SECOND + BLADEBURNER_GAP_MS + 1),
    ]);
    expect(gap.failures).toEqual([]);
    // Levels moving (a level bought each reading, a point coming each): never one stretch past it.
    const buying = fold(every10s(12, (index) => ({ points: 30, levels: { Overclock: index } })));
    expect(buying.failures).toEqual([]);
    // No level that gains (the counts out): points unspent are no failure, however long.
    expect(fold(every10s(12, () => ({ points: 30, count: 0.5 }))).failures).toEqual([]);
  });

  test("the forecast of the actions run reads the levels: Overclock 50 halves Tracking's time, doubling its attempts", () => {
    const rankOf = (levels: BladeburnerSkillLevels) => {
      const { text } = fold(every10s(31, () => ({ levels, current: TRACKING })));
      const found = /measured against (-?[\d.]+) forecast/.exec(text);
      return Number(found?.[1]);
    };
    const without = rankOf({});
    const withOverclock = rankOf({ Overclock: 50 });
    expect(without).toBeGreaterThan(0);
    // Tracking at combat 100: ⌈12.5 / statFac⌉ = 11 s, at ×0.5 ⌈6.25 / statFac⌉ = 6 s; its chance unmoved.
    expect(withOverclock / without).toBeCloseTo(11 / 6, 2);
  });

  test("by action (#381's review): attempts from the count's fall, successes from the rank, each its own bound", () => {
    // Tracking under way, read every 11 s (its attempt's time at combat 100): its count down 1 a reading (its mean
    // growth added), every other attempt a success of 0.3. Then Field Analysis for 60 s, its 0.1 each 30 s.
    const growth = ((5 + 75) / 2 / 10 / 480) * 11;
    const tracking = (index: number, rank: number) => {
      const options = reading({ current: TRACKING, rank });
      return {
        ...options,
        actions: options.actions.map((each) =>
          each.name === "Tracking" ? { ...each, count: 100 - index + growth * index } : each,
        ),
      };
    };
    const FIELD = { type: "General", name: "Field Analysis" };
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    let rank = 0;
    for (let index = 0; index <= 10; index++) {
      if (index > 0 && index % 2 === 0) rank += 0.3;
      folded.addMedium(T0 + index * 11 * SECOND, medium(tracking(index, rank), { factions: [] }));
    }
    const fieldFrom = T0 + 110 * SECOND;
    for (let index = 1; index <= 6; index++) {
      const field = reading({ current: FIELD, rank: rank + ((index - 1) * 10 * 0.1) / 30 });
      folded.addMedium(
        fieldFrom + index * 10 * SECOND,
        medium({ ...field, found: index === 1 ? TRACKING : FIELD }, { factions: [] }),
      );
    }
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 3600 * SECOND).join("\n");
    const chance = (reading().actions.find((each) => each.name === "Tracking")?.chance[0] ?? 0) as number;
    // Ten attempts, and the 10 s from its last reading to the switch: 10/11 of one more.
    const expected = (10 + 10 / 11) * chance * 0.3;
    expect(text).toContain("    by action, each judged as the whole (#381's review; ");
    expect(text).toContain(
      `      Tracking: about 10 attempts, 5 successes; 1.50 measured against ${expected.toFixed(2)} forecast (σ `,
    );
    // Field Analysis: 50 s, its 0.1 each 30 s, no variance; the window's end cuts one.
    expect(text).toContain(
      "      Field Analysis: about 2 attempts, 2 successes; 0.17 measured against 0.17 forecast (σ 0.00, at most 0.00 " +
        "under an attempt's mean, cuts 0.10), its own bound 0.07\n",
    );
  });

  test("an older Agent's readings (no skills): said, no failure", () => {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    const { skillPoints: _points, skillLevels: _levels, ...b2 } = reading();
    folded.addMedium(T0, medium(b2, { factions: [] }));
    const failures: string[] = [];
    expect(folded.section(failures, T0 + SECOND).join("\n")).toContain(
      "  the skills (#379): no reading with them (an older Agent's)",
    );
    expect(failures).toEqual([]);
  });
});
