// The run report (#185): each section from known snapshots and events, each failure turning the verdict to FAIL with
// its line, and its command's exit codes and default window. Over a store built here, never the owner's .data/.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUGMENTATION_NAMES,
  type FactionState,
  type FactionStateReading,
  type FastSnapshotData,
  type IntentOutcome,
  type MediumSnapshotData,
  newBatcherHealth,
  type SlowSnapshotData,
  type StaticSnapshotData,
  type WorkOutcome,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AugmentationTimeline } from "../src/augmentation-report.ts";
import { writeAugmentationsEnabled } from "../src/augmentations.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import { BitNodeCycles } from "../src/cycle-report.ts";
import { INCOME_STALLED_AFTER_MS } from "../src/dashboard/alerts.ts";
import { formatDuration } from "../src/gap-report.ts";
import { describeCeiling, type HackingCeiling, hackingCeiling } from "../src/hacking-ceiling.ts";
import {
  findIncomeStalls,
  inferHackTargets,
  RELOAD_LAG_MS,
  RELOAD_LEAD_MS,
  runReport as reportOf,
} from "../src/run-report.ts";
import { thinStore } from "../src/store-thinning.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { staticServer } from "./helpers/snapshot-fixtures.ts";

const REPORT_CLI = path.resolve(import.meta.dirname, "../src/report-cli.ts");
const T0 = Date.parse("2026-10-26T00:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
/** The BitNode and the cycle the slow snapshots show, unless said: an hour before the run (#244 review: not 1970). */
const RESET = T0 - 60 * MINUTE;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const context = { environment: "E0", release: "r" } as const;

let directory: string;
let store: TelemetryStore;
/** The snapshots not yet written: `flush` writes them in one transaction, before any report reads the store. */
let pending: Parameters<TelemetryStore["recordSnapshot"]>[1][] = [];
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "run-report-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  pending = [];
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
function snapshot(tier: string, offsetMs: number, data: unknown, gameTimeMs = 0, agentSessionId = "session-1") {
  pending.push({
    agentSessionId,
    tier,
    sequenceNumber: ++sequenceNumber,
    gameTimeMs,
    receivedAtMs: T0 + offsetMs,
    missedBefore: 0,
    data,
  });
}
/**
 * Writes the pending snapshots in one transaction (#244 review): one commit, so one sync to disk, a run's (a run is
 * hundreds of snapshots) rather than one each, which made this suite 100 s.
 */
function flush() {
  const each = pending;
  pending = [];
  if (each.length === 0) return;
  store.writeTransaction(() => {
    for (const row of each) store.recordSnapshot(context, row);
  });
}
/** The run report, after writing the pending snapshots. */
const runReport = (...args: Parameters<typeof reportOf>) => {
  flush();
  return reportOf(...args);
};
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
  resetInfo: { lastAugReset: RESET, lastNodeReset: RESET, currentNode: 1, ownedAugs, ownedSF, bitNodeOptions: {} },
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
/** The report of `window`; `verbose` (#245) lists section 3's every line, which the tests of those lines read. */
const report = (options: { verbose?: boolean } = {}) => runReport(store, window, options);

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
      "  brain starts: 1; Agent connections: 1, disconnections: 0; relaunches: 0; deploys: 1; save backups: 1; data " +
        "backups: 0\n",
    ]) {
      expect(text).toContain(line);
    }
    // 2. Progress, the player's own servers left out of the rooted count and the target.
    for (const line of [
      "\n    money: $11,000 → $1,201,000",
      "\n    hacking: 1 → 12",
      "\n    other skills: strength 1 → 1",
      "\n    home RAM: 8 GB → 16 GB",
      "\n    home RAM used: 4 GB (unchanged)",
      "\n    TOR router: no → yes",
      "\n    port openers: none → BruteSSH.exe",
      "\n    the game's servers rooted: 1 → 2",
      // n00dles and pserv-0, then foodnstuff too (#194).
      // n00dles and the brain's pserv-0: foodnstuff isn't among the static snapshot's servers.
      "\n    the hack loop's hosts' RAM: 12 GB on 2 servers (unchanged)",
      "\n    city: Sector-12 (unchanged)",
      "\n    factions: none → CyberSec",
      "\n    jobs: none (unchanged)",
      "\n    installed augmentations: none → Neurotrainer I",
      "\n    BitNode: 1 (unchanged)",
      "\n    Source-Files: none → SF4.3",
      "\n    purchased servers: none → pserv-0",
      // The faction state (#197): reputation first → last, each invitation as first seen, the queue counted; under
      // its BitNode (#244).
      "    faction reputation and favour, first reading → last:\n      CyberSec: reputation 100 → 1,235, favour 0 " +
        "(unchanged)",
      `    faction invitations, as first seen:\n      CyberSec, ${at(10 * SECOND)}\n      Sector-12, ${at(RUN_MS)}`,
      `  BitNodes: BN1.1 from ${at(-60 * MINUTE)} (before the window), not destroyed, `,
      "  BN1.1, first snapshot → last:\n    money: $11,000 → $1,201,000\n",
      "\n    augmentations queued: none → NeuroFlux Governor ×2, BitWire",
      `    n00dles: ${at(20 * SECOND)} to ${at(RUN_MS)}`,
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain("hack loop target, inferred from");
    // 3. Actions, summarised (#245): the intent tried twice listed.
    for (const line of [
      "  intents: 1, by action and outcome (--verbose lists each):\n    buyTor: 1 done\n",
      `    buyTor(Alpha Enterprises): done after 2 tries (ui); done by ${at(60 * SECOND)}`,
      // pserv-0 was there from the first medium snapshot: not bought in the window (#194).
      "  cloud servers bought or upgraded (from the medium snapshots), the fleet by cycle (--verbose lists each):\n" +
        "    none",
      // The work: its changes counted, the one with a problem listed.
      "  work, as it changed, by cycle: each state counted, each problem listed (--verbose lists each):\n" +
        "    BN1.1 1: 3 changes: none wanted, not converged (sim), converged (sim)\n" +
        `      ${at(30 * SECOND)}  not converged (sim): busy\n`,
      `    ${at(12 * MINUTE)}  Noodle Bar: Waiter → Head Waiter`,
      "  dialogs handled, by kind, an alert by its first words (--verbose lists each):\n" +
        '    alert "Message received from unknown…": 1\n' +
        "  dialogs not handled (left blocking the page; section 4's failures):\n    none\n",
    ]) {
      expect(text).toContain(line);
    }
    // --verbose: each, quoted.
    expect(report({ verbose: true }).text).toContain(
      `    ${at(3 * MINUTE)}  alert: "Message received from unknown sender: I know you can sense i…"`,
    );
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
    const { text } = report({ verbose: true });
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
      "\n    money: unknown (unchanged)",
      "\n    hacking: unknown (unchanged)",
      "\n    home RAM: unknown (unchanged)",
      "\n    home RAM used: 4.5 GB → unknown",
      // No static snapshot: which servers are the game's isn't known (#194).
      "\n    the hack loop's hosts' RAM: unknown (no static snapshot) (unchanged)",
      "\n    city: unknown (unchanged)",
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
      "  BitNode not recorded, first snapshot → last:\n    no medium snapshot (the player and the servers) in the window",
      "\n    no slow snapshot (the BitNode, augmentations, Source-Files, purchased servers) in the window",
      "    none moved",
      "  intents: 0, by action and outcome (--verbose lists each):\n    none\n" +
        "  intents not done, done with a problem, or tried again for something besides their worker still at it:\n" +
        "    none",
      "  work, as it changed:\n    not reported",
      "  promotions:\n    none",
      "  dialogs handled, by kind, an alert by its first words (--verbose lists each):\n    none",
      "    invitations travelled for (Tian Di Hui, and the city group the brain chose, decision 54), by cycle " +
        "(--verbose lists each):\n      none",
      "    the brain's faction work, by cycle (--verbose lists each choice):\n      none",
      "  augmentations, by cycle: the set bought, NeuroFlux Governor's levels as one count (--verbose lists each " +
        "decision and purchase):\n    none",
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
    const { text, failures } = report({ verbose: true });
    expect(failures).toEqual([]);
    expect(text).toContain(
      "  cloud servers bought or upgraded (from the medium snapshots):\n" +
        `    ${at(5 * MINUTE)}  pserv-1 bought, 8 GB, $440,000\n` +
        `    ${at(12 * MINUTE)}  pserv-1 upgraded, 8 GB → 64 GB, $3,080,000\n` +
        "    in all: 1 bought, 1 upgraded, $3,520,000",
    );
    expect(text).toContain("\n    the hack loop's hosts' RAM: 12 GB on 2 servers → 76 GB on 3 servers\n");
    // The default (#245): the fleet, a line a cycle (no slow snapshot before the last: one cycle).
    expect(report().text).toContain(
      "  cloud servers bought or upgraded (from the medium snapshots), the fleet by cycle (--verbose lists each):\n" +
        `    BN1.1 1, ${at(5 * MINUTE)} to ${at(12 * MINUTE)}: 1 server, 8 GB → 2 servers, 72 GB (1 bought, ` +
        `1 upgraded, ` +
        "$3,520,000)\n    in all: 1 bought, 1 upgraded, $3,520,000",
    );
  });

  test("outside BN1, the price is unknown", () => {
    withPurchases(2);
    const { text } = report({ verbose: true });
    expect(text).toContain(`    ${at(5 * MINUTE)}  pserv-1 bought, 8 GB, price unknown in BitNode 2`);
    expect(text).toContain("    in all: 1 bought, 1 upgraded\n");
    expect(text).toContain("    the brain buys none in BitNode 2: cloud server prices are known only in BN1\n");
    expect(report().text).toContain(
      `    BN2.1 1, ${at(5 * MINUTE)} to ${at(12 * MINUTE)}: 1 server, 8 GB → 2 servers, 72 GB ` +
        `(1 bought, 1 upgraded)\n` +
        "    in all: 1 bought, 1 upgraded\n",
    );
  });

  test("in BN1, no word of other BitNodes' prices", () => {
    withPurchases(1);
    expect(report().text).not.toContain("the brain buys none");
  });

  test("a cloud server gone from the snapshots (an install deletes them) and bought again is bought again", () => {
    withPurchases(1, { gone: true });
    expect(report({ verbose: true }).text).toContain(
      `    ${at(16 * MINUTE)}  pserv-1 bought, 8 GB, $440,000\n    in all: 2 bought, 1 upgraded, $3,960,000`,
    );
    // The fleet from its size before the cycle's first change to after its last: pserv-0, and pserv-1 at 8 GB again.
    expect(report().text).toContain(
      `    BN1.1 1, ${at(5 * MINUTE)} to ${at(16 * MINUTE)}: 1 server, 8 GB → 2 servers, 16 GB (2 bought, ` +
        `1 upgraded, ` +
        "$3,960,000)\n",
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
  runMs = RUN_MS,
  money = () => 0,
  factions = () => factionState(),
}: {
  earning: (ceilings: Extract<HackingCeiling, { known: true }>) => number;
  relaunchAtMs?: number;
  relaunchFall?: number;
  /** How long it runs, `RUN_MS` unless said. */
  runMs?: number;
  /** The player's money in the medium snapshots (#245), 0 unless said. */
  money?: (offsetMs: number) => number;
  /** The slow snapshots' faction state (#245), nothing joined unless said; null for none, an older Agent. */
  factions?: (offsetMs: number) => FactionStateReading | null;
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
  for (let offsetMs = 10 * SECOND; offsetMs <= 10 * SECOND + runMs; offsetMs += 10 * SECOND) {
    snapshot("medium", offsetMs, { ...medium, player: { ...player, money: money(offsetMs) } });
    const count =
      1e9 + ((offsetMs - 10 * SECOND) / 1000) * earning(ceiling) - (offsetMs >= relaunchAtMs ? relaunchFall : 0);
    if ((offsetMs - 10 * SECOND) % MINUTE === 0) {
      // The game's time with it (#245): 2b's judgements count the time online by it.
      const slow = { ...slowData([], {}, {}, factions(offsetMs)), moneySources: { hacking: count } };
      snapshot("slow", offsetMs, slow, offsetMs);
    }
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
    expect(text).toContain("    faction reputation and favour, first reading → last:\n      never read");
    expect(text).toContain("    faction invitations, as first seen:\n      never read");
    expect(text).toContain("\n    augmentations queued: unknown (unchanged)\n");
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
    // By default (#245), a line a server; no slow snapshot, so no cycle to time it by.
    expect(report().text).toContain(
      "  backdoors (the hacker factions' servers, for their invitations; --verbose lists each change):\n" +
        "    CSEC: not backdoored at the window's start; backdoored 1 time; CyberSec's invitation 1 time\n" +
        "    avmnite-02h: not backdoored at the window's start\n",
    );
    const { text, failures } = report({ verbose: true });
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
      "    CSEC: not backdoored at the window's start; backdoored 1 time; no invitation from CyberSec seen",
    );
    expect(report({ verbose: true }).text).toContain(
      `    CSEC: not backdoored at the window's start; backdoored by ${at(MINUTE)}; no invitation from CyberSec seen`,
    );
  });

  test("one backdoored before the window: its invitation came before too", () => {
    hackerRun({ csec: () => ({ rooted: true, backdoored: true }) });
    expect(report().text).toContain("    CSEC: backdoored at the window's start\n");
    expect(report({ verbose: true }).text).toContain("    CSEC: backdoored at the window's start\n");
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
    expect(report().text).toContain(
      "    CSEC: backdoored at the window's start; backdoored 1 time; no invitation from CyberSec seen\n",
    );
    const { text, failures } = report({ verbose: true });
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
    expect(report({ verbose: true }).text).toContain(
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
    // The default (#245): the choices counted, in the cycle the slow snapshots show.
    expect(report().text).toContain(
      "    the brain's faction work, by cycle (--verbose lists each choice):\n" +
        "      BN1.1 1: 2 choices: hacking for CyberSec ×2; stopped 1 (your work on the dashboard)\n",
    );
    const { text, failures } = report({ verbose: true });
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
    const { text } = report({ verbose: true });
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
    // Each decision and purchase, as these tests read them: --verbose (#245).
    return runReport(store, { environment: "E0", sinceMs: T0, untilMs: T0 + RUN_MS }, { verbose: true });
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

  /** An `augmentationProgress` (#222) for the cycle the run's slow snapshots show (`lastAugReset` RESET). */
  const progress = (fields: Record<string, unknown> = {}) => ({
    lastAugReset: RESET,
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
        [6 * MINUTE, "augmentationProgress", { lastAugReset: RESET }],
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

  test("held for Daedalus's count (#243): the progress says so; it doesn't excuse a cycle overdue", () => {
    const words =
      "Daedalus's count reachable this cycle, The Black Hand in ~17 min (by work at The Black Hand, $1,111,159,900; " +
      "29 of 30 after this install; held 30 min at most, 30 min left)";
    const countHold = { augmentation: "The Black Hand", faction: "The Black Hand", way: "work", etaMs: 1, money: 1 };
    const report = augmentationRun({
      events: [
        [3 * MINUTE, "augmentationProgress", { ...OVERDUE, held: words, countHold: { ...countHold, leftMs: 1 } }],
      ],
    });
    expect(report.text).toContain(`; held: ${words}`);
    expect(overdueFailures(report)).toEqual([
      expect.stringMatching(/^install overdue: 16\.2 h online .*; held: Daedalus/),
    ]);
    expect(report.text).not.toContain("(held for The Red Pill's way: not a failure)");
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
    // Each donation, as these tests read them: --verbose (#245).
    return runReport(store, { environment: "E0", sinceMs: T0, untilMs: T0 + DONATION_RUN_MS }, { verbose: true });
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
      events: [
        [30 * SECOND, "augmentationProgress", { lastAugReset: RESET, byDonation: 0, affordable: 1, setCost: 1e9 }],
      ],
    });
    expect(unused(spent)).toEqual([]);
    fresh();
    // A set that leaves enough: unused all the same.
    const room = donationRun({
      events: [
        [30 * SECOND, "augmentationProgress", { lastAugReset: RESET, byDonation: 0, affordable: 1, setCost: 1e8 }],
      ],
    });
    expect(unused(room)).toHaveLength(1);
  });

  test("donations unused: not with the brain counting one, acting, the money short, or the favour short", () => {
    const counting = donationRun({
      events: [[30 * SECOND, "augmentationProgress", { lastAugReset: RESET, byDonation: 1, affordable: 1 }]],
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
          {
            lastAugReset: RESET,
            affordable: 1,
            affordableWithNeuroFlux: 1,
            bar: 8,
            barWithNeuroFlux: 12,
            byDonation: 1,
          },
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

describe("summaries by default, --verbose for the detail (#245)", () => {
  const BUSY_MS = 60 * MINUTE;
  const INSTALL_MS = 30 * MINUTE;
  const busyWindow = { environment: "E0", sinceMs: T0, untilMs: T0 + BUSY_MS + 30 * SECOND } as const;
  const CLOUD_SERVERS = 20;
  /**
   * The default report's most lines and characters for `busyRun` (#245): its own are 195 and 13,875; --verbose's
   * lines (909) are over 4 times the bound.
   */
  const BUSY_REPORT_LINES = 200;
  const BUSY_REPORT_CHARACTERS = 14_500;
  /**
   * pserv-index's RAM at `offsetMs`, or null where the medium snapshots don't show it: in cycle 1, each bought at 8 GB
   * a minute apart from 1 min, all upgraded to 32 GB at 25 min; the install at 30 min deletes them; in cycle 2, ten
   * bought at 64 GB at 40 min.
   */
  function cloudRam(index: number, offsetMs: number): number | null {
    if (offsetMs < INSTALL_MS) return offsetMs < (index + 1) * MINUTE ? null : offsetMs >= 25 * MINUTE ? 32 : 8;
    return index < 10 && offsetMs >= 40 * MINUTE ? 64 : null;
  }
  /** The n-th intent, given every 10 s and done at once: a cloud server bought, one upgraded and a travel, in turn. */
  const intentAt = (n: number) =>
    intent([`buyServer(pserv-${n}, 8)`, `upgradeServer(pserv-${n}, 16)`, `travel(City-${n})`][n % 3] as string, {
      done: true,
    });
  const choice = (faction: string) => ({
    faction,
    workType: "hacking",
    augmentation: "Neurotrainer I",
    reputation: 2,
    reputationNeeded: 1_000,
    reputationPerSecond: 0.5,
    etaSeconds: 1_996,
  });
  /** A ui backdoor's first try, which starts it and returns (`ingame/src/workers/backdoor-standing.ts:36`). */
  const STARTED = (hostname: string) => `installing the backdoor on ${hostname}: about 30 s left`;
  /**
   * The work at `offsetMs`: a new work wanted every 5 minutes, "not converged" with no problem until its first try (a
   * fast snapshot), then converged; at 33 min, a dialog left for the owner in the way for 3 snapshots.
   */
  function workAt(offsetMs: number): WorkOutcome {
    if (offsetMs % (5 * MINUTE) === 0) return { converged: false, problem: null, backend: null };
    if (offsetMs >= 33 * MINUTE && offsetMs < 33 * MINUTE + 6 * SECOND) {
      return { converged: false, problem: "a dialog the Agent leaves for the owner is open", backend: "ui" };
    }
    return { converged: true, problem: null, backend: "ui" };
  }
  const invitation = (offsetMs: number, phase: string, city: string, factions: string[]) =>
    event(offsetMs, "invitationTravel", { phase, city, factions, money: 2e8, installed: 3, required: 30 });

  /**
   * An hour's busy run, an install at 30 min (run #3's report, 3,270 lines, in small): 375 intents (10 of them ui
   * backdoors done on the try after the one that started them, one tried again for a real problem), 30 cloud servers
   * bought and 20 upgraded, 62 augmentations bought (60 of them NeuroFlux Governor levels), 120 dialogs, 26 changes of
   * work, 30 faction work choices, 11 invitation events, an augmentation progress a minute, and the batcher on n00dles,
   * then joesguns. And five failures: a cloud purchase done with a problem, a dialog left blocking, a donation not
   * shown, an install with no reset, and a hold with no invitation.
   */
  function busyRun() {
    event(0, "brainStarted", { release: "r" });
    snapshot("static", 10 * SECOND, staticData());
    for (let offsetMs = 10 * SECOND; offsetMs <= BUSY_MS; offsetMs += 2 * SECOND) {
      const intents: IntentOutcome[] = [];
      if (offsetMs % (10 * SECOND) === 0) intents.push(intentAt(offsetMs / (10 * SECOND) - 1));
      for (let index = 0; index < 10; index++) {
        const startedMs = 2 * MINUTE + index * 20 * SECOND;
        const hostname = `server-${index}`;
        if (offsetMs === startedMs) {
          intents.push(intent(`backdoor(${hostname})`, { problem: STARTED(hostname), backend: "ui" }));
        }
        if (offsetMs === startedMs + 2 * SECOND) {
          intents.push(intent(`backdoor(${hostname})`, { done: true, tries: 2, backend: "ui" }));
        }
      }
      if (offsetMs === 8 * MINUTE) {
        intents.push(intent("backdoor(phantasy)", { problem: "couldn't connect to max-hardware", backend: "ui" }));
      }
      if (offsetMs === 8 * MINUTE + 2 * SECOND) {
        intents.push(intent("backdoor(phantasy)", { done: true, tries: 2, backend: "ui" }));
      }
      if (offsetMs >= 5 * MINUTE && offsetMs <= 5 * MINUTE + 10 * SECOND) {
        const done = offsetMs === 5 * MINUTE + 10 * SECOND;
        intents.push(intent("travel(Aevum)", { done, tries: done ? 2 : 1, problem: done ? null : "no Travel button" }));
      }
      // Tried again with nothing reported: why isn't known, so listed.
      if (offsetMs === 6 * MINUTE) intents.push(intent("travel(Volhaven)"));
      if (offsetMs === 6 * MINUTE + 2 * SECOND) intents.push(intent("travel(Volhaven)", { done: true, tries: 2 }));
      if (offsetMs === 12 * MINUTE) {
        intents.push(intent("buyServer(pserv-x, 8)", { done: true, problem: "bought as pserv-x-0" }));
      }
      if (offsetMs >= 50 * MINUTE) intents.push(intent("backdoor(foodnstuff)", { tries: 2 }));
      const blocking =
        offsetMs >= 45 * MINUTE && offsetMs <= 45 * MINUTE + 4 * SECOND ? "A dialog nothing closed" : null;
      const target = offsetMs < 25 * MINUTE ? "n00dles" : "joesguns";
      snapshot(
        "fast",
        offsetMs,
        fastData({
          intents,
          dialogs: { handled: [], blocking },
          work: workAt(offsetMs),
          batcher: { ...newBatcherHealth(target, "run-a", 0), state: "batching" },
        }),
      );
    }
    for (let offsetMs = 10 * SECOND; offsetMs <= BUSY_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({
        money: 1e9 + offsetMs,
        factions: ["CyberSec", "NiteSec"],
        noodles: { money: offsetMs, security: 1 },
      });
      data.servers = data.servers.filter((server) => !server.hostname.startsWith("pserv-"));
      for (let index = 0; index < CLOUD_SERVERS; index++) {
        const maxRam = cloudRam(index, offsetMs);
        if (maxRam === null) continue;
        data.servers.push({
          hostname: `pserv-${index}`,
          maxRam,
          cpuCores: 1,
          hasAdminRights: true,
          backdoorInstalled: false,
          moneyAvailable: 0,
          hackDifficulty: 1,
        });
      }
      snapshot("medium", offsetMs, data);
    }
    const cloudNames = Array.from({ length: CLOUD_SERVERS }, (_, index) => `pserv-${index}`);
    for (let offsetMs = 30 * SECOND; offsetMs <= BUSY_MS; offsetMs += MINUTE) {
      const installed = offsetMs >= INSTALL_MS;
      const reputation = (1_000 * offsetMs) / MINUTE;
      const data = slowData(
        cloudNames,
        installed ? { "NeuroFlux Governor": 61, BitWire: 1, "Neurotrainer I": 1 } : { "NeuroFlux Governor": 1 },
        {},
        factionState({
          joined: [
            { name: "CyberSec", reputation, favor: 0 },
            { name: "NiteSec", reputation, favor: 0 },
          ],
        }),
      );
      if (installed) data.resetInfo.lastAugReset = T0 + INSTALL_MS;
      snapshot("slow", offsetMs, data, offsetMs);
    }
    // Cycle 1's install: chosen, two donations, BitWire, Neurotrainer I and 40 NeuroFlux Governor levels, sent.
    event(20 * MINUTE, "augmentationInstallChosen", {
      set: [{ augmentation: "BitWire", price: 10e6 }],
      cost: 10e6,
      queued: [],
      onlineMs: 20 * MINUTE,
      reason: "nothing left",
    });
    event(20 * MINUTE + 10 * SECOND, "augmentationDonated", {
      faction: "CyberSec",
      amount: 1e9,
      reputation: 5_000,
      before: 0,
      after: 5_000,
    });
    event(20 * MINUTE + 20 * SECOND, "augmentationDonated", {
      faction: "NiteSec",
      amount: 2e9,
      reputation: 6_000,
      before: 0,
      after: 6_000,
    });
    const bought = (offsetMs: number, augmentation: string, level: number, price: number) =>
      event(offsetMs, "augmentationBought", { augmentation, faction: "CyberSec", level, price, queueLength: level });
    bought(21 * MINUTE, "BitWire", 1, 10e6);
    bought(21 * MINUTE + SECOND, "Neurotrainer I", 1, 4e6);
    for (let level = 2; level <= 41; level++) bought(22 * MINUTE + level * SECOND, "NeuroFlux Governor", level, 1e6);
    event(29 * MINUTE, "augmentationInstallSent", { source: "brain", queued: ["BitWire", "Neurotrainer I"] });
    // Cycle 2's: 20 more levels, a donation not shown, and an install reported done with no reset.
    for (let level = 42; level <= 61; level++) bought(50 * MINUTE + level * SECOND, "NeuroFlux Governor", level, 2e6);
    event(55 * MINUTE, "augmentationDonationFailed", {
      faction: "CyberSec",
      amount: 3e9,
      reputation: 9_000,
      shown: 5_000,
      donatedAtMs: T0 + 54 * MINUTE,
    });
    for (let minute = 1; minute <= 60; minute++) event(minute * MINUTE + 5 * SECOND, "augmentationProgress", {});
    event(56 * MINUTE, "augmentationInstallNotReset", { queued: ["NeuroFlux Governor"] });
    // Yours, near the window's end: not judged for its reset.
    event(57 * MINUTE, "augmentationInstallSent", { source: "manual", queued: ["NeuroFlux Governor"] });
    // The invitations first, the messages more, then 3 Source-File alerts: counted the most first, alerts by their
    // first words.
    for (let n = 0; n < 20; n++) {
      event(n * 2 * MINUTE + 5 * SECOND, "gameDialog", {
        kind: "factionInvitation",
        text: "Would you like to join Sector-12?",
      });
    }
    for (let n = 0; n < 100; n++) {
      const text =
        n < 97
          ? `Message received from unknown sender: I know you can sense it. (${n})`
          : "You received a Source-File for destroying a BitNode!";
      event(n * 30 * SECOND + 15 * SECOND, "gameDialog", { kind: "alert", text });
    }
    // CyberSec first, NiteSec more: likewise.
    for (let minute = 1; minute <= 29; minute++) {
      event(minute * MINUTE + 1, "factionWorkChosen", choice(minute % 3 === 1 ? "CyberSec" : "NiteSec"));
    }
    event(31 * MINUTE + 1, "factionWorkStopped", { reason: "your work on the dashboard" });
    event(45 * MINUTE + 1, "factionWorkChosen", choice("CyberSec"));
    event(46 * MINUTE + 1, "factionWorkStopped", { reason: "your work on the dashboard" });
    // Invitations (#228): cycle 1's city group, travels, holds and invitations; cycle 2's hold with none.
    event(3 * MINUTE, "cityGroupChosen", { group: "B", factions: ["Chongqing", "New Tokyo", "Ishima"], values: [] });
    invitation(4 * MINUTE, "travel", "Ishima", ["Tian Di Hui"]);
    invitation(4 * MINUTE + 1, "hold", "Ishima", ["Tian Di Hui"]);
    invitation(6 * MINUTE, "invited", "Ishima", ["Tian Di Hui"]);
    invitation(7 * MINUTE, "travel", "Chongqing", ["Chongqing"]);
    invitation(9 * MINUTE, "travel", "Ishima", ["Ishima"]);
    invitation(9 * MINUTE + 1, "hold", "Ishima", ["Ishima"]);
    invitation(10 * MINUTE, "invited", "Ishima", ["Ishima"]);
    invitation(32 * MINUTE, "travel", "Ishima", ["Ishima"]);
    invitation(32 * MINUTE + 1, "hold", "Ishima", ["Ishima"]);
    invitation(37 * MINUTE + 1, "notInvited", "Ishima", ["Ishima"]);
  }
  const sectionOf = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

  test("the default: each block summarised, within a length bound; --verbose: every line", () => {
    busyRun();
    const brief = runReport(store, busyWindow);
    const verbose = runReport(store, busyWindow, { verbose: true });
    const lines = brief.text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(BUSY_REPORT_LINES);
    expect(brief.text.length).toBeLessThanOrEqual(BUSY_REPORT_CHARACTERS);
    expect(verbose.text.split("\n").length).toBeGreaterThan(4 * BUSY_REPORT_LINES);
    expect(lines[1]).toBe(
      "(summaries: --verbose lists each intent, cloud server bought or upgraded, change of work, dialog handled, " +
        "faction work choice, invitation travel, augmentation decision and purchase, and inferred hack target; #245)",
    );
    expect(verbose.text.split("\n")[1]).toBe("");
    const actions = sectionOf(brief.text, "3. Actions", "4. Health");
    for (const block of [
      // Intents: counts by action and outcome, the most first; a ui backdoor's second try routine (counted); then
      // each not done, with a problem, or tried again for something besides its worker still at it.
      "  intents: 375, by action and outcome (--verbose lists each):\n" +
        "    travel: 122 done\n" +
        "    buyServer: 121 done (1 with a problem)\n" +
        "    upgradeServer: 120 done\n" +
        "    backdoor: 11 done (10 tried again while still at it), 1 not done\n" +
        "  intents not done, done with a problem, or tried again for something besides their worker still at it:\n" +
        `    travel(Aevum): done after 2 tries (sim); done by ${at(5 * MINUTE + 10 * SECOND)}\n` +
        `    travel(Volhaven): done after 2 tries (sim); done by ${at(6 * MINUTE + 2 * SECOND)}\n` +
        `    backdoor(phantasy): done after 2 tries (ui); done by ${at(8 * MINUTE + 2 * SECOND)}\n` +
        `    buyServer(pserv-x, 8): done after 1 try (sim): bought as pserv-x-0; done by ${at(12 * MINUTE)}\n` +
        `    backdoor(foodnstuff): not done, 2 tries (sim); first seen ${at(50 * MINUTE)}\n`,
      // Cloud servers: the fleet, a line a cycle.
      "  cloud servers bought or upgraded (from the medium snapshots), the fleet by cycle (--verbose lists each):\n" +
        `    BN1.1 1, ${at(MINUTE)} to ${at(25 * MINUTE)}: none → 20 servers, 640 GB (20 bought, 20 upgraded, ` +
        "$35,200,000)\n" +
        `    BN1.1 2, at ${at(40 * MINUTE)}: none → 10 servers, 640 GB (10 bought, 0 upgraded, $35,200,000)\n` +
        "    in all: 30 bought, 20 upgraded, $70,400,000\n",
      // The work: its changes counted a cycle, each with a problem listed.
      "  work, as it changed, by cycle: each state counted, each problem listed (--verbose lists each):\n" +
        "    BN1.1 1: 11 changes: converged (ui) ×6, not converged ×5\n" +
        "    BN1.1 2: 15 changes: not converged ×7, converged (ui) ×7, not converged (ui)\n" +
        `      ${at(33 * MINUTE)}  not converged (ui): a dialog the Agent leaves for the owner is open\n`,
      // Dialogs: counts by kind, an alert by its first words, and any left blocking.
      "  dialogs handled, by kind, an alert by its first words (--verbose lists each):\n" +
        '    alert "Message received from unknown…": 97\n' +
        "    factionInvitation: 20\n" +
        '    alert "You received a Source-File…": 3\n' +
        "  dialogs not handled (left blocking the page; section 4's failures):\n" +
        `    from ${at(45 * MINUTE)} to ${at(45 * MINUTE + 4 * SECOND)}: "A dialog nothing closed"\n`,
      // Faction work: the choices counted, a line a cycle.
      "    the brain's faction work, by cycle (--verbose lists each choice):\n" +
        "      BN1.1 1: 29 choices: hacking for NiteSec ×19, hacking for CyberSec ×10\n" +
        "      BN1.1 2: 1 choice: hacking for CyberSec; stopped 2 (your work on the dashboard ×2)\n",
      // Invitations: a line a cycle; a hold with no invitation listed.
      "    invitations travelled for (Tian Di Hui, and the city group the brain chose, decision 54), by cycle " +
        "(--verbose lists each):\n" +
        "      BN1.1 1: city group B; 3 travels (Ishima ×2, Chongqing); 2 holds; invited: Tian Di Hui, Ishima\n" +
        "      BN1.1 2: 1 travel (Ishima); 1 hold; invited: none\n" +
        `        ${at(37 * MINUTE + 1)}  NOT INVITED 5 min into the hold in Ishima: Ishima (3 of 30 installed)\n`,
      // Augmentations: the set bought a cycle, NeuroFlux Governor's levels as one count, donations by faction; a
      // donation not shown, always.
      "  augmentations, by cycle: the set bought, NeuroFlux Governor's levels as one count (--verbose lists each " +
        "decision and purchase):\n" +
        "    BN1.1 1: bought 42 for $54,000,000: BitWire, Neurotrainer I, NeuroFlux Governor ×40 (levels 2–41); 1 " +
        "install chosen (nothing left); 2 donations: $1,000,000,000 to CyberSec, $2,000,000,000 to NiteSec; install " +
        "sent (the brain's)\n" +
        "    BN1.1 2: bought 20 for $40,000,000: NeuroFlux Governor ×20 (levels 42–61); install sent (yours)\n" +
        `      ${at(55 * MINUTE)}  donation not shown: $3,000,000,000 to CyberSec (for 9,000 reputation), the ` +
        "faction state showing 5,000\n" +
        `      ${at(56 * MINUTE)}  install reported done but the game didn't reset (queue: NeuroFlux Governor)\n`,
    ]) {
      expect(actions).toContain(block);
    }
    expect(actions).not.toContain("progress: ");
    expect(actions).not.toContain("(7)");
    // The hack loop's target: the batcher's own, from its health, not inferred; the same target is another stretch
    // after the install.
    const progress = sectionOf(brief.text, "2. Progress", "2b. Augmentation cycles");
    expect(progress).toContain(
      "  the batcher's targets, from its health in the fast snapshots (--verbose adds the hack loop's target " +
        "inferred from the servers):\n" +
        `    n00dles: ${at(10 * SECOND)} to ${at(25 * MINUTE - 2 * SECOND)}\n` +
        `    joesguns: ${at(25 * MINUTE)} to ${at(INSTALL_MS - 2 * SECOND)}\n` +
        `    joesguns: ${at(INSTALL_MS)} to ${at(BUSY_MS)}\n`,
    );
    expect(progress).not.toContain("hack loop target, inferred");

    // --verbose: each line, as before.
    for (const line of [
      "  intents:\n",
      `    buyServer(pserv-0, 8): done after 1 try (sim); done by ${at(10 * SECOND)}\n`,
      `    backdoor(server-0): done after 2 tries (ui); done by ${at(2 * MINUTE + 2 * SECOND)}\n`,
      `    ${at(MINUTE)}  pserv-0 bought, 8 GB, $440,000\n`,
      `    ${at(25 * MINUTE)}  pserv-19 upgraded, 8 GB → 32 GB, $1,320,000\n`,
      `  work, as it changed:\n    ${at(10 * SECOND)}  converged (ui)\n    ${at(5 * MINUTE)}  not converged\n`,
      `    ${at(22 * MINUTE + 41 * SECOND)}  bought NeuroFlux Governor (level 41) from CyberSec for $1,000,000 ` +
        "(queue 41)\n",
      `    ${at(MINUTE + 5 * SECOND)}  progress: the counts not stored\n`,
      `    ${at(15 * SECOND)}  alert: "Message received from unknown sender: I know you can sense i…"\n`,
      `      ${at(MINUTE + 1)}  hacking for CyberSec, for Neurotrainer I (reputation 2 of 1,000, 0.50/s: ` +
        "about 33 min)\n",
      `      ${at(4 * MINUTE)}  travel to Ishima for Tian Di Hui's invitation (3 of 30 installed)\n`,
      "  hack loop target, inferred from the game's servers",
      `  the batcher's targets, from its health in the fast snapshots:\n    n00dles: ${at(10 * SECOND)} to `,
    ]) {
      expect(verbose.text).toContain(line);
    }
  });

  test("the verdict, and every failure, warning and check line, are the same with --verbose or without", () => {
    busyRun();
    const brief = runReport(store, busyWindow);
    const verbose = runReport(store, busyWindow, { verbose: true });
    expect(brief.failures.length).toBeGreaterThanOrEqual(5);
    expect(verbose.failures).toEqual(brief.failures);
    expect(verbose.warnings).toEqual(brief.warnings);
    const fromVerdict = (text: string) => text.slice(text.indexOf("\nVerdict: "));
    expect(fromVerdict(brief.text)).toMatch(/^\nVerdict: FAIL\n/);
    expect(fromVerdict(verbose.text)).toBe(fromVerdict(brief.text));
    // Sections 4 to 6, the checks, whole.
    const checks = (text: string) => text.slice(text.indexOf("\n4. Health"), text.indexOf("\nVerdict: "));
    expect(checks(brief.text)).toContain("\n5. Hacking");
    expect(checks(verbose.text)).toBe(checks(brief.text));
    for (const failure of brief.failures) {
      expect(checks(brief.text)).toContain(failure);
    }
  });

  describe("a run of many cycles: each block a line a cycle, however busy each cycle is", () => {
    const CYCLE_MS = 10 * MINUTE;
    /**
     * `cycles` cycles of 10 minutes, a destroy before the sixth and the eleventh (BN1.2, BN1.3), each as busy as
     * `busyness` says: that many ui backdoors (routine), cloud server purchases, changes of work, alerts, faction work
     * choices, NeuroFlux Governor levels and invitation travels. One change of work a cycle has a problem. And what
     * comes again each reset (#245's second round, run #3's longest lines): CSEC backdoored 2 min after each cycle's
     * start and 10 s later each cycle, the factions joined growing a minute at a time from 2, 3 more augmentations
     * installed at each install, and 25 cloud servers.
     */
    function cyclesRun(cycles: number, busyness: number) {
      const startOf = (cycle: number) => cycle * CYCLE_MS;
      const cycleAt = (offsetMs: number) => Math.floor(offsetMs / CYCLE_MS);
      const bitNodeStart = (cycle: number) => (cycle < 5 ? 0 : cycle < 10 ? 5 : 10);
      const FACTIONS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Tian Di Hui", "Sector-12"];
      const factionsOf = (inCycle: number) =>
        [...FACTIONS, "Aevum", "Netburners", "Daedalus", "Chongqing", "Ishima"].slice(
          0,
          2 + Math.floor(inCycle / MINUTE),
        );
      const cloudNames = Array.from({ length: 25 }, (_, index) => "pserv-" + index);
      const untilMs = startOf(cycles);
      event(0, "brainStarted", { release: "r" });
      snapshot("static", 10 * SECOND, staticData());
      // Each cycle's `busyness` things a step apart, on the fast snapshots' 2 s.
      const step = Math.floor((CYCLE_MS - 20 * SECOND) / busyness / 2_000) * 2_000;
      for (let offsetMs = 10 * SECOND; offsetMs < untilMs; offsetMs += 2 * SECOND) {
        const cycle = cycleAt(offsetMs);
        const inCycle = offsetMs - startOf(cycle);
        const n = Math.floor(inCycle / step);
        const intents: IntentOutcome[] = [];
        if (inCycle % step === 0 && n < busyness) {
          intents.push(intent(`backdoor(s-${cycle}-${n})`, { problem: STARTED(`s-${cycle}-${n}`), backend: "ui" }));
          intents.push(intent(`buyServer(p-${cycle}-${n}, 8)`, { done: true }));
        }
        if (inCycle % step === 2 * SECOND && n < busyness) {
          intents.push(intent(`backdoor(s-${cycle}-${n})`, { done: true, tries: 2, backend: "ui" }));
        }
        const work: WorkOutcome =
          inCycle % step === 0
            ? { converged: false, problem: null, backend: null }
            : inCycle === 4 * SECOND
              ? { converged: false, problem: "a dialog the Agent leaves for the owner is open", backend: "ui" }
              : { converged: true, problem: null, backend: "ui" };
        const target = cycle % 2 === 0 ? "n00dles" : "joesguns";
        snapshot(
          "fast",
          offsetMs,
          fastData({ intents, work, batcher: { ...newBatcherHealth(target, "run-a", 0), state: "batching" } }),
        );
      }
      for (let offsetMs = 10 * SECOND; offsetMs < untilMs; offsetMs += 10 * SECOND) {
        const cycle = cycleAt(offsetMs);
        const inCycle = offsetMs - startOf(cycle);
        const data = mediumData({
          money: 1e9 + offsetMs,
          noodles: { money: offsetMs, security: 1 },
          factions: factionsOf(inCycle),
        });
        data.servers.push({
          hostname: "CSEC",
          maxRam: 8,
          cpuCores: 1,
          hasAdminRights: true,
          backdoorInstalled: inCycle >= (cycle === 0 ? 3 * MINUTE : 2 * MINUTE + cycle * 10 * SECOND),
          moneyAvailable: 0,
          hackDifficulty: 1,
        });
        snapshot("medium", offsetMs, data);
      }
      for (let offsetMs = 30 * SECOND; offsetMs <= untilMs; offsetMs += MINUTE) {
        const cycle = cycleAt(offsetMs);
        const first = bitNodeStart(cycle);
        const owned = Object.fromEntries(
          AUGMENTATION_NAMES.slice(0, 5 + 3 * (cycle - first)).map((name) => [name, 1] as [string, number]),
        );
        const ownedSF: Record<string, number> = first === 0 ? {} : { 1: first / 5 };
        const data = slowData(cloudNames, owned, ownedSF, factionState({ joined: [] }));
        data.resetInfo.lastNodeReset = T0 + startOf(first);
        data.resetInfo.lastAugReset = T0 + startOf(cycle);
        snapshot("slow", offsetMs, data, offsetMs);
      }
      for (let cycle = 0; cycle < cycles; cycle++) {
        const at0 = startOf(cycle) + 30 * SECOND;
        event(at0, "cityGroupChosen", { group: "B", factions: [], values: [] });
        for (let n = 0; n < busyness; n++) {
          const atMs = at0 + 1 + n * 1_000;
          event(atMs, "gameDialog", { kind: "alert", text: `Message received from unknown sender: ${n}` });
          event(atMs, "factionWorkChosen", choice(n % 2 === 0 ? "CyberSec" : "NiteSec"));
          event(atMs, "augmentationBought", {
            augmentation: "NeuroFlux Governor",
            faction: "CyberSec",
            level: cycle * busyness + n + 2,
            price: 1e6,
            queueLength: n + 1,
          });
          invitation(atMs, "travel", n % 2 === 0 ? "Ishima" : "Chongqing", ["Ishima"]);
        }
      }
      return { environment: "E0", sinceMs: T0, untilMs: T0 + untilMs + 30 * SECOND } as const;
    }
    /** A block of section 3 from its heading to the next line at its indentation or less. */
    function blockOf(text: string, heading: string): string[] {
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line.startsWith(heading));
      if (start === -1) throw new Error(`no block ${heading}`);
      const indentation = heading.length - heading.trimStart().length;
      const end = lines.findIndex(
        (line, index) => index > start && line.length - line.trimStart().length <= indentation,
      );
      return lines.slice(start, end);
    }
    /** Each summarised block's most lines, for `cycles` cycles: a line a cycle, and the few kept whole. */
    const BLOCKS: [heading: string, most: (cycles: number) => number][] = [
      ["  intents: ", () => 6],
      ["  cloud servers bought or upgraded", (cycles) => cycles + 2],
      ["  work, as it changed", (cycles) => 2 * cycles + 1],
      ["  dialogs handled", () => 3],
      ["    the brain's faction work", (cycles) => cycles + 1],
      ["    invitations travelled for", (cycles) => cycles + 1],
      ["  augmentations, by cycle", (cycles) => cycles + 1],
      ["  the batcher's targets", (cycles) => cycles + 1],
    ];

    test.each([
      [6, 10],
      [6, 40],
      [14, 10],
    ])(
      "%i cycles, %i of each a cycle: each block within its bound, the report within its characters",
      (cycles, busy) => {
        const runWindow = cyclesRun(cycles, busy);
        const brief = runReport(store, runWindow);
        for (const [heading, most] of BLOCKS) {
          expect(blockOf(brief.text, heading).length, heading).toBeLessThanOrEqual(most(cycles));
        }
        // About 1,350 characters a cycle (2b's block is most of it), and 8,600 besides: 16,721 for 6 cycles at 10 of
        // each, 16,756 at 40, and 27,606 for 14 over 3 BitNodes. Not how busy each cycle was.
        expect(brief.text.length).toBeLessThanOrEqual(9_000 + 1_400 * cycles);
        // What comes again each reset is one line, not one a reset (#245's second round): the backdoors, the joins,
        // and each BitNode's lists.
        const lines = brief.text.split("\n");
        // The first cycle's 3 min, then 2 min 10 s on, 10 s more each cycle.
        const lastMs = 2 * MINUTE + (cycles - 1) * 10 * SECOND;
        const most = Math.max(3 * MINUTE, lastMs);
        const mostIn = lastMs <= 3 * MINUTE ? "BN1.1 1" : cycles <= 10 ? `BN1.2 ${cycles - 5}` : `BN1.3 ${cycles - 10}`;
        expect(lines).toContain(
          `    CSEC: not backdoored at the window's start; backdoored in ${cycles} cycles, 2 min 10 s to ` +
            `${formatDuration(most)} after the cycle's start (the most in ${mostIn}); no invitation from CyberSec seen`,
        );
        expect(lines).toContain(
          "    joined: 11 factions, each first in: at the window's start: 2, BN1.1 1: 9 (--verbose lists each " +
            "with when)",
        );
        expect(lines).toContain("    purchased servers: 25 (unchanged)");
        expect(lines).toContain(
          "    factions: 2 → 11 (+ The Black Hand, BitRunners, Tian Di Hui, Sector-12, Aevum, Netburners, and 3 more)",
        );
        expect(lines.filter((line) => line.startsWith("    installed augmentations: 5 → 17 (+ "))).toHaveLength(
          cycles >= 10 ? 2 : 1,
        );
        const progress = brief.text.slice(brief.text.indexOf("2. Progress"), brief.text.indexOf("2b. "));
        // The BitNodes line aside: one entry a BitNode.
        for (const line of progress.split("\n").filter((each) => !each.startsWith("  BitNodes: "))) {
          expect(line.length, line).toBeLessThanOrEqual(200);
        }
        expect(blockOf(brief.text, "  work, as it changed")).toContain(
          `      ${at(CYCLE_MS + 4 * SECOND)}  not converged (ui): a dialog the Agent leaves for the owner is open`,
        );
        expect(blockOf(brief.text, "    invitations travelled for")).toContain(
          `      BN1.2 1: city group B; ${busy} travels (Ishima ×${busy / 2}, Chongqing ×${busy / 2}); ` +
            "0 holds; invited: none",
        );
        expect(runReport(store, runWindow, { verbose: true }).failures).toEqual(brief.failures);
      },
    );
  });

  test("the hack loop's target inferred leaves out a reset, when every server's money moves (#245)", () => {
    // n00dles worked throughout; an install at 10 min puts foodnstuff's money back too.
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData());
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({ money: offsetMs, noodles: { money: offsetMs, security: 1 } });
      if (offsetMs >= 10 * MINUTE) {
        (data.servers.find((server) => server.hostname === "foodnstuff") as { moneyAvailable: number }).moneyAvailable =
          1_000;
      }
      snapshot("medium", offsetMs, data);
    }
    for (let offsetMs = 30 * SECOND; offsetMs <= RUN_MS; offsetMs += MINUTE) {
      const data = slowData();
      if (offsetMs >= 10 * MINUTE) data.resetInfo.lastAugReset = T0 + 10 * MINUTE - 5 * SECOND;
      snapshot("slow", offsetMs, data);
    }
    const { text } = report();
    expect(text).toContain(
      "  hack loop target, inferred from the game's servers whose money or security moved between medium snapshots " +
        `(the owner's own scripts would show too; not across an install or a destroy):\n    ` +
        `n00dles: ${at(20 * SECOND)} to ${at(RUN_MS)}\n\n2b. `,
    );
    expect(text).not.toContain("foodnstuff + n00dles");
  });

  test("…and on the game's own clock, where 2b's estimate of the reset is late (a clock offset over a day)", () => {
    // The game's clock 2 days behind the brain's: 2b takes the reset at the next slow snapshot (10:30, after the
    // medium snapshot at 10:00 that shows it); the snapshots' game times put it between 9:50 and 10:00.
    const gameOf = (offsetMs: number) => T0 + offsetMs - 2 * 24 * 60 * MINUTE;
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) snapshot("fast", offsetMs, fastData(), gameOf(offsetMs));
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      const data = mediumData({ money: offsetMs, noodles: { money: offsetMs, security: 1 } });
      if (offsetMs >= 10 * MINUTE) {
        (data.servers.find((server) => server.hostname === "foodnstuff") as { moneyAvailable: number }).moneyAvailable =
          1_000;
      }
      snapshot("medium", offsetMs, data, gameOf(offsetMs));
    }
    for (let offsetMs = 30 * SECOND; offsetMs <= RUN_MS; offsetMs += MINUTE) {
      const data = slowData();
      data.resetInfo.lastNodeReset = gameOf(-60 * MINUTE);
      data.resetInfo.lastAugReset = offsetMs >= 10 * MINUTE ? gameOf(10 * MINUTE - 5 * SECOND) : gameOf(-60 * MINUTE);
      snapshot("slow", offsetMs, data, gameOf(offsetMs));
    }
    const { text } = report();
    expect(text).toContain(`\n    n00dles: ${at(20 * SECOND)} to ${at(RUN_MS)}\n\n2b. `);
    expect(text).not.toContain("foodnstuff + n00dles");
  });

  test("the batcher's target: the same target after a gap in its looks is another stretch", () => {
    // n00dles throughout, but no batcher health from 5 to 6 min (the batcher stopped).
    event(0, "brainStarted", { release: "r" });
    for (const offsetMs of fastOffsets()) {
      const stopped = offsetMs > 5 * MINUTE && offsetMs < 6 * MINUTE;
      snapshot("fast", offsetMs, stopped ? fastData() : fastData({ batcher: newBatcherHealth("n00dles", "a", 0) }));
    }
    snapshot("medium", 10 * SECOND, mediumData({ money: 1 }));
    expect(report().text).toContain(
      `    n00dles: ${at(10 * SECOND)} to ${at(5 * MINUTE)}\n    n00dles: ${at(6 * MINUTE)} to ${at(RUN_MS)}\n`,
    );
  });

  test("5. Hacking: each hour says what held the cycle back, from 2b's judgements in it, and money unspent", () => {
    // Hour 1 (and the judgement at hour 2's start): reputation short at CyberSec, money plenty; then everything
    // reached and affordable (the count); hour 3: everything reached, no money; hour 4: the count again, judged until
    // the install is chosen at 3 h 35 min, the money unspent until then, not the $3e15 after it.
    const hourOf = (offsetMs: number) => Math.floor((offsetMs - 10 * SECOND) / (60 * MINUTE));
    const chosenAtMs = 215 * MINUTE + 10 * SECOND;
    hackingRun({
      earning: (ceilings) => ceilings.batcherIncomePerSecond / 1_000,
      runMs: 240 * MINUTE,
      money: (offsetMs) => (hourOf(offsetMs) === 2 ? 0 : offsetMs > chosenAtMs ? 3e15 : 1e15),
      factions: (offsetMs) =>
        factionState({
          joined: [{ name: "CyberSec", reputation: offsetMs <= 60 * MINUTE + 10 * SECOND ? 0 : 1e9, favor: 0 }],
        }),
    });
    event(chosenAtMs, "augmentationInstallChosen", { set: [], cost: 0, queued: [], reason: "count reached" });
    const { text } = runReport(store, { ...window, untilMs: T0 + 241 * MINUTE });
    const section = sectionOf(text, "5. Hacking", "6. The batcher");
    const hours = section.slice(section.indexOf("  each hour:\n")).split("\n").slice(1, 9);
    const hourLine = expect.stringMatching(/^ {4}\$[\d,]+\/s: 0\.1% of the batcher ceiling /);
    expect(hours).toEqual([
      hourLine,
      "      held back by reputation, not income (100% of 1 h 0 min online judged in the hour); most money unspent " +
        "$1,000,000,000,000,000",
      hourLine,
      "      held back by count, not income (92% of 1 h 0 min online judged in the hour; reputation 8%); most money " +
        "unspent $1,000,000,000,000,000",
      hourLine,
      "      held back by money: income (100% of 1 h 0 min online judged in the hour)",
      hourLine,
      "      held back by count, not income (100% of 35 min online judged in the hour); most money unspent " +
        "$1,000,000,000,000,000",
    ]);
  });

  test("5. Hacking: an hour with nothing judged in it says so (an older store, no faction state)", () => {
    hackingRun({
      earning: (ceilings) => ceilings.batcherIncomePerSecond / 2,
      runMs: 130 * MINUTE,
      factions: () => null,
    });
    const { text } = runReport(store, { ...window, untilMs: T0 + 131 * MINUTE });
    const section = sectionOf(text, "5. Hacking", "6. The batcher");
    expect(section.match(/\n {6}held back by: not judged in the hour \(no faction state or money\)\n/g)).toHaveLength(
      3,
    );
  });

  test("5. Hacking: an hour or less, the window's line says what held the cycle back", () => {
    hackingRun({ earning: (ceilings) => ceilings.batcherIncomePerSecond / 2 });
    const { text } = report();
    const windowLine = text.split("\n").findIndex((line) => line.startsWith("  over the window: "));
    expect(text.split("\n")[windowLine + 1]).toBe(
      "    held back by factions (100% of 20 min online judged in the hour); most money unspent $0",
    );
    expect(text).not.toContain("  each hour:");
  });
});

test("inferHackTargets: a reset between two medium snapshots isn't a move (#245: every server's money moves)", () => {
  const medium = (atMs: number, noodles: number, zer0: number) => ({
    atMs,
    gameTimeMs: atMs + 1_000,
    data: {
      player: {},
      hasTorRouter: false,
      programs: [],
      servers: [
        {
          hostname: "n00dles",
          maxRam: 4,
          cpuCores: 1,
          hasAdminRights: true,
          moneyAvailable: noodles,
          hackDifficulty: 1,
        },
        { hostname: "zer0", maxRam: 8, cpuCores: 1, hasAdminRights: true, moneyAvailable: zer0, hackDifficulty: 1 },
      ],
    },
  });
  const snapshots = [medium(0, 1, 5), medium(10, 2, 5), medium(20, 3, 9), medium(30, 4, 9)];
  const brain = (...brainMs: number[]) => ({ brainMs, gameMs: [] });
  // The reset at 15: the move from 10 to 20 is the reset's, not the hack loop's.
  expect(inferHackTargets(snapshots, new Set(), brain(15))).toEqual([{ servers: ["n00dles"], fromMs: 10, toMs: 30 }]);
  // At 20 itself it's between them too; at 10, between the two before, not the move.
  expect(inferHackTargets(snapshots, new Set(), brain(20))).toEqual([{ servers: ["n00dles"], fromMs: 10, toMs: 30 }]);
  expect(inferHackTargets(snapshots, new Set(), brain(10))).toEqual([
    { servers: ["n00dles", "zer0"], fromMs: 20, toMs: 20 },
    { servers: ["n00dles"], fromMs: 30, toMs: 30 },
  ]);
  // On the game's clock (each snapshot's game time a second after its receipt): 1,020 is the third's, so between the
  // second and the third; 1,021 is between the third and the fourth.
  expect(inferHackTargets(snapshots, new Set(), { brainMs: [], gameMs: [1_020] })).toEqual([
    { servers: ["n00dles"], fromMs: 10, toMs: 30 },
  ]);
  expect(inferHackTargets(snapshots, new Set(), { brainMs: [], gameMs: [1_021] })).toEqual([
    { servers: ["n00dles"], fromMs: 10, toMs: 10 },
    { servers: ["n00dles", "zer0"], fromMs: 20, toMs: 20 },
  ]);
  // None: every move counts.
  expect(inferHackTargets(snapshots, new Set())).toEqual([
    { servers: ["n00dles"], fromMs: 10, toMs: 10 },
    { servers: ["n00dles", "zer0"], fromMs: 20, toMs: 20 },
    { servers: ["n00dles"], fromMs: 30, toMs: 30 },
  ]);
});

describe("the command", () => {
  function runCli(args: string[], dataDirectory = directory): { exitCode: number; output: string } {
    flush();
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

  test("--verbose lists each line; without it, the summaries (#245)", () => {
    cleanRun({ fast: () => fastData({ intents: [intent("travel(Aevum)", { done: true })] }) });
    const brief = runCli(["--since", at(0), ...until]);
    expect(brief.output).toContain("  intents: 1, by action and outcome (--verbose lists each):\n    travel: 1 done\n");
    expect(brief.output).not.toContain("    travel(Aevum): done after 1 try");
    const verbose = runCli(["--since", at(0), ...until, "--verbose"]);
    expect(verbose.output).toContain(
      `  intents:\n    travel(Aevum): done after 1 try (sim); done by ${at(10 * SECOND)}\n`,
    );
    expect(verbose.exitCode).toBe(brief.exitCode);
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

describe("the stop at the BitNode's end (#303)", () => {
  const DESTROYED = {
    reason: "destroyed",
    bitNode: "BN1.3",
    nextBitNode: "BN1.4",
    detail: "BN1.3 destroyed, BN1.4 seen",
  };
  const MAXED = "Source-File 1 is at level 3, so BitNode 1 gives nothing more";
  const NOTHING_MORE = {
    reason: "nothingMoreToGain",
    bitNode: "BN1.4",
    nextBitNode: null,
    detail: `BN1.4's w0r1d_d43m0n is ready, but ${MAXED}: the next BitNode is yours`,
  };
  /** The `nextBitNode` stall the World Daemon stores as it refuses the destroy, at `offsetMs`. */
  const refused = (offsetMs: number) =>
    event(offsetMs, "worldDaemonStalled", {
      step: "nextBitNode",
      sinceMs: T0 + offsetMs,
      detail: `the BitNode not destroyed: ${MAXED}: the next BitNode is yours (turn the switch off and queue destroyBitNode)`,
    });

  test("the run's expected end, with its reason, in section 1; the hours of quiet after it are no gap or stall", () => {
    cleanRun();
    event(RUN_MS + SECOND, "brainStoppedAtBitNodeEnd", DESTROYED);
    event(RUN_MS + 2 * SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    const { text, failures } = runReport(store, { ...window, untilMs: T0 + RUN_MS + 3 * 60 * MINUTE });
    expect(failures).toEqual([]);
    expect(text.split("\n").at(-1)).toBe("Verdict: PASS");
    expect(text).toContain(
      `  ${at(RUN_MS + SECOND)}  brain stopped itself at the BitNode's end (the switch on): BN1.3 destroyed, BN1.4 seen`,
    );
    expect(text).toContain(
      `  the run's end: the brain stopped itself at ${at(RUN_MS + SECOND)}, at the BitNode's end (the switch on): ` +
        "BN1.3 destroyed, BN1.4 seen. Expected, not a failure: the game and its scripts went on without it; the " +
        "quiet after it is no gap\n\n2. Progress",
    );
  });

  test("the nextBitNode stall the stop answered (nothing more to gain, within a minute): expected, not a failure", () => {
    cleanRun();
    refused(RUN_MS);
    event(RUN_MS, "brainStoppedAtBitNodeEnd", NOTHING_MORE);
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(
      `    world daemon stalled: the BitNode not destroyed: ${MAXED}: the next BitNode is yours (turn the switch off and ` +
        `queue destroyBitNode), from ${at(RUN_MS)} to at least ${at(RUN_MS)} (expected: the brain stopped itself ` +
        `at the BitNode's end at ${at(RUN_MS)}, the switch on)`,
    );
    expect(text).toContain(`the run's end: the brain stopped itself at ${at(RUN_MS)}, at the BitNode's end`);
  });

  test("unanswered, or answered over a minute on, or by another reason, the stall is still a failure", () => {
    cleanRun();
    refused(MINUTE);
    event(2 * MINUTE + SECOND, "brainStoppedAtBitNodeEnd", NOTHING_MORE);
    refused(5 * MINUTE);
    event(5 * MINUTE, "brainStoppedAtBitNodeEnd", DESTROYED);
    refused(10 * MINUTE);
    event(10 * MINUTE - SECOND, "brainStoppedAtBitNodeEnd", NOTHING_MORE);
    const stalls = report().failures.filter((failure) => failure.startsWith("world daemon stalled"));
    expect(stalls).toHaveLength(3);
  });

  test("a window across the stop and a later start: the silence between is expected, the disconnect too", () => {
    cleanRun();
    event(RUN_MS + SECOND, "brainStoppedAtBitNodeEnd", DESTROYED);
    event(RUN_MS + 2 * SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    // Started again 2 hours on: the Agent reconnects and reports.
    const againMs = RUN_MS + 2 * 60 * MINUTE;
    event(againMs, "brainStarted", { release: "r" });
    event(againMs + SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    for (let offsetMs = againMs + 2 * SECOND; offsetMs <= againMs + MINUTE; offsetMs += 2 * SECOND) {
      snapshot("fast", offsetMs, fastData(), 0, "session-2");
    }
    const { text, failures } = runReport(store, { ...window, untilMs: T0 + againMs + 2 * MINUTE });
    expect(failures).toEqual([]);
    expect(text).toContain(
      `    gap: ${at(RUN_MS)} to ${at(againMs + 2 * SECOND)} (7202.0 s); during it: agentDisconnected at ` +
        `${at(RUN_MS + 2 * SECOND)}, brainStarted at ${at(againMs)}, ` +
        `agentConnected at ${at(againMs + SECOND)} (expected: the brain stopped itself at the BitNode's end at ` +
        `${at(RUN_MS + SECOND)})`,
    );
    expect(text).toContain("  Agent disconnects with no reconnect within 1 min:\n    none");
  });

  test("the same silence and disconnect with no stop before them are failures", () => {
    cleanRun();
    event(RUN_MS + 2 * SECOND, "agentDisconnected", { agentSessionId: "session-1" });
    const againMs = RUN_MS + 2 * 60 * MINUTE;
    event(againMs, "brainStarted", { release: "r" });
    event(againMs + SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    for (let offsetMs = againMs + 2 * SECOND; offsetMs <= againMs + MINUTE; offsetMs += 2 * SECOND) {
      snapshot("fast", offsetMs, fastData(), 0, "session-2");
    }
    const { failures } = runReport(store, { ...window, untilMs: T0 + againMs + 2 * MINUTE });
    expect(failures.filter((failure) => /^gap: |^Agent disconnected at /.test(failure))).toHaveLength(2);
  });

  test("a run with no stop says nothing of one", () => {
    cleanRun();
    expect(report().text).not.toContain("the run's end");
  });

  /** The stop that closes the game too, a minute before the run's end, and its close going out at the end. */
  function closingRun() {
    cleanRun();
    event(RUN_MS - MINUTE, "brainStoppedAtBitNodeEnd", { ...DESTROYED, closeGame: true });
    event(RUN_MS, "gameCloseSent", {});
  }

  test("the game closed too: its close, the drop, and the end said; PASS, the disconnect expected", () => {
    closingRun();
    event(RUN_MS + 400, "agentDisconnected", { agentSessionId: "session-1" });
    // Stored once no Agent came back within 15 s of the drop.
    event(RUN_MS + 15_400, "gameClosed", { closeSentAtMs: T0 + RUN_MS, afterMs: 400 });
    const { text, failures, warnings } = runReport(store, { ...window, untilMs: T0 + RUN_MS + 60 * MINUTE });
    expect([failures, warnings]).toEqual([[], []]);
    for (const line of [
      `  ${at(RUN_MS - MINUTE)}  brain stopped itself at the BitNode's end (the switch on, the game to close first): ` +
        "BN1.3 destroyed, BN1.4 seen",
      `  ${at(RUN_MS)}  the game's close sent: its own Save Game, then its window closed`,
      `  ${at(RUN_MS + 15_400)}  game closed: its Agent's connection dropped 0.4 s after the close`,
      `  the run's end: the brain stopped itself at ${at(RUN_MS - MINUTE)}, at the BitNode's end (the switch on): ` +
        `BN1.3 destroyed, BN1.4 seen. Expected, not a failure: the game saved and closed at ${at(RUN_MS + 400)}, ` +
        "then the brain stopped; the quiet after it is no gap",
    ]) {
      expect(text).toContain(line);
    }
  });

  /**
   * The close a try 2 closes (#303 review): out at RUN_MS - 32 s, try 1 not saved 2 s on, try 2 30 s after that closes
   * the window at RUN_MS, the drop 0.4 s on, and `gameClosed` stored 15 s after the drop.
   */
  function closedAtTry2() {
    cleanRun();
    event(RUN_MS - 2 * MINUTE, "brainStoppedAtBitNodeEnd", { ...DESTROYED, closeGame: true });
    event(RUN_MS - 32 * SECOND, "gameCloseSent", {});
    event(RUN_MS - 30 * SECOND, "gameCloseTried", { tries: 1, problem: "the game's save not confirmed" });
    event(RUN_MS + 400, "agentDisconnected", { agentSessionId: "session-1" });
    event(RUN_MS + 15_400, "gameClosed", { closeSentAtMs: T0 + RUN_MS - 32 * SECOND, afterMs: 32_400 });
  }

  test("closed at try 2: the drop and the 15 s before gameClosed are expected; PASS", () => {
    closedAtTry2();
    const { failures, warnings } = runReport(store, { ...window, untilMs: T0 + RUN_MS + 60 * MINUTE });
    expect([failures, warnings]).toEqual([[], []]);
  });

  test("closed at try 2, then the brain started again hours on: the silence from the drop is expected; PASS", () => {
    closedAtTry2();
    const againMs = RUN_MS + 2 * 60 * MINUTE;
    event(againMs, "brainStarted", { release: "r" });
    event(againMs + SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    for (let offsetMs = againMs + 2 * SECOND; offsetMs <= againMs + MINUTE; offsetMs += 2 * SECOND) {
      snapshot("fast", offsetMs, fastData(), 0, "session-2");
    }
    const { text, failures, warnings } = runReport(store, { ...window, untilMs: T0 + againMs + 2 * MINUTE });
    expect([failures, warnings]).toEqual([[], []]);
    // The stop's own time, not the close's events'.
    expect(text).toContain(`(expected: the brain stopped itself at the BitNode's end at ${at(RUN_MS - 2 * MINUTE)})`);
  });

  /** A close, its stop 5 minutes before the run's end, then `gameClosed` stored with `detail`, and a restart. */
  function gapAfterClosed(storedAtOffsetMs: number, detail: Record<string, unknown>) {
    cleanRun();
    event(RUN_MS - 5 * MINUTE, "brainStoppedAtBitNodeEnd", { ...DESTROYED, closeGame: true });
    event(RUN_MS - 5 * MINUTE, "gameCloseSent", {});
    event(storedAtOffsetMs, "gameClosed", detail);
    const againMs = RUN_MS + 2 * 60 * MINUTE;
    event(againMs, "brainStarted", { release: "r" });
    event(againMs + SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    for (let offsetMs = againMs + 2 * SECOND; offsetMs <= againMs + MINUTE; offsetMs += 2 * SECOND) {
      snapshot("fast", offsetMs, fastData(), 0, "session-2");
    }
    return runReport(store, { ...window, untilMs: T0 + againMs + 2 * MINUTE }).failures.filter((failure) =>
      failure.startsWith("gap: "),
    );
  }

  test("a gameClosed whose drop falls outside the silence's window doesn't excuse it, though stored inside", () => {
    // Stored a second into the gap, but its drop was nearly 5 minutes before it.
    expect(gapAfterClosed(RUN_MS + SECOND, { closeSentAtMs: T0 + RUN_MS - 5 * MINUTE, afterMs: SECOND })).toHaveLength(
      1,
    );
  });

  test("a gameClosed without the close's time or the drop's delay counts at its own time", () => {
    expect(gapAfterClosed(RUN_MS + SECOND, {})).toEqual([]);
  });

  test("the game's close not confirmed: a warning (WARN), the end saying the game may still be running", () => {
    closingRun();
    const reason = "the Agent's connection didn't drop within 60 s of the close: the game may still be running";
    event(RUN_MS + MINUTE, "gameCloseNotConfirmed", { reason, closeSentAtMs: T0 + RUN_MS });
    const { text, failures, warnings } = runReport(store, { ...window, untilMs: T0 + RUN_MS + 60 * MINUTE });
    expect(failures).toEqual([]);
    expect(warnings).toEqual([`game close not confirmed at ${at(RUN_MS + MINUTE)}: ${reason} (the brain stopped)`]);
    expect(text.split("\n").at(-2)).toBe("Verdict: WARN");
    expect(text).toContain(`  ${at(RUN_MS + MINUTE)}  game close NOT CONFIRMED: ${reason}`);
    expect(text).toContain(
      `Expected, not a failure: the game's close NOT CONFIRMED (${reason}), so it may still be running`,
    );
  });

  /** The run, a stop at `stopOffsetMs`, and a brain started again 2 hours on: the gap's and disconnect's failures. */
  function acrossRestart(stopOffsetMs: number, kind = "brainStoppedAtBitNodeEnd") {
    cleanRun();
    event(stopOffsetMs, kind, kind === "brainStoppedAtBitNodeEnd" ? DESTROYED : {});
    const againMs = RUN_MS + 2 * 60 * MINUTE;
    event(againMs, "brainStarted", { release: "r" });
    event(againMs + SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    for (let offsetMs = againMs + 2 * SECOND; offsetMs <= againMs + MINUTE; offsetMs += 2 * SECOND) {
      snapshot("fast", offsetMs, fastData(), 0, "session-2");
    }
    return runReport(store, { ...window, untilMs: T0 + againMs + 2 * MINUTE }).failures.filter((failure) =>
      failure.startsWith("gap: "),
    );
  }

  // The gap starts at the run's last fast snapshot, RUN_MS.
  test("the silence follows a stop from RELOAD_LEAD_MS before the gap's start", () => {
    expect(acrossRestart(RUN_MS - RELOAD_LEAD_MS)).toEqual([]);
  });

  test("…not a stop earlier than that: the gap fails", () => {
    expect(acrossRestart(RUN_MS - RELOAD_LEAD_MS - 1)).toHaveLength(1);
  });

  test("…and no later than RELOAD_LAG_MS into the gap", () => {
    expect(acrossRestart(RUN_MS + RELOAD_LAG_MS)).toEqual([]);
  });

  test("…a stop later than that in the gap is another brain's business: the gap fails", () => {
    expect(acrossRestart(RUN_MS + RELOAD_LAG_MS + 1)).toHaveLength(1);
  });

  test("the close's events count as the stop's for the silence after them (#303 review)", () => {
    expect(acrossRestart(RUN_MS, "gameCloseNotConfirmed")).toEqual([]);
  });

  test("each try of the close is listed", () => {
    closingRun();
    event(RUN_MS + 2 * SECOND, "gameCloseTried", { tries: 1, problem: "the game's save not confirmed" });
    const { text } = report();
    expect(text).toContain(
      `  ${at(RUN_MS + 2 * SECOND)}  the game's close tried, not closed (try 1): the game's save not confirmed`,
    );
  });

  test("called off from the dashboard before it went out: the end says the game went on", () => {
    cleanRun();
    event(RUN_MS - MINUTE, "brainStoppedAtBitNodeEnd", { ...DESTROYED, closeGame: true });
    event(RUN_MS - 30 * SECOND, "gameCloseCalledOff", {});
    const { text, failures, warnings } = report();
    expect([failures, warnings]).toEqual([[], []]);
    expect(text).toContain(
      `  ${at(RUN_MS - 30 * SECOND)}  the game's close called off from the dashboard before it went out`,
    );
    expect(text).toContain(
      `Expected, not a failure: the game's close called off from the dashboard at ${at(RUN_MS - 30 * SECOND)}, so the ` +
        "game and its scripts went on without it",
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
   * snapshots after each saying so, and sends it the round after. `laggedRounds` (#309): those rounds' snapshots
   * received 600 ms after their stamps, 2026-11-08's delivery lag, a fast one sent `sentAfterMs` after its stamp if
   * given (the Agent's send stamp, absent from an older Agent).
   */
  const END_MS = 30 * MINUTE;
  /** Run #3's batcher was before #251, on the wall clock (no `clock`); `monotonic`, one since. */
  function incidentRun({
    noStep = false,
    stallsAfter = [] as number[],
    mediumRetriedAt = null as number | null,
    monotonic = false,
    laggedRounds = [] as number[],
    sentAfterMs = null as number | null,
  } = {}) {
    const rounds: { round: number; receivedMs: number; gameMs: number }[] = [];
    let trueMs = 1_800;
    for (let round = 0; trueMs <= END_MS; round++) {
      const gameMs = trueMs + (!noStep && round >= 354 ? 2_678 : 0);
      const receivedMs = trueMs + (!noStep && round >= 364 ? 2_678 : 0) + (laggedRounds.includes(round) ? 600 : 0);
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
      const clock = monotonic ? ("monotonic" as const) : undefined;
      return { ...newBatcherHealth("the-hub", "r1", 0), clock, state, batchesStarted: round, ...counts };
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
      const sent = sentAfterMs === null ? {} : { sentAtMs: T0 + gameMs + sentAfterMs };
      snapshot("fast", receivedMs, fastData({ batcher: health(round), degradedTiers, ...sent }), T0 + gameMs);
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
        `first seen at ${at(731_800)}; no clock step, page stall or delivery lag before it`,
    ]);
    expect(text).toMatch(/3 or more within an hour fail\):\n {4}none\n/);
  });

  test("a batcher on the monotonic clock (#251), the same desyncs after the same step: FAIL, the step no excuse", () => {
    incidentRun({ monotonic: true });
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(text).toContain(`within an hour fail):\n${STEP_LINE}\n  income stalls`);
    expect(warnings).toEqual([]);
    expect(failures).toEqual([
      "batcher out of step: 1615 desyncs (1615 out of order, 0 out of bounds), 16 late, 24 lost on the-hub, the " +
        `first seen at ${at(734_478)}; no page stall or delivery lag before it (a clock step can't put a batcher on ` +
        "the page's monotonic clock out of step, #251)",
    ]);
  });

  /** Rounds 360 to 370 (12:01.8 to 12:21.8) received 0.6 s late; the desyncs first seen at round 365, inside. */
  const laggedRounds = Array.from({ length: 11 }, (_, index) => 360 + index);

  test("a delivery lag (#309) the desyncs began in: in section 4, not a clock step; the desyncs put down to it", () => {
    incidentRun({ noStep: true, monotonic: true, laggedRounds });
    const lagged = runReport(store, incidentWindow);
    const LAG_LINE =
      `    delivery lag up to 0.6 s from ${at(721_800 + 600)} to ${at(743_800)} (not a clock step): 14 snapshots ` +
      "received late, drained in 21 s; whose, unknown (no send stamps: an Agent before #309)";
    expect(lagged.text).toContain(`within an hour fail):\n${LAG_LINE}\n  income stalls`);
    expect(lagged.failures).toEqual([]);
    expect(lagged.warnings).toEqual([
      expect.stringMatching(
        /^batcher out of step after a delivery lag: .*, after a delivery lag of up to 0\.6 s from /,
      ),
    ]);
  });

  test("the same, the Agent's send stamps saying it sent on time: the socket's or the brain's, no excuse: FAIL", () => {
    incidentRun({ noStep: true, monotonic: true, laggedRounds, sentAfterMs: 2 });
    const brains = runReport(store, incidentWindow);
    expect(brains.text).toContain("14 snapshots received late, drained in 21 s; the Agent's share at most 0.0 s");
    expect(brains.warnings).toEqual([]);
    expect(brains.failures).toEqual([
      expect.stringMatching(/ was the socket's or the brain's, the page sending on time: no excuse, #309\)$/),
    ]);
  });

  test("a move of the clocks' gap over a restart isn't a step: FAIL then", () => {
    incidentRun();
    event(708_500, "deployed", { deploymentId: "dep-c", replacedDeploymentId: "dep" });
    event(729_000, "deployed", { deploymentId: "dep-d", replacedDeploymentId: "dep-c" });
    const { text, failures, warnings } = runReport(store, incidentWindow);
    expect(warnings).toEqual([]);
    expect(text).not.toContain(STEP_LINE);
    expect(failures).toEqual([expect.stringMatching(/; no clock step, page stall or delivery lag before it$/)]);
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
      `clock steps, page stalls or delivery lags: 3 from ${at(707_800)} to ${at(1_513_478)}, 3 or more within an ` +
      "hour (1 clock step, 2 page stalls)";
    expect(failures).toEqual([tooMany]);
    expect(warnings).toEqual([WARNING]);
    expect(text.split("\n").slice(-3)).toEqual(["Verdict: FAIL", `  ${tooMany}`, `  warning: ${WARNING}`]);
  });

  test("thinned (#283): the same step and stalls, from every snapshot's times, and the same verdict", () => {
    incidentRun({ stallsAfter: [600, 750] });
    const whole = runReport(store, incidentWindow);
    thinBefore(END_MS + MINUTE);
    const thinned = runReport(store, incidentWindow);
    const incidentsOf = (text: string) =>
      text.split("\n").filter((line) => /^ {4}(clock step|page stalled) /.test(line));
    expect(incidentsOf(whole.text)).toHaveLength(3);
    expect(incidentsOf(thinned.text)).toEqual(incidentsOf(whole.text));
    expect(thinned.failures).toEqual(whole.failures);
    // The batcher's desyncs still put down to the step, seen at the whole snapshots, a minute apart.
    expect(thinned.warnings).toEqual([
      expect.stringMatching(/^batcher out of step after a clock step: 1615 desyncs .*; recovered in /),
    ]);
  });

  test("the command exits 0 on WARN", () => {
    incidentRun();
    flush();
    const output = execFileSync(
      process.execPath,
      [REPORT_CLI, "--data-dir", directory, "--since", at(0), "--until", at(END_MS + 30 * SECOND)],
      { encoding: "utf8", stdio: "pipe" },
    );
    expect(output).toContain(`Verdict: WARN\n  warning: ${WARNING}`);
  });
});

describe("a batcher stuck on a poor target (#275)", () => {
  // The BN1.3 exit run's shape (#274), synthetic: hacking 1,327; 25 cloud servers of 1 PB (26.2 PB, 21:30's) before
  // the install and of 16 TB after (about 424 TB with the game's, 23:00's); the big targets at 3× their minimum
  // security after the install, rho-construction prepared. BN1's figures
  // (servers.ts, the money 25× moneyAvailable, the security a third of hackDifficulty), each range's middle.
  const TARGETS = {
    n00dles: { moneyMax: 1_750_000, minDifficulty: 1, requiredHackingSkill: 1, serverGrowth: 3_000 },
    phantasy: { moneyMax: 600_000_000, minDifficulty: 7, requiredHackingSkill: 100, serverGrowth: 35 },
    "rho-construction": { moneyMax: 15_000_000_000, minDifficulty: 17, requiredHackingSkill: 500, serverGrowth: 50 },
    "b-and-a": { moneyMax: 562_500_000_000, minDifficulty: 27, requiredHackingSkill: 1_025, serverGrowth: 70 },
    ecorp: { moneyMax: 1_250_000_000_000, minDifficulty: 33, requiredHackingSkill: 1_225, serverGrowth: 99 },
  };
  const CLOUD = Array.from({ length: 25 }, (_, index) => `pserv-${index}`);
  const PLAYER = {
    money: 1e12,
    skills: { hacking: 1_327, intelligence: 0 },
    mults: { hacking_chance: 1.6, hacking_speed: 1.8, hacking_money: 2.5, hacking_grow: 1.6 },
  };
  const servers: StaticSnapshotData = {
    servers: [
      { ...staticServer("home"), purchasedByPlayer: true, moneyMax: 0 },
      ...Object.entries(TARGETS).map(([hostname, figures]) => staticServer(hostname, figures)),
      ...CLOUD.map((hostname) => ({ ...staticServer(hostname), purchasedByPlayer: true, moneyMax: 0 })),
    ],
  };
  const medium = (cloudRamGb: number): MediumSnapshotData => ({
    player: PLAYER,
    hasTorRouter: true,
    programs: [],
    servers: [
      { hostname: "home", maxRam: 8_192, cpuCores: 8, hasAdminRights: true, moneyAvailable: 0, hackDifficulty: 1 },
      ...Object.entries(TARGETS).map(([hostname, { moneyMax, minDifficulty }]) => ({
        hostname,
        maxRam: 64,
        cpuCores: 1,
        hasAdminRights: true,
        // The big ones as an install leaves them; the rest prepared.
        moneyAvailable: moneyMax > 1e11 ? moneyMax / 10 : moneyMax,
        hackDifficulty: moneyMax > 1e11 ? 3 * minDifficulty : minDifficulty,
      })),
      ...CLOUD.map((hostname) => ({
        hostname,
        maxRam: cloudRamGb,
        cpuCores: 1,
        hasAdminRights: true,
        moneyAvailable: 0,
        hackDifficulty: 1,
      })),
    ],
  });
  const INSTALL_MS = 70 * MINUTE;
  const END_MS = 200 * MINUTE;
  const stuckWindow = { environment: "E0", sinceMs: T0, untilMs: T0 + END_MS + 30 * SECOND } as const;

  /**
   * The cloud servers' RAM: 1 PB each before the install; after it, 32 GB (n00dles about 50× under the best: not
   * poor), 1 TB from 5 minutes in, and 16 TB from 30 (the real run's 22:26 to 22:28, #277's review).
   */
  const cloudRamGb = (offsetMs: number) =>
    offsetMs < INSTALL_MS
      ? 1_048_576
      : offsetMs < INSTALL_MS + 5 * MINUTE
        ? 32
        : offsetMs < INSTALL_MS + 30 * MINUTE
          ? 1_024
          : 16_384;

  /** Phantasy batched until the install at 70 minutes, then `after` (n00dles, the trap) to 200 minutes. */
  function stuckRun(after = "n00dles") {
    event(0, "brainStarted", { release: "r" });
    snapshot("static", 10 * SECOND, servers);
    for (let offsetMs = 10 * SECOND; offsetMs <= END_MS; offsetMs += 2 * SECOND) {
      const [target, runName] = offsetMs < INSTALL_MS ? ["phantasy", "a"] : [after, "b"];
      const batcher = { ...newBatcherHealth(target, runName, 0), state: "batching" as const };
      snapshot("fast", offsetMs, fastData({ batcher }), offsetMs);
    }
    for (let offsetMs = 10 * SECOND; offsetMs <= END_MS; offsetMs += 10 * SECOND) {
      snapshot("medium", offsetMs, medium(cloudRamGb(offsetMs)), offsetMs);
    }
    for (let offsetMs = 10 * SECOND; offsetMs <= END_MS; offsetMs += MINUTE) {
      const slow = slowData(CLOUD);
      const lastAugReset = offsetMs < INSTALL_MS ? RESET : T0 + INSTALL_MS - SECOND;
      snapshot("slow", offsetMs, { ...slow, resetInfo: { ...slow.resetInfo, lastAugReset } }, offsetMs);
    }
  }

  test("phantasy for an hour, then n00dles for over 2 after the install: a warning, then the cycle's failure", () => {
    stuckRun();
    const { text, failures, warnings } = runReport(store, stuckWindow);
    const stuck = (lines: string[]) => lines.filter((line) => line.startsWith("batcher stuck on a poor target: "));
    expect(stuck(warnings)).toEqual([expect.stringMatching(/^batcher stuck on a poor target: phantasy from /)]);
    expect(stuck(failures)).toEqual([
      expect.stringMatching(/^batcher stuck on a poor target: 2 h 5 min on poor targets in BN1\.\d+ 2 \(2 h or more /),
    ]);
    const [warning, failure] = [stuck(warnings)[0] as string, stuck(failures)[0] as string];
    expect(warning).toContain(`phantasy from ${at(10 * SECOND)} to ${at(INSTALL_MS - 2 * SECOND)} (1 h 9 min on it)`);
    expect(warning).toMatch(/ on it\), in BN1\.\d+ 1; /);
    // n00dles poor only once the cloud servers came, 5 minutes after the install; the ratio climbing with their RAM.
    expect(failure).toContain(
      `in 1 stretch; the longest, n00dles from ${at(INSTALL_MS + 5 * MINUTE)} to ${at(END_MS)} (2 h 5 min on it); `,
    );
    // The best is b-and-a or ecorp, both hackable at 1,327; n00dles' money is what holds it to under $20m/s.
    const range =
      /the best rooted target ([\d,]+)× to ([\d,]+)× it \(at the most (b-and-a|ecorp), \$[\d,]+\/s against \$19,/;
    const [, least, most] = (range.exec(failure) ?? []).map((each) => Number(each?.replaceAll(",", "")));
    expect(least).toBeGreaterThanOrEqual(100);
    expect(least).toBeLessThan(2_000);
    expect(most).toBeGreaterThan(5 * (least as number));
    expect(warning).toMatch(/; the best rooted target [\d,]+×( to [\d,]+×)? it \(at the most (b-and-a|ecorp), /);
    for (const line of [warning, failure]) expect(line).toMatch(/, at hacking 1,327$/);
    // In section 6, under its line.
    expect(text).toContain(`\n    ${warning}\n    ${failure}\n`);
    expect(text).toContain("\nVerdict: FAIL\n");
  });

  test("batching the best throughout: none", () => {
    stuckRun("b-and-a");
    const { text, failures, warnings } = runReport(store, stuckWindow);
    // Phantasy's hour still warns; b-and-a's 2 hours don't.
    expect(warnings.filter((line) => line.includes("stuck on a poor target"))).toHaveLength(1);
    expect(failures.filter((line) => line.includes("stuck on a poor target"))).toEqual([]);
    expect(text).not.toContain("stuck on a poor target: b-and-a");
  });
});

describe("an install or a destroy the reset followed, with no done record (#286)", () => {
  const INSTALL = "installAugmentations()";
  const DESTROY = "destroyBitNode(1)";
  /** The ui destroy's first try, its worker still at it when the BitVerse kills it (`destroy-page.ts:144`). */
  const ENTERING = "backdooring w0r1d_d43m0n: about 1 s left, then entering BitNode 1 from the BitVerse";
  /**
   * An intent the Agent held for 4 s from `atMs` (3 fast snapshots). Then, as a reset does, the Agent away 8 s
   * (unless `away` is false) and a new Agent (another session, unless `newAgent` is false).
   */
  interface Held {
    id: string;
    atMs: number;
    tries?: number;
    problem?: string;
    away?: boolean;
    newAgent?: boolean;
  }
  /** An install the reset killed before its try counted (`intent-runner.ts:48-51`): 0 tries, as the exit run's. */
  const install = (atMs: number, changes: Partial<Held> = {}): Held => ({ id: INSTALL, atMs, ...changes });
  /** A ui destroy after its first try (a destroy is never reported done, `destroy-page.ts:110`). */
  const destroy = (atMs: number, changes: Partial<Held> = {}): Held => ({
    id: DESTROY,
    atMs,
    tries: 1,
    problem: ENTERING,
    ...changes,
  });
  /** A reset at `atMs`: an install's (another `lastAugReset`), or a destroy's (another BitNode, and `lastAugReset`). */
  type Reset = { kind: "install" | "destroy"; atMs: number };
  /**
   * The BN1.3 exit run's shape (#276): the `held` intents, and the slow snapshots, `slowEveryMs` apart from
   * `slowFromMs`, each showing the `resets` by then (a destroy into BN1 an SF1 level more).
   */
  function resetRun({
    held,
    resets = [],
    slowFromMs = 30 * SECOND,
    slowEveryMs = MINUTE,
  }: {
    held: Held[];
    resets?: Reset[];
    slowFromMs?: number;
    slowEveryMs?: number;
  }) {
    event(0, "brainStarted", { release: "r" });
    const isAway = (offsetMs: number) =>
      held.some(
        (each) => each.away !== false && offsetMs > each.atMs + 4 * SECOND && offsetMs < each.atMs + 14 * SECOND,
      );
    /** The Agent at `offsetMs`: a new one after each held intent's last record, unless its `newAgent` is false. */
    const sessionAt = (offsetMs: number) =>
      `session-${1 + held.filter((each) => each.newAgent !== false && offsetMs > each.atMs + 4 * SECOND).length}`;
    for (const offsetMs of fastOffsets(isAway)) {
      const intents = held
        .filter((each) => offsetMs >= each.atMs && offsetMs <= each.atMs + 4 * SECOND)
        .map(({ id, tries = 0, problem = null }) => intent(id, { tries, problem, backend: tries === 0 ? null : "ui" }));
      snapshot("fast", offsetMs, fastData({ intents }), 0, sessionAt(offsetMs));
    }
    for (const { atMs } of held.filter((each) => each.away !== false)) {
      event(atMs + 5 * SECOND, "agentDisconnected", { agentSessionId: sessionAt(atMs + 4 * SECOND) });
      event(atMs + 13 * SECOND, "agentConnected", { agentSessionId: sessionAt(atMs + 14 * SECOND) });
    }
    for (let offsetMs = 10 * SECOND; offsetMs <= RUN_MS; offsetMs += 10 * SECOND) {
      snapshot("medium", offsetMs, mediumData({ money: offsetMs }));
    }
    for (let offsetMs = slowFromMs; offsetMs <= RUN_MS; offsetMs += slowEveryMs) {
      const by = resets.filter((reset) => reset.atMs <= offsetMs);
      const destroys = by.filter((reset) => reset.kind === "destroy");
      const data = slowData([], {}, destroys.length === 0 ? {} : { 1: destroys.length });
      if (by.length > 0) data.resetInfo.lastAugReset = T0 + Math.max(...by.map((reset) => reset.atMs));
      if (destroys.length > 0) data.resetInfo.lastNodeReset = T0 + Math.max(...destroys.map((reset) => reset.atMs));
      snapshot("slow", offsetMs, data);
    }
  }
  const INSTALL_MS = 4 * MINUTE;
  const DESTROY_MS = 12 * MINUTE;
  /** The exit run's two: an install at 4 min and a destroy at 12. */
  const EXIT_RUN = [install(INSTALL_MS), destroy(DESTROY_MS)];
  const resetsAt = (installMs: number, destroyMs: number): Reset[] => [
    { kind: "install", atMs: installMs },
    { kind: "destroy", atMs: destroyMs },
  ];
  const NOTABLE =
    "  intents not done, done with a problem, or tried again for something besides their worker still at it:\n";
  const BY_THE_RESET = "by the reset that followed, with no done record";
  const BOTH_DONE = `    destroyBitNode: 1 done (1 ${BY_THE_RESET})\n    installAugmentations: 1 done (1 ${BY_THE_RESET})\n`;
  const BOTH_NOT_DONE = "    destroyBitNode: 1 not done\n    installAugmentations: 1 not done\n";

  test("each counts as done, the reset seen in the next slow snapshot; the summary says how", () => {
    resetRun({ held: EXIT_RUN, resets: resetsAt(INSTALL_MS + 5 * SECOND, DESTROY_MS + 5 * SECOND) });
    expect(report().text).toContain(
      `  intents: 2, by action and outcome (--verbose lists each):\n${BOTH_DONE}${NOTABLE}    none\n`,
    );
    expect(report({ verbose: true }).text).toContain(
      "  intents:\n" +
        `    ${INSTALL}: done: the reset followed, 0 tries; the reset seen by ${at(INSTALL_MS + 30 * SECOND)}\n` +
        `    ${DESTROY}: done: the reset followed, 1 try (ui); the reset seen by ${at(DESTROY_MS + 30 * SECOND)}\n`,
    );
  });

  test("the exit run's 11 installs, each followed by its reset: 11 done, each its own episode", () => {
    // An install every 90 s from 1 min, each reset 5 s on; a slow snapshot every 30 s.
    const starts = Array.from({ length: 11 }, (_, index) => MINUTE + index * 90 * SECOND);
    resetRun({
      held: starts.map((atMs) => install(atMs)),
      resets: starts.map((atMs) => ({ kind: "install", atMs: atMs + 5 * SECOND })),
      slowFromMs: 15 * SECOND,
      slowEveryMs: 30 * SECOND,
    });
    expect(report().text).toContain(`    installAugmentations: 11 done (11 ${BY_THE_RESET})\n${NOTABLE}    none\n`);
  });

  test("two installs, only the first followed by a reset: the second not done, and stuck at 5 tries", () => {
    resetRun({
      held: [install(INSTALL_MS), install(DESTROY_MS, { tries: 5 })],
      resets: [{ kind: "install", atMs: INSTALL_MS + 5 * SECOND }],
    });
    const { text, failures } = report();
    expect(text).toContain(`    installAugmentations: 1 done (1 ${BY_THE_RESET}), 1 not done\n`);
    expect(failures).toContain(`intent stuck: ${INSTALL}, not done, 5 tries (ui)`);
  });

  test("two destroys, only the first followed by a reset: the second not done", () => {
    resetRun({
      held: [destroy(INSTALL_MS), destroy(DESTROY_MS)],
      resets: [{ kind: "destroy", atMs: INSTALL_MS + 5 * SECOND }],
    });
    expect(report().text).toContain(`    destroyBitNode: 1 done (1 ${BY_THE_RESET}), 1 not done\n`);
  });

  test("an install the same Agent gives again after it left the list is another: the reset after is the second's", () => {
    // Held 4:00 to 4:04, gone at 4:06 and 4:08, back from 4:10 (`intent-runner.ts:7`); the reset at 4:15.
    const same = { away: false, newAgent: false };
    resetRun({
      held: [install(INSTALL_MS, same), install(INSTALL_MS + 10 * SECOND, same)],
      resets: [{ kind: "install", atMs: INSTALL_MS + 15 * SECOND }],
    });
    expect(report().text).toContain(`    installAugmentations: 1 done (1 ${BY_THE_RESET}), 1 not done\n`);
    expect(report({ verbose: true }).text).toContain(
      `    ${INSTALL}: not done, 0 tries; first seen ${at(INSTALL_MS)}\n` +
        `    ${INSTALL}: done: the reset followed, 0 tries; the reset seen by ${at(INSTALL_MS + 30 * SECOND)}\n`,
    );
  });

  test("an install a new Agent holds is another, with no snapshot between them without it", () => {
    // 4:00 to 4:04 from one Agent, 4:06 to 4:10 from the next.
    resetRun({ held: [install(INSTALL_MS, { away: false }), install(INSTALL_MS + 6 * SECOND, { away: false })] });
    expect(report().text).toContain("    installAugmentations: 2 not done\n");
  });

  test("a destroy tried 5 times the reset followed isn't stuck", () => {
    resetRun({
      held: [install(INSTALL_MS), destroy(DESTROY_MS, { tries: 5 })],
      resets: resetsAt(INSTALL_MS + 5 * SECOND, DESTROY_MS + 5 * SECOND),
    });
    const { text, failures } = report();
    expect(failures.filter((failure) => failure.startsWith("intent stuck"))).toEqual([]);
    expect(text).toContain("  stuck intents (5 tries or more, not done at the last look):\n    none\n");
  });

  test("with no reset after: each not done, as its last record says", () => {
    resetRun({ held: EXIT_RUN });
    const { text } = report();
    expect(text).toContain(BOTH_NOT_DONE);
    expect(text).toContain(
      `${NOTABLE}    ${INSTALL}: not done, 0 tries; first seen ${at(INSTALL_MS)}\n` +
        `    ${DESTROY}: not done, 1 try (ui): ${ENTERING}; first seen ${at(DESTROY_MS)}\n`,
    );
  });

  test("a reset before the intent isn't one that followed it", () => {
    resetRun({ held: EXIT_RUN, resets: resetsAt(MINUTE, 2 * MINUTE) });
    expect(report().text).toContain(BOTH_NOT_DONE);
  });

  test("a reset seen 5 minutes after the intent's last record is its", () => {
    // The intents last seen at 4:04 and 12:04. A slow snapshot a minute from 0:04: the resets seen at 9:04 and 17:04.
    resetRun({ held: EXIT_RUN, resets: resetsAt(9 * MINUTE, 17 * MINUTE), slowFromMs: 4 * SECOND });
    expect(report().text).toContain(BOTH_DONE);
  });

  test("a reset seen over 5 minutes after the intent's last record isn't its", () => {
    // The first slow snapshots showing the resets at 9:30 and 17:30.
    resetRun({ held: EXIT_RUN, resets: resetsAt(9 * MINUTE + 5 * SECOND, 17 * MINUTE + 5 * SECOND) });
    expect(report().text).toContain(BOTH_NOT_DONE);
  });

  test("an install's reset isn't a destroy's: a destroy is seen by the BitNode changing", () => {
    // Only a new `lastAugReset` just after the destroy was held (the install's 8 min before: too long ago).
    resetRun({ held: EXIT_RUN, resets: [{ kind: "install", atMs: DESTROY_MS + 5 * SECOND }] });
    expect(report().text).toContain(BOTH_NOT_DONE);
  });

  test("a destroy's reset is an install's too: it resets the cycle (`PlayerObjectGeneralMethods.ts:145`)", () => {
    resetRun({ held: [install(INSTALL_MS)], resets: [{ kind: "destroy", atMs: INSTALL_MS + 5 * SECOND }] });
    expect(report().text).toContain(`    installAugmentations: 1 done (1 ${BY_THE_RESET})\n`);
  });

  const NOT_JUDGED = "before the window's first slow snapshot: not judged";

  test("a destroy before the window's first slow snapshot isn't judged: that BitNode is no change from one before", () => {
    // No slow snapshot until 12:30, after the destroy was held; it shows the destroy's BitNode.
    resetRun({
      held: [destroy(DESTROY_MS)],
      resets: [{ kind: "destroy", atMs: DESTROY_MS + 5 * SECOND }],
      slowFromMs: DESTROY_MS + 30 * SECOND,
    });
    expect(report().text).toContain(`    destroyBitNode: 1 not done (1 ${NOT_JUDGED})\n`);
    expect(report({ verbose: true }).text).toContain(
      `    ${DESTROY}: not done, 1 try (ui): ${ENTERING}; first seen ${at(DESTROY_MS)}; ${NOT_JUDGED}\n`,
    );
  });

  test("nor an install, in the same words as section 4's for an install sent then", () => {
    // No slow snapshot until 4:30, after the install was held and sent; it shows the install's `lastAugReset`.
    resetRun({
      held: [install(INSTALL_MS)],
      resets: [{ kind: "install", atMs: INSTALL_MS + 5 * SECOND }],
      slowFromMs: INSTALL_MS + 30 * SECOND,
    });
    event(INSTALL_MS, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] });
    const { text, failures } = report();
    expect(text).toContain(`    installAugmentations: 1 not done (1 ${NOT_JUDGED})\n`);
    expect(text).toContain(`    ${INSTALL}: not done, 0 tries; first seen ${at(INSTALL_MS)}; ${NOT_JUDGED}\n`);
    expect(text).toContain(`    install sent at ${at(INSTALL_MS)}, ${NOT_JUDGED}\n`);
    expect(failures.filter((failure) => failure.startsWith("install not seen done"))).toEqual([]);
  });

  test("each side's method on its own: with no slow snapshot by then, the first one after is no reset", () => {
    // A caller that doesn't ask `resetKnownBy` or `bitNodeKnownBy` first: the first slow snapshot shows a destroy.
    const augmentations = new AugmentationTimeline();
    const cycles = new BitNodeCycles([], { sinceMs: T0 });
    const destroyed = slowData([], {}, { 1: 1 });
    destroyed.resetInfo.lastAugReset = T0 + MINUTE;
    destroyed.resetInfo.lastNodeReset = T0 + MINUTE;
    augmentations.addSlow(T0 + 2 * MINUTE, destroyed, 0);
    cycles.addSlow(T0 + 2 * MINUTE, 0, destroyed);
    expect([augmentations.resetKnownBy(T0), cycles.bitNodeKnownBy(T0)]).toEqual([false, false]);
    const later = T0 + 2 * MINUTE;
    expect([augmentations.resetKnownBy(later), cycles.bitNodeKnownBy(later)]).toEqual([true, true]);
    expect(augmentations.resetSeenBetween(T0, T0 + 10 * MINUTE)).toBeNull();
    expect(cycles.bitNodeSeenBetween(T0, T0 + 10 * MINUTE)).toBeNull();
  });

  describe("an ordinary intent splits only where the Agent's own tries start again", () => {
    const NO_MONEY = "no money";
    const travel = (tries: number) => intent("travel(Aevum)", { tries, problem: NO_MONEY, backend: "ui" });
    const stuck = (failures: string[]) => failures.filter((failure) => failure.startsWith("intent stuck"));

    test("a gap in the fast snapshots, tries 3 then 5: one episode, stuck once", () => {
      // No fast snapshot from 4:50 to 5:10 (the heartbeat's gap): the same list either side.
      cleanRun({
        fast: (offsetMs) => fastData({ intents: [travel(offsetMs < 5 * MINUTE ? 3 : 5)] }),
        skipFast: (offsetMs) => offsetMs > 5 * MINUTE - 10 * SECOND && offsetMs < 5 * MINUTE + 10 * SECOND,
      });
      const { text, failures } = report();
      expect(text).toContain("    travel: 1 not done\n");
      expect(stuck(failures)).toEqual([`intent stuck: travel(Aevum), not done, 5 tries (ui): ${NO_MONEY}`]);
    });

    test("a snapshot without it, then tries 0 to 5: two episodes, the second stuck", () => {
      // At 3 tries until 5 min, gone at 5:00 (the list empty), then given again: 0 tries, 5 from 6 min.
      cleanRun({
        fast: (offsetMs) =>
          fastData({
            intents:
              offsetMs < 5 * MINUTE
                ? [travel(3)]
                : offsetMs === 5 * MINUTE
                  ? []
                  : [travel(offsetMs < 6 * MINUTE ? 0 : 5)],
          }),
      });
      const { text, failures } = report();
      expect(text).toContain("    travel: 2 not done\n");
      expect(stuck(failures)).toEqual([`intent stuck: travel(Aevum), not done, 5 tries (ui): ${NO_MONEY}`]);
    });
  });
});

/**
 * Thins the store (#283) as a brain started a day after `cutoffOffsetMs` would, keeping a day whole: a slow snapshot
 * then, out of the window, is the newest record, so the cutoff is `cutoffOffsetMs` (on a minute).
 */
function thinBefore(cutoffOffsetMs: number) {
  const DAY = 24 * 60 * MINUTE;
  snapshot("slow", DAY + cutoffOffsetMs, slowData());
  flush();
  return thinStore(store, { context, nowMs: T0 + DAY + cutoffOffsetMs, keptWholeDays: 1 });
}
/** The report's lines in one text and not the other: [only in `first`, only in `second`]. */
function linesApart(first: string, second: string): [string[], string[]] {
  const [a, b] = [first.split("\n"), second.split("\n")];
  return [a.filter((line) => !b.includes(line)), b.filter((line) => !a.includes(line))];
}

describe("over a thinned store (#283)", () => {
  /** A busy run's fast snapshots: an intent done after a minute, work converging, the batcher batching. */
  const busyFast = (offsetMs: number) =>
    fastData({
      intents:
        offsetMs < 70 * SECOND
          ? [intent("buyTor(Alpha Enterprises)")]
          : [intent("buyTor(Alpha Enterprises)", { done: true, tries: 2, backend: "ui" })],
      work: offsetMs < 30 * SECOND ? null : { converged: offsetMs >= 40 * SECOND, problem: null, backend: "sim" },
      pageHeapUsedBytes: (offsetMs === 100 * SECOND ? 300 : 100) * 1024 * 1024,
      batcher: { ...newBatcherHealth("n00dles", "run-a", 0), state: "batching", batchesStarted: offsetMs / 1000 },
    });
  const headings = (text: string) => text.split("\n").filter((line) => /^(\d\. |Verdict)/.test(line));
  const DAY = 24 * 60 * MINUTE;

  const note = (lastOffsetMs: number, fast: number, medium: number) =>
    `  note: the store is thinned (#283) in this window, up to ${at(lastOffsetMs)}: ${fast} fast and ${medium} medium ` +
    "snapshots there keep only their times, one of each a minute kept whole. The heartbeat's gaps, clock steps, page " +
    "stalls and the page heap read every one; the rest read the whole ones, so their times there are within a " +
    "minute, what came and went within one isn't seen, a backdoor overdue (it needs medium snapshots within 30 s) and " +
    "a batcher stuck on a poor target (looks within 6 s) aren't judged there, and the batcher not running for 3 fast " +
    "snapshots in a row counts whole ones, a minute apart";

  test("a clean run thinned throughout: PASS, the same sections and time checks; only what came and went within a minute differs", () => {
    cleanRun({ fast: busyFast });
    const whole = report();
    // 596 fast snapshots from 10 s to 20 min, every 2 s: all but the first of each minute; 120 medium likewise.
    expect(thinBefore(RUN_MS + MINUTE).thinned).toEqual({ fast: 575, medium: 99 });
    const thinned = report();
    expect(thinned.failures).toEqual([]);
    expect(thinned.warnings).toEqual([]);
    expect(headings(thinned.text)).toEqual(headings(whole.text));
    expect(headings(thinned.text).at(-1)).toBe("Verdict: PASS");
    expect(linesApart(whole.text, thinned.text)).toEqual([
      [
        `    buyTor(Alpha Enterprises): done after 2 tries (ui); done by ${at(70 * SECOND)}`,
        "    BN1.1 1: 3 changes: none wanted, not converged (sim), converged (sim)",
      ],
      [
        note(RUN_MS - 2 * SECOND, 575, 99),
        // Seen done at the next whole snapshot, a minute's.
        `    buyTor(Alpha Enterprises): done after 2 tries (ui); done by ${at(2 * MINUTE)}`,
        // Not converged for 10 s, within a minute: not seen.
        "    BN1.1 1: 2 changes: none wanted, converged (sim)",
      ],
    ]);
    // The time checks read every snapshot: the heartbeat's count, its longest interval, and the page heap's 300 MB at
    // 1 min 40 s, a thinned snapshot's.
    expect(thinned.text).toContain(`    596 snapshots, first ${at(10 * SECOND)}, last ${at(RUN_MS)}; `);
    expect(thinned.text).toContain("    longest interval 2.0 s\n    no gaps");
    expect(thinned.text).toContain("  page heap: first 100.0 MB, last 100.0 MB, lowest 100.0 MB, highest 300.0 MB");
    // The batcher's target one stretch across the thinned minutes, not one a minute.
    expect(thinned.text).toContain(`    n00dles: ${at(10 * SECOND)} to ${at(RUN_MS)}\n`);
  });

  test("the batcher seen stopped at a whole snapshot there ends its stretch: the thinned ones after don't carry it on", () => {
    // Stopped from 2:00 to 2:05: the 2:00 snapshot is a minute's whole one.
    cleanRun({
      fast: (offsetMs) => ({
        ...busyFast(offsetMs),
        batcher: offsetMs >= 2 * MINUTE && offsetMs <= 2 * MINUTE + 5 * SECOND ? null : busyFast(offsetMs).batcher,
      }),
    });
    expect(report().text).toContain(
      `    n00dles: ${at(10 * SECOND)} to ${at(2 * MINUTE - 2 * SECOND)}\n    n00dles: ${at(2 * MINUTE + 6 * SECOND)} to `,
    );
    thinBefore(RUN_MS + MINUTE);
    // Seen running at 1:00, stopped at 2:00, running at 3:00: two stretches, as before, at the minutes' times.
    expect(report().text).toContain(
      `    n00dles: ${at(10 * SECOND)} to ${at(MINUTE)}\n    n00dles: ${at(3 * MINUTE)} to ${at(RUN_MS)}\n`,
    );
  });

  test("a window ending between whole snapshots: the BitNodes line the same (#296's ResetDetection), the last readings a minute's", () => {
    cleanRun({ fast: busyFast });
    // The window ends at 19:59, so its last fast and medium snapshots are stubs (the minute's whole ones at 19:00).
    const before = { ...window, untilMs: T0 + RUN_MS - SECOND };
    const whole = runReport(store, before).text;
    thinBefore(RUN_MS + MINUTE);
    const thinned = runReport(store, before);
    const bitNodes =
      `  BitNodes: BN1.1 from ${at(-60 * MINUTE)} (before the window), not destroyed, 1 h 19 min by the window's last ` +
      "record\n";
    expect(whole).toContain(bitNodes);
    expect(thinned.text).toContain(bitNodes);
    expect(thinned.failures).toEqual([]);
    // Besides the note and the two within-a-minute lines, the window's last readings are 19:00's whole ones: the money
    // (in section 2 and the World Daemon's), the batcher's target and its batches, a minute short.
    const [onlyWhole, onlyThinned] = linesApart(whole, thinned.text);
    expect([onlyWhole.length, onlyThinned.length]).toEqual([7, 8]);
    expect(onlyThinned).toContain(`    n00dles: ${at(10 * SECOND)} to ${at(19 * MINUTE)}`);
    expect(onlyThinned).toContain("    money: $11,000 → $1,141,000");
  });

  test("thinned up to the window's middle: PASS, no gap or stall where the thinned part ends", () => {
    cleanRun({ fast: busyFast });
    const whole = report();
    thinBefore(10 * MINUTE);
    const thinned = report();
    expect(thinned.failures).toEqual([]);
    expect(thinned.text).toContain(note(10 * MINUTE - 2 * SECOND, 24 + 9 * 29, 4 + 9 * 5));
    expect(linesApart(whole.text, thinned.text)[1]).toHaveLength(3);
  });

  test("its failures fail the same: a heartbeat gap, an intent stuck, a dialog left blocking, an income stall", () => {
    cleanRun({
      skipFast: (offsetMs) => offsetMs > 3 * MINUTE && offsetMs < 3 * MINUTE + 10 * SECOND,
      fast: (offsetMs) =>
        fastData({
          intents: [intent("buyTor(Alpha Enterprises)", { tries: 5, problem: "no City in the sidebar" })],
          dialogs: { handled: [], blocking: offsetMs >= MINUTE && offsetMs <= 2 * MINUTE ? "Are you sure?" : null },
        }),
      money: (offsetMs) => (offsetMs < 5 * MINUTE ? 1_000 + offsetMs : 1_000 + 5 * MINUTE),
    });
    const whole = report();
    expect(whole.failures).toHaveLength(4);
    thinBefore(RUN_MS + MINUTE);
    expect(report().failures).toEqual(whole.failures);
  });

  test("what came and went within a minute isn't seen: a dialog blocking 20 s between two whole snapshots", () => {
    cleanRun({
      fast: (offsetMs) =>
        fastData({
          dialogs: { handled: [], blocking: offsetMs >= 70 * SECOND && offsetMs <= 90 * SECOND ? "x" : null },
        }),
    });
    expect(report().failures).toEqual([`dialog left blocking from ${at(70 * SECOND)} to ${at(90 * SECOND)}: "x"`]);
    thinBefore(RUN_MS + MINUTE);
    expect(report().failures).toEqual([]);
  });

  test("section 1 says what a thinning in the window did, or that it failed", () => {
    cleanRun();
    thinBefore(RUN_MS + MINUTE);
    event(RUN_MS, "storeThinned", {
      beforeMs: T0,
      fromMs: null,
      keptWholeDays: 14,
      thinned: { fast: 3, medium: 2 },
      bytesBefore: 2_500_000,
      bytesAfter: 1_000,
    });
    event(RUN_MS, "storeThinned", { beforeMs: T0 });
    event(RUN_MS, "storeThinningFailed", { failure: "disk I/O error" });
    const { text, failures } = report();
    expect(text).toContain(
      `  ${at(RUN_MS)}  store thinned before ${at(0)} (the last 14 days before the newest snapshot kept whole; ` +
        "before, one fast and one medium snapshot a minute): 3 fast and 2 medium snapshots cut to their times, their " +
        "data 2.5 MB → 0.0 MB\n" +
        `  ${at(RUN_MS)}  store thinned: {"beforeMs":${T0}}\n` +
        `  ${at(RUN_MS)}  store thinning FAILED, the store left as it was: disk I/O error\n`,
    );
    // The brain started all the same: not the run's failure.
    expect(failures).toEqual([]);
  });

  test("a thinning at this brain's start, just before its brainStarted, is in the default window's section 1; an older one isn't", () => {
    // Before an earlier brain start in the day before: another run's.
    event(-2 * 60 * MINUTE, "storeThinned", { beforeMs: T0 - DAY, thinned: { fast: 1, medium: 0 }, keptWholeDays: 9 });
    event(-60 * MINUTE, "brainStarted", { release: "r0" });
    // This start's: a thinning, and one that failed, just before cleanRun's brainStarted at T0.
    event(-3 * SECOND, "storeThinned", {
      beforeMs: T0 - 14 * DAY,
      fromMs: null,
      keptWholeDays: 14,
      thinned: { fast: 30, medium: 6 },
      bytesBefore: 9_000_000,
      bytesAfter: 7_000,
      tookMs: 2_500,
    });
    event(-2 * SECOND, "storeThinningFailed", { failure: "disk I/O error" });
    cleanRun();
    const { text, failures } = report();
    expect(text).toContain(
      `1. The window\n  note: the brain also started at ${at(-60 * MINUTE)}, 1 h 0 min before the window: for a run that ` +
        "spans a restart, give --since\n" +
        `  ${at(-3 * SECOND)}  store thinned before ${at(-14 * DAY)} (the last 14 days before the newest snapshot ` +
        "kept whole; before, one fast and one medium snapshot a minute): 30 fast and 6 medium snapshots cut to their " +
        "times, their data 9.0 MB → 0.0 MB, in 2.5 s (before the window)\n" +
        `  ${at(-2 * SECOND)}  store thinning FAILED, the store left as it was: disk I/O error (before the window)\n`,
    );
    expect(text).not.toContain("the last 9 days");
    expect(failures).toEqual([]);
  });

  test("section 1 lists the data backups (#284), and those that failed, counted; the one before the start's thinning too", () => {
    // Another run's, before an earlier brain start in the day before: not this one's.
    event(-2 * 60 * MINUTE, "dataBackup", { reason: "thinning", directory: "backups/old", storeBytes: 1, saves: [] });
    event(-60 * MINUTE, "brainStarted", { release: "r0" });
    // That earlier run's own, at its start and interval, after its brainStarted: not the thinning's (#298's review).
    event(-50 * MINUTE, "dataBackup", {
      reason: "start",
      directory: "backups/earlier-start",
      storeBytes: 1,
      saves: [],
    });
    event(-10 * MINUTE, "dataBackupFailed", { reason: "interval", failure: "earlier interval" });
    // This start's thinning's backup failing, before the one that worked.
    event(-5 * SECOND, "dataBackupFailed", { reason: "thinning", failure: "disk busy" });
    // This start's, before its thinning, just before cleanRun's brainStarted at T0.
    const backup = (reason: string, directory: string) => ({
      reason,
      directory,
      storeBytes: 412_300_000,
      saves: ["saves/E0/a.json.gz"],
      tookMs: 1_700,
      removed: [],
    });
    event(-4 * SECOND, "dataBackup", backup("thinning", "backups/before-thinning"));
    cleanRun();
    event(RUN_MS / 4, "dataBackup", backup("start", "backups/at-the-start"));
    event(RUN_MS / 2, "dataBackup", backup("interval", "backups/at-the-interval"));
    event(RUN_MS, "dataBackupFailed", { reason: "interval", failure: "not enough free space" });
    const { text, failures } = report();
    expect(text).toContain(
      `  ${at(-4 * SECOND)}  data backup backups/before-thinning (before the start's thinning): the store 412.3 MB, 1 ` +
        "save backup, in 1.7 s (before the window)\n",
    );
    expect(text).not.toContain("backups/old");
    expect(text).not.toContain("backups/earlier-start");
    expect(text).not.toContain("earlier interval");
    expect(text).toContain(
      `  ${at(-5 * SECOND)}  data backup FAILED (before the start's thinning): disk busy (before the window)\n`,
    );
    expect(text).toContain(
      `  ${at(RUN_MS / 2)}  data backup backups/at-the-interval (at the interval): the store 412.3 MB, 1 save backup, ` +
        "in 1.7 s\n",
    );
    expect(text).toContain(`  ${at(RUN_MS)}  data backup FAILED (at the interval): not enough free space\n`);
    expect(text).toContain("; save backups: 1; data backups: 2, 1 FAILED\n");
    // Play went on: not the run's failure.
    expect(failures).toEqual([]);
  });

  test("npm run thin after the run isn't the run's last record: no gap to it", () => {
    cleanRun();
    // A thinning by hand 20 s after the run's last fast snapshot, in the window.
    event(RUN_MS + 20 * SECOND, "storeThinned", { beforeMs: T0 - DAY });
    event(RUN_MS + 25 * SECOND, "storeThinningFailed", { failure: "x" });
    const { text, failures } = report();
    expect(failures).toEqual([]);
    expect(text).toContain(`after the run's last record (${at(RUN_MS)}), 30 s to its end`);
  });

  test("a gap after a reset intent held only at a thinned snapshot is still the game reloading: its stub keeps the id", () => {
    // The install held at 1:02 alone (a stub after 1:00's whole one); the Agent silent 1:02 to 1:40, back at 1:35.
    cleanRun({
      skipFast: (offsetMs) => offsetMs > 62 * SECOND && offsetMs < 100 * SECOND,
      fast: (offsetMs) =>
        fastData({ intents: offsetMs === 62 * SECOND ? [intent("installAugmentations()", { done: true })] : [] }),
    });
    event(95 * SECOND, "agentConnected", { agentSessionId: "session-2", deploymentId: "dep-b", game: {} });
    const expected =
      `    gap: ${at(62 * SECOND)} to ${at(100 * SECOND)} (38.0 s); during it: agentConnected at ${at(95 * SECOND)}; ` +
      "before it, the Agent held installAugmentations() (expected: the game reloading after the " +
      "installAugmentations() the Agent held)\n";
    const whole = report();
    expect(whole.failures).toEqual([]);
    expect(whole.text).toContain(expected);
    thinBefore(RUN_MS + MINUTE);
    const thinned = report();
    expect(thinned.failures).toEqual([]);
    expect(thinned.text).toContain(expected);
  });
});
