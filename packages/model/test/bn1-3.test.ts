// The held-out validation (#263's part 2): BN1.3, the exit run (#276), which no constant was fitted on. The model is
// fitted on run #3 alone (test/model.test.ts, test/validation.test.ts) and runs here unchanged. Each check is labelled:
// - independent: the fitted model from BN1.3's start (SF1.2, today's brain with #242's share and #243's hold). Nothing
//   of BN1.3 goes in, so these are predictions;
// - downstream: today's rules on BN1.3's own measured level and income a cycle (`BN1_3_CYCLES`). They share inputs with
//   what they check, so they test the rules' mechanism, not the curves.
// BN1.3's cycles 6 to 8 had the batcher stuck on poor targets for about 5 hours (#274): their income, and the level
// and the reputation that follow, are far under a healthy batcher's. The independent run models a healthy one, so it
// leaves those cycles' money out, and the phases and the total they fall in are reported as confounded, not tested; the
// downstream run has them in its measured curves. Each tolerance is in the test's name; the misses are pinned as known.

import { DAEDALUS } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import { type ModelRun, runModel, TODAYS_POLICY } from "../src/index.ts";
import { BN1_3, BN1_3_CASH, BN1_3_CYCLES, BN1_3_PER_CYCLE, STUCK_BATCHER_CYCLES } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const off = (model: number, actual: number) => (model - actual) / Math.abs(actual);

/** The installs (1-based) at #244's phase ends: the count to 17, each donation unlocked, Daedalus's cycle's start. */
function phaseEnds(installsAt: readonly number[], counts: readonly number[], unlocked: (faction: string) => number) {
  const count17 = counts.findIndex((count) => count >= 17) + 1;
  return [count17, unlocked("BitRunners"), unlocked(DAEDALUS) - 1, unlocked(DAEDALUS)].map(
    (install) => installsAt[install - 1] ?? Number.NaN,
  );
}

/** #244's five phases, minutes: count 0 → 17; BitRunners' favour to 150; to Daedalus's cycle; its favour; destroy. */
function phases(ends: readonly number[], destroyedAt: number): number[] {
  return [...ends, destroyedAt].map((end, index) => end - (index === 0 ? 0 : (ends[index - 1] as number)));
}

const BN1_3_PHASES = phases(
  phaseEnds(
    BN1_3.installsAtMinutes,
    BN1_3_PER_CYCLE.map((cycle) => cycle.count),
    (faction) => BN1_3.donationsUnlockedAtInstall[faction as "BitRunners" | "Daedalus"],
  ),
  BN1_3.destroyedAtMinutes,
);

/** The model's view of a run: its installs, the cash and the gross by cycle and minute, its phases. */
function read(options: Parameters<typeof runModel>[1]) {
  const cash = new Map<string, number>();
  const gross = new Map<string, number>();
  let cycle = 1;
  let last = -1;
  const run: ModelRun = runModel(BN1_3.start, {
    ...options,
    onStep: ({ onlineMs, money, gross: income }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      cash.set(`${cycle}:${onlineMs / MINUTE_MS}`, money);
      gross.set(`${cycle}:${onlineMs / MINUTE_MS}`, income);
    },
  });
  const unlockedAt = (faction: string) => {
    const unlock = run.events.find((event) => event.kind === "donationsUnlocked" && event.faction === faction);
    return run.cycles.findIndex((each) => each.endMs === unlock?.atMs) + 1;
  };
  const installsAt = run.cycles.map((each) => each.endMs / MINUTE_MS);
  const ends = phaseEnds(
    installsAt,
    run.cycles.map((each) => each.countAfter),
    unlockedAt,
  );
  return {
    run,
    unlockedAt,
    phases: phases(ends, (run.destroyedAtMs ?? Number.NaN) / MINUTE_MS),
    lengthMin: (index: number) => ((run.cycles[index]?.endMs ?? 0) - (run.cycles[index]?.startMs ?? 0)) / MINUTE_MS,
    mostWorked: (index: number) =>
      Object.entries(run.cycles[index]?.workMinutes ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0],
    cashAt: (cycleNumber: number, minutes: number) => cash.get(`${cycleNumber}:${minutes}`) ?? Number.NaN,
    grossAt: (cycleNumber: number, minutes: number) => gross.get(`${cycleNumber}:${minutes}`) ?? Number.NaN,
  };
}

const actualLengthMin = (index: number) =>
  (BN1_3.installsAtMinutes[index] as number) - (index === 0 ? 0 : (BN1_3.installsAtMinutes[index - 1] as number));

describe("the held-out figures", () => {
  test("BN1.3's phases, as #244 splits run #3's: 317, 232, 86, 93 and 27 min, 12 h 35 min in all", () => {
    expect(BN1_3_PHASES.map((minutes) => Math.round(minutes))).toEqual([317, 232, 86, 93, 27]);
    // The same split on run #3's BN1.2 gives #244's own table: 267, 248, 59, 82 and 21 min.
  });
});

describe("independent: the fitted model from BN1.3's start (nothing of BN1.3 fitted)", () => {
  const model = read({ policy: TODAYS_POLICY });

  test("known miss: BitRunners' donations unlock at the 6th install (8 h 0 min), BN1.3's at its 7th (9 h 9 min)", () => {
    // BN1.3's 6th left BitRunners at favour 128.22; the model's leaves it past 150. BN1.3's 6th and 7th cycles had the
    // stuck batcher (#274), its level and so its reputation low, so a later unlock is expected there, but how much
    // later isn't known; and the model's 5th cycle isn't BN1.3's (below). Daedalus's unlock is an install early too.
    expect(model.unlockedAt("BitRunners")).toBe(6);
    expect(model.run.cycles[5]?.favorAfter.BitRunners).toBeGreaterThan(150);
    expect(model.unlockedAt(DAEDALUS)).toBe(BN1_3.donationsUnlockedAtInstall.Daedalus - 1);
  });

  test("#244's phase 4 (Daedalus's favour) [15%]; known misses: phase 1 +23%, phase 5 −15.0%", () => {
    const [first, , , fourth, fifth] = model.phases.map((minutes, index) =>
      off(minutes, BN1_3_PHASES[index] as number),
    );
    expect(Math.abs(fourth as number)).toBeLessThanOrEqual(0.15);
    // Phase 1: BN1.3's 5th cycle was a quick install at 18.5 min (Tian Di Hui's four, within 20 min of the install);
    // the model's runs 101 min (below). Phase 5: 23 min against 27.1, a step's minute short of the tolerance.
    expect(first).toBeGreaterThan(0.15);
    expect(first).toBeLessThan(0.3);
    expect(fifth).toBeLessThan(-0.15);
    expect(fifth).toBeGreaterThan(-0.2);
  });

  test("confounded, reported: phases 2 and 3 (−61%, −63%) and the destroy (−17%) span the stuck batcher's cycles", () => {
    // The model's healthy batcher is faster through BN1.3's 6th to 8th cycles, as expected, by how much isn't
    // measurable from BN1.3: these aren't validation either way.
    const [, second, third] = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    expect(second).toBeLessThan(0);
    expect(third).toBeLessThan(0);
    expect((model.run.destroyedAtMs ?? 0) / MINUTE_MS).toBeLessThan(BN1_3.destroyedAtMinutes);
  });

  test("cycles 1 to 4: each length [25%], the count after [one], the level at the end [15%]", () => {
    for (const index of [0, 1, 2, 3]) {
      const actual = BN1_3_PER_CYCLE[index];
      const cycle = model.run.cycles[index];
      expect(Math.abs(off(model.lengthMin(index), actualLengthMin(index))), `cycle ${index + 1}`).toBeLessThan(0.25);
      expect(Math.abs((cycle?.countAfter ?? 0) - (actual?.count ?? 0)), `cycle ${index + 1}`).toBeLessThanOrEqual(1);
      expect(Math.abs(off(cycle?.hackingAtEnd ?? 0, actual?.hacking ?? 0)), `cycle ${index + 1}`).toBeLessThan(0.15);
    }
  });

  test("cycles 1, 2 and 4: the faction worked most, and its favour after [20% or 2]; known miss: the 3rd's", () => {
    for (const index of [0, 1, 3]) {
      const actual = BN1_3_PER_CYCLE[index];
      const faction = actual?.faction as string;
      const actualFavor = actual?.favorAfter as number;
      expect(model.mostWorked(index), `cycle ${index + 1}`).toBe(faction);
      expect(
        Math.abs((model.run.cycles[index]?.favorAfter[faction] ?? 0) - actualFavor),
        `cycle ${index + 1}`,
      ).toBeLessThanOrEqual(Math.max(0.2 * actualFavor, 2));
    }
    // The 3rd works CyberSec for Cranial Signal Processors Gen II before NiteSec, as on run #3 (validation.test.ts):
    // NiteSec's favour after it 31.7, BN1.3's 41.01.
    expect(model.mostWorked(2)).toBe("CyberSec");
    expect(model.run.cycles[2]?.favorAfter.NiteSec).toBeLessThan(41.01 * 0.8);
  });

  test("known miss: the 5th cycle runs 101 min, BN1.3's was a quick install at 18.5 min", () => {
    // BN1.3's brain worked Tian Di Hui from 6 min (BitRunners not yet joined: its backdoor came at 10-15 min, hacking
    // 633-818) and quick-installed its four at 17 min. The model joins BitRunners once the level reaches its server's
    // (5-10 min in) and A5 works it, so Tian Di Hui's four never come within the 20 minutes.
    expect(model.lengthMin(4)).toBeGreaterThan(60);
    expect(model.mostWorked(4)).toBe("BitRunners");
    expect(model.run.cycles[4]?.reason).toBe("count reached");
  });

  test("the share a cycle, #242's rule on the model's RAM, cycles 1 to 5 [5%]; the 6th's confounded", () => {
    // Nothing fitted: home's RAM less what it keeps, and the batches' hosts at run #3's 82% use. The 6th's 1.61 is the
    // stuck batcher's: on poor targets the batches left most of the cloud servers to the share.
    for (const index of [0, 1, 2, 3, 4]) {
      const actual = BN1_3_PER_CYCLE[index]?.share as number;
      expect(Math.abs(off(model.run.cycles[index]?.shareBonus ?? 0, actual)), `cycle ${index + 1}`).toBeLessThan(0.05);
    }
    expect(STUCK_BATCHER_CYCLES).toContain(6);
    expect(model.run.cycles[5]?.shareBonus).toBeLessThan(1.61);
  });

  test("the money at high multipliers: 15 min into Daedalus's cycle and The Red Pill's, BN1.3's 9th and 10th [×2]", () => {
    // BN1.3: $12.47b and $13.36b at 15 min, on the world servers alone. The cap on the money's clock (run #3's fit)
    // brings the model's to within ×2, where uncapped it was ×1,000 over. Earlier, at 5 and 10 min, the model's is
    // ×0.003 and ×0.1 BN1.3's: its curve starts slower than a high-level cycle's does.
    const daedalusCycle = model.run.cycles.findIndex((cycle) => cycle.reason === "Daedalus donations") + 1;
    const redPillCycle = model.run.cycles.findIndex((cycle) => cycle.reason === "The Red Pill") + 1;
    expect(redPillCycle).toBe(daedalusCycle + 1);
    for (const [cycle, actualIndex] of [
      [daedalusCycle, 8],
      [redPillCycle, 9],
    ] as const) {
      const actual = BN1_3_CYCLES[actualIndex]?.points.find(([minutes]) => minutes === 15)?.[2] as number;
      const ratio = model.grossAt(cycle, 15) / actual;
      expect(ratio, `cycle ${cycle}`).toBeGreaterThan(0.5);
      expect(ratio, `cycle ${cycle}`).toBeLessThan(2);
      expect(model.grossAt(cycle, 5) / (BN1_3_CYCLES[actualIndex]?.points[0]?.[2] as number)).toBeLessThan(0.1);
    }
  });

  test("known miss: the cash in hand, cycles 1 to 3 at 20 and 30 min (×0.0002 to ×16) and the 4th's (−22% to −39%)", () => {
    for (const { cycle, minutes, cash } of BN1_3_CASH) {
      const ratio = model.cashAt(cycle, minutes) / cash;
      if (cycle === 4) expect(Math.abs(ratio - 1), `cycle 4, ${minutes} min`).toBeGreaterThan(0.1);
      else expect(Math.abs(Math.log10(ratio)), `cycle ${cycle}, ${minutes} min`).toBeGreaterThan(0.5);
    }
  });
});

describe("downstream: today's rules on BN1.3's own measured curves", () => {
  const model = read({ policy: TODAYS_POLICY, measured: BN1_3_CYCLES });

  test("the donations unlock at BN1.3's installs: BitRunners' at the 7th, Daedalus's at the 9th", () => {
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    expect(model.unlockedAt(DAEDALUS)).toBe(BN1_3.donationsUnlockedAtInstall.Daedalus);
  });

  test("#244's phases 1 to 4 [15%], the total [15%]; known miss: phase 5 −15.0%", () => {
    const offs = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    for (const index of [0, 1, 2, 3]) expect(Math.abs(offs[index] as number), `phase ${index + 1}`).toBeLessThan(0.15);
    expect(offs[4]).toBeLessThan(-0.15);
    expect(offs[4]).toBeGreaterThan(-0.2);
    expect(Math.abs(off((model.run.destroyedAtMs ?? 0) / MINUTE_MS, BN1_3.destroyedAtMinutes))).toBeLessThan(0.15);
  });

  test("the count after installs 1, 2, 4, 6 to 9 [one]; known misses: the 3rd (8, 10) and 5th (21, 18)", () => {
    for (const [index, actual] of BN1_3_PER_CYCLE.slice(0, 9).entries()) {
      const short = actual.count - (model.run.cycles[index]?.countAfter ?? 0);
      if (index + 1 === 3) expect(short, "install 3").toBe(2);
      else if (index + 1 === 5) expect(short, "install 5").toBe(-3);
      else expect(Math.abs(short), `install ${index + 1}`).toBeLessThanOrEqual(1);
    }
  });

  test("known miss: the 4th and 5th cycles swap (77 and 104 min, BN1.3's 141 and 18.5): the quick install missed", () => {
    expect(off(model.lengthMin(3), actualLengthMin(3))).toBeLessThan(-0.25);
    expect(model.lengthMin(4)).toBeGreaterThan(60);
    expect(model.lengthMin(3) + model.lengthMin(4)).toBeLessThan((actualLengthMin(3) + actualLengthMin(4)) * 1.15);
  });

  test("the faction worked most in cycles 1, 2 and 6 to 9; known misses in the 3rd to 5th", () => {
    const worked = BN1_3_PER_CYCLE.slice(0, 9).map((_, index) => model.mostWorked(index));
    expect(worked).toEqual([
      "CyberSec",
      "CyberSec",
      "CyberSec", // BN1.3: NiteSec
      "NiteSec", // BN1.3: BitRunners
      "BitRunners", // BN1.3: Tian Di Hui
      "BitRunners",
      "The Black Hand",
      "Aevum",
      "Daedalus",
    ]);
  });

  test("the cash once the cloud servers are bought: the 3rd cycle's 30 min and the 4th's 30 and 60 [10%]", () => {
    for (const [cycle, minutes] of [
      [3, 30],
      [4, 30],
      [4, 60],
    ] as const) {
      const actual = BN1_3_CASH.find((each) => each.cycle === cycle && each.minutes === minutes)?.cash as number;
      expect(Math.abs(off(model.cashAt(cycle, minutes), actual)), `cycle ${cycle}, ${minutes} min`).toBeLessThan(0.1);
    }
  });

  test("known miss: the cash where the spending is most of the income, cycles 1 to 3 at 20 min, under 2% of BN1.3's", () => {
    // The model buys every purchase the minute's money covers; the brain one an intent, a medium snapshot apart, and
    // BN1.3's purchases show its money waiting between them. Part 1's miss on run #3 (validation.test.ts), held out.
    for (const cycle of [1, 2, 3]) {
      const actual = BN1_3_CASH.find((each) => each.cycle === cycle && each.minutes === 20)?.cash as number;
      expect(model.cashAt(cycle, 20) / actual, `cycle ${cycle}`).toBeLessThan(0.02);
    }
  });
});
