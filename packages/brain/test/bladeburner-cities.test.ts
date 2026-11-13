// Bladeburner B4 (#383): the brain's cities and chaos on the worker's readings in the division (the city by B2's
// forecast, Diplomacy and Incite Violence on both sides of their measures, a chaos action kept to its 60 s's end, the
// work or the rest at ½ stamina in the city chosen, the owner's work holding them, an older Agent's reading), the
// controller sending them as the worker's state with A5's work held and nothing outside BN6 and BN7, and the run report's
// cities with their failure, both sides. The rule against the real engine is bn6-cities-simulation.test.ts's; core's
// formulas against the engine's are bladeburner-cities-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  actionSuccessChance,
  BLADEBURNER_CITIES,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  type BladeburnerActionReading,
  type BladeburnerCityReading,
  type BladeburnerPerson,
  CONTROL_PROTOCOL_VERSION,
  chooseBladeburnerAction,
  chooseBladeburnerCity,
  type DesiredState,
  diplomaciesTo50,
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
  describeCityChoice,
} from "../src/bladeburner.ts";
import { BLADEBURNER_GAP_MS } from "../src/bladeburner-actions-report.ts";
import { BLADEBURNER_CHAOS_SLACK_MS, BLADEBURNER_MOVE_WITHIN_MS } from "../src/bladeburner-cities-report.ts";
import { BladeburnerFold } from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { formatDuration } from "../src/gap-report.ts";
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
/** A stronger player (#383): at combat 300, Raid the plan's work, whose counts Incite Violence is worth adding. */
const STRONG: BladeburnerPerson = {
  ...PERSON,
  skills: { ...PERSON.skills, strength: 300, defense: 300, dexterity: 300, agility: 300 },
};

/** The six cities at 1e9, 50 communities and `chaos`, unless `overrides` names one. */
function cities(chaos = 0, overrides: Record<string, Partial<BladeburnerCityReading>> = {}): BladeburnerCityReading[] {
  return BLADEBURNER_CITIES.map((name) => ({ name, population: 1e9, communities: 50, chaos, ...overrides[name] }));
}

/** Every contract and operation at level 1, its count (`counts` by name), its range collapsed on its chance in `city`. */
function actionReadings(
  city: BladeburnerCityReading,
  counts: Record<string, number> = {},
  who: BladeburnerPerson = PERSON,
): BladeburnerActionReading[] {
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city, penalty: 1 });
    return {
      type: action.type,
      name: action.name,
      level: 1,
      maxLevel: 1,
      count: counts[action.name] ?? 100,
      chance: [chance, chance],
    };
  });
}

interface ReadingOptions {
  rank?: number;
  stamina?: number;
  bonusSeconds?: number;
  found?: { type: string; name: string } | null;
  current?: { type: string; name: string } | null;
  city?: string | null;
  all?: BladeburnerCityReading[] | null;
  counts?: Record<string, number>;
  who?: BladeburnerPerson;
}
/** The worker's reading in the division with B4's cities (`all`, read in `city`): full stamina, idle. */
function reading({
  rank = 0,
  stamina = MAX_STAMINA,
  bonusSeconds = 0,
  found = null,
  current = null,
  city = "Sector-12",
  all = cities(),
  counts = {},
  who = PERSON,
}: ReadingOptions = {}) {
  const here = all?.find((each) => each.name === city) ?? cities()[2];
  return {
    rank,
    problems: [],
    stamina,
    maxStamina: MAX_STAMINA,
    bonusSeconds,
    found,
    current,
    actions: actionReadings(here as BladeburnerCityReading, counts, who),
    ...(all === null ? {} : { city, cities: all }),
  };
}

/**
 * A medium snapshot in the division with `bladeburner`, home 128 GB, the player's figures as `getPlayer()` has them;
 * in the Bladeburners faction (#386), and no Black Op read (a B4 Agent's), so no current-rank target: the rule by rank a second.
 */
function medium(bladeburner: unknown, { factions = ["CyberSec", "Bladeburners"] as string[], who = PERSON } = {}) {
  return {
    player: {
      skills: who.skills,
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

const WORK = { type: "Contracts", name: "Bounty Hunter", level: 1 };
const REST = { type: "General", name: "Field Analysis", level: null };
const DIPLOMACY = { type: "General", name: "Diplomacy", level: null };
const INCITE = { type: "General", name: "Incite Violence", level: null };
/** Raid out of count, for the stronger player. */
const COUNTS_OUT = { Raid: 0.5 };
/** The stronger player's reading, Raid out, and its medium snapshot. */
const strongOut = (options: ReadingOptions = {}) =>
  medium(reading({ counts: COUNTS_OUT, who: STRONG, ...options }), { who: STRONG });

/** Core's choice on a reading, as the rule takes it. */
const choiceOf = (options: ReadingOptions = {}) => {
  const read = reading(options);
  return chooseBladeburnerCity(
    {
      readings: read.actions,
      person: PERSON,
      stamina: read.stamina,
      maxStamina: MAX_STAMINA,
      rankMultiplier: 1,
      speed: 1,
      skills: { read: {} },
    },
    { city: read.city as string, cities: read.cities as BladeburnerCityReading[] },
  );
};

describe("the rule (#383)", () => {
  const decide = (
    rule: BladeburnerRule,
    data: MediumSnapshotData,
    { bitNode = 6, ownersWork = false, nowMs = null as number | null } = {},
  ) => rule.update({ mediumData: data, slowData: slow(bitNode), homeKeptGb: 32, ownersWork, nowMs });

  test("every city alike: Sector-12 kept, B2's work there as before, the city in the worker's state", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading())).state).toEqual({ joinTheFaction: false, action: WORK, city: "Sector-12" });
    expect(rule.acting()).toBe(true);
    expect(rule.view().actions?.cities).toEqual(choiceOf());
    expect(rule.view().line).toContain(`; ${describeCityChoice(choiceOf() as never, "Sector-12")}`);
    expect(rule.view().line).toContain("; in Sector-12 (chaos 0.00, 0.30 rank/min: the most of the six)");
  });

  test("an older Agent's reading (no cities): B2's work, the state's city null, so the Agent reads them", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ all: null }))).state).toEqual({
      joinTheFaction: false,
      action: WORK,
      city: null,
    });
    expect(rule.view().actions?.cities).toBeNull();
    // Read before the cities were (the worker hasn't run): the city null too.
    expect(decide(rule, medium(reading({ city: null, all: null }))).state?.city).toBeNull();
  });

  test("Sector-12's chaos at 80: moved to Aevum, B2's work for Aevum; said", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ all }))).state).toEqual({
      joinTheFaction: false,
      action: WORK,
      city: "Aevum",
    });
    expect(rule.view().line).toContain(
      "; in Aevum (chaos 0.00, 0.30 rank/min: the most of the six, moving from Sector-12 (chaos 80.00, ",
    );
    // Read in Aevum: kept there.
    expect(decide(rule, medium(reading({ all, city: "Aevum" }))).state?.city).toBe("Aevum");
  });

  test("every city at 52: Diplomacy, the city held; A5 held for it", () => {
    const rule = new BladeburnerRule();
    const state = decide(rule, medium(reading({ all: cities(52) }))).state;
    expect(state).toEqual({ joinTheFaction: false, action: DIPLOMACY, city: "Sector-12" });
    expect(rule.acting()).toBe(true);
    expect(rule.view().line).toContain("; Diplomacy, then: ");
    expect(rule.view().line).toContain(
      `; Diplomacy pays: its 60 s cost ${choiceOf({ all: cities(52) })?.diplomacy?.cost.toFixed(2)} rank, the chaos 52.00 → 51.48 gains `,
    );
    expect(rule.view().line).toContain(`(about ${diplomaciesTo50(52, 1)} to 50)`);
  });

  test("Diplomacy both sides of its break-even: just over it, sent; just under, B2's work", () => {
    const pays = (chaos: number) => choiceOf({ all: cities(chaos) })?.diplomacy?.pays === true;
    let low = 50;
    let high = 52;
    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2;
      if (pays(middle)) high = middle;
      else low = middle;
    }
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ all: cities(high + 1e-6) }))).state?.action).toEqual(DIPLOMACY);
    expect(decide(rule, medium(reading({ all: cities(low - 1e-6) }))).state?.action).toEqual(WORK);
  });

  test("Raid out of count at combat 300: Incite Violence from chaos 0; not from 40, where the chaos it adds costs more", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, strongOut()).state?.action).toEqual(INCITE);
    expect(rule.view().line).toContain("; Incite Violence pays: the counts out for Raid level 1 (");
    expect(rule.view().line).toContain(" the chaos 0.00 → 20.00 cost ");
    const forty = decide(rule, strongOut({ all: cities(40) })).state?.action;
    const b2 = chooseBladeburnerAction({
      readings: reading({ counts: COUNTS_OUT, who: STRONG }).actions,
      person: STRONG,
      stamina: MAX_STAMINA,
      maxStamina: MAX_STAMINA,
      rankMultiplier: 1,
      speed: 1,
    }).work;
    expect(forty).toEqual({ type: b2?.type, name: b2?.name, level: 1 });
    expect(forty).not.toEqual(INCITE);
    // At combat 100, Bounty Hunter out: its counts aren't worth the 60 s.
    expect(decide(rule, medium(reading({ counts: { "Bounty Hunter": 0.5 } }))).state?.action).not.toEqual(INCITE);
  });

  test("a chaos action under way is kept to its 60 game seconds' end, the city held; then the rule's again", () => {
    const rule = new BladeburnerRule();
    const diplomacy = { type: "General", name: "Diplomacy" };
    const at = (offsetMs: number, options: ReadingOptions) =>
      decide(rule, medium(reading(options)), { nowMs: T0 + offsetMs }).state;
    // Sent at 52, then seen under way at T0; its measure gone (the chaos at 0, the others too), still kept to 60 s.
    expect(at(0, { all: cities(52), found: diplomacy, current: diplomacy })?.action).toEqual(DIPLOMACY);
    expect(
      at(50 * SECOND, { all: cities(0, { Aevum: { population: 2e9 } }), found: diplomacy, current: diplomacy }),
    ).toEqual({
      joinTheFaction: false,
      action: DIPLOMACY,
      city: "Sector-12",
    });
    expect(rule.view().line).toContain("; Diplomacy kept to its 60 s's end, then: ");
    // At 60 s, the rule's own choice: Aevum's larger estimate, B2's work there (Raid, at twice the population).
    expect(
      at(60 * SECOND, { all: cities(0, { Aevum: { population: 2e9 } }), found: diplomacy, current: diplomacy }),
    ).toEqual({
      joinTheFaction: false,
      action: { type: "Operations", name: "Raid", level: 1 },
      city: "Aevum",
    });
    // The game repeats it (#385's review): chosen again at a later run's first reading, that run is kept to its end too.
    const again = new BladeburnerRule();
    const atAgain = (offsetMs: number, options: ReadingOptions) =>
      decide(again, medium(reading(options)), { nowMs: T0 + offsetMs }).state;
    const under = { found: diplomacy, current: diplomacy };
    const gone = { all: cities(0, { Aevum: { population: 2e9 } }), ...under };
    expect(atAgain(0, { all: cities(52), ...under })?.action).toEqual(DIPLOMACY);
    // 60 s: the second run's first reading, every city still at 52: chosen again.
    expect(atAgain(60 * SECOND, { all: cities(52), ...under })?.action).toEqual(DIPLOMACY);
    // 100 s, its measure gone: the second run kept, the city held.
    expect(atAgain(100 * SECOND, gone)).toEqual({ joinTheFaction: false, action: DIPLOMACY, city: "Sector-12" });
    expect(again.view().line).toContain("; Diplomacy kept to its 60 s's end, then: ");
    // 120 s, the third run's first reading: the rule's own choice again.
    expect(atAgain(120 * SECOND, gone)).toEqual({
      joinTheFaction: false,
      action: { type: "Operations", name: "Raid", level: 1 },
      city: "Aevum",
    });
    // Bonus time counts: 10 s and 50 s of it spent is 60 game seconds.
    const second = new BladeburnerRule();
    const bonus = (offsetMs: number, bonusSeconds: number) =>
      second.update({
        mediumData: medium(reading({ all: cities(0), found: diplomacy, current: diplomacy, bonusSeconds })),
        slowData: slow(6),
        homeKeptGb: 32,
        nowMs: T0 + offsetMs,
      }).state?.action;
    expect(bonus(0, 1000)).toEqual(DIPLOMACY);
    expect(bonus(9 * SECOND, 951)).toEqual(DIPLOMACY);
    expect(bonus(10 * SECOND, 950)).toEqual(WORK);
    // With no clock (none yet), nothing is kept.
    const third = new BladeburnerRule();
    expect(
      decide(third, medium(reading({ all: cities(0), found: diplomacy, current: diplomacy }))).state?.action,
    ).toEqual(WORK);
  });

  test("the work or the rest at ½ stamina, in the city chosen", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    const rule = new BladeburnerRule();
    const at = (stamina: number) => decide(rule, medium(reading({ all, stamina }))).state;
    expect(at(MAX_STAMINA / 2)).toEqual({ joinTheFaction: false, action: WORK, city: "Aevum" });
    expect(at(MAX_STAMINA / 2 - 1e-9)).toEqual({ joinTheFaction: false, action: REST, city: "Aevum" });
  });

  test("the owner's work holds the actions and the moves; the cities still read", () => {
    const rule = new BladeburnerRule();
    const all = cities(52, { Aevum: { chaos: 0 } });
    expect(decide(rule, medium(reading({ all })), { ownersWork: true }).state).toEqual({
      joinTheFaction: false,
      city: "Sector-12",
    });
    expect(rule.acting()).toBe(false);
    expect(rule.view().line).toContain("; actions held for your work on the dashboard");
  });

  test("the reading's cities checked: the six, or unread when one isn't a figure", () => {
    expect(bladeburnerSnapshotOf(medium(reading())).reading).toMatchObject({
      kind: "read",
      actions: { city: "Sector-12", cities: cities() },
    });
    expect(bladeburnerSnapshotOf(medium(reading({ all: null }))).reading).toMatchObject({
      kind: "read",
      actions: { city: null, cities: null },
    });
    for (const bad of [
      { ...reading(), city: 3 },
      { ...reading(), cities: "six" },
      { ...reading(), cities: [{ ...cities()[0], chaos: "1" }] },
      { ...reading(), cities: [{ ...cities()[0], name: "Tokyo" }] },
    ]) {
      expect(bladeburnerSnapshotOf(medium(bad)).reading).toEqual({
        kind: "unread",
        problem: "the Bladeburner reading's stamina, actions, skills, cities or Black Op aren't figures",
      });
    }
  });

  test("it logs a move of city and a chaos action, not each figure", () => {
    const lines: string[] = [];
    const rule = new BladeburnerRule((line) => lines.push(line));
    decide(rule, medium(reading()));
    decide(rule, medium(reading({ rank: 1 })));
    decide(rule, medium(reading({ all: cities(0, { "Sector-12": { chaos: 80 } }) })));
    decide(rule, medium(reading({ all: cities(52) })));
    expect(lines.map((line) => line.split(" (")[0])).toEqual([
      "bladeburner: in the division, rank 0.0; Bladeburners joined; Bounty Hunter level 1",
      "bladeburner: in the division, rank 0.0; Bladeburners joined; Bounty Hunter level 1",
      "bladeburner: in the division, rank 0.0; Bladeburners joined; Diplomacy, then: Tracking level 1",
    ]);
    expect(lines[1]).toContain("; in Aevum (");
  });
});

describe("the controller (#383)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-cities-"));
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

  test("in BN6's division: the city, Diplomacy and Incite Violence sent as the worker's state; A5 held for each", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    // The cities not read yet: null, so the Agent reads them.
    send("medium", medium(reading({ city: null, all: null })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: WORK, city: null });
    send("medium", medium(reading({ all: cities(0, { "Sector-12": { chaos: 80 } }) })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: WORK, city: "Aevum" });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    send("medium", medium(reading({ all: cities(52) })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: DIPLOMACY, city: "Sector-12" });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    expect(last()?.work ?? null).toBeNull();
    send("medium", strongOut());
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: INCITE, city: "Sector-12" });
    expect(controller.factionsView()).toMatchObject({ sent: false, waitingFor: BLADEBURNER_ACTIONS_HOLD });
    // The work and the rest at ½ stamina, there.
    send("medium", medium(reading({ stamina: MAX_STAMINA / 2 })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: WORK, city: "Sector-12" });
    send("medium", medium(reading({ stamina: MAX_STAMINA / 2 - 0.01 })));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false, action: REST, city: "Sector-12" });
  });

  test("outside BN6 and BN7, with SF6 and SF7 and a reading with the cities: nothing sent, A5's work goes", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(1, { 6: 1, 7: 1 }));
    send("medium", medium(reading({ all: cities(52) })));
    expect(last()?.bladeburner).toBeUndefined();
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    expect(controller.bladeburnerView().stage).toBe("notManaged");
  });
});

describe("the run report's cities (#383)", () => {
  const BOUNTY = { type: "Contracts", name: "Bounty Hunter" };
  const DIPLOMACY_UNDER_WAY = { type: "General", name: "Diplomacy" };
  /** The fold over `mediums`, BN6's slow snapshot at T0, and an install (a new `lastAugReset`) at each of `installs`. */
  function fold(mediums: [number, MediumSnapshotData][], installs: number[] = []) {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    for (const [index, atMs] of installs.entries()) {
      const data = slow(6);
      folded.addSlow(atMs, { ...data, resetInfo: { ...data.resetInfo, lastAugReset: atMs + index } });
    }
    for (const [atMs, data] of mediums) folded.addMedium(atMs, data);
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 24 * 60 * MINUTE).join("\n");
    return { text, failures };
  }
  /** Readings 10 s apart from `fromMs` up to `toMs`, and `toMs` itself. */
  const every10s = (fromMs: number, toMs: number) => [
    ...Array.from({ length: Math.ceil((toMs - fromMs) / 10_000) }, (_, index) => fromMs + index * 10_000),
    toMs,
  ];
  /**
   * Readings at `offsets`, each `options`'s, the rank as B2's forecast has it for Bounty Hunter under way at the chaos
   * read (its chance at the low end × 0.9, each 21 s; no loss), so B2's rank check holds.
   */
  const at = (offsets: number[], options: (offsetMs: number) => ReadingOptions, factions = ["Bladeburners"]) => {
    let rank = 0;
    let previous: { offsetMs: number; perSecond: number } | null = null;
    return offsets.map((offsetMs) => {
      const each = options(offsetMs);
      if (previous !== null) rank += ((offsetMs - previous.offsetMs) / 1000) * previous.perSecond;
      const read = reading(each);
      const bounty = read.actions.find((action) => action.name === "Bounty Hunter") as BladeburnerActionReading;
      previous = { offsetMs, perSecond: each.current?.name === "Bounty Hunter" ? (bounty.chance[0] * 0.9) / 21 : 0 };
      return [T0 + offsetMs, medium(reading({ ...each, rank }), { factions })] as [number, MediumSnapshotData];
    });
  };

  test("the lines: the city, its time, each city's chaos, the counts, the chaos actions' time, the rule's choice", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    const { text, failures } = fold(
      at([0, 10_000, 20_000, 30_000], (offsetMs) =>
        offsetMs === 0
          ? { all, found: BOUNTY, current: BOUNTY }
          : offsetMs === 10_000
            ? { all, city: "Aevum", found: BOUNTY, current: DIPLOMACY_UNDER_WAY }
            : { all, city: "Aevum", found: DIPLOMACY_UNDER_WAY, current: DIPLOMACY_UNDER_WAY },
      ),
    );
    expect(failures).toEqual([]);
    expect(text).toContain(
      `  the cities and the chaos (#383): 4 readings from ${new Date(T0).toISOString()} to ` +
        `${new Date(T0 + 30 * SECOND).toISOString()}; at the last, the division in Aevum; 1 switch of city\n` +
        "    time by city: Aevum 20 s, Sector-12 10 s\n" +
        "    each city at the last reading (chaos, population estimate, communities): Aevum 0.00, 1000m, 50; " +
        "Chongqing 0.00, 1000m, 50; Sector-12 80.00, 1000m, 50; New Tokyo 0.00, 1000m, 50; Ishima 0.00, 1000m, 50; " +
        "Volhaven 0.00, 1000m, 50\n" +
        "    the counts at the last reading: Tracking 100.0, Bounty Hunter 100.0, Retirement 100.0, Investigation " +
        "100.0, Undercover Operation 100.0, Sting Operation 100.0, Raid 100.0, Stealth Retirement Operation 100.0, " +
        "Assassination 100.0\n" +
        "    Diplomacy under way 20 s, Incite Violence 0 s (60 s a run; bonus time runs them up to 5 times as fast)\n" +
        "    the rule's choice at the last reading: in Aevum (chaos 0.00, ",
    );
    expect(text).toContain(
      "  the chaos over 50 where the division works, the rule's measure wanting it off, past twice its Diplomacy " +
        "estimate and 10 min, or a move's 22 s:\n    none",
    );
  });

  test("under the faction's 25 (#386): the rule's choice by the least time to it, as the brain's; joined, by the rate", () => {
    const readings = (factions: string[]) =>
      at([0, 10_000], () => ({ all: cities(0), found: BOUNTY, current: BOUNTY }), factions);
    const choiceLine = (factions: string[]) =>
      fold(readings(factions))
        .text.split("\n")
        .find((line) => line.includes("the rule's choice at the last reading"));
    expect(choiceLine([])).toContain("rank 25 in about");
    expect(choiceLine([])).toContain("expected: the least of the six");
    expect(choiceLine(["Bladeburners"])).not.toContain("rank 25 in about");
  });

  test("the chaos left over 50 with Diplomacy paying, past twice its estimate and 10 min, fails; at it, passes", () => {
    const attempts = diplomaciesTo50(52, 1);
    const boundMs = 2 * attempts * 60_000 + BLADEBURNER_CHAOS_SLACK_MS;
    const left = (offsets: number[], installs: number[] = []) =>
      fold(
        at(offsets, () => ({ all: cities(52), found: BOUNTY, current: BOUNTY })),
        installs.map((offsetMs) => T0 + offsetMs),
      );
    expect(left(every10s(0, boundMs)).failures).toEqual([]);
    const late = left(every10s(0, boundMs + 1));
    expect(late.failures).toEqual([
      "the chaos over 50 where the division works, the rule's measure wanting it off, from " +
        `${new Date(T0).toISOString()} to ${new Date(T0 + boundMs + 1).toISOString()}, for ` +
        `${formatDuration(boundMs + 1)}, past its bound ${formatDuration(boundMs)} (Sector-12's chaos 52.00 at its ` +
        `start, the rule's Diplomacy estimate ${attempts} × 60 s = ${formatDuration(attempts * 60_000)}; the rule's ` +
        `choice: ${describeCityChoice(choiceOf({ all: cities(52) }) as never, "Sector-12")})`,
    ]);
    // A gap in the readings over `BLADEBURNER_GAP_MS` ends the stretch: each side under the bound.
    const half = Math.floor(boundMs / 2);
    const resumed = half + BLADEBURNER_GAP_MS + 1;
    expect(left([...every10s(0, half), ...every10s(resumed, resumed + half)]).failures).toEqual([]);
    // An install ends it too.
    expect(left(every10s(0, boundMs + 10_000), [half + 5_000]).failures).toEqual([]);
    // Idle (the owner's work, or a stop) isn't the rule's.
    const idle = fold(at(every10s(0, boundMs + 10_000), () => ({ all: cities(52), found: null, current: null })));
    expect(idle.failures).toEqual([]);
    // Under the rule's break-even (Diplomacy not paying, no better city): not wanted, however long.
    expect(
      fold(at(every10s(0, 2 * boundMs), () => ({ all: cities(50.001), found: BOUNTY, current: BOUNTY }))).failures,
    ).toEqual([]);
  });

  test("a move: the chaos at 80 left by the next reading, no failure; past two readings and an Agent round, it fails", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    const moved = fold(
      at([0, 10_000, 20_000], (offsetMs) => ({ all, city: offsetMs === 0 ? "Sector-12" : "Aevum", current: BOUNTY })),
    );
    expect(moved.failures).toEqual([]);
    // #385's review: a move's bound is the reading cadence's, not Diplomacy's.
    expect(BLADEBURNER_MOVE_WITHIN_MS).toBe(2 * BLADEBURNER_READING_SECONDS * 1000 + 2_000);
    const stayed = (offsets: number[]) => fold(at(offsets, () => ({ all, current: BOUNTY })));
    expect(stayed([0, 10_000, BLADEBURNER_MOVE_WITHIN_MS]).failures).toEqual([]);
    const late = stayed([0, 10_000, BLADEBURNER_MOVE_WITHIN_MS + 1]);
    expect(late.failures).toHaveLength(1);
    expect(late.failures[0]).toContain(
      "(Sector-12's chaos 80.00 at its start, a move to Aevum, within two readings and an Agent round; the rule's choice: ",
    );
    expect(late.failures[0]).toContain(`, past its bound ${formatDuration(BLADEBURNER_MOVE_WITHIN_MS)} (`);
  });

  test("with an older Agent's readings (no cities): said, no failure", () => {
    const { text, failures } = fold(at([0, 10_000], () => ({ all: null, current: BOUNTY })));
    expect(text).toContain("  the cities and the chaos (#383): no reading with them (an older Agent's)");
    expect(failures).toEqual([]);
  });

  test("Diplomacy under way isn't resting: B2's stuck-resting check leaves it alone", () => {
    const diplomacy = { type: "General", name: "Diplomacy" };
    const { text, failures } = fold(
      at(every10s(0, 40 * MINUTE), () => ({ all: cities(0), found: diplomacy, current: diplomacy })),
    );
    expect(failures).toEqual([]);
    expect(text).toContain("time under way: Diplomacy 40 min\n");
    expect(text).toContain(", 0 s of it resting, for 0.00 rank (Field Analysis's)");
  });
});

test("the reading interval the report's stretches split at is three readings", () => {
  expect(BLADEBURNER_GAP_MS).toBe(3 * BLADEBURNER_READING_SECONDS * 1000);
});
