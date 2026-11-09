// The validation on BN1.4 (#310), held out: nothing in the model was fitted or planned on it. The curves' tail past
// 120 min (`Calibration.tailCheckedMin`) is fitted on BN1.3, the seen run (#294's item 4: its 141-min 4th cycle and its
// Daedalus cycles), and checked here on BN1.4's Daedalus cycles, the 13th and 14th. BN1.4's 1st cycle is left out
// (35 h 45 min offline, with offline income): every run starts from its 2nd cycle's start as the game showed it
// (`ModelStart.afterInstall`: the set installed, each faction's favour, home's RAM). Labels, by #263's bar:
// - independent: the fitted model from the 2nd cycle's start (SF1.3, today's brain);
// - downstream: today's rules on BN1.4's own measured level and income a cycle (`BN1_4_CYCLES`); they share inputs with
//   what they check, so they test the rules' mechanism, not the curves;
// - the curves: the fitted curves run on each cycle's own multipliers, home RAM and first cloud server
//   (`replayCycle`), no rule moving them: a check of the curves, not the path;
// - the game: the model's formulas (core's `installGains` and SF1's bonus) against the multipliers the game showed;
// - fitted: BN1.3's cycles the tail is fitted on, consistency only.
// Each check asserts its run's range first; each tolerance is in the test's name; the misses are pinned as known.

import { DAEDALUS } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  batchesUseOf,
  CALIBRATION,
  Curves,
  type CycleState,
  cloudRamOf,
  type ModelRun,
  type Multipliers,
  multipliersOf,
  ROOTED_WORLD_RAM_GB_BY_PORTS,
  replayCycle,
  runModel,
  shareRamGbOfState,
  TODAYS_POLICY,
} from "../src/index.ts";
import { BN1_3_TAIL_CYCLES, BN1_4, BN1_4_CYCLES, BN1_4_PER_CYCLE, BN1_4_SHARE_RAM } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const off = (model: number, actual: number) => (model - actual) / Math.abs(actual);
const MULTIPLIER_KEYS = ["hacking", "hacking_exp", "hacking_speed", "hacking_money", "faction_rep"] as const;
/** #263's bars, which the tail is held to: the level within 15%, the money within ×2. */
const LEVEL_BAR = 0.15;
const MONEY_BAR = 2;

/**
 * #244's five phases from the 2nd cycle's start, minutes: count 17; BitRunners' donations; Daedalus's cycle; its
 * donations; the destroy. The phase ends are installs (1-based) but the last.
 */
function phases(
  installsAt: readonly number[],
  counts: readonly number[],
  unlocked: Record<string, number>,
  end: number,
) {
  const endInstalls = [
    counts.findIndex((count) => count >= 17) + 1,
    unlocked.BitRunners ?? Number.NaN,
    (unlocked[DAEDALUS] ?? Number.NaN) - 1,
    unlocked[DAEDALUS] ?? Number.NaN,
  ];
  const ends = [...endInstalls.map((install) => installsAt[install - 1] ?? Number.NaN), end];
  return ends.map((each, index) => each - (index === 0 ? 0 : (ends[index - 1] as number)));
}

const BN1_4_PHASES = phases(
  BN1_4.installsAtMinutes,
  BN1_4_PER_CYCLE.map((cycle) => cycle.count),
  BN1_4.donationsUnlockedAtInstall,
  BN1_4.destroyedAtMinutes,
);

/** The model's view of a run from BN1.4's 2nd cycle: by cycle, the first cloud server and BitRunners' join, minutes. */
function read(options: Parameters<typeof runModel>[1]) {
  const firstCloudMin = new Map<number, number>();
  let cycle = 0;
  let last = Number.POSITIVE_INFINITY;
  const run: ModelRun = runModel(BN1_4.start, {
    ...options,
    onStep: ({ onlineMs, purse }) => {
      if (onlineMs < last) cycle += 1;
      last = onlineMs;
      if (!firstCloudMin.has(cycle) && cloudRamOf(purse) > 0) firstCloudMin.set(cycle, onlineMs / MINUTE_MS);
    },
  });
  const installsAt = run.cycles.map((each) => each.endMs / MINUTE_MS);
  const unlocked = Object.fromEntries(
    run.events.flatMap((event) =>
      event.kind === "donationsUnlocked"
        ? [[event.faction, run.cycles.findIndex((each) => each.endMs === event.atMs) + 1]]
        : [],
    ),
  );
  const bitRunnersJoinedMin = run.cycles.map((each) => {
    const joined = run.events.find(
      (event) =>
        event.kind === "joined" &&
        event.faction === "BitRunners" &&
        event.atMs >= each.startMs &&
        event.atMs <= each.endMs,
    );
    return joined === undefined ? null : (joined.atMs - each.startMs) / MINUTE_MS;
  });
  const most = (index: number) =>
    Object.entries(run.cycles[index]?.workMinutes ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const counts = run.cycles.map((each) => each.countAfter);
  const modelPhases = phases(installsAt, counts, unlocked, (run.destroyedAtMs ?? Number.NaN) / MINUTE_MS);
  return { run, firstCloudMin, installsAt, unlocked, bitRunnersJoinedMin, most, phases: modelPhases };
}

const lengthMin = (run: ModelRun, index: number) =>
  ((run.cycles[index]?.endMs ?? 0) - (run.cycles[index]?.startMs ?? 0)) / MINUTE_MS;

const curves = new Curves(CALIBRATION);

/** The curves on a cycle's own state at its readings from `from` min, each with its ratios to the game's. */
function replay(state: CycleState, points: readonly (readonly [number, number, number])[], from = 5) {
  const read = points.filter(([minutes]) => minutes >= from);
  return replayCycle(
    curves,
    state,
    read.map(([minutes]) => minutes),
  ).map((each, at) => ({
    ...each,
    level: each.hacking / (read[at]?.[1] as number),
    gross: each.money / (read[at]?.[2] as number),
  }));
}

/**
 * The tail's drift on one cycle: past 120 min on each clock, each reading's ratio to the game's against the last
 * reading's before 120, the level's and the money's; and the furthest each clock reached within #263's bars. Null for
 * a clock that never passes 120.
 */
function tailDrift(state: CycleState, points: readonly (readonly [number, number, number])[]) {
  const all = replay(state, points);
  const within = (ratio: "level" | "gross", by: number) =>
    ratio === "level" ? Math.abs(by - 1) <= LEVEL_BAR : by <= MONEY_BAR && by >= 1 / MONEY_BAR;
  const clock = (key: "exp" | "money", ratio: "level" | "gross") => {
    const before = all.findLast((each) => each.clocks[key] <= 120);
    const past = all.filter((each) => each.clocks[key] > 120);
    if (before === undefined || past.length === 0) return null;
    const drifts = past.map((each) => ({ clock: each.clocks[key], by: each[ratio] / before[ratio] }));
    const broke = drifts.findIndex((each) => !within(ratio, each.by));
    return {
      drifts,
      held: broke === -1,
      reached: (broke === -1 ? drifts : drifts.slice(0, broke)).at(-1)?.clock ?? 120,
    };
  };
  return { exp: clock("exp", "level"), money: clock("money", "gross"), end: all.at(-1)?.clocks };
}

describe("BN1.4's own figures", () => {
  test("its phases from the 2nd cycle: 106, 154, 23, 40 and 11 min, 5 h 33 min to the destroy's readiness", () => {
    expect(BN1_4_PHASES.map(Math.round)).toEqual([106, 154, 23, 40, 11]);
    expect(BN1_4_PER_CYCLE.map((cycle) => cycle.lengthMin).reduce((sum, each) => sum + each, 0)).toBeCloseTo(330.5, 1);
    // Six quick installs: the 3rd to 7th and the 11th.
    const quick = BN1_4_PER_CYCLE.flatMap((cycle) => (cycle.reason === "quick install" ? [cycle.cycle] : []));
    expect(quick).toEqual([3, 4, 5, 6, 7, 11]);
  });
});

describe("a run from an install within the BitNode (`ModelStart.afterInstall`)", () => {
  test("starts with its set installed, its factions' favour and its home RAM; a BitNode's start with none", () => {
    const { installed, favor, homeRamGb } = BN1_4.start.afterInstall;
    let firstHomeRamGb: number | null = null;
    const favourOnJoining = new Map<string, number>();
    const run = runModel(BN1_4.start, {
      horizonMs: 30 * MINUTE_MS,
      onStep: ({ purse }) => {
        firstHomeRamGb ??= purse.homeRamGb;
      },
      onWork: ({ joined }) => {
        for (const each of joined) if (!favourOnJoining.has(each.name)) favourOnJoining.set(each.name, each.favor);
      },
    });
    expect(firstHomeRamGb).toBe(homeRamGb);
    expect(run.cycles[0]?.multipliers).toEqual(multipliersOf(installed, 3));
    expect(run.cycles[0]?.countAfter).toBe(Object.keys(installed).length + 1);
    // Every faction joined had the favour given: the whole map.
    expect(Object.fromEntries(favourOnJoining)).toEqual(favor);
    // The given state is copied, never changed.
    expect(BN1_4.start.afterInstall.installed["NeuroFlux Governor"]).toBe(26);
    const fresh = runModel({ currentNode: 1, ownedSF: { "1": 3 } }, { horizonMs: 120 * MINUTE_MS });
    expect(fresh.cycles[0]?.multipliers).toEqual(multipliersOf({}, 3));
  });
});

describe("the game: the model's multipliers against the game's", () => {
  test("installGains with SF1.3's bonus give the game's multipliers, faction_rep too, at each start [0.1%]", () => {
    const installed: Record<string, number> = { ...BN1_4.start.afterInstall.installed };
    for (const cycle of BN1_4_PER_CYCLE) {
      const model = multipliersOf(installed, 3);
      for (const key of MULTIPLIER_KEYS) {
        expect(Math.abs(off(model[key], cycle.multipliers[key])), `${key}, cycle ${cycle.cycle}`).toBeLessThan(0.001);
      }
      for (const name of cycle.added) installed[name] = 1;
      installed["NeuroFlux Governor"] = cycle.neuroFlux;
    }
  });
});

describe("the curves' tail past 120 min: fitted on BN1.3, held out on BN1.4", () => {
  test("fitted on BN1.3's 4th, 9th and 10th: within #263's bars to 262 and 240, so 140 and 120 min past 120", () => {
    const drifts = BN1_3_TAIL_CYCLES.map((cycle) => tailDrift(cycle, cycle.points));
    // The 10th never passes 120 on either clock; the 4th reaches 151 on both, the 9th 262 and 240.
    expect(drifts[2]?.exp).toBeNull();
    expect(drifts[2]?.money).toBeNull();
    // Each cycle's own reach within the bars: the 4th 151 on both clocks, the 9th 262 and 240 (in practice the fit).
    expect(
      drifts.slice(0, 2).map((each) => [each.exp?.reached, each.money?.reached].map((each) => Math.round(each ?? 0))),
    ).toEqual([
      [151, 151],
      [262, 240],
    ]);
    // The extents from the cycles that held within the bars throughout (all of BN1.3's), their furthest reach.
    const reached = (key: "exp" | "money") =>
      Math.max(...drifts.flatMap((each) => (each[key]?.held ? [each[key]?.reached ?? 120] : [])));
    expect(Math.round(reached("exp"))).toBe(262);
    expect(Math.round(reached("money"))).toBe(240);
    // Nothing breaks the bars on BN1.3: the level's ratio moves 5.3% at most, the money's to ×0.67.
    const levels = drifts.flatMap((each) => each.exp?.drifts.map(({ by }) => by) ?? []);
    const money = drifts.flatMap((each) => each.money?.drifts.map(({ by }) => by) ?? []);
    expect(Math.max(...levels.map((by) => Math.abs(by - 1)))).toBeCloseTo(0.053, 3);
    expect(Math.min(...money)).toBeCloseTo(0.67, 2);
    // The extents are the reach, rounded down to 10 min.
    expect(CALIBRATION.tailCheckedMin).toEqual({
      exp: Math.floor((reached("exp") - 120) / 10) * 10,
      money: Math.floor((reached("money") - 120) / 10) * 10,
    });
  });

  test("held out on BN1.4's 13th, to 200/162 of 260/240: the level's ratio drifts −2.9%, the money's ×0.96; the 14th never passes", () => {
    const [thirteenth, fourteenth] = [11, 12].map((index) =>
      tailDrift(BN1_4_PER_CYCLE[index] as CycleState, BN1_4_CYCLES[index]?.points ?? []),
    );
    // The 13th's clocks end at 200 and 162, within the range fitted on BN1.3: checked to there. Its level is about 40%
    // high before 120 and past it alike (the pace at hacking 5,000 and more): what's checked is the drift past 120.
    expect(Math.round(thirteenth?.end?.exp ?? 0)).toBe(200);
    expect(Math.round(thirteenth?.end?.money ?? 0)).toBe(162);
    expect(thirteenth?.end?.exp).toBeLessThanOrEqual(curves.range.exp);
    expect(thirteenth?.end?.money).toBeLessThanOrEqual(curves.range.money);
    const levels = thirteenth?.exp?.drifts.map(({ by }) => by) ?? [];
    const money = thirteenth?.money?.drifts.map(({ by }) => by) ?? [];
    expect(levels).toHaveLength(4);
    expect(money).toHaveLength(2);
    for (const by of levels) expect(Math.abs(by - 1)).toBeLessThanOrEqual(LEVEL_BAR);
    for (const by of money) expect(by >= 1 / MONEY_BAR && by <= MONEY_BAR).toBe(true);
    expect(Math.min(...levels)).toBeCloseTo(0.971, 3);
    expect(Math.min(...money)).toBeCloseTo(0.961, 3);
    expect(fourteenth?.exp).toBeNull();
    expect(fourteenth?.money).toBeNull();
  });
});

describe("the curves on each cycle's own state, the 2nd to 12th", () => {
  const ratios = (index: number, from = 5) =>
    replay(BN1_4_PER_CYCLE[index] as CycleState, BN1_4_CYCLES[index]?.points ?? [], from);
  const meanLevel = (index: number) => {
    const logs = ratios(index).map((each) => Math.log(each.level));
    return Math.exp(logs.reduce((sum, each) => sum + each, 0) / logs.length);
  };

  test("the level, its mean ratio a cycle from 5 min [15%]: the 3rd to 7th within (+2% to +14%); known: the rest high", () => {
    const means = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => meanLevel(index));
    const within = means.map((each) => Math.abs(each - 1) <= LEVEL_BAR);
    expect(within).toEqual([false, true, true, true, true, true, false, false, false, false, false]);
    // The 3rd to 7th +2% to +14%; the 2nd +18%; from the 8th +31% to +61%: the game's level stalls from about 10 min
    // till the cloud's late fill (flat at 1.0k to 1.2k in the 8th while its money stayed near $1e10), which the
    // curves' pace doesn't follow.
    expect(Math.min(...means.slice(1, 6))).toBeCloseTo(1.015, 2);
    expect(Math.max(...means.slice(1, 6))).toBeCloseTo(1.137, 2);
    expect(means[0]).toBeCloseTo(1.18, 2);
    expect(Math.min(...means.slice(6))).toBeGreaterThan(1.3);
    expect(Math.max(...means.slice(6))).toBeLessThan(1.62);
  });

  test("the money at 10 min, before the cycle's servers pay [×2]: all 11 within (×1.1 to ×1.9)", () => {
    const at10 = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => ratios(index, 10)[0]?.gross as number);
    for (const each of at10) {
      expect(each).toBeGreaterThan(1);
      expect(each).toBeLessThan(MONEY_BAR);
    }
  });

  test("known miss: the money at 15 min [×2], 1 of 11 (the 2nd ×0.78); ×0.18 to ×0.37 in five, ×16 to ×3,500 in five", () => {
    // The money after the first cloud server (#294's verdict 4): BN1.4's 7th stayed near $1e10 till 15 min and its 8th
    // to 10th and 12th till 20 to 30 min, where the curves' pace takes it to $1e12 and more; its 3rd to 6th and 11th
    // ramped sooner.
    const at15 = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => ratios(index, 15)[0]?.gross as number);
    expect(at15.filter((each) => each > 1 / MONEY_BAR && each < MONEY_BAR)).toHaveLength(1);
    expect(at15.filter((each) => each < 0.4)).toHaveLength(5);
    expect(at15.filter((each) => each > 15)).toHaveLength(5);
    expect(at15[5]).toBeGreaterThan(15);
    expect(Math.max(...at15)).toBeGreaterThan(3000);
  });
});

describe("held out, downstream: today's rules on BN1.4's own measured curves", () => {
  const model = read({ policy: TODAYS_POLICY, measured: BN1_4_CYCLES });
  const { run } = model;

  test("its range: every cycle within the bound; the 5th, 7th and 11th run 36, 23 and 39 min past BN1.4's own ends", () => {
    expect(run.outOfRange).toEqual([]);
    const past = run.cycles.map((each) => Math.round(each.extrapolatedMinutes));
    expect([past[3], past[5], past[9]]).toEqual([36, 23, 39]);
    expect(Math.max(...past.filter((_, index) => ![3, 5, 9].includes(index)))).toBeLessThanOrEqual(5);
  });

  test("cycles 2 to 4 as BN1.4's: the install's reason, the length [25%], the count after [one], the work, the share [10%]", () => {
    for (const index of [0, 1, 2]) {
      const actual = BN1_4_PER_CYCLE[index] as (typeof BN1_4_PER_CYCLE)[number];
      const cycle = run.cycles[index];
      expect(cycle?.reason).toBe(actual.reason);
      expect(Math.abs(off(lengthMin(run, index), actual.lengthMin))).toBeLessThan(0.25);
      expect(Math.abs((cycle?.countAfter ?? 0) - actual.count)).toBeLessThanOrEqual(1);
      expect(model.most(index)).toBe(actual.faction);
      expect(Math.abs(off((cycle?.shareBonus ?? 0) - 1, (actual.share as number) - 1))).toBeLessThan(0.1);
    }
  });

  test("known miss: 3 of BN1.4's 6 quick installs (the 3rd, 4th, 6th); the 5th and 7th by the count, the 11th Daedalus's", () => {
    const quick = run.cycles.slice(1, 6).map((each) => each.reason === "quick install");
    expect(quick).toEqual([true, true, false, true, false]);
    // The model's 11th, where the path has parted from BN1.4's, is its Daedalus cycle, 39 min past BN1.4's 11th's end.
    expect(run.cycles[9]?.reason).toBe("Daedalus donations");
  });

  test("the first cloud server at 11 min, a step after BN1.4's 10.4, in all 11; BitRunners joined within 2 min, 2 to 8", () => {
    for (let cycle = 1; cycle <= 11; cycle++) expect(model.firstCloudMin.get(cycle)).toBe(11);
    for (const [index, joined] of model.bitRunnersJoinedMin.slice(0, 7).entries()) {
      const actual = BN1_4_PER_CYCLE[index]?.bitRunnersJoinedMin as number;
      expect(Math.abs((joined as number) - actual)).toBeLessThanOrEqual(2);
    }
  });

  test("known miss: both donations two installs early (BitRunners' 8th, Daedalus's 10th; BN1.4's 10th, 12th)", () => {
    expect(model.unlocked).toEqual({ BitRunners: 8, [DAEDALUS]: 10 });
    expect(BN1_4.donationsUnlockedAtInstall).toEqual({ BitRunners: 10, Daedalus: 12 });
  });

  test("#244's phases [15%]: phase 2 −0.4% and the destroy +14.6% within; known: 1 +21%, 3 −16%, 4 +41%, 5 +128%", () => {
    const offs = model.phases.map((each, index) => off(each, BN1_4_PHASES[index] as number));
    expect(offs.map((each) => Math.round(each * 100) + 0)).toEqual([21, 0, -16, 41, 128]);
    // The destroy is within the bar by 0.4 points. BN1.4's 332.6 min is its 15th cycle's first reading (hacking
    // 4,520): its readiness came at or before it, so the true figure is +14.6% or more, and may be past the bar.
    const destroy = off((run.destroyedAtMs as number) / MINUTE_MS, BN1_4.destroyedAtMinutes);
    expect(destroy).toBeLessThan(0.15);
    expect(destroy).toBeGreaterThan(0.145);
  });
});

describe("held out, independent: the fitted model from BN1.4's 2nd cycle", () => {
  const model = read({ policy: TODAYS_POLICY });
  const { run } = model;

  test("its range: every cycle within it, the Daedalus cycle included (out at 62 min past 120 without the tail)", () => {
    expect(run.outOfRange).toEqual([]);
    const tail = { tailCheckedMin: { exp: 0, money: 0 } };
    expect(runModel(BN1_4.start, { policy: TODAYS_POLICY, calibration: tail }).outOfRange).toEqual([9]);
  });

  test("the 2nd cycle as BN1.4's: reason, length −23% [25%], count, levels bought, level +13% [15%], work, share", () => {
    const actual = BN1_4_PER_CYCLE[0];
    const cycle = run.cycles[0];
    expect(cycle?.reason).toBe(actual.reason);
    expect(off(lengthMin(run, 0), actual.lengthMin)).toBeCloseTo(-0.23, 2);
    expect(cycle?.countAfter).toBe(actual.count);
    expect(cycle?.neuroFluxLevels).toBe(actual.neuroFlux - 26);
    expect(off(cycle?.hackingAtEnd ?? 0, actual.hacking)).toBeCloseTo(0.13, 2);
    expect(model.most(0)).toBe("NiteSec");
    expect(Math.abs(off((cycle?.shareBonus ?? 0) - 1, actual.share - 1))).toBeLessThan(0.1);
    expect(Math.abs((model.bitRunnersJoinedMin[0] as number) - actual.bitRunnersJoinedMin)).toBeLessThanOrEqual(2);
    expect(model.firstCloudMin.get(1)).toBe(11);
  });

  test("known miss: 1 of BN1.4's 5 quick installs in cycles 3 to 7 (the 7th): 10 cycles to The Red Pill against 13", () => {
    const reasons = run.cycles.slice(1, 6).map((each) => each.reason);
    expect(reasons).toEqual(["count reached", "count reached", "count reached", "count reached", "quick install"]);
    expect(run.cycles).toHaveLength(10);
    expect(run.cycles.at(-1)?.reason).toBe("The Red Pill");
    // The curves run ahead (the level 2% to 61% high, the money after the first server far over): each cycle reaches
    // the count with its set bought, not NeuroFlux Governor alone; the 3rd ends with 17 installed against 15. The
    // model has no 11th cycle, so BN1.4's 11th quick install has no counterpart.
    expect(run.cycles[1]?.countAfter).toBe(17);
  });

  test("known miss: both donations three installs early (BitRunners' 7th, Daedalus's 9th; BN1.4's 10th, 12th)", () => {
    expect(model.unlocked).toEqual({ BitRunners: 7, [DAEDALUS]: 9 });
  });

  test("#244's phases [15%]: phase 2 −2% and phase 4 +11% within; known: 1 −49%, 3 −42%, 5 +43%, the destroy −17%", () => {
    const offs = model.phases.map((each, index) => off(each, BN1_4_PHASES[index] as number));
    expect(offs.map((each) => Math.round(each * 100) + 0)).toEqual([-49, -2, -42, 11, 43]);
    expect(Math.round(off((run.destroyedAtMs as number) / MINUTE_MS, BN1_4.destroyedAtMinutes) * 100)).toBe(-17);
  });
});

describe("the share at a high level (#294's item 5), on BN1.4's own state", () => {
  test("its RAM with the cloud bought, cycles 8 to 13 [×2.1]: 8 of 13; known: hacking 1.9k to 2.7k ×3.0 to ×5.2", () => {
    // Core's batch plan on BN1.4's level, multipliers, home and cloud RAM (`batchesUseOf`), the share by #242's rule
    // (`shareRamGbOfState`), against the share's RAM the game showed. At hacking 6.4k to 7.6k (the 13th) the batches
    // leave the cloud to the share, as BN1.4's did (×0.99 to ×1.00); at 1.3k to 1.6k (the 8th) they fill it (×1.00). Between, at
    // 1.9k to 2.7k (the 9th to 11th), the plan leaves 54% to 81% of the cloud to the share, where BN1.4's batches held
    // all of it; and the 8th's 40-min reading caught the hosts sharing for a moment (×0.09).
    const installed: Record<string, number> = { ...BN1_4.start.afterInstall.installed };
    const multipliersAt = new Map<number, ReturnType<typeof multipliersOf>>();
    for (const cycle of BN1_4_PER_CYCLE) {
      multipliersAt.set(cycle.cycle, multipliersOf(installed, 3));
      for (const name of cycle.added) installed[name] = 1;
      installed["NeuroFlux Governor"] = cycle.neuroFlux;
    }
    const worldGb = ROOTED_WORLD_RAM_GB_BY_PORTS[5] as number;
    const ratios = BN1_4_SHARE_RAM.map(([cycle, , hacking, homeRamGb, cloudGb, shareGb]) => {
      const { hacking_chance, hacking_speed, hacking_money, hacking_grow } = multipliersAt.get(cycle) as Multipliers;
      const mults = { hacking_chance, hacking_speed, hacking_money, hacking_grow };
      const use = batchesUseOf({ hacking, mults, ports: 5, hostsGb: worldGb + cloudGb });
      const purse = { spent: 0, programs: 6, cloudServersRamGb: [cloudGb], homeRamGb };
      return shareRamGbOfState(purse, use, worldGb) / shareGb;
    });
    const within = ratios.map((each) => each <= 2.1 && each >= 1 / 2.1);
    expect(within).toEqual([true, false, true, true, false, false, false, false, true, true, true, true, true]);
    expect(Math.min(...ratios.slice(8))).toBeGreaterThan(0.98);
    for (const index of [0, 2]) expect(ratios[index]).toBeCloseTo(1, 2);
    expect(Math.min(...[4, 5, 6, 7].map((index) => ratios[index] as number))).toBeGreaterThan(3);
    expect(Math.max(...ratios)).toBeLessThan(5.3);
  });
});
