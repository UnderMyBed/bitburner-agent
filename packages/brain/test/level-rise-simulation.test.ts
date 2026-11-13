// The hacking level's rise (#401) against the simulator's: an 8 GB fresh start in BN1, the brain's hack loop and
// batcher as on Steam, its purchases off (programs, home RAM, cloud servers, augmentations), so the RAM the experience
// rate was measured on holds, as the model takes it (core's level-rise.ts). Seed 1, the Agent's start fixed (#341):
// - **the hour (#401):** from 20 minutes, the experience now and `HackingExpRate` over the 10 minutes before (the
//   brain's measure); the model's level along the next hour against the medium snapshots';
// - **two installs** (the owner's, through the gate, of an augmentation the harness queues): after each, the model
//   from the cycle before's rate at its install, × the install's hacking_exp × hacking_speed (`laterCycleRise`), with
//   the ramp's dead time as the brain takes it (#405's review): the second cycle's from the fallback (the first had no
//   rate carried into it to ramp to), the third's from the second's ramp, measured as the brain does (its rate from
//   the first minute reaching the κ carried into it, per level + 50).
// The bars, stated: over the hour, within 10% of the game's level every 10 minutes, and nearer than the level held flat.
// It drifts under the game's as the hour goes on, as two terms core's model leaves out grow with the level: a hack's
// chance (failed hacks earn a quarter of the experience, `NetscriptHelpers.tsx:564-565`; the chance rises with the
// level, `Hacking.ts:12-28`) and the batcher's move to a target worth more experience a thread. After each install,
// the game's level at every mark lies between the model with its dead time and the model without one: the dead time
// bounds the lead the rate carried over the install would otherwise take (the Agent's restart, the hack loop's start).
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
import { LEVEL_RAMP_FALLBACK_MS } from "../src/augmentations.ts";
import { HackingExpRate } from "../src/world-daemon.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const freshStartOf = useFreshStarts();
const MINUTE = 60_000;
const FIRST = "Neurotrainer I";
const SECOND = "Synaptic Enhancement Implant";

interface Sample {
  atMs: number;
  exp: number;
  level: number;
  levelMult: number;
}

test("seed 1: the model's hacking level against the simulator's, over an hour of a cycle and after two installs", {
  timeout: 300_000,
}, async () => {
  const fresh = await freshStartOf({
    withDesiredState: true,
    seed: 1,
    fixedAgentStart: true,
    augmentations: false,
    beforeAgent: async ({ simulation }) => {
      await simulation.diagnostics.queueAugmentation(FIRST);
    },
  });
  const { game, data, simulation } = fresh;
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
  /** The brain's measure at the last sample: `HackingExpRate` fed every sample, over its whole window. */
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
  /** The ramp, as the brain measures it: the first sample whose rate from the cycle's start reaches `kappa`. */
  const rampOf = (each: Sample[], kappa: number, resetAt: number): number | null => {
    const rate = new HackingExpRate();
    for (const sample of each) {
      rate.add(sample.atMs, sample.exp);
      const perSecond = rate.perSecond();
      if (perSecond !== null && perSecond / (sample.level + 50) >= kappa) return sample.atMs - resetAt;
    }
    return null;
  };
  /** Each model's level and the game's, at the first sample past each `everyMs` mark after `fromMs`. */
  const marks = (rises: LevelRise[], fromMs: number, each: Sample[], everyMs: number) => {
    const rows: { minutes: number; models: number[]; game: number }[] = [];
    let next = fromMs + everyMs;
    for (const sample of each) {
      if (sample.atMs < next) continue;
      const seconds = (sample.atMs - fromMs) / 1000;
      rows.push({ minutes: seconds / 60, models: rises.map((rise) => levelAlong(rise, seconds)), game: sample.level });
      next += everyMs;
    }
    return rows;
  };
  const table = (rows: ReturnType<typeof marks>) =>
    rows
      .map(
        ({ minutes, models, game: level }) =>
          `${minutes.toFixed(1)} min: ${models.map((m) => m.toFixed(0)).join(" / ")} vs ${level}`,
      )
      .join("; ");
  /** The owner's install of what's queued, through the gate; the reset's game time. */
  const install = async () => {
    const before = fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset as number;
    expect(controller.addManualIntent({ action: "installAugmentations", args: {} })).toMatchObject({ ok: true });
    await game.runUntil(
      () => (fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset ?? before) !== before,
      5 * MINUTE,
    );
    return {
      resetAt: fresh.latest<SlowSnapshotData>("slow")?.resetInfo.lastAugReset as number,
      atMs: game.clock.now(),
    };
  };

  // The hour: measured at 20 minutes, past the hack loop's start (#405's review: measured at 11, the window holds that
  // ramp, and the model runs 0.66–0.74 of the game's over the hour; the dead time's business, after an install), the
  // model and the level held flat against the game's.
  await game.run(20 * MINUTE);
  const first = riseAt(samples(startMs));
  expect(first.rise.kappa).toBeGreaterThan(0);
  await game.run(60 * MINUTE);
  const hour = marks([first.rise, { ...first.rise, kappa: 0 }], first.at.atMs, samples(startMs), 10 * MINUTE);
  console.log(`seed 1, the hour (model / flat vs game): ${table(hour)}`);
  expect(hour.length).toBeGreaterThanOrEqual(6);
  for (const { models, game: level } of hour) {
    const [model, flat] = models as [number, number];
    expect(model / level).toBeGreaterThan(0.9);
    expect(model / level).toBeLessThan(1.1);
    expect(Math.abs(model - level)).toBeLessThan(Math.abs(flat - level));
  }

  // The first install: no rate was carried into the first cycle, so no ramp measured: the fallback's dead time.
  const carriedFirst = riseAt(samples(startMs)).rise;
  const firstReset = await install();
  await game.run(20 * MINUTE);
  const secondSamples = samples(firstReset.atMs).filter((sample) => sample.atMs >= firstReset.resetAt);
  const second = laterCycleRise(carriedFirst, levellingInstallMultipliers(0, [FIRST]));
  const secondDead = { ...second, delaySeconds: LEVEL_RAMP_FALLBACK_MS / 1000 };
  const afterFirst = marks([secondDead, second], firstReset.resetAt, secondSamples, 5 * MINUTE);
  const ramp = rampOf(secondSamples, second.kappa, firstReset.resetAt);
  console.log(
    `seed 1, after the first install (dead ${LEVEL_RAMP_FALLBACK_MS / MINUTE} min, the fallback / none vs game): ` +
      `${table(afterFirst)}; its ramp to κ ${second.kappa.toFixed(3)}: ` +
      `${ramp === null ? "never" : `${(ramp / MINUTE).toFixed(1)} min`}`,
  );

  // The second install: the second cycle's ramp measured, or the fallback again where it never reached its κ.
  await simulation.diagnostics.queueAugmentation(SECOND);
  const carriedSecond = riseAt(secondSamples).rise;
  const secondReset = await install();
  await game.run(15 * MINUTE);
  const thirdSamples = samples(secondReset.atMs).filter((sample) => sample.atMs >= secondReset.resetAt);
  const third = laterCycleRise(carriedSecond, levellingInstallMultipliers(0, [SECOND]));
  const deadMs = ramp ?? LEVEL_RAMP_FALLBACK_MS;
  const thirdDead = { ...third, delaySeconds: deadMs / 1000 };
  const afterSecond = marks([thirdDead, third], secondReset.resetAt, thirdSamples, 5 * MINUTE);
  console.log(
    `seed 1, after the second install (dead ${(deadMs / MINUTE).toFixed(1)} min, ${ramp === null ? "the fallback" : "measured"} / none vs game): ${table(afterSecond)}`,
  );

  for (const rows of [afterFirst, afterSecond]) {
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const { models, game: level } of rows) {
      const [dead, none] = models as [number, number];
      expect(level).toBeGreaterThanOrEqual(Math.floor(dead));
      expect(level).toBeLessThanOrEqual(Math.ceil(none));
    }
  }
});
