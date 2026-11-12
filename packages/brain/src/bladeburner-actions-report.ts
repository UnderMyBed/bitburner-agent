// The run report's Bladeburner actions (#375, B2 of #359), part of section 8: from the medium snapshots' readings in
// the division (every 10 s), the time each action ran, the stamina, the actions stopped, the rule's forecast, and the
// rank against the forecast of the actions the readings show running. Paths are `vendor/bitburner-src/src/`'s.
// - **The forecast judged** is the actions run, not the rule's cycle: each interval between readings is the action
//   under way at its start (the worker sets it, then reads), for the interval's game seconds (its real ones, and the
//   bonus time spent: `Bladeburner.ts:1376-1380`). A contract or operation adds its attempts there (the seconds over
//   core's `actionSeconds`) times an attempt's mean rank at the chance read (the game's estimate's low end, its stamina
//   penalty in it) and its variance (core's `attemptRankMoments`: each attempt a success's gain or a failure's loss,
//   each ±10% uniform, `Bladeburner.ts:951`, `:980`); Field Analysis its 0.1 × `BladeburnerRank` each 30 s, no offset
//   (`:1136-1140`); the other rests nothing.
// - **Its bound:** the forecast less `BLADEBURNER_RANK_SIGMAS` of its own standard deviation (the square root of the
//   summed variances: the ±10% and each attempt's success), and less what the readings can't place: at each switch and
//   each end of a stretch of readings, an attempt cut short (`Bladeburner.ts:186-188`: starting another loses the
//   progress; at most a success's 110%) and a reading's interval of the faster action, the switch landing somewhere in
//   it. The low end is the game's lowest chance (`Actions/Action.ts:144-167`: never above the real one), so a rank
//   under the bound is the rule or the formulas wrong, not luck. Rank lost below 0 isn't (`:1271-1274`): it only lifts
//   the rank measured.
// - **A stop:** the action under way at one reading, and none found under way at the next (the worker reads before
//   it acts). At a stamina under that action's cost an attempt, the stamina went to 0 (`Bladeburner.ts:1370-1374`), a
//   failure; with its count under 1, the counts ran out (`:1299-1301`); otherwise, other work (`:1356-1368`).
// - **The rule's forecast** (core's `chooseBladeburnerAction` on the first and last readings): its cycle's rank a
//   second, shown beside the rank measured over the readings; not judged, as a window cuts the cycle anywhere.
// - Left out, and labelled: a failure's HP (the hospital's money, `Hospital/Hospital.ts:4-10`), shown as its mean and
//   not weighed; the counts' growth (random, `:1388-1393`); a stretch's readings more than `BLADEBURNER_GAP_MS` apart
//   split it (the snapshots missing: what ran meanwhile isn't known).
import {
  actionHpLoss,
  actionRankGain,
  actionRankLoss,
  actionSeconds,
  actionStaminaCost,
  attemptRankMoments,
  BLADEBURNER_READING_SECONDS,
  BLADEBURNER_REST_SECONDS,
  type BladeburnerActionPlan,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  chooseBladeburnerAction,
  FIELD_ANALYSIS,
  fieldAnalysisRank,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import { type BladeburnerActionId, type BladeburnerActionsReading, bladeburnerSpeedOf } from "./bladeburner.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";

/** Standard deviations of the forecast's own spread below it before the rank fails: 3, a one-in-740 normal tail. */
export const BLADEBURNER_RANK_SIGMAS = 3;
/** Readings further apart than three intervals split a stretch: snapshots missed, what ran meanwhile unknown. */
export const BLADEBURNER_GAP_MS = 3 * BLADEBURNER_READING_SECONDS * 1000;

/** A reading the fold keeps: its time, rank, B2 figures, the player's, and the BitNode's rank multiplier. */
interface Kept {
  atMs: number;
  rank: number;
  reading: BladeburnerActionsReading;
  person: BladeburnerPerson;
  rankMultiplier: number;
}

/** The action under way at `kept`, as the forecast takes it: an attempt's figures, or a rest's rank a second. */
interface Running {
  name: string;
  /** Rank a game second, its mean (a contract's or operation's attempts, or Field Analysis's). */
  rate: number;
  /** An attempt's mean, variance, seconds, stamina, HP lost on failure (a contract's or operation's), or null. */
  attempt: {
    mean: number;
    variance: number;
    seconds: number;
    stamina: number;
    hpLoss: number;
    chance: number;
    gain: number;
  } | null;
}

const sameAction = (a: BladeburnerActionId | null, b: BladeburnerActionId | null) =>
  a !== null && b !== null && a.type === b.type && a.name === b.name;

function runningOf(kept: Kept): Running | null {
  const current = kept.reading.current;
  if (current === null) return null;
  if (current.type === "General") {
    const rate =
      current.name === FIELD_ANALYSIS
        ? fieldAnalysisRank(kept.rankMultiplier) / BLADEBURNER_REST_SECONDS[FIELD_ANALYSIS]
        : 0;
    return { name: current.name, rate, attempt: null };
  }
  const action = bladeburnerLevelledAction(current.type, current.name);
  const read = kept.reading.actions.find((each) => each.type === current.type && each.name === current.name);
  if (action === null || read === undefined) return { name: current.name, rate: 0, attempt: null };
  const seconds = actionSeconds(action, read.level, kept.person);
  const chance = read.chance[0];
  const gain = actionRankGain(action, read.level, kept.rankMultiplier);
  const { mean, variance } = attemptRankMoments(chance, gain, actionRankLoss(action, read.level));
  return {
    name: `${current.name} level ${read.level}`,
    rate: mean / seconds,
    attempt: {
      mean,
      variance,
      seconds,
      stamina: actionStaminaCost(action, read.level),
      hpLoss: actionHpLoss(action, read.level),
      chance,
      gain,
    },
  };
}

/** What the readings can't place at a switch or an end: an attempt cut short, and a reading's interval of the faster. */
function allowanceOf(running: readonly (Running | null)[], speed: number): number {
  const cut = Math.max(0, ...running.map((each) => (each?.attempt ? 1.1 * each.attempt.gain : 0)));
  const fastest = Math.max(0, ...running.map((each) => each?.rate ?? 0));
  return cut + fastest * BLADEBURNER_READING_SECONDS * speed;
}

/** The actions over a window, folded from the medium snapshots in the division, in order. */
export class BladeburnerActionsFold {
  #first: Kept | null = null;
  #last: Kept | null = null;
  #readings = 0;
  #expected = 0;
  #variance = 0;
  #measured = 0;
  #allowance = 0;
  #switches = 0;
  #stretches = 0;
  #hpLost = 0;
  #gameSeconds = 0;
  readonly #byAction = new Map<string, number>();
  #lowestStamina: { atMs: number; stamina: number; max: number } | null = null;
  readonly #stops: { atMs: number; action: string; cause: "stamina" | "count" | "work"; detail: string }[] = [];
  #firstPlan: BladeburnerActionPlan | null = null;

  /** A medium snapshot in the division with B2's reading (`reading`), in BN6 or BN7 (`bitNode`). */
  add(atMs: number, data: MediumSnapshotData, rank: number, reading: BladeburnerActionsReading, bitNode: number): void {
    const person = bladeburnerPersonOf(data.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null) return;
    const kept: Kept = { atMs, rank, reading, person, rankMultiplier };
    this.#readings += 1;
    if (this.#first === null) {
      this.#first = kept;
      this.#firstPlan = this.#plan(kept);
    }
    const lowest = this.#lowestStamina;
    if (lowest === null || reading.stamina / reading.maxStamina < lowest.stamina / lowest.max) {
      this.#lowestStamina = { atMs, stamina: reading.stamina, max: reading.maxStamina };
    }
    const previous = this.#last;
    this.#last = kept;
    const speed = bladeburnerSpeedOf(reading.bonusSeconds);
    const running = runningOf(kept);
    if (previous === null || atMs - previous.atMs > BLADEBURNER_GAP_MS) {
      // A stretch begins: its start's allowance now, and the last one's end (the window's last, in `section`).
      if (previous !== null) {
        this.#allowance += allowanceOf([runningOf(previous)], bladeburnerSpeedOf(previous.reading.bonusSeconds));
      }
      this.#allowance += allowanceOf([running], speed);
      this.#stretches += 1;
      return;
    }
    const before = runningOf(previous);
    const seconds = (atMs - previous.atMs) / 1000 + previous.reading.bonusSeconds - reading.bonusSeconds;
    this.#gameSeconds += seconds;
    this.#measured += rank - previous.rank;
    const name = before?.name ?? "idle";
    this.#byAction.set(name, (this.#byAction.get(name) ?? 0) + (atMs - previous.atMs));
    if (before !== null) {
      if (before.attempt === null) {
        this.#expected += before.rate * seconds;
      } else {
        const attempts = seconds / before.attempt.seconds;
        this.#expected += attempts * before.attempt.mean;
        this.#variance += attempts * before.attempt.variance;
        this.#hpLost += attempts * (1 - before.attempt.chance) * before.attempt.hpLoss;
      }
    }
    const wasRunning = previous.reading.current;
    if (!sameAction(wasRunning, reading.current) || !sameAction(wasRunning, reading.found)) {
      if (wasRunning !== null || reading.current !== null) {
        this.#switches += 1;
        this.#allowance += allowanceOf([before, running], speed);
      }
    }
    // A stop: under way at the last reading, none found now.
    if (wasRunning !== null && reading.found === null) {
      const read = reading.actions.find((each) => each.type === wasRunning.type && each.name === wasRunning.name);
      const cost = before?.attempt?.stamina ?? 0;
      const cause =
        before?.attempt != null && reading.stamina < cost
          ? "stamina"
          : read !== undefined && read.count < 1
            ? "count"
            : "work";
      const detail =
        cause === "stamina"
          ? `stamina ${reading.stamina.toFixed(2)} / ${reading.maxStamina.toFixed(1)}, under an attempt's ` +
            `${cost.toFixed(2)}`
          : cause === "count"
            ? `its count ${(read?.count ?? 0).toFixed(2)}, under 1`
            : "stopped with stamina and count left: other work";
      this.#stops.push({ atMs, action: wasRunning.name, cause, detail });
    }
  }

  #plan(kept: Kept): BladeburnerActionPlan {
    return chooseBladeburnerAction({
      readings: kept.reading.actions,
      person: kept.person,
      stamina: kept.reading.stamina,
      maxStamina: kept.reading.maxStamina,
      rankMultiplier: kept.rankMultiplier,
      speed: bladeburnerSpeedOf(kept.reading.bonusSeconds),
    });
  }

  /** The actions' lines, its failures added to `failures`; none without a reading. */
  section(failures: string[]): string[] {
    const first = this.#first;
    const last = this.#last;
    if (first === null || last === null) {
      return ["  the actions (#375): no reading with them (the worker's, once home's RAM holds it)"];
    }
    const perMinute = (perSecond: number) => `${(perSecond * 60).toFixed(3)} rank/min`;
    const lines = [
      `  the actions (#375): ${this.#readings} readings from ${formatIsoTime(first.atMs)} to ` +
        `${formatIsoTime(last.atMs)}, ${this.#stretches} stretch${this.#stretches === 1 ? "" : "es"}`,
    ];
    const byAction = [...this.#byAction].sort((a, b) => b[1] - a[1]);
    lines.push(
      `    time under way: ${byAction.length === 0 ? "none between readings" : byAction.map(([name, ms]) => `${name} ${formatDuration(ms)}`).join(", ")}`,
    );
    const lowest = this.#lowestStamina;
    if (lowest !== null) {
      lines.push(
        `    stamina: lowest ${((100 * lowest.stamina) / lowest.max).toFixed(0)}% of the max ` +
          `(${lowest.stamina.toFixed(1)} / ${lowest.max.toFixed(1)}, ${formatIsoTime(lowest.atMs)}); at the last ` +
          `reading ${last.reading.stamina.toFixed(1)} / ${last.reading.maxStamina.toFixed(1)}`,
      );
    }
    const planText = (plan: BladeburnerActionPlan | null) =>
      plan === null
        ? "none"
        : plan.work === null
          ? `${perMinute(plan.rankPerSecond)}, ${plan.rest.name} alone`
          : `${perMinute(plan.rankPerSecond)}, ${plan.work.name} level ${plan.work.level} worked ` +
            `${(100 * plan.duty).toFixed(0)}% with ${plan.rest.name}`;
    const spanMs = last.atMs - first.atMs;
    lines.push(
      `    the rule's forecast over a cycle: ${planText(this.#firstPlan)} at the first reading; ` +
        `${planText(this.#plan(last))} at the last. Measured: ${perMinute(spanMs > 0 ? (last.rank - first.rank) / (spanMs / 1000) : 0)} ` +
        `(rank ${first.rank.toFixed(1)} → ${last.rank.toFixed(1)} over ${formatDuration(spanMs)})`,
    );
    const sigma = Math.sqrt(this.#variance);
    // The last stretch's end, with the others' ends and switches.
    const allowance = this.#allowance + allowanceOf([runningOf(last)], bladeburnerSpeedOf(last.reading.bonusSeconds));
    const bound = this.#expected - BLADEBURNER_RANK_SIGMAS * sigma - allowance;
    lines.push(
      `    rank from the actions run: ${this.#measured.toFixed(2)} measured against ${this.#expected.toFixed(2)} ` +
        `forecast (σ ${sigma.toFixed(2)}), its bound ${bound.toFixed(2)}: the forecast less ${BLADEBURNER_RANK_SIGMAS}σ ` +
        `and ${allowance.toFixed(2)} for ${this.#switches} switch${this.#switches === 1 ? "" : "es"} and the ` +
        `stretches' ends; over ${formatDuration(this.#gameSeconds * 1000)} of game time`,
    );
    lines.push(
      `    HP lost to failures, its mean: ${this.#hpLost.toFixed(1)} (the hospital's money, not weighed: the planner's)`,
    );
    lines.push("    actions stopped between readings:");
    const others = this.#stops.filter((each) => each.cause !== "stamina");
    if (others.length === 0) lines.push("      none but at stamina 0 (below)");
    for (const stop of others) {
      lines.push(
        `      ${formatIsoTime(stop.atMs)}: ${stop.action}, ${stop.cause === "count" ? "the counts ran out" : "other work"} (${stop.detail})`,
      );
    }
    lines.push("  an action stopped at stamina 0 at any reading:");
    const atZero = this.#stops.filter((each) => each.cause === "stamina");
    if (atZero.length === 0) lines.push("    none");
    for (const stop of atZero) {
      const line = `an action stopped at stamina 0: ${stop.action}, found idle ${formatIsoTime(stop.atMs)} (${stop.detail})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    lines.push("  the rank from the actions run below its forecast's bound:");
    if (this.#measured >= bound) lines.push("    none");
    else {
      const line =
        `the rank from the actions run below its forecast's bound: ${this.#measured.toFixed(2)} against ` +
        `${bound.toFixed(2)} (forecast ${this.#expected.toFixed(2)}, σ ${sigma.toFixed(2)}), from ` +
        `${formatIsoTime(first.atMs)} to ${formatIsoTime(last.atMs)}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    return lines;
  }
}
