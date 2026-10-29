// The run report (#185): each section from known snapshots and events, each failure turning the verdict to FAIL with
// its line, and its command's exit codes and default window. Over a store built here, never the owner's .data/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  FactionState,
  FactionStateReading,
  FastSnapshotData,
  IntentOutcome,
  MediumSnapshotData,
  SlowSnapshotData,
  StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { STORE_FILE_NAME } from "../src/config.ts";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { findIncomeStalls, formatDuration, inferHackTargets, runReport } from "../src/run-report.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { staticServer } from "./helpers/snapshot-fixtures.ts";

const REPORT_CLI = path.resolve(import.meta.dirname, "../src/report-cli.ts");
const T0 = Date.parse("2026-10-26T00:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const context = { environment: "E0", release: "r" } as const;

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
function snapshot(tier: string, offsetMs: number, data: unknown) {
  store.recordSnapshot(context, {
    agentSessionId: "session-1",
    tier,
    sequenceNumber: ++sequenceNumber,
    gameTimeMs: 0,
    receivedAtMs: T0 + offsetMs,
    missedBefore: 0,
    data,
  });
}
const event = (offsetMs: number, kind: string, detail: unknown = {}) =>
  store.recordEvent(context, { atMs: T0 + offsetMs, kind, detail });

const fastData = (changes: Partial<FastSnapshotData> = {}): FastSnapshotData => ({
  degradedTiers: [],
  pageHeapUsedBytes: 100 * 1024 * 1024,
  game: { money: 0, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [] },
  intents: [],
  dialogs: { handled: [], blocking: null },
  work: null,
  ...changes,
});
const intent = (id: string, changes: Partial<IntentOutcome> = {}): IntentOutcome => ({
  id,
  done: false,
  tries: 1,
  problem: null,
  backend: "sim",
  ...changes,
});

/** A medium snapshot: the player's money and hacking, home's RAM, and n00dles' money and security. */
function mediumData({
  money,
  hacking = 1,
  homeRam = 8,
  noodles = { money: 1_000, security: 1 },
  hasTorRouter = false,
  programs = [],
  factions = [],
}: {
  money: number;
  hacking?: number;
  homeRam?: number;
  noodles?: { money: number; security: number };
  hasTorRouter?: boolean;
  programs?: string[];
  factions?: string[];
}): MediumSnapshotData {
  const server = (hostname: string, maxRam: number, hasAdminRights: boolean, money = 0, security = 1) => ({
    hostname,
    maxRam,
    cpuCores: 1,
    hasAdminRights,
    backdoorInstalled: false,
    moneyAvailable: money,
    hackDifficulty: security,
  });
  return {
    player: { money, skills: { hacking, strength: 1 }, city: "Sector-12", factions, jobs: {} },
    hasTorRouter,
    programs,
    servers: [
      server("home", homeRam, true, money),
      server("n00dles", 4, true, noodles.money, noodles.security),
      server("foodnstuff", 16, hacking >= 5, 2_000, 10),
      server("pserv-0", 8, true, 0, 1),
    ],
  };
}
/** A faction state read (#197): nothing joined, invited or queued unless said. */
const factionState = (state: Partial<FactionState> = {}): FactionStateReading => ({
  backend: "ui",
  state: { joined: [], invitations: [], queuedAugmentations: [], ...state },
  problem: null,
});
const slowData = (
  purchasedServers: string[] = [],
  ownedAugs: Record<string, number> = {},
  ownedSF: Record<string, number> = {},
  /** Null for none: an older Agent. */
  factions: FactionStateReading | null = factionState(),
): SlowSnapshotData => ({
  resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode: 1, ownedAugs, ownedSF, bitNodeOptions: {} },
  purchasedServers,
  ...(factions === null ? {} : { factions }),
});
const staticData = (): StaticSnapshotData => ({
  servers: [{ ...staticServer("home"), purchasedByPlayer: true, moneyMax: 0 }, staticServer("n00dles")],
});

const RUN_MS = 20 * MINUTE;
/** The fast snapshots' offsets (every 2 s from 10 s), except those `skip` drops. */
function fastOffsets(skip: (offsetMs: number) => boolean = () => false) {
  const offsets: number[] = [];
  for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 2 * SECOND)
    if (!skip(offsetMs)) offsets.push(offsetMs);
  return offsets;
}

/**
 * A clean 20-minute run: the brain starts, deploys and backs up the save; the Agent connects; money rises every medium
 * snapshot (10 s) while n00dles' money and security move; TOR is bought; work converges, a promotion and a dialog.
 * `fast` and `money` change it for one test.
 */
function cleanRun({
  fast = (offsetMs: number) =>
    fastData({ game: { money: offsetMs, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [] } }),
  money = (offsetMs: number) => 1_000 + offsetMs,
  skipFast,
}: {
  fast?: (offsetMs: number) => FastSnapshotData;
  money?: (offsetMs: number) => number;
  skipFast?: (offsetMs: number) => boolean;
} = {}) {
  event(0, "brainStarted", { release: "v0.2.0-25-g7990834" });
  event(5 * SECOND, "deployed", { deploymentId: "dep-b", replacedDeploymentId: "dep-a" });
  event(6 * SECOND, "saveBackup", { file: "saves/E0/backup.json.gz", sizeBytes: 20_480 });
  event(9 * SECOND, "agentConnected", {
    agentSessionId: "session-1",
    deploymentId: "dep-b",
    game: { version: "3.0.1", platform: "Steam" },
  });
  snapshot("static", 10 * SECOND, staticData());
  snapshot("slow", 10 * SECOND, slowData([], {}, {}, factionState({ invitations: ["CyberSec"] })));
  const inCyberSec = (reputation: number, state: Partial<FactionState> = {}) =>
    factionState({ joined: [{ name: "CyberSec", reputation, favor: 0 }], ...state });
  snapshot("slow", 10 * MINUTE, slowData([], {}, {}, inCyberSec(100.4)));
  for (const offsetMs of fastOffsets(skipFast)) snapshot("fast", offsetMs, fast(offsetMs));
  for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
    const late = offsetMs >= 10 * MINUTE;
    snapshot(
      "medium",
      offsetMs,
      mediumData({
        money: money(offsetMs),
        hacking: late ? 12 : 1,
        homeRam: late ? 16 : 8,
        noodles: { money: offsetMs, security: 1 + offsetMs / 1e6 },
        hasTorRouter: late,
        programs: late ? ["BruteSSH.exe"] : [],
        factions: late ? ["CyberSec"] : [],
      }),
    );
  }
  snapshot(
    "slow",
    RUN_MS,
    slowData(
      ["pserv-0"],
      { "Neurotrainer I": 1 },
      { 4: 3 },
      inCyberSec(1234.5, {
        invitations: ["Sector-12"],
        queuedAugmentations: ["NeuroFlux Governor", "BitWire", "NeuroFlux Governor"],
      }),
    ),
  );
  event(3 * MINUTE, "gameDialog", {
    kind: "alert",
    text: "Message received from unknown sender: I know you can sense it. I know you are searching for it.",
  });
  event(12 * MINUTE, "workPromotion", { company: "Noodle Bar", from: "Waiter", to: "Head Waiter", gameTimeMs: 0 });
}

const window = { environment: "E0", sinceMs: T0, untilMs: T0 + RUN_MS + 30 * SECOND } as const;
const report = () => runReport(store, window);

describe("the sections", () => {
  test("a clean run is PASS, and each section says what happened", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          intents:
            offsetMs < 60 * SECOND
              ? [intent("buyTor(Alpha Enterprises)")]
              : [intent("buyTor(Alpha Enterprises)", { done: true, tries: 2, backend: "ui" })],
          work:
            offsetMs < 30 * SECOND
              ? null
              : {
                  converged: offsetMs >= 40 * SECOND,
                  problem: offsetMs >= 40 * SECOND ? null : "busy",
                  backend: "sim",
                },
          pageHeapUsedBytes: (offsetMs === 100 * SECOND ? 300 : 100) * 1024 * 1024,
        }),
    });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text.split("\n").at(-1)).toBe("Verdict: PASS");
    expect(text).toContain("Run report (E0) from 2026-10-26T00:00:00.000Z to 2026-10-26T00:20:30.000Z (20 min 30 s)");
    // 1. The window.
    for (const line of [
      `  ${at(0)}  brain started, release v0.2.0-25-g7990834`,
      `  ${at(5 * SECOND)}  deployed dep-b, replacing dep-a`,
      `  ${at(6 * SECOND)}  save backup saves/E0/backup.json.gz (20 KB)`,
      `  ${at(9 * SECOND)}  Agent connected: session session-1, deployment dep-b, game 3.0.1 (Steam)`,
      "  brain starts: 1; Agent connections: 1, disconnections: 0; relaunches: 0; deploys: 1; save backups: 1",
    ]) {
      expect(text).toContain(line);
    }
    // 2. Progress, the player's own servers left out of the rooted count and the target.
    for (const line of [
      "  money: $11,000 → $1,201,000",
      "  hacking: 1 → 12",
      "  other skills: strength 1 → 1",
      "  home RAM: 8 GB → 16 GB",
      "  home RAM used: 4 GB (unchanged)",
      "  TOR router: no → yes",
      "  port openers: none → BruteSSH.exe",
      "  the game's servers rooted: 1 → 2",
      "  city: Sector-12 (unchanged)",
      "  factions: none → CyberSec",
      "  jobs: none (unchanged)",
      "  installed augmentations: none → Neurotrainer I",
      "  BitNode: 1 (unchanged)",
      "  Source-Files: none → SF4.3",
      "  purchased servers: none → pserv-0",
      // The faction state (#197): reputation first → last, each invitation as first seen, the queue counted.
      "  faction reputation and favour, first reading → last:\n    CyberSec: reputation 100 → 1,235, favour 0 (unchanged)",
      `  faction invitations, as first seen:\n    CyberSec, ${at(10 * SECOND)}\n    Sector-12, ${at(RUN_MS)}`,
      "  augmentations queued: none → NeuroFlux Governor ×2, BitWire",
      `    n00dles: ${at(20 * SECOND)} to ${at(RUN_MS)}`,
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain("hack loop target, inferred from");
    // 3. Actions.
    for (const line of [
      `    buyTor(Alpha Enterprises): done after 2 tries (ui); done by ${at(60 * SECOND)}`,
      `    ${at(10 * SECOND)}  none wanted`,
      `    ${at(30 * SECOND)}  not converged (sim): busy`,
      `    ${at(40 * SECOND)}  converged (sim)`,
      `    ${at(12 * MINUTE)}  Noodle Bar: Waiter → Head Waiter`,
      `    ${at(3 * MINUTE)}  alert: "Message received from unknown sender: I know you can sense i…"`,
    ]) {
      expect(text).toContain(line);
    }
    // 4. Health.
    expect(text).toContain(
      `    ${fastOffsets().length} snapshots, first ${at(10 * SECOND)}, last ${at(RUN_MS)}; before the first, 10 s ` +
        `from the window's start; after the run's last record (${at(RUN_MS)}), 30 s to its end`,
    );
    expect(text).toContain("    longest interval 2.0 s\n    no gaps");
    expect(text).toContain("  page heap: first 100.0 MB, last 100.0 MB, lowest 100.0 MB, highest 300.0 MB");
  });

  test("an intent id given again after it was done is another episode, each with its own outcome", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          intents: [
            offsetMs < MINUTE
              ? intent("travel(Aevum)", { done: offsetMs >= 30 * SECOND })
              : intent("travel(Aevum)", { tries: offsetMs < 2 * MINUTE ? 1 : 2, problem: "no money" }),
          ],
        }),
    });
    const { text } = report();
    expect(text).toContain(
      `    travel(Aevum): done after 1 try (sim); done by ${at(30 * SECOND)}\n` +
        `    travel(Aevum): not done, 2 tries (sim): no money; first seen ${at(MINUTE)}`,
    );
  });

  test("home RAM used comes from the fast snapshots; malformed values read as unknown", () => {
    event(0, "brainStarted", { release: "r" });
    snapshot("fast", 10 * SECOND, fastData({ game: { money: 0, homeRamUsed: 4.5, homeMaxRam: 8, homeProcesses: [] } }));
    snapshot("fast", 12 * SECOND, fastData({ game: null }));
    snapshot("medium", 10 * SECOND, { player: { skills: {} }, hasTorRouter: false, programs: [], servers: [] });
    snapshot("medium", 20 * SECOND, {
      player: { money: "lots", skills: {} },
      hasTorRouter: false,
      programs: [],
      servers: [],
    });
    const { text } = report();
    for (const line of [
      "  money: unknown (unchanged)",
      "  hacking: unknown (unchanged)",
      "  home RAM: unknown (unchanged)",
      "  home RAM used: 4.5 GB → unknown",
      "  city: unknown (unchanged)",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toMatch(/undefined|NaN/);
  });

  test("an earlier brain start in the day before the window is noted", () => {
    event(-3 * MINUTE, "brainStarted", { release: "r" });
    cleanRun();
    expect(report().text).toContain(
      `  note: the brain also started at ${at(-3 * MINUTE)}, 3 min before the window: for a run that spans a ` +
        "restart, give --since",
    );
  });

  test("a brain start more than a day before the window isn't noted", () => {
    event(-25 * 60 * MINUTE, "brainStarted", { release: "r" });
    cleanRun();
    expect(report().text).not.toContain("note: the brain also started");
  });

  test("the snapshots are read one row at a time, in one read transaction", () => {
    cleanRun();
    const iterate = vi.spyOn(store, "iterateSnapshotsInWindow");
    const transaction = vi.spyOn(store, "readTransaction");
    expect(report().failures).toEqual([]);
    expect(iterate.mock.calls.map(([query]) => query.tier).sort()).toEqual(["fast", "medium", "slow", "static"]);
    expect(transaction).toHaveBeenCalledOnce();
    // Every read was inside it.
    expect(Math.min(...iterate.mock.invocationCallOrder)).toBeGreaterThan(transaction.mock.invocationCallOrder[0] ?? 0);
  });

  test("an intent not done says its tries and problem, and when first seen", () => {
    cleanRun({
      fast: () => fastData({ intents: [intent("travel(Aevum)", { tries: 2, problem: "no money", backend: "ui" })] }),
    });
    expect(report().text).toContain(
      `    travel(Aevum): not done, 2 tries (ui): no money; first seen ${at(10 * SECOND)}`,
    );
  });

  test("nothing to say: each part of each section says so", () => {
    event(0, "brainStarted", { release: "r" });
    snapshot("fast", 10 * SECOND, fastData({ work: undefined }));
    const { text } = report();
    for (const line of [
      "  no medium snapshot (the player and the servers) in the window",
      "  no slow snapshot (the BitNode, augmentations, Source-Files, purchased servers) in the window",
      "    none moved",
      "  intents:\n    none",
      "  work, as it changed:\n    not reported",
      "  promotions:\n    none",
      "  dialogs handled:\n    none",
    ]) {
      expect(text).toContain(line);
    }
  });
});

describe("each failure is a FAIL, with its line", () => {
  const verdict = () => {
    const { text, failures } = report();
    return { text, failures, verdictLine: text.split("\n").find((line) => line.startsWith("Verdict:")) };
  };

  test("a gap in the heartbeat over 6 s", () => {
    cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 70 * SECOND });
    const { failures, verdictLine } = verdict();
    expect(verdictLine).toBe("Verdict: FAIL");
    expect(failures).toEqual([`gap: ${at(60 * SECOND)} to ${at(70 * SECOND)} (10.0 s); nothing recorded during it`]);
  });

  test("a gap names the restarts in it, and a reset intent the Agent held before it", () => {
    cleanRun({
      skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 100 * SECOND,
      fast: (offsetMs) =>
        fastData({ intents: offsetMs <= 60 * SECOND ? [intent("installAugmentations()", { done: true })] : [] }),
    });
    event(70 * SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    event(80 * SECOND, "brainStarted", { release: "r2" });
    event(99 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    // A save backup isn't a restart: not named.
    event(98 * SECOND, "saveBackup", { file: "f", sizeBytes: 1 });
    expect(verdict().failures).toEqual([
      `gap: ${at(60 * SECOND)} to ${at(100 * SECOND)} (40.0 s); during it: agentDisconnected at ${at(70 * SECOND)}, ` +
        `brainStarted at ${at(80 * SECOND)}, agentConnected at ${at(99 * SECOND)}; before it, the Agent held ` +
        "installAugmentations()",
    ]);
  });

  test("the faction state unread (#197): each stretch of slow snapshots with the same problem, and none at all", () => {
    cleanRun();
    const unread = (problem: string): FactionStateReading => ({ backend: "ui", state: null, problem });
    snapshot("slow", 2 * MINUTE, slowData([], {}, {}, unread("a dialog the Agent leaves for the owner is open")));
    snapshot("slow", 3 * MINUTE, slowData([], {}, {}, unread("a dialog the Agent leaves for the owner is open")));
    snapshot("slow", 4 * MINUTE, slowData([], {}, {}, unread("no game page to read the faction state through")));
    // Read at 10 min (cleanRun's), then a slow snapshot with no reading at all: an older Agent, or a bug.
    snapshot("slow", 11 * MINUTE, slowData([], {}, {}, null));
    const { text, failures, verdictLine } = verdict();
    expect(verdictLine).toBe("Verdict: FAIL");
    expect(failures).toEqual([
      `faction state unread from ${at(2 * MINUTE)} to ${at(3 * MINUTE)} (2 slow snapshots, ui): a dialog the Agent ` +
        "leaves for the owner is open",
      `faction state unread from ${at(4 * MINUTE)} to ${at(4 * MINUTE)} (1 slow snapshot, ui): no game page to read ` +
        "the faction state through",
      `faction state unread from ${at(11 * MINUTE)} to ${at(11 * MINUTE)} (1 slow snapshot): the slow snapshot ` +
        "carries no faction state the brain can read",
    ]);
    expect(text).toContain(
      `  faction state unread (slow snapshots whose faction state couldn't be read, #197):\n    faction`,
    );
    // What was read still shows.
    expect(text).toContain("    CyberSec: reputation 100 → 1,235, favour 0 (unchanged)");
  });

  test("a clean run's faction state is read throughout: none unread", () => {
    cleanRun();
    expect(report().text).toContain(
      "  faction state unread (slow snapshots whose faction state couldn't be read, #197):\n    none",
    );
  });

  test("never read: the faction lines say so, never an empty state", () => {
    event(0, "brainStarted", { release: "r" });
    snapshot("fast", 10 * SECOND, fastData());
    snapshot("slow", 10 * SECOND, slowData([], {}, {}, { backend: "ui", state: null, problem: "no game page" }));
    const { text } = report();
    expect(text).toContain("  faction reputation and favour, first reading → last:\n    never read");
    expect(text).toContain("  faction invitations, as first seen:\n    never read");
    expect(text).toContain("  augmentations queued: unknown (unchanged)");
  });

  test("an interval of exactly 6 s isn't a gap", () => {
    cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 66 * SECOND });
    expect(verdict().failures).toEqual([]);
    expect(report().text).toContain("    longest interval 6.0 s\n    no gaps");
  });

  test("the silence before the first fast snapshot and after the run's last record isn't a gap", () => {
    cleanRun();
    const { failures } = runReport(store, { ...window, sinceMs: T0 - 10 * MINUTE, untilMs: T0 + 2 * RUN_MS });
    expect(failures).toEqual([]);
  });

  test("an income stall: money not rising for 10 minutes after it first rose; a purchase isn't a rise", () => {
    // Rising to 4 min, then a purchase at 5 min, then flat until a rise at 14 min 10 s.
    cleanRun({
      money: (offsetMs) =>
        offsetMs <= 4 * MINUTE
          ? 1_000 + offsetMs
          : offsetMs < 5 * MINUTE
            ? 241_000
            : offsetMs < 850 * SECOND
              ? 41_000
              : 50_000 + offsetMs,
    });
    const { failures, verdictLine } = verdict();
    expect(verdictLine).toBe("Verdict: FAIL");
    expect(failures).toEqual([
      `income stalled from ${at(4 * MINUTE)} to ${at(850 * SECOND)} (10 min 10 s): money $241,000 → $41,000`,
    ]);
  });

  test("money flat for exactly 10 minutes is a stall", () => {
    const flatFrom4MinutesFor = (flatMs: number) => (offsetMs: number) =>
      offsetMs <= 4 * MINUTE ? 1_000 + offsetMs : offsetMs < 4 * MINUTE + flatMs ? 241_000 : 241_000 + offsetMs;
    cleanRun({ money: flatFrom4MinutesFor(10 * MINUTE) });
    expect(verdict().failures).toEqual([
      `income stalled from ${at(4 * MINUTE)} to ${at(14 * MINUTE)} (10 min): money $241,000 → $241,000`,
    ]);
  });

  test("money flat for 9 minutes 50 s isn't a stall", () => {
    cleanRun({
      money: (offsetMs) =>
        offsetMs <= 4 * MINUTE ? 1_000 + offsetMs : offsetMs < 830 * SECOND ? 241_000 : 241_000 + offsetMs,
    });
    expect(verdict().failures).toEqual([]);
  });

  test("with the hack loop switched off, a stall is shown, not counted; switched on, it's a failure", () => {
    cleanRun({ money: (offsetMs) => Math.min(1_000 + offsetMs, 1_000 + 5 * MINUTE) });
    store.setSetting("hackLoop.enabled", "false");
    const off = verdict();
    expect(off.failures).toEqual([]);
    expect(off.text).toContain(
      "the hack loop is switched off now, so these are shown, not counted:\n    income stalled from",
    );
    store.setSetting("hackLoop.enabled", "true");
    expect(verdict().failures).toHaveLength(1);
  });

  test("a stall over a heartbeat gap says so: the money then went unseen", () => {
    cleanRun({
      money: (offsetMs) => Math.min(1_000 + offsetMs, 1_000 + 5 * MINUTE),
      skipFast: (offsetMs) => offsetMs > 6 * MINUTE && offsetMs < 11 * MINUTE,
    });
    expect(verdict().failures).toContain(
      `income stalled from ${at(5 * MINUTE)} to ${at(RUN_MS)}, the last snapshot, still stalled (15 min): money ` +
        "$301,000 → $301,000; spans a heartbeat gap of 5 min",
    );
  });

  test("an income stall still going at the last snapshot says so", () => {
    cleanRun({ money: (offsetMs) => Math.min(1_000 + offsetMs, 1_000 + 5 * MINUTE) });
    expect(verdict().failures).toEqual([
      `income stalled from ${at(5 * MINUTE)} to ${at(RUN_MS)}, the last snapshot, still stalled (15 min): money ` +
        "$301,000 → $301,000",
    ]);
  });

  test("an intent with 5 tries not done at the last look; 4 tries, or done, isn't", () => {
    cleanRun({
      fast: () =>
        fastData({
          intents: [
            intent("buyTor(Alpha Enterprises)", { tries: 5, problem: "no City in the sidebar", backend: "ui" }),
            intent("travel(Aevum)", { tries: 4 }),
            intent("buyProgram(BruteSSH.exe)", { tries: 9, done: true }),
          ],
        }),
    });
    expect(verdict().failures).toEqual([
      "intent stuck: buyTor(Alpha Enterprises), not done, 5 tries (ui): no City in the sidebar",
    ]);
  });

  test("a stuck intent later done isn't stuck", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          intents: [intent("travel(Aevum)", { tries: offsetMs < MINUTE ? 6 : 7, done: offsetMs >= MINUTE })],
        }),
    });
    expect(verdict().failures).toEqual([]);
  });

  test("a dialog left blocking the page, with when it was seen", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          dialogs: { handled: [], blocking: offsetMs >= MINUTE && offsetMs <= 2 * MINUTE ? "Are you sure?" : null },
        }),
    });
    expect(verdict().failures).toEqual([
      `dialog left blocking from ${at(MINUTE)} to ${at(2 * MINUTE)}: "Are you sure?"`,
    ]);
  });

  test("an Agent disconnect with no reconnect within 60 s, where the run went on", () => {
    cleanRun();
    event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
    event(5 * MINUTE + 61 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    expect(verdict().failures).toEqual([
      `Agent disconnected at ${at(5 * MINUTE)} (session session-1) and reconnected only at ${at(5 * MINUTE + 61 * SECOND)}; nothing recorded during it`,
    ]);
  });

  test("a dialog blocking twice, with a clear page between, is two episodes", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          dialogs: {
            handled: [],
            blocking: (offsetMs >= MINUTE && offsetMs <= 2 * MINUTE) || offsetMs >= 3 * MINUTE ? "Are you sure?" : null,
          },
        }),
    });
    expect(verdict().failures).toEqual([
      `dialog left blocking from ${at(MINUTE)} to ${at(2 * MINUTE)}: "Are you sure?"`,
      `dialog left blocking from ${at(3 * MINUTE)} to ${at(RUN_MS)}: "Are you sure?"`,
    ]);
  });

  test("a replaced session's disconnect and its successor's connect in the same millisecond are a reconnect", () => {
    cleanRun();
    event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
    event(5 * MINUTE, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-c", game: {} });
    expect(verdict().failures).toEqual([]);
  });

  test("a reconnect within 60 s is fine", () => {
    cleanRun();
    event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
    event(5 * MINUTE + 60 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    expect(verdict().failures).toEqual([]);
  });

  test("a disconnect never followed by a reconnect, with the brain still recording, is a failure", () => {
    cleanRun({ skipFast: (offsetMs) => offsetMs > 5 * MINUTE });
    event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
    event(10 * MINUTE, "relaunch", { cause: "notRunning" });
    const { failures } = verdict();
    expect(failures).toContain(
      `Agent disconnected at ${at(5 * MINUTE)} (session session-1) and never reconnected in the window; during it: ` +
        `relaunch at ${at(10 * MINUTE)}`,
    );
    // And the heartbeat's silence after it, to the run's last record (the promotion's event, at 12 minutes), is a gap.
    expect(failures).toContain(
      `gap: ${at(5 * MINUTE)} to ${at(12 * MINUTE)} (420.0 s); during it: agentDisconnected at ${at(5 * MINUTE)}, ` +
        `relaunch at ${at(10 * MINUTE)}`,
    );
  });

  test("a disconnect that's the run's last record isn't: the run ended there", () => {
    cleanRun();
    event(RUN_MS + SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    expect(runReport(store, { ...window, untilMs: T0 + RUN_MS + 10 * MINUTE }).failures).toEqual([]);
  });

  test("a disconnect under 60 s before the window ends isn't: there's no telling yet", () => {
    cleanRun();
    event(RUN_MS + SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    event(RUN_MS + 2 * SECOND, "saveBackup", { failure: "no connection" });
    expect(runReport(store, { ...window, untilMs: T0 + RUN_MS + 60 * SECOND }).failures).toEqual([]);
    expect(runReport(store, { ...window, untilMs: T0 + RUN_MS + 61 * SECOND }).failures).toEqual([
      `Agent disconnected at ${at(RUN_MS + SECOND)} (session session-1) and never reconnected in the window; nothing recorded during it`,
    ]);
  });

  test("deployFailed, versionDrift and supervisionGaveUp events", () => {
    cleanRun();
    event(MINUTE, "deployFailed", { deploymentId: "dep-c", reason: "write refused" });
    event(2 * MINUTE, "versionDrift", { detail: "the Agent's game: commit 3162fd2, pinned 1da7316ff" });
    event(3 * MINUTE, "supervisionGaveUp", { launchesInLastHour: 4 });
    expect(verdict().failures).toEqual([
      `${at(MINUTE)} deploy of dep-c FAILED: write refused`,
      `${at(2 * MINUTE)} version drift: the Agent's game: commit 3162fd2, pinned 1da7316ff`,
      `${at(3 * MINUTE)} supervisor GAVE UP: {"launchesInLastHour":4}`,
    ]);
  });

  test("no heartbeat at all", () => {
    event(0, "brainStarted", { release: "r" });
    event(MINUTE, "deployed", { deploymentId: "dep-b", replacedDeploymentId: null });
    expect(verdict().failures).toEqual(["no fast snapshot (the heartbeat) in the window: the Agent never reported"]);
  });

  test("several failures: one line each, after FAIL", () => {
    cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 70 * SECOND });
    event(MINUTE, "versionDrift", { detail: "drift" });
    const { text } = report();
    expect(text.split("\n").slice(-3)).toEqual([
      "Verdict: FAIL",
      `  gap: ${at(60 * SECOND)} to ${at(70 * SECOND)} (10.0 s); nothing recorded during it`,
      `  ${at(MINUTE)} version drift: drift`,
    ]);
  });
});

describe("backdoors for the hacker factions (#195)", () => {
  const BACKDOOR_CSEC = "backdoor(CSEC)";
  const INVITED = "You received a faction invitation.Would you like to join CyberSec?";
  /**
   * A run with CSEC (needing 54) and avmnite-02h (207) in the snapshots, at hacking 60, money rising: `csec(offsetMs)`
   * says whether CSEC is rooted and backdoored, and `intents(offsetMs)` what the Agent holds. The static snapshot comes at
   * `staticAtMs` (or none, for null), and `skipMedium` leaves medium snapshots out.
   */
  function hackerRun({
    csec,
    intents = () => [],
    staticAtMs = 10 * SECOND,
    skipMedium = () => false,
  }: {
    csec: (offsetMs: number) => { rooted: boolean; backdoored: boolean };
    intents?: (offsetMs: number) => IntentOutcome[];
    staticAtMs?: number | null;
    skipMedium?: (offsetMs: number) => boolean;
  }) {
    event(0, "brainStarted", { release: "r" });
    if (staticAtMs !== null)
      snapshot("static", staticAtMs, {
        servers: [
          ...staticData().servers,
          staticServer("CSEC", { moneyMax: 0, requiredHackingSkill: 54, numOpenPortsRequired: 1 }),
          staticServer("avmnite-02h", { moneyMax: 0, requiredHackingSkill: 207, numOpenPortsRequired: 2 }),
        ],
      });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData({ intents: intents(offsetMs) }));
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({ money: offsetMs, hacking: 60 });
      const { rooted, backdoored } = csec(offsetMs);
      const server = (hostname: string, hasAdminRights: boolean, backdoorInstalled: boolean) => ({
        hostname,
        maxRam: 8,
        cpuCores: 1,
        hasAdminRights,
        backdoorInstalled,
        moneyAvailable: 0,
        hackDifficulty: 0,
      });
      data.servers.push(server("CSEC", rooted, backdoored), server("avmnite-02h", true, false));
      if (!skipMedium(offsetMs)) snapshot("medium", offsetMs, data);
    }
  }

  test("each server's backdoor with when it was first seen, and the invitation that followed", () => {
    hackerRun({
      csec: (offsetMs) => ({ rooted: offsetMs >= 30 * SECOND, backdoored: offsetMs >= MINUTE }),
      intents: (offsetMs) =>
        offsetMs >= 40 * SECOND && offsetMs < 70 * SECOND
          ? [intent(BACKDOOR_CSEC, { done: offsetMs >= 50 * SECOND, tries: offsetMs >= 50 * SECOND ? 2 : 1 })]
          : [],
    });
    event(55 * SECOND, "gameDialog", { kind: "factionInvitation", text: INVITED });
    event(56 * SECOND, "gameDialog", { kind: "alert", text: "Would you like to join NiteSec? (not an invitation)" });
    const { text, failures } = report();
    expect(text).toContain(
      "  backdoors (the hacker factions' servers, for their invitations):\n" +
        `    CSEC: not backdoored at the window's start; backdoored by ${at(MINUTE)}; CyberSec's invitation at ` +
        `${at(55 * SECOND)}\n` +
        "    avmnite-02h: not backdoored at the window's start\n" +
        "    I.I.I.I: not in the medium snapshots\n" +
        "    run4theh111z: not in the medium snapshots\n",
    );
    expect(text).toContain(`    ${BACKDOOR_CSEC}: done after 2 tries (sim); done by ${at(50 * SECOND)}`);
    expect(text).toContain("or more):\n    none\n  backdoors asked for again");
    expect(text).toContain("already backdoored):\n    none");
    expect(failures).toEqual([]);
  });

  test("one backdoored with no invitation seen says so", () => {
    hackerRun({ csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs >= MINUTE }) });
    expect(report().text).toContain(
      `    CSEC: not backdoored at the window's start; backdoored by ${at(MINUTE)}; no invitation from CyberSec seen`,
    );
  });

  test("one backdoored before the window: its invitation came before too", () => {
    hackerRun({ csec: () => ({ rooted: true, backdoored: true }) });
    expect(report().text).toContain("    CSEC: backdoored at the window's start\n");
  });

  test("overdue: rooted, at its level and not backdoored for 5 minutes or more", () => {
    hackerRun({ csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs > 5 * MINUTE + 10 * SECOND }) });
    const { text, failures } = report();
    const line = `backdoor overdue: CSEC due from ${at(10 * SECOND)} to ${at(5 * MINUTE + 10 * SECOND)} (5 min), not backdoored`;
    expect(failures).toEqual([line]);
    expect(text).toContain(
      "  backdoors overdue (one of the hacker factions' servers rooted, at its level and not backdoored for 5 min or " +
        `more):\n    ${line}\n`,
    );
    expect(text.split("\n").at(-1)).toBe(`  ${line}`);
  });

  test("not overdue at 4 min 50 s", () => {
    hackerRun({ csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs > 5 * MINUTE }) });
    expect(report().failures).toEqual([]);
  });

  test("each medium snapshot is judged by the newest static snapshot before it: an install rolls the levels again", () => {
    // From 10 minutes, a new Agent's static snapshot says CSEC needs 70: at hacking 60, no longer due.
    snapshot("static", 10 * MINUTE, {
      servers: [...staticData().servers, staticServer("CSEC", { moneyMax: 0, requiredHackingSkill: 70 })],
    });
    hackerRun({ csec: () => ({ rooted: true, backdoored: false }) });
    expect(report().failures).toEqual([
      `backdoor overdue: CSEC due from ${at(10 * SECOND)} to ${at(10 * MINUTE - 10 * SECOND)} (9 min 40 s), not ` +
        "backdoored",
    ]);
  });

  test("overdue still at the last medium snapshot says so; not rooted, it isn't due", () => {
    hackerRun({ csec: (offsetMs) => ({ rooted: offsetMs >= 10 * MINUTE, backdoored: false }) });
    expect(report().failures).toEqual([
      `backdoor overdue: CSEC due from ${at(10 * MINUTE)} to ${at(RUN_MS)} (10 min), not backdoored; still due at ` +
        "the last medium snapshot",
    ]);
  });

  test("asked for again: a backdoor intent first seen while the server shows backdoored", () => {
    hackerRun({
      csec: () => ({ rooted: true, backdoored: true }),
      intents: (offsetMs) => (offsetMs >= 5 * MINUTE ? [intent(BACKDOOR_CSEC)] : []),
    });
    expect(report().failures).toEqual([
      `backdoor repeated: ${BACKDOOR_CSEC} first seen ${at(5 * MINUTE)}, with CSEC backdoored (the brain's rule, or ` +
        "the owner's queue)",
    ]);
  });

  test("not asked for again: one the window's first fast snapshot already holds, asked for before it", () => {
    hackerRun({
      csec: () => ({ rooted: true, backdoored: true }),
      intents: (offsetMs) => (offsetMs < MINUTE ? [intent(BACKDOOR_CSEC, { done: true })] : []),
    });
    expect(report().failures).toEqual([]);
  });

  test("not asked for again: one asked for after a reset took the backdoor away", () => {
    // An install at 10 minutes: CSEC's backdoor gone, asked for and installed again.
    const reset = (offsetMs: number) => offsetMs >= 10 * MINUTE && offsetMs < 11 * MINUTE;
    hackerRun({
      csec: (offsetMs) => ({ rooted: true, backdoored: !reset(offsetMs) }),
      intents: (offsetMs) => (offsetMs > 10 * MINUTE && offsetMs < 12 * MINUTE ? [intent(BACKDOOR_CSEC)] : []),
    });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(
      `    CSEC: backdoored at the window's start; not backdoored from ${at(10 * MINUTE)} (a reset); backdoored by ` +
        `${at(11 * MINUTE)}; no invitation from CyberSec seen`,
    );
  });

  test("not asked for again: given again to an Agent that reconnected before it reported it done (no tries again)", () => {
    hackerRun({
      csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs >= 50 * SECOND }),
      intents: (offsetMs) =>
        offsetMs < 40 * SECOND
          ? []
          : offsetMs < MINUTE
            ? [intent(BACKDOOR_CSEC, { tries: 1 })]
            : offsetMs < 70 * SECOND
              ? [intent(BACKDOOR_CSEC, { tries: 0 })]
              : [intent(BACKDOOR_CSEC, { done: true })],
    });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain("already backdoored):\n    none");
  });

  test("a medium snapshot before the window's first static one is judged by that one", () => {
    hackerRun({
      staticAtMs: 30 * SECOND,
      csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs >= 6 * MINUTE }),
    });
    expect(report().failures).toEqual([
      `backdoor overdue: CSEC due from ${at(10 * SECOND)} to ${at(6 * MINUTE - 10 * SECOND)} (5 min 40 s), not ` +
        "backdoored",
    ]);
  });

  test("with no static snapshot in the window, overdue can't be judged, and it says so", () => {
    hackerRun({ staticAtMs: null, csec: () => ({ rooted: true, backdoored: false }) });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(
      "or more):\n    not judged: no static snapshot (the servers' levels) in the window: give --since an Agent's start\n" +
        "    none\n",
    );
  });

  test("a gap in the medium snapshots ends a due stretch: the gap isn't counted as overdue", () => {
    hackerRun({
      csec: (offsetMs) => ({ rooted: true, backdoored: offsetMs >= 7 * MINUTE }),
      skipMedium: (offsetMs) => offsetMs > 3 * MINUTE && offsetMs < 4 * MINUTE,
    });
    expect(report().failures).toEqual([]);
  });

  test("no medium snapshot: said so", () => {
    event(0, "brainStarted", { release: "r" });
    snapshot("fast", 10 * SECOND, fastData());
    expect(report().text).toContain(
      "  backdoors (the hacker factions' servers, for their invitations):\n    no medium snapshot",
    );
  });
});

test("a window that ends before it starts, or with nothing in it, can't be reported", () => {
  expect(() => runReport(store, { ...window, untilMs: T0 })).toThrow(RangeError);
  expect(() => runReport(store, window)).toThrow("nothing recorded (E0) from 2026-10-26T00:00:00.000Z");
});

describe("findIncomeStalls", () => {
  const points = (moneys: number[]) => moneys.map((money, index) => ({ atMs: index * MINUTE, money }));

  test("exactly the threshold is a stall; a millisecond less isn't", () => {
    expect(INCOME_STALLED_AFTER_MS).toBe(10 * MINUTE);
    const flatFor10 = points([1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3]);
    expect(findIncomeStalls(flatFor10, 10 * MINUTE)).toEqual([
      { fromMs: MINUTE, toMs: 12 * MINUTE, lengthMs: 11 * MINUTE, moneyFrom: 2, moneyTo: 2, ongoing: false },
    ]);
    expect(findIncomeStalls(flatFor10, 11 * MINUTE)).toHaveLength(1);
    expect(findIncomeStalls(flatFor10, 11 * MINUTE + 1)).toEqual([]);
    expect(findIncomeStalls(points([1, 2, 2, 2]), 2 * MINUTE)).toEqual([
      { fromMs: MINUTE, toMs: 3 * MINUTE, lengthMs: 2 * MINUTE, moneyFrom: 2, moneyTo: 2, ongoing: true },
    ]);
  });

  test("before money first rises, nothing counts (the loop warming up)", () => {
    expect(findIncomeStalls(points([5, 5, 5, 5, 5, 5]), 2 * MINUTE)).toEqual([]);
    expect(findIncomeStalls(points([5, 5, 5, 5, 6, 7]), 2 * MINUTE)).toEqual([]);
  });

  test("a drop (a purchase) isn't a rise; the next rise, from wherever, ends it", () => {
    expect(findIncomeStalls(points([1, 9, 3, 3, 4]), 3 * MINUTE)).toEqual([
      { fromMs: MINUTE, toMs: 4 * MINUTE, lengthMs: 3 * MINUTE, moneyFrom: 9, moneyTo: 3, ongoing: false },
    ]);
  });
});

test("inferHackTargets: the servers whose money or security moved, in stretches; the player's own left out", () => {
  const medium = (atMs: number, states: Record<string, [number, number]>) => ({
    atMs,
    data: {
      player: {},
      hasTorRouter: false,
      programs: [],
      servers: Object.entries(states).map(([hostname, [moneyAvailable, hackDifficulty]]) => ({
        hostname,
        maxRam: 8,
        cpuCores: 1,
        hasAdminRights: true,
        moneyAvailable,
        hackDifficulty,
      })),
    },
  });
  const stretches = inferHackTargets(
    [
      medium(0, { home: [1, 1], n00dles: [1, 1], zer0: [1, 1] }),
      medium(10, { home: [2, 1], n00dles: [2, 1], zer0: [1, 1] }),
      medium(20, { home: [3, 1], n00dles: [2, 1.5], zer0: [1, 1] }),
      // Nothing moved: the stretch goes on.
      medium(30, { home: [3, 1], n00dles: [2, 1.5], zer0: [1, 1] }),
      medium(40, { home: [3, 1], n00dles: [3, 1.5], zer0: [1, 1] }),
      medium(50, { home: [3, 1], n00dles: [4, 1.5], zer0: [1, 0.5] }),
      medium(60, { home: [3, 1], n00dles: [4, 1.5], zer0: [1, 0.4], "pserv-0": [5, 5] }),
      // A server not in the snapshot before isn't a move.
      medium(70, { home: [3, 1], n00dles: [4, 1.5], zer0: [1, 0.3], "pserv-0": [6, 5], "new-server": [1, 1] }),
    ],
    new Set(["home", "pserv-0"]),
  );
  expect(stretches).toEqual([
    { servers: ["n00dles"], fromMs: 10, toMs: 40 },
    { servers: ["n00dles", "zer0"], fromMs: 50, toMs: 50 },
    { servers: ["zer0"], fromMs: 60, toMs: 70 },
  ]);
});

test("formatDuration: to the second under an hour, to the minute over", () => {
  expect(formatDuration(29_400)).toBe("29 s");
  expect(formatDuration(10 * MINUTE)).toBe("10 min");
  expect(formatDuration(24 * MINUTE + 20 * SECOND)).toBe("24 min 20 s");
  expect(formatDuration(74 * MINUTE + 59 * SECOND)).toBe("1 h 14 min");
});

describe("the command", () => {
  function runCli(args: string[], dataDirectory = directory): { exitCode: number; output: string } {
    try {
      const output = execFileSync(process.execPath, [REPORT_CLI, "--data-dir", dataDirectory, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return { exitCode: 0, output };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { exitCode: failed.status, output: failed.stdout + failed.stderr };
    }
  }
  const until = ["--until", at(RUN_MS + 30 * SECOND)];

  test("0 on PASS, 1 on FAIL, 2 when it couldn't run", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "run-report-empty-"));
    try {
      expect(runCli(["--since", at(0)], empty)).toMatchObject({
        exitCode: 2,
        output: expect.stringContaining("report: No telemetry store at"),
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // A store with nothing in it yet: no brain start to begin from, and an empty window.
    expect(runCli(until)).toMatchObject({ exitCode: 2, output: expect.stringContaining("no brain start (E0)") });
    expect(runCli(["--since", at(0), ...until])).toMatchObject({
      exitCode: 2,
      output: expect.stringContaining("report: nothing recorded"),
    });

    cleanRun();
    const pass = runCli(["--since", at(0), ...until]);
    expect(pass.exitCode).toBe(0);
    expect(pass.output).toContain("Verdict: PASS");
    event(MINUTE, "versionDrift", { detail: "drift" });
    const fail = runCli(["--since", at(0), ...until]);
    expect(fail.exitCode).toBe(1);
    expect(fail.output).toContain(`Verdict: FAIL\n  ${at(MINUTE)} version drift: drift`);

    // A window that ends before it starts, a time without Z or an offset, an unknown environment.
    expect(runCli(["--since", at(MINUTE), "--until", at(0)]).exitCode).toBe(2);
    expect(runCli(["--since", "2026-10-26T00:00:00", ...until]).exitCode).toBe(2);
    expect(runCli(["--since", at(0), ...until, "--environment", "E9"]).exitCode).toBe(2);
    // Another environment's window is empty here.
    expect(runCli(["--since", at(0), ...until, "--environment", "E2"]).exitCode).toBe(2);
  });

  test("without --since, the window starts at the newest brain start", () => {
    // An earlier run of the brain, with a failure, then the newest, clean.
    store.recordEvent(context, { atMs: T0 - 2 * MINUTE, kind: "brainStarted", detail: { release: "old" } });
    store.recordEvent(context, { atMs: T0 - MINUTE, kind: "deployFailed", detail: { deploymentId: "x", reason: "y" } });
    cleanRun();
    const newest = runCli(until);
    expect(newest.exitCode).toBe(0);
    expect(newest.output).toContain(`Run report (E0) from ${at(0)} to ${at(RUN_MS + 30 * SECOND)}`);
    expect(runCli(["--since", at(-2 * MINUTE), ...until]).exitCode).toBe(1);
  });
});
