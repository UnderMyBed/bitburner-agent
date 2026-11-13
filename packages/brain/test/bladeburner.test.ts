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
  type CombatPerson,
  combatPersonOf,
  type DesiredState,
  encodeControlMessage,
  type MediumSnapshotData,
  type SlowSnapshotData,
  type SnapshotTier,
  skillExpFor,
  slowestTrainingSeconds,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BLADEBURNER_TRAINING_HELD_EVENT_KIND,
  BladeburnerRule,
  bladeburnerSnapshotOf,
  type GymWork,
  JOIN_BLADEBURNER_INTENT,
  travelIntent,
} from "../src/bladeburner.ts";
import {
  BLADEBURNER_FACTION_WITHIN_MS,
  BLADEBURNER_JOIN_WITHIN_MS,
  BLADEBURNER_TRAINING_SLACK_MS,
  BLADEBURNER_UNREAD_WITHIN_MS,
  BladeburnerFold,
} from "../src/bladeburner-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import { formatDuration } from "../src/gap-report.ts";
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
  /** The hacking level (10 unless said), and the TOR router (#367's review: an invitation's visit pending). */
  hacking?: number;
  hasTorRouter?: boolean;
}
function medium({
  levels = {},
  money = 2e6,
  city = "Sector-12",
  factions = [],
  homeRam = 32,
  inBladeburner = false,
  reading,
  hacking = 10,
  hasTorRouter = false,
}: MediumOptions = {}): MediumSnapshotData {
  const skills: Record<string, number> = { hacking, charisma: 1, intelligence: 0 };
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
    hasTorRouter,
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
    const none = { work: null, intent: null, state: null, skillIntents: [] };
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
        skillIntents: [],
      });
      expect(rule.view().stage).toBe("training");
      expect(rule.training()).toBe(true);
      expect(rule.view().line).toBe(
        "Bladeburner: training to join, Strength training at Powerhouse Gym (strength 1, defense 1, dexterity 1, " +
          "agility 1; all four at 100 in about 75 min there)",
      );
    }
  });

  test("the stats in turn, at the gym the money covers: Iron's under $416,000, none under $72,000", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ levels: { strength: 100, defense: 100 }, money: 400_000 })).work).toEqual({
      kind: "class",
      location: "Iron Gym",
      classType: "dex",
    });
    const poor = new BladeburnerRule();
    expect(decide(poor, medium({ money: 50_000 }))).toEqual({
      work: null,
      intent: null,
      state: null,
      skillIntents: [],
    });
    expect(poor.training()).toBe(false);
    expect(poor.view().line).toBe(
      "Bladeburner: training to join, training waits for money for a gym: $72,000 at Iron Gym (10 minutes of its " +
        "cost) (strength 1, defense 1, dexterity 1, agility 1)",
    );
  });

  test("a start in Ishima, which has no gym: the travel to Sector-12 first, then Powerhouse's class there", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ city: "Ishima" }))).toEqual({
      work: null,
      intent: travelIntent("Sector-12"),
      state: null,
      skillIntents: [],
    });
    expect(travelIntent("Sector-12")).toEqual({
      action: "travel",
      args: { city: "Sector-12" },
      id: "travel(Sector-12)",
    });
    expect(rule.training()).toBe(true);
    expect(rule.view().line).toBe(
      "Bladeburner: training to join, travelling to Sector-12 for Powerhouse Gym (strength 1, defense 1, dexterity 1, " +
        "agility 1)",
    );
    expect(decide(rule, medium({ city: "Sector-12", money: 1.8e6 }))).toEqual({
      work: { kind: "class", location: "Powerhouse Gym", classType: "str" },
      intent: null,
      state: null,
      skillIntents: [],
    });
    // With too little for the travel and a gym: it waits, and says so.
    const poor = new BladeburnerRule();
    expect(decide(poor, medium({ city: "Ishima", money: 271_999 })).intent).toBeNull();
    expect(poor.view().line).toContain("$72,000 at Iron Gym (10 minutes of its cost), and $200,000 to travel there");
  });

  test("the owner's work holds the training: no class, no travel, and its event at each change", () => {
    const events: unknown[] = [];
    const rule = new BladeburnerRule(
      () => {},
      (event) => events.push(event),
    );
    const update = (ownersWork: boolean, nowMs: number, changes: Parameters<typeof medium>[0] = {}) =>
      rule.update({ mediumData: medium(changes), slowData: slow(6), homeKeptGb: 32, ownersWork, nowMs });
    expect(update(false, 1)).toMatchObject({ work: { location: "Powerhouse Gym" } });
    expect(update(true, 2)).toEqual({ work: null, intent: null, state: null, skillIntents: [] });
    expect(rule.training()).toBe(false);
    expect(rule.view().line).toBe(
      "Bladeburner: training to join held for your work on the dashboard (strength 1, defense 1, dexterity 1, agility 1)",
    );
    update(true, 3);
    update(false, 4);
    // Trained while held: the hold ends with the training.
    update(true, 5);
    update(true, 6, { levels: TRAINED });
    expect(events).toEqual([
      { type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, atMs: 2, held: true },
      { type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, atMs: 4, held: false },
      { type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, atMs: 5, held: true },
      { type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, atMs: 6, held: false },
    ]);
  });

  test("the gym chosen is kept while the money covers a minute of it: Powerhouse at $200,000, Iron at $100,000", () => {
    const rule = new BladeburnerRule();
    const location = (work: GymWork | null) => work?.location;
    expect(location(decide(rule, medium({ money: 2e6 })).work)).toBe("Powerhouse Gym");
    expect(location(decide(rule, medium({ money: 200_000 })).work)).toBe("Powerhouse Gym");
    expect(location(decide(rule, medium({ money: 100_000 })).work)).toBe("Iron Gym");
    // A new rule (a restarted brain) starts afresh: Iron at $200,000.
    expect(location(decide(new BladeburnerRule(), medium({ money: 200_000 })).work)).toBe("Iron Gym");
  });

  test("a stat changed at Powerhouse with $500,000: a new class, so the effectors' 10 minutes: Crush's, a travel away", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ money: 2e6 })).work).toEqual({
      kind: "class",
      location: "Powerhouse Gym",
      classType: "str",
    });
    expect(decide(rule, medium({ money: 500_000 })).work?.location).toBe("Powerhouse Gym");
    // Strength at 100: defense next, which the effectors would refuse at Powerhouse under $1.44m.
    expect(decide(rule, medium({ money: 500_000, levels: { strength: 100 } }))).toEqual({
      work: null,
      intent: travelIntent("Aevum"),
      state: null,
      skillIntents: [],
    });
    expect(rule.view().training?.gym).toBe("Crush Fitness Gym");
  });

  test("all four at 100, not in the division: its join, no work; one at 99, never", () => {
    const rule = new BladeburnerRule();
    expect(decide(rule, medium({ levels: TRAINED }))).toEqual({
      work: null,
      intent: JOIN_BLADEBURNER_INTENT,
      state: null,
      skillIntents: [],
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

  test("in the division: no work, no join; the worker only once home's RAM beyond its reserve holds its 50.6 GB (#375)", () => {
    const rule = new BladeburnerRule();
    // After an install, the stats back at 1, the division kept: no training.
    expect(decide(rule, medium({ inBladeburner: true, homeRam: 64 }), slow(6, { 4: 3 }), KEPT_AT_SF4_3)).toEqual({
      work: null,
      intent: null,
      state: null,
      skillIntents: [],
    });
    expect(rule.view().line).toBe(
      "Bladeburner: in the division; its reading waits for home's RAM: 50.6 GB beyond the 65.9 GB home keeps, and home " +
        "has 64 GB",
    );
    expect(decide(rule, medium({ inBladeburner: true, homeRam: 128 }), slow(6, { 4: 3 }), KEPT_AT_SF4_3).state).toEqual(
      {
        joinTheFaction: false,
      },
    );
    expect(rule.view().line).toBe("Bladeburner: in the division; waiting for its worker's reading");
    // Without Singularity home keeps 32 GB: 74.6 GB is the least that holds it (75 GB does; 74.5 GB doesn't).
    const fits = (homeRam: number) => decide(rule, medium({ inBladeburner: true, homeRam }), slow(6), 32).state;
    expect(fits(32.4 + BLADEBURNER_WORKER_RAM_GB)).toEqual({ joinTheFaction: false });
    expect(fits(32 + BLADEBURNER_WORKER_RAM_GB - 0.1)).toBeNull();
  });

  test("the faction asked for once the rank reads 25 and it isn't joined; joined, not again", () => {
    const rule = new BladeburnerRule();
    const read = (rank: number, factions: string[] = []) =>
      decide(rule, medium({ inBladeburner: true, homeRam: 128, factions, reading: { rank, problems: [] } })).state;
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
      reading: { kind: "read", rank: 3, problems: ["x"], actions: null },
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
    const held: unknown[] = [];
    controller.subscribe((event) => {
      if (event.type === BLADEBURNER_TRAINING_HELD_EVENT_KIND) held.push(event);
    });
    controller.setWork({ kind: "crime", crime: "Shoplift" });
    expect(last()?.work).toMatchObject({ kind: "crime", crime: "Shoplift" });
    // Its event goes out (#373's re-review): the run report's overdue clock stops on it.
    expect(held).toEqual([expect.objectContaining({ type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, held: true })]);
    // The training held for it: no travel either, from a city with no gym, and A5 and the invitations free.
    send("medium", cyberSec({ city: "Ishima" }));
    expect(controller.bladeburnerView().line).toContain("held for your work on the dashboard");
    expect(last()?.intents.map((each) => each.id)).not.toContain("travel(Sector-12)");
    controller.setWork(null);
    expect(last()?.intents.map((each) => each.id)).toContain("travel(Sector-12)");
    expect(held).toEqual([
      expect.objectContaining({ held: true }),
      expect.objectContaining({ type: BLADEBURNER_TRAINING_HELD_EVENT_KIND, held: false }),
    ]);
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

  test("the invitations' travel waits for the training: Tian Di Hui's visit held, said why; trained, it goes", () => {
    const { controller, send, last } = connected();
    send("slow", withCyberSec(6));
    const tianDiHui = (levels: Levels) =>
      medium({ levels, money: 2e6, hacking: 100, hasTorRouter: true, homeRam: 2 ** 20, factions: ["CyberSec"] });
    const sentIds = () => last()?.intents.map((each) => each.id) ?? [];
    send("medium", tianDiHui({}));
    expect(controller.invitationsView().waitingFor).toBe("Bladeburner's combat training at the gym (#367)");
    expect(sentIds()).not.toContain("travel(Ishima)");
    send("medium", tianDiHui(TRAINED));
    expect(controller.invitationsView().waitingFor).toBeNull();
    expect(sentIds()).toContain("travel(Ishima)");
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
  /** The overdue bound from nothing at ×1: twice Iron Gym's estimate (core's `slowestTrainingSeconds`) and 10 min. */
  const BOUND_MS =
    Math.ceil(2 * slowestTrainingSeconds(combatPersonOf(medium().player) as CombatPerson) * 1000) +
    BLADEBURNER_TRAINING_SLACK_MS;
  const iso = (atMs: number) => new Date(atMs).toISOString();

  /** A fold with BN6's slow snapshot at T0, home's reserve 32 GB (no Singularity), and each medium at its minute. */
  function fold(
    mediums: [number, MediumSnapshotData][],
    bitNode = 6,
    events: { kind: string; atMs: number; detail: unknown }[] = [],
  ) {
    const folded = new BladeburnerFold(events);
    folded.addSlow(T0, slow(bitNode));
    for (const [minute, data] of mediums) folded.addMedium(T0 + minute * MINUTE, data);
    const failures: string[] = [];
    const lines = folded.section(failures, T0 + 48 * 60 * MINUTE);
    return { text: lines.join("\n"), failures };
  }

  test("outside BN6 and BN7: none played", () => {
    expect(fold([[0, medium()]], 2).text).toBe(
      "8. Bladeburner (#367, #375, #383, #392: the training to join, the division, the faction, the actions, the cities " +
        "and the Black Ops; played in BN6 and BN7 only)\n" +
        "  not in BN6 or BN7 in the window: no Bladeburner played",
    );
  });

  test("the training within its estimate, the join, the rank and the faction: every check passes", () => {
    const { text, failures } = fold([
      [0, medium()],
      [40, medium({ levels: { strength: 100, defense: 100 } })],
      [74, medium({ levels: TRAINED })],
      [75, medium({ levels: TRAINED, inBladeburner: true, homeRam: 128, reading: { rank: 0, problems: [] } })],
      [76, medium({ levels: TRAINED, inBladeburner: true, homeRam: 128, reading: { rank: 25, problems: [] } })],
      [
        76.5,
        medium({
          levels: TRAINED,
          inBladeburner: true,
          homeRam: 128,
          factions: ["Bladeburners"],
          reading: { rank: 25, problems: [] },
        }),
      ],
    ]);
    expect(failures).toEqual([]);
    expect(text).toContain(
      `    from ${iso(T0)} (strength 1, defense 1, dexterity 1, agility 1): estimated 1 h 15 min at Powerhouse Gym from ` +
        `${iso(T0)}; overdue past ${formatDuration(BOUND_MS)}; done ${iso(T0 + 74 * MINUTE)}, after 1 h 14 min (0.99 of ` +
        "the estimate from when it was made)\n",
    );
    expect(text).toContain(`  the division: joined, first seen ${iso(T0 + 75 * MINUTE)}\n`);
    expect(text).toContain(`  rank: 0.0 → 25.0, read from ${iso(T0 + 75 * MINUTE)}\n`);
    expect(text).toContain(`  Bladeburners: joined, first seen ${iso(T0 + 76.5 * MINUTE)}\n`);
    for (const check of [
      "the training past twice the slowest gym's estimate and 10 min from its first sighting, still short of 100, at " +
        "any reading:\n    none",
      "all four at 100 with the division not joined for 5 min or more:\n    none",
      "the division unread with home's RAM there for its worker for 5 min or more:\n    none",
      "the rank at 25 or more with Bladeburners not joined for 1 min or more:\n    none",
    ]) {
      expect(text).toContain(check);
    }
  });

  test("overdue at twice the slowest gym's estimate and 10 min from its first sighting: at it passes, a reading on fails", () => {
    // Iron Gym's 1 a second at ×1 from nothing: 4 × 11,255.3 s, 12.5 h; twice that and 10 min, 25 h 10 min.
    expect(BOUND_MS).toBe(Math.ceil(2 * 4 * skillExpFor(100, 1) * 1000) + BLADEBURNER_TRAINING_SLACK_MS);
    expect(formatDuration(BOUND_MS)).toBe("25 h 10 min");
    const short = medium({ levels: { strength: 100, defense: 100, dexterity: 100, agility: 90 } });
    const atBound = BOUND_MS / MINUTE;
    expect(
      fold([
        [0, medium()],
        [atBound, short],
      ]).failures,
    ).toEqual([]);
    // A millisecond past it fails.
    expect(
      fold([
        [0, medium()],
        [atBound + 1 / MINUTE, short],
      ]).failures,
    ).toHaveLength(1);
    const late = fold([
      [0, medium()],
      [atBound + 10 / 60, short],
    ]);
    expect(late.failures).toEqual([
      "the training past twice the slowest gym's estimate and 10 min from its first sighting, still short of 100, " +
        `from ${iso(T0 + (atBound + 10 / 60) * MINUTE)} to ${iso(T0 + (atBound + 10 / 60) * MINUTE)} (first seen ` +
        `${iso(T0)}, its bound 25 h 10 min; strength 100, defense 100, dexterity 100, agility 90)`,
    ]);
  });

  test("no gym ever affordable, or a start in Ishima with nothing to travel on: the clock runs all the same, and fails", () => {
    for (const changes of [{ money: 0 }, { money: 0, city: "Ishima" }]) {
      const { text, failures } = fold([
        [0, medium(changes)],
        [BOUND_MS / MINUTE + 1, medium(changes)],
      ]);
      expect(text).toContain("no gym's estimate (none the money covered)");
      expect(failures).toHaveLength(1);
    }
    // In Ishima with the money: the travel's gym's estimate, Powerhouse's.
    expect(fold([[0, medium({ city: "Ishima" })]]).text).toContain("estimated 1 h 15 min at Powerhouse Gym");
  });

  test("the clock stops while the owner's work holds the training: 2 h held, 2 h more before it fails", () => {
    const held = (atMinute: number, isHeld: boolean) => ({
      kind: BLADEBURNER_TRAINING_HELD_EVENT_KIND,
      atMs: T0 + atMinute * MINUTE,
      detail: { held: isHeld },
    });
    const events = [held(60, true), held(180, false)];
    const atBound = BOUND_MS / MINUTE;
    const short = medium({ levels: { strength: 100 } });
    expect(
      fold(
        [
          [0, medium()],
          [atBound + 120, short],
        ],
        6,
        events,
      ).failures,
    ).toEqual([]);
    expect(
      fold(
        [
          [0, medium()],
          [atBound + 120 + 10 / 60, short],
        ],
        6,
        events,
      ).failures,
    ).toHaveLength(1);
    // Still held at the reading: the time since it was held counts no more.
    expect(
      fold(
        [
          [0, medium()],
          [atBound + 600, short],
        ],
        6,
        [held(60, true)],
      ).failures,
    ).toEqual([]);
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
    const { failures } = fold([joined(0, 128), joined(BLADEBURNER_UNREAD_WITHIN_MS / MINUTE, 128)]);
    expect(failures).toEqual([
      `the division unread with home's RAM there for its worker from ${iso(T0)} to ${iso(T0 + 5 * MINUTE)}, for ` +
        "5 min (no Bladeburner reading in the medium snapshot)",
    ]);
  });

  test("the rank at 25 with the faction not joined for a minute fails; under it passes; the worker's problems listed", () => {
    const at25 = (minute: number, problems: string[] = []) =>
      [minute, medium({ levels: TRAINED, inBladeburner: true, homeRam: 128, reading: { rank: 25, problems } })] as [
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
