// The page's network (ADR 0012). The simulator stays offline: `fetch` fails as a browser's does with no connection,
// and `XMLHttpRequest` and `EventSource` refuse. WebSockets are the exception: a socket to a URL the parent listens on
// reaches the parent process, in lockstep with the virtual clock, so what a script sees never depends on real time.
import type { NetworkOutboxEntry } from "../../protocol.ts";
import type { VirtualClock } from "../clock.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Events the page causes itself (an open, a refused connection, its own close) arrive this long after the call. */
const PAGE_EVENT_DELAY_MS = 1;
/** "No status received": the code a close event has when the page closed without one (RFC 6455 §7.1.5). */
const NO_STATUS_CODE = 1005;
/** "Abnormal closure": the code of a connection that failed (RFC 6455 §7.1.5). */
const ABNORMAL_CLOSURE_CODE = 1006;
const MAX_CLOSE_REASON_BYTES = 123;

export interface SimulatedNetwork {
  /** Everything the page's sockets did since the last call, in order. */
  take(): NetworkOutboxEntry[];
  /** A frame from the parent, delivered at the virtual now. False if the connection is closing or closed. */
  send(connectionId: number, data: string): boolean;
  /** A close from the parent, delivered at the virtual now. False if the connection is already closing or closed. */
  close(connectionId: number, code: number, reason: string): boolean;
}

/** Cuts the page off from the network, except for sockets to `listenUrls`. Call once, before the engine loads. */
export function installNetwork(clock: VirtualClock, listenUrls: string[]): SimulatedNetwork {
  const listening = new Set(listenUrls.map((url) => new URL(url).href));
  const sockets = new Map<number, SimulatedWebSocket>();
  let outbox: NetworkOutboxEntry[] = [];
  let lastConnectionId = 0;

  const notSupported = (what: string) =>
    new TypeError(`WebSocket ${what} is not supported in the simulator (ADR 0012)`);

  /**
   * A browser WebSocket's behaviour, for what the game's RFA client and the Agent use (text frames, events, states),
   * with the parent at the other end. The rest fails fast rather than half-working.
   */
  class SimulatedWebSocket extends EventTarget {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;
    declare readonly CONNECTING: number;
    declare readonly OPEN: number;
    declare readonly CLOSING: number;
    declare readonly CLOSED: number;

    readonly url: string;
    readyState = CONNECTING;
    readonly connectionId: number;
    /** When the open is due: a frame from the parent is never delivered before it, as a server can't send before. */
    readonly opensAtMs: number;
    readonly #handlers = new Map<string, ((event: Event) => unknown) | null>();

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (protocols !== undefined) throw notSupported("sub-protocols");
      // As the browser parses it: an unparsable URL, or a scheme other than ws: and wss:, is a SyntaxError.
      if (!URL.canParse(String(url))) {
        throw new DOMException(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, "SyntaxError");
      }
      const parsed = new URL(String(url));
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new DOMException(
          `Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${parsed.protocol.slice(0, -1)}' is not allowed.`,
          "SyntaxError",
        );
      }
      this.url = parsed.href;
      this.connectionId = ++lastConnectionId;
      this.opensAtMs = clock.now() + PAGE_EVENT_DELAY_MS;
      sockets.set(this.connectionId, this);
      if (listening.has(this.url)) {
        outbox.push({ connectionId: this.connectionId, atMs: clock.now(), type: "connect", url: this.url });
        clock.queueTask(() => {
          if (this.readyState !== CONNECTING) return;
          this.readyState = OPEN;
          this.dispatchEvent(new Event("open"));
        }, PAGE_EVENT_DELAY_MS);
      } else {
        clock.queueTask(() => this.fail(), PAGE_EVENT_DELAY_MS);
      }
    }

    get binaryType(): string {
      return "blob";
    }

    set binaryType(value: string) {
      if (value !== "blob") throw notSupported(`binaryType "${value}"`);
    }

    send(data: unknown): void {
      if (this.readyState === CONNECTING) {
        throw new DOMException(
          "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          "InvalidStateError",
        );
      }
      if (typeof data !== "string") throw notSupported("binary frames");
      // A browser discards a frame sent once closing has begun.
      if (this.readyState !== OPEN) return;
      outbox.push({ connectionId: this.connectionId, atMs: clock.now(), type: "message", data });
    }

    close(code?: number, reason?: string): void {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException(
          `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          "InvalidAccessError",
        );
      }
      const reasonText = reason ?? "";
      if (new TextEncoder().encode(reasonText).length > MAX_CLOSE_REASON_BYTES) {
        throw new DOMException(
          "Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.",
          "SyntaxError",
        );
      }
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      const wasConnecting = this.readyState === CONNECTING;
      this.readyState = CLOSING;
      outbox.push({
        connectionId: this.connectionId,
        atMs: clock.now(),
        type: "close",
        code: code ?? null,
        reason: reasonText,
      });
      clock.queueTask(
        () => (wasConnecting ? this.fail() : this.finishClose(code ?? NO_STATUS_CODE, reasonText)),
        PAGE_EVENT_DELAY_MS,
      );
    }

    /** A frame from the parent, as one task. Dropped if the connection isn't open by then. */
    receive(data: string): void {
      if (this.readyState !== OPEN) return;
      this.dispatchEvent(new MessageEvent("message", { data, origin: new URL(this.url).origin }));
    }

    /** The connection failed (refused, or closed before it opened): error, then close 1006, in one task. */
    fail(): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.dispatchEvent(new Event("error"));
      this.dispatchEvent(new CloseEvent("close", { code: ABNORMAL_CLOSURE_CODE, reason: "", wasClean: false }));
    }

    /** A clean close, from either side. */
    finishClose(code: number, reason: string): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: true }));
    }

    /** `onopen` and friends, as a browser has them: one listener per type, registered when first set. */
    static defineHandlerProperty(type: string): void {
      Object.defineProperty(SimulatedWebSocket.prototype, `on${type}`, {
        configurable: true,
        get(this: SimulatedWebSocket) {
          return this.#handlers.get(type) ?? null;
        },
        set(this: SimulatedWebSocket, handler: unknown) {
          if (!this.#handlers.has(type)) {
            this.addEventListener(type, (event) => this.#handlers.get(type)?.call(this, event));
          }
          this.#handlers.set(type, typeof handler === "function" ? (handler as (event: Event) => unknown) : null);
        },
      });
    }
  }
  for (const type of ["open", "message", "error", "close"]) SimulatedWebSocket.defineHandlerProperty(type);
  for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    Object.defineProperty(SimulatedWebSocket.prototype, name, { value, enumerable: true });
  }
  Object.defineProperty(SimulatedWebSocket, "name", { value: "WebSocket" });

  const offline = {
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    XMLHttpRequest: refuse("XMLHttpRequest"),
    WebSocket: SimulatedWebSocket,
    EventSource: refuse("EventSource"),
  };
  Object.assign(globalThis, offline);
  Object.assign(window, offline);

  const socketFor = (connectionId: number): SimulatedWebSocket => {
    const socket = sockets.get(connectionId);
    if (!socket) throw new RangeError(`no connection ${connectionId}: the page never opened one with that id`);
    return socket;
  };

  return {
    take: () => {
      const taken = outbox;
      outbox = [];
      return taken;
    },
    send: (connectionId, data) => {
      const socket = socketFor(connectionId);
      if (socket.readyState === CLOSING || socket.readyState === CLOSED) return false;
      // Queued after the open when that's still to come: same moment, later in line.
      clock.queueTask(() => socket.receive(data), Math.max(0, socket.opensAtMs - clock.now()));
      return true;
    },
    close: (connectionId, code, reason) => {
      // A code a server may send (RFC 6455 §7.4): 1005, 1006 and 1015 are reserved for reporting, never sent.
      if (!Number.isInteger(code) || code < 1000 || code > 4999 || [1005, 1006, 1015].includes(code)) {
        throw new RangeError(
          `a close code must be one a server can send (1000-4999, not 1005, 1006 or 1015), got ${code}`,
        );
      }
      const socket = socketFor(connectionId);
      if (socket.readyState === CLOSING || socket.readyState === CLOSED) return false;
      const wasConnecting = socket.readyState === CONNECTING;
      clock.queueTask(() => (wasConnecting ? socket.fail() : socket.finishClose(code, reason)), 0);
      return true;
    },
  };
}

function refuse(name: string) {
  return class {
    constructor() {
      throw new TypeError(`${name}: the simulator has no network`);
    }
  };
}
