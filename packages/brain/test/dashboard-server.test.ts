// The dashboard's server (#93) on a random local port: the page, the status, the switch, and the Host and Origin
// checks that keep other pages (and DNS rebinding) out.
import { request } from "node:http";
import { afterEach, expect, test } from "vitest";
import { type RunningDashboardServer, startDashboardServer } from "../src/dashboard/server.ts";

let server: RunningDashboardServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const STATUS = { nowMs: 1, alerts: [] };

async function start({ status = () => STATUS as never }: { status?: () => never } = {}) {
  const pausedCalls: boolean[] = [];
  const errors: unknown[] = [];
  server = await startDashboardServer({
    port: 0,
    status,
    setSupervisionPaused: (paused) => pausedCalls.push(paused),
    onError: (error) => errors.push(error),
  });
  return { port: server.port, pausedCalls, errors };
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so the test controls the Host and Origin headers exactly. */
function send(
  port: number,
  {
    method = "GET",
    path = "/",
    headers = {},
    body,
  }: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

const sameOrigin = (port: number) => ({ origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });

test("the page and the status, from 127.0.0.1 or localhost", async () => {
  const { port } = await start();
  const page = await send(port, {});
  expect(page.status).toBe(200);
  expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(page.body).toContain("<title>bitburner-agent</title>");
  // Not framed by another page (the pause button), and never cached.
  expect(page.headers["x-frame-options"]).toBe("DENY");
  expect(page.headers["cache-control"]).toBe("no-store");
  const status = await send(port, { path: "/api/status", headers: { host: `localhost:${port}` } });
  expect(status.status).toBe(200);
  expect(JSON.parse(status.body)).toEqual(STATUS);
});

test("it listens on 127.0.0.1 only", async () => {
  const { port } = await start();
  expect(server?.address).toBe("127.0.0.1");
  expect(port).toBeGreaterThan(0);
});

test.each([
  ["a foreign host (DNS rebinding)", "attacker.example:80"],
  ["the right port on another name", "example.com:PORT"],
  ["no port", "127.0.0.1"],
])("a request with %s as Host is refused, 403", async (_description, host) => {
  const { port } = await start();
  const reply = await send(port, { path: "/api/status", headers: { host: host.replace("PORT", String(port)) } });
  expect(reply.status).toBe(403);
  expect(reply.body).not.toContain("nowMs");
});

test("POST /api/supervision sets the switch, from the dashboard's own page", async () => {
  const { port, pausedCalls } = await start();
  const paused = await send(port, {
    method: "POST",
    path: "/api/supervision",
    headers: sameOrigin(port),
    body: JSON.stringify({ paused: true }),
  });
  expect(paused.status).toBe(200);
  expect(JSON.parse(paused.body)).toEqual({ paused: true });
  await send(port, {
    method: "POST",
    path: "/api/supervision",
    headers: { ...sameOrigin(port), origin: `http://localhost:${port}`, host: `localhost:${port}` },
    body: JSON.stringify({ paused: false }),
  });
  expect(pausedCalls).toEqual([true, false]);
});

test.each([
  ["another origin", { origin: "https://attacker.example" }],
  ["no origin", { origin: "" }],
  ["the right host on another port", { origin: "http://127.0.0.1:1" }],
])("a POST from %s is refused, and the switch isn't touched", async (_description, override) => {
  const { port, pausedCalls } = await start();
  const headers: Record<string, string> = { ...sameOrigin(port), ...override };
  if (headers.origin === "") delete headers.origin;
  const reply = await send(port, { method: "POST", path: "/api/supervision", headers, body: '{"paused":true}' });
  expect(reply.status).toBe(403);
  expect(pausedCalls).toEqual([]);
});

test.each([
  ["not JSON", "paused"],
  ["no paused field", "{}"],
  ["paused not a boolean", '{"paused":"yes"}'],
  ["another field too", '{"paused":true,"other":1}'],
  // A valid switch, but padded past 1 KiB: refused for its length alone.
  ["too long", `{"paused":true${" ".repeat(2_000)}}`],
])("a switch body that's %s is refused, 400", async (_description, body) => {
  const { port, pausedCalls } = await start();
  const reply = await send(port, { method: "POST", path: "/api/supervision", headers: sameOrigin(port), body });
  expect(reply.status).toBe(400);
  expect(pausedCalls).toEqual([]);
});

test("other paths are 404, other methods 405", async () => {
  const { port } = await start();
  expect((await send(port, { path: "/nothing" })).status).toBe(404);
  expect((await send(port, { method: "DELETE", path: "/api/status", headers: sameOrigin(port) })).status).toBe(405);
  expect((await send(port, { method: "GET", path: "/api/supervision" })).status).toBe(405);
});

test("a status that fails is a 500, reported, and the server carries on", async () => {
  let calls = 0;
  const { port, errors } = await start({
    status: () => {
      calls++;
      if (calls === 1) throw new Error("the store is locked");
      return STATUS as never;
    },
  });
  expect((await send(port, { path: "/api/status" })).status).toBe(500);
  expect(errors).toEqual([new Error("the store is locked")]);
  expect((await send(port, { path: "/api/status" })).status).toBe(200);
});
