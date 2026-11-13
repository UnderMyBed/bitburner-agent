// Hacknet to Netburners' invitation (#387): Netburners' facts and route for A6, its countables' τ in install timing's
// countables (core's `countablesToCome`), the rule as the controller runs it (the setup asked for, the phases stored,
// no invitation past the estimate loud), and what the run report says. The controller's own tests (the purchase order,
// the planner's go-ahead, an install, Hacknet servers) are desired-state.test.ts's; the simulator's,
// netburners-simulation.test.ts.
import {
  augmentationsSoldBy,
  bestWorkRate,
  countablesToCome,
  type FactionState,
  hacknetSetupPlan,
  INVITATION_CHECK_MS,
  NO_HACKNET_COST_MULTIPLIERS,
  type WorkingPerson,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  HACKNET_SETUP_EVENT_KIND,
  HACKNET_SETUP_INTENT,
  type HacknetEvent,
  HacknetRule,
  type HacknetRuleInputs,
  hacknetHealthLines,
  hacknetLines,
  hacknetMultipliersOf,
  NETBURNERS_NOT_INVITED_AFTER_MS,
  type NetburnersFacts,
  netburnersFactsOf,
  netburnersLeftOut,
  netburnersRoute,
} from "../src/hacknet.ts";

const MINUTE = 60_000;
const NETBURNERS_FIVE = augmentationsSoldBy("Netburners", 1, null).filter((name) => name !== "NeuroFlux Governor");
const NIC = "Hacknet Node NIC Architecture Neural-Upload";
const SETUP = hacknetSetupPlan([], NO_HACKNET_COST_MULTIPLIERS).cost;
const STATE: FactionState = {
  joined: [{ name: "CyberSec", reputation: 10_000, favor: 0 }],
  invitations: [],
  queuedAugmentations: [],
};
const factsOf = (changes: Partial<Parameters<typeof netburnersFactsOf>[0]> = {}) =>
  netburnersFactsOf({
    state: STATE,
    lastAugReset: 0,
    currentNode: 1,
    installed: {},
    ownedSF: {},
    bitNodeOptions: {},
    hackingLevel: 80,
    mults: NO_HACKNET_COST_MULTIPLIERS,
    ...changes,
  }) as NetburnersFacts;

describe("Netburners' facts and A6's route", () => {
  test("its five, the setup's cost from no node; the route while not joined, at hacking 80, one not installed", () => {
    expect(NETBURNERS_FIVE).toHaveLength(5);
    const facts = factsOf();
    expect(facts).toMatchObject({ joined: false, invited: false, hacknetServers: false, cost: SETUP });
    expect(facts.toInstall.sort()).toEqual([...NETBURNERS_FIVE].sort());
    expect(netburnersLeftOut(facts)).toBeNull();
    expect(netburnersRoute(facts, false)).toEqual({ sold: facts.sold, setupMoney: SETUP, invited: false });
    // Bought, or invited: no setup money left.
    expect(netburnersRoute(facts, true)?.setupMoney).toBe(0);
    expect(netburnersRoute(factsOf({ state: { ...STATE, invitations: ["Netburners"] } }), false)).toMatchObject({
      setupMoney: 0,
      invited: true,
    });
  });

  test("none: hacking under 80, joined, all five installed or queued, Hacknet servers (BN9, SF9)", () => {
    const cases: [Partial<Parameters<typeof netburnersFactsOf>[0]>, string][] = [
      [{ hackingLevel: 79.9 }, "hacking 80 for Netburners' invitation (79 now)"],
      [
        { state: { ...STATE, joined: [...STATE.joined, { name: "Netburners", reputation: 0, favor: 0 }] } },
        "nothing: Netburners joined (A5 and A6 have it)",
      ],
      [{ installed: Object.fromEntries(NETBURNERS_FIVE.slice(0, 3).map((name) => [name, 1])) }, ""],
      [
        {
          installed: Object.fromEntries(NETBURNERS_FIVE.slice(0, 3).map((name) => [name, 1])),
          state: { ...STATE, queuedAugmentations: NETBURNERS_FIVE.slice(3) },
        },
        "nothing: Netburners' augmentations installed or queued",
      ],
      [{ ownedSF: { 9: 1 } }, "nothing: Hacknet servers here (BN9 or SF9), left out"],
      [{ currentNode: 9 }, "nothing: Hacknet servers here (BN9 or SF9), left out"],
    ];
    for (const [changes, why] of cases) {
      const facts = factsOf(changes);
      // Three installed, two left: still the route.
      if (why === "") {
        expect(facts.toInstall).toHaveLength(2);
        expect(netburnersLeftOut(facts)).toBeNull();
        continue;
      }
      expect(netburnersLeftOut(facts)).toBe(why);
      expect(netburnersRoute(facts, false)).toBeNull();
    }
    expect(netburnersLeftOut(null)).toBe("the Agent's snapshots");
  });

  test("the multipliers from getPlayer().mults; none where any is missing", () => {
    const mults = {
      hacknet_node_purchase_cost: 0.9,
      hacknet_node_level_cost: 0.85,
      hacknet_node_ram_cost: 1,
      hacknet_node_core_cost: 1,
    };
    expect(hacknetMultipliersOf({ mults })).toEqual({ purchaseCost: 0.9, levelCost: 0.85, ramCost: 1, coreCost: 1 });
    expect(hacknetMultipliersOf({ mults: { ...mults, hacknet_node_core_cost: undefined } })).toBeNull();
    expect(hacknetMultipliersOf({})).toBeNull();
  });
});

describe("Netburners' countables in install timing's (core's countablesToCome)", () => {
  const person: WorkingPerson = {
    skills: { hacking: 300, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    mults: { faction_rep: 1 },
  };
  const conditions = {
    sourceFile15Level: 0,
    factionWorkRepGain: 1,
    favorToDonateToFaction: 1,
    focused: true,
    implant: false,
  };
  const rate = bestWorkRate(person, { name: "Netburners", reputation: 0, favor: 0 }, conditions)?.perSecond as number;
  const base = {
    sold: [],
    state: {
      installed: {},
      queued: [],
      sourceFile11Level: 0,
      bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
    },
    set: { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] },
    joined: STATE.joined,
    shops: new Map([["CyberSec", augmentationsSoldBy("CyberSec", 1, null)]]),
    terms: undefined,
    person,
    conditions,
    work: { owners: null, brainWorks: true },
    money: 0,
    income: 1_000,
  } satisfies Parameters<typeof countablesToCome>[0];
  const route = { sold: augmentationsSoldBy("Netburners", 1, null), setupMoney: SETUP, invited: false };

  test("each by A5's work there: the setup's money at the income, the game's check, then its reputation at the rate", () => {
    expect(rate).toBeGreaterThan(0);
    const toCome = countablesToCome({ ...base, netburners: route });
    expect(toCome.map((each) => each.augmentation).sort()).toEqual([...NETBURNERS_FIVE].sort());
    const nic = toCome.find((each) => each.augmentation === NIC);
    const beforeJoinMs = (SETUP / 1_000) * 1000 + INVITATION_CHECK_MS;
    expect(nic).toMatchObject({
      faction: "Netburners",
      way: "work",
      beforeJoinMs: expect.closeTo(beforeJoinMs, 3),
      workMs: expect.closeTo(beforeJoinMs + (1_875 / rate) * 1000, 3),
    });
    // Its money: its own price after the setup's, at the income (4.5m at $1,000 a second), the later.
    expect(nic?.etaMs).toBeCloseTo(Math.max(nic?.workMs as number, 4.5e6), 3);
    // Bought: the check alone before the work.
    const bought = countablesToCome({ ...base, money: 1e9, netburners: { ...route, setupMoney: 0 } });
    expect(bought.find((each) => each.augmentation === NIC)?.beforeJoinMs).toBe(INVITATION_CHECK_MS);
    // Invited: none.
    const invited = countablesToCome({ ...base, money: 1e9, netburners: { ...route, setupMoney: 0, invited: true } });
    expect(invited.find((each) => each.augmentation === NIC)?.beforeJoinMs).toBe(0);
  });

  test("none: no route, joined (the joined path has them), the owner's work, A5's switch off, the money never coming", () => {
    expect(countablesToCome(base)).toEqual([]);
    const joined = [...STATE.joined, { name: "Netburners", reputation: 0, favor: 0 }];
    expect(
      countablesToCome({ ...base, joined, netburners: route }).every((each) => each.beforeJoinMs === undefined),
    ).toBe(true);
    const owners = { kind: "faction", faction: "CyberSec", workType: "hacking" } as const;
    expect(countablesToCome({ ...base, work: { owners, brainWorks: true }, netburners: route })).toEqual([]);
    expect(countablesToCome({ ...base, work: { owners: null, brainWorks: false }, netburners: route })).toEqual([]);
    expect(countablesToCome({ ...base, income: null, netburners: route })).toEqual([]);
    // Installed or queued ones left out.
    const one = countablesToCome({
      ...base,
      state: {
        ...base.state,
        installed: { [NIC]: 1 },
        queued: NETBURNERS_FIVE.filter((name) => name !== NIC).slice(1),
      },
      netburners: route,
    });
    expect(one).toHaveLength(1);
  });
});

describe("the rule, as the controller runs it", () => {
  const facts = factsOf();
  const make = () => {
    const lines: string[] = [];
    const events: HacknetEvent[] = [];
    const rule = new HacknetRule({ log: (line) => lines.push(line), emit: (event) => events.push(event) });
    const at = (inputs: Partial<HacknetRuleInputs> = {}) =>
      rule.update({
        facts,
        waitedFor: { beforeJoinMs: 5 * MINUTE },
        done: false,
        installUnderWay: false,
        other: null,
        money: 1e9,
        hold: { amount: 0, forWhat: "nothing" },
        nowMs: 0,
        ...inputs,
      });
    return { rule, lines, events, at };
  };

  test("wanted: asked for with the money above the hold; bought, invited: each logged and stored once", () => {
    const { rule, lines, events, at } = make();
    expect(at()).toEqual(HACKNET_SETUP_INTENT);
    expect(rule.view()).toMatchObject({ wanted: true, buying: true, cost: SETUP, bought: false, waitingFor: null });
    expect(rule.reserve()).toBe(SETUP);
    expect(events).toEqual([
      {
        type: HACKNET_SETUP_EVENT_KIND,
        atMs: 0,
        phase: "wanted",
        cost: SETUP,
        estimateMs: 5 * MINUTE,
        sinceWantedMs: null,
      },
    ]);
    at({ nowMs: MINUTE });
    expect(events).toHaveLength(1);
    expect(at({ done: true, nowMs: 2 * MINUTE })).toEqual(HACKNET_SETUP_INTENT);
    expect(rule.view().bought).toBe(true);
    expect(rule.reserve()).toBe(0);
    expect(rule.bought(0)).toBe(true);
    expect(rule.bought(1)).toBe(false);
    expect(at({ facts: { ...facts, invited: true }, nowMs: 3 * MINUTE })).toBeNull();
    expect(events.map((event) => [event.phase, event.sinceWantedMs])).toEqual([
      ["wanted", null],
      ["bought", 2 * MINUTE],
      ["invited", 3 * MINUTE],
    ]);
    expect(lines).toEqual([
      expect.stringMatching(
        /^hacknet: the planner waits for Netburners' countables: its Hacknet setup, \$\d{3},\d{3}, /,
      ),
      expect.stringMatching(/^hacknet: the setup for Netburners' invitation bought/),
      "hacknet: Netburners invited, 3 min after the setup was wanted",
    ]);
  });

  test("not wanted: no go-ahead from the planner, an install under way, a purchase first, the money under the hold", () => {
    const cases: [Partial<HacknetRuleInputs>, string][] = [
      [{ waitedFor: null }, "the planner's wait to reach Netburners' countables"],
      [{ installUnderWay: true }, "the install under way (Hacknet is lost at it)"],
      [{ other: "BruteSSH.exe" }, "BruteSSH.exe first"],
      [{ money: null }, "the player's money in the Agent's medium snapshot"],
      [{ money: 100_000 }, `$${Math.round(SETUP).toLocaleString("en-US")} for the setup ($100,000 now)`],
      [
        { money: 1e9, hold: { amount: 1e9 - SETUP + 1, forWhat: "Daedalus's invitation" } },
        `money above the $${Math.round(1e9 - SETUP + 1).toLocaleString("en-US")} held for Daedalus's invitation ` +
          `($${Math.round(SETUP).toLocaleString("en-US")} the setup)`,
      ],
      [{ facts: factsOf({ hackingLevel: 50 }) }, "hacking 80 for Netburners' invitation (50 now)"],
      [{ facts: null }, "the Agent's snapshots"],
    ];
    for (const [inputs, why] of cases) {
      const { rule, events, at } = make();
      expect(at(inputs)).toBeNull();
      expect(rule.view().waitingFor).toBe(why);
      // Wanted (its price kept from cloud servers, its clock running) only with the planner's go-ahead, no install
      // under way and the facts in: a purchase first, or the money, only holds it back.
      const wanted = inputs.other !== undefined || inputs.money !== undefined;
      expect(rule.view().wanted, why).toBe(wanted);
      expect(rule.reserve(), why).toBe(wanted ? SETUP : 0);
      expect(
        events.map((event) => event.phase),
        why,
      ).toEqual(wanted ? ["wanted"] : []);
    }
    // Exactly the money above the hold: bought.
    const { at } = make();
    expect(at({ money: 1e9, hold: { amount: 1e9 - SETUP, forWhat: "x" } })).toEqual(HACKNET_SETUP_INTENT);
  });

  test("no invitation past the estimate and 10 minutes: NOT INVITED, logged and stored once; a new cycle starts afresh", () => {
    const { lines, events, at } = make();
    at({ nowMs: 0 });
    at({ done: true, nowMs: MINUTE });
    at({ done: true, nowMs: 5 * MINUTE + NETBURNERS_NOT_INVITED_AFTER_MS });
    expect(events.filter((event) => event.phase === "notInvited")).toEqual([]);
    at({ done: true, nowMs: 5 * MINUTE + NETBURNERS_NOT_INVITED_AFTER_MS + 1 });
    at({ done: true, nowMs: 30 * MINUTE });
    expect(events.filter((event) => event.phase === "notInvited")).toEqual([
      expect.objectContaining({ estimateMs: 5 * MINUTE, sinceWantedMs: 15 * MINUTE + 1 }),
    ]);
    expect(lines.at(-1)).toBe(
      "hacknet: NOT INVITED: Netburners hasn't invited 15 min after its setup was wanted (estimate 5 min)",
    );
    // Another cycle: wanted again, its own clock.
    at({ facts: { ...facts, lastAugReset: 1 }, nowMs: 40 * MINUTE });
    expect(events.at(-1)).toMatchObject({ phase: "wanted", atMs: 40 * MINUTE });
  });

  test("the run report: the phases in the factions section; NOT INVITED a failure in section 4", () => {
    const { events, at } = make();
    at({ nowMs: 0 });
    at({ done: true, nowMs: MINUTE });
    at({ done: true, nowMs: 20 * MINUTE });
    const stored = events.map(({ type, atMs, ...detail }) => ({ atMs, kind: type, detail }));
    const formatTime = (ms: number) => `t${ms / MINUTE}`;
    expect(hacknetLines(stored, formatTime)).toEqual([
      "    Netburners' Hacknet setup (#387: its invitation's totals, the cheapest way):",
      `      t0  the setup wanted ($${Math.round(SETUP).toLocaleString("en-US")}), the invitation estimated in 5 min`,
      "      t1  the setup bought, 60 s after it was wanted",
      "      t20  NOT INVITED 20 min after the setup was wanted (estimate 5 min, and 10 min)",
    ]);
    const failures: string[] = [];
    expect(hacknetHealthLines(stored, failures, formatTime)).toEqual([
      "  Netburners not invited (its Hacknet setup's estimate and 10 min, #387):",
      "    Netburners NOT INVITED 20 min after the setup was wanted (estimate 5 min, and 10 min), at t20",
    ]);
    expect(failures).toEqual([
      "Netburners NOT INVITED 20 min after the setup was wanted (estimate 5 min, and 10 min), at t20",
    ]);
    // Never wanted in the window: no lines (the report as long as before #387).
    expect(hacknetLines([], formatTime)).toEqual([]);
    expect(hacknetHealthLines([], [], formatTime)).toEqual([]);
    // Wanted and invited in time: none late.
    expect(hacknetHealthLines(stored.slice(0, 2), [], formatTime)).toEqual([
      "  Netburners not invited (its Hacknet setup's estimate and 10 min, #387):",
      "    none",
    ]);
  });
});
