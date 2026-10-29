// Augmentations in the run report (#210): the installs the slow snapshots show, and the augmentation rule's events (its
// decisions, purchases, installs sent and cycles called off), with the failures: a purchase not queued, an install
// sent with no reset seen after it, and an install reported done with no reset after it.
import { type InstallReason, installGains, NEUROFLUX_GOVERNOR, type SlowSnapshotData } from "@bitburner-agent/core";
import {
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_NOT_QUEUED_EVENT_KIND,
  describeReason,
  formatEta,
  type StoredWay,
} from "./augmentations.ts";
import type { StoredEvent } from "./telemetry-store.ts";

/** The augmentation rule's events (#210): section 3's, so left out of section 1's timeline. */
export const AUGMENTATION_EVENT_KINDS = [
  AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND,
  AUGMENTATION_BOUGHT_EVENT_KIND,
  AUGMENTATION_NOT_QUEUED_EVENT_KIND,
  AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND,
  AUGMENTATION_INSTALL_SENT_EVENT_KIND,
  AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND,
];

/** An install the slow snapshots show: another `lastAugReset`, and what `ownedAugs` gained. */
interface SeenInstall {
  /** When the first slow snapshot showing it arrived. */
  seenAtMs: number;
  /** The augmentations it installed, NeuroFlux Governor once per level. */
  installed: string[];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const formatMoney = (money: unknown) =>
  isFiniteNumber(money) ? `$${Math.round(money).toLocaleString("en-US")}` : "unknown";
const fieldsOf = (detail: unknown) =>
  (typeof detail === "object" && detail !== null ? detail : {}) as Record<string, unknown>;

/** "BitWire, NeuroFlux Governor ×2", or "none". */
export function describeAugmentations(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(", ") || "none";
}

/** The multipliers an install gained above 1, from core's data: "hacking ×1.180, hacking_speed ×1.061". */
export function describeGains(names: readonly string[]): string {
  const known = names.filter((name) => {
    try {
      installGains([name]);
      return true;
    } catch {
      return false;
    }
  });
  const gains = Object.entries(installGains(known)).filter(([, gain]) => gain !== 1);
  return gains.length === 0
    ? "no hacking multiplier"
    : gains.map(([key, gain]) => `${key} ×${gain.toFixed(3)}`).join(", ");
}

/** The slow snapshot's `lastAugReset` and `ownedAugs`, or null where they aren't as the Agent writes them. */
function resetOf(data: SlowSnapshotData) {
  const info = data.resetInfo as Partial<SlowSnapshotData["resetInfo"]> | undefined;
  const owned = info?.ownedAugs;
  if (!isFiniteNumber(info?.lastAugReset) || typeof owned !== "object" || owned === null) return null;
  if (!Object.values(owned).every(isFiniteNumber)) return null;
  return { lastAugReset: info.lastAugReset, ownedAugs: owned };
}

/** The Agent's last disconnect at or before `atMs`, and the connect after it, or null. */
function awayAround(events: readonly StoredEvent[], atMs: number) {
  const disconnect = events.filter((event) => event.kind === "agentDisconnected" && event.atMs <= atMs).at(-1);
  if (disconnect === undefined) return null;
  const connect = events.find((event) => event.kind === "agentConnected" && event.atMs >= disconnect.atMs);
  return connect === undefined ? null : { disconnectedAtMs: disconnect.atMs, connectedAtMs: connect.atMs };
}

/** Augmentations over a run (#210), folded from the slow snapshots one at a time. */
export class AugmentationTimeline {
  readonly installs: SeenInstall[] = [];
  /** The slow snapshots' resets, in order: when the first showing each arrived, and its `lastAugReset`. */
  readonly #resets: { atMs: number; lastAugReset: number }[] = [];
  #owned: Record<string, number> | null = null;

  addSlow(atMs: number, data: SlowSnapshotData): void {
    const reset = resetOf(data);
    if (reset === null) return;
    const previous = this.#resets.at(-1);
    if (previous !== undefined && previous.lastAugReset !== reset.lastAugReset) {
      const installed: string[] = [];
      for (const [name, level] of Object.entries(reset.ownedAugs)) {
        for (let each = this.#owned?.[name] ?? 0; each < level; each += 1) installed.push(name);
      }
      this.installs.push({ seenAtMs: atMs, installed });
    }
    if (previous?.lastAugReset !== reset.lastAugReset) this.#resets.push({ atMs, lastAugReset: reset.lastAugReset });
    this.#owned = reset.ownedAugs;
  }

  /** Section 3's lines: each decision, purchase, install sent, install seen and cycle called off, in time order. */
  actionLines(events: readonly StoredEvent[], formatTime: (ms: number) => string): string[] {
    const entries: { atMs: number; text: string }[] = [];
    for (const { atMs, kind, detail } of events) {
      const fields = fieldsOf(detail);
      if (kind === AUGMENTATION_INSTALL_CHOSEN_EVENT_KIND) {
        const set = Array.isArray(fields.set) ? (fields.set as { augmentation?: unknown }[]) : [];
        const without = (fields.without ?? null) as StoredWay | null;
        const withInstall = (fields.with ?? null) as StoredWay | null;
        entries.push({
          atMs,
          text:
            `install chosen, ${formatEta(isFiniteNumber(fields.sinceResetMs) ? fields.sinceResetMs : null)} since ` +
            `the last: buying ${set.map((each) => String(each.augmentation)).join(", ") || "nothing more"} ` +
            `(${formatMoney(fields.cost)}); ` +
            describeReason(
              (typeof fields.reason === "string"
                ? fields.reason
                : without === null
                  ? "nothing left"
                  : "sooner installing") as InstallReason,
              { with: withInstall, without },
            ),
        });
      } else if (kind === AUGMENTATION_BOUGHT_EVENT_KIND) {
        const level = fields.augmentation === NEUROFLUX_GOVERNOR ? ` (level ${String(fields.level)})` : "";
        entries.push({
          atMs,
          text:
            `bought ${String(fields.augmentation)}${level} from ${String(fields.faction)} for ` +
            `${formatMoney(fields.price)} (queue ${String(fields.queueLength)})`,
        });
      } else if (kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND) {
        const queued = Array.isArray(fields.queued) ? fields.queued.map(String) : [];
        entries.push({
          atMs,
          text:
            `install sent (${fields.source === "manual" ? "yours" : "the brain's"}): ` + describeAugmentations(queued),
        });
      } else if (kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND) {
        entries.push({ atMs, text: `install cycle called off: ${String(fields.reason)}` });
      } else if (kind === AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND) {
        const queued = Array.isArray(fields.queued) ? fields.queued.map(String) : [];
        entries.push({
          atMs,
          text: `install reported done but the game didn't reset (queue: ${describeAugmentations(queued)})`,
        });
      }
    }
    for (const install of this.installs) {
      const away = awayAround(events, install.seenAtMs);
      entries.push({
        atMs: install.seenAtMs,
        text:
          `installed (seen in a slow snapshot): ${describeAugmentations(install.installed)}; ` +
          describeGains(install.installed) +
          (away === null
            ? ""
            : `; the Agent disconnected at ${formatTime(away.disconnectedAtMs)} and was back ` +
              `${formatEta(away.connectedAtMs - away.disconnectedAtMs)} later`),
      });
    }
    entries.sort((a, b) => a.atMs - b.atMs);
    const lines = ["  augmentations (the brain's install decisions and purchases, and the installs):"];
    for (const { atMs, text } of entries) lines.push(`    ${formatTime(atMs)}  ${text}`);
    if (entries.length === 0) lines.push("    none");
    return lines;
  }

  /**
   * Section 4's lines, each failure added to `failures`: a purchase not queued (the rule's event); an install reported
   * done with no reset in the next slow snapshot (the rule's event, #213 re-review); and an install sent with no slow
   * snapshot showing another `lastAugReset` within `withinMs` (not judged where the window ends first, nor where the
   * cycle was called off meanwhile: withdrawn; one reported done with no reset is the failure above).
   */
  healthLines(
    events: readonly StoredEvent[],
    {
      untilMs,
      withinMs,
      failures,
      formatTime,
    }: { untilMs: number; withinMs: number; failures: string[]; formatTime: (ms: number) => string },
  ): string[] {
    const lines = ["  augmentation purchases reported done and never queued:"];
    const notQueued = events.filter((event) => event.kind === AUGMENTATION_NOT_QUEUED_EVENT_KIND);
    for (const { atMs, detail } of notQueued) {
      const fields = fieldsOf(detail);
      const level = fields.augmentation === NEUROFLUX_GOVERNOR ? ` (level ${String(fields.level)})` : "";
      const line =
        `augmentation not queued: ${String(fields.augmentation)}${level}, reported bought at ` +
        `${formatTime(Number(fields.boughtAtMs))}, not in the faction state's queue by ${formatTime(atMs)}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notQueued.length === 0) lines.push("    none");
    lines.push("  installs reported done with no reset in the next slow snapshot:");
    const notReset = events.filter((event) => event.kind === AUGMENTATION_INSTALL_NOT_RESET_EVENT_KIND);
    for (const { atMs, detail } of notReset) {
      const queued = fieldsOf(detail).queued;
      const line =
        `install reported done but the game didn't reset: at ${formatTime(atMs)}, with the faction state's queue ` +
        `${describeAugmentations(Array.isArray(queued) ? queued.map(String) : [])}`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notReset.length === 0) lines.push("    none");
    lines.push(`  installs sent and not seen done (a slow snapshot with another reset) within ${formatEta(withinMs)}:`);
    let notSeen = 0;
    for (const sent of events.filter((event) => event.kind === AUGMENTATION_INSTALL_SENT_EVENT_KIND)) {
      if (sent.atMs + withinMs > untilMs) continue;
      const before = this.#resets.filter((reset) => reset.atMs <= sent.atMs).at(-1);
      const seen = this.#resets.some(
        (reset) =>
          reset.atMs > sent.atMs && reset.atMs <= sent.atMs + withinMs && reset.lastAugReset !== before?.lastAugReset,
      );
      if (seen) continue;
      const reportedDone = notReset.find((event) => event.atMs >= sent.atMs && event.atMs <= sent.atMs + withinMs);
      if (reportedDone !== undefined) {
        lines.push(
          `    install sent at ${formatTime(sent.atMs)}, reported done with no reset at ` +
            `${formatTime(reportedDone.atMs)}: the failure above`,
        );
        continue;
      }
      // Withdrawn: the cycle called off (the switch turned off) before the reset was due.
      const calledOff = events.find(
        (event) =>
          event.kind === AUGMENTATION_CYCLE_CALLED_OFF_EVENT_KIND &&
          event.atMs >= sent.atMs &&
          event.atMs <= sent.atMs + withinMs,
      );
      if (calledOff !== undefined) {
        lines.push(
          `    install sent at ${formatTime(sent.atMs)}, withdrawn at ${formatTime(calledOff.atMs)}: not a failure`,
        );
        continue;
      }
      notSeen++;
      const line =
        `install not seen done: sent at ${formatTime(sent.atMs)}, no slow snapshot with another reset ` +
        `${formatEta(withinMs)} on`;
      lines.push(`    ${line}`);
      failures.push(line);
    }
    if (notSeen === 0) lines.push("    none");
    return lines;
  }
}
