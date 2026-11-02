// Favour and donations (#225): the game's formulas (`Faction/formulas/favor.ts`, `donation.ts`), worked by hand from
// their constants; the brain's parity suite checks them against the engine's `ns.formulas.reputation`.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { AUGMENTATION_BITNODE_MULTIPLIERS } from "../src/augmentation-data.ts";
import {
  acceptsDonations,
  BASE_FAVOR_TO_DONATE,
  DONATE_MONEY_TO_REPUTATION_DIVISOR,
  DONATION_REPUTATION_MARGIN,
  donationForReputation,
  donationsUnlocked,
  donationToReach,
  favorAfterInstall,
  favorToDonate,
  favorToRep,
  MAX_FAVOR,
  repFromDonation,
  repToFavor,
  reputationToUnlockDonations,
} from "../src/donations.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");
const BN1 = { FavorToDonateToFaction: 1 };

describe("favour", () => {
  test("favorToRep and repToFavor: 25000 × (1.02^f − 1), and back; none below 0, none above the most", () => {
    expect(favorToRep(0)).toBe(0);
    expect(favorToRep(1)).toBeCloseTo(500, 9);
    expect(favorToRep(150)).toBeCloseTo(25000 * (1.02 ** 150 - 1), 6);
    expect(favorToRep(-5)).toBe(0);
    for (const favor of [0.5, 12.25, 99, 150, 1000]) expect(repToFavor(favorToRep(favor))).toBeCloseTo(favor, 9);
    expect(repToFavor(0)).toBe(0);
    expect(repToFavor(Number.POSITIVE_INFINITY)).toBe(MAX_FAVOR);
    // The game's constants, not ours: a changed game fails here first.
    expect(gameSource("Faction/formulas/favor.ts")).toContain("const log1point02 = 0.019802627296179712;");
    expect(gameSource("Faction/formulas/favor.ts")).toContain(`export const MaxFavor = ${MAX_FAVOR};`);
    expect(gameSource("Constants.ts")).toContain(`BaseFavorToDonate: ${BASE_FAVOR_TO_DONATE},`);
    expect(gameSource("Constants.ts")).toContain("DonateMoneyToRepDivisor: 1e6,");
    expect(DONATE_MONEY_TO_REPUTATION_DIVISOR).toBe(1e6);
  });

  test("favorAfterInstall: this cycle's reputation added to the favour's worth, as at an install", () => {
    expect(favorAfterInstall(0, 0)).toBe(0);
    expect(favorAfterInstall(0, 500)).toBeCloseTo(1, 9);
    // Favour compounds: 100 favour and 306,374 reputation make 150.
    expect(favorAfterInstall(100, 306_374)).toBeGreaterThanOrEqual(150);
    expect(favorAfterInstall(100, 306_373)).toBeLessThan(150);
  });
});

describe("unlocking donations", () => {
  test("favorToDonate: floor(150 × FavorToDonateToFaction): 150 in BN1, 75 in BN3, 0 in BN8, 153 in BN12.1", () => {
    expect(favorToDonate(BN1)).toBe(150);
    expect(favorToDonate(AUGMENTATION_BITNODE_MULTIPLIERS[3] as { FavorToDonateToFaction: number })).toBe(75);
    expect(favorToDonate(AUGMENTATION_BITNODE_MULTIPLIERS[8] as { FavorToDonateToFaction: number })).toBe(0);
    expect(favorToDonate(AUGMENTATION_BITNODE_MULTIPLIERS[12] as { FavorToDonateToFaction: number })).toBe(153);
    // BN12.2: 150 × 1.02², 156.06, floored.
    expect(favorToDonate({ FavorToDonateToFaction: 1.02 ** 2 })).toBe(156);
    expect(donationsUnlocked(150, BN1)).toBe(true);
    expect(donationsUnlocked(149.999, BN1)).toBe(false);
    // BN8: every joined faction, from no favour.
    expect(donationsUnlocked(0, { FavorToDonateToFaction: 0 })).toBe(true);
  });

  test("reputationToUnlockDonations: the least whole reputation that makes the next install's favour the threshold", () => {
    expect(reputationToUnlockDonations(0, BN1)).toBe(462_491);
    for (const favor of [0, 12.5, 100, 149, 149.9999]) {
      const reputation = reputationToUnlockDonations(favor, BN1);
      expect(favorAfterInstall(favor, reputation), `from ${favor}`).toBeGreaterThanOrEqual(150);
      expect(favorAfterInstall(favor, reputation - 1), `from ${favor}`).toBeLessThan(150);
    }
    expect(reputationToUnlockDonations(100, BN1)).toBe(306_374);
    // Unlocked already: nothing to earn; BN3 halves the favour, so far less.
    expect(reputationToUnlockDonations(150, BN1)).toBe(0);
    expect(reputationToUnlockDonations(150.5, BN1)).toBe(0);
    expect(reputationToUnlockDonations(0, { FavorToDonateToFaction: 0 })).toBe(0);
    expect(reputationToUnlockDonations(0, { FavorToDonateToFaction: 0.5 })).toBe(85_396);
    // A threshold past the most favour there is (BN12 from SF12.275, 150 × 1.02^276): never reached, and no loop.
    expect(reputationToUnlockDonations(0, { FavorToDonateToFaction: 1.02 ** 276 })).toBe(Number.POSITIVE_INFINITY);
    expect(reputationToUnlockDonations(35_000, { FavorToDonateToFaction: 35_331 / 150 })).toBeLessThan(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("a donation's reputation", () => {
  test("repFromDonation and donationForReputation: amount / 1e6 × faction_rep × FactionWorkRepGain, and back", () => {
    expect(repFromDonation(1e9, 1, 1)).toBe(1000);
    expect(repFromDonation(1e9, 1.5, 0.5)).toBe(750);
    expect(donationForReputation(1000, 1, 1)).toBe(1e9);
    expect(donationForReputation(750, 1.5, 0.5)).toBe(1e9);
  });

  test("donationToReach: the least whole dollars whose reputation is the amount and a hundredth, by the game's formula", () => {
    expect(DONATION_REPUTATION_MARGIN).toBe(0.01);
    expect(donationToReach(0, 1, 1)).toBe(0);
    expect(donationToReach(-3, 1, 1)).toBe(0);
    expect(donationToReach(2.5e6, 1, 1)).toBe(2.5e12 + 10_000);
    // Past 2^53 dollars none can be named: Infinity, which no money covers, and no loop.
    expect(donationToReach(1e10, 1, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(donationToReach(9e9, 1, 1)).toBe(9e15 + 10_000);
    for (const [reputation, factionRep, gain] of [
      [1000, 1.37, 0.75],
      [462_491.07, 1.1, 1],
      [17, 2.5, 0.2],
    ] as const) {
      const amount = donationToReach(reputation, factionRep, gain);
      expect(Number.isInteger(amount)).toBe(true);
      expect(repFromDonation(amount, factionRep, gain)).toBeGreaterThanOrEqual(reputation + DONATION_REPUTATION_MARGIN);
      expect(repFromDonation(amount - 1, factionRep, gain)).toBeLessThan(reputation + DONATION_REPUTATION_MARGIN);
      // Added to a reputation as the game adds it, never short of the price.
      for (const before of [0, 0.1, 5_000.3, 1e6 / 3]) {
        expect(
          before + repFromDonation(donationToReach(reputation, factionRep, gain), factionRep, gain),
        ).toBeGreaterThanOrEqual(before + reputation);
      }
    }
  });

  test("acceptsDonations: a faction with work, not the gang's; not Bladeburners, the Church or Shadows of Anarchy", () => {
    expect(acceptsDonations("CyberSec", null)).toBe(true);
    expect(acceptsDonations("Daedalus", null)).toBe(true);
    for (const faction of ["Bladeburners", "Church of the Machine God", "Shadows of Anarchy", "The Gibson"]) {
      expect(acceptsDonations(faction, null), faction).toBe(false);
    }
    expect(acceptsDonations("Slum Snakes", "Slum Snakes")).toBe(false);
    expect(acceptsDonations("Slum Snakes", null)).toBe(true);
  });
});
