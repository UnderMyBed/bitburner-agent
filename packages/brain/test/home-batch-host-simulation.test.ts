// Home as one of the batcher's hosts (#340), an A/B in the simulator (owner decision 67, point 6): the first hour after
// an install, with home large and no cloud servers yet, as BN4.1's cycles started (home 80 to 100% of the rooted RAM).
// A harness edit stands in for the cycles before, through the harness's own hooks: home of `HOME_GB` before the Agent.
// The rest is an install's: hacking from level 1, a fresh start's $1,000, no programs. The brain's rules as on Steam,
// the programs bought with the money; cloud servers, home RAM and augmentations switched off. Left out: cloud servers
// bought within the hour (optimistic for home's gain: they'd add RAM to both arms), and installed augmentations'
// multipliers (cautious: a slower level reaches the richer targets, whose batches want the RAM, later). Each seed runs
// twice: with home among the batcher's hosts, beyond what it keeps (`homeKeptGbOf`), and without
// (`BATCHER_ON_HOME_SETTING` off: main's before #340). Each prints what each arm earned, and when the arm with home had
// earned the hour's money of the arm without. CI runs seed 1; `HOME_BATCH_SEEDS` (`1,2,3`, say) runs others, and
// `HOME_BATCH_MINUTES` another length.
import type { FastSnapshotData, MediumSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BATCHER_ON_HOME_SETTING } from "../src/batcher.ts";
import { runReport } from "../src/run-report.ts";
import { homeKeptGbOf } from "../src/share.ts";
import { writeSwitch } from "../src/switches.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `HOME_BATCH_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function seedsOf(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`HOME_BATCH_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = seedsOf(process.env.HOME_BATCH_SEEDS);
const MINUTE = 60_000;
/** The window after the install each arm runs: the first hour. */
const RUN_MS = Number(process.env.HOME_BATCH_MINUTES ?? 60) * MINUTE;
/** Home's RAM, GB: 4 TB, against the game's servers' few hundred GB once the programs root them. */
const HOME_GB = 4096;

test("HOME_BATCH_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(seedsOf(undefined)).toEqual([1]);
  expect(seedsOf("1, 4")).toEqual([1, 4]);
  for (const odd of ["", "1,", "0", "2.5", "x"]) expect(() => seedsOf(odd)).toThrow(/HOME_BATCH_SEEDS/);
});

/** One arm: the first `RUN_MS` after the install, with home among the batcher's hosts or not. */
async function run(seed: number, onHome: boolean) {
  const fresh = await freshStartOf({
    withDesiredState: true,
    seed,
    augmentations: false,
    beforeAgent: async ({ simulation }) => simulation.diagnostics.setHomeRam(HOME_GB),
  });
  const { game, data } = fresh;
  if (!onHome) writeSwitch(data.store, BATCHER_ON_HOME_SETTING, false);
  const controller = fresh.controller();
  controller.setCloudServersEnabled(false);
  controller.setHomeRamEnabled(false);
  // Money's rises added up, a medium snapshot at a time (#187's `earnedSince`): the programs' spending isn't earnings.
  const samples: { atMs: number; earned: number }[] = [];
  let lastMoney: number | null = null;
  let earned = 0;
  const startMs = game.clock.now();
  // Home's RAM in the batches while batching, from the batcher's health: what it held there, of what home may give.
  let batchingLooks = 0;
  let homeBatchesGb = 0;
  let homeBatchableGb = 0;
  fresh.brain.channel.subscribe((event) => {
    if (event.type !== "snapshotReceived") return;
    if (event.snapshot.tier === "medium") {
      const money = (event.snapshot.data as MediumSnapshotData).player?.money;
      if (typeof money !== "number") return;
      if (lastMoney !== null) earned += Math.max(0, money - lastMoney);
      lastMoney = money;
      samples.push({ atMs: event.atMs - startMs, earned });
    } else if (event.snapshot.tier === "fast") {
      const health = (event.snapshot.data as FastSnapshotData).batcher;
      if (health?.state !== "batching") return;
      batchingLooks += 1;
      homeBatchesGb += health.home?.batchesGb ?? 0;
      homeBatchableGb += health.home == null ? 0 : health.home.gb - health.home.keptGb;
    }
  });
  await game.run(RUN_MS);
  const health = fresh.latest<FastSnapshotData>("fast")?.batcher ?? null;
  const report = runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() });
  return {
    earned,
    samples,
    level: (fresh.medium()?.player as { skills?: { hacking?: number } } | undefined)?.skills?.hacking ?? 0,
    target: health?.target ?? null,
    hosts: controller.batcherView().sent?.hosts ?? 0,
    homeBatchesGb: batchingLooks === 0 ? 0 : homeBatchesGb / batchingLooks,
    homeBatchableGb: batchingLooks === 0 ? 0 : homeBatchableGb / batchingLooks,
    health,
    report,
  };
}

const money = (amount: number) => `$${(amount / 1e6).toFixed(1)}m`;

test.each(SEEDS)(
  "seed %i: the first hour after an install, home large: home as a batch host earns more, and home's RAM is in the batches",
  { timeout: 600_000 },
  async (seed) => {
    const without = await run(seed, false);
    const withHome = await run(seed, true);
    // When the arm with home had earned the hour's money of the arm without.
    const reachedAtMs = withHome.samples.find((sample) => sample.earned >= without.earned)?.atMs ?? null;
    console.log(
      `seed ${seed}, the first ${RUN_MS / MINUTE} min after an install, home ${HOME_GB} GB, no cloud servers: ` +
        `without home ${money(without.earned)} (hacking ${without.level}, on ${without.target}, ${without.hosts} hosts); ` +
        `with home ${money(withHome.earned)} (hacking ${withHome.level}, on ${withHome.target}, ${withHome.hosts} ` +
        `hosts), x${(withHome.earned / without.earned).toFixed(2)}; the arm without's money reached at ` +
        `${reachedAtMs === null ? "never" : `${(reachedAtMs / MINUTE).toFixed(1)} min`}; home's RAM in the batches ` +
        `${Math.round(withHome.homeBatchesGb)} GB on average, of ${Math.round(withHome.homeBatchableGb)} GB it may give`,
    );
    const homeLine = withHome.report.text.split("\n").find((line) => line.includes("home among its hosts (#340)"));
    console.log(homeLine);
    // Home among the hosts only with it on, beyond what it keeps for the Agent (no Singularity: 32 GB).
    expect(without.health?.home ?? null).toBeNull();
    expect(withHome.health?.home).toMatchObject({ gb: HOME_GB, keptGb: homeKeptGbOf(null) });
    expect(withHome.hosts).toBe(without.hosts + 1);
    // Its RAM in the batches, and several times the money for it: x8.71 to x12.53 on seeds 1 to 4 (seed 1 x10.40), the
    // hour's money of the arm without reached in 24.3 to 31.5 minutes; home 86 to 88% in the batches while batching.
    expect(withHome.homeBatchesGb).toBeGreaterThan(0.5 * withHome.homeBatchableGb);
    expect(withHome.earned).toBeGreaterThan(4 * without.earned);
    expect(reachedAtMs).toBeLessThan(45 * MINUTE);
    // Neither arm late, lost or short; the report's home line, and none of its home failures.
    for (const arm of [without, withHome]) {
      expect(arm.health).toMatchObject({ late: 0, lost: 0, batchesShort: 0 });
      expect(arm.report.failures.filter((failure) => /^batches left home idle/.test(failure))).toEqual([]);
    }
    expect(homeLine).toBeDefined();
  },
);
