// The brain at the fork's baseline checkpoints (#83, Q10; architecture §13, ADR 0011): a runner that reads the game at
// fixed virtual times as the baseline does (`@bitburner-agent/legacy`'s `CHECKPOINTS_MS`), stopping at a destroy or a
// cap; the rows for docs/sim/baselines.md, in its columns; and each seed against the fork's same seed.
import { formatMoney, formatSeeds } from "@bitburner-agent/legacy";
import { distribution, type GameSummary } from "@bitburner-agent/sim";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What a checkpoint records: the baseline row's measures, and where in the BitNodes the game is. */
export type Reading = Pick<
  GameSummary,
  "virtualMs" | "money" | "hackingLevel" | "augsInstalled" | "homeRamMax" | "bitNodeN" | "bitNodeLevel" | "sourceFiles"
>;

/** A checkpoint: the reading at the first poll at or past it, or the destroy that came before it. */
export type CheckpointRecord =
  | { atMs: number; destroyed: false; reading: Reading }
  | { atMs: number; destroyed: true; destroyedAtMs: number };

/** One seed's run: its checkpoints, any destroy (virtual ms from the start), how far it ran and the real time it took. */
export interface SeedCheckpoints {
  seed: number;
  /** The checkpoints reached, in order; fewer than asked for only if the run was cut short. */
  checkpoints: CheckpointRecord[];
  /** The first destroy: the first poll whose BitNode or Source-Files differ from the start's. */
  destroyedAtMs: number | null;
  /** The reading after the destroy, or null. */
  afterDestroy: Reading | null;
  capMs: number;
  ranMs: number;
  realMs: number;
}

/** What the runner needs of a game: its summary (`Simulation.summary`), and a way to run it on. */
export interface CheckpointGame {
  summary(): Promise<GameSummary>;
  /** Runs the game (the brain with it) for `ms` of virtual time. */
  run(ms: number): Promise<void>;
}

const readingOf = (summary: GameSummary): Reading => ({
  virtualMs: summary.virtualMs,
  money: summary.money,
  hackingLevel: summary.hackingLevel,
  augsInstalled: summary.augsInstalled,
  homeRamMax: summary.homeRamMax,
  bitNodeN: summary.bitNodeN,
  bitNodeLevel: summary.bitNodeLevel,
  sourceFiles: summary.sourceFiles,
});

/** The BitNode and Source-Files: a destroy changes them (BN1.2 into BN1 is BN1.3 with SF1.2). */
const placeOf = (reading: Reading) =>
  JSON.stringify([reading.bitNodeN, reading.bitNodeLevel, Object.entries(reading.sourceFiles).sort()]);

/**
 * Runs `game` from where it is to `capMs` of virtual time since its simulation started (`GameSummary.virtualMs`, the
 * clock the baseline's checkpoints are on), polling every `pollMs`. Each checkpoint takes the first poll at or past it;
 * the run stops at the first destroy, and every checkpoint after it is recorded as destroyed. `onPoll` sees each reading
 * (progress lines); `onCheckpoint` each checkpoint as it's taken, so a run cut short keeps what it reached.
 */
export async function runToCheckpoints(
  game: CheckpointGame,
  {
    seed,
    checkpointsMs,
    capMs,
    pollMs = MINUTE,
    now = Date.now,
    onPoll = () => {},
    onCheckpoint = () => {},
  }: {
    seed: number;
    checkpointsMs: readonly number[];
    capMs: number;
    pollMs?: number;
    now?: () => number;
    onPoll?: (reading: Reading) => void;
    onCheckpoint?: (record: CheckpointRecord) => void;
  },
): Promise<SeedCheckpoints> {
  if (!(capMs >= (checkpointsMs.at(-1) ?? 0))) throw new RangeError(`the cap, ${capMs} ms, is before a checkpoint`);
  const realStart = now();
  const start = readingOf(await game.summary());
  const checkpoints: CheckpointRecord[] = [];
  const take = (record: CheckpointRecord) => {
    checkpoints.push(record);
    onCheckpoint(record);
  };
  /** Takes every checkpoint `reading` is at or past. */
  const takeDue = (reading: Reading) => {
    for (let due = checkpointsMs[checkpoints.length]; due !== undefined && reading.virtualMs >= due; ) {
      take({ atMs: due, destroyed: false, reading });
      due = checkpointsMs[checkpoints.length];
    }
  };
  let reading = start;
  let destroyedAtMs: number | null = null;
  takeDue(reading);
  while (reading.virtualMs < capMs) {
    const next = checkpointsMs[checkpoints.length] ?? capMs;
    const toMs = Math.min(capMs, reading.virtualMs + pollMs, next);
    await game.run(toMs - reading.virtualMs);
    const before = reading.virtualMs;
    reading = readingOf(await game.summary());
    if (!(reading.virtualMs > before)) throw new Error(`the game didn't run on: still at ${reading.virtualMs} ms`);
    onPoll(reading);
    if (placeOf(reading) !== placeOf(start)) {
      destroyedAtMs = reading.virtualMs;
      break;
    }
    takeDue(reading);
  }
  if (destroyedAtMs !== null) {
    for (const atMs of checkpointsMs.slice(checkpoints.length)) take({ atMs, destroyed: true, destroyedAtMs });
  }
  return {
    seed,
    checkpoints,
    destroyedAtMs,
    afterDestroy: destroyedAtMs === null ? null : reading,
    capMs,
    ranMs: reading.virtualMs,
    realMs: now() - realStart,
  };
}

/** The measures a baseline row compares, from a fork seed's checkpoint (`GameSummary`). */
export type ForkReading = Pick<GameSummary, "money" | "hackingLevel" | "augsInstalled" | "homeRamMax">;

/**
 * The fork at each of `CHECKPOINTS_MS` (4, 8 and 12 h), per seed: the baseline's seventh run, 5238ab6 on Node
 * v26.13.0 (docs/sim/baselines.md), the rows M4 phase B compares with. Deterministic on that Node, so
 * `npm run baseline -w @bitburner-agent/legacy -- --seeds 1..8 --json out.json` reproduces them.
 */
export const FORK_AT_CHECKPOINTS = {
  commit: "5238ab6",
  node: "v26.13.0",
  seeds: {
    1: [
      { money: 54620127.91593085, hackingLevel: 238, augsInstalled: 6, homeRamMax: 128 },
      { money: 104980216.25275399, hackingLevel: 285, augsInstalled: 11, homeRamMax: 128 },
      { money: 27881735761.425392, hackingLevel: 491, augsInstalled: 14, homeRamMax: 2048 },
    ],
    2: [
      { money: 1266330137.0418768, hackingLevel: 279, augsInstalled: 6, homeRamMax: 128 },
      { money: 6899494238.42687, hackingLevel: 374, augsInstalled: 11, homeRamMax: 128 },
      { money: 1112872074865.6228, hackingLevel: 662, augsInstalled: 16, homeRamMax: 32768 },
    ],
    3: [
      { money: 61728843.44439901, hackingLevel: 246, augsInstalled: 6, homeRamMax: 128 },
      { money: 2914708251.779264, hackingLevel: 351, augsInstalled: 11, homeRamMax: 128 },
      { money: 113203796027.75774, hackingLevel: 559, augsInstalled: 15, homeRamMax: 8192 },
    ],
    4: [
      { money: 202119862.29163387, hackingLevel: 244, augsInstalled: 6, homeRamMax: 128 },
      { money: 5077356642.670554, hackingLevel: 341, augsInstalled: 11, homeRamMax: 128 },
      { money: 5847792214.874575, hackingLevel: 493, augsInstalled: 17, homeRamMax: 1024 },
    ],
    5: [
      { money: 18266208.57170795, hackingLevel: 210, augsInstalled: 6, homeRamMax: 64 },
      { money: 1203479.1148379687, hackingLevel: 259, augsInstalled: 10, homeRamMax: 128 },
      { money: 2623194384.9538946, hackingLevel: 329, augsInstalled: 10, homeRamMax: 128 },
    ],
    6: [
      { money: 400996305.4381287, hackingLevel: 268, augsInstalled: 6, homeRamMax: 64 },
      { money: 1685456211.28049, hackingLevel: 372, augsInstalled: 10, homeRamMax: 128 },
      { money: 533859404702.81635, hackingLevel: 574, augsInstalled: 17, homeRamMax: 16384 },
    ],
    7: [
      { money: 17600824.386768345, hackingLevel: 231, augsInstalled: 6, homeRamMax: 64 },
      { money: 117784702.13128299, hackingLevel: 291, augsInstalled: 10, homeRamMax: 128 },
      { money: 9060568.666666666, hackingLevel: 208, augsInstalled: 11, homeRamMax: 128 },
    ],
    8: [
      { money: 132350285.31105053, hackingLevel: 234, augsInstalled: 6, homeRamMax: 64 },
      { money: 3215528258.510932, hackingLevel: 352, augsInstalled: 11, homeRamMax: 256 },
      { money: 14647992020.119453, hackingLevel: 501, augsInstalled: 19, homeRamMax: 2048 },
    ],
  } as Record<number, ForkReading[]>,
};

/** What a row needs beyond the runs (the legacy CLI's `RowMeta`). */
export interface RowMeta {
  date: string;
  commit: string;
  rig: string;
  node: string;
}

const hours = (ms: number) => `${Number((ms / HOUR).toFixed(2))} h`;
/** Virtual time as h:mm. */
export const formatVirtual = (ms: number) =>
  `${Math.floor(ms / HOUR)} h ${String(Math.floor((ms % HOUR) / MINUTE)).padStart(2, "0")} min`;

/**
 * The runs' rows for docs/sim/baselines.md, one per checkpoint, in its columns: the medians (lower middle of an even
 * count) and ranges over the seeds still in their first BitNode there. Reached counts those, of the seeds run, and names
 * the seeds destroyed before it. The heap isn't measured (the Agent's simulation is a child process): "-". Speed and
 * real time per seed are the runs' medians, the same on each row.
 */
export function checkpointRows(runs: SeedCheckpoints[], checkpointsMs: readonly number[], meta: RowMeta): string[] {
  const seeds = formatSeeds(runs.map((run) => run.seed));
  const speed = distribution(runs.map((run) => run.ranMs / Math.max(1, run.realMs)))?.median;
  const real = distribution(runs.map((run) => run.realMs))?.median;
  return checkpointsMs.map((atMs) => {
    const records = runs.flatMap((run) => run.checkpoints.filter((record) => record.atMs === atMs));
    const readings = records.flatMap((record) => (record.destroyed ? [] : [record.reading]));
    const destroyed = records.length - readings.length;
    const stat = (values: number[], format: (n: number) => string, range: boolean) => {
      const d = distribution(values);
      if (!d) return "-";
      return range ? `${format(d.median)} (${format(d.min)}–${format(d.max)})` : format(d.median);
    };
    const cells = [
      meta.date,
      meta.commit,
      meta.rig,
      meta.node,
      seeds,
      hours(atMs),
      `${readings.length}/${runs.length}${destroyed > 0 ? `, ${destroyed} destroyed before it` : ""}`,
      stat(
        readings.map((r) => r.money),
        formatMoney,
        true,
      ),
      stat(
        readings.map((r) => r.hackingLevel),
        String,
        true,
      ),
      stat(
        readings.map((r) => r.augsInstalled),
        String,
        false,
      ),
      stat(
        readings.map((r) => r.homeRamMax),
        (n) => `${n} GB`,
        false,
      ),
      "-",
      speed === undefined ? "-" : `${speed.toFixed(0)}x`,
      real === undefined ? "-" : `${(real / MINUTE).toFixed(0)} min`,
    ];
    return `| ${cells.join(" | ")} |`;
  });
}

/** The measures gated on (Q10's candidate): each at least the fork's. Money is reported, not gated. */
export const GATED = ["hackingLevel", "augsInstalled", "homeRamMax"] as const;
export type Gated = (typeof GATED)[number];

/** One seed at one checkpoint against the fork's same seed: the measures behind, or "destroyed" (ahead on all). */
export interface SeedVerdict {
  seed: number;
  atMs: number;
  verdict: "ahead" | "behind" | "destroyed" | "no fork row";
  behind: Gated[];
}

/** Each seed at each checkpoint against the fork's same seed and checkpoint (`fork`, by seed, in checkpoint order). */
export function compareWithFork(
  runs: SeedCheckpoints[],
  checkpointsMs: readonly number[],
  fork: Record<number, ForkReading[]> = FORK_AT_CHECKPOINTS.seeds,
): SeedVerdict[] {
  return runs.flatMap((run) =>
    run.checkpoints.map((record): SeedVerdict => {
      const theirs = fork[run.seed]?.[checkpointsMs.indexOf(record.atMs)];
      if (record.destroyed) return { seed: run.seed, atMs: record.atMs, verdict: "destroyed", behind: [] };
      if (theirs === undefined) return { seed: run.seed, atMs: record.atMs, verdict: "no fork row", behind: [] };
      const behind = GATED.filter((measure) => record.reading[measure] < theirs[measure]);
      return { seed: run.seed, atMs: record.atMs, verdict: behind.length > 0 ? "behind" : "ahead", behind };
    }),
  );
}

/** Each seed against the fork's, a line a checkpoint: the brain's measures, the fork's, and the verdict. */
export function formatComparison(
  runs: SeedCheckpoints[],
  checkpointsMs: readonly number[],
  fork: Record<number, ForkReading[]> = FORK_AT_CHECKPOINTS.seeds,
): string {
  const verdicts = compareWithFork(runs, checkpointsMs, fork);
  const side = (r: ForkReading | undefined) =>
    r === undefined
      ? "-"
      : `${formatMoney(r.money)}, hacking ${r.hackingLevel}, ${r.augsInstalled} augs, ${r.homeRamMax} GB`;
  const lines = ["| Seed | At | Brain | Fork | Verdict |", "|---|---|---|---|---|"];
  for (const run of runs) {
    for (const record of run.checkpoints) {
      const v = verdicts.find((each) => each.seed === run.seed && each.atMs === record.atMs) as SeedVerdict;
      const brain = record.destroyed ? `destroyed at ${formatVirtual(record.destroyedAtMs)}` : side(record.reading);
      const verdict = v.verdict === "behind" ? `behind on ${v.behind.join(", ")}` : v.verdict;
      lines.push(
        `| ${run.seed} | ${hours(record.atMs)} | ${brain} | ${side(fork[run.seed]?.[checkpointsMs.indexOf(record.atMs)])} | ${verdict} |`,
      );
    }
  }
  return lines.join("\n");
}

/** Each seed's destroy, or how far it ran without one. */
export function formatDestroys(runs: SeedCheckpoints[]): string {
  return runs
    .map((run) =>
      run.destroyedAtMs === null
        ? `seed ${run.seed}: no destroy by ${formatVirtual(run.ranMs)} (cap ${formatVirtual(run.capMs)})`
        : `seed ${run.seed}: destroyed at ${formatVirtual(run.destroyedAtMs)}, into BN${run.afterDestroy?.bitNodeN}.` +
          `${run.afterDestroy?.bitNodeLevel} with Source-Files ${JSON.stringify(run.afterDestroy?.sourceFiles)}`,
    )
    .join("\n");
}
