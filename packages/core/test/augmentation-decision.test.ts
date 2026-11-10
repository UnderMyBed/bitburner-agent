// A6's decision before the commit (#260: moved from the brain, shared with the fast model). The brain's augmentation
// suite covers it through the rule; these pin what the rule's state alone can't reach.
import { expect, test } from "vitest";
import {
  augmentationEndgame,
  augmentationShops,
  GANG_RED_PILL_HOLD_MS,
  gangRedPillEtaMs,
  installJudgement,
} from "../src/augmentation-decision.ts";
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

test("the gang's faction's shop (#334): in the shops, never joined; its reputation reaches, the seller with the most", () => {
  const state = stateOf({});
  const gang = { name: "NiteSec", reputation: 50_000, favor: 0 };
  // Passed as joined too (a slow snapshot as the game reports it): never joined, so no work or donation goes there.
  const joined = [
    { name: "CyberSec", reputation: 100_000, favor: 200 },
    { name: "NiteSec", reputation: 50_000, favor: 0 },
  ];
  const shops = augmentationShops(joined, 2, state, () => false, gang);
  expect(shops.joined.map((each) => each.name)).toEqual(["CyberSec"]);
  expect(shops.gangFaction).toBe("NiteSec");
  expect(shops.shops.get("NiteSec")).toHaveLength(98);
  expect(shops.reputationOf("NiteSec")).toBe(50_000);
  // Sold only elsewhere (BitRunners' 'BitRunners Neurolink', 875,000 reputation): not reached at 50,000.
  expect(shops.sold).toContain("BitRunners Neurolink");
  expect(shops.reached).not.toContain("BitRunners Neurolink");
  // CyberSec's BitWire (3,750): its seller CyberSec, with more; Augmented Targeting I (5,000), not NiteSec's own, the
  // gang's faction.
  expect(shops.sellerOf("BitWire")).toBe("CyberSec");
  expect(shops.sellerOf("Augmented Targeting I")).toBe("NiteSec");
  expect(shops.reached).toContain("Augmented Targeting I");
  expect(shops.reached).not.toContain("The Red Pill");
  // Without a gang: NiteSec as joined, its own shop.
  const without = augmentationShops(joined, 2, state, () => false);
  expect(without.gangFaction).toBeNull();
  expect(without.shops.get("NiteSec")).not.toContain("Augmented Targeting I");
  expect(without.sellerOf("Augmented Targeting I")).toBeNull();
});

test("gangRedPillEtaMs (#334): the reputation still needed at the cycle's average rate; never with none earned", () => {
  // 500,000 in 20 minutes: 2,000,000 more at 25,000 a minute, 80 minutes.
  expect(gangRedPillEtaMs(500_000, 2.5e6, 20 * 60_000)).toBeCloseTo(80 * 60_000, 6);
  expect(gangRedPillEtaMs(2.5e6, 2.5e6, 20 * 60_000)).toBe(0);
  expect(gangRedPillEtaMs(3e6, 2.5e6, 20 * 60_000)).toBe(0);
  expect(gangRedPillEtaMs(0, 2.5e6, 20 * 60_000)).toBe(Number.POSITIVE_INFINITY);
  expect(gangRedPillEtaMs(1, 2.5e6, null)).toBe(Number.POSITIVE_INFINITY);
  expect(gangRedPillEtaMs(1, 2.5e6, 0)).toBe(Number.POSITIVE_INFINITY);
  expect(GANG_RED_PILL_HOLD_MS).toBe(20 * 60_000);
});

test("A8 with the gang's faction (#334): reached, its install; short, held only within the window; no Daedalus hold", () => {
  const state = stateOf({});
  // Daedalus's invitation missing its money alone in BN2: 30 installed, hacking 3,000.
  const installed = Object.fromEntries(
    augmentationShops([], 2, state, () => false, { name: "NiteSec", reputation: 0, favor: 0 })
      .sold.slice(0, 30)
      .map((name) => [name, 1]),
  );
  const endgame = (reputation: number, sinceResetMs: number | null, daedalus: number | null = null) =>
    augmentationEndgame({
      installed,
      installable: [],
      queue: [],
      state: { ...state, installed },
      shops: augmentationShops(
        daedalus === null ? [] : [{ name: "Daedalus", reputation: daedalus, favor: 0 }],
        2,
        { ...state, installed },
        () => false,
        { name: "NiteSec", reputation, favor: 0 },
      ),
      money: 1e9,
      factionRep: 1,
      figures: { money: 1e9, skills },
      currentNode: 2,
      ownedSF: { 1: 3 },
      destroyWanted: true,
      sinceResetMs,
    });
  expect(endgame(2.5e6, 60_000)).toEqual({ kind: "redPill", donation: null });
  // 2m in 60 minutes: the rest in 15 minutes, within 20: held, the time said.
  expect(endgame(2e6, 3_600_000)).toEqual({
    kind: "hold",
    why: "redPill",
    reserve: 0,
    seller: { faction: "NiteSec", reputation: 2e6, needed: 2.5e6, etaMs: 15 * 60_000 },
  });
  // 2m in 80 minutes: 20 minutes more, the window's edge, held; 1m in 60: 90 more, not held.
  expect(endgame(2e6, 80 * 60_000)).toMatchObject({ kind: "hold", seller: { etaMs: 20 * 60_000 } });
  // Not held, and no hold for Daedalus's money: the gang's faction sells it, so its invitation isn't needed.
  expect(endgame(1e6, 3_600_000)).toEqual({ kind: "none" });
  expect(endgame(1e6, null)).toEqual({ kind: "none" });
  // Daedalus joined, short too: its hold, as ever (an install would lose its reputation).
  expect(endgame(1e6, 3_600_000, 1000)).toMatchObject({
    kind: "hold",
    seller: { faction: "Daedalus", reputation: 1000, needed: 2.5e6 },
  });
  // Reached at either: the install.
  expect(endgame(1e6, 3_600_000, 2.5e6)).toEqual({ kind: "redPill", donation: null });
});
