// The hack loop's income across a change of target (#184), in the simulator: an 8 GB fresh start in BN1, the brain's
// rules as on Steam (the loop, the programs and home RAM, all on), run past the starter rule's move from n00dles to
// zer0 at about hacking 150. On Steam, `7990834`'s loop moved every host to zer0 at 4% of its money: weakening and
// growing it took all of them, and money stayed flat for 24 minutes until the owner stopped it. Here, on `7990834`, it
// moved at 45 to 48 virtual minutes on each of seeds 1 to 8, and money then stayed flat for the 45 minutes the test
// ran on. Now the brain prepares the next target on part of the hosts while the rest earn, and moves over once it's
// ready: by then the rule may have moved on from zer0 (to max-hardware, at about hacking 160, in seed 1), so the test
// asks only that the loop leaves n00dles for a better target, without a stall.
//
// The no-rise check over several seeds: `HACK_LOOP_INCOME_SEEDS=1,2,3` (CI runs seed 1). Each seed prints its longest
// stretch without a rise. Seeds 2 to 4 fail it after the move, for the loop's own reason: every host sees max-hardware
// at 75% at once and hacks it together, to almost nothing, and it takes over 20 minutes to grow back. #187 fixes that,
// with `HACK_LOOP_INCOME_SEEDS=1,2,3,4,5,6,7,8` as its failing test (the brain README's income suite says how to run it).
import type { MediumSnapshotData } from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const SEEDS = (process.env.HACK_LOOP_INCOME_SEEDS ?? "1").split(",").map(Number);
/** The starter rule's first target, which earns until a better one is ready. */
const FIRST_TARGET = "n00dles";
/** Virtual time for the move from n00dles: zer0 is the rule's from about 48 minutes, ready some time after. */
const MOVE_WITHIN_MS = 3 * 60 * 60_000;
/** Then this long on, so a move that stalls shows. */
const AFTER_MOVE_MS = 45 * 60_000;

/** The longest time between one rise of `money` and the next, after its first rise, and when it began. */
function longestWithoutRise(samples: { atMs: number; money: number }[]): { lengthMs: number; fromMs: number } {
  let longest = { lengthMs: 0, fromMs: 0 };
  let lastRiseAtMs: number | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index] as { atMs: number; money: number };
    const risen = sample.money > (samples[index - 1] as { money: number }).money;
    if (lastRiseAtMs !== null && sample.atMs - lastRiseAtMs > longest.lengthMs) {
      longest = { lengthMs: sample.atMs - lastRiseAtMs, fromMs: lastRiseAtMs };
    }
    if (risen) lastRiseAtMs = sample.atMs;
  }
  return longest;
}

test.each(SEEDS)(
  "seed %i: past the move from n00dles, money never goes 10 virtual minutes without rising",
  { timeout: 600_000 },
  async (seed) => {
    const fresh = await freshStartOf({ withDesiredState: true, seed });
    const { game, brain } = fresh;
    const samples: { atMs: number; money: number }[] = [];
    brain.channel.subscribe((event) => {
      if (event.type !== "snapshotReceived" || event.snapshot.tier !== "medium") return;
      const money = (event.snapshot.data as MediumSnapshotData).player?.money;
      if (typeof money !== "number") return;
      samples.push({ atMs: event.atMs, money });
    });
    const target = () => fresh.controller().hackLoopView().target;
    await game.runUntil(() => target() !== null && target() !== FIRST_TARGET, MOVE_WITHIN_MS);
    const movedTo = target();
    const movedAtMs = samples.at(-1)?.atMs ?? 0;
    await game.run(AFTER_MOVE_MS);

    const longest = longestWithoutRise(samples);
    const startMs = samples[0]?.atMs ?? 0;
    const minutes = (ms: number) => (ms / 60_000).toFixed(1);
    console.log(
      `seed ${seed}: on ${movedTo} at ${minutes(movedAtMs - startMs)} min; longest without a rise ` +
        `${minutes(longest.lengthMs)} min, from ${minutes(longest.fromMs - startMs)} min; ` +
        `money $${Math.round(samples.at(-1)?.money ?? 0)} at ${minutes((samples.at(-1)?.atMs ?? 0) - startMs)} min`,
    );
    expect(longest.lengthMs).toBeLessThanOrEqual(INCOME_STALLED_AFTER_MS);
    // The brain's alert never held, so never logged.
    expect(brain.logLines.filter((line) => line.startsWith("income stalled"))).toEqual([]);
    // The move happened, and stays.
    expect(target()).not.toBe(FIRST_TARGET);
  },
);
