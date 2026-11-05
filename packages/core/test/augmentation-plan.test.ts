// Augmentations and the reset (#210): which the brain buys, in what order, and when it installs them (the legacy
// scripts' count rule, #222). Worked by hand from the game's data (`Augmentation/Augmentations.ts`) and formulas
// (`skill.ts`, `getAugCost`), and from autopilot.js's constants.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  affordableCounts,
  augmentationBuyOrder,
  chooseAugmentationsToBuy,
  countablesWithinReach,
  countdownExtensionMs,
  daedalusCountOf,
  hackingExpForLevel,
  INSTALL_AT_AUGMENTATIONS,
  INSTALL_AT_AUGMENTATIONS_WITH_NEUROFLUX,
  INSTALL_BAR_FALL_PER_HOUR,
  INSTALL_COUNTDOWN_LEAST_EXTENSION_MS,
  INSTALL_COUNTDOWN_MS,
  type InstallRuleInputs,
  installBars,
  installGains,
  installRule,
  isWorthInstalling,
  QUICK_INSTALL_AT_AUGMENTATIONS,
  QUICK_INSTALL_COUNTDOWN_MS,
  QUICK_INSTALL_WITHIN_MS,
} from "../src/augmentation-plan.ts";
import {
  AUGMENTATION_NAMES,
  type AugmentationPurchaseState,
  NEUROFLUX_GOVERNOR,
  purchaseSequenceCost,
} from "../src/augmentations.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

const BN1: AugmentationPurchaseState = {
  installed: {},
  queued: [],
  sourceFile11Level: 0,
  bitNodeMultipliers: { AugmentationMoneyCost: 1, AugmentationRepCost: 1 },
};
const GEN_I = "Cranial Signal Processors - Gen I";
const GEN_II = "Cranial Signal Processors - Gen II";
const BITWIRE = "BitWire";
const SYNAPTIC = "Synaptic Enhancement Implant";
const NEUROTRAINER = "Neurotrainer I";
/** CyberSec's five worth installing (its shop, `Faction/Factions.ts:14-21`, less NeuroFlux Governor). */
const CYBERSEC = [NEUROTRAINER, SYNAPTIC, BITWIRE, GEN_I, GEN_II];
/** The hacking level the values are at (A5's `hackingValue` weighs the hacking skill multiplier by it). */
const LEVEL = 300;

describe("which augmentations", () => {
  test("worth installing: a hacking value, not NeuroFlux Governor", () => {
    expect(CYBERSEC.every((name) => isWorthInstalling(name))).toBe(true);
    expect(isWorthInstalling("Artificial Synaptic Potentiation")).toBe(true); // hacking chance, speed and exp only
    expect(isWorthInstalling("Social Negotiation Assistant (S.N.A)")).toBe(true); // faction_rep alone
    expect(isWorthInstalling("NeuroFlux Governor")).toBe(false);
    expect(isWorthInstalling("Combat Rib I")).toBe(false);
    expect(isWorthInstalling("Speech Processor Implant")).toBe(false);
    expect(isWorthInstalling("The Red Pill")).toBe(false);
    expect(isWorthInstalling("Unstable Circadian Modulator")).toBe(false); // drawn at random
    expect(() => isWorthInstalling("Nothing")).toThrow(RangeError);
  });

  test("short of Daedalus's count (#228): any augmentation but NeuroFlux Governor and The Red Pill", () => {
    for (const name of [...CYBERSEC, "Combat Rib I", "Speech Processor Implant", "Neural Wit Amplifier"]) {
      expect(isWorthInstalling(name, true)).toBe(true);
    }
    expect(isWorthInstalling("Neural Wit Amplifier")).toBe(false);
    expect(isWorthInstalling("NeuroFlux Governor", true)).toBe(false);
    expect(isWorthInstalling("The Red Pill", true)).toBe(false);
    expect(() => isWorthInstalling("Nothing", true)).toThrow(RangeError);
  });

  test("short of Daedalus's count (#228): under the BitNode's, NeuroFlux Governor once, until it invites", () => {
    /**
     * `count` installed: NeuroFlux Governor at 124 levels (one, `Faction/FactionJoinCondition.ts:130`), then others.
     */
    const installed = (count: number) =>
      Object.fromEntries([
        ["NeuroFlux Governor", 124],
        ...AUGMENTATION_NAMES.filter((name) => name !== "NeuroFlux Governor")
          .slice(0, count - 1)
          .map((name) => [name, 1]),
      ]);
    const base = { currentNode: 1, ownedSF: {}, joined: [{ name: "CyberSec" }], invitations: [] };
    expect(daedalusCountOf({ ...base, installed: installed(29) })).toEqual({
      installed: 29,
      required: 30,
      short: true,
    });
    expect(daedalusCountOf({ ...base, installed: installed(30) })).toEqual({
      installed: 30,
      required: 30,
      short: false,
    });
    expect(daedalusCountOf({ ...base, installed: {} })).toEqual({ installed: 0, required: 30, short: true });
    // Joined or invited, it isn't: the count is met.
    expect(daedalusCountOf({ ...base, installed: installed(29), joined: [{ name: "Daedalus" }] }).short).toBe(false);
    expect(daedalusCountOf({ ...base, installed: installed(29), invitations: ["Daedalus"] }).short).toBe(false);
    // The BitNode's requirement: BN15's 20.
    expect(daedalusCountOf({ ...base, currentNode: 15, installed: installed(20) }).short).toBe(false);
  });

  test("the gains: each multiplier's product, NeuroFlux Governor once per copy", () => {
    expect(installGains(CYBERSEC)).toEqual({
      hacking: 1.05 * 1.05 * 1.07,
      hacking_speed: 1.03 * 1.01 * 1.02,
      hacking_money: 1,
      hacking_grow: 1,
      hacking_chance: 1.05,
      hacking_exp: 1.1,
      faction_rep: 1,
    });
    const nfg = 1.01000262;
    expect(installGains(["NeuroFlux Governor", "NeuroFlux Governor"]).faction_rep).toBe(nfg * nfg);
    expect(installGains([])).toEqual(installGains(["Combat Rib I"]));
  });
});

describe("the buy order", () => {
  test("the dearest first, a prerequisite before what needs it: CyberSec's five", () => {
    expect(augmentationBuyOrder(CYBERSEC)).toEqual([GEN_I, GEN_II, BITWIRE, SYNAPTIC, NEUROTRAINER]);
  });

  test("a chain goes by its dearest member, in its order; one outside the list is taken as owned", () => {
    const gens = ["Cranial Signal Processors - Gen V", "Cranial Signal Processors - Gen III", GEN_II, GEN_I];
    const order = [
      GEN_I, // $70m, but it heads Gen V's chain ($2.25b)
      GEN_II,
      "Cranial Signal Processors - Gen III",
      "Cranial Signal Processors - Gen IV",
      "Cranial Signal Processors - Gen V",
      "DataJack", // $450m
    ];
    expect(augmentationBuyOrder([...gens, "Cranial Signal Processors - Gen IV", "DataJack"])).toEqual(order);
    // $50.3b, where DataJack first ($450m, dearer than Gen I alone) would cost $74.8b.
    const withDataJackFirst = ["DataJack", ...order.slice(0, 5)];
    expect(purchaseSequenceCost(order, BN1).money).toBeLessThan(purchaseSequenceCost(withDataJackFirst, BN1).money);
    expect(augmentationBuyOrder([GEN_II, BITWIRE])).toEqual([GEN_II, BITWIRE]);
  });

  test("of chains as dear, the dearer augmentation first: CashRoot Starter Kit ($125m) before Gen I ($70m, Gen II's)", () => {
    // Both head a $125m chain; CashRoot first costs $709m, Gen I first (the game's order) $758.75m.
    expect(augmentationBuyOrder([GEN_I, GEN_II, "CashRoot Starter Kit"])).toEqual([
      "CashRoot Starter Kit",
      GEN_I,
      GEN_II,
    ]);
  });

  test("ties go to the game's order; a name listed twice is bought once", () => {
    // Both $250m.
    expect(augmentationBuyOrder(["Embedded Netburner Module", "Neural-Retention Enhancement"])).toEqual([
      "Neural-Retention Enhancement",
      "Embedded Netburner Module",
    ]);
    expect(augmentationBuyOrder([BITWIRE, BITWIRE])).toEqual([BITWIRE]);
  });

  test("a cheap prerequisite of a dear one first: ENM, its Core Implant, Gen IV ($8.97b, not $10.6b)", () => {
    const owned = { ...BN1, installed: { [GEN_I]: 1, [GEN_II]: 1, "Cranial Signal Processors - Gen III": 1 } };
    const set = [
      "Cranial Signal Processors - Gen IV",
      "Embedded Netburner Module Core Implant",
      "Embedded Netburner Module",
    ];
    const order = augmentationBuyOrder(set);
    expect(order).toEqual([
      "Embedded Netburner Module",
      "Embedded Netburner Module Core Implant",
      "Cranial Signal Processors - Gen IV",
    ]);
    expect(purchaseSequenceCost(order, owned).money).toBeCloseTo(250e6 + 2.5e9 * 1.9 + 1.1e9 * 1.9 ** 2, 0);
    // Dearest ready first: Gen IV, then ENM, then its Core Implant, $10.6b.
    const dearestReady = [
      "Cranial Signal Processors - Gen IV",
      "Embedded Netburner Module",
      "Embedded Netburner Module Core Implant",
    ];
    expect(purchaseSequenceCost(dearestReady, owned).money).toBeCloseTo(1.1e9 + 250e6 * 1.9 + 2.5e9 * 1.9 ** 2, 0);
  });

  test("the buy order costs less than rising prices: CyberSec's five", () => {
    const inOrder = purchaseSequenceCost(augmentationBuyOrder(CYBERSEC), BN1).money;
    const rising = purchaseSequenceCost([NEUROTRAINER, SYNAPTIC, BITWIRE, GEN_I, GEN_II], BN1).money;
    expect(inOrder).toBeLessThan(rising);
  });
});

describe("the set to buy", () => {
  // In buy order (Gen I, Gen II, BitWire, Synaptic, Neurotrainer I): 70m + 125m × 1.9 + 10m × 1.9² + 7.5m × 1.9³ +
  // 4m × 1.9⁴.
  const ALL_FIVE = 70e6 + 125e6 * 1.9 + 10e6 * 1.9 ** 2 + 7.5e6 * 1.9 ** 3 + 4e6 * 1.9 ** 4;

  test("money for all of them: all five, in buy order, at the game's prices", () => {
    const set = chooseAugmentationsToBuy(CYBERSEC, BN1, ALL_FIVE, LEVEL);
    expect(set.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II, BITWIRE, SYNAPTIC, NEUROTRAINER]);
    expect(set.money).toBeCloseTo(447_170_900, 0);
    expect(set.purchases[1]).toEqual({ name: GEN_II, money: 125e6 * 1.9, reputation: 18_750 });
  });

  test("short of it: the most hacking value, greedily, each kept only if the whole set's money is covered", () => {
    // By value at level 300: Gen II (with Gen I, $307.5m), Gen I, BitWire, Neurotrainer I, then Synaptic, which
    // takes it past.
    const fourHundred = chooseAugmentationsToBuy(CYBERSEC, BN1, 400e6, LEVEL);
    expect(fourHundred.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II, BITWIRE, NEUROTRAINER]);
    expect(fourHundred.money).toBeCloseTo(70e6 + 125e6 * 1.9 + 10e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3, 0);
    // Under Gen II's $307.5m: Neurotrainer I, Gen I, BitWire and Synaptic, $143.5m.
    const threeHundred = chooseAugmentationsToBuy(CYBERSEC, BN1, 300e6, LEVEL);
    expect(threeHundred.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, BITWIRE, SYNAPTIC, NEUROTRAINER]);
    expect(threeHundred.money).toBeCloseTo(143_511_000, 0);
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 3_999_999, LEVEL)).toEqual({
      purchases: [],
      money: 0,
      donations: [],
      donationMoney: 0,
      byDonation: [],
    });
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 4e6, LEVEL).purchases.map((purchase) => purchase.name)).toEqual([
      NEUROTRAINER,
    ]);
  });

  test("the level weighs the skill multipliers: at 300, Gen I and BitWire; at 1, Neurotrainer I first", () => {
    // $90m. At level 300, Gen II (with Gen I) is past it; Gen I ($70m) and BitWire ($19m) fit, Neurotrainer I doesn't.
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 90e6, 300).purchases.map((each) => each.name)).toEqual([
      GEN_I,
      BITWIRE,
    ]);
    // At level 1, Neurotrainer I, then Synaptic, then BitWire: Gen I with them is past it.
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 90e6, 1).purchases.map((each) => each.name)).toEqual([
      BITWIRE,
      SYNAPTIC,
      NEUROTRAINER,
    ]);
  });

  test("a prerequisite not reached keeps out what needs it; one installed or queued doesn't", () => {
    expect(chooseAugmentationsToBuy([GEN_II], BN1, 1e12, LEVEL).purchases).toEqual([]);
    const installed = { ...BN1, installed: { [GEN_I]: 1 } };
    expect(chooseAugmentationsToBuy([GEN_II], installed, 1e12, LEVEL).purchases).toEqual([
      { name: GEN_II, money: 125e6, reputation: 18_750 },
    ]);
    // Queued: Gen II at 1.9 × its price.
    const queued = { ...BN1, queued: [GEN_I] };
    expect(chooseAugmentationsToBuy([GEN_I, GEN_II], queued, 1e12, LEVEL).purchases).toEqual([
      { name: GEN_II, money: 125e6 * 1.9, reputation: 18_750 },
    ]);
  });

  test("a prerequisite reached but not worth installing goes in with what needs it", () => {
    // Graphene Bionic Spine Upgrade needs Bionic Spine (combat both): neither is worth installing.
    expect(
      chooseAugmentationsToBuy(["Bionic Spine", "Graphene Bionic Spine Upgrade"], BN1, 1e15, LEVEL).purchases,
    ).toEqual([]);
    // Gen II's prerequisite is worth it anyway; the rule is the bundle's, whatever its worth.
    expect(chooseAugmentationsToBuy([GEN_I, GEN_II], BN1, 1e12, LEVEL).purchases.map((each) => each.name)).toEqual([
      GEN_I,
      GEN_II,
    ]);
  });

  test("not worth installing, owned or unknown: left out, or refused", () => {
    expect(chooseAugmentationsToBuy(["Combat Rib I", "NeuroFlux Governor"], BN1, 1e12, LEVEL).purchases).toEqual([]);
    expect(chooseAugmentationsToBuy([BITWIRE], { ...BN1, installed: { [BITWIRE]: 1 } }, 1e12, LEVEL).purchases).toEqual(
      [],
    );
    expect(chooseAugmentationsToBuy([BITWIRE], { ...BN1, queued: [BITWIRE] }, 1e12, LEVEL).purchases).toEqual([]);
    expect(() => chooseAugmentationsToBuy(["Nothing"], BN1, 1e12, LEVEL)).toThrow(RangeError);
  });

  describe("short of Daedalus's count (#228)", () => {
    /** Tian Di Hui's no-value three, and Neural Wit Amplifier: $2.5m, $12.5m, $50m and $10m. */
    const WIRED = "Wired Reflexes";
    const SPEECH = "Speech Enhancement";
    const PROCESSOR = "Speech Processor Implant";
    const WIT = "Neural Wit Amplifier";
    const SNA = "Social Negotiation Assistant (S.N.A)"; // faction_rep: a hacking value, $30m

    test("no-value augmentations are chosen too; not short, they aren't", () => {
      const reached = [WIRED, SPEECH, PROCESSOR, WIT];
      expect(chooseAugmentationsToBuy(reached, BN1, 1e12, LEVEL).purchases).toEqual([]);
      const set = chooseAugmentationsToBuy(reached, BN1, 1e12, LEVEL, undefined, true);
      expect(set.purchases.map((each) => each.name).sort()).toEqual([...reached].sort());
      // NeuroFlux Governor and The Red Pill stay out, short or not.
      expect(
        chooseAugmentationsToBuy(["NeuroFlux Governor", "The Red Pill"], BN1, 1e12, LEVEL, undefined, true).purchases,
      ).toEqual([]);
    });

    test("money for some: hacking value first, then the cheapest", () => {
      // S.N.A has a value: first, whatever its price. Then by price: Wired Reflexes, Neural Wit Amplifier, Speech
      // Enhancement, and the Speech Processor Implant ($50m) past the money. In buy order (dearest first).
      const four = 30e6 + 12.5e6 * 1.9 + 10e6 * 1.9 ** 2 + 2.5e6 * 1.9 ** 3;
      const set = chooseAugmentationsToBuy([PROCESSOR, SPEECH, WIT, WIRED, SNA], BN1, four, LEVEL, undefined, true);
      expect(set.purchases.map((each) => each.name)).toEqual([SNA, SPEECH, WIT, WIRED]);
      expect(set.money).toBeCloseTo(four, 0);
      // $30m: Wired Reflexes, then Neural Wit ($10m + $2.5m × 1.9); Speech Enhancement with them is $40.5m, past it.
      const cheap = chooseAugmentationsToBuy([PROCESSOR, SPEECH, WIT, WIRED], BN1, 30e6, LEVEL, undefined, true);
      // (The dearest first would buy Speech Enhancement and Wired Reflexes.)
      expect(cheap.purchases.map((each) => each.name)).toEqual([WIT, WIRED]);
    });
  });
});

describe("donations (#225): what a donation brings within reach", () => {
  // $1m a reputation: faction_rep 1, FactionWorkRepGain 1. CyberSec at 5,000 and NiteSec at 12,000, both unlocked.
  const SELLERS = {
    CyberSec: { faction: "CyberSec", reputation: 5_000 },
    NiteSec: { faction: "NiteSec", reputation: 12_000 },
  };
  const terms = (
    sellers: Record<string, { faction: string; reputation: number }[]>,
    neuroFluxSellers = [] as (typeof SELLERS.CyberSec)[],
  ) => ({
    sellers,
    neuroFluxSellers,
    factionRep: 1,
    factionWorkRepGain: 1,
  });
  /** Gen II (18,750) is reached at neither; the rest are: Gen I at NiteSec, the three cheap ones at CyberSec. */
  const REACHED = [GEN_I, BITWIRE, SYNAPTIC, NEUROTRAINER];
  const GEN_II_SELLERS = { [GEN_II]: [SELLERS.CyberSec, SELLERS.NiteSec] };
  const ALL_FIVE = 447_170_900;

  test("an augmentation no seller's reputation reaches: bought from the seller whose donation is least", () => {
    const set = chooseAugmentationsToBuy(REACHED, BN1, 1e12, LEVEL, terms(GEN_II_SELLERS));
    expect(set.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II, BITWIRE, SYNAPTIC, NEUROTRAINER]);
    expect(set.money).toBeCloseTo(ALL_FIVE, 0);
    // NiteSec's 6,750 short, not CyberSec's 13,750: $6.75b, and $10k for a hundredth more (core's margin).
    expect(set.donations).toEqual([{ faction: "NiteSec", reputation: 18_750, amount: 6_750_010_000 }]);
    expect(set.donationMoney).toBe(6_750_010_000);
    expect(set.byDonation).toEqual([GEN_II]);
    // Reached ones cost nothing: no donation without Gen II.
    expect(chooseAugmentationsToBuy(REACHED, BN1, 1e12, LEVEL, terms({})).donations).toEqual([]);
  });

  test("the money must cover the prices and the donations: a dollar short of Gen II's, it's left out", () => {
    // Gen II with Gen I, its prerequisite: $70m + $125m × 1.9, and NiteSec's $6.75b.
    const genII = 70e6 + 125e6 * 1.9 + 6_750_010_000;
    const short = chooseAugmentationsToBuy(REACHED, BN1, genII - 1, LEVEL, terms(GEN_II_SELLERS));
    expect(short.purchases.map((purchase) => purchase.name)).not.toContain(GEN_II);
    expect(short.byDonation).toEqual([]);
    expect(short.donations).toEqual([]);
    const enough = chooseAugmentationsToBuy(REACHED, BN1, genII, LEVEL, terms(GEN_II_SELLERS));
    expect(enough.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II]);
    expect(enough.byDonation).toEqual([GEN_II]);
    expect(enough.money + enough.donationMoney).toBe(genII);
  });

  test("one donation a faction, for the most reputation bought there: the max, not the sum", () => {
    const nitesec = { faction: "NiteSec", reputation: 0 };
    const sellers = {
      [BITWIRE]: [nitesec],
      [GEN_I]: [nitesec],
      [GEN_II]: [nitesec],
    };
    const set = chooseAugmentationsToBuy([], BN1, 1e12, LEVEL, terms(sellers));
    expect(set.byDonation.sort()).toEqual([BITWIRE, GEN_I, GEN_II].sort());
    expect(set.donations).toEqual([{ faction: "NiteSec", reputation: 18_750, amount: 18_750_010_000 }]);
  });

  test("the seller already raised wins: Gen I's donation at NiteSec covers most of Gen II's there", () => {
    // Both at 0: Gen I (10,000) goes to the first in the game's order (NiteSec); Gen II then raises that one least.
    const zero = (faction: string) => ({ faction, reputation: 0 });
    const both = [zero("NiteSec"), zero("CyberSec")];
    const set = chooseAugmentationsToBuy([], BN1, 1e12, LEVEL, terms({ [GEN_I]: both, [GEN_II]: both }));
    expect(set.donations).toEqual([{ faction: "NiteSec", reputation: 18_750, amount: 18_750_010_000 }]);
  });

  test("a tie on the donation goes to the seller with more reputation: one donation each, not one for both", () => {
    // Gen I raises NiteSec (at 0) to 10,000; Gen II then raises it or CyberSec (at 10,000) by as much: CyberSec.
    const nitesec = { faction: "NiteSec", reputation: 0 };
    const cyberSec = { faction: "CyberSec", reputation: 10_000 };
    const set = chooseAugmentationsToBuy(
      [],
      BN1,
      1e12,
      LEVEL,
      terms({ [GEN_I]: [nitesec], [GEN_II]: [nitesec, cyberSec] }),
    );
    expect(set.donations).toEqual([
      { faction: "NiteSec", reputation: 10_000, amount: 10_000_010_000 },
      { faction: "CyberSec", reputation: 18_750, amount: 8_750_010_000 },
    ]);
  });

  test("NeuroFlux Governor's levels beyond the sellers' reputation, bought with a donation on top of the set's", () => {
    const set = chooseAugmentationsToBuy(REACHED, BN1, ALL_FIVE, LEVEL, terms({}));
    const LEVEL_1 = 750_000 * 1.9 ** 4;
    const LEVEL_2 = 750_000 * 1.14 * 1.9 ** 5;
    const base = { state: BN1, set, neuroFluxReputation: 0 };
    const cyberSec = { faction: "CyberSec", reputation: 0 };
    // 500 reputation, then 570: $500m, then $70m more, one donation of $570m (and a hundredth of a reputation's $10k).
    const money = set.money + LEVEL_1 + 500_010_000 + LEVEL_2 + 70e6;
    const counts = affordableCounts({ ...base, money, donations: terms({}, [cyberSec]) });
    expect(counts).toMatchObject({ neuroFluxLevels: 2, byDonation: 2, donationMoney: 570_010_000 });
    expect(counts.donations).toEqual([{ faction: "CyberSec", reputation: 570, amount: 570_010_000 }]);
    expect(counts.money).toBeCloseTo(money, 0);
    // A dollar short of the second level's donation: one level.
    expect(affordableCounts({ ...base, money: money - 1, donations: terms({}, [cyberSec]) }).neuroFluxLevels).toBe(1);
    // Without a seller taking donations: none, as before.
    expect(affordableCounts({ ...base, money }).neuroFluxLevels).toBe(0);
  });

  test("the set's donations count for NeuroFlux too: a seller raised to Gen II's 18,750 needs none for a level", () => {
    const cyberSec = { faction: "CyberSec", reputation: 0 };
    const donating = terms({ [GEN_II]: [cyberSec], [GEN_I]: [cyberSec] }, [cyberSec]);
    const set = chooseAugmentationsToBuy([], BN1, 1e12, LEVEL, donating);
    expect(set.donations).toEqual([{ faction: "CyberSec", reputation: 18_750, amount: 18_750_010_000 }]);
    const level = 750_000 * 1.9 ** 2;
    const counts = affordableCounts({
      state: BN1,
      set,
      money: set.money + set.donationMoney + level,
      neuroFluxReputation: 0,
      donations: donating,
    });
    expect(counts).toMatchObject({ affordable: 2, neuroFluxLevels: 1, byDonation: 2, donationMoney: 18_750_010_000 });
  });
});

describe("what counts within reach at a commit (#238): Daedalus count stuck's facts", () => {
  const RIB = "Combat Rib I";
  const SPEECH = "Speech Processor Implant";
  const terms = (sellers: Record<string, { faction: string; reputation: number }[]>) => ({
    sellers,
    neuroFluxSellers: [],
    factionRep: 1,
    factionWorkRepGain: 1,
  });

  test("nothing reached, nothing to donate for: none (the early NeuroFlux-only install, CyberSec's five owned)", () => {
    const installed = Object.fromEntries(CYBERSEC.map((name) => [name, 1]));
    expect(countablesWithinReach({ reached: [], state: { ...BN1, installed } })).toEqual([]);
  });

  test("each reached one, whatever its hacking value, at its price then; the cheapest first", () => {
    // After two purchases: each price × 1.9².
    const state = { ...BN1, queued: [GEN_I, BITWIRE] };
    expect(
      countablesWithinReach({
        reached: [
          { augmentation: SPEECH, faction: "Tian Di Hui" },
          { augmentation: RIB, faction: "The Black Hand" },
        ],
        state,
      }),
    ).toEqual([
      { augmentation: RIB, faction: "The Black Hand", money: 23_750_000 * 1.9 ** 2 },
      { augmentation: SPEECH, faction: "Tian Di Hui", money: 50_000_000 * 1.9 ** 2 },
    ]);
  });

  test("never NeuroFlux Governor, one owned or queued (the set's too), or one whose prerequisites aren't", () => {
    const reached = [NEUROFLUX_GOVERNOR, GEN_I, GEN_II, SPEECH, "Combat Rib II"].map((augmentation) => ({
      augmentation,
      faction: "NiteSec",
    }));
    const state = { ...BN1, installed: { [GEN_I]: 1 }, queued: [SPEECH] };
    // Gen II's Gen I is installed; Combat Rib II's Combat Rib I isn't.
    expect(countablesWithinReach({ reached, state }).map((each) => each.augmentation)).toEqual([GEN_II]);
  });

  test("one no reputation reaches, sold by a faction taking donations: its price and the donation, at that faction", () => {
    // Gen II's 18,750 at NiteSec's 12,000: 6,750 at $1m each and $10k for a hundredth more.
    const within = countablesWithinReach({
      reached: [],
      state: { ...BN1, installed: { [GEN_I]: 1 } },
      donations: terms({
        [GEN_II]: [
          { faction: "CyberSec", reputation: 5_000 },
          { faction: "NiteSec", reputation: 12_000 },
        ],
      }),
    });
    // NiteSec's donation is least: 6,750 short, not CyberSec's 13,750.
    expect(within).toEqual([{ augmentation: GEN_II, faction: "NiteSec", money: 125_000_000 + 6_750_010_000 }]);
  });
});

describe("the experience for a level", () => {
  test("the game's `calculateExp`, never below 0", () => {
    expect(gameSource("PersonObjects/formulas/skill.ts")).toContain(
      "let value = Math.exp((skill / mult + 200) / 32) - 534.6;",
    );
    expect(hackingExpForLevel(300, 1)).toBeCloseTo(6_106_793.89, 1);
    expect(hackingExpForLevel(1, 1)).toBe(0);
  });
});

const MINUTE = 60_000;
const HOUR = 3_600_000;

describe("the bars (#222, the legacy scripts' count rule)", () => {
  test("8 new, or 12 with NeuroFlux, each falling by half an augmentation an hour online, floored", () => {
    expect([INSTALL_AT_AUGMENTATIONS, INSTALL_AT_AUGMENTATIONS_WITH_NEUROFLUX, INSTALL_BAR_FALL_PER_HOUR]).toEqual([
      8, 12, 0.5,
    ]);
    expect(installBars(0)).toEqual({
      bar: 8,
      barWithNeuroFlux: 12,
      barFallsAtMs: 2 * HOUR,
      barWithNeuroFluxFallsAtMs: 2 * HOUR,
    });
    // floor(0.5 × 1.99) is 0; at 2 h, 1; at 7.5 h, 3.
    expect(installBars(2 * HOUR - 1)).toMatchObject({ bar: 8, barWithNeuroFlux: 12 });
    expect(installBars(2 * HOUR)).toEqual({
      bar: 7,
      barWithNeuroFlux: 11,
      barFallsAtMs: 4 * HOUR,
      barWithNeuroFluxFallsAtMs: 4 * HOUR,
    });
    expect(installBars(7.5 * HOUR)).toMatchObject({ bar: 5, barWithNeuroFlux: 9, barFallsAtMs: 8 * HOUR });
  });

  test("never below 1: the bar is 1 from 14 h, with NeuroFlux from 22 h; then it falls no more", () => {
    expect(installBars(14 * HOUR - 1)).toMatchObject({ bar: 2, barFallsAtMs: 14 * HOUR });
    expect(installBars(14 * HOUR)).toEqual({
      bar: 1,
      barWithNeuroFlux: 5,
      barFallsAtMs: null,
      barWithNeuroFluxFallsAtMs: 16 * HOUR,
    });
    expect(installBars(22 * HOUR)).toEqual({
      bar: 1,
      barWithNeuroFlux: 1,
      barFallsAtMs: null,
      barWithNeuroFluxFallsAtMs: null,
    });
    expect(installBars(1_000 * HOUR)).toMatchObject({ bar: 1, barWithNeuroFlux: 1 });
  });

  test("an online time that isn't finite, or is below 0, throws", () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(() => installBars(bad)).toThrow(RangeError);
  });
});

describe("the counts", () => {
  const ALL_FIVE = 447_170_900;
  /** NeuroFlux Governor after the five: 750k × 1.9⁵, then 750k × 1.14 × 1.9⁶ (500 and 570 reputation). */
  const LEVEL_1 = 750_000 * 1.9 ** 5;
  const LEVEL_2 = 750_000 * 1.14 * 1.9 ** 6;
  const five = () => chooseAugmentationsToBuy(CYBERSEC, BN1, ALL_FIVE, LEVEL);

  test("the set, and the NeuroFlux Governor levels the money left after it covers, each priced after the last", () => {
    const set = five();
    const counts = affordableCounts({ state: BN1, set, money: ALL_FIVE + LEVEL_1 + LEVEL_2, neuroFluxReputation: 1e6 });
    expect(counts.affordable).toBe(5);
    expect(counts.neuroFluxLevels).toBe(2);
    expect(counts.affordableWithNeuroFlux).toBe(7);
    expect(counts.money).toBeCloseTo(ALL_FIVE + LEVEL_1 + LEVEL_2, 0);
    // A dollar short of the second level: one.
    expect(
      affordableCounts({ state: BN1, set, money: ALL_FIVE + LEVEL_1 + LEVEL_2 - 1, neuroFluxReputation: 1e6 }),
    ).toMatchObject({ affordable: 5, affordableWithNeuroFlux: 6, neuroFluxLevels: 1 });
    expect(affordableCounts({ state: BN1, set, money: ALL_FIVE, neuroFluxReputation: 1e6 })).toMatchObject({
      affordableWithNeuroFlux: 5,
      neuroFluxLevels: 0,
    });
  });

  test("each level needs a joined seller's reputation too: 500, then 570 (×1.14 a level)", () => {
    const rich = { state: BN1, set: five(), money: 1e15 };
    expect(affordableCounts({ ...rich, neuroFluxReputation: 499 }).neuroFluxLevels).toBe(0);
    expect(affordableCounts({ ...rich, neuroFluxReputation: 569 }).neuroFluxLevels).toBe(1);
    expect(affordableCounts({ ...rich, neuroFluxReputation: 570 }).neuroFluxLevels).toBe(2);
  });

  test("only what an install would really install counts: never a purchase the plan holds as queued alone", () => {
    // The plan's queue holds BitWire (reported bought, never shown queued): priced as queued, not counted.
    const state = { ...BN1, queued: [BITWIRE] };
    const set = chooseAugmentationsToBuy([GEN_I], state, 1e12, LEVEL);
    expect(affordableCounts({ state, installable: [], set, money: set.money, neuroFluxReputation: 0 })).toMatchObject({
      affordable: 1,
      affordableWithNeuroFlux: 1,
    });
    expect(affordableCounts({ state, set, money: set.money, neuroFluxReputation: 0 }).affordable).toBe(2);
  });

  test("short of Daedalus's count (#228): what's queued counts whatever its value", () => {
    const state = { ...BN1, queued: ["Combat Rib I", "Neural Wit Amplifier", "NeuroFlux Governor"] };
    const set = chooseAugmentationsToBuy([], state, 0, LEVEL);
    expect(affordableCounts({ state, set, money: 0, neuroFluxReputation: 0 })).toMatchObject({
      affordable: 0,
      affordableWithNeuroFlux: 1,
    });
    expect(affordableCounts({ state, set, money: 0, neuroFluxReputation: 0, short: true })).toMatchObject({
      affordable: 2,
      affordableWithNeuroFlux: 3,
    });
  });

  test("what's queued counts: those worth installing, and NeuroFlux Governor's copies with NeuroFlux; not the rest", () => {
    const state = { ...BN1, queued: [BITWIRE, "NeuroFlux Governor", "Combat Rib I"] };
    const set = chooseAugmentationsToBuy([GEN_I], state, 1e12, LEVEL);
    expect(set.purchases.map((purchase) => purchase.name)).toEqual([GEN_I]);
    const counts = affordableCounts({ state, set, money: set.money, neuroFluxReputation: 0 });
    expect(counts).toEqual({
      affordable: 2,
      affordableWithNeuroFlux: 3,
      neuroFluxLevels: 0,
      money: set.money,
      donations: [],
      donationMoney: 0,
      byDonation: 0,
    });
    // Gen I at 1.9³ for the three queued: $70m × 6.859.
    expect(set.money).toBeCloseTo(70e6 * 1.9 ** 3, 0);
    // The level after three queued and Gen I: 750k × 1.14 (one copy queued) × 1.9⁴.
    expect(
      affordableCounts({ state, set, money: set.money + 750_000 * 1.14 * 1.9 ** 4, neuroFluxReputation: 1e6 }),
    ).toMatchObject({ affordableWithNeuroFlux: 4, neuroFluxLevels: 1 });
  });
});

describe("the rule", () => {
  /** An hour into a cycle seen from its start, nothing affordable. */
  const inputs = (fields: Partial<InstallRuleInputs> = {}): InstallRuleInputs => ({
    onlineMs: HOUR,
    sinceResetMs: HOUR,
    affordable: 0,
    affordableWithNeuroFlux: 0,
    installing: 0,
    neuroFluxLevels: 0,
    nothingLeft: false,
    ...fields,
  });

  test("the count reached: 8 new, or 12 with NeuroFlux; one under either, not", () => {
    expect(installRule(inputs({ affordable: 8, affordableWithNeuroFlux: 8, installing: 8 }))).toMatchObject({
      install: true,
      reason: "count reached",
      bar: 8,
      barWithNeuroFlux: 12,
    });
    expect(installRule(inputs({ affordable: 5, affordableWithNeuroFlux: 12, installing: 5 }))).toMatchObject({
      install: true,
      reason: "count reached",
    });
    expect(installRule(inputs({ affordable: 7, affordableWithNeuroFlux: 11, installing: 7 }))).toMatchObject({
      install: false,
      reason: null,
      affordable: 7,
      affordableWithNeuroFlux: 11,
    });
  });

  test("the bars fall with the time online: 5 new install at 6 h, 1 at 14 h; the game's time since doesn't count", () => {
    const five = { affordable: 5, affordableWithNeuroFlux: 5, installing: 5 };
    expect(installRule(inputs({ ...five, onlineMs: 6 * HOUR - 1, sinceResetMs: 95 * HOUR })).install).toBe(false);
    expect(installRule(inputs({ ...five, onlineMs: 6 * HOUR, sinceResetMs: 95 * HOUR }))).toMatchObject({
      install: true,
      reason: "count reached",
      bar: 5,
    });
    const one = { affordable: 1, affordableWithNeuroFlux: 1, installing: 1 };
    expect(installRule(inputs({ ...one, onlineMs: 14 * HOUR - 1 })).install).toBe(false);
    expect(installRule(inputs({ ...one, onlineMs: 14 * HOUR }))).toMatchObject({ install: true, bar: 1 });
    // NeuroFlux levels alone: the bar with NeuroFlux is 1 from 22 h.
    const levels = { affordable: 0, affordableWithNeuroFlux: 1, installing: 0, neuroFluxLevels: 1 };
    expect(installRule(inputs({ ...levels, onlineMs: 22 * HOUR - 1 })).install).toBe(false);
    expect(installRule(inputs({ ...levels, onlineMs: 22 * HOUR })).install).toBe(true);
  });

  test("a quick install: 4 with NeuroFlux within 20 minutes of the last install, online and in the game's time", () => {
    expect([QUICK_INSTALL_WITHIN_MS, QUICK_INSTALL_AT_AUGMENTATIONS]).toEqual([20 * MINUTE, 4]);
    const four = { affordable: 3, affordableWithNeuroFlux: 4, installing: 3 };
    const early = { onlineMs: 20 * MINUTE - 1, sinceResetMs: 20 * MINUTE - 1 };
    expect(installRule(inputs({ ...four, ...early }))).toMatchObject({ install: true, reason: "quick install" });
    expect(installRule(inputs({ ...four, ...early, affordableWithNeuroFlux: 3 })).install).toBe(false);
    expect(installRule(inputs({ ...four, ...early, onlineMs: 20 * MINUTE })).install).toBe(false);
    expect(installRule(inputs({ ...four, ...early, sinceResetMs: 20 * MINUTE })).install).toBe(false);
    // A save first seen mid-cycle: 0 online, 95 h since its install. Not early in its cycle.
    expect(installRule(inputs({ ...four, onlineMs: 0, sinceResetMs: 95 * HOUR })).install).toBe(false);
    // The count reached early too: a quick install (its shorter countdown).
    expect(installRule(inputs({ ...early, affordable: 8, affordableWithNeuroFlux: 8, installing: 8 })).reason).toBe(
      "quick install",
    );
  });

  test("nothing left at the joined factions: install, with something to install; never with nothing", () => {
    expect(
      installRule(inputs({ nothingLeft: true, affordable: 1, affordableWithNeuroFlux: 1, installing: 1 })),
    ).toMatchObject({ install: true, reason: "nothing left" });
    // Something queued (bought by hand, say) and nothing more affordable: installs.
    expect(installRule(inputs({ nothingLeft: true, installing: 2 })).install).toBe(true);
    expect(installRule(inputs({ nothingLeft: true }))).toMatchObject({ install: false, reason: null });
    // NeuroFlux levels alone don't make nothing left an install: only the bars do.
    expect(installRule(inputs({ nothingLeft: true, affordableWithNeuroFlux: 3, neuroFluxLevels: 3 })).install).toBe(
      false,
    );
  });

  test("never with nothing really to install, whatever the counts say (#222 review: a phantom purchase counted)", () => {
    // At a bar of 1, a count of 1 that nothing queued, in the set or among the levels backs: no install, no reason.
    const phantom = {
      onlineMs: 22 * HOUR,
      affordable: 1,
      affordableWithNeuroFlux: 1,
      installing: 0,
      neuroFluxLevels: 0,
    };
    expect(installRule(inputs(phantom))).toMatchObject({ install: false, reason: null, bar: 1 });
    expect(
      installRule(inputs({ ...phantom, onlineMs: 5 * MINUTE, sinceResetMs: 5 * MINUTE, affordableWithNeuroFlux: 4 })),
    ).toMatchObject({ install: false, reason: null });
    // A level to buy, or one thing queued, is something.
    expect(installRule(inputs({ ...phantom, neuroFluxLevels: 1 })).install).toBe(true);
    expect(installRule(inputs({ ...phantom, installing: 1 })).install).toBe(true);
  });
});

describe("the countdown", () => {
  test("90 s, or 30 s for a quick install; each extension the larger of 10 s and the countdown less a share", () => {
    expect([INSTALL_COUNTDOWN_MS, QUICK_INSTALL_COUNTDOWN_MS, INSTALL_COUNTDOWN_LEAST_EXTENSION_MS]).toEqual([
      90_000, 30_000, 10_000,
    ]);
    // Bar 12: 90 × (1 − 1/12) = 82.5 s, then 75 s; 10 s once the extensions near the bar.
    expect(countdownExtensionMs(90_000, 1, 12)).toBeCloseTo(82_500, 6);
    expect(countdownExtensionMs(90_000, 2, 12)).toBeCloseTo(75_000, 6);
    expect(countdownExtensionMs(90_000, 11, 12)).toBe(10_000);
    expect(countdownExtensionMs(90_000, 20, 12)).toBe(10_000);
    expect(countdownExtensionMs(30_000, 1, 4)).toBeCloseTo(22_500, 6);
  });
});
