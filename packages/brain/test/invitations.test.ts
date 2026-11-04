// Travel for invitations and Daedalus's count (#228, owner decision 54): Tian Di Hui's travel and $1m hold, the city
// group the brain chooses each cycle, its travels and holds, the reach the World Daemon's line and failure read, and
// what the run report says of them. The live run of 2026-11-04 is the shape: 23 installed (the four hacker factions'
// set and NeuroFlux Governor), those four joined, hacking past 6,000, in Sector-12.
import {
  augmentationsSoldBy,
  daedalusCountOf,
  type FactionState,
  isWorthInstalling,
  type JoinedFaction,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  CITY_GROUP_CHOSEN_EVENT_KIND,
  type CityGroupValue,
  chooseCityGroup,
  cityGroupValues,
  cityInvitation,
  daedalusReach,
  describeCityGroupChoice,
  describeReach,
  INVITATION_NOT_SHOWN_AFTER_MS,
  INVITATION_TRAVEL_EVENT_KIND,
  type InvitationEvent,
  type InvitationInputs,
  InvitationRule,
  invitationHealthLines,
  invitationLines,
  planInvitations,
  travelIntent,
  visitsFor,
} from "../src/invitations.ts";

const HACKERS = ["CyberSec", "NiteSec", "The Black Hand", "BitRunners"];
/** The four hacker factions' augmentations with a hacking value: what run #2's first install bought. */
const HACKER_SET = [...new Set(HACKERS.flatMap((faction) => augmentationsSoldBy(faction, 1, null)))].filter((name) =>
  isWorthInstalling(name),
);
/** Run #2's 23: that set, and NeuroFlux Governor at 124 levels (one, `FactionJoinCondition.ts:130`). */
const RUN_2: Record<string, number> = {
  ...Object.fromEntries(HACKER_SET.map((name) => [name, 1])),
  "NeuroFlux Governor": 124,
};
const TIAN_DI_HUI_EIGHT = augmentationsSoldBy("Tian Di Hui", 1, null).filter((name) => name !== "NeuroFlux Governor");
const MINUTE = 60_000;
/** Money for every group's invitations and the tickets. */
const RICH = 11e15;
/** Money for Tian Di Hui's alone: no city group's. */
const TWO_MILLION = 2e6;

/** The faction state: `joined` (names, or factions), the invitations, the queue. */
function stateOf(
  joined: (string | JoinedFaction)[] = HACKERS,
  { invitations = [] as string[], queued = [] as string[] } = {},
): FactionState {
  const factions = joined.map((each) => (typeof each === "string" ? { name: each, reputation: 0, favor: 0 } : each));
  return { joined: factions, invitations, queuedAugmentations: queued };
}

/** The plan's inputs: run #2's end by default. */
function inputs(fields: Partial<InvitationInputs> & { state?: FactionState } = {}): InvitationInputs {
  const state = fields.state ?? stateOf();
  const installed = fields.installed ?? RUN_2;
  return {
    state,
    count: daedalusCountOf({
      currentNode: 1,
      ownedSF: {},
      installed,
      joined: state.joined,
      invitations: state.invitations,
    }),
    currentNode: 1,
    lastAugReset: 0,
    installed,
    hackingLevel: 6_368,
    money: RICH,
    city: "Sector-12",
    ...fields,
  };
}

test("run #2's end: 22 with a hacking value from the four, and NeuroFlux Governor: 23, short of 30", () => {
  expect(HACKER_SET).toHaveLength(22);
  expect(inputs().count).toEqual({ installed: 23, required: 30, short: true });
  expect(TIAN_DI_HUI_EIGHT).toHaveLength(8);
});

test("the city factions' invitations: the game's money and city (`Faction/FactionInfo.tsx:495-555`)", () => {
  expect(
    ["Sector-12", "Chongqing", "New Tokyo", "Ishima", "Aevum", "Volhaven"].map((faction) => [
      faction,
      cityInvitation(faction),
    ]),
  ).toEqual([
    ["Sector-12", { city: "Sector-12", money: 15e6 }],
    ["Chongqing", { city: "Chongqing", money: 20e6 }],
    ["New Tokyo", { city: "New Tokyo", money: 20e6 }],
    ["Ishima", { city: "Ishima", money: 30e6 }],
    ["Aevum", { city: "Aevum", money: 40e6 }],
    ["Volhaven", { city: "Volhaven", money: 50e6 }],
  ]);
  expect(() => cityInvitation("CyberSec")).toThrow(/isn't a city faction/);
});

describe("Tian Di Hui (no city group the money can earn)", () => {
  test("short, in Sector-12 with the hacking and $1.2m: to Ishima, for its eight", () => {
    const plan = planInvitations(inputs({ money: TWO_MILLION }));
    expect(plan).toMatchObject({ travel: "Ishima", hold: 0, group: null, tianDiHui: TIAN_DI_HUI_EIGHT });
    expect(travelIntent("Ishima")).toEqual({ id: "travel(Ishima)", action: "travel", args: { city: "Ishima" } });
  });

  test("not short: only those with a hacking value are wanted, ADR-V1 and S.N.A; with them owned, no travel", () => {
    // Daedalus inviting: the count met.
    const notShort = (installed: Record<string, number>) =>
      inputs({ installed, state: stateOf(["CyberSec"], { invitations: ["Daedalus"] }), money: TWO_MILLION });
    const fresh = notShort({});
    expect(fresh.count.short).toBe(false);
    expect(planInvitations(fresh)).toMatchObject({
      travel: "Ishima",
      tianDiHui: ["ADR-V1 Pheromone Gene", "Social Negotiation Assistant (S.N.A)"],
    });
    const both = { "ADR-V1 Pheromone Gene": 1, "Social Negotiation Assistant (S.N.A)": 1 };
    expect(planInvitations(notShort(both))).toMatchObject({
      travel: null,
      hold: 0,
      tianDiHui: [],
    });
  });

  test("each precondition: joined, invited, hacking 50, the money for $1m and the ticket", () => {
    const tdh = (fields: Partial<InvitationInputs> & { state?: FactionState }) =>
      planInvitations(inputs({ money: TWO_MILLION, ...fields }));
    expect(tdh({ state: stateOf([...HACKERS, "Tian Di Hui"]) }).travel).toBeNull();
    // Joined, it's no stop of the groups' visits: A's from Sector-12 is one travel (Aevum), not two.
    const joinedTdh = cityGroupValues(inputs({ state: stateOf([...HACKERS, "Tian Di Hui"]) }));
    expect(joinedTdh[0]).toMatchObject({ group: "A", travels: 1 });
    expect(tdh({ state: stateOf(HACKERS, { invitations: ["Tian Di Hui"] }) }).travel).toBeNull();
    const short49 = tdh({ hackingLevel: 49 });
    expect(short49.travel).toBeNull();
    expect(short49.waitingFor).toMatch(
      /^hacking 50 for Tian Di Hui's invitation \(49 now\); the money for a city group's /,
    );
    expect(tdh({ hackingLevel: 50 }).travel).toBe("Ishima");
    expect(tdh({ money: 1_199_999 })).toMatchObject({
      travel: null,
      hold: 0,
      waitingFor: "$1,200,000 to travel to Ishima for Tian Di Hui's invitation ($1,199,999 now)",
    });
    expect(tdh({ money: 1_200_000 }).travel).toBe("Ishima");
  });

  test("in Ishima: no travel, $1m held, whatever the money; elsewhere, to Ishima", () => {
    expect(planInvitations(inputs({ city: "Ishima", money: TWO_MILLION }))).toMatchObject({ travel: null, hold: 1e6 });
    expect(planInvitations(inputs({ city: "Ishima", money: 0 }))).toMatchObject({ travel: null, hold: 1e6 });
    for (const city of ["Aevum", "Volhaven", "Chongqing"]) {
      expect(planInvitations(inputs({ city, money: TWO_MILLION })).travel).toBe("Ishima");
    }
    // Hacking short, nothing held: the invitation couldn't come.
    expect(planInvitations(inputs({ city: "Ishima", hackingLevel: 10, money: TWO_MILLION })).hold).toBe(0);
  });
});

describe("the city group (owner decision 54)", () => {
  test("short: how many each sells that count, not sold by a joined faction or Tian Di Hui: B 5, A 4, C 3", () => {
    const values = cityGroupValues(inputs());
    expect(
      values.map(({ group, factions, value, travels, money }) => ({ group, factions, value, travels, money })),
    ).toEqual([
      { group: "A", factions: ["Sector-12", "Aevum"], value: 4, travels: 2, money: 40e6 + 2 * 200e3 },
      { group: "B", factions: ["Chongqing", "New Tokyo", "Ishima"], value: 5, travels: 3, money: 30e6 + 3 * 200e3 },
      { group: "C", factions: ["Volhaven"], value: 3, travels: 2, money: 50e6 + 2 * 200e3 },
    ]);
    // Tian Di Hui's Wired Reflexes and Speech Processor Implant are its, not the groups'.
    expect(values[0]?.augmentations).toEqual([
      "Augmented Targeting I",
      "Augmented Targeting II",
      "CashRoot Starter Kit",
      "PCMatrix",
    ]);
    const plan = planInvitations(inputs());
    expect(plan.group?.group).toBe("B");
    expect(plan.cityFactions).toEqual(["Chongqing", "New Tokyo", "Ishima"]);
    expect(
      describeCityGroupChoice({
        group: "B",
        factions: plan.cityFactions,
        short: true,
        values: values.map(({ group, value, affordable }) => ({ group, value, affordable })),
      }),
    ).toBe("group B (Chongqing, New Tokyo, Ishima): 5 augmentations that count, against A 4, C 3");
    // Short of hacking 50, Tian Di Hui's are the groups' to sell.
    expect(cityGroupValues(inputs({ hackingLevel: 40 })).map((each) => each.value)).toEqual([6, 8, 6]);
  });

  test("not short: their hacking values summed; B's DataJack, Neuralstimulator and Neuregen", () => {
    const fresh = inputs({
      installed: {},
      state: stateOf(["CyberSec"], { invitations: ["Daedalus"] }),
      hackingLevel: 100,
    });
    const values = cityGroupValues(fresh);
    expect(values.map((each) => each.augmentations)).toEqual([
      ["Neuralstimulator", "PCMatrix"],
      ["DataJack", "Neuralstimulator", "Neuregen Gene Modification"],
      ["Neuralstimulator"],
    ]);
    expect(values[1]?.value).toBeGreaterThan(values[0]?.value as number);
    expect(planInvitations(fresh).group?.group).toBe("B");
    const choice = { group: "B", factions: ["Chongqing"], short: false, values };
    expect(describeCityGroupChoice(choice)).toMatch(
      /^group B \(Chongqing\): hacking value \d\.\d\d, against A \d\.\d\d, C \d\.\d\d$/,
    );
  });

  test("the money: each group's invitations and tickets; short of every group's, none chosen, Tian Di Hui's alone", () => {
    expect(planInvitations(inputs({ money: 30.6e6 })).group?.group).toBe("B");
    const poorer = planInvitations(inputs({ money: 30.6e6 - 1 }));
    expect(poorer.values.every((each) => !each.affordable)).toBe(true);
    expect(poorer).toMatchObject({ group: null, cityFactions: [], travel: "Ishima" });
  });

  test("the choice's ties: the fewest travels, then the groups' order; none without value; the one joined fixed", () => {
    const group = (name: string, value: number, travels: number, affordable = true): CityGroupValue => ({
      group: name,
      factions: [],
      augmentations: [],
      value,
      travels,
      money: 0,
      affordable,
    });
    const state = stateOf();
    expect(chooseCityGroup([group("A", 3, 2), group("B", 3, 1), group("C", 2, 0)], state)?.group).toBe("B");
    expect(chooseCityGroup([group("A", 3, 1), group("B", 3, 1), group("C", 3, 1)], state)?.group).toBe("A");
    expect(chooseCityGroup([group("A", 3, 1, false), group("B", 2, 3), group("C", 0, 0)], state)?.group).toBe("B");
    expect(chooseCityGroup([group("A", 0, 1), group("B", 0, 1), group("C", 0, 1)], state)).toBeNull();
    // Kept for the cycle once chosen, whatever the money or the value; a city faction joined fixes it too.
    expect(chooseCityGroup([group("A", 9, 1), group("B", 1, 1, false), group("C", 0, 0)], state, "B")?.group).toBe("B");
    expect(chooseCityGroup([group("A", 9, 1), group("B", 0, 1), group("C", 0, 0)], state, "B")?.group).toBe("B");
    const volhaven = stateOf([...HACKERS, "Volhaven"]);
    expect(chooseCityGroup([group("A", 9, 1), group("B", 0, 1), group("C", 5, 0)], volhaven)?.group).toBe("C");
  });

  test("the visits: the one where the player is first; Tian Di Hui's with B's Ishima, last, or first for A and C", () => {
    expect(visitsFor("B", ["Chongqing", "Ishima"], true, "Sector-12")).toEqual([
      { city: "Chongqing", factions: ["Chongqing"], money: 20e6 },
      { city: "Ishima", factions: ["Ishima", "Tian Di Hui"], money: 30e6 },
    ]);
    expect(visitsFor("A", ["Sector-12", "Aevum"], true, "Sector-12").map((each) => each.city)).toEqual([
      "Sector-12",
      "Ishima",
      "Aevum",
    ]);
    expect(visitsFor("C", ["Volhaven"], false, "Sector-12")).toEqual([
      { city: "Volhaven", factions: ["Volhaven"], money: 50e6 },
    ]);
    expect(visitsFor(null, [], true, "Aevum")).toEqual([{ city: "Ishima", factions: ["Tian Di Hui"], money: 1e6 }]);
  });

  test("B's way: Chongqing's money held there, then New Tokyo, then Ishima with Tian Di Hui; it ends in Ishima", () => {
    expect(planInvitations(inputs())).toMatchObject({ travel: "Chongqing" });
    expect(planInvitations(inputs({ city: "Chongqing" }))).toMatchObject({ travel: null, hold: 20e6 });
    const at = (city: string, invitations: string[], joined: string[] = []) =>
      planInvitations(inputs({ city, state: stateOf([...HACKERS, ...joined], { invitations }) }), {
        group: "B",
        factions: ["Chongqing", "New Tokyo", "Ishima"],
      });
    expect(at("Chongqing", ["Chongqing"])).toMatchObject({ travel: "New Tokyo" });
    expect(at("New Tokyo", ["Chongqing", "New Tokyo"])).toMatchObject({ travel: "Ishima" });
    expect(at("Ishima", ["Chongqing", "New Tokyo"])).toMatchObject({ travel: null, hold: 30e6 });
    // Every invitation shown, but in New Tokyo: on to Ishima, its tech vendor.
    const all = ["Chongqing", "New Tokyo", "Ishima", "Tian Di Hui"];
    expect(at("New Tokyo", [], all)).toMatchObject({ travel: "Ishima" });
    expect(at("Ishima", [], all).travel).toBeNull();
  });
});

describe("the rule, as the controller runs it", () => {
  let lines: string[];
  let events: InvitationEvent[];
  let rule: InvitationRule;
  beforeEach(() => {
    lines = [];
    events = [];
    rule = new InvitationRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
  });
  const phases = () =>
    events.flatMap((event) =>
      event.type === INVITATION_TRAVEL_EVENT_KIND ? [[event.atMs, event.phase, event.city]] : [],
    );

  test("Tian Di Hui alone: the travel, the hold in Ishima, then the invitation; each logged and stored once", () => {
    const tdh = (fields: Partial<InvitationInputs> & { state?: FactionState } = {}) =>
      inputs({ money: TWO_MILLION, ...fields });
    expect(rule.update({ inputs: tdh(), stood: null, nowMs: 0 })).toEqual(travelIntent("Ishima"));
    expect(rule.update({ inputs: tdh(), stood: null, nowMs: 1_000 })).toEqual(travelIntent("Ishima"));
    expect(rule.update({ inputs: tdh({ city: "Ishima" }), stood: null, nowMs: 2_000 })).toBeNull();
    expect(rule.hold()).toBe(1e6);
    const invited = tdh({ city: "Ishima", state: stateOf(HACKERS, { invitations: ["Tian Di Hui"] }) });
    rule.update({ inputs: invited, stood: null, nowMs: 3_000 });
    expect(rule.hold()).toBe(0);
    expect(phases()).toEqual([
      [0, "travel", "Ishima"],
      [2_000, "hold", "Ishima"],
      [3_000, "invited", "Ishima"],
    ]);
    expect(lines).toEqual([
      "invitations: travelling to Ishima for Tian Di Hui's invitation (Daedalus's count: 23 of 30 installed)",
      "invitations: in Ishima: $1,000,000 held for Tian Di Hui's invitation (Daedalus's count: 23 of 30 installed)",
      "invitations: Tian Di Hui invited in Ishima",
    ]);
  });

  test("the group chosen, stored once; kept for the cycle with its factions, chosen afresh after an install", () => {
    rule.update({ inputs: inputs(), stood: null, nowMs: 0 });
    // The money gone: B kept (its travel waits for money).
    rule.update({ inputs: inputs({ money: 0 }), stood: null, nowMs: 1_000 });
    expect(rule.view().cityGroup).toMatch(/^group B /);
    expect(rule.cityFactions()).toEqual(["Chongqing", "New Tokyo", "Ishima"]);
    const choices = () => events.filter((event) => event.type === CITY_GROUP_CHOSEN_EVENT_KIND);
    expect(choices()).toEqual([
      {
        type: CITY_GROUP_CHOSEN_EVENT_KIND,
        atMs: 0,
        group: "B",
        factions: ["Chongqing", "New Tokyo", "Ishima"],
        short: true,
        values: [
          { group: "A", value: 4, affordable: true },
          { group: "B", value: 5, affordable: true },
          { group: "C", value: 3, affordable: true },
        ],
      },
    ]);
    expect(lines[0]).toBe(
      "invitations: city factions: group B (Chongqing, New Tokyo, Ishima): 5 augmentations that count, against A 4, C 3",
    );
    // Chongqing joined, and Daedalus inviting (the count met: no longer short), so New Tokyo's NutriGen is worth nothing
    // now; still B's to join, as chosen.
    const chongqing = inputs({ state: stateOf([...HACKERS, "Chongqing"], { invitations: ["Daedalus"] }) });
    expect(chongqing.count.short).toBe(false);
    rule.update({ inputs: chongqing, stood: null, nowMs: 1_500 });
    expect(rule.cityFactions()).toEqual(["New Tokyo", "Ishima"]);
    // An install: B's five installed, so A is worth the most now.
    const b = cityGroupValues(inputs())[1]?.augmentations ?? [];
    const after = { ...RUN_2, ...Object.fromEntries(b.map((name) => [name, 1])) };
    rule.update({ inputs: inputs({ lastAugReset: 5, installed: after }), stood: null, nowMs: 2_000 });
    expect(choices().map((event) => event.group)).toEqual(["B", "A"]);
  });

  test("an install under way: nothing travelled for or held; from Chongqing or New Tokyo, on to Ishima's vendor", () => {
    expect(rule.update({ inputs: inputs(), stood: null, beforeInstall: true, nowMs: 0 })).toBeNull();
    expect(rule.view()).toMatchObject({ travel: null, hold: 0 });
    expect(rule.update({ inputs: inputs({ city: "Ishima" }), stood: null, beforeInstall: true, nowMs: 0 })).toBeNull();
    expect(rule.hold()).toBe(0);
    for (const city of ["Chongqing", "New Tokyo"]) {
      expect(rule.update({ inputs: inputs({ city }), stood: null, beforeInstall: true, nowMs: 0 })).toEqual(
        travelIntent("Ishima"),
      );
    }
    expect(phases().at(-1)).toEqual([0, "travel", "Ishima"]);
  });

  test("the owner's work, the switch off or an install chosen: no travel, saying why; the group still chosen", () => {
    expect(rule.update({ inputs: inputs(), stood: "your work on the dashboard", nowMs: 0 })).toBeNull();
    expect(rule.view()).toMatchObject({ travel: null, waitingFor: "your work on the dashboard" });
    expect(rule.cityFactions()).toEqual(["Chongqing", "New Tokyo", "Ishima"]);
    expect(rule.update({ inputs: null, stood: null, nowMs: 0 })).toBeNull();
    expect(rule.view()).toMatchObject({ hold: 0, waitingFor: "the Agent's snapshots" });
  });

  test("held 5 minutes with the money and no invitation: NOT INVITED, logged and stored once", () => {
    const chongqing = inputs({ city: "Chongqing" });
    rule.update({ inputs: chongqing, stood: null, nowMs: 0 });
    rule.update({ inputs: chongqing, stood: null, nowMs: INVITATION_NOT_SHOWN_AFTER_MS - 1 });
    expect(phases()).toEqual([[0, "hold", "Chongqing"]]);
    rule.update({ inputs: chongqing, stood: null, nowMs: INVITATION_NOT_SHOWN_AFTER_MS });
    rule.update({ inputs: chongqing, stood: null, nowMs: INVITATION_NOT_SHOWN_AFTER_MS + MINUTE });
    expect(phases()).toEqual([
      [0, "hold", "Chongqing"],
      [INVITATION_NOT_SHOWN_AFTER_MS, "notInvited", "Chongqing"],
    ]);
    expect(lines.at(-1)).toBe(
      "invitations: NOT INVITED: 5 min in Chongqing with hacking 6368 and $11,000,000,000,000,000, and no Chongqing's " +
        "invitation",
    );
  });

  test("short of the money, the hold is still gathering it: the clock runs from the last update short of it", () => {
    // Volhaven joined: group C fixed, nothing more of it to visit; Tian Di Hui's $1m in Ishima.
    const ishima = (money: number) => inputs({ city: "Ishima", money, state: stateOf([...HACKERS, "Volhaven"]) });
    rule.update({ inputs: ishima(900_000), stood: null, nowMs: 0 });
    rule.update({ inputs: ishima(999_999), stood: null, nowMs: 10 * MINUTE });
    rule.update({ inputs: ishima(1e6), stood: null, nowMs: 11 * MINUTE });
    rule.update({ inputs: ishima(1e6), stood: null, nowMs: 15 * MINUTE - 1 });
    expect(phases()).toEqual([[0, "hold", "Ishima"]]);
    rule.update({ inputs: ishima(1e6), stood: null, nowMs: 15 * MINUTE });
    expect(phases()).toEqual([
      [0, "hold", "Ishima"],
      [15 * MINUTE, "notInvited", "Ishima"],
    ]);
  });
});

describe("the reach", () => {
  test("run #2's end: The Black Hand 1, BitRunners 1, Tian Di Hui 8, and the group selling the most of the rest", () => {
    const reach = daedalusReach(stateOf(), 1, RUN_2, 6_368);
    expect(reach.by.slice(0, 3)).toEqual([
      { faction: "The Black Hand", count: 1 },
      { faction: "BitRunners", count: 1 },
      { faction: "Tian Di Hui", count: 8 },
    ]);
    // Group B's five after Tian Di Hui's.
    expect(reach.by.slice(3).map((each) => each.faction)).toEqual(["Chongqing", "New Tokyo", "Ishima"]);
    expect(reach.more).toBe(15);
    expect(describeReach(reach)).toMatch(/^15 more within reach \(The Black Hand 1, BitRunners 1, Tian Di Hui 8, /);
  });

  test("Tian Di Hui only at hacking 50; an invitation without enemies counts; the group a city faction joined", () => {
    expect(daedalusReach(stateOf(), 1, RUN_2, 49).by.map((each) => each.faction)).not.toContain("Tian Di Hui");
    const invited = daedalusReach(stateOf(HACKERS, { invitations: ["Netburners"] }), 1, RUN_2, 49);
    expect(invited.by.map((each) => each.faction)).toContain("Netburners");
    const volhaven = daedalusReach(stateOf([...HACKERS, "Volhaven"]), 1, RUN_2, 49);
    expect(volhaven.by.map((each) => each.faction)).toEqual(["The Black Hand", "BitRunners", "Volhaven"]);
  });

  test("queued ones count (the next install installs them); NeuroFlux Governor once; never The Red Pill", () => {
    const queued = daedalusReach(stateOf(HACKERS, { queued: ["Neural Wit Amplifier"] }), 1, RUN_2, 6_368);
    expect(queued.more).toBe(15);
    expect(daedalusReach(stateOf(["CyberSec"]), 1, {}, 1).by[0]).toEqual({ faction: "CyberSec", count: 6 });
    expect(daedalusReach(stateOf(["Daedalus"]), 1, RUN_2, 1).by[0]).toEqual({ faction: "Daedalus", count: 6 });
    expect(describeReach({ more: 0, by: [] })).toBe("none more within reach");
  });
});

describe("what the run report says", () => {
  const stored = (atMs: number, phase: string, city = "Ishima", factions = ["Tian Di Hui"], money = 0) => ({
    atMs,
    kind: INVITATION_TRAVEL_EVENT_KIND,
    detail: { phase, city, factions, money, installed: 23, required: 30 },
  });
  const time = (ms: number) => `t${ms}`;

  test("the factions section: the group chosen, the travels, the holds and the invitations; none, said", () => {
    const chosen = {
      atMs: 0,
      kind: CITY_GROUP_CHOSEN_EVENT_KIND,
      detail: {
        group: "B",
        factions: ["Chongqing", "New Tokyo", "Ishima"],
        short: true,
        values: [
          { group: "A", value: 4, affordable: true },
          { group: "B", value: 5, affordable: true },
          { group: "C", value: 3, affordable: false },
        ],
      },
    };
    const travel = stored(1, "travel", "Chongqing", ["Chongqing"]);
    const hold = stored(2, "hold", "Chongqing", ["Chongqing"], 20e6);
    expect(invitationLines([chosen, travel, hold], time)).toEqual([
      "    invitations travelled for (Tian Di Hui, and the city group the brain chose, decision 54):",
      "      t0  city factions: group B (Chongqing, New Tokyo, Ishima): 5 augmentations that count, against A 4, C 3 " +
        "(the money short)",
      "      t1  travel to Chongqing for Chongqing's invitation (23 of 30 installed)",
      "      t2  $20,000,000 held in Chongqing for Chongqing's invitation",
    ]);
    expect(invitationLines([stored(3, "invited")], time).at(-1)).toBe("      t3  invited: Tian Di Hui, in Ishima");
    expect(invitationLines([], time).at(-1)).toBe("      none");
  });

  test("section 4: no invitation is a failure", () => {
    const failures: string[] = [];
    expect(invitationHealthLines([stored(1, "hold"), stored(2, "notInvited")], failures, time)).toEqual([
      "  invitations not shown (in the city with the money for 5 min, #228):",
      "    NOT INVITED 5 min into the hold in Ishima: Tian Di Hui (23 of 30 installed), at t2",
    ]);
    expect(failures).toEqual(["NOT INVITED 5 min into the hold in Ishima: Tian Di Hui (23 of 30 installed), at t2"]);
    const none: string[] = [];
    expect(invitationHealthLines([stored(1, "hold")], none, time).at(-1)).toBe("    none");
    expect(none).toEqual([]);
  });
});
