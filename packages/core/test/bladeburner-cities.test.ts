// Bladeburner B4 (#383): the cities and the chaos, their figures checked against the pinned game's source, the formulas
// worked by hand, and the rule's choices of city, Diplomacy and Incite Violence on both sides of their measures. The
// parity against the engine itself is the simulator's (packages/brain/test/bladeburner-cities-parity.test.ts).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  actionSuccessChance,
  BLADEBURNER_CONTRACTS,
  BLADEBURNER_LEVELLED_ACTIONS,
  BLADEBURNER_OPERATIONS,
  type BladeburnerActionReading,
  type BladeburnerCityFigures,
  type BladeburnerPerson,
  chaosDifficultyFactor,
  chooseBladeburnerAction,
} from "../src/bladeburner-actions.ts";
import {
  BLADEBURNER_CHAOS_ACTION_SECONDS,
  BLADEBURNER_CITIES,
  type BladeburnerCityReading,
  CHAOS_DECAY_PER_SECOND,
  chaosActionForgone,
  chaosAfterDiplomacy,
  chaosAfterIncite,
  chaosRankLoss,
  chooseBladeburnerCity,
  cityCompetenceRatio,
  DIPLOMACY,
  diplomaciesTo50,
  diplomacyPercent,
  INCITE_VIOLENCE,
  inciteCountGain,
  isBladeburnerCity,
} from "../src/bladeburner-cities.ts";

const gameSource = (file: string) =>
  readFileSync(new URL(`../../../vendor/bitburner-src/src/${file}`, import.meta.url), "utf8");

/** A player as BN6's division takes one: the four combat stats at `combat`, hacking and charisma 1, no intelligence. */
function person(combat = 100, charisma = 1): BladeburnerPerson {
  return {
    skills: {
      hacking: 1,
      strength: combat,
      defense: combat,
      dexterity: combat,
      agility: combat,
      charisma,
      intelligence: 0,
    },
    mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 },
  };
}

/** Each action read at level 1, its count `count` (or by name), its range collapsed on its chance in `city`. */
function readingsIn(
  who: BladeburnerPerson,
  city: BladeburnerCityFigures,
  { count = 100, counts = {} as Record<string, number> } = {},
): BladeburnerActionReading[] {
  return BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
    const chance = actionSuccessChance(action, 1, who, { city, penalty: 1 });
    return {
      type: action.type,
      name: action.name,
      level: 1,
      maxLevel: 1,
      count: counts[action.name] ?? count,
      chance: [chance, chance],
    };
  });
}

/** The six cities, each at `population` and `chaos` unless `overrides` names it. */
function cities(
  { population = 1e9, communities = 50, chaos = 0 } = {},
  overrides: Record<string, Partial<BladeburnerCityReading>> = {},
): BladeburnerCityReading[] {
  return BLADEBURNER_CITIES.map((name) => ({ name, population, communities, chaos, ...overrides[name] }));
}

const at = <T extends { name: string }>(all: readonly T[], name: string) => all.find((each) => each.name === name) as T;

/** The rule's input for `who` read in Sector-12 of `all`, full stamina, no bonus time, BN6. */
function input(
  who: BladeburnerPerson,
  all: BladeburnerCityReading[],
  options: { count?: number; counts?: Record<string, number> } = {},
) {
  const here = at(all, "Sector-12");
  const max = 39.81;
  return {
    readings: readingsIn(who, here, options),
    person: who,
    stamina: max,
    maxStamina: max,
    rankMultiplier: 1,
    speed: 1,
  };
}

describe("the game's facts", () => {
  test("the six cities, and the division's first, Sector-12", () => {
    expect(gameSource("Locations/Enums.ts")).toContain(
      'export enum CityName {\n  Aevum = "Aevum",\n  Chongqing = "Chongqing",\n  Sector12 = "Sector-12",\n  ' +
        'NewTokyo = "New Tokyo",\n  Ishima = "Ishima",\n  Volhaven = "Volhaven",\n}',
    );
    expect(BLADEBURNER_CITIES).toEqual(["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"]);
    expect(gameSource("Bladeburner/Bladeburner.ts")).toContain("  city = CityName.Sector12;\n");
    expect(isBladeburnerCity("New Tokyo")).toBe(true);
    expect(isBladeburnerCity("Tokyo")).toBe(false);
    expect(isBladeburnerCity(3)).toBe(false);
  });

  test("Diplomacy, Incite Violence, the decay and the switch are the game's lines", () => {
    const bladeburner = gameSource("Bladeburner/Bladeburner.ts");
    for (const line of [
      "    const CharismaLinearFactor = 1e3;\n    const CharismaExponentialFactor = 0.045;\n",
      "      Math.pow(person.skills.charisma, CharismaExponentialFactor) + person.skills.charisma / CharismaLinearFactor;",
      "            this.getCurrentCity().changeChaosByPercentage(-diplomacyPct);",
      "              contract.count += (60 * 3 * contract.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;",
      "              operation.count += (60 * 3 * operation.growthFunction()) / BladeburnerConstants.ActionCountGrowthPeriod;",
      "              city.changeChaosByCount(10);\n              city.changeChaosByCount(city.chaos / Math.log10(city.chaos));",
      "        city.chaos -= 0.0001 * seconds;\n        city.chaos = Math.max(0, city.chaos);",
    ]) {
      expect(bladeburner).toContain(line);
    }
    const city = gameSource("Bladeburner/City.ts");
    expect(city).toContain("    this.chaos = clampNumber(this.chaos * (1 + p / 100), 0);");
    expect(city).toContain("    this.chaos = clampNumber(this.chaos + n, 0);");
    const general = gameSource("Bladeburner/data/GeneralActions.ts");
    expect(general).toContain(
      "  [BladeburnerGeneralActionName.Diplomacy]: new GeneralAction({\n    name: BladeburnerGeneralActionName.Diplomacy,\n" +
        "    getActionTime: () => 60,",
    );
    expect(general).toContain(
      "  [BladeburnerGeneralActionName.InciteViolence]: new GeneralAction({\n" +
        "    name: BladeburnerGeneralActionName.InciteViolence,\n    getActionTime: () => 60,",
    );
    expect(BLADEBURNER_CHAOS_ACTION_SECONDS).toBe(60);
    expect(CHAOS_DECAY_PER_SECOND).toBe(0.0001);
    expect(gameSource("NetscriptFunctions/Bladeburner.ts")).toContain(
      "      bladeburner.city = cityName;\n      return true;",
    );
  });
});

describe("the formulas, worked by hand", () => {
  test("Diplomacy: p = cha^0.045 + cha/1,000 percent; the chaos × (1 − p/100); the count to 50", () => {
    expect(diplomacyPercent(1)).toBeCloseTo(1.001, 12);
    expect(diplomacyPercent(100)).toBeCloseTo(100 ** 0.045 + 0.1, 12);
    expect(chaosAfterDiplomacy(80, 1)).toBeCloseTo(80 * 0.98999, 12);
    expect(chaosAfterDiplomacy(0, 1)).toBe(0);
    // 80 × 0.98999^n ≤ 50: n ≥ ln(0.625) / ln(0.98999) = 46.7.
    expect(diplomaciesTo50(80, 1)).toBe(47);
    expect(80 * 0.98999 ** 47).toBeLessThanOrEqual(50);
    expect(80 * 0.98999 ** 46).toBeGreaterThan(50);
    expect(diplomaciesTo50(50.001, 1)).toBe(1);
    expect(diplomaciesTo50(50, 1)).toBe(0);
    expect(diplomaciesTo50(80, 1e6)).toBe(1);
  });

  test("Incite Violence: + 10, then + chaos/log10(chaos); 180 s of each count's mean growth", () => {
    expect(chaosAfterIncite(0)).toBeCloseTo(20, 12);
    expect(chaosAfterIncite(20)).toBeCloseTo(30 + 30 / Math.log10(30), 12);
    expect(chaosAfterIncite(20)).toBeGreaterThan(50);
    expect(chaosAfterIncite(19)).toBeLessThan(50);
    // Tracking's growth 5–75 tenths: a mean of 4, 180/480 of it; Raid's 2–40: 2.1.
    expect(inciteCountGain(BLADEBURNER_CONTRACTS[0] as never)).toBeCloseTo(1.5, 12);
    const raid = BLADEBURNER_OPERATIONS.find((each) => each.name === "Raid");
    expect(inciteCountGain(raid as never)).toBeCloseTo((180 * 2.1) / 480, 12);
  });

  test("a city's competence over another's: the estimates' ratio^0.7 and the chaos factors", () => {
    expect(cityCompetenceRatio({ population: 1e9, chaos: 0 }, { population: 1e9, chaos: 10 })).toBe(1);
    expect(cityCompetenceRatio({ population: 1e9, chaos: 0 }, { population: 2e9, chaos: 0 })).toBeCloseTo(2 ** 0.7, 12);
    expect(cityCompetenceRatio({ population: 1e9, chaos: 80 }, { population: 1e9, chaos: 0 })).toBeCloseTo(
      Math.sqrt(31),
      12,
    );
    expect(cityCompetenceRatio({ population: 1e9, chaos: 0 }, { population: 1e9, chaos: 80 })).toBeCloseTo(
      1 / Math.sqrt(31),
      12,
    );
    expect(cityCompetenceRatio({ population: 0, chaos: 0 }, { population: 1e9, chaos: 0 })).toBeNull();
    expect(chaosDifficultyFactor(80)).toBeCloseTo(Math.sqrt(31), 12);
  });

  test("the chaos's rank lost: exact where the rate goes as a + b/√(chaos − 49); none at or under 50", () => {
    const a = 0.002;
    const b = 0.005;
    const rate = (chaos: number) => a + b / chaosDifficultyFactor(chaos);
    // ∫ (a + b − a − b/u) 2u du = b·[(u − 1)²], over the decay's 1/0.0001 s a chaos.
    const exact = (from: number, to: number) =>
      (b * ((Math.sqrt(to - 49) - 1) ** 2 - (Math.sqrt(from - 49) - 1) ** 2)) / 0.0001;
    expect(chaosRankLoss(rate, a + b, 52, 80)).toBeCloseTo(exact(52, 80), 6);
    expect(chaosRankLoss(rate, a + b, 30, 51)).toBeCloseTo(exact(50, 51), 6);
    expect(chaosRankLoss(rate, a + b, 10, 50)).toBe(0);
    expect(chaosRankLoss(rate, a + b, 60, 55)).toBe(0);
    // A rate over the baseline loses nothing there.
    expect(chaosRankLoss(() => 1, 0.5, 50, 80)).toBe(0);
  });
  test("a chaos action's 60 s forgo the cycle's rate less what its regain saves of the rest", () => {
    const rest = (name: string, staminaPerSecond: number, rankPerSecond: number) =>
      ({ name, staminaPerSecond, rankPerSecond }) as never;
    const plan = (duty: number, rankPerSecond: number, restOf: never, work = true) =>
      ({ work: work ? {} : null, duty, rest: restOf, rankPerSecond, regain: 0.02 }) as never;
    // Field Analysis the rest (its stamina the regain): Field Analysis's rank.
    expect(chaosActionForgone(plan(0.3, 0.005, rest("Field Analysis", 0.02, 0.1 / 30)))).toBeCloseTo(0.1 / 30, 12);
    // The Chamber (0.05 a second, no rank): the cycle's rate less 0.02/0.05 of it.
    expect(chaosActionForgone(plan(0.3, 0.005, rest("Hyperbolic Regeneration Chamber", 0.05, 0)))).toBeCloseTo(
      0.005 * (1 - 0.02 / 0.05),
      12,
    );
    // Worked all the time, or resting alone: the cycle's rate.
    expect(chaosActionForgone(plan(1, 0.005, rest("Field Analysis", 0.02, 0.1 / 30)))).toBe(0.005);
    expect(chaosActionForgone(plan(0, 0.1 / 30, rest("Field Analysis", 0.02, 0.1 / 30), false))).toBe(0.1 / 30);
  });
});

describe("the rule's choice (#383): the city, Diplomacy and Incite Violence by B2's forecast", () => {
  const who = person();
  const b2 = (all: BladeburnerCityReading[], options = {}) => chooseBladeburnerAction(input(who, all, options));

  test("every city alike: Sector-12 kept, B2's plan there; null with it unread or its estimate 0", () => {
    const all = cities();
    const choice = chooseBladeburnerCity(input(who, all), { city: "Sector-12", cities: all });
    expect(choice?.city).toBe("Sector-12");
    expect(choice?.plan).toEqual(b2(all));
    expect(choice?.byCity.map((each) => each.rankPerSecond)).toEqual(Array(6).fill(b2(all).rankPerSecond));
    expect(choice).toMatchObject({ diplomacy: null, incite: null, chaosAction: null });
    expect(chooseBladeburnerCity(input(who, all), { city: "Nowhere", cities: all })).toBeNull();
    const none = cities({}, { "Sector-12": { population: 0 } });
    expect(chooseBladeburnerCity(input(who, all), { city: "Sector-12", cities: none })).toBeNull();
  });

  test("the city with the most rank a second: a larger estimate; then not past its forecast's tie", () => {
    const all = cities({}, { Ishima: { population: 1.3e9 } });
    const choice = chooseBladeburnerCity(input(who, all), { city: "Sector-12", cities: all });
    expect(choice?.city).toBe("Ishima");
    // Its forecast, B2's at Ishima's figures: the range read times (1.3)^0.7.
    const ishima = chooseBladeburnerAction({
      ...input(who, cities({ population: 1.3e9 })),
      readings: input(who, all).readings,
      city: { ratio: 1.3 ** 0.7, raid: true },
    });
    expect(choice?.plan).toEqual(ishima);
    expect(ishima.rankPerSecond).toBeGreaterThan(b2(all).rankPerSecond);
    // Read in Ishima, Sector-12 the lesser: kept.
    expect(chooseBladeburnerCity(input(who, all), { city: "Ishima", cities: all })?.city).toBe("Ishima");
  });

  test("Sector-12's chaos at 80, the others 0: moved to the first of the others; no Diplomacy there", () => {
    const all = cities({}, { "Sector-12": { chaos: 80 } });
    const choice = chooseBladeburnerCity(input(who, all), { city: "Sector-12", cities: all });
    expect(choice?.city).toBe("Aevum");
    expect(choice?.diplomacy).toBeNull();
    expect(choice?.chaosAction).toBeNull();
    // Its forecast there: B2's at chaos 0, from the range read at 80 (√31 over it).
    expect(choice?.plan.rankPerSecond).toBeCloseTo(b2(cities()).rankPerSecond, 12);
    expect(at(choice?.byCity ?? [], "Sector-12").rankPerSecond).toBeLessThan(choice?.plan.rankPerSecond ?? 0);
  });

  test("Raid is out of a city with no communities", () => {
    // At combat 1,000, Raid is the plan's work.
    const strong = person(1000);
    const all = cities({}, { Aevum: { population: 1.05e9, communities: 0 } });
    const here = chooseBladeburnerAction(input(strong, all));
    expect(here.work?.name).toBe("Raid");
    const choice = chooseBladeburnerCity(input(strong, all), { city: "Sector-12", cities: all });
    const aevum = chooseBladeburnerAction({
      ...input(strong, all),
      city: { ratio: 1.05 ** 0.7, raid: false },
    });
    expect(aevum.work?.name).not.toBe("Raid");
    expect(at(choice?.byCity ?? [], "Aevum").rankPerSecond).toBeCloseTo(aevum.rankPerSecond, 12);
    expect(choice?.city).toBe("Sector-12");
  });

  /** Every city at `chaos`, read in Sector-12. */
  const everywhere = (chaos: number, charisma = 1) => {
    const all = cities({ chaos });
    const whom = person(100, charisma);
    return chooseBladeburnerCity(input(whom, all), { city: "Sector-12", cities: all });
  };

  test("Diplomacy: its 60 s at the rate at 50 against the chaos's rank it takes off, both sides of the break-even", () => {
    const choice = everywhere(52);
    const diplomacy = choice?.diplomacy;
    if (diplomacy == null) throw new Error("no Diplomacy weighed");
    expect(diplomacy.after).toBeCloseTo(52 * 0.98999, 12);
    expect(diplomacy.attemptsTo50).toBe(diplomaciesTo50(52, 1));
    // The cost: what 60 s forgo of the cycle at 50 or under; the gain, the chaos's rank lost from 51.48 to 52, a fine sum.
    const rateAt = (chaos: number) =>
      chooseBladeburnerAction({
        ...input(who, cities({ chaos: 52 })),
        city: { ratio: chaosDifficultyFactor(52) / chaosDifficultyFactor(chaos), raid: true },
      }).rankPerSecond;
    const base = rateAt(50);
    const atFifty = chooseBladeburnerAction({
      ...input(who, cities({ chaos: 52 })),
      city: { ratio: chaosDifficultyFactor(52), raid: true },
    });
    expect(diplomacy.cost).toBeCloseTo(60 * chaosActionForgone(atFifty), 12);
    // Field Analysis the rest: the regain it saves of the rest is worth the cycle's rate less Field Analysis's, so
    // the 60 s forgo Field Analysis's rank.
    expect(atFifty.rest.name).toBe("Field Analysis");
    expect(chaosActionForgone(atFifty)).toBeCloseTo(0.1 / 30, 12);
    let fine = 0;
    const steps = 20_000;
    const width = (52 - diplomacy.after) / steps;
    for (let i = 0; i < steps; i++) fine += Math.max(0, base - rateAt(diplomacy.after + (i + 0.5) * width)) * width;
    expect(diplomacy.gain / (fine / 0.0001)).toBeCloseTo(1, 4);
    expect(diplomacy.pays).toBe(true);
    expect(choice?.chaosAction).toBe(DIPLOMACY);
    // The break-even: bisected on the chaos everywhere; just over it pays, just under doesn't.
    let low = 50;
    let high = 52;
    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2;
      if (everywhere(middle)?.diplomacy?.pays) high = middle;
      else low = middle;
    }
    expect(high).toBeGreaterThan(50);
    expect(high).toBeLessThan(51);
    expect(everywhere(high + 1e-6)?.chaosAction).toBe(DIPLOMACY);
    expect(everywhere(low - 1e-6)?.diplomacy?.pays).toBe(false);
    expect(everywhere(low - 1e-6)?.chaosAction).toBeNull();
    // At 50 or under, none weighed.
    expect(everywhere(50)?.diplomacy).toBeNull();
  });

  test("a city at 52 with the others at 0: moved, not Diplomacy; all at 52: it pays", () => {
    // Sector-12 at 52 with a larger estimate, the others at 0 chaos: the move wins, and Diplomacy isn't weighed there.
    const all = cities({}, { "Sector-12": { chaos: 52 } });
    expect(chooseBladeburnerCity(input(who, all), { city: "Sector-12", cities: all })?.city).toBe("Aevum");
    // Where the others are worse than Sector-12 at its chaos's every step, as when they are all at 52: it pays.
    expect(everywhere(52)?.chaosAction).toBe(DIPLOMACY);
    // One a little under the others: chosen, and Diplomacy weighed there.
    const near = cities({ chaos: 52 }, { Aevum: { chaos: 51.6 } });
    const lower = chooseBladeburnerCity(input(who, near), { city: "Sector-12", cities: near });
    expect(lower?.city).toBe("Aevum");
    expect(lower?.diplomacy?.chaos).toBe(51.6);
  });

  test("Incite Violence at combat 300, Raid out of count: from chaos 0 it pays (to 20, no chaos lost); from 40, not", () => {
    const strong = person(300);
    // Raid, the plan's work, out of count: R∞ over Rn.
    const counts = { Raid: 0.5 };
    const zero = cities();
    const choice = chooseBladeburnerCity(input(strong, zero, { counts }), { city: "Sector-12", cities: zero });
    const incite = choice?.incite;
    if (incite == null) throw new Error("no Incite weighed");
    const now = chooseBladeburnerAction(input(strong, zero, { counts }));
    const unbounded = chooseBladeburnerAction(input(strong, zero, { count: Number.POSITIVE_INFINITY }));
    expect(unbounded.work?.name).toBe("Raid");
    expect(incite.unbounded).toBeCloseTo(unbounded.rankPerSecond, 12);
    expect(incite.after).toBeCloseTo(20, 12);
    expect(incite.countGain).toBeCloseTo((180 * 2.1) / 480, 12);
    expect(incite.work).toBe("Raid level 1");
    // The gain: 0.79 attempts, each its seconds over its share worked, at R∞ in place of Rn; the cost: what 60 s forgo
    // of Rn's cycle, no chaos lost (20 is under 50).
    const seconds = unbounded.work?.seconds ?? 0;
    expect(incite.gain).toBeCloseTo(
      ((180 * 2.1) / 480) * (seconds / unbounded.duty) * (unbounded.rankPerSecond - now.rankPerSecond),
      12,
    );
    expect(incite.cost).toBeCloseTo(60 * chaosActionForgone(now), 12);
    expect(incite.pays).toBe(true);
    expect(choice?.chaosAction).toBe(INCITE_VIOLENCE);
    // From 40, the chaos to 79: its rank lost over the decay outweighs the counts.
    const forty = cities({ chaos: 40 });
    const high = chooseBladeburnerCity(input(strong, forty, { counts }), { city: "Sector-12", cities: forty });
    expect(high?.incite?.after).toBeCloseTo(50 + 50 / Math.log10(50), 12);
    expect(high?.incite?.cost).toBeGreaterThan(60 * chaosActionForgone(now));
    expect(high?.incite?.pays).toBe(false);
    expect(high?.chaosAction).toBeNull();
    // The counts not binding: none weighed.
    expect(chooseBladeburnerCity(input(strong, zero), { city: "Sector-12", cities: zero })?.incite).toBeNull();
  });

  test("Incite Violence at combat 100, Bounty Hunter out: it doesn't pay, its counts worth less than its 60 s", () => {
    // Bounty Hunter's cycle barely beats Field Analysis's (0.30 against 0.20 rank a minute): 1.5 more attempts gain
    // less than the 60 s of Field Analysis forgone, even every count out.
    for (const counts of [
      { "Bounty Hunter": 0.5 },
      Object.fromEntries(BLADEBURNER_LEVELLED_ACTIONS.map((each) => [each.name, 0.5])),
    ]) {
      const zero = cities();
      const incite = chooseBladeburnerCity(input(who, zero, { counts }), { city: "Sector-12", cities: zero })?.incite;
      expect(incite?.work).toBe("Bounty Hunter level 1");
      expect(incite?.cost).toBeCloseTo(60 * (0.1 / 30), 12);
      expect(incite?.pays).toBe(false);
    }
  });

  test("Incite Violence's break-even on the chaos: both sides, where the chaos it adds passes 50", () => {
    const strong = person(300);
    const counts = { Raid: 0.5 };
    const pays = (chaos: number) => {
      const all = cities({ chaos });
      return chooseBladeburnerCity(input(strong, all, { counts }), { city: "Sector-12", cities: all })?.incite?.pays;
    };
    let low = 0;
    let high = 40;
    for (let i = 0; i < 60; i++) {
      const middle = (low + high) / 2;
      if (pays(middle)) low = middle;
      else high = middle;
    }
    // It pays while the chaos it adds stays about at 50: from just under 20 (19.8 → 50).
    expect(chaosAfterIncite(low)).toBeGreaterThan(50);
    expect(chaosAfterIncite(low)).toBeLessThan(50.2);
    expect(pays(low - 1e-6)).toBe(true);
    expect(pays(high + 1e-6)).toBe(false);
  });
});
