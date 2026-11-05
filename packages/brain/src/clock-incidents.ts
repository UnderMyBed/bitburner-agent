// Clock steps and page stalls (#241): what, outside the software, makes a batcher's landings look out of order. Run
// #3 (2026-11-05) had a clock step: Windows stepped the PC's clock +2,678 ms at 17:11:33.5Z (its event log), the
// game's process took it up at about 17:11:46 and the brain's at about 17:12:08 (each resyncs its wall clock now and
// then); the batcher, judging landings by `Date.now()`, saw every part in flight 2.7 s late, and 1,615 desyncs on
// the-hub followed, which it recovered from by itself in 95 s (its own fix is #251). A page stall, the page not
// running its scripts for seconds, would do the same. The run report finds both in the store's snapshots (section 4),
// fails 3 or more in an hour, and section 6 puts a batcher's desyncs down to one within a weaken's time before them
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
 * A clock step: between two snapshots of a tier, the brain's receipt clock less the game's moving by more than this.
 * Each snapshot is received within tens of ms of being taken (the round's worker, then the socket), so the gap holds
 * steady to well within it; a step this size is over twice the slack a batcher's operations had in run #3 (178 ms),
 * so smaller ones that still desync it are left to the batcher's own fix (#251). Run #3's was 2,678 ms.
 */
export const CLOCK_STEP_MIN_MS = 500;
/**
 * And the gap must hold, within this, over the interval before and the one after: a step stays, where a snapshot
 * received late (the brain busy) moves the gap and moves it back.
 */
export const CLOCK_STEP_STEADY_MS = CLOCK_STEP_MIN_MS / 2;
/**
 * The game's clock and the brain's moving the same way by the same amount (within `CLOCK_STEP_STEADY_MS`) this close
 * together are one step, which each process took up at its own moment: V8 and Chromium each resync their wall clock
 * with the system's now and then, not at every read. Run #3's were 20 s apart.
 */
export const CLOCK_STEP_PAIR_WITHIN_MS = 5 * 60_000;
/**
 * A page stall: two medium snapshots further apart on both clocks than their 10 s by more than this, one round of the
 * Agent's (the fast tier's 2 s). A medium snapshot a round late is the tier's worker failing and retried next round (a
 * fast snapshot between says the tier degraded, and that interval isn't judged), or rounds that ran a little over
 * their 2 s, each bounded by its workers' deadlines (ingame `agent/snapshotter.ts`, `takeRound`).
 */
export const PAGE_STALL_MEDIUM_MARGIN_MS = SNAPSHOT_TIER_PERIOD_MS.fast;
/**
 * Or two fast snapshots further apart on both clocks than this: two rounds, so a whole round lost, which a round's own
 * deadlines never lose. Below the heartbeat's gap (6 s, `DEFAULT_GAP_THRESHOLD_MS`), so a stall shows before a gap.
 */
export const PAGE_STALL_FAST_INTERVAL_MS = 2 * SNAPSHOT_TIER_PERIOD_MS.fast;
/** Stalls this close together (from one's end to the next's start) are one incident, their lengths added. */
export const PAGE_STALL_SAME_INCIDENT_WITHIN_MS = 60_000;
/**
 * A batcher's first desync (or late or lost operation) is an incident's if it's seen from the incident's start to this
 * many of its target's weaken times after its end: every part in flight then lands within one weaken (an operation's
 * longest time, 4 hacks, Hacking.ts:89-93). An incident explains the first such stretch only.
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
 * at `fromMs` and `toMs`, and what showed it.
 */
export interface ClockIncident {
  kind: "clockStep" | "pageStall";
  fromMs: number;
  toMs: number;
  sizeMs: number;
  detail: string;
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

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const offsetChangeMs = ({ receivedMs, gameMs }: SnapshotInterval) => receivedMs - gameMs;
/** "+2.7 s", "−1.0 s". */
const signedSeconds = (ms: number) => `${ms >= 0 ? "+" : "−"}${formatSeconds(Math.abs(ms))}`;
const overlap = (a: { fromMs: number; toMs: number }, b: { fromMs: number; toMs: number }) =>
  a.fromMs < b.toMs && b.fromMs < a.toMs;

/** A tier's intervals, null where they can't be judged: over a restart, or with no game time (an older store's 0). */
function intervalsOf(
  points: readonly SnapshotTime[],
  tier: SnapshotInterval["tier"],
  restartBetween: (fromMs: number, toMs: number) => boolean,
): (SnapshotInterval | null)[] {
  const periodMs = SNAPSHOT_TIER_PERIOD_MS[tier];
  return points.slice(1).map((to, index) => {
    const from = points[index] as SnapshotTime;
    if (!(from.gameTimeMs > 0) || !(to.gameTimeMs > 0) || restartBetween(from.atMs, to.atMs)) return null;
    const gameMs = to.gameTimeMs - from.gameTimeMs;
    return { tier, periodMs, fromMs: from.atMs, toMs: to.atMs, receivedMs: to.atMs - from.atMs, gameMs };
  });
}

/**
 * The clocks' moves in a tier's intervals: the gap between the clocks moving by more than `CLOCK_STEP_MIN_MS` and
 * holding within `CLOCK_STEP_STEADY_MS` over the interval before (if judged) and after (which must be). The clock that
 * moved is the one whose interval is further from the tier's period.
 */
function movesOf(intervals: readonly (SnapshotInterval | null)[]): ClockMove[] {
  const moves: ClockMove[] = [];
  intervals.forEach((interval, index) => {
    if (interval === null || !(Math.abs(offsetChangeMs(interval)) > CLOCK_STEP_MIN_MS)) return;
    const intervalBefore = intervals[index - 1];
    const intervalAfter = intervals[index + 1];
    if (intervalBefore && Math.abs(offsetChangeMs(intervalBefore)) > CLOCK_STEP_STEADY_MS) return;
    if (!intervalAfter || Math.abs(offsetChangeMs(intervalAfter)) > CLOCK_STEP_STEADY_MS) return;
    const { periodMs, receivedMs, gameMs, fromMs, toMs } = interval;
    const gameMoved = Math.abs(gameMs - periodMs) >= Math.abs(receivedMs - periodMs);
    moves.push({
      clock: gameMoved ? "game" : "brain",
      fromMs,
      toMs,
      sizeMs: gameMoved ? gameMs - receivedMs : receivedMs - gameMs,
    });
  });
  return moves;
}

const sameMove = (a: ClockMove, b: ClockMove) =>
  a.clock === b.clock &&
  Math.sign(a.sizeMs) === Math.sign(b.sizeMs) &&
  Math.abs(a.sizeMs - b.sizeMs) <= CLOCK_STEP_STEADY_MS;

/** The clock steps: each move both tiers showed once (the narrower interval), a game move paired with the brain's. */
function clockSteps(moves: readonly ClockMove[]): ClockIncident[] {
  const merged: ClockMove[] = [];
  for (const move of [...moves].sort((a, b) => a.fromMs - b.fromMs)) {
    const sameIndex = merged.findIndex((other) => sameMove(other, move) && overlap(other, move));
    if (sameIndex === -1) merged.push(move);
    else if (
      move.toMs - move.fromMs <
      (merged[sameIndex] as ClockMove).toMs - (merged[sameIndex] as ClockMove).fromMs
    ) {
      merged[sameIndex] = move;
    }
  }
  merged.sort((a, b) => a.fromMs - b.fromMs);
  const between = (move: ClockMove) => `${formatIsoTime(move.fromMs)} and ${formatIsoTime(move.toMs)}`;
  const describeFirst = (move: ClockMove) =>
    `the ${move.clock}'s clock ${signedSeconds(move.sizeMs)} between snapshots at ${between(move)}`;
  const describeSecond = (move: ClockMove) =>
    `the ${move.clock}'s ${signedSeconds(move.sizeMs)} between ${between(move)}`;
  const paired = new Set<ClockMove>();
  const steps: ClockIncident[] = [];
  for (const move of merged) {
    if (paired.has(move)) continue;
    const partner = merged.find(
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
      const other = move.clock === "game" ? "brain" : "game";
      steps.push({
        kind: "clockStep",
        fromMs: move.fromMs,
        toMs: move.toMs,
        sizeMs: move.sizeMs,
        detail: `${describeFirst(move)}; the ${other}'s not seen to move`,
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
    });
  }
  return steps;
}

/**
 * The page stalls: each tier's intervals further apart on both clocks than their period by more than its margin (the
 * medium's, unless the tier was retried), the stalls within `PAGE_STALL_SAME_INCIDENT_WITHIN_MS` of each other one
 * incident. A medium interval over fast stalls adds no time to them: theirs are the closer bound.
 */
function pageStalls(
  intervals: readonly (SnapshotInterval | null)[],
  mediumRetried: (fromMs: number, toMs: number) => boolean,
): ClockIncident[] {
  const stallsSeen: StallSeen[] = [];
  for (const interval of intervals) {
    if (interval === null) continue;
    const { tier, periodMs, fromMs, toMs, receivedMs, gameMs } = interval;
    const marginMs =
      tier === "medium" ? PAGE_STALL_MEDIUM_MARGIN_MS : PAGE_STALL_FAST_INTERVAL_MS - SNAPSHOT_TIER_PERIOD_MS.fast;
    const lostMs = Math.min(receivedMs, gameMs) - periodMs;
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
  for (const stall of stallsSeen.sort((a, b) => a.fromMs - b.fromMs)) {
    const last = clusters.at(-1);
    if (last !== undefined && stall.fromMs - clusterEndMs <= PAGE_STALL_SAME_INCIDENT_WITHIN_MS) {
      last.push(stall);
      clusterEndMs = Math.max(clusterEndMs, stall.toMs);
    } else {
      clusters.push([stall]);
      clusterEndMs = stall.toMs;
    }
  }
  return clusters.map((cluster) => {
    const fast = cluster.filter((stall) => stall.tier === "fast");
    const medium = cluster.filter((stall) => stall.tier === "medium");
    const bounds = fast.length > 0 ? fast : medium;
    const mediumAlone = medium.filter((stall) => !fast.some((each) => overlap(each, stall)));
    return {
      kind: "pageStall" as const,
      fromMs: Math.min(...bounds.map(({ fromMs }) => fromMs)),
      toMs: Math.max(...bounds.map(({ toMs }) => toMs)),
      sizeMs: [...fast, ...mediumAlone].reduce((sum, { lostMs }) => sum + lostMs, 0),
      detail: [...fast, ...medium].map(({ detail }) => detail).join("; "),
    };
  });
}

/**
 * The clock steps and page stalls in the medium and fast snapshots' times (each in the brain's order of receipt), but
 * over a restart (`restartsMs`: the brain or the Agent starting or stopping, a deploy), in time order.
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
  const restartBetween = (fromMs: number, toMs: number) => restartsMs.some((each) => each >= fromMs && each <= toMs);
  const mediumRetried = (fromMs: number, toMs: number) =>
    fast.some(
      ({ atMs, degradedTiers }) =>
        atMs > fromMs && atMs <= toMs && Array.isArray(degradedTiers) && degradedTiers.includes("medium"),
    );
  const mediumIntervals = intervalsOf(medium, "medium", restartBetween);
  const fastIntervals = intervalsOf(fast, "fast", restartBetween);
  const steps = clockSteps([...movesOf(mediumIntervals), ...movesOf(fastIntervals)]);
  const stalls = pageStalls([...mediumIntervals, ...fastIntervals], mediumRetried);
  return [...steps, ...stalls].sort((a, b) => a.fromMs - b.fromMs);
}

/** "a clock step of +2.7 s from … to …", "a page stall of ~3.0 s from … to …". */
export function describeIncident({ kind, sizeMs, fromMs, toMs }: ClockIncident): string {
  const size = kind === "clockStep" ? signedSeconds(sizeMs) : `~${formatSeconds(sizeMs)}`;
  const name = kind === "clockStep" ? "clock step" : "page stall";
  return `a ${name} of ${size} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
}

/**
 * Section 4's lines: each incident, and a failure for each stretch of `TOO_MANY_INCIDENTS` or more within
 * `TOO_MANY_INCIDENTS_WITHIN_MS` (each incident in such an hour is in its stretch; stretches an hour apart are two).
 */
export function incidentLines(incidents: readonly ClockIncident[], failures: string[]): string[] {
  const lines = [
    `  clock steps and page stalls (#241: the gap between the game's clock and the brain's moving more than ` +
      `${formatSeconds(CLOCK_STEP_MIN_MS)} and holding; or the snapshots further apart on both clocks than due, the ` +
      `medium by more than ${formatSeconds(PAGE_STALL_MEDIUM_MARGIN_MS)}, the fast by more than ` +
      `${formatSeconds(PAGE_STALL_FAST_INTERVAL_MS)}; ${TOO_MANY_INCIDENTS} or more within an hour fail):`,
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
    for (let each = index; each < index + withinAnHour.length; each++) inTooMany.add(each);
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
    const count = (kind: ClockIncident["kind"], name: string) => {
      const number = stretch.filter((each) => each.kind === kind).length;
      return number === 0 ? null : `${number} ${name}${number === 1 ? "" : "s"}`;
    };
    const kinds = [count("clockStep", "clock step"), count("pageStall", "page stall")].filter((each) => each !== null);
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
      list.filter((each) => each.atMs <= atMs).at(-1) ?? list[0];
    const servers = newestBy(this.#statics)?.servers ?? [];
    const figures = figuresOf(servers.find((server) => server?.hostname === target));
    const player = newestBy(this.#players)?.player;
    if (figures === null || player === undefined) return null;
    const weakenMs = operationTimeMs("weaken1", figures, player);
    return Number.isFinite(weakenMs) && weakenMs > 0 ? weakenMs : null;
  }
}
