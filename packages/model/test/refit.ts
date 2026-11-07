// The refit (#294), on run #3 alone: `node packages/model/test/refit.ts [key=value ...]` (the start). The reference
// cycles' multipliers first, from the downstream run (the brain's rules on run #3's measured curves, which don't
// depend on the fitted constants); then a coordinate descent of `fitError` at `calibrationSteps`, a step at a time, the
// first that lowers it taken; then each step's error around the end, so the flat directions show. Prints the trace; the
// README's calibration section quotes it. Not a test: test/model.test.ts checks its end is a local best.
import {
  CALIBRATION,
  type Calibration,
  type CycleMultipliers,
  calibrationSteps,
  RUN_3_CYCLES,
  RUN_3_POLICY,
  runModel,
} from "../src/index.ts";
import { fitError } from "./fit.ts";
import { RUN_3_BN1_2 } from "./fixtures.ts";

const KEYS = ["hacking", "hacking_exp", "hacking_speed", "hacking_money"] as const;
const round4 = (value: number) => Math.round(value * 1e4) / 1e4;

/** The multipliers the brain's rules install for each reference cycle on run #3's measured curves. */
export function downstreamReferenceCycles(): Calibration["referenceCycles"] {
  const downstream = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
  return CALIBRATION.referenceCycles.map(({ cycle }) => {
    const multipliers = downstream.cycles[cycle - 1]?.multipliers;
    if (multipliers === undefined) throw new Error(`the downstream run has no cycle ${cycle}`);
    return {
      cycle,
      multipliers: Object.fromEntries(
        KEYS.map((key) => [key, round4(multipliers[key])]),
      ) as unknown as CycleMultipliers,
    };
  });
}

/** The descent from `start`: each step taken, and the end. */
export function descend(start: Partial<Calibration>): { trace: string[]; end: Partial<Calibration>; error: number } {
  let calibration: Partial<Calibration> = { ...start, referenceCycles: downstreamReferenceCycles() };
  let error = fitError(calibration).combined;
  const trace = [`start ${error.toFixed(4)}`];
  for (let moved = true; moved; ) {
    moved = false;
    for (const { name, calibration: step } of calibrationSteps({ ...CALIBRATION, ...calibration })) {
      const stepped = fitError({ ...calibration, ...step }).combined;
      if (stepped < error - 1e-9) {
        calibration = { ...calibration, ...step };
        error = stepped;
        trace.push(`${name} ${error.toFixed(4)}`);
        moved = true;
        break;
      }
    }
  }
  return { trace, end: calibration, error };
}

if (import.meta.main) {
  const start = Object.fromEntries(
    process.argv.slice(2).map((each) => [each.split("=")[0], Number(each.split("=")[1])]),
  ) as Partial<Calibration>;
  const { trace, end, error } = descend(start);
  const { referenceCycles, ...constants } = end;
  console.log(trace.join("\n"));
  console.log(`end ${JSON.stringify(constants)} ${error.toFixed(4)}`, fitError(end));
  console.log(`referenceCycles ${JSON.stringify(referenceCycles)}`);
  for (const { name, calibration } of calibrationSteps({ ...CALIBRATION, ...end })) {
    const stepped = fitError({ ...end, ...calibration }).combined;
    console.log(
      `  ${name}: ${stepped.toFixed(4)} (${stepped === error ? "flat" : `+${(stepped - error).toFixed(4)}`})`,
    );
  }
}
