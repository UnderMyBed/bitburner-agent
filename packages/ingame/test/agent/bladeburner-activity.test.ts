// The Agent's Bladeburner activity (#367): the worker run on the brain's state when it changes and every 10 s, its
// reading kept for the medium snapshot, nothing with none asked for; and the workers themselves on a stand-in NS: the
// division's join, and the reading with the faction's and (#375) the action's. The simulator runs the real ones
// (packages/brain/test/bladeburner-effectors.test.ts).
import {
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_WORKER_NAME,
  type BladeburnerState,
  deployedFilePath,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ROUNDS_BETWEEN, createBladeburnerActivity } from "../../src/agent/bladeburner.ts";
import type { WorkerRunner } from "../../src/agent/run-worker.ts";
import { SNAPSHOT_ROUND_MS } from "../../src/agent/snapshotter.ts";
import type { NS } from "../../src/ns.ts";
import { bladeburnerDivisionJoin } from "../../src/workers/bladeburner-division.ts";
import { bladeburnerReading } from "../../src/workers/bladeburner-reading.ts";

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
      getActionEstimatedSuccessChance: () => [0.4, 0.5],
      getActionCurrentLevel: (_type: string, name: string) => levels[name] ?? 1,
      getActionMaxLevel: (_type: string, name: string) => maxLevels[name] ?? 1,
      getActionCountRemaining: () => 10,
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
