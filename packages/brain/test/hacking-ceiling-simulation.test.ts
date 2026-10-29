// The hacking ceiling (#196) against the hack loop, in the simulator: an 8 GB fresh start in BN1, the brain's rules as
// on Steam (the loop, the programs and home RAM, all on), for a bounded stretch of virtual time. The run report reads
// the store as after a live run: what hacking earned (the slow snapshots' money sources) never passes the ceiling (the
// most the loop's hosts' RAM could earn, from the game's formulas), over the run, each hour, or each 10 minutes. The
// percentage the loop reaches is the baseline the batcher (A7) must beat; each seed prints it. CI runs seed 1;
// `HACKING_CEILING_SEEDS` (`1,2,3,4`, say) runs others (the brain README's ceiling suite says how).
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
  "seed %i: 90 virtual minutes from a fresh start, hacking never earns more than the ceiling, which the report shows",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    await fresh.game.run(RUN_MS);
    const window = { environment: "E1" as const, sinceMs: EPOCH_MS, untilMs: fresh.game.clock.now() };
    const { text, failures } = runReport(fresh.data.store, window);
    const section = text.slice(text.indexOf("5. Hacking"), text.indexOf("Verdict"));
    console.log(`seed ${seed}:\n${section}`);
    expect(failures).toEqual([]);
    expect(section).toMatch(/\n {2}the ceiling now: \$[\d,]+\/s on [\w.-]+, with [\d.]+ GB on \d+ servers\n/);
    expect(section).toMatch(/\n {2}\$[\d,]+\/s against a ceiling of \$[\d,]+\/s: \d+\.\d%, from /);

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
    const { whole, stretches } = fold.totals();
    expect(whole).not.toBeNull();
    if (whole === null) return;
    // Hacking earned, and the ceiling rose above it: the loop's hosts were rooted and counted.
    expect(whole.earned).toBeGreaterThan(0);
    expect(whole.earned).toBeLessThanOrEqual(whole.ceiling);
    for (const stretch of stretches) expect(stretch.earned).toBeLessThanOrEqual(stretch.ceiling);
    const intervals = fold.judgedIntervals();
    let tenMinutes = { earned: 0, ceiling: 0, fromMs: intervals[0]?.fromMs ?? 0 };
    let tightest = 0;
    for (const interval of intervals) {
      tenMinutes = {
        ...tenMinutes,
        earned: tenMinutes.earned + interval.earned,
        ceiling: tenMinutes.ceiling + interval.ceiling,
      };
      if (interval.toMs - tenMinutes.fromMs >= TEN_MINUTES_MS) {
        expect(tenMinutes.earned, `from ${tenMinutes.fromMs}`).toBeLessThanOrEqual(tenMinutes.ceiling);
        tightest = Math.max(tightest, tenMinutes.earned / tenMinutes.ceiling);
        tenMinutes = { earned: 0, ceiling: 0, fromMs: interval.toMs };
      }
    }
    console.log(
      `seed ${seed}: hacking reached ${((whole.earned / whole.ceiling) * 100).toFixed(1)}% of the ceiling over the ` +
        `run; the most in any 10 minutes ${(tightest * 100).toFixed(1)}%`,
    );
  },
);
