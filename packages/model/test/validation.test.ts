// The cycle model's validation (#260, #262's review). Its hacking level and money are inputs measured from run #3
// (`RUN_3_CYCLES`), fitted into one curve (./calibration.ts), so they validate nothing; what's under test is the rules
// of reputation, favour, buying and installing that run on them. Split accordingly:
// - independent: the faction worked, the reputation earned there and its rate, the favour after, Daedalus's count, in
//   run #3's cycles 1 to 6, on its own measured curves and on the fitted one; and the simulator's fresh BN1.1;
// - partly downstream: the cycles' lengths and #244's first two phases (the money sets the installs' timing too);
// - fitted, so consistency only: the curve against run #3's own level and money;
// - out of reach: run #3's cycles 7 to 10 (below).
import { describe, expect, test } from "vitest";
import { type ModelRun, READ_MINUTES, RUN_3_CYCLES, RUN_3_POLICY, runModel, TODAYS_POLICY } from "../src/index.ts";
import { RUN_3_BITRUNNERS_FAVOR_AFTER_4, RUN_3_BN1_2, RUN_3_PER_CYCLE, SIMULATOR_SEED_1 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
/** The cycles in the model's reach: up to BitRunners' donations unlocking, #247's question. */
const IN_REACH = 6;
/**
 * The known miss in reach: in the 3rd cycle the model works CyberSec most (for Cranial Signal Processors Gen I and
 * II), then NiteSec, as its 2nd cycle installs one augmentation fewer than run #3's (Gen I's 10,000 reputation not
 * reached at CyberSec); run #3 worked NiteSec. Each figure's tolerance is stated where it's checked.
 */
const KNOWN_WORK_MISS = { cycle: 3, worked: "CyberSec" };

const off = (model: number, actual: number) => Math.abs(model - actual) / Math.abs(actual);
const mostWorked = (workMinutes: Record<string, number>) =>
  Object.entries(workMinutes).sort((a, b) => b[1] - a[1])[0]?.[0];

/** Each in-reach cycle's figures in `run`, at the faction run #3 worked most. */
function perCycle(run: ModelRun) {
  return RUN_3_PER_CYCLE.slice(0, IN_REACH).map((actual, index) => {
    const cycle = run.cycles[index];
    if (cycle === undefined) throw new Error(`the model never ended its cycle ${index + 1}`);
    const minutes = cycle.workMinutes[actual.faction] ?? 0;
    const reputation = cycle.reputation[actual.faction] ?? 0;
    return {
      actual,
      cycle,
      worked: mostWorked(cycle.workMinutes),
      reputation,
      rate: minutes > 0 ? reputation / (minutes * 60) : 0,
      favorAfter: cycle.favorAfter[actual.faction] ?? 0,
      lengthMin: (cycle.endMs - cycle.startMs) / MINUTE_MS,
    };
  });
}

/** The independent checks on a run of run #3's BN1.2 (on its own measured curves, or the fitted one). */
function mechanismChecks(label: string, run: () => ModelRun) {
  describe(`independent: the rules, cycles 1 to ${IN_REACH} (${label})`, () => {
    test("the faction worked most, as run #3, but for the known miss", () => {
      for (const [index, { actual, worked, cycle }] of perCycle(run()).entries()) {
        if (index + 1 === KNOWN_WORK_MISS.cycle) {
          expect(worked).toBe(KNOWN_WORK_MISS.worked);
          // Run #3's faction is still worked, a third of the cycle's work or more.
          const total = Object.values(cycle.workMinutes).reduce((sum, each) => sum + each, 0);
          expect(cycle.workMinutes[actual.faction] ?? 0).toBeGreaterThanOrEqual(total / 3);
        } else expect(worked, `cycle ${index + 1}`).toBe(actual.faction);
      }
    });

    test("Daedalus's count after each install, within one", () => {
      for (const [index, { actual, cycle }] of perCycle(run()).entries()) {
        expect(Math.abs(cycle.countAfter - actual.count), `cycle ${index + 1}`).toBeLessThanOrEqual(1);
      }
    });

    test("the favour after each install at run #3's faction, within 20% or 2 points", () => {
      for (const [index, { actual, favorAfter }] of perCycle(run()).entries()) {
        // Cycles 1 to 6 all report a favour (only the 10th has none).
        const actualFavor = actual.favorAfter ?? Number.NaN;
        const tolerance = Math.max(0.2 * actualFavor, 2);
        expect(Math.abs(favorAfter - actualFavor), `cycle ${index + 1}`).toBeLessThanOrEqual(tolerance);
      }
    });

    test("the reputation earned there within 30%, and its rate a second within 20%", () => {
      for (const [index, { actual, reputation, rate }] of perCycle(run()).entries()) {
        expect(off(reputation, actual.reputation), `cycle ${index + 1}'s reputation`).toBeLessThanOrEqual(0.3);
        expect(off(rate, actual.rate), `cycle ${index + 1}'s rate`).toBeLessThanOrEqual(0.2);
      }
    });

    test("BitRunners' favour about 5 at the 4th install, as run #3's (not grinding it early)", () => {
      expect(run().cycles[3]?.favorAfter.BitRunners ?? 0).toBeLessThan(2 * RUN_3_BITRUNNERS_FAVOR_AFTER_4);
    });

    test("partly downstream: each cycle's length within 35%, and #244's first two phases within 15%", () => {
      for (const [index, { actual, lengthMin }] of perCycle(run()).entries()) {
        expect(off(lengthMin, actual.lengthMin), `cycle ${index + 1}`).toBeLessThanOrEqual(0.35);
      }
      let start = 0;
      for (const { endsAtInstall, minutes } of RUN_3_BN1_2.phases) {
        const end = run().cycles[endsAtInstall - 1]?.endMs ?? 0;
        expect(off((end - start) / MINUTE_MS, minutes)).toBeLessThanOrEqual(0.15);
        start = end;
      }
    });
  });
}

const measured = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
const fitted = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY });
mechanismChecks("run #3's own curves", () => measured);
mechanismChecks("the fitted curve", () => fitted);

describe("out of reach: run #3's cycles 7 to 10", () => {
  test("the known divergence: the 6th install comes before BitRunners' favour reaches 150", () => {
    // Run #3's reached 150.38 at its 6th install, 0.38 over the threshold; the model's 6th install is 10 minutes
    // earlier on run #3's own curves (19 on the fitted one), at 143, so its donations unlock an install later and the
    // later cycles diverge (count 34 after the 7th against 29). Kept as a test so a change to it is seen.
    for (const run of [measured, fitted]) {
      const favor = run.cycles[5]?.favorAfter.BitRunners ?? 0;
      expect(favor).toBeGreaterThan(140);
      expect(favor).toBeLessThan(150);
    }
  });
});

describe("fitted, so consistency only", () => {
  test("the fitted curve's hacking level within 15% of run #3's at each cycle's end, cycles 1 to 6", () => {
    for (const [index, actual] of RUN_3_PER_CYCLE.slice(0, IN_REACH).entries()) {
      expect(off(fitted.cycles[index]?.hackingAtEnd ?? 0, actual.hacking), `cycle ${index + 1}`).toBeLessThan(0.15);
    }
  });

  test("on run #3's own curves, the model reads them back", () => {
    for (const [index, { points }] of RUN_3_CYCLES.slice(0, IN_REACH).entries()) {
      const read = points.filter(([minutes]) => READ_MINUTES.includes(minutes));
      const last = read[read.length - 1];
      const lengthMin = ((measured.cycles[index]?.endMs ?? 0) - (measured.cycles[index]?.startMs ?? 0)) / MINUTE_MS;
      if (last !== undefined && lengthMin >= last[0]) {
        expect(measured.cycles[index]?.hackingAtEnd).toBeGreaterThanOrEqual(last[1]);
      }
    }
  });

  test("in well under a second a run (3 s, for a slow runner)", () => {
    const started = performance.now();
    runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("independent: the simulator's first cycles (a fresh BN1.1 on BN1.2's curve)", () => {
  const run = runModel(SIMULATOR_SEED_1.start, {
    policy: TODAYS_POLICY,
    horizonMs: SIMULATOR_SEED_1.horizonMinutes * MINUTE_MS,
  });

  test("installs at about 57 and 122 min within 15%, 3 and then 4 installed, none more by 200 min", () => {
    expect(run.cycles).toHaveLength(SIMULATOR_SEED_1.installs.length);
    for (const [index, { atMinutes, installed }] of SIMULATOR_SEED_1.installs.entries()) {
      expect(off((run.cycles[index]?.endMs ?? 0) / MINUTE_MS, atMinutes)).toBeLessThanOrEqual(0.15);
      expect(run.cycles[index]?.countAfter).toBe(installed);
    }
  });

  test("the hacking level at each install within 15%", () => {
    for (const [index, level] of SIMULATOR_SEED_1.hackingAtCycleEnd.entries()) {
      expect(off(run.cycles[index]?.hackingAtEnd ?? 0, level)).toBeLessThanOrEqual(0.15);
    }
  });
});
