// The campaign report (#290): clear time, cycles and installs per BitNode, per release, over the whole store. Over
// synthetic stores built here, never the owner's .data/: five BitNodes across four releases (one the same brain with
// two deployments), brain restarts, an offline gap, an install from your queue, a save loaded, and the same campaign
// thinned as #283 plans (events and slow snapshots, a medium snapshot a minute, no fast ones).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { brainReleaseOf, campaignReport } from "../src/campaign-report.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const CAMPAIGN_CLI = path.resolve(import.meta.dirname, "../src/campaign-cli.ts");
const T0 = Date.parse("2026-11-01T00:00:00Z");
const MINUTE = 60_000;
/** The brain's clock (and the game's: one machine) `minutes` after T0. */
const m = (minutes: number) => T0 + minutes * MINUTE;
const at = (minutes: number) => new Date(m(minutes)).toISOString();

let directory: string;
let thinDirectory: string;
/** Every tier, as the brain records it. */
let full: TelemetryStore;
/** The same campaign as #283 would thin it: the events and slow snapshots, a medium snapshot a minute, no fast one. */
let thin: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "campaign-report-"));
  thinDirectory = mkdtempSync(path.join(os.tmpdir(), "campaign-report-thin-"));
  full = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
  thin = TelemetryStore.open(path.join(thinDirectory, STORE_FILE_NAME));
});
afterEach(() => {
  full.close();
  thin.close();
  rmSync(directory, { recursive: true, force: true });
  rmSync(thinDirectory, { recursive: true, force: true });
});

let sequenceNumber = 0;
function snapshot(store: TelemetryStore, release: string, tier: string, atMs: number, data: unknown) {
  store.recordSnapshot(
    { environment: "E0", release },
    {
      agentSessionId: "session-1",
      tier,
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: atMs,
      receivedAtMs: atMs,
      missedBefore: 0,
      data,
    },
  );
}
function event(minutes: number, release: string, kind: string, detail: unknown = {}) {
  for (const store of [full, thin])
    store.recordEvent({ environment: "E0", release }, { atMs: m(minutes), kind, detail });
}
const medium = (money: number) => ({ player: { money, skills: { hacking: 10 }, factions: [] }, servers: [] });
const fast = { degradedTiers: [], pageHeapUsedBytes: null, intents: [], dialogs: { handled: [], blocking: null } };

interface Stretch {
  /** The minutes from T0 with a slow snapshot each, both ends in. */
  from: number;
  to: number;
  release: string;
  /** `lastNodeReset` and `lastAugReset`, in minutes from T0. */
  node: number;
  aug: number;
  /** SF1's level: BN1.1 has none. */
  sf?: number;
  augs?: Record<string, number>;
}
/** A stretch of play: a slow snapshot a minute; in the full store a medium and a fast one every 10 s besides. */
function play({ from, to, release, node, aug, sf = 0, augs = {} }: Stretch) {
  const resetInfo = {
    lastAugReset: m(aug),
    lastNodeReset: m(node),
    currentNode: 1,
    ownedAugs: augs,
    ownedSF: (sf === 0 ? {} : { "1": sf }) as Record<string, number>,
    bitNodeOptions: {},
  };
  const slow: SlowSnapshotData = { resetInfo, purchasedServers: [] };
  for (const store of [full, thin]) {
    store.writeTransaction(() => {
      for (let minute = from; minute <= to; minute++) {
        snapshot(store, release, "slow", m(minute), slow);
        if (store === thin) snapshot(store, release, "medium", m(minute) + 5_000, medium(minute));
        else {
          for (let second = 0; second < 60; second += 10) {
            snapshot(store, release, "medium", m(minute) + second * 1_000 + 5_000, medium(minute));
            snapshot(store, release, "fast", m(minute) + second * 1_000 + 2_000, fast);
          }
        }
      }
    });
  }
}

const V100 = "v1.0.0+aaaaaaaa";
const V100_REDEPLOYED = "v1.0.0+bbbbbbbb";
const V101 = "v1.0.1+cccccccc";
const V110 = "v1.1.0+dddddddd";
const EARLY = { BitWire: 1, "Neurotrainer I": 1 };
const LATER = { ...EARLY, "NeuroFlux Governor": 2, "Synaptic Enhancement Implant": 1 };

/**
 * The campaign, in minutes from T0:
 * - BN1.1, begun two days before the store (and installed in, at -120), v1.0.0: the brain starts at 0, installs at
 *   60.5, restarts onto another deployment at 120.5, goes away at 180 (the game closed) and starts again at 299,
 *   installs from your queue at 360.5, and destroys at 420.5. Online: 1 to 180 and 300 to 420.5, 4 h 59 min 30 s.
 * - BN1.2 from 420.5: v1.0.0 to 480 and its install at 480.5, then v1.0.1 (started at 480.6) installs at 540.5 and
 *   destroys at 600.5. Online 3 h: v1.0.0's 59 min 30 s (420.5 to 480), v1.0.1's 2 h 0 min 30 s.
 * - BN1.3 from 600.5, v1.0.1 alone: an install at 630.5, destroyed at 660.5, 1 h online: a clear of its own.
 * - BN1.4 from 660.5, v1.0.1 alone: installs at 700.5 and 730.5, destroyed at 760.5, 1 h 40 min online.
 * - BN1.4 again from 760.5 (SF1 is at its most), v1.1.0 alone (started at 760.8): an install at 800.5, destroyed at
 *   840.5, 1 h 20 min online: faster than v1.0.1's.
 * - BN1.4 a third time from 840.5, v1.1.0: an install at 855.5, a save from before it loaded at 862, a destroy sent at
 *   870.3 and the next BitNode not seen.
 */
function campaign() {
  event(0, V100, "brainStarted", { release: "v1.0.0" });
  play({ from: 1, to: 60, release: V100, node: -48 * 60, aug: -120 });
  event(60.3, V100, "augmentationInstallSent", { source: "brain", queued: ["BitWire"] });
  play({ from: 61, to: 120, release: V100, node: -48 * 60, aug: 60.5, augs: EARLY });
  event(120.5, V100_REDEPLOYED, "brainStarted", { release: "v1.0.0" });
  play({ from: 121, to: 180, release: V100_REDEPLOYED, node: -48 * 60, aug: 60.5, augs: EARLY });
  event(299, V100_REDEPLOYED, "brainStarted", { release: "v1.0.0" });
  play({ from: 300, to: 360, release: V100_REDEPLOYED, node: -48 * 60, aug: 60.5, augs: EARLY });
  event(360.3, V100_REDEPLOYED, "augmentationInstallSent", { source: "manual", queued: [] });
  play({ from: 361, to: 420, release: V100_REDEPLOYED, node: -48 * 60, aug: 360.5, augs: LATER });
  event(420.3, V100_REDEPLOYED, "bitNodeDestroySent", {});

  play({ from: 421, to: 480, release: V100_REDEPLOYED, node: 420.5, aug: 420.5, sf: 1 });
  event(480.3, V100_REDEPLOYED, "augmentationInstallSent", { source: "brain", queued: [] });
  // The owner upgrades the brain as the install reloads the game: the install is v1.0.0's, the cycle after v1.0.1's.
  event(480.6, V101, "brainStarted", { release: "v1.0.1" });
  play({ from: 481, to: 540, release: V101, node: 420.5, aug: 480.5, sf: 1, augs: EARLY });
  event(540.3, V101, "augmentationInstallSent", { source: "brain", queued: [] });
  play({ from: 541, to: 600, release: V101, node: 420.5, aug: 540.5, sf: 1, augs: LATER });
  event(600.3, V101, "bitNodeDestroySent", {});

  play({ from: 601, to: 630, release: V101, node: 600.5, aug: 600.5, sf: 2 });
  play({ from: 631, to: 660, release: V101, node: 600.5, aug: 630.5, sf: 2, augs: EARLY });
  event(660.3, V101, "bitNodeDestroySent", {});

  play({ from: 661, to: 700, release: V101, node: 660.5, aug: 660.5, sf: 3 });
  play({ from: 701, to: 730, release: V101, node: 660.5, aug: 700.5, sf: 3, augs: EARLY });
  play({ from: 731, to: 760, release: V101, node: 660.5, aug: 730.5, sf: 3, augs: LATER });
  event(760.3, V101, "bitNodeDestroySent", {});

  event(760.8, V110, "brainStarted", { release: "v1.1.0" });
  play({ from: 761, to: 800, release: V110, node: 760.5, aug: 760.5, sf: 3 });
  play({ from: 801, to: 840, release: V110, node: 760.5, aug: 800.5, sf: 3, augs: EARLY });
  event(840.3, V110, "bitNodeDestroySent", {});

  play({ from: 841, to: 855, release: V110, node: 840.5, aug: 840.5, sf: 3 });
  play({ from: 856, to: 861, release: V110, node: 840.5, aug: 855.5, sf: 3, augs: EARLY });
  play({ from: 862, to: 870, release: V110, node: 840.5, aug: 840.5, sf: 3 });
  event(870.3, V110, "bitNodeDestroySent", {});
}

/** The report's rows under the line starting `heading`, to the blank line, each split into its padded cells. */
function rowsUnder(report: string, heading: string): string[][] {
  const lines = report.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line === "");
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/ {2,}/));
}

describe("the campaign report", () => {
  test("a row per BitNode: its start, its end, its clear time online and by the clock, its cycles and installs", () => {
    campaign();
    const report = campaignReport(full, { environment: "E0" });
    expect(report).toContain(
      `Campaign report (E0): every BitNode and release in the store, from ${at(0)} to ${at(870.3)} (14 h 30 min)`,
    );
    expect(report).toContain(
      "  read: 751 slow snapshots and the events of the brain's starts (5), installs and destroys",
    );
    expect(report).toContain('the Agent\'s deployment after the "+" left out): v1.0.0, v1.0.1, v1.1.0');
    const rows = rowsUnder(report, "BitNodes, one row each");
    expect(rows[0]).toEqual([
      "BitNode",
      "started",
      "ended",
      "wall clock",
      "online",
      "cycles",
      "installs",
      "augmentations",
      "brain starts",
      "releases",
    ]);
    // BN1.1: begun two days before the store's first record, and installed in: at least.
    expect(rows[1]).toEqual([
      "BN1.1",
      `${at(-48 * 60)} (before the store)`,
      `destroyed ${at(420.5)}`,
      "55 h 0 min",
      // 1 to 180 and 300 to 420.5: the offline gap left out.
      "≥ 4 h 59 min",
      "≥ 4",
      "≥ 3 (1 from your queue)",
      "4",
      "3",
      "v1.0.0",
    ]);
    expect(rows[2]).toEqual([
      "BN1.2",
      at(420.5),
      `destroyed ${at(600.5)}`,
      "3 h 0 min",
      "3 h 0 min",
      "3",
      "2",
      "4",
      "1",
      "v1.0.0, v1.0.1",
    ]);
    expect(rows[3]).toEqual([
      "BN1.3",
      at(600.5),
      `destroyed ${at(660.5)}`,
      "1 h 0 min",
      "1 h 0 min",
      "2",
      "1",
      "2",
      "0",
      "v1.0.1",
    ]);
    expect(rows[4]).toEqual([
      "BN1.4",
      at(660.5),
      `destroyed ${at(760.5)}`,
      "1 h 40 min",
      "1 h 40 min",
      "3",
      "2",
      "4",
      "0",
      "v1.0.1",
    ]);
    expect(rows[5]).toEqual([
      "BN1.4 #2",
      at(760.5),
      `destroyed ${at(840.5)}`,
      "1 h 20 min",
      "1 h 20 min",
      "2",
      "1",
      "2",
      "1",
      "v1.1.0",
    ]);
    expect(rows[6]).toEqual([
      "BN1.4 #3",
      at(840.5),
      `destroy sent ${at(870.3)}, the next BitNode not seen`,
      "29 min 30 s so far",
      "29 min 30 s so far",
      "2",
      "1",
      "0",
      "0",
      "v1.1.0",
    ]);
    expect(rows).toHaveLength(7);
  });

  test("each BitNode's time online by release, its augmentations, and a save loaded", () => {
    campaign();
    const report = campaignReport(full, { environment: "E0" });
    expect(report).toContain(
      "  BN1.1:\n    time online by release: v1.0.0 4 h 59 min\n" +
        "    installed at its last look: BitWire, Neurotrainer I, NeuroFlux Governor ×2, Synaptic Enhancement Implant",
    );
    expect(report).toContain("  BN1.2:\n    time online by release: v1.0.0 59 min 30 s, v1.0.1 2 h 0 min\n");
    expect(report).toContain(
      `  BN1.4 #3:\n    time online by release: v1.1.0 29 min 30 s\n    installed at its last look: none\n` +
        `    an older save loaded ${at(862)}: a lastAugReset earlier than the cycle's before it`,
    );
    expect(report.match(/an older save loaded/g)).toHaveLength(1);
  });

  test("a row per release and BitNode it played: its time online, cycles, installs, and its clears", () => {
    campaign();
    const rows = rowsUnder(campaignReport(full, { environment: "E0" }), "By release");
    expect(rows).toEqual([
      ["release", "BitNode", "online", "cycles", "installs", "destroyed"],
      // Its two deployments are one release; the install before the store's first record isn't its.
      ["v1.0.0", "BN1.1", "4 h 59 min", "3", "2", "yes, the BitNode's start not seen in the store"],
      ["v1.0.0", "BN1.2", "59 min 30 s", "1", "1", "no"],
      ["v1.0.1", "BN1.2", "2 h 0 min", "2", "1", "yes, played with v1.0.0 too"],
      ["v1.0.1", "BN1.3", "1 h 0 min", "2", "1", "yes, a clear of its own: 1 h 0 min online, 1 h 0 min by the clock"],
      [
        "v1.0.1",
        "BN1.4",
        "1 h 40 min",
        "3",
        "2",
        "yes, a clear of its own: 1 h 40 min online, 1 h 40 min by the clock",
      ],
      [
        "v1.1.0",
        "BN1.4 #2",
        "1 h 20 min",
        "2",
        "1",
        "yes, a clear of its own: 1 h 20 min online, 1 h 20 min by the clock",
      ],
      ["v1.1.0", "BN1.4 #3", "29 min 30 s", "2", "1", "no"],
    ]);
  });

  test("releases compared on a BitNode each cleared on its own, the fastest online first", () => {
    campaign();
    const report = campaignReport(full, { environment: "E0" });
    expect(report).toContain(
      "Compared: each BitNode two releases or more cleared on their own, the fastest online first:\n" +
        "  BN1.4: v1.1.0 1 h 20 min online (1 h 20 min by the clock, 2 cycles); " +
        "v1.0.1 1 h 40 min online (1 h 40 min by the clock, 3 cycles)",
    );
    // BN1.3 had one release's clear; BN1.2 two releases, neither on its own.
    expect(report).not.toMatch(/^ {2}BN1\.[23]: /m);
  });

  test("the same report from a store thinned to its events, slow snapshots and a medium one a minute (#283)", () => {
    campaign();
    expect(thin.snapshots({ environment: "E0" }).some((each) => each.tier === "fast")).toBe(false);
    expect(campaignReport(thin, { environment: "E0" })).toBe(campaignReport(full, { environment: "E0" }));
  });

  test("a fresh save's BitNode from its start, an older BitNode's save loaded, a slow snapshot it can't read", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 30, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 31, to: 40, release: V100, node: 30.5, aug: 30.5, sf: 1 });
    // BN1.1's save loaded again: an older BitNode, not a destroy.
    play({ from: 41, to: 50, release: V100, node: -0.5, aug: -0.5 });
    snapshot(full, V100, "slow", m(51), { purchasedServers: [] });
    const report = campaignReport(full, { environment: "E0" });
    expect(report).toContain("; 1 slow snapshots with no resetInfo to read, left out");
    const rows = rowsUnder(report, "BitNodes, one row each");
    // From its start (half a minute before the first slow snapshot) to the destroy: both edges online.
    expect(rows[1]).toEqual([
      "BN1.1",
      at(-0.5),
      `destroyed ${at(30.5)}`,
      "31 min",
      "31 min",
      "1",
      "0",
      "0",
      "1",
      "v1.0.0",
    ]);
    expect(rows[2]?.slice(0, 5)).toEqual([
      "BN1.2",
      at(30.5),
      `an older save loaded ${at(41)}`,
      "9 min 30 s so far",
      "9 min 30 s so far",
    ]);
    // Its start is the save's, long before: not online.
    expect(rows[3]?.slice(0, 5)).toEqual(["BN1.1 #2", at(40), "not yet", "10 min so far", "9 min so far"]);
    expect(report).toContain("  none yet: no BitNode cleared on their own by two releases");
  });

  test("a BitNode begun before the store's first record, with no install before: its time online at least", () => {
    play({ from: 0, to: 20, release: V100, node: -30, aug: -30 });
    play({ from: 21, to: 25, release: V100, node: 20.5, aug: 20.5, sf: 1 });
    const report = campaignReport(full, { environment: "E0" });
    // Its cycles and installs are all seen: its first look's cycle is its first.
    expect(rowsUnder(report, "BitNodes, one row each")[1]?.slice(0, 7)).toEqual([
      "BN1.1",
      `${at(-30)} (before the store)`,
      `destroyed ${at(20.5)}`,
      "50 min 30 s",
      "≥ 20 min 30 s",
      "1",
      "0",
    ]);
    // Not a clear of its own: the store didn't see its start.
    expect(rowsUnder(report, "By release")[1]).toEqual([
      "v1.0.0",
      "BN1.1",
      "20 min 30 s",
      "1",
      "0",
      "yes, the BitNode's start not seen in the store",
    ]);
  });

  test("throws with no slow snapshot showing a BitNode", () => {
    expect(() => campaignReport(full, { environment: "E0" })).toThrow(
      "no BitNode in the store (E0): 0 slow snapshots, none with a resetInfo to read",
    );
    snapshot(full, V100, "slow", m(0), { purchasedServers: [] });
    expect(() => campaignReport(full, { environment: "E0" })).toThrow("1 slow snapshots, none with a resetInfo");
  });
});

test("a release is the brain's, the Agent's deployment after the + left out", () => {
  expect(brainReleaseOf("v1.0.0+3f2a9c")).toBe("v1.0.0");
  expect(brainReleaseOf("v1.0.0-4-gabc1234-dirty+3f2a9c")).toBe("v1.0.0-4-gabc1234-dirty");
  expect(brainReleaseOf("unknown")).toBe("unknown");
});

describe("the command", () => {
  function runCli(dataDirectory: string, ...args: string[]): { exitCode: number; output: string } {
    try {
      const output = execFileSync(process.execPath, [CAMPAIGN_CLI, "--data-dir", dataDirectory, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });
      return { exitCode: 0, output };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { exitCode: failed.status, output: failed.stdout + failed.stderr };
    }
  }

  test("0 with the report, 2 when it couldn't run", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "campaign-report-empty-"));
    try {
      expect(runCli(empty)).toMatchObject({
        exitCode: 2,
        output: expect.stringContaining("campaign: No telemetry store at"),
      });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(runCli(directory)).toMatchObject({
      exitCode: 2,
      output: expect.stringContaining("campaign: no BitNode in the store (E0)"),
    });
    play({ from: 0, to: 5, release: V100, node: -0.5, aug: -0.5 });
    const done = runCli(directory);
    expect(done.exitCode).toBe(0);
    expect(done.output).toContain("Campaign report (E0)");
    expect(runCli(directory, "--environment", "E1")).toMatchObject({
      exitCode: 2,
      output: expect.stringContaining("(E1)"),
    });
    expect(runCli(directory, "--environment", "E9")).toMatchObject({
      exitCode: 2,
      output: expect.stringContaining("--environment must be one of"),
    });
  });
});
