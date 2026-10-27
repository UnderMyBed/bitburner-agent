// The dashboard's server (#93, architecture §7): one page and a JSON API, on 127.0.0.1 only (owner decision 14). Any
// web page can reach localhost, so it also refuses a Host header that isn't its own (DNS rebinding), any request
// another site's page makes (so none can make the brain build status over and over), and a write from any other page.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DashboardStatus } from "./status.ts";

const LOOPBACK_ADDRESS = "127.0.0.1";
/** The switch's body is `{"paused":true}`; anything much longer isn't one. */
const MAX_BODY_BYTES = 1024;
/** What a browser says about a request's origin (Fetch Metadata): only these are the dashboard's own, or typed in. */
const OWN_FETCH_SITES = new Set(["same-origin", "none"]);
const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");

export interface DashboardServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Built afresh for each request. */
  status(): DashboardStatus;
  setSupervisionPaused(paused: boolean): void;
  /** The hack loop's switch (#134). */
  setHackLoopEnabled(enabled: boolean): void;
  /** The hacking programs' switch (#136). */
  setProgramsEnabled(enabled: boolean): void;
  /** A failure on the brain's side (a 500, or the server's own error): the brain logs it. The server carries on. */
  onError(error: unknown): void;
}

export interface RunningDashboardServer {
  /** The address it's bound to, as the system reports it: always 127.0.0.1. */
  address: string;
  port: number;
  close(): Promise<void>;
}

/** A request refused for what the client sent: answered with its status code, and not the brain's failure. */
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
      // The client went away (mid-body, say): nobody to answer, and nothing for the brain to log.
      if (response.headersSent || response.destroyed) return;
      if (error instanceof RequestError) {
        reply(response, error.statusCode, "text/plain", error.message, { closeConnection: error.statusCode === 413 });
        return;
      }
      options.onError(error);
      reply(response, 500, "text/plain", "the brain couldn't answer: see its log");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!ownHosts.has(request.headers.host ?? "")) throw new RequestError(403, "not this dashboard's host");
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite !== undefined && !OWN_FETCH_SITES.has(String(fetchSite))) {
      throw new RequestError(403, "not from this dashboard's page");
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !ownOrigins.has(origin)) throw new RequestError(403, "not this dashboard's page");
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://dashboard").pathname;
    } catch {
      throw new RequestError(400, "not a valid path");
    }
    const route = `${request.method} ${path}`;
    switch (route) {
      case "GET /":
        return reply(response, 200, "text/html; charset=utf-8", PAGE);
      case "GET /api/status":
        return reply(response, 200, "application/json", JSON.stringify(options.status()));
      case "POST /api/supervision":
        return handleSwitch(request, response, origin, "paused", options.setSupervisionPaused);
      case "POST /api/hack-loop":
        return handleSwitch(request, response, origin, "enabled", options.setHackLoopEnabled);
      case "POST /api/programs":
        return handleSwitch(request, response, origin, "enabled", options.setProgramsEnabled);
      default:
        if (["/", "/api/status", "/api/supervision", "/api/hack-loop", "/api/programs"].includes(path)) {
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
  // From here on, a server error (say, out of file handles) is reported, never an uncaught exception.
  httpServer.on("error", options.onError);
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

function reply(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  { closeConnection = false }: { closeConnection?: boolean } = {},
): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The pause button mustn't be clickable through another page's frame.
    "X-Frame-Options": "DENY",
    ...(closeConnection ? { Connection: "close" } : {}),
  });
  response.end(body);
}

/** At most `MAX_BODY_BYTES`, refused up front when the length is declared. */
async function readBody(request: IncomingMessage): Promise<string> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES)
    throw new RequestError(413, "the body is too long");
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += (chunk as Buffer).length;
    if (byteCount > MAX_BODY_BYTES) throw new RequestError(413, "the body is too long");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A switch: `{ "<field>": true|false }` from the dashboard's own page, answered with the same. */
async function handleSwitch(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  field: "paused" | "enabled",
  apply: (value: boolean) => void,
): Promise<void> {
  // A write must say it's from the dashboard's own page: a missing Origin isn't enough.
  if (origin === undefined) throw new RequestError(403, "not this dashboard's page");
  const value = switchValueOf(await readBody(request), field);
  apply(value);
  reply(response, 200, "application/json", JSON.stringify({ [field]: value }));
}

/** A switch's body: `{ "<field>": true|false }`, exactly. */
function switchValueOf(body: string, field: "paused" | "enabled"): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestError(400, "the body isn't JSON");
  }
  const fields = parsed as Record<string, unknown> | null;
  const isSwitch =
    typeof fields === "object" &&
    fields !== null &&
    Object.keys(fields).join() === field &&
    typeof fields[field] === "boolean";
  if (!isSwitch) throw new RequestError(400, `the body must be {"${field}": true} or {"${field}": false}`);
  return fields[field] as boolean;
}
