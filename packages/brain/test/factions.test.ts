// The brain's joins and faction work (#203): which invitation it joins, which faction and work it chooses and why, the
// rule's log, events and stall as the controller runs it, and what the run report reads of them.
import {
  augmentationBitNodeMultipliers,
  factionReputationPerSecond,
  factionStateOf,
  hackingValue,
  type JoinedFaction,
  type MediumSnapshotData,
  type SlowSnapshotData,
} from "@bitburner-agent/core";
import { describe, expect, test } from "vitest";
import {
  bestWorkRate,
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
  resetInfoOf,
  SLOW_SNAPSHOT_GAP_MS,
  workCandidates,
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
  lastAugReset = 0,
  skipped,
}: {
  joined?: Record<string, number | { reputation: number; favor: number }>;
  invitations?: string[];
  queued?: string[];
  installed?: Record<string, number>;
  currentNode?: number;
  ownedSF?: Record<string, number>;
  lastAugReset?: number;
  /** A skipped reading (#197): the last state again. */
  skipped?: string;
} = {}): SlowSnapshotData {
  const factions: JoinedFaction[] = Object.entries(joined).map(([name, figures]) =>
    typeof figures === "number" ? { name, reputation: figures, favor: 0 } : { name, ...figures },
  );
  return {
    resetInfo: { lastAugReset, lastNodeReset: 0, currentNode, ownedAugs: installed, ownedSF, bitNodeOptions: {} },
    purchasedServers: [],
    factions: {
      backend: skipped === undefined ? "sim" : "ui",
      state: { joined: factions, invitations, queuedAugmentations: queued },
      problem: null,
      ...(skipped === undefined ? {} : { skipped }),
    },
  };
}

/** Hacking work's rate a second for `medium`'s player at favour 0, focused. */
const hackingRate = (medium: MediumSnapshotData, favor = 0) =>
  factionReputationPerSecond(workingPersonOf(medium) as NonNullable<ReturnType<typeof workingPersonOf>>, "hacking", {
    favor,
    sourceFile15Level: 0,
    factionWorkRepGain: 1,
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

  test("by value a second at the player's level: CyberSec's next targets at hacking 55", () => {
    // At 1,500, Synaptic Enhancement Implant (ln 1.03 over 500 left) before BitWire (hacking ×1.05 at level 55, 0.082,
    // over 2,250); Neurotrainer I is reached (A6's to buy).
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 1_500 } })).choice?.augmentation).toBe(
      "Synaptic Enhancement Implant",
    );
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 2_000 } })).choice?.augmentation).toBe("BitWire");
    // At 3,750: Cranial Signal Processors - Gen I (0.092 over 6,250 left) over Gen II, the more valuable (0.181) but
    // over 15,000 left.
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 3_750 } })).choice?.augmentation).toBe(
      "Cranial Signal Processors - Gen I",
    );
    // With Gen I installed, Gen II at last.
    const genOne = slow({ joined: { CyberSec: 3_750 }, installed: { "Cranial Signal Processors - Gen I": 1 } });
    expect(chooseFactionWork(player(55), genOne).choice?.augmentation).toBe("Cranial Signal Processors - Gen II");
  });

  test("the value counts, not the time alone, and the level weighs the skill: CyberSec at 1,000", () => {
    // At hacking 300 BitWire's ×1.05 is worth 0.45 (an experience ×1.56), over 2,750 left, before Synaptic
    // Enhancement Implant's 0.030 over 1,000 left, the nearer.
    expect(chooseFactionWork(player(300), slow({ joined: { CyberSec: 1_000 } })).choice?.augmentation).toBe("BitWire");
    // At hacking 55 BitWire is worth 0.082, against Synaptic's 0.030 a third as far: still just ahead.
    expect(chooseFactionWork(player(55), slow({ joined: { CyberSec: 1_000 } })).choice?.augmentation).toBe("BitWire");
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
    const options = { favor: 0, sourceFile15Level: 0, focused: true, implant: false, factionWorkRepGain: 1 };
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

describe("chooseFactionWork's parts, for A6 too (#203 review)", () => {
  const person = workingPersonOf(player(55)) as NonNullable<ReturnType<typeof workingPersonOf>>;
  const conditions = { sourceFile15Level: 0, focused: true, implant: false, factionWorkRepGain: 1 };

  test("bestWorkRate: the faction's best work type and its rate; null for none offered, or none earned", () => {
    expect(bestWorkRate(person, { name: "CyberSec", reputation: 0, favor: 0 }, conditions)).toEqual({
      workType: "hacking",
      perSecond: hackingRate(player(55)),
    });
    expect(bestWorkRate(person, { name: "Shadows of Anarchy", reputation: 0, favor: 0 }, conditions)).toBeNull();
    expect(bestWorkRate(person, { name: "Not A Faction", reputation: 0, favor: 0 }, conditions)).toBeNull();
    const nobody = workingPersonOf(player(0, { others: 0 })) as NonNullable<ReturnType<typeof workingPersonOf>>;
    expect(bestWorkRate(nobody, { name: "CyberSec", reputation: 0, favor: 0 }, conditions)).toBeNull();
  });

  test("workCandidates: each augmentation worth working for, with its value at the level and the reputation", () => {
    const state = factionStateOf(slow({ joined: { CyberSec: 1_000 } })) as NonNullable<
      ReturnType<typeof factionStateOf>
    >;
    const resetInfo = resetInfoOf(slow()) as NonNullable<ReturnType<typeof resetInfoOf>>;
    expect(workCandidates(state, resetInfo, 55).map(({ augmentation }) => augmentation)).toEqual([
      "BitWire",
      "Synaptic Enhancement Implant",
      "Cranial Signal Processors - Gen I",
      "Cranial Signal Processors - Gen II",
    ]);
    expect(workCandidates(state, resetInfo, 300)[0]).toEqual({
      faction: "CyberSec",
      augmentation: "BitWire",
      value: hackingValue("BitWire", 300),
      reputationNeeded: 3_750,
      reputation: 1_000,
    });
  });

  test("the ETA is to what's left: the requirement less the faction's reputation, at the rate", () => {
    const plan = chooseFactionWork(player(55), slow({ joined: { CyberSec: 1_500 } }));
    expect(plan.choice?.etaSeconds).toBeCloseTo((2_000 - 1_500) / hackingRate(player(55)), 9);
  });

  test("the BitNode's FactionWorkRepGain in the rate (#203 review): BN14's 0.2, so its work isn't taken for stalled", () => {
    const bn14 = chooseFactionWork(player(55), slow({ joined: { CyberSec: 0 }, currentNode: 14 }));
    expect(bn14.choice?.reputationPerSecond).toBeCloseTo(hackingRate(player(55)) * 0.2, 12);
    // Working at BN14's own rate for 20 minutes: never under half of it.
    const { factions, log, update } = ruleOf();
    const rate = hackingRate(player(55)) * 0.2;
    for (let minute = 0; minute <= 20; minute++) {
      const reputation = rate * 60 * minute;
      update({ slowData: slow({ joined: { CyberSec: reputation }, currentNode: 14 }), slowAtMs: minute * 60_000 });
    }
    expect(log.filter((line) => line.includes("STALLED"))).toEqual([]);
    expect(factions.stall()).toMatchObject({ sinceMs: 20 * 60_000 });
  });
});

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

/** A rule, its log and its events, and an update with the inputs given over BN1's defaults. */
function ruleOf() {
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
      [FACTION_WORK_CHOSEN_EVENT_KIND, 3_000, "BitWire"],
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
    expect(factions.view()).toMatchObject({ enabled: false, waitingFor: "the brain's faction work is switched off" });
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

  test("the stall: under half the work's rate over the last 10 minutes, logged once; at half its rate again, it ends", () => {
    const { factions, log, update } = rule();
    const rate = hackingRate(player(55));
    const at = (minutes: number, reputation: number) =>
      update({ slowData: slow({ joined: { CyberSec: reputation } }), slowAtMs: minutes * 60_000 });
    at(0, 0);
    // Not stalled: since the newest reading.
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 0 });
    // The passive gain's few a minute: nothing judged before 10 minutes of readings.
    for (let minute = 1; minute <= 9; minute++) at(minute, minute * 2);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 9 * 60_000 });
    at(10, 20);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 0 });
    expect(log.filter((line) => line.includes("STALLED"))).toEqual([
      expect.stringMatching(
        /^faction work STALLED: CyberSec's reputation has risen under half the hacking work's 0\.\d\d\/s over the last 10 min, /,
      ),
    ]);
    at(11, 22);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 0 });
    expect(log.filter((line) => line.includes("STALLED"))).toHaveLength(1);
    // Half the rate over the 10 minutes from minute 2: on track again.
    at(12, 4 + 0.5 * rate * 600);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 12 * 60_000 });
    expect(log.at(-1)).toBe("faction work: CyberSec's reputation is rising at the work's rate again");
  });

  test("skipped readings (#197: the casino, an infiltration) are left out of the window: no stall over them", () => {
    const { factions, log, update } = rule();
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 0 });
    // Twenty minutes of skipped readings, the state as last read.
    for (let minute = 1; minute <= 20; minute++) {
      update({ slowData: slow({ joined: { CyberSec: 0 }, skipped: "the casino is open" }), slowAtMs: minute * 60_000 });
    }
    expect(log.filter((line) => line.includes("STALLED"))).toEqual([]);
    // The newest reading counted is the first: the alert says there's been none since (dashboard-alerts.test.ts).
    expect(factions.stall()).toEqual({ faction: "CyberSec", sinceMs: 0, lastReadingAtMs: 0 });
    // A read again, at the work's rate since: on track.
    update({ slowData: slow({ joined: { CyberSec: hackingRate(player(55)) * 60 * 21 } }), slowAtMs: 21 * 60_000 });
    expect(log.filter((line) => line.includes("STALLED"))).toEqual([]);
  });

  test("an invitation left to the owner is logged again after a reset (#203 review): it comes again", () => {
    const { log, update } = rule();
    update({ slowData: slow({ invitations: ["Sector-12"], lastAugReset: 1 }) });
    update({ slowData: slow({ invitations: ["Sector-12"], lastAugReset: 1 }) });
    update({ slowData: slow({ invitations: ["Sector-12"], lastAugReset: 2 }) });
    expect(log.filter((line) => line.startsWith("factions: Sector-12's invitation"))).toHaveLength(2);
  });

  test("the stall with the page's stale readings: flat, then the passive gain's jump at its 10-minute refresh", () => {
    // Work not going on, read through the page: the faction's reputation as last read, then 10 minutes of passive gain
    // (1/120 a cycle, 25) when the Factions page is opened again. One interval of it looks on track; the window doesn't.
    const { factions, log, update } = rule();
    const at = (minutes: number, reputation: number) =>
      update({ slowData: slow({ joined: { CyberSec: reputation } }), slowAtMs: minutes * 60_000 });
    for (let minute = 0; minute <= 9; minute++) at(minute, 100);
    at(10, 125);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 0 });
    for (let minute = 11; minute <= 19; minute++) at(minute, 125);
    at(20, 150);
    expect(factions.stall()).toMatchObject({ faction: "CyberSec", sinceMs: 0 });
    expect(log.filter((line) => line.includes("STALLED"))).toHaveLength(1);
    expect(log.filter((line) => line.includes("again"))).toEqual([]);
  });

  test("the stall's watch starts again with another faction, and goes with the work not sent or the snapshots", () => {
    const { factions, update } = rule();
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 0 });
    update({ slowData: slow({ joined: { CyberSec: 0 } }), slowAtMs: 5 * 60_000 });
    expect(factions.stall()?.sinceMs).toBe(5 * 60_000);
    // Another faction: NiteSec's BitWire reached, its Cranial Signal Processors nearer than CyberSec's.
    update({ slowData: slow({ joined: { CyberSec: 0, NiteSec: 9_000 } }), slowAtMs: 6 * 60_000 });
    expect(factions.stall()).toMatchObject({ faction: "NiteSec", sinceMs: 6 * 60_000 });
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

  test("a stall: under half the rate over a 10-minute window, from the first such window's start, ongoing at the end", () => {
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

  test("a stall through the page's stale readings: flat, then a jump at each 10-minute refresh", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    for (let minute = 0; minute <= 20; minute++) {
      timeline.addSlow(minute * 60_000, slow({ joined: { CyberSec: 100 + 25 * Math.floor(minute / 10) } }));
    }
    expect(timeline.stalls).toEqual([expect.objectContaining({ fromMs: 0, toMs: 20 * 60_000, ongoing: true })]);
  });

  test("skipped readings are neither a reading of the window nor a gain; a drop isn't a negative gain", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    timeline.addSlow(0, slow({ joined: { CyberSec: 0 } }));
    for (let minute = 1; minute <= 2; minute++) {
      timeline.addSlow(minute * 60_000, slow({ joined: { CyberSec: 0 }, skipped: "the casino is open" }));
    }
    timeline.addSlow(3 * 60_000, slow({ joined: { CyberSec: 90 } }));
    timeline.addSlow(4 * 60_000, slow({ joined: { CyberSec: 10 } }));
    timeline.addSlow(5 * 60_000, slow({ joined: { CyberSec: 40 } }));
    expect([...timeline.gained]).toEqual([["CyberSec", 120]]);
    const skipping = new FactionWorkTimeline([chosen(0)], STARTED);
    skipping.addSlow(0, slow({ joined: { CyberSec: 0 } }));
    for (let minute = 1; minute <= 20; minute++) {
      // Each within 3 minutes of the last, so no gap: only the skipped readings stand between.
      if (minute % 2 === 0) skipping.addSlow(minute * 60_000, slow({ joined: { CyberSec: 0 }, skipped: "the casino" }));
    }
    expect(skipping.stalls).toEqual([]);
  });

  test("a stall that ends: on track again, not ongoing", () => {
    const timeline = new FactionWorkTimeline([chosen(0)], STARTED);
    slows(timeline, 0, 12, 1);
    // Over the window from minute 3, half of 0.5/s is 150.
    timeline.addSlow(13 * 60_000, slow({ joined: { CyberSec: 3 + 150 } }));
    expect(timeline.stalls).toEqual([expect.objectContaining({ fromMs: 0, toMs: 12 * 60_000, ongoing: false })]);
  });
});
