import type { Clock, TimerHandle } from "../../src/clock.ts";
import type { Connection } from "../../src/connection.ts";

/** A clock tests move by hand. */
export class ManualClock implements Clock {
  #now: number;
  #timers = new Map<number, { dueMs: number; callback: () => void }>();
  #nextHandle = 1;

  constructor(startMs = 1_767_225_600_000) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { dueMs: this.#now + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  /** Moves time on, firing every timer that falls due, in due order. */
  advance(ms: number): void {
    const endMs = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueMs <= endMs)
        .sort(([handleA, a], [handleB, b]) => a.dueMs - b.dueMs || handleA - handleB)[0];
      if (!due) break;
      const [handle, timer] = due;
      this.#timers.delete(handle);
      this.#now = timer.dueMs;
      timer.callback();
    }
    this.#now = endMs;
  }
}

/** A connection whose other end is the test: it records what the channel sends, and how it closed. */
export class MemoryConnection implements Connection {
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  #messageListeners: ((text: string) => void)[] = [];
  #closeListeners: (() => void)[] = [];

  send(text: string): void {
    if (!this.closedWith) this.sent.push(text);
  }

  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    for (const listener of this.#closeListeners) listener();
  }

  onMessage(listener: (text: string) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  /** A frame from the game's side. */
  receive(text: string): void {
    if (this.closedWith) return;
    for (const listener of this.#messageListeners) listener(text);
  }

  /** A frame that was already in flight when the connection was closed, as a real socket can still deliver. */
  receiveInFlight(text: string): void {
    for (const listener of this.#messageListeners) listener(text);
  }

  /** The game's side closed it. */
  dropFromGameSide(): void {
    this.close(1006, "");
  }

  /** What the channel sent, parsed. */
  sentMessages(): { type: string; [field: string]: unknown }[] {
    return this.sent.map((text) => JSON.parse(text) as { type: string });
  }
}
