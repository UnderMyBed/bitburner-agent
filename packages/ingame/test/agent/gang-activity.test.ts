// The Agent's gang activity (#325; G4, #332): the worker run on the brain's state, and, when the brain that ordered
// territory warfare goes, once more with warfare off, owed until a run sets the flag. The worker is a stand-in; the
// simulator runs the real one (packages/brain/test/gang-effectors.test.ts).
import { deployedFilePath, GANG_WORKER_NAME, type GangState } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { createGangActivity, GANG_DISENGAGE_STATE } from "../../src/agent/gang.ts";
import type { WorkerRunner } from "../../src/agent/run-worker.ts";
import type { NS } from "../../src/ns.ts";

const STATE: GangState = {
  recruit: [],
  ascend: [],
  tasks: { a: "Territory Warfare" },
  buy: [],
  keepMoney: null,
  warfare: { engage: true, leastTerritoryPerUpdate: 0 },
};

function activity() {
  const runs: GangState[] = [];
  let reports = true;
  const ns = { print: () => {} } as unknown as NS;
  const workerRunner = {
    runWorker: async (file: string, args: unknown[]) => {
      expect(file).toBe(deployedFilePath("0123456789ab", GANG_WORKER_NAME));
      runs.push(JSON.parse(args[0] as string) as GangState);
      return reports
        ? { outcome: "reported", report: { pid: 1, data: { gang: null, members: [], problems: [] } } }
        : { outcome: "noReport" };
    },
  } as unknown as WorkerRunner;
  const gang = createGangActivity(ns, { deploymentId: "0123456789ab", workerRunner });
  return {
    gang,
    runs,
    failing: (fails: boolean) => {
      reports = !fails;
    },
    round: () => gang.convergeIfDue(Number.POSITIVE_INFINITY),
  };
}

test("the brain gone with warfare ordered: one run with warfare off; then nothing", async () => {
  const { gang, runs, round } = activity();
  gang.desire(STATE);
  await round();
  gang.forget();
  await round();
  await round();
  expect(runs).toEqual([STATE, GANG_DISENGAGE_STATE]);
});

test("holding (no gang in the state): the same; a brain that ordered none: nothing", async () => {
  const held = activity();
  held.gang.desire(STATE);
  await held.round();
  held.gang.desire(null);
  await held.round();
  expect(held.runs).toEqual([STATE, GANG_DISENGAGE_STATE]);
  const older = activity();
  older.gang.desire({ ...STATE, warfare: null });
  await older.round();
  older.gang.forget();
  await older.round();
  expect(older.runs).toHaveLength(1);
});

test("a disengage that fails is owed until a run sets the flag: an older brain back first has its state run with warfare off", async () => {
  const { gang, runs, round, failing } = activity();
  gang.desire(STATE);
  await round();
  failing(true);
  gang.forget();
  await round();
  failing(false);
  // An older brain, no order: its state, warfare off.
  gang.desire({ ...STATE, warfare: null });
  await round();
  expect(runs.at(-1)).toEqual({ ...STATE, warfare: GANG_DISENGAGE_STATE.warfare });
  // Done: its next runs are its own state as it sent it.
  gang.desire({ ...STATE, tasks: {}, warfare: null });
  await round();
  expect(runs.at(-1)).toEqual({ ...STATE, tasks: {}, warfare: null });
  // A brain with its own order back first: its order sets the flag, none owed after.
  const again = activity();
  again.gang.desire(STATE);
  await again.round();
  again.failing(true);
  again.gang.forget();
  await again.round();
  again.failing(false);
  const off = { ...STATE, warfare: { engage: false, leastTerritoryPerUpdate: 0 } };
  again.gang.desire(off);
  await again.round();
  again.gang.desire({ ...off, warfare: null });
  await again.round();
  expect(again.runs.at(-1)).toEqual({ ...off, warfare: null });
});
