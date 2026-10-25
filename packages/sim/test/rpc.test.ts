import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { HostMessage, ParentMessage } from "../src/protocol.ts";
import { RpcClient } from "../src/rpc.ts";

type Request = Extract<ParentMessage, { type: "request" }>;

/** Stands in for a child process: records sent requests; the test replies, fails sends, or ends the process. */
class FakeChild extends EventEmitter {
  sent: Request[] = [];
  sendError: Error | null = null;
  send(message: ParentMessage, callback: (error: Error | null) => void): boolean {
    if (message.type === "request") this.sent.push(message);
    queueMicrotask(() => callback(this.sendError));
    return true;
  }
  reply(message: HostMessage): void {
    this.emit("message", message);
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

function client(output = "") {
  const child = new FakeChild();
  return { child, rpc: new RpcClient(child, () => output) };
}
const idOf = (child: FakeChild, i: number) => child.sent[i]?.id ?? -1;

describe("RpcClient", () => {
  test("matches responses to requests by id, in any order", async () => {
    const { child, rpc } = client();
    const first = rpc.call("now", {});
    const second = rpc.call("advance", { ms: 5 });
    expect(idOf(child, 0)).not.toBe(idOf(child, 1));
    child.reply({ type: "response", id: idOf(child, 1), ok: true, result: 2 });
    child.reply({ type: "response", id: idOf(child, 0), ok: true, result: 1 });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  test("ignores messages that aren't responses", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.reply({ type: "ready" });
    child.reply({ type: "response", id: idOf(child, 0), ok: true, result: 7 });
    await expect(call).resolves.toBe(7);
  });

  test("rejects with the host's error message", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.reply({ type: "response", id: idOf(child, 0), ok: false, error: { message: "boom" } });
    await expect(call).rejects.toThrow("boom");
  });

  test("rejects pending calls with the exit code and the output tail when the process closes", async () => {
    const { child, rpc } = client("…\nFATAL: out of cheese");
    const call = rpc.call("advance", { ms: 1 });
    child.close(3);
    await expect(call).rejects.toThrow(/exited with code 3[\s\S]*FATAL: out of cheese/);
  });

  test("reports a signal when the process is killed", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.close(null, "SIGKILL");
    await expect(call).rejects.toThrow(/killed by SIGKILL/);
  });

  test("rejects calls made after the process closed", async () => {
    const { child, rpc } = client();
    child.close(0);
    await expect(rpc.call("now", {})).rejects.toThrow(/exited with code 0/);
  });

  test("rejects the call, without throwing, when the message can't be delivered", async () => {
    const { child, rpc } = client();
    child.sendError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    await expect(rpc.call("now", {})).rejects.toThrow(/Could not send now[\s\S]*EPIPE/);
  });

  test("an error event on the process rejects pending and later calls", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.emit("error", new Error("spawn failed"));
    await expect(call).rejects.toThrow(/failed: spawn failed/);
    await expect(rpc.call("now", {})).rejects.toThrow(/failed: spawn failed/);
  });
});
