// Clock steps, page stalls (#241) and delivery lags (#309): what, outside the batcher, makes its landings look out of
// order. Run #3
// (2026-11-05) had a clock step: Windows stepped the PC's clock +2,678 ms at 17:11:33.5Z (its event log), the game's
// process took it up at about 17:11:46 and the brain's at about 17:12:08 (each resyncs its wall clock now and then);
// the batcher, then judging landings by `Date.now()`, saw every part in flight 2.7 s late, and 1,615 desyncs on the-hub
// followed, which it recovered from by itself in 95 s. Since #251 the batcher times them on the page's monotonic clock,
// which a step doesn't move: a step explains only an older batcher's desyncs (its health has no `clock`). A page
// stall, the page not running its scripts for seconds (its cause unknown: the PC, the game, or a script of ours),
// still would. A delivery lag (#309) is neither: the snapshots stamped on time by the page and received late by the
// brain, both stamps this PC's `Date.now()`, one clock. The live run of 2026-11-08 had them up to 0.7 s, read as
// clock steps: the dashboard's status, polled every 2 s, sorted every fast snapshot in the store for the newest
// (0.65 s on its 440 MB store, the brain's event loop held meanwhile), and the Agent's rounds, a few ms over 2 s each,
// slid through that hold one round at a time, so each backlog drained over minutes. The run report finds all three in
// the store's snapshots (section 4), fails 3 or more in an hour, and section 6 puts a batcher's desyncs down to one
// within a weaken's time before them (./batcher-report.ts): a warning, not a failure, once the batcher is batching
// again (owner decision 55).
import {
  type HackingPlayer,
  type HackingTarget,
  type MediumSnapshotData,
  operationTimeMs,
  SNAPSHOT_TIER_PERIOD_MS,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { hackingPlayerOf } from "./batcher.ts";
import { formatDuration, formatIsoTime, formatSeconds } from "./gap-report.ts";

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
/**
 * A delivery lag (#309): a medium or fast snapshot received more than this after its stamp, the page's `Date.now()` as
 * its worker reported (`report-to-agent.ts`), on the same PC as the brain's receipt. Each is received within tens of ms
 * otherwise (20 to 30 ms in the 2026-11-08 run); a page stall doesn't delay one, its stamp waiting too.
 */
export const DELIVERY_LAG_MIN_MS = 200;
/**
 * Snapshots late again within this of a delivery lag's drain are the same lag: as the Agent's rounds slide into the
 * brain's hold, a round's snapshots a few ms either side of its start are caught or not (2026-11-08's backlogs drained
 * and were late again 2 to 5 s later, 3 times). A medium tier's period: the brain's other holds were a minute and 30 s
 * apart (the dashboard's polls in a hidden tab, the supervisor's checks).
 */
export const DELIVERY_LAG_SAME_WITHIN_MS = SNAPSHOT_TIER_PERIOD_MS.medium;
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
 * and nothing is out of step for this long after (owner decision 55). Run #3's took 95 s. Since #315 a recovery is in
 * place: the hacks out land (a hack's time) and the held batches refill the target, within core's `recoveryInPlaceMs`
 * (a weaken's time and 10 batches, minutes on most targets), past which it prepares the target again.
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

/**
 * A fast snapshot's time, with the tiers it says failed last round (absent from a malformed one), and the page's
 * `Date.now()` as the Agent sent it (#309: absent from an older Agent, or a thinned one's stub).
 */
export interface FastSnapshotTime extends SnapshotTime {
  degradedTiers?: unknown;
  sentAtMs?: unknown;
}

/**
 * A clock step (`sizeMs` the clock's move, + on), a page stall (`sizeMs` the time lost) or a delivery lag (`sizeMs`
 * the most a snapshot was late, #309), between snapshots received at `fromMs` and `toMs`, and what showed it; for a
 * step, when the game's clock moved, if it was seen to (`gameClock`): the moment an older batcher, on the wall clock,
 * felt it (one since #251 doesn't). A delivery lag's `pageLagMs`: the most the Agent took over a late fast snapshot,
 * from its worker's report to its send, or null where none says (an older Agent's).
 */
export interface ClockIncident {
  kind: "clockStep" | "pageStall" | "deliveryLag";
  fromMs: number;
  toMs: number;
  sizeMs: number;
  detail: string;
  gameClock?: { fromMs: number; toMs: number };
  pageLagMs?: number | null;
}

/**
 * Snapshots received late (#309), from the first received more than `DELIVERY_LAG_MIN_MS` after its stamp
 * (`fromMs`) to the first fast snapshot on time after (`drainedAtMs`; null if a restart (`cutByRestart`) or the
 * window's end came first, `toMs` then the last late one's receipt; `lateAtStart` if the window's first snapshot
 * was late already, so it began before). A backlog if it outlasted a round (late snapshots stamped in more than one),
 * else brief: the snapshots of one round, late once. `lateCount` the snapshots late, `fastLateCount` the fast ones
 * of them; `lateMs` the most one was late, `leastLateMs` the least; `pageLagMs` the most the Agent took over a late
 * fast snapshot, its send's stamp less its worker's, or null where none says.
 */
export interface DeliveryLag {
  fromMs: number;
  toMs: number;
  drainedAtMs: number | null;
  cutByRestart: boolean;
  lateAtStart: boolean;
  lateCount: number;
  fastLateCount: number;
  lateMs: number;
  leastLateMs: number;
  backlog: boolean;
  pageLagMs: number | null;
}

/** What section 4 and section 6 call each kind of incident. */
export const INCIDENT_KIND_NAMES: Record<ClockIncident["kind"], string> = {
  clockStep: "clock step",
  pageStall: "page stall",
  deliveryLag: "delivery lag",
};

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

/** Each move in time order with the other clock's like it within `CLOCK_STEP_PAIR_WITHIN_MS` after, or alone. */
function pairsOf(moves: readonly ClockMove[]): { move: ClockMove; partner: ClockMove | undefined }[] {
  const taken = new Set<ClockMove>();
  const pairs: { move: ClockMove; partner: ClockMove | undefined }[] = [];
  for (const move of moves) {
    if (taken.has(move)) continue;
    const partner = moves.find(
      (other) =>
        !taken.has(other) &&
        other.clock !== move.clock &&
        other.fromMs >= move.fromMs &&
        other.fromMs - move.toMs <= CLOCK_STEP_PAIR_WITHIN_MS &&
        Math.sign(other.sizeMs) === Math.sign(move.sizeMs) &&
        Math.abs(other.sizeMs - move.sizeMs) <= CLOCK_STEP_STEADY_MS,
    );
    taken.add(move);
    if (partner !== undefined) taken.add(partner);
    pairs.push({ move, partner });
  }
  return pairs;
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
  const steps: ClockIncident[] = [];
  for (const { move, partner } of pairsOf(moves)) {
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

/** A delivery lag as found, with the receipt before its first late snapshot (its onset's interval), if judged. */
interface LagSeen extends DeliveryLag {
  beforeMs: number;
}

/**
 * The delivery lags (#309) in the medium and fast snapshots (a fast one whose worker failed left out, stamped at its
 * round's start), in order of receipt: each opened by a snapshot more than `DELIVERY_LAG_MIN_MS` late, drained by the
 * next fast one on time (the medium snapshot, sent after the fast in its round, drains first and isn't trusted to)
 * with none late within `DELIVERY_LAG_SAME_WITHIN_MS` after, cut at a restart. One `explained` (a clock step's moves
 * in it) is the step's, not a lag.
 */
function deliveryLagsOf(
  medium: readonly SnapshotTime[],
  fast: readonly FastSnapshotTime[],
  usableFast: (point: FastSnapshotTime) => boolean,
  restartBetween: (fromMs: number, toMs: number) => boolean,
  explained: (span: Span) => boolean,
): LagSeen[] {
  const points = [
    ...medium.map((point) => ({ point, isFast: false })),
    ...fast.filter(usableFast).map((point) => ({ point: point as FastSnapshotTime, isFast: true })),
  ]
    .filter(({ point }) => point.gameTimeMs > 0)
    .sort((first, second) => first.point.atMs - second.point.atMs);
  const lags: LagSeen[] = [];
  let open: (LagSeen & { firstGameMs: number; lastGameMs: number; drainingAtMs: number | null }) | null = null;
  const close = (cutByRestart: boolean) => {
    if (open === null) return;
    const { firstGameMs, lastGameMs, drainingAtMs: drainedAtMs, ...lag } = open;
    const backlog = lastGameMs - firstGameMs > SNAPSHOT_TIER_PERIOD_MS.fast / 2;
    const seen = {
      ...lag,
      drainedAtMs,
      cutByRestart: drainedAtMs === null && cutByRestart,
      toMs: drainedAtMs ?? lag.toMs,
      backlog,
    };
    if (!explained({ fromMs: seen.beforeMs, toMs: seen.toMs })) lags.push(seen);
    open = null;
  };
  let previous: SnapshotTime | null = null;
  for (const { point, isFast } of points) {
    const restarted = previous !== null && restartBetween(previous.atMs, point.atMs);
    if (restarted) close(true);
    const drainingAtMs = open?.drainingAtMs ?? null;
    if (drainingAtMs !== null && point.atMs - drainingAtMs > DELIVERY_LAG_SAME_WITHIN_MS) close(false);
    const lateMs = point.atMs - point.gameTimeMs;
    if (lateMs > DELIVERY_LAG_MIN_MS) {
      const sentAtMs = (point as FastSnapshotTime).sentAtMs;
      const pageLagMs = isFast && isFiniteNumber(sentAtMs) ? sentAtMs - point.gameTimeMs : null;
      open ??= {
        fromMs: point.atMs,
        toMs: point.atMs,
        beforeMs: previous === null || restarted ? point.atMs : previous.atMs,
        drainedAtMs: null,
        cutByRestart: false,
        lateAtStart: previous === null,
        lateCount: 0,
        fastLateCount: 0,
        lateMs,
        leastLateMs: lateMs,
        backlog: false,
        pageLagMs: null,
        firstGameMs: point.gameTimeMs,
        lastGameMs: point.gameTimeMs,
        drainingAtMs: null,
      };
      open.drainingAtMs = null;
      open.toMs = point.atMs;
      open.lateCount += 1;
      if (isFast) open.fastLateCount += 1;
      open.lateMs = Math.max(open.lateMs, lateMs);
      open.leastLateMs = Math.min(open.leastLateMs, lateMs);
      open.firstGameMs = Math.min(open.firstGameMs, point.gameTimeMs);
      open.lastGameMs = Math.max(open.lastGameMs, point.gameTimeMs);
      if (pageLagMs !== null) open.pageLagMs = Math.max(open.pageLagMs ?? pageLagMs, pageLagMs);
    } else if (isFast && open !== null) {
      open.drainingAtMs ??= point.atMs;
    }
    previous = point;
  }
  close(false);
  return lags;
}

/** What the clocks show, read once for the incidents and the delivery lags alike. */
function readClocks({
  medium,
  fast,
  restartsMs,
}: {
  medium: readonly SnapshotTime[];
  fast: readonly FastSnapshotTime[];
  restartsMs: readonly number[];
}) {
  const restartBetween = (fromMs: number, toMs: number) =>
    restartsMs.some((restartMs) => restartMs >= fromMs && restartMs <= toMs);
  const degraded = (point: FastSnapshotTime, tier: string) =>
    Array.isArray(point.degradedTiers) && point.degradedTiers.includes(tier);
  const mediumRetried = (fromMs: number, toMs: number) =>
    fast.some((point) => point.atMs > fromMs && point.atMs <= toMs && degraded(point, "medium"));
  const mediumIntervals = intervalsOf(medium, "medium", restartBetween);
  const fastIntervals = intervalsOf(fast, "fast", restartBetween, (point) => degraded(point, "fast"));
  const allMoves = mergedMoves([...movesOf(mediumIntervals), ...movesOf(fastIntervals)]);
  // A lag the clocks explain is theirs: a step's moves (a pair's, or the game's alone) within it. The brain's clock
  // taking a step up before the game's makes the snapshots look late until the game's does.
  const pairs = pairsOf(allMoves);
  const stepMoves = allMoves.filter(
    (move) =>
      move.clock === "game" ||
      pairs.some((pair) => pair.partner !== undefined && (pair.move === move || pair.partner === move)),
  );
  const lags = deliveryLagsOf(
    medium,
    fast,
    (point) => !degraded(point, "fast"),
    restartBetween,
    (span) => stepMoves.some((move) => overlaps(move, span)),
  );
  // The brain's clock long as a lag starts, short as it drains, is the lag, not a step: a move of the brain's alone
  // within one is dropped.
  const moves = allMoves.filter(
    (move) => stepMoves.includes(move) || !lags.some((lag) => overlaps(move, { fromMs: lag.beforeMs, toMs: lag.toMs })),
  );
  return { moves, lags, intervals: [...mediumIntervals, ...fastIntervals], mediumRetried };
}

/**
 * The delivery lags (#309) in the medium and fast snapshots' times, backlogs and brief ones, in time order, as
 * `findClockIncidents` reads them.
 */
export function findDeliveryLags(input: Parameters<typeof readClocks>[0]): DeliveryLag[] {
  return readClockIncidents(input).lags;
}

/**
 * A lag never drained, its snapshots late by the same amount throughout (within `CLOCK_STEP_STEADY_MS`), of more than
 * `CLOCK_STEP_MIN_MS`: the brain's clock stepping on alone, the game's not seen to follow before the window's end or
 * a restart, reads the same, so the line says so. Under `CLOCK_STEP_MIN_MS` it's a lag only: a step that small isn't
 * one.
 */
const steadyAndUndrained = (lag: DeliveryLag) =>
  lag.drainedAtMs === null && lag.lateMs > CLOCK_STEP_MIN_MS && lag.lateMs - lag.leastLateMs <= CLOCK_STEP_STEADY_MS;

/**
 * A backlog's line text after its span (#309): whether it could be a clock step, how many were late, how long it took
 * to drain, and whose it was. The Agent's share ends at its send stamp, taken as it builds the fast snapshot: its
 * encoding and the send fall on the far side, with the socket's and the brain's.
 */
function describeBacklog(lag: DeliveryLag): string {
  const kind = steadyAndUndrained(lag)
    ? `(or a clock step, the brain's alone: steady at about ${formatSeconds(lag.lateMs)}, never drained)`
    : "(not a clock step)";
  const start = lag.lateAtStart ? "already late at the window's start, " : "";
  const drained =
    lag.drainedAtMs !== null
      ? `drained in ${lag.lateAtStart ? "at least " : ""}${formatDuration(lag.drainedAtMs - lag.fromMs)}`
      : lag.cutByRestart
        ? "cut by a restart before it drained"
        : "not drained by the window's end";
  const side =
    lag.pageLagMs !== null
      ? `the Agent's share at most ${formatSeconds(lag.pageLagMs)} (its worker's report to its send stamp), the ` +
        "rest its encoding's, the socket's and the brain's"
      : lag.fastLateCount === 0
        ? "whose, unknown (no fast snapshot late in it to tell)"
        : "whose, unknown (no send stamps: an Agent before #309)";
  return `${kind}: ${lag.lateCount} snapshots received late, ${start}${drained}; ${side}`;
}

/**
 * The clock steps, page stalls and delivery lags (backlogs only, #309) in the medium and fast snapshots' times, each
 * tier in the store's order (by receipt, then as stored: so the brain's clock stepping 2 s or more back reorders the
 * fast snapshots, and only the medium tier, 10 s apart, sees a step back of 2 to 10 s), but over a restart
 * (`restartsMs`: the brain or the Agent starting or stopping, a deploy), in time order.
 */
export function findClockIncidents(input: Parameters<typeof readClocks>[0]): ClockIncident[] {
  return readClockIncidents(input).incidents;
}

/** The incidents and every delivery lag, backlog or brief, from one read of the clocks (the run report's). */
export function readClockIncidents(input: Parameters<typeof readClocks>[0]): {
  incidents: ClockIncident[];
  lags: DeliveryLag[];
} {
  const { moves, lags, intervals, mediumRetried } = readClocks(input);
  const steps = clockSteps(moves);
  const stalls = pageStalls(intervals, moves, mediumRetried);
  const backlogs = lags
    .filter((lag) => lag.backlog)
    .map(
      (lag): ClockIncident => ({
        kind: "deliveryLag",
        fromMs: lag.fromMs,
        toMs: lag.toMs,
        sizeMs: lag.lateMs,
        detail: describeBacklog(lag),
        pageLagMs: lag.pageLagMs,
      }),
    );
  const incidents = [...steps, ...stalls, ...backlogs].sort((first, second) => first.fromMs - second.fromMs);
  return { incidents, lags: lags.map(({ beforeMs: _beforeMs, ...lag }) => lag) };
}

/**
 * Whether an incident can put a batcher on the page's monotonic clock out of step (#251): a page stall, or a delivery
 * lag (#309) the Agent's send stamps show was the page's (its share over `DELIVERY_LAG_MIN_MS`). One whose side they
 * can't tell (none, from an Agent before #309, or no fast snapshot late in it) excuses nothing: every such lag seen
 * was the brain's (2026-11-08's, its dashboard's status), which can't move the page's clock. The 2026-11-08 clarkinc
 * desyncs inside one stay a failure; their cause is #315.
 */
export const holdsThePage = (incident: ClockIncident): boolean =>
  incident.kind === "pageStall" ||
  (incident.kind === "deliveryLag" &&
    typeof incident.pageLagMs === "number" &&
    incident.pageLagMs > DELIVERY_LAG_MIN_MS);

/** "a clock step of +2.7 s from … to …", "a page stall of ~3.0 s from … to …", "a delivery lag of up to 0.6 s …". */
export function describeIncident({ kind, sizeMs, fromMs, toMs }: ClockIncident): string {
  const span = `from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
  const size =
    kind === "clockStep"
      ? signedSeconds(sizeMs)
      : kind === "deliveryLag"
        ? `up to ${formatSeconds(sizeMs)}`
        : `~${formatSeconds(sizeMs)}`;
  return `a ${INCIDENT_KIND_NAMES[kind]} of ${size} ${span}`;
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
export function incidentLines(
  incidents: readonly ClockIncident[],
  failures: string[],
  briefLags: readonly DeliveryLag[] = [],
): string[] {
  const lines = [
    `  clock steps, page stalls and delivery lags (#241: one clock's interval between snapshots off the other's by ` +
      `more than ${formatSeconds(CLOCK_STEP_MIN_MS)}, long that once; or the snapshots later than due on both ` +
      `clocks, the medium by more than ${formatSeconds(PAGE_STALL_MEDIUM_MARGIN_MS)}, the fast more than ` +
      `${formatSeconds(PAGE_STALL_FAST_INTERVAL_MS)} apart; #309: or snapshots received over ` +
      `${formatSeconds(DELIVERY_LAG_MIN_MS)} after the page stamped them, one PC's clock, in more than one round; ` +
      `${TOO_MANY_INCIDENTS} or more within an hour fail):`,
  ];
  for (const { kind, fromMs, toMs, sizeMs, detail } of incidents) {
    const span = `from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
    lines.push(
      kind === "clockStep"
        ? `    clock step ${signedSeconds(sizeMs)} ${span}: ${detail}`
        : kind === "deliveryLag"
          ? `    delivery lag up to ${formatSeconds(sizeMs)} ${span} ${detail}`
          : `    page stalled ~${formatSeconds(sizeMs)} ${span} (cause unknown): ${detail}`,
    );
  }
  if (incidents.length === 0) lines.push("    none");
  // The brief ones (#309), a round's snapshots late once, counted apart: held under a round, the next on time.
  if (briefLags.length > 0) {
    const worst = briefLags.reduce((most, lag) => (lag.lateMs > most.lateMs ? lag : most));
    lines.push(
      `    brief delivery lags (a round's snapshots late once, not counted): ${briefLags.length}, the worst ` +
        `${formatSeconds(worst.lateMs)} at ${formatIsoTime(worst.fromMs)}`,
    );
  }
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
    const kindCount = (kind: ClockIncident["kind"]) => {
      const ofKind = stretch.filter((incident) => incident.kind === kind).length;
      return ofKind === 0 ? null : `${ofKind} ${INCIDENT_KIND_NAMES[kind]}${ofKind === 1 ? "" : "s"}`;
    };
    const kinds = [kindCount("clockStep"), kindCount("pageStall"), kindCount("deliveryLag")].filter(
      (kindText) => kindText !== null,
    );
    const line =
      `clock steps, page stalls or delivery lags: ${stretch.length} from ${formatIsoTime(first.fromMs)} to ` +
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
