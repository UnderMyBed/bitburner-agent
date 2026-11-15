// Bladeburner #420: each city at its own true population, from the round over the six. The round built here as the
// game reads it (`Actions/Action.ts:144-167`'s range at each city's own population and estimate, a Black Op's with no
// population factor, `Actions/BlackOperation.ts:55-61`): a city recovered at its truth exactly, one not recovered by
// its own ranges over the game's draw (#411's `actionChanceOverSpread`, the ruling's ½g(high) + ½g(low) with each g on
// its half of U), one with every range clipped at the draw's mean; and B4's figure (the live rule's ratio) and the
// drift's (the walk's and the grown estimate's chance at the start) the same function's.
import { describe, expect, test } from "vitest";
import { COMBAT_STATS, type CombatPerson, skillExpFor, skillLevelOf } from "../src/bladeburner.ts";
import {
  actionChanceOverSpread,
  actionSuccessChance,
  actionSuccessRange,
  BLADEBURNER_LEVELLED_ACTIONS,
  type BladeburnerPerson,
  POPULATION_ESTIMATE_SPREAD,
} from "../src/bladeburner-actions.ts";
import { BLADEBURNER_BLACK_OPS, blackOpSuccessChance } from "../src/bladeburner-black-ops.ts";
import { BLADEBURNER_CITIES, type BladeburnerCityReading, cityCompetenceRatio } from "../src/bladeburner-cities.ts";
import {
  BLADEBURNER_DRAW_RATIO,
  bladeburnerCityMeasures,
  bladeburnerMeasuredCities,
} from "../src/bladeburner-city-measures.ts";
import { bladeburnerDriftStart, driftedChance } from "../src/bladeburner-drift.ts";

const SF1_3 = 1.28;
function personAt(combat: number): BladeburnerPerson {
  const exp = Object.fromEntries(COMBAT_STATS.map((stat) => [stat, skillExpFor(combat, SF1_3)])) as CombatPerson["exp"];
  const skills = { hacking: 100, charisma: 50, intelligence: 0 } as BladeburnerPerson["skills"];
  for (const stat of COMBAT_STATS) skills[stat] = skillLevelOf(exp[stat], SF1_3);
  return { skills, mults: { bladeburner_success_chance: 1, bladeburner_max_stamina: 1, bladeburner_stamina_gain: 1 } };
}

/** A city's truth: its population, its estimate's ratio pop/popEst, communities and chaos. */
interface Truth {
  name: string;
  population: number;
  ratio: number;
  communities: number;
  chaos: number;
}

/** The six cities' truths: each its own pop/popEst (`City.ts:23`'s draw, each on its own). */
const TRUTHS: Truth[] = [
  { name: "Aevum", population: 1.1e9, ratio: 0.8, communities: 60, chaos: 0 },
  { name: "Chongqing", population: 1.0e9, ratio: 1.6, communities: 60, chaos: 0 },
  { name: "Sector-12", population: 0.675e9, ratio: 1.0, communities: 60, chaos: 0 },
  { name: "New Tokyo", population: 1.685e9, ratio: 1.25, communities: 60, chaos: 19.8 },
  { name: "Ishima", population: 1.2e9, ratio: 0.7, communities: 0, chaos: 55 },
  { name: "Volhaven", population: 1.3e9, ratio: 1.9, communities: 60, chaos: 0 },
];

/** What the API reads (`getCityEstimatedPopulation`, the communities, the chaos) and the round, as the game has it. */
function readOf(truths: readonly Truth[], who: BladeburnerPerson, blackOp = BLADEBURNER_BLACK_OPS[3]) {
  const cities: BladeburnerCityReading[] = truths.map((each) => ({
    name: each.name,
    population: each.population / each.ratio,
    communities: each.communities,
    chaos: each.chaos,
  }));
  const formula = blackOp === undefined ? null : blackOpSuccessChance(blackOp, who, { penalty: 1 });
  const round = {
    blackOp: blackOp?.name ?? null,
    city: "New Tokyo",
    cities: truths.map((each) => {
      const estimate = each.population / each.ratio;
      const at = (population: number) => ({ population, chaos: each.chaos, communities: each.communities });
      return {
        name: each.name,
        blackOp: formula === null ? null : actionSuccessRange(formula, formula, each.population, estimate),
        actions: BLADEBURNER_LEVELLED_ACTIONS.map((action) => {
          const real = actionSuccessChance(action, 1, who, { city: at(each.population), penalty: 1 });
          const est = actionSuccessChance(action, 1, who, { city: at(estimate), penalty: 1 });
          return {
            type: action.type,
            name: action.name,
            chance: actionSuccessRange(real, est, each.population, estimate),
          };
        }),
      };
    }),
  };
  return { cities, round, formula };
}

describe("each city measured (#420): its own range, not another's", () => {
  test("every city recovered: its true population exactly, each its own pop/popEst", () => {
    const who = personAt(100);
    const { cities, round, formula } = readOf(TRUTHS, who);
    expect(formula).toBeLessThan(0.5);
    const measures = bladeburnerCityMeasures(cities, round, formula, "New Tokyo");
    expect(measures?.map((each) => each.name)).toEqual([...BLADEBURNER_CITIES]);
    for (const [i, truth] of TRUTHS.entries()) {
      const measure = measures?.[i];
      expect(measure?.by).toBe("recovered");
      expect(measure?.ratio).toBeCloseTo(truth.ratio, 9);
      expect((measure?.population as number) / truth.population).toBeCloseTo(1, 9);
    }
    // The shared ratio (#418's convention, gone): New Tokyo's 1.25 for all would put Volhaven at 1.3e9 × 1.25 / 1.9.
    const volhaven = measures?.find((each) => each.name === "Volhaven");
    expect(volhaven?.population).not.toBeCloseTo((1.3e9 / 1.9) * 1.25, -6);
  });

  test("not recovered (its Black Op's range clipped): by its own ranges, its chance its own over the draw", () => {
    const who = personAt(300);
    const op = BLADEBURNER_BLACK_OPS[0];
    const { cities, round: read, formula } = readOf(TRUTHS, who, op);
    // Volhaven's Black Op range clipped, as the game reads it once pop/popEst × the formula passes 1 (its high end 1:
    // only a bound, `populationRatioOfBlackOpRange`'s null), the others' as read.
    const round = {
      ...read,
      cities: read.cities.map((each) =>
        each.name === "Volhaven" ? { ...each, blackOp: [formula as number, 1] as [number, number] } : each,
      ),
    };
    const measures = bladeburnerCityMeasures(cities, round, formula, "New Tokyo") ?? [];
    const by = Object.fromEntries(measures.map((each) => [each.name, each.by]));
    expect(by.Volhaven).toBe("range");
    expect(by.Chongqing).toBe("recovered");
    expect(by["New Tokyo"]).toBe("recovered");
    // Volhaven's figure is its own range's (the live rule's ratio from New Tokyo, times New Tokyo's exact chance): for
    // every unclipped action in both, its chance over the draw (`actionChanceOverSpread`), as the ruling prices it.
    const measured = bladeburnerMeasuredCities(cities, measures);
    const tokyo = measured.find((each) => each.name === "New Tokyo") as BladeburnerCityReading;
    const volhaven = measured.find((each) => each.name === "Volhaven") as BladeburnerCityReading;
    const ratio = cityCompetenceRatio(tokyo, volhaven) as number;
    const own = (name: string) => round.cities.find((each) => each.name === name) as (typeof round.cities)[number];
    let compared = 0;
    for (const [k, action] of own("Volhaven").actions.entries()) {
      const there = action.chance;
      const here = own("New Tokyo").actions[k]?.chance as [number, number];
      if (!(there[0] > 0 && there[1] < 1 && here[0] > 0 && here[1] < 1) || action.name === "Raid") continue;
      const tokyoTrue = actionSuccessChance(
        BLADEBURNER_LEVELLED_ACTIONS[k] as (typeof BLADEBURNER_LEVELLED_ACTIONS)[number],
        1,
        who,
        { city: { population: 1.685e9, chaos: 19.8, communities: 60 }, penalty: 1 },
      );
      expect((tokyoTrue * ratio) / actionChanceOverSpread(there)).toBeCloseTo(1, 9);
      compared++;
    }
    expect(compared).toBeGreaterThan(3);
    // And off its truth by the draw's pricing, not by New Tokyo's ratio.
    expect(volhaven.population / 1.3e9).not.toBeCloseTo(1, 2);
  });

  test("the ruling's ½g(high) + ½g(low), each g on its half of the draw: #411's expectation over the spread", () => {
    // g on [1, 1.5] (the high end the estimate's: pop/popEst under 1) and on [0.5, 1] (the low end's), unclipped:
    // E[a U^−0.7 | U on [c, d]] = a (d^0.3 − c^0.3) / (0.3 (d − c)).
    const [a, b] = POPULATION_ESTIMATE_SPREAD;
    const g = (chance: number, c: number, d: number) => (chance * (d ** 0.3 - c ** 0.3)) / (0.3 * (d - c));
    for (const range of [
      [0.2, 0.3],
      [0.05, 0.08],
      [0.31, 0.4],
    ] as [number, number][]) {
      const closed = 0.5 * g(range[1], 1, b) + 0.5 * g(range[0], a, 1);
      expect(actionChanceOverSpread(range) / closed).toBeCloseTo(1, 4);
    }
    // The draw's mean factor (a city with every range clipped): E[U^−0.7]^(1/0.7).
    expect(BLADEBURNER_DRAW_RATIO).toBeCloseTo(((b ** 0.3 - a ** 0.3) / 0.3) ** (1 / 0.7), 12);
    expect(BLADEBURNER_DRAW_RATIO).toBeCloseTo(1.0824, 4);
  });

  test("every range clipped and none recovered: at the draw's mean; none read, null", () => {
    const who = personAt(100);
    const { cities, round } = readOf(TRUTHS, who, undefined);
    const clipped = {
      ...round,
      cities: round.cities.map((each) => ({
        ...each,
        actions: each.actions.map((action) => ({ ...action, chance: [1, 1] as [number, number] })),
      })),
    };
    const measures = bladeburnerCityMeasures(cities, clipped, null, "New Tokyo") ?? [];
    for (const [i, each] of measures.entries()) {
      expect(each.by).toBe("draw");
      expect(each.population).toBeCloseTo(
        (cities[i] as BladeburnerCityReading).population * BLADEBURNER_DRAW_RATIO,
        -2,
      );
    }
    expect(bladeburnerCityMeasures(cities, { cities: round.cities.slice(1) }, null, "New Tokyo")).toBeNull();
    expect(bladeburnerCityMeasures(cities, round, null, "Tokyo")).toBeNull();
  });

  test("one function (#420): B4's figure in each city is the drift's at the start (the walk's, the grown estimate's)", () => {
    const who = personAt(300);
    const { cities, round, formula } = readOf(TRUTHS, who, BLADEBURNER_BLACK_OPS[0]);
    const measured = bladeburnerMeasuredCities(
      cities,
      bladeburnerCityMeasures(cities, round, formula, "New Tokyo") ?? [],
    );
    const start = bladeburnerDriftStart(measured, "New Tokyo") as NonNullable<ReturnType<typeof bladeburnerDriftStart>>;
    const reference = start.cities[start.worked] as (typeof start.cities)[number];
    const here = measured.find((each) => each.name === "New Tokyo") as BladeburnerCityReading;
    const bounty = { action: { name: "Bounty Hunter" }, chance: 0.2 };
    for (const city of start.cities) {
      const live = 0.2 * (cityCompetenceRatio(here, city) as number);
      expect(driftedChance(bounty, reference, city) / Math.min(1, live)).toBeCloseTo(1, 12);
    }
  });
});
