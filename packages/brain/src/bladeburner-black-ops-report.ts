// The run report's Black Ops (#392, B5 of #359), part of section 8: from the medium snapshots' readings in the
// division with the next Black Op (every 10 s), the ones done in the window and when, and at the last reading the
// next, its rank, its chance and the ETA. Paths are `vendor/bitburner-src/src/`'s.
// - **Done:** the next read moving on (the n-th's count 0 once done, `NetscriptFunctions/Bladeburner.ts:182-183`).
// - **The ETA** at the last reading: under its rank, #386's least expected time to it (core's `chooseBladeburnerAction`
//   under the target), then the expected time to it done there (core's `checkBladeburnerBlackOp`: attempts at the
//   chance read, each failure's loss rebuilt); at it, the latter.
// - **Due and not run** (decision 45): core's check running it (its rank met, the look-ahead not waiting), the next not
//   under way, and a contract or operation under way instead, for longer than `BLADEBURNER_BLACK_OP_WITHIN_MS`: a
//   failure. Only work under way is judged: a rest is the stamina's (the rule rests from under ½ max to the max, and
//   runs a Black Op only rested, so its chance has no penalty), a chaos action may be kept to its 60 s's end, and idle
//   is the owner's work or the Black Op just ended (the game stops it either way, `Bladeburner.ts:1083`). A gap in the
//   readings or an install ends the stretch, as the other checks'.
// - **The cost** (#390's review): the check is solved only at the readings where it can run (the rank met, work under
//   way), and the ETA once, at the last: a target's solve is hundreds of milliseconds at a Black Op's (B5's grid).
import {
  BLADEBURNER_BLACK_OPS,
  type BladeburnerBlackOpCheck,
  type BladeburnerForecastInput,
  bladeburnerBlackOp,
  bladeburnerPersonOf,
  bladeburnerRankMultiplierOf,
  bladeburnerSkillCostMultiplierOf,
  checkBladeburnerBlackOp,
  chooseBladeburnerAction,
  type MediumSnapshotData,
} from "@bitburner-agent/core";
import { type BladeburnerActionsReading, bladeburnerSpeedOf, describeBlackOpCheck } from "./bladeburner.ts";
import { BLADEBURNER_GAP_MS } from "./bladeburner-actions-report.ts";
import { BLADEBURNER_MOVE_WITHIN_MS } from "./bladeburner-cities-report.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";

/**
 * How long a Black Op may be due with work under way instead (#392): 22 s, a move's (core's reading cadence). The brain
 * sends it at the reading that shows it due; the state's change makes the Agent's Bladeburner run due at once, its next
 * round (2 s), whose worker starts it; the medium snapshot after carries that within a reading (10 s); and one reading
 * more for a run the round's deadline put off.
 */
export const BLADEBURNER_BLACK_OP_WITHIN_MS = BLADEBURNER_MOVE_WITHIN_MS;

/** A reading the fold keeps: its time, rank, B2–B5 figures, the forecast's input, the skills, the faction. */
interface Kept {
  atMs: number;
  rank: number;
  reading: BladeburnerActionsReading;
  input: BladeburnerForecastInput & { skills: { read: Record<string, number> } };
  costMultiplier: number;
  lastAugReset: number | null;
}

/** A stretch a Black Op was due with work under way instead: from, to, and why. */
interface Due {
  fromMs: number;
  toMs: number;
  detail: string;
}

/** The Black Ops over a window, folded from the medium snapshots in the division with the next read, in order. */
export class BladeburnerBlackOpsFold {
  #first: Kept | null = null;
  #last: Kept | null = null;
  readonly #done: { name: string; atMs: number }[] = [];
  readonly #due: Due[] = [];
  #dueOpen: Due | null = null;

  /** A medium snapshot in the division with B5's reading (its `blackOp`), in BN6 or BN7 (`bitNode`). */
  add(
    atMs: number,
    data: MediumSnapshotData,
    rank: number,
    reading: BladeburnerActionsReading,
    bitNode: number,
    lastAugReset: number | null = null,
  ): void {
    if (reading.blackOp === undefined) return;
    const person = bladeburnerPersonOf(data.player);
    const rankMultiplier = bladeburnerRankMultiplierOf(bitNode);
    const costMultiplier = bladeburnerSkillCostMultiplierOf(bitNode);
    if (person === null || rankMultiplier === null || costMultiplier === null) return;
    const kept: Kept = {
      atMs,
      rank,
      reading,
      input: {
        readings: reading.actions,
        person,
        stamina: reading.stamina,
        maxStamina: reading.maxStamina,
        rankMultiplier,
        speed: bladeburnerSpeedOf(reading.bonusSeconds),
        skills: { read: reading.skills?.levels ?? {} },
      },
      costMultiplier,
      lastAugReset,
    };
    if (this.#first === null) this.#first = kept;
    const previous = this.#last;
    this.#last = kept;
    const broken =
      previous === null || atMs - previous.atMs > BLADEBURNER_GAP_MS || previous.lastAugReset !== lastAugReset;
    // Done: the next moved on (an install keeps them, `Prestige.ts:155-158`).
    const was = previous?.reading.blackOp;
    if (was != null && was.name !== reading.blackOp?.name) this.#done.push({ name: was.name, atMs });
    this.#watchDue(kept, broken);
  }

  /** Core's check on the next Black Op at `kept`; null with all done. */
  #check(kept: Kept, forecastUnmet = false): BladeburnerBlackOpCheck | null {
    const next = kept.reading.blackOp;
    const op = next == null ? null : bladeburnerBlackOp(next.name);
    if (op === null || next == null) return null;
    const skills = kept.reading.skills;
    return checkBladeburnerBlackOp(kept.input, {
      op,
      rank: kept.rank,
      chance: next.chance,
      skills:
        skills === null ? null : { levels: skills.levels, points: skills.points, costMultiplier: kept.costMultiplier },
      forecastUnmet,
    });
  }

  /** Due and not run: the check running it, the next not under way, a contract or operation under way instead. */
  #watchDue(kept: Kept, broken: boolean): void {
    const next = kept.reading.blackOp;
    const current = kept.reading.current;
    const working = current?.type === "Contracts" || current?.type === "Operations";
    const op = next == null ? null : bladeburnerBlackOp(next.name);
    // Solved only where it can run: the rank met and work under way.
    const check = op !== null && working && kept.rank >= op.rank ? this.#check(kept) : null;
    const due = check?.run === true;
    if (!due || broken) {
      if (this.#dueOpen !== null) this.#due.push(this.#dueOpen);
      this.#dueOpen = null;
      if (!due) return;
    }
    if (this.#dueOpen !== null) {
      this.#dueOpen.toMs = kept.atMs;
      return;
    }
    this.#dueOpen = {
      fromMs: kept.atMs,
      toMs: kept.atMs,
      detail: `rank ${kept.rank.toFixed(1)}, ${current?.name} under way; ${describeBlackOpCheck(check as BladeburnerBlackOpCheck)}`,
    };
  }

  /** The Black Ops' lines, its failures added to `failures`; one line without a reading with them. */
  section(failures: string[]): string[] {
    const first = this.#first;
    const last = this.#last;
    if (first === null || last === null) return ["  the Black Ops (#392): no reading with them (an older Agent's)"];
    const before = first.reading.blackOp;
    const doneBefore =
      before == null
        ? BLADEBURNER_BLACK_OPS.length
        : Math.max(
            0,
            BLADEBURNER_BLACK_OPS.findIndex((op) => op.name === before.name),
          );
    const lines = [
      `  the Black Ops (#392): ${doneBefore} done before the window; in it, ` +
        (this.#done.length === 0
          ? "none"
          : this.#done.map((each) => `${each.name} ${formatIsoTime(each.atMs)}`).join(", ")),
    ];
    const check = this.#check(last, true);
    if (check === null) lines.push("    all 21 done at the last reading");
    else {
      // Under its rank, #386's least expected time to it first.
      const toRank = check.met
        ? 0
        : (chooseBladeburnerAction({ ...last.input, target: { rank: last.rank, target: check.rank } }).toTarget
            ?.seconds ?? Number.POSITIVE_INFINITY);
      const eta = toRank + check.expected;
      lines.push(
        `    at the last reading, ${formatIsoTime(last.atMs)} (rank ${last.rank.toFixed(1)}): ${describeBlackOpCheck(check)}`,
        `    the ETA to ${check.name} done: ` +
          (Number.isFinite(eta)
            ? `about ${formatDuration(eta * 1000)} (` +
              (check.met
                ? "attempting from its rank met"
                : `rank ${check.rank.toLocaleString("en-US")} in about ${formatDuration(toRank * 1000)} expected, then ` +
                  `about ${formatDuration(check.expected * 1000)} to it done`) +
              ")"
            : "never at the figures read"),
      );
    }
    lines.push(
      `  a Black Op due (its rank met, the check running it) with work under way instead, past ` +
        `${formatDuration(BLADEBURNER_BLACK_OP_WITHIN_MS)}:`,
    );
    const long = [...this.#due, ...(this.#dueOpen === null ? [] : [this.#dueOpen])].filter(
      (each) => each.toMs - each.fromMs > BLADEBURNER_BLACK_OP_WITHIN_MS,
    );
    if (long.length === 0) lines.push("    none");
    for (const each of long) {
      const line =
        `a Black Op due with work under way instead from ${formatIsoTime(each.fromMs)} to ${formatIsoTime(each.toMs)}, ` +
        `for ${formatDuration(each.toMs - each.fromMs)} (${each.detail})`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    return lines;
  }
}
