// The World Daemon in the run report (#215): the path as the window's last snapshots show it (Daedalus, The Red Pill,
// w0r1d_d43m0n's hacking requirement and the ETA at the window's experience rate), the destroys sent, and each stall
// the rule stored, a failure; an install while short of Daedalus's count that added none with nothing that counts
// passed over (#238), information. The `nextBitNode` stall a stop at the BitNode's end for nothing more to gain
// followed (#303, #308) is expected: the owner's switch asked for that end. One no stop followed is the owner's prompt
// (#308): a warning once w0r1d_d43m0n has been ready (rooted at its level) 5 minutes, else a line.
import {
  type MediumSnapshotData,
  type SlowSnapshotData,
  type StaticSnapshotData,
  WORLD_DAEMON,
} from "@bitburner-agent/core";
import { BRAIN_STOPPED_AT_BITNODE_END_EVENT_KIND } from "./bitnode-end.ts";
import { formatDuration } from "./gap-report.ts";
import { CITY_GROUP_CHOSEN_EVENT_KIND } from "./invitations.ts";
import type { StoredEvent } from "./telemetry-store.ts";
import {
  BITNODE_DESTROY_SENT_EVENT_KIND,
  DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND,
  describeWorldDaemonPath,
  HackingExpRate,
  WORLD_DAEMON_STALLED_AFTER_MS,
  WORLD_DAEMON_STALLED_EVENT_KIND,
  worldDaemonPath,
} from "./world-daemon.ts";

/** The World Daemon's events (#215): section 3's and 4's, so left out of section 1's timeline. */
export const WORLD_DAEMON_EVENT_KINDS = [
  WORLD_DAEMON_STALLED_EVENT_KIND,
  BITNODE_DESTROY_SENT_EVENT_KIND,
  DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND,
];

const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/**
 * The window's hacking experience rate, folded from its medium snapshots, for the path's ETA; and when w0r1d_d43m0n was
 * last ready (#308): rooted, at the level the window's newest static snapshot says it needs (`worldDaemonProblem`'s).
 */
export class WorldDaemonFold {
  readonly #exp = new HackingExpRate();
  readonly #requiredHackingLevel: number | null;
  /** The medium snapshots w0r1d_d43m0n has been ready in, unbroken, to the last: the first's and the last's times. */
  #ready: { sinceMs: number; lastMs: number } | null = null;

  constructor(staticData?: StaticSnapshotData) {
    const required = staticData?.servers?.find((server) => server.hostname === WORLD_DAEMON)?.requiredHackingSkill;
    this.#requiredHackingLevel = typeof required === "number" && Number.isFinite(required) ? required : null;
  }

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const player = data.player as { exp?: { hacking?: unknown }; skills?: { hacking?: unknown } } | undefined;
    const exp = player?.exp?.hacking;
    if (typeof exp === "number" && Number.isFinite(exp)) this.#exp.add(atMs, exp);
    const level = player?.skills?.hacking;
    const ready =
      this.#requiredHackingLevel !== null &&
      typeof level === "number" &&
      level >= this.#requiredHackingLevel &&
      data.servers?.find((server) => server.hostname === WORLD_DAEMON)?.hasAdminRights === true;
    this.#ready = ready ? { sinceMs: this.#ready?.sinceMs ?? atMs, lastMs: atMs } : null;
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
        }),
      );
    } catch (error) {
      described = [`not read: the snapshots as core knows the game (${(error as Error).message})`];
    }
    for (const line of described) lines.push(`    ${line}`);
    if (described.length === 0) lines.push("    no slow snapshot in the window");
    for (const { atMs, detail } of events.filter((event) => event.kind === BITNODE_DESTROY_SENT_EVENT_KIND)) {
      const fields = fieldsOf(detail);
      lines.push(
        `    ${formatTime(atMs)}  destroy sent (${fields.source === "manual" ? "yours" : "the brain's"}), into ` +
          `BitNode ${String(fields.nextBitNode)}`,
      );
    }
    for (const { atMs, detail } of events.filter((event) => event.kind === DAEDALUS_COUNT_NEUROFLUX_ONLY_EVENT_KIND)) {
      lines.push(`    ${formatTime(atMs)}  ${String(fieldsOf(detail).detail)}`);
    }
    return lines;
  }

  /**
   * Section 4's lines, each stall the rule stored a failure; but the `nextBitNode` stall (#308): expected when a stop
   * at the BitNode's end for nothing more to gain followed it (the switch on: the stall comes as w0r1d_d43m0n shows,
   * the stop once it's ready), else the owner's prompt: the switch off, the brain waits on them. A warning once
   * w0r1d_d43m0n has been ready `WORLD_DAEMON_STALLED_AFTER_MS` by the window's last medium snapshot, else a line.
   */
  healthLines(
    events: readonly StoredEvent[],
    failures: string[],
    formatTime: (ms: number) => string,
    warnings: string[] = [],
  ): string[] {
    const lines = [
      "  the path to the World Daemon stalled (a step the brain finishes in minutes, not done in 5; or an install while " +
        "short of Daedalus's count that added none to it, passing over one that counts, #228, #238):",
    ];
    const stalls = events.filter((event) => event.kind === WORLD_DAEMON_STALLED_EVENT_KIND);
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
      if (fields.step === "nextBitNode") {
        const answered = stops.find((stop) => stop.atMs >= atMs);
        if (answered !== undefined) {
          lines.push(
            `    ${line} (expected: the brain stopped itself at the BitNode's end at ${formatTime(answered.atMs)}, the ` +
              "switch on)",
          );
          continue;
        }
        const ready = this.#ready;
        if (ready === null || ready.lastMs - ready.sinceMs < WORLD_DAEMON_STALLED_AFTER_MS) {
          lines.push(
            `    ${line} (yours once ${WORLD_DAEMON} is ready, the stop at the BitNode's end off: not ready ` +
              `${formatDuration(WORLD_DAEMON_STALLED_AFTER_MS)} in the window)`,
          );
          continue;
        }
        const prompt =
          `owner prompt: ${line}; ${WORLD_DAEMON} ready from ${formatTime(ready.sinceMs)} to at least ` +
          `${formatTime(ready.lastMs)}, the stop at the BitNode's end off, so the brain waits on you`;
        lines.push(`    ${prompt}`);
        warnings.push(prompt);
        continue;
      }
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (stalls.length === 0) lines.push("    none");
    return lines;
  }
}
