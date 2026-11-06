// A6's decision before the commit (#260: moved from the brain, shared with the fast model). The brain's augmentation
// suite covers it through the rule; these pin what the rule's state alone can't reach.
import { expect, test } from "vitest";
import { augmentationEndgame, augmentationShops, installJudgement } from "../src/augmentation-decision.ts";
import { chooseAugmentationsToBuy } from "../src/augmentation-plan.ts";
import { type AugmentationPurchaseState, augmentationBitNodeMultipliers } from "../src/augmentations.ts";

const bitNode = augmentationBitNodeMultipliers(1, {});
const stateOf = (installed: Record<string, number>, queued: string[] = []): AugmentationPurchaseState => ({
  installed,
  queued,
  sourceFile11Level: 0,
  bitNodeMultipliers: bitNode,
});
const skills = { hacking: 3000, strength: 1, defense: 1, dexterity: 1, agility: 1 };

test("what's queued counts as something to install: nothing left installs it, with an empty set", () => {
  // CyberSec's five all queued (bought, not installed): nothing left there, nothing more to buy.
  const queued = ["BitWire", "Synaptic Enhancement Implant", "Cranial Signal Processors - Gen I", "Neurotrainer I"];
  const state = stateOf({}, queued);
  const owned = (name: string) => queued.includes(name) || name === "Cranial Signal Processors - Gen II";
  const shops = augmentationShops([{ name: "CyberSec", reputation: 1e6, favor: 0 }], 1, state, owned);
  const set = chooseAugmentationsToBuy(shops.reached, state, 0, 300);
  const judged = (installable: string[]) =>
    installJudgement({
      state,
      installable,
      set,
      money: 0,
      shops,
      owned,
      terms: undefined,
      short: false,
      onlineMs: 30 * 60_000,
      sinceResetMs: 30 * 60_000,
    }).rule;
  expect(judged(queued)).toMatchObject({ install: true, reason: "nothing left", affordable: 4 });
  // With nothing really to install (each queued one an `augmentationNotQueued`), never (#213's guarantee).
  expect(judged([]).install).toBe(false);
});

test("the endgame's holds carry their figures for the brain's words", () => {
  const shopsWith = (reputation: number, favor: number) =>
    augmentationShops([{ name: "Daedalus", reputation, favor }], 1, stateOf({}), () => false);
  const endgame = (reputation: number, favor: number, money: number) =>
    augmentationEndgame({
      installed: {},
      installable: [],
      queue: [],
      state: stateOf({}),
      shops: shopsWith(reputation, favor),
      money,
      factionRep: 4,
      figures: { money, skills },
      currentNode: 1,
      ownedSF: {},
      destroyWanted: true,
    });
  expect(endgame(0, 150, 1e9)).toMatchObject({ kind: "hold", why: "redPill", donation: { faction: "Daedalus" } });
  expect(endgame(1000, 0, 1e9)).toMatchObject({
    kind: "hold",
    why: "redPill",
    seller: { faction: "Daedalus", reputation: 1000, needed: 2.5e6 },
  });
  expect(endgame(462_491, 0, 1e9)).toEqual({ kind: "daedalusDonations" });
  expect(endgame(2.5e6, 0, 0)).toEqual({ kind: "redPill", donation: null });
  // The Red Pill installed: the destroy's hold, or nothing when the destroy isn't wanted.
  const installed = (destroyWanted: boolean) =>
    augmentationEndgame({
      installed: { "The Red Pill": 1 },
      installable: [],
      queue: [],
      state: stateOf({ "The Red Pill": 1 }),
      shops: shopsWith(0, 0),
      money: 0,
      factionRep: 1,
      figures: { money: 0, skills },
      currentNode: 1,
      ownedSF: {},
      destroyWanted,
    });
  expect(installed(true)).toEqual({ kind: "hold", why: "destroy", reserve: 0 });
  expect(installed(false)).toEqual({ kind: "none" });
});
