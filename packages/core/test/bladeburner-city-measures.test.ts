// Bladeburner #420: each city at its own true population, from the round over the six. The round built here as the
// game reads it (`Actions/Action.ts:144-167`'s range at each city's own population and estimate, a Black Op's with no
// population factor, `Actions/BlackOperation.ts:55-61`): every city recovered at its truth exactly, from the Black
// Op's range or (#420's ruling 4) any contract's or operation's not clipped, the two roots and the estimate's chance
// picking, ranges that disagree said; the spread's ½g(high) + ½g(low) (#411's `actionChanceOverSpread`) where every
// range clips, at the draw's mean; and B4's figure (the live rule's ratio) and the drift's (the walk's and the grown
// estimate's chance at the start) the same function's.
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
  BLADEBURNER_BRANCH_BAND,
  BLADEBURNER_DRAW_RATIO,
  BLADEBURNER_RANGE_AGREEMENT,
  type BladeburnerCityMeasure,
  bladeburnerCityMeasures,
  bladeburnerMeasuredCities,
  bladeburnerRangesDisagree,
  bladeburnerRoundMeasures,
  populationRatioOfActionRange,
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
            level: 1,
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

  test("its Black Op's range clipped (#420's ruling 4): recovered from its contracts' and operations', exactly", () => {
    const who = personAt(100);
    const op = BLADEBURNER_BLACK_OPS[0];
    const { cities, round: read } = readOf(TRUTHS, who, op);
    // Volhaven's Black Op range clipped, as the game reads it once pop/popEst × the formula passes 1 (its high end 1:
    // only a bound, `populationRatioOfBlackOpRange`'s null), the others' as read.
    const formula = blackOpSuccessChance(op as NonNullable<typeof op>, who, { penalty: 1 });
    const round = {
      ...read,
      cities: read.cities.map((each) =>
        each.name === "Volhaven" ? { ...each, blackOp: [formula, 1] as [number, number] } : each,
      ),
    };
    const measures = bladeburnerRoundMeasures(
      { person: who, stamina: 100, maxStamina: 100 },
      {
        cities,
        round,
        city: "New Tokyo",
      },
    ) as BladeburnerCityMeasure[];
    for (const [i, truth] of TRUTHS.entries()) {
      const measure = measures[i] as BladeburnerCityMeasure;
      expect(measure.by, truth.name).toBe("recovered");
      expect(measure.ratio, truth.name).toBeCloseTo(truth.ratio, 9);
      // Every range not clipped agrees to 1e-9 (Ishima's Raid at 0, no communities, clipped).
      expect(measure.disagreement, truth.name).toBeLessThan(BLADEBURNER_RANGE_AGREEMENT);
    }
    const volhaven = measures.find((each) => each.name === "Volhaven") as BladeburnerCityMeasure;
    // Its first range not clipped, in core's order (Tracking's high end clips at pop/popEst 1.9 here).
    expect(volhaven.source).toBe("Bounty Hunter");
    expect(volhaven.ranges).toBeGreaterThan(5);
    // Its actions alone (all on one g): the branch by the estimate's pick, its bound the other root's distance; the
    // others by the Black Op's and the actions' agreeing (#422's round 2).
    expect(volhaven.pickedBy).toBe("estimate");
    expect(volhaven.rootGap).toBeGreaterThan(1);
    expect(measures.find((each) => each.name === "Aevum")?.pickedBy).toBe("agreement");
    expect(measures.find((each) => each.name === "Aevum")?.source).toBe("the Black Op");
    expect(bladeburnerRangesDisagree(measures)).toBeNull();
  });

  test("an action's range (#420's ruling 4): both roots, the estimate's chance picking; clipped, none", () => {
    // `Action.ts:149-164` by hand: est 0.3 at the estimate, real est × r^0.7, then real ± |real − est|, × r at one end.
    const rangeAt = (est: number, r: number) => {
      const real = est * r ** 0.7;
      return actionSuccessRange(real, est, r, 1);
    };
    for (const r of [0.4, 0.7, 0.95, 1, 1.05, 1.6, 2]) {
      const range = rangeAt(0.2, r);
      expect(populationRatioOfActionRange(range, 0.2), `r ${r}`).toBeCloseTo(r, 12);
      // The estimate's own chance a little off (a reading apart): the same root.
      expect(populationRatioOfActionRange(range, 0.2 * 1.05), `r ${r}`).toBeCloseTo(r, 12);
    }
    // The two roots a range fits: at 0.7 the low end is est·g(0.7); the same range read as r > 1 (the low end the
    // estimate's) gives g(r) = high / low. The estimate's chance names which.
    const range = rangeAt(0.3, 0.7);
    const other = populationRatioOfActionRange(range, range[0]) as number;
    expect(other).toBeGreaterThan(1);
    expect((2 * other ** 0.7 - 1) * other).toBeCloseTo(range[1] / range[0], 12);
    // Clipped: the low end at 0 (r under 0.5^(1/0.7)), the high end at 1, or no estimate's chance.
    expect(populationRatioOfActionRange(rangeAt(0.3, 0.3), 0.3)).toBeNull();
    expect(populationRatioOfActionRange(rangeAt(0.8, 1.9), 0.8)).toBeNull();
    expect(populationRatioOfActionRange(rangeAt(0.3, 0.7), null)).toBeNull();
  });

  test("near r 1 (bn6-skills' Ishima, as the game read it): the branch the Black Op's and the actions' agree on", () => {
    // Its pop/popEst 1.0008: the two roots 0.9992 and 1.0008 are 0.16% apart, within the estimate's own error a reading
    // apart, so neither #411's formula nor an action's estimate picks reliably; the Black Op's range (low/high or
    // high/low) and the actions' (g's roots) agree only on the true branch.
    const ishima = { name: "Ishima", population: 904705522.9582219, communities: 106, chaos: 0 };
    const ranges: [string, [number, number]][] = [
      ["Tracking", [0.4926184024421465, 0.4935581763493826]],
      ["Bounty Hunter", [0.3089613194876021, 0.30955072862246236]],
      ["Investigation", [0.09220042533177157, 0.09237631716515277]],
      ["Sting Operation", [0.05037168058326019, 0.050467775229422626]],
      ["Raid", [0.06719563850519497, 0.06732382841331493]],
    ];
    const round = {
      cities: [
        {
          name: "Ishima",
          blackOp: [0.02871135012239487, 0.028734163210189616] as [number, number],
          actions: ranges.map(([name, chance]) => ({ type: "Contracts", name, level: 1, chance })),
        },
      ],
    };
    // The estimate's chance put at the low end for the Black Op and at the high end for every action: a wrong pick
    // either way, which the branch's agreement overrules.
    const measures = bladeburnerCityMeasures([ishima], round, 0.0287341, "Ishima", (_action) => 0.5) ?? [];
    expect(measures[0]?.ratio).toBeCloseTo(1.000794567, 8);
    expect(measures[0]?.disagreement).toBeLessThan(BLADEBURNER_RANGE_AGREEMENT);
    expect(measures[0]?.ranges).toBe(6);
  });

  test("the agreement bar from the float error, and the band near r 1 (#422's round 2)", () => {
    // 256 unit roundoffs, 2.8e-14; the wrong branch's parting 0.408 (ln r)² passes it where |ln r| > 2.6e-7.
    expect(BLADEBURNER_RANGE_AGREEMENT).toBeCloseTo(2.842e-14, 16);
    expect(BLADEBURNER_BRANCH_BAND).toBeCloseTo(2.64e-7, 9);
    // The parting on the wrong branch against its expansion, by hand at r 1 + 1e-3 and 1 − 1e-2: the Black Op's root
    // (1/r) against an action's (g's root of 1/g(r)).
    for (const r of [1.001, 0.99, 1.0008]) {
      const g = (x: number) => (2 * x ** 0.7 - 1) * x;
      const wrong = populationRatioOfActionRange(
        actionSuccessRange(0.2 * r ** 0.7, 0.2, r, 1),
        r > 1 ? actionSuccessRange(0.2 * r ** 0.7, 0.2, r, 1)[1] : actionSuccessRange(0.2 * r ** 0.7, 0.2, r, 1)[0],
      ) as number;
      // That root is the action's on the wrong branch: g(wrong) = the range's other ratio.
      expect(g(wrong) > 0).toBe(true);
      const parting = Math.abs(Math.log(wrong) - Math.log(1 / r));
      expect(parting / Math.log(r) ** 2).toBeCloseTo((2 * 0.49) / 2.4, 2);
      expect(parting).toBeGreaterThan(BLADEBURNER_RANGE_AGREEMENT);
    }
  });

  test("ranges that disagree (#420's ruling 4): the most off is said, past the float error's bar", () => {
    const who = personAt(100);
    const { cities, round: read } = readOf(TRUTHS, who);
    // Aevum's Tracking range from a population 1% off its others': the model off somewhere.
    const off = {
      ...read,
      cities: read.cities.map((each) =>
        each.name !== "Aevum"
          ? each
          : {
              ...each,
              actions: each.actions.map((action) =>
                action.name !== "Tracking"
                  ? action
                  : { ...action, chance: [action.chance[0] * 1.01, action.chance[1]] as [number, number] },
              ),
            },
      ),
    };
    const measures = bladeburnerRoundMeasures(
      { person: who, stamina: 100, maxStamina: 100 },
      {
        cities,
        round: off,
        city: "New Tokyo",
      },
    ) as BladeburnerCityMeasure[];
    const disagree = bladeburnerRangesDisagree(measures);
    expect(disagree?.name).toBe("Aevum");
    expect(disagree?.disagreement).toBeGreaterThan(1e-3);
    // The Black Op's first: Aevum still at its own.
    expect(measures.find((each) => each.name === "Aevum")?.ratio).toBeCloseTo(0.8, 9);
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
