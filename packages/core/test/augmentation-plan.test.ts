// Augmentations and the reset (#210): which the brain buys, in what order, and whether installing now beats carrying
// on. Worked by hand from the game's data (`Augmentation/Augmentations.ts`) and formulas (`skill.ts`, `getAugCost`).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  augmentationBuyOrder,
  chooseAugmentationsToBuy,
  hackingExpForLevel,
  type InstallCandidate,
  installDecision,
  installGains,
  isWorthInstalling,
  rebuildTimeMs,
} from "../src/augmentation-plan.ts";
import { type AugmentationPurchaseState, purchaseSequenceCost } from "../src/augmentations.ts";

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
/** CyberSec's five worth installing (`Faction/FactionInfo.tsx`'s shop, less NeuroFlux Governor). */
const CYBERSEC = [NEUROTRAINER, SYNAPTIC, BITWIRE, GEN_I, GEN_II];

describe("which augmentations", () => {
  test("worth installing: a hacking value, not NeuroFlux Governor", () => {
    expect(CYBERSEC.every(isWorthInstalling)).toBe(true);
    expect(isWorthInstalling("Artificial Synaptic Potentiation")).toBe(true); // hacking chance, speed and exp only
    expect(isWorthInstalling("Social Negotiation Assistant (S.N.A)")).toBe(true); // faction_rep alone
    expect(isWorthInstalling("NeuroFlux Governor")).toBe(false);
    expect(isWorthInstalling("Combat Rib I")).toBe(false);
    expect(isWorthInstalling("Speech Processor Implant")).toBe(false);
    expect(isWorthInstalling("The Red Pill")).toBe(false);
    expect(isWorthInstalling("Unstable Circadian Modulator")).toBe(false); // drawn at random
    expect(() => isWorthInstalling("Nothing")).toThrow(RangeError);
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

  test("a chain is bought in its order, whatever the prices; one outside the list is taken as owned", () => {
    const gens = ["Cranial Signal Processors - Gen V", "Cranial Signal Processors - Gen III", GEN_II, GEN_I];
    expect(augmentationBuyOrder([...gens, "Cranial Signal Processors - Gen IV", "DataJack"])).toEqual([
      "DataJack", // $450m: dearer than Gen I, the only Gen ready at first
      GEN_I,
      GEN_II,
      "Cranial Signal Processors - Gen III",
      "Cranial Signal Processors - Gen IV",
      "Cranial Signal Processors - Gen V", // $2.25b, but after Gen IV
    ]);
    expect(augmentationBuyOrder([GEN_II, BITWIRE])).toEqual([GEN_II, BITWIRE]);
  });

  test("ties go to the game's order; a name listed twice is bought once", () => {
    // Both $250m.
    expect(augmentationBuyOrder(["Embedded Netburner Module", "Neural-Retention Enhancement"])).toEqual([
      "Neural-Retention Enhancement",
      "Embedded Netburner Module",
    ]);
    expect(augmentationBuyOrder([BITWIRE, BITWIRE])).toEqual([BITWIRE]);
  });

  test("falling prices really cost least: CyberSec's five in buy order against rising prices", () => {
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
    const set = chooseAugmentationsToBuy(CYBERSEC, BN1, ALL_FIVE);
    expect(set.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II, BITWIRE, SYNAPTIC, NEUROTRAINER]);
    expect(set.money).toBeCloseTo(447_170_900, 0);
    expect(set.purchases[1]).toEqual({ name: GEN_II, money: 125e6 * 1.9, reputation: 18_750 });
  });

  test("short of it: the most hacking value, greedily, each kept only if the whole set's money is covered", () => {
    // By value: Gen II (with Gen I, $307.5m), Neurotrainer I, Gen I, BitWire, then Synaptic, which takes it past.
    const fourHundred = chooseAugmentationsToBuy(CYBERSEC, BN1, 400e6);
    expect(fourHundred.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, GEN_II, BITWIRE, NEUROTRAINER]);
    expect(fourHundred.money).toBeCloseTo(70e6 + 125e6 * 1.9 + 10e6 * 1.9 ** 2 + 4e6 * 1.9 ** 3, 0);
    // Under Gen II's $307.5m: Neurotrainer I, Gen I, BitWire and Synaptic, $143.5m.
    const threeHundred = chooseAugmentationsToBuy(CYBERSEC, BN1, 300e6);
    expect(threeHundred.purchases.map((purchase) => purchase.name)).toEqual([GEN_I, BITWIRE, SYNAPTIC, NEUROTRAINER]);
    expect(threeHundred.money).toBeCloseTo(143_511_000, 0);
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 3_999_999)).toEqual({ purchases: [], money: 0 });
    expect(chooseAugmentationsToBuy(CYBERSEC, BN1, 4e6).purchases.map((purchase) => purchase.name)).toEqual([
      NEUROTRAINER,
    ]);
  });

  test("a prerequisite not reached keeps out what needs it; one installed or queued doesn't", () => {
    expect(chooseAugmentationsToBuy([GEN_II], BN1, 1e12)).toEqual({ purchases: [], money: 0 });
    const installed = { ...BN1, installed: { [GEN_I]: 1 } };
    expect(chooseAugmentationsToBuy([GEN_II], installed, 1e12).purchases).toEqual([
      { name: GEN_II, money: 125e6, reputation: 18_750 },
    ]);
    // Queued: Gen II at 1.9 × its price.
    const queued = { ...BN1, queued: [GEN_I] };
    expect(chooseAugmentationsToBuy([GEN_I, GEN_II], queued, 1e12).purchases).toEqual([
      { name: GEN_II, money: 125e6 * 1.9, reputation: 18_750 },
    ]);
  });

  test("a prerequisite reached but not worth installing goes in with what needs it", () => {
    // Graphene Bionic Spine Upgrade needs Bionic Spine (combat both): neither is worth installing.
    expect(chooseAugmentationsToBuy(["Bionic Spine", "Graphene Bionic Spine Upgrade"], BN1, 1e15).purchases).toEqual(
      [],
    );
    // Gen II's prerequisite is worth it anyway; the rule is the bundle's, whatever its worth.
    expect(chooseAugmentationsToBuy([GEN_I, GEN_II], BN1, 1e12).purchases.map((each) => each.name)).toEqual([
      GEN_I,
      GEN_II,
    ]);
  });

  test("not worth installing, owned or unknown: left out, or refused", () => {
    expect(chooseAugmentationsToBuy(["Combat Rib I", "NeuroFlux Governor"], BN1, 1e12).purchases).toEqual([]);
    expect(chooseAugmentationsToBuy([BITWIRE], { ...BN1, installed: { [BITWIRE]: 1 } }, 1e12).purchases).toEqual([]);
    expect(chooseAugmentationsToBuy([BITWIRE], { ...BN1, queued: [BITWIRE] }, 1e12).purchases).toEqual([]);
    expect(() => chooseAugmentationsToBuy(["Nothing"], BN1, 1e12)).toThrow(RangeError);
  });
});

describe("the rebuild", () => {
  test("the experience for a level is the game's `calculateExp`, never below 0", () => {
    expect(gameSource("PersonObjects/formulas/skill.ts")).toContain(
      "let value = Math.exp((skill / mult + 200) / 32) - 534.6;",
    );
    expect(hackingExpForLevel(300, 1)).toBeCloseTo(6_106_793.89, 1);
    expect(hackingExpForLevel(1, 1)).toBe(0);
  });

  test("CyberSec's five at level 300, 7 h in: the experience a quarter, over the exp and speed gains", () => {
    const gains = installGains(CYBERSEC);
    const rebuild = rebuildTimeMs({
      sinceResetMs: 7 * 3_600_000,
      hackingLevel: 300,
      hackingExp: hackingExpForLevel(300, 1),
      gains,
    });
    // 1,464,082 of 6,106,794 experience (0.2397), over 1.1 × 1.06 (exp and speed): 1.44 h.
    expect(rebuild).toBeCloseTo(5_176_083, -1);
  });

  test("no hacking gain: the experience is the same, so only the exp and speed gains shorten it", () => {
    const rebuild = rebuildTimeMs({
      sinceResetMs: 50 * 60_000,
      hackingLevel: 60,
      hackingExp: hackingExpForLevel(60, 1),
      gains: installGains([NEUROTRAINER]),
    });
    expect(rebuild).toBeCloseTo((50 * 60_000) / 1.1, 3);
  });

  test("the multiplier now comes from the level and experience, the BitNode's in it", () => {
    // Level 150 at a multiplier of 0.8: nothing gained, so the time since the install.
    const exp = hackingExpForLevel(150, 0.8);
    const gains = { hacking: 1, hacking_exp: 1, hacking_speed: 1 };
    expect(rebuildTimeMs({ sinceResetMs: 3_600_000, hackingLevel: 150, hackingExp: exp, gains })).toBeCloseTo(
      3_600_000,
      3,
    );
    // ×1.25 hacking: the experience for level 150 at 1.0, of that at 0.8.
    const quicker = rebuildTimeMs({
      sinceResetMs: 3_600_000,
      hackingLevel: 150,
      hackingExp: exp,
      gains: { ...gains, hacking: 1.25 },
    });
    expect(quicker).toBeCloseTo((3_600_000 * hackingExpForLevel(150, 1)) / exp, 3);
  });

  test("no experience yet: nothing to rebuild; a figure that isn't finite or is below 0 throws", () => {
    const gains = { hacking: 1.1, hacking_exp: 1, hacking_speed: 1 };
    expect(rebuildTimeMs({ sinceResetMs: 60_000, hackingLevel: 1, hackingExp: 0, gains })).toBe(0);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => rebuildTimeMs({ sinceResetMs: bad, hackingLevel: 1, hackingExp: 1, gains })).toThrow(RangeError);
      expect(() => rebuildTimeMs({ sinceResetMs: 1, hackingLevel: bad, hackingExp: 1, gains })).toThrow(RangeError);
      expect(() => rebuildTimeMs({ sinceResetMs: 1, hackingLevel: 1, hackingExp: bad, gains })).toThrow(RangeError);
    }
  });
});

describe("the decision", () => {
  const HOUR = 3_600_000;
  /** At level 300, 7 h in, CyberSec's five to install: a rebuild of 1.44 h (above). */
  const base = {
    sinceResetMs: 7 * HOUR,
    hackingLevel: 300,
    hackingExp: hackingExpForLevel(300, 1),
    installing: CYBERSEC,
    money: 500e6,
    incomePerSecond: 100_000,
  };
  const REBUILD = 5_176_083;
  const candidate = (fields: Partial<InstallCandidate>): InstallCandidate => ({
    augmentation: "Neurotrainer II",
    faction: "NiteSec",
    reputation: 0,
    reputationNeeded: 10_000,
    reputationPerSecond: 2,
    costAfterSet: 500e6,
    priceAfterInstall: 0,
    ...fields,
  });

  test("nothing left to work for: install, with something to install; never with nothing", () => {
    expect(installDecision({ ...base, candidates: [] })).toMatchObject({ install: true, without: null, with: null });
    expect(installDecision({ ...base, installing: [], candidates: [] }).install).toBe(false);
    // The income doesn't matter then.
    expect(installDecision({ ...base, incomePerSecond: null, candidates: [] }).install).toBe(true);
  });

  test("the next one sooner carrying on: no install", () => {
    // Carrying on: 10,000 rep at 2/s, 5,000 s (1.39 h). Installing: 1.44 h, then 5,000 s.
    const decision = installDecision({ ...base, candidates: [candidate({})] });
    expect(decision.install).toBe(false);
    expect(decision.without).toEqual({ augmentation: "Neurotrainer II", faction: "NiteSec", ms: 5_000_000 });
    expect(decision.with?.ms).toBeCloseTo(REBUILD + 5_000_000, -1);
    expect(decision.rebuildMs).toBeCloseTo(REBUILD, -1);
  });

  test("the money far off carrying on (the set's prices ×1.9 each), little once installed: install", () => {
    // Carrying on: $22.9b less $500m at $100k/s, 224,000 s. Installing: the rebuild, then 10,000 rep at 2/s or its
    // $250m at $100k/s (2,500 s): 5,000 s.
    const far = candidate({ costAfterSet: 22.9e9, priceAfterInstall: 250e6 });
    const decision = installDecision({ ...base, candidates: [far] });
    expect(decision.without?.ms).toBeCloseTo(224_000_000, -1);
    expect(decision.with?.ms).toBeCloseTo(REBUILD + 5_000_000, -1);
    expect(decision.install).toBe(true);
  });

  test("the longer of reputation and money on each side; the soonest candidate on each", () => {
    const repBound = candidate({ augmentation: "A", reputationNeeded: 40_000, reputation: 30_000 }); // 5,000 s
    const moneyBound = candidate({ augmentation: "B", costAfterSet: 1.5e9, priceAfterInstall: 2e9 }); // 10,000 s
    const decision = installDecision({ ...base, candidates: [moneyBound, repBound] });
    expect(decision.without).toMatchObject({ augmentation: "A", ms: 5_000_000 });
    // Installing, A takes 20,000 s, B's money 20,000 s: the first of the soonest.
    expect(decision.with?.augmentation).toBe("B");
    expect(decision.with?.ms).toBeCloseTo(REBUILD + 20_000_000, -1);
  });

  test("installing, the rate is times the install's faction_rep; the reputation from scratch", () => {
    const sna = candidate({ reputation: 9_000 });
    const plain = installDecision({ ...base, candidates: [sna] });
    const repGain = installDecision({
      ...base,
      installing: [...CYBERSEC, "Social Negotiation Assistant (S.N.A)"],
      candidates: [sna],
    });
    expect(plain.with?.ms).toBeCloseTo(REBUILD + 5_000_000, -1);
    expect(repGain.with?.ms).toBeCloseTo(REBUILD + 5_000_000 / 1.15, -1);
    expect(plain.without?.ms).toBe(500_000);
  });

  test("reached and covered: 0 carrying on; no rate is never, and never on both sides is as good as nothing left", () => {
    const covered = candidate({ reputation: 10_000, costAfterSet: 100e6 });
    expect(installDecision({ ...base, candidates: [covered] }).without?.ms).toBe(0);
    const noRate = candidate({ reputationPerSecond: 0 });
    const never = installDecision({ ...base, candidates: [noRate] });
    expect(never.without?.ms).toBe(Number.POSITIVE_INFINITY);
    expect(never.install).toBe(true);
    expect(installDecision({ ...base, installing: [], candidates: [noRate] }).install).toBe(false);
  });

  test("with candidates and no income measured: it waits, saying why", () => {
    const decision = installDecision({ ...base, incomePerSecond: null, candidates: [candidate({})] });
    expect(decision).toMatchObject({ install: false, without: null, with: null });
    expect(decision.waitingFor).toMatch(/^the income/);
  });

  test("an empty set to install never installs, however far the next", () => {
    const far = candidate({ costAfterSet: 1e15, priceAfterInstall: 0 });
    expect(installDecision({ ...base, installing: [], candidates: [far] }).install).toBe(false);
  });
});
