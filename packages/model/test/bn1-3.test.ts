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

  test("its range: every cycle in it (#263's left it at the 5th)", () => {
    expect(model.run.outOfRange).toEqual([]);
    expect(model.run.cycles).toHaveLength(10);
    expect(model.run.destroyedAtMs).not.toBeNull();
  });

  test("the 5th cycle's quick install at 17 min, BN1.3's at 18.5 [25%]; BitRunners joined at 11 min (BN1.3: 10-15)", () => {
    // #294's joins: BitRunners after its backdoor, the invitation and the brain's slow snapshots, not at the level
    // (#263: at 8 min, and A5 worked it); Tian Di Hui's four came within the 20 minutes.
    expect(model.run.cycles[4]?.reason).toBe("quick install");
    expect(Math.abs(off(model.lengthMin(4), actualLengthMin(4)))).toBeLessThan(0.25);
    expect(model.mostWorked(4)).toBe("Tian Di Hui");
    expect(model.joinedAt("BitRunners", 5)).toBe(11);
  });

  test("both donations at BN1.3's installs, the 7th and the 9th; the destroy +0.5%", () => {
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    expect(model.unlockedAt(DAEDALUS)).toBe(BN1_3.donationsUnlockedAtInstall.Daedalus);
    expect(off((model.run.destroyedAtMs ?? 0) / MINUTE_MS, BN1_3.destroyedAtMinutes)).toBeCloseTo(0.005, 2);
  });

  test("#244's five phases [15%]: −2%, +3%, +1%, +7%, −11%", () => {
    const offs = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    for (const [index, by] of offs.entries()) expect(Math.abs(by), `phase ${index + 1}`).toBeLessThanOrEqual(0.15);
    expect(offs.map((by) => Math.round(by * 100))).toEqual([-2, 3, 1, 7, -11]);
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

  test("each cycle's first cloud server at 11 to 14 min, BN1.3's between 10 and 15; Daedalus's at 17 (BN1.3: 15-20)", () => {
    // #294: the brain's rule (a full 10-minute window of its income measure from the Agent's start, one purchase a
    // medium snapshot). BN1.3's medium snapshots show no cloud RAM at 10 min in every cycle, some at 15 but in the 9th
    // (Daedalus's $100b held), some at 20.
    for (const cycle of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const minutes = model.firstCloudMin.get(cycle) ?? Number.NaN;
      expect(minutes, `cycle ${cycle}`).toBeGreaterThan(10);
      expect(minutes, `cycle ${cycle}`).toBeLessThanOrEqual(15);
    }
    expect(model.firstCloudMin.get(9)).toBe(17);
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

  test("the share's excess (the bonus less 1) a cycle, cycles 2 to 5 [10%]; known: the 1st's +23%", () => {
    for (const index of [1, 2, 3, 4]) {
      const actual = BN1_3_PER_CYCLE[index]?.share as number;
      const excess = off((model.run.cycles[index]?.shareBonus ?? 0) - 1, actual - 1);
      expect(Math.abs(excess), `cycle ${index + 1}`).toBeLessThan(0.1);
    }
    expect(off((model.run.cycles[0]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[0]?.share as number) - 1)).toBeGreaterThan(
      0.2,
    );
  });
});

describe("seen (no longer held out), independent: the fitted model from BN1.3's start", () => {
  const model = read({ policy: TODAYS_POLICY });

  test("its range: the 8th cycle, Daedalus's grind, runs out of it (130 min past the curves' 120)", () => {
    expect(model.run.outOfRange).toEqual([8]);
    expect(model.run.cycles[7]?.extrapolatedMinutes).toBeGreaterThan(125);
  });

  test("BitRunners' donations unlock at the 7th install, BN1.3's [same install]; at 8 h 30 min, against 9 h 9 min", () => {
    // In range. Its time spans BN1.3's stuck 6th and 7th (#274): confounded.
    expect(model.inRange(7)).toBe(true);
    expect(model.unlockedAt("BitRunners")).toBe(BN1_3.donationsUnlockedAtInstall.BitRunners);
    expect(off(model.run.cycles[6]?.endMs ?? 0, (BN1_3.installsAtMinutes[6] as number) * MINUTE_MS)).toBeCloseTo(
      -0.071,
      2,
    );
  });

  test("phase 1 +13% [15%]; known misses, in range: phase 2 −34%, phase 3 0 min against 86", () => {
    // Phase 2 and 3 span BN1.3's stuck batcher, so their size is confounded, but not that the model joins Daedalus in
    // the cycle after the donations unlock, where BN1.3 took another (the stuck 8th).
    expect(model.endInstalls.slice(0, 3).every((install) => model.inRange(install))).toBe(true);
    const [first, second, third] = model.phases.map((minutes, index) => off(minutes, BN1_3_PHASES[index] as number));
    expect(first).toBeCloseTo(0.13, 2);
    expect(second).toBeCloseTo(-0.34, 2);
    expect(third).toBe(-1);
  });

  test("out of range: phases 4 and 5 and the destroy, past the 8th cycle", () => {
    expect(model.inRange(model.endInstalls[3] as number)).toBe(false);
  });

  test("cycles 1 to 3: each length [25%], the count after [one]; the level at the end, cycles 1 to 4 [15%]", () => {
    expect(model.inRange(4)).toBe(true);
    for (const index of [0, 1, 2]) {
      const actual = BN1_3_PER_CYCLE[index];
      const cycle = model.run.cycles[index];
      expect(Math.abs(off(model.lengthMin(index), actualLengthMin(index))), `cycle ${index + 1}`).toBeLessThan(0.25);
      expect(Math.abs((cycle?.countAfter ?? 0) - (actual?.count ?? 0)), `cycle ${index + 1}`).toBeLessThanOrEqual(1);
    }
    for (const index of [0, 1, 2, 3]) {
      const level = model.run.cycles[index]?.hackingAtEnd ?? 0;
      expect(Math.abs(off(level, BN1_3_PER_CYCLE[index]?.hacking ?? 0)), `cycle ${index + 1}`).toBeLessThan(0.15);
    }
  });

  test("known misses: the 4th cycle 73 min (BN1.3's 141), 16 installed after it (14); the 5th 126 min (a quick install)", () => {
    expect(off(model.lengthMin(3), actualLengthMin(3))).toBeLessThan(-0.4);
    expect(model.run.cycles[3]?.countAfter).toBe(16);
    expect(model.lengthMin(4)).toBe(126);
    expect(model.run.cycles[4]?.reason).toBe("count reached");
    // BitRunners joined at 13 min, within BN1.3's 10-15 (#294's joins); A5 works it, as BN1.3's 4th did.
    expect(model.joinedAt("BitRunners", 5)).toBe(13);
    expect(model.mostWorked(4)).toBe("BitRunners");
  });

  test("the faction worked most, cycles 1 and 2, and its favour after the 1st [20% or 2]; known: the 2nd's favour, the 3rd and 4th", () => {
    expect([0, 1].map((index) => model.mostWorked(index))).toEqual(["CyberSec", "CyberSec"]);
    expect(Math.abs((model.run.cycles[0]?.favorAfter.CyberSec ?? 0) - 5.18)).toBeLessThanOrEqual(2);
    // 18.7 against 23.62: −21%.
    expect(off(model.run.cycles[1]?.favorAfter.CyberSec ?? 0, 23.62)).toBeLessThan(-0.2);
    expect([2, 3].map((index) => model.mostWorked(index))).toEqual(["CyberSec", "NiteSec"]);
  });

  test("each cycle's first cloud server at 11 to 13 min (BN1.3's between 10 and 15); Daedalus's at 11 (BN1.3: 15-20)", () => {
    for (const cycle of [1, 2, 3, 4, 5, 6, 7]) {
      const minutes = model.firstCloudMin.get(cycle) ?? Number.NaN;
      expect(minutes, `cycle ${cycle}`).toBeGreaterThan(10);
      expect(minutes, `cycle ${cycle}`).toBeLessThanOrEqual(13);
    }
    // The model's Daedalus cycle (its 8th) reaches hacking 2,500 only after its first server, so no $100b hold first.
    expect(model.run.cycles[7]?.reason).toBe("Daedalus donations");
    expect(model.firstCloudMin.get(8)).toBe(11);
  });

  test("known miss, out of range: the money 5, 10 and 15 min into Daedalus's cycle, ×0.09, ×14, ×680 BN1.3's", () => {
    // BN1.3's 9th held $100b for Daedalus from 8.6 min, bought no cloud server by 15 min, and its money rose about $1b
    // a minute on the world servers alone. The model's money runs away from its first cloud server (11 min) on: the
    // batches' ramp on the new RAM isn't modelled.
    const daedalusCycle = model.run.cycles.findIndex((cycle) => cycle.reason === "Daedalus donations") + 1;
    expect(model.inRange(daedalusCycle)).toBe(false);
    const ratios = [5, 10, 15].map(
      (minutes) =>
        model.grossAt(daedalusCycle, minutes) / (BN1_3_CYCLES[8]?.points.find(([at]) => at === minutes)?.[2] as number),
    );
    expect(ratios[0]).toBeLessThan(0.2);
    expect(ratios[1]).toBeGreaterThan(10);
    expect(ratios[2]).toBeGreaterThan(300);
  });

  test("the share's excess, cycles 2 to 5 [10%]: 3 of 4 (the 2nd −11%); known: the 1st's +16%", () => {
    expect(model.inRange(5)).toBe(true);
    const offs = [1, 2, 3, 4].map((index) =>
      off((model.run.cycles[index]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[index]?.share as number) - 1),
    );
    expect(offs.filter((by) => Math.abs(by) < 0.1)).toHaveLength(3);
    expect(offs[0]).toBeLessThan(-0.1);
    expect(off((model.run.cycles[0]?.shareBonus ?? 0) - 1, (BN1_3_PER_CYCLE[0]?.share as number) - 1)).toBeGreaterThan(
      0.1,
    );
  });

  test("the share's RAM, cycles 2 to 5 at BN1.3's readings the model's cycles reach [×2.1]: 19 of 20", () => {
    // Home's RAM less the Agent's 8 GB and the 32 kept; the batches' hosts, at core's plan, share nothing here. The
    // model's 2nd and 4th cycles end before BN1.3's last readings. The miss: the 2nd at 30 min, ×0.25.
    expect(model.inRange(5)).toBe(true);
    const ratios = BN1_3_SHARE_RAM.filter(({ cycle }) => cycle >= 2 && cycle <= 5).flatMap(({ cycle, points }) =>
      points.flatMap(([minutes, gb]) => {
        const shared = model.shareRamAt(cycle, minutes);
        return shared === undefined ? [] : [{ cycle, minutes, ratio: shared / gb }];
      }),
    );
    expect(ratios).toHaveLength(20);
    expect(ratios.filter(({ ratio }) => ratio >= 1 / 2.1 && ratio <= 2.1)).toHaveLength(19);
    expect(ratios.find(({ ratio }) => ratio < 1 / 2.1)).toMatchObject({ cycle: 2, minutes: 30 });
  });

  test("known miss: the cash, cycles 1 to 4 [×2]: 4 of 9 within (the 3rd ×0.03 and ×0.08, the 1st at 30 min ×10)", () => {
    expect(model.inRange(4)).toBe(true);
    const ratios = BN1_3_CASH.map(({ cycle, minutes, cash }) => model.cashAt(cycle, minutes) / cash);
    expect(ratios.filter((ratio) => Math.abs(Math.log2(ratio)) < 1)).toHaveLength(4);
  });
});
