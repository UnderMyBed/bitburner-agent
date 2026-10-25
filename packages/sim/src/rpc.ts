import type { EventEmitter } from "node:events";
import {
  describeExit,
  type HostMessage,
  type Method,
  type Params,
  type ParentMessage,
  type Result,
} from "./protocol.ts";

/** The parts of a ChildProcess the client uses (a fake in unit tests). */
export interface ChildLike extends Pick<EventEmitter, "on"> {
  send(message: ParentMessage, callback: (error: Error | null) => void): boolean;
}

/**
 * Typed request/response calls to a host process. When the process ends, or a message can't be delivered, pending
 * calls fail with the reason and the tail of its combined stdout and stderr.
 */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private endReason: string | undefined;
  private readonly child: ChildLike;
  private readonly outputTail: () => string;

  constructor(child: ChildLike, outputTail: () => string) {
    this.child = child;
    this.outputTail = outputTail;
    child.on("message", (message: HostMessage) => {
      if (message?.type !== "response") return;
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.ok) call.resolve(message.result);
      else call.reject(Object.assign(new Error(message.error.message), { hostStack: message.error.stack }));
    });
    // "close" (not "exit") fires after the process's stdio has closed, so the output tail is complete.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => this.end(describeExit(code, signal)));
    // E.g. the process died before a message could be written to it.
    child.on("error", (error: Error) => this.end(`failed: ${error.message}`));
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.endReason) return Promise.reject(this.endError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.send({ type: "request", id, method, params }, (error) => {
        if (!error || !this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Could not send ${method} to the simulation process: ${error.message}`));
      });
    });
  }

  private end(reason: string): void {
    this.endReason ??= reason;
    const error = this.endError();
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  private endError(): Error {
    const tail = this.outputTail().trim();
    return new Error(`Simulation process ${this.endReason}${tail ? `. Last output:\n${tail}` : ""}`);
  }
}
