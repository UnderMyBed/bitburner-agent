// The dashboard's server (#93, architecture §7): one page and a JSON API, on 127.0.0.1 only (owner decision 20). Any
// web page can reach localhost, so it also refuses a Host header that isn't its own (DNS rebinding) and a write from
// any page but its own.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DashboardStatus } from "./status.ts";

const LOOPBACK_ADDRESS = "127.0.0.1";
/** The switch's body is `{"paused":true}`; anything much longer isn't one. */
const MAX_BODY_BYTES = 1024;
const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");

export interface DashboardServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Built afresh for each request. */
  status(): DashboardStatus;
  setSupervisionPaused(paused: boolean): void;
  /** A request that failed on the brain's side (a 500): the brain logs it. The server carries on. */
  onError(error: unknown): void;
}

export interface RunningDashboardServer {
  /** The address it's bound to, as the system reports it: always 127.0.0.1. */
  address: string;
  port: number;
  close(): Promise<void>;
}

class RequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<RunningDashboardServer> {
  let ownHosts = new Set<string>();
  let ownOrigins = new Set<string>();
  const httpServer = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof RequestError) return reply(response, error.statusCode, "text/plain", error.message);
      options.onError(error);
      reply(response, 500, "text/plain", "the brain couldn't answer: see its log");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!ownHosts.has(request.headers.host ?? "")) throw new RequestError(403, "not this dashboard's host");
    const route = `${request.method} ${new URL(request.url ?? "/", "http://dashboard").pathname}`;
    switch (route) {
      case "GET /":
        return reply(response, 200, "text/html; charset=utf-8", PAGE);
      case "GET /api/status":
        return reply(response, 200, "application/json", JSON.stringify(options.status()));
      case "POST /api/supervision": {
        if (!ownOrigins.has(request.headers.origin ?? "")) throw new RequestError(403, "not this dashboard's page");
        const paused = pausedOf(await readBody(request));
        options.setSupervisionPaused(paused);
        return reply(response, 200, "application/json", JSON.stringify({ paused }));
      }
      default:
        if (["/", "/api/status", "/api/supervision"].some((path) => route.endsWith(` ${path}`))) {
          throw new RequestError(405, "method not allowed");
        }
        throw new RequestError(404, "not found");
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, LOOPBACK_ADDRESS, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const { address, port } = httpServer.address() as AddressInfo;
  ownHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  ownOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  let closed: Promise<void> | null = null;
  return {
    address,
    port,
    close: () => {
      closed ??= new Promise((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
      return closed;
    },
  };
}

function reply(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The pause button mustn't be clickable through another page's frame.
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new RequestError(400, "the body is too long");
  }
  return body;
}

/** `{ "paused": true|false }`, exactly. */
function pausedOf(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestError(400, "the body isn't JSON");
  }
  const fields = parsed as { paused?: unknown } | null;
  const isSwitch =
    typeof fields === "object" &&
    fields !== null &&
    Object.keys(fields).join() === "paused" &&
    typeof fields.paused === "boolean";
  if (!isSwitch) throw new RequestError(400, 'the body must be {"paused": true} or {"paused": false}');
  return fields.paused as boolean;
}
