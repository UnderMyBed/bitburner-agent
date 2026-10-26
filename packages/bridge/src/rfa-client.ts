// A client for the game's Remote File API (architecture §6): the game connects to the brain, and the brain sends it
// requests, JSON-RPC 2.0-like. Replies echo the request's `id` and may come out of order; an error is a plain string
// (game source: src/RemoteFileAPI/MessageHandlers.ts, Remote.ts:115-135). Every request is for home.
import type { Clock, TimerHandle } from "./clock.ts";
import type { Connection } from "./connection.ts";

export const RFA_REQUEST_TIMEOUT_MS = 30_000;
const HOME = "home";

/**
 * A request that failed: `game`, the game's own error (or a reply of the wrong type); `timeout`, no reply in time (the
 * game sends none when a handler throws, Remote.ts:127-134); `closed`, the connection closed.
 */
export class RfaError extends Error {
  readonly kind: "game" | "timeout" | "closed";

  constructor(request: string, problem: string, kind: RfaError["kind"] = "game") {
    super(`${request}: ${problem}`);
    this.name = "RfaError";
    this.kind = kind;
  }
}

interface PendingRequest {
  description: string;
  resolve(result: unknown): void;
  reject(error: RfaError): void;
  timer: TimerHandle;
}

/** What `getSaveFile` gives: the game's own save, from the serialiser the Steam save uses (MessageHandlers.ts). */
export interface GameSaveFile {
  identifier: string;
  /** True on Steam: `save` is the gzip bytes, one character per byte. False on a page without CompressionStream. */
  binary: boolean;
  save: string;
}

/**
 * The next request id on each connection. Ids are unique per connection, not per client, so several clients can share
 * one (the deployer and the save backups): each takes only the replies to its own requests.
 */
const nextIdByConnection = new WeakMap<Connection, number>();

export class RfaClient {
  readonly #connection: Connection;
  readonly #clock: Clock;
  readonly #pending = new Map<number, PendingRequest>();
  #closed = false;

  constructor(connection: Connection, clock: Clock) {
    this.#connection = connection;
    this.#clock = clock;
    connection.onMessage((text) => this.#receive(text));
    connection.onClose(() => {
      this.#closed = true;
      for (const [id, request] of this.#pending) this.#settle(id, request, "the connection closed", "closed");
    });
  }

  async pushFile(filename: string, content: string): Promise<void> {
    await this.#request("pushFile", filename, { server: HOME, filename, content });
  }

  /** The file's content, or null if it isn't there. */
  async getFile(filename: string): Promise<string | null> {
    try {
      return expectString(`getFile ${filename}`, await this.#request("getFile", filename, { server: HOME, filename }));
    } catch (error) {
      // MessageHandlers.ts, getFile: "File does not exist. Filename: …".
      if (error instanceof RfaError && error.message.includes(": File does not exist.")) return null;
      throw error;
    }
  }

  /** The game refuses to delete a running script's file. */
  async deleteFile(filename: string): Promise<void> {
    await this.#request("deleteFile", filename, { server: HOME, filename });
  }

  async getFileNames(): Promise<string[]> {
    const result = await this.#request("getFileNames", null, { server: HOME });
    if (!Array.isArray(result) || !result.every((name) => typeof name === "string")) {
      throw new RfaError("getFileNames", `unexpected reply ${JSON.stringify(result)}`);
    }
    return result;
  }

  /** The script's static RAM, by the calculator `run` uses. */
  async calculateRam(filename: string): Promise<number> {
    const result = await this.#request("calculateRam", filename, { server: HOME, filename });
    if (typeof result !== "number")
      throw new RfaError(`calculateRam ${filename}`, `unexpected reply ${JSON.stringify(result)}`);
    return result;
  }

  /** The game's `NetscriptDefinitions.d.ts`. */
  async getDefinitionFile(): Promise<string> {
    return expectString("getDefinitionFile", await this.#request("getDefinitionFile", null));
  }

  /** The game's save, as Steam writes it (`binary`) or as base64 text (a page without CompressionStream). */
  async getSaveFile(): Promise<GameSaveFile> {
    const result = await this.#request("getSaveFile", null);
    const { identifier, binary, save } = (result ?? {}) as Partial<GameSaveFile>;
    if (typeof identifier !== "string" || typeof binary !== "boolean" || typeof save !== "string") {
      throw new RfaError("getSaveFile", `unexpected reply ${JSON.stringify(result).slice(0, 200)}`);
    }
    return { identifier, binary, save };
  }

  #request(method: string, subject: string | null, params?: object): Promise<unknown> {
    const description = subject === null ? method : `${method} ${subject}`;
    if (this.#closed) return Promise.reject(new RfaError(description, "the connection closed", "closed"));
    const id = nextIdByConnection.get(this.#connection) ?? 1;
    nextIdByConnection.set(this.#connection, id + 1);
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        const request = this.#pending.get(id);
        if (request) this.#settle(id, request, `no reply within ${RFA_REQUEST_TIMEOUT_MS / 1000} s`, "timeout");
      }, RFA_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { description, resolve, reject, timer });
      this.#connection.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    });
  }

  #receive(text: string): void {
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      return;
    }
    // Nothing a client sends may crash the brain: a frame that isn't a reply object is ignored.
    if (typeof reply !== "object" || reply === null) return;
    const { id, result, error } = reply as { id?: unknown; result?: unknown; error?: unknown };
    // A reply to a request that timed out, or to none: nothing waits for it.
    const request = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (!request) return;
    if (typeof error === "string") this.#settle(id as number, request, error, "game");
    else this.#settle(id as number, request, null, "game", result);
  }

  #settle(id: number, request: PendingRequest, problem: string | null, kind: RfaError["kind"], result?: unknown): void {
    this.#pending.delete(id);
    this.#clock.clearTimeout(request.timer);
    if (problem === null) request.resolve(result);
    else request.reject(new RfaError(request.description, problem, kind));
  }
}

function expectString(description: string, result: unknown): string {
  if (typeof result !== "string") throw new RfaError(description, `unexpected reply ${JSON.stringify(result)}`);
  return result;
}
