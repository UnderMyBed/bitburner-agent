/**
 * Bladeburner (#359), slice B4 (#383): the cities and the chaos. The game's six cities, its formulas for the chaos and
 * the population on an action's success, Diplomacy and Incite Violence, and the rule's choices by B2's forecast of rank
 * a second (./bladeburner-actions.ts's `chooseBladeburnerAction`). Paths are `vendor/bitburner-src/src/`'s (v3.0.1),
 * under `Bladeburner/` unless named.
 * - **The cities:** the six (`Locations/Enums.ts:70-77`), each with its own population, estimate, communities and
 *   chaos (`City.ts:8-28`); the division works in one, Sector-12 at first (`Bladeburner.ts:116`), whose figures an
 *   action reads (`getCurrentCity`, `:163-165`). Switching is free and stops nothing (`switchCity`,
 *   `NetscriptFunctions/Bladeburner.ts:316-321`): it isn't the player's city, so no travel.
 * - **Population:** an action's competence × (pop / 1e9)^0.7, the true population for the real chance and the estimate
 *   for the estimated (`Actions/Action.ts:88-92`; core's `populationSuccessFactor`). The API gives the estimate alone
 *   (`getCityEstimatedPopulation`, `NetscriptFunctions/Bladeburner.ts:297-301`); the true one only the page shows.
 * - **Chaos:** over 50, an action's difficulty × √(1 + chaos − 50) (`Actions/Action.ts:94-103`; core's
 *   `chaosDifficultyFactor`). It falls 0.0001 a second in every city, before the action's progress (`Bladeburner.ts:
 *   1395-1401`), never under 0.
 * - **Diplomacy** (60 s, no stamina, `data/GeneralActions.ts:37-44`): the city's chaos × (1 − p/100), p =
 *   charisma^0.045 + charisma/1,000, the charisma level as it is (`Bladeburner.ts:737-745`, `:1187-1198`, `City.ts:
 *   31-33`).
 * - **Incite Violence** (60 s, no stamina, `data/GeneralActions.ts:52-60`): each contract's and operation's count
 *   + 180 × its growth / 480 (`Bladeburner.ts:1221-1227`; its growth a random tenth over its range, `data/
 *   Contracts.ts`, `data/Operations.ts`), and every city's chaos + 10, then + chaos / log10(chaos) (`:1229-1233`,
 *   `City.ts:89-91`).
 * Left out, and labelled: the random events every 240–600 s (`:601-699`: populations, communities and riots' chaos),
 * read, not forecast; the chaos and population the actions themselves move (`:803-890`: Raid's +1–5% chaos, Sting's
 * +0.1, Stealth Retirement's −1–3%, the kills' population), read, not forecast; the estimate's accuracy (Field
 * Analysis, Tracking, Investigation, Undercover and Datamancer sharpen it, `City.ts:35-58`), which raises the low end
 * the rule reads, not the true chance.
 */
import {
  BLADEBURNER_CONSTANTS,
  type BladeburnerActionPlan,
  type BladeburnerLevelledAction,
  bladeburnerLevelledAction,
  chaosDifficultyFactor,
  chooseBladeburnerAction,
  countGrowthPerSecond,
} from "./bladeburner-actions.ts";

/** The six cities, by the game's names (`Locations/Enums.ts:70-77`). */
export const BLADEBURNER_CITIES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"] as const;
export type BladeburnerCityName = (typeof BLADEBURNER_CITIES)[number];

/** Whether `name` is one of the six. */
export function isBladeburnerCity(name: unknown): name is BladeburnerCityName {
  return typeof name === "string" && (BLADEBURNER_CITIES as readonly string[]).includes(name);
}

/** The general actions on the chaos (`Bladeburner/Enums.ts`), and their time (`data/GeneralActions.ts:39`, `:54`). */
export const DIPLOMACY = "Diplomacy";
export const INCITE_VIOLENCE = "Incite Violence";
export type BladeburnerChaosActionName = typeof DIPLOMACY | typeof INCITE_VIOLENCE;
export const BLADEBURNER_CHAOS_ACTION_SECONDS = 60;

/** The chaos's fall a second, every city's (`Bladeburner.ts:1398`). */
export const CHAOS_DECAY_PER_SECOND = 0.0001;

/** A city as the worker reads it: its population estimate, communities and chaos (`NetscriptFunctions/Bladeburner.ts:297-311`). */
export interface BladeburnerCityReading {
  name: string;
  /** `getCityEstimatedPopulation`: the estimate, not the true population. */
  population: number;
  communities: number;
  chaos: number;
}

/** Diplomacy's fall, in percent of the chaos: charisma^0.045 + charisma/1,000 (`Bladeburner.ts:737-745`). */
export function diplomacyPercent(charisma: number): number {
  return charisma ** 0.045 + charisma / 1e3;
}

/** The chaos after a Diplomacy: chaos × (1 − p/100), at least 0 (`Bladeburner.ts:1187-1198`, `City.ts:31-33`). */
export function chaosAfterDiplomacy(chaos: number, charisma: number): number {
  return Math.max(0, chaos * (1 - diplomacyPercent(charisma) / 100));
}

/** Diplomacies to bring `chaos` to 50 or under, none at it (the decay meanwhile left out: it only shortens it). */
export function diplomaciesTo50(chaos: number, charisma: number): number {
  const { chaosThreshold } = BLADEBURNER_CONSTANTS;
  const keep = 1 - diplomacyPercent(charisma) / 100;
  if (!(chaos > chaosThreshold)) return 0;
  // A fall of 100% or more takes it to 0 at once (charisma near 99,000).
  if (!(keep > 0)) return 1;
  return Math.max(1, Math.ceil(Math.log(chaosThreshold / chaos) / Math.log(keep)));
}

/**
 * A city's chaos after an Incite Violence: + 10, then + chaos / log10(chaos), each at least 0 (`Bladeburner.ts:
 * 1229-1233`, `City.ts:89-91`).
 */
export function chaosAfterIncite(chaos: number): number {
  const raised = Math.max(0, chaos + 10);
  return Math.max(0, raised + raised / Math.log10(raised));
}

/** An Incite Violence's mean count added to `action`: 180 s of its mean growth (`Bladeburner.ts:1221-1227`). */
export function inciteCountGain(action: BladeburnerLevelledAction): number {
  return 3 * BLADEBURNER_CHAOS_ACTION_SECONDS * countGrowthPerSecond(action);
}

/**
 * What an action's competence in city `to` is over that in `from`, the difficulty's chaos factor folded in, by their
 * estimates: (estimate to / estimate from)^0.7 × chaosFactor(from) / chaosFactor(to) (`Actions/Action.ts:88-103`). The
 * game's range scales with it while neither end is clamped (#375's `chanceLowAt`); by the estimates, not the true
 * populations (the API's): so it takes `to`'s estimate as far off its truth as `from`'s, labelled. Null with `from`'s
 * estimate not above 0.
 */
export function cityCompetenceRatio(
  from: { population: number; chaos: number },
  to: { population: number; chaos: number },
): number | null {
  if (!(from.population > 0)) return null;
  const { populationExponent } = BLADEBURNER_CONSTANTS;
  return (
    (Math.max(0, to.population) / from.population) ** populationExponent *
    (chaosDifficultyFactor(from.chaos) / chaosDifficultyFactor(to.chaos))
  );
}

/**
 * The rank lost to the chaos between `from` and `to` (#383), against `baseline` a second: (1/0.0001) ∫ max(0, baseline
 * − rate(x)) dx over the chaos above 50 in [from, to]. It's what a chaos raised from `from` to `to` costs while the decay
 * brings it back: the path from `to` is the path from `from` delayed by (to − from)/0.0001 s, over which the rate is
 * rate(x) at each chaos x passed (`Bladeburner.ts:1395-1401`). Simpson's rule in u = √(x − 49), the chaos factor
 * (`Actions/Action.ts:94-103`), 8 intervals: exact where the rate goes as a + b/u, as B2's forecast does with its chances
 * unclamped (the work's success over the chaos factor, the rest's rank fixed).
 */
export function chaosRankLoss(rate: (chaos: number) => number, baseline: number, from: number, to: number): number {
  const { chaosThreshold } = BLADEBURNER_CONSTANTS;
  const a = Math.max(from, chaosThreshold);
  const b = Math.max(to, chaosThreshold);
  if (!(b > a)) return 0;
  const intervals = 8;
  const low = Math.sqrt(a - chaosThreshold + 1);
  const high = Math.sqrt(b - chaosThreshold + 1);
  const step = (high - low) / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i++) {
    const u = low + i * step;
    const weight = i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2;
    const chaos = chaosThreshold - 1 + u * u;
    sum += weight * Math.max(0, baseline - rate(chaos)) * 2 * u;
  }
  return (sum * step) / 3 / CHAOS_DECAY_PER_SECOND;
}

/**
 * The rank a second Diplomacy or Incite Violence forgoes in `plan`'s cycle of work and rest (#383). Neither costs
 * stamina, and the regain goes on through them (`Bladeburner.ts:1319-1327`), so a second of either saves the cycle
 * regain/g of a second of its rest (g its rest's stamina a second), which the cycle then spends at its own rate R rather
 * than the rest's b: it forgoes R − regain·(R − b)/g, b where the rest is Field Analysis (g the regain), at least 0.
 * With no rest in it (worked all the time, or resting alone), the cycle's rate.
 */
export function chaosActionForgone(plan: BladeburnerActionPlan): number {
  const { work, duty, rest, regain, rankPerSecond } = plan;
  if (work === null || !(duty < 1) || !(rest.staminaPerSecond > 0)) return rankPerSecond;
  return Math.max(0, rankPerSecond - (regain * (rankPerSecond - rest.rankPerSecond)) / rest.staminaPerSecond);
}

/** A chaos action weighed (#383): the chaos where the rule works now and after it, its cost and its gain, in rank. */
export interface BladeburnerChaosMeasure {
  chaos: number;
  after: number;
  /** The rank it costs: its 60 s at the rate it forgoes, and (Incite Violence) the chaos it adds. */
  cost: number;
  /** The rank it gains: the chaos it takes off (Diplomacy), or the counts it adds (Incite Violence). */
  gain: number;
  pays: boolean;
}

/** The rule's choice of city and chaos action (#383), from one reading. */
export interface BladeburnerCityChoice {
  /**
   * The city to work in: the most rank a second by B2's forecast, the current one on a tie; under a current-rank target
   * (#386), the least expected time to it.
   */
  city: string;
  /** B2's plan there (its forecast's work and rest, at that city's estimate and chaos). */
  plan: BladeburnerActionPlan;
  /** Each city's estimate, communities, chaos and B2's forecast there, in the game's order. */
  byCity: (BladeburnerCityReading & { rankPerSecond: number; toTarget?: { target: number; seconds: number } })[];
  /** Diplomacy in the city chosen, its chaos over 50; else null. */
  diplomacy: (BladeburnerChaosMeasure & { attemptsTo50: number }) | null;
  /** Incite Violence, the counts binding (the forecast with them unbounded over it); else null. */
  incite: (BladeburnerChaosMeasure & { work: string; countGain: number; unbounded: number }) | null;
  /** The chaos action to run, or null: Diplomacy where it pays, else Incite Violence where it pays. */
  chaosAction: BladeburnerChaosActionName | null;
}

/** B2's forecast input with the skills read, as `chooseBladeburnerAction` takes it, the city aside. */
export type BladeburnerCityForecastInput = Omit<Parameters<typeof chooseBladeburnerAction>[0], "city">;

/**
 * The city and the chaos action (#383), each by B2's forecast (`chooseBladeburnerAction`), from the reading in `city`
 * (its ranges read there) and every city's figures (`cities`). None of it takes a picked threshold:
 * - **The city:** each city's forecast, its ranges scaled by `cityCompetenceRatio` from the city read (Raid out with no
 *   communities, `Actions/Operation.ts:63-68`); the most rank a second, the current city on a tie. Switching is free.
 *   Under a current-rank target (#386, `input.target`), the least expected time to it. The chaos actions below are
 *   weighed by rank a second still: their effect on the time to a target is left out, and labelled.
 * - **Diplomacy,** the city chosen at a chaos c over 50: one more, to c' = `chaosAfterDiplomacy`, pays when its 60 s
 *   (what they forgo of the cycle at 50 or under, `chaosActionForgone`) cost less than the rank the chaos from c' to c
 *   loses as the decay would bring it down (`chaosRankLoss`, against R0, the forecast there at 50 or under): the path
 *   after it is the path without it, 60 s spent and (c − c')/0.0001 s gained. No other city floors that rate: the city
 *   chosen is the best at c, and its rate only rises as its chaos falls (the chaos factor on the difficulty, the others'
 *   held as read).
 * - **Incite Violence,** with the counts binding (the forecast with every count unbounded, R∞, over the forecast now,
 *   Rn): pays when the counts it adds to R∞'s work (`inciteCountGain`), each an attempt worked at R∞ in place of Rn
 *   (its seconds over R∞'s share worked), gain more than its 60 s (what they forgo of Rn's cycle,
 *   `chaosActionForgone`) and the rank the chaos it adds would lose in the city chosen (`chaosRankLoss` from c to
 *   `chaosAfterIncite`(c), against R∞ at 50, with no Diplomacy: it errs against Incite). Left out, and labelled: the
 *   counts it adds to the other actions, and the other cities' chaos.
 * Null with the city read not among `cities`, or its estimate not above 0: no city to scale from.
 */
export function chooseBladeburnerCity(
  input: BladeburnerCityForecastInput,
  { city, cities }: { city: string; cities: readonly BladeburnerCityReading[] },
): BladeburnerCityChoice | null {
  const here = cities.find((each) => each.name === city);
  if (here === undefined || !(here.population > 0)) return null;
  const forecastIn = (
    there: BladeburnerCityReading,
    chaos = there.chaos,
    readings = input.readings,
    from: BladeburnerCityForecastInput = input,
  ) => {
    const ratio = cityCompetenceRatio(here, { population: there.population, chaos }) ?? 0;
    return chooseBladeburnerAction({ ...from, readings, city: { ratio, raid: there.communities > 0 } });
  };
  const byCity = cities.map((each) => ({ ...each, plan: forecastIn(each) }));
  // Under a target (#386), the least time to it; else the most rank a second. The current city on a tie.
  const better = (a: BladeburnerActionPlan, b: BladeburnerActionPlan) =>
    a.toTarget !== undefined && b.toTarget !== undefined
      ? a.toTarget.seconds < b.toTarget.seconds
      : a.rankPerSecond > b.rankPerSecond;
  let best = byCity.find((each) => each.name === city) as (typeof byCity)[number];
  for (const each of byCity) if (better(each.plan, best.plan)) best = each;
  const chosen = best;
  const { chaosThreshold } = BLADEBURNER_CONSTANTS;
  // The chaos actions are weighed by rank a second (#386: a target aside, labelled).
  const rateInput = { ...input, target: undefined };
  const atChaos = (chaos: number, readings = input.readings) =>
    forecastIn(chosen, chaos, readings, rateInput).rankPerSecond;
  const charisma = input.person.skills.charisma;
  let diplomacy: BladeburnerCityChoice["diplomacy"] = null;
  if (chosen.chaos > chaosThreshold) {
    const after = chaosAfterDiplomacy(chosen.chaos, charisma);
    const atFifty = forecastIn(chosen, chaosThreshold, input.readings, rateInput);
    const baseline = atFifty.rankPerSecond;
    const gain = chaosRankLoss((chaos) => atChaos(chaos), baseline, after, chosen.chaos);
    const cost = BLADEBURNER_CHAOS_ACTION_SECONDS * chaosActionForgone(atFifty);
    diplomacy = {
      chaos: chosen.chaos,
      after,
      cost,
      gain,
      pays: gain > cost,
      attemptsTo50: diplomaciesTo50(chosen.chaos, charisma),
    };
  }
  let incite: BladeburnerCityChoice["incite"] = null;
  const unboundedReadings = input.readings.map((each) => ({ ...each, count: Number.POSITIVE_INFINITY }));
  const unbounded = forecastIn(chosen, chosen.chaos, unboundedReadings, rateInput);
  const nowPlan = chosen.plan.toTarget === undefined ? chosen.plan : forecastIn(chosen, chosen.chaos, input.readings, rateInput);
  const now = nowPlan.rankPerSecond;
  const work = unbounded.work;
  const action = work === null ? null : bladeburnerLevelledAction(work.type, work.name);
  if (work !== null && action !== null && unbounded.rankPerSecond > now && unbounded.duty > 0) {
    const after = chaosAfterIncite(chosen.chaos);
    const countGain = inciteCountGain(action);
    const gain = countGain * (work.seconds / unbounded.duty) * (unbounded.rankPerSecond - now);
    const baseline = atChaos(chaosThreshold, unboundedReadings);
    const chaosCost = chaosRankLoss((chaos) => atChaos(chaos, unboundedReadings), baseline, chosen.chaos, after);
    const cost = BLADEBURNER_CHAOS_ACTION_SECONDS * chaosActionForgone(nowPlan) + chaosCost;
    incite = {
      chaos: chosen.chaos,
      after,
      cost,
      gain,
      pays: gain > cost,
      work: `${work.name} level ${work.level}`,
      countGain,
      unbounded: unbounded.rankPerSecond,
    };
  }
  return {
    city: chosen.name,
    plan: chosen.plan,
    byCity: byCity.map(({ plan, ...each }) => ({
      ...each,
      rankPerSecond: plan.rankPerSecond,
      ...(plan.toTarget === undefined ? {} : { toTarget: plan.toTarget }),
    })),
    diplomacy,
    incite,
    chaosAction: diplomacy?.pays ? DIPLOMACY : incite?.pays ? INCITE_VIOLENCE : null,
  };
}
