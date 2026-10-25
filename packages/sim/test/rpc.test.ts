import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { Request, Response } from "../src/protocol.ts";
import { RpcClient } from "../src/rpc.ts";

/** Stands in for a child process: records sent requests; the test replies or exits. */
class FakeChild extends EventEmitter {
  sent: Request[] = [];
  send(message: Request): boolean {
    this.sent.push(message);
    return true;
  }
  reply(response: Response): void {
    this.emit("message", response);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function client(stderr = "") {
  const child = new FakeChild();
  return { child, rpc: new RpcClient(child, () => stderr) };
}

describe("RpcClient", () => {
  test("matches responses to requests by id, in any order", async () => {
    const { child, rpc } = client();
    const first = rpc.call("now", {});
    const second = rpc.call("advance", { ms: 5 });
    const [a, b] = child.sent;
    expect(a?.id).not.toBe(b?.id);
    child.reply({ id: b?.id ?? -1, ok: true, result: 2 });
    child.reply({ id: a?.id ?? -1, ok: true, result: 1 });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  test("rejects with the host's error message", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.reply({ id: child.sent[0]?.id ?? -1, ok: false, error: { message: "boom", stack: "Error: boom\n at host" } });
    await expect(call).rejects.toThrow("boom");
  });

  test("rejects pending calls with the exit code and the stderr tail when the process exits", async () => {
    const { child, rpc } = client("…\nFATAL: out of cheese");
    const call = rpc.call("advance", { ms: 1 });
    child.exit(3);
    await expect(call).rejects.toThrow(/exited with code 3[\s\S]*FATAL: out of cheese/);
  });

  test("reports a signal when the process is killed", async () => {
    const { child, rpc } = client();
    const call = rpc.call("now", {});
    child.exit(null, "SIGKILL");
    await expect(call).rejects.toThrow(/SIGKILL/);
  });

  test("rejects calls made after the process exited", async () => {
    const { child, rpc } = client();
    child.exit(0);
    await expect(rpc.call("now", {})).rejects.toThrow(/exited/);
  });
});
