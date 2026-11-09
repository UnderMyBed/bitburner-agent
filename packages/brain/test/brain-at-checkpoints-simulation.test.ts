// The brain at the fork's baseline checkpoints (#83, Q10; architecture §13, ADR 0011), in the simulator: the brain's
// rules as on Steam, from exactly the baseline's start (`baselineScenario()`'s fixture: BN1 with SF1.1 and SF4.3, which
// the game makes BN1.2, 32 GB home), read at 4, 8 and 12 virtual hours (`CHECKPOINTS_MS`) as the baseline reads the
// fork, then on to a destroy or a cap. Each seed is compared with the fork's same seed (`FORK_AT_CHECKPOINTS`).
// - CI, seed 1: the runner to 1 virtual hour, read at 20, 40 and 60 minutes: each checkpoint is the game's own summary
//   at the first poll at or past it, and the rows print it.
// - The run, `BRAIN_CHECKPOINTS=1`: each of `BRAIN_CHECKPOINTS_SEEDS` (seed 1 unless given) from the start to a destroy
//   or `BRAIN_CHECKPOINTS_HOURS` virtual hours (16 unless given, 12 at least). `BRAIN_CHECKPOINTS_OUT` names a folder:
//   each seed's progress lines go to `seed-<n>.log` and its result to `seed-<n>.json`, rewritten at each checkpoint and
//   every 10 virtual minutes, so a run the watchdog stops keeps what it reached. Then it prints the rows for
//   docs/sim/baselines.md, each seed against the fork's and the destroys, over every `seed-*.json` in the folder, and
//   writes them to `table.md` there. Heavy: one seed a run (the brain README's checkpoint suite says how).
// - The table alone, `BRAIN_CHECKPOINTS_TABLE=<folder>`: the same print over a folder's results, nothing run.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baselineScenario, CHECKPOINTS_MS } from "@bitburner-agent/legacy";
import { commitId, type GameSummary, REPO_ROOT, rigId } from "@bitburner-agent/sim";
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
  type Reading,
  runToCheckpoints,
  type SeedCheckpoints,
} from "./helpers/checkpoints.ts";
import { useFreshStarts } from "./helpers/fresh-start.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A comma-separated list of seeds; seed 1 when unset. Anything else fails loudly. */
export function seedsOf(text: string | undefined): number[] {
  if (text === undefined) return [1];
  const seeds = text.split(",").map((each) => each.trim());
  if (seeds.some((each) => !/^[1-9]\d*$/.test(each))) {
    throw new Error(`BRAIN_CHECKPOINTS_SEEDS is ${JSON.stringify(text)}: give seeds, comma separated`);
  }
  return seeds.map(Number);
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
const TABLE = process.env.BRAIN_CHECKPOINTS_TABLE;
const OUT = process.env.BRAIN_CHECKPOINTS_OUT;
const BASELINE = baselineScenario();
const freshStartOf = useFreshStarts();

/** A game that runs in steps of `stepMs` and reads `place` (a destroy) from `destroyAtMs` on. */
function fakeGame({
  stepMs = 200,
  startMs = 0,
  destroyAtMs = Number.POSITIVE_INFINITY,
}: {
  stepMs?: number;
  startMs?: number;
  destroyAtMs?: number;
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
        hackingLevel: Math.floor(virtualMs / MINUTE),
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
    const first = run.checkpoints[0] as { reading: Reading };
    expect(first.reading).toEqual({
      virtualMs: 150_030,
      money: 1_500_300,
      hackingLevel: 2,
      augsInstalled: 3,
      homeRamMax: 32,
      bitNodeN: 1,
      bitNodeLevel: 2,
      sourceFiles: { 1: 1, 4: 3 },
    });
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

  test("a start past a checkpoint takes it at once; a cap before one, or a game that doesn't run on, fails", async () => {
    const run = await runToCheckpoints(fakeGame({ startMs: 3 * MINUTE }), {
      seed: 1,
      checkpointsMs: [MINUTE, 4 * MINUTE],
      capMs: 4 * MINUTE,
    });
    expect(run.checkpoints.map((each) => !each.destroyed && each.reading.virtualMs)).toEqual([3 * MINUTE, 4 * MINUTE]);
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
const CHECKS = [HOUR, 2 * HOUR];
const runOf = (
  seed: number,
  checkpoints: CheckpointRecord[],
  destroyedAtMs: number | null = null,
): SeedCheckpoints => ({
  seed,
  checkpoints,
  destroyedAtMs,
  afterDestroy: null,
  capMs: 3 * HOUR,
  ranMs: 3 * HOUR,
  realMs: 30 * MINUTE,
});
const RUNS = [
  runOf(1, [
    { atMs: HOUR, destroyed: false, reading: reading(HOUR, 300, 6, 64) },
    { atMs: 2 * HOUR, destroyed: false, reading: reading(2 * HOUR, 500, 12, 1024) },
  ]),
  runOf(2, [
    { atMs: HOUR, destroyed: false, reading: reading(HOUR, 200, 4, 128) },
    { atMs: 2 * HOUR, destroyed: true, destroyedAtMs: 90 * MINUTE },
  ]),
  runOf(3, [
    { atMs: HOUR, destroyed: false, reading: reading(HOUR, 250, 5, 32) },
    { atMs: 2 * HOUR, destroyed: false, reading: reading(2 * HOUR, 400, 10, 256) },
  ]),
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
};

describe("the rows and the comparison", () => {
  test("rows in baselines.md's columns: medians and ranges over the seeds still in BN1.2, destroys named", () => {
    const rows = checkpointRows(RUNS, CHECKS, { date: "2026-11-09", commit: "abc1234", rig: "rig", node: "v26.13.0" });
    expect(rows).toEqual([
      "| 2026-11-09 | abc1234 | rig | v26.13.0 | 1..3 | 1 h | 3/3 | $250m ($200m–$300m) | 250 (200–300) | 5 | 64 GB | - | 6x | 30 min |",
      "| 2026-11-09 | abc1234 | rig | v26.13.0 | 1..3 | 2 h | 2/3, 1 destroyed before it | $400m ($400m–$500m) | 400 (400–500) | 10 | 256 GB | - | 6x | 30 min |",
    ]);
    expect(checkpointRows([], CHECKS, { date: "d", commit: "c", rig: "r", node: "n" })[0]).toBe(
      "| d | c | r | n |  | 1 h | 0/0 | - | - | - | - | - | - | - |",
    );
  });

  test("each seed against the fork's same seed: at least the fork's hacking, augmentations and home RAM; a destroy ahead", () => {
    expect(compareWithFork(RUNS, CHECKS, FORK)).toEqual([
      { seed: 1, atMs: HOUR, verdict: "ahead", behind: [] },
      { seed: 1, atMs: 2 * HOUR, verdict: "behind", behind: ["augsInstalled"] },
      { seed: 2, atMs: HOUR, verdict: "behind", behind: ["hackingLevel", "homeRamMax"] },
      { seed: 2, atMs: 2 * HOUR, verdict: "destroyed", behind: [] },
      { seed: 3, atMs: HOUR, verdict: "no fork row", behind: [] },
      { seed: 3, atMs: 2 * HOUR, verdict: "no fork row", behind: [] },
    ]);
    const text = formatComparison(RUNS, CHECKS, FORK);
    expect(text).toContain(
      "| 1 | 2 h | $500m, hacking 500, 12 augs, 1024 GB | $1, hacking 400, 13 augs, 128 GB | behind on augsInstalled |",
    );
    expect(text).toContain("| 2 | 2 h | destroyed at 1 h 30 min | $1, hacking 9000, 90 augs, 9000 GB | destroyed |");
    expect(text).toContain("| 3 | 1 h | $250m, hacking 250, 5 augs, 32 GB | - | no fork row |");
  });

  test("the fork's rows are the baseline's: their medians are 5238ab6's rows in baselines.md", () => {
    const at = (index: number, measure: keyof ForkReading) =>
      Object.values(FORK_AT_CHECKPOINTS.seeds)
        .map((seed) => (seed[index] as ForkReading)[measure])
        .sort((a, b) => a - b)[3];
    // baselines.md, 5238ab6 on v26.13.0: hacking 238, 341, 493; augmentations 6, 11, 15; home 64, 128, 2048 GB.
    expect([0, 1, 2].map((i) => [at(i, "hackingLevel"), at(i, "augsInstalled"), at(i, "homeRamMax")])).toEqual([
      [238, 6, 64],
      [341, 11, 128],
      [493, 15, 2048],
    ]);
    expect(Object.keys(FORK_AT_CHECKPOINTS.seeds)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  test("the knobs: seeds, or seed 1; the cap 12 to 48 hours, 16 by default; anything else fails loudly", () => {
    expect(seedsOf(undefined)).toEqual([1]);
    expect(seedsOf("1, 2,8")).toEqual([1, 2, 8]);
    for (const odd of ["", "0", "1,", "2.5", "x"]) expect(() => seedsOf(odd)).toThrow(/BRAIN_CHECKPOINTS_SEEDS/);
    expect(capOf(undefined)).toBe(16 * HOUR);
    expect(capOf("12")).toBe(12 * HOUR);
    for (const odd of ["11.9", "49", "x"]) expect(() => capOf(odd)).toThrow(/BRAIN_CHECKPOINTS_HOURS/);
  });
});

test("seed 1 from the baseline's start, to 1 virtual hour: each checkpoint the game's own summary, printed as a row", {
  timeout: 180_000,
}, async () => {
  const fresh = await freshStartOf({ withDesiredState: true, seed: 1, fixture: BASELINE.fixture });
  const game: CheckpointGame = { summary: () => fresh.simulation.summary(), run: (ms) => fresh.game.run(ms) };
  const checkpointsMs = [20 * MINUTE, 40 * MINUTE, HOUR];
  const run = await runToCheckpoints(game, { seed: 1, checkpointsMs, capMs: HOUR });
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
  const last = run.checkpoints.at(-1) as { reading: Reading };
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
  // The brain played: past hacking 1, home at SF1's 32 GB or more.
  expect(last.reading.hackingLevel).toBeGreaterThan(50);
  expect(last.reading.homeRamMax).toBeGreaterThanOrEqual(32);
  const [, , row] = checkpointRows([run], checkpointsMs, { date: "d", commit: "c", rig: "r", node: "n" });
  expect(row).toContain(
    `| 1 | 1 h | 1/1 | ${row?.split(" | ")[7]} | ${last.reading.hackingLevel} (${last.reading.hackingLevel}–` +
      `${last.reading.hackingLevel}) | ${last.reading.augsInstalled} | ${last.reading.homeRamMax} GB |`,
  );
  console.log(`seed 1 to 1 virtual hour in ${(run.realMs / 1000).toFixed(1)} s real:\n${row}`);
});

/** Every seed's result in `folder`, by seed. */
function resultsIn(folder: string): SeedCheckpoints[] {
  return readdirSync(folder)
    .filter((name) => /^seed-\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(folder, name), "utf8")) as SeedCheckpoints)
    .sort((a, b) => a.seed - b.seed);
}

/** Prints the rows, the comparison and the destroys over `folder`'s results, and writes them to its `table.md`. */
function printTable(folder: string) {
  const runs = resultsIn(folder);
  const meta = {
    date: new Date().toISOString().slice(0, 10),
    commit: commitId(REPO_ROOT),
    rig: rigId(),
    node: process.version,
  };
  const text = [
    `rows for docs/sim/baselines.md:\n${checkpointRows(runs, CHECKPOINTS_MS, meta).join("\n")}`,
    `each seed against the fork's (${FORK_AT_CHECKPOINTS.commit}, ${FORK_AT_CHECKPOINTS.node}):\n${formatComparison(runs, CHECKPOINTS_MS)}`,
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
    const capMs = capOf(process.env.BRAIN_CHECKPOINTS_HOURS);
    const log = path.join(OUT, `seed-${seed}.log`);
    const say = (line: string) => appendFileSync(log, `${line}\n`);
    const realStart = Date.now();
    say(`seed ${seed}: start ${new Date().toISOString()}, cap ${capMs / HOUR} h`);
    const fresh = await freshStartOf({ withDesiredState: true, seed, fixture: BASELINE.fixture });
    const game: CheckpointGame = { summary: () => fresh.simulation.summary(), run: (ms) => fresh.game.run(ms) };
    const checkpoints: CheckpointRecord[] = [];
    const save = (ranMs: number, partial: boolean) =>
      writeFileSync(
        path.join(OUT, `seed-${seed}.json`),
        `${JSON.stringify(
          {
            seed,
            checkpoints,
            destroyedAtMs: null,
            afterDestroy: null,
            capMs,
            ranMs,
            realMs: Date.now() - realStart,
            partial,
          },
          null,
          2,
        )}\n`,
      );
    let nextProgressMs = 0;
    const run = await runToCheckpoints(game, {
      seed,
      checkpointsMs: CHECKPOINTS_MS,
      capMs,
      onPoll: (reading) => {
        if (reading.virtualMs < nextProgressMs) return;
        nextProgressMs = reading.virtualMs + 10 * MINUTE;
        const medium = fresh.medium();
        say(
          `  v ${(reading.virtualMs / MINUTE).toFixed(0)} min, real ${((Date.now() - realStart) / 1000).toFixed(0)} s: ` +
            `hacking ${reading.hackingLevel}, money ${reading.money.toExponential(2)}, ${reading.augsInstalled} augs, ` +
            `home ${reading.homeRamMax} GB, BN${reading.bitNodeN}.${reading.bitNodeLevel}, ` +
            `${(medium?.player.factions as string[] | undefined)?.length ?? "?"} factions, ` +
            `${medium?.servers.filter((each) => each.hasAdminRights).reduce((sum, each) => sum + each.maxRam, 0) ?? "?"} GB rooted`,
        );
        save(reading.virtualMs, true);
      },
      onCheckpoint: (record) => {
        checkpoints.push(record);
        say(`  checkpoint ${JSON.stringify(record)}`);
        save(record.destroyed ? record.destroyedAtMs : record.reading.virtualMs, true);
      },
    });
    writeFileSync(
      path.join(OUT, `seed-${seed}.json`),
      `${JSON.stringify({ ...run, realMs: Date.now() - realStart }, null, 2)}\n`,
    );
    say(`seed ${seed}: done ${new Date().toISOString()}: ${formatDestroys([run])}`);
    printTable(OUT);
    expect(run.checkpoints).toHaveLength(CHECKPOINTS_MS.length);
  },
);
