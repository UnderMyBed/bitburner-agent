// The Remote File API client (#91): requests to the game's RFA handlers, replies matched by id.
import { beforeEach, expect, test } from "vitest";
import { RFA_REQUEST_TIMEOUT_MS, RfaClient, RfaError } from "../src/rfa-client.ts";
import { ManualClock, MemoryConnection } from "./helpers/fakes.ts";

let clock: ManualClock;
let connection: MemoryConnection;
let client: RfaClient;

beforeEach(() => {
  clock = new ManualClock();
  connection = new MemoryConnection();
  client = new RfaClient(connection, clock);
});

const requests = () =>
  connection.sent.map((text) => JSON.parse(text) as { id: number; method: string; params?: object });
/** A reply as the game sends it (`RFAMessage`, `Remote.ts:134`). */
const reply = (id: number, fields: { result?: unknown; error?: string }) =>
  connection.receive(JSON.stringify({ jsonrpc: "2.0", id, ...fields }));

test("each request is JSON-RPC with its own id, for home", async () => {
  void client.pushFile("agent/x/agent.js", "export function main() {}");
  void client.calculateRam("agent/x/agent.js");
  void client.getDefinitionFile();
  expect(requests()).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "pushFile",
      params: { server: "home", filename: "agent/x/agent.js", content: "export function main() {}" },
    },
    { jsonrpc: "2.0", id: 2, method: "calculateRam", params: { server: "home", filename: "agent/x/agent.js" } },
    { jsonrpc: "2.0", id: 3, method: "getDefinitionFile" },
  ]);
});

test("replies are matched by id, in whatever order they come", async () => {
  const names = client.getFileNames();
  const ram = client.calculateRam("a.js");
  reply(2, { result: 2.6 });
  reply(1, { result: ["a.js", "b.txt"] });
  expect(await ram).toBe(2.6);
  expect(await names).toEqual(["a.js", "b.txt"]);
});

test("the game's error, a plain string, is raised as an RfaError naming the method", async () => {
  const deleted = client.deleteFile("agent/x/agent.js");
  reply(1, { error: "Cannot delete a script that is currently running!" });
  await expect(deleted).rejects.toThrow(RfaError);
  await expect(deleted).rejects.toThrow(
    "deleteFile agent/x/agent.js: Cannot delete a script that is currently running!",
  );
});

test("getFile gives null for a file that isn't there, and the content of one that is", async () => {
  const missing = client.getFile("agent/current.txt");
  const present = client.getFile("agent/boot.js");
  reply(1, { error: "File does not exist. Filename: agent/current.txt" });
  reply(2, { result: "boot" });
  expect(await missing).toBeNull();
  expect(await present).toBe("boot");
});

test("a request with no reply in 30 s fails, and a late reply is ignored", async () => {
  const ram = client.calculateRam("a.js");
  clock.advance(RFA_REQUEST_TIMEOUT_MS - 1);
  reply(99, { result: 1 });
  clock.advance(1);
  await expect(ram).rejects.toThrow("calculateRam a.js: no reply within 30 s");
  reply(1, { result: 2.6 });
});

test("closing fails every request still waiting, and any made after", async () => {
  const names = client.getFileNames();
  connection.dropFromGameSide();
  await expect(names).rejects.toThrow("getFileNames: the connection closed");
  await expect(client.getDefinitionFile()).rejects.toThrow("getDefinitionFile: the connection closed");
});

test("a reply of the wrong type for the method is an error, not a value", async () => {
  const ram = client.calculateRam("a.js");
  reply(1, { result: "lots" });
  await expect(ram).rejects.toThrow('calculateRam a.js: unexpected reply "lots"');
});
