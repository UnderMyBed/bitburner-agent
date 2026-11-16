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
  actionSuccessRange,
  BLADEBURNER_CITIES,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  type BladeburnerActionReading,
  type BladeburnerBlackOp,
  type BladeburnerCityReading,
  type BladeburnerPerson,
  blackOpSuccessChance,
  bladeburnerBlackOp,
  bladeburnerPricedInput,
  CONTROL_PROTOCOL_VERSION,
  chooseBladeburnerAction,
  chooseBladeburnerCity,
  type DesiredState,
  diplomaciesTo50,
  encodeControlMessage,
  type MediumSnapshotData,
  maxStaminaOf,
  memoizedBladeburnerChoice,
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
import { BLADEBURNER_GAP_MS, BladeburnerActionsFold } from "../src/bladeburner-actions-report.ts";
import {
  BLADEBURNER_CHAOS_SLACK_MS,
  BLADEBURNER_MOVE_WITHIN_MS,
  BladeburnerCitiesFold,
} from "../src/bladeburner-cities-report.ts";
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

/**
 * The round over the six (#420) as the city worker reads it, each city at its estimate (pop/popEst 1, `truths` aside:
 * a city's true population over its estimate there), the Black Op's range there its chance and that × the ratio
 * (`Actions/Action.ts:144-167`, no population factor), each action's its range at its truth and estimate.
 */
function roundOf(
  all: BladeburnerCityReading[],
  city: string,
  who: BladeburnerPerson = PERSON,
  truths: Record<string, number> = {},
) {
  const formula = blackOpSuccessChance(bladeburnerBlackOp("Operation Typhoon") as BladeburnerBlackOp, who, {
    penalty: 1,
  });
  return {
    blackOp: "Operation Typhoon",
    city,
    cities: all.map((each) => {
      const ratio = truths[each.name] ?? 1;
      const truth = { ...each, population: each.population * ratio };
      return {
        name: each.name,
        blackOp: actionSuccessRange(formula, formula, truth.population, each.population),
        actions: BLADEBURNER_LEVELLED_ACTIONS.map((action) => ({
          type: action.type,
          name: action.name,
          level: 1,
          chance: actionSuccessRange(
            actionSuccessChance(action, 1, who, { city: truth, penalty: 1 }),
            actionSuccessChance(action, 1, who, { city: each, penalty: 1 }),
            truth.population,
            each.population,
          ),
        })),
      };
    }),
  };
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
  /** The round (#420): absent, each city's at its estimate; null, one that failed; false, none (an older Agent). */
  round?: ReturnType<typeof roundOf> | null | false;
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
  round,
}: ReadingOptions = {}) {
  const here = all?.find((each) => each.name === city) ?? cities()[2];
  const theRound =
    round === false
      ? {}
      : { round: round === undefined && city !== null && all !== null ? roundOf(all, city, who) : (round ?? null) };
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
    ...(all === null ? {} : theRound),
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

/**
 * The rules' input with no Black Op read (#415: these readings are a B4 Agent's): the population not recovered, each
 * chance the fallback's, its mean over the estimate's spread (core's `bladeburnerPricedInput`), as the brain prices it.
 */
function spread<T extends Parameters<typeof bladeburnerPricedInput>[0]>(input: T): T {
  return bladeburnerPricedInput(input, { next: null, chanceRead: null }).input;
}

/** Core's choice on a reading, as the rule takes it. */
const choiceOf = (options: ReadingOptions = {}) => {
  const read = reading(options);
  return chooseBladeburnerCity(
    spread({
      readings: read.actions,
      person: PERSON,
      stamina: read.stamina,
      maxStamina: MAX_STAMINA,
      rankMultiplier: 1,
      speed: 1,
      skills: { read: {} },
      // As the brain's input (#418): the cities read (the drift, under a target) and the player's max HP and money;
      // and (#422's round 2) the round's measure of the city read, pop/popEst 1 (these readings' truth), at which the
      // chances are priced in place of the spread.
      drift: { cities: read.cities as BladeburnerCityReading[], city: read.city as string, ratio: 1 },
      hospital: { hpMax: 20, money: 1e6 },
    }),
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
    // At the round's pop/popEst 1 (#422's round 2: 0.31 over the spread before).
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
    const b2 = chooseBladeburnerAction(
      spread({
        readings: reading({ counts: COUNTS_OUT, who: STRONG }).actions,
        person: STRONG,
        stamina: MAX_STAMINA,
        maxStamina: MAX_STAMINA,
        rankMultiplier: 1,
        speed: 1,
      }),
    ).work;
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
        problem: "the Bladeburner reading's stamina, actions, skills, cities, Black Op or round aren't figures",
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

describe("the round over the six (#420): each city at its own measured truth", () => {
  const decide = (rule: BladeburnerRule, data: MediumSnapshotData, nowMs: number | null = null) =>
    rule.update({ mediumData: data, slowData: slow(6), homeKeptGb: 32, ownersWork: false, nowMs });
  // Volhaven's estimate low (0.8e9), its truth high (1.2e9: pop/popEst 1.5, its own draw): the others at 1e9, each its own.
  const all = cities(0, { Volhaven: { population: 0.8e9 } });
  const truths = { Volhaven: 1.5, Aevum: 0.9 };

  test("Volhaven's estimate under the others', its truth over: moved there by its own round, each ratio said", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium(reading({ all, round: roundOf(all, "Sector-12", PERSON, truths) }))).state?.city).toBe(
      "Volhaven",
    );
    expect(rule.view().round?.problem).toBeNull();
    expect(rule.view().round?.measures?.map((each) => [each.name, each.by, Number(each.ratio?.toFixed(6))])).toEqual(
      BLADEBURNER_CITIES.map((name) => [name, "recovered", (truths as Record<string, number>)[name] ?? 1]),
    );
    expect(rule.view().line).toContain(
      "; the round (#420): 6 of 6 recovered; Aevum pop/popEst 0.900 (the Black Op's, 10 ranges agreeing), Chongqing " +
        "pop/popEst 1.000 (the Black Op's, 10 ranges agreeing), ",
    );
    expect(rule.roundProblem()).toBeNull();
    // By the estimates alone (#418's shared ratio, gone), Volhaven's the least of the six: kept in Sector-12.
    const shared = new BladeburnerRule();
    expect(decide(shared, medium(reading({ all }))).state?.city).toBe("Sector-12");
  });

  test("no round (an older Agent), one that failed, or not back in the division's city: no city weighed, the alert's", () => {
    const moveWanted = cities(0, { "Sector-12": { chaos: 80 } });
    const older = new BladeburnerRule();
    // Sector-12's chaos at 80 wants Aevum, but with no city measured none is weighed: kept, and said.
    expect(decide(older, medium(reading({ all: moveWanted, round: false })), T0).state?.city).toBe("Sector-12");
    expect(older.view().actions?.cities).toBeNull();
    expect(older.roundProblem()).toEqual({
      sinceMs: T0,
      problem: "no round over the six cities in the reading (an Agent from before #420)",
    });
    expect(older.view().line).toContain("; no round over the six cities in the reading (an Agent from before #420)");
    // Its since held while it lasts, cleared once a round comes.
    decide(older, medium(reading({ all: moveWanted, round: false })), T0 + 10 * SECOND);
    expect(older.roundProblem()?.sinceMs).toBe(T0);
    decide(older, medium(reading({ all: moveWanted })), T0 + 20 * SECOND);
    expect(older.roundProblem()).toBeNull();
    expect(older.view().actions?.cities?.city).toBe("Aevum");
    // Failed (the worker's problem said), and not back.
    const failed = new BladeburnerRule();
    const problem = "the round (#420): the game didn't move the division to Ishima";
    decide(failed, medium({ ...reading({ all: moveWanted, round: null }), problems: [problem] }), T0);
    expect(failed.roundProblem()?.problem).toBe(`the round over the six cities failed: ${problem}`);
    expect(failed.view().actions?.cities).toBeNull();
    const away = new BladeburnerRule();
    decide(away, medium(reading({ all: moveWanted, round: roundOf(moveWanted, "Aevum") })), T0);
    expect(away.roundProblem()?.problem).toBe("the round left the division in Aevum, not Sector-12");
    expect(away.view().actions?.cities).toBeNull();
  });

  test("B2's and B3's chances in the city read at the round's ratio (#422's round 2), no Black Op read alone", () => {
    // Sector-12's own pop/popEst 1.3; these readings carry no Black Op of `bladeburner.js`'s (a B4 Agent's): before,
    // its chances were priced over the spread; now at the round's measure, as B4's.
    const truthsHere = { "Sector-12": 1.3 };
    const rule = new BladeburnerRule();
    decide(rule, medium(reading({ all, round: roundOf(all, "Sector-12", PERSON, truthsHere) })), T0);
    expect(rule.view().actions?.ratio).toBeCloseTo(1.3, 9);
    expect(rule.view().line).toContain("at the true population (pop/popEst 1.300)");
    // Without the round, the spread, as before.
    const older = new BladeburnerRule();
    decide(older, medium(reading({ all, round: false })), T0);
    expect(older.view().actions?.ratio).toBeNull();
  });

  test("a city's ranges that disagree (#420's ruling 4): the model off, the alert's", () => {
    const round = roundOf(all, "Sector-12", PERSON, truths);
    // Volhaven's Bounty Hunter range from a population 2% off its Black Op's.
    const off = {
      ...round,
      cities: round.cities.map((each) =>
        each.name !== "Volhaven"
          ? each
          : {
              ...each,
              actions: each.actions.map((action) =>
                action.name !== "Bounty Hunter"
                  ? action
                  : { ...action, chance: [action.chance[0] * 1.02, action.chance[1]] as [number, number] },
              ),
            },
      ),
    };
    const rule = new BladeburnerRule();
    decide(rule, medium(reading({ all, round: off })), T0);
    expect(rule.roundProblem()?.problem).toMatch(
      /^Volhaven's ranges in the round give pop\/popEst .* apart, past 2\.84e-14/,
    );
    // As read, all agree.
    const agreeing = new BladeburnerRule();
    decide(agreeing, medium(reading({ all, round })), T0);
    expect(agreeing.roundProblem()).toBeNull();
  });

  test("the round's figures checked: a range not a pair, or a city not the six's, is unread", () => {
    const round = roundOf(all, "Sector-12");
    const bad = { ...round, cities: [{ ...round.cities[0], blackOp: [0.2] }, ...round.cities.slice(1)] };
    expect(bladeburnerSnapshotOf(medium(reading({ all, round: bad as never }))).reading.kind).toBe("unread");
    const unknown = { ...round, cities: [{ ...round.cities[0], name: "Tokyo" }, ...round.cities.slice(1)] };
    expect(bladeburnerSnapshotOf(medium(reading({ all, round: unknown as never }))).reading.kind).toBe("unread");
    expect(bladeburnerSnapshotOf(medium(reading({ all, round }))).reading.kind).toBe("read");
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
      `(Sector-12's chaos 80.00 at its start, a move to Aevum, wanted at ${new Date(T0).toISOString()}, within two ` +
        "readings and an Agent round; the rule's choice: ",
    );
    expect(late.failures[0]).toContain(`, past its bound ${formatDuration(BLADEBURNER_MOVE_WITHIN_MS)} (`);
  });

  test("a move wanted with Diplomacy under way (#420's ruling 3): its bound the kept run's time left and 22 s", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    // Diplomacy under way from 0 (its first reading), the move first wanted at 20 s: 40 s of its 60 s run left then.
    const held = (offsets: number[]) =>
      fold(
        at(offsets, (offsetMs) =>
          offsetMs < 20_000
            ? { all: cities(0), current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY }
            : { all, current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY },
        ),
      );
    const boundMs = BLADEBURNER_MOVE_WITHIN_MS + 40_000;
    expect(held(every10s(0, 20_000 + boundMs)).failures).toEqual([]);
    const late = held(every10s(0, 20_000 + boundMs + 1));
    expect(late.failures).toHaveLength(1);
    expect(late.failures[0]).toContain(
      `a move to Aevum, wanted at ${new Date(T0 + 20_000).toISOString()}, within two readings and an Agent round ` +
        "after the Diplomacy run under way, kept to its end (#385): 40 s of its 60 s left then;",
    );
    expect(late.failures[0]).toContain(`, past its bound ${formatDuration(boundMs)} (`);
  });

  test("a move wanted with Diplomacy's later run under way, not one the rule chose again (#422's review): 22 s", () => {
    const all = cities(0, { "Sector-12": { chaos: 80 } });
    // Diplomacy under way from 0: its second run starts at 60 s, at a reading that doesn't keep it (#385's `keptRun`
    // 0, the rule not yet having ordered it again there), and the move first wanted at that reading has the plain
    // bound. (Diplomacy still under way at 70 s says the rule ordered it at 60 s, `order.name`: kept from then.)
    const unkept = (offsets: number[]) =>
      fold(
        at(offsets, (offsetMs) =>
          offsetMs < 60_000
            ? { all: cities(0), current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY }
            : { all, current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY },
        ),
      );
    expect(unkept(every10s(0, 60_000 + BLADEBURNER_MOVE_WITHIN_MS)).failures).toEqual([]);
    const late = unkept(every10s(0, 60_000 + BLADEBURNER_MOVE_WITHIN_MS + 1));
    expect(late.failures).toHaveLength(1);
    expect(late.failures[0]).toContain(
      `a move to Aevum, wanted at ${new Date(T0 + 60_000).toISOString()}, within two readings and an Agent round; `,
    );
    expect(late.failures[0]).toContain(`, past its bound ${formatDuration(BLADEBURNER_MOVE_WITHIN_MS)} (`);
    // Its second run ordered again at 60 s (still under way at 70 s: `order.name`'s re-keep), the move first wanted at
    // 80 s: that run's 40 s left are kept, the bound 22 + 40 s.
    const rekept = (offsets: number[]) =>
      fold(
        at(offsets, (offsetMs) =>
          offsetMs < 80_000
            ? { all: cities(0), current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY }
            : { all, current: DIPLOMACY_UNDER_WAY, found: DIPLOMACY_UNDER_WAY },
        ),
      );
    expect(rekept(every10s(0, 80_000 + BLADEBURNER_MOVE_WITHIN_MS + 40_000)).failures).toEqual([]);
    expect(rekept(every10s(0, 80_000 + BLADEBURNER_MOVE_WITHIN_MS + 40_001)).failures[0]).toContain(
      "after the Diplomacy run under way, kept to its end (#385): 40 s of its 60 s left then;",
    );
  });

  test("the round (#420): each city's measure over the window, the last in full; a reading without it fails", () => {
    const truths = { Volhaven: 1.5, Aevum: 0.9 };
    const all = cities(0);
    const measured = fold(
      at([0, 10_000], () => ({ all, current: BOUNTY, round: roundOf(all, "Sector-12", PERSON, truths) })),
    );
    expect(measured.failures).toEqual([]);
    expect(measured.text).toContain(
      "  the round over the six cities (#420): 2 of 2 readings measured each city; by city: Aevum recovered 2 " +
        "(pop/popEst 0.900 to 0.900; by the Black Op's range 2, by an action's 0; its branch by the estimate's pick 0), " +
        "at the draw's mean (every range clipped) 0; ",
    );
    expect(measured.text).toContain(
      "    at the last: the round (#420): 6 of 6 recovered; Aevum pop/popEst 0.900 (the Black Op's, 10 ranges agreeing), ",
    );
    expect(measured.text).toContain(
      "  the readings without the round's measure (failed, missing, the division not back in its city, or a city's " +
        "ranges disagreeing):\n    none",
    );
    const missing = fold(
      at([0, 10_000, 20_000], (offsetMs) => ({ all, current: BOUNTY, round: offsetMs < 20_000 ? false : undefined })),
    );
    expect(missing.failures).toEqual([
      `Bladeburner's round over the cities failed from ${new Date(T0).toISOString()} to ` +
        `${new Date(T0 + 10 * SECOND).toISOString()} (no round over the six cities in the reading (an Agent from before #420))`,
    ]);
    expect(missing.text).toContain("1 of 3 readings measured each city");
  });

  test("the rule's choice solved where a check reads it (#396): the chaos over 50 with an action under way, the last", () => {
    /** The solves over readings at `offsets`, `current` under way: those at the readings, and the section's. */
    const solves = (
      all: BladeburnerCityReading[],
      offsets = [0, 10_000, 20_000],
      current: { type: string; name: string } | null = BOUNTY,
    ) => {
      const folded = new BladeburnerCitiesFold();
      let count = 0;
      const counted: typeof chooseBladeburnerAction = (input) => {
        count += 1;
        return chooseBladeburnerAction(input);
      };
      for (const [atMs, data] of at(offsets, () => ({ all, current }))) {
        const read = bladeburnerSnapshotOf(data).reading;
        if (read.kind !== "read" || read.actions === null) throw new Error("not read");
        folded.add(atMs, data, read.actions, 6, null, read.rank, memoizedBladeburnerChoice(counted), read.problems);
      }
      const added = count;
      folded.section([]);
      return { added, section: count - added };
    };
    // Every city calm: no reading's check reads it; the last reading's line solves it, once.
    const calm = solves(cities(0));
    expect(calm.added).toBe(0);
    expect(calm.section).toBeGreaterThan(0);
    // Sector-12's chaos at 80: each reading's, once (the move's check); the last's line reads the one solved.
    const chaos = cities(0, { "Sector-12": { chaos: 80 } });
    const one = solves(chaos, [0]);
    const chaotic = solves(chaos);
    expect(one.added).toBeGreaterThan(0);
    expect(chaotic.added).toBe(3 * one.added);
    expect(chaotic.section).toBe(0);
    // The chaos at 80 with no action under way: the check doesn't read it; the last's line solves it, once.
    expect(solves(chaos, [0, 10_000, 20_000], null)).toEqual({ added: 0, section: one.added });
  });

  test("a reading resting and chaotic (#396): each fold's solve once, through the memo they share", () => {
    const chaos = cities(0, { "Sector-12": { chaos: 80 } });
    /** The solves over two readings with Field Analysis under way in the chaos, through each reading's one memo. */
    const solves = ({ actions, cities: inCities }: { actions: boolean; cities: boolean }) => {
      const actionsFold = new BladeburnerActionsFold(() => false);
      const citiesFold = new BladeburnerCitiesFold();
      let count = 0;
      const counted: typeof chooseBladeburnerAction = (input) => {
        count += 1;
        return chooseBladeburnerAction(input);
      };
      for (const [atMs, data] of at([0, 10_000], () => ({ all: chaos, current: REST }))) {
        const read = bladeburnerSnapshotOf(data).reading;
        if (read.kind !== "read" || read.rank === null || read.actions === null) throw new Error("not read");
        const choose = memoizedBladeburnerChoice(counted);
        if (actions) actionsFold.add(atMs, data, read.rank, read.actions, 6, null, choose);
        if (inCities) citiesFold.add(atMs, data, read.actions, 6, null, read.rank, choose, read.problems);
      }
      return count;
    };
    // The actions fold's plan each reading, once (the first's line and the stuck-resting check read the one); the cities
    // fold's choice each, once (the move's check). Both: their sum, neither solved again. The plan isn't one of the
    // choice's solves: under the drift (#418) their inputs differ (the plan's drift the city read's at its ratio, the
    // choice's each city's at its chaos), so the memo they share doesn't join them.
    expect(solves({ actions: true, cities: false })).toBe(2);
    const choice = solves({ actions: false, cities: true });
    expect(choice).toBeGreaterThan(0);
    expect(solves({ actions: true, cities: true })).toBe(2 + choice);
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
