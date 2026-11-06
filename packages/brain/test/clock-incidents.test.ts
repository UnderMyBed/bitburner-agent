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
  findClockIncidents,
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

/**
 * Run #3's rounds, every 2 s (round k at 1.8 + 2k s, true time) from round 330 to `lastRound`: the game's clock
 * `stepMs` on from round `gameStepAt` (354: between 11:47.8 and 11:49.8), the brain's from `brainStepAt` (364: between
 * 12:07.8 and 12:09.8), null for never; a medium snapshot every 5th round.
 */
function run3({
  gameStepAt = 354 as number | null,
  brainStepAt = 364 as number | null,
  stepMs = 2_678,
  brainStepMs = null as number | null,
  lastRound = 400,
} = {}) {
  const fast = [];
  const medium = [];
  for (let round = 330; round <= lastRound; round++) {
    const trueMs = 1_800 + 2_000 * round;
    const game = trueMs + (gameStepAt !== null && round >= gameStepAt ? stepMs : 0);
    const received = trueMs + (brainStepAt !== null && round >= brainStepAt ? (brainStepMs ?? stepMs) : 0);
    fast.push(point(received, game));
    if (round % 5 === 0) medium.push(point(received, game));
  }
  return { fast, medium, restartsMs: [] };
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
  test("run #3: the game's clock and the brain's each 2.7 s on, 20 s apart, in both tiers: one clock step", () => {
    expect(findClockIncidents(run3())).toEqual([
      {
        kind: "clockStep",
        fromMs: T0 + 707_800,
        toMs: T0 + 732_478,
        sizeMs: 2_678,
        detail:
          `the game's clock +2.7 s between snapshots at ${at(707_800)} and ${at(709_800)}, the brain's +2.7 s ` +
          `between ${at(727_800)} and ${at(732_478)}`,
      },
    ]);
  });

  test("the brain's clock never seen to move (the window ends, say): the game's alone is a clock step", () => {
    expect(findClockIncidents(run3({ brainStepAt: null }))).toEqual([
      {
        kind: "clockStep",
        fromMs: T0 + 707_800,
        toMs: T0 + 709_800,
        sizeMs: 2_678,
        detail:
          `the game's clock +2.7 s between snapshots at ${at(707_800)} and ${at(709_800)}; the brain's not seen to ` +
          "move",
      },
    ]);
  });

  test("the two clocks' moves are one step only within 5 minutes of each other", () => {
    expect(CLOCK_STEP_PAIR_WITHIN_MS).toBe(5 * MINUTE);
    // The brain's move from round 504 (1,009.8 s), 300 s after the game's ended (709.8 s): one.
    const within = findClockIncidents(run3({ brainStepAt: 505, lastRound: 520 }));
    expect(within.map(({ fromMs, toMs }) => [fromMs - T0, toMs - T0])).toEqual([[707_800, 1_011_800 + 2_678]]);
    // A round later, 302 s: two.
    const later = findClockIncidents(run3({ brainStepAt: 506, lastRound: 520 }));
    expect(later.map(({ fromMs }) => fromMs - T0)).toEqual([707_800, 1_011_800]);
  });

  test("a move of 500 ms or less isn't one; just over is", () => {
    expect(CLOCK_STEP_MIN_MS).toBe(500);
    expect(findClockIncidents(run3({ stepMs: 500 }))).toEqual([]);
    expect(findClockIncidents(run3({ stepMs: 501 }))).toHaveLength(1);
  });

  test("moves of different sizes (beyond 250 ms apart) are two steps, not one", () => {
    expect(findClockIncidents(run3({ brainStepMs: 2_678 + 250 }))).toHaveLength(1);
    expect(findClockIncidents(run3({ brainStepMs: 2_678 + 251 }))).toHaveLength(2);
  });

  test("back as well as on: the clock stepped back 1 s", () => {
    const [step] = findClockIncidents(run3({ stepMs: -1_000 }));
    expect(step).toMatchObject({ kind: "clockStep", sizeMs: -1_000 });
    expect(step?.detail).toMatch(/^the game's clock −1\.0 s between .*, the brain's −1\.0 s between/);
  });

  test("the offset must hold before and after: a snapshot received late, or a burst from a busy brain, isn't", () => {
    expect(CLOCK_STEP_STEADY_MS).toBe(250);
    // One received 1.5 s late, the next on time.
    const late = [point(0), point(2_000), point(5_500, 4_000), point(6_000), point(8_000), point(10_000)];
    expect(findClockIncidents({ ...none, fast: late })).toEqual([]);
    // Three taken 2 s apart, received together after a 5 s wait.
    const burst = [
      point(0),
      point(2_000),
      point(9_000, 4_000),
      point(9_000, 6_000),
      point(9_000, 8_000),
      point(10_000),
    ];
    expect(findClockIncidents({ ...none, fast: burst })).toEqual([]);
    // The offset 300 ms off after: not held, not a step.
    const wobbly = [point(0), point(2_000), point(4_000, 6_000), point(6_000, 7_700), point(8_000, 9_700)];
    expect(findClockIncidents({ ...none, fast: wobbly })).toEqual([]);
    // 250 ms: held, a step.
    const held = [point(0), point(2_000), point(4_000, 6_000), point(6_000, 7_750), point(8_000, 9_750)];
    expect(findClockIncidents({ ...none, fast: held })).toHaveLength(1);
    // Moving 300 ms the interval before: not held before.
    const before = [point(0), point(2_000, 2_300), point(4_000, 6_300), point(6_000, 8_300)];
    expect(findClockIncidents({ ...none, fast: before })).toEqual([]);
  });

  test("the last interval, with nothing after to show the offset held, isn't judged", () => {
    expect(findClockIncidents({ ...none, fast: [point(0), point(2_000), point(4_000, 7_000)] })).toEqual([]);
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
      "  clock steps and page stalls (#241: the gap between the game's clock and the brain's moving more than 0.5 s " +
        "and holding; or the snapshots further apart on both clocks than due, the medium by more than 2.0 s, the " +
        "fast by more than 4.0 s; 3 or more within an hour fail):",
      `    clock step +2.7 s from ${at(707_800)} to ${at(732_478)}: the game's clock +2.7 s between snapshots at ` +
        `${at(707_800)} and ${at(709_800)}, the brain's +2.7 s between ${at(727_800)} and ${at(732_478)}`,
      `    page stalled ~3.0 s from ${at(40 * MINUTE)} to ${at(40 * MINUTE + 5_000)} (cause unknown): the fast ` +
        "snapshots 5.0 s apart on both clocks (2 s due)",
    ]);
    expect(failures).toEqual([]);
    expect(incidentLines([], failures).at(-1)).toBe("    none");
  });

  test("3 within an hour fail, once a stretch; the third an hour after the first doesn't count", () => {
    expect(TOO_MANY_INCIDENTS).toBe(3);
    expect(TOO_MANY_INCIDENTS_WITHIN_MS).toBe(60 * MINUTE);
    const failures: string[] = [];
    const lines = incidentLines([step, stall(30 * MINUTE), stall(60 * MINUTE - 1), stall(70 * MINUTE)], failures);
    const failure =
      `clock steps or page stalls: 4 from ${at(707_800)} to ${at(70 * MINUTE + 5_000)}, 3 or more within an hour (1 ` +
      "clock step, 3 page stalls)";
    expect(failures).toEqual([failure]);
    expect(lines.at(-1)).toBe(`    ${failure}`);
    const boundary: string[] = [];
    incidentLines([stall(0), stall(30 * MINUTE), stall(60 * MINUTE)], boundary);
    expect(boundary).toEqual([]);
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
