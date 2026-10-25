import { aggregate, type Checkpoint, type GameSummary, type SeedResult } from "@bitburner-agent/sim";
import { describe, expect, test } from "vitest";
import { baselineRows, formatHeaps, formatMoney, formatSeeds } from "../src/report.ts";

const HOUR = 60 * 60 * 1000;

function summary(fields: Partial<GameSummary>): GameSummary {
  return { money: 0, hackingLevel: 1, augsInstalled: 0, homeRamMax: 32, ...fields } as GameSummary;
}
const checkpoint = (hours: number, fields: Partial<GameSummary>, heapMb?: number): Checkpoint => ({
  virtualMs: hours * HOUR,
  summary: summary(fields),
  ...(heapMb === undefined ? {} : { heapMb }),
});

function seed(seedNumber: number, fields: Partial<SeedResult>): SeedResult {
  return {
    seed: seedNumber,
    ok: true,
    stoppedBy: null,
    passed: true,
    uncaught: 0,
    virtualMs: 12 * HOUR,
    wallMs: 0,
    speed: 0,
    checkpoints: [],
    events: [],
    ...fields,
  };
}

describe("formatting", () => {
  test.each([
    [0, "$0"],
    [999, "$999"],
    [1234, "$1.23k"],
    [2.5e9, "$2.5b"],
    [7.25e10, "$72.5b"],
    [8.08e11, "$808b"],
    [5.21e12, "$5.21t"],
    [3e18, "$3000q"],
    // Rounding up to 1000 moves to the next unit.
    [999_500, "$1m"],
    [999_499, "$999k"],
    [999_999_999, "$1b"],
    // The sign goes before the "$", as the game shows it.
    [-1234, "-$1.23k"],
  ])("money %s reads %s", (money, text) => {
    expect(formatMoney(money)).toBe(text);
  });

  test.each([
    [[1, 2, 3, 4, 5, 6, 7, 8], "1..8"],
    [[3, 1, 2], "1..3"],
    [[1, 3, 5], "1,3,5"],
    [[4], "4"],
  ])("seeds %j are written as --seeds takes them: %s", (seeds, text) => {
    expect(formatSeeds(seeds)).toBe(text);
  });

  test("the heap table shows each seed's heap at the start and at each checkpoint, '-' where there's none", () => {
    const measured = seed(1, {
      heapStartMb: 100,
      checkpoints: [checkpoint(4, {}, 110), checkpoint(8, {}, 112), checkpoint(12, {}, 115)],
    });
    const lines = formatHeaps({ scenario: "s", results: [measured, seed(2, {})], aggregate: aggregate([]) }).split(
      "\n",
    );
    expect(lines[0]?.trim().split(/\s{2,}/)).toEqual(["seed", "heap at start", "at 4 h", "at 8 h", "at 12 h"]);
    expect(lines[1]?.trim().split(/\s{2,}/)).toEqual(["1", "100.0 MB", "110.0 MB", "112.0 MB", "115.0 MB"]);
    expect(lines[2]?.trim().split(/\s{2,}/)).toEqual(["2", "-", "-", "-", "-"]);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });
});

describe("the release rows", () => {
  const meta = { date: "2026-10-25", commit: "abc1234", rig: "rig-16c-62g", node: "v24.22.1" };

  test("one row per checkpoint: seeds that reached it, median money and hacking with ranges, medians of the rest", () => {
    const results = [
      seed(1, {
        wallMs: 8 * 60_000,
        speed: 100,
        checkpoints: [
          checkpoint(4, { money: 1e9, hackingLevel: 200, augsInstalled: 6, homeRamMax: 128 }, 110),
          checkpoint(8, { money: 3e9, hackingLevel: 300, augsInstalled: 10, homeRamMax: 128 }, 112),
          checkpoint(12, { money: 5e9, hackingLevel: 400, augsInstalled: 13, homeRamMax: 512 }, 114),
        ],
      }),
      seed(2, {
        wallMs: 9 * 60_000,
        speed: 120,
        checkpoints: [
          checkpoint(4, { money: 2e9, hackingLevel: 220, augsInstalled: 6, homeRamMax: 128 }, 111),
          checkpoint(8, { money: 4e9, hackingLevel: 320, augsInstalled: 13, homeRamMax: 512 }, 113),
          checkpoint(12, { money: 6e9, hackingLevel: 410, augsInstalled: 20, homeRamMax: 2048 }, 116),
        ],
      }),
      // Stopped by its wall limit after 4 hours: its checkpoint counts, its real time and speed don't.
      seed(3, {
        ok: false,
        passed: false,
        error: "wall limit: 2 min",
        virtualMs: 5 * HOUR,
        wallMs: 2 * 60_000,
        speed: 300,
        checkpoints: [checkpoint(4, { money: 9e9, hackingLevel: 250, augsInstalled: 6, homeRamMax: 32 }, 120)],
      }),
      // Failed early: it reached no checkpoint, and its real time and speed don't count either.
      seed(4, { ok: false, passed: false, wallMs: 1 * 60_000, speed: 400 }),
      seed(5, {
        wallMs: 10 * 60_000,
        speed: 110,
        checkpoints: [
          checkpoint(4, { money: 1.5e9, hackingLevel: 210, augsInstalled: 5, homeRamMax: 64 }, 105),
          checkpoint(8, { money: 2e9, hackingLevel: 280, augsInstalled: 8, homeRamMax: 64 }, 109),
          checkpoint(12, { money: 7e9, hackingLevel: 450, augsInstalled: 25, homeRamMax: 4096 }, 118),
        ],
      }),
    ];
    const rows = baselineRows({ scenario: "s", results, aggregate: aggregate(results) }, meta);
    const prefix = "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 1..5 |";
    expect(rows).toEqual([
      `${prefix} 4 h | 4/5 | $1.5b ($1b–$9b) | 210 (200–250) | 6 | 64 GB | 110 MB | 110x | 9 min |`,
      `${prefix} 8 h | 3/5 | $3b ($2b–$4b) | 300 (280–320) | 10 | 128 GB | 112 MB | 110x | 9 min |`,
      `${prefix} 12 h | 3/5 | $6b ($5b–$7b) | 410 (400–450) | 20 | 2048 GB | 116 MB | 110x | 9 min |`,
    ]);
  });

  test("with no seed reaching a checkpoint, its columns read '-'", () => {
    const results = [seed(1, { ok: false, passed: false })];
    const rows = baselineRows({ scenario: "s", results, aggregate: aggregate(results) }, meta);
    expect(rows[0]).toBe(
      "| 2026-10-25 | abc1234 | rig-16c-62g | v24.22.1 | 1 | 4 h | 0/1 | - | - | - | - | - | - | - |",
    );
  });
});
