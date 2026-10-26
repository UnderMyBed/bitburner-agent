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

const isScriptPath = (path: string) => /\.(js|jsx|ts|tsx)$/.test(path);
const isTextPath = (path: string) => /\.(txt|json|css)$/.test(path);

/**
 * The game's side of a Remote File API connection, answering as `src/RemoteFileAPI/MessageHandlers.ts` and
 * `BaseServer.removeFile` do, for home only, with their messages: files in memory (text files listed before scripts),
 * a RAM figure per script, and scripts that are running (whose files it won't delete; text files it always will).
 * It doesn't check paths beyond their extension.
 */
export class FakeRfaGame extends MemoryConnection {
  readonly files = new Map<string, string>();
  readonly runningScripts = new Set<string>();
  /** Each request, as `method filename` (or just the method). */
  readonly requests: string[] = [];
  definitionFile = "interface NS {}\n";
  ramOf: (filename: string, content: string) => number = () => 2.6;
  /** Drops the connection instead of answering this request (1-based), as a game that quits mid-deploy. */
  dropAtRequest = 0;
  /** Never answers this request (1-based), as the game when a handler throws (Remote.ts:127-134). */
  silentAtRequest = 0;
  /** Reports a close a macrotask late, as `ws` does after the closing handshake, rather than at once. */
  closeReportedLate = false;

  override send(text: string): void {
    super.send(text);
    if (this.closedWith) return;
    const { id, method, params } = JSON.parse(text) as {
      id: number;
      method: string;
      params?: { filename?: string; content?: string };
    };
    this.requests.push(params?.filename === undefined ? method : `${method} ${params.filename}`);
    if (this.requests.length === this.dropAtRequest) {
      queueMicrotask(() => this.dropFromGameSide());
      return;
    }
    if (this.requests.length === this.silentAtRequest) return;
    const answer = this.#answer(method, params?.filename ?? "", params?.content ?? "");
    queueMicrotask(() => this.receive(JSON.stringify({ jsonrpc: "2.0", id, ...answer })));
  }

  override close(code: number, reason: string): void {
    if (!this.closeReportedLate) {
      super.close(code, reason);
      return;
    }
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    setTimeout(() => {
      this.closedWith = null;
      super.close(code, reason);
    }, 0);
  }

  #answer(method: string, filename: string, content: string): { result?: unknown; error?: string } {
    const missing = { error: `File does not exist. Filename: ${filename}` };
    switch (method) {
      case "pushFile":
        if (!isScriptPath(filename) && !isTextPath(filename)) {
          return { error: `Invalid file extension. Filename: ${filename}` };
        }
        this.files.set(filename, content);
        return { result: "OK" };
      case "getFile":
        return this.files.has(filename) ? { result: this.files.get(filename) } : missing;
      case "deleteFile":
        if (!this.files.has(filename)) {
          return {
            error: isScriptPath(filename) ? `Script ${filename} not found.` : `Text file ${filename} not found.`,
          };
        }
        if (this.runningScripts.has(filename)) return { error: "Cannot delete a script that is currently running!" };
        this.files.delete(filename);
        return { result: "OK" };
      case "getFileNames": {
        const names = [...this.files.keys()];
        return { result: [...names.filter(isTextPath), ...names.filter(isScriptPath)] };
      }
      case "calculateRam": {
        if (!isScriptPath(filename)) return { error: `File is not a script. Filename: ${filename}` };
        const script = this.files.get(filename);
        return script === undefined ? missing : { result: this.ramOf(filename, script) };
      }
      case "getDefinitionFile":
        return { result: this.definitionFile };
      default:
        return { error: "Unknown message received" };
    }
  }
}
