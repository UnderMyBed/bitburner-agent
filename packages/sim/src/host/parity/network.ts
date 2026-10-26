// The page's network (ADR 0012). The simulator stays offline: `fetch` fails as a browser's does with no connection,
// and `XMLHttpRequest` and `EventSource` refuse. WebSockets are the exception: a socket to a URL the parent listens on
// reaches the parent process, in lockstep with the virtual clock, so what a script sees never depends on real time.
import type { NetworkOutboxEntry } from "../../protocol.ts";
import type { VirtualClock } from "../clock.ts";
import { reportUncaughtException } from "./errors.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Events the page causes itself (an open, a refused connection, its own close) arrive this long after the call. */
const PAGE_EVENT_DELAY_MS = 1;
/** Close codes (RFC 6455 §7.4.1). */
const NORMAL_CLOSURE_CODE = 1000;
/** "No status received": a close event's code when the page closed without one. Never sent. */
const NO_STATUS_CODE = 1005;
/** "Abnormal closure": the code of a connection that failed. Never sent. */
const ABNORMAL_CLOSURE_CODE = 1006;
/** "TLS handshake failure". Never sent. */
const TLS_HANDSHAKE_CODE = 1015;
const MAX_CLOSE_REASON_BYTES = 123;

export interface SimulatedNetwork {
  /** Everything the page's sockets did since the last call, in order. */
  take(): NetworkOutboxEntry[];
  /**
   * A frame from the parent, due at the virtual now (after the socket's open if that's still to come). False if the
   * connection is closing or closed.
   */
  send(connectionId: number, data: string): boolean;
  /** A close from the parent, due at the virtual now. False if the connection is already closing or closed. */
  close(connectionId: number, code: number, reason: string): boolean;
}

/** What the harness keeps about a socket: none of it is visible to the page. */
interface Connection {
  socket: SimulatedWebSocket;
  connectionId: number;
  /** When the open is due: a frame from the parent never arrives before it, as a server can't send first. */
  opensAtMs: number;
  /** The parent has closed it, though the close hasn't reached the page yet. */
  closedByParent: boolean;
  /** Puts what the page did into the parent's outbox. */
  sendToParent(entry: OutboxEntryBody): void;
  /** Completes the page's own close, a task later: a failure if it hadn't opened, a clean close otherwise. */
  scheduleOwnClose(wasConnecting: boolean, code: number, reason: string): void;
}

/** What goes into the outbox, before its connection and time are stamped on. */
type OutboxEntryBody = NetworkOutboxEntry extends infer Entry
  ? Entry extends NetworkOutboxEntry
    ? Omit<Entry, "connectionId" | "atMs">
    : never
  : never;

/** The harness's way into a socket's private state, set up by the class's static block. */
let readyStateOf: (socket: SimulatedWebSocket) => number;
let setReadyState: (socket: SimulatedWebSocket, state: number) => void;
/** Registers the socket being constructed with the network (`installNetwork`; one per process). */
let openConnection: (socket: SimulatedWebSocket, url: string) => Connection;

const notSupported = (what: string) => new TypeError(`WebSocket ${what} is not supported in the simulator (ADR 0012)`);

/** WebIDL's [Clamp] unsigned short, as Chromium converts `close`'s code: clamped, then rounded half to even. */
function clampToUnsignedShort(value: unknown): number {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  const clamped = Math.min(65535, Math.max(0, number));
  const floor = Math.floor(clamped);
  const fraction = clamped - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * A browser WebSocket, for what the game's RFA client and the Agent use (text frames, events, states), with the parent
 * at the other end. Harness state lives off the instance (`Connection`), so a script sees only what a browser shows.
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
  #readyState = CONNECTING;
  #connection: Connection;
  /** `onopen` and friends: the handler set now, per type. */
  readonly #handlers = new Map<string, ((event: Event) => unknown) | null>();
  /** Each listener a script added, and the wrapper registered for it, per type. */
  readonly #wrappedListeners = new Map<string, Map<unknown, (event: Event) => void>>();

  static {
    readyStateOf = (socket) => socket.#readyState;
    setReadyState = (socket, state) => {
      socket.#readyState = state;
    };
  }

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    if (protocols !== undefined && !(Array.isArray(protocols) && protocols.length === 0)) {
      throw notSupported("sub-protocols");
    }
    // As the WHATWG spec Chromium follows: resolved against the page's URL, http(s) taken as ws(s), any other scheme
    // or a fragment a SyntaxError.
    const parsed = URL.parse(String(url), window.location.href);
    if (!parsed) {
      throw new DOMException(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`, "SyntaxError");
    }
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new DOMException(
        `Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${parsed.protocol.slice(0, -1)}' is not allowed.`,
        "SyntaxError",
      );
    }
    if (parsed.href.includes("#")) {
      throw new DOMException(
        `Failed to construct 'WebSocket': The URL contains a fragment identifier ('${parsed.hash}'). Fragment identifiers are not allowed in WebSocket URLs.`,
        "SyntaxError",
      );
    }
    this.url = parsed.href;
    this.#connection = openConnection(this, this.url);
  }

  get readyState(): number {
    return this.#readyState;
  }

  get binaryType(): string {
    return "blob";
  }

  set binaryType(value: string) {
    if (value !== "blob") throw notSupported(`binaryType "${value}"`);
  }

  /** No sub-protocol was asked for, so none was chosen. */
  get protocol(): string {
    return "";
  }

  get extensions(): string {
    return "";
  }

  /** Frames leave at once (into the parent's outbox), so nothing is ever buffered. */
  get bufferedAmount(): number {
    return 0;
  }

  send(data: unknown): void {
    if (this.#readyState === CONNECTING) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        "InvalidStateError",
      );
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
      throw notSupported("binary frames");
    }
    // Anything else is a USVString to WebIDL: sent as its text.
    const text = String(data);
    // A browser discards a frame sent once closing has begun.
    if (this.#readyState !== OPEN) return;
    this.#connection.sendToParent({ type: "message", data: text });
  }

  close(code?: unknown, reason?: unknown): void {
    const closeCode = code === undefined ? undefined : clampToUnsignedShort(code);
    if (closeCode !== undefined && closeCode !== NORMAL_CLOSURE_CODE && !(closeCode >= 3000 && closeCode <= 4999)) {
      throw new DOMException(
        `Failed to execute 'close' on 'WebSocket': The close code must be either ${NORMAL_CLOSURE_CODE}, or between 3000 and 4999. ${closeCode} is neither.`,
        "InvalidAccessError",
      );
    }
    const reasonText = reason === undefined ? "" : String(reason);
    if (new TextEncoder().encode(reasonText).length > MAX_CLOSE_REASON_BYTES) {
      throw new DOMException(
        `Failed to execute 'close' on 'WebSocket': The close reason must not be greater than ${MAX_CLOSE_REASON_BYTES} UTF-8 bytes.`,
        "SyntaxError",
      );
    }
    if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
    // A reason needs a code on the wire: the browser sends 1000 with it.
    const sentCode = closeCode ?? (reasonText === "" ? undefined : NORMAL_CLOSURE_CODE);
    const wasConnecting = this.#readyState === CONNECTING;
    this.#readyState = CLOSING;
    this.#connection.sendToParent({ type: "close", code: sentCode ?? null, reason: reasonText });
    this.#connection.scheduleOwnClose(wasConnecting, sentCode ?? NO_STATUS_CODE, reasonText);
  }

  /**
   * Listeners are called as a browser calls them: with `this` the socket, an exception reported as uncaught at once,
   * and a returned promise left alone (a rejection is then an unhandled rejection, as in a browser). Node's own
   * EventTarget would report both later, and as uncaught exceptions.
   */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (listener === null) return;
    const wrappers = this.#wrappedListeners.get(type) ?? new Map<unknown, (event: Event) => void>();
    this.#wrappedListeners.set(type, wrappers);
    let wrapper = wrappers.get(listener);
    if (!wrapper) {
      wrapper = (event: Event) => {
        try {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent(event);
        } catch (error) {
          reportUncaughtException(error);
        }
      };
      wrappers.set(listener, wrapper);
    }
    super.addEventListener(type, wrapper, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    const wrapper = this.#wrappedListeners.get(type)?.get(listener);
    if (wrapper) super.removeEventListener(type, wrapper, options);
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

/** Cuts the page off from the network, except for sockets to `listenUrls`. Call once, before the engine loads. */
export function installNetwork(clock: VirtualClock, listenUrls: string[]): SimulatedNetwork {
  const listening = new Set(listenUrls.map((url) => new URL(url).href));
  /** Sockets not yet closed; a closed one is dropped, so a run that reconnects for ever doesn't grow. */
  const connections = new Map<number, Connection>();
  let outbox: NetworkOutboxEntry[] = [];
  let lastConnectionId = 0;

  /** Closes a socket for good, firing its events, and lets the harness forget it. */
  const finish = (connection: Connection, events: Event[]) => {
    if (readyStateOf(connection.socket) === CLOSED) return;
    setReadyState(connection.socket, CLOSED);
    connections.delete(connection.connectionId);
    for (const event of events) connection.socket.dispatchEvent(event);
  };
  /** The connection failed (refused, or closed before it opened): error, then close 1006, in one task. */
  const fail = (connection: Connection) =>
    finish(connection, [
      new Event("error"),
      new CloseEvent("close", { code: ABNORMAL_CLOSURE_CODE, reason: "", wasClean: false }),
    ]);
  const closeCleanly = (connection: Connection, code: number, reason: string) =>
    finish(connection, [new CloseEvent("close", { code, reason, wasClean: true })]);

  openConnection = (socket, url) => {
    const connectionId = ++lastConnectionId;
    const isListening = listening.has(url);
    const connection: Connection = {
      socket,
      connectionId,
      opensAtMs: clock.now() + PAGE_EVENT_DELAY_MS,
      closedByParent: false,
      // A refused socket never reached the parent, so nothing it does goes there either.
      sendToParent: (entry) => {
        if (isListening) outbox.push({ connectionId, atMs: clock.now(), ...entry } as NetworkOutboxEntry);
      },
      scheduleOwnClose: (wasConnecting, code, reason) =>
        clock.queueTask(
          () => (wasConnecting ? fail(connection) : closeCleanly(connection, code, reason)),
          PAGE_EVENT_DELAY_MS,
        ),
    };
    connections.set(connectionId, connection);
    if (isListening) {
      connection.sendToParent({ type: "connect", url });
      clock.queueTask(() => {
        if (readyStateOf(socket) !== CONNECTING) return;
        setReadyState(socket, OPEN);
        socket.dispatchEvent(new Event("open"));
      }, PAGE_EVENT_DELAY_MS);
    } else {
      clock.queueTask(() => fail(connection), PAGE_EVENT_DELAY_MS);
    }
    return connection;
  };

  const pageNetworkGlobals = {
    fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    XMLHttpRequest: refuse("XMLHttpRequest"),
    WebSocket: SimulatedWebSocket,
    EventSource: refuse("EventSource"),
  };
  Object.assign(globalThis, pageNetworkGlobals);
  Object.assign(window, pageNetworkGlobals);

  /** A connection the parent may still use, or null once it's closing or closed. Throws for an id never handed out. */
  const usableConnection = (connectionId: number): Connection | null => {
    if (!Number.isInteger(connectionId) || connectionId < 1 || connectionId > lastConnectionId) {
      throw new RangeError(`no connection ${connectionId}: the page never opened one with that id`);
    }
    const connection = connections.get(connectionId);
    if (!connection || connection.closedByParent) return null;
    const state = readyStateOf(connection.socket);
    return state === CLOSING || state === CLOSED ? null : connection;
  };

  return {
    take: () => {
      const taken = outbox;
      outbox = [];
      return taken;
    },
    send: (connectionId, data) => {
      if (typeof data !== "string") throw new RangeError(`a frame from the parent must be text, got ${typeof data}`);
      const connection = usableConnection(connectionId);
      if (!connection) return false;
      clock.queueTask(
        () => {
          if (readyStateOf(connection.socket) !== OPEN) return;
          const origin = new URL(connection.socket.url).origin;
          connection.socket.dispatchEvent(new MessageEvent("message", { data, origin }));
        },
        Math.max(0, connection.opensAtMs - clock.now()),
      );
      return true;
    },
    close: (connectionId, code, reason) => {
      // A code a server can send (RFC 6455 §7.4.1): the reserved ones only ever report what happened.
      const reserved = [NO_STATUS_CODE, ABNORMAL_CLOSURE_CODE, TLS_HANDSHAKE_CODE];
      if (!Number.isInteger(code) || code < NORMAL_CLOSURE_CODE || code > 4999 || reserved.includes(code)) {
        throw new RangeError(
          `a close code must be one a server can send (1000-4999, not ${reserved.join(", ")}), got ${code}`,
        );
      }
      if (typeof reason !== "string" || new TextEncoder().encode(reason).length > MAX_CLOSE_REASON_BYTES) {
        throw new RangeError(`a close reason must be text of at most ${MAX_CLOSE_REASON_BYTES} UTF-8 bytes`);
      }
      const connection = usableConnection(connectionId);
      if (!connection) return false;
      connection.closedByParent = true;
      const wasConnecting = readyStateOf(connection.socket) === CONNECTING;
      clock.queueTask(() => (wasConnecting ? fail(connection) : closeCleanly(connection, code, reason)), 0);
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
