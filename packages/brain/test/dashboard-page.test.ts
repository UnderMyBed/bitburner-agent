// The dashboard's page (#93) in jsdom, against a stub API: it renders each part of the status, puts the brain's data in
// as text only, says when the brain can't be reached, and sends the switch.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, test } from "vitest";
import type { DashboardStatus } from "../src/dashboard/status.ts";

const PAGE = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8");
const NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);

const STATUS: DashboardStatus = {
  nowMs: NOW_MS,
  environment: "E0",
  brainRelease: "v0.2.0",
  brainStartedAtMs: NOW_MS - 3_600_000,
  agent: {
    connected: true,
    sinceMs: NOW_MS - 600_000,
    agentSessionId: "session-1",
    deploymentId: "abc123def456",
    game: { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" },
    versionDrift: null,
  },
  tiers: {
    static: { receivedAtMs: NOW_MS - 600_000, ageMs: 600_000 },
    slow: { receivedAtMs: NOW_MS - 30_000, ageMs: 30_000 },
    medium: { receivedAtMs: NOW_MS - 4_000, ageMs: 4_000 },
    fast: null,
  },
  values: {
    money: 1234567,
    hackingLevel: 42,
    homeRamUsed: 4.7,
    homeMaxRam: 8,
    homeScripts: 2,
    pageHeapUsedBytes: 250 * 1024 * 1024,
    degradedTiers: ["static"],
  },
  gaps: {
    sinceMs: NOW_MS - 86_400_000,
    untilMs: NOW_MS,
    thresholdMs: 6_000,
    count: 1_800,
    longestIntervalMs: 100_000,
    gaps: [{ fromMs: NOW_MS - 500_000, toMs: NOW_MS - 400_000, lengthMs: 100_000 }],
  },
  alerts: [{ name: "deployFailed", sinceMs: NOW_MS - 60_000, detail: "agent.js needs 4.7 GB" }],
  events: [
    {
      atMs: NOW_MS - 1_000,
      kind: "connectionRejected",
      detail: { reason: "origin", detail: '<img src=x onerror="hacked()">' },
    },
    { atMs: NOW_MS - 2_000, kind: "agentConnected", detail: { agentSessionId: "session-1" } },
  ],
  supervision: { state: "running", paused: false, gaveUpAtMs: null, relaunches: [] },
};

interface Request {
  url: string;
  method: string;
  body: string | undefined;
}

const pages: JSDOM[] = [];
afterEach(() => {
  // Its 2 s poll would otherwise run on.
  for (const page of pages.splice(0)) page.window.close();
});

/** The page with `answer` as the brain's API; resolves once its first poll has rendered. */
async function openPage(answer: (request: Request) => { status: number; body: unknown } | "unreachable") {
  const requests: Request[] = [];
  const page = new JSDOM(PAGE, {
    runScripts: "dangerously",
    url: "http://127.0.0.1:12527/",
    beforeParse(window) {
      window.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
        const request = { url, method: init?.method ?? "GET", body: init?.body };
        requests.push(request);
        const reply = answer(request);
        if (reply === "unreachable") throw new TypeError("Failed to fetch");
        return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
      }) as unknown as typeof fetch;
    },
  });
  pages.push(page);
  await settle();
  return { document: page.window.document, requests };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const textOf = (document: Document, selector: string) => document.querySelector(selector)?.textContent ?? "";

test("it renders each part: alerts, the Agent, the tiers, the game, the gaps, supervision and the events", async () => {
  const { document } = await openPage(() => ({ status: 200, body: STATUS }));
  expect(document.body.classList.contains("unreachable")).toBe(false);
  expect(textOf(document, "#brain")).toContain("E0 · brain v0.2.0");
  expect(textOf(document, "#alerts")).toContain("deployFailed since");
  expect(textOf(document, "#alerts")).toContain("agent.js needs 4.7 GB");
  expect(textOf(document, "#agent")).toContain("Connectedyes");
  expect(textOf(document, "#agent")).toContain("abc123def456");
  expect(textOf(document, "#agent")).toContain("the pinned one");
  expect(textOf(document, "#tiers")).toContain("medium4.0 s ago");
  expect(textOf(document, "#tiers")).toContain("fastnone yet");
  expect(textOf(document, "#values")).toContain("$1,234,567");
  expect(textOf(document, "#values")).toContain("4.7 of 8 GB");
  expect(textOf(document, "#values")).toContain("250 MB");
  expect(textOf(document, "#values")).toContain("Degraded tiersstatic");
  expect(textOf(document, "#gaps")).toContain("1800 fast snapshots");
  expect(textOf(document, "#gaps")).toContain("(100 s)");
  expect(textOf(document, "#supervision")).toContain("Supervision: running");
  expect(textOf(document, "#supervision button")).toBe("Pause supervision");
  expect(document.querySelectorAll("#events tr")).toHaveLength(2);
});

test("the brain's data goes in as text, never as HTML", async () => {
  const { document } = await openPage(() => ({ status: 200, body: STATUS }));
  expect(document.querySelector("#events img")).toBeNull();
  expect(textOf(document, "#events")).toContain('<img src=x onerror=\\"hacked()\\">');
});

test("when the brain can't be reached, the page says so in place of the data", async () => {
  let reachable = true;
  const { document } = await openPage(() => (reachable ? { status: 200, body: STATUS } : "unreachable"));
  expect(document.body.classList.contains("unreachable")).toBe(false);
  reachable = false;
  // The next poll fails: the stale data is hidden behind the notice.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  expect(document.body.classList.contains("unreachable")).toBe(true);
  expect(textOf(document, "#unreachable")).toContain("Brain unreachable");
  const { document: neverReached } = await openPage(() => ({ status: 500, body: null }));
  expect(neverReached.body.classList.contains("unreachable")).toBe(true);
});

test("the button sends the switch, the other way from the status, then shows the new state", async () => {
  let current = STATUS;
  const { document, requests } = await openPage((request) => {
    if (request.method === "POST") {
      const { paused } = JSON.parse(request.body as string) as { paused: boolean };
      current = { ...STATUS, supervision: { ...STATUS.supervision, paused, state: paused ? "paused" : "running" } };
      return { status: 200, body: { paused } };
    }
    return { status: 200, body: current };
  });
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(requests.find((request) => request.method === "POST")).toEqual({
    url: "/api/supervision",
    method: "POST",
    body: '{"paused":true}',
  });
  expect(textOf(document, "#supervision")).toContain("Supervision: paused");
  expect(textOf(document, "#supervision button")).toBe("Resume supervision");
  // And back.
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
    '{"paused":true}',
    '{"paused":false}',
  ]);
  expect(textOf(document, "#supervision")).toContain("Supervision: running");
});
