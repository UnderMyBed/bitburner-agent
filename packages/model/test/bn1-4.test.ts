// The validation on BN1.4 (#310), held out: nothing in the model was fitted or planned on it but the curves' tail past
// 120 min (`Calibration.tailCheckedMin`), fitted on its Daedalus cycles, the 13th and 14th. Its 2nd to 12th cycles only
// check. Its 1st cycle is left out (35 h 45 min offline, with offline income): every run starts from its 2nd cycle's
// start as the game showed it (`ModelStart.afterInstall`: the set installed, each faction's favour, home's RAM).
// Labels, by #263's bar:
// - independent: the fitted model from the 2nd cycle's start (SF1.3, today's brain);
// - downstream: today's rules on BN1.4's own measured level and income a cycle (`BN1_4_CYCLES`); they share inputs with
//   what they check, so they test the rules' mechanism, not the curves;
// - the curves: the fitted curves run on each cycle's own multipliers, home RAM and first cloud server
//   (`replayCycle`), no rule moving them: independent for the 2nd to 12th, fitted for the 13th (the tail);
// - the game: the model's formulas against what the game showed.
// Each check asserts its run's range first; each tolerance is in the test's name; the misses are pinned as known.

import { DAEDALUS } from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  CALIBRATION,
  Curves,
  cloudRamOf,
  type ModelRun,
  multipliersOf,
  replayCycle,
  runModel,
  TODAYS_POLICY,
} from "../src/index.ts";
import { BN1_4, BN1_4_CYCLES, BN1_4_PER_CYCLE } from "./fixtures.ts";

const MINUTE_MS = 60_000;
const off = (model: number, actual: number) => (model - actual) / Math.abs(actual);
const HACKING_KEYS = ["hacking", "hacking_exp", "hacking_speed", "hacking_money"] as const;

/** #244's five phases from the 2nd cycle's start, minutes: count 17; BitRunners' donations; Daedalus's cycle; its
 * donations; the destroy. The phase ends are installs (1-based) but the last. */
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

describe("BN1.4's own figures", () => {
  test("its phases from the 2nd cycle: 106, 154, 23, 40 and 11 min, 5 h 33 min to the destroy's readiness", () => {
    expect(BN1_4_PHASES.map(Math.round)).toEqual([106, 154, 23, 40, 11]);
    expect(BN1_4_PER_CYCLE.map((cycle) => cycle.lengthMin).reduce((sum, each) => sum + each, 0)).toBeCloseTo(330.5, 1);
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
    expect(favourOnJoining.get("CyberSec")).toBe(favor.CyberSec);
    expect(favourOnJoining.get("NiteSec")).toBe(favor.NiteSec);
    // The given state is copied, never changed.
    expect(BN1_4.start.afterInstall.installed["NeuroFlux Governor"]).toBe(26);
    const fresh = runModel({ currentNode: 1, ownedSF: { "1": 3 } }, { horizonMs: 120 * MINUTE_MS });
    expect(fresh.cycles[0]?.multipliers).toEqual(multipliersOf({}, 3));
  });
});

describe("the game: the model's multipliers against the game's", () => {
  test("core's installGains with SF1.3's bonus give the game's hacking multipliers at every cycle's start [0.1%]", () => {
    const installed: Record<string, number> = { ...BN1_4.start.afterInstall.installed };
    for (const cycle of BN1_4_PER_CYCLE) {
      const model = multipliersOf(installed, 3);
      for (const key of HACKING_KEYS) {
        expect(Math.abs(off(model[key], cycle.multipliers[key])), `${key}, cycle ${cycle.cycle}`).toBeLessThan(0.001);
      }
      for (const name of cycle.added) installed[name] = 1;
      installed["NeuroFlux Governor"] = cycle.neuroFlux;
    }
  });
});

describe("the curves on each cycle's own state (independent for the 2nd to 12th, fitted for the 13th)", () => {
  const curves = new Curves(CALIBRATION);
  const replay = (index: number, from = 5) => {
    const points = (BN1_4_CYCLES[index]?.points ?? []).filter(([minutes]) => minutes >= from);
    const state = BN1_4_PER_CYCLE[index] as (typeof BN1_4_PER_CYCLE)[number];
    return replayCycle(
      curves,
      state,
      points.map(([minutes]) => minutes),
    ).map((each, at) => ({
      ...each,
      level: each.hacking / (points[at]?.[1] as number),
      gross: each.money / (points[at]?.[2] as number),
    }));
  };
  const meanLevel = (index: number) => {
    const ratios = replay(index).map((each) => Math.log(each.level));
    return Math.exp(ratios.reduce((sum, each) => sum + each, 0) / ratios.length);
  };

  test("the level, its mean ratio a cycle from 5 min [15%]: cycles 3 to 7 within; known: the 2nd +18%, 8th to 12th high", () => {
    const means = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => meanLevel(index));
    expect(means.map((each) => Math.abs(each - 1) <= 0.15)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // From the 8th the level runs 31% to 61% high: the game's stalls from about 10 min to the cloud's late fill (its
    // level flat at 1.0k to 1.2k in the 8th while its money stayed near $1e10), which the curves' pace doesn't follow.
    expect(means[0]).toBeCloseTo(1.18, 2);
    expect(Math.min(...means.slice(6))).toBeGreaterThan(1.3);
    expect(Math.max(...means.slice(6))).toBeLessThan(1.62);
  });

  test("the money at 10 min, before the cycle's servers pay [×2]: all 11 within (×1.1 to ×1.9)", () => {
    const at10 = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => replay(index, 10)[0]?.gross as number);
    for (const each of at10) {
      expect(each).toBeGreaterThan(1);
      expect(each).toBeLessThan(2);
    }
  });

  test("known miss: the money at 15 min [×2], 1 of 11 (the 2nd ×0.78); ×0.18 to ×0.37 in five, ×16 to ×3,500 in five", () => {
    // The money after the first cloud server (#294's verdict 4): BN1.4's 7th to 10th and 12th stayed near $1e10 till 20
    // to 30 min, where the curves' pace takes it to $1e12 and more; its 3rd to 6th and 11th ramped sooner.
    const at15 = BN1_4_PER_CYCLE.slice(0, 11).map((_, index) => replay(index, 15)[0]?.gross as number);
    expect(at15.filter((each) => each > 0.5 && each < 2)).toHaveLength(1);
    expect(at15.filter((each) => each < 0.4)).toHaveLength(5);
    expect(at15.filter((each) => each > 15)).toHaveLength(5);
    expect(Math.max(...at15)).toBeGreaterThan(3000);
  });

  test("fitted, the tail past 120 min on the 13th: the level's ratio holds within 3%, the money's within 10%", () => {
    // The 13th's clocks reach 200 (the experience's) and 162 (the money's): `tailCheckedMin` is fitted on it, 80 and 40.
    const all = replay(11);
    const last = all.at(-1);
    expect(last?.clocks.exp).toBeGreaterThan(CALIBRATION.tailCheckedMin.exp + 119);
    expect(last?.clocks.money).toBeGreaterThan(CALIBRATION.tailCheckedMin.money + 120);
    const before = all.findLast((each) => each.clocks.exp <= 120) as (typeof all)[number];
    for (const each of all.filter((point) => point.clocks.exp > 120)) {
      expect(Math.abs(each.level / before.level - 1)).toBeLessThan(0.03);
    }
    const beforeMoney = all.findLast((each) => each.clocks.money <= 120) as (typeof all)[number];
    const past = all.filter((point) => point.clocks.money > 120);
    expect(past.length).toBeGreaterThan(1);
    for (const each of past) expect(Math.abs(each.gross / beforeMoney.gross - 1)).toBeLessThan(0.1);
    // The level is 38% to 42% high there, before 120 and past it alike: the pace at hacking 5,000 and more, not the tail.
    expect(before.level).toBeGreaterThan(1.38);
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

  test("known miss: the quick installs in cycles 3 to 7, 3 of BN1.4's 5 (the 3rd, 4th, 6th); the 5th and 7th count", () => {
    const quick = run.cycles.slice(1, 6).map((each) => each.reason === "quick install");
    expect(quick).toEqual([true, true, false, true, false]);
    expect(BN1_4_PER_CYCLE.slice(1, 6).every((cycle) => cycle.reason === "quick install")).toBe(true);
    expect(run.cycles[3]?.reason).toBe("count reached");
  });

  test("the first cloud server at 11 min, a step after BN1.4's 10.4, in all 11; BitRunners joined within 2 min, 2 to 8", () => {
    for (let cycle = 1; cycle <= 11; cycle++) expect(model.firstCloudMin.get(cycle)).toBe(11);
    for (const [index, joined] of model.bitRunnersJoinedMin.slice(0, 7).entries()) {
      expect(
        Math.abs((joined as number) - (BN1_4_PER_CYCLE[index]?.bitRunnersJoinedMin as number)),
      ).toBeLessThanOrEqual(2);
    }
  });

  test("known miss: the donations a install or two early (BitRunners' 8th, Daedalus's 10th; BN1.4's 10th, 12th)", () => {
    expect(model.unlocked).toEqual({ BitRunners: 8, [DAEDALUS]: 10 });
    expect(BN1_4.donationsUnlockedAtInstall).toEqual({ BitRunners: 10, Daedalus: 12 });
  });

  test("#244's phases [15%]: phase 2 −0.4% and the destroy +14.6% within; known: 1 +21%, 3 −16%, 4 +41%, 5 +128%", () => {
    const offs = model.phases.map((each, index) => off(each, BN1_4_PHASES[index] as number));
    expect(offs.map((each) => Math.round(each * 100) + 0)).toEqual([21, 0, -16, 41, 128]);
    expect(off((run.destroyedAtMs as number) / MINUTE_MS, BN1_4.destroyedAtMinutes)).toBeCloseTo(0.146, 2);
  });
});

describe("held out, independent: the fitted model from BN1.4's 2nd cycle", () => {
  const model = read({ policy: TODAYS_POLICY });
  const { run } = model;

  test("its range: every cycle within it, the Daedalus cycle included (#294's range: 62 min past, out)", () => {
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

  test("known miss: no quick install in cycles 3 to 6 (BN1.4: all), so 10 cycles to The Red Pill against 13", () => {
    expect(run.cycles.slice(1, 5).map((each) => each.reason)).toEqual(Array(4).fill("count reached"));
    expect(run.cycles).toHaveLength(10);
    expect(run.cycles.at(-1)?.reason).toBe("The Red Pill");
    // The curves run ahead (the level 5% to 61% high, the money after the first server far over): each cycle reaches
    // the count with its set bought, not NeuroFlux Governor alone; the 3rd ends with 17 installed against 15.
    expect(run.cycles[1]?.countAfter).toBe(17);
  });

  test("known miss: the donations early (BitRunners' 7th, Daedalus's 9th install; BN1.4's 10th, 12th)", () => {
    expect(model.unlocked).toEqual({ BitRunners: 7, [DAEDALUS]: 9 });
  });

  test("#244's phases [15%]: phase 2 −2% and phase 4 +11% within; known: 1 −49%, 3 −42%, 5 +43%, the destroy −17%", () => {
    const offs = model.phases.map((each, index) => off(each, BN1_4_PHASES[index] as number));
    expect(offs.map((each) => Math.round(each * 100) + 0)).toEqual([-49, -2, -42, 11, 43]);
    expect(Math.round(off((run.destroyedAtMs as number) / MINUTE_MS, BN1_4.destroyedAtMinutes) * 100)).toBe(-17);
  });
});
