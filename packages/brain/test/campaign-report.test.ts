// The campaign report (#290): clear time, cycles and installs per BitNode, per release, over the whole store. Over
// synthetic stores built here, never the owner's .data/: six BitNodes across three releases (four deployments), brain
// restarts, an offline gap, an install from your queue, a save loaded, and the same campaign thinned (#283: the events
// and slow snapshots, a medium snapshot a minute, no fast one). Then saves loaded within a BitNode and across them, a
// release changed mid-cycle, a new game, b1t_flum3, a destroy at the cap, installs by hand, and the command.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SlowSnapshotData } from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { brainReleaseOf } from "../src/campaign-model.ts";
import { campaignReport } from "../src/campaign-report.ts";
import { STORE_FILE_NAME } from "../src/config.ts";
import { thinStore } from "../src/store-thinning.ts";
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
/** A snapshot received at `atMs`, the game's clock `gameOffsetMs` from the brain's (none: one machine). */
function snapshot(store: TelemetryStore, release: string, tier: string, atMs: number, data: unknown, gameOffsetMs = 0) {
  store.recordSnapshot(
    { environment: "E0", release },
    {
      agentSessionId: "session-1",
      tier,
      sequenceNumber: ++sequenceNumber,
      gameTimeMs: atMs + gameOffsetMs,
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
const installSent = (minutes: number, release: string, source: "brain" | "manual" = "brain") =>
  event(minutes, release, "augmentationInstallSent", { source, queued: [] });
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
  /** The BitNode (1 unless given), and SF1's level (BN1.1 has none), or every Source-File's as given. */
  bitNode?: number;
  sf?: number | Record<string, number>;
  /** The game's clock less the brain's, in minutes: none, one machine's. */
  gameOffset?: number;
  /** The BitNode's `sourceFileOverrides` (its options): `ownedSF` then shows each at its override. */
  overrides?: Record<string, number>;
  augs?: Record<string, number>;
}
/** A stretch of play: a slow snapshot a minute; in the full store a medium and a fast one every 10 s besides. */
function play({ from, to, release, node, aug, bitNode = 1, sf = 0, augs = {}, gameOffset = 0, overrides }: Stretch) {
  const ownedSF: Record<string, number> = typeof sf === "number" ? (sf === 0 ? {} : { "1": sf }) : sf;
  const resetInfo = {
    lastAugReset: m(aug),
    lastNodeReset: m(node),
    currentNode: bitNode,
    ownedAugs: augs,
    ownedSF,
    bitNodeOptions: overrides === undefined ? {} : { sourceFileOverrides: overrides },
  };
  const slow: SlowSnapshotData = { resetInfo, purchasedServers: [] };
  for (const store of [full, thin]) {
    store.writeTransaction(() => {
      for (let minute = from; minute <= to; minute++) {
        snapshot(store, release, "slow", m(minute), slow, gameOffset * MINUTE);
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
 *   installs from your queue at 360.5 (by hand), and destroys at 420.5. Online: 1 to 180 and 300 to 420.5,
 *   4 h 59 min 30 s; 2 h left out.
 * - BN1.2 from 420.5: v1.0.0 to 480 and its install at 480.5, then v1.0.1 (started at 480.6) installs at 540.5 and
 *   destroys at 600.5. Online 3 h: v1.0.0's 59 min 30 s (420.5 to 480), v1.0.1's 2 h 0 min 30 s.
 * - BN1.3 from 600.5, v1.0.1 alone: an install at 630.5, destroyed at 660.5, 1 h online: a clear of its own.
 * - BN1.4 from 660.5, v1.0.1 alone: installs at 700.5 and 730.5, destroyed at 760.5 (SF1 at its cap, the destroy
 *   sent), 1 h 40 min online.
 * - BN1.4 again from 760.5, v1.1.0 alone (started at 760.8): an install at 800.5, destroyed at 840.5, 1 h 20 min
 *   online: faster than v1.0.1's.
 * - BN1.4 a third time from 840.5, v1.1.0: an install at 855.5, a save from before it loaded at 862, a destroy sent at
 *   870.3 and the next BitNode not seen.
 */
function campaign() {
  event(0, V100, "brainStarted", { release: "v1.0.0" });
  play({ from: 1, to: 60, release: V100, node: -48 * 60, aug: -120 });
  installSent(60.3, V100);
  play({ from: 61, to: 120, release: V100, node: -48 * 60, aug: 60.5, augs: EARLY });
  event(120.5, V100_REDEPLOYED, "brainStarted", { release: "v1.0.0" });
  play({ from: 121, to: 180, release: V100_REDEPLOYED, node: -48 * 60, aug: 60.5, augs: EARLY });
  event(299, V100_REDEPLOYED, "brainStarted", { release: "v1.0.0" });
  play({ from: 300, to: 360, release: V100_REDEPLOYED, node: -48 * 60, aug: 60.5, augs: EARLY });
  installSent(360.3, V100_REDEPLOYED, "manual");
  play({ from: 361, to: 420, release: V100_REDEPLOYED, node: -48 * 60, aug: 360.5, augs: LATER });
  event(420.3, V100_REDEPLOYED, "bitNodeDestroySent", {});

  play({ from: 421, to: 480, release: V100_REDEPLOYED, node: 420.5, aug: 420.5, sf: 1 });
  installSent(480.3, V100_REDEPLOYED);
  // The owner upgrades the brain as the install reloads the game: the install is v1.0.0's, the cycle after v1.0.1's.
  event(480.6, V101, "brainStarted", { release: "v1.0.1" });
  play({ from: 481, to: 540, release: V101, node: 420.5, aug: 480.5, sf: 1, augs: EARLY });
  installSent(540.3, V101);
  play({ from: 541, to: 600, release: V101, node: 420.5, aug: 540.5, sf: 1, augs: LATER });
  event(600.3, V101, "bitNodeDestroySent", {});

  play({ from: 601, to: 630, release: V101, node: 600.5, aug: 600.5, sf: 2 });
  installSent(630.3, V101);
  play({ from: 631, to: 660, release: V101, node: 600.5, aug: 630.5, sf: 2, augs: EARLY });
  event(660.3, V101, "bitNodeDestroySent", {});

  play({ from: 661, to: 700, release: V101, node: 660.5, aug: 660.5, sf: 3 });
  installSent(700.3, V101);
  play({ from: 701, to: 730, release: V101, node: 660.5, aug: 700.5, sf: 3, augs: EARLY });
  installSent(730.3, V101);
  play({ from: 731, to: 760, release: V101, node: 660.5, aug: 730.5, sf: 3, augs: LATER });
  event(760.3, V101, "bitNodeDestroySent", {});

  event(760.8, V110, "brainStarted", { release: "v1.1.0" });
  play({ from: 761, to: 800, release: V110, node: 760.5, aug: 760.5, sf: 3 });
  installSent(800.3, V110);
  play({ from: 801, to: 840, release: V110, node: 760.5, aug: 800.5, sf: 3, augs: EARLY });
  event(840.3, V110, "bitNodeDestroySent", {});

  play({ from: 841, to: 855, release: V110, node: 840.5, aug: 840.5, sf: 3 });
  installSent(855.3, V110);
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
const report = () => campaignReport(full, { environment: "E0" });
const bitNodeRows = () => rowsUnder(report(), "BitNodes, one row each");
const releaseRows = () => rowsUnder(report(), "By release");

describe("the campaign report", () => {
  test("a row per BitNode: its start, its end, its clear time online and by the clock, its cycles and installs", () => {
    campaign();
    const text = report();
    expect(text).toContain(
      `Campaign report (E0): every BitNode and release in the store, from ${at(0)} to ${at(870.3)} (14 h 30 min)`,
    );
    expect(text).toContain(
      "  read: 751 slow snapshots and the events of the brain's starts (5), installs and destroys, never a medium or " +
        "fast snapshot",
    );
    expect(text).toContain('the Agent\'s deployment after the "+" left out): v1.0.0, v1.0.1, v1.1.0');
    const rows = bitNodeRows();
    expect(rows[0]).toEqual([
      "BitNode",
      "started",
      "ended",
      "wall clock",
      "online",
      "left out",
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
      // 1 to 180 and 300 to 420.5: the offline gap left out, and shown.
      "≥ 4 h 59 min",
      "2 h 0 min in 1 gap",
      "≥ 4",
      "≥ 3 (1 by hand)",
      "4",
      "3",
      "v1.0.0",
    ]);
    const rest = ["none"];
    expect(rows[2]).toEqual([
      "BN1.2",
      at(420.5),
      `destroyed ${at(600.5)}`,
      "3 h 0 min",
      "3 h 0 min",
      ...rest,
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
      ...rest,
      "2",
      "1",
      "2",
      "0",
      "v1.0.1",
    ]);
    // SF1 at its cap: no level gained, the destroy known by the brain's own bitNodeDestroySent.
    expect(rows[4]).toEqual([
      "BN1.4",
      at(660.5),
      `destroyed ${at(760.5)} (at the cap)`,
      "1 h 40 min",
      "1 h 40 min",
      ...rest,
      "3",
      "2",
      "4",
      "0",
      "v1.0.1",
    ]);
    expect(rows[5]).toEqual([
      "BN1.4 #2",
      at(760.5),
      `destroyed ${at(840.5)} (at the cap)`,
      "1 h 20 min",
      "1 h 20 min",
      ...rest,
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
      ...rest,
      "2",
      "1",
      "0",
      "0",
      "v1.1.0",
    ]);
    expect(rows).toHaveLength(7);
  });

  test("each BitNode's Source-Files, time online by release, its augmentations, and a save loaded", () => {
    campaign();
    const text = report();
    expect(text).toContain(
      "  BN1.1: entered with no Source-File\n    time online by release: v1.0.0 4 h 59 min\n" +
        "    installed at its last look: BitWire, Neurotrainer I, NeuroFlux Governor ×2, Synaptic Enhancement Implant",
    );
    expect(text).toContain(
      "  BN1.2: entered with SF1.1\n    time online by release: v1.0.0 59 min 30 s, v1.0.1 2 h 0 min\n",
    );
    expect(text).toContain(
      "  BN1.4 #3: entered with SF1.3\n    time online by release: v1.1.0 29 min 30 s\n" +
        `    installed at its last look: none\n    a save loaded ${at(862)}: a lastAugReset seen already`,
    );
    expect(text.match(/^ {4}a save loaded/gm)).toHaveLength(1);
  });

  test("a row per release and BitNode it played: its time online, cycles, installs, and its clears", () => {
    campaign();
    const own = (time: string) => `yes, a clear of its own: ${time} online, ${time} by the clock`;
    expect(releaseRows()).toEqual([
      ["release", "BitNode", "online", "cycles", "installs", "destroyed"],
      // Its two deployments are one release; the install before the store's first record isn't its.
      ["v1.0.0", "BN1.1", "4 h 59 min", "3", "2 (1 by hand)", "yes, the BitNode's start not seen in the store"],
      ["v1.0.0", "BN1.2", "59 min 30 s", "1", "1", "no"],
      ["v1.0.1", "BN1.2", "2 h 0 min", "2", "1", "yes, played with v1.0.0 too"],
      ["v1.0.1", "BN1.3", "1 h 0 min", "2", "1", own("1 h 0 min")],
      ["v1.0.1", "BN1.4", "1 h 40 min", "3", "2", own("1 h 40 min")],
      ["v1.1.0", "BN1.4 #2", "1 h 20 min", "2", "1", own("1 h 20 min")],
      ["v1.1.0", "BN1.4 #3", "29 min 30 s", "2", "1", "no"],
    ]);
  });

  test("releases compared on a BitNode each cleared on its own, the fastest online first, with what's left out", () => {
    campaign();
    const text = report();
    expect(text).toContain(
      "Compared: each BitNode two releases or more cleared on their own, the fastest online first:\n" +
        "  BN1.4: v1.1.0 1 h 20 min online (1 h 20 min by the clock, 2 cycles, left out: none; SF1.3); " +
        "v1.0.1 1 h 40 min online (1 h 40 min by the clock, 3 cycles, left out: none; SF1.3)",
    );
    // BN1.3 had one release's clear; BN1.2 two releases, neither on its own.
    expect(text).not.toMatch(/^ {2}BN1\.[23]: v/m);
  });

  test("the same report from a store thinned to its events, slow snapshots and a medium one a minute (#283)", () => {
    campaign();
    expect(thin.snapshots({ environment: "E0" }).some((each) => each.tier === "fast")).toBe(false);
    expect(campaignReport(thin, { environment: "E0" })).toBe(report());
  });

  test("the same report after #283's own thinning of the full store: its stubs are fast and medium snapshots alone", () => {
    campaign();
    // A fast snapshot two days on, the newest: with a day kept whole, the whole campaign is thinned.
    snapshot(full, V110, "fast", m(870) + 2 * 24 * 60 * MINUTE, fast);
    const whole = report();
    const thinning = thinStore(full, {
      context: { environment: "E0", release: V110 },
      nowMs: m(870) + 2 * 24 * 60 * MINUTE,
      keptWholeDays: 1,
    });
    expect(thinning.thinned.fast).toBeGreaterThan(0);
    expect(thinning.thinned.medium).toBeGreaterThan(0);
    expect(report()).toBe(whole);
  });

  test("a fresh save's BitNode from its start, an older BitNode's save loaded, a slow snapshot it can't read", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 30, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 31, to: 40, release: V100, node: 30.5, aug: 30.5, sf: 1 });
    // BN1.1's save loaded again: an older BitNode, not a destroy.
    play({ from: 41, to: 50, release: V100, node: -0.5, aug: -0.5 });
    snapshot(full, V100, "slow", m(51), { purchasedServers: [] });
    const text = report();
    expect(text).toContain("; 1 slow snapshot with no resetInfo to read, left out");
    const rows = rowsUnder(text, "BitNodes, one row each");
    // From its start (half a minute before the first slow snapshot) to the destroy: both edges online.
    expect(rows[1]).toEqual([
      "BN1.1",
      at(-0.5),
      `destroyed ${at(30.5)}`,
      "31 min",
      "31 min",
      "none",
      "1",
      "0",
      "0",
      "1",
      "v1.0.0",
    ]);
    expect(rows[2]?.slice(0, 5)).toEqual([
      "BN1.2",
      at(30.5),
      `a save loaded ${at(41)}`,
      "9 min 30 s so far",
      "9 min 30 s so far",
    ]);
    // Its start is the save's, long before: not seen, so its times are at least, and its start's gap isn't one.
    expect(rows[3]?.slice(0, 6)).toEqual([
      "BN1.1 #2",
      `${at(40)} (a save loaded)`,
      "not yet",
      "≥ 10 min so far",
      "≥ 9 min so far",
      "none",
    ]);
    expect(text).toContain("  none yet: no BitNode cleared on their own by two releases");
  });

  test("saves within one BitNode, back to an older one and then to the newer: neither an install", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    installSent(10.3, V100);
    play({ from: 11, to: 20, release: V100, node: -0.5, aug: 10.5, augs: EARLY });
    installSent(20.3, V100);
    play({ from: 21, to: 30, release: V100, node: -0.5, aug: 20.5, augs: LATER });
    // The save from the cycle before loaded, then the newer one again.
    play({ from: 31, to: 35, release: V100, node: -0.5, aug: 10.5, augs: EARLY });
    play({ from: 36, to: 40, release: V100, node: -0.5, aug: 20.5, augs: LATER });
    // A save from a cycle the store never saw, before the last look: a save, not an install.
    play({ from: 41, to: 45, release: V100, node: -0.5, aug: 5.5, augs: EARLY });
    const text = report();
    expect(rowsUnder(text, "BitNodes, one row each")[1]?.slice(6, 8)).toEqual(["3", "2"]);
    expect(rowsUnder(text, "By release")[1]?.slice(3, 5)).toEqual(["3", "2"]);
    expect(text).toContain(`    a save loaded ${at(31)}: `);
    expect(text).toContain(`    a save loaded ${at(36)}: `);
    expect(text).toContain(`    a save loaded ${at(41)}: `);
  });

  test("a save loaded after the PC's clock was set back: a cycle seen already is never an install", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    installSent(10.3, V100);
    play({ from: 11, to: 20, release: V100, node: -0.5, aug: 10.5, augs: EARLY });
    // The clock set back an hour: the game's time now before the first cycle's reset. Then that cycle's save loaded.
    play({ from: 21, to: 25, release: V100, node: -0.5, aug: 10.5, augs: EARLY, gameOffset: -60 });
    play({ from: 26, to: 30, release: V100, node: -0.5, aug: -0.5, gameOffset: -60 });
    const text = report();
    expect(rowsUnder(text, "BitNodes, one row each")[1]?.slice(6, 8)).toEqual(["2", "1"]);
    expect(text).toContain(`    a save loaded ${at(26)}: `);
  });

  test("saves across BitNodes, back to an older one and then to the newer: never a destroy or a clear", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 11, to: 20, release: V100, node: 10.5, aug: 10.5, sf: 1 });
    // BN1.1's save, then BN1.2's again, whose destroy follows.
    play({ from: 21, to: 25, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 26, to: 30, release: V100, node: 10.5, aug: 10.5, sf: 1 });
    event(30.3, V100, "bitNodeDestroySent", {});
    play({ from: 31, to: 35, release: V100, node: 30.5, aug: 30.5, sf: 2 });
    const rows = bitNodeRows();
    expect(rows.slice(1).map((row) => row.slice(0, 3))).toEqual([
      ["BN1.1", at(-0.5), `destroyed ${at(10.5)}`],
      ["BN1.2", at(10.5), `a save loaded ${at(21)}`],
      ["BN1.1 #2", `${at(20)} (a save loaded)`, `a save loaded ${at(26)}`],
      ["BN1.2 #2", `${at(25)} (a save loaded)`, `destroyed ${at(30.5)}`],
      ["BN1.3", at(30.5), "not yet"],
    ]);
    expect(releaseRows().map((row) => row.slice(1).join(" | "))).toEqual([
      "BitNode | online | cycles | installs | destroyed",
      "BN1.1 | 11 min | 1 | 0 | yes, a clear of its own: 11 min online, 11 min by the clock",
      "BN1.2 | 9 min 30 s | 1 | 0 | no",
      "BN1.1 #2 | 4 min | 1 | 0 | no",
      "BN1.2 #2 | 4 min 30 s | 1 | 0 | yes, from a save loaded",
      "BN1.3 | 4 min 30 s | 1 | 0 | no",
    ]);
  });

  test("a release changed mid-cycle, away from an install: the step across it is the new release's", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    event(10.5, V101, "brainStarted", { release: "v1.0.1" });
    play({ from: 11, to: 20, release: V101, node: -0.5, aug: -0.5 });
    installSent(20.3, V101);
    play({ from: 21, to: 30, release: V101, node: -0.5, aug: 20.5, augs: EARLY });
    expect(releaseRows().slice(1)).toEqual([
      ["v1.0.0", "BN1.1", "10 min 30 s", "1", "0", "no"],
      ["v1.0.1", "BN1.1", "20 min", "2", "1", "no"],
    ]);
  });

  test("b1t_flum3, a new game, BitNodes unseen, and a destroy at the cap the brain didn't send: none a destroy", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 11, to: 20, release: V100, node: 10.5, aug: 10.5, sf: 1 });
    play({ from: 21, to: 30, release: V100, node: 20.5, aug: 20.5, sf: 2 });
    // b1t_flum3 into BN2: no Source-File gained, though a destroy was sent after the last look (SF1.2: below the cap).
    event(30.2, V100, "bitNodeDestroySent", {});
    play({ from: 31, to: 40, release: V100, node: 30.5, aug: 30.5, bitNode: 2, sf: 2 });
    // A new game: every Source-File gone.
    play({ from: 41, to: 50, release: V100, node: 40.5, aug: 40.5 });
    // SF1 from none to 3: BN1.1 destroyed, and BN1.2 and BN1.3 played where the store didn't see them.
    play({ from: 51, to: 60, release: V100, node: 50.5, aug: 50.5, sf: 3 });
    // At the cap: a destroy sent early, then more play, then the next BN1.4 with none sent after the last look.
    event(52, V100, "bitNodeDestroySent", {});
    play({ from: 61, to: 65, release: V100, node: 60.5, aug: 60.5, sf: 3 });
    expect(
      bitNodeRows()
        .slice(1)
        .map((row) => row.slice(0, 5)),
    ).toEqual([
      ["BN1.1", at(-0.5), `destroyed ${at(10.5)}`, "11 min", "11 min"],
      ["BN1.2", at(10.5), `destroyed ${at(20.5)}`, "10 min", "10 min"],
      ["BN1.3", at(20.5), `b1t_flum3 ${at(30.5)}`, "10 min so far", "10 min so far"],
      ["BN2.1", at(30.5), `a new game ${at(40.5)}`, "10 min so far", "10 min so far"],
      // To its last look: when it was destroyed, the store didn't see; the step to the next start isn't a gap of it.
      ["BN1.1 #2", at(40.5), `destroyed, BitNodes unseen before ${at(50.5)}`, "9 min 30 s so far", "9 min 30 s so far"],
      [
        "BN1.4",
        at(50.5),
        `b1t_flum3, or a destroy not sent by the brain at the cap, ${at(60.5)}`,
        "10 min so far",
        "10 min so far",
      ],
      ["BN1.4 #2", at(60.5), "not yet", "4 min 30 s so far", "4 min 30 s so far"],
    ]);
    expect(bitNodeRows()[5]?.[5]).toBe("none");
    expect(report()).toContain("  BN2.1: entered with SF1.2\n");
    expect(releaseRows().map((row) => row[5])).toEqual([
      "destroyed",
      "yes, a clear of its own: 11 min online, 11 min by the clock",
      "yes, a clear of its own: 10 min online, 10 min by the clock",
      "no",
      "no",
      "yes, BitNodes unseen after it",
      "no",
      "no",
    ]);
  });

  test("with no Source-File before it, another BitNode is a new game: b1t_flum3 needs one", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 11, to: 15, release: V100, node: 10.5, aug: 10.5 });
    expect(bitNodeRows()[1]?.[2]).toBe(`a new game ${at(10.5)}`);
  });

  test("BN12's Source-File has no cap: at level 3 with none gained and no destroy, b1t_flum3 alone", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 5, release: V100, node: -0.5, aug: -0.5, bitNode: 12, sf: { 12: 3 } });
    play({ from: 6, to: 8, release: V100, node: 5.5, aug: 5.5, bitNode: 12, sf: { 12: 3 } });
    expect(bitNodeRows()[1]?.slice(0, 3)).toEqual(["BN12.4", at(-0.5), `b1t_flum3 ${at(5.5)}`]);
  });

  test("another Source-File rising with the BitNode's own: destroyed, with BitNodes unseen between", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5, sf: 1 });
    play({ from: 11, to: 15, release: V100, node: 10.5, aug: 10.5, sf: { 1: 2, 2: 1 } });
    expect(bitNodeRows()[1]?.[2]).toBe(`destroyed, BitNodes unseen before ${at(10.5)}`);
    // Another rising alone: not this one's destroy.
    play({ from: 16, to: 20, release: V100, node: 15.5, aug: 15.5, sf: { 1: 2, 2: 2 } });
    expect(bitNodeRows()[2]?.[2]).toBe(`BitNodes unseen before ${at(15.5)}`);
  });

  test("at the cap (#311 review): a replay sent 45 s before the last look counts; one sent before the last install doesn't", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5, sf: 3 });
    // Live, the slow snapshots go on while the backdoor is typed: the send 45 s before the BitNode's last look.
    event(9.25, V100, "bitNodeDestroySent", {});
    play({ from: 11, to: 12, release: V100, node: 10.5, aug: 10.5, sf: 3 });
    // A destroy sent, then an install after it: the cycle it was sent in is over, so it's not the BitNode's end.
    event(12.2, V100, "bitNodeDestroySent", {});
    installSent(12.5, V100);
    play({ from: 13, to: 15, release: V100, node: 10.5, aug: 12.7, sf: 3, augs: EARLY });
    play({ from: 16, to: 17, release: V100, node: 15.5, aug: 15.5, sf: 3 });
    expect(
      bitNodeRows()
        .slice(1)
        .map((row) => row.slice(0, 3)),
    ).toEqual([
      ["BN1.4", at(-0.5), `destroyed ${at(10.5)} (at the cap)`],
      ["BN1.4 #2", at(10.5), `b1t_flum3, or a destroy not sent by the brain at the cap, ${at(15.5)}`],
      ["BN1.4 #3", at(15.5), "not yet"],
    ]);
  });

  test("at the cap, the 5-minute bound (#311 review): sent 4 min 59 s before the last look counts, 5 min 1 s doesn't", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5, sf: 3 });
    event(10 - 299 / 60, V100, "bitNodeDestroySent", {});
    play({ from: 11, to: 20, release: V100, node: 10.5, aug: 10.5, sf: 3 });
    event(20 - 301 / 60, V100, "bitNodeDestroySent", {});
    play({ from: 21, to: 22, release: V100, node: 20.5, aug: 20.5, sf: 3 });
    expect(
      bitNodeRows()
        .slice(1)
        .map((row) => row[2]),
    ).toEqual([
      `destroyed ${at(10.5)} (at the cap)`,
      `b1t_flum3, or a destroy not sent by the brain at the cap, ${at(20.5)}`,
      "not yet",
    ]);
  });

  test("Source-File overrides: one overridden on either side isn't compared; the BitNode's own falls back on the destroy sent", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    // SF4 overridden to 0 in BN1.2 (ownedSF hides it), shown at its level in BN1.3: not another Source-File rising.
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5, sf: 1, overrides: { 4: 0 } });
    play({ from: 11, to: 20, release: V100, node: 10.5, aug: 10.5, sf: { 1: 2, 4: 1 } });
    // SF1 overridden to 0 in the next two (ownedSF hides it): its level doesn't say; the brain's destroy sent does.
    event(20.2, V100, "bitNodeDestroySent", {});
    play({ from: 21, to: 30, release: V100, node: 20.5, aug: 20.5, sf: { 4: 1 }, overrides: { 1: 0 } });
    event(30.2, V100, "bitNodeDestroySent", {});
    play({ from: 31, to: 40, release: V100, node: 30.5, aug: 30.5, sf: { 4: 1 }, overrides: { 1: 0 } });
    // No destroy sent: unknown.
    play({ from: 41, to: 45, release: V100, node: 40.5, aug: 40.5, sf: { 1: 3, 4: 1 } });
    const rows = bitNodeRows();
    expect(rows.slice(1).map((row) => row[2])).toEqual([
      `destroyed ${at(10.5)}`,
      `destroyed ${at(20.5)} (its Source-File overridden; the destroy sent)`,
      `destroyed ${at(30.5)} (its Source-File overridden; the destroy sent)`,
      `unknown ${at(40.5)} (its Source-File overridden, no destroy sent)`,
      "not yet",
    ]);
    expect(report()).toContain("  BN1.2: entered with SF1.1 (overridden: SF4 at 0)\n");
  });

  test("a save loaded in a BitNode stops a clear of its own", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    installSent(10.3, V100);
    play({ from: 11, to: 20, release: V100, node: -0.5, aug: 10.5, augs: EARLY });
    play({ from: 21, to: 25, release: V100, node: -0.5, aug: -0.5 });
    play({ from: 26, to: 27, release: V100, node: 25.5, aug: 25.5, sf: 1 });
    expect(releaseRows()[1]?.[5]).toBe("yes, with a save loaded in it");
  });

  test("another release only at a BitNode's start, up to 5 min with no install, leaves the next a clear of its own", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 2, release: V100, node: -0.5, aug: -0.5 });
    event(2.5, V101, "brainStarted", { release: "v1.0.1" });
    play({ from: 3, to: 10, release: V101, node: -0.5, aug: -0.5 });
    installSent(10.3, V101);
    play({ from: 11, to: 20, release: V101, node: -0.5, aug: 10.5, augs: EARLY });
    // BN1.2 the same, but its first release played 5 min 30 s: more than the allowance.
    play({ from: 21, to: 26, release: V100, node: 20.5, aug: 20.5, sf: 1 });
    play({ from: 27, to: 40, release: V101, node: 20.5, aug: 20.5, sf: 1 });
    // BN1.3: its first release installed at the start.
    play({ from: 41, to: 42, release: V100, node: 40.5, aug: 40.5, sf: 2 });
    installSent(42.3, V100);
    play({ from: 43, to: 50, release: V101, node: 40.5, aug: 42.5, sf: 2, augs: EARLY });
    // BN1.4: the first release came back after the other's first look.
    play({ from: 51, to: 51, release: V100, node: 50.5, aug: 50.5, sf: 3 });
    play({ from: 52, to: 55, release: V101, node: 50.5, aug: 50.5, sf: 3 });
    play({ from: 56, to: 56, release: V100, node: 50.5, aug: 50.5, sf: 3 });
    play({ from: 57, to: 60, release: V101, node: 50.5, aug: 50.5, sf: 3 });
    event(60.2, V101, "bitNodeDestroySent", {});
    play({ from: 61, to: 62, release: V101, node: 60.5, aug: 60.5, sf: 3 });
    // A new game, whose BN1.1 v1.0.0 clears alone: compared with v1.0.1's, its starter's share shown.
    play({ from: 63, to: 70, release: V100, node: 62.5, aug: 62.5 });
    play({ from: 71, to: 72, release: V100, node: 70.5, aug: 70.5, sf: 1 });
    expect(report()).toContain(
      "  BN1.1: v1.0.0 8 min online (8 min by the clock, 1 cycle, left out: none; no Source-File); v1.0.1 21 min online " +
        "(21 min by the clock, 2 cycles, left out: none; no Source-File) (v1.0.0's first 2 min 30 s)",
    );
    expect(releaseRows().slice(1)).toEqual([
      ["v1.0.0", "BN1.1", "2 min 30 s", "1", "0", "no"],
      ["v1.0.0", "BN1.2", "5 min 30 s", "1", "0", "no"],
      ["v1.0.0", "BN1.3", "1 min 30 s", "1", "1", "no"],
      ["v1.0.0", "BN1.4", "1 min 30 s", "1", "0", "no"],
      ["v1.0.0", "BN1.1 #2", "8 min", "1", "0", "yes, a clear of its own: 8 min online, 8 min by the clock"],
      ["v1.0.0", "BN1.2 #2", "1 min 30 s", "1", "0", "no"],
      [
        "v1.0.1",
        "BN1.1",
        "18 min 30 s",
        "2",
        "1",
        "yes, a clear of its own (v1.0.0's first 2 min 30 s): 21 min online, 21 min by the clock",
      ],
      ["v1.0.1", "BN1.2", "14 min 30 s", "1", "0", "yes, played with v1.0.0 too"],
      ["v1.0.1", "BN1.3", "8 min 30 s", "1", "0", "yes, played with v1.0.0 too"],
      ["v1.0.1", "BN1.4", "8 min 30 s", "1", "0", "yes, played with v1.0.0 too"],
      ["v1.0.1", "BN1.4 #2", "2 min", "1", "0", "no"],
    ]);
  });

  test("the brain away across a destroy: the time from the next BitNode's start to its first look is left out", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    event(10.3, V100, "bitNodeDestroySent", {});
    event(19.5, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 20, to: 30, release: V100, node: 10.5, aug: 10.5, sf: 1 });
    expect(bitNodeRows()[2]?.slice(0, 6)).toEqual([
      "BN1.2",
      at(10.5),
      "not yet",
      "19 min 30 s so far",
      "10 min so far",
      "9 min 30 s in 1 gap",
    ]);
  });

  test("installs by hand (the game's button, your queue) are marked, and a clear with one isn't of its own", () => {
    event(-1, V100, "brainStarted", { release: "v1.0.0" });
    play({ from: 0, to: 10, release: V100, node: -0.5, aug: -0.5 });
    // The game's Install button, or a Soft Reset: no augmentationInstallSent.
    play({ from: 11, to: 20, release: V100, node: -0.5, aug: 10.5, augs: EARLY });
    installSent(20.3, V100, "manual");
    play({ from: 21, to: 30, release: V100, node: -0.5, aug: 20.5, augs: EARLY });
    installSent(30.3, V100);
    play({ from: 31, to: 40, release: V100, node: -0.5, aug: 30.5, augs: LATER });
    play({ from: 41, to: 42, release: V100, node: 40.5, aug: 40.5, sf: 1 });
    expect(bitNodeRows()[1]?.slice(6, 8)).toEqual(["4", "3 (2 by hand)"]);
    expect(releaseRows()[1]?.slice(4)).toEqual(["3 (2 by hand)", "yes, with 2 installs by hand"]);
  });

  test("throws with no slow snapshot showing a BitNode", () => {
    expect(() => report()).toThrow("no BitNode in the store (E0): 0 slow snapshots, none with a resetInfo to read");
    snapshot(full, V100, "slow", m(0), { purchasedServers: [] });
    expect(() => report()).toThrow("1 slow snapshot, none with a resetInfo");
  });

  test("a BitNode begun before the store's first record, with no install before: its time online at least", () => {
    play({ from: 0, to: 20, release: V100, node: -30, aug: -30 });
    play({ from: 21, to: 25, release: V100, node: 20.5, aug: 20.5, sf: 1 });
    // Its cycles and installs are all seen: its first look's cycle is its first. Its start's 30 min aren't a gap.
    expect(bitNodeRows()[1]?.slice(0, 8)).toEqual([
      "BN1.1",
      `${at(-30)} (before the store)`,
      `destroyed ${at(20.5)}`,
      "50 min 30 s",
      "≥ 20 min 30 s",
      "none",
      "1",
      "0",
    ]);
    // Not a clear of its own: the store didn't see its start.
    expect(releaseRows()[1]).toEqual([
      "v1.0.0",
      "BN1.1",
      "20 min 30 s",
      "1",
      "0",
      "yes, the BitNode's start not seen in the store",
    ]);
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

  test("it opens the store read-only and never writes it: the same bytes after, and a read-only file is enough", () => {
    campaign();
    full.close();
    const storePath = path.join(directory, STORE_FILE_NAME);
    const before = { bytes: readFileSync(storePath), modifiedMs: statSync(storePath).mtimeMs };
    chmodSync(storePath, 0o444);
    try {
      const result = runCli(directory);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Compared: ");
      expect(readFileSync(storePath).equals(before.bytes)).toBe(true);
      expect(statSync(storePath).mtimeMs).toBe(before.modifiedMs);
      // A read-only connection may open the write-ahead log beside it, but writes nothing to it.
      const logs = readdirSync(directory).filter((name) => name.endsWith("-wal"));
      expect(logs.map((name) => statSync(path.join(directory, name)).size)).toEqual(logs.map(() => 0));
    } finally {
      chmodSync(storePath, 0o644);
      full = TelemetryStore.open(storePath);
    }
  });

  test("an empty store file stays empty: it's read, never given a schema", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "campaign-report-empty-file-"));
    try {
      const storePath = path.join(empty, STORE_FILE_NAME);
      writeFileSync(storePath, "");
      expect(runCli(empty)).toMatchObject({ exitCode: 2, output: expect.stringContaining("campaign: ") });
      expect(statSync(storePath).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
