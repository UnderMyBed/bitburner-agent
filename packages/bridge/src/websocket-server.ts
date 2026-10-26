// The live transport: a WebSocket server the game's page connects to (architecture §6). Bound to 127.0.0.1 only, and
// it refuses an upgrade from any origin it wasn't told to allow, since any web page can open a socket to localhost.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { Connection } from "./connection.ts";

export const LOOPBACK_ADDRESS = "127.0.0.1";

export interface WebSocketServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Exact `Origin` header values: e.g. `file://` for Steam's page, `http://127.0.0.1:<port>` for E2. */
  allowedOrigins: string[];
  onConnection(connection: Connection): void;
  /** An upgrade refused for its origin (HTTP 403): `(none)` when there was no `Origin` header. */
  onRejectedOrigin(origin: string): void;
}

export interface RunningWebSocketServer {
  port: number;
  /** Stops listening and closes every connection. */
  close(): Promise<void>;
}

export async function startWebSocketServer(options: WebSocketServerOptions): Promise<RunningWebSocketServer> {
  const allowedOrigins = new Set(options.allowedOrigins);
  const httpServer = createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain" }).end("WebSocket only");
  });
  const socketServer = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ req }: { req: IncomingMessage }, callback: (allowed: boolean, code?: number) => void) => {
      const origin = req.headers.origin ?? "(none)";
      if (allowedOrigins.has(origin)) return callback(true);
      options.onRejectedOrigin(origin);
      callback(false, 403);
    },
  });
  socketServer.on("connection", (socket) => options.onConnection(asConnection(socket)));

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, LOOPBACK_ADDRESS, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  return {
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      for (const client of socketServer.clients) client.terminate();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function asConnection(socket: WebSocket): Connection {
  return {
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: (code, reason) => socket.close(code, reason),
    // Binary frames aren't part of the protocol: passed on as text, so the parser rejects them.
    onMessage: (listener) => socket.on("message", (data, isBinary) => listener(isBinary ? "" : data.toString())),
    onClose: (listener) => socket.once("close", () => listener()),
  };
}
