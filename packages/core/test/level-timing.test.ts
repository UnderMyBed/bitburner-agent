// The planner's install timing after Daedalus's count (#413): the candidates' cases, the choice under #406's margin,
// A5's work, the cost by work counts, and the hindcast of BN4.2's c10-c11 and BN4.3's c12-c13 (`postcount.txt`).
import { describe, expect, test } from "vitest";
import { type CountableLeft, factionRepGain, type LaterCycles, levelInstallTiming } from "../src/install-timing.ts";
import { laterCycleRise, levelAlong, levelRiseOf, steps } from "../src/level-rise.ts";
import { addsToLevelling, levellingInstallMultipliers } from "../src/levelling.ts";
import { BN4_3_C12, BN4_3_INSTALLED_AT_COUNT, NEUROFLUX } from "./bn4-postcount-fixture.ts";
import {
  DEAD_BN4_3_C12,
  FACTOR_C12,
  FACTOR_C13,
  FAVOUR_C12,
  MINUTE,
  measuredFactor,
  PATHS,
  pathRows,
  RAMP_FALLBACK_MINUTES,
  READINGS,
  type Reading,
  rateWith,
  readingAt,
} from "./level-timing-hindcast.ts";

const REQUIRED = 2500;
const minutes = (ms: number) => ms / MINUTE;
/** m 2.75 at level 1,440 after 7e9 experience, κ about BN4.3's c12's end: 2,500 never within a cycle. */
const RISE = levelRiseOf({ exp: 7e9, level: 1440, levelMult: 2.747, expPerSecond: 2e6 });
const RATE = rateWith(40, 3.4);
const left = (...names: [string, number][]): CountableLeft[] =>
  names.map(([augmentation, reputation]) => ({ augmentation, reputation, sellers: ["BitRunners"] }));
const later = (fields: Partial<LaterCycles> = {}): LaterCycles => ({
  left: [],
  rebuildMs: 4 * MINUTE,
  rise: RISE,
  deadSeconds: 300,
  rateAt: (_faction, level) => RATE(level),
  installing: ["Cranial Signal Processors - Gen V", NEUROFLUX],
  ...fields,
});
/** The cycle after installing `names` on `RISE`, to the level (`laterCycleRise`, its dead time a ramp): ms. */
const levelAfter = (names: readonly string[], deadSeconds = 300) => {
  const rise = laterCycleRise(RISE, levellingInstallMultipliers(0, names), deadSeconds, true);
  let low = 0;
  let high = 1e9;
  for (let i = 0; i < 200; i++) {
    const middle = (low + high) / 2;
    if (levelAlong(rise, middle) >= REQUIRED) high = middle;
    else low = middle;
  }
  return high * 1000;
};

describe("the candidates (#413)", () => {
  test("install now: the cycle after it to 2,500 along `laterCycleRise`, its dead time first, none left to buy", () => {
    const timing = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [], later: later() });
    expect(timing).not.toBeNull();
    const now = timing?.candidates[0];
    expect(now).toMatchObject({ k: 0, waitedFor: [], tauMs: 0, cyclesMs: [] });
    expect(now?.levelMs).toBeCloseTo(levelAfter(later().installing), -1);
    expect(now?.estimateMs).toBe(now?.levelMs);
    // Staying: at m 2.75, 2,500 is about 1e15 experience away, against the 2e6 a second here.
    expect(minutes(timing?.stayMs as number)).toBeGreaterThan(1e6);
    expect(timing?.choice).toBe(0);
  });

  test("past the level now, staying's estimate is 0 and nothing installs; the money short, its time at the income", () => {
    const near = levelRiseOf({ exp: 1e9, level: 2499, levelMult: 6.8, expPerSecond: 2e6 });
    const staying = levelInstallTiming({ required: REQUIRED, rise: near, waits: [], later: later() });
    expect(minutes(staying?.stayMs as number)).toBeLessThan(1);
    expect(staying?.choice).toBeNull();
    expect(staying?.estimateMs).toBe(staying?.stayMs);
    const money = levelInstallTiming({
      required: REQUIRED,
      rise: near,
      moneyMs: 9 * MINUTE,
      waits: [],
      later: later(),
    });
    expect(money?.stayMs).toBe(9 * MINUTE);
  });

  test("staying from a level between two (a rise's own, unfloored): the time to 2,500 within its step, linear", () => {
    // From 2,499.5 at m 6.8: one step to 2,500.5, so 2,500 is half its time (as `levelAlong` has it).
    const near = { ...levelRiseOf({ exp: 1e9, level: 2499, levelMult: 6.8, expPerSecond: 2e6 }), level: 2499.5 };
    const timing = levelInstallTiming({ required: REQUIRED, rise: near, waits: [], later: later() });
    const step = steps(near).next().value as { toSeconds: number; toLevel: number };
    expect(step.toLevel).toBe(2500.5);
    expect(timing?.stayMs).toBeCloseTo((step.toSeconds / 2) * 1000, 6);
    expect(levelAlong(near, (timing?.stayMs as number) / 1000)).toBeCloseTo(REQUIRED, 9);
  });

  test("the later cycles by #389's DP where the level comes sooner after them: B(j) and the level after j, the least", () => {
    // At m 2.75 times CSP V's 1.3 alone, 2,500 is days away; a cycle buying Neural Accelerator and ABNI first is not.
    const timing = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [],
      later: later({
        left: left(["Neural Accelerator", 200_000], ["Artificial Bio-neural Network Implant", 275_000]),
      }),
    });
    const now = timing?.candidates[0];
    expect(now?.cyclesMs).toHaveLength(1);
    const after = [...later().installing, "Neural Accelerator", "Artificial Bio-neural Network Implant"];
    expect(now?.levelMs).toBeCloseTo(levelAfter(after), -1);
    expect(now?.estimateMs).toBeCloseTo((now?.cyclesMs[0] as number) + (now?.levelMs as number), 6);
    expect(now?.levelMs as number).toBeLessThan(levelAfter(later().installing));
  });

  test("only the hacking set: a countable that adds nothing to the level is never bought for it", () => {
    const timing = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [],
      later: later({ left: left(["DataJack", 1], ["Neural Accelerator", 200_000]) }),
    });
    expect(timing?.later.left).toBe(1);
  });

  test("nothing that adds to the level to install: no install now (it would only reset the level)", () => {
    const timing = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [{ faction: "BitRunners", next: [{ augmentation: "Neural Accelerator", tauMs: 60 * MINUTE }] }],
      later: later({ installing: ["DataJack"] }),
    });
    expect(timing?.candidates.map((each) => each.k)).toEqual([1]);
    expect(timing?.choice).toBe(0);
    expect(timing?.candidates[0]?.faction).toBe("BitRunners");
  });

  test("unpriced (no R, no rise): null, the caller's count rule", () => {
    expect(levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [], later: later({ rebuildMs: null }) })).toBe(
      null,
    );
    expect(levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [], later: later({ rise: null }) })).toBe(null);
  });
});

describe("the choice (#413): installing only by more than the error (#406), a wait held, A5's work", () => {
  const wait = (tauMs: number, tauError?: number) => ({
    faction: "BitRunners",
    next: [{ augmentation: "Neural Accelerator", tauMs, ...(tauError === undefined ? {} : { tauError }) }],
  });
  const nowMs = levelAfter(later().installing);
  const waitLevelMs = levelAfter([...later().installing, "Neural Accelerator"]);

  test("a wait whose augmentation cuts the level's time more than its τ wins; else install now", () => {
    const cut = nowMs - waitLevelMs;
    expect(cut).toBeGreaterThan(0);
    const wins = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [wait(cut / 2)], later: later() });
    expect(wins?.choice).toBe(1);
    expect(wins?.work).toEqual({ faction: "BitRunners", augmentation: "Neural Accelerator" });
    const loses = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [wait(cut * 2)], later: later() });
    expect(loses?.choice).toBe(0);
    // Installing now, A5's work is still the best wait's: the faction whose next most cuts the time.
    expect(loses?.work).toEqual({ faction: "BitRunners", augmentation: "Neural Accelerator" });
  });

  test("installing now by less than the wait's τ error waits; by more, installs; a tie waits", () => {
    const cut = nowMs - waitLevelMs;
    // Install now 10 min ahead of the wait.
    const tauMs = cut + 10 * MINUTE;
    const within = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [wait(tauMs, (15 * MINUTE) / tauMs)],
      later: later(),
    });
    expect(within?.candidates[1]?.errorMs).toBeCloseTo(15 * MINUTE, 6);
    expect(within?.choice).toBe(1);
    expect(within?.kept).toBe("margin");
    expect(within?.marginMs).toBeCloseTo(15 * MINUTE, 6);
    const beyond = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [wait(tauMs, (5 * MINUTE) / tauMs)],
      later: later(),
    });
    expect(beyond?.choice).toBe(0);
    const tie = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [wait(cut)], later: later() });
    expect(tie?.candidates[1]?.estimateMs).toBeCloseTo(tie?.candidates[0]?.estimateMs as number, 3);
    expect(tie?.choice).not.toBe(0);
    // An exact tie: a wait for one that adds nothing to the level (DataJack: hacking_money alone), no τ: the same path
    // after its install, the same estimate to the bit. It waits.
    const exact = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [{ faction: "BitRunners", next: [{ augmentation: "DataJack", tauMs: 0 }] }],
      later: later(),
    });
    expect(exact?.candidates[1]?.estimateMs).toBe(exact?.candidates[0]?.estimateMs);
    expect(exact?.choice).toBe(1);
    expect(exact?.kept).toBe("margin");
  });

  test("the wait under way held unless a rival beats it by more than the larger error", () => {
    const cut = nowMs - waitLevelMs;
    const tauMs = cut + 2 * MINUTE;
    const waits = [wait(tauMs, 0.1)];
    const held = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [
        ...waits,
        { faction: "The Black Hand", next: [{ augmentation: "Neural Accelerator", tauMs: tauMs - 60_000 }] },
      ],
      later: later(),
      held: { faction: "BitRunners", k: 1 },
      tauError: 0,
    });
    expect(held?.candidates[held?.choice as number]?.faction).toBe("BitRunners");
    expect(held?.kept).toBe("held");
    const gone = levelInstallTiming({
      required: REQUIRED,
      rise: RISE,
      waits: [...waits, { faction: "The Black Hand", next: [{ augmentation: "Neural Accelerator", tauMs: 60_000 }] }],
      later: later(),
      held: { faction: "BitRunners", k: 1 },
    });
    expect(gone?.candidates[gone?.choice as number]?.faction).toBe("The Black Hand");
  });

  test("#343's guards: no income measured, or an invitation's money held: install now held, the best wait or none", () => {
    const tauMs = (nowMs - waitLevelMs) * 2;
    for (const guard of [{ incomeMeasured: false }, { invitationHeld: true }]) {
      const held = levelInstallTiming({
        required: REQUIRED,
        rise: RISE,
        waits: [wait(tauMs)],
        later: later(),
        ...guard,
      });
      expect(held?.candidates[0]?.estimateMs).toBeLessThan(held?.candidates[1]?.estimateMs as number);
      expect(held?.choice).toBe(1);
      expect([held?.heldForIncome, held?.heldForInvitation]).toEqual([
        guard.incomeMeasured === false,
        guard.invitationHeld === true,
      ]);
      const none = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [], later: later(), ...guard });
      expect(none?.choice).toBeNull();
    }
    const free = levelInstallTiming({ required: REQUIRED, rise: RISE, waits: [wait(tauMs)], later: later() });
    expect([free?.choice, free?.heldForIncome, free?.heldForInvitation]).toEqual([0, false, false]);
  });

  test("a wait whose τ is past this cycle's own time to the invitation is staying: no wait chosen, nothing held", () => {
    const near = levelRiseOf({ exp: 1e9, level: 2400, levelMult: 6.8, expPerSecond: 2e6 });
    const timing = levelInstallTiming({ required: REQUIRED, rise: near, waits: [wait(600 * MINUTE)], later: later() });
    const waiting = timing?.candidates.find((each) => each.k === 1);
    expect(waiting?.stays).toBe(true);
    expect(waiting?.estimateMs).toBe(timing?.stayMs);
    // Staying (#413's review): no wait chosen, so none described or its money held; A5's work still its faction.
    expect(timing?.choice).toBeNull();
    expect(timing?.estimateMs).toBe(timing?.stayMs);
    expect(timing?.work).toEqual({ faction: "BitRunners", augmentation: "Neural Accelerator" });
  });
});

/** Each reading's timing, as the brain would take it: its τ errors none (the evidence holds no rate series). */
const timingOf = (reading: Reading, counts?: { priced: number; lookups: number; levels?: number }) =>
  levelInstallTiming({
    required: REQUIRED,
    rise: reading.rise,
    waits: reading.waits,
    later: reading.later,
    ...(counts === undefined ? {} : { counts }),
  });

describe("the hindcast (#413): BN4.2's c10-c11 and BN4.3's c12-c13", () => {
  /**
   * The level at 5 and 10 min and each 15 min of each post-count cycle against #405's path (`laterCycleRise` from the
   * cycle before's end, at the install's multipliers), its dead time the brain would price with (the cycle before's
   * ramp, else the fallback's 10 min) a ramp in the rate, the level rising during it (#413's review: flat, BN4.3's c13
   * at 15 min was 1 against 1,607); BN4.2's c9 and BN4.3's c11, before the count, have one sample, their mean rate.
   * 0.84-1.21 throughout, inside the ramp too: c13 0.88 and 0.95 at 5 and 10 min (in c12's 28.5); c14 1.00 at +5
   * (2,597 against 2,608: past 2,500 there, as the c13 install's estimate says); BN4.2's c12 1.21 at +5.
   */
  test("the level at 5, 10 and each 15 min against the path's, inside the ramp too", () => {
    const rows = PATHS.flatMap(({ cycle, before, dead }) =>
      pathRows(cycle, before, dead).map((row) => ({ ...row, name: cycle.name, dead: dead.minutes })),
    );
    expect(rows).toHaveLength(8 + 8 + 8 + 9 + 1 + 1);
    for (const row of rows) {
      expect(row.predicted / row.level).toBeGreaterThan(0.8);
      expect(row.predicted / row.level).toBeLessThan(1.25);
    }
    const inRamp = rows.filter((row) => row.minutes < row.dead).map((row) => `${row.name} ${row.minutes}`);
    expect(inRamp).toEqual([
      "BN4.2 c10 5",
      "BN4.3 c12 5",
      "BN4.3 c13 5",
      "BN4.3 c13 10",
      "BN4.3 c13 15",
      "BN4.3 c14 5",
    ]);
    const c14 = rows.find((row) => row.name === "BN4.3 c14");
    expect(c14?.predicted).toBeGreaterThan(2500);
    expect((c14?.predicted as number) / (c14?.level as number)).toBeCloseTo(1, 1);
  });

  test("BN4.3's measured factor in the share's place: c12's predicts c13's BitRunners rate within 15%", () => {
    expect(FACTOR_C12).toBeCloseTo(3.37, 2);
    expect(FACTOR_C13 / FACTOR_C12).toBeCloseTo(1.14, 2);
    // c13's faction_rep was c12's install's NeuroFlux Governor levels' 1.01^7 = 1.072 higher: the rest, the share's.
    expect(measuredFactor(BN4_3_C12, FAVOUR_C12["The Black Hand"] as number, 23.56, 4, 96)).toBe(FACTOR_C12);
  });

  /**
   * Each post-count install's choice against what happened (each installed), with each option's time to 2,500 and
   * the actual, minutes online from the choice to Daedalus joined. Install now is chosen at all four, as happened; its
   * estimate within ×2 at the two that bought the next cycle (1.28, 0.88). The two last are under 10 min actual, the
   * campaign report's rule for a ratio, so out of it, labelled with their cause: the estimate is the level's alone, the
   * actual mostly the commit (1.8-1.9 min, chosen to sent) and the $100b (about +6 min), both left out. BN4.2's c11 0.3
   * against 6 (its ramp under the evidence's 5-minute samples); BN4.3's c13 4.0 against 8.1 (0.49), the level itself on
   * its path (c14's 2,597 against 2,608 at +5, the test above). Flat for c12's 28.5-min ramp, as before #413's review,
   * c13 was 28.8.
   */
  const ROWS: [name: string, actual: number, installNow: number, bestWait: number, choice: number][] = [
    ["BN4.2 c10", 106, 136.2, 154.6, 0],
    ["BN4.2 c11", 6, 0.3, 298.8, 0],
    ["BN4.3 c12", 171, 150.1, 168.5, 0],
    ["BN4.3 c13", 8.1, 4.0, 288.4, 0],
  ];

  test("each install's choice: install now, as happened; every option's time to 2,500", () => {
    const rows = READINGS.map((reading) => {
      const timing = timingOf(reading);
      const best = Math.min(...(timing?.candidates.filter((each) => each.k > 0).map((each) => each.estimateMs) ?? []));
      return [
        reading.name,
        reading.actual,
        Number(minutes(timing?.candidates[0]?.estimateMs as number).toFixed(1)),
        Number(minutes(best).toFixed(1)),
        timing?.choice,
      ];
    });
    expect(rows).toEqual(ROWS);
    // At 10 min or more actual, within ×2; under it, out of the ratio (the campaign report's rule), labelled above.
    for (const [, actual, now] of rows as [string, number, number][]) {
      if (actual < 10) continue;
      expect(now / actual).toBeGreaterThan(0.5);
      expect(now / actual).toBeLessThan(2);
    }
    expect(rows.filter(([, actual]) => (actual as number) < 10).map(([name]) => name)).toEqual([
      "BN4.2 c11",
      "BN4.3 c13",
    ]);
  });

  /**
   * A5's work at BN4.3's count (#413's question): from c12's start, The Black Hand's work (its reputation the report's
   * rate since R, 4 min), the dead time the brain would have then (#413's review: no hindsight): c12's own ramp once
   * measured (28.5 min), before it the fallback's 10. The planner's estimate against the time left to the join (268 min
   * from the count): 0.79-0.99. It works The Black Hand throughout, its three there (Neuralstimulator, Enhanced Myelin
   * Sheathing, The Black Hand) first, as the brain did.
   */
  test("A5's work from the count: the faction whose next augmentation most cuts the time to 2,500", () => {
    const rows = [15, 30, 45, 60].map((at) => {
      const reading = readingAt({
        name: `BN4.3 c12 at ${at}`,
        actual: 268 - at,
        cycle: BN4_3_C12,
        minutes: at,
        installed: BN4_3_INSTALLED_AT_COUNT,
        installing: Array.from({ length: 7 }, () => NEUROFLUX),
        set: [],
        reputation: { "The Black Hand": 23.56 * Math.max(0, at - 4) * 60 },
        favor: FAVOUR_C12,
        factor: FACTOR_C12,
        dead: at >= DEAD_BN4_3_C12.minutes ? DEAD_BN4_3_C12 : { minutes: RAMP_FALLBACK_MINUTES, from: "the fallback" },
      });
      const timing = timingOf(reading);
      const chosen = timing?.candidates[timing?.choice as number];
      return [at, reading.actual, Number(minutes(timing?.estimateMs as number).toFixed(1)), chosen?.faction, chosen?.k];
    });
    expect(rows).toEqual([
      [15, 253, 250.5, "The Black Hand", 3],
      [30, 238, 210.0, "The Black Hand", 3],
      [45, 223, 186.5, "The Black Hand", 3],
      [60, 208, 164.5, "The Black Hand", 3],
    ]);
    for (const [, actual, estimate] of rows) {
      expect((estimate as number) / (actual as number)).toBeGreaterThan(0.75);
      expect((estimate as number) / (actual as number)).toBeLessThan(1.2);
    }
  });

  /**
   * The cost by work counts (#399's way, not time): BN4.3's c12 at 15 min, 10 of the hacking set left and 14 waits.
   * Each candidate's DP asks for r(r + 1) / 2 cycles of its r left, 409 in all; shared, one priced for each distinct
   * (path, faction_rep, group) of them all, and one walk to the level for each distinct path after every split, both
   * derived here from the candidates (#413's review), not measured.
   */
  test("its work at a reading of 10 left and 14 waits: each distinct cycle priced once, each distinct path walked once", () => {
    const reading = readingAt({
      name: "BN4.3 c12 at 15",
      actual: 253,
      cycle: BN4_3_C12,
      minutes: 15,
      installed: BN4_3_INSTALLED_AT_COUNT,
      installing: Array.from({ length: 7 }, () => NEUROFLUX),
      set: [],
      reputation: { "The Black Hand": 23.56 * 11 * 60 },
      favor: FAVOUR_C12,
      factor: FACTOR_C12,
      dead: { minutes: RAMP_FALLBACK_MINUTES, from: "the fallback" },
    });
    const counts = { priced: 0, lookups: 0 };
    const start = performance.now();
    const timing = timingOf(reading, counts);
    const ms = performance.now() - start;
    const leftCount = timing?.later.left as number;
    expect(leftCount).toBe(10);
    const asked = (timing?.candidates ?? []).reduce((sum, each) => {
      const r =
        leftCount - each.waitedFor.filter((name) => reading.later.left.some((one) => one.augmentation === name)).length;
      return sum + (r * (r + 1)) / 2;
    }, 0);
    expect(timing?.candidates).toHaveLength(15);
    // The distinct cycles and paths, keyed as the pricing keys them: the path (m, κ, the ramp) and faction_rep after the
    // installs before each cycle, and the cycle's countables.
    const later = reading.later;
    const hacking = later.left.filter((each) => addsToLevelling([each.augmentation]));
    const pathOf = (installs: readonly string[]) => {
      const rise = laterCycleRise(
        later.rise as NonNullable<LaterCycles["rise"]>,
        levellingInstallMultipliers(0, installs),
        later.deadSeconds,
        true,
      );
      return `${rise.levelMult} ${rise.kappa} ${rise.rampSeconds ?? 0}`;
    };
    const cycles = new Set<string>();
    const paths = new Set<string>();
    for (const candidate of timing?.candidates ?? []) {
      const names = hacking.map((each) => each.augmentation).filter((name) => !candidate.waitedFor.includes(name));
      const installing = [...later.installing, ...candidate.waitedFor];
      for (let j = 0; j <= names.length; j++) paths.add(pathOf([...installing, ...names.slice(0, j)]));
      for (let i = 0; i < names.length; i++) {
        const before = [...installing, ...names.slice(0, i)];
        for (let j = i + 1; j <= names.length; j++) {
          cycles.add(`${pathOf(before)} ${factionRepGain(before)} ${names.slice(i, j).join(",")}`);
        }
      }
    }
    expect(counts).toEqual({ priced: cycles.size, lookups: asked, levels: paths.size });
    expect(asked).toBe(409);
    console.log(
      `10 left, 14 waits: ${counts.priced} cycles priced of ${counts.lookups}, ${ms.toFixed(2)} ms (printed)`,
    );
  });
});
