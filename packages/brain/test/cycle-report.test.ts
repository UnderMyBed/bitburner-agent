// The run report's BitNodes, milestones and augmentation cycles (#244): section 2 split at each destroy, each
// BitNode's milestones, and section 2b's row per cycle with what held it back. Over a synthetic store built here, never
// the owner's .data/: BN1.1's three cycles (reputation, money, then the bar), a destroy, and BN1.2's first.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUGMENTATION_NAMES,
  augmentationsSoldBy,
  type FactionStateReading,
  type JoinedFaction,
  type MediumSnapshotData,
  NEUROFLUX_GOVERNOR,
  newBatcherHealth,
  type SlowSnapshotData,
  THE_RED_PILL,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { STORE_FILE_NAME } from "../src/config.ts";
import { heldBackOf } from "../src/cycle-report.ts";
import { runReport } from "../src/run-report.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";

const T0 = Date.parse("2026-11-05T00:00:00Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const context = { environment: "E0", release: "r" } as const;

let directory: string;
let store: TelemetryStore;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "cycle-report-"));
  store = TelemetryStore.open(path.join(directory, STORE_FILE_NAME));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

let sequenceNumber = 0;
/** A snapshot received at `offsetMs`, the game's clock the same as the brain's (one machine), unless `gameTimeMs`. */
function snapshot(tier: string, offsetMs: number, data: unknown, gameTimeMs = T0 + offsetMs) {
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

const CYBERSEC = [
  "Neurotrainer I",
  "Synaptic Enhancement Implant",
  "BitWire",
  "Cranial Signal Processors - Gen I",
  "Cranial Signal Processors - Gen II",
];
/** 30 installed (Daedalus's count in BN1): CyberSec's first four (not Gen II) and 26 more. */
const THIRTY = [
  ...CYBERSEC.slice(0, 4),
  ...AUGMENTATION_NAMES.filter(
    (name) => !CYBERSEC.includes(name) && name !== NEUROFLUX_GOVERNOR && name !== THE_RED_PILL,
  ),
].slice(0, 30);
const owned = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 1]));

const reading = (joined: JoinedFaction[], queued: string[] = []): FactionStateReading => ({
  backend: "ui",
  state: { joined, invitations: [], queuedAugmentations: queued },
  problem: null,
});
function slowData({
  lastAugReset,
  lastNodeReset,
  ownedAugs = {},
  ownedSF = {},
  factions,
}: {
  lastAugReset: number;
  lastNodeReset: number;
  ownedAugs?: Record<string, number>;
  ownedSF?: Record<string, number>;
  factions?: FactionStateReading;
}): SlowSnapshotData {
  return {
    resetInfo: { lastAugReset, lastNodeReset, currentNode: 1, ownedAugs, ownedSF, bitNodeOptions: {} },
    purchasedServers: [],
    ...(factions === undefined ? {} : { factions }),
  };
}
function mediumData(money: number, hacking: number, factions: string[], mults = true): MediumSnapshotData {
  return {
    player: {
      money,
      skills: { hacking },
      factions,
      city: "Sector-12",
      jobs: {},
      ...(mults ? { mults: { faction_rep: 1 } } : {}),
    },
    hasTorRouter: false,
    programs: [],
    servers: [{ hostname: "home", maxRam: 8, cpuCores: 1, hasAdminRights: true }],
  };
}
/** A fast snapshot: the batcher's health on `target`, sharing at `bonus` (none at 1), or `batcher` as given. */
function fastData(batcher: unknown) {
  return {
    degradedTiers: [],
    pageHeapUsedBytes: null,
    game: { money: 0, homeRamUsed: 4, homeMaxRam: 8, homeProcesses: [] },
    intents: [],
    dialogs: { handled: [], blocking: null },
    ...(batcher === undefined ? {} : { batcher }),
  };
}
function health(target: string, offsetMs: number, bonus: number) {
  return {
    ...newBatcherHealth(target, "run-1", T0 + offsetMs),
    sharing: { wanted: true, threads: bonus > 1 ? 10 : 0, ramGb: 40, hostsRamGb: 40, bonus, roomGb: 0 },
  };
}

// The run: BN1.1 started an hour before the window; its first cycle half an hour before.
const BN11 = T0 - 60 * MINUTE;
const A = T0 - 30 * MINUTE;
const B = T0 + 59 * MINUTE + 50 * SECOND;
const C = T0 + 119 * MINUTE + 50 * SECOND;
const BN12 = T0 + 169 * MINUTE + 55 * SECOND;
const END = 200 * MINUTE;

/**
 * BN1.1's three cycles and BN1.2's first, a slow snapshot a minute, a medium one a minute (at :30), a fast one every
 * 30 s (at :15 and :45). `old` leaves out what an older Agent and brain didn't record: the faction state, the batcher's
 * health, `faction_rep`, and the brain's events.
 * - A (to +59:50): CyberSec at 1,500 reputation and rising 0.5/s, $1t: reputation held it; its install chosen at +50,
 *   judged until then; installed 2.
 * - B (to +119:50): 20,000 reputation rising 2/s, a 5,000 donation at +89:30, $1m: money; NiteSec
 *   joined too (the medium snapshots); installed by you.
 * - C (to the destroy): 30 installed, CyberSec at 30,000 reputation and 150 favour, Gen II reached and covered: the
 *   bar; Daedalus joined at +130:30, The Red Pill queued from +150; the destroy sent at +169:50.
 * - BN1.2 (from +169:55): nothing joined: only another faction would count more.
 */
function run({ old = false }: { old?: boolean } = {}) {
  if (!old) {
    event(MINUTE, "factionWorkChosen", {
      faction: "CyberSec",
      workType: "hacking",
      augmentation: "BitWire",
      reputation: 1500,
      reputationNeeded: 3750,
      reputationPerSecond: 0.5,
      etaSeconds: 4500,
    });
    event(58 * MINUTE, "augmentationProgress", {
      lastAugReset: A,
      affordable: 2,
      affordableWithNeuroFlux: 2,
      bar: 8,
      barWithNeuroFlux: 12,
      onlineMs: 88 * MINUTE,
      barFallsInMs: 32 * MINUTE,
      barWithNeuroFluxFallsInMs: 32 * MINUTE,
      reason: null,
      countdown: null,
      held: null,
      byDonation: 0,
      setCost: 0,
    });
    event(50 * MINUTE, "augmentationInstallChosen", {
      set: [],
      cost: 0,
      queued: [],
      onlineMs: 88 * MINUTE,
      affordable: 2,
      affordableWithNeuroFlux: 2,
      bar: 2,
      barWithNeuroFlux: 12,
      reason: "count reached",
      donations: [],
    });
    event(59 * MINUTE + 45 * SECOND, "augmentationInstallSent", { source: "brain", queued: CYBERSEC.slice(0, 2) });
    event(89 * MINUTE + 30 * SECOND, "augmentationDonated", {
      faction: "CyberSec",
      amount: 1e9,
      reputation: 0,
      before: 0,
      after: 5000,
    });
    event(119 * MINUTE + 45 * SECOND, "augmentationInstallSent", { source: "manual", queued: [] });
    event(120 * MINUTE, "factionWorkStopped", { reason: "nothing to work for" });
    event(169 * MINUTE + 50 * SECOND, "bitNodeDestroySent", { source: "brain", nextBitNode: 1 });
  }
  for (let minute = 1; minute < 200; minute++) {
    const offsetMs = minute * MINUTE;
    const seconds = (from: number) => (offsetMs - from * MINUTE) / 1000;
    let data: SlowSnapshotData;
    if (minute < 60) {
      data = slowData({
        lastAugReset: A,
        lastNodeReset: BN11,
        factions: reading([{ name: "CyberSec", reputation: 1500 + 0.5 * seconds(1), favor: 0 }]),
      });
    } else if (minute < 120) {
      const donated = offsetMs > 89 * MINUTE + 30 * SECOND ? 5000 : 0;
      data = slowData({
        lastAugReset: B,
        lastNodeReset: BN11,
        ownedAugs: owned(CYBERSEC.slice(0, 2)),
        factions: reading([{ name: "CyberSec", reputation: 20_000 + 2 * seconds(60) + donated, favor: 1.5 }]),
      });
    } else if (minute < 170) {
      data = slowData({
        lastAugReset: C,
        lastNodeReset: BN11,
        ownedAugs: owned(THIRTY),
        factions: reading([{ name: "CyberSec", reputation: 30_000, favor: 150 }], minute >= 150 ? [THE_RED_PILL] : []),
      });
    } else {
      data = slowData({ lastAugReset: BN12, lastNodeReset: BN12, ownedSF: { 1: 1 }, factions: reading([]) });
    }
    if (old) delete data.factions;
    snapshot("slow", offsetMs, data);
  }
  for (let minute = 0; minute < 200; minute++) {
    const offsetMs = minute * MINUTE + 30 * SECOND;
    const medium =
      minute < 60
        ? mediumData(1e12, 100 + minute, ["CyberSec"], !old)
        : minute < 120
          ? mediumData(1e6, 1 + (minute - 60) * 2, ["CyberSec", "NiteSec"], !old)
          : minute < 170
            ? mediumData(1e12, 500, minute >= 130 ? ["CyberSec", "Daedalus"] : ["CyberSec"], !old)
            : mediumData(1_000 + minute, 1 + minute - 170, [], !old);
    snapshot("medium", offsetMs, medium);
    for (const second of [15, 45]) {
      const fastMs = minute * MINUTE + second * SECOND;
      const batcher = old
        ? undefined
        : minute < 60
          ? health("n00dles", fastMs, minute < 30 ? 1.2 : 1)
          : minute < 120
            ? health(minute < 90 ? "joesguns" : "phantasy", fastMs, 1)
            : null;
      snapshot("fast", fastMs, fastData(batcher));
    }
  }
}

const report = (sinceMs = T0, untilMs = T0 + END) => runReport(store, { environment: "E0", sinceMs, untilMs }).text;
/** The lines from the one starting with `start` to the next line indented no more than it. */
function block(text: string, start: string): string {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.trimStart().startsWith(start));
  if (from === -1) throw new Error(`no line starting ${JSON.stringify(start)}`);
  const indent = (line: string) => line.length - line.trimStart().length;
  const until = lines.findIndex((line, index) => index > from && indent(line) <= indent(lines[from] as string));
  return lines.slice(from, until === -1 ? undefined : until).join("\n");
}

describe("section 2 split at each destroy (#244)", () => {
  test("the BitNodes line: each one entered, destroyed or not, with how long", () => {
    run();
    expect(report()).toContain(
      `\n  BitNodes: BN1.1 from ${at(-60 * MINUTE)} (before the window), destroyed after 3 h 49 min; ` +
        `BN1.2 from ${at(169 * MINUTE + 55 * SECOND)}, not destroyed, 29 min 50 s by the window's last record\n`,
    );
  });

  test("progress is first → last within each BitNode, never across the destroy", () => {
    run();
    const text = report();
    const first = block(text, "BN1.1, first snapshot → last:");
    const second = block(text, "BN1.2, first snapshot → last:");
    expect(first).toContain("    money: $1,000,000,000,000 (unchanged)");
    expect(first).toContain("    hacking: 100 → 500");
    expect(first).toContain("    Source-Files: none (unchanged)");
    expect(first).toContain("    factions: CyberSec → CyberSec, Daedalus");
    expect(second).toContain("    money: $1,170 → $1,199");
    expect(second).toContain("    hacking: 1 → 30");
    expect(second).toContain("    Source-Files: SF1.1 (unchanged)");
    expect(second).toContain("    BitNode: 1 (unchanged)");
    expect(text).not.toContain("Source-Files: none → SF1.1");
    expect(text).not.toMatch(/hacking: 100 → 30\b/);
  });

  test("each BitNode's milestones, with the time since its start; one before the window says so", () => {
    run();
    const text = report();
    expect(block(text, "BN1.1, first snapshot → last:")).toContain(
      [
        "    milestones (the time since the BitNode's start):",
        "      first faction joined: CyberSec, before the window",
        `      donations unlocked: CyberSec +3 h 0 min (${at(120 * MINUTE)})`,
        `      Daedalus's count reached (30 installed): +3 h 0 min (${at(120 * MINUTE)})`,
        `      Daedalus joined: +3 h 10 min (${at(130 * MINUTE + 30 * SECOND)})`,
        `      The Red Pill bought: +3 h 30 min (${at(150 * MINUTE)})`,
        `      destroyed: +3 h 49 min (${at(169 * MINUTE + 55 * SECOND)}, the next BitNode's start; sent at ` +
          `${at(169 * MINUTE + 50 * SECOND)})`,
      ].join("\n"),
    );
    expect(block(text, "BN1.2, first snapshot → last:")).toContain(
      [
        "    milestones (the time since the BitNode's start):",
        "      first faction joined: not in the window",
        "      donations unlocked: none in the window",
        "      Daedalus's count reached (30 installed): not in the window",
        "      Daedalus joined: not in the window",
        "      The Red Pill bought: not in the window",
        "      destroyed: not in the window",
      ].join("\n"),
    );
  });

  test("The Red Pill's purchase event, earlier than a snapshot shows it queued, is its time", () => {
    event(140 * MINUTE, "augmentationBought", {
      augmentation: THE_RED_PILL,
      faction: "Daedalus",
      level: 1,
      price: 0,
      queueLength: 1,
    });
    run();
    expect(report()).toContain(`      The Red Pill bought: +3 h 20 min (${at(140 * MINUTE)})`);
  });

  test("a milestone at a BitNode's first look, the BitNode started in the window, has its time, not 'before'", () => {
    run();
    // BN1.1 started 60 minutes before T0: in a window from 61 minutes before, CyberSec at its first look is a join.
    const text = report(T0 - 61 * MINUTE);
    expect(text).toContain(`  BitNodes: BN1.1 from ${at(-60 * MINUTE)}, destroyed after 3 h 49 min; `);
    expect(text).toContain(`      first faction joined: CyberSec, +1 h 0 min (${at(30 * SECOND)})`);
  });

  test("a BitNode started before the window, the window from within it", () => {
    run();
    expect(report(T0 + 175 * MINUTE)).toContain(
      `  BitNodes: BN1.2 from ${at(169 * MINUTE + 55 * SECOND)} (before the window), not destroyed`,
    );
  });
});

describe("section 2b: the augmentation cycles (#244)", () => {
  test("a row per cycle, a BitNode at a time: when, how long, how it ended, what it installed and what held it back", () => {
    run();
    const text = report();
    expect(text).toMatch(/\n2b\. Augmentation cycles .*\n {2}held back by: /);
    expect(text.indexOf("2b. Augmentation cycles")).toBeLessThan(text.indexOf("3. Actions"));
    expect(text.indexOf("2. Progress")).toBeLessThan(text.indexOf("2b. Augmentation cycles"));
    const cycles = text.slice(text.indexOf("2b. Augmentation cycles"), text.indexOf("3. Actions"));
    expect(cycles).toContain(
      [
        "  BN1.1:",
        `    cycle 1 from ${at(-30 * MINUTE)} (before the window), 1 h 29 min (1 h 28 min online), ended by an ` +
          "install (count reached)",
        "      installed: 2 (Neurotrainer I, Synaptic Enhancement Implant); Daedalus's count 0 → 2 of 30",
        "      held back by: reputation (100% of 49 min online judged)",
        "      faction work: CyberSec +1,740 reputation at 0.50/s",
        "      favour: CyberSec 0 → 1.5; donations at 150",
        "      share bonus: ×1.10 on average; most money unspent: $1,000,000,000,000",
        "      hacking: 100 → 159, most 159",
        "      the batcher's targets: n00dles",
        `    cycle 2 from ${at(59 * MINUTE + 50 * SECOND)}, 1 h 0 min (59 min online), ended by an install (yours)`,
      ].join("\n"),
    );
    expect(cycles).toContain(
      [
        "      held back by: money (100% of 59 min online judged)",
        // The 5,000 donated left out of what the work earned.
        "      faction work: CyberSec +7,080 reputation at 2.00/s",
        "      favour: CyberSec 1.5 → 150, donations unlocked",
        "      share bonus: ×1.00 on average; most money unspent: $1,000,000",
        "      hacking: 1 → 119, most 119",
        "      the batcher's targets: joesguns, phantasy",
        `    cycle 3 from ${at(119 * MINUTE + 50 * SECOND)}, 50 min 5 s (49 min online), ended by a destroy`,
        "      installed: none, the BitNode destroyed; Daedalus's count 30 of 30",
        "      held back by: count (100% of 49 min online judged)",
        "      faction work: none recorded",
        "      favour: CyberSec 150, donations unlocked",
        "      share bonus: ×1.00 on average; most money unspent: $1,000,000,000,000",
        "      hacking: 500 → 500, most 500",
        "      the batcher's targets: none",
        "  BN1.2:",
        `    cycle 1 from ${at(169 * MINUTE + 55 * SECOND)}, 29 min 35 s so far (29 min online), not ended in the ` +
          "window",
        "      installed: not yet; Daedalus's count 0 of 30",
        "      held back by: factions (100% of 29 min online judged)",
        "      faction work: none recorded",
        "      favour: no joined faction taking donations",
      ].join("\n"),
    );
    expect(cycles).toMatch(
      /\n {6}installed: 28 \(BitWire, Cranial Signal Processors - Gen I, .*\); Daedalus's count 2 → 30 of 30\n/,
    );
    expect(text).not.toMatch(/undefined|NaN/);
  });

  test("the last cycle's favour is the next install's, predicted", () => {
    run();
    const text = report(T0, T0 + 30 * MINUTE);
    expect(text).toMatch(/\n {6}favour: CyberSec 0 → 4\.57 at the next install \(predicted\); donations at 150\n/);
  });

  test("a window from mid-run: the cycles in it, the first started before it, and numbered from it", () => {
    run();
    const text = report(T0 + 100 * MINUTE);
    const cycles = text.slice(text.indexOf("2b. Augmentation cycles"), text.indexOf("3. Actions"));
    expect(cycles).toContain(
      `    cycle 1 from ${at(59 * MINUTE + 50 * SECOND)} (before the window), 1 h 0 min (19 min online), ended by an ` +
        "install (yours)",
    );
    expect(cycles).toContain(`    cycle 2 from ${at(119 * MINUTE + 50 * SECOND)}, 50 min 5 s`);
    expect(cycles).toContain("  BN1.2:\n    cycle 1 from");
  });

  test("a window that ends before the destroy: one BitNode, not destroyed, its last cycle not ended", () => {
    run();
    const text = report(T0, T0 + 150 * MINUTE);
    expect(text).toContain(`  BitNodes: BN1.1 from ${at(-60 * MINUTE)} (before the window), not destroyed, `);
    expect(text).toContain("ended by an install (yours)\n");
    expect(text).toMatch(/cycle 3 from .*, not ended in the window\n {6}installed: not yet; Daedalus's count 30 of 30/);
    expect(text).toContain("      destroyed: not in the window");
  });

  test("a window that ends between the destroy sent and the next BitNode: sent, the next BitNode not seen", () => {
    run();
    const text = report(T0, T0 + 169 * MINUTE + 52 * SECOND);
    expect(text).toContain(
      `  BitNodes: BN1.1 from ${at(-60 * MINUTE)} (before the window), destroy sent at ` +
        `${at(169 * MINUTE + 50 * SECOND)}, the next BitNode not seen, 3 h 49 min by the window's last record\n`,
    );
    expect(text).toContain(
      `      destroyed: sent +3 h 49 min (${at(169 * MINUTE + 50 * SECOND)}), the next BitNode not seen\n`,
    );
  });

  test("an older store (no faction state, batcher health, faction_rep or brain events): not recorded, never a crash", () => {
    run({ old: true });
    const text = report();
    const cycles = text.slice(text.indexOf("2b. Augmentation cycles"), text.indexOf("3. Actions"));
    expect(cycles).toContain("    cycle 1 from");
    expect(cycles).toContain("ended by an install (none chosen in the window)");
    expect(cycles).toContain(
      "      held back by: not judged: no faction state or money recorded with its slow snapshots",
    );
    expect(cycles).toContain("      faction work: none recorded");
    expect(cycles).toContain("      favour: not recorded (no faction state)");
    expect(cycles).toContain("      share bonus: not recorded; most money unspent: $1,000,000,000,000");
    expect(cycles).toContain("      the batcher's targets: not recorded");
    expect(text).toContain("      donations unlocked: none in the window");
    expect(text).toContain("      destroyed: +3 h 49 min");
    expect(text).toContain("the next BitNode's start; no destroy sent seen)");
    expect(text).not.toMatch(/undefined|NaN/);
  });

  test("no slow snapshot: the BitNodes and cycles not recorded", () => {
    snapshot("medium", 30 * SECOND, mediumData(1, 1, []));
    snapshot("fast", 15 * SECOND, fastData(null));
    const text = report(T0, T0 + MINUTE);
    expect(text).toContain("  BitNodes: not recorded (no slow snapshot in the window)");
    expect(text).toContain("  BitNode not recorded, first snapshot → last:\n    money: $1 (unchanged)");
    expect(text).toContain("2b. Augmentation cycles (each from an install's lastAugReset to the next reset; #244)");
    expect(text).toContain("  not recorded (no slow snapshot in the window)");
  });

  test("a cycle whose install was chosen before its first slow snapshot isn't judged", () => {
    const factions = reading([{ name: "CyberSec", reputation: 1500, favor: 0 }]);
    for (let minute = 1; minute < 4; minute++) {
      snapshot("slow", minute * MINUTE, slowData({ lastAugReset: T0, lastNodeReset: T0, factions }));
      snapshot("medium", minute * MINUTE + 30 * SECOND, mediumData(1e12, 1, ["CyberSec"]));
    }
    event(30 * SECOND, "augmentationInstallChosen", { reason: "quick install" });
    expect(report(T0, T0 + 5 * MINUTE)).toContain(
      "      held back by: not judged: its install was chosen before its first slow snapshot\n",
    );
  });

  test("a reset the game's clock puts after its first slow snapshot (a clock step between) starts at that snapshot", () => {
    for (let minute = 1; minute < 10; minute++) {
      const lastAugReset = minute < 5 ? T0 : T0 + 6 * MINUTE;
      snapshot("slow", minute * MINUTE, slowData({ lastAugReset, lastNodeReset: T0 }));
      snapshot("medium", minute * MINUTE + 30 * SECOND, mediumData(1, minute, []));
    }
    const text = report(T0, T0 + 10 * MINUTE);
    expect(text).toContain(`    cycle 2 from ${at(5 * MINUTE)}, 4 min 30 s so far`);
    expect(text).toContain("      hacking: 5 → 9, most 9\n");
  });

  test("a game clock far from the brain's (or none): the resets are taken as the brain's, within the snapshots", () => {
    // The game's time 0 in every snapshot (an older Agent's fixtures): a reset can't start after its first snapshot.
    for (let minute = 1; minute < 10; minute++) {
      snapshot(
        "slow",
        minute * MINUTE,
        slowData({
          lastAugReset: T0 + (minute < 5 ? -MINUTE : 4 * MINUTE + 30 * SECOND),
          lastNodeReset: T0 - MINUTE,
        }),
        0,
      );
      snapshot("medium", minute * MINUTE + 30 * SECOND, mediumData(1, minute, []), 0);
    }
    const text = report(T0, T0 + 10 * MINUTE);
    expect(text).toContain(`    cycle 1 from ${at(-MINUTE)} (before the window), 5 min 30 s`);
    expect(text).toContain(`    cycle 2 from ${at(4 * MINUTE + 30 * SECOND)}, 5 min so far`);
    // The medium snapshot at 4:30 is the second cycle's, from its reset on.
    expect(text).toContain("      hacking: 1 → 3, most 3\n");
    expect(text).toContain("      hacking: 4 → 9, most 9\n");
  });
});

describe("heldBackOf: what more of would have raised the count (#244)", () => {
  const slow = (joined: JoinedFaction[], ownedAugs: Record<string, number> = {}, queued: string[] = []) =>
    slowData({ lastAugReset: 0, lastNodeReset: 0, ownedAugs, factions: reading(joined, queued) });

  test("reputation: more reputation at CyberSec, the money covering it, would count more", () => {
    expect(heldBackOf(slow([{ name: "CyberSec", reputation: 1500, favor: 0 }]), { money: 1e12, factionRep: 1 })).toBe(
      "reputation",
    );
  });

  test("money: everything reached, and the money short", () => {
    expect(heldBackOf(slow([{ name: "CyberSec", reputation: 20_000, favor: 0 }]), { money: 1e6, factionRep: 1 })).toBe(
      "money",
    );
  });

  test("reputation and money: Sector-12's Wired Reflexes unreached, and CyberSec's reached two not both affordable", () => {
    const joined = [
      { name: "CyberSec", reputation: 2_500, favor: 0 },
      { name: "Sector-12", reputation: 0, favor: 0 },
    ];
    // $9m buys Neurotrainer I alone of the reached ($4m, then Synaptic's $7.5m and its ×1.9 is $15.1m), or Wired
    // Reflexes ($2.5m) and Neurotrainer I ($8.75m in buy order).
    expect(heldBackOf(slow(joined), { money: 9e6, factionRep: 1 })).toBe("reputation and money");
  });

  test("count: everything worth installing at the joined factions is counted; it waits on the bar", () => {
    expect(heldBackOf(slow([{ name: "CyberSec", reputation: 20_000, favor: 0 }]), { money: 1e12, factionRep: 1 })).toBe(
      "count",
    );
  });

  test("factions: nothing worth installing left unowned at the joined factions, or none joined", () => {
    expect(heldBackOf(slow([]), { money: 1e12, factionRep: 1 })).toBe("factions");
    // Owned or queued counts as had; NeuroFlux Governor's levels never count here.
    expect(
      heldBackOf(
        slow([{ name: "CyberSec", reputation: 0, favor: 0 }], owned(CYBERSEC.slice(0, 3)), CYBERSEC.slice(3)),
        {
          money: 0,
          factionRep: 1,
        },
      ),
    ).toBe("factions");
  });

  test("donations unlocked: the reputation is money's to buy, so money held it, not reputation", () => {
    const joined = [{ name: "CyberSec", reputation: 0, favor: 150 }];
    expect(heldBackOf(slow(joined), { money: 1e6, factionRep: 1 })).toBe("money");
    // With the money for the donations and the prices, nothing more would count.
    expect(heldBackOf(slow(joined), { money: 1e15, factionRep: 1 })).toBe("count");
    // A donation's money counts: $5m covers Neurotrainer I's $4m, not the $1b donation for its 1,000 reputation.
    expect(heldBackOf(slow(joined), { money: 5e6, factionRep: 1 })).toBe("reputation and money");
  });

  test("reputation reached exactly is reached", () => {
    // Neurotrainer I needs 1,000: reached, and $4m buys it and nothing more, whatever the reputation.
    expect(heldBackOf(slow([{ name: "CyberSec", reputation: 1_000, favor: 0 }]), { money: 4e6, factionRep: 1 })).toBe(
      "count",
    );
  });

  test("one whose prerequisite can't be had isn't counted: The Black Hand's Gen III and IV need Gen I and II", () => {
    // The Black Hand sells neither Gen I nor Gen II, so no money buys its Gen III or IV: the bar, not the money.
    const rest = augmentationsSoldBy("The Black Hand", 1, null).filter(
      (name) => name !== NEUROFLUX_GOVERNOR && !name.startsWith("Cranial Signal Processors - Gen I"),
    );
    expect(rest).not.toContain("Cranial Signal Processors - Gen III");
    const joined = [{ name: "The Black Hand", reputation: 1e6, favor: 0 }];
    expect(heldBackOf(slow(joined, owned(rest)), { money: 0, factionRep: 1 })).toBe("count");
    // With Gen I and II owned, the money would.
    const withGens = owned([...rest, "Cranial Signal Processors - Gen I", "Cranial Signal Processors - Gen II"]);
    expect(heldBackOf(slow(joined, withGens), { money: 0, factionRep: 1 })).toBe("money");
  });

  test("null where the snapshot doesn't say: no faction state, an unread one, malformed resetInfo, a name core lacks", () => {
    const money = { money: 1, factionRep: 1 };
    expect(heldBackOf(slowData({ lastAugReset: 0, lastNodeReset: 0 }), money)).toBeNull();
    expect(
      heldBackOf(
        { ...slow([]), factions: { backend: "ui", state: null, problem: "no sidebar" } } as SlowSnapshotData,
        money,
      ),
    ).toBeNull();
    expect(
      heldBackOf({ ...slow([]), resetInfo: { lastAugReset: 0 } } as unknown as SlowSnapshotData, money),
    ).toBeNull();
    expect(
      heldBackOf(slow([{ name: "CyberSec", reputation: 0, favor: 0 }], { "Not An Augmentation": 1 }), money),
    ).toBeNull();
  });
});
