// The curve's fit objective (#260, #263), on run #3 alone: shared by test/model.test.ts and the refit's descent.
import { type Calibration, READ_MINUTES, RUN_3_CYCLES, RUN_3_POLICY, runModel } from "../src/index.ts";
import { RUN_3_BN1_2 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
/** The minutes of run #3's 7th to 10th cycles the money's cap is fitted on: before the cloud servers. */
export const CAP_FIT_MINUTES: readonly number[] = [5, 10, 15, 20];

/**
 * The error the fit minimises, the model on run #3's own policy at each reading, the same minute of the same cycle:
 * - `early`: over run #3's cycles 1 to 6, the mean of |ln| of the level's ratio and a third of |log10| of the gross
 *   income's (floored at $1m);
 * - `late`: over its 7th to 10th at `CAP_FIT_MINUTES`, |log10| of the gross income's. From the 7th the model's cycle is
 *   another than run #3's (another set installed), but those minutes are bound by the world servers' RAM alike;
 * - `combined`: the readings of both, the late weighted as the early's money (a third), what the refit minimised.
 * A late reading past the end of the model's cycle reads its money at that end (the cycle ended because the money was
 *   already there, which is the error the cap is about), so the cap's fit can't win by ending those cycles early; a
 *   cycle the model never had (the BitNode destroyed first) has none. `lateReadings` counts them. The early readings
 *   keep part 1's rule, a reading past the end left out: the cap barely moves cycles 1 to 6's ends.
 */
export function fitError(calibration: Partial<Calibration>) {
  const seen = new Map<string, { hacking: number; money: number }>();
  const ends = new Map<number, number>();
  let cycle = 0;
  let last = Number.POSITIVE_INFINITY;
  runModel(RUN_3_BN1_2.start, {
    policy: RUN_3_POLICY,
    calibration,
    onStep: ({ onlineMs, hacking, gross }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      seen.set(`${cycle}:${onlineMs / MINUTE_MS}`, { hacking, money: gross });
      ends.set(cycle, gross);
    },
  });
  const moneyOff = (model: number, actual: number) =>
    Math.abs(Math.log10(Math.max(1e6, model) / Math.max(1e6, actual)));
  let level = 0;
  let money = 0;
  let readings = 0;
  let late = 0;
  let lateReadings = 0;
  for (const [index, { points }] of RUN_3_CYCLES.entries()) {
    for (const [minutes, actualLevel, income] of points) {
      if (!READ_MINUTES.includes(minutes)) continue;
      const step = seen.get(`${index + 1}:${minutes}`);
      if (index < 6) {
        if (step === undefined) continue;
        level += Math.abs(Math.log(step.hacking / actualLevel));
        money += moneyOff(step.money, income);
        readings += 1;
      } else if (CAP_FIT_MINUTES.includes(minutes)) {
        // Past the model's cycle's end, its money at the end; a cycle it never had, none.
        const modelMoney = step?.money ?? ends.get(index + 1);
        if (modelMoney === undefined) continue;
        late += moneyOff(modelMoney, income);
        lateReadings += 1;
      }
    }
  }
  return {
    early: (level + money / 3) / readings,
    late: late / lateReadings,
    lateReadings,
    combined: (level + money / 3 + late / 3) / (readings + lateReadings),
  };
}
