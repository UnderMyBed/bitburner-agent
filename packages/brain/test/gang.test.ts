// The gang (#325, G1 of #324; ascension #328, G2; equipment #330, G3; territory warfare #332, G4): the brain's rule on
// the snapshots, the gang faction left out of what the other rules see, the gate's guard on forming, the equipment's
// hold, the warfare order and deaths, and the run report's section with each of its failures.
// The rule against the real engine is gang-simulation.test.ts's; the formulas against it, gang-parity.test.ts's.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  AUGMENTATION_NAMES,
  BATCHER_RAM_BUDGET_GB,
  type Bn2Route,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  GANG_CYCLES_PER_PROCESS,
  GANG_EQUIPMENT_PAYBACK_LIMIT_MS,
  GANG_FACTIONS,
  GANG_STATS,
  GANG_TERRITORY_UPDATE_MS,
  type GangInformation,
  type GangMemberReading,
  type GangPlan,
  type GangReading,
  type GangRuleInputs,
  type GangWarfareFigures,
  gangMemberAscended,
  gangObjectiveChoice,
  gangSkillLevel,
  gangSoftcapOf,
  gangTerritoryPerUpdate,
  gangWarfareBasis,
  gangWarfareMeasure,
  homeRamUpgradePrice,
  type Intent,
  intentId,
  type MediumSnapshotData,
  parseGangState,
  planGang,
  type SlowSnapshotData,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { donationStatus } from "../src/augmentation-report.ts";
import { AUGMENTATION_RESERVE_LOOKAHEAD_MS } from "../src/augmentations.ts";
import { MEDIUM_SNAPSHOT_GAP_MS } from "../src/backdoors.ts";
import { HOME_KEPT_FOR_THE_AGENT_GB } from "../src/batcher.ts";
import { CLOUD_SERVER_PAYBACK_LIMIT_MS } from "../src/cloud-servers.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import {
  describeWarfare,
  GANG_PLACED_ON_JUSTICE_SETTING,
  GangFactionCarry,
  GangRule,
  gangDeathsBetween,
  gangMoneyHoldOf,
  gangPurchasesSpokenFor,
  gangSnapshotOf,
  gangWarfareFiguresOf,
  withoutGangFaction,
} from "../src/gang.ts";
import {
  GANG_ASCEND_WITHIN_MS,
  GANG_EQUIP_WITHIN_MS,
  GANG_FORM_WITHIN_MS,
  GANG_OBJECTIVE_DIFFERS_WITHIN_MS,
  GANG_RECRUIT_WITHIN_MS,
  GANG_UNREAD_WITHIN_MS,
  GANG_WANTED_OUTCOME_MS,
  GANG_WANTED_OVER_BOUND_MS,
  GANG_WARFARE_WITHIN_MS,
  GangFold,
} from "../src/gang-report.ts";
import {
  GANG_PROBLEM_WITHIN_MS,
  GANG_RESPECT_FLAT_WITHIN_MS,
  GANG_TASK_WITHIN_MS,
  type GangStallReading,
  GangStallWatch,
  gangPlannedRespectPerCycle,
  gangStallsAt,
} from "../src/gang-stalls.ts";
import { snapshotGuardFailure } from "../src/irreversible-gate.ts";
import { SHARE_HOME_KEPT_GB } from "../src/share.ts";
import { type StoredEvent, TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MINUTE = 60_000;
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** A member as the gang worker reads it: `hack` and `cha` levels, the rest 1, no multipliers; training by default. */
function member(name: string, hack = 1, task = "Train Hacking"): GangMemberReading {
  const reading: Record<string, unknown> = {
    name,
    task,
    earnedRespect: 0,
    respectGain: 0,
    moneyGain: 0,
    wantedLevelGain: 0,
  };
  for (const stat of GANG_STATS) {
    const level = stat === "hack" ? hack : 1;
    reading[stat] = level;
    reading[`${stat}_exp`] = expFor(level);
    reading[`${stat}_mult`] = 1;
    reading[`${stat}_asc_mult`] = 1;
    reading[`${stat}_asc_points`] = 0;
  }
  return reading as unknown as GangMemberReading;
}

const NITESEC: GangInformation = {
  faction: "NiteSec",
  isHacking: true,
  respect: 1,
  wantedLevel: 1,
  wantedPenalty: 0.5,
  territory: 1 / 7,
  respectGainRate: 0,
  moneyGainRate: 0,
  wantedLevelGainRate: 0,
  power: 1,
};

/** A medium snapshot with `gang` read, NiteSec joined unless `factions` says otherwise. */
const withGang = (gang: GangReading | null | undefined, factions = ["CyberSec", "NiteSec"]): MediumSnapshotData => ({
  ...mediumData(50, {}, { factions }),
  ...(gang === undefined ? {} : { gang }),
});
const formed = (members: GangMemberReading[], changes: Partial<GangInformation> = {}): GangReading => ({
  gang: { ...NITESEC, ...changes },
  members,
  problems: [],
});
const NONE: GangReading = { gang: null, members: [], problems: [] };

/** A fighter (G4): combat levels 5,000 (power 210, `gangMemberPower`), hacking 1, on `task`. */
function fighter(name: string, task = "Territory Warfare"): GangMemberReading {
  const reading = member(name, 1, task) as unknown as Record<string, number>;
  for (const stat of ["str", "def", "dex", "agi"]) {
    reading[stat] = 5_000;
    reading[`${stat}_exp`] = expFor(5_000);
  }
  return reading as unknown as GangMemberReading;
}
/** The six other gangs (G4), each at `power` and 1/7 of the territory. */
const others = (power: number) =>
  GANG_FACTIONS.filter((faction) => faction !== "NiteSec").map((faction) => ({ faction, power, territory: 1 / 7 }));
/** NiteSec with territory warfare read (G4): its power, the flag, and the others at `otherPower`. */
const warring = (
  members: GangMemberReading[],
  power: number,
  otherPower: number,
  changes: Partial<GangInformation> = {},
): GangReading =>
  formed(members, {
    respect: 1_000,
    wantedPenalty: 0.999,
    power,
    territoryWarfareEngaged: false,
    territoryClashChance: 0,
    otherGangs: others(otherPower).map((other) => ({ ...other, winChance: power / (power + other.power) })),
    ...changes,
  });
const FORM_NITESEC: Intent = {
  action: "createGang",
  args: { faction: "NiteSec" },
  id: intentId("createGang", { faction: "NiteSec" }),
};

describe("the rule", () => {
  test("outside BN2, no gang is managed: no intent, no gang in the desired state", () => {
    const rule = new GangRule();
    expect(rule.update({ mediumData: withGang(NONE), slowData: slowData(1) })).toEqual({ intent: null, gang: null });
    expect(rule.view()).toMatchObject({ stage: "notManaged", line: expect.stringContaining("this is BN1") });
    expect(rule.update({ mediumData: withGang(NONE), slowData: null })).toEqual({ intent: null, gang: null });
  });

  test("in BN2, read before the gang is: an empty gang state, waiting for the worker's reading", () => {
    const rule = new GangRule();
    expect(rule.update({ mediumData: withGang(undefined), slowData: slowData(2) })).toEqual({
      intent: null,
      gang: { recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null, warfare: null },
    });
    expect(rule.view().stage).toBe("waiting");
    const unread = withGang({ gang: null, members: [], problems: ["the gang state isn't one to do"] });
    expect(rule.update({ mediumData: unread, slowData: slowData(2) }).intent).toBeNull();
    expect(rule.view().line).toContain("unread: the gang state isn't one to do");
  });

  test("none formed: with no gang faction joined, it waits; with NiteSec joined, it forms the gang there", () => {
    const rule = new GangRule();
    expect(rule.update({ mediumData: withGang(NONE, ["CyberSec"]), slowData: slowData(2) }).intent).toBeNull();
    expect(rule.view().stage).toBe("noFaction");
    expect(rule.update({ mediumData: withGang(NONE), slowData: slowData(2) })).toEqual({
      intent: FORM_NITESEC,
      gang: { recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null, warfare: null },
    });
    expect(rule.view().line).toBe("Gang: forming with NiteSec");
    // A combat faction joined too: formed there (core's gangFactionToForm).
    expect(
      rule.update({ mediumData: withGang(NONE, ["NiteSec", "Slum Snakes"]), slowData: slowData(2) }).intent?.id,
    ).toBe("createGang(Slum Snakes)");
  });

  test("formed: recruits as the respect allows, each set to train; members by the rule; the gang faction known", () => {
    const rule = new GangRule();
    const decision = rule.update({ mediumData: withGang(formed([])), slowData: slowData(2) });
    expect(decision.intent).toBeNull();
    expect(decision.gang).toEqual({
      recruit: ["member-01", "member-02", "member-03"],
      ascend: [],
      tasks: { "member-01": "Train Hacking", "member-02": "Train Hacking", "member-03": "Train Hacking" },
      buy: [],
      keepMoney: null,
      warfare: null,
    });
    expect(rule.gangFaction()).toBe("NiteSec");
    const grown = formed([member("member-01", 300), member("member-02", 40), member("member-03", 120)], {
      respect: 1_000,
      wantedPenalty: 0.999,
      moneyGainRate: 10,
    });
    // member-01 ascends (G2): its levels are all experience, never ascended; it trains after. Its points as read go
    // with the order, the worker's guard.
    expect(rule.update({ mediumData: withGang(grown), slowData: slowData(2) }).gang).toEqual({
      recruit: ["member-04", "member-05", "member-06", "member-07"],
      ascend: [{ name: "member-01", pointsBefore: 0 }],
      tasks: {
        "member-01": "Train Hacking",
        "member-02": "Train Hacking",
        "member-03": "Phishing",
        "member-04": "Train Hacking",
        "member-05": "Train Hacking",
        "member-06": "Train Hacking",
        "member-07": "Train Hacking",
      },
      buy: [],
      keepMoney: null,
      warfare: null,
    });
    expect(rule.view().line).toMatch(/^Gang: NiteSec's, 3 members of 12 \(2 training, 1 on Phishing\);/);
    expect(rule.view().line).toMatch(/; ascending member-01 \(multipliers up to ×\d+\.\d\d, 0 respect lost\); /);
    // Territory warfare (G4): an older Agent's reading has no other gangs, so no order, the flag left alone.
    expect(rule.view().line).toMatch(/; territory 14\.3%, power 1\.0; warfare not read \(an older Agent\)$/);
    // The money a second, 10 a 200 ms cycle, in dollars (#328's review: the "$" was lost once).
    expect(rule.view().line).toContain("; $50/s; ascending member-01");
  });

  test("the hysteresis across updates: the rule's own justice members kept in the band, an owner's moved back", () => {
    // Respect 1,000; the wanted level that makes each share, (W − 1) / (1,000 + W): the bound 1/3, its half 1/6.
    const at = (share: number) => ({
      respect: 1_000,
      wantedLevel: (1_000 * share + 1) / (1 - share),
      wantedPenalty: 0.5,
    });
    const levels = [300, 250, 200];
    const reading = (tasks: string[], share: number) =>
      withGang(
        formed(
          levels.map((hack, index) => member(`member-0${index + 1}`, hack, tasks[index])),
          at(share),
        ),
      );
    const rule = new GangRule();
    const over = rule.update({
      mediumData: reading(["Plant Virus", "Plant Virus", "DDoS Attacks"], 0.4),
      slowData: slowData(2),
    });
    expect(over.gang?.tasks).toMatchObject({ "member-02": "Ethical Hacking", "member-03": "Ethical Hacking" });
    // Under the bound, over its half, the game showing them on justice: kept.
    const band = reading(["Plant Virus", "Ethical Hacking", "Ethical Hacking"], 0.32);
    expect(rule.update({ mediumData: band, slowData: slowData(2) }).gang?.tasks).toMatchObject({
      "member-02": "Ethical Hacking",
      "member-03": "Ethical Hacking",
    });
    // The same reading to a rule that didn't put them there (the owner did): back to work.
    expect(new GangRule().update({ mediumData: band, slowData: slowData(2) }).gang?.tasks).toMatchObject({
      "member-02": "Plant Virus",
      "member-03": "DDoS Attacks",
    });
    // Kept in the store: a restarted brain's rule keeps them where they are, with no extra swing.
    const settings = new Map<string, string>();
    const store = {
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: string) => settings.set(key, value),
    } as unknown as TelemetryStore;
    new GangRule(() => {}, store).update({
      mediumData: reading(["Plant Virus", "Plant Virus", "DDoS Attacks"], 0.4),
      slowData: slowData(2),
    });
    expect(JSON.parse(settings.get(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null")).toEqual(["member-02", "member-03"]);
    expect(new GangRule(() => {}, store).update({ mediumData: band, slowData: slowData(2) }).gang?.tasks).toMatchObject(
      {
        "member-02": "Ethical Hacking",
        "member-03": "Ethical Hacking",
      },
    );
    // Over the bound, the rule's own stay on justice as the wanted level falls, so the course back only shortens.
    const falling = reading(["Plant Virus", "Ethical Hacking", "Ethical Hacking"], 0.34);
    expect(rule.update({ mediumData: falling, slowData: slowData(2) }).gang?.tasks).toMatchObject({
      "member-02": "Ethical Hacking",
      "member-03": "Ethical Hacking",
    });
  });

  test("no slow snapshot (#365's review): the BitNode unknown, not another; the justice members and the faction kept, cleared in another BitNode", () => {
    const settings = new Map<string, string>();
    const store = {
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: string) => settings.set(key, value),
    } as unknown as TelemetryStore;
    const placed = () => JSON.parse(settings.get(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null");
    settings.set(GANG_PLACED_ON_JUSTICE_SETTING, JSON.stringify(["member-02", "member-03"]));
    // A restarted brain: its first updates come with no snapshots (the controller's constructor, an Agent's hello).
    const rule = new GangRule(() => {}, store);
    expect(rule.update({ mediumData: null, slowData: null })).toEqual({ intent: null, gang: null });
    expect(rule.view()).toMatchObject({ stage: "notManaged", line: "Gang: not managed (no slow snapshot yet)" });
    expect(placed()).toEqual(["member-02", "member-03"]);
    // Then the readings, in the band: the stored justice members kept there.
    const band = withGang(
      formed(
        [
          member("member-01", 300, "Plant Virus"),
          member("member-02", 250, "Ethical Hacking"),
          member("member-03", 200, "Ethical Hacking"),
        ],
        { respect: 1_000, wantedLevel: (1_000 * 0.32 + 1) / (1 - 0.32), wantedPenalty: 0.5 },
      ),
    );
    const onJustice = { "member-02": "Ethical Hacking", "member-03": "Ethical Hacking" };
    expect(rule.update({ mediumData: band, slowData: slowData(2) }).gang?.tasks).toMatchObject(onJustice);
    // An Agent's session ends or begins (the controller's snapshots cleared): waiting, the faction and members kept.
    expect(rule.update({ mediumData: null, slowData: null })).toEqual({ intent: null, gang: null });
    expect(rule.view()).toMatchObject({
      stage: "waiting",
      line: "Gang: waiting for a slow snapshot to say the BitNode",
    });
    expect(rule.gangFaction()).toBe("NiteSec");
    expect(rule.hiddenFactions()).toEqual(["NiteSec"]);
    expect(placed()).toEqual(["member-02", "member-03"]);
    expect(rule.update({ mediumData: band, slowData: slowData(2) }).gang?.tasks).toMatchObject(onJustice);
    // Another BitNode, read: everything cleared, the store's too.
    expect(rule.update({ mediumData: band, slowData: slowData(1) })).toEqual({ intent: null, gang: null });
    expect(rule.view().line).toBe("Gang: not managed (gangs play in BN2 only for now; this is BN1)");
    expect(rule.gangFaction()).toBeNull();
    expect(rule.hiddenFactions()).toEqual([]);
    expect(placed()).toEqual([]);
    // An Agent's session there ends: not managed, as before any slow snapshot (waiting only after BN2's).
    rule.update({ mediumData: null, slowData: null });
    expect(rule.view()).toMatchObject({ stage: "notManaged", line: "Gang: not managed (no slow snapshot yet)" });
  });

  test("in bonus time (over 2 s stored), more members to justice: the game's decay is slower a cycle", () => {
    const three = [member("member-01", 300), member("member-02", 200), member("member-03")];
    const figures = { respect: 1_000, wantedLevel: 800, wantedPenalty: 1_000 / 1_800 };
    const roles = (bonusTimeMs: number) => {
      const decision = new GangRule().update({
        mediumData: withGang(formed(three, { ...figures, bonusTimeMs })),
        slowData: slowData(2),
      });
      return three.map((each) => decision.gang?.tasks[each.name]);
    };
    expect(roles(1_800)).toEqual(["Plant Virus", "Ethical Hacking", "Ethical Hacking"]);
    expect(roles(60_000)).toEqual(["Ethical Hacking", "Ethical Hacking", "Ethical Hacking"]);
  });

  test("a reading whose figures aren't numbers is unread, never acted on", () => {
    const broken = { ...formed([member("member-01")]), members: [{ ...member("member-01"), hack: "9" }] };
    expect(gangSnapshotOf(withGang(broken as unknown as GangReading))).toMatchObject({ kind: "unread" });
    expect(gangSnapshotOf(withGang({ ...formed([]), gang: { ...NITESEC, respect: null } } as never))).toMatchObject({
      kind: "unread",
    });
    expect(gangSnapshotOf({ player: {} })).toEqual({ kind: "absent" });
    // A member with no ascension points (#328, G2): an Agent from before G2, whose reading the rule can't ascend from.
    const { hack_asc_points: _, ...noPoints } = member("member-01");
    expect(gangSnapshotOf(withGang({ ...formed([]), members: [noPoints] } as never))).toMatchObject({ kind: "unread" });
  });
});

describe("ascension (G2)", () => {
  test("the order carries the member's points as read, and is logged; with none, the line says when the next is", () => {
    const logs: string[] = [];
    const rule = new GangRule((line) => logs.push(line));
    // member-01 ascended before (5,000 points), with all of its experience since to gain from.
    const before = {
      ...member("member-01", 300, "Plant Virus"),
      hack_asc_points: 5_000,
      hack_asc_mult: Math.sqrt(2.5),
    };
    const three = [before, member("member-02"), member("member-03")];
    const decision = rule.update({ mediumData: withGang(formed(three, { respect: 4 })), slowData: slowData(2) });
    expect(decision.gang?.ascend).toEqual([{ name: "member-01", pointsBefore: 5_000 }]);
    expect(decision.gang?.tasks["member-01"]).toBe("Train Hacking");
    expect(logs.at(-1)).toMatch(/; ascending member-01 \(multipliers up to ×\d+\.\d\d, 0 respect lost\)$/);
    // Ascended: none can now (its experience reset, the others' under 1,000), and none in a day's work.
    const after = { ...before, ...gangMemberAscended(before) };
    const none = rule.update({
      mediumData: withGang(formed([after, ...three.slice(1)], { respect: 4 })),
      slowData: slowData(2),
    });
    expect(none.gang?.ascend).toEqual([]);
    expect(rule.view().line).toMatch(/; no ascension due within a day; territory /);
    // Trained to hacking 81, about 10 minutes from level 1: a few minutes' work on, it would.
    const nearly = [member("member-01", 81, "Ransomware"), ...three.slice(1)];
    rule.update({ mediumData: withGang(formed(nearly, { respect: 4 })), slowData: slowData(2) });
    expect(rule.view().line).toMatch(/; next ascension: member-01's, in about \d+ min; territory /);
  });
});

describe("the gang faction left out of the factions joined", () => {
  const slow = {
    ...slowData(2),
    factions: {
      backend: "sim" as const,
      state: {
        joined: [
          { name: "CyberSec", reputation: 10, favor: 0 },
          { name: "NiteSec", reputation: 0, favor: 0 },
        ],
        invitations: [],
        queuedAugmentations: [],
      },
      problem: null,
    },
  };

  test("with a gang: its faction goes, the rest stays; the slow snapshot itself untouched", () => {
    const without = withoutGangFaction(slow, ["NiteSec"]);
    expect(without?.factions?.state?.joined.map((each) => each.name)).toEqual(["CyberSec"]);
    expect(without?.resetInfo).toBe(slow.resetInfo);
    expect(slow.factions.state.joined).toHaveLength(2);
  });

  test("with none, or a faction not joined, or no snapshot: as it is", () => {
    expect(withoutGangFaction(slow, [])).toBe(slow);
    expect(withoutGangFaction(slow, ["The Black Hand"])).toBe(slow);
    expect(withoutGangFaction(null, ["NiteSec"])).toBeNull();
    // Every gang faction held out (BN2 before the first reading): the others stay.
    expect(withoutGangFaction(slow, GANG_FACTIONS)?.factions?.state?.joined.map((each) => each.name)).toEqual([
      "CyberSec",
    ]);
  });
});

describe("the gate's guard on forming", () => {
  test("the faction joined, as the game requires; else held, saying why", () => {
    expect(snapshotGuardFailure(FORM_NITESEC, mediumData(1, {}, { factions: ["NiteSec"] }), null)).toBeNull();
    expect(snapshotGuardFailure(FORM_NITESEC, mediumData(1, {}, { factions: ["CyberSec"] }), null)).toBe(
      "NiteSec isn't joined",
    );
    expect(snapshotGuardFailure(FORM_NITESEC, { ...mediumData(1, {}), player: {} }, null)).toBe(
      "the medium snapshot has no list of the factions joined",
    );
  });
});

describe("the run report's section", () => {
  /** A fold over a BN2 window: a slow snapshot, then a medium one every 10 s from `readings`, one per step. */
  function fold(readings: (MediumSnapshotData | null)[], bitNode = 2) {
    const gang = new GangFold();
    gang.addSlow(0, slowData(bitNode));
    readings.forEach((data, index) => {
      if (data !== null) gang.addMedium(index * 10_000, data);
    });
    const failures: string[] = [];
    const lines = gang.section(failures, readings.length * 10_000);
    return { text: lines.join("\n"), failures };
  }
  const repeat = <Value>(value: Value, count: number) => Array.from({ length: count }, () => value);
  const steps = (ms: number) => Math.ceil(ms / 10_000) + 1;

  test("outside BN2: no gang played, nothing judged", () => {
    expect(fold([withGang(NONE)], 1)).toEqual({
      text: "7. The gang (#325, ascension G2, equipment G3, territory G4, its faction's shop G5; played in BN2 only for now)\n  not in BN2 in the window: no gang played",
      failures: [],
    });
  });

  test("a gang that forms and grows: when, by hour, and no failure", () => {
    const three = [member("member-01", 100, "Phishing"), member("member-02", 100), member("member-03", 100)];
    const { text, failures } = fold([
      withGang(NONE),
      withGang(formed([])),
      withGang(formed(three, { respect: 30, wantedLevel: 2, wantedPenalty: 30 / 32, moneyGainRate: 10 })),
    ]);
    expect(failures).toEqual([]);
    expect(text).toContain("  formed: with NiteSec, first seen 1970-01-01T00:00:10.000Z");
    expect(text).toMatch(/\n {4}hour 1: 0 → 3 members; respect 1 → 30 \(2\.90\/s\); \$25\/s on average; /);
    expect(text).toContain(
      "wanted penalty 50.0% → 6.3%, above its floor at most 3.1% (the bound then 33.3%, at 3 members)",
    );
  });

  test("the gang's faction (#334): its reputation, what was bought there, and The Red Pill's route", () => {
    const gang = new GangFold();
    const slow = (queued: string[], ownedAugs: Record<string, number> = {}): SlowSnapshotData => ({
      ...slowData(2),
      resetInfo: { ...slowData(2).resetInfo, ownedAugs },
      gangFaction: "NiteSec",
      factions: {
        backend: "sim",
        state: {
          joined: [{ name: "NiteSec", reputation: 123_456.7, favor: 12.34 }],
          invitations: [],
          queuedAugmentations: queued,
        },
        problem: null,
      },
    });
    gang.addSlow(0, slow([]));
    gang.addMedium(10_000, withGang(formed([])));
    const bought = (augmentation: string, faction = "NiteSec"): StoredEvent => ({
      atMs: 20_000,
      kind: "augmentationBought",
      detail: { augmentation, faction, level: 1, price: 1 },
    });
    const events = [bought("BitWire", "CyberSec"), bought("Augmented Targeting I"), bought("Neurotrainer II")];
    const text = gang.section([], 30_000, events).join("\n");
    expect(text).toContain(
      "\n  the gang's faction (#334), its shop nearly every augmentation: NiteSec, reputation 123,457, favour 12.3 at " +
        "the window's last slow snapshot; bought there in the window: 2 (Augmented Targeting I, Neurotrainer II)\n" +
        "  the gang's faction's reputation by hour, at its slow snapshots: hour 1 123,457 → 123,457\n" +
        "  The Red Pill's route: from NiteSec, the gang's faction, no Daedalus needed in BN2; its reputation 123,457 of " +
        "2,500,000, its estimate unread (no game time) (section 3's path fails if it's reached and not installed)\n",
    );
    // By hour, and the estimate at the cycle's rate from the snapshot's game time (#335's review): 123,457 in 10
    // minutes since the install, the rest in 192.5 min (formatDuration: 3 h 12 min).
    const timed = new GangFold();
    for (const [atMs, reputation] of [
      [0, 1_000],
      [1_800_000, 5_000],
      [3_600_000, 9_000],
      [5_400_000, 123_456.7],
    ] as const) {
      const each = slow([]);
      const state = each.factions?.state;
      if (!state) throw new Error("no state");
      timed.addSlow(
        atMs,
        {
          ...each,
          factions: { ...each.factions, state: { ...state, joined: [{ name: "NiteSec", reputation, favor: 0 }] } },
        } as SlowSnapshotData,
        600_000,
      );
    }
    timed.addMedium(10_000, withGang(formed([])));
    const timedText = timed.section([], 30_000).join("\n");
    expect(timedText).toContain(
      "  the gang's faction's reputation by hour, at its slow snapshots: hour 1 1,000 → 5,000; hour 2 9,000 → 123,457\n",
    );
    expect(timedText).toContain(
      "; its reputation 123,457 of 2,500,000, about 3 h 12 min more at the cycle's rate (section 3's path fails",
    );
    const routeOf = (each: GangFold, events: StoredEvent[] = []) =>
      each.section([], 30_000, events).find((line) => line.startsWith("  The Red Pill's route"));
    expect(routeOf(gang, [bought("The Red Pill")])).toMatch(/; bought$/);
    gang.addSlow(20_000, slow(["The Red Pill"]));
    expect(routeOf(gang)).toMatch(/; queued, to install$/);
    gang.addSlow(25_000, slow([], { "The Red Pill": 1 }));
    expect(routeOf(gang)).toMatch(/; installed$/);
    // No slow snapshot showing the gang's faction: said.
    const unshown = new GangFold();
    unshown.addSlow(0, slowData(2));
    unshown.addMedium(10_000, withGang(formed([])));
    expect(unshown.section([], 30_000)).toContain("  the gang's faction: not shown by a slow snapshot in the window");
  });

  describe("BN2's route (#357)", () => {
    /** Twelve grown hackers (no ascension or equipment due), on Cyberterrorism: made in the tests, after the file's. */
    const twelve = () =>
      Array.from({ length: 12 }, (_, index) =>
        grownHacker(`member-${String(index + 1).padStart(2, "0")}`, { task: "Cyberterrorism", upgrades: [] }),
      );
    /** A medium snapshot of the gang of 12, the player's `faction_rep` read. */
    /** The `index`-th reading of the gang of 12: its respect rising, as working members' does (#354's stalls). */
    const atTwelve = (index: number): MediumSnapshotData => {
      const respect = 2e6 + index * 1e8;
      const data = withGang(formed(twelve(), { respect, wantedLevel: 1, wantedPenalty: respect / (respect + 1) }));
      data.player = { ...data.player, mults: { faction_rep: 1 } };
      return data;
    };
    /** BN2's slow snapshot with NiteSec, the gang's faction, at 0 of The Red Pill's 2.5m. */
    const niteSec: SlowSnapshotData = {
      ...slowData(2),
      gangFaction: "NiteSec",
      factions: {
        backend: "sim",
        state: { joined: [{ name: "NiteSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
        problem: null,
      },
    };
    const chosenEvent = (atMs: number, objective: string, fields: Record<string, unknown> = {}): StoredEvent => ({
      atMs,
      kind: "gangObjectiveChosen",
      detail: {
        objective,
        reason: "estimates",
        members: 12,
        respect: { respectPerCycle: 50, reputationPerSecond: 3.3, etaMs: 7.5e8 },
        money: { respectPerCycle: 5, reputationPerSecond: 0.33, etaMs: 7.5e9 },
        reputation: 0,
        favor: 0,
        factionRep: 1,
        needed: 2.5e6,
        ...fields,
      },
    });
    /** A fold of `count` readings of the gang of 12, 10 s apart, judged with `events`. */
    function judged(count: number, events: StoredEvent[] = [], before: StoredEvent[] = []) {
      const gang = new GangFold();
      gang.addSlow(0, niteSec);
      for (let index = 0; index < count; index += 1) gang.addMedium(index * 10_000, atTwelve(index));
      const failures: string[] = [];
      const text = gang.section(failures, count * 10_000, events, before).join("\n");
      return { text, failures };
    }

    test("(2) at 12 with no objective from the brain: 10 minutes, added up, fail; 9 min 50 s don't", () => {
      expect(judged(60).failures).toEqual([]);
      const { failures, text } = judged(61);
      expect(failures).toEqual([
        "at 12 members with no objective from the brain for 10 min online, added up (#357's (2))",
      ]);
      expect(text).toContain(
        "  the objective at 12 members (#357), the brain's as chosen:\n    none chosen in the window\n",
      );
      // The brain's event, in the window or the day before: none.
      expect(judged(61, [chosenEvent(0, "respect")]).failures).toEqual([]);
      expect(judged(61, [], [chosenEvent(-60_000, "respect")]).failures).toEqual([]);
    });

    test("(2) the brain's objective against core's from the snapshots: a minute apart fails, under it not", () => {
      // Core's is respect here (NiteSec at 0 of 2.5m, twelve at hacking 1,000).
      const steps = Math.ceil(GANG_OBJECTIVE_DIFFERS_WITHIN_MS / 10_000) + 1;
      expect(judged(steps - 1, [chosenEvent(0, "money")]).failures).toEqual([]);
      const { failures, text } = judged(steps, [chosenEvent(0, "money")]);
      expect(failures).toEqual([
        expect.stringMatching(
          /^the objective at 12 differing from core's for 1 min, from 1970-01-01T00:00:00\.000Z to 1970-01-01T00:01:00\.000Z \(the brain's money, core's respect, The Red Pill in /,
        ),
      ]);
      expect(text).toContain(
        "    1970-01-01T00:00:00.000Z: money, The Red Pill in respect's 208.3 h, money's 2083.3 h\n",
      );
      expect(judged(steps, [chosenEvent(0, "respect")]).failures).toEqual([]);
    });

    test("(2) an objective at 12 without its estimates fails; The Red Pill's money needs none", () => {
      const { failures } = judged(3, [chosenEvent(0, "respect", { money: null })]);
      expect(failures).toEqual(["the objective at 12 without its estimates: respect at 1970-01-01T00:00:00.000Z"]);
      const owned = chosenEvent(0, "money", { reason: "The Red Pill owned", respect: null, money: null });
      // Core's from these snapshots is respect (The Red Pill not queued): the difference, under a minute, passes.
      expect(judged(3, [owned]).failures).toEqual([]);
    });

    test("(1) an install chosen in BN2 before the gang, avmnite-02h's level read, without the route's estimates fails", () => {
      const install = (atMs: number, timing: unknown = undefined): StoredEvent => ({
        atMs,
        kind: "augmentationInstallChosen",
        detail: { reason: "Daedalus's count", ...(timing === undefined ? {} : { timing }) },
      });
      const fold = (level: boolean) => {
        const gang = new GangFold();
        if (level) gang.addStatic(0, { servers: [staticServer("avmnite-02h", { requiredHackingSkill: 218 })] });
        gang.addSlow(0, slowData(2));
        gang.addMedium(10_000, withGang(NONE));
        gang.addMedium(20_000, withGang(NONE));
        gang.addMedium(60_000, withGang(formed([])));
        return gang;
      };
      const failuresOf = (gang: GangFold, events: StoredEvent[]) => {
        const failures: string[] = [];
        gang.section(failures, 70_000, events);
        return failures;
      };
      const routed = { route: "gang forming", gang: { installNowMs: 6_000_000, waitMs: 7_000_000 } };
      expect(failuresOf(fold(true), [install(30_000)])).toEqual([
        "install chosen in BN2 before the gang without the planner's estimates: at 1970-01-01T00:00:30.000Z, " +
          "avmnite-02h's level read, its reason Daedalus's count",
      ]);
      // With the route's estimates, after the gang, or with the level unread: none.
      expect(failuresOf(fold(true), [install(30_000, routed)])).toEqual([]);
      expect(failuresOf(fold(true), [install(65_000)])).toEqual([]);
      expect(failuresOf(fold(false), [install(30_000)])).toEqual([]);
    });
  });

  test("a gang faction joined and no gang formed for 5 min fails; under it, it doesn't", () => {
    expect(fold(repeat(withGang(NONE), steps(GANG_FORM_WITHIN_MS) - 1)).failures).toEqual([]);
    const { failures, text } = fold(repeat(withGang(NONE), steps(GANG_FORM_WITHIN_MS)));
    expect(failures).toEqual([
      "no gang formed with a gang faction joined for 5 min, from 1970-01-01T00:00:00.000Z to " +
        "1970-01-01T00:05:00.000Z (NiteSec joined)",
    ]);
    expect(text).toContain("  formed: no; NiteSec joined since 1970-01-01T00:00:00.000Z");
    // With none of the seven joined, nothing to fail.
    expect(fold(repeat(withGang(NONE, ["CyberSec"]), 40)).failures).toEqual([]);
  });

  test("a recruit the respect allows not made for a minute fails", () => {
    const three = [member("member-01"), member("member-02"), member("member-03")];
    const ready = withGang(formed(three, { respect: 6 }));
    expect(fold(repeat(ready, steps(GANG_RECRUIT_WITHIN_MS) - 1)).failures).toEqual([]);
    expect(fold(repeat(ready, steps(GANG_RECRUIT_WITHIN_MS))).failures).toEqual([
      "a recruit the respect allows not made for 1 min, from 1970-01-01T00:00:00.000Z to 1970-01-01T00:01:00.000Z " +
        "(1 allowed at 3 members, respect 6)",
    ]);
  });

  test("the wanted penalty over the rule's bound, off course, for 23 min fails; on course, or all on justice, it doesn't", () => {
    // (4 − 1) / (4 + 4) = 37.5%, just over 1/3 (back at the bound at wanted 3); 4 respect, short of the fourth
    // recruit; members at level 1, whose tasks add no wanted. None on justice: off course, the rule's to fix.
    const three = [member("member-01"), member("member-02"), member("member-03")];
    const figures = { respect: 4, wantedLevel: 4, wantedPenalty: 0.5 };
    const wanted = withGang(formed(three, figures));
    // One on Ethical Hacking: its decay alone brings 4 to 2 in the 23 min, on course, the others' tasks as they are.
    const onCourse = withGang(
      formed([{ ...member("member-01"), task: "Ethical Hacking" }, ...three.slice(1)], figures),
    );
    expect(fold(repeat(onCourse, steps(GANG_WANTED_OUTCOME_MS) - 1)).failures).toEqual([]);
    // The outcome check (#325's review), whatever the forecast: held there, on course by the forecast but not back
    // (a forecast wrong, as bonus time's slower decay makes it), over the bound with a member off justice, for the
    // recovery time and half again: a failure.
    expect(GANG_WANTED_OUTCOME_MS).toBeCloseTo(1.5 * GANG_WANTED_OVER_BOUND_MS, 9);
    // At wanted 6 (50%; back at the bound at 3.5), one on justice is on course in normal time (6 halves to 3), not in
    // bonus time: the decay 2.5 times slower a cycle leaves 4.5.
    const oneOnJustice = [{ ...member("member-01"), task: "Ethical Hacking" }, ...three.slice(1)];
    const higher = { respect: 4, wantedLevel: 6, wantedPenalty: 0.4 };
    expect(fold(repeat(withGang(formed(oneOnJustice, higher)), steps(GANG_WANTED_OVER_BOUND_MS))).failures).toEqual([]);
    // The rule puts member-02 on justice too, which the readings don't show: off its task as well (#354).
    const inBonusTime = withGang(formed(oneOnJustice, { ...higher, bonusTimeMs: 60_000 }));
    expect(fold(repeat(inBonusTime, steps(GANG_WANTED_OVER_BOUND_MS))).failures).toEqual([
      expect.stringMatching(/^the wanted penalty over the rule's bound, off course, for 23 min 10 s, /),
      expect.stringMatching(
        /^a member off the rule's task for 23 min 10 s, .* \(member-02 on Train Hacking, the rule's Ethical Hacking\)$/,
      ),
    ]);
    expect(fold(repeat(onCourse, steps(GANG_WANTED_OUTCOME_MS))).failures).toEqual([
      expect.stringMatching(
        /^the wanted penalty over the rule's bound with a member off justice for 34 min 40 s, from .* \(37\.5% over 33\.3%, wanted 4, 1 of 3 on justice\)$/,
      ),
    ]);
    // Far over with every member on justice: all the game allows, however long the decay takes.
    const allOnJustice = three.map((each) => ({ ...each, task: "Ethical Hacking" }));
    const far = withGang(formed(allOnJustice, { respect: 4, wantedLevel: 4_000, wantedPenalty: 0.001 }));
    expect(fold(repeat(far, 2 * steps(GANG_WANTED_OVER_BOUND_MS))).failures).toEqual([]);
    // None on justice where the rule puts member-01 there: off its task too (#354), but the wanted's own bound is this.
    const wantedOf = (failures: string[]) => failures.filter((each) => each.startsWith("the wanted penalty"));
    expect(wantedOf(fold(repeat(wanted, steps(GANG_WANTED_OVER_BOUND_MS) - 1)).failures)).toEqual([]);
    const { failures } = fold(repeat(wanted, steps(GANG_WANTED_OVER_BOUND_MS)));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(
      /^the wanted penalty over the rule's bound, off course, for 23 min 10 s, from .* \(37\.5% over 33\.3%, wanted 4, 0 of 3 on justice, off course\)$/,
    );
    expect(failures[1]).toMatch(
      /^a member off the rule's task for 23 min 10 s, .* \(member-01 on Train Hacking, the rule's Ethical Hacking\)$/,
    );
  });

  test("ascensions (G2) by hour, each with its gain and the respect it had earned; one the rule makes undone for 1 min fails", () => {
    // member-01 never ascended, its levels all experience: the rule ascends it (respect 4: no recruit due), and has it
    // train after, as it does.
    const ready = { ...member("member-01", 300), earnedRespect: 12 };
    const others = [member("member-02"), member("member-03")];
    const due = withGang(formed([ready, ...others], { respect: 4 }));
    expect(fold(repeat(due, steps(GANG_ASCEND_WITHIN_MS) - 1)).failures).toEqual([]);
    const { failures } = fold(repeat(due, steps(GANG_ASCEND_WITHIN_MS)));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^an ascension the rule makes not made for 1 min, from 1970-01-01T00:00:00\.000Z to 1970-01-01T00:01:00\.000Z \(member-01's, multipliers up to ×\d+\.\d\d, a gain of [\d,]+ over a cost of 12 in /,
    );
    // Made on the third reading: none fails, and the hour's line lists it, its gain the multiplier's rise.
    const ascended = { ...ready, ...gangMemberAscended(ready) };
    const made = withGang(formed([ascended, ...others], { respect: 1 }));
    const { text, failures: none } = fold([due, due, ...repeat(made, steps(GANG_ASCEND_WITHIN_MS) * 2)]);
    expect(none).toEqual([]);
    const gain = ascended.hack_asc_mult.toFixed(2);
    expect(text).toContain(`; 1 ascension (member-01 ×${gain}, 12 respect)`);
    expect(fold(repeat(made, 3)).text).toContain("; no ascensions");
    // Two due, one ascension a reading's run: each ascension starts the wait again, so two made 30 s apart pass.
    const second = { ...ready, name: "member-02" };
    const both = withGang(formed([ready, second, others[1] as GangMemberReading], { respect: 4 }));
    const firstMade = withGang(formed([ascended, second, others[1] as GangMemberReading], { respect: 1 }));
    const secondMade = withGang(
      formed([ascended, { ...second, ...gangMemberAscended(second) }, others[1] as GangMemberReading], { respect: 1 }),
    );
    const paced = fold([...repeat(both, 3), ...repeat(firstMade, 4), ...repeat(secondMade, 3)]);
    expect(paced.failures).toEqual([]);
    expect(paced.text).toContain("; 2 ascensions (member-01 ×");
  });

  test("an owner's member named past what the protocol takes is never an ascension due (#328's review)", () => {
    const longName = { ...member("x".repeat(65), 300, "Plant Virus"), earnedRespect: 0 };
    const reading = withGang(formed([longName, member("member-02"), member("member-03")], { respect: 4 }));
    const { failures } = fold(repeat(reading, steps(GANG_ASCEND_WITHIN_MS) * 2));
    expect(failures).toEqual([]);
  });

  test("the gang unread in BN2 for 5 min fails: no reading, or the worker's problem", () => {
    expect(fold(repeat(withGang(undefined), steps(GANG_UNREAD_WITHIN_MS))).failures).toEqual([
      "the gang unread in BN2 for 5 min, from 1970-01-01T00:00:00.000Z to 1970-01-01T00:05:00.000Z (no gang " +
        "reading in the medium snapshot)",
    ]);
    const unread = withGang({ gang: null, members: [], problems: ["the gang state isn't one to do"] });
    expect(fold(repeat(unread, steps(GANG_UNREAD_WITHIN_MS))).failures[0]).toContain(
      "(the gang state isn't one to do)",
    );
  });

  test("the reports carry the gang's faction within a BitNode past an Agent start's first slow snapshot", () => {
    const carry = new GangFactionCarry();
    const bn2 = (gangFaction: string | null | undefined, lastNodeReset = 0) => ({
      ...slowData(2),
      resetInfo: { ...slowData(2).resetInfo, lastNodeReset },
      ...(gangFaction === undefined ? {} : { gangFaction }),
    });
    expect(carry.of(bn2(null)).gangFaction).toBeNull();
    expect(carry.of(bn2("NiteSec")).gangFaction).toBe("NiteSec");
    // A new Agent's first: null, or absent from an older one; carried.
    expect(carry.of(bn2(null)).gangFaction).toBe("NiteSec");
    expect(carry.of(bn2(undefined)).gangFaction).toBe("NiteSec");
    // Another BitNode (a destroy into BN2 again): none carried.
    expect(carry.of(bn2(null, 99)).gangFaction).toBeNull();
  });

  test("the gang's faction takes no donations in the reports: the slow snapshot's gangFaction (#325's review)", () => {
    const favoured = { reputation: 0, favor: 200 };
    expect(donationStatus("NiteSec", favoured, slowData(2))).toBe("; donations unlocked");
    expect(donationStatus("NiteSec", favoured, { ...slowData(2), gangFaction: "NiteSec" })).toBe("");
    expect(donationStatus("CyberSec", favoured, { ...slowData(2), gangFaction: "NiteSec" })).toBe(
      "; donations unlocked",
    );
  });

  test("the worker's problems are listed as first seen; one in every reading for a minute fails (#354), not under it", () => {
    const problem = "the game didn't set member-01 to Nap";
    // Three: no recruit allowed at respect 1.
    const three = [member("member-01"), member("member-02"), member("member-03")];
    const refused = withGang({ ...formed(three), problems: [problem] });
    const { text, failures } = fold([refused, refused]);
    expect(text).toContain("    1970-01-01T00:00:00.000Z: the game didn't set member-01 to Nap");
    expect(failures).toEqual([]);
    expect(fold(repeat(refused, steps(GANG_PROBLEM_WITHIN_MS) - 1)).failures).toEqual([]);
    expect(fold(repeat(refused, steps(GANG_PROBLEM_WITHIN_MS))).failures).toEqual([
      "a gang worker's problem in every reading for 1 min, from 1970-01-01T00:00:00.000Z to 1970-01-01T00:01:00.000Z " +
        `(${problem})`,
    ]);
    // Gone a reading in between: each passes, however long, another problem in its place not keeping it going.
    const other = withGang({ ...formed(three), problems: ["the game didn't recruit member-04"] });
    const flickering = Array.from({ length: 3 * steps(GANG_PROBLEM_WITHIN_MS) }, (_, index) =>
      index % 2 === 0 ? other : refused,
    );
    expect(fold(flickering).failures).toEqual([]);
    // Nor one across a reading with no gang (unread): each side is under the minute.
    const half = Math.ceil(steps(GANG_PROBLEM_WITHIN_MS) / 2);
    expect(fold([...repeat(refused, half), withGang(undefined), ...repeat(refused, half)]).failures).toEqual([]);
  });

  test("a member off the rule's task for a minute fails (#354); under it, an owner's member, or a plan just changed, not", () => {
    // Level 1: the rule has each train. member-01 left Unassigned: the worker sets it every run, the game refusing.
    const off = withGang(formed([member("member-01", 1, "Unassigned"), member("member-02"), member("member-03")]));
    expect(fold(repeat(off, steps(GANG_TASK_WITHIN_MS) - 1)).failures).toEqual([]);
    expect(fold(repeat(off, steps(GANG_TASK_WITHIN_MS))).failures).toEqual([
      "a member off the rule's task for 1 min, from 1970-01-01T00:00:00.000Z to 1970-01-01T00:01:00.000Z " +
        "(member-01 on Unassigned, the rule's Train Hacking)",
    ]);
    // Set on the third reading: none.
    const on = withGang(formed([member("member-01"), member("member-02"), member("member-03")]));
    expect(fold([off, off, ...repeat(on, 2 * steps(GANG_TASK_WITHIN_MS))]).failures).toEqual([]);
    // Moved off it after two readings on: from the reading before, whose order the worker had to set since.
    expect(fold([on, on, ...repeat(off, steps(GANG_TASK_WITHIN_MS) - 2)]).failures).toEqual([]);
    expect(fold([on, on, ...repeat(off, steps(GANG_TASK_WITHIN_MS) - 1)]).failures).toEqual([
      "a member off the rule's task for 1 min, from 1970-01-01T00:00:10.000Z to 1970-01-01T00:01:10.000Z " +
        "(member-01 on Unassigned, the rule's Train Hacking)",
    ]);
    // The rule's justice member kept on justice in the band (the share between half the bound and the bound), as the
    // brain keeps it (#325's hysteresis): at wanted 2.5, (2.5 − 1) / (4 + 2.5) = 23%, the bound 1/3.
    const kept = withGang(
      formed([member("member-01", 1, "Ethical Hacking"), member("member-02"), member("member-03")], {
        respect: 4,
        wantedLevel: 2.5,
      }),
    );
    expect(fold(repeat(kept, 2 * steps(GANG_TASK_WITHIN_MS))).failures).toEqual([]);
    // An owner's member named past what the protocol takes is the owner's: the brain never sets it.
    const owners = withGang(
      formed([member("x".repeat(65), 1, "Unassigned"), member("member-02"), member("member-03")]),
    );
    expect(fold(repeat(owners, 2 * steps(GANG_TASK_WITHIN_MS))).failures).toEqual([]);
  });

  test("the respect flat with the rule's members working for a minute fails (#354): under a process's worth a reading", () => {
    // 12 members (money): the grown hacker on Money Laundering, by the rule; the others training. The respect a
    // process its plan expects, by the formulas, at each reading's respect.
    const members = twelveWith(grownHacker("member-01"));
    const reading = (respect: number) => withGang(formed(members, { ...GROWN_GANG, respect }));
    const perProcess = (respect: number) => {
      const gang = { ...NITESEC, ...GROWN_GANG, respect };
      const plan = planGang({ gang, isHacking: true, members, softcap: gangSoftcapOf(2) });
      expect(plan.assignments[0]).toMatchObject({ task: "Money Laundering", role: "working" });
      return gangPlannedRespectPerCycle({ gang, members, plan, softcap: gangSoftcapOf(2) }) * GANG_CYCLES_PER_PROCESS;
    };
    // Each reading's respect risen by its plan's process's worth, × `share`: just over, just under it.
    const rising = (share: number, count: number) => {
      const respects = [GROWN_GANG.respect];
      while (respects.length < count) {
        const last = respects.at(-1) as number;
        respects.push(last + perProcess(last) * share);
      }
      return respects.map(reading);
    };
    expect(perProcess(GROWN_GANG.respect)).toBeGreaterThan(0);
    expect(fold(rising(1 + 1e-9, 2 * steps(GANG_RESPECT_FLAT_WITHIN_MS))).failures).toEqual([]);
    expect(fold(rising(1 - 1e-9, steps(GANG_RESPECT_FLAT_WITHIN_MS) - 1)).failures).toEqual([]);
    const { failures } = fold(rising(1 - 1e-9, steps(GANG_RESPECT_FLAT_WITHIN_MS)));
    expect(failures).toEqual([
      expect.stringMatching(
        /^the gang's respect flat with the rule's members working for 1 min, from 1970-01-01T00:00:00\.000Z to 1970-01-01T00:01:00\.000Z \(respect 2,000,000, the rule's tasks expected to earn [\d.e+]+\/s \(1 working\)\)$/,
      ),
    ]);
    // Flat outright, but a fall between (an ascension's or a death's, the only ways down): not judged across it.
    const flat = reading(GROWN_GANG.respect);
    const fell = reading(GROWN_GANG.respect - 1_000);
    const half = Math.ceil(steps(GANG_RESPECT_FLAT_WITHIN_MS) / 2);
    expect(fold([...repeat(flat, half), fell, ...repeat(fell, half)]).failures).toEqual([]);
    expect(fold(repeat(flat, steps(GANG_RESPECT_FLAT_WITHIN_MS))).failures).toHaveLength(1);
    // With the rule's members all training (under 12, the grown hacker trains as it would): nothing expected, none.
    const training = withGang(formed([member("member-01"), member("member-02"), member("member-03")]));
    expect(fold(repeat(training, 2 * steps(GANG_RESPECT_FLAT_WITHIN_MS))).failures).toEqual([]);
  });
});

describe("the gang's silent stalls (#354)", () => {
  const steps = (ms: number) => Math.ceil(ms / 10_000) + 1;
  /** A plan with each member's task (`working` roles), and `recruit`. */
  const planOf = (tasks: Record<string, string>, recruit: string[] = []): GangPlan => ({
    objective: "respect",
    assignments: Object.entries(tasks).map(([name, task]) => ({
      name,
      task,
      role: "working",
      value: 1,
      bestTask: task,
      nextAscensionMs: 0,
    })),
    recruit,
    lostShare: 0,
    bound: 1,
    ascend: null,
    warfare: null,
  });
  const at = (atMs: number, task: string, plan: GangPlan, respect = 1): GangStallReading => ({
    atMs,
    gang: { ...NITESEC, respect },
    members: [member("member-01", 1, task)],
    problems: [],
    plan,
    softcap: 1,
  });

  test("a plan that moves a member back and forth each reading, the worker a reading behind, is no stall", () => {
    const phishing = planOf({ "member-01": "Phishing" });
    const training = planOf({ "member-01": "Train Hacking" });
    const watch = new GangStallWatch();
    for (let index = 0; index < 20; index += 1) {
      const [plan, task] = index % 2 === 0 ? [phishing, "Train Hacking"] : [training, "Phishing"];
      watch.add(at(index * 10_000, task, plan));
    }
    expect(watch.open()).toEqual([]);
    // On the plan's task: none, at a first reading too.
    expect(gangStallsAt(null, at(0, "Phishing", phishing))).toEqual([]);
    expect(gangStallsAt(null, at(0, "Unassigned", phishing))).toHaveLength(1);
    // Held: the order of the reading before not done, nor this one's.
    expect(gangStallsAt(at(0, "Unassigned", phishing), at(10_000, "Unassigned", phishing))).toEqual([
      { key: "task:member-01", kind: "task", fromMs: 0, detail: "member-01 on Unassigned, the rule's Phishing" },
    ]);
    // A recruit the plan before made, set to train at once: off it, held.
    const recruiting = planOf({}, ["member-01"]);
    expect(gangStallsAt(at(0, "Unassigned", recruiting), at(10_000, "Unassigned", phishing))).toHaveLength(1);
    expect(gangStallsAt(at(0, "Unassigned", recruiting), at(10_000, "Train Hacking", phishing))).toEqual([]);
  });

  test("the respect is judged only across two of the game's processes (4 s) or more: one is the least it adds", () => {
    const phishing = planOf({ "member-01": "Phishing" });
    const before = { ...at(0, "Phishing", phishing), members: [member("member-01", 100, "Phishing")] };
    const now = (atMs: number) => ({ ...before, atMs });
    expect(gangPlannedRespectPerCycle(before)).toBeGreaterThan(0);
    expect(gangStallsAt(before, now(3_999))).toEqual([]);
    expect(gangStallsAt(before, now(4_000))).toEqual([expect.objectContaining({ key: "respect", fromMs: 0 })]);
    // Judged on the plan at the reading before, whose tasks were worked since: this one's training changes nothing.
    const training = planOf({ "member-01": "Train Hacking" });
    expect(gangStallsAt(before, { ...now(10_000), plan: training })).toEqual([
      expect.objectContaining({ key: "respect" }),
    ]);
    expect(gangStallsAt({ ...before, plan: training }, now(10_000))).toEqual([]);
  });

  test("the live watch (the dashboard's): stalls past their bound, each medium snapshot once", () => {
    const rule = new GangRule();
    const off = withGang(formed([member("member-01", 1, "Unassigned"), member("member-02"), member("member-03")]));
    const readings = Array.from({ length: steps(GANG_TASK_WITHIN_MS) - 1 }, () => ({ ...off }));
    readings.forEach((mediumData, index) => {
      rule.update({ mediumData, slowData: slowData(2), mediumAtMs: index * 10_000 });
    });
    expect(rule.stalls()).toEqual([]);
    // The same snapshot decided on again, later: not a reading more.
    rule.update({ mediumData: readings.at(-1) as MediumSnapshotData, slowData: slowData(2), mediumAtMs: 60_000 });
    expect(rule.stalls()).toEqual([]);
    rule.update({ mediumData: { ...off }, slowData: slowData(2), mediumAtMs: 60_000 });
    expect(rule.stalls()).toEqual([
      {
        kind: "task",
        fromMs: 0,
        toMs: 60_000,
        detail: "member-01 on Unassigned, the rule's Train Hacking",
      },
    ]);
    // Out of BN2 (a destroy): none.
    rule.update({ mediumData: { ...off }, slowData: slowData(1), mediumAtMs: 70_000 });
    expect(rule.stalls()).toEqual([]);
  });

  test("the live watch starts again after a reading with no gang (#364's review): unread, or absent", () => {
    const off = withGang(formed([member("member-01", 1, "Unassigned"), member("member-02"), member("member-03")]));
    for (const gap of [
      withGang({ gang: null, members: [], problems: ["the gang state isn't one to do"] }),
      withGang(undefined),
    ]) {
      const rule = new GangRule();
      const read = (mediumData: MediumSnapshotData, mediumAtMs: number) =>
        rule.update({ mediumData: { ...mediumData }, slowData: slowData(2), mediumAtMs });
      for (const atMs of [0, 10_000, 20_000, 30_000]) read(off, atMs);
      read(gap, 40_000);
      expect(rule.stalls()).toEqual([]);
      // From the first reading after it: 50 s at 100 s, a minute at 110 s.
      for (const atMs of [50_000, 60_000, 70_000, 80_000, 90_000, 100_000]) read(off, atMs);
      expect(rule.stalls()).toEqual([]);
      read(off, 110_000);
      expect(rule.stalls()).toEqual([expect.objectContaining({ kind: "task", fromMs: 50_000, toMs: 110_000 })]);
    }
  });

  test("a gap in the readings (over 30 s, `MEDIUM_SNAPSHOT_GAP_MS`) ends every stretch (#364's review)", () => {
    expect(MEDIUM_SNAPSHOT_GAP_MS).toBe(30_000);
    // A thinned store's minute apart, or a degraded medium tier: a member off its task, and the respect flat with the
    // grown hacker on Money Laundering, at every reading. None judged across a gap.
    const off = withGang(formed([member("member-01", 1, "Unassigned"), member("member-02"), member("member-03")]));
    const flat = withGang(formed(twelveWith(grownHacker("member-01")), GROWN_GANG));
    const sparse = (data: MediumSnapshotData, everyMs: number, count: number) => {
      const gang = new GangFold();
      gang.addSlow(0, slowData(2));
      for (let index = 0; index < count; index += 1) gang.addMedium(index * everyMs, data);
      const failures: string[] = [];
      gang.section(failures, count * everyMs);
      return failures;
    };
    expect(sparse(off, 60_000, 10)).toEqual([]);
    expect(sparse(flat, 60_000, 10)).toEqual([]);
    expect(sparse(off, 31_000, 10)).toEqual([]);
    // At the gap's edge, 30 s apart, still judged: a minute is three readings.
    expect(sparse(off, 30_000, 3)).toEqual([
      expect.stringMatching(/^a member off the rule's task for 1 min, from 1970-01-01T00:00:00\.000Z /),
    ]);
    expect(sparse(flat, 30_000, 3)).toEqual([
      expect.stringMatching(/^the gang's respect flat with the rule's members working for 1 min, /),
    ]);
  });
});

test("the wanted grace is one justice member's time to halve the wanted level: about 23 min", () => {
  expect(GANG_WANTED_OVER_BOUND_MS / MINUTE).toBeCloseTo(23.09, 2);
});

/** Every rootkit (G3): a grown member has them, so only an augmentation is left to pay. */
const ROOTKITS = ["NUKE Rootkit", "Soulstealer Rootkit", "Demon Rootkit", "Hmap Node", "Jack the Ripper"];

/**
 * A hacker far grown (G3), on Money Laundering: ascension multiplier 150,000, 4.5e10 experience (hacking about 88
 * million), its ascension converting a thousandth more (not paying), a minute's training adding too little to pay
 * within a day, every rootkit already. With 12 members (the money objective) the plan keeps it on Money Laundering,
 * whose money pays an augmentation back within 15 minutes; under 12 the plan has it train, which earns none back.
 */
const grownHacker = (name: string, changes: Partial<GangMemberReading> = {}): GangMemberReading => ({
  ...member(name, 1, "Money Laundering"),
  hack_asc_mult: 150_000,
  hack_asc_points: 4.5e13,
  hack_exp: 4.5e10,
  hack: gangSkillLevel(4.5e10, 150_000),
  upgrades: ROOTKITS,
  augmentations: [],
  ...changes,
});
/** `first` and 11 recruits training: a gang of 12, its objective money. */
const twelveWith = (first: GangMemberReading) => [
  first,
  ...Array.from({ length: 11 }, (_, index) =>
    member(`member-${String(index + 2).padStart(2, "0")}`, 1, "Train Hacking"),
  ),
];
/** The gang's figures for a grown gang: respect 2 million, as 12 members need, and no discount. */
const GROWN_GANG = { respect: 2e6, wantedPenalty: 1, equipmentCostMult: 1 };

describe("the controller (#325)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let clock: ManualClock;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "gang-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    clock = new ManualClock();
    channel = new ControlChannel({ token: TOKEN, clock });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * A brain with the hack loop off (its intents go at once), and an Agent connected, its static snapshot sent; BN2's
   * route the planner's unless said (#357).
   */
  function connected(bn2Route: Bn2Route = "planner") {
    store.setSetting("hackLoop.enabled", "false");
    const lines: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line), bn2Route });
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
    const send = (tier: SnapshotTier, data: unknown, gameTimeMs = 1_000) =>
      connection.receive(
        encodeControlMessage({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          type: "snapshot",
          agentSessionId: "session-1",
          tier,
          sequenceNumber: ++sequenceNumber,
          gameTimeMs,
          data,
        }),
      );
    send("static", { servers: [staticServer("home", { moneyMax: 0 }), staticServer("n00dles")] });
    const last = () =>
      connection
        .sentMessages()
        .filter((message) => message.type === "desiredState")
        .at(-1) as unknown as DesiredState | undefined;
    return { controller, send, last, lines, connection };
  }
  /** A slow snapshot of `bitNode` with NiteSec joined, at no reputation, as forming the gang leaves it. */
  const niteSecSlow = (bitNode: number): SlowSnapshotData => ({
    ...slowData(bitNode),
    factions: {
      backend: "sim",
      state: { joined: [{ name: "NiteSec", reputation: 0, favor: 0 }], invitations: [], queuedAugmentations: [] },
      problem: null,
    },
  });
  /** A medium snapshot with every skill the work's rate reads, NiteSec joined, and `gang` read. */
  const niteSecMedium = (gang: GangReading | null | undefined) => {
    const data = withGang(gang, ["NiteSec"]);
    data.player = {
      ...data.player,
      skills: { hacking: 250, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: { faction_rep: 1 },
    };
    return data;
  };

  test("in BN2: the gang in every state; none formed, its forming asked for (through the gate) as source gang", () => {
    const { controller, send, last, lines } = connected();
    send("slow", niteSecSlow(2));
    send("medium", niteSecMedium(NONE));
    expect(last()?.gang).toEqual({ recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null, warfare: null });
    expect(controller.intentsView()).toEqual([
      { id: FORM_NITESEC.id, source: "gang", outcome: null, waitingFor: expect.any(String) },
    ]);
    // Irreversible: not sent before its guard and a save backup (this brain takes none).
    expect(last()?.intents).toEqual([]);
    expect(lines).toContain("gang: forming with NiteSec");
    expect(controller.gangView().stage).toBe("forming");
  });

  test("the silent stalls (#354) from the snapshots in: the controller's `gangStalls()`, the alert's, past a minute", () => {
    const { controller, send } = connected();
    send("slow", niteSecSlow(2));
    // member-01 left Unassigned at every reading, the rule's Train Hacking: the game refusing it, say.
    const off = formed([member("member-01", 1, "Unassigned"), member("member-02"), member("member-03")]);
    send("medium", niteSecMedium(off));
    for (let step = 1; step <= 5; step += 1) {
      clock.advance(10_000);
      send("medium", niteSecMedium(off));
    }
    expect(controller.gangStalls()).toEqual([]);
    clock.advance(10_000);
    send("medium", niteSecMedium(off));
    expect(controller.gangStalls()).toEqual([
      expect.objectContaining({ kind: "task", detail: "member-01 on Unassigned, the rule's Train Hacking" }),
    ]);
    const [stall] = controller.gangStalls();
    expect((stall?.toMs ?? 0) - (stall?.fromMs ?? 0)).toBe(60_000);
  });

  test("formed: its recruits and tasks sent, and the gang's faction gets none of the brain's faction work", () => {
    const { controller, send, last } = connected();
    send("slow", niteSecSlow(2));
    // Before the gang worker's first reading (a brain just started), every gang faction is held out: no work there.
    send("medium", niteSecMedium(undefined));
    expect(last()?.work).toBeUndefined();
    // None formed: NiteSec is a faction like any, and the brain works for it.
    send("medium", niteSecMedium(NONE));
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "NiteSec" });
    send("medium", niteSecMedium(formed([])));
    expect(last()?.gang?.recruit).toEqual(["member-01", "member-02", "member-03"]);
    expect(last()?.work).toBeUndefined();
    expect(controller.gangView().line).toMatch(/^Gang: NiteSec's, 0 members of 12/);
  });

  test("its shop (#334): A6 buys The Red Pill there at its reputation, the World Daemon's path names it; no work", () => {
    const { controller, send, last } = connected();
    // NiteSec, the gang's faction, at The Red Pill's 2.5m (a harness edit's figure), as the slow snapshot reports it.
    const slow = niteSecSlow(2);
    const state = slow.factions?.state;
    if (!state) throw new Error("no faction state");
    send("slow", {
      ...slow,
      factions: { ...slow.factions, state: { ...state, joined: [{ name: "NiteSec", reputation: 2.5e6, favor: 0 }] } },
    });
    const data = niteSecMedium(formed([]));
    data.player = { ...data.player, money: 0 } as MediumSnapshotData["player"];
    send("medium", data);
    expect(last()?.intents.map((each) => each.id)).toContain(
      intentId("purchaseAugmentation", { faction: "NiteSec", augmentation: "The Red Pill", level: 1 }),
    );
    expect(controller.augmentationsView().asking).toBe("buying The Red Pill from NiteSec");
    expect(controller.worldDaemonView().lines).toContain(
      "The Red Pill: NiteSec's (the gang's faction) reputation 2,500,000 of 2,500,000, reached: to buy and install",
    );
    // Still no work there: the game offers none.
    expect(last()?.work).toBeUndefined();
  });

  test("A5 at the controller (#335's review): what the gang's faction's reputation reaches isn't worked for elsewhere", () => {
    const { send, last } = connected();
    const slow = niteSecSlow(2);
    const state = slow.factions?.state;
    if (!state) throw new Error("no faction state");
    const withNiteSec = (reputation: number) => ({
      ...slow,
      factions: {
        ...slow.factions,
        state: {
          ...state,
          joined: [
            { name: "CyberSec", reputation: 0, favor: 0 },
            { name: "NiteSec", reputation, favor: 0 },
          ],
        },
      },
    });
    send("slow", withNiteSec(0));
    send("medium", niteSecMedium(formed([])));
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "CyberSec" });
    // At 1m the gang's faction reaches all CyberSec sells: none to work for.
    send("slow", withNiteSec(1e6));
    send("medium", niteSecMedium(formed([])));
    expect(last()?.work).toBeUndefined();
  });

  test("a commit for The Red Pill with the gang unread (#335's review): it waits for the reading", () => {
    const { controller, send } = connected();
    store.setSetting("augmentations.cycle", JSON.stringify({ lastAugReset: 0, reason: "The Red Pill" }));
    send("slow", niteSecSlow(2));
    send("medium", niteSecMedium(undefined));
    expect(controller.augmentationsView().waitingFor).toBe(
      "the gang's first reading, for The Red Pill's seller, before the install",
    );
  });

  test("A8's hold there (#335's review): the reputation flat near 2.5m, held 20 min online, its stall at 10, the rate said", () => {
    const { controller, send } = connected();
    const slow = niteSecSlow(2);
    const state = slow.factions?.state;
    if (!state) throw new Error("no faction state");
    const at2400k = {
      ...slow,
      factions: { ...slow.factions, state: { ...state, joined: [{ name: "NiteSec", reputation: 2.4e6, favor: 0 }] } },
    };
    const data = niteSecMedium(formed([]));
    data.player = { ...data.player, money: 0 } as MediumSnapshotData["player"];
    // An hour since the install (lastAugReset 0), then a minute a step: the slow snapshot's game time, the rate's.
    let gameTimeMs = 3_600_000;
    const step = () => {
      clock.advance(60_000);
      gameTimeMs += 60_000;
      send("slow", at2400k, gameTimeMs);
      send("medium", data, gameTimeMs);
    };
    send("slow", at2400k, gameTimeMs);
    send("medium", data, gameTimeMs);
    const held = () =>
      (controller.augmentationsView().waitingFor ?? "").startsWith("The Red Pill: NiteSec's reputation");
    expect(held()).toBe(true);
    // Daedalus's count doesn't count with The Red Pill at the gang's faction: never short of it.
    expect(controller.augmentationsView().progress?.short).toBeNull();
    // 2.4m in an hour: 666.7 a second, the rest in 150 s at it ("3 min").
    expect(controller.worldDaemonView().lines).toContain(
      "The Red Pill: NiteSec's (the gang's faction) reputation 2,400,000 of 2,500,000 at 666.7/s (the cycle's): about " +
        "3 min",
    );
    const stalledAt: number[] = [];
    for (let minute = 1; minute <= 25; minute += 1) {
      step();
      expect(held(), `minute ${minute}`).toBe(minute < 20);
      const stall = controller.worldDaemonView().stall;
      if (stall?.step === "redPillReputation") stalledAt.push(minute);
      if (minute === 10) expect(stall?.detail).toContain("The Red Pill's reputation at NiteSec not rising");
    }
    // Not rising while held: the stall from 10 minutes, as Daedalus's, to the hold's end at 20, never restarted.
    expect(stalledAt).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("the exclusion lifts outside BN2: a BN2 gang's faction is worked for again in BN4", () => {
    const { send, last } = connected();
    send("slow", niteSecSlow(2));
    send("medium", niteSecMedium(formed([])));
    expect(last()?.work).toBeUndefined();
    // Destroyed into BN4: NiteSec joined again, a faction like any.
    send("slow", niteSecSlow(4));
    send("medium", niteSecMedium(undefined));
    expect(last()?.gang).toBeUndefined();
    expect(last()?.work).toMatchObject({ kind: "faction", faction: "NiteSec" });
  });

  test("a member the owner named past what the protocol takes is left as it is, the rest set", () => {
    const { send, last } = connected();
    send("slow", niteSecSlow(2));
    send("medium", niteSecMedium(formed([member("x".repeat(65)), member("member-01")])));
    // Two members: one free recruit left, member-02.
    expect(Object.keys(last()?.gang?.tasks ?? {})).toEqual(["member-01", "member-02"]);
    expect(parseGangState(last()?.gang)).toMatchObject({ ok: true });
  });

  test("the rule's justice members are kept in the brain's store, for a restarted brain", () => {
    const { send, last } = connected();
    send("slow", niteSecSlow(2));
    // Three recruits, all training, far over the bound: all to justice.
    const three = ["member-01", "member-02", "member-03"].map((name) => member(name));
    send("medium", niteSecMedium(formed(three, { respect: 1, wantedLevel: 20, wantedPenalty: 1 / 21 })));
    expect(Object.values(last()?.gang?.tasks ?? {})).toEqual(Array(3).fill("Ethical Hacking"));
    expect(JSON.parse(store.getSetting(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null")).toEqual([
      "member-01",
      "member-02",
      "member-03",
    ]);
  });

  describe("BN2's route (#357): the objective at 12 reaches the tasks", () => {
    /** Twelve members at hacking 1,000, a grown gang: respect's plan puts them on Cyberterrorism, money's elsewhere. */
    const twelve = Array.from({ length: 12 }, (_, index) =>
      member(`member-${String(index + 1).padStart(2, "0")}`, 1_000, "Train Hacking"),
    );
    const reading = formed(twelve, { respect: 2e6, wantedLevel: 1, wantedPenalty: 2e6 / (2e6 + 1) });
    const inputs: GangRuleInputs = {
      gang: { respect: 2e6, wantedLevel: 1, territory: 1 / 7 },
      isHacking: true,
      members: twelve,
      softcap: 1,
      placedOnJustice: [],
      bonusTime: false,
    };
    const tasksOf = (objective: "respect" | "money") =>
      Object.fromEntries(planGang(inputs, objective).assignments.map(({ name, task }) => [name, task]));
    /** NiteSec's slow snapshot with The Red Pill `queued` or not. */
    const withQueue = (queued: string[]): SlowSnapshotData => {
      const slow = niteSecSlow(2);
      const state = slow.factions?.state as NonNullable<NonNullable<SlowSnapshotData["factions"]>["state"]>;
      return { ...slow, factions: { backend: "sim", state: { ...state, queuedAugmentations: queued }, problem: null } };
    };

    test("NiteSec at 0 of The Red Pill's 2.5m: respect's plan in the desired state, the event with both estimates", () => {
      const { controller, send, last, lines } = connected();
      const events: unknown[] = [];
      controller.subscribe((event) => events.push(event));
      // The precondition: the two objectives' plans differ.
      expect(tasksOf("respect")).not.toEqual(tasksOf("money"));
      send("slow", withQueue([]));
      send("medium", niteSecMedium(reading));
      expect(last()?.gang?.tasks).toEqual(tasksOf("respect"));
      const choice = gangObjectiveChoice(inputs, {
        reputation: 0,
        favor: 0,
        factionRep: 1,
        needed: 2.5e6,
        redPillOwned: false,
      });
      expect(choice.objective).toBe("respect");
      expect(events.filter((event) => (event as { type: string }).type === "gangObjectiveChosen")).toEqual([
        {
          type: "gangObjectiveChosen",
          atMs: expect.any(Number),
          objective: "respect",
          reason: "estimates",
          members: 12,
          respect: {
            respectPerCycle: choice.respect?.respectPerCycle,
            reputationPerSecond: choice.respect?.reputationPerSecond,
            etaMs: choice.respect?.etaMs,
          },
          money: {
            respectPerCycle: choice.money?.respectPerCycle,
            reputationPerSecond: choice.money?.reputationPerSecond,
            etaMs: choice.money?.etaMs,
          },
          reputation: 0,
          favor: 0,
          factionRep: 1,
          needed: 2.5e6,
        },
      ]);
      expect(controller.gangView().line).toMatch(
        /^Gang: NiteSec's, 12 members of 12 \(.*\); objective at 12: respect, The Red Pill in \d+\.\d h \(money's \d+\.\d h\); respect /,
      );
      expect(lines).toContainEqual(expect.stringMatching(/^gang: the objective at 12: respect, The Red Pill in /));
      // Again on the next reading: no second event.
      send("medium", niteSecMedium(reading));
      expect(events.filter((event) => (event as { type: string }).type === "gangObjectiveChosen")).toHaveLength(1);
    });

    test("The Red Pill queued: money's plan, and an event at the change", () => {
      const { controller, send, last } = connected();
      const events: { type: string; objective?: string; reason?: string }[] = [];
      controller.subscribe((event) => events.push(event as (typeof events)[number]));
      send("slow", withQueue([]));
      send("medium", niteSecMedium(reading));
      send("slow", withQueue(["The Red Pill"]));
      send("medium", niteSecMedium(reading));
      expect(last()?.gang?.tasks).toEqual(tasksOf("money"));
      expect(
        events
          .filter((event) => event.type === "gangObjectiveChosen")
          .map(({ objective, reason }) => [objective, reason]),
      ).toEqual([
        ["respect", "estimates"],
        ["money", "The Red Pill owned"],
      ]);
      expect(controller.gangView().line).toContain(
        "; objective at 12: money, The Red Pill bought, queued or installed; ",
      );
    });

    test("The Red Pill reported bought, not yet queued (A6's queue): money's plan already", () => {
      const rule = new GangRule();
      const medium = niteSecMedium(reading);
      rule.update({ mediumData: medium, slowData: withQueue([]) });
      expect(rule.view().plan?.objective).toBe("respect");
      const state = rule.update({ mediumData: medium, slowData: withQueue([]), redPillBought: true });
      expect(rule.view().plan?.objective).toBe("money");
      expect(state.gang?.tasks).toEqual(tasksOf("money"));
      // Queued, as the slow snapshot shows it, the rule's own reading: money too.
      const queued = new GangRule();
      queued.update({ mediumData: medium, slowData: withQueue(["The Red Pill"]) });
      expect(queued.view().plan?.objective).toBe("money");
    });

    test("the rules (`bn2Route` rules, the A/B's baseline): money's plan at 12, no event", () => {
      const { controller, send, last } = connected("rules");
      const events: unknown[] = [];
      controller.subscribe((event) => events.push(event));
      send("slow", withQueue([]));
      send("medium", niteSecMedium(reading));
      expect(last()?.gang?.tasks).toEqual(tasksOf("money"));
      expect(controller.gangView().line).not.toContain("objective at 12");
      expect(events.filter((event) => (event as { type: string }).type === "gangObjectiveChosen")).toEqual([]);
    });
  });

  /** Three members, the wanted penalty `share` above its floor at respect 1,000, on `tasks`. */
  const justiceReading = (tasks: string[], share: number) =>
    niteSecMedium(
      formed(
        [member("member-01", 300, tasks[0]), member("member-02", 250, tasks[1]), member("member-03", 200, tasks[2])],
        { respect: 1_000, wantedLevel: (1_000 * share + 1) / (1 - share), wantedPenalty: 0.5 },
      ),
    );
  /** Under the bound, over its half, member-02 and member-03 on justice: kept there only if the rule put them there. */
  const inBand = () => justiceReading(["Plant Virus", "Ethical Hacking", "Ethical Hacking"], 0.32);
  const ON_JUSTICE = { "member-02": "Ethical Hacking", "member-03": "Ethical Hacking" };

  test("a restarted brain keeps the rule's justice members (#365's review): its updates with no snapshots leave the store's", () => {
    store.setSetting(GANG_PLACED_ON_JUSTICE_SETTING, JSON.stringify(["member-02", "member-03"]));
    // The constructor's update and the hello's, with no snapshot yet.
    const { controller, send, last } = connected();
    expect(controller.gangView().stage).toBe("notManaged");
    expect(JSON.parse(store.getSetting(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null")).toEqual(["member-02", "member-03"]);
    send("slow", niteSecSlow(2));
    send("medium", inBand());
    expect(last()?.gang?.tasks).toMatchObject(ON_JUSTICE);
  });

  test("an Agent's disconnect and reconnect in BN2 (#365's review): waiting for a slow snapshot, the justice members kept", () => {
    const { controller, send, connection, lines } = connected();
    send("slow", niteSecSlow(2));
    send("medium", justiceReading(["Plant Virus", "Plant Virus", "DDoS Attacks"], 0.4));
    expect(JSON.parse(store.getSetting(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null")).toEqual(["member-02", "member-03"]);
    connection.close(1006, "the Agent went");
    expect(controller.gangView()).toMatchObject({
      stage: "waiting",
      line: "Gang: waiting for a slow snapshot to say the BitNode",
    });
    expect(lines).toContain("gang: waiting for a slow snapshot to say the BitNode");
    expect(JSON.parse(store.getSetting(GANG_PLACED_ON_JUSTICE_SETTING) ?? "null")).toEqual(["member-02", "member-03"]);
    // The next Agent's session, its snapshots in the band: the rule's own kept on justice.
    const next = new MemoryConnection();
    channel.accept(next);
    const message = (body: Record<string, unknown>) =>
      next.receive(encodeControlMessage({ protocolVersion: CONTROL_PROTOCOL_VERSION, ...body } as never));
    message({
      type: "hello",
      token: TOKEN,
      deploymentId: "deployment-a",
      agentSessionId: "session-2",
      game: { version: "3.0.1", versionNumber: 51, commit: "3162fd2", platform: "Steam" },
    });
    for (const [tier, data] of [
      ["slow", niteSecSlow(2)],
      ["medium", inBand()],
    ] as const) {
      message({
        type: "snapshot",
        agentSessionId: "session-2",
        tier,
        sequenceNumber: ++sequenceNumber,
        gameTimeMs: 2_000,
        data,
      });
    }
    const sent = next
      .sentMessages()
      .filter((each) => each.type === "desiredState")
      .at(-1) as unknown as DesiredState | undefined;
    expect(sent?.gang?.tasks).toMatchObject(ON_JUSTICE);
    expect(controller.gangView().stage).toBe("managed");
  });

  test("equipment (G3): bought from the money above the brain's holds, this round's purchase held on top", () => {
    const { controller, send, last } = connected();
    send("slow", niteSecSlow(2));
    const data = niteSecMedium(formed(twelveWith(grownHacker("member-01")), GROWN_GANG));
    data.player = { ...data.player, money: 1e11 };
    send("medium", data);
    expect(last()?.gang?.buy).toEqual([{ name: "member-01", equipment: "Neuralstimulator", pointsBefore: 4.5e13 }]);
    // The holds: the travel for an invitation's (a city faction's money requirement, #228) and, on top, the TOR
    // router going out this round, $200,000.
    // And (#335's review) a city group's travel: Daedalus's count no longer counts in BN2 with a gang, so the group
    // is chosen by hacking value, Chongqing's.
    expect(last()?.intents.map((each) => each.id)).toEqual(["buyTor(Alpha Enterprises)", "travel(Chongqing)"]);
    const invitation = controller.invitationsView().hold;
    expect(invitation).toBeGreaterThan(0);
    expect(last()?.gang?.keepMoney).toBe(invitation + 200_000);
    expect(controller.gangView().line).toContain("; equipment: buying Neuralstimulator for member-01");
  });

  test("equipment (G3): the home RAM upgrade going out, held at its price on top (#330's re-review: the wiring)", () => {
    // BN1, where home RAM's price is known (BN2's isn't yet): TOR and every port opener owned, home at 64 GB, $1b.
    const { controller, send, last } = connected();
    send("slow", slowData(1));
    const programs = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    send("medium", mediumData(50, {}, { money: 1e9, hasTorRouter: true, programs, homeRam: 64 }));
    expect(last()?.intents.map((each) => each.id)).toContain(
      intentId("upgradeHomeRam", { fromRam: 64, vendor: "Alpha Enterprises" }),
    );
    const most = Math.max(controller.invitationsView().hold, controller.augmentationReserve());
    expect(controller.gangEquipmentHold()).toEqual({
      amount: most + homeRamUpgradePrice(64),
      forWhat: expect.stringContaining("home RAM to 128 GB"),
    });
  });

  test("equipment (G3) and A8 (#334): Daedalus's $100b isn't held in BN2 with a gang: its faction sells The Red Pill", () => {
    const { controller, send, last } = connected();
    const thirty = Object.fromEntries(
      AUGMENTATION_NAMES.filter((name) => name !== "The Red Pill" && name !== "NeuroFlux Governor")
        .slice(0, 30)
        .map((name) => [name, 1]),
    );
    const slow = niteSecSlow(2);
    send("slow", { ...slow, resetInfo: { ...slow.resetInfo, ownedAugs: thirty } });
    const data = niteSecMedium(formed([member("member-01"), member("member-02")], { respect: 1_000 }));
    data.player = {
      ...data.player,
      money: 101e9,
      skills: { ...(data.player?.skills as object), hacking: 2600 },
    } as MediumSnapshotData["player"];
    send("medium", data);
    // Daedalus's invitation wants only its money: before #334, A8 held its $100b, from home RAM and gang equipment
    // too. With the gang's faction selling The Red Pill, Daedalus isn't needed: no hold. The most of the holds is the
    // invitation's travel, with the TOR router going out on top.
    expect(last()?.intents.map((each) => each.id)).toContain("buyTor(Alpha Enterprises)");
    expect(controller.augmentationsView().waitingFor ?? "").not.toContain("Daedalus's invitation");
    expect(controller.augmentationReserve()).toBeLessThan(100e9);
    expect(last()?.gang?.keepMoney).toBe(controller.invitationsView().hold + 200_000);
  });

  test("territory warfare (G4): the crew's tasks and the order sent in the desired state, engaged once stronger", () => {
    const { send, last, lines } = connected();
    send("slow", niteSecSlow(2));
    const members = [member("member-01", 400), fighter("member-02"), fighter("member-03")];
    send("medium", niteSecMedium(warring(members, 1, 1)));
    // At equal powers the fighters build power, not yet engaged: the order says off.
    expect(last()?.gang?.tasks).toMatchObject({ "member-02": "Territory Warfare", "member-03": "Territory Warfare" });
    expect(last()?.gang?.warfare).toEqual({ engage: false, leastTerritoryPerUpdate: 0 });
    expect(parseGangState(last()?.gang)).toMatchObject({ ok: true });
    // Stronger: engaged, with the measure's break-even for the worker's check.
    send("medium", niteSecMedium(warring(members, 50, 1)));
    const order = last()?.gang?.warfare;
    expect(order?.engage).toBe(true);
    expect(order?.leastTerritoryPerUpdate).toBeGreaterThan(0);
    expect(order?.leastTerritoryPerUpdate).toBeLessThan(gangTerritoryPerUpdate(50, 1 / 7, others(1)));
    expect(lines.some((line) => /; territory warfare engaged$/.test(line))).toBe(true);
  });

  test("outside BN2: no gang in the state, nothing logged of it", () => {
    const { send, last, lines } = connected();
    send("slow", niteSecSlow(1));
    send("medium", niteSecMedium(NONE));
    expect(last()?.gang).toBeUndefined();
    expect(lines.filter((line) => line.startsWith("gang:"))).toEqual([]);
  });
});

describe("equipment (G3)", () => {
  const strong = grownHacker;
  const GROWN = GROWN_GANG;
  /** A medium snapshot with the members read and the player's `money`, `keepMoney` the worker's echo. */
  const reading = (members: GangMemberReading[], money: number, keepMoney: number | null = null) => {
    const data = withGang({ ...formed(members, GROWN), keepMoney });
    return { ...data, player: { ...data.player, money } } as MediumSnapshotData;
  };
  const HOLD = { amount: 1e8, forWhat: "the augmentations to buy before the install" };
  /** The gang of 12: `first` and 11 training. */
  const three = (first = strong("member-01")) => twelveWith(first);
  const NEURALSTIMULATOR = 10e9;

  test("valued at the plan's task (#330's re-review): the grown hacker in 3 trains and gets nothing; in 12 it works, and gets it", () => {
    // Three members (the simulator's first end-to-end case): the respect objective, and the plan trains the hacker,
    // which earns no money back, so nothing is bought for it, augmentations included, with $1t free.
    const rule = new GangRule();
    const small = [grownHacker("member-01"), member("member-02", 1, "Train Hacking"), member("member-03", 1)];
    const decision = rule.update({ mediumData: reading(small, 1e12), slowData: slowData(2) });
    expect(decision.gang?.tasks["member-01"]).not.toBe("Money Laundering");
    expect(rule.equip({ money: 1e12, hold: HOLD })?.buy).toEqual([]);
    expect(rule.view().line).toMatch(/; equipment: no equipment pays back within 15 minutes$/);
    // Twelve: the money objective, the hacker on Money Laundering, its augmentation paid back within 15 minutes.
    rule.update({ mediumData: reading(three(), 1e12), slowData: slowData(2) });
    expect(rule.view().plan?.assignments[0]).toMatchObject({ task: "Money Laundering", role: "working" });
    expect(rule.equip({ money: 1e12, hold: HOLD })?.buy.map((each) => each.equipment)).toEqual(["Neuralstimulator"]);
    expect(rule.view().equipment?.buy[0]?.paybackMs).toBeLessThanOrEqual(GANG_EQUIPMENT_PAYBACK_LIMIT_MS);
  });

  test("the reading's equipment: absent from an older Agent, none; the game's names; any other, unread", () => {
    expect(gangSnapshotOf(reading([member("member-01")], 0)).kind).toBe("gang");
    expect(gangSnapshotOf(reading([strong("member-01", { upgrades: ["NUKE Rootkit"] })], 0)).kind).toBe("gang");
    expect(gangSnapshotOf(reading([strong("member-01", { augmentations: ["Spoon"] })], 0))).toEqual({
      kind: "unread",
      problem: "a gang member's equipment isn't the game's",
    });
    const odd = withGang({ ...formed([member("member-01")], { equipmentCostMult: -1 }) });
    expect(gangSnapshotOf(odd)).toMatchObject({ kind: "unread" });
  });

  test("the purchases spoken for: the one going out at its plan's price, each kind; the cloud server waiting, while it'd buy", () => {
    const intent = (action: string, args: Record<string, unknown> = {}) =>
      ({ action, args, id: `${action}()` }) as unknown as Intent;
    const prices = { programs: 1e6, homeRam: 2e8, cloudServer: 3e7 };
    const server = { action: "buyServer", hostname: "pserv-3", ram: 64, price: 4e6, paybackMs: 60_000 } as const;
    const buys: {
      awaiting?: typeof server;
      enabled: boolean;
      hackLoop: boolean;
      committed: boolean;
      problem: boolean;
    } = { enabled: true, hackLoop: true, committed: false, problem: false };
    const spoken = (action: string | null, cloud: Partial<typeof buys> = {}) =>
      gangPurchasesSpokenFor({
        purchase: action === null ? null : { intent: intent(action), forWhat: action },
        prices,
        cloud: { ...buys, ...cloud },
      });
    expect(spoken("buyTor")).toEqual([{ amount: 1e6, forWhat: "buyTor" }]);
    expect(spoken("buyProgram")).toEqual([{ amount: 1e6, forWhat: "buyProgram" }]);
    expect(spoken("upgradeHomeRam")).toEqual([{ amount: 2e8, forWhat: "upgradeHomeRam" }]);
    expect(spoken("buyServer")).toEqual([{ amount: 3e7, forWhat: "buyServer" }]);
    expect(spoken("upgradeServer")).toEqual([{ amount: 3e7, forWhat: "upgradeServer" }]);
    expect(spoken("travel")).toEqual([{ amount: 0, forWhat: "travel" }]);
    expect(spoken(null)).toEqual([]);
    // A price that isn't a number: none.
    expect(
      gangPurchasesSpokenFor({ purchase: { intent: intent("upgradeHomeRam"), forWhat: "x" }, prices: {}, cloud: buys }),
    ).toEqual([{ amount: 0, forWhat: "x" }]);
    // The cloud server waiting for money, on top, only while cloud servers would buy it.
    expect(spoken(null, { awaiting: server })).toEqual([{ amount: 4e6, forWhat: "pserv-3 with 64 GB" }]);
    for (const off of [{ enabled: false }, { hackLoop: false }, { committed: true }, { problem: true }]) {
      expect(spoken(null, { awaiting: server, ...off }), JSON.stringify(off)).toEqual([]);
    }
  });

  test("its payback limit is the cloud servers', the lookahead A6's reserve holds the set for (#330's review)", () => {
    expect(GANG_EQUIPMENT_PAYBACK_LIMIT_MS).toBe(CLOUD_SERVER_PAYBACK_LIMIT_MS);
    expect(GANG_EQUIPMENT_PAYBACK_LIMIT_MS).toBe(AUGMENTATION_RESERVE_LOOKAHEAD_MS);
  });

  test("gang.js starts in the room home keeps free of share threads, whatever the batcher does (#330's review)", () => {
    // The batcher itself takes its budget on home only with 8 GB left beyond it (`HOME_KEPT_FOR_THE_AGENT_GB`), and its
    // operations (on home since #340) and share threads leave `homeKeptGb` free on home (32 GB, and the largest
    // Singularity worker's beside it with SF4). The Agent starts gang.js only in home's free RAM.
    const budgets = JSON.parse(
      readFileSync(new URL("../../ingame/ram-budget.json", import.meta.url), "utf8"),
    ) as Record<string, number>;
    expect(budgets["gang.js"]).toBeLessThanOrEqual(SHARE_HOME_KEPT_GB);
    // With the Agent and the batcher on home too, both within what share threads leave (G4's review): 32 − 3.0 − 3.85.
    const room = SHARE_HOME_KEPT_GB - (budgets["agent.js"] as number) - BATCHER_RAM_BUDGET_GB;
    expect(room).toBeCloseTo(25.15, 9);
    expect(budgets["gang.js"]).toBeLessThanOrEqual(room);
    expect(budgets["gang.js"]).toBeGreaterThan(HOME_KEPT_FOR_THE_AGENT_GB);
  });

  test("the hold: the most of the reserves, the purchases spoken for on top; Infinity spends none", () => {
    const reserves = [
      { amount: 2e8, forWhat: "The Red Pill's donation" },
      { amount: 0, forWhat: "Daedalus's invitation" },
      { amount: 5e8, forWhat: "the augmentations to buy before the install" },
    ];
    expect(gangMoneyHoldOf(reserves, [{ amount: 3e6, forWhat: "BruteSSH.exe" }])).toEqual({
      amount: 5e8 + 3e6,
      forWhat: "the augmentations to buy before the install and BruteSSH.exe",
    });
    expect(gangMoneyHoldOf([], [])).toEqual({ amount: 0, forWhat: "nothing" });
    // An install chosen: A6's reserve is Infinity, so is the hold.
    expect(gangMoneyHoldOf([{ amount: Number.POSITIVE_INFINITY, forWhat: "the install" }], []).amount).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("bought with the money above the hold, at the member's points; a medium snapshot's once; its line and log", () => {
    const lines: string[] = [];
    const rule = new GangRule((line) => lines.push(line));
    const data = reading(three(), 1e11);
    rule.update({ mediumData: data, slowData: slowData(2) });
    const state = rule.equip({ money: 1e11, hold: HOLD });
    expect(state?.buy).toEqual([{ name: "member-01", equipment: "Neuralstimulator", pointsBefore: 4.5e13 }]);
    expect(state?.keepMoney).toBe(1e8);
    expect(rule.view().equipment?.buy).toHaveLength(1);
    expect(rule.view().line).toMatch(
      /; equipment: buying Neuralstimulator for member-01 \(\$10,000,000,000, \$[\d,]+ more money in a day\)$/,
    );
    expect(lines).toContain("gang: buying Neuralstimulator for member-01");
    // The same medium snapshot, another hold (a fast snapshot's round): the same purchases, so the worker isn't rerun.
    rule.update({ mediumData: data, slowData: slowData(2) });
    expect(rule.equip({ money: 1e11, hold: { amount: 2e8, forWhat: "x" } })).toEqual(state);
    // The next: the money above the hold short of it. It still pays: waiting.
    rule.update({ mediumData: reading(three(), 1e10 + 1e6), slowData: slowData(2) });
    expect(rule.equip({ money: 1e10 + 1e6, hold: HOLD })).toMatchObject({ buy: [], keepMoney: 1e8 });
    expect(rule.view().line).toMatch(
      /; equipment: Neuralstimulator for member-01 pays \(\$10,000,000,000\), waiting for money above the \$100,000,000 held for the augmentations to buy before the install$/,
    );
    // An install chosen: none spent, keepMoney null.
    rule.update({ mediumData: reading(three(), 1e12), slowData: slowData(2) });
    expect(
      rule.equip({ money: 1e12, hold: { amount: Number.POSITIVE_INFINITY, forWhat: "the install chosen" } }),
    ).toMatchObject({ buy: [], keepMoney: null });
    expect(rule.view().line).toContain("waiting for the install chosen, which spends everything");
    // An install chosen on a fast snapshot, the medium the same (#330's review): none spent from then on, at once.
    const same = reading(three(), 1e12);
    rule.update({ mediumData: same, slowData: slowData(2) });
    expect(rule.equip({ money: 1e12, hold: HOLD })).toMatchObject({ keepMoney: 1e8 });
    rule.update({ mediumData: same, slowData: slowData(2) });
    expect(
      rule.equip({ money: 1e12, hold: { amount: Number.POSITIVE_INFINITY, forWhat: "the install chosen" } }),
    ).toMatchObject({ buy: [], keepMoney: null });
    // Nothing held, the money short: just "waiting for money" (#330's review).
    rule.update({ mediumData: reading(three(), 1e6), slowData: slowData(2) });
    rule.equip({ money: 1e6, hold: { amount: 0, forWhat: "nothing" } });
    expect(rule.view().line).toMatch(
      /; equipment: Neuralstimulator for member-01 pays \(\$10,000,000,000\), waiting for money$/,
    );
    // Owned already: the next augmentation that pays, of those that raise hacking.
    rule.update({
      mediumData: reading(three(strong("member-01", { augmentations: ["Neuralstimulator"] })), 1e12),
      slowData: slowData(2),
    });
    expect(rule.equip({ money: 1e12, hold: HOLD })?.buy.map((each) => each.equipment)).not.toContain(
      "Neuralstimulator",
    );
    // Weak members: none pays.
    rule.update({ mediumData: reading([member("member-01"), member("member-02")], 1e12), slowData: slowData(2) });
    expect(rule.equip({ money: 1e12, hold: HOLD })?.buy).toEqual([]);
    expect(rule.view().line).toMatch(/; equipment: no equipment pays back within 15 minutes$/);
    // Outside BN2: nothing managed, nothing bought.
    rule.update({ mediumData: reading(three(), 1e12), slowData: slowData(1) });
    expect(rule.equip({ money: 1e12, hold: HOLD })).toBeNull();
  });

  test("the run report: what was bought, by hour, for how much; the rule's purchase with the money free, unbought, fails", () => {
    const fold = (readings: MediumSnapshotData[]) => {
      const gang = new GangFold();
      gang.addSlow(0, slowData(2));
      readings.forEach((data, index) => {
        gang.addMedium(index * 10_000, data);
      });
      const failures: string[] = [];
      const text = gang.section(failures, readings.length * 10_000).join("\n");
      // This check's alone: the respect of 1,000 lets 3 members recruit, which these readings never do.
      return { text, failures: failures.filter((each) => each.startsWith("equipment the rule buys")) };
    };
    const repeat = <Value>(value: Value, count: number) => Array.from({ length: count }, () => value);
    const waiting = reading(three(), 1e11, 1e8);
    // Unbought for the minute, the money free: a failure, saying what and why.
    const steps = GANG_EQUIP_WITHIN_MS / 10_000;
    expect(fold(repeat(waiting, steps)).failures).toEqual([]);
    const { failures } = fold(repeat(waiting, steps + 1));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^equipment the rule buys, with the money free, not bought for 1 min, from 1970-01-01T00:00:00\.000Z to 1970-01-01T00:01:00\.000Z \(Neuralstimulator for member-01, \$10,000,000,000 for \$[\d,]+ more money in 24 h 0 min, \$99,900,000,000 above the \$100,000,000 held\)$/,
    );
    // Not with the money held: keepMoney null (none spent), or the money above it short.
    expect(fold(repeat(reading(three(), 1e11, null), steps * 2)).failures).toEqual([]);
    expect(fold(repeat(reading(three(), 1e10 + 1e6, 1e8), steps * 2)).failures).toEqual([]);
    // Bought: the hour's line counts it, at its cost, and the wait starts again.
    const equipped = strong("member-01", { augmentations: ["Neuralstimulator"], hack_mult: 1.15 });
    const bought = reading(three(equipped), 1e11 - NEURALSTIMULATOR, 1e8);
    const { text, failures: none } = fold([waiting, waiting, bought]);
    expect(none).toEqual([]);
    expect(text).toContain("; 1 equipment bought for $10,000,000,000 (Neuralstimulator)");
    expect(fold([waiting]).text).toContain("; no equipment bought");
    // A purchase starts the wait again, though another item still pays: 40 s waiting, then 30 s more, no failure.
    expect(fold([...repeat(waiting, 5), ...repeat(bought, 3)]).failures).toEqual([]);
    expect(fold([...repeat(waiting, 5), ...repeat(waiting, 3)]).failures).toHaveLength(1);
    // An ascension loses the upgrades: a rootkit bought again after it counts again; the augmentation kept doesn't.
    const rooted = strong("member-01", { upgrades: ["NUKE Rootkit"], augmentations: ["Neuralstimulator"] });
    const ascended = gangMemberAscended(rooted);
    const rebought = { ...rooted, ...ascended, upgrades: ["NUKE Rootkit"] } as GangMemberReading;
    const again = fold([reading(three(rooted), 1e11, 1e8), reading(three(rebought), 1e11, 1e8)]);
    expect(again.text).toContain("; 1 equipment bought for $5,000,000 (NUKE Rootkit)");
    // An Agent upgraded in the window (#330's review): the reading before had no lists, so nothing counts as bought.
    const older = reading(three(), 1e11, 1e8);
    const unlisted = {
      ...older,
      gang: {
        ...older.gang,
        members: (older.gang?.members ?? []).map(({ upgrades: _u, augmentations: _a, ...rest }) => rest),
      },
    } as MediumSnapshotData;
    expect(fold([unlisted, reading(three(rooted), 1e11, 1e8)]).text).toContain("; no equipment bought");
    // Its cost the discounted one at the reading before: there half, after it the full price.
    const half = (data: MediumSnapshotData) =>
      ({ ...data, gang: { ...data.gang, gang: { ...data.gang?.gang, equipmentCostMult: 0.5 } } }) as MediumSnapshotData;
    expect(fold([half(waiting), bought]).text).toContain("; 1 equipment bought for $5,000,000,000 (Neuralstimulator)");
    // An ascension seen in a reading starts the wait again, as the brain ascends first: 40 s, then 30 s, no failure.
    const ascendedTwo = reading(
      [
        strong("member-01"),
        { ...member("member-02", 1, "Train Hacking"), hack_asc_points: 2_000 },
        ...three().slice(2),
      ],
      1e11,
      1e8,
    ) as MediumSnapshotData;
    expect(fold([...repeat(waiting, 5), ...repeat(ascendedTwo, 3)]).failures).toEqual([]);
  });
});

describe("territory warfare (G4)", () => {
  const SLOW = slowData(2);
  const update = (rule: GangRule, reading: GangReading) =>
    rule.update({ mediumData: withGang(reading), slowData: SLOW });

  test("the reading's warfare figures: absent from an older Agent, none; the flag, chance and others' numbers, or unread", () => {
    expect(gangSnapshotOf(withGang(formed([]))).kind).toBe("gang");
    expect(gangSnapshotOf(withGang(warring([], 1, 1))).kind).toBe("gang");
    for (const bad of [
      { territoryWarfareEngaged: "yes" as unknown as boolean },
      { territoryClashChance: Number.NaN },
      { otherGangs: [{ faction: "Tetrads", power: "big", territory: 0.1, winChance: 0.5 }] as never },
      { otherGangs: "Tetrads" as never },
    ]) {
      expect(gangSnapshotOf(withGang(warring([], 1, 1, bad))), JSON.stringify(bad)).toMatchObject({
        kind: "unread",
        problem: "the gang's territory warfare figures aren't numbers",
      });
    }
  });

  test("the rule's figures from the reading: power, flag, chance, the others; none from an older Agent", () => {
    const reading = warring([], 3, 1, { territoryWarfareEngaged: true, territoryClashChance: 0.5 });
    expect(gangWarfareFiguresOf(reading.gang as GangInformation)).toEqual({
      power: 3,
      engaged: true,
      clashChance: 0.5,
      others: others(1),
    });
    expect(gangWarfareFiguresOf(NITESEC)).toBeUndefined();
  });

  test("the crew on Territory Warfare, the order and the dashboard's line: off while it builds, on once stronger", () => {
    const rule = new GangRule();
    const members = [member("member-01", 400), fighter("member-02"), fighter("member-03")];
    const building = update(rule, warring(members, 1, 1));
    expect(building.gang?.tasks).toMatchObject({
      "member-02": "Territory Warfare",
      "member-03": "Territory Warfare",
    });
    expect(building.gang?.warfare).toEqual({ engage: false, leastTerritoryPerUpdate: 0 });
    expect(rule.view().line).toMatch(
      /; territory 14\.3%, power 1\.0; warfare off: the clashes would gain no territory \(win chance 50%–50%\); 2 on Territory Warfare \(about [\d.]+ deaths expected in a day engaged\); 0 deaths seen$/,
    );
    const strong = update(rule, warring(members, 50, 1));
    const plan = rule.view().plan;
    expect(strong.gang?.warfare).toEqual({
      engage: true,
      leastTerritoryPerUpdate: plan?.warfare?.measure.leastTerritoryPerUpdate,
    });
    // 2 × (50/51 × 0.0002 − 1/51 × 0.0001) an update, 180 an hour: 7.0% of the territory.
    const hourly = gangTerritoryPerUpdate(50, 1 / 7, others(1)) * (3_600_000 / GANG_TERRITORY_UPDATE_MS);
    expect(hourly).toBeCloseTo(0.0699, 4);
    expect(rule.view().line).toMatch(
      /; warfare on: 7\.0% territory an hour expected \(win chance 98%–98%\); 2 on Territory Warfare \(about [\d.]+ deaths expected in a day engaged\); 0 deaths seen$/,
    );
    // An older Agent's reading: no order, the flag left alone.
    expect(update(rule, formed(members)).gang?.warfare).toBeNull();
  });

  test("the line's other cases: off as the deaths would cost more; no gang left with territory", () => {
    const measure = {
      territoryPerUpdate: 1e-4,
      territoryValue: 1,
      deathsPerUpdate: 1,
      deathCostPerUpdate: 1,
      gainPerUpdate: 1e-4,
      pays: false,
      leastTerritoryPerUpdate: 1,
      winChances: { least: 0.6, most: 0.7 },
      tailCostPerUpdate: 0,
      crewDeaths: [],
      recruitDeath: { perUpdate: 0, cost: 0 },
    };
    expect(describeWarfare({ crew: ["a"], engage: false, measure, deaths: 3.25 }, NITESEC, 2)).toBe(
      "territory 14.3%, power 1.0; warfare off: its deaths would cost more than the 1.8% territory an hour it'd gain " +
        "is worth (win chance 60%–70%); 1 on Territory Warfare (about 3.3 deaths expected in a day engaged); 2 deaths seen",
    );
    const alone = { ...measure, territoryPerUpdate: 0, winChances: null };
    expect(
      describeWarfare({ crew: [], engage: false, measure: alone, deaths: 0 }, { ...NITESEC, territory: 1 }, 0),
    ).toBe(
      "territory 100.0%, power 1.0; warfare off: the clashes would gain no territory (no other gang has territory); none on " +
        "Territory Warfare; 0 deaths seen",
    );
  });

  test("deaths: a member on Territory Warfare gone between readings, logged and counted; one off it gone, not", () => {
    const before = [
      { name: "a", task: "Territory Warfare" },
      { name: "b", task: "Train Hacking" },
    ];
    expect(gangDeathsBetween(before, [])).toEqual(["a"]);
    expect(gangDeathsBetween(before, [{ name: "a" }])).toEqual([]);
    const logs: string[] = [];
    const rule = new GangRule((line) => logs.push(line));
    const members = [member("member-01", 400), fighter("member-02"), fighter("member-03")];
    update(rule, warring(members, 1, 1));
    update(rule, warring([members[0] as GangMemberReading, members[2] as GangMemberReading], 1, 1));
    expect(logs).toContain("gang: member-02 died in a clash, on Territory Warfare");
    expect(rule.view().line).toMatch(/; 1 death seen$/);
    // member-01 isn't on Territory Warfare: gone, it's no death.
    update(rule, warring([members[2] as GangMemberReading], 1, 1));
    expect(rule.view().line).toMatch(/; 1 death seen$/);
    // A gang gone (none read, or another BitNode) and another formed: its members aren't deaths of the last one's.
    const crew = (...names: string[]) => names.map((name) => fighter(name));
    update(rule, warring(crew("member-03", "member-09"), 1, 1));
    update(rule, NONE);
    update(rule, warring(crew("member-10"), 1, 1));
    expect(rule.view().line).toMatch(/; 1 death seen$/);
    update(rule, warring(crew("member-10", "member-11"), 1, 1));
    rule.update({ mediumData: withGang(NONE), slowData: slowData(1) });
    update(rule, warring(crew("member-12"), 1, 1));
    expect(rule.view().line).toMatch(/; 1 death seen$/);
    expect(logs.filter((line) => line.includes("died"))).toEqual([
      "gang: member-02 died in a clash, on Territory Warfare",
    ]);
    // Weaker: the clashes would lose territory.
    update(rule, warring(members, 1, 50));
    expect(rule.view().line).toMatch(/; warfare off: the clashes would lose territory \(win chance 2\.0%–2\.0%\); /);
  });

  /** A fold over a BN2 window: a slow snapshot, then a medium one every 10 s from `readings`. */
  function fold(readings: GangReading[]) {
    const gang = new GangFold();
    gang.addSlow(0, SLOW);
    readings.forEach((reading, index) => {
      gang.addMedium(index * 10_000, withGang(reading));
    });
    const failures: string[] = [];
    const lines = gang.section(failures, readings.length * 10_000);
    // Territory warfare's alone: these readings leave recruits and an ascension undone too.
    return { text: lines.join("\n"), failures: failures.filter((each) => each.startsWith("territory warfare")) };
  }
  const repeat = <Value>(value: Value, count: number) => Array.from({ length: count }, () => value);
  const minute = Math.ceil(GANG_WARFARE_WITHIN_MS / 10_000) + 1;

  test("the report: engaged while the measure says it loses, or off while it pays, for a minute fails; under, not", () => {
    const crew = [member("member-01", 400), fighter("member-02")];
    const losing = warring(crew, 1, 50, { territoryWarfareEngaged: true, territoryClashChance: 1 });
    const failed = fold(repeat(losing, minute)).failures;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(
      /^territory warfare engaged while the rule's measure says it loses for 1 min, from .* \(the clashes expected to lose territory, 1 on Territory Warfare\)$/,
    );
    expect(fold(repeat(losing, minute - 1)).failures).toEqual([]);
    // At equal powers the clashes gain none: engaged, it loses by the measure all the same.
    const even = warring(crew, 1, 1, { territoryWarfareEngaged: true, territoryClashChance: 1 });
    expect(fold(repeat(even, minute)).failures).toEqual([
      expect.stringMatching(/ \(the clashes expected to gain no territory, 1 on Territory Warfare\)$/),
    ]);
    // Off while it pays: stronger, no crew, so no deaths.
    const paying = warring([member("member-01", 400)], 50, 1);
    expect(fold(repeat(paying, minute)).failures).toEqual([
      expect.stringMatching(
        /^territory warfare off while the rule's measure says it pays for 1 min, from .* \(the territory expected worth [\d,]+ an update against deaths costing 0, 0 on Territory Warfare\)$/,
      ),
    ]);
    // The detail's deaths with the tail's (a fighter at defence 1, the gang's respect 1e8: deaths worth counting).
    const exposedFighter = { ...fighter("member-02"), def: 1, def_exp: 0 } as GangMemberReading;
    const exposed = (engaged: boolean) =>
      warring([member("member-01", 400), exposedFighter], 50, 1, { respect: 1e8, territoryWarfareEngaged: engaged });
    const reading = exposed(false);
    const gang = reading.gang as GangInformation;
    const inputs = {
      gang: { respect: gang.respect, wantedLevel: gang.wantedLevel, territory: gang.territory },
      isHacking: true,
      members: reading.members,
      softcap: 1,
      warfare: gangWarfareFiguresOf(gang) as GangWarfareFigures,
    };
    const measure = gangWarfareMeasure(inputs, gangWarfareBasis(inputs, "respect"), ["member-02"]);
    expect(measure.tailCostPerUpdate).toBeGreaterThan(1);
    const counted = Math.round(measure.deathCostPerUpdate + measure.tailCostPerUpdate).toLocaleString("en-US");
    const either = [true, false].flatMap((engaged) => fold(repeat(exposed(engaged), minute)).failures);
    expect(either).toHaveLength(1);
    expect(either[0]).toContain(`against deaths costing ${counted}, 1 on Territory Warfare)`);
    // Each the right way: none; an older Agent's readings: never judged.
    const engaged = { ...paying, gang: { ...(paying.gang as GangInformation), territoryWarfareEngaged: true } };
    expect(fold(repeat(engaged, minute)).failures).toEqual([]);
    expect(fold(repeat(warring(crew, 1, 50), minute)).failures).toEqual([]);
    expect(fold(repeat(formed(crew, { territoryWarfareEngaged: true }), minute)).failures).toEqual([]);
  });

  test("the report by hour: territory and power, the time engaged, the deaths; the clashes' count not read", () => {
    const crew = [member("member-01", 400), fighter("member-02"), fighter("member-03")];
    const on = (territory: number, power: number, members = crew) =>
      warring(members, power, 1, { territory, territoryWarfareEngaged: true, territoryClashChance: 1 });
    const readings = [
      warring(crew, 1, 1),
      on(1 / 7, 40),
      on(0.15, 45),
      on(0.16, 50, [crew[0] as GangMemberReading, crew[2] as GangMemberReading]),
    ];
    const { text } = fold(readings);
    expect(text).toMatch(
      /; territory 14\.3% → 16\.0%, power 1\.0 → 50\.0; warfare engaged 30 s; 1 death \(member-02\)\n/,
    );
    expect(text).toContain(
      "  clashes won and lost: not read, the game counts neither (the territory and power show what they came to)",
    );
    expect(fold([formed(crew), formed(crew)]).text).toMatch(/; warfare not read; no deaths\n/);
  });
});
