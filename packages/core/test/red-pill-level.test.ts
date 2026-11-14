// D from m (#410): the time after The Red Pill's install to w0r1d_d43m0n's level at the multipliers it leaves, levelling's
// own least candidate then; its hindcast on BN4.1, BN4.2 and BN4.3 (the readback's `dphase.txt`: the level and
// experience every 30 min of each BN4 endgame), BN4.3's three moments replayed through main's code (`evidence.txt`), and
// The Red Pill's install timed: now, or first batching to the levelling set, by #406's margin (the measured error of
// their difference).
import { describe, expect, test } from "vitest";
import { AUGMENTATIONS } from "../src/augmentation-data.ts";
import { augmentationShops } from "../src/augmentation-decision.ts";
import { affordableCounts, chooseAugmentationsToBuy, neuroFluxLadder } from "../src/augmentation-plan.ts";
import { donationTermsOf } from "../src/augmentation-reach.ts";
import { augmentationBitNodeMultipliers, NEUROFLUX_GOVERNOR } from "../src/augmentations.ts";
import { hackingLevelOfExp } from "../src/batcher.ts";
import { destroyEstimate } from "../src/destroy-estimate.ts";
import type { JoinedFaction } from "../src/faction-state.ts";
import type { HackingPlayer, HackingTarget } from "../src/hacking-ceiling.ts";
import {
  addsToLevelling,
  batchThenInstallPlan,
  chooseLevelling,
  type LevellingRate,
  levelLoopThreads,
  levellingEstimates,
  levellingExpPerThreadSecond,
  levellingInstallMultipliers,
  levellingPreparationMs,
  levellingSecondsAfterInstall,
  type RedPillInstallOffer,
  type RedPillPurchase,
  rateStandardError,
  redPillInstallTiming,
  redPillLevelling,
  secondsToHackingLevel,
} from "../src/levelling.ts";

const HOUR = 3600;
const YEAR = 365 * 24 * HOUR;
/** 3000 × BN4's `WorldDaemonDifficulty` 3 (`BitNode/BitNode.tsx:660`, `Server/ServerHelpers.ts:383-385`). */
const REQUIRED = 9000;
/** joesguns (`Server/data/servers.ts`) at BN4's ServerMaxMoney 0.1125 (`BitNode/BitNode.tsx:635`). */
const JOESGUNS: HackingTarget = {
  moneyMax: 6.25e7 * 0.1125,
  minDifficulty: 5,
  baseDifficulty: 15,
  requiredHackingSkill: 10,
  serverGrowth: 20,
};
/** BN4's HackExpGain 0.4 (`BitNode/BitNode.tsx:648`), folded into `hacking_exp` as the brain does. */
const BN4_HACK_EXP_GAIN = 0.4;
/** Home at 16,777,216 GB in BN4.2 and BN4.3 (dphase's homeRAM), less the Agent's 32. */
const HOME_THREADS = levelLoopThreads([16_777_216 - 32]);
const BN4 = augmentationBitNodeMultipliers(4, {});
/** The BitNode's time so far at BN4.3's Red Pill install, 17 h 44 min online (the readback's scoreboard). */
const BN43_SO_FAR = (17 * 60 + 44) * 60;

/** Levelling mode after an install, from player multipliers `m`, `he`, `hs` at `level` now (home's RAM). */
function offerAt({ m, he, hs, level }: { m: number; he: number; hs: number; level: number }) {
  const player: HackingPlayer = {
    skills: { hacking: level, intelligence: 0 },
    mults: { hacking_chance: 1, hacking_speed: hs, hacking_money: 1, hacking_grow: 1 },
  };
  const perThread = {
    expPerSecond: levellingExpPerThreadSecond(JOESGUNS, player, he * BN4_HACK_EXP_GAIN, "grow"),
    atLevel: level,
  };
  const after = { ...player, skills: { hacking: hackingLevelOfExp(0, m), intelligence: 0 } };
  return { homeThreads: HOME_THREADS, perThread, preparationMs: levellingPreparationMs(JOESGUNS, after, HOME_THREADS) };
}
/** D from m with nothing more bought: the formula's rate, its factor unmeasured (1). */
const dFromM = (figures: { m: number; he: number; hs: number; level: number }) =>
  levellingSecondsAfterInstall(0, [], offerAt(figures), 1, REQUIRED, figures.m);

/** BN4.2's installed augmentations (core's levelling.test.ts golden case, its campaign report's list). */
const BN42_INSTALLED = [
  "Artificial Synaptic Potentiation",
  "Cranial Signal Processors - Gen I",
  "Speech Processor Implant",
  "Neurotrainer II",
  "INFRARET Enhancement",
  "Social Negotiation Assistant (S.N.A)",
  "Combat Rib I",
  "Nuoptimal Nootropic Injector Implant",
  "ADR-V1 Pheromone Gene",
  "Augmented Targeting I",
  "Speech Enhancement",
  "BitWire",
  "Synaptic Enhancement Implant",
  "Neurotrainer I",
  "Wired Reflexes",
  "NutriGen Implant",
  "Neural-Retention Enhancement",
  "Embedded Netburner Module",
  "Cranial Signal Processors - Gen II",
  "Neural Wit Amplifier",
  "Magnetism Amplifier",
  "Cranial Signal Processors - Gen III",
  "CRTX42-AA Gene Modification",
  "CashRoot Starter Kit",
  "Augmented Targeting II",
  "Combat Rib II",
  "DermaForce Particle Barrier",
  "Nanofiber Weave",
  "Neuregen Gene Modification",
  "Neuralstimulator",
  "Enhanced Myelin Sheathing",
  "Cranial Signal Processors - Gen IV",
  "The Black Hand",
  "DataJack",
  "Artificial Bio-neural Network Implant",
  "Embedded Netburner Module Core Implant",
  "Cranial Signal Processors - Gen V",
  "Neural Accelerator",
  "Embedded Netburner Module Core V2 Upgrade",
  "BitRunners Neurolink",
  "Embedded Netburner Module Core V3 Upgrade",
  "Embedded Netburner Module Direct Memory Access Upgrade",
  "Embedded Netburner Module Analyze Engine",
  "The Red Pill",
];
/** The three BN4.3 never had (the readback: ×1.15, ×1.08, ×1.10), and the two it bought at The Red Pill. */
const BN43_MISSING = [
  "BitRunners Neurolink",
  "Embedded Netburner Module Core V2 Upgrade",
  "Embedded Netburner Module Core V3 Upgrade",
];
const RED_PILL_PURCHASES = [
  "Embedded Netburner Module Direct Memory Access Upgrade",
  "Embedded Netburner Module Analyze Engine",
  "The Red Pill",
];
/** BN4.3's installed before The Red Pill (assumed: BN4.2's less the five; only prerequisites and prices read it). */
const installedOf = (neuroFlux: number, also: readonly string[] = []) => ({
  ...Object.fromEntries(
    BN42_INSTALLED.filter((name) => !BN43_MISSING.includes(name) && !RED_PILL_PURCHASES.includes(name)).map((name) => [
      name,
      1,
    ]),
  ),
  ...Object.fromEntries(also.map((name) => [name, 1])),
  [NEUROFLUX_GOVERNOR]: neuroFlux,
});

/** A6's set at any money that adds to levelling, and its ladder, as A6 prices them (core's, #380). */
function ladderAt(joined: JoinedFaction[], installed: Record<string, number>, factionRep: number, level: number) {
  const state = { installed, queued: [], sourceFile11Level: 0, bitNodeMultipliers: BN4 };
  const owned = (name: string) => Object.hasOwn(installed, name);
  const shops = augmentationShops(joined, 4, state, owned, null);
  const wanted = shops.sold.filter((name) => !owned(name) && shops.sellerOf(name) === null && addsToLevelling([name]));
  const terms = donationTermsOf(joined, shops.shops, wanted, factionRep, BN4);
  const toBuy = shops.reached.filter((name) => name !== "The Red Pill" && addsToLevelling([name]));
  const whole = chooseAugmentationsToBuy(toBuy, state, Number.MAX_VALUE, level, terms);
  return {
    state,
    shops,
    terms,
    set: whole.purchases.map((purchase) => purchase.name),
    ladder: neuroFluxLadder({ state, set: whole, neuroFluxReputation: shops.neuroFluxReputation, donations: terms }),
  };
}

/** Levelling mode after an install from multipliers `m`, `he`, `hs` at `level` now, the preparation at a purchase's. */
function levellingAfter({ m, he, hs, level }: { m: number; he: number; hs: number; level: number }) {
  const offer = offerAt({ m, he, hs, level });
  return {
    homeThreads: offer.homeThreads,
    perThread: offer.perThread,
    preparationMs: (purchase: RedPillPurchase) => {
      const gain = levellingInstallMultipliers(purchase.levels, purchase.augmentations);
      return levellingPreparationMs(
        JOESGUNS,
        {
          skills: { hacking: hackingLevelOfExp(0, m * gain.hacking), intelligence: 0 },
          mults: { hacking_chance: 1, hacking_speed: hs * gain.hackingSpeed, hacking_money: 1, hacking_grow: 1 },
        },
        HOME_THREADS,
      );
    },
  };
}

/**
 * (d)'s offer after The Red Pill's install with a purchase, as A6 prices it (#410): the purchase and The Red Pill
 * installed, the queue empty, every reputation 0, so the rest of the levelling set and NeuroFlux Governor's levels by
 * donation at the factions taking them now.
 */
function afterInstallOf(installed: Record<string, number>, joined: JoinedFaction[], factionRep: number, level: number) {
  return (purchase: RedPillPurchase) => {
    const after: Record<string, number> = {
      ...installed,
      "The Red Pill": 1,
      [NEUROFLUX_GOVERNOR]: (installed[NEUROFLUX_GOVERNOR] ?? 0) + purchase.levels,
    };
    for (const name of purchase.augmentations) after[name] = 1;
    const state = { installed: after, queued: [], sourceFile11Level: 0, bitNodeMultipliers: BN4 };
    const owned = (name: string) => Object.hasOwn(after, name);
    const reset = joined.map((faction) => ({ ...faction, reputation: 0 }));
    const shops = augmentationShops(reset, 4, state, owned, null);
    const wanted = shops.sold.filter((name) => !owned(name) && addsToLevelling([name]));
    const terms = donationTermsOf(reset, shops.shops, wanted, factionRep, BN4);
    const set = chooseAugmentationsToBuy([], state, Number.MAX_VALUE, level, terms);
    return {
      ladder: neuroFluxLadder({ state, set, neuroFluxReputation: 0, donations: terms }),
      augmentations: set.purchases.map((each) => each.name),
    };
  };
}

/** The Red Pill's offer as A6 builds it (#410), from a BN4 state. */
function redPillOfferOf({
  installed,
  joined,
  factionRep,
  level,
  money,
  redPillMoney,
  incomePerSecond,
  incomeError = null,
  batchingExp,
  batchingExpError = null,
  mults,
}: {
  installed: Record<string, number>;
  joined: JoinedFaction[];
  factionRep: number;
  level: number;
  money: number;
  redPillMoney: number;
  incomePerSecond: number | null;
  incomeError?: number | null;
  batchingExp: LevellingRate | null;
  batchingExpError?: number | null;
  mults: { m: number; he: number; hs: number };
}): RedPillInstallOffer {
  const { state, ladder, set, shops, terms } = ladderAt(joined, installed, factionRep, level);
  const budget = money - redPillMoney;
  const toBuy = shops.reached.filter((name) => name !== "The Red Pill" && addsToLevelling([name]));
  const nowSet = chooseAugmentationsToBuy(toBuy, state, budget, level, terms);
  const nowLadder = neuroFluxLadder({
    state,
    set: nowSet,
    neuroFluxReputation: shops.neuroFluxReputation,
    donations: terms,
  });
  return {
    money,
    redPillMoney,
    incomePerSecond,
    incomeError,
    batchingExp,
    batchingExpError,
    now: {
      levels: Math.max(
        0,
        nowLadder.findLastIndex((cost) => cost <= budget),
      ),
      augmentations: nowSet.purchases.map((each) => each.name),
    },
    ladder,
    augmentations: set,
    afterInstall: afterInstallOf(installed, joined, factionRep, level),
    ...levellingAfter({ ...mults, level }),
    batchingBoundSeconds: BN43_SO_FAR,
    required: REQUIRED,
    levelMult: mults.m,
  };
}

/** BN4.3 at 21:13:35 (evidence): The Red Pill by Daedalus's donation, its 2.5m counting for the rest. */
const BN43_RED_PILL = {
  installed: installedOf(53),
  joined: [
    { name: "Daedalus", reputation: 2_500_000, favor: 150.28 },
    { name: "BitRunners", reputation: 4_827, favor: 150.45 },
    { name: "The Black Hand", reputation: 4_974, favor: 132.2 },
    { name: "NiteSec", reputation: 4_851, favor: 123.7 },
  ],
  factionRep: 2.744,
  level: 3008,
  // The two donations the commit planned, the least the choice implies.
  money: 1.4634e12,
  redPillMoney: 1.2134e12,
  // The hacking money from 21:10:00 to 21:16:30 ($2.441e11 to $7.711e12); the experience 3.9248e8 to 7.5498e8.
  incomePerSecond: 1.91e10,
  batchingExp: { expPerSecond: (7.5498e8 - 3.9248e8) / 390, atLevel: 2938 },
  mults: { m: 6.6236, he: 8.7904, hs: 2.777 },
};

describe("D from m: the hindcast on BN4.1, BN4.2 and BN4.3 (#410)", () => {
  test("a rate's standard error: each interval's about the mean, over the effective count less one", () => {
    expect(rateStandardError([{ atMs: 0, value: 0 }])).toBeNull();
    expect(rateStandardError([0, 1, 2, 3].map((i) => ({ atMs: i * 1000, value: i * 5 })))).toBe(0);
    // Rates 1 and 3 a second, a second each: the mean 2, the variance 1, two intervals: the error 1.
    const two = [
      { atMs: 0, value: 0 },
      { atMs: 1000, value: 1 },
      { atMs: 2000, value: 4 },
    ];
    expect(rateStandardError(two)).toBeCloseTo(1, 9);
  });
  test("calculateSkill at the measured rates: BN4.2's 7.8 h against its 8 h 2 min; BN4.3's about 1,000 years", () => {
    // dphase: BN4.2's experience 2.827e12 at 20:00 (7,922) to 5.588e13 at 03:02 (8,976), 25,320 s at a mean level
    // about 8,500, m 11.042; from 0 at its Red Pill install (19:30) to 9,000 at 03:32: 8 h 2 min.
    const bn42 = secondsToHackingLevel(0, REQUIRED, 11.042, {
      expPerSecond: (5.588e13 - 2.827e12) / 25_320,
      atLevel: 8500,
    });
    expect(bn42 / HOUR).toBeCloseTo(7.8, 1);
    expect(bn42 / (8 * HOUR + 2 * 60)).toBeGreaterThan(1 / 2);
    // BN4.3's: 6.512e11 at 21:47 (4,905) to 1.66e13 at 06:48 (5,663), 32,460 s, about 5,400; m 7.317.
    const bn43 = secondsToHackingLevel(0, REQUIRED, 7.3167, {
      expPerSecond: (1.66e13 - 6.512e11) / 32_460,
      atLevel: 5400,
    });
    expect(bn43 / YEAR).toBeGreaterThan(1000);
    expect(bn43 / YEAR).toBeLessThan(1050);
    expect(bn43).toBeGreaterThan(BN43_SO_FAR);
  });

  test("D from m: levelling's least after the install; levelling mode alone ×1.08 of BN4.2's 8 h 2 min, BN4.3's hopeless", () => {
    // Levelling mode alone, as BN4.2 ran (no (d) then), at the formula's rate: m and hacking_exp from dphase (11.042,
    // 18.503), the speed from its installed list and SF1.3's ×1.28 (`SourceFile/applySourceFile.ts`) and NeuroFlux
    // Governor at 73, at The Red Pill's level (dphase: 7,922 at 20:00).
    const speed = BN42_INSTALLED.reduce(
      (product, name) =>
        product * ((AUGMENTATIONS[name]?.multipliers as Record<string, number> | undefined)?.hacking_speed ?? 1),
      1.28 * 1.01 ** 73,
    );
    const bn42Mode = dFromM({ m: 11.042, he: 18.503, hs: speed, level: 7922 });
    expect(bn42Mode / HOUR).toBeCloseTo(8.68, 2);
    expect(bn42Mode / (8 * HOUR + 2 * 60)).toBeCloseTo(1.08, 2);
    // BN4.3's at 21:25 (evidence: 7.3167, 9.7104, 3.3744; hacking 4,425): the readback's levelling mode said 9.0e6 h.
    expect(dFromM({ m: 7.3167, he: 9.7104, hs: 3.3744, level: 4425 }) / HOUR / 1e6).toBeCloseTo(8.57, 2);
    // Levelling's least (#410's ruling), (d) in each: NeuroFlux Governor alone after the install, every level's
    // reputation taken as reached (assumed, as core's levelling.test.ts's golden cases), at the income measured
    // before The Red Pill and batching's experience rate (BN4.2: $1.83e12/s, 684,373/s at 4,176 after its install;
    // BN4.1: $2.835e11/s, the online money pace, 2.65e6/s at 6,779). Both about an hour: (d), not levelling mode,
    // which BN4.2 ran (8 h 2 min), and the batching BN4.1 did by hand (6.8 h to $7e16, then 4.4 min).
    const nfOnly = (levels: number) => () => ({
      ladder: neuroFluxLadder({
        state: {
          installed: { [NEUROFLUX_GOVERNOR]: levels },
          queued: [],
          sourceFile11Level: 0,
          bitNodeMultipliers: BN4,
        },
        set: { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] },
        neuroFluxReputation: Number.POSITIVE_INFINITY,
      }),
      augmentations: [] as string[],
    });
    const base = (m: number, he: number, hs: number, level: number) => ({
      money: 0,
      redPillMoney: 0,
      now: { levels: 0, augmentations: [] },
      ladder: [],
      augmentations: [],
      ...levellingAfter({ m, he, hs, level }),
      batchingBoundSeconds: null,
      required: REQUIRED,
      levelMult: m,
    });
    const nothing = { levels: 0, augmentations: [] };
    const bn42 = redPillLevelling(
      {
        ...base(11.042, 18.503, speed, 7922),
        incomePerSecond: 1.83e12,
        batchingExp: { expPerSecond: 684_373, atLevel: 4176 },
        afterInstall: nfOnly(73),
      },
      nothing,
    );
    expect(bn42.candidate).toBe("batch");
    expect(bn42.seconds / HOUR).toBeCloseTo(1.02, 2);
    const bn41 = redPillLevelling(
      {
        ...base(11.377, 19.064, 4.465, 6779),
        incomePerSecond: 2.835e11,
        batchingExp: { expPerSecond: 2.65e6, atLevel: 6779 },
        afterInstall: nfOnly(76),
      },
      nothing,
    );
    expect(bn41.candidate).toBe("batch");
    expect(bn41.seconds / HOUR).toBeCloseTo(1.01, 2);
    // BN4.3 with what 5901be2's commit bought (the Analyze Engine and NeuroFlux Governor ×10): (d) after it, 8.3 h at
    // the income before the install, 21.4 h at the $4.97e8/s measured after it (the 21:21 replay's 20.7 h, and the
    // install's fixed 15 min, the root's 3.4 and the preparation).
    const offer = redPillOfferOf(BN43_RED_PILL);
    const bought = { levels: 10, augmentations: ["Embedded Netburner Module Analyze Engine"] };
    expect(redPillLevelling(offer, bought)).toMatchObject({ candidate: "batch" });
    expect(redPillLevelling(offer, bought).seconds / HOUR).toBeCloseTo(8.29, 2);
    expect(redPillLevelling(offer, bought, 4.97e8).seconds / HOUR).toBeCloseTo(21.37, 2);
    expect(redPillLevelling(offer, bought, 4.97e8).seconds).toBeGreaterThan(BN43_SO_FAR);
  });
  test("the destroy estimate (#360) takes D from m before levelling's choice, in place of the prior's constant", () => {
    const prior = {
      bitNode: "BN4.2",
      currentNode: 4,
      aMs: 10 * HOUR * 1000,
      bcMs: 5 * HOUR * 1000,
      redPillCycleMs: HOUR * 1000,
      dMs: 8 * HOUR * 1000,
      requiredLevel: REQUIRED,
    };
    const inputs = {
      currentNode: 4,
      ownedSF: {},
      onlineMs: 15 * HOUR * 1000,
      count: 30,
      redPillInstalled: false,
      countMetOnlineMs: 10 * HOUR * 1000,
      daedalus: "donations installed" as const,
      holdEtaMs: null,
      levellingMs: null,
      prior,
    };
    const d = (estimate: ReturnType<typeof destroyEstimate>) => estimate.terms.find((term) => term.term === "D");
    expect(d(destroyEstimate(inputs))).toMatchObject({ ms: 8 * HOUR * 1000, source: "the prior's (BN4.2)" });
    const fromM = 3.1e10 * 1000;
    const estimate = destroyEstimate({ ...inputs, levelFromMultipliersMs: fromM });
    expect(d(estimate)).toMatchObject({ ms: fromM, label: "either way", atLeast: false });
    expect(d(estimate)?.source).toMatch(/^D from m \(#410\): w0r1d_d43m0n's level 9,000 from 0 experience/);
    // After The Red Pill, levelling's choice is D's; before it, D from m with it said.
    expect(
      d(destroyEstimate({ ...inputs, redPillInstalled: true, levellingMs: 1000, levelFromMultipliersMs: fromM })),
    ).toMatchObject({ ms: 1000 });
    expect(d(destroyEstimate({ ...inputs, redPillInstalled: true, levelFromMultipliersMs: fromM }))?.source).toMatch(
      /, levelling not yet chosen$/,
    );
  });
});

describe("BN4.3's three moments through main's code (#410's replay)", () => {
  test("20:59, the Daedalus donations install with $1.1e16: reputation, not money, bounds NeuroFlux Governor", () => {
    // evidence 20:59: Daedalus 464,958 (favour 0), BitRunners 120,995 (favour 133.8): no donations anywhere (150,
    // `Faction/formulas/donation.ts:16-18`). NeuroFlux Governor's 54th needs 500 × 1.14^53 = 518,713
    // (`Augmentation/AugmentationHelpers.ts:133-139`): three levels (51-53) whatever the money, as 5901be2 bought, and
    // main buys the same. Neurolink needs 875,000 at BitRunners.
    const joined = [
      { name: "Daedalus", reputation: 464_958, favor: 0 },
      { name: "BitRunners", reputation: 120_995, favor: 133.8 },
    ];
    const installed = installedOf(50);
    const state = { installed, queued: [], sourceFile11Level: 0, bitNodeMultipliers: BN4 };
    const owned = (name: string) => Object.hasOwn(installed, name);
    const shops = augmentationShops(joined, 4, state, owned, null);
    const terms = donationTermsOf(joined, shops.shops, [], 2.663, BN4);
    expect(terms.neuroFluxSellers).toEqual([]);
    expect(shops.reached).not.toContain("BitRunners Neurolink");
    const set = { purchases: [], money: 0, donations: [], donationMoney: 0, byDonation: [] };
    const counts = affordableCounts({
      state,
      set,
      money: 1.105e16,
      neuroFluxReputation: shops.neuroFluxReputation,
      donations: terms,
    });
    expect(counts.neuroFluxLevels).toBe(3);
    expect(counts.money / 1e9).toBeCloseTo(4.13, 2);
  });

  test("21:13, The Red Pill's install: main installs at once; #410 batches 38 min for the set and ×11 first, 5.2 h against 15.1 h", () => {
    // evidence 21:13:35: The Red Pill by Daedalus's donation ($1.213e12 for 2.5m), installed at once, as on main (its
    // endgame `redPill`: no D weighed). The levelling set by donation at BitRunners (favour 150.4) and Daedalus (150.3, at
    // 2.5m after The Red Pill's donation): Core V2, Core V3, the Analyze Engine and Neurolink, $5.54e11 with their
    // donations.
    const offer = redPillOfferOf(BN43_RED_PILL);
    expect(offer.augmentations).toEqual([
      "Embedded Netburner Module Core V2 Upgrade",
      "Embedded Netburner Module Core V3 Upgrade",
      "Embedded Netburner Module Analyze Engine",
      "BitRunners Neurolink",
    ]);
    expect((offer.ladder[0] as number) / 1e11).toBeCloseTo(5.54, 2);
    // Now: the $2.5e11 after the donation buys the Analyze Engine and NeuroFlux Governor ×6; after the install
    // levelling's least is (d), re-buying the rest of the set by donation from reputation 0: 15.1 h.
    expect(offer.now).toEqual({ levels: 6, augmentations: ["Embedded Netburner Module Analyze Engine"] });
    const timing = redPillInstallTiming(offer);
    expect(timing.now.candidate).toBe("batch");
    expect(timing.now.seconds / HOUR).toBeCloseTo(15.13, 2);
    // The wait: 37.6 min at $1.91e10/s to $4.34e13 for the whole set and ×11, at The Red Pill's 2.5m at Daedalus, then
    // (d) after it: 5.2 h in all. No error measured (two readings in the evidence), so the margin is 0: the wait.
    expect(timing.wait).toMatchObject({ candidate: "batch", levels: 11 });
    expect((timing.wait?.batchingSeconds as number) / 60).toBeCloseTo(37.6, 1);
    expect((timing.wait?.money as number) / 1e13).toBeCloseTo(4.34, 2);
    expect((timing.wait?.seconds as number) / HOUR).toBeCloseTo(5.23, 2);
    expect(timing.marginSeconds).toBe(0);
    expect(timing.choice).toBe("wait");
    // At the income measured after the install ($4.97e8/s), the wait still: 2.5 h of batching, 20.9 h against 40.1 h.
    const slow = redPillInstallTiming({ ...offer, incomePerSecond: 4.97e8 });
    expect(slow.choice).toBe("wait");
    expect((slow.wait?.seconds as number) < slow.now.seconds).toBe(true);
  });
  test("21:21, levelling's choice: main's (d) batches 5.9 h to the set and ×8, 20.7 h in all, not levelling mode's 8.6e6 h", () => {
    // 5901be2 chose levelling mode (evidence: money 1.85e13 s, levelling mode 3.31e10 s; (d) not in it) and stayed 9 h
    // 40 min with the income stopped. Main's (d) (#380), at 21:25's snapshot (4 min after the choice: hacking 4,425,
    // $2.384e11, the income $4.97e8/s, the hacking money since the 21:17 install) and A6's set by donation at
    // Daedalus (favour 241.6) and BitRunners (186.9): Neurolink, Core V2 and V3, then NeuroFlux Governor from 64.
    const { set, ladder } = ladderAt(
      [
        { name: "Daedalus", reputation: 2_933, favor: 241.6 },
        { name: "BitRunners", reputation: 2_933, favor: 186.9 },
        { name: "The Black Hand", reputation: 2_458, favor: 133 },
        { name: "NiteSec", reputation: 2_721, favor: 124.7 },
      ],
      installedOf(63, RED_PILL_PURCHASES),
      3.031,
      4425,
    );
    expect(set).toEqual(BN43_MISSING.toSorted((a, b) => set.indexOf(a) - set.indexOf(b)));
    expect(set).toHaveLength(3);
    const after = offerAt({ m: 7.3167, he: 9.7104, hs: 3.3744, level: 4425 });
    const inputs = {
      exp: 8.3678e10,
      level: 4425,
      required: REQUIRED,
      levelMult: 7.3167,
      money: { expPerSecond: 448_253, atLevel: 2803 },
      levelling: {
        predicted: { expPerSecond: after.perThread.expPerSecond * HOME_THREADS, atLevel: 4425 },
        factor: null,
      },
      install: null,
      batch: {
        money: 2.384e11,
        incomePerSecond: 4.97e8,
        ladder,
        augmentations: set,
        ...after,
        batchingBoundSeconds: BN43_SO_FAR + 5 * 60,
      },
    };
    const estimates = levellingEstimates(inputs);
    // The money's estimate as the event had it (1.85e13 s), levelling mode's within 7% (home's RAM alone here).
    expect((estimates.money as number) / 1.85e13).toBeCloseTo(1, 2);
    expect((estimates.level as number) / 3.31e10).toBeGreaterThan(0.9);
    const plan = batchThenInstallPlan(inputs);
    expect(plan?.levels).toBe(8);
    expect((plan?.batchingSeconds as number) / HOUR).toBeCloseTo(5.9, 1);
    expect((estimates.batch as number) / HOUR).toBeCloseTo(20.7, 1);
    expect(chooseLevelling(estimates, "money")).toBe("batch");
    // Past the 17 h 49 min so far: the run report's hopeless check, and the brain's alert after its 10 minutes (#410).
    expect((estimates.batch as number) > BN43_SO_FAR + 5 * 60).toBe(true);
  });
});

describe("The Red Pill's install timed (#410): #406's margin, the measured error of the difference", () => {
  const offer = redPillOfferOf(BN43_RED_PILL);

  test("now only where it beats the wait by more than the error; the error from the rates' standard errors", () => {
    // The money for the whole set and ×11 in hand, $1e8/s: the next level is $4.3e13 more, days of batching: the
    // install now wins, with no error measured (no bound on the batching here, so the wait is weighed).
    const slow = {
      ...offer,
      money: offer.redPillMoney + 4.34e13 + 1e9,
      incomePerSecond: 1e8,
      batchingBoundSeconds: null,
    };
    const timing = redPillInstallTiming(slow);
    expect(timing.choice).toBe("now");
    const lead = (timing.wait?.seconds as number) - timing.now.seconds;
    expect(lead).toBeGreaterThan(0);
    expect(timing.marginSeconds).toBe(0);
    expect(timing.why).toMatch(/beats the wait by more than their difference's measured error/);
    // The income's error moves the difference: past the lead, the wait (a tie waits).
    const noisy = redPillInstallTiming({ ...slow, incomeError: 1e10 });
    expect(noisy.marginSeconds).toBeGreaterThan(lead);
    expect(noisy.choice).toBe("wait");
    // The experience rate's error adds in quadrature with the income's.
    const both = redPillInstallTiming({ ...slow, incomeError: 1e10, batchingExpError: 1e6 });
    expect(both.marginSeconds).toBeGreaterThanOrEqual(noisy.marginSeconds);
    // A small error, under the lead: still now.
    const quiet = redPillInstallTiming({ ...slow, incomeError: 1e3 });
    expect(quiet.marginSeconds).toBeGreaterThan(0);
    expect(quiet.marginSeconds).toBeLessThan(lead);
    expect(quiet.choice).toBe("now");
  });

  test("now with no wait: no income measured, or none within the bound; The Red Pill's donation off the money first", () => {
    expect(redPillInstallTiming({ ...offer, incomePerSecond: null })).toMatchObject({
      choice: "now",
      wait: null,
      why: "no income measured to batch with",
    });
    expect(redPillInstallTiming({ ...offer, batchingBoundSeconds: 1 }).why).toMatch(/within the BitNode's time so far/);
    // The wait's batching from the money after the donation.
    const timing = redPillInstallTiming(offer);
    expect(timing.wait?.batchingSeconds).toBeCloseTo(
      ((timing.wait?.money as number) - (offer.money - offer.redPillMoney)) / (offer.incomePerSecond as number),
      6,
    );
  });
});
