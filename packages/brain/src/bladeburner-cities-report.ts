// The run report's Bladeburner cities and chaos (#383, B4 of #359), part of section 8: from the medium snapshots'
// readings in the division with the cities (every 10 s), where the division worked, each city's chaos and population
// estimate, the counts, the time in Diplomacy and Incite Violence, and the rule's choice (core's
// `chooseBladeburnerCity`) at the last reading. Paths are `vendor/bitburner-src/src/`'s.
// - **The round** (#420): each reading's round over the six, its cities recovered (with the pop/popEst each gave), by
//   their own ranges, or at the draw's mean, as the brain measures them (`bladeburnerMeasuredCitiesOf`); the rule's
//   choice is weighed at those. A reading with the cities read and no round (it failed, an older Agent's, or the
//   division not back in its city) is a failure at once, as it's the `bladeburnerCityRound` alert (Fail Fast).
// - **The chaos left** (decision 45): the chaos where the division works over 50, with the rule's own measure wanting
//   it off (core's `chooseBladeburnerCity` on each reading), for longer than its bound: a failure.
//   - **Diplomacy paying:** twice the rule's own Diplomacy estimate (core's `diplomaciesTo50` of 60 s each, at the
//     stretch's first reading) and `BLADEBURNER_CHAOS_SLACK_MS`. Real time against the game's seconds: bonus time only
//     shortens Diplomacy (`Bladeburner.ts:1376-1380`), so the bound errs long.
//   - **A move to another city** (#385's review): `BLADEBURNER_MOVE_WITHIN_MS`, a few readings, as a move takes one;
//     with a chaos action under way at the reading that first wants it (#420's ruling 3), plus that run's game seconds
//     left then, by the rule's own clock: #385's rule keeps the run to its end with the city held, so the move waits.
//   A stretch whose wanted fix changes kind ends, and the next begins with its own bound. Idle (the owner's work, or a
//   stop) isn't the rule's; a gap in the readings or an install ends the stretch, as stuck resting's.
// - Left out, and labelled: the random events (`:601-699`), seen only as the figures they move.
import {
  BLADEBURNER_CHAOS_ACTION_SECONDS,
  BLADEBURNER_CONSTANTS,
  BLADEBURNER_FACTION,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_READING_SECONDS,
  type BladeburnerCityChoice,
  type BladeburnerCityMeasure,
  bladeburnerBlackOp,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerRankTarget,
  chooseBladeburnerAction,
  chooseBladeburnerCity,
  DIPLOMACY,
  diplomaciesTo50,
  INCITE_VIOLENCE,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import {
  type BladeburnerActionsReading,
  bladeburnerMeasuredCitiesOf,
  bladeburnerRoundProblem,
  bladeburnerRuleInputOf,
  describeCityChoice,
  describeCityMeasures,
} from "./bladeburner.ts";
import { BLADEBURNER_GAP_MS } from "./bladeburner-actions-report.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";

/**
 * The chaos left's slack beyond twice the rule's Diplomacy estimate: 10 minutes, picked, as #343's waits' slack was
 * (#385's review): room for a reading's or a run's delay, not a figure the game gives.
 */
export const BLADEBURNER_CHAOS_SLACK_MS = 10 * 60_000;
/**
 * How long a wanted move may take (#385's review): 22 s, from the reading cadence. The brain sends the city at the
 * reading that wants it; the state's change makes the Agent's Bladeburner run due at once, its next round (2 s), whose
 * city worker moves the division; the medium snapshot after carries that within a reading (10 s,
 * `BLADEBURNER_READING_SECONDS`); and one reading more for a run the round's deadline put off.
 */
export const BLADEBURNER_MOVE_WITHIN_MS = 2 * BLADEBURNER_READING_SECONDS * 1000 + 2_000;

/** A reading the fold keeps: its time, the city, the cities, the counts, the action under way, the cycle's install. */
interface Kept {
  atMs: number;
  city: string;
  reading: BladeburnerActionsReading;
  lastAugReset: number | null;
  /**
   * The rule's choice at this reading, solved where a check reads it (#396): the chaos over 50 with an action under
   * way (`#watchChaos`), and the last reading's line; solved once.
   */
  choice: () => BladeburnerCityChoice | null;
}

/** A stretch of chaos left over 50 with the rule's measure wanting it off: from, to, its kind, its bound, and why. */
interface Left {
  kind: "move" | "diplomacy";
  fromMs: number;
  toMs: number;
  boundMs: number;
  detail: string;
}

const millions = (population: number) => `${(population / 1e6).toFixed(0)}m`;

/** The cities over a window, folded from the medium snapshots in the division with them, in order. */
export class BladeburnerCitiesFold {
  #first: Kept | null = null;
  #last: Kept | null = null;
  #readings = 0;
  #switches = 0;
  readonly #byCity = new Map<string, number>();
  readonly #chaosActionMs = new Map<string, number>();
  readonly #left: Left[] = [];
  #leftOpen: Left | null = null;
  /** The rounds (#420): the readings measured, each city's counts by kind and pop/popEst's range, the last's. */
  #rounds = 0;
  readonly #measured = new Map<
    string,
    Record<BladeburnerCityMeasure["by"], number> & {
      blackOp: number;
      estimate: number;
      gap: number;
      low: number;
      high: number;
    }
  >();
  #lastMeasures: BladeburnerCityMeasure[] | null = null;
  readonly #roundFailed: { fromMs: number; toMs: number; detail: string }[] = [];
  #roundOpen: { fromMs: number; toMs: number; detail: string } | null = null;
  /** The chaos action under way (#385) since its first reading under way, as the rule's `#keptChaosAction` counts it. */
  #chaosSince: { name: string; atMs: number; bonusSeconds: number; keptRun: number } | null = null;
  /** Whether the rule keeps the chaos action's run under way at the reading being added (#385, its `#keptChaosAction`). */
  #keptNow = false;
  /** The previous reading's chaos action under way, its run and whether the rule kept it (for the re-keep on its order). */
  #lastChaos: { name: string; run: number; kept: boolean } | null = null;

  /** A medium snapshot in the division with B4's reading (its `city` and `cities`), in BN6 or BN7 (`bitNode`). */
  add(
    atMs: number,
    data: MediumSnapshotData,
    reading: BladeburnerActionsReading,
    bitNode: number,
    lastAugReset: number | null = null,
    /** The rank read (#386): under its current-rank target, the city by the least time to it, as the brain's. */
    rank: number | null = null,
    /** B2's forecast for this reading, shared with its other folds (#392); none given, its own. */
    choose: typeof chooseBladeburnerAction = chooseBladeburnerAction,
    /** The reading's problems (#420: the round's among them). */
    problems: readonly string[] = [],
  ): void {
    const { city, cities } = reading;
    if (city === null || cities === null) return;
    const person = bladeburnerPersonOf(data.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null) return;
    const factions = (data.player as { factions?: unknown } | undefined)?.factions;
    const factionJoined = Array.isArray(factions) && factions.includes(BLADEBURNER_FACTION);
    // The next Black Op's rank (#392) the target too, as the brain's.
    const blackOpRank = reading.blackOp == null ? null : (bladeburnerBlackOp(reading.blackOp.name)?.rank ?? null);
    const target = rank === null ? null : bladeburnerRankTarget({ rank, factionJoined, blackOpRank });
    // Each city measured by the round (#420), as the brain's: none weighed without it.
    const measured = bladeburnerMeasuredCitiesOf(reading, person);
    this.#watchRound(atMs, reading, problems, measured?.measures ?? null);
    // Solved on demand (#396): a far target's solve is tens of milliseconds, its input new each reading (the rank moves,
    // so a cache by value never hits), and most readings no check reads it.
    let solved: { choice: BladeburnerCityChoice | null } | null = null;
    const choice = () => {
      if (solved === null) {
        solved = {
          choice:
            measured === null
              ? null
              : chooseBladeburnerCity(
                  {
                    // As the brain's (#415): each chance at the true population.
                    ...bladeburnerRuleInputOf(reading, person, rankMultiplier, data.player).input,
                    ...(target === null || rank === null ? {} : { target: { rank, target } }),
                  },
                  { city, cities: measured.cities },
                  choose,
                ),
        };
      }
      return solved.choice;
    };
    const kept: Kept = { atMs, city, reading, lastAugReset, choice };
    // The chaos action under way since its first reading so, and the run #385's rule keeps (#422's review: mirroring
    // the rule's `#keptChaosAction` and `#chaosRunOf`): the first run, and each later one the rule chose again at its
    // first reading (`keptRun`). A move waits on a kept run only (#420's ruling 3).
    const now = reading.current;
    const chaosName =
      now?.type === "General" && (now.name === DIPLOMACY || now.name === INCITE_VIOLENCE) ? now.name : null;
    if (chaosName === null) this.#chaosSince = null;
    else if (this.#chaosSince?.name !== chaosName) {
      this.#chaosSince = { name: chaosName, atMs, bonusSeconds: reading.bonusSeconds, keptRun: 0 };
    }
    const since = this.#chaosSince;
    // The rule re-keeps a run on its order (`bladeburner.ts:1413`: `order.name` the chaos action, at a reading where
    // the run wasn't kept; a Black Op's order or a rebuild's Training wins over it). The order isn't in the store, but
    // the worker runs it, so it's this reading's action under way: the same chaos action still under way after a
    // reading that didn't keep its run means the rule ordered it there, and keeps that run (#422's round 2).
    const last = this.#lastChaos;
    if (since !== null && last !== null && last.name === since.name && !last.kept) {
      since.keptRun = Math.max(since.keptRun, last.run);
    }
    const run = since === null ? 0 : this.#runOf(since, kept);
    this.#keptNow = since !== null && run <= since.keptRun;
    this.#lastChaos = since === null ? null : { name: since.name, run, kept: this.#keptNow };
    this.#readings += 1;
    if (this.#first === null) this.#first = kept;
    const previous = this.#last;
    this.#last = kept;
    const broken =
      previous === null || atMs - previous.atMs > BLADEBURNER_GAP_MS || previous.lastAugReset !== lastAugReset;
    this.#watchChaos(kept, person.skills.charisma, broken);
    if (broken || previous === null) return;
    const intervalMs = atMs - previous.atMs;
    if (previous.city !== city) this.#switches += 1;
    this.#byCity.set(previous.city, (this.#byCity.get(previous.city) ?? 0) + intervalMs);
    const under = previous.reading.current;
    if (under?.type === "General" && (under.name === DIPLOMACY || under.name === INCITE_VIOLENCE)) {
      this.#chaosActionMs.set(under.name, (this.#chaosActionMs.get(under.name) ?? 0) + intervalMs);
    }
  }

  /**
   * The round (#420) at a reading: each city's measure counted (recovered, with the least and most pop/popEst it gave,
   * and how often by the Black Op's range; at the draw's mean, every range clipped, #420's ruling 4), the last kept,
   * and a stretch of readings with its problem (failed, missing, not back in the division's city, or a city's ranges
   * disagreeing), each a failure from its first reading.
   */
  #watchRound(
    atMs: number,
    reading: BladeburnerActionsReading,
    problems: readonly string[],
    measures: BladeburnerCityMeasure[] | null,
  ): void {
    const problem = bladeburnerRoundProblem(reading, problems, measures);
    if (problem === null || this.#roundOpen?.detail !== problem) {
      if (this.#roundOpen !== null) this.#roundFailed.push(this.#roundOpen);
      this.#roundOpen = problem === null ? null : { fromMs: atMs, toMs: atMs, detail: problem };
    } else this.#roundOpen.toMs = atMs;
    if (measures === null) return;
    this.#rounds += 1;
    this.#lastMeasures = measures;
    for (const measure of measures) {
      const seen = this.#measured.get(measure.name) ?? {
        recovered: 0,
        blackOp: 0,
        draw: 0,
        estimate: 0,
        gap: 0,
        low: Infinity,
        high: 0,
      };
      seen[measure.by] += 1;
      if (measure.source === "the Black Op") seen.blackOp += 1;
      // Picked by the estimate's own chance (#422's round 2), with its bound: the other root's distance.
      if (measure.pickedBy === "estimate") {
        seen.estimate += 1;
        seen.gap = Math.max(seen.gap, measure.rootGap);
      }
      if (measure.ratio !== null) {
        seen.low = Math.min(seen.low, measure.ratio);
        seen.high = Math.max(seen.high, measure.ratio);
      }
      this.#measured.set(measure.name, seen);
    }
  }

  /** The chaos left over 50 where the division works, the rule's measure wanting it off; a stretch's bound at its start. */
  #watchChaos(kept: Kept, charisma: number, broken: boolean): void {
    const here = kept.reading.cities?.find((each) => each.name === kept.city);
    // The choice solved only with the chaos over 50 and an action under way (#396): elsewhere no kind, whatever it is.
    const over =
      here !== undefined && kept.reading.current !== null && here.chaos > BLADEBURNER_CONSTANTS.chaosThreshold;
    const choice = over ? kept.choice() : null;
    const kind =
      choice === null
        ? null
        : choice.city !== kept.city
          ? "move"
          : choice.diplomacy?.pays === true
            ? "diplomacy"
            : null;
    if (kind === null || broken || this.#leftOpen?.kind !== kind) {
      if (this.#leftOpen !== null) this.#left.push(this.#leftOpen);
      this.#leftOpen = null;
      if (kind === null) return;
    }
    if (this.#leftOpen !== null) {
      this.#leftOpen.toMs = kept.atMs;
      return;
    }
    const attempts = diplomaciesTo50(here?.chaos ?? 0, charisma);
    const estimateMs = attempts * BLADEBURNER_CHAOS_ACTION_SECONDS * 1000;
    // A move wanted with a chaos action under way waits for the run #385's rule keeps (the city held with it): its
    // remaining game seconds at the reading that first wants the move, by the rule's own clock.
    const keptMs = kind === "move" ? this.#keptRunLeftMs(kept) : 0;
    const why =
      kind === "move"
        ? `a move to ${choice?.city}, wanted at ${formatIsoTime(kept.atMs)}, within two readings and an Agent round` +
          (keptMs > 0
            ? ` after the ${this.#chaosSince?.name} run under way, kept to its end (#385): ${formatDuration(keptMs)} ` +
              `of its 60 s left then`
            : "")
        : `the rule's Diplomacy estimate ${attempts} × 60 s = ${formatDuration(estimateMs)}`;
    this.#leftOpen = {
      kind,
      fromMs: kept.atMs,
      toMs: kept.atMs,
      boundMs: kind === "move" ? BLADEBURNER_MOVE_WITHIN_MS + keptMs : 2 * estimateMs + BLADEBURNER_CHAOS_SLACK_MS,
      detail:
        `${kept.city}'s chaos ${(here?.chaos ?? 0).toFixed(2)} at its start, ${why}; the rule's choice: ` +
        (choice === null ? "none" : describeCityChoice(choice, kept.city)),
    };
  }

  /**
   * The kept run's game seconds left at `kept` (#420's ruling 3), in ms: a chaos action's runs are 60 game seconds
   * from its first reading under way, the bonus time spent since counted (the rule's `#chaosRunOf`), so 60 less the
   * run's elapsed; 0 with none under way, or a run the rule doesn't keep (#422's review: then it moves at once). Taken
   * as real time: bonus time only shortens it, so the bound errs long.
   */
  #keptRunLeftMs(kept: Kept): number {
    const since = this.#chaosSince;
    if (since === null || !this.#keptNow) return 0;
    const run = BLADEBURNER_CHAOS_ACTION_SECONDS;
    return (run - (((this.#gameSecondsOf(since, kept) % run) + run) % run)) * 1000;
  }

  /** The game seconds since the chaos action's first reading under way: the real time and the bonus time spent. */
  #gameSecondsOf(since: { atMs: number; bonusSeconds: number }, kept: Kept): number {
    return (kept.atMs - since.atMs) / 1000 + since.bonusSeconds - kept.reading.bonusSeconds;
  }

  /** Which 60 game seconds' run of the chaos action under way `kept` falls in, 0 the first (the rule's `#chaosRunOf`). */
  #runOf(since: { atMs: number; bonusSeconds: number }, kept: Kept): number {
    return Math.floor(this.#gameSecondsOf(since, kept) / BLADEBURNER_CHAOS_ACTION_SECONDS);
  }

  /** The cities' lines, its failures added to `failures`; one line without a reading with them. */
  section(failures: string[]): string[] {
    const first = this.#first;
    const last = this.#last;
    if (first === null || last === null) {
      return ["  the cities and the chaos (#383): no reading with them (an older Agent's)"];
    }
    const lines = [
      `  the cities and the chaos (#383): ${this.#readings} readings from ${formatIsoTime(first.atMs)} to ` +
        `${formatIsoTime(last.atMs)}; at the last, the division in ${last.city}; ${this.#switches} ` +
        `switch${this.#switches === 1 ? "" : "es"} of city`,
    ];
    const byCity = [...this.#byCity].sort((a, b) => b[1] - a[1]);
    lines.push(
      `    time by city: ${byCity.length === 0 ? "none between readings" : byCity.map(([name, ms]) => `${name} ${formatDuration(ms)}`).join(", ")}`,
    );
    lines.push(
      "    each city at the last reading (chaos, population estimate, communities): " +
        (last.reading.cities ?? [])
          .map((each) => `${each.name} ${each.chaos.toFixed(2)}, ${millions(each.population)}, ${each.communities}`)
          .join("; "),
    );
    lines.push(
      "    the counts at the last reading: " +
        BLADEBURNER_LEVELLED_ACTIONS.map(({ type, name }) => {
          const read = last.reading.actions.find((each) => each.type === type && each.name === name);
          return `${name} ${read === undefined ? "unread" : read.count.toFixed(1)}`;
        }).join(", "),
    );
    const timeIn = (name: string) => this.#chaosActionMs.get(name) ?? 0;
    lines.push(
      `    ${DIPLOMACY} under way ${formatDuration(timeIn(DIPLOMACY))}, ${INCITE_VIOLENCE} ` +
        `${formatDuration(timeIn(INCITE_VIOLENCE))} (60 s a run; bonus time runs them up to 5 times as fast)`,
    );
    const lastChoice = last.choice();
    lines.push(
      `    the rule's choice at the last reading: ${lastChoice === null ? "none (no round measuring the cities, the city read not among the six, or its estimate 0)" : describeCityChoice(lastChoice, last.city)}`,
    );
    // The rounds (#420): each city's measure over the window, the last reading's in full, and each stretch without one.
    lines.push(
      `  the round over the six cities (#420): ${this.#rounds} of ${this.#readings} readings measured each city` +
        (this.#rounds === 0
          ? ""
          : `; by city: ${[...this.#measured]
              .map(
                ([name, seen]) =>
                  `${name} recovered ${seen.recovered}` +
                  (seen.recovered > 0
                    ? ` (pop/popEst ${seen.low.toFixed(3)} to ${seen.high.toFixed(3)}; by the Black Op's range ` +
                      `${seen.blackOp}, by an action's ${seen.recovered - seen.blackOp}; its branch by the ` +
                      `estimate's pick ${seen.estimate}` +
                      (seen.estimate > 0 ? `, at most ${(100 * seen.gap).toFixed(2)}% off if wrong` : "") +
                      ")"
                    : "") +
                  `, at the draw's mean (every range clipped) ${seen.draw}`,
              )
              .join("; ")}`),
    );
    if (this.#lastMeasures !== null) lines.push(`    at the last: ${describeCityMeasures(this.#lastMeasures)}`);
    lines.push(
      "  the readings without the round's measure (failed, missing, the division not back in its city, or a city's " +
        "ranges disagreeing):",
    );
    const unmeasured = [...this.#roundFailed, ...(this.#roundOpen === null ? [] : [this.#roundOpen])];
    if (unmeasured.length === 0) lines.push("    none");
    for (const each of unmeasured) {
      const line =
        `Bladeburner's round over the cities failed from ${formatIsoTime(each.fromMs)} to ${formatIsoTime(each.toMs)} ` +
        `(${each.detail})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    lines.push(
      "  the chaos over 50 where the division works, the rule's measure wanting it off, past twice its Diplomacy " +
        `estimate and 10 min, or a move's ${formatDuration(BLADEBURNER_MOVE_WITHIN_MS)}:`,
    );
    const long = [...this.#left, ...(this.#leftOpen === null ? [] : [this.#leftOpen])].filter(
      (each) => each.toMs - each.fromMs > each.boundMs,
    );
    if (long.length === 0) lines.push("    none");
    for (const each of long) {
      const line =
        `the chaos over 50 where the division works, the rule's measure wanting it off, from ` +
        `${formatIsoTime(each.fromMs)} to ${formatIsoTime(each.toMs)}, for ${formatDuration(each.toMs - each.fromMs)}, ` +
        `past its bound ${formatDuration(each.boundMs)} (${each.detail})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    return lines;
  }
}
