// The brain's joins and faction work (#203): which invitation it joins, which faction and work it chooses and why, the
// rule's log, events and stall as the controller runs it, and what the run report reads of them.
import {
  augmentationBitNodeMultipliers,
  factionReputationPerSecond,
  type JoinedFaction,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  chooseFactionWork,
  chooseJoin,
  describeChoice,
  describeEta,
  FACTION_WORK_CHOSEN_EVENT_KIND,
  FACTION_WORK_STALLED_AFTER_MS,
  FACTION_WORK_STOPPED_EVENT_KIND,
  type FactionInputs,
  FactionRule,
  type FactionWorkEvent,
  FactionWorkTimeline,
  joinIntent,
  onTrack,
  SLOW_SNAPSHOT_GAP_MS,
  workingPersonOf,
} from "../src/factions.ts";

/** A player at `hacking`, every other skill at `others`, intelligence 0 and `faction_rep` 1 unless given. */
function player(
  hacking: number,
  {
    others = 1,
    intelligence = 0,
    factionRep = 1,
    factions = [] as string[],
  }: { others?: number; intelligence?: number; factionRep?: number; factions?: string[] } = {},
): MediumSnapshotData {
  return {
    player: {
      skills: {
        hacking,
        strength: others,
        defense: others,
        dexterity: others,
        agility: others,
        charisma: others,
        intelligence,
      },
      mults: { faction_rep: factionRep },
      factions,
    },
    hasTorRouter: false,
    programs: [],
    servers: [],
  };
}

/** A slow snapshot: the factions joined (name → reputation, or with favour), the invitations, the queue, the installs. */
function slow({
  joined = {} as Record<string, number | { reputation: number; favor: number }>,
  invitations = [] as string[],
  queued = [] as string[],
  installed = {} as Record<string, number>,
  currentNode = 1,
  ownedSF = {} as Record<string, number>,
} = {}): SlowSnapshotData {
  const factions: JoinedFaction[] = Object.entries(joined).map(([name, figures]) =>
    typeof figures === "number" ? { name, reputation: figures, favor: 0 } : { name, ...figures },
  );
  return {
    resetInfo: { lastAugReset: 0, lastNodeReset: 0, currentNode, ownedAugs: installed, ownedSF, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: "sim",
      state: { joined: factions, invitations, queuedAugmentations: queued },
      problem: null,
    },
  };
}

/** Hacking work's rate a second for `medium`'s player at favour 0, focused. */
const hackingRate = (medium: MediumSnapshotData, favor = 0) =>
  factionReputationPerSecond(workingPersonOf(medium) as NonNullable<ReturnType<typeof workingPersonOf>>, "hacking", {
    favor,
    sourceFile15Level: 0,
    focused: true,
    implant: false,
  });

describe("chooseJoin", () => {
  test("the first invitation from a faction without enemies, in the order invited; the city factions left", () => {
    expect(chooseJoin(["Sector-12", "CyberSec", "NiteSec"], [])).toEqual({
      next: "CyberSec",
      leftToOwner: [{ faction: "Sector-12", bans: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"] }],
    });
  });

  test("one joined is passed over, as is a name that isn't one of the game's factions; none left, none to join", () => {
    expect(chooseJoin(["CyberSec", "Nope", "NiteSec"], ["CyberSec"])).toEqual({ next: "NiteSec", leftToOwner: [] });
    expect(chooseJoin(["CyberSec"], ["CyberSec"])).toEqual({ next: null, leftToOwner: [] });
    expect(chooseJoin([], [])).toEqual({ next: null, leftToOwner: [] });
  });

  test("every one of the six city factions is left; every other faction is joined", () => {
    for (const city of ["Aevum", "Chongqing", "Ishima", "New Tokyo", "Sector-12", "Volhaven"]) {
      expect(chooseJoin([city], []).next).toBeNull();
    }
    for (const faction of ["Tian Di Hui", "Netburners", "ECorp", "The Syndicate", "Daedalus"]) {
      expect(chooseJoin([faction], []).next).toBe(faction);
    }
  });

  test("joinIntent: the joinFaction intent", () => {
    expect(joinIntent("CyberSec")).toEqual({
      id: "joinFaction(CyberSec)",
      action: "joinFaction",
      args: { faction: "CyberSec" },
    });
  });
});

describe("workingPersonOf", () => {
  test("the seven skills and faction_rep; null when any is missing or not a number", () => {
    expect(workingPersonOf(player(55, { intelligence: 3, factionRep: 1.2 }))).toEqual({
      skills: { hacking: 55, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 3 },
      mults: { faction_rep: 1.2 },
    });
    const noIntelligence = player(55);
    delete (noIntelligence.player.skills as Record<string, unknown>).intelligence;
    expect(workingPersonOf(noIntelligence)).toBeNull();
    expect(workingPersonOf(player(55, { factionRep: Number.NaN }))).toBeNull();
    expect(workingPersonOf({ ...player(55), player: {} })).toBeNull();
  });
});

describe("chooseFactionWork", () => {
  test("from a fresh CyberSec: Neurotrainer I first, the most hacking value a second of hacking work", () => {
    const medium = player(55);
    const plan = chooseFactionWork(medium, slow({ joined: { CyberSec: 0 } }));
    const rate = hackingRate(medium);
    expect(plan).toEqual({
      choice: {
        faction: "CyberSec",
        workType: "hacking",
        augmentation: "Neurotrainer I",
        reputation: 0,
        reputationNeeded: 1_000,
        reputationPerSecond: rate,
        etaSeconds: 1_000 / rate,
      },
      waitingFor: null,
      transient: false,
    });
  });

  test("by value a second, not the nearest alone: with 1,000 reputation, Synaptic Enhancement Implant, then BitWire", () => {
    // Synaptic: ln 1.03 / 1,000 left; BitWire: ln 1.05 / 2,750 left; Neurotrainer I is reached (A6's to buy).
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 1_000 } })).choice?.augmentation).toBe(
      "Synaptic Enhancement Implant",
    );
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 2_000 } })).choice?.augmentation).toBe("BitWire");
    // At 3,750: Cranial Signal Processors - Gen I (ln 1.01 + ln 1.05 over 6,250 left) over Gen II, the more valuable
    // (ln 1.05 + ln 1.02 + ln 1.07) but over 15,000 left.
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 3_750 } })).choice?.augmentation).toBe(
      "Cranial Signal Processors - Gen I",
    );
    // With Gen I installed, Gen II at last.
    const genOne = slow({ joined: { CyberSec: 3_750 }, installed: { "Cranial Signal Processors - Gen I": 1 } });
    expect(chooseFactionWork(player(55), genOne).choice?.augmentation).toBe("Cranial Signal Processors - Gen II");
  });

  test("the value counts, not the time alone: NiteSec at 0 works for Artificial Synaptic Potentiation, not BitWire", () => {
    // BitWire: ln 1.05 over 3,750; Artificial Synaptic Potentiation: ln 1.02 + ln 1.05 + ln 1.05 over 6,250.
    expect(chooseFactionWork(player(55), slow({ joined: { NiteSec: 0 } })).choice?.augmentation).toBe(
      "Artificial Synaptic Potentiation",
    );
  });

  test("installed and queued augmentations are passed over, and NeuroFlux Governor", () => {
    const plan = chooseFactionWork(
      player(55),
      slow({ joined: { CyberSec: 0 }, installed: { "Neurotrainer I": 1 }, queued: ["Synaptic Enhancement Implant"] }),
    );
    expect(plan.choice?.augmentation).toBe("BitWire");
    const everything = slow({
      joined: { CyberSec: 0 },
      installed: { "Neurotrainer I": 1, BitWire: 1, "Cranial Signal Processors - Gen I": 1 },
      queued: ["Synaptic Enhancement Implant", "Cranial Signal Processors - Gen II"],
    });
    expect(chooseFactionWork(player(55), everything)).toEqual({
      choice: null,
      waitingFor: "an augmentation worth working for at the joined factions",
      transient: false,
    });
  });

  test("an augmentation without a hacking value isn't worked for: Sector-12's combat ones, then Neuralstimulator", () => {
    // Sector-12 sells Augmented Targeting I (5,000, dexterity only) and Neuralstimulator (50,000, hacking ones).
    expect(chooseFactionWork(player(55), slow({ joined: { "Sector-12": 0 } })).choice?.augmentation).toBe(
      "Neuralstimulator",
    );
    // With it installed, only those without one are left: none.
    const left = slow({ joined: { "Sector-12": 0 }, installed: { Neuralstimulator: 1 } });
    expect(chooseFactionWork(player(55), left)).toMatchObject({
      choice: null,
      waitingFor: "an augmentation worth working for at the joined factions",
    });
  });

  test("one already reached at another joined faction that sells it is A6's to buy, not worked for", () => {
    // CyberSec at 3,700 is 50 from BitWire (3,750), the best by far: unless NiteSec, which sells it too, has reached it.
    const notReached = chooseFactionWork(player(55), slow({ joined: { CyberSec: 3_700, NiteSec: 3_000 } }));
    expect(notReached.choice).toMatchObject({ faction: "CyberSec", augmentation: "BitWire" });
    const reached = chooseFactionWork(player(55), slow({ joined: { CyberSec: 3_700, NiteSec: 3_750 } }));
    expect(reached.choice).toMatchObject({ faction: "NiteSec", augmentation: "Artificial Synaptic Potentiation" });
  });

  test("a missing prerequisite must be sold by a joined faction", () => {
    // BitRunners sells Cranial Signal Processors - Gen III (50,000, 100 away) and IV, but not Gen I or II, Gen III's
    // prerequisites: Gen III only once both are owned, or a joined faction sells them (NiteSec sells both).
    const alone = chooseFactionWork(player(600), slow({ joined: { BitRunners: 49_900 } }));
    expect(alone.choice?.augmentation).not.toBe("Cranial Signal Processors - Gen III");
    const genTwoOnly = slow({ joined: { BitRunners: 49_900 }, installed: { "Cranial Signal Processors - Gen II": 1 } });
    expect(chooseFactionWork(player(600), genTwoOnly).choice?.augmentation).not.toBe(
      "Cranial Signal Processors - Gen III",
    );
    const withGen2 = chooseFactionWork(
      player(600),
      slow({
        joined: { BitRunners: 49_900 },
        installed: { "Cranial Signal Processors - Gen I": 1, "Cranial Signal Processors - Gen II": 1 },
      }),
    );
    expect(withGen2.choice?.augmentation).toBe("Cranial Signal Processors - Gen III");
    // Every missing one, not just one: Embedded Netburner Module Core V2 Upgrade at OmniTek, 100 away, needs the
    // Module (NiteSec sells it) and its Core Implant (neither does).
    const oneOfTwo = chooseFactionWork(player(600), slow({ joined: { "OmniTek Incorporated": 999_900, NiteSec: 0 } }));
    expect(oneOfTwo.choice?.augmentation).not.toBe("Embedded Netburner Module Core V2 Upgrade");
    const withNiteSec = chooseFactionWork(player(600), slow({ joined: { BitRunners: 49_900, NiteSec: 0 } }));
    expect(withNiteSec.choice).toMatchObject({
      faction: "BitRunners",
      augmentation: "Cranial Signal Processors - Gen III",
    });
  });

  test("the faction's best work type: field for a fighter at The Black Hand, which offers hacking and field", () => {
    const fighter = player(10, { others: 400 });
    const plan = chooseFactionWork(fighter, slow({ joined: { "The Black Hand": 0 } }));
    expect(plan.choice?.workType).toBe("field");
    const person = workingPersonOf(fighter) as NonNullable<ReturnType<typeof workingPersonOf>>;
    const options = { favor: 0, sourceFile15Level: 0, focused: true, implant: false };
    expect(plan.choice?.reputationPerSecond).toBe(factionReputationPerSecond(person, "field", options));
    expect(chooseFactionWork(player(500), slow({ joined: { "The Black Hand": 0 } })).choice?.workType).toBe("hacking");
  });

  test("favour raises the rate, and so wins a tie between factions selling the same augmentation", () => {
    // Neuralstimulator at Sector-12 and Aevum, both at 0: Aevum's favour brings it sooner.
    const medium = player(55);
    const plan = chooseFactionWork(
      medium,
      slow({ joined: { "Sector-12": 0, Aevum: { reputation: 0, favor: 50 } }, installed: aevumCheaperOnes() }),
    );
    expect(plan.choice).toMatchObject({ faction: "Aevum", augmentation: "Neuralstimulator" });
    expect(plan.choice?.reputationPerSecond).toBeCloseTo(hackingRate(medium, 50), 12);
    expect(plan.choice?.reputationPerSecond).toBeCloseTo(hackingRate(medium) * 1.5, 12);
  });

  test("a tie in value and time goes to the faction first in the game's order", () => {
    // Neuralstimulator at Sector-12 and Aevum, equal in every figure: Aevum comes first (`FACTION_NAMES`).
    const plan = chooseFactionWork(
      player(55),
      slow({ joined: { "Sector-12": 0, Aevum: 0 }, installed: aevumCheaperOnes() }),
    );
    expect(plan.choice).toMatchObject({ faction: "Aevum", augmentation: "Neuralstimulator" });
  });

  test("the reputation needed is the BitNode's: × AugmentationRepCost", () => {
    const repCost = augmentationBitNodeMultipliers(3, {}).AugmentationRepCost;
    expect(repCost).toBe(3);
    const plan = chooseFactionWork(player(55), slow({ joined: { CyberSec: 0 }, currentNode: 3 }));
    expect(plan.choice?.reputationNeeded).toBeCloseTo(1_000 * repCost, 9);
  });

  test("the implant installed: unfocused work at the full rate, as focused", () => {
    const medium = player(55);
    const plan = chooseFactionWork(
      medium,
      slow({ joined: { CyberSec: 0 }, installed: { "Neuroreceptor Management Implant": 1 } }),
    );
    expect(plan.choice?.reputationPerSecond).toBe(hackingRate(medium));
  });

  test("none, definitely: no faction joined, or none that offers work", () => {
    expect(chooseFactionWork(player(55), slow())).toEqual({
      choice: null,
      waitingFor: "a faction to join",
      transient: false,
    });
    expect(chooseFactionWork(player(55), slow({ joined: { "Shadows of Anarchy": 0 } }))).toEqual({
      choice: null,
      waitingFor: "a joined faction that offers work",
      transient: false,
    });
  });

  test("none for now: the faction state unread, the reset info or the player's figures missing", () => {
    const unread = { ...slow(), factions: { backend: "ui" as const, state: null, problem: "no Factions page" } };
    expect(chooseFactionWork(player(55), unread)).toEqual({
      choice: null,
      waitingFor: "the faction state in the Agent's slow snapshot (unread: no Factions page)",
      transient: true,
    });
    const absent = { ...slow() };
    delete absent.factions;
    expect(chooseFactionWork(player(55), absent)).toMatchObject({
      waitingFor: "the faction state in the Agent's slow snapshot",
      transient: true,
    });
    const noReset = { ...slow({ joined: { CyberSec: 0 } }), resetInfo: {} as SlowSnapshotData["resetInfo"] };
    expect(chooseFactionWork(player(55), noReset)).toMatchObject({ transient: true, choice: null });
    expect(chooseFactionWork({ ...player(55), player: {} }, slow({ joined: { CyberSec: 0 } }))).toEqual({
      choice: null,
      waitingFor: "the player's skills and multipliers in the Agent's medium snapshot",
      transient: true,
    });
  });

  test("an augmentation core doesn't know (another game version) gives none, saying so", () => {
    const plan = chooseFactionWork(player(55), slow({ joined: { CyberSec: 0 }, queued: ["Some New Augmentation"] }));
    expect(plan.choice).toBeNull();
    expect(plan.waitingFor).toMatch(/^the snapshots as core knows the game \(.*Some New Augmentation/);
  });
});

/** Aevum's augmentations cheaper than Neuralstimulator, and Sector-12's with a hacking value, as installed. */
function aevumCheaperOnes(): Record<string, number> {
  return { "Synaptic Enhancement Implant": 1, "Neurotrainer I": 1, PCMatrix: 1 };
}

describe("describeChoice and describeEta", () => {
  test("in words, for the log, the dashboard and the run report", () => {
    expect(describeEta(30)).toBe("30 s");
    expect(describeEta(0.2)).toBe("1 s");
    expect(describeEta(600)).toBe("10 min");
    expect(describeEta(3 * 3600)).toBe("3.0 h");
    expect(
      describeChoice({
        faction: "CyberSec",
        workType: "hacking",
        augmentation: "BitWire",
        reputation: 1234.5,
        reputationNeeded: 3750,
        reputationPerSecond: 0.3456,
        etaSeconds: 7_000,
      }),
    ).toBe("hacking for CyberSec, for BitWire (reputation 1,235 of 3,750, 0.35/s: about 1.9 h)");
  });
});

describe("FactionRule", () => {
  /** The rule, its log and its events, and an update with the inputs given over these defaults. */
  function rule() {
    const log: string[] = [];
    const events: FactionWorkEvent[] = [];
    const factions = new FactionRule({ log: (line) => log.push(line), emit: (event) => events.push(event) });
    const update = (inputs: Partial<FactionInputs>) =>
      factions.update({
        mediumData: player(55),
        slowData: slow(),
        slowAtMs: 1_000,
        nowMs: 1_000,
        ownersWork: false,
        enabled: true,
        ...inputs,
      });
    return { factions, log, events, update };
  }

  test("joins: asked for until the medium snapshot shows it joined, then the next; logged", () => {
    const { factions, log, update } = rule();
    const invited = slow({ invitations: ["CyberSec", "NiteSec"] });
    expect(update({ slowData: invited }).join).toEqual(joinIntent("CyberSec"));
    expect(update({ slowData: invited }).join).toEqual(joinIntent("CyberSec"));
    expect(factions.view().joining).toBe("CyberSec");
    // Joined: NiteSec next.
    expect(update({ slowData: invited, mediumData: player(55, { factions: ["CyberSec"] }) }).join).toEqual(
      joinIntent("NiteSec"),
    );
    expect(log).toEqual([
      "factions: joining CyberSec (its invitation)",
      "factions: CyberSec joined",
      "factions: joining NiteSec (its invitation)",
    ]);
  });

  test("joins: kept while a slow snapshot older than the join still lists it; one gone with no join is dropped", () => {
    const { log, update } = rule();
    expect(update({ slowData: slow({ invitations: ["CyberSec"] }) }).join).toEqual(joinIntent("CyberSec"));
    // The slow snapshot shows it joined first: joined, and none asked for.
    expect(update({ slowData: slow({ joined: { CyberSec: 0 } }) }).join).toBeNull();
    expect(log).toContain("factions: CyberSec joined");
    expect(update({ slowData: slow({ invitations: ["NiteSec"] }) }).join).toEqual(joinIntent("NiteSec"));
    // An install: no invitation, not joined.
    expect(update({ slowData: slow() }).join).toBeNull();
    expect(log.at(-1)).toBe("factions: no longer joining NiteSec: its invitation is gone");
  });

  test("joins: none without the snapshots, or with a medium snapshot that has no list of factions", () => {
    const { update } = rule();
    const invited = slow({ invitations: ["CyberSec"] });
    expect(update({ slowData: null }).join).toBeNull();
    expect(update({ slowData: invited, mediumData: null }).join).toBeNull();
    expect(update({ slowData: invited, mediumData: { ...player(55), player: {} } }).join).toBeNull();
  });

  test("an invitation from a faction with enemies is left, said in the view and logged once", () => {
    const { factions, log, update } = rule();
    const invited = slow({ invitations: ["Sector-12"] });
    expect(update({ slowData: invited }).join).toBeNull();
    update({ slowData: invited });
    expect(factions.view().leftToOwner).toEqual([
      { faction: "Sector-12", bans: ["Chongqing", "New Tokyo", "Ishima", "Volhaven"] },
    ]);
    expect(log).toEqual([
      "factions: Sector-12's invitation is left to you (joining it bans Chongqing, New Tokyo, Ishima, Volhaven)",
    ]);
  });

  test("work: the choice sent, stored and logged once; another target stored again; the same work type sent", () => {
    const { factions, log, events, update } = rule();
    expect(update({ slowData: slow({ joined: { CyberSec: 0 } }) }).work).toEqual({
      faction: "CyberSec",
      workType: "hacking",
    });
    update({ slowData: slow({ joined: { CyberSec: 10 } }), nowMs: 2_000 });
    expect(events).toEqual([
      expect.objectContaining({ type: FACTION_WORK_CHOSEN_EVENT_KIND, atMs: 1_000, augmentation: "Neurotrainer I" }),
    ]);
    expect(update({ slowData: slow({ joined: { CyberSec: 1_000 } }), nowMs: 3_000 }).work).toEqual({
      faction: "CyberSec",
      workType: "hacking",
    });
    expect(events.map((event) => [event.type, event.atMs, "augmentation" in event && event.augmentation])).toEqual([
      [FACTION_WORK_CHOSEN_EVENT_KIND, 1_000, "Neurotrainer I"],
      [FACTION_WORK_CHOSEN_EVENT_KIND, 3_000, "Synaptic Enhancement Implant"],
    ]);
    expect(log.filter((line) => line.startsWith("faction work: "))).toHaveLength(2);
    expect(log[0]).toMatch(/^faction work: hacking for CyberSec, for Neurotrainer I \(reputation 0 of 1,000, /);
    expect(factions.view()).toMatchObject({ enabled: true, waiting: false, sent: true, waitingFor: null });
  });

  test("the owner's work wins, and the switch off: not sent, stored as stopped once, with why; back on, chosen again", () => {
    const { factions, events, update } = rule();
    const joined = slow({ joined: { CyberSec: 0 } });
    update({ slowData: joined });
    expect(update({ slowData: joined, ownersWork: true, nowMs: 2_000 }).work).toBeNull();
    expect(factions.view()).toMatchObject({ sent: false, waitingFor: "your work on the dashboard" });
    expect(factions.view().choice?.faction).toBe("CyberSec");
    update({ slowData: joined, ownersWork: true, nowMs: 3_000 });
    expect(update({ slowData: joined, enabled: false, nowMs: 4_000 }).work).toBeNull();
    expect(factions.view()).toMatchObject({ enabled: false, waitingFor: "the Faction work switch is off" });
    expect(update({ slowData: joined, nowMs: 5_000 }).work).not.toBeNull();
    expect(events.map((event) => [event.type, event.atMs, "reason" in event ? event.reason : null])).toEqual([
      [FACTION_WORK_CHOSEN_EVENT_KIND, 1_000, null],
      [FACTION_WORK_STOPPED_EVENT_KIND, 2_000, "your work on the dashboard"],
      [FACTION_WORK_CHOSEN_EVENT_KIND, 5_000, null],
    ]);
  });

  test("snapshots missing or the faction state unread: not sent, nothing stored; nothing worth it: stopped", () => {
    const { events, update } = rule();
    update({ slowData: slow({ joined: { CyberSec: 0 } }) });
    expect(update({ slowData: null, mediumData: null }).work).toBeNull();
    const unread = { ...slow(), factions: { backend: "ui" as const, state: null, problem: "no page" } };
    expect(update({ slowData: unread }).work).toBeNull();
    expect(events).toHaveLength(1);
    const everything = slow({
      joined: { CyberSec: 20_000 },
      installed: { "Cranial Signal Processors - Gen I": 1 },
      queued: ["Cranial Signal Processors - Gen II"],
    });
    update({ slowData: everything, nowMs: 9_000 });
    expect(events.at(-1)).toEqual({
      type: FACTION_WORK_STOPPED_EVENT_KIND,
      atMs: 9_000,
      reason: "an augmentation worth working for at the joined factions",
    });
  });

  test("no event before the controller has a time; none stopped before any chosen", () => {
    const { events, update } = rule();
    update({ slowData: slow({ joined: { CyberSec: 0 } }), nowMs: null });
    expect(events).toEqual([]);
    const fresh = rule();
    fresh.update({ slowData: slow({ joined: { CyberSec: 0 } }), ownersWork: true });
    expect(fresh.events).toEqual([]);
  });

  test("the stall: under half the work's rate for 10 minutes, logged once; on track again ends it", () => {
    const { factions, log, update } = rule();
    const medium = player(55);
    const rate = hackingRate(medium);
    const at = (minutes: number, reputation: number) =>
      update({ slowData: slow({ joined: { CyberSec: reputation } }), slowAtMs: minutes * 60_000 });
    at(0, 0);
    expect(factions.stall()).toEqual({ faction: "CyberSec", sinceMs: 0 });
    // On track: just half the rate for the minute.
    at(1, 0.5 * rate * 60);
    expect(factions.stall()).toEqual({ faction: "CyberSec", sinceMs: 60_000 });
    // Under half, minute after minute (the passive gain's few).
    let reputation = 0.5 * rate * 60;
    for (let minute = 2; minute <= 11; minute++) {
      reputation += 2;
      at(minute, reputation);
    }
    expect(factions.stall()).toEqual({ faction: "CyberSec", sinceMs: 60_000 });
    expect(log.filter((line) => line.includes("STALLED"))).toEqual([
      expect.stringMatching(
        /^faction work STALLED: CyberSec's reputation has risen under half the hacking work's 0\.\d\d\/s for 10 min, /,
      ),
    ]);
    reputation += 2;
    at(12, reputation);
    expect(log.filter((line) => line.includes("STALLED"))).toHaveLength(1);
    at(13, reputation + rate * 60);
    expect(factions.stall()).toEqual({ faction: "CyberSec", sinceMs: 13 * 60_000 });
    expect(log.at(-1)).toBe("faction work: CyberSec's reputation is rising at the work's rate again");
  });

  test("the stall's watch starts again with another faction, and goes with the work not sent or the snapshots", () => {
    const { factions, update } = rule();
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 0 });
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 5 * 60_000 });
    expect(factions.stall()?.sinceMs).toBe(0);
    // Another faction: NiteSec's BitWire reached, its Cranial Signal Processors nearer than CyberSec's.
    update({ slowData: slow({ joined: { CyberSec: 0, NiteSec: 9_000 } }), slowAtMs: 6 * 60_000 });
    expect(factions.stall()).toEqual({ faction: "NiteSec", sinceMs: 6 * 60_000 });
    update({ slowData: slow({ joined: { CyberSec: 0, NiteSec: 9_000 } }), ownersWork: true });
    expect(factions.stall()).toBeNull();
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 7 * 60_000 });
    update({ slowData: null, slowAtMs: null });
    expect(factions.stall()).toBeNull();
  });
});

test("onTrack: risen by at least half the rate over the time between", () => {
  expect(onTrack({ atMs: 0, reputation: 10 }, { atMs: 60_000, reputation: 25 }, 0.5)).toBe(true);
  expect(onTrack({ atMs: 0, reputation: 10 }, { atMs: 60_000, reputation: 24.9 }, 0.5)).toBe(false);
  expect(onTrack({ atMs: 0, reputation: 10 }, { atMs: 60_000, reputation: 9 }, 0.5)).toBe(false);
});

describe("FactionWorkTimeline", () => {
  const STARTED = "brainStarted";
  const chosen = (atMs: number, faction = "CyberSec", reputationPerSecond = 0.5) => ({
    atMs,
    kind: FACTION_WORK_CHOSEN_EVENT_KIND,
    detail: {
      faction,
      workType: "hacking",
      augmentation: "Neurotrainer I",
      reputation: 0,
      reputationNeeded: 1_000,
      reputationPerSecond,
      etaSeconds: 2_000,
    },
  });
  const stopped = (atMs: number, reason = "your work on the dashboard") => ({
    atMs,
    kind: FACTION_WORK_STOPPED_EVENT_KIND,
    detail: { reason },
  });
  /** Slow snapshots a minute apart from `fromMinute`, CyberSec's reputation rising `perMinute`. */
  function slows(timeline: FactionWorkTimeline, fromMinute: number, toMinute: number, perMinute: number, start = 0) {
    for (let minute = fromMinute; minute <= toMinute; minute++) {
      timeline.addSlow(minute * 60_000, slow({ joined: { CyberSec: start + (minute - fromMinute) * perMinute } }));
    }
  }

  test("the records: each choice and end, a malformed one left out; the choice in force, ended by a stop or a start", () => {
    const timeline = new FactionWorkTimeline(
      [
        chosen(0),
        { atMs: 1, kind: FACTION_WORK_CHOSEN_EVENT_KIND, detail: { faction: 1 } },
        stopped(10),
        chosen(20),
        { atMs: 30, kind: STARTED, detail: {} },
      ],
      STARTED,
    );
    expect(timeline.records.map((record) => [record.atMs, record.kind])).toEqual([
      [0, "chosen"],
      [10, "stopped"],
      [20, "chosen"],
    ]);
    expect(timeline.choiceAt(5)?.record.atMs).toBe(0);
    expect(timeline.choiceAt(15)).toBeNull();
    expect(timeline.choiceAt(25)?.record.atMs).toBe(20);
    expect(timeline.choiceAt(35)).toBeNull();
  });

  test("joins from the medium snapshots; invitations left to the owner from the slow ones", () => {
    const timeline = new FactionWorkTimeline([], STARTED);
    timeline.addMedium(0, player(55, { factions: ["Sector-12"] }));
    timeline.addMedium(10_000, player(55, { factions: ["Sector-12", "CyberSec"] }));
    expect([...timeline.joined]).toEqual([
      ["Sector-12", null],
      ["CyberSec", 10_000],
    ]);
    timeline.addSlow(60_000, slow({ invitations: ["Aevum", "NiteSec"] }));
    timeline.addSlow(120_000, slow({ invitations: ["Aevum"] }));
    expect([...timeline.leftToOwner]).toEqual([["Aevum", 60_000]]);
  });

  test("reputation gained while the brain's work is on it; on track, no stall", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(timeline, 0, 20, 30);
    expect([...timeline.gained]).toEqual([["CyberSec", 600]]);
    expect(timeline.stalls).toEqual([]);
  });

  test("a stall: under half the rate for 10 minutes or more, from the last snapshot on track, ongoing at the end", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(timeline, 0, 3, 30);
    // 0.5/s is 30 a minute: 14 a minute is under half.
    slows(timeline, 4, 15, 14, 90 + 14);
    expect(timeline.stalls).toEqual([
      {
        faction: "CyberSec",
        workType: "hacking",
        reputationPerSecond: 0.5,
        fromMs: 3 * 60_000,
        toMs: 15 * 60_000,
        ongoing: true,
      },
    ]);
  });

  test("not a stall: 9 minutes under, a gap in the slow snapshots between, or the work stopped", () => {
    const short = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(short, 0, 9, 1);
    expect(short.stalls).toEqual([]);
    const gap = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(gap, 0, 5, 1);
    slows(gap, 5 + SLOW_SNAPSHOT_GAP_MS / 60_000 + 1, 14, 1, 100);
    expect(gap.stalls).toEqual([]);
    const stoppedWork = new FactionWorkTimeline([chosen(0), stopped(5 * 60_000)], STARTED);
    slows(stoppedWork, 0, 20, 1);
    expect(stoppedWork.stalls).toEqual([]);
    const restarted = new FactionWorkTimeline([chosen(0), stopped(5 * 60_000 + 1), chosen(5 * 60_000 + 2)], STARTED);
    slows(restarted, 0, 14, 1);
    expect(restarted.stalls).toEqual([]);
    expect(FACTION_WORK_STALLED_AFTER_MS).toBe(10 * 60_000);
  });

  test("a stall that ends: on track again, not ongoing", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(timeline, 0, 12, 1);
    timeline.addSlow(13 * 60_000, slow({ joined: { CyberSec: 12 + 30 } }));
    expect(timeline.stalls).toEqual([expect.objectContaining({ fromMs: 0, toMs: 12 * 60_000, ongoing: false })]);
  });
});
