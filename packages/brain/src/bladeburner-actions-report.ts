// The run report's Bladeburner actions (#375, B2 of #359), part of section 8: from the medium snapshots' readings in
// the division (every 10 s), the time each action ran, the stamina, the hospital, the actions stopped, the rule's
// forecast, and the rank against the forecast of the actions the readings show running. Paths are
// `vendor/bitburner-src/src/`'s.
// - **The forecast judged** is the actions run, not the rule's cycle: each interval between readings is the action
//   under way at its start (the worker sets it, then reads), for the interval's game seconds (its real ones, and the
//   bonus time spent: `Bladeburner.ts:1376-1380`). A contract or operation adds its attempts there (the seconds over
//   core's `actionSeconds`) times an attempt's mean rank at the chance read (the game's estimate's low end, its stamina
//   penalty in it) and its variance (core's `attemptRankMoments`: each attempt a success's gain or a failure's loss,
//   each ±10% uniform, `Bladeburner.ts:951`, `:980`); Field Analysis its 0.1 × `BladeburnerRank` each 30 s, no offset
//   (`:1136-1140`); the other rests nothing.
// - **Its bound** (#377's review): the forecast less the margin Bernstein's inequality gives at a false failure's chance
//   `BLADEBURNER_RANK_ALPHA` (`bernsteinMargin`), and less one attempt's mean (its chance × its gain) at each switch and
//   each stretch's end, the attempt cut short there (`Bladeburner.ts:186-188`: starting another loses the progress)
//   that the forecast counts in part. The low end is the game's lowest chance (`Actions/Action.ts:144-167`: never above
//   the real one), so a rank under the bound is the rule or the formulas wrong, not luck. Rank lost below 0 isn't
//   (`:1271-1274`): it only lifts the rank measured.
// - **A stop:** the action under way at one reading, and none found under way at the next (the worker reads before
//   it acts). At a stamina under that action's cost an attempt and the regain over the interval (#377's review: bonus
//   time's regain is five times the real seconds'), the stamina went to 0 (`Bladeburner.ts:1370-1374`), a failure; with
//   its count under 1, the counts ran out (`:1299-1301`); otherwise, other work (`:1356-1368`).
// - **Stuck resting** (#377's review): the rule's plan with work (core's `chooseBladeburnerAction` on each reading)
//   and a rest under way, for longer than twice the rule's own time to rest to the max ((max − stamina) over the rest's
//   stamina a second, at the stretch's first reading) and `BLADEBURNER_REST_SLACK_MS`, as #343's waits are bounded: a
//   failure. Idle (the owner's work, or a stop) isn't resting.
// - **The hospital** (#377's review): HP isn't in the rule's choice (money against rank is the planner's, #375). A
//   visit is the HP back at its max from under it, with no Regeneration Chamber's 2 under way (`Bladeburner.ts:983-991`,
//   `PersonObjects/Player/PlayerObjectGeneralMethods.ts:266-290`); its bill is min(10% of the money, (max − HP) ×
//   $100k) with the HP at 0 or under (`Hospital/Hospital.ts:4-17`, `Constants.ts:47`), so at least
//   min(10% of the money, max × $100k). Two visits between readings count as one.
// - **The focus** (#377's review): A5's faction work waits all the actions' time, the rests' too, Field Analysis's rank
//   all it gains then; the time and that rank are shown, the trade the planner's.
// - **The rule's forecast** (core's `chooseBladeburnerAction` on the first and last readings): its cycle's rank a
//   second, shown beside the rank measured over the readings; not judged, as a window cuts the cycle anywhere.
// - Left out, and labelled: the counts' growth (random, `:1388-1393`); a stretch's readings more than
//   `BLADEBURNER_GAP_MS` apart split it (the snapshots missing: what ran meanwhile isn't known).
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
  REGENERATION_CHAMBER,
  staminaGainPerSecond,
} from "@bitburner-agent/core";
import { type BladeburnerActionId, type BladeburnerActionsReading, bladeburnerSpeedOf } from "./bladeburner.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";

/**
 * The rank's false failure's chance a report (#377's review): 1 in 1,000. The owner reads each run's report and acts on
 * its failures (decision 45), at about a run a day; at this rate a check that is right fails falsely about once in
 * three years of runs, while the margin it costs grows only as √ln(1/α).
 */
export const BLADEBURNER_RANK_ALPHA = 0.001;
/** Readings further apart than three intervals split a stretch: snapshots missed, what ran meanwhile unknown. */
export const BLADEBURNER_GAP_MS = 3 * BLADEBURNER_READING_SECONDS * 1000;
/** Stuck resting's slack beyond twice the rule's time to the max: 10 minutes, as #343's waits. */
export const BLADEBURNER_REST_SLACK_MS = 10 * 60_000;
/** The hospital's bill an HP (`Constants.ts`: `HospitalCostPerHp: 100e3`). */
const HOSPITAL_COST_PER_HP = 100e3;

/**
 * Bernstein's inequality's margin (Boucheron, Lugosi and Massart, "Concentration Inequalities", 2013, Corollary 2.11;
 * Bernstein, 1924): for independent attempts whose rank is at most `below` under its mean (here an attempt's mean and a
 * failure's loss at 110%) and whose variances sum to `variance`, P(sum < mean − t) ≤ exp(−t² / (2(variance +
 * below·t/3))). Set to `alpha` and solved: t = L·below/3 + √((L·below/3)² + 2·L·variance), L = ln(1/alpha).
 */
export function bernsteinMargin(variance: number, below: number, alpha: number): number {
  const logs = Math.log(1 / alpha);
  const linear = (logs * below) / 3;
  return linear + Math.sqrt(linear * linear + 2 * logs * variance);
}

/** A reading the fold keeps: its time, rank, B2 figures, the player's, its money and HP, the rank multiplier. */
interface Kept {
  atMs: number;
  rank: number;
  reading: BladeburnerActionsReading;
  person: BladeburnerPerson;
  rankMultiplier: number;
  money: number | null;
  hp: { current: number; max: number } | null;
}

/** The action under way at `kept`, as the forecast takes it: an attempt's figures, or a rest's rank a second. */
interface Running {
  name: string;
  /** A rest (Field Analysis, the Chamber, Training), not a contract or operation. */
  resting: boolean;
  /** Rank a game second, its mean (a contract's or operation's attempts, or Field Analysis's). */
  rate: number;
  /** One attempt's mean (chance × gain; Field Analysis's 0.1): what a cut costs. */
  cut: number;
  /** An attempt's mean, variance, seconds, stamina, HP lost on failure (a contract's or operation's), or null. */
  attempt: {
    mean: number;
    variance: number;
    /** How far under its mean an attempt's rank can go: the mean, and a failure's loss at 110%. */
    below: number;
    seconds: number;
    stamina: number;
    hpLoss: number;
    chance: number;
  } | null;
}

const sameAction = (a: BladeburnerActionId | null, b: BladeburnerActionId | null) =>
  a !== null && b !== null && a.type === b.type && a.name === b.name;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function runningOf(kept: Kept): Running | null {
  const current = kept.reading.current;
  if (current === null) return null;
  if (current.type === "General") {
    const fieldAnalysis = current.name === FIELD_ANALYSIS;
    const gain = fieldAnalysis ? fieldAnalysisRank(kept.rankMultiplier) : 0;
    return {
      name: current.name,
      resting: true,
      rate: fieldAnalysis ? gain / BLADEBURNER_REST_SECONDS[FIELD_ANALYSIS] : 0,
      cut: gain,
      attempt: null,
    };
  }
  const action = bladeburnerLevelledAction(current.type, current.name);
  const read = kept.reading.actions.find((each) => each.type === current.type && each.name === current.name);
  if (action === null || read === undefined)
    return { name: current.name, resting: false, rate: 0, cut: 0, attempt: null };
  const seconds = actionSeconds(action, read.level, kept.person);
  const chance = read.chance[0];
  const gain = actionRankGain(action, read.level, kept.rankMultiplier);
  const loss = actionRankLoss(action, read.level);
  const { mean, variance } = attemptRankMoments(chance, gain, loss);
  return {
    name: `${current.name} level ${read.level}`,
    resting: false,
    rate: mean / seconds,
    cut: chance * gain,
    attempt: {
      mean,
      variance,
      below: mean + 1.1 * loss,
      seconds,
      stamina: actionStaminaCost(action, read.level),
      hpLoss: actionHpLoss(action, read.level),
      chance,
    },
  };
}

/** A stretch resting while the plan has work: from, to, and its bound (twice the time to the max, and the slack). */
interface Resting {
  fromMs: number;
  toMs: number;
  boundMs: number;
  detail: string;
}

/** The actions over a window, folded from the medium snapshots in the division, in order. */
export class BladeburnerActionsFold {
  #first: Kept | null = null;
  #last: Kept | null = null;
  #readings = 0;
  #expected = 0;
  #variance = 0;
  #below = 0;
  #measured = 0;
  #allowance = 0;
  #switches = 0;
  #stretches = 0;
  #hpLost = 0;
  #gameSeconds = 0;
  readonly #byAction = new Map<string, number>();
  #actingMs = 0;
  #restingMs = 0;
  #restingRank = 0;
  #lowestStamina: { atMs: number; stamina: number; max: number } | null = null;
  readonly #stops: { atMs: number; action: string; cause: "stamina" | "count" | "work"; detail: string }[] = [];
  readonly #visits: { atMs: number; leastBill: number }[] = [];
  readonly #resting: Resting[] = [];
  #restingOpen: Resting | null = null;
  #firstPlan: BladeburnerActionPlan | null = null;

  /** A medium snapshot in the division with B2's reading (`reading`), in BN6 or BN7 (`bitNode`). */
  add(atMs: number, data: MediumSnapshotData, rank: number, reading: BladeburnerActionsReading, bitNode: number): void {
    const person = bladeburnerPersonOf(data.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null) return;
    const player = data.player as { money?: unknown; hp?: { current?: unknown; max?: unknown } } | undefined;
    const hp = player?.hp;
    const kept: Kept = {
      atMs,
      rank,
      reading,
      person,
      rankMultiplier,
      money: isNumber(player?.money) ? player.money : null,
      hp: isNumber(hp?.current) && isNumber(hp?.max) ? { current: hp.current, max: hp.max } : null,
    };
    this.#readings += 1;
    const plan = this.#plan(kept);
    if (this.#first === null) {
      this.#first = kept;
      this.#firstPlan = plan;
    }
    const lowest = this.#lowestStamina;
    if (lowest === null || reading.stamina / reading.maxStamina < lowest.stamina / lowest.max) {
      this.#lowestStamina = { atMs, stamina: reading.stamina, max: reading.maxStamina };
    }
    const running = runningOf(kept);
    this.#watchResting(atMs, kept, plan, running);
    const previous = this.#last;
    this.#last = kept;
    if (previous === null || atMs - previous.atMs > BLADEBURNER_GAP_MS) {
      // A stretch begins: the last one's end cut (the window's last, in `section`), and none to place yet here.
      if (previous !== null) this.#allowance += runningOf(previous)?.cut ?? 0;
      this.#stretches += 1;
      return;
    }
    const before = runningOf(previous);
    const intervalMs = atMs - previous.atMs;
    const seconds = intervalMs / 1000 + previous.reading.bonusSeconds - reading.bonusSeconds;
    this.#gameSeconds += seconds;
    this.#measured += rank - previous.rank;
    const name = before?.name ?? "idle";
    this.#byAction.set(name, (this.#byAction.get(name) ?? 0) + intervalMs);
    if (before !== null) {
      this.#actingMs += intervalMs;
      if (before.resting) {
        this.#restingMs += intervalMs;
        this.#restingRank += before.rate * seconds;
      }
      if (before.attempt === null) {
        this.#expected += before.rate * seconds;
      } else {
        const attempts = seconds / before.attempt.seconds;
        this.#expected += attempts * before.attempt.mean;
        this.#variance += attempts * before.attempt.variance;
        this.#below = Math.max(this.#below, before.attempt.below);
        this.#hpLost += attempts * (1 - before.attempt.chance) * before.attempt.hpLoss;
      }
    }
    const wasRunning = previous.reading.current;
    if (!sameAction(wasRunning, reading.current) || !sameAction(wasRunning, reading.found)) {
      if (wasRunning !== null || reading.current !== null) {
        this.#switches += 1;
        this.#allowance += before?.cut ?? 0;
      }
    }
    // A stop: under way at the last reading, none found now.
    if (wasRunning !== null && reading.found === null) {
      const read = reading.actions.find((each) => each.type === wasRunning.type && each.name === wasRunning.name);
      // The stamina an attempt could leave and still have stopped it: its cost, and the regain since (at most the
      // interval's game seconds of it).
      const cost = before?.attempt?.stamina ?? 0;
      const regained = staminaGainPerSecond(previous.person, previous.reading.maxStamina) * Math.max(0, seconds);
      const cause =
        before?.attempt != null && reading.stamina < cost + regained
          ? "stamina"
          : read !== undefined && read.count < 1
            ? "count"
            : "work";
      const detail =
        cause === "stamina"
          ? `stamina ${reading.stamina.toFixed(2)} / ${reading.maxStamina.toFixed(1)}, under an attempt's ` +
            `${cost.toFixed(2)} and ${regained.toFixed(2)} regained since`
          : cause === "count"
            ? `its count ${(read?.count ?? 0).toFixed(2)}, under 1`
            : "stopped with stamina and count left: other work";
      this.#stops.push({ atMs, action: wasRunning.name, cause, detail });
    }
    // The hospital: the HP back at its max from under it, not by the Chamber's 2.
    const was = previous.hp;
    const now = kept.hp;
    if (was !== null && now !== null && was.current < was.max && now.current >= now.max) {
      const chamber = previous.reading.current?.name === REGENERATION_CHAMBER;
      if (!chamber || now.current - was.current > 2) {
        const money = previous.money ?? 0;
        this.#visits.push({ atMs, leastBill: Math.min(0.1 * Math.max(0, money), now.max * HOSPITAL_COST_PER_HP) });
      }
    }
  }

  /** Stuck resting: the plan has work and a rest is under way; each stretch's bound from its first reading. */
  #watchResting(atMs: number, kept: Kept, plan: BladeburnerActionPlan, running: Running | null): void {
    const stuck = plan.work !== null && running?.resting === true;
    if (!stuck) {
      if (this.#restingOpen !== null) this.#resting.push(this.#restingOpen);
      this.#restingOpen = null;
      return;
    }
    if (this.#restingOpen !== null) {
      this.#restingOpen.toMs = atMs;
      return;
    }
    const { stamina, maxStamina } = kept.reading;
    const gain = plan.rest.staminaPerSecond > 0 ? plan.rest.staminaPerSecond : plan.regain;
    const toMaxMs = gain > 0 ? (Math.max(0, maxStamina - stamina) / gain) * 1000 : Number.POSITIVE_INFINITY;
    this.#restingOpen = {
      fromMs: atMs,
      toMs: atMs,
      boundMs: Math.ceil(2 * toMaxMs) + BLADEBURNER_REST_SLACK_MS,
      detail:
        `stamina ${stamina.toFixed(1)} / ${maxStamina.toFixed(1)} at its start, the rule's time to the max ` +
        `${formatDuration(toMaxMs)} with ${plan.rest.name}; the plan's work ${plan.work?.name} level ${plan.work?.level}`,
    };
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
    lines.push(
      `    the focus: A5's faction work waited ${formatDuration(this.#actingMs)} for the actions, ` +
        `${formatDuration(this.#restingMs)} of it resting, for ${this.#restingRank.toFixed(2)} rank (Field ` +
        "Analysis's): the planner's trade",
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
    const margin = bernsteinMargin(this.#variance, this.#below, BLADEBURNER_RANK_ALPHA);
    // The last stretch's end, with the others' ends and the switches.
    const allowance = this.#allowance + (runningOf(last)?.cut ?? 0);
    const bound = this.#expected - margin - allowance;
    lines.push(
      `    rank from the actions run: ${this.#measured.toFixed(2)} measured against ${this.#expected.toFixed(2)} ` +
        `forecast (σ ${Math.sqrt(this.#variance).toFixed(2)}), its bound ${bound.toFixed(2)}: the forecast less ` +
        `Bernstein's ${margin.toFixed(2)} at α ${BLADEBURNER_RANK_ALPHA} and ${allowance.toFixed(2)} for ` +
        `${this.#switches} switch${this.#switches === 1 ? "" : "es"} and the stretches' ends; over ` +
        `${formatDuration(this.#gameSeconds * 1000)} of game time`,
    );
    const bills = this.#visits.reduce((total, each) => total + each.leastBill, 0);
    const maxHp = last.hp?.max;
    lines.push(
      `    the hospital (HP isn't in the rule's choice: money against rank is the planner's): ${this.#visits.length} ` +
        `visit${this.#visits.length === 1 ? "" : "s"} seen, at least $${Math.round(bills).toLocaleString("en-US")}; ` +
        `the failures' HP ${this.#hpLost.toFixed(1)} forecast` +
        (isNumber(maxHp) && maxHp > 0 ? `, about ${(this.#hpLost / maxHp).toFixed(1)} visits at ${maxHp} HP` : ""),
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
        `${bound.toFixed(2)} (forecast ${this.#expected.toFixed(2)}, Bernstein's margin ${margin.toFixed(2)}), from ` +
        `${formatIsoTime(first.atMs)} to ${formatIsoTime(last.atMs)}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    lines.push("  resting with the plan's work waiting, past twice the rule's time to the max and 10 min:");
    const stuck = [...this.#resting, ...(this.#restingOpen === null ? [] : [this.#restingOpen])].filter(
      (each) => each.toMs - each.fromMs > each.boundMs,
    );
    if (stuck.length === 0) lines.push("    none");
    for (const each of stuck) {
      const line =
        `resting with the plan's work waiting from ${formatIsoTime(each.fromMs)} to ${formatIsoTime(each.toMs)}, ` +
        `for ${formatDuration(each.toMs - each.fromMs)}, past its bound ${formatDuration(each.boundMs)} (${each.detail})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    return lines;
  }
}
