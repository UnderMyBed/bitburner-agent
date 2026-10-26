// The live transport, on a random local port: loopback only, origins checked, and frames both ways.
import { once } from "node:events";
import { networkInterfaces } from "node:os";
import { CONTROL_CLOSE_CODES } from "@bitburner-agent/core";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { Connection } from "../src/connection.ts";
import { type RunningWebSocketServer, startWebSocketServer } from "../src/websocket-server.ts";

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

test("an allowed origin connects, and text frames go both ways", async () => {
  const { connections } = await start();
  const client = new WebSocket(urlOf(), { origin: ALLOWED_ORIGIN });
  await once(client, "open");
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
  const client = new WebSocket(urlOf(), { origin: ALLOWED_ORIGIN });
  await once(client, "open");
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

test("it listens on 127.0.0.1 only", async () => {
  await start();
  const otherAddress = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && address.family === "IPv4" && !address.internal)?.address;
  // A machine with no other IPv4 address has nothing else to try.
  if (!otherAddress) return;
  const client = new WebSocket(urlOf(otherAddress), { origin: ALLOWED_ORIGIN });
  const [error] = (await once(client, "error")) as [NodeJS.ErrnoException];
  expect(error.code).toBe("ECONNREFUSED");
});
