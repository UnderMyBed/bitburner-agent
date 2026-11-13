// The run report's Bladeburner section (#367, B1 of #359): in BN6 and BN7, the training to join (its first estimate,
// core's `planCombatTraining` on the medium snapshot it was made at, against the time it took), the division joined,
// the rank, and the Bladeburners faction, from the medium snapshots (the player, `inBladeburner`, and the Agent's
// Bladeburner worker's reading every 10 s). What can stall fails the report, each after a time computed from the game
// or the brain's own pace:
// - the training still short of 100 past twice the slowest gym's estimate and `BLADEBURNER_TRAINING_SLACK_MS` from its
//   first sighting (#367's review: core's `slowestTrainingSeconds`, Iron Gym's 1 a second at the player's experience
//   multipliers then, as #343's waits are bounded, augmentations.ts's `INSTALL_WAIT_OVERDUE_SLACK_MS`). So a training
//   that never starts (no gym the money covers, or a city with none and no travel) fails too. The clock stops while the
//   owner's work holds the training (the rule's `bladeburnerTrainingHeld` events). An install restarts it (the combat
//   experience goes, `PlayerObjectGeneralMethods.ts:86-97`), so each cycle's training is its own;
// - all four at 100 with the division not joined, for over `BLADEBURNER_JOIN_WITHIN_MS`;
// - the division joined, home's RAM holding the worker beyond what it keeps, and no reading, for over
//   `BLADEBURNER_UNREAD_WITHIN_MS`;
// - the rank at 25 or more with the faction not joined, for over `BLADEBURNER_FACTION_WITHIN_MS`.
// Then, in the division, the actions (#375, B2): ./bladeburner-actions-report.ts, with their two failures (an action
// stopped at stamina 0; the rank from the actions run below its forecast's bound); and the cities and the chaos (#383,
// B4): ./bladeburner-cities-report.ts, with its failure (the chaos left over 50 where the division works, the rule's
// measure wanting it off, past twice its Diplomacy estimate and 10 min); and the Black Ops (#392, B5):
// ./bladeburner-black-ops-report.ts, with its failure (one due, its rank and the check met, with work under way instead
// past 22 s).
import {
  BLADEBURNER_BITNODES,
  BLADEBURNER_FACTION,
  BLADEBURNER_FACTION_RANK,
  bladeburnerWorkerFits,
  type ClassChoice,
  COMBAT_STATS,
  type CombatPerson,
  combatPersonOf,
  combatTrained,
  type MediumSnapshotData,
  memoizedBladeburnerChoice,
  planCombatTraining,
  type SlowSnapshotData,
  slowestTrainingSeconds,
} from "@bitburner-agent/core";
import {
  BLADEBURNER_REBUILD_EVENT_KIND,
  BLADEBURNER_TRAINING_HELD_EVENT_KIND,
  bladeburnerSnapshotOf,
  describeRebuildBound,
  homeMaxRamOf,
} from "./bladeburner.ts";
import { BladeburnerActionsFold } from "./bladeburner-actions-report.ts";
import { BladeburnerBlackOpsFold } from "./bladeburner-black-ops-report.ts";
import { BladeburnerCitiesFold } from "./bladeburner-cities-report.ts";
import { bitNodeOfSlow } from "./gang.ts";
import { formatDuration, formatIsoTime } from "./gap-report.ts";
import { homeKeptGbOf, singularityRamMultiplierOf } from "./share.ts";

/** The overdue training's slack beyond twice its estimate: 10 minutes, as #343's waits (`INSTALL_WAIT_OVERDUE_SLACK_MS`). */
export const BLADEBURNER_TRAINING_SLACK_MS = 10 * 60_000;
/**
 * How long all four may be at 100 with the division not joined: 5 minutes. The gate holds the intent for 2 medium
 * snapshots (20 s) and a save backup, then the Agent tries it every 30 s (`INTENT_RETRY_ROUNDS`): 9 tries' time, as
 * the gang's forming (gang-report.ts's `GANG_FORM_WITHIN_MS`).
 */
export const BLADEBURNER_JOIN_WITHIN_MS = 5 * 60_000;
/** How long the division may go unread with home's RAM there for its worker: 5 minutes, 30 of its runs. */
export const BLADEBURNER_UNREAD_WITHIN_MS = 5 * 60_000;
/**
 * How long the rank may be at 25 with the faction not joined: 1 minute. The brain asks on the next medium snapshot
 * (10 s), the worker joins within 10 s, and the next medium snapshot shows it: under 30 s, twice over.
 */
export const BLADEBURNER_FACTION_WITHIN_MS = 60_000;

/** A stretch a condition held, from its first medium snapshot to its last (or the window's end). */
interface Stretch {
  fromMs: number;
  toMs: number;
  detail: string;
}

/** A condition's stretches, and the one open now (gang-report.ts's). */
class Stretches {
  readonly closed: Stretch[] = [];
  #open: Stretch | null = null;

  add(atMs: number, detail: string | null): void {
    if (detail === null) {
      if (this.#open !== null) this.closed.push(this.#open);
      this.#open = null;
      return;
    }
    if (this.#open === null) this.#open = { fromMs: atMs, toMs: atMs, detail };
    else this.#open.toMs = atMs;
  }

  all(endMs: number): Stretch[] {
    return this.#open === null ? this.closed : [...this.closed, { ...this.#open, toMs: endMs }];
  }
}

/** A cycle's training: its start, its first estimate and where it was made, and its end (all four at 100), if seen. */
interface Training {
  fromMs: number;
  lastAugReset: number | null;
  fromLevels: string;
  estimate: { atMs: number; seconds: number; gym: string } | null;
  /** The overdue bound from its first sighting: twice the slowest gym's estimate then, and the slack. */
  boundMs: number;
  doneAtMs: number | null;
  lastAtMs: number;
  lastLevels: string;
}

const levelsOf = (person: CombatPerson) =>
  COMBAT_STATS.map((stat) => `${stat} ${Math.floor(person.skills[stat])}`).join(", ");

/** Bladeburner over a window, folded from the slow and medium snapshots in order of arrival. */
export class BladeburnerFold {
  /** When the training was held for the owner's work, and let go: the rule's events, in order. */
  readonly #holds: { atMs: number; held: boolean }[];

  /** The rebuilds after an install (#404), from the rule's `bladeburnerRebuild` events: each start, and its end. */
  readonly #rebuilds: {
    fromMs: number;
    toMs: number | null;
    targets: string;
    seconds: number | null;
    /** Past its bound at its first sighting (#407's review): not run, a failure; its bound and price then. */
    skipped: { boundSeconds: number; pricedSeconds: number | null } | null;
  }[] = [];

  /**
   * `events`: the window's, for the rule's `bladeburnerTrainingHeld` (its overdue clock stops while held) and (#404)
   * `bladeburnerRebuild` (Training then is the rebuild, not B2's stuck resting).
   */
  constructor(events: readonly { kind: string; atMs: number; detail: unknown }[] = []) {
    this.#holds = events
      .filter((event) => event.kind === BLADEBURNER_TRAINING_HELD_EVENT_KIND)
      .map((event) => ({ atMs: event.atMs, held: (event.detail as { held?: unknown } | null)?.held === true }))
      .sort((a, b) => a.atMs - b.atMs);
    const rebuilds = events
      .filter((event) => event.kind === BLADEBURNER_REBUILD_EVENT_KIND)
      .sort((a, b) => a.atMs - b.atMs);
    for (const { atMs, detail } of rebuilds) {
      const fields = (detail ?? {}) as {
        started?: unknown;
        targets?: unknown;
        seconds?: unknown;
        skipped?: unknown;
        boundSeconds?: unknown;
        pricedSeconds?: unknown;
      };
      const finite = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const open = this.#rebuilds.at(-1);
      if (fields.started === true) {
        const targets = (fields.targets ?? {}) as Record<string, unknown>;
        this.#rebuilds.push({
          fromMs: atMs,
          toMs: null,
          targets: COMBAT_STATS.map((stat) => `${stat} ${String(targets[stat] ?? "?")}`).join(", "),
          seconds: finite(fields.seconds),
          skipped:
            fields.skipped === true
              ? { boundSeconds: finite(fields.boundSeconds) ?? 0, pricedSeconds: finite(fields.pricedSeconds) }
              : null,
        });
      } else if (open !== undefined && open.toMs === null) {
        open.toMs = atMs;
      }
    }
    this.#actions = new BladeburnerActionsFold((atMs) => this.#rebuildingAt(atMs));
  }

  /** Whether a rebuild was under way at `atMs` (#404): started by then, not ended before. */
  #rebuildingAt(atMs: number): boolean {
    return this.#rebuilds.some(
      (each) => each.skipped === null && each.fromMs <= atMs && (each.toMs === null || atMs <= each.toMs),
    );
  }

  /** The time from `fromMs` to `toMs` the training was held for the owner's work. */
  #heldMsBetween(fromMs: number, toMs: number): number {
    let total = 0;
    let since: number | null = null;
    for (const { atMs, held } of this.#holds) {
      if (atMs > toMs) break;
      if (held && since === null) since = Math.max(atMs, fromMs);
      if (!held && since !== null) {
        total += Math.max(0, Math.min(atMs, toMs) - since);
        since = null;
      }
    }
    return since === null ? total : total + Math.max(0, toMs - since);
  }

  readonly #slows: { atMs: number; bitNode: number; homeKeptGb: number; lastAugReset: number | null }[] = [];
  #mediumInBitNode = 0;
  #lastAtMs: number | null = null;
  readonly #trainings: Training[] = [];
  /** The class the report's plan last chose, as the brain keeps it (`chooseGym`'s `kept`). */
  #class: ClassChoice | null = null;
  #joined: { atMs: number; before: boolean } | null = null;
  #sawNotJoined = false;
  #ranks: { atMs: number; rank: number }[] = [];
  #faction: { atMs: number; before: boolean } | null = null;
  #sawNoFaction = false;
  readonly #problems = new Map<string, number>();
  readonly #overdue = new Stretches();
  readonly #notJoined = new Stretches();
  readonly #unread = new Stretches();
  readonly #factionWaiting = new Stretches();
  /** The actions (#375), from the readings in the division. */
  readonly #actions: BladeburnerActionsFold;
  /** The cities and the chaos (#383), from the readings in the division with them. */
  readonly #cities = new BladeburnerCitiesFold();
  /** The Black Ops (#392), from the readings in the division with the next. */
  readonly #blackOps = new BladeburnerBlackOpsFold();
  #sawDivision = false;

  /** A slow snapshot: the BitNode, home's reserve (with its Singularity worker) and the cycle from then on. */
  addSlow(atMs: number, data: SlowSnapshotData): void {
    const bitNode = bitNodeOfSlow(data);
    if (bitNode === null) return;
    const reset = data.resetInfo?.lastAugReset;
    this.#slows.push({
      atMs,
      bitNode,
      homeKeptGb: homeKeptGbOf(singularityRamMultiplierOf(data)),
      lastAugReset: typeof reset === "number" && Number.isFinite(reset) ? reset : null,
    });
  }

  /** The slow snapshot's figures at `atMs`: the last by then, or the first after, with none before. */
  #slowAt(atMs: number) {
    let found = this.#slows[0] ?? null;
    for (const slow of this.#slows) {
      if (slow.atMs > atMs) break;
      found = slow;
    }
    return found;
  }

  /** A medium snapshot (a whole one). */
  addMedium(atMs: number, data: MediumSnapshotData): void {
    const slow = this.#slowAt(atMs);
    if (slow === null || !BLADEBURNER_BITNODES.includes(slow.bitNode)) {
      for (const stretches of [this.#overdue, this.#notJoined, this.#unread, this.#factionWaiting]) {
        stretches.add(atMs, null);
      }
      this.#class = null;
      return;
    }
    this.#mediumInBitNode += 1;
    this.#lastAtMs = atMs;
    const snapshot = bladeburnerSnapshotOf(data);
    const person = combatPersonOf(data.player);
    const money = data.player?.money;
    const city = data.player?.city;
    const inDivision = snapshot.joined === true;
    if (snapshot.joined === false) this.#sawNotJoined = true;
    if (inDivision && this.#joined === null) this.#joined = { atMs, before: !this.#sawNotJoined };
    // The training: short of 100, not in the division. A cycle's own (an install restarts it).
    const training = !inDivision && person !== null && !combatTrained(person);
    let current = this.#trainings.at(-1);
    if (training && person !== null) {
      if (current === undefined || current.doneAtMs !== null || current.lastAugReset !== slow.lastAugReset) {
        current = {
          fromMs: atMs,
          lastAugReset: slow.lastAugReset,
          fromLevels: levelsOf(person),
          estimate: null,
          // To the millisecond, as the snapshots' times are: the bound's edge is then reachable, and judged.
          boundMs: Math.ceil(2 * slowestTrainingSeconds(person) * 1000) + BLADEBURNER_TRAINING_SLACK_MS,
          doneAtMs: null,
          lastAtMs: atMs,
          lastLevels: levelsOf(person),
        };
        this.#trainings.push(current);
        this.#class = null;
      }
      current.lastAtMs = atMs;
      current.lastLevels = levelsOf(person);
      if (typeof money === "number" && typeof city === "string") {
        const plan = planCombatTraining(person, { money, city, kept: this.#class });
        this.#class = plan.work ?? this.#class;
        if (current.estimate === null && plan.etaSeconds !== null && plan.gym !== null) {
          current.estimate = { atMs, seconds: plan.etaSeconds, gym: plan.gym };
        }
      }
    } else if (current !== undefined && current.doneAtMs === null && person !== null) {
      current.doneAtMs = atMs;
      current.lastLevels = levelsOf(person);
    }
    const open = training ? current : undefined;
    this.#overdue.add(
      atMs,
      open !== undefined && atMs - open.fromMs - this.#heldMsBetween(open.fromMs, atMs) > open.boundMs
        ? `first seen ${formatIsoTime(open.fromMs)}, its bound ${formatDuration(open.boundMs)}; ${open.lastLevels}`
        : null,
    );
    this.#notJoined.add(
      atMs,
      snapshot.joined === false && person !== null && combatTrained(person)
        ? `${levelsOf(person)}, not in the division`
        : null,
    );
    const homeMaxRamGb = homeMaxRamOf(data);
    const fits = homeMaxRamGb !== null && bladeburnerWorkerFits({ homeMaxRamGb, homeKeptGb: slow.homeKeptGb });
    const { reading } = snapshot;
    this.#unread.add(
      atMs,
      inDivision && fits && reading.kind !== "read"
        ? reading.kind === "unread"
          ? reading.problem
          : "no Bladeburner reading in the medium snapshot"
        : null,
    );
    const factions = (data.player as { factions?: unknown } | undefined)?.factions;
    const inFaction = Array.isArray(factions) && factions.includes(BLADEBURNER_FACTION);
    if (!inFaction) this.#sawNoFaction = true;
    if (inFaction && this.#faction === null) this.#faction = { atMs, before: !this.#sawNoFaction };
    const rank = reading.kind === "read" ? reading.rank : null;
    if (rank !== null) this.#ranks.push({ atMs, rank });
    if (inDivision) this.#sawDivision = true;
    if (inDivision && rank !== null && reading.kind === "read" && reading.actions !== null) {
      // Each plan solved once a reading, for the folds that weigh it (#392, #390's review: a far target's solve is
      // hundreds of milliseconds).
      const choose = memoizedBladeburnerChoice();
      this.#actions.add(atMs, data, rank, reading.actions, slow.bitNode, slow.lastAugReset, choose);
      this.#cities.add(atMs, data, reading.actions, slow.bitNode, slow.lastAugReset, rank, choose);
      this.#blackOps.add(atMs, data, rank, reading.actions, slow.bitNode, slow.lastAugReset);
    }
    if (reading.kind === "read") {
      for (const problem of reading.problems) if (!this.#problems.has(problem)) this.#problems.set(problem, atMs);
    }
    this.#factionWaiting.add(
      atMs,
      rank !== null && rank >= BLADEBURNER_FACTION_RANK && !inFaction
        ? `rank ${rank.toFixed(1)}, ${BLADEBURNER_FACTION} not joined`
        : null,
    );
  }

  /** The section's lines, its failures added to `failures`. */
  section(failures: string[], windowEndMs: number): string[] {
    const lines = [
      "8. Bladeburner (#367, #375, #383, #392: the training to join, the division, the faction, the actions, the cities " +
        "and the Black Ops; played in BN6 and BN7 only)",
    ];
    if (this.#mediumInBitNode === 0) {
      lines.push("  not in BN6 or BN7 in the window: no Bladeburner played");
      return lines;
    }
    const endMs = this.#lastAtMs ?? windowEndMs;
    lines.push("  the training to join (all four combat stats at 100), each cycle's:");
    if (this.#trainings.length === 0) lines.push("    none in the window");
    for (const each of this.#trainings) {
      const estimate =
        each.estimate === null
          ? "no gym's estimate (none the money covered)"
          : `estimated ${formatDuration(each.estimate.seconds * 1000)} at ${each.estimate.gym} from ` +
            `${formatIsoTime(each.estimate.atMs)}`;
      const end =
        each.doneAtMs === null
          ? `still short at its last reading, ${formatIsoTime(each.lastAtMs)}: ${each.lastLevels}`
          : `done ${formatIsoTime(each.doneAtMs)}, after ${formatDuration(each.doneAtMs - each.fromMs)}` +
            (each.estimate === null
              ? ""
              : ` (${((each.doneAtMs - each.estimate.atMs) / (each.estimate.seconds * 1000)).toFixed(2)} of the ` +
                "estimate from when it was made)");
      lines.push(
        `    from ${formatIsoTime(each.fromMs)} (${each.fromLevels}): ${estimate}; overdue past ` +
          `${formatDuration(each.boundMs)}; ${end}`,
      );
    }
    // The rebuilds after an install (#404): shown; overdue is the World Daemon's stall (section 4), failed there; one past
    // its bound at its first sighting (#407's review), not run, a failure here.
    if (this.#rebuilds.length > 0) {
      lines.push("  the rebuilds after an install (#404), Training back to the combat levels before it:");
      for (const each of this.#rebuilds) {
        const estimate = each.seconds === null ? "no estimate" : `estimated ${formatDuration(each.seconds * 1000)}`;
        const end =
          each.toMs === null
            ? "under way at the window's end"
            : `done ${formatIsoTime(each.toMs)}, after ${formatDuration(each.toMs - each.fromMs)}` +
              (each.seconds === null || !(each.seconds > 0)
                ? ""
                : ` (${((each.toMs - each.fromMs) / (each.seconds * 1000)).toFixed(2)} of the estimate)`);
        if (each.skipped !== null && each.seconds !== null) {
          const line =
            `the rebuild after an install (#404) from ${formatIsoTime(each.fromMs)} to ${each.targets} not run: ` +
            describeRebuildBound({ firstSeconds: each.seconds, ...each.skipped });
          lines.push(`    ${line}`);
          failures.push(line);
          continue;
        }
        lines.push(`    from ${formatIsoTime(each.fromMs)} to ${each.targets}: ${estimate}; ${end}`);
      }
    }
    lines.push(
      this.#joined === null
        ? "  the division: not joined"
        : this.#joined.before
          ? "  the division: joined before the window"
          : `  the division: joined, first seen ${formatIsoTime(this.#joined.atMs)}`,
    );
    const first = this.#ranks[0];
    const last = this.#ranks.at(-1);
    lines.push(
      first === undefined || last === undefined
        ? "  rank: not read (the worker runs once home's RAM beyond what it keeps holds it)"
        : `  rank: ${first.rank.toFixed(1)} → ${last.rank.toFixed(1)}, read from ${formatIsoTime(first.atMs)}`,
    );
    lines.push(
      this.#faction === null
        ? `  ${BLADEBURNER_FACTION}: not joined (it comes at rank ${BLADEBURNER_FACTION_RANK})`
        : this.#faction.before
          ? `  ${BLADEBURNER_FACTION}: joined before the window`
          : `  ${BLADEBURNER_FACTION}: joined, first seen ${formatIsoTime(this.#faction.atMs)}`,
    );
    lines.push("  problems the Bladeburner worker reported, as first seen:");
    if (this.#problems.size === 0) lines.push("    none");
    for (const [problem, atMs] of this.#problems) lines.push(`    ${formatIsoTime(atMs)}: ${problem}`);
    // The overdue training fails at once: its stretch is already past its bound.
    const judged: [readonly Stretch[], number, string][] = [
      [
        this.#overdue.all(endMs),
        0,
        "the training past twice the slowest gym's estimate and 10 min from its first sighting, still short of 100,",
      ],
      [this.#notJoined.all(endMs), BLADEBURNER_JOIN_WITHIN_MS, "all four at 100 with the division not joined"],
      [
        this.#unread.all(endMs),
        BLADEBURNER_UNREAD_WITHIN_MS,
        "the division unread with home's RAM there for its worker",
      ],
      [
        this.#factionWaiting.all(endMs),
        BLADEBURNER_FACTION_WITHIN_MS,
        `the rank at ${BLADEBURNER_FACTION_RANK} or more with ${BLADEBURNER_FACTION} not joined`,
      ],
    ];
    for (const [stretches, withinMs, what] of judged) {
      lines.push(withinMs === 0 ? `  ${what} at any reading:` : `  ${what} for ${formatDuration(withinMs)} or more:`);
      const long = stretches.filter((each) => each.toMs - each.fromMs >= withinMs);
      if (long.length === 0) lines.push("    none");
      for (const { fromMs, toMs, detail } of long) {
        const line =
          `${what} from ${formatIsoTime(fromMs)} to ${formatIsoTime(toMs)}` +
          (withinMs === 0 ? "" : `, for ${formatDuration(toMs - fromMs)}`) +
          ` (${detail})`;
        lines.push(`    ${line}`);
        failures.push(line);
      }
    }
    if (this.#sawDivision) {
      lines.push(
        ...this.#actions.section(failures),
        ...this.#cities.section(failures),
        ...this.#blackOps.section(failures),
      );
    }
    return lines;
  }
}
