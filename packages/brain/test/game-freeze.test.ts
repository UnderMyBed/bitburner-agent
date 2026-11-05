// Game freezes (#241): found in the snapshots' game time, each shown in the run report's section 4, three in an hour a
// failure ("game freezing"), and the weaken time a batcher's desyncs are attributed to one within. Synthetic times,
// shaped on run #3 (2026-11-05): the medium snapshots' game time 12.7 s apart for a 10 s tick, a 5 s fast interval.
import { describe, expect, test } from "vitest";
import {
  findGameFreezes,
  freezeLines,
  GAME_FREEZE_FAST_INTERVAL_MS,
  GAME_FREEZE_MEDIUM_MARGIN_MS,
  GAME_FREEZING_COUNT,
  GAME_FREEZING_WITHIN_MS,
  WeakenTimes,
} from "../src/game-freeze.ts";
import { staticServer } from "./helpers/snapshot-fixtures.ts";

const T0 = Date.parse("2026-11-05T17:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
/** A snapshot received when its game time says (the brain and the game on one machine). */
const point = (offsetMs: number, degradedTiers: string[] = []) => ({
  atMs: T0 + offsetMs,
  gameTimeMs: T0 + offsetMs,
  degradedTiers,
});
/** Snapshots every `stepMs` from `fromMs` to `toMs`. */
const every = (stepMs: number, fromMs: number, toMs: number) => {
  const points = [];
  for (let offsetMs = fromMs; offsetMs <= toMs; offsetMs += stepMs) points.push(point(offsetMs));
  return points;
};

describe("finding game freezes", () => {
  test("the medium snapshots' game time 12.7 s apart for a 10 s tick: a freeze of ~2.7 s between them", () => {
    const medium = [point(691_770), point(701_770), point(714_510), point(724_510)];
    expect(findGameFreezes({ medium, fast: [], restartsMs: [] })).toEqual([
      {
        fromMs: T0 + 701_770,
        toMs: T0 + 714_510,
        lengthMs: 2_740,
        evidence: ["the medium snapshots' game time 12.7 s apart (10 s due)"],
      },
    ]);
  });

  test("a medium snapshot a round late (12 s) is within the margin: a tier retried, or rounds that overran", () => {
    expect(GAME_FREEZE_MEDIUM_MARGIN_MS).toBe(2_000);
    const medium = [point(0), point(12_000), point(22_000)];
    expect(findGameFreezes({ medium, fast: [], restartsMs: [] })).toEqual([]);
    // Just over it is a freeze.
    expect(findGameFreezes({ medium: [point(0), point(12_001)], fast: [], restartsMs: [] })).toHaveLength(1);
  });

  test("a medium interval over a fast snapshot that says the medium tier was degraded isn't a freeze: it was retried", () => {
    const medium = [point(0), point(13_000)];
    const fast = [point(2_000), point(4_000, ["medium"]), point(6_000)];
    expect(findGameFreezes({ medium, fast, restartsMs: [] })).toEqual([]);
    // Another tier degraded says nothing of the medium's.
    expect(findGameFreezes({ medium, fast: [point(4_000, ["slow"])], restartsMs: [] })).toHaveLength(1);
  });

  test("a fast snapshot interval of 5 s for a 2 s tick: a freeze of ~3 s; 4 s exactly isn't one", () => {
    expect(GAME_FREEZE_FAST_INTERVAL_MS).toBe(4_000);
    const fast = [...every(2_000, 720_510, 726_510), ...every(2_000, 731_510, 735_510)];
    expect(findGameFreezes({ medium: [], fast, restartsMs: [] })).toEqual([
      {
        fromMs: T0 + 726_510,
        toMs: T0 + 731_510,
        lengthMs: 3_000,
        evidence: ["the fast snapshots' game time 5.0 s apart (2 s due)"],
      },
    ]);
    expect(findGameFreezes({ medium: [], fast: [point(0), point(4_000)], restartsMs: [] })).toEqual([]);
  });

  test("a slow round spread over a medium tick, with no fast interval over 4 s, is a freeze all the same", () => {
    // Run #3's first: five rounds of about 2.5 s.
    const fast = [point(701_770), point(704_318), point(706_866), point(709_414), point(711_962), point(714_510)];
    const medium = [point(701_770), point(714_510)];
    const freezes = findGameFreezes({ medium, fast, restartsMs: [] });
    expect(freezes.map(({ fromMs, toMs }) => [fromMs - T0, toMs - T0])).toEqual([[701_770, 714_510]]);
  });

  test("a freeze seen by both tiers is one freeze: within both intervals, the longer of the two lengths", () => {
    const medium = [point(724_510), point(737_510)];
    const fast = [point(724_510), point(726_510), point(731_510), point(733_510)];
    expect(findGameFreezes({ medium, fast, restartsMs: [] })).toEqual([
      {
        fromMs: T0 + 726_510,
        toMs: T0 + 731_510,
        lengthMs: 3_000,
        evidence: [
          "the medium snapshots' game time 13.0 s apart (10 s due)",
          "the fast snapshots' game time 5.0 s apart (2 s due)",
        ],
      },
    ]);
  });

  test("a silence with a restart in it (the Agent reconnecting, the brain restarting) isn't a freeze", () => {
    const fast = [point(0), point(2_000), point(12_000), point(14_000)];
    const medium = [point(0), point(20_000)];
    expect(findGameFreezes({ medium, fast, restartsMs: [T0 + 5_000] })).toEqual([]);
    // One outside it doesn't explain it.
    expect(findGameFreezes({ medium: [], fast, restartsMs: [T0 + 13_000] })).toHaveLength(1);
  });

  test("both clocks must say so: the game's clock stepping, or the brain receiving late, isn't a game freeze", () => {
    // The game's clock stepped a minute on, the snapshots arriving every 2 s.
    const stepped = [
      point(0),
      { atMs: T0 + 2_000, gameTimeMs: T0 + 62_000 },
      { atMs: T0 + 4_000, gameTimeMs: T0 + 64_000 },
    ];
    expect(findGameFreezes({ medium: [], fast: stepped, restartsMs: [] })).toEqual([]);
    // Received 9 s apart (the brain busy), taken 2 s apart.
    const late = [point(0), { atMs: T0 + 9_000, gameTimeMs: T0 + 2_000 }];
    expect(findGameFreezes({ medium: [], fast: late, restartsMs: [] })).toEqual([]);
    // The game's clock going back: nothing.
    const back = [point(0), { atMs: T0 + 9_000, gameTimeMs: T0 - 1 }];
    expect(findGameFreezes({ medium: [], fast: back, restartsMs: [] })).toEqual([]);
    // An older store's snapshots with no game time (0): nothing.
    const none = [
      { atMs: T0, gameTimeMs: 0 },
      { atMs: T0 + 9_000, gameTimeMs: 0 },
    ];
    expect(findGameFreezes({ medium: none, fast: none, restartsMs: [] })).toEqual([]);
    // Nor from one with none to one with it: the brain's receipt alone can't tell a freeze.
    const from0 = [
      { atMs: T0, gameTimeMs: 0 },
      { atMs: T0 + 9_000, gameTimeMs: T0 + 9_000 },
    ];
    expect(findGameFreezes({ medium: [], fast: from0, restartsMs: [] })).toEqual([]);
  });
});

describe("section 4's lines, and game freezing", () => {
  const freeze = (offsetMs: number, lengthMs = 3_000) => ({
    fromMs: T0 + offsetMs,
    toMs: T0 + offsetMs + 2_000 + lengthMs,
    lengthMs,
    evidence: [`the fast snapshots' game time ${(2 + lengthMs / 1000).toFixed(1)} s apart (2 s due)`],
  });

  test("each freeze with its length and times; none says so; one or two in an hour aren't a failure", () => {
    const failures: string[] = [];
    const lines = freezeLines([freeze(10 * MINUTE), freeze(40 * MINUTE, 2_740)], failures);
    expect(lines).toEqual([
      "  game freezes (#241: the game's time between medium snapshots over 10 s by more than 2.0 s, or between fast " +
        'snapshots over 4.0 s; 3 or more within an hour are "game freezing"):',
      `    ~3.0 s from ${at(10 * MINUTE)} to ${at(10 * MINUTE + 5_000)}: the fast snapshots' game time 5.0 s apart ` +
        "(2 s due)",
      `    ~2.7 s from ${at(40 * MINUTE)} to ${at(40 * MINUTE + 4_740)}: the fast snapshots' game time 4.7 s apart ` +
        "(2 s due)",
    ]);
    expect(failures).toEqual([]);
    expect(freezeLines([], failures).at(-1)).toBe("    none");
  });

  test("3 within an hour fail as game freezing, once for the stretch; 3 spread over more than an hour don't", () => {
    expect(GAME_FREEZING_COUNT).toBe(3);
    expect(GAME_FREEZING_WITHIN_MS).toBe(60 * MINUTE);
    const failures: string[] = [];
    const lines = freezeLines([freeze(0), freeze(30 * MINUTE), freeze(59 * MINUTE), freeze(70 * MINUTE)], failures);
    const failure =
      `game freezing: 4 game freezes from ${at(0)} to ${at(70 * MINUTE + 5_000)}, ${GAME_FREEZING_COUNT} or more ` +
      "within an hour (the longest ~3.0 s)";
    expect(failures).toEqual([failure]);
    expect(lines.at(-1)).toBe(`    ${failure}`);
    const spread: string[] = [];
    freezeLines([freeze(0), freeze(31 * MINUTE), freeze(61 * MINUTE)], spread);
    expect(spread).toEqual([]);
    // Two stretches an hour and more apart: one failure each.
    const twice: string[] = [];
    freezeLines(
      [
        freeze(0),
        freeze(1),
        freeze(2),
        freeze(3 * 60 * MINUTE),
        freeze(3 * 60 * MINUTE + 1),
        freeze(3 * 60 * MINUTE + 2),
      ],
      twice,
    );
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
