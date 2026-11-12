// Bladeburner B1 (#367): the brain's rule on the snapshots (the training at the gym, the division's join, the worker's
// state behind home's RAM), the controller sending each through the desired state (the training ahead of A5's work,
// the join through the gate, nothing outside BN6 and BN7), the gate's guard, and the run report's section with each
// of its failures. The rule against the real engine is bn6-start-simulation.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  BLADEBURNER_WORKER_RAM_GB,
  COMBAT_STATS,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type SnapshotTier,
  skillExpFor,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BladeburnerRule, bladeburnerSnapshotOf, JOIN_BLADEBURNER_INTENT } from "../src/bladeburner.ts";
import {
  BLADEBURNER_FACTION_WITHIN_MS,
  BLADEBURNER_JOIN_WITHIN_MS,
  BLADEBURNER_TRAINING_SLACK_MS,
  BLADEBURNER_UNREAD_WITHIN_MS,
  BladeburnerFold,
} from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { snapshotGuardFailure } from "../src/irreversible-gate.ts";
import type { SaveBackupEvent } from "../src/save-backups.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MINUTE = 60_000;
/** Home's reserve at SF4.3 (share.ts's `homeKeptGbOf`): 32 GB and the destroy's worker, 33.9 GB. */
const KEPT_AT_SF4_3 = SHARE_HOME_KEPT_GB + 33.9;

type Levels = Partial<Record<(typeof COMBAT_STATS)[number], number>>;

/**
 * A medium snapshot in the shape `getPlayer()` gives: each combat stat at its level (1 unless said) with the experience
 * it takes, every multiplier 1, the money, city and factions; home's RAM; and, when given, `inBladeburner` and the
 * worker's reading.
 */
interface MediumOptions {
  levels?: Levels;
  money?: number;
  city?: string;
  factions?: string[];
  homeRam?: number;
  /** Null: absent, as from an older Agent. */
  inBladeburner?: boolean | null;
  reading?: unknown;
}
function medium({
  levels = {},
  money = 2e6,
  city = "Sector-12",
  factions = [],
  homeRam = 32,
  inBladeburner = false,
  reading,
}: MediumOptions = {}): MediumSnapshotData {
  const skills: Record<string, number> = { hacking: 10, charisma: 1, intelligence: 0 };
  const exp: Record<string, number> = { hacking: 0, charisma: 0, intelligence: 0 };
  const mults: Record<string, number> = { faction_rep: 1, hacking: 1, hacking_exp: 1, charisma: 1, charisma_exp: 1 };
  for (const stat of COMBAT_STATS) {
    const level = levels[stat] ?? 1;
    skills[stat] = level;
    exp[stat] = level <= 1 ? 0 : skillExpFor(level, 1);
    mults[stat] = 1;
    mults[`${stat}_exp`] = 1;
  }
  return {
    player: { skills, exp, mults, money, city, factions },
    hasTorRouter: false,
    programs: [],
    servers: [
      {
        hostname: "home",
        maxRam: homeRam,
        cpuCores: 1,
        hasAdminRights: true,
        backdoorInstalled: false,
        moneyAvailable: 0,
        hackDifficulty: 1,
      },
    ],
    ...(inBladeburner === null ? {} : { inBladeburner }),
    ...(reading === undefined ? {} : { bladeburner: reading as MediumSnapshotData["bladeburner"] }),
  };
}

const TRAINED: Levels = { strength: 100, defense: 100, dexterity: 100, agility: 100 };
/** A slow snapshot of `bitNode` with `ownedSF`. */
const slow = (bitNode: number, ownedSF: Record<string, number> = {}): SlowSnapshotData => {
  const data = slowData(bitNode);
  return { ...data, resetInfo: { ...data.resetInfo, ownedSF } as SlowSnapshotData["resetInfo"] };
};

describe("the rule", () => {
  const decide = (rule: BladeburnerRule, mediumData: MediumSnapshotData | null, slowSnapshot = slow(6), kept = 32) =>
    rule.update({ mediumData, slowData: slowSnapshot, homeKeptGb: kept });

  test("outside BN6 and BN7 nothing, SF6 and SF7 or not; with no slow snapshot, nothing either", () => {
    const rule = new BladeburnerRule();
    const none = { work: null, intent: null, state: null };
    for (const slowSnapshot of [slow(1), slow(2, { 6: 1, 7: 1 }), slow(5, { 6: 3 }), slow(8, { 7: 3 })]) {
      expect(decide(rule, medium({ levels: TRAINED }), slowSnapshot)).toEqual(none);
      expect(decide(rule, medium(), slowSnapshot)).toEqual(none);
      expect(rule.view().stage).toBe("notManaged");
    }
    expect(rule.view().line).toBe("Bladeburner: not managed (played in BN6 and BN7 only for now; this is BN8)");
    expect(rule.update({ mediumData: medium(), slowData: null, homeKeptGb: 32 })).toEqual(none);
  });

  test("in BN6 and BN7, short of 100: the gym's class as the brain's work, strength first, the estimate in the line", () => {
    for (const bitNode of [6, 7]) {
      const rule = new BladeburnerRule();
      expect(decide(rule, medium(), slow(bitNode))).toEqual({
        work: { kind: "class", location: "Powerhouse Gym", classType: "str" },
        intent: null,
        state: null,
      });
      expect(rule.view().stage).toBe("training");
      expect(rule.training()).toBe(true);
      expect(rule.view().line).toBe(
        "Bladeburner: training to join, Strength training at Powerhouse Gym (strength 1, defense 1, dexterity 1, " +
          "agility 1; all four at 100 in about 75 min there)",
      );
    }
  });

  test("the stats in turn, at the gym the money covers: Iron's under Powerhouse's $1.44m, none under $72,000", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ levels: { strength: 100, defense: 100 }, money: 1e6 })).work).toEqual({
      kind: "class",
      location: "Iron Gym",
      classType: "dex",
    });
    const poor = new BladeburnerRule();
    expect(decide(poor, medium({ money: 50_000 })).work).toBeNull();
    expect(poor.training()).toBe(false);
    expect(poor.view().line).toBe(
      "Bladeburner: training to join, training waits for money for a gym in Sector-12: 10 minutes of its cost " +
        "(strength 1, defense 1, dexterity 1, agility 1)",
    );
    expect(decide(poor, medium({ money: 50_000, city: "Chongqing" })).work).toBeNull();
    expect(poor.view().line).toContain("training waits for a gym: none in Chongqing (the travel is left out)");
  });

  test("the gym chosen is kept while the money covers a minute of it: Powerhouse at $200,000, Iron at $100,000", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ money: 2e6 })).work?.location).toBe("Powerhouse Gym");
    expect(decide(rule, medium({ money: 200_000 })).work?.location).toBe("Powerhouse Gym");
    expect(decide(rule, medium({ money: 100_000 })).work?.location).toBe("Iron Gym");
    // A new rule (a restarted brain) starts afresh: Iron at $200,000.
    expect(decide(new BladeburnerRule(), medium({ money: 200_000 })).work?.location).toBe("Iron Gym");
  });

  test("all four at 100, not in the division: its join, no work; one at 99, never", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ levels: TRAINED }))).toEqual({
      work: null,
      intent: JOIN_BLADEBURNER_INTENT,
      state: null,
    });
    expect(JOIN_BLADEBURNER_INTENT).toEqual({
      action: "joinBladeburnerDivision",
      args: {},
      id: "joinBladeburnerDivision()",
    });
    expect(rule.view().line).toBe(
      "Bladeburner: joining the division (strength 100, defense 100, dexterity 100, agility 100: all four at 100)",
    );
    // An older Agent that doesn't say whether the player is in the division: asked; the effector checks the game.
    const older = new BladeburnerRule();
    expect(decide(older, medium({ levels: TRAINED, inBladeburner: null })).intent).toEqual(JOIN_BLADEBURNER_INTENT);
    expect(older.view().line).toContain("; this Agent doesn't say whether it's in");
    for (const stat of COMBAT_STATS) {
      const decision = decide(new BladeburnerRule(), medium({ levels: { ...TRAINED, [stat]: 99 } }));
      expect(decision.intent, stat).toBeNull();
      expect(decision.work?.classType, stat).toBe(
        { strength: "str", defense: "def", dexterity: "dex", agility: "agi" }[stat],
      );
    }
  });

  test("in the division: no work, no join; the worker only once home's RAM beyond its reserve holds its 9.6 GB", () => {
    const rule = new BladeburnerRule();
    // After an install, the stats back at 1, the division kept: no training.
    expect(decide(rule, medium({ inBladeburner: true, homeRam: 64 }), slow(6, { 4: 3 }), KEPT_AT_SF4_3)).toEqual({
      work: null,
      intent: null,
      state: null,
    });
    expect(rule.view().line).toBe(
      "Bladeburner: in the division; its reading waits for home's RAM: 9.6 GB beyond the 65.9 GB home keeps, and home " +
        "has 64 GB",
    );
    expect(decide(rule, medium({ inBladeburner: true, homeRam: 128 }), slow(6, { 4: 3 }), KEPT_AT_SF4_3).state).toEqual(
      {
        joinTheFaction: false,
      },
    );
    expect(rule.view().line).toBe("Bladeburner: in the division; waiting for its worker's reading");
    // Without Singularity home keeps 32 GB: 41.6 GB is the least that holds it.
    const fits = (homeRam: number) => decide(rule, medium({ inBladeburner: true, homeRam }), slow(6), 32).state;
    expect(fits(32 + BLADEBURNER_WORKER_RAM_GB)).toEqual({ joinTheFaction: false });
    expect(fits(32 + BLADEBURNER_WORKER_RAM_GB - 0.1)).toBeNull();
  });

  test("the faction asked for once the rank reads 25 and it isn't joined; joined, not again", () => {
    const rule = new BladeburnerRule();
    const read = (rank: number, factions: string[] = []) =>
      decide(rule, medium({ inBladeburner: true, homeRam: 64, factions, reading: { rank, problems: [] } })).state;
    expect(read(24.9)).toEqual({ joinTheFaction: false });
    expect(rule.view().line).toBe("Bladeburner: in the division, rank 24.9; Bladeburners at rank 25");
    expect(read(25)).toEqual({ joinTheFaction: true });
    expect(rule.view().line).toBe("Bladeburner: in the division, rank 25.0; joining Bladeburners");
    expect(read(30, ["Bladeburners"])).toEqual({ joinTheFaction: false });
    expect(rule.view().line).toBe("Bladeburner: in the division, rank 30.0; Bladeburners joined");
  });

  test("it logs a change of stage, gym or stat, not each figure", () => {
    const lines: string[] = [];
    const rule = new BladeburnerRule((line) => lines.push(line));
    decide(rule, medium());
    decide(rule, medium({ levels: { strength: 50 } }));
    decide(rule, medium({ levels: { strength: 100 } }));
    decide(rule, medium({ levels: TRAINED }));
    decide(rule, medium({ levels: TRAINED, money: 3e6 }));
    expect(lines.map((line) => line.split(" (")[0])).toEqual([
      "bladeburner: training to join, Strength training at Powerhouse Gym",
      "bladeburner: training to join, Defense training at Powerhouse Gym",
      "bladeburner: joining the division",
    ]);
  });

  test("the medium snapshot's reading, checked: absent, unread with the worker's problem, the rank", () => {
    expect(bladeburnerSnapshotOf(medium({ inBladeburner: null }))).toEqual({
      joined: null,
      reading: { kind: "absent" },
    });
    expect(
      bladeburnerSnapshotOf(medium({ inBladeburner: true, reading: { rank: null, problems: ["bad state"] } })),
    ).toEqual({
      joined: true,
      reading: { kind: "unread", problem: "bad state" },
    });
    expect(bladeburnerSnapshotOf(medium({ reading: { rank: "3", problems: [] } })).reading.kind).toBe("unread");
    expect(bladeburnerSnapshotOf(medium({ inBladeburner: true, reading: { rank: 3, problems: ["x"] } }))).toEqual({
      joined: true,
      reading: { kind: "read", rank: 3, problems: ["x"] },
    });
  });
});

describe("the gate's guard (#367): the division's join needs all four at 100 on the medium snapshot", () => {
  test("held with one short, each named; released with all four", () => {
    expect(snapshotGuardFailure(JOIN_BLADEBURNER_INTENT, medium({ levels: TRAINED }), null)).toBeNull();
    expect(snapshotGuardFailure(JOIN_BLADEBURNER_INTENT, medium({ levels: { ...TRAINED, agility: 99 } }), null)).toBe(
      "agility 99: the division needs 100 each",
    );
    expect(snapshotGuardFailure(JOIN_BLADEBURNER_INTENT, medium(), null)).toBe(
      "strength 1, defense 1, dexterity 1, agility 1: the division needs 100 each",
    );
    const unread = { ...medium(), player: { money: 1 } };
    expect(snapshotGuardFailure(JOIN_BLADEBURNER_INTENT, unread, null)).toBe("the medium snapshot has no combat stats");
  });
});

describe("the controller (#367)", () => {
  const TOKEN = "the-token";
  const SAVED: SaveBackupEvent = { type: "saveBackup", atMs: 1, file: "saves/E0/x.json.gz", sizeBytes: 10 };
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "bladeburner-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A brain with the hack loop off (its intents go at once) and stand-in backups, an Agent connected. */
  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const pending: ((event: SaveBackupEvent) => void)[] = [];
    const backupNow = vi.fn(() => new Promise<SaveBackupEvent>((resolve) => pending.push(resolve)));
    const lines: string[] = [];
    const controller = new DesiredStateController({
      channel,
      store,
      saveBackups: { backupNow },
      log: (line) => lines.push(line),
    });
    const connection = new MemoryConnection();
    channel.accept(connection);
    connection.receive(
      encodeControlMessage({
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        type: "hello",
        token: TOKEN,
        deploymentId: "deployment-a",
        agentSessionId: "session-1",
        game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
      }),
    );
    const send = (tier: SnapshotTier, data: unknown) =>
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier,
          sequenceNumber: ++sequenceNumber,
          gameTimeMs: 1_000,
          data,
        }),
      );
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    const last = () =>
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as unknown as DesiredState | undefined;
    const settleBackup = async () => {
      pending.shift()?.(SAVED);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { controller, send, last, lines, backupNow, settleBackup };
  }
  /** A slow snapshot of `bitNode` with CyberSec joined, so A5 has a faction to work for. */
  const withCyberSec = (bitNode: number, ownedSF: Record<string, number> = {}): SlowSnapshotData => ({
    ...slow(bitNode, ownedSF),
    factions: {
      backend: "sim",
      state: { joined: [{ name: "CyberSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  });
  const cyberSec = (changes: MediumOptions = {}) => medium({ factions: ["CyberSec"], ...changes });

  test("in BN6, short of 100: the gym's class sent as the brain's work, A5's faction work and travel waiting for it", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    send("medium", cyberSec());
    expect(last()?.work).toEqual({ kind: "class", location: "Powerhouse Gym", classType: "str", focus: false });
    expect(controller.workView()).toMatchObject({ source: "brain", desired: { kind: "class" } });
    expect(controller.factionsView()).toMatchObject({
      sent: false,
      waitingFor: "Bladeburner's combat training at the gym (#367)",
    });
    expect(last()?.bladeburner).toBeUndefined();
    expect(controller.bladeburnerView().stage).toBe("training");
    // The owner's work still wins.
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    expect(last()?.work).toMatchObject({ kind: "crime", crime: "Shoplift" });
  });

  test("trained: A5's faction work back; the join only through the gate, after two medium snapshots and a backup", async () => {
    const { controller, send, last, backupNow, settleBackup } = connected();
    send("slow", withCyberSec(6));
    // One stat at 99: no join asked for, however long.
    for (let step = 0; step < 4; step++) send("medium", cyberSec({ levels: { ...TRAINED, dexterity: 99 } }));
    const ours = () => controller.intentsView().filter((view) => view.source === "bladeburner");
    const sentJoin = () => last()?.intents.filter((each) => each.action === "joinBladeburnerDivision");
    expect(ours()).toEqual([]);
    expect(backupNow).not.toHaveBeenCalled();
    send("medium", cyberSec({ levels: TRAINED }));
    expect(ours()).toEqual([
      {
        id: JOIN_BLADEBURNER_INTENT.id,
        source: "bladeburner",
        outcome: null,
        waitingFor: "waiting for the guard to hold on 2 consecutive medium snapshots (0 so far)",
      },
    ]);
    expect(sentJoin()).toEqual([]);
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    send("medium", cyberSec({ levels: TRAINED }));
    send("medium", cyberSec({ levels: TRAINED }));
    expect(backupNow).toHaveBeenCalledTimes(1);
    expect(sentJoin()).toEqual([]);
    await settleBackup();
    expect(sentJoin()).toEqual([JOIN_BLADEBURNER_INTENT]);
    // In the division: asked no more.
    send("medium", cyberSec({ levels: TRAINED, inBladeburner: true }));
    expect(sentJoin()).toEqual([]);
    expect(controller.bladeburnerView().stage).toBe("joined");
  });

  test("in the division, the worker's state only with home's RAM beyond its reserve: 128 GB at SF4.3, not 64", () => {
    const { send, last } = connected();
    send("slow", withCyberSec(6, { 1: 3, 4: 3 }));
    send("medium", cyberSec({ inBladeburner: true, homeRam: 64 }));
    expect(last()?.bladeburner).toBeUndefined();
    send("medium", cyberSec({ inBladeburner: true, homeRam: 128 }));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: false });
    send("medium", cyberSec({ inBladeburner: true, homeRam: 128, reading: { rank: 25, problems: [] } }));
    expect(last()?.bladeburner).toEqual({ joinTheFaction: true });
  });

  test("outside BN6 and BN7, with SF6 and SF7 too: no training, no join, no worker; A5's work goes", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(1, { 6: 1, 7: 1 }));
    send("medium", cyberSec());
    send("medium", cyberSec({ levels: TRAINED, homeRam: 1024 }));
    send("medium", cyberSec({ levels: TRAINED, homeRam: 1024 }));
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    expect(last()?.bladeburner).toBeUndefined();
    expect(controller.intentsView().filter((view) => view.source === "bladeburner")).toEqual([]);
    expect(last()?.intents.map((each) => each.action)).not.toContain("joinBladeburnerDivision");
    expect(controller.bladeburnerView().stage).toBe("notManaged");
  });
});

describe("the run report's section 8 (#367)", () => {
  const T0 = Date.UTC(2026, 0, 1);
  const iso = (atMs: number) => new Date(atMs).toISOString();

  /** A fold with BN6's slow snapshot at T0, home's reserve 32 GB (no Singularity), and each medium at its minute. */
  function fold(mediums: [number, MediumSnapshotData][], bitNode = 6) {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(bitNode));
    for (const [minute, data] of mediums) folded.addMedium(T0 + minute * MINUTE, data);
    const failures: string[] = [];
    const lines = folded.section(failures, T0 + 24 * 60 * MINUTE);
    return { text: lines.join("\n"), failures };
  }

  test("outside BN6 and BN7: none played", () => {
    expect(fold([[0, medium()]], 2).text).toBe(
      "8. Bladeburner (#367, B1: the training to join, the division, the faction; played in BN6 and BN7 only)\n" +
        "  not in BN6 or BN7 in the window: no Bladeburner played",
    );
  });

  test("the training within its estimate, the join, the rank and the faction: every check passes", () => {
    const { text, failures } = fold([
      [0, medium()],
      [40, medium({ levels: { strength: 100, defense: 100 } })],
      [74, medium({ levels: TRAINED })],
      [75, medium({ levels: TRAINED, inBladeburner: true, homeRam: 64, reading: { rank: 0, problems: [] } })],
      [76, medium({ levels: TRAINED, inBladeburner: true, homeRam: 64, reading: { rank: 25, problems: [] } })],
      [
        76.5,
        medium({
          levels: TRAINED,
          inBladeburner: true,
          homeRam: 64,
          factions: ["Bladeburners"],
          reading: { rank: 25, problems: [] },
        }),
      ],
    ]);
    expect(failures).toEqual([]);
    expect(text).toContain(
      `    from ${iso(T0)} (strength 1, defense 1, dexterity 1, agility 1): estimated 1 h 15 min at Powerhouse Gym from ` +
        `${iso(T0)}; done ${iso(T0 + 74 * MINUTE)}, after 1 h 14 min (0.99 of the estimate from when it was made)\n`,
    );
    expect(text).toContain(`  the division: joined, first seen ${iso(T0 + 75 * MINUTE)}\n`);
    expect(text).toContain(`  rank: 0.0 → 25.0, read from ${iso(T0 + 75 * MINUTE)}\n`);
    expect(text).toContain(`  Bladeburners: joined, first seen ${iso(T0 + 76.5 * MINUTE)}\n`);
    for (const check of [
      "the training past twice its estimate and 10 min, still short of 100, at any reading:\n    none",
      "all four at 100 with the division not joined for 5 min or more:\n    none",
      "the division unread with home's RAM there for its worker for 5 min or more:\n    none",
      "the rank at 25 or more with Bladeburners not joined for 1 min or more:\n    none",
    ]) {
      expect(text).toContain(check);
    }
  });

  test("the training overdue: past twice its estimate and the slack, still short, fails; just inside, passes", () => {
    const estimateMs = ((4 * skillExpFor(100, 1)) / 10) * 1000;
    const boundMinutes = (2 * estimateMs + BLADEBURNER_TRAINING_SLACK_MS) / MINUTE;
    const inside = fold([
      [0, medium()],
      [boundMinutes - 0.5, medium({ levels: { strength: 100, defense: 100, dexterity: 100, agility: 90 } })],
    ]);
    expect(inside.failures).toEqual([]);
    const late = fold([
      [0, medium()],
      [boundMinutes + 0.5, medium({ levels: { strength: 100, defense: 100, dexterity: 100, agility: 90 } })],
    ]);
    expect(late.failures).toEqual([
      `the training past twice its estimate and 10 min, still short of 100, from ${iso(T0 + (boundMinutes + 0.5) * MINUTE)} ` +
        `to ${iso(T0 + (boundMinutes + 0.5) * MINUTE)} (estimated 1 h 15 min at Powerhouse Gym from ${iso(T0)}; ` +
        "strength 100, defense 100, dexterity 100, agility 90)",
    ]);
  });

  test("an install restarts the training: each cycle's estimate its own", () => {
    const folded = new BladeburnerFold();
    folded.addSlow(T0, slow(6));
    folded.addMedium(T0, medium());
    folded.addMedium(T0 + 100 * MINUTE, medium({ levels: { strength: 100 } }));
    const after = slow(6);
    folded.addSlow(T0 + 101 * MINUTE, {
      ...after,
      resetInfo: { ...after.resetInfo, lastAugReset: 5 } as SlowSnapshotData["resetInfo"],
    });
    folded.addMedium(T0 + 102 * MINUTE, medium());
    folded.addMedium(T0 + 200 * MINUTE, medium({ levels: { strength: 100 } }));
    const failures: string[] = [];
    const text = folded.section(failures, T0 + 300 * MINUTE).join("\n");
    expect(failures).toEqual([]);
    expect(text.match(/^ {4}from /gm)).toHaveLength(2);
  });

  test("trained and not in the division for 5 minutes fails; a minute less passes", () => {
    const trained = (minute: number) => [minute, medium({ levels: TRAINED })] as [number, MediumSnapshotData];
    expect(fold([trained(0), trained(4)]).failures).toEqual([]);
    const { failures } = fold([trained(0), trained(BLADEBURNER_JOIN_WITHIN_MS / MINUTE)]);
    expect(failures).toEqual([
      `all four at 100 with the division not joined from ${iso(T0)} to ${iso(T0 + 5 * MINUTE)}, for 5 min ` +
        "(strength 100, defense 100, dexterity 100, agility 100, not in the division)",
    ]);
  });

  test("the division unread with home's RAM there for its worker, 5 minutes, fails; home too small, it's no failure", () => {
    const joined = (minute: number, homeRam: number) =>
      [minute, medium({ levels: TRAINED, inBladeburner: true, homeRam })] as [number, MediumSnapshotData];
    expect(fold([joined(0, 32), joined(30, 32)]).failures).toEqual([]);
    const { failures } = fold([joined(0, 64), joined(BLADEBURNER_UNREAD_WITHIN_MS / MINUTE, 64)]);
    expect(failures).toEqual([
      `the division unread with home's RAM there for its worker from ${iso(T0)} to ${iso(T0 + 5 * MINUTE)}, for ` +
        "5 min (no Bladeburner reading in the medium snapshot)",
    ]);
  });

  test("the rank at 25 with the faction not joined for a minute fails; under it passes; the worker's problems listed", () => {
    const at25 = (minute: number, problems: string[] = []) =>
      [minute, medium({ levels: TRAINED, inBladeburner: true, homeRam: 64, reading: { rank: 25, problems } })] as [
        number,
        MediumSnapshotData,
      ];
    expect(fold([at25(0), at25(0.5)]).failures).toEqual([]);
    const { text, failures } = fold([
      at25(0, ["the game didn't take the player"]),
      at25(BLADEBURNER_FACTION_WITHIN_MS / MINUTE),
    ]);
    expect(failures).toEqual([
      `the rank at 25 or more with Bladeburners not joined from ${iso(T0)} to ${iso(T0 + MINUTE)}, for 1 min ` +
        "(rank 25.0, Bladeburners not joined)",
    ]);
    expect(text).toContain(
      `  problems the Bladeburner worker reported, as first seen:\n    ${iso(T0)}: the game didn't take the player\n`,
    );
  });
});
