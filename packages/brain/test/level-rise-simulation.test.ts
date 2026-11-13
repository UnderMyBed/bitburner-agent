// The hacking level's rise (#401) against the simulator's: an 8 GB fresh start in BN1, the brain's hack loop and
// batcher as on Steam, its purchases off (programs, home RAM, cloud servers, augmentations), so the RAM the experience
// rate was measured on holds, as the model takes it (core's level-rise.ts; RAM growing is left out there). Seed 1, the
// Agent's start fixed (#341), for a bounded stretch of virtual time:
// - **within the cycle:** at 20 minutes, the experience now and `HackingExpRate` over the 10 minutes before (the
//   brain's measure); the model's level along the next 20 minutes against the medium snapshots';
// - **after an install** (the owner's, through the gate, of Neurotrainer I queued by the harness): the cycle before's
//   rate at the install, × the install's hacking_exp × hacking_speed (`laterCycleRise`), the model's level along the
//   first 15 minutes of the new cycle against the snapshots'.
// The tolerances, stated (seed 1 measured 0.945–0.974 within the cycle; after the install 4.6, 1.8 and 1.4 at 5, 10
// and 15 minutes): within the cycle the model within 10% of the game's level every 5 minutes, and nearer than the
// level held flat; after the install, ahead of the game's (optimistic: the Agent's restart, the hack loop's start and
// the servers rooted again after an install are left out, as the cycle before's rate is its end's), the lead falling,
// under 1.5 times by 15 minutes.
import {
  type LevelRise,
  laterCycleRise,
  levelAlong,
  levellingInstallMultipliers,
  levelRiseOf,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { expect, test } from "vitest";
import { HackingExpRate } from "../src/world-daemon.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const MINUTE = 60_000;
const AUGMENTATION = "Neurotrainer I";

interface Sample {
  atMs: number;
  exp: number;
  level: number;
  levelMult: number;
}

test("seed 1: the model's hacking level against the simulator's, over 20 minutes of a cycle and 15 after an install", {
  timeout: 300_000,
}, async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    seed: 1,
    fixedAgentStart: true,
    augmentations: false,
    beforeAgent: async ({ simulation }) => {
      await simulation.diagnostics.queueAugmentation(AUGMENTATION);
    },
  });
  const { game, data } = fresh;
  const controller = fresh.controller();
  controller.setProgramsEnabled(false);
  controller.setHomeRamEnabled(false);
  controller.setCloudServersEnabled(false);
  const startMs = game.clock.now();
  /** Each medium snapshot's (game time, experience, level, level multiplier) since `sinceMs`, on the brain's clock. */
  const samples = (sinceMs: number): Sample[] =>
    [
      ...data.store.iterateSnapshotsInWindow({ environment: "E1", tier: "medium", sinceMs, untilMs: game.clock.now() }),
    ].map((row) => {
      const player = (row.data as MediumSnapshotData).player as {
        exp: { hacking: number };
        skills: { hacking: number };
        mults: { hacking: number };
      };
      return {
        atMs: row.gameTimeMs,
        exp: player.exp.hacking,
        level: player.skills.hacking,
        levelMult: player.mults.hacking,
      };
    });
  /** The brain's measure at the last sample: `HackingExpRate` fed every sample, over its window. */
  const riseAt = (each: Sample[]): { rise: LevelRise; at: Sample } => {
    const rate = new HackingExpRate();
    for (const sample of each) rate.add(sample.atMs, sample.exp);
    const at = each.at(-1) as Sample;
    expect(rate.windowFull()).toBe(true);
    return {
      rise: levelRiseOf({ exp: at.exp, level: at.level, levelMult: at.levelMult, expPerSecond: rate.perSecond() }),
      at,
    };
  };
  /** The model's level and the game's, at each sample after `fromMs`, every 5 minutes. */
  const compare = (rise: LevelRise, fromMs: number, each: Sample[]) => {
    const rows: { minutes: number; model: number; game: number; flat: number }[] = [];
    let next = fromMs + 5 * MINUTE;
    for (const sample of each) {
      if (sample.atMs < next) continue;
      const model = levelAlong(rise, (sample.atMs - fromMs) / 1000);
      rows.push({ minutes: (sample.atMs - fromMs) / MINUTE, model, game: sample.level, flat: rise.level });
      next += 5 * MINUTE;
    }
    return rows;
  };
  const table = (rows: ReturnType<typeof compare>) =>
    rows
      .map(
        ({ minutes, model, game: level, flat }) =>
          `${minutes.toFixed(1)} min: model ${model.toFixed(0)}, game ${level}, flat ${flat} (model/game ${(model / level).toFixed(3)})`,
      )
      .join("; ");

  // Within the cycle: 20 minutes, the rise measured, then 20 more.
  await game.run(20 * MINUTE);
  const first = riseAt(samples(startMs));
  expect(first.rise.kappa).toBeGreaterThan(0);
  await game.run(20 * MINUTE);
  const within = compare(first.rise, first.at.atMs, samples(startMs));
  console.log(`seed 1, within the cycle (κ ${first.rise.kappa.toFixed(3)}, level ${first.at.level}): ${table(within)}`);

  // The owner's install, through the gate; the rate at it, the cycle before's.
  const before = riseAt(samples(startMs));
  const lastAugResetBefore = fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset as number;
  expect(controller.addManualIntent({ action: "installAugmentations", args: {} })).toMatchObject({ ok: true });
  await game.runUntil(
    () => (fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset ?? lastAugResetBefore) !== lastAugResetBefore,
    5 * MINUTE,
  );
  const resetAt = fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset as number;
  const installedMs = game.clock.now();
  await game.run(15 * MINUTE);
  const after = laterCycleRise(before.rise, levellingInstallMultipliers(0, [AUGMENTATION]));
  const afterSamples = samples(installedMs).filter((sample) => sample.atMs >= resetAt);
  const cycle = compare(after, resetAt, afterSamples);
  console.log(`seed 1, after the install (κ ${after.kappa.toFixed(3)}): ${table(cycle)}`);

  expect(within.length).toBeGreaterThanOrEqual(4);
  for (const { model, game: level, flat } of within) {
    expect(model / level).toBeGreaterThan(0.9);
    expect(model / level).toBeLessThan(1.1);
    expect(Math.abs(model - level)).toBeLessThan(Math.abs(flat - level));
  }
  // The level multiplier after the install: the cycle before's × Neurotrainer I's hacking (none).
  expect(afterSamples[0]?.levelMult).toBeCloseTo(after.levelMult, 6);
  expect(cycle.length).toBeGreaterThanOrEqual(3);
  const leads = cycle.map(({ model, game: level }) => model / level);
  for (const [index, lead] of leads.entries()) {
    expect(lead).toBeGreaterThanOrEqual(1);
    if (index > 0) expect(lead).toBeLessThan(leads[index - 1] as number);
  }
  expect(leads.at(-1)).toBeLessThan(1.5);
});
