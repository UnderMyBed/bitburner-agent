// The dashboard's page (#93) in jsdom, against a stub API: it renders each part of the status, puts the brain's data in
// as text only, tells an unreachable brain from one that failed, and sends the switch. Two fixtures are the real
// status builder's output over a store, so the page is tested against what the brain sends.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastSnapshotData } from "@bitburner-agent/core";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, expect, test } from "vitest";
import { BRAIN_STARTED_EVENT_KIND, buildDashboardStatus, type DashboardStatus } from "../src/dashboard/status.ts";
import { RELAUNCH_EVENT_KIND, recordSupervisionGaveUp } from "../src/supervision.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const PAGE = readFileSync(new URL("../src/dashboard/page.html", import.meta.url), "utf8");
const NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);
const GAME = { version: "3.0.1", versionNumber: 51, commit: "1da7316ff", platform: "Steam" };

/** A status with something in every part: an alert, a gap, a tier with none yet, an event with HTML in it. */
const BUSY_STATUS: DashboardStatus = {
  nowMs: NOW_MS,
  environment: "E0",
  brainRelease: "v0.2.0",
  brainStartedAtMs: NOW_MS - 3_600_000,
  agent: {
    connected: true,
    sinceMs: NOW_MS - 600_000,
    agentSessionId: "session-1",
    deploymentId: "abc123def456",
    game: GAME,
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
    gapCount: 25,
    totalGapMs: 500_000,
    newestGaps: [{ fromMs: NOW_MS - 500_000, toMs: NOW_MS - 400_000, lengthMs: 100_000 }],
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
  hackLoop: { enabled: true, target: "n00dles" },
};

const directory = mkdtempSync(path.join(os.tmpdir(), "dashboard-page-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let storeCount = 0;

/** The real builder's status over a store `fill` sets up after the brain's start. */
function builtStatus(fill: (store: TelemetryStore, context: { environment: "E0"; release: string }) => void) {
  const store = TelemetryStore.open(path.join(directory, `telemetry-${++storeCount}.sqlite`));
  const context = { environment: "E0" as const, release: "v0.2.0+abc123def456" };
  const brainStartedAtMs = NOW_MS - 30_000;
  const brainStartedEventId = store.recordEvent(context, {
    atMs: brainStartedAtMs,
    kind: BRAIN_STARTED_EVENT_KIND,
    detail: {},
  });
  fill(store, context);
  const status = buildDashboardStatus({
    store,
    environment: "E0",
    brainRelease: "v0.2.0",
    brainStartedAtMs,
    brainStartedEventId,
    supervising: true,
    nowMs: NOW_MS,
  });
  store.close();
  return status;
}

/**
 * Healthy: the Agent connected and a heartbeat every 2 s since the brain started, so no alerts. A day of heartbeats is
 * too slow to store row by row here, so the gap report's result is the builder's, with its 24 h window already clear.
 */
const healthyStatus = (): DashboardStatus => {
  const built = builtStatus((store, context) => {
    store.recordEvent(context, {
      atMs: NOW_MS - 29_000,
      kind: "agentConnected",
      detail: { agentSessionId: "s", deploymentId: "abc123def456", game: GAME },
    });
    const fast: FastSnapshotData = { degradedTiers: [], pageHeapUsedBytes: null, game: null };
    for (let ageMs = 28_000; ageMs >= 0; ageMs -= 2_000) {
      store.recordSnapshot(context, {
        agentSessionId: "s",
        tier: "fast",
        sequenceNumber: NOW_MS - ageMs,
        gameTimeMs: NOW_MS - ageMs,
        receivedAtMs: NOW_MS - ageMs,
        missedBefore: 0,
        data: fast,
      });
    }
  });
  return { ...built, gaps: { ...built.gaps, gapCount: 0, totalGapMs: 0, newestGaps: [] } };
};

/** The supervisor gave up after relaunching; the Agent has gone, and nothing has been heard since. */
const gaveUpStatus = () =>
  builtStatus((store, context) => {
    store.recordEvent(context, { atMs: NOW_MS - 20_000, kind: RELAUNCH_EVENT_KIND, detail: { cause: "notRunning" } });
    recordSupervisionGaveUp(store, NOW_MS - 10_000);
  });

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
const isShown = (document: Document, selector: string) =>
  !(document.querySelector(selector) as HTMLElement | null)?.hidden;
/** The data is shown, and no problem: a render error would show here instead. */
const expectDataShown = (document: Document) => {
  expect(textOf(document, "#problem")).toBe("");
  expect(isShown(document, "main")).toBe(true);
};

test("a busy status: every part rendered, alerts, gaps, a tier with none yet", async () => {
  const { document } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
  expectDataShown(document);
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
  expect(textOf(document, "#gaps")).toContain("25 gaps, 500 s in all; the newest 1:");
  expect(textOf(document, "#gaps")).toContain("(100 s)");
  expect(textOf(document, "#supervision")).toContain("Supervision: running");
  expect(textOf(document, "#supervision button")).toBe("Pause supervision");
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: on, against n00dles");
  expect(textOf(document, "#hack-loop button")).toBe("Stop the hack loop");
  expect(document.querySelectorAll("#events tr")).toHaveLength(2);
});

test("a healthy brain, from the real builder: no alerts, no gaps", async () => {
  const status = healthyStatus();
  expect(status.alerts).toEqual([]);
  expect(status.gaps.gapCount).toBe(0);
  const { document } = await openPage(() => ({ status: 200, body: status }));
  expectDataShown(document);
  expect(textOf(document, "#alerts")).toContain("None.");
  expect(textOf(document, "#gaps")).toContain("No gaps.");
  expect(textOf(document, "#agent")).toContain("Connectedyes");
  expect(textOf(document, "#tiers")).toContain("mediumnone yet");
});

test("gave up, from the real builder: the Agent gone, a relaunch listed, and the switch offers Resume", async () => {
  const status = gaveUpStatus();
  expect(status.supervision.state).toBe("gaveUp");
  const { document, requests } = await openPage((request) =>
    request.method === "POST" ? { status: 200, body: { paused: false } } : { status: 200, body: status },
  );
  expectDataShown(document);
  expect(textOf(document, "#agent")).toContain("Connectedno");
  expect(textOf(document, "#alerts")).toContain("supervisionGaveUp");
  expect(textOf(document, "#supervision")).toContain("Supervision: gave up after too many relaunches");
  expect(textOf(document, "#supervision")).toContain("Relaunched");
  expect(textOf(document, "#supervision")).toContain('{"cause":"notRunning"}');
  // One click starts it again: resume, which clears the give-up.
  expect(textOf(document, "#supervision button")).toBe("Resume supervision");
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(requests.find((request) => request.method === "POST")?.body).toBe('{"paused":false}');
});

test("supervision off says so", async () => {
  const off: DashboardStatus = { ...BUSY_STATUS, supervision: { ...BUSY_STATUS.supervision, state: "off" } };
  const { document } = await openPage(() => ({ status: 200, body: off }));
  expectDataShown(document);
  expect(textOf(document, "#supervision")).toContain("Supervision: off: only a brain for Steam's game");
  expect(isShown(document, "#supervision button")).toBe(false);
});

test("the brain's data goes in as text, never as HTML", async () => {
  const { document } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
  expect(document.querySelector("#events img")).toBeNull();
  expect(textOf(document, "#events")).toContain('<img src=x onerror=\\"hacked()\\">');
});

test("when the brain can't be reached, the page says so and hides the data, which isn't current", async () => {
  let reachable = true;
  const { document } = await openPage(() => (reachable ? { status: 200, body: BUSY_STATUS } : "unreachable"));
  expectDataShown(document);
  reachable = false;
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  expect(textOf(document, "#problem")).toContain("Brain unreachable");
  expect(isShown(document, "main")).toBe(false);
});

test("a brain that answers with an error is told apart from one that can't be reached", async () => {
  const { document } = await openPage(() => ({ status: 500, body: null }));
  expect(textOf(document, "#problem")).toContain("The brain couldn't answer (HTTP 500)");
  expect(isShown(document, "main")).toBe(false);
});

test("a status the page can't render says so, rather than blaming the brain", async () => {
  const { document } = await openPage(() => ({ status: 200, body: { nonsense: true } }));
  expect(textOf(document, "#problem")).toContain("The dashboard couldn't show the brain's status");
  expect(isShown(document, "main")).toBe(false);
});

test("the button sends the switch, the other way from the status, then shows the new state", async () => {
  let current = BUSY_STATUS;
  const { document, requests } = await openPage((request) => {
    if (request.method === "POST") {
      const { paused } = JSON.parse(request.body as string) as { paused: boolean };
      current = {
        ...BUSY_STATUS,
        supervision: { ...BUSY_STATUS.supervision, paused, state: paused ? "paused" : "running" },
      };
      return { status: 200, body: { paused } };
    }
    return { status: 200, body: current };
  });
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(textOf(document, "#supervision")).toContain("Supervision: paused");
  expect(textOf(document, "#supervision button")).toBe("Resume supervision");
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
    '{"paused":true}',
    '{"paused":false}',
  ]);
  expect(textOf(document, "#supervision")).toContain("Supervision: running");
});

test("the hack loop's button (#134) sends its switch, the other way from the status, then shows the new state", async () => {
  let current = BUSY_STATUS;
  const { document, requests } = await openPage((request) => {
    if (request.method === "POST") {
      const { enabled } = JSON.parse(request.body as string) as { enabled: boolean };
      current = { ...BUSY_STATUS, hackLoop: { enabled, target: enabled ? "n00dles" : null } };
      return { status: 200, body: { enabled } };
    }
    return { status: 200, body: current };
  });
  (document.querySelector("#hack-loop button") as HTMLButtonElement).click();
  await settle();
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: off");
  expect(textOf(document, "#hack-loop button")).toBe("Start the hack loop");
  (document.querySelector("#hack-loop button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => [request.url, request.body])).toEqual(
    [
      ["/api/hack-loop", '{"enabled":false}'],
      ["/api/hack-loop", '{"enabled":true}'],
    ],
  );
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: on, against n00dles");
});

test("the hack loop on with no target yet says so", async () => {
  const waiting: DashboardStatus = { ...BUSY_STATUS, hackLoop: { enabled: true, target: null } };
  const { document } = await openPage(() => ({ status: 200, body: waiting }));
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: on, rooting servers; no target yet");
});

test("a hack loop switch the brain refuses says so, and the data stays", async () => {
  const { document } = await openPage((request) =>
    request.method === "POST" ? { status: 403, body: null } : { status: 200, body: BUSY_STATUS },
  );
  (document.querySelector("#hack-loop button") as HTMLButtonElement).click();
  await settle();
  expect(textOf(document, "#hack-loop-problem")).toBe("The switch didn't change: HTTP 403");
  expectDataShown(document);
});

test("a switch the brain refuses says so, and the data stays", async () => {
  const { document } = await openPage((request) =>
    request.method === "POST" ? { status: 403, body: null } : { status: 200, body: BUSY_STATUS },
  );
  (document.querySelector("#supervision button") as HTMLButtonElement).click();
  await settle();
  expect(textOf(document, "#switch-problem")).toBe("The switch didn't change: HTTP 403");
  expect(isShown(document, "#switch-problem")).toBe(true);
  expectDataShown(document);
});
