// The run report's batcher section (#205): what the batcher's health in the fast snapshots says, hour by hour, and its
// desyncs and problems; out of step (a desync, or an operation late or lost) fails the run (#206), and so does a batch
// short of RAM, except while sharing on the batches' hosts, the share's failure (#232). Its counts are each run's,
// from 0 when it starts (a new run has another `runName`), so each hour adds up each run's rises within it; a run
// already under way at the window's first snapshot counts from there. Its sharing's lines are ./share-report.ts's
// (#224). Out of step is judged a stretch at a time (#241): one a game freeze explains, which the batcher recovered from
// by itself, is a warning (owner decision 55, ./game-freeze.ts).
import { type BatcherHealth, LANDING_LOST_AFTER_MS } from "@bitburner-agent/core";
import { BATCHER_MOVE_IDLE_FAILS_AFTER_MS, BATCHER_NOT_RUNNING_AFTER, batcherNotRunning } from "./batcher.ts";
import {
  BATCHER_FREEZE_RECOVERY_MS,
  describeFreezeLength,
  FREEZE_ATTRIBUTION_WEAKENS,
  type GameFreeze,
} from "./game-freeze.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import { sharingOf } from "./share.ts";
import { type ReputationPoint, sharingLines } from "./share-report.ts";

/** One fast snapshot's batcher health, as stored (the Agent's word: checked as it's read). */
export interface BatcherPoint {
  atMs: number;
  health: unknown;
  /** The deploy worker's last report while the batcher was wanted (#211); absent from an older Agent. */
  deploy?: unknown;
}

/** The counts added up per hour. */
const COUNTS = [
  "batchesStarted",
  "hacksLanded",
  "hacksFailed",
  "hacksSkipped",
  "moneyHacked",
  "desyncs",
  "outOfOrder",
  "outOfBounds",
  "late",
  "lost",
  "batchesShort",
  "unexpected",
] as const;
/**
 * Counts an older batcher's health lacks, as 0: the batches trimmed to the RAM, and of them the share's (#232); its
 * looks at the target's money after each batch's grow, those below its maximum (#234), and the grows not looked at
 * (#235's review).
 */
const NEWER_COUNTS = [
  "batchesTrimmed",
  "batchesTrimmedBySharing",
  "moneyLooks",
  "moneyLooksBelowFull",
  "growsNotLooked",
] as const;
const ALL_COUNTS = [...COUNTS, ...NEWER_COUNTS] as const;
type Counts = Record<(typeof ALL_COUNTS)[number], number>;

const HOUR_MS = 60 * 60_000;

/** A stored health, or null if it isn't one (every count a number, a run name and a state). */
function healthOf(value: unknown): BatcherHealth | null {
  if (typeof value !== "object" || value === null) return null;
  const health = value as Record<string, unknown>;
  if (typeof health.runName !== "string" || typeof health.state !== "string") return null;
  return COUNTS.every((count) => typeof health[count] === "number" && Number.isFinite(health[count]))
    ? (value as BatcherHealth)
    : null;
}

const zero = (): Counts => Object.fromEntries(ALL_COUNTS.map((count) => [count, 0])) as Counts;
const countsOf = (health: BatcherHealth): Counts =>
  Object.fromEntries(
    ALL_COUNTS.map((count) => {
      const value = health[count];
      return [count, typeof value === "number" && Number.isFinite(value) ? value : 0];
    }),
  ) as Counts;
/** Share threads on the batches' hosts (#230): a batch short then is the share's (`share starved batches`). */
const sharingOnHosts = (health: BatcherHealth | undefined) => {
  const sharing = sharingOf(health ?? null);
  return sharing !== null && sharing.threads > 0 && sharing.hostsRamGb > 0;
};

/**
 * The batcher wanted and not running for `BATCHER_NOT_RUNNING_AFTER` fast snapshots in a row or more (#211), each
 * stretch a failure: the hack loop had left its hosts to it, so nothing hacked them.
 */
function notRunningLines(points: BatcherPoint[], failures: string[]): string[] {
  const lines = ["  sent but not running (3 fast snapshots in a row or more):"];
  const stretches: { fromMs: number; toMs: number; count: number; problem: string }[] = [];
  let inStretch = false;
  for (const { atMs, deploy } of points) {
    const problem = batcherNotRunning(deploy);
    const last = stretches.at(-1);
    if (problem === null) inStretch = false;
    else if (inStretch && last !== undefined) Object.assign(last, { toMs: atMs, count: last.count + 1, problem });
    else {
      stretches.push({ fromMs: atMs, toMs: atMs, count: 1, problem });
      inStretch = true;
    }
  }
  for (const { fromMs, toMs, count, problem } of stretches) {
    if (count < BATCHER_NOT_RUNNING_AFTER) continue;
    const line = `batcher not running from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} (${count} fast snapshots): ${problem}`;
    lines.push(`    ${line}`);
    failures.push(line);
  }
  if (lines.length === 1) lines.push("    none");
  return lines;
}

/**
 * Who hacked over some fast snapshots (#206, section 5's best 10 minutes): "the batcher, batching on n00dles (its
 * health in 290 of 300 fast snapshots)", its states and targets as its health says, or "the hack loop (no batcher
 * health in the 300 fast snapshots)".
 */
export function whoHacked(points: { atMs: number; health: unknown }[]): string {
  const states = new Set<string>();
  const targets = new Set<string>();
  let withHealth = 0;
  for (const { health } of points) {
    const each = healthOf(health);
    if (each === null) continue;
    withHealth += 1;
    states.add(each.state);
    if (each.target) targets.add(each.target);
  }
  const snapshots = `${points.length} fast snapshot${points.length === 1 ? "" : "s"}`;
  if (withHealth === 0) return `the hack loop (no batcher health in the ${snapshots})`;
  return (
    `the batcher, ${[...states].join(", ")} on ${[...targets].join(", ") || "no target"} (its health in ` +
    `${withHealth} of ${snapshots})`
  );
}

/**
 * The money after each batch's grow (#234), for section 6's line: full at all the looks, or how many found the target
 * below its maximum and the least so far of the runs that did (with its target); the grows not looked at (#235's
 * review); none landed; or an older batcher, which doesn't look.
 */
function moneyAfterGrows(
  anyLooking: boolean,
  total: Counts,
  runsBelowFull: number,
  least: { share: number; target: string | null } | null,
): string {
  if (!anyLooking) return "not reported (an older batcher)";
  const grows = (count: number) => `${count} grow${count === 1 ? "" : "s"}`;
  const notLooked = total.growsNotLooked === 0 ? "" : `, ${grows(total.growsNotLooked)} not looked at`;
  if (total.moneyLooks === 0) {
    return total.growsNotLooked === 0
      ? "not looked at (no grow landed in the window)"
      : `none looked at: ${grows(total.growsNotLooked)} not looked at (something else landed on the target first, or ` +
          "a desync's recovery)";
  }
  if (total.moneyLooksBelowFull === 0) return `full at all ${total.moneyLooks} looks${notLooked}`;
  const whose = runsBelowFull === 1 ? "the run's" : "the runs'";
  const share = `${((least?.share ?? 1) * 100).toFixed(1)}%`;
  const ofMaximum = least?.target ? `${least.target}'s maximum` : "the maximum";
  return (
    `below full after ${total.moneyLooksBelowFull} of ${total.moneyLooks} looks (${whose} least so far: ${share} of ` +
    `${ofMaximum})${notLooked}; a grow short of the hack before it, so the batches drift toward the bounds' floor`
  );
}

/**
 * A move (#236): from the last hack on `from` to the first on `to`, or, not done, to `untilMs` with none yet; joined
 * across a batcher's restart by the report (#237's review).
 */
interface Move {
  from: string;
  to: string;
  sinceMs: number;
  untilMs: number;
  done: boolean;
  acrossRestart: boolean;
}

/** A health's last hack (#236), if it is one (the Agent's word: checked as it's read, #237's review). */
function lastHackOf(health: BatcherHealth): { target: string; atMs: number } | null {
  const { target, atMs } = (health.lastHack ?? {}) as Record<string, unknown>;
  return typeof target === "string" && isFiniteNumber(atMs) ? { target, atMs } : null;
}

/** A health's last move (#236), if it is one. */
function lastMoveOf(health: BatcherHealth): { from: string; to: string; idleMs: number; atMs: number } | null {
  const { from, to, idleMs, atMs } = (health.lastMove ?? {}) as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || !isFiniteNumber(idleMs) || !isFiniteNumber(atMs)) {
    return null;
  }
  return { from, to, idleMs, atMs };
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The moves over the window (#236): each finished one a health's `lastMove` showed, once, if it finished in the window
 * (#237's review: the health keeps it until the next); each run's last move still under way (its target not yet
 * hacked since the last hack on another); and, across a restart with no install between (#237's review: the new run
 * starts with no last hack), the last hack of the run before to the first of the next, on another target.
 */
class MoveFold {
  readonly #moves = new Map<string, Move>();
  readonly #runs: {
    runName: string;
    firstHack: { target: string; atMs: number } | null;
    lastHack: { target: string; atMs: number } | null;
    lastAtMs: number;
    last: BatcherHealth;
  }[] = [];
  #firstMs: number | null = null;
  reporting = false;

  add(atMs: number, health: BatcherHealth): void {
    this.#firstMs ??= atMs;
    if (health.lastHack !== undefined) this.reporting = true;
    const hack = lastHackOf(health);
    let run = this.#runs.at(-1);
    if (run?.runName !== health.runName) {
      run = { runName: health.runName, firstHack: null, lastHack: null, lastAtMs: atMs, last: health };
      this.#runs.push(run);
    }
    run.firstHack ??= hack;
    if (hack !== null) run.lastHack = hack;
    run.lastAtMs = atMs;
    run.last = health;
    const move = lastMoveOf(health);
    if (move !== null && move.atMs >= this.#firstMs) {
      this.#moves.set(`${health.runName} ${move.atMs}`, {
        from: move.from,
        to: move.to,
        sinceMs: move.atMs - move.idleMs,
        untilMs: move.atMs,
        done: true,
        acrossRestart: false,
      });
    }
  }

  /** The moves, with those under way at each run's last snapshot and those across a restart, given the installs. */
  moves(resetsMs: readonly number[]): Move[] {
    const moves = [...this.#moves.values()];
    const resetBetween = (fromMs: number, toMs: number) => resetsMs.some((each) => each > fromMs && each <= toMs);
    // The latest last hack of the runs before (#237's re-review): a run with none between two that hack, a crash loop,
    // doesn't break the join.
    let before: { target: string; atMs: number } | null = null;
    this.#runs.forEach((run, index) => {
      const health = run.last;
      const { lastHack } = run;
      const carried = before;
      if (lastHack !== null) before = lastHack;
      if (lastHack !== null) {
        // Under way within the run: the target batched changed since the last hack on it, as its health says (#237's
        // re-review: a detour back to the same target too); an older batcher's, its target not hacked since another's.
        const movedTo = lastMoveOf(health)?.to;
        const changed = health.targetChangedSinceHack;
        const underWay =
          typeof changed === "boolean" ? changed : lastHack.target !== health.target && movedTo !== health.target;
        if (underWay) {
          moves.push({
            from: lastHack.target,
            to: health.target,
            sinceMs: lastHack.atMs,
            untilMs: run.lastAtMs,
            done: false,
            acrossRestart: false,
          });
        }
      }
      if (index === 0 || carried === null) return;
      const first = run.firstHack;
      if (first !== null) {
        if (first.target !== carried.target && !resetBetween(carried.atMs, first.atMs)) {
          moves.push({
            from: carried.target,
            to: first.target,
            sinceMs: carried.atMs,
            untilMs: first.atMs,
            done: true,
            acrossRestart: true,
          });
        }
      } else if (
        index === this.#runs.length - 1 &&
        health.target !== carried.target &&
        !resetBetween(carried.atMs, run.lastAtMs)
      ) {
        moves.push({
          from: carried.target,
          to: health.target,
          sinceMs: carried.atMs,
          untilMs: run.lastAtMs,
          done: false,
          acrossRestart: true,
        });
      }
    });
    return moves;
  }
}

/**
 * Section 6's moves (#236), each with its idle time, and a failure for each past `BATCHER_MOVE_IDLE_FAILS_AFTER_MS`:
 * those its health's `lastMove` showed (each once), and each run's last in the window still under way (its target
 * not yet hacked, since the last hack on another). An older batcher's health has neither, and says so.
 */
function moveLines(moves: Move[], anyReporting: boolean, failures: string[]): string[] {
  if (!anyReporting) return ["  moves (#236): not reported (an older batcher)"];
  if (moves.length === 0) return ["  moves (#236): none"];
  const lines = ["  moves (#236), from the last hack on the target before to the first on the new one:"];
  const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  const failed: string[] = [];
  for (const { from, to, sinceMs, untilMs, done, acrossRestart } of [...moves].sort((a, b) => a.untilMs - b.untilMs)) {
    const idle = minutes(untilMs - sinceMs);
    const restart = acrossRestart ? ", across a restart" : "";
    lines.push(
      done
        ? `    ${from} → ${to} at ${formatIsoTime(untilMs)}: idle ${idle}${restart}`
        : `    ${from} → ${to}, not done at ${formatIsoTime(untilMs)}: idle ${idle} so far${restart}`,
    );
    if (untilMs - sinceMs <= BATCHER_MOVE_IDLE_FAILS_AFTER_MS) continue;
    const limit = `more than ${BATCHER_MOVE_IDLE_FAILS_AFTER_MS / 60_000} min`;
    const line =
      `batcher idle on a move: ${from} → ${to}, ${idle} without a hack, from ${formatIsoTime(sinceMs)} to ` +
      `${formatIsoTime(untilMs)}${done ? "" : ", not done"} (${limit})`;
    failed.push(line);
  }
  // The failures after the moves, as the section's others follow their lines.
  lines.push(...failed.map((line) => `  ${line}`));
  failures.push(...failed);
  return lines;
}

/** The out-of-step counts (#206), as a health has them, or as they rose. */
type OutOfStepCounts = Record<"desyncs" | "outOfOrder" | "outOfBounds" | "late" | "lost", number>;
const OUT_OF_STEP_COUNTS = ["desyncs", "outOfOrder", "outOfBounds", "late", "lost"] as const;

/** One look at a run's health: its state and target, and what of it was out of step since the look before. */
interface RunLook {
  atMs: number;
  state: string;
  target: string;
  rose: OutOfStepCounts;
}

/** The game freezes found (section 4), a weaken's time on a target then, and the warnings to add to (#241). */
export interface FreezeContext {
  freezes: readonly GameFreeze[];
  weakenMs: (target: string, atMs: number) => number | null;
  warnings: string[];
}

/** A freeze that explains a stretch out of step (#241), with a weaken's time on its target then. */
interface Cause {
  freeze: GameFreeze;
  weakenMs: number;
}

/**
 * A stretch out of step (#241): from the run's first look with something risen to its first batching again after it,
 * and anything risen within `BATCHER_FREEZE_RECOVERY_MS` after that (`againMs`, the first). Batching again: a look in
 * `batching` with nothing risen, after one out of it (a desync's recovery: `recovering`, then `preparing`); or, for
 * late or lost alone (no desync, so no recovery), past the freeze's weaken and a part's loss (`settledAfterMs`).
 */
interface Stretch {
  target: string;
  firstMs: number;
  counts: OutOfStepCounts;
  cause: Cause | { why: string };
  leftBatching: boolean;
  settledAfterMs: number;
  recoveredMs: number | null;
  againMs: number | null;
}

const countsText = (counts: OutOfStepCounts) =>
  `${counts.desyncs} desync${counts.desyncs === 1 ? "" : "s"} (${counts.outOfOrder} out of order, ` +
  `${counts.outOfBounds} out of bounds), ${counts.late} late, ${counts.lost} lost`;
/** "~3.0 s from … to …": a freeze's length and the snapshots either side of it. */
const freezeSpan = ({ lengthMs, fromMs, toMs }: GameFreeze) =>
  `${describeFreezeLength(lengthMs)} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}`;
const freezeText = (freeze: GameFreeze) => `a game freeze of ${freezeSpan(freeze)}`;

/**
 * The freeze a stretch's first look out of step at `firstMs` is attributed to (#241): the latest from whose start to
 * `FREEZE_ATTRIBUTION_WEAKENS` weaken times on `target` after its end it lies; or why none is.
 */
function causeOf(firstMs: number, target: string, context: FreezeContext): Cause | { why: string } {
  const before = context.freezes.filter((freeze) => freeze.fromMs <= firstMs);
  const last = before.at(-1);
  if (last === undefined) return { why: "no game freeze before it" };
  const weakenMs = context.weakenMs(target, last.fromMs);
  if (weakenMs === null) {
    return {
      why:
        `${freezeText(last)} before it, but a weaken's time on ${target} is unknown (no static snapshot with its ` +
        "figures, or no medium snapshot with the player's)",
    };
  }
  const freeze = before.findLast((each) => firstMs <= each.toMs + FREEZE_ATTRIBUTION_WEAKENS * weakenMs);
  if (freeze !== undefined) return { freeze, weakenMs };
  const within = `a weaken there (${formatDuration(weakenMs)})`;
  return { why: `no game freeze within ${within} before it (the last, ${freezeSpan(last)})` };
}

/** Each run's stretches out of step (#241), from its looks in order. */
function stretchesOf(looks: readonly RunLook[], context: FreezeContext): Stretch[] {
  const stretches: Stretch[] = [];
  let current: Stretch | null = null;
  for (const { atMs, state, target, rose } of looks) {
    const anyRose = OUT_OF_STEP_COUNTS.some((count) => rose[count] > 0);
    const add = (stretch: Stretch) => {
      for (const count of OUT_OF_STEP_COUNTS) stretch.counts[count] += rose[count];
    };
    if (current !== null && current.recoveredMs === null) {
      if (anyRose) add(current);
      if (state !== "batching") current.leftBatching = true;
      else if (!anyRose && (current.leftBatching || atMs >= current.settledAfterMs)) current.recoveredMs = atMs;
      continue;
    }
    if (!anyRose) continue;
    if (current?.recoveredMs != null && atMs - current.recoveredMs <= BATCHER_FREEZE_RECOVERY_MS) {
      current.againMs ??= atMs;
      add(current);
      continue;
    }
    const cause = causeOf(atMs, target, context);
    current = {
      target,
      firstMs: atMs,
      counts: { ...rose },
      cause,
      leftBatching: state !== "batching",
      settledAfterMs:
        "freeze" in cause
          ? cause.freeze.toMs + FREEZE_ATTRIBUTION_WEAKENS * cause.weakenMs + LANDING_LOST_AFTER_MS
          : atMs,
      recoveredMs: null,
      againMs: null,
    };
    stretches.push(current);
  }
  return stretches;
}

/**
 * Each stretch out of step, as a line: a warning if a freeze explains it, the batcher is batching again within
 * `BATCHER_FREEZE_RECOVERY_MS` of the freeze's end and stays in step that long after, as seen to the window's last look
 * (`lastLookMs`); otherwise a failure (#206), saying why it isn't the freeze's warning (owner decision 55).
 */
function outOfStepLines(
  runs: ReadonlyMap<string, RunLook[]>,
  lastLookMs: number,
  context: FreezeContext,
  failures: string[],
): string[] {
  const lines: string[] = [];
  const recovery = formatDuration(BATCHER_FREEZE_RECOVERY_MS);
  const stretches = [...runs.values()]
    .flatMap((looks) => stretchesOf(looks, context))
    .sort((a, b) => a.firstMs - b.firstMs);
  for (const { target, firstMs, counts, cause, recoveredMs, againMs } of stretches) {
    const seen = `${countsText(counts)} on ${target}, the first seen at ${formatIsoTime(firstMs)}`;
    if (!("freeze" in cause)) {
      const line = `batcher out of step: ${seen}; ${cause.why}`;
      lines.push(`  ${line}`);
      failures.push(line);
      continue;
    }
    const { freeze, weakenMs } = cause;
    const after = `${seen}, after ${freezeText(freeze)} (within a weaken there, ${formatDuration(weakenMs)})`;
    let notRecovered: string | null = null;
    if (recoveredMs === null) {
      notRecovered = `not batching again by the last look, at ${formatIsoTime(lastLookMs)}`;
    } else if (recoveredMs - freeze.toMs > BATCHER_FREEZE_RECOVERY_MS) {
      notRecovered =
        `batching again only at ${formatIsoTime(recoveredMs)}, ${formatDuration(recoveredMs - freeze.toMs)} after the ` +
        `freeze (more than ${recovery})`;
    } else if (againMs !== null) {
      notRecovered =
        `out of step again at ${formatIsoTime(againMs)}, ${formatDuration(againMs - recoveredMs)} after batching ` +
        `again at ${formatIsoTime(recoveredMs)} (within ${recovery})`;
    } else if (lastLookMs - recoveredMs < BATCHER_FREEZE_RECOVERY_MS) {
      notRecovered =
        `batching again at ${formatIsoTime(recoveredMs)}, but the last look, at ${formatIsoTime(lastLookMs)}, is ` +
        `${formatDuration(lastLookMs - recoveredMs)} after it: under the ${recovery} in step a freeze's warning needs`;
    }
    if (notRecovered !== null) {
      const line = `batcher out of step after a game freeze, not recovered: ${after}; ${notRecovered}`;
      lines.push(`  ${line}`);
      failures.push(line);
      continue;
    }
    const line =
      `batcher out of step after a game freeze: ${after}; recovered in ${formatDuration((recoveredMs as number) - firstMs)}: ` +
      `batching again at ${formatIsoTime(recoveredMs)}, and nothing out of step in the ${recovery} after`;
    lines.push(`  ${line}`);
    context.warnings.push(line);
  }
  return lines;
}

/**
 * The section's lines: "6. The batcher", then each hour, the desyncs and the problems seen, and any stretch it was
 * sent but not running, which fails the run (`failures`); then its sharing (#224), with the brain's worked faction's
 * reputation (`readings`). Its moves (#236) are joined across a batcher's restart, but not across an install
 * (`resetsMs`, the game's `lastAugReset` times in the slow snapshots): a new cycle starts from nothing. Each stretch out
 * of step a game freeze explains (`freezeContext`, #241), the batcher batching again by itself, is a warning.
 */
export function batcherSection(
  points: BatcherPoint[],
  failures: string[] = [],
  readings: readonly ReputationPoint[] = [],
  resetsMs: readonly number[] = [],
  freezeContext: FreezeContext = { freezes: [], weakenMs: () => null, warnings: [] },
): string[] {
  const lines = ["6. The batcher (#205, #206)"];
  const notRunning = notRunningLines(points, failures);
  const healths = points.flatMap(({ atMs, health }) => {
    const each = healthOf(health);
    return each === null ? [] : [{ atMs, health: each }];
  });
  if (healths.length === 0) {
    lines.push("  not run in the window (no fast snapshot with its health)");
    if (notRunning.length > 2 || notRunning[1] !== "    none") lines.push(...notRunning);
    return lines;
  }
  const firstMs = (healths[0] as { atMs: number }).atMs;
  const hours = new Map<number, { counts: Counts; targets: Set<string>; states: Set<string> }>();
  const lastOfRun = new Map<string, Counts>();
  const lastHealthOfRun = new Map<string, BatcherHealth>();
  const problems = new Map<string, number>();
  // Each run's looks, for its stretches out of step (#241).
  const looksOfRun = new Map<string, RunLook[]>();
  // Short of RAM (#232): while sharing on the batches' hosts, at either end of the interval (the share's failure, as
  // share-report.ts counts it), or not (the batcher's own).
  let shortWhileSharing = 0;
  let shortOwn = 0;
  let firstShortOwnMs: number | null = null;
  // The least money after a grow (#234), of the healths whose count below full rose: each run's least so far, which
  // only falls, so a run under way at the window's start may give one from before it. And the runs below.
  let leastMoneyBelowFull: { share: number; target: string | null } | null = null;
  const runsBelowFull = new Set<string>();
  // An older batcher doesn't look (#235's review): none of its healths has the count.
  let anyLooking = false;
  // The moves (#236).
  const moveFold = new MoveFold();
  for (const { atMs, health } of healths) {
    const hour = Math.floor((atMs - firstMs) / HOUR_MS);
    const bucket = hours.get(hour) ?? { counts: zero(), targets: new Set<string>(), states: new Set<string>() };
    hours.set(hour, bucket);
    // A run already under way at the window's first snapshot counts from there (#211): what it did before isn't the
    // window's. One that starts later counts from 0.
    const before = lastOfRun.get(health.runName) ?? (atMs === firstMs ? countsOf(health) : zero());
    const now = countsOf(health);
    for (const count of ALL_COUNTS) bucket.counts[count] += Math.max(0, now[count] - before[count]);
    const rose = Object.fromEntries(
      OUT_OF_STEP_COUNTS.map((count) => [count, Math.max(0, now[count] - before[count])]),
    ) as OutOfStepCounts;
    const looks = looksOfRun.get(health.runName) ?? [];
    looksOfRun.set(health.runName, looks);
    looks.push({ atMs, state: health.state, target: health.target, rose });
    const short = Math.max(0, now.batchesShort - before.batchesShort);
    if (sharingOnHosts(lastHealthOfRun.get(health.runName)) || sharingOnHosts(health)) shortWhileSharing += short;
    else if (short > 0) {
      shortOwn += short;
      firstShortOwnMs ??= atMs;
    }
    if (typeof health.moneyLooks === "number") anyLooking = true;
    const { leastMoneyAfterGrow, leastMoneyAfterGrowOn } = health;
    if (now.moneyLooksBelowFull > before.moneyLooksBelowFull && typeof leastMoneyAfterGrow === "number") {
      runsBelowFull.add(health.runName);
      if (leastMoneyBelowFull === null || leastMoneyAfterGrow < leastMoneyBelowFull.share) {
        leastMoneyBelowFull = { share: leastMoneyAfterGrow, target: leastMoneyAfterGrowOn ?? null };
      }
    }
    lastOfRun.set(health.runName, now);
    lastHealthOfRun.set(health.runName, health);
    moveFold.add(atMs, health);
    if (health.target) bucket.targets.add(health.target);
    bucket.states.add(health.state);
    if (health.problem !== null && !problems.has(health.problem)) problems.set(health.problem, atMs);
  }
  lines.push(`  runs: ${lastOfRun.size}; per hour, from ${formatIsoTime(firstMs)}:`);
  const total = zero();
  for (const [hour, { counts, targets, states }] of [...hours].sort(([a], [b]) => a - b)) {
    for (const count of ALL_COUNTS) total[count] += counts[count];
    lines.push(
      `    hour ${hour + 1}: ${[...states].join(", ")} on ${[...targets].join(", ") || "no target"}; ` +
        `${counts.batchesStarted} batches, ${counts.hacksLanded} hack parts landed ($${Math.round(counts.moneyHacked)}), ` +
        `${counts.hacksFailed} failed, ${counts.hacksSkipped} skipped, ${counts.batchesShort} short, ` +
        `${counts.batchesTrimmed} trimmed; ` +
        `${counts.desyncs} desync${counts.desyncs === 1 ? "" : "s"} (${counts.outOfOrder} out of order, ${counts.outOfBounds} out of bounds), ` +
        `${counts.late} late, ${counts.lost} lost, ${counts.unexpected} records of another run`,
    );
  }
  lines.push(
    total.desyncs === 0
      ? "  desyncs: none"
      : `  desyncs: ${total.desyncs} (${total.outOfOrder} out of order, ${total.outOfBounds} out of bounds)`,
  );
  lines.push(total.late + total.lost === 0 ? "  late or lost: none" : `  late: ${total.late}, lost: ${total.lost}`);
  // How close it came to late (#216's review): one late operation fails the run, so the margin is worth seeing.
  const slacks = healths.map(({ health }) => health.leastSlackMs).filter((slack) => typeof slack === "number");
  lines.push(
    slacks.length === 0
      ? "  least slack: unknown (no operation recorded it)"
      : `  least slack: ${Math.round(Math.min(...slacks))} ms (an operation's time to spare when it was called; ` +
          "under 0 is late)",
  );
  // Out of step, a failure (#206): the batches no longer land as planned, or someone else touched the target. A
  // stretch a game freeze explains, which the batcher recovered from by itself, is a warning (#241).
  if (total.desyncs + total.late + total.lost > 0) {
    const lastLookMs = (healths.at(-1) as { atMs: number }).atMs;
    lines.push(...outOfStepLines(looksOfRun, lastLookMs, freezeContext, failures));
  }
  const describeBatchCount = (count: number) => `${count} batch${count === 1 ? "" : "es"}`;
  lines.push(
    total.batchesShort === 0
      ? "  short of RAM: none"
      : `  short of RAM: ${describeBatchCount(total.batchesShort)} (${shortWhileSharing} while sharing on the batches' hosts: ` +
          "the share's)",
  );
  // Trimmed (#232): the batcher fits each batch to the RAM as it will be held, so a plan its hosts can't place is cut,
  // never short. A batch trimmed is income lost, not a failure: a new plan, or one at a lower hacking level, can hold
  // more for a while than the plan's peak. Those the share's threads made smaller are shown apart (#232's review): the
  // share's failure, `share starved batches`.
  lines.push(
    total.batchesTrimmed === 0
      ? "  trimmed to the hosts' RAM (#232): none"
      : `  trimmed to the hosts' RAM (#232): ${describeBatchCount(total.batchesTrimmed)} planned with fewer hack threads than the ` +
          `config's share, or none (${total.batchesTrimmedBySharing} for the share's threads on the batches' hosts: the ` +
          "share's)",
  );
  // Short of RAM, a failure (#232): the batcher fits each batch to the RAM as it will be held, so one short is RAM
  // taken after it was planned (anyone else's script on its hosts), or the fit is wrong. Its hack is lost.
  if (shortOwn > 0) {
    const line =
      `batches short of RAM: ${describeBatchCount(shortOwn)} short (their hacks lost), not while sharing on the batches' hosts, ` +
      `the first seen at ${formatIsoTime(firstShortOwnMs ?? firstMs)}`;
    lines.push(`  ${line}`);
    failures.push(line);
  }
  // The money after each batch's grow (#234): a grow short of the hack before it (a split grow's later parts grow at
  // the security the earlier ones left) leaves the target below its maximum, and the batches drift toward the bounds'
  // floor. A line, not a failure: one that reaches the floor is a desync, which fails the run; this shows it earlier.
  const afterGrows = moneyAfterGrows(anyLooking, total, runsBelowFull.size, leastMoneyBelowFull);
  lines.push(`  money after each batch's grow (#234): ${afterGrows}`);
  lines.push(...moveLines(moveFold.moves(resetsMs), moveFold.reporting, failures));
  lines.push(problems.size === 0 ? "  problems: none" : "  problems:");
  for (const [problem, atMs] of problems) lines.push(`    from ${formatIsoTime(atMs)}: ${problem}`);
  lines.push(...notRunning);
  lines.push(...sharingLines(healths, readings, failures));
  return lines;
}
