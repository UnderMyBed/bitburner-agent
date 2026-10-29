// The hack loop's income across a change of target (#184) and after it (#187), in the simulator: an 8 GB fresh start in
// BN1, the brain's rules as on Steam (the loop, the programs, home RAM and cloud servers, #194, all on), run past the
// starter rule's first move away from n00dles, which comes within reach at about hacking 150, and 45 virtual minutes
// on.
// - #184: on Steam, `7990834`'s loop moved every host to zer0 at 4% of its money: weakening and growing it took all of
//   them, and money stayed flat for 24 minutes until the owner stopped it. Here, on `7990834`, it moved at 45 to 48
//   virtual minutes on each of seeds 1 to 8, and money then stayed flat for the 45 minutes the test ran on. Now the
//   brain prepares the next target on part of the hosts while the rest earn, and moves over once it's ready: by then
//   the rule may have moved on from zer0 (to max-hardware, at about hacking 160), so the test asks only that the loop
//   leaves n00dles for a better target.
// - #187: on `3d6e5a6`, seeds 2 to 4 then went 28, 13 and 24 minutes without a rise: every host saw max-hardware at
//   75% at once and hacked it together, to almost nothing, and it took over 20 minutes to grow back. Now each host
//   hacks with the brain's count of threads.
// No stretch without a rise lasts more than 10 minutes, around the move (from the start of the prepare to 10 minutes
// after it) or over the whole run, from money's first rise. CI runs seed 1; `HACK_LOOP_INCOME_SEEDS`
// (`1,2,3,4,5,6,7,8`, say) runs others (the brain README's income suite says how). Each seed prints its longest
// stretches, its money at the end, and what it earned after the move.
import type { MediumSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

/** `HACK_LOOP_INCOME_SEEDS`: seeds 1 or more, comma separated; unset, seed 1 alone (CI). Anything else fails loudly. */
function incomeSeeds(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (!seeds.every((each) => /^[1-9]\d*$/.test(each))) {
    throw new Error(`HACK_LOOP_INCOME_SEEDS is ${JSON.stringify(text)}: give seeds 1 or more, comma separated`);
  }
  return seeds.map(Number);
}

const freshStartOf = useFreshStarts();
const SEEDS = incomeSeeds(process.env.HACK_LOOP_INCOME_SEEDS);
/** The starter rule's first target, which earns until a better one is ready. */
const FIRST_TARGET = "n00dles";
/** Virtual time for the move from n00dles: zer0 is the rule's from about 48 minutes, ready some time after. */
const MOVE_WITHIN_MS = 3 * 60 * 60_000;
/** After the move, the window around it: the moved hosts' first weaken and grow, and their first hacks. */
const MOVE_WINDOW_AFTER_MS = 10 * 60_000;
/** The run's time after the move: drains came 14 to 21 minutes after it on `3d6e5a6`, and lasted up to 28. */
const AFTER_MOVE_MS = 45 * 60_000;

test("HACK_LOOP_INCOME_SEEDS: seeds 1 or more, or unset for seed 1; an empty or odd entry fails loudly", () => {
  expect(incomeSeeds(undefined)).toEqual([1]);
  expect(incomeSeeds("1,2, 3")).toEqual([1, 2, 3]);
  for (const odd of ["", "1,", "0", "1.5", "two", "-1"])
    expect(() => incomeSeeds(odd)).toThrow(/HACK_LOOP_INCOME_SEEDS/);
});

/**
 * The longest time between one rise of money and the next (or the last sample), after its first rise, among those that
 * overlap `window`, and when it began.
 */
function longestWithoutRise(
  samples: { atMs: number; money: number }[],
  window = { fromMs: Number.NEGATIVE_INFINITY, toMs: Number.POSITIVE_INFINITY },
): { lengthMs: number; fromMs: number } {
  let longest = { lengthMs: 0, fromMs: 0 };
  let lastRiseAtMs: number | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index] as { atMs: number; money: number };
    const risen = sample.money > (samples[index - 1] as { money: number }).money;
    const overlaps = lastRiseAtMs !== null && sample.atMs >= window.fromMs && lastRiseAtMs <= window.toMs;
    if (lastRiseAtMs !== null && overlaps && sample.atMs - lastRiseAtMs > longest.lengthMs) {
      longest = { lengthMs: sample.atMs - lastRiseAtMs, fromMs: lastRiseAtMs };
    }
    if (risen) lastRiseAtMs = sample.atMs;
  }
  return longest;
}

test.each(SEEDS)(
  "seed %i: past the move from n00dles and 45 minutes on, money never goes more than 10 virtual minutes without rising",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain } = fresh;
    const samples: { atMs: number; money: number }[] = [];
    let prepareFromMs: number | null = null;
    brain.channel.subscribe((event) => {
      if (event.type !== "snapshotReceived" || event.snapshot.tier !== "medium") return;
      const money = (event.snapshot.data as MediumSnapshotData).player?.money;
      if (typeof money !== "number") return;
      samples.push({ atMs: event.atMs, money });
      if (prepareFromMs === null && fresh.controller().hackLoopView().preparing !== null) prepareFromMs = event.atMs;
    });
    const target = () => fresh.controller().hackLoopView().target;
    await game.runUntil(() => target() !== null && target() !== FIRST_TARGET, MOVE_WITHIN_MS);
    const movedTo = target();
    const movedAtMs = samples.at(-1)?.atMs ?? 0;
    await game.run(AFTER_MOVE_MS);

    const window = { fromMs: prepareFromMs ?? movedAtMs, toMs: movedAtMs + MOVE_WINDOW_AFTER_MS };
    const aroundTheMove = longestWithoutRise(samples, window);
    const whole = longestWithoutRise(samples);
    const startMs = samples[0]?.atMs ?? 0;
    const minutes = (ms: number) => (ms / 60_000).toFixed(1);
    console.log(
      `seed ${seed}: preparing from ${minutes(window.fromMs - startMs)} min, on ${movedTo} at ` +
        `${minutes(movedAtMs - startMs)} min; longest without a rise around the move ` +
        `${minutes(aroundTheMove.lengthMs)} min, in the run ${minutes(whole.lengthMs)} min, from ` +
        `${minutes(whole.fromMs - startMs)} min; money $${Math.round(samples.at(-1)?.money ?? 0)} at ` +
        `${minutes((samples.at(-1)?.atMs ?? 0) - startMs)} min, earned since the move ` +
        `$${Math.round(earnedSince(samples, movedAtMs))}`,
    );
    expect(aroundTheMove.lengthMs).toBeLessThanOrEqual(INCOME_STALLED_AFTER_MS);
    expect(whole.lengthMs).toBeLessThanOrEqual(INCOME_STALLED_AFTER_MS);
    // The brain's alert never held, so never logged.
    expect(brain.logLines.filter((line) => line.startsWith("income stalled"))).toEqual([]);
    // The move happened, and stays.
    expect(target()).not.toBe(FIRST_TARGET);
  },
);

/**
 * Money's rises after `fromMs`, added up: what came in, less what was spent in the same 10 s (#187). Money at the end
 * depends on when the last purchase came; this doesn't, much.
 */
function earnedSince(samples: { atMs: number; money: number }[], fromMs: number): number {
  let earned = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index] as { atMs: number; money: number };
    const rise = sample.money - (samples[index - 1] as { money: number }).money;
    if (sample.atMs > fromMs && rise > 0) earned += rise;
  }
  return earned;
}
