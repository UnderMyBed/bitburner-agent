// Sharing spare RAM for faction reputation (#224), the brain against the real engine in the simulator: a save as the
// first overnight run found it, RAM far beyond what the batcher's plan can use. Before the Agent starts, the owner's
// setup buys 25 cloud servers of 1 PB (the brain's names), spends the rest, and the player, at a hacking level of about
// 900, joins CyberSec; then the owner sets CyberSec's hacking work on the dashboard. The brain runs the batcher on the
// cloud servers, which batches its target at its plan's peak and shares the rest while the work goes on. Over a
// stretch sharing and one with the switch off, in the same game at the same level, CyberSec's reputation rises by the
// bonus the batcher reports, and no batch is late, lost or short. CI runs seed 1; `SHARE_SEEDS` (`1,2,3`, say) runs
// others.
import {
  type BatcherHealth,
  type FastSnapshotData,
  factionStateOf,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { ownerRunsOnHome, useFreshStarts } from "./helpers/fresh-start.ts";

/** `SHARE_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function shareSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`SHARE_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = shareSeeds(process.env.SHARE_SEEDS);
/** Until the batcher batches and shares: rooting, its target prepared at once on this RAM. */
const SHARING_WITHIN_MS = 10 * 60_000;
/** Each stretch judged, sharing and not: several slow snapshots (every 60 s) each. */
const STRETCH_MS = 4 * 60_000;
/** The owner's setup: 25 cloud servers of 1 PB under the brain's names, bought with money spent again after. */
const OWNERS_SETUP = `export async function main(ns) {
  for (let index = 0; index < 25; index++) ns.cloud.purchaseServer("pserv-" + index, 2 ** 20);
}`;

test("SHARE_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(shareSeeds(undefined)).toEqual([1]);
  expect(shareSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two"]) expect(() => shareSeeds(odd)).toThrow(/SHARE_SEEDS/);
});

test.each(SEEDS)(
  "seed %i: sharing raises CyberSec's reputation by the bonus the batcher reports, with no batch late, lost or short",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({
      withDesiredState: true,
      seed,
      beforeAgent: async (game) => {
        await game.simulation.diagnostics.setMoney(2e12);
        await ownerRunsOnHome(game, OWNERS_SETUP);
        await game.simulation.diagnostics.setMoney(0);
        await game.simulation.diagnostics.gainHackingExp(1e15);
        await game.simulation.diagnostics.joinFactionWithReputation("CyberSec", 0);
      },
    });
    const { game, data } = fresh;
    // The same game throughout: no purchases (the batches' money would buy programs, servers and augmentations, and
    // move the target or reset the game), so both stretches see the same hosts and target at the same level.
    const controller = fresh.controller();
    controller.setProgramsEnabled(false);
    controller.setHomeRamEnabled(false);
    controller.setCloudServersEnabled(false);
    controller.setAugmentationsEnabled(false);
    expect(controller.setWork({ faction: "CyberSec", workType: "hacking" })).toEqual({ ok: true });
    const health = () => fresh.latest<FastSnapshotData>("fast")?.batcher ?? null;
    await game.runUntil(
      () => health()?.state === "batching" && (health()?.sharing?.threads ?? 0) > 0,
      SHARING_WITHIN_MS,
    );
    const reputation = () => {
      const slow = data.store.latestSnapshot({ environment: "E1", tier: "slow" });
      const cyberSec = factionStateOf(slow?.data as SlowSnapshotData)?.joined.find((each) => each.name === "CyberSec");
      return { atMs: slow?.receivedAtMs ?? 0, reputation: cyberSec?.reputation ?? Number.NaN };
    };
    /** CyberSec's reputation a second over `ms`, from slow snapshot to slow snapshot. */
    const rateOver = async (ms: number) => {
      // From the next slow snapshot, so the stretch starts on a reading.
      const before = reputation();
      await game.runUntil(() => reputation().atMs > before.atMs, 90_000);
      const from = reputation();
      await game.run(ms);
      const to = reputation();
      return { perSecond: ((to.reputation - from.reputation) * 1000) / (to.atMs - from.atMs), from, to };
    };
    const sharing = await rateOver(STRETCH_MS);
    // Off: the threads end within 10 s, then the same work, unshared.
    fresh.controller().setShareEnabled(false);
    await game.run(15_000);
    expect(health()?.sharing ?? null).toBeNull();
    const unshared = await rateOver(STRETCH_MS);

    // The batcher's health over the stretch shared: the bonus it reported, on average.
    const healths: { atMs: number; health: BatcherHealth }[] = [];
    for (const row of data.store.iterateSnapshotsInWindow({
      environment: "E1",
      sinceMs: EPOCH_MS,
      untilMs: game.clock.now(),
      tier: "fast",
    })) {
      const each = (row.data as FastSnapshotData).batcher;
      if (each) healths.push({ atMs: row.receivedAtMs, health: each });
    }
    const during = healths.filter(({ atMs }) => atMs > sharing.from.atMs && atMs <= sharing.to.atMs);
    const bonus = during.reduce((sum, { health }) => sum + (health.sharing?.bonus ?? 1), 0) / during.length;
    const threads = during.reduce((sum, { health }) => sum + (health.sharing?.threads ?? 0), 0) / during.length;
    const ratio = sharing.perSecond / unshared.perSecond;
    console.log(
      `seed ${seed}: sharing ${Math.round(threads).toLocaleString("en-US")} threads on average, the bonus ` +
        `x${bonus.toFixed(3)}; CyberSec ${sharing.perSecond.toFixed(3)}/s sharing, ${unshared.perSecond.toFixed(3)}/s ` +
        `not: x${ratio.toFixed(3)}; ${healths.at(-1)?.health.batchesStarted} batches on ${healths.at(-1)?.health.target}`,
    );
    expect(during.length).toBeGreaterThan(50);
    // Sharing all the way, at a bonus worth having: millions of threads on the 25 PB the batches leave.
    expect(during.every(({ health }) => (health.sharing?.threads ?? 0) > 0)).toBe(true);
    expect(bonus).toBeGreaterThan(1.4);
    // Never more than 80% of the hosts' RAM: the threads it counts are the ones running, a round never counted twice.
    const most = Math.max(...healths.map(({ health }) => health.sharing?.ramGb ?? 0));
    expect(most).toBeLessThanOrEqual(0.8 * 25 * 2 ** 20);
    // Hacking work's rate x the bonus (reputation.ts:16-24), at the same skills: within 2%.
    expect(ratio).toBeGreaterThan(bonus * 0.98);
    expect(ratio).toBeLessThan(bonus * 1.02);
    // In step throughout: nothing late, lost or short, no desync.
    for (const { atMs, health } of healths) {
      expect(health, `at ${atMs}`).toMatchObject({ late: 0, lost: 0, desyncs: 0, batchesShort: 0, outOfBounds: 0 });
    }

    // The run report: the share's lines, and neither of its failures.
    const report = runReport(data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: game.clock.now() });
    const section = report.text.slice(
      report.text.indexOf("  sharing spare RAM (#224):"),
      report.text.indexOf("Verdict"),
    );
    console.log(section);
    expect(section).toMatch(/^ {4}shared for \d+ min: threads at most [\d,]+/m);
    expect(section).toContain("    while sharing: 0 late, 0 lost, 0 short;");
    expect(section).toContain("    idle (asked, the room free, no threads, for 10 minutes): never");
    expect(report.failures.filter((failure) => /^share /.test(failure))).toEqual([]);
  },
);
