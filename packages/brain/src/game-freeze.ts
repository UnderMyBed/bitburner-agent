// Game freezes (#241): the page stops running its scripts for seconds, so every timer in it fires late, the batcher's
// operations too, and batches land out of order. Run #3 (2026-11-05) had one: the medium snapshots' game time 12.7 s
// apart for a 10 s tick, a fast interval of 5 s, and 1,615 desyncs on the-hub from 2 s after it, which the batcher
// recovered from by itself in 95 s. The run report finds them in the store's snapshots (section 4), fails 3 or more
// in an hour ("game freezing"), and section 6 attributes a batcher's desyncs to one within a weaken's time before them
// (./batcher-report.ts): a warning, not a failure, once the batcher is batching again (owner decision 55).
import {
  type HackingPlayer,
  type HackingTarget,
  type MediumSnapshotData,
  operationTimeMs,
  SNAPSHOT_TIER_PERIOD_MS,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { hackingPlayerOf } from "./batcher.ts";
import { formatIsoTime, formatSeconds } from "./gap-report.ts";

/**
 * How much more than its 10 s apart two medium snapshots' game time may be before the time over it is a freeze: one
 * round of the Agent's (the fast tier's 2 s). A medium snapshot a round late is the tier's worker failing and retried
 * next round (a fast snapshot between says the tier degraded, and that interval isn't judged), or rounds that ran a
 * little over their 2 s, each bounded by its workers' deadlines (ingame `agent/snapshotter.ts`, `takeRound`). More
 * than a round lost is the page not running. Run #3's 12.7 s is 2.7 s over.
 */
export const GAME_FREEZE_MEDIUM_MARGIN_MS = SNAPSHOT_TIER_PERIOD_MS.fast;
/**
 * Two fast snapshots' game time further apart than this is a freeze, of the time over their 2 s: two rounds, so a whole
 * round lost, which a round's own deadlines never lose. Below the heartbeat's gap (6 s, `DEFAULT_GAP_THRESHOLD_MS`),
 * so a freeze shows before it's a gap. Run #3's 5 s interval is one.
 */
export const GAME_FREEZE_FAST_INTERVAL_MS = 2 * SNAPSHOT_TIER_PERIOD_MS.fast;
/**
 * A batcher's first desync (or late or lost operation) is the freeze's if it's seen from the freeze's start to this
 * many of its target's weaken times after its end: every part in flight when the page stopped lands within one weaken
 * (an operation's longest time, 4 hacks, Hacking.ts:89-93) of the page running again. Later ones are batches started
 * after it.
 */
export const FREEZE_ATTRIBUTION_WEAKENS = 1;
/**
 * A batcher out of step after a freeze is a warning only if it's batching again within this of the freeze's end, and
 * nothing is out of step for this long after (owner decision 55). Run #3's took 95 s; a recovery lets every part in
 * flight land (one weaken, minutes on most targets) and prepares the target again.
 */
export const BATCHER_FREEZE_RECOVERY_MS = 10 * 60_000;
/** This many freezes within `GAME_FREEZING_WITHIN_MS` fail the run (owner decision 55): the game is freezing. */
export const GAME_FREEZING_COUNT = 3;
/** An hour: one freeze in a run is the game's hiccup, as run #3's; three in an hour cost batches often enough to fix. */
export const GAME_FREEZING_WITHIN_MS = 60 * 60_000;

/** A snapshot's time: when the brain received it, and the game's `Date.now()` when the Agent took it. */
export interface SnapshotTime {
  atMs: number;
  gameTimeMs: number;
}

/** A fast snapshot's time, with the tiers it says failed last round (absent from a malformed one). */
export interface FastSnapshotTime extends SnapshotTime {
  degradedTiers?: unknown;
}

/** A freeze: between two snapshots received at `fromMs` and `toMs`, `lengthMs` of game time lost; what showed it. */
export interface GameFreeze {
  fromMs: number;
  toMs: number;
  lengthMs: number;
  evidence: string[];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The time lost between two snapshots of a tier taken `periodMs` apart: the least of the game's time and the brain's
 * between them, less the period. Both clocks: the game's stepping on, or the brain receiving late, is no freeze. A
 * game time that isn't one (0, an older store's) or goes back gives nothing.
 */
function lostMs(from: SnapshotTime, to: SnapshotTime, periodMs: number): number | null {
  if (!(from.gameTimeMs > 0) || !isFiniteNumber(to.gameTimeMs)) return null;
  const gameMs = to.gameTimeMs - from.gameTimeMs;
  if (!(gameMs > 0)) return null;
  return Math.min(gameMs, to.atMs - from.atMs) - periodMs;
}

/**
 * The freezes in the medium and fast snapshots' times (each in the brain's order of receipt), but over a restart
 * (`restartsMs`: the brain or the Agent starting or stopping, a deploy) or, for the medium, a tier retried. A freeze
 * both tiers show is one: within both intervals, the longer of the two lengths.
 */
export function findGameFreezes({
  medium,
  fast,
  restartsMs,
}: {
  medium: readonly SnapshotTime[];
  fast: readonly FastSnapshotTime[];
  restartsMs: readonly number[];
}): GameFreeze[] {
  const restartBetween = (fromMs: number, toMs: number) => restartsMs.some((each) => each >= fromMs && each <= toMs);
  const mediumRetried = (fromMs: number, toMs: number) =>
    fast.some(
      ({ atMs, degradedTiers }) =>
        atMs > fromMs && atMs <= toMs && Array.isArray(degradedTiers) && degradedTiers.includes("medium"),
    );
  const found: GameFreeze[] = [];
  const look = (
    points: readonly SnapshotTime[],
    periodMs: number,
    overMs: number,
    tier: string,
    skip: (fromMs: number, toMs: number) => boolean,
  ) => {
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1] as SnapshotTime;
      const to = points[index] as SnapshotTime;
      const lost = lostMs(from, to, periodMs);
      if (lost === null || !(lost > overMs) || restartBetween(from.atMs, to.atMs) || skip(from.atMs, to.atMs)) continue;
      found.push({
        fromMs: from.atMs,
        toMs: to.atMs,
        lengthMs: lost,
        evidence: [
          `the ${tier} snapshots' game time ${formatSeconds(lost + periodMs)} apart (${periodMs / 1000} s due)`,
        ],
      });
    }
  };
  look(medium, SNAPSHOT_TIER_PERIOD_MS.medium, GAME_FREEZE_MEDIUM_MARGIN_MS, "medium", mediumRetried);
  const fastOverMs = GAME_FREEZE_FAST_INTERVAL_MS - SNAPSHOT_TIER_PERIOD_MS.fast;
  look(fast, SNAPSHOT_TIER_PERIOD_MS.fast, fastOverMs, "fast", () => false);
  // Overlapping intervals are one freeze, lying within both.
  const freezes: GameFreeze[] = [];
  for (const freeze of found.sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs)) {
    const last = freezes.at(-1);
    if (last !== undefined && freeze.fromMs < last.toMs && freeze.toMs > last.fromMs) {
      last.fromMs = Math.max(last.fromMs, freeze.fromMs);
      last.toMs = Math.min(last.toMs, freeze.toMs);
      last.lengthMs = Math.max(last.lengthMs, freeze.lengthMs);
      last.evidence.push(...freeze.evidence);
    } else {
      freezes.push({ ...freeze, evidence: [...freeze.evidence] });
    }
  }
  return freezes;
}

/** "~2.7 s": a freeze's length, to a tenth, approximate (the snapshots bound it, not the game). */
export const describeFreezeLength = (lengthMs: number) => `~${formatSeconds(lengthMs)}`;

/**
 * Section 4's lines: each freeze, and a failure for each stretch of `GAME_FREEZING_COUNT` or more within
 * `GAME_FREEZING_WITHIN_MS` (each freeze in such an hour is in its stretch; stretches an hour apart are two).
 */
export function freezeLines(freezes: readonly GameFreeze[], failures: string[]): string[] {
  const lines = [
    `  game freezes (#241: the game's time between medium snapshots over ${SNAPSHOT_TIER_PERIOD_MS.medium / 1000} s ` +
      `by more than ${formatSeconds(GAME_FREEZE_MEDIUM_MARGIN_MS)}, or between fast snapshots over ` +
      `${formatSeconds(GAME_FREEZE_FAST_INTERVAL_MS)}; ${GAME_FREEZING_COUNT} or more within an hour are "game ` +
      'freezing"):',
  ];
  for (const { fromMs, toMs, lengthMs, evidence } of freezes) {
    lines.push(
      `    ${describeFreezeLength(lengthMs)} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}: ` +
        evidence.join("; "),
    );
  }
  if (freezes.length === 0) lines.push("    none");
  const inAnHour = new Set<number>();
  freezes.forEach((freeze, index) => {
    const within = freezes.filter(
      (other, otherIndex) => otherIndex >= index && other.fromMs - freeze.fromMs < GAME_FREEZING_WITHIN_MS,
    );
    if (within.length < GAME_FREEZING_COUNT) return;
    for (let each = index; each < index + within.length; each++) inAnHour.add(each);
  });
  const stretches: GameFreeze[][] = [];
  freezes.forEach((freeze, index) => {
    if (!inAnHour.has(index)) return;
    const last = stretches.at(-1);
    const previous = last?.at(-1);
    if (
      last !== undefined &&
      previous !== undefined &&
      inAnHour.has(index - 1) &&
      freeze.fromMs - previous.fromMs < GAME_FREEZING_WITHIN_MS
    ) {
      last.push(freeze);
    } else {
      stretches.push([freeze]);
    }
  });
  for (const stretch of stretches) {
    const first = stretch[0] as GameFreeze;
    const last = stretch.at(-1) as GameFreeze;
    const longest = Math.max(...stretch.map(({ lengthMs }) => lengthMs));
    const line =
      `game freezing: ${stretch.length} game freezes from ${formatIsoTime(first.fromMs)} to ` +
      `${formatIsoTime(last.toMs)}, ${GAME_FREEZING_COUNT} or more within an hour (the longest ` +
      `${describeFreezeLength(longest)})`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  return lines;
}

/** A target's figures from a static snapshot's server, or null without the two a weaken's time needs. */
function figuresOf(server: StaticSnapshotData["servers"][number] | undefined): HackingTarget | null {
  if (!isFiniteNumber(server?.minDifficulty) || !isFiniteNumber(server?.requiredHackingSkill)) return null;
  return {
    moneyMax: isFiniteNumber(server.moneyMax) ? server.moneyMax : 0,
    minDifficulty: server.minDifficulty,
    requiredHackingSkill: server.requiredHackingSkill,
    serverGrowth: isFiniteNumber(server.serverGrowth) ? server.serverGrowth : 0,
  };
}

/**
 * A weaken's time on a target over the window, for the attribution: at its minimum security (where a batcher keeps it),
 * for the player then, as the game's formula has it (core's `operationTimeMs`). Kept as the snapshots are read: the
 * static snapshots' servers (an install rolls their figures again) and each medium snapshot's player that changed.
 */
export class WeakenTimes {
  readonly #statics: { atMs: number; servers: StaticSnapshotData["servers"] }[] = [];
  readonly #players: { atMs: number; player: HackingPlayer }[] = [];
  #lastPlayerKey: string | null = null;

  addStatic(atMs: number, data: StaticSnapshotData): void {
    if (Array.isArray(data?.servers)) this.#statics.push({ atMs, servers: data.servers });
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const player = hackingPlayerOf(data?.player);
    if (player === null) return;
    const key = JSON.stringify(player);
    if (key === this.#lastPlayerKey) return;
    this.#lastPlayerKey = key;
    this.#players.push({ atMs, player });
  }

  /** At `atMs`, by the newest of each by then (the first, before any), or null if either is unknown. */
  weakenMs(target: string, atMs: number): number | null {
    const newestBy = <Each extends { atMs: number }>(list: readonly Each[]) =>
      list.filter((each) => each.atMs <= atMs).at(-1) ?? list[0];
    const servers = newestBy(this.#statics)?.servers ?? [];
    const figures = figuresOf(servers.find((server) => server?.hostname === target));
    const player = newestBy(this.#players)?.player;
    if (figures === null || player === undefined) return null;
    const weakenMs = operationTimeMs("weaken1", figures, player);
    return Number.isFinite(weakenMs) && weakenMs > 0 ? weakenMs : null;
  }
}
