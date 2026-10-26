// A client for the game's Remote File API (architecture §6): the game connects to the brain, and the brain sends it
// requests, JSON-RPC 2.0-like. Replies echo the request's `id` and may come out of order; an error is a plain string
// (game source: src/RemoteFileAPI/MessageHandlers.ts, Remote.ts:115-135). Every request is for home.
import type { Clock, TimerHandle } from "./clock.ts";
import type { Connection } from "./connection.ts";

export const RFA_REQUEST_TIMEOUT_MS = 30_000;
const HOME = "home";

/** A request that failed: the game's own error, no reply in time, or the connection closing. */
export class RfaError extends Error {
  constructor(request: string, problem: string) {
    super(`${request}: ${problem}`);
    this.name = "RfaError";
  }
}

interface PendingRequest {
  description: string;
  resolve(result: unknown): void;
  reject(error: RfaError): void;
  timer: TimerHandle;
}

export class RfaClient {
  readonly #connection: Connection;
  readonly #clock: Clock;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  constructor(connection: Connection, clock: Clock) {
    this.#connection = connection;
    this.#clock = clock;
    connection.onMessage((text) => this.#receive(text));
    connection.onClose(() => {
      this.#closed = true;
      for (const [id, request] of this.#pending) this.#settle(id, request, "the connection closed");
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

  #request(method: string, subject: string | null, params?: object): Promise<unknown> {
    const description = subject === null ? method : `${method} ${subject}`;
    if (this.#closed) return Promise.reject(new RfaError(description, "the connection closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        const request = this.#pending.get(id);
        if (request) this.#settle(id, request, `no reply within ${RFA_REQUEST_TIMEOUT_MS / 1000} s`);
      }, RFA_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { description, resolve, reject, timer });
      this.#connection.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    });
  }

  #receive(text: string): void {
    let reply: { id?: unknown; result?: unknown; error?: unknown };
    try {
      reply = JSON.parse(text);
    } catch {
      return;
    }
    // A reply to a request that timed out, or to none: nothing waits for it.
    const request = typeof reply.id === "number" ? this.#pending.get(reply.id) : undefined;
    if (!request) return;
    if (typeof reply.error === "string") this.#settle(reply.id as number, request, reply.error);
    else this.#settle(reply.id as number, request, null, reply.result);
  }

  #settle(id: number, request: PendingRequest, problem: string | null, result?: unknown): void {
    this.#pending.delete(id);
    this.#clock.clearTimeout(request.timer);
    if (problem === null) request.resolve(result);
    else request.reject(new RfaError(request.description, problem));
  }
}

function expectString(description: string, result: unknown): string {
  if (typeof result !== "string") throw new RfaError(description, `unexpected reply ${JSON.stringify(result)}`);
  return result;
}
