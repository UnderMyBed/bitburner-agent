// The live transport, on a random local port: loopback only, origins checked, frames both ways, and nothing a client
// sends can bring the brain down.
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import { CONTROL_CLOSE_CODES } from "@bitburner-agent/core";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { Connection } from "../src/connection.ts";
import { MAX_FRAME_BYTES, type RunningWebSocketServer, startWebSocketServer } from "../src/websocket-server.ts";

const ALLOWED_ORIGIN = "file://";
let server: RunningWebSocketServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<{ connections: Connection[]; rejectedOrigins: string[] }> {
  const connections: Connection[] = [];
  const rejectedOrigins: string[] = [];
  server = await startWebSocketServer({
    port: 0,
    allowedOrigins: [ALLOWED_ORIGIN],
    onConnection: (connection) => connections.push(connection),
    onRejectedOrigin: (origin) => rejectedOrigins.push(origin),
  });
  return { connections, rejectedOrigins };
}

const urlOf = (address = "127.0.0.1") => `ws://${address}:${server?.port}`;

async function openClient(): Promise<WebSocket> {
  const client = new WebSocket(urlOf(), { origin: ALLOWED_ORIGIN });
  await once(client, "open");
  return client;
}

test("an allowed origin connects, and text frames go both ways", async () => {
  const { connections } = await start();
  const client = await openClient();
  const connection = connections[0] as Connection;
  const fromClient = new Promise<string>((resolve) => connection.onMessage(resolve));
  client.send("from the page");
  expect(await fromClient).toBe("from the page");
  const fromServer = once(client, "message");
  connection.send("from the brain");
  expect(String((await fromServer)[0])).toBe("from the brain");
});

test("closing from the server reaches the page with its code, and the connection reports it closed", async () => {
  const { connections } = await start();
  const client = await openClient();
  const connection = connections[0] as Connection;
  const closedOnServer = new Promise<void>((resolve) => connection.onClose(resolve));
  const closedOnPage = once(client, "close");
  connection.close(CONTROL_CLOSE_CODES.replaced, "replaced");
  expect((await closedOnPage)[0]).toBe(CONTROL_CLOSE_CODES.replaced);
  await closedOnServer;
});

test.each([
  ["another origin", "https://example.com", "https://example.com"],
  ["no origin at all", undefined, "(none)"],
])("%s is refused with HTTP 403, and reported", async (_description, origin, reported) => {
  const { connections, rejectedOrigins } = await start();
  const client = new WebSocket(urlOf(), origin === undefined ? {} : { origin });
  const [, response] = (await once(client, "unexpected-response")) as [unknown, { statusCode: number }];
  expect(response.statusCode).toBe(403);
  expect(rejectedOrigins).toEqual([reported]);
  expect(connections).toEqual([]);
});

/** Sends something the protocol forbids, and checks the brain closes that connection and keeps serving others. */
async function expectClosedAndServerAlive(send: (client: WebSocket) => void, expectedCode: number): Promise<void> {
  const { connections } = await start();
  const client = await openClient();
  (connections[0] as Connection).onMessage(() => {});
  const closed = once(client, "close");
  client.on("error", () => {});
  send(client);
  expect((await closed)[0]).toBe(expectedCode);
  const another = await openClient();
  expect(another.readyState).toBe(WebSocket.OPEN);
}

test("a frame that isn't valid UTF-8 closes that connection (1007) and the server carries on", async () => {
  await expectClosedAndServerAlive((client) => client.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false }), 1007);
});

test("a binary frame closes that connection (1003)", async () => {
  await expectClosedAndServerAlive((client) => client.send(Buffer.from("{}"), { binary: true }), 1003);
});

test(`a frame over ${MAX_FRAME_BYTES / 1024 / 1024} MiB closes that connection (1009)`, async () => {
  await expectClosedAndServerAlive((client) => client.send("x".repeat(MAX_FRAME_BYTES + 1)), 1009);
});

test("a port that's taken is a rejection, not a crash", async () => {
  await start();
  await expect(
    startWebSocketServer({
      port: server?.port as number,
      allowedOrigins: [],
      onConnection: () => {},
      onRejectedOrigin: () => {},
    }),
  ).rejects.toThrow(/EADDRINUSE/);
});

test("closing twice is fine", async () => {
  await start();
  await server?.close();
  await server?.close();
});

const anotherIpv4Address = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;

test.skipIf(!anotherIpv4Address)("it listens on 127.0.0.1 only", async () => {
  await start();
  const client = new WebSocket(urlOf(anotherIpv4Address), { origin: ALLOWED_ORIGIN });
  const [error] = (await once(client, "error")) as [NodeJS.ErrnoException];
  expect(error.code).toBe("ECONNREFUSED");
});
