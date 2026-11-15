// The Agent's Bladeburner activity (#367): the worker run on the brain's state when it changes and every 10 s, its
// reading kept for the medium snapshot, nothing with none asked for, and (#383) the city worker run first with a city
// in the state; and the workers themselves on a stand-in NS: the division's join, the reading with the faction's and
// (#375) the action's, (#379) a skill raised to a level, and (#383) the division moved and the cities read. The
// simulator runs the real ones (packages/brain/test/bladeburner-effectors.test.ts).
import {
  BLACK_OPERATIONS,
  BLADEBURNER_BLACK_OPS,
  BLADEBURNER_CITIES,
  BLADEBURNER_CITY_WORKER_NAME,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_SKILL_NAMES,
  BLADEBURNER_WORKER_NAME,
  type BladeburnerState,
  deployedFilePath,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ROUNDS_BETWEEN, createBladeburnerActivity } from "../../src/agent/bladeburner.ts";
import type { WorkerRunner } from "../../src/agent/run-worker.ts";
import { SNAPSHOT_ROUND_MS } from "../../src/agent/snapshotter.ts";
import type { NS } from "../../src/ns.ts";
import { bladeburnerCityReading } from "../../src/workers/bladeburner-city.ts";
import { bladeburnerDivisionJoin } from "../../src/workers/bladeburner-division.ts";
import { bladeburnerReading } from "../../src/workers/bladeburner-reading.ts";
import { bladeburnerSkillRaise } from "../../src/workers/bladeburner-skill.ts";

function activity() {
  const runs: BladeburnerState[] = [];
  let reports = true;
  const ns = { print: () => {} } as unknown as NS;
  const workerRunner = {
    runWorker: async (file: string, args: unknown[]) => {
      expect(file).toBe(deployedFilePath("0123456789ab", BLADEBURNER_WORKER_NAME));
      runs.push(JSON.parse(args[0] as string) as BladeburnerState);
      return reports
        ? { outcome: "reported", report: { pid: 1, data: { rank: runs.length, problems: [] } } }
        : { outcome: "noReport" };
    },
  } as unknown as WorkerRunner;
  const bladeburner = createBladeburnerActivity(ns, { deploymentId: "0123456789ab", workerRunner });
  return {
    bladeburner,
    runs,
    failing: (fails: boolean) => {
      reports = !fails;
    },
    round: () => bladeburner.convergeIfDue(Number.POSITIVE_INFINITY),
  };
}

test("none asked for: nothing runs, and there's no reading", async () => {
  const { bladeburner, runs, round } = activity();
  await round();
  bladeburner.desire(null);
  await round();
  expect(runs).toEqual([]);
  expect(bladeburner.reading()).toBeNull();
});

test("asked for: run at once, then every 10 s, and at once on a change; its reading kept", async () => {
  // Core's reading interval (#375), which the rule's counts and the report's allowance take, is this.
  expect(BLADEBURNER_ROUNDS_BETWEEN * SNAPSHOT_ROUND_MS).toBe(BLADEBURNER_READING_SECONDS * 1000);
  const { bladeburner, runs, round } = activity();
  bladeburner.desire({ joinTheFaction: false });
  await round();
  expect(bladeburner.reading()).toEqual({ rank: 1, problems: [] });
  for (let each = 1; each < BLADEBURNER_ROUNDS_BETWEEN; each++) await round();
  expect(runs).toHaveLength(1);
  await round();
  expect(runs).toHaveLength(2);
  bladeburner.desire({ joinTheFaction: true });
  await round();
  expect(runs).toEqual([{ joinTheFaction: false }, { joinTheFaction: false }, { joinTheFaction: true }]);
  // The same state again changes nothing.
  bladeburner.desire({ joinTheFaction: true });
  await round();
  expect(runs).toHaveLength(3);
});

test("a run that doesn't report is tried next round; the brain gone, or none asked for, the reading goes", async () => {
  const { bladeburner, runs, round, failing } = activity();
  failing(true);
  bladeburner.desire({ joinTheFaction: false });
  await round();
  await round();
  expect(runs).toHaveLength(2);
  expect(bladeburner.reading()).toBeNull();
  failing(false);
  await round();
  expect(bladeburner.reading()).not.toBeNull();
  bladeburner.forget();
  expect(bladeburner.reading()).toBeNull();
  await round();
  expect(runs).toHaveLength(3);
  bladeburner.desire({ joinTheFaction: false });
  await round();
  bladeburner.desire(null);
  expect(bladeburner.reading()).toBeNull();
});

/**
 * A stand-in NS's Bladeburner: in the division or not, at a rank, and what each call that changes the game did (#375:
 * the action under way, each action's level and max level, whether the game starts one).
 */
function standIn({
  inDivision = false,
  rank = 0,
  joins = true,
  current = null as { type: string; name: string } | null,
  levels = {} as Record<string, number>,
  maxLevels = {} as Record<string, number>,
  starts = true,
  points = 0,
  skills = {} as Record<string, number>,
  blackOpsDone = 0,
} = {}) {
  const calls: string[] = [];
  let joined = inDivision;
  let underWay = current;
  const ns = {
    bladeburner: {
      inBladeburner: () => joined,
      getStamina: () => [30, 40],
      getBonusTime: () => 2_500,
      getCurrentAction: () => underWay,
      getActionEstimatedSuccessChance: (type: string) => (type === BLACK_OPERATIONS ? [0.3, 0.35] : [0.4, 0.5]),
      getActionCurrentLevel: (_type: string, name: string) => levels[name] ?? 1,
      getActionMaxLevel: (_type: string, name: string) => maxLevels[name] ?? 1,
      // A Black Op's count: 0 once done, else 1 (`NetscriptFunctions/Bladeburner.ts:182-183`).
      getActionCountRemaining: (type: string, name: string) =>
        type === BLACK_OPERATIONS
          ? BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === name) < blackOpsDone
            ? 0
            : 1
          : 10,
      setActionAutolevel: (_type: string, name: string, autoLevel: boolean) => {
        calls.push(`setActionAutolevel(${name}, ${autoLevel})`);
      },
      setActionLevel: (_type: string, name: string, level: number) => {
        calls.push(`setActionLevel(${name}, ${level})`);
        levels[name] = level;
      },
      startAction: (type: string, name: string) => {
        calls.push(`startAction(${type}, ${name})`);
        if (starts) underWay = { type, name };
        return starts;
      },
      joinBladeburnerDivision: () => {
        calls.push("joinBladeburnerDivision");
        if (joins) joined = true;
        return joins;
      },
      joinBladeburnerFaction: () => {
        calls.push("joinBladeburnerFaction");
        return joins;
      },
      getRank: () => rank,
      getSkillPoints: () => points,
      getSkillLevel: (name: string) => skills[name] ?? 0,
      upgradeSkill: (name: string, count: number) => {
        calls.push(`upgradeSkill(${name}, ${count})`);
        // Each level 2 points, for the stand-in.
        if (2 * count > points) return false;
        points -= 2 * count;
        skills[name] = (skills[name] ?? 0) + count;
        return true;
      },
    },
  } as unknown as NS;
  return { ns, calls };
}

test("join-bladeburner.js: in the division already, done with nothing called; else joined, or the game's refusal", () => {
  const already = standIn({ inDivision: true });
  expect(bladeburnerDivisionJoin(already.ns)).toEqual({ done: true, problem: null });
  expect(already.calls).toEqual([]);
  const fresh = standIn();
  expect(bladeburnerDivisionJoin(fresh.ns)).toEqual({ done: true, problem: null });
  expect(fresh.calls).toEqual(["joinBladeburnerDivision"]);
  const refused = standIn({ joins: false });
  expect(bladeburnerDivisionJoin(refused.ns)).toEqual({
    done: false,
    problem:
      "the game didn't take the player into the Bladeburner division: a combat stat under 100, or no Bladeburner " +
      "here (BN6, BN7, or SF6 or SF7; none in BN8)",
  });
});

test("bladeburner.js: not in the division, no rank and nothing done; in it, the rank, and the faction once at 25", () => {
  const out = standIn({ rank: 30 });
  expect(bladeburnerReading(out.ns, { joinTheFaction: true })).toEqual({ rank: null, problems: [] });
  expect(out.calls).toEqual([]);
  const reading = standIn({ inDivision: true, rank: 12.5 });
  expect(bladeburnerReading(reading.ns, { joinTheFaction: false })).toMatchObject({ rank: 12.5, problems: [] });
  expect(reading.calls).toEqual([]);
  const joining = standIn({ inDivision: true, rank: 25 });
  expect(bladeburnerReading(joining.ns, { joinTheFaction: true })).toMatchObject({ rank: 25, problems: [] });
  expect(joining.calls).toEqual(["joinBladeburnerFaction"]);
  // A stale state (the rank fallen under 25): not asked of the game, a problem.
  const stale = standIn({ inDivision: true, rank: 24 });
  expect(bladeburnerReading(stale.ns, { joinTheFaction: true })).toMatchObject({
    rank: 24,
    problems: ["the faction asked for at rank 24.0, under 25"],
  });
  expect(stale.calls).toEqual([]);
  const refused = standIn({ inDivision: true, rank: 40, joins: false });
  expect(bladeburnerReading(refused.ns, { joinTheFaction: true })).toMatchObject({
    rank: 40,
    problems: ["the game didn't take the player into the Bladeburners faction at rank 40.0"],
  });
});

test("bladeburner.js's action (#375): the level held, started unless under way; a stale level or a refusal a problem", () => {
  const tracking = { type: "Contracts", name: "Tracking" } as const;
  const order = { ...tracking, level: 2 };
  const first = standIn({ inDivision: true, maxLevels: { Tracking: 3 } });
  const reading = bladeburnerReading(first.ns, { joinTheFaction: false, action: order });
  expect(first.calls).toEqual([
    "setActionAutolevel(Tracking, false)",
    "setActionLevel(Tracking, 2)",
    "startAction(Contracts, Tracking)",
  ]);
  // B2's figures: the stamina, the bonus time in seconds, what was found and what's under way, each action read.
  expect(reading).toEqual({
    rank: 0,
    problems: [],
    stamina: 30,
    maxStamina: 40,
    bonusSeconds: 2.5,
    found: null,
    current: tracking,
    actions: BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => ({
      type,
      name,
      level: name === "Tracking" ? 2 : 1,
      maxLevel: name === "Tracking" ? 3 : 1,
      count: 10,
      chance: [0.4, 0.5],
    })),
    // B3 (#379): the points, and every skill's level.
    skillPoints: 0,
    skillLevels: Object.fromEntries(BLADEBURNER_SKILL_NAMES.map((name) => [name, 0])),
    // B5 (#392): the next Black Op, and the game's range for it.
    blackOp: { name: "Operation Typhoon", chance: [0.3, 0.35] },
  });
  // Under way at its level: nothing started again, the level not set again.
  const again = standIn({ inDivision: true, current: tracking, levels: { Tracking: 2 }, maxLevels: { Tracking: 3 } });
  expect(bladeburnerReading(again.ns, { joinTheFaction: false, action: order })).toMatchObject({
    problems: [],
    found: tracking,
    current: tracking,
  });
  expect(again.calls).toEqual(["setActionAutolevel(Tracking, false)"]);
  // At its max: held there. Over it: a stale state, nothing done.
  const atMax = standIn({ inDivision: true, maxLevels: { Tracking: 3 } });
  expect(bladeburnerReading(atMax.ns, { joinTheFaction: false, action: { ...order, level: 3 } }).problems).toEqual([]);
  expect(atMax.calls).toContain("setActionLevel(Tracking, 3)");
  const stale = standIn({ inDivision: true });
  expect(bladeburnerReading(stale.ns, { joinTheFaction: false, action: order }).problems).toEqual([
    "Tracking asked for at level 2, over its max 1",
  ]);
  expect(stale.calls).toEqual([]);
  // The game refusing it (its count under 1).
  const refused = standIn({ inDivision: true, maxLevels: { Tracking: 3 }, starts: false });
  expect(bladeburnerReading(refused.ns, { joinTheFaction: false, action: order })).toMatchObject({
    problems: ["the game didn't start Tracking (Contracts): its count under 1, or the action unknown"],
    current: null,
  });
  // A rest: started, no level; none asked for: nothing done.
  const rest = standIn({ inDivision: true, current: tracking });
  bladeburnerReading(rest.ns, {
    joinTheFaction: false,
    action: { type: "General", name: "Field Analysis", level: null },
  });
  expect(rest.calls).toEqual(["startAction(General, Field Analysis)"]);
  const none = standIn({ inDivision: true, current: tracking });
  expect(bladeburnerReading(none.ns, { joinTheFaction: false })).toMatchObject({ found: tracking, current: tracking });
  expect(none.calls).toEqual([]);
});

test("bladeburner.js's Black Ops (#392): the next in order read, none once all 21 are done; one run as an action", () => {
  const second = standIn({ inDivision: true, blackOpsDone: 1 });
  expect(bladeburnerReading(second.ns, { joinTheFaction: false }).blackOp).toEqual({
    name: "Operation Zero",
    chance: [0.3, 0.35],
  });
  const done = standIn({ inDivision: true, blackOpsDone: 21 });
  expect(bladeburnerReading(done.ns, { joinTheFaction: false }).blackOp).toBeNull();
  // Run: started, no level held (a Black Op has none); under way, not started again.
  const order = { type: BLACK_OPERATIONS, name: "Operation Typhoon", level: null } as const;
  const run = standIn({ inDivision: true });
  expect(bladeburnerReading(run.ns, { joinTheFaction: false, action: order })).toMatchObject({
    problems: [],
    current: { type: BLACK_OPERATIONS, name: "Operation Typhoon" },
  });
  expect(run.calls).toEqual(["startAction(Black Operations, Operation Typhoon)"]);
  const underWay = standIn({ inDivision: true, current: { type: BLACK_OPERATIONS, name: "Operation Typhoon" } });
  bladeburnerReading(underWay.ns, { joinTheFaction: false, action: order });
  expect(underWay.calls).toEqual([]);
  // Done since the brain asked (a state that outlived its one attempt): nothing started, no problem.
  const stale = standIn({ inDivision: true, blackOpsDone: 1 });
  expect(bladeburnerReading(stale.ns, { joinTheFaction: false, action: order }).problems).toEqual([]);
  expect(stale.calls).toEqual([]);
  // The game refusing it (its rank not met, or one before it not done): a problem.
  const refused = standIn({ inDivision: true, starts: false });
  expect(bladeburnerReading(refused.ns, { joinTheFaction: false, action: order }).problems).toEqual([
    "the game didn't start Operation Typhoon (Black Operations): the rank under its own, or not the next",
  ]);
});

test("bladeburner-skill.js (#379): at the level or over, done with nothing bought; else the levels short in one call; refusals", () => {
  const at = standIn({ inDivision: true, points: 10, skills: { Overclock: 3 } });
  expect(bladeburnerSkillRaise(at.ns, "Overclock", 3)).toEqual({ done: true, problem: null });
  expect(bladeburnerSkillRaise(at.ns, "Overclock", 2)).toEqual({ done: true, problem: null });
  expect(at.calls).toEqual([]);
  const short = standIn({ inDivision: true, points: 10, skills: { Overclock: 1 } });
  expect(bladeburnerSkillRaise(short.ns, "Overclock", 4)).toEqual({ done: true, problem: null });
  expect(short.calls).toEqual(["upgradeSkill(Overclock, 3)"]);
  const poor = standIn({ inDivision: true, points: 3 });
  expect(bladeburnerSkillRaise(poor.ns, "Cloak", 2)).toEqual({
    done: false,
    problem: "the game didn't raise Cloak from level 0 to 2: too few skill points, or past its max",
  });
  const out = standIn({ points: 10 });
  expect(bladeburnerSkillRaise(out.ns, "Cloak", 1)).toEqual({
    done: false,
    problem: "not in the Bladeburner division",
  });
  expect(out.calls).toEqual([]);
  for (const [skill, level] of [
    ["Overclocked", 1],
    ["Cloak", 0],
    ["Cloak", 1.5],
  ] as const) {
    expect(bladeburnerSkillRaise(standIn({ inDivision: true }).ns, skill, level)).toEqual({
      done: false,
      problem: `no Bladeburner skill ${JSON.stringify(skill)} at level ${level} to raise`,
    });
  }
});

/** The activity with both workers stood in (#383): what each was run with, in order, and what each reports. */
function withCities() {
  const runs: { file: string; arg: unknown }[] = [];
  const reports = { city: true, reading: true };
  const ns = { print: () => {} } as unknown as NS;
  const workerRunner = {
    runWorker: async (file: string, args: unknown[]) => {
      runs.push({ file, arg: JSON.parse(args[0] as string) });
      if (file === deployedFilePath("0123456789ab", BLADEBURNER_CITY_WORKER_NAME)) {
        return reports.city
          ? {
              outcome: "reported",
              report: {
                pid: 1,
                data: { city: "Aevum", cities: [CITY_READ], problems: ["a city problem"], round: CITY_ROUND },
              },
            }
          : { outcome: "noReport" };
      }
      expect(file).toBe(deployedFilePath("0123456789ab", BLADEBURNER_WORKER_NAME));
      return reports.reading
        ? { outcome: "reported", report: { pid: 2, data: { rank: 5, problems: ["a reading problem"] } } }
        : { outcome: "noReport" };
    },
  } as unknown as WorkerRunner;
  const bladeburner = createBladeburnerActivity(ns, { deploymentId: "0123456789ab", workerRunner });
  return { bladeburner, runs, reports, round: () => bladeburner.convergeIfDue(Number.POSITIVE_INFINITY) };
}
const CITY_READ = { name: "Aevum", population: 1.2e9, communities: 40, chaos: 3 };
/** The round's (#420), as the city worker reports it: passed into the reading as it is. */
const CITY_ROUND = {
  blackOp: "Operation Typhoon",
  cities: [{ name: "Aevum", blackOp: [0.2, 0.3], actions: [] }],
  city: "Aevum",
};

test("with a city in the state (#383): bladeburner-city.js first, then bladeburner.js; the cities in the reading", async () => {
  const { bladeburner, runs, round } = withCities();
  bladeburner.desire({ joinTheFaction: false, city: "Aevum" });
  await round();
  expect(runs.map((run) => run.file.split("/").at(-1))).toEqual([
    BLADEBURNER_CITY_WORKER_NAME,
    BLADEBURNER_WORKER_NAME,
  ]);
  expect(runs[0]?.arg).toBe("Aevum");
  expect(bladeburner.reading()).toEqual({
    rank: 5,
    problems: ["a city problem", "a reading problem"],
    city: "Aevum",
    cities: [CITY_READ],
    round: CITY_ROUND,
  });
  // Null: the cities read, none to move to.
  bladeburner.desire({ joinTheFaction: false, city: null });
  await round();
  expect(runs[2]?.arg).toBeNull();
  // No city in the state (a B3 brain): bladeburner.js alone, as before.
  bladeburner.desire({ joinTheFaction: true });
  await round();
  expect(runs.slice(4).map((run) => run.file.split("/").at(-1))).toEqual([BLADEBURNER_WORKER_NAME]);
  expect(bladeburner.reading()).toEqual({ rank: 5, problems: ["a reading problem"] });
});

test("a city run that doesn't report: no reading run, both tried again next round", async () => {
  const { bladeburner, runs, reports, round } = withCities();
  reports.city = false;
  bladeburner.desire({ joinTheFaction: false, city: "Aevum" });
  await round();
  expect(runs.map((run) => run.file.split("/").at(-1))).toEqual([BLADEBURNER_CITY_WORKER_NAME]);
  expect(bladeburner.reading()).toBeNull();
  reports.city = true;
  reports.reading = false;
  await round();
  expect(runs).toHaveLength(3);
  expect(bladeburner.reading()).toBeNull();
  reports.reading = true;
  await round();
  expect(runs).toHaveLength(5);
  expect(bladeburner.reading()?.city).toBe("Aevum");
});

/**
 * A stand-in NS's Bladeburner for the cities (#383): in the division or not, its city, whether a switch takes (or which
 * city refuses one), and whether the switch back is dropped; and (#420) each range read in the city the division is in
 * then (the low end the city's index, the Black Op's a tenth over it), and a game "tick" queued at each switch, as a
 * microtask: any range read once one ran is marked, so a yield inside the round shows.
 */
function cityStandIn({
  inDivision = true,
  city = "Sector-12",
  switches = true,
  refuses = null as string | null,
  next = "Operation Typhoon" as string | null,
  throwsIn = null as string | null,
} = {}) {
  const calls: string[] = [];
  const ranges: { city: string; name: string; afterTick: boolean }[] = [];
  let at = city;
  let ticked = false;
  const ns = {
    bladeburner: {
      inBladeburner: () => inDivision,
      getCity: () => at,
      switchCity: (name: string) => {
        calls.push(`switchCity(${name})`);
        queueMicrotask(() => {
          ticked = true;
        });
        const takes = switches && name !== refuses;
        if (takes) at = name;
        return takes;
      },
      getCityEstimatedPopulation: (name: string) => 1e9 + name.length,
      getCityCommunities: (name: string) => name.length,
      getCityChaos: (name: string) => (name === at ? 7 : 0),
      getNextBlackOp: () => (next === null ? null : { name: next, rank: 2500 }),
      getActionCurrentLevel: () => 2,
      getActionEstimatedSuccessChance: (type: string, name: string) => {
        // `Actions/Action.ts:193`'s throw (a competence NaN), in one city.
        if (at === throwsIn) throw new Error("Competence calculated as NaN in Action.getSuccessChance()");
        ranges.push({ city: at, name, afterTick: ticked });
        const index = BLADEBURNER_CITIES.indexOf(at as (typeof BLADEBURNER_CITIES)[number]) + 1;
        return type === BLACK_OPERATIONS ? [index / 100, index / 100 + 0.1] : [index / 10, index / 10 + 0.05];
      },
    },
  } as unknown as NS;
  return { ns, calls, ranges, tickedYet: () => ticked };
}

test("bladeburner-city.js (#383): moved unless there, then the six read; null moves nothing; refusals", () => {
  const moving = cityStandIn();
  const reading = bladeburnerCityReading(moving.ns, "Aevum");
  expect(moving.calls[0]).toBe("switchCity(Aevum)");
  expect(reading).toMatchObject({
    city: "Aevum",
    cities: BLADEBURNER_CITIES.map((name) => ({
      name,
      population: 1e9 + name.length,
      communities: name.length,
      chaos: name === "Aevum" ? 7 : 0,
    })),
    problems: [],
  });
  const there = cityStandIn({ city: "Aevum" });
  expect(bladeburnerCityReading(there.ns, "Aevum").city).toBe("Aevum");
  expect(there.calls[0]).toBe("switchCity(Aevum)");
  expect(there.calls).toHaveLength(7);
  const none = cityStandIn();
  expect(bladeburnerCityReading(none.ns, null).city).toBe("Sector-12");
  const refused = cityStandIn({ switches: false });
  expect(bladeburnerCityReading(refused.ns, "Ishima")).toMatchObject({
    city: "Sector-12",
    problems: [
      "the game didn't move the division to Ishima",
      "the round (#420): the game didn't move the division to Aevum",
    ],
    round: null,
  });
  const unknown = cityStandIn();
  expect(bladeburnerCityReading(unknown.ns, "Tokyo")).toMatchObject({
    city: "Sector-12",
    problems: ['no city "Tokyo" to work in'],
  });
  expect(unknown.calls.includes("switchCity(Tokyo)")).toBe(false);
  const out = cityStandIn({ inDivision: false });
  expect(bladeburnerCityReading(out.ns, "Aevum")).toEqual({ city: null, cities: [], problems: [] });
  expect(out.calls).toEqual([]);
});

test("bladeburner-city.js's round (#420): each city's own ranges, then back; synchronous; a refusal, no round", () => {
  const stand = cityStandIn({ city: "Ishima" });
  const reading = bladeburnerCityReading(stand.ns, null);
  // A switch to each in the game's order, then back to the division's city: no yield between (no tick ran).
  expect(stand.calls).toEqual([...BLADEBURNER_CITIES.map((name) => `switchCity(${name})`), "switchCity(Ishima)"]);
  expect(reading).not.toBeInstanceOf(Promise);
  expect(stand.tickedYet()).toBe(false);
  expect(stand.ranges.every((each) => !each.afterTick)).toBe(true);
  expect(reading.city).toBe("Ishima");
  expect(reading.round?.city).toBe("Ishima");
  expect(reading.round?.blackOp).toBe("Operation Typhoon");
  // Each city's ranges are its own: read with the division there.
  for (const [i, name] of BLADEBURNER_CITIES.entries()) {
    const own = reading.round?.cities[i];
    expect(own?.name).toBe(name);
    expect(own?.blackOp).toEqual([(i + 1) / 100, (i + 1) / 100 + 0.1]);
    expect(own?.actions.map((each) => each.name)).toEqual(BLADEBURNER_LEVELLED_ACTIONS.map((each) => each.name));
    expect(own?.actions.every((each) => each.chance[0] === (i + 1) / 10)).toBe(true);
  }
  expect(stand.ranges.filter((each) => each.city === "Volhaven")).toHaveLength(1 + BLADEBURNER_LEVELLED_ACTIONS.length);
  // All 21 done: no Black Op range, the actions' still.
  const done = bladeburnerCityReading(cityStandIn({ next: null }).ns, null);
  expect(done.round?.blackOp).toBeNull();
  expect(done.round?.cities.every((each) => each.blackOp === null && each.actions.length > 0)).toBe(true);
  // A city refusing the switch: no round, the division back, the problem said.
  const refusing = cityStandIn({ refuses: "New Tokyo" });
  const refused = bladeburnerCityReading(refusing.ns, null);
  expect(refused.round).toBeNull();
  expect(refused.problems).toEqual(["the round (#420): the game didn't move the division to New Tokyo"]);
  expect(refusing.calls.at(-1)).toBe("switchCity(Sector-12)");
  expect(refused.city).toBe("Sector-12");
  // Each action's level read with its range (#420's ruling 4).
  expect(reading.round?.cities[0]?.actions.every((each) => each.level === 2)).toBe(true);
  // A read that throws in New Tokyo (#422's review): the division switched back all the same (`finally`), no round.
  const throwing = cityStandIn({ throwsIn: "New Tokyo" });
  const threw = bladeburnerCityReading(throwing.ns, null);
  expect(threw.round).toBeNull();
  expect(threw.city).toBe("Sector-12");
  expect(throwing.calls.at(-1)).toBe("switchCity(Sector-12)");
  expect(threw.problems).toEqual([
    "the round (#420): a read threw in New Tokyo: Competence calculated as NaN in Action.getSuccessChance()",
  ]);
});
