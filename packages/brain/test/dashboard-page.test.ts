// The dashboard's page (#93) in jsdom, against a stub API: it renders each part of the status, puts the brain's data in
// as text only, tells an unreachable brain from one that failed, and sends the switch. Two fixtures are the real
// status builder's output over a store, so the page is tested against what the brain sends.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLASS_LOCATION_NAMES,
  CLASS_LOCATIONS,
  CLASS_TYPE_NAMES,
  CLASS_TYPES,
  CRIME_NAMES,
  type FastSnapshotData,
  INTENT_ACTIONS,
  JOB_FIELDS,
} from "@bitburner-agent/core";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, test } from "vitest";
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
  hackLoop: {
    enabled: true,
    waiting: false,
    target: "n00dles",
    hosts: ["foodnstuff", "joesguns", "n00dles"],
    hackThreads: null,
    preparing: null,
  },
  programs: {
    enabled: true,
    waiting: false,
    owned: ["TOR router", "BruteSSH.exe"],
    buying: null,
    waitingFor: "money for FTPCrack.exe ($1,500,000)",
  },
  homeRam: { enabled: true, waiting: false, ram: 8, upgradingTo: null, waitingFor: "FTPCrack.exe first (cheaper)" },
  intents: [
    {
      id: "travel(Aevum)",
      source: "manual",
      outcome: { id: "travel(Aevum)", done: false, tries: 2, problem: "no Travel", backend: "ui" },
      waitingFor: null,
    },
    { id: "buyTor(Alpha Enterprises)", source: "purchase", outcome: null, waitingFor: null },
  ],
  work: {
    desired: { kind: "faction", faction: "CyberSec", workType: "hacking", focus: true },
    outcome: { converged: false, problem: "no CyberSec among the factions joined", backend: "ui" },
  },
  factions: {
    receivedAtMs: NOW_MS - 30_000,
    backend: "ui",
    state: {
      joined: [
        { name: "CyberSec", reputation: 12345.678, favor: 1.234 },
        { name: "Sector-12", reputation: 0.4, favor: 0 },
      ],
      invitations: ["Aevum"],
      queuedAugmentations: ["Neurotrainer I", "NeuroFlux Governor", "NeuroFlux Governor"],
    },
    problem: null,
  },
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
    hackLoop: { enabled: true, waiting: true, target: null, hosts: [], hackThreads: null, preparing: null },
    programs: { enabled: true, waiting: true, owned: [], buying: null, waitingFor: null },
    homeRam: { enabled: true, waiting: true, ram: null, upgradingTo: null, waitingFor: null },
    intents: [],
    work: { desired: null, outcome: null },
    income: null,
    backdoorsDue: [],
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
    const fast: FastSnapshotData = {
      degradedTiers: [],
      pageHeapUsedBytes: null,
      game: null,
      intents: [],
      dialogs: { handled: [], blocking: null },
    };
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
async function openPage(
  answer: (request: Request) => { status: number; body: unknown; text?: string } | "unreachable",
) {
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
        return {
          ok: reply.status < 400,
          status: reply.status,
          json: async () => reply.body,
          text: async () => reply.text ?? "",
        };
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
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: on, against n00dles, on 3 servers");
  expect(textOf(document, "#hack-loop button")).toBe("Stop the hack loop");
  expect(textOf(document, "#programs")).toContain("Hacking programs: waiting for money for FTPCrack.exe ($1,500,000)");
  expect(textOf(document, "#programs")).toContain("Owned: TOR router, BruteSSH.exe");
  expect(textOf(document, "#programs button")).toBe("Stop buying programs");
  expect(textOf(document, "#home-ram")).toContain("Home RAM: waiting for FTPCrack.exe first (cheaper)");
  expect(textOf(document, "#home-ram")).toContain("Home: 8 GB");
  expect(textOf(document, "#home-ram button")).toBe("Stop upgrading home RAM");
  expect([...document.querySelectorAll("#intents tr")].map((row) => row.textContent)).toEqual([
    "travel(Aevum)manual2 tries via ui: no TravelCancel",
    "buyTor(Alpha Enterprises)purchasenot reported yet",
  ]);
  expect(document.querySelectorAll("#events tr")).toHaveLength(2);
  // The faction state (#197): each faction's reputation and favour, the invitations, the queue counted.
  expect(textOf(document, "#factions")).toContain("via ui.");
  expect([...document.querySelectorAll("#factions tr")].map((row) => row.textContent)).toEqual([
    "CyberSec12,346 rep1.23 favour",
    "Sector-120 rep0 favour",
  ]);
  expect(textOf(document, "#factions")).toContain("Invitations: Aevum");
  expect(textOf(document, "#factions")).toContain("Queued augmentations: Neurotrainer I, NeuroFlux Governor ×2");
  expect(textOf(document, "#factions")).not.toContain("Couldn't be read");
});

test("the faction state unread (#197): why, in red, and nothing in place of the state", async () => {
  const status: DashboardStatus = {
    ...BUSY_STATUS,
    factions: { receivedAtMs: NOW_MS, backend: "ui", state: null, problem: "no game page to read it through" },
  };
  const { document } = await openPage(() => ({ status: 200, body: status }));
  expectDataShown(document);
  const problem = [...document.querySelectorAll("#factions div div")].find((each) =>
    each.textContent?.startsWith("Couldn't be read"),
  );
  expect(problem?.textContent).toBe("Couldn't be read: no game page to read it through");
  expect(problem?.className).toBe("bad");
  expect(textOf(document, "#factions")).not.toContain("Invitations");
  expect(document.querySelectorAll("#factions tr")).toHaveLength(0);
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
  expect(textOf(document, "#factions")).toContain("No slow snapshot yet.");
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
  expect(textOf(document, "#supervision")).toContain("Supervision: gave up (the supervisionGaveUp alert says why)");
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
      current = {
        ...BUSY_STATUS,
        hackLoop: enabled
          ? BUSY_STATUS.hackLoop
          : { enabled, waiting: false, target: null, hosts: [], hackThreads: null, preparing: null },
      };
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
  expect(textOf(document, "#hack-loop")).toContain("Hack loop: on, against n00dles, on 3 servers");
});

test.each([
  [
    "waiting for the Agent's snapshots",
    { enabled: true, waiting: true, target: null, hosts: [], hackThreads: null, preparing: null },
    "on, waiting for the Agent's snapshots",
  ],
  [
    "no target yet",
    { enabled: true, waiting: false, target: null, hosts: [], hackThreads: null, preparing: null },
    "on, rooting servers; no target yet",
  ],
  [
    "preparing the next target (#184)",
    {
      enabled: true,
      waiting: false,
      target: "n00dles",
      hosts: ["foodnstuff", "joesguns", "n00dles"],
      hackThreads: null,
      preparing: { target: "zer0", hosts: ["max-hardware", "omega-net"], hackThreads: null },
    },
    "on, against n00dles, on 3 servers; preparing zer0 on 2 servers",
  ],
  [
    "with each host's hack threads (#187)",
    {
      enabled: true,
      waiting: false,
      target: "max-hardware",
      hosts: ["foodnstuff", "joesguns", "n00dles"],
      hackThreads: 96,
      preparing: { target: "phantasy", hosts: ["omega-net"], hackThreads: 16 },
    },
    "on, against max-hardware, on 3 servers, hacking with at most 96 threads; preparing phantasy on 1 servers, " +
      "hacking with at most 16 threads",
  ],
])("the hack loop on, %s, says so", async (_description, hackLoop, text) => {
  const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, hackLoop } }));
  expect(textOf(document, "#hack-loop")).toContain(`Hack loop: ${text}`);
});

test.each([
  ["supervision", "#supervision button", "#supervision-problem"],
  ["hack loop", "#hack-loop button", "#hack-loop-problem"],
  ["hacking programs", "#programs button", "#programs-problem"],
  ["home RAM", "#home-ram button", "#home-ram-problem"],
])("a %s switch the brain refuses says so under its button, and the data stays", async (_name, button, problem) => {
  const { document } = await openPage((request) =>
    request.method === "POST" ? { status: 403, body: null } : { status: 200, body: BUSY_STATUS },
  );
  (document.querySelector(button) as HTMLButtonElement).click();
  await settle();
  expect(textOf(document, problem)).toBe("The switch didn't change: HTTP 403");
  expect(isShown(document, problem)).toBe(true);
  expectDataShown(document);
});

test("the hacking programs' button (#136) sends its switch, and each state reads plainly", async () => {
  let current = BUSY_STATUS;
  const { document, requests } = await openPage((request) => {
    if (request.method === "POST") {
      const { enabled } = JSON.parse(request.body as string) as { enabled: boolean };
      current = { ...BUSY_STATUS, programs: { ...BUSY_STATUS.programs, enabled, waitingFor: null } };
      return { status: 200, body: { enabled } };
    }
    return { status: 200, body: current };
  });
  (document.querySelector("#programs button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => [request.url, request.body])).toEqual(
    [["/api/programs", '{"enabled":false}']],
  );
  expect(textOf(document, "#programs")).toContain("Hacking programs: not buying");
  expect(textOf(document, "#programs button")).toBe("Start buying programs");
  (document.querySelector("#programs button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
    '{"enabled":false}',
    '{"enabled":true}',
  ]);
});

test.each([
  ["buying one", { buying: "TOR router" }, "buying TOR router"],
  ["all bought", { waitingFor: null }, "all bought"],
  ["waiting for the Agent", { waiting: true }, "waiting for the Agent's snapshots"],
])("the hacking programs, %s, say so", async (_description, changes, text) => {
  const programs = { ...BUSY_STATUS.programs, ...changes };
  const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, programs } }));
  expect(textOf(document, "#programs")).toContain(`Hacking programs: ${text}`);
});

test("home RAM's button (#138) sends its switch, and each state reads plainly", async () => {
  let current = BUSY_STATUS;
  const { document, requests } = await openPage((request) => {
    if (request.method === "POST") {
      const { enabled } = JSON.parse(request.body as string) as { enabled: boolean };
      current = { ...BUSY_STATUS, homeRam: { ...BUSY_STATUS.homeRam, enabled, waitingFor: null } };
      return { status: 200, body: { enabled } };
    }
    return { status: 200, body: current };
  });
  (document.querySelector("#home-ram button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => [request.url, request.body])).toEqual(
    [["/api/home-ram", '{"enabled":false}']],
  );
  expect(textOf(document, "#home-ram")).toContain("Home RAM: not upgrading");
  expect(textOf(document, "#home-ram button")).toBe("Start upgrading home RAM");
  (document.querySelector("#home-ram button") as HTMLButtonElement).click();
  await settle();
  expect(requests.filter((request) => request.method === "POST").map((request) => request.body)).toEqual([
    '{"enabled":false}',
    '{"enabled":true}',
  ]);
});

test.each([
  ["upgrading", { upgradingTo: 16, waitingFor: null }, "upgrading to 16 GB"],
  ["at its limit", { ram: 1_073_741_824, waitingFor: null }, "at its limit"],
  ["waiting for the Agent", { waiting: true, ram: null }, "waiting for the Agent's snapshots"],
])("home RAM, %s, says so", async (_description, changes, text) => {
  const homeRam = { ...BUSY_STATUS.homeRam, ...changes };
  const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, homeRam } }));
  expect(textOf(document, "#home-ram")).toContain(`Home RAM: ${text}`);
});

describe("the intents (#141)", () => {
  /** The page with a brain that takes every write, and answers the status as it was. */
  const openAcceptingPage = () =>
    openPage((request) => (request.method === "POST" ? { status: 200, body: {} } : { status: 200, body: BUSY_STATUS }));
  const posts = (requests: Request[]) =>
    requests.filter((request) => request.method === "POST").map((request) => [request.url, request.body]);

  test("the form queues an intent: its action and JSON arguments", async () => {
    const { document, requests } = await openAcceptingPage();
    const form = document.querySelector("#intents form") as HTMLFormElement;
    (form.elements.namedItem("action") as HTMLSelectElement).value = "travel";
    (form.elements.namedItem("args") as HTMLInputElement).value = '{"city": "Volhaven"}';
    form.requestSubmit();
    await settle();
    expect(posts(requests)).toEqual([["/api/intents", '{"action":"travel","args":{"city":"Volhaven"}}']]);
  });

  test("arguments that aren't JSON are refused on the page, and nothing is sent", async () => {
    const { document, requests } = await openAcceptingPage();
    const form = document.querySelector("#intents form") as HTMLFormElement;
    (form.elements.namedItem("args") as HTMLInputElement).value = "{city: Volhaven";
    form.requestSubmit();
    await settle();
    expect(posts(requests)).toEqual([]);
    expect(textOf(document, "#intents-problem")).toBe("The arguments aren't JSON");
  });

  test("a manual intent's Cancel sends its id; a purchase has no Cancel", async () => {
    const { document, requests } = await openAcceptingPage();
    expect(document.querySelectorAll("#intents button")).toHaveLength(2);
    (document.querySelector("#intents tr button") as HTMLButtonElement).click();
    await settle();
    expect(posts(requests)).toEqual([["/api/intents/cancel", '{"id":"travel(Aevum)"}']]);
  });

  test("one the brain refuses says why, under the form", async () => {
    const { document } = await openPage((request) =>
      request.method === "POST"
        ? { status: 400, body: null, text: "travel's city isn't one of the six" }
        : { status: 200, body: BUSY_STATUS },
    );
    (document.querySelector("#intents form") as HTMLFormElement).requestSubmit();
    await settle();
    expect(textOf(document, "#intents-problem")).toBe("Not queued: HTTP 400: travel's city isn't one of the six");
  });

  test.each([
    ["done", { id: "x", done: true, tries: 1, problem: null, backend: "singularity" }, "done via singularity"],
    [
      "done, with a problem on the way",
      { id: "x", done: true, tries: 1, problem: "no Terminal", backend: "ui" },
      "done via ui (no Terminal)",
    ],
    ["tried once", { id: "x", done: false, tries: 1, problem: null, backend: "sim" }, "1 try via sim"],
    [
      "from an Agent that doesn't name its backend",
      { id: "x", done: false, tries: 1, problem: null, backend: null },
      "1 try",
    ],
  ])("an outcome %s reads plainly", async (_description, outcome, text) => {
    const intents = [{ id: "x", source: "manual", outcome, waitingFor: null }];
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, intents } }));
    expect(textOf(document, "#intents td:nth-child(3)")).toBe(text);
  });

  test("an irreversible intent not yet sent (#147) says what it waits for", async () => {
    const intents = [
      { id: "x", source: "manual", outcome: null, waitingFor: "held: Sector-12's enemy Chongqing is joined" },
    ];
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, intents } }));
    expect(textOf(document, "#intents td:nth-child(3)")).toBe("not sent: held: Sector-12's enemy Chongqing is joined");
  });

  test("the queue form offers every action an intent can name (#147)", async () => {
    const { document } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
    const options = [...document.querySelectorAll("#intents select[name=action] option")].map(
      (option) => option.textContent,
    );
    expect([...options].sort()).toEqual([...INTENT_ACTIONS].sort());
  });

  test("none sent says so", async () => {
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, intents: [] } }));
    expect(textOf(document, "#intents table")).toBe("None.");
  });
});

describe("work (#151)", () => {
  test("the work managed reads plainly, with the Agent's outcome; none says the game's work is left alone", async () => {
    const { document } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
    expect(textOf(document, "#work div")).toBe(
      "hacking work for CyberSec, focused: not converged via ui (no CyberSec among the factions joined)",
    );
    const unmanaged = await openPage(() => ({
      status: 200,
      body: { ...BUSY_STATUS, work: { desired: null, outcome: null } },
    }));
    expect(textOf(unmanaged.document, "#work div")).toBe("Not managed: the game's work is left as it is.");
  });

  test("company work reads plainly too (#153)", async () => {
    const work = {
      desired: { kind: "company", company: "Noodle Bar", field: "Waiter", focus: false },
      outcome: { converged: true, problem: null, backend: "ui" },
    };
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, work } }));
    expect(textOf(document, "#work div")).toBe("Waiter work at Noodle Bar, unfocused: converged via ui");
  });

  test("company work with a promotion taken reads it too (#155)", async () => {
    const promotion = { company: "Carmichael Security", from: "IT Intern", to: "IT Analyst", gameTimeMs: 5_000 };
    const work = {
      desired: { kind: "company", company: "Carmichael Security", field: "IT", focus: true },
      outcome: { converged: true, problem: null, backend: "ui", promotion },
    };
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, work } }));
    expect(textOf(document, "#work div")).toBe(
      "IT work at Carmichael Security, focused: converged via ui; promoted from IT Intern to IT Analyst",
    );
  });

  test("the company form offers the game's job fields, in order, Waiter first chosen as Noodle Bar's (#153)", async () => {
    const { document } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
    const field = document.querySelector("#company-work select[name=field]") as HTMLSelectElement;
    expect([...field.options].map((option) => option.textContent)).toEqual(Object.keys(JOB_FIELDS));
    expect(field.value).toBe("Waiter");
  });

  test("crime reads plainly too, and its form offers the game's crimes, in order (#156)", async () => {
    const work = {
      desired: { kind: "crime", crime: "Grand Theft Auto", focus: true },
      outcome: { converged: false, problem: 'no "Grand Theft Auto" at the Slums', backend: "ui" },
    };
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, work } }));
    expect(textOf(document, "#work div")).toBe(
      'Grand Theft Auto, focused: not converged via ui (no "Grand Theft Auto" at the Slums)',
    );
    const crime = document.querySelector("#crime-work select[name=crime]") as HTMLSelectElement;
    expect([...crime.options].map((option) => option.textContent)).toEqual(CRIME_NAMES);
  });

  test("a class reads plainly, and its form offers the game's universities and gyms, and its classes (#158)", async () => {
    const work = (classType: string) => ({
      desired: { kind: "class", location: "Iron Gym", classType, focus: false },
      outcome: { converged: true, problem: null, backend: "ui" },
    });
    const { document } = await openPage(() => ({ status: 200, body: { ...BUSY_STATUS, work: work("dex") } }));
    expect(textOf(document, "#work div")).toBe("Dexterity training at Iron Gym, unfocused: converged via ui");
    const location = document.querySelector("#class-work select[name=location]") as HTMLSelectElement;
    expect([...location.options].map((option) => option.value)).toEqual(CLASS_LOCATION_NAMES);
    expect([...location.options].map((option) => option.textContent)).toEqual(
      CLASS_LOCATION_NAMES.map((name) => `${name} (${CLASS_LOCATIONS[name]?.city})`),
    );
    expect(location.value).toBe("Rothman University");
    const classType = document.querySelector("#class-work select[name=classType]") as HTMLSelectElement;
    expect([...classType.options].map((option) => [option.value, option.textContent])).toEqual(
      CLASS_TYPE_NAMES.map((name) => [name, CLASS_TYPES[name]?.name]),
    );
    const { document: course } = await openPage(() => ({
      status: 200,
      body: {
        ...BUSY_STATUS,
        work: { ...work("Networks"), desired: { ...work("Networks").desired, location: "Rothman University" } },
      },
    }));
    expect(textOf(course, "#work div")).toBe("Networks at Rothman University, unfocused: converged via ui");
  });

  test("the forms set faction, company, crime or class work, and the stop button stops managing it", async () => {
    const { document, requests } = await openPage(() => ({ status: 200, body: BUSY_STATUS }));
    const form = document.querySelector("#faction-work") as HTMLFormElement;
    (form.elements.namedItem("faction") as HTMLInputElement).value = "NiteSec";
    (form.elements.namedItem("workType") as HTMLSelectElement).value = "field";
    form.requestSubmit();
    await settle();
    (document.querySelector("#stop-work") as HTMLButtonElement).click();
    await settle();
    const companyForm = document.querySelector("#company-work") as HTMLFormElement;
    (companyForm.elements.namedItem("company") as HTMLInputElement).value = "Joe's Guns";
    (companyForm.elements.namedItem("field") as HTMLSelectElement).value = "Employee";
    companyForm.requestSubmit();
    await settle();
    const crimeForm = document.querySelector("#crime-work") as HTMLFormElement;
    (crimeForm.elements.namedItem("crime") as HTMLSelectElement).value = "Heist";
    crimeForm.requestSubmit();
    await settle();
    const classForm = document.querySelector("#class-work") as HTMLFormElement;
    (classForm.elements.namedItem("location") as HTMLSelectElement).value = "Powerhouse Gym";
    (classForm.elements.namedItem("classType") as HTMLSelectElement).value = "agi";
    classForm.requestSubmit();
    await settle();
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => [request.url, JSON.parse(String(request.body))])).toEqual([
      ["/api/work", { work: { faction: "NiteSec", workType: "field" } }],
      ["/api/work", { work: null }],
      ["/api/work", { work: { kind: "company", company: "Joe's Guns", field: "Employee" } }],
      ["/api/work", { work: { kind: "crime", crime: "Heist" } }],
      ["/api/work", { work: { kind: "class", location: "Powerhouse Gym", classType: "agi" } }],
    ]);
  });
});
