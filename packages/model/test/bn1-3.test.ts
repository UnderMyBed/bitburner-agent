// The validation on BN1.3, the exit run (#276). #263's part 2 held it out; its first review's findings then cited its
// figures, and #294 was planned from them (the joins' time, the first cloud purchase, the share at a high level), so
// it is no longer held out: every check here is "seen (no longer held out)". Nothing is fitted on it: #294's refit is
// on run #3 alone (test/fit.ts, test/model.test.ts), and #294's mechanisms are the brain's code and the game's, tested
// against them (packages/brain/test). The next live run is the held-out check. Labels:
// - independent: the fitted model from BN1.3's start (SF1.2, today's brain with #242's share and #243's hold);
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
import { cloudRamOf, type ModelRun, runModel, TODAYS_POLICY } from "../src/index.ts";
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

/**
 * The model's view of a run: its installs, range, cash, gross, share RAM and cloud RAM by cycle and minute, each
 * cycle's first cloud server, and its phases.
 */
function read(options: Parameters<typeof runModel>[1]) {
  const cash = new Map<string, number>();
  const gross = new Map<string, number>();
  const shareRam = new Map<string, number>();
  const firstCloudMin = new Map<number, number>();
  let cycle = 1;
  let last = -1;
  const run: ModelRun = runModel(BN1_3.start, {
    ...options,
    onStep: ({ onlineMs, money, gross: income, purse, shareRamGb }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      const key = `${cycle}:${onlineMs / MINUTE_MS}`;
      cash.set(key, money);
      gross.set(key, income);
      shareRam.set(key, shareRamGb);
      if (cloudRamOf(purse) > 0 && !firstCloudMin.has(cycle)) firstCloudMin.set(cycle, onlineMs / MINUTE_MS);
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
  /** When `faction` was joined in cycle `cycleNumber` (1-based), minutes into it, or undefined. */
  const joinedAt = (faction: string, cycleNumber: number) => {
    const startMs = run.cycles[cycleNumber - 2]?.endMs ?? 0;
    const endMs = run.cycles[cycleNumber - 1]?.endMs ?? Number.POSITIVE_INFINITY;
    const join = run.events.find(
      (event) => event.kind === "joined" && event.faction === faction && event.atMs > startMs && event.atMs <= endMs,
    );
    return join === undefined ? undefined : (join.atMs - startMs) / MINUTE_MS;
  };
  return {
    run,
    unlockedAt,
    joinedAt,
    firstCloudMin,
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

describe("BN1.3's own figures", () => {
  test("its phases, as #244 splits run #3's: 317, 232, 86, 93 and 27 min, 12 h 35 min in all", () => {
    expect(BN1_3_PHASES.map((minutes) => Math.round(minutes))).toEqual([317, 232, 86, 93, 27]);
    // The same split on run #3's BN1.2 gives #244's own table: 267, 248, 59, 82 and 21 min.
  });
});

describe("seen (no longer held out), downstream: today's rules on BN1.3's own measured curves", () => {
  const model = read({ policy: TODAYS_POLICY, measured: BN1_3_CYCLES });

  test("its range: every cycle within the bound, but the 3rd and the 6th run 10 and 9 min past BN1.3's own ends", () => {
    // In range is the 60-min bound, set for the fitted curves. On measured curves a cycle that runs past its own end
    // reads them extrapolated: the 3rd runs 81 min on BN1.3's 70.8, the 6th 103 on 93.9; the rest within 3 min.
    expect(model.run.outOfRange).toEqual([]);
    expect(model.run.cycles).toHaveLength(10);
    const past = model.run.cycles.map((cycle) => Math.round(cycle.extrapolatedMinutes));
    expect(past).toEqual([2, 0, 10, 0, 0, 9, 0, 1, 3, 0]);
  });

  test("the 5th cycle's quick install at 17 min, BN1.3's at 18.5 [25%]; BitRunners joined at 10 min (BN1.3: 10-15)", () => {
    // #294's joins: BitRunners after its backdoor, the invitation and the brain's slow snapshots, not at the level
    // (#263: at 8 min, and A5 worked it); Tian Di Hui's four came within the 20 minutes. BN1.3's slow snapshot at
    // 10 min didn't show BitRunners yet, so the model's 10 is at the edge of its range.
    expect(model.run.cycles[4]?.reason).toBe("quick install");
    expect(Math.abs(off(model.lengthMin(4), actualLengthMin(4)))).toBeLessThan(0.25);
    expect(model.mostWorked(4)).toBe("Tian Di Hui");
    expect(model.joinedAt("BitRunners", 5)).toBe(10);
  });

  test("both donations at BN1.3's installs, the 7th and the 9th; the installs where BN1.3's came (the destroy −0.3%)", () => {
    // The installs match; that's not the time within each cycle, which the lengths check (below).
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    expect(model.unlockedAt(DAEDALUS)).toBe(BN1_3.donationsUnlockedAtInstall.Daedalus);
    expect(off((model.run.destroyedAtMs ?? 0) / MINUTE_MS, BN1_3.destroyedAtMinutes)).toBeCloseTo(-0.003, 2);
  });

  test("#244's five phases [15%]: −3%, +2%, +1%, +3%, −11%", () => {
    const offs = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    for (const [index, by] of offs.entries()) expect(Math.abs(by), `phase ${index + 1}`).toBeLessThanOrEqual(0.15);
    expect(offs.map((by) => Math.round(by * 100))).toEqual([-3, 2, 1, 3, -11]);
  });

  test("each cycle's length [25%]; the count after the 1st to 5th [one]; known: the 6th and 7th 2 and 4 short", () => {
    for (const index of model.run.cycles.keys()) {
      expect(Math.abs(off(model.lengthMin(index), actualLengthMin(index))), `cycle ${index + 1}`).toBeLessThan(0.25);
    }
    const shorts = BN1_3_PER_CYCLE.slice(0, 7).map(
      (actual, index) => actual.count - (model.run.cycles[index]?.countAfter ?? 0),
    );
    expect(shorts).toEqual([0, 1, 0, 1, 1, 2, 4]);
  });

  test("the faction worked most as BN1.3's in 6 of 9; known: the 3rd (CyberSec), the 7th and 8th", () => {
    const worked = BN1_3_PER_CYCLE.slice(0, 9).map((actual, index) => model.mostWorked(index) === actual.faction);
    expect(worked).toEqual([true, true, false, true, true, true, false, false, true]);
  });

  test("the first cloud server at 11 to 14 min in cycles 1-8 (BN1.3: 10-15); at 17 and 18 in the 9th and 10th (15-20)", () => {
    // #294: the brain's rule (a full 10-minute window of its income measure from the Agent's start, one purchase a
    // medium snapshot). BN1.3's medium snapshots show no cloud RAM at 10 min in every cycle, some at 15 but in the 9th
    // and 10th (Daedalus's $100b held), some at 20.
    for (const cycle of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const minutes = model.firstCloudMin.get(cycle) ?? Number.NaN;
      expect(minutes, `cycle ${cycle}`).toBeGreaterThan(10);
      expect(minutes, `cycle ${cycle}`).toBeLessThanOrEqual(15);
    }
    expect([model.firstCloudMin.get(9), model.firstCloudMin.get(10)]).toEqual([17, 18]);
  });

  test("the cash [×2]: 7 of 9 readings within it (#263's: under 2% at 20 min in cycles 1 to 3)", () => {
    // ×1.1, ×1.0, ×0.77, ×2.4, ×0.46, ×0.91, ×0.92, ×0.89, ×0.98: the purchases a medium snapshot apart (#294).
    const ratios = BN1_3_CASH.map(({ cycle, minutes, cash }) => model.cashAt(cycle, minutes) / cash);
    expect(ratios.filter((ratio) => Math.abs(Math.log2(ratio)) < 1)).toHaveLength(7);
    expect(ratios[3]).toBeGreaterThan(2);
    expect(ratios[4]).toBeLessThan(0.5);
  });

  test("the share's RAM at a high level, BN1.3's 9th at 30-75 min [×2.1]: ×0.90 to ×1.00 (#263's ×0.17 to ×0.65)", () => {
    // #294: the batches' use from core's batch maths on the state: at hacking 4,000 and more the target's money bounds
    // them, and they leave most of the cloud to the share, as BN1.3's did. At 20 min, ×8.4: the model's cloud bought
    // by then, BN1.3's not (the first at 17 min, its 20-min reading home's 2.1m GB).
    const ratios = (BN1_3_SHARE_RAM.find(({ cycle }) => cycle === 9)?.points ?? []).map(
      ([minutes, gb]) => (model.shareRamAt(9, minutes) ?? Number.NaN) / gb,
    );
    expect(ratios).toHaveLength(5);
    for (const ratio of ratios.slice(1)) {
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.05);
    }
    expect(ratios[0]).toBeGreaterThan(5);
  });

  test("the share's excess (the bonus less 1) a cycle, cycles 3 to 5 [10%]; known: the 1st +19%, the 2nd −10.1%", () => {
    const offs = [0, 1, 2, 3, 4].map((index) =>
      off((model.run.cycles[index]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[index]?.share as number) - 1),
    );
    for (const index of [2, 3, 4]) expect(Math.abs(offs[index] as number), `cycle ${index + 1}`).toBeLessThan(0.1);
    expect(offs[0]).toBeGreaterThan(0.15);
    expect(offs[1]).toBeCloseTo(-0.101, 3);
  });
});

describe("seen (no longer held out), independent: the fitted model from BN1.3's start", () => {
  const model = read({ policy: TODAYS_POLICY });

  test("its range: the 8th cycle, Daedalus's grind, runs out of it (114 min past the curves' 120)", () => {
    expect(model.run.outOfRange).toEqual([8]);
    expect(Math.round(model.run.cycles[7]?.extrapolatedMinutes ?? 0)).toBe(114);
  });

  test("the 5th cycle's quick install at 17 min, BN1.3's at 18.5 [25%]; BitRunners joined at 12 min (BN1.3: 10-15)", () => {
    // #263's run worked BitRunners from 8 min and missed it (79 min). With #294's joins Tian Di Hui's four came first.
    expect(model.inRange(5)).toBe(true);
    expect(model.run.cycles[4]?.reason).toBe("quick install");
    expect(Math.abs(off(model.lengthMin(4), actualLengthMin(4)))).toBeLessThan(0.25);
    expect(model.mostWorked(4)).toBe("Tian Di Hui");
    expect(model.joinedAt("BitRunners", 5)).toBe(12);
  });

  test("BitRunners' donations unlock at the 7th install, BN1.3's [same install]; at 8 h 35 min, against 9 h 9 min", () => {
    // In range. Its time spans BN1.3's stuck 6th and 7th (#274): confounded.
    expect(model.inRange(7)).toBe(true);
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    expect(off(model.run.cycles[6]?.endMs ?? 0, (BN1_3.installsAtMinutes[6] as number) * MINUTE_MS)).toBeCloseTo(
      -0.063,
      2,
    );
  });

  test("phases 1 and 2 [15%]: −4%, −10%; known miss, in range: phase 3, 0 min against 86", () => {
    // Phase 2 spans BN1.3's stuck batcher, so its size is confounded. Phase 3: the model joins Daedalus in the cycle
    // after the donations unlock, where BN1.3 took another (the stuck 8th).
    expect(model.endInstalls.slice(0, 3).every((install) => model.inRange(install))).toBe(true);
    const [first, second, third] = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    expect(first).toBeCloseTo(-0.035, 2);
    expect(second).toBeCloseTo(-0.1, 2);
    expect(third).toBe(-1);
  });

  test("out of range: phases 4 and 5 and the destroy, past the 8th cycle", () => {
    expect(model.inRange(model.endInstalls[3] as number)).toBe(false);
  });

  test("cycles 1 to 7: each length [25%]; the count after the 1st to 6th [one]; known: the 7th 2 over", () => {
    expect(model.inRange(7)).toBe(true);
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      expect(Math.abs(off(model.lengthMin(index), actualLengthMin(index))), `cycle ${index + 1}`).toBeLessThan(0.25);
    }
    const shorts = BN1_3_PER_CYCLE.slice(0, 7).map(
      (actual, index) => actual.count - (model.run.cycles[index]?.countAfter ?? 0),
    );
    expect(shorts).toEqual([0, 1, 0, 1, 0, 1, -2]);
  });

  test("the level at the end, cycles 2 to 4 [15%]; known: the 1st +17%, the 5th +21%", () => {
    const offs = [0, 1, 2, 3, 4].map((index) =>
      off(model.run.cycles[index]?.hackingAtEnd ?? 0, BN1_3_PER_CYCLE[index]?.hacking ?? 0),
    );
    for (const index of [1, 2, 3]) expect(Math.abs(offs[index] as number), `cycle ${index + 1}`).toBeLessThan(0.15);
    expect(offs[0]).toBeGreaterThan(0.15);
    expect(offs[4]).toBeGreaterThan(0.15);
  });

  test("the faction worked most as BN1.3's in cycles 1, 2, 4, 5 and 6, its favour after [20% or 2]; known: the 3rd", () => {
    for (const index of [0, 1, 3, 4, 5]) {
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
    // NiteSec's favour after it 31.5, BN1.3's 41.01.
    expect(model.mostWorked(2)).toBe("CyberSec");
    expect(model.run.cycles[2]?.favorAfter.NiteSec).toBeLessThan(41.01 * 0.8);
  });

  test("the first cloud server at 11 min in cycles 2-7 (BN1.3: 10-15); known: the 1st at 16, Daedalus's at 12 (15-20)", () => {
    for (const cycle of [2, 3, 4, 5, 6, 7]) expect(model.firstCloudMin.get(cycle), `cycle ${cycle}`).toBe(11);
    // The 1st waits on its payback over the world servers past 15 min; the model's Daedalus cycle (its 8th) reaches
    // hacking 2,500 only after its first server, so no $100b hold first.
    expect(model.firstCloudMin.get(1)).toBe(16);
    expect(model.run.cycles[7]?.reason).toBe("Daedalus donations");
    expect(model.firstCloudMin.get(8)).toBe(12);
  });

  test("known miss, out of range: the money 5, 10 and 15 min into Daedalus's cycle, ×0.02, ×1.6, ×350 BN1.3's", () => {
    // BN1.3's 9th held $100b for Daedalus from 8.6 min, bought no cloud server by 15 min, and its money rose about $1b
    // a minute on the world servers alone. The model's money runs away from its first cloud server (12 min) on: the
    // batches' ramp on the new RAM isn't modelled.
    const daedalusCycle = model.run.cycles.findIndex((cycle) => cycle.reason === "Daedalus donations") + 1;
    expect(model.inRange(daedalusCycle)).toBe(false);
    const ratios = [5, 10, 15].map(
      (minutes) =>
        model.grossAt(daedalusCycle, minutes) / (BN1_3_CYCLES[8]?.points.find(([at]) => at === minutes)?.[2] as number),
    );
    expect(ratios[0]).toBeLessThan(0.05);
    expect(ratios[1]).toBeGreaterThan(1);
    expect(ratios[1]).toBeLessThan(3);
    expect(ratios[2]).toBeGreaterThan(300);
  });

  test("the share's excess, cycles 3 to 5 [10%]; known: the 1st +12%, the 2nd −12%", () => {
    expect(model.inRange(5)).toBe(true);
    const offs = [0, 1, 2, 3, 4].map((index) =>
      off((model.run.cycles[index]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[index]?.share as number) - 1),
    );
    for (const index of [2, 3, 4]) expect(Math.abs(offs[index] as number), `cycle ${index + 1}`).toBeLessThan(0.1);
    expect(offs[0]).toBeGreaterThan(0.1);
    expect(offs[1]).toBeLessThan(-0.1);
  });

  test("the share's RAM, cycles 2 to 5 at BN1.3's readings the model's cycles reach [×2.1]: 22 of 23", () => {
    // Home's RAM less the Agent's 8 GB and the 32 kept; the batches' hosts, at core's plan, share nothing here. The
    // miss: the 2nd at 30 min, ×0.25.
    expect(model.inRange(5)).toBe(true);
    const ratios = BN1_3_SHARE_RAM.filter(({ cycle }) => cycle >= 2 && cycle <= 5).flatMap(({ cycle, points }) =>
      points.flatMap(([minutes, gb]) => {
        const shared = model.shareRamAt(cycle, minutes);
        return shared === undefined ? [] : [{ cycle, minutes, ratio: shared / gb }];
      }),
    );
    expect(ratios).toHaveLength(23);
    expect(ratios.filter(({ ratio }) => ratio >= 1 / 2.1 && ratio <= 2.1)).toHaveLength(22);
    expect(ratios.find(({ ratio }) => ratio < 1 / 2.1)).toMatchObject({ cycle: 2, minutes: 30 });
  });

  test("the cash, cycles 1 to 4 [×2]: 6 of 9 within; known: the 3rd ×0.03 and ×0.10, the 2nd at 30 min ×0.23", () => {
    expect(model.inRange(4)).toBe(true);
    const ratios = BN1_3_CASH.map(({ cycle, minutes, cash }) => model.cashAt(cycle, minutes) / cash);
    expect(ratios.filter((ratio) => Math.abs(Math.log2(ratio)) < 1)).toHaveLength(6);
  });
});
