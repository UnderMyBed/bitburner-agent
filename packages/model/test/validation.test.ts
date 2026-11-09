// The cycle model's validation on run #3, the run it's fitted on (#260, #263), each check labelled for what it
// can show:
// - independent: the simulator's fresh BN1.1 (nothing of it was fitted), first;
// - downstream: run #3's cycles 1 to 6, the rules on its measured level and income a cycle. They share inputs with what
//   they check (the rate is the level times the share; the count and the favour turn on the money and the cycle's
//   length; the measured curves restart at run #3's truth each cycle), so they check the rules' mechanism;
// - fitted, so consistency only: the curve against run #3's own level, the share against run #3's own.
// BitRunners' donations unlock at the 7th install, not the 6th, and the simulator's first install is 16% early: tested
// as known misses, so a change to either is seen. From phase 3 of #244's table on, the runs are out of the curves'
// range (`ModelRun.outOfRange`), so no validation. BN1.3's checks, seen since #294 (no longer held out), are
// test/bn1-3.test.ts. Each tolerance is in the test's name.
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

  test("known miss: the 1st install at about 57 min comes 16% early [15%], the hacking ramp at 8 GB too fast", () => {
    // 48 min. firstCycleSpeed is fitted on BN1.2, whose home starts at 32 GB, as BN1.3's does: BN1.1's 8 GB is out of
    // every run's range. The simulator's figures are the one independent check, so they aren't fitted on.
    const early = 1 - (run.cycles[0]?.endMs ?? 0) / MINUTE_MS / 57;
    expect(early).toBeGreaterThan(0.15);
    expect(early).toBeLessThan(0.2);
  });

  test("the hacking level at the 2nd install [15%]; known miss: the 1st's, 347 against 290 (+20%)", () => {
    const [first, second] = SIMULATOR_SEED_1.hackingAtCycleEnd as readonly number[];
    expect(off(run.cycles[1]?.hackingAtEnd ?? 0, second as number)).toBeLessThanOrEqual(0.15);
    expect(off(run.cycles[0]?.hackingAtEnd ?? 0, first as number)).toBeGreaterThan(0.15);
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

  test("Daedalus's count after the 1st, 2nd, 3rd and 6th installs [one]; known: the 4th and 5th 2 short", () => {
    // #263's: the 3rd and 4th 2 and 4 short; #294's first refit had all six within one.
    for (const [index, { actual, cycle }] of perCycle(measured).entries()) {
      const short = actual.count - cycle.countAfter;
      if (index + 1 === 4 || index + 1 === 5) expect(short, `cycle ${index + 1}`).toBe(2);
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

  test("the reputation [25%] in the 1st and 4th cycles, its rate [16%] in the 1st; known: the 4th's rate +16.1%", () => {
    for (const index of [0, 3]) {
      const { actual, reputation, rate } = perCycle(measured)[index] as ReturnType<typeof perCycle>[number];
      expect(off(reputation, actual.reputation), `cycle ${index + 1}'s reputation`).toBeLessThanOrEqual(0.25);
      if (index === 0) expect(off(rate, actual.rate), "cycle 1's rate").toBeLessThanOrEqual(0.16);
      else expect(off(rate, actual.rate), "cycle 4's rate").toBeCloseTo(0.161, 3);
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

  test("the reputation [25%] and its rate [16%] in the 5th and 6th cycles (#294; #263's −26% and −20%)", () => {
    // −21% and −12%, the rate −2% and −15%: both still share at 1.43 against run #3's 1.49 and 1.55.
    for (const index of [4, 5]) {
      const { actual, reputation, rate } = perCycle(measured)[index] as ReturnType<typeof perCycle>[number];
      expect(off(reputation, actual.reputation), `cycle ${index + 1}`).toBeLessThanOrEqual(0.25);
      expect(off(rate, actual.rate), `cycle ${index + 1}'s rate`).toBeLessThanOrEqual(0.16);
      expect(reputation, `cycle ${index + 1}`).toBeLessThan(actual.reputation);
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

  test("cycles 1 to 3 at 30 min, the cash within ×2 of run #3's (×0.56, ×0.97, ×1.3; #263's under 2% in the 1st, 2nd)", () => {
    // #294: the brain buys one purchase a medium snapshot (10 s), so its money waits between them, as the model's now
    // does; #263's bought each the money covered within the step. Within 10% only in the 2nd.
    const ratios = [0, 1, 2].map((index) => cashAt(index, 30) / actualCash(index, 30));
    for (const [index, ratio] of ratios.entries()) {
      expect(Math.abs(Math.log2(ratio)), `cycle ${index + 1}`).toBeLessThan(1);
    }
    expect(ratios.filter((ratio) => Math.abs(ratio - 1) < 0.1)).toHaveLength(1);
  });
});

describe("the verdict's checks on run #3's BN1.2, the run fitted on", () => {
  const unlockedAt = (run: ModelRun) => {
    const unlock = run.events.find((event) => event.kind === "donationsUnlocked" && event.faction === "BitRunners");
    return run.cycles.findIndex((cycle) => cycle.endMs === unlock?.atMs) + 1;
  };

  test("known miss: BitRunners' donations unlock at the 7th install, not run #3's 6th (8 h 35 min)", () => {
    // Run #3's 6th install came with BitRunners' favour at 150.38, 0.38 over: a knife's edge. The model's is 142.2 on
    // run #3's measured curves and 142.6 on the fitted one (#263's: 139 and 143).
    for (const run of [measured, fitted]) {
      expect(unlockedAt(run)).toBe(7);
      const favor = run.cycles[5]?.favorAfter.BitRunners ?? 0;
      expect(favor).toBeGreaterThan(135);
      expect(favor).toBeLessThan(150);
    }
  });

  test("#244's first two phases [15%]: count 0 → 17 (4 installs), BitRunners' favour 5 → 150 (2 more)", () => {
    // Downstream −6% and +3%; fitted −6% and +2%.
    for (const [label, run] of [
      ["downstream", measured],
      ["fitted", fitted],
    ] as const) {
      // In range: every cycle to the 6th install.
      expect(Math.min(...run.outOfRange)).toBeGreaterThan(6);
      let start = 0;
      for (const [phase, { endsAtInstall, minutes }] of RUN_3_BN1_2.phases.slice(0, 2).entries()) {
        const end = run.cycles[endsAtInstall - 1]?.endMs ?? 0;
        const by = off((end - start) / MINUTE_MS, minutes);
        expect(by, `${label} phase ${phase + 1}`).toBeLessThanOrEqual(0.15);
        start = end;
      }
    }
  });

  test("downstream out of range from phase 3; fitted, in range by #310's tail: the destroy 12 h 1 min, +6.5% [15%]", () => {
    // Measured: run #3's 7th-10th curves run past their ends (31.6, 27.5, 81.7, 18.5 min), as the model's cycles are
    // others (the destroy 11 h 26 min). Fitted: the Daedalus cycle's clocks run past the curves' 120 min, within the
    // tail #310 fitted on BN1.3 (its 8th 23 min past the range, under the bound). Run #3's phases 3 to 5 aren't in the
    // fixtures, so only the total is checked: on the run the curves are fitted on, consistency only.
    expect(Math.min(...measured.outOfRange)).toBeLessThanOrEqual(8);
    expect(fitted.outOfRange).toEqual([]);
    const total = (fitted.destroyedAtMs as number) / MINUTE_MS;
    expect(Math.round(total)).toBe(721);
    expect(off(total, RUN_3_BN1_2.totalMinutes)).toBeLessThan(0.15);
  });
});

describe("fitted, so consistency only", () => {
  test("the fitted curve's hacking level at each cycle's end, cycles 1 to 5 [15%]; known: the 6th +20%", () => {
    for (const [index, actual] of RUN_3_PER_CYCLE.slice(0, CHECKED).entries()) {
      const by = off(fitted.cycles[index]?.hackingAtEnd ?? 0, actual.hacking);
      if (index + 1 === 6) expect(by, "cycle 6").toBeGreaterThan(0.15);
      else expect(by, `cycle ${index + 1}`).toBeLessThan(0.15);
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

test("a run takes well under the CI runner's few seconds (about 0.25 s locally)", () => {
  const started = performance.now();
  runModel(RUN_3_BN1_2.start, { policy: RUN_3_POLICY });
  expect(performance.now() - started).toBeLessThan(3000);
});
