// Favour first (#247): the faction it grinds at, from the game's data (each faction's shop, core's `isWorthInstalling`),
// its work toward the reputation that unlocks donations at the next install, and where it stands among A5's choices.
import { describe, expect, test } from "vitest";
import { daedalusCountOf, isWorthInstalling } from "../src/augmentation-plan.ts";
import { augmentationBitNodeMultipliers, augmentationCost, augmentationsSoldBy } from "../src/augmentations.ts";
import { reputationToUnlockDonations } from "../src/donations.ts";
import type { FactionState } from "../src/faction-state.ts";
import { factionReputationPerSecond, type WorkingPerson } from "../src/faction-work.ts";
import { factionWorkChoice, type WorkConditions, type WorkResetInfo } from "../src/faction-work-choice.ts";
import {
  describeFactionWorkPolicy,
  FACTION_WORK_POLICIES,
  FAVOUR_FIRST_FACTIONS,
  factionWorkChoiceUnder,
  favourFirstFaction,
  favourFirstWork,
  isFactionWorkPolicy,
} from "../src/favour-first.ts";

const PERSON: WorkingPerson = {
  skills: { hacking: 600, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
  mults: { faction_rep: 1 },
};
const CONDITIONS: WorkConditions = {
  sourceFile15Level: 0,
  focused: true,
  implant: false,
  factionWorkRepGain: 1,
  favorToDonateToFaction: 1,
  shareBonus: 1,
};
const RESET: WorkResetInfo = { currentNode: 1, ownedAugs: {}, ownedSF: { "1": 1 } };
const stateOf = (joined: FactionState["joined"], queuedAugmentations: string[] = []): FactionState => ({
  joined,
  invitations: [],
  queuedAugmentations,
});
const countableAt = (faction: string, installed: Record<string, number> = {}) =>
  augmentationsSoldBy(faction, 1, null).filter((name) => isWorthInstalling(name) && !Object.hasOwn(installed, name));
const countOf = (state: FactionState, reset: WorkResetInfo = RESET) =>
  daedalusCountOf({
    currentNode: reset.currentNode,
    ownedSF: reset.ownedSF,
    installed: reset.ownedAugs,
    joined: state.joined,
    invitations: state.invitations,
  });
/** The countable augmentation with the most reputation at `faction`, by core's price. */
const topOf = (faction: string, installed: Record<string, number> = {}) => {
  const purchase = {
    installed,
    queued: [],
    sourceFile11Level: 0,
    bitNodeMultipliers: augmentationBitNodeMultipliers(1, { "1": 1 }),
  };
  return countableAt(faction, installed)
    .map((name) => ({ name, reputation: augmentationCost(name, purchase).reputation }))
    .reduce((best, each) => (each.reputation > best.reputation ? each : best));
};

test("the policies: count first (today's) and favour first, in words; anything else isn't one", () => {
  expect(FACTION_WORK_POLICIES).toEqual(["countFirst", "favourFirst"]);
  expect(describeFactionWorkPolicy("countFirst")).toBe("count first");
  expect(describeFactionWorkPolicy("favourFirst")).toBe("favour first");
  for (const odd of ["count first", "", null, 1]) expect(isFactionWorkPolicy(odd)).toBe(false);
});

describe("favourFirstFaction", () => {
  test("in BN1 from nothing installed: BitRunners, 12 countable (CyberSec 5, NiteSec 10, The Black Hand 9, TDH 2)", () => {
    expect(FAVOUR_FIRST_FACTIONS).toEqual(["CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Tian Di Hui"]);
    expect(FAVOUR_FIRST_FACTIONS.map((faction) => countableAt(faction).length)).toEqual([5, 10, 9, 12, 2]);
    expect(favourFirstFaction(1, {})).toEqual({ faction: "BitRunners", countable: countableAt("BitRunners") });
  });

  test("the installed ones don't count: BitRunners' own installed leave NiteSec, first of the tie with The Black Hand", () => {
    const installed = Object.fromEntries(countableAt("BitRunners").map((name) => [name, 1]));
    const left = FAVOUR_FIRST_FACTIONS.map((faction) => countableAt(faction, installed).length);
    expect(left[3]).toBe(0);
    const most = Math.max(...left);
    expect(favourFirstFaction(1, installed).faction).toBe(FAVOUR_FIRST_FACTIONS[left.indexOf(most)]);
    expect(left.filter((each) => each === most).length).toBeGreaterThan(0);
  });

  test("nothing countable left at any of them: CyberSec, first of the tie at none, and its work none", () => {
    const installed = Object.fromEntries(
      FAVOUR_FIRST_FACTIONS.flatMap((faction) => countableAt(faction)).map((name) => [name, 1]),
    );
    expect(favourFirstFaction(1, installed)).toEqual({ faction: "CyberSec", countable: [] });
    const state = stateOf([{ name: "CyberSec", reputation: 0, favor: 0 }]);
    expect(favourFirstWork(PERSON, state, { ...RESET, ownedAugs: installed }, CONDITIONS)).toBeNull();
  });
});

describe("favourFirstWork", () => {
  test("BitRunners joined: its best work toward the reputation that unlocks its donations, naming its top augmentation", () => {
    const state = stateOf([
      { name: "CyberSec", reputation: 2_000, favor: 10 },
      { name: "BitRunners", reputation: 1_000, favor: 5 },
    ]);
    const needed = reputationToUnlockDonations(5, { FavorToDonateToFaction: 1 });
    const rate = factionReputationPerSecond(PERSON, "hacking", { favor: 5, ...CONDITIONS });
    const top = topOf("BitRunners");
    expect(favourFirstWork(PERSON, state, RESET, CONDITIONS)).toEqual({
      faction: "BitRunners",
      workType: "hacking",
      augmentation: top.name,
      reputation: 1_000,
      reputationNeeded: needed,
      reputationPerSecond: rate,
      etaSeconds: (needed - 1_000) / rate,
      target: "donations",
      augmentationReputation: top.reputation,
      favor: 5,
      favourFirst: true,
    });
    // From favour 5, more than the BitRunners Neurolink's own: the favour is the target, whatever it sells.
    expect(needed).toBeGreaterThan(top.reputation * 0.4);
  });

  test("none: BitRunners not joined, its reputation reached, its donations unlocked, or donations off", () => {
    const at = (reputation: number, favor: number) => stateOf([{ name: "BitRunners", reputation, favor }]);
    expect(favourFirstWork(PERSON, stateOf([{ name: "NiteSec", reputation: 0, favor: 0 }]), RESET, CONDITIONS)).toBe(
      null,
    );
    const needed = reputationToUnlockDonations(40, { FavorToDonateToFaction: 1 });
    expect(favourFirstWork(PERSON, at(needed - 1, 40), RESET, CONDITIONS)?.reputationNeeded).toBe(needed);
    expect(favourFirstWork(PERSON, at(needed, 40), RESET, CONDITIONS)).toBeNull();
    expect(favourFirstWork(PERSON, at(0, 150), RESET, CONDITIONS)).toBeNull();
    expect(favourFirstWork(PERSON, at(0, 0), RESET, { ...CONDITIONS, donations: false })).toBeNull();
  });

  test("the BitNode's favour to donate: BN3's 0.5 (75 favour) lowers the target", () => {
    const reset = { currentNode: 3, ownedAugs: {}, ownedSF: {} };
    const { FavorToDonateToFaction } = augmentationBitNodeMultipliers(3, {});
    expect(FavorToDonateToFaction).not.toBe(1);
    const state = stateOf([{ name: "BitRunners", reputation: 0, favor: 0 }]);
    const choice = favourFirstWork(PERSON, state, reset, {
      ...CONDITIONS,
      favorToDonateToFaction: FavorToDonateToFaction,
    });
    expect(choice?.reputationNeeded).toBe(reputationToUnlockDonations(0, { FavorToDonateToFaction }));
    expect(choice?.reputationNeeded).toBeLessThan(reputationToUnlockDonations(0, { FavorToDonateToFaction: 1 }));
  });

  test("the top augmentation skips one queued; every countable one queued, none (A6 installs them)", () => {
    const top = topOf("BitRunners");
    const joined = [{ name: "BitRunners", reputation: 0, favor: 0 }];
    expect(favourFirstWork(PERSON, stateOf(joined, [top.name]), RESET, CONDITIONS)?.augmentation).not.toBe(top.name);
    expect(favourFirstWork(PERSON, stateOf(joined, countableAt("BitRunners")), RESET, CONDITIONS)).toBeNull();
  });
});

describe("factionWorkChoiceUnder", () => {
  const state = stateOf([
    { name: "CyberSec", reputation: 0, favor: 0 },
    { name: "NiteSec", reputation: 0, favor: 0 },
    { name: "BitRunners", reputation: 0, favor: 0 },
  ]);

  test("count first is A5's own choice; favour first grinds at BitRunners instead", () => {
    const own = factionWorkChoice(PERSON, state, RESET, CONDITIONS, countOf(state));
    expect(factionWorkChoiceUnder("countFirst", PERSON, state, RESET, CONDITIONS, countOf(state))).toEqual(own);
    expect(own?.favourFirst).toBeUndefined();
    const grind = factionWorkChoiceUnder("favourFirst", PERSON, state, RESET, CONDITIONS, countOf(state));
    expect(grind).toMatchObject({ faction: "BitRunners", target: "donations", favourFirst: true });
    expect(grind).not.toEqual(own);
  });

  test("favour first falls back to A5's own once BitRunners isn't joined, or its target is reached", () => {
    const withoutIt = stateOf(state.joined.filter((each) => each.name !== "BitRunners"));
    expect(factionWorkChoiceUnder("favourFirst", PERSON, withoutIt, RESET, CONDITIONS, countOf(withoutIt))).toEqual(
      factionWorkChoice(PERSON, withoutIt, RESET, CONDITIONS, countOf(withoutIt)),
    );
    const reached = stateOf([
      ...withoutIt.joined,
      { name: "BitRunners", reputation: reputationToUnlockDonations(0, { FavorToDonateToFaction: 1 }), favor: 0 },
    ]);
    expect(factionWorkChoiceUnder("favourFirst", PERSON, reached, RESET, CONDITIONS, countOf(reached))).toEqual(
      factionWorkChoice(PERSON, reached, RESET, CONDITIONS, countOf(reached)),
    );
  });

  test("The Red Pill's work stays first under favour first: it ends the BitNode", () => {
    const withDaedalus = stateOf([...state.joined, { name: "Daedalus", reputation: 0, favor: 0 }]);
    expect(
      factionWorkChoiceUnder("favourFirst", PERSON, withDaedalus, RESET, CONDITIONS, countOf(withDaedalus)),
    ).toMatchObject({ faction: "Daedalus", augmentation: "The Red Pill" });
  });
});
