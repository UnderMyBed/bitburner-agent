// The Agent's Bladeburner activity (#367): the worker run on the brain's state when it changes and every 10 s, its
// reading kept for the medium snapshot, nothing with none asked for; and the workers themselves on a stand-in NS: the
// division's join and the reading with the faction's. The simulator runs the real ones
// (packages/brain/test/bladeburner-effectors.test.ts).
import { BLADEBURNER_WORKER_NAME, type BladeburnerState, deployedFilePath } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BLADEBURNER_ROUNDS_BETWEEN, createBladeburnerActivity } from "../../src/agent/bladeburner.ts";
import type { WorkerRunner } from "../../src/agent/run-worker.ts";
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

/** A stand-in NS's Bladeburner: in the division or not, at a rank, and what each call did. */
function standIn({ inDivision = false, rank = 0, joins = true } = {}) {
  const calls: string[] = [];
  let joined = inDivision;
  const ns = {
    bladeburner: {
      inBladeburner: () => joined,
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
  expect(bladeburnerReading(reading.ns, { joinTheFaction: false })).toEqual({ rank: 12.5, problems: [] });
  expect(reading.calls).toEqual([]);
  const joining = standIn({ inDivision: true, rank: 25 });
  expect(bladeburnerReading(joining.ns, { joinTheFaction: true })).toEqual({ rank: 25, problems: [] });
  expect(joining.calls).toEqual(["joinBladeburnerFaction"]);
  // A stale state (the rank fallen under 25): not asked of the game, a problem.
  const stale = standIn({ inDivision: true, rank: 24 });
  expect(bladeburnerReading(stale.ns, { joinTheFaction: true })).toEqual({
    rank: 24,
    problems: ["the faction asked for at rank 24.0, under 25"],
  });
  expect(stale.calls).toEqual([]);
  const refused = standIn({ inDivision: true, rank: 40, joins: false });
  expect(bladeburnerReading(refused.ns, { joinTheFaction: true })).toEqual({
    rank: 40,
    problems: ["the game didn't take the player into the Bladeburners faction at rank 40.0"],
  });
});
