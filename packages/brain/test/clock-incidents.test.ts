// Clock steps and page stalls (#241): found in the snapshots' two clocks, each shown in the run report's section 4, 3
// within an hour a failure, and the weaken time a batcher's desyncs are put down to one within. Synthetic times with
// run #3's real shape (2026-11-05, #241's correction): Windows stepped the clock +2,678 ms; the game's process saw it
// first (a fast interval 4.68 s on the game's clock, 2.00 s received), the brain's 20 s later (the reverse).
import { describe, expect, test } from "vitest";
import {
  CLOCK_STEP_MIN_MS,
  CLOCK_STEP_PAIR_WITHIN_MS,
  CLOCK_STEP_STEADY_MS,
  type ClockIncident,
  DELIVERY_LAG_MIN_MS,
  DELIVERY_LAG_SAME_WITHIN_MS,
  type DeliveryLag,
  describeIncident,
  findClockIncidents,
  findDeliveryLags,
  holdsThePage,
  incidentLines,
  PAGE_STALL_FAST_INTERVAL_MS,
  PAGE_STALL_MEDIUM_MARGIN_MS,
  PAGE_STALL_SAME_INCIDENT_WITHIN_MS,
  TOO_MANY_INCIDENTS,
  TOO_MANY_INCIDENTS_WITHIN_MS,
  WeakenTimes,
} from "../src/clock-incidents.ts";
import { staticServer } from "./helpers/snapshot-fixtures.ts";

const T0 = Date.parse("2026-11-05T17:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
/** A snapshot received at `offsetMs`, taken at the game's `gameOffsetMs` (the same by default). */
const point = (offsetMs: number, gameOffsetMs = offsetMs, degradedTiers: string[] = []) => ({
  atMs: T0 + offsetMs,
  gameTimeMs: T0 + gameOffsetMs,
  degradedTiers,
});
const none = { medium: [], fast: [], restartsMs: [] };

/** Clock moves: from round k on, the clock `ms` on. */
type ClockMoves = [round: number, ms: number][];

/**
 * Run #3's rounds, every 2 s (round k at 1.8 + 2k s, true time) from round 330 to `lastRound`: the game's clock and the
 * brain's each moving as `gameMoves` and `brainMoves` say (by default `stepMs`, the game's from round 354, between
 * 11:47.8 and 11:49.8, and the brain's from 364, between 12:07.8 and 12:09.8); a medium snapshot every 5th round. The
 * fast snapshots in the store's order, by receipt.
 */
function run3({
  stepMs = 2_678,
  gameMoves = null as ClockMoves | null,
  brainMoves = null as ClockMoves | null,
  lastRound = 400,
} = {}) {
  const moved = (moves: ClockMoves, round: number) =>
    moves.reduce((sum, [from, ms]) => sum + (round >= from ? ms : 0), 0);
  const fast = [];
  const medium = [];
  for (let round = 330; round <= lastRound; round++) {
    const trueMs = 1_800 + 2_000 * round;
    const game = trueMs + moved(gameMoves ?? [[354, stepMs]], round);
    const received = trueMs + moved(brainMoves ?? [[364, stepMs]], round);
    fast.push(point(received, game));
    if (round % 5 === 0) medium.push(point(received, game));
  }
  return { fast: fast.sort((a, b) => a.atMs - b.atMs), medium, restartsMs: [] };
}

/** Fast snapshots every 2 s from 0 to `untilMs`, each of `stallsAt` followed by one 5 s later instead. */
function fastWithStalls(stallsAt: number[], untilMs: number) {
  const fast = [];
  for (let offsetMs = 0; offsetMs <= untilMs; offsetMs += stallsAt.includes(offsetMs) ? 5_000 : 2_000) {
    fast.push(point(offsetMs));
  }
  return fast;
}

describe("clock steps", () => {
  const RUN3_STEP = {
    kind: "clockStep",
    fromMs: T0 + 707_800,
    toMs: T0 + 732_478,
    sizeMs: 2_678,
    gameClock: { fromMs: T0 + 707_800, toMs: T0 + 709_800 },
    detail:
      `the game's clock +2.7 s between snapshots at ${at(707_800)} and ${at(709_800)}, the brain's +2.7 s between ` +
      `${at(727_800)} and ${at(732_478)}`,
  };

  test("run #3: the game's clock and the brain's each 2.7 s on, 20 s apart, in both tiers: one clock step", () => {
    expect(findClockIncidents(run3())).toEqual([RUN3_STEP]);
  });

  test("the brain's clock never seen to move (the window ends, say): the game's alone is a clock step", () => {
    expect(findClockIncidents(run3({ brainMoves: [] }))).toEqual([
      {
        kind: "clockStep",
        fromMs: T0 + 707_800,
        toMs: T0 + 709_800,
        sizeMs: 2_678,
        gameClock: { fromMs: T0 + 707_800, toMs: T0 + 709_800 },
        detail:
          `the game's clock +2.7 s between snapshots at ${at(707_800)} and ${at(709_800)}; the brain's not seen to ` +
          "move",
      },
    ]);
  });

  test("the two clocks taking it up in adjacent intervals, 1 s or 2.7 s: one step, each clock judged on its own", () => {
    for (const stepMs of [1_000, 2_678]) {
      const steps = findClockIncidents(run3({ gameMoves: [[354, stepMs]], brainMoves: [[355, stepMs]] }));
      expect(steps).toEqual([
        expect.objectContaining({
          kind: "clockStep",
          sizeMs: stepMs,
          gameClock: { fromMs: T0 + 707_800, toMs: T0 + 709_800 },
        }),
      ]);
      expect(steps[0]?.detail).toMatch(/^the game's clock \+\d\.\d s between .*, the brain's \+\d\.\d s between /);
    }
  });

  test("both taking it up in the same interval: a page stall over 2 s, unseen under it (a round running long)", () => {
    const both = (stepMs: number) => run3({ gameMoves: [[354, stepMs]], brainMoves: [[354, stepMs]] });
    expect(findClockIncidents(both(2_678))).toEqual([
      expect.objectContaining({ kind: "pageStall", fromMs: T0 + 707_800, toMs: T0 + 712_478, sizeMs: 2_678 }),
    ]);
    expect(findClockIncidents(both(1_500))).toEqual([]);
  });

  test("the brain's clock first, the game's after: one step, the batcher's moment the game's", () => {
    const [step, ...rest] = findClockIncidents(run3({ gameMoves: [[364, 2_678]], brainMoves: [[354, 2_678]] }));
    expect(rest).toEqual([]);
    expect(step).toMatchObject({
      kind: "clockStep",
      fromMs: T0 + 707_800,
      sizeMs: 2_678,
      gameClock: { fromMs: T0 + 727_800 + 2_678, toMs: T0 + 729_800 + 2_678 },
    });
    expect(step?.detail).toMatch(/^the brain's clock \+2\.7 s between .*, the game's \+2\.7 s between /);
  });

  test("two game moves and one brain move: the step, and the game's other move alone", () => {
    const steps = findClockIncidents(
      run3({
        gameMoves: [
          [354, 2_678],
          [380, 1_000],
        ],
        brainMoves: [[364, 2_678]],
        lastRound: 400,
      }),
    );
    expect(steps.map(({ sizeMs, detail }) => [sizeMs, detail.endsWith("the brain's not seen to move")])).toEqual([
      [2_678, false],
      [1_000, true],
    ]);
  });

  test("the two clocks' moves are one step only within 5 minutes of each other", () => {
    expect(CLOCK_STEP_PAIR_WITHIN_MS).toBe(5 * MINUTE);
    // The brain's move from round 504 (1,009.8 s), 300 s after the game's ended (709.8 s): one.
    const within = findClockIncidents(run3({ brainMoves: [[505, 2_678]], lastRound: 520 }));
    expect(within.map(({ fromMs, toMs }) => [fromMs - T0, toMs - T0])).toEqual([[707_800, 1_011_800 + 2_678]]);
    // A round later, 302 s: two.
    const later = findClockIncidents(run3({ brainMoves: [[506, 2_678]], lastRound: 520 }));
    expect(later.map(({ fromMs }) => fromMs - T0)).toEqual([707_800, 1_011_800]);
  });

  test("a move of 500 ms or less isn't one; just over is", () => {
    expect(CLOCK_STEP_MIN_MS).toBe(500);
    expect(findClockIncidents(run3({ stepMs: 500 }))).toEqual([]);
    expect(findClockIncidents(run3({ stepMs: 501 }))).toHaveLength(1);
  });

  test("moves of different sizes (beyond 250 ms apart) aren't one step: the brain's alone, on, is a delivery lag", () => {
    // Within 250 ms, one step, and the 250 ms the brain's clock is left ahead is the step's, not a lag (#309).
    expect(findClockIncidents(run3({ brainMoves: [[364, 2_678 + 250]] }))).toEqual([
      expect.objectContaining({ kind: "clockStep" }),
    ]);
    expect(findDeliveryLags(run3({ brainMoves: [[364, 2_678 + 250]] }))).toEqual([]);
    // Beyond, the game's alone; the brain's, alone and on, leaves every snapshot received 251 ms after its stamp, on
    // one PC's clock: a delivery lag (#309).
    const kinds = findClockIncidents(run3({ brainMoves: [[364, 2_678 + 251]] })).map(({ kind }) => kind);
    expect(kinds).toEqual(["clockStep", "deliveryLag"]);
  });

  test("back as well as on: the clock stepped back 1 s", () => {
    const [step] = findClockIncidents(run3({ stepMs: -1_000 }));
    expect(step).toMatchObject({ kind: "clockStep", sizeMs: -1_000 });
    expect(step?.detail).toMatch(/^the game's clock −1\.0 s between .*, the brain's −1\.0 s between/);
  });

  test("the brain's clock 3 s back: the fast snapshots reordered by receipt, the medium tier sees it", () => {
    expect(findClockIncidents(run3({ gameMoves: [], brainMoves: [[364, -3_000]] }))).toEqual([
      {
        kind: "clockStep",
        fromMs: T0 + 721_800,
        toMs: T0 + 728_800,
        sizeMs: -3_000,
        detail: `the brain's clock −3.0 s between snapshots at ${at(721_800)} and ${at(728_800)}; the game's not seen to move`,
      },
    ]);
  });

  test("a medium snapshot the tier retried, the game's clock 1 s back in it: one game move, not the brain's", () => {
    const medium = [point(0), point(10_000), point(22_000, 21_000), point(32_000, 31_000), point(42_000, 41_000)];
    expect(findClockIncidents({ ...none, medium })).toEqual([
      expect.objectContaining({
        kind: "clockStep",
        sizeMs: -1_000,
        gameClock: { fromMs: T0 + 10_000, toMs: T0 + 22_000 },
      }),
    ]);
  });

  test("a clock must be long once and never short: a snapshot received late, or a burst from a busy brain, isn't", () => {
    const steps = (input: Parameters<typeof findClockIncidents>[0]) =>
      findClockIncidents(input).filter(({ kind }) => kind !== "deliveryLag");
    expect(CLOCK_STEP_STEADY_MS).toBe(250);
    // One received 1.5 s late, the next on time; or 2 s late.
    const late = [point(0), point(2_000), point(5_500, 4_000), point(6_000), point(8_000), point(10_000)];
    expect(findClockIncidents({ ...none, fast: late })).toEqual([]);
    const lateByARound = [point(0), point(2_000), point(6_000, 4_000), point(6_000), point(8_000), point(10_000)];
    expect(findClockIncidents({ ...none, fast: lateByARound })).toEqual([]);
    // Three taken 2 s apart, received together after a 5 s wait: no step, a delivery lag over 3 rounds (#309).
    const burst = [
      point(0),
      point(2_000),
      point(9_000, 4_000),
      point(9_000, 6_000),
      point(9_000, 8_000),
      point(10_000),
    ];
    expect(steps({ ...none, fast: burst })).toEqual([]);
    expect(findClockIncidents({ ...none, fast: burst })).toEqual([
      expect.objectContaining({ kind: "deliveryLag", fromMs: T0 + 9_000, toMs: T0 + 10_000, sizeMs: 5_000 }),
    ]);
    // The game's clock 300 ms short after: not held, not a step.
    const wobbly = [point(0), point(2_000), point(4_000, 6_000), point(6_000, 7_700), point(8_000, 9_700)];
    expect(findClockIncidents({ ...none, fast: wobbly })).toEqual([]);
    // 250 ms: held, a step.
    const held = [point(0), point(2_000), point(4_000, 6_000), point(6_000, 7_750), point(8_000, 9_750)];
    expect(findClockIncidents({ ...none, fast: held })).toHaveLength(1);
  });

  test("the last interval, with nothing after to show the clock held, isn't judged", () => {
    expect(findClockIncidents({ ...none, fast: [point(0), point(2_000), point(4_000, 7_000)] })).toEqual([]);
  });

  test("a fast snapshot whose worker failed (stamped at the round's start, sent at its end) is left out", () => {
    const failed = (offsetMs: number) => point(offsetMs + 2_000, offsetMs, ["fast"]);
    const fast = [point(0), point(2_000), failed(4_000), failed(6_000), point(8_000), point(10_000), point(12_000)];
    expect(findClockIncidents({ ...none, fast })).toEqual([]);
  });

  test("over a restart, or with no game time (an older store's 0), nothing", () => {
    expect(findClockIncidents({ ...run3(), restartsMs: [T0 + 708_000, T0 + 728_000] })).toEqual([]);
    const zero = [
      { atMs: T0, gameTimeMs: 0 },
      { atMs: T0 + 2_000, gameTimeMs: 0 },
      { atMs: T0 + 4_000, gameTimeMs: T0 + 4_000 },
      { atMs: T0 + 6_000, gameTimeMs: T0 + 6_000 },
    ];
    expect(findClockIncidents({ ...none, fast: zero })).toEqual([]);
    // From one with none to steady ones: the gap's jump from 0 isn't a step.
    const fromZero = [{ atMs: T0, gameTimeMs: 0 }, point(2_000), point(4_000), point(6_000)];
    expect(findClockIncidents({ ...none, fast: fromZero })).toEqual([]);
  });
});

describe("page stalls", () => {
  test("the medium snapshots 12.7 s apart on both clocks for a 10 s tick: a stall of ~2.7 s", () => {
    expect(PAGE_STALL_MEDIUM_MARGIN_MS).toBe(2_000);
    const medium = [point(691_770), point(701_770), point(714_510), point(724_510)];
    expect(findClockIncidents({ ...none, medium })).toEqual([
      {
        kind: "pageStall",
        fromMs: T0 + 701_770,
        toMs: T0 + 714_510,
        sizeMs: 2_740,
        detail: "the medium snapshots 12.7 s apart on both clocks (10 s due)",
      },
    ]);
  });

  test("a medium snapshot a round late (12 s) isn't one, just over is; nor one the tier retried", () => {
    expect(findClockIncidents({ ...none, medium: [point(0), point(12_000), point(22_000)] })).toEqual([]);
    expect(findClockIncidents({ ...none, medium: [point(0), point(12_001)] })).toHaveLength(1);
    const medium = [point(0), point(13_000)];
    expect(findClockIncidents({ ...none, medium, fast: [point(4_000, 4_000, ["medium"])] })).toEqual([]);
    expect(findClockIncidents({ ...none, medium, fast: [point(4_000, 4_000, ["slow"])] })).toHaveLength(1);
  });

  test("a fast interval of 5 s on both clocks: ~3 s; 4 s isn't one", () => {
    expect(PAGE_STALL_FAST_INTERVAL_MS).toBe(4_000);
    expect(findClockIncidents({ ...none, fast: fastWithStalls([2_000], 9_000) })).toEqual([
      {
        kind: "pageStall",
        fromMs: T0 + 2_000,
        toMs: T0 + 7_000,
        sizeMs: 3_000,
        detail: "the fast snapshots 5.0 s apart on both clocks (2 s due)",
      },
    ]);
    expect(findClockIncidents({ ...none, fast: [point(0), point(4_000)] })).toEqual([]);
  });

  test("long on one clock only is no stall", () => {
    expect(findClockIncidents({ ...none, fast: [point(0), point(9_000, 2_000)] })).toEqual([]);
    expect(findClockIncidents({ ...none, fast: [point(0), point(2_000, 9_000)] })).toEqual([]);
  });

  test("a stall with a restart in it isn't one", () => {
    const fast = [point(0), point(2_000), point(12_000), point(14_000)];
    expect(findClockIncidents({ medium: [], fast, restartsMs: [T0 + 5_000] })).toEqual([]);
    expect(findClockIncidents({ medium: [], fast, restartsMs: [T0 + 13_000] })).toHaveLength(1);
  });

  test("stalls within a minute of each other are one incident, their lengths added; further apart, two", () => {
    expect(PAGE_STALL_SAME_INCIDENT_WITHIN_MS).toBe(MINUTE);
    // The first from 2 s to 7 s; the second from 67 s, 60 s after.
    expect(findClockIncidents({ ...none, fast: fastWithStalls([2_000, 67_000], 80_000) })).toEqual([
      {
        kind: "pageStall",
        fromMs: T0 + 2_000,
        toMs: T0 + 72_000,
        sizeMs: 6_000,
        detail:
          "the fast snapshots 5.0 s apart on both clocks (2 s due); the fast snapshots 5.0 s apart on both clocks " +
          "(2 s due)",
      },
    ]);
    expect(findClockIncidents({ ...none, fast: fastWithStalls([2_000, 69_000], 80_000) })).toHaveLength(2);
  });

  test("a medium stall near a fast one is the same incident, its times within the incident's", () => {
    const medium = [point(20_000), point(33_000)];
    expect(findClockIncidents({ medium, fast: fastWithStalls([2_000], 40_000), restartsMs: [] })).toEqual([
      {
        kind: "pageStall",
        fromMs: T0 + 2_000,
        toMs: T0 + 33_000,
        sizeMs: 6_000,
        detail:
          "the fast snapshots 5.0 s apart on both clocks (2 s due); the medium snapshots 13.0 s apart on both clocks " +
          "(10 s due)",
      },
    ]);
  });

  test("a medium interval over two fast stalls adds nothing: ~6 s in all, not the medium's 6 s over again", () => {
    const fast = fastWithStalls([2_000, 9_000], 16_000);
    const medium = [point(0), point(16_000)];
    expect(findClockIncidents({ medium, fast, restartsMs: [] })).toEqual([
      {
        kind: "pageStall",
        fromMs: T0 + 2_000,
        toMs: T0 + 14_000,
        sizeMs: 6_000,
        detail:
          "the fast snapshots 5.0 s apart on both clocks (2 s due); the fast snapshots 5.0 s apart on both clocks " +
          "(2 s due); the medium snapshots 16.0 s apart on both clocks (10 s due)",
      },
    ]);
  });
});

/**
 * #309's live shape (2026-11-08, E0, on this file's clock): the Agent's rounds 2,005 ms apart (each a few ms over its
 * 2 s), each snapshot reaching the brain 20 ms after its worker's stamp, the medium 28 ms after the fast every 5th
 * round; the brain held `busyMs` of every 2,000 (the dashboard's status, polled every 2 s), anything arriving
 * meanwhile received as the hold ends. Round 15's medium snapshot is caught alone, at the hold's start (670 ms late);
 * round 20's medium too, its fast one just missing it, and from round 21 each fast one is caught 5 ms further in,
 * 668 ms late then 5 ms less a round, on time (198 ms) at round 115. `sentAfterMs`: the Agent's send stamp, so long
 * after its worker's (an older Agent's has none).
 */
function heldEveryPoll({ busyMs = 650, sentAfterMs = null as number | null } = {}) {
  const receivedAt = (arrivalMs: number) => {
    const intoHoldMs = arrivalMs % 2_000;
    return intoHoldMs < busyMs ? arrivalMs - intoHoldMs + busyMs : arrivalMs;
  };
  const fast = [];
  const medium = [];
  for (let round = 0; round < 130; round++) {
    const fastGameMs = 1_877 + 2_005 * round;
    const sent = sentAfterMs === null ? {} : { sentAtMs: T0 + fastGameMs + sentAfterMs };
    fast.push({ ...point(receivedAt(fastGameMs + 20), fastGameMs), ...sent });
    if (round % 5 === 0) medium.push(point(receivedAt(fastGameMs + 48), fastGameMs + 28));
  }
  return { fast, medium, restartsMs: [] };
}

describe("delivery lags (#309)", () => {
  const BACKLOG: DeliveryLag = {
    fromMs: T0 + 32_650,
    toMs: T0 + 232_650,
    drainedAtMs: T0 + 232_650,
    cutByRestart: false,
    lateCount: 113,
    lateMs: 670,
    backlog: true,
    pageLagMs: null,
  };

  test("the live run's shape: the brain held 0.65 s every 2 s is a backlog drained in 3 min 20 s, no clock step", () => {
    expect(DELIVERY_LAG_MIN_MS).toBe(200);
    // From round 15's medium snapshot: late again 8.7 s after its round's fast one drained it, the same lag.
    expect(findClockIncidents(heldEveryPoll())).toEqual([
      {
        kind: "deliveryLag",
        fromMs: T0 + 32_650,
        toMs: T0 + 232_650,
        sizeMs: 670,
        detail:
          "113 snapshots received late, drained in 3 min 20 s; whose, unknown (no send stamps: an Agent before #309)",
        pageLagMs: null,
      },
    ]);
    expect(findDeliveryLags(heldEveryPoll())).toEqual([BACKLOG]);
  });

  test("late again within 10 s of a drain is the same lag; later, another", () => {
    expect(DELIVERY_LAG_SAME_WITHIN_MS).toBe(10_000);
    const onTime = [4_000, 6_000, 8_000, 10_000, 12_000].map((offsetMs) => point(offsetMs));
    const lateAgainAt = (offsetMs: number) => [
      point(0),
      point(2_300, 2_000),
      ...onTime,
      point(offsetMs, offsetMs - 300),
      point(16_000),
    ];
    expect(findDeliveryLags({ ...none, fast: lateAgainAt(14_000) })).toEqual([
      expect.objectContaining({ fromMs: T0 + 2_300, drainedAtMs: T0 + 16_000, lateCount: 2, backlog: true }),
    ]);
    expect(findDeliveryLags({ ...none, fast: lateAgainAt(14_001) })).toEqual([
      expect.objectContaining({ fromMs: T0 + 2_300, drainedAtMs: T0 + 4_000, lateCount: 1, backlog: false }),
      expect.objectContaining({ fromMs: T0 + 14_001, drainedAtMs: T0 + 16_000, lateCount: 1, backlog: false }),
    ]);
  });

  test("held for under the threshold, nothing; a medium snapshot on time first doesn't drain a backlog", () => {
    expect(findDeliveryLags(heldEveryPoll({ busyMs: 180 }))).toEqual([]);
    // Held 400 ms: round 60's medium snapshot is on time (195 ms late) while the fast ones are still late, to 64.
    const lags = findDeliveryLags(heldEveryPoll({ busyMs: 400 }));
    expect(lags.map(({ lateMs, drainedAtMs }) => [lateMs, drainedAtMs])).toEqual([
      [420, T0 + 1_877 + 2_005 * 65 + 198],
    ]);
  });

  test("over 200 ms late is late, 200 isn't; late in two rounds is a backlog, in one (a round's two) brief", () => {
    const fast = (lateMs: number) => [point(0), point(2_000 + lateMs, 2_000), point(4_000), point(6_000)];
    expect(findDeliveryLags({ ...none, fast: fast(200) })).toEqual([]);
    expect(findDeliveryLags({ ...none, fast: fast(201) })).toEqual([
      expect.objectContaining({ fromMs: T0 + 2_201, drainedAtMs: T0 + 4_000, lateCount: 1, backlog: false }),
    ]);
    const twoRounds = [point(0), point(2_300, 2_000), point(4_300, 4_000), point(6_000)];
    expect(findClockIncidents({ ...none, fast: twoRounds })).toEqual([
      expect.objectContaining({ kind: "deliveryLag", fromMs: T0 + 2_300, toMs: T0 + 6_000, sizeMs: 300 }),
    ]);
    // A round's medium snapshot late alone, then with its fast one: brief.
    const mediumAlone = { fast: fast(0), medium: [point(2_330, 2_030)], restartsMs: [] };
    expect(findDeliveryLags(mediumAlone)).toEqual([expect.objectContaining({ lateCount: 1, backlog: false })]);
    const both = { fast: fast(300), medium: [point(2_330, 2_030)], restartsMs: [] };
    expect(findDeliveryLags(both)).toEqual([expect.objectContaining({ lateCount: 2, backlog: false })]);
    // The medium snapshot on time after its round's late fast one doesn't drain it: the next fast one does.
    const mediumOnTime = { fast: fast(300), medium: [point(2_350, 2_200)], restartsMs: [] };
    expect(findDeliveryLags(mediumOnTime)).toEqual([expect.objectContaining({ drainedAtMs: T0 + 4_000 })]);
  });

  test("cut by a restart, or not drained by the window's end: said so, its end the last late one's", () => {
    const late = [point(0), point(2_300, 2_000), point(4_300, 4_000), point(6_300, 6_000), point(8_000)];
    const [cut] = findClockIncidents({ medium: [], fast: late, restartsMs: [T0 + 5_000] });
    expect(cut).toMatchObject({ kind: "deliveryLag", fromMs: T0 + 2_300, toMs: T0 + 4_300 });
    expect(cut?.detail).toMatch(/^2 snapshots received late, cut by a restart before it drained; /);
    const [undrained] = findClockIncidents({ ...none, fast: late.slice(0, 4) });
    expect(undrained).toMatchObject({ kind: "deliveryLag", fromMs: T0 + 2_300, toMs: T0 + 6_300 });
    expect(undrained?.detail).toMatch(/^3 snapshots received late, not drained by the window's end; /);
  });

  test("a clock step with the brain's clock first is the step's, not a lag; the game's first leaves none either", () => {
    const brainFirst = run3({ gameMoves: [[364, 2_678]], brainMoves: [[354, 2_678]] });
    expect(findDeliveryLags(brainFirst)).toEqual([]);
    expect(findClockIncidents(brainFirst).map(({ kind }) => kind)).toEqual(["clockStep"]);
    expect(findDeliveryLags(run3())).toEqual([]);
  });

  test("the Agent's send stamps say whose: its share, and whether it could hold the page's batcher", () => {
    // Sent 1 ms after its worker's stamp: the socket's or the brain's lag, the page on time.
    const [brains] = findClockIncidents(heldEveryPoll({ sentAfterMs: 1 }));
    expect(brains).toMatchObject({ kind: "deliveryLag", pageLagMs: 1 });
    expect(brains?.detail).toBe(
      "113 snapshots received late, drained in 3 min 20 s; the Agent's share at most 0.0 s (its worker's report to " +
        "its send), the rest the socket's and the brain's",
    );
    expect(holdsThePage(brains as ClockIncident)).toBe(false);
    // The page late in sending them: its own, the page held.
    const pageLate = [0, 1, 2, 3].map((round) => ({
      ...point(2_000 * round + 620, 2_000 * round),
      sentAtMs: T0 + 2_000 * round + 600,
    }));
    const [pages] = findClockIncidents({ ...none, fast: [point(-2_000), ...pageLate] });
    expect(pages).toMatchObject({ kind: "deliveryLag", pageLagMs: 600 });
    expect(holdsThePage(pages as ClockIncident)).toBe(true);
    // Unknown (an older Agent): counted as the page's, as a page stall is.
    expect(holdsThePage(findClockIncidents(heldEveryPoll())[0] as ClockIncident)).toBe(true);
    expect(holdsThePage({ kind: "pageStall", fromMs: 0, toMs: 1, sizeMs: 1, detail: "" })).toBe(true);
    expect(holdsThePage(findClockIncidents(run3())[0] as ClockIncident)).toBe(false);
  });

  test("described for the batcher's lines", () => {
    expect(describeIncident(findClockIncidents(heldEveryPoll())[0] as ClockIncident)).toBe(
      `a delivery lag of up to 0.7 s from ${at(32_650)} to ${at(232_650)}`,
    );
  });
});

describe("section 4's lines, and too many in an hour", () => {
  const stall = (offsetMs: number): ClockIncident => ({
    kind: "pageStall",
    fromMs: T0 + offsetMs,
    toMs: T0 + offsetMs + 5_000,
    sizeMs: 3_000,
    detail: "the fast snapshots 5.0 s apart on both clocks (2 s due)",
  });
  const step = findClockIncidents(run3())[0] as ClockIncident;

  test("each incident, what it is and when; none says so; two in an hour aren't a failure", () => {
    const failures: string[] = [];
    expect(incidentLines([step, stall(40 * MINUTE)], failures)).toEqual([
      "  clock steps, page stalls and delivery lags (#241: one clock's interval between snapshots off the other's by " +
        "more than 0.5 s, long that once; or the snapshots later than due on both clocks, the medium by more than " +
        "2.0 s, the fast more than 4.0 s apart; #309: or snapshots received over 0.2 s after the page stamped them, " +
        "one PC's clock, in more than one round; 3 or more within an hour fail):",
      `    clock step +2.7 s from ${at(707_800)} to ${at(732_478)}: the game's clock +2.7 s between snapshots at ` +
        `${at(707_800)} and ${at(709_800)}, the brain's +2.7 s between ${at(727_800)} and ${at(732_478)}`,
      `    page stalled ~3.0 s from ${at(40 * MINUTE)} to ${at(40 * MINUTE + 5_000)} (cause unknown): the fast ` +
        "snapshots 5.0 s apart on both clocks (2 s due)",
    ]);
    expect(failures).toEqual([]);
    expect(incidentLines([], failures).at(-1)).toBe("    none");
  });

  test("a delivery lag (#309), not a clock step; the brief ones counted on a line of their own, the worst named", () => {
    const failures: string[] = [];
    const [backlog] = findClockIncidents(heldEveryPoll());
    // The brain held 0.6 s once a minute (the dashboard's poll in a hidden tab), a fast snapshot caught each time.
    const minutely = [0, 1, 2].map((minute) => [
      point(minute * MINUTE),
      point(minute * MINUTE + 2_000 + 650 - 100 * minute, minute * MINUTE + 2_000),
      point(minute * MINUTE + 4_000),
    ]);
    const brief = findDeliveryLags({ ...none, fast: minutely.flat() });
    expect(brief.map(({ backlog }) => backlog)).toEqual([false, false, false]);
    expect(incidentLines([backlog as ClockIncident], failures, brief).slice(1)).toEqual([
      `    delivery lag up to 0.7 s from ${at(32_650)} to ${at(232_650)} (not a clock step): 113 snapshots received ` +
        "late, drained in 3 min 20 s; whose, unknown (no send stamps: an Agent before #309)",
      `    brief delivery lags (a round's snapshots late once, not counted): 3, the worst 0.7 s at ${at(2_650)}`,
    ]);
    expect(incidentLines([], failures, brief).slice(1)).toEqual([
      "    none",
      `    brief delivery lags (a round's snapshots late once, not counted): 3, the worst 0.7 s at ${at(2_650)}`,
    ]);
    expect(failures).toEqual([]);
  });

  test("3 within an hour fail, once a stretch; the third an hour after the first doesn't count", () => {
    expect(TOO_MANY_INCIDENTS).toBe(3);
    expect(TOO_MANY_INCIDENTS_WITHIN_MS).toBe(60 * MINUTE);
    const failures: string[] = [];
    const lines = incidentLines([step, stall(30 * MINUTE), stall(60 * MINUTE - 1), stall(70 * MINUTE)], failures);
    const failure =
      `clock steps, page stalls or delivery lags: 4 from ${at(707_800)} to ${at(70 * MINUTE + 5_000)}, 3 or more ` +
      "within an hour (1 clock step, 3 page stalls)";
    expect(failures).toEqual([failure]);
    expect(lines.at(-1)).toBe(`    ${failure}`);
    const boundary: string[] = [];
    incidentLines([stall(0), stall(30 * MINUTE), stall(60 * MINUTE)], boundary);
    expect(boundary).toEqual([]);
    // Delivery lags count (#309), named.
    const lagged: string[] = [];
    const [backlog] = findClockIncidents(heldEveryPoll());
    incidentLines([stall(0), backlog as ClockIncident, stall(10 * MINUTE)], lagged);
    expect(lagged).toEqual([expect.stringMatching(/ 3 or more within an hour \(2 page stalls, 1 delivery lag\)$/)]);
    const twice: string[] = [];
    const hour = (offsetMs: number) => [stall(offsetMs), stall(offsetMs + 1), stall(offsetMs + 2)];
    incidentLines([...hour(0), ...hour(3 * 60 * MINUTE)], twice);
    expect(twice).toHaveLength(2);
  });
});

describe("a weaken's time, for the attribution", () => {
  const player = (hacking: number) => ({
    skills: { hacking, intelligence: 0 },
    mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
  });
  const theHub = { servers: [staticServer("the-hub", { requiredHackingSkill: 300, minDifficulty: 20 })] };

  test("on the target at its minimum security, for the player in the newest medium snapshot by then", () => {
    const times = new WeakenTimes();
    times.addStatic(T0, theHub);
    times.addMedium(T0, { player: player(600) } as never);
    times.addMedium(T0 + 10 * MINUTE, { player: player(950) } as never);
    // The game's: 4 hack times (Hacking.ts:89-93), a hack 5 x (2.5 x 300 x 20 + 500) / (600 + 50) s.
    expect(times.weakenMs("the-hub", T0 + 5 * MINUTE)).toBeCloseTo(4 * 5 * (15_500 / 650) * 1000, 6);
    expect(times.weakenMs("the-hub", T0 + 11 * MINUTE)).toBeCloseTo(4 * 5 * (15_500 / 1000) * 1000, 6);
    // Before the first medium snapshot, the first's.
    expect(times.weakenMs("the-hub", T0 - MINUTE)).toBeCloseTo(4 * 5 * (15_500 / 650) * 1000, 6);
  });

  test("unknown without the target's figures or the player's: never a guess", () => {
    const times = new WeakenTimes();
    expect(times.weakenMs("the-hub", T0)).toBeNull();
    times.addStatic(T0, theHub);
    expect(times.weakenMs("the-hub", T0)).toBeNull();
    // An older medium snapshot, without the player's multipliers.
    times.addMedium(T0, { player: { skills: { hacking: 600 } } } as never);
    expect(times.weakenMs("the-hub", T0)).toBeNull();
    times.addMedium(T0, { player: player(600) } as never);
    expect(times.weakenMs("n00dles", T0)).toBeNull();
    expect(times.weakenMs("the-hub", T0)).not.toBeNull();
  });

  test("an install's new static snapshot rolls the figures again: the newest by then counts", () => {
    const times = new WeakenTimes();
    times.addStatic(T0, theHub);
    times.addStatic(T0 + 30 * MINUTE, {
      servers: [staticServer("the-hub", { requiredHackingSkill: 300, minDifficulty: 30 })],
    });
    times.addMedium(T0, { player: player(600) } as never);
    expect(times.weakenMs("the-hub", T0 + MINUTE)).toBeCloseTo(4 * 5 * (15_500 / 650) * 1000, 6);
    expect(times.weakenMs("the-hub", T0 + 31 * MINUTE)).toBeCloseTo(4 * 5 * (23_000 / 650) * 1000, 6);
  });
});
