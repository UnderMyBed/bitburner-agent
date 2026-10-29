// The batcher run by the Agent from the brain's desired state (#205, M4 phase A slice A7b), in the simulator: an 8 GB
// fresh start in BN1, the brain's rules as on Steam, and the dashboard's batcher switch turned on. The brain sends core's
// plan on the hack loop's target and hosts; the hack loop leaves them (it still roots); the Agent writes the config to
// the batcher's port each round and starts it with `batcher-deploy.js` on the largest host; its health comes back in
// every fast snapshot, into the store. Over a bounded stretch of virtual time it prepares the target and batches, with
// no desync, nothing late or lost; turned off, it stops and the hack loop's loops come back. CI runs seed 1;
// `BATCHER_AGENT_SEEDS` (`1,2,3,4`, say) runs others.
import {
  BATCHER_SCRIPT_NAME,
  type BatcherHealth,
  type FastSnapshotData,
  HACK_LOOP_RAM_BUDGET_GB,
  HACK_LOOP_SCRIPT_NAME,
} from "@bitburner-agent/core";
import type { Simulation } from "@bitburner-agent/sim";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { startBrainInSimulation } from "./helpers/brain-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `BATCHER_AGENT_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function agentSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`BATCHER_AGENT_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = agentSeeds(process.env.BATCHER_AGENT_SEEDS);
/** Time to prepare n00dles from a fresh start's 4% at hacking 1, and start batching. */
const BATCHING_WITHIN_MS = 15 * 60_000;
/** Then batching, for the batches to land. */
const BATCHING_FOR_MS = 20 * 60_000;
/** The no-port servers a fresh start roots: the hack loop's hosts, then the batcher's. */
const HOSTS = ["foodnstuff", "sigma-cosmetics", "joesguns", "nectar-net", "hong-fang-tea", "harakiri-sushi"];

test("BATCHER_AGENT_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(agentSeeds(undefined)).toEqual([1]);
  expect(agentSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) expect(() => agentSeeds(odd)).toThrow(/BATCHER_AGENT_SEEDS/);
});

/** The Agent's log on home. */
async function agentLog(simulation: Simulation): Promise<string[]> {
  const agent = (await simulation.ps("home")).find((process) => process.filename.endsWith("/agent.js"));
  if (agent === undefined) throw new Error("no Agent on home");
  return simulation.logs(agent.pid);
}

test.each(SEEDS)(
  "seed %i: with the switch on, the Agent runs the batcher from an 8 GB fresh start, its health in the store, in step",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, simulation, data } = fresh;
    fresh.controller().setBatcherEnabled(true);
    const health = () => fresh.latest<FastSnapshotData>("fast")?.batcher ?? null;
    await game.runUntil(() => health()?.state === "batching", BATCHING_WITHIN_MS);
    const batchingAtMs = game.clock.now();
    await game.run(BATCHING_FOR_MS);

    // Every fast snapshot's health, from the store, as the run report reads it.
    const window = { environment: "E1" as const, sinceMs: EPOCH_MS, untilMs: game.clock.now(), tier: "fast" };
    const healths: BatcherHealth[] = [];
    for (const row of data.store.iterateSnapshotsInWindow(window)) {
      const each = (row.data as FastSnapshotData).batcher;
      if (each) healths.push(each);
    }
    const last = healths.at(-1) as BatcherHealth;
    const view = fresh.controller().batcherView();
    console.log(
      `seed ${seed}: batching ${((batchingAtMs - EPOCH_MS) / 60_000).toFixed(1)} min in, on ${view.sent?.runOn}, ` +
        `against ${last.target}; ${BATCHING_FOR_MS / 60_000} min on: ${last.batchesStarted} batches, ` +
        `${last.hacksLanded} hack parts landed ($${Math.round(last.moneyHacked)}), ${last.desyncs} desyncs, ` +
        `${last.batchesShort} short, ${last.hacksSkipped} hacks skipped; ${healths.length} fast snapshots with its health`,
    );
    expect(healths.length).toBeGreaterThan(100);
    for (const each of healths) {
      expect(each, `at ${each.atMs}`).toMatchObject({ outOfOrder: 0, late: 0, lost: 0, outOfBounds: 0, desyncs: 0 });
    }
    expect(last).toMatchObject({ state: "batching", problem: null });
    expect(last.hacksLanded).toBeGreaterThan(10);
    expect(view.enabled).toBe(true);
    expect(view.sent?.target).toBe(last.target);
    // The run report's section reads the same health from the store: batching, in step.
    const report = runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() }).text;
    const section = report.slice(report.indexOf("6. The batcher"), report.indexOf("Verdict"));
    console.log(section);
    expect(section).toContain("batching on n00dles");
    expect(section).toContain("  desyncs: none\n  late or lost: none\n  problems: none");
    // Sent and running throughout (#211): no stretch of fast snapshots with it not running.
    expect(section).toContain("  sent but not running (3 fast snapshots in a row or more):\n    none");
    expect(fresh.latest<FastSnapshotData>("fast")?.batcherDeploy).toMatchObject({
      running: view.sent?.runOn,
      problem: null,
    });

    // The hack loop leaves the batcher's hosts: none of its loops runs there; ours runs once, where the brain said.
    const running = new Map<string, string[]>();
    for (const host of [...HOSTS, "home"]) {
      running.set(
        host,
        (await simulation.ps(host)).map((process) => process.filename),
      );
    }
    const everywhere = [...running.values()].flat();
    expect(everywhere.filter((file) => file.endsWith(`/${HACK_LOOP_SCRIPT_NAME}`))).toEqual([]);
    expect(everywhere.filter((file) => file.endsWith(`/${BATCHER_SCRIPT_NAME}`))).toHaveLength(1);
    expect(running.get(view.sent?.runOn as string)?.some((file) => file.endsWith(`/${BATCHER_SCRIPT_NAME}`))).toBe(
      true,
    );

    // Off: ours stops, and the hack loop's loops come back on its hosts.
    fresh.controller().setBatcherEnabled(false);
    await game.run(60_000);
    const after: string[] = [];
    for (const host of [...HOSTS, "home"])
      after.push(...(await simulation.ps(host)).map((process) => process.filename));
    expect(after.filter((file) => file.endsWith(`/${BATCHER_SCRIPT_NAME}`))).toEqual([]);
    // Stopped before the hack loop took its hosts back (#211): the Agent's log says "off" before the loops' line.
    const log = await agentLog(simulation);
    const lastOn = log.findLastIndex((line) => line.startsWith("agent: batcher: on "));
    const off = log.findIndex((line, index) => index > lastOn && line === "agent: batcher: off");
    const loopsBack = log.findIndex(
      (line, index) => index > lastOn && /^agent: hack loop: on, .* on [1-9]\d* servers/.test(line),
    );
    expect(off, log.join(" | ")).toBeGreaterThan(lastOn);
    expect(loopsBack, log.join(" | ")).toBeGreaterThan(off);
    expect(after.filter((file) => file.endsWith(`/${HACK_LOOP_SCRIPT_NAME}`)).length).toBeGreaterThan(0);
    // Its health isn't reported while it's off (#211), though its port still has it.
    expect(fresh.latest<FastSnapshotData>("fast")?.batcher ?? null).toBeNull();
    // Once its operations have landed, every loop grows to its host's full size (#211): none left starved.
    await game.run(5 * 60_000);
    for (const host of HOSTS) {
      const loopThreads = (await simulation.ps(host))
        .filter((process) => process.filename.endsWith(`/${HACK_LOOP_SCRIPT_NAME}`))
        .reduce((total, process) => total + process.threads, 0);
      expect(loopThreads, host).toBe(Math.floor(16 / HACK_LOOP_RAM_BUDGET_GB));
    }
  },
);

test("instructions only from the brain it's connected to (#211): one that sends none leaves the batcher as it is", {
  timeout: 600_000,
}, async () => {
  const fresh = await freshStartOf({ withDesiredState: true });
  const { game, simulation } = fresh;
  fresh.controller().setBatcherEnabled(true);
  const health = () => fresh.latest<FastSnapshotData>("fast")?.batcher ?? null;
  await game.runUntil(() => health()?.state === "batching", BATCHING_WITHIN_MS);
  // The brain gone: safe mode keeps the batcher. Then a brain that sends no desired state at all connects.
  fresh.brain.stop();
  await game.run(10_000);
  const quiet = startBrainInSimulation(game, { build: fresh.build, data: fresh.data, withDesiredState: false });
  await game.runUntil(() => quiet.channelEvents.some((event) => event.type === "agentConnected"), 60_000);
  await game.run(5_000);
  // The batcher dies: with no instructions from this brain, the Agent doesn't start it again.
  let killed = 0;
  for (const host of [...HOSTS, "home"]) {
    for (const process of await simulation.ps(host)) {
      if (process.filename.endsWith(`/${BATCHER_SCRIPT_NAME}`) && (await simulation.kill(process.pid))) killed += 1;
    }
  }
  expect(killed).toBe(1);
  await game.run(60_000);
  const running: string[] = [];
  for (const host of [...HOSTS, "home"])
    running.push(...(await simulation.ps(host)).map((process) => process.filename));
  expect(running.filter((file) => file.endsWith(`/${BATCHER_SCRIPT_NAME}`))).toEqual([]);
});
