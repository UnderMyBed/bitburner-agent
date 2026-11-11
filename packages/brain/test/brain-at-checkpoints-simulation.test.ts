// The brain at the fork's baseline checkpoints (#319, Q10 #83; architecture §13, ADR 0011), in the simulator: the
// brain's rules as on Steam, through the simulator's own effectors (not the Singularity workers SF4.3 would give it on
// Steam), from exactly the baseline's start (`baselineScenario()`'s fixture: BN1 with SF1.1 and SF4.3, which the game
// makes BN1.2, 32 GB home), read at 4, 8 and 12 virtual hours (`CHECKPOINTS_MS`) as the baseline reads the fork, then
// on to a destroy or a cap. Each seed is compared with the fork's same seed (`FORK_AT_CHECKPOINTS`) under owner
// decision 65's gate.
// - CI, seed 1: the runner to 1 virtual hour, read at 20, 40 and 60 minutes: each checkpoint is the game's own summary
//   at the first poll at or past it, with the peak hacking level so far, and the rows print it.
// - The run, `BRAIN_CHECKPOINTS=1`: each of `BRAIN_CHECKPOINTS_SEEDS` (seed 1 unless given; `a..b` or `a,b,c`) from the
//   start to a destroy or `BRAIN_CHECKPOINTS_HOURS` virtual hours (16 unless given, 12 to 48). `BRAIN_CHECKPOINTS_OUT`
//   names a folder (made if need be): each seed's progress lines go to `seed-<n>.log` and its result to
//   `seed-<n>.json`, rewritten at each checkpoint and every 10 virtual minutes (`partial` until it ends), so a run
//   stopped from outside keeps what it reached. Then it prints the rows for docs/sim/baselines.md, each seed against
//   the fork's and the destroys, over every `seed-*.json` in the folder, and writes them to `table.md` there. Heavy:
//   one seed a run, under an external real-time kill (the brain README's section says how); Vitest's own 48 h timeout
//   kills nothing.
// - The table alone, `BRAIN_CHECKPOINTS_TABLE=<folder>`: the same print over a folder's results, nothing run.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baselineScenario, CHECKPOINTS_MS } from "@bitburner-agent/legacy";
import { commitId, type GameSummary, parseSeeds, REPO_ROOT, rigId } from "@bitburner-agent/sim";
import { describe, expect, test } from "vitest";
import {
  type CheckpointGame,
  type CheckpointRecord,
  checkpointRows,
  compareWithFork,
  FORK_AT_CHECKPOINTS,
  type ForkReading,
  formatComparison,
  formatDestroys,
  peaksFromLog,
  type Reading,
  type RowMeta,
  runToCheckpoints,
  type SeedCheckpoints,
} from "./helpers/checkpoints.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Seeds as the baseline's `--seeds` takes them (`a..b` or `a,b,c`, distinct); seed 1 when unset. Else it throws. */
export function seedsOf(text: string | undefined): number[] {
  if (text === undefined) return [1];
  try {
    return parseSeeds(text.replace(/\s+/g, ""));
  } catch {
    throw new Error(`BRAIN_CHECKPOINTS_SEEDS is ${JSON.stringify(text)}: give a..b or a,b,c, distinct`);
  }
}
/** The cap in virtual hours: 16 unless given, from the last checkpoint (12) to 48. */
export function capOf(text: string | undefined): number {
  const hours = text === undefined ? 16 : Number(text);
  if (!(hours >= (CHECKPOINTS_MS.at(-1) as number) / HOUR && hours <= 48)) {
    throw new Error(`BRAIN_CHECKPOINTS_HOURS is ${JSON.stringify(text)}: give 12 to 48`);
  }
  return hours * HOUR;
}

const STUDY = process.env.BRAIN_CHECKPOINTS === "1";
if (process.env.BRAIN_CHECKPOINTS !== undefined && !STUDY) {
  console.warn(`BRAIN_CHECKPOINTS is ${JSON.stringify(process.env.BRAIN_CHECKPOINTS)}: only "1" runs the seeds`);
}
const TABLE = process.env.BRAIN_CHECKPOINTS_TABLE;
const OUT = process.env.BRAIN_CHECKPOINTS_OUT;
const BASELINE = baselineScenario();
const freshStartOf = useFreshStarts();

/**
 * A game that runs in steps of `stepMs`, reads `place` (a destroy) from `destroyAtMs` on, and has `hackingAt`'s
 * hacking level (a minute's worth by default).
 */
function fakeGame({
  stepMs = 200,
  startMs = 0,
  destroyAtMs = Number.POSITIVE_INFINITY,
  hackingAt = (ms) => Math.floor(ms / MINUTE),
}: {
  stepMs?: number;
  startMs?: number;
  destroyAtMs?: number;
  hackingAt?: (virtualMs: number) => number;
}): CheckpointGame & { runs: number[] } {
  let virtualMs = startMs;
  const runs: number[] = [];
  return {
    runs,
    run: async (ms) => {
      runs.push(ms);
      virtualMs += Math.ceil(ms / stepMs) * stepMs;
    },
    summary: async (): Promise<GameSummary> => {
      const destroyed = virtualMs >= destroyAtMs;
      return {
        virtualMs,
        playtimeMs: virtualMs,
        bitNodeN: 1,
        bitNodeLevel: destroyed ? 3 : 2,
        sourceFiles: destroyed ? { 1: 2, 4: 3 } : { 1: 1, 4: 3 },
        money: virtualMs * 10,
        hackingLevel: hackingAt(virtualMs),
        hackingExp: 0,
        homeRamUsed: 0,
        homeRamMax: 32,
        scripts: 0,
        augsInstalled: 3 + Math.floor(virtualMs / HOUR),
        augsQueued: 0,
      };
    },
  };
}

describe("the runner", () => {
  test("each checkpoint is the first poll at or past it; polls every minute, never past the next checkpoint", async () => {
    const game = fakeGame({ stepMs: 200, startMs: 30 });
    const seen: CheckpointRecord[] = [];
    const run = await runToCheckpoints(game, {
      seed: 3,
      checkpointsMs: [150_000, 4 * MINUTE],
      capMs: 5 * MINUTE,
      onCheckpoint: (record) => seen.push(record),
    });
    expect(run.checkpoints.map((each) => [each.atMs, !each.destroyed && each.reading.virtualMs])).toEqual([
      [150_000, 150_030],
      [4 * MINUTE, 4 * MINUTE + 30],
    ]);
    expect(seen).toEqual(run.checkpoints);
    // From 30 ms: a minute, another, to the checkpoint at 2.5 minutes, a minute, to 4, then to the cap at 5; each run
    // ends on the step past it.
    expect(game.runs).toEqual([60_000, 60_000, 29_970, 60_000, 29_970, 59_970]);
    expect(run).toMatchObject({ seed: 3, destroyedAtMs: null, afterDestroy: null, capMs: 5 * MINUTE });
    expect(run.ranMs).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(run.checkpoints[0]).toEqual({
      atMs: 150_000,
      destroyed: false,
      reading: {
        virtualMs: 150_030,
        money: 1_500_300,
        hackingLevel: 2,
        augsInstalled: 3,
        homeRamMax: 32,
        bitNodeN: 1,
        bitNodeLevel: 2,
        sourceFiles: { 1: 1, 4: 3 },
      },
      peakHackingLevel: 2,
      peakFrom: "every poll",
    });
  });

  test("the peak hacking level: the highest of every poll so far, so an install's dip on a checkpoint keeps it", async () => {
    // Levels 10 a minute, an install at 3 minutes (back to 1, then 10 a minute again); the checkpoint at 3 minutes
    // falls on the dip. The peak is 20, from the poll at 2 minutes, not the dip's 1; at 6 minutes it's 31.
    const hackingAt = (ms: number) =>
      ms < 3 * MINUTE ? 10 * Math.floor(ms / MINUTE) : 1 + 10 * Math.floor((ms - 3 * MINUTE) / MINUTE);
    const run = await runToCheckpoints(fakeGame({ hackingAt }), {
      seed: 1,
      checkpointsMs: [3 * MINUTE, 6 * MINUTE],
      capMs: 6 * MINUTE,
    });
    expect(
      run.checkpoints.map((each) => !each.destroyed && [each.reading.hackingLevel, each.peakHackingLevel]),
    ).toEqual([
      [1, 20],
      [31, 31],
    ]);
  });

  test("a destroy stops the run: every checkpoint after it is destroyed, with its time and where it went", async () => {
    const run = await runToCheckpoints(fakeGame({ destroyAtMs: 5.5 * MINUTE }), {
      seed: 1,
      checkpointsMs: [2 * MINUTE, 8 * MINUTE, 10 * MINUTE],
      capMs: 20 * MINUTE,
    });
    expect(run.destroyedAtMs).toBe(6 * MINUTE);
    expect(run.ranMs).toBe(6 * MINUTE);
    expect(run.afterDestroy).toMatchObject({ bitNodeLevel: 3, sourceFiles: { 1: 2, 4: 3 } });
    expect(run.checkpoints).toEqual([
      expect.objectContaining({ atMs: 2 * MINUTE, destroyed: false }),
      { atMs: 8 * MINUTE, destroyed: true, destroyedAtMs: 6 * MINUTE },
      { atMs: 10 * MINUTE, destroyed: true, destroyedAtMs: 6 * MINUTE },
    ]);
  });

  test("a destroy on a checkpoint's own poll: the checkpoint is destroyed, never the next BitNode's reading", async () => {
    // The poll at 8 minutes is the checkpoint's and the first in BN1.3.
    const run = await runToCheckpoints(fakeGame({ destroyAtMs: 7.5 * MINUTE }), {
      seed: 1,
      checkpointsMs: [2 * MINUTE, 8 * MINUTE, 10 * MINUTE],
      capMs: 20 * MINUTE,
    });
    expect(run.checkpoints.slice(1)).toEqual([
      { atMs: 8 * MINUTE, destroyed: true, destroyedAtMs: 8 * MINUTE },
      { atMs: 10 * MINUTE, destroyed: true, destroyedAtMs: 8 * MINUTE },
    ]);
  });

  test("a start past a checkpoint takes it at once; checkpoints out of order, a cap before one, or a game that doesn't run on, fail", async () => {
    const run = await runToCheckpoints(fakeGame({ startMs: 3 * MINUTE }), {
      seed: 1,
      checkpointsMs: [MINUTE, 4 * MINUTE],
      capMs: 4 * MINUTE,
    });
    expect(run.checkpoints.map((each) => !each.destroyed && each.reading.virtualMs)).toEqual([3 * MINUTE, 4 * MINUTE]);
    for (const checkpointsMs of [
      [2 * MINUTE, MINUTE],
      [MINUTE, MINUTE],
    ]) {
      await expect(runToCheckpoints(fakeGame({}), { seed: 1, checkpointsMs, capMs: 3 * MINUTE })).rejects.toThrow(
        /must ascend/,
      );
    }
    await expect(
      runToCheckpoints(fakeGame({}), { seed: 1, checkpointsMs: [4 * MINUTE], capMs: 3 * MINUTE }),
    ).rejects.toThrow(/the cap/);
    // A real game's run yields to timers, so a runner without the check would spin past the test's timeout, not hang.
    const stuck: CheckpointGame = { ...fakeGame({}), run: () => new Promise((resolve) => setTimeout(resolve, 0)) };
    await expect(runToCheckpoints(stuck, { seed: 1, checkpointsMs: [MINUTE], capMs: MINUTE })).rejects.toThrow(
      /didn't run on/,
    );
  });
});

const reading = (virtualMs: number, hackingLevel: number, augsInstalled: number, homeRamMax: number): Reading => ({
  virtualMs,
  money: hackingLevel * 1e6,
  hackingLevel,
  augsInstalled,
  homeRamMax,
  bitNodeN: 1,
  bitNodeLevel: 2,
  sourceFiles: { 1: 1, 4: 3 },
});
/** A checkpoint in BN1.2 with its peak (the reading's level unless given). */
const at = (atMs: number, read: Reading, peakHackingLevel = read.hackingLevel): CheckpointRecord => ({
  atMs,
  destroyed: false,
  reading: read,
  peakHackingLevel,
  peakFrom: "every poll",
});
const CHECKS = [HOUR, 2 * HOUR];
const runOf = (
  seed: number,
  checkpoints: CheckpointRecord[],
  extra: Partial<SeedCheckpoints> = {},
): SeedCheckpoints => ({
  seed,
  checkpoints,
  destroyedAtMs: null,
  afterDestroy: null,
  capMs: 3 * HOUR,
  ranMs: 3 * HOUR,
  realMs: 30 * MINUTE,
  ...extra,
});
const RUNS = [
  runOf(1, [at(HOUR, reading(HOUR, 300, 6, 64)), at(2 * HOUR, reading(2 * HOUR, 500, 12, 1024))]),
  // At 1 h, just after an install: hacking 200 against the fork's 250, but its peak, 260, isn't behind.
  runOf(2, [
    at(HOUR, reading(HOUR, 200, 4, 128), 260),
    { atMs: 2 * HOUR, destroyed: true, destroyedAtMs: 90 * MINUTE },
  ]),
  runOf(3, [at(HOUR, reading(HOUR, 250, 5, 32)), at(2 * HOUR, reading(2 * HOUR, 400, 10, 256))]),
];
const FORK: Record<number, ForkReading[]> = {
  1: [
    { money: 1, hackingLevel: 300, augsInstalled: 6, homeRamMax: 64 },
    { money: 1, hackingLevel: 400, augsInstalled: 13, homeRamMax: 128 },
  ],
  2: [
    { money: 1, hackingLevel: 250, augsInstalled: 3, homeRamMax: 256 },
    { money: 1, hackingLevel: 9000, augsInstalled: 90, homeRamMax: 9000 },
  ],
  4: [
    { money: 1, hackingLevel: 270, augsInstalled: 3, homeRamMax: 32 },
    { money: 1, hackingLevel: 300, augsInstalled: 3, homeRamMax: 32 },
  ],
};
const META: RowMeta = { date: "2026-11-09", commit: "abc1234", rig: "rig", node: "v26.13.0" };

describe("the rows and the comparison", () => {
  test("rows in baselines.md's columns: medians and ranges over the seeds still in BN1.2, destroys named", () => {
    const rows = checkpointRows(RUNS, CHECKS, META);
    expect(rows).toEqual([
      "| 2026-11-09 | abc1234 | rig | v26.13.0 | 1..3 | 1 h | 3/3 | $250m ($200m–$300m) | 250 (200–300) | 5 | 64 GB | - | 6x | 30 min |",
      "| 2026-11-09 | abc1234 | rig | v26.13.0 | 1..3 | 2 h | 2/3, 1 destroyed before it | $400m ($400m–$500m) | 400 (400–500) | 10 | 256 GB | - | 6x | 30 min |",
    ]);
    expect(checkpointRows([], CHECKS, { date: "d", commit: "c", rig: "r", node: "n" })[0]).toBe(
      "| d | c | r | n |  | 1 h | 0/0 | - | - | - | - | - | - | - |",
    );
  });

  test("rows over the runs' own date, commit, rig and Node; a stopped seed counted where it got, and named where it didn't", () => {
    const runs = [
      runOf(1, RUNS[0]?.checkpoints ?? [], { meta: { ...META, commit: "e077960" } }),
      runOf(2, RUNS[2]?.checkpoints ?? [], { meta: { ...META, commit: "1a46031" }, realMs: 36 * MINUTE }),
      // Stopped after 1 h: counted there, named at 2 h, and its cut-short real time left out of speed and real time
      // (with it, real time's median would be 36 minutes).
      runOf(5, [at(HOUR, reading(HOUR, 9999, 99, 99999))], {
        partial: true,
        realMs: 500 * MINUTE,
        meta: { ...META, commit: "1a46031" },
      }),
    ];
    expect(checkpointRows(runs, CHECKS, { date: "today", commit: "now", rig: "here", node: "v0" })).toEqual([
      "| 2026-11-09 | e077960 + 1a46031 | rig | v26.13.0 | 1,2,5 | 1 h | 3/3 | $300m ($250m–$10b) | 300 (250–9999) | 6 | 64 GB | - | 5x | 30 min |",
      "| 2026-11-09 | e077960 + 1a46031 | rig | v26.13.0 | 1,2,5 | 2 h | 2/3, stopped before it: 5 | $400m ($400m–$500m) | 400 (400–500) | 10 | 256 GB | - | 5x | 30 min |",
    ]);
    // A run recorded before the meta was kept takes the fallback's.
    expect(checkpointRows([RUNS[0] as SeedCheckpoints], CHECKS, META)[0]).toMatch(/^\| 2026-11-09 \| abc1234 \|/);
    const text = formatComparison(runs, CHECKS, FORK);
    expect(text).toContain("| 5 (stopped) | 1 h |");
    expect(formatDestroys(runs)).toContain("seed 5 (stopped): no destroy by 3 h 00 min (cap 3 h 00 min)");
  });

  test("decision 65: augmentations and home RAM at least the fork's, the peak hacking level at least the fork's level; a destroy ahead", () => {
    const runs = [
      ...RUNS,
      runOf(4, [at(HOUR, reading(HOUR, 260, 3, 32), 269), at(2 * HOUR, reading(2 * HOUR, 300, 3, 32), 300)]),
    ];
    expect(compareWithFork(runs, CHECKS, FORK)).toEqual([
      { seed: 1, atMs: HOUR, verdict: "ahead", behind: [] },
      { seed: 1, atMs: 2 * HOUR, verdict: "behind", behind: ["augsInstalled"] },
      { seed: 2, atMs: HOUR, verdict: "behind", behind: ["homeRamMax"] },
      { seed: 2, atMs: 2 * HOUR, verdict: "destroyed", behind: [] },
      { seed: 3, atMs: HOUR, verdict: "no fork row", behind: [] },
      { seed: 3, atMs: 2 * HOUR, verdict: "no fork row", behind: [] },
      { seed: 4, atMs: HOUR, verdict: "behind", behind: ["peakHackingLevel"] },
      { seed: 4, atMs: 2 * HOUR, verdict: "ahead", behind: [] },
    ]);
    const text = formatComparison(RUNS, CHECKS, FORK);
    expect(text).toContain(
      "| 1 | 2 h | $500m, hacking 500, 12 augs, 1024 GB, peak hacking 500 | $1, hacking 400, 13 augs, 128 GB | behind on augsInstalled |",
    );
    expect(text).toContain(
      "| 2 | 1 h | $200m, hacking 200, 4 augs, 128 GB, peak hacking 260 | $1, hacking 250, 3 augs, 256 GB | behind on homeRamMax |",
    );
    expect(text).toContain("| 2 | 2 h | destroyed at 1 h 30 min | $1, hacking 9000, 90 augs, 9000 GB | destroyed |");
    expect(text).toContain("| 3 | 1 h | $250m, hacking 250, 5 augs, 32 GB, peak hacking 250 | - | no fork row |");
    // A checkpoint without its peak (a run from before the runner kept it) fails loudly until `peaksFromLog` fills it.
    const old = { ...at(HOUR, reading(HOUR, 300, 6, 64)), peakHackingLevel: undefined } as unknown as CheckpointRecord;
    expect(() => compareWithFork([runOf(1, [old])], CHECKS, FORK)).toThrow(/no peak hacking level/);
  });

  test("a run from before the peak was kept: each checkpoint's peak from its 10-minute log lines and its own reading", () => {
    const old = (atMs: number, level: number) =>
      ({ atMs, destroyed: false, reading: reading(atMs, level, 6, 64) }) as unknown as CheckpointRecord;
    const log = [
      "seed 1: start 2026-11-09T15:17:49.706Z, cap 16 h",
      "  v 32 min, real 14 s: hacking 308, money 4.42e+8, 0 augs, home 256 GB, BN1.2, 6 factions, 61052 GB rooted",
      "  v 42 min, real 37 s: hacking 1, money 1.26e+3, 3 augs, home 16384 GB, BN1.2, 0 factions, 16484 GB rooted",
      '  checkpoint {"atMs":3600000,"destroyed":false}',
      "  v 62 min, real 43 s: hacking 999, money 7.11e+7, 3 augs, home 16384 GB, BN1.2, 6 factions, 39500 GB rooted",
    ].join("\r\n");
    const destroyed: CheckpointRecord = { atMs: 3 * HOUR, destroyed: true, destroyedAtMs: 150 * MINUTE };
    const kept = at(2 * HOUR, reading(2 * HOUR, 5, 6, 64), 1500);
    const run = peaksFromLog(runOf(1, [old(HOUR, 20), kept, destroyed]), log);
    // At 1 h: the line at 32 minutes (308) beats the checkpoint's own 20, and the line at 62 minutes is after it.
    expect(run.checkpoints).toEqual([
      { ...old(HOUR, 20), peakHackingLevel: 308, peakFrom: "10-minute log lines" },
      kept,
      destroyed,
    ]);
    expect(formatComparison([run], CHECKS, FORK)).toContain("peak hacking 308 (from the 10-minute log lines)");
    expect(() => peaksFromLog(runOf(1, [old(10 * MINUTE, 20)]), log)).toThrow(/no progress line before/);
  });

  test("the fork's rows are the baseline's: their medians are 5238ab6's rows in baselines.md", () => {
    const median = (index: number, measure: keyof ForkReading) =>
      Object.values(FORK_AT_CHECKPOINTS.seeds)
        .map((seed) => (seed[index] as ForkReading)[measure])
        .sort((a, b) => a - b)[3];
    // baselines.md, 5238ab6 on v26.13.0: hacking 238, 341, 493; augmentations 6, 11, 15; home 64, 128, 2048 GB.
    expect(
      [0, 1, 2].map((i) => [median(i, "hackingLevel"), median(i, "augsInstalled"), median(i, "homeRamMax")]),
    ).toEqual([
      [238, 6, 64],
      [341, 11, 128],
      [493, 15, 2048],
    ]);
    // Their ranges too: they catch a value that changed, not one moved between seeds (min and max don't move then).
    // Which seed holds which value was checked by hand against the run's JSON (FORK_AT_CHECKPOINTS' docstring).
    const range = (index: number, measure: keyof ForkReading) => {
      const values = Object.values(FORK_AT_CHECKPOINTS.seeds).map((seed) => (seed[index] as ForkReading)[measure]);
      return [Math.min(...values), Math.max(...values)];
    };
    expect([0, 1, 2].map((i) => range(i, "hackingLevel"))).toEqual([
      [210, 279],
      [259, 374],
      [208, 662],
    ]);
    expect(Object.keys(FORK_AT_CHECKPOINTS.seeds)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  test("the knobs: seeds as --seeds takes them, or seed 1; the cap 12 to 48 hours, 16 by default; anything else fails loudly", () => {
    expect(seedsOf(undefined)).toEqual([1]);
    expect(seedsOf("1, 2,8")).toEqual([1, 2, 8]);
    expect(seedsOf("3..8")).toEqual([3, 4, 5, 6, 7, 8]);
    for (const odd of ["", "1,", "2.5", "x", "1,1", "5..3"]) {
      expect(() => seedsOf(odd)).toThrow(/BRAIN_CHECKPOINTS_SEEDS/);
    }
    expect(capOf(undefined)).toBe(16 * HOUR);
    expect(capOf("12")).toBe(12 * HOUR);
    expect(capOf("48")).toBe(48 * HOUR);
    for (const odd of ["11.9", "48.1", "x"]) expect(() => capOf(odd)).toThrow(/BRAIN_CHECKPOINTS_HOURS/);
  });
});

// Its bound (#340's review): batches on home's RAM after the install make the hour's work heavier. Seed 1 locally
// ran in 48.6 s of real time with `batcher.home` on and 28.0 s off, with 21,561 batches against 11,839, 305,039
// timers fired against 190,290, and 5.9 s of the brain's CPU against 3.6 s: in proportion to the batches. CI ran
// main's in 107 s, and the other simulator suites run 2-3 times local there (augmentations 75 s, 245 s in CI), so
// up to about 150 s now: 300 s leaves the headroom 180 s no longer did.
test("seed 1 from the baseline's start, to 1 virtual hour: each checkpoint the game's own summary, printed as a row", {
  timeout: 300_000,
}, async () => {
  const fresh = await freshStartOf({ withDesiredState: true, seed: 1, fixture: BASELINE.fixture });
  const game: CheckpointGame = { summary: () => fresh.simulation.summary(), run: (ms) => fresh.game.run(ms) };
  const checkpointsMs = [20 * MINUTE, 40 * MINUTE, HOUR];
  const levels: number[] = [];
  const run = await runToCheckpoints(game, {
    seed: 1,
    checkpointsMs,
    capMs: HOUR,
    onPoll: (each) => levels.push(each.hackingLevel),
  });
  const end = await fresh.simulation.summary();
  expect(run.destroyedAtMs).toBeNull();
  expect(run.checkpoints.map((each) => each.atMs)).toEqual(checkpointsMs);
  for (const record of run.checkpoints) {
    if (record.destroyed) throw new Error("no destroy in an hour");
    // The first poll at or past it, within the driver's step (200 ms).
    expect(record.reading.virtualMs - record.atMs).toBeGreaterThanOrEqual(0);
    expect(record.reading.virtualMs - record.atMs).toBeLessThan(200);
    // The baseline's start: BN1.2 with SF1.1 and SF4.3.
    expect(record.reading).toMatchObject({ bitNodeN: 1, bitNodeLevel: 2, sourceFiles: { 1: 1, 4: 3 } });
  }
  const last = run.checkpoints.at(-1) as Extract<CheckpointRecord, { destroyed: false }>;
  expect(last.reading).toEqual({
    virtualMs: end.virtualMs,
    money: end.money,
    hackingLevel: end.hackingLevel,
    augsInstalled: end.augsInstalled,
    homeRamMax: end.homeRamMax,
    bitNodeN: 1,
    bitNodeLevel: 2,
    sourceFiles: end.sourceFiles,
  });
  // The peak is every poll's highest, and survives an install's dip: seed 1 installs at about 37 minutes (the level
  // falls between two polls, augmentations installed; the planner's install for Daedalus's count, #343: 3 new at 35 min
  // online, installing now 5.4 h against waiting 5.5 h), and the peak is at least the highest level polled before it.
  // Whether the level at 1 h passes it is the scenario's (#340's review): 458 at 1 h with home's RAM in the batches,
  // past the 330 before the install (the count rule's install, about 40 minutes: 477 past 364).
  expect(last.peakHackingLevel).toBe(Math.max(...levels));
  expect(last.reading.augsInstalled).toBeGreaterThan(0);
  const installAt = levels.findIndex((level, index) => index > 0 && level < (levels[index - 1] as number));
  expect(installAt).toBeGreaterThan(0);
  expect(last.peakHackingLevel).toBeGreaterThanOrEqual(Math.max(...levels.slice(0, installAt)));
  // The brain played: past hacking 1, home at SF1's 32 GB or more.
  expect(last.reading.hackingLevel).toBeGreaterThan(50);
  expect(last.reading.homeRamMax).toBeGreaterThanOrEqual(32);
  const [, , row] = checkpointRows([run], checkpointsMs, { date: "d", commit: "c", rig: "r", node: "n" });
  expect(row).toContain(
    `| 1 | 1 h | 1/1 | ${row?.split(" | ")[7]} | ${last.reading.hackingLevel} (${last.reading.hackingLevel}–` +
      `${last.reading.hackingLevel}) | ${last.reading.augsInstalled} | ${last.reading.homeRamMax} GB |`,
  );
});

/**
 * Every seed's result in `folder`, by seed. A run recorded before the runner kept the peak hacking level takes it from
 * its `seed-<n>.log` (`peaksFromLog`).
 */
function resultsIn(folder: string): SeedCheckpoints[] {
  return readdirSync(folder)
    .filter((name) => /^seed-\d+\.json$/.test(name))
    .map((name) => {
      const run = JSON.parse(readFileSync(path.join(folder, name), "utf8")) as SeedCheckpoints;
      const log = path.join(folder, name.replace(/\.json$/, ".log"));
      return existsSync(log) ? peaksFromLog(run, readFileSync(log, "utf8")) : run;
    })
    .sort((a, b) => a.seed - b.seed);
}

/** This run's date, commit, rig and Node. */
const metaNow = (): RowMeta => ({
  date: new Date().toISOString().slice(0, 10),
  commit: commitId(REPO_ROOT),
  rig: rigId(),
  node: process.version,
});

/**
 * Prints the rows, the comparison and the destroys over `folder`'s results, and writes them to its `table.md`. A run
 * recorded before its meta was kept takes today's, which the print says.
 */
function printTable(folder: string) {
  const runs = resultsIn(folder);
  const unstamped = runs.filter((run) => run.meta === undefined).map((run) => run.seed);
  const text = [
    `rows for docs/sim/baselines.md:\n${checkpointRows(runs, CHECKPOINTS_MS, metaNow()).join("\n")}`,
    ...(unstamped.length > 0
      ? [`seeds without their run's date, commit, rig and Node (today's used): ${unstamped}`]
      : []),
    `each seed against the fork's (${FORK_AT_CHECKPOINTS.commit}, ${FORK_AT_CHECKPOINTS.node}), decision 65's gate:\n` +
      formatComparison(runs, CHECKPOINTS_MS),
    `destroys:\n${formatDestroys(runs)}`,
  ].join("\n\n");
  writeFileSync(path.join(folder, "table.md"), `${text}\n`);
  console.log(text);
}

test.skipIf(TABLE === undefined)("the table over a folder's results", () => printTable(TABLE as string));

test.skipIf(!STUDY).each(STUDY ? seedsOf(process.env.BRAIN_CHECKPOINTS_SEEDS) : [])(
  "the run, seed %i: from the baseline's start, read at 4, 8 and 12 virtual hours, to a destroy or the cap",
  { timeout: 48 * HOUR },
  async (seed) => {
    if (OUT === undefined) throw new Error("BRAIN_CHECKPOINTS_OUT: name a folder for the results");
    mkdirSync(OUT, { recursive: true });
    const capMs = capOf(process.env.BRAIN_CHECKPOINTS_HOURS);
    const meta = metaNow();
    const log = path.join(OUT, `seed-${seed}.log`);
    const say = (line: string) => appendFileSync(log, `${line}\n`);
    const realStart = Date.now();
    say(`seed ${seed}: start ${new Date().toISOString()}, cap ${capMs / HOUR} h, ${JSON.stringify(meta)}`);
    const fresh = await freshStartOf({ withDesiredState: true, seed, fixture: BASELINE.fixture });
    const game: CheckpointGame = { summary: () => fresh.simulation.summary(), run: (ms) => fresh.game.run(ms) };
    const checkpoints: CheckpointRecord[] = [];
    const write = (run: SeedCheckpoints) =>
      writeFileSync(path.join(OUT, `seed-${seed}.json`), `${JSON.stringify(run, null, 2)}\n`);
    const save = (ranMs: number) =>
      write({
        seed,
        checkpoints,
        destroyedAtMs: null,
        afterDestroy: null,
        capMs,
        ranMs,
        realMs: Date.now() - realStart,
        partial: true,
        meta,
      });
    let nextProgressMs = 0;
    const run = await runToCheckpoints(game, {
      seed,
      checkpointsMs: CHECKPOINTS_MS,
      capMs,
      onPoll: (reading) => {
        if (reading.virtualMs < nextProgressMs) return;
        nextProgressMs = reading.virtualMs + 10 * MINUTE;
        const medium = fresh.medium();
        const rooted = medium?.servers
          .filter((each) => each.hasAdminRights)
          .reduce((sum, each) => sum + each.maxRam, 0);
        say(
          `  v ${(reading.virtualMs / MINUTE).toFixed(0)} min, real ${((Date.now() - realStart) / 1000).toFixed(0)} s: ` +
            `hacking ${reading.hackingLevel}, money ${reading.money.toExponential(2)}, ${reading.augsInstalled} augs, ` +
            `home ${reading.homeRamMax} GB, BN${reading.bitNodeN}.${reading.bitNodeLevel}, ` +
            `${(medium?.player.factions as string[] | undefined)?.length ?? "?"} factions, ${rooted ?? "?"} GB rooted`,
        );
        save(reading.virtualMs);
      },
      onCheckpoint: (record) => {
        checkpoints.push(record);
        say(`  checkpoint ${JSON.stringify(record)}`);
        save(record.destroyed ? record.destroyedAtMs : record.reading.virtualMs);
      },
    });
    write({ ...run, realMs: Date.now() - realStart, meta });
    say(`seed ${seed}: done ${new Date().toISOString()}: ${formatDestroys([run])}`);
    printTable(OUT);
    expect(run.checkpoints).toHaveLength(CHECKPOINTS_MS.length);
  },
);
