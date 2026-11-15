/**
 * Bladeburner (#359), #420: each city at its own true population, measured. B4's choice and the drift's (the walk's,
 * the grown estimate's) price every city by the one function here, from the round over the six that `bladeburner-
 * city.js` makes at each reading (core's `BladeburnerCitiesRound`). Paths are `vendor/bitburner-src/src/`'s (v3.0.1),
 * under `Bladeburner/` unless named.
 * - **Why measured:** the game draws each city's estimate on its own, the true population × U, U uniform on [0.5, 1.5]
 *   (`City.ts:19-23`), and Field Analysis sharpens the current city's alone (`Bladeburner.ts:1141`). After it the
 *   population moves without the estimate: every population event and migration (`:564-587`, `:613-697`), Raid's
 *   failures (`:839-845`), and Investigation's and Undercover's (a migration, `:811`, `:820`); the kills' and Raid's,
 *   Sting's and Stealth Retirement's successes move both by the same count, not the same share (`City.ts:63-87`). So no
 *   city's pop/popEst carries over from another's, or from an earlier reading (#420's rulings 1 and 2): it's read.
 * - **The round** (ingame's ./workers/bladeburner-city.ts): `switchCity` to each, the next Black Op's range and each
 *   contract's and operation's read there, then back, with no `await` between, so no game time passes in it (a script's
 *   NS calls are synchronous, `Netscript/APIWrapper.ts:78-83`, and the game advances only in its own timer,
 *   `engine.tsx:441`, `:81-118`, `:199-206`): every range is the same instant's, at the same stamina and levels.
 * - **A city recovered** (#411's `populationRatioOfBlackOpRange`: a Black Op's chance has no population factor,
 *   `Actions/BlackOperation.ts:55-61`, so its range there is its chance and that × pop/popEst): the true population,
 *   the estimate × pop/popEst, exactly.
 * - **A city not recovered** (all 21 done, or that range clipped: only a bound): by its own actions' ranges, each
 *   priced over the game's draw (#411's `actionChanceOverSpread`: the estimate's chance is the high end where pop/popEst
 *   is under 1, U over 1, and the low end over it, each half the draw, so ½E[min(1, high × U^−0.7) | U > 1] + ½E[min(1,
 *   low × U^−0.7) | U < 1]: #420's ruling 2's ½g(high) + ½g(low), its g conditioned on the end, as the end fixes which
 *   half of U it is). Its true population is the one whose chance is that against a city priced exactly (the anchor:
 *   the chances go as pop^0.7 over the chaos's factor, `Actions/Action.ts:88-103`, the rest alike in every city at one
 *   instant), on the action furthest from the clip in both (no end at 0 or 1).
 * - **The anchor:** the division's city recovered, else the first recovered in the game's order; none, the division's
 *   city at the draw's mean factor (pop/popEst E[U^−0.7]^(1/0.7) = 1.082), labelled: then only the cities' ratios are
 *   measured, and the absolute scale only moves the events' +100 under 1.5e9 (`:619-620`, `data/Constants.ts`).
 * - **A city with every action's range clipped** there or in the anchor and not recovered: its chances don't move with
 *   its population while clipped, so it's taken at the draw's mean factor too, labelled ("draw").
 */
import type { BladeburnerCitiesRound } from "./bladeburner.ts";
import {
  actionChanceAtRatio,
  actionChanceOverSpread,
  type BladeburnerPerson,
  POPULATION_ESTIMATE_SPREAD,
  populationRatioOfBlackOpRange,
  staminaPenalty,
} from "./bladeburner-actions.ts";
import { blackOpSuccessChance, bladeburnerBlackOp } from "./bladeburner-black-ops.ts";
import type { BladeburnerCityReading } from "./bladeburner-cities.ts";
import { BLADEBURNER_CONSTANTS, chaosDifficultyFactor } from "./bladeburner-constants.ts";
import { type BladeburnerSkillLevels, bladeburnerSkillMultsOf } from "./bladeburner-skills.ts";

/** One city's round, as core's `BladeburnerCityRound` (re-declared here to keep the import one-way). */
interface CityRound {
  name: string;
  blackOp: readonly [number, number] | null;
  actions: readonly { type: string; name: string; chance: readonly [number, number] }[];
}

/** How a city's true population was had (#420). */
export type BladeburnerCityMeasureKind = "recovered" | "range" | "draw";

/** A city measured (#420): its pop/popEst recovered (null: not), how its population was had, and that population. */
export interface BladeburnerCityMeasure {
  name: string;
  ratio: number | null;
  by: BladeburnerCityMeasureKind;
  /** The true population the brain prices the city at: the estimate × pop/popEst recovered, else as `by` says. */
  population: number;
}

/**
 * pop/popEst at the draw's mean factor: E[U^−0.7]^(1/0.7), U uniform on the estimate's spread (`City.ts:23`), the
 * population's factor's mean over it: ((b^0.3 − a^0.3) / (0.3 (b − a)))^(1/0.7) = 1.0824 on [0.5, 1.5].
 */
export const BLADEBURNER_DRAW_RATIO: number = (() => {
  const [a, b] = POPULATION_ESTIMATE_SPREAD;
  const e = 1 - BLADEBURNER_CONSTANTS.populationExponent;
  return ((b ** e - a ** e) / (e * (b - a))) ** (1 / BLADEBURNER_CONSTANTS.populationExponent);
})();

/** Whether a range is clear of the clip at both ends: its chance then moves with the population. */
const unclipped = ([low, high]: readonly [number, number]) => low > 0 && high < 1;

/**
 * Each city at its own true population (#420), from the cities read (`cities`: the estimates, communities and chaos)
 * and the round (`round`), `formula` the round's Black Op's chance at the person (core's `blackOpSuccessChance`, its
 * stamina's penalty in: it only picks which end is the formula's, #411) or null (none: all done), and `city` the
 * division's. In the game's order of `cities`; null with a city of `cities` not in the round, or `city` not among them.
 */
export function bladeburnerCityMeasures(
  cities: readonly BladeburnerCityReading[],
  round: { cities: readonly CityRound[] },
  formula: number | null,
  city: string,
): BladeburnerCityMeasure[] | null {
  const rounds = cities.map((each) => round.cities.find((one) => one.name === each.name));
  if (rounds.some((each) => each === undefined) || !cities.some((each) => each.name === city)) return null;
  const read = rounds as CityRound[];
  const ratios = read.map((each) =>
    each.blackOp === null || formula === null ? null : populationRatioOfBlackOpRange(each.blackOp, formula),
  );
  // Each action's chance there at the true population: exact where recovered, else over the draw (#411's).
  const priced = read.map((each, i) =>
    each.actions.map((action) => {
      const ratio = ratios[i];
      return ratio === null || ratio === undefined
        ? actionChanceOverSpread(action.chance)
        : (actionChanceAtRatio(action.chance, ratio) ?? actionChanceOverSpread(action.chance));
    }),
  );
  const own = cities.findIndex((each) => each.name === city);
  const recoveredFirst = [own, ...cities.map((_, i) => i).filter((i) => i !== own)].find((i) => ratios[i] != null);
  const anchor = recoveredFirst ?? own;
  const estimate = (i: number) => (cities[i] as BladeburnerCityReading).population;
  const anchorRatio = ratios[anchor];
  const anchorPopulation = estimate(anchor) * (anchorRatio ?? BLADEBURNER_DRAW_RATIO);
  const { populationExponent } = BLADEBURNER_CONSTANTS;
  return cities.map((each, i): BladeburnerCityMeasure => {
    const ratio = ratios[i] ?? null;
    if (ratio !== null) return { name: each.name, ratio, by: "recovered", population: each.population * ratio };
    if (i === anchor) return { name: each.name, ratio: null, by: "draw", population: anchorPopulation };
    // By its own ranges against the anchor's: the action furthest from the clip in both (the least high end), Raid
    // only where both have communities (none: its chance 0, `Actions/Operation.ts:63-68`).
    const there = read[i] as CityRound;
    const at = read[anchor] as CityRound;
    let best = -1;
    let least = Number.POSITIVE_INFINITY;
    for (const [k, action] of there.actions.entries()) {
      const theirs = at.actions.find((one) => one.type === action.type && one.name === action.name);
      if (theirs === undefined || !unclipped(action.chance) || !unclipped(theirs.chance)) continue;
      if (
        action.name === "Raid" &&
        !(each.communities > 0 && (cities[anchor] as BladeburnerCityReading).communities > 0)
      )
        continue;
      const high = Math.max(action.chance[1], theirs.chance[1]);
      if (high < least) {
        least = high;
        best = k;
      }
    }
    if (best < 0)
      return { name: each.name, ratio: null, by: "draw", population: each.population * BLADEBURNER_DRAW_RATIO };
    const action = there.actions[best] as CityRound["actions"][number];
    const k = at.actions.findIndex((one) => one.type === action.type && one.name === action.name);
    const chanceThere = priced[i]?.[best] as number;
    const chanceAnchor = priced[anchor]?.[k] as number;
    const factor =
      (chanceThere / chanceAnchor) *
      (chaosDifficultyFactor(each.chaos) / chaosDifficultyFactor((cities[anchor] as BladeburnerCityReading).chaos));
    return {
      name: each.name,
      ratio: null,
      by: "range",
      population: anchorPopulation * factor ** (1 / populationExponent),
    };
  });
}

/**
 * The cities measured from a reading (#420): `bladeburnerCityMeasures` with the round's Black Op's formula at the
 * person and skills read and the stamina's penalty (`input`'s, as #411's `bladeburnerPricedInput`), or null without a
 * round or with it not the six's.
 */
export function bladeburnerRoundMeasures(
  input: { person: BladeburnerPerson; stamina: number; maxStamina: number; skills?: { read?: BladeburnerSkillLevels } },
  { cities, round, city }: { cities: readonly BladeburnerCityReading[]; round: BladeburnerCitiesRound; city: string },
): BladeburnerCityMeasure[] | null {
  const op = round.blackOp === null ? null : bladeburnerBlackOp(round.blackOp);
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const formula =
    op === null
      ? null
      : blackOpSuccessChance(op, input.person, { penalty, skills: bladeburnerSkillMultsOf(input.skills?.read ?? {}) });
  return bladeburnerCityMeasures(cities, round, formula, city);
}

/** The cities read at their measured true populations (#420): what B4, the walk and the grown estimate price. */
export function bladeburnerMeasuredCities<T extends BladeburnerCityReading>(
  cities: readonly T[],
  measures: readonly BladeburnerCityMeasure[],
): T[] {
  return cities.map((each) => {
    const measure = measures.find((one) => one.name === each.name);
    return measure === undefined ? { ...each } : { ...each, population: measure.population };
  });
}
