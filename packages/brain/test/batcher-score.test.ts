// The batcher's score (#206, M4 phase A slice A7c), in the simulator: an 8 GB fresh start in BN1, the brain's rules
// as on Steam (the batcher's switch on, its default since #206; the programs, home RAM and cloud servers on), for a
// bounded stretch of virtual time, then the same seed with the batcher switched off, the hack loop alone. Each is
// scored as the run report scores a live run: the best 10 minutes of what hacking earned against A1's batcher ceiling
// (the best rooted target's, on the hack loop's hosts' RAM, at the hacking level then). The batcher must beat the
// hack loop on every seed, with nothing out of step (no desync, nothing late or lost). CI runs seed 1;
// `BATCHER_SCORE_SEEDS` (`1,2,3,4`, say) runs others (the brain README's score suite has the 8 seeds' table).
import { expect, test } from "vitest";
import { HackingFold } from "../src/hacking-ceiling.ts";
import { runReport } from "../src/run-report.ts";
import type { TelemetryStore } from "../src/telemetry-store.ts";
import { EPOCH_MS } from "./helpers/agent-in-simulation.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `BATCHER_SCORE_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function scoreSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`BATCHER_SCORE_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = scoreSeeds(process.env.BATCHER_SCORE_SEEDS);
/**
 * Long enough for the best 10 minutes of both: the hack loop's come in its first minutes (#196), the batcher's from
 * about 3 to 9 minutes in (8 seeds at #206), before cloud servers multiply the RAM the ceiling counts.
 */
const RUN_MS = 30 * 60_000;
/**
 * The least the batcher's best 10 minutes may score, of A1's measure: seeds 1 to 8 gave 27.5–30.7% at #206; this is
 * 3 points under the worst, so an engine bump can move it a little without failing, and it's still well above the
 * hack loop's best 10 minutes on any seed (18.3–19.9%, #196).
 */
const LEAST_SCORE = 0.245;

test("BATCHER_SCORE_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(scoreSeeds(undefined)).toEqual([1]);
  expect(scoreSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"]) expect(() => scoreSeeds(odd)).toThrow(/BATCHER_SCORE_SEEDS/);
});

/** The best 10 minutes, as the run report's fold has them: the share of the batcher ceiling, and from when. */
function bestTenMinutes(store: TelemetryStore, untilMs: number): { score: number; fromMinute: number } {
  const window = { environment: "E1" as const, sinceMs: EPOCH_MS, untilMs };
  const fold = new HackingFold(new Set(["home"]));
  const read = (tier: string, add: (atMs: number, data: never) => void) => {
    for (const row of store.iterateSnapshotsInWindow({ ...window, tier })) add(row.receivedAtMs, row.data as never);
  };
  read("static", (atMs, data) => fold.addStatic(atMs, data));
  read("slow", (atMs, data) => fold.addSlow(atMs, data));
  read("medium", (atMs, data) => fold.addMedium(atMs, data));
  const { best } = fold.totals();
  if (best === null) throw new Error("no best 10 minutes in the run");
  return { score: best.earned / best.batcher, fromMinute: (best.fromMs - EPOCH_MS) / 60_000 };
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

test.each(SEEDS)(
  "seed %i: the batcher's best 10 minutes, on A1's measure, beat the hack loop's on the same seed, in step",
  { timeout: 600_000 },
  async (seed) => {
    // The batcher, as on Steam.
    const batched = await freshStartOf({ withDesiredState: true, seed });
    expect(batched.controller().batcherView().enabled).toBe(true);
    await batched.game.run(RUN_MS);
    const batchedUntil = batched.game.clock.now();
    const batcher = bestTenMinutes(batched.data.store, batchedUntil);
    const report = runReport(batched.data.store, { environment: "E1", sinceMs: EPOCH_MS, untilMs: batchedUntil });
    const section = report.text.slice(report.text.indexOf("5. Hacking"), report.text.indexOf("Verdict"));
    const by = /\n {4}by: (.*)/.exec(section)?.[1] ?? "";
    // The hack loop alone, on the same seed.
    const looped = await freshStartOf({ withDesiredState: true, seed, batcher: false });
    await looped.game.run(RUN_MS);
    const loop = bestTenMinutes(looped.data.store, looped.game.clock.now());
    console.log(
      `seed ${seed}: the batcher's best 10 minutes ${percent(batcher.score)} of the batcher ceiling, from ` +
        `${batcher.fromMinute.toFixed(1)} min (by ${by}); the hack loop's ${percent(loop.score)}, from ` +
        `${loop.fromMinute.toFixed(1)} min; ${(batcher.score / loop.score).toFixed(2)} times`,
    );
    // In step throughout: the report fails nothing, section 6 included.
    expect(report.failures).toEqual([]);
    expect(section).toContain("  desyncs: none\n  late or lost: none");
    expect(by).toMatch(/^the batcher, /);
    expect(batcher.score).toBeGreaterThanOrEqual(LEAST_SCORE);
    expect(batcher.score).toBeGreaterThan(loop.score);
  },
);
