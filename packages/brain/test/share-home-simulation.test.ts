// Sharing with the batches filling the cloud servers (#242), the brain against the real engine in the simulator: run
// #3's 12:22, scaled down. Before the Agent starts, the owner's setup buys 25 cloud servers of 64 TB (the brain's
// names), home is 64 TB (the same 1:25 as run #3's 1 PB beside 26.2 PB), the player, at a hacking level of about 900,
// joins CyberSec; then the owner sets CyberSec's hacking work on the dashboard. The brain's plan fills the cloud
// servers with batches, over 80% of their RAM. Before #242 the share's 80% cap counted home's RAM and use with theirs,
// so the room was 0 and home sat idle: the bonus x1.000 against x1.388 possible. Now home shares, in two halves, and
// the bonus averages within 1% of the bonus possible on the RAM free, never x1.000, with no batch late, lost or short.
// That's home beside the batcher's hosts, run with `BATCHER_ON_HOME_SETTING` off (#340). The default's arm, since
// #340's review: while sharing is asked, home is a batch host only if the batches gain more with it than the share
// would on it (`homeBatchesWhileSharing`, a placeholder until the planner splits home's RAM), and here home's 4% more
// batch RAM loses to x1.388, so home shares beside the hosts, as #242's, with no failure of the share's or of
// home's. CI runs seed 1; `SHARE_HOME_SEEDS` (`1,2,3`, say) runs others.
import type { BatcherHealth, FastSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { BATCHER_ON_HOME_SETTING } from "../src/batcher.ts";
import { runReport } from "../src/run-report.ts";
import { writeSwitch } from "../src/switches.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts } from "./helpers/fresh-start.ts";

/** `SHARE_HOME_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function seedsOf(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`SHARE_HOME_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = seedsOf(process.env.SHARE_HOME_SEEDS);
/** Each cloud server's RAM and home's, GB: 64 TB, as 1 PB is to 26.2 PB in run #3. */
const CLOUD_SERVER_GB = 2 ** 16;
const HOME_GB = 2 ** 16;
/** The stretch judged: several rounds' halves, a fast snapshot every 2 s. */
const STRETCH_MS = 4 * 60_000;
const OWNERS_SETUP = `export async function main(ns) {
  for (let index = 0; index < 25; index++) ns.cloud.purchaseServer("pserv-" + index, ${CLOUD_SERVER_GB});
}`;
/** Logs the cloud servers' RAM and use, GB. */
const CLOUD_USE = `export async function main(ns) {
  let maxGb = 0, usedGb = 0;
  for (let index = 0; index < 25; index++) {
    maxGb += ns.getServerMaxRam("pserv-" + index);
    usedGb += ns.getServerUsedRam("pserv-" + index);
  }
  ns.print(JSON.stringify({ maxGb, usedGb }));
}`;

test("SHARE_HOME_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(seedsOf(undefined)).toEqual([1]);
  expect(seedsOf("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two"]) expect(() => seedsOf(odd)).toThrow(/SHARE_HOME_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: batches over 80% of the cloud servers, home shares beside them, the bonus within 1% of the possible",
  { timeout: 600_000 },
  async (seed) => {
    const { healths, cloudUse, report } = await run(seed, false);
    const average = (of: (each: BatcherHealth) => number) =>
      healths.reduce((sum, { health: each }) => sum + of(each), 0) / healths.length;
    const bonus = average((each) => each.sharing?.bonus ?? 1);
    const possible = average((each) => each.sharing?.possibleBonus ?? 1);
    const homeShareGb = average((each) => (each.sharing?.ramGb ?? 0) - (each.sharing?.hostsRamGb ?? 0));
    console.log(
      `seed ${seed}, home beside: the cloud servers ${cloudUse.map((each) => `${(each * 100).toFixed(0)}%`).join(", ")} ` +
        `used; home sharing ${Math.round(homeShareGb).toLocaleString("en-US")} GB on average; the bonus ` +
        `x${bonus.toFixed(3)} on average, of x${possible.toFixed(3)} possible; ${healths.at(-1)?.health.batchesStarted} ` +
        `batches on ${healths.at(-1)?.health.target}`,
    );
    expect(healths.length).toBeGreaterThan(100);
    // Run #3's shape: the batches over 80% of the cloud servers throughout, where the old cap left no room at all.
    for (const used of cloudUse) expect(used).toBeGreaterThan(0.82);
    for (const { atMs, health: each } of healths) {
      // Never x1.000 while asked: home shares, in two halves, one always running.
      expect(each.sharing?.threads ?? 0, `at ${atMs}`).toBeGreaterThan(0);
      // Home's RAM shared, all but what it keeps and a thread's fragment, but as a half ends.
      expect(each.sharing?.homeGb, `at ${atMs}`).toBe(HOME_GB);
      expect(each, `at ${atMs}`).toMatchObject({ late: 0, lost: 0, desyncs: 0, batchesShort: 0, outOfBounds: 0 });
    }
    expect(homeShareGb).toBeGreaterThan(0.95 * (HOME_GB - 64));
    // About home's 16,373 threads: 1 + ln(16,374)/25 is x1.388.
    expect(possible).toBeGreaterThan(1.38);
    expect(bonus).toBeGreaterThan(0.99 * possible);
    expect(bonus).toBeLessThanOrEqual(possible + 1e-9);

    // The run report: the bonus against the possible, home never idle, and none of the share's failures.
    const section = report.text.slice(
      report.text.indexOf("  sharing spare RAM (#224):"),
      report.text.indexOf("Verdict"),
    );
    console.log(section);
    expect(section).toMatch(/^ {4}the bonus while asked \(#242\): x1\.3\d\d on average, of x1\.3\d\d possible/m);
    expect(section).toContain(
      "    home idle while asked (over half of what it may share free, for 5 minutes, #242): never",
    );
    expect(report.failures.filter((failure) => /^share /.test(failure))).toEqual([]);
  },
);

test.each(SEEDS)(
  "seed %i, the default (#340's review, a placeholder): home's 4% more batch RAM against x1.388, so home shares",
  { timeout: 600_000 },
  async (seed) => {
    const { healths, cloudUse, report, logLines } = await run(seed, true);
    const average = (of: (each: BatcherHealth) => number) =>
      healths.reduce((sum, { health: each }) => sum + of(each), 0) / healths.length;
    const bonus = average((each) => each.sharing?.bonus ?? 1);
    const possible = average((each) => each.sharing?.possibleBonus ?? 1);
    const homeShareGb = average((each) => (each.sharing?.ramGb ?? 0) - (each.sharing?.hostsRamGb ?? 0));
    console.log(
      `seed ${seed}, the default: the cloud servers ` +
        `${cloudUse.map((each) => `${(each * 100).toFixed(0)}%`).join(", ")} used; home sharing ` +
        `${Math.round(homeShareGb).toLocaleString("en-US")} GB on average; the bonus x${bonus.toFixed(3)} on average, ` +
        `of x${possible.toFixed(3)} possible; ${healths.at(-1)?.health.batchesStarted} batches on ` +
        `${healths.at(-1)?.health.target}`,
    );
    // While faction work asks for the share, the batches gain at most 4% from home (65,504 GB beside 1.6 PB), the
    // share x1.388 on it: home stays beside the hosts (`homeBatchesWhileSharing`), and says so in the brain's log.
    expect(logLines).toContain(
      "batcher: batches harakiri-sushi, sharing its spare RAM, home sharing rather than batching (#340's placeholder)",
    );
    expect(healths.length).toBeGreaterThan(100);
    for (const used of cloudUse) expect(used).toBeGreaterThan(0.82);
    for (const { atMs, health: each } of healths) {
      expect(each.home, `at ${atMs}`).toBeUndefined();
      expect(each.sharing?.homeGb, `at ${atMs}`).toBe(HOME_GB);
      expect(each, `at ${atMs}`).toMatchObject({ late: 0, lost: 0, desyncs: 0, batchesShort: 0, outOfBounds: 0 });
    }
    expect(homeShareGb).toBeGreaterThan(0.95 * (HOME_GB - 64));
    expect(possible).toBeGreaterThan(1.38);
    expect(bonus).toBeGreaterThan(0.99 * possible);
    expect(report.failures.filter((failure) => /^share |^batches left home idle/.test(failure))).toEqual([]);
  },
);

/** One run of run #3's shape: home among the batcher's hosts (the default since #340) or beside them (#242's). */
async function run(seed: number, homeAmongHosts: boolean) {
  const fresh = await freshStartOf({
    withDesiredState: true,
    seed,
    beforeAgent: async (game) => {
      await game.simulation.diagnostics.setMoney(1e15);
      await ownerRunsOnHome(game, OWNERS_SETUP);
      await game.simulation.diagnostics.setHomeRam(HOME_GB);
      await game.simulation.diagnostics.setMoney(0);
      await game.simulation.diagnostics.gainHackingExp(1e15);
      await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
    },
  });
  const { game, data, simulation } = fresh;
  if (!homeAmongHosts) writeSwitch(data.store, BATCHER_ON_HOME_SETTING, false);
  await simulation.writeFile("home", "cloud-use.js", CLOUD_USE);
  // The same game throughout: no purchases, so the hosts and the target stay as they are.
  const controller = fresh.controller();
  controller.setProgramsEnabled(false);
  controller.setHomeRamEnabled(false);
  controller.setCloudServersEnabled(false);
  controller.setAugmentationsEnabled(false);
  expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
  const health = () => fresh.latest<FastSnapshotData>("fast")?.batcher ?? null;
  await game.runUntil(() => health()?.state === "batching", 10 * 60_000);
  // Into the batches' rhythm, and the share's halves'.
  await game.run(60_000);
  const fromMs = game.clock.now();
  const cloudUse: number[] = [];
  for (let elapsed = 0; elapsed < STRETCH_MS; elapsed += 30_000) {
    const { pid } = await simulation.run("home", "cloud-use.js");
    await game.run(30_000);
    const line = (await simulation.logs(pid)).find((each) => each.startsWith("{"));
    const { maxGb, usedGb } = JSON.parse(line ?? "{}") as { maxGb: number; usedGb: number };
    cloudUse.push(usedGb / maxGb);
  }
  const toMs = game.clock.now();

  const healths: { atMs: number; health: BatcherHealth }[] = [];
  for (const row of data.store.iterateSnapshotsInWindow({
    environment: "E1",
    sinceMs: fromMs,
    untilMs: toMs,
    tier: "fast",
  })) {
    const each = (row.data as FastSnapshotData).batcher;
    if (each) healths.push({ atMs: row.receivedAtMs, health: each });
  }
  return {
    healths,
    cloudUse,
    report: runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: toMs }),
    logLines: fresh.brain.logLines,
  };
}
