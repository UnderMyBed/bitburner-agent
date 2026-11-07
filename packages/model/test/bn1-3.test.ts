// The held-out validation (#263's part 2): BN1.3, the exit run (#276), which no constant was fitted on. The model is
// fitted on run #3 alone (test/fit.ts, test/model.test.ts, test/validation.test.ts) and runs here unchanged. Labels:
// - independent: the fitted model from BN1.3's start (SF1.2, today's brain with #242's share and #243's hold). Nothing
//   of BN1.3 goes in, so these are predictions;
// - downstream: today's rules on BN1.3's own measured level and income a cycle (`BN1_3_CYCLES`). They share inputs with
//   what they check, so they test the rules' mechanism, not the curves;
// - out of range: a check whose cycle, or one before it, ran past the curves' range (`ModelRun.outOfRange`), so it's
//   no validation either way, whatever its figure. Every check asserts its run's range first.
// BN1.3's cycles 6 to 8 had the batcher stuck on poor targets for about 5 hours (#274): their income, and the level
// and the reputation that follow, are far under a healthy batcher's, and the 9th starts from what they left. The
// independent run models a healthy batcher, so the size of any check on those cycles, and of the phases and the total
// they fall in, is confounded; the downstream run has them in its measured curves. Each tolerance is in the test's
// name; the misses are pinned as known.

import { DAEDALUS } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import { CALIBRATION, type ModelRun, runModel, shareRamGbOfState, TODAYS_POLICY } from "../src/index.ts";
import { BN1_3, BN1_3_CASH, BN1_3_CYCLES, BN1_3_PER_CYCLE, BN1_3_SHARE_RAM } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const off = (model: number, actual: number) => (model - actual) / Math.abs(actual);

/**
 * The installs (1-based) at #244's phase ends: the first with the count at 17, BitRunners' donations unlocked, the one
 * before Daedalus's donations' (its cycle's start), Daedalus's donations unlocked.
 */
function phaseEndInstalls(counts: readonly number[], unlocked: (faction: string) => number): number[] {
  const count17 = counts.findIndex((count) => count >= 17) + 1;
  return [count17, unlocked("BitRunners"), unlocked(DAEDALUS) - 1, unlocked(DAEDALUS)];
}

/** #244's five phases, minutes: count 0 → 17; BitRunners' favour to 150; to Daedalus's cycle; its favour; destroy. */
function phases(installsAt: readonly number[], endInstalls: readonly number[], destroyedAt: number): number[] {
  const ends = [...endInstalls.map((install) => installsAt[install - 1] ?? Number.NaN), destroyedAt];
  return ends.map((end, index) => end - (index === 0 ? 0 : (ends[index - 1] as number)));
}

const BN1_3_PHASES = phases(
  BN1_3.installsAtMinutes,
  phaseEndInstalls(
    BN1_3_PER_CYCLE.map((cycle) => cycle.count),
    (faction) => BN1_3.donationsUnlockedAtInstall[faction as "BitRunners" | "Daedalus"],
  ),
  BN1_3.destroyedAtMinutes,
);

/** The model's view of a run: its installs, range, cash, gross and share RAM by cycle and minute, and its phases. */
function read(options: Parameters<typeof runModel>[1]) {
  const cash = new Map<string, number>();
  const gross = new Map<string, number>();
  const shareRam = new Map<string, number>();
  let cycle = 1;
  let last = -1;
  const run: ModelRun = runModel(BN1_3.start, {
    ...options,
    onStep: ({ onlineMs, money, gross: income, purse, worldRamGb }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      const key = `${cycle}:${onlineMs / MINUTE_MS}`;
      cash.set(key, money);
      gross.set(key, income);
      shareRam.set(key, shareRamGbOfState(purse, CALIBRATION, worldRamGb, cycle - 1));
    },
  });
  const unlockedAt = (faction: string) => {
    const unlock = run.events.find((event) => event.kind === "donationsUnlocked" && event.faction === faction);
    return run.cycles.findIndex((each) => each.endMs === unlock?.atMs) + 1;
  };
  const endInstalls = phaseEndInstalls(
    run.cycles.map((each) => each.countAfter),
    unlockedAt,
  );
  const firstOut = Math.min(...run.outOfRange, Number.POSITIVE_INFINITY);
  return {
    run,
    unlockedAt,
    /** Whether install `install` (1-based) ends a cycle in range, every cycle to it in range. */
    inRange: (install: number) => install < firstOut,
    endInstalls,
    phases: phases(
      run.cycles.map((each) => each.endMs / MINUTE_MS),
      endInstalls,
      (run.destroyedAtMs ?? Number.NaN) / MINUTE_MS,
    ),
    lengthMin: (index: number) => ((run.cycles[index]?.endMs ?? 0) - (run.cycles[index]?.startMs ?? 0)) / MINUTE_MS,
    mostWorked: (index: number) =>
      Object.entries(run.cycles[index]?.workMinutes ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0],
    cashAt: (cycleNumber: number, minutes: number) => cash.get(`${cycleNumber}:${minutes}`) ?? Number.NaN,
    grossAt: (cycleNumber: number, minutes: number) => gross.get(`${cycleNumber}:${minutes}`) ?? Number.NaN,
    shareRamAt: (cycleNumber: number, minutes: number) => shareRam.get(`${cycleNumber}:${Math.floor(minutes)}`),
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

  test("its range: the 8th cycle, Daedalus's grind, runs out of it (174 min past the curves' 120)", () => {
    expect(model.run.outOfRange).toEqual([8]);
    expect(model.run.cycles[7]?.extrapolatedMinutes).toBeGreaterThan(170);
  });

  test("BitRunners' donations unlock at the 7th install, BN1.3's [same install]; at 8 h 23 min, against 9 h 9 min", () => {
    // In range. The index matches, but not the path: the model's 5th cycle runs 79 min where BN1.3's was an 18.5-min
    // quick install, and its 6th leaves BitRunners at favour 148.8 where BN1.3's left 128.22 (#274's stuck batcher in
    // BN1.3's 6th and 7th: how much it delayed BN1.3 isn't known).
    expect(model.inRange(7)).toBe(true);
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    const sooner = off(model.run.cycles[6]?.endMs ?? 0, (BN1_3.installsAtMinutes[6] as number) * MINUTE_MS);
    expect(sooner).toBeCloseTo(-0.084, 2);
    expect(model.run.cycles[5]?.favorAfter.BitRunners).toBeGreaterThan(145);
  });

  test("known misses, in range: phase 1 +16%, phase 2 −42%, phase 3 0 min against 86 [15%]", () => {
    // Phase 1: the 5th cycle's 79 min, against BN1.3's 18.5-min quick install. Phases 2 and 3 span BN1.3's stuck
    // batcher too, so their size is confounded, but not their cause: the model joins Daedalus in the cycle after the
    // donations unlock, where BN1.3 took another (the stuck 8th).
    expect(model.endInstalls.slice(0, 3).every((install) => model.inRange(install))).toBe(true);
    const [first, second, third] = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    expect(first).toBeCloseTo(0.16, 2);
    expect(second).toBeCloseTo(-0.42, 2);
    expect(third).toBe(-1);
  });

  test("out of range: phases 4 and 5 and the destroy, past the 8th cycle", () => {
    expect(model.inRange(model.endInstalls[3] as number)).toBe(false);
    expect(model.run.outOfRange.length).toBeGreaterThan(0);
  });

  test("cycles 1 to 4: each length [25%], the count after [one], the level at the end [15%]", () => {
    expect(model.inRange(4)).toBe(true);
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

  test("known miss: the 5th cycle runs 79 min to the count rule, BN1.3's was a quick install at 18.5 min", () => {
    // BN1.3's brain worked Tian Di Hui from 6 min (BitRunners not yet joined: its backdoor came at 10-15 min, hacking
    // 633-818) and quick-installed its four at 17 min. The model joins BitRunners once the level reaches its server's
    // (5-10 min in) and A5 works it, so Tian Di Hui's four never come within the 20 minutes.
    expect(model.inRange(5)).toBe(true);
    expect(model.lengthMin(4)).toBe(79);
    expect(model.mostWorked(4)).toBe("BitRunners");
    expect(model.run.cycles[4]?.reason).toBe("count reached");
  });

  test("the share's RAM, #242's rule on the model's, cycles 2 to 5 at BN1.3's readings [×2.1]: 24 of 25", () => {
    // Nothing fitted: home's RAM less the Agent's 8 GB and the 32 kept, and the batches' hosts at run #3's 82% use, so
    // none. Within one doubling of home's RAM (BN1.3's readings rounded to three figures). The miss: the 2nd cycle at
    // 30 min, 8.2k GB against 32.7k (BN1.3 had bought two doublings more).
    expect(model.inRange(5)).toBe(true);
    const ratios = BN1_3_SHARE_RAM.filter(({ cycle }) => cycle >= 2 && cycle <= 5).flatMap(({ cycle, points }) =>
      points.flatMap(([minutes, gb]) => {
        const shared = model.shareRamAt(cycle, minutes);
        return shared === undefined ? [] : [{ cycle, minutes, ratio: shared / gb }];
      }),
    );
    const within = ratios.filter(({ ratio }) => ratio >= 1 / 2.1 && ratio <= 2.1);
    expect(ratios).toHaveLength(25);
    expect(within).toHaveLength(24);
    expect(ratios.find(({ ratio }) => ratio < 1 / 2.1)).toMatchObject({ cycle: 2, minutes: 30 });
  });

  test("the share's excess (the bonus less 1) a cycle, cycles 2 to 5 [10%]; known miss: the 1st's +33%", () => {
    // Cycle 1: the model's home RAM grows faster than BN1.3's (its cash in the steep minutes, below), so its share RAM
    // is ×3.7 and ×4.2 BN1.3's at 20 and 30 min.
    expect(model.inRange(5)).toBe(true);
    for (const index of [1, 2, 3, 4]) {
      const actual = BN1_3_PER_CYCLE[index]?.share as number;
      const excess = off((model.run.cycles[index]?.shareBonus ?? 0) - 1, actual - 1);
      expect(Math.abs(excess), `cycle ${index + 1}`).toBeLessThan(0.1);
    }
    const first = off((model.run.cycles[0]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[0]?.share as number) - 1);
    expect(first).toBeGreaterThan(0.3);
  });

  test("known miss, out of range: the money 5, 10 and 15 min into Daedalus's cycle, ×0.02, ×1.6, ×320 BN1.3's", () => {
    // BN1.3's 9th bought no cloud server by 15 min, its money on the world servers alone till 15-20 min. The model
    // buys its first at about 10 min, and from it the level paces the money again (the cap holds before it only).
    const daedalusCycle = model.run.cycles.findIndex((cycle) => cycle.reason === "Daedalus donations") + 1;
    expect(model.inRange(daedalusCycle)).toBe(false);
    const ratios = [5, 10, 15].map(
      (minutes) =>
        model.grossAt(daedalusCycle, minutes) / (BN1_3_CYCLES[8]?.points.find(([at]) => at === minutes)?.[2] as number),
    );
    expect(ratios[0]).toBeLessThan(0.05);
    expect(ratios[1]).toBeGreaterThan(1);
    expect(ratios[1]).toBeLessThan(3);
    expect(ratios[2]).toBeGreaterThan(100);
  });

  test("known miss: the cash, cycles 1 to 3 at 20 and 30 min (×0.0002 to ×23) and the 4th's (−15% to −36%)", () => {
    expect(model.inRange(4)).toBe(true);
    for (const { cycle, minutes, cash } of BN1_3_CASH) {
      const ratio = model.cashAt(cycle, minutes) / cash;
      if (cycle === 4) expect(Math.abs(ratio - 1), `cycle 4, ${minutes} min`).toBeGreaterThan(0.1);
      else expect(Math.abs(Math.log10(ratio)), `cycle ${cycle}, ${minutes} min`).toBeGreaterThan(0.1);
    }
  });
});

describe("downstream: today's rules on BN1.3's own measured curves", () => {
  const model = read({ policy: TODAYS_POLICY, measured: BN1_3_CYCLES });

  test("its range: the 5th cycle runs 104 min on BN1.3's 18.5-min curve, 86 past it, so from it out of range", () => {
    // It misses BN1.3's quick install as the independent run does. From the 5th, every milestone is out of range: the
    // donations at BN1.3's 7th and 9th installs, phases 1 to 5 (+1%, −7%, +1%, −1%, −15% by the figures; phase 1 from
    // errors that cancel, 141 min to the 3rd install against 158, the 4th cycle 77 against 141, the 5th 104 against
    // 18.5) and the destroy (−2%) are no validation.
    expect(model.run.outOfRange).toEqual([5]);
    expect(model.run.cycles[4]?.extrapolatedMinutes).toBeGreaterThan(80);
    expect(model.endInstalls.every((install) => !model.inRange(install))).toBe(true);
  });

  test("cycles 1 to 4: the count after the 1st, 2nd and 4th [one], the faction worked most in the 1st and 2nd", () => {
    expect(model.inRange(4)).toBe(true);
    for (const index of [0, 1, 3]) {
      const short = (BN1_3_PER_CYCLE[index]?.count ?? 0) - (model.run.cycles[index]?.countAfter ?? 0);
      expect(Math.abs(short), `install ${index + 1}`).toBeLessThanOrEqual(1);
    }
    expect([0, 1].map((index) => model.mostWorked(index))).toEqual(["CyberSec", "CyberSec"]);
  });

  test("known misses in cycles 1 to 4: the count after the 3rd (8, 10), the work in the 3rd and 4th, the 4th's length", () => {
    expect((BN1_3_PER_CYCLE[2]?.count ?? 0) - (model.run.cycles[2]?.countAfter ?? 0)).toBe(2);
    // BN1.3: NiteSec, then BitRunners.
    expect([2, 3].map((index) => model.mostWorked(index))).toEqual(["CyberSec", "NiteSec"]);
    // 77 min, against BN1.3's 141.
    expect(off(model.lengthMin(3), actualLengthMin(3))).toBeLessThan(-0.25);
  });

  test("the cash once the cloud servers are bought, the 3rd cycle's 30 min and the 4th's 30-60 [10%]: 3 of 4", () => {
    // All low: −9%, −8%, −10.5% at 45 min, −2%.
    const offs = [
      [3, 30],
      [4, 30],
      [4, 45],
      [4, 60],
    ].map(([cycle, minutes]) => {
      const actual = BN1_3_CASH.find((each) => each.cycle === cycle && each.minutes === minutes)?.cash as number;
      return off(model.cashAt(cycle as number, minutes as number), actual);
    });
    expect(offs.every((each) => each < 0)).toBe(true);
    expect(offs.filter((each) => Math.abs(each) < 0.1)).toHaveLength(3);
    expect(offs[2]).toBeLessThan(-0.1);
  });

  test("known miss, out of range: the share's RAM at a high level, BN1.3's 9th at 30-75 min, ×0.17 to ×0.65 BN1.3's", () => {
    // At run #3's 82% the batches' hosts share nothing, so the model's is home's alone; BN1.3's healthy 9th, at hacking
    // 4,000 and more, left most of the cloud to the share. `batchesUseOfHosts` isn't constant.
    expect(model.inRange(9)).toBe(false);
    const ratios = (BN1_3_SHARE_RAM.find(({ cycle }) => cycle === 9)?.points ?? [])
      .filter(([minutes]) => minutes >= 30)
      .map(([minutes, gb]) => (model.shareRamAt(9, minutes) ?? Number.NaN) / gb);
    expect(ratios).toHaveLength(4);
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.7);
    }
  });

  test("known miss: the cash where spending is most of the income, cycles 1 to 3 at 20 min, under 2% of BN1.3's", () => {
    // The model buys every purchase the minute's money covers; the brain one an intent, a medium snapshot apart, and
    // BN1.3's purchases show its money waiting between them. Part 1's miss on run #3 (validation.test.ts), held out.
    for (const cycle of [1, 2, 3]) {
      const actual = BN1_3_CASH.find((each) => each.cycle === cycle && each.minutes === 20)?.cash as number;
      expect(model.cashAt(cycle, 20) / actual, `cycle ${cycle}`).toBeLessThan(0.02);
    }
  });
});
