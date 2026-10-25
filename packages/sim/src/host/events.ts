// The sim event log: things the game did that a browser would have shown or done outside the page. Recorded in the
// order they happen; `at` is virtual time (Date is faked once the clock is installed).
import { resolveObjectURL } from "node:buffer";
import { format } from "node:util";
import type { SimEvent } from "../protocol.ts";

const log: SimEvent[] = [];

export function events(): SimEvent[] {
  return [...log];
}

/** Console errors and warnings become events (and still reach stderr, for the output tail on a crash). */
export function captureConsole(): void {
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      log.push({ type: "console", at: Date.now(), level, message: format(...args) });
      original(...args);
    };
  }
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
    log.push({ type: "download", at: Date.now(), filename: this.download, bytes: blob?.size ?? 0 });
  };
}
