// The run report's batcher section (#205): what the batcher's health in the fast snapshots says, hour by hour, and its
// desyncs and problems; out of step (a desync, or an operation late or lost) fails the run (#206), and so does a batch
// short of RAM, except while sharing on the batches' hosts, the share's failure (#232). Its counts are each run's,
// from 0 when it starts (a new run has another `runName`), so each hour adds up each run's rises within it; a run
// already under way at the window's first snapshot counts from there. Its sharing's lines are ./share-report.ts's
// (#224). Out of step is judged a stretch at a time (#241): one a clock step, page stall or delivery lag (#309)
// explains, which the batcher recovered from by itself, is a warning (owner decision 55, ./clock-incidents.ts). Since
// #251 the batcher times its batches on the page's monotonic clock (its health's `clock`), which a clock step doesn't
// move: only a page stall explains its stretches, and a clock step only an older batcher's. A delivery lag (#309)
// counts as a page stall only where the Agent's send stamps show the page was behind it: the socket's or the brain's
// lag can't hold the page's batcher, and one whose side they can't tell excuses nothing (the 2026-11-08 clarkinc
// desyncs stay a failure; their cause is #315). A batcher stuck on poor targets (#275, the best rooted one 100× more
// on the hosts' RAM) is a warning for an hour, and a failure for 2 hours in a cycle. Home among its hosts (#340): its
// RAM in the batches while batching, and `batches left home idle`, a failure, for over half of what home may give
// (its RAM beyond what it keeps) free for 10 minutes while batching, with the plan sent held to the RAM throughout or
// batches trimmed or short of RAM meanwhile.
import {
  BATCH_RAM_WAIT_MS,
  type BatcherHealth,
  type BatchShort,
  LANDING_LOST_AFTER_MS,
  type RamWait,
} from "@bitburner-agent/core";
import { BATCHER_MOVE_IDLE_FAILS_AFTER_MS, BATCHER_NOT_RUNNING_AFTER, batcherNotRunning } from "./batcher.ts";
import {
  BATCHER_INCIDENT_RECOVERY_MS,
  batcherSpanOf,
  type ClockIncident,
  describeIncident,
  holdsThePage,
  INCIDENT_ATTRIBUTION_WEAKENS,
  INCIDENT_KIND_NAMES,
} from "./clock-incidents.ts";
import { DEFAULT_GAP_THRESHOLD_MS, formatDuration, formatIsoTime } from "./gap-report.ts";
import type { BatcherTargetIncomes, TargetIncome } from "./hacking-ceiling.ts";
import { sharingOf } from "./share.ts";
import { type ReputationPoint, sharingLines } from "./share-report.ts";

/** One fast snapshot's batcher health, as stored (the Agent's word: checked as it's read). */
export interface BatcherPoint {
  atMs: number;
  health: unknown;
  /** The deploy worker's last report while the batcher was wanted (#211); absent from an older Agent. */
  deploy?: unknown;
  /** Home's RAM in the fast snapshot then (`game.homeMaxRam`, #340's re-review); absent where it doesn't say. */
  homeMaxRamGb?: unknown;
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
 * (#235's review); the operations that waited for RAM at their time (#246), the hacks held for their batch's, and the
 * orders that found their batch gone (#246's verification); the hacks sent smaller for the level forecast at their
 * landing (#315); and the recoveries in place past their time (#315's review).
 */
const NEWER_COUNTS = [
  "ramWaits",
  "hacksHeldForBatch",
  "ordersDropped",
  "batchesTrimmed",
  "batchesTrimmedBySharing",
  "moneyLooks",
  "moneyLooksBelowFull",
  "growsNotLooked",
  "hacksTrimmedForLevel",
  "recoveriesTimedOut",
] as const;
const ALL_COUNTS = [...COUNTS, ...NEWER_COUNTS] as const;
type Counts = Record<(typeof ALL_COUNTS)[number], number>;

const HOUR_MS = 60 * 60_000;

/** Batching, with over this part of what home may give the batches (its RAM beyond what it keeps) free (#340)... */
export const HOME_BATCHES_IDLE_FREE_FRACTION = 0.5;
/** ...this long, with batches trimmed or short of RAM meanwhile: `batches left home idle`, a failure. */
export const HOME_BATCHES_IDLE_AFTER_MS = 10 * 60_000;
/** Fast snapshots (every 2 s) further apart than this are a gap: a stretch of home idle ends there. */
const HOME_IDLE_GAP_MS = 10_000;
/** Batching this long without home above its reserve among its hosts (#340's re-review): `home missing from the batches`. */
export const HOME_MISSING_AFTER_MS = 10 * 60_000;

/**
 * Stretches of `HOME_MISSING_AFTER_MS` or more (#340's re-review) batching with home left out of the batcher's hosts
 * (its health's `home` null: a batcher since #340), while home's RAM in the fast snapshot is above its reserve then
 * (`reserveGbAt`, what home keeps and the batcher's budget) and nothing asks the batcher to share (the placeholder,
 * `homeBatchesWhileSharing`, may keep home sharing then): `home missing from the batches`, a failure each. The
 * brain's plan left home out (`batcherRoomOf`, its switch on and the batcher too: `expected` given). Each stretch
 * ends at a gap in the fast snapshots or an install (`resetsMs`), so one right after an install starts afresh.
 */
function homeMissingLines(
  points: BatcherPoint[],
  failures: string[],
  resetsMs: readonly number[],
  expected: { reserveGbAt: (atMs: number) => number },
): string[] {
  const lines: string[] = [];
  let from: { atMs: number; homeGb: number; reserveGb: number } | null = null;
  let toMs = 0;
  const close = () => {
    if (from !== null && toMs - from.atMs >= HOME_MISSING_AFTER_MS) {
      const line =
        `home missing from the batches from ${formatIsoTime(from.atMs)} to ${formatIsoTime(toMs)} ` +
        `(${formatDuration(toMs - from.atMs)}): batching, with home's ${gigabytes(from.homeGb)} above the ` +
        `${gigabytes(from.reserveGb)} it keeps and the batcher's, and nothing asking it to share`;
      lines.push(`  ${line}`);
      failures.push(line);
    }
    from = null;
  };
  for (const { atMs, health: value, homeMaxRamGb } of points) {
    const health = healthOf(value);
    const reserveGb = expected.reserveGbAt(atMs);
    const missing =
      health !== null &&
      health.state === "batching" &&
      health.home === null &&
      health.sharing?.wanted !== true &&
      typeof homeMaxRamGb === "number" &&
      homeMaxRamGb > reserveGb;
    const broken =
      missing && from !== null && (atMs - toMs > HOME_IDLE_GAP_MS || resetsMs.some((ms) => toMs < ms && ms <= atMs));
    if (!missing || broken) close();
    if (!missing) continue;
    from ??= { atMs, homeGb: homeMaxRamGb as number, reserveGb };
    toMs = atMs;
  }
  close();
  return lines;
}

const gigabytes = (ram: number) => `${Math.round(ram).toLocaleString("en-US")} GB`;

/** A health's `home` (#340), or null where it has none, or one with a figure not a number of 0 or more. */
function homeOf(health: BatcherHealth): NonNullable<BatcherHealth["home"]> | null {
  const home = health.home as Record<string, unknown> | null | undefined;
  if (typeof home !== "object" || home === null) return null;
  const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  return [home.gb, home.keptGb, home.freeGb, home.batchesGb].every(amount)
    ? (home as unknown as NonNullable<BatcherHealth["home"]>)
    : null;
}

/**
 * Home among the batcher's hosts (#340), from its health's `home` (no line while it never is, or says it oddly): what
 * home may give the batches (its RAM beyond what it keeps for the Agent), and what its operations held there on
 * average and at most while batching. And each stretch of `HOME_BATCHES_IDLE_AFTER_MS` or more batching with over
 * `HOME_BATCHES_IDLE_FREE_FRACTION` of what home may give free, while the plan sent was held to the RAM throughout
 * (#340's review: the config's `ramBound`, core's `isPlanRamBound`: its income below what its target's money allows,
 * so more RAM would earn more), or batches were trimmed or short of RAM (their counts rose within it):
 * `batches left home idle`, a failure each. Either way the batches wanted RAM home had: home listed among the hosts,
 * but the plan or the placement leaving it out untrimmed (#340's re-review: a plan that leaves home out of the hosts,
 * or keeps too much of it, can't show here, as there's no `home` or both sides take it off; that's
 * `home missing from the batches`). Idle alone isn't one: a plan bounded by its target's money leaves home idle that
 * no batch wants.
 */
function homeLines(healths: { atMs: number; health: BatcherHealth }[], failures: string[]): string[] {
  const label = "  home among its hosts (#340)";
  const onHome = healths.flatMap(({ atMs, health }) => {
    const home = homeOf(health);
    return home === null ? [] : [{ atMs, health, home }];
  });
  // Never a host (its switch off, home within what it keeps, or an older batcher): nothing, as before #340.
  if (onHome.length === 0) return [];
  const batching = onHome.filter(({ health }) => health.state === "batching");
  const last = (onHome.at(-1) as { home: NonNullable<BatcherHealth["home"]> }).home;
  const mayGiveGb = Math.max(0, last.gb - last.keptGb);
  const average = batching.reduce((sum, { home }) => sum + home.batchesGb, 0) / (batching.length || 1);
  const most = Math.max(0, ...batching.map(({ home }) => home.batchesGb));
  const percent = mayGiveGb > 0 ? ` (${Math.round((average / mayGiveGb) * 100)}% of it)` : "";
  const lines = [
    `${label}: ${gigabytes(mayGiveGb)} it may give the batches, beyond the ${gigabytes(last.keptGb)} it keeps; ` +
      (batching.length === 0
        ? "never batching on it in the window"
        : `its operations held ${gigabytes(average)} there on average while batching${percent}, at most ` +
          gigabytes(most)),
  ];
  // Stretches batching with over the fraction of what home may give free: whether the plan sent was held to the RAM at
  // every look, and the batches' trimmed and short counts' rises within each, a run at a time.
  let from: { atMs: number; health: BatcherHealth } | null = null;
  let to: { atMs: number; health: BatcherHealth } | null = null;
  let wanted = 0;
  let ramBound = true;
  let stretchMayGiveGb = 0;
  const close = () => {
    if (from !== null && to !== null && to.atMs - from.atMs >= HOME_BATCHES_IDLE_AFTER_MS && (wanted > 0 || ramBound)) {
      const why = [
        ...(ramBound ? ["the plan sent held to the RAM"] : []),
        ...(wanted > 0 ? [`${wanted} batch${wanted === 1 ? "" : "es"} trimmed or short of RAM`] : []),
      ].join(", and ");
      const line =
        `batches left home idle from ${formatIsoTime(from.atMs)} to ${formatIsoTime(to.atMs)} ` +
        `(${formatDuration(to.atMs - from.atMs)}): batching, over half of the ${gigabytes(stretchMayGiveGb)} home may ` +
        `give free, with ${why}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    from = null;
    to = null;
    wanted = 0;
    ramBound = true;
  };
  const wantedOf = (health: BatcherHealth) => (health.batchesTrimmed ?? 0) + health.batchesShort;
  for (const point of healths) {
    const { atMs, health } = point;
    const home = homeOf(health);
    const homeMayGiveGb = home === null ? 0 : Math.max(0, home.gb - home.keptGb);
    const idle =
      health.state === "batching" &&
      home !== null &&
      homeMayGiveGb > 0 &&
      home.freeGb > HOME_BATCHES_IDLE_FREE_FRACTION * homeMayGiveGb;
    if (!idle || (to !== null && atMs - to.atMs > HOME_IDLE_GAP_MS)) close();
    if (!idle) continue;
    if (to !== null && to.health.runName === health.runName) {
      wanted += Math.max(0, wantedOf(health) - wantedOf(to.health));
    }
    ramBound &&= home?.ramBound === true;
    from ??= point;
    to = point;
    stretchMayGiveGb = homeMayGiveGb;
  }
  close();
  if (lines.length === 1) {
    lines.push(
      "    batches left home idle (over half free, the plan held to the RAM or batches trimmed or short, for 10 " +
        "minutes): never",
    );
  }
  return lines;
}

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

/**
 * How many times more the best rooted target must earn than the one batched for that one to be poor (#275), each on
 * the hack loop's hosts' RAM (`TargetIncomesAt`): A1's batcher ceiling a GB times the RAM, at most what batches can
 * take from its money. Both are upper bounds that a plan reaches only in part (preparation, whole threads, the RAM's
 * fit), by up to a few times and differently by target, and the brain itself moves for `BATCHER_MOVE_GAIN` (1.25×)
 * over the horizon: 100× is beyond any of that, so a batcher there isn't choosing between near-equals. #274's replay
 * of the BN1.3 exit run had its plans 1,400× (phantasy against ecorp) to 46,000× (n00dles against b-and-a) apart.
 */
export const BATCHER_POOR_TARGET_RATIO = 100;
/**
 * How long a stretch on poor targets (`BATCHER_POOR_TARGET_RATIO`), seen, before the report names it (#275):
 * preparing a target at 3× its minimum security, as one is after an install, takes one weaken there, 17 to 33 minutes
 * at hacking 1,300 (#274), and the brain prepares the next beside the batches, so a batcher on its way off a poor
 * target has moved within an hour. A warning: a release's run may WARN only with each warning explained (owner
 * decision 55).
 */
export const BATCHER_STUCK_WARNS_AFTER_MS = 60 * 60_000;
/**
 * How long on poor targets in one cycle, all of it, every stretch's whatever its length (#277's review), fails the run
 * (owner decision 59, #275): twice the warning's, past any preparation. The BN1.3 run's cycle 7 was stuck 2 h 9 min
 * on n00dles by this check, 9 minutes past it (#274). A failure blocks a release (decision 55's gate).
 */
export const BATCHER_STUCK_FAILS_AFTER_MS = 2 * BATCHER_STUCK_WARNS_AFTER_MS;
/**
 * How long off poor targets breaks a stretch (#277's review): from its last poor look to the next, with a look judged
 * not poor between (a dip under `BATCHER_POOR_TARGET_RATIO`, or a target that isn't poor). A shorter dip or move joins
 * the stretches either side, its time not counted, so a batcher that keeps stepping off a poor target for a minute
 * isn't let off; 10 minutes is a move's own failure (`BATCHER_MOVE_IDLE_FAILS_AFTER_MS`).
 */
export const BATCHER_STUCK_BREAK_MS = 10 * 60_000;

/** A ratio of the best target's income to the one batched, with the incomes it's of. */
interface PoorRatio {
  ratio: number;
  best: TargetIncome;
  batchedIncome: number;
}

/** A stretch on poor targets (#275), its ratios' least and most, and the hacking levels. */
interface StuckStretch {
  targets: string[];
  cycle: number;
  fromMs: number;
  toMs: number;
  /** The time on them seen: between looks no more than the heartbeat's gap threshold apart, both poor. */
  onMs: number;
  least: number;
  most: PoorRatio;
  hackingLeast: number | null;
  hackingMost: number | null;
}

const formatPerSecond = (income: number) => `$${Math.round(income).toLocaleString("en-US")}/s`;
const formatRatio = (ratio: number) =>
  Number.isFinite(ratio) ? `${Math.round(ratio).toLocaleString("en-US")}×` : "∞×";
const formatLevel = (level: number | null) => (level === null ? "unknown" : Math.round(level).toLocaleString("en-US"));

/** "n00dles from … to … (1 h 9 min on it), in BN1.3 8; the best rooted target 101× to 9,000× it (at the most …)". */
function describeStuck(stretch: StuckStretch, cycleLabel: string | null): string {
  const { targets, fromMs, toMs, onMs, least, most, hackingLeast, hackingMost } = stretch;
  const hacking =
    hackingLeast === hackingMost
      ? formatLevel(hackingLeast)
      : `${formatLevel(hackingLeast)} to ${formatLevel(hackingMost)}`;
  const range =
    formatRatio(least) === formatRatio(most.ratio)
      ? formatRatio(least)
      : `${formatRatio(least)} to ${formatRatio(most.ratio)}`;
  return (
    `${targets.join(", ")} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)} (${formatDuration(onMs)} on it)` +
    `${cycleLabel === null ? "" : `, in ${cycleLabel}`}; the best rooted target ${range} it (at the most ` +
    `${most.best.target}, ${formatPerSecond(most.best.incomePerSecond)} against ${formatPerSecond(most.batchedIncome)} ` +
    `on the hosts' RAM), at hacking ${hacking}`
  );
}

/**
 * Section 6's stuck target check (#275): the stretches of looks at the batcher (`points`, its health's target in the
 * fast snapshots) on targets that the best rooted target would earn `BATCHER_POOR_TARGET_RATIO` times or more than, on
 * the hack loop's hosts' RAM, by the medium snapshot in force (`incomes`: none from one stale or from before an
 * install). An install (`resetsMs`) ends a stretch; so does `BATCHER_STUCK_BREAK_MS` off poor targets, a shorter time
 * joining the stretches either side (#277's review); a look with an income unknown, or a gap, neither ends nor adds
 * to one. A cycle with `BATCHER_STUCK_FAILS_AFTER_MS` on poor targets in all, every stretch's, fails, in one line with
 * its longest stretch; in the others, each stretch of `BATCHER_STUCK_WARNS_AFTER_MS` or more is a warning. Each names
 * the targets, the range of ratios and the best at the largest, the hacking levels, and the cycle (2b's
 * `cycleLabelAt`) where known.
 */
export function stuckTargetLines(
  points: readonly { atMs: number; target: string }[],
  incomes: BatcherTargetIncomes,
  resetsMs: readonly number[],
  failures: string[],
  warnings: string[],
  cycleLabelAt?: (atMs: number) => string,
): string[] {
  const stretches: StuckStretch[] = [];
  // Typed so, not narrowed to null: it's set within the loop.
  let open = null as StuckStretch | null;
  // A look judged not poor since the open stretch's last poor one.
  let offSince = false;
  let cycle = 0;
  let judged = false;
  let previous: { atMs: number; poor: boolean } | null = null;
  for (const { atMs, target } of points) {
    const sinceMs = previous?.atMs;
    if (sinceMs !== undefined && resetsMs.some((resetMs) => resetMs > sinceMs && resetMs <= atMs)) {
      cycle += 1;
      open = null;
    }
    const then = incomes.at(atMs, resetsMs);
    const best = then?.best ?? null;
    const batched = then?.incomeOf(target) ?? null;
    const ratio = best === null || batched === null ? null : batched > 0 ? best.incomePerSecond / batched : Infinity;
    if (ratio !== null) judged = true;
    const poor = ratio !== null && ratio >= BATCHER_POOR_TARGET_RATIO;
    if (ratio !== null && !poor) offSince = true;
    if (poor && best !== null && batched !== null) {
      if (open !== null && offSince && atMs - open.toMs >= BATCHER_STUCK_BREAK_MS) open = null;
      offSince = false;
      const hacking = then?.hacking ?? null;
      const here = { ratio, best, batchedIncome: batched };
      if (open === null) {
        open = {
          targets: [],
          cycle,
          fromMs: atMs,
          toMs: atMs,
          onMs: 0,
          least: ratio,
          most: here,
          hackingLeast: hacking,
          hackingMost: hacking,
        };
        stretches.push(open);
      } else {
        if (previous?.poor && atMs - previous.atMs <= DEFAULT_GAP_THRESHOLD_MS) open.onMs += atMs - previous.atMs;
        open.toMs = atMs;
        open.least = Math.min(open.least, ratio);
        if (ratio > open.most.ratio) open.most = here;
        if (hacking !== null) {
          open.hackingLeast = Math.min(open.hackingLeast ?? hacking, hacking);
          open.hackingMost = Math.max(open.hackingMost ?? hacking, hacking);
        }
      }
      if (!open.targets.includes(target)) open.targets.push(target);
    }
    previous = { atMs, poor };
  }
  const head = "  stuck on a poor target (#275)";
  const what =
    `an hour or more on targets the best rooted one earns ${BATCHER_POOR_TARGET_RATIO}× more than, on the hack ` +
    `loop's hosts' RAM (under ${BATCHER_STUCK_BREAK_MS / 60_000} min off them joins), or ` +
    `${BATCHER_STUCK_FAILS_AFTER_MS / 3_600_000} h of it in a cycle`;
  if (!judged) {
    return [`${head}: not judged (no look at the batcher with its target's income and the best target's known)`];
  }
  const lines: string[] = [];
  const cycles = [...new Set(stretches.map((stretch) => stretch.cycle))];
  for (const each of cycles) {
    const ofCycle = stretches.filter((stretch) => stretch.cycle === each);
    const label = (stretch: StuckStretch) => (cycleLabelAt === undefined ? null : cycleLabelAt(stretch.fromMs));
    const totalMs = ofCycle.reduce((total, stretch) => total + stretch.onMs, 0);
    if (totalMs >= BATCHER_STUCK_FAILS_AFTER_MS) {
      const longest = ofCycle.reduce((most, stretch) => (stretch.onMs > most.onMs ? stretch : most));
      const where = cycleLabelAt === undefined ? "its cycle" : label(longest);
      const count = `${ofCycle.length} ${ofCycle.length === 1 ? "stretch" : "stretches"}`;
      const failed =
        `batcher stuck on a poor target: ${formatDuration(totalMs)} on poor targets in ${where} ` +
        `(${BATCHER_STUCK_FAILS_AFTER_MS / 3_600_000} h or more in a cycle fails), in ${count}; the longest, ` +
        describeStuck(longest, null);
      lines.push(`    ${failed}`);
      failures.push(failed);
      continue;
    }
    for (const stretch of ofCycle.filter(({ onMs }) => onMs >= BATCHER_STUCK_WARNS_AFTER_MS)) {
      const line = `batcher stuck on a poor target: ${describeStuck(stretch, label(stretch))}`;
      lines.push(`    ${line}`);
      warnings.push(line);
    }
  }
  return lines.length === 0 ? [`${head}: none (${what})`] : [`${head}, ${what}:`, ...lines];
}

/** The fields a short or a wait for RAM (#246) has in a number. */
const RAM_RECORD_NUMBER_FIELDS = [
  "atMs",
  "threads",
  "waitedMs",
  "freeGb",
  "largestFreeGb",
  "pastLandingGb",
  "othersGb",
  "sharingGb",
];

/**
 * The shorts or the waits for RAM a health keeps (#246), those that read as one: the Agent's word, so checked as it's
 * read.
 */
function ramRecordsOf(health: BatcherHealth, kind: "shorts"): BatchShort[];
function ramRecordsOf(health: BatcherHealth, kind: "waits"): RamWait[];
function ramRecordsOf(health: BatcherHealth, kind: "shorts" | "waits"): (BatchShort | RamWait)[] {
  const records: unknown = health[kind];
  if (!Array.isArray(records)) return [];
  return records.filter((each): each is BatchShort | RamWait => {
    if (typeof each !== "object" || each === null) return false;
    const fields = each as Record<string, unknown>;
    const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
    return (
      RAM_RECORD_NUMBER_FIELDS.every((name) => isNumber(fields[name])) &&
      (fields.landingLagMs === null || isNumber(fields.landingLagMs)) &&
      (fields.slackMs === undefined || fields.slackMs === null || isNumber(fields.slackMs)) &&
      typeof fields.operation === "string" &&
      typeof fields.target === "string" &&
      (kind === "waits" || fields.failedOn === null || typeof fields.failedOn === "string")
    );
  });
}

const formatGb = (value: number) => `${Number(value.toFixed(2))} GB`;

/**
 * A short or a wait for RAM (#246), as the report lists it: what it was, how long past its time, and what held the RAM
 * at its first look. Its own operations past their landing are RAM a busy page freed late, as are the landings drained
 * then running late; scripts not its own, or its share threads, took RAM after it planned.
 */
function ramRecordLine(record: BatchShort | RamWait, started: boolean): string {
  const lag = record.landingLagMs === null ? "none landed then" : `landings ${Math.round(record.landingLagMs)} ms late`;
  const failedOn = "failedOn" in record && record.failedOn !== null ? `; exec failed on ${record.failedOn}` : "";
  // A grow's or weaken's time to spare as it started, or gave up (#246's verification): under 100 ms, it gave up early.
  const slack = typeof record.slackMs === "number" ? `, ${Math.round(record.slackMs)} ms to spare` : "";
  return (
    `    at ${formatIsoTime(record.atMs)}: ${record.operation} of ${record.threads} threads on ${record.target}, ` +
    `${started ? "started " : ""}${Math.round(record.waitedMs)} ms past its time${slack}; ` +
    `${started ? "at its first look" : "as it gave up"} ` +
    `${formatGb(record.freeGb)} free (${formatGb(record.largestFreeGb)} at most on a host), held by its operations ` +
    `past their landing up to ${formatGb(record.pastLandingGb)}, by scripts not its own ` +
    `${formatGb(record.othersGb)}, by its share threads ${formatGb(record.sharingGb)}; ${lag}${failedOn}`
  );
}

/**
 * Each short or wait for RAM the healths kept (#246), in time order, and how many more there were than kept (the
 * health keeps the last 5 of each, so more between two snapshots aren't all seen).
 */
function ramRecordLines(records: (BatchShort | RamWait)[], count: number, started: boolean): string[] {
  const lines = [...records].sort((a, b) => a.atMs - b.atMs).map((each) => ramRecordLine(each, started));
  const notKept = count - records.length;
  if (notKept > 0) lines.push(`    (${notKept} more not kept: the health keeps the last 5)`);
  return lines;
}

/** The out-of-step counts (#206), as a health has them, or as they rose. */
type OutOfStepCounts = Record<"desyncs" | "outOfOrder" | "outOfBounds" | "late" | "lost", number>;
const OUT_OF_STEP_COUNTS = ["desyncs", "outOfOrder", "outOfBounds", "late", "lost"] as const;

/** One look at a run's health: its run, state and target, and what of it was out of step since its look before. */
interface RunLook {
  runName: string;
  atMs: number;
  state: string;
  target: string;
  rose: OutOfStepCounts;
  /** Whether its batcher times its batches on the page's monotonic clock (#251, its health's `clock`). */
  monotonic: boolean;
  /**
   * Its run's looks after a grow that found the target below full so far, and the least money after one so far, a
   * share of the maximum, and its target (#234); null from an older batcher, which doesn't look.
   */
  belowFull: number | null;
  leastMoneyAfterGrow: number | null;
  leastMoneyAfterGrowOn: string | null;
}

/**
 * How far before a stretch's first look out of step grows short of their hacks are taken as its cause (#315): money
 * below full after a grow drifts the batches down to the bounds' floor within seconds at a batch every 80 ms (6 s on
 * clarkinc on 2026-11-08), and within minutes at the slowest spacings.
 */
export const GROW_SHORTFALL_REACH_MS = 5 * 60_000;

/**
 * Grows short of their hacks before a stretch out of step (#315), on its target: from when, how many looks, and the
 * least money a look found within the reach (null when the run's least didn't fall there).
 */
interface GrowShortfall {
  sinceMs: number;
  looks: number;
  least: number | null;
  on: string;
}

/**
 * The cause a shortfall gives a desync's stretch (#315), for its line: its cause, or, with an incident it's put down to
 * (#241, #309), a cause beside it, as the batcher's own drift doesn't wait for an incident.
 */
const shortfallText = ({ sinceMs, looks, least, on }: GrowShortfall, besideIncident: boolean) => {
  const leastText = least === null ? "" : `, the least ${(least * 100).toFixed(1)}% of ${on}'s maximum`;
  const lead = besideIncident
    ? "a grow shortfall before it too, which may be its cause instead"
    : "its cause: a grow shortfall";
  return (
    `${lead}, the money below full after ${looks} grow${looks === 1 ? "" : "s"} from ${formatIsoTime(sinceMs)}` +
    `${leastText}, each hack taking more than its grow put back, so the batches drifted out of the bounds (#315)`
  );
};

/**
 * The grows short of their hacks on `target` in a run's looks (`history`, in time order, ending with the stretch's
 * first) within `GROW_SHORTFALL_REACH_MS` before it (#315), or null: none rose there, or an older batcher doesn't look.
 * A look's rise counts only while the run batched `target`, `batching` or `recovering` (a move's grows on the target
 * before, landing while the new one is prepared, aren't its); the least
 * is the run's least so far, given only where it fell within the reach, on `target`.
 */
function shortfallBefore(history: readonly RunLook[], target: string): GrowShortfall | null {
  const last = history.at(-1);
  if (last === undefined || last.belowFull === null) return null;
  const fromMs = last.atMs - GROW_SHORTFALL_REACH_MS;
  // From the last look before the reach; with none, the run's first look here (what it counted before isn't seen).
  const baseIndex = Math.max(
    0,
    history.findLastIndex((look) => look.atMs < fromMs),
  );
  let looks = 0;
  let sinceMs: number | null = null;
  for (let index = baseIndex + 1; index < history.length; index++) {
    const look = history[index] as RunLook;
    const rise = (look.belowFull ?? 0) - ((history[index - 1] as RunLook).belowFull ?? 0);
    // While it batched the target (#315's re-review): after a move, preparing the new one, the old one's grows land.
    const batched = look.target === target && (look.state === "batching" || look.state === "recovering");
    if (!batched || !(rise > 0)) continue;
    looks += rise;
    sinceMs ??= look.atMs;
  }
  if (sinceMs === null) return null;
  const leastBefore = (history[baseIndex] as RunLook).leastMoneyAfterGrow ?? 1;
  const leastNow = last.leastMoneyAfterGrow;
  const fellHere = leastNow !== null && leastNow < leastBefore && last.leastMoneyAfterGrowOn === target;
  return { sinceMs, looks, least: fellHere ? leastNow : null, on: target };
}
/**
 * The clock steps, page stalls and delivery lags (#309) found (section 4), a weaken's time on a target then, and the
 * warnings (#241).
 */
export interface IncidentContext {
  incidents: readonly ClockIncident[];
  weakenMs: (target: string, atMs: number) => number | null;
  warnings: string[];
}

/** The incident a stretch out of step is put down to (#241), with a weaken's time on its target then. */
interface Attribution {
  incident: ClockIncident;
  weakenMs: number;
}

/**
 * A stretch out of step (#241), one run's: from its first look with something risen to its first look batching with
 * nothing risen (`recoveredMs`), and anything risen within `BATCHER_INCIDENT_RECOVERY_MS` after that (`againMs`, the
 * first). After a desync's recovery (`recovering` seen), the hacks out before it have landed and the target is back at
 * its maximum (#315: it recovers in place, its held batches' grows and weakens still landing). With late or lost alone
 * it never stops batching, so the parts in flight at its incident may land late, or be found lost, until a weaken and a
 * part's loss after the incident's end (`landingUntilMs`): each such rise is the stretch's, and batching again waits
 * for the last; one over `BATCHER_INCIDENT_RECOVERY_MS` after the incident, once it was batching again
 * (`firstRecoveredMs`), is out of step again (`lateAgainMs`, #249's review). A move (`preparing` a new target) is
 * neither. The incident's end is the batcher's: the game's clock's move, for a step (`batcherSpanOf`; a step explains
 * only an older batcher's stretches, one on the wall clock, #251).
 */
interface OutOfStepStretch {
  runName: string;
  target: string;
  firstMs: number;
  counts: OutOfStepCounts;
  attribution: Attribution | { why: string };
  /** Grows short of their hacks before it, its cause (#315), or null. */
  shortfall: GrowShortfall | null;
  sawRecovering: boolean;
  landingUntilMs: number;
  recoveredMs: number | null;
  firstRecoveredMs: number | null;
  againMs: number | null;
  lateAgainMs: number | null;
}

const countsText = (counts: OutOfStepCounts) =>
  `${counts.desyncs} desync${counts.desyncs === 1 ? "" : "s"} (${counts.outOfOrder} out of order, ` +
  `${counts.outOfBounds} out of bounds), ${counts.late} late, ${counts.lost} lost`;
const addCounts = (counts: OutOfStepCounts, rose: OutOfStepCounts) => {
  for (const count of OUT_OF_STEP_COUNTS) counts[count] += rose[count];
};
const kindName = ({ kind }: ClockIncident) => INCIDENT_KIND_NAMES[kind];

/**
 * The incident a stretch is put down to (#241), its first look out of step being at `firstMs`: the latest incident
 * whose span, as the batcher felt it (`batcherSpanOf`), started by then and ended no more than
 * `INCIDENT_ATTRIBUTION_WEAKENS` weaken times on `target` before it, and that no earlier stretch was put down to
 * (`attributed`); or why there's none. A batcher on the page's monotonic clock (#251, `monotonic`) can't be put out
 * of step by a clock step, so only a page stall explains its stretches; an older batcher's, either. A delivery lag
 * (#309) explains one as a page stall does only where the Agent's send stamps show the page was behind it
 * (`holdsThePage`); one they show was the socket's or the brain's, or can't tell, excuses nothing, and the reason
 * names the last such within a weaken before the stretch.
 */
function attributionOf(
  firstMs: number,
  target: string,
  monotonic: boolean,
  context: IncidentContext,
  attributed: Set<ClockIncident>,
): Attribution | { why: string } {
  const before = (incident: ClockIncident) => batcherSpanOf(incident).fromMs <= firstMs;
  const explaining = context.incidents.filter(
    (incident) =>
      (!monotonic || incident.kind !== "clockStep") && (incident.kind !== "deliveryLag" || holdsThePage(incident)),
  );
  const incidentsBefore = explaining.filter(before);
  const lastIncident = incidentsBefore.at(-1);
  const kinds = monotonic
    ? "page stall, or delivery lag the page was behind,"
    : "clock step, page stall, or delivery lag the page was behind,";
  // Said, so a step, or a lag the page wasn't seen behind within a weaken before, reads as no excuse, not as missed.
  const lagInReach = (incident: ClockIncident) => {
    const lagWeakenMs = context.weakenMs(target, incident.fromMs);
    return lagWeakenMs !== null && firstMs <= incident.toMs + INCIDENT_ATTRIBUTION_WEAKENS * lagWeakenMs;
  };
  const lastNotPage = context.incidents
    .filter(
      (incident) =>
        incident.kind === "deliveryLag" && !holdsThePage(incident) && before(incident) && lagInReach(incident),
    )
    .at(-1);
  const lagNote =
    lastNotPage === undefined
      ? ""
      : typeof lastNotPage.pageLagMs === "number"
        ? ` (${describeIncident(lastNotPage)} was the socket's or the brain's, the page sending on time: no ` +
          "excuse, #309)"
        : ` (${describeIncident(lastNotPage)}, its side unknown, no send stamps showing the page behind it: no ` +
          "excuse, #309)";
  const stepNote =
    (monotonic && context.incidents.some((incident) => incident.kind === "clockStep" && before(incident))
      ? " (a clock step can't put a batcher on the page's monotonic clock out of step, #251)"
      : "") + lagNote;
  if (lastIncident === undefined) return { why: `no ${kinds} before it${stepNote}` };
  const weakenMs = context.weakenMs(target, batcherSpanOf(lastIncident).fromMs);
  if (weakenMs === null) {
    return {
      why:
        `${describeIncident(lastIncident)} before it, but a weaken's time on ${target} is unknown (no static ` +
        "snapshot with its figures, or no medium snapshot with the player's)",
    };
  }
  const inReach = (incident: ClockIncident) =>
    firstMs <= batcherSpanOf(incident).toMs + INCIDENT_ATTRIBUTION_WEAKENS * weakenMs;
  const incident = incidentsBefore.findLast((candidate) => inReach(candidate) && !attributed.has(candidate));
  if (incident !== undefined) {
    attributed.add(incident);
    return { incident, weakenMs };
  }
  const weaken = `a weaken there (${formatDuration(weakenMs)})`;
  const alreadyAttributed = incidentsBefore.findLast(inReach);
  if (alreadyAttributed !== undefined) {
    return {
      why:
        `${describeIncident(alreadyAttributed)} within ${weaken} before it, but an earlier stretch was put down ` +
        `to it${stepNote}`,
    };
  }
  return {
    why: `no ${kinds} within ${weaken} before it (the last, ${describeIncident(lastIncident)})${stepNote}`,
  };
}

/** The stretches out of step (#241), from every run's looks in time order. */
function stretchesOf(looks: readonly RunLook[], context: IncidentContext): OutOfStepStretch[] {
  const stretches: OutOfStepStretch[] = [];
  const openStretchOfRun = new Map<string, OutOfStepStretch>();
  const attributed = new Set<ClockIncident>();
  const historyOfRun = new Map<string, RunLook[]>();
  for (const look of looks) {
    const { runName, atMs, state, target, rose, monotonic } = look;
    const history = historyOfRun.get(runName) ?? [];
    history.push(look);
    historyOfRun.set(runName, history);
    const anyRose = OUT_OF_STEP_COUNTS.some((count) => rose[count] > 0);
    const openStretch = openStretchOfRun.get(runName);
    if (openStretch !== undefined && openStretch.recoveredMs === null) {
      if (anyRose) addCounts(openStretch.counts, rose);
      if (state === "recovering") openStretch.sawRecovering = true;
      else if (state === "batching" && !anyRose) {
        openStretch.recoveredMs = atMs;
        openStretch.firstRecoveredMs ??= atMs;
      }
      continue;
    }
    if (!anyRose) continue;
    if (openStretch?.recoveredMs != null) {
      if (!openStretch.sawRecovering && atMs <= openStretch.landingUntilMs) {
        addCounts(openStretch.counts, rose);
        openStretch.recoveredMs = null;
        const attribution = openStretch.attribution;
        const sinceMs = "incident" in attribution ? atMs - batcherSpanOf(attribution.incident).toMs : 0;
        if (sinceMs > BATCHER_INCIDENT_RECOVERY_MS) openStretch.lateAgainMs ??= atMs;
        continue;
      }
      if (atMs - openStretch.recoveredMs <= BATCHER_INCIDENT_RECOVERY_MS) {
        openStretch.againMs ??= atMs;
        addCounts(openStretch.counts, rose);
        continue;
      }
    }
    const attribution = attributionOf(atMs, target, monotonic, context, attributed);
    const stretch: OutOfStepStretch = {
      runName,
      target,
      firstMs: atMs,
      counts: { ...rose },
      attribution,
      shortfall: shortfallBefore(history, target),
      sawRecovering: state === "recovering",
      landingUntilMs:
        "incident" in attribution
          ? batcherSpanOf(attribution.incident).toMs +
            INCIDENT_ATTRIBUTION_WEAKENS * attribution.weakenMs +
            LANDING_LOST_AFTER_MS
          : atMs,
      recoveredMs: null,
      firstRecoveredMs: null,
      againMs: null,
      lateAgainMs: null,
    };
    openStretchOfRun.set(runName, stretch);
    stretches.push(stretch);
  }
  return stretches;
}

/**
 * A stretch's grow shortfall as its line's cause (#315), `besideIncident` when it's put down to one: only for a desync
 * (out of bounds or out of order), the drift's end; late and lost operations are a start's lag, not the money's.
 */
const causeOf = ({ shortfall, counts }: OutOfStepStretch, besideIncident: boolean) =>
  shortfall === null || counts.desyncs === 0 ? "" : `; ${shortfallText(shortfall, besideIncident)}`;

/**
 * Each stretch out of step put down to an incident, as a line (#241, owner decision 55), judged on its own run's looks
 * (a run replaced or stopped ends there): a warning if the batcher is batching again within
 * `BATCHER_INCIDENT_RECOVERY_MS` of the incident's end and in step that long after, or if its run's looks end
 * before that can be seen ("recovery not yet confirmed"); otherwise a failure. Then the stretches put down to none, one
 * failure with their totals (#206), each listed under it if more than one. A desync's names grows short of their
 * hacks on its target before it as its cause (#315), or, put down to an incident, as a cause beside it.
 */
function outOfStepLines(looks: readonly RunLook[], context: IncidentContext, failures: string[]): string[] {
  const lastLookOfRun = new Map(looks.map(({ runName, atMs }) => [runName, atMs]));
  const recovery = formatDuration(BATCHER_INCIDENT_RECOVERY_MS);
  const lines: string[] = [];
  const unexplained: (OutOfStepStretch & { attribution: { why: string } })[] = [];
  for (const stretch of stretchesOf(looks, context)) {
    const { runName, target, firstMs, counts, attribution, recoveredMs, againMs, lateAgainMs, firstRecoveredMs } =
      stretch;
    const seenText = `${countsText(counts)} on ${target}, the first seen at ${formatIsoTime(firstMs)}`;
    if (!("incident" in attribution)) {
      unexplained.push({ ...stretch, attribution });
      continue;
    }
    const { incident, weakenMs } = attribution;
    const name = kindName(incident);
    const weakenText = `within a weaken there, ${formatDuration(weakenMs)}`;
    const causeText = causeOf(stretch, true);
    const afterText = `${seenText}, after ${describeIncident(incident)} (${weakenText})${causeText}`;
    const runEndMs = lastLookOfRun.get(runName) as number;
    const incidentEndMs = batcherSpanOf(incident).toMs;
    const sinceIncident = (atMs: number) => formatDuration(atMs - incidentEndMs);
    let failed: string | null = null;
    let unconfirmed: string | null = null;
    if (recoveredMs === null) {
      if (runEndMs - incidentEndMs >= BATCHER_INCIDENT_RECOVERY_MS) {
        failed =
          `not batching again within ${recovery} of the ${name} (its run's last look at ` +
          `${formatIsoTime(runEndMs)})`;
      } else {
        unconfirmed =
          `not batching again at its run's last look, at ${formatIsoTime(runEndMs)}, ` +
          `${sinceIncident(runEndMs)} after the ${name} (${recovery} allowed)`;
      }
    } else if (lateAgainMs !== null && firstRecoveredMs !== null) {
      failed =
        `out of step again at ${formatIsoTime(lateAgainMs)}, ${sinceIncident(lateAgainMs)} after the ${name}, after ` +
        `batching again at ${formatIsoTime(firstRecoveredMs)} (more than ${recovery} after it)`;
    } else if (recoveredMs - incidentEndMs > BATCHER_INCIDENT_RECOVERY_MS) {
      failed =
        `batching again only at ${formatIsoTime(recoveredMs)}, ${sinceIncident(recoveredMs)} after the ${name} (more ` +
        `than ${recovery})`;
    } else if (againMs !== null) {
      failed =
        `out of step again at ${formatIsoTime(againMs)}, ${formatDuration(againMs - recoveredMs)} after ` +
        `batching again at ${formatIsoTime(recoveredMs)} (within ${recovery})`;
    } else if (runEndMs - recoveredMs < BATCHER_INCIDENT_RECOVERY_MS) {
      unconfirmed =
        `recovered in ${formatDuration(recoveredMs - firstMs)}: batching again at ${formatIsoTime(recoveredMs)}, ` +
        `but its run's last look, at ${formatIsoTime(runEndMs)}, is ${formatDuration(runEndMs - recoveredMs)} ` +
        `after (${recovery} needed)`;
    }
    let line: string;
    if (failed !== null) {
      line = `batcher out of step after a ${name}, not recovered: ${afterText}; ${failed}`;
      failures.push(line);
    } else if (unconfirmed !== null) {
      line = `batcher out of step after a ${name}, recovery not yet confirmed: ${afterText}; ${unconfirmed}`;
      context.warnings.push(line);
    } else {
      line =
        `batcher out of step after a ${name}: ${afterText}; recovered in ` +
        `${formatDuration((recoveredMs as number) - firstMs)}: batching again at ${formatIsoTime(recoveredMs)}, and ` +
        `nothing out of step in the ${recovery} after`;
      context.warnings.push(line);
    }
    lines.push(`  ${line}`);
  }
  const [first] = unexplained;
  if (first !== undefined) {
    const total = Object.fromEntries(OUT_OF_STEP_COUNTS.map((count) => [count, 0])) as OutOfStepCounts;
    for (const { counts } of unexplained) addCounts(total, counts);
    const targets = [...new Set(unexplained.map(({ target }) => target))].join(", ");
    const line =
      unexplained.length === 1
        ? `batcher out of step: ${countsText(first.counts)} on ${first.target}, the first seen at ` +
          `${formatIsoTime(first.firstMs)}; ${first.attribution.why}${causeOf(first, false)}`
        : `batcher out of step: ${countsText(total)} in ${unexplained.length} stretches on ${targets}, the ` +
          `first seen at ${formatIsoTime(first.firstMs)}; the first: ${first.attribution.why}${causeOf(first, false)}`;
    lines.push(`  ${line}`);
    failures.push(line);
    if (unexplained.length > 1) {
      for (const each of unexplained) {
        const { counts, target, firstMs, attribution } = each;
        lines.push(
          `    ${countsText(counts)} on ${target}, the first seen at ${formatIsoTime(firstMs)}; ${attribution.why}` +
            causeOf(each, false),
        );
      }
    }
  }
  return lines;
}

/**
 * The section's lines: "6. The batcher", then each hour, the desyncs and the problems seen, and any stretch it was
 * sent but not running, which fails the run (`failures`); then its sharing (#224), with the brain's worked faction's
 * reputation (`readings`). Its moves (#236) are joined across a batcher's restart, but not across an install
 * (`resetsMs`, the game's `lastAugReset` times in the slow snapshots): a new cycle starts from nothing. Each
 * stretch out of step a clock step, page stall or delivery lag explains (`incidentContext`, #241, #309), the batcher
 * batching again by itself, is a warning. With `stuck` (the medium snapshots' targets' incomes, and 2b's cycles),
 * after the moves, a batcher stuck on a poor target (#275, `stuckTargetLines`), its warnings with
 * `incidentContext`'s.
 */
export function batcherSection(
  points: BatcherPoint[],
  failures: string[] = [],
  readings: readonly ReputationPoint[] = [],
  resetsMs: readonly number[] = [],
  incidentContext: IncidentContext = { incidents: [], weakenMs: () => null, warnings: [] },
  stuck?: { incomes: BatcherTargetIncomes; cycleLabelAt?: (atMs: number) => string },
  homeExpected?: { reserveGbAt: (atMs: number) => number },
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
  // Each run's looks, in time order, for the stretches out of step (#241).
  const looks: RunLook[] = [];
  // Short of RAM (#232): while sharing on the batches' hosts, at either end of the interval (the share's failure, as
  // share-report.ts counts it), or not (the batcher's own).
  let shortWhileSharing = 0;
  let shortOwn = 0;
  let firstShortOwnMs: number | null = null;
  // Orders that found their batch gone (#253), and the first snapshot that showed one (#246's verification).
  let firstDroppedMs: number | null = null;
  // Each short and wait for RAM the healths keep (#246), once, new since the run's health before (a run under way at
  // the window's first snapshot: those before it aren't the window's); whether any health counts the waits, and each
  // run's longest wait so far, from its latest health.
  const shorts: BatchShort[] = [];
  const waits: RamWait[] = [];
  let anyWaitReporting = false;
  const longestRamWaitMsOfRun = new Map<string, number>();
  // The least money after a grow (#234), of the healths whose count below full rose: each run's least so far, which
  // only falls, so a run under way at the window's start may give one from before it. And the runs below.
  let leastMoneyBelowFull: { share: number; target: string | null } | null = null;
  const runsBelowFull = new Set<string>();
  // An older batcher doesn't look (#235's review): none of its healths has the count.
  let anyLooking = false;
  // The moves (#236).
  const moveFold = new MoveFold();
  // The level forecast at the hacks' landings (#315): whether any health reports it, and each run's most levels so far.
  let anyForecasting = false;
  const mostLevelRiseOfRun = new Map<string, number>();
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
    const monotonic = health.clock === "monotonic";
    looks.push({
      runName: health.runName,
      atMs,
      state: health.state,
      target: health.target,
      rose,
      monotonic,
      belowFull: typeof health.moneyLooksBelowFull === "number" ? health.moneyLooksBelowFull : null,
      leastMoneyAfterGrow: typeof health.leastMoneyAfterGrow === "number" ? health.leastMoneyAfterGrow : null,
      leastMoneyAfterGrowOn: health.leastMoneyAfterGrowOn ?? null,
    });
    if (typeof health.hacksTrimmedForLevel === "number") anyForecasting = true;
    if (typeof health.mostLevelRise === "number") mostLevelRiseOfRun.set(health.runName, health.mostLevelRise);
    const short = Math.max(0, now.batchesShort - before.batchesShort);
    if (sharingOnHosts(lastHealthOfRun.get(health.runName)) || sharingOnHosts(health)) shortWhileSharing += short;
    else if (short > 0) {
      shortOwn += short;
      firstShortOwnMs ??= atMs;
    }
    if (typeof health.moneyLooks === "number") anyLooking = true;
    const previous = lastHealthOfRun.get(health.runName) ?? (atMs === firstMs ? health : undefined);
    const isNew = (kept: (BatchShort | RamWait)[]) => (each: BatchShort | RamWait) =>
      !kept.some((one) => one.atMs === each.atMs && one.operation === each.operation && one.target === each.target);
    shorts.push(
      ...ramRecordsOf(health, "shorts").filter(isNew(previous === undefined ? [] : ramRecordsOf(previous, "shorts"))),
    );
    waits.push(
      ...ramRecordsOf(health, "waits").filter(isNew(previous === undefined ? [] : ramRecordsOf(previous, "waits"))),
    );
    if (typeof health.ramWaits === "number") anyWaitReporting = true;
    if (firstDroppedMs === null && now.ordersDropped > before.ordersDropped) firstDroppedMs = atMs;
    if (typeof health.longestRamWaitMs === "number" && now.ramWaits > before.ramWaits) {
      longestRamWaitMsOfRun.set(health.runName, health.longestRamWaitMs);
    }
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
  // Recoveries in place past their time (#315's review): something kept the target down, and it was prepared again.
  const timedOut =
    total.recoveriesTimedOut === 0
      ? ""
      : `; ${total.recoveriesTimedOut} recover${total.recoveriesTimedOut === 1 ? "y" : "ies"} in place past its time ` +
        "(a weaken and 10 batches: something kept the target down), the target prepared again";
  lines.push(
    total.desyncs === 0
      ? "  desyncs: none"
      : `  desyncs: ${total.desyncs} (${total.outOfOrder} out of order, ${total.outOfBounds} out of bounds)${timedOut}`,
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
  // stretch a clock step, page stall or delivery lag (#309) explains, which the batcher recovered from by itself, is a
  // warning (#241).
  if (total.desyncs + total.late + total.lost > 0) lines.push(...outOfStepLines(looks, incidentContext, failures));
  const describeBatchCount = (count: number) => `${count} batch${count === 1 ? "" : "es"}`;
  lines.push(
    total.batchesShort === 0
      ? "  short of RAM: none"
      : `  short of RAM: ${describeBatchCount(total.batchesShort)} (${shortWhileSharing} while sharing on the batches' hosts: ` +
          "the share's)",
  );
  lines.push(...ramRecordLines(shorts, total.batchesShort, false));
  // Waits for RAM (#246): each a short avoided; what held the RAM says whether it freed late.
  const longestWaitMs = Math.max(0, ...longestRamWaitMsOfRun.values());
  lines.push(
    !anyWaitReporting
      ? "  waited for RAM (#246): not reported (an older batcher)"
      : total.ramWaits === 0
        ? "  waited for RAM (#246): none"
        : `  waited for RAM (#246): ${total.ramWaits} operation${total.ramWaits === 1 ? "" : "s"} found no room at ` +
          `their time and started within ${BATCH_RAM_WAIT_MS} ms; the longest wait in the run so far ` +
          `${Math.round(longestWaitMs)} ms`,
  );
  lines.push(...ramRecordLines(waits, total.ramWaits, true));
  // Hacks held for their batch's orders waiting, apart from the waits for RAM; orders that found their batch gone, its
  // hack out first (a bug since #253 made the hack the last out), never silent (#246's verification).
  if (anyWaitReporting) {
    lines.push(
      `  hacks held for their batch's orders waiting for RAM (#246): ${total.hacksHeldForBatch || "none"}; orders that ` +
        `found their batch gone: ${total.ordersDropped || "none"}`,
    );
  }
  // An order dropped, a failure: its batch's hack landed without it, a grow or weaken, the loss a short is.
  if (total.ordersDropped > 0) {
    const line =
      `batch orders dropped: ${total.ordersDropped} found their batch gone (a bug since #253), the first seen at ` +
      formatIsoTime(firstDroppedMs ?? firstMs);
    lines.push(`  ${line}`);
    failures.push(line);
  }
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
  // taken after it was planned (anyone else's script on its hosts), RAM freed later than its wait (#246: a landing
  // running late on a busy page), or the fit is wrong. Its hack is lost.
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
  // The level forecast (#315): hacks sized for the level at their landing, where the game takes their share. A line,
  // not a failure: a forecast too low shows as grows short above, and as a desync.
  const mostRise = Math.max(0, ...mostLevelRiseOfRun.values());
  lines.push(
    !anyForecasting
      ? "  the level at the hacks' landings (#315): not reported (an older batcher)"
      : `  the level at the hacks' landings (#315): ${total.hacksTrimmedForLevel} hack` +
          `${total.hacksTrimmedForLevel === 1 ? "" : "s"} sent smaller for the level forecast at their landing; the ` +
          `most levels forecast between a hack's start and its landing: ${mostRise}`,
  );
  lines.push(...homeLines(healths, failures));
  if (homeExpected !== undefined) lines.push(...homeMissingLines(points, failures, resetsMs, homeExpected));
  lines.push(...moveLines(moveFold.moves(resetsMs), moveFold.reporting, failures));
  if (stuck !== undefined) {
    const stuckLooks = healths.map(({ atMs, health }) => ({ atMs, target: health.target }));
    const { incomes, cycleLabelAt } = stuck;
    lines.push(...stuckTargetLines(stuckLooks, incomes, resetsMs, failures, incidentContext.warnings, cycleLabelAt));
  }
  lines.push(problems.size === 0 ? "  problems: none" : "  problems:");
  for (const [problem, atMs] of problems) lines.push(`    from ${formatIsoTime(atMs)}: ${problem}`);
  lines.push(...notRunning);
  lines.push(...sharingLines(healths, readings, failures));
  return lines;
}
