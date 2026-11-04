// Reaching Daedalus's count (#228): the travel for Tian Di Hui's invitation and the $1m held for it, the reach the World
// Daemon's line and failure read, and what the run report says of them. The live run of 2026-11-04 is the shape: 23
// installed (the four hacker factions' set and NeuroFlux Governor), those four joined, hacking past 6,000, in Sector-12.
import {
  augmentationsSoldBy,
  daedalusCountOf,
  type FactionState,
  isWorthInstalling,
  type JoinedFaction,
} from "@bitburner-agent/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  daedalusReach,
  describeReach,
  planTianDiHui,
  TIAN_DI_HUI_EVENT_KIND,
  TIAN_DI_HUI_NOT_INVITED_AFTER_MS,
  TIAN_DI_HUI_TRAVEL_INTENT,
  type TianDiHuiEvent,
  type TianDiHuiInputs,
  TianDiHuiRule,
  tianDiHuiHealthLines,
  tianDiHuiLines,
} from "../src/daedalus-count.ts";

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

/** The faction state: `joined` (name → reputation), the invitations, the queue. */
function stateOf(
  joined: string[] = HACKERS,
  { invitations = [] as string[], queued = [] as string[] } = {},
): FactionState {
  const factions: JoinedFaction[] = joined.map((name) => ({ name, reputation: 0, favor: 0 }));
  return { joined: factions, invitations, queuedAugmentations: queued };
}

/** The plan's inputs: run #2's end by default. */
function inputs(fields: Partial<TianDiHuiInputs> & { state?: FactionState } = {}): TianDiHuiInputs {
  const state = fields.state ?? stateOf();
  const installed = fields.installed ?? RUN_2;
  return {
    state,
    count: daedalusCountOf({
      currentNode: 1,
      ownedSF: {},
      installed,
      queued: state.queuedAugmentations,
      joined: state.joined,
      invitations: state.invitations,
    }),
    currentNode: 1,
    installed,
    hackingLevel: 6_368,
    money: 11e15,
    city: "Sector-12",
    ...fields,
  };
}

test("run #2's end: 22 with a hacking value from the four, and NeuroFlux Governor: 23, short of 30", () => {
  expect(HACKER_SET).toHaveLength(22);
  expect(inputs().count).toEqual({ installed: 23, required: 30, short: true });
  expect(TIAN_DI_HUI_EIGHT).toHaveLength(8);
});

describe("the travel for Tian Di Hui's invitation", () => {
  test("short, in Sector-12 with the hacking and the money: travel to Ishima, for its eight", () => {
    expect(planTianDiHui(inputs())).toEqual({ travel: true, hold: 0, wanted: TIAN_DI_HUI_EIGHT, waitingFor: null });
    expect(TIAN_DI_HUI_TRAVEL_INTENT).toEqual({ id: "travel(Ishima)", action: "travel", args: { city: "Ishima" } });
  });

  test("not short: only those with a hacking value are wanted, ADR-V1 and S.N.A; with them owned, no travel", () => {
    // CyberSec's five not installed: the hacking way lasts.
    const fresh = inputs({ installed: {}, state: stateOf(["CyberSec"]) });
    expect(fresh.count.short).toBe(false);
    expect(planTianDiHui(fresh)).toMatchObject({
      travel: true,
      wanted: ["ADR-V1 Pheromone Gene", "Social Negotiation Assistant (S.N.A)"],
    });
    const both = { "ADR-V1 Pheromone Gene": 1, "Social Negotiation Assistant (S.N.A)": 1 };
    expect(planTianDiHui(inputs({ installed: both, state: stateOf(["CyberSec"]) }))).toEqual({
      travel: false,
      hold: 0,
      wanted: [],
      waitingFor: "nothing Tian Di Hui sells that A6 would install, not owned",
    });
    // Queued counts as owned.
    const queued = stateOf(["CyberSec"], { queued: ["ADR-V1 Pheromone Gene", "Social Negotiation Assistant (S.N.A)"] });
    expect(planTianDiHui(inputs({ installed: {}, state: queued })).wanted).toEqual([]);
  });

  test("each precondition: joined, invited, hacking 50, the money for $1m and the ticket", () => {
    expect(planTianDiHui(inputs({ state: stateOf([...HACKERS, "Tian Di Hui"]) }))).toMatchObject({
      travel: false,
      hold: 0,
      waitingFor: "Tian Di Hui joined",
    });
    expect(planTianDiHui(inputs({ state: stateOf(HACKERS, { invitations: ["Tian Di Hui"] }) }))).toMatchObject({
      travel: false,
      hold: 0,
      waitingFor: "Tian Di Hui's invitation, to join",
    });
    expect(planTianDiHui(inputs({ hackingLevel: 49 }))).toMatchObject({
      travel: false,
      waitingFor: "hacking 50 for Tian Di Hui's invitation (49 now)",
    });
    expect(planTianDiHui(inputs({ hackingLevel: 50 })).travel).toBe(true);
    expect(planTianDiHui(inputs({ money: 1_199_999 }))).toMatchObject({
      travel: false,
      hold: 0,
      waitingFor: "$1,200,000 to travel to Ishima for Tian Di Hui ($1,199,999 now)",
    });
    expect(planTianDiHui(inputs({ money: 1_200_000 })).travel).toBe(true);
  });

  test("in a Tian Di Hui city: no travel, $1m held, whatever the money; elsewhere, travel", () => {
    for (const city of ["Ishima", "Chongqing", "New Tokyo"]) {
      expect(planTianDiHui(inputs({ city }))).toMatchObject({ travel: false, hold: 1e6, waitingFor: null });
      expect(planTianDiHui(inputs({ city, money: 0 }))).toMatchObject({ travel: false, hold: 1e6 });
    }
    for (const city of ["Sector-12", "Aevum", "Volhaven"]) expect(planTianDiHui(inputs({ city })).travel).toBe(true);
    // Hacking short, nothing held: the invitation couldn't come.
    expect(planTianDiHui(inputs({ city: "Ishima", hackingLevel: 10 })).hold).toBe(0);
  });
});

describe("the reach", () => {
  test("run #2's end: 10 more, BitRunners 1, The Black Hand 1, Tian Di Hui 8", () => {
    const reach = daedalusReach(stateOf(), 1, RUN_2, 6_368);
    expect(reach).toEqual({
      more: 10,
      by: [
        { faction: "The Black Hand", count: 1 },
        { faction: "BitRunners", count: 1 },
        { faction: "Tian Di Hui", count: 8 },
      ],
    });
    expect(describeReach(reach)).toBe("10 more within reach (The Black Hand 1, BitRunners 1, Tian Di Hui 8)");
  });

  test("Tian Di Hui only at hacking 50; an invitation without enemies counts, one with enemies doesn't", () => {
    expect(daedalusReach(stateOf(), 1, RUN_2, 49)).toMatchObject({ more: 2 });
    // Netburners invites (no enemies, five Hacknet ones); Sector-12 too (enemies: the owner's).
    const invited = daedalusReach(stateOf(HACKERS, { invitations: ["Netburners", "Sector-12"] }), 1, RUN_2, 49);
    expect(invited.by.map((each) => each.faction)).toEqual(["The Black Hand", "BitRunners", "Netburners"]);
    expect(invited.more).toBe(7);
  });

  test("queued ones count (the next install installs them); NeuroFlux Governor once, while none is installed", () => {
    const queued = daedalusReach(stateOf(HACKERS, { queued: ["Neural Wit Amplifier"] }), 1, RUN_2, 6_368);
    expect(queued.more).toBe(10);
    // Nothing installed, CyberSec alone: its five and NeuroFlux Governor.
    expect(daedalusReach(stateOf(["CyberSec"]), 1, {}, 1)).toEqual({ more: 6, by: [{ faction: "CyberSec", count: 6 }] });
    expect(describeReach({ more: 0, by: [] })).toBe("none more within reach");
  });

  test("The Red Pill never counts toward it", () => {
    expect(daedalusReach(stateOf(["Daedalus"]), 1, RUN_2, 1).by).toEqual([{ faction: "Daedalus", count: 6 }]);
  });
});

describe("the rule, as the controller runs it", () => {
  let lines: string[];
  let events: TianDiHuiEvent[];
  let rule: TianDiHuiRule;
  beforeEach(() => {
    lines = [];
    events = [];
    rule = new TianDiHuiRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
  });
  const phases = () => events.map((event) => [event.atMs, event.phase]);

  test("the travel, the hold in Ishima, then the invitation: each logged and stored once", () => {
    expect(rule.update({ inputs: inputs(), stood: null, nowMs: 0 })).toEqual(TIAN_DI_HUI_TRAVEL_INTENT);
    expect(rule.update({ inputs: inputs(), stood: null, nowMs: 1_000 })).toEqual(TIAN_DI_HUI_TRAVEL_INTENT);
    expect(lines).toEqual([
      "tian di hui: travelling to Ishima for its invitation: it sells 8 to install " +
        `(${TIAN_DI_HUI_EIGHT.join(", ")}) (Daedalus's count: 23 of 30 installed)`,
    ]);
    expect(events).toEqual([
      { type: TIAN_DI_HUI_EVENT_KIND, atMs: 0, phase: "travel", wanted: TIAN_DI_HUI_EIGHT, installed: 23, required: 30 },
    ]);
    expect(rule.hold()).toBe(0);
    // In Ishima: no travel again, $1m held.
    expect(rule.update({ inputs: inputs({ city: "Ishima" }), stood: null, nowMs: 2_000 })).toBeNull();
    expect(rule.hold()).toBe(1e6);
    expect(rule.view()).toMatchObject({ traveling: false, hold: 1e6 });
    // Invited: the hold over.
    const invited = inputs({ city: "Ishima", state: stateOf(HACKERS, { invitations: ["Tian Di Hui"] }) });
    expect(rule.update({ inputs: invited, stood: null, nowMs: 3_000 })).toBeNull();
    expect(rule.hold()).toBe(0);
    expect(phases()).toEqual([
      [0, "travel"],
      [2_000, "hold"],
      [3_000, "invited"],
    ]);
    expect(lines.slice(1)).toEqual([
      "tian di hui: in Ishima: $1,000,000 held for its invitation (Daedalus's count: 23 of 30 installed)",
      "tian di hui: the hold is over: invited",
    ]);
  });

  test("the owner's work, the switch off or an install chosen: no travel, saying why", () => {
    expect(rule.update({ inputs: inputs(), stood: "your work on the dashboard", nowMs: 0 })).toBeNull();
    expect(rule.view()).toMatchObject({ traveling: false, waitingFor: "your work on the dashboard" });
    expect(events).toEqual([]);
    expect(rule.update({ inputs: null, stood: null, nowMs: 0 })).toBeNull();
    expect(rule.view()).toMatchObject({ hold: 0, waitingFor: "the Agent's snapshots" });
  });

  test("held 5 minutes with the money and no invitation: NOT INVITED, logged and stored once", () => {
    const ishima = inputs({ city: "Ishima" });
    rule.update({ inputs: ishima, stood: null, nowMs: 0 });
    rule.update({ inputs: ishima, stood: null, nowMs: TIAN_DI_HUI_NOT_INVITED_AFTER_MS - 1 });
    expect(phases()).toEqual([[0, "hold"]]);
    rule.update({ inputs: ishima, stood: null, nowMs: TIAN_DI_HUI_NOT_INVITED_AFTER_MS });
    rule.update({ inputs: ishima, stood: null, nowMs: TIAN_DI_HUI_NOT_INVITED_AFTER_MS + MINUTE });
    expect(phases()).toEqual([
      [0, "hold"],
      [TIAN_DI_HUI_NOT_INVITED_AFTER_MS, "notInvited"],
    ]);
    expect(lines.at(-1)).toBe(
      "tian di hui: NOT INVITED: 5 min in Ishima with hacking 6368 and $11,000,000,000,000,000, and no invitation",
    );
  });

  test("short of the $1m, the hold is still gathering it: the clock runs from the last update short of it", () => {
    rule.update({ inputs: inputs({ city: "Ishima", money: 900_000 }), stood: null, nowMs: 0 });
    rule.update({ inputs: inputs({ city: "Ishima", money: 999_999 }), stood: null, nowMs: 10 * MINUTE });
    rule.update({ inputs: inputs({ city: "Ishima", money: 1e6 }), stood: null, nowMs: 11 * MINUTE });
    rule.update({ inputs: inputs({ city: "Ishima", money: 1e6 }), stood: null, nowMs: 15 * MINUTE - 1 });
    expect(phases()).toEqual([[0, "hold"]]);
    rule.update({ inputs: inputs({ city: "Ishima", money: 1e6 }), stood: null, nowMs: 15 * MINUTE });
    expect(phases()).toEqual([
      [0, "hold"],
      [15 * MINUTE, "notInvited"],
    ]);
  });
});

describe("what the run report says", () => {
  const stored = (atMs: number, phase: TianDiHuiEvent["phase"]) => ({
    atMs,
    kind: TIAN_DI_HUI_EVENT_KIND,
    detail: { phase, wanted: TIAN_DI_HUI_EIGHT, installed: 23, required: 30 },
  });
  const time = (ms: number) => `t${ms}`;

  test("the factions section: the travel, the hold and the invitation; none, said", () => {
    expect(tianDiHuiLines([stored(1, "travel"), stored(2, "hold"), stored(3, "invited")], time)).toEqual([
      "    Tian Di Hui's invitation (the travel, and the $1m held for it):",
      "      t1  travel to Ishima for its invitation (23 of 30 installed; it sells 8 to install)",
      "      t2  $1,000,000 held for its invitation",
      "      t3  invited: the hold is over",
    ]);
    expect(tianDiHuiLines([], time).at(-1)).toBe("      none");
  });

  test("section 4: no invitation is a failure", () => {
    const failures: string[] = [];
    expect(tianDiHuiHealthLines([stored(1, "hold"), stored(2, "notInvited")], failures, time)).toEqual([
      "  Tian Di Hui not inviting (in its city with the money for 5 min):",
      "    Tian Di Hui NOT INVITED 5 min into the hold (23 of 30 installed; it sells 8 to install), at t2",
    ]);
    expect(failures).toEqual([
      "Tian Di Hui NOT INVITED 5 min into the hold (23 of 30 installed; it sells 8 to install), at t2",
    ]);
    const none: string[] = [];
    expect(tianDiHuiHealthLines([stored(1, "hold")], none, time).at(-1)).toBe("    none");
    expect(none).toEqual([]);
  });
});
