// The hacking ceilings (#196) against the hack loop, in the simulator: an 8 GB fresh start in BN1, the brain's rules
// as on Steam (the loop, the programs and home RAM, all on; the batcher off, #206), for a bounded stretch of virtual
// time. The run report reads the store as after a live run: what hacking earned (the slow snapshots' money sources)
// never passes the hacking ceiling (the most any hacker could earn with the loop's hosts' RAM, from the game's
// formulas), over the run, each hour, or each 10 minutes. The percentages the loop reaches, of the batcher ceiling over
// the run and in its best 10 minutes, are the baseline the batcher (A7) must beat; each seed prints them. CI runs seed
// 1; `HACKING_CEILING_SEEDS` (`1,2,3,4`, say) runs others (the brain README's ceiling suite says how).
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { HackingFold } from "../src/hacking-ceiling.ts";
import { runReport } from "../src/run-report.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `HACKING_CEILING_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function ceilingSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`HACKING_CEILING_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = ceilingSeeds(process.env.HACKING_CEILING_SEEDS);
/** Past the loop's move from n00dles (about 48 minutes on), and on a target that grows slowly. */
const RUN_MS = 90 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;

test("HACKING_CEILING_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(ceilingSeeds(undefined)).toEqual([1]);
  expect(ceilingSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) {
    expect(() => ceilingSeeds(odd)).toThrow(/HACKING_CEILING_SEEDS/);
  }
});

test.each(SEEDS)(
  "seed %i: 90 virtual minutes from a fresh start, hacking never earns more than the ceilings allow, which the report shows",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed, batcher: false });
    await fresh.game.run(RUN_MS);
    const window = { environment: "E1" as const, sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() };
    const { text, failures } = runReport(fresh.data.store, window);
    const section = text.slice(text.indexOf("5. Hacking"), text.indexOf("Verdict"));
    console.log(`seed ${seed}:\n${section}`);
    expect(failures).toEqual([]);
    expect(section).toMatch(
      /\n {2}the ceilings now: \$[\d,]+\/s for a batcher on [\w.-]+ \(\$[\d,]+\/s for any hacker\)/,
    );
    expect(section).toMatch(/\n {2}the best 10 minutes: \d+\.\d% of the batcher ceiling \(/);
    expect(section).toMatch(/\n {2}over the window: \$[\d,]+\/s: \d+\.\d% of the batcher ceiling \(\$[\d,]+\/s\), /);

    // The same fold, read directly: the whole run, each hour and each 10 minutes.
    const fold = new HackingFold(new Set(["home"]));
    const read = <Data>(tier: string, add: (atMs: number, data: Data) => void) => {
      for (const row of fresh.data.store.iterateSnapshotsInWindow({ ...window, tier })) {
        add(row.receivedAtMs, row.data as Data);
      }
    };
    read("static", (atMs, data) => fold.addStatic(atMs, data as never));
    read<SlowSnapshotData>("slow", (atMs, data) => fold.addSlow(atMs, data));
    read("medium", (atMs, data) => fold.addMedium(atMs, data as never));
    const { whole, stretches, best } = fold.totals();
    expect(whole).not.toBeNull();
    expect(best).not.toBeNull();
    if (whole === null || best === null) return;
    // Hacking earned, never more than any hacker could with the loop's hosts' RAM, nor than the bound on all of it.
    expect(whole.earned).toBeGreaterThan(0);
    for (const stretch of [whole, ...stretches]) {
      expect(stretch.earned).toBeLessThanOrEqual(stretch.ceiling);
      expect(stretch.ceiling).toBeLessThanOrEqual(stretch.bound);
      expect(stretch.batcher).toBeLessThanOrEqual(stretch.ceiling);
    }
    let tenMinutes = { earned: 0, ceiling: 0, fromMs: fold.judgedIntervals()[0]?.fromMs ?? 0 };
    for (const interval of fold.judgedIntervals()) {
      tenMinutes = {
        ...tenMinutes,
        earned: tenMinutes.earned + interval.earned,
        ceiling: tenMinutes.ceiling + interval.ceiling,
      };
      if (interval.toMs - tenMinutes.fromMs >= TEN_MINUTES_MS) {
        expect(tenMinutes.earned, `from ${tenMinutes.fromMs}`).toBeLessThanOrEqual(tenMinutes.ceiling);
        tenMinutes = { earned: 0, ceiling: 0, fromMs: interval.toMs };
      }
    }
    const percent = (part: number, of: number) => `${((part / of) * 100).toFixed(1)}%`;
    console.log(
      `seed ${seed}: over the run ${percent(whole.earned, whole.batcher)} of the batcher ceiling, ` +
        `${percent(whole.earned, whole.ceiling)} of the ceiling; the best 10 minutes ` +
        `${percent(best.earned, best.batcher)} of the batcher ceiling (${percent(best.earned, best.ceiling)} of the ` +
        `ceiling), from ${((best.fromMs - window.sinceMs) / 60_000).toFixed(0)} min`,
    );
  },
);
