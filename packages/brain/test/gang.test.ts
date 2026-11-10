// The gang (#325, G1 of #324): the brain's rule on the snapshots, the gang faction left out of what the other rules
// see, the gate's guard on forming, and the run report's section with each of its failures. The rule against the real
// engine is gang-simulation.test.ts's; the formulas against it, gang-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  GANG_FACTIONS,
  GANG_STATS,
  type GangInformation,
  type GangMemberReading,
  type GangReading,
  type Intent,
  intentId,
  type MediumSnapshotData,
  parseGangState,
  type SlowSnapshotData,
  type SnapshotTier,
} from "@bitburner-agent/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { donationStatus } from "../src/augmentation-report.ts";
import { DesiredStateController } from "../src/desired-state.ts";
import {
  GANG_PLACED_ON_JUSTICE_SETTING,
  GangFactionCarry,
  GangRule,
  gangSnapshotOf,
  withoutGangFaction,
} from "../src/gang.ts";
import {
  GANG_FORM_WITHIN_MS,
  GANG_RECRUIT_WITHIN_MS,
  GANG_UNREAD_WITHIN_MS,
  GANG_WANTED_OUTCOME_MS,
  GANG_WANTED_OVER_BOUND_MS,
  GangFold,
} from "../src/gang-report.ts";
import { snapshotGuardFailure } from "../src/irreversible-gate.ts";
import { TelemetryStore } from "../src/telemetry-store.ts";
import { mediumData, slowData, staticServer } from "./helpers/snapshot-fixtures.ts";

const MINUTE = 60_000;
const expFor = (level: number) => Math.max(0, Math.exp((level + 200) / 32) - 534.5);

/** A member as the gang worker reads it: `hack` and `cha` levels, the rest 1, no multipliers. */
function member(name: string, hack = 1, task = "Unassigned"): GangMemberReading {
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
      gang: { recruit: [], tasks: {} },
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
      gang: { recruit: [], tasks: {} },
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
      tasks: { "member-01": "Train Hacking", "member-02": "Train Hacking", "member-03": "Train Hacking" },
    });
    expect(rule.gangFaction()).toBe("NiteSec");
    const grown = formed([member("member-01", 300), member("member-02", 40), member("member-03", 120)], {
      respect: 1_000,
      wantedPenalty: 0.999,
    });
    expect(rule.update({ mediumData: withGang(grown), slowData: slowData(2) }).gang).toEqual({
      recruit: ["member-04", "member-05", "member-06", "member-07"],
      tasks: {
        "member-01": "Plant Virus",
        "member-02": "Train Hacking",
        "member-03": "Phishing",
        "member-04": "Train Hacking",
        "member-05": "Train Hacking",
        "member-06": "Train Hacking",
        "member-07": "Train Hacking",
      },
    });
    expect(rule.view().line).toMatch(
      /^Gang: NiteSec's, 3 members of 12 \(1 on Plant Virus, 1 training, 1 on Phishing\);/,
    );
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
      text: "7. The gang (#325; played in BN2 only for now)\n  not in BN2 in the window: no gang played",
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
    const inBonusTime = withGang(formed(oneOnJustice, { ...higher, bonusTimeMs: 60_000 }));
    expect(fold(repeat(inBonusTime, steps(GANG_WANTED_OVER_BOUND_MS))).failures).toEqual([
      expect.stringMatching(/^the wanted penalty over the rule's bound, off course, for 23 min 10 s, /),
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
    expect(fold(repeat(wanted, steps(GANG_WANTED_OVER_BOUND_MS) - 1)).failures).toEqual([]);
    const { failures } = fold(repeat(wanted, steps(GANG_WANTED_OVER_BOUND_MS)));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^the wanted penalty over the rule's bound, off course, for 23 min 10 s, from .* \(37\.5% over 33\.3%, wanted 4, 0 of 3 on justice, off course\)$/,
    );
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

  test("the worker's problems are listed as first seen, and fail nothing by themselves", () => {
    const reading = { ...formed([member("member-01")]), problems: ["the game didn't set member-01 to Nap"] };
    const { text, failures } = fold([withGang(reading), withGang(reading)]);
    expect(text).toContain("    1970-01-01T00:00:00.000Z: the game didn't set member-01 to Nap");
    expect(failures).toEqual([]);
  });
});

test("the wanted grace is one justice member's time to halve the wanted level: about 23 min", () => {
  expect(GANG_WANTED_OVER_BOUND_MS / MINUTE).toBeCloseTo(23.09, 2);
});

describe("the controller (#325)", () => {
  const TOKEN = "the-token";
  let directory: string;
  let store: TelemetryStore;
  let channel: ControlChannel;
  let sequenceNumber = 0;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "gang-"));
    store = TelemetryStore.open(path.join(directory, "telemetry.sqlite"));
    channel = new ControlChannel({ token: TOKEN, clock: new ManualClock() });
    channel.setDeploymentState({ deployedId: "deployment-a", hold: false, deployFailed: false });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A brain with the hack loop off (its intents go at once), and an Agent connected, its static snapshot sent. */
  function connected() {
    store.setSetting("hackLoop.enabled", "false");
    const lines: string[] = [];
    const controller = new DesiredStateController({ channel, store, log: (line) => lines.push(line) });
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
    return { controller, send, last, lines };
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
    expect(last()?.gang).toEqual({ recruit: [], tasks: {} });
    expect(controller.intentsView()).toEqual([
      { id: FORM_NITESEC.id, source: "gang", outcome: null, waitingFor: expect.any(String) },
    ]);
    // Irreversible: not sent before its guard and a save backup (this brain takes none).
    expect(last()?.intents).toEqual([]);
    expect(lines).toContain("gang: forming with NiteSec");
    expect(controller.gangView().stage).toBe("forming");
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

  test("outside BN2: no gang in the state, nothing logged of it", () => {
    const { send, last, lines } = connected();
    send("slow", niteSecSlow(1));
    send("medium", niteSecMedium(NONE));
    expect(last()?.gang).toBeUndefined();
    expect(lines.filter((line) => line.startsWith("gang:"))).toEqual([]);
  });
});
