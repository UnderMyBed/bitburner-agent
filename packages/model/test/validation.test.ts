// The cycle model's validation on run #3, the run it's fitted on (#260, #263), each check labelled for what it
// can show:
// - independent: the simulator's fresh BN1.1 (nothing of it was fitted), first;
// - downstream: run #3's cycles 1 to 6, the rules on its measured level and income a cycle. They share inputs with what
//   they check (the rate is the level times the share; the count and the favour turn on the money and the cycle's
//   length; the measured curves restart at run #3's truth each cycle), so they check the rules' mechanism;
// - fitted, so consistency only: the curve against run #3's own level, the share against run #3's own.
// BitRunners' donations unlock at the 7th install, not the 6th; phases 3 to 5 of #244's table are out by far more than
// 15%; the simulator's first install is 21% early. Those are tested as known misses, so a change to any is seen. The
// held-out validation, on BN1.3, is test/bn1-3.test.ts (#263's part 2). Each tolerance is in the test's name.
import { describe, expect, test } from "vitest";
import { type ModelRun, RUN_3_CYCLES, RUN_3_POLICY, RUN_3_SHARE_BONUS, runModel } from "../src/index.ts";
import { RUN_3_BN1_2, RUN_3_CASH, RUN_3_PER_CYCLE, SIMULATOR_SEED_1 } from "./fixtures.ts";

const MINUTE_MS = 60_000;
/** The cycles checked against run #3: through the 6th, BitRunners' grind. */
const CHECKED = 6;

const off = (model: number, actual: number) => Math.abs(model - actual) / Math.abs(actual);
const mostWorked = (workMinutes: Record<string, number>) =>
  Object.entries(workMinutes).sort((a, b) => b[1] - a[1])[0]?.[0];

describe("independent: the simulator's first cycles (a fresh BN1.1, on the curve fitted to BN1.2)", () => {
  const run = runModel(SIMULATOR_SEED_1.start, {
    policy: SIMULATOR_SEED_1.policy,
    horizonMs: SIMULATOR_SEED_1.horizonMinutes * MINUTE_MS,
  });

  test("3 and then 4 installed, none more by 200 min; the 2nd install at about 122 min [15%]", () => {
    expect(run.cycles).toHaveLength(SIMULATOR_SEED_1.installs.length);
    for (const [index, { installed }] of SIMULATOR_SEED_1.installs.entries()) {
      expect(run.cycles[index]?.countAfter).toBe(installed);
    }
    expect(off((run.cycles[1]?.endMs ?? 0) / MINUTE_MS, 122)).toBeLessThanOrEqual(0.15);
  });

  test("known miss: the 1st install at about 57 min comes 21% early [15%], the hacking ramp at 8 GB too fast", () => {
    // 45 min. firstCycleSpeed is fitted on BN1.2, whose home starts at 32 GB, as BN1.3's does: BN1.1's 8 GB is out of
    // every run's range. The simulator's figures are the one independent check, so they aren't fitted on.
    const early = 1 - (run.cycles[0]?.endMs ?? 0) / MINUTE_MS / 57;
    expect(early).toBeGreaterThan(0.15);
    expect(early).toBeLessThan(0.25);
  });

  test("the hacking level at each install [15%]", () => {
    for (const [index, level] of SIMULATOR_SEED_1.hackingAtCycleEnd.entries()) {
      expect(off(run.cycles[index]?.hackingAtEnd ?? 0, level)).toBeLessThanOrEqual(0.15);
    }
  });
});

/** Each checked cycle's figures in `run`, at the faction run #3 worked most. */
function perCycle(run: ModelRun) {
  return RUN_3_PER_CYCLE.slice(0, CHECKED).map((actual, index) => {
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

const measured = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY, measured: RUN_3_CYCLES });
const fitted = runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY });
/** The cycles whose state has drifted from run #3's (below): their figures are reported, not checked. */
const DRIFTED = [2, 3];

describe("downstream: the rules on run #3's own measured curves, cycles 1 to 6", () => {
  test("the faction worked most, as run #3, but for the 3rd cycle (CyberSec, then NiteSec)", () => {
    for (const [index, { actual, worked }] of perCycle(measured).entries()) {
      expect(worked, `cycle ${index + 1}`).toBe(index + 1 === 3 ? "CyberSec" : actual.faction);
    }
  });

  test("Daedalus's count after the 1st, 2nd, 5th and 6th installs [one]; the 3rd and 4th known short", () => {
    for (const [index, { actual, cycle }] of perCycle(measured).entries()) {
      const short = actual.count - cycle.countAfter;
      if (index + 1 === 3 || index + 1 === 4) expect(short, `cycle ${index + 1}`).toBeGreaterThan(1);
      else expect(Math.abs(short), `cycle ${index + 1}`).toBeLessThanOrEqual(1);
    }
  });

  test("the favour after each install [20% or 2], but for the drifted cycles", () => {
    for (const [index, { actual, favorAfter }] of perCycle(measured).entries()) {
      if (DRIFTED.includes(index + 1)) continue;
      const actualFavor = actual.favorAfter ?? Number.NaN;
      expect(Math.abs(favorAfter - actualFavor), `cycle ${index + 1}`).toBeLessThanOrEqual(
        Math.max(0.2 * actualFavor, 2),
      );
    }
  });

  test("the reputation [25%] and its rate [16%] in the 1st and 4th cycles", () => {
    for (const index of [0, 3]) {
      const { actual, reputation, rate } = perCycle(measured)[index] as ReturnType<typeof perCycle>[number];
      expect(off(reputation, actual.reputation), `cycle ${index + 1}'s reputation`).toBeLessThanOrEqual(0.25);
      expect(off(rate, actual.rate), `cycle ${index + 1}'s rate`).toBeLessThanOrEqual(0.16);
    }
  });

  test("known: the 2nd and 3rd cycles drift low (Cranial Signal Processors Gen I missed at the 2nd install)", () => {
    // The 1st install's money is money-bound in the cycle's steepest minutes (×5 in its last 2.5): with the cash, the
    // model buys 10 NeuroFlux Governor levels at 37 min where run #3 bought 13 by 39.5; the 2nd cycle's bar is then
    // reached sooner (46 min, against 56.6) with CyberSec at 7,774 of Gen I's 10,000; the 3rd works CyberSec for it.
    const [, second, third] = perCycle(measured);
    expect(measured.cycles[0]?.neuroFluxLevels).toBeLessThan(13);
    expect(second?.reputation).toBeLessThan(10_000);
    expect(third?.reputation).toBeLessThan((third?.actual.reputation ?? 0) * 0.75);
  });

  test("known: the reputation low in the 5th and 6th cycles (−26%, −20%; the rate −17%), the 6th's favour short", () => {
    // The 5th works NiteSec for Gen III first (run #3, it seems, had it: its 4th installed 7 to the model's 5), and
    // both share at 1.43 against run #3's 1.49 and 1.55 (the share from the RAM saturates with the cloud servers).
    for (const [index, low, high] of [
      [4, 0.2, 0.3],
      [5, 0.15, 0.25],
    ] as const) {
      const { actual, reputation, rate } = perCycle(measured)[index] as ReturnType<typeof perCycle>[number];
      const short = 1 - reputation / actual.reputation;
      expect(short, `cycle ${index + 1}`).toBeGreaterThan(low);
      expect(short, `cycle ${index + 1}`).toBeLessThan(high);
      expect(1 - rate / actual.rate, `cycle ${index + 1}'s rate`).toBeGreaterThan(0.1);
    }
  });

  test("each cycle's length [25%]", () => {
    for (const [index, { actual, lengthMin }] of perCycle(measured).entries()) {
      expect(off(lengthMin, actual.lengthMin), `cycle ${index + 1}`).toBeLessThanOrEqual(0.25);
    }
  });

  /** The money A6 sees at each minute of run #3's measured cycles, cycles 1 to 6, as `money` has it. */
  const moneyAt = (money: "cash" | "gross") => {
    const seen = new Map<string, number>();
    let cycle = 0;
    let last = -1;
    runModel(RUN_3_BN1_2.start, {
      policy: RUN_3_POLICY,
      measured: RUN_3_CYCLES,
      money,
      horizonMs: measured.cycles[5]?.endMs,
      onStep: ({ onlineMs, money: seenMoney }) => {
        if (onlineMs < last) cycle += 1;
        last = onlineMs;
        seen.set(`${cycle}:${onlineMs / MINUTE_MS}`, seenMoney);
      },
    });
    return (index: number, minutes: number) => seen.get(`${index}:${minutes}`) ?? Number.NaN;
  };
  const cashAt = moneyAt("cash");
  const grossAt = moneyAt("gross");
  /** Run #3's cash in hand at `minutes` into its cycle `index + 1` (#263's comment). */
  const actualCash = (index: number, minutes: number) =>
    RUN_3_CASH[index]?.find(([at]) => at === minutes)?.[1] ?? Number.NaN;

  test("the money in hand once the cloud servers are bought, cycles 5 and 6, 30 to 60 min [10%]", () => {
    // The purchases through the cycle, by the brain's rules, against run #3's cash in hand. Here the gross is within
    // 7% of the cash too ($1.44t of cloud servers against hundreds of trillions): this check alone can't tell them
    // apart.
    for (const index of [4, 5]) {
      for (const minutes of [30, 45, 60]) {
        expect(
          off(cashAt(index, minutes), actualCash(index, minutes)),
          `cycle ${index + 1}, ${minutes} min`,
        ).toBeLessThan(0.1);
      }
    }
  });

  test("where the spending is most of the income, cycles 1 to 3 at 30 min: the gross out by ×2.6 to ×10", () => {
    // Run #3 at 30 min: $196m in hand of $1.95b earned (cycle 1), $45.7b of $244b (2), $888b of $2.33t (3).
    for (const [index, low] of [
      [0, 9],
      [1, 5],
      [2, 2.5],
    ] as const) {
      expect(grossAt(index, 30) / actualCash(index, 30), `cycle ${index + 1}`).toBeGreaterThan(low);
    }
  });

  test("known miss: cycles 1 and 2 at 30 min, the model's cash under 2% of run #3's; the 3rd's within 10%", () => {
    // The model buys each server the money covers within the step; the brain buys one an intent, a medium snapshot
    // (10 s) apart, so its money waits between them (BN1.3's purchase times will say how long).
    for (const index of [0, 1]) {
      expect(cashAt(index, 30) / actualCash(index, 30), `cycle ${index + 1}`).toBeLessThan(0.02);
    }
    expect(off(cashAt(2, 30), actualCash(2, 30)), "cycle 3").toBeLessThan(0.1);
  });
});

describe("#263's gate on run #3's BN1.2: not met", () => {
  const unlockedAt = (run: ModelRun) => {
    const unlock = run.events.find((event) => event.kind === "donationsUnlocked" && event.faction === "BitRunners");
    return run.cycles.findIndex((cycle) => cycle.endMs === unlock?.atMs) + 1;
  };

  test("known miss: BitRunners' donations unlock at the 7th install, not run #3's 6th (8 h 35 min)", () => {
    // Run #3's 6th install came with BitRunners' favour at 150.38, 0.38 over: a knife's edge. The model's is 139 on run
    // #3's measured curves and 143 on the fitted one (the reputation low in the 5th and 6th cycles, above).
    for (const run of [measured, fitted]) {
      expect(unlockedAt(run)).toBe(7);
      const favor = run.cycles[5]?.favorAfter.BitRunners ?? 0;
      expect(favor).toBeGreaterThan(135);
      expect(favor).toBeLessThan(150);
    }
  });

  test("#244's first two phases [15%]: count 0 → 17 (4 installs), BitRunners' favour 5 → 150 (2 more)", () => {
    for (const run of [measured, fitted]) {
      let start = 0;
      for (const { endsAtInstall, minutes } of RUN_3_BN1_2.phases.slice(0, 2)) {
        const end = run.cycles[endsAtInstall - 1]?.endMs ?? 0;
        expect(off((end - start) / MINUTE_MS, minutes)).toBeLessThanOrEqual(0.15);
        start = end;
      }
    }
  });

  test("known miss: phases 3 to 5 out by more than 15%, from the 7th cycle on", () => {
    // Measured: run #3's 7th-10th curves run past their ends (31.6, 27.5, 81.7, 18.5 min), as the model's cycles are
    // others; fitted: the money curve at the 7th cycle's multipliers is $1e13+ by 15 min, against run #3's $1e10.
    for (const run of [measured, fitted]) {
      const ends = [8, 9].map((install) => run.cycles[install - 1]?.endMs ?? Number.NaN);
      const phase3 = ((ends[0] as number) - (run.cycles[5]?.endMs ?? 0)) / MINUTE_MS;
      expect(off(phase3, RUN_3_BN1_2.phases[2]?.minutes ?? 0)).toBeGreaterThan(0.15);
      expect(run.outOfRange.length + (run.destroyedAtMs === null ? 1 : 0)).toBeGreaterThan(0);
    }
  });
});

describe("fitted, so consistency only", () => {
  test("the fitted curve's hacking level at each cycle's end, cycles 1 to 6 [15%]", () => {
    for (const [index, actual] of RUN_3_PER_CYCLE.slice(0, CHECKED).entries()) {
      expect(off(fitted.cycles[index]?.hackingAtEnd ?? 0, actual.hacking), `cycle ${index + 1}`).toBeLessThan(0.15);
    }
  });

  test("the share from the state against run #3's own a cycle [10%], but for the 4th (run #3's 1.16)", () => {
    // Run #3's 4th cycle shared at 1.16 between 1.39 and 1.49: its brain (before #242) shared no home RAM, and its
    // batches held 82% of the cloud servers; nothing in the RAM says so.
    for (const [index, actual] of RUN_3_SHARE_BONUS.slice(0, CHECKED).entries()) {
      const model = measured.cycles[index]?.shareBonus ?? 0;
      if (index + 1 === 4) expect(model, "cycle 4").toBeGreaterThan(actual * 1.15);
      else expect(off(model, actual), `cycle ${index + 1}`).toBeLessThanOrEqual(0.1);
    }
  });
});

test("a run takes well under the CI runner's few seconds (about 0.3 s locally)", () => {
  const started = performance.now();
  runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY });
  expect(performance.now() - started).toBeLessThan(3000);
});
