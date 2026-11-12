// The World Daemon in the run report (#215): the path as the window's last snapshots show it (Daedalus, The Red Pill,
// w0r1d_d43m0n's hacking requirement and the ETA at the window's experience rate), the destroys sent, and each stall
// the rule stored, a failure; an install while short of Daedalus's count that added none with nothing that counts
// passed over (#238), information. Each destroy names the BitNode it enters and the ones the order skipped (#323), and
// a replay with nothing playable left in the campaign's order to gain says it is one (#311, #321).
// Old stores only (#311): before it, the brain refused the destroy at the cap with a `nextBitNode` stall, and its stop
// at the BitNode's end could fire for "nothing more to gain". It emits neither now, but the store is kept for good and
// the reports read old windows, so those are still read as #308 did: the `nextBitNode` stall a stop for nothing more to
// gain followed in its BitNode (#303, #308) is expected: the owner's switch asked for that end. One no stop followed
// (the switch off, or the stop didn't fire) is the owner's prompt (#308): a warning once w0r1d_d43m0n has been ready
// (rooted at its level) 5 minutes, unbroken to its BitNode's last medium snapshot, else a line.
// The levelling choice (#336, ./levelling.ts): once the hacking level is all that's left, the candidates' estimates
// from the window's last snapshots (core's levelling.ts, as the brain scores them), the brain's choice from its
// `levellingChosen` events (none, a brain from before #336: batching for money), and levelling mode's fitted factor,
// its measured rate against the formula's. A failure: the brain not on the shortest (past the hysteresis' 1.25 times)
// for longer than a choice takes (`LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS`), or its choice's estimate past the time
// the BitNode has taken so far, a hopeless one (decision 67's point 8). With the World Daemon's switch off, both are
// warnings: the destroy isn't wanted, and money is what the owner asked for.
import {
  AUGMENTATIONS,
  gangFactionOf,
  LEVELLING_SWITCH_GAIN,
  type LevellingCandidate,
  type LevellingRate,
  levellingEstimates,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
  shortestLevellingCandidate,
  WORLD_DAEMON,
} from "@bitburner-agent/core";
import { bitNodeHackingOf } from "./batcher.ts";
import { BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND } from "./bitnode-end.ts";
import { gangShopOf } from "./gang.ts";
import { formatDuration } from "./gap-report.ts";
import { CITY_GROUP_CHOSEN_EVENT_KIND } from "./invitations.ts";
import {
  describeEstimate,
  describeEstimates,
  LEVELLING_CANDIDATE_WORDS,
  LEVELLING_CHOSEN_EVENT_KIND,
  LevellingRateWindow,
  levellingFiguresOf,
  levellingInputsOf,
  settleMsOf,
} from "./levelling.ts";
import type { StoredEvent } from "./telemetry-store.ts";
import {
  BITNODE_DESTROY_SENT_EVENT_KIND,
  DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND,
  describeWorldDaemonPath,
  HACKING_EXP_WINDOW_MS,
  HackingExpRate,
  sinceResetOf,
  WORLD_DAEMON_STALLED_AFTER_MS,
  WORLD_DAEMON_STALLED_EVENT_KIND,
  worldDaemonPath,
} from "./world-daemon.ts";

/**
 * The World Daemon's events (#215): section 3's and 4's, so left out of section 1's timeline; the levelling choice's
 * too (#336).
 */
export const WORLD_DAEMON_EVENT_KINDS = [
  WORLD_DAEMON_STALLED_EVENT_KIND,
  BITNODE_DESTROY_SENT_EVENT_KIND,
  DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND,
  LEVELLING_CHOSEN_EVENT_KIND,
];

const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/**
 * How long the brain may be off the shortest candidate (#336) before the run report fails it: 10 minutes, the window
 * its rates are measured over (`HACKING_EXP_WINDOW_MS`). The first choice comes a minute after the level is all
 * that's left (money's rate measured), and later ones as the measured rates move, within the window.
 */
export const LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS = HACKING_EXP_WINDOW_MS;

/** The brain's levelling mode at `atMs`, from its events (#336): the last choice by then, or money with none. */
export function levellingModeAt(events: readonly StoredEvent[], atMs: number): LevellingCandidate {
  const last = events.findLast((event) => event.kind === LEVELLING_CHOSEN_EVENT_KIND && event.atMs <= atMs);
  const mode = fieldsOf(last?.detail).mode;
  return mode === "level" || mode === "install" ? mode : "money";
}

/** The snapshots the levelling's judgement reads (#336): the window's last of each tier. */
interface LastSnapshots {
  staticLast: StaticSnapshotData | undefined;
  mediumLast: MediumSnapshotData | undefined;
  slowLast: SlowSnapshotData | undefined;
}

/**
 * w0r1d_d43m0n's readiness in a BitNode (#308), as its last medium snapshot left it: whether it could be judged (a
 * static snapshot by then gave the hacking requirement), and the medium snapshots it has been ready in (rooted, at
 * that level: `worldDaemonProblem`'s), unbroken, to that last one: the first's and the last's times.
 */
interface Readiness {
  judged: boolean;
  ready: { sinceMs: number; lastMs: number } | null;
}

/**
 * The window's hacking experience rate, folded from its medium snapshots, for the path's ETA; and w0r1d_d43m0n's
 * readiness in each BitNode (#308), for the owner's prompt.
 */
export class WorldDaemonFold {
  readonly #exp = new HackingExpRate();
  /** w0r1d_d43m0n's hacking requirement from each static snapshot that gives it, in order (#308). */
  readonly #requirements: { atMs: number; level: number }[] = [];
  /** By BitNode: the run report's index of it (`BitNodeCycles.bitNodeIndexAt`). */
  readonly #readiness = new Map<number, Readiness>();
  /** The last slow snapshot's game time (#334): the gang's faction's rate, since its install. */
  #slowGameTimeMs: number | null = null;
  /**
   * The medium snapshots' experience and level in the window's last BitNode and cycle (#336), for the measured rates:
   * another BitNode, or the experience falling (an install), starts them again.
   */
  #samples: { atMs: number; exp: number; level: number }[] = [];
  #samplesBitNode: number | null = null;
  /** Since when the hacking level has been all that's left (#336), unbroken to the last medium snapshot, or null. */
  #levelOnlySinceMs: number | null = null;

  /** A slow snapshot's game time, in order (#334). */
  addSlow(gameTimeMs: number): void {
    this.#slowGameTimeMs = gameTimeMs;
  }

  /** A static snapshot, in order, the one before the window's first. */
  addStatic(atMs: number, data: StaticSnapshotData): void {
    const level = data.servers?.find((server) => server.hostname === WORLD_DAEMON)?.requiredHackingSkill;
    if (typeof level === "number" && Number.isFinite(level)) this.#requirements.push({ atMs, level });
  }

  /** A medium snapshot, in order, in the BitNode the run report puts it in (`bitNode`, its index). */
  addMedium(atMs: number, data: MediumSnapshotData, bitNode: number): void {
    const player = data.player as { exp?: { hacking?: unknown }; skills?: { hacking?: unknown } } | undefined;
    const exp = player?.exp?.hacking;
    if (typeof exp === "number" && Number.isFinite(exp)) this.#exp.add(atMs, exp);
    const required = this.#requirements.findLast((requirement) => requirement.atMs <= atMs)?.level;
    const level = player?.skills?.hacking;
    // The levelling's samples, and since when the level has been all that's left (#336): w0r1d_d43m0n rooted, the
    // level short of its requirement (rooted, The Red Pill is installed: it's reachable only then).
    if (typeof exp === "number" && Number.isFinite(exp) && typeof level === "number" && Number.isFinite(level)) {
      const last = this.#samples.at(-1);
      if (this.#samplesBitNode !== bitNode || (last !== undefined && exp < last.exp)) this.#samples = [];
      this.#samplesBitNode = bitNode;
      this.#samples.push({ atMs, exp, level });
    }
    const daemonRooted = data.servers?.find((server) => server.hostname === WORLD_DAEMON)?.hasAdminRights === true;
    const levelOnly = required !== undefined && typeof level === "number" && level < required && daemonRooted;
    this.#levelOnlySinceMs = levelOnly ? (this.#levelOnlySinceMs ?? atMs) : null;
    const ready =
      required !== undefined &&
      typeof level === "number" &&
      level >= required &&
      data.servers?.find((server) => server.hostname === WORLD_DAEMON)?.hasAdminRights === true;
    const before = this.#readiness.get(bitNode)?.ready;
    this.#readiness.set(bitNode, {
      judged: required !== undefined,
      ready: ready ? { sinceMs: before?.sinceMs ?? atMs, lastMs: atMs } : null,
    });
  }

  /**
   * Section 3's lines: the path as of the last snapshots, then each destroy sent, and each install while short that
   * added none to the count with nothing that counts passed over (#238).
   */
  pathLines(
    {
      staticLast,
      mediumLast,
      slowLast,
    }: {
      staticLast: StaticSnapshotData | undefined;
      mediumLast: MediumSnapshotData | undefined;
      slowLast: SlowSnapshotData | undefined;
    },
    events: readonly StoredEvent[],
    formatTime: (ms: number) => string,
  ): string[] {
    const lines = ["  the path to the World Daemon (as the window's last snapshots show it):"];
    let described: string[];
    // The reach counts the city group the brain chose (#228): the window's last choice.
    const chosen = events.findLast((event) => event.kind === CITY_GROUP_CHOSEN_EVENT_KIND)?.detail as
      | { group?: unknown }
      | undefined;
    const cityGroup = typeof chosen?.group === "string" ? chosen.group : null;
    try {
      described = describeWorldDaemonPath(
        worldDaemonPath({
          staticData: staticLast ?? null,
          mediumData: mediumLast ?? null,
          slowData: slowLast ?? null,
          expPerSecond: this.#exp.perSecond(),
          cityGroup,
          // The Red Pill at the gang's faction in BN2 (#334), the slow snapshot carrying its name.
          gangShop: gangShopOf(slowLast, gangFactionOf(slowLast)),
          sinceResetMs: sinceResetOf(slowLast, this.#slowGameTimeMs),
        }),
      );
    } catch (error) {
      described = [`not read: the snapshots as core knows the game (${(error as Error).message})`];
    }
    for (const line of described) lines.push(`    ${line}`);
    if (described.length === 0) lines.push("    no slow snapshot in the window");
    for (const line of this.#levelling({ staticLast, mediumLast, slowLast }, events, formatTime)?.lines ?? []) {
      lines.push(`    ${line}`);
    }
    for (const { atMs, detail } of events.filter((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND)) {
      const fields = fieldsOf(detail);
      lines.push(
        `    ${formatTime(atMs)}  destroy sent (${fields.source === "manual" ? "yours" : "the brain's"}), into ` +
          `BitNode ${String(fields.nextBitNode)}` +
          // The BitNodes the order skipped on the way (#323): none in a store from before it.
          (typeof fields.skipped === "string" ? ` (${fields.skipped})` : "") +
          (typeof fields.replay === "string" ? `, a replay (${fields.replay})` : ""),
      );
    }
    for (const { atMs, detail } of events.filter((event) => event.kind === DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND)) {
      lines.push(`    ${formatTime(atMs)}  ${String(fieldsOf(detail).detail)}`);
    }
    return lines;
  }

  /**
   * Section 4's lines, each stall the rule stored a failure; but, in a store from before #311 only, the `nextBitNode`
   * stall (#308; the brain no longer emits it, nor the stop for nothing more to gain): expected when a stop
   * at the BitNode's end for nothing more to gain followed it in its BitNode (the switch on: the stall comes as
   * w0r1d_d43m0n shows, the stop once it's ready), else the owner's prompt: no stop followed (the switch off, or the
   * stop didn't fire), so the brain waits on them. A warning once w0r1d_d43m0n has been ready
   * `WORLD_DAEMON_STALLED_AFTER_MS`, unbroken to its BitNode's last medium snapshot, else a line; one that can't be
   * judged (no static snapshot with the requirement) says so. `bitNodeAt`: the BitNode's index, as `addMedium`'s.
   */
  healthLines(
    events: readonly StoredEvent[],
    {
      failures,
      warnings,
      formatTime,
      bitNodeAt,
      snapshots,
      worldDaemonEnabled = true,
    }: {
      failures: string[];
      warnings: string[];
      formatTime: (ms: number) => string;
      bitNodeAt: (atMs: number) => number;
      /** The window's last snapshots, for the levelling choice's judgement (#336); absent, none. */
      snapshots?: LastSnapshots;
      /**
       * The World Daemon's switch now (#336's review): off, the destroy isn't wanted and money is what the owner asked
       * for, so the levelling choice's failures are warnings. Absent, on.
       */
      worldDaemonEnabled?: boolean;
    },
  ): string[] {
    const lines = [
      "  the path to the World Daemon stalled (a step the brain finishes in minutes, not done in 5; or an install while " +
        "short of Daedalus's count that added none to it, passing over one that counts, #228, #238):",
    ];
    const stalls = events.filter((event) => event.kind === WORLD_DAEMON_STALLED_EVENT_KIND);
    // Old stores only (#311): the stops for nothing more to gain, which no brain since emits.
    const stops = events.filter(
      (event) =>
        event.kind === BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND && fieldsOf(event.detail).reason === "nothingMoreToGain",
    );
    for (const { atMs, detail } of stalls) {
      const fields = fieldsOf(detail);
      // "Daedalus count stuck" (#228) says what it is, and when: the install it saw; every other step is a stall.
      const line =
        fields.step === "daedalusCount"
          ? `${String(fields.detail)}, seen at ${formatTime(atMs)}`
          : `world daemon stalled: ${String(fields.detail)}, from ${formatTime(Number(fields.sinceMs))} to at least ` +
            formatTime(atMs);
      // Old stores only (#311): the refusal's stall, which no brain since emits.
      if (fields.step === "nextBitNode") {
        const bitNode = bitNodeAt(atMs);
        const answered = stops.find((stop) => stop.atMs >= atMs && bitNodeAt(stop.atMs) === bitNode);
        if (answered !== undefined) {
          lines.push(
            `    ${line} (expected: the brain stopped itself at the BitNode's end at ${formatTime(answered.atMs)}, the ` +
              "switch on)",
          );
          continue;
        }
        const noStop = "no stop followed (the switch off, or the stop didn't fire)";
        const readiness = this.#readiness.get(bitNode);
        if (readiness?.judged !== true) {
          lines.push(
            `    ${line} (${noStop}; whether ${WORLD_DAEMON} was ready can't be told: no static snapshot gives its ` +
              "hacking requirement)",
          );
          continue;
        }
        const { ready } = readiness;
        if (ready === null || ready.lastMs - ready.sinceMs < WORLD_DAEMON_STALLED_AFTER_MS) {
          lines.push(
            `    ${line} (${noStop}: yours once ${WORLD_DAEMON} is ready; not ready ` +
              `${formatDuration(WORLD_DAEMON_STALLED_AFTER_MS)} by its BitNode's last medium snapshot)`,
          );
          continue;
        }
        const prompt =
          `owner prompt: ${line}; ${WORLD_DAEMON} ready from ${formatTime(ready.sinceMs)} to at least ` +
          `${formatTime(ready.lastMs)}, and ${noStop}, so the brain waits on you`;
        lines.push(`    ${prompt}`);
        warnings.push(prompt);
        continue;
      }
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (stalls.length === 0) lines.push("    none");
    // The levelling choice (#336), only while the hacking level is all that's left.
    const levelling = snapshots === undefined ? null : this.#levelling(snapshots, events, formatTime);
    if (levelling === null) return lines;
    lines.push(
      "  the levelling choice (#336: the brain not on the shortest way to w0r1d_d43m0n's level for " +
        `${formatDuration(LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS)}, or its choice's estimate past the BitNode's time so ` +
        "far):",
    );
    for (const failure of levelling.failures) {
      if (worldDaemonEnabled) {
        lines.push(`    ${failure}`);
        failures.push(failure);
      } else {
        const warning = `${failure} (the World Daemon's switch is off now: the destroy isn't wanted, so a warning)`;
        lines.push(`    ${warning}`);
        warnings.push(warning);
      }
    }
    if (levelling.failures.length === 0) lines.push("    none");
    return lines;
  }

  /**
   * The levelling choice as the window's end shows it (#336), or null while the hacking level isn't all that's left:
   * the candidates' estimates (core's `levellingEstimates`, on the brain's own figures, `levellingFiguresOf`), the
   * brain's mode from its events (`levellingModeAt`), the mode's rate measured from the medium snapshots once it
   * settled, and the failures: off the shortest past the hysteresis for `LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS`, or
   * the mode's estimate past the BitNode's game time so far (from the slow snapshot's `lastNodeReset`): the whole path
   * to here took that long, so a last step longer than all of it is hopeless (BN4.1: about 2,900 h to go, 27 h in).
   */
  #levelling(
    { staticLast, mediumLast, slowLast }: LastSnapshots,
    events: readonly StoredEvent[],
    formatTime: (ms: number) => string,
  ): { lines: string[]; failures: string[] } | null {
    const sinceMs = this.#levelOnlySinceMs;
    const lastMs = this.#samples.at(-1)?.atMs;
    const required = this.#requirements.at(-1)?.level;
    if (sinceMs === null || lastMs === undefined || required === undefined || mediumLast === undefined) return null;
    const hacking = bitNodeHackingOf(slowLast?.resetInfo?.currentNode).multipliers;
    const figures = levellingFiguresOf(staticLast ?? null, mediumLast, slowLast ?? null, hacking);
    if (figures === null) return null;
    const mode = levellingModeAt(events, lastMs);
    const chosen = events.findLast((event) => event.kind === LEVELLING_CHOSEN_EVENT_KIND && event.atMs <= lastMs);
    const fields = fieldsOf(chosen?.detail);
    const modeSinceMs = Math.max(sinceMs, chosen?.atMs ?? sinceMs);
    const target = figures.target;
    // The mode's rate, measured once it settled, over the window's last 10 minutes at most.
    const settledMs = modeSinceMs + (mode === "money" ? 0 : settleMsOf(mediumLast, hacking, target ? [target] : []));
    const window = new LevellingRateWindow();
    for (const sample of this.#samples) if (sample.atMs >= settledMs) window.add(sample.atMs, sample.exp, sample.level);
    const measured = window.measured();
    const rateOf = (value: unknown): LevellingRate | null => {
      const rate = value as Partial<LevellingRate> | null | undefined;
      return typeof rate?.expPerSecond === "number" && typeof rate.atLevel === "number"
        ? { expPerSecond: rate.expPerSecond, atLevel: rate.atLevel }
        : null;
    };
    const money = mode === "money" ? measured : rateOf(fields.money);
    const predicted =
      target === null || measured === null
        ? null
        : target.expPerThreadSecond * figures.threads * ((measured.atLevel + 50) / (figures.level + 50));
    const fitted = mode === "level" && measured !== null && predicted !== null && predicted > 0;
    const factor = fitted
      ? measured.expPerSecond / (predicted as number)
      : typeof fields.factor === "number"
        ? fields.factor
        : null;
    const levels = typeof fields.neuroFluxLevels === "number" ? fields.neuroFluxLevels : null;
    // (c)'s set from the gang's shop (#355), as the brain last offered it: the game's names only (none before #355).
    const augmentations = Array.isArray(fields.installAugmentations)
      ? fields.installAugmentations.filter(
          (name): name is string => typeof name === "string" && Object.hasOwn(AUGMENTATIONS, name),
        )
      : [];
    const estimates = levellingEstimates(levellingInputsOf(figures, required, money, factor, levels, augmentations));
    const best = shortestLevellingCandidate(estimates);
    const words = LEVELLING_CANDIDATE_WORDS;
    const lines = [
      `levelling (the hacking level all that's left since ${formatTime(sinceMs)}, #336): ${describeEstimates(estimates)}` +
        (chosen === undefined ? " (no levelling choice in the window: a brain from before #336, or none yet)" : ""),
      `  the brain's choice: ${words[mode]} since ${formatTime(modeSinceMs)}` +
        (target === null ? "" : `; levelling's target ${target.hostname}`) +
        "; levelling's fitted factor " +
        (fitted
          ? `${(factor as number).toFixed(2)} (measured ${(measured as LevellingRate).expPerSecond.toExponential(2)}/s, ` +
            `the formula ${(predicted as number).toExponential(2)}/s for the RAM it runs on)`
          : factor !== null
            ? `${factor.toFixed(2)} (as the brain last fitted it)`
            : "not measured (1 taken, optimistic)"),
    ];
    const failures: string[] = [];
    const ours = estimates[mode];
    const shortest = best === null ? null : estimates[best];
    const offMs = lastMs - modeSinceMs;
    if (
      best !== null &&
      best !== mode &&
      shortest !== null &&
      (ours === null || shortest * LEVELLING_SWITCH_GAIN < ours) &&
      offMs > LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS
    ) {
      // The time in the mode, which the last snapshots find off the shortest: when another became shorter isn't
      // followed snapshot by snapshot.
      failures.push(
        `levelling: the brain on ${words[mode]} (${describeEstimate(ours)}) for ${formatDuration(offMs)}, since ` +
          `${formatTime(modeSinceMs)}, past the ${formatDuration(LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS)} a choice ` +
          `takes, and ${words[best]} (${describeEstimate(shortest)}) is shorter by more than 1.25 times at its end`,
      );
    }
    const resetAt = slowLast?.resetInfo?.lastNodeReset;
    const soFarMs =
      typeof resetAt === "number" && this.#slowGameTimeMs !== null ? Math.max(0, this.#slowGameTimeMs - resetAt) : null;
    if (
      ours !== null &&
      soFarMs !== null &&
      ours * 1000 > soFarMs &&
      lastMs - sinceMs > LEVELLING_OFF_SHORTEST_FAILS_AFTER_MS
    ) {
      failures.push(
        `levelling: the brain's choice, ${words[mode]}, ${describeEstimate(ours)} to w0r1d_d43m0n's level, past the ` +
          `${formatDuration(soFarMs)} the BitNode has taken so far: a hopeless estimate`,
      );
    }
    return { lines, failures };
  }
}
