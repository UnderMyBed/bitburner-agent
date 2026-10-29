// The World Daemon in the run report (#215): the path as the window's last snapshots show it (Daedalus, The Red Pill,
// w0r1d_d43m0n's hacking requirement and the ETA at the window's experience rate), the destroys sent, and each stall
// the rule stored, a failure.
import type { MediumSnapshotData, SlowSnapshotData, StaticSnapshotData } from "@bitburner-agent/core";
import type { StoredEvent } from "./telemetry-store.ts";
import {
  BITNODE_DESTROY_SENT_EVENT_KIND,
  describeWorldDaemonPath,
  HackingExpRate,
  WORLD_DAEMON_STALLED_EVENT_KIND,
  worldDaemonPath,
} from "./world-daemon.ts";

/** The World Daemon's events (#215): section 3's and 4's, so left out of section 1's timeline. */
export const WORLD_DAEMON_EVENT_KINDS = [WORLD_DAEMON_STALLED_EVENT_KIND, BITNODE_DESTROY_SENT_EVENT_KIND];

const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/** The window's hacking experience rate, folded from its medium snapshots, for the path's ETA. */
export class WorldDaemonFold {
  readonly #exp = new HackingExpRate();

  addMedium(atMs: number, data: MediumSnapshotData): void {
    const exp = (data.player as { exp?: { hacking?: unknown } } | undefined)?.exp?.hacking;
    if (typeof exp === "number" && Number.isFinite(exp)) this.#exp.add(atMs, exp);
  }

  /** Section 3's lines: the path as of the last snapshots, then each destroy sent. */
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
    try {
      described = describeWorldDaemonPath(
        worldDaemonPath({
          staticData: staticLast ?? null,
          mediumData: mediumLast ?? null,
          slowData: slowLast ?? null,
          expPerSecond: this.#exp.perSecond(),
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
    return lines;
  }

  /** Section 4's lines, each stall the rule stored a failure. */
  healthLines(events: readonly StoredEvent[], failures: string[], formatTime: (ms: number) => string): string[] {
    const lines = ["  the path to the World Daemon stalled (a step the brain finishes in minutes, not done in 5):"];
    const stalls = events.filter((event) => event.kind === WORLD_DAEMON_STALLED_EVENT_KIND);
    for (const { atMs, detail } of stalls) {
      const fields = fieldsOf(detail);
      const line =
        `world daemon stalled: ${String(fields.detail)}, from ${formatTime(Number(fields.sinceMs))} to at least ` +
        formatTime(atMs);
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (stalls.length === 0) lines.push("    none");
    return lines;
  }
}
