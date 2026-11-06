// Clock steps and page stalls (#241): what, outside the batcher, makes its landings look out of order. Run #3
// (2026-11-05) had a clock step: Windows stepped the PC's clock +2,678 ms at 17:11:33.5Z (its event log), the game's
// process took it up at about 17:11:46 and the brain's at about 17:12:08 (each resyncs its wall clock now and then);
// the batcher, then judging landings by `Date.now()`, saw every part in flight 2.7 s late, and 1,615 desyncs on the-hub
// followed, which it recovered from by itself in 95 s. Since #251 the batcher times them on the page's monotonic clock,
// which a step doesn't move: a step explains only an older batcher's desyncs (its health has no `clock`). A page
// stall, the page not running its scripts for seconds (its cause unknown: the PC, the game, or a script of ours),
// still would. The run report
// finds both in the store's snapshots (section 4), fails 3 or more in an hour, and section 6 puts a batcher's desyncs
// down to one within a weaken's time before them (./batcher-report.ts): a warning, not a failure, once the batcher is
// batching again (owner decision 55).
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
 * A clock step: between two snapshots of a tier, one clock's interval longer (or shorter) than the other's by more than
 * this. Each snapshot is received within tens of ms of being taken (the round's worker, then the socket), so the two
 * agree to well within it; a step this size is over twice the slack a batcher's operations had in run #3 (178 ms); a
 * smaller one could desync an older batcher too, and none can one since #251, on the monotonic clock. Run #3's was
 * 2,678 ms.
 */
export const CLOCK_STEP_MIN_MS = 500;
/**
 * And the clock that moved must be long (or short, stepping back) that once: over the interval before and the one
 * after, it's never short by more than this, and before a step back never long. A step stays; a snapshot received late
 * (the brain busy) makes the brain's clock long and then short. Each clock is judged on its own intervals, so the two
 * taking a step up in adjacent intervals are both seen.
 */
export const CLOCK_STEP_STEADY_MS = CLOCK_STEP_MIN_MS / 2;
/**
 * The game's clock and the brain's moving the same way by the same amount (within `CLOCK_STEP_STEADY_MS`) this close
 * together are one step, which each process took up at its own moment: V8 and Chromium each resync their wall clock
 * with the system's now and then, not at every read. Run #3's were 20 s apart. Taken up in the same interval, both
 * clocks are long alike, as for a page stall (and a step under 2 s then reads as a round run long, so isn't seen).
 */
export const CLOCK_STEP_PAIR_WITHIN_MS = 5 * 60_000;
/**
 * A page stall: two medium snapshots later than their 10 s on both clocks by more than this, one round of the Agent's
 * (the fast tier's 2 s). A medium snapshot a round late is the tier's worker failing and retried next round (a fast
 * snapshot between says the tier degraded, and that interval isn't judged), or rounds that ran a little over their
 * 2 s, each bounded by its workers' deadlines (ingame `agent/snapshotter.ts`, `takeRound`).
 */
export const PAGE_STALL_MEDIUM_MARGIN_MS = SNAPSHOT_TIER_PERIOD_MS.fast;
/**
 * Or two fast snapshots more than this apart on both clocks: two rounds, so a whole round lost, which a round's own
 * deadlines never lose. Below the heartbeat's gap (6 s, `DEFAULT_GAP_THRESHOLD_MS`), so a stall shows before a gap.
 */
export const PAGE_STALL_FAST_INTERVAL_MS = 2 * SNAPSHOT_TIER_PERIOD_MS.fast;
/** Stalls this close together (from one's end to the next's start) are one incident, their lengths added. */
export const PAGE_STALL_SAME_INCIDENT_WITHIN_MS = 60_000;
/**
 * A batcher's stretch out of step is an incident's if its first look out of step is seen from the incident's start to
 * this many of its target's weaken times after its end (the game's clock's move, for a step: an older batcher read
 * only it; one since #251 reads neither, so a step explains none of its stretches): every part in flight then lands within one weaken (an operation's longest time, 4 hacks,
 * Hacking.ts:89-93). An incident explains the first such stretch only.
 */
export const INCIDENT_ATTRIBUTION_WEAKENS = 1;
/**
 * A batcher out of step after an incident is a warning only if it's batching again within this of the incident's end,
 * and nothing is out of step for this long after (owner decision 55). Run #3's took 95 s; a recovery lets every part
 * in flight land (one weaken, minutes on most targets) and prepares the target again.
 */
export const BATCHER_INCIDENT_RECOVERY_MS = 10 * 60_000;
/** This many incidents within `TOO_MANY_INCIDENTS_WITHIN_MS` fail the run (owner decision 55). */
export const TOO_MANY_INCIDENTS = 3;
/** An hour: one incident in a run is a hiccup, as run #3's; three in an hour cost batches often enough to fix. */
export const TOO_MANY_INCIDENTS_WITHIN_MS = 60 * 60_000;

/** A snapshot's time: when the brain received it, and the game's `Date.now()` when the Agent took it. */
export interface SnapshotTime {
  atMs: number;
  gameTimeMs: number;
}

/** A fast snapshot's time, with the tiers it says failed last round (absent from a malformed one). */
export interface FastSnapshotTime extends SnapshotTime {
  degradedTiers?: unknown;
}

/**
 * A clock step (`sizeMs` the clock's move, + on) or a page stall (`sizeMs` the time lost), between snapshots received
 * at `fromMs` and `toMs`, and what showed it; for a step, when the game's clock moved, if it was seen to (`gameClock`):
 * the moment an older batcher, on the wall clock, felt it (one since #251 doesn't).
 */
export interface ClockIncident {
  kind: "clockStep" | "pageStall";
  fromMs: number;
  toMs: number;
  sizeMs: number;
  detail: string;
  gameClock?: { fromMs: number; toMs: number };
}

/** Two consecutive snapshots of a tier, as both clocks saw them. */
interface SnapshotInterval {
  tier: "medium" | "fast";
  periodMs: number;
  fromMs: number;
  toMs: number;
  receivedMs: number;
  gameMs: number;
}

/** One clock seen to move: the game's (its time) or the brain's (the receipts). */
interface ClockMove {
  clock: "game" | "brain";
  fromMs: number;
  toMs: number;
  sizeMs: number;
}

/** A stall one tier showed. */
interface StallSeen {
  tier: "medium" | "fast";
  fromMs: number;
  toMs: number;
  lostMs: number;
  detail: string;
}

type Span = { fromMs: number; toMs: number };

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** "+2.7 s", "−1.0 s". */
const signedSeconds = (ms: number) => `${ms >= 0 ? "+" : "−"}${formatSeconds(Math.abs(ms))}`;
const overlaps = (first: Span, second: Span) => first.fromMs < second.toMs && second.fromMs < first.toMs;
const clockMsOf = (interval: SnapshotInterval, clock: ClockMove["clock"]) =>
  clock === "game" ? interval.gameMs : interval.receivedMs;
/**
 * How far a clock's interval is from the nearest whole number of rounds at or over the tier's period: a medium
 * snapshot retried is rounds late on both clocks, a step isn't.
 */
function offRoundsMs(clockMs: number, periodMs: number): number {
  const rounds = Math.max(0, Math.round((clockMs - periodMs) / SNAPSHOT_TIER_PERIOD_MS.fast));
  return clockMs - (periodMs + rounds * SNAPSHOT_TIER_PERIOD_MS.fast);
}

/**
 * A tier's intervals, null where they can't be judged: over a restart, from or to a snapshot with no game time (an
 * older store's 0), or one `unusable` (a fast snapshot whose worker failed: stamped at its round's start, sent at its
 * end).
 */
function intervalsOf(
  points: readonly SnapshotTime[],
  tier: SnapshotInterval["tier"],
  restartBetween: (fromMs: number, toMs: number) => boolean,
  unusable: (point: SnapshotTime) => boolean = () => false,
): (SnapshotInterval | null)[] {
  const periodMs = SNAPSHOT_TIER_PERIOD_MS[tier];
  return points.slice(1).map((to, index) => {
    const from = points[index] as SnapshotTime;
    if (!(from.gameTimeMs > 0) || !(to.gameTimeMs > 0) || unusable(from) || unusable(to)) return null;
    if (restartBetween(from.atMs, to.atMs)) return null;
    const gameMs = to.gameTimeMs - from.gameTimeMs;
    return { tier, periodMs, fromMs: from.atMs, toMs: to.atMs, receivedMs: to.atMs - from.atMs, gameMs };
  });
}

/**
 * The clocks' moves in a tier's intervals: one clock's interval differing from the other's by more than
 * `CLOCK_STEP_MIN_MS`, the one further from a whole number of rounds having moved (the further from the period, if
 * neither is); then that clock, judged on its own intervals, never short by more than `CLOCK_STEP_STEADY_MS` the
 * interval before (if judged) and after (which must be), and before a step back never long either.
 */
function movesOf(intervals: readonly (SnapshotInterval | null)[]): ClockMove[] {
  const moves: ClockMove[] = [];
  intervals.forEach((interval, index) => {
    if (interval === null) return;
    const { periodMs, receivedMs, gameMs, fromMs, toMs } = interval;
    if (!(Math.abs(receivedMs - gameMs) > CLOCK_STEP_MIN_MS)) return;
    const gameOffMs = Math.abs(offRoundsMs(gameMs, periodMs));
    const brainOffMs = Math.abs(offRoundsMs(receivedMs, periodMs));
    const gameMoved =
      Math.abs(gameOffMs - brainOffMs) > CLOCK_STEP_STEADY_MS
        ? gameOffMs > brainOffMs
        : Math.abs(gameMs - periodMs) >= Math.abs(receivedMs - periodMs);
    const clock = gameMoved ? "game" : "brain";
    const sizeMs = gameMoved ? gameMs - receivedMs : receivedMs - gameMs;
    const excessMs = (neighbour: SnapshotInterval) => clockMsOf(neighbour, clock) - neighbour.periodMs;
    const intervalBefore = intervals[index - 1];
    const intervalAfter = intervals[index + 1];
    if (!intervalAfter || excessMs(intervalAfter) < -CLOCK_STEP_STEADY_MS) return;
    if (intervalBefore && excessMs(intervalBefore) < -CLOCK_STEP_STEADY_MS) return;
    if (sizeMs < 0 && intervalBefore && excessMs(intervalBefore) > CLOCK_STEP_STEADY_MS) return;
    moves.push({ clock, fromMs, toMs, sizeMs });
  });
  return moves;
}

const isSameMove = (move: ClockMove, other: ClockMove) =>
  move.clock === other.clock &&
  Math.sign(move.sizeMs) === Math.sign(other.sizeMs) &&
  Math.abs(move.sizeMs - other.sizeMs) <= CLOCK_STEP_STEADY_MS;

/** Each move both tiers showed once, the narrower interval's, in time order. */
function mergedMoves(moves: readonly ClockMove[]): ClockMove[] {
  const merged: ClockMove[] = [];
  for (const move of [...moves].sort((first, second) => first.fromMs - second.fromMs)) {
    const sameIndex = merged.findIndex((other) => isSameMove(other, move) && overlaps(other, move));
    const same = merged[sameIndex];
    if (same === undefined) merged.push(move);
    else if (move.toMs - move.fromMs < same.toMs - same.fromMs) merged[sameIndex] = move;
  }
  return merged.sort((first, second) => first.fromMs - second.fromMs);
}

/** The clock steps: each game move paired with the brain's like it within `CLOCK_STEP_PAIR_WITHIN_MS`, or alone. */
function clockSteps(moves: readonly ClockMove[]): ClockIncident[] {
  const between = (move: ClockMove) => `${formatIsoTime(move.fromMs)} and ${formatIsoTime(move.toMs)}`;
  const describeFirst = (move: ClockMove) =>
    `the ${move.clock}'s clock ${signedSeconds(move.sizeMs)} between snapshots at ${between(move)}`;
  const describeSecond = (move: ClockMove) =>
    `the ${move.clock}'s ${signedSeconds(move.sizeMs)} between ${between(move)}`;
  const gameClockOf = (...seen: ClockMove[]) => {
    const gameMove = seen.find((move) => move.clock === "game");
    return gameMove === undefined ? {} : { gameClock: { fromMs: gameMove.fromMs, toMs: gameMove.toMs } };
  };
  const paired = new Set<ClockMove>();
  const steps: ClockIncident[] = [];
  for (const move of moves) {
    if (paired.has(move)) continue;
    const partner = moves.find(
      (other) =>
        !paired.has(other) &&
        other.clock !== move.clock &&
        other.fromMs >= move.fromMs &&
        other.fromMs - move.toMs <= CLOCK_STEP_PAIR_WITHIN_MS &&
        Math.sign(other.sizeMs) === Math.sign(move.sizeMs) &&
        Math.abs(other.sizeMs - move.sizeMs) <= CLOCK_STEP_STEADY_MS,
    );
    paired.add(move);
    if (partner === undefined) {
      const otherClock = move.clock === "game" ? "brain" : "game";
      steps.push({
        kind: "clockStep",
        fromMs: move.fromMs,
        toMs: move.toMs,
        sizeMs: move.sizeMs,
        detail: `${describeFirst(move)}; the ${otherClock}'s not seen to move`,
        ...gameClockOf(move),
      });
      continue;
    }
    paired.add(partner);
    steps.push({
      kind: "clockStep",
      fromMs: move.fromMs,
      toMs: partner.toMs,
      sizeMs: (move.clock === "game" ? move : partner).sizeMs,
      detail: `${describeFirst(move)}, ${describeSecond(partner)}`,
      ...gameClockOf(move, partner),
    });
  }
  return steps;
}

/**
 * The page stalls: each tier's intervals later than their period on both clocks by more than its margin, less any
 * clock's moves seen within them (the medium's, unless the tier was retried), the stalls within
 * `PAGE_STALL_SAME_INCIDENT_WITHIN_MS` of each other one incident. A medium interval over fast stalls adds no time to
 * them: theirs are the closer bound.
 */
function pageStalls(
  intervals: readonly (SnapshotInterval | null)[],
  moves: readonly ClockMove[],
  mediumRetried: (fromMs: number, toMs: number) => boolean,
): ClockIncident[] {
  const stallsSeen: StallSeen[] = [];
  for (const interval of intervals) {
    if (interval === null) continue;
    const { tier, periodMs, fromMs, toMs, receivedMs, gameMs } = interval;
    const movedWithin = (clock: ClockMove["clock"]) =>
      moves
        .filter((move) => move.clock === clock && move.fromMs >= fromMs && move.toMs <= toMs)
        .reduce((sum, { sizeMs }) => sum + sizeMs, 0);
    const marginMs =
      tier === "medium" ? PAGE_STALL_MEDIUM_MARGIN_MS : PAGE_STALL_FAST_INTERVAL_MS - SNAPSHOT_TIER_PERIOD_MS.fast;
    const lostMs = Math.min(receivedMs - movedWithin("brain"), gameMs - movedWithin("game")) - periodMs;
    if (!(lostMs > marginMs) || (tier === "medium" && mediumRetried(fromMs, toMs))) continue;
    const apart = formatSeconds(lostMs + periodMs);
    stallsSeen.push({
      tier,
      fromMs,
      toMs,
      lostMs,
      detail: `the ${tier} snapshots ${apart} apart on both clocks (${periodMs / 1000} s due)`,
    });
  }
  const clusters: StallSeen[][] = [];
  let clusterEndMs = Number.NEGATIVE_INFINITY;
  for (const stall of stallsSeen.sort((first, second) => first.fromMs - second.fromMs)) {
    const cluster = clusters.at(-1);
    if (cluster !== undefined && stall.fromMs - clusterEndMs <= PAGE_STALL_SAME_INCIDENT_WITHIN_MS) {
      cluster.push(stall);
      clusterEndMs = Math.max(clusterEndMs, stall.toMs);
    } else {
      clusters.push([stall]);
      clusterEndMs = stall.toMs;
    }
  }
  return clusters.map((cluster) => {
    const fast = cluster.filter((stall) => stall.tier === "fast");
    const medium = cluster.filter((stall) => stall.tier === "medium");
    const mediumAlone = medium.filter((stall) => !fast.some((fastStall) => overlaps(fastStall, stall)));
    const counted = [...fast, ...mediumAlone];
    return {
      kind: "pageStall" as const,
      fromMs: Math.min(...counted.map(({ fromMs }) => fromMs)),
      toMs: Math.max(...counted.map(({ toMs }) => toMs)),
      sizeMs: counted.reduce((sum, { lostMs }) => sum + lostMs, 0),
      detail: [...fast, ...medium].map(({ detail }) => detail).join("; "),
    };
  });
}

/**
 * The clock steps and page stalls in the medium and fast snapshots' times, each tier in the store's order (by receipt,
 * then as stored: so the brain's clock stepping 2 s or more back reorders the fast snapshots, and only the medium tier,
 * 10 s apart, sees a step back of 2 to 10 s), but over a restart (`restartsMs`: the brain or the Agent starting or
 * stopping, a deploy), in time order.
 */
export function findClockIncidents({
  medium,
  fast,
  restartsMs,
}: {
  medium: readonly SnapshotTime[];
  fast: readonly FastSnapshotTime[];
  restartsMs: readonly number[];
}): ClockIncident[] {
  const restartBetween = (fromMs: number, toMs: number) =>
    restartsMs.some((restartMs) => restartMs >= fromMs && restartMs <= toMs);
  const degraded = (point: FastSnapshotTime, tier: string) =>
    Array.isArray(point.degradedTiers) && point.degradedTiers.includes(tier);
  const mediumRetried = (fromMs: number, toMs: number) =>
    fast.some((point) => point.atMs > fromMs && point.atMs <= toMs && degraded(point, "medium"));
  const mediumIntervals = intervalsOf(medium, "medium", restartBetween);
  const fastIntervals = intervalsOf(fast, "fast", restartBetween, (point) => degraded(point, "fast"));
  const moves = mergedMoves([...movesOf(mediumIntervals), ...movesOf(fastIntervals)]);
  const steps = clockSteps(moves);
  const stalls = pageStalls([...mediumIntervals, ...fastIntervals], moves, mediumRetried);
  return [...steps, ...stalls].sort((first, second) => first.fromMs - second.fromMs);
}

/** "a clock step of +2.7 s from … to …", "a page stall of ~3.0 s from … to …". */
export function describeIncident({ kind, sizeMs, fromMs, toMs }: ClockIncident): string {
  const size = kind === "clockStep" ? signedSeconds(sizeMs) : `~${formatSeconds(sizeMs)}`;
  const name = kind === "clockStep" ? "clock step" : "page stall";
  return `a ${name} of ${size} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
}

/**
 * The span the batcher felt an incident over: the game's clock's move for a step it was seen in, or the whole (#249's
 * review: the brain's may follow minutes later, or come first).
 */
export const batcherSpanOf = (incident: ClockIncident): Span =>
  incident.gameClock ?? { fromMs: incident.fromMs, toMs: incident.toMs };

/**
 * Section 4's lines: each incident, and a failure for each stretch of `TOO_MANY_INCIDENTS` or more within
 * `TOO_MANY_INCIDENTS_WITHIN_MS` (each incident in such an hour is in its stretch; stretches an hour apart are two).
 */
export function incidentLines(incidents: readonly ClockIncident[], failures: string[]): string[] {
  const lines = [
    `  clock steps and page stalls (#241: one clock's interval between snapshots off the other's by more than ` +
      `${formatSeconds(CLOCK_STEP_MIN_MS)}, long that once; or the snapshots later than due on both clocks, the ` +
      `medium by more than ${formatSeconds(PAGE_STALL_MEDIUM_MARGIN_MS)}, the fast more than ` +
      `${formatSeconds(PAGE_STALL_FAST_INTERVAL_MS)} apart; ${TOO_MANY_INCIDENTS} or more within an hour fail):`,
  ];
  for (const { kind, fromMs, toMs, sizeMs, detail } of incidents) {
    const span = `from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
    lines.push(
      kind === "clockStep"
        ? `    clock step ${signedSeconds(sizeMs)} ${span}: ${detail}`
        : `    page stalled ~${formatSeconds(sizeMs)} ${span} (cause unknown): ${detail}`,
    );
  }
  if (incidents.length === 0) lines.push("    none");
  const inTooMany = new Set<number>();
  incidents.forEach((incident, index) => {
    const withinAnHour = incidents.filter(
      (other, otherIndex) => otherIndex >= index && other.fromMs - incident.fromMs < TOO_MANY_INCIDENTS_WITHIN_MS,
    );
    if (withinAnHour.length < TOO_MANY_INCIDENTS) return;
    for (let member = index; member < index + withinAnHour.length; member++) inTooMany.add(member);
  });
  const stretches: ClockIncident[][] = [];
  incidents.forEach((incident, index) => {
    if (!inTooMany.has(index)) return;
    const stretch = stretches.at(-1);
    const previous = stretch?.at(-1);
    const continues =
      stretch !== undefined &&
      previous !== undefined &&
      inTooMany.has(index - 1) &&
      incident.fromMs - previous.fromMs < TOO_MANY_INCIDENTS_WITHIN_MS;
    if (continues) stretch.push(incident);
    else stretches.push([incident]);
  });
  for (const stretch of stretches) {
    const first = stretch[0] as ClockIncident;
    const last = stretch.at(-1) as ClockIncident;
    const kindCount = (kind: ClockIncident["kind"], name: string) => {
      const ofKind = stretch.filter((incident) => incident.kind === kind).length;
      return ofKind === 0 ? null : `${ofKind} ${name}${ofKind === 1 ? "" : "s"}`;
    };
    const kinds = [kindCount("clockStep", "clock step"), kindCount("pageStall", "page stall")].filter(
      (kindText) => kindText !== null,
    );
    const line =
      `clock steps or page stalls: ${stretch.length} from ${formatIsoTime(first.fromMs)} to ` +
      `${formatIsoTime(last.toMs)}, ${TOO_MANY_INCIDENTS} or more within an hour (${kinds.join(", ")})`;
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
      list.filter((entry) => entry.atMs <= atMs).at(-1) ?? list[0];
    const servers = newestBy(this.#statics)?.servers ?? [];
    const figures = figuresOf(servers.find((server) => server?.hostname === target));
    const player = newestBy(this.#players)?.player;
    if (figures === null || player === undefined) return null;
    const weakenMs = operationTimeMs("weaken1", figures, player);
    return Number.isFinite(weakenMs) && weakenMs > 0 ? weakenMs : null;
  }
}
