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
 *   contract's and operation's range and level read there, then back, with no `await` between, so no game time passes
 *   in it (a script's NS calls are synchronous, `Netscript/APIWrapper.ts:78-83`, and the game advances only in its own
 *   timer, `engine.tsx:441`, `:81-118`, `:199-206`): every range is the same instant's, at the same stamina and levels.
 * - **pop/popEst from any range not clipped** (#420's ruling 4), the Black Op's first (#411's: no population factor,
 *   `Actions/BlackOperation.ts:55-61`, so low/high or high/low), then each contract's and operation's
 *   (`populationRatioOfActionRange`'s two roots); the branch, under 1 or over, the one where the Black Op's and the
 *   actions' agree, else the estimate's own chance's (`bladeburnerCityMeasures`); each that isn't clipped must give the
 *   same r to 1e-9 (`disagreement`, the `bladeburnerCityRound` alert's past it: the model off). The true population is
 *   then the estimate × r, exactly.
 * - **The spread only where every range in the city clips** (#420's ruling 4; all 21 done, the Black Op's at 1, every
 *   action's at 0 or 1): its chances then don't move with its population, so it's taken at the draw's mean factor
 *   (pop/popEst E[U^−0.7]^(1/0.7) = 1.0824, `BLADEBURNER_DRAW_RATIO`: the factor's expectation over the spread),
 *   labelled ("draw"); the run report counts each.
 */
import type { BladeburnerCitiesRound } from "./bladeburner.ts";
import {
  actionSuccessChance,
  type BladeburnerPerson,
  bladeburnerLevelledAction,
  POPULATION_ESTIMATE_SPREAD,
  staminaPenalty,
} from "./bladeburner-actions.ts";
import { blackOpSuccessChance, bladeburnerBlackOp } from "./bladeburner-black-ops.ts";
import type { BladeburnerCityReading } from "./bladeburner-cities.ts";
import { BLADEBURNER_CONSTANTS } from "./bladeburner-constants.ts";
import { type BladeburnerSkillLevels, bladeburnerSkillMultsOf } from "./bladeburner-skills.ts";

/** One city's round, as core's `BladeburnerCityRound` (re-declared here to keep the import one-way). */
interface CityRound {
  name: string;
  blackOp: readonly [number, number] | null;
  actions: readonly { type: string; name: string; level?: number; chance: readonly [number, number] }[];
}

/** How a city's true population was had (#420): recovered from a range, or at the draw's mean (every range clipped). */
export type BladeburnerCityMeasureKind = "recovered" | "draw";

/** A city measured (#420): its pop/popEst recovered (null: not), how, and its true population. */
export interface BladeburnerCityMeasure {
  name: string;
  ratio: number | null;
  by: BladeburnerCityMeasureKind;
  /** The range r was had from: "the Black Op", or the contract's or operation's name; null at the draw. */
  source: string | null;
  /** The ranges not clipped that gave r, and the most any's r is off the first's (relative; 0 with one). */
  ranges: number;
  disagreement: number;
  /** The true population the brain prices the city at: the estimate × pop/popEst recovered, else at the draw's mean. */
  population: number;
}

/** How far the ranges not clipped in a city may give different r and still agree (#420's ruling 4): 1e-9. */
export const BLADEBURNER_RANGE_AGREEMENT = 1e-9;

/**
 * pop/popEst at the draw's mean factor: E[U^−0.7]^(1/0.7), U uniform on the estimate's spread (`City.ts:23`), the
 * population's factor's mean over it: ((b^0.3 − a^0.3) / (0.3 (b − a)))^(1/0.7) = 1.0824 on [0.5, 1.5].
 */
export const BLADEBURNER_DRAW_RATIO: number = (() => {
  const [a, b] = POPULATION_ESTIMATE_SPREAD;
  const e = 1 - BLADEBURNER_CONSTANTS.populationExponent;
  return ((b ** e - a ** e) / (e * (b - a))) ** (1 / BLADEBURNER_CONSTANTS.populationExponent);
})();

/** g(r) = (2r^0.7 − 1)·r: the far end of an action's range over its estimate's end, at pop/popEst r. */
function farEnd(r: number): number {
  return (2 * r ** BLADEBURNER_CONSTANTS.populationExponent - 1) * r;
}

/** The r in [from, to] where `farEnd` is `q` (it rises on r > 0.174: g′ = 3.4r^0.7 − 1), by bisection to the bit. */
function farEndRoot(q: number, from: number, to: number): number {
  let low = from;
  let high = to;
  for (let step = 0; step < 200 && high - low > Number.EPSILON * high; step++) {
    const middle = (low + high) / 2;
    if (farEnd(middle) < q) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * pop/popEst from a contract's or operation's range read (#420's ruling 4), or null where it's clipped (an end at 0
 * or 1: only a bound) or `estimate` is null. The game's range (`Actions/Action.ts:149-164`): est and real the chances
 * at the estimate and the truth (`:169-196`; real = est × r^0.7 unclipped, the population factor `:88-92`, the rest
 * alike), real ± |real − est|, the low end × r under 1, the high end × r over it. So:
 * - r < 1 (real under est): the high end real + (est − real) = est, the low end (2·real − est)·r = est·g(r);
 * - r > 1 (real over est): the low end real − (real − est) = est, the high end (2·real − est)·r = est·g(r);
 * - r = 1: both est.
 * g(r) = (2r^0.7 − 1)·r rises on r > 0.174, so low/high = g(r) has one root in (0.5^(1/0.7), 1) (g there from 0 to
 * 1; under 0.5^(1/0.7) = 0.371 the low end clips at 0) and high/low = g(r) one over 1: two roots fit any range. The
 * estimate's own chance picks: it is the high end for the root under 1 and the low end for the root over it, so the
 * end nearer `estimate` in log ratio (the brain's chance at popEst, the chaos and the person, core's
 * `actionSuccessChance`; a reading apart in its stamina or levels moves it a little, not across the two ends, which
 * are g(r) apart) names the root. Unclipped, est and real are both under 1 (the high end est or above real), so the
 * formula holds unclamped.
 */
export function populationRatioOfActionRange(range: readonly [number, number], estimate: number | null): number | null {
  const [low, high] = range;
  const roots = actionRangeRoots(range);
  if (roots === null || estimate === null || !(estimate > 0)) return null;
  const estIsHigh = Math.abs(Math.log(high / estimate)) <= Math.abs(Math.log(low / estimate));
  return estIsHigh ? roots.below : roots.above;
}

/** Whether a range is clear of the clip at both ends (0 < low ≤ high < 1): it then gives r on either branch. */
const unclipped = ([low, high]: readonly [number, number]) => low > 0 && high < 1 && high >= low;

/** An action's range's two roots (`populationRatioOfActionRange`): r under 1 and over 1, or null clipped. */
function actionRangeRoots(range: readonly [number, number]): { below: number; above: number } | null {
  if (!unclipped(range)) return null;
  const [low, high] = range;
  if (low === high) return { below: 1, above: 1 };
  const floor = 0.5 ** (1 / BLADEBURNER_CONSTANTS.populationExponent);
  return { below: farEndRoot(low / high, floor, 1), above: farEndRoot(high / low, 1, Math.max(2, high / low)) };
}

/**
 * Each city at its own true population (#420), from the cities read (`cities`: the estimates, communities and chaos)
 * and the round (`round`): `formula` the round's Black Op's chance at the person (core's `blackOpSuccessChance`, its
 * stamina's penalty in: it only picks which end is the formula's, #411) or null (none: all done), and `estimateOf` an
 * action's chance at a city's estimate (`actionSuccessChance` at popEst: it only picks the root,
 * `populationRatioOfActionRange`), null where it can't be had. In the game's order of `cities`; null with a city of
 * `cities` not in the round, or `city` (the division's) not among them.
 */
export function bladeburnerCityMeasures(
  cities: readonly BladeburnerCityReading[],
  round: { cities: readonly CityRound[] },
  formula: number | null,
  city: string,
  estimateOf: (
    action: { type: string; name: string; level?: number },
    at: BladeburnerCityReading,
  ) => number | null = () => null,
): BladeburnerCityMeasure[] | null {
  const rounds = cities.map((each) => round.cities.find((one) => one.name === each.name));
  if (rounds.some((each) => each === undefined) || !cities.some((each) => each.name === city)) return null;
  return cities.map((each, i): BladeburnerCityMeasure => {
    const read = rounds[i] as CityRound;
    // Every range not clipped, the Black Op's first, then each contract's and operation's in core's order, each with
    // its r on both branches (under 1 and over it).
    const both: { source: string; below: number; above: number; estimateIsHigh: boolean | null }[] = [];
    const bo = read.blackOp;
    if (bo !== null && unclipped(bo)) {
      // #411's: its chance at one end, that × r at the other (no population factor, `Actions/BlackOperation.ts:55-61`).
      const formulaIsHigh =
        formula === null ? null : Math.abs(Math.log(bo[1] / formula)) <= Math.abs(Math.log(bo[0] / formula));
      both.push({ source: "the Black Op", below: bo[0] / bo[1], above: bo[1] / bo[0], estimateIsHigh: formulaIsHigh });
    }
    for (const action of read.actions) {
      const roots = actionRangeRoots(action.chance);
      if (roots === null) continue;
      const estimate = estimateOf(action, each);
      const estimateIsHigh =
        estimate === null || !(estimate > 0)
          ? null
          : Math.abs(Math.log(action.chance[1] / estimate)) <= Math.abs(Math.log(action.chance[0] / estimate));
      both.push({ source: action.name, ...roots, estimateIsHigh });
    }
    // The branch (#420's ruling 4, #422's measure): the Black Op's range gives r as low/high or high/low, an action's as
    // g's root of the same, so with both read only the true branch has them agree (off it they part at second order
    // in r − 1: Ishima at r 1.0008 in bn6-skills, 2.6e−7 on the wrong branch against 1e−11 on the right). With one
    // kind alone, the estimate's own chance picks (#411's formula for the Black Op; for actions, the one whose ends are
    // furthest apart): near r 1 the two ends are within the estimate's own error of each other, so its pick can err,
    // but its two roots are then as near (Ishima's 0.9992 and 1.0008).
    const spread = (branch: "below" | "above") => {
      const first = both[0]?.[branch] ?? 1;
      return Math.max(0, ...both.map((one) => Math.abs(one[branch] / first - 1)));
    };
    const hasOp = both[0]?.source === "the Black Op";
    const kinds = hasOp && both.length > 1;
    const widest = [...both]
      .sort((a, b) => b.above / b.below - a.above / a.below)
      .find((one) => one.estimateIsHigh !== null);
    const branch: "below" | "above" | null = kinds
      ? spread("below") <= spread("above")
        ? "below"
        : "above"
      : hasOp && both[0]?.estimateIsHigh != null
        ? both[0].estimateIsHigh
          ? "below"
          : "above"
        : widest === undefined
          ? null
          : widest.estimateIsHigh
            ? "below"
            : "above";
    const found = branch === null ? [] : both.map((one) => ({ source: one.source, ratio: one[branch] }));
    const first = found[0];
    if (first === undefined) {
      return {
        name: each.name,
        ratio: null,
        by: "draw",
        source: null,
        ranges: 0,
        disagreement: 0,
        population: each.population * BLADEBURNER_DRAW_RATIO,
      };
    }
    const disagreement = Math.max(0, ...found.map((one) => Math.abs(one.ratio / first.ratio - 1)));
    return {
      name: each.name,
      ratio: first.ratio,
      by: "recovered",
      source: first.source,
      ranges: found.length,
      disagreement,
      population: each.population * first.ratio,
    };
  });
}

/**
 * The cities measured from a reading (#420): `bladeburnerCityMeasures` with the round's Black Op's formula and each
 * action's estimate's chance at the person and skills read and the stamina's penalty (`input`'s, as #411's
 * `bladeburnerPricedInput`), or null without a round or with it not the six's.
 */
export function bladeburnerRoundMeasures(
  input: { person: BladeburnerPerson; stamina: number; maxStamina: number; skills?: { read?: BladeburnerSkillLevels } },
  { cities, round, city }: { cities: readonly BladeburnerCityReading[]; round: BladeburnerCitiesRound; city: string },
): BladeburnerCityMeasure[] | null {
  const op = round.blackOp === null ? null : bladeburnerBlackOp(round.blackOp);
  const penalty = input.maxStamina > 0 ? staminaPenalty(input.stamina, input.maxStamina) : 0;
  const skills = bladeburnerSkillMultsOf(input.skills?.read ?? {});
  const formula = op === null ? null : blackOpSuccessChance(op, input.person, { penalty, skills });
  return bladeburnerCityMeasures(cities, round, formula, city, (action, at) => {
    const levelled = bladeburnerLevelledAction(action.type, action.name);
    if (levelled === null || action.level === undefined || !(penalty > 0)) return null;
    return actionSuccessChance(levelled, action.level, input.person, {
      city: { population: at.population, chaos: at.chaos, communities: at.communities },
      penalty,
      skills,
    });
  });
}

/** The most any city's ranges not clipped are off each other (#420's ruling 4), or null where all agree. */
export function bladeburnerRangesDisagree(
  measures: readonly BladeburnerCityMeasure[],
): { name: string; disagreement: number } | null {
  const worst = measures.reduce<BladeburnerCityMeasure | null>(
    (most, each) => (most === null || each.disagreement > most.disagreement ? each : most),
    null,
  );
  return worst !== null && worst.disagreement > BLADEBURNER_RANGE_AGREEMENT
    ? { name: worst.name, disagreement: worst.disagreement }
    : null;
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
