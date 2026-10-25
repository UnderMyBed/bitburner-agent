import type { EventEmitter } from "node:events";
import type { Method, Params, Request, Response, Result } from "./protocol.ts";

/** The parts of a ChildProcess the client uses (a fake in unit tests). */
export interface ChildLike extends Pick<EventEmitter, "on"> {
  send(message: Request): boolean;
}

/** Typed request/response calls to a host process. Pending calls fail with the process's stderr if it exits. */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private exitReason: string | undefined;
  private readonly child: ChildLike;
  private readonly outputTail: () => string;

  constructor(child: ChildLike, outputTail: () => string) {
    this.child = child;
    this.outputTail = outputTail;
    child.on("message", (message: Response) => {
      if (typeof message !== "object" || message === null || !("id" in message)) return;
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.ok) call.resolve(message.result);
      else call.reject(Object.assign(new Error(message.error.message), { hostStack: message.error.stack }));
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitReason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      const error = this.exitError();
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    });
  }

  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    if (this.exitReason) return Promise.reject(this.exitError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.send({ id, method, params });
    });
  }

  private exitError(): Error {
    const tail = this.outputTail().trim();
    return new Error(`Simulation process ${this.exitReason}${tail ? `. Last output:\n${tail}` : ""}`);
  }
}
