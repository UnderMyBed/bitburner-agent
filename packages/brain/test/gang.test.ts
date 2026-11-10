// The gang (#325, G1 of #324; ascension #328, G2; equipment #330, G3): the brain's rule on the snapshots, the gang
// faction left out of what the other rules see, the gate's guard on forming, the equipment's hold, and the run report's
// section with each of its failures.
// The rule against the real engine is gang-simulation.test.ts's; the formulas against it, gang-parity.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlChannel } from "@bitburner-agent/bridge";
import { ManualClock, MemoryConnection } from "@bitburner-agent/bridge/test-helpers";
import {
  AUGMENTATION_NAMES,
  CONTROL_PROTOCOL_VERSION,
  type DesiredState,
  encodeControlMessage,
  GANG_FACTIONS,
  GANG_STATS,
  type GangInformation,
  type GangMemberReading,
  type GangReading,
  gangMemberAscended,
  gangSkillLevel,
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
  gangMoneyHoldOf,
  gangSnapshotOf,
  withoutGangFaction,
} from "../src/gang.ts";
import {
  GANG_ASCEND_WITHIN_MS,
  GANG_EQUIP_WITHIN_MS,
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
      gang: { recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null },
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
      gang: { recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null },
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
    });
    expect(rule.view().line).toMatch(/^Gang: NiteSec's, 3 members of 12 \(2 training, 1 on Phishing\);/);
    expect(rule.view().line).toMatch(/; ascending member-01 \(multipliers up to ×\d+\.\d\d, 0 respect lost\)$/);
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
    expect(rule.view().line).toMatch(/; no ascension due within a day$/);
    // Trained to hacking 81, about 10 minutes from level 1: a few minutes' work on, it would.
    const nearly = [member("member-01", 81, "Ransomware"), ...three.slice(1)];
    rule.update({ mediumData: withGang(formed(nearly, { respect: 4 })), slowData: slowData(2) });
    expect(rule.view().line).toMatch(/; next ascension: member-01's, in about \d+ min$/);
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
      text: "7. The gang (#325, ascension G2, equipment G3; played in BN2 only for now)\n  not in BN2 in the window: no gang played",
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

  test("ascensions (G2) by hour, each with its gain and the respect it had earned; one the rule makes undone for 1 min fails", () => {
    // member-01 never ascended, its levels all experience: the rule ascends it (respect 4: no recruit due).
    const ready = { ...member("member-01", 300, "Plant Virus"), earnedRespect: 12 };
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

/** Every rootkit (G3): a grown member has them, so only an augmentation is left to pay. */
const ROOTKITS = ["NUKE Rootkit", "Soulstealer Rootkit", "Demon Rootkit", "Hmap Node", "Jack the Ripper"];

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
    expect(last()?.gang).toEqual({ recruit: [], ascend: [], tasks: {}, buy: [], keepMoney: null });
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

  test("equipment (G3): bought from the money above the brain's holds, this round's purchase held on top", () => {
    const { controller, send, last } = connected();
    send("slow", niteSecSlow(2));
    const grown = {
      ...member("member-01", 1, "Train Hacking"),
      hack_asc_mult: 200,
      hack_asc_points: 80e6,
      hack_exp: 1e6,
      hack: gangSkillLevel(1e6, 200),
      upgrades: ROOTKITS,
      augmentations: [],
    };
    const data = niteSecMedium(
      formed([grown, member("member-02"), member("member-03")], {
        respect: 1_000,
        wantedPenalty: 0.999,
        equipmentCostMult: 1,
      }),
    );
    data.player = { ...data.player, money: 1e11 };
    send("medium", data);
    expect(last()?.gang?.buy).toEqual([{ name: "member-01", equipment: "Neuralstimulator", pointsBefore: 80e6 }]);
    // The holds: the travel for an invitation's (a city faction's money requirement, #228) and, on top, the TOR
    // router going out this round, $200,000.
    expect(last()?.intents.map((each) => each.id)).toEqual(["buyTor(Alpha Enterprises)"]);
    const invitation = controller.invitationsView().hold;
    expect(invitation).toBeGreaterThan(0);
    expect(last()?.gang?.keepMoney).toBe(invitation + 200_000);
    expect(controller.gangView().line).toContain("; equipment: buying Neuralstimulator for member-01");
  });

  test("equipment (G3): Daedalus's $100b, held from home RAM, held from gang equipment too", () => {
    const { send, last } = connected();
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
    // The most of the holds, Daedalus's, and the TOR router going out on top.
    expect(last()?.intents.map((each) => each.id)).toContain("buyTor(Alpha Enterprises)");
    expect(last()?.gang?.keepMoney).toBe(100e9 + 200_000);
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
  /**
   * A hacker far grown, training: ascension multiplier 200, a million experience (hacking 48,000), its ascension not
   * paying (×1.006), with every rootkit already. An augmentation pays it back within a day (core's
   * `GANG_AUGMENTATION_HORIZON_MS`).
   */
  const strong = (name: string, changes: Partial<GangMemberReading> = {}): GangMemberReading => ({
    ...member(name, 1, "Train Hacking"),
    hack_asc_mult: 200,
    hack_asc_points: 80e6,
    hack_exp: 1e6,
    hack: gangSkillLevel(1e6, 200),
    upgrades: ROOTKITS,
    augmentations: [],
    ...changes,
  });
  const GROWN = { respect: 1_000, wantedPenalty: 0.999, equipmentCostMult: 1 };
  /** A medium snapshot with the members read and the player's `money`, `keepMoney` the worker's echo. */
  const reading = (members: GangMemberReading[], money: number, keepMoney: number | null = null) => {
    const data = withGang({ ...formed(members, GROWN), keepMoney });
    return { ...data, player: { ...data.player, money } } as MediumSnapshotData;
  };
  const HOLD = { amount: 1e8, forWhat: "the augmentations to buy before the install" };
  const three = (first = strong("member-01")) => [
    first,
    member("member-02", 1, "Train Hacking"),
    member("member-03", 1, "Train Hacking"),
  ];
  const NEURALSTIMULATOR = 10e9;

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
    expect(state?.buy).toEqual([{ name: "member-01", equipment: "Neuralstimulator", pointsBefore: 80e6 }]);
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
    expect(rule.view().line).toMatch(/; equipment: no equipment pays back within its horizon$/);
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
  });
});
