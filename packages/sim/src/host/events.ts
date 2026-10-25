// The sim event log: things the game did that a browser would have shown or done outside the page. Recorded in the
// order they happen. Module-level state is fine here: each simulation process holds exactly one game.
import { resolveObjectURL } from "node:buffer";
import { format } from "node:util";
import type { EventPage, GameEvent, SimEvent } from "../protocol.ts";
import { withoutMachinePaths } from "./paths.ts";

/** The most recent events kept; older ones are dropped (and counted). A long run of noisy scripts stays bounded. */
const KEEP = 10_000;

let kept: SimEvent[] = [];
let dropped = 0;
/** Events recorded so far, by type, dropped ones included. */
const counts = new Map<SimEvent["type"], number>();
let clockReady = false;

function record(event: SimEvent): void {
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  kept.push(event);
  if (kept.length > KEEP * 2) {
    dropped += kept.length - KEEP;
    kept = kept.slice(-KEEP);
  }
}

/** Virtual time, once the clock is installed; 0 for anything that happens while the host is still being set up. */
const now = () => (clockReady ? Date.now() : 0);

export function markClockReady(): void {
  clockReady = true;
}

/** How many events of this type have been recorded so far. */
export function eventCount(type: SimEvent["type"]): number {
  return counts.get(type) ?? 0;
}

export function events(since: number): EventPage {
  const start = Math.max(since, dropped);
  return { events: kept.slice(start - dropped), next: dropped + kept.length, dropped: Math.max(0, dropped - since) };
}

/**
 * Console errors and warnings become events (and still reach stderr, for the output tail on a crash). Node's own
 * process warnings (`(node:<pid>) …`) come through console.error too; they're about the host, not the game. Call once.
 */
export function captureConsole(): void {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = format(...args);
      if (!/^\(node:\d+\) /.test(message)) {
        record({ type: "console", at: now(), level, message: withoutMachinePaths(message) });
      }
      original(...args);
    };
  }
}

/** Something the game raised for its UI, or the router's arrival at the BitVerse (src/engine/bundle/). */
export function gameEvent(event: GameEvent): void {
  record({ ...event, at: now() });
}

/**
 * The game downloads files by clicking an `<a download>` on an object URL (utils/FileUtils.ts): save exports and the
 * pre-v3 backup. jsdom can't navigate; record the download instead.
 */
export function captureDownloads(window: Window & typeof globalThis): void {
  const click = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!this.hasAttribute("download")) return click.call(this);
    const blob = resolveObjectURL(this.href);
    record({ type: "download", at: now(), filename: this.download, bytes: blob?.size ?? 0 });
  };
}
