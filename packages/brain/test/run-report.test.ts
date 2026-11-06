// The run report (#185): each section from known snapshots and events, each failure turning the verdict to FAIL with
// its line, and its command's exit codes and default window. Over a store built here, never the owner's .data/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type FactionState,
  type FactionStateReading,
  type FastSnapshotData,
  type IntentOutcome,
  type MediumSnapshotData,
  newBatcherHealth,
  type SlowSnapshotData,
  type StaticSnapshotData,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writeAugmentationsEnabled } from "../src/augmentations.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { formatDuration } from "../src/gap-report.ts";
import { describeCeiling, type HackingCeiling, hackingCeiling } from "../src/hacking-ceiling.ts";
import { findIncomeStalls, inferHackTargets, runReport } from "../src/run-report.ts";
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
function snapshot(tier: string, offsetMs: number, data: unknown, gameTimeMs = 0) {
  store.recordSnapshot(context, {
    agentSessionId: "session-1",
    tier,
    sequenceNumber: ++sequenceNumber,
    gameTimeMs,
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
      // n00dles and pserv-0, then foodnstuff too (#194).
      // n00dles and the brain's pserv-0: foodnstuff isn't among the static snapshot's servers.
      "  the hack loop's hosts' RAM: 12 GB on 2 servers (unchanged)",
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
      // pserv-0 was there from the first medium snapshot: not bought in the window (#194).
      "  cloud servers bought or upgraded (from the medium snapshots):\n    none",
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
      // No static snapshot: which servers are the game's isn't known (#194).
      "  the hack loop's hosts' RAM: unknown (no static snapshot) (unchanged)",
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
      "  the ceilings now: unknown: no medium snapshot",
      "  actual: unknown: fewer than two slow snapshots in the window",
    ]) {
      expect(text).toContain(line);
    }
  });

  test("5. Hacking: the best 10 minutes and the window against the ceilings, as percentages, and the ceilings now", () => {
    const ceiling = hackingRun({ earning: (ceilings) => ceilings.batcherIncomePerSecond / 2 });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(`  the ceilings now: ${describeCeiling(ceiling)}\n`);
    expect(text).toMatch(/\n {2}the best 10 minutes: 50\.0% of the batcher ceiling \(/);
    expect(text).toMatch(
      /\n {2}over the window: \$[\d,]+\/s: 50\.0% of the batcher ceiling \(\$[\d,]+\/s\), [\d.]+% of the ceiling /,
    );
  });

  test("5. Hacking: a window starting after the Agent's static snapshot still judges, from the one before it (#196)", () => {
    hackingRun({ earning: (ceilings) => ceilings.batcherIncomePerSecond / 2 });
    const { text } = runReport(store, { ...window, sinceMs: T0 + 5 * MINUTE });
    expect(text).toMatch(/\n {2}over the window: \$[\d,]+\/s: 50\.0% of the batcher ceiling /);
  });
});

describe("cloud servers (#194)", () => {
  /**
   * A run whose medium snapshots show pserv-1 from 5 minutes at 8 GB, and at 64 GB from 12 minutes; with `gone`, none
   * from 15 to 16 minutes (an install deleted it), then again at 8 GB.
   */
  function withPurchases(currentNode = 1, { gone = false } = {}) {
    event(0, "brainStarted", { release: "r" });
    snapshot("static", 10 * SECOND, staticData());
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 2 * SECOND) snapshot("fast", offsetMs, fastData());
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({ money: 1_000 + offsetMs });
      const deleted = gone && offsetMs >= 15 * MINUTE && offsetMs < 16 * MINUTE;
      if (offsetMs >= 5 * MINUTE && !deleted) {
        data.servers.push({ ...(data.servers.at(-1) as MediumSnapshotData["servers"][number]), hostname: "pserv-1" });
        const bigger = offsetMs >= 12 * MINUTE && !(gone && offsetMs >= 15 * MINUTE);
        (data.servers.at(-1) as { maxRam: number }).maxRam = bigger ? 64 : 8;
      }
      snapshot("medium", offsetMs, data);
    }
    const slow = slowData(["pserv-0", "pserv-1"]);
    snapshot("slow", RUN_MS, { ...slow, resetInfo: { ...slow.resetInfo, currentNode } });
  }

  test("each bought or upgraded, when, its RAM and BN1's price, and the total; the hosts' RAM", () => {
    withPurchases();
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(
      "  cloud servers bought or upgraded (from the medium snapshots):\n" +
        `    ${at(5 * MINUTE)}  pserv-1 bought, 8 GB, $440,000\n` +
        `    ${at(12 * MINUTE)}  pserv-1 upgraded, 8 GB → 64 GB, $3,080,000\n` +
        "    in all: 1 bought, 1 upgraded, $3,520,000",
    );
    expect(text).toContain("  the hack loop's hosts' RAM: 12 GB on 2 servers → 76 GB on 3 servers");
  });

  test("outside BN1, the price is unknown", () => {
    withPurchases(2);
    const { text } = report();
    expect(text).toContain(`    ${at(5 * MINUTE)}  pserv-1 bought, 8 GB, price unknown in BitNode 2`);
    expect(text).toContain("    in all: 1 bought, 1 upgraded\n");
    expect(text).toContain("    the brain buys none in BitNode 2: cloud server prices are known only in BN1\n");
  });

  test("in BN1, no word of other BitNodes' prices", () => {
    withPurchases(1);
    expect(report().text).not.toContain("the brain buys none");
  });

  test("a cloud server gone from the snapshots (an install deletes them) and bought again is bought again", () => {
    withPurchases(1, { gone: true });
    expect(report().text).toContain(
      `    ${at(16 * MINUTE)}  pserv-1 bought, 8 GB, $440,000\n    in all: 2 bought, 1 upgraded, $3,960,000`,
    );
  });

  test("a cloud purchase not done, with a problem (not enough money), isn't one done with a problem", () => {
    cleanRun({
      fast: () => fastData({ intents: [intent("buyServer(pserv-1, 8)", { problem: "not enough money" })] }),
    });
    expect(report().failures).toEqual([]);
  });

  test("a brain message the Agent refused is a failure, with its reason and count (#194's review)", () => {
    cleanRun();
    event(2 * MINUTE, "messageRefused", { reason: "an intent's hostname isn't valid", count: 2 });
    const { text, failures } = report();
    const line = `${at(2 * MINUTE)} the Agent REFUSED the brain's message (2 so far): an intent's hostname isn't valid`;
    expect(failures).toEqual([line]);
    expect(text).toContain(
      "  deploy failures, version drift, supervision given up, brain messages the Agent refused, restarts that couldn't " +
        `type:\n    ${line}`,
    );
  });

  test("a cloud purchase done with a problem is a failure, with its problem; another intent's isn't one", () => {
    const problem = "bought as pserv-1-0: a server off the network held pserv-1";
    cleanRun({
      fast: () =>
        fastData({
          intents: [
            intent("buyServer(pserv-1, 8)", { done: true, problem }),
            intent("travel(Aevum)", { done: true, problem: "odd" }),
          ],
        }),
    });
    const { text, failures } = report();
    expect(failures).toEqual([`cloud server purchase done with a problem: buyServer(pserv-1, 8): ${problem}`]);
    expect(text).toContain(`    buyServer(pserv-1, 8): done after 1 try (sim): ${problem}; done by ${at(10 * SECOND)}`);
    expect(text).toContain(
      "  cloud server purchases done with a problem:\n    cloud server purchase done with a problem: buyServer(pserv-1, 8)",
    );
  });
});
/**
 * A run with what the ceilings need (#196): zer0 rooted with 16 GB at hacking 150, a medium snapshot every 10 s with
 * the player's skills and multipliers, and hacking earning `earning` $ a second, by the slow snapshots' money sources
 * every minute. From `relaunchAtMs`, the count is `relaunchFall` lower, as after a relaunch from an older save.
 * Returns the ceilings.
 */
function hackingRun({
  earning,
  relaunchAtMs = Number.POSITIVE_INFINITY,
  relaunchFall = 0,
}: {
  earning: (ceilings: Extract<HackingCeiling, { known: true }>) => number;
  relaunchAtMs?: number;
  relaunchFall?: number;
}): Extract<HackingCeiling, { known: true }> {
  const servers: StaticSnapshotData = {
    servers: [
      { ...staticServer("home"), purchasedByPlayer: true, moneyMax: 0 },
      staticServer("zer0", { moneyMax: 187_500_000, minDifficulty: 10, requiredHackingSkill: 75, serverGrowth: 25 }),
    ],
  };
  const player = {
    money: 0,
    skills: { hacking: 150, intelligence: 0 },
    mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
  };
  const zer0 = {
    hostname: "zer0",
    maxRam: 16,
    cpuCores: 1,
    hasAdminRights: true,
    moneyAvailable: 0,
    hackDifficulty: 10,
  };
  const medium: MediumSnapshotData = { player, hasTorRouter: false, programs: [], servers: [zer0] };
  const ceiling = hackingCeiling(servers, medium);
  if (!ceiling.known) throw new Error(ceiling.reason);
  event(0, "brainStarted", { release: "r" });
  snapshot("static", 10 * SECOND, servers);
  for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
  for (let offsetMs = 10 * SECOND; offsetMs <= 10 * SECOND + RUN_MS; offsetMs += 10 * SECOND) {
    snapshot("medium", offsetMs, medium);
    const count =
      1e9 + ((offsetMs - 10 * SECOND) / 1000) * earning(ceiling) - (offsetMs >= relaunchAtMs ? relaunchFall : 0);
    if ((offsetMs - 10 * SECOND) % MINUTE === 0)
      snapshot("slow", offsetMs, { ...slowData(), moneySources: { hacking: count } });
  }
  return ceiling;
}

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
    // The held install would explain the gap (#240), but not the brain's restart in it.
    expect(verdict().failures).toEqual([
      `gap: ${at(60 * SECOND)} to ${at(100 * SECOND)} (40.0 s); during it: agentDisconnected at ${at(70 * SECOND)}, ` +
        `brainStarted at ${at(80 * SECOND)}, agentConnected at ${at(99 * SECOND)}; before it, the Agent held ` +
        "installAugmentations() (not expected: the game reloading after the installAugmentations() the Agent held, " +
        `but a restart in it too: brainStarted at ${at(80 * SECOND)})`,
    ]);
  });

  describe("a reload, after a destroy, an install or a deploy, is an expected gap (#240)", () => {
    type Recorded = [offsetMs: number, kind: string, detail: unknown];
    /**
     * Run #3's shape: the fast snapshots stop at 60 s and start again at `toMs` (off the 2 s grid where the issue's gap
     * was), the Agent disconnecting at 61 s and a new session connecting at `connectAtMs` (just before `toMs`).
     * `holding` is the intent the Agent held until the gap, and `records` the events recorded with them, all in time
     * order as the brain stores them.
     */
    function reloadGap(
      toMs: number,
      {
        holding = null,
        records = [],
        connectAtMs = toMs - 500,
      }: { holding?: string | null; records?: Recorded[]; connectAtMs?: number } = {},
    ) {
      cleanRun({
        skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < toMs,
        fast: (offsetMs) => fastData({ intents: holding !== null && offsetMs <= 60 * SECOND ? [intent(holding)] : [] }),
      });
      if ((toMs - 10 * SECOND) % (2 * SECOND) !== 0) snapshot("fast", toMs, fastData());
      const recorded: Recorded[] = [
        [61 * SECOND, "agentDisconnected", { agentSessionId: "session-1" }],
        [connectAtMs, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} }],
        ...records,
      ];
      for (const [offsetMs, kind, detail] of recorded.sort(([a], [b]) => a - b)) event(offsetMs, kind, detail);
    }
    const during = (toMs: number) =>
      `during it: agentDisconnected at ${at(61 * SECOND)}, agentConnected at ${at(toMs - 500)}`;
    const destroySent = (offsetMs: number, source = "brain"): Recorded => [
      offsetMs,
      "bitNodeDestroySent",
      { source, nextBitNode: 2 },
    ];
    const deployed = (offsetMs: number): Recorded => [
      offsetMs,
      "deployed",
      { deploymentId: "dep-c", replacedDeploymentId: "dep-b" },
    ];
    const gapLine = (toMs: number, fromMs = 60 * SECOND) =>
      `gap: ${at(fromMs)} to ${at(toMs)} (${((toMs - fromMs) / 1000).toFixed(1)} s)`;
    const unexplained = (toMs: number) => `${gapLine(toMs)}; ${during(toMs)}`;

    test.each([
      ["9.5 s", 55.6 * SECOND, 69.5 * SECOND],
      ["13.1 s", 55.3 * SECOND, 73.1 * SECOND],
    ])(
      "run #3's destroys: a %s gap, the destroy sent 4-5 s before it, is shown as expected, not a failure",
      (_, sentMs, toMs) => {
        reloadGap(toMs, { holding: "destroyBitNode(2)", records: [destroySent(sentMs)] });
        const { text, failures } = verdict();
        expect(failures).toEqual([]);
        expect(text).toContain(
          `\n    ${unexplained(toMs)}; before it, the Agent held destroyBitNode(2) (expected: the game reloading after ` +
            `a destroy sent at ${at(sentMs)})\n`,
        );
      },
    );

    test("the owner's destroy, sent through the queue, is a reload too", () => {
      reloadGap(70 * SECOND, { records: [destroySent(57 * SECOND, "manual")] });
      expect(verdict().failures).toEqual([]);
    });

    test("run #3's deploy: a 6.1 s gap, the deploy recorded 0.4 s into it, is shown as expected, not a failure", () => {
      reloadGap(66.1 * SECOND, { records: [deployed(60.4 * SECOND)] });
      const { text, failures } = verdict();
      expect(failures).toEqual([]);
      expect(text).toContain(
        `\n    ${gapLine(66.1 * SECOND)}; during it: deployed at ` +
          `${at(60.4 * SECOND)}, agentDisconnected at ${at(61 * SECOND)}, agentConnected at ${at(65.6 * SECOND)} ` +
          `(expected: the Agent restarting after a deploy at ${at(60.4 * SECOND)})\n`,
      );
    });

    test("an install's: a gap after the install went out is shown as expected, not a failure", () => {
      reloadGap(70 * SECOND, {
        holding: "installAugmentations()",
        records: [[57 * SECOND, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] }]],
      });
      // The reset, seen: the install isn't "not seen done".
      const reset = slowData();
      snapshot("slow", 72 * SECOND, { ...reset, resetInfo: { ...reset.resetInfo, lastAugReset: T0 + 69 * SECOND } });
      const { text, failures } = verdict();
      expect(failures).toEqual([]);
      expect(text).toContain(
        `\n    ${unexplained(70 * SECOND)}; before it, the Agent held installAugmentations() (expected: the game ` +
          `reloading after an install sent at ${at(57 * SECOND)})\n`,
      );
    });

    test("a reload's gap of exactly the bound, 60 s, is expected", () => {
      reloadGap(120 * SECOND, { holding: "destroyBitNode(2)", records: [destroySent(55 * SECOND)] });
      expect(verdict().failures).toEqual([]);
    });

    test("a reload's gap over the bound fails, naming the reload, as does the disconnect over 60 s", () => {
      reloadGap(122 * SECOND, { holding: "destroyBitNode(2)", records: [destroySent(55 * SECOND)] });
      expect(verdict().failures).toEqual([
        `${unexplained(122 * SECOND)}; before it, the Agent held destroyBitNode(2) (not expected: the game ` +
          `reloading after a destroy sent at ${at(55 * SECOND)}, but 62 s long, over the 60 s allowed)`,
        `Agent disconnected at ${at(61 * SECOND)} (session session-1) and reconnected only at ` +
          `${at(121.5 * SECOND)}; nothing recorded during it; before it, the Agent held destroyBitNode(2); just ` +
          `before it, a destroy sent at ${at(55 * SECOND)}`,
      ]);
    });

    test("a gap a millisecond over the bound says so, in figures that disagree with nothing", () => {
      reloadGap(120.001 * SECOND, { records: [destroySent(55 * SECOND)], connectAtMs: 119 * SECOND });
      expect(verdict().failures).toContain(
        `${gapLine(120.001 * SECOND)}; during it: agentDisconnected at ${at(61 * SECOND)}, agentConnected at ` +
          `${at(119 * SECOND)} (not expected: the game reloading after a destroy sent at ${at(55 * SECOND)}, but ` +
          "60.001 s long, over the 60 s allowed)",
      );
    });

    test.each([
      ["the brain starting", "brainStarted", { release: "r2" }],
      ["the game relaunched", "relaunch", { cause: "notRunning" }],
      ["the supervisor failing", "supervisionFailed", { reason: "x" }],
    ])("a reload's gap with %s in it isn't the reload alone: it fails, naming both", (_, kind, detail) => {
      reloadGap(70 * SECOND, { records: [destroySent(57 * SECOND), [65 * SECOND, kind, detail]] });
      expect(verdict().failures).toEqual([
        `${gapLine(70 * SECOND)}; during it: agentDisconnected at ${at(61 * SECOND)}, ${kind} at ${at(65 * SECOND)}, ` +
          `agentConnected at ${at(69.5 * SECOND)} (not expected: the game reloading after a destroy sent at ` +
          `${at(57 * SECOND)}, but a restart in it too: ${kind} at ${at(65 * SECOND)})`,
      ]);
    });

    test("a reload's gap that doesn't end with the Agent reconnected fails, naming the reload", () => {
      cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 70 * SECOND });
      event(...destroySent(55 * SECOND));
      // A connect just before the gap, and one just after it, are neither in it.
      event(59.9 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
      event(70.1 * SECOND, "agentConnected", { agentSessionId: "session-3", deploymentId: "dep-b", game: {} });
      expect(verdict().failures).toEqual([
        `${gapLine(70 * SECOND)}; nothing recorded during it (not expected: the game reloading after a destroy sent ` +
          `at ${at(55 * SECOND)}, but no Agent connected in it)`,
      ]);
    });

    test("a connect at the gap's very end is in it", () => {
      reloadGap(70 * SECOND, { records: [destroySent(57 * SECOND)], connectAtMs: 70 * SECOND });
      expect(verdict().failures).toEqual([]);
    });

    test("a connect at the gap's very start is in it, but the silence after it is the Agent's own (over 6 s)", () => {
      reloadGap(70 * SECOND, { records: [destroySent(57 * SECOND)], connectAtMs: 60 * SECOND });
      expect(verdict().failures).toContain(
        `${gapLine(70 * SECOND)}; during it: agentConnected at ${at(60 * SECOND)}, agentDisconnected at ` +
          `${at(61 * SECOND)} (not expected: the game reloading after a destroy sent at ${at(57 * SECOND)}, but ` +
          `silent for 10.0 s after the Agent connected at ${at(60 * SECOND)})`,
      );
    });

    test("the gap must end within the heartbeat threshold (6 s) of the Agent's connect", () => {
      reloadGap(100 * SECOND, { records: [destroySent(57 * SECOND)], connectAtMs: 94 * SECOND });
      expect(verdict().failures).toEqual([]);
    });

    test("of its last connect: an earlier session's connect in the gap doesn't count against it", () => {
      reloadGap(100 * SECOND, {
        records: [
          destroySent(57 * SECOND),
          [62 * SECOND, "agentConnected", { agentSessionId: "session-x", deploymentId: "dep-b", game: {} }],
        ],
      });
      expect(verdict().failures).toEqual([]);
    });

    test("an Agent connected and then silent fails, though the gap is under the bound", () => {
      reloadGap(100 * SECOND, { records: [destroySent(57 * SECOND)], connectAtMs: 93.9 * SECOND });
      expect(verdict().failures).toEqual([
        `${gapLine(100 * SECOND)}; during it: agentDisconnected at ${at(61 * SECOND)}, agentConnected at ` +
          `${at(93.9 * SECOND)} (not expected: the game reloading after a destroy sent at ${at(57 * SECOND)}, but ` +
          `silent for 6.1 s after the Agent connected at ${at(93.9 * SECOND)})`,
      ]);
    });

    test("a gap that ends on the run's last record, not a snapshot, is over the bound", () => {
      cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND });
      event(...destroySent(57 * SECOND));
      event(65 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
      // cleanRun's last record: the promotion's event at 12 minutes.
      expect(verdict().failures).toContain(
        `${gapLine(12 * MINUTE)}; during it: agentConnected at ${at(65 * SECOND)} (not expected: the game ` +
          `reloading after a destroy sent at ${at(57 * SECOND)}, but 660 s long, over the 60 s allowed)`,
      );
    });

    test("a destroy or install sent 10 s before the gap explains it", () => {
      reloadGap(70 * SECOND, { records: [destroySent(50 * SECOND)] });
      expect(verdict().failures).toEqual([]);
    });

    test("one sent more than 10 s before the gap doesn't: the gap fails as unexplained", () => {
      reloadGap(70 * SECOND, { records: [destroySent(49.9 * SECOND)] });
      expect(verdict().failures).toEqual([unexplained(70 * SECOND)]);
    });

    test("one sent longer before, the Agent still holding the destroy at the gap's start (a late round), explains it", () => {
      reloadGap(70 * SECOND, { holding: "destroyBitNode(2)", records: [destroySent(30 * SECOND)] });
      const { text, failures } = verdict();
      expect(failures).toEqual([]);
      expect(text).toContain(
        `\n    ${unexplained(70 * SECOND)}; before it, the Agent held destroyBitNode(2) (expected: the game reloading ` +
          "after the destroyBitNode(2) the Agent held)\n",
      );
    });

    test("one sent just before the report's window still explains a gap at its start", () => {
      reloadGap(69.5 * SECOND, { records: [destroySent(56 * SECOND)] });
      const { text } = runReport(store, { ...window, sinceMs: T0 + 58 * SECOND });
      expect(text).toContain(
        `\n    ${unexplained(69.5 * SECOND)} (expected: the game reloading after a destroy sent at ${at(56 * SECOND)})\n`,
      );
    });

    test("one reload explains one gap: a second gap after the same destroy fails", () => {
      cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 74 * SECOND });
      snapshot("fast", 66.5 * SECOND, fastData());
      event(...destroySent(57 * SECOND));
      event(61 * SECOND, "agentDisconnected", { agentSessionId: "session-1" });
      event(66 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
      event(67 * SECOND, "agentDisconnected", { agentSessionId: "session-2" });
      event(73.5 * SECOND, "agentConnected", { agentSessionId: "session-3", deploymentId: "dep-b", game: {} });
      const { text, failures } = verdict();
      expect(text).toContain(
        `\n    ${gapLine(66.5 * SECOND)}; during it: agentDisconnected at ${at(61 * SECOND)}, agentConnected at ` +
          `${at(66 * SECOND)} (expected: the game reloading after a destroy sent at ${at(57 * SECOND)})\n`,
      );
      expect(failures).toEqual([
        `${gapLine(74 * SECOND, 66.5 * SECOND)}; during it: agentDisconnected at ${at(67 * SECOND)}, agentConnected ` +
          `at ${at(73.5 * SECOND)}`,
      ]);
    });

    test("a deploy 1 s before the gap explains it: the old Agent's snapshot in flight as it's recorded", () => {
      reloadGap(70 * SECOND, { records: [deployed(59 * SECOND)] });
      expect(verdict().failures).toEqual([]);
    });

    test("a deploy earlier than that doesn't: the old Agent reported after it, so a new Agent died", () => {
      reloadGap(70 * SECOND, { records: [deployed(58.9 * SECOND)] });
      expect(verdict().failures).toEqual([unexplained(70 * SECOND)]);
    });

    test("a deploy up to a fast snapshot's period and 1 s (3 s) into the gap explains it", () => {
      reloadGap(70 * SECOND, { records: [deployed(63 * SECOND)] });
      expect(verdict().failures).toEqual([]);
    });

    test("a deploy later in the gap doesn't: a reload of the game's own, a crash say, may deploy too", () => {
      reloadGap(70 * SECOND, { records: [deployed(63.1 * SECOND)] });
      expect(verdict().failures).toEqual([
        `${gapLine(70 * SECOND)}; during it: agentDisconnected at ${at(61 * SECOND)}, ` +
          `deployed at ${at(63.1 * SECOND)}, agentConnected at ${at(69.5 * SECOND)}`,
      ]);
    });

    test("the latest reload before a gap is the one named", () => {
      reloadGap(70 * SECOND, { records: [destroySent(52 * SECOND)] });
      event(...deployed(59.5 * SECOND));
      expect(report().text).toContain(`(expected: the Agent restarting after a deploy at ${at(59.5 * SECOND)})\n`);
    });

    test("a gap with nothing explaining it still fails, the Agent reconnected or not", () => {
      reloadGap(70 * SECOND);
      expect(verdict().failures).toEqual([unexplained(70 * SECOND)]);
      store.close();
      rmSync(directory, { recursive: true, force: true });
      directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
      store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
      cleanRun({ skipFast: (offsetMs) => offsetMs > 60 * SECOND && offsetMs < 70 * SECOND });
      expect(verdict().failures).toEqual([`${gapLine(70 * SECOND)}; nothing recorded during it`]);
    });

    describe("an Agent disconnect with no reconnect within 60 s names a reload in the 10 s before it", () => {
      const disconnectAfter = (record: Recorded) => {
        cleanRun();
        event(...record);
        event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
        event(5 * MINUTE + 61 * SECOND, "agentConnected", {
          agentSessionId: "session-2",
          deploymentId: "dep-b",
          game: {},
        });
        return verdict().failures;
      };
      const line =
        `Agent disconnected at ${at(5 * MINUTE)} (session session-1) and reconnected only at ` +
        `${at(5 * MINUTE + 61 * SECOND)}; nothing recorded during it`;

      test("one 10 s before it is named", () => {
        expect(disconnectAfter(destroySent(5 * MINUTE - 10 * SECOND))).toEqual([
          `${line}; just before it, a destroy sent at ${at(5 * MINUTE - 10 * SECOND)}`,
        ]);
      });

      test("a deploy is named too", () => {
        expect(disconnectAfter(deployed(5 * MINUTE - 2 * SECOND))).toEqual([
          `${line}; just before it, a deploy at ${at(5 * MINUTE - 2 * SECOND)}`,
        ]);
      });

      test("one earlier isn't", () => {
        expect(disconnectAfter(destroySent(5 * MINUTE - 10.1 * SECOND))).toEqual([line]);
      });

      test("one after it isn't", () => {
        cleanRun();
        event(5 * MINUTE, "agentDisconnected", { agentSessionId: "session-1" });
        event(...destroySent(5 * MINUTE + SECOND));
        event(5 * MINUTE + 61 * SECOND, "agentConnected", {
          agentSessionId: "session-2",
          deploymentId: "dep-b",
          game: {},
        });
        expect(verdict().failures).toEqual([line]);
      });
    });
  });

  const HEADING =
    "  faction state unread (slow snapshots in a row whose faction state couldn't be read, #197; 3 or more is a failure):";

  test("the faction state unread (#197): 3 slow snapshots in a row is a FAIL, whatever each one's reason; fewer is shown, not counted", () => {
    cleanRun();
    const unread = (problem: string): FactionStateReading => ({ backend: "ui", state: null, problem });
    snapshot("slow", 2 * MINUTE, slowData([], {}, {}, unread("a dialog the Agent leaves for the owner is open")));
    snapshot("slow", 3 * MINUTE, slowData([], {}, {}, unread("a dialog the Agent leaves for the owner is open")));
    // Skipped between them: neither ends the stretch nor adds to it.
    snapshot(
      "slow",
      3.5 * MINUTE,
      slowData([], {}, {}, { backend: "ui", state: null, problem: null, skipped: "no sidebar on the page" }),
    );
    snapshot("slow", 4 * MINUTE, slowData([], {}, {}, unread("no game page to read the faction state through")));
    // Read at 10 min (cleanRun's); a single miss at 12 min, then read again at 13 min (P → read → P: two stretches).
    snapshot("slow", 11 * MINUTE, slowData([], {}, {}, unread("no game page to read the faction state through")));
    snapshot("slow", 12 * MINUTE, slowData());
    snapshot("slow", 13 * MINUTE, slowData([], {}, {}, unread("no game page to read the faction state through")));
    const { text, failures, verdictLine } = verdict();
    expect(verdictLine).toBe("Verdict: FAIL");
    const three =
      `faction state unread from ${at(2 * MINUTE)} to ${at(4 * MINUTE)} (3 slow snapshots in a row, ui): no game page ` +
      "to read the faction state through";
    expect(failures).toEqual([three]);
    expect(text).toContain(
      `${HEADING}\n    ${three}\n` +
        `    faction state unread from ${at(11 * MINUTE)} to ${at(11 * MINUTE)} (1 slow snapshot in a row, ui): no ` +
        "game page to read the faction state through; under 3 in a row, not counted\n" +
        `    faction state unread from ${at(13 * MINUTE)} to ${at(13 * MINUTE)} (1 slow snapshot in a row, ui): no ` +
        "game page to read the faction state through; under 3 in a row, not counted",
    );
    // What was read still shows.
    expect(text).toContain("    CyberSec: reputation 100 → 1,235, favour 0 (unchanged)");
  });

  test("an older Agent's slow snapshots (no reading), skipped ones and ones read with the page not put back: shown, never a FAIL", () => {
    cleanRun();
    snapshot("slow", 2 * MINUTE, slowData([], {}, {}, null));
    snapshot("slow", 3 * MINUTE, slowData([], {}, {}, null));
    snapshot("slow", 4 * MINUTE, slowData([], {}, {}, null));
    snapshot(
      "slow",
      5 * MINUTE,
      slowData([], {}, {}, { backend: "ui", state: null, problem: null, skipped: "no sidebar" }),
    );
    snapshot("slow", 6 * MINUTE, slowData([], {}, {}, { ...factionState(), problem: 'no "Stats" in the sidebar' }));
    const { text, failures } = verdict();
    expect(failures).toEqual([]);
    expect(text).toContain(`${HEADING}\n    none`);
    expect(text).toContain(
      "  faction state otherwise: 1 skipped (no sidebar on the page); 3 from an older Agent, with no faction state; 1 " +
        'read, but the page not put back as found (the last: no "Stats" in the sidebar)',
    );
  });

  test("a clean run's faction state is read throughout: none unread", () => {
    cleanRun();
    expect(report().text).toContain(`${HEADING}\n    none`);
    expect(report().text).not.toContain("faction state otherwise");
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

  test("a relaunch, hacking's count since the install falling to an older save's, is no income and no FAIL (#196)", () => {
    hackingRun({
      earning: (ceilings) => ceilings.batcherIncomePerSecond / 2,
      relaunchAtMs: 8 * MINUTE,
      relaunchFall: 5e8,
    });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toMatch(/\n {2}over the window: \$[\d,]+\/s: 4\d\.\d% of the batcher ceiling /);
  });

  test("hacking income above what all the rooted RAM could earn: its formula or the measure is wrong (#196)", () => {
    hackingRun({ earning: (ceilings) => ceilings.boundIncomePerSecond * 1.5 });
    const { failures, verdictLine } = verdict();
    expect(verdictLine).toBe("Verdict: FAIL");
    expect(failures).toEqual([
      expect.stringMatching(
        /^hacking income above what all the rooted RAM could earn: \$[\d,]+ earned from .*: the ceiling's formula or the measure is wrong$/,
      ),
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

  test("a restart after a reset that couldn't type (#212): a failure, with why and what it did", () => {
    cleanRun();
    // The first noted in this run; the second before it (the page's storage outlives a run), reported only now.
    event(MINUTE, "restartFellBack", { outcome: "reloading", reason: "no terminal", atMs: T0 + 30 * SECOND });
    event(2 * MINUTE, "restartFellBack", { outcome: "gaveUp", reason: "no terminal", atMs: T0 - MINUTE });
    expect(verdict().failures).toEqual([
      `${at(MINUTE)} restart after a reset couldn't type run /agent/boot.js: no terminal; it saved and reloaded the ` +
        `game (noted ${at(30 * SECOND)})`,
      `${at(2 * MINUTE)} restart after a reset couldn't type run /agent/boot.js: no terminal; it gave up (noted ` +
        `${at(-MINUTE)}, from before this run)`,
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

describe("factions and their work (#203)", () => {
  const CHOICE = {
    faction: "CyberSec",
    workType: "hacking",
    augmentation: "Neurotrainer I",
    reputation: 2,
    reputationNeeded: 1_000,
    reputationPerSecond: 0.5,
    etaSeconds: 1_996,
  };
  /**
   * A 20-minute run: the brain's work for CyberSec chosen at 1 min (unless `chosenAtMs` is null), CyberSec joined at 30 s,
   * and a slow snapshot each minute (but those `skipSlow` leaves out) with CyberSec's reputation `reputation(minute)`.
   */
  function factionRun({
    reputation,
    chosenAtMs = MINUTE,
    skipSlow = () => false,
    invitations = [],
  }: {
    reputation: (minute: number) => number;
    chosenAtMs?: number | null;
    skipSlow?: (minute: number) => boolean;
    invitations?: string[];
  }) {
    event(0, "brainStarted", { release: "r" });
    if (chosenAtMs !== null) event(chosenAtMs, "factionWorkChosen", CHOICE);
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      snapshot(
        "medium",
        offsetMs,
        mediumData({ money: offsetMs, factions: offsetMs >= 30 * SECOND ? ["CyberSec"] : [] }),
      );
    }
    for (let minute = 1; minute <= RUN_MS / MINUTE; minute++) {
      if (skipSlow(minute)) continue;
      const joined = [{ name: "CyberSec", reputation: reputation(minute), favor: 0 }];
      snapshot("slow", minute * MINUTE, slowData([], {}, {}, factionState({ joined, invitations })));
    }
  }

  test("the joins, the invitations left, each choice and why, and the reputation gained: PASS", () => {
    // 0.5/s is 30 a minute: on track.
    factionRun({ reputation: (minute) => 2 + (minute - 1) * 30, invitations: ["Sector-12"] });
    event(10 * MINUTE + 1, "factionWorkChosen", {
      ...CHOICE,
      augmentation: "BitWire",
      reputation: 1_000,
      etaSeconds: 5_500,
    });
    event(15 * MINUTE + 1, "factionWorkStopped", { reason: "your work on the dashboard" });
    const { text, failures } = report();
    expect(text).toContain(
      "  factions (joins, and the brain's faction work):\n" +
        `    joined: CyberSec by ${at(30 * SECOND)}\n` +
        `    city factions' invitations passed over (not of the city group the brain chose, decision 54): Sector-12 (first seen ${at(MINUTE)})\n` +
        "    the brain's faction work, as chosen:\n" +
        `      ${at(MINUTE)}  hacking for CyberSec, for Neurotrainer I (reputation 2 of 1,000, 0.50/s: about 33 min)\n` +
        `      ${at(10 * MINUTE + 1)}  hacking for CyberSec, for BitWire (reputation 1,000 of 1,000, 0.50/s: about 1.5 h)\n` +
        `      ${at(15 * MINUTE + 1)}  stopped (your work on the dashboard)\n` +
        // Minutes 1 to 15: 14 rises of 30, the work on.
        "    reputation gained with the brain's work on it: CyberSec +420\n",
    );
    expect(text).toContain("no slow snapshot gap over 3 min):\n    none");
    // Actions, not the window's events.
    expect(text).not.toContain("factionWorkChosen");
    expect(text).not.toContain("factionWorkStopped");
    expect(failures).toEqual([]);
  });

  test("none chosen, none joined: said so", () => {
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
    snapshot("medium", 10 * SECOND, mediumData({ money: 1 }));
    const { text } = report();
    expect(text).toContain(
      "    joined: none\n    city factions' invitations passed over (not of the city group the brain chose, decision 54): none\n" +
        "    the brain's faction work, as chosen:\n      none\n    reputation gained with the brain's work on it: none",
    );
  });

  test("stalled: under half the work's rate over 10 minutes, from the first such window's start: FAIL", () => {
    // On track to minute 4, then 10 a minute (under 15, half of 30), to the end: the window from minute 2 is the first
    // under it (60 to 200 by minute 12, under 150).
    factionRun({ reputation: (minute) => (minute <= 4 ? minute * 30 : 120 + (minute - 4) * 10) });
    const { text, failures } = report();
    const line =
      `faction work stalled: CyberSec's reputation rose under half the hacking work's 0.50/s from ${at(2 * MINUTE)} to ` +
      `${at(20 * MINUTE)} (18 min), with the brain's work for it; still under it at the last slow snapshot`;
    expect(text).toContain(`    ${line}`);
    expect(failures).toEqual([line]);
  });

  test("not stalled: a 4-minute dip in work that's otherwise on track, as each 10 minutes still earns half its rate", () => {
    // 30 a minute (0.5/s), but nothing from minute 8 to 11: 180 over any 10 minutes, over the 150 that counts.
    factionRun({ reputation: (minute) => 30 * (minute - Math.max(0, Math.min(minute, 11) - 7)) });
    expect(report().failures).toEqual([]);
  });

  test("not stalled with no choice stored (the owner's work, or the switch off)", () => {
    factionRun({ reputation: () => 5, chosenAtMs: null });
    expect(report().failures).toEqual([]);
  });

  test("not stalled across a gap in the slow snapshots, which starts the clock again", () => {
    // Flat throughout, but a 5-minute gap at minutes 8 to 12: 7 minutes flat before, 8 after.
    factionRun({ reputation: () => 5, skipSlow: (minute) => minute >= 8 && minute <= 12 });
    expect(report().failures).toEqual([]);
  });

  test("stale readings that jump at the page's 10-minute refresh are a stall all the same", () => {
    factionRun({ reputation: (minute) => 100 + 25 * Math.floor(minute / 10) });
    expect(report().failures).toEqual([expect.stringContaining(`from ${at(MINUTE)} to ${at(20 * MINUTE)}`)]);
  });

  test("the stretch starts where the first window under the rate starts: work that stops at minute 10, from minute 6", () => {
    // On track to minute 10, then 1 a minute: the window from minute 5 (150) to 15 (305) still earns 155; the one from
    // minute 6 (180 to 306) is the first under 150.
    factionRun({ reputation: (minute) => (minute <= 10 ? minute * 30 : 300 + (minute - 10)) });
    expect(report().failures).toEqual([
      expect.stringContaining(`from ${at(6 * MINUTE)} to ${at(20 * MINUTE)} (14 min)`),
    ]);
  });

  test("not stalled across a stop and a choice again: the clock starts with the new choice", () => {
    // Flat from minute 1 to 14: 13 minutes, but stopped and chosen again at 5 min, so 8 from the next slow snapshot.
    factionRun({ reputation: () => 5, skipSlow: (minute) => minute > 14 });
    event(5 * MINUTE + 1, "factionWorkStopped", { reason: "your work on the dashboard" });
    event(5 * MINUTE + 2, "factionWorkChosen", CHOICE);
    expect(report().failures).toEqual([]);
  });

  test("not stalled across a brain start, which ends the brain's choice", () => {
    factionRun({ reputation: () => 5 });
    event(6 * MINUTE, "brainStarted", { release: "r" });
    expect(report().failures).toEqual([]);
  });
});

describe("augmentations and the reset (#210)", () => {
  /**
   * A run: the brain's events, `installedAtMs` the first slow snapshot with another `lastAugReset` (BitWire and two
   * more NeuroFlux Governor levels installed), or none.
   */
  function augmentationRun({
    events: augmentationEvents,
    installedAtMs = null,
  }: {
    events: [number, string, unknown][];
    installedAtMs?: number | null;
  }) {
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      snapshot("medium", offsetMs, mediumData({ money: offsetMs }));
    }
    for (let offsetMs = 30 * SECOND; offsetMs <= RUN_MS; offsetMs += MINUTE) {
      const installed = installedAtMs !== null && offsetMs >= installedAtMs;
      // NeuroFlux Governor at level 1 before (installed in an earlier cycle), 3 after: two levels this install.
      const data = slowData([], installed ? { BitWire: 1, "NeuroFlux Governor": 3 } : { "NeuroFlux Governor": 1 });
      if (installed) data.resetInfo.lastAugReset = T0 + installedAtMs;
      snapshot("slow", offsetMs, data);
    }
    for (const [offsetMs, kind, detail] of augmentationEvents) event(offsetMs, kind, detail);
    return runReport(store, { environment: "E0", sinceMs: T0, untilMs: T0 + RUN_MS });
  }
  const CHOSEN = {
    set: [{ augmentation: "BitWire", price: 10e6 }],
    cost: 10e6,
    queued: [],
    onlineMs: 2 * 3_600_000,
    affordable: 1,
    affordableWithNeuroFlux: 3,
    bar: 7,
    barWithNeuroFlux: 11,
    reason: "nothing left",
  };

  test("each decision, purchase, install sent and install seen, in time order; nothing failing", () => {
    const report = augmentationRun({
      events: [
        [5 * MINUTE, "augmentationInstallChosen", CHOSEN],
        [
          6 * MINUTE,
          "augmentationBought",
          { augmentation: "BitWire", faction: "CyberSec", level: 1, price: 10e6, queueLength: 1 },
        ],
        [
          6 * MINUTE + SECOND,
          "augmentationBought",
          { augmentation: "NeuroFlux Governor", faction: "CyberSec", level: 2, price: 1_425_000, queueLength: 3 },
        ],
        [
          8 * MINUTE,
          "augmentationInstallSent",
          { source: "brain", queued: ["BitWire", "NeuroFlux Governor", "NeuroFlux Governor"] },
        ],
        [8 * MINUTE + 5 * SECOND, "agentDisconnected", { agentSessionId: "session-1" }],
        [8 * MINUTE + 8 * SECOND, "agentConnected", { agentSessionId: "session-2" }],
      ],
      installedAtMs: 8 * MINUTE + 30 * SECOND,
    });
    expect(report.text).toContain(
      [
        "  augmentations (the brain's install decisions and purchases, and the installs):",
        `    ${at(5 * MINUTE)}  install chosen, 2.0 h online this cycle: buying BitWire ($10,000,000); nothing else worth installing at the joined factions`,
        `    ${at(6 * MINUTE)}  bought BitWire from CyberSec for $10,000,000 (queue 1)`,
        `    ${at(6 * MINUTE + SECOND)}  bought NeuroFlux Governor (level 2) from CyberSec for $1,425,000 (queue 3)`,
        `    ${at(8 * MINUTE)}  install sent (the brain's): BitWire, NeuroFlux Governor ×2`,
        `    ${at(8 * MINUTE + 30 * SECOND)}  installed (seen in a slow snapshot): BitWire, NeuroFlux Governor ×2; ` +
          "hacking ×1.071, hacking_speed ×1.020, hacking_money ×1.020, hacking_grow ×1.020, hacking_chance ×1.020, " +
          `hacking_exp ×1.020, faction_rep ×1.020; the Agent disconnected at ${at(8 * MINUTE + 5 * SECOND)} and was back 3 s later`,
      ].join("\n"),
    );
    expect(report.text).toContain("  augmentation purchases reported done and never queued:\n    none");
    expect(report.text).toContain("  installs reported done with no reset in the next slow snapshot:\n    none");
    expect(report.text).toContain(
      "  installs sent and not seen done (a slow snapshot with another reset) within 5 min:\n    none",
    );
    expect(report.failures.filter((failure) => /augmentation|install/.test(failure))).toEqual([]);
    // In section 3, not section 1's timeline.
    expect(report.text).not.toContain("augmentationBought:");
  });

  test("none: said so", () => {
    expect(augmentationRun({ events: [] }).text).toContain(
      "  augmentations (the brain's install decisions and purchases, and the installs):\n    none",
    );
  });

  test("a purchase not queued, and an install sent with no reset within 5 minutes: each a failure", () => {
    const report = augmentationRun({
      events: [
        [
          5 * MINUTE,
          "augmentationNotQueued",
          { augmentation: "NeuroFlux Governor", level: 3, boughtAtMs: T0 + 3 * MINUTE },
        ],
        [6 * MINUTE, "augmentationInstallSent", { source: "manual", queued: ["BitWire"] }],
      ],
    });
    expect(report.failures).toContain(
      `augmentation not queued: NeuroFlux Governor (level 3), reported bought at ${at(3 * MINUTE)}, not in the ` +
        `faction state's queue by ${at(5 * MINUTE)}`,
    );
    expect(report.failures).toContain(
      `install not seen done: sent at ${at(6 * MINUTE)}, no slow snapshot with another reset 5 min on`,
    );
    expect(report.text).toContain(`${at(6 * MINUTE)}  install sent (yours): BitWire`);
  });

  test("an install sent, then withdrawn (the cycle called off) before its reset was due: no failure", () => {
    const report = augmentationRun({
      events: [
        [6 * MINUTE, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] }],
        [6 * MINUTE + SECOND, "augmentationCycleCalledOff", { reason: "the Augmentations switch turned off" }],
      ],
    });
    expect(report.failures.filter((failure) => failure.startsWith("install not seen done"))).toEqual([]);
    expect(report.text).toContain(
      `    install sent at ${at(6 * MINUTE)}, withdrawn at ${at(6 * MINUTE + SECOND)}: not a failure`,
    );
    expect(report.text).toContain(
      `${at(6 * MINUTE + SECOND)}  install cycle called off: the Augmentations switch turned off`,
    );
  });

  test("an install reported done with no reset after it: a failure, once (#213 re-review)", () => {
    const report = augmentationRun({
      events: [
        [6 * MINUTE, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] }],
        [7 * MINUTE, "augmentationInstallNotReset", { queued: ["BitWire"] }],
        [
          7 * MINUTE,
          "augmentationCycleCalledOff",
          { reason: "the install was reported done but the game didn't reset" },
        ],
      ],
    });
    expect(report.failures.filter((failure) => /install/.test(failure))).toEqual([
      `install reported done but the game didn't reset: at ${at(7 * MINUTE)}, with the faction state's queue BitWire`,
    ]);
    expect(report.text).toContain(
      `    install sent at ${at(6 * MINUTE)}, reported done with no reset at ${at(7 * MINUTE)}: the failure above`,
    );
    expect(report.text).toContain(
      `${at(7 * MINUTE)}  install reported done but the game didn't reset (queue: BitWire)`,
    );
  });

  test("called off after the 5 minutes: the install not seen done is a failure all the same", () => {
    const report = augmentationRun({
      events: [
        [2 * MINUTE, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] }],
        [9 * MINUTE, "augmentationCycleCalledOff", { reason: "the Augmentations switch turned off" }],
      ],
    });
    expect(report.failures.filter((failure) => failure.startsWith("install not seen done"))).toHaveLength(1);
  });

  test("an install chosen says why: the count reached, a quick install; an earlier brain's as main read it", () => {
    const report = augmentationRun({
      events: [
        [2 * MINUTE, "augmentationInstallChosen", { ...CHOSEN, reason: "count reached", affordable: 7 }],
        [3 * MINUTE, "augmentationInstallChosen", { ...CHOSEN, reason: "quick install", onlineMs: 12 * MINUTE }],
        [
          4 * MINUTE,
          "augmentationInstallChosen",
          {
            set: CHOSEN.set,
            cost: CHOSEN.cost,
            queued: [],
            sinceResetMs: 87.5 * 3_600_000,
            rebuildMs: 3_600_000,
            without: { augmentation: "DataJack", faction: "NiteSec", ms: 15 * 3_600_000 },
            with: { augmentation: "DataJack", faction: "NiteSec", ms: 3.3 * 3_600_000 },
            reason: "sooner installing",
          },
        ],
        [
          5 * MINUTE,
          "augmentationInstallChosen",
          { set: CHOSEN.set, cost: CHOSEN.cost, sinceResetMs: 3_600_000, reason: "nothing reachable" },
        ],
        // Older still (before #213's review), no reason: none carrying on is nothing left, as main inferred it.
        [
          6 * MINUTE,
          "augmentationInstallChosen",
          { set: CHOSEN.set, cost: CHOSEN.cost, sinceResetMs: 3_600_000, without: null },
        ],
      ],
    });
    expect(report.text).toContain(
      "install chosen, 2.0 h online this cycle: buying BitWire ($10,000,000); the count reached: 7 of 7 new " +
        "augmentations affordable (3 of 11 with NeuroFlux)",
    );
    expect(report.text).toContain(
      "install chosen, 12 min online this cycle: buying BitWire ($10,000,000); a quick install, within 20 min of the " +
        "last install: 1 of 7 new augmentations affordable (3 of 11 with NeuroFlux)",
    );
    expect(report.text).toContain(
      "install chosen, 87.5 h since the last: buying BitWire ($10,000,000); the next sooner installing (3.3 h against " +
        "15.0 h, DataJack)",
    );
    expect(report.text).toContain(
      "install chosen, 1.0 h since the last: buying BitWire ($10,000,000); nothing else reachable at a joined faction's " +
        "work (a reputation rate of 0)",
    );
    expect(report.text).toContain(
      `${at(6 * MINUTE)}  install chosen, 1.0 h since the last: buying BitWire ($10,000,000); nothing else worth ` +
        "installing at the joined factions",
    );
  });

  /** An `augmentationProgress` (#222) for the cycle the run's slow snapshots show (`lastAugReset` 0). */
  const progress = (fields: Record<string, unknown> = {}) => ({
    lastAugReset: 0,
    affordable: 1,
    affordableWithNeuroFlux: 3,
    bar: 8,
    barWithNeuroFlux: 12,
    onlineMs: 1.2 * 3_600_000,
    barFallsInMs: 0.8 * 3_600_000,
    barWithNeuroFluxFallsInMs: 0.8 * 3_600_000,
    reason: null,
    countdown: null,
    held: null,
    ...fields,
  });

  test("the count rule's progress (#222): the counts, the bars' next falls, the countdown and a hold, in time order", () => {
    const report = augmentationRun({
      events: [
        [3 * MINUTE, "augmentationProgress", progress()],
        [
          4 * MINUTE,
          "augmentationProgress",
          progress({
            affordableWithNeuroFlux: 4,
            onlineMs: 12 * MINUTE,
            reason: "quick install",
            countdown: { endsAtGameMs: 1, endsInMs: 30_000, quick: true, extensions: 0 },
          }),
        ],
        [5 * MINUTE, "augmentationProgress", progress({ held: "The Red Pill: Daedalus's reputation 1 of 2" })],
        [6 * MINUTE, "augmentationProgress", { lastAugReset: 0 }],
      ],
    });
    expect(report.text).toContain(
      [
        `    ${at(3 * MINUTE)}  progress: 1 of 8 new augmentations affordable (3 of 12 with NeuroFlux), 1.2 h online ` +
          "this cycle; the bar falls to 7 in 48 min",
        `    ${at(4 * MINUTE)}  progress: 1 of 8 new augmentations affordable (4 of 12 with NeuroFlux), 12 min online ` +
          "this cycle; the bar falls to 7 in 48 min; install countdown (a quick install), 30 s left",
        `    ${at(5 * MINUTE)}  progress: 1 of 8 new augmentations affordable (3 of 12 with NeuroFlux), 1.2 h online ` +
          "this cycle; the bar falls to 7 in 48 min; held: The Red Pill: Daedalus's reputation 1 of 2",
        `    ${at(6 * MINUTE)}  progress: the counts not stored`,
      ].join("\n"),
    );
    expect(report.text).not.toContain("augmentationProgress:");
    expect(report.text).toContain("  install overdue (a cycle 16.0 h online with no install chosen):\n    none");
  });

  /** 16.2 h online by the brain's clock, nothing affordable: the bar at 1, with NeuroFlux 4. */
  const OVERDUE = progress({
    affordable: 0,
    affordableWithNeuroFlux: 0,
    bar: 1,
    barWithNeuroFlux: 4,
    onlineMs: 16.2 * 3_600_000,
    barFallsInMs: null,
    barWithNeuroFluxFallsInMs: 1.8 * 3_600_000,
  });
  const OVERDUE_LINE =
    `install overdue: 16.2 h online in the cycle seen from ${at(30 * SECOND)} to ${at(19 * MINUTE + 30 * SECOND)}, ` +
    "and no install chosen; its last counts: 0 of 1 new augmentations affordable (0 of 4 with NeuroFlux), 16.2 h " +
    "online this cycle; the bar is 1, and with NeuroFlux falls to 3 in 1.8 h";
  const overdueFailures = (report: { failures: string[] }) =>
    report.failures.filter((failure) => failure.startsWith("install overdue"));

  test("install overdue (#222): a cycle 16 h online by the brain's clock with no install chosen fails, naming its counts", () => {
    const report = augmentationRun({ events: [[3 * MINUTE, "augmentationProgress", OVERDUE]] });
    expect(overdueFailures(report)).toEqual([OVERDUE_LINE]);
    expect(report.text).toContain(
      `  install overdue (a cycle 16.0 h online with no install chosen):\n    ${OVERDUE_LINE}`,
    );
    // Under 16 h: none.
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    const under = augmentationRun({
      events: [[3 * MINUTE, "augmentationProgress", { ...OVERDUE, onlineMs: 16 * 3_600_000 - 1 }]],
    });
    expect(overdueFailures(under)).toEqual([]);
  });

  test("install overdue: not with an install chosen in the cycle; another cycle's clock doesn't count", () => {
    const chosen = augmentationRun({
      events: [
        [3 * MINUTE, "augmentationProgress", OVERDUE],
        [10 * MINUTE, "augmentationInstallChosen", CHOSEN],
      ],
    });
    expect(overdueFailures(chosen)).toEqual([]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    const otherCycle = augmentationRun({
      events: [[3 * MINUTE, "augmentationProgress", { ...OVERDUE, lastAugReset: 5 }]],
    });
    expect(overdueFailures(otherCycle)).toEqual([]);
  });

  test("install overdue: shown, not counted, while The Red Pill's way held the rule, or with the switch off", () => {
    const held = augmentationRun({
      events: [
        [3 * MINUTE, "augmentationProgress", { ...OVERDUE, held: "The Red Pill: Daedalus's reputation 1 of 2" }],
      ],
    });
    expect(overdueFailures(held)).toEqual([]);
    expect(held.text).toContain("(held for The Red Pill's way: not a failure)");
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    writeAugmentationsEnabled(store, false);
    const off = augmentationRun({ events: [[3 * MINUTE, "augmentationProgress", OVERDUE]] });
    expect(overdueFailures(off)).toEqual([]);
    expect(off.text).toContain(
      "  install overdue (a cycle 16.0 h online with no install chosen): the Augmentations switch is off now, so " +
        `these are shown, not counted:\n    ${OVERDUE_LINE}`,
    );
  });

  test("install overdue by the slow snapshots' own clock (no progress recorded); a gap in the game's time left out", () => {
    /** Slow snapshots 3 minutes apart for 16 h, the game's time with them, but one step of 4 at `gapAfterMs`. */
    function longRun(gapAfterMs: number | null) {
      event(0, "brainStarted", { release: "r" });
      const untilMs = 16 * 3_600_000;
      let gameTimeMs = 1e12;
      for (let offsetMs = 0; offsetMs <= untilMs; offsetMs += 3 * MINUTE) {
        if (gapAfterMs !== null && offsetMs === gapAfterMs) gameTimeMs += MINUTE;
        snapshot("slow", offsetMs, slowData(), gameTimeMs);
        gameTimeMs += 3 * MINUTE;
      }
      return runReport(store, { environment: "E0", sinceMs: T0, untilMs: T0 + untilMs });
    }
    expect(overdueFailures(longRun(null))).toEqual([
      `install overdue: 16.0 h online in the cycle seen from ${at(0)} to ${at(16 * 3_600_000)}, and no install ` +
        "chosen; its last counts: none recorded",
    ]);
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
    // One 4-minute step: left out, so 15.95 h online, not overdue.
    expect(overdueFailures(longRun(3 * 3_600_000))).toEqual([]);
  });

  test("an install sent too near the window's end isn't judged; one the reset follows within 5 minutes passes", () => {
    const late = augmentationRun({
      events: [[RUN_MS - 4 * MINUTE, "augmentationInstallSent", { source: "brain", queued: [] }]],
    });
    expect(late.failures.filter((failure) => failure.startsWith("install not seen done"))).toEqual([]);
  });

  test("a reset more than 5 minutes after the install was sent is a failure all the same", () => {
    const report = augmentationRun({
      events: [[2 * MINUTE, "augmentationInstallSent", { source: "brain", queued: [] }]],
      installedAtMs: 8 * MINUTE,
    });
    expect(report.failures.filter((failure) => failure.startsWith("install not seen done"))).toHaveLength(1);
  });
});

describe("donations (#225)", () => {
  const DONATION_RUN_MS = 40 * MINUTE;
  /**
   * 40 minutes: CyberSec joined at 5,000 with `favor`, a slow snapshot a minute (the game's time with them), and the
   * money every 10 s with a `faction_rep` of 1; the brain's `events`. Cranial Signal Processors - Gen I (10,000, $70m)
   * is CyberSec's only augmentation short of its reputation with its prerequisites owned: $5,000,010,000 by donation.
   */
  function donationRun({
    events: donationEvents = [],
    money = 6e9,
    favor = 150,
  }: {
    events?: [number, string, unknown][];
    money?: number;
    favor?: number;
  } = {}) {
    event(0, "brainStarted", { release: "r" });
    for (let offsetMs = 10 * SECOND; offsetMs <= DONATION_RUN_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({ money });
      (data.player as Record<string, unknown>).mults = { faction_rep: 1 };
      snapshot("medium", offsetMs, data);
    }
    for (let offsetMs = MINUTE; offsetMs <= DONATION_RUN_MS; offsetMs += MINUTE) {
      const factions = factionState({ joined: [{ name: "CyberSec", reputation: 5_000, favor }] });
      snapshot("slow", offsetMs, slowData([], {}, {}, factions), 1e12 + offsetMs);
    }
    for (const [offsetMs, kind, detail] of donationEvents) event(offsetMs, kind, detail);
    return runReport(store, { environment: "E0", sinceMs: T0, untilMs: T0 + DONATION_RUN_MS });
  }
  const unused = (report: { failures: string[] }) =>
    report.failures.filter((failure) => failure.startsWith("donations unused"));
  const fresh = () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
    store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  };
  const UNUSED_LINE =
    "donations unused: Cranial Signal Processors - Gen I within reach at CyberSec by a donation ($5,000,010,000 and " +
    `its $70,000,000, with $6,000,000,000) for 30 min online from ${at(MINUTE)} to ${at(31 * MINUTE)}, and the brain ` +
    "counted none by donation, and bought, donated and chose to install nothing";

  test("donations unused: one within reach 30 min online, the brain counting none, fails once, naming it", () => {
    const report = donationRun();
    expect(unused(report)).toEqual([UNUSED_LINE]);
    expect(report.text).toContain(
      `  donations unused (one within reach 30 min online, counted by none):\n    ${UNUSED_LINE}`,
    );
    // The faction's favour, and its donations unlocked.
    expect(report.text).toContain(
      "    CyberSec: reputation 5,000 (unchanged), favour 150 (unchanged); donations unlocked",
    );
  });

  test("donations unused (#225 review): weighed against the money left after the brain's counted set", () => {
    // The brain's set spent $1b of the $6b on another augmentation (none by donation): Gen I's $5.07b isn't left.
    const spent = donationRun({
      events: [[30 * SECOND, "augmentationProgress", { lastAugReset: 0, byDonation: 0, affordable: 1, setCost: 1e9 }]],
    });
    expect(unused(spent)).toEqual([]);
    fresh();
    // A set that leaves enough: unused all the same.
    const room = donationRun({
      events: [[30 * SECOND, "augmentationProgress", { lastAugReset: 0, byDonation: 0, affordable: 1, setCost: 1e8 }]],
    });
    expect(unused(room)).toHaveLength(1);
  });

  test("donations unused: not with the brain counting one, acting, the money short, or the favour short", () => {
    const counting = donationRun({
      events: [[30 * SECOND, "augmentationProgress", { lastAugReset: 0, byDonation: 1, affordable: 1 }]],
    });
    expect(unused(counting)).toEqual([]);
    fresh();
    // Something donated at 20 min: the stretch starts again after it, 19 min to the end.
    const acted = donationRun({
      events: [
        [20 * MINUTE, "augmentationDonated", { faction: "NiteSec", amount: 1, reputation: 1, before: 0, after: 1 }],
      ],
    });
    expect(unused(acted)).toEqual([]);
    fresh();
    expect(unused(donationRun({ money: 5_070_009_999 }))).toEqual([]);
    fresh();
    const locked = donationRun({ favor: 149 });
    expect(unused(locked)).toEqual([]);
    // Its favour after the next install, and the reputation still to earn this cycle for donations.
    expect(locked.text).toContain(
      "    CyberSec: reputation 5,000 (unchanged), favour 149 (unchanged); 149.5 after the next install; donations " +
        "unlock at 150 favour, 4,559 more reputation this cycle",
    );
  });

  test("donations unused: shown, not counted, with the Augmentations switch off", () => {
    writeAugmentationsEnabled(store, false);
    const off = donationRun();
    expect(unused(off)).toEqual([]);
    expect(off.text).toContain(
      "  donations unused (one within reach 30 min online, counted by none): the Augmentations switch is off now, so " +
        `these are shown, not counted:\n    ${UNUSED_LINE}`,
    );
  });

  test("a donation not shown fails; each donation, its install chosen and the counts by donation read in section 3", () => {
    const donation = { faction: "CyberSec", amount: 5_000_010_000, reputation: 10_000 };
    const report = donationRun({
      events: [
        [
          2 * MINUTE,
          "augmentationProgress",
          { lastAugReset: 0, affordable: 1, affordableWithNeuroFlux: 1, bar: 8, barWithNeuroFlux: 12, byDonation: 1 },
        ],
        [
          3 * MINUTE,
          "augmentationInstallChosen",
          {
            set: [{ augmentation: "Cranial Signal Processors - Gen I", price: 70e6 }],
            cost: 70e6,
            queued: [],
            onlineMs: 2 * 3_600_000,
            reason: "nothing left",
            donations: [donation],
          },
        ],
        [4 * MINUTE, "augmentationDonated", { ...donation, before: 5_000, after: 10_000.01 }],
        [9 * MINUTE, "augmentationDonationFailed", { ...donation, shown: 5_000, donatedAtMs: T0 + 6 * MINUTE }],
      ],
    });
    expect(report.text).toContain(
      `    ${at(2 * MINUTE)}  progress: 1 of 8 new augmentations affordable (1 of 12 with NeuroFlux; 1 of them by donation)`,
    );
    expect(report.text).toContain(
      `    ${at(3 * MINUTE)}  install chosen, 2.0 h online this cycle: buying Cranial Signal Processors - Gen I ($70,000,000); ` +
        "nothing else worth installing at the joined factions; donating first: $5,000,010,000 to CyberSec (for 10,000 " +
        "reputation)",
    );
    expect(report.text).toContain(
      `    ${at(4 * MINUTE)}  donated $5,000,010,000 to CyberSec (for 10,000 reputation): reputation 5,000 → 10,000`,
    );
    const failed =
      `donation failed: $5,000,010,000 to CyberSec (for 10,000 reputation), reported done at ${at(6 * MINUTE)}, the ` +
      `faction state showing 5,000 by ${at(9 * MINUTE)}`;
    expect(report.failures).toContain(failed);
    expect(report.text).toContain(
      `  donations reported done and never shown in the faction's reputation:\n    ${failed}`,
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

describe("the World Daemon (#215)", () => {
  test("a clean run: the path as the last snapshots show it, and no stall", () => {
    cleanRun();
    const { text, failures } = report();
    expect(text).toContain(
      [
        "  the path to the World Daemon (as the window's last snapshots show it):",
        // The count said once, short of it, with what's within reach and where (#228).
        "    Daedalus: not joined; 1 of 30 augmentations installed, 24 more within reach (CyberSec 5, NiteSec 7, The " +
          "Black Hand 6, BitRunners 6); needs $1,201,000 of $100,000,000,000, hacking 12 of 2,500 (or every combat " +
          "skill 1,500)",
        "    The Red Pill: Daedalus not joined",
      ].join("\n"),
    );
    expect(text).toContain(
      "  the path to the World Daemon stalled (a step the brain finishes in minutes, not done in 5; or an install while " +
        "short of Daedalus's count that added none to it, passing over one that counts, #228, #238):\n    none",
    );
    expect(failures.filter((failure) => failure.startsWith("world daemon"))).toEqual([]);
    // In sections 3 and 4, not section 1's timeline.
    expect(text).not.toContain("worldDaemonStalled:");
  });

  test("The Red Pill installed: w0r1d_d43m0n's requirement and the ETA at the window's rate; a destroy sent; a stall fails", () => {
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
    snapshot("static", 10 * SECOND, { servers: [{ ...staticServer("w0r1d_d43m0n"), requiredHackingSkill: 3000 }] });
    snapshot("slow", 10 * SECOND, slowData([], { "The Red Pill": 1 }));
    // Hacking 2000 at about ×5, its experience rising 1e6 a second: the window measures it.
    const exp2000 = Math.exp(600 / 32) - 534.6;
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      const medium = mediumData({ money: 1e9, hacking: 2000 });
      snapshot("medium", offsetMs, {
        ...medium,
        player: { ...medium.player, exp: { hacking: exp2000 + offsetMs * 1_000 } },
        servers: [...medium.servers, { ...medium.servers[0], hostname: "w0r1d_d43m0n", maxRam: 0 }],
      });
    }
    event(15 * MINUTE, "worldDaemonStalled", {
      step: "destroy",
      sinceMs: T0 + 10 * MINUTE,
      detail: "w0r1d_d43m0n at its level (hacking 3,000 of 3,000), the BitNode not destroyed",
    });
    event(16 * MINUTE, "bitNodeDestroySent", { source: "brain", nextBitNode: 1 });
    const { text, failures } = report();
    // In sections 3 and 4, not section 1's timeline.
    expect(text).not.toMatch(/worldDaemonStalled|bitNodeDestroySent/);
    // At the multiplier the last snapshot implies (`skill.ts`), 3000 needs this much more experience.
    const lastExp = exp2000 + RUN_MS * 1_000;
    const multiplier = 2000 / (32 * Math.log(lastExp + 534.6) - 200);
    const eta = ((Math.exp((3000 / multiplier + 200) / 32) - 534.6 - lastExp) / 1e6 / 3600).toFixed(1);
    expect(text).toContain(
      [
        "    The Red Pill: installed",
        `    w0r1d_d43m0n: rooted; hacking 2,000 of 3,000: about ${eta} h at the measured experience rate`,
        `    ${at(16 * MINUTE)}  destroy sent (the brain's), into BitNode 1`,
      ].join("\n"),
    );
    expect(failures).toContain(
      "world daemon stalled: w0r1d_d43m0n at its level (hacking 3,000 of 3,000), the BitNode not destroyed, from " +
        `${at(10 * MINUTE)} to at least ${at(15 * MINUTE)}`,
    );
  });
});

describe("section 6's moves across a batcher's restart (#237's review)", () => {
  /**
   * A run whose batcher hacks phantasy until 5 minutes in, then restarts on n00dles, which it first hacks 17 minutes in:
   * 12 minutes without a hack, joined across the restart; or, with an install between (`installedAtMs`), not a move.
   */
  function restartedRun(installedAtMs: number | null) {
    const health = (offsetMs: number) => {
      const before = offsetMs < 5 * MINUTE;
      const lastHack = before
        ? { target: "phantasy", atMs: T0 + offsetMs }
        : offsetMs >= 17 * MINUTE
          ? { target: "n00dles", atMs: T0 + offsetMs }
          : null;
      return {
        ...newBatcherHealth(before ? "phantasy" : "n00dles", before ? "a" : "b", 0),
        state: "batching" as const,
        lastHack,
      };
    };
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          game: { money: offsetMs, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [] },
          batcher: health(offsetMs),
        }),
    });
    if (installedAtMs !== null) {
      const installed = slowData();
      installed.resetInfo.lastAugReset = T0 + installedAtMs;
      snapshot("slow", installedAtMs + 30 * SECOND, installed);
    }
  }

  test("joined across the restart: idle past 10 minutes, a failure", () => {
    restartedRun(null);
    const { text, failures } = report();
    expect(text).toMatch(/\n {4}phantasy → n00dles at \S+: idle 12\.\d min, across a restart\n/);
    expect(failures.some((failure) => failure.startsWith("batcher idle on a move: phantasy → n00dles"))).toBe(true);
  });

  test("an install between: a new cycle, not a move", () => {
    restartedRun(6 * MINUTE);
    const { text, failures } = report();
    expect(text).toContain("\n  moves (#236): none\n");
    expect(failures.filter((failure) => failure.startsWith("batcher idle on a move"))).toEqual([]);
  });
});

describe("a clock step or page stall behind the batcher's desyncs (#241, owner decision 55)", () => {
  /**
   * Run #3's real shape (2026-11-05, E0; #241's correction), on this file's clock: the Agent's rounds every 2 s from
   * 1.8 s (round k at 1.8 + 2k s), one of 3 s (round 380) during the recovery; Windows stepped the clock +2,678 ms, the
   * game's clock taking it up between rounds 353 and 354 (11:47.8, the fast interval 4.68 s on its clock and 2.00 s
   * received) and the brain's between 363 and 364 (12:07.8, the reverse); 1,615 desyncs on the-hub first seen at
   * 12:14.478 (16 late, 24 lost), the batcher recovering, then preparing, and batching again at 13:49.478, 95 s later,
   * in step to the end at 30 min. `noStep` leaves the clocks alone; `stallsAfter` makes each of those rounds 5 s long
   * on both clocks (a page stall); `mediumRetriedAt` fails the medium tier at that round and the next, the fast
   * snapshots after each saying so, and sends it the round after.
   */
  const END_MS = 30 * MINUTE;
  function incidentRun({ noStep = false, stallsAfter = [] as number[], mediumRetriedAt = null as number | null } = {}) {
    const rounds: { round: number; receivedMs: number; gameMs: number }[] = [];
    let trueMs = 1_800;
    for (let round = 0; trueMs <= END_MS; round++) {
      const gameMs = trueMs + (!noStep && round >= 354 ? 2_678 : 0);
      const receivedMs = trueMs + (!noStep && round >= 364 ? 2_678 : 0);
      rounds.push({ round, receivedMs, gameMs });
      trueMs += stallsAfter.includes(round) ? 5_000 : round === 380 ? 3_000 : 2_000;
    }
    const OUT = { desyncs: 1615, outOfOrder: 1615, late: 16, lost: 24 };
    const health = (round: number) => {
      const [state, counts] =
        round < 365
          ? (["batching", {}] as const)
          : round === 365
            ? (["recovering", { desyncs: 1000, outOfOrder: 1000 }] as const)
            : round < 395
              ? (["recovering", OUT] as const)
              : round < 412
                ? (["preparing", OUT] as const)
                : (["batching", OUT] as const);
      return { ...newBatcherHealth("the-hub", "r1", 0), state, batchesStarted: round, ...counts };
    };
    event(0, "brainStarted", { release: "r" });
    event(SECOND, "agentConnected", { agentSessionId: "session-1", deploymentId: "dep", game: { version: "3.0.1" } });
    const servers = [
      { ...staticServer("home"), purchasedByPlayer: true, moneyMax: 0 },
      staticServer("the-hub", { requiredHackingSkill: 300, minDifficulty: 20 }),
    ];
    snapshot("static", 1_800, { servers }, T0 + 1_800);
    for (const { round, receivedMs, gameMs } of rounds) {
      const retried = mediumRetriedAt !== null && round > mediumRetriedAt && round <= mediumRetriedAt + 2;
      const degradedTiers: FastSnapshotData["degradedTiers"] = retried ? ["medium"] : [];
      snapshot("fast", receivedMs, fastData({ batcher: health(round), degradedTiers }), T0 + gameMs);
      const sendsMedium =
        mediumRetriedAt === null
          ? round % 5 === 0
          : round === mediumRetriedAt + 2 || (round % 5 === 0 && round !== mediumRetriedAt);
      if (!sendsMedium) continue;
      const medium = mediumData({ money: 1_000 + receivedMs });
      const player = {
        ...medium.player,
        skills: { hacking: 600, intelligence: 0 },
        mults: { hacking_chance: 1, hacking_speed: 1, hacking_money: 1, hacking_grow: 1 },
      };
      snapshot("medium", receivedMs, { ...medium, player }, T0 + gameMs);
    }
  }
  const incidentWindow = { environment: "E0", sinceMs: T0, untilMs: T0 + END_MS + 30 * SECOND } as const;
  const STEP_LINE =
    `    clock step +2.7 s from ${at(707_800)} to ${at(732_478)}: the game's clock +2.7 s between snapshots at ` +
    `${at(707_800)} and ${at(709_800)}, the brain's +2.7 s between ${at(727_800)} and ${at(732_478)}`;
  const WARNING =
    "batcher out of step after a clock step: 1615 desyncs (1615 out of order, 0 out of bounds), 16 late, 24 lost on " +
    `the-hub, the first seen at ${at(734_478)}, after a clock step of +2.7 s from ${at(707_800)} to ${at(732_478)} ` +
    `(within a weaken there, 7 min 57 s); recovered in 1 min 35 s: batching again at ${at(829_478)}, and nothing out ` +
    "of step in the 10 min after";

  test("run #3: the clock step in section 4, the desyncs put down to it, recovered: WARN, not FAIL", () => {
    incidentRun();
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([WARNING]);
    expect(text).toContain(`within an hour fail):\n${STEP_LINE}\n  income stalls`);
    expect(text).toContain(`\n  ${WARNING}\n`);
    expect(text.split("\n").slice(-2)).toEqual(["Verdict: WARN", `  warning: ${WARNING}`]);
  });

  test("the same desyncs with the clocks steady: FAIL, as before", () => {
    incidentRun({ noStep: true });
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(warnings).toEqual([]);
    expect(failures).toEqual([
      "batcher out of step: 1615 desyncs (1615 out of order, 0 out of bounds), 16 late, 24 lost on the-hub, the " +
        `first seen at ${at(731_800)}; no clock step or page stall before it`,
    ]);
    expect(text).toMatch(/3 or more within an hour fail\):\n {4}none\n/);
  });

  test("a move of the clocks' gap over a restart isn't a step: FAIL then", () => {
    incidentRun();
    event(708_500, "deployed", { deploymentId: "dep-c", replacedDeploymentId: "dep" });
    event(729_000, "deployed", { deploymentId: "dep-d", replacedDeploymentId: "dep-c" });
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(warnings).toEqual([]);
    expect(text).not.toContain(STEP_LINE);
    expect(failures).toEqual([expect.stringMatching(/; no clock step or page stall before it$/)]);
  });

  test("a medium snapshot retried twice (14 s apart on both clocks, fast snapshots saying so) is no stall", () => {
    incidentRun({ noStep: true, mediumRetriedAt: 400 });
    const { text } = runReport(store, incidentWindow);
    expect(text).toMatch(/3 or more within an hour fail\):\n {4}none\n/);
  });

  test("the step and 2 page stalls within an hour: FAIL, the batcher's warning still listed", () => {
    incidentRun({ stallsAfter: [600, 750] });
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(text).toContain(
      `\n    page stalled ~3.0 s from ${at(1_205_478)} to ${at(1_210_478)} (cause unknown): the fast snapshots 5.0 s ` +
        "apart on both clocks (2 s due); the medium snapshots 13.0 s apart on both clocks (10 s due)\n",
    );
    const tooMany =
      `clock steps or page stalls: 3 from ${at(707_800)} to ${at(1_513_478)}, 3 or more within an hour (1 clock ` +
      "step, 2 page stalls)";
    expect(failures).toEqual([tooMany]);
    expect(warnings).toEqual([WARNING]);
    expect(text.split("\n").slice(-3)).toEqual(["Verdict: FAIL", `  ${tooMany}`, `  warning: ${WARNING}`]);
  });

  test("the command exits 0 on WARN", () => {
    incidentRun();
    const output = execFileSync(
      process.execPath,
      [REPORT_CLI, "--data-dir", directory, "--since", at(0), "--until", at(END_MS + 30 * SECOND)],
      { encoding: "utf8", stdio: "pipe" },
    );
    expect(output).toContain(`Verdict: WARN\n  warning: ${WARNING}`);
  });
});
