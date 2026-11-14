// D from m (#410): the time after The Red Pill's install to w0r1d_d43m0n's level at the multipliers it leaves, its
// hindcast on BN4.1, BN4.2 and BN4.3 (the readback's `dphase.txt`: the level and experience every 30 min of each BN4
// endgame), BN4.3's three moments replayed through main's code (`evidence.txt`), and The Red Pill's install timed: now,
// or first batching to the levelling set (#406's margin rule, decision 68's ×2).
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
  ESTIMATE_ERROR_FACTOR,
  hopelessEstimate,
  LEVELLING_INSTALL_MS,
  LEVELLING_REROOT_MS,
  levelLoopThreads,
  levellingEstimates,
  levellingExpPerThreadSecond,
  levellingInstallMultipliers,
  levellingPreparationMs,
  levellingSecondsAfterInstall,
  redPillInstallTiming,
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

describe("D from m: the hindcast on BN4.1, BN4.2 and BN4.3 (#410)", () => {
  test("hopeless: past the BitNode's time so far, or never; unread, not", () => {
    expect(hopelessEstimate(10, 9)).toBe(true);
    expect(hopelessEstimate(9, 9)).toBe(false);
    expect(hopelessEstimate(Number.POSITIVE_INFINITY, null)).toBe(true);
    expect(hopelessEstimate(1e30, null)).toBe(false);
    expect(hopelessEstimate(null, 1)).toBe(false);
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
    expect(hopelessEstimate(bn43, BN43_SO_FAR)).toBe(true);
  });

  test("D from m, the formula's rate before The Red Pill: BN4.2 ×1.08 of its 8 h 2 min; BN4.3 hopeless; BN4.1's", () => {
    // BN4.2: m and hacking_exp from dphase (11.042, 18.503), the speed from its installed list and SF1.3's ×1.28
    // (`SourceFile/applySourceFile.ts`) and NeuroFlux Governor at 73, at The Red Pill's level (dphase: 7,922 at 20:00).
    const speed = BN42_INSTALLED.reduce(
      (product, name) =>
        product * ((AUGMENTATIONS[name]?.multipliers as Record<string, number> | undefined)?.hacking_speed ?? 1),
      1.28 * 1.01 ** 73,
    );
    const bn42 = dFromM({ m: 11.042, he: 18.503, hs: speed, level: 7922 });
    expect(bn42 / HOUR).toBeCloseTo(8.68, 2);
    // Within decision 68's ×2 of the measured 8 h 2 min (the install's 15 min, the root's 3.4 and its preparation in).
    expect(bn42 / (8 * HOUR + 2 * 60)).toBeLessThan(ESTIMATE_ERROR_FACTOR);
    expect(bn42 / (8 * HOUR + 2 * 60)).toBeCloseTo(1.08, 2);
    // BN4.3: the multipliers at 21:25 (evidence: 7.3167, 9.7104, 3.3744), its level then 4,425: the readback's
    // levelling mode said 9.0e6 h; D from m 8.6e6 h, hopeless against the 17 h 44 min so far.
    const bn43 = dFromM({ m: 7.3167, he: 9.7104, hs: 3.3744, level: 4425 });
    expect(bn43 / HOUR / 1e6).toBeCloseTo(8.57, 2);
    expect(hopelessEstimate(bn43, BN43_SO_FAR)).toBe(true);
    // BN4.1 (core's levelling.test.ts fixture: hacking_exp 19.06, the speed 4.465 assumed): at its Red Pill install, m
    // 11.38, 4.0 h, against 7 h (419 min) measured at the money pace, before levelling (#336) chose levelling mode, so
    // an upper bound; after its NeuroFlux Governor ×20 install, m 13.88, 22.5 min against the 4.4 min measured from
    // the install's send to the destroy: the install's own cautious 15 min and the root's 3.4 are most of it.
    const bn41AtRedPill = dFromM({ m: 11.377, he: 19.064, hs: 4.465, level: 6779 });
    expect(bn41AtRedPill / HOUR).toBeCloseTo(4.05, 2);
    const bn41AfterLevels = dFromM({ m: 13.883, he: 19.064 * 1.01 ** 20, hs: 4.465 * 1.01 ** 20, level: 6779 });
    expect(bn41AfterLevels / 60).toBeCloseTo(22.5, 1);
    expect(bn41AfterLevels - (LEVELLING_INSTALL_MS + LEVELLING_REROOT_MS) / 1000).toBeLessThan(4.5 * 60);
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

  test("21:13, The Red Pill's install: main installs at once; #410 batches first for the set, D 8.6e6 h against 34 h", () => {
    // evidence 21:13:35: The Red Pill by Daedalus's donation ($1.213e12 for 2.5m), installed at once, as on main (its
    // endgame `redPill`: no D weighed). Its commit bought the DMA Upgrade, the Analyze Engine and NeuroFlux Governor
    // 54-63: m 6.6236 → 7.3167. The levelling set by donation at BitRunners (favour 150.4) and Daedalus (150.3, at 2.5m
    // after The Red Pill's donation): Core V2, Core V3, the Analyze Engine and Neurolink, $5.54e11 with their donations.
    const { set, ladder } = ladderAt(
      [
        { name: "Daedalus", reputation: 2_500_000, favor: 150.28 },
        { name: "BitRunners", reputation: 4_827, favor: 150.45 },
        { name: "The Black Hand", reputation: 4_974, favor: 132.2 },
        { name: "NiteSec", reputation: 4_851, favor: 123.7 },
      ],
      installedOf(53),
      2.744,
      3008,
    );
    expect(set).toEqual([
      "Embedded Netburner Module Core V2 Upgrade",
      "Embedded Netburner Module Core V3 Upgrade",
      "Embedded Netburner Module Analyze Engine",
      "BitRunners Neurolink",
    ]);
    expect((ladder[0] as number) / 1e11).toBeCloseTo(5.54, 2);
    const before = offerAt({ m: 6.6236, he: 8.7904, hs: 2.777, level: 3008 });
    // The money: the two donations the commit planned ($1.4634e12, the least the choice implies); the income the
    // evidence's hacking money from 21:10:00 to 21:16:30 ($2.441e11 to $7.711e12: $1.91e10/s).
    const offer = {
      money: 1.4634e12,
      redPillMoney: 1.2134e12,
      incomePerSecond: 1.91e10,
      now: { levels: 10, augmentations: ["Embedded Netburner Module Analyze Engine"] },
      ladder,
      augmentations: set,
      ...before,
      batchingBoundSeconds: BN43_SO_FAR,
      required: REQUIRED,
      levelMult: 6.6236,
    };
    const timing = redPillInstallTiming(offer);
    // Now: what 5901be2 installed, m 7.3167: hopeless.
    expect(timing.nowSeconds / HOUR / 1e6).toBeCloseTo(8.57, 2);
    expect(timing.choice).toBe("wait");
    expect(timing.plan?.levels).toBe(15);
    expect((timing.plan?.batchingSeconds as number) / HOUR).toBeCloseTo(13.7, 1);
    expect((timing.plan?.seconds as number) / HOUR).toBeCloseTo(47.7, 1);
    // The multiplier after it: the set's ×1.366 and NeuroFlux Governor ×15's.
    const gain = levellingInstallMultipliers(15, set);
    expect(6.6236 * gain.hacking).toBeCloseTo(10.5, 1);
    // At a tenth of the income, still the set first (fewer levels).
    expect(redPillInstallTiming({ ...offer, incomePerSecond: 1e9 }).choice).toBe("wait");
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
    // Past the 17 h 49 min so far, so hopeless by the bar too: the alert (#410), the income kept meanwhile.
    expect(hopelessEstimate(estimates.batch, BN43_SO_FAR + 5 * 60)).toBe(true);
  });
});

describe("The Red Pill's install timed (#410): #406's margin rule", () => {
  const offer = {
    money: 0,
    redPillMoney: 0,
    incomePerSecond: 1e9,
    now: { levels: 0, augmentations: [] as string[] },
    ladder: [0, 1e12],
    augmentations: [] as string[],
    ...offerAt({ m: 11, he: 18.5, hs: 3.6, level: 8000 }),
    batchingBoundSeconds: null,
    required: REQUIRED,
    levelMult: 11,
  };
  test("wait only where the batching is at most ×2 D's saving; a tie waits; past it, now", () => {
    const timing = redPillInstallTiming(offer);
    const plan = timing.plan as NonNullable<typeof timing.plan>;
    const saving = timing.nowSeconds - (plan.seconds - plan.batchingSeconds);
    expect(saving).toBeGreaterThan(0);
    expect(plan.batchingSeconds).toBeLessThanOrEqual(ESTIMATE_ERROR_FACTOR * saving);
    expect(timing.choice).toBe("wait");
    // The income that makes the batching exactly ×2 the saving: a tie, waiting; a hair slower, now.
    const tie = (plan.money - offer.money) / (ESTIMATE_ERROR_FACTOR * saving);
    expect(redPillInstallTiming({ ...offer, incomePerSecond: tie }).choice).toBe("wait");
    const slower = redPillInstallTiming({ ...offer, incomePerSecond: tie * 0.999 });
    expect(slower.choice).toBe("now");
    expect(slower.why).toMatch(/costs more than ×2 D's saving/);
  });

  test("now with no plan: no income measured, or none within the bound; the money in hand counts as now's", () => {
    expect(redPillInstallTiming({ ...offer, incomePerSecond: null })).toMatchObject({
      choice: "now",
      plan: null,
      why: "no income measured to batch with",
    });
    expect(redPillInstallTiming({ ...offer, batchingBoundSeconds: 1 }).why).toMatch(/within the BitNode's time so far/);
    // The Red Pill's donation comes off the money first: $2e12 in hand, $1.5e12 of it the donation, batches $5e11.
    const withDonation = redPillInstallTiming({ ...offer, money: 2e12, redPillMoney: 1.5e12 });
    expect(withDonation.plan?.batchingSeconds).toBeCloseTo(5e11 / 1e9, 6);
    // $1e12 beyond the donation buys the ladder's last now: no plan.
    expect(redPillInstallTiming({ ...offer, money: 2.5e12, redPillMoney: 1.5e12 }).plan).toBeNull();
  });
});
