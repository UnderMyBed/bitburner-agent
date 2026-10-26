// The live transport: a WebSocket server the game's page connects to (architecture §6). Bound to 127.0.0.1 only, and
// it refuses an upgrade from any origin it wasn't told to allow, since any web page can open a socket to localhost.
// Nothing a client sends can crash the brain: protocol violations close that connection, nothing more.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { Connection } from "./connection.ts";

const LOOPBACK_ADDRESS = "127.0.0.1";
/**
 * The largest frame accepted by default (the control channel), before or after hello: a static-tier snapshot (every
 * server's fixed fields) is well under a megabyte, so 16 MiB is headroom, not a limit the protocol meets. A larger frame
 * closes the connection (1009).
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * The Remote File API server's limit. Its largest frame is a `getSaveFile` reply: the gzip save as one JSON-escaped
 * character per byte, about 2.1 times its size. 128 MiB takes a save of about 60 MB gzipped.
 */
export const REMOTE_FILE_API_MAX_FRAME_BYTES = 128 * 1024 * 1024;
/** "Unsupported data": the standard close code for a binary frame, which the protocol doesn't use. */
const UNSUPPORTED_DATA_CODE = 1003;

export interface WebSocketServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Exact `Origin` header values: e.g. `file://` for Steam's page, `http://127.0.0.1:<port>` for E2. */
  allowedOrigins: string[];
  onConnection(connection: Connection): void;
  /** An upgrade refused for its origin (HTTP 403): `(none)` when there was no `Origin` header. */
  onRejectedOrigin(origin: string): void;
  /** The largest frame accepted; a larger one closes the connection (1009). Default `MAX_FRAME_BYTES`. */
  maxFrameBytes?: number;
}

export interface RunningWebSocketServer {
  port: number;
  /** Stops listening and closes every connection. Safe to call more than once. */
  close(): Promise<void>;
}

/** Listens on 127.0.0.1; rejects if the port can't be had (e.g. already in use). */
export async function startWebSocketServer(options: WebSocketServerOptions): Promise<RunningWebSocketServer> {
  const allowedOrigins = new Set(options.allowedOrigins);
  const httpServer = createServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain" }).end("WebSocket only");
  });
  const socketServer = new WebSocketServer({
    server: httpServer,
    maxPayload: options.maxFrameBytes ?? MAX_FRAME_BYTES,
    verifyClient: ({ req }: { req: IncomingMessage }, callback: (allowed: boolean, code?: number) => void) => {
      const origin = req.headers.origin ?? "(none)";
      if (allowedOrigins.has(origin)) return callback(true);
      callback(false, 403);
      reportSafely(() => options.onRejectedOrigin(origin));
    },
  });
  // The http server's errors are re-emitted here; while starting, `listen` below rejects on them.
  socketServer.on("error", () => {});
  socketServer.on("connection", (socket) => {
    // A protocol violation (bad UTF-8, an oversized or unmasked frame) is an error event; ws then closes the socket.
    socket.on("error", () => {});
    try {
      options.onConnection(asConnection(socket));
    } catch (error) {
      socket.terminate();
      reportSafely(() => {
        throw error;
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, LOOPBACK_ADDRESS, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  let closed: Promise<void> | null = null;
  return {
    port: (httpServer.address() as AddressInfo).port,
    close: () => {
      closed ??= (async () => {
        for (const client of socketServer.clients) client.terminate();
        await new Promise<void>((resolve) => socketServer.close(() => resolve()));
        await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
      })();
      return closed;
    },
  };
}

/** A callback's error, raised afterwards as an uncaught exception, so it can't break the socket handling around it. */
function reportSafely(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

function asConnection(socket: WebSocket): Connection {
  return {
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: (code, reason) => socket.close(code, reason),
    onMessage: (listener) =>
      socket.on("message", (data, isBinary) => {
        if (isBinary) socket.close(UNSUPPORTED_DATA_CODE, "binary frames aren't part of the protocol");
        else listener(data.toString());
      }),
    onClose: (listener) => socket.once("close", () => listener()),
  };
}
